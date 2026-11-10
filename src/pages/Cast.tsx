/**
 * Cast: characters, props and places saved once, then @mentioned in any prompt.
 * A member is a name, a kind, 1 to 6 pictures and the words that describe it.
 * Pictures come from uploads, drops (files or takes) or "Save to cast" on any
 * still in the Viewer.
 */
import { useEffect, useRef, useState } from 'react';
import { api, uploadFile, type CastKind, type CastMember, type CastSource } from '../api';
import { refreshCast, useCast } from '../castStore';
import { useDropZone, usePageDrop } from '../drop';
import { KIND_LABEL } from '../Mention';
import { navigate, setParams, useRoute } from '../router';
import { setCastTabInPickers, toast, useStore } from '../store';
import { Icon } from '../ui';

const KINDS: { id: CastKind; label: string; hint: string }[] = [
  { id: 'character', label: 'Character', hint: 'A person or creature. Best with a face close-up, a three-quarter view and a full-body shot.' },
  { id: 'prop', label: 'Prop', hint: 'An object they hold or use. One or two clean views.' },
  { id: 'place', label: 'Place', hint: 'A location. One wide, clean shot of it.' },
];
const MAX = 6;

/** A picture in the form: already saved (index into refs) or newly added (upload token). */
type Pic = { saved: number; url: string } | { token: string; url: string };

