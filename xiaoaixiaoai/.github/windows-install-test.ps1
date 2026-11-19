# CI on windows-latest: the Windows install path end to end, in Windows PowerShell 5.1.
# A throwaway config points at a closed port, so the daemon runs without any relay.
param([Parameter(Mandatory = $true)][string]$Bundle)

$ErrorActionPreference = "Stop"
$env:XIAOAIXIAOAI_UPDATE_CHECK = "0"

function Check([bool]$ok, [string]$what) {
  if (-not $ok) { throw "FAILED: $what" }
  Write-Host "ok - $what"
}
function Run([string]$exe) {
  # Native stderr through 2>&1 must not stop Windows PowerShell 5.1.
  $ErrorActionPreference = "Continue"
  $out = & $exe @args 2>&1 | Out-String
  Write-Host $out
  return $out
}
function Target([string]$path) { [string]((Get-Item -LiteralPath $path).Target | Select-Object -First 1) }

$config = Join-Path $env:APPDATA "xiaoaixiaoai"
New-Item -ItemType Directory -Force -Path $config | Out-Null
'{"server":"http://127.0.0.1:9","token":"ci","deviceId":"ci","name":"ci"}' | Set-Content -Encoding ascii -LiteralPath (Join-Path $config "hostd.json")

# As documented: the script text run as a script block, no execution policy involved.
& ([scriptblock]::Create((Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "..\scripts\install-host.ps1")))) -From $Bundle

$root = Join-Path $env:LOCALAPPDATA "Programs\xiaoaixiaoai"
$cmd = Join-Path $root "bin\xiaoaixiaoai.cmd"
$current = Join-Path $root "current"
$version = (Get-Content -Raw (Join-Path $current "package.json") | ConvertFrom-Json).version
Check ((((Get-Item -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) "current is a junction"
Check ((Run $cmd --version).Trim() -eq $version) "xiaoaixiaoai.cmd runs version $version"
Check ([string](Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run").XiaoAiXiaoAi -match "wscript\.exe") "logon entry runs the hidden launcher"
Check (Test-Path -LiteralPath (Join-Path $current "apps\hostd\node_modules\ws\package.json")) "dependency links inside the bundle resolve"

Check ((Run $cmd status) -match "(?m)^daemon\s+running") "the daemon answers on its named pipe"
$svc = Run $cmd service status
Check ($svc -match "(?m)^service\s+running") "the supervisor runs"
$before = [regex]::Match($svc, "running \(pid (\d+)\)").Groups[1].Value

# Update in place: a new folder, junction swap, the service hands over to the new copy.
$up = Run $cmd update --from $Bundle --force
Check ($up -match "restarted XiaoAiXiaoAi") "update switches and restarts the service"
$now = Target $current
Check ($now -match "releases\\$([regex]::Escape($version))\+") "current points at the new copy ($now)"
Check ((Get-ChildItem (Join-Path $root "releases")).Count -eq 2) "two copies kept"
$after = [regex]::Match((Run $cmd service status), "running \(pid (\d+)\)").Groups[1].Value
Check ($after -and $after -ne $before) "a new supervisor runs ($before -> $after)"
for ($i = 0; $i -lt 20; $i++) {
  if ((Run $cmd status) -match "(?m)^daemon\s+running") { break }
  Start-Sleep 1
}
Check ((Run $cmd status) -match "(?m)^daemon\s+running") "the daemon is back after the update"

Run $cmd update --rollback --no-restart | Out-Null
Check ((Target $current) -match "releases\\$([regex]::Escape($version))\\?$") "rollback switches back"

Run $cmd service remove | Out-Null
Check (-not (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run").PSObject.Properties["XiaoAiXiaoAi"]) "service remove drops the logon entry"
Check (-not ((Run $cmd service status) -match "(?m)^service\s+running")) "the supervisor is gone"

Write-Host "--- service log"
Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "xiaoaixiaoai\hostd.log") | Write-Host
