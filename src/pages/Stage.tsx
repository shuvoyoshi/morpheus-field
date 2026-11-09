/**
 * Stage: block a shot in 3D, render it as a finished shot.
 *
 * Place primitive props (or a GLB model) on the ground, give the camera a
 * start and an end (or a preset move), a lens and a length. The page renders
 * the blocking in WebGL as a grey clay clip and an exact depth pass. A look
 * frame made from the depth pass sets the art direction; LTX-2.5 Layout to
 * Render then films the clay with that look. The scene is plain data
 * (src/stage.ts) and every take keeps it, so any Stage take reopens here.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api, inputUrl, mediaUrl, posterUrl, takeAsInput, uploadFile, type StageBlocking, type Take } from '../api';
import { usePageDrop, useDropZone } from '../drop';
import { setParams, useRoute } from '../router';
import { inFeed, isImage, isModel, settingsOf, toast, useStore } from '../store';
import { ChipMenu, Icon, MediaCard, Stepper, Switch, TierChip, fmtSeconds, useEstimate, useTierChoice, RailHandle, useRail } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';
import { MentionBox } from '../Mention';
import {
  CAMERA_MOVES, LENS_MAX, LENS_MIN, MAX_KEYS, MAX_PROPS, PROP_DEFAULTS, STAGE_SECONDS, cleanStageScene, defaultScene,
  describeScene, dropKey, insertKey, keyTimes, lookSize, modelProp, newProp, newPropId, propSpan, retimeKey, sceneKey, snapToFrame, stageFrames, stageSize, stageTier,
  type CameraKey,
  type PropType, type StageAspect, type StageProp, type StageScene, type Vec3,
} from '../stage';
import { StageView, renderBlocking, type ViewMode } from '../stageView';
import type { RenderTier } from '../renderTier';

type LookEngine = 'depth' | 'edit';
/** The look frame: an engine input token, the take it came from, what it was made for, and a note when it was cropped to fit. */
interface Look { token: string; take?: number; key?: string; note?: string }
/** An imported picture, kept so a change of aspect can crop it again. */
interface LookSource { blob: Blob; name: string; take?: number }

const DRAFT_KEY = 'openfield.stage.scene';
const ADD: { type: Exclude<PropType, 'glb'>; icon: string }[] = [
  { type: 'box', icon: 'grid' }, { type: 'cylinder', icon: 'res' }, { type: 'figure', icon: 'person' }, { type: 'wall', icon: 'aspect' }, { type: 'sphere', icon: 'orbit' },
];

/** What a look frame depends on: the set and the camera at the first frame. */
const lookKeyOf = (s: StageScene) => sceneKey({ ...s, props: s.props.map((p) => ({ ...p, to: undefined })), keys: [s.keys[0]], seconds: 0, ease: 'linear' } as StageScene);

const loadImage = (url: string) => new Promise<HTMLImageElement>((res, rej) => {
  const img = new Image();
  img.onload = () => res(img);
  img.onerror = () => rej(new Error('That picture could not be read'));
  img.src = url;
});

/**
 * An imported picture as a look frame for this aspect. One with the shot's
 * aspect goes up as it is; any other is cropped to the middle at the look
 * frame size, so the render reads exactly what the thumbnail shows.
 */
