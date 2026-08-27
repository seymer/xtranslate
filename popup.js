// X 双语对照翻译 - Popup 开关与模式逻辑
const toggle = document.getElementById('toggle');
const modeBtns = document.querySelectorAll('.mode-btn');

// 初始化：读取当前状态（默认开启 + 逐句模式）
chrome.storage.local.get(['enabled', 'mode'], (d) => {
  toggle.checked = d.enabled !== false;
  const currentMode = d.mode === 'block' ? 'block' : 'interleave';
  modeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
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
