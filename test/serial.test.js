const test = require('node:test')
const assert = require('node:assert/strict')
const {
  originOf,
  sameDevice,
  pickAcceptedPort,
  serialAllowed,
  addDevice,
  removeDevice,
} = require('../src/serial')

// Electron reports serial ids as decimal strings ('3118'); config.json and the
// page's port.getInfo() use numbers. Every comparison has to survive that.
const HONEYWELL = { vendorId: 3118, productId: 3480, name: 'Honeywell scanner' }
const port = (id, vendorId, productId) => ({ portId: id, portName: id, vendorId, productId })

test('originOf maps file: pages to file:// (URL gives the string "null")', () => {
  assert.equal(originOf('file:///Users/x/testpage.html'), 'file://')
  assert.equal(originOf('https://tbf.ch/explore?x=1'), 'https://tbf.ch')
  assert.equal(originOf('http://10.10.1.231:3004/explore'), 'http://10.10.1.231:3004')
  assert.equal(originOf('not a url'), '')
  assert.equal(originOf(''), '')
})

test('sameDevice matches string ids against numeric ones', () => {
  assert.ok(sameDevice({ vendorId: '3118', productId: '3480' }, HONEYWELL))
  assert.ok(!sameDevice({ vendorId: '3118', productId: '1' }, HONEYWELL))
})

test('the device handler shape (snake_case, measured) matches too', () => {
  // setDevicePermissionHandler hands serial devices over as
  // { vendor_id: 3118, product_id: 4116, ... } — not the camelCase strings
  // select-serial-port uses. Missing this made getPorts() empty and open() fail
  // on the kiosk page for an accepted device.
  const fromHandler = { name: '7680GSR', vendor_id: 3118, product_id: 4116, serial_number: '25316B1107' }
  const accepted = { vendorId: 3118, productId: 4116, name: '7680GSR' }
  assert.ok(sameDevice(fromHandler, accepted))
  assert.ok(serialAllowed({ origin: 'https://tbf.ch', kioskOrigin: 'https://tbf.ch', device: fromHandler, devices: [accepted] }))
})

test('a port without USB ids (e.g. Bluetooth) never matches', () => {
  assert.ok(!sameDevice({ vendorId: undefined, productId: undefined }, HONEYWELL))
  assert.ok(!sameDevice({}, {}))
})

test('pickAcceptedPort takes the first accepted port and ignores the rest', () => {
  const list = [port('bt', undefined, undefined), port('other', '1', '2'), port('scan', '3118', '3480')]
  assert.equal(pickAcceptedPort(list, [HONEYWELL]), 'scan')
})

test('pickAcceptedPort returns "" (Electron: cancel) when nothing is accepted', () => {
  assert.equal(pickAcceptedPort([port('other', '1', '2')], [HONEYWELL]), '')
  assert.equal(pickAcceptedPort([port('scan', '3118', '3480')], []), '')
  assert.equal(pickAcceptedPort([], [HONEYWELL]), '')
})

test('serialAllowed: accepted device, configured kiosk origin', () => {
  const base = { device: { vendorId: '3118', productId: '3480' }, devices: [HONEYWELL] }
  assert.ok(serialAllowed({ ...base, origin: 'https://tbf.ch', kioskOrigin: 'https://tbf.ch' }))
  assert.ok(!serialAllowed({ ...base, origin: 'https://evil.example', kioskOrigin: 'https://tbf.ch' }))
})

test('serialAllowed: the bundled test page may open any port — before it is accepted', () => {
  // The operator tests a port on the test page *before* accepting it. Measured:
  // with the device handler refusing, open() fails with "Failed to open serial
  // port" even though the page's own chooser just returned that port.
  const base = { device: { vendorId: '1', productId: '2' }, devices: [] }
  assert.ok(serialAllowed({ ...base, origin: 'file://', kioskOrigin: '' }))
  // Electron's permission-check handler reports the same page as "file:///"
  // (measured) — both spellings are the bundled page.
  assert.ok(serialAllowed({ ...base, origin: 'file:///', kioskOrigin: '' }))
})

test('serialAllowed: the kiosk page gets only accepted devices', () => {
  const base = { device: { vendorId: '1', productId: '2' }, devices: [HONEYWELL] }
  assert.ok(!serialAllowed({ ...base, origin: 'https://tbf.ch', kioskOrigin: 'https://tbf.ch' }))
})

test('serialAllowed: no kiosk url means only the test page qualifies', () => {
  const base = { device: { vendorId: '3118', productId: '3480' }, devices: [HONEYWELL] }
  assert.ok(!serialAllowed({ ...base, origin: 'https://tbf.ch', kioskOrigin: '' }))
})

test('addDevice keeps one entry per model and updates its name', () => {
  const once = addDevice([], HONEYWELL)
  const twice = addDevice(once, { vendorId: '3118', productId: '3480', name: 'renamed' })
  assert.equal(twice.length, 1)
  assert.equal(twice[0].name, 'renamed')
  assert.deepEqual(addDevice(once, { vendorId: 1, productId: 2, name: 'x' }).length, 2)
})

test('addDevice stores numbers, whatever it was given', () => {
  const [d] = addDevice([], { vendorId: '3118', productId: '3480', name: 'x' })
  assert.equal(d.vendorId, 3118)
  assert.equal(d.productId, 3480)
})

test('removeDevice drops the model and leaves others', () => {
  const list = addDevice(addDevice([], HONEYWELL), { vendorId: 1, productId: 2, name: 'x' })
  const out = removeDevice(list, { vendorId: '3118', productId: '3480' })
  assert.equal(out.length, 1)
  assert.equal(out[0].vendorId, 1)
})
