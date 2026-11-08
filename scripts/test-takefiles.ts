/**
 * A take's file footprint (server/takeFiles.ts): what `?purge=1` deletes, and
 * that a malformed settings row never throws. Plus the trash round-trip
 * (server/files.ts): stash, restore, collide, purge — with OPENFIELD_OUTPUT
 * pointed at a temp dir so the real library is never touched.
 *
 *   npx tsx scripts/test-takefiles.ts
 */
import assert from 'assert/strict';
import { existsSync as fsx, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join as pjoin, dirname as pdirname } from 'path';
import { safeSettings, takeFiles } from '../server/takeFiles.js';

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

await check('no output path -> no files', () => {
  assert.deepEqual(takeFiles({ output_path: null, settings: '{}' }), []);
});

await check('a plain take lists the output and its sidecars', () => {
  const f = takeFiles({ output_path: '/p/Morpheus/shot_1.mp4', settings: '{}' });
  assert.deepEqual(f, [
    '/p/Morpheus/shot_1.mp4',
    '/p/Morpheus/shot_1.mp4.poster.jpg',
    '/p/Morpheus/shot_1.mp4.turntable.mp4',
    '/p/Morpheus/shot_1.mp4.subject.png',
  ]);
});

await check('the alpha cut and HDR masters are included', () => {
  const settings = JSON.stringify({
    alphaPath: '/p/Morpheus/shot_1.mov',
    hdr: { exrZip: '/p/Morpheus/shot_1.exr.zip', hlgMov: '/p/Morpheus/shot_1.hlg.mov', proresMov: '/p/Morpheus/shot_1.pr.mov' },
  });
  const f = takeFiles({ output_path: '/p/Morpheus/shot_1.mp4', settings });
  for (const want of ['/p/Morpheus/shot_1.mov', '/p/Morpheus/shot_1.exr.zip', '/p/Morpheus/shot_1.hlg.mov', '/p/Morpheus/shot_1.pr.mov']) {
    assert.ok(f.includes(want), `expected ${want}`);
  }
});

await check('duplicates are collapsed', () => {
  const settings = JSON.stringify({ alphaPath: '/p/Morpheus/shot_1.mp4' }); // same as the output
  const f = takeFiles({ output_path: '/p/Morpheus/shot_1.mp4', settings });
  assert.equal(f.filter((x) => x === '/p/Morpheus/shot_1.mp4').length, 1);
});

await check('a malformed settings row does not throw', () => {
  assert.deepEqual(safeSettings({ settings: 'not json {' }), {});
  assert.deepEqual(safeSettings({ settings: 'null' }), {});
  assert.deepEqual(safeSettings({ settings: '"a string"' }), {});
  assert.deepEqual(safeSettings({ settings: '123' }), {});
});

await check('a valid object settings row parses', () => {
  assert.deepEqual(safeSettings({ settings: '{"a":1}' }), { a: 1 });
});

// ---------- trash (server/files.ts) ----------

