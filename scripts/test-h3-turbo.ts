/**
 * H3 sampling (turbo / max) and LoRA chaining, no GPU or engine needed:
 * `npm run test:h3-turbo`.
 *
 * The page's preset list (src/presets.ts) and the server's (server/graphs/h3.ts)
 * must name the same preset and file; the Video page offers turbo only when the
 * distill is present; the server refuses an unknown preset or a missing LoRA in
 * words. Every mode (t2v, i2v, refs) runs on the all-in-one checkpoint.
 */
import assert from 'assert/strict';
import { H3_TURBO, H3_TURBO_FILES, H3_TURBO_LORA, availableH3Turbo } from '../src/presets.js';
import { H3_TURBO_PRESETS, H3_MODELS, buildH3Graph, turboProblem } from '../server/graphs/h3.js';
import { estimate, type EstimateTake } from '../server/estimate.js';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

const DISTILL = H3_TURBO_FILES.turbo;

check('page and server name the same preset, file and steps', () => {
  assert.deepEqual(H3_TURBO.map((t) => t.key), H3_TURBO_PRESETS.map((p) => p.id));
  for (const p of H3_TURBO_PRESETS) {
    assert.equal(H3_TURBO_FILES[p.id], p.lora, p.id);
    assert.equal(H3_TURBO.find((t) => t.key === p.id)?.steps, p.steps, p.id);
  }
  assert.equal(H3_TURBO_LORA, H3_TURBO_PRESETS[0].lora);
});

check('the page offers turbo only when the distill ComfyUI lists, under that exact name', () => {
  assert.deepEqual(availableH3Turbo([]), []);
  assert.deepEqual(availableH3Turbo(['other.safetensors', DISTILL]).map((t) => t.key), ['turbo']);
  assert.deepEqual(availableH3Turbo([`sub\\${DISTILL}`]), [], 'a file in a subfolder is another name to ComfyUI');
});

check('the server lets a listed preset run, and refuses a missing LoRA or an unknown id in words', () => {
  assert.equal(turboProblem('turbo', new Set([DISTILL])), null);
  assert.match(turboProblem('turbo', new Set(['other.safetensors']))!, /needs .*models\/loras.*h3-turbo/);
  assert.match(turboProblem('warp-9', new Set([DISTILL]))!, /Unknown H3 turbo preset "warp-9"/);
});

check('the estimate keeps H3 turbo and max sampling apart, and LTX-2.5 as it was', () => {
  const take = (settings: Record<string, unknown>, render_seconds: number): EstimateTake =>
    ({ kind: 'video', status: 'done', render_seconds, settings: JSON.stringify({ width: 896, height: 512, seconds: 5, ...settings }) });
  const list = [
    take({ videoModel: 'h3' }, 1116), take({ videoModel: 'h3' }, 1100),
    take({ videoModel: 'h3', h3Turbo: 'turbo' }, 247), take({ videoModel: 'h3', h3Turbo: 'turbo' }, 250),
    take({ videoModel: 'ltx25' }, 90),
  ];
  const q = { kind: 'video', model: 'h3', w: '896', h: '512', seconds: '5' };
  assert.deepEqual(estimate({ ...q, turbo: 'turbo' }, list), { seconds: 250, samples: 2 });
  assert.deepEqual(estimate({ ...q, turbo: 'none' }, list), { seconds: 1116, samples: 2 });
  assert.deepEqual(estimate({ ...q, model: 'ltx25' }, list), { seconds: 90, samples: 1 });
});

check('a turbo graph loads the distill and its shift, runs 8 steps, on the all-in-one checkpoint', () => {
  const g = buildH3Graph({ prompt: 'p', width: 832, height: 480, lengthFrames: 124, seed: 1, steps: 20, turbo: 'turbo' }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(g.u.inputs.unet_name, H3_MODELS.unet);
  assert.equal(g.lora0.inputs.lora_name, DISTILL);
  assert.equal(g.lora0.inputs.strength_model, 1.0);
  assert.ok(g.shift, 'turbo applies the sigma shift');
  assert.deepEqual(g.shift.inputs.model, ['lora0', 0]);
  assert.equal(g.sched.inputs.steps, 8);
  assert.equal(g.sampler.inputs.sampler_name, 'euler');
  assert.deepEqual(g.sched.inputs.model, ['shift', 0]);
  assert.deepEqual(g.guider.inputs.model, ['shift', 0]);
});

check('a max graph runs 20 steps with no distill and no shift', () => {
  const g = buildH3Graph({ prompt: 'p', width: 832, height: 480, lengthFrames: 124, seed: 1, steps: 20 }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(g.u.inputs.unet_name, H3_MODELS.unet);
  assert.equal(g.lora0, undefined);
  assert.equal(g.shift, undefined);
  assert.equal(g.sched.inputs.steps, 20);
  assert.deepEqual(g.sched.inputs.model, ['u', 0]);
});

check('your LoRAs chain before the turbo distill, each at its strength', () => {
  const g = buildH3Graph({
    prompt: 'p', width: 832, height: 480, lengthFrames: 124, seed: 1, steps: 20, turbo: 'turbo',
    loras: [{ file: 'char.safetensors', strength: 0.8 }, { file: 'style.safetensors', strength: 1.2 }],
  }) as Record<string, { inputs: Record<string, unknown> }>;
  // char -> style -> distill, then the shift
  assert.equal(g.lora0.inputs.lora_name, 'char.safetensors');
  assert.equal(g.lora0.inputs.strength_model, 0.8);
  assert.deepEqual(g.lora0.inputs.model, ['u', 0]);
  assert.equal(g.lora1.inputs.lora_name, 'style.safetensors');
  assert.equal(g.lora1.inputs.strength_model, 1.2);
  assert.deepEqual(g.lora1.inputs.model, ['lora0', 0]);
  assert.equal(g.lora2.inputs.lora_name, DISTILL);
  assert.equal(g.lora2.inputs.strength_model, 1.0);
  assert.deepEqual(g.lora2.inputs.model, ['lora1', 0]);
  assert.deepEqual(g.shift.inputs.model, ['lora2', 0]);
  assert.equal(g.sched.inputs.steps, 8);
});

check('reference mode runs on the same all-in-one checkpoint', () => {
  const g = buildH3Graph({ prompt: 'p', width: 832, height: 480, lengthFrames: 124, seed: 1, steps: 20, refImages: ['r1.png', 'r2.png'] }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(g.u.inputs.unet_name, H3_MODELS.unet);
  assert.equal(g.gen.class_type, 'MiniMaxH3ReferenceToVideo');
});

check('text-to-video (no frames) builds a valid graph with no frame loaders', () => {
  const g = buildH3Graph({ prompt: 'p', width: 832, height: 480, lengthFrames: 124, seed: 1, steps: 20 }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(g.gen.class_type, 'MiniMaxH3ImageToVideo');
  assert.equal(g.gen.inputs.first_frame, undefined);
  assert.equal(g.gen.inputs.last_frame, undefined);
  assert.ok(!('ls' in g) && !('le' in g), 'no frame loaders without frames');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exit(1);
