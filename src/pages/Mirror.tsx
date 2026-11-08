/**
 * Mirror: film a move on your phone, keep its motion, change everything else.
 * Source clip -> control track (pose / depth / edges) -> LTX-2.5 IC-LoRA.
 * Two more modes share the clip: Restyle (a new look for the whole shot) and
 * Object swap (one thing replaced), in ./MirrorEdit.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import { api, downloadUrl, inputUrl, mediaUrl, takeAsInput, uploadFile, type Take } from '../api';
import { setParams, useRoute } from '../router';
import { inFeed, settingsOf, toast, useStore } from '../store';
import { useDropZone, usePageDrop } from '../drop';
import { Icon, MediaCard, Stepper, Switch, TierChip, fmtSeconds, useEstimate, useTierChoice } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';
import { MIRROR_CONTROLS as CONTROLS, mirrorSize } from '../catalog';
import { PhoneDrop } from '../Phone';
import { MentionBox, useMentioned } from '../Mention';
import { RestyleControls, SwapControls } from './MirrorEdit';

/**
 * Mirror's modes. Object swap is experimental and hidden: open it with
 * ?mode=swap (or ?swap=1). It holds up on objects (a parked van became a
 * pickup truck that tracks the camera), but a swapped moving person loses the
 * source's action (a running man became a knight on a motorbike); Mirror with
 * an edited first frame is the better path for people.
 */
const MODES = [
  { id: 'motion', label: 'Motion' },
  { id: 'restyle', label: 'Restyle' },
  { id: 'swap', label: 'Object swap' },
] as const;


interface Clip { token: string; url: string; seconds: number; w: number; h: number; name: string }

