/**
 * "Use your phone" (PhoneDrop): a QR code for a single-use LAN link
 * (server/phone.ts). The phone films or picks a clip and uploads it; the clip
 * lands here over the live socket and goes straight into the page's clip slot
 * via onClip.
 *
 * "Open on your phone" (PhonePair): pairs the phone's browser with this
 * desktop so the whole app can be opened in it (server/phoneApp.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { api, type PairEvent, type PairSession, type PhoneEvent, type PhoneSession } from './api';
import { onPairEvent, onPhoneEvent } from './store';
import { linkProps } from './router';
import { Commands, Icon, Qr } from './ui';

type Phase =
  | { kind: 'off' }
  | { kind: 'opening' }
  | { kind: 'open'; session: PhoneSession; step: 'waiting' | 'opened' | 'receiving'; bytes: number }
  | { kind: 'ended'; text: string }
  | { kind: 'error'; text: string };

const ENDED: Record<string, string> = {
  expired: 'The code expired. Make a new one when you are ready to film.',
  abuse: 'The link closed after too many bad requests on the network.',
  replaced: 'The code moved to another Morpheus window.',
};

export function PhoneDrop({ onClip }: { onClip: (token: string, name: string) => void | Promise<void> }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'off' });
  const [now, setNow] = useState(Date.now());
  const sessionId = phase.kind === 'open' ? phase.session.id : null;
  const onClipRef = { current: onClip };
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // The session outlives the page: the user scans the code and then films on
  // the phone, often without the desktop in front of them — leaving the page
  // must NOT close the link (that is what used to cut the phone mid-upload).
  // It closes on its TTL, on Cancel, or when a newer code replaces it.
  // Follow it at all times — including while at 'off', so a link opened in
  // another window (or before a page reload) is adopted here.
  useEffect(() => {
    let dead = false;
    const off = onPhoneEvent((e: PhoneEvent) => {
      const p = phaseRef.current;
      if (p.kind === 'open' && e.id !== p.session.id) return;
      if (e.state === 'opened' || e.state === 'waiting' || e.state === 'receiving') {
        setPhase((q) => (q.kind === 'open' ? { ...q, step: e.state as 'waiting' | 'opened' | 'receiving', bytes: e.bytes ?? 0 } : q));
      } else if (e.state === 'received' && e.result) {
        setPhase({ kind: 'off' });
        void onClipRef.current(e.result.token, e.result.name);
      } else if (e.state === 'closed') {
        if (e.reason === 'received' || e.reason === 'cancelled') setPhase({ kind: 'off' });
        else setPhase({ kind: 'ended', text: ENDED[e.reason ?? ''] ?? 'The phone link closed.' });
      }
    });
    // Adopt a link that is already open (another window, or a page reload).
    void api.phoneStatus().then(({ session }) => {
      if (!dead && session) setPhase((q) => (q.kind === 'off' ? { kind: 'open', session, step: 'waiting', bytes: 0 } : q));
    }).catch(() => {});
    return () => { dead = true; off(); };
  }, []);

  // Countdown only; the server's TTL owns the lifetime.
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sessionId]);

  async function start() {
    setPhase({ kind: 'opening' });
    try {
      const session = await api.phoneStart();
      setNow(Date.now());
      setPhase({ kind: 'open', session, step: 'waiting', bytes: 0 });
    } catch (e) {
      setPhase({ kind: 'error', text: e instanceof Error ? e.message : 'Could not open the phone link' });
    }
  }

  if (phase.kind === 'off' || phase.kind === 'opening') {
    return (
      <button type="button" className="btn sm phone-btn" disabled={phase.kind === 'opening'} onClick={() => void start()}>
        <Icon name="phone" size={14} />{phase.kind === 'opening' ? 'Opening a link...' : 'Use your phone'}
      </button>
    );
  }

  if (phase.kind !== 'open') {
    return (
      <div className="phone-panel">
        <div className="dim" style={{ fontSize: 12.5 }}>{phase.text}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn sm accent" onClick={() => void start()}>New code</button>
          <button type="button" className="btn sm ghost" onClick={() => setPhase({ kind: 'off' })}>Close</button>
        </div>
      </div>
    );
  }

  const { session, step, bytes } = phase;
  const left = Math.max(0, session.expiresAt - now);
  const clock = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
  const net = session.network;
  const isPublic = !!session.public && !!session.pin;
  return (
    <div className="phone-panel">
      <div className="phone-qr"><Qr text={session.url} label="QR code for the phone clip link" /></div>
      {isPublic && session.pin && (
        <div className="phone-pin" title="Enter this code on your phone to unlock the link">
          <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}>PIN</span>
          <span className="mono" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '.3em' }}>{session.pin}</span>
        </div>
      )}
      <div className="phone-status">
        <span className={`dot ${step === 'waiting' ? 'busy' : 'up'}`} />
        <span>
          {step === 'waiting' && 'Scan with your phone camera'}
          {step === 'opened' && 'Phone connected. Film the move.'}
          {step === 'receiving' && `Receiving the clip${bytes ? ` · ${(bytes / 1048576).toFixed(0)} MB` : '...'}`}
        </span>
        <span className="mono dim" style={{ marginLeft: 'auto' }}>{clock}</span>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {isPublic
          ? 'Works on mobile data (over the tunnel). Enter the PIN on your phone. The code works once, for 15 minutes — it stays open if you leave this page.'
          : 'Same Wi-Fi as this computer. The code works once, for 15 minutes — it stays open if you leave this page.'}
      </div>

      {net.warning ? (
        <div className="phone-warn">
          <div>{net.warning}</div>
          <Commands lines={net.commands} />
        </div>
      ) : net.commands.length > 0 && (
        <details className="phone-help">
          <summary>Phone can't connect?</summary>
          <div className="dim" style={{ fontSize: 12, margin: '6px 0' }}>
            Windows may be blocking the port. Allow it once from an elevated PowerShell:
          </div>
          <Commands lines={net.commands} />
        </details>
      )}

      <button type="button" className="btn sm ghost" onClick={() => setPhase({ kind: 'off' })}>Cancel</button>
    </div>
  );
}

// ---------- open the app on your phone ----------

type PairPhase =
  | { kind: 'off' }
  | { kind: 'opening' }
  | { kind: 'open'; session: PairSession; step: 'waiting' | 'linked' }
  | { kind: 'ended'; text: string }
  | { kind: 'error'; text: string };

const PAIR_ENDED: Record<string, string> = {
  expired: 'The pairing expired. Pair again when you want to use the phone.',
  abuse: 'The pairing closed after too many bad requests on the network.',
  replaced: 'The pairing moved to another Morpheus window.',
};

function useNarrow(): boolean {
  const [n, setN] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 600px)');
    const on = () => setN(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return n;
}

export function PhonePair() {
  const [phase, setPhase] = useState<PairPhase>({ kind: 'off' });
  const [now, setNow] = useState(Date.now());
  const sessionId = phase.kind === 'open' ? phase.session.id : null;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const narrow = useNarrow();

  // A pairing is a session, not a one-shot: it stays open when you leave the
  // page, and closes on disconnect or expiry. Follow it at all times — including
  // while at 'off', so a pairing made in another window is adopted here too.
  useEffect(() => {
    let dead = false;
    const off = onPairEvent((e: PairEvent) => {
      const p = phaseRef.current;
      if (p.kind === 'open') {
        if (e.id !== p.session.id) return;
        if (e.state === 'waiting' || e.state === 'linked') setPhase({ kind: 'open', session: p.session, step: e.state });
        else if (e.state === 'closed') setPhase(e.reason === 'cancelled' ? { kind: 'off' } : { kind: 'ended', text: PAIR_ENDED[e.reason ?? ''] ?? 'The phone pairing closed.' });
      } else if (p.kind === 'off' && e.state !== 'closed') {
        void api.pairStatus().then(({ session }) => {
          if (!dead && session) setPhase((q) => (q.kind === 'off' ? { kind: 'open', session, step: e.state === 'linked' ? 'linked' : 'waiting' } : q));
        }).catch(() => {});
      }
    });
    // Adopt a pairing that is already active (opened from another window).
    void api.pairStatus().then(({ session }) => {
      if (!dead && session) setPhase((p) => (p.kind === 'off' ? { kind: 'open', session, step: 'waiting' } : p));
    }).catch(() => {});
    return () => { dead = true; off(); };
  }, []);

  // Countdown only; closing is explicit (Disconnect) or server-side.
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sessionId]);

  async function start() {
    setPhase({ kind: 'opening' });
    try {
      const session = await api.pairStart();
      setNow(Date.now());
      setPhase({ kind: 'open', session, step: 'waiting' });
    } catch (e) {
      setPhase({ kind: 'error', text: e instanceof Error ? e.message : 'Could not open the pairing' });
    }
  }

  function disconnect() {
    const id = sessionId;
    setPhase({ kind: 'off' });
    if (id) void api.pairStop(id).catch(() => {});
  }

  if (phase.kind === 'off' || phase.kind === 'opening') {
    if (narrow) {
      // A QR to "open the app on your phone" is pointless on the phone itself.
      return <div className="dim" style={{ fontSize: 12.5 }}>You are already on the phone — pair it from a desktop screen.</div>;
    }
    return (
      <button type="button" className="btn sm phone-btn" disabled={phase.kind === 'opening'} onClick={() => void start()}>
        <Icon name="phone" size={14} />{phase.kind === 'opening' ? 'Opening the pairing...' : 'Open on your phone'}
      </button>
    );
  }

  if (phase.kind !== 'open') {
    return (
      <div className="phone-panel">
        <div className="dim" style={{ fontSize: 12.5 }}>{phase.text}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn sm accent" onClick={() => void start()}>Pair again</button>
          <button type="button" className="btn sm ghost" onClick={() => setPhase({ kind: 'off' })}>Close</button>
        </div>
      </div>
    );
  }

  const { session, step } = phase;
  const left = Math.max(0, session.expiresAt - now);
  const clock = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
  const net = session.network;
  return (
    <div className="phone-panel">
      {/* pair-qr: hidden on narrow screens (the phone) — the status below stays */}
      <div className="phone-qr pair-qr"><Qr text={session.url} label="QR code to open Morpheus on your phone" /></div>
      <div className="phone-status">
        <span className={`dot ${step === 'waiting' ? 'busy' : 'up'}`} />
        <span>
          {step === 'waiting' && 'Scan with your phone — the whole app opens'}
          {step === 'linked' && 'Phone linked. Use it like a second desktop.'}
        </span>
        <span className="mono dim" style={{ marginLeft: 'auto' }}>{clock}</span>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>Same Wi-Fi as this computer. The pairing lasts an hour, or until you disconnect.</div>

      {net.warning ? (
        <div className="phone-warn">
          <div>{net.warning}</div>
          <Commands lines={net.commands} />
        </div>
      ) : net.commands.length > 0 && (
        <details className="phone-help">
          <summary>Phone can't connect?</summary>
          <div className="dim" style={{ fontSize: 12, margin: '6px 0' }}>
            Windows may be blocking the port. Allow it once from an elevated PowerShell:
          </div>
          <Commands lines={net.commands} />
        </details>
      )}

      <button type="button" className="btn sm ghost" onClick={disconnect}>Disconnect</button>
    </div>
  );
}

/** Top-bar chip while a phone pairing is live, so it can be managed from Setup. */
export function PairChip() {
  const [live, setLive] = useState(false);
  useEffect(() => {
    let dead = false;
    const sync = () => {
      void api.pairStatus().then(({ session }) => { if (!dead) setLive(!!session); }).catch(() => {});
    };
    sync();
    const off = onPairEvent((e) => {
      if (e.state === 'closed') setLive(false);
      else sync();
    });
    return () => { dead = true; off(); };
  }, []);
  if (!live) return null;
  return (
    <a className="nav-link pair-chip" {...linkProps('/setup')} title="A phone is paired — Setup > Phone to disconnect">
      <span className="dot up" />phone
    </a>
  );
}
