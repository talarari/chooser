# Chooser TURN Worker

A tiny Cloudflare Worker that mints **short-lived [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/) credentials** for the Chooser app.

## Why this exists

Chooser is a static, server-less site (GitHub Pages) that connects players peer-to-peer over WebRTC. Two peers that can't reach each other directly need a **TURN relay** to connect — most painfully iPhone Safari on a plain LAN, which gathers only mDNS `.local` host candidates it won't resolve for the peer, so the connection never forms ([issue #2](https://github.com/talarari/chooser/issues/2)).

Free public TURN with universal static credentials no longer exists (Open Relay's `openrelayproject` credentials were retired and now return `400`/`701`). Cloudflare TURN is reliable and free for our volume (1,000 GB/mo), but it issues **short-lived** credentials minted from a TURN key whose **API token is a secret** — it must never ship in client JavaScript.

This Worker is the one small piece of server we keep: it holds the secret token and exposes only a credential-minting endpoint. The client (`js/net.js` → `fetchTurnServers`) fetches fresh ICE servers from it at join time. The token never leaves Cloudflare.

## Setup

You need a (free) Cloudflare account.

1. **Create a TURN key.** Dashboard → **Realtime** → **TURN** → **Create**. Copy the **Turn Token ID** (the Key ID) and the **API Token**.

2. **Configure `wrangler.toml`.** Set `TURN_KEY_ID` to the Key ID and `ALLOWED_ORIGINS` to your site origin (e.g. `https://talarari.github.io`). `localhost`/`127.0.0.1` are always allowed for local dev and the e2e.

3. **Store the API token as a secret** (never commit it):
   ```sh
   cd turn-worker
   npx wrangler secret put TURN_KEY_API_TOKEN
   # paste the API Token when prompted
   ```

4. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
   Note the deployed URL (e.g. `https://chooser-turn.<your-subdomain>.workers.dev`).

5. **Point the app at it.** Put that URL in `TURN_ENDPOINT` in `js/net.js`.

## Verify

```sh
# From an allowed origin (localhost is always allowed):
curl -s -H 'Origin: http://localhost' https://chooser-turn.<your-subdomain>.workers.dev | jq
```

A working response looks like:

```json
{
  "iceServers": {
    "urls": [
      "stun:stun.cloudflare.com:3478",
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp"
    ],
    "username": "<short-lived>",
    "credential": "<short-lived>"
  }
}
```

## Local development / e2e

```sh
cd turn-worker
TURN_KEY_ID=... npx wrangler dev      # serves on http://127.0.0.1:8787
# (set the secret once with `wrangler secret put`, or use a .dev.vars file)
```

The forced-relay e2e (`npm run e2e:turn`) points the app at a TURN endpoint via the `?turn=` seam; set `TURN_WORKER_URL` to a running `wrangler dev` URL (or the deployed Worker) to exercise the real relay path. Without it, the test skips.
