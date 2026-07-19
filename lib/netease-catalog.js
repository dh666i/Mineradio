'use strict';

const TYPED_SEARCH_TYPES = Object.freeze({
  artist: { apiType: 100, listKey: 'artists', countKey: 'artistCount' },
  album: { apiType: 10, listKey: 'albums', countKey: 'albumCount' },
  playlist: { apiType: 1000, listKey: 'playlists', countKey: 'playlistCount' },
});

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizePagination(limitValue, offsetValue, options) {
  const opts = options || {};
  const defaultLimit = Math.max(1, Math.trunc(finiteNonNegative(opts.defaultLimit, 30)) || 30);
  const maxLimit = Math.max(defaultLimit, Math.trunc(finiteNonNegative(opts.maxLimit, 100)) || 100);
  const requestedLimit = Math.trunc(finiteNonNegative(limitValue, defaultLimit));
  return {
    limit: Math.max(1, Math.min(maxLimit, requestedLimit || defaultLimit)),
    offset: Math.max(0, Math.trunc(finiteNonNegative(offsetValue, 0))),
  };
}

function normalizeTypedSearchType(value) {
  const type = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TYPED_SEARCH_TYPES, type) ? type : '';
}

function resolvePageCursor(page, total, rawCount, upstreamHasMore) {
  page = page || {};
  const limit = Math.max(1, Math.trunc(finiteNonNegative(page.limit, 1)) || 1);
  const offset = Math.max(0, Math.trunc(finiteNonNegative(page.offset, 0)));
  const count = Math.max(0, Math.trunc(finiteNonNegative(rawCount, 0)));
  const reportedTotal = Math.max(0, Math.trunc(finiteNonNegative(total, 0)));
  const more = upstreamHasMore === true || offset + count < reportedTotal;
  const inferredTotal = offset + count;
  const resolvedTotal = Math.max(reportedTotal, inferredTotal, upstreamHasMore === true ? offset + count + 1 : 0);
  return {
    total: resolvedTotal,
    nextOffset: offset + (more ? limit : count),
    more,
    hasMore: more,
  };
}

function mapArtists(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(artist => ({
      id: artist && artist.id,
      name: String(artist && artist.name || '').trim(),
    }))
    .filter(artist => artist.id && artist.name);
}

function mapNeteaseArtist(raw) {
  raw = raw || {};
  const aliases = Array.isArray(raw.alias) ? raw.alias.filter(Boolean).map(String) : [];
  const albumCount = finiteNonNegative(raw.albumSize || raw.albumCount, 0) || 0;
  const songCount = finiteNonNegative(raw.musicSize || raw.songSize || raw.songCount, 0) || 0;
  return {
    provider: 'netease',
    source: 'netease',
    type: 'artist',
    id: raw.id,
    name: raw.name || '',
    avatar: raw.picUrl || raw.img1v1Url || raw.avatarUrl || raw.cover || '',
    aliases,
    alias: aliases,
    albumCount,
    albumSize: albumCount,
    songCount,
    musicCount: songCount,
    musicSize: songCount,
    followed: !!(raw.followed || raw.follow),
  };
}

function mapNeteaseAlbum(raw) {
  raw = raw || {};
  const artists = mapArtists(raw.artists || (raw.artist ? [raw.artist] : []));
  return {
    provider: 'netease',
    source: 'netease',
    type: 'album',
    id: raw.id,
    name: raw.name || '',
    cover: raw.picUrl || raw.blurPicUrl || raw.coverUrl || '',
    artist: artists.map(item => item.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    songCount: finiteNonNegative(raw.size || raw.songCount, 0) || 0,
    publishTime: finiteNonNegative(raw.publishTime || raw.publishDate, 0) || 0,
    albumType: raw.type || '',
    subType: raw.subType || '',
    company: raw.company || '',
    description: raw.description || raw.desc || '',
    aliases: Array.isArray(raw.alias) ? raw.alias.filter(Boolean).map(String) : [],
  };
}

function mapNeteasePlaylist(raw) {
  raw = raw || {};
  const creator = raw.creator || raw.user || {};
  return {
    provider: 'netease',
    source: 'netease',
    type: 'playlist',
    id: raw.id || raw.resourceId || raw.creativeId,
    name: raw.name || raw.title || '',
    cover: raw.coverImgUrl || raw.picUrl || raw.coverUrl
      || raw.uiElement && raw.uiElement.image && raw.uiElement.image.imageUrl || '',
    description: raw.description || raw.desc || '',
    trackCount: finiteNonNegative(raw.trackCount || raw.songCount || raw.programCount, 0) || 0,
    playCount: finiteNonNegative(raw.playCount || raw.playcount, 0) || 0,
    creator: creator.nickname || creator.name || '',
    creatorId: creator.userId || creator.id || null,
    creatorAvatar: creator.avatarUrl || creator.avatar || '',
    subscribed: !!raw.subscribed,
    specialType: finiteNonNegative(raw.specialType, 0) || 0,
    privacy: finiteNonNegative(raw.privacy, 0) || 0,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean).map(String) : [],
    updateTime: finiteNonNegative(raw.updateTime, 0) || 0,
  };
}

