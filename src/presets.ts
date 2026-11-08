/** Doctrine encoded: iterate cheap, spend full-res only on locked heroes. */

export const RES_PRESETS = [
  { key: 'iterate', label: '0.4MP · ~3min/5s', w: 864, h: 480 },
  { key: 'mid', label: '0.6MP · ~8min/5s', w: 1056, h: 608 },
  { key: 'hero', label: '1MP MAX · slow', w: 1344, h: 768 },
] as const;

export const STILL_SIZES = [
  { key: '16:9', w: 1664, h: 928 },
  { key: '9:16', w: 928, h: 1664 },
  { key: '1:1', w: 1328, h: 1328 },
] as const;

/**
 * Style preambles are user data, not constants — they live in the database and
 * are edited in the UI (Setup panel -> Style preamble -> EDIT). See
 * server/jobs.ts for the starters seeded into a fresh install.
 */

/** H3 frame grid: 17k+5. Returns nearest legal frame count for a seconds value. */
export function secondsToFrames(seconds: number): number {
  const target = Math.round(seconds * 24);
  const k = Math.round((target - 5) / 17);
  return Math.max(5, Math.min(362, 17 * Math.max(0, k) + 5));
}

/**
 * H3 turbo (step distill) option. Mirrors H3_TURBO_PRESETS in
 * server/graphs/h3.ts — the id must stay in sync; the server is the authority
 * on which LoRA file and sigma shift the id actually applies.
 */
export const H3_TURBO = [
  { key: 'turbo', label: '8-STEP · TURBO', steps: 8,
    note: 'The v0.1 step distill at 8 steps — about 2.5x faster than the 20-step max.' },
] as const;

/** The step-distill the turbo preset applies, at strength 1.0. */
export const H3_TURBO_LORA =
  'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors';

/** LoRA filenames the turbo preset needs present in ComfyUI's lora folder. */
export const H3_TURBO_FILES: Record<string, string> = {
  turbo: H3_TURBO_LORA,
};
/** The turbo presets whose LoRA ComfyUI lists, under exactly the name the graph asks for. */
export const availableH3Turbo = (loras: readonly string[]) => {
  const have = new Set(loras);
  return H3_TURBO.filter((t) => have.has(H3_TURBO_FILES[t.key]));
};
