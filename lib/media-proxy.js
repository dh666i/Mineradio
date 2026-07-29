'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 20000;
const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_AUDIO_MAX_BYTES = 512 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const IMAGE_TYPE_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
]);

const AUDIO_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/vorbis',
  'audio/wav',
  'audio/wave',
  'audio/webm',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
  'application/ogg',
]);

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'range',
  'referer',
  'user-agent',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function createProxyError(code, message, statusCode, cause) {
  const error = new Error(message || code);
  error.name = 'MediaProxyError';
  error.code = code;
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  return error;
}

function createAbortError(message) {
  const error = new Error(message || 'The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function positiveInteger(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max || Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Math.floor(number), max || Number.MAX_SAFE_INTEGER);
}

function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseIpv4(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map(part => {
    if (!/^\d{1,3}$/.test(part)) return -1;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : -1;
  });
  return bytes.some(value => value < 0) ? null : bytes;
}

function parseIpv6(address) {
  let text = normalizeHost(address);
  const zoneIndex = text.indexOf('%');
  if (zoneIndex >= 0) text = text.slice(0, zoneIndex);
  if (!text || text.split('::').length > 2) return null;

  let ipv4Tail = null;
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.') && lastColon >= 0) {
    ipv4Tail = parseIpv4(text.slice(lastColon + 1));
    if (!ipv4Tail) return null;
    text = text.slice(0, lastColon) + ':' +
      ((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16) + ':' +
      ((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16);
  }

  const halves = text.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some(part => !/^[0-9a-f]{1,4}$/i.test(part)) ||
      right.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return null;
  }

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [
    ...left.map(part => parseInt(part, 16)),
    ...Array(Math.max(0, missing)).fill(0),
    ...right.map(part => parseInt(part, 16)),
  ];
  if (words.length !== 8) return null;

  const bytes = [];
  for (const word of words) bytes.push(word >> 8, word & 0xff);
  return bytes;
}

function isForbiddenIpv4(address) {
  const bytes = Array.isArray(address) ? address : parseIpv4(address);
  if (!bytes) return true;
  const [a, b, c] = bytes;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;

  // IETF special-purpose, documentation, benchmarking, multicast, and reserved ranges.
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isForbiddenIpv6(address) {
  const bytes = Array.isArray(address) ? address : parseIpv6(address);
  if (!bytes || bytes.length !== 16) return true;

  // RFC 6052's well-known NAT64 prefix is globally routable only when the
  // embedded IPv4 destination is globally routable as well.
  const isWellKnownNat64 =
    bytes[0] === 0x00 && bytes[1] === 0x64 &&
    bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every(value => value === 0);
  if (isWellKnownNat64) return isForbiddenIpv4(bytes.slice(12));

  const allZero = bytes.every(value => value === 0);
  const loopback = bytes.slice(0, 15).every(value => value === 0) && bytes[15] === 1;
  if (allZero || loopback) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true;
  if (bytes[0] === 0xff) return true;

  // Only native global-unicast addresses are accepted. This excludes IPv4
  // compatibility, mapped/translatable, NAT64, link-scoped, and reserved space.
  if ((bytes[0] & 0xe0) !== 0x20) return true;

  // IETF protocol assignments, benchmarking, ORCHID, transition, and docs.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] <= 0x01) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 &&
      (bytes[3] & 0xf0) === 0x10) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 &&
      (bytes[3] & 0xf0) === 0x20) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0x00) return true;
  return false;
}

function isForbiddenAddress(address) {
  const normalized = normalizeHost(address);
  const family = net.isIP(normalized);
  if (family === 4) return isForbiddenIpv4(normalized);
  if (family === 6) return isForbiddenIpv6(normalized);
  return true;
}

function normalizeLookupRecords(value) {
  const records = Array.isArray(value) ? value : [value];
  return records.map(record => {
    if (typeof record === 'string') return { address: record, family: net.isIP(record) };
    const address = record && record.address;
    return { address, family: net.isIP(address) || Number(record && record.family) };
  }).filter(record => record.address && (record.family === 4 || record.family === 6));
}

