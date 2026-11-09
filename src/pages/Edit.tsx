/**
 * Edit: change a still with words (Qwen-Image-Edit 2509), plus the one-click
 * image apps that compile chip picks into a batch of edits: New angle,
 * Coverage, Push in, Next beat, Relight, Expand. Every result is an ordinary
 * still take, so Library, the Viewer and Animate all work on it.
 */
import { useEffect, useRef, useState } from 'react';
import { api, inputUrl, mediaUrl, takeAsInput, uploadFile, type Take } from '../api';
import { EDIT_APPS, EXPAND_ASPECTS, RELIGHT_DIRECTIONS, IMAGE_QUALITY, editAppById, editVariants, type EditMode } from '../catalog';
import { navigate, setParams, useRoute } from '../router';
import { inFeed, setHandoff, settingsOf, toast, useStore } from '../store';
import { ChipMenu, Clip, Icon, MediaCard, Spill, Stepper, fmtSeconds, presetClip, useEstimate, RailHandle, useRail } from '../ui';
import Viewer, { animate, recreate, remove } from '../Viewer';
import { useDropZone, usePageDrop } from '../drop';
import { DropWell } from './Mirror';
import { MentionBox } from '../Mention';

interface Source { token: string; w: number; h: number; take?: number }

/** Pixel size of an image URL, read by the browser. */
function dimsOf(url: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res({ w: 0, h: 0 });
    im.src = url;
  });
}

/** Output size of an edit at 1 MP, mirroring server/graphs/edit.ts editSize (for the estimate and the chip). */
function outSize(w: number, h: number) {
  if (!w || !h) return { w: 1328, h: 752 };
  const ratio = w / h;
  const hh = Math.sqrt(1e6 / ratio);
  const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return { w: snap(hh * ratio), h: snap(hh) };
}

