// Networking layer. Trystero handles WebRTC signaling over public Nostr
// relays, so the whole app runs without any server of our own. The bundle is
// vendored (see vendor/) so there is no runtime CDN dependency either.

import {joinRoom, selfId, getRelaySockets, defaultRelayUrls} from '../vendor/trystero-nostr.min.js'
import {hashStr, mulberry32} from './chooser.js'
import './diag.js' // installs the RTCPeerConnection wrap before any joinRoom()
import {nostrDiagnostics} from './relaydiag.js' // wraps relay WebSockets, same timing

export {selfId}

const APP_ID = 'finger-chooser-webrtc-v1'

// Pin well-established public relays instead of trystero's appId-derived
// default picks, which proved unreliable for peer discovery in practice.
//
// Curated to relays that reliably ACCEPT trystero's ephemeral signaling. Every
// trickled ICE candidate is published to every relay per peer, so a hostile
// relay isn't just dead weight — its rejections are pure flood with no payoff.
// Dropped on real-device evidence (iPhone, room 5KM3): relay.damus.io
// ("rate-limited: you are noting too much" — refused 13 of 20 publishes) and
// relay02.lnfi.network ("rate-limited: slow down") throttled us; offchain.pub
// hard-rejects anonymous events ("Policy violated and pubkey is not in our web
// of trust"); relay.nostr.band never finished connecting. The relays below all
// accepted ~100 publishes and delivered peer traffic back in the same capture.
const PINNED_RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.agorist.space',
  'wss://hol.is',
  'wss://koru.bitcointxoko.org',
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

// Six curated relays already give ample discovery redundancy; the fallback is
// just insurance against the pinned list rotting, so keep it small — every
// extra relay multiplies the per-candidate publish fan-out (the flood we're
// trimming), and an undrawn-quality relay can re-introduce rejections.
const RELAY_URLS = relayOverride() ?? [...PINNED_RELAY_URLS, ...fallbackRelays(2)]

// TURN relay. STUN-only candidates fail when two peers can't reach each other
// directly: most painfully iPhone Safari, which gathers only mDNS `.local` host
// candidates it won't resolve for the peer and so never connects on a plain LAN
// (issue #2). A relayed (TURN) candidate has a real public address — nothing to
// resolve, no NAT to pierce — so it's the universal fallback.
//
// Free public TURN with universal static credentials no longer exists (Open
// Relay's `openrelayproject` credentials were retired and now return 400/701),
// so we use Cloudflare TURN, which mints SHORT-LIVED credentials from a key
// whose API token is a secret. The token must never ship in client JS, so a
// tiny Cloudflare Worker (see turn-worker/) holds it and exposes only a minting
// endpoint; we fetch fresh ICE servers from there at join time. trystero
// appends our turnConfig onto its STUN defaults (iceServers:
// defaultStun.concat(turnConfig)) and ICE still prefers a direct path, only
// relaying when nothing else works, so this costs no relay bandwidth for peers
// that connect directly (e.g. Chrome↔Chrome on a LAN).
//
// The deployed Worker URL (see turn-worker/). Empty would mean STUN-only,
// exactly as before TURN existed; the ?turn= seam below overrides it for
// tests/local dev.
const TURN_ENDPOINT = 'https://chooser-turn.talarari.workers.dev'

let lastTurnFetch = {
  endpoint: TURN_ENDPOINT,
  attempted: false,
  ok: false,
  durationMs: null,
  iceServerCount: 0,
  iceServerUrls: [],
  error: null,
}

// Test seam: `?turn=<url>` overrides the Worker endpoint (point the e2e at a
// local `wrangler dev`), and `?turn=` (empty) disables TURN entirely.
function turnEndpoint() {
  try {
    if (typeof location !== 'undefined' && location.search) {
      const override = new URLSearchParams(location.search).get('turn')
      if (override !== null) return override
    }
  } catch {}
  return TURN_ENDPOINT
}

