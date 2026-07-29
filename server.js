// ====================================================================
//  粒子音乐可视化播放器 — Server v2
//  - 网易云搜索 / 歌曲URL / 封面/音频代理
//  - 扫码登录 (login_qr_*) + cookie 持久化 (./.cookie)
//  - 试听检测 (freeTrialInfo) + 全 quality 探测
//  - 所有受保护 API 都会带上已登录用户的 cookie
// ====================================================================
const {
  search,
  cloudsearch,
  song_detail,
  song_url,
  song_url_v1,
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  logout,
  user_account,
  user_playlist,
  user_subcount,
  user_record,
  comment_music,
  artist_detail,
  artist_top_song,
  artist_songs,
  artist_album,
  album,
  like: like_song,
  likelist,
  song_like_check,
  playlist_tracks,
  playlist_track_add,
  playlist_create,
  playlist_update,
  playlist_subscribe,
  playlist_privacy,
  playlist_delete,
  song_order_update,
  playlist_detail,
  playlist_track_all,
  personalized,
  recommend_resource,
  recommend_songs,
  personal_fm,
  fm_trash,
  dj_detail,
  dj_program,
  dj_hot,
  dj_sublist,
  user_audio,
  dj_paygift,
  record_recent_voice,
  record_recent_song,
  sati_resource_sub_list,
  toplist_detail,
  top_song,
  album_new,
  album_sublist,
  artist_sublist,
  playlist_catlist,
  top_playlist,
  user_cloud,
  lyric,
  lyric_new,
} = require('NeteaseCloudMusicApi');
const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { once } = require('events');
const { fileURLToPath } = require('url');
const { analyzePodcastDjStream, analyzePodcastDjIntro } = require('./dj-analyzer');
const {
  getPlaylistEditRestriction,
  getPlaylistSubscriptionRestriction,
  normalizeNeteaseId,
} = require('./lib/netease-playlist-policy');
const {
  parseBlockMapBuffer,
  planDifferentialAssembly,
  verifyCopiedBlock,
  describeDifferentialPlan,
} = require('./lib/update-differ');
const {
  createProviderRoutes,
  MUTATING_POST_ROUTES: PROVIDER_MUTATING_POST_ROUTES,
  POST_ONLY_ROUTES: PROVIDER_POST_ONLY_ROUTES,
} = require('./lib/provider-routes');
const {
  createQishuiAudioProxy,
  sendAudioBuffer: sendQishuiAudioBuffer,
} = require('./lib/qishui-audio-proxy');
const { resolveSharedPlaylistWithTracks } = require('./lib/shared-playlist-resolver');
const { createMediaProxy, validatedContentType } = require('./lib/media-proxy');
const {
  normalizeQQVipPayload: normalizeQQVipPayloadStrict,
  resolveQQVipFromProbes,
  qqVipSessionCacheKey,
  qqVipCacheTtlMs,
} = require('./qq-vip-api');
const {
  TYPED_SEARCH_TYPES,
  mapNeteaseAlbum,
  mapNeteaseArtist,
  mapNeteasePlaylist,
  mapNeteasePlaylistMeta,
  mapPlaylistCategories,
  mapTypedSearchResult,
  normalizePagination,
  normalizePlaylistMetadataPatch,
  normalizeTypedSearchType,
  resolvePageCursor,
} = require('./lib/netease-catalog');

const PROVIDER_TYPED_SEARCH_TYPES = Object.freeze({
  netease: Object.freeze(['artist', 'album', 'playlist']),
  qq: Object.freeze(['artist', 'playlist']),
  kugou: Object.freeze(['playlist']),
  qishui: Object.freeze(['playlist']),
  spotify: Object.freeze(['album', 'playlist']),
});

function normalizeTypedSearchProvider(value) {
  const provider = String(value == null ? 'netease' : value).trim().toLowerCase();
  const aliases = {
    '': 'netease',
    ne: 'netease',
    netease: 'netease',
    'netease-cloud-music': 'netease',
    wangyiyun: 'netease',
    qq: 'qq',
    qqmusic: 'qq',
    'qq-music': 'qq',
    kg: 'kugou',
    kugou: 'kugou',
    'kugou-music': 'kugou',
    qs: 'qishui',
    qishui: 'qishui',
    soda: 'qishui',
    'soda-music': 'qishui',
    sp: 'spotify',
    spotify: 'spotify',
  };
  return aliases[provider] || '';
}

function typedSearchListKey(type) {
  return type === 'artist' ? 'artists' : (type === 'album' ? 'albums' : 'playlists');
}

function typedSearchErrorStatus(error, fallback) {
  const code = String(error || '').toUpperCase();
  if (/AUTH|LOGIN|COOKIE|TOKEN.*REQUIRED|UNAUTHORIZED/.test(code)) return 401;
  if (/RATE|429/.test(code)) return 429;
  if (/INVALID|UNSUPPORTED|MISSING/.test(code)) return 400;
  const explicit = Number(fallback);
  return explicit >= 400 && explicit <= 599 ? explicit : 502;
}

let electronSafeStorage = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.safeStorage) electronSafeStorage = electron.safeStorage;
} catch (_) {}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const RUNTIME_PLATFORM = String(process.env.MINERADIO_RUNTIME_PLATFORM || process.platform).toLowerCase();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, '.cookie');
const QQ_COOKIE_FILE = process.env.QQ_COOKIE_FILE || path.join(__dirname, '.qq-cookie');
const UPDATE_WORK_DIR = process.env.MINERADIO_UPDATE_DIR || path.join(__dirname, 'updates');
const UPDATE_DOWNLOAD_DIR = process.env.MINERADIO_UPDATE_DOWNLOAD_DIR || path.join(UPDATE_WORK_DIR, 'downloads');
const BEATMAP_CACHE_DIR = process.env.MINERADIO_BEAT_CACHE_DIR || path.join(
  process.env.MINERADIO_USER_DATA_DIR
    || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Mineradio') : path.join(__dirname, '.mineradio-data')),
  'cache',
  'beatmaps',
);
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = isPackagedRuntime()
  ? (APP_PACKAGE.version || '0.9.11')
  : (process.env.MINERADIO_VERSION || APP_PACKAGE.version || '0.9.11');
const UPDATE_CONFIG = readUpdateConfig(APP_PACKAGE);
const mediaProxy = createMediaProxy();
const PODCAST_ANALYSIS_MAX_BYTES = 512 * 1024 * 1024;
async function fetchPodcastAnalysisMedia(targetUrl, init) {
  const response = await mediaProxy.fetch(targetUrl, {
    ...(init || {}),
    maxBytes: PODCAST_ANALYSIS_MAX_BYTES,
    totalTimeoutMs: 15 * 60 * 1000,
  });
  if (response.ok) {
    try {
      validatedContentType('audio', response.url, response.headers.get('content-type'));
    } catch (error) {
      if (response.body) {
        try { await response.body.cancel(); } catch (_) {}
      }
      throw error;
    }
  }
  return response;
}
const configuredQishuiMaxSourceBytes = Number(process.env.MINERADIO_QISHUI_AUDIO_MAX_BYTES);
const qishuiMaxSourceBytes = Number.isFinite(configuredQishuiMaxSourceBytes) &&
  configuredQishuiMaxSourceBytes > 0
  ? Math.min(Math.floor(configuredQishuiMaxSourceBytes), 512 * 1024 * 1024)
  : 160 * 1024 * 1024;
const qishuiAudioProxy = createQishuiAudioProxy({
  fetch: async (targetUrl, init) => {
    const response = await mediaProxy.fetch(targetUrl, init);
    const declaredBytes = Number(response.headers.get('content-length')) || 0;
    if ((!response.ok || declaredBytes > qishuiMaxSourceBytes) && response.body) {
      try { await response.body.cancel(); } catch (_) {}
    }
    return response;
  },
  maxSourceBytes: qishuiMaxSourceBytes,
  maxCacheBytes: Number(process.env.MINERADIO_QISHUI_AUDIO_CACHE_BYTES) || 256 * 1024 * 1024,
  maxCacheEntries: 4,
  maxConcurrent: 2,
  maxQueued: 6,
});
const UPDATE_MAX_BYTES = 1024 * 1024 * 1024;
const UPDATE_METADATA_MAX_BYTES = 1024 * 1024;
const UPDATE_READ_IDLE_TIMEOUT_MS = 20000;
const UPDATE_CONNECT_TIMEOUT_MS = 14000;
const UPDATE_PROBE_RANGE_BYTES = 256 * 1024;
const UPDATE_PROBE_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
const UPDATE_PROBE_TIMEOUT_MS = 6500;
const UPDATE_LOW_SPEED_THRESHOLD_BPS = 128 * 1024;
const UPDATE_LOW_SPEED_REQUIRED_GAIN = 1.35;
const UPDATE_LOW_SPEED_GRACE_MS = 6000;
const UPDATE_LOW_SPEED_DURATION_MS = 10000;
const UPDATE_SPEED_WINDOW_MS = 5000;
const UPDATE_BLOCKMAP_MAX_BYTES = 8 * 1024 * 1024;
const UPDATE_DIFF_GAP_BYTES = 256 * 1024;
const UPDATE_DIFF_MAX_FETCH_RATIO = 0.8;
const UPDATE_FALLBACK_NOTES = [
  '电影镜头节奏更松',
  '音源失败自动换源',
  '右上角更新提示',
];
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_IP_LOCATION_URL = 'https://ipwho.is/';
const WEATHER_DEFAULT_LOCATION = {
  name: '上海',
  country: 'China',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
};

const updateDownloadJobs = new Map();

function applySystemCertificateAuthorities() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const bundled = tls.getCACertificates('default') || [];
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return;
    const seen = new Set();
    const merged = [];
    bundled.concat(system).forEach(cert => {
      if (!cert || seen.has(cert)) return;
      seen.add(cert);
      merged.push(cert);
    });
    if (merged.length > bundled.length) tls.setDefaultCACertificates(merged);
  } catch (e) {
    console.warn('[TLS] system CA merge skipped:', e.message);
  }
}

applySystemCertificateAuthorities();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ---------- Cookie 持久化 ----------
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
function collectCookiePair(picked, key, value) {
  key = String(key || '').trim();
  if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return;
  if (value === null || value === undefined) return;
  picked.set(key, String(value).trim());
}
function collectCookieInput(input, picked) {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    input.forEach(item => collectCookieInput(item, picked));
    return;
  }
  if (typeof input === 'object') {
    if (input.name && Object.prototype.hasOwnProperty.call(input, 'value')) {
      collectCookiePair(picked, input.name, input.value);
      return;
    }
    Object.keys(input).forEach(key => {
      const value = input[key];
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
        collectCookiePair(picked, key, value.value);
      } else if (typeof value !== 'object') {
        collectCookiePair(picked, key, value);
      }
    });
    return;
  }
  String(input).split(/\r?\n/).forEach(line => {
    line.split(';').forEach(part => {
      const raw = String(part || '').trim();
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      collectCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
    });
  });
}
function normalizeCookieHeader(input) {
  const picked = new Map();
  collectCookieInput(input, picked);
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
function rawCookieFallback(input) {
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input) && input.every(item => typeof item === 'string')) return input.join('; ').trim();
  return '';
}
const PROTECTED_SECRET_PREFIX = 'mineradio-safe-storage-v1:';
function safeStorageAvailable() {
  try {
    return !!(electronSafeStorage && electronSafeStorage.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}
function quarantineUnreadableSecret(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.renameSync(filePath, `${filePath}.unreadable-${Date.now()}`);
  } catch (_) {}
}
function writeProtectedSecret(filePath, value) {
  const secret = String(value || '');
  try {
    if (!secret) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return true;
    }
    let payload = secret;
    if (safeStorageAvailable()) {
      payload = PROTECTED_SECRET_PREFIX + electronSafeStorage.encryptString(secret).toString('base64');
    } else if (process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE !== '1') {
      console.warn('[Credentials] secure storage unavailable; login remains in memory only');
      return false;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    console.warn('[Credentials] protected credential write failed:', e.message);
    return false;
  }
}
function readProtectedSecret(filePath) {
  if (!fs.existsSync(filePath)) return '';
  try {
    const payload = fs.readFileSync(filePath, 'utf8').trim();
    if (!payload) return '';
    if (payload.startsWith(PROTECTED_SECRET_PREFIX)) {
      if (!safeStorageAvailable()) return '';
      const encrypted = Buffer.from(payload.slice(PROTECTED_SECRET_PREFIX.length), 'base64');
      return electronSafeStorage.decryptString(encrypted).trim();
    }
    if (safeStorageAvailable()) {
      if (writeProtectedSecret(filePath, payload)) return payload;
      quarantineUnreadableSecret(filePath);
      return '';
    }
    if (process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE === '1' ||
        process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS === '1') return payload;
    quarantineUnreadableSecret(filePath);
    console.warn('[Credentials] unprotected stored login was isolated');
    return '';
  } catch (e) {
    quarantineUnreadableSecret(filePath);
    console.warn('[Credentials] stored login could not be decrypted and was isolated');
    return '';
  }
}
let userCookie = '';
try { userCookie = readProtectedSecret(COOKIE_FILE); }
catch (e) { userCookie = ''; }
function saveCookie(c) {
  const nextCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  if (!writeProtectedSecret(COOKIE_FILE, nextCookie)) return false;
  userCookie = nextCookie;
  return true;
}

let qqCookie = '';
try { qqCookie = readProtectedSecret(QQ_COOKIE_FILE); }
catch (e) { qqCookie = ''; }
function saveQQCookie(c) {
  const nextCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  if (!writeProtectedSecret(QQ_COOKIE_FILE, nextCookie)) return false;
  qqCookie = nextCookie;
  qqVipInfoCache.clear();
  return true;
}

// ---------- 工具 ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}
const API_POST_ONLY_ROUTES = new Set([
  ...PROVIDER_POST_ONLY_ROUTES,
  '/api/update/download',
  '/api/update/download/switch',
  '/api/update/download/cancel',
  '/api/update/patch',
  '/api/personal-fm/trash',
  '/api/qq/login/cookie',
  '/api/qq/logout',
  '/api/login/cookie',
  '/api/login/qr/check',
  '/api/logout',
  '/api/song/like',
  '/api/playlist/create',
  '/api/playlist/add-song',
  '/api/playlist/remove-song',
  '/api/playlist/rename',
  '/api/playlist/update-meta',
  '/api/playlist/update-metadata',
  '/api/playlist/subscribe',
  '/api/playlist/delete',
  '/api/playlist/reorder-tracks',
  '/api/shared-playlist/resolve',
]);
const API_MUTATING_POST_ROUTES = new Set([
  ...API_POST_ONLY_ROUTES,
  ...PROVIDER_MUTATING_POST_ROUTES,
  '/api/beatmap/cache',
]);

function parseLoopbackAuthority(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL('http://' + raw);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return null;
    return { hostname, port: parsed.port || '80' };
  } catch (e) {
    return null;
  }
}
function parseLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:') return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return null;
    return { hostname, port: parsed.port || '80' };
  } catch (e) {
    return null;
  }
}
function isSameLoopbackEndpoint(left, right) {
  return !!(left && right && left.hostname === right.hostname && left.port === right.port);
}
function isLoopbackSocketAddress(value) {
  const address = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function isTrustedApiRequest(req) {
  const host = parseLoopbackAuthority(req.headers.host);
  const localPort = String((req.socket && req.socket.localPort) || PORT);
  if (!host || host.port !== localPort || !isLoopbackSocketAddress(req.socket && req.socket.remoteAddress)) return false;

  const fetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = String(req.headers.origin || '').trim();
  if (origin && !isSameLoopbackEndpoint(parseLoopbackHttpUrl(origin), host)) return false;

  const referer = String(req.headers.referer || '').trim();
  if (!origin && referer && !isSameLoopbackEndpoint(parseLoopbackHttpUrl(referer), host)) return false;
  return true;
}
function guardApiMutation(req, res, pathname) {
  const method = String(req.method || 'GET').toUpperCase();
  if (API_POST_ONLY_ROUTES.has(pathname) && method !== 'POST') {
    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return false;
  }
  if (API_MUTATING_POST_ROUTES.has(pathname) && method === 'POST' && String(req.headers['x-mineradio-request'] || '') !== '1') {
    sendJSON(res, { ok: false, error: 'UNTRUSTED_MUTATION_REQUEST' }, 403);
    return false;
  }
  return true;
}
function readPackageInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function parseGitHubRepository(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  const github = raw.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  if (github) return { owner: github[1], repo: github[2].replace(/\.git$/i, '') };
  return null;
}
function isPackagedRuntime() {
  return process.env.MINERADIO_APP_PACKAGED === '1' || process.env.NODE_ENV === 'production';
}
function readUpdateManifestOverride() {
  if (isPackagedRuntime()) return '';
  return process.env.MINERADIO_UPDATE_MANIFEST
    || process.env.MINERADIO_UPDATE_MANIFEST_URL
    || process.env.MINERADIO_UPDATE_MANIFEST_FILE
    || '';
}
function readUpdateConfig(pkg) {
  const local = (pkg && pkg.mineradio && pkg.mineradio.update) || {};
  const allowOverrides = !isPackagedRuntime();
  const repoHint = (allowOverrides && (
    process.env.MINERADIO_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
  ))
    || local.repository
    || local.github
    || (pkg && pkg.repository && (pkg.repository.url || pkg.repository))
    || '';
  const parsed = parseGitHubRepository(repoHint) || {};
  const owner = (allowOverrides && process.env.MINERADIO_UPDATE_OWNER) || local.owner || parsed.owner || '';
  const repo = (allowOverrides && process.env.MINERADIO_UPDATE_REPO) || local.repo || parsed.repo || '';
  return {
    provider: local.provider || 'github',
    owner,
    repo,
    configured: !!(owner && repo),
    preview: local.preview !== false,
    preferMirrors: local.preferMirrors !== false,
    mirrors: readUpdateMirrors(local, allowOverrides),
    manifest: readUpdateManifestOverride(),
  };
}
function parseUpdateMirrorList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\n,;]/);
}
function readUpdateMirrors(local, allowOverrides) {
  const envMirrors = allowOverrides
    ? (process.env.MINERADIO_UPDATE_MIRRORS || process.env.MINERADIO_UPDATE_MIRROR || '')
    : '';
  const raw = envMirrors
    ? parseUpdateMirrorList(envMirrors)
    : parseUpdateMirrorList(local.mirrors || local.downloadMirrors || []);
  const seen = new Set();
  const mirrors = [];
  raw.forEach(item => {
    const url = String(item || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push(url);
  });
  return mirrors.slice(0, 6);
}
function normalizeDigest(value, algorithm) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = new RegExp('^' + algorithm + ':', 'i');
  return raw.replace(prefix, '').trim().replace(/^['"]|['"]$/g, '');
}
function assetDigestInfo(asset) {
  const digest = String(asset && asset.digest || '').trim();
  return {
    sha256: normalizeDigest((asset && asset.sha256) || (/^sha256:/i.test(digest) ? digest : ''), 'sha256').toLowerCase(),
    sha512: normalizeDigest((asset && asset.sha512) || (/^sha512:/i.test(digest) ? digest : ''), 'sha512'),
  };
}
function buildMirrorUrl(originalUrl, mirror) {
  const source = String(originalUrl || '').trim();
  const base = String(mirror || '').trim();
  if (!/^https?:\/\//i.test(source) || !/^https?:\/\//i.test(base)) return '';
  if (base.includes('{encodedUrl}')) return base.replace(/\{encodedUrl\}/g, encodeURIComponent(source));
  if (base.includes('{url}')) return base.replace(/\{url\}/g, source);
  return base.replace(/\/+$/, '/') + source;
}
function configuredMirrorIndexForUrl(value) {
  const target = String(value || '').trim().toLowerCase();
  if (!target) return -1;
  const mirrors = UPDATE_CONFIG.mirrors || [];
  for (let i = 0; i < mirrors.length; i++) {
    const raw = String(mirrors[i] || '').trim();
    const marker = raw.match(/\{(?:encodedUrl|url)\}/i);
    if (marker) {
      const markerIndex = marker.index || 0;
      const prefix = raw.slice(0, markerIndex).toLowerCase();
      const suffix = raw.slice(markerIndex + marker[0].length).toLowerCase();
      if (target.startsWith(prefix) && (!suffix || target.endsWith(suffix))) return i;
      continue;
    }
    const prefix = raw.replace(/\/+$/, '/').toLowerCase();
    if (prefix && target.startsWith(prefix)) return i;
  }
  return -1;
}
function uniqueDownloadCandidates(urls, opts) {
  opts = opts || {};
  const suppliedUrls = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(url => /^https?:\/\//i.test(url));
  const suppliedSeen = new Set();
  const uniqueSuppliedUrls = suppliedUrls.filter(url => {
    const key = url.toLowerCase();
    if (suppliedSeen.has(key)) return false;
    suppliedSeen.add(key);
    return true;
  });
  const mirrors = opts.useMirrors === false ? [] : (UPDATE_CONFIG.mirrors || []);
  const mirrored = [];
  uniqueSuppliedUrls.filter(url => configuredMirrorIndexForUrl(url) < 0).forEach(source => {
    mirrors.forEach((mirror, index) => {
      const url = buildMirrorUrl(source, mirror);
      if (url) mirrored.push({
        url,
        label: '国内加速线路 ' + (index + 1),
        mirrored: true,
      });
    });
  });
  const supplied = uniqueSuppliedUrls.map(url => {
    const mirrorIndex = configuredMirrorIndexForUrl(url);
    return {
      url,
      label: mirrorIndex >= 0 ? ('国内加速线路 ' + (mirrorIndex + 1)) : (/github\.com/i.test(url) ? 'GitHub 直连' : '下载线路'),
      mirrored: mirrorIndex >= 0,
    };
  });
  const ordered = UPDATE_CONFIG.preferMirrors === false ? supplied.concat(mirrored) : mirrored.concat(supplied);
  const seen = new Set();
  return ordered.filter(item => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function publicDownloadUrls(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => item && item.url)
    .filter(Boolean);
}
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').replace(/[+].*$/, '').replace(/-.+$/, '');
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) {
    const left = aa[i] || 0;
    const right = bb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function cleanReleaseLine(line) {
  return String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}
function extractReleaseNotes(body) {
  const notes = [];
  String(body || '').split(/\r?\n/).forEach(line => {
    if (/<!--[\s\S]*?-->/i.test(line)) return;
    const text = cleanReleaseLine(line);
    if (!text) return;
    if (/^(what'?s changed|changes|changelog|full changelog|更新日志)$/i.test(text)) return;
    if (/https?:\/\//i.test(text)) return;
    if (/^(下载|网盘|夸克盘|百度(?:云|网盘)|蓝奏(?:云|网盘)|安装包)/i.test(text)) return;
    if (text.length > 72) return;
    notes.push(text);
  });
  return notes.slice(0, 4);
}
function pickReleaseAsset(assets, latestVersion) {
  const list = Array.isArray(assets) ? assets : [];
  const expectedName = `Mineradio-${normalizeVersion(latestVersion)}-Setup.exe`;
  const preferred = list.find(a => String(a && a.name || '').toLowerCase() === expectedName.toLowerCase());
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: Number(preferred.size || 0) || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function patchAssetVersions(name) {
  const matches = String(name || '').match(/\d+(?:[._-]\d+){1,3}/g) || [];
  return matches.map(item => normalizeVersion(item.replace(/[._-]/g, '.'))).filter(Boolean);
}
function pickPatchAsset(assets, currentVersion, latestVersion) {
  const list = Array.isArray(assets) ? assets : [];
  const current = normalizeVersion(currentVersion || APP_VERSION);
  const latest = normalizeVersion(latestVersion || '');
  const preferred = list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    if (latest) return versions[0] === current && versions[versions.length - 1] === latest;
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => /\.(patch\.json|patch)$/i.test(a && a.name || ''));
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function updateAssetNameFromUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const base = path.basename(decodeURIComponent(u.pathname || ''));
    if (base) return base;
  } catch (_) {}
  return path.basename(String(value || '').split('?')[0]) || '';
}
function normalizeManifestUpdateInfo(data) {
  data = data || {};
  const release = data.release || {};
  const asset = release.asset || data.asset || {};
  const latestVersion = normalizeVersion(
    data.latestVersion
    || data.version
    || release.version
    || release.tagName
    || release.tag_name
    || release.name
    || APP_VERSION
  ) || APP_VERSION;
  const downloadUrl = release.downloadUrl || data.downloadUrl || asset.downloadUrl || asset.browser_download_url || '';
  const patch = release.patch || data.patch || null;
  const assetUrls = [downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []);
  const patchUrls = patch ? [patch.downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []) : [];
  const patchInfo = patch && patch.downloadUrl ? {
    name: patch.name || updateAssetNameFromUrl(patch.downloadUrl) || `Mineradio-${APP_VERSION}→${latestVersion}.patch.json`,
    size: Number(patch.size || 0) || 0,
    contentType: patch.contentType || patch.content_type || 'application/json',
    downloadUrl: patch.downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(patchUrls)),
    from: normalizeVersion(patch.from || APP_VERSION),
    to: normalizeVersion(patch.to || latestVersion),
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
  } : null;
  const notes = Array.isArray(release.notes) && release.notes.length
    ? release.notes.slice(0, 4).map(cleanReleaseLine).filter(Boolean)
    : (extractReleaseNotes(release.body || data.body).length ? extractReleaseNotes(release.body || data.body) : UPDATE_FALLBACK_NOTES);
  const assetInfo = downloadUrl ? {
    name: asset.name || updateAssetNameFromUrl(downloadUrl) || `Mineradio-${latestVersion}-Setup.exe`,
    size: Number(asset.size || 0) || 0,
    contentType: asset.contentType || asset.content_type || '',
    downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(assetUrls)),
    sha256: normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(asset.sha512 || release.sha512 || data.sha512 || '', 'sha512'),
  } : null;
  return {
    configured: true,
    preview: false,
    updateAvailable: data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0,
    checkStatus: (data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0) ? 'available' : 'current',
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: release.tagName || release.tag_name || data.tagName || ('v' + latestVersion),
      name: release.name || data.name || ('Mineradio v' + latestVersion),
      version: latestVersion,
      publishedAt: release.publishedAt || release.published_at || data.publishedAt || '',
      htmlUrl: release.htmlUrl || release.html_url || data.htmlUrl || '',
      downloadUrl,
      asset: assetInfo,
      patch: patchInfo,
      patchAvailable: !!(patchInfo && patchInfo.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
      summary: release.summary || data.summary || notes[0] || '发现新版本，建议更新。',
      notes,
    },
    source: 'manifest',
  };
}
async function readUpdateManifest(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('UPDATE_MANIFEST_MISSING');
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Update manifest ' + resp.status);
    return resp.json();
  }
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function fetchManifestUpdateInfo(ref) {
  try {
    const data = await readUpdateManifest(ref);
    return normalizeManifestUpdateInfo(data);
  } catch (err) {
    return localUpdateFallback(err.message || 'Update manifest failed', { configured: true });
  }
}
function beatCacheRootInfo() {
  const dir = path.resolve(BEATMAP_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && path.isAbsolute(dir) && path.resolve(dir) !== path.resolve(root);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
}
function ensureBeatMapCacheDir() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_PATH_INVALID');
    err.code = 'BEAT_CACHE_PATH_INVALID';
    err.info = info;
    throw err;
  }
  if (!info.available) {
    const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  fs.mkdirSync(info.dir, { recursive: true });
  return info.dir;
}
function safeBeatMapCacheFile(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > 240) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
  return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
}
function compactBeatMapCachePayload(body) {
  const key = String(body && body.key || '').trim();
  const map = body && body.map;
  if (!key || !map || typeof map !== 'object') return null;
  return {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || '').slice(0, 32),
      title: String(body.title || '').slice(0, 160),
      artist: String(body.artist || '').slice(0, 160),
      mode: String(body.mode || 'mr').slice(0, 32),
    },
    map,
  };
}
function readBeatMapCache(key) {
  const file = safeBeatMapCacheFile(key);
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.map ? raw : null;
}
function writeBeatMapCache(body) {
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
}
function clearBeatMapCache() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_PATH_INVALID');
    err.code = 'BEAT_CACHE_PATH_INVALID';
    err.info = info;
    throw err;
  }
  if (!fs.existsSync(info.dir)) return { ok: true, files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  fs.readdirSync(info.dir, { withFileTypes: true }).forEach((entry) => {
    if (!entry.isFile() || !/\.(?:json|tmp)$/i.test(entry.name)) return;
    const file = path.join(info.dir, entry.name);
    try {
      bytes += fs.statSync(file).size || 0;
      fs.unlinkSync(file);
      files += 1;
    } catch (_) {}
  });
  return { ok: true, files, bytes };
}
function localUpdateFallback(reason, opts) {
  opts = opts || {};
  const configured = !!(opts.configured != null ? opts.configured : false);
  return {
    configured,
    preview: false,
    updateAvailable: false,
    checkStatus: reason ? 'error' : 'current',
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    release: {
      tagName: 'v' + APP_VERSION,
      name: 'Mineradio v' + APP_VERSION,
      version: APP_VERSION,
      htmlUrl: '',
      downloadUrl: '',
      summary: reason ? '检查更新失败，请稍后重试。' : '当前版本已是最新。',
      notes: UPDATE_FALLBACK_NOTES,
    },
    reason: reason || '',
  };
}
function updateError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
function classifyUpdateError(err) {
  const code = String(err && err.code || '').trim();
  const message = String(err && err.message || err || '').trim();
  const detail = message || code || '未知错误';
  if (code === 'UPDATE_DOWNLOAD_CANCELLED') {
    return { code, reason: '下载已取消。', detail };
  }
  if (code === 'UPDATE_SOURCE_SWITCH_REQUESTED') {
    return { code, reason: '已手动跳过当前下载线路。', detail };
  }
  if (code === 'UPDATE_LOW_SPEED') {
    return { code, reason: '当前线路持续低速，已自动切换下载线路。', detail };
  }
  if (/HASH|DIGEST|CHECKSUM/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_HASH_MISMATCH', reason: '文件校验失败，可能是线路缓存异常，已拦截该安装包。', detail };
  }
  if (/SIZE_MISMATCH|content length/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_SIZE_MISMATCH', reason: '下载文件大小不一致，可能是网络中断或线路缓存不完整。', detail };
  }
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_TIMEOUT', reason: '连接超时，当前网络到更新线路不稳定。', detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|fetch failed|getaddrinfo/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_DNS_FAILED', reason: '域名解析失败，可能是当前网络无法连接该更新线路。', detail };
  }
  if (/ECONNRESET|ECONNREFUSED|socket|network/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_NETWORK_FAILED', reason: '网络连接被中断，已尝试切换更新线路。', detail };
  }
  const http = message.match(/\bHTTP[_\s-]?(\d{3})\b/i) || message.match(/\b(\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { code: code || 'UPDATE_HTTP_403', reason: '更新线路返回 403，可能被限流或拦截。', detail };
    if (status === 404) return { code: code || 'UPDATE_HTTP_404', reason: '更新文件不存在，可能 release 资源还没有同步完成。', detail };
    if (status >= 500) return { code: code || 'UPDATE_HTTP_5XX', reason: '更新线路服务器异常，请稍后重试。', detail };
    return { code: code || ('UPDATE_HTTP_' + status), reason: '更新线路返回 HTTP ' + status + '。', detail };
  }
  return { code: code || 'UPDATE_FAILED', reason: '更新失败：' + detail, detail };
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
async function readUpdateChunk(reader) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(updateError('UPDATE_READ_TIMEOUT', 'Update download stalled')), UPDATE_READ_IDLE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    try { await reader.cancel(err && err.message || 'download stalled'); } catch (_) {}
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fetchTextFromCandidates(candidates, timeoutMs) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 6500);
    try {
      const resp = await fetch(candidate.url, {
        signal: controller.signal,
        headers: Object.assign({ 'User-Agent': `Mineradio/${APP_VERSION}` }, candidate.headers || {}),
      });
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      const declaredSize = Number(resp.headers.get('content-length') || 0) || 0;
      if (declaredSize > UPDATE_METADATA_MAX_BYTES) throw updateError('UPDATE_METADATA_TOO_LARGE', 'Update metadata exceeds the size limit');
      if (!resp.body || typeof resp.body.getReader !== 'function') throw updateError('UPDATE_METADATA_BODY_MISSING', 'Update metadata response has no body');
      const chunks = [];
      let received = 0;
      const reader = resp.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buffer = Buffer.from(chunk.value);
        received += buffer.length;
        if (received > UPDATE_METADATA_MAX_BYTES) {
          try { await reader.cancel('metadata too large'); } catch (_) {}
          throw updateError('UPDATE_METADATA_TOO_LARGE', 'Update metadata exceeds the size limit');
        }
        chunks.push(buffer);
      }
      return { text: Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''), candidate };
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push(candidate.label + ': ' + info.reason);
    } finally {
      clearTimeout(timer);
    }
  }
  throw updateError('UPDATE_ALL_LINES_FAILED', failures.join('；') || 'All update lines failed');
}
function yamlScalar(text, key) {
  const pattern = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}
