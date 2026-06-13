// Forced-relay end-to-end test: proves two peers connect PURELY through the TURN
// relay, with no direct path allowed (iceTransportPolicy:'relay' via the
// ?ice=relay seam in js/net.js). A direct connection can't mask a broken relay,
// so a green run here means the Cloudflare TURN fallback added for iPhone Safari
// (issue #2) actually relays traffic end to end.
//
// TURN credentials are minted by the Cloudflare Worker in turn-worker/ (the API
// token is a secret that can't ship in client JS), so this test needs a running
// Worker and real network egress to Cloudflare TURN. Point it at one with:
//
//   TURN_WORKER_URL=https://chooser-turn.<subdomain>.workers.dev npm run e2e:turn
//   # or against a local `wrangler dev`:
//   TURN_WORKER_URL=http://127.0.0.1:8787 npm run e2e:turn
//
// Without TURN_WORKER_URL the test SKIPS (locked-down CI has no TURN key and
// filters STUN/TURN egress anyway), so it validates the relay path only where a
// Worker + connectivity exist. Real iPhone Safari confirmation still needs a
// device or cloud lab (issue #2).
import {test, describe, before, after} from 'node:test'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium, webkit} from 'playwright'
import {startRelay} from './relay.mjs'
import {startServer} from './server.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOM = 'TURNROOM'
const WORKER = process.env.TURN_WORKER_URL

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
  page.waitForFunction(() => window.__relayCand, null, {timeout: 20000}).then(() => true, () => false)

const hasPeers = (page) => page.waitForFunction(
  () => document.querySelector('#peer-count')?.textContent.includes('2 device'),
  null, {timeout: 30000})

function turnSuite(engine, label) {
  describe(`${label} ↔ ${label} over TURN (forced relay)`, () => {
    let relay, server, browser, A, B

    before(async () => {
      if (!WORKER) return // nothing to launch when we're going to skip
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
      if (!WORKER) {
        t.skip('Set TURN_WORKER_URL to a deployed Worker or `wrangler dev` URL to ' +
          'validate the Cloudflare TURN relay path (see turn-worker/README.md). ' +
          'Real iPhone Safari confirmation still needs a device (issue #2).')
        return
      }
      // With a Worker configured we expect TURN to allocate. No relay candidate
      // here is a real failure (broken Worker/credentials, or blocked egress),
      // not a skip — that's the whole point of running with TURN_WORKER_URL.
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