// Fetch fresh ICE servers from the Worker. Best-effort: on any failure (no
// endpoint, network error, slow Worker) we fall back to STUN-only so joining is
// never blocked by TURN — peers that can connect directly still do, exactly as
// before TURN existed. The 3s timeout caps how long a join can wait on it.
async function fetchTurnServers() {
  const endpoint = turnEndpoint()
  lastTurnFetch = {
    endpoint,
    attempted: Boolean(endpoint),
    ok: false,
    durationMs: null,
    iceServerCount: 0,
    iceServerUrls: [],
    error: null,
  }
  if (!endpoint) return []
  const started = performance.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(endpoint, {signal: ctrl.signal})
    lastTurnFetch.durationMs = Math.round(performance.now() - started)
    if (!res.ok) {
      lastTurnFetch.error = `HTTP ${res.status}`
      return []
    }
    const {iceServers} = await res.json()
    const servers = iceServers ? [].concat(iceServers) : []
    lastTurnFetch.ok = true
    lastTurnFetch.iceServerCount = servers.length
    lastTurnFetch.iceServerUrls = servers.flatMap(({urls}) => [].concat(urls ?? []))
    return servers
  } catch (error) {
    lastTurnFetch.durationMs = Math.round(performance.now() - started)
    lastTurnFetch.error = error?.name === 'AbortError' ? 'timeout' : error?.message ?? String(error)
    return []
  } finally {
    clearTimeout(timer)
  }
}

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

export function networkDiagnostics() {
  const sockets = getRelaySockets()
  return {
    appId: APP_ID,
    relayUrls: RELAY_URLS,
    relays: Object.entries(sockets).map(([url, socket]) => ({
      url,
      readyState: socket.readyState,
    })),
    turn: lastTurnFetch,
    forceRelayOnly: forceRelayOnly(),
    // Discovery layer (relaydiag.js): whether announce traffic actually crosses
    // the relays. `nostr.distinctPubkeys` >= 2 means the peer's announce is
    // arriving; stuck at 1 means we're alone on the wire despite open sockets.
    nostr: nostrDiagnostics(),
  }
}

export async function connect(roomCode, {onFingers, onPick, onName, onMode, onGroup, onPeerJoin, onPeerLeave}) {
  const turnConfig = await fetchTurnServers()
  const room = joinRoom({
    appId: APP_ID,
    relayConfig: {urls: RELAY_URLS},
    turnConfig,
    // Keep trickle ICE ON (trystero's default). Disabling it (tried in #7) is a
    // trap with TURN configured: trystero then withholds the SDP offer until ICE
    // gathering reaches `complete`, but Cloudflare hands back many TURN URLs
    // (:3478, :53, :80/tcp, :443/tcp, :5349/tcp …) and a browser waits on every
    // one before completing. Some gather slowly or never respond — on WebKit
    // (iPhone) gathering stays `gathering` indefinitely — so the offer is never
    // sent, the peer never answers (`remoteDescription: null`, `signaling:
    // have-local-offer`), and no data channel opens. Real-device logs and the
    // forced-relay e2e both showed this: trickle-off stalls/fails the relay
    // path, trickle-on connects in ~1s. Trickle delivers candidates as they're
    // gathered over the (reliable, persistent-websocket) Nostr relays, so the
    // relay candidate still reaches the peer — without gating on gathering ever
    // completing.
    ...(forceRelayOnly() ? {rtcConfig: {iceTransportPolicy: 'relay'}} : {}),
  }, roomCode)

  const fingers = room.makeAction('fingers')
  // `pick` reveals winners: {seed, keys, count} (count = number of winners).
  const pick = room.makeAction('pick')
  const name = room.makeAction('name')
  // `mode` syncs the room setting: {mode, winnerCount, groupCount} — both counts
  // travel together so each mode's count stays consistent across peers. `group`
  // is the division reveal ({seed, keys, count}), the groups-mode analogue of `pick`.
  const mode = room.makeAction('mode')
  const group = room.makeAction('group')

  fingers.onMessage = (data, {peerId}) => onFingers(data, peerId)
  pick.onMessage = (data, {peerId}) => onPick(data, peerId)
  name.onMessage = (data, {peerId}) => onName(data, peerId)
  mode.onMessage = (data, {peerId}) => onMode?.(data, peerId)
  group.onMessage = (data, {peerId}) => onGroup?.(data, peerId)
  room.onPeerJoin = onPeerJoin
  room.onPeerLeave = onPeerLeave

  return {
    sendFingers: (data, target) => fingers.send(data, target ? {target} : {}),
    sendPick: (data) => pick.send(data),
    sendName: (data, target) => name.send(data, target ? {target} : {}),
    sendMode: (data, target) => mode.send(data, target ? {target} : {}),
    sendGroup: (data) => group.send(data),
    leave: () => room.leave(),
  }
}
