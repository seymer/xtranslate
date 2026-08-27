const fs = require('fs');
let code = fs.readFileSync('content.js', 'utf8');

const targetStr = `    if (bestFollowing) {
      dbg('findTweetText: OK (following)', { btn: btn.getAttribute('aria-label'), tweetText: bestFollowing.textContent.slice(0, 40) });
      return bestFollowing;
    }
    if (bestPreceding) {
      dbg('findTweetText: OK (preceding)', { btn: btn.getAttribute('aria-label'), tweetText: bestPreceding.textContent.slice(0, 40) });
      return bestPreceding;
    }`;

const replaceStr = `    // 绝大多数情况下，翻译按钮在推文正文下方（推文在前，按钮在后）
    if (bestPreceding) {
      dbg('findTweetText: OK (preceding)', { btn: btn.getAttribute('aria-label'), tweetText: bestPreceding.textContent.slice(0, 40) });
      return bestPreceding;
    }
    if (bestFollowing) {
      dbg('findTweetText: OK (following)', { btn: btn.getAttribute('aria-label'), tweetText: bestFollowing.textContent.slice(0, 40) });
      return bestFollowing;
    }`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, replaceStr);
    fs.writeFileSync('content.js', code);
    console.log("Patch applied!");
} else {
    console.log("Target string not found!");
}
