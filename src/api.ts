/** Client-side API + live socket. */
import type { RenderTier, TierState } from './renderTier';
import type { VideoDecode, VideoDecodeState } from './videoDecode';

export interface Take {
  id: number;
  created_at: string;
  project_id: number | null;
  kind: string;
  shot_name: string;
  prompt_id: string | null;
  status: string;
  settings: string;
  output_path: string | null;
  render_seconds: number | null;
  transcript: string | null;
  starred: number;
  error: string | null;
  /** The take this one was made from (edit, upscale, mirror, ...), when any. */
  parent_take_id?: number | null;
  /** Set while the take sits in the trash (its files are stashed, not deleted). */
  trashed_at?: string | null;
}

export interface Project { id: number; name: string; folder: string }

export type CastKind = 'character' | 'prop' | 'place';
export interface CastRef { token: string; file: string; w: number; h: number; url: string }
export interface CastMember { id: number; name: string; kind: CastKind; refs: CastRef[]; notes: string; created_at: string }
/** Where a cast picture comes from: an upload token, a finished still take, or (MCP) a local file. */
export type CastSource = { token: string } | { takeId: number };

export interface Preamble { id: number; name: string; text: string; sort: number }

export interface ModelFileRef {
  file: string; dir: string; repo: string; path: string; gb: number; gated?: boolean;
  /** The OPENFIELD_LTX25_* variable that set this file in place of the stock one. */
  override?: string;
}

export interface BundleStatus {
  id: string;
  label: string;
  purpose: string;
  license: string;
  optional: boolean;
  gb: number;
  ready: boolean;
  missingFiles: ModelFileRef[];
  missingNodes: { class: string; pack: string; url: string }[];
}

/** The Setup > Engine choice: LAN or WAN, and (in LAN mode) which card. */
export type EngineMode = 'lan' | 'wan';
export type EngineGpu = '4090' | '5090' | 'both';
export interface EngineState {
  mode: EngineMode;
  gpu: EngineGpu;
  source: 'user' | 'default';
  /** A COMFY_LAUNCH_WAN (listen bat) is configured, so WAN can do anything. */
  wanConfigured: boolean;
}

export interface Status {
  up: boolean;
  version?: string;
  gpu?: string;
  api?: boolean;
  target?: 'local' | 'cloud';
  vramFreeGb?: number;
  vramTotalGb?: number;
  queueRemaining?: number;
  otherGpuProcess?: boolean;
  /** Whether a COMFY_LAUNCH command is configured, i.e. START ENGINE can work. */
  canLaunch?: boolean;
  /** The saved LAN/WAN + card choice (Setup > Engine). */
  engine?: EngineState;
  comfyUrl?: string;
  /** The machine-wide video render size and where it came from. */
  renderTier?: TierState;
  /** Whole-clip or chunked video decode (Setup > Video decode). */
  videoDecode?: VideoDecodeState;
  /** Set when OPENFIELD_LLM_REASONING overrides the Director's "Think first" switch (its reasoning_effort value). */
  plannerReasoning?: string | null;
  /** Set when the server runs as the judge preview (server/judge.ts). */
  judge?: { cap: number; used: number; left: number; maxSeconds: number };
  active: Take[];
}

/** A phone hand-off link (server/phone.ts). `url` holds the single-use secret. */
export interface PhoneSession {
  id: string;
  url: string;
  expiresAt: number;
  port: number;
  maxBytes: number;
  network: { wsl: 'none' | 'mirrored' | 'nat'; bindHost: string; urlHost: string; warning: string | null; commands: string[] };
}

/** Live phone state, relayed over /live. `result` arrives with 'received'. */
export interface PhoneEvent {
  type: 'phone';
  id: string;
  state: 'waiting' | 'opened' | 'receiving' | 'received' | 'closed';
  bytes?: number;
  result?: { token: string; name: string; bytes: number };
  reason?: 'received' | 'expired' | 'cancelled' | 'abuse' | 'replaced';
}

/** A phone pairing (server/phoneApp.ts). Scanning `url` opens the app and sets the cookie. */
export interface PairSession {
  id: string;
  url: string;
  expiresAt: number;
  port: number;
  upstream: string;
  network: { wsl: 'none' | 'mirrored' | 'nat'; bindHost: string; urlHost: string; warning: string | null; commands: string[] };
}

