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
  const canvas = {
    ...el('stage'),
    clientWidth: 800, clientHeight: 600, width: 0, height: 0,
    getContext: () => new Proxy({}, {get: () => () => {}}),
  }
  els['#stage'] = canvas
  globalThis.__sent = []
  globalThis.document = {
    querySelector: (s) => (els[s] ??= el(s.slice(1))),
    addEventListener: (t, fn) => { (listeners['document:' + t] ||= []).push(fn) },
    visibilityState: 'visible',
  }
  globalThis.window = {
    addEventListener: (t, fn) => { (listeners['window:' + t] ||= []).push(fn) },
    devicePixelRatio: 2,
  }
  globalThis.location = {hash: '#TEST', origin: 'http://x', pathname: '/'}
  globalThis.requestAnimationFrame = (fn) => rafQueue.push(fn)
  // main.js starts a heartbeat interval; keep it from holding the process open
  globalThis.setInterval = () => 0
  globalThis.localStorage = {getItem: () => null, setItem: () => {}}
  Object.defineProperty(globalThis.performance, 'now', {value: () => vnow})

  await import(pathToFileURL(join(dir, 'js', 'main.js')))
})

test('joining from the URL hash wires up the room', () => {
  assert.ok(globalThis.__mock, 'joinRoom should have been called')
  assert.equal(globalThis.__mock.roomId, 'TEST')
  assert.ok(globalThis.__mock.config.relayConfig.urls.length >= 4,
    'pinned relay list should be passed to trystero')
  const urls = globalThis.__mock.config.relayConfig.urls
  assert.equal(new Set(urls).size, urls.length, 'relay list should have no duplicates')
  assert.equal(urls.filter((u) => u.startsWith('wss://d')).length, 4,
    'four fallback relays should be drawn from the default pool')
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

test('rejoins the room after a long page suspension', () => {
  const joinsBefore = globalThis.__joins
  const fireVisibility = (state) => {
    globalThis.document.visibilityState = state
    for (const fn of listeners['document:visibilitychange']) fn()
  }

  // a short tab switch should NOT trigger a rejoin
  fireVisibility('hidden')
  fireVisibility('visible')
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
  assert.equal(globalThis.__joins, joinsBefore + 1, 'long hide should rejoin')
  assert.equal(globalThis.__mock.roomId, 'TEST', 'should rejoin the same room')
  assert.equal(typeof globalThis.__mock.actions.fingers.onMessage, 'function',
    'handlers should be re-wired on the fresh room')
})

test('no runtime errors were surfaced to the on-screen toast', () => {
  const err = globalThis.document.querySelector('#err')
  assert.equal(err.textContent, '', `error toast showed: ${err.textContent}`)
})
