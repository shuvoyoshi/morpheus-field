/**
 * Every machine-specific knob Morpheus has, in one place.
 *
 * Nothing here is required: a machine running ComfyUI on the default port,
 * with comfy-api-proxy installed, needs no configuration at all.
 *
 * Values come from the environment; a `.env` file next to package.json is
 * loaded first if present. See `.env.example`.
 */
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseTier } from '../src/renderTier.js';
import { parseVideoDecode } from '../src/videoDecode.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Node >= 20.12 can read a .env without a dependency. Missing file is fine.
try {
  process.loadEnvFile?.(join(ROOT, '.env'));
} catch {
  /* no .env on this machine */
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const flag = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim());

/** Judge mode (server/judge.ts): a password-gated preview for a rented box. Off by default. */
const judgeOn = flag(process.env.OPENFIELD_JUDGE);

export const config = {
  /** Port the sidecar listens on. In production it also serves the built UI. */
  port: num(process.env.OPENFIELD_PORT, 3161),
  /** Port Vite serves the UI on in dev (`npm run dev`). Production uses `port`. */
  uiPort: num(process.env.OPENFIELD_UI_PORT, 3160),
  /**
   * Interface to bind. Loopback by default: Morpheus has no authentication.
   * Judge mode adds a password and binds every interface unless told otherwise.
   */
  host: (process.env.OPENFIELD_HOST || '').trim() || (judgeOn ? '0.0.0.0' : '127.0.0.1'),

  /**
   * Judge mode: every route needs a sign-in with OPENFIELD_JUDGE_PASSWORD, renders
   * are held to draft sizes, and OPENFIELD_JUDGE_CAP renders a day (UTC) is the
   * limit across all apps. The server refuses to start in judge mode without a
   * password.
   */
  judge: {
    on: judgeOn,
    password: process.env.OPENFIELD_JUDGE_PASSWORD ?? '',
    cap: Math.max(0, Math.floor(num(process.env.OPENFIELD_JUDGE_CAP, 20))),
  },

  /** Job history, the input cache and the proxy's job state. A network volume on a rented box. */
  dataDir: process.env.OPENFIELD_DATA || join(ROOT, 'data'),

  /**
   * "Film it on your phone" opens a second, single-use listener on the LAN only
   * while a phone session is open (see server/phone.ts). The main server stays
   * on loopback. PHONE_HOST overrides the auto-detected LAN address; under WSL2
   * NAT it is the Windows LAN address to put in the QR code.
   */
   phonePort: num(process.env.OPENFIELD_PHONE_PORT, 3162),
   phoneHost: (process.env.OPENFIELD_PHONE_HOST || '').trim() || undefined,
  /**
   * Mobile-data access: the public base URL of a tunnel (e.g.
   * https://xyz.trycloudflare.com) that reaches this machine's phone port. When
   * set, the phone link is exposed over the internet so a phone on cellular can
   * use it; the listener then binds loopback and requires a PIN. Unset = LAN only.
   */
   phonePublicHost: (process.env.OPENFIELD_PHONE_PUBLIC_HOST || '').trim() || undefined,

  /**
   * "Open on your phone" (server/phoneApp.ts): a token-gated LAN reverse proxy
   * of the whole app, so a phone's browser is a second desktop. The main server
   * stays on loopback. Reuses OPENFIELD_PHONE_HOST unless
   * OPENFIELD_PHONE_APP_HOST names a different address.
   */
  phoneAppPort: num(process.env.OPENFIELD_PHONE_APP_PORT, 3163),
  phoneAppHost: ((process.env.OPENFIELD_PHONE_APP_HOST || process.env.OPENFIELD_PHONE_HOST) || '').trim() || undefined,
  /**
   * The app origin the pairing proxies to. Default: Vite in dev, the sidecar's
   * own port in production (it serves the UI there).
   */
  uiOrigin: (process.env.OPENFIELD_UI_ORIGIN || '').trim(),

  /** Where the ComfyUI server answers (health, model lists, launching). */
  comfyUrl: (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, ''),

  /**
   * Where Comfy API v2 answers. Every job goes here through the Comfy SDK.
   * Default is the local comfy-api-proxy in front of your own ComfyUI.
   * Comfy Cloud: https://cloud.comfy.org (needs COMFY_API_KEY).
   */
  comfyBaseUrl: (process.env.COMFY_BASE_URL || 'http://127.0.0.1:8189').replace(/\/+$/, ''),
  /** Only for Comfy Cloud or a Comfy API deployment. Leave unset for local. */
  comfyApiKey: (process.env.COMFY_API_KEY || '').trim(),
  /**
   * comfy-api-proxy executable. When set (or found on PATH), Morpheus starts
   * the proxy itself if the v2 API is not answering locally.
   */
  proxyBin: process.env.COMFY_PROXY_BIN || 'comfy-api-proxy',

  /**
   * Optional command that starts ComfyUI, used by the START ENGINE button and
   * the boot-time autostart. Unset = Morpheus never tries to launch anything and
   * simply reports the engine as down.
   *
   * WSL driving a Windows install:  COMFY_LAUNCH="cmd.exe /c start \"\" C:\\path\\to\\ComfyUI\\run.bat"
   * Native Linux:                   COMFY_LAUNCH="/home/me/ComfyUI/venv/bin/python /home/me/ComfyUI/main.py"
   */
  comfyLaunch: process.env.COMFY_LAUNCH || '',
  /**
   * LAN/WAN launch mode (Setup > Engine). WAN mode uses this command instead of
   * COMFY_LAUNCH — a bat that starts ComfyUI with --listen so it is reachable
   * over the network (Tailscale). Unset = WAN falls back to COMFY_LAUNCH.
   */
  comfyLaunchWan: (process.env.COMFY_LAUNCH_WAN || '').trim(),
  /** Seconds to wait for the engine to answer after launching it. */
  comfyLaunchTimeout: num(process.env.COMFY_LAUNCH_TIMEOUT, 120) * 1000,

  /**
   * How long one engine-health probe may take before we call it slow (ms).
   * Kept generous: on a machine where another process shares the GPU, ComfyUI's
   * /system_stats and the proxy's job list can stall for a few seconds without
   * being down. apiUp() retries once on a timeout, so a transient stall does not
   * flip the engine to "down".
   */
  probeTimeoutMs: num(process.env.OPENFIELD_PROBE_TIMEOUT_MS, 8000),

  /**
   * ComfyUI's models/ directory. Only the installer script needs this — the
   * app itself asks the running engine what it can see.
   */
  comfyModelsDir: process.env.COMFY_MODELS_DIR || '',

  /** Fallback output folder when no project is selected. */
  outputDir: process.env.OPENFIELD_OUTPUT || join(homedir(), 'morpheus-output'),

  /**
   * Folder of loose .safetensors mapped into ComfyUI via extra_model_paths.
   * Morpheus header-inspects these to tell LoRAs from full models so each file is
   * only offered in a menu where it can work. Unset = feature is inert.
   */
  spiceDir: process.env.SPICE_DIR || '',

  /** Optional whisper CLI for auto-transcribing generated dialogue. */
  whisperBin: process.env.WHISPER_BIN || '',
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  /** Defaults to the ffprobe sitting next to FFMPEG_BIN. */
  ffprobeBin: process.env.FFPROBE_BIN || (process.env.FFMPEG_BIN || 'ffmpeg').replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),

  /**
   * Render size for video when Setup has no choice: 480p, 720p or 1080p.
   * Unset = from the GPU (24 GB or more renders at 720p, smaller cards at 480p).
   */
  renderTier: parseTier(process.env.OPENFIELD_RENDER_TIER),

  /**
   * Video decode when Setup has no choice: whole (one call over the clip) or
   * chunked (64 frames at a time). Unset = from the GPU (AMD = chunked).
   */
  videoDecode: parseVideoDecode(process.env.OPENFIELD_VIDEO_DECODE),

  /** Serve the built UI from the sidecar (`npm start` passes --production; NODE_ENV=production works too). */
  serveStatic: process.env.NODE_ENV === 'production' || process.argv.includes('--production'),
} as const;
