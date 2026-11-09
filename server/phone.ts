/**
 * "Film it on your phone": a one-shot LAN drop box for a single clip.
 *
 * The main Morpheus server binds loopback and has no authentication, so it is
 * never put on the network. Instead, while a phone session is open, this module
 * runs a second, deliberately tiny HTTP listener on the LAN interface that
 * answers exactly two requests:
 *
 *   GET  /p/<token>          the mobile page
 *   POST /p/<token>/upload   one video, raw body (no multipart)
 *
 * Everything else is a 404. The token is 32 random bytes, lives only in the QR
 * URL, and is spent by the first successful upload. The listener shuts itself
 * down after that upload, on expiry, on too many bad requests, or when the
 * desktop closes the session. It never touches the filesystem or the database:
 * accepted bytes go to the `onClip` callback, and the caller decides what to do.
 *
 * Nothing in here reads config.ts so it can be exercised in isolation
 * (see scripts/test-phone.ts). LAN detection is shared with the pairing
 * proxy in server/lan.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { detectNetwork, fmtHost, type PhoneNetwork } from './lan.js';

export { detectNetwork, pickLanAddress, type PhoneNetwork } from './lan.js';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, 'phone.html'), 'utf8');
// The page is served from this listener's own port, so a /logo/... URL would 404
// (in dev the UI is on the Vite port); the CSP allows data: for images, so inline
// the mark instead. The full mark is 1.2 MB — too heavy for a phone on Wi-Fi — so
// inline the 96px variant when it exists (it is displayed at 20px). If the file
// is ever missing the page hides the empty slot.
const LOGO_DIR = join(here, '..', 'public', 'logo');
const LOGO_PATH = existsSync(join(LOGO_DIR, 'muilogo-96.png'))
  ? join(LOGO_DIR, 'muilogo-96.png')
  : join(LOGO_DIR, 'muilogo.png');
const LOGO = existsSync(LOGO_PATH) ? `data:image/png;base64,${readFileSync(LOGO_PATH).toString('base64')}` : '';

export interface PhoneClip { data: Buffer; mime: string; ext: 'mp4' | 'mov' | 'webm'; name: string }

export type PhoneState =
  | { state: 'waiting' }
  | { state: 'opened' }
  | { state: 'receiving'; bytes: number }
  | { state: 'received'; result: unknown }
  | { state: 'closed'; reason: 'received' | 'expired' | 'cancelled' | 'abuse' | 'replaced' };

export interface PhoneSessionInfo {
  /** Public session id (not the secret). The desktop matches live events on it. */
  id: string;
  url: string;
  expiresAt: number;
  port: number;
  maxBytes: number;
  network: PhoneNetwork;
  /** The auth PIN for public/mobile-data mode, or null for LAN (token-only) mode. */
  pin: string | null;
  /** True when the link is exposed over the internet (a tunnel), not just the LAN. */
  public: boolean;
}

export interface PhoneOptions {
  port: number;
  /** Bind/advertise this address instead of auto-detecting one. */
  host?: string;
  /**
   * Public base URL of a tunnel (e.g. https://xyz.trycloudflare.com) for
   * mobile-data access. When set, the link is reachable from the internet, the
   * listener binds loopback (the tunnel connects locally), and a PIN is required.
   */
  publicUrl?: string;
  /** The auth PIN for public mode. If publicUrl is set and this is omitted, one is generated. */
  pin?: string;
  ttlMs?: number;
  maxBytes?: number;
  /** Store the clip. Its return value is passed through to the 'received' state. Throwing keeps the session open. */
  onClip: (clip: PhoneClip) => Promise<unknown>;
  onState: (id: string, s: PhoneState) => void;
}

/** Fifteen minutes: long enough to find a clip on the phone and send it, short enough to not linger. */
const DEFAULT_TTL = 15 * 60_000;
const DEFAULT_MAX = 300 * 1024 * 1024;
const MAX_BAD_REQUESTS = 30;

interface Session {
  info: PhoneSessionInfo;
  token: Buffer;
  server: Server;
  timer: NodeJS.Timeout;
  uploading: boolean;
  bad: number;
  opts: PhoneOptions;
}

let current: Session | null = null;

export function phoneSession(): PhoneSessionInfo | null {
  return current?.info ?? null;
}

