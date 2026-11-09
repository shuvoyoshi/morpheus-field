/** Full-screen asset viewer with continue-actions (Animate, Loop, Recreate...). */
import { Fragment, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { api, downloadUrl, finishFileUrl, mediaUrl, posterUrl, subjectUrl, takeAsInput, turntableUrl, workflowUrl, type SeamMeasure, type Take } from './api';
import { navigate } from './router';
import { getState, isAudio, isImage, isModel, refreshTakes, setHandoff, settingsOf, toast, useStore } from './store';
import type { ModelLook } from './ModelView';
// three.js loads only when a 3D take is opened.
const ModelView = lazy(() => import('./ModelView'));
import { Icon, Spill } from './ui';
import { pause, playerState, playTake, usePlayer } from './playerStore';
import { DIRECTOR_AXES, IMAGE_MODELS, SPEED_RAMPS, VIDEO_MODELS, editAppById } from './catalog';
import { effectById } from './effects';
import { SaveToCast } from './pages/Cast';
import { useCast } from './castStore';
import { lineage } from './lineage';

export async function animate(t: Take, loop = false) {
  toast('Sending to Video...');
  const token = await takeAsInput(t.id);
  setHandoff({
    refs: loop
      ? [{ token, role: 'start', kind: 'image', name: `take ${t.id}` }, { token, role: 'end', kind: 'image', name: `take ${t.id}` }]
      : [{ token, role: 'start', kind: 'image', name: `take ${t.id}` }],
    prompt: settingsOf(t).userPrompt ?? settingsOf(t).prompt,
  });
  navigate(loop ? '/video?preset=static' : '/video');
}

/** Hand a take to the Effects app as its clip or still. */
export async function addEffect(t: Take) {
  toast('Sending to Effects...');
  const still = isImage(t);
  const token = await takeAsInput(t.id);
  setHandoff({ refs: [{ token, role: 'start', kind: still ? 'image' : 'video', name: `take ${t.id}` }] });
  navigate(`/effects?effect=${still ? 'living-photo' : 'cutout'}`);
}

/**
 * Remove background from the Viewer. A still is cut out at once (transparent
 * PNG, the fast path); a clip opens the Remove background page, where the
 * subject to follow can be named first.
 */
export async function removeBackground(t: Take) {
  if (!isImage(t)) { navigate(`/cutout?take=${t.id}`); return; }
  await api.generate({
    kind: 'cutout', app: 'cutout', mode: 'matte', sourceTake: t.id, background: 'transparent', userPrompt: 'Remove background',
  });
  toast('Removing the background');
  navigate('/cutout');
}

export async function recreate(t: Take) {
  const s = { ...settingsOf(t) };
  delete s.seed;
  try {
    if (s.cut) {
      // A cut is recreated by shooting every shot again with new seeds.
      await api.directorScene({ ...s, shots: (s.shots ?? []).map((x: any) => ({ ...x, take: undefined, hero: undefined })) });
      toast('Shooting the scene again');
      return;
    }
    await api.generate(s);
    toast('Recreating with a new seed');
  } catch (e) {
    toast(e instanceof Error ? e.message : 'failed', true);
  }
}

/** Seam Doctor: measure, then try trim, a re-render across the wrap, or a new seed. Results land as new takes. */
export async function fixSeam(t: Take) {
  const r = await api.fixSeam(t.id, 'auto');
  if (!r.fix) return toast('Already seamless: the wrap moves like any other frame');
  toast(`Improving the seam (now ${r.before.ratio}x a frame step): ${r.fix === 'trim' ? 'trimming to the frames that close the loop'
    : r.fix === 'regen' ? 're-rendering across the wrap'
    : r.fix === 'bridge' ? 'bridging the wrap with new frames'
    : 'rendering the loop again with a new seed'}. The original stays as it is.`);
}

/**
 * What a seam fix did, in plain words: the wrap before (the take it fixed)
 * against the wrap now. Null for a take that is not a seam fix.
 */
export function seamOutcome(s: Record<string, any>, takes: Take[]): string | null {
  if (!s.seam || !(s.app === 'seam' || s.doctor)) return null;
  const rootId = Number(s.doctor?.root ?? s.sourceTake);
  const root = takes.find((x) => x.id === rootId);
  const before: number | undefined = s.before?.ratio ?? (root ? settingsOf(root).seam?.ratio : undefined);
  const after: number = s.seam.ratio;
  const last = !(s.doctor?.next ?? []).length;
  const fmt = (v: number) => `${Math.round(v * 10) / 10}x`;
  if (s.seam.verdict === 'seamless') return before != null ? `Seam closed: from ${fmt(before)} to ${fmt(after)} a frame step.` : `Seam closed: ${fmt(after)} a frame step.`;
  if (before != null && after < before) return `Seam improved from ${fmt(before)} to ${fmt(after)} a frame step; still visible.${last ? '' : ' Trying the next strategy.'}`;
  return last ? `No strategy closed this seam (${before != null ? `${fmt(before)} before, ` : ''}${fmt(after)} here); kept the original.`
    : `This try did not improve the seam (${before != null ? `${fmt(before)} to ` : ''}${fmt(after)}). Trying the next strategy.`;
}

/** Re-render a video take as HDR: EXR sequence + HLG master. */
export async function finishHdr(t: Take) {
  await api.generate({ kind: 'hdr', sourceTake: t.id });
  toast('Finishing in HDR. The EXRs and the HLG master land on the new take.');
}

/** The seam verdict as a badge, for any take that has been measured. */
export function SeamBadge({ seam }: { seam?: SeamMeasure }) {
  if (!seam) return null;
  const ok = seam.verdict === 'seamless';
  return (
    <span className={`badge seam ${ok ? 'ok' : 'bad'}`}
      title={`The wrap moves ${seam.ratio}x as much as an ordinary frame step`}>
      {ok ? 'Seamless' : 'Visible seam'}
    </span>
  );
}

export async function remove(t: Take) {
  await api.trash(t.id);
  await refreshTakes();
}

/** What engine + app made a take, in one line (the Viewer's "Model" row). */
function modelLabel(t: Take): string {
  const s = settingsOf(t);
  const image = isImage(t);
  const object = isModel(t);
  const cutoutBg = s.background === 'color' ? `over ${s.color}` : s.background === 'blur' ? 'blurred background' : s.background === 'image' ? 'new background' : 'transparent';
  return object ? `Model · TRELLIS.2 ${s.quality === 'quality' ? 'high' : 'draft'}`
    : s.app === 'cutout' ? `Remove background · ${image ? 'BiRefNet' : s.mode === 'track' ? 'SAM 3.1 track' : s.mode === 'matte' ? 'BiRefNet' : 'BiRefNet + SAM 3.1'} · ${cutoutBg}`
    : s.app === 'restyle' ? `Restyle · ${s.styleName ?? 'custom look'} · Qwen-Image-Edit + LTX-2.5`
    : s.app === 'swap' ? 'Object swap · SAM 3.1 + Qwen-Image-Edit + LTX-2.5 inpaint'
    : s.app === 'seam' ? `Seam fix · ${s.mode === 'trim' ? 'trim' : s.mode === 'regen' ? 'wrap re-rendered · LTX-2.5' : s.mode === 'reseed' ? 'new seed' : 'bridge · LTX-2.5'}`
    : s.app === 'hdr' ? 'Finish in HDR · LTX-2.5 SDR to HDR'
    : s.app === 'stage' ? (image ? `Stage look frame · ${s.engine === 'edit' ? 'Qwen-Image-Edit on the clay' : 'Z-Image Turbo on the depth pass'}` : 'Stage · LTX-2.5 Layout to Render')
    : s.castEngine === 'compose' ? `Cast${s.app === 'cast' ? ' hero frame' : ''} · Qwen-Image-Edit 2509${s.quality === 'draft' ? ' draft' : ''}`
    : s.castEngine === 'sheet' ? 'Cast · LTX-2.5 Ingredients IC-LoRA'
    : s.app === 'upscale' ? `Upscale · ${s.mode === 'redraw' ? `Redraw · SeedVR2 ${String(s.model).toUpperCase()}` : s.mode === 'dream' ? 'Dream · LTX-2.5' : 'Sharpen'}`
    : image
    ? s.app === 'edit' ? `${editAppById(s.mode ?? 'free').name} · Qwen-Image-Edit${s.quality === 'draft' ? ' draft' : ''}`
    : IMAGE_MODELS.find((m) => m.id === s.model)?.label ?? s.model
    : t.kind === 'upres' ? 'Upscale 2x'
    : s.app === 'mirror' ? `Mirror · ${s.control ?? 'pose'} · LTX-2.5`
    : s.app === 'reshoot' ? 'Reshoot · LTX'
    : s.app === 'effects' ? `Effect · ${effectById(s.effect)?.name ?? s.effect} · LTX-2.5`
    : s.app === 'extend' ? `Extend ${s.direction === 'backward' ? 'backward' : 'forward'} · LTX-2.5`
    : s.app === 'transition' ? 'Transition · LTX-2.5'
    : s.app === 'speak' ? 'Speak · LTX-2.5 audio to video'
    : s.app === 'sound' ? 'Add sound · LTX-2.5 video to audio'
    : s.app === 'audio' ? (s.model === 'qwen3-tts' ? 'Audio · Speech · Qwen3-TTS 1.7B VoiceDesign' : `Audio · Music · ACE-Step 1.5 ${s.model === 'base' ? 'Base · 30 steps' : 'Turbo · 8 steps'}`)
    : s.cut ? `Director scene · ${(s.shots ?? []).length} shots · LTX-2.5`
    : VIDEO_MODELS.find((m) => m.id === s.videoModel)?.label ?? s.videoModel;
}

/**
 * The ComfyUI workflow behind a take. ComfyUI 0.38 loads an API-format graph
 * when the .json file, or a link to it, is dropped on its canvas; pasting the
 * JSON as text only works for its own UI format, and there is no URL parameter
 * that takes a workflow. So "Open in ComfyUI" opens the canvas in a new tab,
 * downloads the file, and leaves a link here that can be dragged straight onto it.
 */
function ComfyWorkflow({ take }: { take: Take }) {
  const status = useStore((s) => s.status);
  const [have, setHave] = useState<boolean | null>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    setHave(null);
    setOpened(false);
    let live = true;
    fetch(workflowUrl(take.id), { method: 'HEAD' }).then((r) => live && setHave(r.ok)).catch(() => live && setHave(false));
    return () => { live = false; };
  }, [take.id]);

  // Cloud renders have no local canvas to open.
  const comfyUrl = status?.target === 'cloud' ? undefined : status?.comfyUrl;
  const download = () => {
    const a = document.createElement('a');
    a.href = workflowUrl(take.id, true);
    a.click();
  };
  const open = () => {
    window.open(comfyUrl, '_blank', 'noopener');
    download();
    setOpened(true);
  };

  if (have === false) return <div className="label">No ComfyUI workflow was recorded for this take.</div>;
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>ComfyUI workflow</div>
      <div className="viewer-actions">
        <button type="button" className="btn sm" disabled={!have} onClick={download}><Icon name="download" size={14} />Download workflow</button>
        {comfyUrl && <button type="button" className="btn sm" disabled={!have} onClick={open}><Icon name="nodes" size={14} />Open in ComfyUI</button>}
      </div>
      {opened && (
        <div className="compiled" style={{ marginTop: 8, fontFamily: "var(--font-ui)", fontSize: 12.5 }}>
          ComfyUI is open in a new tab and the workflow file is downloading. Drop the file onto the ComfyUI canvas to load it, or drag{' '}
          <a href={workflowUrl(take.id)} download={`openfield_take_${take.id}.json`} draggable style={{ color: 'var(--accent)' }}>this link</a>
          {' '}onto the canvas.
        </div>
      )}
    </div>
  );
}

