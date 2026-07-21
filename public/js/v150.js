(function () {
  'use strict';

  var experience = window.MineradioCore && window.MineradioCore.neteaseExperience;
  if (!experience) {
    console.error('[V150] netease-experience.js must be loaded before v150.js');
    return;
  }

  var legacy = {
    clearSearchResults: window.clearSearchResults,
    doSearch: window.doSearch,
    loadMoreSearchResults: window.loadMoreSearchResults,
    playAllSearchResults: window.playAllSearchResults,
    retrySearch: window.retryV140Search,
    updateSearchModeTabs: window.updateSearchModeTabs,
    openPlaylistPanelDetail: window.openPlaylistPanelDetail,
    loadPlaylistIntoQueueById: window.loadPlaylistIntoQueueById,
    refreshUserPlaylists: window.refreshUserPlaylists,
    renderUserPlaylistsList: window.renderUserPlaylistsList,
    closeGsapModal: window.closeGsapModal,
  };

  var SEARCH_TYPES = ['song', 'artist', 'album', 'playlist'];
  var SEARCH_TYPE_LABELS = {
    song: '单曲',
    artist: '歌手',
    album: '专辑',
    playlist: '歌单',
  };
  var DISCOVER_SECTIONS = [
    { id: 'toplists', label: '排行榜', kind: 'playlist' },
    { id: 'new-songs', label: '新歌', kind: 'song' },
    { id: 'new-albums', label: '新碟', kind: 'album' },
    { id: 'playlists', label: '歌单广场', kind: 'playlist' },
    { id: 'favorite-albums', label: '收藏专辑', kind: 'album', auth: true },
    { id: 'followed-artists', label: '关注歌手', kind: 'artist', auth: true },
    { id: 'listening-rank', label: '听歌排行', kind: 'song', auth: true },
    { id: 'recent', label: '最近播放', kind: 'song', auth: true },
    { id: 'cloud', label: '云盘', kind: 'song', auth: true },
  ];

  var typedSearch = {
    type: 'song',
    query: '',
    items: [],
    offset: 0,
    total: 0,
    hasMore: false,
    loading: false,
    token: 0,
  };
  var discoverState = {
    section: 'toplists',
    mode: 'list',
    items: [],
    offset: 0,
    total: 0,
    hasMore: false,
    loading: false,
    token: 0,
    cat: '全部',
    categories: [],
    categoriesLoaded: false,
  };
  var discoverPlaylist = {
    playlist: null,
    tracks: [],
    loading: false,
    complete: false,
    failed: false,
    total: 0,
    visible: 120,
    token: 0,
  };
  var metadataEditState = { playlist: null, pid: '' };
  var searchPlayAllBusy = false;
  var searchPlayAllToken = 0;
  var playlistQueueBusy = false;
  var userPlaylistRefreshToken = 0;
  var userPlaylistsComplete = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function finite(value, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? value : fallback;
  }

  function html(value) {
    if (typeof window.escHtml === 'function') return window.escHtml(String(value == null ? '' : value));
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clone(item) {
    return typeof window.cloneSong === 'function'
      ? window.cloneSong(item)
      : Object.assign({}, item || {});
  }

  function itemKey(item) {
    if (typeof window.queueItemKey === 'function') {
      var queueKey = window.queueItemKey(item);
      if (queueKey) return queueKey;
    }
    return experience.itemIdentity(item);
  }

  function mergeItems(existing, incoming) {
    return experience.mergeUnique(existing, incoming, itemKey);
  }

  function currentMode() {
    return String(window.searchMode || 'song');
  }

  function isNeteaseLoggedIn() {
    return !!(window.loginStatus && window.loginStatus.loggedIn);
  }

  function coverOf(item) {
    item = item || {};
    return item.cover || item.picUrl || item.coverImgUrl || item.avatar || item.avatarUrl || '';
  }

  function creatorName(item) {
    item = item || {};
    var creator = item.creator;
    if (creator && typeof creator === 'object') return creator.nickname || creator.name || '';
    return creator || item.creatorName || item.artist || '';
  }

  function artistName(item) {
    item = item || {};
    if (typeof item.artist === 'string') return item.artist;
    if (item.artist && typeof item.artist === 'object') return item.artist.name || '';
    if (Array.isArray(item.artists)) {
      return item.artists.map(function (artist) { return artist && artist.name; }).filter(Boolean).join(' / ');
    }
    return item.artistName || '';
  }

  function formatCount(value) {
    value = Math.max(0, finite(value, 0));
    if (value >= 100000000) return (value / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (value >= 10000) return (value / 10000).toFixed(value >= 100000 ? 0 : 1).replace(/\.0$/, '') + '万';
    return value ? String(value) : '';
  }

  function formatDate(value) {
    var timestamp = finite(value, 0);
    if (!timestamp) return '';
    try {
      return new Date(timestamp).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  function apiError(payload, fallback) {
    var successfulPayload = !!payload && !payload.error && payload.ok !== false;
    if (successfulPayload && experience.shouldInvalidateSession(payload, isNeteaseLoggedIn())) {
      invalidateNeteaseSession({ payload: payload });
    }
    if (!payload || successfulPayload) return null;
    var error = new Error(payload.message || payload.errorReason || payload.error || fallback || '请求失败');
    error.code = payload.errorCode || payload.code || payload.error || '';
    error.status = finite(payload.status, 0);
    error.payload = payload;
    var normalizedCode = String(error.code || '').toUpperCase();
    error.authRequired = payload.loggedIn === false || error.status === 401 ||
      normalizedCode === '301' || normalizedCode === '401' ||
      normalizedCode === 'LOGIN_REQUIRED' || normalizedCode === 'LOGIN_EXPIRED' || normalizedCode === 'AUTH_EXPIRED';
    return error;
  }

  function isNeteaseAuthFailure(error) {
    var payload = error && error.payload || {};
    var code = String(error && error.code || payload.errorCode || payload.error || payload.code || '').toUpperCase();
    return !!(error && error.status === 401) || payload.loggedIn === false || payload.authExpired === true ||
      code === 'LOGIN_REQUIRED' || code === 'LOGIN_EXPIRED' || code === 'AUTH_EXPIRED';
  }

  function invalidateNeteaseSession(error) {
    if (!isNeteaseAuthFailure(error)) return false;
    if (window.loginStatus) {
      window.loginStatus.loggedIn = false;
      window.loginStatus.authExpired = true;
    }
    if (window.desktopWindow && typeof window.desktopWindow.invalidateNeteaseMusicLogin === 'function') {
      Promise.resolve(window.desktopWindow.invalidateNeteaseMusicLogin()).catch(function () {});
    }
    if (typeof window.refreshLoginStatus === 'function') {
      Promise.resolve(window.refreshLoginStatus(true)).catch(function () {});
    }
    return true;
  }

  function renderPlaylistLoginRequired() {
    var list = byId('pl-list');
    if (!list) return;
    list.innerHTML = '<div class="v150-state"><div class="v150-state-copy"><strong>网易云登录状态已失效</strong>' +
      '<span>重新登录后即可继续查看歌单</span><button class="fx-mini-btn" type="button" data-v150-login="1">重新登录</button></div></div>';
  }

  function errorText(error, fallback) {
    if (error && (error.authRequired || error.kind === 'auth_required' || error.status === 401)) {
      return '网易云登录状态已失效';
    }
    if (error && error.kind === 'offline') return '当前处于离线状态';
    if (error && error.kind === 'timeout') return '请求超时，请稍后重试';
    if (error && error.kind === 'rate_limited') return '请求过于频繁，请稍后重试';
    if (error && error.kind === 'server') return '网易云服务暂时不可用';
    return error && error.message ? error.message : (fallback || '加载失败');
  }

  function postJson(url, data) {
    return window.apiJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    });
  }

  function showOperation(text, state) {
    var node = byId('v150-operation-status');
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('show', !!text);
    node.classList.toggle('busy', state === 'busy');
    node.classList.toggle('error', state === 'error');
    if (node.__hideTimer) clearTimeout(node.__hideTimer);
    if (text && state !== 'busy') {
      node.__hideTimer = setTimeout(function () {
        node.classList.remove('show', 'error');
      }, 3400);
    }
  }

  function hideOperationSoon() {
    var node = byId('v150-operation-status');
    if (!node) return;
    if (node.__hideTimer) clearTimeout(node.__hideTimer);
    node.__hideTimer = setTimeout(function () {
      node.classList.remove('show', 'busy', 'error');
    }, 900);
  }

  function installStyles() {
    if (byId('v150-runtime-styles')) return;
    var style = document.createElement('style');
    style.id = 'v150-runtime-styles';
    style.textContent = [
      '#v150-search-types{display:none;align-items:center;gap:4px;width:max-content;max-width:100%;margin-top:6px;padding:3px;border:1px solid rgba(255,255,255,.07);border-radius:7px;background:rgba(8,11,14,.42)}',
      '#v150-search-types.show{display:flex}',
      '#v150-search-types button{height:25px;padding:0 11px;border:0;border-radius:5px;background:transparent;color:rgba(255,255,255,.43);font:650 10.5px/1 inherit;cursor:pointer}',
      '#v150-search-types button:hover,#v150-search-types button:focus-visible{color:#fff;background:rgba(255,255,255,.06)}',
      '#v150-search-types button.active{color:#fff;background:rgba(var(--fc-accent-rgb),.13);box-shadow:inset 0 0 0 1px rgba(var(--fc-accent-rgb),.25)}',
      'body.empty-home-active.diy-mode #v150-search-types{display:none}',
      '.v150-entity-toolbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;min-height:42px;padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(10,13,16,.94);backdrop-filter:blur(18px)}',
      '.v150-entity-toolbar strong{font-size:11px;color:rgba(255,255,255,.82)}',
      '.v150-entity-toolbar span{font-size:10px;color:rgba(255,255,255,.36)}',
      '.v150-entity-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;padding:5px}',
      '.v150-entity-card{min-width:0;display:grid;grid-template-columns:48px minmax(0,1fr) 18px;align-items:center;gap:10px;min-height:64px;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}',
      '.v150-entity-card:hover,.v150-entity-card:focus-visible{background:rgba(255,255,255,.055);outline:none}',
      '.v150-entity-cover{width:48px;height:48px;border-radius:6px;object-fit:cover;background:rgba(255,255,255,.055)}',
      '.v150-entity-card.artist .v150-entity-cover{border-radius:50%}',
      '.v150-entity-copy{min-width:0}',
      '.v150-entity-name,.v150-entity-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.v150-entity-name{font-size:11.5px;font-weight:680;color:rgba(255,255,255,.88)}',
      '.v150-entity-meta{margin-top:5px;font-size:9.8px;color:rgba(255,255,255,.38)}',
      '.v150-entity-open{font-size:18px;color:rgba(255,255,255,.28)}',
      '.v150-search-more{display:block;margin:7px auto 11px}',
      '#v150-operation-status{position:fixed;left:50%;bottom:96px;z-index:80;max-width:min(480px,calc(100vw - 32px));padding:9px 13px;border:1px solid rgba(255,255,255,.10);border-radius:7px;background:rgba(10,13,16,.94);box-shadow:0 12px 36px rgba(0,0,0,.4);color:rgba(255,255,255,.76);font-size:10.5px;opacity:0;visibility:hidden;transform:translate(-50%,8px);transition:opacity .18s,transform .18s,visibility .18s}',
      '#v150-operation-status.show{opacity:1;visibility:visible;transform:translate(-50%,0)}',
      '#v150-operation-status.busy{border-color:rgba(var(--fc-accent-rgb),.26)}',
      '#v150-operation-status.error{border-color:rgba(255,112,136,.34);color:#ffc5ce}',
      '#v150-discover-modal{z-index:58}',
      '.v150-discover-modal{width:min(1000px,95vw);height:min(760px,91vh);max-width:none;padding:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden;text-align:left}',
      '.v150-discover-head{display:flex;align-items:center;gap:14px;padding:18px 20px 13px;border-bottom:1px solid rgba(255,255,255,.065)}',
      '.v150-discover-heading{min-width:0;margin-right:auto}',
      '.v150-discover-kicker{font-size:9px;font-weight:760;color:rgba(var(--fc-accent-rgb),.72);letter-spacing:0}',
      '.v150-discover-title{margin-top:4px;font-size:20px;font-weight:740;color:rgba(255,255,255,.94)}',
      '.v150-icon-command{width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.10);border-radius:7px;background:rgba(255,255,255,.035);color:rgba(255,255,255,.67);font:20px/1 inherit;cursor:pointer}',
      '.v150-icon-command:hover,.v150-icon-command:focus-visible{color:#fff;background:rgba(255,255,255,.08)}',
      '.v150-discover-tabs{display:flex;align-items:center;gap:3px;padding:7px 14px;overflow-x:auto;border-bottom:1px solid rgba(255,255,255,.055)}',
      '.v150-discover-tabs button{height:29px;flex:0 0 auto;padding:0 11px;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.42);font:650 10.5px/1 inherit;cursor:pointer}',
      '.v150-discover-tabs button:hover,.v150-discover-tabs button:focus-visible{color:#fff;background:rgba(255,255,255,.055)}',
      '.v150-discover-tabs button.active{color:#fff;background:rgba(var(--fc-accent-rgb),.12);box-shadow:inset 0 0 0 1px rgba(var(--fc-accent-rgb),.22)}',
      '.v150-discover-body{min-height:0;overflow:auto;padding:14px 18px 20px}',
      '.v150-discover-body::-webkit-scrollbar{width:6px}.v150-discover-body::-webkit-scrollbar-thumb{border-radius:999px;background:rgba(255,255,255,.14)}',
      '.v150-discover-subhead{display:flex;align-items:center;gap:10px;min-height:34px;margin-bottom:9px}',
      '.v150-discover-subhead strong{font-size:12px;color:rgba(255,255,255,.82)}',
      '.v150-category-select{margin-left:auto;height:29px;max-width:180px;padding:0 28px 0 9px;border:1px solid rgba(255,255,255,.10);border-radius:6px;background:#11161a;color:rgba(255,255,255,.74);font:10.5px/1 inherit}',
      '.v150-browse-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}',
      '.v150-browse-card{min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}',
      '.v150-browse-card:focus-visible{outline:1px solid rgba(var(--fc-accent-rgb),.7);outline-offset:4px}',
      '.v150-browse-cover{display:block;width:100%;aspect-ratio:1;object-fit:cover;border-radius:7px;background:rgba(255,255,255,.055);box-shadow:0 10px 28px rgba(0,0,0,.24);transition:transform .18s,filter .18s}',
      '.v150-browse-card:hover .v150-browse-cover{transform:translateY(-2px);filter:brightness(1.08)}',
      '.v150-browse-card.artist .v150-browse-cover{border-radius:50%}',
      '.v150-browse-name,.v150-browse-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.v150-browse-name{margin-top:8px;font-size:11px;font-weight:680;color:rgba(255,255,255,.86)}',
      '.v150-browse-meta{margin-top:4px;font-size:9.5px;color:rgba(255,255,255,.34)}',
      '.v150-song-list{display:grid;gap:1px}',
      '.v150-song-row{display:grid;grid-template-columns:30px 42px minmax(0,1fr) minmax(120px,.55fr) auto;align-items:center;gap:10px;min-height:57px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.045)}',
      '.v150-song-index{font:600 9.5px/1 var(--font-mono);text-align:center;color:rgba(255,255,255,.24)}',
      '.v150-song-cover{width:42px;height:42px;border-radius:6px;object-fit:cover;background:rgba(255,255,255,.055)}',
      '.v150-song-main{min-width:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}',
      '.v150-song-main:hover .v150-song-name,.v150-song-main:focus-visible .v150-song-name{color:#fff}',
      '.v150-song-name,.v150-song-artist,.v150-song-album{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.v150-song-name{font-size:11.5px;font-weight:670;color:rgba(255,255,255,.84)}',
      '.v150-song-artist,.v150-song-album{font-size:9.8px;color:rgba(255,255,255,.34);margin-top:4px}',
      '.v150-row-add{width:29px;height:29px;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(255,255,255,.025);color:rgba(255,255,255,.52);font:17px/1 inherit;cursor:pointer}',
      '.v150-row-add:hover,.v150-row-add:focus-visible{color:#fff;background:rgba(255,255,255,.07)}',
      '.v150-state{min-height:260px;display:grid;place-items:center;padding:30px;text-align:center}',
      '.v150-state-copy strong,.v150-state-copy span{display:block}',
      '.v150-state-copy strong{font-size:13px;color:rgba(255,255,255,.78)}',
      '.v150-state-copy span{max-width:420px;margin-top:7px;font-size:10.5px;line-height:1.55;color:rgba(255,255,255,.38)}',
      '.v150-state-copy button{margin-top:14px}',
      '.v150-load-more{display:block;margin:17px auto 0}',
      '.v150-playlist-hero{display:grid;grid-template-columns:112px minmax(0,1fr);gap:17px;padding:4px 2px 17px;border-bottom:1px solid rgba(255,255,255,.065)}',
      '.v150-playlist-cover{width:112px;height:112px;border-radius:7px;object-fit:cover;background:rgba(255,255,255,.055)}',
      '.v150-playlist-copy{min-width:0;align-self:center}',
      '.v150-playlist-title{font-size:19px;font-weight:740;color:rgba(255,255,255,.93)}',
      '.v150-playlist-meta{margin-top:6px;font-size:10px;color:rgba(255,255,255,.39)}',
      '.v150-playlist-description{max-width:680px;margin-top:8px;font-size:10.5px;line-height:1.55;color:rgba(255,255,255,.45);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.v150-playlist-actions{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:12px}',
      '.v150-inline-progress{padding:8px 11px;margin:4px 0 7px;border:1px solid rgba(var(--fc-accent-rgb),.14);border-radius:6px;background:rgba(var(--fc-accent-rgb),.045);font-size:9.8px;color:rgba(255,255,255,.45)}',
      '.v150-owner-tools{display:flex;align-items:center;gap:6px;margin-left:auto}',
      '.v150-meta-modal{width:min(540px,92vw);padding:22px;text-align:left}',
      '.v150-meta-modal h2{margin:0;font-size:17px;color:rgba(255,255,255,.92)}',
      '.v150-form-grid{display:grid;gap:12px;margin-top:17px}',
      '.v150-form-grid label{display:grid;gap:6px;font-size:10px;color:rgba(255,255,255,.48)}',
      '.v150-form-grid input,.v150-form-grid textarea,.v150-form-grid select{width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.10);border-radius:6px;background:rgba(255,255,255,.035);color:#fff;font:11px/1.4 inherit;outline:none}',
      '.v150-form-grid input,.v150-form-grid select{height:36px;padding:0 10px}',
      '.v150-form-grid textarea{min-height:88px;padding:9px 10px;resize:vertical}',
      '.v150-form-grid input:focus,.v150-form-grid textarea:focus,.v150-form-grid select:focus{border-color:rgba(var(--fc-accent-rgb),.5)}',
      '.v150-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
      '@media(max-width:820px){.v150-browse-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.v150-entity-grid{grid-template-columns:1fr}.v150-song-row{grid-template-columns:26px 40px minmax(0,1fr) auto}.v150-song-album{display:none}}',
      '@media(max-width:560px){.v150-discover-modal{width:100vw;height:100vh;max-height:none;border-radius:0}.v150-discover-head{padding:14px}.v150-discover-body{padding:12px}.v150-browse-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.v150-playlist-hero{grid-template-columns:82px minmax(0,1fr)}.v150-playlist-cover{width:82px;height:82px}.v150-playlist-title{font-size:16px}}',
    ].join('');
    document.head.appendChild(style);
  }

  function injectShell() {
    var searchTabs = byId('search-mode-tabs');
    if (searchTabs && !byId('v150-search-types')) {
      var types = document.createElement('div');
      types.id = 'v150-search-types';
      types.setAttribute('role', 'tablist');
      types.setAttribute('aria-label', '网易云搜索类型');
      types.innerHTML = SEARCH_TYPES.map(function (type) {
        return '<button type="button" role="tab" data-v150-search-type="' + type + '" aria-selected="' +
          (type === typedSearch.type ? 'true' : 'false') + '">' + SEARCH_TYPE_LABELS[type] + '</button>';
      }).join('');
      searchTabs.insertAdjacentElement('afterend', types);
    }

    var homeRow = document.querySelector('.home-quick-row');
    if (homeRow && !byId('home-discover-btn')) {
      var discoverButton = document.createElement('button');
      discoverButton.id = 'home-discover-btn';
      discoverButton.className = 'home-chip';
      discoverButton.type = 'button';
      discoverButton.textContent = '发现';
      discoverButton.setAttribute('aria-label', '打开网易云发现');
      discoverButton.addEventListener('click', function () { openNeteaseDiscover('toplists'); });
      homeRow.appendChild(discoverButton);
    }

    if (!byId('v150-operation-status')) {
      var status = document.createElement('div');
      status.id = 'v150-operation-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      document.body.appendChild(status);
    }

    ensureDiscoverModal();
    ensureMetadataModal();
  }

  function ensureDiscoverModal() {
    if (byId('v150-discover-modal')) return byId('v150-discover-modal');
    var mask = document.createElement('div');
    mask.id = 'v150-discover-modal';
    mask.className = 'modal-mask';
    mask.setAttribute('aria-hidden', 'true');
    mask.innerHTML =
      '<div class="modal v150-discover-modal" role="dialog" aria-modal="true" aria-labelledby="v150-discover-title">' +
        '<header class="v150-discover-head">' +
          '<button id="v150-discover-back" class="v150-icon-command" type="button" aria-label="返回发现列表" title="返回" hidden>‹</button>' +
          '<div class="v150-discover-heading"><div class="v150-discover-kicker">NETEASE DISCOVER</div><div id="v150-discover-title" class="v150-discover-title">发现</div></div>' +
          '<button class="v150-icon-command" type="button" data-v150-close-discover="1" aria-label="关闭发现">×</button>' +
        '</header>' +
        '<div id="v150-discover-tabs" class="v150-discover-tabs" role="tablist" aria-label="发现栏目"></div>' +
        '<main id="v150-discover-body" class="v150-discover-body"></main>' +
      '</div>';
    mask.addEventListener('click', function (event) {
      if (event.target === mask || (event.target.closest && event.target.closest('[data-v150-close-discover]'))) {
        closeNeteaseDiscover();
      }
    });
    document.body.appendChild(mask);
    return mask;
  }

  function ensureMetadataModal() {
    if (byId('v150-metadata-modal')) return byId('v150-metadata-modal');
    var mask = document.createElement('div');
    mask.id = 'v150-metadata-modal';
    mask.className = 'modal-mask';
    mask.setAttribute('aria-hidden', 'true');
    mask.innerHTML =
      '<form id="v150-metadata-form" class="modal v150-meta-modal" role="dialog" aria-modal="true" aria-labelledby="v150-meta-title">' +
        '<h2 id="v150-meta-title">编辑歌单信息</h2>' +
        '<div class="v150-form-grid">' +
          '<label>名称<input id="v150-meta-name" name="name" maxlength="40" required></label>' +
          '<label>简介<textarea id="v150-meta-description" name="description" maxlength="1000"></textarea></label>' +
          '<label>标签<input id="v150-meta-tags" name="tags" maxlength="120" placeholder="多个标签用逗号分隔"></label>' +
          '<label>可见性<select id="v150-meta-privacy" name="privacy"><option value="0">公开</option><option value="10">仅自己可见</option></select></label>' +
        '</div>' +
        '<div class="v150-form-actions">' +
          '<button class="modal-btn" type="button" data-v150-close-meta="1">取消</button>' +
          '<button id="v150-meta-submit" class="modal-btn primary" type="submit">保存</button>' +
        '</div>' +
      '</form>';
    mask.addEventListener('click', function (event) {
      if (event.target === mask || (event.target.closest && event.target.closest('[data-v150-close-meta]'))) {
        window.closeGsapModal(mask);
      }
    });
    mask.querySelector('form').addEventListener('submit', submitMetadataEdit);
    document.body.appendChild(mask);
    return mask;
  }

  function syncSearchTypeUi() {
    var root = byId('v150-search-types');
    if (!root) return;
    var visible = currentMode() === 'netease';
    root.classList.toggle('show', visible);
    root.setAttribute('aria-hidden', visible ? 'false' : 'true');
    all('[data-v150-search-type]', root).forEach(function (button) {
      var active = button.getAttribute('data-v150-search-type') === typedSearch.type;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = visible && active ? 0 : -1;
    });
  }

  function resetTypedSearch(clearQuery) {
    typedSearch.token += 1;
    typedSearch.items = [];
    typedSearch.offset = 0;
    typedSearch.total = 0;
    typedSearch.hasMore = false;
    typedSearch.loading = false;
    if (clearQuery) typedSearch.query = '';
  }

  function setNeteaseSearchType(type) {
    if (SEARCH_TYPES.indexOf(type) < 0 || typedSearch.type === type) return;
    searchPlayAllToken += 1;
    typedSearch.type = type;
    resetTypedSearch(true);
    syncSearchTypeUi();
    if (typeof legacy.clearSearchResults === 'function') legacy.clearSearchResults();
    var input = byId('search-input');
    var query = input ? input.value.trim() : '';
    if (query) window.doSearch(query);
    else if (type === 'song' && typeof window.renderSearchHistory === 'function') window.renderSearchHistory();
  }
  window.setNeteaseSearchType = setNeteaseSearchType;

  function typedPayloadItems(payload, type) {
    var keys = type === 'artist'
      ? ['artists', 'items', 'results']
      : (type === 'album'
        ? ['albums', 'items', 'results']
        : ['playlists', 'items', 'results']);
    return experience.pageItems(payload, keys);
  }

  function typedEntityMeta(item, type) {
    if (type === 'artist') {
      var artistBits = [];
      if (item.albumCount || item.albumSize) artistBits.push((item.albumCount || item.albumSize) + ' 张专辑');
      if (item.musicCount || item.musicSize) artistBits.push((item.musicCount || item.musicSize) + ' 首歌曲');
      if (Array.isArray(item.alias) && item.alias.length) artistBits.push(item.alias[0]);
      return artistBits.join(' · ') || '网易云歌手';
    }
    if (type === 'album') {
      return [artistName(item), formatDate(item.publishTime), item.songCount ? item.songCount + ' 首' : ''].filter(Boolean).join(' · ');
    }
    return [
      creatorName(item),
      item.trackCount ? item.trackCount + ' 首' : '',
      item.playCount ? formatCount(item.playCount) + ' 次播放' : '',
    ].filter(Boolean).join(' · ');
  }

  function typedStateMarkup(title, detail, retry) {
    return '<div class="v150-state"><div class="v150-state-copy"><strong>' + html(title) + '</strong>' +
      (detail ? '<span>' + html(detail) + '</span>' : '') +
      (retry ? '<button class="fx-mini-btn" type="button" data-v150-retry-typed="1">重试</button>' : '') +
      '</div></div>';
  }

  function renderTypedSearch() {
    var results = byId('search-results');
    if (!results) return;
    var type = typedSearch.type;
    if (!typedSearch.items.length) {
      results.innerHTML = typedStateMarkup(
        typedSearch.loading ? '正在搜索' : '没有找到结果',
        typedSearch.loading ? '“' + typedSearch.query + '”' : '换一个关键词试试',
        false
      );
      results.classList.add('show');
      return;
    }
    var countLabel = typedSearch.total > typedSearch.items.length
      ? typedSearch.items.length + ' / ' + typedSearch.total
      : String(typedSearch.items.length);
    var cards = typedSearch.items.map(function (item, index) {
      var cover = coverOf(item);
      var coverMarkup = cover
        ? '<img class="v150-entity-cover" src="' + html(cover) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=.2">'
        : '<span class="v150-entity-cover"></span>';
      return '<button class="v150-entity-card ' + type + '" type="button" data-v150-typed-index="' + index + '">' +
        coverMarkup +
        '<span class="v150-entity-copy"><span class="v150-entity-name">' + html(item.name || item.title || '未命名') + '</span>' +
        '<span class="v150-entity-meta">' + html(typedEntityMeta(item, type)) + '</span></span>' +
        '<span class="v150-entity-open" aria-hidden="true">›</span></button>';
    }).join('');
    results.innerHTML =
      '<div class="v150-entity-toolbar"><strong>' + SEARCH_TYPE_LABELS[type] + '</strong><span>' + countLabel + ' 条结果</span></div>' +
      '<div class="v150-entity-grid" role="list">' + cards + '</div>' +
      (typedSearch.hasMore
        ? '<button class="fx-mini-btn ghost v150-search-more" type="button" data-v150-load-more-typed="1">加载更多</button>'
        : '');
    results.classList.add('show');
  }

  async function runTypedSearch(query, append) {
    query = String(query || '').trim();
    if (!query) return;
    var type = typedSearch.type;
    if (type === 'song') return legacy.doSearch(query);
    if (!append || typedSearch.query !== query) {
      resetTypedSearch(false);
      typedSearch.query = query;
    }
    if (typedSearch.loading) return;
    typedSearch.loading = true;
    var token = ++typedSearch.token;
    if (!append) renderTypedSearch();
    else {
      var more = byId('search-results') && byId('search-results').querySelector('[data-v150-load-more-typed]');
      if (more) { more.disabled = true; more.textContent = '正在加载'; }
    }
    try {
      var limit = 24;
      var payload = await window.apiJson(
        '/api/search/typed?keywords=' + encodeURIComponent(query) +
        '&type=' + encodeURIComponent(type) +
        '&limit=' + limit +
        '&offset=' + typedSearch.offset
      );
      var payloadError = apiError(payload, '搜索失败');
      if (payloadError) throw payloadError;
      if (token !== typedSearch.token || currentMode() !== 'netease' || typedSearch.type !== type) return;
      var incoming = typedPayloadItems(payload, type);
      var responseLimit = Math.max(1, finite(payload.limit, limit));
      var responseOffset = Math.max(0, finite(payload.offset, typedSearch.offset));
      typedSearch.items = experience.mergeUnique(append ? typedSearch.items : [], incoming, function (item) {
        return type + ':' + experience.itemIdentity(item);
      });
      typedSearch.total = experience.pageTotal(payload, typedSearch.items.length);
      typedSearch.offset = finite(payload.nextOffset, responseOffset + (incoming.length < responseLimit ? incoming.length : responseLimit));
      typedSearch.hasMore = experience.pageHasMore(
        payload,
        typedSearch.offset,
        typedSearch.total,
        incoming.length,
        responseLimit
      );
      if (typeof window.rememberSearchQuery === 'function') window.rememberSearchQuery(query);
      renderTypedSearch();
    } catch (error) {
      if (token !== typedSearch.token) return;
      var results = byId('search-results');
      if (append && typedSearch.items.length) {
        renderTypedSearch();
        if (results) {
          results.insertAdjacentHTML('beforeend', typedStateMarkup('加载失败', errorText(error), true));
        }
      } else if (results) {
        results.innerHTML = typedStateMarkup('搜索失败', errorText(error), true);
        results.classList.add('show');
      }
    } finally {
      if (token === typedSearch.token) typedSearch.loading = false;
    }
  }

  function openTypedEntity(index) {
    var item = typedSearch.items[index];
    if (!item) return;
    if (typedSearch.type === 'artist') {
      if (typeof window.openArtistDetailForSong === 'function') {
        window.openArtistDetailForSong({
          id: 'artist:' + String(item.id || ''),
          artistId: item.id,
          artist: item.name || '',
          artists: [{ id: item.id, name: item.name || '' }],
          provider: 'netease',
          source: 'netease',
          cover: coverOf(item),
        });
      }
    } else if (typedSearch.type === 'album') {
      if (typeof window.openAlbumDetail === 'function') window.openAlbumDetail(item);
    } else if (typedSearch.type === 'playlist') {
      openNeteasePlaylistDetail(item);
    }
    var results = byId('search-results');
    if (results) results.classList.remove('show');
  }

  async function playAllNeteaseSearchResults() {
    if (searchPlayAllBusy) return;
    var state = window.__mineradioV140Search || {};
    var query = String(state.query || (byId('search-input') && byId('search-input').value) || '').trim();
    if (!query || !window.playlist || !window.playlist.length) return legacy.playAllSearchResults();
    var expectedTotal = Math.max(finite(state.neteaseTotal, 0), finite(state.total, 0));
    var shouldContinue = state.neteaseHasMore !== false || state.hasMore || expectedTotal > window.playlist.length;
    if (!shouldContinue) return legacy.playAllSearchResults();

    searchPlayAllBusy = true;
    var operationToken = ++searchPlayAllToken;
    var initial = window.playlist.slice();
    var startOffset = Math.max(0, finite(state.neteaseOffset, initial.length));
    var expectedMode = currentMode();
    function throwIfPlayAllCancelled() {
      var activeQuery = String((byId('search-input') && byId('search-input').value) || '').trim();
      if (operationToken === searchPlayAllToken && currentMode() === expectedMode && typedSearch.type === 'song' && activeQuery === query) return;
      var cancelled = new Error('SEARCH_PLAY_ALL_CANCELLED');
      cancelled.cancelled = true;
      throw cancelled;
    }
    showOperation('正在获取全部搜索结果 ' + initial.length + (expectedTotal ? '/' + expectedTotal : ''), 'busy');
    try {
      var result = await experience.collectPaged(function (page) {
        throwIfPlayAllCancelled();
        return window.apiJson(
          '/api/search?keywords=' + encodeURIComponent(query) +
          '&limit=' + page.limit +
          '&offset=' + page.offset
        ).then(function (payload) {
          var payloadError = apiError(payload, '搜索结果加载失败');
          if (payloadError) throw payloadError;
          return payload;
        });
      }, {
        initialItems: initial,
        offset: startOffset,
        total: expectedTotal,
        hasMore: true,
        limit: 100,
        maxItems: 5000,
        maxPages: 80,
        keys: ['songs'],
        key: itemKey,
        onPage: function (progress) {
          throwIfPlayAllCancelled();
          showOperation(
            '正在获取全部搜索结果 ' + progress.items.length +
            (progress.total ? '/' + progress.total : ''),
            'busy'
          );
        },
      });
      throwIfPlayAllCancelled();
      window.playlist = result.items.map(clone);
      state.neteaseOffset = result.nextOffset;
      state.neteaseHasMore = !result.complete;
      state.hasMore = !result.complete;
      state.neteaseTotal = result.total;
      state.total = result.total;
      if (result.truncated) {
        showOperation('结果过多，已载入前 ' + result.items.length + ' 首', 'error');
      } else {
        showOperation('已获取全部 ' + result.items.length + ' 首，正在播放', 'done');
      }
      legacy.playAllSearchResults();
      hideOperationSoon();
    } catch (error) {
      if (error && error.cancelled) {
        hideOperationSoon();
        return;
      }
      try {
        throwIfPlayAllCancelled();
      } catch (cancelledError) {
        hideOperationSoon();
        return;
      }
      var partial = error && error.partialResult && error.partialResult.items || initial;
      window.playlist = partial.map(clone);
      showOperation('全部结果加载失败，已播放获取到的 ' + partial.length + ' 首', 'error');
      if (partial.length) legacy.playAllSearchResults();
      else if (typeof window.showToast === 'function') window.showToast(errorText(error, '搜索结果加载失败'));
    } finally {
      searchPlayAllBusy = false;
    }
  }

  function discoverSection(section) {
    return DISCOVER_SECTIONS.find(function (entry) { return entry.id === section; }) || DISCOVER_SECTIONS[0];
  }

  function discoverItems(payload, section) {
    var kind = discoverSection(section).kind;
    if (kind === 'song') return experience.pageItems(payload, ['songs', 'tracks', 'items', 'recent', 'cloud']);
    if (kind === 'album') return experience.pageItems(payload, ['albums', 'items', 'results']);
    if (kind === 'artist') return experience.pageItems(payload, ['artists', 'items', 'results']);
    return experience.pageItems(payload, ['playlists', 'toplists', 'items', 'results']);
  }

  function flattenCategories(payload) {
    var input = payload && (payload.categories || payload.items || payload.sub || payload.all) || [];
    var output = [];
    function add(value) {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      if (typeof value === 'object' && !value.name && !value.label) {
        Object.keys(value).forEach(function (key) { add(value[key]); });
        return;
      }
      var name = typeof value === 'string' ? value : (value.name || value.label);
      if (name && output.indexOf(name) < 0) output.push(name);
    }
    add(input);
    if (output.indexOf('全部') < 0) output.unshift('全部');
    return output.slice(0, 120);
  }

  function renderDiscoverTabs() {
    var tabs = byId('v150-discover-tabs');
    if (!tabs) return;
    tabs.hidden = discoverState.mode !== 'list';
    tabs.innerHTML = DISCOVER_SECTIONS.map(function (section) {
      var active = section.id === discoverState.section;
      return '<button type="button" role="tab" data-v150-section="' + section.id + '" class="' +
        (active ? 'active' : '') + '" aria-selected="' + (active ? 'true' : 'false') + '">' +
        section.label + '</button>';
    }).join('');
  }

  function discoverStateMarkup(title, detail, action, actionLabel) {
    return '<div class="v150-state"><div class="v150-state-copy"><strong>' + html(title) + '</strong>' +
      (detail ? '<span>' + html(detail) + '</span>' : '') +
      (action ? '<button class="fx-mini-btn" type="button" data-v150-state-action="' + action + '">' + html(actionLabel || '重试') + '</button>' : '') +
      '</div></div>';
  }

  function browseCardMarkup(item, index, kind) {
    var cover = coverOf(item);
    var meta = kind === 'artist'
      ? [
          item.albumCount ? item.albumCount + ' 张专辑' : '',
          (item.songCount || item.musicCount) ? (item.songCount || item.musicCount) + ' 首歌曲' : '',
        ].filter(Boolean).join(' · ')
      : (kind === 'album'
      ? [artistName(item), formatDate(item.publishTime)].filter(Boolean).join(' · ')
      : [
          creatorName(item),
          item.trackCount ? item.trackCount + ' 首' : '',
          item.playCount ? formatCount(item.playCount) + ' 播放' : '',
        ].filter(Boolean).join(' · '));
    return '<button class="v150-browse-card ' + kind + '" type="button" data-v150-browse-index="' + index + '">' +
      (cover
        ? '<img class="v150-browse-cover" src="' + html(cover) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=.2">'
        : '<span class="v150-browse-cover"></span>') +
      '<span class="v150-browse-name">' + html(item.name || item.title || '未命名') + '</span>' +
      '<span class="v150-browse-meta">' + html(meta || '网易云音乐') + '</span></button>';
  }

  function songRowsMarkup(items, prefix) {
    return '<div class="v150-song-list" role="list">' + items.map(function (song, index) {
      var cover = coverOf(song);
      return '<div class="v150-song-row" role="listitem">' +
        '<span class="v150-song-index">' + String(index + 1).padStart(2, '0') + '</span>' +
        (cover
          ? '<img class="v150-song-cover" src="' + html(cover) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=.2">'
          : '<span class="v150-song-cover"></span>') +
        '<button class="v150-song-main" type="button" data-v150-song-index="' + index + '" data-v150-song-source="' + prefix + '">' +
          '<span class="v150-song-name">' + html(song.name || song.title || '未知歌曲') + '</span>' +
          '<span class="v150-song-artist">' + html(artistName(song) || '未知歌手') + '</span></button>' +
        '<span class="v150-song-album">' + html(song.album || song.albumName || '') + '</span>' +
        '<button class="v150-row-add" type="button" data-v150-song-add="' + index + '" data-v150-song-source="' + prefix + '" aria-label="设为下一首">+</button>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderDiscoverList() {
    var body = byId('v150-discover-body');
    var title = byId('v150-discover-title');
    var back = byId('v150-discover-back');
    if (!body) return;
    discoverState.mode = 'list';
    if (title) title.textContent = '发现';
    if (back) back.hidden = true;
    renderDiscoverTabs();
    var section = discoverSection(discoverState.section);
    if (discoverState.loading && !discoverState.items.length) {
      body.innerHTML = discoverStateMarkup('正在载入' + section.label, '正在连接网易云', '', '');
      return;
    }
    if (section.auth && !isNeteaseLoggedIn()) {
      body.innerHTML = discoverStateMarkup(
        '登录后查看' + section.label,
        '当前网易云账号尚未登录或登录状态已失效',
        'login',
        '登录网易云'
      );
      return;
    }
    if (!discoverState.items.length) {
      body.innerHTML = discoverStateMarkup('暂无' + section.label + '内容', '稍后再试', 'retry', '重新加载');
      return;
    }
    var categorySelect = '';
    if (discoverState.section === 'playlists') {
      categorySelect =
        '<select class="v150-category-select" id="v150-category-select" aria-label="歌单分类">' +
        discoverState.categories.map(function (category) {
          return '<option value="' + html(category) + '"' + (category === discoverState.cat ? ' selected' : '') + '>' + html(category) + '</option>';
        }).join('') + '</select>';
    }
    var content = section.kind === 'song'
      ? songRowsMarkup(discoverState.items, 'discover')
      : '<div class="v150-browse-grid" role="list">' + discoverState.items.map(function (item, index) {
          return browseCardMarkup(item, index, section.kind);
        }).join('') + '</div>';
    body.innerHTML =
      '<div class="v150-discover-subhead"><strong>' + html(section.label) + '</strong>' +
        '<span class="v150-entity-meta">' + discoverState.items.length +
        (discoverState.total > discoverState.items.length ? '/' + discoverState.total : '') + '</span>' +
        categorySelect + '</div>' +
      content +
      (discoverState.hasMore
        ? '<button class="fx-mini-btn ghost v150-load-more" type="button" data-v150-discover-more="1">加载更多</button>'
        : '');
  }

  async function ensurePlaylistCategories() {
    if (discoverState.categoriesLoaded) return;
    try {
      var payload = await window.apiJson('/api/discover/netease?section=playlist-categories&limit=200&offset=0');
      var payloadError = apiError(payload, '歌单分类加载失败');
      if (payloadError) throw payloadError;
      discoverState.categories = flattenCategories(payload);
    } catch (_) {
      discoverState.categories = ['全部'];
    }
    discoverState.categoriesLoaded = true;
  }

  async function loadDiscoverSection(sectionId, append) {
    var section = discoverSection(sectionId);
    if (!append || discoverState.section !== section.id) {
      discoverState.token += 1;
      discoverState.loading = false;
      discoverState.section = section.id;
      discoverState.items = [];
      discoverState.offset = 0;
      discoverState.total = 0;
      discoverState.hasMore = false;
    }
    discoverState.mode = 'list';
    renderDiscoverTabs();
    if (section.auth && !isNeteaseLoggedIn()) {
      discoverState.loading = false;
      renderDiscoverList();
      return;
    }
    if (section.id === 'playlists') await ensurePlaylistCategories();
    if (discoverState.loading) return;
    discoverState.loading = true;
    var token = ++discoverState.token;
    renderDiscoverList();
    try {
      var limit = section.kind === 'song' ? 50 : 30;
      var url = '/api/discover/netease?section=' + encodeURIComponent(section.id) +
        '&limit=' + limit +
        '&offset=' + discoverState.offset;
      if (section.id === 'playlists') url += '&cat=' + encodeURIComponent(discoverState.cat || '全部');
      var payload = await window.apiJson(url);
      var payloadError = apiError(payload, section.label + '加载失败');
      if (payloadError) throw payloadError;
      if (token !== discoverState.token || discoverState.section !== section.id) return;
      var incoming = discoverItems(payload, section.id);
      var responseLimit = Math.max(1, finite(payload.limit, limit));
      var responseOffset = Math.max(0, finite(payload.offset, discoverState.offset));
      discoverState.items = experience.mergeUnique(append ? discoverState.items : [], incoming, function (item) {
        return section.kind + ':' + experience.itemIdentity(item);
      });
      discoverState.total = experience.pageTotal(payload, discoverState.items.length);
      discoverState.offset = finite(payload.nextOffset, responseOffset + (incoming.length < responseLimit ? incoming.length : responseLimit));
      discoverState.hasMore = experience.pageHasMore(
        payload,
        discoverState.offset,
        discoverState.total,
        incoming.length,
        responseLimit
      );
      renderDiscoverList();
    } catch (error) {
      if (token !== discoverState.token) return;
      var invalidated = invalidateNeteaseSession(error);
      var body = byId('v150-discover-body');
      if (body) {
        var authFailure = invalidated || isNeteaseAuthFailure(error);
        body.innerHTML = discoverStateMarkup(
          authFailure ? '网易云登录状态已失效' : section.label + '加载失败',
          errorText(error),
          authFailure ? 'login' : 'retry',
          authFailure ? '重新登录' : '重试'
        );
      }
    } finally {
      if (token === discoverState.token) discoverState.loading = false;
    }
  }

  function openNeteaseDiscover(section) {
    var mask = ensureDiscoverModal();
    if (!mask.classList.contains('show')) window.openGsapModal(mask);
    loadDiscoverSection(section || discoverState.section, false);
  }
  window.openNeteaseDiscover = openNeteaseDiscover;

  function closeNeteaseDiscover() {
    discoverState.token += 1;
    discoverState.loading = false;
    discoverPlaylist.token += 1;
    discoverPlaylist.loading = false;
    legacy.closeGsapModal(byId('v150-discover-modal'));
  }
  window.closeNeteaseDiscover = closeNeteaseDiscover;

  function openBrowseItem(index) {
    var item = discoverState.items[index];
    if (!item) return;
    var kind = discoverSection(discoverState.section).kind;
    if (kind === 'album') {
      closeNeteaseDiscover();
      if (typeof window.openAlbumDetail === 'function') {
        setTimeout(function () { window.openAlbumDetail(item); }, 170);
      }
    } else if (kind === 'artist') {
      closeNeteaseDiscover();
      if (typeof window.openArtistDetailForSong === 'function') {
        setTimeout(function () {
          window.openArtistDetailForSong({
            id: 'artist:' + String(item.id || ''),
            artistId: item.id,
            artist: item.name || '',
            artists: [{ id: item.id, name: item.name || '' }],
            provider: 'netease',
            source: 'netease',
            cover: coverOf(item),
          });
        }, 170);
      }
    } else if (kind === 'playlist') {
      openNeteasePlaylistDetail(item);
    }
  }

  function sourceSongs(source) {
    return source === 'playlist' ? discoverPlaylist.tracks : discoverState.items;
  }

  function playDiscoverSong(index, source) {
    var songs = sourceSongs(source);
    if (!songs[index]) return;
    window.playQueue = songs.map(clone);
    window.currentIdx = index;
    closeNeteaseDiscover();
    if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('netease-discover');
    if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('netease-discover', true);
    if (typeof window.forcePlaybackControlsInteractive === 'function') window.forcePlaybackControlsInteractive();
    Promise.resolve(window.playQueueAt(index)).catch(function (error) {
      console.warn('[V150DiscoverPlay]', error);
      if (typeof window.showToast === 'function') window.showToast('播放启动失败');
    });
  }

  function queueDiscoverSong(index, source) {
    var song = sourceSongs(source)[index];
    if (!song) return;
    if (typeof window.queueSongNext === 'function') window.queueSongNext(clone(song));
    if (typeof window.showToast === 'function') window.showToast('已设为下一首: ' + (song.name || '歌曲'));
  }

  async function fetchCompletePlaylist(pid, options) {
    options = options || {};
    var total = Math.max(0, finite(options.total, 0));
    var playlistInfo = options.playlist || null;
    var result = await experience.collectPaged(function (page) {
      return window.apiJson(
        '/api/playlist/tracks?id=' + encodeURIComponent(pid) +
        '&limit=' + page.limit +
        '&offset=' + page.offset
      ).then(function (payload) {
        var payloadError = apiError(payload, '歌单加载失败');
        if (payloadError) throw payloadError;
        if (payload.playlist) {
          playlistInfo = Object.assign({}, playlistInfo || {}, payload.playlist);
        }
        return payload;
      });
    }, {
      limit: 500,
      maxItems: 10000,
      maxPages: 80,
      total: total,
      hasMore: true,
      keys: ['tracks'],
      key: itemKey,
      onPage: function (progress) {
        if (typeof options.onPage === 'function') {
          return options.onPage(progress, playlistInfo);
        }
      },
    });
    result.playlist = playlistInfo;
    return result;
  }

  function isOwnedPlaylist(item, pid) {
    item = item || {};
    pid = String(pid || item.id || '');
    var accountId = window.loginStatus && (window.loginStatus.userId || window.loginStatus.accountId);
    var creator = item.creator || {};
    var creatorId = item.creatorId || creator.userId || creator.id;
    if (accountId && creatorId) return String(accountId) === String(creatorId);
    var cached = (window.userPlaylists || []).find(function (playlist) {
      return playlist && playlist.provider !== 'qq' && String(playlist.id) === pid;
    });
    return !!(cached && !cached.subscribed && finite(cached.specialType, 0) === 0);
  }

  function playlistActionMarkup(item) {
    item = item || {};
    var pid = String(item.id || '');
    var owner = isOwnedPlaylist(item, pid);
    var special = finite(item.specialType, 0) !== 0;
    if (owner && !special) {
      return '<button class="fx-mini-btn ghost" type="button" data-v150-edit-playlist="' + html(pid) + '">编辑信息</button>';
    }
    if (owner || special || finite(item.privacy, 0) === 10) return '';
    return '<button class="fx-mini-btn ghost" type="button" data-v150-subscribe-playlist="' + html(pid) + '">' +
      (item.subscribed ? '取消收藏' : '收藏歌单') + '</button>';
  }

  function renderDiscoverPlaylistDetail() {
    var body = byId('v150-discover-body');
    var title = byId('v150-discover-title');
    var back = byId('v150-discover-back');
    var tabs = byId('v150-discover-tabs');
    if (!body) return;
    discoverState.mode = 'detail';
    var item = discoverPlaylist.playlist || {};
    if (title) title.textContent = '歌单详情';
    if (back) back.hidden = false;
    if (tabs) tabs.hidden = true;
    var cover = coverOf(item);
    var loaded = discoverPlaylist.tracks.length;
    var progress = discoverPlaylist.loading
      ? '<div class="v150-inline-progress" role="status">正在载入完整歌单 ' + loaded +
        (discoverPlaylist.total ? '/' + discoverPlaylist.total : '') + '</div>'
      : (discoverPlaylist.failed
        ? '<div class="v150-inline-progress" role="status">后续歌曲加载失败，当前保留 ' + loaded + ' 首</div>'
        : '');
    var visibleTracks = discoverPlaylist.tracks.slice(0, discoverPlaylist.visible);
    var actions =
      '<div class="v150-playlist-actions">' +
        '<button class="modal-btn primary" type="button" data-v150-play-detail="1"' + (!loaded || discoverPlaylist.loading ? ' disabled' : '') + '>播放全部</button>' +
        '<button class="modal-btn" type="button" data-v150-queue-detail="1"' + (!loaded || discoverPlaylist.loading ? ' disabled' : '') + '>加入队列</button>' +
        playlistActionMarkup(item) +
      '</div>';
    body.innerHTML =
      '<section class="v150-playlist-hero">' +
        (cover
          ? '<img class="v150-playlist-cover" src="' + html(cover) + '" alt="" onerror="this.style.opacity=.2">'
          : '<span class="v150-playlist-cover"></span>') +
        '<div class="v150-playlist-copy"><div class="v150-playlist-title">' + html(item.name || '歌单') + '</div>' +
          '<div class="v150-playlist-meta">' + html([
            creatorName(item),
            (discoverPlaylist.total || item.trackCount || loaded) + ' 首',
            item.playCount ? formatCount(item.playCount) + ' 次播放' : '',
          ].filter(Boolean).join(' · ')) + '</div>' +
          (item.description ? '<div class="v150-playlist-description">' + html(item.description) + '</div>' : '') +
          actions +
        '</div>' +
      '</section>' +
      progress +
      (visibleTracks.length
        ? songRowsMarkup(visibleTracks, 'playlist')
        : discoverStateMarkup(discoverPlaylist.loading ? '正在载入歌单' : '歌单暂无歌曲', '', '', '')) +
      (discoverPlaylist.tracks.length > discoverPlaylist.visible
        ? '<button class="fx-mini-btn ghost v150-load-more" type="button" data-v150-show-more-tracks="1">显示更多 ' +
          discoverPlaylist.visible + '/' + discoverPlaylist.tracks.length + '</button>'
        : '');
  }

  async function openNeteasePlaylistDetail(itemOrId) {
    var item = itemOrId && typeof itemOrId === 'object'
      ? Object.assign({}, itemOrId)
      : { id: itemOrId, name: '歌单详情' };
    if (!item.id) {
      if (typeof window.showToast === 'function') window.showToast('未找到歌单信息');
      return;
    }
    var mask = ensureDiscoverModal();
    if (!mask.classList.contains('show')) window.openGsapModal(mask);
    var token = ++discoverPlaylist.token;
    discoverPlaylist.playlist = item;
    discoverPlaylist.tracks = [];
    discoverPlaylist.loading = true;
    discoverPlaylist.complete = false;
    discoverPlaylist.failed = false;
    discoverPlaylist.total = finite(item.trackCount, 0);
    discoverPlaylist.visible = 120;
    renderDiscoverPlaylistDetail();
    try {
      var result = await fetchCompletePlaylist(item.id, {
        total: discoverPlaylist.total,
        playlist: item,
        onPage: function (progress, playlistInfo) {
          if (token !== discoverPlaylist.token) {
            var cancelled = new Error('PLAYLIST_DETAIL_CANCELLED');
            cancelled.cancelled = true;
            throw cancelled;
          }
          discoverPlaylist.playlist = Object.assign({}, discoverPlaylist.playlist, playlistInfo || {});
          discoverPlaylist.tracks = progress.items.map(clone);
          discoverPlaylist.total = progress.total || discoverPlaylist.total;
          renderDiscoverPlaylistDetail();
        },
      });
      if (token !== discoverPlaylist.token) return;
      discoverPlaylist.playlist = Object.assign({}, discoverPlaylist.playlist, result.playlist || {});
      discoverPlaylist.tracks = result.items.map(clone);
      discoverPlaylist.total = result.total;
      discoverPlaylist.complete = result.complete;
      discoverPlaylist.loading = false;
      discoverPlaylist.failed = false;
      renderDiscoverPlaylistDetail();
      if (result.truncated && typeof window.showToast === 'function') {
        window.showToast('歌单过大，已载入前 ' + result.items.length + ' 首');
      }
    } catch (error) {
      if (token !== discoverPlaylist.token) return;
      if (error && error.cancelled) return;
      var partial = error && error.partialResult && error.partialResult.items || discoverPlaylist.tracks;
      discoverPlaylist.tracks = partial.map(clone);
      discoverPlaylist.loading = false;
      discoverPlaylist.failed = true;
      renderDiscoverPlaylistDetail();
      if (typeof window.showToast === 'function') {
        window.showToast(partial.length
          ? '歌单未完整载入，已保留 ' + partial.length + ' 首'
          : errorText(error, '歌单加载失败'));
      }
    }
  }
  window.openNeteasePlaylistDetail = openNeteasePlaylistDetail;

  function playDiscoverPlaylist() {
    if (!discoverPlaylist.tracks.length || discoverPlaylist.loading) return;
    window.playQueue = discoverPlaylist.tracks.map(clone);
    window.currentIdx = 0;
    closeNeteaseDiscover();
    if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('discover-playlist');
    if (typeof window.safeSwitchPlaylistTab === 'function') window.safeSwitchPlaylistTab('queue', 'discover-playlist');
    if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('discover-playlist', true);
    if (typeof window.forcePlaybackControlsInteractive === 'function') window.forcePlaybackControlsInteractive();
    Promise.resolve(window.playQueueAt(0)).catch(function (error) {
      console.warn('[V150PlaylistPlay]', error);
      if (typeof window.showToast === 'function') window.showToast('歌单已载入，播放启动失败');
    });
  }

  function addDiscoverPlaylistToQueue() {
    if (!discoverPlaylist.tracks.length || discoverPlaylist.loading) return;
    var known = Object.create(null);
    (window.playQueue || []).forEach(function (song) {
      var key = itemKey(song);
      if (key) known[key] = true;
    });
    var added = 0;
    discoverPlaylist.tracks.forEach(function (song) {
      var key = itemKey(song);
      if (key && known[key]) return;
      window.playQueue.push(clone(song));
      if (key) known[key] = true;
      added += 1;
    });
    if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('discover-playlist-add');
    if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('discover-playlist-add', true);
    if (typeof window.showToast === 'function') window.showToast(added ? '已加入 ' + added + ' 首歌曲' : '歌单歌曲已在队列中');
  }

  function openMetadataEdit(item, pid) {
    item = item || {};
    metadataEditState.playlist = item;
    metadataEditState.pid = String(pid || item.id || '');
    if (!metadataEditState.pid) return;
    byId('v150-meta-name').value = item.name || '';
    byId('v150-meta-description').value = item.description || '';
    var tags = item.tags || item.tag || [];
    byId('v150-meta-tags').value = Array.isArray(tags) ? tags.join(', ') : String(tags || '');
    var currentPrivacy = finite(item.privacy, 0) === 10 ? 10 : 0;
    var privacySelect = byId('v150-meta-privacy');
    var privateOption = privacySelect && privacySelect.querySelector('option[value="10"]');
    if (privateOption) privateOption.disabled = currentPrivacy !== 10;
    if (privacySelect) privacySelect.value = String(currentPrivacy);
    window.openGsapModal(ensureMetadataModal());
  }

  async function submitMetadataEdit(event) {
    event.preventDefault();
    var pid = metadataEditState.pid;
    var item = metadataEditState.playlist || {};
    if (!pid) return;
    var name = byId('v150-meta-name').value.trim();
    var description = byId('v150-meta-description').value.trim();
    var tags = byId('v150-meta-tags').value.split(/[,，]/).map(function (tag) { return tag.trim(); }).filter(Boolean).slice(0, 3);
    var privacy = finite(byId('v150-meta-privacy').value, 0) === 10 ? 10 : 0;
    var submit = byId('v150-meta-submit');
    submit.disabled = true;
    submit.textContent = '正在保存';
    try {
      var payload = await postJson('/api/playlist/update-meta', {
        pid: pid,
        name: name,
        description: description,
        tags: tags,
        privacy: privacy,
      });
      var payloadError = apiError(payload, '歌单信息保存失败');
      if (payloadError) throw payloadError;
      item.name = name;
      item.description = description;
      item.tags = tags;
      item.privacy = privacy;
      (window.userPlaylists || []).forEach(function (playlist) {
        if (playlist && playlist.provider !== 'qq' && String(playlist.id) === pid) {
          playlist.name = name;
          playlist.description = description;
          playlist.tags = tags;
          playlist.privacy = privacy;
        }
      });
      if (window.playlistPanelDetailState && window.playlistPanelDetailState.playlist &&
          String(window.playlistPanelDetailState.playlist.id) === pid) {
        Object.assign(window.playlistPanelDetailState.playlist, item);
      }
      if (discoverPlaylist.playlist && String(discoverPlaylist.playlist.id) === pid) {
        Object.assign(discoverPlaylist.playlist, item);
        renderDiscoverPlaylistDetail();
      }
      if (typeof window.renderPlaylistPanelDetailState === 'function') window.renderPlaylistPanelDetailState();
      window.closeGsapModal(byId('v150-metadata-modal'));
      if (typeof window.showToast === 'function') window.showToast('歌单信息已更新');
    } catch (error) {
      invalidateNeteaseSession(error);
      if (typeof window.showToast === 'function') window.showToast(errorText(error, '歌单信息保存失败'));
    } finally {
      submit.disabled = false;
      submit.textContent = '保存';
    }
  }

  async function togglePlaylistSubscription(item, pid, button) {
    item = item || {};
    pid = String(pid || item.id || '');
    if (!pid) return;
    if (!isNeteaseLoggedIn()) {
      if (typeof window.openProviderLogin === 'function') window.openProviderLogin('netease');
      return;
    }
    var subscribe = !item.subscribed;
    if (button) button.disabled = true;
    try {
      var payload = await postJson('/api/playlist/subscribe', { pid: pid, subscribe: subscribe });
      var payloadError = apiError(payload, subscribe ? '收藏歌单失败' : '取消收藏失败');
      if (payloadError) throw payloadError;
      item.subscribed = subscribe;
      if (discoverPlaylist.playlist && String(discoverPlaylist.playlist.id) === pid) {
        discoverPlaylist.playlist.subscribed = subscribe;
        renderDiscoverPlaylistDetail();
      }
      if (typeof window.showToast === 'function') window.showToast(subscribe ? '歌单已收藏' : '已取消收藏');
      if (typeof window.refreshUserPlaylists === 'function') {
        Promise.resolve(window.refreshUserPlaylists(true)).catch(function () {});
      }
    } catch (error) {
      invalidateNeteaseSession(error);
      if (typeof window.showToast === 'function') window.showToast(errorText(error, subscribe ? '收藏歌单失败' : '取消收藏失败'));
    } finally {
      if (button && button.isConnected) button.disabled = false;
    }
  }

  function decoratePanelPlaylistDetail() {
    var state = window.playlistPanelDetailState;
    var list = byId('pl-list');
    var detail = list && list.querySelector('.pl-inline-detail');
    if (!state || !state.key || state.key.indexOf('netease:') !== 0 || !state.playlist || !detail) return;
    var pid = state.key.slice('netease:'.length);
    var actions = detail.querySelector('.pl-detail-actions');
    if (!actions) return;
    var tools = actions.querySelector('.v150-owner-tools');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'v150-owner-tools';
      actions.appendChild(tools);
    }
    var owner = isOwnedPlaylist(state.playlist, pid);
    var special = finite(state.playlist.specialType, 0) !== 0;
    if (owner && !special) {
      tools.innerHTML = '<button class="pl-owner-action" type="button" data-v150-panel-action="edit">编辑信息</button>';
    } else if (!owner && !special && finite(state.playlist.privacy, 0) !== 10) {
      tools.innerHTML = '<button class="pl-owner-action" type="button" data-v150-panel-action="subscribe">' +
        (state.playlist.subscribed ? '取消收藏' : '收藏歌单') + '</button>';
    } else {
      tools.remove();
    }
    var existingProgress = detail.querySelector('.v150-inline-progress');
    if (state.v150LoadingMore) {
      var text = '正在载入完整歌单 ' + state.tracks.length + (state.v150Total ? '/' + state.v150Total : '');
      if (!existingProgress) {
        existingProgress = document.createElement('div');
        existingProgress.className = 'v150-inline-progress';
        existingProgress.setAttribute('role', 'status');
        var sticky = detail.querySelector('.pl-detail-sticky');
        if (sticky) sticky.insertAdjacentElement('afterend', existingProgress);
      }
      existingProgress.textContent = text;
      all('[data-v140-pl-action],[data-v140-pl-remove],.pl-track-manage', detail).forEach(function (control) {
        control.disabled = true;
        control.title = '完整歌单载入后可管理';
      });
      all('.pl-detail-row[draggable=true]', detail).forEach(function (row) {
        row.draggable = false;
      });
    } else if (existingProgress) {
      existingProgress.remove();
    }
  }

  async function openCompletePlaylistPanelDetail(provider, pid, title) {
    if (provider === 'qq') return legacy.openPlaylistPanelDetail(provider, pid, title);
    if (!pid) return;
    var key = 'netease:' + String(pid);
    var state = window.playlistPanelDetailState;
    if (state && state.key === key) {
      if (typeof window.collapsePlaylistPanelDetail === 'function') {
        window.collapsePlaylistPanelDetail();
        return;
      }
      return legacy.openPlaylistPanelDetail(provider, pid, title);
    }
    var playlist = (window.userPlaylists || []).find(function (item) {
      return item && item.provider !== 'qq' && String(item.id) === String(pid);
    }) || { id: pid, provider: 'netease', name: title || '歌单详情' };
    var token = state ? state.token + 1 : 1;
    window.playlistPanelDetailState = {
      key: key,
      loading: true,
      playlist: playlist,
      tracks: [],
      token: token,
      renderLimit: window.PLAYLIST_DETAIL_INITIAL_RENDER || 80,
      v150LoadingMore: true,
      v150Total: finite(playlist.trackCount, 0),
    };
    if (typeof window.renderPlaylistPanelDetailState === 'function') window.renderPlaylistPanelDetailState();
    if (typeof window.scrollPlaylistPanelDetailIntoView === 'function') window.scrollPlaylistPanelDetailIntoView(key);
    try {
      var result = await fetchCompletePlaylist(pid, {
        total: playlist.trackCount,
        playlist: playlist,
        onPage: function (progress, playlistInfo) {
          var current = window.playlistPanelDetailState;
          if (!current || current.token !== token || current.key !== key) {
            var cancelled = new Error('PLAYLIST_PANEL_CANCELLED');
            cancelled.cancelled = true;
            throw cancelled;
          }
          current.loading = false;
          current.v150LoadingMore = progress.hasMore;
          current.v150Total = progress.total;
          current.playlist = Object.assign({}, current.playlist, playlistInfo || {});
          current.tracks = progress.items.map(clone);
          current.renderLimit = Math.min(
            current.tracks.length,
            Math.max(window.PLAYLIST_DETAIL_INITIAL_RENDER || 80, current.renderLimit || 0)
          );
          if (typeof window.renderPlaylistPanelDetailState === 'function') window.renderPlaylistPanelDetailState();
        },
      });
      var current = window.playlistPanelDetailState;
      if (!current || current.token !== token || current.key !== key) return;
      current.loading = false;
      current.v150LoadingMore = false;
      current.v150Total = result.total;
      current.playlist = Object.assign({}, current.playlist, result.playlist || {});
      current.tracks = result.items.map(clone);
      current.renderLimit = Math.min(
        current.tracks.length,
        Math.max(window.PLAYLIST_DETAIL_INITIAL_RENDER || 80, current.renderLimit || 0)
      );
      if (typeof window.renderPlaylistPanelDetailState === 'function') window.renderPlaylistPanelDetailState();
      if (result.truncated && typeof window.showToast === 'function') {
        window.showToast('歌单过大，已载入前 ' + result.items.length + ' 首');
      }
    } catch (error) {
      var currentState = window.playlistPanelDetailState;
      if (!currentState || currentState.token !== token || currentState.key !== key) return;
      if (error && error.cancelled) return;
      invalidateNeteaseSession(error);
      var partial = error && error.partialResult && error.partialResult.items || currentState.tracks;
      currentState.loading = false;
      currentState.v150LoadingMore = false;
      currentState.tracks = partial.map(clone);
      if (typeof window.renderPlaylistPanelDetailState === 'function') window.renderPlaylistPanelDetailState();
      if (typeof window.showToast === 'function') {
        window.showToast(partial.length ? '歌单未完整载入，已保留 ' + partial.length + ' 首' : errorText(error, '歌单详情加载失败'));
      }
    }
  }

  async function loadCompletePlaylistIntoQueue(id, autoplay, title) {
    if (String(id || '').indexOf('qq:') === 0) return legacy.loadPlaylistIntoQueueById(id, autoplay, title);
    if (!id || playlistQueueBusy) return;
    playlistQueueBusy = true;
    if (typeof window.showLoading === 'function') window.showLoading();
    showOperation('正在载入完整歌单', 'busy');
    try {
      var result = await fetchCompletePlaylist(id, {
        onPage: function (progress) {
          showOperation(
            '正在载入完整歌单 ' + progress.items.length + (progress.total ? '/' + progress.total : ''),
            'busy'
          );
        },
      });
      if (!result.items.length) {
        if (typeof window.showToast === 'function') window.showToast('歌单为空');
        return;
      }
      window.playQueue = result.items.map(clone);
      if (typeof window.isLikedPlaylistContext === 'function' &&
          window.isLikedPlaylistContext(id, title, result.playlist) &&
          typeof window.markSongsLiked === 'function') {
        window.markSongsLiked(window.playQueue, true);
      }
      if (typeof window.syncLikeStatusForSongs === 'function') window.syncLikeStatusForSongs(window.playQueue);
      window.currentIdx = 0;
      if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('playlist-load-complete');
      if (typeof window.safeSwitchPlaylistTab === 'function') window.safeSwitchPlaylistTab('queue', 'playlist-load-complete');
      if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('playlist-load-complete', true);
      if (typeof window.forcePlaybackControlsInteractive === 'function') window.forcePlaybackControlsInteractive();
      showOperation('已载入完整歌单，共 ' + result.items.length + ' 首', result.truncated ? 'error' : 'done');
      if (autoplay) {
        try {
          await window.playQueueAt(0);
        } catch (playError) {
          console.warn('[V150PlaylistAutoplay]', playError);
          if (typeof window.showToast === 'function') window.showToast('歌单已载入，播放启动失败');
        }
      }
      hideOperationSoon();
    } catch (error) {
      invalidateNeteaseSession(error);
      var partial = error && error.partialResult && error.partialResult.items || [];
      if (partial.length) {
        window.playQueue = partial.map(clone);
        window.currentIdx = 0;
        if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('playlist-load-partial');
        if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('playlist-load-partial', true);
        showOperation('歌单加载中断，已保留 ' + partial.length + ' 首', 'error');
        if (autoplay) Promise.resolve(window.playQueueAt(0)).catch(function () {});
      } else {
        showOperation(errorText(error, '歌单加载失败'), 'error');
      }
    } finally {
      playlistQueueBusy = false;
      if (typeof window.hideLoading === 'function') window.hideLoading();
    }
  }

  async function refreshAllNeteasePlaylists(force) {
    if (!force && userPlaylistsComplete && isNeteaseLoggedIn()) {
      return legacy.refreshUserPlaylists(false);
    }
    var token = ++userPlaylistRefreshToken;
    await Promise.resolve(legacy.refreshUserPlaylists(force));
    if (token !== userPlaylistRefreshToken || !isNeteaseLoggedIn()) return;
    try {
      var result = await experience.collectPaged(function (page) {
        return window.apiJson('/api/user/playlists?limit=' + page.limit + '&offset=' + page.offset).then(function (payload) {
          var payloadError = apiError(payload, '歌单列表加载失败');
          if (payloadError) throw payloadError;
          return payload;
        });
      }, {
        limit: 100,
        maxItems: 2000,
        maxPages: 30,
        keys: ['playlists'],
        key: function (playlist) { return 'playlist:' + String(playlist && playlist.id || ''); },
      });
      if (token !== userPlaylistRefreshToken) return;
      var qq = (window.userPlaylists || []).filter(function (playlist) { return playlist && playlist.provider === 'qq'; });
      var netease = result.items.map(function (playlist) {
        playlist.provider = 'netease';
        playlist.source = 'netease';
        return playlist;
      });
      window.userPlaylists = netease.concat(qq);
      userPlaylistsComplete = result.complete && !result.truncated;
      if (typeof window.resetPlaylistPanelRenderLimit === 'function') window.resetPlaylistPanelRenderLimit();
      if (typeof window.renderUserPlaylistsList === 'function') window.renderUserPlaylistsList({ animate: false, reset: true });
      if (typeof window.scheduleShelfRebuild === 'function') window.scheduleShelfRebuild('v150-user-playlists', true);
    } catch (error) {
      userPlaylistsComplete = false;
      if (invalidateNeteaseSession(error)) renderPlaylistLoginRequired();
      console.warn('[V150UserPlaylists]', error);
    }
  }

  function bindEvents() {
    window.addEventListener('mineradio:netease-auth-expired', function (event) {
      userPlaylistsComplete = false;
      invalidateNeteaseSession({
        status: 401,
        code: 'LOGIN_EXPIRED',
        payload: event && event.detail || { authExpired: true, loggedIn: false },
      });
    });
    var typeRoot = byId('v150-search-types');
    if (typeRoot) {
      typeRoot.addEventListener('click', function (event) {
        var button = event.target && event.target.closest && event.target.closest('[data-v150-search-type]');
        if (button) setNeteaseSearchType(button.getAttribute('data-v150-search-type'));
      });
      typeRoot.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        var index = SEARCH_TYPES.indexOf(typedSearch.type);
        index += event.key === 'ArrowRight' ? 1 : -1;
        if (index < 0) index = SEARCH_TYPES.length - 1;
        if (index >= SEARCH_TYPES.length) index = 0;
        setNeteaseSearchType(SEARCH_TYPES[index]);
        var active = typeRoot.querySelector('[data-v150-search-type="' + SEARCH_TYPES[index] + '"]');
        if (active) active.focus();
      });
    }

    var results = byId('search-results');
    if (results) {
      results.addEventListener('click', function (event) {
        var entity = event.target && event.target.closest && event.target.closest('[data-v150-typed-index]');
        var more = event.target && event.target.closest && event.target.closest('[data-v150-load-more-typed]');
        var retry = event.target && event.target.closest && event.target.closest('[data-v150-retry-typed]');
        if (entity) openTypedEntity(finite(entity.getAttribute('data-v150-typed-index'), -1));
        else if (more) runTypedSearch(typedSearch.query, true);
        else if (retry) runTypedSearch(typedSearch.query, false);
      });
    }
    var searchInput = byId('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        if (searchInput.value.trim() || currentMode() !== 'netease' || typedSearch.type === 'song') return;
        resetTypedSearch(true);
        var panel = byId('search-results');
        if (panel) {
          panel.innerHTML = '';
          panel.classList.remove('show');
        }
      });
    }

    var sourceTabs = byId('search-mode-tabs');
    if (sourceTabs) {
      sourceTabs.addEventListener('click', function () {
        setTimeout(function () {
          if (currentMode() !== 'netease') searchPlayAllToken += 1;
          syncSearchTypeUi();
        }, 0);
      });
    }

    var discover = byId('v150-discover-modal');
    if (discover) {
      discover.addEventListener('click', function (event) {
        var target = event.target && event.target.closest ? event.target.closest(
          '[data-v150-section],[data-v150-browse-index],[data-v150-song-index],[data-v150-song-add],' +
          '[data-v150-discover-more],[data-v150-state-action],[data-v150-play-detail],' +
          '[data-v150-queue-detail],[data-v150-show-more-tracks],[data-v150-edit-playlist],' +
          '[data-v150-subscribe-playlist]'
        ) : null;
        if (!target) return;
        if (target.hasAttribute('data-v150-section')) {
          loadDiscoverSection(target.getAttribute('data-v150-section'), false);
        } else if (target.hasAttribute('data-v150-browse-index')) {
          openBrowseItem(finite(target.getAttribute('data-v150-browse-index'), -1));
        } else if (target.hasAttribute('data-v150-song-index')) {
          playDiscoverSong(
            finite(target.getAttribute('data-v150-song-index'), -1),
            target.getAttribute('data-v150-song-source')
          );
        } else if (target.hasAttribute('data-v150-song-add')) {
          queueDiscoverSong(
            finite(target.getAttribute('data-v150-song-add'), -1),
            target.getAttribute('data-v150-song-source')
          );
        } else if (target.hasAttribute('data-v150-discover-more')) {
          loadDiscoverSection(discoverState.section, true);
        } else if (target.hasAttribute('data-v150-state-action')) {
          var action = target.getAttribute('data-v150-state-action');
          if (action === 'login' && typeof window.openProviderLogin === 'function') window.openProviderLogin('netease');
          else loadDiscoverSection(discoverState.section, false);
        } else if (target.hasAttribute('data-v150-play-detail')) {
          playDiscoverPlaylist();
        } else if (target.hasAttribute('data-v150-queue-detail')) {
          addDiscoverPlaylistToQueue();
        } else if (target.hasAttribute('data-v150-show-more-tracks')) {
          discoverPlaylist.visible += 120;
          renderDiscoverPlaylistDetail();
        } else if (target.hasAttribute('data-v150-edit-playlist')) {
          openMetadataEdit(discoverPlaylist.playlist, target.getAttribute('data-v150-edit-playlist'));
        } else if (target.hasAttribute('data-v150-subscribe-playlist')) {
          togglePlaylistSubscription(
            discoverPlaylist.playlist,
            target.getAttribute('data-v150-subscribe-playlist'),
            target
          );
        }
      });
      discover.addEventListener('change', function (event) {
        if (event.target && event.target.id === 'v150-category-select') {
          discoverState.cat = event.target.value || '全部';
          loadDiscoverSection('playlists', false);
        }
      });
      var back = byId('v150-discover-back');
      if (back) {
        back.addEventListener('click', function () {
          discoverPlaylist.token += 1;
          discoverPlaylist.loading = false;
          renderDiscoverList();
        });
      }
    }

    var playlistList = byId('pl-list');
    if (playlistList) {
      playlistList.addEventListener('click', function (event) {
        var login = event.target && event.target.closest && event.target.closest('[data-v150-login]');
        if (login) {
          event.preventDefault();
          event.stopImmediatePropagation();
          userPlaylistsComplete = false;
          if (typeof window.openProviderLogin === 'function') window.openProviderLogin('netease');
          return;
        }
        var action = event.target && event.target.closest && event.target.closest('[data-v150-panel-action]');
        if (!action) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        var state = window.playlistPanelDetailState;
        if (!state || !state.playlist || state.key.indexOf('netease:') !== 0) return;
        var pid = state.key.slice('netease:'.length);
        if (action.getAttribute('data-v150-panel-action') === 'edit') {
          openMetadataEdit(state.playlist, pid);
        } else {
          togglePlaylistSubscription(state.playlist, pid, action);
        }
      }, true);
    }
  }

  function installOverrides() {
    window.clearSearchResults = function () {
      searchPlayAllToken += 1;
      resetTypedSearch(true);
      return legacy.clearSearchResults.apply(this, arguments);
    };
    window.updateSearchModeTabs = function () {
      var result = legacy.updateSearchModeTabs.apply(this, arguments);
      syncSearchTypeUi();
      return result;
    };
    window.doSearch = function (query, options) {
      searchPlayAllToken += 1;
      if (currentMode() === 'netease' && typedSearch.type !== 'song') {
        return runTypedSearch(query, false);
      }
      return legacy.doSearch(query, options);
    };
    window.loadMoreSearchResults = function () {
      if (currentMode() === 'netease' && typedSearch.type !== 'song') {
        return runTypedSearch(typedSearch.query, true);
      }
      return legacy.loadMoreSearchResults.apply(this, arguments);
    };
    window.retryV140Search = function () {
      if (currentMode() === 'netease' && typedSearch.type !== 'song') {
        return runTypedSearch(typedSearch.query || (byId('search-input') && byId('search-input').value), false);
      }
      return legacy.retrySearch.apply(this, arguments);
    };
    window.playAllSearchResults = function () {
      if (currentMode() === 'netease' && typedSearch.type === 'song') {
        return playAllNeteaseSearchResults();
      }
      return legacy.playAllSearchResults.apply(this, arguments);
    };
    window.openPlaylistPanelDetail = openCompletePlaylistPanelDetail;
    window.loadPlaylistIntoQueueById = loadCompletePlaylistIntoQueue;
    window.refreshUserPlaylists = refreshAllNeteasePlaylists;
    window.renderUserPlaylistsList = function () {
      var result = legacy.renderUserPlaylistsList.apply(this, arguments);
      requestAnimationFrame(decoratePanelPlaylistDetail);
      return result;
    };
    window.closeGsapModal = function (mask, afterClose) {
      if (mask && mask.id === 'v150-discover-modal') {
        discoverState.token += 1;
        discoverState.loading = false;
        discoverPlaylist.token += 1;
        discoverPlaylist.loading = false;
      }
      return legacy.closeGsapModal(mask, afterClose);
    };
  }

  installStyles();
  injectShell();
  bindEvents();
  installOverrides();
  syncSearchTypeUi();
  requestAnimationFrame(decoratePanelPlaylistDetail);
  window.__mineradioV150 = {
    discover: discoverState,
    playlist: discoverPlaylist,
    search: typedSearch,
    version: '1.5.3',
  };
})();
