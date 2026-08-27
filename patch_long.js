const fs = require('fs');
let code = fs.readFileSync('content.js', 'utf8');

const targetStr = `    if (isShowTranslationBtn(btn)) {
      const origHTML = tweetText.innerHTML;
      nativeClick(btn);
      const transHTML = await waitForChange(tweetText, origHTML);
      if (!transHTML) { dbg('processPair: FAIL (translate timeout)'); failedBtns.set(btn, Date.now()); cleanupPending(tweetText, pendingKey); return; }`;

const replaceStr = `    if (isShowTranslationBtn(btn)) {
      await expandShowMore(tweetText);
      const origHTML = tweetText.innerHTML;
      nativeClick(btn);
      let transHTML = await waitForChange(tweetText, origHTML);
      if (transHTML) { await expandShowMore(tweetText); transHTML = tweetText.innerHTML; }
      if (!transHTML) { dbg('processPair: FAIL (translate timeout)'); failedBtns.set(btn, Date.now()); cleanupPending(tweetText, pendingKey); return; }`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, replaceStr);
    fs.writeFileSync('content.js', code);
    console.log("Patch applied!");
} else {
    console.log("Target string not found!");
}
