# Installing Morpheus

A full walkthrough, starting from a machine with nothing on it. If you already
run ComfyUI, skip to step 3.

If you would rather not do this by hand, open this repository in Claude Code and
say "set up Morpheus". [`../CLAUDE.md`](../CLAUDE.md) contains the instructions for
an agent to run the whole thing.

---

## 0. What you need first

| | |
| --- | --- |
| GPU | 24 GB VRAM realistically. Built and measured on a 32 GB RTX 5090; NVIDIA is the only vendor tested. AMD through ROCm on Linux is untested (reports welcome). |
| Disk | About 72 GB for the core models, about 334 GB for everything. |
| OS | Linux or Windows, or WSL2 driving a Windows ComfyUI. macOS is untested. |
| Node | 22 or newer (`node -v`). |
| Python | 3.10 to 3.12, for ComfyUI. |
| HuggingFace | A free account plus a read token. LTX-2.5 is gated. |
| ffmpeg | `ffmpeg` and `ffprobe` on PATH (or `FFMPEG_BIN` / `FFPROBE_BIN` in `.env`). Stage, Remove background, Finish in HDR, the seam meter, Upscale and MCP previews use them. |

Stills work on much less VRAM than video. If you have 12 to 16 GB, install the
`qwen` bundle and expect video to be painful or impossible.

**Render size.** Every video app renders at one machine-wide size: 720p on a
card with 24 GB or more (LTX-2.5 looks far better there), 480p below that.
Change it in Setup > Render size or the GPU chip (the choice is stored on the
server, so every browser and the MCP server share it), or set
`OPENFIELD_RENDER_TIER=480p|720p|1080p` in `.env` to replace the GPU guess.
Each app keeps its own size chip. Mirror, Restyle, Object swap, Effects,
Speak, Extend and Transitions stop at 720p (they peak near 31 GB there on a
32 GB card); Reshoot stops at 480p (720p took nearly 3x as long for little
gain). Use Upscale past these.

---

## 1. ComfyUI

Skip if you have 0.38 or newer already (`git -C /path/to/ComfyUI describe --tags`).

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
pip install -r requirements.txt
python main.py --listen 127.0.0.1 --port 8188 --preview-method auto
```

Use the CUDA index URL that matches your card. Blackwell (50-series) needs cu128
or newer. Confirm it is up:

```bash
curl -s http://127.0.0.1:8188/system_stats
```

Leave it running. `--preview-method auto` turns on the live step-by-step
previews in Morpheus's render cards.

### The Comfy API v2 proxy

Morpheus runs every job through the Comfy SDK, which speaks Comfy API v2. A
self-hosted ComfyUI gets v2 from comfy-api-proxy, a small open-source service
that sits next to it:

```bash
pipx install comfy-api-proxy
comfy-api-proxy run        # serves v2 on 127.0.0.1:8189, proxies ComfyUI on :8188
```

On systems that block a global `pip install` (PEP 668, for example Ubuntu 24.04
and Debian 12), use `pipx` as above, or a virtual environment:

```bash
python3 -m venv ~/.venvs/comfy-api-proxy
~/.venvs/comfy-api-proxy/bin/pip install comfy-api-proxy
# then in Morpheus's .env:
# COMFY_PROXY_BIN=/home/you/.venvs/comfy-api-proxy/bin/comfy-api-proxy
```

You do not have to keep it running yourself: if `comfy-api-proxy` is on your
PATH (or named by `COMFY_PROXY_BIN` in `.env`), the Morpheus server starts it
when the v2 API is not answering, with its job state in `data/proxy/`.

**Comfy Cloud (experimental).** Local ComfyUI behind the proxy is the supported
path. Setting `COMFY_BASE_URL=https://cloud.comfy.org` and `COMFY_API_KEY` sends
the same SDK calls to Comfy Cloud, but that route is untested. Apps that need a
custom node pack Cloud lacks will fail there, and Object and Finish in HDR need
a local engine because they read outputs from ComfyUI's own history.

### Custom nodes

Video, Image, Director, Loop, Speak, Object and Cast use stock nodes. The other
apps need these packs:

