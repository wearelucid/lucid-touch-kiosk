# Plug-and-play Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scattered setup controls on the test page with a five-step checklist that derives its state from the system, detects the touch panel on its own, and can be re-entered from a running kiosk.

**Architecture:** Two new pure modules carry the logic: `src/setup-state.js` (step states from facts) runs in the renderer and under `node --test`; `src/gesture.js` (five-finger hold) runs inside the touch agent. `main.js` only gains facts to persist (`touchVerified`, `serialSkipped`, `null` panel ids), one fetch-based URL check, and the kiosk→setup path. `src/testpage.html` is restructured around the checklist; the test targets and serial probe move but do not change.

**Tech Stack:** Electron 44 (main process + `webContents.debugger`), node-hid, WebHID/Web Serial in the bundled page, `node --test` + `node:assert/strict`. No build step, no bundler, no linter.

**Spec:** `docs/superpowers/specs/2026-10-15-plug-and-play-setup-design.md`

## Global Constraints

- **Tob commits himself.** A "Commit" step means: stage the listed files and hand over the message. Never run `git commit`.
- Only setup/test windows get `preload`; the kiosk URL never does. The kiosk→setup triggers therefore live entirely in the main process.
- `createKioskWindow` creates the new window before destroying the previous one; the agent starts on `dom-ready` and stops on `detach` / `render-process-gone`. No new path may break either pairing.
- Touch dispatch stays fire-and-forget; the hold detector must not add an `await` to the data handler.
- Device-supplied strings (product names, port names) go into the DOM as `textContent`, never `innerHTML`.
- UI copy is English. Log messages that repeat must not carry changing values (the logger collapses by text).
- Manual verification runs on the packaged build started with `open -n "dist/mac-arm64/Lucid Touch Kiosk.app"`, never from a shell (TCC attributes a shell launch to the terminal).
- Config keys added: `touchVerified` (bool, default `false`), `serialSkipped` (bool, default `false`); `hidVendorId` / `hidProductId` default `null`. Old config files must keep working unchanged.

## Review Focus

1. **A display that disappears** after setup (projector unplugged): `displayIndex` points past the list → step 1 must read blocked, not done. Test in Task 1 (`display index beyond the list is blocked`).
2. **A panel that reports fewer fingers than `maxTouchPoints`** (Flip reports 10, a two-finger panel 2): the hold detector must never fire on fewer than five contacts, and the kiosk must still open setup via the shortcut. Test in Task 2 (`fewer than five fingers never fires`); shortcut in Task 5.
3. **Contact ids that churn during a hold** (many panels renumber contacts when one finger lifts and comes back): the detector must restart the timer, not fire on a stale start. Test in Task 2 (`a changed contact id restarts the hold`).
4. **Corner taps made with a mouse in dev** (no panel attached): they must not count towards `touchVerified`, or a developer's `config.json` says verified for a panel nobody tapped. Pinned in Task 7 (`pointerType === 'touch'` guard) and checked manually in Task 10.
5. **A URL the check cannot fetch but the kiosk can load** (`file:`, `data:`, an intranet host down right now): *Check* reports, *Start kiosk* stays enabled. Test in Task 5 (`checkUrl` returns `{ ok:false, error }` for `file:` without throwing) and the button is never disabled in Task 6.

---

## File structure

| File | Responsibility |
|---|---|
| `src/setup-state.js` (new) | `pickDisplay(displays)` and `deriveSteps(inputs)`. Pure. Loaded by the page via `<script>` and by tests via `require` (guarded `module.exports`). |
| `test/setup-state.test.js` (new) | One test per row of the spec's step tables. |
| `src/gesture.js` (new) | `createHoldDetector(opts).feed(contacts, now)`. Pure. |
| `test/gesture.test.js` (new) | Hold, drift, early lift, id churn, re-arm. |
| `src/derive.js` | Adds `deriveAllDevices(devices)`; `deriveFromDevices` becomes a thin wrapper. |
| `test/derive.test.js` | Adds tests for `deriveAllDevices`. |
| `src/touch-agent.js` | `not-configured` status for `null` ids; optional `onGesture` (5th argument) wired to the hold detector. |
| `src/main.js` | `DEFAULTS`; `kiosk:save` learns `touchVerified`, `serialSkipped`, display change recreates the window; `savePanel` resets `touchVerified`; auto display pick at boot; `kiosk:setupInfo`, `kiosk:deriveAll`, `kiosk:checkUrl`; `openSetup()` from `before-input-event` and the gesture. |
| `src/preload.js` | `setupInfo`, `deriveAll`, `checkUrl`. |
| `src/testpage.html` | Checklist markup + renderer; steps 1/2/5 (Task 6), step 3 (Task 7), step 4 + idle return (Task 8). |
| `README.md`, `CLAUDE.md` | Install section, architecture notes, the kiosk→setup path. |

---

### Task 1: `setup-state.js` — step states from facts

**Files:**
- Create: `src/setup-state.js`
- Test: `test/setup-state.test.js`

**Interfaces:**
- Produces: `pickDisplay(displays: Array<{internal:boolean}>) → number|null` — index of the only display, or of the only external one; `null` when ambiguous or empty.
- Produces: `deriveSteps({ config, displays, status, cornersHit }) → { steps: Array<{ id, state, reason }>, active: string|null }` where `id ∈ 'display'|'permission'|'panel'|'serial'|'url'`, `state ∈ 'done'|'active'|'blocked'|'skipped'|'pending'`, `reason` a short machine string the page maps to copy (`'choose'`, `'waiting'`, `'denied'`, `'probably-denied'`, `'unknown'`, `'searching'`, `'verify'`, `'device-busy'`, `'device-error'`, `'input-monitoring'`, `null`).
- `status` is the last touch-agent `status` diag event (`{ state, reason, inputMonitoring }`) or `null` before the first one.

- [ ] **Step 1: Write the failing tests**

```js
// test/setup-state.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { pickDisplay, deriveSteps } = require('../src/setup-state')

const ext = { internal: false }, int = { internal: true }
const states = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.state]))
const reasons = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.reason]))
const open = { state: 'open', reason: null, inputMonitoring: 'granted' }
const base = { displayIndex: 0, hidVendorId: 1, hidProductId: 2, touchReport: {} }

test('pickDisplay: one display → 0, one external among several → its index, else null', () => {
  assert.equal(pickDisplay([int]), 0)
  assert.equal(pickDisplay([int, ext]), 1)
  assert.equal(pickDisplay([ext, ext]), null)
  assert.equal(pickDisplay([int, ext, ext]), null)
  assert.equal(pickDisplay([]), null)
})

test('nothing configured, no status yet: display done, permission waiting', () => {
  const r = deriveSteps({ config: { displayIndex: 0 }, displays: [ext], status: null, cornersHit: 0 })
  assert.deepEqual(states(r), { display: 'done', permission: 'active', panel: 'pending', serial: 'pending', url: 'pending' })
  assert.equal(reasons(r).permission, 'waiting')
  assert.equal(r.active, 'permission')
})

test('display index beyond the list is blocked', () => {
  const r = deriveSteps({ config: { displayIndex: 2 }, displays: [ext], status: null, cornersHit: 0 })
  assert.equal(states(r).display, 'blocked')
  assert.equal(reasons(r).display, 'choose')
})

test('permission denied blocks step 2', () => {
  const status = { state: 'error', reason: 'input-monitoring', inputMonitoring: 'denied' }
  const r = deriveSteps({ config: base, displays: [ext], status, cornersHit: 0 })
  assert.equal(states(r).permission, 'blocked')
  assert.equal(reasons(r).permission, 'denied')
  assert.equal(states(r).panel, 'pending')
})

test('permission unknown alone passes; unknown + panel would not open blocks as probably-denied', () => {
  const nf = { state: 'error', reason: 'not-configured', inputMonitoring: 'unknown' }
  const a = deriveSteps({ config: { displayIndex: 0 }, displays: [ext], status: nf, cornersHit: 0 })
  assert.equal(states(a).permission, 'done')
  assert.equal(reasons(a).permission, 'unknown')
  assert.equal(states(a).panel, 'active')
  const busy = { state: 'error', reason: 'device-busy', inputMonitoring: 'unknown' }
  const b = deriveSteps({ config: base, displays: [ext], status: busy, cornersHit: 0 })
  assert.equal(states(b).permission, 'blocked')
  assert.equal(reasons(b).permission, 'probably-denied')
})

test('panel: not-configured / not-found are searching, device-busy blocks, open needs verification', () => {
  const mk = (reason, state = 'error') => deriveSteps({
    config: base, displays: [ext], status: { state, reason, inputMonitoring: 'granted' }, cornersHit: 0,
  })
  assert.equal(states(mk('not-configured')).panel, 'active'); assert.equal(reasons(mk('not-configured')).panel, 'searching')
  assert.equal(states(mk('not-found')).panel, 'active'); assert.equal(reasons(mk('not-found')).panel, 'searching')
  assert.equal(states(mk('device-busy')).panel, 'blocked'); assert.equal(reasons(mk('device-busy')).panel, 'device-busy')
  assert.equal(states(mk('device-error')).panel, 'blocked')
  assert.equal(states(mk(null, 'open')).panel, 'active'); assert.equal(reasons(mk(null, 'open')).panel, 'verify')
})

test('panel done by five corner taps this session or by touchVerified from config', () => {
  const taps = deriveSteps({ config: base, displays: [ext], status: open, cornersHit: 5 })
  assert.equal(states(taps).panel, 'done')
  const saved = deriveSteps({ config: { ...base, touchVerified: true }, displays: [ext], status: open, cornersHit: 0 })
  assert.equal(states(saved).panel, 'done')
  assert.equal(states(saved).serial, 'active')
})

test('serial: devices → done, serialSkipped → skipped, neither → active', () => {
  const cfg = { ...base, touchVerified: true }
  assert.equal(states(deriveSteps({ config: { ...cfg, serialDevices: [{ vendorId: 1, productId: 1 }] }, displays: [ext], status: open, cornersHit: 0 })).serial, 'done')
  assert.equal(states(deriveSteps({ config: { ...cfg, serialSkipped: true }, displays: [ext], status: open, cornersHit: 0 })).serial, 'skipped')
  assert.equal(states(deriveSteps({ config: cfg, displays: [ext], status: open, cornersHit: 0 })).serial, 'active')
})

test('url set → done; all done → active is null', () => {
  const cfg = { ...base, touchVerified: true, serialSkipped: true, url: 'https://example.org' }
  const r = deriveSteps({ config: cfg, displays: [ext], status: open, cornersHit: 0 })
  assert.deepEqual(states(r), { display: 'done', permission: 'done', panel: 'done', serial: 'skipped', url: 'done' })
  assert.equal(r.active, null)
})

test('diagnostics visit: url set but panel broken → later steps stay done, panel is the active one', () => {
  const cfg = { ...base, touchVerified: true, serialSkipped: true, url: 'https://example.org' }
  const status = { state: 'error', reason: 'not-found', inputMonitoring: 'granted' }
  const r = deriveSteps({ config: cfg, displays: [ext], status, cornersHit: 0 })
  assert.equal(states(r).panel, 'active')
  assert.equal(states(r).url, 'done')
  assert.equal(r.active, 'panel')
})

test('old config: ids set, no touchVerified key → panel asks for the taps once', () => {
  const r = deriveSteps({ config: { displayIndex: 0, hidVendorId: 1111, hidProductId: 26005 }, displays: [ext], status: open, cornersHit: 0 })
  assert.equal(states(r).panel, 'active')
  assert.equal(reasons(r).panel, 'verify')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/setup-state.test.js`
