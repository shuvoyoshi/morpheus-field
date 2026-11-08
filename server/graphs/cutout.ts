/**
 * Cut out: background removal for stills and clips, on core ComfyUI nodes
 * (ComfyUI >= 0.38). No video model is involved unless the caller asks for
 * the LTX Alpha-Gen path, which lives in the Effects app.
 *
 *   matte   BiRefNet (LoadBackgroundRemovalModel -> RemoveBackground) on every
 *           frame. Soft edges with real hair detail. The default: on the test
 *           clips it was the most stable of the three (see the report).
 *   track   SAM 3.1 finds the subject from a word ("person", "the dog") and
 *           follows it with its memory tracker (SAM3_VideoTrack). Rock steady
 *           from frame to frame, but the edge is a hard 0/1 line.
 *   hybrid  BiRefNet's soft matte, kept only inside a grown SAM track of the
 *           named subject, for busy backgrounds where the matte picks up
 *           other things. Where the track loses part of the subject (fast
 *           change, a dissolve), the cut out loses it too.
 *
 * Output: a still is a PNG (RGBA when the background is transparent). A clip
 * with a transparent background is ProRes 4444 with alpha (.mov, through VHS);
 * the server then makes the browser preview over a checkerboard. A clip with a
 * new background (color, blur, picture) is a plain H.264 MP4.
 *
 * Mask convention: RemoveBackground and SAM give foreground = 1. ComfyUI's
 * JoinImageWithAlpha inverts its mask (it expects LoadImage's mask, where 1 is
 * transparent), hence the InvertMask before it, as in the shipped BiRefNet
 * blueprint.
 */

export const BIREFNET = 'birefnet.safetensors';
export const SAM3 = 'sam3.1_multiplex_fp16.safetensors';

export type CutoutMethod = 'matte' | 'track' | 'hybrid';
export type CutoutBackground = 'transparent' | 'color' | 'blur' | 'image';

type Ref = [string, number];
type Graph = Record<string, any>;

export interface CutoutBg {
  background: CutoutBackground;
  /** color: '#rrggbb'. */
  color?: string;
  /** image: loader filename / asset token of the new background. */
  backgroundImage?: string;
}

export interface CutoutStillParams extends CutoutBg {
  image: string;
  width: number;
  height: number;
  filenamePrefix?: string;
}

export interface CutoutVideoParams extends CutoutBg {
  sourceVideo: string;
  width: number;
  height: number;
  /** Frames to read (0 = all), at the source rate. */
  frames: number;
  fps: number;
  method: CutoutMethod;
  /** What SAM looks for (track / hybrid). */
  subject?: string;
  /** Keep the clip's sound (only when the server probed a sound track). */
  withAudio?: boolean;
  filenamePrefix?: string;
}

/** '#rrggbb' -> the 24-bit int EmptyImage takes. Anything else is black. */
export function colorInt(hex?: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  return m ? parseInt(m[1], 16) : 0;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The foreground matte for `frames` from BiRefNet. */
function matte(g: Graph, frames: Ref): Ref {
  g.bgm = { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: BIREFNET } };
  g.matte = { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bgm', 0], image: frames } };
  return ['matte', 0];
}

/** SAM 3.1 detects `subject` and tracks it; returns the union mask of what it follows. */
function track(g: Graph, frames: Ref, subject: string, maxObjects: number): Ref {
  g.sam = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: SAM3 } };
  g.samText = { class_type: 'CLIPTextEncode', inputs: { clip: ['sam', 1], text: subject } };
  g.samTrack = {
    class_type: 'SAM3_VideoTrack',
    inputs: { images: frames, model: ['sam', 0], conditioning: ['samText', 0], detection_threshold: 0.4, max_objects: maxObjects, detect_interval: 1 },
  };
  g.samMask = { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['samTrack', 0], object_indices: '' } };
  return ['samMask', 0];
}

/**
 * Put `image` over the chosen background with `mask` (foreground = 1).
 * Returns RGBA for transparent, RGB otherwise. The background goes in as a
 * single frame painted over the clip where the mask is 0, so it repeats to
 * whatever frame count the loader actually produced.
 */
