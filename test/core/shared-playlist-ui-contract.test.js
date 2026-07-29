'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const scriptSource = fs.readFileSync(path.join(root, 'public', 'js', 'v155-shared-playlists.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('search detects share links after the existing search wrappers', () => {
  assert.match(indexSource, /<script src="js\/v150\.js"><\/script>[\s\S]*?<script src="js\/v155-shared-playlists\.js"><\/script>/);
  assert.match(scriptSource, /var legacyDoSearch = window\.doSearch/);
  assert.match(scriptSource, /looksLikeSharedPlaylist\(query\)/);
  assert.match(scriptSource, /\/api\/shared-playlist\/resolve/);
  assert.match(scriptSource, /resolved\.provider === 'kugou' \|\| resolved\.provider === 'qishui'/);
  assert.match(scriptSource, /Array\.isArray\(resolved\.tracks\)/);
  assert.match(scriptSource, /playlistTracksEndpoint\(resolved\.provider, resolved\.id\)/);
  assert.match(scriptSource, /\/api\/shared-playlist\/resolve[\s\S]*?timeoutMs:\s*30000/);
});

test('imported playlists persist separately and can be removed', () => {
  assert.match(scriptSource, /mineradio-imported-playlists-v1/);
  assert.match(scriptSource, /MAX_STORAGE_CHARS/);
  assert.match(scriptSource, /playlist\.imported = true/);
  assert.match(scriptSource, /window\.deleteImportedPlaylistRecord/);
  assert.match(indexSource, /data-delete-imported-playlist="1"/);
  assert.match(indexSource, /getImportedPlaylistRecord\(parsedShelfPlaylist\.provider, parsedShelfPlaylist\.id\)/);
});

test('shared playlist resolver is a trusted POST-only route', () => {
  assert.match(serverSource, /'\/api\/shared-playlist\/resolve'/);
  assert.match(serverSource, /resolveSharedPlaylistWithTracks\(body\.text \|\| body\.url \|\| body\.input/);
  assert.match(serverSource, /Number\(err && err\.statusCode\)/);
});
