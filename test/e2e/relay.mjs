// A tiny, self-contained Nostr relay implementing just enough of NIP-01 to
// carry trystero's WebRTC signaling between two local browser pages. No public
// network, no external relays — the whole Chromium e2e runs offline.
//
// trystero's nostr strategy (see vendor/trystero-nostr.min.js):
//   subscribe: ["REQ", subId, {kinds:[K], since: <unix-s>, "#x":[topic]}]
//   publish:   ["EVENT", {kind:K, tags:[["x", topic]], created_at, content, ...}]
// so the relay must honour `kinds`, `since` and arbitrary `#<tag>` filters and
// live-forward matching EVENTs to every open subscription.
import {WebSocketServer} from 'ws'

function filterMatch(f, ev) {
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.since != null && ev.created_at < f.since) return false
  if (f.until != null && ev.created_at > f.until) return false
  for (const key of Object.keys(f)) {
    if (key[0] !== '#') continue
    const tag = key.slice(1)
    const wanted = f[key]
    if (!ev.tags?.some((t) => t[0] === tag && wanted.includes(t[1]))) return false
  }
  return true
}

const matches = (filters, ev) => filters.some((f) => filterMatch(f, ev))

export function startRelay(port = 0) {
  const wss = new WebSocketServer({port})
  const subs = new Map() // ws -> Map<subId, filters[]>
  const recent = [] // bounded log so a late REQ can still catch a fresh event

  wss.on('connection', (ws) => {
    subs.set(ws, new Map())
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      const [type, ...rest] = msg
      if (type === 'REQ') {
        const [subId, ...filters] = rest
        subs.get(ws).set(subId, filters)
        for (const ev of recent) {
          if (matches(filters, ev)) ws.send(JSON.stringify(['EVENT', subId, ev]))
        }
        ws.send(JSON.stringify(['EOSE', subId]))
      } else if (type === 'EVENT') {
        const ev = rest[0]
        recent.push(ev)
        if (recent.length > 500) recent.shift()
        ws.send(JSON.stringify(['OK', ev.id, true, '']))
        for (const [peer, peerSubs] of subs) {
          if (peer.readyState !== 1) continue
          for (const [subId, filters] of peerSubs) {
            if (matches(filters, ev)) peer.send(JSON.stringify(['EVENT', subId, ev]))
          }
        }
      } else if (type === 'CLOSE') {
        subs.get(ws)?.delete(rest[0])
      }
    })
    ws.on('close', () => subs.delete(ws))
  })

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const {port: boundPort} = wss.address()
      resolve({
        port: boundPort,
        url: `ws://localhost:${boundPort}`,
        close: () => new Promise((r) => wss.close(r)),
      })
    })
  })
}
