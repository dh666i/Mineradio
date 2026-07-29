const crypto = require('crypto');
const { TrackDecryptor } = require('../qishui-audio-decryptor/track-decryptor');

const DEFAULT_MAX_SOURCE_BYTES = 160 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 4;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 6;
const DEFAULT_CACHE_TTL_MS = 20 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 45000;

function createProxyError(code, message, statusCode) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function boundedPositive(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max || Number.MAX_SAFE_INTEGER);
}

function parseEncryptedAudioUrl(value) {
  const text = String(value || '').trim();
  if (!text) return { cleanUrl: '', auth: '' };
  const marker = text.indexOf('#auth=');
  if (marker < 0) return { cleanUrl: text, auth: '' };
  let auth = text.slice(marker + 6);
  try { auth = decodeURIComponent(auth); } catch (_) {}
  return {
    cleanUrl: text.slice(0, marker),
    auth: String(auth || '').trim(),
  };
}

function assertRemoteHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (_) {
    throw createProxyError('QISHUI_AUDIO_URL_INVALID', '汽水音频地址无效', 400);
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw createProxyError('QISHUI_AUDIO_URL_INVALID', '汽水音频地址必须使用 HTTP(S)', 400);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateIpv4 = /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  const privateHost = host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || privateIpv4;
  if (privateHost) {
    throw createProxyError('QISHUI_AUDIO_URL_FORBIDDEN', '汽水音频地址不能指向本机或局域网', 403);
  }
  parsed.hash = '';
  return parsed.toString();
}

function validateTopLevelMp4(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw createProxyError('QISHUI_AUDIO_MP4_INVALID', '汽水音频文件过短', 422);
  }
  const required = new Set(['ftyp', 'moov', 'mdat']);
  let offset = 0;
  let boxCount = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw createProxyError('QISHUI_AUDIO_MP4_INVALID', '汽水音频 MP4 边界不完整', 422);
    }
    const rawSize = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      throw createProxyError('QISHUI_AUDIO_MP4_INVALID', '汽水音频 MP4 box 类型无效', 422);
    }
    if (rawSize === 1) {
      throw createProxyError('QISHUI_AUDIO_MP4_UNSUPPORTED', '暂不支持扩展尺寸 MP4 box', 422);
    }
    const size = rawSize === 0 ? buffer.length - offset : rawSize;
    if (size < 8 || offset + size > buffer.length) {
      throw createProxyError('QISHUI_AUDIO_MP4_INVALID', '汽水音频 MP4 box 越界', 422);
    }
    required.delete(type);
    offset += size;
    boxCount += 1;
    if (boxCount > 4096) {
      throw createProxyError('QISHUI_AUDIO_MP4_INVALID', '汽水音频 MP4 box 数量异常', 422);
    }
    if (rawSize === 0) break;
  }
  if (offset !== buffer.length || required.size) {
    throw createProxyError('QISHUI_AUDIO_MP4_INVALID', '汽水音频缺少必要的 MP4 数据', 422);
  }
  return true;
}

async function readResponseBuffer(response, maxBytes) {
  const declared = Number(response && response.headers && response.headers.get('content-length')) || 0;
  if (declared > maxBytes) {
    throw createProxyError('QISHUI_AUDIO_TOO_LARGE', '汽水音频文件超过安全大小限制', 413);
  }
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw createProxyError('QISHUI_AUDIO_TOO_LARGE', '汽水音频文件超过安全大小限制', 413);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (_) {}
        throw createProxyError('QISHUI_AUDIO_TOO_LARGE', '汽水音频文件超过安全大小限制', 413);
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  return Buffer.concat(chunks, total);
}

function resolveByteRange(value, total) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.includes(',')) return { invalid: true };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, total - 1) };
}

function sendAudioBuffer(res, payload, range, method) {
  const buffer = payload && payload.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw createProxyError('QISHUI_AUDIO_BUFFER_EMPTY', '汽水音频解密结果为空', 500);
  }
  const total = buffer.length;
  const resolvedRange = resolveByteRange(range, total);
  const common = {
    'Content-Type': payload.contentType || 'audio/mp4',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  };
  if (resolvedRange && resolvedRange.invalid) {
    res.writeHead(416, { ...common, 'Content-Range': 'bytes */' + total });
    res.end();
    return;
  }
  if (resolvedRange) {
    const length = resolvedRange.end - resolvedRange.start + 1;
    res.writeHead(206, {
      ...common,
      'Content-Length': length,
      'Content-Range': 'bytes ' + resolvedRange.start + '-' + resolvedRange.end + '/' + total,
    });
    if (String(method || '').toUpperCase() === 'HEAD') res.end();
    else res.end(buffer.subarray(resolvedRange.start, resolvedRange.end + 1));
    return;
  }
  res.writeHead(200, { ...common, 'Content-Length': total });
  if (String(method || '').toUpperCase() === 'HEAD') res.end();
  else res.end(buffer);
}

