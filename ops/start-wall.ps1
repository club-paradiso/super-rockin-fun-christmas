# STUDIO SHALOM - media wall screen (Windows). Started by start-wall.bat, which prints the
# Korean messages (this file stays ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM).
# Needs only Chrome or Edge. The hub address is the first line of wall-hub.txt next to this file
# (shown in the hub window). If the browser closes or crashes it is opened again. If it closes
# within 10 seconds, another wall window is already open (Chrome handed the launch to it), so the
# loop stops instead of stacking windows.
$ErrorActionPreference = "Stop"
$hub = (Get-Content -Path (Join-Path $PSScriptRoot "wall-hub.txt") -TotalCount 1).Trim()
$profileDir = Join-Path $env:LOCALAPPDATA "follow-the-lights\wall"
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) {
  Write-Host "Chrome or Edge not found."
  exit 2
}
$browserArgs = @(
  "--user-data-dir=`"$profileDir`"", "--kiosk", "--app=$hub/wall", "--no-first-run",
  "--no-default-browser-check", "--disable-session-crashed-bubble",
  "--disable-features=Translate", "--autoplay-policy=no-user-gesture-required"
)
while ($true) {
  Write-Host "Opening $hub/wall"
  $started = Get-Date
  Start-Process -FilePath $browser -ArgumentList $browserArgs -Wait
  if (((Get-Date) - $started).TotalSeconds -lt 10) {
    Write-Host "The wall screen is already open (or the browser could not start)."
    exit 3
  }
  Write-Host "The wall browser closed. Opening again in 5 seconds. Close this window to stop."
  Start-Sleep -Seconds 5
}
