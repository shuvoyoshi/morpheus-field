/**
 * Audio: two engines, one feed.
 *  Music  — ACE-Step 1.5 XL turns tags and lyrics into a full song, with key,
 *           tempo, language and length (5 s to 5 min). Turbo is the 8-step
 *           distill for drafts, Base the full 30 steps.
 *  Speech — Qwen3-TTS 1.7B VoiceDesign says your words in a voice you
 *           describe in plain words.
 * Every result is an ordinary take (kind 'audio'), so Library, the Viewer,
 * favorites and downloads all work on it.
 */
import { useState } from 'react';
import { api } from '../api';
import { ACE_KEYS, ACE_LANGUAGES, ACE_TIMESIGS, TTS_LANGUAGES } from '../catalog';
import { setParams, useRoute } from '../router';
import { isAudio, inFeed, toast, useStore } from '../store';
import { ChipMenu, Clip, Icon, MediaCard, Spill, Stepper, fmtSeconds, presetClip, useEstimate, RailHandle, useRail } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';

const SEC_MIN = 5, SEC_MAX = 300;

function fmtDur(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export default function AudioPage() {
  const { params } = useRoute();
  // Mode lives in the URL like every other page: the tabs below call setParams.
  const mode: 'music' | 'speech' = params.get('mode') === 'speech' ? 'speech' : 'music';
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [count, setCount] = useState(1);

  // Music
  const [tags, setTags] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [model, setModel] = useState<'turbo' | 'base'>('turbo');
  const [key, setKey] = useState('E minor');
  const [bpm, setBpm] = useState(120);
  const [timesig, setTimesig] = useState('4');
  const [language, setLanguage] = useState('en');
  const [seconds, setSeconds] = useState(15);
  // Speech
  const [text, setText] = useState('');
  const [instruct, setInstruct] = useState('');
  const [lang, setLang] = useState('Auto');

  const music = mode === 'music';
  const est = useEstimate(music
    ? { kind: 'music', app: 'audio', model, seconds }
    : { kind: 'speech', app: 'audio', model: 'qwen3-tts' });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && isAudio(t)));
  const done = takes.filter((t) => t.status === 'done');

  const ready = music ? !!(tags.trim() || lyrics.trim()) : !!text.trim();

  async function go() {
    if (!ready) return;
    setBusy('Queuing...');
    try {
      const r = music
        ? await api.generate({
          kind: 'music', app: 'audio', model, tags, lyrics, key, bpm, timesignature: timesig, language, seconds,
          count, shotName: (tags || lyrics).slice(0, 30),
        })
        : await api.generate({
          kind: 'speech', app: 'audio', model: 'qwen3-tts', text, instruct, language: lang,
          count, shotName: text.slice(0, 30),
        });
      toast(`Queued ${r.takeIds.length} audio render${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  const clampSec = (v: number) => Math.max(SEC_MIN, Math.min(SEC_MAX, Math.round(v) || SEC_MIN));

  const step = (dir: 1 | -1) => {
    if (!done.length) return;
    const i = done.findIndex((t) => t.id === viewing);
    const n = done[(i + dir + done.length) % done.length];
    if (n) setViewing(n.id);
  };

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`rail-layout ${railOpen ? '' : 'rail-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="rail">
        <Spill src={presetClip('golden')} video />
        <div className="display" style={{ fontSize: 26 }}>Audio</div>
        <div className="edit-apps">
          <button type="button" className={`edit-app ${music ? 'on' : ''}`} onClick={() => setParams({ mode: null })}>
            <Icon name="audio" size={14} /><span>Music</span>
          </button>
          <button type="button" className={`edit-app ${!music ? 'on' : ''}`} onClick={() => setParams({ mode: 'speech' })}>
            <Icon name="person" size={14} /><span>Speech</span>
          </button>
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: -4 }}>
          {music ? 'Lyrics and tags in, a full song out — ACE-Step 1.5 XL.' : 'Your words, in a voice you describe — Qwen3-TTS.'}
        </div>

        {music ? (
          <>
            <div className="rail-section">
              <div className="label">Tags · mood, genre, instruments</div>
              <textarea className="prompt" rows={3} value={tags} onChange={(e) => setTags(e.target.value)}
                placeholder="late night lo-fi, warm vinyl crackle, soft jazz piano, mellow bass"
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready && !busy) void go(); }} />
            </div>
            <div className="rail-section">
              <div className="label">Lyrics · optional</div>
              <textarea className="prompt" rows={4} value={lyrics} onChange={(e) => setLyrics(e.target.value)}
                placeholder={'[verse]\n...\n[chorus]\n...'}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready && !busy) void go(); }} />
            </div>

            <div className="rail-section">
              <div className="label">Engine</div>
              <div className="chip-row">
                <button type="button" className={`chip ${model === 'turbo' ? 'on' : ''}`} onClick={() => setModel('turbo')}
                  title="The distilled 8-step weights. Fast drafts.">
                  <Icon name="bolt" size={14} />Turbo · 8 steps
                </button>
                <button type="button" className={`chip ${model === 'base' ? 'on' : ''}`} onClick={() => setModel('base')}
                  title="The full 30 steps. Slower, more character.">
                  Base · 30 steps
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <ChipMenu value={key} onChange={setKey} title="Key" options={ACE_KEYS.map((k) => ({ value: k, label: k }))} />
                <ChipMenu value={timesig} onChange={setTimesig} title="Time signature" options={ACE_TIMESIGS.map((t) => ({ value: t.id, label: t.label }))} />
                <ChipMenu value={language} onChange={setLanguage} title="Lyric language" options={ACE_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} />
                <ChipMenu value={bpm} onChange={(v) => setBpm(Math.max(10, Math.min(300, v)))} title="Tempo"
                  options={Array.from({ length: 30 }, (_, i) => ({ value: 10 + i * 10, label: `${10 + i * 10} BPM` }))} />
              </div>
            </div>

            <div className="rail-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="label" style={{ marginBottom: 0 }}>Length</span>
                <span className="mono" style={{ fontSize: 12 }}>{fmtDur(seconds)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input type="range" min={SEC_MIN} max={SEC_MAX} step={1} value={seconds}
                  onChange={(e) => setSeconds(clampSec(Number(e.target.value)))}
                  style={{ flex: 1, accentColor: 'var(--accent)' }} />
                <input className="field" type="number" min={SEC_MIN} max={SEC_MAX} step={1} value={seconds}
                  onChange={(e) => setSeconds(clampSec(Number(e.target.value)))}
                  onBlur={(e) => setSeconds(clampSec(Number(e.target.value)))}
                  style={{ width: 62, textAlign: 'right' }} aria-label="Length in seconds" />
              </div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>5 seconds to 5 minutes, one second at a time. Longer takes take longer to render.</div>
            </div>
          </>
        ) : (
          <>
            <div className="rail-section">
              <div className="label">Words to say</div>
              <textarea className="prompt" rows={4} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Asta la vista, friend. See you on the other side."
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready && !busy) void go(); }} />
            </div>
            <div className="rail-section">
              <div className="label">The voice · in words</div>
              <textarea className="prompt" rows={3} value={instruct} onChange={(e) => setInstruct(e.target.value)}
                placeholder="a warm, weathered voice, dry and unhurried, like a western hero shrugging off a long ride" />
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Timbre, emotion, pace — whatever the voice should be.</div>
            </div>
            <div className="rail-section">
              <div className="label">Language</div>
              <ChipMenu value={lang} onChange={setLang} options={TTS_LANGUAGES.map((l) => ({ value: l, label: l }))} />
            </div>
          </>
        )}

        <div className="chip-row" style={{ alignItems: 'center', gap: 8 }}>
          {music
            ? <span className="chip"><Icon name="res" size={14} />{model === 'turbo' ? '8 steps' : '30 steps'}</span>
            : <span className="chip"><Icon name="res" size={14} />1.7B</span>}
          <span className="chip"><Icon name="audio" size={14} />MP3</span>
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
        </div>

        <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !ready} onClick={() => void go()}>
          <span>{busy ?? (music ? 'Make music' : 'Speak')}</span>
          <span className="cost">{est ? fmtSeconds(est * count) : (music ? 'ACE-Step 1.5' : 'Qwen3-TTS')}</span>
        </button>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className="on">Results · {takes.length}</button>
          </div>
        </div>
        <div className="canvas-body">
          {takes.length === 0 ? (
            <div className="hero-empty">
              <div className="fan">
                {['golden', 'bloom', 'dreamlike', 'noir'].map((id) => <div key={id}><Clip src={presetClip(id)} className="" /></div>)}
              </div>
              <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>
                {music ? <>Write it, <span className="hl">hear it</span></> : <>Say it in <span className="hl">any voice</span></>}
              </div>
              <div className="steps3">
                {music ? <>
                  <div><span className="label">01</span><b>Tags and lyrics</b><span className="dim">Mood, genre, instruments — words like the back of a record sleeve.</span></div>
                  <div><span className="label">02</span><b>Key, tempo, length</b><span className="dim">Five seconds to five minutes, one second at a time.</span></div>
                  <div><span className="label">03</span><b>Turbo or Base</b><span className="dim">Eight steps for a draft, thirty for the keeper.</span></div>
                </> : <>
                  <div><span className="label">01</span><b>Your words</b><span className="dim">A line, a paragraph, a whole scene.</span></div>
                  <div><span className="label">02</span><b>Describe the voice</b><span className="dim">Warm and dry, bright and quick — in plain words.</span></div>
                  <div><span className="label">03</span><b>Play it back</b><span className="dim">A new take every time; keep the one that sounds right.</span></div>
                </>}
              </div>
            </div>
          ) : (
            <div className="edit-batches">
              <div className="edit-batch">
                <div className="grid edit-grid n{Math.min(done.length, 9)}" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(220px, 1fr))` }}>
                  {takes.map((t) => (
                    <MediaCard key={t.id} take={t} onOpen={() => setViewing(t.id)} actions={<>
                      <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                      <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                    </>} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
    </div>
  );
}
