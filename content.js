/**
 * X (x.com) 双语对照翻译 - Content Script
 *
 * 工作原理（利用官方已有翻译，不调用任何第三方 API）：
 * 1. 官方自动翻译开启时（或用户手动点过"翻译帖子"），被翻译的推文会出现
 *    带「显示原文」按钮的灰色提示栏（"翻译自 英语" / "关于自动翻译"），
 *    此时 div[data-testid="tweetText"] 里渲染的是【译文】。
 * 2. 本脚本发现该按钮后：
 *    - 先备份 tweetText 的 innerHTML（即官方译文 HTML）；
 *    - 程序化模拟点击「显示原文」，让官方把内容换回【原文】；
 *    - 轮询等待 tweetText 内容变化，拿到原文；
 *    - 在 tweetText 之后插入一个兄弟节点容器：说明文字 + 备份的译文。
 * 3. 最终效果：原文保持原位（仍是 React 管理，链接/@提及/图片等交互不受影响），
 *    译文块紧跟其后，用左侧竖线 + 灰色小字区分。点击灰色说明文字可折叠/展开译文。
 *
 * 身份识别体系：
 * - tweetId（推文 URL 中的数字 ID）：主要身份标识，用于防止虚拟列表复用时误配
 * - DOM WeakMap：当前节点 → 翻译记录的映射
 * - recordNodes Set：可遍历的节点集合（配合 WeakMap 使用，定期清理断开节点）
 * - head/transHead：辅助诊断，用于日志和快速校验
 */
