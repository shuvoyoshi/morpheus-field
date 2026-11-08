/**
 * "Open on your phone": pair a phone's browser with this desktop session.
 *
 * Like the clip drop box (server/phone.ts), the main server stays on loopback
 * and has no authentication, so nothing of it is put on the network. Instead,
 * while a pairing session is open, this module runs a second tiny LAN listener
 * that reverse-proxies the whole app (UI, /api, /live websocket) to the
 * upstream origin. The phone's browser is then a second desktop: it can browse
 * the library, watch renders live, and queue work.
 *
 * The gate is a cookie, not a path prefix, so the app code needs no changes:
 *
 *   GET /pair/<token>   verify the token from the QR URL, set the cookie, 302 to /
 *   anything else       valid pairing cookie required, then proxy upstream
 *
 * The token is 32 random bytes. It lives in the QR URL and the cookie; nothing
 * else reveals it. The listener shuts down on expiry, on too many bad
 * requests, when the desktop disconnects, or when a new pairing replaces it.
 *
 * Nothing in here reads config.ts so it can be exercised in isolation
 * (see scripts/test-phoneapp.ts).
 */
import { createServer, request, type IncomingMessage, type IncomingHttpHeaders, type Server, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { detectNetwork, fmtHost, type PhoneNetwork } from './lan.js';

export type PairState =
  | { state: 'waiting' }
  | { state: 'linked' }
  | { state: 'closed'; reason: 'expired' | 'cancelled' | 'abuse' | 'replaced' };

export interface PairSessionInfo {
  /** Public session id (not the secret). The desktop matches live events on it. */
  id: string;
  /** The QR url: opens the app and sets the pairing cookie. */
  url: string;
  expiresAt: number;
  port: number;
  /** The app origin this listener proxies to (UI + /api + /live). */
  upstream: string;
  network: PhoneNetwork;
}

export interface PairOptions {
  port: number;
  /** Bind/advertise this address instead of auto-detecting one. */
  host?: string;
  upstream: string;
  ttlMs?: number;
  onState: (id: string, s: PairState) => void;
}

/** One hour: the phone is using the app, not sending one clip. */
const DEFAULT_TTL = 60 * 60_000;
const MAX_BAD_REQUESTS = 30;
const COOKIE = 'morpheus_pair';
// Hop-by-hop headers (RFC 7230) plus the ones the app would misread: its
// Origin/Host checks must see a plain loopback request, not the phone's.
const STRIP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'host', 'origin', 'referer', 'cookie',
]);

interface Session {
  info: PairSessionInfo;
  token: Buffer;
  tokenStr: string;
  server: Server;
  timer: NodeJS.Timeout;
  bad: number;
  linked: boolean;
  upstream: { protocol: string; hostname: string; port: number; host: string };
  opts: PairOptions;
}

let current: Session | null = null;

export function pairSession(): PairSessionInfo | null {
  return current?.info ?? null;
}

