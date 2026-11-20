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

  // 文本导出（t 为 i18n 函数，review.js 传入）：导出标题、导出日期、逐条作者/保存日/原文/译文
  function formatExportText(items, t) {
    const dateStr = (ts) => {
      const d = new Date(ts);
      return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
    };
    const lines = [t('exportTitle')];
    lines.push(`${t('exportDate')}${dateStr(Date.now())}`);
    lines.push('='.repeat(44));
    (items || []).forEach((tweet) => {
      if (!tweet || !tweet.id) return;
      lines.push('');
      lines.push(`【${tweet.author || t('unknownAuthor')}】`);
      lines.push(t('savedOn', dateStr(tweet.savedAt)));
      lines.push('');
      lines.push(tweet.text || '');
      if (tweet.translation) {
        lines.push('');
        lines.push(`${t('translationLabel')}:`);
        lines.push(tweet.translation);
      }
    });
    return lines.join('\n') + '\n';
  }

  function toggle(items, tweet) {
    const list = Array.isArray(items) ? items : [];
    const isSaved = list.some((item) => item && item.id === tweet.id);
    return isSaved
      ? { items: remove(items, tweet.id), saved: false }
      : { items: upsert(items, tweet), saved: true };
  }

  return { safeStorageGet, localDay, upsert, dueToday, markReviewed, remove, toggle, formatExportText };
});
