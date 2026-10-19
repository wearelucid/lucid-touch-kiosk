const test = require('node:test')
const assert = require('node:assert/strict')
const { createHoldDetector } = require('../src/gesture')

const five = (dx = 0, ids = [1, 2, 3, 4, 5]) => ids.map((id, i) => ({ id, x: 100 * i + dx, y: 500 }))

test('five still fingers for holdMs fire once, then not again until released', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000, maxDriftPx: 40 })
  assert.equal(d.feed(five(), 0), false)
  assert.equal(d.feed(five(), 1500), false)
  assert.equal(d.feed(five(), 3000), true)
  assert.equal(d.feed(five(), 3100), false)
  assert.equal(d.feed(five(), 9000), false)
  assert.equal(d.feed([], 9100), false) // release
  assert.equal(d.feed(five(), 9200), false)
  assert.equal(d.feed(five(), 12200), true) // re-armed
})

test('fewer than five fingers never fires', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000 })
  const four = five().slice(0, 4)
  for (let t = 0; t <= 10000; t += 500) assert.equal(d.feed(four, t), false)
})

test('drift beyond maxDriftPx restarts the hold', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000, maxDriftPx: 40 })
  d.feed(five(), 0)
  assert.equal(d.feed(five(60), 1000), false) // moved → restart at 1000
  assert.equal(d.feed(five(60), 3000), false) // only 2000 since the restart
  assert.equal(d.feed(five(60), 4000), true)
})

test('an early lift resets; a changed contact id restarts the hold', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 3000 })
  d.feed(five(), 0)
  d.feed(five().slice(0, 4), 1000) // one finger lifted
  assert.equal(d.feed(five(), 1100), false)
  assert.equal(d.feed(five(), 3500), false) // 2400 since re-touch
  assert.equal(d.feed(five(), 4100), true)
  const e = createHoldDetector({ fingers: 5, holdMs: 3000 })
  e.feed(five(), 0)
  e.feed(five(0, [1, 2, 3, 4, 6]), 1000) // id 5 renumbered to 6
  assert.equal(e.feed(five(0, [1, 2, 3, 4, 6]), 3000), false)
  assert.equal(e.feed(five(0, [1, 2, 3, 4, 6]), 4000), true)
})

test('more than five fingers count as a hold too', () => {
  const d = createHoldDetector({ fingers: 5, holdMs: 1000 })
  const six = five().concat([{ id: 6, x: 900, y: 500 }])
  d.feed(six, 0)
  assert.equal(d.feed(six, 1000), true)
})
