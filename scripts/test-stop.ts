/**
 * Stop semantics: `npm run test:stop`.
 *
 * Starts a real server on 127.0.0.1 (scratch data, engine down), seeds one
 * take mid-render and one waiting in the queue, and checks that /api/stop
 * cancels and marks the live one (and tells the UI), while the queued take —
 * a separate take — stays queued.
 */
import assert from 'assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { ROOT } from '../server/config.js';

const scratch = mkdtempSync(join(tmpdir(), 'openfield-stop-test-'));
const PORT = 3201;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    OPENFIELD_PORT: String(PORT),
    OPENFIELD_HOST: '127.0.0.1',
    OPENFIELD_DATA: scratch,
    OPENFIELD_OUTPUT: join(scratch, 'out'),
    // Nothing answers on the discard port: no engine, no proxy, no GPU.
    COMFY_URL: 'http://127.0.0.1:9',
    COMFY_BASE_URL: 'http://127.0.0.1:9',
    COMFY_PROXY_BIN: join(scratch, 'no-such-proxy'),
    COMFY_LAUNCH: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout!.on('data', (d) => (log += d));
child.stderr!.on('data', (d) => (log += d));
const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));

const req = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: init.body ? { 'content-type': 'application/json', ...(init.headers as object) } : init.headers,
    redirect: 'manual',
  });

try {
  await check('the server comes up', async () => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      try { if ((await fetch(`${BASE}/api/status`, { redirect: 'manual' })).status === 200) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server on ${PORT} did not come up:\n${log.slice(-2000)}`);
  });

  // Seed the two states directly in the scratch database.
  const db = new Database(join(scratch, 'morpheus.db'));
  const live = db.prepare("INSERT INTO takes (kind, shot_name, status, prompt_id, settings) VALUES ('still','stop test','rendering','fake-live-job','{}')").run().lastInsertRowid as number;
  const queued = db.prepare("INSERT INTO takes (kind, shot_name, status, settings) VALUES ('still','queued test','queued','{}')").run().lastInsertRowid as number;

  const events: Record<string, any>[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.on('message', (m) => { try { events.push(JSON.parse(String(m))); } catch { /* binary */ } });

  await check('stop cancels the live render and marks the take stopped', async () => {
    const r = await req('/api/stop', { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.stopped, 1, `exactly the live take, got ${JSON.stringify(body)}`);
    const t = await (await req(`/api/takes/${live}`)).json();
    assert.equal(t.status, 'stopped', `the take is stopped, not ${t.status}`);
    assert.match(String(t.error), /stopped/);
  });

  await check('the queued take is a separate take: it stays queued', async () => {
    const t = await (await req(`/api/takes/${queued}`)).json();
    assert.equal(t.status, 'queued');
    assert.equal(t.error, null);
  });

  await check('the UI is told: /live carries the stopped take', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const e = events.find((x) => x.type === 'take' && x.take?.id === live);
    assert.ok(e, `a take event for the stopped take (${JSON.stringify(events)})`);
    assert.equal(e.take.status, 'stopped');
  });

  await check('a second stop is a no-op', async () => {
    const body = await (await req('/api/stop', { method: 'POST' })).json();
    assert.equal(body.stopped, 0);
  });

  ws.close();
  db.close();
} finally {
  if (child.pid && child.exitCode === null) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  if (child.pid && child.exitCode === null) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
