/**
 * Stills graph builders — seven models, each with a DRAFT and a QUALITY mode.
 *
 *  qwen     — Qwen-Image fp8. DRAFT = Lightning 8-step LoRA; QUALITY = no LoRA,
 *             50 steps, CFG 2.5. `negative` only matters here (CFG > 1).
 *  flux2    — FLUX.2 dev fp8mixed, the photorealism lead. FluxGuidance 4, 20
 *             steps. DRAFT = Turbo LoRA @ 8 steps. Reference pictures go in as
 *             ReferenceLatents (the FLUX.2 multi-reference recipe).
 *  qwen21   — Qwen-Image 2.1 (the qwen_image21 model class): QwenImage21Cache +
 *             TextEncodeQwenImage21, 25 steps CFG 1. DRAFT = the 8-step distill.
 *  krea2    — Krea-2 Turbo, a few-step model: CFG 1, 8 (draft) / 25 (high).
 *  zimage   — Z-Image Turbo, AuraFlow shift 3, res_multistep, CFG 1.
 *  klein    — FLUX.2 Klein 9B: Flux2 scheduler + CFGGuider 5, references as
 *             ReferenceLatents.
 *  flux3    — FLUX.3 (a Flux2 subclass): official recipe, a plain KSampler at
 *             CFG 1 (er_sde, 15 steps), Qwen3-VL `flux3` encoder, `flux2` VAE;
 *             references through ReferenceMultiLatent.
 *
 * Your own LoRAs chain after the model (and after the draft distill).
 *
 * Graph shapes come from the official ComfyUI blueprints for each model.
 */

export type StillsModel = 'qwen' | 'flux2' | 'qwen21' | 'krea2' | 'zimage' | 'klein' | 'flux3';

export interface StillsParams {
  model: StillsModel;
  quality: 'draft' | 'quality';
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /**
   * Things to keep OUT of the image. This is the only place exclusions work:
   * Qwen draws whatever you negate in the POSITIVE prompt ("no rope" renders a
   * rope), because the encoder embeds the noun and the sampler renders it. Only
   * effective where CFG > 1 (qwen quality, qwen21 quality, klein); ignored on
   * the CFG-1 turbo models and in every draft mode.
   */
  negative?: string;
  /** Your own LoRAs (server/loras.ts checked the family), applied in order. */
  loras?: { name: string; strength: number }[];
  /** flux2 / klein (ReferenceLatent) or flux3 (ReferenceMultiLatent): reference pictures, input tokens. */
  refImages?: string[];
}

const SAVE = { class_type: 'SaveImage', inputs: { images: ['d', 0], filename_prefix: 'Morpheus_still' } };

/** Chain LoraLoaderModelOnly nodes after `from`; returns the last model output. */
function chainLoras(g: Record<string, unknown>, from: [string, number], loras?: StillsParams['loras']): [string, number] {
  let model = from;
  (loras ?? []).forEach((l, i) => {
    g[`ulora${i}`] = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: l.name, strength_model: l.strength } };
    model = [`ulora${i}`, 0];
  });
  return model;
}

/** Append the FLUX.2 multi-reference chain (LoadImage -> scale -> VAE encode -> ReferenceLatent). */
function refChain(g: Record<string, unknown>, cond: [string, number], refImages?: string[]): [string, number] {
  (refImages ?? []).forEach((image, i) => {
    Object.assign(g, {
      [`ri${i}`]: { class_type: 'LoadImage', inputs: { image } },
      [`rs${i}`]: { class_type: 'ImageScaleToTotalPixels', inputs: { image: [`ri${i}`, 0], upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 16 } },
      [`re${i}`]: { class_type: 'VAEEncode', inputs: { pixels: [`rs${i}`, 0], vae: ['v', 0] } },
      [`rl${i}`]: { class_type: 'ReferenceLatent', inputs: { conditioning: cond, latent: [`re${i}`, 0] } },
    });
    cond = [`rl${i}`, 0];
  });
  return cond;
}

