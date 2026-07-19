'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const network = require('../../public/js/core/network-errors');

test('offline state wins over a generic fetch error', () => {
  const classified = network.classifyNetworkError(new TypeError('fetch failed'), { online: false });
  assert.equal(classified.kind, network.ERROR_KINDS.OFFLINE);
  assert.equal(classified.retryable, true);
});

test('timeout and user abort are distinguished', () => {
  const timeout = network.classifyNetworkError({ name: 'AbortError' }, { timedOut: true });
  const requestTimeout = network.classifyNetworkError({ status: 408 });
  const aborted = network.classifyNetworkError({ name: 'AbortError' });

  assert.equal(timeout.kind, network.ERROR_KINDS.TIMEOUT);
  assert.equal(requestTimeout.kind, network.ERROR_KINDS.TIMEOUT);
  assert.equal(timeout.retryable, true);
  assert.equal(aborted.kind, network.ERROR_KINDS.ABORTED);
  assert.equal(aborted.retryable, false);
});

test('HTTP authentication errors request sign-in', () => {
  const classified = network.classifyNetworkError(null, { response: { status: 401 } });
  assert.equal(classified.kind, network.ERROR_KINDS.AUTH_REQUIRED);
  assert.equal(classified.authRequired, true);
});

test('Netease login-required code 301 maps to authentication', () => {
  const classified = network.classifyNetworkError(null, { payload: { code: 301 } });
  assert.equal(classified.kind, network.ERROR_KINDS.AUTH_REQUIRED);
});

test('application login errors carried in payload.error map to authentication', () => {
  const expired = network.classifyNetworkError(null, {
    payload: { ok: false, error: 'LOGIN_EXPIRED' },
  });
  const sessionExpired = network.classifyNetworkError(null, {
    payload: { ok: false, error: 'LOGIN_SESSION_EXPIRED' },
  });

  assert.equal(expired.kind, network.ERROR_KINDS.AUTH_REQUIRED);
  assert.equal(expired.authRequired, true);
  assert.equal(sessionExpired.kind, network.ERROR_KINDS.AUTH_REQUIRED);
});

test('rate limits and server errors are retryable', () => {
  const rateLimited = network.classifyNetworkError({ status: 429 });
  const server = network.classifyNetworkError({ statusCode: 503 });

  assert.equal(rateLimited.kind, network.ERROR_KINDS.RATE_LIMITED);
  assert.equal(rateLimited.retryable, true);
  assert.equal(server.kind, network.ERROR_KINDS.SERVER);
  assert.equal(server.retryable, true);
});

test('common fetch transport failures map to network', () => {
  assert.equal(
    network.classifyNetworkError(new TypeError('Failed to fetch')).kind,
    network.ERROR_KINDS.NETWORK
  );
  assert.equal(
    network.classifyNetworkError({ code: 'ECONNRESET' }).kind,
    network.ERROR_KINDS.NETWORK
  );
});

test('invalid JSON is classified separately from transport failure', () => {
  const classified = network.classifyNetworkError(new SyntaxError('Unexpected token'));
  assert.equal(classified.kind, network.ERROR_KINDS.INVALID_RESPONSE);
  assert.equal(classified.retryable, false);
});

test('application failures remain distinct from HTTP failures', () => {
  const classified = network.classifyNetworkError(null, {
    payload: { success: false, code: 'PLAYLIST_WRITE_FAILED' },
  });
  assert.equal(classified.kind, network.ERROR_KINDS.APPLICATION);

  const okContract = network.classifyNetworkError(null, {
    payload: { ok: false, error: 'PLAYLIST_WRITE_FAILED' },
  });
  assert.equal(okContract.kind, network.ERROR_KINDS.APPLICATION);
});

test('retry helper accepts either raw errors or classified results', () => {
  const classified = network.classifyNetworkError({ status: 503 });
  assert.equal(network.isRetryableNetworkError(classified), true);
  assert.equal(network.isRetryableNetworkError({ status: 404 }), false);
});

test('networkErrorMessage returns a stable fallback', () => {
  assert.equal(network.networkErrorMessage({ kind: 'unknown' }), 'An unexpected request error occurred');
});
