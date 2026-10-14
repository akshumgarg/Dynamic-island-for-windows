const { app, BrowserWindow, ipcMain, screen, net, powerMonitor } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { getWeather } = require('./weather')

// ---- Sizes in pixels (the big card uses the same sizes in style.css) ----
const WIN_W = 520, WIN_H = 260          // the see-through window at the top of the screen
const LINE_W = 110                      // thin line when hidden
const PILL_H = 38                       // small pill height (its width depends on what is inside)
const OPEN_W = 440, OPEN_H = 200, OPEN_TOP = 10   // big card

let win = null
let ui = { mode: 'hidden', pillWidth: 190 }   // the page tells us this
let holding = false          // true while you drag a slider
let mouseInside = false
let lastApply = 0
let controlProcess
let firstWindow = true
let lastRebuildAt = 0

// A new window (after lock or sleep) needs these again, so we keep them
let lastWeather = null, lastArt = null

app.whenReady().then(() => {
  createWindow(null)
  startScripts()
  startMouseWatcher()
  setInterval(updateWeather, 10 * 60 * 1000)   // new weather every 10 minutes

  // Keep the island above other windows, in case Windows moved it down
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
  }, 5000)

  // After sleep, lock or a screen change, Windows can leave the window in a broken state
  // (hover works but clicks do not). So we make a fresh window.
  powerMonitor.on('resume', rebuildSoon)
  powerMonitor.on('unlock-screen', rebuildSoon)
  screen.on('display-added', rebuildSoon)
  screen.on('display-removed', rebuildSoon)
  screen.on('display-metrics-changed', () => { if (Date.now() - lastRebuildAt > 5000) rebuildSoon() })
})

// There can be a moment with no window while we rebuild. Do not quit the app then.
app.on('window-all-closed', () => {})

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

// oldWin = the window we are replacing. It is closed only when the new one is ready,
// so the island never disappears.
function createWindow(oldWin) {
  const screenBox = screen.getPrimaryDisplay().bounds

  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    x: screenBox.x + Math.round((screenBox.width - WIN_W) / 2),   // middle of the screen
    y: screenBox.y,                                               // top edge
    frame: false,          // no title bar
    transparent: true,     // see-through background
    alwaysOnTop: true,     // stay above other windows
    skipTaskbar: true,     // no taskbar icon
    resizable: false,
    hasShadow: false,
    focusable: false,      // never steal keyboard focus
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)      // clicks pass through the empty area
  // "quiet" = do not slide out by itself (we do that only when the app starts)
  win.loadFile('index.html', firstWindow ? {} : { query: { quiet: '1' } })
  firstWindow = false

  win.webContents.once('did-finish-load', () => {
    if (lastWeather) send('weather', lastWeather)
    else updateWeather()
    if (lastArt) setTimeout(() => send('art-online', lastArt), 2500)   // song picture again
    if (oldWin && !oldWin.isDestroyed()) oldWin.destroy()               // the new one is ready
  })
}

let rebuildTimer
function rebuildSoon() {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(rebuildWindow, 800)      // wait a moment for Windows to settle
}

function rebuildWindow() {
  lastRebuildAt = Date.now()
  mouseInside = false
  holding = false
  ui = { mode: 'hidden', pillWidth: ui.pillWidth }
  createWindow(win)
}

ipcMain.on('state', (e, s) => { ui = s })
ipcMain.on('hold', (e, value) => { holding = value })

// ---- Timer, stopwatch and alarms are saved in a file, so they survive a restart or a new window ----
function clockFile() { return path.join(app.getPath('userData'), 'clock.json') }
ipcMain.on('load-clock', e => {
  try { e.returnValue = JSON.parse(fs.readFileSync(clockFile(), 'utf8')) } catch (err) { e.returnValue = null }
})
ipcMain.on('save-clock', (e, data) => {
  try { fs.writeFileSync(clockFile(), JSON.stringify(data)) } catch (err) {}
})

// ---- Commands for PowerShell (control.ps1) ----
// Sliders send many values very fast. We keep only the newest one of each kind, and send it
// when the script is free. This way it never falls behind.
let queue = []
let controlBusy = false
let busySince = 0