function qwenGraph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const g0: Record<string, unknown> = {};
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_fp8_e4m3fn.safetensors', weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.negative ?? '' } },
    lat: { class_type: 'EmptySD3LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model: chainLoras(g0, [draft ? 'lora' : 'u', 0], p.loras), positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0],
        seed: p.seed,
        steps: draft ? 8 : 50,
        cfg: draft ? 1.0 : 2.5,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } },
    save: SAVE,
  };
  if (draft) {
    g.lora = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['u', 0], lora_name: 'Qwen-Image-Lightning-8steps-V1.0.safetensors', strength_model: 1.0 },
    };
  }
  return { ...g, ...g0 };
}

/**
 * Qwen-Image 2.1 is the special `qwen_image21` model class (comfy/ldm/qwen_image21):
 * it needs the QwenImage21Cache wrapper around the model and the
 * TextEncodeQwenImage21 encoder (which emits positive + negative + a latent), the
 * dedicated `qwen_image_2.1_vae_bf16` VAE, and a plain KSampler (cfg 1). A plain
 * CLIPTextEncode / qwen_image_vae / AuraFlow all fail at runtime on this class.
 */
function qwen21Graph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const g0: Record<string, unknown> = {};
  const model = chainLoras(g0, [draft ? 'lora' : 'u', 0], p.loras);
  g0.cache = { class_type: 'QwenImage21Cache', inputs: { model, device: 'auto', dtype: 'default' } };
  if (draft) {
    g0.lora = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['u', 0], lora_name: 'p_qwen_image_2.1_8step_v0.1.safetensors', strength_model: 1.0 },
    };
  }
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
    te: {
      class_type: 'TextEncodeQwenImage21',
      inputs: { clip: ['c', 0], prompt: p.prompt, negative_prompt: p.negative ?? '', resolution: Math.max(p.width, p.height), vae: ['v', 0] },
    },
    lat: { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model: ['cache', 0], positive: ['te', 0], negative: ['te', 1], latent_image: ['lat', 0],
        seed: p.seed,
        steps: draft ? 8 : 25,
        cfg: 1.0,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } },
    save: SAVE,
  };
  return { ...g, ...g0 };
}

function krea2Graph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const g0: Record<string, unknown> = {};
  const model = chainLoras(g0, ['u', 0], p.loras);
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    zero: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } },
    lat: { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model, positive: ['pos', 0], negative: ['zero', 0], latent_image: ['lat', 0],
        seed: p.seed,
        steps: draft ? 8 : 25,
        cfg: 1.0,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } },
    save: SAVE,
  };
  return { ...g, ...g0 };
}

function zimageGraph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const g0: Record<string, unknown> = {};
  const model = chainLoras(g0, ['u', 0], p.loras);
  g0.ms = { class_type: 'ModelSamplingAuraFlow', inputs: { model, shift: 3 } };
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    zero: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } },
    lat: { class_type: 'EmptySD3LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model: ['ms', 0], positive: ['pos', 0], negative: ['zero', 0], latent_image: ['lat', 0],
        seed: p.seed,
        steps: draft ? 8 : 20,
        cfg: 1.0,
        sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1.0,
      },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } },
    save: SAVE,
  };
  return { ...g, ...g0 };
}

function kleinGraph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const steps = draft ? 8 : 20;
  const g0: Record<string, unknown> = {};
  const model = chainLoras(g0, ['u', 0], p.loras);
  const cond = refChain(g0, ['pos', 0], p.refImages);
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-base-9b-fp8.safetensors', weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'flux2', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.negative ?? '' } },
    cfg: { class_type: 'CFGGuider', inputs: { model, positive: cond, negative: ['neg', 0], cfg: 5 } },
    sched: { class_type: 'Flux2Scheduler', inputs: { steps, width: p.width, height: p.height } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    lat: { class_type: 'EmptyFlux2LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    sca: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['cfg', 0], sampler: ['sampler', 0], sigmas: ['sched', 0], latent_image: ['lat', 0] },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['sca', 0], vae: ['v', 0] } },
    save: SAVE,
  };
  return { ...g, ...g0 };
}

