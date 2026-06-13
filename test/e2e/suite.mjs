// Shared end-to-end suite, parametrised by Playwright browser engine.
//
// The same hermetic harness — two real browser pages, real
// RTCPeerConnection/data channels over loopback host candidates, signaling
// carried by a local Nostr relay (test/e2e/relay.mjs) — runs against whichever
// engine is passed in. connect.chromium.e2e.test.mjs drives Chromium; the
// WebKit variant (connect.webkit.e2e.test.mjs) drives Playwright's WebKit, the
// closest stand-in for iPhone Safari available on Linux/CI.
//
// Caveat (see issue #2): WebKit-on-Linux is NOT Safari, and its WebRTC stack
// differs from real iOS Safari, so a green WebKit run is reassurance, not
// proof. Real validation still needs an actual iPhone or a cloud device lab.
import {test, before, after, describe} from 'node:test'
import assert from 'node:assert/strict'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {startRelay} from './relay.mjs'
import {startServer} from './server.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The real Cloudflare TURN Worker (turn-worker/), same one production uses. The
// relay suites mint short-lived credentials from it and connect over Cloudflare
// TURN, so e2e exercises the real production relay path — not a local stand-in.
// localhost is always an allowed origin on the Worker, so CI mints fine.
// Override with TURN_WORKER_URL to point at a `wrangler dev` or staging Worker.
const TURN_WORKER_URL = process.env.TURN_WORKER_URL || 'https://chooser-turn.talarari.workers.dev'

// Drive a finger down by dispatching the same PointerEvent the app's real
// listeners handle (canvas pointerdown), positioned by fraction of the canvas
// so it is resolution-independent.
async function press(page, id, fx, fy) {
  await page.evaluate(({id, fx, fy}) => {
    const c = document.querySelector('#stage')
    c.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: id, clientX: fx * c.clientWidth, clientY: fy * c.clientHeight,
      bubbles: true, cancelable: true,
    }))
  }, {id, fx, fy})
}

// 60s, not 30s: the forced-relay path (WebKit over Cloudflare TURN) can take
// ~30s to open — with trickle off each peer waits for ICE gathering to complete
// across all of Cloudflare's TURN transports before it even sends its offer.
// Direct (Chromium) still resolves in a second or two, well under this ceiling.
const hasPeers = (page) => page.waitForFunction(
  () => document.querySelector('#peer-count')?.textContent.includes('2 device'),
  null, {timeout: 60000})

const bannerShown = (page) => page.waitForFunction(
  () => !document.querySelector('#banner').hidden, null, {timeout: 20000})

// True once the canvas has any non-transparent pixel — i.e. a finger is drawn.
const canvasHasInk = (page) => page.waitForFunction(() => {
  const c = document.querySelector('#stage')
  const {data} = c.getContext('2d').getImageData(0, 0, c.width, c.height)
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true
  return false
}, null, {timeout: 10000})

// Register the full connectivity suite for one Playwright engine.
//
// turnRelay: route the media/data path through the real Cloudflare TURN Worker
// and force `iceTransportPolicy:'relay'` (production's cross-network path). This
// is how the WebKit (Safari-engine) suite connects — WebKit gathers only
// unresolvable mDNS host candidates over loopback, so a relay candidate is the
// only one that works, exactly as on real iPhone Safari (issue #2). Default
// (Chromium) stays direct: it connects over loopback host candidates with no
// TURN, guarding production's same-network direct path.
export function connectSuite(browserType, label, {turnRelay = false} = {}) {
  describe(`${label} ↔ ${label} WebRTC${turnRelay ? ' (relay)' : ''}`, () => {
    const ROOM = 'E2EROOM'
    let relay, server, browser, A, B

    before(async () => {
      relay = await startRelay()
      server = await startServer(repo)
      browser = await browserType.launch()
      // turnRelay: app fetches short-lived creds from the real Worker via the
      // ?turn= seam and ice=relay forces the connection onto Cloudflare TURN (so
      // loopback host candidates can't mask the relay). Otherwise ?turn= (empty)
      // disables TURN entirely and peers connect directly over loopback host
      // candidates. Signaling always runs through the local Nostr relay so the
      // test stays deterministic; only the WebRTC media/data path is production.
      const turnParams = turnRelay
        ? `&turn=${encodeURIComponent(TURN_WORKER_URL)}&ice=relay`
        : '&turn='
      const url = `${server.url}/?relays=${encodeURIComponent(relay.url)}${turnParams}#${ROOM}`

      const open = async (name) => {
        const ctx = await browser.newContext()
        const page = await ctx.newPage()
        await page.addInitScript((n) => localStorage.setItem('chooser:name', n), name)
        await page.goto(url)
        return page
      }
      // Distinct names exercise the rename/identity broadcast across the wire.
      A = await open('Alice Apple')
      B = await open('Bob Banana')
    })

    after(async () => {
      await browser?.close()
      await server?.close()
      await relay?.close()
    })

    test('two peers reach "2 devices" (the connectivity regression guard)', async () => {
      await Promise.all([hasPeers(A), hasPeers(B)])
    })

    test('a finger on A renders as a remote finger on B', async () => {
      // B has no local fingers, so any ink on B's canvas is the remote finger.
      await press(A, 1, 0.3, 0.3)
      await canvasHasInk(B)
    })

    test('holding two fingers picks one winner both pages agree on', async () => {
      await press(A, 1, 0.3, 0.3)
      await press(B, 1, 0.7, 0.7)

      await Promise.all([bannerShown(A), bannerShown(B)])
      const [ba, bb] = await Promise.all([A.textContent('#banner'), B.textContent('#banner')])

      // Exactly one device sees itself chosen; the other names that same peer —
      // proving both computed the identical winner from the synced seed, and that
      // the winner's chosen name propagated over the data channel.
      const winners = [ba, bb].filter((t) => t.includes('You were chosen'))
      assert.equal(winners.length, 1, `expected one winner, got banners: "${ba}" | "${bb}"`)

      const [winPage, loserBanner] = ba.includes('You were chosen') ? [A, bb] : [B, ba]
      const winName = (await winPage.textContent('#name-pill')).trim()
      assert.equal(loserBanner.trim(), `${winName} was chosen`)
    })
  })
}
