/** Explore (home), Apps gallery, Library, and the "coming" placeholder. */
import { useEffect, useRef, useState } from 'react';
import { api, type Take } from '../api';
import { APPS, APP_CATS, RECIPES, presetById, recipeUrl, type AppDef } from '../catalog';
import { linkProps, setParams, useRoute } from '../router';
import { isAudio, isImage, isModel, useStore, inFeed, toggleFavorite, toast, refreshTakes, settingsOf } from '../store';
import { Clip, Icon, MediaCard, Spill, presetClip } from '../ui';
import Viewer, { animate, recreate, remove } from '../Viewer';

/** The app a take was made with, as a Library section heading. */
function groupOf(t: Take): string {
  const s = settingsOf(t);
  if (s.cut || s.app === 'director') return 'Director';
  switch (s.app) {
    case 'image': return 'Image';
    case 'edit': return 'Edit';
    case 'mirror':
    case 'restyle': return 'Mirror';
    case 'effects': return 'Effects';
    case 'cutout': return 'Cutout';
    case 'swap': return 'Object swap';
    case 'reshoot': return 'Reshoot';
    case 'extend': return 'Extend';
    case 'transition': return 'Transitions';
    case 'speak': return 'Speak';
    case 'sound': return 'Add sound';
    case 'audio': return 'Audio';
    case 'upscale': return 'Upscale';
    case 'object': return 'Model';
    case 'hdr': return 'Finish';
    case 'seam': return 'Seam';
    case 'stage': return 'Stage';
    case 'cast': return 'Cast';
    default: return t.kind === 'audio' ? 'Audio' : t.kind === 'object' ? 'Model' : t.kind === 'still' ? 'Image' : 'Video';
  }
}

/** Cover art for an app: a curated rendered clip, so a fresh install never shows an empty card. */
function AppArt({ app }: { app: AppDef }) {
  return <Clip src={app.clip ?? presetClip(app.cover)} />;
}

