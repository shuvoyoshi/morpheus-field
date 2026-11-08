/**
 * What the UI offers: models, motion presets, aspect/resolution menus.
 * Every model here is open weights and runs on the local engine.
 */
import { RENDER_TIERS, capTier, tierSize, tierSizeOf, type RenderTier } from './renderTier.js';

export type MediaKind = 'image' | 'video';

export interface VideoModel {
  id: 'ltx25' | 'ltx' | 'h3';
  label: string;
  vendor: string;
  note: string;
  start: boolean;      // accepts a start frame
  end: boolean;        // accepts an end frame (first + last)
  audio: boolean;
  durations: number[]; // seconds
  license: string;
  warn?: string;
}

export const VIDEO_MODELS: VideoModel[] = [
  {
    id: 'ltx25', label: 'LTX-2.5', vendor: 'Lightricks', note: 'Fast 22B distilled. Text, image, or first + last frame.',
    start: true, end: true, audio: true, durations: [3, 5, 8, 10], license: 'LTX community license',
  },
  {
    id: 'h3', label: 'MiniMax H3', vendor: 'MiniMax', note: 'Text, image, first + last frame, or references — all on the all-in-one H3 checkpoint. Strong direction-following and dialogue. Turbo (8-step) or max (20-step). Opt-in.',
    start: true, end: true, audio: true, durations: [5, 8, 10], license: 'H3 community license',
    warn: 'H3 license excludes the US, EU, UK and South Korea.',
  },
];

export interface ImageModel {
  id: 'qwen' | 'flux2';
  label: string;
  vendor: string;
  note: string;
  license: string;
  warn?: string;
}

export const IMAGE_MODELS: ImageModel[] = [
  { id: 'qwen', label: 'Qwen-Image', vendor: 'Alibaba', note: 'Text, layout and posters. Apache 2.0.', license: 'Apache 2.0' },
  { id: 'flux2', label: 'FLUX.2 dev', vendor: 'Black Forest Labs', note: 'Photoreal lead.', license: 'FLUX.2 dev non-commercial', warn: 'Non-commercial license.' },
];

export const ASPECTS = [
  { id: '16:9', w: 16, h: 9 },
  { id: '9:16', w: 9, h: 16 },
  { id: '1:1', w: 1, h: 1 },
  { id: '4:3', w: 4, h: 3 },
  { id: '21:9', w: 21, h: 9 },
] as const;
export type AspectId = (typeof ASPECTS)[number]['id'];

/** Pixel size for a given aspect at a target megapixel budget, snapped to 64. */
export function sizeFor(aspect: AspectId, mp: number): { w: number; h: number } {
  const a = ASPECTS.find((x) => x.id === aspect) ?? ASPECTS[0];
  const ratio = a.w / a.h;
  const h = Math.sqrt((mp * 1e6) / ratio);
  const snap = (n: number) => Math.max(256, Math.round(n / 64) * 64);
  return { w: snap(h * ratio), h: snap(h) };
}

/** Video sizes: the render tiers (src/renderTier.ts), as the size menus list them. */
export const VIDEO_RES = RENDER_TIERS.map((t) => ({ id: t.id, mp: t.mp, note: t.short }));

/** Width over height of an aspect. */
export const aspectRatio = (aspect: AspectId): number => {
  const a = ASPECTS.find((x) => x.id === aspect) ?? ASPECTS[0];
  return a.w / a.h;
};

/**
 * A video frame at a tier, 64-aligned (two-stage LTX-2.5): a fixed aspect, or
 * 'auto', which follows the start frame and falls back to 16:9.
 */
export function videoFrame(aspect: 'auto' | AspectId, tier: RenderTier, start?: { w?: number; h?: number }): { w: number; h: number } {
  if (aspect !== 'auto') return tierSize(tier, aspectRatio(aspect));
  return tierSizeOf(tier, start?.w, start?.h);
}

export const IMAGE_QUALITY = [
  { id: 'draft', label: 'Draft', note: '8 steps' },
  { id: 'quality', label: 'High', note: 'Full sampling' },
] as const;

export const IMAGE_RES = [
  { id: '1K', mp: 1.0 },
  { id: '2K', mp: 2.0 },
] as const;

/**
 * Motion presets. Each one is a prompt fragment in camera and VFX language
 * that LTX-2.5 follows well. Names are ours.
 */
export interface MotionPreset {
  id: string;
  name: string;
  cat: 'camera' | 'epic' | 'vfx' | 'mood';
  text: string;
  /** Placeholder art until a rendered thumbnail exists in /presets/<id>.mp4. */
  hue: number;
}

export const PRESET_CATS = [
  { id: 'all', label: 'All' },
  { id: 'camera', label: 'Camera' },
  { id: 'epic', label: 'Epic camera' },
  { id: 'vfx', label: 'Effects' },
  { id: 'mood', label: 'Mood' },
] as const;