/**
 * FLUX.3 (a Flux2 subclass) — the official Comfy-Org `image_flux3_klein_t2i`
 * recipe: a plain KSampler (no guider/scheduler stack) at CFG 1, `er_sde`, 15
 * steps; `qwen3vl_4b_int8_convrot` text encoder (type `flux3`) and the `flux2`
 * VAE. Reference pictures go in through ReferenceMultiLatent (the edit
 * template), which appends their latents to the positive/negative conditioning.
 */
function flux3Graph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const g0: Record<string, unknown> = {};
  const model = chainLoras(g0, ['u', 0], p.loras);
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: 'flux3-image-klein-base-int8-convrot.safetensors', weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_int8_convrot.safetensors', type: 'flux3', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.negative ?? '' } },
    lat: { class_type: 'EmptyFlux2LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model, positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0],
        seed: p.seed,
        steps: draft ? 8 : 15,
        cfg: 1.0,
        sampler_name: 'er_sde', scheduler: 'simple', denoise: 1.0,
      },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } },
    save: SAVE,
  };
  // Reference pictures: each loaded, then handed to one ReferenceMultiLatent that
  // appends their latents to the conditioning (the FLUX.3 image-edit recipe).
  if (p.refImages?.length) {
    p.refImages.forEach((image, i) => { g0[`ri${i}`] = { class_type: 'LoadImage', inputs: { image } }; });
    const rml: Record<string, unknown> = { positive: ['pos', 0], vae: ['v', 0], resolution: 'resize', megapixels: 1.0 };
    p.refImages.forEach((_, i) => { rml[`image${i}`] = [`ri${i}`, 0]; });
    g0.rml = { class_type: 'ReferenceMultiLatent', inputs: rml };
    (g.k as { inputs: Record<string, unknown> }).inputs.positive = ['rml', 0];
    (g.k as { inputs: Record<string, unknown> }).inputs.negative = ['rml', 1];
  }
  return { ...g, ...g0 };
}

function flux2Graph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const steps = draft ? 8 : 20;
  const g0: Record<string, unknown> = {};
  const model = chainLoras(g0, [draft ? 'lora' : 'u', 0], p.loras);
  const cond = refChain(g0, ['pos', 0], p.refImages);
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: 'flux2_dev_fp8mixed.safetensors', weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: 'mistral_3_small_flux2_fp4_mixed.safetensors', type: 'flux2', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    fg: { class_type: 'FluxGuidance', inputs: { conditioning: cond, guidance: 4 } },
    guider: { class_type: 'BasicGuider', inputs: { model, conditioning: ['fg', 0] } },
    sched: { class_type: 'Flux2Scheduler', inputs: { steps, width: p.width, height: p.height } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    lat: { class_type: 'EmptyFlux2LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    sca: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sched', 0], latent_image: ['lat', 0] },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['sca', 0], vae: ['v', 0] } },
    save: SAVE,
  };
  if (draft) {
    g.lora = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['u', 0], lora_name: 'Flux2TurboComfyv2.safetensors', strength_model: 1.0 },
    };
  }
  return { ...g, ...g0 };
}

export function buildStillsGraph(p: StillsParams): Record<string, unknown> {
  switch (p.model) {
    case 'flux2': return flux2Graph(p);
    case 'qwen21': return qwen21Graph(p);
    case 'krea2': return krea2Graph(p);
    case 'zimage': return zimageGraph(p);
    case 'klein': return kleinGraph(p);
    case 'flux3': return flux3Graph(p);
    case 'qwen':
    default: return qwenGraph(p);
  }
}
