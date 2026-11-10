/**
 * Source slot for the continue tools (Extend, Transition, Speak, Add sound):
 * pick one of your takes, or drop a file. Either way the media is uploaded as
 * an input and comes back as a token plus the facts the page sizes itself by.
 */
import { useEffect, useRef, useState } from 'react';
import { mediaUrl, posterUrl, takeAsInput, uploadFile, type CastMember, type CastRef, type Take } from './api';
import { useCast } from './castStore';
import { useDropZone } from './drop';
import { isAudio, isImage, isModel, settingsOf, toast, useStore } from './store';
import { Icon } from './ui';

/** The plain "browse your device" well — the Device tab of the media picker. */
function DeviceWell(p: { accept: string; onFile: (f: File) => void; icon: string; title: string; sub?: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const zone = useDropZone((files) => p.onFile(files[0]));
  return (
    <div className={`well ${zone.over ? 'drag' : ''}`} style={p.compact ? { padding: 10 } : undefined}
      onClick={() => input.current?.click()} {...zone.props}>
      <input ref={input} type="file" accept={p.accept} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onFile(f); }} />
      {!p.compact && <div className="well-icons"><span><Icon name={p.icon} /></span></div>}
      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{p.title}</div>
      {p.sub && <div style={{ fontSize: 12, marginTop: 2 }}>{p.sub}</div>}
    </div>
  );
}

export type SourceKind = 'video' | 'image' | 'audio';

export interface Source {
  token: string;
  kind: SourceKind;
  /** Preview URL: the take's media or a blob of the dropped file. */
  url: string;
  name: string;
  w: number;
  h: number;
  seconds: number;
  takeId?: number;
  /** The take's own prompt, used when the user leaves theirs empty. */
  prompt?: string;
}

/** Duration and frame size of a media URL, from the browser's own decoder. */
export function measure(url: string, kind: SourceKind): Promise<{ w: number; h: number; seconds: number }> {
  return new Promise((res) => {
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight, seconds: 0 });
      img.onerror = () => res({ w: 0, h: 0, seconds: 0 });
      img.src = url;
      return;
    }
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => res({ w: (el as HTMLVideoElement).videoWidth || 0, h: (el as HTMLVideoElement).videoHeight || 0, seconds: el.duration || 0 });
    el.onerror = () => res({ w: 0, h: 0, seconds: 0 });
    el.src = url;
  });
}

/** A finished take as a source. */
export async function sourceFromTake(t: Take): Promise<Source> {
  const kind: SourceKind = isImage(t) ? 'image' : isAudio(t) ? 'audio' : 'video';
  const url = mediaUrl(t.id);
  const [token, m] = await Promise.all([takeAsInput(t.id), measure(url, kind)]);
  const s = settingsOf(t);
  return { token, kind, url, name: `take ${t.id}`, ...m, takeId: t.id, prompt: s.userPrompt || s.prompt || s.text || s.tags };
}

export async function sourceFromFile(f: File, kind: SourceKind): Promise<Source> {
  const url = URL.createObjectURL(f);
  const [token, m] = await Promise.all([uploadFile(f), measure(url, kind)]);
  return { token, kind, url, name: f.name.replace(/\.[^.]+$/, ''), ...m };
}

/** A cast reference or take is already on the server; fetch it as a File for pages that re-upload. */
export async function sourceToFile(s: Source): Promise<File | null> {
  try {
    const blob = await (await fetch(s.url)).blob();
    const ext = s.kind === 'video' ? 'mp4' : s.kind === 'audio' ? 'mp3' : 'png';
    const mime = blob.type || (s.kind === 'video' ? 'video/mp4' : s.kind === 'audio' ? 'audio/mpeg' : 'image/png');
    return new File([blob], `${s.name || 'media'}.${ext}`, { type: mime });
  } catch {
    return null;
  }
}

const EXT_KIND: Record<string, SourceKind> = {
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', mkv: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image',
  wav: 'audio', mp3: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio', aac: 'audio',
};

/** What a file is, by its MIME type, or by its extension when the browser gives none. */
export function fileKind(f: File): SourceKind | null {
  const byType = (['video', 'image', 'audio'] as SourceKind[]).find((k) => f.type.startsWith(`${k}/`));
  return byType ?? EXT_KIND[f.name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/** Upload a dropped or picked file as a source, if it is one of `accept`. Toasts and returns null otherwise. */
export async function loadFile(f: File, accept: SourceKind[]): Promise<Source | null> {
  const kind = fileKind(f);
  if (!kind || !accept.includes(kind)) { toast(`Drop ${accept.join(' or ')}`, true); return null; }
  if (f.size > 45e6) { toast('That file is over 45 MB. Trim it first.', true); return null; }
  try { return await sourceFromFile(f, kind); } catch (e) { toast(e instanceof Error ? e.message : 'upload failed', true); return null; }
}

/** Load ?take=<id> once into a source, then drop the param. */
export function useTakeParam(id: string | null, onSource: (s: Source) => void) {
  const takes = useStore((s) => s.takes);
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!id) { if (loaded) setLoaded(null); return; }
    if (id === loaded) return;
    const t = takes.find((x) => x.id === Number(id));
    if (!t) return;
    setLoaded(id);
    void sourceFromTake(t).then(onSource).catch((e) => toast(e instanceof Error ? e.message : 'could not load the take', true));
  }, [id, takes, loaded]);
}

/**
 * One source slot. Empty: a drop well plus a strip of recent takes that fit.
 * Filled: the preview with a remove button.
 */
