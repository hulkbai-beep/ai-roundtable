'use strict';
// 模拟 `codex exec ... -o <文件> -`：从标准输入读提示词，把最后一条回复写进 -o 指定的文件。
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.MOCK_OLD_CODEX && args.includes('--ephemeral')) {
  console.error("error: unexpected argument '--ephemeral' found");
  process.exit(2);
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
  };
  const text = input.includes('请只回复两个字') ? '在线' : `MOCK-CODEX ${JSON.stringify(info)}`;
  // 和另外两个模拟命令一样，可以用 MOCK_DELAY 让它慢一点再回复
  setTimeout(() => {
    if (o >= 0) fs.writeFileSync(args[o + 1], text);
    console.log(text);
    process.stderr.write('tokens used\n1,234\n');
  }, Number(process.env.MOCK_DELAY || 0));
});
