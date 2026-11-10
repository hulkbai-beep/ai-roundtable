'use strict';
// 模拟 `claude -p --output-format json`：从标准输入读提示词，输出一行 JSON。
// 回复里带上收到的参数信息，测试用它来检查参数有没有传对。
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
    stdinHasSystem: input.includes('你是 Claude'),
    blocks: (input.match(/^【[^】\n]+】$/gm) || []).length,
    quote: input.includes('"引号"'),
    model: argAfter('--model'),
    effort: argAfter('--effort'),
  };
  const result = input.includes('请只回复两个字') ? '在线' : `Claude：MOCK-CLAUDE ${JSON.stringify(info)}`;
  setTimeout(() => {
    // 模拟 Max 额度用完：旧版的写法“…|恢复时间（秒）”
    if (process.env.MOCK_CLAUDE_LIMIT) {
      const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
      process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${reset}` })}\n`);
      return;
    }
    const usage = { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 };
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage, modelUsage: { 'claude-mock': {} } })}\n`);
  }, Number(process.env.MOCK_DELAY || 100));
});
