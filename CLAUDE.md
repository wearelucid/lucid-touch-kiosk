# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron kiosk shell (macOS/arm64) that loads a configured URL fullscreen and drives it
from a **USB HID touchscreen**. Instead of relying on OS touch delivery, it reads the raw
HID reports itself (`node-hid`, main process) and injects **trusted** touch events into its
own renderer through the in-process DevTools Protocol (`webContents.debugger` →
`Input.dispatchTouchEvent`). Because the events are trusted, the page gets native scroll
momentum, sliders, hover and multitouch with no in-page code.

## Commands

```sh
npm install     # postinstall runs electron-rebuild for node-hid (Electron ABI)
npm start       # electron . — runs against project-root config.json
npm test        # node --test test/*.test.js — unit tests for parse.js, derive.js, serial.js
npm run rebuild # re-run electron-rebuild if node-hid throws NODE_MODULE_VERSION
npm run dist    # electron-builder → dist/mac-arm64/Lucid Touch Kiosk.app (unsigned)
DIAGNOSE=1 npm start   # log every connected HID device (vid/pid/usage)
```

There is no linter or formatter in this repo. `npm test` covers the three pure modules
(`src/parse.js`, `src/derive.js`, `src/serial.js`) — everything that touches Electron (main.js, touch-agent.js,
the IPC surface, the wizard's actual save/reload behavior) is still verified only by running
the app; `src/testpage.html` is the built-in harness (panel diagnostics, touch counters,
scroll/pinch/slider/drag targets, corner calibration marks, and the panel wizard).

Env overrides read at boot: `KIOSK_CONFIG`, `KIOSK_URL`, `MAX_TOUCH_POINTS`,
`ALLOW_PAGE_ZOOM`, `DISPLAY_INDEX`, `ZOOM`, `TOUCH_ROTATION`.

## Architecture

Data flow: `panel → USB HID → node-hid → parse.js → touch-agent.js (diff to
start/move/end) → webContents.debugger → renderer`.

- [src/main.js](src/main.js) — process lifecycle, config resolution, window creation, IPC.
- [src/touch-agent.js](src/touch-agent.js) — opens the HID device, converts contacts to CDP
  touch events, owns the debugger attachment. Returns `{ stop() }`.
- [src/parse.js](src/parse.js) — pure, layout-driven bit reader for HID touch reports.
  Unit-tested (`test/parse.test.js`).
- [src/derive.js](src/derive.js) — pure: turns a WebHID report descriptor
  (`device.collections`) into the `touchReport` layout `parse.js` consumes. The panel
  wizard's core. No Electron, no DOM, no I/O. Unit-tested (`test/derive.test.js`).
- [src/serial.js](src/serial.js) — pure: which serial device a page may use (accepted
  vid/pid × origin), and the answer to `select-serial-port`. Unit-tested (`test/serial.test.js`).
- [src/preload.js](src/preload.js) — `window.lucidKiosk` bridge (`chooseDisplay`, `save`,
  `launch`, `setZoom`, `deriveLayout`, `savePanel`, the serial chooser and accepted-device
  list). Attached **only** to setup/test windows, never to the kiosk URL.
- [src/testpage.html](src/testpage.html) — setup UI (URL + zoom fields, Launch) and touch
  test harness in one page.

### Boot modes

`app.whenReady()` looks for an *external* config (`$KIOSK_CONFIG` → next to the `.app` →
`userData/config.json`; in dev, project-root `config.json` counts):

- **no external config** → display-picker window (HTML built inline as a `data:` URL in
  `displayPickerHtml()`), then the test page fullscreen on the chosen display.
- **external config, blank `url`** → test page fullscreen (setup mode with touch live).
- **external config with `url`** → the kiosk proper, no preload.

`pending` in main.js is the config-in-progress across the setup IPC calls; `writeConfig`
persists on *every* step (display pick, save, launch), not only on Launch.

### Diagnostics channel

`startTouchAgent(wc, config, log, onDiag)` takes an optional 4th argument. When
present it emits `config` / `devices` / `status` / `report` events; `main.js`
forwards them over `kiosk:diag` to the test page, which renders the diagnostics
section. The callback is passed **only when `test === true`** — kiosk mode must
stay free of this overhead, so don't hoist it unconditionally.

`report` events are throttled to ~10/s and are emitted *including* the ones
`parseContacts` rejects (`contacts: null`). That is deliberate: bytes arriving
with nothing parsed is the signature of a wrong `touchReport` layout, which a
device list alone cannot distinguish from a working panel.

Failure reasons are classified in `openWithRetry` by evidence, not inference.
**Enumeration is not gated by Input Monitoring — only opening is**, so a full
`HID.devices()` list proves nothing about the permission (measured: 67 devices
returned while opening a keyboard failed). `probePermission()` therefore opens a
reference device (usage `1/6` or `1/2`) and closes it again: failure means the
denial is global. That splits "panel listed but won't open" into
`input-monitoring` vs `device-busy`, and a missing panel stays `not-found` since
the cable is genuinely the issue there.

The test page's action buttons map to `kiosk:openInputMonitoring` (deep-links
`x-apple.systempreferences:…?Privacy_ListenEvent`), `kiosk:rescan`
(`agent.rescan()`, which cancels the 2 s backoff) and `kiosk:relaunch`. There is
deliberately no "request permission again" button: macOS shows the TCC prompt
once per binary and never re-prompts after a denial, so such a button could not
work without a native `IOHIDRequestAccess` call.

