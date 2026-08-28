// Reads the USB HID touchscreen (node-hid) and injects REAL touch into the
// Electron window's webContents via the in-process DevTools Protocol
// (webContents.debugger), so the events are trusted and the page behaves as it
// would on a real touch device.

const HID = require('node-hid')
const { parseContacts, rotate, SIS_LAYOUT } = require('./parse')

// Injected on every document: block page pinch-zoom + rubber-band bounce while
// keeping scroll AND in-site multitouch (touch events still reach the page).
const TAME_GESTURES_SRC =
  "(function(){function a(){try{" +
  "var els=[document.documentElement,document.body];" +
  "for(var i=0;i<els.length;i++){var e=els[i];if(!e)continue;" +
  "e.style.setProperty('touch-action','pan-x pan-y','important');" +
  "e.style.setProperty('overscroll-behavior','none','important');}" +
  "}catch(e){}}a();document.addEventListener('DOMContentLoaded',a);})()"

/** Diagnostic: list every HID device so an operator can find vid/pid/usage. */
function listDevices(log) {
  log('--- HID devices (DIAGNOSE) ---')
  for (const d of HID.devices()) {
    log(
      `  0x${(d.vendorId || 0).toString(16)}:0x${(d.productId || 0).toString(16)}`,
      `usage ${(d.usagePage || 0).toString(16)}/${(d.usage || 0).toString(16)}`,
      `${d.manufacturer || ''} ${d.product || ''}`.trim(),
    )
  }
  log('--- end HID devices ---')
}

/**
 * Enumerate HID devices and pick the configured touchscreen.
 * Returns the full list too, so the diagnostics view can show what macOS sees.
 */
function scanDevices(config) {
  const all = HID.devices()
  const matches = all.filter(
    (d) => d.vendorId === config.hidVendorId && d.productId === config.hidProductId,
  )
  // Prefer the digitizer touchscreen interface (usage page 0x0D, usage 0x04).
  const touch =
    matches.find((d) => d.usagePage === 0x0d && d.usage === 0x04) || matches[0] || null
  return { all, matches, touch }
}

/**
 * Is Input Monitoring granted? macOS lets any process *enumerate* HID devices
 * without it — HID.devices() returns a full list either way — but *opening* one
 * requires the grant. So the only honest test is to open something harmless:
 * a keyboard or mouse, closed again immediately. Failing that is a global
 * denial, not a problem with the touchscreen.
 * @returns {'granted'|'denied'|'unknown'}
 */
function probePermission(all) {
  const refs = all.filter((d) => d.usagePage === 1 && (d.usage === 6 || d.usage === 2))
  if (!refs.length) return 'unknown' // nothing safe to test with
  for (const d of refs) {
    try {
      new HID.HID(d.path).close()
      return 'granted'
    } catch {
      /* try the next reference device */
    }
  }
  return 'denied'
}

const hex4 = (n) => (n || 0).toString(16).padStart(4, '0')

/** Strip a HID.devices() entry down to what the diagnostics table shows. */
const summarize = (d) => ({
  vendorId: d.vendorId || 0,
  productId: d.productId || 0,
  usagePage: d.usagePage || 0,
  usage: d.usage || 0,
  name: `${d.manufacturer || ''} ${d.product || ''}`.trim(),
})

// Live report events are throttled before crossing IPC: a panel emits >100/s
// while touched, and flooding the channel would add latency to the very touch
// path being measured. ~10/s is plenty to read along.
const REPORT_THROTTLE_MS = 100

/**
 * Start driving `webContents` from the touchscreen.
 * @param {(ev: object) => void} [onDiag] receives diagnostics events
 *   (`config` | `devices` | `status` | `report`). Only wired up for the test
 *   page; in kiosk mode it is undefined and nothing is collected.
 * @returns {{ stop: () => void }}
 */