export const PRESETS: MotionPreset[] = [
  { id: 'free', name: 'Free', cat: 'camera', text: '', hue: 30 },
  { id: 'push-in', name: 'Push In', cat: 'camera', text: 'The camera pushes in slowly and steadily toward the subject.', hue: 32 },
  { id: 'pull-back', name: 'Pull Back Reveal', cat: 'camera', text: 'The camera pulls back smoothly, revealing the wider environment around the subject.', hue: 200 },
  { id: 'orbit-left', name: 'Orbit Left', cat: 'camera', text: 'The camera orbits slowly to the left around the subject, keeping it centered.', hue: 260 },
  { id: 'orbit-right', name: 'Orbit Right', cat: 'camera', text: 'The camera orbits slowly to the right around the subject, keeping it centered.', hue: 280 },
  { id: 'crane-up', name: 'Crane Rise', cat: 'camera', text: 'The camera cranes up and rises above the scene, tilting down to keep the subject in frame.', hue: 170 },
  { id: 'truck-left', name: 'Side Track', cat: 'camera', text: 'The camera tracks sideways to the left, parallel to the subject, with foreground parallax.', hue: 140 },
  { id: 'handheld', name: 'Handheld Drift', cat: 'camera', text: 'Handheld camera, subtle natural sway and breathing, documentary feel.', hue: 20 },
  { id: 'static', name: 'Locked Off', cat: 'camera', text: 'The camera is completely still, a locked-off frame. Only the subject and the environment move.', hue: 0 },
  { id: 'rack-focus', name: 'Rack Focus', cat: 'camera', text: 'The focus racks from the foreground to the subject in the background, shallow depth of field.', hue: 45 },
  { id: 'dolly-zoom', name: 'Vertigo', cat: 'epic', text: 'Dolly zoom: the camera moves forward while zooming out, the background stretches away behind the subject.', hue: 330 },
  { id: 'crash-zoom', name: 'Crash Zoom', cat: 'epic', text: 'A sudden fast crash zoom in onto the subject.', hue: 0 },
  { id: 'fpv-dive', name: 'FPV Dive', cat: 'epic', text: 'FPV drone shot, fast and fluid, diving down and swooping through the scene.', hue: 190 },
  { id: 'whip-pan', name: 'Whip Pan', cat: 'epic', text: 'A fast whip pan with motion blur that lands on the subject.', hue: 15 },
  { id: 'aerial-pull', name: 'Aerial Pullback', cat: 'epic', text: 'Aerial shot pulling back and rising high into the sky, the landscape opening below.', hue: 210 },
  { id: 'freeze-orbit', name: 'Frozen Orbit', cat: 'epic', text: 'Time freezes; the camera orbits around the frozen moment, particles suspended in the air.', hue: 300 },
  { id: 'snorricam', name: 'Body Mount', cat: 'epic', text: 'Body-mounted camera locked to the subject’s face while the world moves around them.', hue: 350 },
  { id: 'embers', name: 'Ember Storm', cat: 'vfx', text: 'Glowing embers and sparks swirl through the air around the subject.', hue: 18 },
  { id: 'ink-bloom', name: 'Ink Bloom', cat: 'vfx', text: 'Dark ink blooms and spreads through the frame like smoke in water.', hue: 240 },
  { id: 'shatter', name: 'Glass Shatter', cat: 'vfx', text: 'The scene cracks and shatters like glass, fragments drifting in slow motion.', hue: 195 },
  { id: 'fog-roll', name: 'Fog Roll', cat: 'vfx', text: 'Thick fog rolls in low across the ground and slowly swallows the scene.', hue: 220 },
  { id: 'neon-rain', name: 'Neon Rain', cat: 'vfx', text: 'Heavy rain falls, neon reflections shimmer on every wet surface.', hue: 290 },
  { id: 'disintegrate', name: 'Dust Away', cat: 'vfx', text: 'The subject slowly disintegrates into fine drifting dust carried by the wind.', hue: 35 },
  { id: 'bloom', name: 'Overgrowth', cat: 'vfx', text: 'Plants and flowers grow rapidly and overtake every surface in time-lapse.', hue: 110 },
  { id: 'golden', name: 'Golden Hour', cat: 'mood', text: 'Warm low golden-hour sun, long shadows, soft haze, lens flare.', hue: 38 },
  { id: 'noir', name: 'Night Noir', cat: 'mood', text: 'High-contrast night, hard single light source, deep shadows, wet streets.', hue: 230 },
  { id: 'dreamlike', name: 'Dream Drift', cat: 'mood', text: 'Slow dreamlike motion, soft focus edges, floating particles, gentle light.', hue: 270 },
  { id: 'storm', name: 'Storm Front', cat: 'mood', text: 'A storm front moves in, wind whips through the scene, flashes of lightning.', hue: 205 },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

/** Deterministic placeholder gradient for a preset or app. */
export function artFor(hue: number): string {
  return `radial-gradient(120% 90% at 75% 20%, hsl(${hue} 70% 32% / .95), transparent 60%), radial-gradient(90% 80% at 15% 90%, hsl(${(hue + 40) % 360} 60% 18%), transparent 70%), #08080a`;
}

/** Compose the final prompt: user text + motion preset + optional style. */
export function compilePrompt(parts: (string | undefined | false)[]): string {
  return parts
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .map((p) => (/[.!?]$/.test(p) ? p : `${p}.`))
    .join(' ');
}

/** Object app detail levels; the numbers mirror server/graphs/trellis.ts OBJECT_QUALITY. */
export const OBJECT_DETAIL = [
  { id: 'draft', label: 'Draft', note: 'Up to 150k faces, 2K textures. About 2 minutes on a 5090. Check the shape here.' },
  { id: 'quality', label: 'High', note: 'Up to 400k faces, 4K textures plus baked normal and AO maps. About 5 minutes on a 5090.' },
] as const;

/** The app gallery. `route` is where Try opens; `soon` apps are listed but locked. */
export interface AppDef {
  id: string;
  name: string;
  blurb: string;
  route: string;
  icon: string;
  hue: number;
  cat: 'create' | 'direct' | 'transform' | 'finish';
  /** Motion preset whose rendered clip stands in as this app's cover art. */
  cover: string;
  /** A clip of the app's own output under public/, used as the cover in place of the preset clip. */
  clip?: string;
}

export const APP_CATS = [
  { id: 'all', label: 'All' },
  { id: 'create', label: 'Create' },
  { id: 'direct', label: 'Direct' },
  { id: 'transform', label: 'Transform' },
  { id: 'finish', label: 'Finish' },
] as const;

export const APPS: AppDef[] = [
  { id: 'video', name: 'Video', blurb: 'Turn text or an image into video, with camera and effect presets.', route: '/video', icon: 'video', hue: 32, cat: 'create', cover: 'embers', clip: '/apps/video.mp4' },
  { id: 'image', name: 'Image', blurb: 'Make stills from a prompt and animate any of them in one click.', route: '/image', icon: 'image', hue: 200, cat: 'create', cover: 'golden', clip: '/apps/image.mp4' },
  { id: 'loop', name: 'Seamless Loop', blurb: 'Turn one image into a loop whose first and last frames match.', route: '/video?mode=loop', icon: 'loop', hue: 160, cat: 'create', cover: 'dreamlike', clip: '/apps/loop.mp4' },
  { id: 'cast', name: 'Cast', blurb: 'Save a character, prop or place once and @mention it in any prompt.', route: '/cast', icon: 'person', hue: 28, cat: 'direct', cover: 'handheld', clip: '/apps/cast.mp4' },
  { id: 'director', name: 'Director', blurb: 'Set genre, camera, light, film stock, era and speed ramp, and they compile into the shot.', route: '/director', icon: 'film', hue: 18, cat: 'direct', cover: 'noir', clip: '/apps/director.mp4' },
  { id: 'stage', name: 'Stage', blurb: 'Block a shot in 3D and render it as a finished shot that moves like the blocking.', route: '/stage', icon: 'camera', hue: 36, cat: 'direct', cover: 'push-in', clip: '/apps/stage.mp4' },
  { id: 'scene', name: 'Scene', blurb: 'Write a scene and get it planned, shot and cut into one take.', route: '/director?mode=scene', icon: 'grid', hue: 28, cat: 'direct', cover: 'crane-up', clip: '/apps/scene.mp4' },
  { id: 'effects', name: 'Effects', blurb: 'Apply a one-click effect to a clip or a still, from cutout and flood to pop and inflate.', route: '/effects', icon: 'sparkle', hue: 300, cat: 'transform', cover: 'shatter', clip: '/apps/effects.mp4' },
  { id: 'mirror', name: 'Mirror', blurb: 'Film a move on your phone and put that motion onto any character.', route: '/mirror', icon: 'mirror', hue: 280, cat: 'transform', cover: 'snorricam', clip: '/apps/mirror.mp4' },
  { id: 'reshoot', name: 'Reshoot', blurb: 'Re-aim the camera on an existing clip: orbit, rise or push in after the fact.', route: '/reshoot', icon: 'orbit', hue: 230, cat: 'transform', cover: 'freeze-orbit', clip: '/apps/reshoot.mp4' },
  { id: 'edit', name: 'Edit', blurb: 'Change a still with a sentence, and paint a mask to keep the rest exactly.', route: '/edit', icon: 'wand', hue: 250, cat: 'transform', cover: 'ink-bloom' },
  { id: 'angle', name: 'New angle', blurb: 'See the same scene from new camera positions, as a grid of angles.', route: '/edit?app=angle', icon: 'orbit', hue: 210, cat: 'transform', cover: 'orbit-right' },
  { id: 'coverage', name: 'Coverage', blurb: 'Get nine shots of one moment from one image, from wide to extreme close-up.', route: '/edit?app=coverage', icon: 'grid', hue: 150, cat: 'direct', cover: 'truck-left' },
  { id: 'pushin', name: 'Push in', blurb: 'Walk the camera toward the subject in steps, down to the detail.', route: '/edit?app=pushin', icon: 'search', hue: 40, cat: 'direct', cover: 'push-in' },
  { id: 'next', name: 'Next beat', blurb: 'Get four continuations of the moment in the same world.', route: '/edit?app=next', icon: 'film', hue: 205, cat: 'direct', cover: 'storm' },
  { id: 'relight', name: 'Relight', blurb: 'Move the light and change its color, one mood per result.', route: '/edit?app=relight', icon: 'light', hue: 38, cat: 'transform', cover: 'golden' },
  { id: 'cutout', name: 'Remove background', blurb: 'Cut the subject out of a still or a clip, with alpha or over a new background.', route: '/cutout', icon: 'cutout', hue: 120, cat: 'transform', cover: 'static' },
  { id: 'expand', name: 'Expand', blurb: 'Grow the frame to a new shape and paint in what was outside it.', route: '/edit?app=expand', icon: 'aspect', hue: 220, cat: 'transform', cover: 'pull-back' },
  { id: 'extend', name: 'Extend', blurb: 'Continue a take forward or give it a lead-in, with motion, look and sound carried on.', route: '/extend', icon: 'plus', hue: 24, cat: 'finish', cover: 'aerial-pull', clip: '/apps/extend.mp4' },
  { id: 'transition', name: 'Transitions', blurb: 'Bridge two takes or stills with a generated move such as a morph or a whip pan.', route: '/extend?mode=transition', icon: 'loop', hue: 300, cat: 'finish', cover: 'whip-pan', clip: '/apps/transition.mp4' },
  { id: 'upscale', name: 'Upscale', blurb: 'Sharpen, redraw or dream any take or file at a higher resolution.', route: '/upscale', icon: 'up', hue: 50, cat: 'finish', cover: 'rack-focus', clip: '/apps/upscale.mp4' },
  { id: 'speak', name: 'Speak', blurb: 'Turn a face and a voice track into a talking shot that follows the audio.', route: '/speak', icon: 'person', hue: 12, cat: 'transform', cover: 'handheld' },
  { id: 'object', name: 'Object', blurb: 'Turn one still into a textured 3D model you can spin, download or place in Stage.', route: '/object', icon: 'cube', hue: 30, cat: 'create', cover: 'turntable', clip: '/apps/object.mp4' },
  { id: 'sound', name: 'Add sound', blurb: 'Generate a soundtrack for a silent take and keep the picture as it is.', route: '/speak?mode=sound', icon: 'audio', hue: 190, cat: 'create', cover: 'storm' },
  { id: 'audio', name: 'Audio', blurb: 'Write lyrics and tags and get a full song from ACE-Step 1.5, or have Qwen3-TTS say anything in a voice you describe.', route: '/audio', icon: 'audio', hue: 175, cat: 'create', cover: 'golden' },
  { id: 'agent', name: 'Agent', blurb: 'Chat with a model that plans and drives the whole studio, chaining renders until your ask is done.', route: '/agent', icon: 'nodes', hue: 335, cat: 'direct', cover: 'dolly-zoom' },
];

/** ACE-Step's 24 keys, in the exact "Name major/minor" form the encoder lists. */
export const ACE_KEYS = [
  'C major', 'G major', 'D major', 'A major', 'E major', 'B major', 'F# major',
  'F major', 'C# major', 'G# major', 'D# major', 'A# major',
  'C minor', 'G minor', 'D minor', 'A minor', 'E minor', 'B minor', 'F# minor',
  'F minor', 'C# minor', 'G# minor', 'D# minor', 'A# minor',
];
/** ACE-Step language codes (the encoder's list, a practical subset). */
export const ACE_LANGUAGES = [
  { id: 'en', label: 'English' }, { id: 'zh', label: 'Chinese' }, { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' }, { id: 'es', label: 'Spanish' }, { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' }, { id: 'it', label: 'Italian' }, { id: 'pt', label: 'Portuguese' },
  { id: 'ru', label: 'Russian' },
];
export const ACE_TIMESIGS = [
  { id: '4', label: '4/4' }, { id: '3', label: '3/4' }, { id: '2', label: '2/4' }, { id: '6', label: '6/8' },
];
/** Qwen3VoiceDesign's language list. */
export const TTS_LANGUAGES = ['Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'];

/** Ready-made setups. Recreate loads one into its app via URL params. */
export interface Recipe { id: string; name: string; preset: string; prompt: string; route: string }
export const RECIPES: Recipe[] = [
  { id: 'storm-keeper', name: 'Storm keeper', preset: 'push-in', route: '/video', prompt: 'An old lighthouse keeper in a yellow raincoat on a pier as a storm breaks, waves exploding over the rail.' },
  { id: 'gallery-orbit', name: 'Gallery orbit', preset: 'orbit-left', route: '/video', prompt: 'A bronze statue of a dancer in an empty marble hall, dust in the window light.' },
  { id: 'forge', name: 'Forge sparks', preset: 'embers', route: '/video', prompt: 'A blacksmith hammering glowing steel in a dark forge.' },
  { id: 'canyon', name: 'Canyon dive', preset: 'fpv-dive', route: '/video', prompt: 'A waterfall pouring into a green jungle canyon, mist rising.' },
  { id: 'noir-street', name: 'Noir corner', preset: 'noir', route: '/video', prompt: 'A detective under a single streetlamp, rain on the brim of his hat.' },
  { id: 'dust-horse', name: 'Dust horse', preset: 'disintegrate', route: '/video', prompt: 'A stone statue of a horse on a desert plain at dusk.' },
  { id: 'corridor', name: 'Vertigo corridor', preset: 'dolly-zoom', route: '/video', prompt: 'A man at the far end of a long hotel corridor with patterned carpet.' },
  { id: 'lantern', name: 'Lantern field', preset: 'dreamlike', route: '/video', prompt: 'A girl holding a paper lantern in a field of tall grass at night.' },
];
export const recipeUrl = (r: Recipe) => `${r.route}?preset=${r.preset}&prompt=${encodeURIComponent(r.prompt)}`;

/**
 * Director axes. Each option is a prompt fragment; the page and the MCP server
 * both compile them with directorDirection() below. A genre option also `sets`
 * the other axes when it is picked (the user can override them after).
 */
export interface DirectorOption { id: string; label: string; text: string; sets?: Record<string, string> }
export interface DirectorAxis { id: string; label: string; icon: string; options: DirectorOption[] }

export const DIRECTOR_AXES: DirectorAxis[] = [
  { id: 'genre', label: 'Genre', icon: 'wand', options: [
    { id: 'auto', label: 'Auto', text: '' },
    { id: 'drama', label: 'Drama', text: 'intimate character drama, naturalistic performances, emotional weight in small gestures', sets: { camera: 'large-format', light: 'overcast', grade: 'natural' } },
    { id: 'noir', label: 'Noir', text: 'film noir, moral shadows, smoke and venetian-blind light, a city that keeps secrets', sets: { light: 'chiaroscuro', film: 'bw', look: 'noir', grade: 'mono' } },
    { id: 'horror', label: 'Horror', text: 'horror film, creeping tension, the camera lingers on what should not be there', sets: { light: 'moon', look: 'horror', grade: 'steel' } },
    { id: 'action', label: 'Action', text: 'high-octane action film, kinetic momentum, debris and speed, bodies in motion', sets: { camera: 'anamorphic', light: 'hard', grade: 'teal' } },
    { id: 'comedy', label: 'Comedy', text: 'bright comedy, playful timing, warm and open frames, expressive faces', sets: { camera: 'wide-prime', light: 'golden', grade: 'pastel' } },
    { id: 'epic', label: 'Epic', text: 'sweeping epic, mythic scale, vast landscapes and tiny figures against them', sets: { camera: 'anamorphic', light: 'golden', look: 'epic' } },
    { id: 'scifi', label: 'Sci-fi', text: 'science fiction, cold engineered spaces, the future made physical', sets: { light: 'neon', look: 'scifi', grade: 'steel' } },
  ]},
  { id: 'camera', label: 'Camera', icon: 'camera', options: [
    { id: 'auto', label: 'Auto', text: '' },
    { id: 'large-format', label: 'Large format · 50mm f/2', text: 'shot on a large-format digital cinema camera, 50mm lens at f/2, shallow depth of field' },
    { id: 'anamorphic', label: 'Anamorphic · 40mm', text: 'anamorphic 40mm lens, oval bokeh, horizontal lens flares, 2.39:1 feel' },
    { id: 'wide-prime', label: 'Wide prime · 24mm', text: '24mm wide prime lens, deep focus, environmental framing' },
    { id: 'tele', label: 'Telephoto · 135mm', text: '135mm telephoto lens, compressed background, creamy falloff' },
    { id: '16mm', label: '16mm film camera', text: 'shot on a 16mm film camera, handheld intimacy, visible grain' },
    { id: 'vintage', label: 'Vintage glass', text: 'vintage uncoated lens, soft halation, gentle vignette' },
  ]},
  { id: 'framing', label: 'Framing', icon: 'aspect', options: [
    { id: 'auto', label: 'Auto', text: '' },
    { id: 'wide', label: 'Wide', text: 'wide establishing shot' },
    { id: 'medium', label: 'Medium', text: 'medium shot, waist up' },
    { id: 'close', label: 'Close-up', text: 'close-up on the face' },
    { id: 'ecu', label: 'Extreme close-up', text: 'extreme close-up detail' },
    { id: 'ots', label: 'Over the shoulder', text: 'over-the-shoulder shot' },
    { id: 'low', label: 'Low angle', text: 'low-angle shot looking up, heroic' },
    { id: 'high', label: 'High angle', text: 'high-angle shot looking down' },
    { id: 'top', label: 'Top down', text: 'top-down overhead shot' },
  ]},
  { id: 'light', label: 'Light', icon: 'light', options: [
    { id: 'auto', label: 'Auto', text: '' },
    { id: 'golden', label: 'Golden hour', text: 'warm low golden-hour sun, long shadows' },
    { id: 'overcast', label: 'Overcast soft', text: 'soft overcast daylight, gentle wraparound light' },
    { id: 'practical', label: 'Practical night', text: 'night lit only by practical lamps and signs, pools of light' },
    { id: 'hard', label: 'Hard noon', text: 'hard midday sun, crisp black shadows' },
    { id: 'neon', label: 'Neon', text: 'saturated neon light, magenta and cyan spill' },
    { id: 'candle', label: 'Candlelight', text: 'flickering candlelight, warm falloff into darkness' },
    { id: 'moon', label: 'Moonlight', text: 'cold blue moonlight, silver rim light' },
    { id: 'chiaroscuro', label: 'Chiaroscuro', text: 'single hard key light, deep chiaroscuro shadows' },
  ]},
  { id: 'film', label: 'Film', icon: 'film', options: [
    { id: 'auto', label: 'Auto', text: '' },
    { id: '500t', label: 'Tungsten 500T', text: 'tungsten-balanced 500T motion picture film, fine grain, cool shadows' },
    { id: '250d', label: 'Daylight 250D', text: 'daylight 250D motion picture film, natural color' },
    { id: 'reversal', label: 'Slide reversal', text: 'color reversal slide film, rich saturated color, deep blacks' },
    { id: 'bw', label: 'Black and white 400', text: 'black and white 400 speed film, strong grain, silver tones' },
    { id: 'digital', label: 'Clean digital', text: 'clean digital cinema image, no grain' },
  ]},
  { id: 'look', label: 'Look', icon: 'sparkle', options: [
    { id: 'auto', label: 'Auto', text: '' },
    { id: 'noir', label: 'Neo-noir', text: 'neo-noir mood, rain-slick, menace' },
    { id: 'epic', label: 'Epic', text: 'epic scale, vast, awe' },
    { id: 'horror', label: 'Dread', text: 'quiet dread, negative space, something wrong in the frame' },
    { id: 'doc', label: 'Documentary', text: 'observational documentary realism' },
    { id: 'dream', label: 'Dreamlike', text: 'dreamlike and uncanny, soft surreal atmosphere' },
    { id: 'scifi', label: 'Hard sci-fi', text: 'hard science fiction, practical-feeling machinery' },
  ]},
  { id: 'grade', label: 'Grade', icon: 'palette', options: [
    { id: 'auto', label: 'Auto', text: '' },
    { id: 'teal', label: 'Teal and orange', text: 'teal and orange color grade' },
    { id: 'bleach', label: 'Bleach bypass', text: 'bleach-bypass grade, low saturation, high contrast' },
    { id: 'pastel', label: 'Warm pastel', text: 'warm pastel grade, lifted blacks' },
    { id: 'steel', label: 'Cold steel', text: 'cold steel-blue grade' },
    { id: 'mono', label: 'Monochrome', text: 'monochrome grade' },
    { id: 'natural', label: 'Natural', text: 'natural, true-to-life color' },
  ]},
];

/** Camera moves the Director offers in Shot mode. */
export const DIRECTOR_MOVES = PRESETS.filter((p) => p.cat === 'camera' || p.cat === 'epic');

/** Picks after choosing a genre: its `sets` overwrite those axes, the rest stay. */
export function pickGenre(picks: Record<string, string>, genre: string): Record<string, string> {
  const opt = DIRECTOR_AXES[0].options.find((o) => o.id === genre);
  return { ...picks, ...(opt?.sets ?? {}), genre };
}

/**
 * Era scrubber, 1960 to 2020. The prompt snaps to the nearest decade; the
 * grade is a real color pass on the output (server/graphs/director.ts, a
 * GLSL shader in the graph) blended between the two decades either side.
 */
export const ERA_MIN = 1960;
export const ERA_MAX = 2020;

/** Grade knobs per decade. lift = RGB added in the shadows, gain = RGB multiplied in the highlights. */
export interface EraGrade {
  sat: number; contrast: number; fade: number;
  lift: [number, number, number]; gain: [number, number, number];
  grain: number; bloom: number; vignette: number;
}

export const ERA_DECADES: { year: number; label: string; text: string; grade: EraGrade }[] = [
  { year: 1960, label: '1960s', text: '1960s period film, dye-transfer color, rich reds and painted skies, soft contrast, fine grain',
    grade: { sat: 1.3, contrast: 0.92, fade: 0.04, lift: [0.0, 0.04, 0.06], gain: [1.1, 1.0, 0.84], grain: 0.06, bloom: 0.12, vignette: 0.38 } },
  { year: 1970, label: '1970s', text: '1970s film look, warm faded color, lifted blacks, soft contrast, heavy grain',
    grade: { sat: 0.74, contrast: 0.84, fade: 0.11, lift: [0.05, 0.03, 0.0], gain: [1.06, 0.98, 0.82], grain: 0.085, bloom: 0.15, vignette: 0.3 } },
  { year: 1980, label: '1980s', text: '1980s look, punchy saturated color, diffusion filter bloom on the highlights',
    grade: { sat: 1.28, contrast: 1.08, fade: 0.03, lift: [0.025, 0.0, 0.04], gain: [1.03, 0.96, 1.02], grain: 0.05, bloom: 0.42, vignette: 0.2 } },
  { year: 1990, label: '1990s', text: '1990s look, slightly green shadows, analog print texture',
    grade: { sat: 0.94, contrast: 1.06, fade: 0.03, lift: [0.0, 0.035, 0.01], gain: [1.03, 1.0, 0.93], grain: 0.045, bloom: 0.08, vignette: 0.22 } },
  { year: 2000, label: '2000s', text: 'early 2000s look, desaturated bleach-bypass contrast, cool steel tones',
    grade: { sat: 0.5, contrast: 1.35, fade: 0.0, lift: [0.0, 0.02, 0.03], gain: [0.94, 1.0, 1.02], grain: 0.035, bloom: 0.05, vignette: 0.3 } },
  { year: 2010, label: '2010s', text: '2010s digital cinema look, teal shadows and warm skin tones, clean image',
    grade: { sat: 1.05, contrast: 1.1, fade: 0.0, lift: [-0.01, 0.02, 0.045], gain: [1.06, 1.0, 0.93], grain: 0.012, bloom: 0.04, vignette: 0.15 } },
  { year: 2020, label: '2020s', text: 'modern high-dynamic-range digital look, clean and crisp',
    grade: { sat: 1.08, contrast: 1.04, fade: 0.0, lift: [0.0, 0.0, 0.0], gain: [1.0, 1.0, 1.0], grain: 0.0, bloom: 0.02, vignette: 0.08 } },
];

export const clampEra = (year: number) => Math.max(ERA_MIN, Math.min(ERA_MAX, Math.round(year)));

/** The decade the prompt names for a year. */
export const eraDecade = (year: number) =>
  ERA_DECADES.reduce((a, b) => (Math.abs(b.year - year) < Math.abs(a.year - year) ? b : a));

/** The grade for a year: linear blend between the decades either side. */
export function eraGrade(year: number): EraGrade {
  const y = clampEra(year);
  const i = Math.min(ERA_DECADES.length - 2, Math.floor((y - ERA_MIN) / 10));
  const a = ERA_DECADES[i].grade;
  const b = ERA_DECADES[i + 1].grade;
  // Eased so each decade holds its look near its own year and the scrub moves between them.
  const lin = (y - ERA_DECADES[i].year) / 10;
  const t = lin * lin * (3 - 2 * lin);
  const mix = (x: number, z: number) => Math.round((x + (z - x) * t) * 1000) / 1000;
  const mix3 = (x: number[], z: number[]) => [0, 1, 2].map((k) => mix(x[k], z[k])) as [number, number, number];
  return {
    sat: mix(a.sat, b.sat), contrast: mix(a.contrast, b.contrast), fade: mix(a.fade, b.fade),
    lift: mix3(a.lift, b.lift), gain: mix3(a.gain, b.gain),
    grain: mix(a.grain, b.grain), bloom: mix(a.bloom, b.bloom), vignette: mix(a.vignette, b.vignette),
  };
}

/**
 * The direction fragments in prompt order: genre, the other axes, then the
 * era's decade. Unknown axes (old takes saved an `era` pick) are ignored.
 */
export function directorDirection(picks: Record<string, string>, era: number | null): string[] {
  const out = DIRECTOR_AXES.map((a) => a.options.find((o) => o.id === (picks[a.id] ?? 'auto'))?.text).filter(Boolean) as string[];
  if (era != null) out.push(eraDecade(clampEra(era)).text);
  return out;
}

/**
 * Speed ramps: a retime after the render. Each is a speed curve over the
 * source clip (1 = real time, 0.25 = quarter speed). Slow parts are filled
 * with RIFE frames in the graph, then frames are picked along the curve, so
 * the shot's length changes. Ramped shots render without sound.
 */
export const SPEED_RAMPS = [
  { id: 'linear', label: 'Linear', note: 'Real time' },
  { id: 'slowmo', label: 'Slow-mo', note: 'Half speed throughout, twice as long' },
  { id: 'rampup', label: 'Ramp up', note: 'Starts slow, ends fast' },
  { id: 'impact', label: 'Impact', note: 'Fast in, a hard slow beat in the middle, out' },
  { id: 'bullet', label: 'Bullet time', note: 'Real time, then nearly frozen through the middle, then real time' },
] as const;
export type RampId = (typeof SPEED_RAMPS)[number]['id'];
export const isRamp = (id: unknown): id is RampId => SPEED_RAMPS.some((r) => r.id === id);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Speed at source position u (0..1). Never below 0.2. */
export function rampSpeed(id: RampId, u: number): number {
  switch (id) {
    case 'slowmo': return 0.5;
    case 'rampup': return 0.35 + 1.45 * smooth(0.15, 0.85, u);
    case 'impact': return 1.35 - 1.1 * smooth(0.32, 0.44, u) * (1 - smooth(0.6, 0.72, u));
    case 'bullet': return 1 - 0.8 * smooth(0.25, 0.4, u) * (1 - smooth(0.6, 0.75, u));
    default: return 1;
  }
}

/**
 * The retime of a clip of `frames` frames: how many in-between frames RIFE
 * makes per source frame (`multiplier`), and which frames of that dense batch
 * the output keeps, in order. Output frame k advances the source by
 * speed(u) source frames.
 */
export function rampPlan(id: RampId, frames: number): { multiplier: number; indices: number[]; outFrames: number } {
  if (id === 'linear' || frames < 2) {
    return { multiplier: 1, indices: Array.from({ length: frames }, (_, i) => i), outFrames: frames };
  }
  const span = frames - 1;
  let min = Infinity;
  for (let i = 0; i <= 100; i++) min = Math.min(min, rampSpeed(id, i / 100));
  const multiplier = Math.max(2, Math.min(5, Math.ceil(1 / min - 1e-6)));
  const last = span * multiplier;
  const indices: number[] = [];
  for (let s = 0; s <= span + 1e-9; s += rampSpeed(id, s / span)) indices.push(Math.min(last, Math.round(s * multiplier)));
  if (indices[indices.length - 1] !== last) indices.push(last);
  return { multiplier, indices, outFrames: indices.length };
}

/** Seconds a ramped clip runs at 24 fps. */
export const rampSeconds = (id: RampId, seconds: number, fps = 24) =>
  Math.round((rampPlan(id, Math.round(seconds * fps) + 1).outFrames / fps) * 10) / 10;

/**
 * Multi-shot: one scene becomes a shot list (server-side local LLM, or written
 * by hand), each shot an LTX job, then one cut. `cast` is the seam for the Cast
 * app: cast member ids whose hero frame the shot starts from (server/scene.ts,
 * castHeroSeam).
 */
export interface SceneShot {
  framing: string;      // a DIRECTOR_AXES framing id
  move: string;         // a DIRECTOR_MOVES id
  action: string;       // what happens in this shot
  seconds: number;      // 2 to 6
  ramp?: RampId;        // overrides the scene's ramp
  cast?: number[];      // cast member ids (Cast app); see castHeroSeam in server/scene.ts
  /** A finished video take to reuse instead of shooting this one again. */
  take?: number;
}
export const SCENE_MIN_SHOTS = 2;
export const SCENE_MAX_SHOTS = 6;
export const SHOT_SECONDS = { min: 2, max: 6 } as const;
export const SCENE_FRAMINGS = DIRECTOR_AXES.find((a) => a.id === 'framing')!.options.filter((o) => o.id !== 'auto');

/**
 * One shot's prompt: its move, framing and action, then the shared direction.
 * The whole scene is left out on purpose: given every beat, the model tries to
 * play them all in one shot. The planner writes each action to stand alone
 * (place and character named every time).
 */
export function shotPrompt(shot: Pick<SceneShot, 'framing' | 'move' | 'action'>, direction: string[]): string {
  const framing = SCENE_FRAMINGS.find((f) => f.id === shot.framing)?.text;
  return compilePrompt([presetById(shot.move).text, framing && `${framing[0].toUpperCase()}${framing.slice(1)}`, shot.action, direction.join(', ')]);
}

/** Mirror control tracks: what of the source clip is kept. */
export const MIRROR_CONTROLS = [
  { id: 'pose', label: 'Body motion', note: 'Tracks the skeleton: performance, dance, gesture.' },
  { id: 'depth', label: 'Whole scene', note: 'Keeps the shape of the space and the camera move.' },
  { id: 'edges', label: 'Outlines', note: 'Keeps contours tightly. Best for objects and graphics.' },
] as const;

/** Reshoot angle shortcuts (degrees of orbit and height). */
export const RESHOOT_ANGLES = [
  { id: 'orbit-r', label: 'Orbit right', az: 30, el: 0 },
  { id: 'orbit-l', label: 'Orbit left', az: -30, el: 0 },
  { id: 'high', label: 'From above', az: 0, el: 25 },
  { id: 'low', label: 'From below', az: 0, el: -15 },
  { id: 'three-q', label: 'Three-quarter', az: 40, el: 12 },
];

/**
 * Upscale app. Three ways to add resolution, each a ComfyUI graph in
 * server/graphs/upscale.ts. The page, the server and the MCP server all size
 * the output with upscaleSize() so the three never disagree.
 */
export type UpscaleMode = 'sharpen' | 'redraw' | 'dream';

export const UPSCALE_MODES: { id: UpscaleMode; label: string; note: string; image: boolean }[] = [
  { id: 'sharpen', label: 'Sharpen', note: 'Fast and faithful. A 2x ESRGAN pass that keeps every pixel where it was.', image: true },
  { id: 'redraw', label: 'Redraw', note: 'SeedVR2 rebuilds real detail: skin, fabric, foliage, text. Slower.', image: true },
  { id: 'dream', label: 'Dream', note: 'LTX-2.5 re-imagines the clip at 2x. Steer it with a prompt and a creativity amount.', image: false },
];

export const SHARPEN_MODELS = [
  { id: 'esrgan', label: 'RealESRGAN x4plus', file: 'RealESRGAN_x4plus.pth', note: 'BSD-3. Safe for paid work.' },
  { id: 'ultrasharp', label: '4x-UltraSharp', file: '4x-UltraSharp.pth', note: 'Crisper edges. Non-commercial license.', warn: '4x-UltraSharp is licensed CC BY-NC-SA 4.0: non-commercial use only.' },
] as const;
export type SharpenModel = (typeof SHARPEN_MODELS)[number]['id'];

export const REDRAW_MODELS = [
  { id: '3b', label: 'SeedVR2 3B', note: 'Fast.' },
  { id: '7b', label: 'SeedVR2 7B', note: 'More detail, about twice as slow.' },
] as const;
export type RedrawModel = (typeof REDRAW_MODELS)[number]['id'];

/** Redraw target, as the short edge of the frame. 4K direct does not fit a 32 GB card. */
export const REDRAW_HEIGHTS = [1080, 1440] as const;

export const REDRAW_COLOR = [
  { id: 'lab', label: 'Match color', note: 'Keeps the source grade. Default.' },
  { id: 'wavelet', label: 'Soft match', note: 'Matches broad color, keeps new fine detail.' },
  { id: 'none', label: 'Off', note: 'Whatever the model returns.' },
] as const;
export type RedrawColor = (typeof REDRAW_COLOR)[number]['id'];

/** Dream creativity: the sigma the refine pass starts from. Low keeps the source, high re-imagines it. */
export const DREAM_CREATIVITY = { min: 0.2, max: 0.85, default: 0.5 } as const;
export const DREAM_MAX_SECONDS = 10;
/** Longest delivered edge for Dream (the LTX refine runs at full output size). */
export const DREAM_MAX_EDGE = 1920;
/** Longest delivered edge for Sharpen. */
export const SHARPEN_MAX_EDGE = 3840;
/**
 * Sharpen holds the whole clip at 4x in RAM (float32) before the 2x reduction,
 * so its length is capped by that buffer: about 14 s of 832x448, 5.7 s of
 * 1280x704, 2.5 s of 1080p.
 */
export const SHARPEN_BUFFER_GB = 24;
export function sharpenMaxSeconds(w: number, h: number): number {
  if (!w || !h) return Infinity;
  return Math.floor(((SHARPEN_BUFFER_GB * 1e9) / (16 * w * h * 12)) / 24 * 10) / 10;
}
/** Redraw caps clips at this length too: SeedVR2 runs about a second per frame at 1080p. */
export const REDRAW_MAX_SECONDS = 10;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const snap32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);

