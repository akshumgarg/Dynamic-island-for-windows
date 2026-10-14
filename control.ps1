# Waits for words (one per line) and does them. Prints "done" when it has finished each one.
#   music:     playpause, next, prev, seek 83.5
#   computer:  volume 0.4, mute, brightness 70, wifi on, wifi off, bluetooth on, bluetooth off
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -Path (Join-Path $PSScriptRoot 'audio.cs')

function Log($msg) { Add-Content -Path (Join-Path $PSScriptRoot 'island-log.txt') -Value "$(Get-Date -Format s) control: $msg" }

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# Keyboard keys (used as a backup plan)
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);' -Name K -Namespace W
function PressKey($code) { [W.K]::keybd_event($code, 0, 0, 0); [W.K]::keybd_event($code, 0, 2, 0) }

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr = Await ($mgrType::RequestAsync()) $mgrType

# ---- Volume: level is 0.0 to 1.0 ----
function SetVolume($level) {
  try {
    [Audio]::Volume = [single]$level
    if ($level -gt 0) { [Audio]::Mute = $false }
    if ([math]::Abs([Audio]::Volume - $level) -lt 0.03) { return }      # it worked
    Log "volume did not change to $level"
  } catch { Log "volume: $($_.Exception.Message)" }
  # Backup plan: press the volume keys. One press = 2%.
  $steps = [int][math]::Round(($level - [Audio]::Volume) * 50)
  if ($steps -gt 0) { $code = 0xAF } else { $code = 0xAE }
  for ($i = 0; $i -lt [math]::Abs($steps); $i++) { PressKey $code }
}

# ---- Brightness: 0 to 100. We keep the Windows object, so every change is fast ----
$brightObject = $null
function SetBrightness($level) {
  if (-not $script:brightObject) {
    $script:brightObject = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods | Select-Object -First 1
  }
  [void]$script:brightObject.WmiSetBrightness(1, [byte]$level)
}

# ---- Wi-Fi and Bluetooth on or off ----
function SetRadio($kind, $on) {
  [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
  [Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
  [Windows.Devices.Radios.RadioState,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
  $null = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
  $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  foreach ($r in $radios) {
    if ("$($r.Kind)" -eq $kind) {
      if ($on) { $state = [Windows.Devices.Radios.RadioState]::On } else { $state = [Windows.Devices.Radios.RadioState]::Off }
      $result = Await ($r.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
      if ("$result" -ne 'Allowed') { Log "$kind radio: Windows said $result" }
    }
  }
}

# ---- Music player buttons ----
function MediaCommand($cmd, $parts) {
  $s = $mgr.GetCurrentSession()      # the same player the island shows
  if (-not $s) { return }
  switch ($cmd) {
    'playpause' { if (-not (Await ($s.TryTogglePlayPauseAsync()) ([bool]))) { PressKey 0xB3 } }
    'next'      { if (-not (Await ($s.TrySkipNextAsync()) ([bool])))        { PressKey 0xB0 } }
    'prev'      { if (-not (Await ($s.TrySkipPreviousAsync()) ([bool])))    { PressKey 0xB1 } }
    'seek' {
      $t = $s.GetTimelineProperties()
      $ticks = $t.StartTime.Ticks + [long]([double]$parts[1] * 10000000)   # seconds -> ticks
      $ok = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
      if (-not $ok) { Log 'this player did not accept the new time' }
    }
  }
}

while ($line = [Console]::In.ReadLine()) {
  try {
    $parts = $line.Trim().Split(' ')
    $cmd = $parts[0]
    switch ($cmd) {
      'volume'     { SetVolume ([double]$parts[1]) }
      'mute'       { [Audio]::Mute = -not [Audio]::Mute }
      'brightness' { SetBrightness ([int]$parts[1]) }
      'wifi'       { SetRadio 'WiFi' ($parts[1] -eq 'on') }
      'bluetooth'  { SetRadio 'Bluetooth' ($parts[1] -eq 'on') }
      default      { MediaCommand $cmd $parts }
    }
  } catch { Log "$line -> $($_.Exception.Message)" }
  'done'                              # tells main.js we are ready for the next one
}
