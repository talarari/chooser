// Hermetic Chromium↔Chromium end-to-end test of the real WebRTC path — the
// connectivity regression guard from issue #1. See suite.mjs for the harness.
import {chromium} from 'playwright'
import {connectSuite} from './suite.mjs'

connectSuite(chromium, 'Chromium')