function mapNeteasePlaylistMeta(raw, fallbackId) {
  const mapped = mapNeteasePlaylist({ ...(raw || {}), id: raw && raw.id || fallbackId });
  return {
    ...mapped,
    commentCount: finiteNonNegative(raw && raw.commentCount, 0) || 0,
    shareCount: finiteNonNegative(raw && raw.shareCount, 0) || 0,
    subscribedCount: finiteNonNegative(raw && (raw.subscribedCount || raw.bookCount), 0) || 0,
    createTime: finiteNonNegative(raw && raw.createTime, 0) || 0,
  };
}

function mapTypedSearchResult(body, type) {
  const normalizedType = normalizeTypedSearchType(type);
  if (!normalizedType) return null;
  const config = TYPED_SEARCH_TYPES[normalizedType];
  const result = body && (body.result || body.data) || {};
  const rawItems = Array.isArray(result[config.listKey]) ? result[config.listKey] : [];
  const mapper = normalizedType === 'artist'
    ? mapNeteaseArtist
    : (normalizedType === 'album' ? mapNeteaseAlbum : mapNeteasePlaylist);
  const items = rawItems.map(mapper).filter(item => item.id && item.name);
  const total = finiteNonNegative(result[config.countKey], items.length);
  return { type: normalizedType, listKey: config.listKey, apiType: config.apiType, items, total };
}

function mapPlaylistCategories(body) {
  body = body || {};
  const names = body.categories || body.category || {};
  const groups = new Map();
  Object.keys(names).forEach(key => {
    groups.set(String(key), {
      id: String(key),
      name: String(names[key] || ''),
      items: [],
    });
  });
  (Array.isArray(body.sub) ? body.sub : []).forEach(item => {
    if (!item || !item.name) return;
    const categoryId = String(item.category == null ? '' : item.category);
    if (!groups.has(categoryId)) {
      groups.set(categoryId, { id: categoryId, name: '', items: [] });
    }
    groups.get(categoryId).items.push({
      name: String(item.name),
      hot: !!item.hot,
      activity: !!item.activity,
    });
  });
  return Array.from(groups.values()).sort((left, right) => {
    const leftNumber = Number(left.id);
    const rightNumber = Number(right.id);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return left.id.localeCompare(right.id);
  });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function containsControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function containsUnsafeDescriptionCharacters(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[;,]/);
  const tags = [];
  for (const item of raw) {
    const tag = String(item == null ? '' : item).trim();
    if (!tag || tags.includes(tag)) continue;
    if (tag.length > 20 || containsControlCharacters(tag) || /[;,]/.test(tag)) {
      return { ok: false, error: 'INVALID_PLAYLIST_TAGS', tags: [] };
    }
    tags.push(tag);
  }
  if (tags.length > 3) return { ok: false, error: 'INVALID_PLAYLIST_TAGS', tags: [] };
  return { ok: true, error: '', tags };
}

function normalizePlaylistMetadataPatch(input, current) {
  input = input || {};
  current = current || {};
  const hasName = hasOwn(input, 'name');
  const hasDescription = hasOwn(input, 'description') || hasOwn(input, 'desc');
  const hasTags = hasOwn(input, 'tags');
  const hasPrivacy = hasOwn(input, 'privacy');
  if (!hasName && !hasDescription && !hasTags && !hasPrivacy) {
    return { ok: false, error: 'NO_METADATA_CHANGES' };
  }

  const name = String(hasName ? input.name : current.name || '').trim();
  const descriptionValue = hasOwn(input, 'description') ? input.description : input.desc;
  const description = String(hasDescription ? descriptionValue : current.description || '').trim();
  if (!name || name.length > 40 || containsControlCharacters(name)) {
    return { ok: false, error: 'INVALID_PLAYLIST_NAME' };
  }
  if (description.length > 1000 || containsUnsafeDescriptionCharacters(description)) {
    return { ok: false, error: 'INVALID_PLAYLIST_DESCRIPTION' };
  }

  const currentTags = Array.isArray(current.tags) ? current.tags : String(current.tags || '').split(/[;,]/);
  const normalizedTags = normalizeTags(hasTags ? input.tags : currentTags);
  if (!normalizedTags.ok) return normalizedTags;
  const currentPrivacy = Number(current.privacy == null ? 0 : current.privacy);
  const privacy = Number(hasPrivacy ? input.privacy : currentPrivacy);
  if (!Number.isInteger(privacy) || (privacy !== 0 && privacy !== 10)) {
    return { ok: false, error: 'INVALID_PLAYLIST_PRIVACY' };
  }

  return {
    ok: true,
    error: '',
    metadata: {
      name,
      description,
      tags: normalizedTags.tags,
      privacy,
    },
    changed: {
      name: hasName,
      description: hasDescription,
      tags: hasTags,
      privacy: hasPrivacy && privacy !== currentPrivacy,
    },
  };
}

module.exports = {
  TYPED_SEARCH_TYPES,
  mapNeteaseAlbum,
  mapNeteaseArtist,
  mapNeteasePlaylist,
  mapNeteasePlaylistMeta,
  mapPlaylistCategories,
  mapTypedSearchResult,
  normalizePagination,
  normalizePlaylistMetadataPatch,
  normalizeTypedSearchType,
  resolvePageCursor,
};
