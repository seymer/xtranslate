const fs = require('fs');
let code = fs.readFileSync('content.js', 'utf8');

// 1. Remove tt.innerHTML = ...
code = code.replace(/try \{ tt\.innerHTML = \(rec && rec\.transHTML\) \|\| wrap\.__xtlTrans \|\| ''; \} catch \(_\) \{\}/g, '// BUG FIX: DO NOT manually set innerHTML to avoid React desync.');

// 2. Remove recordNodes.clear()
code = code.replace(/\/\/ 清空 recordNodes（关闭后所有记录失效）\n\s*recordNodes\.clear\(\);/g, '// BUG FIX: Do not clear recordNodes so rebuildAll can restore instantly.');

fs.writeFileSync('content.js', code);
