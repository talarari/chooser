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

export function diagSnapshot() {
  return {
    connection: distinct((pc) => pc.connectionState),
    ice: distinct((pc) => pc.iceConnectionState),
    gathering: distinct((pc) => pc.iceGatheringState),
    candidates: [...candidateTypes],
    peerConnections: [...pcs].map((pc) => {
      const info = pcInfo.get(pc)
      return {
        id: info?.id,
        createdAt: info?.createdAt,
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
        localDescription: pc.localDescription?.type ?? null,
        remoteDescription: pc.remoteDescription?.type ?? null,
        config: info?.config,
        localCandidates: info?.localCandidates ?? [],
        iceCandidateErrors: info?.iceCandidateErrors ?? [],
        stateLog: info?.stateLog ?? [],
      }
    }),
  }
}

export async function diagDetails() {
  const base = diagSnapshot()
  const peerConnections = await Promise.all(base.peerConnections.map(async (entry) => {
    const pc = [...pcs].find((candidate) => pcInfo.get(candidate)?.id === entry.id)
    if (!pc?.getStats) return entry
    try {
      const stats = await pc.getStats()
      const selectedPairs = []
      const candidatePairs = []
      const candidates = {}
      for (const report of stats.values()) {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates[report.id] = {
            type: report.type,
            candidateType: report.candidateType,
            protocol: report.protocol,
            address: report.address ? '[redacted]' : undefined,
            port: report.port ? '[redacted]' : undefined,
            relayProtocol: report.relayProtocol,
            url: report.url,
          }
        }
      }
      for (const report of stats.values()) {
        if (report.type !== 'candidate-pair') continue
        const pair = {
          state: report.state,
          nominated: report.nominated,
          selected: report.selected,
          currentRoundTripTime: report.currentRoundTripTime,
          availableOutgoingBitrate: report.availableOutgoingBitrate,
          bytesSent: report.bytesSent,
          bytesReceived: report.bytesReceived,
          local: candidates[report.localCandidateId],
          remote: candidates[report.remoteCandidateId],
        }
        candidatePairs.push(pair)
        if (report.selected || report.nominated) selectedPairs.push(pair)
      }
      return {...entry, selectedPairs, candidatePairs: candidatePairs.slice(0, 10)}
    } catch (error) {
      return {...entry, statsError: error?.message ?? String(error)}
    }
  }))
  return {...base, peerConnections}
}
