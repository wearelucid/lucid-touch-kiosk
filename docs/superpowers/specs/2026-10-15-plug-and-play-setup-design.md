# Plug-and-play setup — design

**Date:** 2026-10-15
**Status:** draft for review
**Scope:** first-run setup, panel detection, serial device acceptance, and the way back
into setup from a running kiosk. Out of scope: the quarantine flag (needs an installer
script, decided "later"), signing, mirrored touch axes.

## Goal

An operator who has never seen the app should be able to unzip it, open it, plug in the
touchscreen and (optionally) a serial device, type the URL and have a working kiosk —
without reading the README, editing `config.json`, or knowing what Input Monitoring is.
The same screen should later tell a technician *which* of those things broke on a kiosk
they cannot see working.

## Core idea: a checklist that ticks itself

The setup is **one page with five steps**, shown as a vertical list of cards. There is no
"Next" button. Each step's state is **derived live from the system** (config file +
touch-agent status + display list + serial ports), never from a stored step counter. The
operator's job is physical: plug things in, click "Allow", tap corners. The app notices
when a step is satisfied and expands the next one.

Consequences that fall out of this:

- **Setup and diagnostics are the same view.** A kiosk that lost touch two months later
  shows the same checklist with step 3 red. Section *7 · Touch panel diagnostics* and
  *8 · Serial devices* of today's test page are absorbed into steps 3 and 4.
- **A relaunch mid-setup is harmless.** Step 2 needs one (a permission grant does not
  reach a running process); the list rebuilds from config and system state and lands on
  step 3.
- **The state logic is pure and testable.** `src/setup-state.js` takes plain inputs and
  returns per-step states; nothing in it touches Electron or the DOM.

### Step states

Each step is one of `done`, `active` (the first step that is not done — expanded, with
its controls), `blocked` (active, and the system says why it cannot proceed), `skipped`
(serial only), or `pending` (later than the active one — collapsed, greyed). A `done`
step collapses to a one-line summary with a **Change** link that re-expands it without
undoing anything.

## The five steps

### 1 · Display

**Done when** `config.displayIndex` points at a display that currently exists.

**Automatic when** there is exactly one display, or exactly one *external* display (the
touchscreen is practically always external): the app picks it and the step is done before
the operator sees it. Only when it is ambiguous (two externals, or an external plus a
built-in on a MacBook with the lid open where the external is not obviously the panel)
does the existing small display-picker window appear, unchanged in content.

**Card:** "Display 1 — 1920×1080, external". **Change** cycles the setup window to the
next display (`kiosk:save {displayIndex}` + window recreate, both exist). The choice is
confirmed implicitly in step 3: if the corner taps land on this window, it was the right
display.

### 2 · Permission (Input Monitoring)

**Done when** the touch agent reports `inputMonitoring: 'granted'`. Opening the panel
successfully is proof too (the agent already sets `granted` in that case).

**Blocked when** it reports `denied`, or reports `unknown` *and* the panel exists but
would not open. (`unknown` means no keyboard/mouse was available as a reference device —
a real case on a headless Mac mini. Alone it is not blocking; step 3's open attempt
decides.)

**The macOS prompt.** The first HID open triggers the TCC dialog. It appears over the
setup page within a second of launch, so the card's text is already visible beneath it:
*"macOS will ask whether this app may monitor input. That is how it reads the touchscreen.
Click Allow."* Deferring the agent start until the operator clicks something would be
cleaner but breaks the dom-ready/agent pairing invariant; not worth it.

**When blocked, the card shows, in this order:**

1. *Open System Settings* (existing deep link). Text: "Enable Lucid Touch Kiosk. If it is
   not listed, add it with +."
2. **Relaunch app** — large, primary. Text: "A permission granted while the app is running
   does not reach it."
3. Small print: the Bluetooth prompt macOS 14+ shows during HID enumeration — *Don't
   Allow* is correct, the panel is USB.

After a rebuild the grant is bound to the old binary; the existing hint about removing
and re-adding the entry stays, under a *Still not working?* disclosure.

### 3 · Touch panel

**Done when** the agent's status is `open` **and** the panel has been verified once
(`config.touchVerified === true`, see below).

**No more "Detect" button.** When the step is active and no panel is open, the page runs
the WebHID derivation itself every 2 s: `navigator.hid.getDevices()` → `kiosk:deriveLayout`
(the existing pure path). Outcomes:

