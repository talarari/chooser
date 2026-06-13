// Forced-relay end-to-end test: proves two peers connect PURELY through the TURN
// relay, with no direct path allowed (iceTransportPolicy:'relay' via the
// ?ice=relay seam in js/net.js). A direct connection can't mask a broken relay,
// so a green run here means the Open Relay TURN fallback added for iPhone Safari
// (issue #2) actually relays traffic end to end.
//
// Unlike the hermetic connect suite, this needs real network egress to the TURN
// server. Locked-down CI sandboxes commonly allowlist egress (DNS + HTTPS to
// approved hosts) and filter STUN/TURN flows, so they can't reach any TURN relay
// (this repo's CI included), and the free public Open Relay is itself
// best-effort. So the test PROBES whether a relay candidate can be gathered and
// SKIPS — rather than fails — when TURN is unreachable. It therefore validates
// the relay path wherever connectivity exists (a dev machine, a permissive CI),
// and stays quiet where it can't. Real iPhone Safari confirmation still needs a
// device or cloud lab (issue #2).
import {test, describe, before, after} from 'node:test'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium, webkit} from 'playwright'
import {startRelay} from './relay.mjs'
import {startServer} from './server.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOM = 'TURNROOM'

// Injected before app code: flip window flags when a relay (TURN) candidate is
// gathered and when the peer connection actually opens, so the test can tell
// "TURN unreachable" (no relay candidate) apart from "TURN works but won't
// connect" (relay candidate, never connected).
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
      relay = await startRelay()
      server = await startServer(repo)
      browser = await engine.launch()
      // Local relay for signaling; ice=relay forces the media/data path onto TURN.
      const url = `${server.url}/?relays=${encodeURIComponent(relay.url)}&ice=relay#${ROOM}`
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
      const [ra, rb] = await Promise.all([gotRelayCandidate(A), gotRelayCandidate(B)])
      if (!ra || !rb) {
        t.skip('TURN unreachable from this environment (no relay candidate gathered — ' +
          'STUN/TURN egress is filtered here, or the free relay is down). The relay path ' +
          'can only be validated where TURN egress exists; confirm iPhone Safari on a real device (issue #2).')
        return
      }
      // A relay candidate means the TURN allocation succeeded, so the relay-only
      // path must now carry the connection all the way to "2 devices".
      await Promise.all([hasPeers(A), hasPeers(B)])
    })
  })
}

turnSuite(chromium, 'Chromium')
turnSuite(webkit, 'WebKit')
