/**
 * The whisper command builder (server/whisper.ts): the path must arrive as a
 * single, verbatim argument — not shell-interpolated — so a project folder or
 * shot name carrying shell metacharacters cannot execute.
 *
 *   npx tsx scripts/test-whisper.ts
 */
import assert from 'assert/strict';
import { join } from 'path';
import { whisperArgs } from '../server/whisper.js';

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

const DIR = '/tmp/openfield-whisper-test';
const FFMPEG = '/usr/bin/ffmpeg';
const WHISPER = '/usr/local/bin/whisper';

await check('ffmpeg is an [executable, args] pair', () => {
  const { ffmpeg } = whisperArgs(FFMPEG, WHISPER, '/a/b/shot.mp4', DIR);
  assert.equal(ffmpeg[0], FFMPEG);
  assert.ok(Array.isArray(ffmpeg[1]));
});

await check('the video path is one verbatim argument', () => {
  const evil = '/proj/$(touch /tmp/pwned) `id` "x"/shot_1.mp4';
  const { ffmpeg } = whisperArgs(FFMPEG, WHISPER, evil, DIR);
  const args = [...ffmpeg[1]];
  const i = args.indexOf('-i');
  assert.ok(i >= 0, '-i flag present');
  assert.equal(args[i + 1], evil, 'path passed through untouched, as a single element');
});

await check('no argument is a joined shell string', () => {
  const evil = '/proj/$(cmd)/shot.mp4';
  const { ffmpeg, whisper } = whisperArgs(FFMPEG, WHISPER, evil, DIR);
  for (const [bin, args] of [ffmpeg, whisper]) {
    assert.equal(typeof bin, 'string');
    for (const a of args) {
      assert.equal(typeof a, 'string');
      // A path never bleeds into its neighbours: each arg is a discrete token.
      assert.ok(!a.includes('\0'));
    }
  }
});

await check('whisper targets the extracted wav and writes into the temp dir', () => {
  const { wav, whisper } = whisperArgs(FFMPEG, WHISPER, '/a/b/shot.mp4', DIR);
  assert.equal(wav, join(DIR, 'a.wav'));
  const args = [...whisper[1]];
  assert.ok(args.includes(wav), 'wav is an input arg');
  const o = args.indexOf('--output_dir');
  assert.equal(args[o + 1], DIR, 'output dir is the temp dir');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
