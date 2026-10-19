// Pure: the five setup steps and what state each is in, derived from facts
// (config file, the touch agent's last status, the display list, this
// session's corner taps) — never from a stored "current step". That is what
// lets the same checklist serve first-run setup and later diagnostics, and
// survive a relaunch in the middle.
//
// Runs in the test page (plain <script>) and under node --test, hence the
// guarded module.exports at the bottom.

const STEP_IDS = ['display', 'permission', 'panel', 'serial', 'url']

/**
 * Which display to use without asking: the only one, or the only external
 * one (a touchscreen is practically always external). null = ask.
 * @param {Array<{internal?: boolean}>} displays in screen.getAllDisplays() order
 * @returns {number|null}
 */
function pickDisplay(displays) {
  if (!displays || !displays.length) return null
  if (displays.length === 1) return 0
  const external = []
  displays.forEach((d, i) => {
    if (!d.internal) external.push(i)
  })
  return external.length === 1 ? external[0] : null
}

// Each step reduces to: done? and if not, is the system saying why it can't
// proceed (a block) or merely what it is doing (a reason for the active card)?
function displayStep(config, displays) {
  const i = config.displayIndex
  const done = Number.isInteger(i) && i >= 0 && i < displays.length
  return { done, block: done ? null : 'choose', reason: done ? null : 'choose' }
}

function permissionStep(status) {
  if (!status) return { done: false, block: null, reason: 'waiting' }
  const perm = status.inputMonitoring
  if (status.state === 'open' || perm === 'granted') return { done: true, block: null, reason: null }
  if (perm === 'denied') return { done: false, block: 'denied', reason: 'denied' }
  // 'unknown' = no keyboard/mouse to probe with. Alone it is no verdict; a
  // panel that is listed but won't open turns it into one.
  if (perm === 'unknown' && status.reason === 'device-busy')
    return { done: false, block: 'probably-denied', reason: 'probably-denied' }
  if (perm === 'unknown') return { done: true, block: null, reason: 'unknown' }
  return { done: false, block: null, reason: 'waiting' }
}

function panelStep(config, status, cornersHit) {
  if (!status) return { done: false, block: null, reason: 'waiting' }
  if (status.state === 'open') {
    const verified = config.touchVerified === true || cornersHit >= 5
    return { done: verified, block: null, reason: verified ? null : 'verify' }
  }
  switch (status.reason) {
    case 'not-configured':
    case 'not-found':
      return { done: false, block: null, reason: 'searching' }
    case 'input-monitoring':
    case 'device-busy':
    case 'device-error':
      return { done: false, block: status.reason, reason: status.reason }
    default:
      return { done: false, block: null, reason: 'waiting' }
  }
}

function serialStep(config) {
  const devices = Array.isArray(config.serialDevices) ? config.serialDevices : []
  if (devices.length) return { done: true, block: null, reason: null }
  if (config.serialSkipped === true) return { done: true, skipped: true, block: null, reason: null }
  return { done: false, block: null, reason: null }
}

function urlStep(config) {
  const done = typeof config.url === 'string' && config.url.trim() !== ''
  return { done, block: null, reason: null }
}

/**
 * @param {object} p
 * @param {object} p.config the config as persisted (or pending) — displayIndex,
 *   hid ids, touchVerified, serialDevices, serialSkipped, url
 * @param {Array<{internal?: boolean}>} p.displays
 * @param {{state:string, reason:string|null, inputMonitoring?:string}|null} p.status
 *   the touch agent's last `status` diag event; null before the first one
 * @param {number} p.cornersHit distinct corner marks hit this session (0..5)
 * @returns {{ steps: Array<{id:string, state:string, reason:string|null}>, active: string|null }}
 */
function deriveSteps({ config = {}, displays = [], status = null, cornersHit = 0 } = {}) {
  const facts = {
    display: displayStep(config, displays),
    permission: permissionStep(status),
    panel: panelStep(config, status, cornersHit),
    serial: serialStep(config),
    url: urlStep(config),
  }
  // The first step that is not done is the active one; later unfinished steps
  // wait. Finished steps *after* the active one stay done — on a diagnostics
  // visit the URL is set even though the panel is the problem.
  let active = null
  const steps = STEP_IDS.map((id) => {
    const f = facts[id]
    let state
    if (f.done) state = f.skipped ? 'skipped' : 'done'
    else if (!active) {
      active = id
      state = f.block ? 'blocked' : 'active'
    } else state = 'pending'
    return { id, state, reason: f.reason }
  })
  return { steps, active }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pickDisplay, deriveSteps, STEP_IDS }
}
