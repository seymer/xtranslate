const list = document.getElementById('list');
const summary = document.getElementById('summary');
const viewToggle = document.getElementById('viewToggle');
const exportSelectedBtn = document.getElementById('exportSelectedBtn');
const exportAllBtn = document.getElementById('exportAllBtn');
let messages = {};
let allTweets = [];
let view = 'due';
let updateQueue = Promise.resolve();
const selected = new Set(); // 选中用于「导出选中」的收藏 ID

function t(key, value) {
  const s = messages[key] || key;
  return value === undefined ? s : s.replace('$1', String(value));
}

async function loadLanguage() {
  let lang = 'zh_CN';
  try { ({ lang = 'zh_CN' } = await chrome.storage.local.get('lang')); } catch (_) { /* use default */ }
  const locale = lang === 'en' ? 'en' : 'zh_CN';
  try {
    const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
    const json = await response.json();
    messages = Object.fromEntries(Object.entries(json).map(([key, item]) => [key, item.message]));
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    document.title = t('reviewTitle');
  } catch (_) { /* Keep the built-in Chinese labels if locale loading fails. */ }
}

function formatDate(timestamp) {
  const locale = document.documentElement.lang === 'en' ? 'en-US' : 'zh-CN';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function createButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function appendActions(card, tweet) {
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const selectCb = document.createElement('input');
  selectCb.type = 'checkbox';
  selectCb.className = 'export-select';
  selectCb.checked = selected.has(tweet.id);
  selectCb.title = t('exportSelect');
  selectCb.setAttribute('aria-label', t('exportSelect'));
  selectCb.addEventListener('change', () => {
    if (selectCb.checked) selected.add(tweet.id);
    else selected.delete(tweet.id);
    updateExportButtons();
  });
  actions.appendChild(selectCb);

  if (view === 'due') {
    actions.appendChild(createButton(t('markReviewed'), 'action-btn primary', async () => {
      await updateSavedTweets((items) => XTLSavedTweets.markReviewed(items, tweet.id));
    }));
  }
  actions.appendChild(createButton(t('removeSaved'), 'action-btn', async () => {
    await updateSavedTweets((items) => XTLSavedTweets.remove(items, tweet.id));
  }));
  card.appendChild(actions);
}

function appendOriginalFallback(card, text) {
  const originalLabel = document.createElement('strong');
  originalLabel.textContent = `${t('originalLabel')}:`;
  const original = document.createElement('p');
  original.className = 'tweet-text';
  original.textContent = text || '';
  card.append(originalLabel, original);
}

function appendTranslationFallback(card, translation, buttonClass) {
  const translationNode = document.createElement('p');
  translationNode.className = 'translation';
  translationNode.hidden = true;
  translationNode.textContent = `${t('translationLabel')}: ${translation || ''}`;
  const button = createButton(t('showTranslation'), buttonClass, () => {
    translationNode.hidden = !translationNode.hidden;
    button.textContent = t(translationNode.hidden ? 'showTranslation' : 'hideTranslation');
  });
  card.append(button, translationNode);
}

function buildInterleave(card, tweet) {
  const origSents = XTLText.splitSentences(tweet.text || '').filter((s) => !XTLText.isPureUrl(s));
  const transSents = XTLText.splitSentences(tweet.translation || '').filter((s) => !XTLText.isPureUrl(s));
  if (origSents.length === 0 || origSents.length !== transSents.length) return false;

  const interleave = document.createElement('div');
  interleave.className = 'interleave';
  origSents.forEach((orig, i) => {
    const pair = document.createElement('div');
    pair.className = 'pair';
    const origP = document.createElement('p');
    origP.className = 'orig';
    origP.textContent = orig;
    const transP = document.createElement('p');
    transP.className = 'trans';
    transP.textContent = transSents[i];
    transP.hidden = true; // 默认隐藏已保存译文，可展开对照
    pair.append(origP, transP);
    interleave.appendChild(pair);
  });

  const showButton = createButton(t('showTranslation'), 'translation-toggle', () => {
    const first = interleave.querySelector('.trans');
    if (!first) return;
    const reveal = first.hidden;
    interleave.querySelectorAll('.trans').forEach((el) => { el.hidden = !reveal; });
    showButton.textContent = t(reveal ? 'showTranslation' : 'hideTranslation');
  });
  card.append(interleave, showButton);
  return true;
}

function makeCard(tweet) {
  const card = document.createElement('article');
  card.className = 'tweet-card';

  const meta = document.createElement('div');
  meta.className = 'tweet-meta';
  const author = document.createElement('strong');
  author.textContent = tweet.author || t('unknownAuthor');
  const savedDate = document.createElement('span');
  savedDate.textContent = t('savedOn', formatDate(tweet.savedAt));
  const metaLeft = document.createElement('div');
  metaLeft.append(author, document.createTextNode(' · '), savedDate);
  const openLink = document.createElement('a');
  openLink.className = 'tweet-link';
  openLink.href = /^https:\/\/(x|twitter)\.com\//.test(tweet.url || '') ? tweet.url : '#';
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.textContent = t('openTweet');
  meta.append(metaLeft, openLink);
  card.appendChild(meta);

  if (tweet.translation) {
    if (!buildInterleave(card, tweet)) {
      appendOriginalFallback(card, tweet.text);
      appendTranslationFallback(card, tweet.translation, 'translation-toggle');
    }
  } else {
    appendOriginalFallback(card, tweet.text);
  }

  appendActions(card, tweet);
  return card;
}

function render() {
  const items = view === 'due' ? XTLSavedTweets.dueToday(allTweets) : allTweets;
  list.replaceChildren();
  const dueCount = XTLSavedTweets.dueToday(allTweets).length;
  summary.textContent = view === 'due' ? `${dueCount} · ${t('reviewToday')}` : `${allTweets.length} · ${t('reviewAll')}`;
  viewToggle.textContent = t(view === 'due' ? 'reviewAll' : 'reviewToday');

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t(view === 'due' ? (allTweets.length ? 'reviewDone' : 'reviewEmpty') : 'reviewEmptyAll');
    list.appendChild(empty);
    return;
  }
  items.forEach((tweet) => list.appendChild(makeCard(tweet)));
}

async function refresh() {
  const data = await chrome.storage.local.get({ savedTweets: [] });
  const items = Array.isArray(data.savedTweets) ? data.savedTweets : [];
  allTweets = items.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  // 清理已被删除/移动的选中项
  for (const id of selected) if (!allTweets.some((t) => t.id === id)) selected.delete(id);
  updateExportButtons();
  render();
}

function updateExportButtons() {
  exportSelectedBtn.disabled = selected.size === 0;
}

function exportTweets(items) {
  if (!items || items.length === 0) return;
  const text = XTLSavedTweets.formatExportText(items, t);
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const filename = `xtranslate-saved-${stamp}.txt`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

exportSelectedBtn.addEventListener('click', () => {
  exportTweets(allTweets.filter((t) => selected.has(t.id)));
});
exportAllBtn.addEventListener('click', () => exportTweets(allTweets));

async function updateSavedTweets(transform) {
  const operation = updateQueue.then(async () => {
    const data = await chrome.storage.local.get({ savedTweets: [] });
    const items = Array.isArray(data.savedTweets) ? data.savedTweets : [];
    await chrome.storage.local.set({ savedTweets: transform(items) });
    await refresh();
  });
  updateQueue = operation.catch(() => {});
  await operation.catch(() => {});
}

viewToggle.addEventListener('click', () => {
  view = view === 'due' ? 'all' : 'due';
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.savedTweets) refresh();
});

(async () => {
  await loadLanguage();
  await refresh();
})();
