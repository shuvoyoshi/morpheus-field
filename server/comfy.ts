/**
 * ComfyUI server introspection: health, VRAM, model enums, node classes,
 * and launching the engine. Comfy API v2 does not cover node introspection
 * yet, so these read the ComfyUI server API directly. Every job (submit,
 * progress, outputs, cancel) goes through the Comfy SDK in engine.ts.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { config, ROOT } from './config.js';
import { meta } from './jobs.js';

/** A folder path as ComfyUI reports it, made readable from this process (WSL sees D:\ as /mnt/d). */
function enginePath(dir: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
  if (m && process.platform !== 'win32') return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  return dir;
}

const COMFY = config.comfyUrl;

export interface ComfyStatus {
  up: boolean;
  version?: string;
  gpu?: string;
  vramFreeGb?: number;
  vramTotalGb?: number;
  queueRemaining?: number;
  otherGpuProcess?: boolean;
}

export async function getStatus(): Promise<ComfyStatus> {
  try {
    const r = await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(config.probeTimeoutMs) });
    if (!r.ok) return { up: false };
    const d = (await r.json()) as any;
    const dev = d.devices?.[0] ?? {};
    const q = await fetch(`${COMFY}/prompt`, { signal: AbortSignal.timeout(config.probeTimeoutMs) })
      .then((x) => x.json() as any)
      .catch(() => null);
    return {
      up: true,
      version: d.system?.comfyui_version,
      gpu: typeof dev.name === 'string' ? dev.name.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '') : undefined,
      vramFreeGb: dev.vram_free ? dev.vram_free / 1e9 : undefined,
      vramTotalGb: dev.vram_total ? dev.vram_total / 1e9 : undefined,
      queueRemaining: q?.exec_info?.queue_remaining,
      // Heuristic from the 2026-06-29 Topaz incident: almost-no free VRAM
      // while our queue is empty means another process owns the GPU.
      otherGpuProcess:
        q?.exec_info?.queue_remaining === 0 && dev.vram_free && dev.vram_free < 3e9,
    };
  } catch {
    return { up: false };
  }
}

// ------------------------------------------------------------------ engine ----
//
// Setup > Engine: which mode (LAN or WAN) and, in LAN mode, which card. The
// choice persists in the meta table like the render tier; it applies at the
// next launch (stop, then start, to switch cards mid-session).

export type EngineMode = 'lan' | 'wan';
export type EngineGpu = '4090' | '5090' | 'both';
export interface EngineSelection { mode: EngineMode; gpu: EngineGpu; }
export interface EngineState extends EngineSelection {
  source: 'user' | 'default';
  /** A COMFY_LAUNCH_WAN (listen bat) is configured, so WAN mode can do anything. */
  wanConfigured: boolean;
}

const ENGINE_KEY = 'engine_launch';
const DEFAULT_SELECTION: EngineSelection = { mode: 'lan', gpu: 'both' };

function readSelection(): EngineSelection {
  const raw = meta.get(ENGINE_KEY);
  if (!raw) return DEFAULT_SELECTION;
  try {
    const o = JSON.parse(raw) as Partial<EngineSelection>;
    const mode = o.mode === 'lan' || o.mode === 'wan' ? o.mode : DEFAULT_SELECTION.mode;
    const gpu = o.gpu === '4090' || o.gpu === '5090' || o.gpu === 'both' ? o.gpu : DEFAULT_SELECTION.gpu;
    return { mode, gpu };
  } catch {
    return DEFAULT_SELECTION;
  }
}

/** The saved launch choice, for the UI and /api/status. */
export function engineState(): EngineState {
  const sel = readSelection();
  return { ...sel, source: meta.get(ENGINE_KEY) ? 'user' : 'default', wanConfigured: !!config.comfyLaunchWan };
}

/** Persist a mode and/or gpu choice; returns the full state. */
export function setEngineSelection(patch: Partial<EngineSelection>): EngineState {
  const cur = readSelection();
  const next: EngineSelection = { mode: patch.mode ?? cur.mode, gpu: patch.gpu ?? cur.gpu };
  meta.set(ENGINE_KEY, JSON.stringify(next));
  return engineState();
}