export default function Viewer({ takeId, onClose, onStep }: { takeId: number; onClose: () => void; onStep: (dir: 1 | -1) => void }) {
  // The take on display. Starts at the prop; lineage steps move it. A new prop
  // (a different asset opened, or an arrow-key step from the parent page) resets it.
  const [currentId, setCurrentId] = useState(takeId);
  const [compare, setCompare] = useState(false);
  const take = useStore((s) => s.takes.find((x) => x.id === currentId));
  const allTakes = useStore((s) => s.takes);
  const [casting, setCasting] = useState(false);
  const [look, setLook] = useState<ModelLook>('lit');
  const cast = useCast();
  const playingThis = usePlayer((p) => p.current === currentId && p.playing);
  useEffect(() => { setCasting(false); setCompare(false); setCurrentId(takeId); }, [takeId]);
  // Opening an audio take starts it in the popup player (its old autoPlay).
  useEffect(() => {
    const t = getState().takes.find((x) => x.id === currentId);
    if (t && isAudio(t) && t.status === 'done' && playerState().current !== t.id) playTake(t.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onStep(1);
      if (e.key === 'ArrowLeft') onStep(-1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, onStep]);
  if (!take) return null;
  const s = settingsOf(take);
  const image = isImage(take);
  const object = isModel(take);
  const audio = isAudio(take);
  // The words that went in: tags and lyrics for music, the words and the voice for speech.
  const audioText = audio
    ? (s.model === 'qwen3-tts'
      ? [s.text, s.instruct ? `Voice: ${s.instruct}` : ''].filter(Boolean).join('\n\n')
      : [s.tags, s.lyrics].filter(Boolean).join('\n\n'))
    : '';
  const model = modelLabel(take);
  // What this take was made from, if any (edit, upscale, mirror, ...).
  const parent = take.parent_take_id != null ? allTakes.find((x) => x.id === take.parent_take_id) : undefined;

  const act = (fn: () => Promise<unknown>) => () => void fn().catch((e) => toast(e instanceof Error ? e.message : 'failed', true));
  // Secondary transforms. On a video take they sit under "More..." so the grid stays short.
  const done = take.status === 'done';
  const more: MoreItem[] = [
    !image && !audio && done && { label: 'Restyle', icon: 'palette', title: 'Same motion, a new look', run: () => { onClose(); navigate(`/mirror?mode=restyle&take=${take.id}`); } },
    done && s.app !== 'cutout' && !audio && { label: 'Remove background', icon: 'cutout', run: act(async () => { onClose(); await removeBackground(take); }) },
    !audio && { label: 'Add effect', icon: 'sparkle', run: act(() => addEffect(take)) },
    !image && !audio && { label: 'Add sound', icon: 'audio', run: () => { onClose(); navigate(`/speak?mode=sound&take=${take.id}`); } },
    !image && !audio && done && s.app !== 'hdr' && { label: 'Finish in HDR', icon: 'sparkle', title: 'ACEScg EXR sequence and an HLG master, from LTX-2.5 SDR to HDR', run: act(() => finishHdr(take)) },
    !image && !audio && done && { label: 'Improve the seam', icon: 'loop', title: 'Measure the loop point and try to lower it: trim, regenerate the wrap, or a new seed. Each try is a new take; the original is kept', run: act(() => fixSeam(take)) },
  ].filter((m): m is MoreItem => !!m);

  return (
    <div className="viewer-back" onClick={onClose}>
      {!audio && <Spill src={posterUrl(take.id)} key={take.id} />}
      <div className="viewer-stage" onClick={(e) => e.stopPropagation()}>
        {compare && parent
          ? <CompareStage a={parent} b={take} />
          : (<>
            {object && take.status === 'done'
              ? <ObjectStage take={take} look={look} onLook={setLook} />
              : image
              ? <img src={mediaUrl(take.id)} alt="" className={s.app === 'cutout' && s.background === 'transparent' ? 'checker' : undefined} />
              : audio
              ? (
                <div className="viewer-audio">
                  <div className="viewer-audio-note"><Icon name="audio" size={64} /></div>
                  <div className="label" style={{ margin: '14px 0 10px' }}>{audioText || s.userPrompt || s.prompt}</div>
                  <button type="button" className={`btn ${playingThis ? '' : 'accent'}`}
                    onClick={() => (playingThis ? pause() : playTake(take.id))}>
                    <Icon name={playingThis ? 'pause' : 'play'} size={15} />
                    {playingThis ? 'Pause' : 'Play in the player'}
                  </button>
                  <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Live visualizer, waveform, stats and transport in the popup player.</div>
                </div>
              )
              : <video src={mediaUrl(take.id)} controls autoPlay muted loop playsInline />}
          </>)}
        <button type="button" className="icon-btn" style={{ position: 'absolute', top: 16, left: 16 }} onClick={onClose} aria-label="close"><Icon name="x" /></button>
      </div>
      <aside className="viewer-side" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="label">{object ? '3D' : image ? 'Image' : audio ? 'Audio' : 'Video'} · #{take.id}</span>
          <button type="button" className={`icon-btn ${take.starred ? 'on' : ''}`} onClick={act(() => api.star(take.id, !take.starred).then(refreshTakes))} aria-label="favorite"><Icon name="heart" /></button>
        </div>
        <LineageStrip take={take} takes={allTakes} onOpen={(id) => { setCompare(false); setCurrentId(id); }} />
        {compare && parent && <SettingsDiff a={parent} b={take} />}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>{audio ? (s.model === 'qwen3-tts' ? 'Words' : 'Tags and lyrics') : 'Prompt'}</div>
          <div className="viewer-prompt">{audio ? audioText : (s.userPrompt || s.prompt || s.instruction)}</div>
          {s.prompt && s.userPrompt && s.prompt !== s.userPrompt && (
            <details style={{ marginTop: 8 }}>
              <summary className="label" style={{ cursor: 'pointer' }}>Compiled prompt</summary>
              <div className="compiled" style={{ marginTop: 6 }}>{s.prompt}</div>
            </details>
          )}
          <button type="button" className="btn sm ghost" style={{ marginTop: 6 }}
            onClick={() => { void navigator.clipboard.writeText(audio ? audioText : (s.prompt ?? '')); toast(audio ? 'Copied' : 'Prompt copied'); }}>
            {audio ? 'Copy' : 'Copy prompt'}
          </button>
        </div>
        {object ? (
          <div className="viewer-actions">
            <a className="btn sm accent" href={downloadUrl(take.id)}><Icon name="download" size={14} />Download GLB</a>
            <a className="btn sm" href={`${turntableUrl(take.id)}`} download={`take_${take.id}_turntable.mp4`}><Icon name="video" size={14} />Turntable</a>
            {take.status === 'done' && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/stage?prop=${take.id}`); }} title="Open Stage with this model placed in the set as a prop"><Icon name="camera" size={14} />Use in Stage</button>}
            {s.sourceTake && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/object?take=${s.sourceTake}`); }}><Icon name="image" size={14} />Source still</button>}
            <button type="button" className="btn sm" onClick={act(() => recreate(take))}><Icon name="redo" size={14} />Recreate</button>
            <button type="button" className="btn sm danger" onClick={act(async () => { await remove(take); onClose(); })}><Icon name="trash" size={14} />Delete</button>
          </div>
        ) : (
        <div className="viewer-actions">
          {parent && <button type="button" className={`btn sm ${compare ? 'accent' : ''}`} onClick={() => setCompare(!compare)} title={compare ? 'Back to this take alone' : `Side by side with what it was made from (#${parent.id})`}><Icon name={compare ? 'x' : 'layers'} size={14} />{compare ? 'Exit compare' : 'Compare with source'}</button>}
          {s.app === 'stage' && s.scene && <button type="button" className="btn sm accent" onClick={() => { onClose(); navigate(`/stage?take=${take.id}`); }} title="Load this take's set, camera and look back into Stage"><Icon name="camera" size={14} />Open in Stage</button>}
          {image && take.status === 'done' && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/object?take=${take.id}`); }} title="A textured 3D model of the subject, from this still"><Icon name="cube" size={14} />Make 3D</button>}
          {image && take.status === 'done' && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/stage?look=${take.id}`); }} title="Open Stage with this still as the look frame, cropped to the shot if it needs to be"><Icon name="camera" size={14} />Use as Stage look frame</button>}
          {image && <button type="button" className={`btn sm ${s.app === 'stage' ? '' : 'accent'}`} onClick={act(() => animate(take))}><Icon name="video" size={14} />Animate</button>}
          {image && <button type="button" className="btn sm" onClick={act(() => animate(take, true))}><Icon name="loop" size={14} />Make a loop</button>}
          {image && take.status === 'done' && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/edit?take=${take.id}`); }} title="Edit, new angle, relight, expand and more"><Icon name="wand" size={14} />Edit...</button>}
          {image && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/speak?take=${take.id}`); }}><Icon name="person" size={14} />Speak</button>}
          {take.kind !== 'upres' && s.app !== 'upscale' && !audio && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/upscale?take=${take.id}`); }}><Icon name="up" size={14} />Upscale</button>}
          {!image && !audio && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/extend?take=${take.id}`); }}><Icon name="plus" size={14} />Extend</button>}
          {!audio && <button type="button" className="btn sm" onClick={() => { onClose(); navigate(`/extend?mode=transition&take=${take.id}`); }}><Icon name="loop" size={14} />Transition to...</button>}
          {image ? more.map((m) => (
            <button key={m.label} type="button" className="btn sm" onClick={m.run} title={m.title}><Icon name={m.icon} size={14} />{m.label}</button>
          )) : more.length > 0 && <MoreMenu items={more} />}
          {image && <button type="button" className="btn sm" onClick={act(async () => {
            const token = await takeAsInput(take.id);
            setHandoff({ refs: [{ token, role: 'end', kind: 'image', name: `take ${take.id}` }] });
            navigate('/video');
          })} title="Use as the end frame of a new video"><Icon name="ref" size={14} />As end frame</button>}
          {image && take.status === 'done' && <button type="button" className={`btn sm ${casting ? 'on' : ''}`} onClick={() => setCasting(!casting)} title="Keep this face, prop or place and @mention it in any prompt"><Icon name="person" size={14} />Save to cast</button>}
          {audio && take.status === 'done' && <button type="button" className="btn sm accent" onClick={() => { onClose(); navigate(`/speak?take=${take.id}`); }} title="A talking shot: a face with this voice on it"><Icon name="person" size={14} />Make it talk</button>}
          <button type="button" className="btn sm" onClick={act(() => recreate(take))}><Icon name="redo" size={14} />Recreate</button>
          <a className="btn sm" href={downloadUrl(take.id)}><Icon name="download" size={14} />Download{s.alphaPath ? ' preview' : ''}</a>
          {s.alphaPath && <a className="btn sm accent" href={`/api/media/${take.id}?alpha=1`}><Icon name="download" size={14} />ProRes 4444 with alpha</a>}
          <button type="button" className="btn sm danger" onClick={act(async () => { await remove(take); onClose(); })}><Icon name="trash" size={14} />Delete</button>
        </div>
        )}
        {casting && <SaveToCast takeId={take.id} onClose={() => setCasting(false)} />}
        {s.seam && <SeamReport seam={s.seam} outcome={seamOutcome(s, getState().takes)} />}
        {s.app === 'hdr' && <HdrFiles take={take} />}
        <ComfyWorkflow take={take} />
        <dl className="kv">
          <dt>Model</dt><dd>{model}</dd>
          {s.preset && s.preset !== 'free' && <><dt>Motion</dt><dd>{s.presetName ?? s.preset}</dd></>}
          {Array.isArray(s.cast) && s.cast.length > 0 && <><dt>Cast</dt><dd>{s.cast.map((id: number) => cast.find((m) => m.id === id)?.name ?? `#${id}`).join(', ')}{s.castEngine === 'frame' ? ' · hero frame' : ''}</dd></>}
          {s.app === 'stage' && s.scene && <><dt>Set</dt><dd>{s.scene.props?.length ?? 0} props · {s.scene.lens}mm · {s.scene.keys?.length ?? 2} camera keys{!image && s.quality ? ` · ${s.quality}` : ''}</dd></>}
          {object ? <>
            <dt>Mesh</dt><dd>up to {Number(s.faces).toLocaleString()} faces · {s.texture}px textures{s.quality === 'quality' ? ' · normal and AO maps' : ''}</dd>
            <dt>Subject</dt><dd>{s.removeBackground === false ? "the picture's own transparency" : 'cut out by BiRefNet'}</dd>
           </> : !audio && <><dt>Size</dt><dd>{s.width}x{s.height}</dd></>}
          {!image && !object && s.seconds && <><dt>Length</dt><dd>{s.outSeconds ? `${s.outSeconds}s (shot ${s.seconds}s)` : `${s.seconds}s`}</dd></>}
          {s.picks?.genre && s.picks.genre !== 'auto' && <><dt>Genre</dt><dd>{DIRECTOR_AXES[0].options.find((o) => o.id === s.picks.genre)?.label ?? s.picks.genre}</dd></>}
          {s.era != null && <><dt>Era</dt><dd>{s.era}{s.eraGraded ? ', graded' : s.cut && s.eraGrade !== false ? ', graded per shot' : ', prompt only'}</dd></>}
          {s.ramp && s.ramp !== 'linear' && <><dt>Speed</dt><dd>{SPEED_RAMPS.find((r) => r.id === s.ramp)?.label ?? s.ramp}{s.rampSilent ? ', no sound' : ''}</dd></>}
          {s.cut && <><dt>Shots</dt><dd>{(s.shots ?? []).map((x: any, i: number) => <div key={i} style={{ fontSize: 12 }}>{i + 1}. {x.action}</div>)}</dd></>}
          <dt>Seed</dt><dd className="mono">{s.seed}</dd>
          {take.render_seconds && <><dt>Render</dt><dd>{Math.round(take.render_seconds)}s on this GPU</dd></>}
          <dt>File</dt><dd className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{take.output_path?.split('/').pop()}</dd>
        </dl>
        <div className="label" style={{ marginTop: 'auto' }}>← → to browse · Esc to close · {getState().takes.length} assets</div>
      </aside>
    </div>
  );
}

