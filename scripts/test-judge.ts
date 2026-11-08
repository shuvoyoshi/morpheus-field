/**
 * Judge mode checks, no GPU needed: `npm run test:judge`.
 *
 * Part 1 tests the pure pieces of server/judge.ts (session cookie, password
 * check, login limiter, daily cap, body limits). Part 2 starts real servers on
 * 127.0.0.1 (ports 3197 to 3199) pointed at an engine address where nothing
 * answers, and checks sign-in on the API, the UI and the /live socket, the cap
 * (OPENFIELD_JUDGE_CAP=0 must answer 429 before any engine work), the refused
 * routes, the login rate limit, and that the non-judge server still refuses a
 * foreign Host. Every server is stopped by PID at the end.
 */
import assert from 'assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { ROOT } from '../server/config.js';
import {
  JUDGE_COOKIE, JUDGE_MAX_SECONDS, cookieOf, limitRenderBody, limitRequest, loginLimiter, passwordMatches, renderCap, signSession, verifySession,
} from '../server/judge.js';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'openfield-judge-test-'));

// ------------------------------------------------------------ part 1 ----
console.log('\nJudge mode, unit checks');

const PW = 'test-password-123';

await check('a signed session verifies', () => assert.ok(verifySession(PW, signSession(PW))));
await check('a session signed with another password does not', () => assert.ok(!verifySession(PW, signSession('another-password'))));
await check('an expired session does not', () => assert.ok(!verifySession(PW, signSession(PW, Date.now() - 8 * 86_400_000))));
await check('a tampered expiry does not', () => {
  const [, sig] = signSession(PW).split('.');
  assert.ok(!verifySession(PW, `${Date.now() + 99 * 86_400_000}.${sig}`));
});
await check('junk values do not', () => {
  for (const v of [undefined, '', '.', 'abc', '123', '123.', `${Date.now() + 1e6}.short`]) assert.ok(!verifySession(PW, v));
});
await check('password check', () => {
  assert.ok(passwordMatches(PW, PW));
  assert.ok(!passwordMatches(PW, PW + 'x'));
  assert.ok(!passwordMatches(PW, ''));
  assert.ok(!passwordMatches(PW, undefined));
  assert.ok(!passwordMatches(PW, { toString: () => PW }));
});
await check('cookie header parsing', () => {
  assert.equal(cookieOf(`a=1; ${JUDGE_COOKIE}=x.y; b=2`, JUDGE_COOKIE), 'x.y');
  assert.equal(cookieOf('a=1', JUDGE_COOKIE), undefined);
  assert.equal(cookieOf(undefined, JUDGE_COOKIE), undefined);
});

await check('login limiter: per address, then overall', () => {
  const l = loginLimiter({ perKey: 3, global: 5, windowMs: 60_000 });
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) { assert.equal(l.blocked('a', t), 0); l.fail('a', t); }
  assert.ok(l.blocked('a', t) > 0, 'a is blocked after 3 failures');
  assert.equal(l.blocked('b', t), 0, 'b is not');
  l.fail('b', t); l.fail('c', t);
  assert.ok(l.blocked('d', t) > 0, 'the global bucket blocks a fresh address');
  assert.equal(l.blocked('a', t + 61_000), 0, 'the window passes');
});

await check('daily cap: take, refuse, refund, persist', () => {
  const file = join(scratch, 'cap.json');
  const c = renderCap(3, file);
  assert.ok(c.take(2));
  assert.ok(!c.take(2), 'would pass the cap');
  assert.equal(c.used(), 2);
  c.refund(1);
  assert.equal(c.left(), 2);
  assert.equal(renderCap(3, file).used(), 1, 'a restart keeps the count');
  assert.ok(!renderCap(0, join(scratch, 'zero.json')).take(1), 'cap 0 refuses everything');
});

