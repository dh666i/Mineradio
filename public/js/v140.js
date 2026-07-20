(function () {
  'use strict';

  var core = window.MineradioCore || {};
  var queueCore = core.queueSession || null;
  var lyricCore = core.lyrics || null;
  var networkCore = core.networkErrors || null;
  var versionCore = core.version || null;
  var V140_VERSION = '1.4.0';
  var SESSION_KEY = 'mineradio-queue-session-v1';
  var REDUCED_MOTION_KEY = 'mineradio-reduced-motion-v1';
  var PODCAST_RATE_KEY = 'mineradio-podcast-rate-v1';

  function byId(id) { return document.getElementById(id); }
  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function finite(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function songKey(song) {
    if (queueCore && queueCore.queueItemKey) return queueCore.queueItemKey(song);
    return typeof queueItemKey === 'function' ? queueItemKey(song) : '';
  }
  function currentSong() {
    return currentIdx >= 0 && playQueue[currentIdx] ? playQueue[currentIdx] : (activePlaybackSong || null);
  }
  function isPodcast(song) {
    return typeof isPodcastSong === 'function'
      ? isPodcastSong(song)
      : !!(song && (song.type === 'podcast' || song.source === 'podcast'));
  }
  function isNeteaseSong(song) {
    return !!(song && !isPodcast(song) && songProviderKey(song) === 'netease' && /^\d+$/.test(String(song.id || '')));
  }
  function requestBody(data) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    };
  }
  function errorText(error, fallback) {
    var kind = error && error.kind;
    if (kind === 'offline') return '当前处于离线状态';
    if (kind === 'timeout') return '请求超时，请稍后重试';
    if (kind === 'auth_required') return '登录状态已失效';
    if (kind === 'rate_limited') return '请求过于频繁，请稍后重试';
    if (kind === 'server') return '音乐服务暂时不可用';
    if (kind === 'invalid_response') return '服务返回了无法识别的数据';
    if (kind === 'network') return '暂时无法连接音乐服务';
    return (error && error.message) || fallback || '操作失败';
  }

  function installRuntimeStyles() {
    if (byId('v140-runtime-styles')) return;
    var style = document.createElement('style');
    style.id = 'v140-runtime-styles';
    style.textContent = [
      '.search-result-more{position:relative;flex:0 0 30px;width:30px;min-width:30px;max-width:30px}',
      '.search-result-more>summary{box-sizing:border-box;list-style:none;width:30px;height:30px;display:grid;place-items:center;overflow:hidden;border-radius:7px;color:rgba(255,255,255,.62);cursor:pointer;font-family:inherit;font-size:18px;line-height:1;letter-spacing:0;text-align:center}',
      '.search-result-more>summary::-webkit-details-marker{display:none}',
      '.search-result-more[open]>summary,.search-result-more>summary:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.search-result-menu{position:absolute;right:0;top:34px;z-index:20;width:150px;padding:6px;background:rgba(12,16,20,.98);border:1px solid rgba(255,255,255,.11);border-radius:8px;box-shadow:0 16px 42px rgba(0,0,0,.42)}',
      '.search-result-menu button{width:100%;height:32px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.72);font:inherit;font-size:11px;text-align:left;cursor:pointer}',
      '.search-result-menu button:hover,.search-result-menu button:focus-visible{background:rgba(255,255,255,.075);color:#fff}',
      '.queue-select-box{width:16px;height:16px;accent-color:var(--fc-accent);flex:0 0 auto}',
      '.queue-item.queue-selected{background:rgba(var(--fc-accent-rgb),.08)}',
      '.queue-item .queue-main-hit{display:flex;align-items:center;gap:10px;min-width:0;flex:1;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}',
      '.queue-selection-tools{display:flex;align-items:center;gap:6px;margin:7px 0}',
      '.queue-selection-count{font-size:10px;color:rgba(255,255,255,.42);margin-right:auto}',
      '.queue-window-nav{display:grid;grid-template-columns:30px minmax(0,1fr) 30px;align-items:center;gap:8px;min-height:34px;margin:5px 0;padding:2px 4px}',
      '.queue-window-nav button{width:30px;height:30px;padding:0;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(255,255,255,.035);color:rgba(255,255,255,.62);font:18px/1 inherit;cursor:pointer}',
      '.queue-window-nav button:hover,.queue-window-nav button:focus-visible{background:rgba(255,255,255,.075);color:#fff}',
      '.queue-window-nav button:disabled{opacity:.22;cursor:default}',
      '.queue-window-info,.mini-queue-window-info{text-align:center;color:rgba(255,255,255,.35);font-size:9.5px}',
      '.queue-window-nav .queue-window-info{width:100%;min-width:0;height:30px;border:0;background:transparent;font:inherit;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
      '.queue-window-nav .queue-window-info:hover,.queue-window-nav .queue-window-info:focus-visible{background:rgba(255,255,255,.045);color:rgba(255,255,255,.72)}',
      '.mini-queue-window-info{padding:6px 4px 2px}',
      '.mini-queue-open-full{display:block;margin:5px auto 1px;padding:5px 9px;border:0;border-radius:5px;background:transparent;color:rgba(255,255,255,.5);font:inherit;font-size:10px;cursor:pointer}',
      '.mini-queue-open-full:hover,.mini-queue-open-full:focus-visible{background:rgba(255,255,255,.06);color:#fff}',
      '.queue-row-manage{display:flex;gap:4px;margin-left:auto}',
      '.queue-row-manage button,.pl-owner-action,.pl-track-manage{height:26px;padding:0 8px;border:1px solid rgba(255,255,255,.09);border-radius:6px;background:rgba(255,255,255,.03);color:rgba(255,255,255,.55);font:inherit;font-size:10px;cursor:pointer}',
      '.pl-owner-action.danger,.pl-track-manage.danger{color:#ff8ca0}',
      '.pl-detail-row[draggable=true]{cursor:grab}',
      '.pl-detail-row.pl-track-dragging{opacity:.42}',
      '.pl-detail-row.pl-track-drop{box-shadow:inset 0 -2px 0 rgba(var(--fc-accent-rgb),.85)}',
      '.artist-album-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
      '.artist-album-card{min-width:0;padding:8px;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:rgba(255,255,255,.025);color:inherit;text-align:left;cursor:pointer}',
      '.artist-album-card:hover{background:rgba(255,255,255,.055)}',
      '.artist-album-card img{display:block;width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;margin-bottom:7px}',
      '.artist-album-card b,.artist-album-card small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.artist-album-card b{font-size:11px}.artist-album-card small{font-size:9.5px;color:rgba(255,255,255,.38);margin-top:3px}',
      '.album-track-main{min-width:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}',
      '.settings-inline-label{margin:14px 0 6px;color:rgba(255,255,255,.38);font-size:10px}',
      '#toast.v140-action-toast{display:flex;align-items:center}',
      '@media(max-width:720px){.artist-album-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}'
    ].join('');
    document.head.appendChild(style);
  }

  // Request failures now carry an explicit kind/status while successful payloads
  // remain untouched, including APIs that report application errors in JSON.
  async function apiJsonV140(url, opts) {
    opts = opts || {};
    var fetchOpts = Object.assign({}, opts);
    var timeoutOption = fetchOpts.timeoutMs;
    delete fetchOpts.timeoutMs;
    var timeoutMs = timeoutOption === false ? 0 : Math.max(0, finite(timeoutOption, 15000));
    var method = String(fetchOpts.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      fetchOpts.headers = Object.assign({}, fetchOpts.headers || {}, { 'X-Mineradio-Request': '1' });
    }
    var timer = null;
    var timedOut = false;
    if (timeoutMs && window.AbortController && !fetchOpts.signal) {
      var controller = new AbortController();
      fetchOpts.signal = controller.signal;
      timer = setTimeout(function () {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
    try {
      var response = await fetch(url, fetchOpts);
      var raw = await response.text();
      var payload = {};
      if (raw) {
        try { payload = JSON.parse(raw); }
        catch (parseError) {
          parseError.code = 'INVALID_RESPONSE';
          parseError.status = response.status;
          parseError.payload = null;
          throw parseError;
        }
      }
      if (payload && payload.authExpired === true) {
        try {
          window.dispatchEvent(new CustomEvent('mineradio:netease-auth-expired', { detail: payload }));
        } catch (_) {}
      }
      if (!response.ok) {
        var httpError = new Error((payload && (payload.message || payload.errorReason || payload.error)) || ('HTTP ' + response.status));
        httpError.status = response.status;
        httpError.code = payload && (payload.errorCode || payload.reason || payload.code || payload.error);
        httpError.payload = payload;
        throw httpError;
      }
      return payload;
    } catch (error) {
      var classified = networkCore && networkCore.classifyNetworkError
        ? networkCore.classifyNetworkError(error, {
            status: error && error.status,
            payload: error && error.payload,
            timedOut: timedOut,
            aborted: !timedOut && error && error.name === 'AbortError',
            online: navigator.onLine
          })
        : { kind: timedOut ? 'timeout' : (navigator.onLine === false ? 'offline' : 'network'), retryable: true };
      error.kind = classified.kind;
      error.status = classified.status || error.status || 0;
      error.code = classified.code || error.code || '';
      error.retryable = !!classified.retryable;
      error.authRequired = !!classified.authRequired;
      if (timedOut && !error.message) error.message = 'Request timed out';
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  window.apiJson = apiJsonV140;

  var legacyDoSearch = window.doSearch;
  var v140Search = {
    query: '', mode: 'song', loading: false, requestSeq: 0,
    neteaseOffset: 0, qqOffset: 0, hasMore: false, total: 0,
    neteaseHasMore: true, qqHasMore: true, neteaseTotal: 0, qqTotal: 0,
    partialFailures: [], lastError: null
  };
  window.__mineradioV140Search = v140Search;

  function searchStateMarkup(title, detail, retry) {
    return '<div class="search-state"><strong>' + escHtml(title) + '</strong>' +
      (detail ? '<span>' + escHtml(detail) + '</span>' : '') +
      (retry ? '<button class="fx-mini-btn" type="button" onclick="retryV140Search()">重试</button>' : '') + '</div>';
  }
  function resetSearchPaging(q, mode) {
    v140Search.query = q;
    v140Search.mode = mode;
    v140Search.neteaseOffset = 0;
    v140Search.qqOffset = 0;
    v140Search.hasMore = false;
    v140Search.total = 0;
    v140Search.neteaseHasMore = true;
    v140Search.qqHasMore = true;
    v140Search.neteaseTotal = 0;
    v140Search.qqTotal = 0;
    v140Search.partialFailures = [];
    v140Search.lastError = null;
  }
  function mergeSearchPage(existing, incoming) {
    var seen = Object.create(null);
    var result = [];
    (existing || []).concat(incoming || []).forEach(function (song) {
      var key = songKey(song) || (songProviderKey(song) + ':' + String(song.name || '') + '|' + String(song.artist || ''));
      if (!key || seen[key]) return;
      seen[key] = true;
      result.push(song);
    });
    return result;
  }
  async function fetchSearchPage(q, mode, state) {
    state = state || v140Search;
    if (mode === 'netease') {
      var neLimit = 24;
      var ne = await apiJsonV140('/api/search?keywords=' + encodeURIComponent(q) + '&limit=' + neLimit + '&offset=' + state.neteaseOffset);
      var neOffset = state.neteaseOffset + finite(ne.limit, neLimit);
      return {
        songs: ne.songs || [], hasMore: !!ne.hasMore, partialFailures: [],
        neteaseOffset: neOffset, qqOffset: state.qqOffset,
        neteaseHasMore: !!ne.hasMore, qqHasMore: state.qqHasMore,
        neteaseTotal: finite(ne.total, neOffset), qqTotal: state.qqTotal,
        total: finite(ne.total, neOffset)
      };
    }
    if (mode === 'qq') {
      var qqLimit = 24;
      var qq = await apiJsonV140('/api/qq/search?keywords=' + encodeURIComponent(q) + '&limit=' + qqLimit + '&offset=' + state.qqOffset);
      var qqOffset = state.qqOffset + finite(qq.limit, qqLimit);
      return {
        songs: qq.songs || [], hasMore: !!qq.hasMore, partialFailures: [],
        neteaseOffset: state.neteaseOffset, qqOffset: qqOffset,
        neteaseHasMore: state.neteaseHasMore, qqHasMore: !!qq.hasMore,
        neteaseTotal: state.neteaseTotal, qqTotal: finite(qq.total, qqOffset),
        total: finite(qq.total, qqOffset)
      };
    }
    var neCombinedLimit = 18;
    var qqCombinedLimit = 12;
    var requestNetease = state.neteaseHasMore !== false;
    var requestQQ = state.qqHasMore !== false;
    var settled = await Promise.allSettled([
      requestNetease
        ? apiJsonV140('/api/search?keywords=' + encodeURIComponent(q) + '&limit=' + neCombinedLimit + '&offset=' + state.neteaseOffset)
        : Promise.resolve(null),
      requestQQ
        ? apiJsonV140('/api/qq/search?keywords=' + encodeURIComponent(q) + '&limit=' + qqCombinedLimit + '&offset=' + state.qqOffset)
        : Promise.resolve(null)
    ]);
    var neData = settled[0].status === 'fulfilled' ? settled[0].value : null;
    var qqData = settled[1].status === 'fulfilled' ? settled[1].value : null;
    var failures = [];
    if (requestNetease && settled[0].status === 'rejected') failures.push('网易云');
    if (requestQQ && settled[1].status === 'rejected') failures.push('QQ 音乐');
    if (!neData && !qqData && failures.length) {
      throw settled[0].status === 'rejected' ? settled[0].reason : settled[1].reason;
    }
    var nextNeteaseOffset = neData ? state.neteaseOffset + finite(neData.limit, neCombinedLimit) : state.neteaseOffset;
    var nextQQOffset = qqData ? state.qqOffset + finite(qqData.limit, qqCombinedLimit) : state.qqOffset;
    var nextNeteaseHasMore = neData ? !!neData.hasMore : state.neteaseHasMore;
    var nextQQHasMore = qqData ? !!qqData.hasMore : state.qqHasMore;
    var nextNeteaseTotal = neData ? finite(neData.total, nextNeteaseOffset) : state.neteaseTotal;
    var nextQQTotal = qqData ? finite(qqData.total, nextQQOffset) : state.qqTotal;
    var merged = typeof mergeSongSearchResults === 'function'
      ? mergeSongSearchResults(neData && neData.songs || [], qqData && qqData.songs || [], 30, q)
      : (neData && neData.songs || []).concat(qqData && qqData.songs || []);
    return {
      songs: merged,
      hasMore: !!(nextNeteaseHasMore || nextQQHasMore),
      partialFailures: failures,
      neteaseOffset: nextNeteaseOffset,
      qqOffset: nextQQOffset,
      neteaseHasMore: nextNeteaseHasMore,
      qqHasMore: nextQQHasMore,
      neteaseTotal: nextNeteaseTotal,
      qqTotal: nextQQTotal,
      total: nextNeteaseTotal + nextQQTotal
    };
  }

  function searchOverflowMarkup(song, index) {
    var albumAction = song && (song.albumId || song.album)
      ? '<button type="button" onclick="event.stopPropagation();openSearchResultAlbum(' + index + ')">查看专辑</button>' : '';
    return '<details class="search-result-more" onclick="event.stopPropagation()">' +
      '<summary aria-label="更多操作" title="更多操作">&#8230;</summary>' +
      '<div class="search-result-menu" role="menu">' +
        '<button type="button" onclick="toggleLikeSearchResult(' + index + ')">' + (isSongLiked(song) ? '取消红心' : '红心喜欢') + '</button>' +
        '<button type="button" onclick="collectSearchResult(' + index + ')">收藏到歌单</button>' +
        '<button type="button" onclick="openSearchResultArtist(' + index + ')">查看歌手</button>' + albumAction +
      '</div></details>';
  }

  function renderSongSearchResultsV140(songs) {
    playlist = songs || [];
    var batchCount = typeof dedupeSearchBatchSongs === 'function' ? dedupeSearchBatchSongs(playlist).length : playlist.length;
    var countLabel = v140Search.total > playlist.length
      ? '已加载 <strong>' + playlist.length + '</strong><span class="search-batch-total"> / 共 ' + v140Search.total + ' 首</span>'
      : '<strong>' + playlist.length + '</strong> 首结果';
    var toolbar = '<div class="search-batch-toolbar" role="toolbar" aria-label="搜索结果批量操作">' +
      '<span class="search-batch-count">' + countLabel + '</span>' +
      '<button class="search-batch-action primary" type="button" onclick="event.stopPropagation();playAllSearchResults()" aria-label="播放全部，共 ' + batchCount + ' 首"><span>播放全部</span></button>' +
      '<button class="search-batch-action" type="button" onclick="event.stopPropagation();addAllSearchResultsToQueue()" aria-label="全部加入队列，共 ' + batchCount + ' 首"><span>加入队列</span></button>' +
    '</div>';
    var rows = playlist.map(function (song, index) {
      var thumb = songCoverSrc(song, 80);
      var image = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" onerror="this.style.opacity=.2">' : '<div class="mini-queue-cover"></div>';
      var vip = song.fee === 1 ? '<span class="tag-vip">VIP</span>' : '';
      return '<div class="search-result ' + songProviderKey(song) + '-source" role="listitem">' +
        '<button class="search-result-main" type="button" onclick="playSearchResult(' + index + ')" aria-label="播放 ' + escHtml(song.name || '歌曲') + '">' + image +
          '<span class="search-result-info"><span class="search-result-title">' + escHtml(song.name || '') + songSourceTagHtml(song) + vip + '</span>' +
          '<span class="search-result-meta">' + escHtml(searchResultMetaText(song)) + '</span></span>' +
        '</button>' +
        '<button class="add-btn" type="button" title="下一首播放" aria-label="将 ' + escHtml(song.name || '歌曲') + ' 设为下一首" onclick="event.stopPropagation();queueSearchResult(' + index + ')">+</button>' +
        searchOverflowMarkup(song, index) +
      '</div>';
    }).join('');
    var more = v140Search.hasMore
      ? '<button class="fx-mini-btn ghost search-load-more" type="button" onclick="loadMoreSearchResults()">加载更多</button>' : '';
    var partialWarning = v140Search.partialFailures.length
      ? '<div class="search-state search-partial-warning"><strong>' + escHtml(v140Search.partialFailures.join('、') + '暂时不可用') + '</strong><span>已保留当前结果，加载更多时会继续重试</span></div>'
      : '';
    $results.innerHTML = partialWarning + toolbar + '<div role="list" aria-label="歌曲搜索结果">' + rows + '</div>' + more;
    $results.classList.add('show');
    syncLikeStatusForSongs(playlist);
    if (window.gsap) animateListItems($results, '.search-result', { x: 0, y: 6, stagger: 0.01, duration: 0.18, limit: 18 });
  }
  window.renderSongSearchResults = renderSongSearchResultsV140;

  async function runPagedSearch(q, append, opts) {
    opts = opts || {};
    q = String(q || '').trim();
    if (!q) {
      if (searchMode === 'podcast') loadPodcastHot(); else renderSearchHistory();
      return;
    }
    if (searchMode === 'podcast') {
      return legacyDoSearch ? legacyDoSearch(q, opts) : doPodcastSearch(q);
    }
    var mode = searchMode;
    if (!append || v140Search.query !== q || v140Search.mode !== mode) {
      if (v140Search.loading) v140Search.requestSeq++;
      v140Search.loading = false;
      resetSearchPaging(q, mode);
    }
    if (v140Search.loading) return;
    v140Search.loading = true;
    var seq = ++v140Search.requestSeq;
    var pagingState = {
      neteaseOffset: v140Search.neteaseOffset,
      qqOffset: v140Search.qqOffset,
      neteaseHasMore: v140Search.neteaseHasMore,
      qqHasMore: v140Search.qqHasMore,
      neteaseTotal: v140Search.neteaseTotal,
      qqTotal: v140Search.qqTotal
    };
    var inputValue = $input ? $input.value.trim() : q;
    if (!append) {
      playlist = [];
      $results.innerHTML = searchStateMarkup('正在搜索', '“' + q + '”', false);
      $results.classList.add('show');
    } else {
      var moreButton = $results.querySelector('.search-load-more');
      if (moreButton) { moreButton.disabled = true; moreButton.textContent = '正在加载…'; }
    }
    try {
      var page = await fetchSearchPage(q, mode, pagingState);
      if (seq !== v140Search.requestSeq || searchMode !== mode || ($input && $input.value.trim() !== inputValue)) return;
      v140Search.neteaseOffset = page.neteaseOffset;
      v140Search.qqOffset = page.qqOffset;
      v140Search.neteaseHasMore = page.neteaseHasMore;
      v140Search.qqHasMore = page.qqHasMore;
      v140Search.neteaseTotal = page.neteaseTotal;
      v140Search.qqTotal = page.qqTotal;
      v140Search.total = page.total;
      v140Search.partialFailures = page.partialFailures || [];
      v140Search.hasMore = !!page.hasMore;
      playlist = mergeSearchPage(append ? playlist : [], page.songs || []);
      searchLastResultQuery = playlist.length ? searchResultKey(q, mode) : '';
      if (!playlist.length) {
        $results.innerHTML = searchStateMarkup('没有找到相关歌曲', '换一个歌名或歌手试试', false);
        $results.classList.add('show');
      } else {
        rememberSearchQuery(q);
        renderSongSearchResultsV140(playlist);
        if (opts.autoPlayFirst) playSearchResult(0);
      }
    } catch (error) {
      if (seq !== v140Search.requestSeq) return;
      v140Search.lastError = error;
      if (append && playlist.length) {
        renderSongSearchResultsV140(playlist);
        var more = $results.querySelector('.search-load-more');
        if (more) more.insertAdjacentHTML('beforebegin', searchStateMarkup('加载失败', errorText(error), true));
      } else {
        $results.innerHTML = searchStateMarkup('搜索失败', errorText(error), true);
        $results.classList.add('show');
      }
    } finally {
      if (seq === v140Search.requestSeq) v140Search.loading = false;
    }
  }
  window.doSearch = function (q, opts) { return runPagedSearch(q, false, opts); };
  window.loadMoreSearchResults = function () { return runPagedSearch(v140Search.query, true); };
  window.retryV140Search = function () { return runPagedSearch(v140Search.query || ($input && $input.value), false); };

  var albumDetailState = { album: null, tracks: [], token: 0 };
  function albumDate(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (_) { return ''; }
  }
  function renderAlbumDetail() {
    var album = albumDetailState.album || {};
    var cover = byId('album-detail-cover');
    var title = byId('album-detail-heading');
    var sub = byId('album-detail-sub');
    var list = byId('album-detail-list');
    if (cover) cover.style.backgroundImage = album.cover ? 'url("' + cssImageUrl(coverUrlWithSize(album.cover, 320)) + '")' : '';
    if (title) title.textContent = album.name || '专辑详情';
    if (sub) sub.textContent = [album.artist, albumDate(album.publishTime), albumDetailState.tracks.length + ' 首'].filter(Boolean).join(' · ');
    if (!list) return;
    if (!albumDetailState.tracks.length) {
      list.innerHTML = '<div class="search-state"><strong>这张专辑暂无可播放歌曲</strong></div>';
      return;
    }
    list.innerHTML = albumDetailState.tracks.map(function (song, index) {
      return '<div class="album-track">' +
        '<span class="album-track-index">' + String(index + 1).padStart(2, '0') + '</span>' +
        '<button class="album-track-main" type="button" onclick="playAlbumDetailTrack(' + index + ')"><span class="album-track-title">' + escHtml(song.name || '') + '</span><span class="album-track-sub">' + escHtml(song.artist || album.artist || '') + '</span></button>' +
        '<span class="album-track-actions"><button class="fx-mini-btn ghost" type="button" onclick="queueAlbumDetailTrack(' + index + ')" title="下一首播放">+</button><button class="fx-mini-btn ghost" type="button" onclick="collectAlbumDetailTrack(' + index + ')" title="收藏到歌单">收藏</button></span>' +
      '</div>';
    }).join('');
  }
  window.openAlbumDetail = async function (albumOrId) {
    var id = albumOrId && typeof albumOrId === 'object' ? albumOrId.id : albumOrId;
    if (!id) { showToast('未找到专辑信息'); return; }
    var token = ++albumDetailState.token;
    albumDetailState.album = albumOrId && typeof albumOrId === 'object' ? albumOrId : { id: id, name: '正在载入专辑' };
    albumDetailState.tracks = [];
    renderAlbumDetail();
    openGsapModal(byId('album-detail-modal'));
    try {
      var data = await apiJsonV140('/api/album/detail?id=' + encodeURIComponent(id));
      if (token !== albumDetailState.token) return;
      albumDetailState.album = data.album || albumDetailState.album;
      albumDetailState.tracks = (data.tracks || []).map(cloneSong);
      renderAlbumDetail();
    } catch (error) {
      if (token !== albumDetailState.token) return;
      var list = byId('album-detail-list');
      if (list) list.innerHTML = searchStateMarkup('专辑加载失败', errorText(error), false);
    }
  };
  window.closeAlbumDetail = function () { closeGsapModal(byId('album-detail-modal')); };
  window.playAlbumDetailTrack = function (index) {
    if (!albumDetailState.tracks[index]) return;
    playQueue = albumDetailState.tracks.map(cloneSong);
    currentIdx = index;
    closeAlbumDetail();
    safeRenderQueuePanel('album-detail-play', { deferWhenHidden: false });
    safeShelfRebuild('album-detail-play', true);
    playQueueAt(index);
  };
  window.playAlbumDetailAll = function () { if (albumDetailState.tracks.length) playAlbumDetailTrack(0); };
  window.addAlbumDetailToQueue = function () {
    var added = 0;
    albumDetailState.tracks.forEach(function (song) { queueSong(song); added++; });
    showToast('已加入 ' + added + ' 首歌曲');
  };
  window.queueAlbumDetailTrack = function (index) {
    var song = albumDetailState.tracks[index];
    if (song) { queueSongNext(song); showToast('已设为下一首: ' + song.name); }
  };
  window.collectAlbumDetailTrack = function (index) {
    var song = albumDetailState.tracks[index];
    if (song) openCollectModal(song);
  };
  window.openSearchResultAlbum = async function (index) {
    var song = playlist && playlist[index];
    if (!song) return;
    if (song.albumId) return openAlbumDetail(song.albumId);
    if (!song.album) { showToast('当前歌曲没有专辑信息'); return; }
    try {
      var data = await apiJsonV140('/api/album/search?keywords=' + encodeURIComponent(song.album + ' ' + (song.artist || '')) + '&limit=8&offset=0');
      var target = (data.albums || []).find(function (item) {
        return normalizeArtistNameForMatch(item.name) === normalizeArtistNameForMatch(song.album);
      }) || (data.albums || [])[0];
      if (target) openAlbumDetail(target); else showToast('没有找到对应专辑');
    } catch (error) { showToast(errorText(error, '专辑查找失败')); }
  };

  installRuntimeStyles();
})();

(function () {
  'use strict';

  var core = window.MineradioCore || {};
  var queueCore = core.queueSession || null;
  var lyricCore = core.lyrics || null;
  var versionCore = core.version || null;
  var SESSION_KEY = 'mineradio-queue-session-v1';
  var REDUCED_MOTION_KEY = 'mineradio-reduced-motion-v1';
  var PODCAST_RATE_KEY = 'mineradio-podcast-rate-v1';
  var LYRIC_DISPLAY_KEY = 'mineradio-lyric-display-v1';

  function byId(id) { return document.getElementById(id); }
  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function finite(value, fallback) { value = Number(value); return isFinite(value) ? value : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function keyFor(song) {
    if (queueCore && queueCore.queueItemKey) return queueCore.queueItemKey(song);
    return typeof queueItemKey === 'function' ? queueItemKey(song) : '';
  }
  function selectedSong() { return currentIdx >= 0 && playQueue[currentIdx] ? playQueue[currentIdx] : null; }
  function isPodcast(song) {
    return typeof isPodcastSong === 'function' ? isPodcastSong(song) : !!(song && (song.type === 'podcast' || song.source === 'podcast'));
  }
  function postJson(url, data) {
    return apiJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
  }
  function messageFor(error, fallback) {
    if (error && error.kind === 'offline') return '当前处于离线状态';
    if (error && error.kind === 'timeout') return '请求超时，请稍后重试';
    if (error && error.kind === 'auth_required') return '登录状态已失效';
    return (error && error.message) || fallback || '操作失败';
  }

  var pendingResume = { key: '', seconds: 0 };
  var sessionSaveTimer = null;
  var queueSelectionMode = false;
  var queueSelection = new Set();
  var queueDragIndex = -1;
  var QUEUE_RENDER_BATCH = 180;
  var MINI_QUEUE_RENDER_BATCH = 120;
  var queueRenderStart = 0;
  var queueRenderFollowCurrent = true;
  var queueRenderQueueRef = playQueue;

  function playbackWasActive() { return !!(audio && audio.src && !audio.paused && !audio.ended); }
  function updatePlaybackPresence() {
    var song = selectedSong() || activePlaybackSong;
    document.body.classList.toggle('v140-has-playback', !!song);
    document.body.classList.toggle('podcast-playing', isPodcast(song));
    updateHomeQueueCard();
  }
  function renderSelectedSongPaused(song) {
    activePlaybackSong = song || null;
    playing = false;
    if (typeof setPlayIcon === 'function') setPlayIcon(false);
    if (!song) {
      updatePlaybackPresence();
      return;
    }
    var title = byId('thumb-title');
    var artist = byId('thumb-artist');
    var wrap = byId('thumb-wrap');
    if (title) title.textContent = song.name || song.title || '';
    if (artist) artist.textContent = song.artist || '';
    if (wrap) wrap.classList.add('visible');
    if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
    if (typeof updateLikeButtons === 'function') updateLikeButtons(song);
    if (typeof updateCustomCoverButton === 'function') updateCustomCoverButton();
    if (typeof updateCustomLyricControls === 'function') updateCustomLyricControls();
    var cover = typeof songCoverSrc === 'function' ? songCoverSrc(song, 400) : (song.cover || '');
    if (typeof loadCoverFromUrl === 'function') {
      try { loadCoverFromUrl(cover || '', { deferHeavy: true, delay: 800, timeout: 1800 }); } catch (_) {}
    }
    updatePlaybackPresence();
    if (typeof syncSystemMediaIntegration === 'function') syncSystemMediaIntegration(true);
  }
  function stopAudioForQueueChange(nextSong) {
    trackSwitchToken++;
    try {
      if (audio) {
        audio.onended = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    } catch (_) {}
    renderSelectedSongPaused(nextSong || null);
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  }

  function saveQueueSessionNow() {
    if (!queueCore || !queueCore.serializeQueueSnapshot) return;
    try {
      if (!playQueue.length) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      localStorage.setItem(SESSION_KEY, queueCore.serializeQueueSnapshot({
        queue: playQueue,
        currentIndex: currentIdx,
        activePlaybackSong: activePlaybackSong,
        positionSeconds: audio && isFinite(audio.currentTime) ? audio.currentTime : pendingResume.seconds,
        durationSeconds: audio && isFinite(audio.duration) ? audio.duration : 0,
        playMode: playMode,
        wasPlaying: playbackWasActive(),
        context: activeRadioContext || null
      }));
    } catch (error) {
      console.warn('[QueueSessionSave]', error);
    }
  }
  function scheduleQueueSessionSave() {
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(function () {
      sessionSaveTimer = null;
      saveQueueSessionNow();
    }, 180);
  }
  function restoreQueueSession() {
    if (!queueCore || !queueCore.restoreQueueSnapshot || playQueue.length) return false;
    var raw = '';
    try { raw = localStorage.getItem(SESSION_KEY) || ''; } catch (_) {}
    if (!raw) return false;
    var restored = queueCore.restoreQueueSnapshot(raw);
    if (!restored.ok || !restored.state || !restored.state.queue.length) {
      try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
      return false;
    }
    playQueue = restored.state.queue.map(function (song) { return cloneSong(song); });
    currentIdx = clamp(finite(restored.state.currentIndex, 0), 0, playQueue.length - 1);
    playMode = restored.state.playMode || 'loop';
    activeRadioContext = restored.state.context || null;
    pendingResume = {
      key: keyFor(playQueue[currentIdx]),
      seconds: Math.max(0, finite(restored.state.positionSeconds, 0))
    };
    renderSelectedSongPaused(playQueue[currentIdx]);
    if (typeof switchPlaybackVisualToEmily === 'function') switchPlaybackVisualToEmily();
    if (typeof updatePlayModeButton === 'function') updatePlayModeButton(false);
    renderQueuePanelV140({ animate: false, preserveWindow: true });
    showToast(pendingResume.seconds > 1 ? '已恢复上次队列和播放位置' : '已恢复上次队列');
    return true;
  }

  function showUndoToast(label, callback) {
    var toast = byId('toast');
    if (!toast) return;
    toast.textContent = '';
    toast.classList.add('show', 'v140-action-toast');
    var text = document.createElement('span');
    text.textContent = label;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'undo-toast-action';
    button.textContent = '撤销';
    button.addEventListener('click', function () {
      callback();
      toast.classList.remove('show', 'v140-action-toast');
    }, { once: true });
    toast.appendChild(text);
    toast.appendChild(button);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show', 'v140-action-toast'); }, 5200);
  }
  function queueSnapshotRefs() {
    return { queue: playQueue.slice(), currentIndex: currentIdx, currentKey: keyFor(selectedSong()), activeKey: keyFor(activePlaybackSong) };
  }
  function restoreQueueRefs(snapshot) {
    var activeKey = playbackWasActive() ? keyFor(activePlaybackSong) : '';
    playQueue = snapshot.queue.slice();
    currentIdx = snapshot.currentIndex;
    if (activeKey) {
      var activeIndex = playQueue.findIndex(function (song) { return keyFor(song) === activeKey; });
      if (activeIndex >= 0) currentIdx = activeIndex;
    }
    if (!playbackWasActive()) renderSelectedSongPaused(playQueue[currentIdx] || null);
    queueSelection.clear();
    renderQueuePanelV140({ animate: false });
    safeShelfRebuild('queue-undo', true);
    scheduleQueueSessionSave();
    showToast('已撤销');
  }

  function moveQueueItemV140(from, to, announce, renderOptions) {
    from = finite(from, -1); to = finite(to, -1);
    if (from < 0 || to < 0 || from >= playQueue.length || to >= playQueue.length || from === to) return false;
    if (queueCore && queueCore.moveQueueItem) {
      var moved = queueCore.moveQueueItem({ queue: playQueue, currentIndex: currentIdx }, from, to);
      if (!moved.changed) return false;
      playQueue = moved.state.queue;
      currentIdx = moved.state.currentIndex;
    } else {
      var current = selectedSong();
      var item = playQueue.splice(from, 1)[0];
      playQueue.splice(to, 0, item);
      currentIdx = current ? playQueue.indexOf(current) : -1;
    }
    renderQueuePanelV140(Object.assign({ animate: false, preserveWindow: true }, renderOptions || {}));
    safeShelfRebuild('queue-reorder');
    scheduleQueueSessionSave();
    if (announce) showToast('已调整队列顺序');
    return true;
  }
  window.moveQueueItemV140 = moveQueueItemV140;

  function queueActionButtons(song, index) {
    return '<div class="qi-act">' +
      '<button class="' + (isSongLiked(song) ? 'liked' : '') + '" type="button" onclick="event.stopPropagation();toggleLikeQueueIndex(' + index + ')" title="' + (isSongLiked(song) ? '取消红心' : '红心喜欢') + '">' + heartIconSvg() + '</button>' +
      '<button class="queue-next" type="button" onclick="event.stopPropagation();queueIndexNext(' + index + ')" title="下一首播放">下</button>' +
      '<button type="button" onclick="event.stopPropagation();collectQueueIndex(' + index + ')" title="收藏到歌单">' + playlistPlusIconSvg() + '</button>' +
      '<button type="button" onclick="event.stopPropagation();removeFromQueue(' + index + ')" title="移除">×</button>' +
    '</div>';
  }
  function renderQueueSelectionTools() {
    var pane = byId('queue-pane');
    if (!pane) return;
    var existing = byId('queue-selection-tools');
    if (!queueSelectionMode) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'queue-selection-tools';
      existing.className = 'queue-selection-tools';
      var list = byId('queue-list');
      pane.insertBefore(existing, list);
    }
    existing.innerHTML = '<span class="queue-selection-count">已选择 ' + queueSelection.size + ' 首</span>' +
      '<button class="fx-mini-btn ghost" type="button" onclick="selectAllQueueItems()">全选</button>' +
      '<button class="fx-mini-btn ghost" type="button" onclick="removeSelectedQueueItems()"' + (queueSelection.size ? '' : ' disabled') + '>移除</button>';
  }
  function renderQueueWindowNavigation(start, end) {
    var pane = byId('queue-pane');
    var list = byId('queue-list');
    if (!pane || !list) return;
    var host = byId('queue-window-nav');
    if (playQueue.length <= QUEUE_RENDER_BATCH) {
      if (host) host.remove();
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = 'queue-window-nav';
      host.className = 'queue-window-nav';
      host.setAttribute('role', 'navigation');
      host.setAttribute('aria-label', '队列分页');
      pane.insertBefore(host, list);
    }
    host.innerHTML =
      '<button type="button" title="上一段" aria-label="显示上一段队列" onclick="shiftQueueRenderWindow(-1)"' + (start <= 0 ? ' disabled' : '') + '>‹</button>' +
      '<button class="queue-window-info" type="button" title="定位到当前歌曲" aria-label="定位到当前歌曲" onclick="followCurrentQueueWindow()">' + (start + 1) + '-' + end + ' / ' + playQueue.length + (currentIdx >= 0 ? ' · 当前 ' + (currentIdx + 1) : '') + '</button>' +
      '<button type="button" title="下一段" aria-label="显示下一段队列" onclick="shiftQueueRenderWindow(1)"' + (end >= playQueue.length ? ' disabled' : '') + '>›</button>';
  }
  function renderMiniQueueV140(opts) {
    opts = opts || {};
    var list = byId('mini-queue-list');
    var count = byId('mini-queue-count');
    if (!list || !count) return;
    count.textContent = playQueue.length ? (playQueue.length + ' 首' + (currentIdx >= 0 ? ' · 正在播放 ' + (currentIdx + 1) : '')) : '0 首';
    if (!miniQueueOpen && !opts.animate && !opts.scrollCurrent) return;
    if (!playQueue.length) {
      list.innerHTML = '<div class="mini-queue-empty">队列为空，先搜索或打开歌单</div>';
      return;
    }
    var miniMaxStart = Math.max(0, playQueue.length - MINI_QUEUE_RENDER_BATCH);
    var miniStart = currentIdx >= 0
      ? clamp(currentIdx - Math.floor(MINI_QUEUE_RENDER_BATCH / 3), 0, miniMaxStart)
      : 0;
    var miniEnd = Math.min(playQueue.length, miniStart + MINI_QUEUE_RENDER_BATCH);
    list.innerHTML = playQueue.slice(miniStart, miniEnd).map(function (song, localIndex) {
      var index = miniStart + localIndex;
      var thumb = songCoverSrc(song, 60);
      var image = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" onerror="this.style.opacity=.2">' : '<div class="mini-queue-cover"></div>';
      return '<div class="mini-queue-item' + (index === currentIdx ? ' now' : '') + '" role="option" aria-selected="' + (index === currentIdx ? 'true' : 'false') + '" tabindex="0" data-mini-queue-index="' + index + '" onclick="playQueueAt(' + index + ')">' + image +
        '<div class="mini-queue-info"><div class="mini-queue-name">' + escHtml(song.name || '') + '</div><div class="mini-queue-sub">' + escHtml(song.artist || '') + '</div></div>' +
        '<button class="mini-queue-remove mini-queue-next" type="button" onclick="event.stopPropagation();queueIndexNext(' + index + ')" title="下一首播放">下</button>' +
        '<button class="mini-queue-remove" type="button" onclick="event.stopPropagation();removeFromQueue(' + index + ')" title="移除">×</button></div>';
    }).join('') + (playQueue.length > MINI_QUEUE_RENDER_BATCH
      ? '<div class="mini-queue-window-info">显示 ' + (miniStart + 1) + '-' + miniEnd + ' / ' + playQueue.length + '</div>' +
        '<button class="mini-queue-open-full" type="button" onclick="event.stopPropagation();closeMiniQueue();openPlaylistPanelTab(\'queue\')">查看完整队列</button>'
      : '');
    if (opts.scrollCurrent) requestAnimationFrame(function () {
      var active = list.querySelector('.mini-queue-item.now');
      if (active && typeof smoothScrollToItem === 'function') smoothScrollToItem(list, active, { duration: .3, align: .42 });
    });
  }
  window.renderMiniQueuePanel = renderMiniQueueV140;

  function renderQueuePanelV140(opts) {
    opts = opts || {};
    var list = byId('queue-list');
    if (!list) return;
    var queueReplaced = queueRenderQueueRef !== playQueue;
    if (queueReplaced) {
      queueRenderQueueRef = playQueue;
      if (opts.preserveWindow !== true) {
        queueRenderFollowCurrent = true;
        queueRenderStart = 0;
      }
    }
    if (opts.resetWindow || opts.followCurrent) queueRenderFollowCurrent = true;
    if (!playQueue.length) {
      queueRenderStart = 0;
      list.innerHTML = '<div style="text-align:center;padding:24px 0;color:rgba(255,255,255,.32);font-size:11.5px">队列为空，搜索后可设为下一首</div>';
      renderQueueWindowNavigation(0, 0);
      renderQueueSelectionTools();
      renderMiniQueueV140();
      updatePlaybackPresence();
      return;
    }
    var explicitWindow = isFinite(Number(opts.windowStart));
    if (explicitWindow) {
      queueRenderStart = queueCore && queueCore.queueWindowStart
        ? queueCore.queueWindowStart(playQueue.length, QUEUE_RENDER_BATCH, Number(opts.windowStart))
        : Math.floor(clamp(Number(opts.windowStart), 0, playQueue.length - 1) / QUEUE_RENDER_BATCH) * QUEUE_RENDER_BATCH;
      queueRenderFollowCurrent = false;
    } else if (queueRenderFollowCurrent && currentIdx >= 0) {
      queueRenderStart = queueCore && queueCore.queueWindowStart
        ? queueCore.queueWindowStart(playQueue.length, QUEUE_RENDER_BATCH, currentIdx)
        : Math.floor(currentIdx / QUEUE_RENDER_BATCH) * QUEUE_RENDER_BATCH;
    } else {
      queueRenderStart = queueCore && queueCore.queueWindowStart
        ? queueCore.queueWindowStart(playQueue.length, QUEUE_RENDER_BATCH, queueRenderStart)
        : Math.floor(clamp(queueRenderStart, 0, playQueue.length - 1) / QUEUE_RENDER_BATCH) * QUEUE_RENDER_BATCH;
    }
    var windowEnd = Math.min(playQueue.length, queueRenderStart + QUEUE_RENDER_BATCH);
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '接下来播放');
    var rows = playQueue.slice(queueRenderStart, windowEnd).map(function (song, localIndex) {
      var index = queueRenderStart + localIndex;
      var thumb = songCoverSrc(song, 60);
      var image = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" onerror="this.style.opacity=.2">' : '<div style="width:38px;height:38px;border-radius:6px;background:rgba(255,255,255,.06);flex:0 0 auto"></div>';
      var selected = queueSelection.has(song);
      return '<div class="queue-item' + (index === currentIdx ? ' now' : '') + (selected ? ' queue-selected' : '') + '" data-queue-index="' + index + '" role="option" aria-selected="' + (index === currentIdx ? 'true' : 'false') + '" tabindex="0" draggable="true">' +
        '<button class="queue-drag-handle" type="button" tabindex="-1" aria-hidden="true" title="拖动排序">⋮</button>' +
        (queueSelectionMode ? '<input class="queue-select-box" type="checkbox" ' + (selected ? 'checked ' : '') + 'aria-label="选择 ' + escHtml(song.name || '歌曲') + '" onclick="event.stopPropagation();toggleQueueItemSelection(' + index + ')">' : '') +
        '<button class="queue-main-hit" type="button" onclick="playQueueAt(' + index + ')">' + image +
          '<span class="qi-info"><span class="qi-name">' + escHtml(song.name || '') + '</span><span class="qi-sub"><span class="queue-artist-link">' + escHtml(song.artist || '未知歌手') + '</span></span></span></button>' +
        queueActionButtons(song, index) + '</div>';
    }).join('');
    list.innerHTML = rows;
    renderQueueWindowNavigation(queueRenderStart, windowEnd);
    renderQueueSelectionTools();
    renderMiniQueueV140({ scrollCurrent: miniQueueOpen });
    updatePlaybackPresence();
    if (opts.animate && window.gsap) animateListItems(list, '.queue-item', { x: -8, y: 6, stagger: .01, duration: .2, limit: 16 });
  }
  window.renderQueuePanel = renderQueuePanelV140;
  window.shiftQueueRenderWindow = function (direction) {
    direction = direction < 0 ? -1 : 1;
    queueRenderStart = queueCore && queueCore.shiftQueueWindow
      ? queueCore.shiftQueueWindow(playQueue.length, QUEUE_RENDER_BATCH, queueRenderStart, direction)
      : Math.floor(clamp(queueRenderStart + direction * QUEUE_RENDER_BATCH, 0, Math.max(0, playQueue.length - 1)) / QUEUE_RENDER_BATCH) * QUEUE_RENDER_BATCH;
    renderQueuePanelV140({ animate: false, windowStart: queueRenderStart });
    var panel = byId('playlist-panel');
    if (panel) panel.scrollTop = 0;
  };
  window.followCurrentQueueWindow = function () {
    queueRenderFollowCurrent = true;
    renderQueuePanelV140({ animate: false, followCurrent: true });
    var panel = byId('playlist-panel');
    if (panel) panel.scrollTop = 0;
    requestAnimationFrame(function () {
      var active = byId('queue-list') && byId('queue-list').querySelector('.queue-item.now');
      if (active) active.focus();
    });
  };

  var legacySafeRenderQueuePanel = window.safeRenderQueuePanel;
  window.safeRenderQueuePanel = function (reason, opts) {
    var result = legacySafeRenderQueuePanel ? legacySafeRenderQueuePanel(reason, opts) : (renderQueuePanelV140(opts), true);
    scheduleQueueSessionSave();
    updatePlaybackPresence();
    return result;
  };

  window.toggleQueueSelectionMode = function () {
    queueSelectionMode = !queueSelectionMode;
    if (!queueSelectionMode) queueSelection.clear();
    renderQueuePanelV140({ animate: false });
    syncQueueToolbarButtons();
  };
  window.toggleQueueItemSelection = function (index) {
    var song = playQueue[index];
    if (!song) return;
    if (queueSelection.has(song)) queueSelection.delete(song); else queueSelection.add(song);
    renderQueuePanelV140({ animate: false });
  };
  window.selectAllQueueItems = function () {
    if (queueSelection.size === playQueue.length) queueSelection.clear();
    else playQueue.forEach(function (song) { queueSelection.add(song); });
    renderQueuePanelV140({ animate: false });
  };
  window.removeSelectedQueueItems = function () {
    if (!queueSelection.size) return;
    var before = queueSnapshotRefs();
    var removedCurrent = queueSelection.has(selectedSong());
    var wasPlaying = playbackWasActive();
    var oldIndex = currentIdx;
    var selectedIndices = [];
    playQueue.forEach(function (song, index) { if (queueSelection.has(song)) selectedIndices.push(index); });
    if (queueCore && queueCore.removeQueueItems) {
      var removal = queueCore.removeQueueItems({
        queue: playQueue,
        currentIndex: currentIdx,
        currentKey: keyFor(selectedSong()),
        positionSeconds: audio && audio.currentTime || 0,
        wasPlaying: wasPlaying
      }, selectedIndices, { onRemoveCurrent: 'advance' });
      if (!removal.changed) return;
      playQueue = removal.state.queue;
      currentIdx = removal.state.currentIndex;
      removedCurrent = removal.removedCurrent;
    } else {
      var removedBeforeCurrent = selectedIndices.filter(function (index) { return index < oldIndex; }).length;
      var currentSong = selectedSong();
      playQueue = playQueue.filter(function (song) { return !queueSelection.has(song); });
      if (!playQueue.length) currentIdx = -1;
      else if (removedCurrent) currentIdx = Math.min(Math.max(0, oldIndex - removedBeforeCurrent), playQueue.length - 1);
      else currentIdx = playQueue.indexOf(currentSong);
      if (currentIdx < 0 && playQueue.length) currentIdx = Math.min(Math.max(0, oldIndex - removedBeforeCurrent), playQueue.length - 1);
    }
    queueSelection.clear();
    if (removedCurrent) {
      if (wasPlaying && currentIdx >= 0) playQueueAt(currentIdx);
      else stopAudioForQueueChange(playQueue[currentIdx] || null);
    }
    renderQueuePanelV140({ animate: false, preserveWindow: true });
    safeShelfRebuild('queue-remove-selected', true);
    scheduleQueueSessionSave();
    showUndoToast('已移除所选歌曲', function () { restoreQueueRefs(before); });
  };

  function syncQueueToolbarButtons() {
    var multi = byId('queue-multi-btn');
    if (multi) {
      multi.classList.toggle('active', queueSelectionMode);
      multi.textContent = queueSelectionMode ? '完成' : '多选';
    }
  }
  function decorateQueueToolbar() {
    var toolbar = byId('queue-pane') && byId('queue-pane').querySelector('.queue-toolbar > div:last-child');
    if (!toolbar || byId('queue-multi-btn')) return;
    var multi = document.createElement('button');
    multi.id = 'queue-multi-btn';
    multi.type = 'button';
    multi.className = 'fx-mini-btn ghost';
    multi.textContent = '多选';
    multi.addEventListener('click', window.toggleQueueSelectionMode);
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'fx-mini-btn ghost queue-save-btn';
    save.textContent = '存为歌单';
    save.addEventListener('click', saveQueueAsPlaylist);
    toolbar.insertBefore(multi, toolbar.lastElementChild);
    toolbar.insertBefore(save, toolbar.lastElementChild);
  }

  window.saveQueueAsPlaylist = saveQueueAsPlaylist;
  async function saveQueueAsPlaylist() {
    if (!playQueue.length) { showToast('队列为空'); return; }
    if (typeof ensureLoggedInForAction === 'function' && !ensureLoggedInForAction()) return;
    var eligible = playQueue.filter(function (song) {
      return song && songProviderKey(song) === 'netease' && !isPodcast(song) && /^\d+$/.test(String(song.id || ''));
    });
    if (!eligible.length) { showToast('队列中没有可同步到网易云的歌曲'); return; }
    var name = window.prompt('歌单名称', 'Mineradio 队列 ' + new Date().toLocaleDateString('zh-CN'));
    if (!name || !name.trim()) return;
    var createdPid = '';
    try {
      var created = await postJson('/api/playlist/create', { name: name.trim() });
      var pid = created && created.playlist && created.playlist.id;
      if (!pid) throw new Error((created && created.error) || 'CREATE_PLAYLIST_FAILED');
      createdPid = String(pid);
      var ids = eligible.map(function (song) { return String(song.id); }).filter(function (id, index, arr) { return arr.indexOf(id) === index; });
      var added = await postJson('/api/playlist/add-song', { pid: pid, id: ids.join(',') });
      if (!added || !added.success) throw new Error((added && added.error) || 'PLAYLIST_ADD_FAILED');
      showToast('已保存歌单，共 ' + ids.length + ' 首');
      refreshUserPlaylists(true);
    } catch (error) {
      if (error && error.authRequired) {
        if (window.desktopWindow && typeof window.desktopWindow.invalidateNeteaseMusicLogin === 'function') {
          Promise.resolve(window.desktopWindow.invalidateNeteaseMusicLogin()).catch(function () {});
        }
        if (typeof refreshLoginStatus === 'function') Promise.resolve(refreshLoginStatus(true)).catch(function () {});
      }
      if (createdPid) {
        showToast('歌单已创建，但歌曲同步失败：' + messageFor(error, '请稍后重试'));
        refreshUserPlaylists(true);
      } else {
        showToast(messageFor(error, '保存歌单失败'));
      }
    }
  }

  window.removeFromQueue = function (index) {
    index = finite(index, -1);
    if (index < 0 || index >= playQueue.length) return;
    var before = queueSnapshotRefs();
    var wasPlaying = playbackWasActive();
    var result;
    if (queueCore && queueCore.removeQueueItem) {
      result = queueCore.removeQueueItem({
        queue: playQueue,
        currentIndex: currentIdx,
        currentKey: keyFor(selectedSong()),
        positionSeconds: audio && audio.currentTime || 0,
        wasPlaying: wasPlaying
      }, index, { onRemoveCurrent: 'advance' });
      if (!result.changed) return;
      playQueue = result.state.queue;
      currentIdx = result.state.currentIndex;
    } else {
      var removedCurrent = index === currentIdx;
      playQueue.splice(index, 1);
      if (!playQueue.length) currentIdx = -1;
      else if (removedCurrent) currentIdx = Math.min(index, playQueue.length - 1);
      else if (index < currentIdx) currentIdx--;
      result = { removedCurrent: removedCurrent, nextAction: removedCurrent ? (wasPlaying ? 'play-current' : 'load-current') : 'none' };
    }
    if (result.removedCurrent) {
      if (result.nextAction === 'play-current' && currentIdx >= 0) playQueueAt(currentIdx);
      else stopAudioForQueueChange(playQueue[currentIdx] || null);
    }
    renderQueuePanelV140({ animate: false, preserveWindow: true });
    safeShelfRebuild('remove-queue-item');
    scheduleQueueSessionSave();
    showUndoToast('已从队列移除', function () { restoreQueueRefs(before); });
  };
  window.clearQueue = function () {
    if (!playQueue.length) return;
    var before = queueSnapshotRefs();
    playQueue = [];
    currentIdx = -1;
    queueSelection.clear();
    stopAudioForQueueChange(null);
    renderQueuePanelV140({ animate: false });
    safeShelfRebuild('clear-queue');
    scheduleQueueSessionSave();
    showUndoToast('已清空队列', function () { restoreQueueRefs(before); });
  };

  var legacyNextTrack = window.nextTrack;
  window.nextTrack = function () {
    if (playMode !== 'shuffle' || playQueue.length <= 1 || (activeRadioContext && activeRadioContext.type === 'netease-personal-fm')) {
      return legacyNextTrack();
    }
    var next = currentIdx;
    while (next === currentIdx) next = Math.floor(Math.random() * playQueue.length);
    currentIdx = next;
    return Promise.resolve(playQueueAt(next)).finally(forcePlaybackControlsInteractive);
  };

  function bindQueueInteractions() {
    var list = byId('queue-list');
    if (list && !list.__v140Bound) {
      list.__v140Bound = true;
      list.addEventListener('keydown', function (event) {
        var row = event.target && event.target.closest && event.target.closest('[data-queue-index]');
        if (!row || event.target !== row) return;
        var index = finite(row.getAttribute('data-queue-index'), -1);
        if ((event.ctrlKey || event.metaKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          var target = clamp(index + (event.key === 'ArrowUp' ? -1 : 1), 0, playQueue.length - 1);
          var targetWindow = queueCore && queueCore.queueWindowStart
            ? queueCore.queueWindowStart(playQueue.length, QUEUE_RENDER_BATCH, target)
            : Math.floor(target / QUEUE_RENDER_BATCH) * QUEUE_RENDER_BATCH;
          if (moveQueueItemV140(index, target, true, { windowStart: targetWindow })) {
            var nextRow = list.querySelector('[data-queue-index="' + target + '"]');
            if (nextRow) nextRow.focus();
          }
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          playQueueAt(index);
        } else if (event.key === 'Delete') {
          event.preventDefault();
          removeFromQueue(index);
        }
      });
      list.addEventListener('dragstart', function (event) {
        var row = event.target && event.target.closest && event.target.closest('[data-queue-index]');
        if (!row) return;
        queueDragIndex = finite(row.getAttribute('data-queue-index'), -1);
        row.classList.add('queue-dragging');
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(queueDragIndex)); }
      });
      list.addEventListener('dragover', function (event) {
        var row = event.target && event.target.closest && event.target.closest('[data-queue-index]');
        if (!row || queueDragIndex < 0) return;
        event.preventDefault();
        all('.queue-item', list).forEach(function (item) { item.classList.remove('queue-drop-before', 'queue-drop-after'); });
        var rect = row.getBoundingClientRect();
        row.classList.add(event.clientY < rect.top + rect.height / 2 ? 'queue-drop-before' : 'queue-drop-after');
      });
      list.addEventListener('drop', function (event) {
        var row = event.target && event.target.closest && event.target.closest('[data-queue-index]');
        if (!row || queueDragIndex < 0) return;
        event.preventDefault();
        var to = finite(row.getAttribute('data-queue-index'), -1);
        var rect = row.getBoundingClientRect();
        if (event.clientY >= rect.top + rect.height / 2) to++;
        if (to > queueDragIndex) to--;
        moveQueueItemV140(queueDragIndex, to, true);
        queueDragIndex = -1;
      });
      list.addEventListener('dragend', function () {
        queueDragIndex = -1;
        all('.queue-item', list).forEach(function (item) { item.classList.remove('queue-dragging', 'queue-drop-before', 'queue-drop-after'); });
      });
    }
    var mini = byId('mini-queue-list');
    if (mini && !mini.__v140KeyBound) {
      mini.__v140KeyBound = true;
      mini.addEventListener('keydown', function (event) {
        var row = event.target && event.target.closest && event.target.closest('[data-mini-queue-index]');
        if (row && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          playQueueAt(finite(row.getAttribute('data-mini-queue-index'), -1));
        }
      });
    }
  }

  var podcastRate = clamp(finite(localStorage.getItem(PODCAST_RATE_KEY), 1), .5, 2.5);
  var sleepState = { mode: 'off', timer: null, endsAt: 0 };
  var legacyPlayQueueAt = window.playQueueAt;
  function syncPodcastControls() {
    var song = selectedSong() || activePlaybackSong;
    document.body.classList.toggle('podcast-playing', isPodcast(song));
    var label = byId('playback-rate-label');
    if (label) label.textContent = String(podcastRate).replace(/\.0$/, '') + '×';
    if (audio && isPodcast(song)) audio.playbackRate = podcastRate;
  }
  function installSleepEndedGuard() {
    if (!audio || audio.__v140EndedGuard === audio.onended) return;
    var originalEnded = audio.onended;
    var guarded = function (event) {
      if (sleepState.mode === 'track') {
        clearSleepTimer(true);
        playing = false;
        setPlayIcon(false);
        showToast('本首播放完毕，睡眠定时已停止播放');
        saveQueueSessionNow();
        return;
      }
      if (typeof originalEnded === 'function') return originalEnded.call(audio, event);
    };
    audio.onended = guarded;
    audio.__v140EndedGuard = guarded;
  }
  window.playQueueAt = async function (index, opts) {
    opts = Object.assign({}, opts || {});
    var target = playQueue[index];
    if (pendingResume.key && target && keyFor(target) === pendingResume.key && opts.resumeAt == null) {
      opts.resumeAt = pendingResume.seconds;
      pendingResume = { key: '', seconds: 0 };
    }
    document.body.classList.toggle('podcast-playing', isPodcast(target));
    var result = await legacyPlayQueueAt(index, opts);
    syncPodcastControls();
    installSleepEndedGuard();
    updatePlaybackPresence();
    scheduleQueueSessionSave();
    return result;
  };
  window.seekPlaybackBy = function (seconds) {
    if (!audio || !isFinite(audio.duration)) return;
    audio.currentTime = clamp((audio.currentTime || 0) + finite(seconds, 0), 0, audio.duration);
    updatePlaybackProgressUi();
    if (typeof syncBeatMapPlaybackCursor === 'function') syncBeatMapPlaybackCursor(audio.currentTime, true);
  };
  window.cyclePlaybackRate = function () {
    var rates = [1, 1.25, 1.5, 1.75, 2];
    var index = rates.indexOf(podcastRate);
    podcastRate = rates[(index + 1) % rates.length];
    try { localStorage.setItem(PODCAST_RATE_KEY, podcastRate); } catch (_) {}
    syncPodcastControls();
    showToast('播客速度 ' + podcastRate + '×');
  };
  function updateSleepButton() {
    var button = byId('sleep-timer-btn');
    if (!button) return;
    var labels = { off: '睡眠定时', track: '播完本首停止', 15: '15 分钟后停止', 30: '30 分钟后停止', 45: '45 分钟后停止', 60: '60 分钟后停止' };
    button.classList.toggle('active', sleepState.mode !== 'off');
    button.title = labels[sleepState.mode] || labels.off;
    button.setAttribute('aria-label', button.title);
  }
  function clearSleepTimer(silent) {
    if (sleepState.timer) clearTimeout(sleepState.timer);
    sleepState = { mode: 'off', timer: null, endsAt: 0 };
    updateSleepButton();
    if (!silent) showToast('睡眠定时已关闭');
  }
  window.cycleSleepTimer = function () {
    var modes = ['off', 15, 30, 45, 60, 'track'];
    var next = modes[(modes.indexOf(sleepState.mode) + 1) % modes.length];
    if (sleepState.timer) clearTimeout(sleepState.timer);
    sleepState = { mode: next, timer: null, endsAt: 0 };
    if (typeof next === 'number') {
      sleepState.endsAt = Date.now() + next * 60000;
      sleepState.timer = setTimeout(function () {
        sleepState.timer = null;
        if (audio && !audio.paused) audio.pause();
        playing = false;
        setPlayIcon(false);
        clearSleepTimer(true);
        showToast('睡眠定时已停止播放');
      }, next * 60000);
      showToast(next + ' 分钟后停止播放');
    } else if (next === 'track') showToast('将在本首播放完毕后停止');
    else showToast('睡眠定时已关闭');
    updateSleepButton();
    installSleepEndedGuard();
  };

  function updateHomeQueueCard() {
    var title = byId('home-queue-title');
    var sub = byId('home-queue-sub');
    var art = document.querySelector('.home-queue-art');
    var song = selectedSong() || playQueue[0];
    if (title) title.textContent = playQueue.length ? ('接下来播放 · ' + playQueue.length) : '接下来播放';
    if (sub) sub.textContent = song ? ((song.name || '') + (song.artist ? ' · ' + song.artist : '')) : '队列会保留到下次启动';
    if (art) {
      var cover = song && songCoverSrc(song, 260);
      art.style.backgroundImage = cover ? 'url("' + cssImageUrl(cover) + '")' : '';
      art.classList.toggle('has-cover', !!cover);
    }
  }
  window.openHomeQueue = function () {
    homeSuppressed = false;
    setHomeControlsLocked(false);
    openPlaylistPanelTab('queue', true);
    renderQueuePanelV140({ animate: true });
  };
  window.openHomeLikedMusic = async function () {
    if (!hasPlatformLogin('netease')) { openProviderLogin('netease'); return; }
    if (!userPlaylists.length) await refreshUserPlaylists(true);
    var liked = userPlaylists.find(function (playlist) {
      return playlist.provider !== 'qq' && (Number(playlist.specialType) === 5 || /喜欢的音乐|我喜欢的音乐/.test(String(playlist.name || '')));
    });
    openPlaylistPanelTab('playlists', true);
    if (liked && liked.id) openPlaylistPanelDetail('netease', liked.id, liked.name || '我喜欢的音乐');
    else showToast('没有找到网易云红心歌单');
  };

  var legacyUpdateProgressUi = window.updatePlaybackProgressUi;
  window.updatePlaybackProgressUi = function () {
    var result = legacyUpdateProgressUi.apply(this, arguments);
    var bar = byId('progress-bar');
    if (bar) {
      var duration = typeof getPlaybackDurationSeconds === 'function' ? getPlaybackDurationSeconds() : 0;
      var current = typeof getPlaybackCurrentSeconds === 'function' ? getPlaybackCurrentSeconds() : 0;
      var percent = duration > 0 ? clamp(current / duration * 100, 0, 100) : 0;
      bar.setAttribute('aria-valuenow', String(Math.round(percent)));
      bar.setAttribute('aria-valuetext', formatProgramTime(current) + ' / ' + formatProgramTime(duration));
      bar.setAttribute('aria-disabled', duration > 0 ? 'false' : 'true');
    }
    return result;
  };
  function bindProgressKeyboard() {
    var bar = byId('progress-bar');
    if (!bar || bar.__v140KeyBound) return;
    bar.__v140KeyBound = true;
    bar.addEventListener('keydown', function (event) {
      var duration = getPlaybackDurationSeconds();
      if (!audio || !duration) return;
      var target = audio.currentTime || 0;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target -= event.shiftKey ? 15 : 5;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target += event.shiftKey ? 15 : 5;
      else if (event.key === 'PageDown') target -= duration * .1;
      else if (event.key === 'PageUp') target += duration * .1;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = duration;
      else return;
      event.preventDefault();
      event.stopPropagation();
      audio.currentTime = clamp(target, 0, duration);
      updatePlaybackProgressUi();
    }, true);
  }

  decorateQueueToolbar();
  bindQueueInteractions();
  bindProgressKeyboard();
  updateSleepButton();
  restoreQueueSession();
  updatePlaybackPresence();
  window.addEventListener('beforeunload', saveQueueSessionNow);
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveQueueSessionNow(); });
  setInterval(function () { if (playQueue.length) saveQueueSessionNow(); }, 5000);
})();

(function () {
  'use strict';

  var core = window.MineradioCore || {};
  var lyricCore = core.lyrics || null;
  var versionCore = core.version || null;
  var REDUCED_MOTION_KEY = 'mineradio-reduced-motion-v1';
  var LYRIC_DISPLAY_KEY = 'mineradio-lyric-display-v1';

  function byId(id) { return document.getElementById(id); }
  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function finite(value, fallback) { value = Number(value); return isFinite(value) ? value : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function postJson(url, data) {
    return apiJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
  }
  function messageFor(error, fallback) {
    if (error && error.kind === 'offline') return '当前处于离线状态';
    if (error && error.kind === 'timeout') return '请求超时，请稍后重试';
    if (error && error.kind === 'auth_required') return '登录状态已失效';
    return (error && error.message) || fallback || '操作失败';
  }

  // Settings reuses the already-bound performance controls so there is only
  // one source of truth for renderer and background policy preferences.
  function moveSettingsControls() {
    var backgroundHost = byId('settings-performance-background');
    var qualityHost = byId('settings-performance-quality');
    var liveHost = byId('settings-live-background');
    var background = byId('performance-background-seg');
    var quality = byId('performance-quality-seg');
    var live = byId('t-liveBackgroundKeep');
    if (backgroundHost && background && background.parentNode !== backgroundHost) {
      backgroundHost.innerHTML = '<div class="settings-inline-label">后台运行策略</div>';
      backgroundHost.appendChild(background);
    }
    if (qualityHost && quality && quality.parentNode !== qualityHost) {
      qualityHost.innerHTML = '<div class="settings-inline-label">画质档位</div>';
      qualityHost.appendChild(quality);
    }
    if (liveHost && live && live.parentNode !== liveHost) {
      liveHost.innerHTML = '<div class="settings-inline-label">直播模式</div>';
      liveHost.appendChild(live);
    }
  }
  function readReducedMotion() {
    try {
      var raw = localStorage.getItem(REDUCED_MOTION_KEY);
      if (raw != null) return raw === '1';
    } catch (_) {}
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function setReducedMotion(enabled, persist) {
    document.documentElement.classList.toggle('reduce-motion', !!enabled);
    if (persist !== false) {
      try { localStorage.setItem(REDUCED_MOTION_KEY, enabled ? '1' : '0'); } catch (_) {}
    }
    var checkbox = byId('settings-reduced-motion');
    if (checkbox) checkbox.checked = !!enabled;
  }
  function updateSettingsVersion() {
    var node = byId('settings-version');
    if (!node) return;
    var current = updatePreviewState && updatePreviewState.currentVersion || '1.5.1';
    node.textContent = 'Mineradio v' + current + (updatePreviewState && updatePreviewState.checkStatus === 'available' ? (' · 可更新至 v' + updatePreviewState.version) : '');
  }
  function activateSettingsTab(name, focus) {
    var tabs = all('[data-settings-tab]');
    var pages = all('[data-settings-page]');
    tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-settings-tab') === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    pages.forEach(function (page) { page.classList.toggle('active', page.getAttribute('data-settings-page') === name); });
  }
  function syncSettingsFields() {
    moveSettingsControls();
    var autoHide = byId('settings-controls-autohide');
    var reduced = byId('settings-reduced-motion');
    var quality = byId('settings-quality');
    if (autoHide) autoHide.checked = !!controlsAutoHide;
    if (reduced) reduced.checked = document.documentElement.classList.contains('reduce-motion');
    if (quality) quality.value = normalizePlaybackQuality(playbackQuality);
    updateSettingsVersion();
    if (typeof updatePerformanceControls === 'function') updatePerformanceControls();
  }
  window.openSettingsModal = function () {
    if (typeof immersiveMode !== 'undefined' && immersiveMode && typeof setImmersiveMode === 'function') setImmersiveMode(false);
    syncSettingsFields();
    activateSettingsTab('playback', false);
    openGsapModal(byId('settings-modal'));
  };
  window.closeSettingsModal = function () { closeGsapModal(byId('settings-modal')); };
  window.openHotkeySettingsFromSettings = function () {
    closeSettingsModal();
    setTimeout(function () { if (typeof openHotkeySettings === 'function') openHotkeySettings(); }, 180);
  };
  window.checkForUpdatesFromSettings = async function () {
    var button = document.querySelector('[onclick="checkForUpdatesFromSettings()"]');
    if (button) { button.disabled = true; button.textContent = '正在检查…'; }
    try {
      await checkLatestUpdate();
      updateSettingsVersion();
      if (updatePreviewState.updateAvailable) {
        closeSettingsModal();
        setTimeout(openUpdatePanel, 180);
      } else if (updatePreviewState.checkStatus === 'error') showToast('检查更新失败');
      else showToast('当前已是最新版本');
    } finally {
      if (button) { button.disabled = false; button.textContent = '检查更新'; }
    }
  };
  function bindSettings() {
    all('[data-settings-tab]').forEach(function (tab, index, tabs) {
      tab.addEventListener('click', function () { activateSettingsTab(tab.getAttribute('data-settings-tab'), false); });
      tab.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        var delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        var next = (index + delta + tabs.length) % tabs.length;
        activateSettingsTab(tabs[next].getAttribute('data-settings-tab'), true);
      });
    });
    var autoHide = byId('settings-controls-autohide');
    if (autoHide) autoHide.addEventListener('change', function () {
      if (!!autoHide.checked !== !!controlsAutoHide) toggleControlsAutoHide();
    });
    var reduced = byId('settings-reduced-motion');
    if (reduced) reduced.addEventListener('change', function () { setReducedMotion(reduced.checked, true); });
    var quality = byId('settings-quality');
    if (quality) quality.addEventListener('change', function () {
      setPlaybackQuality(quality.value);
      setTimeout(function () { quality.value = normalizePlaybackQuality(playbackQuality); }, 0);
    });
  }

  var legacySetPerformanceBackgroundMode = window.setPerformanceBackgroundMode;
  window.setPerformanceBackgroundMode = function (mode, silent) {
    var result = legacySetPerformanceBackgroundMode(mode, silent);
    var api = window.desktopWindow;
    if (api && typeof api.setBackgroundPolicy === 'function') {
      Promise.resolve(api.setBackgroundPolicy(normalizePerformanceBackgroundMode(mode, false))).catch(function (error) {
        console.warn('[BackgroundPolicy]', error);
      });
    }
    return result;
  };
  function syncDesktopBackgroundPolicy() {
    var api = window.desktopWindow;
    if (!api || typeof api.getBackgroundPolicy !== 'function') return;
    Promise.resolve(api.getBackgroundPolicy()).then(function (result) {
      var mode = result && (result.mode || result.policy || result);
      if (mode === 'auto' || mode === 'keep' || mode === 'release') setPerformanceBackgroundMode(mode, true);
    }).catch(function () {});
  }

  // Modal focus is managed centrally, including dynamically-created dialogs.
  var legacyOpenModal = window.openGsapModal;
  var legacyCloseModal = window.closeGsapModal;
  var modalOpeners = new WeakMap();
  function focusableIn(mask) {
    return all('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', mask)
      .filter(function (node) { return node.offsetParent !== null && node.getAttribute('aria-hidden') !== 'true'; });
  }
  window.openGsapModal = function (mask) {
    if (!mask) return;
    modalOpeners.set(mask, document.activeElement);
    mask.setAttribute('aria-hidden', 'false');
    legacyOpenModal(mask);
    requestAnimationFrame(function () {
      var focusable = focusableIn(mask);
      var target = focusable[0] || mask.querySelector('.modal');
      if (target) {
        if (!target.hasAttribute('tabindex') && !/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(target.tagName)) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    });
  };
  window.closeGsapModal = function (mask, afterClose) {
    if (!mask) { if (afterClose) afterClose(); return; }
    legacyCloseModal(mask, function () {
      mask.setAttribute('aria-hidden', 'true');
      var opener = modalOpeners.get(mask);
      modalOpeners.delete(mask);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
      if (afterClose) afterClose();
    });
  };
  function visibleModal() {
    var visible = all('.modal-mask.show');
    return visible.length ? visible[visible.length - 1] : null;
  }
  function closeNamedModal(mask) {
    if (!mask) return;
    var closers = {
      'settings-modal': window.closeSettingsModal,
      'album-detail-modal': window.closeAlbumDetail,
      'update-modal': window.closeUpdatePanel,
      'track-detail-modal': window.closeTrackDetailModal,
      'login-modal': window.closeLoginModal,
      'user-modal': window.closeUserModal,
      'cover-crop-modal': window.closeCoverCropModal,
      'collect-modal': window.closeCollectModal,
      'local-beat-modal': function () {
        if (typeof localBeatAnalysis !== 'undefined' && localBeatAnalysis.active && typeof cancelLocalBeatAnalysis === 'function') cancelLocalBeatAnalysis();
        else if (typeof closeLocalBeatModal === 'function') closeLocalBeatModal();
      },
      'custom-lyric-modal': window.closeCustomLyricModal,
      'daily-recommend-modal': window.closeDailyRecommendDetail
    };
    var close = closers[mask.id];
    if (typeof close === 'function') close(); else closeGsapModal(mask);
  }
  document.addEventListener('keydown', function (event) {
    var mask = visibleModal();
    if (!mask) return;
    if (event.key === 'Tab') {
      var focusable = focusableIn(mask);
      if (!focusable.length) { event.preventDefault(); return; }
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeNamedModal(mask);
    }
  }, true);
  ['settings-modal', 'album-detail-modal'].forEach(function (id) {
    var mask = byId(id);
    if (!mask) return;
    mask.setAttribute('aria-hidden', mask.classList.contains('show') ? 'false' : 'true');
    mask.addEventListener('click', function (event) { if (event.target === mask) closeNamedModal(mask); });
  });

  // Display modes add a secondary line without changing the timed lyric data.
  var lyricDisplayMode = (function () {
    try {
      var saved = localStorage.getItem(LYRIC_DISPLAY_KEY);
      return saved === 'bilingual' || saved === 'romanization' ? saved : 'original';
    } catch (_) { return 'original'; }
  })();
  var legacyApplyOriginalLyricsState = window.applyOriginalLyricsState;
  function lyricDisplayPartsForLine(line) {
    if (lyricCore && lyricCore.lyricDisplayParts) {
      return lyricCore.lyricDisplayParts(line, lyricDisplayMode, { sourceMode: lyricSourceMode });
    }
    line = line || {};
    var primary = String(line.originalText || line.text || '').replace(/\s+/g, ' ').trim();
    var secondary = '';
    if (lyricSourceMode !== 'custom') {
      if (lyricDisplayMode === 'bilingual') secondary = String(line.translation || '').replace(/\s+/g, ' ').trim();
      else if (lyricDisplayMode === 'romanization') secondary = String(line.romanization || '').replace(/\s+/g, ' ').trim();
    }
    return { primary: primary, secondary: secondary };
  }
  window.getLyricDisplayParts = lyricDisplayPartsForLine;
  window.getLyricDisplayText = function (line) {
    var parts = lyricDisplayPartsForLine(line);
    return parts.secondary ? parts.primary + '\n' + parts.secondary : parts.primary;
  };
  function updateLyricDisplayButton() {
    var button = byId('lyric-display-mode-btn');
    if (!button) return;
    var labels = { original: '原文', bilingual: '双语', romanization: '罗马音' };
    var short = { original: '原', bilingual: '译', romanization: '音' };
    button.title = '歌词显示：' + labels[lyricDisplayMode];
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', lyricDisplayMode === 'original' ? 'false' : 'true');
    var icon = button.querySelector('.lyrics-word-icon');
    if (icon) icon.textContent = short[lyricDisplayMode];
  }
  window.applyOriginalLyricsState = function () {
    lyricSourceMode = 'original';
    applyLyricsState(originalLyricsState.lines, originalLyricsState.hasNativeKaraoke, originalLyricsState.timingSource);
  };
  window.cycleLyricDisplayMode = function () {
    var modes = ['original', 'bilingual', 'romanization'];
    var next = modes[(modes.indexOf(lyricDisplayMode) + 1) % modes.length];
    if (next === 'bilingual' && !(originalLyricsState.lines || []).some(function (line) { return line.translation; })) next = 'romanization';
    if (next === 'romanization' && !(originalLyricsState.lines || []).some(function (line) { return line.romanization; })) next = 'original';
    lyricDisplayMode = next;
    try { localStorage.setItem(LYRIC_DISPLAY_KEY, lyricDisplayMode); } catch (_) {}
    updateLyricDisplayButton();
    if (lyricSourceMode === 'custom') showToast('自定义歌词仅显示原文');
    else applyOriginalLyricsState();
  };
  window.fetchLyric = async function (songOrId, token) {
    try {
      var song = songOrId && typeof songOrId === 'object' ? songOrId : null;
      var provider = songProviderKey(song);
      var endpoint;
      if (provider === 'qq') {
        var mid = song.mid || song.songmid || song.id || '';
        var qqId = song.qqId || (/^\d+$/.test(String(song.id || '')) ? song.id : '');
        endpoint = '/api/qq/lyric?mid=' + encodeURIComponent(mid) + '&id=' + encodeURIComponent(qqId);
      } else {
        endpoint = '/api/lyric?id=' + encodeURIComponent(song ? song.id : songOrId);
      }
      var data = await apiJson(endpoint);
      if (token !== trackSwitchToken) return;
      var native = parseYrcText(data.yrc || '');
      if (!native.length && data.qrc) {
        native = lyricCore && lyricCore.parseQrc ? lyricCore.parseQrc(data.qrc) : [];
      }
      var lrc = parseLyricText(data.lyric || '');
      var primary = native.length ? native : lrc;
      if (lyricCore && lyricCore.alignTranslatedLyrics) {
        var translated = lyricCore.alignTranslatedLyrics(primary, lyricCore.parseLrc(data.tlyric || ''), { toleranceSeconds: .85 });
        var romanized = lyricCore.alignTranslatedLyrics(primary, lyricCore.parseLrc(data.roma || ''), { toleranceSeconds: .85, omitDuplicateText: false });
        primary = primary.map(function (line, index) {
          var copy = cloneLyricLine(line);
          copy.originalText = copy.text;
          copy.translation = translated[index] && translated[index].translation || '';
          copy.romanization = romanized[index] && romanized[index].translation || '';
          return copy;
        });
      }
      var nativeKaraoke = native.some(function (line) { return line.words && line.words.length; });
      var nativeSource = native[0] && native[0].source || '';
      var timing = nativeKaraoke
        ? (nativeSource.indexOf('qrc') === 0 ? 'qrc-word' : 'yrc-word')
        : (native.length ? (nativeSource.indexOf('qrc') === 0 ? 'qrc-line' : 'yrc-line') : (lrc.length ? 'lrc-line' : 'fallback'));
      var lines = withLyricFallback(primary);
      if (lines.length && lines[0].fallback) timing = 'fallback';
      setOriginalLyricsState(lines, nativeKaraoke, timing);
      applyPreferredLyricsForCurrent(true);
      updateLyricDisplayButton();
    } catch (error) {
      if (token !== trackSwitchToken) return;
      var fallback = withLyricFallback([]);
      setOriginalLyricsState(fallback, false, 'fallback');
      applyPreferredLyricsForCurrent(true);
    }
  };

  // Artist detail keeps hot songs and adds the artist's album catalog beneath it.
  var artistAlbumList = [];
  var legacyOpenTrackDetailModal = window.openTrackDetailModal;
  window.openTrackDetailModal = function (type, songOverride) {
    var song = songOverride || (typeof currentCoverSong === 'function' ? currentCoverSong() : null);
    var result = legacyOpenTrackDetailModal(type, songOverride);
    if (type !== 'artist' || !song || songProviderKey(song) !== 'netease') return result;
    var artistId = currentArtistId(song);
    var body = byId('track-detail-body');
    if (!artistId || !body) return result;
    var seq = trackDetailSeq;
    var section = document.createElement('div');
    section.className = 'detail-section';
    section.innerHTML = '<div class="detail-section-head"><div class="detail-section-title">专辑</div></div><div id="artist-album-list"><div class="detail-loading">正在载入专辑…</div></div>';
    body.appendChild(section);
    apiJson('/api/artist/albums?id=' + encodeURIComponent(artistId) + '&limit=18&offset=0').then(function (data) {
      if (seq !== trackDetailSeq) return;
      artistAlbumList = data.albums || [];
      var target = byId('artist-album-list');
      if (!target) return;
      if (!artistAlbumList.length) { target.innerHTML = '<div class="detail-empty">暂无专辑</div>'; return; }
      target.innerHTML = '<div class="artist-album-grid">' + artistAlbumList.map(function (album, index) {
        var cover = album.cover ? coverUrlWithSize(album.cover, 180) : '';
        return '<button class="artist-album-card" type="button" onclick="openArtistAlbumDetail(' + index + ')">' +
          (cover ? '<img src="' + escHtml(cover) + '" alt="" loading="lazy">' : '') +
          '<b>' + escHtml(album.name || '') + '</b><small>' + escHtml([albumDateLabel(album.publishTime), album.songCount ? album.songCount + ' 首' : ''].filter(Boolean).join(' · ')) + '</small></button>';
      }).join('') + '</div>';
      bindTrackDetailScrollers();
    }).catch(function () {
      var target = byId('artist-album-list');
      if (seq === trackDetailSeq && target) target.innerHTML = '<div class="detail-empty">专辑加载失败</div>';
    });
    return result;
  };
  function albumDateLabel(ms) {
    if (!ms) return '';
    try { return new Date(ms).getFullYear() + ' 年'; } catch (_) { return ''; }
  }
  window.openArtistAlbumDetail = function (index) {
    var album = artistAlbumList[index];
    if (!album) return;
    closeTrackDetailModal();
    setTimeout(function () { openAlbumDetail(album); }, 170);
  };

  // Update status exposes only the three fields users need and supports real cancellation.
  var legacyApplyLatestUpdateInfo = window.applyLatestUpdateInfo;
  window.applyLatestUpdateInfo = function (data) {
    data = data || {};
    legacyApplyLatestUpdateInfo(data);
    if (versionCore && versionCore.isUpdateAvailable) {
      updatePreviewState.updateAvailable = !!data.updateAvailable && versionCore.isUpdateAvailable(updatePreviewState.version, updatePreviewState.currentVersion);
      if (!updatePreviewState.updateAvailable && updatePreviewState.checkStatus === 'available') updatePreviewState.checkStatus = 'current';
      setUpdatePreviewVisible(updatePreviewState.updateAvailable && updatePreviewState.checkStatus === 'available');
    }
    updateSettingsVersion();
  };
  function updateDownloadStatusFields() {
    var route = byId('update-route-status');
    var speed = byId('update-speed-status');
    var eta = byId('update-eta-status');
    var cancel = byId('update-cancel-btn');
    var downloading = updatePreviewState.status === 'downloading';
    var cancellable = downloading && updatePreviewState.mode === 'installer';
    if (route) route.textContent = updatePreviewState.sourceLabel || (updatePreviewState.attempts > 1 ? ('线路 ' + updatePreviewState.attempt + '/' + updatePreviewState.attempts) : (downloading ? '正在连接' : '等待下载'));
    if (speed) speed.textContent = updatePreviewState.speedBps > 0 ? formatUpdateSpeed(updatePreviewState.speedBps) : '--';
    if (eta) {
      var seconds = finite(updatePreviewState.etaSeconds, 0);
      eta.textContent = seconds > 0 ? (seconds >= 60 ? (Math.ceil(seconds / 60) + ' 分钟') : (Math.ceil(seconds) + ' 秒')) : '--';
    }
    if (cancel) {
      cancel.textContent = cancellable ? (updatePreviewState.cancelRequested ? '正在取消…' : '取消下载') : '关闭窗口';
      cancel.disabled = !!(cancellable && updatePreviewState.cancelRequested && !updatePreviewState.downloadJobId);
    }
  }
  var legacySyncUpdateClass = window.syncUpdatePreviewStateClass;
  window.syncUpdatePreviewStateClass = function () {
    var result = legacySyncUpdateClass.apply(this, arguments);
    updateDownloadStatusFields();
    return result;
  };
  var legacyApplyUpdateJob = window.applyUpdateDownloadJob;
  window.applyUpdateDownloadJob = function (job) {
    if (job && job.status === 'cancelled') {
      if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
      updatePreviewState.pollTimer = null;
      updatePreviewState.status = 'cancelled';
      updatePreviewState.downloadJobStatus = 'cancelled';
      updatePreviewState.message = job.message || '下载已取消';
      updatePreviewState.speedBps = 0;
      updatePreviewState.etaSeconds = 0;
      updatePreviewState.downloadJobId = '';
      updatePreviewState.cancelRequested = false;
      updateUpdatePreviewProgress(0);
      updateDownloadStatusFields();
      return;
    }
    var result = legacyApplyUpdateJob(job);
    if (updatePreviewState.status !== 'downloading') updatePreviewState.cancelRequested = false;
    updateDownloadStatusFields();
    return result;
  };
  window.cancelOrCloseUpdateDownload = async function () {
    if (updatePreviewState.status !== 'downloading' || updatePreviewState.mode !== 'installer') {
      closeUpdatePanel();
      return;
    }
    if (!updatePreviewState.downloadJobId) {
      updatePreviewState.cancelRequested = true;
      updatePreviewState.message = '正在等待下载任务取消';
      syncUpdatePreviewStateClass();
      updateDownloadStatusFields();
      return;
    }
    var id = updatePreviewState.downloadJobId;
    var button = byId('update-cancel-btn');
    if (button) { button.disabled = true; button.textContent = '正在取消…'; }
    try {
      var job;
      try { job = await postJson('/api/update/download/cancel', { id: id }); }
      catch (httpError) {
        if (!window.desktopWindow || typeof window.desktopWindow.cancelUpdateDownload !== 'function') throw httpError;
        job = await window.desktopWindow.cancelUpdateDownload(id);
      }
      if (!job || job.ok === false) throw new Error((job && job.error) || 'UPDATE_CANCEL_FAILED');
      applyUpdateDownloadJob(job.job || job);
      showToast('更新下载已取消');
    } catch (error) {
      showToast(messageFor(error, '取消下载失败'));
    } finally {
      if (button) button.disabled = false;
      updateDownloadStatusFields();
    }
  };

  setReducedMotion(readReducedMotion(), false);
  bindSettings();
  syncDesktopBackgroundPolicy();
  updateLyricDisplayButton();
  updateDownloadStatusFields();
})();

(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }
  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function finite(value, fallback) { value = Number(value); return isFinite(value) ? value : fallback; }
  function postJson(url, data) {
    return apiJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
  }
  function errorText(error, fallback) {
    if (error && error.kind === 'offline') return '当前处于离线状态';
    if (error && error.kind === 'timeout') return '请求超时，请稍后重试';
    if (error && error.kind === 'auth_required') return '登录状态已失效';
    return (error && error.message) || fallback || '操作失败';
  }

  function reportPlaylistMutationError(error, fallback) {
    if (error && error.authRequired) {
      if (window.desktopWindow && typeof window.desktopWindow.invalidateNeteaseMusicLogin === 'function') {
        Promise.resolve(window.desktopWindow.invalidateNeteaseMusicLogin()).catch(function () {});
      }
      if (typeof refreshLoginStatus === 'function') {
        Promise.resolve(refreshLoginStatus(true)).catch(function () {});
      }
    }
    showToast(errorText(error, fallback));
  }

  var legacyClearSearchResults = window.clearSearchResults;
  window.clearSearchResults = function () {
    var state = window.__mineradioV140Search;
    if (state) { state.requestSeq++; state.loading = false; state.query = ''; state.lastError = null; }
    return legacyClearSearchResults.apply(this, arguments);
  };
  var legacyUpdateSearchModeTabs = window.updateSearchModeTabs;
  window.updateSearchModeTabs = function () {
    var result = legacyUpdateSearchModeTabs.apply(this, arguments);
    var panel = byId('search-results');
    if (panel) panel.setAttribute('aria-labelledby', 'search-mode-' + (searchMode === 'podcast' ? 'podcast' : (searchMode === 'qq' ? 'qq' : (searchMode === 'netease' ? 'netease' : 'song'))));
    return result;
  };
  updateSearchModeTabs();

  function ownerPlaylistContext() {
    var state = playlistPanelDetailState;
    if (!state || !state.key || state.key.indexOf('netease:') !== 0 || !state.playlist) return null;
    var playlist = state.playlist;
    if (playlist.subscribed || Number(playlist.specialType || 0) !== 0) return null;
    return {
      state: state,
      playlist: playlist,
      id: state.key.slice('netease:'.length),
      tracks: state.tracks || []
    };
  }
  function decoratePlaylistOwnerControls() {
    var context = ownerPlaylistContext();
    var detail = byId('pl-list') && byId('pl-list').querySelector('.pl-inline-detail');
    if (!context || !detail) return;
    var actions = detail.querySelector('.pl-detail-actions');
    if (actions && !actions.querySelector('[data-v140-pl-action]')) {
      actions.insertAdjacentHTML('beforeend',
        '<button class="pl-owner-action" type="button" data-v140-pl-action="rename">重命名</button>' +
        '<button class="pl-owner-action danger" type="button" data-v140-pl-action="delete">删除歌单</button>');
    }
    var canReorder = context.tracks.length > 1 && context.tracks.every(function (song) { return song && /^\d+$/.test(String(song.id || '')); });
    all('.pl-detail-row[data-pl-detail-row]', detail).forEach(function (row) {
      var index = finite(row.getAttribute('data-pl-detail-row'), -1);
      var song = context.tracks[index];
      if (!song) return;
      row.draggable = canReorder;
      row.setAttribute('aria-label', (song.name || '歌曲') + (canReorder ? '，可拖动排序' : ''));
      if (!row.querySelector('[data-v140-pl-remove]')) {
        var manage = document.createElement('div');
        manage.className = 'queue-row-manage';
        if (canReorder) manage.innerHTML = '<button class="pl-track-manage" type="button" tabindex="-1" aria-hidden="true" title="拖动歌曲行排序">⋮</button>';
        manage.insertAdjacentHTML('beforeend', '<button class="pl-track-manage danger" type="button" data-v140-pl-remove="' + index + '" aria-label="从歌单移除 ' + escHtml(song.name || '歌曲') + '">移除</button>');
        row.appendChild(manage);
      }
    });
  }
  var legacyRenderUserPlaylistsList = window.renderUserPlaylistsList;
  window.renderUserPlaylistsList = function () {
    var result = legacyRenderUserPlaylistsList.apply(this, arguments);
    requestAnimationFrame(decoratePlaylistOwnerControls);
    return result;
  };

  async function renameOwnerPlaylist(context) {
    var next = window.prompt('新的歌单名称', context.playlist.name || '');
    if (!next || !next.trim() || next.trim() === context.playlist.name) return;
    try {
      var result = await postJson('/api/playlist/rename', { pid: context.id, name: next.trim() });
      if (!result || result.ok === false) throw new Error((result && result.error) || 'PLAYLIST_RENAME_FAILED');
      context.playlist.name = next.trim();
      var cached = userPlaylists.find(function (playlist) { return String(playlist.id) === String(context.id) && playlist.provider !== 'qq'; });
      if (cached) cached.name = next.trim();
      renderPlaylistPanelDetailState();
      showToast('歌单已重命名');
    } catch (error) { reportPlaylistMutationError(error, '重命名失败'); }
  }
  async function deleteOwnerPlaylist(context) {
    if (!window.confirm('确定删除歌单“' + (context.playlist.name || '') + '”吗？此操作会同步到网易云。')) return;
    try {
      var result = await postJson('/api/playlist/delete', { pid: context.id });
      if (!result || result.ok === false || result.deleted === false) throw new Error((result && result.error) || 'PLAYLIST_DELETE_FAILED');
      playlistPanelDetailState = { key: '', loading: false, playlist: null, tracks: [], token: playlistPanelDetailState.token + 1, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER };
      userPlaylists = userPlaylists.filter(function (playlist) { return !(playlist.provider !== 'qq' && String(playlist.id) === String(context.id)); });
      renderUserPlaylistsList({ animate: true, reset: true });
      safeShelfRebuild('playlist-delete', true);
      showToast('歌单已删除');
      refreshUserPlaylists(true);
    } catch (error) { reportPlaylistMutationError(error, '删除歌单失败'); }
  }
  async function removeOwnerPlaylistTrack(context, index) {
    var song = context.tracks[index];
    if (!song || !/^\d+$/.test(String(song.id || ''))) return;
    try {
      var result = await postJson('/api/playlist/remove-song', { pid: context.id, ids: [String(song.id)] });
      if (!result || result.ok === false) throw new Error((result && result.error) || 'PLAYLIST_REMOVE_SONG_FAILED');
      context.tracks.splice(index, 1);
      context.playlist.trackCount = Math.max(0, finite(result.trackCount, context.tracks.length));
      playlistPanelDetailState.renderLimit = Math.min(context.tracks.length, Math.max(PLAYLIST_DETAIL_INITIAL_RENDER, playlistPanelDetailState.renderLimit || 0));
      renderPlaylistPanelDetailState();
      safeShelfRebuild('playlist-remove-track', true);
      showToast('已从歌单移除: ' + (song.name || '歌曲'));
    } catch (error) { reportPlaylistMutationError(error, '移除歌曲失败'); }
  }
  async function persistPlaylistOrder(context, previous) {
    var ids = context.tracks.map(function (song) { return String(song.id); });
    try {
      var result = await postJson('/api/playlist/reorder-tracks', { pid: context.id, ids: ids });
      if (!result || result.ok === false) throw new Error((result && result.error) || 'PLAYLIST_REORDER_FAILED');
      showToast('歌单顺序已同步');
      safeShelfRebuild('playlist-reorder', true);
    } catch (error) {
      context.state.tracks = previous;
      renderPlaylistPanelDetailState();
      reportPlaylistMutationError(error, '歌单排序同步失败');
    }
  }

  var playlistDragIndex = -1;
  var playlistDragSnapshot = null;
  function bindPlaylistManagement() {
    var list = byId('pl-list');
    if (!list || list.__v140OwnerBound) return;
    list.__v140OwnerBound = true;
    list.addEventListener('click', function (event) {
      var action = event.target && event.target.closest && event.target.closest('[data-v140-pl-action]');
      var remove = event.target && event.target.closest && event.target.closest('[data-v140-pl-remove]');
      var handle = event.target && event.target.closest && event.target.closest('.pl-track-manage');
      if (!action && !remove && !handle) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      var context = ownerPlaylistContext();
      if (!context) return;
      if (remove) removeOwnerPlaylistTrack(context, finite(remove.getAttribute('data-v140-pl-remove'), -1));
      else if (action && action.getAttribute('data-v140-pl-action') === 'rename') renameOwnerPlaylist(context);
      else if (action && action.getAttribute('data-v140-pl-action') === 'delete') deleteOwnerPlaylist(context);
    }, true);
    list.addEventListener('dragstart', function (event) {
      var context = ownerPlaylistContext();
      var row = event.target && event.target.closest && event.target.closest('.pl-detail-row[data-pl-detail-row]');
      if (!context || !row || !row.draggable) return;
      playlistDragIndex = finite(row.getAttribute('data-pl-detail-row'), -1);
      playlistDragSnapshot = context.tracks.slice();
      row.classList.add('pl-track-dragging');
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(playlistDragIndex)); }
    });
    list.addEventListener('dragover', function (event) {
      var row = event.target && event.target.closest && event.target.closest('.pl-detail-row[data-pl-detail-row]');
      if (!row || playlistDragIndex < 0) return;
      event.preventDefault();
      all('.pl-detail-row', list).forEach(function (item) { item.classList.remove('pl-track-drop'); });
      row.classList.add('pl-track-drop');
    });
    list.addEventListener('drop', function (event) {
      var context = ownerPlaylistContext();
      var row = event.target && event.target.closest && event.target.closest('.pl-detail-row[data-pl-detail-row]');
      if (!context || !row || playlistDragIndex < 0) return;
      event.preventDefault();
      var target = finite(row.getAttribute('data-pl-detail-row'), -1);
      if (target < 0 || target === playlistDragIndex) return;
      var item = context.tracks.splice(playlistDragIndex, 1)[0];
      context.tracks.splice(target, 0, item);
      playlistPanelDetailState.tracks = context.tracks;
      renderPlaylistPanelDetailState();
      persistPlaylistOrder(context, playlistDragSnapshot || []);
      playlistDragIndex = -1;
      playlistDragSnapshot = null;
    });
    list.addEventListener('dragend', function () {
      playlistDragIndex = -1;
      playlistDragSnapshot = null;
      all('.pl-detail-row', list).forEach(function (item) { item.classList.remove('pl-track-dragging', 'pl-track-drop'); });
    });
  }

  bindPlaylistManagement();
  requestAnimationFrame(decoratePlaylistOwnerControls);
})();