/**
 * Delivered frame size for an upscale of a w x h source.
 *   sharpen: 2x, capped so the long edge stays within SHARPEN_MAX_EDGE.
 *   redraw:  short edge to `height`, long edge capped at the 16:9 width of that height.
 *   dream:   2x of a 32-aligned base frame, capped at DREAM_MAX_EDGE (LTX latents are 32-aligned
 *            and the latent upsampler doubles them, so the output is 64-aligned).
 */
export function upscaleSize(mode: UpscaleMode, w: number, h: number, height: number = REDRAW_HEIGHTS[0]): { w: number; h: number } {
  if (!w || !h) return { w: 0, h: 0 };
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (mode === 'sharpen') {
    const s = Math.min(2, SHARPEN_MAX_EDGE / long);
    return { w: even(w * s), h: even(h * s) };
  }
  if (mode === 'redraw') {
    const s = Math.min(height / short, Math.round((height * 16) / 9) / long);
    return { w: even(w * s), h: even(h * s) };
  }
  const s = Math.min(2, DREAM_MAX_EDGE / long);
  return { w: snap32((w * s) / 2) * 2, h: snap32((h * s) / 2) * 2 };
}

/** LTX frame counts satisfy n % 8 === 1. Largest such count that fits in the clip, capped. */
export function dreamFrames(seconds: number, fps = 24): number {
  const n = Math.floor(Math.min(seconds, DREAM_MAX_SECONDS) * fps + 1e-6);
  return Math.max(9, Math.floor((n - 1) / 8) * 8 + 1);
}

