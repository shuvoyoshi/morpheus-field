/**
 * Render a short looping preview for every motion preset into
 * public/presets/<id>.mp4, through the running Morpheus server.
 *
 *   npm run presets              # all missing
 *   npm run presets -- push-in   # just these ids (re-renders)
 *
 * Each preview is t2v on LTX-2.5, 3:4, 3 seconds, no audio. The render's
 * take is deleted afterwards so previews never show up in the Library.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ROOT, config } from '../server/config.js';
import { PRESETS } from '../src/catalog.js';

const API = `http://127.0.0.1:${config.port}`;
const OUT = join(ROOT, 'public', 'presets');
mkdirSync(OUT, { recursive: true });

/** One subject per preset, picked to show the move or effect off clearly. */
const SUBJECT: Record<string, string> = {
  free: 'A lone tree on a hill under drifting clouds, wind in the grass.',
  'push-in': 'An old lighthouse keeper in a yellow raincoat on a stormy pier.',
  'pull-back': 'A small red tent on a vast white salt flat at dawn.',
  'orbit-left': 'A bronze statue of a dancer in an empty marble hall.',
  'orbit-right': 'A vintage motorcycle parked in a neon-lit alley at night.',
  'crane-up': 'A street market at dusk, strings of lanterns, crowds below.',
  'truck-left': 'A woman cycling past a row of colorful houses by a canal.',
  handheld: 'A boxer catching his breath in a dim gym, sweat and dust in the light.',
  static: 'Waves crashing against black rocks, spray blown by the wind.',
  'rack-focus': 'Raindrops on a window, a city skyline glowing behind them.',
  'dolly-zoom': 'A man standing at the end of a long hotel corridor.',
  'crash-zoom': 'A cat sitting on a rooftop that suddenly looks at the camera.',
  'fpv-dive': 'A waterfall pouring into a green jungle canyon.',
  'whip-pan': 'Two dancers on a rooftop at sunset.',
  'aerial-pull': 'A winding mountain road through autumn forest.',
  'freeze-orbit': 'A splash of water frozen around a falling red apple.',
  snorricam: 'A runner sprinting through a busy night street.',
  embers: 'A blacksmith at an anvil in a dark forge.',
  'ink-bloom': 'A pale porcelain mask resting on black water.',
  shatter: 'A mirror reflecting a candle in a dark room.',
  'fog-roll': 'An abandoned train station at night under one streetlamp.',
  'neon-rain': 'A taxi waiting at a crossing in a dense city.',
  disintegrate: 'A stone statue of a horse on a desert plain.',
  bloom: 'A rusted car abandoned in an empty field.',
  golden: 'A wheat field with a farmhouse in the distance.',
  noir: 'A detective lighting a cigarette under a streetlamp.',
  dreamlike: 'A girl holding a paper lantern in a field of tall grass at night.',
  storm: 'A lone windmill on a prairie under a dark sky.',
};

const only = process.argv.slice(2);
const todo = PRESETS.filter((p) => (only.length ? only.includes(p.id) : !existsSync(join(OUT, `${p.id}.mp4`))));
console.log(`${todo.length} preset previews to render`);

/** Fetch JSON; ride out a server restart instead of dying mid-batch. */
async function j(path: string, init?: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(API + path, init);
      const d = await r.json();
      if (!r.ok) throw Object.assign(new Error(d.error || String(r.status)), { http: true });
      return d;
    } catch (e: any) {
      if (e?.http || attempt > 30) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

for (const p of todo) {
  const prompt = [p.text, SUBJECT[p.id] ?? 'A quiet cinematic landscape.', 'Cinematic, beautiful light, high detail.'].filter(Boolean).join(' ');
  const { takeId } = await j('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'video', videoModel: 'ltx25', app: 'preset-thumb', prompt, width: 576, height: 768, seconds: 3, seed: 1234, shotName: `preset_${p.id}` }),
  });
  process.stdout.write(`${p.id.padEnd(14)} take ${takeId} `);
  let t: any;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    t = (await j('/api/takes')).find((x: any) => x.id === takeId);
    if (t && !['queued', 'rendering'].includes(t.status)) break;
  }
  if (t.status !== 'done') { console.log(`FAILED ${t.error}`); continue; }
  execFileSync(config.ffmpegBin, ['-v', 'error', '-y', '-i', t.output_path, '-an', '-vf', 'scale=360:-2', '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT, `${p.id}.mp4`)]);
  await j(`/api/takes/${takeId}`, { method: 'DELETE' });
  console.log(`ok ${Math.round(t.render_seconds)}s`);
}
console.log('done');
