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

// Open Relay (metered.ca) free public TURN — ~20 GB/mo, static public
// credentials. STUN-only candidates fail when two peers can't reach each other
// directly: most painfully iPhone Safari, which gathers only mDNS `.local` host
// candidates it won't resolve for the peer and so never connects on a plain LAN
// (issue #2). A relayed (TURN) candidate has a real public address — nothing to
// resolve, no NAT to pierce — so it's the universal fallback. trystero appends
// turnConfig onto its STUN defaults (iceServers: defaultStun.concat(turnConfig))
// and ICE still prefers a direct path, only relaying when nothing else works,
// so this costs no relay bandwidth for peers that connect directly (e.g.
// Chrome↔Chrome on a LAN). Public/free = best-effort reliability; swap in a
// dedicated provider (e.g. Cloudflare TURN) once traffic warrants it.
const TURN_SERVERS = [
  {urls: 'stun:stun.relay.metered.ca:80'},
  {urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject'},
  {urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject'},
  {urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject'},
  // TLS on 443/TCP — the transport that survives UDP-blocking and restrictive
  // firewalls (best practice for a TURN fallback that must "always" connect).
  {urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject'},
]

// Test seam: `?ice=relay` forces ICE to use only relay (TURN) candidates, so the
// e2e can prove traffic actually traverses the TURN server (no direct path can
// mask a broken relay). Production never sets it, so ICE keeps preferring direct.
function forceRelayOnly() {
  try {
    if (typeof location !== 'undefined' && location.search) {
      return new URLSearchParams(location.search).get('ice') === 'relay'
    }
  } catch {}
  return false
}

export function relayStatus() {
  const sockets = Object.values(getRelaySockets())
  return {open: sockets.filter((s) => s.readyState === 1).length, total: sockets.length}
}

export function connect(roomCode, {onFingers, onPick, onName, onPeerJoin, onPeerLeave}) {
  const room = joinRoom({
    appId: APP_ID,
    relayConfig: {urls: RELAY_URLS},
    turnConfig: TURN_SERVERS,
    ...(forceRelayOnly() ? {rtcConfig: {iceTransportPolicy: 'relay'}} : {}),
  }, roomCode)

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
