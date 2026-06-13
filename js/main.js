import {connect, selfId, relayStatus, networkDiagnostics} from './net.js'
import {diagDetails, diagSnapshot} from './diag.js'
import {draw} from './render.js'
import {
  MIN_FINGERS, HOLD_MS, REVEAL_MIN_MS, REVEAL_MAX_MS, MIN_GROUPS, MAX_GROUPS, NEUTRAL_COLOR,
  fingerKey, colorFor, peerName, sanitizeName, pickWinner, assignGroups, groupColor,
  randomCode, normalizeCode,
} from './chooser.js'

const $ = (sel) => document.querySelector(sel)

const landing = $('#landing')
const app = $('#app')
const canvas = $('#stage')
const ctx = canvas.getContext('2d')
const roomCodeEl = $('#room-code')
const nameEls = [$('#name-pill'), $('#name-landing')]
const copyStateEl = $('#copy-state')
const diagnosticShareEl = $('#share-diagnostic')
const peerCountEl = $('#peer-count')
const diagEl = $('#diag')
const bannerEl = $('#banner')
const tipEl = $('#tip')
const errEl = $('#err')
const modeToggleEl = $('#mode-toggle')
const groupStepperEl = $('#group-stepper')
const groupCountLabelEl = $('#group-count-label')

// surface runtime failures on screen — phones have no devtools handy
const errorLog = []

function showError(msg) {
  errorLog.push({at: new Date().toISOString(), message: msg})
  if (errorLog.length > 20) errorLog.shift()
  errEl.textContent = `⚠ ${msg}`
  errEl.hidden = false
}

window.addEventListener('error', (e) => showError(e.message))
window.addEventListener('unhandledrejection', (e) => showError(e.reason?.message ?? String(e.reason)))

// ---- state ----

let net = null
let roomCode = null

const localFingers = new Map() // pointerId -> {x, y} normalized 0..1
const peers = new Map() // peerId -> {fingers: Map<fingerId, [x, y]>, ts, name?}
const bornAt = new Map() // fingerKey -> first-seen timestamp, for pop-in animation

let state = 'idle' // idle | armed | picked
let stableSince = 0
let lastSig = ''
let progress = 0
let winner = null // {key, peerId, x, y, local, color} — set in 'pick' mode
let groupAssignment = null // Map<fingerKey, groupIndex> — set in 'groups' mode
let pickedAt = 0

// Selection mode, shared across the room. 'pick' chooses one finger (the
// original behavior); 'groups' starts everyone neutral and, on the same hold,
// divides the fingers into `groupCount` colored groups instead of a winner.
let mode = 'pick' // 'pick' | 'groups'
let groupCount = 2

const PEER_STALE_MS = 3000

// ---- player name ----

let myName = null
try { myName = sanitizeName(localStorage.getItem('chooser:name')) } catch {}
if (!myName) myName = peerName(selfId)

function renderName() {
  for (const el of nameEls) el.textContent = myName
}
renderName()

function nameOf(peerId) {
  return peers.get(peerId)?.name ?? peerName(peerId)
}

for (const el of nameEls) {
  el.addEventListener('click', () => {
    const next = sanitizeName(prompt('Your name', myName))
    if (!next || next === myName) return
    myName = next
    try { localStorage.setItem('chooser:name', myName) } catch {}
    renderName()
    net?.sendName(myName)
  })
}

function ensurePeer(peerId) {
  let peer = peers.get(peerId)
  if (!peer) {
    peer = {fingers: new Map(), ts: performance.now()}
    peers.set(peerId, peer)
  }
  return peer
}

// ---- selection mode ----

function renderMode() {
  modeToggleEl.textContent = mode === 'groups' ? 'Groups' : 'Pick one'
  groupStepperEl.hidden = mode !== 'groups'
  groupCountLabelEl.textContent = `${groupCount} groups`
  tipEl.textContent = mode === 'groups'
    ? `Everyone holds a finger — they'll be split into ${groupCount} groups`
    : 'Touch and hold with at least two fingers — across any devices in the room'
}

// Apply a mode update that arrived from a peer (no rebroadcast).
function applyMode(data) {
  if (!data) return
  if (data.mode === 'pick' || data.mode === 'groups') mode = data.mode
  if (Number.isFinite(data.groupCount)) {
    groupCount = Math.min(MAX_GROUPS, Math.max(MIN_GROUPS, Math.floor(data.groupCount)))
  }
  renderMode()
}

