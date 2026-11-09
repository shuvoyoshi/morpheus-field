/**
 * Agent: a chat that drives the whole studio. The local LLM plans a multi-step
 * job (shown as a checklist to approve), then calls the Morpheus tool set to
 * queue renders on your GPU, chains them (animate a still, upscale a cut, ...),
 * and reports what it made. Its thinking streams live and stays collapsed until
 * you expand it. Conversations persist server-side; the left rail is the
 * history, with bulk select and delete.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { agentChat, api, posterUrl, type AgentConfig, type AgentEvent, type AgentStep, type Convo, type HistoryMsg, type Take } from '../api';
import { inFeed, isAudio, isImage, isModel, settingsOf, toast, upsertTake, useStore } from '../store';
import { lineage } from '../lineage';
import { AgentModelSetup, AgentModelSwitcher, Icon, MediaCard, Switch, RailHandle, useRail } from '../ui';
import { linkProps, navigate, useRoute } from '../router';
import { speak, stopSpeaking } from '../speech';
import Viewer from '../Viewer';

const uid = () => Math.random().toString(36).slice(2, 10);

type Block =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'thinking'; text: string; live: boolean }
  | { id: string; kind: 'text'; text: string; live: boolean }
  | { id: string; kind: 'tool'; name: string; running: boolean; ok?: boolean; summary?: string }
  | { id: string; kind: 'take'; takeId: number }
  | { id: string; kind: 'show'; ids: number[]; flow: boolean }
  | { id: string; kind: 'summary'; takeIds: number[] }
  | { id: string; kind: 'plan'; steps: AgentStep[]; resolved?: boolean; finished?: boolean; statuses?: Record<number, 'running' | 'done' | 'failed'> }
  | { id: string; kind: 'error'; text: string };

type PlanBlock = Extract<Block, { kind: 'plan' }>;

/** The take id(s) a tool queued, read from its (JSON) result summary. */
function takeIdsFromSummary(summary?: string): number[] {
  if (!summary) return [];
  try {
    const o = JSON.parse(summary) as Record<string, unknown>;
    const ids: number[] = [];
    const push = (v: unknown) => { if (typeof v === 'number') ids.push(v); };
    if (Array.isArray(o.take_ids)) for (const v of o.take_ids) push(v);
    push(o.take_id); push(o.cut_take_id); push(o.upscale_of);
    return [...new Set(ids)];
  } catch { return []; }
}

