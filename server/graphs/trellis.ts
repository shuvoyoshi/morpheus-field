/**
 * Image to 3D, two engines on the same stage pipeline, through ComfyUI's
 * built-in nodes (comfy_extras/nodes_trellis2.py and nodes_mesh_postprocess.py).
 * The wiring follows ComfyUI's own "3d_pixal3d_trellis2_image_to_model"
 * template, whose TRELLIS.2/Pixal3D switch we set once per render:
 *
 *   still -> subject mask (BiRefNet, or the picture's own alpha)
 *         -> ImageCropToMask (square, subject centered, black around it)
 *   TRELLIS.2 branch: DINOv3 -> Trellis2Conditioning
 *   Pixal3D branch:    DINOv3-NAF -> MoGe (per-image FoV) -> Pixal3DConditioning
 *   1. structure: empty structure latent -> KSampler (shift 5, CFG 7.5 with the
 *      template's CFG override + rescale) -> 32^3 occupancy voxels
 *   2. shape:     Trellis2ShapeStage -> KSampler at 512, Trellis2UpsampleStage
 *                 -> KSampler at the target resolution -> shape VAE -> mesh
 *   3. texture:   Trellis2TextureStage -> KSampler (CFG 1) -> texture VAE
 *                 -> PBR voxels (base color, metallic, roughness)
 *   post: remesh (UDF) -> decimate -> smooth normals -> UV unwrap -> bake the
 *         texture voxels into an atlas (back-projected from the dense mesh)
 *         -> (High) bake a normal map and AO from the dense mesh -> GLB.
 *
 * Both branches share stages 1-3 and the post pipeline; only the UNet, the
 * encoder and the conditioning differ (model_detection picks the Pixal3D
 * projection head out of the weights, so the samplers are agnostic).
 *
 * Besides the GLB the graph renders a turntable in the engine: the finished
 * mesh, turned a step per frame and ray-cast by RenderMesh, into a short mp4 the
 * Library and the Viewer use as the poster. It also previews the isolated
 * subject, so a bad cutout is visible next to the model it produced.
 *
 * Node ids the server reads back: 'save' (the GLB, a "3d" UI output the v2
 * proxy does not list, so engine.ts reads it from ComfyUI's history),
 * 'turntable' (the mp4) and 'subject' (the cutout).
 */

type Graph = Record<string, unknown>;
type Link = [string, number];

export const TRELLIS_MODEL = 'trellis_2_bf16.safetensors';
export const TRELLIS_SHAPE_VAE = 'trellis_2_shape_vae_bf16.safetensors';
export const TRELLIS_TEXTURE_VAE = 'trellis_2_texture_vae_bf16.safetensors';
export const TRELLIS_ENCODER = 'dino_v3_vit_l.safetensors';
export const BG_REMOVAL_MODEL = 'birefnet.safetensors';

/** The Pixal3D branch: Tencent Pixal3D UNet, the DINOv3-NAF encoder, and MoGe for the per-image FoV. */
export const PIXAL3D_MODEL = 'pixal3d_int8_convrot.safetensors';
export const PIXAL3D_ENCODER = 'dino_v3_L_naf_fp32.safetensors';
export const MOGE_MODEL = 'moge_2_vitl_normal_fp16.safetensors';

/** Which engine builds the mesh: TRELLIS.2 (the default) or Pixal3D. */
export type ObjectModel = 'trellis' | 'pixal3d';

export type ObjectQuality = 'draft' | 'quality';

/** Per-quality settings. High is the template's pipeline at a lighter face count; Draft trades detail for time. */
export const OBJECT_QUALITY: Record<ObjectQuality, {
  structureSteps: number; shapeSteps: number; upsampleSteps: number; textureSteps: number;
  resolution: number; remesh: number; faces: number; texture: number; bakeDetail: boolean;
}> = {
  draft: { structureSteps: 12, shapeSteps: 12, upsampleSteps: 8, textureSteps: 8, resolution: 1024, remesh: 512, faces: 150_000, texture: 2048, bakeDetail: false },
  quality: { structureSteps: 12, shapeSteps: 20, upsampleSteps: 12, textureSteps: 12, resolution: 1536, remesh: 768, faces: 400_000, texture: 4096, bakeDetail: true },
};

