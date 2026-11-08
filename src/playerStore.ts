/**
 * The popup player: one shared audio element the whole app plays through.
 * The queue is the finished audio takes (newest first, feed order). The
 * popup draws a live bar visualizer from an analyser on the element and a
 * seekable waveform from peaks decoded once per take; transport, volume,
 * shuffle and repeat live here so the Viewer, the cards and the popup
 * always agree on what is playing.
 */
import { useSyncExternalStore } from 'react';
import { mediaUrl } from './api';
import { getState, inFeed, isAudio } from './store';

export type Repeat = 'off' | 'all' | 'one';

export interface PlayerState {
  current: number | null;
  playing: boolean;
  dur: number;
  volume: number;
  muted: boolean;
  repeat: Repeat;
  shuffle: boolean;
  open: boolean;
  /** Measured file bitrate (kbps), known once the take's peaks are decoded and its duration is loaded. */
  kbps: number | null;
}

const PREF_KEY = 'morpheus.player';

function loadPrefs(): Pick<PlayerState, 'volume' | 'muted' | 'repeat' | 'shuffle'> {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
    return {
      volume: typeof p.volume === 'number' ? Math.max(0, Math.min(1, p.volume)) : 0.85,
      muted: !!p.muted,
      repeat: p.repeat === 'all' || p.repeat === 'one' ? p.repeat : 'off',
      shuffle: !!p.shuffle,
    };
  } catch {
    return { volume: 0.85, muted: false, repeat: 'off', shuffle: false };
  }
}

let state: PlayerState = { current: null, playing: false, dur: 0, kbps: null, open: false, ...loadPrefs() };
const listeners = new Set<() => void>();

let prefTimer: number | undefined;
function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = window.setTimeout(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ volume: state.volume, muted: state.muted, repeat: state.repeat, shuffle: state.shuffle })); } catch { /* private mode */ }
  }, 250);
}

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  if (patch.volume !== undefined || patch.muted !== undefined || patch.repeat !== undefined || patch.shuffle !== undefined) savePrefs();
}

const subscribe = (l: () => void) => (listeners.add(l), () => { listeners.delete(l); });
const snap = () => state;

export function usePlayer<T>(sel: (s: PlayerState) => T): T {
  return sel(useSyncExternalStore(subscribe, snap));
}
export const playerState = () => state;

// ---------- the one element the whole app plays through ----------
const el = document.createElement('audio');
el.preload = 'auto';
el.volume = state.muted ? 0 : state.volume;

