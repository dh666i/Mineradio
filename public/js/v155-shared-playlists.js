(function () {
  'use strict';

  var STORE_KEY = 'mineradio-imported-playlists-v1';
  var MAX_RECORDS = 30;
  var MAX_TRACKS_PER_RECORD = 500;
  var MAX_STORAGE_CHARS = 3600000;
  var PROVIDER_LABELS = {
    netease: '网易云音乐',
    qq: 'QQ 音乐',
    kugou: '酷狗音乐',
    qishui: '汽水音乐',
    spotify: 'Spotify'
  };

  function recordKey(provider, id) {
    return String(provider || 'netease') + ':' + String(id || '');
  }

  function readRecords() {
    try {
      var value = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(value) ? value.filter(function (record) {
        return record && record.provider && record.id && record.playlist && Array.isArray(record.tracks);
      }) : [];
    } catch (_) {
      return [];
    }
  }

  function writeRecords(records) {
    records = (records || []).slice(0, MAX_RECORDS);
    var text = JSON.stringify(records);
    while (records.length > 1 && text.length > MAX_STORAGE_CHARS) {
      records.pop();
      text = JSON.stringify(records);
    }
    try { localStorage.setItem(STORE_KEY, text); } catch (_) {}
    return records;
  }

  function normalizePlaylist(provider, id, sourceUrl, response, tracks) {
    var playlist = Object.assign({}, response && response.playlist || {});
    playlist.provider = provider;
    playlist.source = provider;
    playlist.id = String(playlist.id || id);
    playlist.name = playlist.name || ('导入的' + (PROVIDER_LABELS[provider] || '音乐') + '歌单');
    playlist.cover = playlist.cover || (tracks[0] && tracks[0].cover) || '';
    playlist.trackCount = Math.max(Number(playlist.trackCount || response && response.total) || 0, tracks.length);
    playlist.creator = playlist.creator || '分享歌单';
    playlist.sourceUrl = sourceUrl || '';
    playlist.imported = true;
    playlist.importedAt = Date.now();
    return playlist;
  }

  function rememberRecord(resolved, response) {
    var provider = resolved.provider;
    var id = String(resolved.id || '');
    var tracks = (response && response.tracks || []).slice(0, MAX_TRACKS_PER_RECORD).map(function (song) {
      var copy = typeof cloneSong === 'function' ? cloneSong(song) : Object.assign({}, song);
      copy.provider = copy.provider || provider;
      copy.source = copy.source || provider;
      return copy;
    });
    var playlist = normalizePlaylist(provider, id, resolved.sourceUrl || resolved.resolvedUrl, response, tracks);
    var record = {
      key: recordKey(provider, id),
      provider: provider,
      id: id,
      sourceUrl: playlist.sourceUrl,
      importedAt: Date.now(),
      playlist: playlist,
      tracks: tracks
    };
    var records = readRecords().filter(function (item) { return item.key !== record.key; });
    records.unshift(record);
    writeRecords(records);
    return record;
  }

  function importedPlaylists() {
    return readRecords().map(function (record) {
      return Object.assign({}, record.playlist, {
        provider: record.provider,
        id: record.id,
        imported: true,
        trackCount: Math.max(Number(record.playlist.trackCount) || 0, record.tracks.length)
      });
    });
  }

  function mergeImportedPlaylists() {
    var imported = importedPlaylists();
    var base = Array.isArray(window.userPlaylists) ? window.userPlaylists.filter(function (playlist) {
      return !(playlist && playlist.imported);
    }) : [];
    window.userPlaylists = base.concat(imported);
    return window.userPlaylists;
  }

  function findRecord(provider, id) {
    var key = recordKey(provider, id);
    return readRecords().find(function (record) { return record.key === key; }) || null;
  }

  window.getImportedPlaylistRecord = findRecord;
  window.deleteImportedPlaylistRecord = function (provider, id) {
    var key = recordKey(provider, id);
    writeRecords(readRecords().filter(function (record) { return record.key !== key; }));
    if (window.playlistPanelDetailState && window.playlistPanelDetailState.key === key) {
      window.playlistPanelDetailState = {
        key: '',
        loading: false,
        playlist: null,
        tracks: [],
        token: Number(window.playlistPanelDetailState.token || 0) + 1,
        renderLimit: window.PLAYLIST_DETAIL_INITIAL_RENDER || 24
      };
    }
    mergeImportedPlaylists();
    if (typeof window.renderUserPlaylistsList === 'function') window.renderUserPlaylistsList({ animate: true, reset: true });
    if (typeof window.scheduleShelfRebuild === 'function') window.scheduleShelfRebuild('delete-imported-playlist', true);
    if (typeof window.showToast === 'function') window.showToast('已移除导入记录');
  };

  var legacyRefreshUserPlaylists = window.refreshUserPlaylists;
  if (typeof legacyRefreshUserPlaylists === 'function') {
    window.refreshUserPlaylists = async function () {
      var result = await legacyRefreshUserPlaylists.apply(this, arguments);
      mergeImportedPlaylists();
      if (typeof window.renderUserPlaylistsList === 'function') {
        window.renderUserPlaylistsList({ animate: false, reset: true });
      }
      if (typeof window.scheduleShelfRebuild === 'function') window.scheduleShelfRebuild('merge-imported-playlists', true);
      return window.userPlaylists || result;
    };
  }

  var legacyOpenPlaylistPanelDetail = window.openPlaylistPanelDetail;
  if (typeof legacyOpenPlaylistPanelDetail === 'function') {
    window.openPlaylistPanelDetail = async function (provider, id, title) {
      var record = findRecord(provider, id);
      if (!record) return legacyOpenPlaylistPanelDetail.apply(this, arguments);
      var key = recordKey(provider, id);
      if (window.playlistPanelDetailState && window.playlistPanelDetailState.key === key) {
        if (typeof window.collapsePlaylistPanelDetail === 'function') window.collapsePlaylistPanelDetail();
        return;
      }
      var nextToken = Number(window.playlistPanelDetailState && window.playlistPanelDetailState.token || 0) + 1;
      window.playlistPanelDetailState = {
        key: key,
        loading: false,
        playlist: record.playlist,
        tracks: record.tracks.map(function (song) { return typeof cloneSong === 'function' ? cloneSong(song) : Object.assign({}, song); }),
        token: nextToken,
        renderLimit: Math.min(record.tracks.length, window.PLAYLIST_DETAIL_INITIAL_RENDER || 24)
      };
      if (typeof window.renderPlaylistPanelDetailState === 'function') window.renderPlaylistPanelDetailState();
      if (typeof window.scrollPlaylistPanelDetailIntoView === 'function') window.scrollPlaylistPanelDetailIntoView(key);
    };
  }

  var legacyLoadPlaylistIntoQueueById = window.loadPlaylistIntoQueueById;
  if (typeof legacyLoadPlaylistIntoQueueById === 'function') {
    window.loadPlaylistIntoQueueById = async function (value, autoplay, title) {
      var parsed = typeof window.parseProviderPlaylistId === 'function'
        ? window.parseProviderPlaylistId(value)
        : { provider: 'netease', id: String(value || '') };
      var record = findRecord(parsed.provider, parsed.id);
      if (!record) return legacyLoadPlaylistIntoQueueById.apply(this, arguments);
      if (!record.tracks.length) {
        if (typeof window.showToast === 'function') window.showToast('导入歌单为空');
        return false;
      }
      window.playQueue = record.tracks.map(function (song) { return typeof cloneSong === 'function' ? cloneSong(song) : Object.assign({}, song); });
      window.currentIdx = 0;
      if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('imported-playlist-load');
      if (typeof window.safeSwitchPlaylistTab === 'function') window.safeSwitchPlaylistTab('queue', 'imported-playlist-load');
      if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('imported-playlist-load', true);
      if (typeof window.forcePlaybackControlsInteractive === 'function') window.forcePlaybackControlsInteractive();
      if (autoplay && typeof window.playQueueAt === 'function') await window.playQueueAt(0);
      if (typeof window.showToast === 'function') window.showToast('载入: ' + (title || record.playlist.name));
      return true;
    };
  }

  function looksLikeSharedPlaylist(value) {
    var text = String(value || '');
    return /(?:music\.163\.com|163cn\.tv|y\.qq\.com|kugou\.com|qishui\.douyin\.com|music\.douyin\.com|open\.spotify\.com|spotify\.link)|(?:^|\s)(?:netease|qq|kugou|qishui|spotify):/i.test(text);
  }

  async function importSharedPlaylist(query) {
    var seq = ++window.searchRequestSeq;
    if (window.$results) {
      window.$results.innerHTML = '<div class="search-empty">正在解析分享歌单…</div>';
      window.$results.classList.add('show');
    }
    try {
      var resolved = await window.apiJson('/api/shared-playlist/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: query }),
        timeoutMs: 30000
      });
      if (seq !== window.searchRequestSeq) return false;
      var hasPublicTracks = (resolved.provider === 'kugou' || resolved.provider === 'qishui') &&
        Array.isArray(resolved.tracks);
      var response = hasPublicTracks
        ? resolved
        : await window.apiJson(window.playlistTracksEndpoint(resolved.provider, resolved.id), { timeoutMs: 30000 });
      if (seq !== window.searchRequestSeq) return false;
      var tracks = response && response.tracks || [];
      if (!tracks.length) {
        var label = PROVIDER_LABELS[resolved.provider] || '该平台';
        throw new Error(response && (response.message || response.error) || ('登录' + label + '后才能读取这个歌单'));
      }
      var record = rememberRecord(resolved, response);
      mergeImportedPlaylists();
      window.playlist = record.tracks.map(function (song) { return typeof cloneSong === 'function' ? cloneSong(song) : Object.assign({}, song); });
      window.searchLastResultQuery = 'shared|' + record.key;
      if (typeof window.renderSongSearchResults === 'function') window.renderSongSearchResults(window.playlist);
      if (typeof window.renderUserPlaylistsList === 'function') window.renderUserPlaylistsList({ animate: false, reset: true });
      if (typeof window.scheduleShelfRebuild === 'function') window.scheduleShelfRebuild('shared-playlist-import', true);
      if (typeof window.showToast === 'function') window.showToast('已导入: ' + record.playlist.name);
      return true;
    } catch (error) {
      if (seq === window.searchRequestSeq && window.$results) {
        window.playlist = [];
        window.searchLastResultQuery = '';
        window.$results.innerHTML = '<div class="search-empty">歌单导入失败<br><span>' + window.escHtml(error && error.message || '请检查链接和平台登录状态') + '</span></div>';
        window.$results.classList.add('show');
      }
      return false;
    }
  }

  var legacyDoSearch = window.doSearch;
  if (typeof legacyDoSearch === 'function') {
    window.doSearch = function (query, options) {
      if (looksLikeSharedPlaylist(query)) return importSharedPlaylist(String(query || '').trim());
      return legacyDoSearch.call(this, query, options);
    };
  }

  mergeImportedPlaylists();
})();
