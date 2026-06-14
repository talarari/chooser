let _ctx = null

function ac() {
  if (typeof AudioContext === 'undefined') return null
  if (!_ctx) _ctx = new AudioContext()
  if (_ctx.state === 'suspended') _ctx.resume()
  return _ctx
}

function beep(freq, startTime, duration, volume = 0.15, type = 'sine') {
  const c = ac()
  if (!c) return
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.connect(gain)
  gain.connect(c.destination)
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, startTime)
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
  osc.start(startTime)
  osc.stop(startTime + duration)
}

// step: 0 = start of countdown, 1 = 33%, 2 = 66% — pitch escalates with each step
export function playCountdownTick(step) {
  const c = ac()
  if (!c) return
  const freq = [440, 587, 784][step] // A4 → D5 → G5
  beep(freq, c.currentTime, 0.08, 0.12)
}

export function playWinnerReveal(localWon) {
  const c = ac()
  if (!c) return
  const t = c.currentTime
  if (localWon) {
    // ascending arpeggio
    for (const [freq, delay] of [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3]]) {
      beep(freq, t + delay, 0.4, 0.15)
    }
  } else {
    beep(392, t, 0.2, 0.08) // short neutral tone
  }
}

export function playGroupReveal() {
  const c = ac()
  if (!c) return
  const t = c.currentTime
  // staggered G major chord
  for (const [freq, delay] of [[392, 0], [494, 0.03], [587, 0.06]]) {
    beep(freq, t + delay, 0.35, 0.1)
  }
}
