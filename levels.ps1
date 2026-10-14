# Watches the volume and the screen brightness, 7 times a second.
# Prints one line of JSON, but only when something changed.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Path (Join-Path $PSScriptRoot 'audio.cs')

$logged = $false
function LogOnce($msg) {
  if ($script:logged) { return }
  $script:logged = $true
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Content -Path (Join-Path $PSScriptRoot 'island-log.txt') -Value "$(Get-Date -Format s) levels: $msg"
}

$brightnessWorks = $true
$brightness = -1
$volume = -1
$muted = $false
$lastLine = ''
$loop = 0

while ($true) {
  try {
    $volume = [int][math]::Round([Audio]::Volume * 100)
    $muted = [Audio]::Mute
  } catch { $volume = -1; LogOnce "volume: $($_.Exception.Message)" }

  if ($brightnessWorks -and $loop % 2 -eq 0) {          # brightness: about 3 times a second
    try {
      $b = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
      if (-not $b) { throw 'no screen brightness control' }
      $brightness = [int]$b.CurrentBrightness
    } catch { $brightnessWorks = $false; $brightness = -1 }
  }

  $line = @{ volume = $volume; muted = $muted; brightness = $brightness } | ConvertTo-Json -Compress
  if ($line -ne $lastLine) { $line; $lastLine = $line }
  $loop++
  Start-Sleep -Milliseconds 150
}