export default function EditPage() {
  const { params } = useRoute();
  const app = editAppById(params.get('app') || 'free');
  const fromTake = Number(params.get('take')) || null;
  const [source, setSource] = useState<Source | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [mask, setMask] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [chips, setChips] = useState<string[]>(app.defaults);
  const [direction, setDirection] = useState('auto');
  const [expandTo, setExpandTo] = useState('16:9');
  const [zoom, setZoom] = useState(0.8);
  const [quality, setQuality] = useState<'draft' | 'quality'>('draft');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<'takes' | 'mask' | number>('takes');
  const [viewing, setViewing] = useState<number | null>(null);

  // A deep link swaps the source under an open viewer; close it.
  useEffect(() => { setViewing(null); }, [fromTake]);
  // A new app starts from its own default picks.
  useEffect(() => { setChips(app.defaults); }, [app.id]);
  // Deep link from the Viewer: /edit?app=angle&take=44 preloads that still.
  useEffect(() => {
    if (!fromTake || source?.take === fromTake) return;
    let live = true;
    setBusy('Loading the image...');
    takeAsInput(fromTake)
      .then(async (token) => {
        const d = await dimsOf(inputUrl(token));
        if (live) { setSource({ token, ...d, take: fromTake }); setMask(null); }
      })
      .catch((e) => toast(e instanceof Error ? e.message : 'could not load that take', true))
      .finally(() => live && setBusy(null));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromTake]);

  const expandRatio = EXPAND_ASPECTS.find((a) => a.id === expandTo)?.ratio || 0;
  const size = app.id === 'expand' && expandRatio
    ? outSize(expandRatio * 1000, 1000)
    : outSize(source?.w ?? 0, source?.h ?? 0);
  const est = useEstimate({ kind: 'still', model: 'qwen-edit', quality, w: size.w, h: size.h });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && settingsOf(t).app === 'edit'));
  const many = app.id === 'free' || app.id === 'expand';
  let planned = 0;
  try { planned = editVariants(app.id, { text, chips, direction, count }).length; } catch { planned = 0; }

  async function addSource(f: File) {
    if (!f.type.startsWith('image/')) { toast('Drop an image (PNG, JPEG or WebP)', true); return; }
    setBusy('Uploading...');
    try {
      const token = await uploadFile(f);
      setSource({ token, ...(await dimsOf(URL.createObjectURL(f))) });
      setMask(null);
      setParams({ take: null });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    } finally {
      setBusy(null);
    }
  }

  async function addRef(f: File) {
    if (!f.type.startsWith('image/')) return;
    setBusy('Uploading...');
    try { const t = await uploadFile(f); setRefs((r) => [...r, t].slice(0, 2)); } catch (e) { toast(String(e), true); } finally { setBusy(null); }
  }

  // A drop anywhere on the page fills the first empty image slot: the image
  // being edited, then (free mode) images 2 and 3. With every slot full it
  // replaces the image being edited.
  usePageDrop('Drop an image to edit it', (files) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) { toast('Drop an image (PNG, JPEG or WebP)', true); return; }
    const open = app.id === 'free' ? 2 - refs.length : 0;
    void (async () => {
      if (!source) {
        await addSource(imgs[0]);
        for (const f of imgs.slice(1, 1 + open)) await addRef(f);
      } else if (open > 0) {
        for (const f of imgs.slice(0, open)) await addRef(f);
      } else {
        await addSource(imgs[0]);
      }
    })();
  });
  // Dropping onto the filled image slot swaps the image.
  const replaceZone = useDropZone((files) => void addSource(files[0]));

  async function useAsSource(t: Take) {
    setParams({ take: String(t.id) });
    setView('takes');
  }

  async function go() {
    if (!source) return;
    setBusy('Queuing...');
    try {
      const variants = editVariants(app.id, { text, chips, direction, count });
      const ratio = EXPAND_ASPECTS.find((a) => a.id === expandTo)?.ratio ?? 0;
      const r = await api.generate({
        kind: 'edit', app: 'edit', mode: app.id, model: 'qwen-edit', quality,
        images: [source.token, ...(app.id === 'free' ? refs : [])], mask: app.id === 'free' ? mask ?? undefined : undefined,
        expand: app.id === 'expand' ? { aspect: ratio, zoom } : undefined, sourceTake: source.take,
        variants: variants.map((v) => ({ label: v.label, instruction: v.instruction, prompt: v.instruction, userPrompt: app.id === 'free' ? v.label : `${app.name}: ${v.label}` })),
        shotName: `${app.id === 'free' ? 'edit' : app.id}_${(text || app.name).slice(0, 30)}`,
      });
      setView('takes');
      toast(`Queued ${r.takeIds.length} edit${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  const toggle = (id: string) => setChips((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const compareTake = typeof view === 'number' ? takes.find((t) => t.id === view) : undefined;
  const batches = groupBatches(takes);

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <Spill src={presetClip(app.cover)} video />
        <div className="display" style={{ fontSize: 26 }}>{app.name}</div>
        <div className="edit-apps">
          {EDIT_APPS.map((a) => (
            <button key={a.id} type="button" className={`edit-app ${a.id === app.id ? 'on' : ''}`} onClick={() => setParams({ app: a.id === 'free' ? null : a.id })} title={a.blurb}>
              <Icon name={a.icon} size={14} /><span>{a.name}</span>
            </button>
          ))}
          <button type="button" className="edit-app" title="Cut the subject out: a transparent PNG, or a new background" onClick={() => {
            if (source && !source.take) setHandoff({ refs: [{ token: source.token, role: 'start', kind: 'image', name: 'your image' }] });
            navigate(`/cutout${source?.take ? `?take=${source.take}` : ''}`);
          }}><Icon name="cutout" size={14} /><span>Remove background</span></button>
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>{app.blurb}</div>

        <div className="rail-section">
          <div className="label">Image</div>
          {source ? (
            <div className={`ref ${replaceZone.over ? 'drag' : ''}`} style={{ aspectRatio: `${source.w || 16} / ${source.h || 9}` }} {...replaceZone.props}>
              <img src={inputUrl(source.token)} alt="" />
              <span className="role start">{source.take ? `take ${source.take}` : 'your image'}</span>
              <button type="button" className="x" onClick={() => { setSource(null); setMask(null); setParams({ take: null }); }} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <DropWell accept="image/*" onFile={addSource} icon="image" title="Add the image to change" sub="Or open any still in the Library and pick Edit." />
          )}
        </div>

        {app.id === 'free' && (
          <div className="rail-section">
            <div className="label">More images · optional</div>
            <div className="ref-row">
              {refs.map((t, i) => (
                <div key={t} className="ref">
                  <img src={inputUrl(t)} alt="" />
                  <span className="role">image {i + 2}</span>
                  <button type="button" className="x" onClick={() => setRefs((r) => r.filter((x) => x !== t))} aria-label="remove"><Icon name="x" size={12} /></button>
                </div>
              ))}
              {refs.length < 2 && <DropWell accept="image/*" onFile={addRef} icon="ref" compact title="+ Image" sub="" />}
            </div>
            <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Refer to them by number: put the jacket from image 2 on the man in image 1.</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <button type="button" className={`chip ${view === 'mask' ? 'on' : ''}`} disabled={!source} onClick={() => setView(view === 'mask' ? 'takes' : 'mask')}>
                <Icon name="wand" size={14} />{mask ? 'Mask painted' : 'Paint where to change'}
              </button>
              {mask && <button type="button" className="btn sm ghost" onClick={() => setMask(null)}>Clear mask</button>}
            </div>
          </div>
        )}

        {app.chips.length > 0 && (
          <div className="rail-section">
            <div className="label">{app.id === 'relight' ? 'Light' : app.id === 'next' ? 'Beats' : app.id === 'pushin' ? 'Steps' : 'Shots'} · {chips.length} picked</div>
            <div className="chip-row">
              {app.chips.map((c) => (
                <button key={c.id} type="button" className={`chip ${chips.includes(c.id) ? 'on' : ''}`} onClick={() => toggle(c.id)}>{c.label}</button>
              ))}
            </div>
          </div>
        )}

        {app.id === 'relight' && (
          <div className="rail-section">
            <div className="label">Coming from</div>
            <div className="chip-row">
              {RELIGHT_DIRECTIONS.map((d) => (
                <button key={d.id} type="button" className={`chip ${direction === d.id ? 'on' : ''}`} onClick={() => setDirection(d.id)}>{d.label}</button>
              ))}
            </div>
          </div>
        )}

        {app.id === 'expand' && (
          <div className="rail-section">
            <div className="label">New shape</div>
            <div className="chip-row">
              {EXPAND_ASPECTS.map((a) => (
                <button key={a.id} type="button" className={`chip ${expandTo === a.id ? 'on' : ''}`} onClick={() => setExpandTo(a.id)}>{a.label}</button>
              ))}
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="dim" style={{ fontSize: 12.5 }}>Pull back</span><span className="mono" style={{ fontSize: 12 }}>{Math.round((1 - zoom) * 100)}%</span></div>
              <input type="range" min={0.5} max={1} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>0% fills the new shape edge to edge. More leaves room on every side.</div>
            </div>
          </div>
        )}

        <div className="rail-section">
          <div className="label">{app.id === 'free' ? 'What to change' : 'Direction · optional'}</div>
          <MentionBox className="prompt" rows={3} value={text} onChange={setText} placeholder={app.id === 'free' ? `${app.hint} Type @ to bring in your cast.` : app.hint}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && source && !busy) void go(); }} />
        </div>

        <div className="chip-row" style={{ alignItems: 'center' }}>
          <ChipMenu icon="res" value={quality} onChange={setQuality} title="Quality"
            options={IMAGE_QUALITY.map((q) => ({ value: q.id, label: q.label, note: q.id === 'draft' ? '8 steps, ~9s each' : '20 steps, ~40s each' }))} />
          <span className="chip"><Icon name="aspect" size={14} />{source ? `${size.w}x${size.h}` : '1 MP'}</span>
          {many && <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />}
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !source || !planned} onClick={() => void go()}>
          <span>{busy ?? (planned > 1 ? `${app.id === 'free' ? 'Edit' : app.name} · ${planned}` : app.id === 'free' ? 'Edit' : app.name)}</span>
          <span className="cost">{est ? fmtSeconds(est * Math.max(1, planned)) : 'Qwen-Image-Edit'}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className={view === 'takes' ? 'on' : ''} onClick={() => setView('takes')}>Results</button>
            {view === 'mask' && <button type="button" className="on">Mask</button>}
            {compareTake && <button type="button" className="on">Before and after</button>}
          </div>
          {view !== 'takes' && <button type="button" className="icon-btn" onClick={() => setView('takes')} aria-label="close"><Icon name="x" /></button>}
        </div>
        <div className="canvas-body">
          {view === 'mask' && source ? (
            <MaskPainter source={source} onDone={(token) => { setMask(token); setView('takes'); }} onCancel={() => setView('takes')} />
          ) : compareTake ? (
            <StillCompare take={compareTake} actions={<>
              <button type="button" className="btn sm accent" onClick={() => setViewing(compareTake.id)}><Icon name="sparkle" size={14} />Open</button>
              <button type="button" className="btn sm" onClick={() => void useAsSource(compareTake)}><Icon name="redo" size={14} />Keep editing this</button>
              <button type="button" className="btn sm" onClick={() => void animate(compareTake)}><Icon name="video" size={14} />Animate</button>
            </>} />
          ) : batches.length === 0 ? (
            <div className="hero-empty">
              <div className="fan">
                {['orbit-right', 'golden', 'push-in', 'pull-back'].map((id) => <div key={id}><Clip src={presetClip(id)} className="" /></div>)}
              </div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>Change a still <span className="hl">with words</span></div>
              <div className="steps3">
                <div><span className="label">01</span><b>Add an image</b><span className="dim">Or press Edit on any still in the Library.</span></div>
                <div><span className="label">02</span><b>Pick an app</b><span className="dim">A new angle, nine shots, new light, a bigger frame.</span></div>
                <div><span className="label">03</span><b>Compare</b><span className="dim">Drag across any result to see what changed.</span></div>
              </div>
            </div>
          ) : (
            <div className="edit-batches">
              {batches.map((b) => (
                <div key={b.key} className="edit-batch">
                  <div className="label">{b.title}</div>
                  <div className={`grid edit-grid n${Math.min(b.takes.length, 9)}`}>
                    {b.takes.map((t) => (
                      <MediaCard key={t.id} take={t} onOpen={() => setView(t.id)} actions={<>
                        {t.status === 'done' && <button type="button" className="icon-btn" title="Keep editing this" onClick={() => void useAsSource(t)}><Icon name="wand" size={14} /></button>}
                        {t.status === 'done' && <button type="button" className="icon-btn" title="Animate" onClick={() => void animate(t)}><Icon name="video" size={14} /></button>}
                        <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                        <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                      </>} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={() => {}} />}
    </div>
  );
}

/** Takes grouped by the request that made them, newest first. */
function groupBatches(takes: Take[]): { key: string; title: string; takes: Take[] }[] {
  const out: { key: string; title: string; takes: Take[] }[] = [];
  const index = new Map<string, number>();
  for (const t of takes) {
    const s = settingsOf(t);
    const key = s.batch ?? `t${t.id}`;
    if (!index.has(key)) {
      const app = editAppById(s.mode ?? 'free');
      const what = s.mode === 'free' || !s.mode ? (s.label ?? s.instruction ?? '') : app.name;
      index.set(key, out.length);
      out.push({ key, title: `${what}${s.sourceTake ? ` · from take ${s.sourceTake}` : ''}`, takes: [] });
    }
    out[index.get(key)!].takes.push(t);
  }
  for (const b of out) b.takes.sort((x, y) => (settingsOf(x).batchIndex ?? 0) - (settingsOf(y).batchIndex ?? 0));
  return out;
}

/** Drag-to-compare for stills: the source on the left, the edit on the right. */
export function StillCompare({ take, actions }: { take: Take; actions?: React.ReactNode }) {
  const s = settingsOf(take);
  const [x, setX] = useState(50);
  const before = Array.isArray(s.images) ? s.images[0] : undefined;
  // Expand: the original sits inside the bigger canvas, so place it there.
  const inner = s.inner as { x: number; y: number; w: number; h: number } | undefined;
  const pos = inner && s.width && s.height
    ? { left: `${(inner.x / s.width) * 100}%`, top: `${(inner.y / s.height) * 100}%`, width: `${(inner.w / s.width) * 100}%`, height: `${(inner.h / s.height) * 100}%` }
    : { left: 0, top: 0, width: '100%', height: '100%' };
  const set = (e: React.MouseEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); setX(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))); };
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {take.status !== 'done' ? <div className="empty">{take.status === 'failed' ? `Failed: ${take.error}` : 'Rendering...'}</div> : (
        <div className="compare" style={{ aspectRatio: `${s.width} / ${s.height}` }}
          onMouseMove={(e) => { if (e.buttons === 1) set(e); }} onClick={set}>
          <img src={mediaUrl(take.id)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          {before && (
            <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - x}% 0 0)`, background: inner ? '#08090b' : undefined }}>
              <img src={inputUrl(before)} alt="" style={{ position: 'absolute', ...pos, objectFit: 'cover' }} />
            </div>
          )}
          <div className="compare-line" style={{ left: `${x}%` }} />
          <span className="badge" style={{ position: 'absolute', top: 12, left: 12 }}>before</span>
          <span className="badge" style={{ position: 'absolute', top: 12, right: 12 }}>after</span>
        </div>
      )}
      <div className="dim" style={{ marginTop: 10, fontSize: 12.5 }}>Drag across the frame to compare. {s.userPrompt}</div>
      {s.instruction && (
        <details style={{ marginTop: 8 }}>
          <summary className="label" style={{ cursor: 'pointer' }}>Instruction sent to the model</summary>
          <div className="compiled" style={{ marginTop: 6 }}>{s.instruction}</div>
        </details>
      )}
      {actions && <div className="chip-row" style={{ marginTop: 12, gap: 8 }}>{actions}</div>}
    </div>
  );
}

