#!/usr/bin/env bash
# Morpheus one-command install for Linux and WSL2.
#
#   bash scripts/install.sh            interactive
#   bash scripts/install.sh --yes      take every default (core bundles only)
#   bash scripts/install.sh --dry-run  say what it would do, change nothing
#
# What it does, asking before anything big:
#   1. checks Node 22+, Python 3.10 to 3.12, ffmpeg/ffprobe, git, curl and the GPU;
#   2. finds a running ComfyUI (COMFY_URL, default :8188), or a folder you point
#      at, or clones one (0.38.2);
#   3. clones the custom node packs at pinned commits (deploy/runpod/nodes.txt);
#   4. installs comfy-api-proxy in its own venv (safe on PEP 668 systems);
#   5. writes .env (the HuggingFace token is read without echo and never printed);
#   6. npm ci, lists the model bundles, asks which to fetch, downloads them;
#   7. runs the doctor.
# Re-running it is safe: finished steps are skipped, downloads resume.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
NODES_TXT="$ROOT/deploy/runpod/nodes.txt"
COMFY_REF="v0.38.2"
PROXY_VERSION="0.1.6"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"
YES=0
DRY=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m    %s\n' "$*"; }
note() { printf '\033[33m  note\033[0m  %s\n' "$*"; }
bad()  { printf '\033[31m  fail\033[0m  %s\n' "$*"; }
die()  { bad "$*"; exit 1; }
step() { printf '\n'; bold "$*"; }

# Run a command, or only show it under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi
}

# ask "question" default -> answer in $REPLY
ask() {
  local q="$1" def="${2:-}"
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then REPLY="$def"; printf '  %s [%s] %s\n' "$q" "$def" "$def"; return; fi
  read -r -p "  $q [$def] " REPLY || REPLY=""
  REPLY="${REPLY:-$def}"
}
yes_no() { ask "$1 (y/n)" "${2:-y}"; [[ "$REPLY" =~ ^[Yy] ]]; }

