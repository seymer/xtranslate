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
  const PROCESS_PAIR_TIMEOUT = 5000; // 单条 processPair 最大耗时，防止阻塞整个 scan
  const PENDING_TTL = 30000;
  const PROCESSED_TTL = 60000;
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
  const processedIds = new Map();     // tweetId → timestamp（60秒去重）
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

  function isProcessedId(id) {
    if (!id) return false;
    const ts = processedIds.get(id);
    if (ts === undefined) return false;
    if (Date.now() - ts > PROCESSED_TTL) { processedIds.delete(id); return false; }
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
      const link = article.querySelector('a[href*="/status/"]');
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
  function isPureUrl(s) { return PURE_URL_RE.test(s.trim()); }

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
      n.title = '点击折叠 / 展开译文';
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

  function createBlockWrap(rec, bodyClass, bodyHTML) {
    const block = document.createElement('div');
    block.className = 'xtl-wrap';
    if (rec.note) {
      const n = document.createElement('div');
      n.className = 'xtl-note';
      n.textContent = rec.note;
      n.title = '点击折叠 / 展开译文';
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

  function cleanupPending(tt, pendingKey, success) {
    pending.delete(tt);
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
    return Promise.race([
      processPair(btn, tweetText),
      new Promise((resolve) => setTimeout(() => {
        dbg('processPair: HARD TIMEOUT (', PROCESS_PAIR_TIMEOUT, 'ms)');
        pending.delete(tweetText);
        resolve();
      }, PROCESS_PAIR_TIMEOUT)),
    ]);
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
        if (tweetId) processedIds.set(tweetId, Date.now());
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
      if (tweetId) processedIds.set(tweetId, Date.now());
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
      if (tweetId) processedIds.set(tweetId, Date.now());
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
    if (tweetId) processedIds.set(tweetId, Date.now());
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

      // Bug1: tweetId 去重 — 但如果当前 tweetText 没有 wrap，说明 DOM 被重建了，允许重新处理
      const tweetId = getTweetId(tt);
      if (tweetId && isProcessedId(tweetId) && hasWrapNear(tt)) { dbg('scan: SKIP (processed tweetId)', tweetId); continue; }

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
    processedIds.clear();
    failedBtns = new WeakMap();
    retryRemaining = 3;

    document.querySelectorAll('.xtl-wrap').forEach((wrap) => {
      const tt = wrap.previousElementSibling;
      if (isTweetText(tt)) {
        tt.classList.remove('xtl-hidden');
        const rec = records.get(tt);
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

  /* ==================== 事件监听 ==================== */

  document.addEventListener('click', (e) => {
    const note = e.target && e.target.closest && e.target.closest('.xtl-note');
    if (!note) return;
    const wrap = note.parentElement;
    wrap.classList.toggle('xtl-collapsed');
    note.setAttribute('aria-expanded', !wrap.classList.contains('xtl-collapsed'));
  }, true);

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

  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  dbg('init: MutationObserver attached');
  scheduleScan();
  setInterval(scheduleScan, 2000);

  // 定期清理
  function cleanupExpiredEntries() {
    const now = Date.now();
    for (const [k, ts] of pendingTexts) { if (now - ts > PENDING_TTL) pendingTexts.delete(k); }
    for (const [k, ts] of processedIds) { if (now - ts > PROCESSED_TTL) processedIds.delete(k); }
    // 清理断开的 recordNodes
    for (const tt of recordNodes) { if (!tt.isConnected) { recordNodes.delete(tt); records.delete(tt); } }
  }
  setInterval(cleanupExpiredEntries, 15000);

  chrome.storage.local.get(['enabled', 'mode'], (d) => {
    enabled = d.enabled !== false;
    mode = d.mode === 'block' ? 'block' : 'interleave';
    dbg('init: storage loaded', { enabled, mode });
    scheduleScan();
  });

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
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    dbg('message:', msg.type, msg);
  });
})();
