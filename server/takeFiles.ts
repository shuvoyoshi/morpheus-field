/**
 * A take's on-disk footprint, computed from its row: the output file plus the
 * side files Morpheus writes next to it (poster, the object turntable and
 * subject, the alpha cut, and the HDR masters). Used by `?purge=1` on
 * DELETE /api/takes/:id and testable without a server.
 */

/** A take's settings, or {} if they are malformed — a route must not 500 on a bad row. */
export function safeSettings(t: { settings: string }): Record<string, any> {
  try {
    const s = JSON.parse(t.settings);
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

/** Every file a take owns: the output, its poster/sidecars, the alpha cut, and the HDR masters. */
export function takeFiles(t: { output_path: string | null; settings: string }): string[] {
  const out: string[] = [];
  if (!t.output_path) return out;
  out.push(t.output_path, `${t.output_path}.poster.jpg`, `${t.output_path}.turntable.mp4`, `${t.output_path}.subject.png`);
  const s = safeSettings(t);
  if (typeof s.alphaPath === 'string') out.push(s.alphaPath);
  // The engine's original output, kept when the save fell back to a copy.
  if (typeof s.engineFile === 'string') out.push(s.engineFile);
  if (s.hdr && typeof s.hdr === 'object') {
    for (const k of ['exrZip', 'hlgMov', 'proresMov'] as const) if (typeof s.hdr[k] === 'string') out.push(s.hdr[k]);
  }
  return [...new Set(out)];
}