# Set KEY=value in .env, replacing an existing line (commented or not). Never echoes the value.
set_env() {
  local key="$1" value="$2"
  if [ "$DRY" = 1 ]; then printf '  would set %s in .env\n' "$key"; return; fi
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  local tmp; tmp="$(mktemp)"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    $0 ~ "^[# ]*" k "=" { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
env_has() { [ -f "$ENV_FILE" ] && grep -Eq "^$1=.+" "$ENV_FILE"; }

cd "$ROOT"
bold "Morpheus install"
[ "$DRY" = 1 ] && note "Dry run: nothing is installed or written."

# --------------------------------------------------------------- 1. checks ----
step "1. Prerequisites"
command -v node >/dev/null || die "Node is not installed. Install Node 22 or newer (https://nodejs.org or nvm), then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) is too old. Morpheus needs 22 or newer (the Comfy SDK requires it)."
ok "Node $(node -v)"
for t in git curl; do command -v "$t" >/dev/null || die "$t is not installed."; done
ok "git, curl"

PY=""
for c in python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null; then
    v="$("$c" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
    case "$v" in 3.10|3.11|3.12) PY="$c"; break ;; esac
  fi
done
if [ -n "$PY" ]; then ok "Python $("$PY" -V 2>&1 | cut -d' ' -f2) ($PY)"; else note "No Python 3.10 to 3.12 found. Needed only if this script installs ComfyUI or the proxy here."; fi
if "${PY:-python3}" -m venv --help >/dev/null 2>&1; then :; else note "python venv is missing (Debian/Ubuntu: sudo apt install python3-venv)."; fi

if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then ok "ffmpeg, ffprobe"
else note "ffmpeg/ffprobe not on PATH. Stage, Remove background, HDR, the seam meter and Upscale need them (sudo apt install ffmpeg)."; fi

VRAM_GB=0
if command -v nvidia-smi >/dev/null; then
  GPU_LINE="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || true)"
  if [ -n "$GPU_LINE" ]; then
    VRAM_GB=$(( ${GPU_LINE##*, } / 1024 ))
    ok "GPU ${GPU_LINE%%,*}, about ${VRAM_GB} GB"
    if [ "$VRAM_GB" -lt 16 ]; then note "Under 16 GB: plan on stills only; video will be very slow or fail."
    elif [ "$VRAM_GB" -lt 23 ]; then note "Under 24 GB: video offloads and is slow, and defaults to 480p."; fi
  fi
else
  note "nvidia-smi not found. Morpheus needs an NVIDIA GPU for local renders."
fi
WSL=0; grep -qi microsoft /proc/version 2>/dev/null && WSL=1
[ "$WSL" = 1 ] && note "WSL detected. A ComfyUI on the Windows side works too: point at its folder under /mnt/<drive>/."

# -------------------------------------------------------------- 2. ComfyUI ----
step "2. ComfyUI (0.38 or newer)"
COMFY_URL_DEFAULT="${COMFY_URL:-http://127.0.0.1:8188}"
COMFY_DIR=""
COMFY_PYBIN=""
COMFY_RUNNING=0
if curl -fsS --max-time 3 "$COMFY_URL_DEFAULT/system_stats" >/dev/null 2>&1; then
  COMFY_RUNNING=1
  # system_stats carries the version and ComfyUI's own argv (main.py's path gives the folder).
  read -r ver hint < <(curl -fsS --max-time 3 "$COMFY_URL_DEFAULT/system_stats" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const j = JSON.parse(s).system ?? {}; const m = (j.argv ?? [])[0] ?? "";
        console.log((j.comfyui_version ?? "?") + " " + m.replace(/[\\/]main\.py$/i, "")); } catch { console.log("? "); }
    });') || true
  if [[ "$hint" =~ ^[A-Za-z]: ]] && command -v wslpath >/dev/null; then hint="$(wslpath -u "$hint" 2>/dev/null || echo "$hint")"; fi
  [ -d "${hint:-/nonexistent}" ] || hint=""
  ok "ComfyUI is running at $COMFY_URL_DEFAULT (v${ver:-?})"
  ask "Where is that ComfyUI folder? (for custom nodes and models; blank to skip)" "$hint"
  COMFY_DIR="$REPLY"
else
  note "Nothing answers at $COMFY_URL_DEFAULT."
  ask "Path to an existing ComfyUI folder, or 'clone' to install one at ~/ComfyUI" "clone"
  if [ "$REPLY" = "clone" ]; then
    COMFY_DIR="$HOME/ComfyUI"
    [ -n "$PY" ] || die "Installing ComfyUI needs Python 3.10 to 3.12."
    if [ -d "$COMFY_DIR/.git" ]; then ok "$COMFY_DIR already exists, keeping it"
    else
      yes_no "Clone ComfyUI $COMFY_REF into $COMFY_DIR and install PyTorch (about 5 GB)?" y || die "Install ComfyUI yourself (docs/INSTALL.md step 1), then re-run."
      run git clone --filter=blob:none https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
      run git -C "$COMFY_DIR" checkout --quiet "$COMFY_REF"
    fi
    if [ ! -x "$COMFY_DIR/venv/bin/python" ]; then
      run "$PY" -m venv "$COMFY_DIR/venv"
      run "$COMFY_DIR/venv/bin/pip" install --upgrade pip wheel
      note "PyTorch from $TORCH_INDEX (set TORCH_INDEX for another CUDA build; 50-series cards need cu128 or newer)."
      run "$COMFY_DIR/venv/bin/pip" install torch torchvision torchaudio --index-url "$TORCH_INDEX"
      run "$COMFY_DIR/venv/bin/pip" install -r "$COMFY_DIR/requirements.txt"
    fi
  else
    COMFY_DIR="$REPLY"
  fi
fi
COMFY_DIR="${COMFY_DIR/#\~/$HOME}"
if [ -n "$COMFY_DIR" ]; then
  [ -d "$COMFY_DIR" ] || [ "$DRY" = 1 ] || die "$COMFY_DIR does not exist."
  for p in "$COMFY_DIR/venv/bin/python" "$COMFY_DIR/.venv/bin/python"; do [ -x "$p" ] && { COMFY_PYBIN="$p"; break; }; done
  if [ -z "$COMFY_PYBIN" ] && [ -x "$HOME/ComfyUI/venv/bin/python" ] && [ "$COMFY_DIR" = "$HOME/ComfyUI" ]; then COMFY_PYBIN="$HOME/ComfyUI/venv/bin/python"; fi
  [ "$DRY" = 1 ] && [ -z "$COMFY_PYBIN" ] && [ "$COMFY_DIR" = "$HOME/ComfyUI" ] && COMFY_PYBIN="$COMFY_DIR/venv/bin/python"
  if [ -n "$COMFY_PYBIN" ]; then ok "ComfyUI's Python: $COMFY_PYBIN"
  else note "No Linux venv in $COMFY_DIR (a Windows or portable install?). Node pack requirements must be installed with that ComfyUI's own Python."; fi
fi

# ----------------------------------------------------------- 3. node packs ----
step "3. Custom node packs (pinned)"
if [ -z "$COMFY_DIR" ]; then
  note "No ComfyUI folder given, skipping. docs/INSTALL.md lists the packs to clone by hand."
else
  # Uncommented lines in nodes.txt are the core set; commented ones are optional.
  # The list is on fd 3 so the questions inside the loop still read the terminal.
  while read -r opt name url commit req <&3; do
    dest="$COMFY_DIR/custom_nodes/$name"
    if [ -d "$dest/.git" ]; then ok "$name already present"; continue; fi
    if [ "$opt" = "#" ]; then yes_no "Optional pack $name?" n || continue; fi
    run git clone --filter=blob:none "$url" "$dest"
    run git -C "$dest" checkout --quiet "$commit"
    if [ -n "$COMFY_PYBIN" ]; then
      if [ "$DRY" = 1 ] || [ -f "$dest/$req" ]; then run "$COMFY_PYBIN" -m pip install -r "$dest/$req"; fi
    else
      note "Install $name's $req with your ComfyUI's Python."
    fi
  done 3< <(grep -E '^(# )?[A-Za-z].* https://github.com/' "$NODES_TXT" | sed -E 's/^([A-Za-z])/- \1/')
fi

# --------------------------------------------------------------- 4. proxy ----
step "4. comfy-api-proxy (Comfy API v2)"
PROXY_BIN=""
if command -v comfy-api-proxy >/dev/null; then PROXY_BIN="$(command -v comfy-api-proxy)"; ok "found $PROXY_BIN"
elif env_has COMFY_PROXY_BIN; then PROXY_BIN="$(grep -E '^COMFY_PROXY_BIN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"; ok "from .env: $PROXY_BIN"
else
  VENV="$HOME/.venvs/comfy-api-proxy"
  [ -n "$PY" ] || die "comfy-api-proxy needs Python 3.10 or newer."
  if [ ! -x "$VENV/bin/comfy-api-proxy" ]; then
    run "$PY" -m venv "$VENV"
    run "$VENV/bin/pip" install "comfy-api-proxy==$PROXY_VERSION"
  fi
  PROXY_BIN="$VENV/bin/comfy-api-proxy"
  ok "installed in $VENV (Morpheus starts it for you)"
fi

# ----------------------------------------------------------------- 5. .env ----
step "5. Settings (.env)"
if [ ! -f "$ENV_FILE" ] && [ "$DRY" = 0 ]; then cp .env.example "$ENV_FILE"; chmod 600 "$ENV_FILE"; ok "created .env from .env.example"; fi
set_env COMFY_URL "$COMFY_URL_DEFAULT"
set_env COMFY_PROXY_BIN "$PROXY_BIN"
MODELS_DIR=""
if [ -n "$COMFY_DIR" ]; then MODELS_DIR="$COMFY_DIR/models"; set_env COMFY_MODELS_DIR "$MODELS_DIR"; fi
if [ -n "$COMFY_PYBIN" ] && ! env_has COMFY_LAUNCH; then
  set_env COMFY_LAUNCH "$COMFY_PYBIN $COMFY_DIR/main.py --listen 127.0.0.1 --port 8188 --preview-method auto"
  ok "COMFY_LAUNCH set: Morpheus can start ComfyUI (with live previews)"
fi
if env_has HF_TOKEN || [ -n "${HF_TOKEN:-}" ]; then
  ok "HF_TOKEN already set"
  [ -n "${HF_TOKEN:-}" ] && ! env_has HF_TOKEN && set_env HF_TOKEN "$HF_TOKEN"
else
  echo "  LTX-2.5 is gated. Open https://huggingface.co/Lightricks/LTX-2.5, accept the license,"
  echo "  then make a read token at https://huggingface.co/settings/tokens."
  if [ "$YES" = 0 ] && [ -t 0 ]; then
    read -r -s -p "  Paste the token (hidden; blank to skip): " TOKEN || TOKEN=""
    echo
    if [ -n "$TOKEN" ]; then set_env HF_TOKEN "$TOKEN"; ok "HF_TOKEN saved to .env (not shown)"; else note "Skipped. Gated downloads will fail until HF_TOKEN is in .env."; fi
    unset TOKEN
  else
    note "No HF_TOKEN. Gated downloads will fail until it is in .env."
  fi
fi

# -------------------------------------------------------------- 6. models ----
step "6. App and models"
run npm ci --no-audit --no-fund
if [ "$DRY" = 1 ]; then echo "  would run: npm run models -- --list"; else npm run -s models -- --list || true; fi
cat <<'EOF'
  Core: ltx25 (40 GB) + qwen (32 GB), both commercial use allowed. The right default.
  Licenses to know before picking more:
    h3, h3-turbo: the H3 license EXCLUDES the US, the EU, the UK and South Korea. h3 needs the all-in-one checkpoint added by hand (not downloaded).
    flux2 and upres-ultrasharp: NON-COMMERCIAL.
    effects, cast, stage, hdr, swap: LTX terms, each repo gated separately on Hugging Face.
EOF
ask "Bundles to download (comma list, 'core' for ltx25,qwen, 'none' to skip)" "core"
PICK="$REPLY"
[ "$PICK" = "core" ] && PICK="ltx25,qwen"
if [ "$PICK" != "none" ] && [ -n "$PICK" ]; then
  if [ -z "$MODELS_DIR" ] && ! env_has COMFY_MODELS_DIR; then
    ask "ComfyUI models folder (holds diffusion_models/, vae/, loras/)" ""
    MODELS_DIR="${REPLY/#\~/$HOME}"
    [ -n "$MODELS_DIR" ] && set_env COMFY_MODELS_DIR "$MODELS_DIR"
  fi
  if [ "$DRY" = 1 ]; then echo "  would run: npm run models -- --only $PICK"
  else
    npm run -s models -- --only "$PICK" --dry-run | tail -n 4 || true
    if yes_no "Download these now? (resumable; re-run this script to continue)" y; then
      npm run -s models -- --only "$PICK" || note "Some files failed. Re-run to resume; check HF_TOKEN and the license pages."
    fi
  fi
fi

# -------------------------------------------------------------- 7. doctor ----
step "7. Check"
if [ "$COMFY_RUNNING" = 1 ]; then
  note "ComfyUI only sees new models after a restart. Restart it now."
  [ "$YES" = 1 ] || [ ! -t 0 ] || read -r -p "  Press Enter when ComfyUI is back up. " _ || true
elif [ -n "$COMFY_PYBIN" ] && [ "$DRY" = 0 ]; then
  if yes_no "Start ComfyUI now in the background (log: ~/comfyui.log)?" y; then
    (cd "$COMFY_DIR" && nohup "$COMFY_PYBIN" main.py --listen 127.0.0.1 --port 8188 --preview-method auto > "$HOME/comfyui.log" 2>&1 &)
    for _ in $(seq 1 90); do curl -fsS --max-time 2 "$COMFY_URL_DEFAULT/system_stats" >/dev/null 2>&1 && break; sleep 2; done
  fi
fi
if [ "$DRY" = 1 ]; then echo "  would run: npm run doctor"
elif npm run -s doctor; then
  bold "Ready. npm run dev, then open http://localhost:3160 (or npm run build && npm start for one port, http://localhost:3161)."
else
  note "Fix what the doctor marks FAIL, then run npm run doctor again."
fi
