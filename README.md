# lucid-touch-kiosk

A fullscreen kiosk for macOS that loads one URL and drives it from a **USB HID
touchscreen**. The app reads the panel's raw HID reports itself and injects them
into its own Chromium renderer as **trusted touch** (in-process DevTools
Protocol) — so any web page gets native momentum scrolling, sliders, pinch and
multitouch, with no in-page code, no external browser, no debugging port.

## Why

macOS has no touchscreen support: plug in a USB touch panel and the system
ignores it, while Windows treats the same panel as a first-class multitouch
device. The commercial drivers that bridge the gap emulate a *mouse* — one
contact, no momentum, no pinch.

This app skips the OS instead: `panel → node-hid → bit parser →
Input.dispatchTouchEvent`. To the page, it's indistinguishable from an iPad.

## Requirements

- **Mac with Apple Silicon** — built arm64-only; universal binaries break
  node-hid's device opening.
- **USB HID touchscreen** — Windows-Precision-style panels are profiled
  automatically by the built-in wizard; others can be
  [described by hand](#supporting-a-different-touchscreen).
- **Input Monitoring permission** — macOS lets any process *list* HID devices
  but not *open* one. Until granted, the panel shows up in every diagnostic and
  delivers no touch. See [Build](#build-an-unsigned-app).

## Quick start

```sh
npm install     # rebuilds node-hid for Electron's ABI
npm start       # no config yet → interactive setup
npm test        # unit tests for the report parser + layout derivation
```

First run walks you through setup:

1. **Pick the display** the touchscreen is connected to.
2. The **test page** opens there fullscreen: touch targets (tap, scroll, pinch,
   drag), the [diagnostics panel](#when-touch-doesnt-work), and fields for
   **URL**, **Zoom** and **Touch rotation**. Press **Launch** when it feels
   right — a blank URL keeps the test page.

Every choice is persisted to `config.json` immediately.

If node-hid throws `NODE_MODULE_VERSION`, run `npm run rebuild`.

## Build an unsigned .app

```sh
npm run dist    # → dist/mac-arm64/Lucid Touch Kiosk.app
```

First launch:

1. Clear quarantine: `xattr -dr com.apple.quarantine "dist/mac-arm64/Lucid Touch Kiosk.app"`
   (or right-click → Open).
2. Grant **Input Monitoring** (System Settings → Privacy & Security), then
   relaunch — a grant issued while the app runs doesn't reach it.
3. macOS 14+ also asks about **Bluetooth** (node-hid scans it during
   enumeration). The panel is USB — **Don't Allow** is fine.

The app is unsigned, so the Input Monitoring grant is bound to the exact binary:
after a rebuild, remove and re-add the entry. Signing with a Developer ID would
make both grants persist and drop the quarantine step.

## Configuration

`config.json` is **generated, not shipped**: setup writes it, the panel wizard
updates it, and it describes one machine (which display, which panel, how it's
mounted). Search order at launch — the log prints which file won:

`$KIOSK_CONFIG` → next to the `.app` → `~/Library/Application Support/Lucid
Touch Kiosk/` (in dev: the project root). To ship a preconfigured kiosk, put a
`config.json` next to the `.app`.

| Key / env | Default | Meaning |
| --- | --- | --- |
| `url` / `KIOSK_URL` | `""` | Page to show. **Blank → the built-in test page.** |
| `hidVendorId`, `hidProductId` | `0x0457`, `0x6595` (SiS) | Touchscreen USB ids |
| `touchReport` | SiS layout | Bit layout of the touch report — [see below](#supporting-a-different-touchscreen) |
| `touchRotation` / `TOUCH_ROTATION` | `null` = follow the display | `0`/`90`/`180`/`270` for a panel mounted sideways |
| `displayIndex` / `DISPLAY_INDEX` | `1` | Monitor to open on (see `display[N]` in the startup log) |
| `zoom` / `ZOOM` | `1` | Page zoom (`2.5` = 250%); touch stays aligned |
| `maxTouchPoints` / `MAX_TOUCH_POINTS` | `10` | `1` disables multitouch entirely |
| `allowPageZoom` / `ALLOW_PAGE_ZOOM` | `false` | `false` blocks pinch-zoom + overscroll bounce, keeps scroll and in-page multitouch |

### Rotated / portrait panels

A digitizer is bonded to its panel, so it reports in the panel's **unrotated**
frame — rotate the display in macOS and the image turns while touch does not.
The app corrects this automatically from the display's rotation; a
portrait-mounted panel needs no configuration.

`touchRotation` (or the **Touch rotation** control on the test page, which
applies immediately) overrides the automatic value — for the one case the rule
can't cover: a touch foil mounted turned relative to its display. It lives
outside `touchReport` because it describes the mounting, not the panel.

### Supporting a different touchscreen

Use the **panel wizard**: test page → **7 · Touch panel diagnostics** →
**Details** → **Panel wizard**.

1. **Detect panel layout** — reads the panel's HID report descriptor via WebHID
   (Chromium can parse it; node-hid on macOS cannot) and derives the
   `touchReport` block. You get a JSON preview plus any warnings.
2. **Save & use this layout** — writes ids + layout to `config.json` and
   restarts the touch agent on the new panel.
3. Touch the screen and check **Live reports** — parsed contacts confirm the
   layout.

Verified end-to-end on a Samsung Flip (`25b5:0054`) — a useful second reference
because its axes have different ranges, which is what `logicalMaxY` is for:

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

The wizard **rejects** panels whose contact blocks aren't evenly strided, or
whose descriptor lacks a usable `logicalMaximum` — an explicit error instead of
a silently broken layout. For those, press **Save raw descriptors** (writes
every descriptor to `hid-descriptors.json` next to `config.json`) and hand-write
the block:

| Field | Meaning |
| --- | --- |
| `reportId` | HID report id (`0`/null if the device has no report ids) |
| `maxContacts` | max simultaneous fingers in one report |
| `strideBits` | bit distance between contact blocks |
| `tipOffset` | tip-switch bit within a block |
| `contactIdOffset`, `contactIdBits` | contact-id field (`null` → use the finger index) |
| `xOffset`, `yOffset`, `coordBits` | X/Y field offsets + bit width |
| `logicalMax`, `logicalMaxY` | full-scale X (and Y, unless `logicalMaxY` differs) |

> WebHID is granted only to the app's own bundled pages — a remote kiosk URL
> never gets raw HID access.

## When touch doesn't work

The test page's **diagnostics section** answers, without a terminal: is the
panel listed (digitizers marked `⌖`, the configured one highlighted), is Input
Monitoring granted (proven by opening a reference keyboard/mouse — failure there
is a global denial, not a panel problem), did the panel open, and is the layout
right. Every failure comes with its fix, plus buttons to open the Input
Monitoring settings, re-scan, or relaunch.

The **live report feed** separates the cases a device list can't:

| You see | It means |
| --- | --- |
| Parsed contacts with sensible coordinates | Working. |
| Bytes arriving, `contacts: null` | Panel fine, layout wrong — `reportId` mismatch or a field size out of range. |
| Bytes arriving, `0 contacts` while touching | Tip-switch offset wrong. |
| No reports, status red | Not a layout problem — read the status hint (permission or cable). |

On a configured kiosk, blank out `url` to get back to the test page.
`DIAGNOSE=1` prints all HID devices to stdout (run the packaged binary from
Terminal to see it).

If a panel won't come up, keep three things and it can be profiled later
without the hardware: `hid-descriptors.json` (**Save raw descriptors**), the
`DIAGNOSE=1` output, and what the status line and live reports said.

## How it works

`finger → panel → USB HID → node-hid → parse.js (layout-driven bit reader) →
diff to touchStart/Move/End → webContents.debugger →
Input.dispatchTouchEvent → renderer`. The page is a normal web page; it never
knows a USB panel drives it. The agent injects `touch-action: pan-x pan-y` and
`overscroll-behavior: none` on every document (plus
`setVisualZoomLevelLimits(1,1)`) to suppress page pinch-zoom and rubber-banding
while keeping scroll and multitouch.

## License

MIT — see [LICENSE](LICENSE). Bundled fonts (Space Grotesk, Instrument Serif)
are under the SIL Open Font License, included in `src/fonts/`.