export function Explore() {
  const hero = ['stage', 'director', 'mirror', 'effects', 'video'].map((id) => APPS.find((a) => a.id === id)!);
  const recent = useStore((s) => s.takes.filter((t) => inFeed(t) && t.status === 'done'));
  const [viewing, setViewing] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLButtonElement>(null);
  const rightRef = useRef<HTMLButtonElement>(null);
  // The row's scroll position, kept across effect re-runs so a new take
  // landing in the list does not snap the strip back to the start.
  const posRef = useRef(0);
  // Endless carousel: a steady left drift (60px/s) wrapping at one copy of the
  // row. Driven by rAF because CSS animations are what get killed by
  // prefers-reduced-motion and browser flags — an inline transform never dies.
  // Hold the right arrow to fast-forward, the left to rewind; the row itself
  // drags with mouse or touch (a real drag swallows the click that would open
  // a card).
  useEffect(() => {
    const wrap = wrapRef.current;
    const track = trackRef.current;
    if (!wrap || !track) return;
    let raf = 0;
    let x = posRef.current;
    let last = performance.now();
    let rowHover = false;   // pointer over the strip: idle drift pauses
    let btnHover = false;   // pointer over an arrow: drift pauses so it can be held
    let boost = 0;          // -1 fast-forward (right held), +1 rewind (left held)
    let pDown = false;      // a pointer is down on the strip (not yet a drag)
    let dragging = false;   // the press has become a drag (past the 6px threshold)
    let startX = 0;
    let px = 0;
    let suppressClick = false;

    const half = () => track.scrollWidth / 2;
    const wrap_around = () => {
      const h = half();
      if (h > 0) { while (x > 0) x -= h; while (x <= -h) x += h; }
    };
    const apply = () => { posRef.current = x; track.style.transform = `translate3d(${x}px,0,0)`; };
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (!dragging) {
        const v = boost ? boost * 720 : rowHover || btnHover ? 0 : -60;
        if (v) { x += v * dt; wrap_around(); apply(); }
      }
      raf = requestAnimationFrame(step);
    };

    const rowEnter = () => { rowHover = true; };
    const rowLeave = () => { rowHover = false; };

    // press-and-hold speed control
    const wired: Array<[HTMLButtonElement, string, EventListener]> = [];
    const wireButton = (b: HTMLButtonElement | null, dir: number) => {
      if (!b) return;
      const on = (e: Event) => { e.preventDefault(); btnHover = true; };
      const off = () => { btnHover = false; boost = 0; };
      const down = (e: Event) => { e.preventDefault(); boost = dir; };
      const pairs: Array<[string, EventListener]> = [['pointerenter', on], ['pointerleave', off], ['pointerdown', down], ['pointerup', off], ['pointercancel', off]];
      for (const [ev, fn] of pairs) {
        b.addEventListener(ev, fn);
        wired.push([b, ev, fn]);
      }
    };

    // pointer drag (mouse + touch). Capture only kicks in once the move is past
    // the 6px threshold — capturing from the first pointerdown retargets the
    // click to the strip and the card's own onClick (open the preview) dies.
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pDown = true;
      dragging = false;
      startX = px = e.clientX;
    };
    const move = (e: PointerEvent) => {
      if (!pDown) return;
      if (!dragging) {
        if (Math.abs(e.clientX - startX) <= 6) return;
        dragging = true;
        try { wrap.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      }
      const dx = e.clientX - px;
      px = e.clientX;
      x += dx;
      wrap_around();
      apply();
    };
    const up = () => {
      if (!pDown) return;
      pDown = false;
      if (dragging) suppressClick = true;
    };
    // capture phase beats the card's own onClick, so a drag never opens a card
    const click = (e: Event) => {
      if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
    };

    wrap.addEventListener('pointerenter', rowEnter);
    wrap.addEventListener('pointerleave', rowLeave);
    wrap.addEventListener('pointerdown', down);
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);
    wrap.addEventListener('click', click, true);
    wireButton(leftRef.current, +1);
    wireButton(rightRef.current, -1);
    wrap_around();
    apply();
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      wrap.removeEventListener('pointerenter', rowEnter);
      wrap.removeEventListener('pointerleave', rowLeave);
      wrap.removeEventListener('pointerdown', down);
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', up);
      wrap.removeEventListener('pointercancel', up);
      wrap.removeEventListener('click', click, true);
      for (const [b, ev, fn] of wired) b.removeEventListener(ev, fn);
    };
  }, [recent.length]);
  return (
    <div className="page-scroll" style={{ position: 'relative' }}>
      <div className="explore-glow"><Spill src={hero[0].clip ?? presetClip(hero[0].cover)} video /></div>
      <div className="page-pad page-pad-wide">
        {recent.length > 0 && <>
          <div className="section-head"><h2 className="display">Recent</h2><a className="dim" {...linkProps('/library')}>Library <Icon name="chev" size={12} /></a></div>
          <div className="recent-marquee">
            <div className="marquee" ref={wrapRef}>
              {/* all takes in one endless row; rendered twice for a seamless loop */}
              <div className="marquee-track" ref={trackRef}>
                {[...recent, ...recent].map((t, i) => (
                  <div className="marquee-item" key={i}><MediaCard take={t} onOpen={() => setViewing(t.id)} /></div>
                ))}
              </div>
            </div>
            <button type="button" className="mq-arrow left" ref={leftRef} aria-label="Rewind the recent carousel" title="Hold to rewind"><Icon name="chev" size={18} className="flip" /></button>
            <button type="button" className="mq-arrow right" ref={rightRef} aria-label="Fast forward the recent carousel" title="Hold to fast-forward"><Icon name="chev" size={18} /></button>
          </div>
        </>}

        <div className="carousel">
          {hero.map((a) => (
            <a key={a.id} className="hero-card" {...linkProps(a.route)}>
              <AppArt app={a} />
              <div className="txt">
                <div className="display">{a.name}</div>
                <div className="dim" style={{ marginTop: 6 }}>{a.blurb}</div>
              </div>
            </a>
          ))}
        </div>

        <div className="section-head"><h2 className="display">Tools</h2><a className="dim" {...linkProps('/apps')}>All apps <Icon name="chev" size={12} /></a></div>
        <div className="tiles">
          {APPS.map((a) => (
            <a key={a.id} className="tile" {...linkProps(a.route)}>
              <span className="ico"><Icon name={a.icon} /></span>
              <span>
                <b>{a.name}</b>
                <div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>{a.blurb}</div>
              </span>
            </a>
          ))}
        </div>

        <div className="section-head"><h2 className="display">Start from a recipe</h2><span className="dim">One click loads the setup. Change anything.</span></div>
        <div className="recipe-grid">
          {RECIPES.map((r) => (
            <a key={r.id} className="preset-card" {...linkProps(recipeUrl(r))} title={r.prompt}>
              <Clip src={presetClip(r.preset)} />
              <span className="cat badge">{presetById(r.preset).name}</span>
              <span className="name">{r.name}<div className="dim" style={{ font: '550 12px/1.3 var(--font-ui)', fontVariationSettings: "'wdth' 100", textTransform: 'none', marginTop: 8 }}>Recreate this shot</div></span>
            </a>
          ))}
        </div>

      </div>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={() => {}} />}
    </div>
  );
}