Expected: FAIL — `Cannot find module '../src/setup-state'`

- [ ] **Step 3: Write the module**

```js
// src/setup-state.js
// Pure: the five setup steps and what state each is in, derived from facts
// (config file, the touch agent's last status, the display list, this
// session's corner taps) — never from a stored "current step". That is what
// lets the same checklist serve first-run setup and later diagnostics, and
// survive a relaunch in the middle.
//
// Runs in the test page (plain <script>) and under node --test, hence the
// guarded module.exports at the bottom.

const STEP_IDS = ['display', 'permission', 'panel', 'serial', 'url']

/**
 * Which display to use without asking: the only one, or the only external
 * one (a touchscreen is practically always external). null = ask.
 * @param {Array<{internal?: boolean}>} displays in screen.getAllDisplays() order
 * @returns {number|null}
 */
function pickDisplay(displays) {
  if (!displays || !displays.length) return null
  if (displays.length === 1) return 0
  const external = []
  displays.forEach((d, i) => { if (!d.internal) external.push(i) })
  return external.length === 1 ? external[0] : null
}

// Each step reduces to: done? and if not, is the system saying why it can't
// proceed (a block) or merely what it is doing (a reason for the active card)?
function displayStep(config, displays) {
  const i = config.displayIndex
  const done = Number.isInteger(i) && i >= 0 && i < displays.length
  return { done, block: done ? null : 'choose', reason: done ? null : 'choose' }
}

function permissionStep(status) {
  if (!status) return { done: false, block: null, reason: 'waiting' }
  const perm = status.inputMonitoring
  if (status.state === 'open' || perm === 'granted') return { done: true, block: null, reason: null }
  if (perm === 'denied') return { done: false, block: 'denied', reason: 'denied' }
  // 'unknown' = no keyboard/mouse to probe with. Alone it is no verdict; a
  // panel that is listed but won't open turns it into one.
  if (perm === 'unknown' && status.reason === 'device-busy')
    return { done: false, block: 'probably-denied', reason: 'probably-denied' }
  if (perm === 'unknown') return { done: true, block: null, reason: 'unknown' }
  return { done: false, block: null, reason: 'waiting' }
}

function panelStep(config, status, cornersHit) {
  if (!status) return { done: false, block: null, reason: 'waiting' }
  if (status.state === 'open') {
    const verified = config.touchVerified === true || cornersHit >= 5
    return { done: verified, block: null, reason: verified ? null : 'verify' }
  }
  switch (status.reason) {
    case 'not-configured':
    case 'not-found':
      return { done: false, block: null, reason: 'searching' }
    case 'input-monitoring':
    case 'device-busy':
    case 'device-error':
      return { done: false, block: status.reason, reason: status.reason }
    default:
      return { done: false, block: null, reason: 'waiting' }
  }
}

function serialStep(config) {
  const devices = Array.isArray(config.serialDevices) ? config.serialDevices : []
  if (devices.length) return { done: true, block: null, reason: null }
  if (config.serialSkipped === true) return { done: true, skipped: true, block: null, reason: null }
  return { done: false, block: null, reason: null }
}

function urlStep(config) {
  const done = typeof config.url === 'string' && config.url.trim() !== ''
  return { done, block: null, reason: null }
}

/**
 * @param {object} p
 * @param {object} p.config the config as persisted (or pending) — displayIndex,
 *   hid ids, touchVerified, serialDevices, serialSkipped, url
 * @param {Array<{internal?: boolean}>} p.displays
 * @param {{state:string, reason:string|null, inputMonitoring?:string}|null} p.status
 *   the touch agent's last `status` diag event; null before the first one
 * @param {number} p.cornersHit distinct corner marks hit this session (0..5)
 * @returns {{ steps: Array<{id:string, state:string, reason:string|null}>, active: string|null }}
 */
function deriveSteps({ config = {}, displays = [], status = null, cornersHit = 0 } = {}) {
  const facts = {
    display: displayStep(config, displays),
    permission: permissionStep(status),
    panel: panelStep(config, status, cornersHit),
    serial: serialStep(config),
    url: urlStep(config),
  }
  // The first step that is not done is the active one; later unfinished steps
  // wait. Finished steps *after* the active one stay done — on a diagnostics
  // visit the URL is set even though the panel is the problem.
  let active = null
  const steps = STEP_IDS.map((id) => {
    const f = facts[id]
    let state
    if (f.done) state = f.skipped ? 'skipped' : 'done'
    else if (!active) { active = id; state = f.block ? 'blocked' : 'active' }
    else state = 'pending'
    return { id, state, reason: f.reason }
  })
  return { steps, active }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pickDisplay, deriveSteps, STEP_IDS }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/setup-state.test.js`
Expected: all 11 tests PASS

- [ ] **Step 5: Commit**

Stage `src/setup-state.js test/setup-state.test.js`. Message:

```
feat: derive the setup checklist's step states from facts
```

---

### Task 2: `gesture.js` — five-finger hold detector

**Files:**
- Create: `src/gesture.js`
- Test: `test/gesture.test.js`

**Interfaces:**
- Produces: `createHoldDetector({ fingers = 5, holdMs = 3000, maxDriftPx = 40 }) → { feed(contacts: Array<{id:number,x:number,y:number}>, now: number) → boolean }`. Returns `true` exactly once per hold; re-arms only after the contact count drops below `fingers`.

- [ ] **Step 1: Write the failing tests**

```js
// test/gesture.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHoldDetector } = require('../src/gesture')

const five = (dx = 0, ids = [1, 2, 3, 4, 5]) => ids.map((id, i) => ({ id, x: 100 * i + dx, y: 500 }))

test('five still fingers for holdMs fire once, then not again until released', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000, maxDriftPx: 40 })
  assert.equal(d.feed(five(), 0), false)
  assert.equal(d.feed(five(), 1500), false)
  assert.equal(d.feed(five(), 3000), true)
  assert.equal(d.feed(five(), 3100), false)
  assert.equal(d.feed(five(), 9000), false)
  assert.equal(d.feed([], 9100), false) // release
  assert.equal(d.feed(five(), 9200), false)
  assert.equal(d.feed(five(), 12200), true) // re-armed
})

test('fewer than five fingers never fires', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000 })
  const four = five().slice(0, 4)
  for (let t = 0; t <= 10000; t += 500) assert.equal(d.feed(four, t), false)
})

test('drift beyond maxDriftPx restarts the hold', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000, maxDriftPx: 40 })
  d.feed(five(), 0)
  assert.equal(d.feed(five(60), 1000), false) // moved → restart at 1000
  assert.equal(d.feed(five(60), 3000), false) // only 2000 since the restart
  assert.equal(d.feed(five(60), 4000), true)
})

test('an early lift resets; a changed contact id restarts the hold', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000 })
  d.feed(five(), 0)
  d.feed(five().slice(0, 4), 1000) // one finger lifted
  assert.equal(d.feed(five(), 1100), false)
  assert.equal(d.feed(five(), 3500), false) // 2400 since re-touch
  assert.equal(d.feed(five(), 4100), true)
  const e = createHoldDetector({ fingers: 5, holdMs: 3000 })
  e.feed(five(), 0)
  e.feed(five(0, [1, 2, 3, 4, 6]), 1000) // id 5 renumbered to 6
  assert.equal(e.feed(five(0, [1, 2, 3, 4, 6]), 3000), false)
  assert.equal(e.feed(five(0, [1, 2, 3, 4, 6]), 4000), true)
})

test('more than five fingers count as a hold too', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 1000 })
  const six = five().concat([{ id: 6, x: 900, y: 500 }])
  d.feed(six, 0)
  assert.equal(d.feed(six, 1000), true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/gesture.test.js`
