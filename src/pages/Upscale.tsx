/**
 * Upscale: more resolution for any take or file, three ways.
 *   Sharpen  ESRGAN 2x, fast and faithful (stills too).
 *   Redraw   SeedVR2 diffusion restoration at 1080/1440 (stills too).
 *   Dream    LTX-2.5 latent upscale + prompt-steered refine (video).
 * Results open in a before/after drag compare.
 */
import { useEffect, useRef, useState } from 'react';
import { downloadUrl, inputUrl, mediaUrl, posterUrl, uploadFile, type Take } from '../api';
import { setParams, useRoute } from '../router';
import { inFeed, isAudio, isImage, isModel, settingsOf, toast, useStore } from '../store';
import { ChipMenu, Icon, MediaCard, Spill, Switch, fmtSeconds, useEstimate, RailHandle, useRail } from '../ui';
import { recreate, remove } from '../Viewer';
import { DropWell } from './Mirror';
import { useDropZone, usePageDrop } from '../drop';
import { api } from '../api';
import {
  DREAM_CREATIVITY, DREAM_MAX_SECONDS, REDRAW_COLOR, REDRAW_HEIGHTS, REDRAW_MAX_SECONDS, REDRAW_MODELS, SHARPEN_MODELS, sharpenMaxSeconds,
  UPSCALE_MODES, upscaleSize, type RedrawColor, type RedrawModel, type SharpenModel, type UpscaleMode,
} from '../catalog';

interface Source {
  kind: 'video' | 'image';
  /** A finished take, or an uploaded file's token. */
  take?: number;
  token?: string;
  url: string;
  name: string;
  w: number;
  h: number;
  seconds: number;
}

/** Width, height and length of a piece of media, read by the browser. */
function measure(url: string, kind: 'video' | 'image'): Promise<{ w: number; h: number; s: number }> {
  return new Promise((res) => {
    if (kind === 'image') {
      const i = new Image();
      i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight, s: 0 });
      i.onerror = () => res({ w: 0, h: 0, s: 0 });
      i.src = url;
      return;
    }
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, s: v.duration });
    v.onerror = () => res({ w: 0, h: 0, s: 5 });
    v.src = url;
  });
}

const isUpscale = (t: Take) => t.kind === 'upres' || settingsOf(t).app === 'upscale';
const modeLabel = (m: string | undefined) => UPSCALE_MODES.find((x) => x.id === m)?.label ?? 'Sharpen';

