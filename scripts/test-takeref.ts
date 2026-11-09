/**
 * Take-reference resolution: a bare take id ("75") must resolve the same as the
 * documented "take:75", while real file paths keep resolving as files. This is
 * the failure the in-app agent hit — it sent `references: ["75"]` / `images:
 * ["75"]` and every call died with "No such file: <cwd>\75" (the bare id fell
 * through to the local-file branch). No LLM or GPU needed: `npm run test:takeref`.
 */
import assert from 'assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// A 1x1 PNG so imageDims() reads real dimensions off the take's media.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && req.url === '/api/takes') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify([{ id: 75, status: 'done', kind: 'still', settings: '{"width":1024,"height":1024}', output_path: '/tmp/take_75.png' }]));
  }
  if (req.method === 'GET' && req.url === '/api/media/75') {
    res.setHeader('content-type', 'image/png');
    return res.end(PNG);
  }
  if (req.method === 'POST' && req.url === '/api/upload') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw) as { name: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: `token_${b.name}` }));
    });
    return;
  }
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: `no fake endpoint for ${req.method} ${req.url}` }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
// client.ts captures OPENFIELD_URL at module load, so it must be set before the import.
process.env.OPENFIELD_URL = `http://127.0.0.1:${port}`;
const { takeIdOf, resolveInput } = await import('../mcp/client.ts');

let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`); }
}

await check('takeIdOf maps the documented and bare forms to the id', () => {
  assert.equal(takeIdOf('take:75'), 75);
  assert.equal(takeIdOf('75'), 75);
  assert.equal(takeIdOf(' 75 '), 75);
  assert.equal(takeIdOf('"75"'), 75);
  assert.equal(takeIdOf('TAKE:75'), 75);
});

await check('takeIdOf leaves real file paths and other strings alone', () => {
  assert.equal(takeIdOf('C:\\Users\\me\\pic.png'), undefined);
  assert.equal(takeIdOf('~/shots/clip.mp4'), undefined);
  assert.equal(takeIdOf('16:9'), undefined);
  assert.equal(takeIdOf(''), undefined);
});

await check('a bare take id resolves as a take (the original failure)', async () => {
  const a = await resolveInput('75', 'image');
  assert.equal(a.takeId, 75);
  assert.equal(a.name, 'take 75');
  assert.ok(a.token, 'got an upload token');
});

await check('take:<id> still resolves as a take', async () => {
  const a = await resolveInput('take:75', 'image');
  assert.equal(a.takeId, 75);
});

await check('a file path still resolves as a file, not a take', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openfield-takeref-'));
  const p = join(dir, 'shot.png');
  await writeFile(p, PNG);
  const a = await resolveInput(p, 'image');
  assert.equal(a.takeId, undefined, 'a file is not a take');
  assert.equal(a.source, p);
  assert.ok(a.token, 'got an upload token');
});

await check('a bare id that is not a take fails readably (points at list_takes)', async () => {
  await assert.rejects(() => resolveInput('9999', 'image'), /No take 9999|list_takes/);
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
