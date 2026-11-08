'use strict';
// 模拟 `claude -p --output-format json`：从标准输入读提示词，输出一行 JSON。
// 回复里带上收到的参数信息，测试用它来检查参数有没有传对。
const args = process.argv.slice(2);
if (process.env.MOCK_OLD_CLAUDE && args.includes('--no-session-persistence')) {
  console.error("error: unknown option '--no-session-persistence'");
  process.exit(1);
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
    systemLines: sys >= 0 ? args[sys + 1].split('\n').length : 0,
    toolsDisabled: tools >= 0 && args[tools + 1] === '',
    stdinHasSystem: input.includes('你是 Claude'),
    blocks: (input.match(/^【[^】\n]+】$/gm) || []).length,
    quote: input.includes('"引号"'),
  };
  const result = input.includes('请只回复两个字') ? '在线' : `Claude：MOCK-CLAUDE ${JSON.stringify(info)}`;
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, modelUsage: { 'claude-mock': {} } })}\n`);
  }, Number(process.env.MOCK_DELAY || 100));
});
