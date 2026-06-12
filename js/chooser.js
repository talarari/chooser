// Pure game logic shared by every peer. Everything here must be deterministic
// so that all devices, given the same pick message, agree on the winner.

export const MIN_FINGERS = 2
export const HOLD_MS = 3000 // fingers must stay stable this long before a pick
export const REVEAL_MIN_MS = 2500 // winner stays on screen at least this long
export const REVEAL_MAX_MS = 8000 // ...and resets after this long no matter what

export const PALETTE = [
  '#ff3b6b', '#ffb820', '#27e0a6', '#2fb5ff', '#a06bff', '#ff7a45',
  '#3ddc97', '#ff5fa2', '#55e6f2', '#cdf252', '#ff8fd8', '#7da2ff',
]

const ADJECTIVES = [
  'Brave', 'Calm', 'Daring', 'Eager', 'Fuzzy', 'Gentle', 'Happy', 'Jolly',
  'Keen', 'Lucky', 'Mighty', 'Nimble', 'Proud', 'Quick', 'Sunny', 'Witty',
]

const ANIMALS = [
  'Otter', 'Panda', 'Tiger', 'Koala', 'Llama', 'Gecko', 'Raven', 'Shark',
  'Moose', 'Bison', 'Dingo', 'Heron', 'Lemur', 'Mole', 'Newt', 'Wolf',
]

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function fingerKey(peerId, fingerId) {
  return `${peerId}/${fingerId}`
}

// FNV-1a, used to derive stable colors/names from ids.
export function hashStr(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function colorFor(key) {
  return PALETTE[hashStr(key) % PALETTE.length]
}

export function peerName(peerId) {
  const h = hashStr(peerId)
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 8) % ANIMALS.length]}`
}

export function sanitizeName(raw) {
  const name = (raw || '').trim().replace(/\s+/g, ' ').slice(0, 20)
  return name.length ? name : null
}

// Deterministic PRNG so every peer derives the same winner from the seed.
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// keys: finger keys present at pick time (any order). Returns the winning key.
export function pickWinner(keys, seed) {
  const sorted = [...keys].sort()
  if (sorted.length === 0) return null
  return sorted[Math.floor(mulberry32(seed)() * sorted.length)]
}

export function randomCode(len = 4) {
  let code = ''
  for (let i = 0; i < len; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

export function normalizeCode(raw) {
  const code = (raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return code.length >= 3 && code.length <= 8 ? code : null
}