function composite(g: Graph, image: Ref, mask: Ref, bg: CutoutBg, w: number, h: number): Ref {
  g.bgMask = { class_type: 'InvertMask', inputs: { mask } };
  if (bg.background === 'transparent') {
    g.rgba = { class_type: 'JoinImageWithAlpha', inputs: { image, alpha: ['bgMask', 0] } };
    return ['rgba', 0];
  }
  let back: Ref;
  if (bg.background === 'color') {
    g.bgSolid = { class_type: 'EmptyImage', inputs: { width: w, height: h, batch_size: 1, color: colorInt(bg.color) } };
    back = ['bgSolid', 0];
  } else if (bg.background === 'image') {
    if (!bg.backgroundImage) throw new Error('A new background needs a picture');
    g.bgLoad = { class_type: 'LoadImage', inputs: { image: bg.backgroundImage } };
    g.bgFit = { class_type: 'ImageScale', inputs: { image: ['bgLoad', 0], upscale_method: 'lanczos', width: w, height: h, crop: 'center' } };
    back = ['bgFit', 0];
  } else {
    // Portrait blur: shrink to an eighth, blur, scale back up. A 31 px kernel
    // on the full frame barely softens a 1 MP picture.
    g.bgSmall = { class_type: 'ImageScale', inputs: { image, upscale_method: 'area', width: even(w / 8), height: even(h / 8), crop: 'disabled' } };
    g.bgBlur = { class_type: 'ImageBlur', inputs: { image: ['bgSmall', 0], blur_radius: 6, sigma: 3 } };
    g.bgUp = { class_type: 'ImageScale', inputs: { image: ['bgBlur', 0], upscale_method: 'bilinear', width: w, height: h, crop: 'disabled' } };
    back = ['bgUp', 0];
  }
  g.comp = { class_type: 'ImageCompositeMasked', inputs: { destination: image, source: back, x: 0, y: 0, resize_source: false, mask: ['bgMask', 0] } };
  return ['comp', 0];
}

export function buildCutoutStillGraph(p: CutoutStillParams): Graph {
  const g: Graph = {
    load: { class_type: 'LoadImage', inputs: { image: p.image } },
  };
  const m = matte(g, ['load', 0]);
  const out = composite(g, ['load', 0], m, p, p.width, p.height);
  g.save = { class_type: 'SaveImage', inputs: { images: out, filename_prefix: p.filenamePrefix ?? 'morpheus/cutout' } };
  return g;
}

export function buildCutoutVideoGraph(p: CutoutVideoParams): Graph {
  const W = even(p.width);
  const H = even(p.height);
  const g: Graph = {
    src: {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: p.sourceVideo, force_rate: 0, custom_width: 0, custom_height: 0,
        frame_load_cap: p.frames, skip_first_frames: 0, select_every_nth: 1,
      },
    },
    fit: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
  };
  const frames: Ref = ['fit', 0];
  const subject = p.subject?.trim() || 'person';
  let mask: Ref;
  if (p.method === 'track') {
    // Alone, the track is the cut out: follow one subject, not every passer-by
    // that matches the word.
    mask = track(g, frames, subject, 1);
  } else if (p.method === 'hybrid') {
    const soft = matte(g, frames);
    // As a gate, a generous track (up to 4 matches) costs nothing: BiRefNet
    // still decides what is foreground inside it.
    const hard = track(g, frames, subject, 4);
    // Grow the track so it never clips the matte's soft edge (hair, motion
    // blur). The gate's own hard line then sits where the matte is already 0.
    const grow = Math.max(6, Math.round(Math.min(W, H) * 0.03));
    g.gateGrow = { class_type: 'GrowMask', inputs: { mask: hard, expand: grow, tapered_corners: true } };
    g.gate = { class_type: 'MaskComposite', inputs: { destination: soft, source: ['gateGrow', 0], x: 0, y: 0, operation: 'multiply' } };
    mask = ['gate', 0];
  } else {
    mask = matte(g, frames);
  }
  const out = composite(g, frames, mask, p, W, H);
  const audio = p.withAudio ? { audio: ['src', 2] } : {};
  if (p.background === 'transparent') {
    g.save = {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: out, ...audio, frame_rate: p.fps, loop_count: 0, filename_prefix: p.filenamePrefix ?? 'morpheus/cutout',
        format: 'video/ProRes', profile: '4444', pingpong: false, save_output: true,
      },
    };
  } else {
    g.video = { class_type: 'CreateVideo', inputs: { images: out, fps: p.fps, ...audio } };
    g.save = { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: p.filenamePrefix ?? 'morpheus/cutout', format: 'auto', codec: 'auto' } };
  }
  return g;
}
