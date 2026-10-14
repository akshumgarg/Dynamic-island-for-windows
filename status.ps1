# Prints one line of JSON every second: Wi-Fi and Bluetooth.
# (The volume and brightness are in levels.ps1, because they need to be faster.)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Writes a line into island-log.txt, but only the first time for each kind of problem
$logged = @{}
function LogOnce($kind, $msg) {
  if ($logged[$kind]) { return }
  $logged[$kind] = $true
  Add-Content -Path (Join-Path $PSScriptRoot 'island-log.txt') -Value "$(Get-Date -Format s) status ($kind): $msg"
}

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# ---- Wi-Fi name ----
function GetWifi {
  $name = ''
  try {
    $text = (netsh wlan show interfaces) -join "`n"
    if ($text -match '(?m)^\s*State\s*:\s*connected') {
      $name = 'Connected'
      if ($text -match '(?m)^\s*SSID\s*:\s*(.+?)\s*$') { $name = $Matches[1] }
      else {                                                   # Windows hid the name: use the network name instead
        $profile = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($profile) { $name = $profile.Name }
      }
    }
  } catch { LogOnce 'wifi' $_.Exception.Message }
  return $name
}

# ---- Are the Wi-Fi and Bluetooth radios switched on? ----
function GetRadios {
  $result = @{ wifi = $null; bluetooth = $null }
  try {
    [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
    $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    foreach ($r in $radios) {
      if ("$($r.Kind)" -eq 'WiFi')      { $result.wifi = ("$($r.State)" -eq 'On') }
      if ("$($r.Kind)" -eq 'Bluetooth') { $result.bluetooth = ("$($r.State)" -eq 'On') }
    }
  } catch { LogOnce 'radios' $_.Exception.Message }
  return $result
}

# ---- Bluetooth devices that are connected right now. Returns $null if Windows could not tell ----
function GetBluetooth {
  try {
    $infoType     = [Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime]
    $infoListType = [Windows.Devices.Enumeration.DeviceInformationCollection,Windows.Devices.Enumeration,ContentType=WindowsRuntime]
    $btType       = [Windows.Devices.Bluetooth.BluetoothDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
    $bleType      = [Windows.Devices.Bluetooth.BluetoothLEDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
    $connected    = [Windows.Devices.Bluetooth.BluetoothConnectionStatus,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
    $names = @()
    foreach ($type in @($btType, $bleType)) {                  # normal Bluetooth and low-energy Bluetooth
      $selector = $type::GetDeviceSelectorFromConnectionStatus($connected::Connected)
      $list = Await ($infoType::FindAllAsync($selector)) $infoListType
      foreach ($d in $list) { if ($d.Name -and ($names -notcontains $d.Name)) { $names += $d.Name } }
    }
    return ,$names
  } catch { LogOnce 'bluetooth' $_.Exception.Message; return $null }
}

$loop = 0
$wifi = ''
$bt = @()
$radios = @{ wifi = $null; bluetooth = $null }

while ($true) {
  try {
    if ($loop % 2 -eq 0) { $radios = GetRadios }
    if ($loop % 5 -eq 0) {
      $wifi = GetWifi
      $found = GetBluetooth
      if ($null -ne $found) { $bt = $found }       # (null on the left, so an empty list still counts)
    }
  } catch { LogOnce 'loop' $_.Exception.Message }

  @{ wifi = $wifi; wifiOn = $radios.wifi; btOn = $radios.bluetooth; bluetooth = @($bt) } | ConvertTo-Json -Compress
  $loop++
  Start-Sleep -Seconds 1
}