function githubReleaseDownloadUrl(version, fileName) {
  const tag = 'v' + normalizeVersion(version);
  const encodedOwner = encodeURIComponent(UPDATE_CONFIG.owner);
  const encodedRepo = encodeURIComponent(UPDATE_CONFIG.repo);
  const encodedName = String(fileName || '').split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://github.com/${encodedOwner}/${encodedRepo}/releases/download/${tag}/${encodedName}`;
}
function githubReleaseAssetApiUrl(release, fileName) {
  const expectedName = String(fileName || '').trim().toLowerCase();
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const asset = assets.find(item => String(item && item.name || '').trim().toLowerCase() === expectedName);
  const assetId = String(asset && asset.id || '').trim();
  if (!asset || !/^\d+$/.test(assetId) || !asset.url) return '';
  try {
    const parsed = new URL(String(asset.url));
    const expectedPath = `/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/assets/${assetId}`.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'api.github.com' || parsed.pathname.toLowerCase() !== expectedPath) return '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}
function parseLatestYmlUpdateInfo(text, reason) {
  const latestVersion = normalizeVersion(yamlScalar(text, 'version') || APP_VERSION) || APP_VERSION;
  const expectedName = `Mineradio-${latestVersion}-Setup.exe`;
  const assetPath = yamlScalar(text, 'path') || yamlScalar(text, 'url') || expectedName;
  const sha512 = normalizeDigest(yamlScalar(text, 'sha512'), 'sha512');
  const size = Number(yamlScalar(text, 'size') || 0) || 0;
  const releaseDate = yamlScalar(text, 'releaseDate');
  if (path.basename(assetPath).toLowerCase() !== expectedName.toLowerCase() || assetPath !== path.basename(assetPath)) {
    throw updateError('UPDATE_ASSET_NAME_INVALID', `Expected ${expectedName}`);
  }
  if (!(/^[a-f0-9]{128}$/i.test(sha512) || /^[A-Za-z0-9+/]{86}==$/.test(sha512))) {
    throw updateError('UPDATE_DIGEST_MISSING', 'latest.yml does not contain a valid sha512 digest');
  }
  if (!(size > 0) || size > UPDATE_MAX_BYTES) {
    throw updateError('UPDATE_SIZE_INVALID', 'latest.yml contains an invalid installer size');
  }
  const downloadUrl = githubReleaseDownloadUrl(latestVersion, assetPath);
  const candidates = uniqueDownloadCandidates(downloadUrl);
  const asset = {
    name: updateAssetNameFromUrl(downloadUrl) || assetPath,
    size,
    contentType: 'application/octet-stream',
    downloadUrl,
    downloadUrls: publicDownloadUrls(candidates),
    sha256: '',
    sha512,
  };
  return {
    configured: true,
    preview: false,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    checkStatus: compareVersions(latestVersion, APP_VERSION) > 0 ? 'available' : 'current',
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: 'v' + latestVersion,
      name: 'Mineradio v' + latestVersion,
      version: latestVersion,
      publishedAt: releaseDate,
      htmlUrl: `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/tag/v${latestVersion}`,
      downloadUrl,
      asset,
      patch: null,
      patchAvailable: false,
      summary: '发现新版本，建议更新。',
      notes: ['更新元数据已通过 GitHub 获取', '安装包下载完成后会验证完整性', '下载失败会显示具体原因和当前速度'],
    },
    source: 'latest-yml',
    reason: reason || '',
  };
}
async function fetchLatestYmlUpdateInfo(reason, release) {
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') throw updateError('UPDATE_REPOSITORY_NOT_CONFIGURED');
  const latestYmlUrl = `https://github.com/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest/download/latest.yml`;
  const candidates = [];
  const assetApiUrl = githubReleaseAssetApiUrl(release, 'latest.yml');
  if (assetApiUrl) {
    candidates.push({
      url: assetApiUrl,
      label: 'GitHub Releases API',
      mirrored: false,
      headers: {
        'Accept': 'application/octet-stream',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }
  candidates.push({ url: latestYmlUrl, label: 'GitHub 直连', mirrored: false });
  const result = await fetchTextFromCandidates(candidates, 6500);
  return parseLatestYmlUpdateInfo(result.text, reason);
}
async function fetchLatestUpdateInfo() {
  if (RUNTIME_PLATFORM !== 'win32') {
    return {
      ...localUpdateFallback('', { configured: UPDATE_CONFIG.configured }),
      platform: RUNTIME_PLATFORM,
      platformSupported: false,
      checkStatus: 'unsupported',
      reason: 'UPDATE_PLATFORM_UNSUPPORTED',
      release: {
        ...localUpdateFallback().release,
        summary: '当前平台暂不支持应用内安装更新。',
      },
    };
  }
  if (UPDATE_CONFIG.manifest) return fetchManifestUpdateInfo(UPDATE_CONFIG.manifest);
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') return localUpdateFallback();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  let releaseData = null;
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!resp.ok) return await fetchLatestYmlUpdateInfo('GitHub Releases ' + resp.status);
    const data = await resp.json();
    releaseData = data;
    const latestVersion = normalizeVersion(data.tag_name || data.name || APP_VERSION) || APP_VERSION;
    const releaseAsset = pickReleaseAsset(data.assets, latestVersion);
    const metadata = await fetchLatestYmlUpdateInfo('GitHub release metadata', data);
    if (normalizeVersion(metadata.latestVersion) !== latestVersion) {
      throw updateError('UPDATE_VERSION_MISMATCH', 'GitHub release and latest.yml versions do not match');
    }
    if (compareVersions(latestVersion, APP_VERSION) > 0 && !releaseAsset) {
      throw updateError('UPDATE_ASSET_MISSING', `Expected Mineradio-${latestVersion}-Setup.exe`);
    }
    const asset = metadata.release.asset;
    if (releaseAsset) {
      asset.contentType = releaseAsset.contentType;
      asset.downloadUrl = releaseAsset.downloadUrl;
      asset.downloadUrls = publicDownloadUrls(uniqueDownloadCandidates(releaseAsset.downloadUrl));
    }
    const notes = extractReleaseNotes(data.body).length ? extractReleaseNotes(data.body) : UPDATE_FALLBACK_NOTES;
    return {
      configured: true,
      preview: false,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      checkStatus: compareVersions(latestVersion, APP_VERSION) > 0 ? 'available' : 'current',
      currentVersion: APP_VERSION,
      latestVersion,
      release: {
        tagName: data.tag_name || ('v' + latestVersion),
        name: data.name || ('Mineradio v' + latestVersion),
        version: latestVersion,
        publishedAt: data.published_at || '',
        htmlUrl: data.html_url || '',
        downloadUrl: asset ? asset.downloadUrl : '',
        asset,
        patch: null,
        patchAvailable: false,
        summary: notes[0] || '发现新版本，建议更新。',
        notes,
      },
    };
  } catch (err) {
    const reason = err && err.message || 'Update check failed';
    try { return await fetchLatestYmlUpdateInfo(reason, releaseData); }
    catch (fallbackErr) { return localUpdateFallback((fallbackErr && fallbackErr.message) || reason, { configured: true }); }
  } finally {
    clearTimeout(timer);
  }
}
function safeUpdateFileName(name, version) {
  const raw = String(name || '').trim() || `Mineradio-${version || APP_VERSION}.exe`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || `Mineradio-${version || APP_VERSION}.exe`;
}
function publicUpdateJob(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  const ready = job.status === 'ready';
  return {
    ok: job.status !== 'error',
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    received: job.received || 0,
    total: job.total || 0,
    speedBps: job.speedBps || 0,
    etaSeconds: job.etaSeconds || 0,
    sourceLabel: job.sourceLabel || '',
    attempt: job.attempt || 0,
    attempts: job.attempts || 0,
    routing: job.routing || '',
    probing: job.routing === 'probing',
    canSwitch: canSwitchUpdateSource(job),
    canCancel: canCancelUpdateDownload(job),
    cancelled: job.status === 'cancelled',
    mode: job.mode || 'installer',
    message: job.message || '',
    restartRequired: !!job.restartRequired,
    cached: !!job.cached,
    fileName: job.fileName || '',
    filePath: ready ? job.filePath : '',
    expectedSize: ready ? (job.expectedSize || job.total || 0) : 0,
    sha256: ready ? (job.sha256 || '') : '',
    sha512: ready ? (job.sha512 || '') : '',
    version: job.version || '',
    releaseUrl: job.releaseUrl || '',
    error: job.error || '',
    errorReason: job.errorReason || '',
    errorDetail: job.errorDetail || '',
    failedAttempts: Array.isArray(job.failedAttempts) ? job.failedAttempts.slice(0, 6) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function activeUpdateJobFor(version) {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.find(job => job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
}
function trimUpdateJobs() {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  jobs.slice(8).forEach(job => updateDownloadJobs.delete(job.id));
}
function canCancelUpdateDownload(job) {
  return !!(job && (job.status === 'queued' || job.status === 'downloading') && job.routing !== 'verifying');
}
function isUpdateDownloadCancelled(job) {
  return !!(job && (job.cancelRequested || job.status === 'cancelled'));
}
function throwIfUpdateDownloadCancelled(job) {
  if (isUpdateDownloadCancelled(job)) {
    throw updateError('UPDATE_DOWNLOAD_CANCELLED', 'Update download cancelled');
  }
}
function cleanupUpdateDownloadPartial(job) {
  if (!job || !job.filePath) return;
  const tmpPath = job.filePath + '.download';
  try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
}
function requestUpdateDownloadCancel(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  if (job.status === 'cancelled') return publicUpdateJob(job);
  if (!canCancelUpdateDownload(job)) {
    return { ok: false, error: 'UPDATE_JOB_NOT_CANCELLABLE', job: publicUpdateJob(job) };
  }
  const controller = job.activeAbortController;
  job.cancelRequested = true;
  job.switchRequested = false;
  job.status = 'cancelled';
  job.routing = 'cancelled';
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.error = '';
  job.errorReason = '';
  job.errorDetail = '';
  job.message = '下载已取消';
  job.updatedAt = Date.now();
  if (controller) controller.abort(updateError('UPDATE_DOWNLOAD_CANCELLED', 'Update download cancelled'));
  cleanupUpdateDownloadPartial(job);
  return publicUpdateJob(job);
}
async function downloadUpdateAsset(job) {
  const tmpPath = job.filePath + '.download';
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
      },
    });
    if (!resp.ok) throw new Error('Download failed ' + resp.status);

    const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.total = totalHeader || job.total || 0;
    job.received = 0;
    job.progress = 0;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';
    job.updatedAt = Date.now();
    let speedWindowAt = Date.now();
    let speedWindowBytes = 0;

    const writer = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        job.received += buf.length;
        speedWindowBytes += buf.length;
        const now = Date.now();
        if (now - speedWindowAt >= 900) {
          job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
          speedWindowAt = now;
          speedWindowBytes = 0;
        }
        if (job.total > 0) {
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
          job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
        } else {
          const kb = Math.max(1, job.received / 1024);
          job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
        }
        job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
        job.updatedAt = Date.now();
        if (!writer.write(buf)) await once(writer, 'drain');
      }
    } finally {
      writer.end();
      await once(writer, 'finish').catch(() => {});
    }

    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    fs.renameSync(tmpPath, job.filePath);
    job.status = 'ready';
    job.progress = 100;
    job.message = '安装包已下载';
    job.updatedAt = Date.now();
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    job.status = 'error';
    job.error = e.message || 'UPDATE_DOWNLOAD_FAILED';
    job.updatedAt = Date.now();
  }
}
function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}
function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex');
}
function verifyUpdateBuffer(buffer, job) {
  const expectedSize = Number(job.expectedSize || job.total || 0) || 0;
  if (expectedSize > 0 && buffer.length !== expectedSize) {
    throw updateError('UPDATE_SIZE_MISMATCH', `Expected ${expectedSize} bytes, got ${buffer.length}`);
  }
  const expectedSha256 = normalizeDigest(job.sha256 || '', 'sha256').toLowerCase();
  const expectedSha512 = normalizeDigest(job.sha512 || '', 'sha512');
  if (!expectedSha256 && !expectedSha512) {
    throw updateError('UPDATE_DIGEST_MISSING', 'Installer digest is required');
  }
  if (expectedSha256 && sha256Hex(buffer) !== expectedSha256) {
    throw updateError('UPDATE_SHA256_MISMATCH', 'Downloaded sha256 mismatch');
  }
  if (expectedSha512) {
    const actualBase64 = sha512Base64(buffer);
    const actualHex = sha512Hex(buffer).toLowerCase();
    if (actualBase64 !== expectedSha512 && actualHex !== expectedSha512.toLowerCase()) {
      throw updateError('UPDATE_SHA512_MISMATCH', 'Downloaded sha512 mismatch');
    }
  }
}
function verifyUpdateFile(filePath, job) {
  verifyUpdateBuffer(fs.readFileSync(filePath), job);
}
function moveInvalidUpdateFile(filePath, reason) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const invalidPath = path.join(dir, `${base}.invalid-${Date.now()}${ext || '.bin'}`);
    fs.renameSync(filePath, invalidPath);
    console.warn('[UpdateDownload] cached installer moved aside:', reason || 'invalid', invalidPath);
  } catch (e) {
    console.warn('[UpdateDownload] failed to move invalid cached installer:', e.message);
  }
}
function reuseVerifiedInstallerJob(opts) {
  if (!opts || !opts.filePath || !fs.existsSync(opts.filePath)) return null;
  if (!opts.expectedSize && !opts.sha256 && !opts.sha512) return null;
  const now = Date.now();
  const stat = fs.statSync(opts.filePath);
  const job = {
    id: 'cached-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'ready',
    progress: 100,
    received: stat.size || 0,
    total: opts.expectedSize || stat.size || 0,
    speedBps: 0,
    etaSeconds: 0,
    sourceLabel: '本地缓存',
    routing: 'ready',
    attempt: 0,
    attempts: opts.attempts || 0,
    mode: 'installer',
    message: '安装包已下载，可直接打开安装',
    fileName: opts.fileName || path.basename(opts.filePath),
    filePath: opts.filePath,
    version: opts.version || '',
    downloadUrl: opts.downloadUrl || '',
    downloadCandidates: opts.downloadCandidates || [],
    expectedSize: opts.expectedSize || 0,
    sha256: opts.sha256 || '',
    sha512: opts.sha512 || '',
    releaseUrl: opts.releaseUrl || '',
    failedAttempts: [],
    cached: true,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  try {
    verifyUpdateFile(opts.filePath, job);
    updateDownloadJobs.set(job.id, job);
    trimUpdateJobs();
    return job;
  } catch (err) {
    moveInvalidUpdateFile(opts.filePath, (err && err.message) || 'cache verification failed');
    return null;
  }
}
function setUpdateJobError(job, err, fallbackMessage) {
  const info = classifyUpdateError(err);
  job.status = 'error';
  job.routing = 'error';
  job.activeAbortController = null;
  job.switchRequested = false;
  job.error = info.code;
  job.errorReason = info.reason;
  job.errorDetail = info.detail;
  job.message = fallbackMessage || info.reason;
  job.updatedAt = Date.now();
}
function prepareUpdateJobAttempt(job, candidate, index, total) {
  job.status = 'downloading';
  job.routing = 'downloading';
  job.sourceLabel = candidate.label || '下载线路';
  job.attempt = index + 1;
  job.attempts = total;
  job.currentCandidateIndex = index;
  job.switchRequested = false;
  job.received = 0;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.error = '';
  job.errorReason = '';
  job.errorDetail = '';
  job.updatedAt = Date.now();
}
function ensureMirrorCanBeVerified(job, candidate) {
  if (job.sha256 || job.sha512) return;
  throw updateError('UPDATE_DIGEST_MISSING', 'Installer download requires a trusted digest');
}
function canSwitchUpdateSource(job) {
  return !!(job
    && job.mode === 'installer'
    && job.status === 'downloading'
    && job.routing === 'downloading'
    && job.activeAbortController
    && !job.switchRequested
    && job.attempt > 0
    && job.attempt < job.attempts);
}
function requestUpdateSourceSwitch(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  if (job.switchRequested && job.routing === 'switching') {
    return Object.assign(publicUpdateJob(job), { switching: true });
  }
  if (!canSwitchUpdateSource(job)) {
    return { ok: false, error: 'UPDATE_SOURCE_NOT_SWITCHABLE', job: publicUpdateJob(job) };
  }
  const controller = job.activeAbortController;
  job.switchRequested = true;
  job.routing = 'switching';
  job.message = '正在切换下载线路';
  job.updatedAt = Date.now();
  controller.abort(updateError('UPDATE_SOURCE_SWITCH_REQUESTED', 'Manual source switch requested'));
  return Object.assign(publicUpdateJob(job), { switching: true });
}
async function probeUpdateDownloadCandidate(candidate, expectedSize, cancelSignal) {
  const targetBytes = Math.min(
    UPDATE_PROBE_RANGE_BYTES,
    Math.max(1, Number(expectedSize || UPDATE_PROBE_RANGE_BYTES) || UPDATE_PROBE_RANGE_BYTES)
  );
  const controller = new AbortController();
  const cancelProbe = () => controller.abort(
    cancelSignal && cancelSignal.reason || updateError('UPDATE_DOWNLOAD_CANCELLED', 'Update download cancelled')
  );
  if (cancelSignal) {
    if (cancelSignal.aborted) cancelProbe();
    else cancelSignal.addEventListener('abort', cancelProbe, { once: true });
  }
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), UPDATE_PROBE_TIMEOUT_MS);
  let reader = null;
  let received = 0;
  try {
    const resp = await fetch(candidate.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
        'Range': `bytes=0-${targetBytes - 1}`,
        'Accept-Encoding': 'identity',
      },
    });
    if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      throw updateError('UPDATE_PROBE_BODY_MISSING', 'Update probe response has no body');
    }
    reader = resp.body.getReader();
    while (received < targetBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const size = Number(chunk.value && chunk.value.byteLength || 0) || 0;
      received += Math.min(size, targetBytes - received);
    }
    if (received < targetBytes) {
      throw updateError('UPDATE_PROBE_TRUNCATED', `Update probe returned ${received} of ${targetBytes} bytes`);
    }
    const durationMs = Math.max(1, Date.now() - startedAt);
    return {
      ok: true,
      bytes: received,
      durationMs,
      speedBps: Math.round(received / (durationMs / 1000)),
    };
  } catch (err) {
    return {
      ok: false,
      bytes: received,
      durationMs: Math.max(1, Date.now() - startedAt),
      error: String(err && (err.code || err.message) || 'UPDATE_PROBE_FAILED'),
    };
  } finally {
    clearTimeout(timer);
    if (cancelSignal) cancelSignal.removeEventListener('abort', cancelProbe);
    if (reader) {
      try { await reader.cancel('probe complete'); } catch (_) {}
    }
  }
}
function orderUpdateCandidatesByProbe(candidates, results) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  const validResults = (Array.isArray(results) ? results : [])
    .filter(result => result && Number.isInteger(result.index) && result.index >= 0 && result.index < list.length);
  const resultByIndex = new Map(validResults.map(result => [result.index, result]));
  const decorate = index => {
    const result = resultByIndex.get(index);
    return Object.assign({}, list[index], {
      probeOk: !!(result && result.ok),
      probeSpeedBps: result && result.ok ? (result.speedBps || 0) : 0,
    });
  };
  const measured = validResults
    .filter(result => result && result.ok && Number.isInteger(result.index) && result.index >= 0 && result.index < list.length)
    .slice()
    .sort((a, b) => (b.speedBps || 0) - (a.speedBps || 0) || a.index - b.index);
  const selected = new Set(measured.map(result => result.index));
  return measured.map(result => decorate(result.index))
    .concat(list.map((_, index) => index).filter(index => !selected.has(index)).map(decorate));
}
function hasFasterProbedUpdateCandidate(candidates, currentIndex, currentSpeedBps) {
  const requiredSpeed = Math.max(1, Number(currentSpeedBps || 0)) * UPDATE_LOW_SPEED_REQUIRED_GAIN;
  return candidates.slice(currentIndex + 1).some(candidate => (
    candidate && candidate.probeOk && Number(candidate.probeSpeedBps || 0) >= requiredSpeed
  ));
}
async function rankUpdateDownloadCandidates(job, candidates) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  throwIfUpdateDownloadCancelled(job);
  if (list.length <= 1) return list;
  const maxCandidates = Math.max(1, Math.floor(UPDATE_PROBE_TOTAL_MAX_BYTES / UPDATE_PROBE_RANGE_BYTES));
  const probeTargets = list.slice(0, maxCandidates);
  job.status = 'downloading';
  job.routing = 'probing';
  job.sourceLabel = '自动测速';
  job.attempt = 0;
  job.attempts = list.length;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.message = '正在测速选择最快下载线路';
  job.updatedAt = Date.now();
  const controller = new AbortController();
  job.activeAbortController = controller;
  let results;
  try {
    results = await Promise.all(probeTargets.map(async (candidate, index) => Object.assign(
      { index, label: candidate.label || '下载线路' },
      await probeUpdateDownloadCandidate(candidate, job.expectedSize, controller.signal)
    )));
  } finally {
    if (job.activeAbortController === controller) job.activeAbortController = null;
  }
  throwIfUpdateDownloadCancelled(job);
  job.probeResults = results.map(result => ({
    label: result.label,
    ok: result.ok,
    speedBps: result.speedBps || 0,
    durationMs: result.durationMs || 0,
    error: result.error || '',
  }));
  return orderUpdateCandidatesByProbe(list, results);
}

// ====================================================================
//  差量更新 (blockmap differential)
//  - 复用本地缓存的旧安装包, 只用 HTTP Range 下载新旧版本之间变化的块
//  - 复制块逐块校验, 拼装结果仍走 verifyUpdateFile 的整体摘要终检
//  - 任何一步失败自动回退整包下载; MINERADIO_UPDATE_DIFFERENTIAL=0 可整体停用
// ====================================================================
function updateInstallerVersionFromName(name) {
  const match = /^Mineradio-(\d+(?:\.\d+){1,3})-Setup\.exe$/i.exec(String(name || ''));
  return match ? match[1] : '';
}

function findDifferentialBaseInstaller(targetVersion) {
  try {
    if (!fs.existsSync(UPDATE_DOWNLOAD_DIR)) return null;
    const target = normalizeVersion(targetVersion);
    const bases = [];
    for (const name of fs.readdirSync(UPDATE_DOWNLOAD_DIR)) {
      const version = updateInstallerVersionFromName(name);
      if (!version || normalizeVersion(version) === target) continue;
      const filePath = path.join(UPDATE_DOWNLOAD_DIR, name);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch (_) { continue; }
      if (!stat.isFile() || !(stat.size > 0)) continue;
      bases.push({ name, filePath, version, size: stat.size });
    }
    if (!bases.length) return null;
    bases.sort((a, b) => compareVersions(b.version, a.version));
    const current = bases.find(base => normalizeVersion(base.version) === normalizeVersion(APP_VERSION));
    return current || bases[0];
  } catch (_) {
    return null;
  }
}

function updateBlockMapCandidates(job, version, fileName) {
  const sources = [];
  const direct = String(job && job.downloadUrl || '');
  if (UPDATE_CONFIG.manifest) {
    if (/^https?:\/\//i.test(direct)) sources.push(direct + '.blockmap');
  } else {
    sources.push(githubReleaseDownloadUrl(version, fileName + '.blockmap'));
    if (/^https?:\/\//i.test(direct) && !/api\.github\.com/i.test(direct)) sources.push(direct + '.blockmap');
  }
  return uniqueDownloadCandidates(sources);
}

async function fetchUpdateBlockMapBuffer(candidates) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, 8000);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      let bodyTimer = null;
      const buf = Buffer.from(await Promise.race([
        resp.arrayBuffer(),
        new Promise((_, reject) => {
          bodyTimer = setTimeout(() => reject(updateError('UPDATE_BLOCKMAP_TIMEOUT', 'blockmap body timed out')), 10000);
        }),
      ]).finally(() => { if (bodyTimer) clearTimeout(bodyTimer); }));
      if (!buf.length || buf.length > UPDATE_BLOCKMAP_MAX_BYTES) {
        throw updateError('UPDATE_BLOCKMAP_SIZE_INVALID', 'blockmap size invalid');
      }
      return buf;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || updateError('UPDATE_BLOCKMAP_UNAVAILABLE', 'blockmap unavailable');
}

function readLocalBlockMapSidecar(filePath) {
  try {
    const sidecar = filePath + '.blockmap';
    if (fs.existsSync(sidecar)) return fs.readFileSync(sidecar);
  } catch (_) {}
  return null;
}

function saveBlockMapSidecar(filePath, buffer) {
  try { fs.writeFileSync(filePath + '.blockmap', buffer); } catch (_) {}
}

function pruneCachedUpdateInstallers(keepFileName) {
  try {
    if (!fs.existsSync(UPDATE_DOWNLOAD_DIR)) return;
    const keep = String(keepFileName || '').toLowerCase();
    for (const name of fs.readdirSync(UPDATE_DOWNLOAD_DIR)) {
      if (!/^Mineradio-\d+(?:\.\d+){1,3}-Setup\.exe(\.blockmap)?$/i.test(name)) continue;
      const lower = name.toLowerCase();
      if (lower === keep || lower === keep + '.blockmap') continue;
      try { fs.unlinkSync(path.join(UPDATE_DOWNLOAD_DIR, name)); } catch (_) {}
    }
  } catch (_) {}
}

async function persistUpdateBlockMapSidecarAsync(job) {
  try {
    if (!readLocalBlockMapSidecar(job.filePath)) {
      const buf = await fetchUpdateBlockMapBuffer(updateBlockMapCandidates(job, job.version, job.fileName));
      saveBlockMapSidecar(job.filePath, buf);
    }
  } catch (err) {
    console.warn('[UpdateDiff] blockmap sidecar fetch skipped:', err && err.message || err);
  }
  try { pruneCachedUpdateInstallers(job.fileName); } catch (_) {}
}

async function streamUpdateRangeToWriter(job, candidates, preferred, op, writer, plan) {
  const ordered = preferred ? [preferred].concat(candidates.filter(candidate => candidate !== preferred)) : candidates.slice();
  let written = 0;
  let lastError = null;
  for (const candidate of ordered) {
    throwIfUpdateDownloadCancelled(job);
    const controller = new AbortController();
    job.activeAbortController = controller;
    const connectTimer = setTimeout(() => {
      controller.abort(updateError('UPDATE_CONNECT_TIMEOUT', 'Range request timed out'));
    }, UPDATE_CONNECT_TIMEOUT_MS);
    try {
      const start = op.offset + written;
      const end = op.offset + op.size - 1;
      const resp = await fetch(candidate.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': `Mineradio/${APP_VERSION}`,
          Range: `bytes=${start}-${end}`,
        },
      });
      clearTimeout(connectTimer);
      if (resp.status !== 206) throw updateError('UPDATE_RANGE_UNSUPPORTED', 'HTTP ' + resp.status + ' (need 206 partial content)');
      const contentRange = String(resp.headers.get('content-range') || '').toLowerCase();
      if (!contentRange.startsWith('bytes ' + start + '-')) {
        throw updateError('UPDATE_RANGE_MISMATCH', 'content-range ' + contentRange);
      }
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        throw updateError('UPDATE_BODY_MISSING', 'Range response has no body');
      }
      const reader = resp.body.getReader();
      try {
        while (written < op.size) {
          throwIfUpdateDownloadCancelled(job);
          if (job.switchRequested) throw updateError('UPDATE_SOURCE_SWITCH_REQUESTED', 'Manual source switch requested');
          const chunk = await readUpdateChunk(reader);
          if (chunk.done) break;
          let buf = Buffer.from(chunk.value);
          if (written + buf.length > op.size) buf = buf.subarray(0, op.size - written);
          if (!buf.length) continue;
          written += buf.length;
          job.received += buf.length;
          if (job.received > plan.fetchBytes + 4 * 1024 * 1024) {
            throw updateError('UPDATE_DIFF_OVERFLOW', 'Range data exceeded the differential plan');
          }
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / Math.max(1, plan.fetchBytes)) * 100)));
          job.updatedAt = Date.now();
          if (!writer.write(buf)) await once(writer, 'drain');
        }
      } finally {
        try { await reader.cancel('range segment finished'); } catch (_) {}
      }
      if (written !== op.size) throw updateError('UPDATE_RANGE_TRUNCATED', `expected ${op.size} bytes, got ${written}`);
      return candidate;
    } catch (err) {
      clearTimeout(connectTimer);
      if (isUpdateDownloadCancelled(job)) throw err;
      if (err && err.code === 'UPDATE_SOURCE_SWITCH_REQUESTED') throw err;
      lastError = err;
    } finally {
      if (job.activeAbortController === controller) job.activeAbortController = null;
    }
  }
  throw lastError || updateError('UPDATE_RANGE_FAILED', 'No download source served the byte range');
}