/** Open a session (closing any previous one) and start the LAN listener. */
export async function openPhoneSession(opts: PhoneOptions): Promise<PhoneSessionInfo> {
  if (current) closePhoneSession('replaced');
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
  // Public/mobile-data mode: the link is exposed through a tunnel, so the phone
  // can reach it off the LAN. We bind loopback (only the local tunnel can get
  // in) and require a PIN, because the URL is now on the open internet.
  const isPublic = !!opts.publicUrl;
  const pin = isPublic ? (opts.pin ?? makePin()) : null;
  const network = isPublic
    ? { wsl: 'none' as const, bindHost: opts.host ?? '127.0.0.1', urlHost: '', warning: null, commands: [] }
    : await detectNetwork(opts.host, opts.port);
  const token = randomBytes(32);
  const id = randomBytes(8).toString('hex');
  const tokenStr = token.toString('base64url');
  const url = isPublic
    ? `${opts.publicUrl!.replace(/\/+$/, '')}/p/${tokenStr}`
    : `http://${fmtHost(network.urlHost)}:${opts.port}/p/${tokenStr}`;

  const server = createServer((req, res) => handle(req, res));
  // Slowloris and parked sockets: nothing about this needs more than a few clients.
  server.maxConnections = 16;
  server.headersTimeout = 15_000;
  // A 300 MB clip over slow Wi-Fi can take well over the session TTL; never
  // abort an upload just because the link expired — only the TTL itself and an
  // explicit cancel end the session.
  server.requestTimeout = Math.max(ttl, 30 * 60_000);
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(
        e.code === 'EADDRINUSE'
          ? `Port ${opts.port} is taken. Set OPENFIELD_PHONE_PORT to a free port.`
          : e.code === 'EADDRNOTAVAIL'
            ? `${network.bindHost} is not an address on this machine. Check OPENFIELD_PHONE_HOST.`
            : `Could not open the phone listener: ${e.message}`,
      ));
    });
    server.listen(opts.port, network.bindHost, () => resolve());
  });

  const expiresAt = Date.now() + ttl;
  const s: Session = {
    info: { id, url, expiresAt, port: opts.port, maxBytes, network, pin, public: isPublic },
    token,
    server,
    timer: setTimeout(() => expire(s), ttl),
    uploading: false,
    bad: 0,
    opts,
  };
  s.timer.unref();
  current = s;
  opts.onState(id, { state: 'waiting' });
  return s.info;

  function handle(req: IncomingMessage, res: ServerResponse) {
    // Requests that arrive on a socket accepted just before close still land here.
    if (current !== s) return send(res, 410, { error: 'This link is closed.' });
    const m = /^\/p\/([A-Za-z0-9_-]{1,64})(\/(upload|check))?$/i.exec((req.url || '').split('?')[0]);
    if (!m || !tokenOk(m[1])) {
      if (++s.bad >= MAX_BAD_REQUESTS) setImmediate(() => closePhoneSession('abuse'));
      req.resume();
      return send(res, 404, { error: 'Not found' });
    }
    if (!m[2] && req.method === 'GET') {
      opts.onState(id, { state: 'opened' });
      const html = PAGE
        .replace('__LOGO__', LOGO)
        .replace('__MAX_BYTES__', String(maxBytes))
        .replace('__EXPIRES_AT__', String(expiresAt))
        .replace('__PIN_REQUIRED__', String(!!pin));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // The token is in the URL; keep it out of Referer headers and other origins.
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src blob:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      return res.end(html);
    }
    if (m[3] === 'check' && req.method === 'POST') {
      // Let the phone confirm the PIN before it films, so a wrong code is caught
      // up front rather than after the clip is already recorded.
      req.resume();
      if (pin && !pinOk(String(req.headers['x-pin'] || ''), pin)) {
        return send(res, 401, { error: 'Wrong PIN. Check the code on your computer.' });
      }
      return send(res, 200, { ok: true });
    }
    if (m[3] === 'upload' && req.method === 'POST') {
      if (pin && !pinOk(String(req.headers['x-pin'] || ''), pin)) {
        req.resume();
        return send(res, 401, { error: 'Wrong PIN. Check the code on your computer.' });
      }
      return void upload(req, res);
    }
    req.resume();
    return send(res, 405, { error: 'Method not allowed' });
  }

  function tokenOk(candidate: string): boolean {
    const b = Buffer.from(candidate, 'base64url');
    return b.length === token.length && timingSafeEqual(b, token);
  }

  /** Expiry that never yanks the socket out from under a clip still on its way. */
  function expire(s: Session): void {
    if (current !== s) return;
    if (s.uploading) {
      s.timer = setTimeout(() => expire(s), 30_000);
      return;
    }
    closePhoneSession('expired');
  }

  async function upload(req: IncomingMessage, res: ServerResponse) {
    if (s.uploading) { req.resume(); return send(res, 409, { error: 'A clip is already on its way.' }); }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('video/')) { req.resume(); return send(res, 415, { error: 'That is not a video file.' }); }
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= 0) { req.resume(); return send(res, 411, { error: 'Missing file size.' }); }
    if (declared > maxBytes) { req.resume(); return send(res, 413, { error: `Clip is over ${Math.round(maxBytes / 1048576)} MB. Film a shorter take.` }); }

    s.uploading = true;
    const chunks: Buffer[] = [];
    let got = 0;
    let lastReport = 0;
    let failed = false;
    opts.onState(id, { state: 'receiving', bytes: 0 });
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        got += chunk.length;
        // Content-Length is the client's word; enforce the cap on actual bytes.
        if (got > declared || got > maxBytes) { failed = true; break; }
        chunks.push(chunk);
        if (got - lastReport > 4 * 1048576) { lastReport = got; opts.onState(id, { state: 'receiving', bytes: got }); }
      }
    } catch {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      return; // client went away mid-upload; let them retry
    }
    if (failed || got !== declared) {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      res.setHeader('Connection', 'close');
      return send(res, failed ? 413 : 400, { error: failed ? 'Clip is larger than it said it was.' : 'Upload was cut short. Try again.' });
    }
    const data = Buffer.concat(chunks);
    const ext = sniffVideo(data);
    if (!ext) {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      return send(res, 415, { error: 'That file is not an MP4, MOV or WebM video.' });
    }
    const rawName = decodeName(req.headers['x-filename']);
    try {
      // Label the bytes by what they are, not by what the phone said.
      const realMime = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
      const result = await opts.onClip({ data, mime: realMime, ext, name: rawName || `phone.${ext}` });
      send(res, 200, { ok: true });
      opts.onState(id, { state: 'received', result });
      // Spent: the token cannot be used again. Give the 200 time to actually
      // reach the phone (a lossy Wi-Fi link can lose it to the socket teardown
      // otherwise), then take the listener down.
      setTimeout(() => { if (current === s) closePhoneSession('received'); }, 1500);
    } catch (e) {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      send(res, 500, { error: `Morpheus could not keep the clip: ${e instanceof Error ? e.message : 'unknown error'}` });
    }
  }
}

