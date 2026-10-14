const { ipcRenderer } = require('electron')
const $ = id => document.getElementById(id)
const body = document.body
const island = $('island')
const PAGE_H = 200      // height of one page

// ---- Things we need to remember ----
let mode = 'hidden'       // 'hidden' = thin line, 'pill' = small, 'open' = big card
let hovering = false      // mouse is on the island
let peeking = false       // island comes out by itself for a moment
let hudActive = false     // showing volume or brightness in the pill
let hideTimer, peekTimer, hudTimer
let pillWidth = 190       // how wide the small pill is (measured below)
let lastReport = ''
const ringing = []        // timers and alarms that are ringing now: { icon, text }

let page = 'home'         // page we are on
let musicActive = false   // true while music plays, and for 5 seconds after it stops
let lastPlaying = 0       // last time something was playing
let currentTitle = ''     // last song name we saw
let duration = 0          // song length in seconds
let seekHoldUntil = 0     // after you slide the song, wait a moment before listening to the player again
let monthShift = 0        // calendar: 0 = this month, 1 = next month, -1 = last month

// =====================================================
// 1. Hide, small pill, big card
// =====================================================

// What to show when the mouse is away. The pill stays while something rings.
function restMode() { return (peeking || hudActive || ringing.length > 0) ? 'pill' : 'hidden' }

// Tells main.js which area of the screen to watch with the mouse
function report() {
  const state = { mode, pillWidth }
  const text = JSON.stringify(state)
  if (text !== lastReport) { lastReport = text; ipcRenderer.send('state', state) }
}

function setMode(newMode) {
  if (newMode === mode) return
  mode = newMode
  body.dataset.mode = mode
  if (mode === 'open') showFirstPage()
  report()
}

// main.js says if the mouse is on the island or not
ipcRenderer.on('hover', (e, inside) => {
  clearTimeout(hideTimer)
  if (inside) {
    hovering = true
    if (mode === 'hidden') setMode('pill')
  } else {
    hideTimer = setTimeout(() => {          // wait a little before hiding
      hovering = false
      setMode(restMode())
    }, 350)
  }
})

// Click on the pill: stop the ringing, or open the big card
island.addEventListener('click', () => {
  if (ringing.length > 0) { dismissRing(); return }
  if (mode === 'pill') setMode('open')
})

// Come out for 3.5 seconds by itself (new song, charger plugged in)
function peek() {
  peeking = true
  clearTimeout(peekTimer)
  if (mode === 'hidden') setMode('pill')
  peekTimer = setTimeout(() => {
    peeking = false
    if (!hovering && mode === 'pill') setMode(restMode())
  }, 3500)
}

// Shows the volume or brightness in the pill for a moment, like Windows does
function showHud(kind, value, muted) {
  if (mode === 'open') return                       // the sliders on page 2 already show it
  const off = kind === 'volume' && (muted || value === 0)
  $('hudIcon').textContent = kind === 'brightness' ? '☀️' : (off ? '🔇' : value < 34 ? '🔈' : value < 67 ? '🔉' : '🔊')
  $('hudFill').style.width = (off ? 0 : value) + '%'
  $('hudFill').style.background = kind === 'brightness' ? '#ffc233' : '#4cc3ff'
  $('hudNum').textContent = kind === 'volume' && muted ? 'Mute' : value
  body.classList.add('hud')
  hudActive = true
  if (mode === 'hidden') setMode('pill')
  clearTimeout(hudTimer)
  hudTimer = setTimeout(() => {
    body.classList.remove('hud')
    hudActive = false
    if (!hovering && !peeking && mode === 'pill') setMode(restMode())
  }, 1800)
}

// The pill grows or shrinks to fit what is inside it (time, weather, battery, bars)
new ResizeObserver(() => {
  pillWidth = Math.ceil($('pillLayer').offsetWidth)
  island.style.setProperty('--pillW', pillWidth + 'px')
  report()
}).observe($('pillLayer'))