async function attemptDifferentialUpdateDownload(job) {
  if (process.env.MINERADIO_UPDATE_DIFFERENTIAL === '0') return false;
  const base = findDifferentialBaseInstaller(job.version);
  if (!base) return false;

  const resetForFullDownload = () => {
    job.mode = 'installer';
    job.routing = 'queued';
    job.sourceLabel = '';
    job.total = job.expectedSize || 0;
    job.received = 0;
    job.progress = 0;
    job.updatedAt = Date.now();
  };

  job.status = 'downloading';
  job.routing = 'differential';
  job.sourceLabel = '差量更新';
  job.message = '正在比对新旧安装包块清单';
  job.updatedAt = Date.now();

  const newMapBuffer = await fetchUpdateBlockMapBuffer(updateBlockMapCandidates(job, job.version, job.fileName));
  throwIfUpdateDownloadCancelled(job);
  let oldMapBuffer = readLocalBlockMapSidecar(base.filePath);
  if (!oldMapBuffer) {
    oldMapBuffer = await fetchUpdateBlockMapBuffer(updateBlockMapCandidates(job, base.version, base.name));
    saveBlockMapSidecar(base.filePath, oldMapBuffer);
  }
  throwIfUpdateDownloadCancelled(job);

  const oldMap = parseBlockMapBuffer(oldMapBuffer);
  const newMap = parseBlockMapBuffer(newMapBuffer);
  if (job.expectedSize > 0 && newMap.totalSize !== job.expectedSize) {
    throw updateError('UPDATE_BLOCKMAP_SIZE_MISMATCH', `blockmap total ${newMap.totalSize} != asset size ${job.expectedSize}`);
  }
  if (base.size !== oldMap.totalSize) {
    throw updateError('UPDATE_DIFF_BASE_MISMATCH', 'Cached installer size does not match its blockmap');
  }
  const plan = planDifferentialAssembly(oldMap, newMap, {
    gapBytes: UPDATE_DIFF_GAP_BYTES,
    maxFetchRatio: UPDATE_DIFF_MAX_FETCH_RATIO,
  });
  if (!plan) {
    console.log('[UpdateDiff] differential not worthwhile, using full download');
    resetForFullDownload();
    return false;
  }
  console.log('[UpdateDiff]', base.name, '->', job.fileName, describeDifferentialPlan(plan));

  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');

  job.mode = 'differential';
  job.total = plan.fetchBytes;
  job.received = 0;
  job.progress = 1;
  job.etaSeconds = 0;
  job.message = '正在差量更新（只下载变化部分）';
  job.updatedAt = Date.now();

  const tmpPath = job.filePath + '.download';
  try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  const oldFile = await fs.promises.open(base.filePath, 'r');
  const writer = fs.createWriteStream(tmpPath);
  let rangeSource = null;
  try {
    for (const op of plan.ops) {
      throwIfUpdateDownloadCancelled(job);
      if (job.switchRequested) throw updateError('UPDATE_SOURCE_SWITCH_REQUESTED', 'Manual source switch requested');
      if (op.type === 'copy') {
        const buf = Buffer.allocUnsafe(op.size);
        let done = 0;
        while (done < op.size) {
          const { bytesRead } = await oldFile.read(buf, done, op.size - done, op.oldOffset + done);
          if (bytesRead <= 0) throw updateError('UPDATE_DIFF_BASE_READ_FAILED', 'Cached installer is truncated');
          done += bytesRead;
        }
        if (!verifyCopiedBlock(buf, op.checksum)) {
          throw updateError('UPDATE_DIFF_BASE_CORRUPT', 'Cached installer block checksum mismatch');
        }
        if (!writer.write(buf)) await once(writer, 'drain');
      } else {
        rangeSource = await streamUpdateRangeToWriter(job, candidates, rangeSource, op, writer, plan);
        job.sourceLabel = '差量更新 · ' + (rangeSource.label || '下载线路');
      }
    }
  } finally {
    try { await oldFile.close(); } catch (_) {}
    writer.end();
    await once(writer, 'finish').catch(() => {});
  }
  throwIfUpdateDownloadCancelled(job);
  job.routing = 'verifying';
  job.message = '正在校验安装包';
  job.updatedAt = Date.now();
  verifyUpdateFile(tmpPath, job);
  throwIfUpdateDownloadCancelled(job);
  if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
  fs.renameSync(tmpPath, job.filePath);
  saveBlockMapSidecar(job.filePath, newMapBuffer);
  pruneCachedUpdateInstallers(job.fileName);
  const fetchedMb = Math.max(1, Math.round(plan.fetchBytes / (1024 * 1024)));
  const totalMb = Math.max(1, Math.round(plan.totalBytes / (1024 * 1024)));
  job.status = 'ready';
  job.routing = 'ready';
  job.progress = 100;
  job.etaSeconds = 0;
  job.message = `差量更新完成：只下载了 ${fetchedMb} MB（完整包 ${totalMb} MB）`;
  job.updatedAt = Date.now();
  return true;
}