export default function MirrorPage() {
  const { params } = useRoute();
  const control = (params.get('control') as 'pose' | 'depth' | 'edges') || 'pose';
  const mode = MODES.find((m) => m.id === params.get('mode'))?.id ?? 'motion';
  const swapOn = mode === 'swap' || params.get('swap') === '1';
  const [clip, setClip] = useState<Clip | null>(null);
  // Deep link from the Viewer (Restyle on a take): /mirror?mode=restyle&take=42.
  const fromTake = Number(params.get('take')) || null;
  useEffect(() => {
    if (!fromTake) return;
    let live = true;
    takeAsInput(fromTake)
      .then(async (token) => {
        const url = inputUrl(token);
        const m = await probeClip(url);
        if (live) setClip({ token, url, seconds: m.s, w: m.w, h: m.h, name: `take ${fromTake}` });
      })
      .catch((e) => toast(e instanceof Error ? e.message : 'could not load that take', true));
    return () => { live = false; };
  }, [fromTake]);
  const [frame, setFrame] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const castNamed = useMentioned(prompt).some((m) => m.refs.length);
  const [strength, setStrength] = useState(1);
  const [audio, setAudio] = useState(false);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [res, setRes] = useTierChoice('mirror');

  const seconds = clip ? Math.max(1, Math.min(12, Math.floor(clip.seconds))) : 5;
  const size = mirrorSize(clip?.w ?? 0, clip?.h ?? 0, res);
  const est = useEstimate({ kind: 'video', model: 'mirror', w: size.w, h: size.h, seconds });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && ['mirror', 'restyle', 'swap'].includes(settingsOf(t).app)));

  async function addClip(f: File) {
    if (!f.type.startsWith('video/')) { toast('Drop a video clip (MP4 or MOV)', true); return; }
    if (f.size > 90e6) { toast('Clip is over 90 MB. Trim it to 12 seconds or less.', true); return; }
    setBusy('Uploading clip...');
    try {
      const url = URL.createObjectURL(f);
      const meta = await probeClip(url);
      if (meta.s < 1.5) { toast('Clip is too short. Use 2 to 12 seconds.', true); return; }
      const token = await uploadFile(f);
      setClip({ token, url, seconds: meta.s, w: meta.w, h: meta.h, name: f.name });
      if (meta.s > 12.5) toast('Using the first 12 seconds of the clip');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    } finally {
      setBusy(null);
    }
  }

  /** A clip that arrived from the phone is already uploaded; just read its shape. */
  async function addPhoneClip(token: string, name: string) {
    const url = inputUrl(token);
    const meta = await probeClip(url);
    if (meta.s < 1.5) { toast('That phone clip is too short. Use 2 to 12 seconds.', true); return; }
    setClip({ token, url, seconds: meta.s, w: meta.w, h: meta.h, name });
    toast(meta.s > 12.5 ? 'Clip from your phone is in. Using the first 12 seconds.' : 'Clip from your phone is in');
  }

  async function addFrame(f: File) {
    if (!f.type.startsWith('image/')) return;
    setBusy('Uploading frame...');
    try { setFrame(await uploadFile(f)); } catch (e) { toast(String(e), true); } finally { setBusy(null); }
  }

  usePageDrop('Drop a clip to copy its motion, or an image as the first frame', (files) => {
    const f = files[0];
    if (f.type.startsWith('video/')) void addClip(f);
    else if (f.type.startsWith('image/')) void addFrame(f);
  });

  async function go() {
    if (!clip) return;
    setBusy('Queuing...');
    try {
      const r = await api.generate({
        kind: 'mirror', app: 'mirror', videoModel: 'mirror', control, sourceVideo: clip.token, startImage: frame ?? undefined,
        prompt, userPrompt: prompt, width: size.w, height: size.h, seconds, guideStrength: strength, withAudio: audio, count,
        shotName: (prompt || 'mirror').slice(0, 40),
      });
      toast(`Queued ${r.takeIds.length} take${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  const compareTake = takes.find((t) => t.id === compare);

  return (
    <div className="rail-layout" style={{ gridTemplateColumns: '360px 1fr' }}>
      <aside className="rail">
        <div className="display" style={{ fontSize: 26 }}>Mirror</div>
        <div className="tabs" style={{ borderBottom: 0, marginTop: -6 }}>
          {MODES.filter((m) => m.id !== 'swap' || swapOn).map((m) => (
            <button key={m.id} type="button" className={mode === m.id ? 'on' : ''} onClick={() => setParams({ mode: m.id === 'motion' ? null : m.id })}>{m.label}</button>
          ))}
        </div>
        {mode === 'motion' && <>
        <div className="seg">
          {CONTROLS.map((c) => (
            <button key={c.id} type="button" className={control === c.id ? 'on' : ''} onClick={() => setParams({ control: c.id === 'pose' ? null : c.id })}>{c.label}</button>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>{CONTROLS.find((c) => c.id === control)!.note}</div>
        </>}
        {mode === 'restyle' && <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>Same moves and camera, a whole new look. The first frame is redrawn in the style, then the clip's motion carries it.</div>}
        {mode === 'swap' && <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>Replace one thing in the clip. Everything around it stays exactly as filmed. Experimental: best on objects; for a person, use Motion with a new first frame.</div>}

        <div className="rail-section">
          <div className="label">Source clip</div>
          {clip ? (
            <div className="ref" style={{ aspectRatio: `${clip.w || 16} / ${clip.h || 9}` }}>
              <video src={clip.url} muted loop autoPlay playsInline />
              <span className="role">{Math.min(12, clip.seconds).toFixed(1)}s</span>
              <button type="button" className="x" onClick={() => { setClip(null); setParams({ take: null }); }} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <>
              <DropWell accept="video/*" onFile={addClip} icon="video" title="Add the clip to copy" sub="2 to 12 seconds. Film it the way the shot should be framed." />
              <PhoneDrop onClip={addPhoneClip} />
            </>
          )}
        </div>

        {mode === 'restyle' ? <RestyleControls clip={clip} /> : mode === 'swap' ? <SwapControls clip={clip} /> : <>
        <div className="rail-section">
          <div className="label">First frame · optional</div>
          {frame ? (
            <div className="ref" style={{ aspectRatio: '16/9' }}>
              <img src={inputUrl(frame)} alt="" />
              <span className="role start">first frame</span>
              <button type="button" className="x" onClick={() => setFrame(null)} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <DropWell accept="image/*" onFile={addFrame} icon="person" compact title="+ Character or world frame" sub="" />
          )}
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Match the clip's framing: same size in frame, same angle.</div>
        </div>

        <div className="rail-section">
          <div className="label">Who and where</div>
          <MentionBox className="prompt" rows={4} value={prompt} onChange={setPrompt}
            placeholder="A knight in battered silver armor in a torchlit stone hall, same moves as the clip. Type @ for your cast." />
          {!frame && castNamed && <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>No first frame: one is made from your cast, in the clip's opening pose.</div>}
        </div>

        <div className="rail-section">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="label">Hold to the clip</span><span className="mono dim" style={{ fontSize: 12 }}>{Math.round(strength * 100)}%</span></div>
          <input type="range" min={0.4} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
        </div>

        <div className="chip-row" style={{ alignItems: 'center' }}>
          <span className="chip"><Icon name="clock" size={14} />{seconds}s</span>
          <TierChip app="mirror" value={res} onChange={setRes} />
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
          <span className="chip" style={{ gap: 10 }}><Icon name="audio" size={14} />Sound <Switch on={audio} onChange={setAudio} label="sound" /></span>
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !clip || !prompt.trim()} onClick={() => void go()}>
          <span>{busy ?? 'Mirror it'}</span>
          <span className="cost">{size.w}x{size.h}{est ? ` · ${fmtSeconds(est * count)}` : ' · LTX-2.5 + IC-LoRA'}</span>
        </button>
        </>}
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className={!compareTake ? 'on' : ''} onClick={() => setCompare(null)}>Takes</button>
            {compareTake && <button type="button" className="on">Compare</button>}
          </div>
          {compareTake && <button type="button" className="icon-btn" onClick={() => setCompare(null)} aria-label="close"><Icon name="x" /></button>}
        </div>
        <div className="canvas-body">
          {compareTake ? <Compare take={compareTake} onOpen={() => setViewing(compareTake.id)} /> : takes.length === 0 ? (
            <div className="hero-empty">
              <div className="label" style={{ marginBottom: 14 }}>Same moves, new everything</div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>You act it. <span className="hl">It becomes them.</span></div>
              <div className="steps3">
                <div><span className="label">01</span><b>Film the move</b><span className="dim">Any phone clip. Frame it like the final shot.</span></div>
                <div><span className="label">02</span><b>Say who and where</b><span className="dim">Add a first frame to lock the look.</span></div>
                <div><span className="label">03</span><b>Mirror it</b><span className="dim">Your timing, on a new character.</span></div>
              </div>
            </div>
          ) : (
            <div className="grid">
              {takes.map((t) => (
                <MediaCard key={t.id} take={t} tag={mirrorTag(t)} onOpen={() => setCompare(t.id)} actions={<>
                  <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                  <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                </>} />
              ))}
            </div>
          )}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={() => {}} />}
    </div>
  );
}

/** Duration and frame size of a clip, read by the browser. Unreadable codecs fall back to 5 s, unknown size. */
export function probeClip(url: string): Promise<{ s: number; w: number; h: number }> {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => res({ s: v.duration, w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => res({ s: 5, w: 0, h: 0 });
    v.src = url;
  });
}

export function DropWell(p: { accept: string; onFile: (f: File) => void; icon: string; title: string; sub: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const zone = useDropZone((files) => p.onFile(files[0]));
  return (
    <div className={`well ${zone.over ? 'drag' : ''}`} style={p.compact ? { padding: 10 } : undefined}
      onClick={() => input.current?.click()} {...zone.props}>
      <input ref={input} type="file" accept={p.accept} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onFile(f); }} />
      {!p.compact && <div className="well-icons"><span><Icon name={p.icon} /></span></div>}
      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{p.title}</div>
      {p.sub && <div style={{ fontSize: 12, marginTop: 2 }}>{p.sub}</div>}
    </div>
  );
}

/** What a Mirror-family take did, in a few words. */
export function mirrorTag(t: Take): string {
  const s = settingsOf(t);
  if (s.app === 'restyle') return 'Restyle';
  if (s.app === 'swap') return 'Swap';
  if (s.app === 'reshoot') return 'Reshoot';
  return CONTROLS.find((c) => c.id === s.control)?.label ?? 'Mirror';
}

/**
 * Your clip next to the result, in lockstep. The result is the clock; your clip
 * follows by nudging its playback rate and only seeks when it is far off (a
 * loop), so neither side stutters.
 */
export function Compare({ take, onOpen }: { take: Take; onOpen?: () => void }) {
  const s = settingsOf(take);
  const [mode, setMode] = useState<'side' | 'wipe'>('side');
  const [x, setX] = useState(50);
  const src = useRef<HTMLVideoElement>(null);
  const out = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = src.current, b = out.current;
      if (a && b && !b.paused && a.readyState >= 2) {
        const drift = a.currentTime - b.currentTime;
        if (Math.abs(drift) > 0.3) { a.currentTime = b.currentTime; a.playbackRate = 1; }
        else a.playbackRate = Math.min(1.15, Math.max(0.85, 1 - drift * 0.8));
        if (a.paused) void a.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [take.id, mode]);
  const outLabel = mirrorTag(take);
  const seconds = s.outSeconds ?? s.seconds;
  const video = (ref: React.RefObject<HTMLVideoElement | null>, url: string, master: boolean, style?: React.CSSProperties) => (
    <video ref={ref} src={url} muted loop={master} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style }} />
  );
  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <b>{outLabel}</b>
        <span className="dim" style={{ fontSize: 12.5 }}>Take #{take.id}{seconds ? ` · ${seconds}s` : ''}{s.width ? ` · ${s.width}x${s.height}` : ''}</span>
        <div className="seg" style={{ marginLeft: 'auto', width: 190 }}>
          <button type="button" className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')}>Side by side</button>
          <button type="button" className={mode === 'wipe' ? 'on' : ''} onClick={() => setMode('wipe')}>Wipe</button>
        </div>
        {onOpen && <button type="button" className="btn sm" onClick={onOpen}><Icon name="grid" size={13} />Open</button>}
        <a className="btn sm" href={downloadUrl(take.id)}><Icon name="download" size={13} />Download</a>
        <button type="button" className="btn sm" onClick={() => void recreate(take)}><Icon name="redo" size={13} />Retry</button>
      </div>
      {mode === 'side' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[['Your clip', src, inputUrl(s.sourceVideo), false], [outLabel, out, mediaUrl(take.id), true]].map(([label, ref, url, master]) => (
            <div key={label as string} style={{ position: 'relative', aspectRatio: `${s.width || 16} / ${s.height || 9}`, borderRadius: 14, overflow: 'hidden', background: '#000' }}>
              {video(ref as React.RefObject<HTMLVideoElement | null>, url as string, master as boolean)}
              <span className="badge on-media" style={{ position: 'absolute', top: 12, left: 12 }}>{label as string}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ position: 'relative', aspectRatio: `${s.width || 16} / ${s.height || 9}`, borderRadius: 14, overflow: 'hidden', background: '#000', cursor: 'ew-resize', userSelect: 'none' }}
          onMouseMove={(e) => { if (e.buttons !== 1) return; const r = e.currentTarget.getBoundingClientRect(); setX(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))); }}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setX(((e.clientX - r.left) / r.width) * 100); }}>
          {video(out, mediaUrl(take.id), true, { position: 'absolute', inset: 0 })}
          {video(src, inputUrl(s.sourceVideo), false, { position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - x}% 0 0)` })}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${x}%`, width: 2, background: 'var(--accent)', transform: 'translateX(-1px)' }} />
          <span className="badge on-media" style={{ position: 'absolute', top: 12, left: 12 }}>Your clip</span>
          <span className="badge on-media" style={{ position: 'absolute', top: 12, right: 12 }}>{outLabel}</span>
        </div>
      )}
      {s.userPrompt && <div className="dim" style={{ marginTop: 10, fontSize: 12.5 }}>{s.userPrompt}</div>}
    </div>
  );
}
