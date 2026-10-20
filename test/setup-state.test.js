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