/**
 * Turntable: frames, rate and size of the in-engine preview render. RenderMesh
 * rebuilds its ray-casting BVH every frame, so frames cost time in proportion
 * to the face count: 48 frames added about 110 s to a 400k-face High run on a
 * 5090. 32 frames at 16 fps is a smooth 2 s loop at two thirds of that.
 */
export const TURNTABLE = { frames: 32, fps: 16, size: 512, pitch: 12, startYaw: 35 } as const;

export interface TrellisParams {
  /** Loader filename or asset token of the still. */
  image: string;
  seed: number;
  quality: ObjectQuality;
  /** The engine: 'trellis' (TRELLIS.2, default) or 'pixal3d'. */
  model?: ObjectModel;
  /** true: BiRefNet finds the subject. false: use the picture's own transparency. */
  removeBackground: boolean;
  /** Frames in the turntable; 0 skips it. */
  turntableFrames?: number;
  filenamePrefix?: string;
}

export function buildTrellisGraph(p: TrellisParams): Graph {
  const q = OBJECT_QUALITY[p.quality];
  const seed = Math.max(0, Math.floor(p.seed)) % 2 ** 32;
  const model: ObjectModel = p.model === 'pixal3d' ? 'pixal3d' : 'trellis';
  const unet = model === 'pixal3d' ? PIXAL3D_MODEL : TRELLIS_MODEL;
  const encoder = model === 'pixal3d' ? PIXAL3D_ENCODER : TRELLIS_ENCODER;
  const g: Graph = {
    img: { class_type: 'LoadImage', inputs: { image: p.image } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    svae: { class_type: 'VAELoader', inputs: { vae_name: TRELLIS_SHAPE_VAE } },
    tvae: { class_type: 'VAELoader', inputs: { vae_name: TRELLIS_TEXTURE_VAE } },
    dino: { class_type: 'CLIPVisionLoader', inputs: { clip_name: encoder } },
  };

  // ---- the subject ----
  let mask: Link;
  if (p.removeBackground) {
    g.bgm = { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: BG_REMOVAL_MODEL } };
    g.bg = { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bgm', 0], image: ['img', 0] } };
    mask = ['bg', 0];
  } else {
    // LoadImage's mask is 1 - alpha; the subject is its inverse.
    g.alpha = { class_type: 'InvertMask', inputs: { mask: ['img', 1] } };
    mask = ['alpha', 0];
  }
  g.crop = {
    class_type: 'ImageCropToMask',
    inputs: { images: ['img', 0], masks: mask, width: 1024, height: 1024, pad_factor: 1.1, grow_mask: 0, background: '#000000' },
  };
  g.subject = { class_type: 'PreviewImage', inputs: { images: ['crop', 0] } };
  if (model === 'pixal3d') {
    // Pixal3D conditions on the DINOv3-NAF encoder and a per-image camera FoV:
    // MoGe estimates the source camera on the cropped subject, and
    // MoGeGeometryToFOV turns its intrinsics into horizontal degrees (the
    // template's rig: the unit cube spans 1/1.1 of the frame).
    g.moge = { class_type: 'LoadMoGeModel', inputs: { model_name: MOGE_MODEL } };
    g.geo = {
      class_type: 'MoGeInference',
      inputs: { moge_model: ['moge', 0], image: ['crop', 0], resolution_level: 9, fov_x_degrees: 0, batch_size: 4, force_projection: true, apply_mask: true, refine_steps: 3 },
    };
    g.fov = { class_type: 'MoGeGeometryToFOV', inputs: { moge_geometry: ['geo', 0], axis: 'horizontal', unit: 'degrees' } };
    g.cond = { class_type: 'Pixal3DConditioning', inputs: { clip_vision_model: ['dino', 0], image: ['crop', 0], camera_angle_x: ['fov', 0] } };
  } else {
    g.cond = { class_type: 'Trellis2Conditioning', inputs: { clip_vision_model: ['dino', 0], image: ['crop', 0] } };
  }

  // ---- 1. sparse structure ----
  // The template's CFG override and rescale reproduce the reference pipeline's guidance schedule.
  g.cfgS = { class_type: 'CFGOverride', inputs: { model: ['unet', 0], cfg: 1, start_percent: 0.667, end_percent: 1 } };
  g.rsS = { class_type: 'RescaleCFG', inputs: { model: ['cfgS', 0], multiplier: 0.7 } };
  g.msS = { class_type: 'ModelSamplingSD3', inputs: { model: ['rsS', 0], shift: 5 } };
  g.empty = { class_type: 'EmptyTrellis2LatentStructure', inputs: { batch_size: 1 } };
  g.kS = {
    class_type: 'KSampler',
    inputs: {
      model: ['msS', 0], positive: ['cond', 0], negative: ['cond', 1], latent_image: ['empty', 0],
      seed, steps: q.structureSteps, cfg: 7.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    },
  };
  g.voxel = { class_type: 'VaeDecodeStructureTrellis2', inputs: { samples: ['kS', 0], vae: ['svae', 0], resolution: '32' } };

  // ---- 2. shape, then upsampled ----
  g.cfgG = { class_type: 'CFGOverride', inputs: { model: ['unet', 0], cfg: 1, start_percent: 0.769, end_percent: 1 } };
  g.rsG = { class_type: 'RescaleCFG', inputs: { model: ['cfgG', 0], multiplier: 0.5 } };
  g.shape = { class_type: 'Trellis2ShapeStage', inputs: { positive: ['cond', 0], negative: ['cond', 1], voxel: ['voxel', 0] } };
  g.kG = {
    class_type: 'KSampler',
    inputs: {
      model: ['rsG', 0], positive: ['shape', 0], negative: ['shape', 1], latent_image: ['shape', 2],
      seed: (seed + 1) % 2 ** 32, steps: q.shapeSteps, cfg: 7.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    },
  };
  g.up = {
    class_type: 'Trellis2UpsampleStage',
    inputs: { positive: ['shape', 0], negative: ['shape', 1], shape_latent: ['kG', 0], vae: ['svae', 0], target_resolution: q.resolution },
  };
  g.kU = {
    class_type: 'KSampler',
    inputs: {
      model: ['rsG', 0], positive: ['up', 0], negative: ['up', 1], latent_image: ['up', 2],
      seed: (seed + 2) % 2 ** 32, steps: q.upsampleSteps, cfg: 7.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    },
  };
  g.mesh = { class_type: 'VaeDecodeShapeTrellis', inputs: { samples: ['kU', 0], vae: ['svae', 0] } };

  // ---- 3. texture ----
  g.tex = { class_type: 'Trellis2TextureStage', inputs: { positive: ['up', 0], negative: ['up', 1], shape_latent: ['kU', 0] } };
  g.kT = {
    class_type: 'KSampler',
    inputs: {
      model: ['unet', 0], positive: ['tex', 0], negative: ['tex', 1], latent_image: ['tex', 2],
      seed: (seed + 3) % 2 ** 32, steps: q.textureSteps, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    },
  };
  g.colors = { class_type: 'VaeDecodeTextureTrellis', inputs: { samples: ['kT', 0], vae: ['tvae', 0], shape_subdivides: ['mesh', 1] } };

  // ---- post: a clean, unwrapped, textured mesh ----
  g.remesh = {
    class_type: 'RemeshMesh',
    inputs: {
      mesh: ['mesh', 0], resolution: q.remesh, sign_mode: 'udf',
      'sign_mode.qef': false, 'sign_mode.drop_inverted_components': false, 'sign_mode.drop_enclosed_components': false,
      band: 1, project_back: 0, fix_poles: false, smooth_iters: 0, drop_small_components: 0.01, precluster_max_verts: 20_000_000,
    },
  };
  g.dec = { class_type: 'DecimateMesh', inputs: { mesh: ['remesh', 0], target_face_count: q.faces, placement_mode: 'midpoint' } };
  g.smooth = { class_type: 'MeshSmoothNormals', inputs: { mesh: ['dec', 0], crease_angle: 180 } };
  g.uv = { class_type: 'UnwrapMesh', inputs: { mesh: ['smooth', 0], segmenter: 'pec', resolution: q.texture, padding: 1, weld_distance: 0.0002 } };
  g.bake = { class_type: 'BakeTextureFromVoxel', inputs: { mesh: ['uv', 0], voxel_colors: ['colors', 0], texture_size: q.texture, reference_mesh: ['mesh', 0] } };
  const maps: Record<string, Link> = { base_color: ['bake', 0], metallic: ['bake', 1], roughness: ['bake', 2] };
  if (q.bakeDetail) {
    g.nrm = { class_type: 'BakeNormalMapFromMesh', inputs: { low_poly: ['uv', 0], high_poly: ['remesh', 0], resolution: Math.min(2048, q.texture), cage_distance: 0.05, ignore_backfaces: true } };
    g.ao = { class_type: 'BakeAmbientOcclusion', inputs: { low_poly: ['uv', 0], high_poly: ['remesh', 0], resolution: 1024, samples: 64, max_distance: 0.71, strength: 1, bias: 0.01 } };
    maps.normal_map = ['nrm', 0];
    maps.occlusion = ['ao', 0];
  }
  g.apply = { class_type: 'ApplyTextureToMesh', inputs: { mesh: ['uv', 0], ...maps } };
  g.final = { class_type: 'MeshSmoothNormals', inputs: { mesh: ['apply', 0], crease_angle: 180 } };
  g.save = { class_type: 'SaveGLB', inputs: { mesh: ['final', 0], filename_prefix: p.filenamePrefix ?? 'morpheus/object' } };

  const frames = p.turntableFrames ?? TURNTABLE.frames;
  if (frames > 0) addTurntable(g, ['final', 0], frames);
  return g;
}

/**
 * A turntable of `mesh`: per frame the mesh turns about its vertical axis, tips
 * toward the camera a little, and RenderMesh ray-casts it from its default
 * front camera, which frames the mesh's bounding sphere. Turning the mesh
 * keeps any object, a bust or a full figure, filling the frame. Frame 0 is a
 * three-quarter view; it is the poster.
 */
function addTurntable(g: Graph, mesh: Link, frames: number) {
  let batch: Link | null = null;
  for (let i = 0; i < frames; i++) {
    // RotateMesh takes -360..360; keep the angle in one turn.
    const yaw = Math.round(((TURNTABLE.startYaw + (i * 360) / frames) % 360) * 100) / 100;
    g[`yaw${i}`] = { class_type: 'RotateMesh', inputs: { mesh, mode: 'euler_xyz', 'mode.angle_x': 0, 'mode.angle_y': yaw, 'mode.angle_z': 0 } };
    g[`tip${i}`] = { class_type: 'RotateMesh', inputs: { mesh: [`yaw${i}`, 0], mode: 'euler_xyz', 'mode.angle_x': TURNTABLE.pitch, 'mode.angle_y': 0, 'mode.angle_z': 0 } };
    g[`r${i}`] = {
      class_type: 'RenderMesh',
      inputs: { mesh: [`tip${i}`, 0], mode: 'auto', width: TURNTABLE.size, height: TURNTABLE.size, background: '#0b0a09' },
    };
    const frame: Link = [`r${i}`, 0];
    if (!batch) batch = frame;
    else {
      g[`b${i}`] = { class_type: 'ImageBatch', inputs: { image1: batch, image2: frame } };
      batch = [`b${i}`, 0];
    }
  }
  g.ttv = { class_type: 'CreateVideo', inputs: { images: batch!, fps: TURNTABLE.fps } };
  g.turntable = { class_type: 'SaveVideo', inputs: { video: ['ttv', 0], filename_prefix: 'morpheus/object_turntable', format: 'auto', codec: 'auto' } };
}