export default function CastPage() {
  const { params } = useRoute();
  const cast = useCast();
  const editId = Number(params.get('edit')) || null;
  const creating = params.get('new') === '1';
  const editing = editId ? cast.find((m) => m.id === editId) ?? null : null;
  const open = creating || !!editing;
  const castTab = useStore((s) => s.castTab);

  return (
    <div className="page-scroll">
      <div className="page-pad" style={{ maxWidth: 1500 }}>
        <div className="cast-head">
          <div>
            <h1 className="display" style={{ fontSize: 'clamp(44px,5.4vw,80px)', margin: '8px 0 0' }}>Your <span className="hl">cast</span></h1>
            <p className="dim" style={{ marginTop: 10, maxWidth: 640 }}>
              Save a character, prop or place once. Type <b className="mono" style={{ color: 'var(--accent-hi)' }}>@</b> in any prompt to bring it in:
              stills compose it from its pictures, videos hold it on a reference sheet, so the same face and the same coat show up in every shot.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-end' }}>
            {!open && <button type="button" className="btn accent" onClick={() => setParams({ new: '1', edit: null })}><Icon name="plus" size={14} />New cast member</button>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12.5, color: 'var(--dim)', fontWeight: 600 }}>
              <input type="checkbox" checked={castTab} onChange={(e) => setCastTabInPickers(e.target.checked)} style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--accent)' }} />
              Show cast in media pickers
            </label>
          </div>
        </div>

        {open && <CastForm key={editing?.id ?? 'new'} member={editing} onDone={() => setParams({ new: null, edit: null })} />}

        {cast.length === 0 && !open ? (
          <div className="hero-empty" style={{ paddingTop: 40 }}>
            <div className="fan">{[0, 1, 2, 3].map((i) => <div key={i} className="cast-ghost"><Icon name={['person', 'person', 'grid', 'image'][i]} size={34} /></div>)}</div>
            <div className="display" style={{ fontSize: 'clamp(30px,4vw,52px)' }}>Nobody cast yet</div>
            <p className="dim" style={{ marginTop: 12 }}>Drop a few pictures of the same person here, or open any still and pick Save to cast.</p>
          </div>
        ) : (
          <div className="cast-grid">
            {cast.map((m) => <CastCard key={m.id} m={m} on={m.id === editId} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function CastCard({ m, on }: { m: CastMember; on: boolean }) {
  const fan = m.refs.slice(0, 3);
  const prompt = (p: string) => encodeURIComponent(`@${m.name} ${p}`);
  return (
    <div className={`cast-card ${on ? 'on' : ''}`}>
      <button type="button" className="cast-fan" onClick={() => setParams({ edit: String(m.id), new: null })} title="Edit">
        {fan.map((r, i) => <div key={r.token} className={`f${fan.length}-${i}`}><img src={r.url} alt="" /></div>)}
      </button>
      <div className="cast-body">
        <div className="cast-title">
          <span className="display">{m.name}</span>
          <span className="badge">{KIND_LABEL[m.kind]}</span>
        </div>
        <div className="mono cast-handle">@{m.name}</div>
        <p className="cast-notes">{m.notes || <span className="dim">No description yet. Words help: what they look like, what they wear.</span>}</p>
        <div className="cast-actions">
          <button type="button" className="btn sm" onClick={() => navigate(`/image?prompt=${prompt(m.kind === 'place' ? '' : 'in ')}`)}><Icon name="image" size={14} />Still</button>
          <button type="button" className="btn sm" onClick={() => navigate(`/video?prompt=${prompt('')}`)}><Icon name="video" size={14} />Video</button>
          <button type="button" className="btn sm ghost" onClick={() => setParams({ edit: String(m.id), new: null })}>Edit</button>
        </div>
      </div>
    </div>
  );
}

function CastForm({ member, onDone }: { member: CastMember | null; onDone: () => void }) {
  const [name, setName] = useState(member?.name ?? '');
  const [kind, setKind] = useState<CastKind>(member?.kind ?? 'character');
  const [notes, setNotes] = useState(member?.notes ?? '');
  const [pics, setPics] = useState<Pic[]>(() => member?.refs.map((r, i) => ({ saved: i, url: r.url })) ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!member) nameRef.current?.focus(); }, [member]);

  async function add(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, MAX - pics.length);
    if (!imgs.length) { toast(pics.length >= MAX ? 'Six pictures is the most a cast member keeps' : 'Cast pictures are stills: PNG, JPEG or WebP', true); return; }
    setBusy('Uploading...');
    try {
      for (const f of imgs) {
        const token = await uploadFile(f);
        setPics((p) => [...p, { token, url: URL.createObjectURL(f) }].slice(0, MAX));
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    } finally {
      setBusy(null);
    }
  }
  const zone = useDropZone((f) => void add(f));
  usePageDrop(member ? `Drop pictures of ${member.name}` : 'Drop pictures for the new cast member', (f) => void add(f));

  async function save() {
    setBusy('Saving...');
    try {
      const fresh: CastSource[] = pics.filter((p): p is { token: string; url: string } => 'token' in p).map((p) => ({ token: p.token }));
      if (member) {
        const keep = new Set(pics.filter((p): p is { saved: number; url: string } => 'saved' in p).map((p) => p.saved));
        await api.updateCast(member.id, {
          name, kind, notes, addRefs: fresh,
          removeRefs: member.refs.map((_, i) => i).filter((i) => !keep.has(i)),
        });
        toast(`${name} saved`);
      } else {
        await api.createCast({ name, kind, notes, refs: fresh });
        toast(`${name} joined the cast. Type @${name} in any prompt.`);
      }
      await refreshCast();
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save', true);
    } finally {
      setBusy(null);
    }
  }

  async function del() {
    if (!member || !confirm(`Remove ${member.name} from the cast? Their pictures stay in your output folder.`)) return;
    await api.deleteCast(member.id).catch((e) => toast(String(e), true));
    await refreshCast();
    onDone();
  }

  const k = KINDS.find((x) => x.id === kind)!;
  return (
    <div className="cast-form">
      <div className="cast-form-pics">
        <div className="label">Pictures · {pics.length} of {MAX}</div>
        <div className="refs">
          {pics.map((p, i) => (
            <div className="ref" key={p.url}>
              <img src={p.url} alt="" />
              <span className="role">{i === 0 ? 'main' : `${i + 1}`}</span>
              <button type="button" className="x" onClick={() => setPics((c) => c.filter((_, j) => j !== i))} aria-label="remove"><Icon name="x" size={12} /></button>
            </div>
          ))}
          {pics.length < MAX && (
            <div className={`well cast-add ${zone.over ? 'drag' : ''}`} onClick={() => input.current?.click()} {...zone.props}>
              <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void add(e.target.files)} />
              <Icon name="plus" />
              <span>{pics.length ? 'Add' : 'Add pictures'}</span>
            </div>
          )}
        </div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{k.hint} The first picture is the main one.</div>
      </div>
      <div className="cast-form-fields">
        <div className="rail-section">
          <div className="label">Name</div>
          <input ref={nameRef} className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value.replace(/^@+/, ''))} placeholder="Mara" />
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>You will type it as <span className="mono" style={{ color: 'var(--accent-hi)' }}>@{name.trim() || 'Name'}</span>.</div>
        </div>
        <div className="seg">
          {KINDS.map((x) => <button key={x.id} type="button" className={kind === x.id ? 'on' : ''} onClick={() => setKind(x.id)}>{x.label}</button>)}
        </div>
        <div className="rail-section">
          <div className="label">In words</div>
          <textarea className="prompt" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={kind === 'character' ? 'A woman in her forties, black bob with a silver streak, round tortoiseshell glasses, rust corduroy jacket over a teal sweater.' : kind === 'prop' ? 'A dented brass lantern with a green glass chimney.' : 'A narrow night market under strings of bare bulbs, wet cobblestones.'} />
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>These words go into every prompt that mentions {name.trim() || 'them'}.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
          <button type="button" className="btn accent" disabled={!!busy || !name.trim() || !pics.length} onClick={() => void save()}>{busy ?? (member ? 'Save' : 'Add to cast')}</button>
          <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
          {member && <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} onClick={() => void del()}><Icon name="trash" size={14} />Remove</button>}
        </div>
      </div>
    </div>
  );
}

