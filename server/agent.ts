/**
 * The in-app agent: a small agentic loop that lets the local LLM drive the
 * Morpheus tool set (the same registry the MCP server exposes, mcp/tools.ts).
 * The LLM decides which tools to call and in what order, reacting to each
 * result; GPU work is queued on the user's machine as it happens.
 *
 * This runs inside the Morpheus server (server/index.ts). It talks to the LLM
 * over llm.ts, and calls the tools the same way the MCP server does, so both
 * consumers share one registry and one set of server-side guards.
 */
import { z } from 'zod';
import { TOOLS, toolByName, safe, type ToolCtx, type ToolDef, type ToolResult } from '../mcp/tools.ts';
import { api } from '../mcp/client.ts';
import { llmChat, type LLMEvent, type LLMMessage, type ToolSpec } from './llm.ts';
import { effectiveLlmConfig, llmConfigState } from './llmConfig.ts';

export type AgentStep = { id: string; label: string; tool?: string; why?: string };
export type AgentEvent =
  | { type: 'plan'; steps: AgentStep[] }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_done'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'take'; id: number }
  | { type: 'show'; ids: number[]; flow: boolean }
  | { type: 'loading'; text: string; ready?: boolean }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | { type: 'done'; stepsUsed: number; elapsedMs: number };

export interface AgentOptions {
  message: string;
  history?: LLMMessage[];
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

const MAX_ROUNDS = 12;

const SYSTEM = [
  'You are the agent inside Morpheus, a local GPU creative studio: video, image, edit, loops, director, stage, upscale, remove-background, mirror, restyle, object swap, reshoot, extend, transition, audio (music and speech), speak, add-sound, 3D.',
  'You accomplish the user\'s creative task by calling tools. Each render tool queues real GPU work on the user\'s machine, so be deliberate and never invent results.',
  '',
  'Rules:',
  '- Prefer count 1 while iterating; render several takes only when the user asked for options.',
  '- After a render tool returns take id(s), call wait_for_take (or get_take) to see the result before claiming success. Do not describe a take you have not checked.',
  '- Chain work by take id: to animate a still, upscale it, or build on it, pass take:<id> as the input.',
  '- When a task clearly needs several GPU steps and the user has not already approved a plan, call present_plan and stop. If the user\'s message says they approved the plan, execute it and do not present it again.',
  '- If a tool returns an error, read its message and recover or explain the fix.',
  '- A call rejected for bad arguments is not an engine failure: the message lists what is allowed. Fix the arguments and call it again; never re-send the same bad arguments.',
  '- Keep replies short and concrete. When done, say what was made and where (the take id and file path).',
  '- Showing results: the chat renders preview cards, side by side, for the takes a show_take call lists. When the user asks to see, show or preview a take — including one already in the library — call list_takes if you do not know the ids, then call show_take with them. When the user asks how a take was made, or for the chain leading to it, call show_take with flow: true and just the newest id — the chat renders the chain with arrows. Do not tell the user you cannot display images.',
  '',
  'Pick the tool and model for the job, then write the prompt in that model\'s dialect:',
  '- Photoreal still -> generate_image (qwen); stylized or 3D still -> generate_image (flux2).',
  '- Motion -> generate_video (ltx25); a cut multi-shot scene -> direct_scene; a talking head -> speak; a 3D object -> make_3d.',
  '- Music -> generate_music (mood, tempo, key, instruments, structure); spoken words -> generate_speech (the exact words plus a voice description).',
  '- Still dialect: subject, setting, lighting, lens, mood. Video dialect: shot type, subject, camera move, lighting. Music dialect: genre, tempo in BPM, key, mood, structure.',
  '',
  'If a render fails, change something instead of re-sending the same call:',
  '- Out of memory or VRAM -> retry at a smaller resolution or a shorter duration. Missing model -> offer to download it or use an available alternative. Engine busy -> queue after the current job. Three identical failures -> stop and ask the user.',
  '',
  'Critique before you present: once a take resolves, call critique_take on it against the request. If any score is below 3, apply that fix and re-queue once. At most two critique rounds per turn, then present the result and let the user decide. Skip critique for audio unless you are verifying the spoken words.',
].join('\n');

// OpenAI `parameters` is a JSON schema. zod v4 emits one directly, but with
// non-standard keys some servers refuse: LM Studio's tool parser 400s on `default`
// ("failed to parse JSON value"), and several reject `additionalProperties`,
// `$schema`, `$id`. Strip those, and drop defaulted fields from `required`
// (the model may omit them; the server fills them in).
function toOpenAIParams(shape: Record<string, z.ZodType>): Record<string, unknown> {
  const raw = z.toJSONSchema(z.object(shape), { target: 'draft-07' }) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  // Record which fields carry a default before the strip removes the key.
  const defaulted = new Set(Object.entries(raw.properties ?? {}).filter(([, p]) => p && typeof p === 'object' && 'default' in p).map(([name]) => name));
  const strip = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k === 'additionalProperties' || k === 'default' || k === '$schema' || k === '$id') continue;
        out[k] = strip(v);
      }
      return out;
    }
    return o;
  };
  const cleaned = strip(raw) as { required?: string[] };
  if (Array.isArray(cleaned.required)) cleaned.required = cleaned.required.filter((f) => !defaulted.has(f));
  return cleaned as Record<string, unknown>;
}

