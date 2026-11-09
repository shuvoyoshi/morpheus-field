/**
 * Remove background: cut the subject out of a still or a clip. Stills go
 * through BiRefNet (soft matte); clips add SAM 3.1 tracking so the cut out
 * holds still from frame to frame. Transparent results are a PNG with alpha,
 * or ProRes 4444 with alpha for clips (the take itself is a preview over a
 * checkerboard). Or put the subject over a color, a blur or a new picture.
 */
import { useEffect, useState } from 'react';
import { api, inputUrl, mediaUrl, uploadFile, type Take } from '../api';
import { CUTOUT_BACKGROUNDS, CUTOUT_COLORS, CUTOUT_MAX_SECONDS, CUTOUT_MODES, cutoutSize, type CutoutBackground, type CutoutMode } from '../catalog';
import { setParams, useRoute } from '../router';
import { inFeed, isImage, settingsOf, takeHandoff, toast, useStore } from '../store';
import { Icon, MediaCard, Switch, fmtSeconds, useEstimate, RailHandle, useRail } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';
import { usePageDrop } from '../drop';
import { DropWell, probeClip } from './Mirror';

/** What is being cut out: an uploaded file, or a finished take by id. */
interface Source { kind: 'image' | 'video'; token?: string; take?: number; url: string; w: number; h: number; seconds: number; name: string }

function dimsOf(url: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res({ w: 0, h: 0 });
    im.src = url;
  });
}

export const alphaUrl = (id: number) => `/api/media/${id}?alpha=1`;

