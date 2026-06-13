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
const candidateTypes = new Set()

if (typeof window !== 'undefined' && window.RTCPeerConnection) {
  const Native = window.RTCPeerConnection
  function Tracked(...args) {
    const pc = new Native(...args)
    pcs.add(pc)
    pc.addEventListener('icecandidate', (e) => {
      const m = e.candidate && /(?:^| )typ (\w+)/.exec(e.candidate.candidate)
      if (m) candidateTypes.add(m[1])
    })
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
  }
}
