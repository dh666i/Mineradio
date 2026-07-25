(function () {
  'use strict';

  var TYPES = ['all', 'song', 'playlist', 'artist'];
  var TYPE_LABELS = { all: '综合', song: '单曲', playlist: '歌单', artist: '频道' };
  var legacy = {
    clearSearchResults: window.clearSearchResults,
    doSearch: window.doSearch,
    loadMoreSearchResults: window.loadMoreSearchResults,
    retrySearch: window.retryV140Search,
    updateSearchModeTabs: window.updateSearchModeTabs,
    showLoginModal: window.showLoginModal,
    setLoginProvider: window.setLoginProvider,
    updateLoginProviderUi: window.updateLoginProviderUi,
    refreshQr: window.refreshQr,
    showUserModal: window.showUserModal,
    updateUserModalUi: window.updateUserModalUi,
    renderUserBtn: window.renderUserBtn,
    logoutActiveAccount: window.logoutActiveAccount,
    onUserBtnClick: window.onUserBtnClick,
    setActiveAccountProvider: window.setActiveAccountProvider,
    openProviderLogin: window.openProviderLogin,
    playSearchResult: window.playSearchResult,
    queueSearchResult: window.queueSearchResult,
    playAllSearchResults: window.playAllSearchResults,
    addAllSearchResultsToQueue: window.addAllSearchResultsToQueue,
    shuffleAllSearchResults: window.shuffleAllSearchResults,
  };
  var oauthState = {
    loaded: false,
    clientConfigured: false,
    connected: false,
    secureStorageAvailable: false,
    authorizing: false,
    busy: false,
    account: null,
    phase: 'idle',
    error: '',
    message: '',
    profilePending: false,
    pollTimer: null,
    pollDeadline: 0,
    pollGeneration: 0,
    statusRequestSeq: 0,
  };
  var searchState = {
    type: 'all',
    query: '',
    songs: [],
    playlists: [],
    artists: [],
    nextPageToken: '',
    total: 0,
    loading: false,
    token: 0,
    error: null,
    scrollTop: 0,
  };
  var accountViewState = {
    view: '',
    items: [],
    nextPageToken: '',
    total: 0,
    loading: false,
    token: 0,
    error: null,
    returnToAccount: false,
  };
  var youtubeOnlyUserModal = false;
  var detailState = {
    type: '',
    item: null,
    authorized: false,
    songs: [],
    nextPageToken: '',
    total: 0,
    loading: false,
    token: 0,
    error: null,
  };
  function byId(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    if (typeof window.escHtml === 'function') return window.escHtml(String(value == null ? '' : value));
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function finite(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }

  function isYouTubeSong(song) {
    return !!(song && (song.provider === 'youtube' || song.source === 'youtube' || song.type === 'youtube'));
  }

  function videoId(song) {
    return String(song && (song.videoId || song.youtubeId || song.id) || '').trim();
  }

  function coverOf(item) {
    return String(item && (item.cover || item.avatar) || '');
  }

  function mergeUnique(existing, incoming, key) {
    var seen = Object.create(null);
    var output = [];
    (existing || []).concat(incoming || []).forEach(function (item) {
      var identity = key(item);
      if (!identity || seen[identity]) return;
      seen[identity] = true;
      output.push(item);
    });
    return output;
  }

  function songKey(song) {
    return 'youtube:' + videoId(song);
  }

  function entityKey(item) {
    return String(item && (item.playlistId || item.channelId || item.id) || '');
  }

  function apiErrorCode(error) {
    var payload = error && error.payload || {};
    return String(error && error.code || payload.error || payload.code || '').toUpperCase();
  }

  function apiErrorText(error, fallback) {
    var payload = error && error.payload || {};
    var code = apiErrorCode(error);
    if (code === 'YOUTUBE_API_KEY_REQUIRED') return '请先登录 YouTube 账号';
    if (code === 'YOUTUBE_API_KEY_INVALID') return 'API 密钥无效或来源限制不匹配';
    if (code === 'YOUTUBE_API_DISABLED') return '此密钥尚未启用 YouTube Data API v3';
    if (code === 'YOUTUBE_QUOTA_EXCEEDED') return 'YouTube API 今日配额已用完';
    if (code === 'YOUTUBE_RATE_LIMITED') return 'YouTube 请求过于频繁，请稍后再试';
    if (code === 'YOUTUBE_REQUEST_TIMEOUT') return 'YouTube 请求超时，请检查网络或代理';
    if (code === 'YOUTUBE_NETWORK_FAILED') return '无法连接 YouTube，请检查网络或代理';
    if (code === 'YOUTUBE_OAUTH_CONFIG_REQUIRED') return '当前版本暂未配置 YouTube 登录';
    if (code === 'YOUTUBE_OAUTH_LOGIN_REQUIRED') return '请先登录 YouTube 账号';
    if (code === 'YOUTUBE_OAUTH_SESSION_EXPIRED') return 'YouTube 登录已失效，请重新登录';
    if (code === 'YOUTUBE_OAUTH_SCOPE_REQUIRED') return '请重新登录，并在 Google 授权页允许查看你的 YouTube 账号';
    if (code === 'YOUTUBE_OAUTH_ACCOUNT_REQUIRED') return '此 Google 账号尚未创建 YouTube 频道';
    if (code === 'YOUTUBE_OAUTH_ACCESS_DENIED') return '你已取消 YouTube 登录授权';
    if (code === 'YOUTUBE_OAUTH_FLOW_EXPIRED') return '登录授权已超时，请重新登录';
    if (code === 'YOUTUBE_OAUTH_STATE_INVALID') return '登录校验失败，请重新登录';
    if (code === 'YOUTUBE_SECURE_STORAGE_UNAVAILABLE') return 'Windows 加密存储当前不可用';
    return payload.message || error && error.message || fallback || 'YouTube 服务暂时不可用';
  }

  function postJson(url, data) {
    return window.apiJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    });
  }

  function injectSearchTypes() {
    if (byId('v155-youtube-types')) return;
    var sourceTabs = byId('search-mode-tabs');
    if (!sourceTabs) return;
    var root = document.createElement('div');
    root.id = 'v155-youtube-types';
    root.setAttribute('role', 'tablist');
    root.setAttribute('aria-label', 'YouTube 搜索类型');
    root.innerHTML = TYPES.map(function (type) {
      return '<button type="button" role="tab" data-v155-youtube-type="' + type + '" aria-selected="' +
        (type === searchState.type ? 'true' : 'false') + '">' + TYPE_LABELS[type] + '</button>';
    }).join('');
    var neteaseTypes = byId('v150-search-types');
    (neteaseTypes || sourceTabs).insertAdjacentElement('afterend', root);
    root.addEventListener('click', function (event) {
      var button = event.target && event.target.closest && event.target.closest('[data-v155-youtube-type]');
      if (button) setYouTubeSearchType(button.getAttribute('data-v155-youtube-type'));
    });
    root.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var index = TYPES.indexOf(searchState.type) + (event.key === 'ArrowRight' ? 1 : -1);
      if (index < 0) index = TYPES.length - 1;
      if (index >= TYPES.length) index = 0;
      setYouTubeSearchType(TYPES[index]);
      var active = root.querySelector('[data-v155-youtube-type="' + TYPES[index] + '"]');
      if (active) active.focus();
    });
  }

  function syncSearchTypes() {
    var root = byId('v155-youtube-types');
    if (!root) return;
    var visible = String(window.searchMode || '') === 'youtube';
    root.classList.toggle('show', visible);
    root.setAttribute('aria-hidden', visible ? 'false' : 'true');
    Array.prototype.forEach.call(root.querySelectorAll('[data-v155-youtube-type]'), function (button) {
      var active = button.getAttribute('data-v155-youtube-type') === searchState.type;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = visible && active ? 0 : -1;
    });
  }

  function resetSearch(clearQuery) {
    searchState.token += 1;
    searchState.songs = [];
    searchState.playlists = [];
    searchState.artists = [];
    searchState.nextPageToken = '';
    searchState.total = 0;
    searchState.loading = false;
    searchState.error = null;
    if (clearQuery) searchState.query = '';
  }

  function setYouTubeSearchType(type) {
    if (TYPES.indexOf(type) < 0 || type === searchState.type) return;
    searchState.type = type;
    resetSearch(true);
    syncSearchTypes();
    if (typeof legacy.clearSearchResults === 'function') legacy.clearSearchResults();
    var input = byId('search-input');
    var query = input ? input.value.trim() : '';
    if (query) window.doSearch(query);
    else if (typeof window.renderSearchHistory === 'function') window.renderSearchHistory();
  }
  window.setYouTubeSearchType = setYouTubeSearchType;

  function resultImage(item, className) {
    var cover = coverOf(item);
    return cover
      ? '<img class="' + className + '" src="' + esc(cover) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=.2">'
      : '<span class="' + className + '"></span>';
  }

  function songMeta(song) {
    var parts = [song && song.artist || 'YouTube'];
    var duration = finite(song && (song.durationMs || song.duration), 0);
    if (duration > 0 && typeof window.formatProgramTime === 'function') {
      parts.push(window.formatProgramTime(duration > 1000 ? duration / 1000 : duration));
    }
    if (song && song.live) parts.push('直播');
    return parts.filter(Boolean).join(' · ');
  }

  function entityMeta(item, type) {
    if (type === 'artist') {
      var channelBits = [];
      if (item.videoCount) channelBits.push(item.videoCount + ' 个视频');
      if (item.subscriberCount) channelBits.push(item.subscriberCount + ' 位订阅者');
      return channelBits.join(' · ') || 'YouTube 频道';
    }
    return [item.creator || 'YouTube', item.trackCount ? item.trackCount + ' 个视频' : ''].filter(Boolean).join(' · ');
  }

  function songMarkup(song, index) {
    var name = song.name || song.title || '未命名';
    return '<button class="v155-song-row" type="button" data-v155-song-index="' + index + '" ' +
      'title="在 YouTube Music 中打开" aria-label="在 YouTube Music 中打开 ' + esc(name) + '">' +
      resultImage(song, 'v155-song-cover') +
      '<span class="v155-result-copy"><span class="v155-result-name">' + esc(name) + '</span>' +
      '<span class="v155-result-meta"><span class="v155-youtube-source-badge">YouTube</span>' + esc(songMeta(song)) + '</span></span>' +
      '<span class="v155-result-action v155-external-action" aria-hidden="true">↗</span></button>';
  }

  function entityMarkup(item, type, index) {
    return '<button class="v155-entity-card ' + type + '" type="button" data-v155-entity-type="' + type + '" data-v155-entity-index="' + index + '">' +
      resultImage(item, 'v155-entity-cover') +
      '<span class="v155-result-copy"><span class="v155-result-name">' + esc(item.name || item.title || '未命名') + '</span>' +
      '<span class="v155-result-meta"><span class="v155-youtube-source-badge">YouTube</span>' + esc(entityMeta(item, type)) + '</span></span>' +
      '<span class="v155-result-action" aria-hidden="true">›</span></button>';
  }

  function stateMarkup(title, detail, action) {
    var button = '';
    if (action === 'login') button = '<button class="fx-mini-btn" type="button" data-v155-open-login="1">登录 YouTube</button>';
    else if (action === 'retry') button = '<button class="fx-mini-btn" type="button" data-v155-retry="1">重试</button>';
    return '<div class="v155-search-state"><div><strong>' + esc(title) + '</strong>' +
      (detail ? '<span>' + esc(detail) + '</span>' : '') + button + '</div></div>';
  }

  function openModal(mask, afterOpen) {
    if (!mask) return;
    if (typeof window.openGsapModal === 'function') window.openGsapModal(mask);
    else mask.classList.add('show');
    if (afterOpen) afterOpen();
  }

  function transitionModal(fromMask, toMask, afterOpen) {
    var openNext = function () { openModal(toMask, afterOpen); };
    if (fromMask && fromMask.classList.contains('show')) {
      if (typeof window.closeGsapModal === 'function') window.closeGsapModal(fromMask, openNext);
      else {
        fromMask.classList.remove('show');
        openNext();
      }
      return;
    }
    openNext();
  }

  function sectionHead(type, count, hasItems) {
    return '<div class="v155-search-head"><strong>' + TYPE_LABELS[type] + '</strong><span>' + count + ' 条</span>' +
      (type === 'song' && hasItems
        ? '<button type="button" data-v155-open-search="1">在 YouTube Music 查看</button>'
        : '') +
      (searchState.type === 'all'
        ? '<button type="button" data-v155-view-type="' + type + '">查看全部</button>'
        : '') + '</div>';
  }

  function renderYouTubeSearch() {
    var results = byId('search-results');
    if (!results) return;
    if (searchState.loading && !searchState.songs.length && !searchState.playlists.length && !searchState.artists.length) {
      results.innerHTML = stateMarkup('正在搜索 YouTube Music', '正在查找单曲、歌单和频道');
      results.classList.add('show');
      return;
    }
    if (searchState.error && !searchState.songs.length && !searchState.playlists.length && !searchState.artists.length) {
      var code = apiErrorCode(searchState.error);
      results.innerHTML = stateMarkup(
        'YouTube 搜索不可用',
        apiErrorText(searchState.error),
        ['YOUTUBE_API_KEY_REQUIRED', 'YOUTUBE_OAUTH_CONFIG_REQUIRED', 'YOUTUBE_OAUTH_LOGIN_REQUIRED', 'YOUTUBE_OAUTH_SESSION_EXPIRED'].includes(code)
          ? 'login'
          : 'retry'
      );
      results.classList.add('show');
      return;
    }

    var sections = [];
    function pushSection(type, items) {
      var cards = type === 'song'
        ? items.map(songMarkup).join('')
        : items.map(function (item, index) { return entityMarkup(item, type, index); }).join('');
      var bodyClass = type === 'song' ? 'v155-song-grid' : 'v155-entity-grid';
      sections.push('<section class="v155-search-section">' + sectionHead(type, items.length, !!items.length) +
        (items.length ? '<div class="' + bodyClass + '">' + cards + '</div>' : '<div class="v155-search-empty">没有相关结果</div>') +
        '</section>');
    }
    if (searchState.type === 'all') {
      pushSection('song', searchState.songs);
      pushSection('playlist', searchState.playlists);
      pushSection('artist', searchState.artists);
    } else if (searchState.type === 'song') {
      pushSection('song', searchState.songs);
    } else if (searchState.type === 'playlist') {
      pushSection('playlist', searchState.playlists);
    } else {
      pushSection('artist', searchState.artists);
    }
    if (!searchState.songs.length && !searchState.playlists.length && !searchState.artists.length) {
      results.innerHTML = stateMarkup(
        '没有找到相关结果',
        searchState.nextPageToken ? '当前页没有相关内容，可以继续查找' : '换一个关键词试试'
      ) + (searchState.nextPageToken
        ? '<button class="fx-mini-btn ghost v155-load-more" type="button" data-v155-load-more="1">继续查找</button>'
        : '');
    } else {
      results.innerHTML = '<div class="v155-search-sections">' + sections.join('') + '</div>' +
        (searchState.nextPageToken
          ? '<button class="fx-mini-btn ghost v155-load-more" type="button" data-v155-load-more="1">加载更多</button>'
          : '');
    }
    if (searchState.error) {
      results.innerHTML += '<div class="v155-inline-error" role="status"><span>' +
        esc(apiErrorText(searchState.error, '加载更多失败')) +
        '</span><button class="fx-mini-btn ghost" type="button" data-v155-load-more="1">重试</button></div>';
    }
    results.classList.add('show');
    if (typeof window.updateSearchPillGlassDisplacementMap === 'function') {
      requestAnimationFrame(window.updateSearchPillGlassDisplacementMap);
    }
  }

  async function runYouTubeSearch(query, append) {
    query = String(query || '').trim();
    if (!query) return;
    if (!append || searchState.query !== query) {
      resetSearch(false);
      searchState.query = query;
    }
    if (searchState.loading) return;
    searchState.loading = true;
    searchState.error = null;
    var token = ++searchState.token;
    renderYouTubeSearch();
    try {
      var url = '/api/youtube/search?keywords=' + encodeURIComponent(query) +
        '&type=' + encodeURIComponent(searchState.type) +
        '&limit=' + (searchState.type === 'all' ? '30' : '24');
      if (append && searchState.nextPageToken) url += '&pageToken=' + encodeURIComponent(searchState.nextPageToken);
      var payload = await window.apiJson(url, { timeoutMs: 22000 });
      if (token !== searchState.token || String(window.searchMode || '') !== 'youtube') return;
      searchState.songs = mergeUnique(append ? searchState.songs : [], payload.songs || [], songKey);
      searchState.playlists = mergeUnique(append ? searchState.playlists : [], payload.playlists || [], entityKey);
      searchState.artists = mergeUnique(append ? searchState.artists : [], payload.artists || [], entityKey);
      searchState.nextPageToken = String(payload.nextPageToken || '');
      searchState.total = finite(payload.total, searchState.songs.length + searchState.playlists.length + searchState.artists.length);
      if (typeof window.rememberSearchQuery === 'function') window.rememberSearchQuery(query);
      if (typeof window.searchResultKey === 'function') window.searchLastResultQuery = window.searchResultKey(query, 'youtube');
      searchState.loading = false;
      renderYouTubeSearch();
    } catch (error) {
      if (token !== searchState.token) return;
      searchState.error = error;
      searchState.loading = false;
      renderYouTubeSearch();
    } finally {
      if (token === searchState.token) searchState.loading = false;
    }
  }

  function openSearchSong(index) {
    var song = searchState.songs[index];
    if (!song) return;
    openYouTubeSong(song);
  }

  function openSearchOnYouTubeMusic() {
    if (!searchState.query) return;
    openYouTubeExternal(youtubeSearchUrl(searchState.query), 'YouTube Music 搜索');
  }

  function ensureDetailModal() {
    var mask = byId('v155-youtube-detail');
    if (mask) return mask;
    mask = document.createElement('div');
    mask.id = 'v155-youtube-detail';
    mask.className = 'modal-mask';
    mask.setAttribute('aria-hidden', 'true');
    mask.innerHTML = '<div class="modal v155-detail-modal" role="dialog" aria-modal="true" aria-labelledby="v155-detail-title">' +
      '<header id="v155-detail-head" class="v155-detail-head"></header>' +
      '<main id="v155-detail-body" class="v155-detail-body"></main></div>';
    mask.addEventListener('click', function (event) {
      if (event.target === mask) {
        closeDetail(false);
        return;
      }
      var back = event.target && event.target.closest && event.target.closest('[data-v155-detail-back]');
      if (back) {
        closeDetail(true);
        return;
      }
      var close = event.target && event.target.closest && event.target.closest('[data-v155-detail-close]');
      if (close) {
        closeDetail(false);
        return;
      }
      var openSong = event.target && event.target.closest && event.target.closest('[data-v155-detail-open-song]');
      var openSource = event.target && event.target.closest && event.target.closest('[data-v155-detail-open-source]');
      var more = event.target && event.target.closest && event.target.closest('[data-v155-detail-more]');
      if (openSong) openDetailSong(finite(openSong.getAttribute('data-v155-detail-open-song'), -1));
      else if (openSource) openDetailSource();
      else if (more) loadDetail(true);
    });
    document.body.appendChild(mask);
    return mask;
  }

  function renderDetail() {
    var head = byId('v155-detail-head');
    var body = byId('v155-detail-body');
    if (!head || !body) return;
    var item = detailState.item || {};
    var typeLabel = detailState.type === 'artist' ? 'YOUTUBE CHANNEL' : 'YOUTUBE PLAYLIST';
    var meta = detailState.type === 'artist'
      ? [item.videoCount ? item.videoCount + ' 个视频' : '', item.subscriberCount ? item.subscriberCount + ' 位订阅者' : ''].filter(Boolean).join(' · ')
      : [item.creator || '', detailState.total ? detailState.total + ' 个视频' : ''].filter(Boolean).join(' · ');
    head.innerHTML = resultImage(item, 'v155-detail-cover') +
      '<div><div class="v155-detail-kind"><span class="v155-youtube-source-badge">YouTube</span>' + typeLabel + '</div>' +
      '<div id="v155-detail-title" class="v155-detail-title">' + esc(item.name || item.title || 'YouTube') + '</div>' +
      '<div class="v155-detail-meta">' + esc(meta || 'YouTube') + '</div>' +
      (item.description ? '<div class="v155-detail-description">' + esc(item.description) + '</div>' : '') +
      '<div class="v155-detail-actions"><button class="modal-btn primary" type="button" data-v155-detail-open-source="1" ' +
      (youtubeEntityUrl(detailState.type, item) ? '' : 'disabled') + '>在 YouTube Music 中打开 ↗</button></div></div>' +
      '<div class="v155-detail-window-actions">' +
      (detailState.returnToAccount
        ? '<button class="v155-detail-close v155-detail-back" type="button" data-v155-detail-back="1" aria-label="返回个人内容" title="返回个人内容">←</button>'
        : '') +
      '<button class="v155-detail-close" type="button" data-v155-detail-close="1" aria-label="关闭">×</button></div>';

    if (detailState.loading && !detailState.songs.length) {
      body.innerHTML = stateMarkup('正在载入', item.name || '');
      return;
    }
    if (detailState.error && !detailState.songs.length) {
      body.innerHTML = stateMarkup('载入失败', apiErrorText(detailState.error), 'retry');
      var retry = body.querySelector('[data-v155-retry]');
      if (retry) retry.addEventListener('click', function () { loadDetail(false); }, { once: true });
      return;
    }
    if (!detailState.songs.length) {
      body.innerHTML = stateMarkup(
        '当前页没有相关视频',
        detailState.nextPageToken ? '可以继续载入后续内容' : ''
      ) + (detailState.nextPageToken
        ? '<button class="fx-mini-btn ghost v155-detail-more" type="button" data-v155-detail-more="1">继续载入</button>'
        : '');
      return;
    }
    body.innerHTML = detailState.songs.map(function (song, index) {
      return '<div class="v155-detail-row"><span class="v155-detail-index">' + String(index + 1).padStart(2, '0') + '</span>' +
        resultImage(song, 'v155-detail-cover-small') +
        '<button class="v155-detail-main" type="button" data-v155-detail-open-song="' + index + '" ' +
        'title="在 YouTube Music 中打开">' +
        '<span class="v155-result-name">' + esc(song.name || '未命名') + '</span>' +
        '<span class="v155-result-meta"><span class="v155-youtube-source-badge">YouTube</span>' + esc(songMeta(song)) +
        '</span></button><span class="v155-detail-external" aria-hidden="true">↗</span></div>';
    }).join('') + (detailState.nextPageToken
      ? '<button class="fx-mini-btn ghost v155-detail-more" type="button" data-v155-detail-more="1">' +
        (detailState.loading ? '正在加载' : '加载更多') + '</button>'
      : '');
    if (detailState.error) {
      body.innerHTML += '<div class="v155-inline-error" role="status"><span>' +
        esc(apiErrorText(detailState.error, '加载更多失败')) +
        '</span><button class="fx-mini-btn ghost" type="button" data-v155-detail-more="1">重试</button></div>';
    }
  }

  async function loadDetail(append) {
    if (!detailState.item || detailState.loading) return;
    if (!append) {
      detailState.songs = [];
      detailState.nextPageToken = '';
      detailState.total = 0;
    }
    detailState.error = null;
    detailState.loading = true;
    var token = ++detailState.token;
    renderDetail();
    try {
      var id = detailState.type === 'artist'
        ? (detailState.item.channelId || detailState.item.id)
        : (detailState.item.playlistId || detailState.item.id);
      var url = detailState.type === 'artist'
        ? (detailState.authorized
          ? '/api/youtube/account/artist?id=' + encodeURIComponent(id) + '&limit=50'
          : '/api/youtube/artist?id=' + encodeURIComponent(id) + '&limit=50')
        : (detailState.authorized
          ? '/api/youtube/account/playlist?id=' + encodeURIComponent(id) + '&limit=50'
          : '/api/youtube/playlist?id=' + encodeURIComponent(id) + '&limit=50');
      if (append && detailState.nextPageToken) url += '&pageToken=' + encodeURIComponent(detailState.nextPageToken);
      var payload = await window.apiJson(url, { timeoutMs: 22000 });
      if (token !== detailState.token) return;
      var incoming = detailState.type === 'artist' ? payload.songs || [] : payload.tracks || [];
      detailState.songs = mergeUnique(append ? detailState.songs : [], incoming, songKey);
      detailState.item = Object.assign({}, detailState.item, detailState.type === 'artist' ? payload.artist || {} : payload.playlist || {});
      detailState.total = finite(payload.total, detailState.songs.length);
      detailState.nextPageToken = String(payload.nextPageToken || '');
      detailState.error = null;
    } catch (error) {
      if (token !== detailState.token) return;
      detailState.error = error;
    } finally {
      if (token === detailState.token) {
        detailState.loading = false;
        renderDetail();
      }
    }
  }

  function openEntityItem(type, item, authorized, options) {
    if (!item) return;
    options = options || {};
    detailState.type = type;
    detailState.item = Object.assign({}, item);
    detailState.authorized = !!authorized;
    detailState.songs = [];
    detailState.nextPageToken = '';
    detailState.total = 0;
    detailState.loading = false;
    detailState.error = null;
    detailState.returnToAccount = !!options.returnToAccount;
    detailState.token += 1;
    var mask = ensureDetailModal();
    renderDetail();
    transitionModal(options.fromMask || null, mask, function () { loadDetail(false); });
  }

  function openEntity(type, index) {
    var item = type === 'artist' ? searchState.artists[index] : searchState.playlists[index];
    openEntityItem(type, item, false);
  }

  function closeDetail(returnToAccount) {
    var mask = byId('v155-youtube-detail');
    if (!mask) return;
    detailState.token += 1;
    detailState.loading = false;
    var shouldReturn = !!returnToAccount && detailState.returnToAccount;
    detailState.returnToAccount = false;
    var reopen = shouldReturn ? function () {
      var accountMask = ensureAccountViewModal();
      renderAccountView();
      openModal(accountMask, function () {
        var body = byId('v155-account-view-body');
        if (body) requestAnimationFrame(function () { body.scrollTop = accountViewState.scrollTop || 0; });
      });
    } : null;
    if (typeof window.closeGsapModal === 'function') window.closeGsapModal(mask, reopen);
    else {
      mask.classList.remove('show');
      if (reopen) reopen();
    }
  }
  window.closeYouTubeDetailModal = function () { closeDetail(false); };

  function openDetailSong(index) {
    if (!detailState.songs[index]) return;
    openYouTubeSong(detailState.songs[index]);
  }

  function openDetailSource() {
    openYouTubeEntity(detailState.type, detailState.item);
  }

  function bindSearchResults() {
    var results = byId('search-results');
    if (!results) return;
    results.addEventListener('click', function (event) {
      var song = event.target && event.target.closest && event.target.closest('[data-v155-song-index]');
      var entity = event.target && event.target.closest && event.target.closest('[data-v155-entity-type]');
      var more = event.target && event.target.closest && event.target.closest('[data-v155-load-more]');
      var retry = event.target && event.target.closest && event.target.closest('[data-v155-retry]');
      var login = event.target && event.target.closest && event.target.closest('[data-v155-open-login]');
      var view = event.target && event.target.closest && event.target.closest('[data-v155-view-type]');
      var openSearch = event.target && event.target.closest && event.target.closest('[data-v155-open-search]');
      if (song) openSearchSong(finite(song.getAttribute('data-v155-song-index'), -1));
      else if (entity) openEntity(
        entity.getAttribute('data-v155-entity-type'),
        finite(entity.getAttribute('data-v155-entity-index'), -1)
      );
      else if (more) runYouTubeSearch(searchState.query, true);
      else if (retry) runYouTubeSearch(searchState.query, false);
      else if (login) openYouTubeLogin(null, false);
      else if (view) setYouTubeSearchType(view.getAttribute('data-v155-view-type'));
      else if (openSearch) openSearchOnYouTubeMusic();
    });
  }

  function openYouTubeLogin(fromMask, autoStart) {
    var open = async function () {
      await window.showLoginModal({ provider: 'youtube' });
      if (autoStart && !oauthState.connected && oauthState.clientConfigured
        && !oauthState.authorizing && oauthState.phase !== 'exchanging') {
        startYouTubeOAuthLogin();
      }
    };
    if (fromMask && fromMask.classList && fromMask.classList.contains('show')
      && typeof window.closeGsapModal === 'function') {
      window.closeGsapModal(fromMask, function () { open().catch(function () {}); });
      return;
    }
    return open();
  }
  window.openYouTubeLogin = openYouTubeLogin;

  function stopOAuthPolling() {
    if (oauthState.pollTimer) clearTimeout(oauthState.pollTimer);
    oauthState.pollTimer = null;
    oauthState.pollDeadline = 0;
    oauthState.pollGeneration += 1;
  }

  function applyOAuthPayload(payload, invalidateStatusRequests) {
    payload = payload || {};
    if (invalidateStatusRequests) oauthState.statusRequestSeq += 1;
    oauthState.loaded = true;
    oauthState.clientConfigured = !!payload.clientConfigured;
    oauthState.connected = !!payload.connected;
    oauthState.secureStorageAvailable = !!payload.secureStorageAvailable;
    oauthState.authorizing = !!payload.authorizing;
    oauthState.account = payload.account || null;
    oauthState.phase = String(payload.phase || 'idle');
    oauthState.error = String(payload.error || '');
    oauthState.message = String(payload.message || '');
    oauthState.profilePending = !!payload.profilePending;
    updateOAuthUi();
    return payload;
  }

  function updateOAuthUi() {
    syncMainAccountUi();
  }

  async function loadYouTubeOAuthStatus(options) {
    options = options || {};
    var requestSeq = ++oauthState.statusRequestSeq;
    try {
      var payload = await window.apiJson('/api/youtube/oauth/status');
      if (requestSeq !== oauthState.statusRequestSeq) return null;
      applyOAuthPayload(payload);
      if (!options.fromPoll && (payload.authorizing || payload.phase === 'exchanging' || payload.profilePending) && !oauthState.pollTimer) {
        scheduleOAuthPoll(payload.authorizationExpiresAt);
      }
      return payload;
    } catch (error) {
      if (requestSeq !== oauthState.statusRequestSeq) return null;
      oauthState.loaded = true;
      oauthState.error = apiErrorCode(error) || 'YOUTUBE_OAUTH_STATUS_FAILED';
      oauthState.message = apiErrorText(error, '读取 YouTube 登录状态失败');
      updateOAuthUi();
      throw error;
    }
  }

  function scheduleOAuthPoll(deadline) {
    stopOAuthPolling();
    var generation = oauthState.pollGeneration;
    oauthState.pollDeadline = Math.max(Date.now() + 5000, Number(deadline) || Date.now() + 10 * 60 * 1000);
    var poll = async function () {
      if (generation !== oauthState.pollGeneration) return;
      if (Date.now() >= oauthState.pollDeadline) {
        stopOAuthPolling();
        oauthState.authorizing = false;
        oauthState.error = 'YOUTUBE_OAUTH_FLOW_EXPIRED';
        oauthState.message = '登录授权已超时，请重新登录';
        updateOAuthUi();
        postJson('/api/youtube/oauth/cancel', {}).catch(function () {});
        return;
      }
      try {
        var payload = await loadYouTubeOAuthStatus({ fromPoll: true });
        if (generation !== oauthState.pollGeneration) return;
        if (payload && payload.connected && !payload.authorizing && !payload.profilePending && payload.phase === 'connected') {
          stopOAuthPolling();
          if (youtubeOnlyUserModal) {
            activateYouTubeAccount(false);
            var loginMask = byId('login-modal');
            if (loginMask && loginMask.classList.contains('show') && typeof window.closeGsapModal === 'function') {
              window.closeGsapModal(loginMask);
            }
          }
          if (typeof window.showToast === 'function') window.showToast('YouTube 账号已登录');
          return;
        }
        if (payload && !payload.authorizing && payload.phase !== 'exchanging' && !payload.profilePending) {
          stopOAuthPolling();
          return;
        }
      } catch (_) {}
      if (generation !== oauthState.pollGeneration) return;
      oauthState.pollTimer = setTimeout(poll, document.hidden ? 2200 : 1100);
    };
    oauthState.pollTimer = setTimeout(poll, 800);
  }

  async function startYouTubeOAuthLogin() {
    if (oauthState.busy || !oauthState.clientConfigured || oauthState.authorizing || oauthState.phase === 'exchanging') return;
    oauthState.busy = true;
    oauthState.error = '';
    oauthState.message = '';
    updateOAuthUi();
    var flowStarted = false;
    try {
      var payload = await postJson('/api/youtube/oauth/start', {});
      flowStarted = true;
      applyOAuthPayload(payload, true);
      var targetUrl = String(payload.authorizationUrl || '');
      if (!targetUrl) throw new Error('未收到 Google 授权地址');
      if (!window.desktopWindow || typeof window.desktopWindow.openYouTubeOAuth !== 'function') {
        throw new Error('当前环境无法打开 Google 授权页面');
      }
      var opened = await window.desktopWindow.openYouTubeOAuth(targetUrl);
      if (!opened || opened.ok === false) throw new Error(opened && opened.error || '无法打开系统浏览器');
      if (typeof window.showToast === 'function') window.showToast('请在系统浏览器中完成 YouTube 授权');
      scheduleOAuthPoll(payload.expiresAt || payload.authorizationExpiresAt);
    } catch (error) {
      if (flowStarted) {
        try {
          var cancelled = await postJson('/api/youtube/oauth/cancel', {});
          stopOAuthPolling();
          applyOAuthPayload(cancelled, true);
        } catch (_) {}
      }
      oauthState.authorizing = false;
      oauthState.error = apiErrorCode(error) || 'YOUTUBE_OAUTH_OPEN_FAILED';
      oauthState.message = apiErrorText(error, error && error.message || '无法启动 YouTube 登录');
      updateOAuthUi();
    } finally {
      oauthState.busy = false;
      updateOAuthUi();
    }
  }
  window.startYouTubeOAuthLogin = startYouTubeOAuthLogin;

  async function cancelYouTubeOAuthLogin() {
    if (oauthState.busy || (!oauthState.authorizing && oauthState.phase !== 'exchanging')) return;
    oauthState.busy = true;
    oauthState.error = '';
    oauthState.message = '正在取消本次登录...';
    updateOAuthUi();
    try {
      var payload = await postJson('/api/youtube/oauth/cancel', {});
      stopOAuthPolling();
      applyOAuthPayload(payload, true);
      if (!oauthState.connected && hasTraditionalAccount()) {
        selectTraditionalAccountFallback();
        renderYouTubeTopAccount();
      }
      if (typeof window.showToast === 'function') window.showToast('已取消 YouTube 登录');
    } catch (error) {
      oauthState.error = apiErrorCode(error) || 'YOUTUBE_OAUTH_CANCEL_FAILED';
      oauthState.message = apiErrorText(error, '取消 YouTube 登录失败');
      updateOAuthUi();
    } finally {
      oauthState.busy = false;
      updateOAuthUi();
    }
  }
  window.cancelYouTubeOAuthLogin = cancelYouTubeOAuthLogin;

  async function logoutYouTubeOAuth() {
    if (oauthState.busy || !oauthState.connected) return;
    if (!window.confirm('退出当前 YouTube 账号？本机保存的登录令牌会被清除。')) return;
    oauthState.busy = true;
    updateOAuthUi();
    try {
      var payload = await postJson('/api/youtube/oauth/logout', {});
      stopOAuthPolling();
      applyOAuthPayload(payload, true);
      if (typeof window.showToast === 'function') window.showToast('已退出 YouTube 账号');
    } catch (error) {
      oauthState.error = apiErrorCode(error) || 'YOUTUBE_OAUTH_LOGOUT_FAILED';
      oauthState.message = apiErrorText(error, '退出 YouTube 账号失败');
      updateOAuthUi();
    } finally {
      oauthState.busy = false;
      updateOAuthUi();
    }
  }

  function hasTraditionalAccount() {
    return !!(window.loginStatus && window.loginStatus.loggedIn)
      || !!(window.qqLoginStatus && window.qqLoginStatus.loggedIn);
  }

  function youtubeAccountName() {
    return String(oauthState.account && oauthState.account.name || 'YouTube 用户');
  }

  function youtubeAccountAvatar() {
    var avatar = String(oauthState.account && oauthState.account.avatar || '');
    if (avatar) return avatar;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
      '<rect width="96" height="96" rx="48" fill="#170b0d"/><circle cx="48" cy="48" r="34" fill="#ff4e5e" opacity=".18"/>' +
      '<text x="48" y="57" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#ff8994">YT</text></svg>';
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }

  function oauthDisplayMessage() {
    if (oauthState.message) return oauthState.message;
    if (!oauthState.secureStorageAvailable) return 'Windows 加密存储当前不可用';
    if (oauthState.error) return apiErrorText({ code: oauthState.error }, 'YouTube 登录状态异常');
    if (oauthState.authorizing || oauthState.phase === 'exchanging') return '请在系统浏览器中完成 Google 授权';
    if (oauthState.connected) return oauthState.account
      ? '已连接，可访问个人歌单、喜欢的视频和订阅频道'
      : '已登录，正在同步账号资料';
    if (oauthState.clientConfigured) return '点击下方按钮后会打开 Google 官方登录页面';
    return '当前版本暂未配置 YouTube 登录';
  }

  function syncMainLoginUi() {
    var isYouTube = String(window.loginProvider || '') === 'youtube';
    var provider = isYouTube ? 'youtube' : String(window.loginProvider || 'netease');
    var isQQ = provider === 'qq';
    var isNetease = !isYouTube && !isQQ;
    var panel = byId('youtube-main-login-panel');
    var youtubeTab = byId('login-provider-youtube');
    var neteaseTab = byId('login-provider-netease');
    var qqTab = byId('login-provider-qq');
    var shell = byId('qr-shell');
    var qrStatus = byId('qr-status');
    var qqPanel = byId('qq-cookie-panel');
    var refresh = byId('refresh-qr-btn');
    var qqToggle = byId('qq-cookie-toggle-btn');
    if (!isQQ) window.qqManualCookieOpen = false;
    [
      [neteaseTab, isNetease],
      [qqTab, isQQ],
      [youtubeTab, isYouTube],
    ].forEach(function (entry) {
      var tab = entry[0];
      var active = entry[1];
      if (!tab) return;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (isYouTube) {
      if (shell) shell.classList.remove('web-login-preview', 'qq-preview', 'netease-preview');
      if (qqPanel) qqPanel.classList.remove('show');
      if (qqToggle) qqToggle.classList.remove('show');
    }
    if (panel) panel.hidden = !isYouTube;
    if (shell) shell.hidden = isYouTube;
    if (qrStatus) qrStatus.hidden = isYouTube;
    if (qqPanel) qqPanel.hidden = isYouTube || !isQQ || !window.qqManualCookieOpen;
    if (refresh) refresh.hidden = isYouTube;
    if (qqToggle) qqToggle.hidden = isYouTube || !isQQ;
    if (!isYouTube) return;

    var title = byId('login-modal-title');
    var description = byId('login-modal-desc');
    var name = byId('youtube-main-login-name');
    var status = byId('youtube-main-login-status');
    var avatar = byId('youtube-main-login-avatar');
    var primary = byId('youtube-main-login-primary');
    var cancel = byId('youtube-main-login-cancel');
    var isAuthorizing = oauthState.authorizing || oauthState.phase === 'exchanging';
    if (title) title.textContent = oauthState.connected ? 'YouTube 账号' : '登录 YouTube Music';
    if (description) {
      description.innerHTML = '使用 <b>Google 官方 OAuth</b> 在系统浏览器中授权；Mineradio 不会读取或保存你的 Google 密码。';
    }
    if (name) name.textContent = oauthState.connected ? youtubeAccountName() : 'YouTube Music';
    if (status) {
      status.textContent = oauthDisplayMessage();
      status.classList.toggle('error', !!oauthState.error || !oauthState.secureStorageAvailable);
    }
    if (avatar) {
      avatar.hidden = !oauthState.connected;
      if (oauthState.connected) {
        avatar.src = youtubeAccountAvatar();
        avatar.alt = youtubeAccountName() + ' 的头像';
      }
    }
    if (primary) {
      primary.disabled = oauthState.busy || !oauthState.loaded || !oauthState.clientConfigured
        || isAuthorizing || !oauthState.secureStorageAvailable;
      primary.textContent = oauthState.connected
        ? '查看个人内容'
        : (isAuthorizing
          ? '等待浏览器授权'
          : (oauthState.error === 'YOUTUBE_OAUTH_SCOPE_REQUIRED' ? '重新授权' : '使用 Google 账号登录'));
    }
    if (cancel) {
      cancel.hidden = !isAuthorizing;
      cancel.disabled = oauthState.busy;
    }
  }

  function youtubeAccountIsActive() {
    return oauthState.connected && String(window.activeAccountProvider || '') === 'youtube';
  }

  function setTraditionalAccountActionsVisible(visible) {
    var addNetease = byId('account-add-netease');
    var addQQ = byId('account-add-qq');
    var content = byId('account-youtube-content');
    var neteaseConnected = !!(window.loginStatus && window.loginStatus.loggedIn);
    var qqConnected = !!(window.qqLoginStatus && window.qqLoginStatus.loggedIn);
    if (addNetease) addNetease.style.display = visible && !neteaseConnected ? '' : 'none';
    if (addQQ) addQQ.style.display = visible && !qqConnected ? '' : 'none';
    if (content) content.hidden = visible;
  }

  function renderYouTubeUserModal() {
    var account = oauthState.account || {};
    var chip = byId('account-provider-chip');
    var avatar = byId('user-modal-avatar');
    var name = byId('user-modal-name');
    var detail = byId('user-modal-vip');
    var hint = byId('account-hint');
    var logout = byId('account-logout-btn');
    if (chip) {
      chip.className = 'account-provider-chip youtube';
      chip.innerHTML = '<span class="account-source-dot youtube"></span><span>YouTube Music</span>';
    }
    if (avatar) avatar.src = youtubeAccountAvatar();
    if (name) name.textContent = youtubeAccountName();
    if (detail) {
      detail.textContent = account.email || account.customUrl || 'Google OAuth 已连接';
      detail.style.color = 'rgba(255,137,148,.78)';
    }
    ['netease', 'qq', 'youtube'].forEach(function (key) {
      var button = byId('user-provider-' + key);
      if (button) {
        var active = key === 'youtube';
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    });
    setTraditionalAccountActionsVisible(false);
    if (hint) hint.textContent = '已通过 Google 官方授权连接 YouTube Music。';
    if (logout) {
      logout.hidden = false;
      logout.textContent = '退出 YouTube';
    }
  }

  function syncTraditionalUserModal() {
    var youtubeTab = byId('user-provider-youtube');
    if (youtubeTab) {
      youtubeTab.classList.remove('active');
      youtubeTab.setAttribute('aria-selected', 'false');
    }
    setTraditionalAccountActionsVisible(true);
  }

  function activateYouTubeAccount(updateModal) {
    window.activeAccountProvider = 'youtube';
    youtubeOnlyUserModal = true;
    renderYouTubeTopAccount();
    if (updateModal !== false) renderYouTubeUserModal();
  }

  function selectTraditionalAccountFallback() {
    youtubeOnlyUserModal = false;
    if (window.loginStatus && window.loginStatus.loggedIn) window.activeAccountProvider = 'netease';
    else if (window.qqLoginStatus && window.qqLoginStatus.loggedIn) window.activeAccountProvider = 'qq';
  }

  function renderYouTubeTopAccount() {
    var shouldShowYouTube = oauthState.connected
      && (!hasTraditionalAccount() || String(window.activeAccountProvider || '') === 'youtube');
    if (typeof legacy.renderUserBtn === 'function') legacy.renderUserBtn();
    var button = byId('user-btn');
    if (!shouldShowYouTube) {
      if (button) button.classList.remove('youtube-account');
      return;
    }
    window.activeAccountProvider = 'youtube';
    if (!button) return;
    button.classList.remove('logged-out');
    button.classList.add('logged-in', 'youtube-account');
    button.title = youtubeAccountName() + ' · YouTube 账号信息';
    button.innerHTML = '<img id="user-avatar" src="' + esc(youtubeAccountAvatar()) + '" alt="">' +
      '<span>' + esc(youtubeAccountName()) + '</span><span class="v155-top-youtube-badge">YouTube</span>';
  }

  function syncMainAccountUi() {
    syncMainLoginUi();
    if (oauthState.connected && (youtubeOnlyUserModal || !hasTraditionalAccount())) {
      window.activeAccountProvider = 'youtube';
      youtubeOnlyUserModal = true;
    }
    renderYouTubeTopAccount();
    var userModal = byId('user-modal');
    if (youtubeAccountIsActive() && userModal && userModal.classList.contains('show')) renderYouTubeUserModal();
  }

  function handleMainYouTubeLogin() {
    if (!oauthState.clientConfigured) {
      oauthState.error = 'YOUTUBE_OAUTH_CONFIG_REQUIRED';
      oauthState.message = '当前版本暂未配置 YouTube 登录';
      updateOAuthUi();
      if (typeof window.showToast === 'function') window.showToast(oauthState.message);
      return;
    }
    if (oauthState.connected) {
      openYouTubeAccountView('playlists');
      return;
    }
    youtubeOnlyUserModal = true;
    startYouTubeOAuthLogin();
  }

  function installMainAccountIntegration() {
    window.setLoginProvider = function (provider, silent) {
      if (provider === 'youtube') {
        if (typeof window.stopQrPoll === 'function') window.stopQrPoll();
        window.loginProvider = 'youtube';
        syncMainLoginUi();
        return;
      }
      var result = legacy.setLoginProvider.apply(this, arguments);
      syncMainLoginUi();
      return result;
    };
    window.updateLoginProviderUi = function () {
      if (String(window.loginProvider || '') === 'youtube') {
        syncMainLoginUi();
        return;
      }
      var result = legacy.updateLoginProviderUi.apply(this, arguments);
      syncMainLoginUi();
      return result;
    };
    window.refreshQr = function () {
      if (String(window.loginProvider || '') === 'youtube') return loadYouTubeOAuthStatus();
      return legacy.refreshQr.apply(this, arguments);
    };
    window.showLoginModal = function (options) {
      options = options || {};
      if (options.provider === 'youtube') {
        window.loginProvider = 'youtube';
        if (typeof window.openGsapModal === 'function') window.openGsapModal(byId('login-modal'));
        syncMainLoginUi();
        return loadYouTubeOAuthStatus().catch(function () {});
      }
      return legacy.showLoginModal.apply(this, arguments);
    };
    window.renderUserBtn = function () {
      renderYouTubeTopAccount();
    };
    window.onUserBtnClick = function () {
      if (youtubeAccountIsActive() || (!hasTraditionalAccount() && oauthState.connected)) return window.showUserModal();
      return legacy.onUserBtnClick.apply(this, arguments);
    };
    window.showUserModal = function () {
      if (youtubeAccountIsActive() || (!hasTraditionalAccount() && oauthState.connected)) {
        youtubeOnlyUserModal = true;
        if (!youtubeAccountIsActive()) window.activeAccountProvider = 'youtube';
        renderYouTubeUserModal();
        if (typeof window.openGsapModal === 'function') window.openGsapModal(byId('user-modal'));
        return;
      }
      youtubeOnlyUserModal = false;
      var result = legacy.showUserModal.apply(this, arguments);
      syncTraditionalUserModal();
      return result;
    };
    window.updateUserModalUi = function () {
      if (youtubeAccountIsActive()) {
        renderYouTubeUserModal();
        return;
      }
      var result = legacy.updateUserModalUi.apply(this, arguments);
      syncTraditionalUserModal();
      return result;
    };
    window.setActiveAccountProvider = function (provider) {
      if (provider === 'youtube') {
        if (!oauthState.connected) {
          youtubeOnlyUserModal = true;
          return openYouTubeLogin(byId('user-modal'), true);
        }
        activateYouTubeAccount(true);
        return;
      }
      youtubeOnlyUserModal = false;
      return legacy.setActiveAccountProvider.apply(this, arguments);
    };
    window.openProviderLogin = function (provider) {
      if (provider === 'youtube') return openYouTubeLogin(byId('user-modal'), true);
      return legacy.openProviderLogin.apply(this, arguments);
    };
    window.logoutActiveAccount = async function () {
      if (youtubeAccountIsActive()) {
        await logoutYouTubeOAuth();
        selectTraditionalAccountFallback();
        if (hasTraditionalAccount()) {
          renderYouTubeTopAccount();
          window.updateUserModalUi();
        } else if (typeof window.closeUserModal === 'function') {
          window.closeUserModal();
        }
        return;
      }
      return legacy.logoutActiveAccount.apply(this, arguments);
    };
  }

  var ACCOUNT_VIEW_LABELS = {
    playlists: '我的 YouTube 歌单',
    likes: '喜欢的视频',
    subscriptions: '订阅频道',
  };

  function ensureAccountViewModal() {
    var mask = byId('v155-youtube-account-view');
    if (mask) return mask;
    mask = document.createElement('div');
    mask.id = 'v155-youtube-account-view';
    mask.className = 'modal-mask';
    mask.setAttribute('aria-hidden', 'true');
    mask.innerHTML = '<div class="modal v155-account-view-modal" role="dialog" aria-modal="true" aria-labelledby="v155-account-view-title">' +
      '<header class="v155-account-view-head"><div><span class="v155-youtube-source-badge">YouTube</span>' +
      '<h2 id="v155-account-view-title"></h2><p id="v155-account-view-meta"></p></div>' +
      '<button class="v155-detail-close" type="button" data-v155-account-close="1" aria-label="关闭">×</button></header>' +
      '<main id="v155-account-view-body" class="v155-account-view-body"></main></div>';
    mask.addEventListener('click', function (event) {
      if (event.target === mask || (event.target.closest && event.target.closest('[data-v155-account-close]'))) {
        accountViewState.token += 1;
        if (typeof window.closeGsapModal === 'function') window.closeGsapModal(mask);
        else mask.classList.remove('show');
        return;
      }
      var more = event.target && event.target.closest && event.target.closest('[data-v155-account-more]');
      var retry = event.target && event.target.closest && event.target.closest('[data-v155-account-retry]');
      var openSong = event.target && event.target.closest && event.target.closest('[data-v155-account-open-song]');
      var entity = event.target && event.target.closest && event.target.closest('[data-v155-account-entity]');
      var openLikes = event.target && event.target.closest && event.target.closest('[data-v155-account-open-likes]');
      if (more) loadAccountView(true);
      else if (retry) loadAccountView(false);
      else if (openSong) openAccountSong(finite(openSong.getAttribute('data-v155-account-open-song'), -1));
      else if (entity) openAccountEntity(finite(entity.getAttribute('data-v155-account-entity'), -1));
      else if (openLikes) openYouTubeExternal('https://www.youtube.com/playlist?list=LL', 'YouTube 喜欢的视频');
    });
    document.body.appendChild(mask);
    return mask;
  }

  function renderAccountView() {
    var title = byId('v155-account-view-title');
    var meta = byId('v155-account-view-meta');
    var body = byId('v155-account-view-body');
    if (!title || !meta || !body) return;
    title.textContent = ACCOUNT_VIEW_LABELS[accountViewState.view] || 'YouTube 账号内容';
    meta.textContent = accountViewState.total ? accountViewState.total + ' 项' : '';
    if (accountViewState.loading && !accountViewState.items.length) {
      body.innerHTML = stateMarkup('正在读取账号内容', '正在连接 YouTube');
      return;
    }
    if (accountViewState.error && !accountViewState.items.length) {
      body.innerHTML = stateMarkup('读取失败', apiErrorText(accountViewState.error)) +
        '<button class="fx-mini-btn v155-account-retry" type="button" data-v155-account-retry="1">重试</button>';
      return;
    }
    if (!accountViewState.items.length) {
      body.innerHTML = stateMarkup('这里还没有内容', 'YouTube 账号暂未返回相关项目');
      return;
    }
    if (accountViewState.view === 'likes') {
      body.innerHTML = '<div class="v155-account-view-toolbar"><button class="modal-btn primary" type="button" data-v155-account-open-likes="1">' +
        '在 YouTube 中打开 ↗</button></div>' +
        '<div class="v155-account-song-list">' + accountViewState.items.map(function (song, index) {
          return '<div class="v155-detail-row">' +
            '<span class="v155-detail-index">' + String(index + 1).padStart(2, '0') + '</span>' +
            resultImage(song, 'v155-detail-cover-small') +
            '<button class="v155-detail-main" type="button" data-v155-account-open-song="' + index + '" ' +
            'title="在 YouTube Music 中打开">' +
            '<span class="v155-result-name">' + esc(song.name || '未命名') + '</span>' +
            '<span class="v155-result-meta"><span class="v155-youtube-source-badge">YouTube</span>' + esc(songMeta(song)) +
            '</span></button><span class="v155-detail-external" aria-hidden="true">↗</span></div>';
        }).join('') + '</div>';
    } else {
      var type = accountViewState.view === 'subscriptions' ? 'artist' : 'playlist';
      body.innerHTML = '<div class="v155-account-entity-grid">' + accountViewState.items.map(function (item, index) {
        return '<button class="v155-entity-card ' + type + '" type="button" data-v155-account-entity="' + index + '">' +
          resultImage(item, 'v155-entity-cover') +
          '<span class="v155-result-copy"><span class="v155-result-name">' + esc(item.name || item.title || '未命名') + '</span>' +
          '<span class="v155-result-meta"><span class="v155-youtube-source-badge">YouTube</span>' + esc(entityMeta(item, type)) + '</span></span>' +
          '<span class="v155-result-action" aria-hidden="true">›</span></button>';
      }).join('') + '</div>';
    }
    if (accountViewState.nextPageToken) {
      body.innerHTML += '<button class="fx-mini-btn ghost v155-detail-more" type="button" data-v155-account-more="1">' +
        (accountViewState.loading ? '正在加载' : '加载更多') + '</button>';
    }
    if (accountViewState.error) {
      body.innerHTML += '<div class="v155-inline-error" role="status"><span>' +
        esc(apiErrorText(accountViewState.error, '加载更多失败')) +
        '</span><button class="fx-mini-btn ghost" type="button" data-v155-account-more="1">重试</button></div>';
    }
  }

  async function loadAccountView(append) {
    if (!accountViewState.view || accountViewState.loading) return;
    if (!append) {
      accountViewState.items = [];
      accountViewState.nextPageToken = '';
      accountViewState.total = 0;
    }
    accountViewState.error = null;
    accountViewState.loading = true;
    var token = ++accountViewState.token;
    renderAccountView();
    try {
      var url = '/api/youtube/account/' + accountViewState.view + '?limit=30';
      if (append && accountViewState.nextPageToken) {
        url += '&pageToken=' + encodeURIComponent(accountViewState.nextPageToken);
      }
      var payload = await window.apiJson(url, { timeoutMs: 22000 });
      if (token !== accountViewState.token) return;
      var incoming = accountViewState.view === 'likes'
        ? (payload.songs || payload.items || [])
        : (accountViewState.view === 'subscriptions'
          ? (payload.artists || payload.items || [])
          : (payload.playlists || payload.items || []));
      accountViewState.items = mergeUnique(
        append ? accountViewState.items : [],
        incoming,
        accountViewState.view === 'likes' ? songKey : entityKey
      );
      accountViewState.total = finite(payload.total, accountViewState.items.length);
      accountViewState.nextPageToken = String(payload.nextPageToken || '');
      accountViewState.error = null;
    } catch (error) {
      if (token !== accountViewState.token) return;
      accountViewState.error = error;
      var code = apiErrorCode(error);
      if (code === 'YOUTUBE_OAUTH_LOGIN_REQUIRED' || code === 'YOUTUBE_OAUTH_SESSION_EXPIRED') {
        oauthState.connected = false;
        oauthState.error = code;
        oauthState.message = apiErrorText(error);
        updateOAuthUi();
      }
    } finally {
      if (token === accountViewState.token) {
        accountViewState.loading = false;
        renderAccountView();
      }
    }
  }

  function openYouTubeAccountView(view) {
    if (!oauthState.connected) {
      openYouTubeLogin(null, true);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(ACCOUNT_VIEW_LABELS, view)) return;
    accountViewState.view = view;
    accountViewState.items = [];
    accountViewState.nextPageToken = '';
    accountViewState.total = 0;
    accountViewState.loading = false;
    accountViewState.error = null;
    accountViewState.scrollTop = 0;
    accountViewState.token += 1;
    var mask = ensureAccountViewModal();
    renderAccountView();
    var sourceMask = [byId('settings-modal'), byId('login-modal'), byId('user-modal')].find(function (candidate) {
      return candidate && candidate.classList.contains('show');
    });
    if (sourceMask && sourceMask.id === 'login-modal' && typeof window.stopQrPoll === 'function') window.stopQrPoll();
    transitionModal(sourceMask, mask, function () {
      loadAccountView(false);
    });
  }
  window.openYouTubeAccountView = openYouTubeAccountView;

  function closeAccountView() {
    var mask = byId('v155-youtube-account-view');
    if (!mask) return;
    accountViewState.token += 1;
    accountViewState.loading = false;
    if (typeof window.closeGsapModal === 'function') window.closeGsapModal(mask);
    else mask.classList.remove('show');
  }
  window.closeYouTubeAccountViewModal = closeAccountView;

  function openAccountSong(index) {
    if (!accountViewState.items[index]) return;
    openYouTubeSong(accountViewState.items[index]);
  }

  function openAccountEntity(index) {
    var item = accountViewState.items[index];
    if (!item) return;
    var body = byId('v155-account-view-body');
    accountViewState.scrollTop = body ? body.scrollTop : 0;
    openEntityItem(
      accountViewState.view === 'subscriptions' ? 'artist' : 'playlist',
      item,
      true,
      { returnToAccount: true, fromMask: byId('v155-youtube-account-view') }
    );
  }

  function bindOAuthControls() {
    var mainPrimary = byId('youtube-main-login-primary');
    var mainCancel = byId('youtube-main-login-cancel');
    if (mainPrimary) mainPrimary.addEventListener('click', handleMainYouTubeLogin);
    if (mainCancel) mainCancel.addEventListener('click', cancelYouTubeOAuthLogin);
  }

  function safeYouTubeId(value, maxLength) {
    value = String(value || '').trim();
    return value && value.length <= (maxLength || 200) && /^[A-Za-z0-9_-]+$/.test(value) ? value : '';
  }

  function youtubeSongUrl(song) {
    var id = safeYouTubeId(videoId(song), 64);
    return id ? 'https://music.youtube.com/watch?v=' + encodeURIComponent(id) : '';
  }

  function youtubeEntityUrl(type, item) {
    var id = type === 'artist'
      ? safeYouTubeId(item && (item.channelId || item.id), 128)
      : safeYouTubeId(item && (item.playlistId || item.id), 200);
    if (!id) return '';
    return type === 'artist'
      ? 'https://music.youtube.com/channel/' + encodeURIComponent(id)
      : 'https://music.youtube.com/playlist?list=' + encodeURIComponent(id);
  }

  function youtubeSearchUrl(query) {
    query = String(query || '').trim().slice(0, 200);
    return query ? 'https://music.youtube.com/search?q=' + encodeURIComponent(query) : '';
  }

  function openYouTubeExternal(url, label) {
    var api = window.desktopWindow;
    if (!url || !api || typeof api.openYouTubeContent !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('当前环境无法打开 YouTube');
      return false;
    }
    Promise.resolve(api.openYouTubeContent(url)).then(function (result) {
      if (!result || result.ok !== true) {
        throw new Error(result && result.error || 'YOUTUBE_CONTENT_OPEN_FAILED');
      }
      if (typeof window.showToast === 'function') {
        window.showToast('已在系统浏览器中打开' + (label ? ': ' + label : ''));
      }
    }).catch(function () {
      if (typeof window.showToast === 'function') window.showToast('无法在系统浏览器中打开 YouTube');
    });
    return true;
  }

  function openYouTubeSong(song) {
    return openYouTubeExternal(youtubeSongUrl(song), song && (song.name || song.title) || 'YouTube Music');
  }

  function openYouTubeEntity(type, item) {
    return openYouTubeExternal(youtubeEntityUrl(type, item), item && (item.name || item.title) || 'YouTube Music');
  }

  async function playYouTubeQueueAt(index) {
    var song = window.playQueue && window.playQueue[index];
    if (!isYouTubeSong(song)) return false;
    return openYouTubeSong(song);
  }

  window.MineradioYouTubeV155 = {
    isSong: isYouTubeSong,
    active: function () { return false; },
    connected: function () { return oauthState.connected; },
    accountStatus: function () {
      var account = oauthState.account || {};
      return {
        provider: 'youtube',
        loggedIn: oauthState.connected,
        nickname: youtubeAccountName(),
        userId: account.channelId || account.id || '',
        avatar: youtubeAccountAvatar(),
        email: account.email || '',
        vipType: 0,
      };
    },
    isPlaying: function () { return false; },
    playQueueAt: playYouTubeQueueAt,
    play: function () { return false; },
    pause: function () { return false; },
    stop: function () { return false; },
    seekTo: function () { return false; },
    currentTime: function () { return 0; },
    duration: function () { return 0; },
    setVolume: function () { return false; },
    handleMediaAction: function () { return false; },
  };

  function withInternalSearchSongs(callback, context, args, emptyAction) {
    var source = Array.isArray(window.playlist) ? window.playlist : [];
    var internalSongs = source.filter(function (song) { return !isYouTubeSong(song); });
    if (internalSongs.length === source.length) return callback.apply(context, args);
    if (!internalSongs.length) return emptyAction ? emptyAction() : false;
    window.playlist = internalSongs;
    try {
      return callback.apply(context, args);
    } finally {
      window.playlist = source;
    }
  }

  function openCurrentYouTubeSearch() {
    var input = byId('search-input');
    var query = input ? input.value.trim() : '';
    var first = Array.isArray(window.playlist)
      ? window.playlist.find(function (song) { return isYouTubeSong(song); })
      : null;
    return query
      ? openYouTubeExternal(youtubeSearchUrl(query), 'YouTube Music 搜索')
      : openYouTubeSong(first);
  }

  function decorateCombinedYouTubeRows() {
    var results = byId('search-results');
    if (!results) return;
    Array.prototype.forEach.call(results.querySelectorAll('.search-result.youtube-source'), function (row) {
      var main = row.querySelector('.search-result-main');
      if (main) {
        main.classList.add('v155-external-result');
        main.setAttribute('aria-label', '在 YouTube Music 中打开此结果');
        main.title = '在 YouTube Music 中打开';
      }
      Array.prototype.forEach.call(row.querySelectorAll('.add-btn, .search-result-more'), function (control) {
        control.remove();
      });
    });
  }

  function observeCombinedYouTubeRows() {
    var results = byId('search-results');
    if (!results || typeof MutationObserver !== 'function') return;
    decorateCombinedYouTubeRows();
    var observer = new MutationObserver(decorateCombinedYouTubeRows);
    observer.observe(results, { childList: true, subtree: true });
  }

  function installOverrides() {
    window.clearSearchResults = function () {
      resetSearch(true);
      return legacy.clearSearchResults.apply(this, arguments);
    };
    window.doSearch = function (query, options) {
      if (String(window.searchMode || '') === 'youtube') return runYouTubeSearch(query, false);
      return legacy.doSearch.apply(this, arguments);
    };
    window.loadMoreSearchResults = function () {
      if (String(window.searchMode || '') === 'youtube') return runYouTubeSearch(searchState.query, true);
      return legacy.loadMoreSearchResults.apply(this, arguments);
    };
    window.retryV140Search = function () {
      if (String(window.searchMode || '') === 'youtube') return runYouTubeSearch(searchState.query, false);
      return legacy.retrySearch.apply(this, arguments);
    };
    window.updateSearchModeTabs = function () {
      var result = legacy.updateSearchModeTabs.apply(this, arguments);
      syncSearchTypes();
      return result;
    };
    window.playSearchResult = function (index) {
      var song = Array.isArray(window.playlist) ? window.playlist[index] : null;
      if (isYouTubeSong(song)) return openYouTubeSong(song);
      return legacy.playSearchResult.apply(this, arguments);
    };
    window.queueSearchResult = function (index) {
      var song = Array.isArray(window.playlist) ? window.playlist[index] : null;
      if (isYouTubeSong(song)) return openYouTubeSong(song);
      return legacy.queueSearchResult.apply(this, arguments);
    };
    window.playAllSearchResults = function () {
      return withInternalSearchSongs(legacy.playAllSearchResults, this, arguments, openCurrentYouTubeSearch);
    };
    window.addAllSearchResultsToQueue = function () {
      return withInternalSearchSongs(legacy.addAllSearchResultsToQueue, this, arguments, function () {
        if (typeof window.showToast === 'function') window.showToast('YouTube 内容不会加入应用播放队列');
        return false;
      });
    };
    window.shuffleAllSearchResults = function () {
      return withInternalSearchSongs(legacy.shuffleAllSearchResults, this, arguments, openCurrentYouTubeSearch);
    };
  }

  injectSearchTypes();
  ensureDetailModal();
  ensureAccountViewModal();
  bindSearchResults();
  installMainAccountIntegration();
  bindOAuthControls();
  installOverrides();
  observeCombinedYouTubeRows();
  syncSearchTypes();
  syncMainAccountUi();
  loadYouTubeOAuthStatus().catch(function () {});
  window.addEventListener('beforeunload', function () {
    stopOAuthPolling();
  }, { once: true });
  window.__mineradioV155 = {
    search: searchState,
    detail: detailState,
    accountView: accountViewState,
    oauth: oauthState,
  };
})();
