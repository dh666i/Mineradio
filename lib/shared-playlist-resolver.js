'use strict';

const crypto = require('node:crypto');

const MAX_REDIRECTS = 4;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PUBLIC_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_PUBLIC_TRACKS = 500;
const MAX_QISHUI_PUBLIC_TRACKS = 300;
const KUGOU_H5_SECRET = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KUGOU_ANDROID_SECRET = 'OIlwieks28dk2k092lksi2UIkp';
const KUGOU_MOBILE_ORIGIN = 'https://m.kugou.com';
const KUGOU_MOBILE_API_ORIGIN = 'https://mobiles.kugou.com';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

function normalizeHost(value) {
  return String(value || '').replace(/^\.+|\.+$/g, '').toLowerCase();
}

function providerForHost(hostname) {
  const host = normalizeHost(hostname);
  if (host === 'music.163.com' || host.endsWith('.music.163.com') || host === '163cn.tv' || host.endsWith('.163cn.tv')) return 'netease';
  if (host === 'y.qq.com' || host.endsWith('.y.qq.com')) return 'qq';
  if (host === 'kugou.com' || host.endsWith('.kugou.com')) return 'kugou';
  if (host === 'qishui.douyin.com' || host === 'music.douyin.com') return 'qishui';
  if (host === 'open.spotify.com' || host === 'spotify.link') return 'spotify';
  return '';
}