const OUT = pjoin(tmpdir(), `morpheus-trash-test-${Date.now()}`);
process.env.OPENFIELD_OUTPUT = OUT;
const files = await import('../server/files.js');
if (!files.trashRoot().startsWith(OUT)) {
  console.error(`refusing to run: trashRoot ${files.trashRoot()} is not under the temp dir ${OUT}`);
  process.exit(1);
}
const LIB = pjoin(OUT, 'Morpheus');
const put = (rel: string, data = 'x') => {
  const p = pjoin(LIB, rel);
  mkdirSync(pdirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
};

await check('stashFiles moves the files into the trash and writes the manifest', async () => {
  const a = put('shot_1.mp4');
  const b = put('shot_1.mp4.poster.jpg');
  assert.equal(await files.stashFiles([a, b], '999'), 2);
  assert.ok(!fsx(a) && !fsx(b), 'the library copies are gone');
  const dir = pjoin(files.trashRoot(), '999');
  assert.ok(fsx(pjoin(dir, 'manifest.json')), 'the manifest is written');
  assert.ok(fsx(pjoin(dir, 'shot_1.mp4')) && fsx(pjoin(dir, 'shot_1.mp4.poster.jpg')), 'both files are stashed');
});

await check('trashTakeFiles stashes the whole footprint (sidecars, alpha, HDR)', async () => {
  const out = put('hero_7.mp4');
  const poster = put('hero_7.mp4.poster.jpg');
  const alpha = put('hero_7_alpha.mov');
  const hdr = put('hero_7_ACEScg_exr.zip');
  const t = { id: 42, output_path: out, settings: JSON.stringify({ alphaPath: alpha, hdr: { exrZip: hdr } }) };
  assert.equal(await files.trashTakeFiles(t), 4);
  for (const f of [out, poster, alpha, hdr]) assert.ok(!fsx(f), `${f} should be out of the library`);
  const dir = pjoin(files.trashRoot(), '42');
  for (const name of ['hero_7.mp4', 'hero_7.mp4.poster.jpg', 'hero_7_alpha.mov', 'hero_7_ACEScg_exr.zip']) {
    assert.ok(fsx(pjoin(dir, name)), `${name} is stashed`);
  }
});

await check('restoreTakeFiles puts the files back where they came from', async () => {
  const res = await files.restoreTakeFiles({ id: 42, output_path: pjoin(LIB, 'hero_7.mp4'), settings: '{}' });
  assert.equal(res.restored, 4);
  assert.equal(res.remapped, undefined, 'no collision, no remap');
  for (const name of ['hero_7.mp4', 'hero_7.mp4.poster.jpg', 'hero_7_alpha.mov', 'hero_7_ACEScg_exr.zip']) {
    assert.ok(fsx(pjoin(LIB, name)), `${name} is back`);
  }
  assert.ok(!fsx(pjoin(files.trashRoot(), '42')), 'the trash folder is cleaned up');
});

await check('a restore whose names were taken lands under bumped names and reports the remap', async () => {
  const t = { id: 42, output_path: pjoin(LIB, 'hero_7.mp4'), settings: '{}' };
  put('hero_7.mp4', 'stashed copy');
  put('hero_7.mp4.poster.jpg', 'stashed sidecar');
  assert.equal(await files.trashTakeFiles(t), 2);
  // A newer take renders into the same names while the old one is trashed.
  put('hero_7.mp4', 'new take');
  put('hero_7.mp4.poster.jpg', 'new sidecar');
  const res = await files.restoreTakeFiles(t);
  assert.equal(res.restored, 2);
  assert.ok(res.remapped, 'a collision was detected');
  assert.equal(res.remapped![t.output_path!], pjoin(LIB, 'hero_7_2.mp4'));
  assert.ok(fsx(pjoin(LIB, 'hero_7_2.mp4')), 'the stashed output landed under the bumped name');
  assert.ok(fsx(pjoin(LIB, 'hero_7_2.mp4.poster.jpg')), 'the sidecar stayed derivable from its parent');
  assert.equal(await (await import('fs/promises')).readFile(pjoin(LIB, 'hero_7.mp4'), 'utf8'), 'new take', 'the newer take is untouched');
});

await check('purgeTakeFiles removes the files and the trash folder', async () => {
  const out = put('gone_9.mp4');
  const side = put('gone_9.mp4.subject.png');
  const t = { id: 77, output_path: out, settings: JSON.stringify({ alphaPath: side }) };
  await files.trashTakeFiles(t);
  await files.purgeTakeFiles(t);
  assert.ok(!fsx(out) && !fsx(side), 'the library copies are gone');
  assert.ok(!fsx(pjoin(files.trashRoot(), '77')), 'the trash folder is gone too');
});

await check('stashing again after a purge starts clean', async () => {
  const out = put('again_5.png');
  const t = { id: 77, output_path: out, settings: '{}' };
  assert.equal(await files.trashTakeFiles(t), 1);
  assert.ok(!fsx(out));
  const n = await files.purgeTakeFiles(t);
  assert.equal(n, 0, 'nothing left in the library to purge');
  assert.ok(!fsx(pjoin(files.trashRoot(), '77')));
});

rmSync(OUT, { recursive: true, force: true });

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
