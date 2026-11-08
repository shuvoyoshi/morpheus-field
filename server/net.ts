/**
 * Network guard for the LLM endpoints. The agent, the Director planner and the
 * model-list probe all fetch a server the user names (OPENFIELD_LLM_URL,
 * OPENFIELD_OLLAMA_URL, or a value saved in the app). A shared, password-gated
 * box (judge mode) must not let that fetch reach a cloud metadata service or an
 * arbitrary host, so every one of them is checked here first: the URL's host
 * must be this machine or a private (RFC 1918 / ULA) address. Loopback and
 * private are allowed; link-local (169.254.0.0/16 — the 169.254.169.254
 * metadata endpoint), carrier-grade NAT, unique-global and public addresses are
 * refused.
 *
 * The host is resolved before the check, and every address it resolves to must
 * pass, so a name that points one record at a private box and another at the
 * public internet is refused too.
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

/** True for 127.0.0.0/8, ::1, and the private ranges (10/8, 172.16/12, 192.168/16, fc00::/7). */
export function isPrivateOrLoopback(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    return false; // 0.0.0.0, 169.254.0.0/16 (link-local / metadata), and public
  }
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
    const first = Number.parseInt(v6.split(':', 1)[0], 16); // the first 16-bit group
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    return false; // fe80::/10 link-local and global
  }
  return false;
}

/**
 * Throw unless `rawUrl` is http(s) and its host is this machine or private.
 * Resolves hostnames and requires every address to pass.
 */
export async function assertPrivateUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`the LLM URL is not a valid URL: ${rawUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`the LLM URL must be http or https (got ${u.protocol.replace(/:$/, '')})`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPrivateOrLoopback(host)) throw new Error(`the LLM URL host must be this machine or a private address (got ${host})`);
    return;
  }
  let addrs: string[];
  try {
    addrs = (await lookup(host, { all: true })).map((r) => r.address);
  } catch (e) {
    throw new Error(`could not resolve the LLM URL host "${host}": ${e instanceof Error ? e.message : e}`);
  }
  if (!addrs.length || !addrs.every((a) => isPrivateOrLoopback(a))) {
    throw new Error(`the LLM URL host must be this machine or a private address (got ${host} -> ${addrs.join(', ') || 'no address'})`);
  }
}
