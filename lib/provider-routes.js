'use strict';

const path = require('node:path');
const credentialStore = require('./protected-credential-store');
const kugou = require('../kugou-api');
const qishui = require('../qishui-api');
const spotify = require('../spotify-api');

const POST_ONLY_ROUTES = new Set([
  '/api/kugou/login/cookie',
  '/api/kugou/logout',
  '/api/kugou/song/like',
  '/api/kugou/playlist/add-song',
  '/api/qishui/login/token',
  '/api/qishui/login/cookie',
  '/api/qishui/logout',
  '/api/qishui/song/like',
  '/api/qishui/playlist/collect',
  '/api/qishui/playlist/add-song',
  '/api/qishui/album/collect',
  '/api/qishui/listen/report',
  '/api/spotify/config',
  '/api/spotify/logout',
  '/api/spotify/song/like',
  '/api/spotify/album/like',
  '/api/spotify/playlist/add-song',
  '/api/spotify/playlist/create',
  '/api/spotify/playlist/collect',
]);

const MUTATING_POST_ROUTES = new Set([
  ...POST_ONLY_ROUTES,
  '/api/qishui/song/comments',
]);

const HANDLED_ROUTES = new Set([
  '/api/kugou/search',
  '/api/kugou/recommendations',
  '/api/kugou/song/url',
  '/api/kugou/lyric',
  '/api/kugou/login/status',
  '/api/kugou/login/cookie',
  '/api/kugou/logout',
  '/api/kugou/user/playlists',
  '/api/kugou/playlist/tracks',
  '/api/kugou/song/like/check',
  '/api/kugou/song/like',
  '/api/kugou/playlist/add-song',
  '/api/qishui/status',
  '/api/qishui/login/status',
  '/api/qishui/login/token',
  '/api/qishui/login/cookie',
  '/api/qishui/logout',
  '/api/qishui/search',
  '/api/qishui/feed',
  '/api/qishui/user/playlists',
  '/api/qishui/playlist/tracks',
  '/api/qishui/song/like/check',
  '/api/qishui/song/like',
  '/api/qishui/playlist/collect',
  '/api/qishui/playlist/add-song',
  '/api/qishui/album/collect',
  '/api/qishui/listen/report',
  '/api/qishui/song/comments',
  '/api/qishui/song/url',
  '/api/qishui/lyric',
  '/api/spotify/status',
  '/api/spotify/config',
  '/api/spotify/logout',
  '/api/spotify/search',
  '/api/spotify/recommendations',
  '/api/spotify/user/playlists',
  '/api/spotify/playlist/tracks',
  '/api/spotify/album/detail',
  '/api/spotify/song/like/check',
  '/api/spotify/song/like',
  '/api/spotify/album/like/check',
  '/api/spotify/album/like',
  '/api/spotify/playlist/add-song',
  '/api/spotify/playlist/create',
  '/api/spotify/playlist/collect',
  '/api/spotify/song/url',
  '/api/spotify/lyric',
]);

