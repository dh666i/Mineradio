'use strict';

const crypto = require('node:crypto');

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const YOUTUBE_OAUTH_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly',
]);
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function oauthError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const raw = text(value);
  if (!raw) throw oauthError('YOUTUBE_OAUTH_CONFIG_INVALID', '请选择 Google OAuth 桌面客户端 JSON');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (_) {
    throw oauthError('YOUTUBE_OAUTH_CONFIG_INVALID', 'OAuth 客户端 JSON 格式不正确');
  }
}

function normalizeInstalledClientConfig(value) {
  const parsed = parseJsonObject(value);
  const installed = parsed.installed && typeof parsed.installed === 'object'
    ? parsed.installed
    : (parsed.clientId || parsed.client_id ? parsed : null);
  if (!installed || parsed.web) {
    throw oauthError('YOUTUBE_OAUTH_CLIENT_TYPE_INVALID', '请使用 Google OAuth“桌面应用”客户端 JSON');
  }
  const clientId = text(installed.client_id || installed.clientId);
  const clientSecret = text(installed.client_secret || installed.clientSecret);
  const projectId = text(installed.project_id || installed.projectId);
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw oauthError('YOUTUBE_OAUTH_CLIENT_ID_INVALID', 'OAuth 客户端 ID 格式不正确');
  }
  if (!clientSecret || clientSecret.length > 512) {
    throw oauthError('YOUTUBE_OAUTH_CLIENT_SECRET_INVALID', 'OAuth 桌面客户端 JSON 缺少 client_secret');
  }
  return { clientId, clientSecret, projectId };
}

function publicClientConfig(config) {
  config = config || {};
  return {
    configured: !!(text(config.clientId) && text(config.clientSecret)),
    clientIdHint: text(config.clientId).replace(/^(.{6}).*(.{12})$/, '$1...$2'),
    projectId: text(config.projectId),
  };
}

function base64Url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkcePair(randomBytes) {
  const source = typeof randomBytes === 'function' ? randomBytes(64) : crypto.randomBytes(64);
  const verifier = base64Url(source);
  const challenge = derivePkceChallenge(verifier);
  return { verifier, challenge, method: 'S256' };
}

function derivePkceChallenge(verifier) {
  verifier = text(verifier);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw oauthError('YOUTUBE_OAUTH_PKCE_INVALID', 'PKCE verifier 格式不正确');
  }
  return base64Url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

function createOAuthState(randomBytes) {
  const source = typeof randomBytes === 'function' ? randomBytes(32) : crypto.randomBytes(32);
  return base64Url(source);
}

