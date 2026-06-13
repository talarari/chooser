// On-screen WebRTC diagnostics (issue #2). Phones have no devtools, and the
// iPhone Safari failure is a *silent* one — the room joins, no JS error fires,
// the relay counter looks healthy, but the peer connection never forms. So we
// surface the live connection/ICE state and the candidate types each connection
// gathers, right in the HUD, to turn "it just doesn't connect" into a precise
// readout ("ice: failed", "no relay candidate gathered", ...).
//
// trystero owns the RTCPeerConnections, so our only hook is to wrap the
// RTCPeerConnection constructor. This module must run before any connection is
// created — net.js imports it for that side effect, ahead of joinRoom().

const pcs = new Set()
const pcInfo = new WeakMap()
const candidateTypes = new Set()

let nextPcId = 1

function addressKind(address) {
  return address
    ? address.endsWith('.local') ? 'mdns'
      : address.includes(':') ? 'ipv6'
        : 'ipv4'
    : null
}

function parseCandidate(candidate) {
  const text = candidate?.candidate ?? ''
  const type = /(?:^| )typ (\w+)/.exec(text)?.[1] ?? 'unknown'
  const protocol = /(?:^| )(udp|tcp)(?: |$)/i.exec(text)?.[1]?.toLowerCase() ?? null
  const address = /(?:^| )candidate:\S+ \d+ \S+ \d+ ([^ ]+) \d+/.exec(text)?.[1] ?? null
  const url = candidate?.url ?? null
  return {
    type,
    protocol,
    addressKind: addressKind(address),
    url,
  }
}

function summarizeIceServers(args) {
  const [{iceServers = [], iceTransportPolicy = 'all'} = {}] = args
  return {
    iceTransportPolicy,
    iceServers: iceServers.map(({urls, username, credential}) => ({
      urls: [].concat(urls ?? []),
      hasUsername: Boolean(username),
      hasCredential: Boolean(credential),
    })),
  }
}

if (typeof window !== 'undefined' && window.RTCPeerConnection) {
  const Native = window.RTCPeerConnection
  function Tracked(...args) {
    const pc = new Native(...args)
    const info = {
      id: nextPcId++,
      createdAt: new Date().toISOString(),
      config: summarizeIceServers(args),
      localCandidates: [],
      iceCandidateErrors: [],
      stateLog: [],
    }
    pcInfo.set(pc, info)
    pcs.add(pc)
    const logState = (event) => {
      info.stateLog.push({
        event,
        atMs: Math.round(performance.now()),
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
      })
      if (info.stateLog.length > 20) info.stateLog.shift()
    }
    logState('created')
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return
      const parsed = parseCandidate(e.candidate)
      candidateTypes.add(parsed.type)
      info.localCandidates.push(parsed)
      if (info.localCandidates.length > 50) info.localCandidates.shift()
    })
    pc.addEventListener('icecandidateerror', (e) => {
      info.iceCandidateErrors.push({
        atMs: Math.round(performance.now()),
        url: e.url ?? null,
        addressKind: addressKind(e.address),
        port: e.port ?? null,
        errorCode: e.errorCode ?? null,
        errorText: e.errorText ?? null,
      })
      if (info.iceCandidateErrors.length > 20) info.iceCandidateErrors.shift()
    })
    for (const event of ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange']) {
      pc.addEventListener(event, () => logState(event))
    }
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed') pcs.delete(pc)
    })
    return pc
  }
  // Inherit instances + statics (e.g. generateCertificate) from the native ctor.
  Tracked.prototype = Native.prototype
  Object.setPrototypeOf(Tracked, Native)
  window.RTCPeerConnection = Tracked
  if (window.webkitRTCPeerConnection === Native) window.webkitRTCPeerConnection = Tracked
}

// Collapse the live connections' states into compact, distinct readouts. With
// two devices there's a single connection; with more, distinct values are
// joined so one failing peer is still visible (e.g. "connected,failed").
function distinct(getter) {
  const vals = new Set()
  for (const pc of pcs) vals.add(getter(pc))
  return [...vals].join(',') || '–'
}

// Lightweight: just the aggregate states + candidate types for the on-screen
// HUD, which polls this every animation frame. The heavy per-connection detail
// lives in diagDetails() (the Debug button), built only on demand.
export function diagSnapshot() {
  return {
    connection: distinct((pc) => pc.connectionState),
    ice: distinct((pc) => pc.iceConnectionState),
    gathering: distinct((pc) => pc.iceGatheringState),
    candidates: [...candidateTypes],
  }
}