const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: toOpenAIParams(t.inputSchema as Record<string, z.ZodType>),
}));

const PLAN_TOOL: ToolSpec = {
  name: 'present_plan',
  description: 'Propose a multi-step plan and stop, waiting for the user to approve it before any GPU work runs. Use when the task needs 2+ GPU steps and the user has not already approved. Do not render anything in the same turn.',
  parameters: toOpenAIParams({
    steps: z.array(z.object({
      id: z.string().describe('Short step id, e.g. "1"'),
      label: z.string().describe('What happens, one clause'),
      tool: z.string().optional().describe('The tool that step would use'),
      why: z.string().optional().describe('Why this step'),
    })).min(1).max(8).describe('The ordered steps'),
  }),
};
/** Agent-local: show existing takes in the chat as preview cards, side by side.
 *  A successful call emits one `show` event (ids + flow flag) the page renders as
 *  a card grid — or, with flow: true, as the parent→child chain with arrows (the
 *  page walks the lineage, so only the newest id is needed). Not in the shared
 *  registry: MCP clients already receive preview images from get_take/wait_for_take. */
const SHOW_TOOL: ToolDef = {
  name: 'show_take',
  title: 'Show takes',
  description: 'Show take(s) to the user in the chat: the page renders their preview cards side by side. Use when the user asks to see, show or preview a take, including takes already in the library (call list_takes first if you do not know the ids). When the user asks how a take was made, or for the chain leading to it, pass flow: true with just the newest id — the page walks back its parents and renders the chain with arrows. No GPU work.',
  inputSchema: {
    take_ids: z.array(z.number().int()).min(1).max(16).describe('The take ids to show, in order'),
    flow: z.boolean().default(false).describe('true = these takes form a source-to-result chain; pass just the newest id and the page walks back its parents, rendered with arrows'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: safe(async ({ take_ids, flow }) => {
    const all = await api.takes();
    const missing = take_ids.filter((id: number) => !all.some((t) => t.id === id));
    if (missing.length) throw new Error(`no take ${missing.join(', ')} — list_takes shows the recent ones`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ shown: true, take_ids, flow: !!flow, note: 'The chat now shows preview cards for these takes, side by side; the user can see them.' }),
      }],
    };
  }),
};

const ALL_TOOLS: ToolSpec[] = [
  ...TOOL_SPECS,
  PLAN_TOOL,
  { name: SHOW_TOOL.name, description: SHOW_TOOL.description, parameters: toOpenAIParams(SHOW_TOOL.inputSchema as Record<string, z.ZodType>) },
];

/** Pull the queued take id(s) out of a tool's text payload, for the UI's live cards. */
function takeIdsFrom(out: ToolResult): number[] {
  const ids: number[] = [];
  for (const c of out.content) {
    if (c.type !== 'text') continue;
    try {
      const o = JSON.parse(c.text) as Record<string, unknown>;
      const push = (v: unknown) => { if (typeof v === 'number') ids.push(v); };
      if (Array.isArray(o.take_ids)) for (const v of o.take_ids) push(v);
      push(o.take_id);
      push(o.cut_take_id);
      push(o.upscale_of);
    } catch { /* not a JSON payload */ }
  }
  return [...new Set(ids)];
}

const resultToText = (out: ToolResult): string =>
  out.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');

/** A rejected tool call, as a message the model can act on: what was wrong and where. */
function badArgs(name: string, issues: { path: PropertyKey[]; message: string }[]): string {
  const why = issues
    .slice(0, 6)
    .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .join('  ·  ');
  return `${name}: fix the arguments — ${why}`;
}

/** One agent turn: LLM -> tools -> LLM -> ... until a final answer, a plan, or a cap. */
export async function runAgent(opts: AgentOptions): Promise<void> {
  const ec = llmConfigState();
  if (!ec.ready) throw new Error(ec.note || 'No LLM configured. Set the LLM URL in the Agent page or Setup, or OPENFIELD_LLM_URL in .env.');
  await runTurnInner(opts);
}

