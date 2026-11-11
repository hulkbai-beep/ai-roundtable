'use strict';
// 模拟 `codex exec ... -o <文件> -`：从标准输入读提示词，把最后一条回复写进 -o 指定的文件。
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.MOCK_OLD_CODEX && args.includes('--ephemeral')) {
  console.error("error: unexpected argument '--ephemeral' found");
  process.exit(2);
}
// 模拟不能附图片的旧版本
if (process.env.MOCK_CODEX_NO_IMAGE && args.includes('--image')) {
  console.error("error: unexpected argument '--image' found");
  process.exit(2);
}
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
// --image 后面跟的文件（路径相对于运行目录），以及紧跟在最后一张图片后面的参数
function imageArgs() {
  const out = [];
  args.forEach((a, i) => {
    if (a !== '--image') return;
    let size = -1;
    try {
      size = fs.statSync(args[i + 1]).size;
    } catch {
      /* 读不到 */
    }
    out.push({ path: args[i + 1], size, next: args[i + 2] });
  });
  return out;
}
const o = args.indexOf('-o');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  process.stderr.write('Reading prompt from stdin...\n');
  // 模拟 ChatGPT 账号的额度用完
  if (process.env.MOCK_CODEX_LIMIT) {
    process.stderr.write("ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again in 2 hours 5 minutes.\n");
    process.exit(1);
  }
  const info = {
    exec: args[0] === 'exec',
    sandbox: args[args.indexOf('--sandbox') + 1],
    stdinDash: args[args.length - 1] === '-',
    hasSystem: input.includes('你是 GPT'),
    blocks: (input.match(/^【[^】\n]+】$/gm) || []).length,
    model: args.includes('-m') ? args[args.indexOf('-m') + 1] : undefined,
    config: args.includes('-c') ? args[args.indexOf('-c') + 1] : undefined,
    images: args.includes('--image') ? imageArgs() : undefined,
    files: listedFiles(input),
  };
  const text = input.includes('请只回复两个字') ? '在线' : `MOCK-CODEX ${JSON.stringify(info)}`;
  if (o >= 0) fs.writeFileSync(args[o + 1], text);
  console.log(text);
  process.stderr.write('tokens used\n1,234\n');
});
