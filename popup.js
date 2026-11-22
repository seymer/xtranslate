// X 双语对照翻译 - Popup 开关、模式、颜色、语言逻辑
const toggle = document.getElementById('toggle');
const modeBtns = document.querySelectorAll('.mode-btn');
const transColor = document.getElementById('transColor');
const blurMode = document.getElementById('blurMode');
const maskScope = document.getElementById('maskScope');
const maskStyle = document.getElementById('maskStyle');
const glossEnabled = document.getElementById('glossEnabled');
const langBtns = document.querySelectorAll('.lang-btn');
const reviewButton = document.getElementById('reviewButton');

let manualLang = null;
let reviewMessages = {};

function updateReviewButton(items) {
  const saved = Array.isArray(items) ? items : [];
  const dueCount = XTLSavedTweets.dueToday(saved).length;
  const template = reviewMessages.reviewButton || '每日复习（$1）';
  reviewButton.textContent = template.replace('$1', String(dueCount));
}

chrome.storage.local.get({ savedTweets: [] }, (data) => updateReviewButton(data.savedTweets));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.savedTweets) updateReviewButton(changes.savedTweets.newValue);
});
reviewButton.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
});

// 注入本地化文本；手动选择语言时用 _locales 对应文件覆盖
function applyI18n(key, msg) {
  if (!msg) return;
  document.querySelectorAll('[data-i18n="' + key + '"]').forEach((el) => {
    el.textContent = msg;
  });
}

// 手动语言：加载 _locales/<lang>/messages.json 并应用全部文本
async function setManualLang(lang) {
  try {
    const res = await fetch(chrome.runtime.getURL('_locales/' + lang + '/messages.json'));
    const json = await res.json();
    reviewMessages = Object.fromEntries(Object.entries(json).map(([key, value]) => [key, value.message]));
    for (const [key, v] of Object.entries(json)) applyI18n(key, v.message);
    chrome.storage.local.get({ savedTweets: [] }, (data) => updateReviewButton(data.savedTweets));
  } catch (_) { /* 加载失败则保持浏览器语言 */ }
}

// 初始化：读取当前状态（默认开启 + 逐句模式 + 默认蓝 + 不模糊 + 自动语言）
chrome.storage.local.get(['enabled', 'mode', 'transColor', 'blurMode', 'maskScope', 'maskStyle', 'glossEnabled', 'lang'], (d) => {
  toggle.checked = d.enabled !== false;
  const currentMode = d.mode === 'block' ? 'block' : 'interleave';
  modeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
  // 旧版“blue”选项已并入默认蓝色，旧数据映射为 default
  transColor.value = (d.transColor === 'text' || d.transColor === 'green') ? d.transColor : 'default';
  blurMode.value = (d.blurMode === 'orig' || d.blurMode === 'trans') ? d.blurMode : 'none';
  maskScope.value = d.maskScope === 'sentence' ? 'sentence' : 'keyword';
  const maskStyles = ['blur-soft', 'blur', 'blur-strong', 'bar', 'dotted'];
  maskStyle.value = maskStyles.includes(d.maskStyle) ? d.maskStyle : 'blur';
  glossEnabled.checked = d.glossEnabled !== false;

  manualLang = d.lang === 'zh_CN' || d.lang === 'en' ? d.lang : 'zh_CN';
  langBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === manualLang);
  });
  setManualLang(manualLang);
});

// 向当前页面的 content script 发消息
function sendMessage(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, () => {
      if (chrome.runtime.lastError) { /* content script 可能未就绪 */ }
    });
  });
}

// 切换开关
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ enabled });
  sendMessage({ type: 'XTL_TOGGLE', enabled });
});

// 切换显示模式
modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    modeBtns.forEach((b) => b.classList.toggle('active', b === btn));
    chrome.storage.local.set({ mode });
    sendMessage({ type: 'XTL_MODE', mode });
  });
});

// 切换译文颜色
transColor.addEventListener('change', () => {
  const color = transColor.value;
  chrome.storage.local.set({ transColor: color });
  sendMessage({ type: 'XTL_TRANS_COLOR', transColor: color });
});

// 切换模糊显示：同一时间只允许原文或译文其中一侧模糊
blurMode.addEventListener('change', () => {
  const mode = blurMode.value === 'orig' || blurMode.value === 'trans' ? blurMode.value : 'none';
  chrome.storage.local.set({ blurMode: mode });
  sendMessage({ type: 'XTL_BLUR', blurMode: mode });
});

// 切换遮挡范围：关键词 / 整句
maskScope.addEventListener('change', () => {
  const scope = maskScope.value === 'sentence' ? 'sentence' : 'keyword';
  chrome.storage.local.set({ maskScope: scope });
  sendMessage({ type: 'XTL_MASK_SCOPE', maskScope: scope });
});

// 切换遮挡风格与模糊强度
maskStyle.addEventListener('change', () => {
  const style = ['blur-soft', 'blur', 'blur-strong', 'bar', 'dotted'].includes(maskStyle.value)
    ? maskStyle.value
    : 'blur';
  chrome.storage.local.set({ maskStyle: style });
  sendMessage({ type: 'XTL_MASK_STYLE', maskStyle: style });
});

// 悬停关键词时显示本地词典释义
glossEnabled.addEventListener('change', () => {
  const value = glossEnabled.checked;
  chrome.storage.local.set({ glossEnabled: value });
  sendMessage({ type: 'XTL_GLOSS', glossEnabled: value });
});

// 切换界面语言，重载弹窗使其生效
langBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.lang === manualLang) return;
    chrome.storage.local.set({ lang: btn.dataset.lang }, () => {
      window.location.reload();
    });
  });
});