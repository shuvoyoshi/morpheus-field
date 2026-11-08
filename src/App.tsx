/** Morpheus shell: top bar + routed page. */
import { lazy, Suspense, useEffect } from 'react';
import { APPS, type AppDef } from './catalog';
import { linkProps, useRoute } from './router';
import { startLive, useStore } from './store';
import { useGlobalDrop } from './drop';
import { GpuChip, Icon, JudgeBanner, Logo, Toast } from './ui';
import VideoPage from './pages/Video';
import ImagePage from './pages/Image';
import DirectorPage from './pages/Director';
import MirrorPage from './pages/Mirror';
import ReshootPage from './pages/Reshoot';
import EffectsPage from './pages/Effects';
import UpscalePage from './pages/Upscale';
import ExtendPage from './pages/Extend';
import SpeakPage from './pages/Speak';
import EditPage from './pages/Edit';
import AudioPage from './pages/Audio';
import CastPage from './pages/Cast';
import CutoutPage from './pages/Cutout';
import AgentPage from './pages/Agent';
// three.js is only needed by Stage and Object: load them when opened, not on every page
const StagePage = lazy(() => import('./pages/Stage'));
const ObjectPage = lazy(() => import('./pages/Object'));
import { Apps, Explore, Library, Soon } from './pages/Home';
import Setup from './pages/Setup';
import Player from './Player';
import { PairChip } from './Phone';

const SECTIONS = [
  { to: '/image', label: 'Image', icon: 'image' },
  { to: '/edit', label: 'Edit', icon: 'wand' },
  { to: '/video', label: 'Video', icon: 'video' },
  { to: '/audio', label: 'Audio', icon: 'audio' },
  { to: '/agent', label: 'Agent', icon: 'nodes' },
  { to: '/library', label: 'Library', icon: 'film' },
  { to: '/apps', label: 'Apps', icon: 'grid' },
];

export default function App() {
  const { path, params } = useRoute();
  useEffect(() => { startLive(); }, []);
  const drop = useGlobalDrop();
  const judge = useStore((s) => !!s.status?.judge);
  // Apps the user pinned to the header, in the order they pinned them.
  const favorites = useStore((s) => s.favorites);
  const favApps = favorites.map((id) => APPS.find((a) => a.id === id)).filter((a): a is AppDef => !!a);

  const page = (() => {
    if (path === '/image') return <ImagePage />;
    if (path === '/video') return <VideoPage />;
    if (path === '/director') return <DirectorPage />;
    if (path === '/mirror') return <MirrorPage />;
    if (path === '/reshoot') return <ReshootPage />;
    if (path === '/effects') return <EffectsPage />;
    if (path === '/upscale') return <UpscalePage />;
    if (path === '/extend') return <ExtendPage />;
    if (path === '/speak') return <SpeakPage />;
    if (path === '/edit') return <EditPage />;
    if (path === '/audio') return <AudioPage />;
    if (path === '/cast') return <CastPage />;
    if (path === '/cutout') return <CutoutPage />;
    if (path === '/agent' || /^\/agent\/c\/\d+$/.test(path)) return <AgentPage />;
    if (path === '/stage') return <StagePage />;
    if (path === '/object') return <ObjectPage />;
    if (path === '/apps') return <Apps />;
    if (path === '/library') return <Library />;
    if (path === '/setup') return <Setup />;
    return <Explore />;
  })();

  // the tab says where you are
  useEffect(() => {
    const name = path === '/' ? 'Explore' : path === '/setup' ? 'Setup' : path === '/library' ? 'Library'
      : (path === '/agent' || /^\/agent\/c\/\d+$/.test(path)) ? 'Agent'
      : APPS.find((a) => a.route.split('?')[0] === path)?.name ?? SECTIONS.find((s) => s.to === path)?.label;
    document.title = name ? `${name} · Morpheus` : 'Morpheus';
  }, [path]);

  const isActive = (to: string) => {
    if (to === '/') return path === '/';
    if (to === '/agent') return path === '/agent' || /^\/agent\/c\/\d+$/.test(path);
    const [p, q] = to.split('?');
    if (p !== path) return false;
    if (!q) return !(path === '/video' && params.get('mode') === 'loop');
    return [...new URLSearchParams(q)].every(([k, v]) => params.get(k) === v);
  };

  return (
    <div className={`app ${judge ? 'has-judge' : ''}`}>
      <header className={`topbar ${path === '/' ? 'on-home' : ''}`}>
        <a className="brand" {...linkProps('/')}><Logo /><span className="brand-word">M O R P H E U S</span></a>
        <nav className="nav">
          {SECTIONS.map((s) => <a key={s.to} className={`nav-link ${isActive(s.to) ? 'active' : ''}`} {...linkProps(s.to)}><Icon name={s.icon} size={14} />{s.label}</a>)}
          {favApps.length > 0 && <>
            <span className="nav-sep" />
            {favApps.map((a) => (
              <a key={a.id} className={`nav-link ${isActive(a.route) ? 'active' : ''}`} {...linkProps(a.route)}>
                <Icon name={a.icon} size={14} />{a.name}
              </a>
            ))}
          </>}
          <a className={`nav-link nav-setup ${isActive('/setup') ? 'active' : ''}`} {...linkProps('/setup')}><Icon name="cpu" size={14} />Setup</a>
        </nav>
        <div className="topbar-right">
          <a className="nav-link" {...linkProps('/setup')} title="Models and setup"><Icon name="cpu" size={14} />Setup</a>
          <PairChip />
          <GpuChip />
        </div>
      </header>
      <JudgeBanner />
      <main className="main"><Suspense fallback={null}>{page}</Suspense></main>
      {drop.dragging && drop.label && <div className="drop-veil" aria-hidden><span>{drop.label}</span></div>}
      <Player />
      <Toast />
    </div>
  );
}