// =====================================================
// 2. Clock (pill, page 2, calendar box)
// =====================================================
function timeText(d) {
  return (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (d.getHours() < 12 ? 'AM' : 'PM')
}
function tick() {
  const d = new Date()
  const hour = d.getHours() % 12 || 12
  $('pillTime').textContent = timeText(d)
  $('homeTime').textContent = hour + ':' + String(d.getMinutes()).padStart(2, '0')
  $('homeAmpm').textContent = d.getHours() < 12 ? 'AM' : 'PM'
  $('homeDate').textContent = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
  // today's box on the calendar page
  $('tileMonth').textContent = d.toLocaleDateString([], { month: 'long' })
  $('tileYear').textContent = d.getFullYear()
  $('tileDay').textContent = d.getDate()
  $('tileWeekday').textContent = d.toLocaleDateString([], { weekday: 'long' })
}
setInterval(tick, 1000); tick()

// =====================================================
// 3. Sliders (one helper for the song, volume and brightness)
// =====================================================
// onDrag runs while you drag (ratio 0 to 1). onDone runs when you let go.
function makeSlider(bar, onDrag, onDone) {
  let active = false
  const ratioAt = e => {
    const box = bar.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
  }
  bar.addEventListener('pointerdown', e => {
    active = true
    bar.classList.add('dragging')
    bar.setPointerCapture(e.pointerId)         // keep getting mouse moves even outside the bar
    ipcRenderer.send('hold', true)             // main.js: stay awake while I drag
    onDrag(ratioAt(e))
  })
  bar.addEventListener('pointermove', e => { if (active) onDrag(ratioAt(e)) })
  const finish = e => {
    if (!active) return
    active = false
    bar.classList.remove('dragging')
    ipcRenderer.send('hold', false)
    onDone(ratioAt(e))
  }
  bar.addEventListener('pointerup', finish)
  bar.addEventListener('pointercancel', finish)
  return { isDragging: () => active }
}

// =====================================================
// 4. Pages (scroll and dots)
// =====================================================
const pageEls = { music: $('pageMusic'), home: $('pageHome'), timer: $('pageTimer'),
                  calendar: $('pageCalendar'), weather: $('pageWeather') }

// The music page is only in the list when music is active
function pageList() {
  return (musicActive ? ['music'] : []).concat(['home', 'weather', 'calendar', 'timer'])
}

// Puts every page in its place: the current one in view, others above or below it
function layoutPages() {
  const list = pageList()
  if (!list.includes(page)) page = 'home'
  const current = list.indexOf(page)
  for (const name in pageEls) {
    const position = list.indexOf(name)
    const el = pageEls[name]
    if (position === -1) {                                  // not in the list: park it away
      el.style.transform = 'translateY(' + PAGE_H + 'px)'
      el.style.opacity = 0
    } else {
      el.style.transform = 'translateY(' + (position - current) * PAGE_H + 'px)'
      el.style.opacity = position === current ? 1 : 0
    }
  }
  $('dots').innerHTML = list.map(n => '<i data-page="' + n + '"' + (n === page ? ' class="on"' : '') + '></i>').join('')
}

function goTo(name) {
  if (name === page) return
  page = name
  layoutPages()
}

function showFirstPage() {
  page = musicActive ? 'music' : 'home'
  resetCalendar()
  layoutPages()
}

$('dots').onclick = e => { if (e.target.dataset.page) goTo(e.target.dataset.page) }

// Mouse wheel moves between pages
let scrollLocked = false
island.addEventListener('wheel', e => {
  if (mode !== 'open') return
  e.preventDefault()
  if (scrollLocked || Math.abs(e.deltaY) < 4) return
  scrollLocked = true
  setTimeout(() => { scrollLocked = false }, 450)       // one page per scroll
  const list = pageList()
  const next = list.indexOf(page) + (e.deltaY > 0 ? 1 : -1)
  if (next >= 0 && next < list.length) goTo(list[next])
}, { passive: false })

// =====================================================
// 5. Calendar with sliding months
// =====================================================
function monthName(shift) {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + shift, 1)
    .toLocaleDateString([], { month: 'long', year: 'numeric' })
}

