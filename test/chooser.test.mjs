import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  pickWinner, pickWinners, mulberry32, colorFor, peerName, sanitizeName, fingerKey,
  randomCode, normalizeCode, PALETTE, assignGroups, groupColor,
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

test('pickWinners is deterministic for a given seed', () => {
  const keys = ['peerB/2', 'peerA/1', 'peerC/7', 'peerD/4']
  const first = pickWinners(keys, 12345, 2)
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(pickWinners(keys, 12345, 2), first)
  }
})

test('pickWinners is order-independent (all peers agree)', () => {
  const keys = ['c/1', 'a/9', 'b/3', 'a/2', 'd/5']
  const shuffled = ['a/2', 'd/5', 'b/3', 'c/1', 'a/9']
  for (const seed of [0, 1, 42, 999999, 2 ** 31]) {
    // sort both so set membership is compared (order within the result is the
    // shuffle order, which is itself identical for identical sorted input)
    assert.deepEqual(pickWinners(keys, seed, 3), pickWinners(shuffled, seed, 3))
  }
})

test('pickWinners returns count distinct members all from the input', () => {
  const keys = ['a/1', 'b/1', 'c/1', 'd/1', 'e/1']
  const won = pickWinners(keys, 42, 3)
  assert.equal(won.length, 3)
  assert.equal(new Set(won).size, 3, 'winners are distinct')
  for (const w of won) assert.ok(keys.includes(w), 'winner is from the input')
})

test('pickWinners clamps count to the number of keys', () => {
  const keys = ['a/1', 'b/1', 'c/1']
  const won = pickWinners(keys, 7, 10)
  assert.equal(won.length, 3, 'cannot pick more winners than fingers')
  assert.equal(new Set(won).size, 3)
})

test('pickWinners clamps count up to at least 1 and handles empty input', () => {
  assert.deepEqual(pickWinners([], 7, 3), [])
  assert.equal(pickWinners(['only/1'], 7, 5).length, 1)
  assert.equal(pickWinners(['a/1', 'b/1'], 7, 0).length, 1, 'count below 1 clamps to 1')
})

test('pickWinners with count 1 matches pickWinner', () => {
  const keys = ['peerB/2', 'peerA/1', 'peerC/7']
  for (const seed of [0, 1, 42, 12345, 999999]) {
    assert.equal(pickWinners(keys, seed, 1)[0], pickWinner(keys, seed))
  }
})

test('assignGroups is deterministic and order-independent (all peers agree)', () => {
  const keys = Array.from({length: 10}, (_, i) => `p/${i}`)
  const shuffled = [...keys].reverse()
  const a = assignGroups(keys, 123, 3)
  const b = assignGroups(shuffled, 123, 3)
  for (const k of keys) assert.equal(a.get(k), b.get(k))
})

test('assignGroups splits into balanced groups within range', () => {
  const keys = Array.from({length: 10}, (_, i) => `p/${i}`)
  const a = assignGroups(keys, 42, 3)
  assert.equal(a.size, 10)
  const sizes = [0, 0, 0]
  for (const g of a.values()) {
    assert.ok(g >= 0 && g < 3, 'group index in range')
    sizes[g]++
  }
  assert.equal(sizes.reduce((x, y) => x + y, 0), 10)
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, 'group sizes differ by at most one')
})

test('assignGroups fills every group when there are enough fingers', () => {
  const keys = Array.from({length: 12}, (_, i) => `p/${i}`)
  const seen = new Set(assignGroups(keys, 7, 4).values())
  assert.equal(seen.size, 4, 'every group should get at least one finger')
})

test('assignGroups handles edge cases', () => {
  assert.equal(assignGroups([], 1, 3).size, 0)
  const single = assignGroups(['only/1'], 1, 3)
  assert.equal(single.size, 1)
  assert.ok(single.get('only/1') >= 0 && single.get('only/1') < 3)
})

test('groupColor is stable and from the palette', () => {
  assert.equal(groupColor(0), groupColor(0))
  assert.ok(PALETTE.includes(groupColor(5)))
  assert.equal(groupColor(PALETTE.length), groupColor(0), 'wraps around the palette')
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
