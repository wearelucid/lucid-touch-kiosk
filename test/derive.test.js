const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveTouchReport, deriveFromDevices } = require('../src/derive')
const { parseContacts } = require('../src/parse')

// One SiS-like contact block, 80 bits: tip@0(1), pad(7), id@8(8), X@16(16),
// Y@32(16), pad(32). Usages are 32-bit (usagePage << 16) | usageId.
const TIP = 0x000d0042, CID = 0x000d0051, X = 0x00010030, Y = 0x00010031
const contactItems = (xMax = 4095, yMax = 4095) => [
  { reportSize: 1, reportCount: 1, usages: [TIP], logicalMinimum: 0, logicalMaximum: 1 },
  { reportSize: 7, reportCount: 1, isConstant: true, usages: [] },
  { reportSize: 8, reportCount: 1, usages: [CID], logicalMinimum: 0, logicalMaximum: 255 },
  { reportSize: 16, reportCount: 1, usages: [X], logicalMinimum: 0, logicalMaximum: xMax },
  { reportSize: 16, reportCount: 1, usages: [Y], logicalMinimum: 0, logicalMaximum: yMax },
  { reportSize: 16, reportCount: 2, isConstant: true, usages: [] },
]
const collections = (items, reportId = 0x91) => [
  { usagePage: 0x0d, usage: 0x04, children: [], inputReports: [{ reportId, items }] },
]
const sisCollections = () =>
  collections(Array.from({ length: 5 }, () => contactItems()).flat())

test('derives the SiS layout from a SiS-shaped descriptor', () => {
  const { layout, warnings } = deriveTouchReport(sisCollections())
  assert.deepEqual(layout, {
    reportId: 0x91,
    maxContacts: 5,
    strideBits: 80,
    tipOffset: 0,
    contactIdOffset: 8,
    contactIdBits: 8,
    xOffset: 16,
    yOffset: 32,
    coordBits: 16,
    logicalMax: 4095,
  })
  assert.deepEqual(warnings, [])
})

test('round-trip: a report parsed with the derived layout yields the touch', () => {
  const { layout } = deriveTouchReport(sisCollections())
  const buf = Buffer.alloc(1 + 5 * 10)
  buf[0] = 0x91
  buf[1] = 0x01 // tip
  buf[2] = 2 // contact id
  buf.writeUInt16LE(2048, 3)
  buf.writeUInt16LE(1024, 5)
  const out = parseContacts(buf, layout)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 2)
  assert.ok(Math.abs(out[0].nx - 2048 / 4095) < 1e-9)
  assert.ok(Math.abs(out[0].ny - 1024 / 4095) < 1e-9)
})

test('differing X/Y logical ranges set logicalMaxY', () => {
  const items = Array.from({ length: 2 }, () => contactItems(4095, 8191)).flat()
  const { layout } = deriveTouchReport(collections(items))
  assert.equal(layout.logicalMax, 4095)
  assert.equal(layout.logicalMaxY, 8191)
})

test('nested collections are searched', () => {
  const wrapped = [{ usagePage: 1, usage: 0, inputReports: [], children: sisCollections() }]
  assert.equal(deriveTouchReport(wrapped).layout.reportId, 0x91)
})

test('missing Contact ID falls back to block index with a warning', () => {
  const items = Array.from({ length: 2 }, () => [
    { reportSize: 1, reportCount: 1, usages: [TIP], logicalMaximum: 1 },
    { reportSize: 7, reportCount: 1, isConstant: true, usages: [] },
    { reportSize: 16, reportCount: 1, usages: [X], logicalMaximum: 4095 },
    { reportSize: 16, reportCount: 1, usages: [Y], logicalMaximum: 4095 },
  ]).flat()
  const { layout, warnings } = deriveTouchReport(collections(items))
  assert.equal(layout.contactIdOffset, null)
  assert.ok(warnings.some((w) => /Contact ID/i.test(w)))
})

test('non-uniform stride is rejected with a clear error', () => {
  const items = [
    ...contactItems(),
    { reportSize: 8, reportCount: 1, isConstant: true, usages: [] }, // extra pad → block 2 shifted
    ...contactItems(),
  ]
  assert.throws(() => deriveTouchReport(collections(items)), /strided/)
})

test('a descriptor without a touch report is rejected', () => {
  const mouse = [{ usagePage: 1, usage: 2, children: [], inputReports: [{ reportId: 1, items: [
    { reportSize: 8, reportCount: 3, usages: [X, Y], logicalMinimum: -127, logicalMaximum: 127 },
  ] }] }]
  assert.throws(() => deriveTouchReport(mouse), /no input report/i)
})

test('deriveFromDevices picks the digitizer among mixed devices', () => {
  const out = deriveFromDevices([
    { vendorId: 1, productId: 1, productName: 'Some Keyboard', collections: [] },
    { vendorId: 0x0457, productId: 0x6595, productName: 'SiS HID Touch', collections: sisCollections() },
  ])
  assert.equal(out.vendorId, 0x0457)
  assert.equal(out.layout.maxContacts, 5)
})

test('deriveFromDevices with no devices throws', () => {
  assert.throws(() => deriveFromDevices([]), /no HID devices/i)
})

test('missing X logicalMaximum is rejected, not silently coerced to 1', () => {
  // xMax=0 stands in for "the descriptor's X item never carried a
  // logicalMaximum" — flattenReport can't tell the two apart, and neither
  // is usable as a divisor.
  const items = Array.from({ length: 5 }, () => contactItems(0, 4095)).flat()
  assert.throws(() => deriveTouchReport(collections(items)), /X axis|logicalMaximum/i)
})