/** Physical CUDA indices on this machine: 0 = RTX 4090, 1 = RTX 5090. */
function gpuEnv(gpu: EngineGpu): string {
  // both: 5090 primary, the same order the listen bat uses (CUDA_VISIBLE_DEVICES=1,0).
  return gpu === '4090' ? '0' : gpu === '5090' ? '1' : '1,0';
}

/**
 * Start ComfyUI using the COMFY_LAUNCH command, then wait for it to answer.
 * Idempotent: no-ops if the engine is already up. Returns false immediately
 * when no launch command is configured — Morpheus never guesses how to start a
 * renderer it did not install.
 *
 * WAN mode uses COMFY_LAUNCH_WAN (a bat that passes --listen); LAN mode uses
 * COMFY_LAUNCH with CUDA_VISIBLE_DEVICES pinned to the chosen card. The bat
 * sets its own CUDA_VISIBLE_DEVICES, so WAN inherits nothing extra.
 */
export async function launchEngine(timeoutMs = config.comfyLaunchTimeout): Promise<boolean> {
  if ((await getStatus()).up) return true;
  const sel = readSelection();
  const isWan = sel.mode === 'wan';
  const command = isWan ? config.comfyLaunchWan || config.comfyLaunch : config.comfyLaunch;
  if (!command) return false;
  const env: NodeJS.ProcessEnv = isWan
    ? { ...process.env }
    : { ...process.env, CUDA_VISIBLE_DEVICES: gpuEnv(sel.gpu) };
  const { spawn } = await import('child_process');
  // cmd.exe refuses to run with a UNC working directory, which is what a WSL
  // path looks like to it — so hand the child a drive-backed cwd when we have one.
  const cwd = existsSync('/mnt/c') ? '/mnt/c' : ROOT;
  try {
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: 'ignore', env });
    child.on('error', (e) => console.error('[openfield] COMFY_LAUNCH failed:', e.message));
    child.unref();
  } catch (e) {
    console.error('[openfield] COMFY_LAUNCH failed:', e instanceof Error ? e.message : e);
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if ((await getStatus()).up) return true;
  }
  return false;
}

/** True when a launch command is configured, i.e. START ENGINE can do anything. */
export function canLaunchEngine(): boolean {
  return !!(config.comfyLaunch || config.comfyLaunchWan);
}

/**
 * Stop a running ComfyUI: kill its python (the main.py process) and the bat
 * window that launched it, with their process trees. Windows-first; a
 * POSIX best-effort pkill otherwise. Returns how many process trees were
 * asked to die (0 = nothing matched, e.g. the engine was already down).
 */
export async function stopEngine(): Promise<{ ok: boolean; killed: number }> {
  const { execFile } = await import('child_process');
  if (process.platform === 'win32') {
    const pids = await comfyProcessPids();
    for (const pid of pids) {
      await new Promise<void>((res) => execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => res()));
    }
    return { ok: pids.length > 0, killed: pids.length };
  }
  await new Promise<void>((res) => execFile('pkill', ['-f', 'main\\.py'], () => res()));
  return { ok: true, killed: 1 };
}

/** PIDs of ComfyUI's python (its main.py) and the bat's cmd that started it. */
function comfyProcessPids(): Promise<number[]> {
  const script =
    "$p=@(); " +
    "$p+=(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object CommandLine -match 'main\\.py' | Select-Object -ExpandProperty ProcessId); " +
    "$p+=(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object CommandLine -match 'Start ComfyUI' | Select-Object -ExpandProperty ProcessId); " +
    "$p | Select-Object -Unique | ForEach-Object { [string]$_ }";
  return new Promise((resolve) => {
    import('child_process').then(({ execFile }) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], (err, stdout) => {
        if (err) return resolve([]);
        resolve(stdout.split(/\s+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0));
      });
    });
  });
}

