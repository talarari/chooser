import {connect, selfId, relayStatus} from './net.js'
import {draw} from './render.js'
import {
  MIN_FINGERS, HOLD_MS, REVEAL_MIN_MS, REVEAL_MAX_MS,
  fingerKey, colorFor, peerName, sanitizeName, pickWinner, randomCode, normalizeCode,
} from './chooser.js'

const $ = (sel) => document.querySelector(sel)

const landing = $('#landing')
const app = $('#app')
const canvas = $('#stage')
const ctx = canvas.getContext('2d')
const roomCodeEl = $('#room-code')
const nameEls = [$('#name-pill'), $('#name-landing')]
const copyStateEl = $('#copy-state')
const peerCountEl = $('#peer-count')
const bannerEl = $('#banner')
const tipEl = $('#tip')
const errEl = $('#err')

// surface runtime failures on screen — phones have no devtools handy
function showError(msg) {
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
let winner = null // {key, peerId, x, y, local, color}
let pickedAt = 0

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

// ---- landing / room entry ----

$('#new-room').addEventListener('click', () => enterRoom(randomCode()))

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const code = normalizeCode($('#join-code').value)
  if (code) enterRoom(code)
})

let loopStarted = false

function enterRoom(code) {
  if (net) {
    try { net.leave() } catch {}
    peers.clear()
    localFingers.clear()
    reset()
  }
  roomCode = code
  location.hash = code
  roomCodeEl.textContent = code
  landing.hidden = true
  app.hidden = false

  net = joinNet(code)

  requestWakeLock()
  resize()
  if (!loopStarted) {
    loopStarted = true
    requestAnimationFrame(tick)
  }
}

function joinNet(code) {
  return connect(code, {
    onFingers: (data, peerId) => {
      const peer = ensurePeer(peerId)
      peer.fingers = new Map(Object.entries(data))
      peer.ts = performance.now()
    },
    onPick: (data) => applyPick(data),
    onName: (data, peerId) => {
      ensurePeer(peerId).name = sanitizeName(data) ?? undefined
    },
    onPeerJoin: (peerId) => {
      ensurePeer(peerId)
      // bring the newcomer up to date
      net.sendFingers(packFingers(), peerId)
      net.sendName(myName, peerId)
    },
    onPeerLeave: (peerId) => peers.delete(peerId),
  })
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

function rejoinRoom() {
  try { net.leave() } catch {}
  peers.clear()
  localFingers.clear()
  reset()
  net = joinNet(roomCode)
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
    f.color = colorFor(f.key)
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
      if (progress >= 1 && isHost()) doPick(fingers)
    } else {
      state = 'idle'
      progress = 0
    }
  }

  draw(ctx, {w: canvas.clientWidth, h: canvas.clientHeight, now, fingers, state, progress, winner, pickedAt})

  const relays = relayStatus()
  peerCountEl.textContent =
    `${1 + peers.size} device${peers.size ? 's' : ''} · ${relays.open}/${relays.total} relays`
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
