(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.neteaseExperience = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function finite(value, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? value : fallback;
  }

  function positiveInteger(value, fallback) {
    value = Math.floor(finite(value, fallback));
    return value > 0 ? value : fallback;
  }

  function itemIdentity(item) {
    item = item || {};
    var provider = String(item.provider || item.source || 'netease').toLowerCase();
    var id = item.id || item.songId || item.albumId || item.artistId || item.playlistId || item.mid;
    if (id !== undefined && id !== null && String(id)) return provider + ':' + String(id);
    var name = String(item.name || item.title || '').trim().toLowerCase();
    var artist = String(item.artist || item.creator || '').trim().toLowerCase();
    return name ? provider + ':text:' + name + '|' + artist : '';
  }

  function mergeUnique(existing, incoming, keyFn) {
    var identify = typeof keyFn === 'function' ? keyFn : itemIdentity;
    var seen = Object.create(null);
    var merged = [];
    (existing || []).concat(incoming || []).forEach(function (item, index) {
      if (!item) return;
      var key = identify(item, index);
      if (!key) key = '__unkeyed__:' + index + ':' + merged.length;
      if (seen[key]) return;
      seen[key] = true;
      merged.push(item);
    });
    return merged;
  }

  function pageItems(payload, keys) {
    payload = payload || {};
    keys = Array.isArray(keys) && keys.length
      ? keys
      : ['items', 'songs', 'tracks', 'artists', 'albums', 'playlists', 'toplists', 'results'];
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    }
    if (payload.result && typeof payload.result === 'object') {
      for (var j = 0; j < keys.length; j++) {
        if (Array.isArray(payload.result[keys[j]])) return payload.result[keys[j]];
      }
    }
    return [];
  }

  function shouldInvalidateSession(payload, currentlyLoggedIn) {
    return !!currentlyLoggedIn && !!payload && (payload.authExpired === true || payload.loggedIn === false);
  }

  function pageTotal(payload, fallback) {
    payload = payload || {};
    var candidates = [
      payload.total,
      payload.trackCount,
      payload.count,
      payload.result && payload.result.total,
      payload.playlist && payload.playlist.trackCount,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var value = finite(candidates[i], -1);
      if (value >= 0) return Math.floor(value);
    }
    return Math.max(0, Math.floor(finite(fallback, 0)));
  }

  function pageHasMore(payload, nextOffset, total, rawCount, limit) {
    payload = payload || {};
    var responseOffset = Math.max(0, Math.floor(finite(payload.offset, 0)));
    var cursorAdvanced = nextOffset > responseOffset;
    if (typeof payload.hasMore === 'boolean') return payload.hasMore && (rawCount > 0 || cursorAdvanced);
    if (typeof payload.more === 'boolean') return payload.more && (rawCount > 0 || cursorAdvanced);
    if (payload.result && typeof payload.result.hasMore === 'boolean') {
      return payload.result.hasMore && (rawCount > 0 || cursorAdvanced);
    }
    if (total > 0) return rawCount > 0 && nextOffset < total;
    return rawCount >= limit;
  }

  async function collectPaged(fetchPage, options) {
    if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
    options = options || {};
    var limit = positiveInteger(options.limit, 100);
    var maxItems = positiveInteger(options.maxItems, 5000);
    var maxPages = positiveInteger(options.maxPages, 100);
    var offset = Math.max(0, Math.floor(finite(options.offset, 0)));
    var total = Math.max(0, Math.floor(finite(options.total, 0)));
    var identify = typeof options.key === 'function' ? options.key : itemIdentity;
    var items = mergeUnique([], options.initialItems || [], identify);
    var pages = 0;
    var hasMore = options.hasMore !== false;
    var truncated = false;

    while (hasMore && pages < maxPages && items.length < maxItems) {
      var requestOffset = offset;
      var payload;
      try {
        payload = await fetchPage({ offset: requestOffset, limit: limit, page: pages });
      } catch (error) {
        error.partialResult = {
          items: items.slice(),
          total: total,
          pages: pages,
          nextOffset: offset,
          complete: false,
          truncated: false,
        };
        throw error;
      }

      var rawItems = typeof options.getItems === 'function'
        ? options.getItems(payload)
        : pageItems(payload, options.keys);
      rawItems = Array.isArray(rawItems) ? rawItems : [];
      items = mergeUnique(items, rawItems, identify);
      total = typeof options.getTotal === 'function'
        ? Math.max(total, Math.floor(finite(options.getTotal(payload), 0)))
        : Math.max(total, pageTotal(payload, total));

      var responseOffset = Math.max(0, Math.floor(finite(payload && payload.offset, requestOffset)));
      var responseLimit = positiveInteger(payload && payload.limit, limit);
      var explicitNextOffset = finite(payload && payload.nextOffset, -1);
      offset = explicitNextOffset >= 0
        ? Math.floor(explicitNextOffset)
        : responseOffset + (rawItems.length < responseLimit ? rawItems.length : responseLimit);
      if (offset <= requestOffset && rawItems.length) offset = requestOffset + rawItems.length;

      hasMore = typeof options.getHasMore === 'function'
        ? !!options.getHasMore(payload, {
            nextOffset: offset,
            total: total,
            rawCount: rawItems.length,
            limit: responseLimit,
          })
        : pageHasMore(payload, offset, total, rawItems.length, responseLimit);
      pages += 1;

      if (items.length > maxItems) {
        items = items.slice(0, maxItems);
        truncated = true;
        hasMore = false;
      }
      if (!rawItems.length && offset <= requestOffset) hasMore = false;

      if (typeof options.onPage === 'function') {
        await options.onPage({
          items: items.slice(),
          pageItems: rawItems.slice(),
          payload: payload || {},
          page: pages,
          nextOffset: offset,
          total: total,
          hasMore: hasMore,
        });
      }
    }

    if (hasMore && (pages >= maxPages || items.length >= maxItems)) truncated = true;
    return {
      items: items,
      total: total || items.length,
      pages: pages,
      nextOffset: offset,
      complete: !hasMore && !truncated,
      truncated: truncated,
    };
  }

  return {
    collectPaged: collectPaged,
    itemIdentity: itemIdentity,
    mergeUnique: mergeUnique,
    pageHasMore: pageHasMore,
    pageItems: pageItems,
    pageTotal: pageTotal,
    shouldInvalidateSession: shouldInvalidateSession,
  };
});
