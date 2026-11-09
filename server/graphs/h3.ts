/**
 * MiniMax H3 graph builders — API-format ComfyUI graphs. One builder covers
 * text-to-video, image-to-video (first + last frame, loops), and
 * reference mode; the mode is inferred from which images are present.
 *
 * Every mode runs on the all-in-one H3 checkpoint (H3_MODELS.unet), so a single
 * UNET serves t2v, i2v and refs. Sampling has two settings:
 *
 *   max   20 steps, no distill            the reference quality
 *   turbo 8 steps + the v0.1 step distill your faster setting
 *
 * Your own LoRAs (validated by pickLoras) are applied in order, with the turbo
 * distill last at strength 1.0 — the distill and its sigma shift stay a matched
 * pair on top of whatever you stacked.
 */

export interface H3Params {
  prompt: string;
  width: number;   // multiple of 32
  height: number;  // multiple of 32
  lengthFrames: number; // snapped to 17k+5 grid by snapH3Length
  seed: number;
  steps: number;
  startImage?: string; // ComfyUI input-folder filename
  endImage?: string;
  refImages?: string[]; // reference mode
  /** Optional checkpoint override (any UNET ComfyUI lists). Defaults to the all-in-one Singularity. */
  checkpoint?: string;
  /** Your own LoRAs (validated by pickLoras), applied in order. */
  loras?: { file: string; strength: number }[];
  /** Turbo preset id from H3_TURBO_PRESETS; '' / undefined = max sampling. */
  turbo?: string;
  /**
   * Mux the generated audio into the file. OFF by default: H3 is natively
   * audio-video and will invent room tone and mumbled voices under any prompt,
   * which is noise on a visual loop. The audio latent is still sampled either
   * way, because the sampler expects the concatenated AV latent, so this
   * changes the delivered file and not the picture.
   * Turn it on for dialogue work, where the voice is the point.
   */
  withAudio?: boolean;
}

export interface H3TurboPreset {
  id: string;
  label: string;
  steps: number;
  /** The lightx2v step-distills are trained against a shifted schedule and need it. */
  shiftVideo?: number;
  shiftAudio?: number;
  lora: string;
  note: string;
}

/** The step-distill the turbo preset applies, at strength 1.0. */
export const H3_TURBO_LORA =
  'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors';

export const H3_TURBO_PRESETS: H3TurboPreset[] = [
  {
    id: 'turbo',
    label: '8-STEP · TURBO',
    steps: 8,
    shiftVideo: 6,
    shiftAudio: 3,
    lora: H3_TURBO_LORA,
    note: 'The v0.1 step distill at 8 steps — about 2.5x faster than the 20-step max.',
  },
];

/** Resolve a preset id into the LoRA/steps/shift actually applied, or null for max. */
export function resolveTurbo(
  turboId: string | undefined,
): { lora: string; steps: number; shiftVideo?: number; shiftAudio?: number } | null {
  if (!turboId) return null;
  const preset = H3_TURBO_PRESETS.find((p) => p.id === turboId);
  if (!preset) return null;
  return { lora: preset.lora, steps: preset.steps, shiftVideo: preset.shiftVideo, shiftAudio: preset.shiftAudio };
}

export const H3_MODELS = {
  /** The all-in-one H3 checkpoint: t2v, i2v and refs all run on it. */
  unet: 'Minimax-h3_Singularity_ref2va_v2_int8.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
};

/** Why a turbo preset cannot run with the LoRAs ComfyUI lists (`have`), or null when it can. */
export function turboProblem(turbo: string, have: ReadonlySet<string>): string | null {
  const t = resolveTurbo(turbo);
  if (!t) return `Unknown H3 turbo preset "${turbo}". Use one of: ${H3_TURBO_PRESETS.map((p) => p.id).join(', ')}.`;
  if (have.has(t.lora)) return null;
  return `The H3 turbo preset "${turbo}" needs ${t.lora} in models/loras/. "npm run models -- --only h3-turbo" fetches it.`;
}

/** Frame counts must sit on the model's 17k+5 grid (5, 22, ..., 124, ..., 362). */
export function snapH3Length(frames: number): number {
  const k = Math.round((frames - 5) / 17);
  return Math.max(5, Math.min(362, 17 * Math.max(0, k) + 5));
}

