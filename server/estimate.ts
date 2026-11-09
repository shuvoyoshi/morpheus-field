/**
 * Render-time estimates from finished takes: the median of the takes that ran
 * like the one asked about (GET /api/estimate). No I/O, so it can be tested.
 */

/** A finished take as the estimate reads it. */
export interface EstimateTake { kind: string; settings: string; render_seconds: number | null; status: string }

/** The take kind a request kind produces: music and speech both land as 'audio'. */
const FAMILY: Record<string, string> = { music: 'audio', speech: 'audio' };
const kindOf = (k: string) => (k === 'still' || k === 'upres' || k === 'object' ? k : FAMILY[k] ?? 'video');

/** Whether a take ran like the query: same kind and app, model, quality, H3 turbo, about the same size and length. */
export function ranLike(q: Record<string, string | undefined>, t: EstimateTake): boolean {
  const s = JSON.parse(t.settings);
  if (t.kind !== kindOf(q.kind ?? 'video')) return false;
  // Upscale takes only answer for the Upscale app, per mode.
  if ((s.app === 'upscale') !== (q.app === 'upscale')) return false;
  // Apps with their own pipeline (Remove background, Restyle, Swap) only answer for themselves.
  if (q.app && s.app !== q.app) return false;
  if (q.mode && s.mode !== q.mode) return false;
  // Object takes from before the engine choice are all TRELLIS.2.
  if (q.model) {
    const m = s.videoModel || s.model || (t.kind === 'object' ? 'trellis' : undefined);
    if (m !== q.model) return false;
  }
  if (q.quality && s.quality && s.quality !== q.quality) return false;
  // H3 with a step distill runs several times faster than full sampling: never mix the two.
  if (q.turbo && (s.h3Turbo || 'none') !== q.turbo) return false;
  const px = (s.width || 0) * (s.height || 0);
  const qpx = Number(q.w) * Number(q.h);
  if (qpx && Math.abs(px - qpx) / qpx > 0.25) return false;
  if (q.seconds && s.seconds && Math.abs(s.seconds - Number(q.seconds)) > 1) return false;
  return true;
}

/** The median render time of the finished takes that ran like the query, and how many there were. */
export function estimate(q: Record<string, string | undefined>, list: EstimateTake[]): { seconds: number | null; samples: number } {
  const secs = list
    .filter((t) => t.status === 'done' && t.render_seconds && ranLike(q, t))
    .map((t) => t.render_seconds!)
    .sort((a, b) => a - b);
  return { seconds: secs.length ? secs[Math.floor(secs.length / 2)] : null, samples: secs.length };
}
