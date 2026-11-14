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
// Go 写的工具遇到不认识的参数时的说法。下面这句是真机（Windows，2026-11）上看到的原话：
// 不管传的是 --output-format 还是 -output-format，报错里都只有一条横线，“flags”是复数
const undefinedFlag = (a) => `Error: flags provided but not defined: -${a.replace(/^-+/, '')}\n`;

// agy models：列出这个账号能用的模型，stdout 上一行一个，“Fetching available models...”在 stderr 上。
// 一行的样子有两种：“名字<Tab>给人看的名字”，或者只有给人看的名字（MOCK_AGY_MODELS=names）。
// 这两种样子、没登录时的那句话，出自 varadfromeast/codex-agy-bridge 的测试（它调用的是真的 agy），不是在我们自己的真机上看到的；
// lib/model-list.js 的 parseModelList 认得比这里宽
if (args[0] === 'models') {
  const mode = process.env.MOCK_AGY_MODELS;
  // models 后面只认 -h / --help。这段用法说明也是真机上的原话（看到的是挤成一行的，换行的位置是猜的；程序名那里是 agy.exe）
  const extra = args.slice(1).find((a) => a !== '-h' && a !== '--help');
  if (extra) {
    process.stderr.write(`Usage: agy models [flags]\n\nList available models\n\nFlags:\n  -h          Show help\n  --help      Show help\n\n${undefinedFlag(extra)}`);
    process.exit(1);
  }
  // 没登录
  if (mode === 'login') {
    process.stderr.write('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n');
    process.exit(1);
  }
  // 认不出来的输出
  if (mode === 'weird') {
    process.stdout.write('Nothing to show here\n');
    process.exit(0);
  }
  process.stderr.write('Fetching available models...\n');
  if (mode === 'names') process.stdout.write('Gemini 3 Mock Pro (High)\nGemini 3 Mock Pro (Low)\nGemini 3 Mock Flash\n');
  else process.stdout.write('gemini-mock-pro-high\tGemini Mock Pro (High)\ngemini-mock-pro-low\tGemini Mock Pro (Low)\ngemini-mock-flash\tGemini Mock Flash\n');
  process.exit(0);
}
// 不认 --model 的版本（MOCK_AGY_NOMODEL）：和上面一样的说法
if (process.env.MOCK_AGY_NOMODEL && args.includes('--model')) {
  process.stderr.write(undefinedFlag('--model'));
  process.exit(1);
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
    webRule: /你可以上网|You can use the web/.test(prompt) ? true : undefined,
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
