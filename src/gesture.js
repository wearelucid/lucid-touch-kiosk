// Pure: "N fingers held still for a while" — the way back into setup from a
// running kiosk, where there is no keyboard and the page gets no bridge. Fed
// every parsed report from the touch agent (contacts already in viewport
// pixels); fires once per hold and re-arms when the fingers come off.

/**
 * @param {object} [opts]
 * @param {number} [opts.fingers=5]    contacts needed
 * @param {number} [opts.holdMs=3000]  how long they must stay
 * @param {number} [opts.maxDriftPx=40] how far any finger may wander
 */
function createHoldDetector({ fingers = 5, holdMs = 3000, maxDriftPx = 40 } = {}) {
  let start = null // { at, points: Map<id, {x,y}> }
  let fired = false

  const restart = (contacts, now) => {
    start = { at: now, points: new Map(contacts.map((c) => [c.id, { x: c.x, y: c.y }])) }
    fired = false
    return false
  }

  return {
    /**
     * @param {Array<{id:number,x:number,y:number}>} contacts current fingers
     * @param {number} now ms timestamp (Date.now() or a test clock)
     * @returns {boolean} true once, the moment the hold completes
     */
    feed(contacts, now) {
      if (!contacts || contacts.length < fingers) {
        start = null
        fired = false
        return false
      }
      if (!start) return restart(contacts, now)
      // Same fingers, still in place? A renumbered id or a wandering finger is
      // a new attempt, not a continuation.
      for (const c of contacts) {
        const p = start.points.get(c.id)
        if (!p || Math.hypot(c.x - p.x, c.y - p.y) > maxDriftPx) return restart(contacts, now)
      }
      if (fired) return false
      if (now - start.at >= holdMs) {
        fired = true
        return true
      }
      return false
    },
  }
}

module.exports = { createHoldDetector }
