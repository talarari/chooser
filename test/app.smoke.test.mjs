// End-to-end smoke test of the app logic: stubs the DOM and mocks trystero at
// the vendor-module layer (so the real net.js runs against the real trystero
// v0.25 API shape), then drives a full round — three fingers held stable
// across two devices -> host pick -> reveal -> reset.
import {test, before} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, cp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, dirname} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {pickWinner} from '../js/chooser.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// Mirrors trystero 0.25: makeAction returns {send, onMessage}, peer events are
// assigned properties. If trystero's API shape changes again, update this mock
// alongside net.js.
const VENDOR_MOCK = `
export const selfId = 'selfPeer0001'
export const getRelaySockets = () => ({})
export const defaultRelayUrls = ['wss://d1', 'wss://d2', 'wss://d3', 'wss://d4', 'wss://d5', 'wss://d6']
export function joinRoom(config, roomId) {
  globalThis.__joins = (globalThis.__joins ?? 0) + 1
  const actions = {}
  const room = {
    makeAction: (name) => (actions[name] = {
      onMessage: null,
      send: async (data, opts = {}) => globalThis.__sent.push([name, data, opts.target]),
    }),
    onPeerJoin: null,
    onPeerLeave: null,
    leave: () => {},
  }
  globalThis.__mock = {room, actions, config, roomId}
  return room
}
`

const listeners = {}
const el = (id) => ({
  id, hidden: false, textContent: '', value: '', style: {},
  addEventListener(type, fn) { (listeners[id + ':' + type] ||= []).push(fn) },
})

let vnow = 0
let rafQueue = []

// connect() is async (it awaits a TURN-credential fetch before joinRoom), so a
// join completes a few microtasks after it's triggered. A real-timer tick
// flushes that chain. setInterval is stubbed out below, but setTimeout is real.
const flush = () => new Promise((r) => setTimeout(r, 0))

function step(ms, frames = 1) {
  for (let i = 0; i < frames; i++) {
    vnow += ms / frames
    const q = rafQueue
    rafQueue = []
    for (const fn of q) fn(vnow)
  }
}

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chooser-smoke-'))
  await cp(join(repo, 'js'), join(dir, 'js'), {recursive: true})
  await mkdir(join(dir, 'vendor'))
  await writeFile(join(dir, 'vendor', 'trystero-nostr.min.js'), VENDOR_MOCK)

  const els = {}
  globalThis.__ctxCalls = []
  const canvas = {
    ...el('stage'),
    clientWidth: 800, clientHeight: 600, width: 0, height: 0,
    getContext: () => new Proxy({}, {
      get(target, prop) {
        if (prop in target) return target[prop]
        return (...args) => globalThis.__ctxCalls.push([String(prop), ...args])
      },
    }),
  }
  els['#stage'] = canvas
  globalThis.__sent = []
  globalThis.document = {
    querySelector: (s) => (els[s] ??= el(s.slice(1))),
    addEventListener: (t, fn) => { (listeners['document:' + t] ||= []).push(fn) },
    visibilityState: 'visible',
    hasFocus: () => true,
  }
  globalThis.window = {
    addEventListener: (t, fn) => { (listeners['window:' + t] ||= []).push(fn) },
    devicePixelRatio: 2,
    innerWidth: 800,
    innerHeight: 600,
    isSecureContext: true,
  }
  globalThis.screen = {width: 800, height: 600}
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'node-smoke-test',
      platform: 'test',
      language: 'en-US',
      onLine: true,
      clipboard: {
        lastText: '',
        writeText: async (text) => { globalThis.navigator.clipboard.lastText = text },
      },
    },
  })
  globalThis.location = {hash: '#TEST', origin: 'http://x', pathname: '/', search: ''}
  // net.js fetches TURN credentials from the Worker at join time; keep this
  // test hermetic (and offline) by failing that fetch — connect() falls back to
  // STUN-only, exactly as when no Worker is configured.
  globalThis.fetch = async () => { throw new Error('no network in smoke test') }
  globalThis.requestAnimationFrame = (fn) => rafQueue.push(fn)
  // main.js starts a heartbeat interval; keep it from holding the process open
  globalThis.setInterval = () => 0
  globalThis.localStorage = {getItem: () => null, setItem: () => {}}
  Object.defineProperty(globalThis.performance, 'now', {value: () => vnow})

  await import(pathToFileURL(join(dir, 'js', 'main.js')))
  await flush() // let the hash-driven join finish (async TURN fetch -> joinRoom)
})