Expected: FAIL — `Cannot find module '../src/gesture'`

- [ ] **Step 3: Write the module**

```js
// src/gesture.js
// Pure: "N fingers held still for a while" — the way back into setup from a
// running kiosk, where there is no keyboard and the page gets no bridge. Fed
// every parsed report from the touch agent (contacts already in viewport
// pixels); fires once per hold and re-arms when the fingers come off.

/**
 * @param {object} [opts]
 * @param {number} [opts.fingers=5]    contacts needed
 * @param {number} [opts.holdMs=3000]  how long they must stay
 * @param {number} [opts.maxDriftPx=40] how far any finger may wander
 */
function createHoldDetector({ fingers = 5, holdMs = 3000, maxDriftPx = 40 } = {}) {
  let start = null // { at, points: Map<id, {x,y}> }
  let fired = false

  const restart = (contacts, now) => {
    start = { at: now, points: new Map(contacts.map((c) => [c.id, { x: c.x, y: c.y }])) }
    fired = false
    return false
  }

  return {
    /**
     * @param {Array<{id:number,x:number,y:number}>} contacts current fingers
     * @param {number} now ms timestamp (Date.now() or a test clock)
     * @returns {boolean} true once, the moment the hold completes
     */
    feed(contacts, now) {
      if (!contacts || contacts.length < fingers) {
        start = null
        fired = false
        return false
      }
      if (!start) return restart(contacts, now)
      // Same fingers, still in place? A renumbered id or a wandering finger is
      // a new attempt, not a continuation.
      for (const c of contacts) {
        const p = start.points.get(c.id)
        if (!p || Math.hypot(c.x - p.x, c.y - p.y) > maxDriftPx) return restart(contacts, now)
      }
      if (fired) return false
      if (now - start.at >= holdMs) {
        fired = true
        return true
      }
      return false
    },
  }
}

module.exports = { createHoldDetector }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/gesture.test.js`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

Stage `src/gesture.js test/gesture.test.js`. Message:

```
feat: detect a five-finger hold as the way back into setup
```

---

### Task 3: `deriveAllDevices` in derive.js

**Files:**
- Modify: `src/derive.js:221-246`
- Test: `test/derive.test.js`

**Interfaces:**
- Produces: `deriveAllDevices(devices) → { hits: Array<{ layout, warnings, vendorId, productId, productName }>, errors: Array<{ vendorId, productId, productName, error: string }> }`. Never throws. `deriveFromDevices` keeps its signature and behaviour (throws when nothing derives, warns when several do).

- [ ] **Step 1: Write the failing tests** (append to `test/derive.test.js`; `sisCollections` and `collections` helpers already exist at the top of that file)

```js
const { deriveAllDevices } = require('../src/derive')

test('deriveAllDevices: every digitizer is a hit, every other device an error, nothing throws', () => {
  const mouse = { vendorId: 1, productId: 1, productName: 'Mouse',
    collections: [{ usagePage: 1, usage: 2, children: [], inputReports: [] }] }
  const flip = { vendorId: 0x25b5, productId: 0x54, productName: 'Flip', collections: sisCollections() }
  const sis = { vendorId: 0x0457, productId: 0x6595, productName: 'SiS', collections: sisCollections() }
  const r = deriveAllDevices([mouse, flip, sis])
  assert.deepEqual(r.hits.map((h) => h.productName), ['Flip', 'SiS'])
  assert.equal(r.hits[0].layout.maxContacts, 5)
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].productName, 'Mouse')
  assert.match(r.errors[0].error, /digitizer|touch/i)
  assert.deepEqual(deriveAllDevices([]), { hits: [], errors: [] })
  assert.deepEqual(deriveAllDevices(undefined), { hits: [], errors: [] })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/derive.test.js`
Expected: FAIL — `deriveAllDevices is not a function`

- [ ] **Step 3: Implement — replace the body of `deriveFromDevices` and export both**

```js
/**
 * Derive a layout for every device that has one. Nothing is thrown: the page
 * lists the hits (one → use it, several → choose) and shows the errors for
 * the rest, so an unknown panel is still diagnosable.
 * @returns {{ hits: Array<object>, errors: Array<{vendorId,productId,productName,error}> }}
 */
function deriveAllDevices(devices) {
  const hits = []
  const errors = []
  for (const d of devices || []) {
    const ident = { vendorId: d.vendorId, productId: d.productId, productName: d.productName || '' }
    try {
      hits.push({ ...deriveTouchReport(d.collections), ...ident })
    } catch (err) {
      errors.push({ ...ident, error: err.message })
    }
  }
  return { hits, errors }
}

function deriveFromDevices(devices) {
  if (!devices || !devices.length) throw new Error('no HID devices visible to WebHID')
  const { hits, errors } = deriveAllDevices(devices)
  if (!hits.length)
    throw new Error(
      `no touch digitizer among ${devices.length} HID device(s):\n` +
        errors.map((e) => `${e.productName || 'device'} ${e.vendorId}:${e.productId} — ${e.error}`).join('\n'),
    )
  if (hits.length > 1)
    hits[0].warnings.push(
      `${hits.length} touch digitizers found — using ${hits[0].productName || hits[0].vendorId + ':' + hits[0].productId}`,
    )
  return hits[0]
}

module.exports = { deriveTouchReport, deriveFromDevices, deriveAllDevices }
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all PASS, including the pre-existing `deriveFromDevices` tests.

- [ ] **Step 5: Commit**

Stage `src/derive.js test/derive.test.js`. Message:

```
feat: derive layouts for every digitizer so the page can list them
```

---

### Task 4: touch-agent — `not-configured` status and the gesture hook

**Files:**
- Modify: `src/touch-agent.js` (`openWithRetry` ~line 203, `toEvent` ~line 173, `device.on('data')` ~line 258, signature line 92)

**Interfaces:**
- Consumes: `createHoldDetector` from Task 2.
- Produces: `startTouchAgent(webContents, config, log, onDiag, onGesture)` — 5th argument optional; when given and `config.maxTouchPoints >= 5`, called with no arguments once per five-finger hold. New status reason `'not-configured'` (`state: 'error'`, with `inputMonitoring` from the probe) when `config.hidVendorId == null || config.hidProductId == null`.

No unit test covers this file (it needs node-hid and a debugger); it is verified in Task 10. Keep the change minimal and mechanical.

- [ ] **Step 1: Require the detector and extend the signature**

At the top, after the `parse` require:

```js
const { createHoldDetector } = require('./gesture')
```

Change the JSDoc and signature:

```js
 * @param {() => void} [onGesture] called once per five-finger hold — the
 *   kiosk's way back into setup. Only created when the panel can report
 *   five contacts; a two-finger panel keeps the keyboard shortcut alone.
 * @returns {{ stop: () => void, rescan: () => void, setRotation: (deg: number) => void }}
 */
