/**
 * Output file management. Finished renders move from ComfyUI's output
 * into the active project folder as <shot>_<seed>.<ext>; upres saves as
 * <shot>_<seed>_UP.mp4, a seam fix as _LOOP, an HDR finish as _HDR.
 *
 * Two ways to land a file: saveToProject writes the bytes the engine handed
 * us, and moveToProject renames the engine's own output file — one copy
 * instead of two, when the library lives on the same volume as ComfyUI's
 * output folder (the local default). Both verify the result and never
 * overwrite an existing take file.
 */
import { mkdir, rm, writeFile, stat, rename } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { config } from './config.js';
import { takeFiles } from './takeFiles.js';

export function safeShotName(name: string): string {
  const cleaned = (name || 'shot').replace(/[^a-zA-Z0-9._ -]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  return cleaned || 'shot';
}

export interface SaveOpts {
  ext: string;
  upres?: boolean;
  suffix?: string;
}

/** The take's destination in a project folder, bumping a counter instead of overwriting. */
export function destPath(projectFolder: string, shotName: string, seed: number, opts: SaveOpts): string {
  const dir = join(projectFolder, 'Morpheus');
  const base = `${safeShotName(shotName)}_${seed}${opts.upres ? '_UP' : ''}${opts.suffix ?? ''}`;
  let path = join(dir, `${base}.${opts.ext}`);
  for (let i = 2; existsSync(path); i++) path = join(dir, `${base}_${i}.${opts.ext}`);
  return path;
}

export async function saveToProject(
  projectFolder: string,
  shotName: string,
  seed: number,
  data: Buffer,
  opts: SaveOpts
): Promise<string> {
  const path = destPath(projectFolder, shotName, seed, opts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  const st = await stat(path);
  if (st.size !== data.length) throw new Error('write verification failed');
  return path;
}

/**
 * Zero-copy save: the engine's output file (same volume) becomes the take's
 * file. Throws if the source is gone; the caller falls back to saveToProject.
 */
export async function moveToProject(
  source: string,
  projectFolder: string,
  shotName: string,
  seed: number,
  opts: SaveOpts
): Promise<string> {
  if (!existsSync(source)) throw new Error('the engine output file is already gone');
  const before = await stat(source);
  const path = destPath(projectFolder, shotName, seed, opts);
  await mkdir(dirname(path), { recursive: true });
  await rename(source, path);
  const after = await stat(path);
  if (after.size !== before.size) throw new Error('move verification failed');
  return path;
}

// ---------- trash ----------
//
// The shared trash: <output folder>/.trash/<key>/, one folder per trashed
// take (or cast member). A manifest maps each stashed file back to its
// original path, which is what restore moves it to. Files are kept until a
// purge, so "delete" is always recoverable until it is not.

export const trashRoot = (): string => join(config.outputDir, '.trash');
const trashDir = (key: string) => join(trashRoot(), key);

type Manifest = Record<string, string>; // stashed file name -> original absolute path

function readManifest(key: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(trashDir(key), 'manifest.json'), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m as Manifest : null;
  } catch {
    return null;
  }
}

/** `stem.ext` -> `stem_<i>.ext`, the same bumping destPath uses. */
function bumpName(path: string, i: number): string {
  const e = extname(path);
  return `${basename(path).slice(0, -e.length)}_${i}${e}`;
}

/** Move a set of files into the shared trash under `key`, keeping a manifest. */
export async function stashFiles(files: string[], key: string): Promise<number> {
  const live = files.filter((f) => typeof f === 'string' && existsSync(f));
  if (!live.length) return 0;
  const dir = trashDir(key);
  await mkdir(dir, { recursive: true });
  const map: Manifest = {};
  for (const f of live) {
    let name = basename(f);
    for (let i = 2; existsSync(join(dir, name)); i++) name = bumpName(f, i);
    await rename(f, join(dir, name));
    map[name] = f;
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(map));
  return live.length;
}

/** A take's files, into the trash. The DB mark is the caller's job. */
export async function trashTakeFiles(take: { id: number; output_path: string | null; settings: string }): Promise<number> {
  return stashFiles(takeFiles(take), String(take.id));
}

/**
 * A trashed take's files, back to their original paths. If any original name
 * is taken (a newer take owns it), the whole take lands under the next free
 * name, so its sidecars stay derivable from its output file. `remapped` is
 * set only when the files had to move to new names.
 */
export async function restoreTakeFiles(
  take: { id: number; output_path: string | null; settings: string }
): Promise<{ restored: number; remapped?: Record<string, string> }> {
  const dir = trashDir(String(take.id));
  const map = readManifest(String(take.id));
  if (!map) return { restored: 0 };
  const originals = Object.values(map);
  const main = take.output_path;
  const destFor = (orig: string, suffix: string): string => {
    if (main && orig === main) return main.replace(/(\.[^.]+)$/, `${suffix}$1`);
    if (main && orig.startsWith(main)) return orig.replace(main, destFor(main, suffix));
    const e = extname(orig);
    return e ? orig.slice(0, -e.length) + suffix + e : orig + suffix;
  };
  let suffix = '';
  for (const i of [null, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    suffix = i === null ? '' : `_${i}`;
    if (originals.every((o) => !existsSync(destFor(o, suffix)))) break;
    if (i === 12) throw new Error('could not find a free name to restore the take into');
  }
  let restored = 0;
  for (const [name, orig] of Object.entries(map)) {
    const src = join(dir, name);
    if (!existsSync(src)) continue;
    const dest = destFor(orig, suffix);
    await mkdir(dirname(dest), { recursive: true });
    await rename(src, dest);
    restored++;
  }
  await rm(dir, { recursive: true, force: true });
  return suffix ? { restored, remapped: Object.fromEntries(Object.entries(map).map(([n, o]) => [o, destFor(o, suffix)])) } : { restored };
}

/** A take's files, gone wherever they are (library or trash). The caller deletes the row. */
export async function purgeTakeFiles(take: { id: number; output_path: string | null; settings: string }): Promise<number> {
  let gone = 0;
  for (const f of takeFiles(take)) {
    try {
      if (existsSync(f)) { await rm(f); gone++; }
    } catch { /* keep going; the row still goes */ }
  }
  try {
    await rm(trashDir(String(take.id)), { recursive: true, force: true });
  } catch { /* already gone */ }
  return gone;
}

/**
 * Pixel size of a PNG, JPEG or WebP from its header, without decoding it.
 * Null for anything else. The edit graphs need it to keep the source aspect.
 */
export function imageDims(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) };
    }
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
