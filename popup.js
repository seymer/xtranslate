// X 双语对照翻译 - Popup 开关、模式、颜色、语言逻辑
const toggle = document.getElementById('toggle');
const modeBtns = document.querySelectorAll('.mode-btn');
const transColor = document.getElementById('transColor');
const langBtns = document.querySelectorAll('.lang-btn');

let manualLang = null;

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
    for (const [key, v] of Object.entries(json)) applyI18n(key, v.message);
  } catch (_) { /* 加载失败则保持浏览器语言 */ }
}

// 初始化：读取当前状态（默认开启 + 逐句模式 + 默认灰 + 自动语言）
chrome.storage.local.get(['enabled', 'mode', 'transColor', 'lang'], (d) => {
  toggle.checked = d.enabled !== false;
  const currentMode = d.mode === 'block' ? 'block' : 'interleave';
  modeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
  transColor.value = d.transColor || 'default';

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

// 切换界面语言，重载弹窗使其生效
langBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.lang === manualLang) return;
    chrome.storage.local.set({ lang: btn.dataset.lang }, () => {
      window.location.reload();
    });
  });
});