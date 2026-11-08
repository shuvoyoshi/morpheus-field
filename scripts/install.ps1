<#
Morpheus install for native Windows (PowerShell 5.1 or 7).

  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Yes      take every default
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun   change nothing

Honest status: Morpheus is built and tested on Linux and on WSL2 driving a
Windows ComfyUI. Native Windows should work (Node, ComfyUI, comfy-api-proxy,
curl.exe and ffmpeg all run there) but has not been run end to end. If
anything here fails, use WSL2 and scripts/install.sh, which can drive this
same Windows ComfyUI through /mnt/<drive>/.

Steps: prerequisites, find or clone ComfyUI (v0.38.2), pinned custom node
packs (deploy/runpod/nodes.txt), comfy-api-proxy in its own venv, .env (the
HuggingFace token is read hidden and never printed), npm ci, model bundles,
doctor.
#>
param([switch]$Yes, [switch]$DryRun)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$NodesTxt = Join-Path $Root 'deploy\runpod\nodes.txt'
$ComfyRef = 'v0.38.2'
$ProxyVersion = '0.1.6'
$TorchIndex = if ($env:TORCH_INDEX) { $env:TORCH_INDEX } else { 'https://download.pytorch.org/whl/cu128' }
$ComfyUrl = if ($env:COMFY_URL) { $env:COMFY_URL } else { 'http://127.0.0.1:8188' }

function Say-Step($t) { Write-Host ''; Write-Host $t -ForegroundColor White }
function Say-Ok($t) { Write-Host "  ok    $t" -ForegroundColor Green }
function Say-Note($t) { Write-Host "  note  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  fail  $t" -ForegroundColor Red; exit 1 }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# Probe a native command quietly: PowerShell 5.1 turns its stderr into an error under Stop.
function Probe([string]$exe, [string[]]$argv) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @argv 2>$null | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false } finally { $ErrorActionPreference = $old }
}

function Run([string]$exe, [string[]]$argv) {
  if ($DryRun) { Write-Host "  would run: $exe $($argv -join ' ')"; return }
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail "$exe exited $LASTEXITCODE" }
}

function Ask([string]$q, [string]$def) {
  if ($Yes -or -not [Environment]::UserInteractive) { Write-Host "  $q [$def] $def"; return $def }
  $a = Read-Host "  $q [$def]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $def } else { return $a.Trim() }
}
function YesNo([string]$q, [string]$def = 'y') { (Ask "$q (y/n)" $def) -match '^[Yy]' }

# Set KEY=value in .env (replacing a commented or live line), UTF-8 without BOM. Never prints the value.
function Set-EnvKey([string]$key, [string]$value) {
  if ($DryRun) { Write-Host "  would set $key in .env"; return }
  $lines = @()
  if (Test-Path $EnvFile) { $lines = [IO.File]::ReadAllLines($EnvFile) }
  $out = New-Object System.Collections.Generic.List[string]
  $done = $false
  foreach ($l in $lines) {
    if ($l -match "^[# ]*$([regex]::Escape($key))=") { if (-not $done) { $out.Add("$key=$value"); $done = $true } }
    else { $out.Add($l) }
  }
  if (-not $done) { $out.Add("$key=$value") }
  [IO.File]::WriteAllLines($EnvFile, $out, (New-Object System.Text.UTF8Encoding($false)))
}
function EnvHas([string]$key) { (Test-Path $EnvFile) -and (Select-String -Path $EnvFile -Pattern "^$([regex]::Escape($key))=." -Quiet) }

Set-Location $Root
Write-Host 'Morpheus install (native Windows)' -ForegroundColor White
Say-Note 'Native Windows is not tested end to end yet. WSL2 with scripts/install.sh is the tested path.'
if ($DryRun) { Say-Note 'Dry run: nothing is installed or written.' }

