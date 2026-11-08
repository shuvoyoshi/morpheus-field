/**
 * Director post and scene graphs.
 *
 *   Era grade   a GLSL fragment shader (ComfyUI's GLSLShader node, core since
 *               0.38) on the decoded frames: saturation, contrast, split-tone
 *               lift and gain, black fade, highlight bloom, vignette and grain,
 *               with the knobs from eraGrade() in src/catalog.ts.
 *   Speed ramp  RIFE VFI fills in-between frames, then
 *               GetImagesFromBatchIndexed (KJNodes) keeps the frames rampPlan()
 *               picks along the speed curve. Played back at 24 fps, so the
 *               shot stretches where it is slow. Ramped shots drop their sound.
 *   Shot list   a local LLM in the graph: TextGenerateLTX2Prompt with our own
 *               system prompt, written out by SaveText, parsed by the server.
 *   Cut         every shot's file loaded at one size, ImageBatch-joined and
 *               muxed, the same pattern as the Transition graph in ./ltxtools.ts.
 *
 * applyPost() edits an already-built graph in place: it finds the frames that
 * feed CreateVideo (or SaveImage for a still) and splices the passes in front.
 */
import { rampPlan, type EraGrade, type RampId } from '../../src/catalog.js';

type Ref = [string, number];
type Graph = Record<string, any>;

/**
 * The grade. u_float order matches GRADE_UNIFORMS. Grain hashes the pixel's
 * position with its own color, so it changes from frame to frame as the
 * picture moves (the node passes no frame index).
 */