export function SourceSlot(p: {
  label: string;
  value: Source | null;
  onChange: (s: Source | null) => void;
  accept: SourceKind[];
  title: string;
  sub: string;
}) {
  const v = p.value;
  const file = async (f: File) => { const src = await loadFile(f, p.accept); if (src) p.onChange(src); };
  // A filled slot takes a drop too: it replaces what is there.
  const replace = useDropZone((files) => void file(files[0]));

  return (
    <div className="rail-section">
      <div className="label">{p.label}</div>
      {v ? (
        v.kind === 'audio' ? (
          <div className={`ref ${replace.over ? 'drag' : ''}`} {...replace.props} style={{ aspectRatio: 'auto', padding: '12px 12px 12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="audio" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
              <div className="dim mono" style={{ fontSize: 11.5 }}>{v.seconds.toFixed(1)}s</div>
            </div>
            <button type="button" className="x" style={{ position: 'static' }} onClick={() => p.onChange(null)} aria-label="remove"><Icon name="x" size={12} /></button>
          </div>
        ) : (
          <div className={`ref ${replace.over ? 'drag' : ''}`} {...replace.props} style={{ aspectRatio: `${v.w || 16} / ${v.h || 9}` }}>
            {v.kind === 'image' ? <img src={v.url} alt="" /> : <video src={v.url} muted loop autoPlay playsInline />}
            <span className="role">{v.kind === 'image' ? v.name : `${v.seconds.toFixed(1)}s · ${v.name}`}</span>
            <button type="button" className="x" onClick={() => p.onChange(null)} aria-label="remove"><Icon name="x" size={12} /></button>
          </div>
        )
      ) : (
        <MediaPicker accept={p.accept} title={p.title} sub={p.sub} icon={p.accept[0]} onPick={(s) => p.onChange(s)} />
      )}
    </div>
  );
}

/**
 * The media picker: Device (browse/drop a file), Cast (your saved pictures)
 * and Library (your takes). Only the tabs that have something to offer show,
 * and the bar itself hides when there is just one.
 */
export function MediaPicker(p: {
  accept: SourceKind[];
  title: string;
  sub?: string;
  icon: string;
  onPick: (s: Source) => void;
}) {
  const castTab = useStore((s) => s.castTab);
  const cast = useCast();
  const library = useStore((s) => s.takes
    .filter((t) => t.status === 'done' && t.output_path && !isModel(t) && p.accept.includes(isImage(t) ? 'image' : isAudio(t) ? 'audio' : 'video'))
    .slice(0, 48));
  const castMembers = cast.filter((m) => m.refs.length > 0);
  const showCast = p.accept.includes('image') && castTab && castMembers.length > 0;
  const showLibrary = library.length > 0;
  const tabs: { id: string; label: string }[] = [
    { id: 'device', label: 'Device' },
    ...(showCast ? [{ id: 'cast', label: `Cast · ${castMembers.length}` }] : []),
    ...(showLibrary ? [{ id: 'library', label: 'Library' }] : []),
  ];
  const [tab, setTab] = useState('device');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if ((tab === 'cast' && !showCast) || (tab === 'library' && !showLibrary)) setTab('device');
  }, [showCast, showLibrary]);

  const pickFile = async (f: File) => {
    setBusy(true);
    try { const src = await loadFile(f, p.accept); if (src) p.onPick(src); } finally { setBusy(false); }
  };
  const pickTake = async (t: Take) => {
    setBusy(true);
    try { p.onPick(await sourceFromTake(t)); } catch (e) { toast(e instanceof Error ? e.message : 'failed', true); } finally { setBusy(false); }
  };
  const pickRef = (m: CastMember, r: CastRef) => {
    p.onPick({ token: r.token, kind: 'image', url: r.url, name: m.name, w: r.w, h: r.h, seconds: 0 });
  };

  const device = <DeviceWell accept={p.accept.map((k) => `${k}/*`).join(',')} onFile={(f) => void pickFile(f)} icon={p.icon} title={busy ? 'Loading...' : p.title} sub={p.sub} />;

  // Just the device: keep the old single well, no tab bar.
  if (!showCast && !showLibrary) return device;

  return (
    <div>
      <div className="seg" style={{ marginBottom: 8 }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'device' && device}
      {tab === 'cast' && showCast && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 260, overflowY: 'auto' }}>
          {castMembers.map((m) => (
            <div key={m.id}>
              <div className="mono" style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 4 }}>@{m.name}</div>
              <div className="refs" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                {m.refs.map((r) => (
                  <button key={r.token} type="button" className="ref" style={{ padding: 0, border: 0, cursor: 'pointer' }} title={`Use ${m.name}'s picture`} onClick={() => pickRef(m, r)}>
                    <img src={r.url} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === 'library' && showLibrary && (
        <div className="src-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)', maxHeight: 260, overflowY: 'auto' }}>
          {library.map((t) => (
            <button key={t.id} type="button" title={`Use take ${t.id}`} disabled={busy} onClick={() => void pickTake(t)}>
              {isAudio(t) && <span style={{ position: 'static', display: 'grid', placeItems: 'center', width: '100%', height: '100%', background: 'transparent', color: 'var(--accent)' }}><Icon name="audio" size={18} /></span>}
              {!isAudio(t) && <img src={posterUrl(t.id)} alt="" loading="lazy" />}
              {!isAudio(t) && !isImage(t) && <span><Icon name="video" size={11} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

