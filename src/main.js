// Electron main process. Flow:
//   - No external config.json → window 1: pick a display.
//   - Picking a display → window 2: the test page (fullscreen on that display,
//     touch agent live) with URL + zoom controls; "Launch" saves config and
//     opens the chosen URL (or stays on the test page if URL is blank).
//   - External config with a URL → straight to the kiosk URL.
// One app = Chromium renderer + node-hid in the main process; no external
// browser, no debugging port.

const { app, BrowserWindow, screen, ipcMain, shell, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { startTouchAgent } = require('./touch-agent')
const { deriveFromDevices } = require('./derive')

const log = (...a) => console.log('[kiosk]', ...a)
const hex = (n) => '0x' + (n || 0).toString(16).padStart(4, '0')

const DEFAULTS = {
  url: '', // empty → the built-in test page
  hidVendorId: 0x0457,
  hidProductId: 0x6595,
  maxTouchPoints: 10,
  allowPageZoom: false,
  displayIndex: 1,
  zoom: 1,
}

const TEST_PAGE = path.join(__dirname, 'testpage.html')
const PRELOAD = path.join(__dirname, 'preload.js')

// Electron's loadURL needs a scheme. A bare host like "10.10.1.231:3004" or
// "tbf.ch/explore" would otherwise fail to load → black screen. Default to http
// for plain IP/localhost, https otherwise; leave full URLs (and file:/data:) be.
function normalizeUrl(u) {
  const s = (u || '').trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(file|data):/i.test(s)) return s
  const isLocal = /^(localhost|127\.0\.0\.1|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)
  return (isLocal ? 'http://' : 'https://') + s
}

const existsSafe = (p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function externalConfigCandidates() {
  const c = []
  if (process.env.KIOSK_CONFIG) c.push(process.env.KIOSK_CONFIG)
  if (app.isPackaged) {
    c.push(path.resolve(path.dirname(app.getPath('exe')), '../../../config.json'))
    c.push(path.join(app.getPath('userData'), 'config.json'))
  } else {
    c.push(path.join(app.getAppPath(), 'config.json'))
  }
  return c
}

const findExternalConfig = () =>
  externalConfigCandidates().find(existsSafe) || null

function loadSeed() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function applyEnv(cfg) {
  if (process.env.KIOSK_URL) cfg.url = process.env.KIOSK_URL
  if (process.env.MAX_TOUCH_POINTS) cfg.maxTouchPoints = Number(process.env.MAX_TOUCH_POINTS)
  if (process.env.ALLOW_PAGE_ZOOM) cfg.allowPageZoom = true
  if (process.env.DISPLAY_INDEX) cfg.displayIndex = Number(process.env.DISPLAY_INDEX)
  if (process.env.ZOOM) cfg.zoom = Number(process.env.ZOOM)
  return cfg
}

function loadConfig(configPath) {
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    log('config from', configPath)
  } catch {
    log('config: unreadable, using defaults (', configPath, ')')
  }
  return applyEnv({ ...DEFAULTS, ...file })
}

// Same directory resolution config.json uses (external override → next to the
// packaged .app → userData; project root in dev). Shared so anything else we
// write alongside config.json — e.g. the raw HID descriptor dump — lands in
// the same place, in both dev and packaged builds.
function configDirCandidates() {
  return app.isPackaged
    ? [path.resolve(path.dirname(app.getPath('exe')), '../../../'), app.getPath('userData')]
    : [app.getAppPath()]
}

function writeJsonFile(filename, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n'
  for (const dir of configDirCandidates()) {
    const t = path.join(dir, filename)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(t, body)
      return t
    } catch {
      /* try next */
    }
  }
  return null
}

function writeConfig(obj) {
  return writeJsonFile('config.json', obj)
}

let win = null
let agent = null
let pending = null // config-in-progress during setup

// --- kiosk / test window ---------------------------------------------------

function logDisplays() {
  screen.getAllDisplays().forEach((d, i) => {
    log(
      `display[${i}]`,
      `${d.bounds.width}x${d.bounds.height}`,
      d.internal ? 'internal' : 'external',
      d.id === screen.getPrimaryDisplay().id ? '(primary)' : '',
    )
  })
}