// Makes the grid of days for one month
function buildMonth(shift) {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() + shift, 1)
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const grid = document.createElement('div')
  grid.className = 'days'
  let html = ''
  for (let i = 0; i < first.getDay(); i++) html += '<div></div>'     // empty boxes before day 1
  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = (first.getDay() + day - 1) % 7                    // 0 = Sunday, 6 = Saturday
    const isToday = shift === 0 && day === now.getDate()
    html += '<div class="' + (weekday === 0 || weekday === 6 ? 'weekend ' : '') + (isToday ? 'today' : '') + '">' + day + '</div>'
  }
  grid.innerHTML = html
  return grid
}

function resetCalendar() {
  monthShift = 0
  $('calWrap').innerHTML = ''
  $('calWrap').appendChild(buildMonth(0))
  $('calTitle').textContent = monthName(0)
}

// direction: 1 = next month (slides to the left), -1 = last month (slides to the right)
function changeMonth(direction) {
  monthShift += direction
  $('calTitle').textContent = monthName(monthShift)
  const oldGrid = $('calWrap').lastElementChild
  const newGrid = buildMonth(monthShift)
  newGrid.style.transform = 'translateX(' + direction * 100 + '%)'    // new month waits on the side
  $('calWrap').appendChild(newGrid)
  void newGrid.offsetWidth                                            // lets the browser see the start place
  oldGrid.style.transform = 'translateX(' + -direction * 100 + '%)'   // old month slides out
  newGrid.style.transform = 'translateX(0)'                           // new month slides in
  setTimeout(() => oldGrid.remove(), 500)
}
$('calPrev').onclick = () => changeMonth(-1)
$('calNext').onclick = () => changeMonth(1)

// =====================================================
// 6. Music
// =====================================================

// The music page stays for 5 seconds after the audio stops, then it goes away
setInterval(() => {
  const active = Date.now() - lastPlaying < 5000
  if (active !== musicActive) {
    musicActive = active
    layoutPages()
  }
}, 500)

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec))
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')
}
function dataUrl(base64) {
  return 'data:image/' + (base64.startsWith('/9j/') ? 'jpeg' : 'png') + ';base64,' + base64
}

// Finds the main colour of the song picture and uses it for the slider and the glow
function setTint(src) {
  const root = document.documentElement
  if (!src) { root.style.removeProperty('--tint'); return }
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 12
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, 12, 12)
    const px = ctx.getImageData(0, 0, 12, 12).data
    let r = 0, g = 0, b = 0, total = 0
    for (let i = 0; i < px.length; i += 4) {
      const spread = Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2])
      const weight = 1 + spread / 20                      // colourful pixels count more
      r += px[i] * weight; g += px[i + 1] * weight; b += px[i + 2] * weight; total += weight
    }
    r /= total; g /= total; b /= total
    const k = Math.min(2.2, 220 / Math.max(r, g, b, 1))   // make it bright enough to see on black
    root.style.setProperty('--tint', 'rgb(' + Math.min(255, r * k) + ',' + Math.min(255, g * k) + ',' + Math.min(255, b * k) + ')')
  }
  img.src = src
}

function setArt(src) {
  const image = src ? 'url("' + src + '")' : ''
  $('art').style.backgroundImage = image
  $('glow').style.backgroundImage = image
  $('art').classList.toggle('has', !!src)
  setTint(src)
}

// Moves the song slider and the two times (instant = no sliding animation)
function setProgress(position, length, instant) {
  const bar = $('bar')
  const ratio = length > 0 ? Math.min(1, Math.max(0, position / length)) : 0
  if (instant) bar.classList.add('instant')
  $('fill').style.width = ratio * 100 + '%'
  $('knob').style.left = ratio * 100 + '%'
  if (instant) { void bar.offsetWidth; bar.classList.remove('instant') }
  $('elapsed').textContent = fmt(position)
  $('remaining').textContent = length > 0 ? '-' + fmt(length - position) : '--:--'
}