async function runTurnInner(opts: AgentOptions): Promise<void> {
  const started = Date.now();
  const emit = opts.onEvent;
  const eff = effectiveLlmConfig();
  const cfg = { url: eff.url, model: eff.model, key: eff.key, reasoning: eff.reasoning };

  // The local LLM may still be loading its weights (LM Studio): announce it, then
  // clear on the first streamed token so the UI shows a real status, not silence.
  emit({ type: 'loading', text: 'Loading model…' });
  let readySent = false;
  const onLlmEvent = (e: LLMEvent) => {
    if (!readySent) { readySent = true; emit({ type: 'loading', text: 'ready', ready: true }); }
    if (e.type === 'thinking') emit({ type: 'thinking', text: e.text });
    else if (e.type === 'text') emit({ type: 'text', text: e.text });
  };

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    ...(opts.history ?? []),
    { role: 'user', content: opts.message },
  ];
  const ctx: ToolCtx = { signal: opts.signal, progress: (m) => emit({ type: 'thinking', text: m }) };
  let stepsUsed = 0;
  // Identical failing call, counted: the model sometimes re-sends the same bad
  // arguments instead of reading the error. Three strikes ends the turn.
  const failStreak = new Map<string, number>();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (opts.signal?.aborted) { emit({ type: 'stopped' }); return; }
    let result;
    try {
      result = await llmChat(cfg, { messages, tools: ALL_TOOLS, onEvent: onLlmEvent, signal: opts.signal });
    } catch (e) {
      emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }

    const toolCalls = result.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
    messages.push({ role: 'assistant', content: result.content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (!result.toolCalls.length) {
      if (result.note) emit({ type: 'thinking', text: result.note });
      emit({ type: 'done', stepsUsed, elapsedMs: Date.now() - started });
      return;
    }

    // A plan stops the turn and waits for approval; nothing else runs this turn.
    const planCall = result.toolCalls.find((tc) => tc.name === 'present_plan');
    if (planCall) {
      const steps = (Array.isArray(planCall.args.steps) ? planCall.args.steps : []) as AgentStep[];
      emit({ type: 'plan', steps });
      for (const tc of result.toolCalls) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: tc.name === 'present_plan' ? 'Plan presented. Awaiting the user\'s approval to run it.' : 'Not executed: the plan is awaiting approval.' });
      }
      emit({ type: 'done', stepsUsed, elapsedMs: Date.now() - started });
      return;
    }

    for (const tc of result.toolCalls) {
      if (opts.signal?.aborted) { emit({ type: 'stopped' }); return; }
      const tool = toolByName(tc.name) ?? (tc.name === 'show_take' ? SHOW_TOOL : undefined);
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `Unknown tool: ${tc.name}` });
        emit({ type: 'tool_done', id: tc.id, name: tc.name, ok: false, summary: 'unknown tool' });
        continue;
      }
      stepsUsed++;
      emit({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args });
      let out: ToolResult;
      if (typeof tc.args === 'object' && tc.args !== null && '_raw' in tc.args) {
        // The model's arguments were not valid JSON (llm.ts keeps the raw string under _raw).
        out = { isError: true, content: [{ type: 'text', text: `${tc.name}: the arguments were not valid JSON. Send a JSON object of arguments, e.g. {"prompt": "..."}.` }] };
      } else {
        // Validate against the tool's zod shape: defaults are filled in (the schema
        // sent to the model has them stripped) and bad enums become a readable,
        // self-correctable error instead of a TypeError deep in the body builder.
        const parsed = z.object(tool.inputSchema).safeParse(tc.args);
        out = parsed.success
          ? await tool.handler(parsed.data, ctx)
          : { isError: true, content: [{ type: 'text', text: badArgs(tc.name, parsed.error.issues) }] };
      }
      // show_take renders as one card grid (or an arrow chain when flow: true)
      // instead of a card per id, so it emits a single `show` event.
      if (tc.name === 'show_take' && !out.isError) {
        emit({ type: 'show', ids: takeIdsFrom(out), flow: (tc.args as { flow?: unknown })?.flow === true });
      } else {
        for (const id of takeIdsFrom(out)) emit({ type: 'take', id });
      }
      emit({ type: 'tool_done', id: tc.id, name: tc.name, ok: !out.isError, summary: resultToText(out) });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultToText(out) });
      if (out.isError) {
        const key = `${tc.name}:${JSON.stringify(tc.args)}`;
        const fails = (failStreak.get(key) ?? 0) + 1;
        failStreak.set(key, fails);
        if (fails >= 3) {
          emit({ type: 'error', message: 'Stopped: the same call has failed three times with the same arguments. Change the request, or tell me what to adjust.' });
          emit({ type: 'done', stepsUsed, elapsedMs: Date.now() - started });
          return;
        }
      }
    }
  }

  emit({ type: 'thinking', text: `Stopped after ${MAX_ROUNDS} tool rounds without a final answer.` });
  emit({ type: 'done', stepsUsed, elapsedMs: Date.now() - started });
}
