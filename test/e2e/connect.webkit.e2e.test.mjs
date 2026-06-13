// Hermetic WebKit↔WebKit end-to-end test of the real WebRTC path. WebKit is the
// engine behind Safari, so this is the closest stand-in for iPhone Safari we can
// run on Linux/CI (issue #2). It is a smoke signal, not a Safari oracle:
// WebKit-on-Linux's WebRTC differs from real iOS Safari, so on-device testing
// remains the source of truth. See suite.mjs for the harness and caveats.
import {webkit} from 'playwright'
import {connectSuite} from './suite.mjs'

connectSuite(webkit, 'WebKit')
