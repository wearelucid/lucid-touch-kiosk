const test = require('node:test')
const assert = require('node:assert/strict')
const { consoleLine, exceptionLine } = require('../src/pageconsole')

// Payloads as recorded from Electron 44's DevTools protocol (Runtime domain).
const frame = (lineNumber) => ({ callFrames: [{ url: 'https://www.tbf.ch/chunk.js', lineNumber }] })

test('a DOMException argument keeps its name and message', () => {
  // What Electron's console-message reduces to "[object DOMException]".
  const line = consoleLine({
    type: 'error',
    args: [
      { type: 'string', value: 'Failed to reconnect to last port:' },
      { type: 'object', subtype: 'error', className: 'DOMException', description: 'InvalidStateError: The port is already open.' },
    ],
    stackTrace: frame(7),
  })
  assert.deepEqual(line, {
    level: 'error',
    text: 'Failed to reconnect to last port: InvalidStateError: The port is already open. (https://www.tbf.ch/chunk.js:8)',
  })
})

test('an error argument is reduced to its first line — the stack stays out of the log', () => {
  const line = consoleLine({
    type: 'error',
    args: [{ type: 'object', subtype: 'error', className: 'TypeError', description: 'TypeError: x is undefined\n    at a (b.js:1:2)\n    at c' }],
    stackTrace: frame(0),
  })
  assert.equal(line.text, 'TypeError: x is undefined (https://www.tbf.ch/chunk.js:1)')
})

test('warnings map to warn, numbers print as numbers', () => {
  const line = consoleLine({
    type: 'warning',
    args: [{ type: 'string', value: 'plain warning' }, { type: 'number', value: 42, description: '42' }],
    stackTrace: frame(2),
  })
  assert.deepEqual(line, { level: 'warn', text: 'plain warning 42 (https://www.tbf.ch/chunk.js:3)' })
})

test('plain objects, null and undefined get readable stand-ins', () => {
  const line = consoleLine({
    type: 'error',
    args: [
      { type: 'object', className: 'Object', description: 'Object' },
      { type: 'object', subtype: 'null', value: null },
      { type: 'undefined' },
    ],
  })
  assert.equal(line.text, 'Object null undefined')
})

test('log, info and debug are not logged', () => {
  for (const type of ['log', 'info', 'debug', 'dir', 'table']) {
    assert.equal(consoleLine({ type, args: [{ type: 'string', value: 'x' }] }), null)
  }
})

test('a failed console.assert is an error', () => {
  assert.equal(consoleLine({ type: 'assert', args: [{ type: 'string', value: 'Assertion failed' }] }).level, 'error')
})

test('%c styling is dropped together with its style argument', () => {
  // As Electron's own security warning arrives: "%cElectron Security Warning…", "font-weight: bold;", "…".
  const line = consoleLine({
    type: 'warning',
    args: [
      { type: 'string', value: '%cElectron Security Warning' },
      { type: 'string', value: 'font-weight: bold;' },
      { type: 'string', value: 'details' },
    ],
  })
  assert.equal(line.text, 'Electron Security Warning details')
})

test('%s and %d are substituted like the browser console does', () => {
  const line = consoleLine({
    type: 'error',
    args: [
      { type: 'string', value: 'port %s failed after %d tries' },
      { type: 'string', value: 'cu.usbmodem1' },
      { type: 'number', value: 3, description: '3' },
    ],
  })
  assert.equal(line.text, 'port cu.usbmodem1 failed after 3 tries')
})

test('an uncaught exception reads like the browser reports it', () => {
  const line = exceptionLine({
    exceptionDetails: {
      text: 'Uncaught (in promise)',
      lineNumber: 6,
      url: 'https://www.tbf.ch/chunk.js',
      exception: { type: 'object', subtype: 'error', className: 'TypeError', description: 'TypeError: rejected promise\n    at x' },
    },
  })
  assert.deepEqual(line, {
    level: 'error',
    text: 'Uncaught (in promise) TypeError: rejected promise (https://www.tbf.ch/chunk.js:7)',
  })
})

test('an exception without an exception object falls back to its text', () => {
  const line = exceptionLine({ exceptionDetails: { text: 'Uncaught SyntaxError: Unexpected token', lineNumber: 0, url: '' } })
  assert.equal(line.text, 'Uncaught SyntaxError: Unexpected token')
})

// ---- routing between console-message and the protocol ------------------------
const { createConsoleRouter } = require('../src/pageconsole')

const router = () => {
  const out = []
  const r = createConsoleRouter((e) => out.push(e.text))
  return { r, out }
}
const fallbackEntry = { level: 'error', text: 'Failed to connect: [object DOMException]' }
const replayed = (timestamp) => ({
  type: 'error',
  timestamp,
  args: [
    { type: 'string', value: 'Failed to connect:' },
    { type: 'object', subtype: 'error', className: 'DOMException', description: 'SecurityError: Must be handling a user gesture' },
  ],
})

test('a message from before the protocol is logged once, with its details from the replay', () => {
  // The page logs at startup, before the touch agent attaches the debugger.
  const { r, out } = router()
  r.fromConsoleMessage(fallbackEntry, false) // held back
  r.protocolEnabled(2000) // Runtime.enable: context created first (measured) …
  r.fromProtocol('Runtime.consoleAPICalled', replayed(1000)) // … then the replay
  assert.deepEqual(out, ['Failed to connect: SecurityError: Must be handling a user gesture'])
})

test('if the protocol never comes, the held-back messages are logged as they are', () => {
  const { r, out } = router()
  r.fromConsoleMessage(fallbackEntry, false)
  r.fallBack()
  assert.deepEqual(out, ['Failed to connect: [object DOMException]'])
})

test('with the protocol active, console-message is ignored — nothing twice', () => {
  const { r, out } = router()
  r.protocolEnabled(1000)
  r.fromConsoleMessage(fallbackEntry, true)
  r.fromProtocol('Runtime.consoleAPICalled', replayed(3000))
  assert.equal(out.length, 1)
  assert.match(out[0], /SecurityError/)
})

test('after the debugger detaches, console-message is logged directly again', () => {
  const { r, out } = router()
  r.protocolEnabled(1000)
  r.fallBack() // detach
  r.fromConsoleMessage(fallbackEntry, false)
  assert.deepEqual(out, ['Failed to connect: [object DOMException]'])
})

test('re-attaching after direct logging skips the replay of what was already logged', () => {
  // A reload after a renderer crash: messages before the new attach went out
  // through console-message; the replay must not repeat them.
  const { r, out } = router()
  r.fallBack()
  r.fromConsoleMessage(fallbackEntry, false) // logged directly
  r.protocolEnabled(5000)
  r.fromProtocol('Runtime.consoleAPICalled', replayed(4000)) // replay of the same → skipped
  r.fromProtocol('Runtime.consoleAPICalled', replayed(6000)) // new → logged
  assert.equal(out.length, 2)
  assert.match(out[1], /SecurityError/)
})

test('a new execution context (navigation) does not reset an active protocol', () => {
  const { r, out } = router()
  r.protocolEnabled(1000)
  r.protocolEnabled(9000) // every navigation creates a context
  r.fromProtocol('Runtime.consoleAPICalled', replayed(5000))
  assert.equal(out.length, 1)
})

test('other protocol events are ignored', () => {
  const { r, out } = router()
  r.protocolEnabled(0)
  r.fromProtocol('Runtime.executionContextDestroyed', { timestamp: 1 })
  r.fromProtocol('Page.frameNavigated', {})
  assert.equal(out.length, 0)
})
