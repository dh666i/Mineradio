'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GOOGLE_AUTHORIZATION_ENDPOINT,
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
} = require('../../lib/youtube-oauth');

const CLIENT_ID = '1234567890-example.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret';

test('normalizes only installed OAuth client JSON and never exposes its secret', () => {
  const config = normalizeInstalledClientConfig(JSON.stringify({
    installed: {
      client_id: CLIENT_ID,
      project_id: 'mineradio-test',
      client_secret: CLIENT_SECRET,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  }));
  assert.deepEqual(config, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    projectId: 'mineradio-test',
  });
  const visible = publicClientConfig(config);
  assert.equal(visible.configured, true);
  assert.equal(visible.projectId, 'mineradio-test');
  assert.match(visible.clientIdHint, /\.\.\./);
  assert.equal(JSON.stringify(visible).includes(CLIENT_SECRET), false);

  assert.throws(() => normalizeInstalledClientConfig({
    web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
  }), { code: 'YOUTUBE_OAUTH_CLIENT_TYPE_INVALID' });
});

test('creates deterministic PKCE, state, and a complete authorization URL', () => {
  const fixed = size => Buffer.alloc(size, 0x5a);
  const pkce = createPkcePair(fixed);
  const state = createOAuthState(fixed);
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);

  const redirectUri = 'http://127.0.0.1:32123/api/youtube/oauth/callback';
  const target = new URL(buildAuthorizationUrl({
    clientId: CLIENT_ID,
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
  }));
  assert.equal(target.origin + target.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
  assert.equal(target.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(target.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(target.searchParams.get('state'), state);
  assert.equal(target.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('access_type'), 'offline');
  assert.equal(target.searchParams.has('include_granted_scopes'), false);
  assert.deepEqual(YOUTUBE_OAUTH_SCOPES, [
    'https://www.googleapis.com/auth/youtube.readonly',
  ]);
  assert.equal(target.searchParams.get('scope'), YOUTUBE_OAUTH_SCOPES[0]);
});

test('OAuth runtime no longer depends on Google profile scopes or userinfo', () => {
  const fs = require('node:fs');
  const serverSource = fs.readFileSync(require.resolve('../../server'), 'utf8');
  assert.doesNotMatch(serverSource, /GOOGLE_USERINFO_ENDPOINT|openidconnect\.googleapis\.com/);
});

test('matches the RFC 7636 S256 challenge vector and validates callback replay boundaries', () => {
  assert.equal(
    derivePkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const now = 1_700_000_000_000;
  const flow = {
    state: 'expected-state',
    verifier: 'verifier-value',
    redirectUri: 'http://127.0.0.1:32123/callback',
    createdAt: now,
  };
  assert.deepEqual(validateOAuthCallback({
    state: 'expected-state',
    code: 'authorization-code',
  }, flow, now + 1000), {
    ok: true,
    consume: true,
    error: '',
    code: 'authorization-code',
  });
  assert.equal(validateOAuthCallback({ state: 'wrong', code: 'code' }, flow, now).consume, false);
  assert.equal(
    validateOAuthCallback({ state: 'expected-state', error: 'access_denied' }, flow, now).error,
    'YOUTUBE_OAUTH_ACCESS_DENIED',
  );
  assert.equal(
    validateOAuthCallback({ state: 'expected-state', code: 'code' }, flow, now + 11 * 60_000).error,
    'YOUTUBE_OAUTH_FLOW_EXPIRED',
  );
});

test('builds Google authorization-code and refresh form bodies', () => {
  const authBody = authorizationCodeTokenBody({
    code: 'auth-code',
    redirectUri: 'http://127.0.0.1:32123/callback',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    codeVerifier: 'verifier',
  });
  assert.equal(authBody.get('grant_type'), 'authorization_code');
  assert.equal(authBody.get('code'), 'auth-code');
  assert.equal(authBody.get('client_secret'), CLIENT_SECRET);
  assert.equal(authBody.get('code_verifier'), 'verifier');

  const refreshBody = refreshTokenBody({
    refreshToken: 'refresh-token',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.equal(refreshBody.get('refresh_token'), 'refresh-token');
  assert.equal(refreshBody.get('client_secret'), CLIENT_SECRET);
  assert.equal(refreshBody.has('code_verifier'), false);
});

test('validates state, flow expiry, and token lifetime conservatively', () => {
  const now = 1_700_000_000_000;
  const flow = {
    state: 'state-value',
    verifier: 'verifier-value',
    redirectUri: 'http://127.0.0.1:32123/callback',
    createdAt: now,
  };
  assert.equal(timingSafeTextEqual('state-value', 'state-value'), true);
  assert.equal(timingSafeTextEqual('state-value', 'state-other'), false);
  assert.equal(isOAuthFlowFresh(flow, now + 60_000), true);
  assert.equal(isOAuthFlowFresh(flow, now + 11 * 60_000), false);

  const tokens = normalizeTokenPayload({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
  }, null, now);
  assert.equal(hasRefreshToken(tokens), true);
  assert.equal(hasUsableAccessToken(tokens, now), true);
  assert.equal(hasUsableAccessToken(tokens, now + 3_599_000), false);
});

test('preserves refresh token across access-token refresh and maps account metadata', () => {
  const now = 1_700_000_000_000;
  const refreshed = normalizeTokenPayload({
    access_token: 'new-access',
    expires_in: 1800,
  }, {
    refreshToken: 'old-refresh',
    clientId: CLIENT_ID,
    account: { id: 'old' },
  }, now);
  assert.equal(refreshed.refreshToken, 'old-refresh');
  assert.equal(refreshed.clientId, CLIENT_ID);
  assert.deepEqual(refreshed.account, { id: 'old' });
  const switchedAccount = normalizeTokenPayload({
    access_token: 'new-account-access',
    expires_in: 1800,
  }, null, now);
  assert.equal(switchedAccount.refreshToken, '');
  assert.equal(switchedAccount.account, null);

  const account = mapYouTubeAccount({
    id: 'UC123',
    snippet: {
      title: 'Mineradio Test',
      customUrl: '@mineradio',
      thumbnails: { high: { url: 'https://example.test/avatar.jpg' } },
    },
    contentDetails: {
      relatedPlaylists: { likes: 'LL123', uploads: 'UU123' },
    },
    statistics: { subscriberCount: '12', videoCount: '34', playlistCount: '5' },
  });
  assert.deepEqual(account, {
    id: 'UC123',
    channelId: 'UC123',
    name: 'Mineradio Test',
    avatar: 'https://example.test/avatar.jpg',
    description: '',
    customUrl: '@mineradio',
    subscriberCount: 12,
    videoCount: 34,
    playlistCount: 5,
    likesPlaylistId: 'LL123',
    uploadsPlaylistId: 'UU123',
    provider: 'youtube',
  });
});