test('joining from the URL hash wires up the room', () => {
  assert.ok(globalThis.__mock, 'joinRoom should have been called')
  assert.equal(globalThis.__mock.roomId, 'TEST')
  assert.ok(globalThis.__mock.config.relayConfig.urls.length >= 4,
    'pinned relay list should be passed to trystero')
  const urls = globalThis.__mock.config.relayConfig.urls
  assert.equal(new Set(urls).size, urls.length, 'relay list should have no duplicates')
  assert.equal(urls.filter((u) => u.startsWith('wss://d')).length, 2,
    'two fallback relays should be drawn from the default pool')
  assert.equal(typeof globalThis.__mock.actions.fingers.onMessage, 'function')
  assert.equal(typeof globalThis.__mock.actions.pick.onMessage, 'function')
  assert.equal(typeof globalThis.__mock.actions.name.onMessage, 'function')
  assert.equal(typeof globalThis.__mock.room.onPeerJoin, 'function')
  assert.equal(typeof globalThis.__mock.room.onPeerLeave, 'function')
  assert.equal(globalThis.document.querySelector('#room-code').textContent, 'TEST')
})

test('a full round: stable fingers -> host pick -> reveal -> reset', () => {
  const {room, actions} = globalThis.__mock
  const sent = globalThis.__sent

  // two local fingers go down
  const down = listeners['stage:pointerdown'][0]
  down({pointerId: 1, clientX: 100, clientY: 100, preventDefault: () => {}})
  down({pointerId: 2, clientX: 500, clientY: 400, preventDefault: () => {}})
  assert.ok(sent.some(([name]) => name === 'fingers'), 'finger state should be broadcast')

  // a remote peer joins and reports one finger (re-sent as heartbeat)
  room.onPeerJoin('zzzRemotePeer')
  assert.ok(sent.some(([name, , target]) => name === 'fingers' && target === 'zzzRemotePeer'),
    'newcomer should be brought up to date with a targeted send')

  // hold stable past HOLD_MS; selfPeer0001 < zzzRemotePeer so we are host
  step(100, 5)
  for (let i = 0; i < 4; i++) {
    actions.fingers.onMessage({7: [0.5, 0.5]}, {peerId: 'zzzRemotePeer'})
    step(1000, 10)
  }

  const pickMsg = sent.find(([name]) => name === 'pick')
  assert.ok(pickMsg, 'host should broadcast a pick after the hold')
  assert.equal(pickMsg[1].keys.length, 3, 'pick should cover all three fingers')
  const banner = globalThis.document.querySelector('#banner')
  assert.ok(!banner.hidden, 'banner should show the winner')

  // lift all fingers and let the reveal expire
  const up = listeners['window:pointerup'][0]
  up({pointerId: 1})
  up({pointerId: 2})
  actions.fingers.onMessage({}, {peerId: 'zzzRemotePeer'})
  step(9000, 20)
  assert.ok(banner.hidden, 'round should reset after the reveal')
})

