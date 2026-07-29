'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const v150Source = fs.readFileSync(path.join(root, 'public', 'js', 'v150.js'), 'utf8');
const desktopSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const wallpaperSource = fs.readFileSync(path.join(root, 'public', 'wallpaper.html'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadImageUrlHelpers() {
  const helperSource = sourceBetween(
    indexSource,
    'function escapeHtmlAttribute',
    'function normalizePlaybackQuality'
  );
  const coverHelperSource = sourceBetween(
    indexSource,
    'function isInlineCoverSrc',
    'function songCustomCoverKey'
  );
  const context = {
    URL,
    window: {
      location: {
        href: 'http://127.0.0.1:37210/index.html',
        origin: 'http://127.0.0.1:37210',
      },
    },
  };
  vm.runInNewContext(
    `${helperSource}\n${coverHelperSource}\nthis.imageUrlHelpers = { escapeHtmlAttribute, normalizeSafeImageUrl, safeRenderableImageUrl, safeImageAttr, safeCssImageUrl, safeCssImageStyleAttr, persistentSongCoverValue, coverProxySrc, coverUrlWithSize };`,
    context
  );
  return context.imageUrlHelpers;
}

test('image URL normalization allows supported remote and same-origin sources', () => {
  const helpers = loadImageUrlHelpers();

  assert.equal(
    helpers.normalizeSafeImageUrl('https://cdn.example.test/cover.jpg?size=400'),
    'https://cdn.example.test/cover.jpg?size=400'
  );
  assert.equal(
    helpers.normalizeSafeImageUrl('http://cdn.example.test/cover.png'),
    'http://cdn.example.test/cover.png'
  );
  assert.equal(
    helpers.normalizeSafeImageUrl('/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fa.jpg'),
    'http://127.0.0.1:37210/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fa.jpg'
  );
  assert.equal(
    helpers.normalizeSafeImageUrl('assets/placeholder.png'),
    'http://127.0.0.1:37210/assets/placeholder.png'
  );
  assert.equal(
    helpers.coverProxySrc('/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fa.jpg'),
    'http://127.0.0.1:37210/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fa.jpg'
  );
  assert.equal(
    helpers.coverProxySrc('http://127.0.0.1:37210/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fa.jpg'),
    'http://127.0.0.1:37210/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fa.jpg'
  );
});

test('image URL normalization preserves local blob and generated image data', () => {
  const helpers = loadImageUrlHelpers();
  const blobUrl = 'blob:http://127.0.0.1:37210/8a661622-a3bf-4c87-b3a8-47465a230077';
  const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const jpegData = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const webpData = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TA==';
  const generatedSvg = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#111"/></svg>'
  );

  assert.equal(helpers.normalizeSafeImageUrl(blobUrl), blobUrl);
  assert.equal(helpers.normalizeSafeImageUrl(pngData), pngData);
  assert.equal(helpers.normalizeSafeImageUrl(jpegData), jpegData);
  assert.equal(helpers.normalizeSafeImageUrl(webpData), webpData);
  assert.equal(helpers.coverProxySrc(blobUrl), blobUrl);
  assert.equal(helpers.coverProxySrc(pngData), pngData);
  assert.equal(helpers.coverUrlWithSize(blobUrl, 400), blobUrl);
  assert.equal(helpers.coverUrlWithSize(pngData, 400), pngData);
  assert.equal(helpers.normalizeSafeImageUrl(generatedSvg), '');
  assert.equal(
    helpers.normalizeSafeImageUrl(generatedSvg, { allowSvgData: true }),
    generatedSvg
  );
});

test('image URL normalization rejects active content and attribute escapes', () => {
  const helpers = loadImageUrlHelpers();
  const unsafeSvg = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'
  );
  const linkedSvg = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="&#x6a;avascript:alert(1)"/></svg>'
  );
  const styledSvg = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://evil.example/x)}</style></svg>'
  );
  const foreignSvg = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>unsafe</div></foreignObject></svg>'
  );
  const animatedSvg = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="javascript:alert(1)"/></svg>'
  );
  const rejected = [
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'ftp://cdn.example.test/cover.jpg',
    'data:text/html,<script>alert(1)</script>',
    '/api/logout',
    'http://127.0.0.1:37210/api/logout',
    'http://127.0.0.1:37211/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fa.jpg',
    'http://localhost:37210/api/logout',
    'http://player.localhost:37210/assets/placeholder.png',
    'http://[::1]:37210/api/logout',
    'https://user:password@cdn.example.test/cover.jpg',
    '//evil.example/cover.jpg',
    '\\\\evil.example\\cover.jpg',
    'blob:null/8a661622-a3bf-4c87-b3a8-47465a230077',
    'blob:http://localhost:37210/8a661622-a3bf-4c87-b3a8-47465a230077',
    'blob:http://127.0.0.1:37211/8a661622-a3bf-4c87-b3a8-47465a230077',
    'blob:https://evil.example/8a661622-a3bf-4c87-b3a8-47465a230077',
    'https://cdn.example.test/cover.jpg" onerror="alert(1)',
    "https://cdn.example.test/cover.jpg' onerror='alert(1)",
    'https://cdn.example.test/cover.jpg` onerror=`alert(1)',
    'https://cdn.example.test/cover.jpg\nonerror=alert(1)',
    '\u007fhttps://cdn.example.test/cover.jpg',
    '\u0085https://cdn.example.test/cover.jpg',
  ];

  rejected.forEach((value) => {
    assert.equal(helpers.normalizeSafeImageUrl(value, { allowSvgData: true }), '', value);
  });
  assert.equal(helpers.normalizeSafeImageUrl(unsafeSvg, { allowSvgData: true }), '');
  assert.equal(helpers.normalizeSafeImageUrl(linkedSvg, { allowSvgData: true }), '');
  assert.equal(helpers.normalizeSafeImageUrl(styledSvg, { allowSvgData: true }), '');
  assert.equal(helpers.normalizeSafeImageUrl(foreignSvg, { allowSvgData: true }), '');
  assert.equal(helpers.normalizeSafeImageUrl(animatedSvg, { allowSvgData: true }), '');
});