(() => {
  'use strict';

  const SHOW_ORIGINAL_LABELS = ['显示原文', 'Show original'];
  const SHOW_TRANSLATION_LABELS = ['显示翻译', 'Show translation'];
  const SHOW_MORE_LABELS = ['显示更多', 'Show more'];
  const POLL_MS = 80;
  const POLL_MAX = 3000;
  // 单条 processPair 最多要经历 expandShowMore + waitForChange 各两次（每次最长 POLL_MAX），
  // 最长约 12s；超时值必须大于它，否则正常处理会被硬超时截断，留下未完成的中间状态。
  const PROCESS_PAIR_TIMEOUT = 15000;
  const PENDING_TTL = 30000;
  const FAILED_BTN_TTL = 30000; // Bug5: failedBtns 30秒后允许重试

  const THIRD_PARTY_SELECTORS = [
    '[class*="eusoft"]',
    'app-translate-content',
    'translate-node-container',
  ];

  const DEBUG = false;
  const dbg = (...args) => { if (DEBUG) console.log('[XTL]', ...args); };

  /* ==================== 状态 ==================== */

  let enabled = true;
  let mode = 'interleave';

  const records = new WeakMap();      // tweetText → { tweetId, transHTML, origHTML, note, origText, head, transHead }
  const recordNodes = new Set();      // 所有有 record 的节点（可遍历，配合 WeakMap）
  const pending = new WeakSet();      // 正在处理中的 tweetText
  let failedBtns = new WeakMap();     // Bug5: btn → timestamp，超时后允许重试
  const pendingTexts = new Map();     // textKey → timestamp（30秒冷却）
  let retryRemaining = 3;

  /* ==================== 基础工具 ==================== */

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /** Bug2: 用 tweetId+textKey 联合 key 避免不同推文碰撞 */
  function makePendingKey(tweetId, textKey) {
    return tweetId ? tweetId + '|' + textKey : textKey;
  }

  function isPendingText(key) {
    const ts = pendingTexts.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > PENDING_TTL) { pendingTexts.delete(key); return false; }
    return true;
  }

  const isTweetText = (el) => el && el.matches && (el.matches('div[data-testid="tweetText"]') || el.matches('div[data-testid="UserDescription"]'));

  function hasThirdPartyTranslation(root) {
    if (!root) return false;
    for (const sel of THIRD_PARTY_SELECTORS) {
      try {
        if (root.matches && root.matches(sel)) return true;
        if (root.querySelector && root.querySelector(sel)) return true;
      } catch (_) {}
    }
    return false;
  }

  function htmlToText(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || '').replace(/\r/g, '');
  }

  /** 从 tweetText 向上查找所属推文的 tweetId（URL 中的数字 ID） */
  function getTweetId(tweetText) {
    try {
      const article = tweetText.closest('article');
      if (!article) return null;
      // 引用推文里也有 /status/ 链接；优先取带 <time> 的永久链接，避免拿错 ID
      const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
        .filter((link) => link.closest('article') === article);
      const link = links.find((candidate) => candidate.querySelector('time')) || links[0];
      if (!link) return null;
      const m = link.href.match(/\/status\/(\d+)/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  /** 获取 tweetText 的局部搜索容器（限制 querySelector 范围，避免拿错节点） */
  function getLocalScope(tweetText) {
    return tweetText.closest('article') || tweetText.parentElement || document.body;
  }

  /* ==================== 句子/段落拆分 ==================== */

  const PURE_URL_RE = /^(https?:\/\/|www\.)\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i;
  function isPureUrl(s) { return PURE_URL_RE.test((s || '').trim()); }

  const ABBREVS = new Set([
    'vs','dr','mr','mrs','ms','prof','inc','ltd','corp','co','dept','est','vol','fig',
    'no','dept','approx','dept','govt','ft','lb','oz','kg','mg','mm','cm','km','hr','min','sec',
    'ave','blvd','st','rd','ave','appx','dept','govt','assn','intl','natl','univ',
    'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec',
    'jr','sr','esq','phd','md','dds','rv','dc','ca','eg','ie','al','etc','resp'
  ]);

  function splitSentences(text) {
    const DOT_PH = '\u0001';
    const BRK_PH = '\u0002';
    const LIST_PH = '\u0003';
    const ABBR_PH = '\u0004';
    const bracketMap = [];
    let prepared = text
      .replace(/\r/g, '\n')
      .replace(/[「『][\s\S]*?[」』]/g, (m) => { bracketMap.push(m); return BRK_PH + (bracketMap.length - 1); })
      .replace(/…|\.{3,}/g, (m) => { bracketMap.push(m); return BRK_PH + (bracketMap.length - 1); });
    // 保护列表序号（1.  2.  𝟭.）和小数点（2.1）不被拆分
    prepared = prepared.replace(/(\p{N})[.、] /gu, `$1${LIST_PH}`);
    // 保护 URL（https://x.com/path、ft.trib.al、jamesclear.com）中的句点不被拆分
    prepared = prepared.replace(
      /(?:https?:\/\/[^\s]+|(?:[a-zA-Z0-9][\w-]*\.)*(?:[a-zA-Z0-9][\w-]*)\.(?:com|org|net|edu|gov|mil|io|co|dev|app|me|ly|ai|cc|ru|cn|uk|de|fr|jp|br|in|info|biz|xyz|online|site|tech|store|fun|pro|vip)(?:\/[^\s]*)?)(?=[^\w.]|$)/gu,
      (m) => m.replace(/\./g, ABBR_PH)
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
      .map(s => s.trim()
        .split(DOT_PH).join('.')
        .split(LIST_PH).join('.')
        .split(ABBR_PH).join('.')
        .replace(new RegExp(BRK_PH + '(\\d+)', 'g'), (_, i) => bracketMap[+i]))
      .filter(s => s.length > 0);
  }

  function splitParagraphs(text) {
    return text
      .replace(/[「『][\s\S]*?[」』]/g, (m) => m.replace(/\n/g, ' '))
      .replace(/\r/g, '\n')
      .split(/\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
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

  function buildInterleaved(origText, transText, note, origHTML, transHTML) {
    let origParas = mergePunctuationParas(splitParagraphs(origText));
    let transParas = mergePunctuationParas(splitParagraphs(transText));
    origParas = origParas.filter(p => !isPureUrl(p));
    transParas = transParas.filter(p => !isPureUrl(p));
    if (origParas.length === 0 || transParas.length === 0) return null;

    // Bug7: 段落数不等时，拼接后仍尝试逐句 interleave
    if (origParas.length !== transParas.length) {
      const fullOrig = origParas.join('\n');
      const fullTrans = transParas.join('\n');
      origParas = [fullOrig];
      transParas = [fullTrans];
    }

    const container = document.createElement('div');
    container.className = 'xtl-wrap xtl-interleave';
    if (note) {
      const n = document.createElement('div');
      n.className = 'xtl-note';
      n.textContent = note;
      n.title = FOLD_HINT;
      container.appendChild(n);
    }
    origParas.forEach((origPara, pi) => {
      const transPara = transParas[pi];
      let origSents = splitSentences(origPara).filter(s => !isPureUrl(s));
      let transSents = splitSentences(transPara).filter(s => !isPureUrl(s));
      if (origSents.length >= 2 && origSents.length === transSents.length) {
        origSents.forEach((orig, si) => {
          const pair = document.createElement('div');
          pair.className = 'xtl-pair';
          const o = document.createElement('div'); o.className = 'xtl-orig'; o.textContent = norm(orig); pair.appendChild(o);
          const t = document.createElement('div'); t.className = 'xtl-trans'; t.textContent = norm(transSents[si]); pair.appendChild(t);
          container.appendChild(pair);
        });
      } else {
        const pair = document.createElement('div');
        pair.className = 'xtl-pair';
        const o = document.createElement('div'); o.className = 'xtl-orig';
        const t = document.createElement('div'); t.className = 'xtl-trans';
        
        // 恢复 HTML 保留逻辑：如果是整体 fallback，使用 innerHTML 保留富文本
        if (origParas.length === 1) {
          o.innerHTML = origHTML || '';
          t.innerHTML = transHTML || '';
        } else {
          o.textContent = norm(origPara);
          t.textContent = norm(transPara);
        }
        
        pair.appendChild(o);
        pair.appendChild(t);
        container.appendChild(pair);
      }
    });
    return container;
  }

  /* ==================== 按钮识别 ==================== */

  function isShowOriginalBtn(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    return SHOW_ORIGINAL_LABELS.includes(norm(el.getAttribute('aria-label') || el.innerText || ''));
  }

  function isShowTranslationBtn(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    return SHOW_TRANSLATION_LABELS.includes(norm(el.getAttribute('aria-label') || el.innerText || ''));
  }

  function isShowMoreBtn(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    return SHOW_MORE_LABELS.includes(norm(el.getAttribute('aria-label') || el.innerText || ''));
  }

  /* ==================== DOM 定位 ==================== */

  /**
   * 由按钮定位所属的 tweetText。
   * 策略：优先在 article 内搜索（最快），找不到则逐级向上遍历祖先（兼容横幅在 article 外的情况）。
   */
  function findTweetTextForBtn(btn) {
    // 第一步：尝试 article 范围（最常见布局）
    const articleScope = btn.closest('article');
    if (articleScope) {
      const tt = findTweetTextInScope(btn, articleScope);
      if (tt) return tt;
    }
    // 第二步：逐级向上遍历（兼容翻译横幅在 article 外层的布局）
    let p = btn.parentElement;
    for (let i = 0; i < 8 && p; i++) {
      if (p === articleScope) { p = p.parentElement; continue; } // 跳过已搜过的 article
      const tt = findTweetTextInScope(btn, p);
      if (tt) return tt;
      p = p.parentElement;
    }
    dbg('findTweetText: FAIL');
    return null;
  }

  /**
   * Bug3: 在指定容器内查找距离按钮最近的 tweetText（双向查找）。
   * 优先找按钮之后的，找不到则找按钮之前最近的。
   */
  function findTweetTextInScope(btn, scope) {
    const candidates = scope.querySelectorAll('div[data-testid="tweetText"], div[data-testid="UserDescription"]');
    let bestFollowing = null;
    let bestPreceding = null;
    for (const tt of candidates) {
      const pos = btn.compareDocumentPosition(tt);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
        // 按钮在 tweetText 之前（最常见），取第一个即可
        if (!bestFollowing) {
          bestFollowing = tt;
        }
      } else if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        // 按钮在 tweetText 之后（某些布局），取最后一个（最近的）
        bestPreceding = tt;
      }
    }
    // 绝大多数情况下，翻译按钮在推文正文下方（推文在前，按钮在后）
    if (bestPreceding) {
      dbg('findTweetText: OK (preceding)', { btn: btn.getAttribute('aria-label'), tweetText: bestPreceding.textContent.slice(0, 40) });
      return bestPreceding;
    }
    if (bestFollowing) {
      dbg('findTweetText: OK (following)', { btn: btn.getAttribute('aria-label'), tweetText: bestFollowing.textContent.slice(0, 40) });
      return bestFollowing;
    }
    return null;
  }

  function findShowOriginalBtnNear(tt) {
    // 优先在 article 内搜索
    const articleScope = tt.closest('article');
    if (articleScope) {
      const btn = findBtnInScope(articleScope, isShowOriginalBtn);
      if (btn) return btn;
    }
    // 向上遍历（兼容按钮在 article 外的情况）
    let p = tt.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      if (p === articleScope) { p = p.parentElement; continue; }
      const btn = findBtnInScope(p, isShowOriginalBtn);
      if (btn) return btn;
      p = p.parentElement;
    }
    return null;
  }

  /** 在容器内查找第一个匹配的按钮 */
  function findBtnInScope(scope, predicate) {
    const btns = scope.querySelectorAll('[role="button"], button');
    for (const b of btns) { if (predicate(b)) return b; }
    return null;
  }

  /** Bug6: 改进 wrap 检测 — 向后遍历 sibling 查找，并校验关联 */
  function hasWrapNear(tt) {
    if (tt.closest && tt.closest('.xtl-wrap')) return true;
    // 向后遍历 nextElementSibling 链（最多 3 层，兼容 React 插入的额外 wrapper）
    let sib = tt.nextElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      if (sib.classList && sib.classList.contains('xtl-wrap')) return true;
      sib = sib.nextElementSibling;
    }
    // 也检查 parentElement 的直接子节点（兼容旧布局）
    const parent = tt.parentElement;
    if (!parent) return false;
    for (const child of parent.children) {
      if (child !== tt && child.classList && child.classList.contains('xtl-wrap')) return true;
    }
    return false;
  }

  function extractNote(btn) {
    try {
      let el = btn.parentElement;
      for (let i = 0; i < 4 && el; i++) {
        let txt = norm(el.innerText || '');
        [...SHOW_ORIGINAL_LABELS, '关于自动翻译', 'About automatic translations']
          .forEach((k) => { txt = txt.split(k).join(' '); });
        txt = norm(txt);
        if (txt && txt.length <= 80) return txt;
        el = el.parentElement;
      }
    } catch (_) {}
    return null;
  }

  /* ==================== 事件 & 等待 ==================== */

  function nativeClick(el) {
    const o = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
    } catch (_) {}
    el.click();
  }

  function waitForChange(tweetText, prevHTML) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (!tweetText.isConnected) { clearInterval(timer); return resolve({ disconnected: true }); }
        if (tweetText.innerHTML !== prevHTML) { clearInterval(timer); dbg('waitForChange:', Date.now() - t0, 'ms'); return resolve(tweetText.innerHTML); }
        if (Date.now() - t0 > POLL_MAX) { clearInterval(timer); dbg('waitForChange: TIMEOUT'); return resolve(null); }
      }, POLL_MS);
    });
  }

  /**
   * 等待节点被 React 替换。在局部范围内查找新节点，避免全页面误配。
   */
  function waitForReplacement(oldNode, prevHTML, testId) {
    const scope = getLocalScope(oldNode);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const removed = !oldNode.isConnected;
      const timer = setInterval(() => {
        if (!scope.isConnected) { clearInterval(timer); return resolve({ disconnected: true }); }
        // 如果节点被复用且内容改变，直接返回
        if (oldNode.isConnected && oldNode.innerHTML !== prevHTML) {
          clearInterval(timer);
          dbg('waitForReplacement (reused):', Date.now() - t0, 'ms');
          return resolve(oldNode.innerHTML);
        }
        if (!removed && oldNode.isConnected) return;
        // 在局部范围内查找新节点
        const newNode = scope.querySelector(`div[data-testid="${testId}"]`);
        if (!newNode || newNode === oldNode) return;
        if (newNode.innerHTML === prevHTML) return;
        clearInterval(timer);
        dbg('waitForReplacement:', Date.now() - t0, 'ms');
        return resolve(newNode.innerHTML);
      }, POLL_MS);
      setTimeout(() => { clearInterval(timer); dbg('waitForReplacement: TIMEOUT'); return resolve(null); }, POLL_MAX);
    });
  }

  /* ==================== 构建双语块 ==================== */

  const FOLD_TITLES = {
    zh_CN: '点击折叠 / 展开译文',
    en: 'Click to collapse / expand translation',
  };
  let FOLD_HINT = FOLD_TITLES.zh_CN;
  /** 按存储中的手动语言更新折叠提示（null=跟随浏览器） */
  function applyFoldTitle(lang) {
    if (lang && lang !== 'auto') FOLD_HINT = FOLD_TITLES[lang] || FOLD_HINT;
    else {
      try { FOLD_HINT = chrome.i18n.getMessage('foldTitle') || FOLD_TITLES.zh_CN; }
      catch (_) { FOLD_HINT = FOLD_TITLES.zh_CN; }
    }
    document.querySelectorAll('.xtl-note').forEach((n) => { n.title = FOLD_HINT; });
  }

  /* ==================== 译文颜色设置 ==================== */
  // 每种预设的亮色/暗色变体（均满足 WCAG AA 对比度）
  const TRAN_COLORS = {
    // 默认改为蓝色（旧版的透明/灰色仍兼容，不再单独提供"蓝色"选项）
    default: { light: 'rgb(13, 97, 204)', dark: 'rgb(108, 178, 238)' },
    text: { light: 'rgb(15, 20, 25)', dark: 'rgb(231, 233, 234)' },   // 跟随正文
    blue: { light: 'rgb(13, 97, 204)', dark: 'rgb(108, 178, 238)' },  // 保留兼容
    green: { light: 'rgb(20, 112, 76)', dark: 'rgb(94, 192, 138)' },  // 绿
  };
  function applyTransColor(name) {
    const c = TRAN_COLORS[name] || TRAN_COLORS.default;
    const root = document.documentElement;
    if (c.light) root.style.setProperty('--xtl-trans-color', c.light);
    else root.style.removeProperty('--xtl-trans-color');
    if (c.dark) root.style.setProperty('--xtl-trans-color-dark', c.dark);
    else root.style.removeProperty('--xtl-trans-color-dark');
  }

  function createBlockWrap(rec, bodyClass, bodyHTML) {
    const block = document.createElement('div');
    block.className = 'xtl-wrap';
    if (rec.note) {
      const n = document.createElement('div');
      n.className = 'xtl-note';
      n.textContent = rec.note;
      n.title = FOLD_HINT;
      block.appendChild(n);
    }
    const body = document.createElement('div');
    body.className = bodyClass;
    body.innerHTML = bodyHTML;
    block.appendChild(body);
    block.__xtlTrans = rec.transHTML;
    block.__xtlMode = 'block';
    return block;
  }

  function insertWrap(tweetText, wrap, hide) {
    if (!tweetText.isConnected) return;
    tweetText.classList.toggle('xtl-hidden', !!hide);
    tweetText.parentElement.insertBefore(wrap, tweetText.nextSibling);
  }

  function removeAllWraps(tt) {
    const parent = tt.parentElement;
    if (!parent) return;
    Array.from(parent.children).forEach((child) => {
      if (child !== tt && child.classList && child.classList.contains('xtl-wrap')) child.remove();
    });
  }

  function buildAndInsert(tweetText, rec) {
    removeAllWraps(tweetText);
    const origText = htmlToText(rec.origHTML || '');
    const transText = htmlToText(rec.transHTML);

    if (tweetText.matches('div[data-testid="UserDescription"]')) {
      const block = createBlockWrap(rec, 'xtl-trans', rec.transHTML);
      block.removeChild(block.lastChild);
      const origBody = document.createElement('div'); origBody.className = 'xtl-interleave-orig'; origBody.innerHTML = rec.origHTML || ''; block.appendChild(origBody);
      const transBody = document.createElement('div'); transBody.className = 'xtl-interleave-trans'; transBody.innerHTML = rec.transHTML; block.appendChild(transBody);
      insertWrap(tweetText, block, true);
      dbg('buildAndInsert: UserDescription');
      return;
    }

    if (mode === 'block') {
      insertWrap(tweetText, createBlockWrap(rec, 'xtl-trans', rec.transHTML), false);
      dbg('buildAndInsert: block');
      return;
    }

    const wrap = buildInterleaved(origText, transText, rec.note, rec.origHTML, rec.transHTML);
    if (wrap) {
      wrap.__xtlTrans = rec.transHTML;
      wrap.__xtlMode = 'interleave';
      insertWrap(tweetText, wrap, true);
      dbg('buildAndInsert: interleave');
      return;
    }

    dbg('buildAndInsert: interleave failed, fallback block');
    insertWrap(tweetText, createBlockWrap(rec, 'xtl-trans', rec.transHTML), false);
  }

  /* ==================== Show More ==================== */

  async function expandShowMore(tweetText) {
    // 先在 tweetText 内部查找
    const candidates = [];
    tweetText.querySelectorAll('button, [role="button"]').forEach((el) => {
      if (isShowMoreBtn(el)) candidates.push(el);
    });
    // 再在局部父容器中查找（限一层，避免点到其他推文的按钮）
    if (candidates.length === 0) {
      const parent = tweetText.parentElement;
      if (parent) {
        parent.querySelectorAll(':scope > button, :scope > [role="button"]').forEach((el) => {
          if (isShowMoreBtn(el) && !isShowOriginalBtn(el)) candidates.push(el);
        });
      }
    }
    if (candidates.length === 0) return null;
    const btn = candidates[0];
    const prevHTML = tweetText.innerHTML;
    nativeClick(btn);
    await waitForChange(tweetText, prevHTML);
    return btn;
  }

  /* ==================== 核心处理 ==================== */

  const activePendingKeys = new WeakMap(); // tweetText → 当前使用的 pendingKey（供硬超时清理）

  function cleanupPending(tt, pendingKey, success) {
    pending.delete(tt);
    activePendingKeys.delete(tt);
    if (success && pendingKey) pendingTexts.delete(pendingKey);
  }

  /** 将记录写入 records + recordNodes */
  function setRecord(node, rec) {
    records.set(node, rec);
    recordNodes.add(node);
  }

  /** 从 records + recordNodes 中删除 */
  function deleteRecord(node) {
    records.delete(node);
    recordNodes.delete(node);
  }

  /** 包装 processPair 并设置超时保护，防止单条推文阻塞整个 scan */
  function processPairWithTimeout(btn, tweetText) {
    let timer;
    const work = processPair(btn, tweetText).finally(() => clearTimeout(timer));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        dbg('processPair: HARD TIMEOUT (', PROCESS_PAIR_TIMEOUT, 'ms)');
        // 释放重试冷却让下次 scan 可以重试；不清 pending —— 等原 processPair 结束后
        // 再清理（cleanupPending），避免原操作仍在跑时 double-run。
        const key = activePendingKeys.get(tweetText);
        if (key) pendingTexts.delete(key);
        resolve();
      }, PROCESS_PAIR_TIMEOUT);
    });
    return Promise.race([work, timeout]);
  }

  async function processPair(btn, tweetText) {
    if (records.has(tweetText) || pending.has(tweetText)) { dbg('processPair: SKIP (pending/recorded)'); return; }
    if (hasThirdPartyTranslation(tweetText)) { dbg('processPair: SKIP (third-party)'); return; }

    const tweetId = getTweetId(tweetText);
    const textKey = norm(tweetText.textContent).slice(0, 64);
    const pendingKey = makePendingKey(tweetId, textKey); // Bug2: 联合 key
    if (isPendingText(pendingKey)) { dbg('processPair: SKIP (pendingTexts)'); return; }
    pendingTexts.set(pendingKey, Date.now());
    pending.add(tweetText);
    activePendingKeys.set(tweetText, pendingKey);
    dbg('processPair: START', { tweetId, type: isShowTranslationBtn(btn) ? '显示翻译' : '显示原文', text: tweetText.textContent.slice(0, 40) });

    // ---------- UserDescription 专用路径 ----------
    if (tweetText.matches('div[data-testid="UserDescription"]')) {
      let node = tweetText;
      const scope = getLocalScope(node);

      if (isShowTranslationBtn(btn)) {
        const origHTML = node.innerHTML;
        nativeClick(btn);
        const transHTML = await waitForReplacement(node, origHTML, 'UserDescription');
        if (transHTML && transHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }
        if (!transHTML) { dbg('processPair: FAIL (UserDescription translate timeout)'); failedBtns.set(btn, Date.now()); cleanupPending(tweetText, pendingKey); return; }
        node = scope.querySelector('div[data-testid="UserDescription"]') || node;
        if (!enabled) { cleanupPending(tweetText, pendingKey); return; }
        const rec = { tweetId, transHTML, origHTML, note: extractNote(btn), origText: htmlToText(origHTML), head: htmlToText(origHTML).slice(0, 32), transHead: htmlToText(transHTML).slice(0, 32) };
        setRecord(node, rec);
        buildAndInsert(node, rec);
        cleanupPending(tweetText, pendingKey, true);
        return;
      }

      const transHTML = node.innerHTML;
      const note = extractNote(btn);
      nativeClick(btn);
      const origHTML = await waitForReplacement(node, transHTML, 'UserDescription');
      if (origHTML && origHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }
      if (!origHTML) { dbg('processPair: FAIL (UserDescription original timeout)'); failedBtns.set(btn, Date.now()); cleanupPending(tweetText, pendingKey); return; }
      node = scope.querySelector('div[data-testid="UserDescription"]') || node;
      if (!enabled) { try { node.innerHTML = transHTML; } catch (_) {} cleanupPending(tweetText, pendingKey); return; }
      const rec = { tweetId, transHTML, origHTML, note, origText: htmlToText(origHTML), head: htmlToText(origHTML).slice(0, 32), transHead: htmlToText(transHTML).slice(0, 32) };
      setRecord(node, rec);
      buildAndInsert(node, rec);
      cleanupPending(tweetText, pendingKey, true);
      return;
    }

    // ---------- tweetText 正常路径 ----------

    if (isShowTranslationBtn(btn)) {
      await expandShowMore(tweetText);
      const origHTML = tweetText.innerHTML;
      nativeClick(btn);
      let transHTML = await waitForChange(tweetText, origHTML);
      if (transHTML && transHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }
      if (transHTML) { await expandShowMore(tweetText); transHTML = tweetText.innerHTML; }
      if (!transHTML) { dbg('processPair: FAIL (translate timeout)'); failedBtns.set(btn, Date.now()); cleanupPending(tweetText, pendingKey); return; }

      const revertBtn = findShowOriginalBtnNear(tweetText);
      let reverted = false;
      if (revertBtn) {
        nativeClick(revertBtn);
        reverted = !!(await waitForChange(tweetText, transHTML));
      }
      if (!reverted) { try { tweetText.innerHTML = origHTML; } catch (_) {} }
      if (!enabled) { cleanupPending(tweetText, pendingKey); return; }

      const rec = { tweetId, transHTML, origHTML, note: extractNote(btn), origText: htmlToText(origHTML), head: htmlToText(origHTML).slice(0, 32), transHead: htmlToText(transHTML).slice(0, 32) };
      setRecord(tweetText, rec);
      buildAndInsert(tweetText, rec);
      cleanupPending(tweetText, pendingKey, true);
      return;
    }

    // 显示原文按钮
    await expandShowMore(tweetText);
    const transHTML = tweetText.innerHTML;
    const note = extractNote(btn);
    nativeClick(btn);
    let origHTML = await waitForChange(tweetText, transHTML);
    if (origHTML && origHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }
    if (origHTML) { await expandShowMore(tweetText); origHTML = tweetText.innerHTML; }
    if (!origHTML) { dbg('processPair: FAIL (original timeout)'); failedBtns.set(btn, Date.now()); cleanupPending(tweetText, pendingKey); return; }
    if (!enabled) { try { tweetText.innerHTML = transHTML; } catch (_) {} cleanupPending(tweetText, pendingKey); return; }

    const rec = { tweetId, transHTML, origHTML, note, origText: htmlToText(origHTML), head: htmlToText(origHTML).slice(0, 32), transHead: htmlToText(transHTML).slice(0, 32) };
    setRecord(tweetText, rec);
    buildAndInsert(tweetText, rec);
    cleanupPending(tweetText, pendingKey, true);
  }

  /* ==================== 校验 ==================== */

  /** Issue B: 增强校验 — 优先用 innerHTML 比较，head 作为 fallback */
  function isValid(tweetText) {
    const rec = records.get(tweetText);
    if (!rec) return false;

    if (hasThirdPartyTranslation(tweetText)) {
      tweetText.classList.remove('xtl-hidden');
      const wrap = tweetText.nextElementSibling;
      if (wrap && wrap.classList && wrap.classList.contains('xtl-wrap')) wrap.remove();
      deleteRecord(tweetText);
      return false;
    }

    // 用 tweetId 做主要身份校验（虚拟列表复用时 tweetId 会变）
    const currentId = getTweetId(tweetText);
    if (rec.tweetId && currentId && currentId !== rec.tweetId) {
      dbg('isValid: FAIL (tweetId mismatch)', { expected: rec.tweetId, current: currentId });
      tweetText.classList.remove('xtl-hidden');
      removeAllWraps(tweetText);
      deleteRecord(tweetText);
      return false;
    }

    // 查找 wrap（向后遍历 sibling，兼容 React 插入的额外层）
    let foundWrap = null;
    let sib = tweetText.nextElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      if (sib.classList && sib.classList.contains('xtl-wrap')) { foundWrap = sib; break; }
      sib = sib.nextElementSibling;
    }
    const hasWrap = !!foundWrap;

    // Issue B: 优先用 innerHTML 精确比较，fallback 到 head 前缀
    const currentHTML = tweetText.innerHTML;
    const htmlMatch = (currentHTML === rec.origHTML) || (currentHTML === rec.transHTML);
    const headOK = htmlMatch || norm(tweetText.textContent).startsWith(rec.head) || (rec.transHead && norm(tweetText.textContent).startsWith(rec.transHead));

    if (hasWrap && headOK) return true;

    // 双语块缺失或内容不匹配
    if (foundWrap) foundWrap.remove();
    tweetText.classList.remove('xtl-hidden');
    dbg('isValid: FAIL (stale)', { hasWrap, headOK, htmlMatch });
    deleteRecord(tweetText);
    return false;
  }

  /* ==================== 扫描 ==================== */

  async function scan(isRetry) {
    if (!enabled) return;
    if (!isRetry) retryRemaining = 3;
    let hasRetry = false;
    const candidates = document.querySelectorAll('article [role="button"], article button, [role="button"], button');
    dbg('scan: candidates', candidates.length);

    for (const el of candidates) {
      // Bug5: failedBtns 带时间戳，超过 FAILED_BTN_TTL 后允许重试
      const failTs = failedBtns.get(el);
      if (failTs !== undefined) {
        if (Date.now() - failTs < FAILED_BTN_TTL) continue;
        failedBtns.delete(el); // 已过期，允许重试
      }

      const isOrig = isShowOriginalBtn(el);
      const isTrans = isShowTranslationBtn(el);
      if (!isOrig && !isTrans) continue;

      const tt = findTweetTextForBtn(el);
      if (!tt) { hasRetry = true; continue; }
      if (pending.has(tt)) continue;
      if (isValid(tt)) continue;
      if (hasWrapNear(tt)) continue;

      const tweetId = getTweetId(tt);

      // Bug2: 文本冷却用联合 key（防重入）
      const k = norm(tt.textContent).slice(0, 64);
      const pendingKey = makePendingKey(tweetId, k);
      if (isPendingText(pendingKey)) continue;

      await processPairWithTimeout(el, tt);
    }

    if (hasRetry && retryRemaining > 0) {
      retryRemaining--;
      dbg('scan: retry in 300ms (remaining:', retryRemaining, ')');
      await new Promise(r => setTimeout(r, 300));
      scanScheduled = false;
      await scan(true);
    }
  }

  /* ==================== 开关控制 ==================== */

  function restoreToTranslationOnly() {
    pendingTexts.clear();
    failedBtns = new WeakMap();
    retryRemaining = 3;

    document.querySelectorAll('.xtl-wrap').forEach((wrap) => {
      const tt = wrap.previousElementSibling;
      if (isTweetText(tt)) {
        tt.classList.remove('xtl-hidden');
        // BUG FIX: DO NOT manually set innerHTML to avoid React desync.
      }
      wrap.remove();
    });

    document.querySelectorAll('div[data-testid="tweetText"], div[data-testid="UserDescription"]').forEach((tt) => {
      if (!tt.classList.contains('xtl-hidden')) return;
      const parent = tt.parentElement;
      if (!parent) return;
      Array.from(parent.children).forEach((child) => {
        if (child !== tt && child.classList && child.classList.contains('xtl-wrap')) child.remove();
      });
      tt.classList.remove('xtl-hidden');
    });

    // BUG FIX: Do not clear recordNodes so rebuildAll can restore instantly.
  }

  function rebuildAll() {
    // 第一阶段：清理断开的节点
    for (const tt of recordNodes) {
      if (!tt.isConnected) { recordNodes.delete(tt); records.delete(tt); }
    }
    // 第二阶段：重建双语块
    for (const tt of recordNodes) {
      const rec = records.get(tt);
      if (!rec) { recordNodes.delete(tt); continue; }
      if (hasThirdPartyTranslation(tt)) continue;

      const currentId = getTweetId(tt);
      if (rec.tweetId && currentId && currentId !== rec.tweetId) {
        tt.classList.remove('xtl-hidden');
        removeAllWraps(tt);
        deleteRecord(tt);
        continue;
      }

      tt.classList.remove('xtl-hidden');
      try { tt.innerHTML = rec.origHTML; } catch (_) {}
      removeAllWraps(tt);
      buildAndInsert(tt, rec);
    }
  }

  /* ==================== 收藏推文 ==================== */

  const SAVE_LABELS = {
    zh_CN: { save: '保存推文', unsave: '取消保存推文' },
    en: { save: 'Save tweet', unsave: 'Remove saved tweet' },
  };
  let contentLang = 'zh_CN';
  let saveSyncScheduled = false;
  let saveWriteQueue = Promise.resolve();
  let extensionContextAlive = true;
  let extensionObserver = null;
  let extensionTimers = [];

  /** 扩展被重载后，旧 content script 里的 chrome.* 调用会一直抛错。彻底停机。 */
  function shutdownExtensionContext() {
    if (!extensionContextAlive) return;
    extensionContextAlive = false;
    try { if (extensionObserver) extensionObserver.disconnect(); } catch (_) {}
    extensionTimers.forEach((id) => { try { clearInterval(id); } catch (_) {} });
    extensionTimers = [];
    document.querySelectorAll('.xtl-save-btn').forEach((btn) => btn.remove());
  }

  function handleStorageError(error) {
    if (/Extension context invalidated/i.test(error && error.message || String(error))) {
      console.info('[XTL] extension context invalidated - stopping old content script. Refresh the page.');
      shutdownExtensionContext();
      return;
    }
    // 收藏失败要有可见线索，否则用户只会看到星标没反应
    console.warn('[XTL] storage error:', error);
  }

  function getSavedTweets(callback) {
    if (!extensionContextAlive) return false;
    try {
      return XTLSavedTweets.safeStorageGet(
        chrome.storage.local,
        { savedTweets: [] },
        (data) => {
          if (extensionContextAlive) callback(data || {});
        },
        handleStorageError,
      );
    } catch (error) {
      handleStorageError(error);
      return false;
    }
  }

  function tweetIdForArticle(article) {
    const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
      .filter((candidate) => candidate.closest('article') === article);
    const permalink = links.find((link) => link.querySelector('time')) || links[0];
    const match = permalink && permalink.href.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function tweetTextForArticle(article) {
    return Array.from(article.querySelectorAll('div[data-testid="tweetText"]'))
      .find((node) => node.closest('article') === article) || null;
  }

  function findGrokControl(article) {
    const candidates = article.querySelectorAll('button, [role="button"], [data-testid]');
    for (const candidate of candidates) {
      if (candidate.closest('article') !== article) continue;
      const label = [
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('data-testid'),
        candidate.getAttribute('title'),
        candidate.getAttribute('href'),
        candidate.innerText,
      ].join(' ');
      if (!/grok/i.test(label)) continue;
      return candidate.matches('button, [role="button"]')
        ? candidate
        : candidate.closest('button, [role="button"]') || candidate;
    }
    return null;
  }

  function placeSaveButton(article, button) {
    // 时间线: 旁边 Grok 控件(插入为兄弟节点)
    const grokControl = findGrokControl(article);
    if (grokControl && grokControl.parentElement) {
      if (button.parentElement !== grokControl.parentElement || button.nextElementSibling !== grokControl) {
        grokControl.parentElement.insertBefore(button, grokControl);
      }
      return;
    }

    // 时间线: 操作栏(追加到组末尾)
    const group = Array.from(article.querySelectorAll('[role="group"]'))
      .find((node) => node.closest('article') === article);
    const parent = group || article;
    if (button.parentElement !== parent || parent.lastElementChild !== button) parent.appendChild(button);
  }

  function updateSaveButton(button, isSaved) {
    const labels = SAVE_LABELS[contentLang] || SAVE_LABELS.zh_CN;
    button.textContent = isSaved ? '★' : '☆';
    button.setAttribute('aria-label', isSaved ? labels.unsave : labels.save);
    button.title = isSaved ? labels.unsave : labels.save;
    button.classList.toggle('xtl-saved', isSaved);
    button.dataset.saved = String(isSaved);
  }

  function scheduleSaveButtonSync() {
    if (!extensionContextAlive || saveSyncScheduled) return;
    saveSyncScheduled = true;
    setTimeout(() => {
      saveSyncScheduled = false;
      syncSaveButtons();
    }, 250);
  }

  function syncSaveButtons() {
    if (!extensionContextAlive) return;
    try {
      const buttons = [];
      document.querySelectorAll('article').forEach((article) => {
        const tweetId = tweetIdForArticle(article);
        if (!tweetId) return;
        // 长文(文章页)没有 data-testid="tweetText" — 用户不再在长文上收藏, 去掉星并清除旧星
        if (!tweetTextForArticle(article)) {
          Array.from(article.querySelectorAll('.xtl-save-btn')).forEach((existing) => existing.remove());
          return;
        }
        let button = Array.from(article.querySelectorAll('.xtl-save-btn'))
          .find((candidate) => candidate.closest('article') === article);
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.className = 'xtl-save-btn';
        }
        // 点击事件统一在 document 上委托处理，避免 React 重渲染替换按钮后监听器失效
        button.dataset.tweetId = tweetId;
        placeSaveButton(article, button);
        buttons.push(button);
      });

      getSavedTweets((data) => {
        if (!extensionContextAlive) return;
        const items = Array.isArray(data.savedTweets) ? data.savedTweets : [];
        const savedIds = new Set(items.map((item) => item && item.id));
        buttons.forEach((button) => updateSaveButton(button, savedIds.has(button.dataset.tweetId)));
      });
    } catch (error) {
      handleStorageError(error);
    }
  }

  function saveArticleTweet(article, button, expectedSaved) {
    if (!extensionContextAlive) return;
    try {
      const tweetId = button.dataset.tweetId;
      if (!tweetId) return;
      const tweetText = tweetTextForArticle(article);
      const record = tweetText ? records.get(tweetText) : null;
      const origHTML = record ? record.origHTML : (tweetText ? tweetText.innerHTML : '');
      const transHTML = record ? record.transHTML : '';
      const authorNode = Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
        .find((node) => node.closest('article') === article);
      const tweet = {
        id: tweetId,
        url: `https://x.com/i/status/${tweetId}`,
        author: norm(authorNode && authorNode.innerText) || '',
        text: htmlToText(origHTML) || (tweetText ? norm(tweetText.textContent) : ''),
        translation: transHTML ? htmlToText(transHTML) : '',
        savedAt: Date.now(),
      };

      saveWriteQueue = saveWriteQueue.then(async () => {
        if (!extensionContextAlive) return;
        try {
          const data = await chrome.storage.local.get({ savedTweets: [] });
          const result = XTLSavedTweets.toggle(data.savedTweets || [], tweet);
          await chrome.storage.local.set({ savedTweets: result.items });
          if (extensionContextAlive) updateSaveButton(button, result.saved);
        } catch (error) {
          if (expectedSaved !== undefined) updateSaveButton(button, !expectedSaved);
          handleStorageError(error);
        }
      }).catch(handleStorageError);
    } catch (error) {
      if (expectedSaved !== undefined) updateSaveButton(button, !expectedSaved);
      handleStorageError(error);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.savedTweets) scheduleSaveButtonSync();
  });

  /* ==================== 事件监听 ==================== */

  // 单个委托监听器：无论按钮何时被 React 重建都能响应，且点击时重新读取所属 article
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    const saveBtn = target.closest('.xtl-save-btn');
    if (saveBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const article = saveBtn.closest('article');
      if (!article) return;
      const tweetId = saveBtn.dataset.tweetId || tweetIdForArticle(article) || '';
      if (!tweetId) return; // 拿不到推文 ID 时不做任何视觉变更，避免假收藏状态
      saveBtn.dataset.tweetId = tweetId;
      // 先给出即时反馈；写入失败时再回滚
      const expected = saveBtn.dataset.saved !== 'true';
      updateSaveButton(saveBtn, expected);
      saveArticleTweet(article, saveBtn, expected);
      return;
    }

    const note = target.closest('.xtl-note');
    if (!note) return;
    const wrap = note.parentElement;
    if (!wrap) return;
    wrap.classList.toggle('xtl-collapsed');
    note.setAttribute('aria-expanded', !wrap.classList.contains('xtl-collapsed'));
  }, true);

  // 处理来自 popup / background 的即时控制消息（storage.onChanged 仍作为兜底）
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'XTL_TOGGLE' && !extensionContextAlive) return;
    if (msg.type === 'XTL_TOGGLE') {
      enabled = !!msg.enabled;
      if (enabled) { rebuildAll(); scheduleScan(); } else { restoreToTranslationOnly(); }
    } else if (msg.type === 'XTL_MODE') {
      const newMode = msg.mode === 'block' ? 'block' : 'interleave';
      if (newMode !== mode) { mode = newMode; if (enabled) rebuildAll(); }
    } else if (msg.type === 'XTL_TRANS_COLOR') {
      applyTransColor(msg.transColor);
    }
  });

  /* ==================== 初始化 ==================== */

  let scanScheduled = false;
  let scanning = false;
  let scanQueued = false; // Issue A: 排队机制，避免丢失 mutation
  function scheduleScan() {
    if (scanning) {
      scanQueued = true; // 正在扫描中，标记需要再扫一次
      return;
    }
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(async () => {
      scanScheduled = false;
      if (scanning) { scanQueued = true; return; }
      scanning = true;
      try { await scan(); } catch (e) { dbg('scan error:', e); }
      scanning = false;
      // Issue A: 如果扫描期间有新的 mutation 排队，立即再扫一次
      if (scanQueued) {
        scanQueued = false;
        scheduleScan();
      }
    }, 120);
  }

  extensionObserver = new MutationObserver(() => { scheduleScan(); scheduleSaveButtonSync(); });
  if (document.body) extensionObserver.observe(document.body, { childList: true, subtree: true });
  dbg('init: MutationObserver attached');
  scheduleScan();
  scheduleSaveButtonSync();
  extensionTimers.push(setInterval(() => { scheduleScan(); scheduleSaveButtonSync(); }, 2000));

  // 定期清理
  function cleanupExpiredEntries() {
    const now = Date.now();
    for (const [k, ts] of pendingTexts) { if (now - ts > PENDING_TTL) pendingTexts.delete(k); }
    // 清理断开的 recordNodes
    for (const tt of recordNodes) { if (!tt.isConnected) { recordNodes.delete(tt); records.delete(tt); } }
  }
  extensionTimers.push(setInterval(cleanupExpiredEntries, 15000));

  console.info('[XTL] content script ready - build 2026-11-20-audit');

  (function loadInitialSettings() {
    if (!extensionContextAlive) return;
    let storage;
    try { storage = chrome.storage.local; } catch (error) { handleStorageError(error); return; }
    XTLSavedTweets.safeStorageGet(storage, ['enabled', 'mode', 'transColor', 'lang'], (d) => {
      if (!extensionContextAlive) return;
      enabled = d.enabled !== false;
      mode = d.mode === 'block' ? 'block' : 'interleave';
      applyTransColor(d.transColor);
      applyFoldTitle(d.lang);
      contentLang = d.lang === 'en' ? 'en' : 'zh_CN';
      dbg('init: storage loaded', { enabled, mode });
      scheduleScan();
      scheduleSaveButtonSync();
    }, handleStorageError);
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) {
      const newEnabled = !!changes.enabled.newValue;
      if (newEnabled !== enabled) {
        enabled = newEnabled;
        dbg('storage toggle:', enabled);
        if (enabled) { rebuildAll(); scheduleScan(); } else { restoreToTranslationOnly(); }
      }
    }
    if (changes.mode) {
      const newMode = changes.mode.newValue === 'block' ? 'block' : 'interleave';
      if (newMode !== mode) {
        mode = newMode;
        dbg('storage mode:', mode);
        if (enabled) rebuildAll();
      }
    }
    if (changes.transColor) {
      applyTransColor(changes.transColor.newValue);
    }
    if (changes.lang) {
      applyFoldTitle(changes.lang.newValue);
      contentLang = changes.lang.newValue === 'en' ? 'en' : 'zh_CN';
      scheduleSaveButtonSync();
    }
  });
})();
