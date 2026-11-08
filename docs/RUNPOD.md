# Judge preview on Runpod

A password-gated, live Morpheus for the contest judges, on a rented Runpod GPU
that runs only while judging is open. Your own machine is never exposed: the
pod has its own ComfyUI, its own models and its own job history.

What judges get: the full Morpheus UI behind a sign-in page, with draft limits
(5 seconds, 720p, one take per render, a few variants at most), a daily render
cap shared by everyone (20 by default), and a slim "Judge preview" strip that
says so. Setup is read-only; phone capture, project folders, HDR, Upscale
Redraw 7B, Object High and deleting are off. Everything in `server/judge.ts`.

The pieces live in [`deploy/runpod/`](../deploy/runpod/):

| File | What it is |
| --- | --- |
| `Dockerfile` | CUDA 12.8 on Ubuntu 24.04, Node 22, ffmpeg, ComfyUI v0.38.2, pinned node packs, comfy-api-proxy 0.1.6, Morpheus built |
| `nodes.txt` | The custom node packs baked in, each pinned by commit |
| `start.sh` | First boot: models to the volume. Every boot: ComfyUI, then Morpheus in judge mode on port 3161 |
| `template.json` | A Runpod template (REST `POST /v1/templates` body) with the image name left as `REPLACE_ME` |

---

## What you need

- A Runpod account with a payment method (pods bill per second while running).
- A Docker Hub account (or any registry Runpod can pull from) for the image.
- A Hugging Face account that has **accepted the LTX-2.5 license** at
  <https://huggingface.co/Lightricks/LTX-2.5>, and a read token from
  <https://huggingface.co/settings/tokens>.
- A judge password: 8 characters or more, one you are happy to paste into the
  submission form.

## 1. Build and push the image

From the repository root, on any machine with Docker (no GPU needed):

```bash
docker build -f deploy/runpod/Dockerfile -t <dockerhub-user>/openfield-runpod:0.1.0 .
docker login
docker push <dockerhub-user>/openfield-runpod:0.1.0
```

If you already built it locally as `openfield-runpod:local-test`, `docker tag`
it instead of building again. The image is about 14 GB and holds no models and no secrets, so a public
repository is fine. For a private one, add your registry login under Runpod >
Settings > Container registry auth and pick it on the template.

## 2. Make a network volume

Runpod > Storage > New network volume: **150 GB** in a data center that has the
GPU you want (check availability first; a volume is tied to its data center).
The demo bundles take about 92 GB; the rest is headroom for renders and logs.

## 3. Add two secrets

Runpod > Secrets:

- `openfield_judge_password`: the judge password.
- `hf_token`: the Hugging Face read token.

The template reads them as `{{ RUNPOD_SECRET_openfield_judge_password }}` and
`{{ RUNPOD_SECRET_hf_token }}`, so neither is ever typed into a template or
shown in the pod's settings.

## 4. Create the template

Either in the console (Templates > New template) with the values from
`deploy/runpod/template.json`, or through the API:

```bash
sed 's#REPLACE_ME/openfield-runpod:0.1.0#<dockerhub-user>/openfield-runpod:0.1.0#' deploy/runpod/template.json > /tmp/of-template.json
curl -s https://rest.runpod.io/v1/templates \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
  --data @/tmp/of-template.json
```

The settings that matter: container disk 40 GB, volume mount path `/workspace`,
HTTP port `3161`, and these environment variables:

| Variable | Value | |
| --- | --- | --- |
| `OPENFIELD_JUDGE_PASSWORD` | `{{ RUNPOD_SECRET_openfield_judge_password }}` | required; the pod refuses to start without it |
| `HF_TOKEN` | `{{ RUNPOD_SECRET_hf_token }}` | needed on the first boot only |
| `OPENFIELD_JUDGE_CAP` | `20` | renders per UTC day, across all apps |
| `OPENFIELD_BUNDLES` | `ltx25,qwen,edit,cutout,ltx-tools` | what the first boot downloads |
| `OPENFIELD_SKIP_DOWNLOAD` | `0` | `1` starts with whatever is on the volume |

## 5. First boot (do this a day before judging)

Deploy a pod: pick the template, attach the network volume, and choose a GPU
with **24 GB or more**:

- **RTX 5090 (32 GB)**: what Morpheus was built and measured on. Best match.
- **L40S (48 GB)**: the most headroom, a little slower than a 5090.
- **RTX 4090 (24 GB)**: works at 720p, with some offloading on the heavier apps.

The first boot downloads about 92 GB to `/workspace/models` (resumable: if the
pod stops, the next boot carries on). Watch the pod's logs. When you see
`Morpheus on http://0.0.0.0:3161`, open:

```
https://<pod id>-3161.proxy.runpod.net
```

(the pod's Connect menu shows the same link). Sign in, render one still and one
short video, and check that both play. Then **stop** the pod. The volume keeps
the models, so later boots take a few minutes.

If something fails: `/workspace/logs/comfyui.log` has ComfyUI's log, and the
pod log shows the doctor's report and Morpheus's own output.

## 6. During judging

Start the pod when judging opens and give the judges the link and password.
The cap resets at midnight UTC; raise `OPENFIELD_JUDGE_CAP` and restart the
pod if they run out. Every judge shares one queue on one GPU, so renders wait
their turn.

**Stop the pod as soon as judging closes.** A stopped pod costs nothing for
compute; only the volume keeps billing. Delete the volume after the contest.

## Cost

Runpod list prices, October 2026 (check the pricing page; community cloud is
cheaper than secure cloud):

| | Rate | One judging day (8 hours up) | Left up 24 hours |
| --- | --- | --- | --- |
| RTX 5090 | about $0.69 to $1.19 an hour | about $6 to $10 | about $17 to $29 |
| L40S | about $0.86 to $1.09 an hour | about $7 to $9 | about $21 to $26 |
| RTX 4090 | about $0.59 to $0.89 an hour | about $5 to $7 | about $14 to $21 |
| Network volume, 150 GB | $0.07 per GB a month | about $0.35 a day | $10.50 a month |

The first boot adds roughly an hour of GPU time for the downloads (about $1),
unless you do it on the cheapest GPU in the same data center and switch for
judging. The daily cap bounds how busy the GPU gets, not how long it is up:
the meter runs whenever the pod is running.

## What judge mode does, exactly

- `OPENFIELD_JUDGE=1` binds `0.0.0.0` and accepts any Host header; every route
  (the API, the `/live` socket and the UI) needs the sign-in cookie. Normal
  mode is unchanged: loopback only, with the DNS-rebinding guard.
- The cookie is HMAC-signed with a key derived from the password, `HttpOnly`,
  `SameSite=Strict`, `Secure` when the proxy reports HTTPS, and lasts 7 days.
  Changing the password signs everyone out.
- Five wrong passwords from one address, or 40 overall, lock sign-in for 15
  minutes.
- A render request reserves its count against the cap before anything runs; a
  request that then fails (engine down, missing model) gives it back. The
  count is kept in `/workspace/openfield-data/judge-usage.json`.
- `npm run test:judge` checks all of this without a GPU.
