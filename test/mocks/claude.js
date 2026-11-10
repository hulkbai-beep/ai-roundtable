'use strict';
// 模拟 `claude -p --output-format json`：从标准输入读提示词，输出一行 JSON。
// 回复里带上收到的参数信息，测试用它来检查参数有没有传对。
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.MOCK_OLD_CLAUDE && args.includes('--no-session-persistence')) {
  console.error("error: unknown option '--no-session-persistence'");
  process.exit(1);
}
if (process.env.MOCK_OLD_CLAUDE && args.includes('--effort')) {
  console.error("error: unknown option '--effort'");
  process.exit(1);
}
const argAfter = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
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
// 模拟 Claude Code 不让读附件：照常回复，同时在 JSON 里报告 permission_denials
if (process.env.MOCK_CLAUDE_DENY) {
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '我打不开这些文件。', permission_denials: [{ tool_name: 'Read' }] })}\n`);
  });
  return;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const sys = args.indexOf('--system-prompt');
  const tools = args.indexOf('--tools');
  const info = {
    print: args.includes('-p'),
    json: args[args.indexOf('--output-format') + 1] === 'json',
    systemArg: sys >= 0 && args[sys + 1].includes('你是 Claude'),
    systemEn: sys >= 0 && args[sys + 1].includes('You are Claude.') ? true : undefined,
    systemLines: sys >= 0 ? args[sys + 1].split('\n').length : 0,
    toolsDisabled: tools >= 0 && args[tools + 1] === '',
    tools: tools >= 0 ? args[tools + 1] : undefined,
    files: listedFiles(input),
    attachments: (input.match(/^<附件 编号="\d+"/gm) || []).length || undefined,
    stdinHasSystem: input.includes('你是 Claude'),
    blocks: (input.match(/^【[^】\n]+】$/gm) || []).length,
    quote: input.includes('"引号"'),
    model: argAfter('--model'),
    effort: argAfter('--effort'),
  };
  const result = input.includes('请只回复两个字') ? '在线' : `Claude：MOCK-CLAUDE ${JSON.stringify(info)}`;
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, modelUsage: { 'claude-mock': {} } })}\n`);
  }, Number(process.env.MOCK_DELAY || 100));
});