function safeHttpUrl(value, base) {
  try {
    const parsed = new URL(String(value || ''), base);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function firstSharedHttpUrl(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'<>]+/ig) || [];
  for (const value of matches.slice(0, 12)) {
    const parsed = safeHttpUrl(value.replace(/[),，。！？；;]+$/g, ''));
    if (parsed && providerForHost(parsed.hostname)) return parsed;
  }
  return null;
}

function queryValue(url, names) {
  for (const name of names) {
    const value = String(url.searchParams.get(name) || '').trim();
    if (value) return value;
  }
  const hash = String(url.hash || '');
  for (const name of names) {
    const match = hash.match(new RegExp('(?:[?&]|^)' + name + '=([^&]+)', 'i'));
    if (match) return decodeURIComponent(match[1]);
  }
  return '';
}

function parseProviderUrl(url, provider) {
  const source = decodeURIComponent(url.toString());
  let match;
  if (provider === 'netease') {
    const id = queryValue(url, ['id', 'playlistId']);
    match = source.match(/\/playlist\/(\d{5,})/i);
    return /^\d{5,}$/.test(id) ? id : (match && match[1] || '');
  }
  if (provider === 'qq') {
    const id = queryValue(url, ['id', 'disstid', 'tid']);
    match = source.match(/(?:playlist|playsquare|taoge|albumDetail)\/(\d{5,})/i);
    if (!match) match = url.pathname.match(/\/(\d{5,})(?:\.html)?$/i);
    return /^\d{5,}$/.test(id) ? id : (match && match[1] || '');
  }
  if (provider === 'kugou') {
    const id = queryValue(url, ['global_collection_id', 'global_specialid', 'specialid', 'listid', 'id', 'src_cid']);
    match = source.match(/\/songlist\/([^/?#]+)/i) || source.match(/gcid_([a-z0-9]+)/i);
    return String(id || (match && match[1]) || '').replace(/^gcid_/i, 'gcid_').slice(0, 160);
  }
  if (provider === 'qishui') {
    const id = queryValue(url, ['playlist_id', 'playlistId', 'id']);
    match = source.match(/(?:playlist_id|playlistId)["':=\s%]+([a-z0-9_-]{5,})/i);
    return String(id || (match && match[1]) || '').slice(0, 160);
  }
  if (provider === 'spotify') {
    match = url.pathname.match(/\/playlist\/([a-z0-9]{10,})/i);
    return match && match[1] || '';
  }
  return '';
}

function parseEmbeddedProviderId(text, provider) {
  const source = String(text || '');
  let match;
  if (provider === 'netease') match = source.match(/(?:playlistId|playlist_id|playlist\?id)["':=\s\\/%]+(\d{5,})/i);
  if (provider === 'qq') match = source.match(/(?:disstid|playlistId|playlist_id|tid)["':=\s\\/%]+(\d{5,})/i);
  if (provider === 'kugou') {
    match = source.match(/(?:global_collection_id|global_specialid|specialid|listid)["':=\s\\/%]+([a-z0-9_-]{3,})/i)
      || source.match(/gcid_([a-z0-9]+)/i);
  }
  if (provider === 'qishui') match = source.match(/(?:playlist_id|playlistId)["':=\s\\/%]+([a-z0-9_-]{5,})/i);
  if (provider === 'spotify') match = source.match(/spotify:playlist:([a-z0-9]{10,})/i);
  return match && match[1] || '';
}

function parseDirectReference(input) {
  const text = String(input || '').trim();
  const directPatterns = [
    ['netease', /(?:^|\s)netease:(\d{5,})(?:\s|$)/i],
    ['qq', /(?:^|\s)qq:(\d{5,})(?:\s|$)/i],
    ['kugou', /(?:^|\s)kugou:([a-z0-9_-]{3,})(?:\s|$)/i],
    ['qishui', /(?:^|\s)qishui:([a-z0-9_-]{5,})(?:\s|$)/i],
    ['spotify', /(?:^|\s)spotify:(?:playlist:)?([a-z0-9]{10,})(?:\s|$)/i],
  ];
  for (const entry of directPatterns) {
    const match = text.match(entry[1]);
    if (match) return { provider: entry[0], id: match[1], sourceUrl: '' };
  }
  const url = firstSharedHttpUrl(text);
  if (!url) return null;
  const provider = providerForHost(url.hostname);
  const id = parseProviderUrl(url, provider);
  return { provider, id, sourceUrl: url.toString(), url };
}

async function readResponseTextLimited(response, maxBytes) {
  maxBytes = Math.max(1, Number(maxBytes) || MAX_RESPONSE_BYTES);
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    const text = response && typeof response.text === 'function' ? await response.text() : '';
    return String(text || '').slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const item = await reader.read();
      if (item.done) break;
      const value = Buffer.from(item.value || []);
      const remaining = maxBytes - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.length, remaining);
      if (value.length > remaining) break;
    }
  } finally {
    try { await reader.cancel(); } catch (_) {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchSharedPage(url, options) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('SHARED_PLAYLIST_FETCH_UNAVAILABLE');
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url.toString(), {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': options.userAgent || 'Mineradio',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSharedPlaylist(input, options = {}) {
  const direct = parseDirectReference(input);
  if (!direct || !direct.provider) {
    const error = new Error('UNSUPPORTED_SHARED_PLAYLIST');
    error.code = 'UNSUPPORTED_SHARED_PLAYLIST';
    throw error;
  }
  if (direct.id) {
    return {
      provider: direct.provider,
      id: direct.id,
      sourceUrl: direct.sourceUrl,
      resolvedUrl: direct.sourceUrl,
      redirected: false,
    };
  }
  if (!direct.url) {
    const error = new Error('SHARED_PLAYLIST_ID_MISSING');
    error.code = 'SHARED_PLAYLIST_ID_MISSING';
    throw error;
  }
  const provider = direct.provider;
  let current = direct.url;
  const visited = new Set();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (providerForHost(current.hostname) !== provider) {
      const error = new Error('SHARED_PLAYLIST_REDIRECT_BLOCKED');
      error.code = 'SHARED_PLAYLIST_REDIRECT_BLOCKED';
      throw error;
    }
    const key = current.toString();
    if (visited.has(key)) {
      const error = new Error('SHARED_PLAYLIST_REDIRECT_LOOP');
      error.code = 'SHARED_PLAYLIST_REDIRECT_LOOP';
      throw error;
    }
    visited.add(key);
    const parsedId = parseProviderUrl(current, provider);
    if (parsedId) {
      return {
        provider,
        id: parsedId,
        sourceUrl: direct.sourceUrl,
        resolvedUrl: current.toString(),
        redirected: hop > 0,
      };
    }
    const response = await fetchSharedPage(current, options);
    const location = response && response.headers && response.headers.get && response.headers.get('location');
    if (response && response.status >= 300 && response.status < 400 && location) {
      const next = safeHttpUrl(location, current);
      if (!next || providerForHost(next.hostname) !== provider) {
        const error = new Error('SHARED_PLAYLIST_REDIRECT_BLOCKED');
        error.code = 'SHARED_PLAYLIST_REDIRECT_BLOCKED';
        throw error;
      }
      current = next;
      continue;
    }
    const responseUrl = response && response.url ? safeHttpUrl(response.url) : null;
    if (responseUrl && providerForHost(responseUrl.hostname) === provider) current = responseUrl;
    const html = await readResponseTextLimited(response, options.maxResponseBytes);
    const embeddedId = parseProviderUrl(current, provider) || parseEmbeddedProviderId(html, provider);
    if (embeddedId) {
      return {
        provider,
        id: embeddedId,
        sourceUrl: direct.sourceUrl,
        resolvedUrl: current.toString(),
        redirected: hop > 0 || current.toString() !== direct.sourceUrl,
      };
    }
    break;
  }
  const error = new Error('SHARED_PLAYLIST_ID_MISSING');
  error.code = 'SHARED_PLAYLIST_ID_MISSING';
  throw error;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16) || 32))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanExternalText(value) {
  return stripHtml(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExternalUrl(value) {
  let text = cleanExternalText(value)
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/');
  if (/^\/\//.test(text)) text = 'https:' + text;
  return /^https?:\/\//i.test(text) ? text : '';
}

function stableExternalId(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

function firstInputUrl(value) {
  const match = String(value || '').match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0].replace(/[),，。！？；;、\]}]+$/g, '') : '';
}

function extractHtmlMeta(html, name) {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = String(html || '');
  const first = source.match(new RegExp(
    '<meta[^>]+(?:name|property|itemprop)=["\']' + escaped + '["\'][^>]+content=["\']([^"\']+)["\']',
    'i'
  ));
  if (first) return cleanExternalText(first[1]);
  const reversed = source.match(new RegExp(
    '<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:name|property|itemprop)=["\']' + escaped + '["\']',
    'i'
  ));
  return reversed ? cleanExternalText(reversed[1]) : '';
}

function publicFetchError(code, message, statusCode) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode || 0;
  return error;
}

async function requestPublicText(target, options, init) {
  options = options || {};
  init = init || {};
  const parsed = safeHttpUrl(target);
  if (!parsed || !providerForHost(parsed.hostname)) {
    throw publicFetchError('SHARED_PLAYLIST_HOST_BLOCKED', '分享歌单地址不受支持', 400);
  }
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw publicFetchError('SHARED_PLAYLIST_FETCH_UNAVAILABLE', '当前环境无法读取分享页');
  }
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(parsed.toString(), {
      method: init.method || 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: Object.assign({
        'User-Agent': options.userAgent || MOBILE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
      }, init.headers || {}),
      body: init.body,
    });
    const text = await readResponseTextLimited(
      response,
      options.maxPublicResponseBytes || MAX_PUBLIC_RESPONSE_BYTES
    );
    if (response && Number(response.status) >= 400) {
      const error = publicFetchError(
        'SHARED_PLAYLIST_HTTP_' + response.status,
        '分享页请求失败: HTTP ' + response.status,
        Number(response.status)
      );
      error.body = text;
      throw error;
    }
    return { response, text, url: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSameProviderDocument(target, provider, options, headers) {
  let current = safeHttpUrl(target);
  const visited = new Set();
  if (!current || providerForHost(current.hostname) !== provider) {
    throw publicFetchError('SHARED_PLAYLIST_HOST_BLOCKED', '分享歌单地址不受支持', 400);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const key = current.toString();
    if (visited.has(key)) {
      throw publicFetchError('SHARED_PLAYLIST_REDIRECT_LOOP', '分享链接出现循环跳转');
    }
    visited.add(key);
    const result = await requestPublicText(current, options, { headers });
    const response = result.response || {};
    const location = response.headers && response.headers.get && response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = safeHttpUrl(location, current);
      if (!next || providerForHost(next.hostname) !== provider) {
        throw publicFetchError('SHARED_PLAYLIST_REDIRECT_BLOCKED', '分享链接跳转到了不受支持的地址');
      }
      current = next;
      continue;
    }
    const responseUrl = response.url ? safeHttpUrl(response.url) : null;
    if (responseUrl) {
      if (providerForHost(responseUrl.hostname) !== provider) {
        throw publicFetchError('SHARED_PLAYLIST_REDIRECT_BLOCKED', '分享链接跳转到了不受支持的地址');
      }
      current = responseUrl;
    }
    return {
      html: result.text,
      url: current.toString(),
      redirected: hop > 0 || current.toString() !== String(target),
    };
  }
  throw publicFetchError('SHARED_PLAYLIST_REDIRECT_LIMIT', '分享链接跳转次数过多');
}

function normalizePublicPlaylist(provider, playlist, tracks, extra) {
  playlist = playlist || {};
  extra = extra || {};
  const normalizedTracks = (tracks || [])
    .slice(0, provider === 'qishui' ? MAX_QISHUI_PUBLIC_TRACKS : MAX_PUBLIC_TRACKS)
    .filter(track => track && track.name);
  const trackCount = Math.max(
    normalizedTracks.length,
    Number(playlist.trackCount || extra.trackCount || 0) || 0
  );
  const partial = !!(playlist.partial || extra.partial || trackCount > normalizedTracks.length);
  const normalizedPlaylist = {
    provider,
    source: provider,
    type: 'playlist',
    id: String(playlist.id || stableExternalId(playlist.sourceUrl || playlist.name)),
    name: cleanExternalText(playlist.name || '导入歌单'),
    cover: normalizeExternalUrl(playlist.cover || ''),
    creator: cleanExternalText(playlist.creator || ''),
    sourceUrl: playlist.sourceUrl || '',
    trackCount,
    loadedCount: normalizedTracks.length,
    partial,
    partialReason: playlist.partialReason || extra.partialReason || '',
  };
  return {
    ok: true,
    provider,
    id: normalizedPlaylist.id,
    sourceUrl: normalizedPlaylist.sourceUrl,
    resolvedUrl: normalizedPlaylist.sourceUrl,
    redirected: !!extra.redirected,
    playlist: normalizedPlaylist,
    tracks: normalizedTracks,
    total: trackCount,
    trackCount,
    loadedCount: normalizedTracks.length,
    partial,
  };
}

function parseKugouShareInput(value) {
  const raw = String(value || '').trim();
  const directReference = raw.match(/(?:^|\s)kugou:([a-z0-9_-]+)(?:\s|$)/i);
  const directId = String(directReference && directReference[1] || '');
  const sourceUrl = firstInputUrl(raw);
  const decoded = (() => {
    try { return decodeURIComponent(sourceUrl || raw); } catch (_) { return sourceUrl || raw; }
  })();
  const parsed = safeHttpUrl(sourceUrl);
  const query = parsed && parsed.searchParams;
  const gcidMatch = decoded.match(/gcid_([a-z0-9]+)/i);
  const pathSpecial = parsed && parsed.pathname.match(/\/songlist\/(\d+)(?:\/|$)/i);
  const gcid = String(
    (/^gcid_([a-z0-9]+)$/i.exec(directId) || [])[1] ||
    gcidMatch && gcidMatch[1] ||
    query && String(query.get('src_cid') || '').replace(/^gcid_/i, '') ||
    ''
  );
  const globalCollectionId = String(
    directId && !/^(?:gcid_|special_|\d+$)/i.test(directId) ? directId :
    query && (query.get('global_collection_id') || query.get('global_specialid')) ||
    (decoded.match(/(?:global_collection_id|global_specialid)[=:\/\s%]+([a-z0-9_-]+)/i) || [])[1] ||
    ''
  );
  const specialId = String(
    (/^special_(\d+)$/i.exec(directId) || [])[1] ||
    (/^\d+$/.test(directId) ? directId : '') ||
    query && (query.get('specialid') || query.get('listid')) ||
    (decoded.match(/(?:specialid|listid)[=:\/\s%]+(\d+)/i) || [])[1] ||
    pathSpecial && pathSpecial[1] ||
    (/^special_(\d+)$/i.exec(raw) || [])[1] ||
    ''
  );
  return {
    sourceUrl,
    gcid: gcid.replace(/^gcid_/i, ''),
    globalCollectionId,
    specialId,
    uid: String(query && query.get('uid') || ''),
    cover: String(query && query.get('cover') || ''),
  };
}

function kugouSignature(query, secret, body) {
  const sorted = String(query || '').split('&').filter(Boolean).sort().join('');
  return crypto.createHash('md5')
    .update(secret + sorted + String(body || '') + secret)
    .digest('hex');
}

function kugouHeaders(clientTime) {
  const stamp = String(clientTime || '1586163242519');
  return {
    Referer: 'https://m3ws.kugou.com/share/index.php',
    Origin: 'https://m3ws.kugou.com',
    'User-Agent': MOBILE_USER_AGENT,
    mid: stamp,
    dfid: '-',
    clienttime: stamp,
  };
}

async function kugouApiJson(target, options, init) {
  const result = await requestPublicText(target, options, init);
  let text = String(result.text || '').trim();
  const callback = text.match(/^[^(]*\(([\s\S]*)\)\s*;?$/);
  if (callback) text = callback[1];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    throw publicFetchError('KUGOU_PUBLIC_JSON_INVALID', '酷狗公开接口返回了无效数据');
  }
  const errorCode = payload && (payload.errcode ?? payload.err_code ?? payload.error_code);
  if (payload && payload.status === 0 || errorCode != null && String(errorCode) !== '0') {
    throw publicFetchError(
      'KUGOU_PUBLIC_API_FAILED',
      cleanExternalText(payload && (payload.error || payload.errmsg || payload.msg)) || '酷狗公开接口暂时不可用'
    );
  }
  return payload || {};
}

function kugouData(payload) {
  return payload && (payload.data || payload.info) || payload || {};
}

async function decodeKugouGcid(gcid, options) {
  gcid = String(gcid || '').replace(/^gcid_/i, '');
  const params = 'dfid=-&appid=1005&mid=0&clientver=20109&clienttime=640612895&uuid=-';
  const body = JSON.stringify({ ret_info: 1, data: [{ id: 'gcid_' + gcid, id_type: 2 }] });
  const target = 'https://t.kugou.com/v1/songlist/batch_decode?' + params +
    '&signature=' + kugouSignature(params, KUGOU_ANDROID_SECRET, body);
  const payload = await kugouApiJson(target, options, {
    method: 'POST',
    headers: Object.assign({}, kugouHeaders(), { 'Content-Type': 'application/json' }),
    body,
  });
  const data = kugouData(payload);
  const list = Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : []);
  return String(list[0] && (list[0].global_collection_id || list[0].global_specialid) || '');
}

async function fetchKugouListInfo(id, kind, options) {
  const clientTime = '1586163242519';
  const idQuery = kind === 'special'
    ? 'specialid=' + encodeURIComponent(id) + '&global_specialid='
    : 'specialid=0&global_specialid=' + encodeURIComponent(id);
  const params = 'appid=1058&' + idQuery +
    '&format=jsonp&srcappid=2919&clientver=20000&clienttime=' + clientTime +
    '&mid=' + clientTime + '&uuid=' + clientTime + '&dfid=-';
  const target = KUGOU_MOBILE_API_ORIGIN + '/api/v5/special/info_v2?' + params +
    '&signature=' + kugouSignature(params, KUGOU_H5_SECRET);
  return kugouData(await kugouApiJson(target, options, { headers: kugouHeaders(clientTime) }));
}

async function fetchKugouListSongs(id, kind, total, options) {
  const tracks = [];
  let page = 1;
  const expected = Math.min(Math.max(1, Number(total) || MAX_PUBLIC_TRACKS), MAX_PUBLIC_TRACKS);
  while (tracks.length < expected) {
    const pageSize = Math.min(300, expected - tracks.length);
    const clientTime = '1586163263991';
    const idQuery = kind === 'special'
      ? 'global_specialid=&specialid=' + encodeURIComponent(id)
      : 'global_specialid=' + encodeURIComponent(id) + '&specialid=0';
    const params = 'appid=1058&' + idQuery +
      '&plat=0&version=8000&page=' + page + '&pagesize=' + pageSize +
      '&srcappid=2919&clientver=20000&clienttime=' + clientTime +
      '&mid=' + clientTime + '&uuid=' + clientTime + '&dfid=-';
    const target = KUGOU_MOBILE_API_ORIGIN + '/api/v5/special/song_v2?' + params +
      '&signature=' + kugouSignature(params, KUGOU_H5_SECRET);
    const data = kugouData(await kugouApiJson(target, options, { headers: kugouHeaders(clientTime) }));
    const songs = Array.isArray(data.info)
      ? data.info
      : (Array.isArray(data.songs) ? data.songs : (Array.isArray(data.list) ? data.list : []));
    if (!songs.length) break;
    tracks.push(...songs);
    if (songs.length < pageSize) break;
    page += 1;
  }
  return tracks.slice(0, MAX_PUBLIC_TRACKS);
}

function extractWindowOutputJson(html) {
  const source = String(html || '');
  const marker = source.indexOf('window.$output');
  if (marker < 0) return '';
  const equals = source.indexOf('=', marker);
  if (equals < 0) return '';
  let start = equals + 1;
  while (/\s/.test(source[start] || '')) start += 1;
  if (source[start] !== '{') return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return '';
}

function kugouCover(value) {
  return normalizeExternalUrl(String(value || '').replace('{size}', '480'));
}

function mapPublicKugouTrack(raw, index) {
  raw = raw || {};
  const singers = Array.isArray(raw.singerinfo) ? raw.singerinfo : (Array.isArray(raw.Singers) ? raw.Singers : []);
  let artist = cleanExternalText(
    raw.singerName || raw.author_name || raw.singername || raw.SingerName ||
    singers.map(item => item && (item.name || item.SingerName)).filter(Boolean).join(' / ')
  );
  let name = cleanExternalText(raw.name || raw.songname || raw.fileName || raw.filename || raw.SongName || '');
  const split = name.indexOf(' - ');
  if (split > 0) {
    artist = artist || cleanExternalText(name.slice(0, split));
    name = cleanExternalText(name.slice(split + 3));
  }
  const hash = String(raw.hash || raw.FileHash || '');
  const mixSongId = String(raw.mixsongid || raw.add_mixsongid || raw.EMixSongID || raw.MixSongID || raw.album_audio_id || '');
  const albumId = String(raw.album_id || raw.albumid || raw.AlbumID || raw.req_albumid || '');
  const durationMs = Number(raw.timelen || raw.timeLength || 0) ||
    (Number(raw.duration || raw.Duration || 0) || 0) * 1000;
  const privilege = Number(raw.privilege || raw.Privilege || raw.media_privilege || 0) || 0;
  return {
    provider: 'kugou',
    source: 'kugou',
    type: 'kugou',
    id: hash || mixSongId || ('kugou-public-' + stableExternalId(name + '|' + artist + '|' + index)),
    hash,
    fileHash: hash,
    mixSongId,
    albumAudioId: String(raw.encode_album_audio_id || raw.album_audio_id || mixSongId || ''),
    albumId,
    name,
    artist,
    artists: artist ? [{ name: artist }] : [],
    album: cleanExternalText(raw.remark || raw.albumName || raw.AlbumName || raw.albuminfo && raw.albuminfo.name || ''),
    cover: kugouCover(raw.cover || raw.imgUrl || raw.Image || raw.trans_param && raw.trans_param.union_cover || ''),
    duration: durationMs,
    fee: Number(raw.feetype || raw.pay_type || 0) ? 1 : 0,
    privilege,
    playable: privilege <= 8,
    playbackFallbackOnly: !hash && !mixSongId,
  };
}

async function readKugouList(id, kind, info, sourceUrl, options) {
  const listInfo = await fetchKugouListInfo(id, kind, options);
  const total = Number(listInfo.songcount || listInfo.count || MAX_PUBLIC_TRACKS) || MAX_PUBLIC_TRACKS;
  const rawSongs = await fetchKugouListSongs(id, kind, total, options);
  return normalizePublicPlaylist('kugou', {
    id: kind === 'special' ? 'special_' + id : id,
    name: listInfo.specialname || listInfo.name || '酷狗歌单',
    cover: kugouCover(listInfo.imgurl || listInfo.pic || info.cover || ''),
    creator: listInfo.nickname || listInfo.list_create_username || listInfo.suid || info.uid || '',
    sourceUrl,
    trackCount: Number(listInfo.songcount || listInfo.count || rawSongs.length) || rawSongs.length,
  }, rawSongs.map(mapPublicKugouTrack));
}

async function importKugouPublicPlaylist(input, options) {
  const info = parseKugouShareInput(input);
  if (!info.gcid && !info.globalCollectionId && !info.specialId) {
    throw publicFetchError('SHARED_PLAYLIST_ID_MISSING', '没有从酷狗分享链接中识别到歌单', 400);
  }
  const sourceUrl = info.sourceUrl || (
    info.gcid
      ? KUGOU_MOBILE_ORIGIN + '/songlist/gcid_' + info.gcid + '/?src_cid=' + info.gcid
      : ''
  );
  let lastError = null;
  let globalCollectionId = info.globalCollectionId;
  if (!globalCollectionId && info.gcid) {
    try {
      globalCollectionId = await decodeKugouGcid(info.gcid, options);
    } catch (error) {
      lastError = error;
    }
  }
  if (globalCollectionId) {
    try {
      return await readKugouList(globalCollectionId, 'collection', info, sourceUrl, options);
    } catch (error) {
      lastError = error;
    }
  }
  if (info.specialId) {
    try {
      return await readKugouList(info.specialId, 'special', info, sourceUrl, options);
    } catch (error) {
      lastError = error;
    }
  }
  if (!info.gcid) throw lastError || publicFetchError('KUGOU_PUBLIC_PLAYLIST_FAILED', '酷狗公开歌单读取失败');
  const mobileUrl = sourceUrl || KUGOU_MOBILE_ORIGIN + '/songlist/gcid_' + info.gcid + '/?src_cid=' + info.gcid;
  const page = await fetchSameProviderDocument(mobileUrl, 'kugou', options, {
    Referer: KUGOU_MOBILE_ORIGIN + '/',
    Origin: KUGOU_MOBILE_ORIGIN,
    'User-Agent': MOBILE_USER_AGENT,
  });
  const jsonText = extractWindowOutputJson(page.html);
  if (!jsonText) throw lastError || publicFetchError('KUGOU_PUBLIC_PAGE_EMPTY', '酷狗分享页没有返回歌单数据');
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (_) {
    throw publicFetchError('KUGOU_PUBLIC_PAGE_INVALID', '酷狗分享页数据解析失败');
  }
  const body = data && data.info || {};
  const listInfo = body.listinfo || {};
  let rawSongs = Array.isArray(body.songs) ? body.songs : [];
  if (listInfo.specialid && Number(listInfo.count || body.count || 0) > rawSongs.length) {
    try {
      const full = await readKugouList(String(listInfo.specialid), 'special', info, page.url, options);
      if (full.tracks.length > rawSongs.length) return full;
    } catch (_) {}
  }
  return normalizePublicPlaylist('kugou', {
    id: listInfo.specialid ? 'special_' + listInfo.specialid : 'gcid_' + info.gcid,
    name: listInfo.name || '酷狗歌单',
    cover: kugouCover(listInfo.pic || info.cover || ''),
    creator: listInfo.list_create_username || info.uid || '',
    sourceUrl: page.url,
    trackCount: Number(listInfo.count || body.count || rawSongs.length) || rawSongs.length,
  }, rawSongs.map(mapPublicKugouTrack), { redirected: page.redirected });
}

function parseQishuiPlaylistId(value) {
  const raw = String(value || '');
  const direct = raw.match(/(?:playlist_id|playlistId)[=:\/\s"'\\%]+([a-z0-9_-]{5,})/i) ||
    raw.match(/(?:^|\s)qishui:([a-z0-9_-]{5,})(?:\s|$)/i);
  if (direct) return direct[1];
  const parsed = safeHttpUrl(firstInputUrl(raw) || raw);
  return parsed ? String(parsed.searchParams.get('playlist_id') || parsed.searchParams.get('playlistId') || '') : '';
}

function firstJsonImage(html) {
  const source = String(html || '');
  const match = source.match(/"(?:cover|cover_url|image|image_url|pic|pic_url)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)
    || source.match(/(https?:\\?\/\\?\/[^"'<>\s]+\.(?:jpg|jpeg|png|webp)[^"'<>\s]*)/i);
  if (!match) return '';
  let value = match[1] || '';
  try { value = JSON.parse('"' + value.replace(/"/g, '\\"') + '"'); } catch (_) {}
  return normalizeExternalUrl(value);
}

function mapPublicQishuiTrack(name, meta, cover, index) {
  name = cleanExternalText(name);
  meta = cleanExternalText(meta);
  if (!name || name.length > 120) return null;
  const parts = meta.split(/\s*[·•|]\s*/).map(cleanExternalText).filter(Boolean);
  const artist = parts[0] || '';
  return {
    provider: 'qishui',
    source: 'qishui',
    type: 'qishui',
    id: 'qishui-public-' + stableExternalId(name + '|' + artist + '|' + index),
    providerSongId: '',
    name,
    artist,
    artists: artist ? [{ name: artist }] : [],
    album: parts.slice(1).join(' / '),
    cover,
    duration: 0,
    fee: 0,
    playable: false,
    playbackMode: 'recommend-match',
    recommendationSource: 'qishui-public-share',
    playbackFallbackOnly: true,
    restriction: {
      category: 'provider_limited',
      message: '汽水分享歌曲会自动匹配已登录平台的可播版本。',
      action: 'switch_source',
    },
  };
}

function parseQishuiRenderedTracks(html, cover) {
  const tracks = [];
  const seen = new Set();
  const rowPattern = /<div[^>]*style=["'][^"']*padding-top:\s*14px;[^"']*padding-bottom:\s*14px;[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*style=["'][^"']*padding-top:\s*14px;[^"']*padding-bottom:\s*14px;|<\/body>|$)/gi;
  let row;
  while ((row = rowPattern.exec(String(html || ''))) && tracks.length < MAX_QISHUI_PUBLIC_TRACKS) {
    const labels = Array.from(row[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
      .map(match => cleanExternalText(match[1]))
      .filter(Boolean);
    if (labels.length < 2) continue;
    const song = mapPublicQishuiTrack(labels[0], labels[1], cover, tracks.length);
    const key = song && (song.name + '|' + song.artist);
    if (!song || seen.has(key)) continue;
    seen.add(key);
    tracks.push(song);
  }
  return tracks;
}

async function importQishuiPublicPlaylist(input, options) {
  const sourceUrl = firstInputUrl(input);
  const directId = parseQishuiPlaylistId(input);
  const target = sourceUrl || (
    directId ? 'https://music.douyin.com/qishui/share/playlist?playlist_id=' + encodeURIComponent(directId) : ''
  );
  if (!target) {
    throw publicFetchError('SHARED_PLAYLIST_ID_MISSING', '没有从汽水分享链接中识别到歌单', 400);
  }
  const page = await fetchSameProviderDocument(target, 'qishui', options, {
    Referer: 'https://music.douyin.com/',
    'User-Agent': MOBILE_USER_AGENT,
  });
  const html = page.html;
  const id = parseQishuiPlaylistId(page.url) || parseQishuiPlaylistId(html) || stableExternalId(page.url);
  const titleTag = (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const name = extractHtmlMeta(html, 'og:title') || extractHtmlMeta(html, 'title') ||
    cleanExternalText(titleTag) || '汽水音乐歌单';
  const cover = normalizeExternalUrl(
    extractHtmlMeta(html, 'og:image') ||
    extractHtmlMeta(html, 'image') ||
    extractHtmlMeta(html, 'twitter:image') ||
    firstJsonImage(html)
  );
  const tracks = parseQishuiRenderedTracks(html, cover);
  const countMatch = String(html || '').match(/(\d+)\s*(?:首|songs?)/i);
  const advertisedCount = Number(countMatch && countMatch[1] || 0) || 0;
  const trackCount = Math.max(tracks.length, advertisedCount);
  const partial = !tracks.length || trackCount > tracks.length;
  return normalizePublicPlaylist('qishui', {
    id,
    name,
    cover,
    creator: '汽水音乐',
    sourceUrl: page.url,
    trackCount,
    partial,
    partialReason: partial ? (tracks.length ? 'qishui_partial_page' : 'qishui_metadata_only') : '',
  }, tracks, { redirected: page.redirected });
}

async function resolveSharedPlaylistWithTracks(input, options = {}) {
  const direct = parseDirectReference(input);
  if (!direct || !direct.provider) {
    throw publicFetchError('UNSUPPORTED_SHARED_PLAYLIST', '暂不支持这个分享链接', 400);
  }
  if (direct.provider === 'kugou') return importKugouPublicPlaylist(input, options);
  if (direct.provider === 'qishui') return importQishuiPublicPlaylist(input, options);
  const resolved = await resolveSharedPlaylist(input, options);
  return { ok: true, ...resolved };
}

module.exports = {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_PUBLIC_TRACKS,
  providerForHost,
  parseDirectReference,
  parseProviderUrl,
  parseKugouShareInput,
  parseQishuiRenderedTracks,
  importKugouPublicPlaylist,
  importQishuiPublicPlaylist,
  resolveSharedPlaylist,
  resolveSharedPlaylistWithTracks,
};
