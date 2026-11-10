/**
 * Image: create stills from a prompt (and reference pictures) on any installed
 * image model. Left rail = the controls (model, format, references, prompt,
 * LoRAs); the canvas on the right is your images, newest first.
 */
import { useEffect, useRef, useState } from 'react';
import { api, inputUrl, uploadFile } from '../api';
import { useDropZone, usePageDrop } from '../drop';
import { ASPECTS, IMAGE_MODELS, IMAGE_QUALITY, IMAGE_RES, imageModelById, sizeFor, type AspectId } from '../catalog';
import { navigate, setParams, useRoute } from '../router';
import { inFeed, isImage, setHandoff, toast, useStore } from '../store';
import { ChipMenu, Clip, Icon, MediaCard, ModelPicker, RailHandle, Spill, Stepper, fmtSeconds, presetClip, useEstimate, useRail } from '../ui';
import { LoraChips, useLoraPicks } from '../Loras';
import Viewer, { animate, recreate, remove } from '../Viewer';
import { MentionBox } from '../Mention';
import { MediaPicker, sourceToFile } from '../SourcePick';

/** Qwen-Image 2.1, FLUX.2 dev and FLUX.3 take up to six reference
 *  pictures, your own plus any @cast; Qwen-Image renders them through
 *  Qwen-Image-Edit 2509, which holds three. Krea-2, Z-Image and FLUX.2
 *  Klein are t2i only (their weights render spliced reference latents with
 *  artifacts or noise). */
const MAX_REFS = 6;

/** Adds reference pictures: browse the device, pick from the cast, or the library. */
function RefWell({ onFiles, compact, hint }: { onFiles: (f: File[]) => void; compact?: boolean; hint: string }) {
  return (
    <MediaPicker
      accept={['image']}
      title={compact ? '+ Add reference' : 'Add references'}
      sub={hint}
      icon="image"
      onPick={(s) => void sourceToFile(s).then((f) => { if (f) onFiles([f]); else toast('could not load that media', true); })}
    />
  );
}

