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
  const info = { exec: args[0] === 'exec', sandbox: args[args.indexOf('--sandbox') + 1], stdinDash: args[args.length - 1] === '-', hasSystem: input.includes('你是 GPT') };
  const text = input.includes('请只回复两个字') ? '在线' : `MOCK-CODEX ${JSON.stringify(info)}`;
  if (o >= 0) fs.writeFileSync(args[o + 1], text);
  console.log(text);
});