/** Transition bridge styles. Each is the bridge prompt; the user's words follow it. Names are ours. */
export const TRANSITION_STYLES = [
  { id: 'morph', label: 'Morph', text: 'One continuous shot. The first scene fluidly morphs into the second: shapes, light and color melt and reform into the new subject without a cut.' },
  { id: 'whip', label: 'Whip pan', text: 'A fast whip pan with heavy motion blur carries the camera out of the first scene and lands it in the second.' },
  { id: 'match', label: 'Match cut', text: 'A graphic match cut: the dominant shape of the first frame becomes the matching shape of the second frame, same position, same scale.' },
  { id: 'light-leak', label: 'Light leak', text: 'A warm film light leak and lens flare blooms across the frame, burns to bright orange, and clears to reveal the second scene.' },
  { id: 'push-through', label: 'Push through', text: 'The camera pushes forward fast through the first scene, through a dark gap, and emerges into the second scene.' },
  { id: 'ink', label: 'Ink bloom', text: 'Dark ink blooms through the frame like smoke in water, swallows the first scene, and recedes to reveal the second.' },
  { id: 'glitch', label: 'Glitch', text: 'A burst of analog video glitch: tracking lines, color channel tearing and static, resolving into the second scene.' },
  { id: 'spin', label: 'Barrel roll', text: 'The camera barrels and spins in a fast roll, the world turns over, and it settles level in the second scene.' },
] as const;
export type TransitionStyleId = (typeof TRANSITION_STYLES)[number]['id'];

