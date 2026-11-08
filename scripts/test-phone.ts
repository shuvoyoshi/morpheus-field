/**
 * Exercises the phone LAN listener (server/phone.ts) on its own: no Morpheus
 * server, no ComfyUI. Accepted clips go to an in-memory callback.
 *
 *   npx tsx scripts/test-phone.ts <sample.mp4> [port]
 *
 * Opens a real listener on this machine's LAN address for a few seconds.
 */
import { readFileSync } from 'fs';
import { closePhoneSession, openPhoneSession, type PhoneClip, type PhoneSessionInfo, type PhoneState } from '../server/phone.js';

const sample = process.argv[2];
const port = Number(process.argv[3] || 3199);
if (!sample) { console.error('usage: tsx scripts/test-phone.ts <sample.mp4> [port]'); process.exit(2); }
const mp4 = readFileSync(sample);

let fails = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) fails++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let clips: PhoneClip[] = [];
let states: PhoneState[] = [];
async function open(o: { ttlMs?: number; maxBytes?: number } = {}): Promise<PhoneSessionInfo> {
  clips = [];
  states = [];
  return openPhoneSession({
    port, ...o,
    onClip: async (c) => { clips.push(c); return { token: 'asset:test' }; },
    onState: (_id, s) => { states.push(s); },
  });
}
const post = (url: string, body: Buffer, type = 'video/mp4', headers: Record<string, string> = {}) =>
  fetch(`${url}/upload`, { method: 'POST', body: new Uint8Array(body), headers: { 'Content-Type': type, 'X-Filename': 'take one.mp4', ...headers } });
const refused = async (url: string) => {
  try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return false; } catch { return true; }
};

// ---- 1. page, token gate, validation, happy path ----
let s = await open({ maxBytes: 2 * 1024 * 1024 });
console.log(`session ${s.id} on ${s.url}`);
console.log(`network: ${JSON.stringify(s.network)}`);
ok(/^http:\/\/[\d.]+:\d+\/p\/[A-Za-z0-9_-]{43}$/.test(s.url), 'URL carries a 256-bit base64url token');
ok(s.network.bindHost !== '127.0.0.1' && s.network.bindHost !== '0.0.0.0', `binds one LAN interface (${s.network.bindHost}), not all`);

let r = await fetch(s.url);
const html = await r.text();
ok(r.status === 200 && html.includes('Film the move') && html.includes('capture="environment"'), 'GET page with token -> 200 mobile page');
ok(!html.includes('__MAX_BYTES__') && html.includes(String(2 * 1024 * 1024)), 'page has the size cap filled in');
ok((r.headers.get('content-security-policy') || '').includes("default-src 'none'"), 'page sends a locked-down CSP');
ok(r.headers.get('referrer-policy') === 'no-referrer', 'page sends Referrer-Policy: no-referrer');

const base = s.url.replace(/\/p\/.*$/, '');
const wrong = s.url.slice(0, -4) + (s.url.endsWith('AAAA') ? 'BBBB' : 'AAAA');
ok((await fetch(wrong)).status === 404, 'GET with a wrong token -> 404');
ok((await fetch(`${base}/`)).status === 404, 'GET / -> 404');
ok((await fetch(`${base}/p/`)).status === 404, 'GET /p/ -> 404');
ok((await post(wrong, mp4)).status === 404, 'POST upload with a wrong token -> 404');
ok((await fetch(`${s.url}/upload`)).status === 405, 'GET on the upload path -> 405');
ok((await post(s.url, mp4, 'text/plain')).status === 415, 'POST with a non-video Content-Type -> 415');
ok((await post(s.url, Buffer.from('<html>not a video at all, honest</html>'), 'video/mp4')).status === 415, 'POST video/mp4 that is not a video (magic bytes) -> 415');
r = await post(s.url, Buffer.alloc(3 * 1024 * 1024, 0), 'video/mp4');
ok(r.status === 413, 'POST over the size cap -> 413');
ok(clips.length === 0, 'nothing reached onClip from rejected uploads');

r = await post(s.url, mp4);
ok(r.status === 200, `POST real mp4 (${mp4.length} bytes) -> 200`);
ok(clips.length === 1 && clips[0].data.equals(mp4), 'onClip got the exact bytes');
ok(clips[0]?.ext === 'mp4' && clips[0]?.mime === 'video/mp4', 'container sniffed as mp4');
ok(clips[0]?.name === 'take one.mp4', 'filename header decoded and sanitized');
ok(states.some((x) => x.state === 'received'), "state 'received' emitted");
await sleep(500);
ok(states.at(-1)?.state === 'closed' && (states.at(-1) as any).reason === 'received', 'session closes itself after the upload');
ok(await refused(s.url), 'listener is gone: the page no longer answers');
ok(await refused(`${s.url}/upload`), 'token is spent: replaying the upload cannot connect');

// ---- 2. expiry ----
s = await open({ ttlMs: 1200 });
ok((await fetch(s.url)).status === 200, 'short-lived session answers before expiry');
await sleep(1800);
ok(states.at(-1)?.state === 'closed' && (states.at(-1) as any).reason === 'expired', "state 'closed: expired' after the TTL");
ok(await refused(s.url), 'listener is gone after expiry');

// ---- 3. a new session invalidates the old token ----
const first = await open();
const second = await open();
ok(first.url !== second.url, 'every session gets a fresh token');
ok((await fetch(first.url)).status === 404, 'the previous token is dead once a new session opens');
ok((await fetch(second.url)).status === 200, 'the new token works');

// ---- 4. guessing gets the listener shut ----
for (let i = 0; i < 30; i++) await fetch(`${base}/p/guess${i}`).catch(() => {});
await sleep(100);
ok(states.at(-1)?.state === 'closed' && (states.at(-1) as any).reason === 'abuse', '30 bad requests close the session');
ok(await refused(second.url), 'listener is gone after too many guesses');

// ---- 5. explicit cancel ----
s = await open();
closePhoneSession('cancelled');
ok(await refused(s.url), 'cancel closes the listener');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
