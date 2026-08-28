// Layout-driven HID touch-report parser.
//
// The layout describes where the per-contact fields sit in a report. Defaults
// match the SiS HID Touch Controller (report 0x91: up to 5 contacts, 80-bit
// stride; per contact: tip switch @ bit 0, contact id @ bit 8, X @ bit 16,
// Y @ bit 32, both 16-bit with logical range 0..4095). For a different panel,
// set a `touchReport` block in config.json — the panel wizard on the test page
// derives one from the device's own report descriptor. An optional logicalMaxY
// overrides the Y full-scale when the axes differ.
//
// node-hid prepends the report id to the buffer for devices with numbered
// reports, so offsets are taken against the payload AFTER that leading byte.

const SIS_LAYOUT = {
  reportId: 0x91, // 0/null = report has no id (read from byte 0)
  maxContacts: 5,
  strideBits: 80, // bit distance between consecutive contact blocks
  tipOffset: 0, // tip-switch bit, within a contact block
  contactIdOffset: 8, // contact-id field (null → use the contact index)
  contactIdBits: 8,
  xOffset: 16,
  yOffset: 32,
  coordBits: 16,
  logicalMax: 4095, // full-scale X value (and Y, unless logicalMaxY is set)
}

/** Read `bits` bits at absolute `bitOffset`, LSB-first (HID report order). */
function readBits(buf, bitOffset, bits) {
  let value = 0
  for (let i = 0; i < bits; i++) {
    const absBit = bitOffset + i
    const byteIndex = absBit >> 3
    if (byteIndex >= buf.length) break
    // `value |= bit << i` is a 32-bit signed bitwise op — JS shifts wrap
    // their amount modulo 32, so once `i` reaches 32 this doesn't just read
    // "too much", it aliases bit 32 back onto bit 0 and silently corrupts
    // the value. Callers must keep `bits` <= MAX_FIELD_BITS (see below).
    value |= ((buf[byteIndex] >> (absBit & 7)) & 1) << i
  }
  return value >>> 0
}

// touchReport may now come from the panel wizard (src/derive.js) or a
// hand-edit rather than a careful human, so parseContacts validates it
// before looping instead of trusting numbers the panel reported about
// itself. Bounds mirror the ones enforced at derivation time: generous
// next to a real Windows-Precision-style digitizer (~10 contacts, a few
// hundred bits of stride), tight enough to reject a corrupt/nonsensical
// layout before looping over it.
const MAX_FIELD_BITS = 32 // see readBits' comment above — a hard correctness bound, not just a sanity one
const MAX_CONTACTS = 64
const MAX_STRIDE_BITS = 8192 // 1KB per contact block; also derive.js's report-width ceiling

/** True when `layout` is plausible enough to loop over without risking a hang or a corrupted read. */
function isSaneLayout(layout) {
  if (!layout || typeof layout !== 'object') return false
  const maxContacts = layout.maxContacts
  const strideBits = layout.strideBits
  const coordBits = layout.coordBits
  const contactIdBits = layout.contactIdBits == null ? 8 : layout.contactIdBits
  if (!(maxContacts > 0) || maxContacts > MAX_CONTACTS) return false
  if (!(strideBits > 0) || strideBits > MAX_STRIDE_BITS) return false
  if (!(coordBits > 0) || coordBits > MAX_FIELD_BITS) return false
  if (!(contactIdBits > 0) || contactIdBits > MAX_FIELD_BITS) return false
  return true
}

/**
 * Parse a raw node-hid buffer into the active contacts using `layout`.
 * @param {Buffer} buf full report buffer (buf[0] is the report id if numbered)
 * @param {object} [layout] touch-report layout (defaults to SiS)
 * @returns {Array<{id:number,nx:number,ny:number}>|null}
 */
function parseContacts(buf, layout = SIS_LAYOUT) {
  if (!buf || buf.length === 0) return null
  if (!isSaneLayout(layout)) return null
  let payload
  if (layout.reportId) {
    if (buf[0] !== layout.reportId) return null
    payload = buf.subarray(1)
  } else {
    payload = buf
  }
  const max = layout.logicalMax || 1
  const maxY = layout.logicalMaxY || max
  const contacts = []
  for (let i = 0; i < layout.maxContacts; i++) {
    const base = i * layout.strideBits
    if (readBits(payload, base + layout.tipOffset, 1) !== 1) continue
    contacts.push({
      id:
        layout.contactIdOffset != null
          ? readBits(payload, base + layout.contactIdOffset, layout.contactIdBits || 8)
          : i,
      nx: readBits(payload, base + layout.xOffset, layout.coordBits) / max,
      ny: readBits(payload, base + layout.yOffset, layout.coordBits) / maxY,
    })
  }
  return contacts
}

/**
 * Turn a normalized contact from the panel's frame into the screen's.
 *
 * A panel mounted sideways — or a display rotated in macOS while the panel
 * keeps reporting in its native orientation — needs this before the contact is
 * scaled to the viewport. Rotation is a property of the installation, not of
 * the report layout, which is why it lives outside `touchReport`.
 *
 * Anything other than 0/90/180/270 is treated as 0: a kiosk that maps touches
 * to the wrong place is easier to diagnose than one that mangles them by an
 * arbitrary angle, and the aspect ratio makes non-right angles meaningless in
 * normalized space anyway.
 *
 * @param {number} nx 0..1 along the panel's X axis
 * @param {number} ny 0..1 along the panel's Y axis
 * @param {number} [deg] 0 | 90 | 180 | 270, clockwise
 * @returns {{nx: number, ny: number}}
 */
function rotate(nx, ny, deg) {
  switch (deg) {
    case 90:
      return { nx: 1 - ny, ny: nx }
    case 180:
      return { nx: 1 - nx, ny: 1 - ny }
    case 270:
      return { nx: ny, ny: 1 - nx }
    default:
      return { nx, ny }
  }
}

const ROTATIONS = [0, 90, 180, 270]

/**
 * Decide the mounting rotation: an explicit config value wins, otherwise
 * follow the display.
 *
 * A touchscreen's digitizer is bonded to the panel, so it reports in the
 * panel's unrotated frame no matter what the OS does with the image. Rotating
 * the display therefore always calls for the same rotation on the touch side,
 * and the OS already knows the angle — asking the operator for it would be
 * asking for something we can read. The override exists for the case the rule
 * doesn't cover: a separate touch foil mounted turned relative to its display.
 *
 * @param {number|null|undefined} configured `touchRotation` from config.json
 * @param {number} [displayRotation] degrees reported by the OS for the display
 * @returns {number} 0 | 90 | 180 | 270
 */
function resolveRotation(configured, displayRotation) {
  if (ROTATIONS.includes(configured)) return configured
  return ROTATIONS.includes(displayRotation) ? displayRotation : 0
}

module.exports = { SIS_LAYOUT, readBits, parseContacts, rotate, resolveRotation }
