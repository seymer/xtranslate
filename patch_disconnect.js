const fs = require('fs');
let code = fs.readFileSync('content.js', 'utf8');

// 1. Modify waitForChange
code = code.replace(
  `if (!tweetText.isConnected) { clearInterval(timer); return resolve(null); }`,
  `if (!tweetText.isConnected) { clearInterval(timer); return resolve({ disconnected: true }); }`
);

// 2. Modify waitForReplacement
code = code.replace(
  `const removed = !oldNode.isConnected;\n      const timer = setInterval(() => {`,
  `const removed = !oldNode.isConnected;\n      const timer = setInterval(() => {\n        if (!scope.isConnected) { clearInterval(timer); return resolve({ disconnected: true }); }`
);

// 3. Modify processPair UserDescription (Show translation branch)
code = code.replace(
  `const transHTML = await waitForReplacement(node, origHTML, 'UserDescription');\n        if (!transHTML)`,
  `const transHTML = await waitForReplacement(node, origHTML, 'UserDescription');\n        if (transHTML && transHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }\n        if (!transHTML)`
);

// 4. Modify processPair UserDescription (Show original branch)
code = code.replace(
  `const origHTML = await waitForReplacement(node, transHTML, 'UserDescription');\n      if (!origHTML)`,
  `const origHTML = await waitForReplacement(node, transHTML, 'UserDescription');\n      if (origHTML && origHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }\n      if (!origHTML)`
);

// 5. Modify processPair tweetText (Show translation branch)
code = code.replace(
  `let transHTML = await waitForChange(tweetText, origHTML);\n      if (transHTML) { await expandShowMore(tweetText); transHTML = tweetText.innerHTML; }\n      if (!transHTML)`,
  `let transHTML = await waitForChange(tweetText, origHTML);\n      if (transHTML && transHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }\n      if (transHTML) { await expandShowMore(tweetText); transHTML = tweetText.innerHTML; }\n      if (!transHTML)`
);

// 6. Modify processPair tweetText (Show original branch)
code = code.replace(
  `let origHTML = await waitForChange(tweetText, transHTML);\n    if (origHTML) { await expandShowMore(tweetText); origHTML = tweetText.innerHTML; }\n    if (!origHTML)`,
  `let origHTML = await waitForChange(tweetText, transHTML);\n    if (origHTML && origHTML.disconnected) { cleanupPending(tweetText, pendingKey, true); return; }\n    if (origHTML) { await expandShowMore(tweetText); origHTML = tweetText.innerHTML; }\n    if (!origHTML)`
);

fs.writeFileSync('content.js', code);
console.log("Disconnect patch applied!");