/** The server stores created_at/updated_at as UTC "YYYY-MM-DD HH:MM:SS". */
const parseUtc = (s: string) => new Date(s.replace(' ', 'T') + 'Z');
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function groupLabel(iso: string): string {
  const days = Math.round((startOfDay(new Date()) - startOfDay(parseUtc(iso))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return 'Earlier';
}
function timeLabel(iso: string): string {
  const d = parseUtc(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function AgentPage() {
  const { path } = useRoute();
  const convoMatch = /^\/agent\/c\/(\d+)$/.exec(path);
  const convoId = convoMatch ? Number(convoMatch[1]) : null;

  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [convos, setConvos] = useState<Convo[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notFound, setNotFound] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastUserRef = useRef('');
  /** A new chat's conversation is created at turn start; this holds its id until the route catches up. */
  const pendingConvoRef = useRef<number | null>(null);
  const activePlanIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadingTimerRef = useRef<number | null>(null);

  // Blocks live in a ref as the source of truth so async callbacks read the
  // latest value (state updates are batched and would otherwise go stale).
  const [blocks, setBlocksState] = useState<Block[]>([]);
  const blocksRef = useRef<Block[]>([]);
  const setBlocks = (updater: Block[] | ((prev: Block[]) => Block[])) => {
    const next = typeof updater === 'function' ? (updater as (p: Block[]) => Block[])(blocksRef.current) : updater;
    blocksRef.current = next;
    setBlocksState(next);
  };

  const loadConvos = useCallback(() => { api.conversations().then(setConvos).catch(() => {}); }, []);
  const reloadConfig = useCallback(() => {
    api.agentConfig().then(setConfig).catch(() => setConfig({ ready: false, url: null, model: null, keySet: false, reasoning: null, note: 'Could not read the agent config.', sources: { url: 'unset', model: 'unset', key: 'unset', reasoning: 'unset' } }));
  }, []);
  useEffect(() => { reloadConfig(); loadConvos(); }, [reloadConfig, loadConvos]);

  // Load (or clear) the conversation when the route points at one.
  useEffect(() => {
    setNotFound(false);
    if (convoId) {
      api.getConversation(convoId).then((c) => {
        blocksRef.current = (c.blocks ?? []) as Block[];
        setBlocksState(blocksRef.current);
        setShowThinking(!!(c.settings as Record<string, unknown>)?.thinking);
      }).catch(() => setNotFound(true));
    } else {
      blocksRef.current = [];
      setBlocksState([]);
    }
  }, [convoId]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [blocks, busy]);

  function onEvent(e: AgentEvent) {
    setBlocks((prev) => {
      const last = prev[prev.length - 1];
      switch (e.type) {
        case 'thinking':
          if (last && last.kind === 'thinking' && last.live) { const c = [...prev]; c[c.length - 1] = { ...last, text: last.text + e.text }; return c; }
          return [...prev, { id: uid(), kind: 'thinking', text: e.text, live: true }];
        case 'text':
          if (last && last.kind === 'text' && last.live) { const c = [...prev]; c[c.length - 1] = { ...last, text: last.text + e.text }; return c; }
          return [...prev, { id: uid(), kind: 'text', text: e.text, live: true }];
        case 'tool_call':
          return [...prev, { id: e.id, kind: 'tool', name: e.name, running: true }];
        case 'tool_done':
          return prev.map((b) => (b.kind === 'tool' && b.id === e.id ? { ...b, running: false, ok: e.ok, summary: e.summary } : b));
        case 'take':
          return prev.some((b) => b.kind === 'take' && b.takeId === e.id) ? prev : [...prev, { id: uid(), kind: 'take', takeId: e.id }];
        case 'show':
          return prev.some((b) => b.kind === 'show' && b.flow === e.flow && JSON.stringify(b.ids) === JSON.stringify(e.ids))
            ? prev
            : [...prev, { id: uid(), kind: 'show', ids: e.ids, flow: e.flow }];
        case 'plan':
          return [...prev, { id: uid(), kind: 'plan', steps: e.steps }];
        case 'error':
          return [...prev, { id: uid(), kind: 'error', text: e.message }];
        case 'done':
        case 'stopped':
          return prev.map((b) => ((b.kind === 'thinking' || b.kind === 'text') && (b as { live: boolean }).live ? { ...b, live: false } : b));
        default:
          return prev;
      }
    });
  }

  // The "Loading model…" bar: shown after 1.5s of no reply (a cold model is
  // loading weights), cleared as soon as anything streams back.
  function startLoading() {
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = window.setTimeout(() => setLoading(true), 1500);
  }
  function clearLoading() {
    setLoading(false);
    if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
  }

  /** Create (or touch) the conversation as soon as the turn starts, so the history rail shows it immediately. */
  async function ensureConversation() {
    try {
      if (convoId) {
        await api.saveConversation(convoId, { blocks: blocksRef.current, settings: { thinking: showThinking } });
      } else {
        const c = await api.createConversation({ title: lastUserRef.current.slice(0, 60) || 'New chat', blocks: blocksRef.current, settings: { thinking: showThinking } });
        pendingConvoRef.current = c.id;
      }
      loadConvos();
    } catch { /* server offline: persistTurn retries at turn end */ }
  }

  /** Save the conversation (create it on the first turn if it did not exist at start, then open it). */
  async function persistTurn() {
    const id = convoId ?? pendingConvoRef.current;
    try {
      if (id) {
        await api.saveConversation(id, { blocks: blocksRef.current, settings: { thinking: showThinking } });
      } else {
        const c = await api.createConversation({ title: lastUserRef.current.slice(0, 60) || 'New chat', blocks: blocksRef.current, settings: { thinking: showThinking } });
        pendingConvoRef.current = c.id;
      }
      loadConvos();
      // Navigate only once the turn is over: at turn start the convoId effect would
      // reload blocks and race the live stream.
      if (!convoId && pendingConvoRef.current) navigate(`/agent/c/${pendingConvoRef.current}`, true);
    } catch (e) {
      toast(e instanceof Error ? e.message ? 'Saved locally, but the server is offline' : e.message : 'could not save the conversation', true);
    }
  }

  function updatePlan(planId: string, fn: (p: PlanBlock) => PlanBlock) {
    setBlocks((prev) => prev.map((b) => (b.id === planId && b.kind === 'plan' ? fn(b) : b)));
  }

  /** Does a plan step's `tool` field point at this tool? LLMs are loose about the
   *  name (free text, missing, hyphens), so compare normalized and allow either side
   *  to contain the other. */
  function stepToolMatch(stepTool: string | undefined, tool: string): boolean {
    if (!stepTool) return false;
    const norm = (v: string) => v.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    const a = norm(stepTool), b = norm(tool);
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  /** Fold a tool event into the active plan's to-do checks. Match by tool name first,
   *  then by order (steps run in the order the plan listed them), so the checklist
   *  still advances when the name is loose. */
  function stepState(p: PlanBlock, next: 'running' | 'done' | 'failed', tool: string): PlanBlock {
    const statuses = { ...p.statuses };
    const open = (k: number) => statuses[k] !== 'done' && statuses[k] !== 'failed';
    if (next === 'running') {
      let i = p.steps.findIndex((s, k) => stepToolMatch(s.tool, tool) && open(k));
      if (i < 0) i = p.steps.findIndex((_s, k) => open(k));
      if (i >= 0) statuses[i] = 'running';
    } else {
      let i = -1;
      for (let k = p.steps.length - 1; k >= 0; k--) if (stepToolMatch(p.steps[k].tool, tool) && statuses[k] === 'running') { i = k; break; }
      if (i < 0) for (let k = p.steps.length - 1; k >= 0; k--) if (statuses[k] === 'running') { i = k; break; }
      if (i >= 0) statuses[i] = next;
    }
    return { ...p, statuses };
  }

  function routePlan(e: AgentEvent) {
    const pid = activePlanIdRef.current;
    if (!pid) return;
    if (e.type === 'tool_call') updatePlan(pid, (p) => stepState(p, 'running', e.name));
    else if (e.type === 'tool_done') updatePlan(pid, (p) => stepState(p, e.ok ? 'done' : 'failed', e.name));
  }

  async function runTurn(message: string, base?: Block[]) {
    const text = message.trim();
    if (!text || busy) return;
    lastUserRef.current = text;
    const baseBlocks = base ?? blocksRef.current;
    setBlocks([...baseBlocks, { id: uid(), kind: 'user', text }]);
    setInput('');
    setBusy(true);
    startLoading();
    // Await so the conversation id is settled before the turn ends (a fast turn must not
    // double-create the conversation in persistTurn).
    await ensureConversation();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const history: HistoryMsg[] = [];
    for (const b of baseBlocks) {
      if (b.kind === 'user') history.push({ role: 'user', content: b.text });
      else if (b.kind === 'text') history.push({ role: 'assistant', content: b.text });
    }
    // Asked on the gesture that starts the work, so a completion alert can reach
    // the user off-tab.
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    // take id -> the tool that produced it: show_take cards are "shown", not "created".
    const turnTakes = new Map<number, string>();
    let lastTool = '';
    const handleEvent = (e: AgentEvent) => {
      if (e.type === 'tool_call') lastTool = e.name;
      if (e.type === 'take') turnTakes.set(e.id, lastTool);
      if (e.type !== 'loading' || (e as { ready?: boolean }).ready) clearLoading();
      routePlan(e);
      onEvent(e);
    };
    try {
      await agentChat(text, handleEvent, ctl.signal, history);
    } catch (err) {
      clearLoading();
      if ((err as { name?: string })?.name === 'AbortError') onEvent({ type: 'stopped' });
      else onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearLoading();
      setBusy(false);
      abortRef.current = null;
      const created = [...turnTakes].filter(([, tool]) => tool !== 'show_take').map(([id]) => id);
      if (created.length) {
        setBlocks((prev) => [...prev, { id: uid(), kind: 'summary', takeIds: created }]);
      }
      const pid = activePlanIdRef.current;
      if (pid) updatePlan(pid, (p) => ({ ...p, finished: true }));
      activePlanIdRef.current = null;
      if (created.length) void finishTurn(created.length);
      void persistTurn();
    }
  }

  /** The turn is over: alert the user, and hand the GPU back if this one ran on it. */
  async function finishTurn(takes: number) {
    let freed = false;
    try { await api.free(); freed = true; } catch { /* cloud engine or offline: nothing to free */ }
    toast(`Done — ${takes} take${takes > 1 ? 's' : ''}${freed ? ' · VRAM freed' : ''}`);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification('Morpheus — agent done', { body: `${takes} take${takes > 1 ? 's' : ''} ready${freed ? ', VRAM freed' : ''}.` });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* some browsers refuse off-gesture notifications */ }
    }
  }

  /** Stop halts the agent loop and cancels the live GPU render. */
  const stop = () => { abortRef.current?.abort(); void api.stop().catch(() => {}); };

  /** Library drawer: add a take as a `take:<id>` reference in the prompt. */
  function addRef(id: number) {
    const tok = `take:${id}`;
    setInput((prev) => (prev.trim() ? `${prev.replace(/[ \t]+$/, '')} ${tok}` : tok));
    toast(`${tok} added as a reference`);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // ---- message actions ----
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy', true); }
  }
  function readAloud(blockId: string) {
    const b = blocksRef.current.find((x) => x.id === blockId);
    if (!b || (b.kind !== 'user' && b.kind !== 'text')) return;
    if (speakingId) { stopSpeaking(); setSpeakingId(null); return; }
    setSpeakingId(blockId);
    speak((b as { text: string }).text, () => setSpeakingId(null));
  }
  function retryUserBlock(blockId: string) {
    if (busy) return;
    const idx = blocksRef.current.findIndex((b) => b.id === blockId);
    if (idx < 0) return;
    const message = (blocksRef.current[idx] as { text: string }).text;
    void runTurn(message, blocksRef.current.slice(0, idx));
  }
  async function forkAt(index: number) {
    try {
      let sourceId = convoId;
      if (!sourceId) {
        const c = await api.createConversation({ title: lastUserRef.current.slice(0, 60) || 'Untitled', blocks: blocksRef.current });
        sourceId = c.id;
      }
      const fork = await api.forkConversation(sourceId, index, 'Fork');
      navigate(`/agent/c/${fork.id}`);
      loadConvos();
    } catch (e) { toast(e instanceof Error ? e.message : 'could not fork', true); }
  }

  // ---- history ----
  const allSelected = convos.length > 0 && selected.size === convos.length;
  const toggleSelect = (id: number) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAll = () => setSelected(new Set(convos.map((c) => c.id)));
  const deselectAll = () => setSelected(new Set());
  async function deleteMany(ids: number[]) {
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} conversation${ids.length > 1 ? 's' : ''}?`)) return;
    try {
      await api.deleteConversations(ids);
      setSelected((prev) => { const n = new Set(prev); ids.forEach((i) => n.delete(i)); return n; });
      loadConvos();
      if (convoId && ids.includes(convoId)) navigate('/agent', true);
    } catch (e) { toast(e instanceof Error ? e.message : 'could not delete', true); }
  }
  const deleteOne = (id: number) => void deleteMany([id]);

  const groups = (() => {
    const buckets: Record<string, Convo[]> = { Today: [], Yesterday: [], 'This week': [], Earlier: [] };
    for (const c of convos) (buckets[groupLabel(c.updated_at)] ??= []).push(c);
    return ['Today', 'Yesterday', 'This week', 'Earlier'].map((label) => ({ label, items: buckets[label] ?? [] })).filter((g) => g.items.length);
  })();

  const title = convos.find((c) => c.id === convoId)?.title ?? (blocks[0] && (blocks[0] as { kind?: string }).kind === 'user' ? (blocks[0] as { text?: string }).text?.slice(0, 60) : null);

  const [railOpen, toggleRail] = useRail();

  return (
    <div className={`agent ${railOpen ? '' : 'agent-closed'}`}>
      <RailHandle open={railOpen} onToggle={toggleRail} />
      <aside className="agent-side">
        <div className="agent-side-top">
          <button type="button" className="agent-new" onClick={() => navigate('/agent')}>
            <Icon name="plus" size={15} />New chat
          </button>
          <button type="button" className={`agent-side-link ${libOpen ? 'on' : ''}`} onClick={() => setLibOpen((v) => !v)}><Icon name="film" size={14} />Library</button>
        </div>
        <div className="agent-history">
          <div className="agent-history-head">
            <span className="label">History</span>
            {convos.length > 0 && (
              <span className="agent-history-tools">
                <input type="checkbox" className="agent-hcheck"
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < convos.length; }}
                  checked={allSelected}
                  onChange={() => (allSelected ? deselectAll() : selectAll())}
                  aria-label="Select all conversations" />
              </span>
            )}
          </div>
          {convos.length === 0 ? (
            <div className="agent-history-empty dim">No conversations yet.</div>
          ) : (
            <div className="agent-history-list">
              {groups.map((g) => (
                <div key={g.label} className="agent-hgroup">
                  <div className="agent-hlabel">{g.label}</div>
                  {g.items.map((c) => (
                    <div key={c.id} className={`agent-hrow ${c.id === convoId ? 'active' : ''}`}>
                      <input type="checkbox" className="agent-hcheck" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} aria-label={`Select ${c.title}`} />
                      <a className="agent-htitle" {...linkProps(`/agent/c/${c.id}`)} title={`${c.title} · ${timeLabel(c.updated_at)}`}>{c.title}</a>
                       <button type="button" className="agent-hdel" onClick={() => deleteOne(c.id)} title="Delete"><Icon name="trash" size={12} /></button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {selected.size > 0 && (
            <div className="agent-history-bar">
              <span className="dim">{selected.size} selected</span>
              <button type="button" className="btn sm danger" onClick={() => void deleteMany([...selected])}><Icon name="trash" size={13} />Delete</button>
            </div>
          )}
        </div>
      </aside>

      <div className="agent-main">
        <header className="agent-head">
          <div className="agent-title">
            <span className="display" style={{ fontSize: 20 }}>{convoId ? (title ?? 'Conversation') : 'New chat'}</span>
            <span className="dim">{config?.ready ? '' : 'No LLM configured yet'}</span>
          </div>
        </header>

        <div className="agent-scroll" ref={scrollRef}>
          {!config || !config.ready ? (
            <div className="agent-setup-wrap">
              <div className="label" style={{ marginBottom: 10 }}>Point the agent at a local model</div>
              <div className="dim" style={{ fontSize: 12.5, marginBottom: 12 }}>
                Any OpenAI-compatible server works (LM Studio, llama.cpp, vLLM). The model should support tool calling — a thinking model like Qwen3 works well.
              </div>
              <AgentModelSetup onSaved={reloadConfig} />
            </div>
          ) : notFound ? (
            <div className="agent-empty">
              <div className="display" style={{ fontSize: 24 }}>That conversation is gone</div>
              <div className="dim" style={{ margin: '10px auto 18px', maxWidth: 420 }}>It may have been deleted in another window.</div>
              <button type="button" className="btn accent" onClick={() => navigate('/agent')}><Icon name="plus" size={13} />New chat</button>
            </div>
          ) : blocks.length === 0 ? (
            <div className="agent-empty">
              <div className="display" style={{ fontSize: 'clamp(26px,3.4vw,42px)' }}>What are we making <span className="hl">today</span>?</div>
              <div className="dim" style={{ maxWidth: 560, margin: '14px auto 0' }}>
                Ask for anything, end to end. The agent plans the steps, queues the renders on your GPU, and chains them. Try:
              </div>
              <div className="agent-samples">
                <button type="button" onClick={() => setInput('A 5s video of a paper boat sailing a rain puddle at dusk, then upscale it to 1080p.')}>A 5s video of a paper boat in a rain puddle, then a 1080p upscale</button>
                <button type="button" onClick={() => setInput('Make a logo still for a coffee brand, then animate it with a slow orbit camera move.')}>A logo still, then animate it with a slow orbit</button>
                <button type="button" onClick={() => setInput('@Mara walks through a night market with neon, then upscale the cut.')}>@Mara in a neon night market, then upscale the cut</button>
              </div>
            </div>
          ) : (
            <div className="agent-thread">
              {blocks.map((b, i) => (
                <BlockView key={b.id} b={b} index={i} showThinking={showThinking} speakingId={speakingId}
                  onOpen={setViewing} onApprove={(id) => approvePlan(id)} onDiscard={discardPlan}
                  onCopy={copyText} onSpeak={readAloud} onRetry={retryUserBlock} onFork={forkAt}
                  onStop={stop} disabled={busy} />
              ))}
              {loading && <LoadingBar />}
            </div>
          )}
        </div>

        {config?.ready && (
          <>
            <div className="agent-controls">
              <AgentModelSwitcher />
              <span className="chip" style={{ gap: 8 }} title="Show the model's reasoning, collapsed by default"><Icon name="sparkle" size={13} />Thinking <Switch on={showThinking} onChange={(v) => { setShowThinking(v); if (convoId) api.saveConversation(convoId, { settings: { thinking: v } }).catch(() => {}); }} label="show thinking" /></span>
            </div>
            <div className="agent-composer">
              <textarea
                ref={inputRef}
                className="agent-prompt"
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runTurn(input); } }}
                placeholder="Describe what you want, end to end. Enter to run · Shift+Enter for a new line."
              />
              {busy
                ? <button type="button" className="gen-tile danger" onClick={stop}><Icon name="stop" size={18} /><small>Stop</small></button>
                : <button type="button" className="gen-tile" disabled={!input.trim()} onClick={() => void runTurn(input)}><Icon name="bolt" size={18} /><small>Run</small></button>}
            </div>
          </>
        )}
      </div>

      {libOpen && <LibraryDrawer onClose={() => setLibOpen(false)} onRef={addRef} onOpen={(id) => setViewing(id)} />}
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={() => {}} />}
    </div>
  );

  function approvePlan(planId: string) {
    const plan = blocksRef.current.find((b) => b.id === planId && b.kind === 'plan');
    if (!plan || plan.kind !== 'plan') return;
    setBlocks((prev) => prev.map((b) => (b.id === planId ? { ...b, resolved: true } : b)));
    activePlanIdRef.current = planId;
    const list = plan.steps.map((s, i) => `${i + 1}. ${s.label}${s.tool ? ` (${s.tool})` : ''}`).join('\n');
    void runTurn(`The user approved this plan. Execute it now, in order, and do not present the plan again:\n${list}\n\nOriginal request: ${lastUserRef.current}`);
  }
  function discardPlan(planId: string) {
    setBlocks((prev) => prev.filter((b) => b.id !== planId));
    toast('Plan discarded');
  }
}

function BlockView(p: {
  b: Block; index: number; showThinking: boolean; speakingId: string | null;
  onOpen: (id: number) => void; onApprove: (id: string) => void; onDiscard: (id: string) => void;
  onCopy: (text: string) => void; onSpeak: (id: string) => void; onRetry: (id: string) => void; onFork: (index: number) => void;
  onStop: () => void;
  disabled: boolean;
}) {
  const b = p.b;
  const speaking = p.speakingId === b.id;
  switch (b.kind) {
    case 'user':
      return (
        <div className="agent-row user">
          <div className="agent-bubble user">{b.text}</div>
          <div className="agent-actions">
            <button type="button" className="agent-act" title="Copy" onClick={() => p.onCopy(b.text)}><Icon name="copy" size={13} /></button>
            <button type="button" className={`agent-act ${speaking ? 'on' : ''}`} title="Read aloud" onClick={() => p.onSpeak(b.id)}><Icon name="vol" size={13} /></button>
            {!p.disabled && <button type="button" className="agent-act" title="Retry from here" onClick={() => p.onRetry(b.id)}><Icon name="redo" size={13} /></button>}
            <button type="button" className="agent-act" title="Fork a new conversation up to here" onClick={() => p.onFork(p.index)}><Icon name="fork" size={13} /></button>
          </div>
        </div>
      );
    case 'thinking':
      return <ThinkingBlock text={b.text} live={b.live} showThinking={p.showThinking} />;
    case 'text':
      return (
        <div className="agent-row agent">
          <div className="agent-avatar"><Icon name="sparkle" size={13} /></div>
          <div className="agent-textwrap">
            <div className="agent-bubble agent">{b.live ? b.text : <Md text={b.text} />}{b.live && <span className="agent-caret" aria-hidden />}</div>
            {!b.live && (
              <div className="agent-actions">
                <button type="button" className="agent-act" title="Copy" onClick={() => p.onCopy(b.text)}><Icon name="copy" size={13} /></button>
                <button type="button" className={`agent-act ${speaking ? 'on' : ''}`} title="Read aloud" onClick={() => p.onSpeak(b.id)}><Icon name="vol" size={13} /></button>
                <button type="button" className="agent-act" title="Fork a new conversation up to here" onClick={() => p.onFork(p.index)}><Icon name="fork" size={13} /></button>
              </div>
            )}
          </div>
        </div>
      );
    case 'tool': {
      const thumbId = takeIdsFromSummary(b.summary)[0];
      return (
        <div className={`agent-row tool ${b.running ? 'running' : b.ok === false ? 'err' : 'done'}`}>
          <div className={`agent-tool ${b.running ? 'running' : b.ok === false ? 'err' : 'done'}`}>
            <span className="agent-tool-ico"><Icon name={b.running ? 'loop' : b.ok === false ? 'x' : 'bolt'} size={13} /></span>
            <b title={b.name}>{b.name.replace(/_/g, ' ')}</b>
            <span className={`agent-tool-state ${b.running ? 'run' : b.ok === false ? 'bad' : ''}`}>{b.running ? 'working…' : b.ok === false ? 'failed' : 'done'}</span>
            {thumbId !== undefined && (
              <img className="agent-tool-thumb" src={posterUrl(thumbId)} alt="" title="Open preview"
                onClick={() => p.onOpen(thumbId)}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            )}
            {b.summary && (
              <details className="agent-tool-detail" open>
                <summary>{b.ok === false ? 'error details' : 'details'}</summary>
                <pre>{b.summary}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    case 'take':
      return <div className="agent-row take"><TakeCard id={b.takeId} onOpen={p.onOpen} /></div>;
    case 'show':
      return <ShowBlock ids={b.ids} flow={b.flow} onOpen={p.onOpen} />;
    case 'summary': {
      const ids = b.takeIds;
      if (!ids.length) return null;
      return (
        <div className="agent-row agent">
          <div className="agent-avatar"><Icon name="sparkle" size={13} /></div>
          <div className="agent-made">
            <div className="agent-made-head"><Icon name="bolt" size={13} />Created · {ids.length}</div>
            <div className="agent-made-grid">
              {ids.map((id) => <TakeCard key={id} id={id} onOpen={p.onOpen} />)}
            </div>
          </div>
        </div>
      );
    }
    case 'plan': {
      if (b.resolved) {
        const active = !b.finished;
        const n = b.steps.length;
        const doneCount = Object.values(b.statuses ?? {}).filter((s) => s === 'done').length;
        return (
          <div className={`agent-row plan ${active ? 'active' : ''}`}>
            <div className={`agent-plan todo ${active ? 'pinned' : ''}`}>
              <div className="agent-plan-head">
                <Icon name="nodes" size={14} />Plan · {n} steps · approved
                <span className="dim"> · {doneCount}/{n} done</span>
              </div>
              <ol className="agent-todo">
                {b.steps.map((s, i) => {
                  const st = b.statuses?.[i];
                  return (
                    <li key={s.id ?? i} className={st ?? 'pending'}>
                      <span className="todo-box" aria-hidden>
                        {st === 'done' ? '✓' : st === 'failed' ? '✗' : st === 'running' ? <span className="todo-spin" /> : <span className="todo-tick" />}
                      </span>
                      <span className="todo-label">{s.label}</span>
                    </li>
                  );
                })}
              </ol>
              {active && (
                <div className="agent-plan-actions">
                  <button type="button" className="btn sm danger" onClick={p.onStop}><Icon name="stop" size={13} />Stop</button>
                </div>
              )}
            </div>
          </div>
        );
      }
      return (
        <div className="agent-row plan">
          <div className="agent-plan">
            <div className="agent-plan-head"><Icon name="nodes" size={14} />Plan · {b.steps.length} steps</div>
            <ol className="agent-plan-steps">
              {b.steps.map((s, i) => (
                <li key={s.id ?? i}><b>{i + 1}.</b> {s.label}{s.tool && <span className="dim tool-tag">{s.tool}</span>}{s.why && <div className="dim why">{s.why}</div>}</li>
              ))}
            </ol>
            {!p.disabled && (
              <div className="agent-plan-actions">
                <button type="button" className="btn accent" onClick={() => p.onApprove(b.id)}><Icon name="play" size={13} />Run the plan</button>
                <button type="button" className="linkish" onClick={() => p.onDiscard(b.id)}>Discard</button>
              </div>
            )}
          </div>
        </div>
      );
    }
    case 'error':
      return <div className="agent-row error"><div className="agent-err"><Icon name="x" size={12} />{b.text}</div></div>;
    default:
      return null;
  }
}

function ThinkingBlock({ text, live, showThinking }: { text: string; live: boolean; showThinking: boolean }) {
  const [open, setOpen] = useState(showThinking);
  useEffect(() => { setOpen(showThinking); }, [showThinking]);
  return (
    <div className="agent-think-wrap">
      <div className={`agent-think ${open ? 'open' : ''}`}>
        <button type="button" className="agent-think-head" onClick={() => setOpen(!open)}>
          <Icon name="sparkle" size={12} />
          <span>Thinking</span>
          {live && <span className="agent-pulse" aria-hidden />}
          <Icon name={open ? 'up' : 'down'} size={12} />
        </button>
        {open && <div className="agent-think-body">{text || (live ? 'thinking…' : '')}</div>}
      </div>
    </div>
  );
}

/**
 * Minimal markdown for agent replies: bold, italic, inline code, headings,
 * ordered and unordered lists, paragraphs. Plain text (user blocks, thinking)
 * stays pre-wrapped. Builds React nodes, so there is no HTML injection path.
 */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g;
function inline(s: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of s.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(s.slice(last, i));
    const t = m[0];
    if (t.startsWith('**')) out.push(<b key={k++}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else out.push(<i key={k++}>{t.slice(1, -1)}</i>);
    last = i + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function Md({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let key = 0;
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => { if (para.length) { blocks.push(<p key={key++}>{inline(para.join(' '))}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
    blocks.push(list.ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const num = /^\d+[.)]\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      const label = inline(heading[2]);
      blocks.push(heading[1].length === 1 ? <h3 key={key++}>{label}</h3> : <h4 key={key++}>{label}</h4>);
    } else if (num || bullet) {
      flushPara();
      const ordered = !!num;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((num ?? bullet)![1]);
    } else if (!line) {
      flushPara(); flushList();
    } else para.push(line);
  }
  flushPara(); flushList();
  return <div className="agent-md">{blocks}</div>;
}

/** A take from the live feed; if the socket missed it, poll the server until it is terminal. */
function useTake(id: number): Take | undefined {
  const take = useStore((s) => s.takes.find((t) => t.id === id));
  useEffect(() => {
    if (take) return;
    let dead = false;
    const t0 = Date.now();
    (async () => {
      while (!dead && Date.now() - t0 < 10 * 60_000) {
        try {
          const t = await api.getTake(id);
          if (dead) return;
          upsertTake(t);
          if (t.status === 'done' || t.status === 'failed' || t.status === 'stopped') return;
        } catch { /* server offline; retry */ }
        if (!dead) await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => { dead = true; };
  }, [id, take]);
  return take;
}

function TakeCard({ id, onOpen }: { id: number; onOpen: (id: number) => void }) {
  const take = useTake(id);
  if (!take) return <div className="agent-take pending"><span className="dot" />Queued take {id}…</div>;
  return (
    <div className="agent-take">
      <MediaCard take={take} onOpen={() => onOpen(take.id)} />
    </div>
  );
}

/** The chain a shown take was made from (oldest first): the head, then its parents
 *  fetched one hop at a time as they resolve into the store. */
function useFlowChain(headId: number | undefined): Take[] {
  const takes = useStore((s) => s.takes);
  const all = useMemo(() => {
    const byId = new Map(takes.map((t) => [t.id, t]));
    return [...byId.values()];
  }, [takes]);
  const chain = useMemo(() => (headId != null ? lineage(all, headId) : []), [all, headId]);
  // The head, or the next unresolved parent: one fetch per hop as the chain grows.
  const headMissing = headId != null && !all.some((t) => t.id === headId);
  const nextParent = headMissing
    ? headId
    : (chain.length && chain[0].parent_take_id != null && !all.some((t) => t.id === chain[0].parent_take_id) ? chain[0].parent_take_id : undefined);
  useEffect(() => {
    if (nextParent == null) return;
    let dead = false;
    api.getTake(nextParent).then((t) => { if (!dead) upsertTake(t); }).catch(() => { /* the chain simply stops there */ });
    return () => { dead = true; };
  }, [nextParent]);
  return chain;
}

/** A short caption under a shown card: id, app, model. */
function takeCaption(t: Take): string {
  const s = settingsOf(t);
  const app = s.app ?? (t.kind === 'still' ? 'image' : t.kind === 'upres' ? 'upscale' : 'video');
  const model = s.videoModel ?? s.model;
  return `#${t.id} · ${app}${model ? ` · ${model}` : ''}`;
}

/** A show_take result: the takes side by side — or, with flow, the chain that led
 *  to them, oldest to newest, with arrows. Clicking any card opens the viewer. */
function ShowBlock({ ids, flow, onOpen }: { ids: number[]; flow: boolean; onOpen: (id: number) => void }) {
  const chain = useFlowChain(flow ? ids[0] : undefined);
  return (
    <div className="agent-row agent">
      <div className="agent-avatar"><Icon name="sparkle" size={13} /></div>
      <div className="agent-made">
        <div className="agent-made-head">
          <Icon name="film" size={13} />{flow ? 'Flow' : 'Showing'} · {flow ? Math.max(chain.length, ids.length) : ids.length}
        </div>
        {flow ? (
          <div className="agent-show-flow">
            {chain.length === 0 ? (
              <div className="agent-take pending"><span className="dot" />Loading the chain…</div>
            ) : (
              chain.map((t, i) => (
                <Fragment key={t.id}>
                  {i > 0 && <span className="agent-show-arrow" aria-hidden>→</span>}
                  <div className="agent-take">
                    <MediaCard take={t} onOpen={() => onOpen(t.id)} />
                    <div className="agent-show-cap">{takeCaption(t)}</div>
                  </div>
                </Fragment>
              ))
            )}
          </div>
        ) : (
          <div className={`agent-show-grid ${ids.length === 1 ? 'single' : ''}`}>
            {ids.map((id) => <TakeCard key={id} id={id} onOpen={onOpen} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** The "Loading model…" bar shown while the LLM is silent (cold weights) and before the first token. */
function LoadingBar() {
  return (
    <div className="agent-status" role="status">
      <span className="agent-status-bar" aria-hidden><i /></span>
      <span>Loading model…</span>
    </div>
  );
}

/** A slide-in panel of finished takes: click an item to preview it full-screen, or add it as a `take:<id>` reference. */
function LibraryDrawer({ onClose, onRef, onOpen }: { onClose: () => void; onRef: (id: number) => void; onOpen: (id: number) => void }) {
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && t.status === 'done'));
  const [filter, setFilter] = useState('all');
  const list = takes.filter((t) =>
    filter === 'image' ? isImage(t) : filter === 'video' ? !isImage(t) && !isModel(t) && !isAudio(t) : filter === 'audio' ? isAudio(t) : filter === '3d' ? isModel(t) : true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="lib-veil" onClick={onClose} aria-hidden />
      <aside className="lib-drawer" role="dialog" aria-label="Library">
        <div className="lib-head">
          <span className="display">Library</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close library"><Icon name="x" size={14} /></button>
        </div>
        <div className="lib-filters">
          {['all', 'image', 'video', 'audio', '3d'].map((f) => (
            <button key={f} type="button" className={`pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f === '3d' ? '3D' : f[0].toUpperCase() + f.slice(1)}</button>
          ))}
        </div>
        <div className="lib-body">
          {list.length === 0 ? <div className="dim" style={{ padding: 18 }}>Nothing here yet. Everything you make lands here.</div> : (
            <div className="lib-grid">
              {list.map((t) => (
                <MediaCard key={t.id} take={t} onOpen={() => onOpen(t.id)} actions={
                  <button type="button" className="icon-btn" title="Use as a reference in the prompt" onClick={() => onRef(t.id)}><Icon name="copy" size={14} /></button>
                } />
              ))}
            </div>
          )}
        </div>
        <div className="lib-foot">
          <a {...linkProps('/library')}>Open full library</a>
        </div>
      </aside>
    </>
  );
}
