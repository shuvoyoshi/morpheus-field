/**
 * Judge mode: a password-gated, rate-capped preview of Morpheus for contest
 * judges, meant for a rented GPU box (deploy/runpod) that is only up during
 * judging. Off unless OPENFIELD_JUDGE=1.
 *
 * What it adds on top of the normal server:
 *  - a login page and a signed HttpOnly SameSite=Strict cookie, required on
 *    every route (API, /live websocket and the static UI);
 *  - login rate limits, per address and overall;
 *  - a daily render cap across all apps (429 when it is spent);
 *  - draft-sized limits on every render request, and the machine-changing
 *    routes (Setup writes including the agent's LLM config, project folders,
 *    phone listener, deletes) refused. The agent itself stays usable: its
 *    renders go through the capped render routes, and its conversation
 *    history is ordinary chat state.
 *
 * The pure parts (cookie, limiter, cap, body limits) take their inputs as
 * arguments so scripts/test-judge.ts can check them without a GPU.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const JUDGE_COOKIE = 'of_judge';
/** A login lasts a week; a new password ends every session at once. */
export const COOKIE_DAYS = 7;
export const JUDGE_MAX_SECONDS = 5;
/** 720p at 16:9, 64-aligned, as the render tier makes it. Taller or wider shapes keep this budget. */
export const JUDGE_MAX_VIDEO_PIXELS = 1280 * 736;
/** Stills: Qwen-Image's native 1328x752 and a little headroom. */
export const JUDGE_MAX_STILL_PIXELS = 1_100_000;
export const JUDGE_MAX_VARIANTS = 4;
export const JUDGE_MAX_SHOTS = 3;
export const MIN_PASSWORD = 8;

// ---------------------------------------------------------------- cookie ----

const sha = (s: string) => createHash('sha256').update(s).digest();
const keyOf = (password: string) => sha(`openfield-judge|${password}`);
const sigOf = (password: string, exp: number) => createHmac('sha256', keyOf(password)).update(`judge|${exp}`).digest('base64url');

/** A signed session value: `<expiry ms>.<hmac>`. */
export function signSession(password: string, now = Date.now()): string {
  const exp = now + COOKIE_DAYS * 86_400_000;
  return `${exp}.${sigOf(password, exp)}`;
}

/** Whether a session value is ours and unexpired. Constant-time on the signature. */
export function verifySession(password: string, value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(value.slice(0, dot));
  if (!Number.isFinite(exp) || exp < now) return false;
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(sigOf(password, exp));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Constant-time password check (both sides hashed to the same length first). */
export function passwordMatches(password: string, attempt: unknown): boolean {
  if (typeof attempt !== 'string' || !attempt) return false;
  return timingSafeEqual(sha(attempt), sha(password));
}

export function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// --------------------------------------------------------------- limiter ----

/**
 * Failed-login limiter: `perKey` failures per address and `global` failures in
 * all per window. The global bucket stops an attacker who rotates addresses
 * (X-Forwarded-For is client-supplied behind a proxy).
 */
export function loginLimiter(opts: { perKey: number; global: number; windowMs: number }) {
  const fails = new Map<string, number[]>();
  let all: number[] = [];
  const recent = (xs: number[], now: number) => xs.filter((t) => now - t < opts.windowMs);
  return {
    /** Seconds until this address may try again, or 0. */
    blocked(key: string, now = Date.now()): number {
      all = recent(all, now);
      const mine = recent(fails.get(key) ?? [], now);
      fails.set(key, mine);
      const wait = (xs: number[]) => Math.ceil((opts.windowMs - (now - xs[0])) / 1000);
      if (mine.length >= opts.perKey) return wait(mine);
      if (all.length >= opts.global) return wait(all);
      return 0;
    },
    fail(key: string, now = Date.now()) {
      fails.set(key, [...recent(fails.get(key) ?? [], now), now]);
      all = [...recent(all, now), now];
    },
    succeed(key: string) {
      fails.delete(key);
    },
  };
}

// ------------------------------------------------------------------- cap ----

/** Renders per UTC day, kept in a small JSON file so a restart does not reset it. */
export function renderCap(cap: number, file: string) {
  const today = () => new Date().toISOString().slice(0, 10);
  let state = { day: today(), used: 0 };
  try {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      if (s && typeof s.day === 'string' && Number.isFinite(s.used)) state = { day: s.day, used: s.used };
    }
  } catch {
    /* a broken file starts the day over */
  }
  const roll = () => {
    if (state.day !== today()) state = { day: today(), used: 0 };
  };
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state));
    } catch (e) {
      console.error('[openfield] could not save the judge render count:', e instanceof Error ? e.message : e);
    }
  };
  return {
    cap,
    used: () => (roll(), state.used),
    left: () => (roll(), Math.max(0, cap - state.used)),
    /** Reserve n renders. False (and nothing reserved) when that would pass the cap. */
    take(n: number): boolean {
      roll();
      if (state.used + n > cap) return false;
      state.used += n;
      save();
      return true;
    },
    /** Give back a reservation whose request failed. */
    refund(n: number) {
      roll();
      state.used = Math.max(0, state.used - n);
      save();
    },
  };
}