function startTouchAgent(webContents, config, log, onDiag, onGesture) {
```

Right after `let rotation = …`:

```js
  const hold =
    onGesture && Number(config.maxTouchPoints) >= 5
      ? createHoldDetector({ fingers: 5, holdMs: 3000, maxDriftPx: 40 })
      : null
```

- [ ] **Step 2: Split `toEvent` so the detector sees the same pixel points**

Replace the start of `toEvent` (the `const cur = contacts.map(...)` block) with a named helper used by both:

```js
  // Rotate first, scale second: the panel's frame is normalized, the
  // viewport's is not, so swapping axes after scaling would stretch them.
  const toPoints = (contacts) =>
    contacts.map((c) => {
      const r = rotate(c.nx, c.ny, rotation)
      return { id: c.id, x: Math.round(r.nx * vp.w), y: Math.round(r.ny * vp.h) }
    })

  const toEvent = (cur) => {
    const curMap = new Map(cur.map((p) => [p.id, p]))
    // … rest of toEvent unchanged (type detection, prev = curMap, refreshViewport, return)
  }
```

And in the data handler:

```js
      const capped = contacts
        .slice()
        .sort((a, b) => a.id - b.id)
        .slice(0, config.maxTouchPoints)
      const pts = toPoints(capped)
      if (hold && hold.feed(pts, Date.now())) {
        log('five-finger hold — opening setup')
        try { onGesture() } catch (err) { error('gesture handler failed:', err.message) }
      }
      const ev = toEvent(pts)
      if (ev) dispatch(ev)
```

- [ ] **Step 3: Add the `not-configured` branch at the top of `openWithRetry`**

Before `const { all, touch } = scanDevices(config)`:

```js
    if (config.hidVendorId == null || config.hidProductId == null) {
      // Nothing to look for yet — the setup page is deriving a panel from
      // WebHID. Still enumerate and probe, so step 2 of the checklist has its
      // permission verdict before a panel is even chosen.
      const all = HID.devices()
      diag('devices', { devices: all.map(summarize) })
      const perm = probePermission(all)
      warn('no touchscreen configured yet', `— input monitoring: ${perm} — waiting`)
      diag('status', {
        state: 'error',
        reason: 'not-configured',
        message: 'no touchscreen configured yet — plug the panel in, the setup page finds it',
        deviceCount: all.length,
        inputMonitoring: perm,
      })
      scheduleRetry()
      return
    }
```

The `warn` text is constant, so the logger collapses the 2 s repeats.

- [ ] **Step 4: Run the suite and start the dev app once**

Run: `npm test` — Expected: PASS (nothing here is unit-tested, this guards against a syntax slip).
Run: `npm start` with the project `config.json` as is — Expected: the test page still shows the panel opening in section 7; nothing else changes yet. Quit with ⌘Q.

- [ ] **Step 5: Commit**

Stage `src/touch-agent.js`. Message:

```
feat: report an unconfigured panel and hook the five-finger hold
```

---

### Task 5: main.js and preload — facts, boot auto-pick, URL check, way back

**Files:**
- Modify: `src/main.js` (requires l.13-18, `DEFAULTS` l.63-73, `createKioskWindow` l.216-380, `setup:chooseDisplay`/`kiosk:save`/`kiosk:savePanel` l.541-597, boot l.693-709)
- Modify: `src/preload.js`
- Create: `src/urlcheck.js`
- Test: `test/urlcheck.test.js` (new, for `checkUrl`'s pure result mapping only)

**Interfaces:**
- Consumes: `pickDisplay` (Task 1), `deriveAllDevices` (Task 3), `onGesture` (Task 4).
- Produces IPC: `kiosk:setupInfo → { config, displays: [{ index, width, height, internal, primary }] }`; `kiosk:deriveAll(devices) → { hits, errors }`; `kiosk:checkUrl(url) → { ok, status?, error?, url }`; `kiosk:save` additionally accepts `touchVerified: boolean`, `serialSkipped: boolean`, and recreates the test window when `displayIndex` changes.
- Produces bridge: `window.lucidKiosk.setupInfo()`, `.deriveAll(devices)`, `.checkUrl(url)`.
- Produces internal: `openSetup()`.

- [ ] **Step 1: Write the failing test for the URL-check result mapping**

The fetch itself needs Electron's `net`; what is testable is the mapping from a response or error to the page's verdict. Put that in a tiny pure helper inside a new file so main.js only calls it.

```js
// test/urlcheck.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { verdictFromResponse, verdictFromError } = require('../src/urlcheck')

test('2xx/3xx/4xx are reachable, 405 asks for a GET retry', () => {
  assert.deepEqual(verdictFromResponse({ status: 200 }), { ok: true, status: 200 })
  assert.deepEqual(verdictFromResponse({ status: 302 }), { ok: true, status: 302 })
  assert.deepEqual(verdictFromResponse({ status: 404 }), { ok: true, status: 404, note: 'reachable, but the server answered 404' })
  assert.deepEqual(verdictFromResponse({ status: 405 }), { retryWithGet: true })
  assert.deepEqual(verdictFromResponse({ status: 503 }), { ok: false, status: 503, error: 'server answered 503' })
})

test('errors are named, timeouts and DNS in words a non-developer can act on', () => {
  assert.deepEqual(verdictFromError({ name: 'TimeoutError' }), { ok: false, error: 'timed out after 5 s' })
  assert.deepEqual(verdictFromError({ name: 'AbortError' }), { ok: false, error: 'timed out after 5 s' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_NAME_NOT_RESOLVED' }), { ok: false, error: 'host name not found (DNS)' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_CONNECTION_REFUSED' }), { ok: false, error: 'connection refused' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_INTERNET_DISCONNECTED' }), { ok: false, error: 'no network' })
  assert.deepEqual(verdictFromError({ message: 'something odd' }), { ok: false, error: 'something odd' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_UNKNOWN_URL_SCHEME' }), { ok: false, error: 'cannot check this kind of URL — the kiosk may still load it' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/urlcheck.test.js`
Expected: FAIL — `Cannot find module '../src/urlcheck'`

- [ ] **Step 3: Write `src/urlcheck.js`**

```js
// src/urlcheck.js
// Pure: turn a fetch outcome into the one-line verdict the URL step shows.
// The fetch lives in main.js (Electron's net); this is the part worth testing.

const ERRORS = [
  ['ERR_NAME_NOT_RESOLVED', 'host name not found (DNS)'],
  ['ERR_CONNECTION_REFUSED', 'connection refused'],
  ['ERR_INTERNET_DISCONNECTED', 'no network'],
  ['ERR_CONNECTION_TIMED_OUT', 'timed out after 5 s'],
  ['ERR_UNKNOWN_URL_SCHEME', 'cannot check this kind of URL — the kiosk may still load it'],
  ['ERR_FILE_NOT_FOUND', 'cannot check this kind of URL — the kiosk may still load it'],
]

function verdictFromResponse(res) {
  const status = res.status
  if (status === 405) return { retryWithGet: true }
  if (status >= 500) return { ok: false, status, error: `server answered ${status}` }
  if (status >= 400) return { ok: true, status, note: `reachable, but the server answered ${status}` }
  return { ok: true, status }
}

function verdictFromError(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { ok: false, error: 'timed out after 5 s' }
  const msg = (err && err.message) || String(err)
  for (const [code, text] of ERRORS) if (msg.includes(code)) return { ok: false, error: text }
  return { ok: false, error: msg }
}

module.exports = { verdictFromResponse, verdictFromError }
```

Run: `node --test test/urlcheck.test.js` — Expected: PASS.

- [ ] **Step 4: main.js — requires and DEFAULTS**

```js
const { app, BrowserWindow, screen, ipcMain, shell, session, net } = require('electron')
// …
const { deriveFromDevices, deriveAllDevices } = require('./derive')
const { pickDisplay } = require('./setup-state')
const { verdictFromResponse, verdictFromError } = require('./urlcheck')
```

```js
const DEFAULTS = {
  url: '', // empty → the built-in setup/test page
  hidVendorId: null, // null = no panel chosen yet; the setup page derives one from WebHID
  hidProductId: null,
  maxTouchPoints: 10,
  allowPageZoom: false,
  displayIndex: 1,
  zoom: 1,
  touchRotation: null, // null = follow the display's rotation; 0|90|180|270 overrides
  touchVerified: false, // the five corner taps landed; reset whenever the panel changes
  serialDevices: [], // [{ vendorId, productId, name }] accepted on the test page
  serialSkipped: false, // operator said "no serial devices" in setup
}
```

- [ ] **Step 5: main.js — the way back, inside `createKioskWindow`**

Add a module-level function near `createKioskWindow`:

```js
// From a running kiosk back into the checklist — a panel swap or a new serial
// device must not require editing config.json. config.url stays set, so a
// restart in the meantime boots into the kiosk, not into setup.
function openSetup() {
  log('setup requested from the kiosk')
  createKioskWindow(pending || loadSeed(), { test: true })
}
```

In `createKioskWindow`, replace the `startAgent` body's first line and add the shortcut:

```js
  // The kiosk page has no bridge, so both ways back are handled here.
  const onGesture = test ? undefined : () => openSetup()
  const startAgent = () => {
    ownAgent = startTouchAgent(wc, agentConfig, touchLog, onDiag, onGesture)
    agent = ownAgent
    setTimeout(() => pageConsole.giveUpWaiting(), 5000)
  }
  if (!test) {
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.meta && input.shift && input.code === 'Comma') {
        e.preventDefault()
        openSetup()
      }
    })
  }
```

- [ ] **Step 6: main.js — IPC changes**

Replace `kiosk:save` wholesale:

```js
ipcMain.handle('kiosk:save', (_e, p = {}) => {
  pending = pending || loadSeed()
  const previousDisplay = pending.displayIndex
  if (typeof p.url === 'string') pending.url = p.url.trim()
  if (p.zoom) pending.zoom = Number(p.zoom) || 1
  if (Number.isInteger(p.displayIndex)) pending.displayIndex = p.displayIndex
  if ('touchRotation' in p) {
    // null puts it back to following the display; a number overrides. Applied
    // to the running agent too, so the operator can try a value and touch the
    // screen straight away instead of relaunching between attempts.
    pending.touchRotation = p.touchRotation == null ? null : Number(p.touchRotation) || 0
    if (agent) agent.setRotation(resolveRotation(pending.touchRotation, displayRotation))
  }
  if (typeof p.touchVerified === 'boolean') pending.touchVerified = p.touchVerified
  if (typeof p.serialSkipped === 'boolean') pending.serialSkipped = p.serialSkipped
  const written = writeConfig(pending)
  log('saved config', written, '·', JSON.stringify({ url: pending.url, zoom: pending.zoom }))
  // A new display means a new window; the setup page comes back on it.
  if (Number.isInteger(p.displayIndex) && p.displayIndex !== previousDisplay)
    createKioskWindow(pending, { test: true })
  return { ok: true, written }
})
```

The spec lists a `kiosk:cancelSerialChooser` IPC. It is not needed: `kiosk:pickSerialPort(null)` already answers the parked chooser with `''` (unknown ids cancel), and Task 8 uses that. No new handler.

In `kiosk:savePanel`, after the `touchReport` line:

```js
  pending.touchVerified = false // a new panel is unverified by definition
```

New handlers, next to `kiosk:deriveLayout`:

```js
ipcMain.handle('kiosk:deriveAll', (_e, devices) => {
  const r = deriveAllDevices(devices)
  if (r.hits.length) log('derived', r.hits.length, 'digitizer layout(s)')
  return r
})

// What the checklist needs to derive its step states: the config as it stands
// and the displays as the OS sees them. Called on load and after every save.
ipcMain.handle('kiosk:setupInfo', () => {
  const primaryId = screen.getPrimaryDisplay().id
  return {
    config: { ...(pending || loadSeed()) },
    displays: screen.getAllDisplays().map((d, index) => ({
      index, width: d.bounds.width, height: d.bounds.height,
      internal: Boolean(d.internal), primary: d.id === primaryId,
    })),
  }
})

// Reachability only — a typo or a dead DNS name should fail here, not as a
// black fullscreen. Never gates Start: an intranet host may be down now and
// fine at boot, and the kiosk's reload-with-backoff covers that.
ipcMain.handle('kiosk:checkUrl', async (_e, raw) => {
  const url = normalizeUrl(raw)
  if (!url) return { ok: false, error: 'no URL', url }
  const attempt = async (method) => {
    const res = await net.fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(5000) })
    const v = verdictFromResponse(res)
    return v.retryWithGet && method === 'HEAD' ? attempt('GET') : v
  }
  try {
    const v = await attempt('HEAD')
    log('url check', url, '→', v.ok ? 'ok ' + v.status : 'failed: ' + v.error)
    return { ...v, url }
  } catch (err) {
    const v = verdictFromError(err)
    log.warn('url check', url, '→', v.error)
    return { ...v, url }
  }
})
```

- [ ] **Step 7: main.js — auto-pick the display at boot**

Replace the `if (!ext) { enterDisplayPicker(); return }` block in `start()`:

```js
    if (!ext) {
      const i = pickDisplay(screen.getAllDisplays())
      if (i == null) {
        enterDisplayPicker()
        return
      }
      log('SETUP — display', i, 'chosen automatically')
      pending = { ...loadSeed(), displayIndex: i }
      writeConfig(pending)
      createKioskWindow(pending, { test: true })
      return
    }
```

- [ ] **Step 8: preload.js — three bridge functions**

```js
  // window 2: everything the checklist derives its step states from
  setupInfo: () => ipcRenderer.invoke('kiosk:setupInfo'),
  // window 2: step 3 — every derivable digitizer, no throw
  deriveAll: (devices) => ipcRenderer.invoke('kiosk:deriveAll', devices),
  // window 2: step 5 — is the URL reachable from here, right now
  checkUrl: (url) => ipcRenderer.invoke('kiosk:checkUrl', url),
```

- [ ] **Step 9: Run tests and a smoke start**

Run: `npm test` — Expected: PASS.
Run: `KIOSK_CONFIG=/tmp/ltk-fresh.json npm start` (a path that does not exist) — Expected: with one external display the test page opens on it without the picker and `/tmp/ltk-fresh.json` appears with `"hidVendorId": null`; with two externals the picker appears. Quit. Remove `/tmp/ltk-fresh.json`.

- [ ] **Step 10: Commit**

Stage `src/main.js src/preload.js src/urlcheck.js test/urlcheck.test.js`. Message:

```
feat: setup facts, boot display auto-pick, URL check, and the way back from the kiosk
```

---

### Task 6: Test page — checklist skeleton with steps 1, 2 and 5

**Files:**
- Modify: `src/testpage.html` (markup l.306-467, script l.470-963)

**Interfaces:**
- Consumes: `deriveSteps` (Task 1, via `<script src="setup-state.js">`), `K.setupInfo()`, `K.checkUrl()`, `K.save()`, `K.launch()`, `K.openInputMonitoring()`, `K.relaunch()`, `onDiag` status events.
- Produces for Tasks 7/8: a renderer `render()` that any step code calls after changing its inputs; shared state `S = { info, status, cornersHit }`; step card elements `#step-display … #step-url` each with `.summary` and `.body`; the hook `onStepActivated(id)` that Tasks 7/8 attach to.

- [ ] **Step 1: Load the pure module and add the checklist markup**

In `<head>`, after the fonts (the file is loaded over `file://`, so a sibling script tag works):

```html
<script src="setup-state.js"></script>
```

Replace the `<p class="lede">` and the whole `<div class="cfgbar">…</div>` with:

```html
  <p class="lede">Plug the touchscreen in and follow the list. Each step ticks itself off.</p>

  <ol class="steps" id="steps">
    <li class="step" id="step-display" data-step="display">
      <div class="head"><span class="mark"></span><span class="title">1 · Display</span><span class="summary"></span>
        <button class="change" data-change="display">Change</button></div>
      <div class="body">
        <p class="dim">The touchscreen's display. Tapping the corners in step 3 confirms it.</p>
        <div id="disp-list"></div>
      </div>
    </li>
    <li class="step" id="step-permission" data-step="permission">
      <div class="head"><span class="mark"></span><span class="title">2 · Permission</span><span class="summary"></span></div>
      <div class="body">
        <p>macOS asks whether this app may <b>monitor input</b>. That is how it reads the touchscreen — click <b>Allow</b>.</p>
        <p class="dim">macOS 14+ also asks about Bluetooth while scanning USB devices. <b>Don't Allow</b> is correct: the panel is USB.</p>
        <div id="perm-blocked" hidden>
          <p class="bad" id="perm-why"></p>
          <p>1. <button id="d-open-im">Open System Settings</button> <span class="dim">enable Lucid Touch Kiosk — if it is not listed, add it with +</span></p>
          <p>2. <button id="d-relaunch" class="primary">Relaunch app</button> <span class="dim">a permission granted while the app is running does not reach it</span></p>
          <details><summary>Still not working?</summary>
            <p class="dim">The grant is tied to the exact binary. After a rebuild, remove the entry in Input Monitoring and add the app again — an entry from an older build does not apply.</p>
          </details>
          <span id="d-act-msg" class="dim"></span>
        </div>
      </div>
    </li>
    <li class="step" id="step-panel" data-step="panel">
      <div class="head"><span class="mark"></span><span class="title">3 · Touch panel</span><span class="summary"></span></div>
      <div class="body" id="panel-body"><!-- Task 7 --></div>
    </li>
    <li class="step" id="step-serial" data-step="serial">
      <div class="head"><span class="mark"></span><span class="title">4 · Serial devices</span><span class="summary"></span>
        <button class="change" data-change="serial">Change</button></div>
      <div class="body" id="serial-body"><!-- Task 8 --></div>
    </li>
    <li class="step" id="step-url" data-step="url">
      <div class="head"><span class="mark"></span><span class="title">5 · URL and start</span><span class="summary"></span>
        <button class="change" data-change="url">Change</button></div>
      <div class="body">
        <div class="cfgbar">
          <label>URL <input id="cfg-url" placeholder="kiosk.example.org/start" /></label>
          <label>Zoom <input id="cfg-zoom" type="number" min="0.5" max="5" step="0.25" value="1" /></label>
          <button id="url-check">Check</button>
          <button id="launch" class="primary">Start kiosk ▶</button>
          <span id="launch-msg" class="dim"></span>
        </div>
      </div>
    </li>
  </ol>
```

The rotation `<select id="cfg-rot">` moves into step 3 in Task 7 — keep its `<label>` block in a `<template id="rot-template">` for now so the existing script that references `cfg-rot` still finds it after Task 7 inserts it. (Until Task 7, wrap the existing `$('cfg-rot')` listener in `if ($('cfg-rot'))`.)

Wrap the existing test `<div class="grid">…</div>` (sections 1–6) in:

```html
  <section id="tryout" hidden>
    <h2>Try it out</h2>
    <div class="grid"> … existing six sections unchanged … </div>
  </section>
```

Remove `<section id="diag">` and `<section id="serial">` entirely; their inner pieces return in Tasks 7 and 8 inside the step bodies. Keep the corner buttons.

- [ ] **Step 2: Styles for the list** (append inside `<style>`; colours only via the existing tokens)

```css
/* --- setup checklist -------------------------------------------------------- */
.steps { list-style: none; margin: 0 0 28px; padding: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.step { border-top: 1px solid var(--line); }
.step:first-child { border-top: 0; }
.step .head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; }
.step .mark { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line); flex: none; }
.step.done .mark, .step.skipped .mark { background: var(--ink); border-color: var(--ink); }
.step.active .mark { border-color: var(--ink); box-shadow: 0 0 0 4px var(--accent); }
.step.blocked .mark { background: var(--bad, #c0392b); border-color: var(--bad, #c0392b); }
.step .title { font-weight: 500; }
.step .summary { color: var(--ink-faint); flex: 1; }
.step .change { margin-left: auto; visibility: hidden; }
.step.done .change, .step.skipped .change { visibility: visible; }
.step .body { display: none; padding: 0 18px 18px 48px; }
.step.active .body, .step.blocked .body, .step.open .body { display: block; }
.step.pending { opacity: .45; }
.primary { background: var(--ink); color: var(--paper); border: 0; }
.bad { color: var(--bad, #c0392b); }
#disp-list button { display: block; margin: 6px 0; }
```

- [ ] **Step 3: Renderer and shared state** — insert at the top of the IIFE, right after `const $ = …` (and move `const K = window.lucidKiosk` up here from its current place further down)

```js
  const K = window.lucidKiosk
  // ---- the checklist ----------------------------------------------------------
  // Everything the step states derive from. Mutate, then render().
  const S = { info: null, status: null, cornersHit: 0, open: null }
  const SUMMARY = {
    display: (st, info) => {
      const d = info && info.displays[info.config.displayIndex]
      return d ? `Display ${d.index} — ${d.width}×${d.height}, ${d.internal ? 'built-in' : 'external'}` : 'choose a display'
    },
    permission: (st) => ({ waiting: 'checking…', denied: 'denied', 'probably-denied': 'probably denied',
      unknown: 'cannot tell yet — the panel will show' }[st.reason] || 'granted'),
    panel: (st) => ({ waiting: 'starting…', searching: 'looking for a touchscreen…', verify: 'panel open — tap the corners',
      'device-busy': 'panel found but busy', 'device-error': 'connection lost', 'input-monitoring': 'blocked by permission' }[st.reason]
      || (S.status && S.status.message) || ''),
    serial: (st, info) => {
      const n = ((info && info.config.serialDevices) || []).length
      return st.state === 'skipped' ? 'no serial devices' : n ? `${n} device model${n > 1 ? 's' : ''} accepted` : 'optional'
    },
    url: (st, info) => (info && info.config.url) || '',
  }
  const activated = new Set() // steps whose onStepActivated already ran this activation
  const stepHooks = {} // id → fn, attached by the step code below
  function render() {
    if (!S.info) return
    const { steps, active } = deriveSteps({ config: S.info.config, displays: S.info.displays, status: S.status, cornersHit: S.cornersHit })
    for (const st of steps) {
      const li = $('step-' + st.id)
      li.className = 'step ' + st.state + (S.open === st.id ? ' open' : '')
      li.querySelector('.summary').textContent = SUMMARY[st.id](st, S.info)
      const isActive = st.state === 'active' || st.state === 'blocked' || S.open === st.id
      if (isActive && !activated.has(st.id)) { activated.add(st.id); if (stepHooks[st.id]) stepHooks[st.id](st) }
      if (!isActive) activated.delete(st.id)
    }
    $('tryout').hidden = !(S.status && S.status.state === 'open')
    document.body.dataset.active = active || 'none'
  }
  async function refreshInfo() { if (K && K.setupInfo) { S.info = await K.setupInfo(); render() } }
  // "Change" on a finished step re-opens its card without undoing anything.
  document.querySelectorAll('.change').forEach((b) => b.addEventListener('click', () => {
    S.open = S.open === b.dataset.change ? null : b.dataset.change; render()
  }))
```

- [ ] **Step 4: Step 1 — display list**

```js
  stepHooks.display = () => {
    const box = $('disp-list'); box.innerHTML = ''
    for (const d of S.info.displays) {
      const b = document.createElement('button')
      b.textContent = `Display ${d.index} — ${d.width}×${d.height} ${d.internal ? 'built-in' : 'external'}${d.primary ? ' (primary)' : ''}`
      if (d.index === S.info.config.displayIndex) b.disabled = true
      // kiosk:save recreates the setup window on the new display; this page goes away.
      b.addEventListener('click', () => K.save({ displayIndex: d.index }))
      box.appendChild(b)
    }
  }
```

- [ ] **Step 5: Step 2 — permission card** — replace the old `d-open-im` / `d-relaunch` / `d-rescan` listeners with:

```js
  const WHY = {
    denied: 'Input Monitoring is denied: the panel is listed, but macOS refuses to let this app read it.',
    'probably-denied': 'The panel is listed but will not open, and there is no keyboard or mouse to test the permission with — most likely Input Monitoring is not granted.',
  }
  stepHooks.permission = (st) => {
    $('perm-blocked').hidden = st.state !== 'blocked'
    $('perm-why').textContent = WHY[st.reason] || ''
  }
  const actMsg = (t) => { $('d-act-msg').textContent = t }
  $('d-open-im').addEventListener('click', () => {
    actMsg('opening System Settings…')
    K.openInputMonitoring().then((r) => actMsg(r && r.ok ? 'System Settings opened — enable this app, then Relaunch.' : 'could not open System Settings: ' + ((r && r.error) || 'unknown')))
  })
  $('d-relaunch').addEventListener('click', () => { actMsg('relaunching…'); K.relaunch() })
```

Keep a module-level `onDiag` as today, but its `status` branch becomes:

```js
    if (ev.type === 'status') { S.status = ev; render() }
```

(The `d-status` / `d-perm` / `d-hint` / `d-actions` lines go; those elements no longer exist. The `config`, `devices`, and `report` branches stay and are rehomed in Task 7 — until then guard them with `if ($('d-layout'))`, `if ($('d-devs'))`, `if ($('d-hex'))`.)

- [ ] **Step 6: Step 5 — URL card** — replace the existing `launch` listener and add the check:

```js
  $('url-check').addEventListener('click', async () => {
    const url = $('cfg-url').value.trim()
    if (!url) return ($('launch-msg').textContent = 'enter a URL first')
    $('launch-msg').textContent = 'checking…'
    const r = await K.checkUrl(url)
    $('launch-msg').textContent = r.ok ? `reachable (${r.status})${r.note ? ' — ' + r.note : ''}` : `not reachable: ${r.error}`
  })
  $('launch').addEventListener('click', () => {
    const url = $('cfg-url').value.trim()
    const zoom = parseFloat($('cfg-zoom').value) || 1
    $('launch-msg').textContent = url ? 'starting ' + url + '…' : 'enter a URL first'
    if (url) K.launch({ url, zoom })
  })
```

*Start kiosk* is never disabled by a failed check (Review Focus 5).

- [ ] **Step 7: Boot the renderer** — at the end of the IIFE, replace `if (K && K.onDiag) K.onDiag(onDiag) else …` with:

```js
  if (K && K.onDiag) { K.onDiag(onDiag); refreshInfo() }
  else { S.info = { config: {}, displays: [] }; document.querySelector('.lede').textContent = '(not running inside the kiosk app — no setup, test targets only)'; $('tryout').hidden = false }
```

Also: the existing `save` wrapper must return the promise so callers can chain `refreshInfo`:

```js
  const save = (partial) => (K && K.save ? K.save(partial) : Promise.resolve())
  $('cfg-zoom').addEventListener('change', () => save({ zoom: parseFloat($('cfg-zoom').value) || 1 }).then(refreshInfo))
  $('cfg-url').addEventListener('change', () => save({ url: $('cfg-url').value.trim() }).then(refreshInfo))
```

Prefill of `cfg-url` / `cfg-zoom` from the query string stays as it is.

- [ ] **Step 8: Run it in dev and check by eye**

Run: `KIOSK_CONFIG=/tmp/ltk-fresh.json npm start`
Expected: the list renders; step 1 done with the display summary; step 2 either done (granted) or blocked with the two buttons; step 3 active with an empty body (Task 7); *Try it out* hidden until the panel opens (it won't yet — no panel configured). Open DevTools from the terminal if needed: `--args --remote-debugging-port=9333` per CLAUDE.md. Quit, remove `/tmp/ltk-fresh.json`.

- [ ] **Step 9: Commit**

Stage `src/testpage.html`. Message:

```
feat: setup page as a self-ticking checklist (display, permission, URL)
```

---

### Task 7: Test page — step 3, auto-detection and corner verification

**Files:**
- Modify: `src/testpage.html` (step 3 body + script)

**Interfaces:**
- Consumes: `K.deriveAll`, `K.savePanel`, `K.dumpDescriptors`, `K.rescan`, `K.save({ touchVerified })`, `K.save({ touchRotation })`, `onDiag` `devices` / `report` / `config` events, `S`, `render`, `stepHooks`.
- Produces: `S.cornersHit` maintained from the corner marks; `touchVerified` saved on 5/5.

- [ ] **Step 1: Step 3 markup** — replace `<!-- Task 7 -->` inside `#panel-body`:

```html
        <p id="p-text"></p>
        <div id="p-candidates"></div>
        <div id="p-verify" hidden>
          <p>Tap the <b>four corners</b> and the <b>centre</b>. <b id="p-count">0</b> / 5</p>
          <div id="p-rot" hidden>
            <p class="bad">A tap landed far from its mark — the panel is probably mounted rotated. Try:</p>
            <label>Touch rotation
              <select id="cfg-rot">
                <option value="auto">Auto (display)</option>
                <option value="0">0°</option><option value="90">90°</option>
                <option value="180">180°</option><option value="270">270°</option>
              </select></label>
          </div>
        </div>
        <div id="p-blocked" hidden>
          <p class="bad" id="p-why"></p>
          <button id="d-rescan">Re-scan now</button>
        </div>
        <div id="p-fail" hidden>
          <p class="bad">A HID device was found but no touch layout could be derived from it:</p>
          <pre id="p-errors"></pre>
          <p><button id="w-dump">Save raw descriptors</button> <span class="dim">then describe <code>touchReport</code> by hand — see the README.</span> <span id="w-msg" class="dim"></span></p>
        </div>
        <details id="p-details">
          <summary>Details — HID devices, live reports, active layout, log</summary>
          <h3>HID devices <span class="dim" id="d-count"></span></h3>
          <table id="d-devs"><tbody></tbody></table>
          <h3>Live reports <span class="dim">— touch the panel</span></h3>
          <div class="dparsed" id="d-parsed">no reports received yet</div>
          <pre id="d-hex">—</pre>
          <p class="dim"><b id="d-rate">0</b> reports/s · <b id="d-seq">0</b> total (display throttled to ~10/s)</p>
          <h3>Active layout</h3>
          <pre id="d-layout">—</pre>
          <p class="dlog">Log: <span id="d-logpath">—</span> <button id="d-openlogs">Open log folder</button></p>
        </details>
```

Delete the `<template id="rot-template">` from Task 6 and the `if ($('cfg-rot'))` guard; the select is real again. The `d-*` guards from Task 6 Step 5 can go too.

- [ ] **Step 2: Auto-detection loop and candidate list** — replace the old `w-detect` / `w-save` listeners (keep `collectHidDevices` and the `w-dump` listener as they are):

```js
  const PANEL_WHY = {
    'device-busy': 'The panel is listed and the permission is fine, but it would not open — something else is holding it. Close any browser with a WebHID connection to it.',
    'device-error': 'The connection dropped after it had been working — usually the cable or a sleeping panel. Reconnecting.',
    'input-monitoring': 'Blocked by Input Monitoring — see step 2.',
  }
  let detectTimer = null, saving = false
  const stopDetecting = () => { clearTimeout(detectTimer); detectTimer = null }
  const idOf = (h) => hex4(h.vendorId) + ':' + hex4(h.productId)
  const usePanel = (h) => {
    if (saving) return
    saving = true
    $('p-text').textContent = 'Saving ' + (h.productName || idOf(h)) + ' — the page reloads with the new panel…'
    // savePanel recreates this window; a rejection is the only case we survive.
    K.savePanel({ hidVendorId: h.vendorId, hidProductId: h.productId, touchReport: h.layout })
      .catch((err) => { saving = false; $('p-text').textContent = 'save failed: ' + err.message })
  }
  async function detectOnce() {
    if (!navigator.hid || !K || !K.deriveAll) return
    let payload
    try { payload = await collectHidDevices() } catch (err) { $('p-text').textContent = 'WebHID error: ' + err.message; return }
    const { hits, errors } = await K.deriveAll(payload)
    const cfg = S.info.config
    const configured = cfg.hidVendorId != null && cfg.hidProductId != null
    const box = $('p-candidates'); box.innerHTML = ''
    $('p-fail').hidden = true
    if (hits.length === 1 && !configured) return usePanel(hits[0]) // the plug-and-play case
    if (hits.length) {
      $('p-text').textContent = hits.length === 1
        ? 'The configured panel is not there, but this one is:'
        : hits.length + ' touchscreens found — which one is it?'
      for (const h of hits) {
        const b = document.createElement('button')
        b.textContent = (h.productName || 'touchscreen') + ' (' + idOf(h) + ')' + (hits.length === 1 ? ' — use this panel instead' : '')
        b.addEventListener('click', () => usePanel(h))
        box.appendChild(b)
      }
      return
    }
    if (payload.length && errors.length) {
      $('p-text').textContent = 'No touchscreen found. Check the USB cable or hub.'
      $('p-fail').hidden = false
      $('p-errors').textContent = errors.map((e) => `${e.productName || 'device'} ${idOf(e)} — ${e.error}`).join('\n')
    } else {
      $('p-text').textContent = 'No touchscreen found. Check the USB cable or hub.'
    }
  }
  const detectLoop = async () => {
    if (!detectTimer) return
    await detectOnce()
    if (detectTimer) detectTimer = setTimeout(detectLoop, 2000)
  }
  stepHooks.panel = () => {} // state-driven below, nothing to do on activation alone
  function renderPanel(st) {
    const open = S.status && S.status.state === 'open'
    $('p-verify').hidden = !open
    $('p-blocked').hidden = st.state !== 'blocked'
    $('p-why').textContent = PANEL_WHY[st.reason] || ''
    const searching = st.reason === 'searching'
    $('p-candidates').hidden = !searching
    if (searching && !detectTimer) { detectTimer = setTimeout(detectLoop, 0) }
    if (!searching) { stopDetecting(); if (open) $('p-text').textContent = S.status.message }
  }
```

Hook it into `render()` from Task 6: after the step loop, add `renderPanel(steps.find((s) => s.id === 'panel'))`.

`$('d-rescan')` keeps its old listener (`K.rescan()`), now inside `#p-blocked`.

- [ ] **Step 3: Corner verification** — replace the corner-mark listener:

```js
  const hitCorners = new Set()
  document.querySelectorAll('.corner').forEach((b) => {
    b.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return // a mouse in dev must not verify a panel nobody tapped
      const r = b.getBoundingClientRect()
      const err = Math.round(Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)))
      b.classList.add('hit')
      b.textContent = b.dataset.c + ' ' + err + 'px'
      if (err > 60) { $('p-rot').hidden = false; return } // landed on the mark's box but far off centre → rotation suspect
      hitCorners.add(b.dataset.c)
      S.cornersHit = hitCorners.size
      $('p-count').textContent = S.cornersHit
      if (S.cornersHit >= 5 && !S.info.config.touchVerified) K.save({ touchVerified: true }).then(refreshInfo)
      render()
    })
  })
```

A tap that misses the mark entirely (lands elsewhere) is the rotation signal too — add a document-level listener: on `pointerup` with `pointerType === 'touch'` while `#p-verify` is visible and the target is not a `.corner`, if the point is within 120 px of any corner mark's centre, show `#p-rot`. Keep it simple:

```js
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || $('p-verify').hidden || e.target.closest('.corner')) return
    const near = [...document.querySelectorAll('.corner')].some((b) => {
      const r = b.getBoundingClientRect()
      return Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < 120
    })
    if (near) $('p-rot').hidden = false
  }, true)
```

The existing `cfg-rot` `change` listener stays (it saves `touchRotation`, applied live by `kiosk:save`); after a rotation change, clear `hitCorners`, reset `S.cornersHit = 0`, the marks' `hit` class and text, and `render()` — the operator taps again under the new rotation.

- [ ] **Step 4: Run in dev with a panel**

Run: `KIOSK_CONFIG=/tmp/ltk-fresh.json npm start` with the SiS or the Flip attached and Input Monitoring granted to the dev Electron.
Expected: step 3 says "looking…", then "Saving …", the page reloads, the panel opens, the corner prompt appears, five touches tick it done, `touchVerified: true` lands in the JSON, step 4 becomes active. Unplug the panel on a second run with the JSON kept: step 3 shows "connection lost", then "looking…" once the agent reports not-found; replug → open again, no taps asked (verified already). Quit, remove the JSON.

- [ ] **Step 5: Commit**

Stage `src/testpage.html`. Message:

```
feat: find the touch panel on its own and verify it with five taps
```

---

### Task 8: Test page — step 4 serial and the idle return

**Files:**
- Modify: `src/testpage.html` (step 4 body + script)

**Interfaces:**
- Consumes: the existing serial script block (`sRenderAccepted`, `sRenderPorts`, `sOpenProbe`, `sCloseProbe`, `K.pickSerialPort`, `K.saveSerialDevice`, `K.removeSerialDevice`, `K.onSerialPorts`), `K.save({ serialSkipped })`, `K.launch`, `S`, `stepHooks`, `refreshInfo`.

- [ ] **Step 1: Step 4 markup** — replace `<!-- Task 8 -->` inside `#serial-body` with the old section 8 contents, minus its `<h2>` and the *Search* button, plus the lead and the skip button:

```html
        <p>Printer, scanner, sensor? <b>Plug it in now</b> — it appears below. Test it, then accept it; the kiosk page may open accepted models without asking.</p>
        <h3>Accepted</h3>
        <ul class="s-list" id="s-accepted"></ul>
        <div id="s-chooser">
          <h3>Available ports <span class="dim">— a device plugged in now appears here</span></h3>
          <ul class="s-list" id="s-ports"></ul>
        </div>
        <div id="s-probe" hidden>
          <h3>Live data — <span id="s-probe-name"></span></h3>
          <label>Baud <select id="s-baud"><!-- the existing option list, moved verbatim from old section 8 --></select></label>
          <pre id="s-data">— scan or send something —</pre>
          <p class="dim"><b id="s-bytes">0</b> bytes received</p>
          <p><button id="s-accept" class="md">Accept device</button> <button id="s-discard" class="md">Discard</button></p>
        </div>
        <p><button id="s-skip">No devices, continue</button> <span id="s-msg" class="dim"></span></p>
```

- [ ] **Step 2: Open the chooser on activation, close it on leaving**

Replace the `s-search` click listener with a function the hook calls, and keep the body identical apart from the first lines:

```js
  let sChooserOpen = false
  async function sOpenChooser() {
    if (!K || !K.pickSerialPort || !navigator.serial || sChooserOpen) return
    sChooserOpen = true
    await sCloseProbe()
    $('s-probe').hidden = true
    $('s-ports').innerHTML = ''
    sMsg('')
    try {
      sPort = await navigator.serial.requestPort()
      sBytes = 0; sText = ''
      $('s-bytes').textContent = '0'
      $('s-data').textContent = '— scan or send something —'
      $('s-probe-name').textContent = (sChosen && (sChosen.displayName || sChosen.portName)) || 'serial port'
      $('s-probe').hidden = false
      sMsg('port open — scan or send something to confirm it is the right device')
      sOpenProbe().catch((err) => sMsg('could not open the port: ' + err.message))
    } catch (err) {
      sPort = null
      if (!(err && err.name === 'NotFoundError')) sMsg('error: ' + (err && err.message))
    } finally {
      sChooserOpen = false
    }
  }
  stepHooks.serial = () => { sOpenChooser() }
  // Leaving the step must not leave Electron's parked chooser callback hanging.
  function sLeave() { if (sChooserOpen && K) K.pickSerialPort(null) }
  $('s-skip').addEventListener('click', () => { sLeave(); K.save({ serialSkipped: true }).then(refreshInfo) })
```

After a successful *Accept* (existing listener), call `refreshInfo()` so step 4 turns done, then `sOpenChooser()` again so a second device can follow. After *Discard*, `sOpenChooser()` again. In `render()` (Task 6), when the serial step is neither active, blocked nor open and `sChooserOpen` is true, call `sLeave()` — add that line right after the step loop: `if (!['active','blocked'].includes(steps.find(s=>s.id==='serial').state) && S.open !== 'serial') sLeave()`.

Remove the old `s-search` and `s-cancel` listeners and elements.

- [ ] **Step 3: Idle return to the kiosk**

Near the end of the IIFE:

```js
  // A technician who opened setup from the kiosk and walked away must not
  // leave the checklist in front of visitors. First-time setup (no URL yet)
  // is never interrupted.
  const IDLE_MS = 10 * 60 * 1000
  let idleTimer = null
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (S.info && S.info.config.url) K.launch({})
    }, IDLE_MS)
  }
  for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, armIdle, true)
  armIdle()
```

`kiosk:launch` with `{}` keeps `pending.url` (it only overrides when `opts.url` is a string) and opens the kiosk.

Also add, for the diagnostics visit, a **Back to kiosk** button in step 5's card: `<button id="back-kiosk" hidden>Back to kiosk</button>` next to *Start kiosk*; in `render()` set `$('back-kiosk').hidden = !(S.info.config.url)`; its listener calls `K.launch({})`.

- [ ] **Step 4: Run in dev**

Run: `npm start` with the project `config.json` (`url` blank, panel configured). Expected: with the panel verified, step 4 is active, the port list is live (plug a USB-serial adapter in: it appears), *Test* opens the probe, *Accept* turns the step done and the list reopens, *No devices, continue* also turns it done; *Change* reopens the card. Set a URL, *Start kiosk*, then press `⌘⇧,` on the kiosk: the checklist is back, all green, with *Back to kiosk*. Wait is impractical for the 10-minute idle — temporarily set `IDLE_MS` to 20 s for one run, confirm the return, set it back.

- [ ] **Step 5: Commit**

Stage `src/testpage.html`. Message:

```
feat: serial devices as a skippable setup step; return to the kiosk when idle
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md` (Install, "Supporting a different touchscreen", serial section)
- Modify: `CLAUDE.md` (Architecture module list, Boot modes, Diagnostics channel, Panel wizard, Invariants, Serial devices)

- [ ] **Step 1: README**

In *Install*, after the `xattr` block, replace the permission paragraphs with:

```markdown
Open the app. It shows a five-step checklist on the touchscreen's display and
ticks the steps off as they are satisfied:

1. **Display** — chosen automatically when there is one external display.
2. **Permission** — macOS asks for *Input Monitoring*; click **Allow**. If you
   missed it: **Open System Settings**, enable the app, then **Relaunch app**
   (a grant does not reach a running app). The Bluetooth prompt may be
   declined — the panel is USB.
3. **Touch panel** — found and profiled on its own from its HID descriptor.
   Tap the four corners and the centre to confirm it (and the display, and the
   mounting rotation).
4. **Serial devices** — optional. Plug in a printer or scanner, **Test**,
   **Accept**. Or **No devices, continue**.
5. **URL and start** — type the URL, **Check** it, **Start kiosk**.

To get back into the checklist from the running kiosk: press **⌘⇧,** or hold
**five fingers** still on the screen for three seconds (panels that report
five or more contacts). After ten minutes without input the kiosk returns on
its own.
```

Under *Supporting a different touchscreen*, replace the wizard paragraph's first sentence with: "Step 3 of the checklist derives `hidVendorId`/`hidProductId` and `touchReport` from the panel's WebHID report descriptor on its own; when several touchscreens are connected it asks which." Keep the manual table.

In the serial section, replace "An operator accepts device models once, on the test page (*8 · Serial devices*)" with "… in step 4 of the checklist".

Document the new config keys in the config table: `touchVerified`, `serialSkipped`, and that `hidVendorId`/`hidProductId` default to `null`.

- [ ] **Step 2: CLAUDE.md**

- Module list: add `src/setup-state.js` (pure; step states from facts; runs in the page and in tests), `src/gesture.js` (pure; five-finger hold), `src/urlcheck.js` (pure; fetch outcome → verdict). Commands line: `npm test` now also covers them.
- *Boot modes*: "no external config → `pickDisplay` chooses the only (external) display and opens the checklist there; the display-picker window only appears when that is ambiguous."
- *Diagnostics channel*: new reason `not-configured`; `startTouchAgent` takes a 5th argument `onGesture`, passed only in kiosk mode and only acted on when `maxTouchPoints >= 5`.
- *Panel wizard* → rename to *Panel detection*: step 3 polls `kiosk:deriveAll` every 2 s while the agent reports `not-configured`/`not-found`; auto-saves only when no panel is configured; `savePanel` resets `touchVerified`.
- *Invariants*: add "`DEFAULTS.hidVendorId/hidProductId` are `null`; a config with ids but no `touchReport` still falls back to `SIS_LAYOUT`." and "The kiosk→setup path (`openSetup`) goes through `createKioskWindow`, so the window-count and agent-pairing invariants hold; `config.url` is never cleared by it."
- *Serial devices*: the chooser opens when step 4 activates and is cancelled with `pickSerialPort(null)` when the step is left.
- *Running the app for testing*: the kiosk shortcut `⌘⇧,`.

- [ ] **Step 3: Commit**

Stage `README.md CLAUDE.md`. Message:

```
docs: describe the setup checklist and the way back from the kiosk
```

---

### Task 10: Packaged verification

**Files:** none (hand-over to Tob; the build runs here).

- [ ] **Step 1: Build**

Run: `npm run dist` then `xattr -dr com.apple.quarantine "dist/mac-arm64/Lucid Touch Kiosk.app"`.

- [ ] **Step 2: Reset the machine state for a first run**

Remove `dist/mac-arm64/config.json` if present. In *System Settings → Privacy & Security → Input Monitoring*, remove the *Lucid Touch Kiosk* entry. Clear `dist/mac-arm64/logs/kiosk.log`.

- [ ] **Step 3: Hand over with the checklist below** (Tob runs it; a shell launch would skew TCC)

```bash
open -n "dist/mac-arm64/Lucid Touch Kiosk.app"
```

| # | Do | Expect |
|---|---|---|
| 1 | First launch, one external display, panel attached | Checklist on the external display, step 1 done, macOS prompt over step 2 |
| 2 | Click *Don't Allow* | Step 2 blocked, two buttons; *Open System Settings* lands in Input Monitoring |
| 3 | Enable the app, *Relaunch app* | Step 2 done; step 3 "Saving …", reload, "tap the corners" |
| 4 | Tap TL, TR, BL, BR, centre | 5 / 5, step 3 done, `touchVerified: true` in `dist/mac-arm64/config.json`, *Try it out* visible |
| 5 | *No devices, continue* | Step 4 skipped; step 5 active |
| 6 | Type a bogus host, *Check* | "not reachable: host name not found (DNS)", *Start kiosk* still enabled |
| 7 | Type the real URL, *Check*, *Start kiosk* | Kiosk page fullscreen, touch works |
| 8 | On the kiosk: hold five fingers still 3 s | Checklist back, all green, *Back to kiosk* |
| 9 | `⌘⇧,` on the kiosk (keyboard attached) | Same |
| 10 | Unplug the panel while in the checklist | Step 3 "connection lost" → "looking for a touchscreen…"; replug → open, no taps asked |
| 11 | Plug a USB-serial adapter in during step 4 (*Change* on step 4) | Appears in the list; *Test* shows bytes; *Accept* → step done, log line `serial accepted` |
| 12 | Copy an old `config.json` (SiS ids, no `touchReport`, no new keys, a URL) beside the app, relaunch | Boots into the kiosk; touch works; `⌘⇧,` → step 3 asks for the taps once |
| 13 | `grep -c "no touchscreen configured yet" dist/mac-arm64/logs/kiosk.log` after run 1 | A single line with a repeat count, not one line per 2 s |

- [ ] **Step 4: Record outcomes**

Any row that fails goes back to the owning task; nothing is "done" until the table is green on the packaged build.