/** Open a session (closing any previous one) and start the LAN listener. */
export async function openPairSession(opts: PairOptions): Promise<PairSessionInfo> {
  if (current) closePairSession('replaced');
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const network = await detectNetwork(opts.host, opts.port, 'Morpheus phone app');
  const up = new URL(opts.upstream);
  const token = randomBytes(32);
  const id = randomBytes(8).toString('hex');
  const tokenStr = token.toString('base64url');

  const server = createServer((req, res) => handle(req, res));
  server.maxConnections = 32;
  server.headersTimeout = 15_000;
  server.requestTimeout = ttl; // uploads from the phone may take their time
  server.keepAliveTimeout = 5_000;
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket as Socket, head));

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(
        e.code === 'EADDRINUSE'
          ? `Port ${opts.port} is taken. Set OPENFIELD_PHONE_APP_PORT to a free port.`
          : e.code === 'EADDRNOTAVAIL'
            ? `${network.bindHost} is not an address on this machine. Check OPENFIELD_PHONE_HOST.`
            : `Could not open the phone pairing: ${e.message}`,
      ));
    });
    server.listen(opts.port, network.bindHost, () => resolve());
  });

  const expiresAt = Date.now() + ttl;
  const s: Session = {
    info: { id, url: `http://${fmtHost(network.urlHost)}:${opts.port}/pair/${tokenStr}`, expiresAt, port: opts.port, upstream: opts.upstream, network },
    token,
    tokenStr,
    server,
    timer: setTimeout(() => closePairSession('expired'), ttl),
    bad: 0,
    linked: false,
    upstream: { protocol: up.protocol, hostname: up.hostname, port: Number(up.port) || (up.protocol === 'https:' ? 443 : 80), host: up.host },
    opts,
  };
  s.timer.unref();
  current = s;
  opts.onState(id, { state: 'waiting' });
  return s.info;

  function tokenOk(candidate: string): boolean {
    const b = Buffer.from(candidate, 'base64url');
    return b.length === s.token.length && timingSafeEqual(b, s.token);
  }

  function cookieOk(req: IncomingMessage): boolean {
    const c = req.headers.cookie;
    if (typeof c !== 'string') return false;
    const m = /(?:^|;\s*)morpheus_pair=([A-Za-z0-9_-]{1,128})/.exec(c);
    if (!m) return false;
    return tokenOk(m[1]);
  }

  function bad(res: ServerResponse, req: IncomingMessage) {
    if (++s.bad >= MAX_BAD_REQUESTS) setImmediate(() => closePairSession('abuse'));
    req.resume();
    return send(res, 404, { error: 'Not found' });
  }

  function fwdHeaders(h: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
    const out: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined || STRIP.has(k.toLowerCase())) continue;
      out[k] = v;
    }
    out.host = s.upstream.host;
    return out;
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    // Requests that arrive on a socket accepted just before close still land here.
    if (current !== s) { req.resume(); return send(res, 410, { error: 'This link is closed.' }); }
    const path = (req.url || '').split('?')[0];
    if (path.startsWith('/pair/')) {
      const m = /^\/pair\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if (!m || !tokenOk(m[1])) return bad(res, req);
      if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return send(res, 405, { error: 'Method not allowed' }); }
      if (!s.linked) { s.linked = true; opts.onState(id, { state: 'linked' }); }
      res.writeHead(302, {
        Location: '/',
        // The cookie carries the secret from here on; the URL does not.
        'Set-Cookie': `${COOKIE}=${s.tokenStr}; Path=/; HttpOnly; SameSite=Lax`,
        'Cache-Control': 'no-store',
        // The token is in the URL; keep it out of Referer headers and other origins.
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end();
    }
    if (!cookieOk(req)) return bad(res, req);
    proxy(req, res);
  }

  function proxy(req: IncomingMessage, res: ServerResponse) {
    const upReq = request({
      protocol: s.upstream.protocol,
      hostname: s.upstream.hostname,
      port: s.upstream.port,
      method: req.method,
      path: req.url, // path + query, verbatim
      headers: fwdHeaders(req.headers),
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, fwdHeaders(upRes.headers));
      // An unhandled 'error' on either side of this pipe takes the whole
      // server down: tie the two ends together so an abrupt disconnect on one
      // tears the other down quietly instead of throwing.
      upRes.on('error', () => res.destroy());
      res.on('close', () => { if (!res.writableEnded) upReq.destroy(); });
      upRes.pipe(res);
    });
    upReq.on('error', (e) => {
      if (!res.headersSent) send(res, 502, { error: `The app did not answer: ${e instanceof Error ? e.message : 'unknown error'}` });
      else res.end();
    });
    // The client vanishing mid-body must tear down the upstream request, not
    // leave it hanging (or throw on the raw socket).
    req.on('error', () => upReq.destroy());
    req.on('close', () => { if (!req.readableEnded) upReq.destroy(); });
    req.pipe(upReq);
  }

  function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    if (current !== s) { socket.write('HTTP/1.1 410 Gone\r\n\r\n'); return socket.destroy(); }
    if (!/websocket/i.test(req.headers.upgrade ?? '')) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    if (!cookieOk(req)) {
      if (++s.bad >= MAX_BAD_REQUESTS) setImmediate(() => closePairSession('abuse'));
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    const upReq = request({
      protocol: s.upstream.protocol,
      hostname: s.upstream.hostname,
      port: s.upstream.port,
      method: req.method,
      path: req.url,
      headers: { ...fwdHeaders(req.headers), connection: 'upgrade', upgrade: 'websocket' },
    });
    let up: Socket | null = null;
    // A client that RSTs (tab closed, network blip) emits 'error' on these
    // raw sockets; without handlers Node kills the process. Keep the two
    // sides paired so either death is handled on both.
    socket.on('error', () => { upReq.destroy(); up?.destroy(); });
    socket.on('close', () => { upReq.destroy(); up?.destroy(); });
    upReq.on('upgrade', (upRes, upSocket) => {
      up = upSocket;
      upSocket.on('error', () => socket.destroy());
      upSocket.on('close', () => socket.destroy());
      let headOut = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        headOut += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
      }
      headOut += '\r\n';
      socket.write(headOut);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upReq.on('error', () => { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.destroy(); });
    upReq.end();
  }
}

/** Close the current session and its listener. Safe to call when none is open. */
export function closePairSession(reason: 'expired' | 'cancelled' | 'abuse' | 'replaced' = 'cancelled') {
  const s = current;
  if (!s) return;
  current = null;
  clearTimeout(s.timer);
  s.server.close();
  s.server.closeAllConnections();
  s.opts.onState(s.info.id, { state: 'closed', reason });
}

function send(res: ServerResponse, code: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