/**
 * Paint where the edit may change. White strokes on black at the source's own
 * resolution, uploaded as a PNG; the graph keeps every black pixel as it was.
 */
function MaskPainter({ source, onDone, onCancel }: { source: Source; onDone: (token: string) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [brush, setBrush] = useState(0.06);
  const [saving, setSaving] = useState(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const W = source.w || 1024;
  const H = source.h || 576;

  useEffect(() => {
    const c = canvas.current!.getContext('2d')!;
    c.clearRect(0, 0, W, H);
  }, [W, H]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const paint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1) { last.current = null; return; }
    const c = canvas.current!.getContext('2d')!;
    const p = at(e);
    c.strokeStyle = 'rgba(255, 102, 0, 1)';
    c.lineWidth = brush * Math.max(W, H);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(last.current?.x ?? p.x, last.current?.y ?? p.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    last.current = p;
  };

  async function save() {
    setSaving(true);
    try {
      // The visible strokes are amber over the photo; the mask is the same
      // strokes in white on black.
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const o = out.getContext('2d')!;
      o.fillStyle = '#000'; o.fillRect(0, 0, W, H);
      o.filter = 'brightness(0) invert(1)';
      o.drawImage(canvas.current!, 0, 0);
      // Feather the edge so the new pixels blend into the kept ones.
      const soft = document.createElement('canvas');
      soft.width = W; soft.height = H;
      const sc = soft.getContext('2d')!;
      sc.filter = `blur(${Math.round(Math.max(W, H) * 0.012)}px)`;
      sc.drawImage(out, 0, 0);
      o.filter = 'none';
      o.drawImage(soft, 0, 0);
      const blob = await new Promise<Blob>((res) => out.toBlob((b) => res(b!), 'image/png'));
      onDone(await uploadFile(new File([blob], 'mask.png', { type: 'image/png' })));
      toast('Mask set. Only the painted area will change.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the mask', true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="compare" style={{ aspectRatio: `${W} / ${H}`, cursor: 'crosshair' }}>
        <img src={inputUrl(source.token)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        <canvas ref={canvas} width={W} height={H} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); last.current = null; paint(e); }} onPointerMove={paint}
          onPointerUp={() => { last.current = null; }} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.55, touchAction: 'none' }} />
      </div>
      <div className="chip-row" style={{ marginTop: 12, alignItems: 'center', gap: 8 }}>
        <span className="dim" style={{ fontSize: 12.5 }}>Brush</span>
        <input type="range" min={0.02} max={0.16} step={0.01} value={brush} onChange={(e) => setBrush(Number(e.target.value))} style={{ width: 140, accentColor: 'var(--accent)' }} />
        <button type="button" className="btn sm" onClick={() => canvas.current!.getContext('2d')!.clearRect(0, 0, W, H)}>Clear</button>
        <button type="button" className="btn sm accent" disabled={saving} onClick={() => void save()}>Use this mask</button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>Cancel</button>
      </div>
      <div className="dim" style={{ marginTop: 8, fontSize: 12.5 }}>Paint over what should change. Everything you leave unpainted comes back exactly as it was.</div>
    </div>
  );
}