// ---------- graph: analyser for the bar visualizer (created once, on a gesture) ----------
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
function ensureGraph() {
  if (!ctx) {
    const AC: typeof AudioContext = window.AudioContext
      || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    const src = ctx.createMediaElementSource(el);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    src.connect(analyser).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
}
export const getAnalyser = () => analyser;

export const getPosition = () => el.currentTime;
export const getDuration = () => el.duration || 0;

// ---------- queue: the finished audio takes, feed order ----------
export function queue(): number[] {
  return getState().takes
    .filter((t) => inFeed(t) && isAudio(t) && t.status === 'done' && !!t.output_path)
    .map((t) => t.id);
}

// ---------- waveform peaks: decode once per take, cache ----------
const peaks = new Map<number, Float32Array>();
const bytes = new Map<number, number>();
const inflight = new Map<number, Promise<Float32Array | null>>();
export const peaksOf = (id: number) => peaks.get(id);

const PEAK_N = 560;
function decode(id: number): Promise<Float32Array | null> {
  let p = inflight.get(id);
  if (!p) {
    p = (async () => {
      ensureGraph();
      const blob = await (await fetch(mediaUrl(id))).blob();
      const buf = await blob.arrayBuffer();
      const audio = await ctx!.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const out = new Float32Array(PEAK_N);
      const stepLen = Math.max(1, Math.floor(data.length / PEAK_N));
      let max = 0;
      let n = 0;
      for (let i = 0; i < PEAK_N && n < data.length; i++) {
        let peak = 0;
        const end = Math.min(data.length, n + stepLen);
        for (let j = n; j < end; j += 4) {
          const v = Math.abs(data[j]);
          if (v > peak) peak = v;
        }
        out[i] = peak;
        if (peak > max) max = peak;
        n = end;
      }
      if (max > 0) for (let i = 0; i < PEAK_N; i++) out[i] /= max;
      peaks.set(id, out);
      bytes.set(id, blob.size);
      // The duration may already be loaded; then the bitrate is known now.
      if (state.current === id && el.duration > 0) set({ kbps: Math.round((blob.size * 8) / 1000 / el.duration) });
      return out;
    })().catch(() => null);
    inflight.set(id, p);
  }
  return p;
}

// ---------- element events ----------
el.addEventListener('play', () => set({ playing: true }));
el.addEventListener('pause', () => set({ playing: false }));
el.addEventListener('loadedmetadata', () => {
  const d = el.duration || 0;
  const b = state.current != null ? bytes.get(state.current) : undefined;
  set({ dur: d, kbps: b && d > 0 ? Math.round((b * 8) / 1000 / d) : null });
});
el.addEventListener('durationchange', () => {
  const d = el.duration || 0;
  const b = state.current != null ? bytes.get(state.current) : undefined;
  set({ dur: d, kbps: b && d > 0 ? Math.round((b * 8) / 1000 / d) : null });
});
el.addEventListener('ended', () => {
  if (state.repeat === 'one') {
    el.currentTime = 0;
    void el.play().catch(() => {});
    return;
  }
  const q = queue();
  const i = state.current == null ? -1 : q.indexOf(state.current);
  if (i >= 0 && i + 1 < q.length) playTake(q[i + 1]);
  else if (i >= 0 && state.repeat === 'all' && q.length) playTake(q[0]);
  else set({ playing: false });
});

// ---------- transport ----------
function load(id: number) {
  el.src = mediaUrl(id);
  el.currentTime = 0;
  set({ current: id, dur: 0, kbps: null, playing: false });
}

/** Make this take the one playing (and keep it playing). Always opens the popup. */
export function playTake(id: number, autoplay = true) {
  ensureGraph();
  if (state.current !== id) load(id);
  if (autoplay) void el.play().catch(() => set({ playing: false }));
  set({ open: true });
  void decode(id);
}

export function toggle() {
  if (state.current == null) return;
  ensureGraph();
  if (el.paused) void el.play().catch(() => {});
  else el.pause();
}

export function pause() {
  el.pause();
}

export function seek(t: number) {
  const d = el.duration;
  if (d && isFinite(d)) el.currentTime = Math.max(0, Math.min(d - 0.05, t));
}

export function seekBy(dt: number) {
  seek(el.currentTime + dt);
}

export function setVolume(v: number) {
  const volume = Math.max(0, Math.min(1, v));
  el.volume = volume;
  set({ volume, muted: false });
}

export function toggleMute() {
  el.volume = state.muted ? state.volume : 0;
  set({ muted: !state.muted });
}

function step(dir: 1 | -1) {
  const q = queue();
  if (!q.length) return;
  if (state.shuffle && q.length > 1) {
    const i = q.indexOf(state.current!);
    let n = i;
    while (n === i) n = Math.floor(Math.random() * q.length);
    playTake(q[n]);
    return;
  }
  const i = state.current == null ? -1 : q.indexOf(state.current);
  const n = i + dir;
  if (n < 0 || n >= q.length) {
    if (state.repeat === 'all') playTake(q[(n + q.length) % q.length]);
    else if (i < 0) playTake(q[0]);
    return;
  }
  playTake(q[n]);
}

export function next() {
  step(1);
}

/** Standard behaviour: restart the track after the first few seconds, else step back. */
export function prev() {
  if (el.currentTime > 3) {
    el.currentTime = 0;
    return;
  }
  step(-1);
}

export function cycleRepeat() {
  const order: Repeat[] = ['off', 'all', 'one'];
  set({ repeat: order[(order.indexOf(state.repeat) + 1) % order.length] });
}

export function toggleShuffle() {
  set({ shuffle: !state.shuffle });
}

export function openPlayer(open = true) {
  set({ open });
}
