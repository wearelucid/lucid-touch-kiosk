const test = require('node:test')
const assert = require('node:assert/strict')
const { parseContacts, SIS_LAYOUT } = require('../src/parse')

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