test('image URL normalization rejects literal private and reserved network targets', () => {
  const helpers = loadImageUrlHelpers();
  const rejected = [
    'http://0.0.0.0/cover.jpg',
    'http://10.20.30.40/cover.jpg',
    'http://100.64.0.1/cover.jpg',
    'http://127.0.0.1/cover.jpg',
    'http://169.254.169.254/latest/meta-data',
    'http://172.31.255.255/cover.jpg',
    'http://192.0.0.1/cover.jpg',
    'http://192.168.1.1/cover.jpg',
    'http://198.18.0.1/cover.jpg',
    'http://198.51.100.2/cover.jpg',
    'http://203.0.113.9/cover.jpg',
    'http://224.0.0.1/cover.jpg',
    'http://240.0.0.1/cover.jpg',
    'http://2130706433/cover.jpg',
    'http://0x7f000001/cover.jpg',
    'http://[::]/cover.jpg',
    'http://[::1]/cover.jpg',
    'http://[::ffff:192.168.1.2]/cover.jpg',
    'http://[fc00::1]/cover.jpg',
    'http://[fd12:3456::1]/cover.jpg',
    'http://[fe80::1]/cover.jpg',
    'http://[fec0::1]/cover.jpg',
    'http://[ff02::1]/cover.jpg',
    'http://[64:ff9b::808:808]/cover.jpg',
    'http://[100::1]/cover.jpg',
    'http://[2001:db8::1]/cover.jpg',
    'http://[2002:7f00:1::]/cover.jpg',
    'http://[3fff::1]/cover.jpg',
  ];

  rejected.forEach((value) => {
    assert.equal(helpers.normalizeSafeImageUrl(value), '', value);
  });
  assert.equal(
    helpers.normalizeSafeImageUrl('https://8.8.8.8/cover.jpg'),
    'https://8.8.8.8/cover.jpg'
  );
  assert.equal(
    helpers.normalizeSafeImageUrl('https://[2606:4700:4700::1111]/cover.jpg'),
    'https://[2606:4700:4700::1111]/cover.jpg'
  );
});

