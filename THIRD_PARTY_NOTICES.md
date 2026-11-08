# Third-party notices

Morpheus's own code is MIT (see [`LICENSE`](LICENSE)). It **redistributes no
model weights and no ComfyUI custom nodes**. Weights are downloaded by you, from
their publishers, by `npm run models` or by the node packs on first use. Each one
stays under its own license, listed below. Accepting those licenses, and
following them, is up to you.

Licenses were checked against each primary source (Hugging Face model card or
LICENSE file, GitHub repo LICENSE, npm or PyPI metadata) on 2026-10-17. Where a
source did not say, the table says **unverified**. This is a summary, not legal
advice. The linked license text is what binds you.

**Commercial use** means running the model for paid or revenue-generating work.

| Mark | Meaning |
| --- | --- |
| **Yes** | Commercial use permitted under the license's normal conditions. |
| **Yes, under $10M** | Free under US$10M yearly revenue (affiliates counted together). Above that, a paid license from the publisher. |
| **NO (non-commercial)** | Non-commercial use only. |
| **GEO-RESTRICTED** | Not licensed at all in some countries. |

## What this means for each app

| App | Default path | Commercial? |
| --- | --- | --- |
| Video, Seamless Loop, Director | LTX-2.5 | Yes, under $10M |
| Image | Qwen-Image | Yes |
| Image with FLUX.2 | FLUX.2-dev | **NO (non-commercial)** |
| Edit and the image apps (New angle, Coverage, Push in, Next beat, Relight, Expand) | Qwen-Image-Edit 2509 + Lightning / Multiple-angles LoRAs | Yes |
| Video with MiniMax H3 | MiniMax H3 | **GEO-RESTRICTED**: not licensed in the US, EU, UK or South Korea |
| Mirror, pose or edges | LTX-2.5 + IC-LoRA + DWPose / Canny | Yes, under $10M |
| Mirror, depth | adds Depth Anything V2 Small | Yes |
| Mirror > Restyle | Qwen-Image-Edit 2509 + LTX-2.5 + IC-LoRA Union Control (+ Depth Anything V2 Small for depth) | Yes, under $10M |
| Mirror > Object swap (experimental) | SAM 3.1 + Qwen-Image-Edit 2509 + LTX-2.5 + in/outpainting IC-LoRA | Yes, under $10M (SAM 3.1: Meta SAM License, see below) |
| Remove background, stills and clips | BiRefNet (+ SAM 3.1 for the steady and tracked clip modes) | Yes (SAM 3.1: Meta SAM License, see below) |
| Reshoot | LTX-2.5 + CrossView-Warp + MoGe-2 | Yes, under $10M |
| Effects | LTX-2.5 + one Lightricks or kabachuha LoRA per effect | Yes, under $10M |
| Extend, Transitions, Speak, Add sound | LTX-2.5 | Yes, under $10M |
| Upscale, Sharpen (default) | RealESRGAN x4plus | Yes |
| Upscale, Sharpen with 4x-UltraSharp (opt-in `upres-ultrasharp`) | 4x-UltraSharp | **NO (non-commercial)** |
| Upscale, Redraw | SeedVR2 3B / 7B | Yes |
| Upscale, Dream | LTX-2.5 + its x2 latent upscaler | Yes, under $10M |
| Improve the seam (trim) | none: frames are only cut | Yes |
| Improve the seam (re-render, bridge, new seed) | LTX-2.5 | Yes, under $10M |
| Finish in HDR | LTX-2.5 + SDR-to-HDR IC-LoRA and scene embeddings | Yes, under $10M |
| Stage (shot) | LTX-2.5 + Layout-to-Render IC-LoRA | Yes, under $10M |
| Stage (look frame) | Z-Image Turbo + Fun ControlNet Union, or Qwen-Image-Edit 2509 | Yes |
| Object (image to 3D), Make 3D | TRELLIS.2 + DINOv3 ViT-L + BiRefNet | Yes (DINOv3 under its acceptable-use terms) |