/**
 * Read a node's COMBO option list out of /object_info.
 *
 * ComfyUI has two shapes in the wild and both appear in a single install:
 * legacy `[[...options], {...}]` and the V3 schema's
 * `["COMBO", { options: [...] }]`. Reading only the first breaks silently
 * (`.filter is not a function`) the day a node is ported.
 */
export async function comboOptions(nodeClass: string, input: string): Promise<string[]> {
  try {
    const r = await fetch(`${COMFY}/object_info/${encodeURIComponent(nodeClass)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const spec = ((await r.json()) as any)?.[nodeClass]?.input?.required?.[input];
    if (!Array.isArray(spec)) return [];
    if (Array.isArray(spec[0])) return spec[0].filter((x: unknown) => typeof x === 'string');
    const opts = spec[1]?.options;
    return Array.isArray(opts) ? opts.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Files in one of the engine's model folders (GET /models/<folder>), for
 * loaders whose dropdown lists files that are not on disk yet (SeedVR2 offers
 * its whole download registry). Empty when the engine is down.
 */
export async function listModelFolder(folder: string): Promise<string[]> {
  try {
    const r = await fetch(`${COMFY}/models/${encodeURIComponent(folder)}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const d = (await r.json()) as unknown;
    return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Node class names the engine knows about — used by preflight. */
export async function listNodeClasses(): Promise<Set<string>> {
  try {
    const r = await fetch(`${COMFY}/object_info`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return new Set();
    return new Set(Object.keys((await r.json()) as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

import { classifySpice } from './spice.js';

/** Model files the engine can currently see, grouped for the UI. */
export async function listCheckpoints(): Promise<Record<string, string[]>> {
  const [unets, ckpts, loras] = await Promise.all([
    comboOptions('UNETLoader', 'unet_name'),
    comboOptions('CheckpointLoaderSimple', 'ckpt_name'),
    comboOptions('LoraLoaderModelOnly', 'lora_name'),
  ]);
  // Spice files are mapped into every ComfyUI folder, so header-classify
  // them and only offer each file where it can actually function.
  const spice = await classifySpice();
  const spiceLoraSet = new Set(spice.loras);
  const spiceModelSet = new Set(spice.models);
  return {
    h3: unets.filter((n) => /minimax|h3/i.test(n)),
    flux2: unets.filter((n) => n.startsWith('flux2')),
    qwen: unets.filter((n) => n.startsWith('qwen_image')),
    // LTX family: full checkpoints + spice transformers — NEVER spice loras
    ltx: [...new Set([...ckpts, ...unets])].filter(
      (n) => (/ltx/i.test(n) || /lt3x/i.test(n) || spiceModelSet.has(n)) && !spiceLoraSet.has(n)
    ),
    checkpoints_all: ckpts,
    unets_all: unets,
    // Extra-LoRA menu: engine loras minus anything that's a full model
    loras: loras.filter((n) => !spiceModelSet.has(n)),
  };
}

let outputDirCache: string | null | undefined;

/**
 * ComfyUI's output folder on this machine, as the engine reports it — the
 * one place its render results land before Morpheus moves them into a
 * project. Fallback: the output/ next to the models/ directory.
 */
export async function comfyOutputDir(): Promise<string | null> {
  if (outputDirCache !== undefined) return outputDirCache;
  let dir: string | null = null;
  try {
    const r = await fetch(`${COMFY}/internal/folder_paths`, { signal: AbortSignal.timeout(3000) });
    const d = (await r.json()) as Record<string, unknown>;
    const entry = d?.output as unknown;
    const list = Array.isArray((entry as [unknown[]] | undefined)?.[0])
      ? ((entry as [string[]])[0] ?? [])
      : Array.isArray(entry) ? (entry as string[]) : [];
    dir = list.map(enginePath).find((p) => existsSync(p)) ?? null;
  } catch { /* engine down or an older build without the route */ }
  if (!dir && config.comfyModelsDir) {
    const p = resolve(config.comfyModelsDir, '..', 'output');
    if (existsSync(p)) dir = p;
  }
  outputDirCache = dir;
  return dir;
}