// Apply a local change and tell the room — mode is a shared room setting.
function broadcastMode() {
  renderMode()
  net?.sendMode({mode, groupCount})
}

modeToggleEl.addEventListener('click', () => {
  mode = mode === 'groups' ? 'pick' : 'groups'
  reset() // clear any in-progress reveal when switching modes
  broadcastMode()
})

$('#group-dec').addEventListener('click', () => {
  groupCount = Math.max(MIN_GROUPS, groupCount - 1)
  broadcastMode()
})

$('#group-inc').addEventListener('click', () => {
  groupCount = Math.min(MAX_GROUPS, groupCount + 1)
  broadcastMode()
})

renderMode()

// ---- landing / room entry ----

$('#new-room').addEventListener('click', () => enterRoom(randomCode()))

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const code = normalizeCode($('#join-code').value)
  if (code) enterRoom(code)
})

let loopStarted = false

// Monotonic join counter. connect() now awaits a TURN-credential fetch, so a
// rapid re-join (or a rejoin-after-suspend racing a manual join) could resolve
// an older join after a newer one. Each join claims a sequence number and only
// installs its room handle if it's still the latest.
let joinSeq = 0

async function enterRoom(code) {
  if (net) {
    try { net.leave() } catch {}
    peers.clear()
    localFingers.clear()
    reset()
  }
  net = null
  roomCode = code
  location.hash = code
  roomCodeEl.textContent = code
  landing.hidden = true
  app.hidden = false

  requestWakeLock()
  resize()
  if (!loopStarted) {
    loopStarted = true
    requestAnimationFrame(tick)
  }

  // net is briefly null while credentials are fetched; every user of net guards
  // with `?.`, and the render loop above is already running.
  net = await joinNet(code)
}

async function joinNet(code) {
  const seq = ++joinSeq
  const room = await connect(code, {
    onFingers: (data, peerId) => {
      const peer = ensurePeer(peerId)
      peer.fingers = new Map(Object.entries(data))
      peer.ts = performance.now()
    },
    onPick: (data) => applyPick(data),
    onName: (data, peerId) => {
      ensurePeer(peerId).name = sanitizeName(data) ?? undefined
    },
    onMode: (data) => applyMode(data),
    onGroup: (data) => applyGroup(data),
    onPeerJoin: (peerId) => {
      ensurePeer(peerId)
      // bring the newcomer up to date
      net.sendFingers(packFingers(), peerId)
      net.sendName(myName, peerId)
      net.sendMode({mode, groupCount}, peerId)
    },
    onPeerLeave: (peerId) => peers.delete(peerId),
  })
  if (seq !== joinSeq) {
    // A newer join started while we awaited TURN credentials — drop this one.
    try { room.leave() } catch {}
    return null
  }
  return room
}

// Mobile browsers freeze the page when the screen locks or the tab is
// backgrounded for a while; WebRTC connections and relay traffic silently
// die. After a long suspension, rejoin the room with fresh connections.
const REJOIN_AFTER_HIDDEN_MS = 15000
let hiddenAt = null

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
  } else if (net && hiddenAt && Date.now() - hiddenAt > REJOIN_AFTER_HIDDEN_MS) {
    rejoinRoom()
  }
})

async function rejoinRoom() {
  try { net.leave() } catch {}
  peers.clear()
  localFingers.clear()
  reset()
  net = null
  net = await joinNet(roomCode)
}

const hashCode = normalizeCode(location.hash.slice(1))
if (hashCode) enterRoom(hashCode)