export default function UpscalePage() {
  const { params } = useRoute();
  const mode = (UPSCALE_MODES.some((m) => m.id === params.get('mode')) ? params.get('mode') : 'sharpen') as UpscaleMode;
  const deepTake = Number(params.get('take')) || null;
  const [source, setSource] = useState<Source | null>(null);
  const [sharpModel, setSharpModel] = useState<SharpenModel>('esrgan');
  const [rife, setRife] = useState(false);
  const [redrawModel, setRedrawModel] = useState<RedrawModel>('3b');
  const [upHeight, setUpHeight] = useState<number>(REDRAW_HEIGHTS[0]);
  const [color, setColor] = useState<RedrawColor>('lab');
  const [creativity, setCreativity] = useState<number>(DREAM_CREATIVITY.default);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'takes' | 'library'>('takes');
  const [compare, setCompare] = useState<number | null>(null);

  const all = useStore((s) => s.takes);
  const takes = all.filter((t) => inFeed(t) && isUpscale(t));
  const library = all.filter((t) => inFeed(t) && t.status === 'done' && !!t.output_path && !isUpscale(t) && !isModel(t) && !isAudio(t)).slice(0, 60);

  async function pickTake(t: Take) {
    const kind = isImage(t) ? 'image' : 'video';
    const url = mediaUrl(t.id);
    const m = await measure(url, kind);
    const s = settingsOf(t);
    setSource({ kind, take: t.id, url, name: s.shotName || `take ${t.id}`, w: m.w || s.width || 0, h: m.h || s.height || 0, seconds: m.s || s.seconds || 0 });
    setTab('takes');
    setCompare(null);
  }

  // /upscale?take=<id> (the viewer's Upscale action) picks that take once it is loaded.
  const deepDone = useRef<number | null>(null);
  useEffect(() => {
    if (!deepTake || deepDone.current === deepTake) return;
    const t = all.find((x) => x.id === deepTake);
    if (!t) return;
    deepDone.current = deepTake;
    void pickTake(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepTake, all]);

  async function addFile(f: File) {
    const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
    if (!kind) { toast('Drop a video or an image', true); return; }
    if (f.size > 45e6) { toast('File is over 45 MB. Trim or re-encode it first.', true); return; }
    setBusy('Uploading...');
    try {
      const url = URL.createObjectURL(f);
      const m = await measure(url, kind);
      setSource({ kind, token: await uploadFile(f), url, name: f.name.replace(/\.[^.]+$/, ''), w: m.w, h: m.h, seconds: m.s });
      setParams({ take: null });
      setCompare(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    } finally {
      setBusy(null);
    }
  }

  // Upscale has one source slot for both kinds: a video or an image dropped
  // anywhere on the page (or on the filled slot) becomes the new source.
  usePageDrop('Drop a video or an image to upscale it', (files) => {
    const f = files[0];
    if (f.type.startsWith('video/') || f.type.startsWith('image/')) void addFile(f);
    else toast('Drop a video or an image', true);
  });
  const replaceZone = useDropZone((files) => void addFile(files[0]));

  const video = source?.kind === 'video';
  const out = source ? upscaleSize(mode, source.w, source.h, upHeight) : { w: 0, h: 0 };
  const cap = mode === 'dream' ? DREAM_MAX_SECONDS : mode === 'redraw' ? REDRAW_MAX_SECONDS : sharpenMaxSeconds(source?.w ?? 0, source?.h ?? 0);
  const seconds = video ? Math.round(Math.min(source!.seconds, cap) * 10) / 10 : 0;
  const blocked = mode === 'dream' && source?.kind === 'image' ? 'Dream works on video. Use Sharpen or Redraw for a still.' : null;
  const model = mode === 'sharpen' ? sharpModel : mode === 'redraw' ? redrawModel : undefined;
  const est = useEstimate(source ? {
    kind: video ? 'upres' : 'still', app: 'upscale', mode, ...(model ? { model } : {}), w: out.w, h: out.h, ...(video ? { seconds } : {}),
  } : null);
  const engine = mode === 'sharpen' ? SHARPEN_MODELS.find((m) => m.id === sharpModel)!.label : mode === 'redraw' ? 'SeedVR2' : 'LTX-2.5';

  async function go() {
    if (!source || blocked) return;
    setBusy('Queuing...');
    try {
      const r = await api.generate({
        kind: 'upscale', app: 'upscale', mode, sourceTake: source.take, source: source.token, sourceKind: source.kind,
        model, rife: mode === 'sharpen' && video ? rife : undefined,
        upHeight: mode === 'redraw' ? upHeight : undefined, color: mode === 'redraw' ? color : undefined,
        creativity: mode === 'dream' ? creativity : undefined, prompt: mode === 'dream' ? prompt : undefined,
        userPrompt: mode === 'dream' && prompt.trim() ? prompt : `${modeLabel(mode)} · ${engine}`,
        shotName: source.take ? undefined : source.name.slice(0, 40),
      });
      setCompare(null);
      setTab('takes');
      toast(`Queued ${modeLabel(mode).toLowerCase()} as take ${r.takeId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  const compareTake = takes.find((t) => t.id === compare);
  const modeDef = UPSCALE_MODES.find((m) => m.id === mode)!;

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        {source && <Spill src={source.take ? posterUrl(source.take) : source.url} video={!source.take && video} key={source.url} />}
        <div className="display" style={{ fontSize: 26 }}>Upscale</div>

        <div className="rail-section">
          <div className="label">Source</div>
          {source ? (
            <div className={`ref ${replaceZone.over ? 'drag' : ''}`} style={{ aspectRatio: `${source.w || 16} / ${source.h || 9}` }} {...replaceZone.props}>
              {video ? <video src={source.url} muted loop autoPlay playsInline /> : <img src={source.url} alt="" />}
              <span className="role">{source.w}x{source.h}{video ? ` · ${source.seconds.toFixed(1)}s` : ''}</span>
              <button type="button" className="x" onClick={() => { setSource(null); setParams({ take: null }); }} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <DropWell accept="video/*,image/*" onFile={addFile} icon="up" title="Add a video or an image" sub="MP4, MOV, PNG, JPG or WebP, up to 45 MB." />
          )}
          <button type="button" className={`btn sm ${tab === 'library' ? 'accent' : ''}`} onClick={() => { setCompare(null); setTab(tab === 'library' ? 'takes' : 'library'); }}>
            <Icon name="grid" size={14} />Pick from library
          </button>
        </div>

        <div className="seg">
          {UPSCALE_MODES.map((m) => (
            <button key={m.id} type="button" className={mode === m.id ? 'on' : ''} onClick={() => setParams({ mode: m.id === 'sharpen' ? null : m.id })}>{m.label}</button>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>{modeDef.note}</div>

        {mode === 'sharpen' && (
          <div className="rail-section">
            <div className="label">Model</div>
            {SHARPEN_MODELS.map((m) => (
              <button key={m.id} type="button" className="rail-row" onClick={() => setSharpModel(m.id)} style={sharpModel === m.id ? { borderColor: 'rgba(255, 102, 0, 0.6)' } : undefined}>
                <span><span className="val" style={{ color: sharpModel === m.id ? 'var(--accent-hi)' : undefined }}>{m.label}</span><span className="dim" style={{ fontSize: 12 }}>{m.note}</span></span>
                {sharpModel === m.id && <Icon name="chev" size={14} />}
              </button>
            ))}
            {video && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="dim" style={{ fontSize: 12.5 }}>Double the frame rate (RIFE)</span>
                <Switch on={rife} onChange={setRife} label="double the frame rate" />
              </div>
            )}
          </div>
        )}

        {mode === 'redraw' && (
          <div className="rail-section">
            <div className="label">Model</div>
            <div className="seg">
              {REDRAW_MODELS.map((m) => <button key={m.id} type="button" className={redrawModel === m.id ? 'on' : ''} onClick={() => setRedrawModel(m.id)}>{m.label}</button>)}
            </div>
            <div className="dim" style={{ fontSize: 12 }}>{REDRAW_MODELS.find((m) => m.id === redrawModel)!.note}</div>
            <div className="label" style={{ marginTop: 4 }}>Target</div>
            <div className="seg">
              {REDRAW_HEIGHTS.map((h) => <button key={h} type="button" className={upHeight === h ? 'on' : ''} onClick={() => setUpHeight(h)}>{h}p</button>)}
            </div>
            <div className="chip-row">
              <ChipMenu icon="palette" label="Color" value={color} onChange={(v) => setColor(v as RedrawColor)} dir="down" title="Color"
                options={REDRAW_COLOR.map((c) => ({ value: c.id, label: c.label, note: c.note }))} />
            </div>
          </div>
        )}

        {mode === 'dream' && (
          <>
            <div className="rail-section">
              <div className="label">What to add or reimagine · optional</div>
              <textarea className="prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder="Wet cobblestones, embroidered fabric, frost on the glass." />
            </div>
            <div className="rail-section">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="label">Creativity</span><span className="mono dim" style={{ fontSize: 12 }}>{creativity.toFixed(2)}</span></div>
              <input type="range" min={DREAM_CREATIVITY.min} max={DREAM_CREATIVITY.max} step={0.05} value={creativity} onChange={(e) => setCreativity(Number(e.target.value))} />
              <div style={{ display: 'flex', justifyContent: 'space-between' }} className="label"><span>Faithful</span><span>Reimagined</span></div>
            </div>
          </>
        )}

        {source && (
          <div className="chip-row" style={{ alignItems: 'center' }}>
            <span className="chip"><Icon name="aspect" size={14} />{source.w}x{source.h} → {out.w}x{out.h}</span>
            {video && <span className="chip"><Icon name="clock" size={14} />{seconds}s{source.seconds > cap + 0.05 ? ` of ${source.seconds.toFixed(1)}` : ''}</span>}
          </div>
        )}
        {blocked && <div className="dim" style={{ fontSize: 12.5, color: 'var(--accent-hi)' }}>{blocked}</div>}

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !source || !!blocked} onClick={() => void go()}>
          <span>{busy ?? modeDef.label}</span>
          <span className="cost">{est ? fmtSeconds(est) : engine}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className={tab === 'takes' && !compareTake ? 'on' : ''} onClick={() => { setTab('takes'); setCompare(null); }}>Takes</button>
            <button type="button" className={tab === 'library' && !compareTake ? 'on' : ''} onClick={() => { setTab('library'); setCompare(null); }}>Library</button>
            {compareTake && <button type="button" className="on">Before and after</button>}
          </div>
          {compareTake && <button type="button" className="icon-btn" onClick={() => setCompare(null)} aria-label="close"><Icon name="x" /></button>}
        </div>
        <div className="canvas-body">
          {compareTake ? <BeforeAfter take={compareTake} /> : tab === 'library' ? (
            library.length === 0 ? <div className="empty">No finished takes yet. Drop a file in the source well instead.</div> : (
              <>
                <div className="label" style={{ marginBottom: 12 }}>Pick a take to upscale</div>
                <div className="grid dense">
                  {library.map((t) => (
                    <div key={t.id} style={source?.take === t.id ? { borderRadius: 12, boxShadow: '0 0 0 2px var(--accent)' } : undefined}>
                      <MediaCard take={t} onOpen={() => void pickTake(t)} />
                    </div>
                  ))}
                </div>
              </>
            )
          ) : takes.length === 0 ? (
            <div className="hero-empty">
              <div className="label" style={{ marginBottom: 14 }}>More pixels, three ways</div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>Sharpen it, redraw it, <span className="hl">or dream it bigger</span></div>
              <div className="steps3">
                <div><span className="label">01</span><b>Sharpen</b><span className="dim">2x in seconds. Every pixel stays where it was.</span></div>
                <div><span className="label">02</span><b>Redraw</b><span className="dim">SeedVR2 rebuilds texture and fine detail at 1080p or 1440p.</span></div>
                <div><span className="label">03</span><b>Dream</b><span className="dim">LTX-2.5 re-imagines the clip at 2x, steered by your words.</span></div>
              </div>
            </div>
          ) : (
            <div className="grid">
              {takes.map((t) => (
                <MediaCard key={t.id} take={t} onOpen={() => setCompare(t.id)} actions={<>
                  <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                  <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                </>} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** The source an upscale take was made from, as a URL. */
function beforeUrl(t: Take): string | null {
  const s = settingsOf(t);
  const take = s.sourceTake ?? s.upresOf;
  if (take) return mediaUrl(take);
  return s.source ? inputUrl(s.source) : null;
}

/**
 * Drag-to-compare for an upscale: the source, scaled up by the browser, on the
 * left of the line, the result on the right. "Pixels" zooms both to the
 * result's native size and pans with the pointer, which is where an upscale
 * shows.
 */
function BeforeAfter({ take }: { take: Take }) {
  const s = settingsOf(take);
  const image = isImage(take);
  const before = beforeUrl(take);
  const [x, setX] = useState(50);
  const [zoom, setZoom] = useState<'fit' | 'pixels'>('fit');
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const [scale, setScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (zoom === 'fit' || !box.current) { setScale(1); return; }
    setScale(Math.max(1, (s.width || 1) / box.current.getBoundingClientRect().width));
  }, [zoom, s.width]);

  const sync = () => { if (a.current && b.current && Math.abs(a.current.currentTime - b.current.currentTime) > 0.08) a.current.currentTime = b.current.currentTime; };
  const rel = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { px: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)), py: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)) };
  };
  const layer = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${scale})`, transformOrigin: `${origin.x}% ${origin.y}%` } as const;
  const media = (src: string, ref: React.RefObject<HTMLVideoElement | null>, lead: boolean) => image
    ? <img src={src} alt="" style={{ ...layer, imageRendering: scale > 1 ? 'auto' : undefined }} draggable={false} />
    : <video ref={ref} src={src} muted loop autoPlay playsInline onTimeUpdate={lead ? sync : undefined} style={layer} />;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <div ref={box} className="compare" style={{ aspectRatio: `${s.width || 16} / ${s.height || 9}` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); setX(rel(e).px); }}
        onPointerUp={() => setDragging(false)}
        onPointerMove={(e) => {
          const p = rel(e);
          if (dragging) setX(p.px);
          else if (scale > 1) setOrigin({ x: p.px, y: p.py });
        }}>
        {media(mediaUrl(take.id), b, true)}
        {before && <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', clipPath: `inset(0 ${100 - x}% 0 0)` }}>{media(before, a, false)}</div>}
        <div className="compare-line" style={{ left: `${x}%` }}><span><Icon name="mirror" size={14} /></span></div>
        <span className="badge" style={{ position: 'absolute', top: 12, left: 12 }}>before · {s.sourceWidth ?? '?'}x{s.sourceHeight ?? '?'}</span>
        <span className="badge" style={{ position: 'absolute', top: 12, right: 12 }}>{modeLabel(s.mode)} · {s.width}x{s.height}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        <div className="dim" style={{ fontSize: 12.5 }}>
          Drag across the frame to compare.{scale > 1 ? ' Move the pointer to look around.' : ''}
          {take.render_seconds ? ` Rendered in ${Math.round(take.render_seconds)}s on this GPU.` : ''}
          {!before && ' The source of this take is no longer available.'}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <div className="seg" style={{ width: 170 }}>
            <button type="button" className={zoom === 'fit' ? 'on' : ''} onClick={() => setZoom('fit')}>Fit</button>
            <button type="button" className={zoom === 'pixels' ? 'on' : ''} onClick={() => setZoom('pixels')}>Pixels</button>
          </div>
          <a className="btn sm" href={downloadUrl(take.id)}><Icon name="download" size={14} />Download</a>
        </div>
      </div>
      {s.mode === 'dream' && <div className="dim" style={{ marginTop: 8, fontSize: 12.5 }}>Creativity {Number(s.creativity).toFixed(2)} · {s.userPrompt}</div>}
    </div>
  );
}
