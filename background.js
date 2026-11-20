/**
 * X 双语对照翻译 - Background Service Worker
 *
 * 处理键盘快捷键：翻转 storage 开关，并通知当前标签的 content script。
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-bilingual') return;
  try {
    const { enabled = true } = await chrome.storage.local.get('enabled');
    const newEnabled = !enabled;
    await chrome.storage.local.set({ enabled: newEnabled });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https:\/\/(x|twitter)\.com\//.test(tab.url)) return;
    chrome.tabs.sendMessage(tab.id, { type: 'XTL_TOGGLE', enabled: newEnabled }, () => {
      if (chrome.runtime.lastError) { /* 页面未注入 content script，storage.onChanged 会兜底 */ }
    });
  } catch (_) { /* 忽略 */ }
});