export const GRADE_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_float0;  // saturation
uniform float u_float1;  // contrast
uniform float u_float2;  // fade (black lift)
uniform float u_float3;  // lift r
uniform float u_float4;  // lift g
uniform float u_float5;  // lift b
uniform float u_float6;  // gain r
uniform float u_float7;  // gain g
uniform float u_float8;  // gain b
uniform float u_float9;  // grain
uniform float u_float10; // bloom
uniform float u_float11; // vignette
uniform float u_float12; // amount (0 = untouched, 1 = full grade)
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec2 uv = v_texCoord;
  vec3 src = texture(u_image0, uv).rgb;
  vec3 c = src;

  // Bloom: highlights spread through a 16-tap ring at two radii.
  if (u_float10 > 0.0) {
    vec2 px = 1.0 / u_resolution;
    float r = max(u_resolution.x, u_resolution.y) * 0.012;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 0.3927;
      float rr = (i % 2 == 0) ? r : r * 2.2;
      vec3 s = texture(u_image0, uv + vec2(cos(a), sin(a)) * rr * px).rgb;
      acc += max(s - 0.55, 0.0);
    }
    c += acc / 16.0 * u_float10 * 2.2;
  }

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, u_float0);
  c = (c - 0.5) * u_float1 + 0.5;

  // Split tone: lift adds color into the shadows, gain multiplies the highlights.
  float w = smoothstep(0.0, 1.0, clamp(l, 0.0, 1.0));
  c += vec3(u_float3, u_float4, u_float5) * (1.0 - w);
  c *= mix(vec3(1.0), vec3(u_float6, u_float7, u_float8), w);

  // Fade: blacks lift, whites roll off a little, like an old print.
  c = mix(vec3(u_float2), vec3(1.0 - u_float2 * 0.35), clamp(c, 0.0, 1.0));

  vec2 d = uv - 0.5;
  c *= 1.0 - u_float11 * dot(d, d) * 1.6;

  float n = hash(vec3(uv * u_resolution, dot(src, vec3(97.0, 131.0, 173.0)))) - 0.5;
  c += n * u_float9 * (1.2 - abs(l - 0.5));

  fragColor0 = vec4(clamp(mix(src, c, u_float12), 0.0, 1.0), 1.0);
}
`;

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Grade knobs as the shader's float inputs, in uniform order. */
export function gradeUniforms(g: EraGrade, amount = 1): number[] {
  return [g.sat, g.contrast, g.fade, ...g.lift, ...g.gain, g.grain, g.bloom, g.vignette, amount].map(r4);
}

/** Grade an image batch. The shader writes RGBA; SplitImageWithAlpha drops the alpha. */
export function gradeNodes(g: Graph, key: string, images: Ref, grade: EraGrade, amount = 1): Ref {
  const inputs: Record<string, unknown> = {
    fragment_shader: GRADE_SHADER,
    size_mode: 'from_input',
    'images.image0': images,
  };
  gradeUniforms(grade, amount).forEach((v, i) => {
    g[`${key}F${i}`] = { class_type: 'PrimitiveFloat', inputs: { value: v } };
    inputs[`floats.u_float${i}`] = [`${key}F${i}`, 0];
  });
  g[key] = { class_type: 'GLSLShader', inputs };
  g[`${key}Rgb`] = { class_type: 'SplitImageWithAlpha', inputs: { image: [key, 0] } };
  return [`${key}Rgb`, 0];
}

/** Retime an image batch of `frames` frames along a ramp. */
export function rampNodes(g: Graph, key: string, images: Ref, ramp: RampId, frames: number): { ref: Ref; outFrames: number } {
  const plan = rampPlan(ramp, frames);
  if (ramp === 'linear') return { ref: images, outFrames: frames };
  g[`${key}Vfi`] = {
    class_type: 'RIFE VFI',
    inputs: {
      frames: images, ckpt_name: 'rife47.pth', clear_cache_after_n_frames: 10,
      multiplier: plan.multiplier, fast_mode: true, ensemble: true, scale_factor: 1.0,
      dtype: 'float32', torch_compile: false, batch_size: 1,
    },
  };
  g[`${key}Pick`] = { class_type: 'GetImagesFromBatchIndexed', inputs: { images: [`${key}Vfi`, 0], indexes: plan.indices.join(', ') } };
  return { ref: [`${key}Pick`, 0], outFrames: plan.outFrames };
}

export interface PostOpts {
  grade?: EraGrade;
  ramp?: RampId;
  /** Frames the graph decodes (needed for the ramp plan). */
  frames?: number;
}

/**
 * Splice the grade and the ramp into a built graph, in front of its
 * CreateVideo (video) or SaveImage (still). A ramp removes the sound.
 * Returns the frame count the output will have.
 */
export function applyPost(g: Graph, o: PostOpts): { outFrames?: number; silent: boolean } {
  const ramp = o.ramp && o.ramp !== 'linear' ? o.ramp : undefined;
  if (!o.grade && !ramp) return { outFrames: o.frames, silent: false };
  const vid = Object.entries(g).find(([, n]) => n?.class_type === 'CreateVideo');
  const still = Object.entries(g).find(([, n]) => n?.class_type === 'SaveImage');
  const target = vid ?? still;
  if (!target) throw new Error('This graph has no CreateVideo or SaveImage to grade');
  const node = target[1];
  let images: Ref = node.inputs.images;
  if (o.grade) images = gradeNodes(g, 'eraGrade', images, o.grade);
  let outFrames = o.frames;
  let silent = false;
  if (ramp && vid) {
    if (!o.frames) throw new Error('A speed ramp needs the frame count');
    const r = rampNodes(g, 'ramp', images, ramp, o.frames);
    images = r.ref;
    outFrames = r.outFrames;
    // The sound no longer lines up with the picture: drop it and its decoder.
    const audio = node.inputs.audio as Ref | undefined;
    delete node.inputs.audio;
    if (audio && g[audio[0]]?.class_type === 'LTXVAudioVAEDecode') delete g[audio[0]];
    silent = true;
  }
  node.inputs.images = images;
  return { outFrames, silent };
}

// ---------------------------------------------------------------- shot list

/** The Gemma 3 12B text encoder of LTX-2.0. It doubles as a working LLM. */
export const PLANNER_ENCODER = 'gemma_3_12B_it_fp4_mixed.safetensors';

export const PLANNER_SYSTEM = (n: { min: number; max: number }, framings: string[], moves: string[]) => [
  'You are a film director planning coverage. Split the user\'s scene into a shot list that tells it in order.',
  `Use ${n.min} to ${n.max} shots. Vary the framing from shot to shot.`,
  'Reply with JSON only, no prose and no code fences, exactly this shape:',
  '{"shots":[{"framing":"...","move":"...","action":"...","seconds":3}]}',
  `framing is one of: ${framings.join(', ')}.`,
  `move is one of: ${moves.join(', ')}.`,
  'action is one sentence in the present tense that stands on its own: who is in frame, where they are, and what they do. Describe the character and the place the same way in every shot.',
  'seconds is a whole number from 2 to 6.',
].join('\n');

export interface PlannerParams {
  scene: string;
  system: string;
  seed: number;
  maxTokens?: number;
  encoder?: string;
}

export function buildPlannerGraph(p: PlannerParams): Graph {
  return {
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: p.encoder ?? PLANNER_ENCODER, type: 'ltxv', device: 'default' } },
    sys: { class_type: 'PrimitiveStringMultiline', inputs: { value: p.system } },
    gen: {
      class_type: 'TextGenerateLTX2Prompt',
      inputs: {
        clip: ['clip', 0], prompt: p.scene, max_length: p.maxTokens ?? 700,
        sampling_mode: 'on',
        'sampling_mode.temperature': 0.4, 'sampling_mode.top_k': 64, 'sampling_mode.top_p': 0.95,
        'sampling_mode.min_p': 0.05, 'sampling_mode.repetition_penalty': 1.05, 'sampling_mode.seed': p.seed,
        thinking: false, use_default_template: true, mtp: 'off', system_prompt: ['sys', 0],
      },
    },
    save: { class_type: 'SaveText', inputs: { text: ['gen', 0], filename_prefix: 'morpheus/shotlist', format: 'json' } },
  };
}

// ---------------------------------------------------------------- cut

export interface CutClip {
  file: string;          // asset token / input filename of a finished shot
  frames: number;        // at fps, from the server's probe
  hasAudio: boolean;
}

export interface CutParams {
  clips: CutClip[];
  width: number;
  height: number;
  fps?: number;
  /** Mux sound: each shot's own track, silence under shots that have none. */
  withAudio?: boolean;
  filenamePrefix?: string;
}

/** Hard cuts, in order, at one size. */
export function buildCutGraph(p: CutParams): Graph {
  if (p.clips.length < 1) throw new Error('A cut needs at least one shot');
  const fps = p.fps ?? 24;
  const g: Graph = {};
  let frames: Ref | undefined;
  let audio: Ref | undefined;
  p.clips.forEach((c, i) => {
    g[`c${i}`] = {
      class_type: 'VHS_LoadVideo',
      inputs: { video: c.file, force_rate: fps, custom_width: 0, custom_height: 0, frame_load_cap: c.frames, skip_first_frames: 0, select_every_nth: 1 },
    };
    g[`c${i}Fit`] = { class_type: 'ImageScale', inputs: { image: [`c${i}`, 0], upscale_method: 'lanczos', width: p.width, height: p.height, crop: 'center' } };
    const f: Ref = [`c${i}Fit`, 0];
    frames = frames ? (g[`j${i}`] = { class_type: 'ImageBatch', inputs: { image1: frames, image2: f } }, [`j${i}`, 0]) : f;
    if (p.withAudio) {
      const dur = r4(c.frames / fps);
      const a: Ref = c.hasAudio
        ? (g[`c${i}A`] = { class_type: 'TrimAudioDuration', inputs: { audio: [`c${i}`, 2], start_index: 0, duration: dur } }, [`c${i}A`, 0])
        : (g[`c${i}A`] = { class_type: 'EmptyAudio', inputs: { duration: dur, sample_rate: 48000, channels: 2 } }, [`c${i}A`, 0]);
      audio = audio ? (g[`ja${i}`] = { class_type: 'AudioConcat', inputs: { audio1: audio, audio2: a, direction: 'after' } }, [`ja${i}`, 0]) : a;
    }
  });
  g.video = { class_type: 'CreateVideo', inputs: { images: frames, fps, ...(audio ? { audio } : {}) } };
  g.save = { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: p.filenamePrefix ?? 'morpheus/scene', format: 'auto', codec: 'auto' } };
  return g;
}