/** Live pairing state, relayed over /live. */
export interface PairEvent {
  type: 'phoneapp';
  id: string;
  state: 'waiting' | 'linked' | 'closed';
  reason?: 'expired' | 'cancelled' | 'abuse' | 'replaced';
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  // Only claim a JSON body when one exists — Fastify 400s an empty body sent
  // with a JSON content-type, which silently broke every body-less POST
  // (STOP, CLEAR QUEUE, cancel, trash) until 2026-08-04.
  const headers = init?.body
    ? { 'Content-Type': 'application/json', ...init.headers }
    : init?.headers;
  const r = await fetch(url, init && { ...init, headers });
  // Judge preview: a lapsed sign-in goes back to the login page.
  if (r.status === 401 && url.startsWith('/api/')) {
    window.location.assign('/login');
    throw new Error('Sign in again');
  }
  // An empty body means the server (or its proxy) died mid-response — parse
  // defensively instead of throwing "Unexpected end of JSON input", which said
  // nothing about what was actually wrong (2026-11-07: dead API behind Vite).
  let d: unknown;
  try { d = await r.json(); } catch { d = null; }
  if (!r.ok) {
    const o = d && typeof d === 'object' ? (d as { error?: unknown; message?: unknown }) : null;
    const msg = (o && (typeof o.error === 'string' ? o.error : typeof o.message === 'string' ? o.message : null))
      || `Morpheus is not answering (HTTP ${r.status})`;
    console.error(`[morpheus] ${init?.method || 'GET'} ${url} failed:`, msg);
    throw new Error(msg);
  }
  return d as T;
}

/** Where a config field came from: saved in the app, from .env, or unset. */
export type LlmSource = 'user' | 'env' | 'unset';

/** The in-app agent's LLM config (server/llmConfig.ts). `ready` = a URL is set (saved or via .env). */
export interface AgentConfig {
  ready: boolean;
  url: string | null;
  model: string | null;
  keySet: boolean;
  reasoning: string | null;
  note: string | null;
  sources: { url: LlmSource; model: LlmSource; key: LlmSource; reasoning: LlmSource };
}

/** A model the agent's LLM server offers, with stats when the server provides them. */
export interface LlmModel {
  id: string;
  name?: string;
  size?: string;
  contextLength?: number;
  quantization?: string;
}

export interface AgentStep { id: string; label: string; tool?: string; why?: string }

/** A saved Agent conversation (server/jobs.ts `conversations`). The list is light (no blocks). */
export interface Convo { id: number; title: string; created_at: string; updated_at: string }
export interface ConvoFull extends Convo { settings: Record<string, unknown>; blocks: unknown[] }
/** Prior turns, text only (user + assistant), so the agent can chain on what it made. */
export interface HistoryMsg { role: 'user' | 'assistant'; content: string }
/** An agent turn's streamed events (server/agent.ts), in order. */
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