function lookupAll(lookup, hostname) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, address, family) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else if (Array.isArray(address)) resolve(address);
      else resolve([{ address, family }]);
    };

    try {
      const result = lookup(hostname, { all: true, verbatim: true }, done);
      if (result && typeof result.then === 'function') {
        result.then(value => {
          if (settled) return;
          settled = true;
          resolve(value);
        }, error => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      } else if (result !== undefined && !settled) {
        settled = true;
        resolve(result);
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

function makePinnedLookup(records) {
  const frozen = records.map(record => ({ address: record.address, family: record.family }));
  return function pinnedLookup(_hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    }
    options = options || {};
    const family = Number(options.family) || 0;
    const candidates = family ? frozen.filter(record => record.family === family) : frozen;
    const selected = candidates.length ? candidates : frozen;
    process.nextTick(() => {
      if (!selected.length) {
        const error = new Error('No validated address is available');
        error.code = 'ENOTFOUND';
        callback(error);
      } else if (options.all) {
        callback(null, selected.map(record => ({ ...record })));
      } else {
        callback(null, selected[0].address, selected[0].family);
      }
    });
  };
}

function normalizedHeaderEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  return Object.entries(headers);
}

function sanitizeRequestHeaders(headers) {
  const output = {};
  for (const [rawName, rawValue] of normalizedHeaderEntries(headers)) {
    const name = String(rawName || '').trim().toLowerCase();
    if (!REQUEST_HEADER_ALLOWLIST.has(name) || rawValue == null) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    if (/[\r\n]/.test(value)) continue;
    output[name] = value;
  }
  if (Object.prototype.hasOwnProperty.call(output, 'range')) {
    const range = parseRequestRange(output.range);
    if (!range) {
      throw createProxyError(
        'MEDIA_PROXY_REQUEST_RANGE_INVALID',
        'Only one valid byte range may be requested',
        400
      );
    }
    output.range = range.value;
  }
  output['accept-encoding'] = 'identity';
  return output;
}

function readHeader(headers, name) {
  if (!headers) return null;
  const value = headers[String(name).toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0] == null ? null : String(value[0]);
  return value == null ? null : String(value);
}

function normalizeContentType(value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : '';
}

function inferredContentType(kind, targetUrl) {
  let pathname = '';
  try {
    pathname = new URL(targetUrl).pathname.toLowerCase();
  } catch (_) {}
  if (kind === 'image') {
    if (/\.jpe?g$/.test(pathname)) return 'image/jpeg';
    if (/\.png$/.test(pathname)) return 'image/png';
    if (/\.webp$/.test(pathname)) return 'image/webp';
    if (/\.gif$/.test(pathname)) return 'image/gif';
    if (/\.avif$/.test(pathname)) return 'image/avif';
    return '';
  }
  if (kind === 'audio') {
    if (/\.mp3$/.test(pathname)) return 'audio/mpeg';
    if (/\.flac$/.test(pathname)) return 'audio/flac';
    if (/\.(m4a|mp4)$/.test(pathname)) return 'audio/mp4';
    if (/\.aac$/.test(pathname)) return 'audio/aac';
    if (/\.(ogg|oga)$/.test(pathname)) return 'audio/ogg';
    if (/\.opus$/.test(pathname)) return 'audio/opus';
    if (/\.wav$/.test(pathname)) return 'audio/wav';
    if (/\.webm$/.test(pathname)) return 'audio/webm';
  }
  return '';
}

function validatedContentType(kind, targetUrl, upstreamValue) {
  const upstreamType = normalizeContentType(upstreamValue);
  const inferred = inferredContentType(kind, targetUrl);
  if (kind === 'image') {
    const imageType = IMAGE_TYPE_ALIASES.get(upstreamType) || upstreamType;
    if (IMAGE_TYPES.has(imageType)) return imageType;
    if (!upstreamType && inferred) return inferred;
  } else if (kind === 'audio') {
    if (AUDIO_TYPES.has(upstreamType)) return upstreamType;
    if ((!upstreamType || upstreamType === 'application/octet-stream') && inferred) return inferred;
  }
  throw createProxyError(
    'MEDIA_PROXY_TYPE_FORBIDDEN',
    kind === 'image' ? 'Unsupported image content type' : 'Unsupported audio content type',
    415
  );
}

function parseContentLength(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeResponseHeader(value, maxLength) {
  const text = String(value || '');
  if (!text || text.length > (maxLength || 512) || /[\r\n]/.test(text)) return '';
  return text;
}

function parseRequestRange(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 256 || /[\r\n]/.test(text)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
  if (!match || (!match[1] && !match[2])) return null;

  if (match[1]) {
    const start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0) return null;
    if (!match[2]) {
      return { value: `bytes=${start}-`, type: 'open', start, end: null };
    }
    const end = Number(match[2]);
    if (!Number.isSafeInteger(end) || end < start) return null;
    return { value: `bytes=${start}-${end}`, type: 'closed', start, end };
  }

  const suffixLength = Number(match[2]);
  if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
  return { value: `bytes=-${suffixLength}`, type: 'suffix', suffixLength };
}

function parseContentRange(value, status) {
  const text = safeResponseHeader(value, 256);
  if (!text) return null;
  if (status === 416) {
    const match = /^bytes \*\/(\d+)$/i.exec(text);
    if (!match) return null;
    const total = Number(match[1]);
    if (!Number.isSafeInteger(total) || total < 0) return null;
    return { value: text, unsatisfied: true, total };
  }

  if (status !== 206) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(text);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  if (total != null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return {
    value: text,
    unsatisfied: false,
    start,
    end,
    total,
    length: end - start + 1,
  };
}

function validContentRange(value, status) {
  const parsed = parseContentRange(value, status);
  return parsed ? parsed.value : '';
}

function contentRangeMatchesRequest(contentRange, requestRange) {
  if (!contentRange || contentRange.unsatisfied || !requestRange) return false;

  if (requestRange.type === 'closed') {
    if (contentRange.start !== requestRange.start) return false;
    const expectedEnd = contentRange.total == null
      ? requestRange.end
      : Math.min(requestRange.end, contentRange.total - 1);
    return contentRange.end === expectedEnd;
  }

  if (requestRange.type === 'open') {
    return contentRange.start === requestRange.start &&
      (contentRange.total == null || contentRange.end === contentRange.total - 1);
  }

  if (contentRange.total == null) {
    return contentRange.length <= requestRange.suffixLength;
  }
  const expectedLength = Math.min(requestRange.suffixLength, contentRange.total);
  return contentRange.start === contentRange.total - expectedLength &&
    contentRange.end === contentRange.total - 1;
}

function unsatisfiedRangeMatchesRequest(contentRange, requestRange) {
  if (!contentRange || !contentRange.unsatisfied || !requestRange) return false;
  if (requestRange.type === 'suffix') return contentRange.total === 0;
  return requestRange.start >= contentRange.total;
}

class HeaderBag {
  constructor(headers) {
    this.values = new Map();
    for (const [name, value] of Object.entries(headers || {})) {
      if (value == null) continue;
      this.values.set(String(name).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    }
  }

  get(name) {
    const value = this.values.get(String(name || '').toLowerCase());
    return value == null ? null : value;
  }

  has(name) {
    return this.values.has(String(name || '').toLowerCase());
  }

  entries() {
    return this.values.entries();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

class ByteLimitTransform extends Transform {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.total = 0;
  }

  _transform(chunk, encoding, callback) {
    this.total += chunk.length;
    if (this.total > this.maxBytes) {
      callback(createProxyError(
        'MEDIA_PROXY_BODY_TOO_LARGE',
        'Upstream media exceeds the allowed size',
        413
      ));
      return;
    }
    callback(null, chunk);
  }
}

function createRequestContext(signal, totalTimeoutMs) {
  let abortReject;
  const abortPromise = new Promise((_, reject) => {
    abortReject = reject;
  });
  abortPromise.catch(() => {});

  const context = {
    aborted: false,
    error: null,
    request: null,
    response: null,
    timer: null,
    signal,
    signalHandler: null,
    abortPromise,
    wait(promise) {
      return Promise.race([promise, abortPromise]);
    },
    abort(error) {
      if (this.aborted) return;
      this.aborted = true;
      this.error = error || createAbortError();
      abortReject(this.error);
      if (this.request && typeof this.request.destroy === 'function') {
        try { this.request.destroy(this.error); } catch (_) {}
      }
      if (this.response && typeof this.response.destroy === 'function') {
        try { this.response.destroy(this.error); } catch (_) {}
      }
    },
    finish() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (this.signal && this.signalHandler) {
        try { this.signal.removeEventListener('abort', this.signalHandler); } catch (_) {}
      }
      this.signalHandler = null;
      this.request = null;
      this.response = null;
    },
  };

  if (signal) {
    context.signalHandler = () => context.abort(createAbortError());
    if (signal.aborted) context.signalHandler();
    else signal.addEventListener('abort', context.signalHandler, { once: true });
  }
  if (totalTimeoutMs > 0) {
    context.timer = setTimeout(() => {
      context.abort(createProxyError(
        'MEDIA_PROXY_TOTAL_TIMEOUT',
        'Media request exceeded the total timeout',
        504
      ));
    }, totalTimeoutMs);
  }
  return context;
}

function normalizeNetworkError(error) {
  if (error && (error.name === 'AbortError' || error.name === 'MediaProxyError')) return error;
  return createProxyError(
    'MEDIA_PROXY_UPSTREAM_ERROR',
    'Unable to reach the upstream media server',
    502,
    error
  );
}

function createFetchBody(response, context, maxBytes) {
  let reader = null;
  let locked = false;
  let disturbed = false;
  let streamedBytes = 0;

  const body = {
    getReader() {
      if (locked) throw new TypeError('Readable body is already locked');
      if (!reader) reader = response[Symbol.asyncIterator]();
      locked = true;
      disturbed = true;
      let released = false;
      return {
        async read() {
          if (released) throw new TypeError('Reader lock has been released');
          try {
            const result = await reader.next();
            if (result.done) context.finish();
            const value = result.done ? undefined : new Uint8Array(result.value);
            streamedBytes += value ? value.byteLength : 0;
            if (maxBytes > 0 && streamedBytes > maxBytes) {
              const error = createProxyError(
                'MEDIA_PROXY_BODY_TOO_LARGE',
                'Upstream media exceeds the allowed size',
                413
              );
              context.abort(error);
              throw error;
            }
            return {
              done: Boolean(result.done),
              value,
            };
          } catch (error) {
            context.finish();
            throw context.error || error;
          }
        },
        async cancel() {
          if (released) return;
          context.finish();
          try { response.destroy(); } catch (_) {}
        },
        releaseLock() {
          released = true;
          locked = false;
        },
      };
    },
    async cancel() {
      if (locked) throw new TypeError('Readable body is already locked');
      disturbed = true;
      context.finish();
      try { response.destroy(); } catch (_) {}
    },
  };

  return {
    body,
    get bodyUsed() {
      return disturbed;
    },
    async arrayBuffer() {
      const streamReader = body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const part = await streamReader.read();
          if (part.done) break;
          const chunk = Buffer.from(part.value);
          chunks.push(chunk);
          total += chunk.length;
        }
      } finally {
        streamReader.releaseLock();
      }
      const buffer = Buffer.concat(chunks, total);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

class MediaProxy {
  constructor(options) {
    options = options || {};
    this.lookup = options.lookup || dns.promises.lookup.bind(dns.promises);
    this.transport = options.transport || null;
    this.connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      2 * 60 * 1000
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
      5 * 60 * 1000
    );
    this.totalTimeoutMs = positiveInteger(
      options.totalTimeoutMs,
      DEFAULT_TOTAL_TIMEOUT_MS,
      30 * 60 * 1000
    );
    this.maxRedirects = nonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 10);
    this.imageMaxBytes = positiveInteger(
      options.imageMaxBytes,
      DEFAULT_IMAGE_MAX_BYTES,
      128 * 1024 * 1024
    );
    this.audioMaxBytes = positiveInteger(
      options.audioMaxBytes,
      DEFAULT_AUDIO_MAX_BYTES,
      1024 * 1024 * 1024
    );
    this.fetch = this.fetch.bind(this);
    this.pipe = this.pipe.bind(this);
  }

  async resolveTarget(value) {
    let target;
    try {
      if (String(value || '').length > 8192) throw new Error('URL is too long');
      target = new URL(String(value || ''));
    } catch (error) {
      throw createProxyError('MEDIA_PROXY_URL_INVALID', 'Media URL is invalid', 400, error);
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') ||
        target.username || target.password || !target.hostname) {
      throw createProxyError(
        'MEDIA_PROXY_URL_INVALID',
        'Media URL must use HTTP(S) without credentials',
        400
      );
    }

    const expectedPort = target.protocol === 'http:' ? 80 : 443;
    const actualPort = target.port ? Number(target.port) : expectedPort;
    if (actualPort !== expectedPort) {
      throw createProxyError(
        'MEDIA_PROXY_PORT_FORBIDDEN',
        'Media URL uses a non-default port',
        403
      );
    }

    const hostname = normalizeHost(target.hostname);
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw createProxyError(
        'MEDIA_PROXY_ADDRESS_FORBIDDEN',
        'Media URL cannot target a local or private address',
        403
      );
    }

    let records;
    const literalFamily = net.isIP(hostname);
    if (literalFamily) {
      records = [{ address: hostname, family: literalFamily }];
    } else {
      try {
        records = normalizeLookupRecords(await lookupAll(this.lookup, hostname));
      } catch (error) {
        throw createProxyError(
          'MEDIA_PROXY_DNS_FAILED',
          'Unable to resolve the media host',
          502,
          error
        );
      }
    }
    if (!records.length) {
      throw createProxyError('MEDIA_PROXY_DNS_FAILED', 'Media host has no usable address', 502);
    }
    if (records.some(record => isForbiddenAddress(record.address))) {
      throw createProxyError(
        'MEDIA_PROXY_ADDRESS_FORBIDDEN',
        'Media URL cannot target a local, private, or reserved address',
        403
      );
    }

    target.hash = '';
    return { target, records };
  }

  transportFor(target) {
    if (typeof this.transport === 'function') return this.transport;
    if (this.transport && typeof this.transport.request === 'function') {
      return this.transport.request.bind(this.transport);
    }
    if (this.transport && typeof this.transport[target.protocol] === 'function') {
      return this.transport[target.protocol].bind(this.transport);
    }
    return target.protocol === 'https:' ? https.request : http.request;
  }

  requestHop(resolved, method, headers, context, connectTimeoutMs) {
    return context.wait(new Promise((resolve, reject) => {
      let connectTimer = null;
      let settled = false;
      const target = resolved.target;
      const requestOptions = {
        method,
        headers,
        lookup: makePinnedLookup(resolved.records),
        agent: false,
      };
      const clearConnectTimer = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        reject(context.error || normalizeNetworkError(error));
      };

      let request;
      try {
        request = this.transportFor(target)(target, requestOptions, response => {
          if (settled) {
            try { response.destroy(); } catch (_) {}
            return;
          }
          settled = true;
          clearConnectTimer();
          context.response = response;
          resolve(response);
        });
      } catch (error) {
        fail(error);
        return;
      }
      context.request = request;
      request.once('error', fail);
      request.once('socket', socket => {
        if (!socket || socket.connecting === false) {
          clearConnectTimer();
          return;
        }
        const connectedEvent = target.protocol === 'https:' ? 'secureConnect' : 'connect';
        socket.once(connectedEvent, clearConnectTimer);
        socket.once('error', clearConnectTimer);
        socket.once('close', clearConnectTimer);
      });
      if (!settled) {
        connectTimer = setTimeout(() => {
          context.abort(createProxyError(
            'MEDIA_PROXY_CONNECT_TIMEOUT',
            'Media server connection timed out',
            504
          ));
        }, connectTimeoutMs);
      }
      try {
        request.end();
      } catch (error) {
        fail(error);
      }
    }));
  }

  attachResponseLifecycle(response, context, idleTimeoutMs) {
    const finish = () => context.finish();
    response.once('end', finish);
    response.once('close', finish);
    response.once('error', finish);
    response.once('aborted', finish);
    if (idleTimeoutMs > 0 && typeof response.setTimeout === 'function') {
      response.setTimeout(idleTimeoutMs, () => {
        context.abort(createProxyError(
          'MEDIA_PROXY_IDLE_TIMEOUT',
          'Media response stalled',
          504
        ));
      });
    }
  }

  async open(targetUrl, init, context) {
    init = init || {};
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw createProxyError('MEDIA_PROXY_METHOD_FORBIDDEN', 'Only GET and HEAD are supported', 405);
    }
    const headers = sanitizeRequestHeaders(init.headers);
    const requestRange = headers.range ? parseRequestRange(headers.range) : null;
    const connectTimeoutMs = positiveInteger(
      init.connectTimeoutMs,
      this.connectTimeoutMs,
      2 * 60 * 1000
    );
    const idleTimeoutMs = positiveInteger(
      init.idleTimeoutMs,
      this.idleTimeoutMs,
      5 * 60 * 1000
    );
    const maxRedirects = nonNegativeInteger(init.maxRedirects, this.maxRedirects, 10);
    const redirectMode = init.redirect || 'follow';
    let currentUrl = targetUrl;
    let redirected = false;

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        const resolved = await context.wait(this.resolveTarget(currentUrl));
        const response = await this.requestHop(
          resolved,
          method,
          headers,
          context,
          connectTimeoutMs
        );
        const status = Number(response.statusCode) || 0;
        if (!REDIRECT_STATUSES.has(status) || redirectMode === 'manual') {
          this.attachResponseLifecycle(response, context, idleTimeoutMs);
          return {
            response,
            finalUrl: resolved.target.toString(),
            redirected,
            method,
            requestRange,
          };
        }

        const location = readHeader(response.headers, 'location');
        context.response = null;
        try { response.destroy(); } catch (_) {}
        if (redirectMode === 'error') {
          throw createProxyError(
            'MEDIA_PROXY_REDIRECT_FORBIDDEN',
            'Upstream media redirected unexpectedly',
            502
          );
        }
        if (!location) {
          throw createProxyError(
            'MEDIA_PROXY_REDIRECT_INVALID',
            'Upstream media redirect has no location',
            502
          );
        }
        if (redirectCount >= maxRedirects) {
          throw createProxyError(
            'MEDIA_PROXY_TOO_MANY_REDIRECTS',
            'Upstream media redirected too many times',
            502
          );
        }
        try {
          currentUrl = new URL(location, resolved.target).toString();
        } catch (error) {
          throw createProxyError(
            'MEDIA_PROXY_REDIRECT_INVALID',
            'Upstream media redirect is invalid',
            502,
            error
          );
        }
        context.request = null;
        redirected = true;
      }
    } catch (error) {
      context.finish();
      throw normalizeNetworkError(error);
    }
  }

  async fetch(targetUrl, init) {
    init = init || {};
    const totalTimeoutMs = positiveInteger(
      init.totalTimeoutMs,
      this.totalTimeoutMs,
      30 * 60 * 1000
    );
    const context = createRequestContext(init.signal, totalTimeoutMs);
    if (context.aborted) {
      context.finish();
      throw context.error;
    }
    let opened;
    try {
      opened = await this.open(targetUrl, init, context);
    } catch (error) {
      context.finish();
      throw error;
    }
    const response = opened.response;
    const status = Number(response.statusCode) || 0;
    const headers = new HeaderBag(response.headers);
    const maxBytes = positiveInteger(
      init.maxBytes,
      this.audioMaxBytes,
      1024 * 1024 * 1024
    );
    const contentLength = parseContentLength(headers.get('content-length'));
    if (opened.method !== 'HEAD' && contentLength != null && contentLength > maxBytes) {
      try { response.destroy(); } catch (_) {}
      context.finish();
      throw createProxyError(
        'MEDIA_PROXY_BODY_TOO_LARGE',
        'Upstream media exceeds the allowed size',
        413
      );
    }
    let fetchBody = null;
    if (opened.method === 'HEAD') {
      try { response.destroy(); } catch (_) {}
      context.finish();
    } else {
      fetchBody = createFetchBody(response, context, maxBytes);
    }

    const output = {
      ok: status >= 200 && status <= 299,
      status,
      statusText: http.STATUS_CODES[status] || '',
      url: opened.finalUrl,
      redirected: opened.redirected,
      headers,
      body: fetchBody && fetchBody.body,
      async arrayBuffer() {
        if (!fetchBody) return new ArrayBuffer(0);
        return fetchBody.arrayBuffer();
      },
    };
    Object.defineProperty(output, 'bodyUsed', {
      enumerable: true,
      get: () => Boolean(fetchBody && fetchBody.bodyUsed),
    });
    return output;
  }

  async pipe(req, res, targetUrl, options) {
    options = options || {};
    const kind = options.kind === 'image' ? 'image' : 'audio';
    const totalTimeoutMs = positiveInteger(
      options.totalTimeoutMs,
      this.totalTimeoutMs,
      30 * 60 * 1000
    );
    const context = createRequestContext(options.signal, totalTimeoutMs);
    const onRequestAborted = () => context.abort(createAbortError('Downstream request was aborted'));
    const onRequestClose = () => {
      if (req && req.complete !== true) onRequestAborted();
    };
    const onResponseClose = () => {
      if (!res.writableEnded) onRequestAborted();
    };
    if (req && typeof req.once === 'function') {
      req.once('aborted', onRequestAborted);
      req.once('close', onRequestClose);
    }
    if (res && typeof res.once === 'function') res.once('close', onResponseClose);

    try {
      const method = String(req && req.method || 'GET').toUpperCase();
      const opened = await this.open(targetUrl, {
        ...options,
        method,
      }, context);
      const upstream = opened.response;
      const status = Number(upstream.statusCode) || 0;
      if ((status < 200 || status >= 300) && status !== 416) {
        try { upstream.destroy(); } catch (_) {}
        throw createProxyError(
          'MEDIA_PROXY_UPSTREAM_STATUS',
          'Upstream media request failed',
          status >= 400 && status <= 499 ? status : 502
        );
      }

      const commonHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': options.cacheControl ||
          (kind === 'image' ? 'public, max-age=86400' : 'no-store'),
      };
      const rawContentRange = readHeader(upstream.headers, 'content-range');
      const parsedContentRange = parseContentRange(rawContentRange, status);
      const contentRange = parsedContentRange ? parsedContentRange.value : '';
      if (status === 416) {
        if (!unsatisfiedRangeMatchesRequest(parsedContentRange, opened.requestRange)) {
          try { upstream.destroy(); } catch (_) {}
          throw createProxyError(
            'MEDIA_PROXY_RANGE_INVALID',
            'Upstream unsatisfied range response is invalid',
            502
          );
        }
        commonHeaders['Content-Range'] = contentRange;
        if (kind === 'audio') commonHeaders['Accept-Ranges'] = 'bytes';
        res.writeHead(416, commonHeaders);
        res.end();
        try { upstream.destroy(); } catch (_) {}
        context.finish();
        return { ok: true, status: 416 };
      }
      if (status === 206 &&
          !contentRangeMatchesRequest(parsedContentRange, opened.requestRange)) {
        try { upstream.destroy(); } catch (_) {}
        throw createProxyError(
          'MEDIA_PROXY_RANGE_INVALID',
          'Upstream partial response does not match the requested range',
          502
        );
      }

      const encoding = String(readHeader(upstream.headers, 'content-encoding') || '')
        .split(',', 1)[0]
        .trim()
        .toLowerCase();
      if (encoding && encoding !== 'identity') {
        try { upstream.destroy(); } catch (_) {}
        throw createProxyError(
          'MEDIA_PROXY_ENCODING_UNSUPPORTED',
          'Compressed upstream media is not supported',
          502
        );
      }
      const contentType = validatedContentType(
        kind,
        opened.finalUrl,
        readHeader(upstream.headers, 'content-type')
      );
      const rawContentLength = readHeader(upstream.headers, 'content-length');
      const contentLength = parseContentLength(rawContentLength);
      if (rawContentLength != null && contentLength == null) {
        try { upstream.destroy(); } catch (_) {}
        throw createProxyError(
          'MEDIA_PROXY_LENGTH_INVALID',
          'Upstream media has an invalid Content-Length',
          502
        );
      }
      if (status === 206 && contentLength != null &&
          contentLength !== parsedContentRange.length) {
        try { upstream.destroy(); } catch (_) {}
        throw createProxyError(
          'MEDIA_PROXY_RANGE_INVALID',
          'Upstream partial response length does not match Content-Range',
          502
        );
      }
      const maxBytes = positiveInteger(
        options.maxBytes,
        kind === 'image' ? this.imageMaxBytes : this.audioMaxBytes,
        1024 * 1024 * 1024
      );
      if (contentLength != null && contentLength > maxBytes) {
        try { upstream.destroy(); } catch (_) {}
        throw createProxyError(
          'MEDIA_PROXY_BODY_TOO_LARGE',
          'Upstream media exceeds the allowed size',
          413
        );
      }

      const outputHeaders = { ...commonHeaders, 'Content-Type': contentType };
      if (contentLength != null) outputHeaders['Content-Length'] = String(contentLength);
      if (contentRange) outputHeaders['Content-Range'] = contentRange;
      if (kind === 'audio') outputHeaders['Accept-Ranges'] = 'bytes';
      res.writeHead(status, outputHeaders);
      if (method === 'HEAD') {
        res.end();
        try { upstream.destroy(); } catch (_) {}
        context.finish();
        return { ok: true, status };
      }

      await pipeline(upstream, new ByteLimitTransform(maxBytes), res);
      context.finish();
      return { ok: true, status };
    } catch (error) {
      const normalized = normalizeNetworkError(error);
      context.finish();
      if (res.headersSent || res.destroyed || normalized.name === 'AbortError') {
        if (!res.destroyed && typeof res.destroy === 'function') {
          try { res.destroy(normalized); } catch (_) {}
        }
        return { ok: false, error: normalized };
      }
      const statusCode = Number(normalized.statusCode);
      res.writeHead(statusCode >= 400 && statusCode <= 599 ? statusCode : 500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(normalized.message || 'Media proxy failed');
      return { ok: false, error: normalized };
    } finally {
      if (req && typeof req.removeListener === 'function') {
        req.removeListener('aborted', onRequestAborted);
        req.removeListener('close', onRequestClose);
      }
      if (res && typeof res.removeListener === 'function') {
        res.removeListener('close', onResponseClose);
      }
    }
  }
}

function createMediaProxy(options) {
  return new MediaProxy(options);
}

module.exports = {
  MediaProxy,
  createMediaProxy,
  createProxyError,
  isForbiddenAddress,
  validContentRange,
  validatedContentType,
};