| Situation | Behaviour |
|---|---|
| No panel in config, exactly one digitizer derived | Save automatically (`kiosk:savePanel`), window recreates, agent opens it. Card: "Found *Samsung Flip* — using it." |
| A panel in config, agent says `not-found`, a different single digitizer derived | Card offers **Use this panel instead** (one click → `savePanel`). Not automatic: replacing a configured panel is a decision. |
| Several digitizers | List by product name and ids; click → `savePanel`. |
| No digitizer among the HID devices | "No touchscreen found. Check the USB cable or hub." The step completes itself when one appears. The HID device table (today's *Details*) is available under a disclosure for the curious. |
| Derivation rejected for every candidate | The existing fallback: the error text, **Save raw descriptors**, and a pointer to the README's manual `touchReport` section. |
| Panel listed, permission fine, won't open (`device-busy`) | Existing hint (close browsers holding a WebHID connection) + **Re-scan**. |

This requires `DEFAULTS.hidVendorId/hidProductId` to become `null` — the current SiS
defaults make every other panel report "not found" against ids the operator never chose.
`SIS_LAYOUT` stays as the `touchReport` fallback so an existing `config.json` that carries
the SiS ids without a layout keeps working.

**Verification (the corner taps).** Once the panel is open the card says *"Tap the four
corners and the centre."* The existing corner marks light up as they are hit; the card
counts "3 / 5". At 5 / 5 the page saves `touchVerified: true` and the step is done. If a
tap lands far from the mark (> 60 px, the existing per-mark error readout), the card
shows the four rotations as buttons with the current one highlighted; each applies live
through the existing `touchRotation` save path, no relaunch. A fresh `savePanel` resets
`touchVerified` to `false` — a new panel is unverified by definition.

Why persist verification: a relaunch between step 3 and 4 (or after the window recreate
`savePanel` causes) must not ask for the five taps again, and on the later diagnostics
visit the step must read as done without a ritual. Why require it at all: it is the only
thing that catches a rotated or mirrored mounting and a wrong display before the kiosk
goes live.

**Details disclosure** (collapsed): HID device table, live reports with the parser
verdict, active layout, log path and *Open log folder* — everything today's section 7
*Details* shows, unchanged.

### 4 · Serial devices (skippable)

**Done when** `config.serialDevices` is non-empty, or `config.serialSkipped === true`.
**Skipped** is shown as done with the summary "No serial devices" and **Change**.

**Card text:** *"Printer, scanner, sensor? Plug it in now — it appears below."* On
entering the step the page calls `requestPort()` itself, which parks Electron's chooser
callback as today and makes the port list live (`serial-port-added/-removed` already feed
it). Each listed port has **Test**, which opens the existing probe (baud rate, raw bytes),
then **Accept**. Accepted models are listed above with **Remove**. Button **No devices,
continue** sets `serialSkipped`.

Leaving the step (it becomes done or the operator moves on) answers the parked chooser
with `''` so no callback is left hanging — the existing `destroyed` handler covers the
window-close case, this adds the navigate-away case.

### 5 · URL and start

**Done when** `config.url` is non-empty — which is also the condition under which the app
boots straight into kiosk mode, so this step is only ever active in setup.

**Card:** URL field, zoom field (live preview, existing), then **Check** and **Start kiosk**.
*Check* asks the main process to fetch the normalized URL (`net.fetch`, 5 s timeout,
HEAD then GET on 405) and reports "reachable (200)" / "DNS failed" / "timed out" — not a
render test, but it catches the typo before it becomes a black fullscreen. *Start kiosk*
is the existing `kiosk:launch`.

## The way back from kiosk mode

A kiosk must be re-enterable for a panel swap or a new serial device without editing
`config.json`. Two triggers, both handled in the main process so the kiosk page never
gets a preload:

- **Keyboard:** `⌘⇧,` via `before-input-event` on the kiosk window's `webContents`.
- **Touch:** five fingers held still for 3 s. Detected in the touch agent, which already
  sees every contact; the hold logic is a pure function in `src/gesture.js` (contacts +
  timestamps in, `true` once per hold out) so it can be tested without a panel. Enabled
  only when `maxTouchPoints >= 5`; on two-finger panels a two-finger hold is an ordinary
  visitor action, so there the shortcut is the only way in.

Either trigger calls `createKioskWindow(pending, { test: true })`: the setup page replaces
the kiosk window through the existing swap (window count never hits 0, agent pairing
intact). `config.url` is left untouched, so the checklist opens with all five steps done,
step 5 expanded, and a **Back to kiosk** button; and if the Mac restarts meanwhile it
boots into the kiosk, not into setup. After 10 minutes without a pointer event on the
setup page while `config.url` is set, the page launches the kiosk itself — a technician
who walks away must not leave the checklist in front of visitors.

## Page layout

`src/testpage.html` is restructured, not rewritten; the test targets and their scripts
move, they don't change.

```
┌ Lucid Touch Kiosk — Setup ─────────────────────────────┐
│ ● 1 Display        Display 1 — 1920×1080      Change   │
│ ● 2 Permission     granted                             │
│ ○ 3 Touch panel    ← active, expanded                  │
│     Found Samsung Flip (25b5:0054) — panel open.        │
│     Tap the four corners and the centre.   3 / 5       │
│     ▸ Details                                          │
│ ○ 4 Serial devices                                     │
│ ○ 5 URL and start                                      │
├────────────────────────────────────────────────────────┤
│ Try it out  (visible once step 3 is open)              │
│ 1 Tap targets · 2 Scroll · 3 Multitouch · 4 Pinch ·    │
│ 5 Slider · 6 Drag                                      │
└────────────────────────────────────────────────────────┘
  TL / TR / BL / BR / C corner marks as today, over everything
```

The telemetry strip (last event, counters, viewport) stays at the top: it is the first
sign of life and costs nothing.

UI language stays English, as the page is today.

## Modules and changes

| File | Change |
|---|---|
| `src/setup-state.js` **(new, pure)** | `deriveSteps({ config, displays, status, serialPorts, cornersHit })` → `[{ id, state, summary, reason }]`. Also `pickDisplay(displays)` → index or `null` when ambiguous. Unit-tested: every row of the step tables above is a test case. |
| `src/gesture.js` **(new, pure)** | `createHoldDetector({ fingers, holdMs, maxDriftPx })` → `feed(contacts, now)` returns `true` once per hold. Unit-tested with synthetic contact sequences (drift, finger lifted early, re-arm after release). |
| `src/derive.js` | Add `deriveAllDevices(devices)` → `{ hits, errors }` (no throw) so the page can list several digitizers. `deriveFromDevices` stays as is for the existing IPC. Tested. |
| `src/touch-agent.js` | `null` vid/pid → status `not-configured` (distinct from `not-found`: the message must not print `0000:0000`). Optional `onGesture` callback wired to the hold detector; only created when `maxTouchPoints >= 5`. |
| `src/main.js` | `DEFAULTS` ids `null`; `touchVerified`, `serialSkipped` in `kiosk:save`; `savePanel` resets `touchVerified`; `pickDisplay` before `enterDisplayPicker`; `kiosk:checkUrl`; an internal `openSetup()` called from the shortcut handler and the gesture callback (not IPC — the kiosk page has no bridge); `kiosk:cancelSerialChooser`. |
| `src/preload.js` | `checkUrl`, `cancelSerialChooser`. |
| `src/testpage.html` | Checklist markup + a small renderer that calls `deriveSteps` with the live inputs and patches the cards; auto-derivation loop in step 3; corner counting; idle timer. Sections 7/8 dissolve into steps 3/4. |
| `README.md`, `CLAUDE.md` | Install section becomes "open it and follow the checklist"; architecture notes for the two new modules and the kiosk→setup path. |

`setup-state.js` runs in the renderer (it is pure, so it can be loaded by the page with a
`<script>`; its `module.exports` is guarded by `typeof module !== 'undefined'` so the same
file serves `node --test`), which keeps the step logic next to the cards and off the IPC
surface. The
main process does not need the step states; it only persists facts.

## Config additions

```json
{
  "hidVendorId": null,          // was 1111 — no panel assumed until derived
  "hidProductId": null,
  "touchVerified": false,       // five corner taps landed; reset by savePanel
  "serialSkipped": false        // operator said "no serial devices"
}
```

Existing config files without these keys behave as before: SiS ids with a missing
`touchReport` still get `SIS_LAYOUT`; a missing `touchVerified` means step 3 asks for the
taps once; a missing `serialSkipped` with an empty device list means step 4 is active in
setup, which is correct for a config written by an older version.

## Error handling

- Every blocked state names the evidence, as the agent does today (`not-found` vs
  `input-monitoring` vs `device-busy` are kept, `not-configured` is added). No step shows
  a generic "something went wrong".
- The auto-derivation loop stops while a `savePanel` is in flight and after a successful
  open; it never saves twice.
- `checkUrl` failures are informational; *Start kiosk* is never disabled by them (an
  intranet URL may be unreachable from the setup moment and fine at boot — the kiosk's
  reload-with-backoff handles that).
- The 10-minute idle return applies only when `config.url` is set; a first-time setup is
  never interrupted.

## Testing

- `npm test`: `setup-state` (all table rows, resumption after relaunch, `unknown`
  permission cases), `gesture` (hold, drift, early lift, re-arm), `derive.all`.
- Manual, on the packaged build launched with `open` (a shell launch skews TCC):
  1. Fresh machine state (remove the Input Monitoring entry, delete `config.json`): zip →
     open → checklist → deny the prompt → step 2 blocked → settings → relaunch → step 3
     auto-detects the Flip → 5 taps → skip serial → URL → kiosk.
  2. Same with the SiS panel, and with no panel attached (step 3 waits, plug in, proceeds).
  3. From the running kiosk: `⌘⇧,` and the five-finger hold both open the checklist with
     everything green; *Back to kiosk* and the 10-minute idle both return.
  4. An old `config.json` (SiS ids, no `touchReport`, no new keys) boots into the kiosk
     unchanged.

## Decisions taken in review

- Checklist, not a multi-screen wizard.
- Return path from kiosk mode is in scope (shortcut + five-finger hold).
- Serial is a skippable step, not hidden under "advanced".
- Installer script for the quarantine flag: later, separate spec.
