// Which serial devices a page may use. Pure data-in/data-out — no Electron —
// so the rules that decide device access are unit-tested rather than trusted.
//
// Chrome asks the user every time a page calls navigator.serial.requestPort().
// A kiosk has nobody to ask, so an operator accepts devices once on the test
// page instead; those land in config.json as `serialDevices` and are granted
// silently afterwards — to the configured kiosk URL's origin and nothing else.
//
// Devices are identified by USB vendor/product id, deliberately not by serial
// number: config.json travels with the kiosk folder, and a replacement unit of
// the same model should work without setting it up again.

/** Origin of a URL, with file: pages mapped to "file://" (URL reports "null"). */
function originOf(url) {
  if (typeof url !== 'string' || !url) return ''
  if (url.startsWith('file:')) return 'file://'
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

// Electron reports ids as decimal strings, config.json and port.getInfo() use
// numbers; a port with no USB ids (Bluetooth, built-in) must never match.
const idOf = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v))

// Electron describes the same port in two shapes: select-serial-port gives
// { vendorId: '3118', productId: '4116' }, setDevicePermissionHandler gives
// { vendor_id: 3118, product_id: 4116 } (both measured). Read either.
const vendorOf = (d) => idOf(d && (d.vendorId ?? d.vendor_id))
const productOf = (d) => idOf(d && (d.productId ?? d.product_id))

/** Same USB model? Tolerates string vs number ids and both Electron shapes. */
function sameDevice(a, b) {
  const av = vendorOf(a)
  const ap = productOf(a)
  return Number.isFinite(av) && Number.isFinite(ap) && av === vendorOf(b) && ap === productOf(b)
}

/** Is this the app's own bundled page (test page)? */
const isBundled = (origin) => typeof origin === 'string' && origin.startsWith('file:')

const isAccepted = (port, devices) => (devices || []).some((d) => sameDevice(port, d))

/**
 * Answer to Electron's select-serial-port for the kiosk page: the first port
 * that was accepted, or "" — which Electron treats as the user cancelling.
 * @param {Array<{portId: string, vendorId?: string, productId?: string}>} portList
 */
function pickAcceptedPort(portList, devices) {
  const hit = (portList || []).find((p) => isAccepted(p, devices))
  return hit ? hit.portId : ''
}

/**
 * May `origin` use this serial device?
 *
 * The bundled test page may open any port: it is our own code, and it only
 * ever opens the port the operator just picked in its chooser — which happens
 * *before* the device is accepted, so requiring acceptance here would make the
 * test impossible (measured: open() then fails with "Failed to open serial
 * port"). Electron spells that origin both "file://" and "file:///".
 *
 * The kiosk page gets accepted devices only, and only on the configured URL's
 * origin: the kiosk may navigate elsewhere (a link, a redirect), and pages
 * there must not inherit hardware access.
 */
function serialAllowed({ origin, device, kioskOrigin, devices }) {
  if (isBundled(origin)) return true
  return Boolean(kioskOrigin) && origin === kioskOrigin && isAccepted(device, devices)
}

const normalize = (d) => ({
  vendorId: vendorOf(d),
  productId: productOf(d),
  name: String(d.name || '').trim() || 'Serial device',
})

/** Accept a device model; re-accepting the same model just updates its name. */
function addDevice(devices, device) {
  const next = normalize(device)
  return [...(devices || []).filter((d) => !sameDevice(d, next)), next]
}

/** Forget a device model. */
function removeDevice(devices, device) {
  return (devices || []).filter((d) => !sameDevice(d, device))
}

module.exports = { originOf, isBundled, sameDevice, pickAcceptedPort, serialAllowed, addDevice, removeDevice }