// `test` true → load the built-in test page (URL/zoom controls + touch tests),
// with the preload so it can save config + launch. Otherwise load config.url.
function createKioskWindow(config, { test } = {}) {
  const display = screen.getAllDisplays()[config.displayIndex] || screen.getPrimaryDisplay()
  const { x, y, width, height } = display.bounds
  log('→ display', config.displayIndex, `${width}x${height}`, test ? '(test page)' : '(' + config.url + ')')

  const next = new BrowserWindow({
    x, y, width, height,
    kiosk: true,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: test ? PRELOAD : undefined, // only the test page gets the bridge
    },
  })
  const prev = win
  win = next

  const wc = next.webContents
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {})
  if (!test && config.zoom && config.zoom !== 1) {
    wc.on('did-finish-load', () => {
      try {
        wc.setZoomFactor(config.zoom)
      } catch {}
    })
  }
  // Diagnostics are pushed to the test page only. In kiosk mode the callback is
  // undefined, so the agent collects nothing at all.
  const onDiag = test
    ? (ev) => {
        if (!next.isDestroyed()) next.webContents.send('kiosk:diag', ev)
      }
    : undefined
  // Both the outgoing window's `detach` handler and this window's `dom-ready`
  // handler close over the module-level `agent`, but each window must only
  // ever stop the agent instance IT started. During a window swap the old
  // window's debugger `detach` (triggered by `prev.destroy()` below) can
  // fire after this window's `dom-ready` has already run — a shared
  // reference would then tear down the brand-new agent instead of the dead
  // one, silently killing touch and turning kiosk:rescan into a no-op.
  let ownAgent = null
  const startAgent = () => {
    ownAgent = startTouchAgent(wc, config, log, onDiag)
    agent = ownAgent
  }
  const stopOwnAgent = () => {
    if (!ownAgent) return
    ownAgent.stop()
    if (agent === ownAgent) agent = null
    ownAgent = null
  }

  wc.once('dom-ready', startAgent)
  wc.on('did-fail-load', (_e, code, desc, validatedURL) => {
    log('LOAD FAILED', code, desc, '→', validatedURL, '(black screen)')
  })
  wc.debugger.on('detach', (_e, reason) => {
    log('debugger detached:', reason)
    stopOwnAgent()
  })
  wc.on('render-process-gone', (_e, details) => {
    log('renderer gone:', details.reason, '— reloading')
    stopOwnAgent()
    next.reload()
    wc.once('dom-ready', startAgent)
  })

  if (test) {
    next.loadFile(TEST_PAGE, {
      query: { url: config.url || '', zoom: String(config.zoom || 1) },
    })
  } else {
    next.loadURL(normalizeUrl(config.url))
  }

  // Close the previous window only after the new one exists (never hit 0 windows).
  if (prev && !prev.isDestroyed()) prev.destroy()
}

// --- window 1: display picker ----------------------------------------------

