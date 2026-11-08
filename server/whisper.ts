/**
 * Local transcription of generated dialogue, via whatever whisper CLI the
 * machine has (set WHISPER_BIN). Entirely optional and best-effort: a failure,
 * or no whisper at all, never blocks a finished take.
 *
 * The commands run through execFile with an argument array — never a shell —
 * so a path that carries shell metacharacters (a project folder named
 * `foo$(cmd)`) is passed to ffmpeg/whisper verbatim instead of being executed.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

/** The two commands, as [executable, args] pairs (no shell involved). */
export function whisperArgs(ffmpegBin: string, whisperBin: string, videoPath: string, dir: string) {
  const wav = join(dir, 'a.wav');
  return {
    wav,
    ffmpeg: [ffmpegBin, ['-y', '-v', 'quiet', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', wav]] as const,
    whisper: [whisperBin, [wav, '--model', 'base', '--language', 'en', '--output_format', 'txt', '--output_dir', dir]] as const,
  };
}

export async function transcribe(videoPath: string): Promise<string | null> {
  // Opt-in: without WHISPER_BIN set, takes simply carry no transcript.
  if (!config.whisperBin) return null;
  const dir = await mkdtemp(join(tmpdir(), 'openfield-whisper-'));
  try {
    const { ffmpeg, whisper } = whisperArgs(config.ffmpegBin, config.whisperBin, videoPath, dir);
    await execFileAsync(ffmpeg[0], [...ffmpeg[1]], { timeout: 180000 });
    await execFileAsync(whisper[0], [...whisper[1]], { timeout: 180000 });
    const txt = (await readFile(join(dir, 'a.txt'), 'utf-8')).trim();
    return txt || null;
  } catch {
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
