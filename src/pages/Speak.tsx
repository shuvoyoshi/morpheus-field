/**
 * Speak and Add sound, the two directions of LTX-2.5's joint audio + video
 * model. Speak: a face (or any start frame) plus your sound file; the sound is
 * frozen and only the picture is generated, so lips and motion follow it.
 * Add sound: a clip's frames are frozen and only the soundtrack is generated.
 */
import { useState } from 'react';
import { api } from '../api';
import { SOUND_PROMPT, SPEAK_PROMPT, compilePrompt } from '../catalog';
import { tierSizeOf } from '../renderTier';
import { usePageDrop } from '../drop';
import { setParams, useRoute } from '../router';
import { SourceSlot, fileKind, loadFile, useTakeParam, type Source } from '../SourcePick';
import { inFeed, settingsOf, toast, useStore } from '../store';
import { Icon, MediaCard, Stepper, TierChip, fmtSeconds, useEstimate, useTierChoice, RailHandle, useRail } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';
import { MentionBox, useMentioned } from '../Mention';

type Mode = 'speak' | 'sound';

export default function SpeakPage() {
  const { params } = useRoute();
  const mode: Mode = params.get('mode') === 'sound' ? 'sound' : 'speak';
  const [face, setFace] = useState<Source | null>(null);
  const [voice, setVoice] = useState<Source | null>(null);
  const [clip, setClip] = useState<Source | null>(null);
  const [words, setWords] = useState('');
  const [prompt, setPrompt] = useState('');
  const [res, setRes] = useTierChoice('speak');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  // Viewer hand-off: a still fills the face, a sound fills the voice, a clip fills the clip.
  useTakeParam(params.get('take'), (s) => {
    if (s.kind === 'image') { setFace(s); setParams({ mode: null, take: null }); }
    else if (s.kind === 'audio') { setVoice(s); setParams({ mode: null, take: null }); }
    else { setClip(s); setParams({ mode: 'sound', take: null }); }
  });

  const speak = mode === 'speak';

  // A drop anywhere on the page goes by what it is: a still is the face, a sound
  // file is the voice (both Speak), a video is the clip for Add sound.
  usePageDrop(
    speak ? 'Drop a face image or a sound file. A clip opens Add sound.' : 'Drop a clip to add sound to it',
    async (files) => {
      for (const f of files.slice(0, 3)) {
        const kind = fileKind(f);
        const s = await loadFile(f, kind ? [kind] : ['image', 'audio', 'video']);
        if (!s) continue;
        if (s.kind === 'image') { setFace(s); if (!speak) setParams({ mode: null }); }
        else if (s.kind === 'audio') { setVoice(s); if (!speak) setParams({ mode: null }); }
        else { setClip(s); if (speak) setParams({ mode: 'sound' }); }
      }
    },
  );
  // Speak renders in two stages, so its size is 64-aligned.
  const size = (() => {
    return tierSizeOf(res, face?.w, face?.h, 64);
  })();
  const seconds = speak
    ? Math.max(1, Math.min(10, Math.floor((voice?.seconds ?? 5) * 10) / 10))
    : Math.max(1, Math.min(20, Math.floor((clip?.seconds ?? 5) * 10) / 10));
  const est = useEstimate({ kind: 'video', model: mode, w: size.w, h: size.h, seconds: Math.round(seconds) });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && settingsOf(t).app === mode));
  // A cast member named in the direction stands in for the face: their hero frame becomes it.
  const castFace = useMentioned(prompt).some((m) => m.refs.length);
  const ready = speak ? (!!face || castFace) && !!voice : clip?.kind === 'video';

  async function go() {
    setBusy('Queuing...');
    try {
      const r = speak ? await api.generate(speakBody()) : await api.generate(soundBody());
      toast(`Queued ${r.takeIds.length} take${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  function speakBody() {
    const f = face, v = voice!;
    const body = {
      kind: 'speak', app: 'speak', videoModel: 'ltx25', startImage: f?.token, audio: v.token, audioStart: 0, seconds,
      prompt: compilePrompt([prompt.trim() || SPEAK_PROMPT, words.trim() && `They say: ${words.trim()}`]), userPrompt: words.trim() || prompt.trim() || v.name,
      width: size.w, height: size.h, count, shotName: `speak_${v.name}`.slice(0, 40),
    };
    return body;
  }

  function soundBody() {
    const c = clip!;
    const body = {
      kind: 'sound', app: 'sound', videoModel: 'ltx25', sourceVideo: c.token, parentTake: c.takeId, seconds,
      prompt: prompt.trim() || SOUND_PROMPT, userPrompt: prompt.trim() || 'Add sound',
      width: c.w, height: c.h, count, shotName: `sound_${c.name}`.slice(0, 40),
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
          <button type="button" className={speak ? 'on' : ''} onClick={() => setParams({ mode: null })}>Speak</button>
          <button type="button" className={!speak ? 'on' : ''} onClick={() => setParams({ mode: 'sound' })}>Add sound</button>
        </div>

        {speak ? (
          <>
            <SourceSlot label="Face" value={face} onChange={setFace} accept={['image']} title="Add a face" sub="Head and shoulders, facing the camera, mouth visible." />
            <SourceSlot label="Voice" value={voice} onChange={setVoice} accept={['audio']} title="Add a sound file" sub="WAV or MP3, up to 10 seconds are used. Speech, singing or music." />
            <div className="rail-section">
              <div className="label">What they say · optional</div>
              <textarea className="prompt" rows={2} value={words} onChange={(e) => setWords(e.target.value)} placeholder="The words in the recording. It helps the mouth shapes." />
            </div>
            <div className="rail-section">
              <div className="label">Direction · optional</div>
              <MentionBox className="prompt" rows={2} value={prompt} onChange={setPrompt} placeholder="A tired old sailor talks quietly, rain on his hood. Type @ for your cast." />
              {!face && castFace && <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>No face added: a portrait of your cast member is made first and used as the face.</div>}
            </div>
          </>
        ) : (
          <>
            <SourceSlot label="Clip" value={clip} onChange={setClip} accept={['video']} title="Add a clip" sub="The picture stays exactly as it is. Up to 20 seconds." />
            <div className="rail-section">
              <div className="label">What it should sound like · optional</div>
              <textarea className="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Hammer strikes on an anvil, a roaring forge, hissing sparks." />
            </div>
            {clip && clip.kind === 'video' && <div className="dim" style={{ fontSize: 12.5 }}>Any sound the clip has now is replaced.</div>}
          </>
        )}

        <div className="chip-row" style={{ alignItems: 'center' }}>
          <span className="chip"><Icon name="clock" size={14} />{seconds.toFixed(1)}s</span>
          {speak
            ? <TierChip app="speak" value={res} onChange={setRes} />
            : <span className="chip"><Icon name="aspect" size={14} />{clip?.w ? `${clip.w}x${clip.h}` : 'clip size'}</span>}
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !ready} onClick={() => void go()}>
          <span>{busy ?? (speak ? 'Speak' : 'Add sound')}</span>
          <span className="cost">{speak ? `${size.w}x${size.h}${est ? ` · ${fmtSeconds(est * count)}` : ''}` : est ? fmtSeconds(est * count) : 'LTX-2.5 audio + video'}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}><button type="button" className="on">Takes</button></div>
        </div>
        <div className="canvas-body">
          {takes.length === 0 ? (
            <div className="hero-empty">
              <div className="label" style={{ marginBottom: 14 }}>{speak ? 'Sound in, picture out' : 'Picture in, sound out'}</div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>
                {speak ? <>Give a face <span className="hl">your voice</span></> : <>Every take <span className="hl">gets a soundtrack</span></>}
              </div>
              <div className="steps3">
                {speak ? <>
                  <div><span className="label">01</span><b>Add a face</b><span className="dim">A still from Image, or your own photo.</span></div>
                  <div><span className="label">02</span><b>Add the voice</b><span className="dim">A recording of speech, a song, a beat.</span></div>
                  <div><span className="label">03</span><b>Speak</b><span className="dim">Your audio stays untouched; the picture moves to it.</span></div>
                </> : <>
                  <div><span className="label">01</span><b>Pick a silent take</b><span className="dim">Or any clip you want to re-sound.</span></div>
                  <div><span className="label">02</span><b>Describe the sound</b><span className="dim">Or leave it empty and let the picture decide.</span></div>
                  <div><span className="label">03</span><b>Add sound</b><span className="dim">The frames are untouched; only audio is made.</span></div>
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