export function buildH3Graph(p: H3Params): Record<string, unknown> {
  const useRef = !!p.refImages?.length;
  const unetName = p.checkpoint || H3_MODELS.unet;
  const turbo = resolveTurbo(p.turbo);
  const steps = turbo ? turbo.steps : p.steps;

  // LoRA chain: your picks in order, then the turbo distill at strength 1.0.
  // Each node patches the previous model, so the last one is what the
  // scheduler and guider read.
  const chain: { file: string; strength: number }[] = [...(p.loras ?? [])];
  if (turbo) chain.push({ file: turbo.lora, strength: 1.0 });
  let prev = 'u';
  const loraNodes: Record<string, unknown> = {};
  for (let i = 0; i < chain.length; i++) {
    const id = `lora${i}`;
    loraNodes[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: [prev, 0], lora_name: chain[i].file, strength_model: chain[i].strength },
    };
    prev = id;
  }
  // The sigma shift sits after the LoRAs so the shifted sigmas apply to the
  // patched model. Only turbo sets it — max sampling keeps the model's schedule.
  const useShift = !!turbo && turbo.shiftVideo !== undefined && turbo.shiftAudio !== undefined;
  const shiftNode = useShift
    ? { class_type: 'MiniMaxH3SigmaShift', inputs: { model: [prev, 0], shift_video: turbo!.shiftVideo, shift_audio: turbo!.shiftAudio } }
    : null;
  const modelSrc = useShift ? 'shift' : prev;

  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: H3_MODELS.clip, type: 'minimax', device: 'default' } },
    vv: { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.videoVae } },
    va: { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.audioVae } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sched: { class_type: 'BasicScheduler', inputs: { model: [modelSrc, 0], scheduler: 'simple', steps, denoise: 1.0 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    guider: { class_type: 'BasicGuider', inputs: { model: [modelSrc, 0], conditioning: ['gen', 0] } },
    sca: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sched', 0], latent_image: ['gen', 1] },
    },
    dv: { class_type: 'VAEDecode', inputs: { samples: ['sca', 0], vae: ['vv', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dv', 0], fps: 24 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: 'video/Morpheus', format: 'auto', codec: 'auto' } },
    ...loraNodes,
    ...(shiftNode ? { shift: shiftNode } : {}),
  };

  // Decode and mux the audio track only when it is actually wanted. The audio
  // VAE is loaded regardless above; leaving it unconsumed is harmless.
  if (p.withAudio) {
    g.da = { class_type: 'VAEDecodeAudio', inputs: { samples: ['sca', 0], vae: ['va', 0] } };
    (g.vid as { inputs: Record<string, unknown> }).inputs.audio = ['da', 0];
  }

  const genInputs: Record<string, unknown> = {
    clip: ['c', 0],
    vae: ['vv', 0],
    prompt: p.prompt,
    width: p.width,
    height: p.height,
    length: snapH3Length(p.lengthFrames),
  };

  if (useRef) {
    // Reference mode: each ref is its own dynamic dotted input slot
    // (ref_images.ref_image_N), per the official r2v template wiring.
    const refs = (p.refImages || []).slice(0, 4);
    refs.forEach((name, i) => {
      g[`ref${i}`] = { class_type: 'LoadImage', inputs: { image: name } };
      genInputs[`ref_images.ref_image_${i}`] = [`ref${i}`, 0];
    });
    genInputs.audio_vae = ['va', 0];
    // 'match' scales refs to the generation's pixel area (fast);
    // 'max' = 2048px identity-fidelity mode but several times slower.
    genInputs.ref_image_size = 'match';
    g.gen = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: genInputs };
  } else {
    if (p.startImage) {
      g.ls = { class_type: 'LoadImage', inputs: { image: p.startImage } };
      g.ss = {
        class_type: 'ImageScaleToTotalPixels',
        inputs: { image: ['ls', 0], upscale_method: 'lanczos', megapixels: (p.width * p.height) / 1e6, resolution_steps: 32 },
      };
      genInputs.first_frame = ['ss', 0];
    }
    if (p.endImage) {
      g.le = { class_type: 'LoadImage', inputs: { image: p.endImage } };
      g.se = {
        class_type: 'ImageScaleToTotalPixels',
        inputs: { image: ['le', 0], upscale_method: 'lanczos', megapixels: (p.width * p.height) / 1e6, resolution_steps: 32 },
      };
      genInputs.last_frame = ['se', 0];
    }
    g.gen = { class_type: 'MiniMaxH3ImageToVideo', inputs: genInputs };
  }

  return g;
}
