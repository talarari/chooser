# Chooser

A multiplayer finger chooser that works **across devices** — everyone in the room holds a finger on their own phone, and one finger (on one device) gets picked.

100% client-only: no backend, no accounts, no build step. Peers connect directly over **WebRTC**, with signaling done through public Nostr relays via [Trystero](https://github.com/dmotz/trystero), so the whole thing can be served as static files (e.g. GitHub Pages). Trystero (v0.25.2, nostr strategy) is vendored as a single ESM bundle in `vendor/`, so there's no runtime CDN dependency — to update it, rebuild with `npx esbuild node_modules/trystero/dist/nostr.mjs --bundle --format=esm --minify`.

## How to play

1. Open the app, tap **Start a room** — you get a 4-letter room code.
2. Friends join by entering the code (or opening the shared link — tap the room pill to copy/share it).
3. Everyone touches and holds the screen. Multiple fingers per device work too.
4. Once at least **2 fingers** (across all devices) hold steady for **3 seconds**, one finger is chosen. The winning device lights up.
5. Lift all fingers to play again.

You get a random name (e.g. "Lucky Otter"); tap it — on the start screen or in the room header — to rename yourself. Names are saved on your device and shown to other players when you're chosen.

## Run locally

Any static file server works:

```sh
npm start            # python3 -m http.server 8080
# then open http://localhost:8080
```

Note: WebRTC + clipboard APIs require a secure context — `localhost` is fine, but to test from a phone on your LAN you'll need HTTPS (or deploy to any static host).

## Run tests

```sh
npm test
```

Unit + smoke tests cover the deterministic selection logic in `js/chooser.js` and the app wiring (with trystero mocked at the module boundary).

### End-to-end (real WebRTC)

```sh
npm install            # devDeps: playwright + ws
npm run e2e:install    # one-time: download the Chromium + WebKit binaries
npm run e2e            # Chromium↔Chromium, direct (the regression guard)
npm run e2e:webkit     # WebKit↔WebKit over real Cloudflare TURN (Safari — see below)
npm run e2e:turn       # forced-relay over real Cloudflare TURN (see below)
npm run e2e:all        # all of the above
```

The relay suites (`e2e:webkit`, `e2e:turn`) connect over the **real Cloudflare TURN** path production uses — they mint short-lived credentials from the deployed Worker (`turn-worker/`) and relay through Cloudflare TURN — so they need outbound egress to Cloudflare TURN. From a host that blocks STUN/TURN egress they fail (no relay candidate gathered) rather than skip. Override the Worker with `TURN_WORKER_URL=…` (e.g. a local `wrangler dev`).

A hermetic Chromium↔Chromium test (`test/e2e/`) drives **two real browser pages** through a full round over **real `RTCPeerConnection`/data channels**. It needs no public network: the pages connect via loopback host candidates, and signaling runs through a tiny local Nostr relay (`test/e2e/relay.mjs`, minimal NIP-01) that the app is pointed at with a `?relays=ws://localhost:…` test seam in `js/net.js`. It asserts both peers reach "2 devices", a finger drawn on one page renders remotely on the other, and a held pick yields one winner both pages agree on — the guard that catches networking regressions the mocked tests can't see. The suite is parametrised by engine in `test/e2e/suite.mjs`.

#### Safari (WebKit) over TURN — `npm run e2e:webkit`

The same suite runs against Playwright's **WebKit**, the engine behind Safari — the closest stand-in for iPhone Safari available on Linux/CI (issue #2). WebKit gathers only mDNS `.local` host candidates, each with an obfuscated hostname the peer can't resolve over loopback, so no *direct* candidate pair ever forms — the same class of failure real Safari hits on a LAN. So this suite connects over the **real Cloudflare TURN** relay (short-lived creds from the Worker, `iceTransportPolicy: 'relay'`): the relay candidate has a routable address with nothing to resolve, so the Safari-engine peers reach "2 devices" exactly as they do in production. It is wired into CI as a **non-blocking** job (`continue-on-error`, absent from deploy's `needs`) so a transient TURN hiccup can't wedge a deploy, but it is expected to pass. Caveat: WebKit-on-Linux is **not** Safari and its WebRTC differs from real iOS Safari, so a real iPhone (or a cloud device lab) remains the source of truth.

#### Forced relay — `npm run e2e:turn`

The Safari/cross-network fix is a **TURN relay fallback** (see "How it works"): a relayed candidate has a real routable address, so it sidesteps the mDNS resolution and NAT traversal that strand peers with no direct path. This test forces ICE through TURN only (`iceTransportPolicy: 'relay'`, via the `?ice=relay` seam in `js/net.js`) on both Chromium and WebKit and asserts two peers still connect — so a direct path can't hide a broken relay.

It runs against the **real production setup**: short-lived credentials minted by the Cloudflare Worker in [`turn-worker/`](turn-worker/) (the API token is a secret that can't ship in client JS), relaying through Cloudflare TURN. It defaults to the deployed Worker so it always runs (no skip); override with `TURN_WORKER_URL=…` (e.g. a local `wrangler dev`). It therefore needs real egress to Cloudflare TURN — from a host that filters STUN/TURN egress it **fails** (no relay candidate gathered), which is a real broken-relay signal, not a skip. Because WebKit-on-Linux ≠ Safari, **final confirmation is still a real iPhone Safari ↔ Chrome session** on the same and on different networks (issue #2 acceptance criteria).

## Deploy to GitHub Pages

The repo ships with a workflow (`.github/workflows/deploy.yml`) that runs the tests, builds `dist/` with `node build.mjs`, and force-pushes it to the `gh-pages` branch (Pages serves from that branch). It triggers on pushes to `main`, or run it manually from the Actions tab.

The build bundles the whole JS module graph (app + vendored Trystero) into a single `app.js` referenced with a commit-stamped URL. That matters: Pages caches assets for 10 minutes, and serving the app as multiple plain-path modules once let a browser mix old and new module versions mid-deploy, breaking the site. One file + stamped URL makes deploys atomic per browser.

The app lives at `https://<user>.github.io/<repo>/` — asset paths are relative, so the project subpath just works, and Pages' HTTPS satisfies the secure-context requirement for WebRTC and clipboard access.

## How it works

- **Networking** (`js/net.js`): Trystero joins a room derived from the room code. Two P2P actions are used: `fingers` (each device broadcasts its active touches as normalized coordinates, plus a 1s heartbeat) and `pick` (the chosen-finger announcement). ICE uses public STUN plus a **TURN relay fallback** from [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/) (including TLS-over-443 for UDP-blocked networks). **Trickle ICE is disabled** (`trickleIce: false`): each peer waits for ICE gathering to *complete* and sends one offer/answer with the full candidate set — including the TURN relay candidate — baked into the SDP, instead of dribbling candidates out as separate messages. Over the eventually-consistent, lossy Nostr relay mesh those trailing per-candidate messages don't reliably reach the peer, which strands cross-network peers (relay candidates gathered on both ends but the remote side never leaves `ice: new`, so no data channel opens and fingers never cross — issue #2). Bundling everything into a single SDP message survives the lossy channel. Cloudflare issues short-lived credentials minted from a key whose API token is a secret, so a tiny [Cloudflare Worker](turn-worker/) holds the token and mints credentials on demand; the client fetches fresh ICE servers from it at join time (free public TURN with universal static credentials no longer exists — Open Relay's were retired). ICE always prefers a direct path and only relays when none exists, so relayed bandwidth is spent only on the connections that need it — chiefly iPhone Safari, which otherwise can't connect on a plain LAN (issue #2). With no Worker configured the app falls back to STUN-only, exactly as before TURN existed.
- **Agreement without a server** (`js/chooser.js`): every finger has a global key `peerId/pointerId`. When the finger set is stable for 3s, the *host* (the peer with the lexicographically smallest id) broadcasts `{seed, keys}`. Every device sorts the keys and runs the same seeded PRNG (mulberry32), so all peers independently compute the same winner.
- **Resilience**: finger state is re-broadcast every second and expires after 3s of silence, so a device that drops off can't wedge the round. The winner reveal also has a hard 8s timeout.
- **Rendering** (`js/render.js`): fullscreen canvas; local fingers are solid rings, remote fingers are dashed ghost rings at their relative positions, a white arc shows the countdown, and the winner gets a shockwave reveal.
- **On-screen WebRTC diagnostic** (`js/diag.js`): phones have no devtools and the iPhone Safari failure is silent (the room joins, no error, but no peer connection forms), so the HUD shows a live readout next to the relay counter — `pc <connectionState> · ice <iceConnectionState> · gather <iceGatheringState> · <candidate types>` — turning "it just doesn't connect" into a precise triage signal (issue #2). It wraps `RTCPeerConnection` to observe the connections trystero owns.