async function downloadUpdateAssetWithMirrors(job) {
  const tmpPath = job.filePath + '.download';
  try {
    if (await attemptDifferentialUpdateDownload(job)) return;
  } catch (diffError) {
    if (isUpdateDownloadCancelled(job)) {
      cleanupUpdateDownloadPartial(job);
      return;
    }
    job.switchRequested = false;
    const info = classifyUpdateError(diffError);
    job.failedAttempts = (job.failedAttempts || []).concat({
      source: '差量更新',
      reason: info.reason,
      detail: info.detail,
    }).slice(-6);
    console.warn('[UpdateDiff] falling back to full download:', diffError && diffError.message || diffError);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    job.mode = 'installer';
    job.routing = 'queued';
    job.sourceLabel = '';
    job.total = job.expectedSize || 0;
    job.received = 0;
    job.progress = 0;
    job.message = '差量更新不可用，转为完整下载';
    job.updatedAt = Date.now();
  }
  const initialCandidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  let candidates;
  try {
    candidates = await rankUpdateDownloadCandidates(job, initialCandidates);
  } catch (err) {
    if (isUpdateDownloadCancelled(job)) {
      cleanupUpdateDownloadPartial(job);
      return;
    }
    setUpdateJobError(job, err, '下载准备失败');
    return;
  }
  if (isUpdateDownloadCancelled(job)) {
    cleanupUpdateDownloadPartial(job);
    return;
  }
  job.downloadCandidates = candidates;
  job.attempts = candidates.length;
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    if (isUpdateDownloadCancelled(job)) {
      cleanupUpdateDownloadPartial(job);
      return;
    }
    const candidate = candidates[i];
    let controller = null;
    try {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      ensureMirrorCanBeVerified(job, candidate);
      prepareUpdateJobAttempt(job, candidate, i, candidates.length);
      job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';

      controller = new AbortController();
      job.activeAbortController = controller;
      const connectTimer = setTimeout(() => {
        controller.abort(updateError('UPDATE_CONNECT_TIMEOUT', 'Update connection timed out'));
      }, UPDATE_CONNECT_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(candidate.url, {
          signal: controller.signal,
          headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
        });
      } finally {
        clearTimeout(connectTimer);
      }
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        throw updateError('UPDATE_BODY_MISSING', 'Update response has no body');
      }

      const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      if (totalHeader > UPDATE_MAX_BYTES) throw updateError('UPDATE_TOO_LARGE', 'Installer exceeds the download limit');
      if (job.expectedSize > 0 && totalHeader > 0 && totalHeader !== job.expectedSize) {
        throw updateError('UPDATE_SIZE_MISMATCH', `Expected ${job.expectedSize} bytes, server reported ${totalHeader}`);
      }
      job.total = totalHeader || job.expectedSize || job.total || 0;
      job.progress = 0;
      job.updatedAt = Date.now();
      const attemptStartedAt = Date.now();
      let speedUpdateAt = attemptStartedAt;
      let lowSpeedSince = 0;
      const speedSamples = [{ at: attemptStartedAt, received: 0 }];

      const writer = fs.createWriteStream(tmpPath);
      const reader = resp.body.getReader();
      let bodyComplete = false;
      try {
        while (true) {
          const chunk = await readUpdateChunk(reader);
          if (chunk.done) {
            bodyComplete = true;
            break;
          }
          const buf = Buffer.from(chunk.value);
          job.received += buf.length;
          if (job.received > UPDATE_MAX_BYTES || job.expectedSize > 0 && job.received > job.expectedSize) {
            throw updateError('UPDATE_TOO_LARGE', 'Installer exceeded the expected size');
          }
          const now = Date.now();
          if (now - speedUpdateAt >= 900) {
            speedSamples.push({ at: now, received: job.received });
            const cutoff = now - UPDATE_SPEED_WINDOW_MS;
            while (speedSamples.length > 2 && speedSamples[1].at <= cutoff) speedSamples.shift();
            const first = speedSamples[0];
            job.speedBps = Math.round((job.received - first.received) / Math.max(0.001, (now - first.at) / 1000));
            speedUpdateAt = now;
            if (i < candidates.length - 1 && now - attemptStartedAt >= UPDATE_LOW_SPEED_GRACE_MS) {
              const fasterCandidateAvailable = hasFasterProbedUpdateCandidate(candidates, i, job.speedBps);
              if (job.speedBps < UPDATE_LOW_SPEED_THRESHOLD_BPS && fasterCandidateAvailable) {
                if (!lowSpeedSince) lowSpeedSince = now;
                if (now - lowSpeedSince >= UPDATE_LOW_SPEED_DURATION_MS) {
                  throw updateError('UPDATE_LOW_SPEED', `A probed download source is at least ${UPDATE_LOW_SPEED_REQUIRED_GAIN}x faster`);
                }
              } else {
                lowSpeedSince = 0;
              }
            }
          }
          if (job.total > 0) {
            job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
            job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
          } else {
            const kb = Math.max(1, job.received / 1024);
            job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
          }
          job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
          job.updatedAt = Date.now();
          if (!writer.write(buf)) await once(writer, 'drain');
        }
      } catch (err) {
        try { await reader.cancel(err && err.message || 'download attempt stopped'); } catch (_) {}
        throw err;
      } finally {
        if (bodyComplete && !isUpdateDownloadCancelled(job)) {
          job.routing = 'verifying';
          job.message = '正在校验安装包';
          if (job.activeAbortController === controller) job.activeAbortController = null;
          job.updatedAt = Date.now();
        }
        writer.end();
        await once(writer, 'finish').catch(() => {});
      }

      throwIfUpdateDownloadCancelled(job);
      verifyUpdateFile(tmpPath, job);
      throwIfUpdateDownloadCancelled(job);
      if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
      fs.renameSync(tmpPath, job.filePath);
      job.status = 'ready';
      job.routing = 'ready';
      job.progress = 100;
      job.etaSeconds = 0;
      job.message = '安装包已下载';
      job.updatedAt = Date.now();
      persistUpdateBlockMapSidecarAsync(job).catch(() => {});
      return;
    } catch (attemptError) {
      if (isUpdateDownloadCancelled(job)) {
        cleanupUpdateDownloadPartial(job);
        return;
      }
      const switchedManually = !!job.switchRequested;
      const err = switchedManually
        ? updateError('UPDATE_SOURCE_SWITCH_REQUESTED', 'Manual source switch requested')
        : attemptError;
      job.switchRequested = false;
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1
        ? (switchedManually ? '正在切换下载线路' : ((candidate.label || '当前线路') + '不可用，正在切换线路'))
        : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '下载失败：' + info.reason);
    } finally {
      if (job.activeAbortController === controller) job.activeAbortController = null;
    }
  }
}
function startUpdateDownloadJob(info) {
  const release = info && info.release ? info.release : {};
  const asset = release.asset || {};
  const downloadUrl = release.downloadUrl || asset.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'UPDATE_ASSET_MISSING' };

  const version = info.latestVersion || release.version || '';
  const expectedName = `Mineradio-${normalizeVersion(version)}-Setup.exe`;
  const existing = activeUpdateJobFor(version);
  if (existing) return publicUpdateJob(existing);

  const fileName = safeUpdateFileName(asset.name || '', version);
  const filePath = path.join(UPDATE_DOWNLOAD_DIR, fileName);
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []));
  const expectedSize = asset.size || 0;
  const sha256 = normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase();
  const sha512 = normalizeDigest(asset.sha512 || '', 'sha512');
  if (fileName.toLowerCase() !== expectedName.toLowerCase()) return { ok: false, error: 'UPDATE_ASSET_NAME_INVALID' };
  if (!(expectedSize > 0) || expectedSize > UPDATE_MAX_BYTES) return { ok: false, error: 'UPDATE_SIZE_INVALID' };
  if (!sha256 && !sha512) return { ok: false, error: 'UPDATE_DIGEST_MISSING' };
  const cached = reuseVerifiedInstallerJob({
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    attempts: downloadCandidates.length,
  });
  if (cached) return publicUpdateJob(cached);

  const now = Date.now();
  const job = {
    id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    routing: 'queued',
    progress: 0,
    received: 0,
    total: expectedSize,
    mode: 'installer',
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadUpdateAssetWithMirrors(job);
  return publicUpdateJob(job);
}
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const params = new URLSearchParams(raw);
        const out = {};
        params.forEach((v, k) => { out[k] = v; });
        resolve(out);
      }
    });
    req.on('error', () => resolve({}));
  });
}
function normalizeApiCode(payload) {
  const body = payload && (payload.body || payload);
  return Number((body && body.code) || (body && body.body && body.body.code) || (payload && payload.status) || 0);
}
function normalizeApiMessage(payload) {
  const body = payload && (payload.body || payload);
  return (body && (body.message || body.msg || body.error)) || (body && body.body && (body.body.message || body.body.msg || body.body.error)) || '';
}
function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach(part => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}
function serializeCookieObject(obj) {
  return Object.keys(obj || {})
    .filter(k => obj[k] != null && String(obj[k]) !== '')
    .map(k => k + '=' + String(obj[k]))
    .join('; ');
}
function qqCookieObject() {
  return parseCookieString(qqCookie);
}
function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}
function qqCookieUin(obj) {
  obj = obj || qqCookieObject();
  const raw = Number(obj.login_type) === 2 ? (obj.wxuin || obj.uin || obj.p_uin) : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin);
  return normalizeQQUin(raw);
}
function qqCookieMusicKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
}
function qqCookiePlaybackKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
}
function decodeQQCookieValue(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim(); }
  catch (e) { return String(value || '').trim(); }
}
function qqCookieNickname(obj, uin) {
  obj = obj || qqCookieObject();
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  const padded = uin ? '0' + uin : '';
  const keys = [
    uin && ('ptnick_' + uin),
    padded && ('ptnick_' + padded),
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname'
  ].filter(Boolean);
  for (const key of keys) {
    if (obj[key]) {
      const nick = decodeQQCookieValue(obj[key]);
      if (nick) return nick;
    }
  }
  const ptnickKey = Object.keys(obj).find(key => /^ptnick_/i.test(key) && obj[key]);
  return ptnickKey ? decodeQQCookieValue(obj[ptnickKey]) : '';
}
function qqCookieAvatar(obj, uin) {
  obj = obj || qqCookieObject();
  const direct = obj.qqmusic_avatar || obj.avatar || obj.avatarUrl || obj.headpic || '';
  if (direct) return decodeQQCookieValue(direct);
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : '';
}
function normalizeQQCookieInput(cookieText) {
  const obj = parseCookieString(cookieText);
  if (Number(obj.login_type) === 2 && obj.wxuin && !obj.uin) obj.uin = obj.wxuin;
  if (!obj.uin && (obj.qqmusic_uin || obj.p_uin)) obj.uin = obj.qqmusic_uin || obj.p_uin;
  if (obj.uin) obj.uin = normalizeQQUin(obj.uin);
  return serializeCookieObject(obj);
}
function playbackRestriction(provider, category, message, action, extra) {
  return {
    provider,
    category,
    action: action || '',
    message,
    ...(extra || {}),
  };
}
function classifyNeteasePlaybackRestriction(lastData, loginInfo) {
  const loggedIn = !!(loginInfo && loginInfo.loggedIn);
  const fee = Number(lastData && lastData.fee);
  const code = Number(lastData && lastData.code);
  const freeTrial = lastData && lastData.freeTrialInfo;
  if (!loggedIn) {
    return playbackRestriction('netease', 'login_required', '网易云需要登录后尝试获取完整播放地址', 'login', { code, fee });
  }
  if (freeTrial) {
    return playbackRestriction('netease', 'trial_only', '网易云仅返回试听片段，完整播放需要会员或购买', 'upgrade', { code, fee });
  }
  if (fee === 1) {
    return playbackRestriction('netease', 'vip_required', '网易云歌曲需要 VIP 权限，当前无法获取完整播放地址', 'upgrade', { code, fee });
  }
  if (fee === 4 || fee === 8) {
    return playbackRestriction('netease', 'paid_required', '网易云歌曲需要单曲、专辑购买或更高权限', 'purchase', { code, fee });
  }
  if (code === 404 || code === 403) {
    return playbackRestriction('netease', 'copyright_unavailable', '网易云版权暂不可播，换源或稍后重试会更稳', 'switch_source', { code, fee });
  }
  return playbackRestriction('netease', 'url_unavailable', '网易云没有返回可播放地址，可能是版权、会员或地区限制', loggedIn ? 'switch_source' : 'login', { code, fee });
}
function classifyQQPlaybackRestriction(info, session) {
  const hasSession = typeof session === 'object' ? !!session.hasSession : !!session;
  const hasPlaybackKey = typeof session === 'object' ? !!session.hasPlaybackKey : hasSession;
  const rawMsg = String((info && (info.msg || info.tips || info.errmsg || info.message)) || '').trim();
  const code = Number((info && (info.result || info.code || info.errtype)) || 0);
  const lower = rawMsg.toLowerCase();
  if (!hasSession) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐需要登录或授权后才能获取播放地址', 'login', { code, rawMessage: rawMsg });
  }
  if (!hasPlaybackKey && code === 104003) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐当前只拿到了网页登录状态，还缺少播放授权，请重新打开官方 QQ 音乐登录窗口完成授权', 'login', { code, rawMessage: rawMsg, missingPlaybackKey: true });
  }
  if (code === 104003) {
    return playbackRestriction('qq', 'copyright_unavailable', 'QQ 音乐没有给当前版本返回播放地址，通常是版权、会员或官方版本限制，可以换一个搜索结果或切到网易云源', 'switch_source', { code, rawMessage: rawMsg });
  }
  if (/vip|会员|付费|购买|数字专辑|专辑|pay/.test(lower + rawMsg)) {
    return playbackRestriction('qq', 'paid_required', 'QQ 音乐歌曲需要会员、购买或数字专辑权限', 'upgrade', { code, rawMessage: rawMsg });
  }
  if (code && code !== 0) {
    return playbackRestriction('qq', 'copyright_unavailable', rawMsg || 'QQ 音乐版权暂不可播或仅官方客户端可播', 'switch_source', { code, rawMessage: rawMsg });
  }
  return playbackRestriction('qq', 'url_unavailable', 'QQ 音乐没有返回播放地址，可能受版权、会员或官方客户端限制', 'switch_source', { code, rawMessage: rawMsg });
}
const NETEASE_QUALITY_CANDIDATES = [
  { level: 'jymaster', br: 1999000, label: '超清母带', svip: true },
  { level: 'hires',    br: 1999000, label: '高清臻音' },
  { level: 'lossless', br: 1411000, label: '无损' },
  { level: 'exhigh',   br: 999000,  label: '极高' },
  { level: 'standard', br: 128000,  label: '标准' },
];
const QQ_QUALITY_CANDIDATE_TEMPLATES = [
  { prefix: 'RS01', ext: '.flac', level: 'hires', label: 'Hi-Res FLAC' },
  { prefix: 'F000', ext: '.flac', level: 'lossless', label: '无损 FLAC' },
  { prefix: 'M800', ext: '.mp3', level: 'exhigh', label: '320k MP3' },
  { prefix: 'M500', ext: '.mp3', level: 'standard', label: '128k MP3' },
  { prefix: 'C400', ext: '.m4a', level: 'aac', label: 'AAC/M4A' },
];
function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['jymaster', 'master', 'studio', 'svip'].includes(raw)) return 'jymaster';
  if (['hires', 'hi-res', 'highres', 'zhenyin', 'spatial'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  return 'hires';
}
function qualityCandidatesFrom(target, candidates) {
  target = normalizeQualityPreference(target);
  let start = candidates.findIndex(item => item.level === target);
  if (start < 0) start = 0;
  return candidates.slice(start);
}
function hasNeteaseSvip(loginInfo) {
  return !!(loginInfo && loginInfo.loggedIn && (loginInfo.vipLevel === 'svip' || loginInfo.isSvip || Number(loginInfo.vipType || 0) >= 10));
}
function mapArtists(raw) {
  return (raw || [])
    .map(a => ({ id: a && a.id, name: (a && a.name) || '' }))
    .filter(a => a.name);
}
function mapSongRecord(s) {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  return {
    provider: 'netease',
    source: 'netease',
    type: 'song',
    id: s.id,
    name: s.name,
    artist: artists.map(a => a.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || '',
    albumId: album.id,
    cover: album.picUrl || album.coverUrl || '',
    duration: s.dt || s.duration || 0,
    fee: s.fee,
  };
}
function mapAlbumRecord(raw) {
  raw = raw || {};
  const artists = mapArtists(raw.artists || (raw.artist ? [raw.artist] : []));
  return {
    provider: 'netease',
    source: 'netease',
    type: 'album',
    id: raw.id,
    name: raw.name || '',
    cover: raw.picUrl || raw.blurPicUrl || raw.coverUrl || '',
    artist: artists.map(item => item.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    songCount: Number(raw.size || raw.songCount || 0) || 0,
    publishTime: Number(raw.publishTime || raw.publishDate || 0) || 0,
    albumType: raw.type || '',
    subType: raw.subType || '',
    company: raw.company || '',
    description: raw.description || raw.desc || '',
    alias: Array.isArray(raw.alias) ? raw.alias.filter(Boolean).map(String) : [],
  };
}
function mapDiscoverPlaylist(pl, tag) {
  pl = pl || {};
  const creator = pl.creator || pl.user || {};
  const id = pl.id || pl.resourceId || pl.creativeId;
  return {
    provider: 'netease',
    source: 'netease',
    type: 'playlist',
    id,
    name: pl.name || pl.title || '',
    cover: pl.picUrl || pl.coverImgUrl || pl.coverUrl || pl.uiElement && pl.uiElement.image && pl.uiElement.image.imageUrl || '',
    trackCount: pl.trackCount || pl.songCount || pl.programCount || 0,
    playCount: pl.playCount || pl.playcount || 0,
    creator: creator.nickname || creator.name || '',
    tag: tag || pl.alg || '',
  };
}

function lowSignalText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLowSignalPodcastItem(item) {
  const name = lowSignalText(item && (item.name || item.title || item.radioName));
  const sub = lowSignalText(item && (item.djName || item.category || item.desc || item.sub));
  const text = name + ' ' + sub;
  return /购买播客|付费精品|qzone|空间背景音乐|背景音乐|四只烤翅|试纸烤翅/i.test(text);
}

function isQQFavoritePlaylist(pl) {
  const name = String(pl && pl.name || '').trim();
  return /我喜欢|我的喜欢|喜欢的音乐/i.test(name);
}

function isQzoneBackgroundPlaylist(pl) {
  const text = String((pl && pl.name || '') + ' ' + (pl && pl.creator || '')).toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}
async function requireLogin(res, responseExtras) {
  const info = await getLoginInfo();
  if (info.loginCheckFailed) {
    sendJSON(res, {
      ...(responseExtras || {}),
      ok: false,
      error: 'LOGIN_STATUS_UNAVAILABLE',
      message: info.error || '网易云登录状态暂时无法确认',
      loggedIn: null,
    }, 502);
    return null;
  }
  if (info.partial && !info.userId) {
    sendJSON(res, {
      ...(responseExtras || {}),
      ok: false,
      error: 'LOGIN_PROFILE_UNAVAILABLE',
      message: '网易云账号资料暂时不可用，请稍后重试',
      loggedIn: true,
      partial: true,
    }, 503);
    return null;
  }
  if (!info.loggedIn || !info.userId) {
    sendJSON(res, {
      ...(responseExtras || {}),
      ok: false,
      error: info.authExpired ? 'LOGIN_EXPIRED' : 'LOGIN_REQUIRED',
      loggedIn: false,
      authExpired: !!info.authExpired,
    }, 401);
    return null;
  }
  return info;
}

function mapNeteaseSongs(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(mapSongRecord)
    .filter(song => song.id && song.name);
}

function taskStatus(result, label) {
  if (!result || result.status !== 'fulfilled') {
    const reason = result && result.reason;
    const code = normalizeApiCode(reason);
    return {
      ok: false,
      code: code || 0,
      error: normalizeApiMessage(reason) || reason && reason.message || `${label} failed`,
    };
  }
  const code = normalizeApiCode(result.value);
  const ok = !code || code === 200;
  return {
    ok,
    code: code || 0,
    error: ok ? '' : (normalizeApiMessage(result.value) || `${label} failed`),
  };
}

// ---------- 业务: 搜索 ----------
//   优先用 cloudsearch (新接口, 字段更全, picUrl 更稳定)
//   对于仍然缺失封面的歌曲, 用 song_detail 批量补齐
async function handleSearch(keywords, limit, offset) {
  const pageOffset = Math.max(0, Number(offset || 0) || 0);
  console.log('[Search]', keywords, 'limit:', limit, 'offset:', pageOffset);
  const requestResult = await callPublicNetease(cookie => cloudsearch({
    keywords,
    type: 1,
    limit,
    offset: pageOffset,
    cookie,
    timestamp: Date.now(),
  }));
  const body = throwOnNeteaseApiFailure(requestResult.result, 'SEARCH_FAILED');
  const resultBody = body && (body.result || body.data) || {};
  const songs = Array.isArray(resultBody.songs) ? resultBody.songs : [];

  let mapped = mapNeteaseSongs(songs);

  // 兜底: 补齐缺失的封面
  const missing = mapped.filter(s => !s.cover).map(s => s.id);
  if (missing.length) {
    try {
      console.log('[Search] backfilling covers for', missing.length, 'songs');
      const dd = await song_detail({ ids: missing.join(','), cookie: userCookie });
      const songsArr = (dd.body && dd.body.songs) || [];
      const idToPic = {};
      songsArr.forEach(s => {
        const pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
        if (pic) idToPic[s.id] = pic;
      });
      mapped = mapped.map(s => s.cover ? s : { ...s, cover: idToPic[s.id] || '' });
    } catch (e) { console.warn('[Search] backfill failed:', e.message); }
  }

  const cursor = resolvePageCursor(
    { limit, offset: pageOffset },
    resultBody.songCount,
    songs.length,
    resultBody.hasMore === true || resultBody.more === true,
  );
  return {
    type: 'song',
    requiresLogin: false,
    loggedIn: requestResult.authExpired ? false : null,
    authExpired: requestResult.authExpired,
    songs: mapped,
    items: mapped,
    total: cursor.total,
    offset: pageOffset,
    limit,
    nextOffset: cursor.nextOffset,
    more: cursor.more,
    hasMore: cursor.hasMore,
    empty: mapped.length === 0,
  };
}

async function handleDiscoverHome() {
  const info = await getLoginInfo();
  const loggedIn = !!(info && info.loggedIn);
  if (!loggedIn) {
    return {
      ok: false,
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      sourceStatus: {
        personalized: { ok: false, error: 'LOGIN_REQUIRED' },
        podcasts: { ok: false, error: 'LOGIN_REQUIRED' },
        privatePlaylists: { ok: false, error: 'LOGIN_REQUIRED' },
        dailySongs: { ok: false, error: 'LOGIN_REQUIRED' },
      },
      mode: 'starter',
      updatedAt: Date.now(),
    };
  }
  const tasks = [
    personalized({ limit: 8, cookie: userCookie, timestamp: Date.now() }),
    dj_hot({ limit: 6, offset: 0, cookie: userCookie, timestamp: Date.now() }),
    recommend_resource({ cookie: userCookie, timestamp: Date.now() }),
    recommend_songs({ cookie: userCookie, timestamp: Date.now() }),
  ];
  const result = await Promise.allSettled(tasks);

  const personalizedBody = result[0].status === 'fulfilled' && result[0].value && result[0].value.body || {};
  const publicPlaylists = (personalizedBody.result || personalizedBody.data || [])
    .map(pl => mapDiscoverPlaylist(pl, '推荐歌单'))
    .filter(pl => pl.id && pl.name)
    .slice(0, 8);

  const podcastBody = result[1].status === 'fulfilled' && result[1].value && result[1].value.body || {};
  const podcastRaw = podcastBody.djRadios || podcastBody.djradios || podcastBody.radios || podcastBody.data || [];
  const podcasts = (Array.isArray(podcastRaw) ? podcastRaw : [])
    .map(mapPodcastRadio)
    .filter(p => p.id && !isLowSignalPodcastItem(p))
    .slice(0, 6);

  let privatePlaylists = [];
  if (result[2].status === 'fulfilled' && result[2].value) {
    const body = result[2].value.body || {};
    const raw = body.recommend || body.data || [];
    privatePlaylists = (Array.isArray(raw) ? raw : [])
      .map(pl => mapDiscoverPlaylist(pl, '私人推荐'))
      .filter(pl => pl.id && pl.name)
      .slice(0, 6);
  }

  let dailySongs = [];
  if (result[3].status === 'fulfilled' && result[3].value) {
    const body = result[3].value.body || {};
    const raw = body.data && (body.data.dailySongs || body.data.recommend) || body.recommend || [];
    dailySongs = mapNeteaseSongs(raw);
  }

  return {
    ok: true,
    loggedIn,
    user: loggedIn ? { userId: info.userId, nickname: info.nickname || '', avatar: info.avatar || '' } : null,
    dailySongs,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts,
    sourceStatus: {
      personalized: taskStatus(result[0], 'Personalized playlists'),
      podcasts: taskStatus(result[1], 'Podcasts'),
      privatePlaylists: taskStatus(result[2], 'Private playlists'),
      dailySongs: taskStatus(result[3], 'Daily recommendations'),
    },
    updatedAt: Date.now(),
  };
}

const NETEASE_NEW_SONG_AREAS = Object.freeze({
  all: 0,
  zh: 7,
  ea: 96,
  jp: 8,
  kr: 16,
});
const NETEASE_NEW_ALBUM_AREAS = new Set(['ALL', 'ZH', 'EA', 'JP', 'KR']);
const NETEASE_DISCOVER_SECTIONS = new Set([
  'toplists',
  'new-songs',
  'new-albums',
  'playlist-categories',
  'playlists',
  'recent',
  'cloud',
  'favorite-albums',
  'followed-artists',
  'listening-rank',
]);
const NETEASE_PROTECTED_DISCOVER_SECTIONS = new Set([
  'recent',
  'cloud',
  'favorite-albums',
  'followed-artists',
  'listening-rank',
]);

function discoverPageResponse(section, page, total, items, extras, paging) {
  const list = Array.isArray(items) ? items : [];
  const cursor = resolvePageCursor(
    page,
    total,
    paging && paging.rawCount != null ? paging.rawCount : list.length,
    !!(paging && paging.hasMore),
  );
  return {
    ok: true,
    section,
    error: '',
    limit: page.limit,
    offset: page.offset,
    ...cursor,
    empty: list.length === 0,
    items: list,
    ...(extras || {}),
  };
}

function emptyNeteaseDiscoverResponse(section, limit, offset) {
  const page = normalizePagination(limit, offset, { defaultLimit: 30, maxLimit: 100 });
  const specialized = {};
  if (section === 'toplists') specialized.toplists = [];
  else if (section === 'new-albums' || section === 'favorite-albums') specialized.albums = [];
  else if (section === 'followed-artists') specialized.artists = [];
  else if (section === 'playlists') specialized.playlists = [];
  else if (section === 'playlist-categories') {
    specialized.categories = [];
    specialized.categoryGroups = [];
  } else specialized.songs = [];
  return {
    section,
    ...page,
    total: 0,
    nextOffset: page.offset,
    more: false,
    hasMore: false,
    empty: true,
    items: [],
    ...specialized,
  };
}

function mapRecentSongRecord(record) {
  record = record || {};
  const rawSong = record.data || record.song || record.resource || record;
  const mapped = mapSongRecord(rawSong);
  return {
    ...mapped,
    playedAt: Number(record.playTime || record.playedAt || record.time || 0) || 0,
    playCount: Number(record.playCount || record.count || 0) || 0,
  };
}

function mapCloudSongRecord(record) {
  record = record || {};
  const rawSong = record.simpleSong || record.song || record.resource || {};
  const mapped = mapSongRecord(rawSong);
  if (!mapped.id) mapped.id = record.songId || record.id;
  if (!mapped.name) mapped.name = record.songName || record.fileName || '';
  if (!mapped.artist) mapped.artist = record.artist || '';
  if (!mapped.album) mapped.album = record.album || '';
  return {
    ...mapped,
    sourceType: 'netease-cloud',
    cloud: {
      fileName: record.fileName || '',
      fileSize: Number(record.fileSize || 0) || 0,
      bitrate: Number(record.bitrate || record.bitRate || 0) || 0,
      addTime: Number(record.addTime || record.uploadTime || 0) || 0,
    },
  };
}

async function handleNeteaseDiscover(section, query) {
  const page = normalizePagination(query.limit, query.offset, { defaultLimit: 30, maxLimit: 100 });
  const protectedSection = NETEASE_PROTECTED_DISCOVER_SECTIONS.has(section);
  let loginInfo = null;
  if (protectedSection) {
    loginInfo = query.loginInfo;
  }

  if (section === 'toplists') {
    const requestResult = await callPublicNetease(cookie => toplist_detail({ cookie, timestamp: Date.now() }));
    const body = throwOnNeteaseApiFailure(requestResult.result, 'NETEASE_TOPLISTS_FAILED');
    const raw = Array.isArray(body.list) ? body.list : [];
    const total = raw.length;
    const rawPage = raw.slice(page.offset, page.offset + page.limit);
    const items = rawPage.map(item => ({
      ...mapNeteasePlaylist(item),
      updateFrequency: item.updateFrequency || '',
      tracks: mapNeteaseSongs(item.tracks || []).slice(0, 3),
    })).filter(item => item.id && item.name);
    return discoverPageResponse(section, page, total, items, {
      toplists: items,
      requiresLogin: false,
      loggedIn: requestResult.authExpired ? false : null,
      authExpired: requestResult.authExpired,
    }, { rawCount: rawPage.length });
  }

  if (section === 'new-songs') {
    const areaKey = String(query.area || 'all').trim().toLowerCase();
    const numericArea = Number(areaKey);
    const area = Object.prototype.hasOwnProperty.call(NETEASE_NEW_SONG_AREAS, areaKey)
      ? NETEASE_NEW_SONG_AREAS[areaKey]
      : (Object.values(NETEASE_NEW_SONG_AREAS).includes(numericArea) ? numericArea : 0);
    const requestResult = await callPublicNetease(cookie => top_song({ type: area, cookie, timestamp: Date.now() }));
    const body = throwOnNeteaseApiFailure(requestResult.result, 'NETEASE_NEW_SONGS_FAILED');
    const raw = Array.isArray(body.data) ? body.data : (Array.isArray(body.songs) ? body.songs : []);
    const rawPage = raw.slice(page.offset, page.offset + page.limit);
    const items = mapNeteaseSongs(rawPage);
    return discoverPageResponse(section, page, raw.length, items, {
      songs: items,
      area,
      requiresLogin: false,
      loggedIn: requestResult.authExpired ? false : null,
      authExpired: requestResult.authExpired,
    }, { rawCount: rawPage.length });
  }

  if (section === 'new-albums') {
    const requestedArea = String(query.area || 'ALL').trim().toUpperCase();
    const area = NETEASE_NEW_ALBUM_AREAS.has(requestedArea) ? requestedArea : 'ALL';
    const requestResult = await callPublicNetease(cookie => album_new({
      area,
      limit: page.limit,
      offset: page.offset,
      cookie,
      timestamp: Date.now(),
    }));
    const body = throwOnNeteaseApiFailure(requestResult.result, 'NETEASE_NEW_ALBUMS_FAILED');
    const raw = Array.isArray(body.albums) ? body.albums : [];
    const items = raw.map(mapAlbumRecord).filter(item => item.id && item.name);
    const total = Math.max(0, Number(body.total || body.albumCount || items.length) || 0);
    return discoverPageResponse(section, page, total, items, {
      albums: items,
      area,
      requiresLogin: false,
      loggedIn: requestResult.authExpired ? false : null,
      authExpired: requestResult.authExpired,
    }, { rawCount: raw.length, hasMore: body.hasMore === true || body.more === true });
  }

  if (section === 'playlist-categories') {
    const requestResult = await callPublicNetease(cookie => playlist_catlist({ cookie, timestamp: Date.now() }));
    const body = throwOnNeteaseApiFailure(requestResult.result, 'NETEASE_PLAYLIST_CATEGORIES_FAILED');
    const categoryGroups = mapPlaylistCategories(body);
    const categories = categoryGroups
      .flatMap(group => group.items.map(item => item.name))
      .filter((name, index, list) => name && list.indexOf(name) === index);
    return {
      ok: true,
      section,
      error: '',
      empty: categories.length === 0,
      total: categories.length,
      categories,
      categoryGroups,
      items: categories,
      requiresLogin: false,
      loggedIn: requestResult.authExpired ? false : null,
      authExpired: requestResult.authExpired,
    };
  }

  if (section === 'playlists') {
    const cat = String(query.cat || '全部').trim().slice(0, 30) || '全部';
    const order = String(query.order || 'hot').toLowerCase() === 'new' ? 'new' : 'hot';
    const requestResult = await callPublicNetease(cookie => top_playlist({
      cat,
      order,
      limit: page.limit,
      offset: page.offset,
      cookie,
      timestamp: Date.now(),
    }));
    const body = throwOnNeteaseApiFailure(requestResult.result, 'NETEASE_PLAYLISTS_FAILED');
    const raw = Array.isArray(body.playlists) ? body.playlists : [];
    const items = raw.map(mapNeteasePlaylist).filter(item => item.id && item.name);
    const total = Math.max(0, Number(body.total || body.playlistCount || items.length) || 0);
    return discoverPageResponse(section, page, total, items, {
      playlists: items,
      cat,
      order,
      requiresLogin: false,
      loggedIn: requestResult.authExpired ? false : null,
      authExpired: requestResult.authExpired,
    }, { rawCount: raw.length, hasMore: body.more === true || body.hasMore === true });
  }

  if (section === 'favorite-albums') {
    const result = await album_sublist({
      limit: page.limit,
      offset: page.offset,
      cookie: userCookie,
      timestamp: Date.now(),
    });
    const body = throwOnNeteaseApiFailure(result, 'NETEASE_FAVORITE_ALBUMS_FAILED');
    const raw = Array.isArray(body.data) ? body.data : (Array.isArray(body.albums) ? body.albums : []);
    const items = raw.map(mapNeteaseAlbum).filter(item => item.id && item.name);
    const total = Math.max(0, Number(body.count || body.total || items.length) || 0);
    return discoverPageResponse(section, page, total, items, {
      albums: items,
      requiresLogin: true,
      loggedIn: !!loginInfo,
      authExpired: false,
    }, { rawCount: raw.length, hasMore: body.hasMore === true || body.more === true });
  }

  if (section === 'followed-artists') {
    const result = await artist_sublist({
      limit: page.limit,
      offset: page.offset,
      cookie: userCookie,
      timestamp: Date.now(),
    });
    const body = throwOnNeteaseApiFailure(result, 'NETEASE_FOLLOWED_ARTISTS_FAILED');
    const raw = Array.isArray(body.data) ? body.data : (Array.isArray(body.artists) ? body.artists : []);
    const items = raw.map(mapNeteaseArtist).filter(item => item.id && item.name);
    const total = Math.max(0, Number(body.count || body.total || items.length) || 0);
    return discoverPageResponse(section, page, total, items, {
      artists: items,
      requiresLogin: true,
      loggedIn: !!loginInfo,
      authExpired: false,
    }, { rawCount: raw.length, hasMore: body.hasMore === true || body.more === true });
  }

  if (section === 'listening-rank') {
    const period = String(query.period || '').trim().toLowerCase() === 'week' || String(query.recordType) === '1'
      ? 'week'
      : 'all';
    const result = await user_record({
      uid: loginInfo.userId,
      type: period === 'week' ? 1 : 0,
      cookie: userCookie,
      timestamp: Date.now(),
    });
    const body = throwOnNeteaseApiFailure(result, 'NETEASE_LISTENING_RANK_FAILED');
    const raw = period === 'week'
      ? (Array.isArray(body.weekData) ? body.weekData : [])
      : (Array.isArray(body.allData) ? body.allData : []);
    const rawPage = raw.slice(page.offset, page.offset + page.limit);
    const items = rawPage.map((record, index) => ({
      ...mapSongRecord(record && (record.song || record.data) || {}),
      rank: page.offset + index + 1,
      playCount: Number(record && record.playCount || 0) || 0,
      score: Number(record && record.score || 0) || 0,
    })).filter(item => item.id && item.name);
    return discoverPageResponse(section, page, raw.length, items, {
      songs: items,
      period,
      requiresLogin: true,
      loggedIn: !!loginInfo,
      authExpired: false,
    }, { rawCount: rawPage.length });
  }

  if (section === 'recent') {
    const fetchLimit = Math.min(1000, page.offset + page.limit);
    const result = await record_recent_song({ limit: fetchLimit, cookie: userCookie, timestamp: Date.now() });
    const body = throwOnNeteaseApiFailure(result, 'NETEASE_RECENT_FAILED');
    const data = body.data || {};
    const raw = Array.isArray(data.list) ? data.list : (Array.isArray(body.list) ? body.list : []);
    const rawPage = raw.slice(page.offset, page.offset + page.limit);
    const items = rawPage
      .map(mapRecentSongRecord)
      .filter(item => item.id && item.name);
    const total = Math.max(0, Number(data.total || body.total || raw.length) || 0);
    return discoverPageResponse(section, page, total, items, {
      songs: items,
      requiresLogin: true,
      loggedIn: !!loginInfo,
      authExpired: false,
    }, { rawCount: rawPage.length });
  }

  const result = await user_cloud({
    limit: page.limit,
    offset: page.offset,
    cookie: userCookie,
    timestamp: Date.now(),
  });
  const body = throwOnNeteaseApiFailure(result, 'NETEASE_CLOUD_FAILED');
  const raw = Array.isArray(body.data) ? body.data : (body.data && Array.isArray(body.data.list) ? body.data.list : []);
  const items = raw.map(mapCloudSongRecord).filter(item => item.id && item.name);
  const total = Math.max(0, Number(body.count || body.total || body.data && body.data.total || items.length) || 0);
  return discoverPageResponse(section, page, total, items, {
    songs: items,
    size: Number(body.size || body.maxSize || 0) || 0,
    requiresLogin: true,
    loggedIn: !!loginInfo,
    authExpired: false,
  }, { rawCount: raw.length, hasMore: body.hasMore === true || body.more === true });
}

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': UA,
};
const QQ_VIP_INFO_CACHE_TTL_MS = 2 * 60 * 1000;
const qqVipInfoCache = new Map();

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(opts.timeoutMs || 10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Invalid JSON from ' + targetUrl);
    err.cause = e;
    throw err;
  }
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function openMeteoWeatherLabel(code) {
  code = Number(code);
  if (code === 0) return '晴';
  if (code === 1 || code === 2) return '少云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code === 51 || code === 53 || code === 55) return '毛毛雨';
  if (code === 56 || code === 57) return '冻雨';
  if (code === 61 || code === 63 || code === 65) return '雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75 || code === 77) return '雪';
  if (code === 80 || code === 81 || code === 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95 || code === 96 || code === 99) return '雷雨';
  return '天气';
}

function buildWeatherMood(weather, date) {
  const now = date || new Date();
  const hour = now.getHours();
  const code = Number(weather && weather.weatherCode);
  const temp = Number(weather && weather.temperature);
  const apparent = Number(weather && weather.apparentTemperature);
  const rain = Number(weather && weather.precipitation) || 0;
  const humidity = Number(weather && weather.humidity) || 0;
  const wind = Number(weather && weather.windSpeed) || 0;
  const isNight = weather && weather.isDay === 0 || hour < 6 || hour >= 20;
  const isMorning = hour >= 5 && hour < 11;
  const isDusk = hour >= 17 && hour < 20;
  const isRain = rain > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  const isSnow = [71, 73, 75, 77, 85, 86].includes(code);
  const isCloud = [2, 3, 45, 48].includes(code);
  const isStorm = [95, 96, 99].includes(code);
  const feels = Number.isFinite(apparent) ? apparent : temp;

  let mood = {
    key: 'clear',
    title: '晴朗电台',
    tagline: '让节奏亮一点，像窗边的光',
    energy: 0.62,
    warmth: 0.58,
    focus: 0.48,
    melancholy: 0.24,
    keywords: ['轻快 华语', 'city pop', 'indie pop', 'chill pop', '阳光 歌单'],
  };
  if (isStorm) {
    mood = {
      key: 'storm',
      title: '雷雨电台',
      tagline: '低频更厚，适合把世界关小一点',
      energy: 0.46,
      warmth: 0.34,
      focus: 0.66,
      melancholy: 0.62,
      keywords: ['暗色 R&B', 'trip hop', '夜晚 电子', '氛围 摇滚', '雨夜 歌单'],
    };
  } else if (isRain) {
    mood = {
      key: 'rain',
      title: '雨天电台',
      tagline: '留一点潮湿的空间给旋律',
      energy: 0.38,
      warmth: 0.42,
      focus: 0.64,
      melancholy: 0.66,
      keywords: ['雨天 R&B', 'lofi rainy', '华语 慢歌', 'dream pop', '雨夜 歌单'],
    };
  } else if (isSnow || feels <= 3) {
    mood = {
      key: 'snow',
      title: '冷空气电台',
      tagline: '干净、慢速、带一点冬天的颗粒感',
      energy: 0.34,
      warmth: 0.28,
      focus: 0.72,
      melancholy: 0.54,
      keywords: ['冬天 民谣', 'ambient piano', '日系 冬天', 'indie folk', '安静 歌单'],
    };
  } else if (feels >= 31 || humidity >= 78) {
    mood = {
      key: 'humid',
      title: '闷热电台',
      tagline: '降低密度，留出一点呼吸',
      energy: 0.48,
      warmth: 0.76,
      focus: 0.46,
      melancholy: 0.30,
      keywords: ['夏日 chill', 'bossa nova', 'city pop 夏天', '轻电子', '海边 歌单'],
    };
  } else if (isCloud) {
    mood = {
      key: 'cloudy',
      title: '阴天电台',
      tagline: '不急着明亮，先让声音变软',
      energy: 0.40,
      warmth: 0.46,
      focus: 0.58,
      melancholy: 0.52,
      keywords: ['阴天 华语', 'indie rock mellow', 'neo soul', 'chillhop', '独立 民谣'],
    };
  }

  if (isNight) {
    mood.key += '-night';
    mood.title = mood.key.startsWith('clear') ? '夜色电台' : mood.title.replace('电台', '夜听');
    mood.tagline = '音量放低一点，让夜色参与编曲';
    mood.energy = Math.min(mood.energy, 0.42);
    mood.focus = Math.max(mood.focus, 0.68);
    mood.melancholy = Math.max(mood.melancholy, 0.52);
    mood.keywords = ['夜晚 R&B', 'late night jazz', 'ambient', 'lofi sleep', '夜跑 歌单'].concat(mood.keywords.slice(0, 3));
  } else if (isMorning) {
    mood.title = mood.key.startsWith('rain') ? '雨晨电台' : '早晨电台';
    mood.energy = Math.max(mood.energy, 0.52);
    mood.keywords = ['早晨 通勤', 'morning acoustic', '清晨 indie', '轻快 华语'].concat(mood.keywords.slice(0, 3));
  } else if (isDusk) {
    mood.title = mood.key.startsWith('rain') ? '黄昏雨声' : '黄昏电台';
    mood.melancholy = Math.max(mood.melancholy, 0.48);
    mood.keywords = ['黄昏 city pop', '日落 歌单', '落日飞车', 'soul pop'].concat(mood.keywords.slice(0, 3));
  }

  if (wind >= 28) {
    mood.energy = Math.max(mood.energy, 0.56);
    mood.keywords = ['公路 摇滚', 'windy day playlist'].concat(mood.keywords.slice(0, 4));
  }
  mood.keywords = Array.from(new Set(mood.keywords)).slice(0, 7);
  return mood;
}

async function resolveOpenMeteoLocation(query) {
  const raw = String(query || '').trim();
  if (!raw) return WEATHER_DEFAULT_LOCATION;
  const u = new URL(OPEN_METEO_GEOCODE_URL);
  u.searchParams.set('name', raw);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const first = body && Array.isArray(body.results) && body.results[0];
  if (!first) return { ...WEATHER_DEFAULT_LOCATION, query: raw, fallback: true };
  return {
    name: first.name || raw,
    country: first.country || '',
    admin1: first.admin1 || '',
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone || 'auto',
  };
}

async function fetchOpenMeteoWeather(params) {
  params = params || {};
  let location;
  const lat = clampNumber(params.lat, -90, 90, NaN);
  const lon = clampNumber(params.lon, -180, 180, NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = {
      name: String(params.city || params.name || '当前位置').trim() || '当前位置',
      country: '',
      latitude: lat,
      longitude: lon,
      timezone: params.timezone || 'auto',
    };
  } else {
    location = await resolveOpenMeteoLocation(params.city || params.q || params.location);
  }
  const u = new URL(OPEN_METEO_FORECAST_URL);
  u.searchParams.set('latitude', String(location.latitude));
  u.searchParams.set('longitude', String(location.longitude));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('hourly', 'precipitation_probability,weather_code,temperature_2m');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const cur = body && body.current || {};
  const weather = {
    provider: 'open-meteo',
    location: {
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: body.timezone || location.timezone || '',
      fallback: !!location.fallback,
    },
    label: openMeteoWeatherLabel(cur.weather_code),
    weatherCode: Number(cur.weather_code),
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    precipitation: Number(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: Number(cur.cloud_cover),
    windSpeed: Number(cur.wind_speed_10m),
    windGusts: Number(cur.wind_gusts_10m),
    isDay: Number(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
  };
  weather.mood = buildWeatherMood(weather);
  return weather;
}

async function fetchIpWeatherLocation() {
  const u = new URL(WEATHER_IP_LOCATION_URL);
  u.searchParams.set('fields', 'success,message,country,region,city,latitude,longitude,timezone,ip');
  u.searchParams.set('lang', 'zh-CN');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  if (!body || body.success === false || !Number.isFinite(Number(body.latitude)) || !Number.isFinite(Number(body.longitude))) {
    const err = new Error(body && body.message || 'IP_LOCATION_FAILED');
    err.body = body;
    throw err;
  }
  return {
    provider: 'ipwho.is',
    city: body.city || WEATHER_DEFAULT_LOCATION.name,
    region: body.region || '',
    country: body.country || '',
    latitude: Number(body.latitude),
    longitude: Number(body.longitude),
    timezone: (body.timezone && (body.timezone.id || body.timezone.name))
      || (typeof body.timezone === 'string' ? body.timezone : 'auto'),
    ip: body.ip || '',
  };
}

function weatherRadioSeedQueries(mood) {
  const key = String(mood && mood.key || '');
  if (key.includes('rain') || key.includes('storm')) return ['陈奕迅 阴天快乐', '周杰伦 雨下一整晚', '孙燕姿 遇见', '林宥嘉 说谎', '毛不易 消愁'];
  if (key.includes('snow') || key.includes('cloudy')) return ['陈奕迅 好久不见', '莫文蔚 阴天', '李健 贝加尔湖畔', '朴树 平凡之路', '蔡健雅 达尔文'];
  if (key.includes('humid')) return ['落日飞车 My Jinji', '告五人 爱人错过', '夏日入侵企画 想去海边', '陈绮贞 旅行的意义', '王若琳 Lost in Paradise'];
  if (key.includes('night')) return ['方大同 特别的人', '陶喆 爱很简单', 'Frank Ocean Pink + White', '林忆莲 夜太黑', "Norah Jones Don't Know Why"];
  return ['孙燕姿 天黑黑', '周杰伦 晴天', '五月天 温柔', '陈奕迅 稳稳的幸福', '王菲'];
}

function fallbackWeatherForRadio(params, err) {
  params = params || {};
  const name = String(params.city || params.q || params.location || WEATHER_DEFAULT_LOCATION.name).trim() || WEATHER_DEFAULT_LOCATION.name;
  return {
    provider: 'open-meteo',
    location: {
      name,
      country: '',
      admin1: '',
      latitude: null,
      longitude: null,
      timezone: params.timezone || WEATHER_DEFAULT_LOCATION.timezone,
      fallback: true,
    },
    label: '天气暂不可用',
    weatherCode: null,
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    precipitation: null,
    cloudCover: null,
    windSpeed: null,
    windGusts: null,
    isDay: null,
    time: '',
    updatedAt: Date.now(),
    error: err && err.message || '',
    mood: {
      key: 'fallback',
      title: '临时电台',
      tagline: '天气暂时没有回来，先放一组稳妥的歌',
      energy: 0.54,
      warmth: 0.55,
      focus: 0.55,
      melancholy: 0.35,
      keywords: ['华语 流行', 'indie pop', 'city pop', '轻快 歌单', 'chill pop'],
    },
  };
}

function uniqueSongsByKey(songs) {
  const seen = new Set();
  const out = [];
  (songs || []).forEach(song => {
    const key = String(song && (song.id || song.name + '|' + song.artist) || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

function tagWeatherPoolSongs(songs, source) {
  return (songs || []).map(song => ({ ...song, weatherSource: source }));
}

async function fetchWeatherPlaylistSongs(playlist, limit) {
  const id = playlist && playlist.id;
  if (!id) return [];
  let rawTracks = [];
  try {
    if (typeof playlist_track_all === 'function') {
      const all = await playlist_track_all({ id, limit: limit || 36, offset: 0, cookie: userCookie, timestamp: Date.now() });
      rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
    }
  } catch (e) {
    console.warn('[WeatherRadio] playlist_track_all failed:', playlist && playlist.name, e.message);
  }
  if (!rawTracks.length && typeof playlist_detail === 'function') {
    try {
      const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
      const pl = (detail.body && detail.body.playlist) || {};
      rawTracks = pl.tracks || [];
    } catch (e) {
      console.warn('[WeatherRadio] playlist_detail failed:', playlist && playlist.name, e.message);
    }
  }
  return rawTracks.map(mapSongRecord).filter(song => song.id && song.name).slice(0, limit || 36);
}

async function filterLikelyPlayableWeatherSongs(songs) {
  const source = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .slice(0, 24);
  const playable = [];
  const fallback = source.slice(0, 24);
  for (let i = 0; i < source.length; i += 4) {
    const chunk = source.slice(i, i + 4);
    const settled = await Promise.allSettled(chunk.map(async song => {
      const info = await handleSongUrl(song.id, { loggedIn: !!userCookie }, 'standard');
      return info && info.url ? song : null;
    }));
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) playable.push(result.value);
      else if (result.status === 'rejected') console.warn('[WeatherRadio] playable probe failed:', chunk[idx] && chunk[idx].name, result.reason && result.reason.message);
    });
    if (playable.length >= 12) break;
  }
  return (playable.length ? playable : fallback).slice(0, 24);
}

function isLowSignalWeatherSong(song) {
  const text = String([
    song && song.name,
    song && song.artist,
    song && song.album,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return true;
  if (/(^|[\s\-_/（(])ai(?:\s*(歌|歌曲|音乐|cover|翻唱|生成|作曲|演唱|女声|男声)|$|[\s\-_/）)])/i.test(text)) return true;
  if (/suno|udio|人工智能|生成歌曲|ai歌曲|虚拟歌手|测试音频|demo|beat\s*maker/i.test(text)) return true;
  if (/翻自|翻唱|cover|remix|伴奏|纯音乐|钢琴|dj|live\s*版|live版|唯美钢琴|karaoke|instrumental/i.test(text)) return true;
  if (/白噪音|雨声|睡眠|助眠|冥想|疗愈频率|环境音|自然声音|asmr/i.test(text)) return true;
  if (/[（(](r&b|lofi|jazz|dj|edm|trap|remix|伴奏|纯音乐|钢琴|电子|治愈|古风|女声|男声|英文|中文版|抖音|ai)[）)]/i.test(text)) return true;
  if (/^(纯音乐|轻音乐|治愈系|放松|睡眠|雨天|阴天|夜晚|夏日|海边)$/i.test(String(song.name || '').trim())) return true;
  return false;
}

function scoreWeatherSong(song, mood) {
  const text = String((song && song.name || '') + ' ' + (song && song.artist || '') + ' ' + (song && song.album || '')).toLowerCase();
  let score = 0;
  if (song && song.cover) score += 4;
  if (song && song.duration) score += 2;
  if (song && song.weatherSource === 'daily') score += 6;
  if (song && song.weatherSource === 'private') score += 4;
  if (/周杰伦|陈奕迅|孙燕姿|五月天|王菲|陶喆|方大同|林宥嘉|蔡健雅|莫文蔚|李健|毛不易|告五人|落日飞车|陈绮贞|朴树/.test(text)) score += 10;
  const key = String(mood && mood.key || '');
  if (key.includes('rain') && /雨|阴|夜|慢|r&b|soul|陈奕迅|林宥嘉|孙燕姿/.test(text)) score += 5;
  if (key.includes('humid') && /夏|海|city|pop|落日|告五人|方大同|陶喆/.test(text)) score += 5;
  if (key.includes('night') && /夜|moon|jazz|soul|r&b|方大同|陶喆|王菲/.test(text)) score += 5;
  if (key.includes('cloudy') && /阴|民谣|indie|陈绮贞|朴树|李健/.test(text)) score += 5;
  return score;
}

function weatherArtistKey(song) {
  const raw = String(song && song.artist || song && song.name || '').split(/\s*\/\s*|、|,|&/)[0] || '';
  return raw.trim().toLowerCase() || 'unknown';
}

function weatherTitleKey(song) {
  return String(song && song.name || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s._\-·'’"“”「」《》:：/\\|]+/g, '')
    .trim();
}

function uniqueWeatherTitles(sorted) {
  const seen = new Set();
  const out = [];
  (sorted || []).forEach(song => {
    const key = weatherTitleKey(song);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(song);
  });
  return out;
}

function diversifyWeatherSongs(sorted, artistLimit) {
  const primary = [];
  const deferred = [];
  const counts = new Map();
  (sorted || []).forEach(song => {
    const key = weatherArtistKey(song);
    const count = counts.get(key) || 0;
    if (count < artistLimit) {
      primary.push(song);
      counts.set(key, count + 1);
    } else {
      deferred.push(song);
    }
  });
  return primary.length >= 8 ? primary : primary.concat(deferred.slice(0, 8 - primary.length));
}

function orderWeatherSongs(songs, mood) {
  const sorted = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .sort((a, b) => scoreWeatherSong(b, mood) - scoreWeatherSong(a, mood));
  return diversifyWeatherSongs(uniqueWeatherTitles(sorted), 2);
}

async function buildWeatherRadio(params) {
  let weather;
  try {
    weather = await fetchOpenMeteoWeather(params);
  } catch (e) {
    console.warn('[WeatherRadio] weather provider failed, using fallback radio:', e.message);
    weather = fallbackWeatherForRadio(params, e);
  }
  const queries = weatherRadioSeedQueries(weather.mood);
  let songs = [];
  const settled = await Promise.allSettled(queries.slice(0, 4).map(q => handleSearch(q, 6)));
  settled.forEach(result => {
    if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.songs)) songs = songs.concat(result.value.songs);
  });
  if (songs.length < 10 && weather.mood && Array.isArray(weather.mood.keywords)) {
    const more = await Promise.allSettled(weather.mood.keywords.slice(0, 2).map(q => handleSearch(q, 6)));
    more.forEach(result => {
      if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.songs)) songs = songs.concat(result.value.songs);
    });
  }
  songs = orderWeatherSongs(songs, weather.mood);
  return {
    ok: true,
    weather,
    radio: {
      title: weather.mood.title,
      subtitle: weather.mood.tagline,
      seedQueries: queries.slice(0, 4),
      songs: songs.slice(0, 18),
      updatedAt: Date.now(),
    },
  };
}

function parseJSONText(text) {
  const raw = String(text || '').trim();
  const json = raw.replace(/^callback\(([\s\S]*)\);?$/, '$1');
  return JSON.parse(json);
}

async function qqMusicRequest(payload, opts) {
  opts = opts || {};
  const body = JSON.stringify(payload);
  const headers = {
    ...QQ_HEADERS,
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
  };
  if (opts.cookie && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(QQ_MUSICU_URL, {
    method: 'POST',
    headers,
    timeoutMs: opts.timeoutMs,
  }, body);
  return parseJSONText(text);
}

function normalizeQQVipPayload(payload, fallback) {
  return normalizeQQVipPayloadStrict(payload, fallback || {});
}

function withQQVipSyncState(info, probeAvailable) {
  info = info || {};
  const authIncomplete = !!(info.loggedIn && !info.playbackKeyReady);
  const membershipUnknown = !!(info.loggedIn && info.membershipKnown !== true);
  const membershipStale = !!(info.loggedIn && (
    authIncomplete ||
    membershipUnknown ||
    (info.profileUnavailable && !probeAvailable)
  ));
  return {
    ...info,
    membershipStale,
    authorizationIncomplete: authIncomplete,
    vipSyncState: authIncomplete
      ? 'authorization_incomplete'
      : (membershipUnknown ? 'unknown' : (probeAvailable ? 'checked' : (membershipStale ? 'stale' : 'profile'))),
  };
}

function mergeQQVipStatus(info, vip, source) {
  info = info || {};
  const profilePositive = !!(
    info.isVip ||
    info.isSvip ||
    info.vipLevel === 'vip' ||
    info.vipLevel === 'svip' ||
    Number(info.vipType || 0) > 0 ||
    Number(info.svipType || 0) > 0
  );
  const probeKnown = !!(vip && vip.resolved && vip.membershipKnown !== false);
  if (!probeKnown) {
    return withQQVipSyncState({
      ...info,
      vipCheckedAt: Date.now(),
      vipProbeAvailable: false,
      vipSource: info.vipSource || 'profile',
    }, false);
  }

  // One replicated endpoint can briefly return an ordinary result after the
  // official profile already confirmed an active membership.
  if (profilePositive && !vip.isVip) {
    return withQQVipSyncState({
      ...info,
      membershipKnown: true,
      vipCheckedAt: Date.now(),
      vipProbeAvailable: true,
      vipEvidenceConflict: true,
      vipSource: info.vipSource || 'qq-profile-vip',
    }, true);
  }
  if (info.loggedIn && info.playbackKeyReady === false && !vip.isVip) {
    return withQQVipSyncState({
      ...info,
      vipCheckedAt: Date.now(),
      vipProbeAvailable: false,
      vipSource: source || vip.vipSource || info.vipSource || 'qq-vip-probe-untrusted',
    }, false);
  }
  return withQQVipSyncState({
    ...info,
    vipType: vip.vipType || 0,
    svipType: vip.svipType || 0,
    vipLevel: vip.vipLevel || 'none',
    isVip: !!vip.isVip,
    isSvip: !!vip.isSvip,
    vipLabel: vip.vipLabel || (vip.isVip ? 'VIP' : '无VIP'),
    membershipKnown: true,
    expiresAt: Number(vip.expiresAt) || 0,
    vipCheckedAt: Date.now(),
    vipProbeAvailable: true,
    vipSource: source || vip.vipSource || 'qq-vip-probe',
  }, true);
}

async function fetchQQVipStatus(cookieObj, opts) {
  opts = opts || {};
  cookieObj = cookieObj || qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return null;

  const cacheKey = qqVipSessionCacheKey(uin, musicKey, cookieObj);
  const cached = cacheKey ? qqVipInfoCache.get(cacheKey) : null;
  if (!opts.force && cached && Date.now() < cached.expiresAt) return cached.value;

  const comm = { uin, format: 'json', ct: 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const probes = [
    {
      source: 'qq-vip-query-v2-list',
      responseKey: 'req_1',
      uin: String(uin),
      body: {
        comm,
        req_1: {
          module: 'userInfo.VipQueryServer',
          method: 'SRFVipQuery_V2',
          param: { uin_list: [String(uin)] },
        },
      },
    },
    {
      source: 'qq-vip-query-v1-list',
      responseKey: 'req_1',
      uin: String(uin),
      body: {
        comm,
        req_1: {
          module: 'userInfo.VipQueryServer',
          method: 'SRFVipQuery',
          param: { uin_list: [String(uin)] },
        },
      },
    },
    {
      source: 'qq-vip-query-v2-single',
      responseKey: 'vip',
      uin: String(uin),
      body: {
        comm,
        vip: {
          module: 'userInfo.VipQueryServer',
          method: 'SRFVipQuery_V2',
          param: { uin: String(uin), uin_list: [String(uin)] },
        },
      },
    },
  ];
  const value = await resolveQQVipFromProbes(probes, probe => {
    return qqMusicRequest(probe.body, { cookie: true, timeoutMs: 4200 });
  });
  if (value && value.resolved) {
    const ttlMs = qqVipCacheTtlMs(value, {
      positiveTtlMs: QQ_VIP_INFO_CACHE_TTL_MS,
      negativeTtlMs: 30 * 1000,
    });
    if (cacheKey && ttlMs > 0) {
      qqVipInfoCache.set(cacheKey, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
    }
    return value;
  }
  if (opts.force && value && value.errorCount) {
    console.warn('[QQLogin] VIP probe incomplete:', value.errorCount + '/' + probes.length);
  }
  return null;
}

function normalizeQQProfile(body, cookieObj) {
  cookieObj = cookieObj || qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const data = (body && (body.data || body.profile || body.creator || body.result)) || {};
  const creator = (data.creator || data.user || data.profile || data) || {};
  const vipInfo = data.vipInfo || data.vipinfo || data.vip || creator.vipInfo || creator.vipinfo || {};
  const profileNick = decodeQQCookieValue(creator.nick || creator.nickname || creator.name || creator.hostname || creator.title || '');
  const profileAvatar = creator.headpic || creator.avatar || creator.avatarUrl || creator.logo || '';
  const cookieNick = qqCookieNickname(cookieObj, uin);
  const nick = profileNick || cookieNick || '';
  const avatar = profileAvatar || qqCookieAvatar(cookieObj, uin);
  // Cookie labels may survive a downgrade. Only current profile fields or an
  // account-scoped entitlement probe are accepted as membership evidence.
  const profileVip = normalizeQQVipPayload({ data, creator, vipInfo }, {});
  return {
    provider: 'qq',
    loggedIn: !!(uin && qqCookieMusicKey(cookieObj)),
    preview: false,
    userId: uin,
    nickname: nick || (uin ? ('QQ ' + uin) : 'QQ 音乐'),
    avatar,
    vipType: profileVip.vipType || 0,
    svipType: profileVip.svipType || 0,
    vipLevel: profileVip.vipLevel || 'none',
    isVip: !!profileVip.isVip,
    isSvip: !!profileVip.isSvip,
    vipLabel: profileVip.vipLabel || '无VIP',
    membershipKnown: !!profileVip.membershipKnown,
    expiresAt: Number(profileVip.expiresAt) || 0,
    hasCookie: !!qqCookie,
    playbackKeyReady: !!qqCookiePlaybackKey(cookieObj),
    profileSource: profileNick || profileAvatar ? 'qq-profile' : (cookieNick || avatar ? 'cookie' : 'fallback'),
    vipSource: profileVip.resolved ? 'qq-profile-vip' : 'profile',
  };
}

function qqProfileAuthInvalid(value) {
  if (!value) return false;
  const payload = value && value.body && typeof value.body === 'object' ? value.body : value;
  const statusCode = Number(value && value.statusCode);
  if (statusCode === 401 || statusCode === 403) return true;
  if (payload && typeof payload === 'object' && (
    Number(payload.code) === 1000 ||
    Number(payload.result) === 301 ||
    Number(payload.code) === 401 ||
    Number(payload.code) === 403
  )) return true;
  const text = [
    value && value.message,
    payload && payload.message,
    payload && payload.msg,
  ].filter(Boolean).join(' ');
  return /(?:token|cookie|login|auth|登录|会话).{0,24}(?:expired|invalid|失效|过期|未登录|重新登录|无效|校验失败)/i.test(text)
    || /(?:expired|invalid|失效|过期|未登录|重新登录|无效).{0,24}(?:token|cookie|login|auth|登录|会话)/i.test(text);
}

function expiredQQLoginInfo() {
  return withQQVipSyncState({
    provider: 'qq',
    loggedIn: false,
    preview: false,
    userId: '',
    nickname: 'QQ 音乐',
    avatar: '',
    vipType: 0,
    svipType: 0,
    vipLevel: 'none',
    isVip: false,
    isSvip: false,
    vipLabel: '无VIP',
    membershipKnown: false,
    hasCookie: !!qqCookie,
    playbackKeyReady: false,
    authExpired: true,
    reauthRequired: true,
    stale: true,
    error: 'LOGIN_EXPIRED',
  }, false);
}

async function getQQLoginInfo(options) {
  options = options || {};
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return { provider: 'qq', loggedIn: false, hasCookie: !!qqCookie };
  const fallback = normalizeQQProfile(null, cookieObj);
  const vipProbePromise = fetchQQVipStatus(cookieObj, { force: !!options.forceVip }).catch(e => {
    if (options.forceVip) console.warn('[QQLogin] VIP probe skipped:', e.message);
    return null;
  });
  try {
    const u = new URL('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
    u.searchParams.set('cid', '205360838');
    u.searchParams.set('userid', uin);
    u.searchParams.set('reqfrom', '1');
    u.searchParams.set('g_tk', '5381');
    u.searchParams.set('loginUin', uin);
    u.searchParams.set('hostUin', '0');
    u.searchParams.set('format', 'json');
    u.searchParams.set('inCharset', 'utf8');
    u.searchParams.set('outCharset', 'utf-8');
    u.searchParams.set('notice', '0');
    u.searchParams.set('platform', 'yqq.json');
    u.searchParams.set('needNewCode', '0');
    const text = await requestText(u.toString(), {
      headers: { ...QQ_HEADERS, Cookie: qqCookie },
      timeoutMs: options.forceVip ? 6500 : 10000,
    });
    const body = parseJSONText(text);
    const vipProbe = await vipProbePromise;
    if (qqProfileAuthInvalid(body)) return expiredQQLoginInfo();
    const info = normalizeQQProfile(body, cookieObj);
    return mergeQQVipStatus(info, vipProbe, vipProbe && vipProbe.vipSource);
  } catch (e) {
    console.warn('[QQLogin] profile check failed:', e.message);
    const vipProbe = await vipProbePromise;
    if (qqProfileAuthInvalid(e)) return expiredQQLoginInfo();
    return mergeQQVipStatus({
      ...fallback,
      profileUnavailable: true,
      unavailable: true,
      loginCheckFailed: true,
    }, vipProbe, vipProbe && vipProbe.vipSource);
  }
}

async function qqGetJSON(targetUrl, params, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null) u.searchParams.set(k, String(params[k]));
  });
  const headers = { ...QQ_HEADERS, ...(opts.headers || {}) };
  if (opts.cookie !== false && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(u.toString(), { headers });
  return parseJSONText(text);
}

function audioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes('qq.com') || host.includes('qpic.cn')) headers.Referer = 'https://y.qq.com/';
    if (host.includes('qishui.com') || host.includes('byteimg.com') || host.includes('douyin') || host.includes('bytecdn')) {
      headers.Referer = 'https://www.qishui.com/';
    }
  } catch (e) {}
  if (range) headers.Range = range;
  return headers;
}

function mapQQPlaylist(pl, kind) {
  pl = pl || {};
  const id = pl.dissid || pl.tid || pl.dirid || pl.id || pl.diss_id;
  return {
    provider: 'qq',
    source: 'qq',
    id: id ? String(id) : '',
    name: pl.diss_name || pl.name || pl.title || '',
    cover: pl.diss_cover || pl.logo || pl.picurl || pl.cover || '',
    trackCount: pl.song_cnt || pl.songnum || pl.total_song_num || pl.song_count || 0,
    playCount: pl.listen_num || pl.visitnum || pl.play_count || 0,
    creator: pl.hostname || pl.nick || pl.creator || 'QQ 音乐',
    subscribed: kind === 'collect',
    specialType: 0,
  };
}

function mapQQPlaylistTrack(raw) {
  raw = raw || {};
  const track = raw.songid || raw.songmid || raw.mid || raw.name ? raw : (raw.track_info || raw.songInfo || raw.songinfo || raw.song || {});
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || track.singers || []);
  const mid = track.mid || track.songmid || raw.mid || raw.songmid || '';
  const albumMid = album.mid || track.albummid || raw.albummid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid || String(track.id || track.songid || raw.id || raw.songid || ''),
    qqId: track.id || track.songid || raw.id || raw.songid || '',
    mid,
    songmid: mid,
    mediaMid: (track.file && track.file.media_mid) || track.strMediaMid || track.media_mid || raw.strMediaMid || '',
    name: track.name || track.songname || raw.songname || '',
    artist: artists.map(a => a.name).join(' / ') || track.singername || raw.singername || '',
    artists,
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || track.albumname || raw.albumname || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300),
    duration: (Number(track.interval || raw.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function handleQQUserPlaylists() {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', playlists: [] };
  const uin = info.userId;
  const createdReq = qqGetJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss', {
    hostUin: 0,
    hostuin: uin,
    sin: 0,
    size: 200,
    g_tk: 5381,
    loginUin: uin,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const collectReq = qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
    ct: 20,
    cid: 205360956,
    userid: uin,
    reqtype: 3,
    sin: 0,
    ein: 80,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const [createdRaw, collectRaw] = await Promise.allSettled([createdReq, collectReq]);
  const created = createdRaw.status === 'fulfilled' && createdRaw.value && createdRaw.value.data && Array.isArray(createdRaw.value.data.disslist)
    ? createdRaw.value.data.disslist.map(pl => mapQQPlaylist(pl, 'created')) : [];
  const collected = collectRaw.status === 'fulfilled' && collectRaw.value && collectRaw.value.data && Array.isArray(collectRaw.value.data.cdlist)
    ? collectRaw.value.data.cdlist.map(pl => mapQQPlaylist(pl, 'collect')) : [];
  const seen = new Set();
  const playlists = created.concat(collected).filter(pl => {
    if (!pl.id || !pl.name || seen.has(pl.id)) return false;
    if (isQzoneBackgroundPlaylist(pl)) return false;
    seen.add(pl.id);
    return true;
  }).sort((a, b) => Number(isQQFavoritePlaylist(b)) - Number(isQQFavoritePlaylist(a)));
  return { loggedIn: true, provider: 'qq', userId: uin, playlists };
}

async function handleQQPlaylistTracks(id) {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', tracks: [] };
  const pid = String(id || '').trim();
  if (!pid) return { loggedIn: true, provider: 'qq', error: 'Missing QQ playlist id', tracks: [] };
  const result = await qqGetJSON('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
    type: 1,
    utf8: 1,
    disstid: pid,
    loginUin: info.userId,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/n/yqq/playlist' } });
  const detail = result && result.cdlist && result.cdlist[0] ? result.cdlist[0] : {};
  const rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
  const tracks = rawTracks.map(mapQQPlaylistTrack).filter(s => s.name && (s.mid || s.id));
  const playlist = {
    provider: 'qq',
    id: pid,
    name: detail.dissname || detail.diss_name || detail.name || '',
    cover: detail.logo || detail.diss_cover || '',
    trackCount: tracks.length,
  };
  return { loggedIn: true, provider: 'qq', playlist, tracks };
}

function qqAlbumCover(albumMid, size) {
  if (!albumMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
}

function qqSingerAvatar(singerMid, size) {
  if (!singerMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T001R' + px + 'x' + px + 'M000' + singerMid + '.jpg?max_age=2592000';
}

function mapQQArtists(raw) {
  return (raw || [])
    .map(a => ({
      id: a && a.id,
      mid: a && a.mid,
      name: (a && (a.name || a.title)) || '',
    }))
    .filter(a => a.name);
}

function mapQQSmartSong(item) {
  item = item || {};
  const mid = item.mid || item.songmid || item.id || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: item.id || item.docid || '',
    mid,
    songmid: mid,
    name: item.name || item.title || '',
    artist: item.singer || '',
    artists: item.singer ? [{ name: item.singer }] : [],
    album: '',
    cover: '',
    duration: 0,
    fee: 0,
    playable: false,
  };
}

function mapQQTrack(track, fallback) {
  track = track || {};
  fallback = fallback || {};
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || []);
  const mid = track.mid || fallback.mid || fallback.songmid || '';
  const albumMid = album.mid || album.pmid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: track.id || fallback.qqId || fallback.id || '',
    mid,
    songmid: mid,
    mediaMid: track.file && track.file.media_mid,
    name: track.name || track.title || fallback.name || '',
    artist: artists.map(a => a.name).join(' / ') || fallback.artist || '',
    artists: artists.length ? artists : (fallback.artists || []),
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || fallback.album || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300) || fallback.cover || '',
    duration: (Number(track.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function qqSmartboxLookup(keywords) {
  const u = new URL(QQ_SMARTBOX_URL);
  u.searchParams.set('format', 'json');
  u.searchParams.set('key', keywords);
  u.searchParams.set('g_tk', '5381');
  u.searchParams.set('loginUin', '0');
  u.searchParams.set('hostUin', '0');
  u.searchParams.set('inCharset', 'utf8');
  u.searchParams.set('outCharset', 'utf-8');
  u.searchParams.set('notice', '0');
  u.searchParams.set('platform', 'yqq.json');
  u.searchParams.set('needNewCode', '0');
  const text = await requestText(u.toString(), { headers: QQ_HEADERS });
  const json = parseJSONText(text);
  if (!json || Number(json.code || 0) !== 0) {
    const error = new Error(json && (json.message || json.msg) || 'QQ_SMARTBOX_SEARCH_FAILED');
    error.code = 'QQ_SMARTBOX_SEARCH_FAILED';
    throw error;
  }
  return json && json.data || {};
}

async function qqSmartboxSearch(keywords, limit) {
  const data = await qqSmartboxLookup(keywords);
  const items = data && data.song && data.song.itemlist;
  return (Array.isArray(items) ? items : []).slice(0, Math.max(1, Math.min(limit || 10, 50))).map(mapQQSmartSong);
}

async function qqSongDetail(mid, fallback) {
  if (!mid) return fallback;
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    songinfo: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid },
    },
  });
  const data = json && json.songinfo && json.songinfo.data;
  return mapQQTrack(data && data.track_info, fallback);
}

function normalizeArtistDetailPagination(limit, offset, defaultLimit) {
  const page = normalizePagination(limit, offset, {
    defaultLimit,
    maxLimit: 80,
  });
  return {
    limit: Math.max(10, page.limit),
    offset: page.offset,
  };
}

function firstFiniteNonNegativeCount(values, fallback) {
  for (const value of values || []) {
    if (value == null || value === '') continue;
    const count = Number(value);
    if (Number.isFinite(count) && count >= 0) return Math.trunc(count);
  }
  const fallbackCount = Number(fallback);
  return Number.isFinite(fallbackCount) && fallbackCount >= 0 ? Math.trunc(fallbackCount) : 0;
}

function resolveArtistDetailCursor(page, total, rawCount, upstreamHasMore) {
  const count = firstFiniteNonNegativeCount([rawCount], 0);
  const cursor = resolvePageCursor(page, total, count, upstreamHasMore);
  if (count > 0) return cursor;
  return {
    ...cursor,
    nextOffset: page.offset,
    more: false,
    hasMore: false,
  };
}

function emptyArtistDetailPage(page) {
  return {
    total: 0,
    offset: page.offset,
    limit: page.limit,
    nextOffset: page.offset,
    more: false,
    hasMore: false,
  };
}

async function handleQQArtistDetail(mid, limit, offset) {
  const singerMid = String(mid || '').trim();
  const page = normalizeArtistDetailPagination(limit, offset, 36);
  if (!singerMid) {
    return {
      provider: 'qq',
      error: 'MISSING_SINGER_MID',
      artist: null,
      songs: [],
      ...emptyArtistDetailPage(page),
    };
  }
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    singer: {
      module: 'music.web_singer_info_svr',
      method: 'get_singer_detail_info',
      param: { sort: 5, singermid: singerMid, sin: page.offset, num: page.limit },
    },
  }, { cookie: true });
  const block = json && json.singer;
  if (!block || Number(block.code || 0) !== 0) {
    return {
      provider: 'qq',
      error: block && (block.message || block.msg || block.code) || 'QQ_ARTIST_DETAIL_FAILED',
      artist: null,
      songs: [],
      ...emptyArtistDetailPage(page),
    };
  }
  const data = block.data || {};
  const info = data.singer_info || data.singerInfo || {};
  const rawSongs = Array.isArray(data.songlist) ? data.songlist : [];
  const rawPage = rawSongs.slice(0, page.limit);
  const songs = rawPage
    .map(raw => mapQQTrack(raw && (raw.track_info || raw.songInfo || raw.songinfo || raw.song) || raw, {}))
    .filter(song => song && song.name && (song.mid || song.id));
  const matchedSongArtist = songs[0] && (songs[0].artists || []).find(a => a && a.mid === singerMid);
  const artistMid = info.mid || singerMid;
  const artistName = info.name || info.title || (matchedSongArtist && matchedSongArtist.name) || '';
  const reportedTotal = firstFiniteNonNegativeCount([
    data.total_song,
    data.song_count,
    data.total,
    info.musicSize,
    info.songCount,
    info.song_num,
  ], rawPage.length);
  const cursor = resolveArtistDetailCursor(
    page,
    reportedTotal,
    rawPage.length,
    data.more === true || data.hasMore === true || data.has_more === true || Number(data.has_more) === 1,
  );
  return {
    provider: 'qq',
    artist: {
      provider: 'qq',
      id: info.id || '',
      mid: artistMid,
      name: artistName,
      avatar: info.pic || info.avatar || qqSingerAvatar(artistMid, 300),
      fans: firstFiniteNonNegativeCount([info.fans], 0),
      musicSize: cursor.total,
      albumSize: firstFiniteNonNegativeCount([data.total_album], 0),
      mvSize: firstFiniteNonNegativeCount([data.total_mv], 0),
    },
    total: cursor.total,
    offset: page.offset,
    limit: page.limit,
    nextOffset: cursor.nextOffset,
    more: cursor.more,
    hasMore: cursor.hasMore,
    songs,
  };
}

async function handleQQSearch(keywords, limit, offset) {
  const kw = String(keywords || '').trim();
  const pageOffset = Math.max(0, Number(offset || 0) || 0);
  if (!kw) return { songs: [], total: 0, offset: pageOffset, limit, hasMore: false, pagination: 'local' };
  console.log('[QQSearch]', kw, 'limit:', limit, 'offset:', pageOffset);
  const base = await qqSmartboxSearch(kw, 50);
  const page = base.slice(pageOffset, pageOffset + limit);
  const detailed = await Promise.all(page.map(async item => {
    try { return await qqSongDetail(item.mid, item); }
    catch (e) {
      console.warn('[QQSearch] detail failed:', item.mid, e.message);
      return item;
    }
  }));
  const seen = new Set();
  const songs = detailed.filter(song => {
    const key = song && (song.mid || song.id || (song.name + '|' + song.artist));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!song.name;
  });
  return {
    songs,
    total: base.length,
    offset: pageOffset,
    limit,
    hasMore: pageOffset + page.length < base.length,
    pagination: 'local',
  };
}

function decodeQQSearchText(value) {
  return decodeHtmlEntities(decodeHtmlEntities(String(value || ''))).trim();
}

function mapQQTypedArtist(item) {
  item = item || {};
  const mid = String(item.mid || item.singermid || '').trim();
  const id = mid || String(item.id || item.singerid || item.docid || '').trim();
  const name = decodeQQSearchText(item.name || item.singer || item.singername || item.title);
  if (!id || !name) return null;
  return {
    provider: 'qq',
    source: 'qq',
    type: 'artist',
    id,
    mid,
    singerMid: mid,
    name,
    avatar: item.pic || item.avatar || qqSingerAvatar(mid, 300),
    aliases: [],
    alias: [],
    albumCount: Number(item.album_count || item.albumCount || 0) || 0,
    albumSize: Number(item.album_count || item.albumCount || 0) || 0,
    songCount: Number(item.song_count || item.songCount || 0) || 0,
    musicCount: Number(item.song_count || item.songCount || 0) || 0,
    musicSize: Number(item.song_count || item.songCount || 0) || 0,
    followed: false,
  };
}

function mapQQTypedPlaylist(item) {
  item = item || {};
  const creator = item.creator && typeof item.creator === 'object' ? item.creator : {};
  const id = String(item.dissid || item.tid || item.id || item.docid || '').trim();
  const name = decodeQQSearchText(item.dissname || item.name || item.title);
  if (!id || !name) return null;
  return {
    provider: 'qq',
    source: 'qq',
    type: 'playlist',
    id,
    name,
    cover: item.imgurl || item.diss_cover || item.logo || item.picurl || item.cover || '',
    description: decodeQQSearchText(item.introduction || item.description || item.desc),
    trackCount: Number(item.song_count || item.song_cnt || item.songnum || item.total_song_num || 0) || 0,
    playCount: Number(item.listennum || item.listen_num || item.visitnum || item.play_count || 0) || 0,
    creator: decodeQQSearchText(
      creator.name ||
      creator.nick ||
      creator.nickname ||
      item.hostname ||
      item.nick ||
      (typeof item.creator === 'string' ? item.creator : '')
    ) || 'QQ 音乐',
    creatorId: String(creator.creator_uin || creator.qq || creator.id || item.creator_uin || ''),
    creatorAvatar: creator.avatarUrl || creator.avatar || '',
    subscribed: false,
    specialType: 0,
  };
}

async function handleQQTypedSearch(keywords, type, limit, offset) {
  const searchType = String(type || '').trim().toLowerCase();
  limit = Math.max(1, Math.min(50, Number(limit) || 24));
  offset = Math.max(0, Number(offset) || 0);
  if (searchType === 'artist') {
    const data = await qqSmartboxLookup(keywords);
    const group = data && data.singer || {};
    const rawItems = Array.isArray(group.itemlist) ? group.itemlist : [];
    const pageItems = rawItems.slice(offset, offset + limit);
    const items = pageItems.map(mapQQTypedArtist).filter(Boolean);
    return {
      provider: 'qq',
      source: 'qq',
      type: searchType,
      loggedIn: !!(qqCookieUin(qqCookieObject()) && qqCookieMusicKey(qqCookieObject())),
      pagination: 'local',
      items,
      total: rawItems.length,
      rawCount: pageItems.length,
      offset,
      limit,
      nextOffset: offset + pageItems.length,
      hasMore: offset + pageItems.length < rawItems.length,
    };
  }
  if (searchType !== 'playlist') {
    return {
      provider: 'qq',
      source: 'qq',
      type: searchType,
      items: [],
      total: 0,
      rawCount: 0,
      offset,
      limit,
      nextOffset: offset,
      hasMore: false,
      error: 'SEARCH_TYPE_UNSUPPORTED',
    };
  }
  const cookieObject = qqCookieObject();
  const loggedIn = !!(qqCookieUin(cookieObject) && qqCookieMusicKey(cookieObject));
  if (!loggedIn) {
    return {
      provider: 'qq',
      source: 'qq',
      type: searchType,
      loggedIn: false,
      requiresLogin: true,
      items: [],
      total: 0,
      rawCount: 0,
      offset,
      limit,
      nextOffset: offset,
      hasMore: false,
      error: 'QQ_LOGIN_REQUIRED',
      message: '请先登录 QQ 音乐，再搜索并打开 QQ 音乐歌单。',
    };
  }
  const pageSize = 50;
  const pageNumber = Math.floor(offset / pageSize) + 1;
  const pageStart = (pageNumber - 1) * pageSize;
  const localStart = offset - pageStart;
  const rawItems = [];
  let total = 0;
  let currentPage = pageNumber;
  while (rawItems.length < localStart + limit) {
    const json = await qqGetJSON('https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist', {
      remoteplace: 'txt.yqq.playlist',
      searchid: '1',
      query: keywords,
      page_no: currentPage,
      num_per_page: pageSize,
      format: 'json',
    }, { headers: { Referer: 'https://y.qq.com/' } });
    if (!json || Number(json.code || 0) !== 0) {
      const error = new Error(json && (json.message || json.msg) || 'QQ_PLAYLIST_SEARCH_FAILED');
      error.code = 'QQ_PLAYLIST_SEARCH_FAILED';
      throw error;
    }
    const data = json && json.data || {};
    const pageItems = Array.isArray(data.list) ? data.list : [];
    total = Number(data.sum || data.display_num || total) || total;
    rawItems.push(...pageItems);
    if (!pageItems.length || pageItems.length < pageSize) break;
    if (total && pageStart + rawItems.length >= total) break;
    currentPage += 1;
  }
  const pageItems = rawItems.slice(localStart, localStart + limit);
  const items = pageItems.map(mapQQTypedPlaylist).filter(Boolean);
  const resolvedTotal = Math.max(total, offset + pageItems.length);
  return {
    provider: 'qq',
    source: 'qq',
    type: searchType,
    loggedIn: true,
    items,
    total: resolvedTotal,
    rawCount: pageItems.length,
    offset,
    limit,
    nextOffset: offset + pageItems.length,
    hasMore: offset + pageItems.length < resolvedTotal,
  };
}

const QQ_PLAYABLE_PROBE_LIMIT = 4;
const QQ_PLAYABLE_PROBE_TIMEOUT_MS = 2500;
const QQ_VKEY_TIMEOUT_MS = 6000;
const QQ_SONG_URL_TOTAL_TIMEOUT_MS = 9000;

function resolveQQStreamUrl(sip, purl) {
  const raw = String(purl || '').trim();
  if (!raw) return '';
  try {
    const target = new URL(raw, String(sip || 'https://ws.stream.qqmusic.qq.com/'));
    return target.protocol === 'https:' || target.protocol === 'http:' ? target.toString() : '';
  } catch (_) {
    return '';
  }
}

// QQ can return a purl for a high-quality file that responds with 404. Read
// only the first two bytes so playback can fall back before the renderer loads it.
function qqProbePlayable(targetUrl, options) {
  options = options || {};
  return new Promise(resolve => {
    let target;
    try { target = new URL(targetUrl); } catch (_) { resolve(false); return; }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') { resolve(false); return; }
    const transport = target.protocol === 'https:' ? https : http;
    const timeoutMs = Math.max(500, Math.min(8000, Number(options.timeoutMs) || QQ_PLAYABLE_PROBE_TIMEOUT_MS));
    const signal = options.signal;
    let request = null;
    let settled = false;
    const onAbort = () => {
      if (request) request.destroy();
      finish(false);
    };
    const finish = ok => {
      if (settled) return;
      settled = true;
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      resolve(!!ok);
    };
    if (signal && signal.aborted) { finish(false); return; }
    try {
      request = transport.get(target, {
        headers: {
          ...QQ_HEADERS,
          Range: 'bytes=0-1',
          'Accept-Encoding': 'identity',
        },
        timeout: timeoutMs,
      }, response => {
        const playable = response.statusCode === 200 || response.statusCode === 206;
        response.destroy();
        finish(playable);
      });
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      request.on('timeout', () => {
        request.destroy();
        finish(false);
      });
      request.on('error', () => finish(false));
    } catch (_) {
      if (request) request.destroy();
      finish(false);
    }
  });
}

async function selectQQPlayableInfo(infos, sip, probe, options) {
  options = options || {};
  const allInfos = Array.isArray(infos) ? infos : [];
  const candidates = allInfos
    .filter(item => item && item.purl)
    .map(info => ({ info, url: resolveQQStreamUrl(sip, info.purl) }));
  const fallback = candidates[0] || { info: allInfos[0] || null, url: '' };
  if (candidates.length < 2) return { ...fallback, verified: false };

  const checks = candidates.slice(0, QQ_PLAYABLE_PROBE_LIMIT);
  const probePlayable = typeof probe === 'function' ? probe : qqProbePlayable;
  const states = checks.map(item => item.url ? null : false);
  const controllers = checks.map(() => typeof AbortController === 'function' ? new AbortController() : null);
  const budgetMs = Math.max(50, Math.min(
    QQ_PLAYABLE_PROBE_TIMEOUT_MS,
    Number(options.timeoutMs) || QQ_PLAYABLE_PROBE_TIMEOUT_MS
  ));

  return new Promise(resolve => {
    let completed = states.filter(state => state !== null).length;
    let finished = false;
    const budgetTimer = setTimeout(() => {
      finish({ ...fallback, verified: false, timedOut: true });
    }, budgetMs);
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(budgetTimer);
      controllers.forEach(controller => {
        if (controller && !controller.signal.aborted) controller.abort();
      });
      resolve(result);
    };
    const decide = () => {
      if (finished) return;
      for (let index = 0; index < states.length; index += 1) {
        if (states[index] === null) return;
        if (states[index] === true) {
          finish({ ...checks[index], verified: true });
          return;
        }
      }
      if (completed >= states.length) finish({ ...fallback, verified: false });
    };

    checks.forEach((candidate, index) => {
      if (!candidate.url) return;
      const controller = controllers[index];
      Promise.resolve().then(() => probePlayable(candidate.url, {
        timeoutMs: budgetMs,
        signal: controller && controller.signal,
      })).then(Boolean, () => false).then(playable => {
        if (states[index] !== null) return;
        states[index] = playable;
        completed += 1;
        decide();
      });
    });
    decide();
  });
}