function timingSafeTextEqual(expected, actual) {
  const left = Buffer.from(text(expected), 'utf8');
  const right = Buffer.from(text(actual), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isOAuthFlowFresh(flow, now) {
  now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const createdAt = Number(flow && flow.createdAt);
  return !!(flow && text(flow.state) && text(flow.verifier) && text(flow.redirectUri)
    && Number.isFinite(createdAt) && createdAt > 0 && now - createdAt >= 0
    && now - createdAt <= OAUTH_FLOW_TTL_MS);
}

function validateOAuthCallback(query, flow, now) {
  query = query || {};
  if (!isOAuthFlowFresh(flow, now)) {
    return { ok: false, consume: true, error: 'YOUTUBE_OAUTH_FLOW_EXPIRED', code: '' };
  }
  if (!timingSafeTextEqual(flow.state, query.state)) {
    return { ok: false, consume: false, error: 'YOUTUBE_OAUTH_STATE_INVALID', code: '' };
  }
  const providerError = text(query.error);
  if (providerError) {
    return {
      ok: false,
      consume: true,
      error: providerError === 'access_denied'
        ? 'YOUTUBE_OAUTH_ACCESS_DENIED'
        : 'YOUTUBE_OAUTH_TOKEN_EXCHANGE_FAILED',
      code: '',
    };
  }
  const code = text(query.code);
  if (!code || code.length > 8192) {
    return { ok: false, consume: true, error: 'YOUTUBE_OAUTH_STATE_INVALID', code: '' };
  }
  return { ok: true, consume: true, error: '', code };
}

function buildAuthorizationUrl(options) {
  options = options || {};
  const clientId = text(options.clientId);
  const redirectUri = text(options.redirectUri);
  const state = text(options.state);
  const codeChallenge = text(options.codeChallenge);
  if (!clientId || !redirectUri || !state || !codeChallenge) {
    throw oauthError('YOUTUBE_OAUTH_REQUEST_INVALID', 'OAuth 授权参数不完整');
  }
  const target = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  target.searchParams.set('client_id', clientId);
  target.searchParams.set('redirect_uri', redirectUri);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('scope', (options.scopes || YOUTUBE_OAUTH_SCOPES).join(' '));
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', codeChallenge);
  target.searchParams.set('code_challenge_method', 'S256');
  target.searchParams.set('access_type', 'offline');
  target.searchParams.set('prompt', options.prompt || 'consent');
  return target.toString();
}

function authorizationCodeTokenBody(options) {
  options = options || {};
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', text(options.code));
  body.set('redirect_uri', text(options.redirectUri));
  body.set('client_id', text(options.clientId));
  body.set('client_secret', text(options.clientSecret));
  body.set('code_verifier', text(options.codeVerifier));
  return body;
}

function refreshTokenBody(options) {
  options = options || {};
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', text(options.refreshToken));
  body.set('client_id', text(options.clientId));
  body.set('client_secret', text(options.clientSecret));
  return body;
}

function normalizeTokenPayload(payload, previous, now) {
  payload = payload && typeof payload === 'object' ? payload : {};
  previous = previous && typeof previous === 'object' ? previous : {};
  now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const accessToken = text(payload.access_token || previous.accessToken);
  const refreshToken = text(payload.refresh_token || previous.refreshToken);
  const clientId = text(payload.client_id || payload.clientId || previous.clientId);
  const expiresIn = Math.max(0, Number(payload.expires_in) || 0);
  const previousExpiry = Math.max(0, Number(previous.expiresAt) || 0);
  return {
    accessToken,
    refreshToken,
    clientId,
    tokenType: text(payload.token_type || previous.tokenType || 'Bearer'),
    scope: text(payload.scope || previous.scope),
    expiresAt: expiresIn ? now + expiresIn * 1000 : previousExpiry,
    account: previous.account && typeof previous.account === 'object' ? previous.account : null,
  };
}

function hasRefreshToken(tokens) {
  return !!text(tokens && tokens.refreshToken);
}

function hasUsableAccessToken(tokens, now, skewMs) {
  now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  skewMs = Number.isFinite(Number(skewMs)) ? Math.max(0, Number(skewMs)) : ACCESS_TOKEN_SKEW_MS;
  return !!(text(tokens && tokens.accessToken)
    && Number(tokens && tokens.expiresAt) > now + skewMs);
}

function mapYouTubeAccount(channel) {
  channel = channel || {};
  const snippet = channel.snippet || {};
  const contentDetails = channel.contentDetails || {};
  const related = contentDetails.relatedPlaylists || {};
  const statistics = channel.statistics || {};
  const thumbnails = snippet.thumbnails || {};
  const avatar = ['high', 'medium', 'default']
    .map(key => text(thumbnails[key] && thumbnails[key].url))
    .find(Boolean) || '';
  const id = text(channel.id);
  if (!id) return null;
  return {
    id,
    channelId: id,
    name: text(snippet.title) || 'YouTube 用户',
    avatar,
    description: text(snippet.description),
    customUrl: text(snippet.customUrl),
    subscriberCount: Math.max(0, Number(statistics.subscriberCount) || 0),
    videoCount: Math.max(0, Number(statistics.videoCount) || 0),
    playlistCount: Math.max(0, Number(statistics.playlistCount) || 0),
    likesPlaylistId: text(related.likes),
    uploadsPlaylistId: text(related.uploads),
    provider: 'youtube',
  };
}

module.exports = {
  ACCESS_TOKEN_SKEW_MS,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  OAUTH_FLOW_TTL_MS,
  YOUTUBE_OAUTH_SCOPES,
  authorizationCodeTokenBody,
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  derivePkceChallenge,
  hasRefreshToken,
  hasUsableAccessToken,
  isOAuthFlowFresh,
  mapYouTubeAccount,
  normalizeInstalledClientConfig,
  normalizeTokenPayload,
  publicClientConfig,
  refreshTokenBody,
  timingSafeTextEqual,
  validateOAuthCallback,
};
