/**
 * Extend and Transitions: continue a take forward (or give it a lead-in), or
 * bridge two takes with a generated move. Both run on LTX-2.5 and save the
 * joined clip as a new take.
 */
import { useState } from 'react';
import { api } from '../api';
import { CONTINUE_PROMPT, TRANSITION_STYLES, compilePrompt } from '../catalog';
import { usePageDrop } from '../drop';
import { setParams, useRoute } from '../router';
import { SourceSlot, loadFile, useTakeParam, type Source } from '../SourcePick';
import { inFeed, settingsOf, toast, useStore } from '../store';
import { ChipMenu, Icon, MediaCard, Stepper, Switch, TierChip, fmtSeconds, useEstimate, useTierChoice, RailHandle, useRail } from '../ui';
import { tierSizeOf } from '../renderTier';
import Viewer, { recreate, remove } from '../Viewer';

type Mode = 'extend' | 'transition';

export default function ExtendPage() {
  const { params } = useRoute();
  const mode: Mode = params.get('mode') === 'transition' ? 'transition' : 'extend';
  const [src, setSrc] = useState<Source | null>(null);
  const [to, setTo] = useState<Source | null>(null);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [styleId, setStyleId] = useState<string>('morph');
  const [prompt, setPrompt] = useState('');
  const [extendSeconds, setExtendSeconds] = useState(3);
  const [bridgeSeconds, setBridgeSeconds] = useState(2);
  const [audio, setAudio] = useState(true);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [res, setRes] = useTierChoice(params.get('mode') === 'transition' ? 'transition' : 'extend');

  // Viewer hand-off: ?take=<id> fills the first slot (Extend, or Transition from).
  useTakeParam(params.get('take'), (s) => { setSrc(s); setParams({ take: null }); });

  const style = TRANSITION_STYLES.find((s) => s.id === styleId) ?? TRANSITION_STYLES[0];
  const transition = mode === 'transition';

  // A drop anywhere on the page. Extend: the clip. Transition: the first empty side,
  // From then To (the second file of a two-file drop goes to To); both full replaces To.
  usePageDrop(
    !transition ? 'Drop a clip to extend it'
      : !src ? 'Drop the first take: a clip or a still'
      : !to ? 'Drop the second take: a clip or a still'
      : 'Drop a take to replace the second one',
    async (files) => {
      if (!transition) {
        const s = await loadFile(files[0], ['video']);
        if (s) setSrc(s);
        return;
      }
      let fillFrom = !src;
      for (const f of files.slice(0, 2)) {
        const s = await loadFile(f, ['video', 'image']);
        if (!s) continue;
        if (fillFrom) { setSrc(s); fillFrom = false; } else setTo(s);
      }
    },
  );
  const seconds = transition ? bridgeSeconds : extendSeconds;
  const setSeconds = transition ? setBridgeSeconds : setExtendSeconds;
  // The render size at the shape of the clip (or, for two stills, the first one), 32-aligned.
  const size = (() => {
    const v = [src, to].find((s) => s?.kind === 'video') ?? src ?? to;
    return tierSizeOf(res, v?.w, v?.h, 32);
  })();
  const est = useEstimate({ kind: 'video', model: mode, w: size.w, h: size.h, seconds });
  const hasSound = transition ? true : !!src;
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && settingsOf(t).app === mode));
  const ready = transition ? !!src && !!to : src?.kind === 'video';

  async function go() {
    if (!src) return;
    setBusy('Queuing...');
    try {
      const r = transition ? await api.generate(transitionBody()) : await api.generate(extendBody());
      toast(`Queued ${r.takeIds.length} take${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  function extendBody() {
    const s = src!;
    const body = {
      kind: 'extend', app: 'extend', videoModel: 'ltx25', direction, sourceVideo: s.token, parentTake: s.takeId,
      prompt: prompt.trim() || s.prompt || CONTINUE_PROMPT, userPrompt: prompt.trim() || `${direction === 'backward' ? 'Lead-in' : 'Extend'} +${seconds}s`,
      width: size.w, height: size.h, seconds, withAudio: audio, count, shotName: `extend_${s.name}`.slice(0, 40),
    };
    return body;
  }

  function transitionBody() {
    const a = src!, b = to!;
    const body = {
      kind: 'transition', app: 'transition', videoModel: 'ltx25', style: style.id,
      startVideo: a.kind === 'video' ? a.token : undefined, startImage: a.kind === 'image' ? a.token : undefined,
      endVideo: b.kind === 'video' ? b.token : undefined, endImage: b.kind === 'image' ? b.token : undefined,
      prompt: compilePrompt([style.text, prompt]), userPrompt: prompt.trim() || style.label,
      width: size.w, height: size.h, seconds, withAudio: audio, count, shotName: `transition_${style.id}`,
    };
    return body;
  }

  const list = takes.filter((t) => t.status === 'done');
  const step = (dir: 1 | -1) => {
    const i = list.findIndex((t) => t.id === viewing);
    const n = list[(i + dir + list.length) % list.length];
    if (n) setViewing(n.id);
  };

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <div className="tabs">
          <button type="button" className={!transition ? 'on' : ''} onClick={() => setParams({ mode: null })}>Extend</button>
          <button type="button" className={transition ? 'on' : ''} onClick={() => setParams({ mode: 'transition' })}>Transition</button>
        </div>

        {!transition ? (
          <>
            <SourceSlot label="Clip" value={src} onChange={setSrc} accept={['video']} title="Add a clip to extend" sub="Pick one of your takes below, or drop a video." />
            <div className="seg">
              <button type="button" className={direction === 'forward' ? 'on' : ''} onClick={() => setDirection('forward')}>Continue after</button>
              <button type="button" className={direction === 'backward' ? 'on' : ''} onClick={() => setDirection('backward')}>Lead in before</button>
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>
              {direction === 'forward'
                ? 'The last second of the clip stays in view while the model writes what happens next, so motion and sound carry on.'
                : 'Builds the moments before the first frame. Best for camera moves, weather and drift: the lead-in is written in reverse, so a person walking would walk backwards.'}
            </div>
            <div className="rail-section">
              <div className="label">What happens {direction === 'forward' ? 'next' : 'before'} · optional</div>
              <textarea className="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder={src?.prompt ? `Empty keeps the take's prompt: ${src.prompt.slice(0, 90)}` : 'The storm breaks and a wave crashes over the rail.'} />
            </div>
          </>
        ) : (
          <>
            <div className="join-row">
              <SourceSlot label="From" value={src} onChange={setSrc} accept={['video', 'image']} title="First take" sub="" />
              <span className="arrow"><Icon name="chev" /></span>
              <SourceSlot label="To" value={to} onChange={setTo} accept={['video', 'image']} title="Second take" sub="" />
            </div>
            <div className="rail-section">
              <div className="label">Transition</div>
              <div className="style-grid">
                {TRANSITION_STYLES.map((s) => (
                  <button key={s.id} type="button" className={`chip ${s.id === styleId ? 'on' : ''}`} title={s.text} onClick={() => setStyleId(s.id)}>{s.label}</button>
                ))}
              </div>
            </div>
            <div className="rail-section">
              <div className="label">Direction · optional</div>
              <textarea className="prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="The sparks become rain." />
            </div>
          </>
        )}

        <div className="chip-row" style={{ alignItems: 'center' }}>
          <ChipMenu icon="clock" value={seconds} onChange={setSeconds} title={transition ? 'Bridge length' : 'New footage'}
            options={(transition ? [1, 2, 3, 4] : [2, 3, 5, 8]).map((d) => ({ value: d, label: `${transition ? '' : '+'}${d}s` }))} />
          <TierChip app={transition ? 'transition' : 'extend'} value={res} onChange={setRes} />
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
          {hasSound && <span className="chip" style={{ gap: 10 }}><Icon name="audio" size={14} />Sound <Switch on={audio} onChange={setAudio} label="sound" /></span>}
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !ready} onClick={() => void go()}>
          <span>{busy ?? (transition ? 'Make transition' : direction === 'forward' ? 'Extend' : 'Add lead-in')}</span>
          <span className="cost">{size.w}x{size.h}{est ? ` · ${fmtSeconds(est * count)}` : ' · LTX-2.5'}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}><button type="button" className="on">Takes</button></div>
        </div>
        <div className="canvas-body">
          {takes.length === 0 ? (
            <div className="hero-empty">
              <div className="label" style={{ marginBottom: 14 }}>{transition ? 'Two takes, one move' : 'The shot keeps rolling'}</div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>
                {transition ? <>Cut <span className="hl">without a cut</span></> : <>Roll past <span className="hl">the last frame</span></>}
              </div>
              <div className="steps3">
                {transition ? <>
                  <div><span className="label">01</span><b>Pick two takes</b><span className="dim">Clips or stills, in play order.</span></div>
                  <div><span className="label">02</span><b>Choose the move</b><span className="dim">Morph, whip pan, match cut, light leak and more.</span></div>
                  <div><span className="label">03</span><b>Make it</b><span className="dim">You get one clip: first take, bridge, second take.</span></div>
                </> : <>
                  <div><span className="label">01</span><b>Pick a take</b><span className="dim">Any clip, yours or dropped in.</span></div>
                  <div><span className="label">02</span><b>Say what happens</b><span className="dim">Or leave it empty to carry on as it was.</span></div>
                  <div><span className="label">03</span><b>Extend</b><span className="dim">The new seconds are joined onto the original.</span></div>
                </>}
              </div>
            </div>
          ) : (
            <div className="grid">
              {takes.map((t) => (
                <MediaCard key={t.id} take={t} onOpen={() => setViewing(t.id)} actions={<>
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