test('image attributes and inline CSS proxy remote sources and encode their output context', () => {
  const helpers = loadImageUrlHelpers();

  assert.equal(
    helpers.escapeHtmlAttribute('&<>"\''),
    '&amp;&lt;&gt;&quot;&#39;'
  );
  assert.equal(
    helpers.safeImageAttr('https://cdn.example.test/cover.jpg?x=1&y=2'),
    '/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fcover.jpg%3Fx%3D1%26y%3D2'
  );
  assert.equal(
    helpers.safeCssImageStyleAttr('https://cdn.example.test/cover.jpg?x=1&y=2'),
    'background-image:url(&quot;/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fcover.jpg%3Fx%3D1%26y%3D2&quot;)'
  );
  assert.equal(
    helpers.safeCssImageUrl('https://cdn.example.test/cover.jpg?x=1&y=2'),
    '/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fcover.jpg%3Fx%3D1%26y%3D2'
  );
  assert.equal(
    helpers.safeImageAttr('/api/cover?url=test&v=1'),
    'http://127.0.0.1:37210/api/cover?url=test&amp;v=1'
  );
  assert.equal(
    helpers.coverUrlWithSize('https://cdn.example.test/cover.jpg', 400),
    '/api/cover?url=https%3A%2F%2Fcdn.example.test%2Fcover.jpg%3Fparam%3D400y400'
  );
  const entityAttempt = helpers.safeImageAttr(
    'https://cdn.example.test/&quot; onerror=alert(1)'
  );
  assert.match(entityAttempt, /%26quot%3B/);
  assert.doesNotMatch(entityAttempt, /(?:^|[^&])&quot;|onerror=/);
});

test('persisted song covers stay independent from the current local server port', () => {
  const helpers = loadImageUrlHelpers();
  const remote = 'https://cdn.example.test/cover.jpg?size=400';

  assert.equal(
    helpers.persistentSongCoverValue(
      'http://127.0.0.1:3917/api/cover?url=' + encodeURIComponent(remote)
    ),
    remote
  );
  assert.equal(
    helpers.persistentSongCoverValue('/api/cover?url=' + encodeURIComponent(remote)),
    remote
  );
  assert.equal(helpers.persistentSongCoverValue('/assets/placeholder.png'), '/assets/placeholder.png');
  assert.equal(helpers.persistentSongCoverValue('blob:http://127.0.0.1:37210/dead'), '');
  assert.equal(
    helpers.persistentSongCoverValue(
      'http://127.0.0.1:3917/api/cover?url=' + encodeURIComponent('http://192.168.1.1/private.jpg')
    ),
    ''
  );
});