const songSlider = makeSlider($('bar'),
  ratio => { if (duration > 0) setProgress(ratio * duration, duration, true) },
  ratio => {
    if (!(duration > 0)) return
    seekHoldUntil = Date.now() + 1500                   // wait a moment so the bar does not jump back
    ipcRenderer.send('control', 'seek ' + (ratio * duration).toFixed(1))
  })

ipcRenderer.on('media', (e, m) => {
  body.classList.toggle('playing', m.playing)       // only a class changes, buttons are never replaced
  if (m.playing) lastPlaying = Date.now()
  if (!m.title) return                              // nothing playing: keep the last song for now

  const changed = m.title !== currentTitle
  currentTitle = m.title
  duration = m.duration
  $('title').textContent = m.title
  $('artist').textContent = m.artist || ''
  $('source').textContent = m.source || ''

  if (changed) setArt('')                           // remove the old picture
  if ('art' in m) setArt(dataUrl(m.art))            // picture from Windows (only sent when the song changes)

  // Do not move the slider while you are dragging it (or just after)
  if (changed || (!songSlider.isDragging() && Date.now() > seekHoldUntil)) setProgress(m.position, m.duration, changed)

  if (changed && m.playing) peek()                  // new song: come out for a moment
})

// Picture found online (when Windows had none)
ipcRenderer.on('art-online', (e, a) => { if (a.title === currentTitle) setArt(dataUrl(a.base64)) })

$('prev').onclick = () => ipcRenderer.send('control', 'prev')
$('play').onclick = () => ipcRenderer.send('control', 'playpause')
$('next').onclick = () => ipcRenderer.send('control', 'next')

// =====================================================
// 7. Page 2: volume, brightness, Wi-Fi, Bluetooth
// =====================================================
let lastVolume = null, lastMuted = false, lastBrightness = null
let lastDevices = null
let volHoldUntil = 0, brightHoldUntil = 0
let lastVolumeSent = 0, lastBrightSent = 0
let wifiOn = true, btOn = true             // are the Wi-Fi and Bluetooth radios on?
let wifiHoldUntil = 0, btHoldUntil = 0     // after you click a tile, ignore old news for a few seconds
let wifiName = '', devices = []

function setVolume(percent, muted) {
  $('volFill').style.width = (muted ? 0 : percent) + '%'
  $('volKnob').style.left = (muted ? 0 : percent) + '%'
  $('volNum').textContent = muted ? 'Mute' : percent
  $('volIcon').textContent = (muted || percent === 0) ? '🔇' : '🔊'
}
function setBrightness(percent) {
  $('brightFill').style.width = percent + '%'
  $('brightKnob').style.left = percent + '%'
  $('brightNum').textContent = percent
}

// Volume and brightness change while you drag. main.js keeps only the newest value, so it never falls behind.
const volSlider = makeSlider($('volBar'),
  ratio => {
    setVolume(Math.round(ratio * 100), false)
    if (Date.now() - lastVolumeSent > 80) {
      lastVolumeSent = Date.now()
      ipcRenderer.send('control', 'volume ' + ratio.toFixed(2))
    }
  },
  ratio => {
    volHoldUntil = Date.now() + 1000
    ipcRenderer.send('control', 'volume ' + ratio.toFixed(2))
  })
const brightSlider = makeSlider($('brightBar'),
  ratio => {
    setBrightness(Math.round(ratio * 100))
    if (Date.now() - lastBrightSent > 80) {
      lastBrightSent = Date.now()
      ipcRenderer.send('control', 'brightness ' + Math.round(ratio * 100))
    }
  },
  ratio => {
    brightHoldUntil = Date.now() + 1500
    ipcRenderer.send('control', 'brightness ' + Math.round(ratio * 100))
  })
$('volIcon').onclick = () => ipcRenderer.send('control', 'mute')