class QishuiAudioProxy {
  constructor(options) {
    options = options || {};
    this.fetch = options.fetch || global.fetch;
    this.decryptor = options.decryptor || new TrackDecryptor();
    this.maxSourceBytes = boundedPositive(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, 512 * 1024 * 1024);
    this.maxCacheBytes = boundedPositive(options.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES, 1024 * 1024 * 1024);
    this.maxCacheEntries = boundedPositive(options.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 16);
    this.maxConcurrent = boundedPositive(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 4);
    this.maxQueued = boundedPositive(options.maxQueued, DEFAULT_MAX_QUEUED, 24);
    this.cacheTtlMs = boundedPositive(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 2 * 60 * 60 * 1000);
    this.fetchTimeoutMs = boundedPositive(options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS, 120000);
    this.cache = new Map();
    this.cacheBytes = 0;
    this.inflight = new Map();
    this.active = 0;
    this.waiters = [];
  }

  cacheKey(cleanUrl, auth) {
    return crypto.createHash('sha256').update(cleanUrl + '\n' + auth).digest('hex');
  }

  pruneCache(now) {
    now = now || Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.at <= this.cacheTtlMs) continue;
      this.cache.delete(key);
      this.cacheBytes -= entry.buffer.length;
    }
    while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].buffer.length;
    }
    this.cacheBytes = Math.max(0, this.cacheBytes);
  }

  remember(key, payload) {
    if (!payload || !Buffer.isBuffer(payload.buffer) || payload.buffer.length > this.maxCacheBytes) return;
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.buffer.length;
    this.cache.set(key, { ...payload, at: Date.now() });
    this.cacheBytes += payload.buffer.length;
    this.pruneCache();
  }

  async acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= this.maxQueued) {
      throw createProxyError('QISHUI_AUDIO_BUSY', '汽水音频解密任务过多，请稍后重试', 429);
    }
    await new Promise(resolve => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  async withSlot(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  subscribe(entry, signal) {
    const consumer = {};
    entry.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
        entry.consumers.delete(consumer);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onAbort = () => {
        finish(reject, createProxyError(
          'QISHUI_AUDIO_CLIENT_ABORTED',
          '汽水音频请求已取消',
          499
        ));
        if (!entry.settled && entry.consumers.size === 0 && !entry.controller.signal.aborted) {
          entry.abortKind = 'downstream';
          entry.controller.abort();
        }
      };
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      entry.promise.then(
        value => finish(resolve, value),
        error => finish(reject, error)
      );
    });
  }

  async load(value, headers, options) {
    options = options || {};
    const signal = options.signal;
    if (signal && signal.aborted) {
      throw createProxyError('QISHUI_AUDIO_CLIENT_ABORTED', '汽水音频请求已取消', 499);
    }
    const parsed = parseEncryptedAudioUrl(value);
    if (!parsed.auth) return null;
    const cleanUrl = assertRemoteHttpUrl(parsed.cleanUrl);
    const key = this.cacheKey(cleanUrl, parsed.auth);
    this.pruneCache();
    const cached = this.cache.get(key);
    if (cached) {
      cached.at = Date.now();
      return cached;
    }
    let entry = this.inflight.get(key);
    if (entry && entry.controller.signal.aborted) {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
      entry = null;
    }
    if (!entry) {
      entry = {
        abortKind: '',
        consumers: new Set(),
        controller: new AbortController(),
        promise: null,
        settled: false,
        timedOut: false,
      };
      const operation = this.withSlot(async () => {
        const timer = setTimeout(() => {
          entry.timedOut = true;
          entry.abortKind = 'timeout';
          entry.controller.abort();
        }, this.fetchTimeoutMs);
        try {
          if (entry.controller.signal.aborted) {
            throw createProxyError('QISHUI_AUDIO_CLIENT_ABORTED', '汽水音频请求已取消', 499);
          }
          const response = await this.fetch(cleanUrl, {
            headers: headers || {},
            redirect: 'follow',
            signal: entry.controller.signal,
          });
          if (!response || !response.ok) {
            throw createProxyError(
              'QISHUI_AUDIO_FETCH_FAILED',
              '汽水音频下载失败: HTTP ' + (response && response.status || 0),
              502
            );
          }
          const encryptedBuffer = await readResponseBuffer(response, this.maxSourceBytes);
          validateTopLevelMp4(encryptedBuffer);
          const result = this.decryptor.decrypt({ encryptedBuffer, spadeA: parsed.auth });
          if (!result || !Buffer.isBuffer(result.buffer) || !result.buffer.length) {
            throw createProxyError('QISHUI_AUDIO_DECRYPT_FAILED', '汽水音频解密失败', 422);
          }
          const payload = {
            buffer: result.buffer,
            contentType: result.extension === '.flac' ? 'audio/flac' : 'audio/mp4',
            extension: result.extension,
          };
          this.remember(key, payload);
          return payload;
        } catch (error) {
          if (error && error.name === 'AbortError') {
            if (entry.abortKind === 'downstream') {
              throw createProxyError('QISHUI_AUDIO_CLIENT_ABORTED', '汽水音频请求已取消', 499);
            }
            throw createProxyError('QISHUI_AUDIO_FETCH_TIMEOUT', '汽水音频下载超时', 504);
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      });
      entry.promise = operation.finally(() => {
        entry.settled = true;
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
      this.inflight.set(key, entry);
    }
    return this.subscribe(entry, signal);
  }
}

function createQishuiAudioProxy(options) {
  return new QishuiAudioProxy(options);
}

module.exports = {
  QishuiAudioProxy,
  createQishuiAudioProxy,
  parseEncryptedAudioUrl,
  resolveByteRange,
  sendAudioBuffer,
  validateTopLevelMp4,
};