test('external image metadata renderers use the safe image context helpers', () => {
  const renderContracts = [
    ['function renderDailyRecommendDetail()', 'function compactHomeCount', /safeImageAttr\(cover\)/],
    ['function renderHomeTiles()', 'function renderHomeDiscover()', /safeCssImageStyleAttr\(cover\)/],
    ['function renderDetailComments(comments)', 'function syncArtistDetailActions', /safeImageAttr\(user\.avatar/],
    ['function renderArtistSongList(songs)', 'function playArtistDetailSong', /safeImageAttr\(cover\)/],
    ['function openTrackDetailModal(type, songOverride)', 'function updateCustomCoverButton', /safeImageAttr\(cover\)/],
    ['function renderCollectModal()', 'async function addCollectTargetToPlaylist', /safeImageAttr\(songCoverSrc/],
    ['function searchThumbHtml(src)', 'function renderPodcastRadios', /safeImageAttr\(coverUrlWithSize/],
    ['function renderSongSearchResults(songs)', 'function searchBatchVersionKey', /safeImageAttr\(songCoverSrc/],
    ['function renderMiniQueuePanel(opts)', "document.addEventListener('click'", /safeImageAttr\(songCoverSrc/],
    ['function renderQueuePanel(opts)', 'async function refreshUserPlaylists', /safeImageAttr\(songCoverSrc/],
    ['function playlistPanelDetailHtml(pl, provider)', 'function renderPlaylistPanelDetailState', /safeImageAttr\(songCoverSrc/],
    ['function renderUserPlaylistsList(opts)', 'function renderMyPodcastCollections', /safeImageAttr\(pl\.cover/],
    ['function renderMyPodcastCollections(opts)', "document.getElementById('pl-list')", /safeImageAttr\(pc\.cover/],
    ['function renderMyPodcastRadioItems(key, title, items)', 'async function openMyPodcastCollection', /safeImageAttr\(r\.cover/],
    ['function renderUserBtn()', 'async function showLoginModal', /safeImageAttr\(providerAvatarSrc/],
    ['function updateUserModalUi()', 'function showUserModal', /safeRenderableImageUrl\(providerAvatarSrc/],
  ];

  renderContracts.forEach(([start, end, expected]) => {
    assert.match(sourceBetween(indexSource, start, end), expected, start);
  });
});

test('discovery cards proxy external covers before rendering', () => {
  const browseCards = sourceBetween(
    v150Source,
    'function browseCardMarkup(item, index, kind)',
    'function songRowsMarkup(items, prefix)'
  );
  const songRows = sourceBetween(
    v150Source,
    'function songRowsMarkup(items, prefix)',
    'function renderDiscoverList()'
  );

  assert.match(browseCards, /window\.safeImageAttr\(cover\)/);
  assert.doesNotMatch(browseCards, /src="' \+ html\(cover\)/);
  assert.match(songRows, /window\.safeImageAttr\(cover\)/);
  assert.doesNotMatch(songRows, /src="' \+ html\(cover\)/);
});

test('renderer CSP disallows remote code and keeps required local/blob capabilities', () => {
  const match = indexSource.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i
  );
  assert.ok(match, 'missing Content-Security-Policy meta');
  const policy = match[1];

  assert.match(policy, /(?:^|;\s*)script-src 'self' 'unsafe-inline'(?:;|$)/);
  assert.match(policy, /(?:^|;\s*)worker-src 'self' blob:(?:;|$)/);
  assert.match(policy, /(?:^|;\s*)img-src 'self' data: blob:(?:;|$)/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /script-src[^;]*https?:/);
  assert.doesNotMatch(indexSource, /cdn\.jsdelivr\.net|@xenova\/transformers|@mediapipe\//);

  const aiDepthSource = sourceBetween(
    indexSource,
    'async function ensureAIDepthPipeline()',
    'function makeAIDepthInputCanvas'
  );
  assert.doesNotMatch(aiDepthSource, /\bimport\s*\(|createElement\(['"]script/);

  const gestureSource = sourceBetween(
    indexSource,
    'async function startGestureControl()',
    'function stopGestureControl()'
  );
  assert.doesNotMatch(gestureSource, /loadScriptOnce|new Hands|new Camera|mediaDevices/);
  assert.match(indexSource, /id="cam-seg" hidden aria-hidden="true"/);
  assert.match(indexSource, /data-cam="gesture"[^>]*disabled/);
});

test('cover loader never falls back to the unproxied remote URL', () => {
  const loaderSource = sourceBetween(
    indexSource,
    'function loadCoverFromUrl(directUrl, opts)',
    'function setAlbumBackground(src)'
  );
  assert.match(loaderSource, /var proxiedUrl = coverProxySrc\(directUrl\)/);
  assert.match(loaderSource, /isInlineCoverSrc\(directUrl\)[\s\S]*applyCoverDataUrl\(directUrl, opts\)/);
  assert.doesNotMatch(loaderSource, /img2|\.src\s*=\s*directUrl/);
});

test('system media and wallpaper artwork cannot fall back to an unvalidated source', () => {
  const metadataSource = sourceBetween(
    indexSource,
    'function currentDesktopSongMeta()',
    'function systemMediaArtworkType(src)'
  );
  const wallpaperSanitizer = sourceBetween(
    desktopSource,
    'function sanitizeWallpaperCover(value)',
    'function clampNumber(value, min, max, fallback)'
  );

  assert.match(metadataSource, /cover:\s*safeRenderableImageUrl\(coverCandidate\)/);
  assert.match(metadataSource, /return safeRenderableImageUrl\(String\(raw/);
  assert.doesNotMatch(metadataSource, /songCoverSrc\(song,\s*360\)\s*\|\|\s*song\.cover/);
  assert.match(wallpaperSanitizer, /parsed\.pathname === '\/api\/cover'/);
  assert.match(wallpaperSanitizer, /parsed\.pathname\.startsWith\('\/assets\/'\)/);
  assert.match(wallpaperSanitizer, /parsed\.origin === expectedOrigin/);
  assert.match(wallpaperSource, /Content-Security-Policy[^>]+img-src 'self' data: blob:/);
});

test('custom background video settings accept only local data or stored media IDs', () => {
  const normalizer = sourceBetween(
    indexSource,
    'function normalizeCustomBackgroundMedia(value)',
    'function customBackgroundMediaLabel(media)'
  );

  assert.match(normalizer, /data:video\\\/\(mp4\|webm\|quicktime\)/);
  assert.doesNotMatch(normalizer, /https\?:\\\/\\\//);
});
