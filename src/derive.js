// Derive the kiosk's `touchReport` config block from a WebHID report
// descriptor (`device.collections`). Pure data-in/data-out — no Electron, no
// DOM — so it runs in the main process and under `node --test` alike.
//
// Groups the descriptor's fields into per-contact blocks, then converts them
// to the uniform-stride layout parse.js consumes. Panels whose contact blocks are
// not evenly strided cannot be expressed in that model and are rejected —
// a hand-written touchReport in config.json remains the escape hatch.

// 32-bit usage = (usagePage << 16) | usageId
const USAGE_X = 0x00010030 // Generic Desktop / X
const USAGE_Y = 0x00010031 // Generic Desktop / Y
const USAGE_TIP_SWITCH = 0x000d0042 // Digitizers / Tip Switch
const USAGE_CONTACT_ID = 0x000d0051 // Digitizers / Contact Identifier

// The numbers below drive loops over data the *device* reports about
// itself (via WebHID), not a human typing careful values into config.json.
// A corrupt or unusual descriptor must be rejected with a clear reason
// instead of hanging flattenReport's loops (single-threaded main process —
// a hang here freezes the whole app). Each bound is generous next to a
// real touch digitizer and tight enough to catch nonsense.

// parse.js's readBits accumulates a field's bits via `value |= bit << i`, a
// 32-bit signed bitwise op. JS shifts wrap their amount modulo 32, so a
// width above 32 doesn't just read "too much" — it aliases bit 32 back onto
// bit 0 and silently corrupts the value. No single field may claim more
// bits than that, regardless of how generous the other limits are.
const MAX_FIELD_BITS = 32

// reportCount is the repeat of one field *within a single HID item* (a
// padding/reserved run, or an array of like usages) — not the number of
// contacts, which shows up as repeated items instead (see contactItems()
// in the tests: every real field has reportCount 1). Even a generous
// padding item rarely exceeds a couple of dozen. 128 leaves ~5x headroom
// over anything a real descriptor does, while still catching a corrupted
// or device-confused count.
const MAX_REPORT_COUNT = 128

// Total accumulated width of one input report. A 10-contact Windows-
// Precision-style digitizer (tip + contact id + X + Y + pressure/width/
// height per contact, plus trailing Contact Count and Scan Time fields)
// comes to roughly 800-1000 bits (~100-125 bytes). 8192 bits (1KB) is
// ~8x that: generous headroom for panels with extra fields, but far below
// what it would take to actually stall flattenReport's loop.
const MAX_REPORT_BITS = 8192

// Expressed as a contact count (rather than only bits) so a nonsense
// descriptor is rejected with a clearer message. Comfortably above the
// ~10 contacts of any real panel; also keeps a derived layout within the
// bound parse.js enforces on maxContacts at runtime (see src/parse.js),
// so the wizard never hands off a layout that parse.js would then reject.
const MAX_CONTACTS = 64

/**
 * Expand one report's items into a flat field list with absolute bit offsets.
 * Also returns the report's total bit width, used to confirm the derived
 * stride actually accounts for every bit (see toKioskLayout).
 */
function flattenReport(report) {
  const fields = []
  let bit = 0
  for (const item of report.items || []) {
    const count = item.reportCount || 0
    const size = item.reportSize || 0
    if (size > MAX_FIELD_BITS)
      throw new Error(`field reportSize ${size} exceeds the ${MAX_FIELD_BITS}-bit limit — descriptor looks corrupt`)
    if (count > MAX_REPORT_COUNT)
      throw new Error(`field reportCount ${count} exceeds the ${MAX_REPORT_COUNT} sanity limit — descriptor looks corrupt`)
    const usages = item.usages || []
    const usageMin = item.usageMinimum || 0
    for (let i = 0; i < count; i++) {
      fields.push({
        bit,
        bits: size,
        // padding items carry no usages; guard the lookup rather than throw
        usage: item.isRange ? usageMin + i : usages[Math.min(i, usages.length - 1)] || 0,
        logicalMin: item.logicalMinimum || 0,
        logicalMax: item.logicalMaximum || 0,
      })
      bit += size
      // Guard the *accumulated* width too: many items each under the
      // per-item reportCount cap can still add up to an absurd report.
      if (bit > MAX_REPORT_BITS)
        throw new Error(`report width ${bit} bits exceeds the ${MAX_REPORT_BITS}-bits sanity limit — descriptor looks corrupt`)
    }
  }
  return { fields, totalBits: bit }
}

function collectInputReports(collections) {
  const reports = []
  const visit = (c) => {
    for (const r of c.inputReports || []) reports.push(r)
    for (const child of c.children || []) visit(child)
  }
  for (const c of collections || []) visit(c)
  return reports
}

/** Group fields into per-contact blocks — each Tip Switch opens a new one. */
function groupContacts(fields) {
  const contacts = []
  let cur = null
  const flush = () => {
    if (cur && cur.x != null && cur.y != null) contacts.push(cur)
  }
  for (const f of fields) {
    if (f.usage === USAGE_TIP_SWITCH) {
      flush()
      cur = { tip: f.bit }
    } else if (cur && f.usage === USAGE_CONTACT_ID && cur.id == null) {
      cur.id = f.bit
      cur.idBits = f.bits
    } else if (cur && f.usage === USAGE_X && cur.x == null) {
      cur.x = f.bit
      cur.xBits = f.bits
      cur.xMin = f.logicalMin
      cur.xMax = f.logicalMax
    } else if (cur && f.usage === USAGE_Y && cur.y == null) {
      cur.y = f.bit
      cur.yBits = f.bits
      cur.yMin = f.logicalMin
      cur.yMax = f.logicalMax
    }
  }
  flush()
  return contacts
}