test('renaming yourself broadcasts, remote names appear in the banner', () => {
  const {actions} = globalThis.__mock
  const sent = globalThis.__sent

  // both name chips show the generated name before any rename
  assert.match(globalThis.document.querySelector('#name-landing').textContent, /^\w+ \w+$/)
  assert.equal(globalThis.document.querySelector('#name-landing').textContent,
    globalThis.document.querySelector('#name-pill').textContent)

  // rename via the landing chip; both chips update
  globalThis.prompt = () => '  Cool   Cucumber  '
  listeners['name-landing:click'][0]()
  assert.ok(sent.some(([name, data]) => name === 'name' && data === 'Cool Cucumber'),
    'new name should be broadcast')
  assert.equal(globalThis.document.querySelector('#name-pill').textContent, 'Cool Cucumber')
  assert.equal(globalThis.document.querySelector('#name-landing').textContent, 'Cool Cucumber')

  // a remote peer announces a name, then wins a round
  actions.name.onMessage('Alice', {peerId: 'zzzRemotePeer'})
  listeners['stage:pointerdown'][0]({pointerId: 9, clientX: 200, clientY: 200, preventDefault: () => {}})
  actions.fingers.onMessage({7: [0.5, 0.5]}, {peerId: 'zzzRemotePeer'})
  step(100, 2)

  const keys = ['selfPeer0001/9', 'zzzRemotePeer/7']
  let seed = 0
  while (pickWinner(keys, seed) !== 'zzzRemotePeer/7') seed++
  actions.pick.onMessage({seed, keys}, {peerId: 'zzzRemotePeer'})
  assert.equal(globalThis.document.querySelector('#banner').textContent, 'Alice was chosen')

  // cleanup: lift everything and let the reveal expire
  listeners['window:pointerup'][0]({pointerId: 9})
  actions.fingers.onMessage({}, {peerId: 'zzzRemotePeer'})
  step(9000, 20)
  assert.ok(globalThis.document.querySelector('#banner').hidden)
})

test('groups mode: pick toggle off, host divides fingers into colored groups', () => {
  const {actions} = globalThis.__mock
  const sent = globalThis.__sent
  sent.length = 0

  // switch to groups mode and bump the group count — both broadcast as `mode`
  listeners['mode-toggle:click'][0]()
  let modeMsg = sent.filter(([name]) => name === 'mode').at(-1)
  assert.ok(modeMsg && modeMsg[1].mode === 'groups', 'switching to groups broadcasts the mode')
  assert.equal(globalThis.document.querySelector('#mode-toggle').textContent, 'Groups')
  assert.ok(!globalThis.document.querySelector('#count-stepper').hidden, 'count stepper shows in groups mode')

  listeners['count-inc:click'][0]() // 2 -> 3 groups
  modeMsg = sent.filter(([name]) => name === 'mode').at(-1)
  assert.equal(modeMsg[1].groupCount, 3, 'changing the count broadcasts it')
  assert.equal(globalThis.document.querySelector('#count-label').textContent, '3 groups')

  // two local fingers + one remote finger, held stable past HOLD_MS as host
  const down = listeners['stage:pointerdown'][0]
  down({pointerId: 1, clientX: 100, clientY: 100, preventDefault: () => {}})
  down({pointerId: 2, clientX: 500, clientY: 400, preventDefault: () => {}})
  step(100, 5)
  for (let i = 0; i < 4; i++) {
    actions.fingers.onMessage({7: [0.5, 0.5]}, {peerId: 'zzzRemotePeer'})
    step(1000, 10)
  }

  // host should broadcast a `group` division, not a `pick`
  const groupMsg = sent.find(([name]) => name === 'group')
  assert.ok(groupMsg, 'host should broadcast a group division after the hold')
  assert.ok(!sent.some(([name]) => name === 'pick'), 'no winner is picked in groups mode')
  assert.equal(groupMsg[1].count, 3)
  assert.equal(groupMsg[1].keys.length, 3, 'division should cover all three fingers')
  const banner = globalThis.document.querySelector('#banner')
  assert.ok(!banner.hidden && banner.textContent === 'Split into 3 groups', 'banner shows the division')

  // lift everything; the group labels should still draw during the minimum
  // reveal window, matching winners mode's lingering picked state.
  const up = listeners['window:pointerup'][0]
  globalThis.__ctxCalls.length = 0
  up({pointerId: 1})
  up({pointerId: 2})
  actions.fingers.onMessage({}, {peerId: 'zzzRemotePeer'})
  step(100, 2)
  assert.ok(globalThis.__ctxCalls.some(([name]) => name === 'fillText'),
    'group labels should linger after fingers are lifted')

  // let the reveal expire, and switch back to pick mode
  step(9000, 20)
  assert.ok(banner.hidden, 'round should reset after the reveal')
  listeners['mode-toggle:click'][0]() // back to winners for later tests
  assert.equal(globalThis.document.querySelector('#mode-toggle').textContent, 'Winners')
})

