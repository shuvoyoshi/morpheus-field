/**
 * Effects: one-click LTX-2.5 LoRA effects, a grid of named looks on open
 * weights. Clip effects (IC-LoRA) re-render a source clip frame-locked; still
 * effects animate one image with a plain LoRA. Definitions live in ../effects.ts.
 */
import { useEffect, useState } from 'react';
import { api, inputUrl, mediaUrl, posterUrl, takeAsInput, uploadFile, type BundleStatus } from '../api';
import { artFor } from '../catalog';
import { EFFECTS, effectById, effectPrompt, effectSize, type EffectDef } from '../effects';
import { linkProps, setParams, useRoute } from '../router';
import { inFeed, isImage, isModel, settingsOf, takeHandoff, toast, useStore } from '../store';
import { ChipMenu, Icon, MediaCard, Spill, Stepper, Switch, TierChip, fmtSeconds, useEstimate, useTierChoice, RailHandle, useRail } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';
import { DropWell, probeClip } from './Mirror';
import { usePageDrop } from '../drop';
import { PhoneDrop } from '../Phone';

/** The thing an effect is applied to: an uploaded clip or still. */
interface Input { kind: 'clip' | 'still'; token: string; url: string; w: number; h: number; seconds: number; name: string }

const effectClip = (id: string) => `/effects/${id}.mp4`;

