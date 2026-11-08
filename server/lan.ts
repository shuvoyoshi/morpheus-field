/**
 * LAN detection, shared by the phone listeners:
 *
 *   server/phone.ts     one-shot clip drop box ("Use your phone")
 *   server/phoneApp.ts  pairing proxy ("Open on your phone")
 *
 * Neither of those modules reads config.ts, so this file stands on its own:
 * nothing here touches .env. The override address and the port to mention in
 * the firewall commands are passed in by the caller.
 */
import { readFileSync, existsSync } from 'fs';
import { networkInterfaces } from 'os';
import { execFile } from 'child_process';

export interface PhoneNetwork {
  /** 'none' when not under WSL. */
  wsl: 'none' | 'mirrored' | 'nat';
  /** Interface address the listener is bound to. */
  bindHost: string;
  /** Address put in the QR URL. Differs from bindHost only behind a WSL2 NAT. */
  urlHost: string;
  /** Plain-language problem, or null when the phone should simply be able to connect. */
  warning: string | null;
  /** Commands that fix the warning (run in an elevated Windows PowerShell). */
  commands: string[];
}

export const fmtHost = (h: string) => (h.includes(':') ? `[${h}]` : h);

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

const isPrivate = (ip: string) =>
  /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const VIRTUAL_IF = /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|zt|utun|tun|tap|lo)/i;

/** Interface name -> metric of its default route (Linux only). */
function defaultRouteMetrics(): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync('/proc/net/route')) return out;
  try {
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 7 && f[1] === '00000000' && f[7] === '00000000') {
        const metric = Number(f[6]);
        if (!out.has(f[0]) || metric < out.get(f[0])!) out.set(f[0], metric);
      }
    }
  } catch { /* fall back to ranking */ }
  return out;
}

/** Best guess at the address a phone on the same Wi-Fi can reach. */
export function pickLanAddress(): { name: string; address: string } | null {
  const routes = defaultRouteMetrics();
  const cands: { name: string; address: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      if (VIRTUAL_IF.test(name)) continue;
      let score = isPrivate(a.address) ? 100 : 10;
      if (a.address.startsWith('192.168.')) score += 20;
      else if (a.address.startsWith('10.')) score += 10;
      if (routes.has(name)) score += 1000 - Math.min(999, routes.get(name)!);
      cands.push({ name, address: a.address, score });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  return cands[0] ?? null;
}

/** Mirrored-mode WSL puts 10.255.255.254 on lo; NAT mode never does. */
function wslMode(): 'none' | 'mirrored' | 'nat' {
  if (!isWsl()) return 'none';
  const lo = networkInterfaces().lo ?? [];
  return lo.some((a) => a.address === '10.255.255.254') ? 'mirrored' : 'nat';
}

/** Windows' own LAN address, from ipconfig.exe through WSL interop. Best effort. */
function windowsLanAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ipconfig.exe', { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const ips = [...String(stdout).matchAll(/IPv4[^:\r\n]*:\s*([\d.]+)/g)].map((m) => m[1]);
      resolve(ips.find((ip) => ip.startsWith('192.168.')) ?? ips.find((ip) => ip.startsWith('10.')) ?? null);
    });
  });
}

const VM_CREATOR_WSL = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}';

/**
 * Work out where a phone can reach the listener, and what (if anything) the
 * user has to run on Windows to let it through. `name` is human-facing (the
 * firewall rule's display name and the warning text).
 */
export async function detectNetwork(override: string | undefined, port: number, name = 'Morpheus phone'): Promise<PhoneNetwork> {
  const wsl = wslMode();
  const local = pickLanAddress();
  const localAddrs = new Set(Object.values(networkInterfaces()).flat().map((a) => a?.address));
  const overrideIsLocal = !!override && localAddrs.has(override);
  const bindHost = overrideIsLocal ? override! : local?.address ?? '';
  if (!bindHost) {
    throw new Error('No network connection found. Connect this machine to the same Wi-Fi as your phone.');
  }
  const ruleName = name.replace(/[^A-Za-z0-9]/g, '');
  const firewall = `New-NetFirewallRule -DisplayName "${name}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`;

  if (wsl === 'nat') {
    // WSL2 NAT: the Linux address is behind Windows and unreachable from the phone.
    // The phone has to hit Windows, which forwards to us via portproxy.
    const win = (override && !overrideIsLocal ? override : null) ?? (await windowsLanAddress());
    return {
      wsl,
      bindHost,
      urlHost: win ?? bindHost,
      warning:
        'Morpheus is running inside WSL2 with NAT networking, so your phone cannot reach it directly. ' +
        'Forward the port from Windows once (elevated PowerShell), or switch WSL to mirrored networking ' +
        '(add networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, then wsl --shutdown).' +
        (win ? '' : ' Windows\' LAN address could not be detected; set OPENFIELD_PHONE_HOST to it.'),
      commands: [
        `netsh interface portproxy add v4tov4 listenaddress=${win ?? '0.0.0.0'} listenport=${port} connectaddress=${bindHost} connectport=${port}`,
        firewall,
      ],
    };
  }
  if (wsl === 'mirrored') {
    return {
      wsl,
      bindHost,
      urlHost: bindHost,
      warning: null,
      // Mirrored mode shares Windows' address, but Hyper-V's firewall still filters inbound.
      commands: [
        `New-NetFirewallHyperVRule -Name ${ruleName} -DisplayName "${name}" -Direction Inbound -VMCreatorId '${VM_CREATOR_WSL}' -Protocol TCP -LocalPorts ${port}`,
        firewall,
      ],
    };
  }
  return { wsl, bindHost, urlHost: bindHost, warning: null, commands: [] };
}