// ---------------------------------------------------------- body limits ----

const STILL_KINDS = new Set(['still', 'edit', 'stage-look', 'cutout', 'object']);
const clampSeconds = (v: unknown) => Math.max(1, Math.min(JUDGE_MAX_SECONDS, Number(v) || JUDGE_MAX_SECONDS));
const limitTier = (v: unknown) => (v === '480p' ? '480p' : '720p');

/**
 * Hold one render body to the judge limits, in place. Returns an error for a
 * request the preview does not run at all, or null.
 */
export function limitRenderBody(b: any): string | null {
  if (!b || typeof b !== 'object') return null;
  delete b.projectId;
  if (b.kind === 'hdr') return 'Finish in HDR is not part of the judge preview.';
  if (b.kind === 'object' && b.quality === 'quality') return 'Object renders at Draft in the judge preview.';
  if (b.kind === 'upscale' && b.mode === 'redraw' && b.model === '7b') return 'Upscale Redraw 7B is not part of the judge preview. Use 3B.';
  if (b.kind === 'upscale' && b.upHeight !== undefined) b.upHeight = 1080;
  b.resolution = limitTier(b.resolution);
  b.seconds = clampSeconds(b.seconds);
  delete b.fps;
  if (b.lengthFrames !== undefined) b.lengthFrames = Math.min(121, Number(b.lengthFrames) || 121);
  if (b.steps !== undefined) b.steps = Math.max(1, Math.min(30, Number(b.steps) || 20));
  if (b.mp !== undefined) b.mp = Math.min(1, Number(b.mp) || 1);
  const w = Number(b.width), h = Number(b.height);
  if (w > 0 && h > 0) {
    const max = STILL_KINDS.has(b.kind) ? JUDGE_MAX_STILL_PIXELS : JUDGE_MAX_VIDEO_PIXELS;
    if (w * h > max) return `The judge preview renders up to ${STILL_KINDS.has(b.kind) ? 'about 1 megapixel for stills' : '720p for video'}. This asked for ${w}x${h}.`;
  }
  return null;
}

/**
 * Limit a render request by route. Returns how many renders it counts for
 * against the daily cap, or an error to refuse it with.
 */
export function limitRequest(route: string, b: any): { units: number } | { error: string } {
  if (route === '/api/generate') {
    if (!b || typeof b !== 'object') return { units: 1 };
    b.count = 1;
    if (Array.isArray(b.variants)) {
      b.variants = b.variants.slice(0, JUDGE_MAX_VARIANTS);
      const { variants: _v, ...shared } = b;
      for (const v of b.variants) {
        if (!v || typeof v !== 'object') continue;
        // Check the body this variant really renders (queueTakes merges it over the shared one),
        // then carry the limited values back into the fields the variant sets itself.
        const merged = { ...shared, ...v };
        const why = limitRenderBody(merged);
        if (why) return { error: why };
        for (const k of VARIANT_FIELDS) if (k in v) v[k] = merged[k];
        delete v.projectId; delete v.fps;
      }
    }
    const why = limitRenderBody(b);
    if (why) return { error: why };
    return { units: Math.max(1, Array.isArray(b.variants) ? b.variants.length : 1) };
  }
  if (route === '/api/director/scene') {
    if (!b || typeof b !== 'object') return { units: 1 };
    delete b.projectId;
    b.resolution = limitTier(b.resolution);
    const w = Number(b.width), h = Number(b.height);
    if (w > 0 && h > 0 && w * h > JUDGE_MAX_VIDEO_PIXELS) return { error: `The judge preview renders up to 720p. This asked for ${w}x${h}.` };
    const shots: any[] = Array.isArray(b.shots) ? b.shots : [];
    if (shots.length > JUDGE_MAX_SHOTS) return { error: `A scene in the judge preview takes up to ${JUDGE_MAX_SHOTS} shots.` };
    for (const s of shots) if (s && typeof s === 'object') s.seconds = clampSeconds(s.seconds);
    return { units: Math.max(1, shots.length) * (b.heroFrames ? 2 : 1) };
  }
  if (route === '/api/cast/hero' && b && typeof b === 'object') delete b.projectId;
  return { units: 1 };
}

const VARIANT_FIELDS = ['resolution', 'seconds', 'steps', 'mp', 'lengthFrames', 'upHeight'] as const;

/** Routes that render, and so count against the daily cap. */
export const RENDER_ROUTES = new Set([
  'POST /api/generate',
  'POST /api/director/scene',
  'POST /api/takes/:id/fix-seam',
  'POST /api/takes/:id/upres',
  'POST /api/cast/hero',
]);

/** Routes that change the machine rather than make a render. The agent's
 *  conversation routes are deliberately not here: a judge can chat with the
 *  agent and keep the history; what it can steer is the LLM config write
 *  (refused) and the renders (capped, like every other app). */
