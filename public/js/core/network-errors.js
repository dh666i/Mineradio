(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.networkErrors = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ERROR_KINDS = Object.freeze({
    OFFLINE: 'offline',
    TIMEOUT: 'timeout',
    ABORTED: 'aborted',
    AUTH_REQUIRED: 'auth_required',
    FORBIDDEN: 'forbidden',
    NOT_FOUND: 'not_found',
    CONFLICT: 'conflict',
    RATE_LIMITED: 'rate_limited',
    SERVER: 'server',
    HTTP: 'http',
    INVALID_RESPONSE: 'invalid_response',
    NETWORK: 'network',
    APPLICATION: 'application',
    UNKNOWN: 'unknown',
  });

  var RETRYABLE_KINDS = {
    offline: true,
    timeout: true,
    rate_limited: true,
    server: true,
    network: true,
  };

  function numberOrZero(value) {
    var number = Number(value);
    return isFinite(number) && number >= 100 && number <= 599 ? number : 0;
  }

  function normalizedCode(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  function errorCode(error, context, payload) {
    return normalizedCode(
      context.code ||
      (error && (error.code || error.errorCode)) ||
      (payload && (payload.errorCode || payload.error || payload.reason || payload.code))
    );
  }

  function errorStatus(error, context, payload) {
    var response = context.response || (error && error.response);
    return numberOrZero(context.status) ||
      numberOrZero(response && response.status) ||
      numberOrZero(error && (error.status || error.statusCode)) ||
      numberOrZero(payload && payload.status) ||
      numberOrZero(payload && payload.code);
  }

  function result(kind, status, code, detail) {
    var retryable = !!RETRYABLE_KINDS[kind] || status === 408;
    return {
      kind: kind,
      status: status || 0,
      code: code || '',
      retryable: retryable,
      authRequired: kind === ERROR_KINDS.AUTH_REQUIRED,
      detail: detail || '',
    };
  }

  function classifyNetworkError(error, context) {
    context = context || {};
    var payload = context.payload || (error && error.payload) || null;
    var status = errorStatus(error, context, payload);
    var code = errorCode(error, context, payload);
    var name = String(error && error.name || '');
    var detail = String(context.message || (error && error.message) || (payload && payload.message) || '');
    var detailLower = detail.toLowerCase();

    if (context.online === false) return result(ERROR_KINDS.OFFLINE, status, code, detail);
    if (status === 408 || context.timedOut || /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TIMEOUT|MINERADIO_TIMEOUT)$/.test(code) || /timed?\s*out|timeout/.test(detailLower)) {
      return result(ERROR_KINDS.TIMEOUT, status || 408, code, detail);
    }
    if (context.aborted || name === 'AbortError' || code === 'ABORT_ERR' || code === 'ERR_ABORTED') {
      return result(ERROR_KINDS.ABORTED, status, code, detail);
    }
    if (status === 401 || code === '301' || /^(LOGIN_REQUIRED|LOGIN_EXPIRED|LOGIN_SESSION_EXPIRED|AUTH_REQUIRED|AUTH_EXPIRED|UNAUTHORIZED)$/.test(code)) {
      return result(ERROR_KINDS.AUTH_REQUIRED, status || 401, code, detail);
    }
    if (status === 403) return result(ERROR_KINDS.FORBIDDEN, status, code, detail);
    if (status === 404) return result(ERROR_KINDS.NOT_FOUND, status, code, detail);
    if (status === 409) return result(ERROR_KINDS.CONFLICT, status, code, detail);
    if (status === 429) return result(ERROR_KINDS.RATE_LIMITED, status, code, detail);
    if (status >= 500) return result(ERROR_KINDS.SERVER, status, code, detail);
    if (status >= 400) return result(ERROR_KINDS.HTTP, status, code, detail);
    if (name === 'SyntaxError' || /^(INVALID_JSON|INVALID_RESPONSE|BAD_RESPONSE)$/.test(code)) {
      return result(ERROR_KINDS.INVALID_RESPONSE, status, code, detail);
    }
    if (/^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|FETCH_FAILED)$/.test(code) ||
        name === 'TypeError' && /fetch|network|load failed|connection/.test(detailLower)) {
      return result(ERROR_KINDS.NETWORK, status, code, detail);
    }
    if (payload && (payload.success === false || payload.ok === false)) {
      return result(ERROR_KINDS.APPLICATION, status, code, detail);
    }
    return result(ERROR_KINDS.UNKNOWN, status, code, detail);
  }

  function isRetryableNetworkError(error, context) {
    if (error && typeof error.retryable === 'boolean' && error.kind) return error.retryable;
    return classifyNetworkError(error, context).retryable;
  }

  function networkErrorMessage(error, context) {
    var classified = error && error.kind ? error : classifyNetworkError(error, context);
    var messages = {
      offline: 'No network connection',
      timeout: 'The request timed out',
      aborted: 'The request was canceled',
      auth_required: 'Sign-in is required',
      forbidden: 'The account does not have permission',
      not_found: 'The requested content was not found',
      conflict: 'The request conflicts with the current state',
      rate_limited: 'Too many requests; try again later',
      server: 'The music service is temporarily unavailable',
      http: 'The request failed',
      invalid_response: 'The service returned an invalid response',
      network: 'The service could not be reached',
      application: 'The operation was not completed',
      unknown: 'An unexpected request error occurred',
    };
    return messages[classified.kind] || messages.unknown;
  }

  return {
    ERROR_KINDS: ERROR_KINDS,
    classifyNetworkError: classifyNetworkError,
    isRetryableNetworkError: isRetryableNetworkError,
    networkErrorMessage: networkErrorMessage,
  };
});