$('#room-pill').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${roomCode}`
  try {
    if (navigator.share) await navigator.share({title: 'Join my Chooser room', url})
    else await navigator.clipboard.writeText(url)
    copyStateEl.textContent = '✓'
    setTimeout(() => (copyStateEl.textContent = '⧉'), 1500)
  } catch {}
})

function visiblePeers() {
  const now = performance.now()
  return [...peers.entries()].map(([peerId, peer]) => ({
    peerId,
    name: peer.name ?? null,
    fingerCount: peer.fingers.size,
    ageMs: Math.round(now - peer.ts),
  }))
}

async function diagnosticText() {
  const url = `${location.origin}${location.pathname}${location.search}#${roomCode ?? ''}`
  const params = (() => {
    try { return Object.fromEntries(new URLSearchParams(location.search)) } catch { return {} }
  })()
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    url,
    roomCode,
    selfId,
    myName,
    document: {
      visibilityState: document.visibilityState,
      hiddenAt,
      focused: document.hasFocus?.() ?? null,
    },
    runtime: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      online: navigator.onLine,
      secureContext: window.isSecureContext,
      devicePixelRatio: window.devicePixelRatio,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
      },
      capabilities: {
        RTCPeerConnection: Boolean(window.RTCPeerConnection),
        webkitRTCPeerConnection: Boolean(window.webkitRTCPeerConnection),
        webShare: Boolean(navigator.share),
        clipboard: Boolean(navigator.clipboard?.writeText),
        wakeLock: Boolean(navigator.wakeLock),
        vibrate: Boolean(navigator.vibrate),
      },
    },
    query: params,
    network: networkDiagnostics(),
    room: {
      hasNet: Boolean(net),
      peerCount: peers.size,
      peers: visiblePeers(),
      localFingerCount: localFingers.size,
      state,
      mode,
      groupCount,
      isHost: isHost(),
    },
    webrtc: await diagDetails(),
    errors: errorLog,
  }
  return `Chooser diagnostics\n\n${JSON.stringify(diagnostics, null, 2)}`
}

diagnosticShareEl.addEventListener('click', async () => {
  try {
    const text = await diagnosticText()
    if (navigator.share) await navigator.share({title: 'Chooser diagnostics', text})
    else await navigator.clipboard.writeText(text)
    diagnosticShareEl.textContent = 'Copied'
    setTimeout(() => (diagnosticShareEl.textContent = 'Debug'), 1500)
  } catch (error) {
    showError(`diagnostic share failed: ${error?.message ?? String(error)}`)
  }
})

// ---- input ----

function pointerPos(e) {
  return {x: e.clientX / canvas.clientWidth, y: e.clientY / canvas.clientHeight}
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  localFingers.set(e.pointerId, pointerPos(e))
  broadcastFingers()
})

window.addEventListener('pointermove', (e) => {
  if (!localFingers.has(e.pointerId)) return
  localFingers.set(e.pointerId, pointerPos(e))
  scheduleBroadcast()
})

for (const evt of ['pointerup', 'pointercancel']) {
  window.addEventListener(evt, (e) => {
    if (!localFingers.has(e.pointerId)) return
    localFingers.delete(e.pointerId)
    broadcastFingers()
  })
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault())

// ---- networking helpers ----

function packFingers() {
  const out = {}
  for (const [id, f] of localFingers) {
    out[id] = [Math.round(f.x * 1e4) / 1e4, Math.round(f.y * 1e4) / 1e4]
  }
  return out
}

let broadcastQueued = false

function broadcastFingers() {
  broadcastQueued = false
  net?.sendFingers(packFingers())
}

function scheduleBroadcast() {
  if (broadcastQueued) return
  broadcastQueued = true
  requestAnimationFrame(broadcastFingers)
}

// Heartbeat: lets peers expire our fingers if we vanish without a leave event.
setInterval(() => {
  if (net && localFingers.size > 0) broadcastFingers()
}, 1000)

// ---- selection state machine ----

function isHost() {
  let host = selfId
  for (const peerId of peers.keys()) if (peerId < host) host = peerId
  return host === selfId
}

function collectFingers(now) {
  const out = []
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  for (const [id, f] of localFingers) {
    out.push({key: fingerKey(selfId, id), peerId: selfId, x: f.x, y: f.y, local: true})
  }
  for (const [peerId, peer] of peers) {
    if (now - peer.ts > PEER_STALE_MS && peer.fingers.size > 0) peer.fingers.clear()
    for (const [id, [x, y]] of peer.fingers) {
      out.push({key: fingerKey(peerId, id), peerId, x, y, local: false})
    }
  }
  for (const f of out) {
    if (!bornAt.has(f.key)) bornAt.set(f.key, now)
    f.bornAt = bornAt.get(f.key)
    if (groupAssignment) {
      // a group division is revealed: color each finger by its group (driven by
      // the assignment itself, so it renders even if a peer's mode hasn't synced)
      const g = groupAssignment.get(f.key)
      f.group = g ?? null
      f.color = g == null ? NEUTRAL_COLOR : groupColor(g)
    } else if (mode === 'groups') {
      // groups mode, pre-reveal: no finger is colored yet
      f.group = null
      f.color = NEUTRAL_COLOR
    } else {
      f.color = colorFor(f.key)
    }
    f.px = f.x * w
    f.py = f.y * h
  }
  const live = new Set(out.map((f) => f.key))
  for (const key of bornAt.keys()) if (!live.has(key)) bornAt.delete(key)
  return out
}

