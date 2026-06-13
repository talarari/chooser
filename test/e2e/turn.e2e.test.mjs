// Forced-relay end-to-end test: proves two peers connect PURELY through the TURN
// relay, with no direct path allowed (iceTransportPolicy:'relay' via the
// ?ice=relay seam in js/net.js). A direct connection can't mask a broken relay,
// so a green run here means the Cloudflare TURN fallback added for iPhone Safari
// (issue #2) actually relays traffic end to end.
//
// This runs against the REAL production setup: short-lived credentials are
// minted by the Cloudflare Worker in turn-worker/ (the API token is a secret
// that can't ship in client JS) and traffic relays through Cloudflare TURN —
// the same path production uses. It defaults to the deployed Worker so it always
// runs (no skip); override with TURN_WORKER_URL to point at a `wrangler dev` or
// staging Worker:
//
//   TURN_WORKER_URL=http://127.0.0.1:8787 npm run e2e:turn
//
// It therefore needs real network egress to Cloudflare TURN; from a host that
// blocks STUN/TURN egress no relay candidate is gathered and it fails (by
// design — that's a real broken-relay signal, not a skip). Real iPhone Safari
// confirmation still needs a device or cloud lab (issue #2).
import {test, describe, before, after} from 'node:test'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium, webkit} from 'playwright'
import {startRelay} from './relay.mjs'
import {startServer} from './server.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOM = 'TURNROOM'
const WORKER = process.env.TURN_WORKER_URL || 'https://chooser-turn.talarari.workers.dev'

// Injected before app code: flip a window flag when a relay (TURN) candidate is
// gathered, so the test can tell "TURN works" apart from "no relay candidate"
// (broken Worker/credentials, or filtered egress).
const probe = () => {
  window.__relayCand = false
  const Orig = window.RTCPeerConnection
  window.RTCPeerConnection = function (...args) {
    const pc = new Orig(...args)
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate && / typ relay/.test(e.candidate.candidate)) window.__relayCand = true
    })
    return pc
  }
  window.RTCPeerConnection.prototype = Orig.prototype
}

const gotRelayCandidate = (page) =>
  page.waitForFunction(() => window.__relayCand, null, {timeout: 40000}).then(() => true, () => false)

// 60s: the forced-relay path over real Cloudflare TURN can take ~30s to open —
// with trickle off each peer waits for ICE gathering to complete across all of
// Cloudflare's TURN transports before sending its offer.
const hasPeers = (page) => page.waitForFunction(
  () => document.querySelector('#peer-count')?.textContent.includes('2 device'),
  null, {timeout: 60000})

function turnSuite(engine, label) {
  describe(`${label} ↔ ${label} over TURN (forced relay)`, () => {
    let relay, server, browser, A, B

    before(async () => {
      relay = await startRelay()
      server = await startServer(repo)
      browser = await engine.launch()
      // Local relay for signaling; turn=<Worker> supplies Cloudflare TURN creds;
      // ice=relay forces the media/data path onto TURN so a direct path can't
      // mask a broken relay.
      const url = `${server.url}/?relays=${encodeURIComponent(relay.url)}` +
        `&turn=${encodeURIComponent(WORKER)}&ice=relay#${ROOM}`
      const open = async (name) => {
        const ctx = await browser.newContext()
        const page = await ctx.newPage()
        await page.addInitScript(probe)
        await page.addInitScript((n) => localStorage.setItem('chooser:name', n), name)
        await page.goto(url)
        return page
      }
      A = await open('Relay A')
      B = await open('Relay B')
    })

    after(async () => {
      await browser?.close()
      await server?.close()
      await relay?.close()
    })

    test('two peers connect using only TURN relay candidates', async (t) => {
      // TURN must allocate against the real Worker + Cloudflare TURN. No relay
      // candidate is a real failure (broken Worker/credentials, or blocked
      // egress), never a skip — exercising the production relay path is the point.
      const [ra, rb] = await Promise.all([gotRelayCandidate(A), gotRelayCandidate(B)])
      t.assert.ok(ra && rb,
        'no relay candidate gathered — the Worker did not return working TURN ' +
        'credentials, or STUN/TURN egress is blocked from here')
      // The relay-only path must now carry the connection all the way to "2 devices".
      await Promise.all([hasPeers(A), hasPeers(B)])
    })
  })
}

turnSuite(chromium, 'Chromium')
turnSuite(webkit, 'WebKit')
