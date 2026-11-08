/**
 * LTX-Video 2.3 graph builder — faithful port of the official
 * video_ltx2_3_i2v template (two-stage: base pass at half resolution →
 * 2x latent upsample → refine pass → tiled decode + audio decode).
 * 25fps native, distilled sigma schedules, CFG 1.
 * Supports arbitrary family checkpoints (e.g. the SpiceModels fine-tune)
 * plus one optional extra LoRA on top of the distilled one.
 */

export interface LtxParams {
  prompt: string;
  width: number;    // final output size (stage 1 runs at half)
  height: number;
  seconds: number;  // frames = seconds * 25 + 1
  seed: number;
  checkpoint: string;         // model file (full checkpoint OR bare transformer)
  /** True when the file is transformer-only (SpiceModels quants) → UNETLoader. */
  modelIsUnet?: boolean;
  /** 'distilled' = fast 8+4-step schedule (official base); 'dev' = full
   *  20-step CFG-4 sampling — REQUIRED for non-distilled fine-tunes. */
  sampling?: 'distilled' | 'dev';
  extraLora?: string;         // e.g. the SpiceModels companion LoRA
  extraLoraStrength?: number;
  startImage?: string;        // input-folder filename → i2v; absent → t2v
}

const GEMMA = 'gemma_3_12B_it_fp4_mixed.safetensors';
/** Official base checkpoint — donor for VAE/audio-VAE/text-encoder projection
 *  when the selected model file is transformer-only. */
const DONOR_CKPT = 'ltx-2.3-22b-dev-fp8.safetensors';
const DISTILL_LORA = 'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors';
const UPSCALER = 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors';
const NEGATIVE = 'pc game, console game, video game, cartoon, childish, ugly';
const SIGMAS_BASE = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const SIGMAS_REFINE = '0.85, 0.7250, 0.4219, 0.0';
export const LTX_FPS = 25;

export function buildLtxGraph(p: LtxParams): Record<string, unknown> {
  const frames = Math.round(p.seconds * LTX_FPS) + 1;
  const i2v = !!p.startImage;
  const dev = p.sampling === 'dev';

  // Model chain: (checkpoint | bare transformer) → distilled LoRA → user LoRA.
  // VAE + audio VAE + encoder projection always come from a checkpoint that
  // actually contains them: the selected one if full, else the official donor.
  const vaeCkptName = p.modelIsUnet ? DONOR_CKPT : p.checkpoint;
  const g: Record<string, unknown> = {
    ...(p.modelIsUnet
      ? {
          unet: { class_type: 'UNETLoader', inputs: { unet_name: p.checkpoint, weight_dtype: 'default' } },
          ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: vaeCkptName } },
        }
      : {
          ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
        }),
    dlora: {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: [p.modelIsUnet ? 'unet' : 'ckpt', 0], lora_name: DISTILL_LORA, strength_model: dev ? 0.0 : 1.0 },
    },
  };
  let model: [string, number] = ['dlora', 0];
  if (p.extraLora) {
    g.xlora = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model, lora_name: p.extraLora, strength_model: p.extraLoraStrength ?? 1.0 },
    };
    model = ['xlora', 0];
  }

  Object.assign(g, {
    enc: {
      class_type: 'LTXAVTextEncoderLoader',
      inputs: { text_encoder: GEMMA, ckpt_name: vaeCkptName, device: 'default' },
    },
    avae: { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: vaeCkptName } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['enc', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['enc', 0], text: NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: LTX_FPS } },

    latV: {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: { width: Math.round(p.width / 2), height: Math.round(p.height / 2), length: frames, batch_size: 1 },
    },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: LTX_FPS, batch_size: 1, audio_vae: ['avae', 0] } },

    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: dev ? 'euler_ancestral' : 'euler' } },
    sigBase: dev
      ? { class_type: 'LTXVScheduler', inputs: { steps: 20, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1 } }
      : { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS_BASE } },
    sigRefine: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS_REFINE } },
    noise1: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    noise2: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed + 1 } },

    guide1: { class_type: 'CFGGuider', inputs: { model, positive: ['cond', 0], negative: ['cond', 1], cfg: dev ? 4 : 1 } },
    upmodel: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: UPSCALER } },
  });

  // ---- stage 1: base pass at half resolution ----
  let stage1Latent: [string, number] = ['latV', 0];
  if (i2v) {
    Object.assign(g, {
      img: { class_type: 'LoadImage', inputs: { image: p.startImage } },
      rsz: {
        class_type: 'ImageScale',
        inputs: { image: ['img', 0], upscale_method: 'lanczos', width: p.width, height: p.height, crop: 'center' },
      },
      rszEdge: { class_type: 'ResizeImagesByLongerEdge', inputs: { images: ['rsz', 0], longer_edge: 1536 } },
      prep: { class_type: 'LTXVPreprocess', inputs: { image: ['rszEdge', 0], img_compression: 18 } },
      inj1: {
        class_type: 'LTXVImgToVideoInplace',
        inputs: { vae: ['ckpt', 2], image: ['prep', 0], latent: ['latV', 0], strength: 0.7, bypass: false },
      },
    });
    stage1Latent = ['inj1', 0];
  }

  Object.assign(g, {
    cat1: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: stage1Latent, audio_latent: ['latA', 0] } },
    s1: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise1', 0], guider: ['guide1', 0], sampler: ['sampler', 0], sigmas: ['sigBase', 0], latent_image: ['cat1', 0] },
    },
    sep1: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['s1', 0] } },
    up: { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['sep1', 0], upscale_model: ['upmodel', 0], vae: ['ckpt', 2] } },
  });

  // ---- stage 2: refine at full resolution ----
  let stage2Latent: [string, number] = ['up', 0];
  let guide2Pos: [string, number] = ['cond', 0];
  let guide2Neg: [string, number] = ['cond', 1];
  if (i2v) {
    Object.assign(g, {
      inj2: {
        class_type: 'LTXVImgToVideoInplace',
        inputs: { vae: ['ckpt', 2], image: ['prep', 0], latent: ['up', 0], strength: 1.0, bypass: false },
      },
      crop: { class_type: 'LTXVCropGuides', inputs: { positive: ['cond', 0], negative: ['cond', 1], latent: ['sep1', 0] } },
    });
    stage2Latent = ['inj2', 0];
    guide2Pos = ['crop', 0];
    guide2Neg = ['crop', 1];
  }

  Object.assign(g, {
    guide2: { class_type: 'CFGGuider', inputs: { model, positive: guide2Pos, negative: guide2Neg, cfg: 1 } },
    cat2: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: stage2Latent, audio_latent: ['sep1', 1] } },
    s2: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise2', 0], guider: ['guide2', 0], sampler: ['sampler', 0], sigmas: ['sigRefine', 0], latent_image: ['cat2', 0] },
    },
    sep2: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['s2', 0] } },
    dv: { class_type: 'VAEDecodeTiled', inputs: { samples: ['sep2', 0], vae: ['ckpt', 2], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } },
    da: { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['sep2', 1], audio_vae: ['avae', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dv', 0], audio: ['da', 0], fps: LTX_FPS } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: 'video/Morpheus_LTX', format: 'auto', codec: 'auto' } },
  });

  return g;
}
