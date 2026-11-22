/* X 双语对照翻译 - 关键词遮挡工具
 * 纯逻辑：从句子中挑选适合遮挡的关键词，并按关键词切分文本。
 * 供 content.js 使用，也可在 Node 测试中直接 require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XTLKeywords = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EN_STOPWORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any',
    'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
    'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'done', 'during', 'each',
    'etc', 'few', 'for', 'from', 'further', 'get', 'got', 'had', 'has', 'have', 'having', 'he',
    'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into',
    'is', 'it', 'its', 'itself', 'just', 'me', 'might', 'more', 'most', 'much', 'must', 'my',
    'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our',
    'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shall', 'she', 'should', 'so', 'some',
    'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
    'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'us', 'via',
    'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
    'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
    'aren', 'can', 'couldn', 'didn', 'doesn', 'don', 'hadn', 'hasn', 'haven', 'isn', 'mightn',
    'mustn', 'needn', 'shan', 'shouldn', 'wasn', 'weren', 'won', 'wouldn',
    'http', 'https', 'www', 'com', 'org', 'net',
  ]);

  const ZH_STOPWORDS = new Set([
    '的', '了', '是', '在', '和', '也', '就', '都', '而', '及', '与', '着', '或', '一个', '一种',
    '我们', '你们', '他们', '她们', '它们', '这', '那', '这个', '那个', '这些', '那些', '这样', '那样',
    '有', '我', '你', '他', '她', '它', '不', '没', '没有', '很', '会', '要', '可以', '能', '能够',
    '因为', '所以', '但是', '但', '如果', '然后', '还是', '已经', '正在', '被', '把', '让', '给',
    '对', '从', '到', '向', '于', '为', '以', '其', '之', '上', '下', '中', '里', '外', '来', '去',
    '个', '些', '呢', '吗', '吧', '啊', '呀', '哦', '嗯', '还', '又', '再', '才', '只', '更', '最',
    '太', '非常', '比较', '一些', '什么', '怎么', '为什么', '哪', '哪里', '谁', '时候', '现在',
    '今天', '明天', '昨天', '这里', '那里', '以及', '并且', '不过', '只是', '这样', '那样',
  ]);

  const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;
  const MENTION_RE = /^[@#]\S*$/;
  const PURE_NUMBER_RE = /^\d+(?:[.,]\d+)*$/;
  const PUNCT_RE = /^[\p{P}\p{S}\s]+$/u;
  const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;

  function isCJK(text) {
    return CJK_RE.test(text || '');
  }

  function makeSegmenter(locale, granularity) {
    try {
      if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
      return new Intl.Segmenter(locale, { granularity });
    } catch (_) {
      return null;
    }
  }

  function cleanForSelection(text) {
    return String(text || '')
      .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
      .replace(/[@#][\p{L}\p{N}_]+/gu, ' ');
  }

  function isMaskableWord(word, cjk) {
    if (!word) return false;
    if ((cjk ? ZH_STOPWORDS : EN_STOPWORDS).has(word.toLowerCase())) return false;
    if (URL_RE.test(word) || MENTION_RE.test(word) || PURE_NUMBER_RE.test(word)) return false;
    if (PUNCT_RE.test(word)) return false;
    if (!cjk && word.length < 2) return false;
    return true;
  }

  function scoreWord(word) {
    let score = word.length * 2;
    // 首字母大写的词更可能是专有名词/主语，优先遮挡。
    if (/^[A-Z]/.test(word) && !/^[A-Z]+$/.test(word)) score += 2;
    if (/\d/.test(word)) score += 1;
    return score;
  }

  function chooseKeyword(text) {
    const clean = cleanForSelection(text);
    const cjk = isCJK(clean);
    const locale = cjk ? 'zh' : 'en';
    const segmenter = makeSegmenter(locale, 'word');
    if (!segmenter) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const part of segmenter.segment(clean)) {
      if (!part.isWordLike) continue;
      const word = part.segment;
      if (!isMaskableWord(word, cjk)) continue;
      const score = scoreWord(word);
      if (score > bestScore) {
        best = word;
        bestScore = score;
      }
    }
    return best;
  }

  function chooseKeywords(text, max) {
    const limit = Math.max(1, max || 6);
    const clean = cleanForSelection(text);
    if (!clean.trim()) return [];

    const locale = isCJK(clean) ? 'zh' : 'en';
    const sentenceSegmenter = makeSegmenter(locale, 'sentence');
    const sentences = sentenceSegmenter
      ? Array.from(sentenceSegmenter.segment(clean), (part) => part.segment)
      : [clean];

    const keywords = [];
    const seen = new Set();
    for (const sentence of sentences) {
      const keyword = chooseKeyword(sentence);
      if (!keyword) continue;
      const key = keyword.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      keywords.push(keyword);
      if (keywords.length >= limit) break;
    }
    return keywords;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function keywordPattern(keyword) {
    const escaped = escapeRegExp(keyword);
    if (/^[A-Za-z0-9]/.test(keyword) && /[A-Za-z0-9]$/.test(keyword)) {
      return '\\b' + escaped + '\\b';
    }
    return escaped;
  }

  /** 把文本切成 [{ text, match }]，match=true 表示命中的关键词。 */
  function splitByKeywords(text, keywords) {
    if (!text || !keywords || keywords.length === 0) {
      return [{ text: text || '', match: false }];
    }
    const patterns = keywords
      .slice()
      .sort((a, b) => b.length - a.length)
      .map(keywordPattern);
    let re;
    try {
      re = new RegExp(patterns.join('|'), 'gi');
    } catch (_) {
      return [{ text, match: false }];
    }

    const parts = [];
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > last) {
        parts.push({ text: text.slice(last, match.index), match: false });
      }
      parts.push({ text: match[0], match: true });
      last = match.index + match[0].length;
      if (match[0].length === 0) re.lastIndex += 1;
    }
    if (last < text.length) {
      parts.push({ text: text.slice(last), match: false });
    }
    return parts.length ? parts : [{ text, match: false }];
  }

  return { chooseKeyword, chooseKeywords, splitByKeywords, isCJK };
});