export default function EffectsPage() {
  const { params } = useRoute();
  const fx = effectById(params.get('effect')) ?? EFFECTS[0];
  const tab = params.get('tab') || (params.get('effect') ? 'takes' : 'effects');

  const [inputs, setInputs] = useState<{ clip: Input | null; still: Input | null }>({ clip: null, still: null });
  const [text, setText] = useState('');
  const [res, setRes] = useTierChoice('effects');
  const [stillSeconds, setStillSeconds] = useState(5);
  const [loop, setLoop] = useState(true);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());

  // Which effect LoRAs the engine can see; a missing one shows as "Not installed".
  useEffect(() => {
    api.preflight().then((r: { bundles: BundleStatus[] }) => {
      setMissing(new Set(r.bundles.filter((b) => b.id.startsWith('effects')).flatMap((b) => b.missingFiles.map((f) => f.file))));
    }).catch(() => {});
  }, []);

  // "Add effect" from the viewer hands over a take as a clip or a still. It can
  // arrive while this page is already open (the viewer is on it), so re-check on
  // every navigation; takeHandoff() only ever yields a hand-off once.
  const routeKey = params.toString();
  useEffect(() => {
    const r = takeHandoff()?.refs[0];
    if (!r) return;
    setViewing(null);
    void adopt(r.token, r.name, r.kind === 'video' ? 'clip' : 'still');
  }, [routeKey]);

  const input = inputs[fx.input];
  const seconds = fx.input === 'clip'
    ? Math.max(1, Math.min(fx.maxSeconds, Math.floor(input?.seconds || fx.maxSeconds)))
    : Math.min(fx.maxSeconds, stillSeconds);
  const size = effectSize(fx, input ?? undefined, res);
  const est = useEstimate({ kind: 'video', model: 'ltx25', w: size.w, h: size.h, seconds });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && settingsOf(t).app === 'effects'));
  const installed = !missing.has(fx.lora);

  function pick(e: EffectDef) {
    setText('');
    setParams({ effect: e.id, tab: null });
  }

  /** Read an input's shape, then keep it in the slot for its kind. */
  async function adopt(token: string, name: string, kind: 'clip' | 'still') {
    const url = inputUrl(token);
    if (kind === 'clip') {
      const m = await probeClip(url);
      if (m.s < 1) { toast('Clip is too short. Use 1 to 8 seconds.', true); return; }
      setInputs((c) => ({ ...c, clip: { kind, token, url, w: m.w, h: m.h, seconds: m.s, name } }));
      if (fx.input !== 'clip') setParams({ effect: EFFECTS.find((e) => e.input === 'clip')!.id });
    } else {
      const d = await new Promise<{ w: number; h: number }>((res) => {
        const img = new Image();
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res({ w: 0, h: 0 });
        img.src = url;
      });
      setInputs((c) => ({ ...c, still: { kind, token, url, ...d, seconds: 0, name } }));
      if (fx.input !== 'still') setParams({ effect: EFFECTS.find((e) => e.input === 'still')!.id });
    }
  }

  async function addFile(f: File) {
    const kind = f.type.startsWith('video/') ? 'clip' : f.type.startsWith('image/') ? 'still' : null;
    if (!kind) { toast('Drop a video clip or an image', true); return; }
    if (f.size > 90e6) { toast('File is over 90 MB. Trim it first.', true); return; }
    setBusy('Uploading...');
    try {
      await adopt(await uploadFile(f), f.name, kind);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    } finally {
      setBusy(null);
    }
  }

  // A drop anywhere on the page: a video fills the clip slot, an image the still
  // slot, and the effect switches to one that takes it if needed.
  usePageDrop('Drop a clip for a clip effect, or an image for a still effect', (files) => {
    const f = files[0];
    if (f.type.startsWith('video/') || f.type.startsWith('image/')) void addFile(f);
    else toast('Drop a video clip or an image', true);
  });

  async function fromLibrary(id: number, still: boolean) {
    setPicking(false);
    setBusy('Loading take...');
    try {
      await adopt(await takeAsInput(id), `take ${id}`, still ? 'still' : 'clip');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  async function go() {
    if (!input) return;
    setBusy('Queuing...');
    try {
      const r = await api.generate({
        kind: 'effect', app: 'effects', effect: fx.id, videoModel: 'ltx25', prompt: effectPrompt(fx, text), userPrompt: text || fx.name, text,
        width: size.w, height: size.h, seconds, loop: fx.loopable ? loop : undefined, count,
        sourceVideo: fx.input === 'clip' ? input.token : undefined, startImage: fx.input === 'still' ? input.token : undefined,
        shotName: `${fx.name} ${text}`.trim().slice(0, 40),
      });
      toast(`Queued ${r.takeIds.length} take${r.takeIds.length > 1 ? 's' : ''}`);
      setParams({ tab: 'takes' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  const viewList = takes.filter((t) => t.status === 'done');
  const step = (dir: 1 | -1) => {
    const i = viewList.findIndex((t) => t.id === viewing);
    const n = viewList[(i + dir + viewList.length) % viewList.length];
    if (n) setViewing(n.id);
  };

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <Spill src={effectClip(fx.id)} video key={fx.id} />
        <button type="button" className="preset-hero" onClick={() => setParams({ tab: 'effects' })}>
          <EffectArt fx={fx} />
          <div className="txt">
            <div className="display">{fx.name}</div>
            <div className="label">{fx.input === 'clip' ? 'Clip in, clip out' : 'Still in, clip out'} · LTX-2.5</div>
          </div>
          <span className="chip change"><Icon name="wand" size={13} />Change</span>
        </button>
        <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>{fx.blurb}</div>
        {fx.id === 'cutout' && (
          <div className="compiled" style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5 }}>
            This effect regenerates the matte with LTX at the size you pick. For a transparent clip at full size, use{' '}
            <a {...linkProps('/cutout')} style={{ color: 'var(--accent)' }}>Remove background</a>: faster, and ProRes 4444 with alpha.
          </div>
        )}
        {!installed && (
          <div className="label" style={{ color: 'var(--accent)', textTransform: 'none', letterSpacing: 0 }}>
            Not installed: {fx.lora}. Run npm run models -- --only {fx.bundle}.
          </div>
        )}

        <div className="rail-section">
          <div className="label">{fx.input === 'clip' ? 'Source clip' : 'Still'}</div>
          {input ? (
            <div className="ref" style={{ aspectRatio: `${input.w || 16} / ${input.h || 9}` }}>
              {input.kind === 'clip' ? <video src={input.url} muted loop autoPlay playsInline /> : <img src={input.url} alt="" />}
              <span className="role">{input.kind === 'clip' ? `${Math.min(fx.maxSeconds, input.seconds).toFixed(1)}s` : 'first frame'}</span>
              <button type="button" className="x" onClick={() => setInputs((c) => ({ ...c, [fx.input]: null }))} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ) : (
            <>
              <DropWell accept={fx.input === 'clip' ? 'video/*' : 'image/*'} onFile={addFile} icon={fx.input === 'clip' ? 'video' : 'image'}
                title={fx.input === 'clip' ? 'Add the clip' : 'Add the still'}
                sub={fx.input === 'clip' ? `Up to ${fx.maxSeconds} seconds are used.` : 'It becomes the first frame.'} />
              <button type="button" className="btn sm" onClick={() => setPicking(true)}><Icon name="grid" size={14} />From your library</button>
              {fx.input === 'clip' && <PhoneDrop onClip={(token, name) => adopt(token, name, 'clip')} />}
            </>
          )}
        </div>

        {fx.field && (
          <div className="rail-section">
            <div className="label">{fx.field.label}</div>
            <textarea className="prompt" rows={3} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={fx.field.default || fx.field.placeholder}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && input) void go(); }} />
            <details>
              <summary className="label" style={{ cursor: 'pointer' }}>Final prompt</summary>
              <div className="compiled" style={{ marginTop: 6 }}>{effectPrompt(fx, text)}</div>
            </details>
          </div>
        )}
        {!fx.field && <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>No prompt: the clip is the only guide.</div>}

        <div className="chip-row" style={{ alignItems: 'center' }}>
          {fx.input === 'clip'
            ? <span className="chip"><Icon name="clock" size={14} />{seconds}s</span>
            : <ChipMenu icon="clock" value={stillSeconds} onChange={setStillSeconds} title="Duration"
                options={[3, 5, 8].filter((s) => s <= fx.maxSeconds).map((s) => ({ value: s, label: `${s}s` }))} />}
          <TierChip app="effects" value={res} onChange={setRes} />
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
          {fx.loopable && <span className="chip" style={{ gap: 10 }}><Icon name="loop" size={14} />Loop <Switch on={loop} onChange={setLoop} label="loop" /></span>}
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !input || !installed} onClick={() => void go()}>
          <span>{busy ?? `Apply ${fx.name}`}</span>
          <span className="cost">{size.w}x{size.h}{est ? ` · ${fmtSeconds(est * count)}` : ''}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className={tab === 'effects' ? 'on' : ''} onClick={() => setParams({ tab: 'effects' })}>Effects</button>
            <button type="button" className={tab === 'takes' ? 'on' : ''} onClick={() => setParams({ tab: 'takes' })}>Takes</button>
          </div>
        </div>
        <div className="canvas-body">
          {tab === 'effects' && <EffectGrid value={fx.id} missing={missing} onPick={pick} />}
          {tab === 'takes' && (takes.length === 0 ? <EffectGrid value={fx.id} missing={missing} onPick={pick} /> : (
            <div className="grid">
              {takes.map((t) => (
                <MediaCard key={t.id} take={t} onOpen={() => setViewing(t.id)} actions={<>
                  <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                  <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                </>} />
              ))}
            </div>
          ))}
        </div>
      </section>
      {picking && <LibraryPicker still={fx.input === 'still'} onPick={fromLibrary} onClose={() => setPicking(false)} />}
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
    </div>
  );
}

