// Networking layer. Trystero handles WebRTC signaling over public Nostr
// relays, so the whole app runs without any server of our own. The bundle is
// vendored (see vendor/) so there is no runtime CDN dependency either.

import {joinRoom, selfId, getRelaySockets, defaultRelayUrls} from '../vendor/trystero-nostr.min.js'
import {hashStr, mulberry32} from './chooser.js'

export {selfId}

const APP_ID = 'finger-chooser-webrtc-v1'

// Pin well-established public relays instead of trystero's appId-derived
// default picks, which proved unreliable for peer discovery in practice.
const PINNED_RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://relay.nostr.band',
]

// Always-on fallback in case the pinned list rots: a draw from trystero's
// default relay pool, shuffled deterministically from the app id so every
// client computes the same draw and is guaranteed to share these relays.
function fallbackRelays(count) {
  const pool = defaultRelayUrls.filter((url) => !PINNED_RELAY_URLS.includes(url))
  const rand = mulberry32(hashStr(APP_ID))
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}

// Test seam: a `?relays=ws://host:port,...` query param overrides the relay
// list entirely, so the hermetic Chromium e2e (test/e2e) can point every peer
// at a local Nostr relay with no public network. Production never sets it, so
// the pinned + fallback defaults below are untouched.
function relayOverride() {
  try {
    if (typeof location !== 'undefined' && location.search) {
      const relays = new URLSearchParams(location.search).get('relays')
      if (relays) return relays.split(',').filter(Boolean)
    }
  } catch {}
  return null
}

const RELAY_URLS = relayOverride() ?? [...PINNED_RELAY_URLS, ...fallbackRelays(4)]

export function relayStatus() {
  const sockets = Object.values(getRelaySockets())
  return {open: sockets.filter((s) => s.readyState === 1).length, total: sockets.length}
}

export function connect(roomCode, {onFingers, onPick, onName, onPeerJoin, onPeerLeave}) {
  const room = joinRoom({appId: APP_ID, relayConfig: {urls: RELAY_URLS}}, roomCode)

  const fingers = room.makeAction('fingers')
  const pick = room.makeAction('pick')
  const name = room.makeAction('name')

  fingers.onMessage = (data, {peerId}) => onFingers(data, peerId)
  pick.onMessage = (data, {peerId}) => onPick(data, peerId)
  name.onMessage = (data, {peerId}) => onName(data, peerId)
  room.onPeerJoin = onPeerJoin
  room.onPeerLeave = onPeerLeave

  return {
    sendFingers: (data, target) => fingers.send(data, target ? {target} : {}),
    sendPick: (data) => pick.send(data),
    sendName: (data, target) => name.send(data, target ? {target} : {}),
    leave: () => room.leave(),
  }
}