function numberParam(url, name, fallback, min, max) {
  const parsed = Number.parseInt(url.searchParams.get(name) || '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error('REQUEST_BODY_TOO_LARGE');
        error.statusCode = 413;
        req.destroy(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        const error = new Error('INVALID_JSON_BODY');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(payload));
}

function errorStatus(error) {
  const explicit = Number(error && error.statusCode);
  if (explicit >= 400 && explicit <= 599) return explicit;
  const text = String(error && (error.code || error.message) || '');
  if (/REQUIRED|MISSING|INVALID|NOT_CONFIGURED/i.test(text)) return 400;
  if (/LOGIN|COOKIE|AUTH|TOKEN_EXPIRED|UNAUTHORIZED/i.test(text)) return 401;
  if (/RATE|429/i.test(text)) return 429;
  return 500;
}

function publicProviderStatus(value) {
  if (!value || typeof value !== 'object') return value;
  const output = Array.isArray(value) ? [] : {};
  Object.keys(value).forEach(key => {
    if (/^(?:cookie|token|accessToken|refreshToken|clientSecret|credentialsFile|configFile|tokenFile|file)$/i.test(key)) return;
    const child = value[key];
    output[key] = child && typeof child === 'object' ? publicProviderStatus(child) : child;
  });
  return output;
}

function createProviderRoutes(options = {}) {
  const userDataDir = options.userDataDir || process.env.MINERADIO_USER_DATA_DIR || process.cwd();
  const kugouCookieFile = process.env.KUGOU_COOKIE_FILE || path.join(userDataDir, '.kugou-cookie');
  const qishuiCookieFile = process.env.QISHUI_COOKIE_FILE || path.join(userDataDir, '.qishui-cookie');
  let kugouCookie = '';
  let qishuiCookie = '';
  try { kugouCookie = credentialStore.readString(kugouCookieFile); } catch (_) {}
  try { qishuiCookie = credentialStore.readString(qishuiCookieFile); } catch (_) {}

  function saveKugouCookie(value) {
    const nextCookie = kugou.normalizeKugouCookieInput(value);
    credentialStore.writeString(kugouCookieFile, nextCookie);
    kugouCookie = nextCookie;
    return true;
  }

  function saveQishuiCookie(value) {
    const nextCookie = qishui.normalizeQishuiCookieInput(value);
    credentialStore.writeString(qishuiCookieFile, nextCookie);
    qishuiCookie = nextCookie;
    return true;
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (!HANDLED_ROUTES.has(pathname)) return false;

    try {
      if (pathname === '/api/kugou/search') {
        const limit = numberParam(url, 'limit', 12, 4, 20);
        const offset = numberParam(url, 'offset', 0, 0, 100000);
        const result = await kugou.handleKugouSearch(url.searchParams.get('keywords') || '', limit, kugouCookie, offset);
        sendJson(res, {
          provider: 'kugou',
          songs: result.songs,
          total: result.total,
          rawCount: result.rawCount,
          offset,
          limit,
          nextOffset: result.nextOffset,
          hasMore: result.hasMore,
        });
        return true;
      }
      if (pathname === '/api/kugou/recommendations') {
        sendJson(res, await kugou.handleKugouGuessLike(kugouCookie, numberParam(url, 'limit', 12, 4, 20)));
        return true;
      }
      if (pathname === '/api/kugou/song/url') {
        sendJson(res, await kugou.handleKugouSongUrl({
          hash: url.searchParams.get('hash') || url.searchParams.get('id') || '',
          albumId: url.searchParams.get('albumId') || url.searchParams.get('album_id') || '',
          albumAudioId: url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || url.searchParams.get('mixSongId') || '',
          mixSongId: url.searchParams.get('mixSongId') || url.searchParams.get('albumAudioId') || '',
          hqHash: url.searchParams.get('hqHash') || '',
          sqHash: url.searchParams.get('sqHash') || '',
          resHash: url.searchParams.get('resHash') || '',
          quality: url.searchParams.get('quality') || '',
          vipRequired: url.searchParams.get('vipRequired') || '',
          needVip: url.searchParams.get('needVip') || '',
          onlyVipPlayable: url.searchParams.get('onlyVipPlayable') || '',
          privilege: url.searchParams.get('privilege') || '',
          fee: url.searchParams.get('fee') || '',
        }, kugouCookie));
        return true;
      }
      if (pathname === '/api/kugou/lyric') {
        const hash = url.searchParams.get('hash') || url.searchParams.get('id') || '';
        if (!hash) {
          sendJson(res, { provider: 'kugou', error: 'KUGOU_HASH_REQUIRED', lyric: '' }, 400);
          return true;
        }
        sendJson(res, await kugou.handleKugouLyric(
          hash,
          url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || '',
          url.searchParams.get('duration') || ''
        ));
        return true;
      }
      if (pathname === '/api/kugou/login/status') {
        const info = await kugou.getKugouLoginInfo(kugouCookie);
        if (info.authExpired) saveKugouCookie('');
        sendJson(res, publicProviderStatus(info));
        return true;
      }
      if (pathname === '/api/kugou/login/cookie') {
        const body = await readJsonBody(req);
        const normalized = kugou.normalizeKugouCookieInput(body.cookie || body.data || body.text || '');
        const auth = kugou.extractKugouAuth(normalized);
        if (!auth.loggedIn && !/(?:^|;\s*)kg_mid=/i.test(normalized)) {
          sendJson(res, { provider: 'kugou', loggedIn: false, error: 'INVALID_KUGOU_COOKIE' }, 400);
          return true;
        }
        saveKugouCookie(normalized);
        const info = await kugou.getKugouLoginInfo(kugouCookie);
        if (info.authExpired) {
          saveKugouCookie('');
          sendJson(res, publicProviderStatus({
            ...info,
            ok: false,
            saved: false,
            sessionPersisted: false,
            message: '酷狗音乐登录凭据已失效，请重新登录',
          }), 401);
          return true;
        }
        sendJson(res, publicProviderStatus({
          ...info,
          ok: true,
          saved: true,
          sessionPersisted: true,
          partial: auth.loggedIn && !auth.playbackReady,
        }));
        return true;
      }
      if (pathname === '/api/kugou/logout') {
        saveKugouCookie('');
        sendJson(res, { provider: 'kugou', loggedIn: false, ok: true });
        return true;
      }
      if (pathname === '/api/kugou/user/playlists') {
        sendJson(res, await kugou.handleKugouUserPlaylists(kugouCookie));
        return true;
      }
      if (pathname === '/api/kugou/playlist/tracks') {
        const paged = url.searchParams.has('limit') || url.searchParams.has('offset');
        const opts = paged ? {
          limit: numberParam(url, 'limit', 50, 10, 50),
          offset: numberParam(url, 'offset', 0, 0, 100000),
          paged: true,
        } : {};
        sendJson(res, await kugou.handleKugouPlaylistTracks(
          url.searchParams.get('id') || url.searchParams.get('global_collection_id') || '',
          kugouCookie,
          opts
        ));
        return true;
      }
      if (pathname === '/api/kugou/song/like/check') {
        sendJson(res, await kugou.handleKugouLikeCheck({
          hashes: url.searchParams.get('hashes') || url.searchParams.get('hash') || '',
        }, kugouCookie));
        return true;
      }
      if (pathname === '/api/kugou/song/like') {
        const body = await readJsonBody(req);
        sendJson(res, await kugou.handleKugouLikeToggle(body.song || body, body.like !== false, kugouCookie));
        return true;
      }
      if (pathname === '/api/kugou/playlist/add-song') {
        const body = await readJsonBody(req);
        const playlistId = body.pid || body.playlistId || '';
        if (!playlistId) {
          sendJson(res, { provider: 'kugou', success: false, error: 'PLAYLIST_ID_REQUIRED' }, 400);
          return true;
        }
        sendJson(res, await kugou.handleKugouPlaylistAddSong(playlistId, body.song || body, kugouCookie));
        return true;
      }

      if (pathname === '/api/qishui/status' || pathname === '/api/qishui/login/status') {
        const info = await qishui.handleQishuiStatus(qishuiCookie);
        if (info.authExpired) saveQishuiCookie('');
        sendJson(res, publicProviderStatus(info));
        return true;
      }
      if (pathname === '/api/qishui/login/token') {
        const body = await readJsonBody(req);
        sendJson(res, publicProviderStatus(qishui.saveQishuiAccessToken(body.token || body.accessToken || body.access_token || '')));
        return true;
      }
      if (pathname === '/api/qishui/login/cookie') {
        const body = await readJsonBody(req);
        const normalized = qishui.normalizeQishuiCookieInput(body.cookie || body.data || body.text || '');
        if (!qishui.qishuiCookieHasLogin(normalized)) {
          sendJson(res, { provider: 'qishui', loggedIn: false, error: 'INVALID_QISHUI_COOKIE' }, 400);
          return true;
        }
        saveQishuiCookie(normalized);
        const info = await qishui.handleQishuiStatus(qishuiCookie);
        if (info.authExpired) {
          saveQishuiCookie('');
          sendJson(res, publicProviderStatus({
            ...info,
            ok: false,
            saved: false,
            sessionPersisted: false,
            message: '汽水音乐登录凭据已失效，请重新导入',
          }), 401);
          return true;
        }
        sendJson(res, publicProviderStatus({
          ...info,
          ok: true,
          saved: true,
          sessionPersisted: true,
        }));
        return true;
      }
      if (pathname === '/api/qishui/logout') {
        saveQishuiCookie('');
        sendJson(res, publicProviderStatus({ ...qishui.clearQishuiAccessToken(), webSession: false, cookieReady: false }));
        return true;
      }
      if (pathname === '/api/qishui/search') {
        sendJson(res, await qishui.handleQishuiSearch(
          url.searchParams.get('keywords') || '',
          numberParam(url, 'limit', 12, 4, 20),
          qishuiCookie,
          numberParam(url, 'offset', 0, 0, 100000)
        ));
        return true;
      }
      if (pathname === '/api/qishui/feed') {
        sendJson(res, await qishui.handleQishuiFeed(numberParam(url, 'limit', 8, 4, 12), qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/user/playlists') {
        sendJson(res, await qishui.handleQishuiUserPlaylists(qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/playlist/tracks') {
        const hasPaging = url.searchParams.has('limit') || url.searchParams.has('offset');
        sendJson(res, await qishui.handleQishuiPlaylistTracks(
          url.searchParams.get('id') || 'qishui-feed',
          hasPaging ? {
            limit: numberParam(url, 'limit', 50, 1, 100),
            offset: numberParam(url, 'offset', 0, 0, 100000),
          } : {},
          qishuiCookie
        ));
        return true;
      }
      if (pathname === '/api/qishui/song/like/check') {
        const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '').split(',').map(item => item.trim()).filter(Boolean);
        sendJson(res, await qishui.handleQishuiCheckTracksLiked(ids, qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/song/like') {
        const body = await readJsonBody(req);
        const song = body.song || body;
        sendJson(res, await qishui.handleQishuiSetTrackLiked(song.providerSongId || song.trackId || song.id || '', body.like !== false, qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/playlist/collect') {
        const body = await readJsonBody(req);
        sendJson(res, await qishui.handleQishuiSetPlaylistCollected(body.id || body.playlistId || '', body.collected !== false, qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/playlist/add-song') {
        const body = await readJsonBody(req);
        sendJson(res, await qishui.handleQishuiPlaylistAddSong(body.id || body.pid || body.playlistId || '', body.song || body, qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/album/collect') {
        const body = await readJsonBody(req);
        sendJson(res, await qishui.handleQishuiSetAlbumCollected(body.id || body.albumId || '', body.collected !== false, qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/listen/report') {
        const body = await readJsonBody(req);
        const song = body.song || body;
        sendJson(res, await qishui.handleQishuiReportRecentlyPlayed(
          song.providerSongId || song.trackId || song.id || '',
          qishuiCookie
        ));
        return true;
      }
      if (pathname === '/api/qishui/song/comments') {
        const id = url.searchParams.get('id') || url.searchParams.get('trackId') || '';
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          sendJson(res, await qishui.handleQishuiCreateComment(id || body.id || body.trackId || '', body.content || body.text || '', qishuiCookie));
        } else {
          sendJson(res, await qishui.handleQishuiComments(id, {
            limit: numberParam(url, 'limit', 18, 1, 50),
            cursor: url.searchParams.get('cursor') || '',
          }, qishuiCookie));
        }
        return true;
      }
      if (pathname === '/api/qishui/song/url') {
        sendJson(res, await qishui.handleQishuiSongUrl({
          id: url.searchParams.get('id') || url.searchParams.get('trackId') || '',
          quality: url.searchParams.get('quality') || '',
          vipRequired: url.searchParams.get('vipRequired') || '',
          needVip: url.searchParams.get('needVip') || '',
          onlyVipPlayable: url.searchParams.get('onlyVipPlayable') || '',
          privilege: url.searchParams.get('privilege') || '',
          fee: url.searchParams.get('fee') || '',
        }, qishuiCookie));
        return true;
      }
      if (pathname === '/api/qishui/lyric') {
        sendJson(res, await qishui.handleQishuiLyric(url.searchParams.get('id') || url.searchParams.get('trackId') || '', qishuiCookie));
        return true;
      }

      if (pathname === '/api/spotify/status') {
        sendJson(res, publicProviderStatus(await spotify.handleSpotifyStatus()));
        return true;
      }
      if (pathname === '/api/spotify/config') {
        const saved = spotify.saveSpotifyConfig(await readJsonBody(req));
        sendJson(res, publicProviderStatus({ ...(await spotify.handleSpotifyStatus()), ...saved, ok: true }));
        return true;
      }
      if (pathname === '/api/spotify/logout') {
        sendJson(res, spotify.clearSpotifyToken());
        return true;
      }
      if (pathname === '/api/spotify/search') {
        sendJson(res, await spotify.handleSpotifySearch(
          url.searchParams.get('keywords') || '',
          numberParam(url, 'limit', 10, 4, 20),
          numberParam(url, 'offset', 0, 0, 100000)
        ));
        return true;
      }
      if (pathname === '/api/spotify/recommendations') {
        sendJson(res, await spotify.handleSpotifyRecommendations(numberParam(url, 'limit', 10, 4, 10)));
        return true;
      }
      if (pathname === '/api/spotify/user/playlists') {
        sendJson(res, await spotify.handleSpotifyUserPlaylists({
          limit: numberParam(url, 'limit', 300, 1, 500),
          offset: numberParam(url, 'offset', 0, 0, 100000),
        }));
        return true;
      }
      if (pathname === '/api/spotify/playlist/tracks') {
        sendJson(res, await spotify.handleSpotifyPlaylistTracks(
          url.searchParams.get('id') || url.searchParams.get('playlistId') || '',
          {
            limit: numberParam(url, 'limit', 48, 1, 100),
            offset: numberParam(url, 'offset', 0, 0, 100000),
            market: url.searchParams.get('market') || '',
          }
        ));
        return true;
      }
      if (pathname === '/api/spotify/album/detail') {
        sendJson(res, await spotify.handleSpotifyAlbumDetail(
          url.searchParams.get('id') || url.searchParams.get('albumId') || '',
          { limit: numberParam(url, 'limit', 80, 1, 100), market: url.searchParams.get('market') || '' }
        ));
        return true;
      }
      if (pathname === '/api/spotify/song/like/check' || pathname === '/api/spotify/album/like/check') {
        const type = pathname.includes('/album/') ? 'album' : 'track';
        const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '').split(',').map(item => item.trim()).filter(Boolean);
        sendJson(res, await spotify.handleSpotifyLibraryCheck(type, ids));
        return true;
      }
      if (pathname === '/api/spotify/song/like' || pathname === '/api/spotify/album/like') {
        const type = pathname.includes('/album/') ? 'album' : 'track';
        const body = await readJsonBody(req);
        sendJson(res, await spotify.handleSpotifyLibrarySet(type, body.song || body.album || body, body.like !== false));
        return true;
      }
      if (pathname === '/api/spotify/playlist/add-song') {
        const body = await readJsonBody(req);
        sendJson(res, await spotify.handleSpotifyPlaylistAddSong(body.pid || body.playlistId || '', body.song || body));
        return true;
      }
      if (pathname === '/api/spotify/playlist/create') {
        const body = await readJsonBody(req);
        sendJson(res, await spotify.handleSpotifyCreatePlaylist(body.name || '', {
          public: body.public === true,
          description: body.description || '',
        }));
        return true;
      }
      if (pathname === '/api/spotify/playlist/collect') {
        const body = await readJsonBody(req);
        sendJson(res, await spotify.handleSpotifyLibrarySet('playlist', body, body.collected !== false));
        return true;
      }
      if (pathname === '/api/spotify/song/url') {
        sendJson(res, await spotify.handleSpotifySongUrl({
          id: url.searchParams.get('id') || '',
          providerSongId: url.searchParams.get('providerSongId') || '',
          spotifyId: url.searchParams.get('spotifyId') || '',
          uri: url.searchParams.get('uri') || '',
        }));
        return true;
      }
      if (pathname === '/api/spotify/lyric') {
        sendJson(res, await spotify.handleSpotifyLyric(url.searchParams.get('id') || ''));
        return true;
      }
    } catch (error) {
      const provider = pathname.includes('/kugou/') ? 'kugou' : (pathname.includes('/qishui/') ? 'qishui' : 'spotify');
      sendJson(res, {
        provider,
        ok: false,
        error: String(error && (error.code || error.message) || 'PROVIDER_REQUEST_FAILED'),
        message: String(error && error.message || 'Provider request failed'),
      }, errorStatus(error));
      return true;
    }

    return false;
  }

  async function searchTyped(provider, type, keywords, limit, offset) {
    if (provider === 'kugou') {
      return kugou.handleKugouTypedSearch(keywords, type, limit, kugouCookie, offset);
    }
    if (provider === 'qishui') {
      return qishui.handleQishuiTypedSearch(keywords, type, limit, qishuiCookie, offset);
    }
    if (provider === 'spotify') {
      return spotify.handleSpotifyTypedSearch(keywords, type, limit, offset);
    }
    return {
      provider,
      source: provider,
      type,
      items: [],
      total: 0,
      rawCount: 0,
      offset,
      limit,
      nextOffset: offset,
      hasMore: false,
      error: 'INVALID_SEARCH_PROVIDER',
    };
  }

  return {
    handle,
    searchTyped,
    getCookies: () => ({ kugou: kugouCookie, qishui: qishuiCookie }),
  };
}

module.exports = {
  HANDLED_ROUTES,
  MUTATING_POST_ROUTES,
  POST_ONLY_ROUTES,
  createProviderRoutes,
  publicProviderStatus,
};