export default function CutoutPage() {
  const { params } = useRoute();
  const fromTake = Number(params.get('take')) || null;
  const allTakes = useStore((s) => s.takes);
  const [src, setSrc] = useState<Source | null>(null);
  const [mode, setMode] = useState<CutoutMode>('matte');
  const [subject, setSubject] = useState('');
  const [background, setBackground] = useState<CutoutBackground>('transparent');
  const [color, setColor] = useState<string>(CUTOUT_COLORS[0]);
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [audio, setAudio] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<number | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  // Deep link from the Viewer or the Edit app: /cutout?take=44.
  useEffect(() => {
    if (!fromTake || src?.take === fromTake) return;
    const t = allTakes.find((x) => x.id === fromTake);
    if (!t || t.status !== 'done') return;
    const s = settingsOf(t);
    const image = isImage(t);
    setSrc({ kind: image ? 'image' : 'video', take: t.id, url: mediaUrl(t.id), w: s.width || 0, h: s.height || 0, seconds: Number(s.seconds) || 0, name: `take ${t.id}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromTake, allTakes.length]);

  // A still handed over by the Edit app (an upload, not a take).
  const routeKey = params.toString();
  useEffect(() => {
    const r = takeHandoff()?.refs[0];
    if (!r) return;
    const url = inputUrl(r.token);
    void (r.kind === 'video' ? probeClip(url).then((m) => ({ w: m.w, h: m.h, s: m.s })) : dimsOf(url).then((d) => ({ ...d, s: 0 })))
      .then((m) => setSrc({ kind: r.kind === 'video' ? 'video' : 'image', token: r.token, url, w: m.w, h: m.h, seconds: m.s, name: r.name }));
  }, [routeKey]);

  const video = src?.kind === 'video';
  const size = cutoutSize(src?.w ?? 0, src?.h ?? 0);
  const seconds = video ? Math.min(CUTOUT_MAX_SECONDS, Math.round((src?.seconds ?? 0) * 10) / 10) : 0;
  const est = useEstimate(src ? { kind: video ? 'video' : 'still', app: 'cutout', w: size.w, h: size.h, ...(video ? { seconds } : {}) } : null);
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && settingsOf(t).app === 'cutout'));

  async function addFile(f: File) {
    const isVideo = f.type.startsWith('video/');
    if (!isVideo && !f.type.startsWith('image/')) { toast('Drop a still (PNG, JPEG, WebP) or a clip (MP4, MOV)', true); return; }
    setBusy('Uploading...');
    try {
      const url = URL.createObjectURL(f);
      const meta = isVideo ? await probeClip(url) : { ...(await dimsOf(url)), s: 0 };
      const token = await uploadFile(f);
      setSrc({ kind: isVideo ? 'video' : 'image', token, url, w: meta.w, h: meta.h, seconds: meta.s, name: f.name.replace(/\.[^.]+$/, '') });
      setParams({ take: null });
      if (isVideo && meta.s > CUTOUT_MAX_SECONDS + 0.5) toast(`Using the first ${CUTOUT_MAX_SECONDS} seconds of the clip`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    } finally {
      setBusy(null);
    }
  }

  async function addBackground(f: File) {
    if (!f.type.startsWith('image/')) { toast('The new background is a still image', true); return; }
    setBusy('Uploading...');
    try { setBgImage(await uploadFile(f)); setBackground('image'); } catch (e) { toast(String(e), true); } finally { setBusy(null); }
  }

  usePageDrop('Drop a still or a clip to cut out', (files) => void addFile(files[0]));

  function cutoutBody() {
    const s = src!;
    const keep = subject.trim() || 'person';
    const body = {
      kind: 'cutout', app: 'cutout', mode: video ? mode : 'matte',
      sourceTake: s.take, image: !s.take && !video ? s.token : undefined, sourceVideo: !s.take && video ? s.token : undefined,
      subject: video && mode !== 'matte' ? keep : undefined,
      background, color: background === 'color' ? color : undefined, backgroundImage: background === 'image' ? bgImage ?? undefined : undefined,
      withAudio: video ? audio : undefined,
      userPrompt: `Remove background${video && mode !== 'matte' ? `: ${keep}` : ''}`,
      shotName: s.take ? undefined : `${s.name}_cutout`.slice(0, 40),
    };
    return body;
  }

  async function go() {
    if (!src) return;
    if (background === 'image' && !bgImage) { toast('Add the picture to put behind the subject', true); return; }
    setBusy('Queuing...');
    try {
      const r = await api.generate(cutoutBody());
      setView(null);
      toast(`Queued ${r.takeIds.length > 1 ? `${r.takeIds.length} cut outs` : 'the cut out'}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  const viewTake = takes.find((t) => t.id === view);

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <div className="display" style={{ fontSize: 26 }}>Remove background</div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>Cut the subject out of a still or a clip. Keep it transparent, or put it somewhere new.</div>

        <div className="rail-section">
          <div className="label">{video ? 'Clip' : src ? 'Still' : 'Still or clip'}</div>
          {src ? (
            <div className="ref" style={{ aspectRatio: `${src.w || 16} / ${src.h || 9}` }}>
              {video ? <video src={src.url} muted loop autoPlay playsInline /> : <img src={src.url} alt="" />}
              <span className="role start">{src.take ? `take ${src.take}` : video ? `${Math.min(CUTOUT_MAX_SECONDS, src.seconds).toFixed(1)}s` : 'your image'}</span>
              <button type="button" className="x" onClick={() => { setSrc(null); setParams({ take: null }); }} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <DropWell accept="image/*,video/*" onFile={(f) => void addFile(f)} icon="cutout" title="Add a still or a clip" sub={`Or open any take in the Library and pick Remove background. Clips up to ${CUTOUT_MAX_SECONDS} s.`} />
          )}
        </div>

        {video && (
          <div className="rail-section">
            <div className="label">How to follow it</div>
            <div className="seg">
              {CUTOUT_MODES.map((m) => (
                <button key={m.id} type="button" className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>{m.label}</button>
              ))}
            </div>
            <div className="dim" style={{ fontSize: 12.5 }}>{CUTOUT_MODES.find((m) => m.id === mode)!.note}</div>
            {mode !== 'matte' && (
              <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What to keep: person, the dog, the red car" />
            )}
          </div>
        )}

        <div className="rail-section">
          <div className="label">Background</div>
          <div className="seg">
            {CUTOUT_BACKGROUNDS.map((b) => (
              <button key={b.id} type="button" className={background === b.id ? 'on' : ''} onClick={() => setBackground(b.id)}>{b.label}</button>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 12.5 }}>{CUTOUT_BACKGROUNDS.find((b) => b.id === background)!.note}</div>
          {background === 'color' && (
            <div className="chip-row" style={{ alignItems: 'center' }}>
              {CUTOUT_COLORS.map((c) => (
                <button key={c} type="button" className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
              ))}
              <input type="color" className="swatch" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Pick a color" />
            </div>
          )}
          {background === 'image' && (bgImage ? (
            <div className="ref" style={{ aspectRatio: `${src?.w || 16} / ${src?.h || 9}` }}>
              <img src={inputUrl(bgImage)} alt="" />
              <span className="role">new background</span>
              <button type="button" className="x" onClick={() => setBgImage(null)} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <DropWell accept="image/*" onFile={(f) => void addBackground(f)} icon="image" compact title="+ Picture to put behind" sub="" />
          ))}
        </div>

        <div className="chip-row" style={{ alignItems: 'center' }}>
          {src && size.w > 0 && <span className="chip"><Icon name="aspect" size={14} />{size.w}x{size.h}</span>}
          {video && <span className="chip"><Icon name="clock" size={14} />{seconds}s</span>}
          {video && <span className="chip" style={{ gap: 10 }}><Icon name="audio" size={14} />Sound <Switch on={audio} onChange={setAudio} label="sound" /></span>}
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !src} onClick={() => void go()}>
          <span>{busy ?? 'Remove background'}</span>
          <span className="cost">{est ? fmtSeconds(est) : video && mode !== 'matte' ? 'BiRefNet + SAM 3.1' : 'BiRefNet'}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className={!viewTake ? 'on' : ''} onClick={() => setView(null)}>Cut outs</button>
            {viewTake && <button type="button" className="on">Before and after</button>}
          </div>
          {viewTake && <button type="button" className="icon-btn" onClick={() => setView(null)} aria-label="close"><Icon name="x" /></button>}
        </div>
        <div className="canvas-body">
          {viewTake ? <CutoutCompare take={viewTake} onOpen={() => setViewing(viewTake.id)} /> : takes.length === 0 ? (
            <div className="hero-empty">
              <div className="label" style={{ marginBottom: 14 }}>No green screen</div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>Keep the subject. <span className="hl">Lose the rest.</span></div>
              <div className="steps3">
                <div><span className="label">01</span><b>Add a still or a clip</b><span className="dim">Or press Remove background on any take.</span></div>
                <div><span className="label">02</span><b>Pick a background</b><span className="dim">Transparent, a color, a blur or a new picture.</span></div>
                <div><span className="label">03</span><b>Take it anywhere</b><span className="dim">PNG with alpha, or ProRes 4444 for your edit.</span></div>
              </div>
            </div>
          ) : (
            <div className="grid">
              {takes.map((t) => (
                <MediaCard key={t.id} take={t} onOpen={() => setView(t.id)} actions={<>
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

/** Drag-to-compare: the source on the left, the cut out (over a checkerboard) on the right. */
function CutoutCompare({ take, onOpen }: { take: Take; onOpen: () => void }) {
  const s = settingsOf(take);
  const [x, setX] = useState(50);
  const image = isImage(take);
  const before = s.sourceTake ? mediaUrl(Number(s.sourceTake)) : inputUrl(String(s.image ?? s.sourceVideo ?? ''));
  const set = (e: React.MouseEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); setX(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))); };
  const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } as const;
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {take.status !== 'done' ? <div className="empty">{take.status === 'failed' ? `Failed: ${take.error}` : 'Rendering...'}</div> : (
        <div className={`compare ${s.background === 'transparent' ? 'checker' : ''}`} style={{ aspectRatio: `${s.width} / ${s.height}` }}
          onMouseMove={(e) => { if (e.buttons === 1) set(e); }} onClick={set}>
          {image ? <img src={mediaUrl(take.id)} alt="" style={fill} /> : <video src={mediaUrl(take.id)} muted loop autoPlay playsInline style={fill} />}
          <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - x}% 0 0)` }}>
            {image ? <img src={before} alt="" style={fill} /> : <video src={before} muted loop autoPlay playsInline style={fill} />}
          </div>
          <div className="compare-line" style={{ left: `${x}%` }} />
          <span className="badge" style={{ position: 'absolute', top: 12, left: 12 }}>before</span>
          <span className="badge" style={{ position: 'absolute', top: 12, right: 12 }}>cut out</span>
        </div>
      )}
      <div className="dim" style={{ marginTop: 10, fontSize: 12.5 }}>
        Drag across the frame to compare.{!image && s.background === 'transparent' && ' The clip here is a preview over a checkerboard; the download keeps the alpha.'}
      </div>
      {take.status === 'done' && (
        <div className="chip-row" style={{ marginTop: 12, gap: 8 }}>
          <button type="button" className="btn sm accent" onClick={onOpen}><Icon name="sparkle" size={14} />Open</button>
          {s.alphaPath && <a className="btn sm" href={alphaUrl(take.id)}><Icon name="download" size={14} />ProRes 4444 with alpha</a>}
          <a className="btn sm" href={`${mediaUrl(take.id)}?download=1`}><Icon name="download" size={14} />{image ? (s.background === 'transparent' ? 'PNG with alpha' : 'PNG') : 'Preview MP4'}</a>
        </div>
      )}
    </div>
  );
}