/** Extend: what the model is told when the user leaves the prompt empty and the take has none. */
export const CONTINUE_PROMPT = 'The shot continues naturally: same scene, same subject, same light, same camera.';

/** Speak: the default direction when the user gives none. */
export const SPEAK_PROMPT = 'A person speaks to the camera, natural lip movement, subtle head motion and blinking.';

/** Add sound: the default when the user does not describe the sound. */
export const SOUND_PROMPT = 'Natural sound that matches the scene: ambience, movement and every visible action, no music.';

/**
 * Edit app modes. Each one-click image app compiles chip picks into a list of
 * instructions for Qwen-Image-Edit; every instruction becomes one take, shown
 * together as a grid. Free mode is a single instruction run `count` times.
 * Names are ours. The page and the MCP server both call editVariants().
 */
export type EditMode = 'free' | 'angle' | 'coverage' | 'pushin' | 'next' | 'relight' | 'expand';

export interface EditChip { id: string; label: string; text: string }

export interface EditApp {
  id: EditMode;
  name: string;
  blurb: string;
  icon: string;
  /** Motion preset whose rendered clip is the app's cover art. */
  cover: string;
  /** Chips the user picks from; each picked chip is one result (except relight/expand). */
  chips: EditChip[];
  /** Chip ids picked when the app opens. */
  defaults: string[];
  /** Placeholder for the optional text box. */
  hint: string;
}

