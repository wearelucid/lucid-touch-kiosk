// Turn the page's console output, as the DevTools protocol reports it, into
// one log line. Pure — no Electron — so the formatting is unit-tested against
// payloads recorded from Electron 44.
//
// Electron's own console-message event hands over a finished string in which
// objects have already become "[object DOMException]" — exactly the part that
// says what went wrong. The protocol's Runtime.consoleAPICalled keeps each
// argument separate, and an error arrives with its description
// ("InvalidStateError: The port is already open.").

// Only what someone diagnosing a kiosk needs; log/info/debug would drown it.
const LEVELS = { error: 'error', assert: 'error', warning: 'warn' }

const firstLine = (s) => String(s).split('\n')[0]

/** One console argument as text. */
function describe(arg) {
  if (!arg) return ''
  if (arg.type === 'string') return arg.value
  if (arg.type === 'undefined') return 'undefined'
  if (arg.subtype === 'null') return 'null'
  if (arg.type !== 'object' && arg.type !== 'function' && 'value' in arg) return String(arg.value)
  const text = arg.description || arg.className || arg.type
  // An error's description continues with its stack; the first line is what
  // happened, and the call site is already appended to the log line.
  return arg.subtype === 'error' ? firstLine(text) : text
}

/**
 * Join the arguments like the browser console: printf-style %s/%d/%i/%f/%o/%O
 * in the first string take the next arguments, %c takes its style argument
 * and prints nothing, the rest are appended with spaces.
 */
function formatArgs(args) {
  const rest = [...(args || [])]
  const first = rest.shift()
  if (!first) return ''
  if (first.type !== 'string') return [first, ...rest].map(describe).join(' ')
  const head = first.value.replace(/%[sdifoOc%]/g, (spec) => {
    if (spec === '%%') return '%'
    const arg = rest.shift()
    if (spec === '%c') return ''
    return arg === undefined ? spec : describe(arg)
  })
  return [head, ...rest.map(describe)].filter((s) => s !== '').join(' ')
}

// The protocol counts lines from 0; editors and Electron's own event from 1.
const where = (url, lineNumber) => (url ? ` (${url}:${(lineNumber || 0) + 1})` : '')

/**
 * @param {object} params a Runtime.consoleAPICalled event
 * @returns {{ level: 'error'|'warn', text: string } | null} null for levels not logged
 */
function consoleLine(params) {
  const level = LEVELS[params.type]
  if (!level) return null
  const frame = ((params.stackTrace && params.stackTrace.callFrames) || [])[0] || {}
  return { level, text: formatArgs(params.args) + where(frame.url, frame.lineNumber) }
}

/**
 * @param {object} params a Runtime.exceptionThrown event — an uncaught error
 *   or an unhandled promise rejection in the page
 * @returns {{ level: 'error', text: string }}
 */
function exceptionLine(params) {
  const d = params.exceptionDetails || {}
  const what = d.exception ? describe(d.exception) : ''
  const text = [d.text, what].filter(Boolean).join(' ')
  return { level: 'error', text: text + where(d.url, d.lineNumber) }
}

/**
 * Decide, per message, whether it goes out through Electron's console-message
 * or through the protocol — never both, and never neither.
 *
 * The protocol is only available once the touch agent has attached the
 * debugger (on dom-ready), but a page often complains earliest at startup. So
 * console-message entries are held back until then: enabling the Runtime
 * domain first reports the execution context, then replays every earlier
 * message with its details (order measured), and the held-back copies are
 * dropped. If the protocol never arrives, `fallBack()` logs them as they are.
 * After a detach, console-message is logged directly; should the protocol come
 * back (a reload after a renderer crash), its replay of what was already
 * logged is skipped by timestamp.
 *
 * @param {(entry: {level: 'error'|'warn', text: string}) => void} emit
 */
function createConsoleRouter(emit) {
  let mode = 'waiting' // 'waiting' → held back · 'protocol' · 'direct'
  let held = []
  let skipBefore = 0

  return {
    /** Electron's console-message, already reduced to an entry (or null). */
    fromConsoleMessage(entry, debuggerAttached) {
      if (!entry) return
      if (mode === 'protocol' && debuggerAttached) return
      if (mode === 'waiting') held.push(entry)
      else emit(entry)
    },
    /** Runtime.executionContextCreated — the protocol is live and replays from here. */
    protocolEnabled(at) {
      if (mode === 'protocol') return
      // Coming from direct logging, everything before now has already gone out.
      skipBefore = mode === 'direct' ? at : 0
      mode = 'protocol'
      held = []
    },
    /** Any debugger message; only console calls and exceptions produce a line. */
    fromProtocol(method, params) {
      if (method !== 'Runtime.consoleAPICalled' && method !== 'Runtime.exceptionThrown') return
      if (params.timestamp < skipBefore) return
      const entry = method === 'Runtime.consoleAPICalled' ? consoleLine(params) : exceptionLine(params)
      if (entry) emit(entry)
    },
    /** The protocol is gone (detach) or never came: log what was held back, then directly. */
    fallBack() {
      held.forEach(emit)
      held = []
      mode = 'direct'
    },
    /** Still waiting after the agent should long have attached. */
    giveUpWaiting() {
      if (mode === 'waiting') this.fallBack()
    },
  }
}

module.exports = { consoleLine, exceptionLine, createConsoleRouter }
