/**
 * The in-app agent's LLM wiring (server/llm.ts), made persistent and editable
 * in the UI (Agent page and Setup). Each field resolves independently, in order:
 * a value saved in the app, else the matching OPENFIELD_LLM_* env var, else
 * unset. Saving a field in the app overrides the env var for that field without
 * touching .env, and it takes effect immediately (no restart).
 */
import { meta } from './jobs.js';
import { assertPrivateUrl } from './net.js';

const KEY = 'agent_llm';

type Field = 'url' | 'model' | 'key' | 'reasoning';
const FIELDS: Field[] = ['url', 'model', 'key', 'reasoning'];

const ENV: Record<Field, string> = {
  url: 'OPENFIELD_LLM_URL',
  model: 'OPENFIELD_LLM_MODEL',
  key: 'OPENFIELD_LLM_KEY',
  reasoning: 'OPENFIELD_LLM_REASONING',
};

type Stored = Partial<Record<Field, string>>;

function readStored(): Stored {
  const raw = meta.get(KEY);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Stored = {};
    for (const f of FIELDS) if (typeof o[f] === 'string') out[f] = o[f];
    return out;
  } catch {
    return {};
  }
}

function writeStored(s: Stored) {
  const present = FIELDS.filter((f) => s[f] !== undefined && (s[f] || '').trim() !== '');
  if (present.length) meta.set(KEY, JSON.stringify(Object.fromEntries(present.map((f) => [f, s[f]!.trim()]))));
  else meta.delete(KEY);
}

function envOf(f: Field): string {
  const v = (process.env[ENV[f]] || '').trim();
  return f === 'url' ? v.replace(/\/+$/, '') : v;
}

/** Where a field's value came from, for the UI to say "your pick" vs "from .env". */
export type LlmSource = 'user' | 'env' | 'unset';

export interface LlmConfigState {
  ready: boolean;
  url: string | null;
  model: string | null;
  keySet: boolean;
  reasoning: string | null;
  note: string | null;
  sources: Record<Field, LlmSource>;
}

export type LlmPatch = Partial<Record<Field, string | null>>;

/** The resolved per-field config (saved > env > unset), ready to hand to llmChat. */
export function effectiveLlmConfig(): { url?: string; model?: string; key?: string; reasoning?: string } {
  const stored = readStored();
  const out: { url?: string; model?: string; key?: string; reasoning?: string } = {};
  for (const f of FIELDS) {
    const u = (stored[f] || '').trim();
    if (u) { out[f] = f === 'url' ? u.replace(/\/+$/, '') : u; continue; }
    const e = envOf(f);
    if (e) out[f] = e;
  }
  return out;
}

/** The full config state, with per-field provenance, for /api/agent/config. */
export function llmConfigState(): LlmConfigState {
  const stored = readStored();
  const resolve = (f: Field): { value?: string; source: LlmSource } => {
    const u = (stored[f] || '').trim();
    if (u) return { value: f === 'url' ? u.replace(/\/+$/, '') : u, source: 'user' };
    const e = envOf(f);
    if (e) return { value: e, source: 'env' };
    return { source: 'unset' };
  };
  const url = resolve('url');
  const model = resolve('model');
  const key = resolve('key');
  const reasoning = resolve('reasoning');
  const ready = !!url.value;
  const note = !ready
    ? 'No LLM URL yet. Point the agent at an OpenAI-compatible server (e.g. http://127.0.0.1:1234/v1 for LM Studio), then pick a model.'
    : !model.value
      ? 'Pick a model below, or set OPENFIELD_LLM_MODEL. A server that lists exactly one model is used as-is.'
      : null;
  return {
    ready,
    url: url.value ?? null,
    model: model.value ?? null,
    keySet: !!key.value,
    reasoning: reasoning.value ?? null,
    note,
    sources: { url: url.source, model: model.source, key: key.source, reasoning: reasoning.source },
  };
}

/** Save per-field overrides; null (or empty) clears a field back to the env var, or unset. */
export function setLlmConfig(patch: LlmPatch) {
  const stored = readStored();
  for (const f of FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (v === null || (typeof v === 'string' && !v.trim())) delete stored[f];
    else stored[f] = (v as string).trim();
  }
  writeStored(stored);
}

// ---------------------------------------------------------------- models ----

export interface LlmModel {
  id: string;
  name?: string;
  size?: string;
  contextLength?: number;
  quantization?: string;
}

function fmtBytes(n: number): string {
  const gb = n / 2 ** 30;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`;
}

/**
 * The models the agent's LLM server offers, with stats when it's LM Studio
 * (its native /api/v0/models lists size, context and quantization). A plain
 * OpenAI-compatible server just returns ids. `url`/`key` let the setup card
 * load a not-yet-saved server's list.
 */
export async function listLlmModels(opts: { url?: string; key?: string } = {}): Promise<{ models: LlmModel[]; error?: string }> {
  const eff = effectiveLlmConfig();
  const url = (opts.url || eff.url || '').trim().replace(/\/+$/, '');
  const key = (opts.key || eff.key || '').trim();
  if (!url) return { models: [], error: 'Enter the LLM URL first (e.g. http://127.0.0.1:1234/v1), then load its models.' };
  try {
    await assertPrivateUrl(url);
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) };
  }
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;

  const ids: string[] = [];
  let listError: string | undefined;
  try {
    const r = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const list = (await r.json()) as { data?: { id?: string }[] };
      for (const m of list.data ?? []) if (m.id) ids.push(m.id);
    } else {
      listError = `${url}/models answered ${r.status}`;
    }
  } catch (e) {
    listError = `Could not reach ${url}/models (${e instanceof Error ? e.message : String(e)})`;
  }

  const models: LlmModel[] = ids.map((id) => ({ id }));
  const base = url.replace(/\/v\d+\/?$/, '');
  try {
    const r = await fetch(`${base}/api/v0/models`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const arr = (await r.json()) as { id?: string; name?: string; size?: string | number; contextLength?: number; context?: number; quantization?: string }[];
      const byId = new Map(models.map((m) => [m.id, m]));
      for (const m of arr) {
        if (!m.id) continue;
        const t = byId.get(m.id);
        if (!t) continue;
        if (m.name) t.name = m.name;
        if (m.size != null) t.size = typeof m.size === 'number' ? fmtBytes(m.size) : m.size;
        if (m.contextLength) t.contextLength = m.contextLength;
        else if (m.context) t.contextLength = m.context;
        if (m.quantization) t.quantization = m.quantization;
      }
    }
  } catch {
    /* not an LM Studio server; the ids above stand */
  }
  return { models, ...(listError && models.length === 0 ? { error: listError } : {}) };
}