async function handleQQSongUrl(mid, mediaMid, qualityPreference) {
  const songmid = String(mid || '').trim();
  if (!songmid) return { provider: 'qq', url: '', error: 'MISSING_MID', message: 'Missing QQ song mid' };
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj) || '0';
  const musicKey = qqCookieMusicKey(cookieObj);
  const playbackKey = qqCookiePlaybackKey(cookieObj);
  const fileMediaMid = String(mediaMid || '').trim();
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const deadlineAt = Date.now() + QQ_SONG_URL_TOTAL_TIMEOUT_MS;
  const remainingBudgetMs = () => Math.max(50, deadlineAt - Date.now());
  const mediaIds = [];
  if (fileMediaMid) mediaIds.push(fileMediaMid);
  if (songmid && !mediaIds.includes(songmid)) mediaIds.push(songmid);
  const fileCandidates = mediaIds.flatMap(mediaId =>
    qualityCandidatesFrom(requestedQuality, QQ_QUALITY_CANDIDATE_TEMPLATES)
      .map(item => ({ ...item, mediaId, filename: item.prefix + mediaId + item.ext }))
  );
  const filenames = fileCandidates.map(item => item.filename);
  const param = {
    guid,
    songmid: filenames.length ? filenames.map(() => songmid) : [songmid],
    songtype: filenames.length ? filenames.map(() => 0) : [0],
    uin,
    loginflag: 1,
    platform: '20',
  };
  if (filenames.length) param.filename = filenames;
  const comm = { uin, format: 'json', ct: musicKey ? 19 : 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const json = await qqMusicRequest({
    comm,
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param,
    },
  }, {
    cookie: true,
    timeoutMs: Math.min(QQ_VKEY_TIMEOUT_MS, remainingBudgetMs()),
  });
  const data = json && json.req_0 && json.req_0.data;
  const infos = (data && Array.isArray(data.midurlinfo)) ? data.midurlinfo : [];
  const sip = (data && data.sip && data.sip[0]) || 'https://ws.stream.qqmusic.qq.com/';
  const selected = await selectQQPlayableInfo(infos, sip, null, {
    timeoutMs: remainingBudgetMs(),
  });
  const info = selected.info;
  const purl = info && info.purl;
  if (purl) {
    const fileMeta = fileCandidates.find(item => item.filename === info.filename) || {};
    return {
      provider: 'qq',
      url: selected.url || resolveQQStreamUrl(sip, purl),
      trial: false,
      playable: true,
      level: fileMeta.level || info.filename || '',
      quality: fileMeta.label || info.filename || '',
      filename: info.filename || '',
      requestedQuality,
    };
  }
  const restriction = classifyQQPlaybackRestriction(info, {
    hasSession: !!(uin && musicKey),
    hasPlaybackKey: !!(uin && playbackKey),
  });
  return {
    provider: 'qq',
    url: '',
    playable: false,
    error: 'QQ_URL_UNAVAILABLE',
    loggedIn: !!(uin && musicKey),
    playbackKeyReady: !!(uin && playbackKey),
    restriction,
    reason: restriction.category,
    message: restriction.message,
    qqCode: info && (info.result || info.code || info.errtype),
    rawMessage: info && (info.msg || info.tips || info.errmsg || ''),
    tried: fileCandidates.map(item => item.label + ' · ' + item.filename),
    requestedQuality,
  };
}

