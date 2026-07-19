'use strict';

function normalizeNeteaseId(value) {
  const id = String(value == null ? '' : value).trim();
  const numeric = Number(id);
  return /^\d{1,16}$/.test(id) && Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : '';
}

function getPlaylistEditRestriction(playlist, userId) {
  const ownerId = normalizeNeteaseId(playlist && playlist.creator && playlist.creator.userId);
  const normalizedUserId = normalizeNeteaseId(userId);
  if (!ownerId || ownerId !== normalizedUserId || playlist && playlist.subscribed === true) {
    return 'PLAYLIST_NOT_OWNED';
  }

  const specialType = Number(playlist && playlist.specialType || 0);
  if (!Number.isFinite(specialType) || specialType !== 0) {
    return 'PLAYLIST_SPECIAL_READ_ONLY';
  }
  return '';
}

function getPlaylistSubscriptionRestriction(playlist, userId) {
  const playlistId = normalizeNeteaseId(playlist && playlist.id);
  if (!playlistId) return 'PLAYLIST_NOT_FOUND';

  const ownerId = normalizeNeteaseId(playlist && playlist.creator && playlist.creator.userId);
  const normalizedUserId = normalizeNeteaseId(userId);
  if (ownerId && normalizedUserId && ownerId === normalizedUserId) {
    return 'PLAYLIST_OWNED';
  }

  if (playlist && playlist.privacy != null && Number(playlist.privacy) !== 0) {
    return 'PLAYLIST_NOT_PUBLIC';
  }
  return '';
}

module.exports = {
  getPlaylistEditRestriction,
  getPlaylistSubscriptionRestriction,
  normalizeNeteaseId,
};