/** Close the current session and its listener. Safe to call when none is open. */
export function closePhoneSession(reason: 'received' | 'expired' | 'cancelled' | 'abuse' | 'replaced' = 'cancelled') {
  const s = current;
  if (!s) return;
  current = null;
  clearTimeout(s.timer);
  s.server.close();
  s.server.closeAllConnections();
  s.opts.onState(s.info.id, { state: 'closed', reason });
}

/** A 6-digit code, shown on the desktop and entered on the phone (public mode). */
function makePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Constant-time PIN compare. Length is fixed (6 digits), so the guard is only a
 *  safety net against a malformed header. */
function pinOk(provided: string, pin: string): boolean {
  const p = provided.trim();
  if (p.length !== pin.length) return false;
  return timingSafeEqual(Buffer.from(p), Buffer.from(pin));
}

function send(res: ServerResponse, code: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function decodeName(h: string | string[] | undefined): string {
  if (typeof h !== 'string') return '';
  let s = h;
  try { s = decodeURIComponent(h); } catch { /* keep raw */ }
  return s.replace(/[^\w.\- ]+/g, '').slice(0, 80);
}

/** Container from magic bytes, not from what the client claims. */
export function sniffVideo(b: Buffer): PhoneClip['ext'] | null {
  if (b.length < 12) return null;
  if (b.readUInt32BE(0) === 0x1a45dfa3) return 'webm'; // EBML (WebM / Matroska)
  const atom = b.toString('latin1', 4, 8);
  if (atom === 'ftyp') return b.toString('latin1', 8, 12) === 'qt  ' ? 'mov' : 'mp4';
  // Older QuickTime files can open with another top-level atom before ftyp/moov.
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(atom)) return 'mov';
  return null;
}
