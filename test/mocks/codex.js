'use strict';
// 模拟 `codex exec ... -o <文件> -`：从标准输入读提示词，把最后一条回复写进 -o 指定的文件。
//
// 输出的样子照着 openai/codex 的源码写（codex-rs/exec/src/event_processor_with_human_output.rs）：
//  - stderr 上先是一段配置，然后把提示词原样回显在 “user” 下面，模型的回复在 “codex” 下面，
//    最后两行是 “tokens used” 和一个按系统语言加了分隔符的数字；
//  - 最后一条回复另外打印到 stdout；
//  - 出错时打印 “ERROR: …”，退出码是 1，-o 的文件是空的。
// 额度用完的那句话逐字来自 codex-rs/protocol/src/error.rs（注意是弯引号 ’）。
// 这个文件要能单独运行：Windows 上的测试会把它单独复制到别的目录（见 test/helpers.js 的 makeBin），不能 require 旁边的文件。
const fs = require('fs');
const args = process.argv.slice(2);

// codex 写恢复时间的格式（codex-rs/protocol/src/error.rs 的 format_retry_timestamp）：
// 当天写 “3:05 PM”，不是当天写 “Jan 2nd, 2026 3:05 PM”
function codexRetryTime(ts, now = Date.now()) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(ts);
  const hm = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  const day = d.getDate();
  const suffix = day >= 11 && day <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
  return `${MONTHS[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()} ${hm}`;
}

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
  if (failure === 'empty') {
    // 没有报错、也没有回复：退出码是 0，-o 的文件是空的
    err(`Warning: no last agent message; wrote empty content to ${o >= 0 ? args[o + 1] : 'output'}`);
    return;
  }
  if (failure) {
    // 和额度无关的失败。默认是断网；其他几种：
    const errors = {
      // 这个账号的套餐不含 Codex
      plan: 'ERROR: To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.',
      // 磁盘配额满了（Rust 报操作系统错误的写法）
      disk: 'ERROR: Disk quota exceeded (os error 122)',
      // 服务器回 429，原因是这一次请求本身太大（codex 把状态和返回内容原样报出来）
      large:
        'ERROR: unexpected status 429 Too Many Requests: {"error":{"message":"Request too large for gpt-mock in organization org-mock on tokens per min (TPM): Limit 30000, Requested 44000. The input or output tokens must be reduced in order to run successfully.","type":"tokens","code":"rate_limit_exceeded"}}, url: https://api.openai.com/v1/responses',
    };
    err(errors[failure] || 'ERROR: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)');
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
    images: args.includes('--image') ? imageArgs() : undefined,
    files: listedFiles(input),
  };
  // MOCK_CODEX_REPLY=footer：回复的最后一行正好是 “tokens used”（后面紧跟着真正的那两行）
  const text = input.includes('请只回复两个字') ? '在线' : process.env.MOCK_CODEX_REPLY === 'footer' ? 'MOCK-CODEX 输出的最后两行是：\ntokens used' : `MOCK-CODEX ${JSON.stringify(info)}`;
  err(`codex\n${text}`);
  if (o >= 0) fs.writeFileSync(args[o + 1], text);
  // MOCK_CODEX_LOCALE=de 模拟德语系统上的写法（1.234）
  err(`tokens used\n${process.env.MOCK_CODEX_LOCALE === 'de' ? '1.234' : '1,234'}`);
  console.log(text);
});
