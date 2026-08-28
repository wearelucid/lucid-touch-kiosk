# lucid-touch-kiosk

A fullscreen kiosk for macOS that loads one URL and drives it from a USB HID
touchscreen. The app reads the panel's raw HID reports itself and injects them
into its own Chromium renderer as trusted touch events, using the in-process
DevTools Protocol. Pages get momentum scrolling, sliders, pinch and multitouch
without any in-page code, and touch feels native.

## Why

macOS has no touchscreen support. A USB touch panel is ignored by the system,
while Windows treats the same hardware as a multitouch device.

The commercial drivers that fill this gap work system-wide: every application
becomes touchable. They achieve that by emulating a mouse, which is where the
compromise sits — one contact at a time, no momentum scrolling, no pinch, and
no real touch events for a web page to respond to.

This app makes the opposite trade. Nothing else on the Mac gains touch; only
the page this kiosk loads. Within that scope the support is complete, because
the events are injected as trusted input rather than translated into mouse
clicks: `panel → node-hid → bit parser → Input.dispatchTouchEvent`.

So the question is which shape fits: a driver if the whole desktop needs touch,
this if a single web app does.

## Requirements

- **Mac with Apple Silicon.** Built arm64-only; universal binaries break
  node-hid's device opening.
- **USB HID touchscreen.** Windows-Precision-style panels are profiled
  automatically by the built-in wizard; others can be
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

The app is **not signed or notarised**, so macOS quarantines it on download.
Clear that flag once, in Terminal:

```sh
xattr -dr com.apple.quarantine "path/to/Lucid Touch Kiosk.app"
```

Then grant the permission the app needs to read the panel:

1. **System Settings → Privacy & Security → Input Monitoring**, and enable
   Lucid Touch Kiosk (use **+** to add it if it isn't listed).
2. Relaunch. A permission granted while the app runs does not reach it.

Without Input Monitoring, macOS refuses to let the app open the panel: the
touchscreen shows up in every diagnostic and still delivers no touch.

macOS 14+ also asks about Bluetooth, because node-hid scans it while
enumerating devices. The panel is USB, so **Don't Allow** is fine.

> Without the `xattr` command, macOS blocks the first launch. The **Open
> Anyway** button in System Settings → Privacy & Security only appears
> immediately after such a blocked attempt, which makes it easy to miss —
> hence the Terminal route above.

### First run

1. Pick the display the touchscreen is connected to.
2. The test page opens there fullscreen. It has touch targets (tap, scroll,
   pinch, drag), the [diagnostics panel](#when-touch-doesnt-work), and fields
   for URL, zoom and touch rotation. Press Launch to open the kiosk; a blank
   URL keeps the test page.

Each choice is written to `config.json` as it is made — see
[Configuration](#configuration) for where that file lives.

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
| `hidVendorId`, `hidProductId` | `0x0457`, `0x6595` (SiS) | Touchscreen USB ids |
| `touchReport` | SiS layout | Bit layout of the touch report — [see below](#supporting-a-different-touchscreen) |
| `touchRotation` / `TOUCH_ROTATION` | `null` = follow the display | `0`/`90`/`180`/`270` for a panel mounted sideways |
| `displayIndex` / `DISPLAY_INDEX` | `1` | Monitor to open on (see `display[N]` in the startup log) |
| `zoom` / `ZOOM` | `1` | Page zoom (`2.5` = 250%); touch stays aligned |
| `maxTouchPoints` / `MAX_TOUCH_POINTS` | `10` | `1` disables multitouch entirely |
| `allowPageZoom` / `ALLOW_PAGE_ZOOM` | `false` | `false` blocks pinch-zoom and overscroll bounce, keeps scroll and in-page multitouch |

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

Use the panel wizard: test page → 7 · Touch panel diagnostics → Details →
Panel wizard.

1. **Detect panel layout** reads the panel's HID report descriptor via WebHID
   (Chromium can parse it; node-hid on macOS cannot) and derives the
   `touchReport` block, showing a JSON preview and any warnings.
2. **Save & use this layout** writes the ids and layout to `config.json` and
   restarts the touch agent on the new panel.
3. Touch the screen and check Live reports. Parsed contacts confirm the layout.

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

On a configured kiosk, blank out `url` to return to the test page. `DIAGNOSE=1`
prints all HID devices to stdout; run the packaged binary from Terminal to see
it.

If a panel cannot be brought up, three things allow profiling it later without
the hardware: `hid-descriptors.json` from Save raw descriptors, the `DIAGNOSE=1`
output, and what the status line and live reports showed.

## Build from source

```sh
npm install     # rebuilds node-hid for Electron's ABI
npm start       # run from source; no config yet → interactive setup
npm test        # unit tests for the report parser and layout derivation
npm run dist    # → dist/mac-arm64/Lucid Touch Kiosk.app
```

If node-hid throws `NODE_MODULE_VERSION`, run `npm run rebuild`.

A locally built app is unsigned too, so it needs the same unblocking as a
downloaded one. The Input Monitoring grant is bound to the exact binary, so
after each `npm run dist` the entry has to be removed and re-added. Signing
with an Apple Developer ID would make both grants persist and remove the
Gatekeeper step entirely.

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
