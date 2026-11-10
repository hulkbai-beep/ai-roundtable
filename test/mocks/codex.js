'use strict';
// 模拟 `codex exec ... -o <文件> -`：从标准输入读提示词，把最后一条回复写进 -o 指定的文件。
//
// 输出的样子照着 openai/codex 的源码写（codex-rs/exec/src/event_processor_with_human_output.rs）：
//  - stderr 上先是一段配置，然后把提示词原样回显在 “user” 下面，模型的回复在 “codex” 下面，
//    最后两行是 “tokens used” 和一个按系统语言加了分隔符的数字；
//  - 最后一条回复另外打印到 stdout；
//  - 出错时打印 “ERROR: …”，退出码是 1，-o 的文件是空的。
// 额度用完的那句话逐字来自 codex-rs/protocol/src/error.rs（注意是弯引号 ’）。
const fs = require('fs');
const { codexRetryTime } = require('./codex-time');
const args = process.argv.slice(2);
if (process.env.MOCK_OLD_CODEX && args.includes('--ephemeral')) {
  console.error("error: unexpected argument '--ephemeral' found");
  process.exit(2);
}
const o = args.indexOf('-o');
const err = (s) => process.stderr.write(`${s}\n`);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  // 真的 codex 在开始前就把 -o 的文件建好了，失败时里面是空的
  if (o >= 0) fs.writeFileSync(args[o + 1], '');
  err('OpenAI Codex v0.167.0\n--------');
  err(`workdir: ${process.cwd()}\nmodel: gpt-mock\nprovider: openai\napproval: never\nsandbox: read-only\nreasoning effort: none\nreasoning summaries: auto\nsession id: 0199a213-81c0-7800-8aa1-bbab2a035a53`);
  err('--------');
  err(`user\n${input}`);

  const limit = process.env.MOCK_CODEX_LIMIT;
  if (limit === '429') {
    // 服务器一直回 429，codex 自己重试了几次后放弃
    err('ERROR: exceeded retry limit, last status: 429 Too Many Requests, request id: req_0123456789');
    process.exitCode = 1;
    return;
  }
  if (limit) {
    // 免费账号额度用完；MOCK_CODEX_LIMIT=later 模拟服务器没给恢复时间的情况
    const when = limit === 'later' ? 'later' : `at ${codexRetryTime(Date.now() + 125 * 60000)}`;
    err(`ERROR: You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again ${when}.`);
    process.exitCode = 1;
    return;
  }
  const failure = process.env.MOCK_CODEX_FAIL;
  if (failure) {
    // 和额度无关的失败：断网；MOCK_CODEX_FAIL=plan 是这个账号的套餐不含 Codex
    err(
      failure === 'plan'
        ? 'ERROR: To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.'
        : 'ERROR: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)'
    );
    process.exitCode = 1;
    return;
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
  err(`codex\n${text}`);
  if (o >= 0) fs.writeFileSync(args[o + 1], text);
  // MOCK_CODEX_LOCALE=de 模拟德语系统上的写法（1.234）
  err(`tokens used\n${process.env.MOCK_CODEX_LOCALE === 'de' ? '1.234' : '1,234'}`);
  console.log(text);
});
