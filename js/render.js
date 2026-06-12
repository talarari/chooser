// Canvas rendering. Receives a view-model from main.js each frame and draws
// the finger circles, countdown arcs and winner reveal.

const RING_RADIUS = 52
const RING_WIDTH = 9

function easeOutBack(t) {
  const c = 1.70158
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function drawFinger(ctx, f, now, {progress, dim}) {
  const born = clamp01((now - f.bornAt) / 250)
  const scale = easeOutBack(born)
  const breathe = 1 + 0.03 * Math.sin(now / 250 + f.bornAt)
  const r = RING_RADIUS * scale * breathe * (f.local ? 1 : 0.8)

  ctx.save()
  ctx.globalAlpha = (f.local ? 1 : 0.75) * (1 - dim)
  ctx.translate(f.px, f.py)

  // inner glow disc
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2)
  ctx.fillStyle = f.color
  ctx.globalAlpha *= 0.25
  ctx.fill()
  ctx.globalAlpha = (f.local ? 1 : 0.75) * (1 - dim)

  // main ring
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.lineWidth = RING_WIDTH
  ctx.strokeStyle = f.color
  if (!f.local) ctx.setLineDash([10, 8])
  ctx.stroke()
  ctx.setLineDash([])

  // countdown arc filling clockwise from 12 o'clock
  if (progress > 0) {
    ctx.beginPath()
    ctx.arc(0, 0, r + 14, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2)
    ctx.lineWidth = 4
    ctx.strokeStyle = '#ffffff'
    ctx.globalAlpha *= 0.9
    ctx.stroke()
  }

  ctx.restore()
}

function drawWinner(ctx, f, now, pickedAt) {
  const t = now - pickedAt

  ctx.save()
  ctx.translate(f.px, f.py)

  // expanding shockwave rings
  for (let i = 0; i < 3; i++) {
    const wave = ((t / 900 + i / 3) % 1)
    ctx.beginPath()
    ctx.arc(0, 0, RING_RADIUS + wave * 130, 0, Math.PI * 2)
    ctx.lineWidth = 3
    ctx.strokeStyle = f.color
    ctx.globalAlpha = (1 - wave) * 0.5
    ctx.stroke()
  }

  // solid winner disc
  const pop = easeOutBack(clamp01(t / 350))
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.arc(0, 0, RING_RADIUS * 1.25 * pop, 0, Math.PI * 2)
  ctx.fillStyle = f.color
  ctx.fill()
  ctx.beginPath()
  ctx.arc(0, 0, (RING_RADIUS * 1.25 + 12) * pop, 0, Math.PI * 2)
  ctx.lineWidth = RING_WIDTH
  ctx.strokeStyle = f.color
  ctx.stroke()

  ctx.restore()
}

export function draw(ctx, vm) {
  const {w, h, now, fingers, state, progress, winner, pickedAt} = vm

  ctx.clearRect(0, 0, w, h)

  if (state === 'picked' && winner) {
    const dim = clamp01((now - pickedAt) / 400)
    for (const f of fingers) {
      if (f.key !== winner.key) drawFinger(ctx, f, now, {progress: 0, dim})
    }
    drawWinner(ctx, winner, now, pickedAt)
  } else {
    for (const f of fingers) {
      drawFinger(ctx, f, now, {progress: state === 'armed' ? progress : 0, dim: 0})
    }
  }
}
