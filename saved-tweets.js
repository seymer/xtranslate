(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XTLSavedTweets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function safeStorageGet(storage, query, callback, onError) {
    let request;
    try {
      request = storage.get(query, callback);
    } catch (error) {
      if (onError) onError(error);
      return false;
    }
    if (request && typeof request.catch === 'function') {
      request.catch((error) => {
        if (onError) onError(error);
      });
    }
    return true;
  }

  function localDay(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function upsert(items, tweet) {
    const list = Array.isArray(items) ? items : [];
    const existing = list.find((item) => item && item.id === tweet.id);
    const next = { ...tweet };
    if (existing) {
      next.savedAt = existing.savedAt || tweet.savedAt;
      next.reviewedOn = existing.reviewedOn || null;
      next.reviewCount = existing.reviewCount || 0;
      next.lastReviewedAt = existing.lastReviewedAt || null;
    } else {
      next.reviewCount = 0;
      next.reviewedOn = null;
      next.lastReviewedAt = null;
    }
    return [next, ...list.filter((item) => item && item.id !== tweet.id)];
  }

  function dueToday(items, now) {
    if (!Array.isArray(items)) return [];
    const today = localDay(now === undefined ? Date.now() : now);
    return items.filter((item) => item && item.reviewedOn !== today);
  }

  function markReviewed(items, id, now) {
    if (!Array.isArray(items)) return [];
    const timestamp = now === undefined ? Date.now() : now;
    return items.map((item) => item && item.id === id
      ? (item.reviewedOn === localDay(timestamp)
        ? item
        : { ...item, reviewedOn: localDay(timestamp), lastReviewedAt: timestamp, reviewCount: (item.reviewCount || 0) + 1 })
      : item);
  }

  function remove(items, id) {
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item && item.id !== id);
  }

  function toggle(items, tweet) {
    const list = Array.isArray(items) ? items : [];
    const isSaved = list.some((item) => item && item.id === tweet.id);
    return isSaved
      ? { items: remove(items, tweet.id), saved: false }
      : { items: upsert(items, tweet), saved: true };
  }

  return { safeStorageGet, localDay, upsert, dueToday, markReviewed, remove, toggle };
});
