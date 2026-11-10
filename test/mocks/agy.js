'use strict';
// 模拟 `agy -p "<提示词>"`：提示词在命令行参数里（或者 -p 后面没有内容时从标准输入读）。
const args = process.argv.slice(2);
if (process.env.MOCK_AGY_SILENT) process.exit(0);
// 模拟 AI Pro 额度用完（不说什么时候恢复）
if (process.env.MOCK_AGY_LIMIT) {
  console.error('Error: RESOURCE_EXHAUSTED: Quota exceeded for this account.');
  process.exit(1);
}
function answer(prompt) {
  const info = {
    blocks: (prompt.match(/^【[^】\n]+】$/gm) || []).length,
    hasSystem: prompt.includes('你是 Gemini'),
    quote: prompt.includes('"引号"'),
    lines: prompt.split('\n').length,
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
