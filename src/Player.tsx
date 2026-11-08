/**
 * The popup media player: a floating glass card, styled after a desktop
 * music app. Left column reads like a now-playing widget — a live bar
 * visualizer over the analyser, the seekable waveform (decoded peaks),
 * time and transport; the right is the track. Draggable from its header;
 * the queue is the finished audio takes, so prev/next/shuffle/repeat walk it.
 */
import { useEffect, useRef, useState } from 'react';
import { ACE_LANGUAGES, ACE_TIMESIGS } from './catalog';
import { settingsOf, useStore } from './store';
import {
  cycleRepeat, getAnalyser, getDuration, getPosition, next, openPlayer, pause,
  peaksOf, playerState, prev, playTake, queue, seek, setVolume,
  toggle, toggleMute, toggleShuffle, usePlayer,
} from './playerStore';
import { Icon } from './ui';

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

const BARS = 40;

export default function Player() {
  const open = usePlayer((p) => p.open);
  const current = usePlayer((p) => p.current);
  const playing = usePlayer((p) => p.playing);
  const volume = usePlayer((p) => p.volume);
  const muted = usePlayer((p) => p.muted);
  const repeat = usePlayer((p) => p.repeat);
  const shuffle = usePlayer((p) => p.shuffle);
  const dur = usePlayer((p) => p.dur);
  const kbps = usePlayer((p) => p.kbps);

  const take = useStore((s) => (current == null ? undefined : s.takes.find((x) => x.id === current)));

  const [pos, setPos] = useState(0);
  const [where, setWhere] = useState<{ x: number; y: number } | null>(null);

  const vizRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const smooth = useRef<number[]>([]);
  const freq = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const hover = useRef<number | null>(null);
  const drag = useRef<{ ox: number; oy: number } | null>(null);
  const grad = useRef<CanvasGradient | null>(null);
  const gradH = useRef(0);

  // Clock for the time readout (the canvases read the element live in rAF).
  useEffect(() => {
    if (!playing || current == null) return;
    const t = window.setInterval(() => setPos(getPosition()), 200);
    return () => clearInterval(t);
  }, [playing, current]);
  useEffect(() => { setPos(getPosition()); }, [current]);

  // Space toggles playback while the popup is up (the Viewer keeps its own keys).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const st = playerState();
      if (!st.open || st.current == null) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.viewer-back')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // The draw loop: bars from the analyser, waveform from the peaks, both live.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const st = playerState();
      if (!st.open || st.current == null) return;
      const dpr = window.devicePixelRatio || 1;

      const cv = vizRef.current;
      if (cv && cv.clientWidth > 0) {
        const W = Math.round(cv.clientWidth * dpr);
        const H = Math.round(cv.clientHeight * dpr);
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; grad.current = null; }
        const c = cv.getContext('2d');
        if (c) drawBars(c, W, H, dpr);
      }

      const wv = waveRef.current;
      if (wv && wv.clientWidth > 0) {
        const W = Math.round(wv.clientWidth * dpr);
        const H = Math.round(wv.clientHeight * dpr);
        if (wv.width !== W || wv.height !== H) { wv.width = W; wv.height = H; }
        const c = wv.getContext('2d');
        if (c) drawWave(c, W, H, st.current, dpr);
      }
    };

    function drawBars(c: CanvasRenderingContext2D, W: number, H: number, dpr: number) {
      c.clearRect(0, 0, W, H);
      const an = getAnalyser();
      if (an && an.fftSize) {
        if (!freq.current || freq.current.length !== an.frequencyBinCount) freq.current = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(freq.current);
      }
      const data = an ? freq.current : null;
      const s = smooth.current;
      if (s.length !== BARS) {
        smooth.current = new Array(BARS).fill(0);
        return;
      }
      if (!grad.current || gradH.current !== H) {
        const g = c.createLinearGradient(0, H, 0, 0);
        g.addColorStop(0, '#d95600');
        g.addColorStop(0.55, '#ff6600');
        g.addColorStop(1, '#ff9d5c');
        grad.current = g;
        gradH.current = H;
      }
      const r = Math.pow(210, 1 / BARS);
      const bw = W / BARS;
      c.fillStyle = grad.current;
      for (let i = 0; i < BARS; i++) {
        let target = 0.02;
        if (data) {
          const lo = Math.max(1, Math.floor(Math.pow(r, i)));
          const hi = Math.min(data.length, Math.max(lo + 1, Math.ceil(Math.pow(r, i + 1))));
          let sum = 0;
          for (let b = lo; b < hi; b++) sum += data[b];
          target = sum / (hi - lo) / 255;
        }
        s[i] = Math.max(target, s[i] * 0.86);
        const bh = Math.max(2 * dpr, s[i] * H * 0.94);
        const x = i * bw + bw * 0.2;
        const w = bw * 0.6;
        if (typeof c.roundRect === 'function') {
          c.beginPath();
          c.roundRect(x, H - bh, w, bh, Math.min(w / 2, 3 * dpr));
          c.fill();
        } else {
          c.fillRect(x, H - bh, w, bh);
        }
      }
    }

    function drawWave(c: CanvasRenderingContext2D, W: number, H: number, id: number, dpr: number) {
      c.clearRect(0, 0, W, H);
      const pk = peaksOf(id);
      const d = getDuration();
      const frac = d > 0 ? Math.min(1, getPosition() / d) : 0;
      if (!pk) {
        c.fillStyle = 'rgba(232, 235, 239, 0.10)';
        const y = Math.round(H / 2);
        for (let x = 0; x < W; x += 6 * dpr) c.fillRect(x, y - dpr, 3 * dpr, 2 * dpr);
        return;
      }
      const n = pk.length;
      const bw = W / n;
      for (let i = 0; i < n; i++) {
        const amp = Math.max(1.5 * dpr, pk[i] * H * 0.9);
        const x = i * bw;
        const hx = hover.current;
        const isHover = hx != null && Math.abs(x + bw / 2 - hx) < bw * 2;
        c.fillStyle = (i / n) <= frac
          ? 'rgba(255, 102, 0, 0.95)'
          : isHover ? 'rgba(232, 235, 239, 0.55)' : 'rgba(232, 235, 239, 0.16)';
        c.fillRect(x, (H - amp) / 2, Math.max(1, bw * 0.62), amp);
      }
      const px = frac * W;
      c.fillStyle = '#ff9d5c';
      c.fillRect(px - dpr, 0, 2 * dpr, H);
    }

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (current == null) return null;
  if (!take) return null;
  const s = settingsOf(take);
  const music = s.model !== 'qwen3-tts';
  const q = queue();
  const qi = q.indexOf(take.id);
  const timeSig = ACE_TIMESIGS.find((t) => t.id === s.timesignature)?.label ?? (s.timesignature ? `${s.timesignature}/4` : null);
  const langLabel = music ? ACE_LANGUAGES.find((l) => l.id === s.language)?.label : undefined;

  const title = take.shot_name || (s.userPrompt ?? s.tags ?? '').toString().slice(0, 60) || 'Untitled';
  const sub = music
    ? `ACE-Step 1.5 ${s.model === 'base' ? 'Base · 30 steps' : 'Turbo · 8 steps'}${langLabel && langLabel !== 'English' ? ` · ${langLabel}` : ''}`
    : `Qwen3-TTS 1.7B VoiceDesign${s.language && s.language !== 'Auto' ? ` · ${s.language}` : ''}`;

  const chips: { text: string; key?: boolean }[] = [
    { text: music ? 'ACE-Step 1.5' : 'Qwen3-TTS 1.7B', key: true },
  ];
  if (music) {
    if (s.key) chips.push({ text: s.key });
    if (s.bpm) chips.push({ text: `${s.bpm} BPM` });
    if (timeSig) chips.push({ text: timeSig });
  } else if (s.language && s.language !== 'Auto') chips.push({ text: s.language });
  if (kbps) chips.push({ text: `${kbps} kbps` });
  if (s.seed != null) chips.push({ text: `seed ${s.seed}` });
  if (qi >= 0) chips.push({ text: `${qi + 1} / ${q.length}` });

  // Drag from the header; the position sticks for the session.
  const onHeadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const node = e.currentTarget;
    const rect = node.closest('.player')!.getBoundingClientRect();
    drag.current = { ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    node.setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const panel = e.currentTarget.parentElement;
    const w = panel ? panel.clientWidth : 480;
    const h = panel ? panel.clientHeight : 260;
    const x = Math.max(8, Math.min(window.innerWidth - w - 4, e.clientX - drag.current.ox));
    const y = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - drag.current.oy));
    setWhere({ x, y });
  };
  const onHeadUp = () => { drag.current = null; };

  const waveSeek = (clientX: number, rect: DOMRect) => {
    const d = getDuration();
    if (d > 0) {
      seek((clientX - rect.left) / rect.width * d);
      setPos(getPosition());
    }
  };
  const onWaveDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    waveSeek(e.clientX, rect);
    const move = (ev: PointerEvent) => waveSeek(ev.clientX, rect);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const style: React.CSSProperties = where
    ? { left: where.x, top: where.y, right: 'auto', bottom: 'auto' }
    : {};

  return (
    <div className={`player ${open ? 'show' : ''}`} style={style} role="region" aria-label="Music player">
      <div className="player-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp}>
        <div className="player-art"><Icon name="audio" size={26} /></div>
        <div className="player-id">
          <div className="player-title" title={title}>{title}</div>
          <div className="player-sub">{sub}</div>
        </div>
        <button type="button" className="icon-btn" onClick={() => openPlayer(false)} aria-label="Close the player"><Icon name="x" size={13} /></button>
      </div>

      <canvas ref={vizRef} className="viz" aria-hidden />
      <div className="player-times mono">
        <span>{fmtTime(pos)}</span>
        <span className="dim">- {fmtTime(dur - pos)}</span>
      </div>

      <canvas
        ref={waveRef}
        className="wave"
        onPointerDown={onWaveDown}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          hover.current = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
        }}
        onPointerLeave={() => { hover.current = null; }}
        aria-label="Waveform, click to seek"
      />

      <div className="player-ctl">
        <button type="button" className={`pc ${shuffle ? 'on' : ''}`} title={shuffle ? 'Shuffle on' : 'Shuffle off'} onClick={toggleShuffle}><Icon name="shuffle" size={16} /></button>
        <button type="button" className="pc" title="Previous (restarts the track after 3 s)" onClick={prev}><Icon name="prev" size={17} /></button>
        <button type="button" className="pc-main" title={playing ? 'Pause' : 'Play'} onClick={toggle}><Icon name={playing ? 'pause' : 'play'} size={21} /></button>
        <button type="button" className="pc" title="Next" onClick={next}><Icon name="next" size={17} /></button>
        <button type="button" className={`pc ${repeat !== 'off' ? 'on' : ''}`}
          title={repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeating the queue' : 'Repeating this track'}
          onClick={cycleRepeat}>
          <Icon name="repeat" size={16} />
          {repeat === 'one' && <i className="pc-dot">1</i>}
        </button>
        <div className="player-vol">
          <button type="button" className="pc" title={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
            <Icon name={muted || volume === 0 ? 'volx' : 'vol'} size={16} />
          </button>
          <input
            type="range" min={0} max={1} step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
          />
        </div>
      </div>

      <div className="player-stats">
        {chips.map((c) => <span key={c.text} className={`pstat ${c.key ? 'key' : ''}`}>{c.text}</span>)}
      </div>
    </div>
  );
}
