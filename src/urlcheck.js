// Pure: turn a fetch outcome into the one-line verdict the URL step shows.
// The fetch lives in main.js (Electron's net); this is the part worth testing.

const ERRORS = [
  ['ERR_NAME_NOT_RESOLVED', 'host name not found (DNS)'],
  ['ERR_CONNECTION_REFUSED', 'connection refused'],
  ['ERR_INTERNET_DISCONNECTED', 'no network'],
  ['ERR_CONNECTION_TIMED_OUT', 'timed out after 5 s'],
  ['ERR_UNKNOWN_URL_SCHEME', 'cannot check this kind of URL — the kiosk may still load it'],
  ['ERR_FILE_NOT_FOUND', 'cannot check this kind of URL — the kiosk may still load it'],
]

function verdictFromResponse(res) {
  const status = res.status
  if (status === 405) return { retryWithGet: true }
  if (status >= 500) return { ok: false, status, error: `server answered ${status}` }
  if (status >= 400) return { ok: true, status, note: `reachable, but the server answered ${status}` }
  return { ok: true, status }
}

function verdictFromError(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    return { ok: false, error: 'timed out after 5 s' }
  const msg = (err && err.message) || String(err)
  for (const [code, text] of ERRORS) if (msg.includes(code)) return { ok: false, error: text }
  return { ok: false, error: msg }
}

module.exports = { verdictFromResponse, verdictFromError }