// ---- Wi-Fi and Bluetooth tiles: click to turn on or off ----
function drawNetwork() {
  $('wifiTile').classList.toggle('off', !wifiOn)
  $('wifiName').textContent = !wifiOn ? 'Off' : (wifiName || 'Not connected')
  $('btTile').classList.toggle('off', !btOn)
  $('btName').textContent = !btOn ? 'Off' : devices.length === 0 ? 'Not connected'
    : devices.length === 1 ? devices[0] : devices[0] + ' +' + (devices.length - 1)
}
$('wifiTile').onclick = () => {
  wifiOn = !wifiOn                                    // change the tile at once, Windows confirms later
  wifiHoldUntil = Date.now() + 5000
  ipcRenderer.send('control', 'wifi ' + (wifiOn ? 'on' : 'off'))
  drawNetwork()
}
$('btTile').onclick = () => {
  btOn = !btOn
  btHoldUntil = Date.now() + 5000
  ipcRenderer.send('control', 'bluetooth ' + (btOn ? 'on' : 'off'))
  drawNetwork()
}
drawNetwork()

// main.js sends this every time the volume or the brightness changes (also when you use the keyboard keys)
ipcRenderer.on('levels', (e, s) => {
  if (s.volume >= 0) {
    $('volBar').classList.remove('off')
    if (!volSlider.isDragging() && Date.now() > volHoldUntil) setVolume(s.volume, s.muted)
    if (lastVolume !== null && (s.volume !== lastVolume || s.muted !== lastMuted)) showHud('volume', s.volume, s.muted)
    lastVolume = s.volume
    lastMuted = s.muted
  } else {
    $('volBar').classList.add('off')
  }

  // Brightness (only laptop screens can do this)
  if (s.brightness >= 0) {
    $('brightBar').classList.remove('off')
    if (!brightSlider.isDragging() && Date.now() > brightHoldUntil) setBrightness(s.brightness)
    if (lastBrightness !== null && s.brightness !== lastBrightness) showHud('brightness', s.brightness, false)
    lastBrightness = s.brightness
  } else {
    $('brightBar').classList.add('off')
    $('brightNum').textContent = '--'
  }
})

// main.js sends this once a second: Wi-Fi and Bluetooth
ipcRenderer.on('status', (e, s) => {
  wifiName = s.wifi || ''
  devices = Array.isArray(s.bluetooth) ? s.bluetooth : (s.bluetooth ? [s.bluetooth] : [])
  if (typeof s.wifiOn === 'boolean' && Date.now() > wifiHoldUntil) wifiOn = s.wifiOn
  if (typeof s.btOn === 'boolean' && Date.now() > btHoldUntil) btOn = s.btOn
  drawNetwork()

  // a new Bluetooth device connected: come out for a moment
  if (lastDevices !== null && devices.some(d => !lastDevices.includes(d))) peek()
  lastDevices = devices
})

// =====================================================
// 8. Weather
// =====================================================
function weatherLook(code) {      // weather code -> [picture, words, glow colour]
  if (code === 0) return ['☀️', 'Clear', 'rgba(255,170,60,.2)']
  if (code <= 2) return ['⛅', 'Partly cloudy', 'rgba(255,200,90,.17)']
  if (code === 3) return ['☁️', 'Cloudy', 'rgba(140,165,210,.17)']
  if (code === 45 || code === 48) return ['🌫️', 'Foggy', 'rgba(170,180,195,.16)']
  if (code >= 51 && code <= 67) return ['🌧️', 'Rain', 'rgba(60,140,255,.2)']
  if (code >= 71 && code <= 77) return ['❄️', 'Snow', 'rgba(150,210,255,.2)']
  if (code >= 80 && code <= 82) return ['🌦️', 'Showers', 'rgba(60,140,255,.2)']
  if (code >= 85 && code <= 86) return ['🌨️', 'Snow showers', 'rgba(150,210,255,.2)']
  if (code >= 95) return ['⛈️', 'Thunderstorm', 'rgba(150,90,255,.22)']
  return ['🌡️', '', 'rgba(76,195,255,.16)']
}

ipcRenderer.on('weather', (e, w) => {
  const [icon, words, glow] = weatherLook(w.code)
  $('pillWeather').textContent = icon + ' ' + w.temp + '°'
  $('wCity').textContent = w.city
  $('wIcon').textContent = icon
  $('wTemp').textContent = w.temp + '°'
  $('wText').textContent = words
  $('wWind').textContent = w.wind + ' km/h'
  $('wFeels').textContent = w.feels + '°'
  $('wHumidity').textContent = w.humidity + '%'
  $('pageWeather').style.setProperty('--sky', glow)
})

