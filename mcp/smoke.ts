/**
 * Smoke test: spawn the MCP server over stdio with the SDK client and call the
 * READ-ONLY tools against a running Morpheus (status, list_presets,
 * list_recipes, list_takes, get_take). Never queues a render.
 *
 *   npx tsx mcp/smoke.ts             (or: npm run mcp:smoke)
 *
 * Also checks that bad input to a generate tool is rejected before anything
 * reaches the GPU (a missing file fails at the upload step).
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', join(here, 'server.ts')],
  env: process.env as Record<string, string>, // passes OPENFIELD_URL through
  stderr: 'inherit',
});
const client = new Client({ name: 'openfield-smoke', version: '0.1.0' });
await client.connect(transport);

const EXPECTED = [
  'status', 'list_presets', 'list_recipes', 'generate_video', 'make_loop', 'generate_image', 'list_loras',
  'direct_shot', 'direct_scene', 'edit_image', 'mirror_motion', 'remove_background', 'restyle_video', 'swap_object',
  'apply_effect', 'reshoot', 'extend_video', 'make_transition', 'speak', 'add_sound', 'generate_music', 'generate_speech',
  'upscale', 'make_3d', 'list_takes', 'get_take', 'wait_for_take', 'critique_take',
  'list_cast', 'create_cast', 'fix_seam', 'finish_hdr', 'stage_render', 'cancel',
];
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
for (const n of EXPECTED) assert.ok(names.includes(n), `missing tool ${n}`);
console.log(`ok  ${tools.length} tools: ${names.join(', ')}`);

type Res = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
async function call(name: string, args: Record<string, unknown> = {}): Promise<Res> {
  return (await client.callTool({ name, arguments: args })) as Res;
}
const json = (r: Res, i = 0) => JSON.parse(r.content[i].text!);

const st = await call('status');
assert.ok(!st.isError, st.content[0]?.text);
const s = json(st);
console.log(`ok  status: engine_up=${s.engine_up} gpu=${s.gpu} comfy=${s.comfyui_version} queue=${s.queue.length} bundles=${s.bundles?.filter((b: any) => b.ready).map((b: any) => b.id).join('/')}`);

const pr = json(await call('list_presets'));
assert.ok(pr.motion_presets.length >= 20 && pr.director_axes.camera && pr.mirror_modes.length === 3 && pr.effects.length >= 4);
console.log(`ok  list_presets: ${pr.motion_presets.length} motion, ${Object.keys(pr.director_axes).length} director axes, ${pr.reshoot_angles.length} reshoot angles`);

const cam = json(await call('list_presets', { section: 'motion', category: 'epic' }));
assert.ok(cam.motion_presets.every((p: any) => p.category === 'epic') && !cam.director_axes);
console.log(`ok  list_presets filter: ${cam.motion_presets.length} epic`);

const rc = json(await call('list_recipes'));
assert.ok(rc.length > 0 && rc[0].compiled_prompt);
console.log(`ok  list_recipes: ${rc.length} (${rc.map((r: any) => r.id).join(', ')})`);

const lc = await call('list_cast');
assert.ok(!lc.isError, 'list_cast failed');
console.log(`ok  list_cast: ${lc.content[0].text!.startsWith('[') ? `${JSON.parse(lc.content[0].text!).length} members` : 'empty'}`);

// The cast API must never read a local path it is handed (only upload tokens and take ids).
{
  const base = (process.env.OPENFIELD_URL || 'http://127.0.0.1:3161').replace(/\/+$/, '');
  for (const refs of [[{ path: '/etc/passwd' }], [{ token: '/etc/passwd' }], [{ takeId: 1, path: '/etc/passwd' }]]) {
    const r = await fetch(`${base}/api/cast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'smoke path probe', refs }) });
    assert.equal(r.status, 400, `POST /api/cast with ${JSON.stringify(refs)} must 400, got ${r.status}`);
  }
  console.log('ok  POST /api/cast refuses local paths (400)');
}

const lt = json(await call('list_takes', { limit: 5 }));
console.log(`ok  list_takes: ${lt.count} rows; newest ${lt.takes[0]?.id ?? '-'} ${lt.takes[0]?.status ?? ''}`);

const done = json(await call('list_takes', { status: 'done', limit: 50 }));
assert.ok(done.takes.every((t: any) => t.status === 'done'));
const still = done.takes.find((t: any) => t.kind === 'still');
const video = done.takes.find((t: any) => t.kind !== 'still');
for (const t of [still, video].filter(Boolean)) {
  const r = await call('get_take', { take_id: t.id });
  assert.ok(!r.isError, r.content[0]?.text);
  const meta = json(r);
  const img = r.content.find((c) => c.type === 'image');
  assert.equal(meta.id, t.id);
  console.log(`ok  get_take ${t.id} (${t.kind}): ${meta.output_path}; preview ${img ? `${img.mimeType} ${Math.round((img.data!.length * 3) / 4 / 1024)} KB` : 'none'}`);
}

if (still) {
  const w = await call('wait_for_take', { take_ids: [still.id], timeout_seconds: 5, preview: false });
  assert.ok(!w.isError && json(w).timed_out === false && json(w, 1).status === 'done');
  console.log(`ok  wait_for_take on finished take ${still.id} returns at once`);
}

const missing = await call('get_take', { take_id: 99_999_999 });
assert.ok(missing.isError);
console.log(`ok  get_take unknown id -> error: ${missing.content[0].text}`);

// Rejected before the GPU: the file does not exist, so nothing is uploaded or queued.
const bad = await call('make_loop', { image: '/nonexistent/openfield-smoke.png' });
assert.ok(bad.isError && /No such file/.test(bad.content[0].text!));
console.log(`ok  make_loop with a missing file -> error: ${bad.content[0].text}`);

await client.close();
console.log('\nsmoke passed (read-only)');
