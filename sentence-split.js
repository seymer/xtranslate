/* X 双语对照翻译 - 共享句拆分工具
 * 提供 splitSentences / splitParagraphs / mergePunctuationParas / isPureUrl。
 * 供 content.js（页面上的逐句排列）与 review.js（收藏列表逐句对照）共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XTLText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PURE_URL_RE = /^(https?:\/\/|www\.)\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i;
  function isPureUrl(s) { return PURE_URL_RE.test(s.trim()); }

  const ABBREVS = new Set([
    'vs', 'dr', 'mr', 'mrs', 'ms', 'prof', 'inc', 'ltd', 'corp', 'co', 'dept', 'est', 'vol', 'fig',
    'no', 'approx', 'govt', 'ft', 'lb', 'oz', 'kg', 'mg', 'mm', 'cm', 'km', 'hr', 'min', 'sec',
    'ave', 'blvd', 'st', 'rd', 'appx', 'assn', 'intl', 'natl', 'univ',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'jr', 'sr', 'esq', 'phd', 'md', 'dds', 'rv', 'dc', 'ca', 'eg', 'ie', 'al', 'etc', 'resp',
  ]);

  function splitSentences(text) {
    const DOT_PH = '\u0001';
    const BRK_PH = '\u0002';
    const LIST_PH = '\u0003';
    const ABBR_PH = '\u0004';
    const bracketMap = [];
    let prepared = (text || '')
      .replace(/\r/g, '\n')
      .replace(/[「『][\s\S]*?[」』]/g, (m) => { bracketMap.push(m); return BRK_PH + (bracketMap.length - 1); })
      .replace(/…|\.{3,}/g, (m) => { bracketMap.push(m); return BRK_PH + (bracketMap.length - 1); });
    // 保护列表序号（1.  2.  𝟭.）和小数点（2.1）不被拆分
    prepared = prepared.replace(/(\p{N})[.、] /gu, `$1${LIST_PH}`);
    // 保护 URL（https://x.com/path、ft.trib.al、jamesclear.com）中的句点不被拆分
    prepared = prepared.replace(
      /(?:https?:\/\/[^\s]+|(?:[a-zA-Z0-9][\w-]*\.)*(?:[a-zA-Z0-9][\w-]*)\.(?:com|org|net|edu|gov|mil|io|co|dev|app|me|ly|ai|cc|ru|cn|uk|de|fr|jp|br|in|info|biz|xyz|online|site|tech|store|fun|pro|vip)(?:\/[^\s]*)?)(?=[^\w.]|$)/gu,
      (m) => m.replace(/\./g, ABBR_PH),
    );
    // 保护常见缩写（vs.  Dr.  D.C.  U.S.A. 等）不被拆分
    prepared = prepared.replace(/(?:(\p{L}+)\.)+(?=\s|\b)/gu, (m) => {
      const clean = m.replace(/\s+$/, '').replace(/\.$/, '');
      if (ABBREVS.has(clean.replace(/\./g, '').toLowerCase())) {
        return m.replace(/\./g, ABBR_PH);
      }
      return m;
    });
    const delimited = prepared
      .replace(/([。！？])/g, '$1\u0000')
      .replace(/(?<!\d)([.!?]+)(?=\s|\b)/g, '$1\u0000')
      .replace(/\n+/g, '\u0000');
    return delimited
      .split('\u0000')
      .map((s) => s.trim()
        .split(DOT_PH).join('.')
        .split(LIST_PH).join('.')
        .split(ABBR_PH).join('.')
        .replace(new RegExp(BRK_PH + '(\\d+)', 'g'), (_, i) => bracketMap[+i]))
      .filter((s) => s.length > 0);
  }

  function splitParagraphs(text) {
    return (text || '')
      .replace(/[「『][\s\S]*?[」』]/g, (m) => m.replace(/\n/g, ' '))
      .replace(/\r/g, '\n')
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function mergePunctuationParas(paras) {
    const result = [];
    const PUNCT = /^[!！？?。，,、；;：:…·\s]+$/;
    for (const p of paras) {
      const clean = p.trim();
      if (result.length > 0 && clean.length <= 6 && PUNCT.test(clean)) {
        result[result.length - 1] += clean;
      } else if (clean.length > 0) {
        result.push(clean);
      }
    }
    return result;
  }

  return { splitSentences, splitParagraphs, mergePunctuationParas, isPureUrl };
});