export const BLOCKED_ROUTES = new Set([
  'PUT /api/settings',
  'PUT /api/agent/config',
  'POST /api/projects',
  'POST /api/phone/start',
  'POST /api/phoneapp/start',
  'POST /api/engine/start',
  'POST /api/engine/stop',
  'PUT /api/engine/config',
  'POST /api/free',
  'POST /api/queue/clear',
  'POST /api/stop',
  'POST /api/takes/:id/collect-hdr',
]);

// ----------------------------------------------------------------- wiring ----

export interface JudgeOptions {
  password: string;
  cap: number;
  usageFile: string;
}

export interface JudgeState {
  cap: number;
  used: number;
  left: number;
  maxSeconds: number;
}

/** Where the request came from, for the login limiter. */
function clientKey(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.ip;
}

const OPEN_PATHS = new Set(['/login', '/api/judge/login']);

/**
 * Put judge mode on a Fastify app. Call before routes are registered. Returns
 * the current cap state for /api/status.
 */
export function installJudge(app: FastifyInstance, opts: JudgeOptions): () => JudgeState {
  const cap = renderCap(opts.cap, opts.usageFile);
  const limiter = loginLimiter({ perKey: 5, global: 40, windowMs: 15 * 60_000 });
  const reserved = new WeakMap<FastifyRequest, number>();

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (OPEN_PATHS.has(path)) return;
    if (verifySession(opts.password, cookieOf(req.headers.cookie, JUDGE_COOKIE))) return;
    if (path.startsWith('/api') || path.startsWith('/live')) {
      return reply.code(401).send({ error: 'Sign in to the judge preview first.' });
    }
    return reply.redirect('/login', 302);
  });

  app.addHook('preHandler', async (req, reply) => {
    const key = `${req.method} ${req.routeOptions.url ?? ''}`;
    if (req.method === 'DELETE' || BLOCKED_ROUTES.has(key)) {
      return reply.code(403).send({ error: 'Not available in the judge preview.' });
    }
    if (!RENDER_ROUTES.has(key)) return;
    const r = limitRequest(req.routeOptions.url ?? '', req.body);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    if (!cap.take(r.units)) {
      return reply.code(429).send({
        error: `The judge preview has used its ${cap.cap} renders for today. It resets at midnight UTC. Thank you for looking.`,
      });
    }
    reserved.set(req, r.units);
  });

  // A refused or failed render gives its reservation back.
  app.addHook('onResponse', async (req, reply) => {
    const n = reserved.get(req);
    if (n && reply.statusCode >= 400) cap.refund(n);
  });

  app.get('/login', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(LOGIN_PAGE));

  app.post('/api/judge/login', async (req, reply) => {
    const who = clientKey(req);
    const wait = limiter.blocked(who);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: `Too many tries. Wait ${Math.ceil(wait / 60)} minute(s) and try again.` });
    const attempt = (req.body as { password?: unknown } | undefined)?.password;
    if (!passwordMatches(opts.password, attempt)) {
      limiter.fail(who);
      return reply.code(401).send({ error: 'That password is not right.' });
    }
    limiter.succeed(who);
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
    const secure = proto === 'https' ? '; Secure' : '';
    reply.header('Set-Cookie', `${JUDGE_COOKIE}=${encodeURIComponent(signSession(opts.password))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86_400}${secure}`);
    return { ok: true };
  });

  app.post('/api/judge/logout', async (_req, reply) => {
    reply.header('Set-Cookie', `${JUDGE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  return () => ({ cap: cap.cap, used: cap.used(), left: cap.left(), maxSeconds: JUDGE_MAX_SECONDS });
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Morpheus judge preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #f3eadf;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { width: min(360px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 22px; margin: 0; font-weight: 650; }
  p { margin: 0; color: #b8ad9f; font-size: 14px; }
  input { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(255,236,210,.18); background: #0b0a09; color: inherit; }
  button { font: inherit; font-weight: 600; padding: 10px 12px; border-radius: 8px; border: 0; background: #ffb547; color: #1c0e00; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .err { color: #ff8a73; min-height: 1.5em; }
</style>
</head>
<body>
<form id="f">
  <h1>Morpheus judge preview</h1>
  <p>A shared preview on a rented GPU. Enter the password from the submission.</p>
  <input id="pw" type="password" autocomplete="current-password" placeholder="Password" required autofocus>
  <button id="go" type="submit">Enter</button>
  <div class="err" id="err" role="alert"></div>
</form>
<script>
  const f = document.getElementById('f'), err = document.getElementById('err'), go = document.getElementById('go');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true; err.textContent = '';
    try {
      const r = await fetch('/api/judge/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pw').value }) });
      if (r.ok) { location.replace('/'); return; }
      err.textContent = (await r.json().catch(() => ({}))).error || 'Could not sign in.';
    } catch { err.textContent = 'Could not reach the server.'; }
    go.disabled = false;
  });
</script>
</body>
</html>`;