export const api = {
  status: () => j<Status>('/api/status'),
  /** The agent's LLM wiring (no network): is a model configured, and which. */
  agentConfig: () => j<AgentConfig>('/api/agent/config'),
  /** Save the agent's LLM wiring; null clears a field back to .env (or unset). Applies immediately. */
  setAgentConfig: (patch: Partial<Record<'url' | 'model' | 'key' | 'reasoning', string | null>>) =>
    j<AgentConfig>('/api/agent/config', { method: 'PUT', body: JSON.stringify(patch) }),
  /** The models the agent's LLM server offers, with stats on LM Studio. `url`/`key` load a not-yet-saved server. */
  agentModels: (url?: string, key?: string) => {
    const qs = new URLSearchParams();
    if (url) qs.set('url', url);
    if (key) qs.set('key', key);
    const s = qs.toString();
    return j<{ models: LlmModel[]; error?: string }>(`/api/agent/models${s ? `?${s}` : ''}`);
  },
  /** Saved Agent conversations, most recently updated first. */
  conversations: () => j<Convo[]>('/api/agent/conversations'),
  /** Create a conversation (the first turn of a chat); returns the new row with its id. */
  createConversation: (row: { title?: string; blocks?: unknown[]; settings?: unknown }) =>
    j<ConvoFull>('/api/agent/conversations', { method: 'POST', body: JSON.stringify(row) }),
  getConversation: (id: number) => j<ConvoFull>(`/api/agent/conversations/${id}`),
  /** Save a conversation's blocks / settings / title (bumps updated_at). */
  saveConversation: (id: number, patch: { blocks?: unknown[]; settings?: unknown; title?: string }) =>
    j<ConvoFull>(`/api/agent/conversations/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** Fork a conversation through a given block index into a new one. */
  forkConversation: (id: number, upTo: number, title?: string) =>
    j<ConvoFull>(`/api/agent/conversations/${id}/fork`, { method: 'POST', body: JSON.stringify({ upTo, ...(title ? { title } : {}) }) }),
  deleteConversations: (ids: number[]) =>
    j<{ deleted: number }>('/api/agent/conversations', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  /** Set the machine-wide render size; null goes back to the default (OPENFIELD_RENDER_TIER or the GPU). */
  setRenderTier: (renderTier: RenderTier | null) =>
    j<{ renderTier: TierState }>('/api/settings', { method: 'PUT', body: JSON.stringify({ renderTier }) }),
  /** Set the machine-wide video decode; null goes back to the default (OPENFIELD_VIDEO_DECODE or the GPU). */
  setVideoDecode: (videoDecode: VideoDecode | null) =>
    j<{ videoDecode: VideoDecodeState }>('/api/settings', { method: 'PUT', body: JSON.stringify({ videoDecode }) }),
  takes: (projectId: number | null) => j<Take[]>(`/api/takes${projectId ? `?project=${projectId}` : ''}`),
  getTake: (id: number) => j<Take>(`/api/takes/${id}`),
  projects: () => j<Project[]>('/api/projects'),
  addProject: (name: string, folder: string) =>
    j<{ id: number }>('/api/projects', { method: 'POST', body: JSON.stringify({ name, folder }) }),
  upload: (name: string, dataUrl: string) =>
    j<{ name: string }>('/api/upload', { method: 'POST', body: JSON.stringify({ name, dataUrl }) }),
  generate: (body: Record<string, unknown>) =>
    j<{ takeId: number; takeIds: number[] }>('/api/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Stop: cancel the live render, mark the take stopped (the Agent page's Stop). */
  stop: () => j<{ ok: true; stopped: number }>('/api/stop', { method: 'POST' }),
  cancelTake: (id: number) => j<{ ok: true }>(`/api/takes/${id}/cancel`, { method: 'POST' }),
  clearQueue: () => j<{ ok: true }>('/api/queue/clear', { method: 'POST' }),
  startEngine: () => j<{ ok: boolean }>('/api/engine/start', { method: 'POST' }),
  stopEngine: () => j<{ ok: boolean; killed: number }>('/api/engine/stop', { method: 'POST' }),
  engineConfig: () => j<EngineState>('/api/engine/config'),
  setEngineConfig: (patch: { mode?: EngineMode; gpu?: EngineGpu }) =>
    j<EngineState>('/api/engine/config', { method: 'PUT', body: JSON.stringify(patch) }),
  models: () => j<{ checkpoints: Record<string, string[]>; card: Record<string, unknown> }>('/api/models'),
  removeQueued: (promptId: string) => j<{ ok: true }>(`/api/queue/${promptId}`, { method: 'DELETE' }),
  star: (id: number, on: boolean) => j<Take>(`/api/takes/${id}/star`, { method: 'POST', body: JSON.stringify({ on }) }),
  /** Move a take to the trash: its files are stashed (recoverable), the row is kept. */
  trash: (id: number) => j<{ ok: true; moved: number }>(`/api/takes/${id}`, { method: 'DELETE' }),
  /** Bring a trashed take (and its stashed files) back. */
  restore: (id: number) => j<{ ok: true; restored: number }>(`/api/takes/${id}/restore`, { method: 'POST' }),
  /** Delete a take for good, files wherever they are. */
  purge: (id: number) => j<{ ok: true; purged: number }>(`/api/takes/${id}?purge=1`, { method: 'DELETE' }),
  /** Stage a finished take's file into the engine as a new input (server-side, any size). */
  takeInput: (id: number) => j<{ token: string }>(`/api/takes/${id}/input`, { method: 'POST' }),
  /** Takes in the trash. */
  trashed: () => j<Take[]>('/api/takes?trashed=1'),
  /** Empty the trash: every trashed take, files included. */
  emptyTrash: () => j<{ ok: true; purged: number; takes: number }>('/api/takes/trash', { method: 'DELETE' }),
  /** Move a selection to the trash in one request (Library's batch delete). */
  trashMany: (ids: number[]) => j<{ ok: true; moved: number; failed: number }>('/api/takes/trash', { method: 'POST', body: JSON.stringify({ ids }) }),
  preflight: (refresh = false) =>
    j<{ bundles: BundleStatus[] }>(`/api/preflight${refresh ? '?refresh=1' : ''}`),
  preambles: () => j<Preamble[]>('/api/preambles'),
  addPreamble: (name: string, text: string) =>
    j<{ id: number }>('/api/preambles', { method: 'POST', body: JSON.stringify({ name, text }) }),
  savePreamble: (id: number, name: string, text: string) =>
    j<Preamble>(`/api/preambles/${id}`, { method: 'PUT', body: JSON.stringify({ name, text }) }),
  estimate: (q: Record<string, string | number>) =>
    j<{ seconds: number | null; samples: number }>(`/api/estimate?${new URLSearchParams(q as Record<string, string>)}`),
  free: () => j<{ ok: true }>('/api/free', { method: 'POST' }),
  phoneStart: () => j<PhoneSession>('/api/phone/start', { method: 'POST' }),
  /** Close our session only: a newer one from another window keeps running. */
  phoneStop: (id: string) => j<{ ok: true }>('/api/phone/stop', { method: 'POST', body: JSON.stringify({ id }) }),
  /** Open the whole app on a paired phone (Setup > Phone). */
  pairStart: () => j<PairSession>('/api/phoneapp/start', { method: 'POST' }),
  pairStop: (id: string) => j<{ ok: true }>('/api/phoneapp/stop', { method: 'POST', body: JSON.stringify({ id }) }),
  pairStatus: () => j<{ session: PairSession | null }>('/api/phoneapp'),
  cast: () => j<CastMember[]>('/api/cast'),
  createCast: (m: { name: string; kind: CastKind; notes: string; refs: CastSource[] }) =>
    j<CastMember>('/api/cast', { method: 'POST', body: JSON.stringify(m) }),
  updateCast: (id: number, patch: { name?: string; kind?: CastKind; notes?: string; addRefs?: CastSource[]; removeRefs?: number[] }) =>
    j<CastMember>(`/api/cast/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCast: (id: number) => j<{ ok: true }>(`/api/cast/${id}`, { method: 'DELETE' }),
  castHero: (b: { castIds: number[]; shot: string; width?: number; height?: number }) =>
    j<{ takeId: number }>('/api/cast/hero', { method: 'POST', body: JSON.stringify(b) }),
  deletePreamble: (id: number) => j<{ ok: true }>(`/api/preambles/${id}`, { method: 'DELETE' }),
  /** Director scenes: plan a shot list (poll it), then shoot it into one cut. */
  directorPlan: (body: { scene: string; shots?: number; planner?: string; think?: boolean }) =>
    j<ScenePlan>('/api/director/plan', { method: 'POST', body: JSON.stringify(body) }),
  directorPlanStatus: (id: string) => j<ScenePlan>(`/api/director/plan/${id}`),
  directorScene: (body: Record<string, unknown>) =>
    j<{ cutId: number; take: Take }>('/api/director/scene', { method: 'POST', body: JSON.stringify(body) }),
  /** Measure a take as a loop (stored on the take as settings.seam). */
  seam: (id: number) => j<SeamMeasure>(`/api/takes/${id}/seam`),
  /** Collect an HDR finish's EXRs and HLG master from the engine again. */
  collectHdr: (id: number) => j<Record<string, unknown>>(`/api/takes/${id}/collect-hdr`, { method: 'POST' }),
  /** Seam Doctor: auto picks trim, then a re-render across the wrap, then a new seed, by measurement. */
  /** Stage: the blocking frames rendered in WebGL become the clay and depth inputs. */
  stageBlocking: (body: { width: number; height: number; clay: string[]; depth: string[]; clayStill: string; depthStill: string }) =>
    j<StageBlocking>('/api/stage/blocking', { method: 'POST', body: JSON.stringify(body) }),
  fixSeam: (id: number, strategy: 'auto' | 'trim' | 'regen' | 'bridge' | 'reseed' = 'auto') =>
    j<{ fix: string | null; before: SeamMeasure; takeIds: number[] }>(`/api/takes/${id}/fix-seam`, { method: 'POST', body: JSON.stringify({ strategy }) }),
};

/** A blocking turned into engine inputs (server/stage.ts). */
export interface StageBlocking {
  clayVideo: string;
  depthVideo: string;
  depthImage: string;
  clayImage: string;
  width: number;
  height: number;
  frames: number;
  /** Seconds the server spent encoding and uploading. */
  took?: number;
}

/** A shot list being planned on the server (server/scene.ts). */
export interface ScenePlan {
  id: string;
  status: 'running' | 'done' | 'failed';
  scene: string;
  shots?: { framing: string; move: string; action: string; seconds: number }[];
  planner?: 'engine' | 'llm' | 'ollama' | 'split';
  notes: string[];
  seconds?: number;
  error?: string;
  /** While running: the planner at work, its model, what it is doing and the shots written so far. */
  stage?: 'engine' | 'llm' | 'ollama';
  model?: string;
  phase?: 'waiting' | 'thinking' | 'writing';
  partial?: { framing: string; move: string; action: string; seconds: number }[];
}

/** How a loop closes (server/seam.ts). ratio is the wrap as a multiple of an ordinary frame step. */
export interface SeamMeasure {
  n: number;
  fps: number;
  verdict: 'seamless' | 'visible';
  ratio: number;
  texture: { wrap: number; local: number; median: number; ratio: number };
  composition: { wrap: number; local: number; ratio: number };
  splices?: { frame: number; ratio: number }[];
}

export interface LiveEvents {
  onProgress: (v: { promptId: string; value: number; max: number }) => void;
  onStarted?: (promptId: string) => void;
  onPreview: (blobUrl: string, promptId: string | null) => void;
  onTake: (take: Take) => void;
  onQueue: (remaining: number) => void;
  onPhone?: (e: PhoneEvent) => void;
  onPhoneApp?: (e: PairEvent) => void;
}

/** Connect the live socket; auto-reconnects. Returns a cleanup fn. */
export function connectLive(ev: LiveEvents): () => void {
  let ws: WebSocket | null = null;
  let dead = false;
  let lastPreview: string | null = null;
  let previewJob: string | null = null;

  const open = () => {
    ws = new WebSocket(`ws://${location.host}/live`);
    ws.binaryType = 'blob';
    ws.onmessage = (m) => {
      if (m.data instanceof Blob) {
        if (lastPreview) URL.revokeObjectURL(lastPreview);
        lastPreview = URL.createObjectURL(m.data);
        ev.onPreview(lastPreview, previewJob);
        return;
      }
      try {
        const d = JSON.parse(m.data);
        if (d.type === 'preview') previewJob = d.promptId ?? null;
        if (d.type === 'progress') ev.onProgress(d);
        if (d.type === 'started') ev.onStarted?.(d.promptId);
        if (d.type === 'take') ev.onTake(d.take);
        if (d.type === 'queue') ev.onQueue(d.remaining);
        if (d.type === 'phone') ev.onPhone?.(d);
        if (d.type === 'phoneapp') ev.onPhoneApp?.(d);
      } catch { /* ignore */ }
    };
    ws.onclose = () => { if (!dead) setTimeout(open, 2500); };
  };
  open();
  return () => { dead = true; ws?.close(); };
}

/**
 * One agent turn, streamed over SSE. `onEvent` fires for every event as it
 * arrives (thinking, text, each tool call and its result, queued take ids).
 * Aborting `signal` closes the stream and stops the server-side loop.
 */
export async function agentChat(message: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, history?: HistoryMsg[]): Promise<void> {
  const r = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, ...(history?.length ? { history } : {}) }),
    signal,
  });
  if (!r.ok || !r.body) {
    let msg = `agent ${r.status}`;
    try { const d = (await r.json()) as { error?: string; message?: string }; msg = d.error || d.message || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
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
      if (!data) continue;
      try { onEvent(JSON.parse(data) as AgentEvent); } catch { /* ignore a torn line */ }
    }
  }
}

