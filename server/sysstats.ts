/**
 * Machine vitals for the engine card: CPU, RAM and disk usage, and per-GPU
 * utilization, VRAM and temperature (nvidia-smi under CUDA_DEVICE_ORDER=
 * PCI_BUS_ID, the same order the engine launch pins). The GPU sample is cached
 * briefly and refreshed in the background, so /api/status never blocks on
 * nvidia-smi; a stale sample is served while the fresh one lands.
 */
import { statfs } from 'fs/promises';
import os from 'os';

export interface GpuStat {
  name: string;
  usage: number;
  vramUsedGb: number;
  vramTotalGb: number;
  tempC: number;
}

export interface SysStats {
  /** % since the last status call; null on the very first (no baseline yet). */
  cpu: number | null;
  ram: number;
  disk: number | null;
  gpus: GpuStat[];
}

// ---- CPU: delta of os.cpus() between calls — no dependency, no subprocess ----
let prev: { t: number; idle: number; total: number } | null = null;
function cpuPct(): number | null {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  const now = Date.now();
  let pct: number | null = null;
  if (prev && now > prev.t && total > prev.total) {
    pct = Math.round(Math.max(0, Math.min(100, (1 - (idle - prev.idle) / (total - prev.total)) * 100)));
  }
  prev = { t: now, idle, total };
  return pct;
}

function ramPct(): number {
  const total = os.totalmem();
  if (!total) return 0;
  return Math.round(((total - os.freemem()) / total) * 100);
}

function diskPct(): Promise<number | null> {
  return statfs('/')
    .then((s) => {
      const total = s.blocks * s.bsize;
      if (!total) return null;
      return Math.round(((total - s.bavail * s.bsize) / total) * 100);
    })
    .catch(() => null);
}

// ---- GPU: cached nvidia-smi, refreshed in the background ----
const GPU_TTL = 2000;
let gpuCache: { at: number; gpus: GpuStat[] } | null = null;
let gpuPending: Promise<GpuStat[]> | null = null;

function nvidiaSmi(): Promise<GpuStat[]> {
  return new Promise((resolve) => {
    import('child_process').then(({ execFile }) => {
      execFile(
        'nvidia-smi',
        ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
        { env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' }, timeout: 2500 },
        (err, stdout) => {
          if (err) return resolve(gpuCache?.gpus ?? []);
          const gpus: GpuStat[] = [];
          for (const line of String(stdout).split(/\r?\n/)) {
            const m = /^\s*(\d+)\s*,\s*(.+?)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/.exec(line);
            if (!m) continue;
            gpus.push({
              name: m[2],
              usage: Number(m[3]),
              vramUsedGb: Number(m[4]) / 1024,
              vramTotalGb: Number(m[5]) / 1024,
              tempC: Number(m[6]),
            });
          }
          resolve(gpus);
        },
      );
    });
  });
}

function gpuStats(): Promise<GpuStat[]> {
  if (gpuCache && Date.now() - gpuCache.at < GPU_TTL) return Promise.resolve(gpuCache.gpus);
  if (!gpuPending) {
    gpuPending = nvidiaSmi()
      .then((g) => {
        gpuCache = { at: Date.now(), gpus: g };
        gpuPending = null;
        return g;
      })
      .catch(() => {
        gpuPending = null;
        return gpuCache?.gpus ?? [];
      });
  }
  return Promise.resolve(gpuCache?.gpus ?? []);
}

export function systemStats(): Promise<SysStats> {
  return gpuStats().then((gpus) => diskPct().then((disk) => ({ cpu: cpuPct(), ram: ramPct(), disk, gpus })));
}