await check('body limits: seconds, size tier, fps, project, count', () => {
  const b: any = { kind: 'video', videoModel: 'ltx25', seconds: 20, resolution: '1080p', fps: 60, projectId: 4, count: 8 };
  const r = limitRequest('/api/generate', b);
  assert.deepEqual(r, { units: 1 });
  assert.equal(b.seconds, JUDGE_MAX_SECONDS);
  assert.equal(b.resolution, '720p');
  assert.equal(b.fps, undefined);
  assert.equal(b.projectId, undefined);
  assert.equal(b.count, 1);
  const low: any = { kind: 'video', resolution: '480p', seconds: 2 };
  limitRenderBody(low);
  assert.equal(low.resolution, '480p');
  assert.equal(low.seconds, 2);
});
await check('body limits: refused apps and sizes', () => {
  assert.match(limitRenderBody({ kind: 'hdr' }) ?? '', /HDR/);
  assert.match(limitRenderBody({ kind: 'object', quality: 'quality' }) ?? '', /Draft/);
  assert.match(limitRenderBody({ kind: 'upscale', mode: 'redraw', model: '7b' }) ?? '', /7B/);
  assert.match(limitRenderBody({ kind: 'video', width: 1920, height: 1088 }) ?? '', /720p/);
  assert.equal(limitRenderBody({ kind: 'video', width: 1280, height: 704 }), null);
  assert.equal(limitRenderBody({ kind: 'still', width: 1328, height: 752 }), null);
  assert.match(limitRenderBody({ kind: 'still', width: 2048, height: 2048 }) ?? '', /megapixel/);
});
await check('body limits: variants count and are clamped', () => {
  const b: any = { kind: 'edit', instruction: 'x', variants: Array.from({ length: 9 }, () => ({ seconds: 30, mp: 2, projectId: 1 })) };
  const r = limitRequest('/api/generate', b);
  assert.deepEqual(r, { units: 4 });
  assert.equal(b.variants.length, 4);
  assert.equal(b.variants[0].seconds, JUDGE_MAX_SECONDS);
  assert.equal(b.variants[0].mp, 1);
  assert.equal(b.variants[0].projectId, undefined);
  assert.ok('error' in limitRequest('/api/generate', { kind: 'video', variants: [{ width: 3840, height: 2160 }] }));
});
await check('scene limits: shots, seconds, hero frames', () => {
  const b: any = { shots: [{ action: 'a', seconds: 9 }, { action: 'b' }], heroFrames: true };
  assert.deepEqual(limitRequest('/api/director/scene', b), { units: 4 });
  assert.equal(b.shots[0].seconds, JUDGE_MAX_SECONDS);
  assert.ok('error' in limitRequest('/api/director/scene', { shots: [{}, {}, {}, {}] }));
});

// ------------------------------------------------------------ part 2 ----
console.log('\nJudge mode, live servers on 127.0.0.1 (no engine)');

const children: ChildProcess[] = [];

function start(port: number, env: Record<string, string>): { child: ChildProcess; out: () => string; exited: Promise<number | null> } {
  const data = mkdtempSync(join(scratch, `srv${port}-`));
  let log = '';
  // One process (node with the tsx loader), so its PID is the server's own.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OPENFIELD_PORT: String(port),
      OPENFIELD_HOST: '127.0.0.1',
      OPENFIELD_DATA: data,
      OPENFIELD_OUTPUT: join(data, 'out'),
      // Nothing answers on the discard port: no engine, no proxy, no GPU.
      COMFY_URL: 'http://127.0.0.1:9',
      COMFY_BASE_URL: 'http://127.0.0.1:9',
      COMFY_PROXY_BIN: join(data, 'no-such-proxy'),
      COMFY_LAUNCH: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  children.push(child);
  const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  return { child, out: () => log, exited };
}

async function waitUp(port: number, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`server on ${port} did not come up`);
}

const req = (port: number, path: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body) headers['content-type'] = 'application/json';
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, redirect: 'manual' });
};

/** A GET with a chosen Host header (fetch does not let a caller set Host). */
function getWithHost(port: number, path: string, host: string, cookie?: string): Promise<number> {
  return new Promise((res, rej) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (m) => { m.resume(); res(m.statusCode ?? 0); });
    r.on('error', rej);
    r.end();
  });
}

