/** Shared UI kit: icons, chips with menus, media cards, GPU chip, logo. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { api, posterUrl, mediaUrl, turntableUrl, type AgentConfig, type EngineGpu, type EngineMode, type LlmModel, type Take } from './api';
import { isActive, isAudio, isImage, isModel, refreshStatus, settingsOf, toast, useStore } from './store';
import { APP_MAX_TIER, RENDER_TIERS, appTier, tierCapNote, tierDef, tiersUpTo, type RenderTier, type TierApp } from './renderTier';
import { takeDragProps } from './drop';
import { VIDEO_DECODES, type VideoDecode } from './videoDecode';
import { pause, playTake, usePlayer } from './playerStore';

// ---------- icons (1.6px stroke, 16px box) ----------
const P: Record<string, ReactNode> = {
  image: <><rect x="2.5" y="3" width="11" height="10" rx="2" /><circle cx="6" cy="6.5" r="1.2" /><path d="M3 11.5l3.2-3 2.3 2 2-1.6 2.5 2.4" /></>,
  video: <><rect x="2" y="3.5" width="9" height="9" rx="2" /><path d="M11 7l3-2v6l-3-2" /></>,
  audio: <><path d="M6 11.5V4l6-1.5V10" /><circle cx="4.5" cy="11.5" r="1.5" /><circle cx="10.5" cy="10" r="1.5" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  aspect: <><rect x="2.5" y="4" width="11" height="8" rx="1.5" /></>,
  res: <><path d="M8 2.5l5 3v5l-5 3-5-3v-5z" /></>,
  sparkle: <><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M12 4l-1.8 1.8M5.8 10.2L4 12" /></>,
  plus: <><path d="M8 3v10M3 8h10" /></>,
  minus: <><path d="M3 8h10" /></>,
  x: <><path d="M4 4l8 8M12 4l-8 8" /></>,
  chev: <><path d="M6 4l4 4-4 4" /></>,
  down: <><path d="M4 6l4 4 4-4" /></>,
  heart: <><path d="M8 13s-5-3-5-6.5A2.5 2.5 0 018 5a2.5 2.5 0 015 1.5C13 10 8 13 8 13z" /></>,
  star: <><path d="M8 1.9L9.6 6L14 6.3L10.6 9L11.7 13.3L8 10.9L4.3 13.3L5.4 9L2 6.3L6.4 6Z" /></>,
  download: <><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" /></>,
  redo: <><path d="M12.5 6.5A5 5 0 103 9" /><path d="M12.5 3v3.5H9" /></>,
  undo: <><path d="M3.5 6.5A5 5 0 1113 9" /><path d="M3.5 3v3.5H7" /></>,
  wand: <><path d="M3 13l7-7M9 3l.5 1.5L11 5l-1.5.5L9 7l-.5-1.5L7 5l1.5-.5zM12.5 8l.3.9.9.3-.9.3-.3.9-.3-.9-.9-.3.9-.3z" /></>,
  ref: <><rect x="2.5" y="2.5" width="7" height="7" rx="1.5" /><path d="M6.5 13.5h7v-7" /></>,
  up: <><path d="M3 10l5-5 5 5" /></>,
  loop: <><path d="M3 8a4 4 0 017-2.6M13 8a4 4 0 01-7 2.6" /><path d="M10 2.5v3h-3M6 13.5v-3h3" /></>,
  phone: <><rect x="4.5" y="1.5" width="7" height="13" rx="1.8" /><path d="M7 12.5h2" /></>,
  camera: <><rect x="2" y="4.5" width="12" height="8.5" rx="2" /><circle cx="8" cy="8.7" r="2.3" /><path d="M5.5 4.5l1-2h3l1 2" /></>,
  film: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M5 2.5v11M11 2.5v11M2.5 6h2.5M2.5 10h2.5M11 6h2.5M11 10h2.5" /></>,
  light: <><circle cx="8" cy="7" r="3" /><path d="M6.5 11.5h3M7 13.5h2M8 1.5v1M2.5 7h1M12.5 7h1M4 3l.7.7M12 3l-.7.7" /></>,
  palette: <><path d="M8 2.5a5.5 5.5 0 100 11c1 0 1.2-.8.8-1.5-.5-.8 0-1.8 1-1.8h1.4a2.3 2.3 0 002.3-2.4A5.5 5.5 0 008 2.5z" /><circle cx="5.3" cy="7" r=".7" /><circle cx="7.5" cy="5" r=".7" /><circle cx="10.4" cy="5.7" r=".7" /></>,
  person: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" /></>,
  grid: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3 3" /></>,
  bolt: <><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" /></>,
  mirror: <><path d="M8 2v12" /><path d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5" /></>,
  orbit: <><ellipse cx="8" cy="8" rx="6" ry="3" /><circle cx="8" cy="8" r="1.5" /></>,
  stop: <><rect x="4" y="4" width="8" height="8" rx="1.5" /></>,
  nodes: <><rect x="1.5" y="3" width="4.5" height="4" rx="1" /><rect x="10" y="9" width="4.5" height="4" rx="1" /><path d="M6 5h4.75a1.5 1.5 0 011.5 1.5V9" /></>,
  cutout: <><circle cx="4.5" cy="11.5" r="2" /><circle cx="11.5" cy="11.5" r="2" /><path d="M5.9 10L11 2.5M10.1 10L5 2.5" /></>,
  cube: <><path d="M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z" /><path d="M2.5 4.9L8 8l5.5-3.1M8 8v6.2" /></>,
  cpu: <><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" /></>,
  play: <path d="M5.4 3.1l7.8 4.9-7.8 4.9z" fill="currentColor" stroke="none" />,
  pause: <><rect x="4.1" y="3.4" width="2.7" height="9.2" rx="1" fill="currentColor" stroke="none" /><rect x="9.2" y="3.4" width="2.7" height="9.2" rx="1" fill="currentColor" stroke="none" /></>,
  prev: <><path d="M12.4 3.9v8.2" /><path d="M11.4 4L4.6 8l6.8 4z" fill="currentColor" stroke="none" /></>,
  next: <><path d="M3.6 3.9v8.2" /><path d="M4.6 4l6.8 4-6.8 4z" fill="currentColor" stroke="none" /></>,
  shuffle: <><path d="M2 4.5h2.6c2.9 0 4 7 6.9 7H14.6" /><path d="M2 11.5h2.6c2.9 0 4-7 6.9-7H14.6" /><path d="M12.9 9.8l1.7 1.7-1.7 1.7" /><path d="M12.9 2.8L14.6 4.5l-1.7 1.7" /></>,
  repeat: <><path d="M3.2 8a4.8 4.8 0 018.2-3.3M12.8 8a4.8 4.8 0 01-8.2 3.3" /><path d="M11.9 2.4v2.7h-2.7M4.1 13.6v-2.7h2.7" /></>,
  vol: <><path d="M2.5 6.2h2.3L8.5 3v10L4.8 9.8H2.5z" /><path d="M10.8 5.5a3.5 3.5 0 010 5M12.9 3.7a6.3 6.3 0 010 8.6" /></>,
  volx: <><path d="M2.5 6.2h2.3L8.5 3v10L4.8 9.8H2.5z" /><path d="M10.8 6.4l4.4 4.4M15.2 6.4l-4.4 4.4" /></>,
  copy: <><rect x="5.5" y="2.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5v-6a2 2 0 012-2" /></>,
  fork: <><circle cx="4" cy="4" r="1.4" /><circle cx="4" cy="12" r="1.4" /><circle cx="12" cy="6" r="1.4" /><path d="M4 5.5v5M4 8c4 0 8-1.5 8-3.5" /></>,
  layers: <><path d="M8 2l6 3.4L8 8.8 2 5.4z" /><path d="M2.6 8.4L8 11.3l5.4-2.9M2.6 11L8 13.9l5.4-2.9" /></>,
  check: <path d="M3 8.5l3.2 3.2L13 5" />,
};

export function Icon({ name, size = 16, className }: { name: keyof typeof P | string; size?: number; className?: string }) {
  const icon = P[name] ? name : 'sparkle';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden data-icon={icon} className={className}>
      {P[icon]}
    </svg>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  return <img className="brand-mark" src="/logo/muilogo.png" alt="Morpheus" width={size} height={size} />;
}

// ---------- media that lights the room ----------
/** Blurred, saturated copy of a piece of media, placed behind a panel so the work tints the chrome around it. */
export function Spill({ src, video }: { src: string; video?: boolean }) {
  return (
    <div className="spill" aria-hidden>
      {video ? <video src={src} muted loop autoPlay playsInline preload="metadata" /> : <img src={src} alt="" />}
    </div>
  );
}