function mapQQComment(raw) {
  raw = raw || {};
  const user = raw.user || raw.uin || {};
  const nickname = raw.nick || raw.nickname || raw.encrypt_uin || user.nick || user.nickname || user.name || 'QQ 音乐用户';
  const avatar = raw.avatarurl || raw.avatar || user.avatarurl || user.avatar || '';
  const timeRaw = Number(raw.time || raw.commenttime || raw.createTime || 0) || 0;
  return {
    id: raw.commentid || raw.commentId || raw.id || '',
    content: raw.rootcommentcontent || raw.content || raw.comment || '',
    likedCount: Number(raw.praisenum || raw.praise_num || raw.likedCount || 0) || 0,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
    user: {
      id: raw.encrypt_uin || raw.uin || user.uin || '',
      nickname,
      avatar,
    },
  };
}

async function handleQQSongComments(id, mid, limit, offset) {
  let topid = String(id || '').replace(/\D/g, '');
  if (!topid && mid) {
    try {
      const detail = await qqSongDetail(mid, { mid });
      topid = String((detail && (detail.qqId || detail.id)) || '').replace(/\D/g, '');
    } catch (e) {
      console.warn('[QQComments] detail fallback failed:', e.message);
    }
  }
  if (!topid) return { provider: 'qq', error: 'Missing QQ song id', comments: [] };
  const page = Math.max(0, Math.floor((offset || 0) / Math.max(1, limit || 20)));
  const uin = qqCookieUin() || '0';
  const body = await qqGetJSON('https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg', {
    g_tk: '5381',
    loginUin: uin,
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
    cid: '205360772',
    reqtype: '2',
    biztype: '1',
    topid,
    cmd: '8',
    needmusiccrit: '0',
    pagenum: String(page),
    pagesize: String(limit || 20),
  }, { headers: { Referer: 'https://y.qq.com/n/ryqq/songDetail/' + encodeURIComponent(mid || topid) } });
  const hotList = body && body.hot_comment && body.hot_comment.commentlist;
  const normalList = body && body.comment && body.comment.commentlist;
  const raw = (offset === 0 && Array.isArray(hotList) && hotList.length) ? hotList : (normalList || []);
  const comments = (raw || []).map(mapQQComment).filter(c => c.content);
  const total = Number(body && body.comment && (body.comment.commenttotal || body.comment.comment_total)) || comments.length;
  return { provider: 'qq', id: topid, total, comments, hot: !!(offset === 0 && Array.isArray(hotList) && hotList.length) };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function decodeQQLyricText(text) {
  let raw = decodeHtmlEntities(String(text || '').trim());
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^\s*\[/.test(raw)) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
      if (decoded && (decoded.includes('[') || /[\u4e00-\u9fa5]/.test(decoded))) raw = decoded;
    } catch (e) {
      console.warn('[QQLyric] base64 decode failed:', e.message);
    }
  }
  return decodeHtmlEntities(raw).replace(/\r\n/g, '\n').trim();
}

function normalizeQQSongId(id) {
  const n = String(id || '').replace(/\D/g, '');
  return n ? Number(n) : 0;
}

async function handleQQLyric(mid, id) {
  const songMID = String(mid || '').trim();
  const songID = normalizeQQSongId(id);
  if (!songMID && !songID) return { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' };

  let lyricText = '';
  let transText = '';
  let qrcText = '';
  let romaText = '';
  let source = 'qq-musicu';

  try {
    const param = {};
    if (songMID) param.songMID = songMID;
    if (songID) param.songID = songID;
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param,
      },
    }, { cookie: true });
    const data = json && json.lyric && json.lyric.data;
    lyricText = decodeQQLyricText(data && data.lyric);
    transText = decodeQQLyricText(data && data.trans);
    qrcText = decodeQQLyricText(data && data.qrc);
    romaText = decodeQQLyricText(data && data.roma);
  } catch (e) {
    console.warn('[QQLyric] musicu failed:', e.message);
  }

  if (!lyricText && songMID) {
    try {
      const body = await qqGetJSON('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        songmid: songMID,
        songtype: '0',
        format: 'json',
        nobase64: '1',
        g_tk: '5381',
        loginUin: qqCookieUin() || '0',
        hostUin: '0',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
      }, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
      lyricText = decodeQQLyricText(body && body.lyric);
      transText = decodeQQLyricText(body && (body.trans || body.tlyric)) || transText;
      source = 'qq-legacy';
    } catch (e) {
      console.warn('[QQLyric] legacy failed:', e.message);
    }
  }

  return {
    provider: 'qq',
    id: songID || '',
    mid: songMID,
    lyric: lyricText,
    tlyric: transText,
    yrc: '',
    qrc: qrcText,
    roma: romaText,
    source: lyricText ? source : 'qq-empty',
  };
}

function mapPodcastRadio(r) {
  r = r || {};
  const dj = r.dj || r.djSimple || r.djUser || r.creator || {};
  const id = r.id || r.rid || r.radioId;
  return {
    id,
    rid: id,
    name: r.name || r.radioName || '',
    cover: r.picUrl || r.picURL || r.coverUrl || r.coverImgUrl || r.avatarUrl || '',
    desc: r.desc || r.description || r.rcmdText || '',
    djName: dj.nickname || r.djName || r.nickname || '',
    category: r.category || r.categoryName || '',
    programCount: r.programCount || r.programNum || r.programCnt || 0,
    subCount: r.subCount || r.subedCount || r.subscriberCount || 0,
  };
}

function mapPodcastProgram(p, fallbackRadio) {
  p = p || {};
  const mainSong = p.mainSong || p.song || p.mainTrack || {};
  const radio = p.radio || fallbackRadio || {};
  const mappedRadio = mapPodcastRadio(radio);
  const artists = mapArtists(mainSong.ar || mainSong.artists || []);
  const album = mainSong.al || mainSong.album || {};
  const dj = p.dj || radio.dj || {};
  const playableId = mainSong.id || p.mainSongId || p.songId;
  return {
    type: 'podcast',
    source: 'podcast',
    id: playableId,
    programId: p.id || p.programId,
    radioId: mappedRadio.id,
    name: p.name || mainSong.name || '',
    artist: mappedRadio.name || dj.nickname || artists.map(a => a.name).join(' / ') || mappedRadio.djName || '',
    artists,
    artistId: artists[0] && artists[0].id,
    album: mappedRadio.name || album.name || 'Podcast',
    cover: p.coverUrl || p.cover || p.blurCoverUrl || mappedRadio.cover || album.picUrl || '',
    duration: p.duration || mainSong.dt || mainSong.duration || 0,
    fee: mainSong.fee,
    djName: mappedRadio.djName || dj.nickname || '',
    radioName: mappedRadio.name || '',
    desc: p.description || p.desc || '',
    createTime: p.createTime || 0,
    serialNum: p.serialNum || p.serial || 0,
  };
}

function firstArrayFrom(obj, keys) {
  obj = obj || {};
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.list)) return value.list;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.resources)) return value.resources;
  }
  return [];
}

function mapPodcastVoice(v) {
  v = v || {};
  const raw = v.resource || v.voice || v.data || v.program || v;
  const mainSong = raw.mainSong || raw.song || raw.track || {};
  const radio = raw.radio || raw.djRadio || raw.voiceList || raw.podcast || {};
  const playableId = raw.trackId || raw.songId || raw.mainSongId || mainSong.id || raw.id;
  return {
    type: 'podcast',
    source: 'podcast',
    sourceType: 'podcast-voice',
    id: playableId,
    programId: raw.programId || raw.voiceId || raw.id,
    radioId: radio.id || radio.radioId || radio.voiceListId || raw.radioId || raw.voiceListId,
    name: raw.name || raw.songName || raw.title || mainSong.name || '',
    artist: (radio.name || radio.radioName || radio.voiceListName || raw.podcastName || raw.djName || 'Voice'),
    album: radio.name || radio.radioName || raw.podcastName || 'Podcast',
    cover: raw.coverUrl || raw.cover || raw.picUrl || raw.coverImgUrl || radio.picUrl || radio.coverUrl || '',
    duration: raw.duration || raw.durationMs || mainSong.dt || mainSong.duration || 0,
    djName: raw.djName || (radio.dj && radio.dj.nickname) || '',
    radioName: radio.name || radio.radioName || raw.podcastName || '',
    desc: raw.desc || raw.description || '',
  };
}

function mapPodcastCollectionRadio(r, key) {
  const radio = mapPodcastRadio(r);
  return {
    ...radio,
    type: 'podcast-radio',
    sourceType: 'podcast-radio',
    collectionKey: key || '',
    radioId: radio.id,
    name: radio.name,
    artist: radio.djName || radio.category || 'Podcast',
    album: radio.category || 'Podcast',
  };
}

function podcastCollectionMeta(key, items) {
  const meta = {
    collect: { key: 'collect', title: '收藏播客', sub: '你收藏的播客', itemType: 'radio' },
    created: { key: 'created', title: '创建播客', sub: '你创建的播客', itemType: 'radio' },
    liked: { key: 'liked', title: '喜欢的声音', sub: '收藏或最近喜欢的声音', itemType: 'voice' },
  }[key] || { key, title: key, sub: '', itemType: 'radio' };
  const first = (items || [])[0] || {};
  return {
    ...meta,
    count: (items || []).length,
    cover: first.cover || first.picUrl || first.coverUrl || '',
  };
}

