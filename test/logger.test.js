const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLogger } = require('../src/logger')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-log-'))
const read = (dir, f = 'kiosk.log') => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')
const quiet = { echo: () => {} }

// A clock the test moves by hand, so an hour of retries takes no real time.
function fakeClock(start = new Date(2026, 8, 29, 14, 0, 0)) {
  let t = start.getTime()
  const now = () => new Date(t)
  now.advance = (ms) => { t += ms }
  return now
}

test('writes one line with time, level, area and message', () => {
  const dir = tmp()
  const log = createLogger({ dir, now: fakeClock(), ...quiet })
  log.warn('serial', 'refused a port request from', 'http://x')
  assert.deepEqual(read(dir), ['2026-09-29 14:00:00.000  WARN   serial   refused a port request from http://x'])
})

test('a message repeating within a minute is counted, not written', () => {
  const dir = tmp()
  const now = fakeClock()
  const log = createLogger({ dir, now, ...quiet })
  for (let i = 0; i < 1000; i++) { log.warn('touch', 'touchscreen not found'); now.advance(2000) }
  log.flush()
  const lines = read(dir)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /WARN   touch    touchscreen not found$/)
  assert.match(lines[1], /touchscreen not found — repeated 999× since 14:00:02$/)
})

test('once a repeat goes quiet for a minute, its count is written', () => {
  const dir = tmp()
  const now = fakeClock()
  const log = createLogger({ dir, now, ...quiet })
  for (let i = 0; i < 10; i++) { log.warn('touch', 'touchscreen not found'); now.advance(2000) }
  now.advance(61000)
  log.info('touch', 'connected')
  const lines = read(dir)
  assert.equal(lines.length, 3)
  assert.match(lines[1], /repeated 9×/)
  assert.match(lines[2], /INFO   touch    connected$/)
})

test('two alternating retry messages collapse too', () => {
  // Panel present but permission missing: the agent alternates "opening" and
  // "not granted" every 2 s — consecutive-only deduplication would let both through.
  const dir = tmp()
  const now = fakeClock()
  const log = createLogger({ dir, now, ...quiet })
  for (let i = 0; i < 1000; i++) {
    log.info('touch', 'opening Samsung HID Multi-Touch')
    log.warn('touch', 'Input Monitoring is not granted')
    now.advance(2000)
  }
  log.flush()
  const lines = read(dir)
  assert.equal(lines.length, 4)
  assert.equal(lines.filter((l) => l.includes('repeated 999×')).length, 2)
})

test('a sporadic event is written every time', () => {
  const dir = tmp()
  const now = fakeClock()
  const log = createLogger({ dir, now, ...quiet })
  log.info('app', 'rescan requested')
  now.advance(10 * 60 * 1000)
  log.info('app', 'rescan requested')
  const lines = read(dir)
  assert.equal(lines.length, 2)
  assert.ok(!lines.some((l) => l.includes('repeated')))
})

test('a retry loop running for hours stays a handful of lines', () => {
  // The touch agent retries every 2 s while the panel is missing: 5400 calls = 3 h.
  const dir = tmp()
  const now = fakeClock()
  const log = createLogger({ dir, now, ...quiet })
  for (let i = 0; i < 5400; i++) { log.warn('touch', 'touchscreen not found'); now.advance(2000) }
  const lines = read(dir)
  assert.ok(lines.length <= 4, `expected a handful of lines, got ${lines.length}`)
  assert.equal(lines.filter((l) => l.includes('repeated')).length, 2) // hourly, while it lasts
})

test('flush writes a pending repeat count (e.g. on quit)', () => {
  const dir = tmp()
  const log = createLogger({ dir, now: fakeClock(), ...quiet })
  log.warn('touch', 'x'); log.warn('touch', 'x'); log.warn('touch', 'x')
  log.flush()
  const lines = read(dir)
  assert.equal(lines.length, 2)
  assert.match(lines[1], /x — repeated 2×/)
})

test('the same text at another level or area is not a repeat', () => {
  const dir = tmp()
  const log = createLogger({ dir, now: fakeClock(), ...quiet })
  log.warn('touch', 'x'); log.error('touch', 'x'); log.error('serial', 'x')
  assert.equal(read(dir).length, 3)
})

test('the log rotates and never grows beyond its files', () => {
  const dir = tmp()
  const log = createLogger({ dir, now: fakeClock(), maxBytes: 2000, keep: 3, ...quiet })
  for (let i = 0; i < 500; i++) log.info('app', 'distinct message number ' + i)
  const files = fs.readdirSync(dir).sort()
  assert.deepEqual(files, ['kiosk.1.log', 'kiosk.2.log', 'kiosk.3.log', 'kiosk.log'])
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 2000, f + ' over the limit')
  assert.match(read(dir).at(-1), /number 499$/) // newest in kiosk.log
  assert.ok(!files.some((f) => read(dir, f).some((l) => /number 0$/.test(l)))) // oldest dropped
})

test('a restart appends to the existing log and keeps counting its size', () => {
  const dir = tmp()
  const now = fakeClock()
  createLogger({ dir, now, ...quiet }).info('app', 'first run')
  createLogger({ dir, now, ...quiet }).info('app', 'second run')
  assert.equal(read(dir).length, 2)
})

test('errors are written with their stack', () => {
  const dir = tmp()
  const log = createLogger({ dir, now: fakeClock(), ...quiet })
  log.error('app', 'uncaught exception', new Error('boom'))
  const text = fs.readFileSync(path.join(dir, 'kiosk.log'), 'utf8')
  assert.match(text, /uncaught exception Error: boom/)
  assert.match(text, /\n\s+at /)
})

test('an unwritable location never throws — logging must not take the app down', () => {
  const log = createLogger({ dir: '/dev/null/cannot-exist', now: fakeClock(), ...quiet })
  assert.doesNotThrow(() => log.error('app', 'still fine'))
  assert.equal(log.path, null)
})

test('every line is also echoed (stdout for `open --stdout`)', () => {
  const echoed = []
  const log = createLogger({ dir: tmp(), now: fakeClock(), echo: (l) => echoed.push(l) })
  log.info('app', 'hello')
  assert.equal(echoed.length, 1)
  assert.match(echoed[0], /INFO   app      hello$/)
})
