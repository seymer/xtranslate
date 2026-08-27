const fs = require('fs');
let code = fs.readFileSync('content.js', 'utf8');

const targetStr = `      } else {
        const pair = document.createElement('div');
        pair.className = 'xtl-pair';
        const o = document.createElement('div'); o.className = 'xtl-orig'; o.textContent = norm(origPara); pair.appendChild(o);
        const t = document.createElement('div'); t.className = 'xtl-trans'; t.textContent = norm(transPara); pair.appendChild(t);
        container.appendChild(pair);
      }`;

const replaceStr = `      } else {
        const pair = document.createElement('div');
        pair.className = 'xtl-pair';
        const o = document.createElement('div'); o.className = 'xtl-orig';
        const t = document.createElement('div'); t.className = 'xtl-trans';
        
        // 恢复 HTML 保留逻辑：如果是整体 fallback，使用 innerHTML 保留富文本
        if (origParas.length === 1) {
          o.innerHTML = origHTML || '';
          t.innerHTML = transHTML || '';
        } else {
          o.textContent = norm(origPara);
          t.textContent = norm(transPara);
        }
        
        pair.appendChild(o);
        pair.appendChild(t);
        container.appendChild(pair);
      }`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, replaceStr);
    fs.writeFileSync('content.js', code);
    console.log("Fallback patch applied!");
} else {
    console.log("Target string not found!");
}