export function Apps() {
  const { params } = useRoute();
  const cat = params.get('cat') || 'all';
  const [q, setQ] = useState('');
  const favorites = useStore((s) => s.favorites);

  const matches = (a: AppDef) => (cat === 'all' || a.cat === cat) && (!q || `${a.name} ${a.blurb}`.toLowerCase().includes(q.toLowerCase()));
  const all = APPS.filter(matches);
  // The main apps (the ones in the header) lead the page as a featured row.
  const MAIN = ['image', 'edit', 'video', 'audio', 'agent'];
  const featured = cat === 'all' && !q ? APPS.filter((a) => MAIN.includes(a.id) && matches(a)) : [];
  const rest = featured.length ? all.filter((a) => !MAIN.includes(a.id)) : all;
  const groups = APP_CATS.filter((c) => c.id !== 'all')
    .map((c) => ({ cat: c, apps: rest.filter((a) => a.cat === c.id) }))
    .filter((g) => g.apps.length > 0);

  const card = (a: AppDef) => {
    const on = favorites.includes(a.id);
    return (
      <div key={a.id} className="app-card">
        <button type="button" className={`star ${on ? 'on' : ''}`} aria-pressed={on}
          title={on ? 'Remove from header quick links' : 'Pin to header quick links'}
          onClick={() => toggleFavorite(a.id)}>
          <Icon name="star" size={15} />
        </button>
        <a className="media" {...linkProps(a.route)}>
          <AppArt app={a} />
          <span className="name display">{a.name}</span>
        </a>
        <div className="body">
          <p>{a.blurb}</p>
          <a className="btn sm try" {...linkProps(a.route)}>Open {a.name}</a>
        </div>
      </div>
    );
  };

  return (
    <div className="page-scroll">
      <div className="page-pad">
        <h1 className="display" style={{ fontSize: 'clamp(48px,6vw,88px)', margin: '8px 0 0' }}>All Apps</h1>
        <div className="picker-top" style={{ margin: '22px 0 18px' }}>
          <div style={{ position: 'relative' }}>
            <input className="field" style={{ width: 240, padding: '8px 10px 8px 30px' }} placeholder="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />
            <span style={{ position: 'absolute', left: 10, top: 10, color: 'var(--mute)' }}><Icon name="search" size={14} /></span>
          </div>
          {APP_CATS.map((c) => <button key={c.id} type="button" className={`pill ${cat === c.id ? 'active' : ''}`} onClick={() => setParams({ cat: c.id === 'all' ? null : c.id })}>{c.label}</button>)}
        </div>
        {featured.length > 0 && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', marginBottom: 28 }}>
            {featured.map((a) => card(a))}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.cat.id} style={{ marginBottom: 26 }}>
            <h2 className="display" style={{ fontSize: 24, margin: '0 0 14px', color: 'var(--dim)' }}>{g.cat.label}</h2>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              {g.apps.map((a) => card(a))}
            </div>
          </section>
        ))}
        {all.length === 0 && <div className="empty">No apps match your search.</div>}
      </div>
    </div>
  );
}