// =====================================================
// 9. Battery (in the pill and on page 2)
// =====================================================
navigator.getBattery().then(b => {
  const percent = () => Math.round(b.level * 100)
  const show = () => {
    const p = percent()
    const low = p <= 15 && !b.charging
    // page 2
    $('battFill').style.width = p + '%'
    $('battText').textContent = p + '%'
    $('battery').classList.toggle('charging', b.charging)
    $('battery').classList.toggle('low', low)
    // small pill: battery picture, bolt while charging, and the number
    $('pillBattFill').setAttribute('width', 19.8 * p / 100)
    $('pillBattery').classList.toggle('charging', b.charging)
    $('pillBattery').classList.toggle('low', low)
    $('pillBattText').textContent = p + '%'
  }
  b.onlevelchange = () => {
    show()
    if (!b.charging && (percent() === 20 || percent() === 10)) peek()      // battery low: come out
  }
  b.onchargingchange = () => { show(); peek() }                            // plug or unplug: come out
  show()
})

// =====================================================
// 10. Timer, stopwatch and alarms
//     They are saved in a file (by main.js), so they are not lost when the app restarts
// =====================================================
let timer = { total: 300, left: 300, endsAt: 0 }   // total = seconds you chose, left = seconds left, endsAt = when it ends (0 = not running)
let stopwatch = { elapsed: 0, startedAt: 0 }       // elapsed = milliseconds, startedAt = when it started (0 = stopped)
let alarms = []                                    // each one: { id, hour, minute, on, next }
let newAlarm = { hour: 7, minute: 30, pm: false }  // the time shown in the alarm picker
let tab = 'timer'                                  // 'timer', 'stopwatch' or 'alarm'

function saveClock() { ipcRenderer.send('save-clock', { timer, stopwatch, alarms }) }

function loadClock() {
  const data = ipcRenderer.sendSync('load-clock')
  if (!data) return
  if (data.timer) timer = data.timer
  if (data.stopwatch) stopwatch = data.stopwatch
  if (data.alarms) alarms = data.alarms
}

function pad(n) { return String(n).padStart(2, '0') }

// ---------- Ringing: the pill comes out, makes a sound, and stays until you click it ----------
let audioContext = null
let soundTimer = null

function beeps() {                                 // four short beeps
  audioContext = audioContext || new AudioContext()
  if (audioContext.state === 'suspended') audioContext.resume()
  const start = audioContext.currentTime
  for (let i = 0; i < 4; i++) {
    const osc = audioContext.createOscillator()
    const gain = audioContext.createGain()
    osc.frequency.value = i % 2 ? 1175 : 988        // two notes, up and down
    const t = start + i * 0.2
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
    osc.connect(gain)
    gain.connect(audioContext.destination)
    osc.start(t)
    osc.stop(t + 0.18)
  }
}
function startSound() {
  if (soundTimer) return
  beeps()
  soundTimer = setInterval(beeps, 1500)            // again and again until you click the pill
}
function stopSound() {
  clearInterval(soundTimer)
  soundTimer = null
}

function showRing() {
  const first = ringing[0]
  if (!first) { body.classList.remove('ring'); return }
  $('ringIcon').textContent = first.icon
  $('ringText').textContent = first.text + (ringing.length > 1 ? '  +' + (ringing.length - 1) : '')
  body.classList.add('ring')
}

function ring(icon, text) {
  ringing.push({ icon, text })
  showRing()
  startSound()
  if (mode !== 'pill') setMode('pill')             // comes out (also closes the big card if it was open)
}

// Click on the pill while it rings: stop this one. If another is ringing, show that next.
function dismissRing() {
  ringing.shift()
  showRing()
  if (ringing.length === 0) {
    stopSound()
    if (!hovering && !peeking && mode === 'pill') setMode(restMode())
  }
}

