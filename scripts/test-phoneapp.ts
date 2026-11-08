/**
 * Exercises the pairing proxy (server/phoneApp.ts) on its own: no Morpheus
 * server, no ComfyUI. The upstream is a fake app: an HTTP echo plus a
 * websocket echo on /live.
 *
 *   npx tsx scripts/test-phoneapp.ts
 */
import { createServer } from 'http';
import net from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { closePairSession, openPairSession, type PairSessionInfo, type PairState } from '../server/phoneApp.js';

const UP = 3176;
const PORT = 3177;
const UPSTREAM = `http://127.0.0.1:${UP}`;
let fails = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) fails++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- fake upstream app ----
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url?.startsWith('/api/echo')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        x: req.headers['x-test'] ?? null,
        origin: req.headers.origin ?? null,
        host: req.headers.host,
        body: body.toString('utf8'),
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`UPSTREAM ${req.url}`);
  });
});
const wss = new WebSocketServer({ noServer: true });
upstream.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/live')) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.on('message', (m) => ws.send(`echo:${m}`)); });
});
await new Promise<void>((r) => upstream.listen(UP, '127.0.0.1', () => r()));

const states: PairState[] = [];
const open = (o: { ttlMs?: number } = {}) =>
  openPairSession({ port: PORT, host: '127.0.0.1', upstream: UPSTREAM, ...o, onState: (_id, st) => states.push(st) });
// One-shot connections: a replaced session destroys its pooled keep-alive
// sockets, and reusing one of them mid-flight would ECONNRESET for no reason.
const f = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), connection: 'close' } });
const refused = async (url: string) => {
  try { await f(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' }); return false; } catch { return true; }
};
const tokenOf = (s: PairSessionInfo) => s.url.split('/pair/')[1];
const wsOk = (headers: Record<string, string>) => new Promise<boolean>((resolve) => {
  let settled = false;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers });
  const done = (v: boolean) => { if (settled) return; settled = true; try { ws.terminate(); } catch { /* gone */ } resolve(v); };
  ws.on('open', () => ws.send('ping'));
  ws.on('message', (m) => done(m.toString() === 'echo:ping'));
  ws.on('error', () => done(false));
  setTimeout(() => done(false), 3000);
});

// ---- 1. gate, proxy, websocket ----
let s = await open({ ttlMs: 60_000 });
console.log(`session ${s.id} on ${s.url}`);
const token = tokenOf(s);
const base = s.url.replace(/\/pair\/.*$/, '');
const cookie = { cookie: `morpheus_pair=${token}` };

ok(/^http:\/\/[\d.]+:3177\/pair\/[A-Za-z0-9_-]{43}$/.test(s.url), 'URL carries a 256-bit base64url token');
ok((await f(`${base}/`, { redirect: 'manual' })).status === 404, 'no cookie -> 404');
ok((await f(`${base}/pair/wrong`, { redirect: 'manual' })).status === 404, 'wrong token -> 404');
const pair = await f(`${base}/pair/${token}`, { redirect: 'manual' });
ok(pair.status === 302 && pair.headers.get('location') === '/', 'pair -> 302 to /');
ok(/morpheus_pair=/.test(pair.headers.get('set-cookie') ?? ''), 'pair sets the pairing cookie');
ok((pair.headers.get('set-cookie') ?? '').includes('HttpOnly'), 'cookie is HttpOnly');
ok(pair.headers.get('referrer-policy') === 'no-referrer', 'pair sends Referrer-Policy: no-referrer');

