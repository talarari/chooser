// Nostr-layer diagnostics. The WebRTC diagnostics (diag.js) show what happens
// *after* two peers find each other; this shows whether they find each other at
// all. trystero discovers peers by publishing tiny "announce" events to the
// public Nostr relays and subscribing for the room's matching events — a layer
// that, until now, was a black box: a phone could hold ten open relay sockets
// and still exchange zero discovery traffic (the reproducible iPhone case),
// leaving only a healthy-looking socket counter and a pristine, unused offer
// pool. So we wrap the relay WebSockets and count what actually crosses them.
//
// The single load-bearing signal is `distinctPubkeys`: every peer signs its
// announce with its own Nostr key, and the relay echoes matching events back to
// every subscriber (your own included). So one device alone in a room sees 1
// pubkey (itself); a working two-device room sees >= 2. Stuck at 1 means the
// other phone's announce never arrives — discovery is starved, not WebRTC.
//
// Like diag.js, this must wrap the constructor before trystery opens any
// socket, so net.js imports it for the side effect ahead of joinRoom().

const sockets = new Set()
const sockInfo = new WeakMap()
const pubkeys = new Set() // distinct event author pubkeys seen across all relays
const kinds = new Set() // distinct Nostr event kinds seen (trystero uses one)
const rejections = [] // relay refusals: ["OK", id, false, msg] / NOTICE / CLOSED

let nextSockId = 1

// Only instrument relay sockets (wss://), not, say, any future fetch-upgrade.
function isRelayUrl(url) {
  return typeof url === 'string' && /^wss?:\/\//i.test(url)
}

function blankCounts() {
  return {EVENT: 0, REQ: 0, CLOSE: 0, OK: 0, NOTICE: 0, EOSE: 0, CLOSED: 0, AUTH: 0, other: 0}
}

function bump(counts, type) {
  if (type in counts) counts[type]++
  else counts.other++
}

// Parse one Nostr frame (a JSON array whose first element is the verb) and fold
// it into this socket's tallies. Best-effort: malformed frames just count as
// `other` rather than throwing inside a WebSocket handler.
function record(info, raw, dir) {
  const counts = dir === 'tx' ? info.sent : info.recv
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    counts.other++
    return
  }
  if (!Array.isArray(msg)) {
    counts.other++
    return
  }
  const [verb] = msg
  bump(counts, verb)
  if (verb === 'EVENT') {
    // tx: ["EVENT", event]; rx: ["EVENT", subId, event]
    const event = dir === 'tx' ? msg[1] : msg[2]
    if (event && typeof event === 'object') {
      if (typeof event.pubkey === 'string') {
        pubkeys.add(event.pubkey)
        info.pubkeys.add(event.pubkey)
      }
      if (Number.isFinite(event.kind)) kinds.add(event.kind)
    }
  } else if (verb === 'OK' && msg[2] === false) {
    pushReject(info.url, `OK false: ${msg[3] ?? ''}`)
  } else if (verb === 'NOTICE') {
    pushReject(info.url, `NOTICE: ${msg[1] ?? ''}`)
  } else if (verb === 'CLOSED') {
    pushReject(info.url, `CLOSED: ${msg[2] ?? ''}`)
  }
}

function pushReject(url, msg) {
  rejections.push({url, msg: String(msg).slice(0, 120)})
  if (rejections.length > 20) rejections.shift()
}

if (typeof window !== 'undefined' && window.WebSocket) {
  const Native = window.WebSocket
  function Tracked(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols)
    if (isRelayUrl(url)) {
      const info = {id: nextSockId++, url: String(url), sent: blankCounts(), recv: blankCounts(), pubkeys: new Set()}
      sockInfo.set(ws, info)
      sockets.add(ws)
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') record(info, e.data, 'rx')
      })
      const nativeSend = ws.send.bind(ws)
      ws.send = (data) => {
        if (typeof data === 'string') record(info, data, 'tx')
        return nativeSend(data)
      }
    }
    return ws
  }
  Tracked.prototype = Native.prototype
  Object.setPrototypeOf(Tracked, Native) // inherit CONNECTING/OPEN/... statics
  window.WebSocket = Tracked
}

// Compact per-relay line in the codebase's terse-diagnostic style, e.g.
// "tx 7E/2R · rx 31E/2OK · pk 2" — events/reqs out, events/oks in, distinct
// authors seen on this relay. A relay stuck at "pk 1" (or 0) with healthy tx is
// accepting our announce but never delivering the peer's.
function summarizeSocket(info) {
  const s = info.sent
  const r = info.recv
  return `tx ${s.EVENT}E/${s.REQ}R · rx ${r.EVENT}E/${r.OK}OK · pk ${info.pubkeys.size}`
}

export function nostrDiagnostics() {
  const perRelay = {}
  for (const ws of sockets) {
    const info = sockInfo.get(ws)
    if (info) perRelay[info.url] = summarizeSocket(info)
  }
  return {
    // The headline: distinct announce authors seen. 1 = alone (only our own
    // announce echoed back); >= 2 = the other device's announce is arriving.
    distinctPubkeys: pubkeys.size,
    kindsSeen: [...kinds],
    rejections,
    perRelay,
  }
}