export default function ImagePage() {
  const { params } = useRoute();
  const model = imageModelById(params.get('model') ?? 'qwen');
  const [prompt, setPrompt] = useState(() => params.get('prompt') ?? '');
  // A link (Cast page: Still) carries its prompt once; drop it from the URL after reading.
  useEffect(() => { if (params.get('prompt')) setParams({ prompt: null }); }, []);
  const [aspect, setAspect] = useState<AspectId>('16:9');
  const [quality, setQuality] = useState<'draft' | 'quality'>('draft');
  const [res, setRes] = useState<'1K' | '2K'>('1K');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loras, setLoras] = useLoraPicks(model.loraFamily);
  const [refs, setRefs] = useState<{ token: string; name: string }[]>([]);
  const [title, setTitle] = useState('');
  const [viewing, setViewing] = useState<number | null>(null);
  const [railOpen, toggleRail] = useRail();
  const refsOn = !!model.refs;
  // Qwen-Image renders its references through Qwen-Image-Edit 2509, which holds three.
  const maxRefs = model.id === 'qwen' ? 3 : MAX_REFS;

  // Switching model clears the references (only some models take them).
  useEffect(() => { setRefs([]); }, [model.id]);

  async function addRefs(files: File[]) {
    for (const f of files.filter((x) => x.type.startsWith('image/'))) {
      try {
        const token = await uploadFile(f);
        setRefs((cur) => [...cur, { token, name: f.name }].slice(0, maxRefs));
      } catch (e) { toast(e instanceof Error ? e.message : 'upload failed', true); }
    }
  }

  usePageDrop(refsOn ? 'Drop images to use as references' : 'Drop an image to animate it', async (files) => {
    if (refsOn) { void addRefs(files); return; }
    const f = files.find((x) => x.type.startsWith('image/'));
    if (!f) { toast('Drop an image to animate it', true); return; }
    try {
      setHandoff({ refs: [{ token: await uploadFile(f), role: 'start', kind: 'image', name: f.name }] });
      navigate('/video');
    } catch (e) { toast(e instanceof Error ? e.message : 'upload failed', true); }
  });

  const size = sizeFor(aspect, IMAGE_RES.find((r) => r.id === res)!.mp);
  const est = useEstimate({ kind: 'still', model: model.id, quality, w: size.w, h: size.h });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && isImage(t)));
  const done = takes.filter((t) => t.status === 'done');

  async function go() {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const r = await api.generate({
        kind: 'still', model: model.id, quality, prompt, userPrompt: prompt, width: size.w, height: size.h, count,
        shotName: (title.trim() || prompt).slice(0, 60),
        ...(loras.length ? { loras } : {}),
        ...(refsOn && refs.length ? { refImages: refs.map((r) => r.token) } : {}),
      });
      toast(`Queued ${r.takeIds.length} image${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(false);
    }
  }

  const step = (dir: 1 | -1) => {
    const i = done.findIndex((t) => t.id === viewing);
    const n = done[(i + dir + done.length) % done.length];
    if (n) setViewing(n.id);
  };

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <ModelPicker models={IMAGE_MODELS} value={model.id} onChange={(id) => setParams({ model: id === 'qwen' ? null : id })} showRefs />
        {model.warn && <div className="label" style={{ color: 'var(--accent)', textTransform: 'none', letterSpacing: 0, fontSize: 11.5 }}>{model.warn}</div>}

        <div className="chip-row">
          <ChipMenu icon="aspect" value={aspect} onChange={setAspect} title="Aspect" options={ASPECTS.map((a) => ({ value: a.id, label: a.id }))} />
          <ChipMenu icon="res" value={quality} onChange={setQuality} title="Quality" options={IMAGE_QUALITY.map((q) => ({ value: q.id, label: q.label, note: q.note }))} />
          <ChipMenu icon="grid" value={res} onChange={setRes} title="Resolution" options={IMAGE_RES.map((r) => ({ value: r.id, label: r.id, note: `${r.mp} MP` }))} />
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
        </div>

        {refsOn && (
          <div className="rail-section">
            <div className="label">References</div>
            {refs.length > 0 && (
              <div className="refs">
                {refs.map((r, i) => (
                  <div className="ref" key={r.token} title={`Reference ${i + 1}: ${r.name}. Say "the person in image ${i + 1}" to point at it.`}>
                    <img src={inputUrl(r.token)} alt="" />
                    <span className="role">{i + 1}</span>
                    <button type="button" className="x" onClick={() => setRefs((c) => c.filter((_, j) => j !== i))} aria-label="remove"><Icon name="x" size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            {refs.length < maxRefs && (
              <RefWell onFiles={addRefs} compact={refs.length > 0}
                hint={model.id === 'qwen'
                  ? `Renders through Qwen-Image-Edit 2509: the frame is built around its ${maxRefs} reference pictures.`
                  : `${model.label} keeps their faces, clothes and objects in a new photograph. Point at them as "the person in image 1".`} />
            )}
          </div>
        )}

        <div className="rail-section">
          <div className="label">Title</div>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="Name this image (optional)" />
        </div>

        <div className="rail-section">
          <div className="label">Prompt</div>
          <MentionBox className="prompt" rows={4} value={prompt} onChange={setPrompt}
            placeholder={`Describe the image you want with ${model.label}. Type @ to bring in your cast.`}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && prompt.trim()) void go(); }} />
          <LoraChips family={model.loraFamily} value={loras} onChange={setLoras} />
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button type="button" className="generate" disabled={busy || !prompt.trim()} onClick={() => void go()}>
            <span>{busy ? 'Queuing...' : 'Generate'}</span>
            <span className="cost">{size.w}x{size.h}{est ? ` · ${fmtSeconds(est * count)}` : ''}</span>
          </button>
        </div>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className="on">History</button>
          </div>
        </div>
        <div className="canvas-body">
          {takes.length === 0 ? (
            <div className="hero-empty">
              <div className="explore-glow" style={{ top: -60 }}><Spill src={presetClip('golden')} video /></div>
              <div className="fan">
                {['ink-bloom', 'golden', 'neon-rain', 'bloom'].map((id) => <div key={id}><Clip src={presetClip(id)} className="" /></div>)}
              </div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>Make an image with <span className="hl">{model.label}</span></div>
              <p className="dim" style={{ marginTop: 14 }}>Open weights, on your own GPU. Describe it on the left.</p>
            </div>
          ) : (
            <div className="grid">
              {takes.map((t) => (
                <MediaCard key={t.id} take={t} onOpen={() => setViewing(t.id)} actions={<>
                  <button type="button" className="icon-btn" title="Animate" onClick={() => void animate(t)}><Icon name="video" size={14} /></button>
                  <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                  <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                </>} />
              ))}
            </div>
          )}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
    </div>
  );
}
