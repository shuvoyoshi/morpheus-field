/**
 * Model: any still becomes a textured 3D model (TRELLIS.2 or Pixal3D on the
 * local engine). The rail takes the still and the settings; the canvas shows
 * the selected model on a turntable you can grab, next to every other take.
 * Each result is an ordinary take whose file is a GLB, so the Library, the
 * Viewer and the Stage all read it from /api/media/<take>.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { api, downloadUrl, mediaUrl, posterUrl, subjectUrl, type Take } from '../api';
import { MODEL_MODELS, OBJECT_DETAIL, type ModelEngine } from '../catalog';
import { setParams, useRoute } from '../router';
import { SourceSlot, loadFile, useTakeParam, type Source } from '../SourcePick';
import { inFeed, isModel, settingsOf, toast, useStore } from '../store';
import { Icon, MediaCard, Spill, Stepper, Switch, fmtSeconds, presetClip, useEstimate, RailHandle, useRail } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';
import { usePageDrop } from '../drop';
import type { ModelLook } from '../ModelView';

const ModelView = lazy(() => import('../ModelView'));

export default function ObjectPage() {
  const { params } = useRoute();
  const [source, setSource] = useState<Source | null>(null);
  const [model, setModel] = useState<ModelEngine>('trellis');
  const [quality, setQuality] = useState<'draft' | 'quality'>('draft');
  const [cutout, setCutout] = useState(true);
  // Background removal you can see before the 3D run: a cutout take of the still.
  const [cut, setCut] = useState<{ takeId: number; forSource: string } | null>(null);
  const [showCut, setShowCut] = useState(true);
  const [cutting, setCutting] = useState(false);
  const sourceKey = source ? String(source.takeId ?? source.token) : '';
  const cutTake = useStore((st) => (cut ? st.takes.find((t) => t.id === cut.takeId) : undefined));
  const cutReady = !!cut && cut.forSource === sourceKey && cutTake?.status === 'done';
  const usingCut = cutReady && showCut;
  useEffect(() => { setShowCut(true); }, [cut?.takeId]);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [look, setLook] = useState<ModelLook>('lit');
  const [viewing, setViewing] = useState<number | null>(null);

  // Deep link from the Viewer's Make 3D: /object?take=44 preloads that still.
  useTakeParam(params.get('take'), (s) => { setSource(s); setParams({ take: null }); });
  usePageDrop('Drop a still to make it 3D', (files) => {
    void (async () => { const s = await loadFile(files[0], ['image']); if (s) setSource(s); })();
  });

  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && isModel(t)));
  const est = useEstimate({ kind: 'object', model, quality });
  const shown = takes.find((t) => t.id === selected) ?? takes.find((t) => t.status === 'done');
  useEffect(() => { setLook('lit'); }, [shown?.id]);

  async function removeBackground() {
    if (!source) return;
    setCutting(true);
    try {
      const r = await api.generate({
        kind: 'cutout', app: 'cutout', mode: 'matte', background: 'transparent',
        ...(source.takeId ? { sourceTake: source.takeId } : { image: source.token }),
        userPrompt: 'Remove background', shotName: `${(source.name || 'still').slice(0, 30)}_cutout`,
      });
      setCut({ takeId: r.takeIds[0], forSource: sourceKey });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setCutting(false);
    }
  }

  async function go() {
    if (!source) return;
    setBusy('Queuing...');
    try {
      const r = await api.generate({
        kind: 'object', app: 'object', model, quality, count,
        // With the cutout showing, mesh exactly that PNG; its alpha is the subject.
        ...(usingCut ? { sourceTake: cut!.takeId, removeBackground: false }
          : { removeBackground: cutout, ...(source.takeId ? { sourceTake: source.takeId } : { image: source.token }) }),
        shotName: `object_${(source.prompt || source.name || 'still').slice(0, 30)}`,
        userPrompt: source.prompt ? `3D: ${source.prompt}` : `3D from ${source.name}`,
      });
      setSelected(r.takeIds[0]);
      toast(`Building ${r.takeIds.length} model${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  const q = OBJECT_DETAIL.find((x) => x.id === quality)!;
  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <Spill src={presetClip('turntable')} video />
        <div className="display" style={{ fontSize: 26 }}>Model</div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>One still becomes a textured 3D model you can turn, download as GLB and drop into a scene. On your GPU.</div>

        <SourceSlot label="Still" value={source} onChange={setSource} accept={['image']}
          title="Add a still of the thing" sub="One subject, whole in frame, on a plain background works best." />

        <div className="rail-section">
          <div className="label">Engine</div>
          <div className="seg">
            {MODEL_MODELS.map((x) => <button key={x.id} type="button" className={model === x.id ? 'on' : ''} onClick={() => setModel(x.id)}>{x.label}</button>)}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>{MODEL_MODELS.find((x) => x.id === model)!.note} {MODEL_MODELS.find((x) => x.id === model)!.vendor} · {MODEL_MODELS.find((x) => x.id === model)!.license}.</div>
        </div>

        <div className="rail-section">
          <div className="label">Detail</div>
          <div className="seg">
            {OBJECT_DETAIL.map((x) => <button key={x.id} type="button" className={quality === x.id ? 'on' : ''} onClick={() => setQuality(x.id)}>{x.label}</button>)}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>{q.note}</div>
        </div>

        {source && (
          <div className="rail-section">
            {cutReady && (
              <>
                <div className="seg">
                  <button type="button" className={!showCut ? 'on' : ''} onClick={() => setShowCut(false)}>Original</button>
                  <button type="button" className={showCut ? 'on' : ''} onClick={() => setShowCut(true)}>Cut out</button>
                </div>
                {showCut && (
                  <div className="checker" style={{ borderRadius: 12, overflow: 'hidden', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}>
                    <img src={mediaUrl(cut!.takeId)} alt="The subject with the background removed" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
                  </div>
                )}
              </>
            )}
            <button type="button" className="btn sm" disabled={cutting || (!!cut && cut.forSource === sourceKey && !cutReady && cutTake?.status !== 'failed')} onClick={() => void removeBackground()}>
              <Icon name="sparkle" size={13} />
              {cutting || (cut && cut.forSource === sourceKey && !cutReady && cutTake?.status !== 'failed') ? 'Removing the background...' : cutReady ? 'Remove the background again' : 'Remove background'}
            </button>
            {cutReady && <div className="dim" style={{ fontSize: 12 }}>{showCut ? 'Make 3D builds exactly this cutout.' : 'Make 3D uses the original picture.'}</div>}
          </div>
        )}

        {!usingCut && <div className="rail-section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span className="dim" style={{ fontSize: 12.5 }}>Cut the subject out first</span>
            <Switch on={cutout} onChange={setCutout} label="cut the subject out first" />
          </div>
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {cutout ? 'BiRefNet finds the subject and drops the background.' : 'Uses the picture\'s own transparency. Turn this off only for a PNG that is already cut out.'}
          </div>
        </div>}

        <div className="chip-row" style={{ alignItems: 'center' }}>
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
          <span className="dim" style={{ fontSize: 12 }}>Each take uses a new seed.</span>
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !source} onClick={() => void go()}>
          <span>{busy ?? (count > 1 ? `Make 3D · ${count}` : 'Make 3D')}</span>
          <span className="cost">{est ? fmtSeconds(est * count) : MODEL_MODELS.find((x) => x.id === model)!.label}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className="on">Models</button>
          </div>
        </div>
        <div className="canvas-body">
          {takes.length === 0 ? (
            <div className="hero-empty">
              <div className="object-hero"><video src={presetClip('turntable')} muted loop autoPlay playsInline /></div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>A still <span className="hl">in the round</span></div>
              <div className="steps3">
                <div><span className="label">01</span><b>Add a still</b><span className="dim">Or press Make 3D on any image in the Library.</span></div>
                <div><span className="label">02</span><b>Pick the detail</b><span className="dim">Draft to check the shape, High for the keeper.</span></div>
                <div><span className="label">03</span><b>Turn it</b><span className="dim">Drag to orbit, download the GLB, block it into a scene.</span></div>
              </div>
            </div>
          ) : (
            <>
              {shown && shown.status === 'done' && <ObjectFocus take={shown} look={look} onLook={setLook} onOpen={() => setViewing(shown.id)} />}
              <div className="grid dense" style={{ marginTop: 18 }}>
                {takes.map((t) => (
                  <MediaCard key={t.id} take={t} onOpen={() => setSelected(t.id)} actions={<>
                    {t.status === 'done' && <a className="icon-btn" title="Download GLB" href={downloadUrl(t.id)}><Icon name="download" size={14} /></a>}
                    <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                    <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                  </>} />
                ))}
              </div>
            </>
          )}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={() => {}} />}
    </div>
  );
}

/** The selected model, big: grab to orbit, switch looks, see what it was made from. */
function ObjectFocus({ take, look, onLook, onOpen }: { take: Take; look: ModelLook; onLook: (l: ModelLook) => void; onOpen: () => void }) {
  const s = settingsOf(take);
  return (
    <div className="object-focus">
      <Suspense fallback={<div className="model-view"><img className="model-poster" src={posterUrl(take.id)} alt="" /></div>}>
        <ModelView src={mediaUrl(take.id)} poster={posterUrl(take.id)} look={look} />
      </Suspense>
      <div className="object-side">
        <div className="label">From</div>
        <img className="object-from" src={subjectUrl(take.id)} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <div className="seg">
          {(['lit', 'clay', 'wire'] as const).map((l) => (
            <button key={l} type="button" className={look === l ? 'on' : ''} onClick={() => onLook(l)}>{l === 'lit' ? 'Textured' : l === 'clay' ? 'Clay' : 'Wire'}</button>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          {s.quality === 'quality' ? 'High' : 'Draft'} · up to {Number(s.faces).toLocaleString()} faces · {s.texture}px textures
          {take.render_seconds ? ` · ${Math.round(take.render_seconds)}s` : ''}
        </div>
        <a className="btn sm accent" href={downloadUrl(take.id)}><Icon name="download" size={14} />Download GLB</a>
        <button type="button" className="btn sm" onClick={onOpen}><Icon name="sparkle" size={14} />Open</button>
      </div>
    </div>
  );
}
