// WebKit↔WebKit end-to-end test of the real WebRTC path, over real Cloudflare
// TURN. WebKit is the engine behind Safari, so this is the closest stand-in for
// iPhone Safari we can run on Linux/CI (issue #2). WebKit gathers only mDNS
// `.local` host candidates a peer can't resolve over loopback, so the two pages
// connect ONLY via a relay candidate — exactly the relay fallback real iPhone
// Safari depends on. So it mints short-lived credentials from the production
// Worker (turn-worker/) and forces ice=relay: the Safari-engine connection that
// fails on plain loopback now succeeds over the same Cloudflare TURN production
// uses, guarding that relay path end to end.
//
// It is still a smoke signal, not a Safari oracle: WebKit-on-Linux's WebRTC
// differs from real iOS Safari, so on-device testing remains the source of
// truth. See suite.mjs for the harness and caveats.
import {webkit} from 'playwright'
import {connectSuite} from './suite.mjs'

connectSuite(webkit, 'WebKit', {turnRelay: true})
