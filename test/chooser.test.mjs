import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  pickWinner, mulberry32, colorFor, peerName, sanitizeName, fingerKey,
  randomCode, normalizeCode, PALETTE,
} from '../js/chooser.js'

test('pickWinner is deterministic for a given seed', () => {
  const keys = ['peerB/2', 'peerA/1', 'peerC/7']
  const first = pickWinner(keys, 12345)
  for (let i = 0; i < 20; i++) {
    assert.equal(pickWinner(keys, 12345), first)
  }
})

test('pickWinner is order-independent (all peers agree)', () => {
  const keys = ['c/1', 'a/9', 'b/3', 'a/2']
  const shuffled = ['a/2', 'b/3', 'c/1', 'a/9']
  for (const seed of [0, 1, 42, 999999, 2 ** 31]) {
    assert.equal(pickWinner(keys, seed), pickWinner(shuffled, seed))
  }
})

test('pickWinner returns a member of the input and covers all members', () => {
  const keys = ['a/1', 'b/1', 'c/1', 'd/1']
  const seen = new Set()
  for (let seed = 0; seed < 1000; seed++) {
    const w = pickWinner(keys, seed)
    assert.ok(keys.includes(w))
    seen.add(w)
  }
  assert.equal(seen.size, keys.length, 'every finger should be reachable')
})

test('pickWinner handles edge cases', () => {
  assert.equal(pickWinner([], 7), null)
  assert.equal(pickWinner(['only/1'], 7), 'only/1')
})

test('mulberry32 produces values in [0, 1) and is reproducible', () => {
  const a = mulberry32(99)
  const b = mulberry32(99)
  for (let i = 0; i < 100; i++) {
    const v = a()
    assert.ok(v >= 0 && v < 1)
    assert.equal(v, b())
  }
})

test('colorFor is stable and from the palette', () => {
  const key = fingerKey('somePeer', 3)
  assert.equal(colorFor(key), colorFor(key))
  assert.ok(PALETTE.includes(colorFor(key)))
})

test('peerName is stable per peer', () => {
  assert.equal(peerName('abc123'), peerName('abc123'))
  assert.match(peerName('abc123'), /^\w+ \w+$/)
})

test('sanitizeName trims, collapses whitespace and caps length', () => {
  assert.equal(sanitizeName('  Big   Bird  '), 'Big Bird')
  assert.equal(sanitizeName('x'.repeat(50)).length, 20)
  assert.equal(sanitizeName('   '), null)
  assert.equal(sanitizeName(''), null)
  assert.equal(sanitizeName(null), null)
})

test('room codes round-trip through normalizeCode', () => {
  for (let i = 0; i < 50; i++) {
    const code = randomCode()
    assert.equal(normalizeCode(code), code)
    assert.equal(normalizeCode(` ${code.toLowerCase()} `), code)
  }
  assert.equal(normalizeCode('x'), null)
  assert.equal(normalizeCode(''), null)
  assert.equal(normalizeCode('toolongcode123'), null)
})