async function fitLookFrame(src: LookSource, aspect: StageAspect): Promise<{ token: string; note?: string }> {
  const ls = lookSize(aspect);
  const url = URL.createObjectURL(src.blob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const want = ls.w / ls.h;
    if (!w || !h) throw new Error('That picture has no size');
    if (Math.abs(w / h / want - 1) < 0.01) return { token: await uploadFile(new File([src.blob], src.name, { type: src.blob.type || 'image/png' })) };
    const sw = w / h > want ? h * want : w, sh = w / h > want ? h : w / want;
    const c = document.createElement('canvas');
    c.width = ls.w; c.height = ls.h;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, ls.w, ls.h);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not crop the picture'))), 'image/png'));
    const token = await uploadFile(new File([blob], src.name.replace(/\.[^.]+$/, '') + `_${aspect.replace(':', 'x')}.png`, { type: 'image/png' }));
    return { token, note: `The picture is ${w}x${h}, so it was cropped to the middle to fit the ${aspect} shot.` };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadDraft(): StageScene | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? cleanStageScene(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export default function StagePage() {
  const { params } = useRoute();
  const fromTake = Number(params.get('take')) || null;
  const fromProp = Number(params.get('prop')) || null;
  const fromLook = Number(params.get('look')) || null;
  const [scene, setScene] = useState<StageScene>(() => loadDraft() ?? defaultScene());
  const [mode, setMode] = useState<ViewMode>('set');
  const [key, setKey] = useState<number | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  // Render size: the machine-wide tier (Setup) until picked here, held at Stage's 720p cap.
  const [res, setRes] = useTierChoice('stage');
  const [lookEngine, setLookEngine] = useState<LookEngine>('depth');
  const [look, setLook] = useState<Look | null>(null);
  const [lookCount, setLookCount] = useState(2);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [waitLook, setWaitLook] = useState<number[]>([]);
  const [framed, setFramed] = useState(false);
  const [library, setLibrary] = useState(false);
  const lookSource = useRef<LookSource | null>(null);
  const lookInput = useRef<HTMLInputElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<StageView | null>(null);
  const blocked = useRef<{ key: string; b: StageBlocking } | null>(null);
  const glbInput = useRef<HTMLInputElement>(null);

  const size = stageSize(scene.aspect, res);
  const ls = lookSize(scene.aspect);
  const frames = stageFrames(scene.seconds);
  /** One frame, as a shot-time fraction: the snap and the smallest gap between keys. */
  const gap = 1 / Math.max(1, frames - 1);
  const times = useMemo(() => keyTimes(scene), [scene.keys, scene.ease]);
  const prop = scene.props.find((p) => p.id === picked) ?? null;
  const lookKey = lookKeyOf(scene);
  const lookStale = !!look?.key && look.key !== lookKey;
  const est = useEstimate({ kind: 'video', model: 'stage', w: size.w, h: size.h, seconds: scene.seconds });

  // ---------- the viewport ----------

  useEffect(() => {
    if (!host.current) return;
    const v = new StageView(host.current, {
      onMoveProp: (id, at, end) => setScene((s) => ({ ...s, props: s.props.map((p) => (p.id === id ? (end ? { ...p, to: at } : { ...p, pos: at }) : p)) })),
      onSelect: setPicked,
      onFrame: setFramed,
    });
    view.current = v;
    return () => { v.dispose(); view.current = null; };
  }, []);
  useEffect(() => { view.current?.setScene(scene); }, [scene]);
  useEffect(() => { view.current?.setTime(t); }, [t]);
  useEffect(() => { view.current?.setMode(mode); }, [mode]);
  useEffect(() => { view.current?.selectKey(key); }, [key]);
  useEffect(() => { view.current?.select(picked); }, [picked]);

  // Keep the draft across reloads (per browser).
  useEffect(() => {
    const id = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(scene)); } catch { /* private window */ } }, 400);
    return () => clearTimeout(id);
  }, [scene]);

  // Play the move.
  useEffect(() => {
    if (!playing) return;
    setKey(null);
    view.current?.resetFrame();
    let raf = 0;
    const t0 = performance.now() - t * scene.seconds * 1000;
    const tick = (now: number) => {
      const u = ((now - t0) / (scene.seconds * 1000)) % 1;
      setT(u);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, scene.seconds]);

  // Keys (outside text fields, with no take open): K adds a camera key at the playhead,
  // Delete removes the picked prop or else the selected key, [ and ] jump between keys.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      if (viewing !== null || e.ctrlKey || e.metaKey || e.altKey) return;
      if (tag === 'TEXTAREA' || el?.isContentEditable || (tag === 'INPUT' && (el as HTMLInputElement).type !== 'range')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (picked) { e.preventDefault(); removeProp(picked); }
        else if (key !== null) { e.preventDefault(); removeKey(key); }
      } else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); addKeyAtPlayhead(); }
      else if (e.key === '[') { e.preventDefault(); jumpKey(-1); }
      else if (e.key === ']') { e.preventDefault(); jumpKey(1); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // ---------- open a Stage take: its set, its words, its look ----------

  const allTakes = useStore((s) => s.takes);
  const models = useMemo(() => allTakes.filter((x) => isModel(x) && x.status === 'done').slice(0, 40), [allTakes]);
  useEffect(() => {
    if (!fromTake) return;
    const tk = allTakes.find((x) => x.id === fromTake);
    if (!tk) return;
    const s = settingsOf(tk);
    setParams({ take: null });
    if (s.app !== 'stage' || !s.scene) { toast('That take was not made in Stage', true); return; }
    void (async () => {
      try {
        const sc = cleanStageScene(s.scene);
        setScene(sc);
        setPrompt(s.castSource ?? s.userPrompt ?? s.prompt ?? '');
        const tier = stageTier(s.resolution) ?? stageTier(s.quality);
        if (tier) setRes(tier);
        if (s.engine === 'edit' || s.lookEngine === 'edit') setLookEngine('edit');
        setPicked(null); setKey(null); setT(0); setMode('set');
        lookSource.current = null;
        view.current?.resetFrame();
        if (isImage(tk) && tk.status === 'done') setLook({ token: await takeAsInput(tk.id), take: tk.id, key: lookKeyOf(sc) });
        else if (s.lookImage) setLook({ token: s.lookImage, take: s.lookTake, key: lookKeyOf(sc) });
        toast(`Loaded the set from take ${tk.id}`);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'could not load that set', true);
      }
    })();
  }, [fromTake, allTakes.length > 0]);

  // Use in Stage (Viewer, on an Object take): place its GLB in the set.
  useEffect(() => {
    if (!fromProp) return;
    const tk = allTakes.find((x) => x.id === fromProp);
    if (!tk) return;
    setParams({ prop: null });
    if (!isModel(tk) || tk.status !== 'done') { toast('That take is not a finished 3D model', true); return; }
    addModel(tk);
  }, [fromProp, allTakes.length > 0]);

  // Use as Stage look frame (Viewer, on any still): /stage?look=<take>.
  useEffect(() => {
    if (!fromLook) return;
    const tk = allTakes.find((x) => x.id === fromLook);
    if (!tk) return;
    setParams({ look: null });
    if (!isImage(tk) || tk.status !== 'done') { toast('That take is not a finished still', true); return; }
    void lookFromTake(tk);
  }, [fromLook, allTakes.length > 0]);

  // An imported look frame is cropped again when the aspect changes.
  useEffect(() => {
    const src = lookSource.current;
    if (!src || !look) return;
    void importLook(src, false);
  }, [scene.aspect]);

  // A look frame being made becomes the look as soon as the first one lands.
  useEffect(() => {
    if (!waitLook.length) return;
    const done = allTakes.find((x) => waitLook.includes(x.id) && x.status === 'done');
    if (done) {
      setWaitLook([]);
      lookSource.current = null;
      void takeAsInput(done.id).then((token) => setLook({ token, take: done.id, key: settingsOf(done).lookKey }));
    } else if (waitLook.every((id) => { const x = allTakes.find((y) => y.id === id); return x && x.status !== 'queued' && x.status !== 'rendering'; })) setWaitLook([]);
  }, [allTakes, waitLook]);

  // ---------- editing ----------

  const patchProp = (id: string, patch: Partial<StageProp>) => setScene((s) => ({ ...s, props: s.props.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  function removeProp(id: string) {
    setScene((s) => ({ ...s, props: s.props.filter((p) => p.id !== id) }));
    if (picked === id) setPicked(null);
  }
  function addProp(type: Exclude<PropType, 'glb'>) {
    if (scene.props.length >= MAX_PROPS) { toast(`Up to ${MAX_PROPS} props`, true); return; }
    const aim = scene.keys[0].target;
    const at: Vec3 = [Math.round((aim[0] + (Math.random() * 2 - 1) * 1.5) * 10) / 10, 0, Math.round((aim[2] + (Math.random() * 2 - 1) * 1.5) * 10) / 10];
    const p = newProp(type, at);
    setScene((s) => ({ ...s, props: [...s.props, p] }));
    setPicked(p.id);
  }
  async function addGlb(f: File) {
    try {
      setBusy('Adding the model');
      const token = await uploadFile(new File([f], f.name, { type: 'model/gltf-binary' }));
      const aim = scene.keys[0].target;
      const p: StageProp = { id: newPropId(), type: 'glb', pos: [aim[0], 0, aim[2]], size: [1.5, 1.5, 1.5], rot: 0, asset: token, label: f.name.replace(/\.glb$/i, '').slice(0, 40) };
      setScene((s) => ({ ...s, props: [...s.props, p] }));
      setPicked(p.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not add the model', true);
    } finally {
      setBusy(null);
    }
  }
  /** A model from the 3D library (an Object take), loaded by its take id. */
  function addModel(tk: Take) {
    if (scene.props.length >= MAX_PROPS) { toast(`Up to ${MAX_PROPS} props`, true); return; }
    const aim = scene.keys[0].target;
    const p = modelProp(tk.id, modelName(tk), [aim[0], 0, aim[2]]);
    setScene((s) => ({ ...s, props: [...s.props, p] }));
    setPicked(p.id);
    setMode('set');
    toast(`Added ${p.label} to the set`);
  }
  /** A preset fills the keys from the first one (evenly spread); editing them after makes the move Custom. */
  function applyMove(id: string) {
    const m = CAMERA_MOVES.find((x) => x.id === id)!;
    const first: CameraKey = { pos: scene.keys[0].pos, target: scene.keys[0].target };
    setScene((s) => ({ ...s, keys: m.make(first).map((k) => ({ pos: k.pos, target: k.target })), move: m.id }));
    setKey(null);
    view.current?.resetFrame();
    setPlaying(true);
  }
  const setKeys = (keys: CameraKey[]) => setScene((s) => ({ ...s, keys, move: 'custom' }));
  /** Select key i: the playhead goes to it and the Camera view looks through it. */
  function pickKey(i: number, look = true) {
    setPlaying(false);
    setPicked(null);
    if (look) setMode('shot');
    setKey(i);
    setT(times[i]);
    view.current?.resetFrame();
  }
  /** Scrub: the playhead moves, the view follows the path, and a key under the playhead is selected. */
  function scrub(u: number) {
    setPlaying(false);
    setT(u);
    view.current?.resetFrame();
    const hit = times.findIndex((x) => Math.abs(x - u) < gap / 2);
    setKey(hit >= 0 ? hit : null);
  }
  /** A new key at the playhead (snapped to a frame), holding the view as it is now. */
  function addKeyAtPlayhead() {
    if (scene.keys.length >= MAX_KEYS) { toast(`Up to ${MAX_KEYS} camera keys`, true); return; }
    const at = snapToFrame(t, frames);
    const cam = view.current?.currentView();
    if (!cam) return;
    const r = insertKey(scene, at, cam, gap * 0.999);
    if (!r) {
      const on = times.findIndex((x) => Math.abs(x - at) < gap);
      if (on >= 0) { pickKey(on, false); toast(`Key ${on + 1} is at the playhead already. Frame the shot, then Set key from this view.`); }
      return;
    }
    setPlaying(false);
    setKeys(r.keys);
    setKey(r.index);
    setT(at);
    view.current?.resetFrame();
    toast(`Added key ${r.index + 1} at ${(at * scene.seconds).toFixed(1)}s`);
  }
  /** Store the Camera view into the selected key. */
  function setKeyFromView() {
    if (key === null) { toast('Pick a key first, or Add key at playhead', true); return; }
    const cam = view.current?.currentView();
    if (!cam) return;
    setKeys(scene.keys.map((k, j) => (j === key ? { ...k, pos: cam.pos, target: cam.target } : k)));
    view.current?.resetFrame();
    toast(`Key ${key + 1} set from this view`);
  }
  function removeKey(i: number) {
    if (scene.keys.length <= 2) { toast('The camera needs at least two keys', true); return; }
    setKeys(dropKey(scene, i));
    setKey(null);
    view.current?.resetFrame();
  }
  /** [ and ]: the key before or after the playhead. */
  function jumpKey(dir: 1 | -1) {
    const eps = gap / 2;
    const i = dir > 0 ? times.findIndex((x) => x > t + eps) : times.map((x, j) => (x < t - eps ? j : -1)).filter((j) => j >= 0).pop() ?? -1;
    if (i >= 0) pickKey(i, false);
  }
  /** Drag a key's diamond to retime it (snapped to frames, kept between its neighbours); a click selects it. */
  function dragKey(e: ReactPointerEvent, i: number) {
    e.preventDefault();
    const box = lane.current?.getBoundingClientRect();
    if (!box) return;
    const x0 = e.clientX;
    let moved = false;
    const at = (x: number) => snapToFrame((x - box.left) / box.width, frames);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (i === 0 || i === scene.keys.length - 1) return;
      moved = true;
      // Only key i moves during the drag, so the keys at drag start are the ones to retime.
      const keys = retimeKey(scene, i, at(ev.clientX), gap * 0.999);
      setScene((s) => ({ ...s, keys, move: 'custom' }));
      setPlaying(false); setKey(i); setT(keys[i].t!);
      view.current?.resetFrame();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) pickKey(i);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  /** Drag one end of the picked prop's move on the timeline. */
  function dragSpan(e: ReactPointerEvent, id: string, end: 0 | 1) {
    e.preventDefault();
    e.stopPropagation();
    const box = lane.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) => {
      const u = snapToFrame((ev.clientX - box.left) / box.width, frames);
      setScene((s) => ({
        ...s, props: s.props.map((p) => {
          if (p.id !== id) return p;
          const sp = [...propSpan(p)] as [number, number];
          sp[end] = end === 0 ? Math.min(u, sp[1] - gap) : Math.max(u, sp[0] + gap);
          sp[end] = Math.max(0, Math.min(1, sp[end]));
          return { ...p, span: sp[0] <= 0 && sp[1] >= 1 ? undefined : sp };
        }),
      }));
      setPlaying(false); setT(u);
      view.current?.resetFrame();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- rendering ----------

  /** The blocking for the current set at this size, rendered and uploaded once. */
  async function blockingFor(q: RenderTier): Promise<StageBlocking> {
    const k = sceneKey(scene, q);
    if (blocked.current?.key === k) return blocked.current.b;
    const sz = stageSize(scene.aspect, q);
    const n = stageFrames(scene.seconds);
    setBusy(`Drawing the blocking 0/${n}`);
    const f = await renderBlocking(scene, sz, n, lookSize(scene.aspect), (d, total) => setBusy(`Drawing the blocking ${d}/${total}`));
    setBusy('Sending the blocking');
    const b = await api.stageBlocking({ width: f.width, height: f.height, clay: f.clay, depth: f.depth, clayStill: f.clayStill, depthStill: f.depthStill });
    blocked.current = { key: k, b };
    return b;
  }

  async function makeLook() {
    try {
      const b = await blockingFor(res);
      setBusy('Queuing the look frame');
      const body = {
        kind: 'stage-look', app: 'stage', mode: 'look', engine: lookEngine, prompt, userPrompt: prompt, scene, resolution: res, lookKey,
        depthImage: b.depthImage, clayImage: b.clayImage, width: ls.w, height: ls.h, count: lookCount,
        shotName: `${(prompt || describeScene(scene)).slice(0, 34)}_look`,
      };
      const r = await api.generate(body);
      setWaitLook(r.takeIds);
      toast(`Making ${r.takeIds.length} look frame${r.takeIds.length > 1 ? 's' : ''}. The first one becomes the look.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  async function go() {
    try {
      const b = await blockingFor(res);
      setBusy('Queuing the shot');
      const body = {
        kind: 'stage', app: 'stage', videoModel: 'stage', prompt, userPrompt: prompt, scene, resolution: res, lookEngine,
        clayVideo: b.clayVideo, depthVideo: b.depthVideo, depthImage: b.depthImage, clayImage: b.clayImage,
        lookImage: look?.token, lookTake: look?.take, lookWidth: ls.w, lookHeight: ls.h,
        width: size.w, height: size.h, seconds: scene.seconds, frames, count,
        shotName: (prompt || describeScene(scene)).slice(0, 40),
      };
      const r = await api.generate(body);
      toast(look ? `Rendering ${r.takeIds.length} shot${r.takeIds.length > 1 ? 's' : ''}` : 'Making a look frame first, then the shot');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  /** An imported picture becomes the look frame, cropped to the shot's aspect when it differs. */
  async function importLook(src: LookSource, announce = true) {
    try {
      setBusy('Adding the look frame');
      const r = await fitLookFrame(src, scene.aspect);
      lookSource.current = src;
      setLook({ token: r.token, take: src.take, key: lookKeyOf(scene), note: r.note });
      setLibrary(false);
      if (announce) toast(r.note ? 'Look frame added, cropped to fit the shot' : 'Look frame added');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not add the look frame', true);
    } finally {
      setBusy(null);
    }
  }
  async function lookFromFile(f: File) {
    if (!f.type.startsWith('image/')) { toast('A look frame is an image', true); return; }
    await importLook({ blob: f, name: f.name });
  }
  /** A still from the library. A Stage look frame made for this set keeps its own staleness key. */
  async function lookFromTake(x: Take) {
    try {
      const blob = await (await fetch(mediaUrl(x.id))).blob();
      await importLook({ blob, name: `take_${x.id}.png`, take: x.id });
      const k = settingsOf(x).app === 'stage' ? settingsOf(x).lookKey : undefined;
      if (k) setLook((l) => (l && l.take === x.id ? { ...l, key: k } : l));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not load that still', true);
    }
  }
  function clearLook() { setLook(null); lookSource.current = null; }
  const lookDrop = useDropZone((files) => void lookFromFile(files[0]));
  usePageDrop('Drop an image for the look frame, or a .glb model to add it as a prop', (files) => {
    const glb = files.find((f) => /\.glb$/i.test(f.name));
    if (glb) { void addGlb(glb); return; }
    const img = files.find((f) => f.type.startsWith('image/'));
    if (img) void lookFromFile(img);
    else toast('Stage takes an image (the look frame) or a .glb model', true);
  });

  // ---------- takes ----------

  const takes = useStore((s) => s.takes.filter((x) => inFeed(x) && settingsOf(x).app === 'stage'));
  const done = takes.filter((x) => x.status === 'done');
  const step = (dir: 1 | -1) => {
    const i = done.findIndex((x) => x.id === viewing);
    const nx = done[(i + dir + done.length) % done.length];
    if (nx) setViewing(nx.id);
  };
  const useAsLook = (x: Take) => lookFromTake(x);
  const stills = useMemo(() => allTakes.filter((x) => isImage(x) && x.status === 'done' && x.output_path).slice(0, 12), [allTakes]);

  const keyName = (i: number) => `Key ${i + 1}`;
  const secs = (u: number) => `${(u * scene.seconds).toFixed(1)}s`;
  const moveName = scene.move === 'custom' ? 'Custom' : CAMERA_MOVES.find((m) => m.id === scene.move)?.name;
  const moving = prop?.to ? prop : null;

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout stage-page ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="display" style={{ fontSize: 26 }}>Stage</div>
          <TierChip app="stage" value={res} onChange={setRes} />
        </div>

        <div className="rail-section">
          <div className="label">The shot</div>
          <MentionBox className="prompt" rows={3} value={prompt} onChange={setPrompt}
            placeholder="What the finished shot looks like. Example: a night market under paper lanterns, wet stone, @Mara in a rust coat by the stall. Type @ for your cast." />
        </div>

        <div className="rail-section">
          <div className="label">Camera move{moveName ? ` · ${moveName}` : ''}</div>
          <div className="chip-row">
            {CAMERA_MOVES.map((m) => <button key={m.id} type="button" className={`chip ${scene.move === m.id ? 'on' : ''}`} onClick={() => applyMove(m.id)} title={`Fill the keys from key 1: ${m.name.toLowerCase()}`}>{m.name}</button>)}
            {scene.move === 'custom' && <span className="chip on" title="The keys were edited by hand">Custom</span>}
          </div>
        </div>

        <div className="rail-section">
          <div className="label">Camera keys · {scene.keys.length}</div>
          <div className="stage-keystrip" role="listbox" aria-label="camera keys">
            {scene.keys.map((_, i) => (
              <button key={i} type="button" role="option" aria-selected={key === i} className={`stage-keycard ${key === i ? 'on' : ''}`} onClick={() => pickKey(i)} title={`Go to ${keyName(i).toLowerCase()} and look through it`}>
                <span className="stage-diamond" aria-hidden />
                <b>{keyName(i)}</b>
                <small className="mono">{secs(times[i])}</small>
              </button>
            ))}
          </div>
          <div className="chip-row">
            <button type="button" className="btn sm" onClick={addKeyAtPlayhead} disabled={scene.keys.length >= MAX_KEYS} title="A new key at the playhead, holding the Camera view as it is now (K)"><Icon name="plus" size={13} />Add key at playhead</button>
            <button type="button" className={`btn sm ${framed && key !== null ? 'accent' : ''}`} onClick={setKeyFromView} disabled={key === null} title={key === null ? 'Pick a key first' : `Store the Camera view into ${keyName(key).toLowerCase()}`}><Icon name="camera" size={13} />Set key from this view</button>
            <button type="button" className="btn sm ghost" onClick={() => key !== null && removeKey(key)} disabled={key === null || scene.keys.length <= 2} title="Delete the selected key (Delete)"><Icon name="trash" size={13} />Delete key</button>
          </div>
          <div className="dim stage-hint">Pick a key, frame the shot in the Camera view, then Set key from this view.</div>
          <div className="dim stage-hint mono">K add key · Delete remove · [ ] previous and next key</div>
          <label className="stage-slider">
            <span className="dim">Lens</span>
            <input type="range" min={LENS_MIN} max={LENS_MAX} step={1} value={scene.lens} onChange={(e) => setScene({ ...scene, lens: Number(e.target.value) })} aria-label="focal length" />
            <span className="mono">{scene.lens}mm</span>
          </label>
          <div className="chip-row">
            <ChipMenu icon="clock" value={scene.seconds} onChange={(v) => setScene({ ...scene, seconds: v })} title="Length" options={STAGE_SECONDS.map((d) => ({ value: d as number, label: `${d}s`, note: `${stageFrames(d)} frames` }))} />
            <ChipMenu icon="aspect" value={scene.aspect} onChange={(v: StageAspect) => { setScene({ ...scene, aspect: v }); }} title="Aspect" options={(['16:9', '9:16', '1:1'] as StageAspect[]).map((a) => ({ value: a, label: a }))} />
            <span className="chip" style={{ gap: 10 }} title="Start and land the move gently"><Icon name="bolt" size={14} />Ease <Switch on={scene.ease === 'smooth'} onChange={(v) => setScene({ ...scene, ease: v ? 'smooth' : 'linear' })} label="ease the move" /></span>
          </div>
        </div>

        <div className="rail-section">
          <div className="label">Props · {scene.props.length}</div>
          <div className="chip-row">
            {ADD.map((a) => <button key={a.type} type="button" className="chip" onClick={() => addProp(a.type)}><Icon name={a.icon} size={13} />{PROP_DEFAULTS[a.type].label}</button>)}
            <button type="button" className="chip" onClick={() => glbInput.current?.click()} title="A .glb model, shown in the set and drawn into the clay"><Icon name="plus" size={13} />Model</button>
            <input ref={glbInput} type="file" accept=".glb,model/gltf-binary" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void addGlb(f); e.target.value = ''; }} />
            <ChipMenu icon="cube" value={0} title="From your 3D library" onChange={(id: number) => { const tk = models.find((x) => x.id === id); if (tk) addModel(tk); }}
              options={[{ value: 0, label: '3D library', disabled: true, note: models.length ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'none yet: Make 3D on a still' },
                ...models.map((x) => ({ value: x.id, label: modelName(x), note: `take ${x.id}` }))]} />
          </div>
          <div className="stage-props">
            {scene.props.map((p) => (
              <button key={p.id} type="button" className={`stage-prop ${p.id === picked ? 'on' : ''}`} onClick={() => setPicked(p.id === picked ? null : p.id)}>
                <span>{p.label ?? p.type}</span><small className="dim">{p.to ? 'moves' : `${p.size[1]}m`}</small>
              </button>
            ))}
          </div>
          {prop && <PropEditor prop={prop} seconds={scene.seconds} onPatch={(patch) => patchProp(prop.id, patch)} onRemove={() => removeProp(prop.id)} onSeek={(u) => scrub(u)} />}
        </div>

        <div className="rail-section">
          <div className="label">Look frame</div>
          <input ref={lookInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void lookFromFile(f); e.target.value = ''; }} />
          {look ? (
            <div className={`ref stage-look ${lookDrop.over ? 'drag' : ''}`} {...lookDrop.props} style={{ aspectRatio: `${ls.w} / ${ls.h}` }}>
              <img src={inputUrl(look.token)} alt="the look frame" />
              <span className="role start">look{look.take ? ` · take ${look.take}` : ''}</span>
              <button type="button" className="x" onClick={clearLook} aria-label="remove the look frame" title="Remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <div className={`well stage-lookwell ${lookDrop.over ? 'drag' : ''}`} {...lookDrop.props} role="button" tabIndex={0}
              onClick={() => lookInput.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lookInput.current?.click(); } }}>
              <div className="well-icons"><span><Icon name="image" /></span></div>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>{waitLook.length ? 'Making the look frame...' : 'Add a look frame'}</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>Click to pick a picture or drop one here. It sets the palette, light and materials; the blocking sets where things are.</div>
            </div>
          )}
          {look?.note && <div className="dim stage-hint">{look.note}</div>}
          {lookStale && <div className="dim" style={{ fontSize: 12, color: 'var(--accent-hi)' }}>The set or the first key changed since this look frame. Where they disagree, the shot follows the look frame.</div>}
          <div className="chip-row">
            {look && <button type="button" className="btn sm" onClick={() => lookInput.current?.click()} disabled={!!busy}><Icon name="image" size={13} />Replace</button>}
            <button type="button" className={`btn sm ${library ? 'on' : ''}`} onClick={() => setLibrary(!library)} aria-expanded={library}><Icon name="grid" size={13} />From your library</button>
          </div>
          {library && (stills.length ? (
            <div className="src-strip" aria-label="your stills">
              {stills.map((x) => (
                <button key={x.id} type="button" title={`Use take ${x.id} as the look frame`} disabled={!!busy} onClick={() => void lookFromTake(x)}>
                  <img src={posterUrl(x.id)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          ) : <div className="dim stage-hint">No stills yet. Make one in Image, or Make look frame below.</div>)}
          <div className="chip-row">
            <ChipMenu icon="image" value={lookEngine} onChange={setLookEngine} title="Look frame from" options={[
              { value: 'depth', label: 'Depth lock', note: 'Z-Image Turbo reads the depth pass' },
              { value: 'edit', label: 'Clay edit', note: 'Qwen-Image-Edit repaints the clay frame, cast pictures included' },
            ]} />
            <Stepper value={lookCount} min={1} max={4} onChange={setLookCount} fmt={(v) => `${v}/4`} />
            <button type="button" className="btn sm" disabled={!!busy || waitLook.length > 0} onClick={() => void makeLook()}><Icon name="sparkle" size={13} />Make look frame</button>
          </div>
        </div>

        <div className="chip-row">
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
          <span className="dim" style={{ fontSize: 12 }}>{size.w}x{size.h} · {frames} frames at 24 fps</span>
        </div>
        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy} onClick={() => void go()}>
          <span>{busy ?? (look ? 'Render shot' : 'Make the look, then render')}</span>
          <span className="cost">{res}{est ? ` · ${fmtSeconds(est * count)}` : ''}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className={mode === 'set' ? 'on' : ''} onClick={() => setMode('set')}>Set</button>
            <button type="button" className={mode === 'shot' ? 'on' : ''} onClick={() => setMode('shot')}>Camera</button>
          </div>
          <span className="dim" style={{ fontSize: 12 }}>
            {mode === 'set' ? 'Drag a prop to move it. Drag empty ground to orbit, right-drag to pan, scroll to zoom.'
              : framed ? (key !== null ? `Framed by hand. Set key from this view to store it in ${keyName(key).toLowerCase()}, or Add key at playhead.` : 'Framed by hand. Add key at playhead to keep it.')
              : `Through the lens at ${secs(t)}${key !== null ? `, on ${keyName(key).toLowerCase()}` : ''}. Drag to swing, right-drag to slide, scroll to move in. Props move in the Set view.`}
          </span>
          {framed && <button type="button" className="btn sm ghost" onClick={() => view.current?.resetFrame()} title="Drop the hand framing and follow the camera path">Back to the path</button>}
        </div>
        <div className="canvas-body stage-body">
          <div className="stage-viewport" ref={host} />
          <div className="stage-timeline">
            <button type="button" className="icon-btn" onClick={() => setPlaying(!playing)} aria-label={playing ? 'pause' : 'play'}><Icon name={playing ? 'stop' : 'video'} size={14} /></button>
            <div className="stage-scrub">
              <div className="stage-lane" ref={lane}>
                {moving && (() => {
                  const [a, b] = propSpan(moving);
                  return (
                    <div className="stage-span" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} title={`${moving.label ?? moving.type} moves from ${secs(a)} to ${secs(b)}`}>
                      <span className="stage-span-end" onPointerDown={(e) => dragSpan(e, moving.id, 0)} title="Drag: when the move starts" />
                      <span className="stage-span-name">{moving.label ?? moving.type}</span>
                      <span className="stage-span-end" onPointerDown={(e) => dragSpan(e, moving.id, 1)} title="Drag: when the move ends" />
                    </div>
                  );
                })()}
                {times.map((kt, i) => (
                  <button key={i} type="button" className={`stage-tick ${key === i ? 'on' : ''} ${i === 0 || i === scene.keys.length - 1 ? 'pinned' : ''}`} style={{ left: `${kt * 100}%` }}
                    onPointerDown={(e) => dragKey(e, i)} aria-label={`${keyName(i)} at ${secs(kt)}`}
                    title={`${keyName(i)} at ${secs(kt)}${i === 0 || i === scene.keys.length - 1 ? '' : '. Drag to retime'}`} />
                ))}
              </div>
              <input type="range" min={0} max={frames - 1} step={1} value={Math.round(t * (frames - 1))} onChange={(e) => scrub(Number(e.target.value) / (frames - 1))} aria-label="shot time" />
            </div>
            <span className="mono dim" style={{ fontSize: 12, minWidth: 76, textAlign: 'right' }}>{secs(t)} / {scene.seconds}s</span>
          </div>
          {takes.length === 0 ? (
            <div className="steps3" style={{ marginTop: 22 }}>
              <div><span className="label">01</span><b>Block the set</b><span className="dim">Drop in boxes, pillars, figures and walls. Give the camera keys along the timeline and a lens.</span></div>
              <div><span className="label">02</span><b>Make a look frame</b><span className="dim">One picture of the first frame, drawn on the set's own depth. It sets the look.</span></div>
              <div><span className="label">03</span><b>Render</b><span className="dim">The camera move and the layout come from the blocking, the light and materials from the look.</span></div>
            </div>
          ) : (
            <>
              <div className="label" style={{ margin: '22px 0 10px' }}>Takes</div>
              <div className="grid">
                {takes.map((x) => (
                  <MediaCard key={x.id} take={x} onOpen={() => setViewing(x.id)} pendingLabel={settingsOf(x).app === 'stage' && !x.prompt_id && x.kind === 'video' ? 'Waiting for the look frame' : undefined} actions={<>
                    {isImage(x) && x.status === 'done' && <button type="button" className="icon-btn" title="Use as the look frame" onClick={() => void useAsLook(x)}><Icon name="ref" size={14} /></button>}
                    <button type="button" className="icon-btn" title="Load this set" onClick={() => setParams({ take: String(x.id) })}><Icon name="grid" size={14} /></button>
                    <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(x)}><Icon name="redo" size={14} /></button>
                    <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(x)}><Icon name="trash" size={14} /></button>
                  </>} />
                ))}
              </div>
            </>
          )}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
    </div>
  );
}

/** Size, turn, height and motion of the picked prop. */
function PropEditor({ prop: p, seconds, onPatch, onRemove, onSeek }: { prop: StageProp; seconds: number; onPatch: (patch: Partial<StageProp>) => void; onRemove: () => void; onSeek: (t: number) => void }) {
  const [a, b] = propSpan(p);
  const big = p.type === 'wall' ? 30 : 12;
  const dim = (i: 0 | 1 | 2, v: number) => { const size = [...p.size] as Vec3; size[i] = v; onPatch({ size }); };
  const row = (label: string, value: number, min: number, max: number, stepv: number, set: (v: number) => void, unit = 'm') => (
    <label className="stage-slider">
      <span className="dim">{label}</span>
      <input type="range" min={min} max={max} step={stepv} value={value} onChange={(e) => set(Number(e.target.value))} aria-label={label} />
      <span className="mono">{value}{unit}</span>
    </label>
  );
  return (
    <div className="stage-editor">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="stage-name" value={p.label ?? ''} placeholder={p.type} maxLength={40} onChange={(e) => onPatch({ label: e.target.value })} aria-label="prop name" />
        <button type="button" className="icon-btn" title="Remove the prop (Delete)" onClick={onRemove}><Icon name="trash" size={13} /></button>
      </div>
      {row('Width', p.size[0], 0.1, big, 0.05, (v) => dim(0, v))}
      {row('Height', p.size[1], 0.1, 20, 0.05, (v) => dim(1, v))}
      {row('Depth', p.size[2], 0.05, big, 0.05, (v) => dim(2, v))}
      {row('Turn', p.rot, -180, 180, 1, (v) => onPatch({ rot: v }), '°')}
      {row('Lift', p.pos[1], 0, 10, 0.05, (v) => onPatch({ pos: [p.pos[0], v, p.pos[2]], ...(p.to ? { to: [p.to[0], v, p.to[2]] as Vec3 } : {}) }))}
      <div className="era-grade">
        <span className="dim">Moves during the shot</span>
        <Switch on={!!p.to} onChange={(v) => onPatch(v ? { to: [Math.round((p.pos[0] + 1.5) * 100) / 100, p.pos[1], p.pos[2]] } : { to: undefined, span: undefined })} label="moves during the shot" />
      </div>
      {p.to && <>
        <div className="dim stage-hint">Moves from {(a * seconds).toFixed(1)}s to {(b * seconds).toFixed(1)}s. Drag the ends of its bar on the timeline to change when. Drag the prop at the start to place where it starts, at the end to place where it ends.</div>
        <div className="chip-row">
          <button type="button" className="btn sm" onClick={() => onSeek(a)}>Go to start</button>
          <button type="button" className="btn sm" onClick={() => onSeek(b)}>Go to end</button>
        </div>
      </>}
    </div>
  );
}

/** A short name for an Object take in the prop list. */
function modelName(t: Take): string {
  const s = settingsOf(t);
  const name = (s.shotName || t.shot_name || s.sourceName || '').toString().trim();
  return (name || `model ${t.id}`).slice(0, 40);
}