function sendControl(text) {
  const kind = text.split(' ')[0]
  if (kind === 'volume' || kind === 'brightness' || kind === 'seek') {
    queue = queue.filter(c => c.split(' ')[0] !== kind)       // drop the older ones
  }
  queue.push(text)
  pumpControl()
}

function pumpControl() {
  if (controlBusy && Date.now() - busySince > 3000) controlBusy = false   // the script is stuck? go on
  if (controlBusy || queue.length === 0) return
  controlBusy = true
  busySince = Date.now()
  controlProcess.stdin.write(queue.shift() + '\n')
}
ipcMain.on('control', (e, text) => sendControl(text))

function within(p, left, right, top, bottom) {
  return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
}

// ---- Every 50ms: is the mouse on the island (or on the top edge where it hides)? ----
function startMouseWatcher() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const centerX = b.x + b.width / 2

    let inside
    if (ui.mode === 'open') {
      inside = within(p, centerX - OPEN_W / 2 - 8, centerX + OPEN_W / 2 + 8, b.y, b.y + OPEN_TOP + OPEN_H + 12)
    } else if (ui.mode === 'pill') {
      inside = within(p, centerX - ui.pillWidth / 2 - 8, centerX + ui.pillWidth / 2 + 8, b.y, b.y + PILL_H + 8)
    } else {
      // hidden: only the very top pixels in the middle count
      inside = within(p, centerX - LINE_W / 2 - 15, centerX + LINE_W / 2 + 15, b.y, b.y + 3)
    }
    if (holding) inside = true          // dragging a slider: stay "inside" even if the mouse goes outside

    // Tell the window when it changes, and also once every second,
    // in case Windows forgot the setting
    const now = Date.now()
    if (inside !== mouseInside || now - lastApply > 1000) {
      const changed = inside !== mouseInside
      mouseInside = inside
      lastApply = now
      win.setIgnoreMouseEvents(!inside)   // catch clicks only while the mouse is on the island
      if (changed) send('hover', inside)
    }
  }, 50)
}

// ---- Weather ----
async function updateWeather() {
  try {
    lastWeather = await getWeather()
    send('weather', lastWeather)
  } catch (e) {
    setTimeout(updateWeather, 30 * 1000)   // no internet? try again in 30 seconds
  }
}

// ---- Runs a PowerShell script. Each line it prints goes to onLine ----
function runScript(file, onLine) {
  const ps = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, file)
  ])
  ps.stdout.setEncoding('utf8')
  ps.stdin.on('error', () => {})
  let buffer = ''
  ps.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()
    lines.forEach(line => onLine(line.trim()))
  })
  app.on('before-quit', () => ps.kill())
  return ps
}

let artAsked = ''
function startScripts() {
  // Music info, once every second
  runScript('media.ps1', line => {
    try {
      const m = JSON.parse(line)
      if (m.art) lastArt = { title: m.title, base64: m.art }
      send('media', m)
      // Windows had no song picture? Look for one online (once per song)
      if (m.title && m.artFailed && artAsked !== m.title + m.artist) {
        artAsked = m.title + m.artist
        findArtOnline(m.title, m.artist)
      }
    } catch (e) {}
  })

  // Volume and brightness: a line comes when one of them changes
  runScript('levels.ps1', line => {
    try { send('levels', JSON.parse(line)) } catch (e) {}
  })

  // Wi-Fi and Bluetooth, once every second
  runScript('status.ps1', line => {
    try { send('status', JSON.parse(line)) } catch (e) {}
  })

  // Buttons and sliders. It says "done" after each command.
  controlProcess = runScript('control.ps1', line => {
    if (line === 'done') { controlBusy = false; pumpControl() }
  })
}

async function findArtOnline(title, artist) {
  try {
    const term = encodeURIComponent(title + ' ' + artist)
    const res = await net.fetch('https://itunes.apple.com/search?media=music&entity=song&limit=1&term=' + term)
    const data = await res.json()
    if (!data.results.length) return
    const url = data.results[0].artworkUrl100.replace('100x100', '300x300')
    const picture = Buffer.from(await (await net.fetch(url)).arrayBuffer())
    lastArt = { title, base64: picture.toString('base64') }
    send('art-online', lastArt)
  } catch (e) {}
}