function displayPickerHtml() {
  const primaryId = screen.getPrimaryDisplay().id
  const buttons = screen
    .getAllDisplays()
    .map(
      (d, i) =>
        `<button class="disp" onclick="window.lucidKiosk.chooseDisplay(${i})">` +
        `Display ${i} — ${d.bounds.width}×${d.bounds.height} ` +
        `${d.internal ? 'internal' : 'external'}${d.id === primaryId ? ' (primary)' : ''}</button>`,
    )
    .join('')
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body{font:15px ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e0ea;margin:0;padding:32px}
      h1{font-size:20px;color:#9fb6cd}
      .disp{display:block;width:100%;text-align:left;margin:10px 0;padding:18px 20px;font:inherit;
        background:#1d2a38;color:#d7e0ea;border:1px solid #34465a;border-radius:8px;cursor:pointer}
      .disp:hover{background:#243648;border-color:#2f81f7}
    </style></head><body>
      <h1>Lucid Touch Kiosk — choose a display</h1>
      <p>Click the touchscreen's display. The touch test page opens there next.</p>
      ${buttons}
    </body></html>`)
  )
}

function enterDisplayPicker() {
  logDisplays()
  log('SETUP — choose a display')
  win = new BrowserWindow({
    width: 560,
    height: 480,
    title: 'Lucid Touch Kiosk — Setup',
    backgroundColor: '#0b0f14',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.loadURL(displayPickerHtml())
}

// --- WebHID (panel wizard) ---------------------------------------------------

// The test page reads the touch panel's report descriptor via WebHID —
// Chromium parses descriptors (node-hid on macOS cannot), which is how the
// wizard derives a touchReport layout for an unknown panel. Reading
// `device.collections` never open()s the device, so it cannot collide with
// the touch agent holding it through node-hid.
function setupWebHid() {
  // Only the bundled file:// pages get HID access — never a remote kiosk URL.
  const trusted = (origin) => typeof origin === 'string' && origin.startsWith('file://')
  session.defaultSession.setDevicePermissionHandler(
    (details) => details.deviceType === 'hid' && trusted(details.origin),
  )
}

// --- IPC --------------------------------------------------------------------

ipcMain.handle('setup:chooseDisplay', (_e, index) => {
  pending = { ...loadSeed(), displayIndex: Number(index) || 0 }
  writeConfig(pending) // persist the display choice
  createKioskWindow(pending, { test: true }) // open test page on that display
  return { ok: true }
})

ipcMain.handle('kiosk:save', (_e, p = {}) => {
  pending = pending || loadSeed()
  if (typeof p.url === 'string') pending.url = p.url.trim()
  if (p.zoom) pending.zoom = Number(p.zoom) || 1
  if (Number.isInteger(p.displayIndex)) pending.displayIndex = p.displayIndex
  const written = writeConfig(pending)
  log('saved config', written, '·', JSON.stringify({ url: pending.url, zoom: pending.zoom }))
  return { ok: true, written }
})

// --- panel wizard (test page only) ------------------------------------------

// The renderer collects navigator.hid devices (WebHID has already parsed the
// report descriptors) and this turns them into a parse.js layout. Pure lookup,
// no device is opened.
ipcMain.handle('kiosk:deriveLayout', (_e, devices) => {
  try {
    const r = deriveFromDevices(devices)
    log('wizard derived layout:', JSON.stringify(r.layout), 'warnings:', r.warnings.length)
    return { ok: true, ...r }
  } catch (err) {
    log('wizard derive failed:', err.message)
    return { ok: false, error: err.message }
  }
})

// Persist a wizard result. The running agent read its config at start, so the
// test window is recreated — createKioskWindow keeps the window count above
// zero, and the fresh agent opens the new panel.
ipcMain.handle('kiosk:savePanel', (_e, p = {}) => {
  pending = pending || loadSeed()
  if (Number.isInteger(p.hidVendorId)) pending.hidVendorId = p.hidVendorId
  if (Number.isInteger(p.hidProductId)) pending.hidProductId = p.hidProductId
  if (p.touchReport && typeof p.touchReport === 'object') pending.touchReport = p.touchReport
  const written = writeConfig(pending)
  log('saved panel config', written, '·', hex(pending.hidVendorId) + ':' + hex(pending.hidProductId))
  createKioskWindow(pending, { test: true })
  return { ok: true, written }
})

// Escape hatch for when deriveLayout fails on an unknown panel: the same
// devices array the wizard already collected (raw report descriptors and
// all), written verbatim next to config.json so a layout can still be
// hand-derived later even if the panel is never available again.
ipcMain.handle('kiosk:dumpDescriptors', (_e, devices) => {
  const written = writeJsonFile('hid-descriptors.json', devices)
  if (written) log('dumped HID descriptors →', written)
  else log('dumping HID descriptors failed: no writable location')
  return written
    ? { ok: true, written }
    : { ok: false, error: 'could not write hid-descriptors.json to any candidate location' }
})

// --- diagnostics actions (test page only) ----------------------------------

// macOS shows the Input Monitoring prompt once per binary and never again after
// a denial — TCC offers no way to re-ask. Deep-linking into the right settings
// pane is the only thing that actually helps someone standing at the kiosk.
ipcMain.handle('kiosk:openInputMonitoring', () => {
  const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
  log('opening Input Monitoring settings')
  return shell.openExternal(url).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, error: err.message }),
  )
})

ipcMain.handle('kiosk:rescan', () => {
  log('rescan requested')
  if (agent) agent.rescan()
  return { ok: !!agent }
})

// A freshly granted Input Monitoring permission does not reach a running
// process — node-hid keeps failing until the app is restarted.
ipcMain.handle('kiosk:relaunch', () => {
  log('relaunch requested')
  if (agent) agent.stop()
  app.relaunch()
  app.exit(0)
})

ipcMain.handle('kiosk:launch', (_e, opts = {}) => {
  const cfg = { ...(pending || loadSeed()) }
  if (typeof opts.url === 'string') cfg.url = opts.url.trim()
  if (opts.zoom) cfg.zoom = Number(opts.zoom) || 1
  const written = writeConfig(cfg)
  pending = cfg
  log('launch → wrote', written, '· url:', cfg.url || '(test page)', '· zoom', cfg.zoom)
  // With a URL → real kiosk (no preload). Blank → stay on the test page.
  createKioskWindow(cfg, { test: !cfg.url })
  return { ok: true, written }
})

// --- boot ------------------------------------------------------------------

app.whenReady().then(() => {
  setupWebHid()
  const start = () => {
    const ext = findExternalConfig()
    if (!ext) {
      enterDisplayPicker()
      return
    }
    const cfg = loadConfig(ext)
    pending = cfg
    createKioskWindow(cfg, { test: !cfg.url })
  }
  start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) start()
  })
})

// Release the HID device at the first sign of a quit, while the JS
// environment is still intact. Waiting for the default teardown lets
// node-hid's pending read complete into a dying context, which aborts the
// process instead of exiting — a crash dialog on every ⌘Q.
app.on('before-quit', () => {
  if (agent) {
    agent.stop()
    agent = null
  }
})

app.on('window-all-closed', () => {
  if (agent) agent.stop()
  app.quit()
})