/**
 * Appended to every recipe so the edit changes only what was asked. Camera
 * chips lead with the Chinese command the Multiple-angles LoRA was trained on
 * (used for New angle and Push in when installed); the English that follows
 * carries the edit on its own when it is not.
 */
const KEEP = 'Keep the same subject, setting, lighting and visual style.';

export const EDIT_APPS: EditApp[] = [
  {
    id: 'free', name: 'Edit', icon: 'wand', cover: 'ink-bloom',
    blurb: 'Say what to change. Add up to two more images to pull things in from.',
    chips: [], defaults: [], hint: 'Replace the sky with a storm front. Keep everything else.',
  },
  {
    id: 'angle', name: 'New angle', icon: 'orbit', cover: 'orbit-right',
    blurb: 'The same scene from a camera somewhere else: orbit, rise, look up, go behind.',
    chips: [
      { id: 'left-45', label: 'Orbit left 45°', text: '将镜头向左旋转45度. Show the same scene photographed from a camera moved around to the left, about 45 degrees, now seeing the subject from its left three-quarter side.' },
      { id: 'right-45', label: 'Orbit right 45°', text: '将镜头向右旋转45度. Show the same scene photographed from a camera moved around to the right, about 45 degrees, now seeing the subject from its right three-quarter side.' },
      { id: 'left-90', label: 'Side on, left', text: '将镜头向左旋转90度. Show the same scene photographed from the left side, the subject seen in profile.' },
      { id: 'right-90', label: 'Side on, right', text: '将镜头向右旋转90度. Show the same scene photographed from the right side, the subject seen in profile.' },
      { id: 'behind', label: 'From behind', text: 'Show the same scene photographed from the opposite side, from behind the subject, looking back the other way.' },
      { id: 'high', label: 'High angle', text: '将镜头转为俯视. Show the same scene photographed from a high vantage point above, looking down at the subject.' },
      { id: 'low', label: 'Low angle', text: 'Show the same scene photographed from ground level, a low camera looking up at the subject.' },
      { id: 'top', label: 'Overhead', text: 'Bird’s-eye view: the same scene photographed from a drone directly above, looking straight down.' },
      { id: 'wide', label: 'Step back', text: '将镜头转为广角镜头. Show the same scene photographed from much farther away, a wide view that reveals the surroundings.' },
    ],
    defaults: ['left-45', 'right-45', 'high', 'low'],
    hint: 'Optional: what the new camera should see, e.g. the door behind her.',
  },
  {
    id: 'coverage', name: 'Coverage', icon: 'grid', cover: 'truck-left',
    blurb: 'Nine shots of one moment: wide to extreme close-up, over the shoulder, high and low.',
    chips: [
      { id: 'establishing', label: 'Establishing', text: 'An establishing extreme wide shot of this scene, the subject small in a vast environment.' },
      { id: 'wide', label: 'Wide', text: 'Pull the camera far back for a wide shot: the main subject small and seen in full, lots of the surrounding space around it.' },
      { id: 'medium', label: 'Medium', text: 'Move the camera closer for a medium shot: the main subject framed from the waist up, filling about half the frame.' },
      { id: 'mcu', label: 'Medium close', text: 'A medium close-up of the main subject, chest up, the background softly out of focus.' },
      { id: 'close', label: 'Close-up', text: 'A close-up of the main subject filling most of the frame.' },
      { id: 'ecu', label: 'Extreme close', text: 'An extreme close-up on one telling detail of the main subject.' },
      { id: 'ots', label: 'Over the shoulder', text: 'An over-the-shoulder shot from behind a figure or object in the foreground, looking at the main subject.' },
      { id: 'low', label: 'Low hero', text: 'Put the camera low near the ground looking steeply up at the main subject, a heroic low-angle shot.' },
      { id: 'high', label: 'High angle', text: 'A high-angle shot looking down on the main subject and its surroundings.' },
    ],
    defaults: ['establishing', 'wide', 'medium', 'mcu', 'close', 'ecu', 'ots', 'low', 'high'],
    hint: 'Optional: anything every shot should keep, e.g. her red coat.',
  },
  {
    id: 'pushin', name: 'Push in', icon: 'search', cover: 'push-in',
    blurb: 'A series that walks the camera toward the subject, frame by frame, down to the detail.',
    chips: [
      { id: 'x1.5', label: '1.5x closer', text: 'Move the camera closer to the main subject, a slightly tighter framing about one and a half times closer.' },
      { id: 'x2', label: '2x closer', text: 'Move the camera closer to the main subject, a tighter framing about twice as close.' },
      { id: 'x4', label: '4x closer', text: '将镜头向前移动. Move the camera much closer to the main subject, a close framing about four times closer.' },
      { id: 'x8', label: 'Detail', text: '将镜头转为特写镜头. Move the camera right up to the main subject for a macro close-up of its surface and fine detail.' },
    ],
    defaults: ['x1.5', 'x2', 'x4', 'x8'],
    hint: 'Optional: what to push in on, e.g. the lantern in his hand.',
  },
  {
    id: 'next', name: 'Next beat', icon: 'film', cover: 'storm',
    blurb: 'What happens next: four continuations of the moment, same world, story moving forward.',
    chips: [
      { id: 'later', label: 'A moment later', text: 'Show the next shot of this story a few seconds later: the main subject has moved to a different spot and is doing a different action, seen in a new composition.' },
      { id: 'arrives', label: 'Something arrives', text: 'Show the next shot of this story: someone or something new has arrived in the scene and the main subject turns to face it, seen in a new composition.' },
      { id: 'turn', label: 'The turn', text: 'Show the turning point of this story: something sudden and dramatic happens and the main subject reacts with a strong gesture, seen in a new composition.' },
      { id: 'after', label: 'Aftermath', text: 'Show a later shot of this story, the quiet aftermath: the main subject alone and still, the place changed by what happened, seen in a new composition.' },
    ],
    defaults: ['later', 'arrives', 'turn', 'after'],
    hint: 'Optional: steer the story, e.g. the storm finally hits the tower.',
  },
  {
    id: 'relight', name: 'Relight', icon: 'light', cover: 'golden',
    blurb: 'Move the light and change its color. Pick a direction and one or more moods.',
    chips: [
      { id: 'golden', label: 'Golden hour', text: 'warm low golden-hour sunlight with long soft shadows' },
      { id: 'blue', label: 'Blue hour', text: 'cool blue-hour twilight, soft and dim, deep blue ambient light' },
      { id: 'moon', label: 'Moonlight', text: 'cold silver moonlight at night, dark surroundings, crisp rim light' },
      { id: 'neon', label: 'Neon', text: 'saturated magenta and cyan neon light spilling across every surface at night' },
      { id: 'candle', label: 'Candlelight', text: 'flickering warm candlelight falling off into darkness' },
      { id: 'overcast', label: 'Overcast', text: 'soft even overcast daylight with no hard shadows' },
      { id: 'noon', label: 'Hard noon', text: 'hard midday sun overhead with crisp black shadows' },
      { id: 'studio', label: 'Studio', text: 'clean three-point studio lighting against a dark background' },
    ],
    defaults: ['golden', 'moon', 'neon', 'overcast'],
    hint: 'Optional: anything else about the light, e.g. lightning in the clouds.',
  },
  {
    id: 'expand', name: 'Expand', icon: 'aspect', cover: 'pull-back',
    blurb: 'Grow the frame to a new aspect, or pull back, and paint in what was outside it.',
    chips: [],
    defaults: [],
    hint: 'Optional: what is beyond the frame, e.g. a harbor town to the right.',
  },
];

