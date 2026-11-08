/**
 * The LLM network guard (server/net.ts): the host must be this machine or a
 * private address. No network needed — IP literals are checked directly, and a
 * couple of hostnames exercise the resolver path.
 *
 *   npx tsx scripts/test-net.ts
 */
import assert from 'assert/strict';
import { isPrivateOrLoopback, assertPrivateUrl } from '../server/net.js';

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

const okIp = (ip: string) => assert.ok(isPrivateOrLoopback(ip), `expected ${ip} to be allowed`);
const badIp = (ip: string) => assert.ok(!isPrivateOrLoopback(ip), `expected ${ip} to be refused`);

// ---- IP classifier ----
await check('loopback IPv4 is allowed', () => okIp('127.0.0.1'));
await check('10/8 private is allowed', () => okIp('10.1.2.3'));
await check('172.16/12 private is allowed', () => okIp('172.16.0.1'));
await check('172.31/12 private is allowed', () => okIp('172.31.255.254'));
await check('192.168/16 private is allowed', () => okIp('192.168.1.10'));
await check('loopback IPv6 is allowed', () => okIp('::1'));
await check('ULA fc00::/7 is allowed', () => okIp('fd12:3456::1'));
await check('ULA fc00 (compressed) is allowed', () => okIp('fc00::1'));
await check('a non-ULA IPv6 is refused', () => badIp('2001:db8::1'));

await check('link-local 169.254 (metadata) is refused', () => badIp('169.254.169.254'));
await check('172.32 is public, refused', () => badIp('172.32.0.1'));
await check('0.0.0.0 is refused', () => badIp('0.0.0.0'));
await check('public IPv4 is refused', () => badIp('8.8.8.8'));
await check('link-local IPv6 is refused', () => badIp('fe80::1'));
await check('public IPv6 is refused', () => badIp('2001:4860:4860::8888'));
await check('a bare string is refused', () => badIp('not-an-ip'));

// ---- URL guard ----
await check('http loopback URL passes', async () => {
  await assertPrivateUrl('http://127.0.0.1:1234/v1');
});
await check('https private URL passes', async () => {
  await assertPrivateUrl('https://192.168.1.50:8080');
});
await check('IPv6 loopback URL passes', async () => {
  await assertPrivateUrl('http://[::1]:1234/v1');
});
await check('a public IP URL is refused', async () => {
  await assert.rejects(() => assertPrivateUrl('http://8.8.8.8/v1'), /private address/);
});
await check('the metadata IP is refused', async () => {
  await assert.rejects(() => assertPrivateUrl('http://169.254.169.254/latest/meta-data/'), /private address/);
});
await check('a non-http scheme is refused', async () => {
  await assert.rejects(() => assertPrivateUrl('file:///etc/passwd'), /http or https/);
});
await check('a non-URL is refused', async () => {
  await assert.rejects(() => assertPrivateUrl('not a url'), /not a valid URL/);
});
await check('localhost (resolves to loopback) passes', async () => {
  await assertPrivateUrl('http://localhost:1234/v1');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