// Collapse a pc's gathered candidates into counts keyed by type/proto/family,
// e.g. {"relay/udp/ipv4": 8, "srflx/udp/ipv6": 3, "host/udp/mdns": 2} — the same
// signal as the raw list (often 20-50 near-duplicate entries) in one line.
function summarizeCandidates(list) {
  const counts = {}
  for (const c of list) {
    const key = [c.type, c.protocol, c.addressKind].filter(Boolean).join('/')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

// A single time-ordered event log MERGED across every connection — the raw
// chronology that grouping by state alone would lose. Each line is tagged with
// the pc id, so an individual connection's history is recoverable (filter by
// `pc<id>`) and cross-connection interleaving (glare, an answer landing on the
// wrong pc, who offered first) stays visible. One terse line per transition:
// "254ms pc7 signaling new/new/gathering/have-local-offer".
function mergedEventLog(pcSet) {
  const events = []
  for (const pc of pcSet) {
    const info = pcInfo.get(pc) ?? {}
    for (const s of info.stateLog ?? []) events.push({...s, id: info.id})
  }
  events.sort((a, b) => a.atMs - b.atMs)
  return events.map((s) =>
    `${s.atMs}ms pc${s.id} ${s.event.replace('statechange', '')} ` +
    `${s.connection}/${s.ice}/${s.gathering}/${s.signaling}`)
}

// ICE candidate errors deduped to counts, e.g.
// {"701 stun:stun1.l.google.com:19302 ipv6": 4}. Without this a flaky network
// logs the same 701 dozens of times.
function summarizeErrors(list) {
  const counts = {}
  for (const e of list) {
    const key = [e.errorCode, e.url, e.addressKind].filter((v) => v != null).join(' ')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

// State signature used to group connections — peers in the same place in the
// handshake collapse into one entry. "offer→·" means an offer was sent but no
// answer came back; "offer→answer" means the handshake completed.
function signatureOf(pc) {
  return `${pc.connectionState}/${pc.iceConnectionState}/${pc.iceGatheringState}/${pc.signalingState}` +
    ` ${pc.localDescription?.type ?? '·'}→${pc.remoteDescription?.type ?? '·'}`
}

// Prefer the most-progressed connection as a group's representative, so a lone
// "connected" pc isn't hidden behind a crowd of stuck ones.
const PROGRESS = {closed: 0, failed: 1, new: 2, connecting: 3, checking: 3, completed: 4, connected: 5}
const rank = (pc) => (PROGRESS[pc.connectionState] ?? 2) + (PROGRESS[pc.iceConnectionState] ?? 2)

async function detailOf(pc) {
  const info = pcInfo.get(pc) ?? {}
  const entry = {
    ageMs: info.createdAt ? Date.now() - Date.parse(info.createdAt) : null,
    candidates: summarizeCandidates(info.localCandidates ?? []),
    candidateErrors: summarizeErrors(info.iceCandidateErrors ?? []),
  }
  if (!pc.getStats) return entry
  try {
    const stats = await pc.getStats()
    const candidates = {}
    for (const r of stats.values()) {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
        candidates[r.id] = {candidateType: r.candidateType, protocol: r.protocol, relayProtocol: r.relayProtocol}
      }
    }
    const pairStates = {}
    let selectedPair = null
    for (const r of stats.values()) {
      if (r.type !== 'candidate-pair') continue
      pairStates[r.state] = (pairStates[r.state] ?? 0) + 1
      if (r.selected || r.nominated) selectedPair = summarizePair(r, candidates)
    }
    entry.selectedPair = selectedPair
    entry.pairStates = pairStates
  } catch (error) {
    entry.statsError = error?.message ?? String(error)
  }
  return entry
}

// The connecting candidate pair, reduced to type/proto per side + the numbers
// that matter (address/port were redacted anyway, so they're dropped).
function summarizePair(pair, candidates) {
  const side = (id) => {
    const c = candidates[id]
    return c ? [c.candidateType, c.protocol, c.relayProtocol].filter(Boolean).join('/') : null
  }
  return {
    state: pair.state,
    nominated: pair.nominated || undefined,
    local: side(pair.localCandidateId),
    remote: side(pair.remoteCandidateId),
    rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
    bytesSent: pair.bytesSent || undefined,
    bytesReceived: pair.bytesReceived || undefined,
  }
}

export async function diagDetails() {
  // Group connections by state signature for the at-a-glance summary — trystero
  // can spin up (and abandon) many pcs, and 20 identical "offer sent, no answer"
  // connections are one insight with a count, not 20 near-identical dumps. Full
  // detail (incl. getStats) is built once per group from the most-progressed pc.
  // The raw cross-connection chronology is NOT lost: it's in `events` below.
  let config // identical across connections — reported once, not per pc
  const groups = new Map() // signature -> {count, ids, pc}
  for (const pc of pcs) {
    const info = pcInfo.get(pc) ?? {}
    config ??= info.config
    const sig = signatureOf(pc)
    const g = groups.get(sig)
    if (g) {
      g.count++
      g.ids.push(info.id)
      if (rank(pc) > rank(g.pc)) g.pc = pc
    } else {
      groups.set(sig, {count: 1, ids: [info.id], pc})
    }
  }
  const peerConnections = await Promise.all([...groups].map(async ([signature, {count, ids, pc}]) => ({
    signature,
    count,
    ids,
    ...await detailOf(pc),
  })))
  return {
    ...diagSnapshot(),
    config,
    peerConnectionCount: pcs.size,
    peerConnections,
    events: mergedEventLog(pcs),
  }
}