## Models

| Model | Author | License | Commercial use | Source |
| --- | --- | --- | --- | --- |
| LTX-2.5 22B distilled transformer, video VAE, audio VAE, x2 latent upscaler | Lightricks | LTX-2.x Community License Agreement (Aug 11, 2026) | Yes, under $10M | [HF Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 text encoder (`gemma4-12b-with-proj-ltx-2.5`, Gemma 4 12B + LTX projections) | Lightricks, on Google Gemma 4 | Distributed in the LTX-2.5 repo under the LTX-2.x Community License. Base Gemma 4 is Apache 2.0. | Yes, under $10M | [HF Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5), [Gemma 4 license](https://ai.google.dev/gemma/docs/gemma_4_license) |
| Qwen-Image (fp8) and its VAE | Alibaba Qwen, repackaged by Comfy Org | Apache 2.0 | Yes | [HF Qwen/Qwen-Image](https://huggingface.co/Qwen/Qwen-Image), [HF Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI) |
| Qwen-Image-Edit 2509 (fp8) | Alibaba Qwen, repackaged by Comfy Org | Apache 2.0 | Yes | [HF Qwen/Qwen-Image-Edit-2509](https://huggingface.co/Qwen/Qwen-Image-Edit-2509), [HF Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) |
| Qwen2.5-VL 7B text encoder (fp8) | Alibaba Qwen, repackaged by Comfy Org | Apache 2.0 | Yes | [HF Qwen/Qwen2.5-VL-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct) |
| FLUX.2-dev (fp8mixed) and FLUX.2 VAE | Black Forest Labs, repackaged by Comfy Org | FLUX Non-Commercial License | **NO (non-commercial)**. The license says outputs may be used for any purpose, but the model itself may only be run for non-commercial purposes; revenue-generating use needs a [BFL commercial license](https://bfl.ai/licensing). | [HF black-forest-labs/FLUX.2-dev](https://huggingface.co/black-forest-labs/FLUX.2-dev) (gated), [license text](https://github.com/black-forest-labs/flux2/tree/main/model_licenses) |
| Mistral Small 3 text encoder for FLUX.2 (fp4) | Mistral AI, repackaged by Comfy Org | Upstream Mistral Small 3.2 is Apache 2.0; the Comfy-Org FLUX.2 repo distributes it under the FLUX non-commercial terms | **NO** as used here (only runs with FLUX.2-dev) | [HF Comfy-Org/flux2-dev](https://huggingface.co/Comfy-Org/flux2-dev), [HF mistralai/Mistral-Small-3.2-24B-Instruct-2506](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506) |
| MiniMax H3 FL2VA and Ref2VA (pruned fp8), video VAE, audio VAE | MiniMax, repackaged by Comfy Org | MiniMax H3 Community License Agreement. Licensed only outside the Excluded Territories (US, EU, UK, South Korea). Over US$20M yearly revenue needs written authorization. Commercial products must display "MiniMax H3" in the UI. | **GEO-RESTRICTED**. Elsewhere: yes, with the conditions listed. | [HF MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3), [license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE), [HF Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) |
| Qwen3-VL 32B text encoder for H3 (nvfp4 AWQ) | Alibaba Qwen, quantized and distributed by Comfy Org in the H3 repo | Upstream Qwen3-VL-32B is Apache 2.0; distributed here inside the H3 repo under the H3 license | **GEO-RESTRICTED** as used here | [HF Qwen/Qwen3-VL-32B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-32B-Instruct), [HF Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) |
| LTX-2.3 22B dev (fp8), x2 spatial upscaler (legacy `ltx23` bundle) | Lightricks | LTX-2 Community License Agreement (Jan 5, 2026) | Yes, under $10M | [HF Lightricks/LTX-2.3-fp8](https://huggingface.co/Lightricks/LTX-2.3-fp8), [HF Lightricks/LTX-2.3](https://huggingface.co/Lightricks/LTX-2.3), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |
| Gemma 3 12B IT text encoder (fp4, legacy `ltx23` bundle) | Google, repackaged by Comfy Org | Gemma Terms of Use (Comfy-Org repo card lists the LTX-2 license) | Yes, subject to the Gemma Prohibited Use Policy | [HF google/gemma-3-12b-it](https://huggingface.co/google/gemma-3-12b-it), [HF Comfy-Org/ltx-2](https://huggingface.co/Comfy-Org/ltx-2), [terms](https://ai.google.dev/gemma/terms) |
| MoGe-2 ViT-L normal (fp16) | Microsoft Research, repackaged by Comfy Org | MIT | Yes | [HF Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe), [HF Ruicheng/moge-2-vitl-normal](https://huggingface.co/Ruicheng/moge-2-vitl-normal), [GitHub microsoft/MoGe](https://github.com/microsoft/MoGe) |
| DWPose whole-body pose (`dw-ll_ucoco_384_bs5.torchscript.pt`) | IDEA Research; TorchScript export by hr16 | Apache 2.0 | Yes | [HF hr16/DWPose-TorchScript-BatchSize5](https://huggingface.co/hr16/DWPose-TorchScript-BatchSize5), [HF yzd-v/DWPose](https://huggingface.co/yzd-v/DWPose), [GitHub IDEA-Research/DWPose](https://github.com/IDEA-Research/DWPose) |
| YOLOX-L person detector (`yolox_l.onnx`) | Megvii; hosted in the DWPose repo | Apache 2.0 | Yes | [HF yzd-v/DWPose](https://huggingface.co/yzd-v/DWPose), [GitHub Megvii-BaseDetection/YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) |
| Depth Anything V2 Small (`depth_anything_v2_vits.pth`), Mirror depth mode | Depth Anything team (HKU / TikTok) | Apache 2.0 (the Base, Large and Giant models are CC BY-NC 4.0; Morpheus uses Small) | Yes | [HF depth-anything/Depth-Anything-V2-Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small), [GitHub DepthAnything/Depth-Anything-V2](https://github.com/DepthAnything/Depth-Anything-V2#license) |
| RealESRGAN x4plus (`RealESRGAN_x4plus.pth`), the Upscale Sharpen default | Xintao Wang et al. | BSD-3-Clause | Yes | [GitHub xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (v0.1.0 release). The installer fetches a byte-identical copy from [HF lllyasviel/Annotators](https://huggingface.co/lllyasviel/Annotators). |
| 4x-UltraSharp (`4x-UltraSharp.pth`), opt-in Upscale Sharpen model (`upres-ultrasharp` bundle) | Kim2091 | CC BY-NC-SA 4.0 | **NO (non-commercial)** | [HF Kim2091/UltraSharp](https://huggingface.co/Kim2091/UltraSharp) |
| SeedVR2 3B and 7B (`seedvr2_ema_3b_fp16`, `seedvr2_ema_7b_fp16`) and VAE (`ema_vae_fp16`), Upscale Redraw | ByteDance Seed; fp16 repackage by numz | Apache 2.0 | Yes | [HF numz/SeedVR2_comfyUI](https://huggingface.co/numz/SeedVR2_comfyUI), [HF ByteDance-Seed/SeedVR2-3B](https://huggingface.co/ByteDance-Seed/SeedVR2-3B), [HF ByteDance-Seed/SeedVR2-7B](https://huggingface.co/ByteDance-Seed/SeedVR2-7B), [GitHub ByteDance-Seed/SeedVR](https://github.com/ByteDance-Seed/SeedVR) |
| TRELLIS.2 4B DiT, shape VAE and texture VAE (`trellis_2_bf16`, `trellis_2_shape_vae_bf16`, `trellis_2_texture_vae_bf16`), the Object app | Microsoft, repackaged by Comfy Org | MIT | Yes | [HF microsoft/TRELLIS.2-4B](https://huggingface.co/microsoft/TRELLIS.2-4B), [HF Comfy-Org/TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2), [GitHub microsoft/TRELLIS.2](https://github.com/microsoft/TRELLIS.2) |
| DINOv3 ViT-L image encoder (`dino_v3_vit_l`), TRELLIS.2 conditioning | Meta AI, repackaged by Comfy Org | Meta DINOv3 License. The Comfy-Org repo is tagged MIT, but the upstream weights (gated by Meta with manual approval) carry the DINOv3 License, so that is what applies. | Yes. Royalty-free, commercial use allowed; excluded uses include military and ITAR-controlled work and reverse engineering. | [HF facebook/dinov3-vitl16-pretrain-lvd1689m](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m), [HF Comfy-Org/TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2), [license](https://ai.meta.com/resources/models-and-libraries/dinov3-license/) |
| BiRefNet (`birefnet.safetensors`), the Object app's subject cutout | Peng Zheng et al., repackaged by Comfy Org | MIT | Yes | [HF ZhengPeng7/BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet), [HF Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet) |
| RIFE 4.7 (`rife47.pth`), Upscale frame doubling | hzwer (Practical-RIFE) | MIT (the Practical-RIFE README puts its released models under the repo's MIT license) | Yes | [GitHub hzwer/Practical-RIFE](https://github.com/hzwer/Practical-RIFE). Frame-Interpolation downloads it from third-party Hugging Face mirrors; the mirror copies themselves are **unverified**. |

| BiRefNet (`birefnet.safetensors`), Remove background | ZhengPeng7 (Peng Zheng et al.), repackaged by Comfy Org | MIT | Yes | [HF Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet), [HF ZhengPeng7/BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet), [GitHub ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet) |
| SAM 3.1 (`sam3.1_multiplex_fp16.safetensors`), Remove background steady / tracked modes and Object swap | Meta, repackaged by Comfy Org | Meta SAM License | Yes. Royalty-free, commercial use allowed. Excluded: military, warfare and ITAR-controlled uses; no reverse engineering. Research publications must acknowledge SAM. | [HF Comfy-Org/sam3.1](https://huggingface.co/Comfy-Org/sam3.1), [HF facebook/sam3.1](https://huggingface.co/facebook/sam3.1) |

## LoRAs and adapters

| LoRA | Author | License | Commercial use | Source |
| --- | --- | --- | --- | --- |
| LTX-2.3 22B IC-LoRA Union Control (ref0.5), used by Mirror on LTX-2.5 | Lightricks | LTX-2 Community License Agreement | Yes, under $10M | [HF Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control) |
| LTX-2.3 22B IC-LoRA In/Outpainting (`ltx-2.3-22b-ic-lora-in-outpainting-0.9`), used by Object swap on LTX-2.5 | Lightricks | LTX-2 Community License Agreement | Yes, under $10M | [HF Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |
| LTX-2.3 22B distilled 1.1 LoRA (legacy `ltx23` bundle) | Lightricks, repackaged by Comfy Org | LTX-2 Community License Agreement | Yes, under $10M | [HF Comfy-Org/ltx-2.3](https://huggingface.co/Comfy-Org/ltx-2.3) |
| CrossView-Warp v2 IC-LoRA (`LTX2.3-22B_IC-LoRA-CrossView-Warp_v2_6000`), used by Reshoot | Cseti | Labelled Apache 2.0 by the author. It is an LTX-2.3 adapter, and the LTX license says derivatives (LoRA adapters included) must be distributed under LTX terms, so the LTX-2 Community License effectively governs it. Training renders used CC-BY 4.0 / CC0 assets, attributed in its ATTRIBUTION.md. | Yes, under $10M | [HF Cseti/LTX2.3-22B_IC-LoRA-CrossView-Warp_v2](https://huggingface.co/Cseti/LTX2.3-22B_IC-LoRA-CrossView-Warp_v2), [ATTRIBUTION.md](https://huggingface.co/Cseti/LTX2.3-22B_IC-LoRA-CrossView-Warp_v2/blob/main/ATTRIBUTION.md) |
| Qwen-Image Lightning 8-step V1.0 | lightx2v | Apache 2.0 | Yes | [HF lightx2v/Qwen-Image-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Lightning) |
| Qwen-Image-Edit-2509 Lightning 8-step V1.0 (optional, used when present) | lightx2v | Apache 2.0 | Yes | [HF lightx2v/Qwen-Image-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Lightning) |
| Qwen-Edit-2509 Multiple-angles LoRA (optional, used when present) | dx8152, repackaged by Comfy Org | Apache 2.0 | Yes | [HF dx8152/Qwen-Edit-2509-Multiple-angles](https://huggingface.co/dx8152/Qwen-Edit-2509-Multiple-angles) |
| FLUX.2 Turbo LoRA (`Flux2TurboComfyv2`) | fal (original), ComfyUI conversion by ByteZSzn, repackaged by Comfy Org | FLUX non-commercial terms (fal's original card lists the FLUX [dev] Non-Commercial License; the ByteZSzn conversion declares no license, **unverified**) | **NO (non-commercial)** | [HF fal/FLUX.2-dev-Turbo](https://huggingface.co/fal/FLUX.2-dev-Turbo), [HF ByteZSzn/Flux.2-Turbo-ComfyUI](https://huggingface.co/ByteZSzn/Flux.2-Turbo-ComfyUI), [HF Comfy-Org/flux2-dev](https://huggingface.co/Comfy-Org/flux2-dev) |
| MiniMax H3 turbo step-distill LoRA (Ref2V 4-step v0.1) | lightx2v | Labelled Apache 2.0 by lightx2v. The H3 license defines distills and other Model Derivatives as H3 works under H3 terms, so assume the H3 license applies. | **GEO-RESTRICTED** | [HF lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) |
| LTX-2.5 22B Alpha-Gen IC-LoRA, the Cutout effect (`ltx-2.5-22b-ic-lora-alpha-gen-0.9`) | Lightricks | LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`) | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-IC-LoRA-Alpha-Gen](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Alpha-Gen) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 22B Water-Simulation IC-LoRA, the Flood effect (`ltx-2.5-22b-ic-lora-water-simulation-0.9`) | Lightricks | LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`) | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-IC-LoRA-Water-Simulation](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Water-Simulation) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 22B Day-To-Night IC-LoRA, the Nightfall effect (`ltx-2.5-22b-ic-lora-day-to-night-0.9`) | Lightricks | LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`) | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-IC-LoRA-Day-To-Night](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Day-To-Night) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 22B Clean-Plate IC-LoRA, the Empty the scene effect (`ltx-2.5-22b-ic-lora-clean-plate-1.0`) | Lightricks | LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`) | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-IC-LoRA-Clean-Plate](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Clean-Plate) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 22B Cinemagraph LoRA, the Living photo effect (`ltx-2.5-22b-lora-cinemagraph-0.9`) | Lightricks | LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`) | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-LoRA-Cinemagraph](https://huggingface.co/Lightricks/LTX-2.5-22b-LoRA-Cinemagraph) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 22B SDR-to-HDR IC-LoRA (`ltx-2.5-22b-ic-lora-sdr-to-hdr-1.0`) and its scene embeddings (`ltx-2.5-22b-ic-lora-sdr-to-hdr-scene-emb`, a saved conditioning loaded in place of a prompt), Finish in HDR | Lightricks | LTX-2.x Community License Agreement | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-IC-LoRA-SDR-To-HDR](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-SDR-To-HDR) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 22B Ingredients IC-LoRA (`ltx-2.5-22b-ic-lora-ingredients-0.9`), Cast in video (reference sheet) | Lightricks | LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`) | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| LTX-2.5 22B Layout-to-Render IC-LoRA (`ltx-2.5-22b-ic-lora-layout-to-render-1.0`), Stage | Lightricks | LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`) | Yes, under $10M | [HF Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render) (gated), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) |
| Z-Image Turbo (bf16), its Qwen3 4B text encoder and the FLUX.1 autoencoder (`ae.safetensors`), Stage look frames | Tongyi-MAI (Alibaba), repackaged by Comfy Org; VAE by Black Forest Labs | Apache 2.0 (repo card `apache-2.0`) | Yes | [HF Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo), [HF Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) |
| Z-Image-Turbo Fun ControlNet Union (`Z-Image-Turbo-Fun-Controlnet-Union`), Stage look frames on the depth pass | Alibaba PAI | Apache 2.0 (repo card `apache-2.0`) | Yes | [HF alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union](https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union) |
| POP LoRA (`ltx23-pop`, trained on LTX-2.3), an Effects card | kabachuha | LTX-2 Community License Agreement (repo card `ltx-2-community-license-agreement`) | Yes, under $10M | [HF kabachuha/ltx23-pop](https://huggingface.co/kabachuha/ltx23-pop), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |
| Inflate it LoRA (`ltx2-inflate`, trained on LTX-2 19B), an Effects card | kabachuha | LTX-2 Community License Agreement (repo card `ltx-2-community-license-agreement`) | Yes, under $10M | [HF kabachuha/ltx2-inflate-it](https://huggingface.co/kabachuha/ltx2-inflate-it), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |
| Cakeify v2 LoRA (`ltx2-cakeify-v2`, trained on LTX-2 19B), an Effects card | kabachuha | LTX-2 Community License Agreement (repo card `ltx-2-community-license-agreement`) | Yes, under $10M | [HF kabachuha/ltx2-cakeify](https://huggingface.co/kabachuha/ltx2-cakeify), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |
| Squish (one hand) LoRA (`ltx2-handsquish`, trained on LTX-2 19B), an Effects card | kabachuha | LTX-2 Community License Agreement (repo card `ltx-2-community-license-agreement`) | Yes, under $10M | [HF kabachuha/ltx2-squish-one-hand](https://huggingface.co/kabachuha/ltx2-squish-one-hand), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |
| Disguise drop LoRA (`ltx2-disguise-drop`, trained on LTX-2 19B), an Effects card | kabachuha | LTX-2 Community License Agreement (repo card `ltx-2-community-license-agreement`) | Yes, under $10M | [HF kabachuha/ltx2-disguise-drop](https://huggingface.co/kabachuha/ltx2-disguise-drop), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |
| Eat v2 LoRA (`ltx2-eat-v2`, trained on LTX-2 19B), an Effects card | kabachuha | LTX-2 Community License Agreement (repo card `ltx-2-community-license-agreement`) | Yes, under $10M | [HF kabachuha/ltx2-eat](https://huggingface.co/kabachuha/ltx2-eat), [license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) |

## ComfyUI custom node packs

Stock ComfyUI (0.38+) provides the LTX core nodes (`LTXVAddGuide`,
`LTXVDualCFGGuider`, `GetICLoRAParameters` and others), the MoGe nodes
(`LoadMoGeModel`, `MoGeInference`) and the MiniMax H3 nodes. The packs below
are cloned by you into `ComfyUI/custom_nodes/`.

| Pack | Author | License | Commercial use | Used by | Source |
| --- | --- | --- | --- | --- | --- |
| ComfyUI-VideoHelperSuite | Kosinkadink | GPL-3.0 | Yes | Mirror, Reshoot, Effects (clip effects), Upscale, Extend, Transitions (clip ends), Add sound, Improve the seam | [GitHub](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) |
| ComfyUI-KJNodes | kijai | GPL-3.0 | Yes | Extend, backward lead-in (`ReverseImageBatch`) | [GitHub](https://github.com/kijai/ComfyUI-KJNodes) |
| ComfyUI-Frame-Interpolation | Fannovel16 | MIT | Yes | Upscale (RIFE) | [GitHub](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation) |
| comfyui_controlnet_aux | Fannovel16 | Apache 2.0 (the code; detector weights it fetches carry their own licenses, above) | Yes | Mirror | [GitHub](https://github.com/Fannovel16/comfyui_controlnet_aux) |
| ComfyUI-CrossViewWarp | Cseti (cseti007) | Apache 2.0 | Yes | Reshoot | [GitHub](https://github.com/cseti007/ComfyUI-CrossViewWarp) |
| ComfyUI-SeedVR2_VideoUpscaler | numz | Apache 2.0 | Yes | Upscale (Redraw) | [GitHub](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) |
| ComfyUI-LTXVideo | Lightricks | LTX-2 Community License Agreement (not an OSI license) | Yes, under $10M | Reshoot, Effects (`LTXICLoRALoaderModelOnly`, `LTXAddVideoICLoRAGuide`), Extend, Add sound and Improve the seam (`LTXVSetAudioVideoMaskByTime`), Finish in HDR (`LTXVSDRToHDRWorkingSpace`, `LTXVLoadConditioning`, `LTXVVAEForceFloat32`, `LTXVHDRDecodePostprocess`, `LTXVSaveHLG`) | [GitHub](https://github.com/Lightricks/ComfyUI-LTXVideo), [LICENSE](https://github.com/Lightricks/ComfyUI-LTXVideo/blob/master/LICENSE) |

## Runtime

| Component | Author | License | Commercial use | Source |
| --- | --- | --- | --- | --- |
| ComfyUI | Comfy Org | GPL-3.0 | Yes | [GitHub Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) |
| comfy-api-proxy (pip, 0.1.6) | Comfy Org | MIT | Yes | [GitHub](https://github.com/Comfy-Org/comfy-api-proxy), [PyPI](https://pypi.org/project/comfy-api-proxy/) |
| @comfyorg/sdk (0.5.0) | Comfy Org | MIT | Yes | [npm](https://www.npmjs.com/package/@comfyorg/sdk), [GitHub](https://github.com/Comfy-Org/comfy-typescript-sdk) |
| @modelcontextprotocol/sdk | Model Context Protocol | MIT | Yes | [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| fastify, @fastify/static, @fastify/websocket | Fastify | MIT | Yes | [npm](https://www.npmjs.com/package/fastify) |
| react, react-dom | Meta | MIT | Yes | [npm](https://www.npmjs.com/package/react) |
| three (0.186), the 3D viewer in the Object app and the Viewer | three.js authors | MIT | Yes | [npm](https://www.npmjs.com/package/three), [GitHub mrdoob/three.js](https://github.com/mrdoob/three.js) |
| better-sqlite3 | WiseLibs | MIT | Yes | [npm](https://www.npmjs.com/package/better-sqlite3) |
| ws | ws contributors | MIT | Yes | [npm](https://www.npmjs.com/package/ws) |
| three (three.js) | three.js authors | MIT | Yes | [npm](https://www.npmjs.com/package/three), [GitHub](https://github.com/mrdoob/three.js) |
| zod | Colin McDonnell | MIT | Yes | [npm](https://www.npmjs.com/package/zod) |
| qrcode-generator, the phone hand-off QR code | Kazuhiko Arase | MIT | Yes | [npm](https://www.npmjs.com/package/qrcode-generator) |
| Vite (build only) | Vite contributors | MIT | Yes | [npm](https://www.npmjs.com/package/vite) |
| Archivo, Inter, JetBrains Mono (via Fontsource) | their type designers | SIL Open Font License 1.1 | Yes | [Fontsource](https://fontsource.org) |

ComfyUI, VideoHelperSuite and KJNodes are GPL-3.0. Morpheus talks to ComfyUI over its
HTTP API as a separate program and ships none of its code, so Morpheus itself
stays MIT.

Not used: `kabachuha/ltx2-hydraulic-press` states no license on its card, so
Morpheus does not fetch or offer it.

## Keeping this file honest

The model license strings shown in the app and in
[`docs/MODELS.md`](docs/MODELS.md) come from `server/models.ts`. If you add a
model, update both that file and this one.