### Panel wizard

`setupDevicePermissions()` in main.js grants WebHID only to the bundled `file://` pages
(`session.defaultSession.setDevicePermissionHandler`, checked against `details.origin`) — a
remote kiosk URL never gets it. This is what lets `src/testpage.html` read
`navigator.hid.getDevices()` (Chromium parses the report descriptor into `device.collections`;
node-hid on macOS cannot) without opening the device, so it can't collide with the touch agent
holding it via node-hid.

The test page's wizard block (inside *7 · Touch panel diagnostics* → *Details* → *Panel
wizard*) sends the collected `collections` to IPC `kiosk:deriveLayout`, which calls
`deriveFromDevices` / `deriveTouchReport` in [src/derive.js](src/derive.js) — pure lookup, no
device opened. `deriveTouchReport` deliberately tolerates trailing Contact Count (0x000D0054) /
Scan Time (0x000D0056) fields after the last contact block (standard on Windows-Precision-style
digitizers) but rejects contact blocks that aren't evenly strided, and rejects a descriptor
whose X or Y has no usable `logicalMaximum` — both throw an explicit error rather than deriving
a layout that would silently place every touch off-screen. `kiosk:savePanel` then writes
`hidVendorId`/`hidProductId`/`touchReport` via `writeConfig` and calls `createKioskWindow` again
so the new agent starts against the new layout.

### Invariants worth preserving

- `createKioskWindow` creates the new window *before* destroying the previous one — window
  count must never hit 0, or `window-all-closed` quits the app.
- The touch agent is (re)started on `dom-ready` and torn down on `debugger detach` /
  `render-process-gone`. Any new window/reload path must keep that pairing, or touch
  silently dies.
- Only the test/setup windows get `preload`. Never attach the bridge to an arbitrary
  remote URL.
- Touch rotation is resolved in `createKioskWindow` (`resolveRotation` in parse.js) and
  applied in `touch-agent.js` **before** the contact is scaled to the viewport — the
  normalized space is square and the viewport is not, so rotating after scaling would
  stretch the axes. A `touchRotation` of `null` follows `display.rotation`: a digitizer is
  bonded to its panel and reports in the unrotated frame, so a rotated display always needs
  the same angle back, and the OS already knows it. It lives outside `touchReport` because
  it describes the mounting, not the report format.
- Coordinates are normalized (`nx`/`ny` in parse.js) and multiplied by the renderer's
  `innerWidth/innerHeight`, polled once a second and on every `touchStart`. This is why
  page zoom stays aligned — don't switch to screen pixels.
- Touch dispatch is fire-and-forget (`.catch(() => {})`, no `await`) on purpose: awaiting
  each CDP round-trip destroys smoothness. Let Chromium coalesce.
- `normalizeUrl` exists because `loadURL` needs a scheme; bare `host:port` would otherwise
  black-screen. Local/IP hosts default to `http`, everything else to `https`.
- WebHID is granted only to `file://` origins in `setupDevicePermissions()`. The kiosk window shares
  `session.defaultSession`, so this origin check is the only thing standing between a remote
  page and raw HID access — never loosen it. It also implicitly depends on no `BrowserWindow`
  being given a custom `partition`/session; a future change that adds one would silently
  bypass this gate.
- The kiosk page gets serial access only for device models in `config.serialDevices`, and only
  on the configured URL's origin (`serialAllowed` in serial.js); the bundled test page may open
  any port its operator picks. Don't answer `select-serial-port` for other origins, and don't
  show a chooser on the kiosk page.
  Electron spells the bundled origin both `file://` and `file:///` depending on the handler —
  match with `isBundled()`, not string equality.