/**
 * "Save to cast" from the Viewer: start a new member from this still, or add
 * it to one that exists.
 */
export function SaveToCast({ takeId, onClose }: { takeId: number; onClose: () => void }) {
  const cast = useCast();
  const [target, setTarget] = useState<number | 'new'>('new');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CastKind>('character');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (target === 'new') {
        const m = await api.createCast({ name, kind, notes, refs: [{ takeId }] });
        toast(`${m.name} joined the cast. Type @${m.name} in any prompt.`);
      } else {
        const m = await api.updateCast(target, { addRefs: [{ takeId }] });
        toast(`Added to ${m.name}: ${m.refs.length} picture${m.refs.length > 1 ? 's' : ''}`);
      }
      await refreshCast();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save', true);
    } finally {
      setBusy(false);
    }
  }

  const full = typeof target === 'number' && (cast.find((m) => m.id === target)?.refs.length ?? 0) >= MAX;
  return (
    <div className="save-cast">
      <div className="label">Save to cast</div>
      <div className="chip-row">
        <button type="button" className={`chip ${target === 'new' ? 'on' : ''}`} onClick={() => setTarget('new')}><Icon name="plus" size={13} />New</button>
        {cast.map((m) => (
          <button key={m.id} type="button" className={`chip ${target === m.id ? 'on' : ''}`} onClick={() => setTarget(m.id)} title={`Add this picture to ${m.name}`}>
            {m.refs[0] && <img className="chip-face" src={m.refs[0].url} alt="" />}{m.name}
          </button>
        ))}
      </div>
      {target === 'new' && (
        <>
          <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value.replace(/^@+/, ''))} placeholder="Name, as you will type it after @" autoFocus />
          <div className="seg">{KINDS.map((x) => <button key={x.id} type="button" className={kind === x.id ? 'on' : ''} onClick={() => setKind(x.id)}>{x.label}</button>)}</div>
          <textarea className="prompt" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="In words: what they look like, what they wear." />
        </>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn sm accent" disabled={busy || full || (target === 'new' && !name.trim())} onClick={() => void save()}>
          {full ? 'Six pictures already' : target === 'new' ? 'Add to cast' : 'Add picture'}
        </button>
        <button type="button" className="btn sm ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
