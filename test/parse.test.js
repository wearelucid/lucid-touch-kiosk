const test = require('node:test')
const assert = require('node:assert/strict')
const { parseContacts, rotate, resolveRotation, SIS_LAYOUT } = require('../src/parse')

// Build a SiS-format report buffer: report id 0x91, then per contact 80 bits:
// tip @0, contact id @8 (8b), X @16 (16b LE), Y @32 (16b LE), rest zero.
function sisReport(contacts) {
  const buf = Buffer.alloc(1 + 5 * 10) // id + 5 contacts x 80 bits
  buf[0] = 0x91
  contacts.forEach((c, i) => {
    const base = 1 + i * 10
    buf[base] = 0x01 // tip down
    buf[base + 1] = c.id
    buf.writeUInt16LE(c.x, base + 2)
    buf.writeUInt16LE(c.y, base + 4)
  })
  return buf
}

test('parses a SiS report with the default layout', () => {
  const out = parseContacts(sisReport([{ id: 3, x: 2048, y: 1024 }]))
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 3)
  assert.ok(Math.abs(out[0].nx - 2048 / 4095) < 1e-9)
  assert.ok(Math.abs(out[0].ny - 1024 / 4095) < 1e-9)
})

test('rejects a foreign report id', () => {
  const buf = sisReport([{ id: 0, x: 1, y: 1 }])
  buf[0] = 0x42
  assert.equal(parseContacts(buf), null)
})

test('logicalMaxY normalizes Y independently when set', () => {
  const layout = { ...SIS_LAYOUT, logicalMax: 4095, logicalMaxY: 8191 }
  const out = parseContacts(sisReport([{ id: 0, x: 4095, y: 8191 }]), layout)
  assert.ok(Math.abs(out[0].nx - 1) < 1e-9)
  assert.ok(Math.abs(out[0].ny - 1) < 1e-9)
})

// A touchReport may now come from the panel wizard (src/derive.js) or a
// hand-edit rather than a careful human, so parseContacts must validate it
// before looping instead of trusting numbers the panel reported about itself.

test('absurd maxContacts returns null instead of looping', () => {
  const layout = { ...SIS_LAYOUT, maxContacts: 100000 }
  assert.equal(parseContacts(sisReport([{ id: 0, x: 1, y: 1 }]), layout), null)
})

test('coordBits beyond what readBits can represent returns null', () => {
  // readBits accumulates with `value |= bit << i`, a 32-bit signed op — a
  // width above 32 wraps the shift amount modulo 32 and corrupts the value,
  // so this must be rejected outright rather than read incorrectly.
  const layout = { ...SIS_LAYOUT, coordBits: 40 }
  assert.equal(parseContacts(sisReport([{ id: 0, x: 1, y: 1 }]), layout), null)
})

test('absurd strideBits returns null', () => {
  const layout = { ...SIS_LAYOUT, strideBits: 100000000 }
  assert.equal(parseContacts(sisReport([{ id: 0, x: 1, y: 1 }]), layout), null)
})

// A panel mounted at 90° reports coordinates in its own frame, so the contact
// has to be turned back before it is scaled to the viewport. Corners are the
// only points worth pinning — they catch a wrong direction, which the centre
// (invariant under every rotation) never would.
test('rotate leaves contacts untouched at 0°', () => {
  assert.deepEqual(rotate(0.25, 0.75, 0), { nx: 0.25, ny: 0.75 })
})

test('rotate turns the corners the right way at 90°', () => {
  // panel top-left → screen bottom-left, panel bottom-left → screen top-left
  assert.deepEqual(rotate(0, 0, 90), { nx: 1, ny: 0 })
  assert.deepEqual(rotate(1, 0, 90), { nx: 1, ny: 1 })
  assert.deepEqual(rotate(1, 1, 90), { nx: 0, ny: 1 })
  assert.deepEqual(rotate(0, 1, 90), { nx: 0, ny: 0 })
})

test('rotate flips both axes at 180°', () => {
  assert.deepEqual(rotate(0, 0, 180), { nx: 1, ny: 1 })
  assert.deepEqual(rotate(0.25, 0.75, 180), { nx: 0.75, ny: 0.25 })
})

test('rotate at 270° is the inverse of 90°', () => {
  for (const [x, y] of [[0, 0], [1, 0], [0.25, 0.75]]) {
    const r = rotate(x, y, 90)
    assert.deepEqual(rotate(r.nx, r.ny, 270), { nx: x, ny: y })
  }
})

test('an unusable rotation is ignored rather than mangling every touch', () => {
  assert.deepEqual(rotate(0.25, 0.75, 45), { nx: 0.25, ny: 0.75 })
  assert.deepEqual(rotate(0.25, 0.75, undefined), { nx: 0.25, ny: 0.75 })
})

// The digitizer of a touchscreen is bonded to the panel, so its axes always
// follow the panel's unrotated orientation. When macOS rotates the display,
// the touch has to come back by the same amount — which the OS already knows,
// so the default is to follow it rather than ask the operator.
test('resolveRotation follows the display when nothing is configured', () => {
  assert.equal(resolveRotation(null, 90), 90)
  assert.equal(resolveRotation(undefined, 270), 270)
})

test('resolveRotation lets an explicit value win, including 0', () => {
  assert.equal(resolveRotation(0, 90), 0)
  assert.equal(resolveRotation(180, 90), 180)
})

test('resolveRotation falls back to 0 for unusable input', () => {
  assert.equal(resolveRotation(null, undefined), 0)
  assert.equal(resolveRotation('nonsense', 90), 90)
})
