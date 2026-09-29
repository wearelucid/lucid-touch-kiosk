// A log file that stays readable and bounded on a kiosk that runs for months.
//
// Two things make a naive log useless there: a retry loop (the touch agent
// retries every 2 s while the panel is missing — 43 200 lines a day) buries
// the one line that matters, and the file grows without limit. So a message
// that recurs within a minute of its previous occurrence is counted instead of
// written — whatever came in between, because retry paths alternate between
// messages ("opening …", "not granted") — and the count is written once the
// repeat goes quiet, hourly while it lasts, and on quit. The file rotates by
// size: kiosk.log → kiosk.1.log … kiosk.<keep>.log, oldest dropped.
//
// Writes are synchronous so the last lines before a crash are on disk; after
// collapsing, the volume is far too low for that to cost anything. Logging
// must never take the app down, so every failure here is swallowed.

const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')

const pad = (n, w = 2) => String(n).padStart(w, '0')
const stamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/**
 * @param {object} opts
 * @param {string} opts.dir directory for the log files
 * @param {number} [opts.maxBytes] rotate once kiosk.log would exceed this (default 5 MB)
 * @param {number} [opts.keep] rotated files kept besides kiosk.log (default 4 → max 25 MB)
 * @param {number} [opts.quietMs] a message recurring within this long of its last occurrence is counted
 * @param {number} [opts.repeatSummaryMs] while a message keeps repeating, report the count this often
 * @param {() => Date} [opts.now] clock, injectable for tests
 * @param {(line: string) => void} [opts.echo] also receives every line (stdout by default)
 */
function createLogger({
  dir,
  file = 'kiosk.log',
  maxBytes = 5 * 1024 * 1024,
  keep = 4,
  quietMs = 60 * 1000,
  repeatSummaryMs = 60 * 60 * 1000,
  now = () => new Date(),
  echo = (line) => process.stdout.write(line + '\n'),
} = {}) {
  const target = dir ? path.join(dir, file) : null
  let writable = Boolean(target)
  let size = 0
  if (writable) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      size = fs.existsSync(target) ? fs.statSync(target).size : 0
      fs.accessSync(dir, fs.constants.W_OK)
    } catch {
      writable = false
    }
  }

  const rotated = (i) => path.join(dir, file.replace(/\.log$/, '') + '.' + i + '.log')
  function rotate() {
    try {
      fs.rmSync(rotated(keep), { force: true })
      for (let i = keep - 1; i >= 1; i--) if (fs.existsSync(rotated(i))) fs.renameSync(rotated(i), rotated(i + 1))
      fs.renameSync(target, rotated(1))
    } catch {
      /* a failed rotation just means a larger file — never a crash */
    }
    size = 0
  }

  function write(level, area, text, at) {
    const line = `${stamp(at)}  ${level.padEnd(5)}  ${area.padEnd(7)}  ${text}`
    try {
      echo(line)
    } catch {}
    if (!writable) return
    const bytes = Buffer.byteLength(line) + 1
    if (size > 0 && size + bytes > maxBytes) rotate()
    try {
      fs.appendFileSync(target, line + '\n')
      size += bytes
    } catch {}
  }

  // Messages seen within the last `quietMs`, least recently seen first (a hit
  // re-inserts its key), so the quiet ones sit at the front and a sweep stops
  // at the first one still active. Capped, so a page logging endless unique
  // lines can't grow it without bound.
  const recent = new Map()
  const MAX_TRACKED = 500

  function summarize(r, at) {
    if (r.count === 0) return
    write(r.level, r.area, `${r.text} — repeated ${r.count}× since ${clock(r.since)}`, at)
    r.count = 0
    r.summarizedAt = at
  }

  function sweep(at) {
    for (const [key, r] of recent) {
      if (at - r.lastSeen < quietMs && recent.size <= MAX_TRACKED) break
      summarize(r, at)
      recent.delete(key)
    }
  }

  function entry(level, area, args) {
    const at = now()
    const text = util.format(...args)
    const key = level + '\u0000' + area + '\u0000' + text
    sweep(at)
    const r = recent.get(key)
    if (r) {
      if (r.count === 0) r.since = at
      r.count++
      r.lastSeen = at
      recent.delete(key)
      recent.set(key, r)
      if (at - r.summarizedAt >= repeatSummaryMs) summarize(r, at)
      return
    }
    write(level, area, text, at)
    recent.set(key, { level, area, text, lastSeen: at, count: 0, since: at, summarizedAt: at })
  }

  return {
    /** Path of the current log file, or null if the location isn't writable. */
    path: writable ? target : null,
    info: (area, ...a) => entry('INFO', area, a),
    warn: (area, ...a) => entry('WARN', area, a),
    error: (area, ...a) => entry('ERROR', area, a),
    /** Write out pending repeat counts — call before quitting. */
    flush: () => {
      const at = now()
      for (const r of recent.values()) summarize(r, at)
    },
  }
}

module.exports = { createLogger }