/** Convert per-contact blocks into parse.js's uniform-stride layout. */
function toKioskLayout(reportId, contacts, totalBits) {
  const warnings = []
  if (contacts.length > MAX_CONTACTS)
    throw new Error(`${contacts.length} contacts found — exceeds the ${MAX_CONTACTS}-contact sanity limit for a touch digitizer`)
  const c0 = contacts[0]
  if (c0.xBits !== c0.yBits)
    throw new Error(`X is ${c0.xBits}-bit but Y is ${c0.yBits}-bit — parse.js expects equal coordBits`)
  // A single contact has nothing to diff a stride against — it spans the
  // whole report by definition.
  const stride = contacts.length > 1 ? contacts[1].tip - c0.tip : totalBits
  contacts.forEach((c, i) => {
    const off = i * stride
    const idMoved = c0.id != null && c.id !== c0.id + off
    if (c.tip !== c0.tip + off || c.x !== c0.x + off || c.y !== c0.y + off || idMoved)
      throw new Error('contact blocks are not evenly strided — this panel needs a hand-written touchReport')
  })
  // Two contacts alone can't disprove a bogus stride (nothing contradicts
  // it), so also check the contact blocks actually fit inside the report —
  // catches e.g. padding wedged between two otherwise-uniform blocks. This
  // must stay a `>` (fit check), not `!==` (exact match): real Windows-
  // Precision-style digitizers routinely append Contact Count (0x000D0054)
  // and Scan Time (0x000D0056) fields AFTER the last contact block, so
  // totalBits legitimately exceeds strideBits * maxContacts. Rejecting
  // those trailing fields would reject exactly the standard panels this
  // wizard exists to support — do not "tighten" this back to equality.
  if (stride * contacts.length > totalBits)
    throw new Error('contact blocks are not evenly strided — this panel needs a hand-written touchReport')
  // A descriptor with no (or zero) logicalMaximum can't be told apart from
  // one that genuinely reports 0 — either way there's no usable full-scale
  // value to divide by. parse.js does `raw / logicalMax`, so silently
  // falling back to 1 here sends every touch far outside 0..1 with nothing
  // in the logs to explain it. Reject instead: the operator needs to know
  // the descriptor is incomplete so a hand-written touchReport is the way out.
  if (!c0.xMax)
    throw new Error(
      'X axis has no usable logicalMaximum in this descriptor — cannot derive a touchReport; set one by hand in config.json',
    )
  // Y gets the same treatment, but only for a genuinely missing/zero value.
  // When X and Y report the same logicalMaximum, parse.js's own fallback
  // (logicalMaxY || logicalMax) already does the right thing, so that case
  // deliberately does NOT set logicalMaxY below — it is not "missing", it's
  // "equal", and must stay silent rather than becoming a rejection.
  if (!c0.yMax)
    throw new Error(
      'Y axis has no usable logicalMaximum in this descriptor — cannot derive a touchReport; set one by hand in config.json',
    )
  if (c0.xMin || c0.yMin)
    warnings.push(`logical minimum is ${c0.xMin}/${c0.yMin} but parse.js assumes 0 — coordinates will be offset`)
  if (c0.id == null) warnings.push('no Contact ID field — contact ids fall back to the block index')
  const layout = {
    reportId,
    maxContacts: contacts.length,
    strideBits: stride,
    tipOffset: c0.tip,
    contactIdOffset: c0.id != null ? c0.id : null,
    contactIdBits: c0.id != null ? c0.idBits : 8,
    xOffset: c0.x,
    yOffset: c0.y,
    coordBits: c0.xBits,
    logicalMax: c0.xMax,
  }
  if (c0.yMax !== c0.xMax) layout.logicalMaxY = c0.yMax
  return { layout, warnings }
}

/**
 * Derive a parse.js layout from one device's collections.
 * @returns {{ layout: object, warnings: string[] }}
 * @throws {Error} when no touch report is found, or none fits the model.
 */
function deriveTouchReport(collections) {
  let lastErr = 'no input report with Tip Switch + X + Y — not a touch digitizer?'
  for (const report of collectInputReports(collections)) {
    const { fields, totalBits } = flattenReport(report)
    const contacts = groupContacts(fields)
    if (!contacts.length) continue
    try {
      return toKioskLayout(report.reportId || 0, contacts, totalBits)
    } catch (err) {
      lastErr = err.message // a touch report, but not expressible — keep looking
    }
  }
  throw new Error(lastErr)
}

/**
 * Try every WebHID device until one yields a touch layout.
 * @param {Array<{vendorId:number,productId:number,productName?:string,collections:Array}>} devices
 * @returns {{ layout: object, warnings: string[], vendorId: number, productId: number, productName: string }}
 */
function deriveFromDevices(devices) {
  if (!devices || !devices.length) throw new Error('no HID devices visible to WebHID')
  const errors = []
  const hits = []
  for (const d of devices) {
    try {
      hits.push({
        ...deriveTouchReport(d.collections),
        vendorId: d.vendorId,
        productId: d.productId,
        productName: d.productName || '',
      })
    } catch (err) {
      errors.push(`${d.productName || 'device'} ${d.vendorId}:${d.productId} — ${err.message}`)
    }
  }
  if (!hits.length)
    throw new Error(`no touch digitizer among ${devices.length} HID device(s):\n${errors.join('\n')}`)
  if (hits.length > 1)
    hits[0].warnings.push(
      `${hits.length} touch digitizers found — using ${hits[0].productName || hits[0].vendorId + ':' + hits[0].productId}`,
    )
  return hits[0]
}

module.exports = { deriveTouchReport, deriveFromDevices }