export function Library() {
  const { params } = useRoute();
  const filter = params.get('filter') || 'all';
  const isTrash = filter === 'trash';
  const all = useStore((s) => s.takes.filter(inFeed));
  const takes = all.filter((t) =>
    filter === 'image' ? isImage(t) : filter === 'video' ? !isImage(t) && !isModel(t) && !isAudio(t) : filter === 'audio' ? isAudio(t) : filter === '3d' ? isModel(t) : filter === 'favorites' ? !!t.starred : true);
  const done = takes.filter((t) => t.status === 'done');
  const [viewing, setViewing] = useState<number | null>(null);
  const [group, setGroup] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  // The trash is not in the store's take list (the server keeps it out of the feeds).
  const [trashList, setTrashList] = useState<Take[] | null>(null);
  const [tick, setTick] = useState(0);
  const bump = () => setTick((x) => x + 1);
  useEffect(() => {
    if (!isTrash) return;
    api.trashed().then(setTrashList).catch(() => setTrashList([]));
  }, [isTrash, tick]);
  const restoreOne = async (t: Take) => {
    try {
      await api.restore(t.id);
      bump();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'restore failed', true);
    }
  };
  const purgeOne = async (t: Take) => {
    if (!window.confirm(`Delete "${t.shot_name}" permanently? Its files go with it.`)) return;
    try {
      await api.purge(t.id);
      bump();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'delete failed', true);
    }
  };
  const emptyTrash = async () => {
    if (!trashList?.length) return;
    if (!window.confirm(`Permanently delete all ${trashList.length} trashed take${trashList.length === 1 ? '' : 's'} and their files?`)) return;
    try {
      const r = await api.emptyTrash();
      toast(`Trash emptied: ${r.takes} take${r.takes === 1 ? '' : 's'}, ${r.purged} file${r.purged === 1 ? '' : 's'}.`);
      bump();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'emptying the trash failed', true);
    }
  };
  const step = (dir: 1 | -1) => {
    const i = done.findIndex((t) => t.id === viewing);
    const n = done[(i + dir + done.length) % done.length];
    if (n) setViewing(n.id);
  };
  const toggleSel = (id: number) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = takes.length > 0 && takes.every((t) => selected.has(t.id));
  const batchDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`Move ${ids.length} take${ids.length === 1 ? '' : 's'} to the trash? Restore them from the Library's trash, or delete them permanently there.`)) return;
    setBusy(true);
    try {
      const r = await api.trashMany(ids);
      setSelected(new Set());
      toast(`Moved ${r.moved} to the trash${r.failed ? ` · ${r.failed} failed` : ''}`, r.failed > 0);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'trashing failed', true);
    } finally {
      setBusy(false);
      await refreshTakes();
    }
  };
  const trashCards = (list: Take[]) => list.map((t) => (
    <div key={t.id} className="lib-select">
      <MediaCard take={t} onOpen={() => setViewing(t.id)} actions={<>
        <button type="button" className="icon-btn" title="Restore" onClick={() => void restoreOne(t)}><Icon name="undo" size={14} /></button>
        <button type="button" className="icon-btn" title="Delete permanently" onClick={() => void purgeOne(t)}><Icon name="trash" size={14} /></button>
      </>} />
    </div>
  ));
  const cards = (list: Take[]) => list.map((t) => (
    <div key={t.id} className={`lib-select ${selected.has(t.id) ? 'on' : ''}`}>
      <MediaCard take={t} onOpen={() => setViewing(t.id)} actions={<>
        {isImage(t) && t.status === 'done' && (
          <button type="button" className="icon-btn" title="Animate" onClick={() => void animate(t)}><Icon name="video" size={14} /></button>
        )}
        <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
        <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
      </>} />
      <button type="button" className="lib-check" aria-pressed={selected.has(t.id)} title={selected.has(t.id) ? 'Deselect' : 'Select'} onClick={() => toggleSel(t.id)} />
    </div>
  ));
  let groups: [string, Take[]][] = [];
  if (group) {
    const m = new Map<string, Take[]>();
    for (const t of takes) { const g = groupOf(t); const arr = m.get(g) ?? []; arr.push(t); m.set(g, arr); }
    groups = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  return (
    <div className="page-scroll">
      <div className="page-pad" style={{ maxWidth: 1600 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          <h1 className="display" style={{ fontSize: 40, margin: '0 14px 0 0' }}>Library</h1>
          {['all', 'image', 'video', 'audio', '3d', 'favorites', 'trash'].map((f) => (
            <button key={f} type="button" className={`pill ${filter === f ? 'active' : ''}`} onClick={() => setParams({ filter: f === 'all' ? null : f })}>
              {f === '3d' ? '3D' : f === 'trash' ? 'Trash' : f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
          <span style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
          <button type="button" className={`pill ${group ? 'active' : ''}`} title="Section the grid by the app that made each take" onClick={() => setGroup(!group)}><Icon name="grid" size={13} />Group</button>
          <span className="dim" style={{ marginLeft: 'auto' }}>{isTrash
            ? `${trashList?.length ?? '…'} in the trash · kept until you empty it`
            : `${done.length} assets · saved to your output folder`}</span>
        </div>
        {isTrash ? (
          trashList === null ? <div className="empty">Loading the trash…</div>
            : trashList.length === 0 ? <div className="empty">The trash is empty. Deleted takes wait here — restore them, or delete them permanently.</div>
              : <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                  <button type="button" className="btn sm danger" onClick={() => void emptyTrash()}><Icon name="trash" size={14} />Empty trash</button>
                  <span className="dim">Files stay on disk until a take is deleted permanently.</span>
                </div>
                <div className="grid dense">{trashCards(trashList)}</div>
              </>
        ) : takes.length === 0 ? <div className="empty">Nothing here yet. Everything you make is saved here automatically.</div>
          : group ? (
            <div className="lib-groups">
              {groups.map(([label, list]) => (
                <section key={label}>
                  <h3 className="display lib-group-head">{label}<span className="dim">{list.length}</span></h3>
                  <div className="grid dense">{cards(list)}</div>
                </section>
              ))}
            </div>
          ) : (
            <div className="grid dense">{cards(takes)}</div>
          )}
      </div>
      {selected.size > 0 && (
        <div className="batch-bar">
          <span>{selected.size} selected</span>
          <button type="button" className="btn sm ghost" disabled={busy || allSelected} title="Select every take on this page" onClick={() => setSelected(new Set(takes.map((t) => t.id)))}><Icon name="check" size={14} />Select all</button>
          <button type="button" className="btn sm ghost" disabled={busy} title="Clear the selection" onClick={() => setSelected(new Set())}><Icon name="x" size={14} />Deselect all</button>
          <button type="button" className="btn sm danger" disabled={busy} title="Move the selected takes to the trash" onClick={() => void batchDelete()}><Icon name="trash" size={14} /></button>
        </div>
      )}
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
    </div>
  );
}

export function Soon({ appId }: { appId: string }) {
  const a = APPS.find((x) => x.id === appId)!;
  return (
    <div className="page-scroll">
      <div className="hero-empty">
        <div className="label" style={{ marginBottom: 14 }}>In the workshop</div>
        <div className="display" style={{ fontSize: 'clamp(40px,6vw,80px)' }}>{a.name}</div>
        <p className="dim" style={{ maxWidth: 520, margin: '16px auto 0' }}>{a.blurb}</p>
        <a className="btn" style={{ marginTop: 22 }} {...linkProps('/apps')}>Back to apps</a>
      </div>
    </div>
  );
}
