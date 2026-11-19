# 小爱小爱 for a Windows computer: installs the `xiaoaixiaoai` command, registers this
# computer with your relay and keeps it online in the background (starts hidden at logon).
# Runs as your user; no administrator rights. Windows 10 1809+ or 11, x64 or ARM64.
#
#   powershell -File scripts/install-host.ps1 -From C:\path\xiaoaixiaoai-0.1.0.tar.gz -Server https://xiaoaixiaoai.example.com
#
#   -Server <url>       your relay. A phone that is already connected scans the QR code shown and approves.
#   -Code <CODE>        register with an invite or setup code instead (first computer on a new relay)
#   <invite link>       the same as one link: https://<server>/p/<CODE> or xiaoaixiaoai://pair?...
#   -Name <name>        device name (default: this computer's name)
#   -ReadOnly           phones and other computers may look but not type
#   -Version <x.y.z>    legacy option; the local bundle's manifest remains authoritative
#   -Dir <path>         install folder (default %LOCALAPPDATA%\Programs\xiaoaixiaoai)
#   -From <file>        required: an existing local xiaoaixiaoai release bundle (not a URL/UNC)
#   -NoService          install the command only; then run `xiaoaixiaoai up` yourself
#
# This fork has no configured remote release source. HERDR_POCKET_REPO cannot enable one.
# Node itself may be fetched from nodejs.org / npmmirror.com after local-source policy passes,
# with checksum verification. Remote product updates stay disabled; use a reviewed local bundle.

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Link = "",
  [string]$Server = $env:XIAOAIXIAOAI_SERVER,
  [string]$Code = "",
  [string]$Name = "",
  [switch]$ReadOnly,
  [string]$Version = "",
  [string]$Dir = "",
  [string]$From = "",
  [switch]$NoService
)

$ErrorActionPreference = "Stop"

# Pure early policy seam; no directory writes, downloads, runtime bootstrap or services.
function AssertLocalBundleSource([string]$Source) {
  if ([string]::IsNullOrWhiteSpace($Source)) {
    throw "Owned release source is not configured; explicit local bundle required (-From)."
  }
  if ($Source -match '^[A-Za-z][A-Za-z0-9+.-]*://' -or $Source -match '^(\\\\|//)') {
    throw "-From must be a local bundle path, not a URL/network path"
  }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "-From must name an existing local bundle file"
  }
  $resolved = Resolve-Path -LiteralPath $Source
  if ($resolved.Provider.Name -ne "FileSystem" -or $resolved.ProviderPath -match '^(\\\\|//)') {
    throw "-From must resolve to a local filesystem bundle"
  }
  return $resolved.ProviderPath
}
$From = AssertLocalBundleSource $From

$ProgressPreference = "SilentlyContinue" # Windows PowerShell downloads crawl with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$NodeMajor = 24

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Magenta }
function Warn([string]$m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "x $m" -ForegroundColor Red; throw $m }