test('missing Y logicalMaximum is rejected, not silently falling back to X', () => {
  const items = Array.from({ length: 5 }, () => contactItems(4095, 0)).flat()
  assert.throws(() => deriveTouchReport(collections(items)), /Y axis|logicalMaximum/i)
})

test('single-contact descriptor derives a layout that round-trips a real report', () => {
  // Exactly one contact block: stride has nothing to diff against, so
  // toKioskLayout falls back to totalBits. Pin the observable behaviour
  // (a report parses correctly), not the internal strideBits number.
  const items = contactItems()
  const { layout } = deriveTouchReport(collections(items))
  assert.equal(layout.maxContacts, 1)
  const buf = Buffer.alloc(1 + 10)
  buf[0] = 0x91
  buf[1] = 0x01 // tip
  buf[2] = 7 // contact id
  buf.writeUInt16LE(1000, 3)
  buf.writeUInt16LE(2000, 5)
  const out = parseContacts(buf, layout)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 7)
  assert.ok(Math.abs(out[0].nx - 1000 / 4095) < 1e-9)
  assert.ok(Math.abs(out[0].ny - 2000 / 4095) < 1e-9)
})

test('trailing Contact Count / Scan Time fields are tolerated', () => {
  const CONTACT_COUNT = 0x000d0054, SCAN_TIME = 0x000d0056
  const items = [
    ...Array.from({ length: 5 }, () => contactItems()).flat(),
    { reportSize: 8, reportCount: 1, usages: [CONTACT_COUNT], logicalMinimum: 0, logicalMaximum: 5 },
    { reportSize: 16, reportCount: 1, usages: [SCAN_TIME], logicalMinimum: 0, logicalMaximum: 65535 },
  ]
  const { layout } = deriveTouchReport(collections(items))
  assert.equal(layout.maxContacts, 5)
  assert.equal(layout.strideBits, 80)
})

// These numbers come straight off the attached device — a corrupt or
// unusual descriptor must be rejected with a clear reason, not hang
// flattenReport's loops. See src/derive.js's MAX_* constants for the
// reasoning behind each threshold.

test('oversized reportSize is rejected', () => {
  // A single field wider than 32 bits can never be represented correctly by
  // parse.js's readBits (see its 32-bit-shift comment), regardless of how
  // generous the other limits are.
  const items = [{ reportSize: 999, reportCount: 1, usages: [TIP], logicalMaximum: 1 }]
  assert.throws(() => deriveTouchReport(collections(items)), /reportSize/i)
})

test('oversized reportCount is rejected', () => {
  const items = [{ reportSize: 1, reportCount: 1000000, usages: [TIP], logicalMaximum: 1 }]
  assert.throws(() => deriveTouchReport(collections(items)), /reportCount/i)
})

test('absurd accumulated report width is rejected even when no single item is oversized', () => {
  // Each item's reportCount (100) is individually plausible; only the sum
  // across many such items is absurd. Guards the accumulated width, not
  // just each item in isolation.
  const items = Array.from({ length: 100 }, () => ({ reportSize: 32, reportCount: 100, usages: [] }))
  assert.throws(() => deriveTouchReport(collections(items)), /bits/i)
})

test('SiS-shaped descriptor still derives unchanged under the new bounds', () => {
  const { layout, warnings } = deriveTouchReport(sisCollections())
  assert.deepEqual(layout, {
    reportId: 0x91,
    maxContacts: 5,
    strideBits: 80,
    tipOffset: 0,
    contactIdOffset: 8,
    contactIdBits: 8,
    xOffset: 16,
    yOffset: 32,
    coordBits: 16,
    logicalMax: 4095,
  })
  assert.deepEqual(warnings, [])
})

test('round-trip: contact-ID-less layout falls back to block index at parse time', () => {
  // derive.js emits contactIdOffset: null when a descriptor has no Contact
  // ID field; parse.js is supposed to fall back to the block index. This is
  // the path likely to execute for real on an unknown panel tomorrow, so it
  // needs an end-to-end test, not just a unit check of the derived layout.
  const items = Array.from({ length: 3 }, () => [
    { reportSize: 1, reportCount: 1, usages: [TIP], logicalMaximum: 1 },
    { reportSize: 7, reportCount: 1, isConstant: true, usages: [] },
    { reportSize: 16, reportCount: 1, usages: [X], logicalMaximum: 4095 },
    { reportSize: 16, reportCount: 1, usages: [Y], logicalMaximum: 4095 },
  ]).flat()
  const { layout } = deriveTouchReport(collections(items))
  assert.equal(layout.contactIdOffset, null)
  assert.equal(layout.maxContacts, 3)

  const buf = Buffer.alloc(1 + (3 * layout.strideBits) / 8)
  buf[0] = 0x91
  for (let i = 0; i < 3; i++) {
    const blockBit = i * layout.strideBits
    buf[1 + (blockBit + layout.tipOffset) / 8] = 0x01 // tip down
    buf.writeUInt16LE(1000 + i, 1 + (blockBit + layout.xOffset) / 8)
    buf.writeUInt16LE(2000 + i, 1 + (blockBit + layout.yOffset) / 8)
  }
  const out = parseContacts(buf, layout)
  assert.equal(out.length, 3)
  out.forEach((c, i) => {
    assert.equal(c.id, i)
    assert.ok(Math.abs(out[i].nx - (1000 + i) / 4095) < 1e-9)
  })
})
