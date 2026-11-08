/**
 * App-wide live state: takes (the asset feed), engine status, per-job
 * progress and the latest preview frame. One socket feeds it; components
 * subscribe with useStore(selector).
 */
import { useSyncExternalStore } from 'react';
import { api, connectLive, type PairEvent, type PhoneEvent, type Status, type Take } from './api';

export interface Live {
  takes: Take[];
  status: Status | null;
  progress: Record<string, { value: number; max: number }>;
  /** Jobs the engine has started (the rest of the active takes are waiting in its line). */
  started: Record<string, true>;
  /** The newest live preview frame and the render it belongs to. */
  preview: { url: string; promptId: string | null } | null;
  toast: { text: string; err?: boolean } | null;
  /** App ids pinned to the header as quick links, in the order they were added. */
  favorites: string[];
}

const FAV_KEY = 'morpheus.favorites';
function loadFavorites(): string[] {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); } catch { return []; }
}

let state: Live = { takes: [], status: null, progress: {}, started: {}, preview: null, toast: null, favorites: loadFavorites() };
const listeners = new Set<() => void>();
function set(patch: Partial<Live>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => { listeners.delete(l); });
const snap = () => state;

/** Subscribe to the whole state (a stable snapshot) and derive with `sel`. */
export function useStore<T>(sel: (s: Live) => T): T {
  return sel(useSyncExternalStore(subscribe, snap));
}
export const getState = () => state;

let toastTimer: number | undefined;
export function toast(text: string, err = false) {
  set({ toast: { text, err } });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set({ toast: null }), err ? 7000 : 3500);
}

/** Pin/unpin an app to the header quick links. Survives reloads via localStorage. */
export function toggleFavorite(id: string) {
  const has = state.favorites.includes(id);
  const favorites = has ? state.favorites.filter((x) => x !== id) : [...state.favorites, id];
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch { /* private mode */ }
  set({ favorites });
}

export async function refreshTakes() {
  try {
    set({ takes: await api.takes(null) });
  } catch {
    /* server down; status shows it */
  }
}

export async function refreshStatus() {
  try {
    set({ status: await api.status() });
  } catch {
    set({ status: { up: false, active: [] } });
  }
}

function upsert(t: Take) {
  const i = state.takes.findIndex((x) => x.id === t.id);
  const takes = i >= 0 ? state.takes.map((x) => (x.id === t.id ? t : x)) : [t, ...state.takes];
  const progress = { ...state.progress };
  if (t.status !== 'rendering' && t.status !== 'queued' && t.prompt_id) delete progress[t.prompt_id];
  set({ takes, progress });
}

/** Fold a fetched take into the feed (the Agent's chat cards use this to resolve a take the live socket may have missed). */
export const upsertTake = upsert;

let started = false;
export function startLive() {
  if (started) return;
  started = true;
  void refreshTakes();
  void refreshStatus();
  setInterval(refreshStatus, 4000);
  connectLive({
    onProgress: (p) => set({ progress: { ...state.progress, [p.promptId]: { value: p.value, max: p.max } } }),
    onStarted: (id) => set({ started: { ...state.started, [id]: true } }),
    onPreview: (url, promptId) => set({ preview: { url, promptId } }),
    onTake: (t) => {
      upsert(t);
      // A finished render's last frame must never show on the next one.
      if (t.status !== 'rendering' && state.preview?.promptId && state.preview.promptId === t.prompt_id) set({ preview: null });
      if (t.status === 'failed') toast(`Render failed: ${t.error ?? 'unknown error'}`, true);
    },
    onQueue: () => void refreshStatus(),
    onPhone: (e) => phoneListeners.forEach((l) => l(e)),
    onPhoneApp: (e) => pairListeners.forEach((l) => l(e)),
  });
}

/** Phone hand-off events are one-shot, so they go to listeners rather than into state. */
const phoneListeners = new Set<(e: PhoneEvent) => void>();
export function onPhoneEvent(l: (e: PhoneEvent) => void): () => void {
  phoneListeners.add(l);
  return () => { phoneListeners.delete(l); };
}

/** Pairing events (Setup > Phone) follow the same one-shot pattern. */
const pairListeners = new Set<(e: PairEvent) => void>();
export function onPairEvent(l: (e: PairEvent) => void): () => void {
  pairListeners.add(l);
  return () => { pairListeners.delete(l); };
}

/** Settings JSON of a take, parsed once. */
const parsed = new WeakMap<Take, any>();
export function settingsOf(t: Take): any {
  let s = parsed.get(t);
  if (!s) {
    try { s = JSON.parse(t.settings); } catch { s = {}; }
    parsed.set(t, s);
  }
  return s;
}

export const isImage = (t: Take) => t.kind === 'still';
/** An Object take: a GLB, with a turntable mp4 standing in for it wherever media plays. */
export const isModel = (t: Take) => t.kind === 'object';
/** An Audio take (Music or Speech): an mp3, no frames anywhere. */
export const isAudio = (t: Take) => t.kind === 'audio';
export const isActive = (t: Take) => t.status === 'queued' || t.status === 'rendering';

/**
 * Cross-page hand-off: "Animate" or "Use as reference" on an asset drops
 * refs here, then navigates; the create page takes them on mount.
 */
export interface Ref { token: string; role: 'start' | 'end' | 'ref'; kind: 'image' | 'video'; name: string }
let handoff: { refs: Ref[]; prompt?: string } | null = null;
export function setHandoff(h: { refs: Ref[]; prompt?: string }) { handoff = h; }
export function takeHandoff() { const h = handoff; handoff = null; return h; }

/** Takes that belong in a feed: not cancelled, not internal renders (preset previews, angle previews). */
const INTERNAL_APPS = new Set(['preset-thumb', 'reshoot-warp']);
export const inFeed = (t: Take) => t.status !== 'stopped' && !INTERNAL_APPS.has(settingsOf(t).app);
