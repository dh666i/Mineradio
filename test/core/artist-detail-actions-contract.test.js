'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('artist detail exposes a guarded action capped at 100 hot songs', () => {
  const artistActions = sourceBetween(
    indexSource,
    'function syncArtistDetailActions',
    'function collectArtistDetailSong',
  );
  const artistModal = sourceBetween(
    indexSource,
    'function openTrackDetailModal',
    'function openArtistDetailForSong',
  );

  assert.match(indexSource, /\.detail-play-all:disabled\{opacity:\.38;cursor:default;pointer-events:none\}/);
  assert.match(artistActions, /playAllButton\.disabled = loaded < 1 \|\| artistDetailState\.loading \|\| artistDetailState\.playAllBusy/);
  assert.match(artistActions, /detailArtistSongs = \(songs \|\| \[\]\)\.map\(cloneSong\);\s*syncArtistDetailActions\(\)/);
  assert.match(artistActions, /playQueue = detailArtistSongs\.map\(cloneSong\);\s*currentIdx = i/);
  assert.match(artistActions, /async function playArtistDetailAll\(\)/);
  assert.match(artistActions, /pager\.collectPaged/);
  assert.match(artistActions, /initialItems: detailArtistSongs/);
  assert.match(indexSource, /var ARTIST_DETAIL_PLAY_LIMIT = 100/);
  assert.match(artistActions, /limit: pageLimit,\s*maxItems: ARTIST_DETAIL_PLAY_LIMIT,\s*maxPages: 10/);
  assert.match(artistActions, /ensureArtistPlayAllActive\(token\)/);
  assert.match(artistActions, /error\.partialResult && error\.partialResult\.items \|\| detailArtistSongs/);
  assert.match(
    artistModal,
    /id="artist-detail-play-all"[\s\S]*?onclick="playArtistDetailAll\(\)"[\s\S]*?id="artist-detail-play-all-label">播放前100首<\/span>/,
  );
});

test('artist detail clears stale actions while loading and on lookup failure', () => {
  const artistModal = sourceBetween(
    indexSource,
    'function openTrackDetailModal',
    'function openArtistDetailForSong',
  );

  assert.match(artistModal, /if \(type === 'artist'\) \{\s*detailArtistSongs = \[\]/);
  assert.match(artistModal, /artistDetailState = \{[\s\S]*?token: seq/);
  assert.match(artistModal, /syncArtistDetailActions\('不可用'\)/);
  assert.match(artistModal, /syncArtistDetailActions\('加载失败'\)/);
  assert.match(artistModal, /artistSongMarkup = renderArtistSongList\(r\.songs \|\| \[\]\)/);
  assert.match(artistModal, /var directArtistEntry = \/\^artist:/);
  assert.match(artistModal, /artist-detail-music-size/);
  assert.match(artistModal, /artist-detail-brief/);
});