interface MoreItem { label: string; icon: string; title?: string; run: () => void }

/** "More..." button: a keyboard-accessible menu (arrows, Home/End, Enter, Esc returns focus). */
function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const close = () => { setOpen(false); btn.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); els[(n + els.length) % els.length]?.focus(); };
    // Keep the Viewer's own arrow / Esc keys from firing while the menu is open.
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape', 'Tab'].includes(e.key)) e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div className="pop-wrap more-wrap" ref={wrap}>
      <button ref={btn} type="button" className={`btn sm ${open ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setOpen(true); } }}>
        More...<Icon name="down" size={12} />
      </button>
      {open && (
        <div ref={menu} className="popover down more-menu" role="menu" aria-label="More actions" onKeyDown={onKey}>
          {items.map((m) => (
            <button key={m.label} type="button" role="menuitem" className="pop-item" title={m.title}
              onClick={() => { setOpen(false); m.run(); }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name={m.icon} size={14} />{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SeamReport({ seam, outcome }: { seam: SeamMeasure; outcome: string | null }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="label">Loop point</span>
        <SeamBadge seam={seam} />
      </div>
      {outcome && <p className="dim" style={{ margin: '0 0 6px' }}>{outcome}</p>}
      <dl className="kv">
        <dt>Wrap</dt><dd>{seam.ratio}x a frame step</dd>
        <dt>Texture</dt><dd>{seam.texture.ratio.toFixed(2)}x</dd>
        <dt>Composition</dt><dd>{seam.composition.ratio.toFixed(2)}x</dd>
        {seam.splices?.map((sp) => <Fragment key={sp.frame}><dt>Join at frame {sp.frame}</dt><dd>{sp.ratio}x</dd></Fragment>)}
      </dl>
    </div>
  );
}

function HdrFiles({ take }: { take: Take }) {
  const hdr = settingsOf(take).hdr;
  if (take.status !== 'done') return null;
  if (!hdr) return <div className="label">Collecting the EXR frames and the HLG master...</div>;
  const again = <button type="button" className="btn sm ghost" onClick={() => void api.collectHdr(take.id).then(refreshTakes).catch((e) => toast(e instanceof Error ? e.message : 'failed', true))}>Collect the files again</button>;
  if (hdr.error) return <div><div className="label" style={{ color: 'var(--bad)' }}>HDR files: {hdr.error}</div>{again}</div>;
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>HDR masters</div>
      <div className="viewer-actions">
        <a className="btn sm" href={finishFileUrl(take.id, 'exr')}><Icon name="download" size={14} />EXR sequence</a>
        <a className="btn sm" href={finishFileUrl(take.id, 'hlg')}><Icon name="download" size={14} />HLG .mov</a>
        {hdr.proresMov && <a className="btn sm" href={finishFileUrl(take.id, 'prores')}><Icon name="download" size={14} />HLG ProRes</a>}
      </div>
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>EXR</dt><dd>{hdr.check.exr.frames} frames · ACEScg · {hdr.check.exr.pixel === 'half' ? '16-bit half' : hdr.check.exr.pixel}</dd>
        <dt>Master</dt><dd>HLG · BT.2020 · {/10/.test(hdr.check.hlg.pix_fmt) ? '10-bit' : hdr.check.hlg.pix_fmt}</dd>
        {!hdr.check.ok && <><dt>Check</dt><dd style={{ color: 'var(--bad)' }}>{hdr.check.problems.join('. ')}</dd></>}
      </dl>
      {!hdr.check.ok && again}
    </div>
  );
}

/**
 * An Object take in the Viewer: the GLB to grab and turn, with the clay and
 * wire looks for judging the geometry, and the subject it was built from.
 */
function ObjectStage({ take, look, onLook }: { take: Take; look: ModelLook; onLook: (l: ModelLook) => void }) {
  return (
    <div className="object-stage">
      <Suspense fallback={<img className="model-poster" src={posterUrl(take.id)} alt="" />}>
        <ModelView src={mediaUrl(take.id)} poster={posterUrl(take.id)} look={look} />
      </Suspense>
      <div className="object-looks" onClick={(e) => e.stopPropagation()}>
        {(['lit', 'clay', 'wire'] as const).map((l) => (
          <button key={l} type="button" className={`pill ${look === l ? 'active' : ''}`} onClick={() => onLook(l)}>
            {l === 'lit' ? 'Textured' : l === 'clay' ? 'Clay' : 'Wireframe'}
          </button>
        ))}
      </div>
      <img className="object-subject" src={subjectUrl(take.id)} alt="" title="The subject as the model saw it" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
    </div>
  );
}

/** The take's parent chain, oldest first; each step jumps to it. Hidden when there is nothing to show. */
function LineageStrip({ take, takes, onOpen }: { take: Take; takes: Take[]; onOpen: (id: number) => void }) {
  const chain = lineage(takes, take.id);
  const children = takes.filter((x) => x.parent_take_id === take.id);
  if (chain.length < 2 && children.length === 0) return null;
  const appOf = (t: Take) => settingsOf(t).app ?? t.kind;
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>Lineage{children.length > 0 ? ` · ${children.length} made from this` : ''}</div>
      <div className="lineage">
        {chain.map((c, i) => (
          <button key={c.id} type="button"
            className={`lineage-step ${c.id === take.id ? 'now' : ''}`}
            disabled={c.id === take.id}
            onClick={() => onOpen(c.id)}
            title={i === chain.length - 1 ? 'This take' : `Made by ${appOf(c)} · #${c.id}`}>
            <span className="lineage-thumb">{isAudio(c) ? <Icon name="audio" size={14} /> : <img src={posterUrl(c.id)} alt="" />}</span>
            <span className="lineage-app">{appOf(c)}</span>
            <span className="lineage-id">#{c.id}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One side of a before/after comparison, with a plain media render (no player, no 3D). */
function ComparePane({ t, tag }: { t: Take; tag: string }) {
  const s = settingsOf(t);
  return (
    <div className="compare-pane">
      <div className="compare-tag">{tag}</div>
      {isAudio(t)
        ? <div className="compare-audio"><Icon name="audio" size={40} /><div className="dim" style={{ fontSize: 12 }}>{s.text ?? s.tags ?? s.userPrompt}</div></div>
        : isImage(t)
        ? <img src={mediaUrl(t.id)} alt="" className={s.app === 'cutout' && s.background === 'transparent' ? 'checker' : undefined} />
        : isModel(t)
        ? <img src={posterUrl(t.id)} alt="" />
        : <video src={mediaUrl(t.id)} controls muted loop playsInline />}
    </div>
  );
}

/** Side by side: the take it was made from, and the take itself. */
function CompareStage({ a, b }: { a: Take; b: Take }) {
  return (
    <div className="compare">
      <ComparePane t={a} tag={`Source · #${a.id}`} />
      <div className="compare-divider" />
      <ComparePane t={b} tag={`Result · #${b.id}`} />
    </div>
  );
}

/** How the source and the result differ: model, seed, size, length, prompt. */
function SettingsDiff({ a, b }: { a: Take; b: Take }) {
  const sa = settingsOf(a), sb = settingsOf(b);
  const val = (v: unknown) => (v == null || v === '' ? '—' : String(v));
  const rows: [string, string, string][] = [
    ['Model', modelLabel(a), modelLabel(b)],
    ['Seed', val(sa.seed), val(sb.seed)],
    ['Size', sa.width ? `${sa.width}×${sa.height}` : '—', sb.width ? `${sb.width}×${sb.height}` : '—'],
    ['Length', sa.seconds ? `${sa.seconds}s` : '—', sb.seconds ? `${sb.seconds}s` : '—'],
    ['Prompt', val(sa.userPrompt ?? sa.prompt ?? sa.instruction), val(sb.userPrompt ?? sb.prompt ?? sb.instruction)],
  ];
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>What changed</div>
      <table className="diff">
        <tbody>
          {rows.map(([k, av, bv]) => (
            <tr key={k} className={av !== bv ? 'differs' : 'same'}>
              <th>{k}</th><td>{av}</td><td>{bv}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
