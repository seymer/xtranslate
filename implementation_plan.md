# X 双语对照翻译 — 全面审计报告 & 修复方案

## 问题概述

经过对 [content.js](file:///Users/ims/Downloads/xtranslate/content.js) 的逐行审计，发现 **7 个核心 bug** 和 **4 个次要问题** 会导致推文无法如预期转换为双语模式。下面按严重程度排列。

---

## 🔴 核心 Bug（直接导致推文漏掉）

### Bug 1: `processedIds` 60 秒去重 — 滚动回来的推文被永久跳过

> [!CAUTION]
> 这是最主要的漏掉推文原因。

**位置**: [content.js L53, L67-73, L628-630](file:///Users/ims/Downloads/xtranslate/content.js#L53)

**问题**: `processedIds` 以 `tweetId → timestamp` 做 60 秒去重。当用户滚动到一条推文、脚本成功处理后，如果用户在 60 秒内**滚走再滚回来**，虚拟列表会销毁并重建 DOM 节点（新节点没有 `records` 记录），但 `processedIds` 还在冷却期内，导致 `scan()` 直接跳过。

**结果**: 推文显示为纯原文/纯译文，没有双语块。60 秒后才可能重新被处理（如果恰好触发了 scan）。

**修复方案**: `processedIds` 的目的应该是防止**同一轮 scan 中重复处理**，而不是跨 scan 去重。应改为：
- 在 scan 开始时创建一个局部 `Set`，当轮结束即释放；或者
- 在 scan 中检查 `processedIds` 之前，先确认该 `tweetText` 节点是否已经有对应的 `.xtl-wrap`，如果没有则允许重新处理。

---

### Bug 2: `pendingTexts` 文本冷却 — 相同文本的不同推文被误跳

> [!CAUTION]
> 高频场景：转发、引用推文、话题讨论中经常出现相同前 64 字符的推文。

**位置**: [content.js L52, L60-65, L485-487, L633-634](file:///Users/ims/Downloads/xtranslate/content.js#L52)

**问题**: `pendingTexts` 用 `norm(tt.textContent).slice(0, 64)` 做 30 秒冷却。如果两条不同推文恰好前 64 字符相同（例如转推、引用同一内容），第二条会被错误跳过。

**结果**: 内容相似的推文只有第一条被处理。

**修复方案**: 用 `tweetId` + 文本前缀做联合 key，或者把 `pendingTexts` 的 key 改为 `tweetId || textKey`（有 tweetId 时优先用 tweetId）。

---

### Bug 3: `findTweetTextForBtn` 只找按钮之**后**的 tweetText — 布局变化时找不到

> [!WARNING]
> X 的 DOM 布局并不保证翻译按钮始终在 tweetText 之前。

**位置**: [content.js L243-257](file:///Users/ims/Downloads/xtranslate/content.js#L243)

**问题**: `findTweetTextInScope` 用 `compareDocumentPosition` 只接受 `DOCUMENT_POSITION_FOLLOWING`（按钮在 tweetText 之前）。但 X 的某些布局中（例如推文详情页、引用推文展开后），翻译提示栏可能在 tweetText **下方**（DOM 顺序在后），此时函数返回 `null`。

**结果**: `scan()` 中 `findTweetTextForBtn` 返回 null，该推文被跳过（设 `hasRetry=true`，最多重试 3 次后放弃）。

**修复方案**: 对于 `tweetText`，同时接受 `DOCUMENT_POSITION_PRECEDING`（按钮在 tweetText 之后），选距离最近的一个。或者改用反向查找策略：从 tweetText 出发找按钮（`findShowOriginalBtnNear` 已经实现了这个方向），在 scan 中直接遍历 tweetText 而非按钮。

---

### Bug 4: `scan()` 对候选按钮的选择器过于宽泛，且串行处理导致后面的推文来不及处理

> [!WARNING]
> 这是性能+功能的双重问题。

**位置**: [content.js L612, L636](file:///Users/ims/Downloads/xtranslate/content.js#L612)

**问题**:
1. 选择器 `'article [role="button"], article button, [role="button"], button'` 会匹配页面上**所有按钮**（包括点赞、转发、回复等），`candidates` 数量可能达数百个。虽然后面有 `isShowOriginalBtn/isShowTranslationBtn` 过滤，但遍历本身开销不小。
2. `for...of` 中每条推文都 `await processPairWithTimeout`（最多等 5 秒），串行处理意味着如果页面上有 10 条待处理推文，最后一条可能要等 50 秒才被处理。在这期间用户可能已经滚过它了。

**修复方案**:
1. 优化选择器——缩小搜索范围。X 的翻译横幅按钮通常在特定的 `div` 结构内，可以利用 `aria-label` 属性预过滤。
2. 考虑按钮发现后立即 push 到数组，然后用 `Promise.all` 或有限并发（例如 3 个同时处理）来加速。

---

### Bug 5: `waitForChange` 和 `waitForReplacement` 超时后不恢复按钮状态

> [!WARNING]
> 超时后推文卡在中间状态（既没有原文也没有译文的完整显示）。

**位置**: [content.js L322-331, L336-353, L532, L556-558](file:///Users/ims/Downloads/xtranslate/content.js#L322)

**问题**: 点击「显示原文」后开始轮询等 `innerHTML` 变化，但 X 官方接口偶尔响应慢（超过 3 秒 `POLL_MAX`）。超时后 `processPair` 把按钮加入 `failedBtns`（永久跳过），不会再尝试恢复。

**结果**: 该推文的翻译按钮被永久标记为失败，即使稍后条件满足了也不会重试。

**修复方案**:
1. `failedBtns` 改为带时间戳的 `Map`，超过一定时间（如 30 秒）后允许重试。
2. 超时后尝试点击按钮恢复原来的状态。

---

### Bug 6: `hasWrapNear` 检查不完整 — 会遗漏某些已处理的推文导致重复处理

**位置**: [content.js L284-292](file:///Users/ims/Downloads/xtranslate/content.js#L284)

**问题**: `hasWrapNear` 只检查 `tt.closest('.xtl-wrap')` 和 `tt.parentElement.children`。但如果 X 在 tweetText 和 `.xtl-wrap` 之间插入了额外的 wrapper 层（React 偶尔会这么做），`.xtl-wrap` 就不在 `parentElement.children` 中。

同时，在相反方向上，如果 `.xtl-wrap` 属于**另一条推文**（引用推文嵌套场景），也可能误判为"已处理"而跳过当前推文。

**修复方案**: 改为从 tweetText 向后遍历 `nextElementSibling` 链找 `.xtl-wrap`，并验证 wrap 的 tweetId 是否匹配。

---

### Bug 7: interleave 模式段落数不等时的 fallback 显示不一致

**位置**: [content.js L163](file:///Users/ims/Downloads/xtranslate/content.js#L163)

**问题**: `buildInterleaved` 中，如果 `origParas.length !== transParas.length`（原文和译文的段落数不同），直接返回 `null`，fallback 到 block 模式。但 URL 过滤后段落数很容易不等（原文有多个 URL 段落而译文没有），这导致大量推文被迫降级到 block 模式。

**修复方案**: 当段落数不等时，尝试"最佳匹配"策略：
- 如果只差 1-2 段，尝试合并短段落。
- 或者 fallback 到"整段对照"（不做逐句拆分，但仍以 interleave 样式显示整个原文+整个译文），而非完全 fallback 到 block。

---

## 🟡 次要问题

### Issue A: `scanning` 标志导致 mutation 期间的 scan 请求丢失

**位置**: [content.js L719-730](file:///Users/ims/Downloads/xtranslate/content.js#L719)

当 `scanning = true` 时，`scheduleScan()` 直接 return，新到的 mutation 不会排队。虽然有 2 秒的 `setInterval` 兜底，但在快速滚动场景下可能导致延迟。

**修复**: 改为 `scanQueued` 标志，在 `scanning` 结束后检查并立即执行排队的 scan。

---

### Issue B: `norm()` + `head` 校验过于脆弱

**位置**: [content.js L594](file:///Users/ims/Downloads/xtranslate/content.js#L594)

`isValid` 用 `norm(tweetText.textContent).startsWith(rec.head)` 校验内容。但 `head` 只取前 32 字符，当推文以 emoji 或 `@mention` 开头时，空白规范化后可能不匹配。

**修复**: 改为比较 `tweetText.innerHTML` 是否等于 `rec.origHTML`（已缓存，准确度更高）。

---

### Issue C: 推文详情页（`/status/xxx`）的 tweetText 没有 `article` 祖先

**位置**: [content.js L97-98](file:///Users/ims/Downloads/xtranslate/content.js#L97)

在推文详情页中，主推文的 tweetText 有时不被包裹在 `<article>` 中（X 最近的改版），导致 `getTweetId` 返回 `null`。这本身不阻止处理，但会导致 `processedIds` 去重失效 + `isValid` 的 tweetId 校验跳过。

**修复**: 增加 fallback——从 URL `window.location.pathname` 提取 tweetId。

---

### Issue D: `restoreToTranslationOnly` 中 `innerHTML = transHTML` 可能触发 React 不一致

**位置**: [content.js L661](file:///Users/ims/Downloads/xtranslate/content.js#L661)

直接设置 `innerHTML` 绕过了 React 的 virtual DOM，可能导致后续 React 更新时出现异常渲染。

**修复**: 改为点击「显示翻译」按钮（如果还在 DOM 中），让 X 自己切换回译文。

---

## Proposed Changes

### [MODIFY] [content.js](file:///Users/ims/Downloads/xtranslate/content.js)

以下是按优先级排列的修复：

#### 1. 修复 Bug 1 — `processedIds` 去重逻辑
- 在 `scan()` 检查 `isProcessedId` 之前，增加条件：如果当前 tweetText 没有 `.xtl-wrap` 邻居，则跳过 `processedIds` 检查，允许重新处理。

#### 2. 修复 Bug 2 — `pendingTexts` 冷却 key
- 将 `pendingTexts` 的 key 改为 `tweetId + '|' + textKey`（有 tweetId 时）或纯 `textKey`（无 tweetId 时），避免不同推文的文本碰撞。

#### 3. 修复 Bug 3 — `findTweetTextInScope` 双向查找
- 在 `findTweetTextInScope` 中，同时接受 `DOCUMENT_POSITION_PRECEDING`，并选择距离按钮最近的 tweetText。

#### 4. 修复 Bug 5 — `failedBtns` 改为带时间戳、可重试
- `failedBtns` 从 `WeakSet` 改为 `WeakMap<btn, timestamp>`，超过 30 秒后允许重试。

#### 5. 修复 Bug 6 — `hasWrapNear` 增强
- 改为向后遍历 sibling 查找 `.xtl-wrap`，并校验 wrap 的数据关联。

#### 6. 修复 Bug 7 — interleave fallback 改进
- 段落数不等时，fallback 到"整体 interleave"（整段原文 + 整段译文，仍以 interleave 样式显示），而非直接 fallback 到 block。

#### 7. 修复 Issue A — scan 排队机制
- 引入 `scanQueued` 标志，确保 scanning 期间收到的 mutation 不会丢失。

#### 8. 修复 Issue B — 校验逻辑增强
- `isValid` 中增加 `innerHTML` 比较作为主要校验手段。

---

## Verification Plan

### 手动验证
1. 在 X 的时间线上快速滚动，验证所有带翻译按钮的推文都能被处理
2. 滚动离开后再滚回来，验证推文仍显示双语
3. 查找内容相似的推文（转推/引用），验证都能独立被处理
4. 在推文详情页验证主推文和回复都能被处理
5. 切换 interleave/block 模式，验证 fallback 行为
6. 开启/关闭扩展，验证状态恢复正常

### 自动化检查
- 在控制台开启 `DEBUG = true`，监控日志中 `SKIP`、`FAIL`、`TIMEOUT` 的出现频率是否显著降低
