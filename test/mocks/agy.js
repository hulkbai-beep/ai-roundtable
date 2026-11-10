'use strict';
// 模拟 `agy -p "<提示词>"`：提示词在命令行参数里（或者 -p 后面没有内容时从标准输入读）。
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.MOCK_AGY_SILENT) process.exit(0);
// 提示词末尾列出的附件文件（“- 附件 1（a.png）：路径”），以及按这个路径是不是真的读得到（size 是文件大小，读不到是 -1）
function listedFiles(prompt) {
  const out = [];
  for (const m of prompt.matchAll(/^- (?:附件 (\d+)（.*）( 的完整文字)?：|Attachment (\d+) \(.*\)(, full text)?: )(.+)$/gm)) {
    let size = -1;
    try {
      size = fs.statSync(m[5]).size;
    } catch {
      /* 读不到 */
    }
    out.push({ n: Number(m[1] || m[3]), text: Boolean(m[2] || m[4]), path: m[5], size });
  }
  return out.length ? out : undefined;
}
function answer(prompt) {
  const info = {
    blocks: (prompt.match(/^【[^】\n]+】$/gm) || []).length,
    hasSystem: prompt.includes('你是 Gemini'),
    quote: prompt.includes('"引号"'),
    lines: prompt.split('\n').length,
    files: listedFiles(prompt),
  };
  const reply = prompt.includes('请只回复两个字') ? '在线' : `\u001b[32mMOCK-AGY\u001b[0m ${JSON.stringify(info)}`;
  setTimeout(() => console.log(reply), Number(process.env.MOCK_DELAY || 100));
}
const i = args.indexOf('-p');
if (i >= 0 && i + 1 < args.length) answer(args[i + 1]);
else {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => answer(s));
}
