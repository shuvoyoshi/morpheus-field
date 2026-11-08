/**
 * Audio app: Music (ACE-Step 1.5 text to music) and Speech (Qwen3-TTS).
 *
 *  music  — ACE-Step 1.5 XL: a diffusion audio model with a dual Qwen text and
 *           lyrics encoder. TURBO is the 8-step distilled weights, BASE the
 *           full 30 steps. Native ComfyUI nodes, 0.42 or newer; graph shape
 *           from the stock "Text to Audio (ACE-Step 1.5)" blueprint. The
 *           encoder's CFG lives in cfg_scale (the KSampler runs CFG 1).
 *  speech — Qwen3-TTS 1.7B VoiceDesign: a described voice says your text.
 *           Node pack comfyui-qwen3-tts; its loader fetches the weights from
 *           Hugging Face on first use when they are not in models/Qwen3-TTS/.
 *
 * Both save through SaveAudioAdvanced (MP3 320k); the deprecated
 * SaveAudioMP3 still exists but ComfyUI flags it.
 */

export const ACE_TURBO = 'acestep_v1.5_xl_turbo_bf16.safetensors';
export const ACE_BASE = 'acestep_v1.5_xl_base_bf16.safetensors';
export const ACE_CLIP_1 = 'qwen_0.6b_ace15.safetensors';
export const ACE_CLIP_2 = 'qwen_4b_ace15.safetensors';
export const ACE_VAE = 'ace_1.5_vae.safetensors';
export const ACE_NODES = ['TextEncodeAceStepAudio1.5', 'EmptyAceStep1.5LatentAudio'];
export const QWEN3_REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
export const QWEN3_FOLDER = 'Qwen3-TTS-12Hz-1.7B-VoiceDesign';
export const QWEN3_NODES = ['Qwen3Loader', 'Qwen3VoiceDesign'];

export interface MusicParams {
  lyrics: string;
  tags: string;
  model: 'turbo' | 'base';
  /** 5 to 300; the node allows 1 to 1000. */
  seconds: number;
  /** "C major" ... "B minor" — the encoder's 24 keys. */
  key: string;
  /** 10 to 300. */
  bpm: number;
  /** "2" | "3" | "4" | "6". */
  timesignature: string;
  /** ISO code, "en" by default. */
  language: string;
  seed: number;
}

export function buildAcestepMusic(p: MusicParams): Record<string, unknown> {
  const turbo = p.model === 'turbo';
  const seconds = Math.max(1, Math.min(1000, Math.round(p.seconds)));
  return {
    u: { class_type: 'UNETLoader', inputs: { unet_name: turbo ? ACE_TURBO : ACE_BASE, weight_dtype: 'default' } },
    c: { class_type: 'DualCLIPLoader', inputs: { clip_name1: ACE_CLIP_1, clip_name2: ACE_CLIP_2, type: 'ace', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: ACE_VAE } },
    t: {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        clip: ['c', 0],
        tags: p.tags,
        lyrics: p.lyrics,
        seed: p.seed,
        bpm: Math.max(10, Math.min(300, Math.round(p.bpm) || 120)),
        duration: seconds,
        timesignature: p.timesignature || '4',
        language: p.language || 'en',
        keyscale: p.key || 'E minor',
        generate_audio_codes: true,
        cfg_scale: 2,
        temperature: 0.85,
        top_p: 0.9,
        top_k: 0,
        min_p: 0,
      },
    },
    n: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['t', 0] } },
    l: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds, batch_size: 1 } },
    s: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['u', 0], shift: 3 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model: ['s', 0], positive: ['t', 0], negative: ['n', 0], latent_image: ['l', 0],
        seed: p.seed, steps: turbo ? 8 : 30, cfg: 1,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    d: { class_type: 'VAEDecodeAudio', inputs: { samples: ['k', 0], vae: ['v', 0] } },
    // SaveAudioAdvanced is a dynamic combo: with format=mp3 the quality input is
    // named "format.quality" in the API (prefix-joined), not a top-level "quality".
    save: { class_type: 'SaveAudioAdvanced', inputs: { audio: ['d', 0], filename_prefix: 'Morpheus_audio', format: 'mp3', 'format.quality': '320k' } },
  };
}

export interface SpeechParams {
  text: string;
  /** The voice, in words. */
  instruct: string;
  /** "Auto" | "English" | ... — Qwen3VoiceDesign's list. */
  language: string;
  seed: number;
}

export function buildQwen3Speech(p: SpeechParams): Record<string, unknown> {
  return {
    m: { class_type: 'Qwen3Loader', inputs: { repo_id: QWEN3_REPO, source: 'HuggingFace', precision: 'bf16', attention: 'auto' } },
    t: {
      class_type: 'Qwen3VoiceDesign',
      inputs: { model: ['m', 0], text: p.text, instruct: p.instruct || 'A natural, clear voice.', language: p.language || 'Auto', seed: p.seed },
    },
    save: { class_type: 'SaveAudioAdvanced', inputs: { audio: ['t', 0], filename_prefix: 'Morpheus_audio', format: 'mp3', 'format.quality': '320k' } },
  };
}
