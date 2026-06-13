// Hermetic Chromium↔Chromium end-to-end test of the real WebRTC path.
//
// Two real browser pages, real RTCPeerConnection/data channels, connecting over
// loopback host candidates (no STUN/TURN) with signaling carried by a local
// Nostr relay (test/e2e/relay.mjs). This is the regression guard issue #1 asks
// for: it goes red whenever a change breaks peer connectivity — exactly the
// class of bug (TURN + trickle-ICE) the mocked unit tests sailed past.
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {startRelay} from './relay.mjs'
import {startServer} from './server.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOM = 'E2EROOM'

let relay, server, browser, A, B

// Drive a finger down/up by dispatching the same PointerEvents the app's real
// listeners handle (canvas pointerdown, window pointerup), positioned by
// fraction of the canvas so it is resolution-independent.
async function press(page, id, fx, fy) {
  await page.evaluate(({id, fx, fy}) => {
    const c = document.querySelector('#stage')
    c.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: id, clientX: fx * c.clientWidth, clientY: fy * c.clientHeight,
      bubbles: true, cancelable: true,
    }))
  }, {id, fx, fy})
}

const hasPeers = (page) => page.waitForFunction(
  () => document.querySelector('#peer-count')?.textContent.includes('2 device'),
  null, {timeout: 30000})

const bannerShown = (page) => page.waitForFunction(
  () => !document.querySelector('#banner').hidden, null, {timeout: 20000})

// True once the canvas has any non-transparent pixel — i.e. a finger is drawn.
const canvasHasInk = (page) => page.waitForFunction(() => {
  const c = document.querySelector('#stage')
  const {data} = c.getContext('2d').getImageData(0, 0, c.width, c.height)
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true
  return false
}, null, {timeout: 10000})

before(async () => {
  relay = await startRelay()
  server = await startServer(repo)
  browser = await chromium.launch()
  const url = `${server.url}/?relays=${encodeURIComponent(relay.url)}#${ROOM}`

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