function wsOpen(port: number, cookie?: string): Promise<'open' | number> {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: cookie ? { cookie } : {} });
    ws.on('open', () => { ws.close(); res('open'); });
    ws.on('unexpected-response', (_r, msg) => { res(msg.statusCode ?? 0); ws.terminate(); });
    ws.on('error', () => res(-1));
  });
}

try {
  await check('refuses to start in judge mode without a password', async () => {
    const s = start(3199, { OPENFIELD_JUDGE: '1', OPENFIELD_JUDGE_PASSWORD: '' });
    const code = await Promise.race([s.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
    assert.notEqual(code, 'timeout', 'it kept running');
    assert.notEqual(code, 0);
    assert.match(s.out(), /OPENFIELD_JUDGE_PASSWORD/);
  });

  const J = 3199;
  start(J, { OPENFIELD_JUDGE: '1', OPENFIELD_JUDGE_PASSWORD: PW, OPENFIELD_JUDGE_CAP: '0' });
  await waitUp(J);

  let cookie = '';
  await check('API without a cookie: 401', async () => assert.equal((await req(J, '/api/status')).status, 401));
  await check('UI without a cookie: redirect to /login', async () => {
    const r = await req(J, '/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  });
  await check('/login serves the sign-in page', async () => {
    const r = await req(J, '/login');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /judge preview/);
  });
  await check('/live without a cookie: 401', async () => assert.equal(await wsOpen(J), 401));
  await check('wrong password: 401, no cookie', async () => {
    const r = await req(J, '/api/judge/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  });
  await check('right password: HttpOnly SameSite=Strict cookie', async () => {
    const r = await req(J, '/api/judge/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie') ?? '';
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    cookie = sc.split(';')[0];
  });
  await check('status with the cookie: 200, judge state, any Host', async () => {
    assert.equal(await getWithHost(J, '/api/status', 'abc123-3161.proxy.runpod.net', cookie), 200);
    const r = await req(J, '/api/status', { cookie });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.deepEqual({ cap: d.judge?.cap, used: d.judge?.used }, { cap: 0, used: 0 });
  });
  await check('/live with the cookie: opens', async () => assert.equal(await wsOpen(J, cookie), 'open'));
  await check('a forged cookie: 401', async () => {
    assert.equal((await req(J, '/api/status', { cookie: `${JUDGE_COOKIE}=${Date.now() + 1e9}.AAAA` })).status, 401);
  });
  await check('cap 0: generate answers 429', async () => {
    const r = await req(J, '/api/generate', { method: 'POST', cookie, body: JSON.stringify({ kind: 'still', prompt: 'a lighthouse' }) });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /renders for today/);
  });
  await check('cap 0: a scene answers 429', async () => {
    const r = await req(J, '/api/director/scene', { method: 'POST', cookie, body: JSON.stringify({ shots: [{ action: 'walks' }] }) });
    assert.equal(r.status, 429);
  });
  await check('Setup writes, phone, projects, stop and deletes: 403', async () => {
    const hits = await Promise.all([
      req(J, '/api/settings', { method: 'PUT', cookie, body: JSON.stringify({ renderTier: '1080p' }) }),
      req(J, '/api/agent/config', { method: 'PUT', cookie, body: JSON.stringify({ url: 'http://127.0.0.1:9999/v1' }) }),
      req(J, '/api/phone/start', { method: 'POST', cookie }),
      req(J, '/api/projects', { method: 'POST', cookie, body: JSON.stringify({ name: 'x', folder: '/etc' }) }),
      req(J, '/api/stop', { method: 'POST', cookie }),
      req(J, '/api/takes/1', { method: 'DELETE', cookie }),
      req(J, '/api/cast/1', { method: 'DELETE', cookie }),
      req(J, '/api/agent/conversations', { method: 'DELETE', cookie, body: JSON.stringify({ ids: [1] }) }),
    ]);
    assert.deepEqual(hits.map((r) => r.status), [403, 403, 403, 403, 403, 403, 403, 403]);
  });
  await check('the agent stays usable: chat, create, save and fork its conversations', async () => {
    const created = await req(J, '/api/agent/conversations', { method: 'POST', cookie, body: JSON.stringify({ title: 'judge chat' }) });
    assert.equal(created.status, 201);
    const id = (await created.json()).id as number;
    const saved = await req(J, `/api/agent/conversations/${id}`, { method: 'PUT', cookie, body: JSON.stringify({ blocks: [] }) });
    assert.equal(saved.status, 200);
    const fork = await req(J, `/api/agent/conversations/${id}/fork`, { method: 'POST', cookie, body: JSON.stringify({ upTo: 0 }) });
    assert.equal(fork.status, 201);
    // No LLM answers on this box, so the stream carries the config error —
    // the point is the route itself is open, not 403.
    const chat = await req(J, '/api/agent/chat', { method: 'POST', cookie, body: JSON.stringify({ message: 'hello' }) });
    assert.equal(chat.status, 200, `agent chat answered ${chat.status}, not 403`);
    const body = await chat.text();
    assert.match(body, /LLM configured|No LLM/, 'the stream reports the missing LLM, not a refusal');
  });
  await check('login rate limit: the 6th wrong try from one address is 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await req(J, '/api/judge/login', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ password: `wrong${i}` }) });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    // Blocked means blocked: even the right password waits.
    const r = await req(J, '/api/judge/login', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ password: PW }) });
    assert.equal(r.status, 429);
  });

  const C = 3198;
  start(C, { OPENFIELD_JUDGE: '1', OPENFIELD_JUDGE_PASSWORD: PW, OPENFIELD_JUDGE_CAP: '2' });
  await waitUp(C);
  const login = await req(C, '/api/judge/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
  const c2 = (login.headers.get('set-cookie') ?? '').split(';')[0];
  await check('a render that fails (engine down) gives its count back', async () => {
    const r = await req(C, '/api/generate', { method: 'POST', cookie: c2, body: JSON.stringify({ kind: 'still', prompt: 'a lighthouse' }) });
    assert.equal(r.status, 503, `expected the engine-down answer, got ${r.status}`);
    const d = await (await req(C, '/api/status', { cookie: c2 })).json();
    assert.equal(d.judge.used, 0);
    assert.equal(d.judge.left, 2);
  });
  await check('oversize and over-long requests are refused before the cap', async () => {
    const big = await req(C, '/api/generate', { method: 'POST', cookie: c2, body: JSON.stringify({ kind: 'video', videoModel: 'ltx25', width: 1920, height: 1088 }) });
    assert.equal(big.status, 400);
    const hdr = await req(C, '/api/generate', { method: 'POST', cookie: c2, body: JSON.stringify({ kind: 'hdr', sourceTake: 1 }) });
    assert.equal(hdr.status, 400);
    const scene = await req(C, '/api/director/scene', { method: 'POST', cookie: c2, body: JSON.stringify({ shots: [{}, {}, {}, {}] }) });
    assert.equal(scene.status, 400);
  });
  await check('a request bigger than what is left: 429', async () => {
    const r = await req(C, '/api/generate', { method: 'POST', cookie: c2, body: JSON.stringify({ kind: 'edit', instruction: 'x', variants: [{}, {}, {}] }) });
    assert.equal(r.status, 429);
  });

  const N = 3197;
  start(N, {});
  await waitUp(N);
  await check('normal mode still refuses a foreign Host', async () => {
    assert.equal(await getWithHost(N, '/api/status', 'evil.example'), 403);
    assert.equal(await getWithHost(N, '/api/status', `127.0.0.1:${N}`), 200);
  });
  await check('normal mode needs no sign-in', async () => assert.equal((await req(N, '/api/judge/login', { method: 'POST', body: '{}' })).status, 404));
} finally {
  for (const c of children) if (c.pid && c.exitCode === null) {
    try { process.kill(c.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 500));
  for (const c of children) if (c.pid && c.exitCode === null) {
    try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
