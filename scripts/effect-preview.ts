/**
 * Cut an Effects card preview from a finished effect take, into
 * public/effects/<effect>.mp4 (3:4, 360x480, 3 s, silent), the same shape as
 * the motion preset previews in public/presets/.
 *
 *   npm run effects:preview -- <takeId> [start-seconds]
 *
 * Clip effects show a before / after split: the source clip on the left half,
 * the effect on the right, so the card reads at thumbnail size. Still effects
 * show the result alone. Reads the take through the running Morpheus server
 * (OPENFIELD_PORT, default 3161).
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ROOT, config } from '../server/config.js';
import { effectById } from '../src/effects.js';

const API = `http://127.0.0.1:${config.port}`;
const [idArg, startArg] = process.argv.slice(2);
if (!idArg) throw new Error('usage: effect-preview.ts <takeId> [start-seconds]');
const takes = (await (await fetch(`${API}/api/takes`)).json()) as any[];
const t = takes.find((x) => x.id === Number(idArg));
if (!t?.output_path || t.status !== 'done') throw new Error(`take ${idArg} is not a finished take`);
const s = JSON.parse(t.settings);
const fx = effectById(s.effect);
if (!fx) throw new Error(`take ${idArg} is not an effect take`);

const OUT = join(ROOT, 'public', 'effects');
mkdirSync(OUT, { recursive: true });
const out = join(OUT, `${fx.id}.mp4`);
const ss = String(Number(startArg) || 0);
// 3:4 centre crop, 360x480.
const card = 'crop=ih*3/4:ih,scale=360:480:flags=lanczos,setsar=1';
const enc = ['-an', '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', '3'];

if (fx.input === 'clip' && s.sourceVideo) {
  const tmp = mkdtempSync(join(tmpdir(), 'of-fxprev-'));
  try {
    const src = join(tmp, 'src.mp4');
    writeFileSync(src, Buffer.from(await (await fetch(`${API}/api/input-image/${encodeURIComponent(s.sourceVideo)}`)).arrayBuffer()));
    // Source scaled to the take's exact size so the halves line up, then split down the middle.
    const graph = [
      `[0:v]scale=${s.width}:${s.height}:force_original_aspect_ratio=increase,crop=${s.width}:${s.height},fps=24,${card}[a]`,
      `[1:v]fps=24,${card}[b]`,
      '[a]crop=180:480:0:0[l]',
      '[b]crop=180:480:180:0[r]',
      '[l][r]hstack,drawbox=x=179:y=0:w=2:h=480:color=white@0.85:t=fill[v]',
    ].join(';');
    execFileSync(config.ffmpegBin, ['-v', 'error', '-y', '-ss', ss, '-i', src, '-ss', ss, '-i', t.output_path, '-filter_complex', graph, '-map', '[v]', ...enc, out]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  execFileSync(config.ffmpegBin, ['-v', 'error', '-y', '-ss', ss, '-i', t.output_path, '-vf', card, ...enc, out]);
}
console.log(`public/effects/${fx.id}.mp4 from take ${t.id}`);