export const mediaUrl = (id: number) => `/api/media/${id}`;
export const posterUrl = (id: number) => `/api/poster/${id}`;
export const downloadUrl = (id: number) => `/api/media/${id}?download=1`;
/** An Object take's sidecars: the turntable render and the isolated subject it was built from. */
export const turntableUrl = (id: number) => `/api/takes/${id}/turntable`;
export const subjectUrl = (id: number) => `/api/takes/${id}/subject`;
/** An HDR finish's downloads: the EXR zip, the HLG HEVC .mov, the HLG ProRes .mov. */
export const finishFileUrl = (id: number, which: 'exr' | 'hlg' | 'prores') => `/api/takes/${id}/file/${which}`;
export const inputUrl = (token: string) => `/api/input-image/${encodeURIComponent(token)}`;
/** A take's ComfyUI workflow (API format). The path ends in a .json filename
 *  because ComfyUI names a dropped link after its URL and types it by extension. */
export const workflowUrl = (id: number, download = false) =>
  `/api/takes/${id}/workflow/openfield_take_${id}.json${download ? '?download=1' : ''}`;

/** Read a File as a data URL and upload it; returns the asset token. */
export async function uploadFile(f: File): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
  return (await api.upload(f.name, dataUrl)).name;
}

/**
 * A finished take's media as a new input (Animate, Use as reference, stage
 * look, ...). The server stages the file straight into the engine — at any
 * size, without the bytes crossing the browser as base64.
 */
export async function takeAsInput(id: number): Promise<string> {
  return (await api.takeInput(id)).token;
}
