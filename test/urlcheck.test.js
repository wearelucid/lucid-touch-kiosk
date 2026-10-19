const test = require('node:test')
const assert = require('node:assert/strict')
const { verdictFromResponse, verdictFromError } = require('../src/urlcheck')

test('2xx/3xx/4xx are reachable, 405 asks for a GET retry', () => {
  assert.deepEqual(verdictFromResponse({ status: 200 }), { ok: true, status: 200 })
  assert.deepEqual(verdictFromResponse({ status: 302 }), { ok: true, status: 302 })
  assert.deepEqual(verdictFromResponse({ status: 404 }), { ok: true, status: 404, note: 'reachable, but the server answered 404' })
  assert.deepEqual(verdictFromResponse({ status: 405 }), { retryWithGet: true })
  assert.deepEqual(verdictFromResponse({ status: 503 }), { ok: false, status: 503, error: 'server answered 503' })
})

test('errors are named, timeouts and DNS in words a non-developer can act on', () => {
  assert.deepEqual(verdictFromError({ name: 'TimeoutError' }), { ok: false, error: 'timed out after 5 s' })
  assert.deepEqual(verdictFromError({ name: 'AbortError' }), { ok: false, error: 'timed out after 5 s' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_NAME_NOT_RESOLVED' }), { ok: false, error: 'host name not found (DNS)' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_CONNECTION_REFUSED' }), { ok: false, error: 'connection refused' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_INTERNET_DISCONNECTED' }), { ok: false, error: 'no network' })
  assert.deepEqual(verdictFromError({ message: 'something odd' }), { ok: false, error: 'something odd' })
  assert.deepEqual(verdictFromError({ message: 'net::ERR_UNKNOWN_URL_SCHEME' }), { ok: false, error: 'cannot check this kind of URL — the kiosk may still load it' })
})