function startTouchAgent(webContents, config, log, onDiag) {
  if (process.env.DIAGNOSE) listDevices(log)
  // Touch-report layout: config.touchReport if present, else the SiS default.
  const layout = config.touchReport || undefined
  let rotation = Number(config.touchRotation) || 0
  log('touch layout:', layout ? 'from config.touchReport' : 'built-in SiS default')
  if (rotation) log('touch rotation:', rotation + '°')

  const diag = onDiag
    ? (type, data) => {
        try {
          onDiag({ type, ...data })
        } catch {
          /* renderer gone */
        }
      }
    : () => {}

  diag('config', {
    vendorId: config.hidVendorId,
    productId: config.hidProductId,
    maxTouchPoints: config.maxTouchPoints,
    layout: layout || SIS_LAYOUT,
    layoutSource: layout ? 'config.touchReport' : 'built-in SiS default',
  })

  const dbg = webContents.debugger
  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
  } catch (err) {
    log('debugger attach failed:', err.message)
  }
  const send = (method, params) => dbg.sendCommand(method, params)

  let stopped = false
  let device = null
  let prev = new Map()
  let vp = { w: 1920, h: 1080 }
  let reportSeq = 0
  let lastReportAt = 0
  let retryTimer = null

  // Retries are cancellable so the "Re-scan" button can jump the 2s queue.
  const scheduleRetry = () => {
    clearTimeout(retryTimer)
    retryTimer = setTimeout(openWithRetry, 2000)
  }

  // Reports are forwarded even when parseContacts() rejects them (null = the
  // report id did not match the layout). That case is the whole point: bytes
  // arriving + nothing parsed means the panel works and the layout is wrong.
  const emitReport = (buf, contacts) => {
    reportSeq++
    if (!onDiag) return
    const now = Date.now()
    if (now - lastReportAt < REPORT_THROTTLE_MS) return
    lastReportAt = now
    diag('report', {
      seq: reportSeq,
      len: buf.length,
      hex: buf.subarray(0, 64).toString('hex'),
      contacts: contacts
        ? contacts.map((c) => ({ id: c.id, nx: +c.nx.toFixed(4), ny: +c.ny.toFixed(4) }))
        : null,
    })
  }

  const refreshViewport = async () => {
    try {
      const { result } = await send('Runtime.evaluate', {
        expression: '({w:innerWidth,h:innerHeight})',
        returnByValue: true,
      })
      if (result && result.value && result.value.w) vp = result.value
    } catch {
      /* navigating; keep last */
    }
  }

  // Fire-and-forget, in order (the smoothness fix) — let Chromium rAF-coalesce.
  const dispatch = (ev) => {
    send('Input.dispatchTouchEvent', ev).catch(() => {})
  }

  const toEvent = (contacts) => {
    const cur = contacts.map((c) => {
      // Rotate first, scale second: the panel's frame is normalized, the
      // viewport's is not, so swapping axes after scaling would stretch them.
      const r = rotate(c.nx, c.ny, rotation)
      return { id: c.id, x: Math.round(r.nx * vp.w), y: Math.round(r.ny * vp.h) }
    })
    const curMap = new Map(cur.map((p) => [p.id, p]))
    let type = null
    if (cur.some((p) => !prev.has(p.id))) type = 'touchStart'
    else if ([...prev.keys()].some((id) => !curMap.has(id))) type = 'touchEnd'
    else if (
      cur.some((p) => {
        const pp = prev.get(p.id)
        return pp.x !== p.x || pp.y !== p.y
      })
    )
      type = 'touchMove'
    prev = curMap
    if (!type) return null
    if (type === 'touchStart') void refreshViewport()
    return { type, touchPoints: cur.map((p) => ({ x: p.x, y: p.y, id: p.id })) }
  }

  const openWithRetry = () => {
    if (stopped) return
    const { all, touch } = scanDevices(config)
    diag('devices', { devices: all.map(summarize) })

    if (!touch) {
      // Enumeration is unaffected by Input Monitoring, so a missing panel here
      // really is a missing panel — but report the permission anyway, so the
      // next problem is already on screen once the cable is sorted out.
      const perm = probePermission(all)
      const message = `touchscreen not found (VID 0x${hex4(config.hidVendorId)} PID 0x${hex4(config.hidProductId)})`
      log(message, `— input monitoring: ${perm} — retrying`)
      diag('status', {
        state: 'error',
        reason: 'not-found',
        message,
        deviceCount: all.length,
        inputMonitoring: perm,
      })
      scheduleRetry()
      return
    }

    try {
      log('opening', touch.product || 'device')
      device = new HID.HID(touch.path)
    } catch (err) {
      // The panel is listed but won't open. Probe a reference device to tell a
      // global permission denial apart from something holding this one device.
      const perm = probePermission(all)
      const reason = perm === 'denied' ? 'input-monitoring' : 'device-busy'
      const message =
        perm === 'denied'
          ? 'Input Monitoring is not granted — the panel is connected but macOS blocks reading it'
          : `found the panel but could not open it: ${err.message}`
      log(message, `— input monitoring: ${perm} — retrying`)
      diag('status', {
        state: 'error',
        reason,
        message,
        deviceCount: all.length,
        inputMonitoring: perm,
      })
      scheduleRetry()
      return
    }

    log('connected — touch the screen')
    diag('status', {
      state: 'open',
      reason: null,
      message: `panel ${hex4(config.hidVendorId)}:${hex4(config.hidProductId)} open${touch.product ? ' — ' + touch.product : ''}`,
      deviceCount: all.length,
      inputMonitoring: 'granted', // opening succeeded — that *is* the proof
    })

    device.on('data', (buf) => {
      const contacts = parseContacts(buf, layout)
      emitReport(buf, contacts)
      if (contacts === null) return
      const capped = contacts
        .slice()
        .sort((a, b) => a.id - b.id)
        .slice(0, config.maxTouchPoints)
      const ev = toEvent(capped)
      if (ev) dispatch(ev)
    })
    device.on('error', (err) => {
      log('device error', err.message, '— reopening')
      diag('status', {
        state: 'error',
        reason: 'device-error',
        message: `device error: ${err.message}`,
      })
      try {
        device.close()
      } catch {}
      device = null
      prev = new Map()
      if (!stopped) scheduleRetry()
    })
  }

  const init = async () => {
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 10,
    })
    if (!config.allowPageZoom) {
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: TAME_GESTURES_SRC,
      })
      await send('Runtime.evaluate', { expression: TAME_GESTURES_SRC }).catch(
        () => {},
      )
    }
    await refreshViewport()
  }

  const vpTimer = setInterval(refreshViewport, 1000)
  init()
    .then(openWithRetry)
    .catch((err) => log('init failed:', err.message))

  return {
    /**
     * Change the mounting rotation without restarting the agent — the operator
     * is standing at the panel trying values, and a restart would cost the
     * device handle and the debugger attachment for every attempt.
     */
    setRotation(deg) {
      rotation = Number(deg) || 0
      log('touch rotation:', rotation + '°')
    },
    /** Retry immediately instead of waiting out the 2s backoff. */
    rescan() {
      if (stopped) return
      clearTimeout(retryTimer)
      try {
        if (device) device.close()
      } catch {}
      device = null
      prev = new Map()
      openWithRetry()
    },
    stop() {
      stopped = true
      clearInterval(vpTimer)
      clearTimeout(retryTimer)
      // Take the listeners off before closing. node-hid finishes the in-flight
      // read on a worker thread and reports the close as an error; if that
      // lands while the JS environment is already tearing down, node-hid
      // raises it with ThrowAsJavaScriptException and there is no longer a
      // handler to receive it — an uncaught C++ throw that aborts the whole
      // process (SIGABRT), which macOS reports as "quit unexpectedly".
      try {
        if (device) {
          device.removeAllListeners('data')
          device.removeAllListeners('error')
          device.close()
        }
      } catch {}
      device = null
      try {
        if (dbg.isAttached()) dbg.detach()
      } catch {}
    },
  }
}

module.exports = { startTouchAgent }
