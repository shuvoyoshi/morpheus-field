/**
 * A shared OpenAI-compatible streaming client for the local LLM (LM Studio,
 * llama.cpp, vLLM, ...). Named by OPENFIELD_LLM_URL (base URL up to and
 * including /v1). Used by the in-app agent (agent.ts); the Director planner in
 * scene.ts keeps its own tuned copy, but both speak the same wire protocol.
 *
 * Unlike scene.ts (which wants one JSON blob), this client is built for tool
 * calling: it streams text and reasoning separately, and accumulates the
 * streamed `tool_calls[]` (whose name and arguments arrive across many chunks)
 * into a final list the caller can dispatch.
 */

import { assertPrivateUrl } from './net.js';

const LLM = (process.env.OPENFIELD_LLM_URL || '').trim().replace(/\/+$/, '');
const LLM_MODEL = (process.env.OPENFIELD_LLM_MODEL || '').trim();
const LLM_KEY = (process.env.OPENFIELD_LLM_KEY || '').trim();
const LLM_REASONING = (process.env.OPENFIELD_LLM_REASONING || '').trim();
/** How long the LLM may stay silent, and run in all. A thinking model says nothing until it starts. */
const LLM_IDLE = 180_000;
const LLM_TOTAL = 600_000;

/** One piece of a multimodal user message. A bare string is the common case;
 *  a parts array lets the agent's VLM see frames (image_url) alongside text. */
export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | LLMContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: LLMToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LLMToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolSpec { name: string; description?: string; parameters: Record<string, unknown> }

/** Incremental events, for the UI to show the agent's thinking and speech as they stream. */
export type LLMEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string };  // a tool call was requested (name known)

export interface LLMResult {
  content: string;                                        // final text, thinking removed
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  note?: string;
  model: string;
}

export interface LLMConfig { url?: string; model?: string; key?: string; reasoning?: string }

/** Env-var LLM config, for the /api/agent/config endpoint (no network). */
export function envLlmConfig() {
  return {
    ready: !!LLM,
    url: LLM || null,
    model: LLM_MODEL || null,
    keySet: !!LLM_KEY,
    reasoning: LLM_REASONING || null,
    note: LLM
      ? (LLM_MODEL ? null : 'OPENFIELD_LLM_MODEL not set; the first model the server lists will be used (set it to be sure)')
      : 'OPENFIELD_LLM_URL is not set. Point it at an OpenAI-compatible server, e.g. http://127.0.0.1:1234/v1 (LM Studio).',
  };
}

/** fetch reports a connection the server dropped mid-body as a bare "terminated". */
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return m === 'terminated' ? 'the server closed the connection' : m;
};

/** The `data:` payloads of a server-sent event stream, up to `[DONE]` or the end of the body. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        if (data) yield data;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Split a reasoning model's content into its thinking (anything between `...`)
 * and its actual reply. Stateful across chunks, and tolerant of a tag split
 * across a chunk boundary (it holds back a tag's worth of tail).
 */
class ThinkSplit {
  private buf = '';
  private open = false;
  feed(chunk: string): { thinking: string; text: string } {
    this.buf += chunk;
    let thinking = '';
    let text = '';
    for (;;) {
      if (this.open) {
        const m = this.buf.search(/<\/think>/i);
        if (m >= 0) { thinking += this.buf.slice(0, m); this.buf = this.buf.slice(m + 8); this.open = false; }
        else break;
      } else {
        const m = this.buf.search(/<think>/i);
        if (m >= 0) { text += this.buf.slice(0, m); this.buf = this.buf.slice(m + 7); this.open = true; }
        else {
          const hold = Math.min(this.buf.length, 7);  // the tail might be a partial `<think`
          text += this.buf.slice(0, -hold);
          this.buf = this.buf.slice(-hold);
          break;
        }
      }
    }
    return { thinking, text };
  }
  end(): { thinking: string; text: string } {
    const out = this.open ? { thinking: this.buf, text: '' } : { thinking: '', text: this.buf };
    this.buf = '';
    return out;
  }
}

/**
 * One chat turn against the LLM, with optional tool calling. Streams
 * thinking/text/tool events to `onEvent` as they arrive and returns the final
 * text plus the accumulated, parsed tool calls. A server that refuses a
 * request with a 400 is asked again without reasoning_effort, then without
 * streaming (one that ignores `stream` answers in a single piece).
 */