const GROUPS = [
  { id: 'all', label: 'All' },
  { id: 'clip', label: 'On a clip' },
  { id: 'still', label: 'On a still' },
] as const;

function EffectGrid({ value, missing, onPick }: { value: string; missing: Set<string>; onPick: (e: EffectDef) => void }) {
  const [group, setGroup] = useState<(typeof GROUPS)[number]['id']>('all');
  const list = EFFECTS.filter((e) => group === 'all' || e.input === group);
  return (
    <div className="picker">
      <div className="picker-top">
        {GROUPS.map((g) => (
          <button key={g.id} type="button" className={`pill ${group === g.id ? 'active' : ''}`} onClick={() => setGroup(g.id)}>{g.label}</button>
        ))}
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 12.5 }}>LTX-2.5 LoRAs, on your GPU</span>
      </div>
      <div className="picker-grid">
        {list.map((e) => (
          <button key={e.id} type="button" className={`preset-card ${e.id === value ? 'on' : ''}`} onClick={() => onPick(e)} title={e.blurb}>
            <EffectArt fx={e} />
            <span className="cat badge">{missing.has(e.lora) ? 'Not installed' : e.input === 'clip' ? 'Clip' : 'Still'}</span>
            <span className="name">{e.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The effect's rendered preview loop, or a quiet gradient until one exists. */
function EffectArt({ fx }: { fx: EffectDef }) {
  const [hasVideo, setHasVideo] = useState(true);
  return (
    <>
      <div className="art gen" style={{ ['--g' as any]: artFor((EFFECTS.indexOf(fx) * 37) % 360) }} />
      {hasVideo && (
        <video className="art" src={effectClip(fx.id)} muted loop autoPlay playsInline preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setHasVideo(false)} />
      )}
    </>
  );
}

/** Pick a finished take as the effect's input. */
function LibraryPicker({ still, onPick, onClose }: { still: boolean; onPick: (id: number, still: boolean) => void; onClose: () => void }) {
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && t.status === 'done' && isImage(t) === still && t.kind !== 'upres' && t.kind !== 'audio' && !isModel(t)));
  return (
    <div className="viewer-back" style={{ display: 'block', background: 'rgba(0,0,0,0.82)', overflowY: 'auto' }} onClick={onClose}>
      <div className="page-pad" onClick={(e) => e.stopPropagation()}>
        <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="display">Pick a {still ? 'still' : 'clip'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="close"><Icon name="x" /></button>
        </div>
        {takes.length === 0 ? <div className="dim">No finished {still ? 'stills' : 'videos'} yet.</div> : (
          <div className="picker-grid">
            {takes.map((t) => (
              <button key={t.id} type="button" className="preset-card" style={{ aspectRatio: '16 / 10' }} onClick={() => onPick(t.id, still)}>
                {still ? <img className="art" src={mediaUrl(t.id)} alt="" /> : <img className="art" src={posterUrl(t.id)} alt="" />}
                <span className="name" style={{ fontSize: 14 }}>{(settingsOf(t).userPrompt || t.shot_name || '').slice(0, 40)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