let r = await f(`${base}/`, { headers: cookie });
ok(r.status === 200 && (await r.text()) === 'UPSTREAM /', 'cookie -> the app is proxied');
r = await f(`${base}/api/echo`, { method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json', 'x-test': 'hi', origin: base, referer: `${base}/x` }, body: '{"a":1}' });
const echoed = (await r.json()) as { x: string | null; origin: string | null; host: string; body: string };
ok(r.status === 200 && echoed.body === '{"a":1}' && echoed.x === 'hi', 'POST body and headers proxied');
ok(echoed.origin === null, 'the phone Origin is stripped (the app would 403 it)');
ok(String(echoed.host).startsWith('127.0.0.1'), 'Host is rewritten to the upstream');
ok((await f(`${base}/`, { headers: { cookie: 'morpheus_pair=AAAA' }, redirect: 'manual' })).status === 404, 'wrong cookie -> 404');
ok(states.some((x) => x.state === 'linked'), "state 'linked' emitted");
ok(await wsOk(cookie), 'websocket /live is proxied with the cookie');
ok(!(await wsOk({})), 'websocket /live is refused without the cookie');

// ---- 2. expiry ----
s = await open({ ttlMs: 1200 });
ok((await f(s.url, { redirect: 'manual' })).status === 302, 'short-lived session answers before expiry');
await sleep(1800);
ok(states.at(-1)?.state === 'closed' && (states.at(-1) as PairState & { reason?: string }).reason === 'expired', "state 'closed: expired' after the TTL");
ok(await refused(`${base}/`), 'listener is gone after expiry');

// ---- 3. a new session invalidates the old cookie ----
const first = await open();
const second = await open();
ok(first.url !== second.url, 'every session gets a fresh token');
ok((await f(`${base}/`, { headers: { cookie: `morpheus_pair=${tokenOf(first)}` }, redirect: 'manual' })).status === 404, 'the previous cookie is dead once a new session opens');
ok((await f(`${base}/`, { headers: { cookie: `morpheus_pair=${tokenOf(second)}` }, redirect: 'manual' })).status === 200, 'the new cookie works');
closePairSession('cancelled');

// ---- 4. guessing gets the listener shut ----
await open();
for (let i = 0; i < 30; i++) await f(`${base}/guess${i}`).catch(() => {});
await sleep(100);
ok(states.at(-1)?.state === 'closed' && (states.at(-1) as PairState & { reason?: string }).reason === 'abuse', '30 bad requests close the session');
ok(await refused(`${base}/`), 'listener is gone after too many guesses');

// ---- 5. abrupt disconnects must not kill the listener ----
// 2026-11-07: a client RST mid-websocket emitted an unhandled 'error' on a raw
// socket and took the whole server down. Each of these must leave it serving.
s = await open();
const c5 = { cookie: `morpheus_pair=${tokenOf(s)}` };
await new Promise<void>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers: c5 });
  ws.on('open', () => ws.terminate()); // RST, no close frame
  ws.on('error', () => {});
  setTimeout(resolve, 150);
});
await sleep(200);
ok((await f(`${base}/`, { headers: c5, redirect: 'manual' })).status === 200, 'listener survives a client RST mid-websocket');
await new Promise<void>((resolve) => {
  const sock = net.connect(PORT, '127.0.0.1');
  sock.on('connect', () => sock.write('POST /api/echo HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{"a":1'));
  sock.on('error', () => {});
  setTimeout(() => { sock.destroy(); resolve(); }, 150); // vanish mid-body
});
await sleep(200);
ok((await f(`${base}/`, { headers: c5, redirect: 'manual' })).status === 200, 'listener survives a request dying mid-body');
upstream.close(); // stop listening: new connections now ECONNREFUSE
await sleep(150);
ok((await f(`${base}/`, { headers: c5, redirect: 'manual' })).status === 502, 'upstream down -> 502, not a dead listener');
await new Promise<void>((r) => upstream.listen(UP, '127.0.0.1', () => r()));
ok((await f(`${base}/`, { headers: c5, redirect: 'manual' })).status === 200, 'serves again once the upstream is back');

// ---- 6. explicit cancel ----
await open();
closePairSession('cancelled');
ok(await refused(`${base}/`), 'cancel closes the listener');

upstream.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
