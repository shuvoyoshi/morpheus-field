#!/usr/bin/env bash
# Morpheus judge preview, Runpod entrypoint.
#
#  1. Puts models, job history and renders on the network volume (/workspace).
#  2. Downloads the core bundles and the judge demo bundles there, once
#     (resumable: a restarted pod picks up where it stopped).
#  3. Starts ComfyUI (--preview-method auto) on loopback.
#  4. Starts Morpheus in judge mode on 0.0.0.0:3161, which also starts
#     comfy-api-proxy. Open it through Runpod's HTTP proxy:
#     https://<pod id>-3161.proxy.runpod.net
#
# Env (set on the Runpod template; tokens through Runpod secrets):
#   OPENFIELD_JUDGE_PASSWORD  required, 8+ characters
#   HF_TOKEN                  read token, with the LTX-2.5 license accepted
#   OPENFIELD_JUDGE_CAP       renders per UTC day, default 20
#   OPENFIELD_BUNDLES         default: ltx25,qwen,edit,cutout,ltx-tools
#   OPENFIELD_SKIP_DOWNLOAD   1 = start with whatever is on the volume
#   RUNPOD_VOLUME             default /workspace
#
# Paths can be overridden (COMFY_DIR, COMFY_PY, OPENFIELD_DIR, COMFY_PROXY_BIN)
# so the logic can be dry-run off the image with stubs.
set -euo pipefail

VOL="${RUNPOD_VOLUME:-/workspace}"
COMFY_DIR="${COMFY_DIR:-/opt/ComfyUI}"
COMFY_PY="${COMFY_PY:-/opt/venv/bin/python}"
OPENFIELD_DIR="${OPENFIELD_DIR:-/opt/openfield}"
COMFY_PORT="${COMFY_PORT:-8188}"
BUNDLES="${OPENFIELD_BUNDLES:-ltx25,qwen,edit,cutout,ltx-tools}"
COMFY_WAIT="${COMFY_WAIT:-600}"

log() { printf '\n[openfield-runpod] %s\n' "$*"; }
die() { printf '\n[openfield-runpod] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- checks ----
if [ "${OPENFIELD_JUDGE:-1}" != "0" ]; then
  pw="${OPENFIELD_JUDGE_PASSWORD:-}"
  [ "${#pw}" -ge 8 ] || die "Set OPENFIELD_JUDGE_PASSWORD (8 characters or more) on the pod. The preview never starts without one."
  unset pw
fi
mkdir -p "$VOL" 2>/dev/null || true
[ -w "$VOL" ] || die "$VOL is not writable. Attach a network volume (or a pod volume) mounted at $VOL."
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
else
  log "nvidia-smi not found. Is this a GPU pod?"
fi

# ---------------------------------------------------------------- volume ----
MODELS="$VOL/models"
mkdir -p "$MODELS" "$VOL/openfield-data" "$VOL/openfield-output" "$VOL/logs"
# Seed the folder layout ComfyUI expects, then point ComfyUI's models/ at the volume.
if [ -d "$COMFY_DIR/models.dist" ]; then
  cp -rn "$COMFY_DIR/models.dist/." "$MODELS/" 2>/dev/null || true
fi
if [ ! -L "$COMFY_DIR/models" ]; then
  rm -rf "$COMFY_DIR/models"
  ln -s "$MODELS" "$COMFY_DIR/models"
fi

export COMFY_MODELS_DIR="$MODELS"
export COMFY_URL="http://127.0.0.1:${COMFY_PORT}"
export OPENFIELD_DATA="$VOL/openfield-data"
export OPENFIELD_OUTPUT="$VOL/openfield-output"
export OPENFIELD_HOST="${OPENFIELD_HOST:-0.0.0.0}"
export OPENFIELD_PORT="${OPENFIELD_PORT:-3161}"
export OPENFIELD_JUDGE="${OPENFIELD_JUDGE:-1}"
export OPENFIELD_RENDER_TIER="${OPENFIELD_RENDER_TIER:-720p}"
export COMFY_PROXY_BIN="${COMFY_PROXY_BIN:-/opt/proxy/bin/comfy-api-proxy}"
# Judges cannot start the engine; this script owns it.
unset COMFY_LAUNCH

# ---------------------------------------------------------------- models ----
cat <<EOF

[openfield-runpod] License notes for the bundles on this pod ($BUNDLES):
  ltx25, cutout's video path, ltx-tools: LTX-2.x Community License. Free for any use,
    commercial included, under \$10M yearly revenue. Gated: accept it on
    https://huggingface.co/Lightricks/LTX-2.5 with the account behind HF_TOKEN.
  qwen, edit: Apache 2.0.   cutout (BiRefNet): MIT.
  Node packs: VideoHelperSuite and KJNodes are GPL-3.0, ComfyUI-LTXVideo is under LTX terms.
  Not installed here on purpose: h3 (license excludes the US, EU, UK and South Korea),
  flux2 and upres-ultrasharp (non-commercial).
EOF

if [ "${OPENFIELD_SKIP_DOWNLOAD:-0}" = "1" ]; then
  log "OPENFIELD_SKIP_DOWNLOAD=1: starting with what is already on $MODELS."
else
  [ -n "${HF_TOKEN:-}" ] || log "HF_TOKEN is not set. Gated LTX files will fail to download; anything already on the volume still works."
  log "Fetching bundles to $MODELS (resumable, finished files are skipped). The first boot downloads about 92 GB."
  cd "$OPENFIELD_DIR"
  if ! npm run -s models -- --only "$BUNDLES" --dest "$MODELS"; then
    log "Some downloads failed (see above). Starting anyway; the apps that need the missing files say so. Restart the pod to resume."
  fi
fi

# --------------------------------------------------------------- ComfyUI ----
log "Starting ComfyUI on 127.0.0.1:${COMFY_PORT}"
cd "$COMFY_DIR"
"$COMFY_PY" main.py --listen 127.0.0.1 --port "$COMFY_PORT" --preview-method auto \
  >> "$VOL/logs/comfyui.log" 2>&1 &
COMFY_PID=$!

waited=0
until curl -fsS "http://127.0.0.1:${COMFY_PORT}/system_stats" >/dev/null 2>&1; do
  kill -0 "$COMFY_PID" 2>/dev/null || { tail -n 40 "$VOL/logs/comfyui.log" >&2 || true; die "ComfyUI exited during startup (log above, full log in $VOL/logs/comfyui.log)."; }
  [ "$waited" -lt "$COMFY_WAIT" ] || die "ComfyUI did not answer within ${COMFY_WAIT}s. See $VOL/logs/comfyui.log."
  sleep 2
  waited=$((waited + 2))
done
log "ComfyUI is up after ${waited}s."

# ------------------------------------------------------------- Morpheus ----
cd "$OPENFIELD_DIR"
log "Starting Morpheus in judge mode on ${OPENFIELD_HOST}:${OPENFIELD_PORT} (cap ${OPENFIELD_JUDGE_CAP:-20} renders a day)."
if [ -n "${RUNPOD_POD_ID:-}" ]; then
  log "Open https://${RUNPOD_POD_ID}-${OPENFIELD_PORT}.proxy.runpod.net"
fi
# The doctor is informational here: a missing optional bundle is not fatal.
npm run -s doctor || log "The doctor reported problems (above). The preview still starts."
exec npm start