| Pack | Needed by |
| --- | --- |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | Mirror, Reshoot, Effects (clip effects), Upscale, Extend, Transitions, Add sound, the seam fixer |
| [ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) | Reshoot, Effects, Extend, Transitions, Add sound, the seam fixer, Finish in HDR, Stage, Object swap |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Extend (backward lead-in), Object swap |
| [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) | Mirror and Restyle (pose, depth and edge preprocessors) |
| [ComfyUI-CrossViewWarp](https://github.com/cseti007/ComfyUI-CrossViewWarp) | Reshoot |
| [ComfyUI-Frame-Interpolation](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation) | Upscale Sharpen frame doubling, Director speed ramps |
| [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) | Upscale Redraw |

Clone them into `ComfyUI/custom_nodes/`, install their requirements into
ComfyUI's Python, and restart ComfyUI:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git
git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git
git clone https://github.com/kijai/ComfyUI-KJNodes.git
git clone https://github.com/Fannovel16/comfyui_controlnet_aux.git
git clone https://github.com/cseti007/ComfyUI-CrossViewWarp.git
git clone https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git
git clone https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git
pip install -r ComfyUI-VideoHelperSuite/requirements.txt
pip install -r ComfyUI-LTXVideo/requirements.txt
pip install -r ComfyUI-KJNodes/requirements.txt
pip install -r comfyui_controlnet_aux/requirements.txt
pip install -r ComfyUI-CrossViewWarp/requirements.txt
pip install -r ComfyUI-Frame-Interpolation/requirements-no-cupy.txt
pip install -r ComfyUI-SeedVR2_VideoUpscaler/requirements.txt
```

The SeedVR2 pack downloads any model it is asked for that is missing, up to
16 GB, on first use. Morpheus checks `models/SEEDVR2/` first and refuses to
start a Redraw whose weights are not there, so fetch them with
`npm run models -- --only seedvr2` where you can watch it.

---

## 2. A HuggingFace token

LTX-2.5, the default video engine, is a gated repository. Two steps, in order:

1. Open <https://huggingface.co/Lightricks/LTX-2.5> while logged in and accept
   the license. Downloads fail with 401 until you do, token or not.
2. Create a **read** token at <https://huggingface.co/settings/tokens>.

Everything else in the manifest downloads without a token.

---

## 3. Morpheus

```bash
git clone https://github.com/wexloops/openfield.git
cd openfield
npm install
cp .env.example .env
```

Edit `.env`. In most cases three lines is the whole configuration:

```bash
COMFY_URL=http://127.0.0.1:8188
COMFY_MODELS_DIR=/home/you/ComfyUI/models
HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
```

`COMFY_MODELS_DIR` is the folder containing `diffusion_models/`,
`text_encoders/`, `vae/` and `loras/`. Only the installer uses it. If ComfyUI
keeps its weights elsewhere through `extra_model_paths.yaml`, point this at
wherever you actually want new downloads to land, and make sure ComfyUI is
configured to read from there.

Optional, and worth setting on a workstation:

```bash
# Lets the START ENGINE button launch ComfyUI for you.
COMFY_LAUNCH=/home/you/ComfyUI/venv/bin/python /home/you/ComfyUI/main.py --preview-method auto
# WSL driving a Windows install:
COMFY_LAUNCH=cmd.exe /c start "" C:\path\to\ComfyUI\run.bat
```

---

## 4. The models

```bash
npm run models -- --list    # what you have and what you are missing
npm run models              # the core install: LTX-2.5 + Qwen, about 72 GB
```

This is a long download. It resumes, so an interrupted 21 GB pull picks up where
it stopped rather than starting over. Run the same command again after any
failure.

Adding more later (sizes and licenses from `server/models.ts`; "LTX terms" means
the LTX-2.x Community License, free for commercial use under $10M yearly revenue):

```bash
npm run models -- --only edit              # Edit + image apps, Restyle, Cast stills. 31.8 GB, Apache 2.0
npm run models -- --only mirror            # Mirror. 0.7 GB, LTX terms (pose/depth detectors Apache 2.0)
npm run models -- --only reshoot           # Reshoot. 1 GB, LTX terms (MoGe-2 MIT)
npm run models -- --only cast              # Cast in video. 1.3 GB, LTX terms, gated repo
npm run models -- --only effects           # Effects, Lightricks set. 3.1 GB, LTX terms, five gated repos
npm run models -- --only effects-community # Effects, community set. 5.6 GB, LTX terms
npm run models -- --only stage             # Stage shots. 1.3 GB, LTX terms, gated repo
npm run models -- --only stage-look        # Stage look frames (Z-Image Turbo). 23.8 GB, Apache 2.0
npm run models -- --only trellis2          # Object (image to 3D). 14 GB, MIT (DINOv3 under the Meta DINOv3 License)
npm run models -- --only hdr               # Finish in HDR. 1.3 GB, LTX terms, gated repo
npm run models -- --only cutout            # Remove background (BiRefNet). 0.4 GB, MIT
npm run models -- --only sam3              # SAM 3.1 tracking. 1.8 GB, Meta SAM License
npm run models -- --only swap              # Object swap. 1.3 GB, LTX terms, gated repo
npm run models -- --only upres             # Upscale Sharpen (RealESRGAN). 0.1 GB, BSD-3-Clause
npm run models -- --only upres-ultrasharp  # 4x-UltraSharp for Sharpen. 0.1 GB, NON-COMMERCIAL
npm run models -- --only seedvr2           # Upscale Redraw (3B + 7B + VAE). 23.8 GB, Apache 2.0
npm run models -- --only dream             # Upscale Dream. No weights beyond ltx25; checks VideoHelperSuite
npm run models -- --only ltx-tools         # Extend, Transitions, Add sound. No weights; checks the node packs
npm run models -- --only flux2             # FLUX.2 stills. 50.9 GB, NON-COMMERCIAL
npm run models -- --only h3                # MiniMax H3 video. 21.5 GB (the all-in-one checkpoint is added by hand), GEO-RESTRICTED
npm run models -- --only h3-turbo          # H3 8-step turbo distill. 2 GB, GEO-RESTRICTED
npm run models -- --all                    # everything, about 334 GB
```

Gated repos need their license accepted on Hugging Face, one page each, with the
same account as your token: the Lightricks IC-LoRA repos behind `cast`,
`effects`, `stage`, `hdr` and `swap` (see the lock icons in [`MODELS.md`](MODELS.md)).

Read the license line the installer prints before it fetches a bundle. H3
excludes the United States, the EU, the UK and South Korea. FLUX.2-dev,
and 4x-UltraSharp are non-commercial. Full table in
[`MODELS.md`](MODELS.md), every third-party license in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

**Restart ComfyUI after downloading.** It scans its model folders at startup, so
new files are invisible until it does.

---

## 5. Check, then run

```bash
npm run doctor
```

It checks the things that actually break: Node version, whether ComfyUI answers,
whether the weights are visible to it, whether the output folder is writable. Fix
anything it marks FAIL before going on.

```bash
npm run dev
```

Open <http://localhost:3160>.

To confirm the whole loop end to end, generate a still first: open Image and pick
**Draft**. It is the fastest render here and it exercises submit, the live
preview relay, and the file write.

### One port, for everyday use

`npm run dev` runs Vite on :3160 next to the API on :3161. For a single process
that serves the built UI and the API together on :3161:

```bash
npm run build
npm start                  # open http://localhost:3161
```

---

## Filming on your phone

Mirror and Reshoot have a **Use your phone** button. It shows a QR code; scan it
with a phone on the same Wi-Fi, film the move (or pick a clip), and it lands in
the clip slot on screen.

The main Morpheus server never leaves loopback. While the code is showing, and
only then, a second listener opens on this machine's LAN address
(`OPENFIELD_PHONE_PORT`, default 3162). It serves one mobile page and accepts one
upload, both behind a random single-use token that only exists in the QR code.
Uploads must be MP4, MOV or WebM by their actual bytes, at most 300 MB. The
listener closes after the first clip, after 10 minutes, on Cancel, or when you
leave the page.

If auto-detection picks the wrong network, set `OPENFIELD_PHONE_HOST` to this
machine's LAN address.

**WSL2.** With the default NAT networking the Linux side is not reachable from
your phone. Either switch WSL to mirrored networking (add
`networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig`, then
`wsl --shutdown`), or forward the port from Windows once, in an elevated
PowerShell (the app shows these lines with your addresses filled in):

```powershell
netsh interface portproxy add v4tov4 listenaddress=<windows-lan-ip> listenport=3162 connectaddress=<wsl-ip> connectport=3162
New-NetFirewallRule -DisplayName "Morpheus phone" -Direction Inbound -Protocol TCP -LocalPort 3162 -Action Allow -Profile Private
```

Mirrored mode can still need Hyper-V's firewall opened for the port; the app
shows that command under "Phone can't connect?". The forwarded port only reaches
something while a phone code is showing.

### Opening the whole app on your phone

Setup has a second phone feature, **Open on your phone**: scan the code and the
whole app opens in your phone's browser — the library, live renders, the queue —
as a second desktop paired to this machine.

While a pairing is live, and only then, a second listener opens on the LAN
(`OPENFIELD_PHONE_APP_PORT`, default 3163) that reverse-proxies the app. The
gate is a random token: it travels once in the QR code, then lives in an
HttpOnly cookie the proxy checks on every request, including the live
websocket. The pairing lasts an hour, or until you press Disconnect, or until
a new pairing replaces it. The same WSL2 and firewall notes above apply, with
the pairing's port.

The pairing carries full app privileges — it is your studio on your LAN, behind
a secret. The main server still never leaves loopback.

## Troubleshooting

**"ComfyUI is not answering."** It is not running, or it is on another port.
Check `curl http://127.0.0.1:8188/system_stats` and set `COMFY_URL` to match.

**The MODELS chip says something is missing, but the file is there.** ComfyUI
only rescans model folders at startup. Restart it. If it still cannot see the
file, the name is wrong: Morpheus resolves models by exact filename, so a
`-fp8` where the manifest says `_fp8` is a different file as far as it is
concerned. Compare against [`MODELS.md`](MODELS.md).

**A download 401s.** That is a gated repo. Accept the license on the model page while
logged in, then check `HF_TOKEN` is set in `.env`.

**Out of memory during a video render.** Drop to the ITERATE resolution preset,
shorten the clip, and close anything else holding the GPU. Morpheus warns in the
header when the card has almost no free VRAM while its own queue is empty, which
usually means another program has it.

**STOP does not stop instantly.** ComfyUI interrupts at node and step
boundaries. On a long sampler that can be a step, which at hero sizes is a while.
The request succeeded; the render has not noticed yet.

**Edits to the UI do not appear.** If you are running from a filesystem without
inotify, such as a Windows drive mounted into WSL, Vite cannot watch files.
Restart `npm run dev` and hard-refresh.

**Renders succeed but nothing lands.** Check the project folder path. It is a
path on the machine running the Morpheus server. Under WSL that means `/mnt/e/...`, not
`E:\...`; a Windows-style path creates a literally named directory.

---

## One-command install

`scripts/install.sh` runs steps 1 to 5 above in one go on Linux and WSL2,
asking before anything big:

```bash
bash scripts/install.sh            # interactive
bash scripts/install.sh --dry-run  # say what it would do, change nothing
bash scripts/install.sh --yes      # take every default (core bundles only)
```

It checks Node 22+, Python 3.10 to 3.12, ffmpeg, git, curl and the GPU; uses a
running ComfyUI (`COMFY_URL`, default :8188), a folder you point at, or clones
v0.38.2 to `~/ComfyUI` with PyTorch from the cu128 index (`TORCH_INDEX` picks
another); clones the custom node packs at the commits pinned in
`deploy/runpod/nodes.txt` (the core four by default, the rest on request) and
installs their requirements with ComfyUI's own Python; puts comfy-api-proxy in
`~/.venvs/comfy-api-proxy` (safe where a global pip install is refused); writes
`.env` (the Hugging Face token is read hidden and never printed); then runs
`npm ci`, lists the bundles with their license notes, downloads the ones you
pick, and runs the doctor. Re-running it is safe: finished steps are skipped
and downloads resume from `<file>.part`.

For a ComfyUI on the Windows side under WSL2, give its folder as
`/mnt/<drive>/...`. The script cannot install node requirements into a Windows
Python; it says so, and you run those `pip install` lines from Windows.

**Native Windows.** `scripts/install.ps1` does the same steps in PowerShell
(`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`, with
`-DryRun` and `-Yes`), and finds a venv or portable ComfyUI's Python. Node,
ComfyUI, comfy-api-proxy, curl and ffmpeg all run on Windows and `npm start`
no longer depends on a Unix shell, but Morpheus has not been run end to end on
native Windows. If anything misbehaves there, use WSL2 and `install.sh`.

**A preview for other people.** To put Morpheus on the internet for a while
(contest judges, a demo), do not open your own machine: see
[`RUNPOD.md`](RUNPOD.md) for a password-gated judge mode on a rented GPU.

