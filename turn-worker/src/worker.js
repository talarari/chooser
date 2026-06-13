// Cloudflare Realtime TURN credential minter.
//
// The app is a static GitHub Pages site with no server of its own, but it needs
// a TURN relay to connect peers that can't reach each other directly — most
// painfully iPhone Safari on a LAN, which gathers only mDNS `.local` host
// candidates it won't resolve for the peer, so no direct connection ever forms
// (issue #2). The retired free public TURN services (e.g. Open Relay's universal
// `openrelayproject` credentials) no longer allocate, so we use Cloudflare TURN.
//
// Cloudflare issues SHORT-LIVED credentials minted from a TURN key whose API
// token is a SECRET that must never ship in client JS. This Worker is the one
// piece of server we keep: it holds the token and exposes only a minting
// endpoint. The client fetches fresh ICE servers from here at join time
// (js/net.js → fetchTurnServers), and the token never leaves Cloudflare.
//
// Deploy + config: see README.md in this directory. Required:
//   TURN_KEY_ID         (var)    — the Cloudflare TURN key's ID
//   TURN_KEY_API_TOKEN  (secret) — the TURN key's API token
//   ALLOWED_ORIGINS     (var)    — comma-separated origins allowed to mint
//                                  (localhost/127.0.0.1 are always allowed, for
//                                  local dev and the forced-relay e2e)

const CF_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'

// Only hand credentials to origins we trust, so a scraped Worker URL can't be
// used to burn the TURN quota from arbitrary sites. localhost is always allowed
// so `wrangler dev` + the e2e (which serve from 127.0.0.1) work without config.
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin')
  if (!origin) return null
  let host
  try { host = new URL(origin).hostname } catch { return null }
  if (host === 'localhost' || host === '127.0.0.1') return origin
  const allow = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  return allow.includes(origin) ? origin : null
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env)

    if (request.method === 'OPTIONS') {
      return new Response(null, {status: origin ? 204 : 403, headers: origin ? corsHeaders(origin) : {}})
    }
    if (!origin) return new Response('origin not allowed', {status: 403})
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('method not allowed', {status: 405, headers: corsHeaders(origin)})
    }
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      return new Response('TURN key not configured (set TURN_KEY_ID + TURN_KEY_API_TOKEN)', {
        status: 500,
        headers: corsHeaders(origin),
      })
    }

    const ttl = Number(env.TTL) || 86400
    const minted = await fetch(`${CF_API}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({ttl}),
    })
    if (!minted.ok) {
      return new Response(`TURN mint failed: ${minted.status} ${await minted.text()}`, {
        status: 502,
        headers: corsHeaders(origin),
      })
    }
    // Pass Cloudflare's {"iceServers": {...}} through verbatim. Never cache —
    // these credentials expire, and every joiner needs a fresh allocation.
    return new Response(await minted.text(), {
      status: 200,
      headers: {...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
    })
  },
}