- Each window owns the touch agent it started (`ownAgent`/`stopOwnAgent` in
  `createKioskWindow`); the module-level `agent` is only cleared when it still points at that
  same instance. During a window swap the outgoing window's debugger `detach` (triggered by
  `prev.destroy()`) can fire after the incoming window's `dom-ready` has already started its
  own agent — with a shared reference, that `detach` handler would tear down the wrong (new)
  agent, silently killing touch on the window that's actually showing and turning
  `kiosk:rescan` into a no-op.

### Serial devices

Chrome shows a chooser for `navigator.serial.requestPort()`; **Electron shows nothing** and
fires `select-serial-port` on the session instead — unhandled, the request is cancelled
silently, which is how a kiosk page's "connect" button fails with no visible error. So:

- An operator accepts device models once, on the test page (*8 · Serial devices*). The test
  page's own `requestPort()` is parked in `serialPick` in main.js; the port list goes to the
  page over `kiosk:serialPorts` (kept live via `serial-port-added/-removed`), and the pick comes
  back over `kiosk:pickSerialPort`. Accepted models land in `config.serialDevices` as
  `{ vendorId, productId, name }` — vid/pid, not serial number, so the config stays valid for a
  replacement unit when the kiosk folder is copied.
- The kiosk page **never** sees a chooser (visitors stand in front of it). Its requests are
  answered with the first accepted port; its `getPorts()` sees accepted ports via the device
  permission handler — both only for the configured `url`'s origin, not for pages the kiosk
  navigates to.
- The baud rate is the page's business (it passes it to `port.open`) and is not stored.

Measured, and not obvious from the docs:

- Electron describes the same port in two shapes: `select-serial-port` gives
  `{ vendorId: '3118', productId: '4116' }` (camelCase strings), `setDevicePermissionHandler`
  gives `{ vendor_id: 3118, product_id: 4116 }` (snake_case numbers). `sameDevice` in serial.js
  reads both; reading only one made `getPorts()` empty and `open()` fail for an accepted device.
- If the device permission handler refuses a port, `open()` fails with "Failed to open serial
  port" even right after the page's own chooser returned it. That's why the test page may open
  any port (the operator tests it *before* accepting).
- Enumerating serial ports touches Bluetooth. macOS checks that against the **responsible
  process** — for an app started from a shell, the shell's host (Terminal, or Claude Code:
  `responsible: claude` in the crash report). Without a Bluetooth usage description there, the
  process hangs or is killed (`__TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__`). Launched via
  LaunchServices the app is responsible for itself and it works.

### Supporting a different touchscreen

The **panel wizard** (see above) is the primary path: it derives `hidVendorId`/`hidProductId`
and `touchReport` from the panel's WebHID report descriptor and writes them to config.json —
no manual bit-twiddling. Verified end-to-end on a Samsung Flip (`25b5:0054`), whose derived
layout also exercises `logicalMaxY` (X and Y have different logical ranges — 4800/3000; the
README carries the full block as a second reference). When the wizard rejects a panel, fall
back to hand-writing `touchReport` in config.json. Defaults are the SiS controller (`SIS_LAYOUT` in
parse.js: report 0x91, 5 contacts, 80-bit stride). Fields are documented in the README table
and in parse.js's header comment. macOS hides the digitizer collection from `ioreg`/node-hid,
which is exactly why the wizard goes through WebHID — and why `Save raw descriptors` (IPC
`kiosk:dumpDescriptors`) exists for the cases the wizard rejects.

## Running the app for testing

Start the packaged app with `open`, never by executing the binary from a shell:

```sh
open -n "dist/mac-arm64/Lucid Touch Kiosk.app" --stdout /tmp/kiosk.log --stderr /tmp/kiosk.log
```

Started from a shell, macOS attributes the app's privacy access (Input Monitoring, Bluetooth) to
the shell's host process, so permission results reflect the terminal's grants — which is how a
grant can appear to survive rebuilds, or be denied although it was given. `--env DIAGNOSE=1`
passes the device-list switch; `--args --remote-debugging-port=9333` makes the test page
drivable over CDP for automated checks.

## Packaging notes

Built **arm64-only on purpose** — universal binaries break `node-hid` device opening on
macOS. The app is unsigned by design (`identity: null`), so each `npm run dist` needs the
quarantine flag cleared and **Input Monitoring** re-granted (the grant is bound to the exact
binary). Signing is skipped entirely, which is why no entitlements file is carried — they
are only ever applied during codesigning.