# ---------------------------------------------------------------- 1 ----
Say-Step '1. Prerequisites'
if (-not (Has node)) { Fail 'Node is not installed. Install Node 22 or newer from https://nodejs.org, then re-run.' }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { Fail "Node $(node -v) is too old. Morpheus needs 22 or newer." }
Say-Ok "Node $(node -v)"
if (-not (Has git)) { Fail 'git is not installed (https://git-scm.com).' }
if (-not (Has curl.exe)) { Fail 'curl.exe is missing (it ships with Windows 10 and 11).' }
Say-Ok 'git, curl'
$Py = $null
if (Has py) { foreach ($v in '3.12', '3.11', '3.10') { if (Probe py @("-$v", '-c', '1')) { $Py = @('py', "-$v"); break } } }
if (-not $Py -and (Has python) -and (Probe python @('-c', 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)'))) { $Py = @('python') }
if ($Py) { Say-Ok "Python: $($Py -join ' ')" } else { Say-Note 'No Python 3.10 to 3.12 found. Needed to install ComfyUI or the proxy here.' }
if ((Has ffmpeg) -and (Has ffprobe)) { Say-Ok 'ffmpeg, ffprobe' } else { Say-Note 'ffmpeg/ffprobe not on PATH (winget install Gyan.FFmpeg). Stage, Remove background, HDR, seams and Upscale need them.' }
if (Has nvidia-smi) {
  $g = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | Select-Object -First 1)
  $parts = $g -split ',\s*'
  $gb = [math]::Floor([int]$parts[1] / 1024)
  Say-Ok "GPU $($parts[0]), about $gb GB"
  if ($gb -lt 16) { Say-Note 'Under 16 GB: plan on stills only.' } elseif ($gb -lt 23) { Say-Note 'Under 24 GB: video offloads and defaults to 480p.' }
} else { Say-Note 'nvidia-smi not found. Morpheus needs an NVIDIA GPU for local renders.' }

# ---------------------------------------------------------------- 2 ----
Say-Step '2. ComfyUI (0.38 or newer)'
$ComfyDir = ''
$ComfyPy = ''
$running = $false
try { $st = Invoke-RestMethod -Uri "$ComfyUrl/system_stats" -TimeoutSec 3; $running = $true; Say-Ok "ComfyUI is running at $ComfyUrl (v$($st.system.comfyui_version))" } catch { Say-Note "Nothing answers at $ComfyUrl." }
if ($running) {
  $ComfyDir = Ask 'Where is that ComfyUI folder? (blank to skip custom nodes)' ''
} else {
  $a = Ask "Path to an existing ComfyUI folder, or 'clone' to install one at $env:USERPROFILE\ComfyUI" 'clone'
  if ($a -eq 'clone') {
    $ComfyDir = Join-Path $env:USERPROFILE 'ComfyUI'
    if (-not $Py) { Fail 'Installing ComfyUI needs Python 3.10 to 3.12 (winget install Python.Python.3.12).' }
    if (-not (Test-Path (Join-Path $ComfyDir '.git'))) {
      if (-not (YesNo "Clone ComfyUI $ComfyRef into $ComfyDir and install PyTorch (about 5 GB)?")) { Fail 'Install ComfyUI yourself (docs/INSTALL.md step 1), then re-run.' }
      Run git @('clone', '--filter=blob:none', 'https://github.com/comfyanonymous/ComfyUI.git', $ComfyDir)
      Run git @('-C', $ComfyDir, 'checkout', '--quiet', $ComfyRef)
    }
    $venvPy = Join-Path $ComfyDir 'venv\Scripts\python.exe'
    if (-not (Test-Path $venvPy)) {
      $pyExe = $Py[0]; $pyArgs = @($Py | Select-Object -Skip 1)
      Run $pyExe ($pyArgs + @('-m', 'venv', (Join-Path $ComfyDir 'venv')))
      Run $venvPy @('-m', 'pip', 'install', '--upgrade', 'pip', 'wheel')
      Run $venvPy @('-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', $TorchIndex)
      Run $venvPy @('-m', 'pip', 'install', '-r', (Join-Path $ComfyDir 'requirements.txt'))
    }
  } else { $ComfyDir = $a }
}
if ($ComfyDir) {
  if (-not (Test-Path $ComfyDir) -and -not $DryRun) { Fail "$ComfyDir does not exist." }
  # A venv install, or the portable build (python_embeded sits next to the ComfyUI folder).
  foreach ($p in @((Join-Path $ComfyDir 'venv\Scripts\python.exe'), (Join-Path $ComfyDir '.venv\Scripts\python.exe'), (Join-Path (Split-Path $ComfyDir -Parent) 'python_embeded\python.exe'))) {
    if (Test-Path $p) { $ComfyPy = $p; break }
  }
  if ($DryRun -and -not $ComfyPy) { $ComfyPy = Join-Path $ComfyDir 'venv\Scripts\python.exe' }
  if ($ComfyPy) { Say-Ok "ComfyUI's Python: $ComfyPy" } else { Say-Note "No Python found for $ComfyDir; install node requirements with its own Python." }
}

# ---------------------------------------------------------------- 3 ----
Say-Step '3. Custom node packs (pinned)'
if (-not $ComfyDir) { Say-Note 'No ComfyUI folder given, skipping. docs/INSTALL.md lists the packs.' }
else {
  foreach ($line in (Get-Content $NodesTxt)) {
    if ($line -notmatch 'https://github.com/') { continue }
    $optional = $line.StartsWith('#')
    $f = (($line -replace '^[#\s]+', '').Trim()) -split '\s+'
    $name, $url, $commit, $req = $f[0], $f[1], $f[2], $f[3]
    $dest = Join-Path $ComfyDir "custom_nodes\$name"
    if (Test-Path (Join-Path $dest '.git')) { Say-Ok "$name already present"; continue }
    if ($optional -and -not (YesNo "Optional pack ${name}?" 'n')) { continue }
    Run git @('clone', '--filter=blob:none', $url, $dest)
    Run git @('-C', $dest, 'checkout', '--quiet', $commit)
    if ($ComfyPy -and ($DryRun -or (Test-Path (Join-Path $dest $req)))) { Run $ComfyPy @('-m', 'pip', 'install', '-r', (Join-Path $dest $req)) }
  }
}

# ---------------------------------------------------------------- 4 ----
Say-Step '4. comfy-api-proxy (Comfy API v2)'
$ProxyBin = ''
$found = Get-Command comfy-api-proxy -ErrorAction SilentlyContinue
if ($found) { $ProxyBin = $found.Source; Say-Ok "found $ProxyBin" }
else {
  $venv = Join-Path $env:USERPROFILE '.venvs\comfy-api-proxy'
  $ProxyBin = Join-Path $venv 'Scripts\comfy-api-proxy.exe'
  if (-not (Test-Path $ProxyBin)) {
    if (-not $Py) { Fail 'comfy-api-proxy needs Python 3.10 or newer.' }
    $pyExe = $Py[0]; $pyArgs = @($Py | Select-Object -Skip 1)
    Run $pyExe ($pyArgs + @('-m', 'venv', $venv))
    Run (Join-Path $venv 'Scripts\python.exe') @('-m', 'pip', 'install', "comfy-api-proxy==$ProxyVersion")
  }
  Say-Ok "installed in $venv (Morpheus starts it for you)"
}

# ---------------------------------------------------------------- 5 ----
Say-Step '5. Settings (.env)'
if (-not (Test-Path $EnvFile) -and -not $DryRun) { Copy-Item (Join-Path $Root '.env.example') $EnvFile; Say-Ok 'created .env from .env.example' }
Set-EnvKey 'COMFY_URL' $ComfyUrl
Set-EnvKey 'COMFY_PROXY_BIN' $ProxyBin
$ModelsDir = ''
if ($ComfyDir) { $ModelsDir = Join-Path $ComfyDir 'models'; Set-EnvKey 'COMFY_MODELS_DIR' $ModelsDir }
if ($ComfyPy -and -not (EnvHas 'COMFY_LAUNCH')) {
  Set-EnvKey 'COMFY_LAUNCH' "`"$ComfyPy`" `"$(Join-Path $ComfyDir 'main.py')`" --listen 127.0.0.1 --port 8188 --preview-method auto"
  Say-Ok 'COMFY_LAUNCH set: Morpheus can start ComfyUI'
}
if ((EnvHas 'HF_TOKEN') -or $env:HF_TOKEN) {
  Say-Ok 'HF_TOKEN already set'
  if ($env:HF_TOKEN -and -not (EnvHas 'HF_TOKEN')) { Set-EnvKey 'HF_TOKEN' $env:HF_TOKEN }
} else {
  Write-Host '  LTX-2.5 is gated. Accept its license at https://huggingface.co/Lightricks/LTX-2.5,'
  Write-Host '  then make a read token at https://huggingface.co/settings/tokens.'
  if (-not $Yes) {
    $sec = Read-Host '  Paste the token (hidden; blank to skip)' -AsSecureString
    $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    if ($tok) { Set-EnvKey 'HF_TOKEN' $tok; Say-Ok 'HF_TOKEN saved to .env (not shown)' } else { Say-Note 'Skipped. Gated downloads fail until HF_TOKEN is in .env.' }
    Remove-Variable tok, sec
  } else { Say-Note 'No HF_TOKEN. Gated downloads fail until it is in .env.' }
}

# ---------------------------------------------------------------- 6 ----
Say-Step '6. App and models'
Run npm @('ci', '--no-audit', '--no-fund')
if ($DryRun) { Write-Host '  would run: npm run models -- --list' } else { npm run -s models -- --list }
Write-Host '  Core: ltx25 (40 GB) + qwen (32 GB), both commercial use allowed. The right default.'
Write-Host '  h3, h3-turbo: the H3 license EXCLUDES the US, the EU, the UK and South Korea. h3 needs the all-in-one checkpoint added by hand.'
Write-Host '  flux2 and upres-ultrasharp: NON-COMMERCIAL. effects, cast, stage, hdr, swap: LTX terms, gated one by one.'
$pick = Ask "Bundles to download (comma list, 'core' for ltx25,qwen, 'none' to skip)" 'core'
if ($pick -eq 'core') { $pick = 'ltx25,qwen' }
if ($pick -and $pick -ne 'none') {
  if (-not $ModelsDir -and -not (EnvHas 'COMFY_MODELS_DIR')) {
    $ModelsDir = Ask 'ComfyUI models folder (holds diffusion_models, vae, loras)' ''
    if ($ModelsDir) { Set-EnvKey 'COMFY_MODELS_DIR' $ModelsDir }
  }
  if ($DryRun) { Write-Host "  would run: npm run models -- --only $pick" }
  elseif (YesNo 'Download these now? (resumable; re-run to continue)') {
    npm run -s models -- --only $pick
    if ($LASTEXITCODE -ne 0) { Say-Note 'Some files failed. Re-run to resume; check HF_TOKEN and the license pages.' }
  }
}

# ---------------------------------------------------------------- 7 ----
Say-Step '7. Check'
if ($running) { Say-Note 'Restart ComfyUI so it sees the new models, then continue.'; if (-not $Yes) { Read-Host '  Press Enter when it is back up' | Out-Null } }
if ($DryRun) { Write-Host '  would run: npm run doctor' }
else {
  npm run -s doctor
  if ($LASTEXITCODE -eq 0) { Write-Host 'Ready. npm run dev, then open http://localhost:3160' -ForegroundColor White }
  else { Say-Note 'Fix what the doctor marks FAIL, then run npm run doctor again.' }
}
