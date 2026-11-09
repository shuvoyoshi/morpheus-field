/**
 * VRAM auto-clear: while the engine is idle (no queued jobs) but still holding
 * models in VRAM, free them on a one-minute tick so a render never starts on a
 * GPU that is out of memory for the next model. A Setup switch turns it off, in
 * which case models stay loaded.
 *
 * "A model is hot loaded" is read from the GPU: if VRAM is in use (free < total)
 * while the queue is empty, something is resident. Without a job in flight
 * freeing it is always safe — the next render simply reloads it.
 */
import { config } from './config.js';
import { meta } from './jobs.js';
import * as comfy from './comfy.js';
import * as eng from './engine.js';
import { modelsUnloaded } from './modelSwitch.js';

const KEY = 'vram_auto_clear';

/** The Setup switch: on by default is a foot-gun (it unloads mid-session), so
 *  off until the user opts in. */
export const vramClearOn = (): boolean => meta.get(KEY) === '1';
export function setVramClear(on: boolean): void {
  if (on) meta.set(KEY, '1');
  else meta.delete(KEY);
}

/** The engine's queue, or null when it cannot be asked. */
async function queued(): Promise<number | null> {
  try {
    const r = await fetch(`${config.comfyUrl}/queue`, { signal: AbortSignal.timeout(4000) });
    const q = (await r.json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
  } catch {
    return null;
  }
}

async function tick(): Promise<void> {
  if (!vramClearOn() || !eng.isLocal()) return;
  // A queued or running job = the GPU is busy; leave its models alone.
  const q = await queued();
  if (q === null || q > 0) return;
  const st = await comfy.getStatus().catch(() => null);
  // VRAM reserved (free well under total) means a model is resident.
  if (st?.up && st.vramTotalGb && st.vramFreeGb !== undefined && st.vramFreeGb < st.vramTotalGb - 0.5) {
    await fetch(`${config.comfyUrl}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    modelsUnloaded();
    console.log('[openfield] VRAM auto-clear: freed idle models');
  }
}

let timer: NodeJS.Timeout | null = null;
let intervalMs = 60_000;
/** The last tick (or start), so the client can count down to the next one. */
let anchorAt: number | null = null;

export function startVramAutoClear(ms = 60_000): void {
  if (timer) return;
  intervalMs = ms;
  anchorAt = Date.now();
  timer = setInterval(() => {
    anchorAt = Date.now();
    void tick().catch(() => {});
  }, ms);
  // A timer must never keep the process alive on the way out.
  timer.unref?.();
}

/** The auto-clear state + when it next fires (server epoch ms), for the countdown. */
export function vramClearInfo(): { on: boolean; intervalMs: number; nextAt: number | null } {
  return { on: vramClearOn(), intervalMs, nextAt: anchorAt === null ? null : anchorAt + intervalMs };
}