function doPick(fingers) {
  const seed = (Math.random() * 2 ** 32) >>> 0
  const keys = fingers.map((f) => f.key)
  net.sendPick({seed, keys})
  applyPick({seed, keys})
}

function doGroup(fingers) {
  const seed = (Math.random() * 2 ** 32) >>> 0
  const keys = fingers.map((f) => f.key)
  const count = groupCount
  net.sendGroup({seed, keys, count})
  applyGroup({seed, keys, count})
}

function applyGroup({seed, keys, count}) {
  if (state === 'picked') return
  groupAssignment = assignGroups(keys, seed, count)
  winner = null
  state = 'picked'
  pickedAt = performance.now()
  navigator.vibrate?.(40)
  bannerEl.hidden = false
  bannerEl.style.color = '' // group reveal has no single color; use the default
  bannerEl.textContent = `Split into ${count} group${count === 1 ? '' : 's'}`
}

function applyPick({seed, keys}) {
  if (state === 'picked') return
  const key = pickWinner(keys, seed)
  if (!key) return
  const now = performance.now()
  const f = collectFingers(now).find((x) => x.key === key)
  const peerId = key.split('/')[0]
  winner = {
    key,
    peerId,
    local: peerId === selfId,
    color: colorFor(key),
    px: f ? f.px : canvas.clientWidth / 2,
    py: f ? f.py : canvas.clientHeight / 2,
  }
  state = 'picked'
  pickedAt = now
  navigator.vibrate?.(winner.local ? [80, 60, 160] : 30)
  bannerEl.hidden = false
  bannerEl.style.color = winner.color
  bannerEl.textContent = winner.local ? '🎉 You were chosen!' : `${nameOf(peerId)} was chosen`
}

function reset() {
  state = 'idle'
  winner = null
  groupAssignment = null
  progress = 0
  stableSince = performance.now()
  bannerEl.hidden = true
}

// ---- main loop ----

function tick() {
  const now = performance.now()
  const fingers = collectFingers(now)

  if (state === 'picked') {
    const elapsed = now - pickedAt
    if ((fingers.length === 0 && elapsed > REVEAL_MIN_MS) || elapsed > REVEAL_MAX_MS) {
      reset()
    } else if (winner) {
      // follow the winning finger while it's still down
      const f = fingers.find((x) => x.key === winner.key)
      if (f) {
        winner.px = f.px
        winner.py = f.py
      }
    }
  } else {
    const sig = fingers.map((f) => f.key).sort().join('|')
    if (sig !== lastSig) stableSince = now
    lastSig = sig
    if (fingers.length >= MIN_FINGERS) {
      state = 'armed'
      progress = (now - stableSince) / HOLD_MS
      if (progress >= 1 && isHost()) {
        if (mode === 'groups') doGroup(fingers)
        else doPick(fingers)
      }
    } else {
      state = 'idle'
      progress = 0
    }
  }

  draw(ctx, {w: canvas.clientWidth, h: canvas.clientHeight, now, fingers, state, progress, winner, pickedAt})

  const relays = relayStatus()
  peerCountEl.textContent =
    `${1 + peers.size} device${peers.size ? 's' : ''} · ${relays.open}/${relays.total} relays`

  // WebRTC diagnostic (issue #2): live connection/ICE state + gathered candidate
  // types, so a silent peer-connection failure (the iPhone Safari case) reads
  // out on screen instead of leaving only the healthy-looking relay counter.
  const d = diagSnapshot()
  diagEl.textContent =
    `pc ${d.connection} · ice ${d.ice} · gather ${d.gathering} · ${d.candidates.join('/') || 'no candidates'}`

  tipEl.style.opacity = state === 'idle' && fingers.length === 0 ? 1 : 0

  requestAnimationFrame(tick)
}

// ---- chrome ----

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

window.addEventListener('resize', resize)

async function requestWakeLock() {
  try {
    const lock = await navigator.wakeLock?.request('screen')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestWakeLock()
    }, {once: true})
    void lock
  } catch {}
}
