/**
 * Finish in HDR, after the render: collect what the HDR nodes wrote into
 * ComfyUI's output folder and turn it into the downloads.
 *
 *   <base>_ACEScg_exr.zip   16-bit half-float ACEScg EXR frames, stored (EXR is already compressed)
 *   <base>_HLG.mov          the HLG BT.2020 10-bit HEVC master, remuxed losslessly into a .mov
 *   <base>_HLG_ProRes.mov   the same master as ProRes 422 HQ 10-bit, for editors without HEVC
 *
 * <base> is the HDR take's own file name without its extension (<shot>_<seed>_HDR).
 *
 * The files are read through ComfyUI's own /view endpoint, so Morpheus never
 * needs to know where ComfyUI keeps its output folder. Validation reads the
 * written files back: ffprobe for the movies' color tags, the EXR header for
 * channels, pixel type and chromaticities.
 */
import { execFile } from 'child_process';
import { createWriteStream } from 'fs';
import { readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { crc32 } from 'zlib';
import { config } from './config.js';
import { comfyOutputDir } from './comfy.js';
import { hdrPaths } from './graphs/hdr.js';

const view = (filename: string, subfolder: string) =>
  `${config.comfyUrl}/view?${new URLSearchParams({ filename, subfolder, type: 'output' })}`;

async function fetchOutput(filename: string, subfolder: string): Promise<Buffer | null> {
  const r = await fetch(view(filename, subfolder)).catch(() => null);
  if (!r || !r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

const split = (p: string) => {
  const i = p.lastIndexOf('/');
  return { sub: p.slice(0, i), name: p.slice(i + 1) };
};

// ---------- zip (store) ----------

/**
 * Write a stored (uncompressed) zip, streaming. Zip64 is not written, so the
 * archive must stay under 4 GB; HDR finishes are capped well below that.
 */
async function writeZip(path: string, entries: AsyncIterable<{ name: string; data: Buffer }>): Promise<{ files: number; bytes: number }> {
  const out = createWriteStream(path);
  const write = (b: Buffer) => new Promise<void>((res, rej) => out.write(b, (e) => (e ? rej(e) : res())));
  const central: Buffer[] = [];
  let offset = 0;
  let files = 0;
  for await (const { name, data } of entries) {
    const fname = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local);
    await write(fname);
    await write(data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(fname.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, fname);
    offset += 30 + fname.length + data.length;
    if (offset > 0xffffffff) throw new Error('the EXR sequence is over 4 GB; finish a shorter or smaller clip');
    files++;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files, 8);
  end.writeUInt16LE(files, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(cd);
  await write(end);
  await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  return { files, bytes: offset + cd.length + 22 };
}

// ---------- EXR header ----------

export interface ExrHeader {
  channels: { name: string; type: 'uint' | 'half' | 'float' }[];
  compression: string;
  width: number;
  height: number;
  chromaticities?: number[];
  attributes: string[];
}

const COMPRESSION = ['none', 'rle', 'zips', 'zip', 'piz', 'pxr24', 'b44', 'b44a', 'dwaa', 'dwab'];

/** Parse the attribute header of a scanline or tiled single-part EXR. */
export function readExrHeader(b: Buffer): ExrHeader {
  if (b.readUInt32LE(0) !== 20000630) throw new Error('not an OpenEXR file');
  let i = 8;
  const cstr = () => {
    const end = b.indexOf(0, i);
    const s = b.toString('latin1', i, end);
    i = end + 1;
    return s;
  };
  const h: ExrHeader = { channels: [], compression: '?', width: 0, height: 0, attributes: [] };
  for (;;) {
    const name = cstr();
    if (!name) break;
    const type = cstr();
    const size = b.readInt32LE(i);
    i += 4;
    const v = b.subarray(i, i + size);
    h.attributes.push(`${name}:${type}`);
    if (name === 'channels') {
      let j = 0;
      while (v[j] !== 0) {
        const e = v.indexOf(0, j);
        const cname = v.toString('latin1', j, e);
        const pt = v.readInt32LE(e + 1);
        h.channels.push({ name: cname, type: (['uint', 'half', 'float'] as const)[pt] });
        j = e + 1 + 16;
      }
    } else if (name === 'compression') {
      h.compression = COMPRESSION[v[0]] ?? String(v[0]);
    } else if (name === 'dataWindow') {
      h.width = v.readInt32LE(8) - v.readInt32LE(0) + 1;
      h.height = v.readInt32LE(12) - v.readInt32LE(4) + 1;
    } else if (name === 'chromaticities') {
      h.chromaticities = Array.from({ length: 8 }, (_, k) => Math.round(v.readFloatLE(k * 4) * 10000) / 10000);
    }
    i += size;
  }
  return h;
}

/** ACES AP1 (ACEScg) primaries and the ACES white point, as an EXR stores them. */
const AP1 = [0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767];
const isAp1 = (c?: number[]) => !!c && c.every((x, k) => Math.abs(x - AP1[k]) < 0.002);

// ---------- movies ----------

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((res, rej) =>
    execFile(bin, args, { maxBuffer: 1 << 26 }, (e, out, err) => (e ? rej(new Error(`${bin.split('/').pop()}: ${String(err || e.message).split('\n').slice(-3).join(' ')}`)) : res(out))));
}
const ffprobe = () => config.ffprobeBin;

export interface MovieTags { codec: string; pix_fmt: string; color_primaries?: string; color_transfer?: string; color_space?: string; frames: number; width: number; height: number }

export async function movieTags(path: string): Promise<MovieTags> {
  const out = await run(ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=codec_name,pix_fmt,color_primaries,color_transfer,color_space,nb_read_frames,width,height', '-of', 'json', path]);
  const s = JSON.parse(out).streams?.[0] ?? {};
  return {
    codec: s.codec_name, pix_fmt: s.pix_fmt, color_primaries: s.color_primaries, color_transfer: s.color_transfer,
    color_space: s.color_space, frames: Number(s.nb_read_frames) || 0, width: s.width, height: s.height,
  };
}

const HLG_TAGS = ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc'];

/**
 * The engine's own copies of a collected take — its EXR folder, the HLG
 * master, any preview original — removed once the deliverables are safe in
 * the project, so the library keeps exactly one copy of each file.
 */
export async function dropHdrSources(tag: string): Promise<void> {
  const outDir = await comfyOutputDir();
  if (!outDir) return;
  const dir = join(outDir, 'morpheus', 'hdr');
  try {
    for (const name of await readdir(dir)) {
      if (name === tag || name.startsWith(`${tag}_`)) await rm(join(dir, name), { recursive: true, force: true });
    }
  } catch { /* already gone */ }
}

// ---------- collect ----------

export interface HdrFinish {
  exrZip: string;
  hlgMov: string;
  proresMov?: string;
  frames: number;
  check: {
    exr: { frames: number; channels: string; pixel: string; compression: string; size: string; acescg: boolean };
    hlg: MovieTags;
    prores?: MovieTags;
    ok: boolean;
    problems: string[];
  };
}

/**
 * Pull the EXR frames and the HLG master for `tag` out of ComfyUI's output and
 * write the downloads next to the preview take at `base` (path without
 * extension). `frames` is how many EXRs the graph was built to write.
 */
export async function collectHdr(tag: string, frames: number, base: string): Promise<HdrFinish> {
  const paths = hdrPaths(tag);
  const problems: string[] = [];

  // EXR sequence, numbered from 0 by LTXVHDRDecodePostprocess.
  let first: ExrHeader | null = null;
  let got = 0;
  const exrZip = `${base}_ACEScg_exr.zip`;
  async function* exrs() {
    for (let k = 0; k < frames; k++) {
      const name = `${paths.exrPrefix}_${String(k).padStart(5, '0')}.exr`;
      const data = await fetchOutput(name, paths.exrDir);
      if (!data) {
        problems.push(`EXR frame ${name} is missing from ComfyUI's output (${paths.exrDir})`);
        return;
      }
      if (!first) first = readExrHeader(data);
      got++;
      yield { name: `${base.split('/').pop()}_${String(k).padStart(5, '0')}.exr`, data };
    }
  }
  await writeZip(exrZip, exrs());
  if (!first) throw new Error(`No EXR frames came back from ComfyUI (looked in output/${paths.exrDir}).`);
  const head = first as ExrHeader;

  // HLG master: LTXVSaveHLG names it <prefix>_<counter>_hlg.mp4 with the next free counter.
  const { sub, name } = split(paths.hlgPrefix);
  let hlgName: string | null = null;
  let hlg: Buffer | null = null;
  for (let c = 1; c <= 20 && !hlg; c++) {
    hlgName = `${name}_${String(c).padStart(5, '0')}_hlg.mp4`;
    hlg = await fetchOutput(hlgName, sub);
  }
  if (!hlg || !hlgName) throw new Error(`The HLG master is missing from ComfyUI's output (${paths.hlgPrefix}_*_hlg.mp4).`);
  // The job can report done a moment before the encoder's file is final on a
  // Windows drive: read it until two reads a second apart agree.
  for (let k = 0; k < 10; k++) {
    await new Promise((r) => setTimeout(r, 1000));
    const again = await fetchOutput(hlgName, sub);
    if (again && again.equals(hlg)) break;
    if (again) hlg = again;
  }
  const hlgMp4 = `${base}_HLG.src.mp4`;
  await writeFile(hlgMp4, hlg);
  const hlgMov = `${base}_HLG.mov`;
  // Lossless remux: same HEVC stream, tagged hvc1 so QuickTime and Resolve read it.
  await run(config.ffmpegBin, ['-v', 'error', '-y', '-i', hlgMp4, '-map', '0', '-c', 'copy', '-tag:v', 'hvc1', ...HLG_TAGS, hlgMov]);
  let proresMov: string | undefined = `${base}_HLG_ProRes.mov`;
  try {
    await run(config.ffmpegBin, ['-v', 'error', '-y', '-i', hlgMp4, '-map', '0:v', '-map', '0:a?', '-c:v', 'prores_ks', '-profile:v', '3',
      '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0', ...HLG_TAGS, '-c:a', 'pcm_s16le', proresMov]);
  } catch (e) {
    problems.push(`ProRes copy not written: ${e instanceof Error ? e.message : e}`);
    proresMov = undefined;
  }
  await rm(hlgMp4, { force: true });

  const hlgTags = await movieTags(hlgMov);
  const proresTags = proresMov ? await movieTags(proresMov) : undefined;
  const expectHlg = (t: MovieTags, what: string) => {
    if (t.color_primaries !== 'bt2020') problems.push(`${what}: primaries ${t.color_primaries}, expected bt2020`);
    if (t.color_transfer !== 'arib-std-b67') problems.push(`${what}: transfer ${t.color_transfer}, expected arib-std-b67 (HLG)`);
    if (!/10le$/.test(t.pix_fmt)) problems.push(`${what}: ${t.pix_fmt} is not 10-bit`);
    if (t.frames !== frames) problems.push(`${what}: ${t.frames} frames, the source has ${frames}`);
  };
  expectHlg(hlgTags, 'HLG master');
  if (proresTags) expectHlg(proresTags, 'ProRes');
  if (got !== frames) problems.push(`${got} EXR frames, the source has ${frames}`);
  const pixel = [...new Set(head.channels.map((c) => c.type))].join('/');
  if (pixel !== 'half') problems.push(`EXR pixels are ${pixel}, expected half (16-bit float)`);
  if (!isAp1(head.chromaticities)) problems.push('EXR is not tagged with ACEScg (AP1) chromaticities');

  // The masters are written and verified: drop the engine's source copies.
  await dropHdrSources(tag).catch(() => {});
  return {
    exrZip, hlgMov, proresMov, frames,
    check: {
      exr: {
        frames: got, channels: head.channels.map((c) => c.name).join(''), pixel, compression: head.compression,
        size: `${head.width}x${head.height}`, acescg: isAp1(head.chromaticities),
      },
      hlg: hlgTags,
      prores: proresTags,
      ok: problems.length === 0,
      problems,
    },
  };
}
