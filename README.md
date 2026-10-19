# lucid-touch-kiosk

A fullscreen kiosk for macOS that loads one URL and drives it from a USB HID
touchscreen. The app reads the panel's raw HID reports itself and injects them
into its own Chromium renderer as trusted touch events, using the in-process
DevTools Protocol. Pages get momentum scrolling, sliders, pinch and multitouch
without any in-page code, and touch feels native.

## Why

macOS has no touchscreen support. A USB touch panel is ignored by the system. At best, you get mouse emulation out of the box.

The commercial drivers that try to fill this gap work system-wide but not well. 

By injecting touch events from the HID straight into the browser nothing else on the Mac gains touch; only
the page this kiosk loads. But within that scope the support is complete, because
the events are injected as trusted input rather than translated into mouse
clicks: `panel → node-hid → bit parser → Input.dispatchTouchEvent`.

So, inside the browser you get native touch with everything you'd expect it to have.

## Requirements

- **Mac with Apple Silicon.** Built arm64-only; universal binaries break
  node-hid's device opening.
- **USB HID touchscreen.** Windows-Precision-style panels are profiled
  automatically by the setup checklist; others can be
  [described by hand](#supporting-a-different-touchscreen).
- **Input Monitoring permission.** macOS lets any process list HID devices but
  not open one. Until it is granted, the panel appears in every diagnostic and
  delivers no touch. See [Install](#install).

## Install

Download the latest `LucidTouchKiosk-*-arm64.zip` from
[Releases](https://github.com/wearelucid/lucid-touch-kiosk/releases) and unzip
it. Put the app wherever suits the machine — the Desktop, or a folder of its
own. Its `config.json` will appear next to it, so app and settings stay
together and can be copied to the next kiosk as one folder.

Releases are signed with Lucid's Developer ID and notarised by Apple, so the
app opens like any other download.

Open the app. It shows a five-step checklist on the touchscreen's display and
ticks the steps off as they are satisfied:

1. **Display** — chosen automatically when there is one external display.
2. **Permission** — macOS asks for *Input Monitoring*; click **Allow**. If you
   missed it: **Open System Settings**, enable the app, then **Relaunch app**
   (a grant does not reach a running app). The Bluetooth prompt may be
   declined — the panel is USB.
3. **Touch panel** — found and profiled on its own from its HID descriptor.
   Tap the four corners and the centre to confirm it (and the display, and the
   mounting rotation).
4. **Serial devices** — optional. Plug in a printer or scanner, **Test**,
   **Accept**. Or **No devices, continue**.
5. **URL and start** — type the URL, **Check** it, **Start kiosk**.

To get back into the checklist from the running kiosk: press **⌘⇧,** or hold
**five fingers** still on the screen for three seconds (panels that report
five or more contacts). After ten minutes without input the kiosk returns on
its own.

### First run

The checklist above is the whole first run. Below it, once the panel is open,
the page offers touch targets (tap, scroll, pinch, drag) to try the panel on,
and step 3's *Details* holds the [diagnostics](#when-touch-doesnt-work). When
several displays could be the touchscreen's, a small window asks first.

Each choice is written to `config.json` as it is made — see
[Configuration](#configuration) for where that file lives. The same checklist
is what you see again later when something is wrong: the broken step is the
one that is not ticked.

If the page can't be loaded — typically right after login, before the network
is up — the kiosk keeps retrying (after 2, 4, 8 s, then every 30 s) until it
loads, so a kiosk started as a login item doesn't stay on a black screen.

To quit a running kiosk, press ⌘Q.

## Configuration

`config.json` is generated rather than shipped: setup writes it, the panel
wizard updates it, and it describes one machine — which display, which panel,
how it is mounted.

It lives **next to the `.app`**, which is what makes a kiosk portable: move
the folder to another machine and its configuration comes along. Search order
at launch, first match wins, with the chosen file printed to the log:

`$KIOSK_CONFIG` → next to the `.app` → `~/Library/Application Support/Lucid
Touch Kiosk/`. In dev, the project root.

The one exception is an **applications folder**. Loose files don't belong in
`/Applications`, and it is writable only for admins — a standard account would
silently end up elsewhere, so the same app would behave differently per
account. Installed there, the config goes to Application Support for everyone.

| Key / env | Default | Meaning |
| --- | --- | --- |
| `url` / `KIOSK_URL` | `""` | Page to show. Blank opens the built-in test page. |
| `hidVendorId`, `hidProductId` | `null` = none chosen yet | Touchscreen USB ids; step 3 of the checklist fills them in |
| `touchReport` | SiS layout | Bit layout of the touch report — [see below](#supporting-a-different-touchscreen) |
| `touchVerified` | `false` | The five corner taps landed on this panel; reset whenever the panel changes |
| `touchRotation` / `TOUCH_ROTATION` | `null` = follow the display | `0`/`90`/`180`/`270` for a panel mounted sideways |
| `displayIndex` / `DISPLAY_INDEX` | `1` | Monitor to open on (see `display[N]` in the startup log) |
| `zoom` / `ZOOM` | `1` | Page zoom (`2.5` = 250%); touch stays aligned |
| `maxTouchPoints` / `MAX_TOUCH_POINTS` | `10` | `1` disables multitouch entirely |
| `allowPageZoom` / `ALLOW_PAGE_ZOOM` | `false` | `false` blocks pinch-zoom and overscroll bounce, keeps scroll and in-page multitouch |
| `serialDevices` | `[]` | Serial devices the kiosk page may use — [see below](#serial-devices) |
| `serialSkipped` | `false` | "No serial devices" was chosen in setup |

### Rotated and portrait panels

A digitizer is bonded to its panel, so it reports in the panel's unrotated
frame. Rotating the display in macOS turns the image but not the touch
coordinates. The app reads the display's rotation and corrects for it, so a
portrait-mounted panel needs no configuration.

`touchRotation` overrides that value, as does the Touch rotation control on the
test page, which applies immediately. This covers the case the rule cannot: a
touch foil mounted turned relative to its display. Rotation sits outside
`touchReport` because it describes the mounting, not the panel.

### Supporting a different touchscreen

Step 3 of the checklist does this on its own: it reads the panel's HID report
descriptor via WebHID (Chromium can parse it; node-hid on macOS cannot),
derives `hidVendorId`/`hidProductId` and the `touchReport` block, writes them
to `config.json` and restarts the touch agent on the new panel. With several
touchscreens connected it asks which one; with a panel already configured it
offers the newly found one instead of replacing silently. Touch the screen and
check *Details → Live reports*: parsed contacts confirm the layout.

Verified end-to-end on a Samsung Flip (`25b5:0054`), which is a useful second
reference because its axes have different ranges — the case `logicalMaxY`
exists for:

```json
{
  "hidVendorId": 9653,
  "hidProductId": 84,
  "touchReport": {
    "reportId": 1, "maxContacts": 4, "strideBits": 80,
    "tipOffset": 0, "contactIdOffset": 8, "contactIdBits": 8,
    "xOffset": 16, "yOffset": 32, "coordBits": 16,
    "logicalMax": 4800, "logicalMaxY": 3000
  }
}
```

The wizard rejects panels whose contact blocks are not evenly strided, and
descriptors without a usable `logicalMaximum`. Both produce an explicit error
rather than a layout that would place every touch wrongly. In those cases,
press Save raw descriptors, which writes every connected device's descriptor to
`hid-descriptors.json` next to `config.json`, and write the block by hand:

| Field | Meaning |
| --- | --- |
| `reportId` | HID report id (`0`/null if the device has no report ids) |
| `maxContacts` | max simultaneous fingers in one report |
| `strideBits` | bit distance between contact blocks |
| `tipOffset` | tip-switch bit within a block |
| `contactIdOffset`, `contactIdBits` | contact-id field (`null` uses the finger index) |
| `xOffset`, `yOffset`, `coordBits` | X/Y field offsets and bit width |
| `logicalMax`, `logicalMaxY` | full-scale X, and Y when it differs |

> WebHID is granted only to the app's own bundled pages. A remote kiosk URL
> never gets raw HID access.

### Serial devices

A kiosk page can use serial devices — a barcode scanner, a card reader — through
the Web Serial API. In Chrome, `navigator.serial.requestPort()` opens a dialog
where the user picks a port. The kiosk shows no dialog: visitors stand in front
of it. Instead, devices are accepted once on the test page:

1. Step 4 of the checklist lists all serial ports, including ones plugged in
   while it is open.
2. **Test** opens a port and shows what it sends; scan or send something to
   confirm it's the right device.
3. **Accept device** stores it in `config.json`.

From then on the kiosk page receives the accepted device without a dialog, both
when it calls `requestPort()` and when it calls `getPorts()` to reconnect after
a restart. Only the origin of the configured `url` gets access; a page the
kiosk navigates to elsewhere does not.

Devices are stored by USB vendor and product id, not serial number, so a
replacement unit of the same model works without setting it up again. The baud
rate isn't stored — the page passes it when it opens the port. Ports without a
USB id (Bluetooth, built-in) can't be recognised after a restart and so can't
be accepted.

## When touch doesn't work

The diagnostics section of the test page answers four questions without a
terminal: whether the panel is listed (digitizers are marked `⌖`, the
configured one is highlighted), whether Input Monitoring is granted, whether
the panel could be opened, and whether the layout is right. The permission is
tested by opening a reference keyboard or mouse — a failure there is a global
denial rather than a panel problem. Each failure state names its remedy, and
buttons open the Input Monitoring settings, re-scan, or relaunch.

The live report feed separates cases a device list cannot:

| You see | It means |
| --- | --- |
| Parsed contacts with sensible coordinates | Working. |
| Bytes arriving, `contacts: null` | Panel fine, layout wrong: `reportId` mismatch or a field size out of range. |
| Bytes arriving, `0 contacts` while touching | Tip-switch offset is wrong. |
| No reports, status red | Not a layout problem — read the status hint (permission or cable). |

On a configured kiosk, blank out `url` to return to the test page.

Everything the app notices ends up in its [log](#log). To also list every
connected HID device there, start it with `DIAGNOSE=1`:

```sh
open -n "path/to/Lucid Touch Kiosk.app" --env DIAGNOSE=1
```

Always start the app from Finder or with `open`, never by running the binary
from a terminal: macOS then attributes the app's permission requests to the
terminal, so Input Monitoring and Bluetooth are checked against the terminal's
grants instead — permissions seem to be missing, or to survive rebuilds, for no
apparent reason.

If a panel cannot be brought up, three things allow profiling it later without
the hardware: `hid-descriptors.json` from Save raw descriptors, the log from a
`DIAGNOSE=1` start, and what the status line and live reports showed.

## Log

The app writes `logs/kiosk.log` next to itself — or to
`~/Library/Logs/Lucid Touch Kiosk/` when installed in an applications folder.
The test page shows the path and has an **Open log folder** button.

It records serial events (search, pick, accept, hand-over to the page,
refusals), touch panel state (found, lost, permission missing), errors and
warnings from the kiosk page's own console, failed page loads, crashed helper
processes, and unexpected exceptions in the app itself — which would otherwise
put an error dialog on the kiosk screen. Individual touches are not logged.

Errors from the page are logged with their actual message — `InvalidStateError:
The port is already open.` rather than the `[object DOMException]` the page's
console output alone would give — including those from before the page
finished loading.

```
2026-09-29 09:08:30.558  WARN   serial   the page asked for a port but no visible port is accepted
2026-09-29 09:08:32.576  WARN   serial   refused a port request from http://127.0.0.1:8732
```

It is built to run unattended for months:

- **Repeats collapse.** A message recurring within a minute of its last
  occurrence is counted, not written. A retry loop — the panel is missing, a
  page keeps failing to reconnect — becomes one line plus
  `— repeated 1 799× since 14:00:02`, written when it stops, hourly while it
  lasts, and on quit.
- **Size is capped.** At 5 MB `kiosk.log` rotates to `kiosk.1.log` …
  `kiosk.4.log` and the oldest is dropped: 25 MB at most, however long the kiosk
  runs.
- **Nothing is lost on a crash.** Every line is on disk the moment it's
  written.

## Build from source

```sh
npm install     # rebuilds node-hid for Electron's ABI
npm start       # run from source; no config yet → interactive setup
npm test        # unit tests for the report parser and layout derivation
npm run dist    # → dist/mac-arm64/Lucid Touch Kiosk.app
```

If node-hid throws `NODE_MODULE_VERSION`, run `npm run rebuild`.

`npm run dist` signs the app with the *Developer ID Application* certificate
in your login keychain (Hardened Runtime, entitlements in
`build/entitlements.mac.plist`) and produces both the `.app` and the release
zip. Without such a certificate electron-builder falls back to an unsigned
build, which macOS blocks on first launch — clear it with
`xattr -dr com.apple.quarantine "dist/mac-arm64/Lucid Touch Kiosk.app"`.

Notarisation runs as part of the build when credentials are present. Store
them once in the keychain:

```sh
xcrun notarytool store-credentials "lucid-notary" --apple-id "you@example.com" --team-id "R8H8B94FZJ"
```

then build with `APPLE_KEYCHAIN_PROFILE=lucid-notary npm run dist`. Without
the variable the build logs "skipped macOS notarization" and the result is
signed but not notarised — fine for the development machine, not for a
release. Check a release build with
`spctl -a -vv "dist/mac-arm64/Lucid Touch Kiosk.app"`: it must say
`source=Notarized Developer ID`.

Because macOS binds the Input Monitoring grant to the signing identity rather
than to the binary's hash, a signed build keeps the grant across rebuilds.

## How it works

`finger → panel → USB HID → node-hid → parse.js (layout-driven bit reader) →
diff to touchStart/Move/End → webContents.debugger →
Input.dispatchTouchEvent → renderer`. The renderer runs an ordinary web page
with no knowledge of the panel. On every document the agent sets
`touch-action: pan-x pan-y` and `overscroll-behavior: none`, and the window
uses `setVisualZoomLevelLimits(1,1)`, to suppress page pinch-zoom and
rubber-banding while keeping scroll and multitouch.

## License

MIT — see [LICENSE](LICENSE). The bundled fonts (Space Grotesk, Instrument
Serif) are under the SIL Open Font License, included in `src/fonts/`.
