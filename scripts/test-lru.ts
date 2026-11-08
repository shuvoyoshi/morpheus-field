/**
 * The bounded LRU cache (server/lru.ts) that caps the server's per-token maps.
 * Pure, no I/O.
 *
 *   npx tsx scripts/test-lru.ts
 */
import assert from 'assert/strict';
import { Lru } from '../server/lru.js';

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

await check('a bad cap is rejected', () => {
  assert.throws(() => new Lru(0));
  assert.throws(() => new Lru(-5));
  assert.throws(() => new Lru(1.5));
});

await check('set/get round-trips', () => {
  const l = new Lru<string, number>(4);
  l.set('a', 1);
  assert.equal(l.get('a'), 1);
  assert.equal(l.has('b'), false);
  assert.equal(l.get('b'), undefined);
});

await check('it evicts the least-recently-used past the cap', () => {
  const l = new Lru<string, number>(3);
  l.set('a', 1);
  l.set('b', 2);
  l.set('c', 3);
  l.set('d', 4); // evicts 'a' (oldest)
  assert.equal(l.has('a'), false);
  assert.deepEqual([...l.keys()], ['b', 'c', 'd']);
  assert.equal(l.size, 3);
});

await check('a hit refreshes recency, protecting against eviction', () => {
  const l = new Lru<string, number>(3);
  l.set('a', 1);
  l.set('b', 2);
  l.set('c', 3);
  l.get('a'); // touch 'a' -> 'b' is now the LRU
  l.set('d', 4); // evicts 'b', not 'a'
  assert.equal(l.has('a'), true);
  assert.equal(l.has('b'), false);
  assert.deepEqual([...l.keys()], ['c', 'a', 'd']);
});

await check('re-setting a key updates it without growing', () => {
  const l = new Lru<string, number>(3);
  l.set('a', 1);
  l.set('b', 2);
  l.set('a', 10);
  assert.equal(l.get('a'), 10);
  assert.equal(l.size, 2);
});

await check('delete and clear work', () => {
  const l = new Lru<string, number>(3);
  l.set('a', 1);
  l.set('b', 2);
  assert.equal(l.delete('a'), true);
  assert.equal(l.delete('a'), false);
  l.clear();
  assert.equal(l.size, 0);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