async function fetchMyPodcastItems(key, info, limit, offset) {
  limit = Math.max(8, Math.min(60, Number(limit) || 30));
  offset = Math.max(0, Number(offset) || 0);
  if (key === 'collect') {
    const r = await dj_sublist({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['djRadios', 'djradios', 'radios', 'data']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'created') {
    const r = await user_audio({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'paid') {
    const r = await dj_paygift({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'liked') {
    let raw = [];
    try {
      const sati = await sati_resource_sub_list({ cookie: userCookie, timestamp: Date.now() });
      raw = firstArrayFrom(sati.body, ['data', 'resources', 'list']);
    } catch (e) {
      console.warn('[MyPodcastLiked] sati sub list failed:', e.message);
    }
    if (!raw.length) {
      try {
        const recent = await record_recent_voice({ limit, cookie: userCookie, timestamp: Date.now() });
        raw = firstArrayFrom(recent.body, ['data', 'list', 'resources']);
      } catch (e) {
        console.warn('[MyPodcastLiked] recent voice fallback failed:', e.message);
      }
    }
    return { itemType: 'voice', items: raw.map(mapPodcastVoice).filter(x => x.id && x.name) };
  }
  return { itemType: 'radio', items: [] };
}

// ---------- 业务: 取歌曲URL (探测试听) ----------
//   返回 { url, trial, level, br }
//   trial=true 表示这是试听片段 (freeTrialInfo 非空)
async function handleSongUrl(id, loginInfo, qualityPreference) {
  console.log('[SongUrl] id:', id, 'logged-in:', !!userCookie);
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES)
    .filter(q => !q.svip || svipReady);

  let trialFallback = null; // 兜底: 即使是试听也要能播
  let lastData = null;
  let lastError = null;

  for (const q of qualities) {
    try {
      // 优先用 v1 接口 (支持更高音质 level 字段)
      let result;
      try {
        result = await song_url_v1({ id, level: q.level, cookie: userCookie });
      } catch (e) {
        result = await song_url({ id, br: q.br, cookie: userCookie });
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      console.log('[SongUrl]', q.level, '->', url ? 'OK' : 'no url', freeTrial ? '(TRIAL)' : '');
      if (url && !freeTrial) {
        return { url, trial: false, playable: true, level: q.level, quality: q.label, br: d.br, requestedQuality };
      }
      if (url && freeTrial && !trialFallback) {
        trialFallback = {
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
        };
      }
    } catch (err) {
      lastError = err;
      console.log('[SongUrl]', q.level, 'failed:', err.message);
    }
  }
  if (trialFallback) return trialFallback;
  const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
  return {
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    requestedQuality,
  };
}

// ---------- 业务: 登录态/用户信息 ----------
function readCookieFromResponse(resp) {
  const candidates = [
    resp && resp.cookie,
    resp && resp.body && resp.body.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookies,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookieHeader(candidate);
    if (cookie) return cookie;
  }
  return '';
}
function firstPositiveNumberFrom(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}
function collectStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(key => collectStringValues(value[key], out, depth + 1));
  }
  return out;
}
function collectVipStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach(item => collectVipStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;
  Object.keys(value).forEach(key => {
    const child = value[key];
    if (/vip|svip|member|associator|privilege|right|level|package|label|title|type/i.test(key)) {
      collectStringValues(child, out, depth + 1);
    } else if (child && typeof child === 'object') {
      collectVipStringValues(child, out, depth + 1);
    }
  });
  return out;
}
function normalizeNeteaseVip(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  extra = extra || {};
  const vipInfo = profile.vipInfo || profile.vipinfo || account.vipInfo || account.vipinfo || extra.vipInfo || extra.vipinfo || {};
  const objects = [account, profile, vipInfo, extra];
  const vipType = firstPositiveNumberFrom([profile, account, vipInfo], [
    'vipType', 'vip_type', 'viptype',
  ]);
  const text = collectVipStringValues({ account, profile, vipInfo, extra }, [], 0).join(' ').toLowerCase();
  const svipFlag = objects.some(obj => obj && (
    obj.isSvip === true || obj.is_svip === true || obj.svip === true ||
    Number(obj.isSvip || obj.is_svip || obj.svip || obj.svipType || obj.svip_type || 0) > 0
  )) || /svip|supervip|super_vip|blackvip|black_vip|黑胶svip|超级会员/.test(text);
  const vipFlag = objects.some(obj => obj && (
    obj.isVip === true || obj.is_vip === true || obj.vip === true ||
    Number(obj.isVip || obj.is_vip || obj.vip || obj.vipFlag || obj.vipflag || 0) > 0
  )) || /vip|黑胶|会员/.test(text);
  const isSvip = svipFlag || vipType >= 10;
  const isVip = isSvip || vipFlag || vipType > 0;
  const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
  return {
    vipType,
    vipLevel,
    isVip,
    isSvip,
    vipLabel: vipLevel === 'svip' ? 'SVIP' : (vipLevel === 'vip' ? 'VIP' : '无VIP'),
  };
}
function normalizeLoginInfo(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  const userId = profile.userId || profile.user_id || profile.id || account.userId || account.id || '';
  if (!(userId || userId === 0)) return { loggedIn: false };
  const vip = normalizeNeteaseVip(profile, account, extra);
  return {
    loggedIn: true,
    userId,
    nickname: profile.nickname || profile.userName || '网易云用户',
    avatar: profile.avatarUrl || profile.avatar || '',
    ...vip,
  };
}
function isNeteaseAuthInvalidPayload(payload) {
  const code = normalizeApiCode(payload);
  if (code === 301 || code === 401) return true;
  const msg = normalizeApiMessage(payload);
  return /未登录|需要登录|请先登录|login/i.test(msg) && code >= 300;
}
function neteaseRouteFailure(err, fallbackError) {
  const code = normalizeApiCode(err);
  const loggedIn = !isNeteaseAuthInvalidPayload(err);
  if (!loggedIn) saveCookie('');
  return {
    status: loggedIn ? 500 : 401,
    body: {
      ok: false,
      loggedIn,
      error: normalizeApiMessage(err) || (err && err.message) || fallbackError,
      code: code || 0,
    },
  };
}
function createApiRouteError(error, status, message, extras) {
  const err = new Error(message || error);
  err.apiRouteError = error;
  err.httpStatus = status || 500;
  err.responseExtras = extras || {};
  return err;
}
function sendNeteaseApiFailure(res, err, fallbackError, responseExtras, protectedRoute) {
  const extras = { ...(responseExtras || {}) };
  if (err && err.apiRouteError) {
    sendJSON(res, {
      ...extras,
      ...(err.responseExtras || {}),
      ok: false,
      error: err.apiRouteError,
      message: err.message || err.apiRouteError,
    }, err.httpStatus || 500);
    return;
  }
  const code = normalizeApiCode(err);
  const authExpired = isNeteaseAuthInvalidPayload(err);
  if (authExpired) saveCookie('');
  const status = authExpired && protectedRoute ? 401 : (code === 404 ? 404 : 502);
  sendJSON(res, {
    ...extras,
    ok: false,
    loggedIn: protectedRoute ? !authExpired : null,
    authExpired: !!authExpired,
    requiresLogin: !!protectedRoute,
    error: authExpired && protectedRoute ? 'LOGIN_EXPIRED' : fallbackError,
    code: code || 0,
    message: normalizeApiMessage(err) || (err && err.message) || fallbackError,
  }, status);
}
function throwOnNeteaseApiFailure(result, fallbackError) {
  const body = result && (result.body || result) || {};
  let failed = body;
  let code = normalizeApiCode(result);
  if (code >= 200 && code < 300) {
    failed = Object.keys(body)
      .filter(key => key.startsWith('/api/'))
      .map(key => body[key])
      .find(value => {
        const nestedCode = normalizeApiCode(value);
        return nestedCode && (nestedCode < 200 || nestedCode >= 300);
      });
    if (!failed) return body;
    code = normalizeApiCode(failed);
  } else if (!code) {
    failed = body;
  }
  const err = new Error(normalizeApiMessage(failed) || normalizeApiMessage(result) || fallbackError);
  err.status = code || 502;
  err.body = failed || body;
  throw err;
}
async function callPublicNetease(call) {
  const hadCookie = !!userCookie;
  let authExpired = false;
  let result;
  try {
    result = await call(userCookie);
  } catch (err) {
    if (!hadCookie || !isNeteaseAuthInvalidPayload(err)) throw err;
    saveCookie('');
    authExpired = true;
    result = await call('');
  }
  if (hadCookie && isNeteaseAuthInvalidPayload(result)) {
    saveCookie('');
    authExpired = true;
    result = await call('');
  }
  return { result, authExpired };
}

const NETEASE_PLAYLIST_MANIFEST_TTL_MS = 45 * 1000;
const NETEASE_PLAYLIST_MANIFEST_CACHE_MAX = 32;
const neteasePlaylistManifestCache = new Map();

function neteasePlaylistManifestCacheKey(id) {
  const sessionKey = crypto.createHash('sha256').update(String(userCookie || 'public')).digest('hex').slice(0, 16);
  return `${id}|${sessionKey}`;
}

function invalidateNeteasePlaylistManifest(id) {
  const prefix = `${String(id || '')}|`;
  for (const key of neteasePlaylistManifestCache.keys()) {
    if (key.startsWith(prefix)) neteasePlaylistManifestCache.delete(key);
  }
}

async function loadNeteasePlaylistManifest(id) {
  const cacheKey = neteasePlaylistManifestCacheKey(id);
  const cached = neteasePlaylistManifestCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { playlist: cached.playlist, authExpired: false };
  }
  if (cached) neteasePlaylistManifestCache.delete(cacheKey);

  const detailRequest = await callPublicNetease(cookie => playlist_detail({
    id,
    s: 0,
    cookie,
    timestamp: Date.now(),
  }));
  const detailBody = throwOnNeteaseApiFailure(detailRequest.result, 'PLAYLIST_DETAIL_FAILED');
  const playlist = detailBody.playlist;
  if (playlist && normalizeNeteaseId(playlist.id)) {
    const currentKey = neteasePlaylistManifestCacheKey(id);
    neteasePlaylistManifestCache.set(currentKey, {
      playlist,
      expiresAt: Date.now() + NETEASE_PLAYLIST_MANIFEST_TTL_MS,
    });
    while (neteasePlaylistManifestCache.size > NETEASE_PLAYLIST_MANIFEST_CACHE_MAX) {
      neteasePlaylistManifestCache.delete(neteasePlaylistManifestCache.keys().next().value);
    }
  }
  return { playlist, authExpired: detailRequest.authExpired };
}
function normalizeNeteaseIds(value, max) {
  let raw = value;
  if (typeof raw === 'string' && /^\s*\[/.test(raw)) {
    try { raw = JSON.parse(raw); } catch (_) {}
  }
  const values = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',');
  const ids = values.map(normalizeNeteaseId).filter(Boolean);
  if (!ids.length || ids.length !== values.length || ids.length > (max || 500) || new Set(ids).size !== ids.length) return null;
  return ids;
}
function escapeNeteaseBatchString(value) {
  return JSON.stringify(String(value == null ? '' : value)).slice(1, -1);
}
async function getPlaylistForPolicy(pid) {
  let detail;
  try {
    detail = await playlist_detail({ id: pid, s: 0, cookie: userCookie, timestamp: Date.now() });
  } catch (err) {
    if (normalizeApiCode(err) === 404) throw createApiRouteError('PLAYLIST_NOT_FOUND', 404, '歌单不存在');
    throw err;
  }
  const code = normalizeApiCode(detail);
  if (code === 404) throw createApiRouteError('PLAYLIST_NOT_FOUND', 404, '歌单不存在');
  throwOnNeteaseApiFailure(detail, 'PLAYLIST_DETAIL_FAILED');
  const body = detail.body || detail || {};
  const playlist = body.playlist;
  if (!playlist || !normalizeNeteaseId(playlist.id)) {
    throw createApiRouteError('PLAYLIST_NOT_FOUND', 404, '歌单不存在');
  }
  return playlist;
}
async function getOwnedPlaylist(pid, userId) {
  const playlist = await getPlaylistForPolicy(pid);
  const editRestriction = getPlaylistEditRestriction(playlist, userId);
  if (editRestriction === 'PLAYLIST_NOT_OWNED') {
    throw createApiRouteError('PLAYLIST_NOT_OWNED', 403, '只能修改自己创建的歌单', { loggedIn: true, pid });
  }
  if (editRestriction === 'PLAYLIST_SPECIAL_READ_ONLY') {
    throw createApiRouteError('PLAYLIST_SPECIAL_READ_ONLY', 403, '系统特殊歌单不能通过歌单管理功能修改', { loggedIn: true, pid });
  }
  return playlist;
}
async function getSubscribablePlaylist(pid, userId) {
  const playlist = await getPlaylistForPolicy(pid);
  const restriction = getPlaylistSubscriptionRestriction(playlist, userId);
  if (restriction === 'PLAYLIST_OWNED') {
    throw createApiRouteError('PLAYLIST_OWNED', 409, '不能订阅自己创建的歌单', { loggedIn: true, pid });
  }
  if (restriction === 'PLAYLIST_NOT_PUBLIC') {
    throw createApiRouteError('PLAYLIST_NOT_PUBLIC', 403, '只能订阅公开歌单', { loggedIn: true, pid });
  }
  if (restriction) {
    throw createApiRouteError(restriction, 404, '歌单不存在', { loggedIn: true, pid });
  }
  return playlist;
}
async function getLoginInfo() {
  if (!userCookie) return { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };

  let completedChecks = 0;
  let lastError = null;
  let authInvalid = false;

  // login_status 对二维码 cookie 的资料刷新通常更及时；失败时再降级到 user_account。
  try {
    const st = await login_status({ cookie: userCookie, timestamp: Date.now() });
    completedChecks++;
    const body = st.body || {};
    const data = body.data || body;
    const info = normalizeLoginInfo(data.profile || body.profile, data.account || body.account, data);
    if (info.loggedIn) return info;
    authInvalid = isNeteaseAuthInvalidPayload(st);
  } catch (e) {
    console.warn('[Login] login_status failed:', e.message);
    if (isNeteaseAuthInvalidPayload(e)) authInvalid = true;
    else lastError = e;
  }

  if (authInvalid) {
    saveCookie('');
    return { loggedIn: false, authExpired: true, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  }

  try {
    const acc = await user_account({ cookie: userCookie, timestamp: Date.now() });
    completedChecks++;
    const body = acc.body || {};
    const info = normalizeLoginInfo(body.profile, body.account, body);
    if (info.loggedIn) return info;
    if (isNeteaseAuthInvalidPayload(acc)) authInvalid = true;
  } catch (e) {
    console.warn('[Login] account check failed:', e.message);
    if (isNeteaseAuthInvalidPayload(e)) authInvalid = true;
    else lastError = e;
  }

  if (authInvalid) {
    saveCookie('');
    return { loggedIn: false, authExpired: true, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  }
  if (completedChecks > 0) {
    return {
      loggedIn: true,
      partial: true,
      pendingProfile: true,
      profileUnavailable: true,
      hasCookie: true,
      userId: '',
      nickname: '网易云用户',
      avatar: '',
      vipType: 0,
      vipLevel: 'none',
      isVip: false,
      isSvip: false,
      vipLabel: '无VIP',
    };
  }
  return {
    loggedIn: false,
    hasCookie: true,
    loginCheckFailed: true,
    error: normalizeApiMessage(lastError) || (lastError && lastError.message) || 'LOGIN_STATUS_UNAVAILABLE',
    vipType: 0,
    vipLevel: 'none',
    isVip: false,
    isSvip: false,
    vipLabel: '无VIP',
  };
}

// ====================================================================
//  HTTP Server
// ====================================================================
const providerRoutes = createProviderRoutes({
  userDataDir: path.dirname(COOKIE_FILE),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;
  if (pn.startsWith('/api/')) {
    if (!isTrustedApiRequest(req)) {
      sendJSON(res, { ok: false, error: 'UNTRUSTED_API_REQUEST' }, 403);
      return;
    }
    if (!guardApiMutation(req, res, pn)) return;
    if (await providerRoutes.handle(req, res, url)) return;
  }

  if (pn === '/api/app/version') {
    sendJSON(res, {
      name: APP_PACKAGE.name || 'mineradio',
      productName: APP_PACKAGE.productName || 'Mineradio',
      version: APP_VERSION,
      update: {
        provider: UPDATE_CONFIG.provider,
        configured: UPDATE_CONFIG.configured,
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        preview: UPDATE_CONFIG.preview,
        manifestOverride: !!UPDATE_CONFIG.manifest,
      },
    });
    return;
  }

  if (pn === '/api/update/latest') {
    try {
      sendJSON(res, await fetchLatestUpdateInfo());
    } catch (err) {
      sendJSON(res, {
        ...localUpdateFallback(err.message || 'Update check failed', { configured: UPDATE_CONFIG.configured }),
        error: err.message || 'Update check failed',
      });
    }
    return;
  }

  if (pn === '/api/update/download') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdateDownloadJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdateDownload]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/download/switch') {
    const body = await readRequestBody(req);
    const id = String(body && body.id || '').trim();
    if (!id) {
      sendJSON(res, { ok: false, error: 'UPDATE_JOB_ID_REQUIRED' }, 400);
      return;
    }
    const job = updateDownloadJobs.get(id);
    const result = requestUpdateSourceSwitch(job);
    const status = result.ok ? 200 : (result.error === 'UPDATE_JOB_NOT_FOUND' ? 404 : 409);
    sendJSON(res, result, status);
    return;
  }

  if (pn === '/api/update/download/cancel') {
    const body = await readRequestBody(req);
    const id = String(body && body.id || '').trim();
    if (!/^[a-z0-9-]{8,96}$/i.test(id)) {
      sendJSON(res, { ok: false, error: 'UPDATE_JOB_ID_INVALID' }, 400);
      return;
    }
    const job = updateDownloadJobs.get(id);
    const result = requestUpdateDownloadCancel(job);
    const status = result.ok ? 200 : (result.error === 'UPDATE_JOB_NOT_FOUND' ? 404 : 409);
    sendJSON(res, result, status);
    return;
  }

  if (pn === '/api/update/download/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/update/patch') {
    sendJSON(res, { ok: false, error: 'PATCH_UPDATES_DISABLED' }, 410);
    return;
  }

  if (pn === '/api/update/patch/status') {
    sendJSON(res, { ok: false, error: 'PATCH_UPDATES_DISABLED' }, 410);
    return;
  }

  if (pn === '/api/beatmap/cache/status') {
    const info = beatCacheRootInfo();
    sendJSON(res, {
      enabled: info.allowed && info.available,
      dir: info.dir,
      drive: info.drive,
      reason: !info.allowed ? 'INVALID_CACHE_PATH' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
      mode: info.allowed && info.available ? 'disk' : 'memory-only',
    });
    return;
  }

  if (pn === '/api/beatmap/cache') {
    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      try {
        const entry = readBeatMapCache(key);
        sendJSON(res, entry
          ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
          : { ok: true, hit: false, key });
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          hit: false,
          enabled: false,
          mode: 'memory-only',
          key,
          reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, writeBeatMapCache(body));
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          enabled: false,
          mode: 'memory-only',
          reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'DELETE') {
      if (String(req.headers['x-mineradio-request'] || '') !== '1') {
        sendJSON(res, { ok: false, error: 'UNTRUSTED_MUTATION_REQUEST' }, 403);
        return;
      }
      try {
        sendJSON(res, clearBeatMapCache());
      } catch (err) {
        sendJSON(res, {
          ok: false,
          error: err.code || err.message || 'BEAT_CACHE_CLEAR_FAILED',
        }, 500);
      }
      return;
    }

    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/shared-playlist/resolve') {
    try {
      const body = await readRequestBody(req);
      const resolved = await resolveSharedPlaylistWithTracks(body.text || body.url || body.input || '', {
        userAgent: UA,
        timeoutMs: 8000,
      });
      sendJSON(res, { ok: true, ...resolved });
    } catch (err) {
      const code = err && (err.code || err.message) || 'SHARED_PLAYLIST_RESOLVE_FAILED';
      const resolverStatus = Number(err && err.statusCode);
      const status = Number.isInteger(resolverStatus) && resolverStatus >= 400 && resolverStatus <= 599
        ? resolverStatus
        : (code === 'UNSUPPORTED_SHARED_PLAYLIST' || code === 'SHARED_PLAYLIST_ID_MISSING' ? 400 : 502);
      sendJSON(res, {
        ok: false,
        error: code,
        message: code === 'UNSUPPORTED_SHARED_PLAYLIST'
          ? '暂不支持这个分享链接'
          : (code === 'SHARED_PLAYLIST_ID_MISSING' ? '没有从分享链接中识别到歌单' : '分享链接解析失败'),
      }, status);
    }
    return;
  }

  if (pn === '/api/recommend/daily') {
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, loggedIn: null, error: 'METHOD_NOT_ALLOWED', songs: [] }, 405);
      return;
    }
    try {
      const info = await requireLogin(res, { songs: [] });
      if (!info) return;
      const result = await recommend_songs({ cookie: userCookie, timestamp: Date.now() });
      const code = normalizeApiCode(result);
      if (code && code !== 200) {
        const loggedIn = !isNeteaseAuthInvalidPayload(result);
        sendJSON(res, {
          ok: false,
          loggedIn,
          error: normalizeApiMessage(result) || 'DAILY_RECOMMENDATIONS_FAILED',
          code,
          songs: [],
        }, loggedIn ? 502 : 401);
        return;
      }
      const body = result.body || {};
      const raw = body.data && (body.data.dailySongs || body.data.recommend) || body.recommend || [];
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        songs: mapNeteaseSongs(raw),
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('[DailyRecommendations]', err);
      const failure = neteaseRouteFailure(err, 'DAILY_RECOMMENDATIONS_FAILED');
      sendJSON(res, { ...failure.body, songs: [] }, failure.status);
    }
    return;
  }

  if (pn === '/api/personal-fm') {
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, loggedIn: null, error: 'METHOD_NOT_ALLOWED', songs: [] }, 405);
      return;
    }
    try {
      const info = await requireLogin(res, { songs: [] });
      if (!info) return;
      const result = await personal_fm({ cookie: userCookie, timestamp: Date.now() });
      const code = normalizeApiCode(result);
      if (code && code !== 200) {
        const loggedIn = !isNeteaseAuthInvalidPayload(result);
        sendJSON(res, {
          ok: false,
          loggedIn,
          error: normalizeApiMessage(result) || 'PERSONAL_FM_FAILED',
          code,
          songs: [],
        }, loggedIn ? 502 : 401);
        return;
      }
      const body = result.body || {};
      const raw = body.data || body.songs || [];
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        songs: mapNeteaseSongs(raw),
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('[PersonalFM]', err);
      const failure = neteaseRouteFailure(err, 'PERSONAL_FM_FAILED');
      sendJSON(res, { ...failure.body, songs: [] }, failure.status);
    }
    return;
  }

  if (pn === '/api/personal-fm/trash') {
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, loggedIn: null, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const id = String(body.id || '').trim();
      const parsedTime = Number(body.time);
      const time = Number.isFinite(parsedTime) && parsedTime > 0 ? Math.round(parsedTime) : 25;
      if (!id) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'MISSING_SONG_ID' }, 400);
        return;
      }
      const result = await fm_trash({ id, time, cookie: userCookie, timestamp: Date.now() });
      const code = normalizeApiCode(result);
      if (code && code !== 200) {
        const loggedIn = !isNeteaseAuthInvalidPayload(result);
        sendJSON(res, {
          ok: false,
          loggedIn,
          error: normalizeApiMessage(result) || 'PERSONAL_FM_TRASH_FAILED',
          code,
          id,
        }, loggedIn ? 502 : 401);
        return;
      }
      sendJSON(res, { ok: true, loggedIn: true, error: '', id, time, code: code || 200 });
    } catch (err) {
      console.error('[PersonalFMTrash]', err);
      const failure = neteaseRouteFailure(err, 'PERSONAL_FM_TRASH_FAILED');
      sendJSON(res, failure.body, failure.status);
    }
    return;
  }

  if (pn === '/api/discover/home') {
    try {
      sendJSON(res, await handleDiscoverHome());
    } catch (err) {
      console.error('[DiscoverHome]', err);
      sendJSON(res, { error: err.message, loggedIn: false, dailySongs: [], playlists: [], podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/discover/netease') {
    const section = String(url.searchParams.get('section') || '').trim().toLowerCase();
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, section, error: 'METHOD_NOT_ALLOWED', items: [] }, 405);
      return;
    }
    if (!NETEASE_DISCOVER_SECTIONS.has(section)) {
      sendJSON(res, {
        ok: false,
        section,
        error: 'INVALID_DISCOVER_SECTION',
        supportedSections: Array.from(NETEASE_DISCOVER_SECTIONS),
        items: [],
        empty: true,
      }, 400);
      return;
    }
    const protectedSection = NETEASE_PROTECTED_DISCOVER_SECTIONS.has(section);
    const emptyResponse = emptyNeteaseDiscoverResponse(
      section,
      url.searchParams.get('limit'),
      url.searchParams.get('offset'),
    );
    try {
      let loginInfo = null;
      if (protectedSection) {
        loginInfo = await requireLogin(res, { ...emptyResponse, requiresLogin: true });
        if (!loginInfo) return;
      }
      const result = await handleNeteaseDiscover(section, {
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
        area: url.searchParams.get('area'),
        cat: url.searchParams.get('cat'),
        order: url.searchParams.get('order'),
        period: url.searchParams.get('period'),
        recordType: url.searchParams.get('type'),
        loginInfo,
      });
      sendJSON(res, result);
    } catch (err) {
      console.error('[NeteaseDiscover:' + section + ']', err);
      sendNeteaseApiFailure(res, err, 'NETEASE_DISCOVER_FAILED', emptyResponse, protectedSection);
    }
    return;
  }

  if (pn === '/api/weather/radio') {
    try {
      const data = await buildWeatherRadio({
        city: url.searchParams.get('city') || url.searchParams.get('q') || '',
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        timezone: url.searchParams.get('timezone') || '',
      });
      sendJSON(res, data);
    } catch (err) {
      console.error('[WeatherRadio]', err);
      sendJSON(res, {
        ok: false,
        error: err.message,
        weather: null,
        radio: { title: '天气电台', subtitle: '天气暂时没有回来，可以先听今日推荐。', seedQueries: [], songs: [] },
      }, 500);
    }
    return;
  }

  if (pn === '/api/weather/ip-location') {
    try {
      sendJSON(res, { ok: true, location: await fetchIpWeatherLocation() });
    } catch (err) {
      console.error('[WeatherIpLocation]', err);
      sendJSON(res, { ok: false, error: err.message, location: null }, 500);
    }
    return;
  }

  // ---------- 搜索 ----------
  if (pn === '/api/search') {
    const keywords = String(url.searchParams.get('keywords') || '').trim().slice(0, 120);
    const page = normalizePagination(url.searchParams.get('limit'), url.searchParams.get('offset'), {
      defaultLimit: 20,
      maxLimit: 50,
    });
    const emptyResponse = {
      type: 'song',
      keywords,
      ...page,
      total: 0,
      nextOffset: page.offset,
      more: false,
      hasMore: false,
      empty: true,
      items: [],
      songs: [],
    };
    if (req.method !== 'GET') {
      sendJSON(res, { ...emptyResponse, ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    if (!keywords) {
      sendJSON(res, { ...emptyResponse, ok: false, error: 'MISSING_KEYWORDS' }, 400);
      return;
    }
    try {
      const result = await handleSearch(keywords, page.limit, page.offset);
      sendJSON(res, { ok: true, error: '', keywords, ...result });
    } catch (err) {
      console.error('[Search]', err);
      sendNeteaseApiFailure(res, err, 'SEARCH_FAILED', emptyResponse, false);
    }
    return;
  }

  if (pn === '/api/search/typed') {
    const keywords = String(url.searchParams.get('keywords') || '').trim().slice(0, 120);
    const type = normalizeTypedSearchType(url.searchParams.get('type'));
    const requestedProvider = url.searchParams.has('provider')
      ? url.searchParams.get('provider')
      : (url.searchParams.has('source') ? url.searchParams.get('source') : 'netease');
    const provider = normalizeTypedSearchProvider(requestedProvider);
    const page = normalizePagination(url.searchParams.get('limit'), url.searchParams.get('offset'), {
      defaultLimit: 24,
      maxLimit: 50,
    });
    const emptyResponse = {
      provider: provider || String(requestedProvider || '').trim().toLowerCase(),
      source: provider || String(requestedProvider || '').trim().toLowerCase(),
      type,
      keywords,
      ...page,
      total: 0,
      nextOffset: page.offset,
      more: false,
      hasMore: false,
      empty: true,
      items: [],
      artists: [],
      albums: [],
      playlists: [],
    };
    if (req.method !== 'GET') {
      sendJSON(res, { ...emptyResponse, ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    if (!keywords) {
      sendJSON(res, { ...emptyResponse, ok: false, error: 'MISSING_KEYWORDS' }, 400);
      return;
    }
    if (!type) {
      sendJSON(res, {
        ...emptyResponse,
        ok: false,
        error: 'INVALID_SEARCH_TYPE',
        supportedTypes: Object.keys(TYPED_SEARCH_TYPES),
      }, 400);
      return;
    }
    if (!provider) {
      sendJSON(res, {
        ...emptyResponse,
        ok: false,
        error: 'INVALID_SEARCH_PROVIDER',
        supportedProviders: Object.keys(PROVIDER_TYPED_SEARCH_TYPES),
      }, 400);
      return;
    }
    if (!PROVIDER_TYPED_SEARCH_TYPES[provider].includes(type)) {
      sendJSON(res, {
        ...emptyResponse,
        provider,
        source: provider,
        ok: false,
        error: 'SEARCH_TYPE_UNSUPPORTED',
        supportedTypes: PROVIDER_TYPED_SEARCH_TYPES[provider],
      }, 400);
      return;
    }
    try {
      if (provider === 'netease') {
        const requestResult = await callPublicNetease(cookie => cloudsearch({
          keywords,
          type: TYPED_SEARCH_TYPES[type].apiType,
          limit: page.limit,
          offset: page.offset,
          cookie,
          timestamp: Date.now(),
        }));
        const body = throwOnNeteaseApiFailure(requestResult.result, 'TYPED_SEARCH_FAILED');
        const mapped = mapTypedSearchResult(body, type);
        const cursor = resolvePageCursor(
          page,
          mapped.total,
          mapped.rawCount,
          mapped.upstreamHasMore,
        );
        sendJSON(res, {
          ...emptyResponse,
          ok: true,
          provider,
          source: provider,
          requiresLogin: false,
          loggedIn: requestResult.authExpired ? false : null,
          authExpired: requestResult.authExpired,
          error: '',
          type,
          keywords,
          ...page,
          total: cursor.total,
          nextOffset: cursor.nextOffset,
          more: cursor.more,
          hasMore: cursor.hasMore,
          empty: mapped.items.length === 0,
          items: mapped.items,
          [mapped.listKey]: mapped.items,
        });
        return;
      }

      const result = provider === 'qq'
        ? await handleQQTypedSearch(keywords, type, page.limit, page.offset)
        : await providerRoutes.searchTyped(provider, type, keywords, page.limit, page.offset);
      if (result && result.error) {
        const statusCode = typedSearchErrorStatus(result.error);
        sendJSON(res, {
          ...emptyResponse,
          ...result,
          ok: false,
          provider,
          source: provider,
          type,
          keywords,
          ...page,
          total: 0,
          nextOffset: page.offset,
          more: false,
          hasMore: false,
          empty: true,
          items: [],
          artists: [],
          albums: [],
          playlists: [],
          requiresLogin: statusCode === 401 || result.requiresLogin === true,
        }, statusCode);
        return;
      }
      const items = result && Array.isArray(result.items) ? result.items : [];
      const rawCount = Math.max(0, Number(result && result.rawCount) || items.length);
      const cursor = resolvePageCursor(
        page,
        Number(result && result.total) || 0,
        rawCount,
        result && result.hasMore,
      );
      const hasMore = result && typeof result.hasMore === 'boolean'
        ? result.hasMore
        : cursor.hasMore;
      const explicitNextOffset = Number(result && result.nextOffset);
      const nextOffset = Number.isFinite(explicitNextOffset) && explicitNextOffset >= page.offset
        ? explicitNextOffset
        : cursor.nextOffset;
      const listKey = typedSearchListKey(type);
      sendJSON(res, {
        ...emptyResponse,
        ...(result || {}),
        ok: true,
        provider,
        source: provider,
        error: '',
        type,
        keywords,
        ...page,
        total: cursor.total,
        nextOffset,
        more: hasMore,
        hasMore,
        empty: items.length === 0,
        items,
        [listKey]: items,
      });
    } catch (err) {
      console.error('[TypedSearch:' + provider + ':' + type + ']', err);
      if (provider === 'netease') {
        sendNeteaseApiFailure(res, err, 'TYPED_SEARCH_FAILED', emptyResponse, false);
        return;
      }
      const statusCode = typedSearchErrorStatus(
        err && (err.code || err.message),
        Number(err && err.statusCode) === 429 ? 429 : (Number(err && err.statusCode) === 401 ? 401 : 502),
      );
      sendJSON(res, {
        ...emptyResponse,
        ok: false,
        provider,
        source: provider,
        error: (provider + '_TYPED_SEARCH_FAILED').toUpperCase(),
        message: err && err.message || 'Typed search failed',
        requiresLogin: statusCode === 401,
      }, statusCode);
    }
    return;
  }

  if (pn === '/api/qq/search') {
    try {
      const kw = String(url.searchParams.get('keywords') || '').trim().slice(0, 120);
      const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      if (!kw) { sendJSON(res, { ok: false, provider: 'qq', error: 'MISSING_KEYWORDS', songs: [], total: 0, offset, limit, hasMore: false, pagination: 'local' }, 400); return; }
      const result = await handleQQSearch(kw, limit, offset);
      sendJSON(res, { ok: true, provider: 'qq', error: '', ...result });
    } catch (err) {
      console.error('[QQSearch]', err);
      sendJSON(res, { ok: false, provider: 'qq', error: err.message, songs: [], total: 0, hasMore: false, pagination: 'local' }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/url') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('id') || '';
      const mediaMid = url.searchParams.get('mediaMid') || url.searchParams.get('media_mid') || '';
      const quality = url.searchParams.get('quality') || '';
      const info = await handleQQSongUrl(mid, mediaMid, quality);
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQSongUrl]', err);
      sendJSON(res, { provider: 'qq', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/lyric') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      if (!mid && !id) { sendJSON(res, { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' }, 400); return; }
      const data = await handleQQLyric(mid, id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQLyric]', err);
      sendJSON(res, { provider: 'qq', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲URL ----------
  if (pn === '/api/qq/login/status') {
    try {
      const forceVip = /^(1|true|yes)$/i.test(String(
        url.searchParams.get('forceVip') || url.searchParams.get('force') || ''
      ));
      const info = await getQQLoginInfo({ forceVip });
      if (info.authExpired) saveQQCookie('');
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQLoginStatus]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeQQCookieInput(raw);
      const obj = parseCookieString(normalized);
      if (!qqCookieUin(obj) || !qqCookieMusicKey(obj)) {
        sendJSON(res, { provider: 'qq', loggedIn: false, error: 'INVALID_QQ_COOKIE', message: 'QQ cookie 缺少 uin 或有效登录票据' }, 400);
        return;
      }
      if (!saveQQCookie(normalized)) {
        sendJSON(res, {
          provider: 'qq',
          ok: false,
          loggedIn: false,
          sessionPersisted: false,
          error: 'LOGIN_SESSION_PERSIST_FAILED',
          message: 'QQ 音乐登录成功，但安全凭据无法写入本机',
        }, 503);
        return;
      }
      const info = await getQQLoginInfo({ forceVip: true });
      if (info.authExpired) {
        saveQQCookie('');
        sendJSON(res, {
          ...info,
          ok: false,
          saved: false,
          sessionPersisted: false,
          message: 'QQ 音乐登录凭据已失效，请重新扫码登录',
        }, 401);
        return;
      }
      sendJSON(res, { ...info, ok: true, saved: true, sessionPersisted: true });
    } catch (err) {
      console.error('[QQLoginCookie]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/logout') {
    const cleared = saveQQCookie('');
    sendJSON(res, {
      provider: 'qq',
      ok: cleared,
      loggedIn: cleared ? false : !!qqCookie,
      error: cleared ? '' : 'LOGIN_SESSION_CLEAR_FAILED',
    }, cleared ? 200 : 500);
    return;
  }

  if (pn === '/api/qq/user/playlists') {
    try {
      const data = await handleQQUserPlaylists();
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQUserPlaylists]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('disstid') || '';
      const data = await handleQQPlaylistTracks(id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQPlaylistTracks]', err);
      sendJSON(res, { provider: 'qq', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/artist/detail') {
    const page = normalizeArtistDetailPagination(
      url.searchParams.get('limit'),
      url.searchParams.get('offset'),
      36,
    );
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('singermid') || '';
      if (!mid) {
        sendJSON(res, {
          provider: 'qq',
          error: 'MISSING_SINGER_MID',
          artist: null,
          songs: [],
          ...emptyArtistDetailPage(page),
        }, 400);
        return;
      }
      const data = await handleQQArtistDetail(mid, page.limit, page.offset);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQArtistDetail]', err);
      sendJSON(res, {
        provider: 'qq',
        error: err.message,
        artist: null,
        songs: [],
        ...emptyArtistDetailPage(page),
      }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/comments') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const data = await handleQQSongComments(id, mid, limit, offset);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQSongComments]', err);
      sendJSON(res, { provider: 'qq', error: err.message, comments: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/search') {
    try {
      const kw = String(url.searchParams.get('keywords') || '').trim();
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      if (!kw) { sendJSON(res, { podcasts: [] }); return; }
      const r = await cloudsearch({ keywords: kw, type: 1009, limit, cookie: userCookie, timestamp: Date.now() });
      const result = (r.body && r.body.result) || {};
      const raw = result.djRadios || result.djradios || result.radios || [];
      const podcasts = raw.map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, total: result.djRadiosCount || result.djradiosCount || podcasts.length });
    } catch (err) {
      console.error('[PodcastSearch]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/hot') {
    try {
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_hot({ limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.djRadios || body.djradios || body.radios || body.data || [];
      const podcasts = (Array.isArray(raw) ? raw : []).map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, more: !!body.hasMore });
    } catch (err) {
      console.error('[PodcastHot]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/detail') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id' }, 400); return; }
      const r = await dj_detail({ rid, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const radio = mapPodcastRadio(body.data || body.djRadio || body.radio || body);
      sendJSON(res, { podcast: radio });
    } catch (err) {
      console.error('[PodcastDetail]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/programs') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id', programs: [] }, 400); return; }
      const limit = Math.max(10, Math.min(60, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_program({ rid, limit, offset, asc: false, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.programs || (body.data && (body.data.list || body.data.programs)) || [];
      const radio = raw[0] && raw[0].radio ? mapPodcastRadio(raw[0].radio) : { id: rid, rid };
      const programs = (Array.isArray(raw) ? raw : [])
        .map(p => mapPodcastProgram(p, radio))
        .filter(p => p.id && p.name);
      sendJSON(res, { radio, programs, more: !!body.more, total: body.count || programs.length });
    } catch (err) {
      console.error('[PodcastPrograms]', err);
      sendJSON(res, { error: err.message, programs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) {
        const empty = ['collect', 'created', 'liked'].map(k => podcastCollectionMeta(k, []));
        sendJSON(res, { loggedIn: false, collections: empty });
        return;
      }
      const keys = ['collect', 'created', 'liked'];
      const collections = await Promise.all(keys.map(async key => {
        try {
          const data = await fetchMyPodcastItems(key, info, 12, 0);
          return podcastCollectionMeta(key, data.items || []);
        } catch (e) {
          console.warn('[MyPodcast]', key, e.message);
          return podcastCollectionMeta(key, []);
        }
      }));
      sendJSON(res, { loggedIn: true, collections });
    } catch (err) {
      console.error('[MyPodcast]', err);
      sendJSON(res, { error: err.message, collections: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my/items') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, items: [] }); return; }
      const key = String(url.searchParams.get('key') || 'collect');
      const limit = parseInt(url.searchParams.get('limit') || '36', 10) || 36;
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const data = await fetchMyPodcastItems(key, info, limit, offset);
      sendJSON(res, { loggedIn: true, key, ...podcastCollectionMeta(key, data.items || []), itemType: data.itemType, items: data.items || [] });
    } catch (err) {
      console.error('[MyPodcastItems]', err);
      sendJSON(res, { error: err.message, items: [] }, 500);
    }
    return;
  }

  if (pn === '/api/song/url') {
    try {
      const sid = url.searchParams.get('id');
      const quality = url.searchParams.get('quality') || '';
      const loginInfo = await getLoginInfo();
      const info = await handleSongUrl(sid, loginInfo, quality);
      sendJSON(res, {
        ...info,
        loggedIn: loginInfo.loggedIn,
        vipType: loginInfo.vipType || 0,
        vipLevel: loginInfo.vipLevel || 'none',
        isVip: !!loginInfo.isVip,
        isSvip: !!loginInfo.isSvip,
        vipLabel: loginInfo.vipLabel || '无VIP',
      });
    } catch (err) { console.error('[SongUrl]', err); sendJSON(res, { error: err.message }, 500); }
    return;
  }

  if (pn === '/api/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeCookieHeader(raw);
      const obj = parseCookieString(normalized);
      if (!obj.MUSIC_U) {
        sendJSON(res, { loggedIn: false, error: 'INVALID_NETEASE_COOKIE', message: '网易云 cookie 缺少 MUSIC_U' }, 400);
        return;
      }
      if (!saveCookie(normalized)) {
        sendJSON(res, {
          ok: false,
          loggedIn: false,
          sessionPersisted: false,
          error: 'LOGIN_SESSION_PERSIST_FAILED',
          message: '网易云登录成功，但安全凭据无法写入本机',
        }, 503);
        return;
      }
      let info = await getLoginInfo();
      if (!info.loggedIn && userCookie) {
        info = {
          loggedIn: true,
          pendingProfile: true,
          nickname: '网易云用户',
          avatar: '',
          vipType: 0,
          vipLevel: 'none',
          isVip: false,
          isSvip: false,
          vipLabel: '无VIP',
        };
      }
      sendJSON(res, { ...info, ok: true, saved: true, sessionPersisted: true, hasCookie: !!userCookie });
    } catch (err) {
      console.error('[LoginCookie]', err);
      sendJSON(res, { loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  // ---------- 登录: QR Key ----------
  // ---------- 播客 DJ 长音频后端离线锁拍 ----------
  if (pn === '/api/podcast/dj-beatmap') {
    try {
      const audioUrl = url.searchParams.get('url');
      const durationSec = Math.max(0, Number(url.searchParams.get('duration') || 0) || 0);
      if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
        sendJSON(res, { error: 'Invalid audio url' }, 400);
        return;
      }
      console.log('[PodcastDjBeatmap] start', Math.round(durationSec || 0) + 's');
      const started = Date.now();
      const introSec = Math.max(0, Number(url.searchParams.get('intro') || 0) || 0);
      const map = introSec
        ? await analyzePodcastDjIntro(audioUrl, {
          durationSec,
          introSec,
          userAgent: UA,
          fetch: fetchPodcastAnalysisMedia,
        })
        : await analyzePodcastDjStream(audioUrl, {
          durationSec,
          userAgent: UA,
          fetch: fetchPodcastAnalysisMedia,
        });
      console.log('[PodcastDjBeatmap] done beats:', map.visualBeatCount || 0, 'ms:', Date.now() - started, 'decode:', map.decode || {});
      sendJSON(res, { ok: true, map });
    } catch (err) {
      console.error('[PodcastDjBeatmap]', err);
      sendJSON(res, { ok: false, error: err.message || String(err) }, 500);
    }
    return;
  }

  if (pn === '/api/login/qr/key') {
    try {
      const r = await login_qr_key({ timestamp: Date.now() });
      const key = r.body && r.body.data && r.body.data.unikey;
      sendJSON(res, { key });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: QR 二维码图片 ----------
  if (pn === '/api/login/qr/create') {
    try {
      const key = url.searchParams.get('key');
      const r = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
      const d = r.body && r.body.data;
      sendJSON(res, { img: d && d.qrimg, url: d && d.qrurl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: 轮询扫码状态 ----------
  if (pn === '/api/login/qr/check') {
    try {
      const requestBody = await readRequestBody(req);
      const key = requestBody.key || url.searchParams.get('key');
      let r = await login_qr_check({ key, noCookie: true, timestamp: Date.now() });
      let body = r.body || {};
      let code = Number(body.code || r.code);
      let msg  = body.message || r.message || '';
      let cookie = readCookieFromResponse(r);
      if (code === 803 && !cookie) {
        try {
          const retry = await login_qr_check({ key, timestamp: Date.now() });
          const retryCookie = readCookieFromResponse(retry);
          if (retryCookie) {
            r = retry;
            body = retry.body || body;
            code = Number(body.code || retry.code || code);
            msg = body.message || retry.message || msg;
            cookie = retryCookie;
          }
        } catch (retryErr) {
          console.warn('[Login] qr cookie retry failed:', retryErr.message);
        }
      }
      // 803 = 授权成功, 802 = 已扫待确认, 801 = 等待扫码, 800 = 二维码过期
      if (code === 803) {
        if (cookie && !saveCookie(cookie)) {
          sendJSON(res, {
            code,
            ok: false,
            loggedIn: false,
            sessionPersisted: false,
            error: 'LOGIN_SESSION_PERSIST_FAILED',
            message: '网易云登录成功，但安全凭据无法写入本机',
          }, 503);
          return;
        }
        let info = await getLoginInfo();
        if (!info.loggedIn) {
          const profile = body.profile || (body.data && body.data.profile) || {};
          info = normalizeLoginInfo(profile, body.account || (body.data && body.data.account), body.data || body);
        }
        if (!info.loggedIn && cookie) {
          info = {
            loggedIn: true,
            pendingProfile: true,
            nickname: (body.nickname || (body.profile && body.profile.nickname) || '网易云用户'),
            avatar: body.avatarUrl || (body.profile && body.profile.avatarUrl) || '',
            vipType: 0,
            vipLevel: 'none',
            isVip: false,
            isSvip: false,
            vipLabel: '无VIP',
          };
        }
        sendJSON(res, {
          code,
          message: msg,
          ...info,
          ok: !!cookie && info.loggedIn,
          sessionPersisted: !!cookie && info.loggedIn,
          hasCookie: !!cookie,
        });
        return;
      }
      sendJSON(res, { code, message: msg, nickname: body.nickname, avatar: body.avatarUrl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录态查询 ----------
  if (pn === '/api/login/status') {
    const info = await getLoginInfo();
    sendJSON(res, info);
    return;
  }

  // ---------- 登出 ----------
  if (pn === '/api/logout') {
    try { await logout({ cookie: userCookie }); } catch (e) {}
    const cleared = saveCookie('');
    sendJSON(res, {
      ok: cleared,
      loggedIn: cleared ? false : !!userCookie,
      error: cleared ? '' : 'LOGIN_SESSION_CLEAR_FAILED',
    }, cleared ? 200 : 500);
    return;
  }

  // ---------- 用户歌单 ----------
  if (pn === '/api/user/playlists') {
    const page = normalizePagination(url.searchParams.get('limit'), url.searchParams.get('offset'), {
      defaultLimit: 60,
      maxLimit: 200,
    });
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED', loggedIn: null, playlists: [], total: 0, more: false, hasMore: false, ...page }, 405);
      return;
    }
    try {
      const info = await requireLogin(res, { playlists: [], total: 0, more: false, hasMore: false, ...page });
      if (!info) return;
      const countPromise = typeof user_subcount === 'function'
        ? user_subcount({ cookie: userCookie, timestamp: Date.now() }).catch(err => {
          console.warn('[UserPlaylists] count unavailable:', err.message);
          return null;
        })
        : Promise.resolve(null);
      const [result, countResult] = await Promise.all([
        user_playlist({
          uid: info.userId,
          limit: page.limit,
          offset: page.offset,
          cookie: userCookie,
          timestamp: Date.now(),
        }),
        countPromise,
      ]);
      const body = throwOnNeteaseApiFailure(result, 'USER_PLAYLISTS_FAILED');
      const playlists = (Array.isArray(body.playlist) ? body.playlist : [])
        .map(mapNeteasePlaylist)
        .filter(playlist => playlist.id && playlist.name);

      let total = Number(body.total || body.count || body.playlistCount);
      let totalExact = Number.isFinite(total) && total >= 0;
      if (!totalExact && countResult) {
        const countBody = countResult.body || countResult || {};
        const createdCount = Number(countBody.createdPlaylistCount);
        const subscribedCount = Number(countBody.subPlaylistCount);
        if (Number.isFinite(createdCount) && Number.isFinite(subscribedCount)) {
          total = Math.max(0, createdCount) + Math.max(0, subscribedCount);
          totalExact = true;
        }
      }
      const moreFromApi = body.more === true || body.hasMore === true;
      const minimumTotal = page.offset + playlists.length + (moreFromApi ? 1 : 0);
      if (!totalExact) total = minimumTotal;
      else total = Math.max(total, page.offset + playlists.length);
      const hasMore = moreFromApi || page.offset + playlists.length < total;
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        authExpired: false,
        error: '',
        userId: info.userId,
        ...page,
        total,
        nextOffset: page.offset + (hasMore ? page.limit : playlists.length),
        totalExact,
        more: hasMore,
        hasMore,
        empty: playlists.length === 0,
        playlists,
      });
    } catch (err) {
      console.error('[UserPlaylists]', err);
      sendNeteaseApiFailure(res, err, 'USER_PLAYLISTS_FAILED', {
        playlists: [],
        total: 0,
        totalExact: false,
        more: false,
        hasMore: false,
        empty: true,
        ...page,
      }, true);
    }
    return;
  }

  // ---------- 专辑搜索 ----------
  if (pn === '/api/album/search') {
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED', albums: [] }, 405);
      return;
    }
    const keywords = String(url.searchParams.get('keywords') || '').trim().slice(0, 120);
    const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '24', 10) || 24));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    if (!keywords) {
      sendJSON(res, { ok: false, error: 'MISSING_KEYWORDS', albums: [], total: 0, empty: true }, 400);
      return;
    }
    try {
      const requestResult = await callPublicNetease(cookie => cloudsearch({
        keywords,
        type: 10,
        limit,
        offset,
        cookie,
        timestamp: Date.now(),
      }));
      const body = throwOnNeteaseApiFailure(requestResult.result, 'ALBUM_SEARCH_FAILED');
      const result = body.result || {};
      const albums = (Array.isArray(result.albums) ? result.albums : [])
        .map(mapAlbumRecord)
        .filter(item => item.id && item.name);
      const total = Math.max(0, Number(result.albumCount || albums.length) || 0);
      sendJSON(res, {
        ok: true,
        requiresLogin: false,
        loggedIn: requestResult.authExpired ? false : null,
        authExpired: requestResult.authExpired,
        error: '',
        keywords,
        limit,
        offset,
        total,
        hasMore: offset + albums.length < total,
        empty: albums.length === 0,
        albums,
      });
    } catch (err) {
      console.error('[AlbumSearch]', err);
      sendNeteaseApiFailure(res, err, 'ALBUM_SEARCH_FAILED', { albums: [], total: 0, empty: true }, false);
    }
    return;
  }

  // ---------- 专辑详情 / 曲目 ----------
  if (pn === '/api/album/detail') {
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED', album: null, tracks: [] }, 405);
      return;
    }
    const id = normalizeNeteaseId(url.searchParams.get('id'));
    if (!id) {
      sendJSON(res, { ok: false, error: 'INVALID_ALBUM_ID', album: null, tracks: [] }, 400);
      return;
    }
    try {
      const requestResult = await callPublicNetease(cookie => album({ id, cookie, timestamp: Date.now() }));
      const body = throwOnNeteaseApiFailure(requestResult.result, 'ALBUM_DETAIL_FAILED');
      if (!body.album || !normalizeNeteaseId(body.album.id)) {
        throw createApiRouteError('ALBUM_NOT_FOUND', 404, '专辑不存在');
      }
      const mappedAlbum = mapAlbumRecord(body.album);
      const tracks = mapNeteaseSongs(body.songs || body.tracks || []);
      if (!mappedAlbum.songCount) mappedAlbum.songCount = tracks.length;
      sendJSON(res, {
        ok: true,
        requiresLogin: false,
        loggedIn: requestResult.authExpired ? false : null,
        authExpired: requestResult.authExpired,
        error: '',
        empty: tracks.length === 0,
        album: mappedAlbum,
        tracks,
      });
    } catch (err) {
      console.error('[AlbumDetail]', err);
      if (normalizeApiCode(err) === 404 && !err.apiRouteError) {
        err = createApiRouteError('ALBUM_NOT_FOUND', 404, '专辑不存在');
      }
      sendNeteaseApiFailure(res, err, 'ALBUM_DETAIL_FAILED', { album: null, tracks: [] }, false);
    }
    return;
  }

  // ---------- 歌手专辑 ----------
  if (pn === '/api/artist/albums') {
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED', artist: null, albums: [] }, 405);
      return;
    }
    const id = normalizeNeteaseId(url.searchParams.get('id'));
    const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '24', 10) || 24));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    if (!id) {
      sendJSON(res, { ok: false, error: 'INVALID_ARTIST_ID', artist: null, albums: [] }, 400);
      return;
    }
    try {
      const requestResult = await callPublicNetease(cookie => artist_album({
        id,
        limit,
        offset,
        cookie,
        timestamp: Date.now(),
      }));
      const body = throwOnNeteaseApiFailure(requestResult.result, 'ARTIST_ALBUMS_FAILED');
      const albums = (Array.isArray(body.hotAlbums) ? body.hotAlbums : (Array.isArray(body.albums) ? body.albums : []))
        .map(mapAlbumRecord)
        .filter(item => item.id && item.name);
      const rawArtist = body.artist || albums[0] && body.hotAlbums && body.hotAlbums[0] && body.hotAlbums[0].artist || {};
      const mappedArtists = mapArtists(rawArtist.id ? [rawArtist] : []);
      sendJSON(res, {
        ok: true,
        requiresLogin: false,
        loggedIn: requestResult.authExpired ? false : null,
        authExpired: requestResult.authExpired,
        error: '',
        id,
        limit,
        offset,
        hasMore: !!body.more,
        empty: albums.length === 0,
        artist: {
          id: rawArtist.id || id,
          name: rawArtist.name || '',
          avatar: rawArtist.picUrl || rawArtist.img1v1Url || '',
          aliases: Array.isArray(rawArtist.alias) ? rawArtist.alias.filter(Boolean).map(String) : [],
          artists: mappedArtists,
        },
        albums,
      });
    } catch (err) {
      console.error('[ArtistAlbums]', err);
      if (normalizeApiCode(err) === 404 && !err.apiRouteError) {
        err = createApiRouteError('ARTIST_NOT_FOUND', 404, '歌手不存在');
      }
      sendNeteaseApiFailure(res, err, 'ARTIST_ALBUMS_FAILED', { artist: null, albums: [] }, false);
    }
    return;
  }

  // ---------- 红心状态 ----------
  if (pn === '/api/song/like/check') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!ids.length) { sendJSON(res, { error: 'Missing song id', liked: {}, ids: [] }, 400); return; }
      let likedIds = [];
      try {
        if (typeof song_like_check === 'function') {
          const checked = await song_like_check({ ids: JSON.stringify(ids.map(Number).filter(Boolean)), cookie: userCookie, timestamp: Date.now() });
          const data = (checked.body && (checked.body.data || checked.body.ids)) || checked.body || {};
          if (Array.isArray(data)) likedIds = data.map(String);
          else if (data && typeof data === 'object') {
            ids.forEach(id => {
              if (data[id] || data[String(id)] || data[Number(id)]) likedIds.push(String(id));
            });
          }
        }
      } catch (e) {
        console.warn('[LikeCheck] direct check failed:', e.message);
      }
      if (!likedIds.length) {
        const r = await likelist({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
        likedIds = ((r.body && r.body.ids) || []).map(String);
      }
      const set = new Set(likedIds);
      const liked = {};
      ids.forEach(id => { liked[id] = set.has(String(id)); });
      sendJSON(res, { loggedIn: true, ids, liked });
    } catch (err) {
      console.error('[LikeCheck]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 红心/取消红心 ----------
  if (pn === '/api/song/like') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const id = body.id || url.searchParams.get('id');
      const nextLike = String(body.like != null ? body.like : (url.searchParams.get('like') || 'true')) !== 'false';
      if (!id) { sendJSON(res, { error: 'Missing song id' }, 400); return; }
      const r = await like_song({ id, like: String(nextLike), cookie: userCookie, timestamp: Date.now() });
      const code = (r.body && r.body.code) || r.code || 200;
      sendJSON(res, { loggedIn: true, id, liked: nextLike, code, body: r.body || r });
    } catch (err) {
      console.error('[Like]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 创建歌单 ----------
  if (pn === '/api/playlist/create') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const name = String(body.name || url.searchParams.get('name') || '').trim();
      const privacy = String(body.privacy || url.searchParams.get('privacy') || '0');
      if (!name) { sendJSON(res, { error: 'Missing playlist name' }, 400); return; }
      const r = await playlist_create({ name, privacy, cookie: userCookie, timestamp: Date.now() });
      const created = (r.body && (r.body.playlist || r.body.data)) || {};
      sendJSON(res, { loggedIn: true, playlist: created, body: r.body || r });
    } catch (err) {
      console.error('[PlaylistCreate]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 收藏歌曲到歌单 ----------
  if (pn === '/api/playlist/add-song') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const pid = body.pid || url.searchParams.get('pid');
      const id = body.id || body.ids || url.searchParams.get('id') || url.searchParams.get('ids');
      if (!pid || !id) { sendJSON(res, { error: 'Missing playlist id or song id' }, 400); return; }
      const attempts = [];
      let finalBody = null;
      let finalCode = 0;
      let finalMessage = '';
      let success = false;

      const primary = await playlist_tracks({ op: 'add', pid, tracks: String(id), cookie: userCookie, timestamp: Date.now() });
      finalBody = primary.body || primary;
      finalCode = normalizeApiCode(primary);
      finalMessage = normalizeApiMessage(primary);
      success = finalCode === 200 && !(finalBody && finalBody.error);
      attempts.push({ api: 'playlist_tracks', code: finalCode, message: finalMessage, body: finalBody });

      if (!success && typeof playlist_track_add === 'function') {
        try {
          const fallback = await playlist_track_add({ pid, ids: String(id), cookie: userCookie, timestamp: Date.now() });
          finalBody = fallback.body || fallback;
          finalCode = normalizeApiCode(fallback);
          finalMessage = normalizeApiMessage(fallback);
          success = finalCode === 200 && !(finalBody && finalBody.error);
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: finalBody });
        } catch (fallbackErr) {
          const errBody = fallbackErr.body || fallbackErr.response || {};
          finalBody = errBody;
          finalCode = normalizeApiCode(errBody);
          finalMessage = normalizeApiMessage(errBody) || fallbackErr.message || '';
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: errBody });
        }
      }

      if (!success) {
        sendJSON(res, { loggedIn: true, pid, id, success: false, code: finalCode, error: finalMessage || 'PLAYLIST_ADD_FAILED', attempts }, finalCode === 401 ? 401 : 409);
        return;
      }
      invalidateNeteasePlaylistManifest(pid);
      sendJSON(res, { loggedIn: true, pid, id, success: true, code: finalCode, body: finalBody, attempts });
    } catch (err) {
      console.error('[PlaylistAddSong]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 从自己的歌单移除歌曲 ----------
  if (pn === '/api/playlist/remove-song') {
    try {
      const info = await requireLogin(res, { removedIds: [] });
      if (!info) return;
      const body = await readRequestBody(req);
      const pid = normalizeNeteaseId(body.pid || url.searchParams.get('pid'));
      const ids = normalizeNeteaseIds(body.ids != null ? body.ids : body.id, 500);
      if (!pid || !ids) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_PLAYLIST_OR_SONG_IDS', removedIds: [] }, 400);
        return;
      }
      const playlist = await getOwnedPlaylist(pid, info.userId);
      const currentIds = new Set((playlist.trackIds || []).map(item => normalizeNeteaseId(item && (item.id || item))).filter(Boolean));
      const missingIds = ids.filter(id => !currentIds.has(id));
      if (missingIds.length) {
        throw createApiRouteError('PLAYLIST_TRACK_NOT_FOUND', 404, '歌单中没有要移除的歌曲', {
          loggedIn: true,
          pid,
          missingIds,
          removedIds: [],
        });
      }
      const result = await playlist_tracks({
        op: 'del',
        pid,
        tracks: ids.join(','),
        cookie: userCookie,
        timestamp: Date.now(),
      });
      const resultBody = throwOnNeteaseApiFailure(result, 'PLAYLIST_REMOVE_SONG_FAILED');
      invalidateNeteasePlaylistManifest(pid);
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        code: normalizeApiCode(result) || 200,
        pid,
        removedIds: ids,
        trackCount: Math.max(0, Number(playlist.trackCount || currentIds.size) - ids.length),
        body: resultBody,
      });
    } catch (err) {
      console.error('[PlaylistRemoveSong]', err);
      sendNeteaseApiFailure(res, err, 'PLAYLIST_REMOVE_SONG_FAILED', { removedIds: [] }, true);
    }
    return;
  }

  // ---------- 重命名自己的歌单 ----------
  if (pn === '/api/playlist/rename') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const pid = normalizeNeteaseId(body.pid || url.searchParams.get('pid'));
      const name = String(body.name || '').trim();
      if (!pid) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_PLAYLIST_ID' }, 400);
        return;
      }
      if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_PLAYLIST_NAME' }, 400);
        return;
      }
      const playlist = await getOwnedPlaylist(pid, info.userId);
      const tags = Array.isArray(playlist.tags) ? playlist.tags.join(';') : String(playlist.tags || '');
      const result = await playlist_update({
        id: pid,
        name: escapeNeteaseBatchString(name),
        desc: escapeNeteaseBatchString(playlist.description || ''),
        tags: escapeNeteaseBatchString(tags),
        cookie: userCookie,
        timestamp: Date.now(),
      });
      const resultBody = throwOnNeteaseApiFailure(result, 'PLAYLIST_RENAME_FAILED');
      invalidateNeteasePlaylistManifest(pid);
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        code: normalizeApiCode(result) || 200,
        pid,
        name,
        body: resultBody,
      });
    } catch (err) {
      console.error('[PlaylistRename]', err);
      sendNeteaseApiFailure(res, err, 'PLAYLIST_RENAME_FAILED', {}, true);
    }
    return;
  }

  // ---------- 更新自己的歌单元数据 ----------
  if (pn === '/api/playlist/update-meta' || pn === '/api/playlist/update-metadata') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const pid = normalizeNeteaseId(body.pid || body.id || url.searchParams.get('pid'));
      if (!pid) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_PLAYLIST_ID' }, 400);
        return;
      }
      const playlist = await getOwnedPlaylist(pid, info.userId);
      const normalized = normalizePlaylistMetadataPatch(body, playlist);
      if (!normalized.ok) {
        sendJSON(res, { ok: false, loggedIn: true, error: normalized.error, pid }, 400);
        return;
      }
      const metadata = normalized.metadata;
      if (normalized.changed.privacy && metadata.privacy !== 0) {
        throw createApiRouteError(
          'PLAYLIST_PRIVACY_UNSUPPORTED',
          409,
          '网易云当前只允许把隐私歌单改为公开，不能把已有公开歌单改为隐私歌单',
          { loggedIn: true, pid },
        );
      }

      const results = {};
      if (normalized.changed.name || normalized.changed.description || normalized.changed.tags) {
        const result = await playlist_update({
          id: pid,
          name: escapeNeteaseBatchString(metadata.name),
          desc: escapeNeteaseBatchString(metadata.description),
          tags: escapeNeteaseBatchString(metadata.tags.join(';')),
          cookie: userCookie,
          timestamp: Date.now(),
        });
        results.metadata = throwOnNeteaseApiFailure(result, 'PLAYLIST_METADATA_UPDATE_FAILED');
      }
      if (normalized.changed.privacy) {
        const result = await playlist_privacy({ id: pid, cookie: userCookie, timestamp: Date.now() });
        results.privacy = throwOnNeteaseApiFailure(result, 'PLAYLIST_PRIVACY_UPDATE_FAILED');
      }
      invalidateNeteasePlaylistManifest(pid);
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        pid,
        metadata,
        changed: normalized.changed,
        body: results,
      });
    } catch (err) {
      console.error('[PlaylistUpdateMeta]', err);
      sendNeteaseApiFailure(res, err, 'PLAYLIST_METADATA_UPDATE_FAILED', {}, true);
    }
    return;
  }

  // ---------- 订阅或取消订阅公开歌单 ----------
  if (pn === '/api/playlist/subscribe') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const pid = normalizeNeteaseId(body.pid || body.id || url.searchParams.get('pid'));
      const hasSubscribe = Object.prototype.hasOwnProperty.call(body, 'subscribe')
        || Object.prototype.hasOwnProperty.call(body, 'subscribed');
      const subscribeValue = Object.prototype.hasOwnProperty.call(body, 'subscribe') ? body.subscribe : body.subscribed;
      const subscribe = subscribeValue === true || subscribeValue === 1 || String(subscribeValue).toLowerCase() === 'true';
      if (!pid) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_PLAYLIST_ID' }, 400);
        return;
      }
      if (!hasSubscribe || ![true, false, 1, 0, 'true', 'false', '1', '0'].includes(subscribeValue)) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_SUBSCRIBE_STATE', pid }, 400);
        return;
      }
      const playlist = await getSubscribablePlaylist(pid, info.userId);
      if (!!playlist.subscribed === subscribe) {
        invalidateNeteasePlaylistManifest(pid);
        sendJSON(res, {
          ok: true,
          loggedIn: true,
          error: '',
          pid,
          subscribed: subscribe,
          changed: false,
          code: 200,
        });
        return;
      }
      const result = await playlist_subscribe({
        id: pid,
        t: subscribe ? 1 : 0,
        cookie: userCookie,
        timestamp: Date.now(),
      });
      const resultBody = throwOnNeteaseApiFailure(result, 'PLAYLIST_SUBSCRIBE_FAILED');
      invalidateNeteasePlaylistManifest(pid);
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        pid,
        subscribed: subscribe,
        changed: true,
        code: normalizeApiCode(result) || 200,
        body: resultBody,
      });
    } catch (err) {
      console.error('[PlaylistSubscribe]', err);
      sendNeteaseApiFailure(res, err, 'PLAYLIST_SUBSCRIBE_FAILED', { subscribed: null, changed: false }, true);
    }
    return;
  }

  // ---------- 删除自己的歌单 ----------
  if (pn === '/api/playlist/delete') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const pid = normalizeNeteaseId(body.pid || url.searchParams.get('pid'));
      if (!pid) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_PLAYLIST_ID' }, 400);
        return;
      }
      await getOwnedPlaylist(pid, info.userId);
      const result = await playlist_delete({ id: pid, cookie: userCookie, timestamp: Date.now() });
      const resultBody = throwOnNeteaseApiFailure(result, 'PLAYLIST_DELETE_FAILED');
      invalidateNeteasePlaylistManifest(pid);
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        code: normalizeApiCode(result) || 200,
        pid,
        deleted: true,
        body: resultBody,
      });
    } catch (err) {
      console.error('[PlaylistDelete]', err);
      sendNeteaseApiFailure(res, err, 'PLAYLIST_DELETE_FAILED', { deleted: false }, true);
    }
    return;
  }

  // ---------- 更新自己歌单内的完整曲序 ----------
  if (pn === '/api/playlist/reorder-tracks') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = await readRequestBody(req);
      const pid = normalizeNeteaseId(body.pid || url.searchParams.get('pid'));
      const ids = normalizeNeteaseIds(body.ids, 10000);
      if (!pid || !ids) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'INVALID_PLAYLIST_OR_SONG_IDS' }, 400);
        return;
      }
      if (new Set(ids).size !== ids.length) {
        sendJSON(res, { ok: false, loggedIn: true, error: 'DUPLICATE_SONG_IDS' }, 400);
        return;
      }
      const playlist = await getOwnedPlaylist(pid, info.userId);
      const currentIds = (playlist.trackIds || []).map(item => normalizeNeteaseId(item && (item.id || item))).filter(Boolean);
      const requestedSet = new Set(ids);
      const sameTracks = currentIds.length === ids.length && currentIds.every(id => requestedSet.has(id));
      if (!sameTracks) {
        throw createApiRouteError('PLAYLIST_TRACK_ORDER_MISMATCH', 409, '曲序必须包含歌单当前的全部歌曲且不能增删', {
          loggedIn: true,
          pid,
          expectedTrackCount: currentIds.length,
          receivedTrackCount: ids.length,
        });
      }
      const result = await song_order_update({
        pid,
        ids: JSON.stringify(ids.map(Number)),
        cookie: userCookie,
        timestamp: Date.now(),
      });
      const resultBody = throwOnNeteaseApiFailure(result, 'PLAYLIST_REORDER_FAILED');
      invalidateNeteasePlaylistManifest(pid);
      sendJSON(res, {
        ok: true,
        loggedIn: true,
        error: '',
        code: normalizeApiCode(result) || 200,
        pid,
        ids,
        body: resultBody,
      });
    } catch (err) {
      console.error('[PlaylistReorder]', err);
      sendNeteaseApiFailure(res, err, 'PLAYLIST_REORDER_FAILED', {}, true);
    }
    return;
  }

  // ---------- 歌词 ----------
  if (pn === '/api/lyric') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing song id', lyric: '', tlyric: '', yrc: '', roma: '' }, 400); return; }
      let body = {};
      let source = 'lyric';
      try {
        if (typeof lyric_new === 'function') {
          const nr = await lyric_new({ id, cookie: userCookie, timestamp: Date.now() });
          body = nr.body || {};
          source = 'lyric_new';
        }
      } catch (errNew) {
        console.warn('[LyricNew]', errNew.message);
      }
      if (!((body.lrc && body.lrc.lyric) || (body.yrc && body.yrc.lyric))) {
        const r = await lyric({ id, cookie: userCookie, timestamp: Date.now() });
        body = r.body || body || {};
        source = 'lyric';
      }
      sendJSON(res, {
        lyric: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || '',
        yrc: (body.yrc && body.yrc.lyric) || '',
        roma: (body.romalrc && body.romalrc.lyric) || (body.roma && body.roma.lyric) || '',
        source,
      });
    } catch (err) {
      console.error('[Lyric]', err);
      sendJSON(res, { error: err.message, lyric: '', tlyric: '', yrc: '', roma: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲评论 ----------
  if (pn === '/api/song/comments') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      if (!id) { sendJSON(res, { error: 'Missing song id', comments: [] }, 400); return; }
      const r = await comment_music({ id, limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || r || {};
      const raw = body.hotComments && offset === 0 ? body.hotComments : (body.comments || []);
      const comments = (raw || []).map(c => ({
        id: c.commentId,
        content: c.content || '',
        likedCount: c.likedCount || 0,
        time: c.time || 0,
        user: c.user ? { id: c.user.userId, nickname: c.user.nickname || '', avatar: c.user.avatarUrl || '' } : null,
      })).filter(c => c.content);
      sendJSON(res, { id, total: body.total || 0, comments, hot: !!(body.hotComments && offset === 0), body });
    } catch (err) {
      console.error('[SongComments]', err);
      sendJSON(res, { error: err.message, comments: [] }, 500);
    }
    return;
  }

  // ---------- 歌手主页 / 热门歌曲 ----------
  if (pn === '/api/artist/detail') {
    const page = normalizeArtistDetailPagination(
      url.searchParams.get('limit'),
      url.searchParams.get('offset'),
      30,
    );
    try {
      const id = url.searchParams.get('id');
      if (!id) {
        sendJSON(res, {
          error: 'Missing artist id',
          songs: [],
          authExpired: false,
          ...emptyArtistDetailPage(page),
        }, 400);
        return;
      }
      let authExpired = false;
      let detailBody = {};
      try {
        const requestResult = await callPublicNetease(cookie => artist_detail({
          id,
          cookie,
          timestamp: Date.now(),
        }));
        authExpired = authExpired || requestResult.authExpired;
        detailBody = requestResult.result && (requestResult.result.body || requestResult.result) || {};
      } catch (e) {
        console.warn('[ArtistDetail] detail failed:', e.message);
      }
      let rawSongs = [];
      let songsBody = {};
      try {
        const requestResult = await callPublicNetease(cookie => artist_songs({
          id,
          order: 'hot',
          limit: page.limit,
          offset: page.offset,
          cookie,
          timestamp: Date.now(),
        }));
        authExpired = authExpired || requestResult.authExpired;
        songsBody = requestResult.result && (requestResult.result.body || requestResult.result) || {};
        rawSongs = songsBody.songs || (songsBody.data && songsBody.data.songs) || [];
        if (!Array.isArray(rawSongs)) rawSongs = [];
      } catch (e) {
        console.warn('[ArtistSongs] hot failed:', e.message);
      }
      let usedTopSongFallback = false;
      if (page.offset === 0 && !rawSongs.length) {
        try {
          const requestResult = await callPublicNetease(cookie => artist_top_song({
            id,
            cookie,
            timestamp: Date.now(),
          }));
          authExpired = authExpired || requestResult.authExpired;
          const fallbackBody = requestResult.result && (requestResult.result.body || requestResult.result) || {};
          rawSongs = Array.isArray(fallbackBody.songs) ? fallbackBody.songs : [];
          usedTopSongFallback = true;
        } catch (e) {
          console.warn('[ArtistSongs] top fallback failed:', e.message);
        }
      }
      const artist = detailBody.artist || (detailBody.data && (detailBody.data.artist || detailBody.data)) || {};
      const rawPage = rawSongs.slice(0, page.limit);
      const songs = rawPage.map(mapSongRecord).filter(s => s.id);
      const songsData = songsBody.data && typeof songsBody.data === 'object' ? songsBody.data : {};
      const reportedTotal = firstFiniteNonNegativeCount([
        songsBody.total,
        songsBody.songCount,
        songsData.total,
        songsData.songCount,
        artist.musicSize,
        artist.songSize,
      ], rawPage.length);
      const cursor = usedTopSongFallback
        ? {
          total: songs.length,
          nextOffset: page.offset + songs.length,
          more: false,
          hasMore: false,
        }
        : resolveArtistDetailCursor(
          page,
          reportedTotal,
          rawPage.length,
          songsBody.more === true || songsBody.hasMore === true
            || songsData.more === true || songsData.hasMore === true,
        );
      sendJSON(res, {
        id,
        artist: {
          id: artist.id || id,
          name: artist.name || artist.artistName || '',
          avatar: artist.avatar || artist.cover || artist.picUrl || artist.img1v1Url || '',
          brief: artist.briefDesc || artist.description || artist.desc || '',
          musicSize: firstFiniteNonNegativeCount([artist.musicSize, artist.songSize], cursor.total),
          albumSize: firstFiniteNonNegativeCount([artist.albumSize], 0),
        },
        songs,
        total: cursor.total,
        offset: page.offset,
        limit: page.limit,
        nextOffset: cursor.nextOffset,
        more: cursor.more,
        hasMore: cursor.hasMore,
        authExpired,
        body: detailBody,
      });
    } catch (err) {
      console.error('[ArtistDetail]', err);
      sendJSON(res, {
        error: err.message,
        songs: [],
        authExpired: false,
        ...emptyArtistDetailPage(page),
      }, 500);
    }
    return;
  }

  // ---------- 歌单曲目详情 ----------
  if (pn === '/api/playlist/tracks') {
    const page = normalizePagination(url.searchParams.get('limit'), url.searchParams.get('offset'), {
      defaultLimit: 500,
      maxLimit: 500,
    });
    if (req.method !== 'GET') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED', playlist: null, tracks: [], total: 0, more: false, hasMore: false, ...page }, 405);
      return;
    }
    try {
      const id = normalizeNeteaseId(url.searchParams.get('id'));
      if (!id) {
        sendJSON(res, { ok: false, error: 'INVALID_PLAYLIST_ID', playlist: null, tracks: [], total: 0, more: false, hasMore: false, ...page }, 400);
        return;
      }

      const manifest = await loadNeteasePlaylistManifest(id);
      let authExpired = manifest.authExpired;
      const playlist = manifest.playlist;
      if (!playlist || !normalizeNeteaseId(playlist.id)) {
        throw createApiRouteError('PLAYLIST_NOT_FOUND', 404, '歌单不存在');
      }
      const playlistMeta = mapNeteasePlaylistMeta(playlist, id);
      const trackIds = (Array.isArray(playlist.trackIds) ? playlist.trackIds : [])
        .map(item => normalizeNeteaseId(item && (item.id || item)))
        .filter(Boolean);
      const total = Math.max(
        0,
        Number(playlist.trackCount || 0) || 0,
        trackIds.length,
        Array.isArray(playlist.tracks) ? playlist.tracks.length : 0,
      );
      let rawTracks = [];

      if (page.offset < total) {
        const selectedIds = trackIds.slice(page.offset, page.offset + page.limit);
        if (selectedIds.length) {
          const songRequest = await callPublicNetease(cookie => song_detail({
            ids: selectedIds.join(','),
            cookie,
            timestamp: Date.now(),
          }));
          authExpired = authExpired || songRequest.authExpired;
          const songBody = throwOnNeteaseApiFailure(songRequest.result, 'PLAYLIST_TRACK_DETAILS_FAILED');
          const songs = Array.isArray(songBody.songs) ? songBody.songs : [];
          const songsById = new Map(songs.map(song => [normalizeNeteaseId(song.id), song]));
          rawTracks = selectedIds.map(songId => songsById.get(songId)).filter(Boolean);
        } else if (Array.isArray(playlist.tracks) && playlist.tracks.length > page.offset) {
          rawTracks = (Array.isArray(playlist.tracks) ? playlist.tracks : [])
            .slice(page.offset, page.offset + page.limit);
        }
      }

      if (!rawTracks.length && page.offset < total && typeof playlist_track_all === 'function') {
        const pageRequest = await callPublicNetease(cookie => playlist_track_all({
          id,
          limit: page.limit,
          offset: page.offset,
          cookie,
          timestamp: Date.now(),
        }));
        authExpired = authExpired || pageRequest.authExpired;
        const pageBody = throwOnNeteaseApiFailure(pageRequest.result, 'PLAYLIST_TRACKS_FAILED');
        rawTracks = pageBody.songs || pageBody.tracks || [];
      }

      const tracks = mapNeteaseSongs(rawTracks);
      const hasMore = page.offset + page.limit < total;
      sendJSON(res, {
        ok: true,
        requiresLogin: false,
        loggedIn: authExpired ? false : null,
        authExpired,
        error: '',
        ...page,
        total,
        nextOffset: Math.min(total, page.offset + (hasMore ? page.limit : rawTracks.length)),
        more: hasMore,
        hasMore,
        empty: tracks.length === 0,
        playlist: { ...playlistMeta, trackCount: total },
        tracks,
      });
    } catch (err) {
      console.error('[PlaylistTracks]', err);
      sendNeteaseApiFailure(res, err, 'PLAYLIST_TRACKS_FAILED', {
        playlist: null,
        tracks: [],
        total: 0,
        more: false,
        hasMore: false,
        empty: true,
        ...page,
      }, isNeteaseAuthInvalidPayload(err));
    }
    return;
  }

  // ---------- 封面代理 (带 CORS 头, 给 canvas 提取像素用) ----------
  if (pn === '/api/cover') {
    const coverUrl = url.searchParams.get('url');
    await mediaProxy.pipe(req, res, coverUrl, {
      kind: 'image',
      headers: {
        'User-Agent': UA,
        Referer: 'https://music.163.com/',
      },
      cacheControl: 'public, max-age=86400',
    });
    return;
  }

  // ---------- 音频代理 (支持 Range) ----------
  if (pn === '/api/audio') {
    try {
      const audioUrl = url.searchParams.get('url');
      if (!audioUrl) { res.writeHead(400); res.end('Missing url'); return; }
      const range = req.headers.range || '';
      if (audioUrl.includes('#auth=')) {
        const downstreamController = new AbortController();
        const abortDownstream = () => downstreamController.abort();
        req.once('aborted', abortDownstream);
        res.once('close', abortDownstream);
        let decrypted;
        try {
          decrypted = await qishuiAudioProxy.load(
            audioUrl,
            audioProxyHeadersFor(audioUrl, ''),
            { signal: downstreamController.signal }
          );
        } finally {
          req.removeListener('aborted', abortDownstream);
          res.removeListener('close', abortDownstream);
        }
        if (downstreamController.signal.aborted || res.destroyed || res.writableEnded) return;
        if (decrypted && decrypted.buffer) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          sendQishuiAudioBuffer(res, decrypted, range, req.method);
          return;
        }
      }
      await mediaProxy.pipe(req, res, audioUrl, {
        kind: 'audio',
        headers: audioProxyHeadersFor(audioUrl, range),
        cacheControl: 'no-store',
      });
    } catch (err) {
      if (err && err.code === 'QISHUI_AUDIO_CLIENT_ABORTED') return;
      console.error('[Audio]', err && (err.code || err.message || err));
      if (res.headersSent) {
        try { res.destroy(); } catch (_) {}
        return;
      }
      const statusCode = Number(err && err.statusCode);
      res.writeHead(statusCode >= 400 && statusCode <= 599 ? statusCode : 500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(err && err.message ? err.message : 'Audio proxy failed');
    }
    return;
  }

  // ---------- 静态资源 ----------
  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 粒子音乐可视化 v2  →  http://localhost:' + PORT);
  console.log(' 登录态: ' + (userCookie ? '已登录(cookie已加载)' : '未登录'));
  console.log('======================================================');
});

module.exports = server;