// ---------- Timer ----------
function timerLeft() { return timer.endsAt ? Math.max(0, (timer.endsAt - Date.now()) / 1000) : timer.left }

function formatTimer(seconds) {
  seconds = Math.ceil(seconds)
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s)
}

function drawTimer() {
  const left = timerLeft()
  const running = timer.endsAt > 0
  const started = running || timer.left < timer.total
  $('timerTime').textContent = formatTimer(left)
  $('timerFill').style.width = (timer.total > 0 ? left / timer.total * 100 : 0) + '%'
  $('tabTimer').classList.toggle('started', started)
  $('timerStart').textContent = running ? 'Pause' : (started ? 'Resume' : 'Start')
}

function setTimerMinutes(minutes) {                // only before it starts
  if (timer.endsAt || timer.left < timer.total) return
  timer.total = timer.left = Math.min(99 * 60, Math.max(60, Math.round(minutes * 60)))
  saveClock()
  drawTimer()
}
$('timerPlus').onclick = () => setTimerMinutes(timer.total / 60 + 1)
$('timerMinus').onclick = () => setTimerMinutes(timer.total / 60 - 1)
$('timerChips').onclick = e => { if (e.target.dataset.minutes) setTimerMinutes(Number(e.target.dataset.minutes)) }

$('timerStart').onclick = () => {
  if (timer.endsAt) { timer.left = timerLeft(); timer.endsAt = 0 }                    // pause
  else if (timer.left > 0) timer.endsAt = Date.now() + timer.left * 1000              // start, or go on
  saveClock()
  drawTimer()
}
$('timerReset').onclick = () => {
  timer.endsAt = 0
  timer.left = timer.total
  saveClock()
  drawTimer()
}

function checkTimer() {                            // is the timer finished?
  if (!timer.endsAt || Date.now() < timer.endsAt) return
  const lateBy = Date.now() - timer.endsAt
  timer.endsAt = 0
  timer.left = timer.total
  saveClock()
  drawTimer()
  if (lateBy < 10 * 60 * 1000) ring('⏱️', 'Timer finished')     // not if it ended long ago while the app was closed
}

// ---------- Stopwatch ----------
function stopwatchTime() { return stopwatch.elapsed + (stopwatch.startedAt ? Date.now() - stopwatch.startedAt : 0) }

function formatStopwatch(ms) {
  const hundredths = Math.floor(ms / 10)
  const cs = hundredths % 100
  const s = Math.floor(hundredths / 100) % 60
  const m = Math.floor(hundredths / 6000) % 60
  const h = Math.floor(hundredths / 360000)
  return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s) + '.' + pad(cs)
}

function drawStopwatch() {
  const running = stopwatch.startedAt > 0
  $('swTime').textContent = formatStopwatch(stopwatchTime())
  $('swTime').classList.toggle('running', running)
  $('swStart').textContent = running ? 'Stop' : (stopwatch.elapsed > 0 ? 'Resume' : 'Start')
}

$('swStart').onclick = () => {
  if (stopwatch.startedAt) { stopwatch.elapsed += Date.now() - stopwatch.startedAt; stopwatch.startedAt = 0 }
  else stopwatch.startedAt = Date.now()
  saveClock()
  drawStopwatch()
}
$('swReset').onclick = () => {
  stopwatch = { elapsed: 0, startedAt: 0 }
  saveClock()
  drawStopwatch()
}

// ---------- Alarms ----------
function alarmText(a) {
  return (a.hour % 12 || 12) + ':' + pad(a.minute) + ' ' + (a.hour < 12 ? 'AM' : 'PM')
}

// Works out the next time this alarm should ring (today if it is still to come, else tomorrow)
function armAlarm(a) {
  const t = new Date()
  t.setHours(a.hour, a.minute, 0, 0)
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1)
  a.next = t.getTime()
}

function drawPicker() {
  $('alHour').textContent = newAlarm.hour
  $('alMin').textContent = pad(newAlarm.minute)
  $('alAmpm').textContent = newAlarm.pm ? 'PM' : 'AM'
}