/** A motion preset's rendered clip (public/presets/<id>.mp4). */
export const presetClip = (id: string) => `/presets/${id}.mp4`;

export function Clip({ src, className = 'art' }: { src: string; className?: string }) {
  return <video className={className} src={src} muted loop autoPlay playsInline preload="metadata" />;
}

// ---------- popover menus ----------
export function useClickAway(ref: React.RefObject<HTMLElement | null>, onAway: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onAway(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onAway(); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [ref, onAway, active]);
}

export interface Opt<T extends string | number> { value: T; label: string; note?: string; disabled?: boolean }

/** Icon + value chip that opens a menu of options. */
export function ChipMenu<T extends string | number>(props: {
  icon?: string; label?: string; value: T; options: Opt<T>[]; onChange: (v: T) => void; dir?: 'up' | 'down'; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);
  const cur = props.options.find((o) => o.value === props.value);
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="chip" onClick={() => setOpen(!open)} title={props.title}>
        {props.icon && <Icon name={props.icon} size={14} />}
        {props.label && <span className="dim">{props.label}</span>}
        <span>{cur?.label ?? String(props.value)}</span>
      </button>
      {open && (
        <div className={`popover ${props.dir ?? 'up'}`} style={props.dir === 'down' ? undefined : { left: 0 }}>
          {props.title && <div className="pop-title label">{props.title}</div>}
          {props.options.map((o) => (
            <button key={String(o.value)} type="button" disabled={o.disabled}
              className={`pop-item ${o.value === props.value ? 'on' : ''}`}
              onClick={() => { props.onChange(o.value); setOpen(false); }}>
              <span>{o.label}</span>{o.note && <small>{o.note}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Stepper({ value, min, max, onChange, fmt }: { value: number; min: number; max: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="fewer"><Icon name="minus" size={13} /></button>
      <span>{fmt ? fmt(value) : value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label="more"><Icon name="plus" size={13} /></button>
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Toast() {
  const t = useStore((s) => s.toast);
  if (!t) return null;
  return <div className={`toast ${t.err ? 'err' : ''}`}>{t.text}</div>;
}

// ---------- render size ----------
/** The machine-wide render size (Setup, or the GPU chip). 720p until the server answers. */
export function useRenderTier(): RenderTier {
  return useStore((s) => s.status?.renderTier?.tier) ?? '720p';
}

/**
 * A page's size chip: it follows the machine-wide render size until a size is
 * picked on the page, and stays at or under the app's largest safe size.
 */
export function useTierChoice(app: TierApp): [RenderTier, (t: RenderTier) => void] {
  const global = useRenderTier();
  const [own, setOwn] = useState<RenderTier | null>(null);
  return [appTier(app, own ?? global), setOwn];
}

/** The size chip itself. Apps that stop below 1080p say so, and point at Upscale. */
export function TierChip({ app, value, onChange }: { app: TierApp; value: RenderTier; onChange: (t: RenderTier) => void }) {
  // The judge preview stops every app at 720p.
  const judge = useStore((s) => !!s.status?.judge);
  const max = judge && APP_MAX_TIER[app] === '1080p' ? '720p' : APP_MAX_TIER[app];
  return (
    <ChipMenu icon="res" value={value} onChange={onChange}
      title={tierCapNote(app) ?? 'Render size'}
      options={tiersUpTo(max).map((t) => ({ value: t.id, label: t.id, note: t.short }))} />
  );
}

/** The machine-wide render size, as Setup and the GPU chip show it. Shared by every browser and the MCP server. */
export function RenderTierPicker({ compact }: { compact?: boolean }) {
  const st = useStore((s) => s.status?.renderTier);
  const judge = useStore((s) => !!s.status?.judge);
  const [busy, setBusy] = useState(false);
  async function pick(t: RenderTier | null) {
    setBusy(true);
    try {
      await api.setRenderTier(t);
      await refreshStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the render size', true);
    } finally {
      setBusy(false);
    }
  }
  // No fallback when the server is silent: a fake "720p" highlight here read
  // like a saved setting when it was only the code's default (2026-11-07).
  const cur = st?.tier;
  const why = !st ? '' : st.source === 'env' ? 'Set by OPENFIELD_RENDER_TIER.' : st.source === 'gpu' ? 'Picked for this card.' : `Your pick. This card's default is ${st.auto}.`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div className="seg">
        {RENDER_TIERS.map((t) => (
          <button key={t.id} type="button" className={cur === t.id ? 'on' : ''} disabled={busy || judge || !st} title={t.note} onClick={() => void pick(t.id)}>
            {compact ? t.id : t.label}
          </button>
        ))}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {judge ? 'Fixed in the judge preview.' : st ? <>{tierDef(st.tier).note} {why}</> : 'Unknown while the server is down.'}
        {!judge && st?.source === 'user' && <> <button type="button" className="linkish" disabled={busy} onClick={() => void pick(null)}>Use the default</button></>}
      </div>
    </div>
  );
}

/** The machine-wide video decode, as Setup shows it: whole clip or in chunks. */
export function VideoDecodePicker() {
  const st = useStore((s) => s.status?.videoDecode);
  const judge = useStore((s) => !!s.status?.judge);
  const [busy, setBusy] = useState(false);
  async function pick(m: VideoDecode | null) {
    setBusy(true);
    try {
      await api.setVideoDecode(m);
      await refreshStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the video decode', true);
    } finally {
      setBusy(false);
    }
  }
  const cur = st?.mode;
  const def = VIDEO_DECODES.find((d) => d.id === cur) ?? VIDEO_DECODES[0];
  const autoLabel = VIDEO_DECODES.find((d) => d.id === st?.auto)?.label.toLowerCase() ?? '';
  const why = !st ? '' : st.source === 'env' ? 'Set by OPENFIELD_VIDEO_DECODE.' : st.source === 'gpu' ? 'Picked for this GPU.' : `Your pick. This GPU's default is ${autoLabel}.`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div className="seg">
        {VIDEO_DECODES.map((d) => (
          <button key={d.id} type="button" className={cur === d.id ? 'on' : ''} disabled={busy || judge || !st} title={d.note} onClick={() => void pick(d.id)}>
            {d.label}
          </button>
        ))}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {judge ? 'Fixed in the judge preview.' : st ? <>{def.note} {why}</> : 'Unknown while the server is down.'}
        {!judge && st?.source === 'user' && <> <button type="button" className="linkish" disabled={busy} onClick={() => void pick(null)}>Use the default</button></>}
      </div>
    </div>
  );
}

// ---------- engine control ----------
const ENGINE_GPUS: { id: EngineGpu; label: string; compact: string; note: string }[] = [
  { id: '4090', label: '4090', compact: '4090', note: 'RTX 4090 only (CUDA 0)' },
  { id: '5090', label: '5090', compact: '5090', note: 'RTX 5090 only (CUDA 1)' },
  { id: 'both', label: '4090+5090', compact: 'both', note: 'Both cards, 5090 primary' },
];

/**
 * Setup > Engine: LAN or WAN, which card in LAN mode, and the on/off switch.
 * The choice saves immediately and applies at the next start (stop, then start,
 * to switch cards while the engine is running).
 */
export function EngineControl({ compact }: { compact?: boolean }) {
  const st = useStore((s) => s.status);
  const eng = st?.engine;
  const judge = useStore((s) => !!st?.judge);
  const [busy, setBusy] = useState(false);
  const up = !!st?.up;
  const active = st?.active?.length ?? 0;
  const mode = eng?.mode ?? 'lan';
  const gpu = eng?.gpu ?? 'both';
  const wan = mode === 'wan';
  const wanOk = eng?.wanConfigured ?? false;

  async function pick(patch: { mode?: EngineMode; gpu?: EngineGpu }) {
    setBusy(true);
    try {
      await api.setEngineConfig(patch);
      await refreshStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the engine choice', true);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    try {
      const r = await api.startEngine();
      await refreshStatus();
      if (!r.ok) toast('The engine did not come up — check the console.', true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not start the engine', true);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (active > 0 && !window.confirm(`Stop the engine? ${active} take${active > 1 ? 's are' : ' is'} still queued/rendering and will be lost.`)) return;
    setBusy(true);
    try {
      await api.stopEngine();
      await refreshStatus();
      toast('Engine stopped.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not stop the engine', true);
    } finally {
      setBusy(false);
    }
  }

  const cuda = gpu === '4090' ? '0' : gpu === '5090' ? '1' : '1,0';
  const whatRuns = wan
    ? (wanOk ? 'WAN · the listen bat (--listen)' : 'WAN · falls back to COMFY_LAUNCH (no --listen yet — set COMFY_LAUNCH_WAN)')
    : `LAN · COMFY_LAUNCH · CUDA_VISIBLE_DEVICES=${cuda}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <div className="seg">
        <button type="button" className={mode === 'lan' ? 'on' : ''} disabled={busy || judge} onClick={() => void pick({ mode: 'lan' })}>LAN</button>
        <button type="button" className={mode === 'wan' ? 'on' : ''} disabled={busy || judge} title={wanOk ? 'The listen bat (--listen)' : 'Needs COMFY_LAUNCH_WAN in .env'} onClick={() => void pick({ mode: 'wan' })}>WAN</button>
      </div>
      <div className="seg">
        {ENGINE_GPUS.map((g) => (
          <button key={g.id} type="button" className={gpu === g.id ? 'on' : ''} disabled={busy || judge || wan} title={wan ? "WAN uses the listen bat's own cards" : g.note} onClick={() => void pick({ gpu: g.id })}>
            {compact ? g.compact : g.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {up
          ? <button type="button" className="btn sm danger" disabled={busy} onClick={() => void stop()}>Stop engine</button>
          : <button type="button" className="btn sm accent" disabled={busy || judge || !st?.canLaunch} onClick={() => void start()}>Start engine</button>}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {judge ? 'Fixed in the judge preview.' : <>{whatRuns}. {up ? 'Running — stop, then start, to apply a change.' : 'Applies on next start.'}</>}
      </div>
    </div>
  );
}

// ---------- agent model ----------
/** A model's stats line, e.g. "18.2 GB · 32k ctx · Q8_0" (only what the server reports). */
function modelStats(m: LlmModel): string {
  const bits: string[] = [];
  if (m.size) bits.push(m.size);
  if (m.contextLength) bits.push(`${Math.round(m.contextLength / 1000)}k ctx`);
  if (m.quantization) bits.push(m.quantization);
  return bits.join(' · ');
}

/**
 * First-time setup for the agent's LLM: the server URL, an optional key, and a
 * model picker whose options carry each model's size / context / quantization.
 * Saved to the server (overrides .env per field, applies immediately).
 */
export function AgentModelSetup({ onSaved }: { onSaved?: () => void }) {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [keyClear, setKeyClear] = useState(false); // user pressed "Clear the saved key"
  const [model, setModel] = useState('');
  const [models, setModels] = useState<LlmModel[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [cfgNote, setCfgNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [src, setSrc] = useState<AgentConfig['sources'] | null>(null);

  const loadModels = async (u = url) => {
    setLoading(true);
    setNote(null);
    try {
      const r = await api.agentModels(u.trim() || undefined, key.trim() || undefined);
      setModels(r.models);
      setNote(r.error ?? (r.models.length ? null : 'The server answered but listed no models.'));
    } catch (e) {
      setModels([]);
      setNote(e instanceof Error ? e.message : 'could not load the model list');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.agentConfig().then((c) => {
      setUrl(c.url ?? '');
      setModel(c.model ?? '');
      setSrc(c.sources);
      setCfgNote(c.note);
      if (c.url) void loadModels(c.url);
    }).catch(() => { /* offline: the form still works */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setSaving(true);
    try {
      // Blank key = keep whatever is set: the server treats an omitted field as
      // unchanged, but a null key DELETES the saved one — and this field never
      // pre-fills, so "save with the key box empty" used to wipe it silently.
      const patch: Partial<Record<'url' | 'model' | 'key', string | null>> = {
        url: url.trim() || null,
        model: model || null,
      };
      if (keyClear) patch.key = null;
      else if (key.trim()) patch.key = key.trim();
      const c = await api.setAgentConfig(patch);
      setSrc(c.sources);
      setCfgNote(c.note);
      setKey('');
      setKeyClear(false);
      toast('Agent model saved');
      onSaved?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the agent model', true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="agent-setup-card">
      {cfgNote && <div className="dim" style={{ fontSize: 12.5, marginBottom: 2 }}>{cfgNote}</div>}
      <div className="agent-setup-row">
        <label className="label" htmlFor="agent-url">Server URL{src?.url === 'env' && <span className="dim"> · from .env</span>}</label>
        <input id="agent-url" className="field" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:1234/v1" spellCheck={false} autoComplete="off" />
      </div>
      <div className="agent-setup-row">
        <label className="label" htmlFor="agent-key">API key <span className="dim">· optional, LM Studio needs none</span></label>
        <input id="agent-key" className="field" type="password" value={key}
          onChange={(e) => { setKey(e.target.value); setKeyClear(false); }}
          placeholder={src?.key === 'unset' ? 'none' : 'leave blank to keep the current one'}
          spellCheck={false} autoComplete="off" />
        {src && src.key !== 'unset' && (
          <div className="dim" style={{ fontSize: 12 }}>
            {src.key === 'user' ? 'Key set in the app.' : 'Key from .env.'}
            {src.key === 'user' && <>
              {' '}<button type="button" className="linkish" disabled={saving}
                onClick={() => { setKey(''); setKeyClear(true); }}>Clear the saved key</button>
            </>}
          </div>
        )}
      </div>
      <div className="agent-setup-row">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <label className="label" htmlFor="agent-model">Model{src?.model === 'env' && <span className="dim"> · from .env</span>}</label>
          <button type="button" className="linkish" disabled={loading || !url.trim()} onClick={() => void loadModels()}>
            {loading ? 'Loading…' : models.length ? 'Reload models' : 'Load models'}
          </button>
        </div>
        <select id="agent-model" className="field" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">— pick a model —</option>
          {model && !models.some((m) => m.id === model) && (
            <option value={model}>{model}  ·  saved, not in the current list</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name || m.id}{modelStats(m) ? `  ·  ${modelStats(m)}` : ''}</option>
          ))}
        </select>
        {note && <div className="dim" style={{ fontSize: 12 }}>{note}</div>}
      </div>
      <div className="agent-setup-actions">
        <button type="button" className="btn accent" disabled={saving || !url.trim()} onClick={() => void save()}>
          <Icon name="bolt" size={13} />{saving ? 'Saving…' : 'Save'}
        </button>
        <span className="dim" style={{ fontSize: 12 }}>Saved here it overrides .env and applies immediately — no restart.</span>
      </div>
    </div>
  );
}

/**
 * The active agent model as a chip in the header. Opens the server's model list
 * (each with its stats); picking one saves it and switches the agent over.
 */
export function AgentModelSwitcher() {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);

  const refresh = useCallback(async () => {
    const c = await api.agentConfig().catch(() => null);
    setCfg(c);
    if (c?.url) {
      const r = await api.agentModels().catch(() => null);
      if (r) setModels(r.models);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function pick(id: string) {
    setOpen(false);
    setBusy(true);
    try {
      await api.setAgentConfig({ model: id || null });
      toast(id ? `Model: ${id}` : 'Model cleared');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not switch the model', true);
    } finally {
      setBusy(false);
    }
  }

  if (!cfg?.ready) return null;
  const cur = models.find((m) => m.id === cfg.model);
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="chip" disabled={busy} onClick={() => setOpen((o) => !o)} title="Switch the agent's model">
        <Icon name="cpu" size={13} /><span>{cur?.name || cfg.model || 'auto'}</span><Icon name={open ? 'up' : 'down'} size={12} />
      </button>
      {open && (
        <div className="popover up" style={{ left: 0, minWidth: 280 }}>
          <div className="pop-title label">Agent model</div>
          {models.length === 0 && <div className="dim" style={{ fontSize: 12, padding: '4px 2px' }}>No models listed — set it in the Agent page or Setup.</div>}
          {models.map((m) => (
            <button key={m.id} type="button" className={`pop-item ${m.id === cfg.model ? 'on' : ''}`} onClick={() => void pick(m.id)}>
              <span>{m.name || m.id}</span>
              {modelStats(m) && <small>{modelStats(m)}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- GPU chip (replaces a credits counter) ----------
export function GpuChip() {
  const st = useStore((s) => s.status);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);
  // The badge is this app's takes; the engine's own queue can include other clients' jobs.
  const active = st?.active?.length ?? 0;
  const onEngine = st?.queueRemaining ?? 0;
  const used = st?.vramTotalGb && st.vramFreeGb !== undefined ? st.vramTotalGb - st.vramFreeGb : undefined;
  const pct = used !== undefined && st?.vramTotalGb ? Math.min(100, (used / st.vramTotalGb) * 100) : 0;
  const state = !st ? '' : !st.up ? 'down' : active ? 'busy' : 'up';
  const gpu = st?.target === 'cloud' ? 'Comfy Cloud' : st?.gpu?.replace(/^NVIDIA\s+(GeForce\s+)?/, '') ?? 'GPU';
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="gpu-chip" onClick={() => setOpen(!open)}>
        <span className={`dot ${state}`} />
        <span className="mono">{st?.up ? gpu : 'Engine off'}</span>
        {st?.up && st.target !== 'cloud' && <span className="vram" title="VRAM in use"><i style={{ width: `${pct}%` }} /></span>}
        {active > 0 && <span className="badge">{active} in queue</span>}
      </button>
      {open && (
        <div className="popover down" style={{ width: 300, padding: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>Engine</div>
          <dl className="kv">
            <dt>Target</dt><dd>{st?.target === 'cloud' ? 'Comfy Cloud' : 'Local ComfyUI'}</dd>
            <dt>ComfyUI</dt><dd>{st?.up ? `v${st.version ?? '?'}` : 'not answering'}</dd>
            <dt>Comfy API v2</dt><dd>{st?.api ? 'up' : 'down'}</dd>
            {used !== undefined && <><dt>VRAM</dt><dd>{used.toFixed(1)} / {st!.vramTotalGb!.toFixed(1)} GB</dd></>}
            <dt>Jobs</dt><dd>{active ? `${active} active` : 'idle'}</dd>
            {onEngine > active && <><dt className="dim">Engine queue</dt><dd className="dim">{onEngine} on the engine</dd></>}
          </dl>
          <div style={{ marginTop: 12 }}>
            <EngineControl compact />
          </div>
          <div className="label" style={{ margin: '12px 0 6px' }}>Render size</div>
          <RenderTierPicker compact />
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            {st?.up && <button type="button" className="btn sm" onClick={() => void api.free().then(() => toast('VRAM freed'))}>Free VRAM</button>}
            {active > 0 && <button type="button" className="btn sm danger" onClick={() => void api.clearQueue()}>Stop all</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- media card ----------
export function aspectOf(t: Take): string {
  const s = settingsOf(t);
  return s.width && s.height ? `${s.width} / ${s.height}` : '16 / 9';
}

export function MediaCard({ take, onOpen, actions, pendingLabel, tag }: { take: Take; onOpen?: () => void; actions?: ReactNode; pendingLabel?: string; tag?: string }) {
  const playingThis = usePlayer((p) => p.current === take.id && p.playing);
  const progress = useStore((s) => (take.prompt_id ? s.progress[take.prompt_id] : undefined));
  const started = useStore((st) => !!take.prompt_id && !!st.started[take.prompt_id]);
  const preview = useStore((s) => s.preview);
  const status = useStore((s) => s.status);
  const vref = useRef<HTMLVideoElement>(null);
  const s = settingsOf(take);
  const style = { ['--ar' as any]: aspectOf(take) };

  if (isActive(take)) {
    // running once the engine says so (or its steps arrive); a first-in-line take only counts as
    // running when nothing else is ahead of it in the engine's queue (another app may be using it)
    const first = status?.active?.[0]?.id === take.id;
    const foreign = (status?.queueRemaining ?? 0) > (status?.active?.length ?? 0);
    const running = started || !!progress || (first && !foreign);
    const pct = progress ? Math.round((progress.value / Math.max(1, progress.max)) * 100) : 0;
    return (
      <div className="card pending" style={style}>
        {running && preview && preview.promptId === take.prompt_id && <img src={preview.url} alt="" style={{ opacity: 0.85, filter: 'saturate(.9)' }} />}
        <div className="status">
          <div>
            <div className="label" style={{ color: 'var(--accent)' }}>{running ? (progress?.max && progress.max !== 100 ? `Step ${progress.value}/${progress.max}` : 'Rendering') : first ? 'Waiting for the engine' : pendingLabel ?? 'Queued'}</div>
          </div>
        </div>
        <div className="progress"><i style={{ width: `${running ? pct : 0}%` }} /></div>
      </div>
    );
  }
  if (take.status !== 'done' || !take.output_path) {
    return (
      <div className="card failed" style={style} title={take.error ?? ''}>
        <div className="status"><div><div className="label">{take.status}</div><div style={{ marginTop: 6, fontSize: 12 }}>{(take.error ?? '').slice(0, 110)}</div></div></div>
        <div className="quick" style={{ opacity: 1 }}>{actions}</div>
      </div>
    );
  }
  const image = isImage(take);
  const model = isModel(take);
  if (isAudio(take)) {
    // No frames at all: a note, the player button, and the length.
    return (
      <div className="card audio" style={style} onClick={onOpen}
        {...takeDragProps(take.id, (take.output_path ?? `take_${take.id}`).split(/[\\/]/).pop()!, 'audio/mpeg')}>
        <div className="audio-art"><Icon name="audio" size={44} /></div>
        <button type="button" className={`card-play ${playingThis ? 'on' : ''}`}
          onClick={(e) => { e.stopPropagation(); playingThis ? pause() : playTake(take.id); }}
          aria-label={playingThis ? 'Pause' : 'Play in the player'}>
          <Icon name={playingThis ? 'pause' : 'play'} size={24} />
        </button>
        <div className="kind">
          {tag && <span className="badge" style={{ marginRight: 4 }}>{tag}</span>}
          <span className="badge cool">{s.outSeconds ?? s.seconds ? `${s.outSeconds ?? s.seconds}s` : 'audio'}</span>
        </div>
        <div className="quick" onClick={(e) => e.stopPropagation()}>{actions}</div>
        <div className="scrim" />
        <div className="meta"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.userPrompt || s.prompt || s.tags || s.lyrics || s.text || s.instruct}</span></div>
      </div>
    );
  }
  return (
    <div className={`card ${image && s.app === 'cutout' && s.background === 'transparent' ? 'checker' : ''}`} style={style} onClick={onOpen}
      {...takeDragProps(take.id, (take.output_path ?? `take_${take.id}`).split(/[\\/]/).pop()!, image ? 'image/png' : model ? 'model/gltf-binary' : 'video/mp4')}
      onMouseEnter={() => { const v = vref.current; if (v) { v.muted = true; void v.play().catch(() => {}); } }}
      onMouseLeave={() => { const v = vref.current; if (v) { v.pause(); v.currentTime = 0; } }}>
      <img src={posterUrl(take.id)} alt="" loading="lazy" />
      {!image && <video ref={vref} src={model ? turntableUrl(take.id) : mediaUrl(take.id)} muted loop playsInline preload="none" />}
      <div className="kind">
        {tag && <span className="badge" style={{ marginRight: 4 }}>{tag}</span>}
        {model && <span className="badge cool">3D</span>}
        {!image && !model && <span className="badge cool">{s.outSeconds ?? s.seconds ? `${s.outSeconds ?? s.seconds}s` : 'video'}</span>}
        {s.cut && <span className="badge cool" style={{ marginLeft: 4 }}>{(s.shots ?? []).length} shots</span>}
        {!image && s.seam && <span className={`badge seam ${s.seam.verdict === 'seamless' ? 'ok' : 'bad'}`} title={`Loop point: ${s.seam.ratio}x a frame step`}>{s.seam.verdict === 'seamless' ? 'Seamless' : 'Visible seam'}</span>}
        {!image && s.app === 'hdr' && <span className="badge">HDR</span>}
      </div>
      <div className="quick" onClick={(e) => e.stopPropagation()}>{actions}</div>
      <div className="scrim" />
      <div className="meta"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.userPrompt || s.prompt}</span></div>
    </div>
  );
}

export function fmtSeconds(sec: number | null | undefined): string {
  if (!sec) return '';
  if (sec < 90) return `~${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)} min`;
}

/** Live render-time estimate for the current settings. */
export function useEstimate(q: Record<string, string | number> | null): number | null {
  const [sec, setSec] = useState<number | null>(null);
  const key = q ? JSON.stringify(q) : '';
  useEffect(() => {
    if (!q) return;
    let dead = false;
    const t = setTimeout(() => api.estimate(q).then((r) => !dead && setSec(r.seconds)).catch(() => {}), 250);
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return sec;
}

// ---------- phone ----------
/** QR as SVG, encoded here: the link carries a secret, so it never goes to a QR web service. */
export function Qr({ text, label }: { text: string; label: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return { n, d };
  }, [text]);
  const q = 4; // quiet zone, in modules
  return (
    <svg viewBox={`${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect x={-q} y={-q} width={n + 2 * q} height={n + 2 * q} fill="#e8ebef" />
      <path d={d} fill="#08090b" />
    </svg>
  );
}

/** Copyable one-line commands (elevated PowerShell), used by the phone panels. */
export function Commands({ lines }: { lines: string[] }) {
  return (
    <div className="phone-cmds">
      {lines.map((l) => (
        <button key={l} type="button" title="Copy" onClick={() => void navigator.clipboard?.writeText(l).then(() => toast('Copied'))}>
          <code>{l}</code>
        </button>
      ))}
    </div>
  );
}

// ---------- judge preview ----------
/** A slim strip under the top bar when the server runs as the judge preview. */
export function JudgeBanner() {
  const j = useStore((s) => s.status?.judge);
  if (!j) return null;
  return (
    <div className="judge-banner" role="note">
      <b>Judge preview.</b> This runs on a rented GPU with draft limits: up to {j.maxSeconds} seconds, 720p and one take per render.
      {' '}Setup is read-only, and phone capture, project folders and deleting are off.
      {' '}<span className="mono">{j.left} of {j.cap}</span> renders left today.
    </div>
  );
}
