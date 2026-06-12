// Networking layer. Trystero handles WebRTC signaling over public Nostr
// relays, so the whole app runs without any server of our own. The bundle is
// vendored (see vendor/) so there is no runtime CDN dependency either.

import {joinRoom, selfId, getRelaySockets} from '../vendor/trystero-nostr.min.js'

export {selfId}

const APP_ID = 'finger-chooser-webrtc-v1'

// Pin well-established public relays instead of trystero's appId-derived
// default picks, which proved unreliable for peer discovery in practice.
const RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://relay.nostr.band',
]

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
