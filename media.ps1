# Reads "now playing" info from Windows and prints it as JSON every second
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Writes a line into island-log.txt (next to this script) so we can see what went wrong
function Log($msg) { Add-Content -Path (Join-Path $PSScriptRoot 'island-log.txt') -Value "$(Get-Date -Format s) $msg" }

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$mgrType    = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$propType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$readerType = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
$mgr = Await ($mgrType::RequestAsync()) $mgrType

# ---- Which app or website is playing? ----
$browsers = @{ chrome = 'Chrome'; msedge = 'Edge'; firefox = 'Firefox'; brave = 'Brave'; opera = 'Opera'; vivaldi = 'Vivaldi' }
$sites = 'YouTube Music', 'YouTube', 'Spotify', 'SoundCloud', 'JioSaavn', 'Gaana', 'Apple Music', 'Amazon Music'

function GetSource($appId, $title) {
  $id = "$appId".ToLower()
  $proc = $null
  foreach ($k in $browsers.Keys) { if ($id -like "*$k*") { $proc = $k } }
  if ($id -match '^[0-9a-f]{16}$') { $proc = 'firefox' }      # Firefox uses a code like this as its name

  if (-not $proc) {                                           # a normal app, like the Spotify app
    if ($id -like '*spotify*') { return 'Spotify' }
    $name = ($appId -split '!')[0] -replace '\.exe$', '' -replace '_[a-z0-9]{13}$', ''
    $name = ($name -split '\.')[-1]
    if ($name.Length -gt 0) { return $name.Substring(0, 1).ToUpper() + $name.Substring(1) }
    return ''
  }

  # A browser: read the browser window titles to guess the website
  $site = $null
  $bullet = [string][char]0x2022                              # the dot used by Spotify: "Song • Artist"
  $titles = Get-Process -Name $proc -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }
  foreach ($t in $titles) {
    foreach ($name in $sites) { if (-not $site -and $t -like "*$name*") { $site = $name } }
    if (-not $site -and $title -and $t.Contains($title) -and $t.Contains($bullet)) { $site = 'Spotify' }
  }
  if ($site) { return "$site on " + $browsers[$proc] }
  return $browsers[$proc]
}

# ---- The song picture, as text (base64). Returns $null if there is none ----
function GetArt($props) {
  if (-not $props.Thumbnail) { Log 'the player gave no picture'; return $null }
  $stream = $null
  try { $stream = Await ($props.Thumbnail.OpenReadAsync()) $streamType }
  catch { Log "could not open the picture: $($_.Exception.Message)"; return $null }

  try {                                                       # way 1
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    if ($ms.Length -gt 0) { return [Convert]::ToBase64String($ms.ToArray()) }
  } catch { Log "way 1 failed: $($_.Exception.Message)" }

  try {                                                       # way 2
    $reader = $readerType::new($stream)
    $size = [uint32]$stream.Size
    $null = Await ($reader.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    return [Convert]::ToBase64String($bytes)
  } catch { Log "way 2 failed: $($_.Exception.Message)" }
  return $null
}

$lastKey = ''
$needArt = $false
$artTries = 0
$source = ''
$loop = 0

while ($true) {
  $loop++
  $o = @{ title = ''; artist = ''; playing = $false; position = 0; duration = 0; source = '' }   # reset every round
  try {
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $status = "$($s.GetPlaybackInfo().PlaybackStatus)"
      if ($status -ne 'Closed' -and $status -ne 'Stopped') {
        $p = Await ($s.TryGetMediaPropertiesAsync()) $propType
        $playing = ($status -eq 'Playing')

        # song time
        $t = $s.GetTimelineProperties()
        $dur = ($t.EndTime - $t.StartTime).TotalSeconds
        $pos = ($t.Position - $t.StartTime).TotalSeconds
        if ($playing) {
          $delta = ([DateTimeOffset]::Now - $t.LastUpdatedTime).TotalSeconds
          if ($delta -gt 0 -and $delta -lt 3600) { $pos += $delta }
        }
        if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
        if ($pos -lt 0) { $pos = 0 }

        # new song? find where it plays and get its picture
        $key = "$($p.Title)|$($p.Artist)"
        if ($key -ne $lastKey) {
          $lastKey = $key; $needArt = $true; $artTries = 0
          $source = GetSource $s.SourceAppUserModelId $p.Title
        } elseif ($loop % 5 -eq 0) {                          # the website may show up later, try again
          $better = GetSource $s.SourceAppUserModelId $p.Title
          if ($better -like '* on *') { $source = $better }
        }

        $o = @{ title = $p.Title; artist = $p.Artist; playing = $playing; source = $source
                position = [math]::Round($pos, 1); duration = [math]::Round($dur, 1) }

        if ($needArt) {
          if ($artTries -lt 6) {
            $artTries++
            $art = GetArt $p
            if ($art) { $o.art = $art; $needArt = $false }
          } else { $o.artFailed = $true }                     # tell the app to look online
        }
      }
    }
  } catch { Log "loop error: $($_.Exception.Message)" }
  $o | ConvertTo-Json -Compress
  Start-Sleep -Milliseconds 1000
}
