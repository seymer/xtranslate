/* X 双语对照翻译 - 本地英汉词典查询
 * 数据为扩展自带的精简 JSON，首次使用时加载并缓存。
 * 只处理英文词 -> 中文释义。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XTLDictionary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const cache = new Map();
  const FILE = 'en-zh.json';

  function load() {
    if (cache.has(FILE)) return cache.get(FILE);
    const url = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL('data/' + FILE)
      : 'data/' + FILE;
    const promise = fetch(url).then((response) => {
      if (!response.ok) throw new Error('dictionary load failed: ' + response.status);
      return response.json();
    });
    cache.set(FILE, promise);
    return promise;
  }

  function lookup(word) {
    const clean = String(word || '').trim();
    if (!clean) return Promise.resolve(null);
    const key = clean.toLowerCase();
    return load().then((dict) => {
      if (dict[key]) return dict[key];
      // 简单词形还原：cateries -> category, walked -> walk, running -> run
      const variants = [];
      if (key.endsWith('ies')) variants.push(key.slice(0, -3) + 'y');
      if (key.endsWith('es')) variants.push(key.slice(0, -2), key.slice(0, -1));
      if (key.endsWith('s')) variants.push(key.slice(0, -1));
      if (key.endsWith('ing')) {
        const base = key.slice(0, -3);
        variants.push(base, base + 'e');
        if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
          variants.push(base.slice(0, -1));
        }
      }
      if (key.endsWith('ed')) {
        const base = key.slice(0, -2);
        variants.push(base, base + 'e');
        if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
          variants.push(base.slice(0, -1));
        }
      }
      for (const variant of variants) {
        if (dict[variant]) return dict[variant];
      }
      return null;
    }).catch(() => null);
  }

  function format(entry) {
    if (!entry) return '';
    const lines = [entry.p ? entry.w + '  /' + entry.p + '/' : entry.w];
    if (entry.t) lines.push(entry.t);
    if (entry.f) lines.push('词频 ' + entry.f);
    return lines.join('\n');
  }

  return { load, lookup, format };
});
