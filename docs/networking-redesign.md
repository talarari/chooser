# Networking redesign: authoritative Cloudflare room server

> Status: **design approved, not yet implemented.** This document is the spec to
> implement from. It replaces the current P2P/WebRTC architecture.

## Context

Chooser is a multiplayer "everyone holds a finger, then it picks winners/groups"
game. Today it runs 100% peer-to-peer over WebRTC, with **Nostr relays** doing the
signaling WebRTC itself doesn't define, **Cloudflare TURN** as a relay fallback, and
a deterministic seeded PRNG (`js/chooser.js`) so every peer independently computes
the *same* winner with no coordination. A lexicographically-smallest-peer "host"
(`js/main.js` `isHost()`) triggers the pick.

This is the wrong architecture for this game:

- The data is tiny and **not latency-sensitive** (fingers mostly don't move — the
  game is holding still), so P2P buys nothing.
- The signaling layer Nostr provides is the flaky part: **iPhones fail to connect**
  over public relays (the original reason TURN was bolted on, issue #2).
- The deterministic PRNG and host election exist *only* to fake agreement without an
  authority.

The goal: **free to run, and it just works.** With one tiny authoritative server we
delete the entire signaling/ICE/TURN/host-election problem space. A Cloudflare
**Durable Object** is the right primitive — `idFromName(roomCode)` gives the exact
"deterministic routing by room id" we want, for free. The free tier (100k req/day,
incoming WS messages billed 20:1, hibernation = no idle charges) is far more than
enough at this scale.

### Decisions

- **Server owns the full game state** — the Durable Object tracks all fingers, runs
  the hold timer, decides the pick, and broadcasts state transitions. Clients become
  input-forwarders + renderers. No host election, no cross-peer timing divergence.
- **Remove WebRTC / Nostr / TURN entirely.** No fallback.

## Architecture

```
client ──WSS /room/:code──► Worker ──idFromName(code)──► Room (Durable Object)
                                                          ├─ holds all fingers + room state
                                                          ├─ runs hold timer via DO alarm
                                                          ├─ decides pick (calls chooser.js)
                                                          └─ broadcasts to all sockets
```

- **Routing:** `env.ROOMS.idFromName(roomCode)` → same code always hits the same DO.
- **Transport:** one `wss://` connection per client (WebSocket Hibernation API, so
  idle rooms cost no duration). iPhones: plain TLS WebSocket, no NAT traversal.
- **Authority:** the DO is the single source of truth for fingers, mode, and phase.

### Server game-state machine (in the DO; no 60fps loop — event + alarm driven)

State per room: `members: Map<id,{ws,name}>`, `fingers: Map<id, {pointerId:[x,y]}>`,
`mode/winnerCount/groupCount`, `phase: idle|armed|picked`, `stableSig`.

- **On `fingers` message:** update sender's fingers, broadcast `fingers {from,fingers}`
  to others, recompute the union finger-key **set signature** (sorted keys — matches
  today's `js/main.js` hold logic, where *moving* a finger does NOT reset, only
  add/remove).
  - signature changed & ≥2 fingers → set `phase=armed`, `setAlarm(now+HOLD_MS)`,
    broadcast `armed {durationMs: HOLD_MS}`.
  - signature changed & <2 fingers → cancel/clear, broadcast `reset`.
  - signature unchanged → nothing (timer keeps running).
- **On alarm:** if still ≥2 stable fingers → run `pickWinners`/`assignGroups`
  (imported from `js/chooser.js`, now with a plain `Math.random` seed — no cross-peer
  reproducibility needed), `phase=picked`, broadcast `picked {keys}` or
  `grouped {assignment}`, set a reveal-end alarm (`REVEAL_MAX_MS`). Reveal-end alarm →
  `phase=idle`, broadcast `reset`.
- **On `mode` message:** clamp, store, broadcast `mode {...}` (anyone may change it;
  server is authority — no host).
- **On `name`:** store on member, broadcast `name {from,name}`.
- **On connect:** assign/accept client id, send `welcome {members, mode, counts,
  phase}`, broadcast `member-join`. On close: drop member + its fingers, broadcast
  `member-leave`, recompute signature.

### Protocol (JSON over WS)

- **C→S:** `hello {id,name}`, `fingers {fingers}`, `name {name}`,
  `mode {mode,winnerCount,groupCount}`
- **S→C:** `welcome {...}`, `member-join {id,name}`, `member-leave {id}`,
  `fingers {from,fingers}`, `name {from,name}`, `mode {...}`,
  `armed {durationMs}`, `picked {keys}`, `grouped {assignment}`, `reset {}`

Note: `picked`/`grouped` carry the **final** keys/assignment. Clients no longer run
the PRNG; they map keys → their locally-held finger positions for rendering. The
`{seed, keys, count}` reproducibility payload is gone.

## File changes

### New — `room-worker/` (Cloudflare Worker + Durable Object)

- `room-worker/src/worker.js` — `fetch`: on `/room/:code`, validate origin, upgrade
  to WebSocket, route to `env.ROOMS.idFromName(code)`.
- `room-worker/src/room.js` — `Room` DO class using **WebSocket Hibernation**
  (`state.acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `webSocketError`,
  `alarm`). Implements the state machine above; imports `pickWinners`, `assignGroups`
  from `../../js/chooser.js`.
- `room-worker/wrangler.toml` — `[[durable_objects.bindings]]` ROOMS→Room, and a
  **SQLite migration** (`new_sqlite_classes`) — required for free-tier DOs.
- `room-worker/README.md` — deploy steps (`wrangler deploy`), free-tier notes.

### Modified

- **`js/net.js`** — full rewrite to a thin WebSocket client. Keep the same surface
  `main.js` consumes: `connect(roomCode, handlers)` returning `{sendFingers, sendName,
  sendMode, leave}`; export a client-generated `selfId` (random string, sent in
  `hello` — keeps `selfId` synchronous at module load as today); add
  `connectionStatus()` + simplified `networkDiagnostics()`. Add WS auto-reconnect with
  backoff. Handlers gain `onArmed/onPicked/onGrouped/onReset/onMember*`; drop the
  TURN-fetch/ICE machinery entirely. Reuse a `?server=ws://…` test seam in the spirit
  of the existing `?relays=`/`?turn=` seams.
- **`js/main.js`**
  - Delete `isHost()`, `doPick`/`doGroup`, and the host-triggered pick in `tick()`.
    The tick loop now only renders.
  - `applyPick`/`applyGroup` take the server's final `keys`/`assignment` (no seed, no
    `pickWinners` call) and map to local positions via `collectFingers()`.
  - Drive `armed`/progress from the server `armed` event: interpolate `progress`
    locally from receipt time over `durationMs`; keep countdown tick sounds local.
    `reset` event clears reveal/armed.
  - Drop the `onPeerJoin` catch-up resends — `welcome` carries room state. Keep the
    visibilitychange rejoin but as a WS reconnect.
- **`js/diag.js`** — remove the `RTCPeerConnection` wrap; reduce to WS
  connection-state + member count for the on-screen HUD.
- **Build / `package.json`** — drop the Trystero vendor from the client bundle; add a
  worker deploy script. Delete `vendor/trystero-nostr.min.js`.
- **Tests** — `js/chooser.js` unit tests stay (pure logic unchanged). Rewrite the e2e
  transport harness: run the worker under **`wrangler dev` / miniflare** and point
  browser clients at it via `?server=`. Delete the forced-relay/TURN e2e (`?ice=relay`,
  `?turn=`) — no longer meaningful.
- **`turn-worker/`** — delete (replaced by `room-worker/`).
- **Docs / README** — update the architecture description (no more P2P/Nostr/TURN).

### Unchanged

- `js/chooser.js` logic — now *shared* by client (colors/names/codes) and worker
  (pick/group). `js/render.js`, `js/audio.js`, PWA/service worker.

## Verification

1. **Unit:** `npm test` — `chooser.js` pick/group tests still green.
2. **Worker local:** `cd room-worker && npx wrangler dev`; confirm a DO is created per
   room code and the WS upgrade works.
3. **e2e (hermetic):** two headless Chromium contexts join the same code via
   `?server=ws://localhost:<wrangler-port>`; assert: both see 2 devices, fingers
   render across clients, holding ≥2 fingers 3s yields a `picked`/`grouped` reveal with
   the exact existing banner wording (e.g. "🎉 You were chosen!").
4. **Manual cross-device (the real bug):** deploy worker (`wrangler deploy`), open the
   GitHub Pages app on an **iPhone Safari + a laptop** on the same room code, confirm
   they connect and a pick works — the case that failed over Nostr.
5. **Free-tier sanity:** confirm idle rooms hibernate (no duration billing) and a busy
   session stays well under 100k req/day given the 20:1 WS billing ratio.

## Notes for whoever implements this

- **Deploy + the iPhone test must run from a local machine** with `wrangler` logged
  into the Cloudflare account — they can't be done from a sandboxed CI/web
  environment.
- `js/chooser.js` is pure ESM with no browser dependencies, so the Worker can import
  it directly; `wrangler` bundles it via esbuild.
- Free-tier Durable Objects **must be SQLite-backed** — use `new_sqlite_classes` in
  the wrangler migration. You don't need to persist anything; room state lives in
  memory while the room is active.
- Keep the existing banner copy exact — the e2e asserts on the single-winner wording.