export async function llmChat(
  cfg: LLMConfig,
  params: {
    messages: LLMMessage[];
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'none' | 'required';
    temperature?: number;
    onEvent?: (e: LLMEvent) => void;
    signal?: AbortSignal;
  },
): Promise<LLMResult> {
  const url = (cfg.url ?? LLM).replace(/\/+$/, '');
  const key = (cfg.key ?? LLM_KEY).trim();
  const reasoning = (cfg.reasoning ?? LLM_REASONING).trim();
  if (!url) throw new Error('OPENFIELD_LLM_URL is not set');
  await assertPrivateUrl(url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  let model = (cfg.model ?? LLM_MODEL).trim();
  if (!model) {
    const r = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${url}/models answered ${r.status}`);
    const list = (await r.json()) as { data?: { id?: string }[] };
    // A server with one model (llama-server) is asked as it is. One that lists several (LM Studio
    // lists every downloaded model, embedding models too, and loads the one asked for) needs the choice made.
    const ids = (list.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
    if (ids.length !== 1) throw new Error(`${url}/models lists ${ids.length || 'no'} model${ids.length === 1 ? '' : 's'}; set OPENFIELD_LLM_MODEL`);
    model = ids[0];
  }

  const ctl = params.signal ? new AbortController() : new AbortController();
  if (params.signal) {
    const relay = () => ctl.abort(params.signal!.reason);
    if (params.signal.aborted) relay();
    else params.signal.addEventListener('abort', relay, { once: true });
  }
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error(`no answer for ${LLM_IDLE / 1000}s`)), LLM_IDLE);
  };
  const total = setTimeout(() => ctl.abort(new Error(`no reply after ${LLM_TOTAL / 1000}s`)), LLM_TOTAL);

  // The OpenAI wire format wraps each tool as { type:'function', function:{...} };
  // the internal ToolSpec is the bare { name, description, parameters }. Sending the
  // bare form is a 400 on strict servers (LM Studio's tool parser included).
  const tools = params.tools?.filter((t) => t.name).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const emit = params.onEvent;
  try {
    const t = { reasoning: !!reasoning, stream: true };
    let note: string | undefined;
    let r: Response | undefined;
    for (;;) {
      touch();
      r = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers,
        signal: ctl.signal,
        body: JSON.stringify({
          model, stream: t.stream, temperature: params.temperature ?? 0.4,
          messages: params.messages,
          ...(tools?.length ? { tools, ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}) } : {}),
          ...(t.reasoning ? { reasoning_effort: reasoning } : {}),
        }),
      });
      if (r.status !== 400) break;
      await r.body?.cancel().catch(() => {});
      if (t.reasoning) {
        t.reasoning = false;
        note = `the server refused reasoning_effort "${reasoning}"; asked without it`;
      } else if (t.stream) t.stream = false;
      else break;
    }
    if (!r || !r.ok) throw new Error(`${model} at ${url} answered ${r?.status}`);
    if (!r.body || !(r.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // One-piece answer (a server that ignores `stream`).
      const d = (await r.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[] } }[];
      };
      const msg = d.choices?.[0]?.message ?? {};
      const split = new ThinkSplit();
      const out = split.feed(`${msg.content ?? ''}`);
      const tc = (msg.tool_calls ?? []).map((c) => ({ id: c.id ?? '', name: c.function?.name ?? '', argsRaw: c.function?.arguments ?? '' }));
      return {
        content: out.text.trim(),
        toolCalls: tc.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.argsRaw) })),
        note, model,
      };
    }

    const split = new ThinkSplit();
    const acc: { id: string; name: string; args: string }[] = [];
    const byIndex = new Map<number, number>();
    const sawTool = new Set<string>();
    let content = '';
    try {
      for await (const data of sseData(r.body)) {
        touch();
        const chunk = JSON.parse(data) as {
          error?: { message?: string } | string;
          choices?: {
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              reasoning?: string | null;
              tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };
        if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'stream error');
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) emit?.({ type: 'thinking', text: delta.reasoning_content });
        else if (delta.reasoning) emit?.({ type: 'thinking', text: delta.reasoning });
        if (delta.content) {
          const out = split.feed(delta.content);
          if (out.thinking) emit?.({ type: 'thinking', text: out.thinking });
          if (out.text) { emit?.({ type: 'text', text: out.text }); content += out.text; }
        }
        for (const c of delta.tool_calls ?? []) {
          const idx = c.index ?? 0;
          let pos = byIndex.get(idx);
          if (pos === undefined) { pos = acc.length; byIndex.set(idx, pos); acc.push({ id: '', name: '', args: '' }); }
          if (c.id) acc[pos].id = c.id;
          if (c.function?.name) { acc[pos].name += c.function.name; if (!sawTool.has(acc[pos].name)) { sawTool.add(acc[pos].name); emit?.({ type: 'tool', name: acc[pos].name }); } }
          if (c.function?.arguments) acc[pos].args += c.function.arguments;
        }
      }
      const tail = split.end();
      if (tail.thinking) emit?.({ type: 'thinking', text: tail.thinking });
      if (tail.text) { emit?.({ type: 'text', text: tail.text }); content += tail.text; }
    } catch (e) {
      const why = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
      // A reply that breaks off: keep the text and any tool calls already received.
      const kept = acc.filter((c) => c.name);
      if (kept.length || content.trim()) {
        return { content: content.trim(), toolCalls: kept.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.args) })), note: `${errText(why)}; kept partial reply`, model };
      }
      throw why;
    }
    return {
      content: content.trim(),
      toolCalls: acc.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.args) })).filter((c) => c.name),
      note, model,
    };
  } catch (e) {
    throw ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  const s = (raw || '').trim();
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return { _raw: s }; }
}