function Fetch([string]$url, [string]$out) {
  for ($i = 1; $i -le 3; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -Headers @{ "User-Agent" = "xiaoaixiaoai-installer" }
      return
    } catch {
      if ($i -eq 3) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

# Mainland China by the time zone; XIAOAIXIAOAI_MIRROR forces it either way.
function InChina {
  switch -regex ("$env:XIAOAIXIAOAI_MIRROR") {
    "^(1|true|on|yes)$" { return $true }
    "^(0|false|off|no)$" { return $false }
  }
  $tz = [TimeZoneInfo]::Local.Id
  return ($tz -eq "China Standard Time") -or ($tz -in @("Asia/Shanghai", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar", "PRC"))
}
$China = InChina

function Sha256([string]$file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

# The hash for one file in a sha256sum listing.
function SumFor([string]$listing, [string]$file) {
  foreach ($line in ($listing -split "`n")) {
    if ($line -match "^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$" -and (Split-Path -Leaf $Matches[2]) -eq $file) { return $Matches[1].ToLowerInvariant() }
  }
  return $null
}

function NewTemp {
  $t = Join-Path ([IO.Path]::GetTempPath()) ("xiaoaixiaoai-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $t | Out-Null
  return $t
}

# Folders with junctions inside: rmdir /s removes the links, never what they point to.
function RemoveTree([string]$path) {
  if (Test-Path -LiteralPath $path) { cmd /c rmdir /s /q "`"$path`"" | Out-Null }
}

function RemoveLink([string]$path) {
  if (Test-Path -LiteralPath $path) { cmd /c rmdir "`"$path`"" | Out-Null }
}

function LinkTarget([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $t = (Get-Item -LiteralPath $path -Force).Target
  if ($t) { return [string]($t | Select-Object -First 1) }
  return $null
}

function Arch {
  $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($a) { "AMD64" { return "x64" } "ARM64" { return "arm64" } default { Die "no Node build for $a Windows" } }
}

function NodeOk([string]$node) {
  if (-not (Test-Path -LiteralPath $node)) { return $false }
  & $node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" 2>$null
  return $LASTEXITCODE -eq 0
}

# A private Node in <Dir>\node: a fixed path the service and the command can rely on.
function PrivateNode {
  $node = Join-Path $Dir "node\node.exe"
  if (NodeOk $node) { return $node }
  $arch = Arch
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $tmp = NewTemp
  try {
    # The checksums from nodejs.org itself; npmmirror's latest-v* list can lag behind.
    try {
      Fetch "$base/SHASUMS256.txt" "$tmp\SHASUMS256.txt"
    } catch {
      if (-not $China) { throw }
      Fetch "https://npmmirror.com/mirrors/node/latest-v$NodeMajor.x/SHASUMS256.txt" "$tmp\SHASUMS256.txt"
    }
    $sums = Get-Content -Raw -LiteralPath "$tmp\SHASUMS256.txt"
    if ($sums -notmatch "(node-(v[0-9.]+)-win-$arch\.zip)") { Die "nodejs.org lists no win-$arch build" }
    $file = $Matches[1]
    $sources = @("$base/$file", "https://npmmirror.com/mirrors/node/$($Matches[2])/$file")
    if ($China) { [array]::Reverse($sources) }
    Say "downloading $file"
    try { Fetch $sources[0] "$tmp\$file" } catch { Fetch $sources[1] "$tmp\$file" }
    if ((Sha256 "$tmp\$file") -ne (SumFor $sums $file)) { Die "checksum mismatch for $file" }
    $x = Join-Path $tmp "x"
    New-Item -ItemType Directory -Path $x | Out-Null
    & $Tar -xf "$tmp\$file" -C $x
    if ($LASTEXITCODE -ne 0) { Expand-Archive -LiteralPath "$tmp\$file" -DestinationPath $x -Force }
    $unpacked = Get-ChildItem -LiteralPath $x -Directory | Select-Object -First 1
    RemoveTree (Join-Path $Dir "node")
    Move-Item -LiteralPath $unpacked.FullName -Destination (Join-Path $Dir "node")
  } finally {
    RemoveTree $tmp
  }
  if (-not (NodeOk $node)) { Die "the downloaded Node does not start" }
  return $node
}

# Unpack the release bundle into <Dir>\releases\<version> and point <Dir>\current at it.
function InstallBundle {
  $tmp = NewTemp
  try {
    if ($From) {
      $file = (Resolve-Path -LiteralPath $From).Path
    } else {
      Die "Owned release source is not configured; explicit local bundle required (-From)."
    }
    # The bundle's own unpacker: tar.exe can't make its links without Developer Mode.
    & $Tar -xzf $file -C $tmp "*/packages/update/src/untar.ts"
    $untar = Get-ChildItem -LiteralPath $tmp -Recurse -Filter "untar.ts" | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $untar) { Die "this bundle has no Windows unpacker: Windows needs 小爱小爱 0.1.2 or newer" }
    $ver = (& $Node --no-warnings $untar.FullName $file | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or -not $ver) { Die "could not read the bundle's version" }
    $releases = Join-Path $Dir "releases"
    $target = Join-Path $releases $ver
    $current = Join-Path $Dir "current"
    $before = LinkTarget $current
    if ($before -and ($before.TrimEnd("\") -ieq $target) -and (Test-Path -LiteralPath $target)) {
      Say "小爱小爱 $ver is already installed"
    } else {
      New-Item -ItemType Directory -Force -Path $releases | Out-Null
      RemoveTree $target
      & $Node --no-warnings $untar.FullName $file $target | Out-Null
      if ($LASTEXITCODE -ne 0) { RemoveTree $target; Die "unpacking the bundle failed" }
      $got = & $Node --no-warnings (Join-Path $target "apps\hostd\src\cli.ts") --version
      if ($LASTEXITCODE -ne 0 -or $got -ne $ver) { RemoveTree $target; Die "the new copy does not start ($got)" }
      RemoveLink $current
      New-Item -ItemType Junction -Path $current -Target $target | Out-Null
      if ($before -and ($before.TrimEnd("\") -ine $target)) {
        $previous = Join-Path $Dir "previous"
        RemoveLink $previous
        New-Item -ItemType Junction -Path $previous -Target $before.TrimEnd("\") | Out-Null
      }
    }
    return $ver
  } finally {
    RemoveTree $tmp
  }
}

# Put <Dir>\bin on the user's PATH, keeping its type (REG_EXPAND_SZ) and other entries as they are.
function AddToPath([string]$bin) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($raw -split ";" | Where-Object { $_ })
    if ($parts -notcontains $bin) {
      $key.SetValue("Path", (($parts + $bin) -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # Tell Explorer, so new terminals see it.
      [Environment]::SetEnvironmentVariable("XIAOAIXIAOAI_PATH_SET", "1", "User")
      [Environment]::SetEnvironmentVariable("XIAOAIXIAOAI_PATH_SET", $null, "User")
      Say "added $bin to your PATH (new terminals have it)"
    }
  } finally {
    $key.Close()
  }
  if (($env:Path -split ";") -notcontains $bin) { $env:Path = "$bin;$env:Path" }
}

# The installed CLI, run by Node directly: the .cmd would let cmd.exe split arguments at & or ^.
function HP { & $Node --no-warnings (Join-Path $Dir "current\apps\hostd\src\cli.ts") @args }
function DaemonRunning { try { (HP status | Out-String) -match "(?m)^daemon\s+running" } catch { $false } }
function ServiceRunning { try { (HP service status | Out-String) -match "(?m)^service\s+running" } catch { $false } }

# ---------------------------------------------------------------------------------------------------------------------------------

if ([Environment]::OSVersion.Platform -ne "Win32NT") { Die "this installer is for Windows; on macOS and Linux use scripts/install-host.sh" }
$Tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path -LiteralPath $Tar)) { Die "Windows' tar.exe is missing (Windows 10 1803 or newer has it)" }
if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA "Programs\xiaoaixiaoai" }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path -LiteralPath $Dir).Path

$Node = PrivateNode
$Installed = InstallBundle
Say "小爱小爱 $Installed is in $Dir"

# The command: a .cmd next to the install, with paths relative to itself (any user name works).
$Bin = Join-Path $Dir "bin"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
$Cmd = Join-Path $Bin "xiaoaixiaoai.cmd"
$shim = "@echo off`r`nrem Written by install-host.ps1. Update with: xiaoaixiaoai update`r`n`"%~dp0..\node\node.exe`" --no-warnings `"%~dp0..\current\apps\hostd\src\cli.ts`" %*`r`n"
[IO.File]::WriteAllText($Cmd, $shim, [Text.Encoding]::ASCII)
AddToPath $Bin

$hc = Get-Command hc -ErrorAction SilentlyContinue
if (-not $hc -and -not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "Programs\herdr-core\hc.exe"))) {
  Warn "herdr (hc) is not installed yet: install herdr first, then your agents show up"
}

# Register unless this computer already is (with the same relay).
$homeDir = if ($env:XIAOAIXIAOAI_HOME) { $env:XIAOAIXIAOAI_HOME } else { Join-Path $env:APPDATA "xiaoaixiaoai" }
$config = Join-Path $homeDir "hostd.json"
$registered = $false
if ((Test-Path -LiteralPath $config) -and -not ($Link + $Code)) {
  $currentServer = ""
  try { $currentServer = [string](Get-Content -Raw -LiteralPath $config | ConvertFrom-Json).server } catch {}
  $wanted = ([string]$Server).TrimEnd("/")
  if ($wanted -and $wanted -notmatch "^https?://") { $wanted = "https://$wanted" }
  if ($currentServer -and (-not $wanted -or $wanted -eq $currentServer)) {
    $registered = $true
    Say "already registered with $currentServer"
  }
}
if (-not $registered) {
  if ($Server -or $Link -or $Code) {
    $a = @("login")
    if ($Link) { $a += $Link }
    if ($Server) { $a += @("--server", $Server) }
    if ($Code) { $a += @("--code", $Code) }
    if ($Name) { $a += @("--name", $Name) }
    HP @a
    if ($LASTEXITCODE -ne 0) { Die "registering this computer did not finish; run the installer again" }
    $registered = $true
  } else {
    Warn "no -Server given: the command is installed, this computer is not registered yet"
  }
}

if ($NoService -or -not $registered) {
  $s = if ($Server) { " --server $Server" } else { "" }
  Write-Host ""
  Write-Host "Next"
  Write-Host "  xiaoaixiaoai up$s     register (if needed) and keep this computer online"
  Write-Host "  xiaoaixiaoai service install   start it hidden at logon"
  Write-Host "  Remote updates are disabled; rerun this saved installer with -From <reviewed-local-bundle>."
  return
}

if ((DaemonRunning) -and -not (ServiceRunning)) {
  Warn "xiaoaixiaoai is already running in a terminal: stop it (Ctrl+C) so the background service can take over"
}
$svc = @("service", "install")
if ($ReadOnly) { $svc += "--read-only" }
HP @svc
if ($LASTEXITCODE -ne 0) { Die "setting up the background service failed" }

for ($i = 0; $i -lt 15; $i++) {
  if (DaemonRunning) { break }
  Start-Sleep -Seconds 1
}
Write-Host ""
HP status
$log = Join-Path $env:LOCALAPPDATA "xiaoaixiaoai\hostd.log"
Write-Host ""
Write-Host "小爱小爱 runs in the background and starts when you log on."
Write-Host "  Logs     $log"
Write-Host "  Update   rerun this saved installer with -From <reviewed-local-bundle> (remote updates disabled)"
Write-Host "  Invite   xiaoaixiaoai pair     (QR code for a phone or another computer)"
Write-Host "  Stop     xiaoaixiaoai service remove"
