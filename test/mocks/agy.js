'use strict';
// 模拟 `agy -p "<提示词>"`：提示词在命令行参数里（或者 -p 后面没有内容时从标准输入读）。
// 出错时的输出照着 Antigravity CLI 的 CHANGELOG 和用户贴出来的报错写：
// stderr 上一行 “error: …”，再加一行 “AGY_ERROR: {…}”，退出码 3。
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('agy 1.4.0\n');
  process.exit(0);
}
if (process.env.MOCK_AGY_SILENT) process.exit(0);

const fail = (lines, code = 3) => {
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(code);
};
const agyError = (o) => `AGY_ERROR: ${JSON.stringify({ code_kind: 'http', retryable: true, error_id: 'mock-0000', ...o })}`;

// 模拟 AI Pro 额度用完
const limit = process.env.MOCK_AGY_LIMIT;
if (limit === 'resets') {
  // 说了多久之后恢复
  fail([
    '⚠ Individual quota reached. Please upgrade your subscription to increase your limits.',
    'Resets in 2h57m45s.',
    agyError({ short_error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits.', status: 'RESOURCE_EXHAUSTED', error_code: 429 }),
  ]);
} else if (limit === 'old') {
  // 旧版本：没有 AGY_ERROR 这一行，退出码是 1
  fail(['error: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).'], 1);
} else if (limit === 'quiet') {
  // 有时候退出码是 0、标准输出是空的，原因只在 stderr 上
  fail(['error: Your AI credits balance is too low to continue.', 'warning: run ended with no output and no recorded error'], 0);
} else if (limit) {
  // 不说什么时候恢复
  fail(['error: Your AI credits balance is too low to continue.', agyError({ short_error: 'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED', error_code: 429 })]);
}
// 和额度无关的失败
const failure = process.env.MOCK_AGY_FAIL;
if (failure === 'large') {
  // 消息太大：gRPC 也用 RESOURCE_EXHAUSTED 报这个
  const said = 'RESOURCE_EXHAUSTED (code 8): grpc: received message larger than max (5351648 vs. 4194304)';
  fail([`error: ${said}`, agyError({ short_error: said, status: 'RESOURCE_EXHAUSTED', error_code: 8, retryable: false })]);
} else if (failure === 'capacity') {
  // 服务器上这个模型暂时没有容量：也是 429 / RESOURCE_EXHAUSTED，但不是这个账号的额度
  const said = 'RESOURCE_EXHAUSTED (code 429): No capacity available for model gemini-3.1-pro-preview on the server';
  fail([`error: ${said}`, agyError({ short_error: said, status: 'RESOURCE_EXHAUSTED', error_code: 429 })]);
} else if (failure) {
  // 服务器暂时繁忙
  fail(['error: The model is overloaded. Please try again later.', agyError({ short_error: 'UNAVAILABLE (code 503): The model is overloaded. Please try again later.', status: 'UNAVAILABLE', error_code: 503 })]);
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
function answer(prompt) {
  const info = {
    blocks: (prompt.match(/^【[^】\n]+】$/gm) || []).length,
    hasSystem: prompt.includes('你是 Gemini'),
    quote: prompt.includes('"引号"'),
    lines: prompt.split('\n').length,
    final: prompt.includes('你是这一轮最后一个发言的人') ? true : undefined,
    chars: prompt.length,
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