function drawAlarms() {
  const today = new Date().toDateString()
  $('alarmList').innerHTML = alarms.map(a =>
    '<div class="alarmRow"><div class="alText"><b>' + alarmText(a) + '</b><small>' +
    (a.on ? (new Date(a.next).toDateString() === today ? 'Today' : 'Tomorrow') : 'Off') + '</small></div>' +
    '<div class="sw' + (a.on ? ' on' : '') + '" data-toggle="' + a.id + '"></div>' +
    '<button class="del" data-delete="' + a.id + '">×</button></div>').join('') ||
    '<div class="emptyAlarm">No alarms yet</div>'
  $('alarmAdd').classList.toggle('off', alarms.length >= 3)
  $('alarmAdd').textContent = alarms.length >= 3 ? '3 alarms (full)' : 'Add alarm'
}

function stepAlarm(field, delta) {
  if (field === 'hour') newAlarm.hour = (newAlarm.hour - 1 + delta + 12) % 12 + 1
  if (field === 'minute') newAlarm.minute = (newAlarm.minute + delta + 60) % 60
  if (field === 'ampm') newAlarm.pm = !newAlarm.pm
  drawPicker()
}

$('picker').onclick = e => {
  const button = e.target.closest('button')
  if (button) stepAlarm(button.dataset.f, Number(button.dataset.d))
}
let lastPickerWheel = 0
$('picker').addEventListener('wheel', e => {       // scroll on a number to change it
  e.preventDefault()
  e.stopPropagation()                              // do not change the page
  const column = e.target.closest('.col')
  if (!column || Date.now() - lastPickerWheel < 90) return
  lastPickerWheel = Date.now()
  stepAlarm(column.dataset.f, e.deltaY < 0 ? 1 : -1)
}, { passive: false })

$('alarmAdd').onclick = () => {
  if (alarms.length >= 3) return
  const a = { id: Date.now(), hour: (newAlarm.hour % 12) + (newAlarm.pm ? 12 : 0), minute: newAlarm.minute, on: true, next: 0 }
  armAlarm(a)
  alarms.push(a)
  alarms.sort((x, y) => (x.hour * 60 + x.minute) - (y.hour * 60 + y.minute))
  saveClock()
  drawAlarms()
}

$('alarmList').onclick = e => {
  const id = Number(e.target.dataset.toggle || e.target.dataset.delete)
  const a = alarms.find(x => x.id === id)
  if (!a) return
  if (e.target.dataset.toggle) { a.on = !a.on; if (a.on) armAlarm(a) }
  if (e.target.dataset.delete) alarms = alarms.filter(x => x.id !== id)
  saveClock()
  drawAlarms()
}

function checkAlarms() {
  const now = Date.now()
  let changed = false
  alarms.forEach(a => {
    if (!a.on || now < a.next) return
    a.on = false                                   // an alarm rings once, then it switches itself off
    changed = true
    if (now - a.next < 5 * 60 * 1000) ring('⏰', 'Alarm ' + alarmText(a))
  })
  if (changed) { saveClock(); drawAlarms() }
}

// ---------- Tabs ----------
$('tabs').onclick = e => {
  if (!e.target.dataset.tab) return
  tab = e.target.dataset.tab
  $('tabTimer').classList.toggle('on', tab === 'timer')
  $('tabStopwatch').classList.toggle('on', tab === 'stopwatch')
  $('tabAlarm').classList.toggle('on', tab === 'alarm')
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
}

// Checks 20 times a second. Draws the numbers only while you are looking at them.
setInterval(() => {
  checkTimer()
  checkAlarms()
  if (mode === 'open' && page === 'timer') {
    if (tab === 'timer') drawTimer()
    if (tab === 'stopwatch') drawStopwatch()
  }
}, 50)

// =====================================================
// Start
// =====================================================
loadClock()
drawTimer()
drawStopwatch()
drawPicker()
drawAlarms()
resetCalendar()
layoutPages()
if (!location.search.includes('quiet')) peek()      // come out once at the start (not after unlock)