test('winners mode with count 2: host picks two winners across devices', () => {
  const {actions} = globalThis.__mock
  const sent = globalThis.__sent
  sent.length = 0

  // we're back in winners mode (count 1, the default); bump to 2 winners
  listeners['count-inc:click'][0]() // 1 -> 2 winners
  let modeMsg = sent.filter(([name]) => name === 'mode').at(-1)
  assert.ok(modeMsg && modeMsg[1].mode === 'winners', 'still in winners mode')
  assert.equal(modeMsg[1].winnerCount, 2, 'changing the count broadcasts it')
  assert.equal(globalThis.document.querySelector('#count-label').textContent, '2 winners')

  // two local fingers + one remote finger, held stable past HOLD_MS as host
  const down = listeners['stage:pointerdown'][0]
  down({pointerId: 1, clientX: 100, clientY: 100, preventDefault: () => {}})
  down({pointerId: 2, clientX: 500, clientY: 400, preventDefault: () => {}})
  step(100, 5)
  for (let i = 0; i < 4; i++) {
    actions.fingers.onMessage({7: [0.5, 0.5]}, {peerId: 'zzzRemotePeer'})
    step(1000, 10)
  }

  const pickMsg = sent.find(([name]) => name === 'pick')
  assert.ok(pickMsg, 'host should broadcast a pick after the hold')
  assert.equal(pickMsg[1].count, 2, 'pick should carry the winner count')
  assert.equal(pickMsg[1].keys.length, 3, 'pick should cover all three fingers')
  const banner = globalThis.document.querySelector('#banner')
  assert.ok(!banner.hidden, 'banner should reveal the winners')
  // two of the three fingers won; the local player held two so is a winner
  assert.match(banner.textContent, /winner/, 'banner reflects multiple winners')

  // lift everything, let the reveal expire, and drop back to 1 winner
  const up = listeners['window:pointerup'][0]
  up({pointerId: 1})
  up({pointerId: 2})
  actions.fingers.onMessage({}, {peerId: 'zzzRemotePeer'})
  step(9000, 20)
  assert.ok(banner.hidden, 'round should reset after the reveal')
  listeners['count-dec:click'][0]() // back to 1 winner for later tests
  assert.equal(globalThis.document.querySelector('#count-label').textContent, '1 winner')
})

test('rejoins the room after a long page suspension', async () => {
  const joinsBefore = globalThis.__joins
  const fireVisibility = (state) => {
    globalThis.document.visibilityState = state
    for (const fn of listeners['document:visibilitychange']) fn()
  }

  // a short tab switch should NOT trigger a rejoin
  fireVisibility('hidden')
  fireVisibility('visible')
  await flush()
  assert.equal(globalThis.__joins, joinsBefore, 'short hide should not rejoin')

  // a long suspension (screen lock) should rejoin with fresh connections
  fireVisibility('hidden')
  const realNow = Date.now
  Date.now = () => realNow() + 20000
  try {
    fireVisibility('visible')
  } finally {
    Date.now = realNow
  }
  await flush() // rejoinRoom -> async connect -> joinRoom
  assert.equal(globalThis.__joins, joinsBefore + 1, 'long hide should rejoin')
  assert.equal(globalThis.__mock.roomId, 'TEST', 'should rejoin the same room')
  assert.equal(typeof globalThis.__mock.actions.fingers.onMessage, 'function',
    'handlers should be re-wired on the fresh room')
})

test('diagnostic share button copies a complete debug report', async () => {
  await listeners['share-diagnostic:click'][0]()
  const text = globalThis.navigator.clipboard.lastText
  assert.match(text, /^Chooser diagnostics\n\n/)
  const report = JSON.parse(text.replace(/^Chooser diagnostics\n\n/, ''))
  assert.equal(report.roomCode, 'TEST')
  assert.equal(report.selfId, 'selfPeer0001')
  assert.equal(report.runtime.userAgent, 'node-smoke-test')
  assert.equal(report.network.turn.attempted, true)
  assert.ok(Array.isArray(report.network.relayUrls))
  assert.ok(Array.isArray(report.webrtc.peerConnections))
  assert.equal(report.room.hasNet, true)
})

test('no runtime errors were surfaced to the on-screen toast', () => {
  const err = globalThis.document.querySelector('#err')
  assert.equal(err.textContent, '', `error toast showed: ${err.textContent}`)
})