export const editAppById = (id: string) => EDIT_APPS.find((a) => a.id === id) ?? EDIT_APPS[0];

/** Where the key light comes from, for Relight. */
export const RELIGHT_DIRECTIONS = [
  { id: 'auto', label: 'Any', text: '' },
  { id: 'left', label: 'From the left', text: 'coming from the left side of the frame' },
  { id: 'right', label: 'From the right', text: 'coming from the right side of the frame' },
  { id: 'back', label: 'Behind', text: 'coming from behind the subject as a strong rim light' },
  { id: 'top', label: 'Above', text: 'coming from directly above' },
  { id: 'front', label: 'Front', text: 'coming from the front, toward the subject' },
  { id: 'below', label: 'Below', text: 'coming from below, lighting the subject from underneath' },
] as const;

/** Target canvases for Expand; `same` keeps the aspect and only pulls back. */
export const EXPAND_ASPECTS = [
  { id: 'same', label: 'Same shape', ratio: 0 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '21:9', label: '21:9', ratio: 21 / 9 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
] as const;

export interface EditVariant { label: string; instruction: string }

export interface EditPicks {
  /** Free mode: the instruction. Other modes: optional steer text. */
  text: string;
  /** Picked chip ids (angle, coverage, pushin, next, relight). */
  chips: string[];
  /** Relight: where the light comes from. */
  direction?: string;
  /** Free and expand: how many takes (each the next seed). */
  count: number;
}

/**
 * Compile an Edit app's picks into one instruction per result. Throws with a
 * readable message when the picks cannot make anything.
 */
export function editVariants(mode: EditMode, p: EditPicks): EditVariant[] {
  const app = editAppById(mode);
  const extra = p.text.trim();
  const finish = (s: string) => compilePrompt([s, extra, KEEP]);
  if (mode === 'free') {
    if (!extra) throw new Error('Say what to change.');
    return Array.from({ length: Math.max(1, Math.min(4, p.count)) }, () => ({ label: extra.slice(0, 60), instruction: compilePrompt([extra]) }));
  }
  if (mode === 'expand') {
    const text = compilePrompt([
      'Zoom out: extend this picture beyond its original edges to fill a larger frame.',
      'Continue the scene seamlessly into the new space around it with matching perspective, light and texture.',
      extra,
      'Keep everything in the original picture exactly as it is.',
    ]);
    return Array.from({ length: Math.max(1, Math.min(4, p.count)) }, () => ({ label: 'Expanded', instruction: text }));
  }
  const picked = app.chips.filter((c) => p.chips.includes(c.id));
  if (!picked.length) throw new Error(`Pick at least one ${mode === 'relight' ? 'mood' : 'option'}.`);
  if (mode === 'relight') {
    const dir = RELIGHT_DIRECTIONS.find((d) => d.id === (p.direction ?? 'auto')) ?? RELIGHT_DIRECTIONS[0];
    return picked.map((c) => ({
      label: c.label,
      instruction: compilePrompt([
        `Relight the scene with ${c.text}${dir.text ? `, the key light ${dir.text}` : ''}`,
        extra,
        'Keep the same subject, composition and every object exactly where it is; change only the lighting, shadows and color of the light.',
      ]),
    }));
  }
  // A story beat has to move the subject, so it only keeps who and how it looks.
  if (mode === 'next') return picked.map((c) => ({ label: c.label, instruction: compilePrompt([c.text, extra, 'Keep the same characters, world and visual style.']) }));
  return picked.map((c) => ({ label: c.label, instruction: finish(c.text) }));
}

/**
 * Cut out (Remove background). Stills always use the soft matte; clips pick a
 * method. Names are ours. The page, the server and the MCP server read these.
 */
export type CutoutMode = 'matte' | 'track' | 'hybrid';
export type CutoutBackground = 'transparent' | 'color' | 'blur' | 'image';

export const CUTOUT_MODES: { id: CutoutMode; label: string; note: string }[] = [
  { id: 'matte', label: 'Soft matte', note: 'Every frame matted on its own, soft edges. Best for most clips.' },
  { id: 'hybrid', label: 'Steady', note: 'The soft matte, kept inside the tracked subject. For busy backgrounds or several people; can clip fast-changing edges.' },
  { id: 'track', label: 'Tracked', note: 'Follows one named thing. Rock steady, hard edges.' },
];

export const CUTOUT_BACKGROUNDS: { id: CutoutBackground; label: string; note: string }[] = [
  { id: 'transparent', label: 'Transparent', note: 'PNG with alpha. Clips: ProRes 4444 with alpha, plus a preview.' },
  { id: 'color', label: 'Color', note: 'A flat color behind the subject.' },
  { id: 'blur', label: 'Blur', note: 'The same background, softly out of focus.' },
  { id: 'image', label: 'Picture', note: 'Put the subject in front of another image.' },
];

export const CUTOUT_COLORS = ['#ffffff', '#000000', '#00b140', '#0047bb', '#f2c14e', '#e8e2d6'] as const;

/** Longest clip a cut out reads, and the longest edge it keeps (ProRes 4444 is large). */
export const CUTOUT_MAX_SECONDS = 20;
export const CUTOUT_MAX_EDGE = 1920;

/** Cut out frame size: the source's own, capped at CUTOUT_MAX_EDGE, even. */
export function cutoutSize(w: number, h: number): { w: number; h: number } {
  if (!w || !h) return { w: 0, h: 0 };
  const s = Math.min(1, CUTOUT_MAX_EDGE / Math.max(w, h));
  return { w: even(w * s), h: even(h * s) };
}

/**
 * Restyle (in Mirror): frame 0 is redrawn in the style, then Mirror carries the
 * source's motion through it. `text` is the look, used both in the edit
 * instruction and in the shot prompt. Names are ours.
 */
export interface RestyleStyle { id: string; label: string; text: string }

export const RESTYLE_STYLES: RestyleStyle[] = [
  { id: 'watercolor', label: 'Watercolor', text: 'a loose watercolor painting on textured paper, soft bleeding washes of color, visible brush strokes and white paper showing through' },
  { id: 'oil', label: 'Oil paint', text: 'a thick impasto oil painting, bold visible brush strokes, rich saturated pigment, canvas texture' },
  { id: 'clay', label: 'Claymation', text: 'a stop-motion claymation scene, everything sculpted from smooth plasticine with fingerprint texture, miniature set lighting' },
  { id: 'anime', label: 'Anime cel', text: 'a hand-drawn 2D anime cel, clean ink outlines, flat cel shading with two-tone shadows, painted background' },
  { id: '3d', label: '3D animated', text: 'a polished 3D animated feature film frame, soft subsurface skin, stylized proportions, warm global illumination' },
  { id: 'pencil', label: 'Pencil sketch', text: 'a graphite pencil sketch on off-white paper, cross-hatched shading, loose construction lines' },
  { id: 'ink', label: 'Comic ink', text: 'a black and white comic book page panel, bold brush ink lines, heavy spot blacks, halftone dot shading' },
  { id: 'charcoal', label: 'Charcoal', text: 'a smudged charcoal drawing, deep soft blacks, rough paper grain, expressive strokes' },
  { id: 'pixel', label: 'Pixel art', text: '16-bit pixel art, a limited palette, crisp square pixels, dithered shading' },
  { id: 'lowpoly', label: 'Low poly', text: 'a low-poly 3D render, flat-shaded triangular facets, simple gradients, clean geometry' },
  { id: 'paper', label: 'Paper cutout', text: 'layered paper cutout craft, cut colored card stock with soft drop shadows between the layers' },
  { id: 'stained', label: 'Stained glass', text: 'a stained glass window, jewel-colored glass panes separated by dark lead lines, light glowing through' },
  { id: 'woodcut', label: 'Woodcut', text: 'a woodcut print, bold carved black lines, rough wood grain texture, two-color ink on paper' },
  { id: 'embroidery', label: 'Embroidery', text: 'a detailed embroidery on linen, every shape stitched in colored thread, visible stitch texture' },
  { id: 'marble', label: 'Marble statue', text: 'everything carved from white veined marble, a museum sculpture, soft gallery light' },
  { id: 'chrome', label: 'Liquid chrome', text: 'everything made of mirror-polished liquid chrome, reflecting a bright studio environment' },
  { id: 'toy', label: 'Plastic toy', text: 'a miniature world of glossy molded plastic toys, tilt-shift depth of field, bright toy colors' },
  { id: 'noir', label: 'Film noir', text: 'a black and white film noir frame, hard single key light, deep shadows, venetian blind light, film grain' },
  { id: 'neon', label: 'Neon night', text: 'a rain-soaked neon city at night, magenta and cyan signs reflecting on every wet surface' },
  { id: 'winter', label: 'Deep winter', text: 'the same place buried in deep snow during a quiet snowfall, frost on every surface, cold blue light' },
  { id: 'thermal', label: 'Thermal camera', text: 'a thermal imaging camera view, warm bodies glowing white and orange against a cold purple and blue background' },
  { id: 'blueprint', label: 'Blueprint', text: 'a technical blueprint drawing, fine white construction lines on deep blue paper, measurements and grid' },
];

export const restyleById = (id: string) => RESTYLE_STYLES.find((s) => s.id === id);

/** The look, from a style chip and/or the user's own words. */
export function restyleLook(styleId: string | null | undefined, text: string): string {
  const style = styleId ? restyleById(styleId) : undefined;
  return compilePrompt([style?.text, text.trim()]);
}

/** What Qwen-Image-Edit is told to do to frame 0. */
export function restyleInstruction(look: string): string {
  return compilePrompt([
    `Redraw this entire image as ${look}`,
    'Keep the exact composition and framing, every person and their pose, and every object in the same place and at the same size.',
  ]);
}

/** What LTX is told the finished shot looks like. */
export function restylePrompt(look: string): string {
  return compilePrompt([`The whole scene rendered as ${look}`, 'Same people, same actions and the same camera movement as the source clip.']);
}

/** Restyle keeps the shape of the scene (depth) or its outlines (edges). Body pose alone loses the world. */
export const RESTYLE_CONTROLS = MIRROR_CONTROLS.filter((c) => c.id !== 'pose');

/** Object swap (in Mirror): what LTX is told fills the masked region. */
export function swapPrompt(replacement: string): string {
  return compilePrompt([replacement, 'It moves naturally with the scene, lit by the same light, filmed by the same camera.']);
}

/**
 * Mirror / Restyle / Object swap working frame for a clip of w x h at a tier
 * (capped at 720p, see APP_MAX_TIER), 64-aligned. IC-LoRA renders fail on a
 * 32-but-not-64 grid (928x512 gives an odd latent grid).
 */
export function mirrorSize(w: number, h: number, tier: RenderTier): { w: number; h: number } {
  return tierSizeOf(capTier(tier, '720p'), w, h, 64);
}

/** Object swap reads at most this much of a clip (the inpaint pass holds every frame). */
export const SWAP_MAX_SECONDS = 8;
