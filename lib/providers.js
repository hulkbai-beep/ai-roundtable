'use strict';

// 三位成员的各种“接入方式”：命令行工具（走订阅）或 HTTP 接口（走免费额度 / API Key）

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAdaptive, detectCommand } = require('./spawn');
const { request } = require('./http');
const { stripAnsi, splitArgs, tail, uid, safeJson, UserError } = require('./util');
const { tr, L } = require('./i18n');
const { detectLimit, parseResetAt, limitReply, stripEcho, parseLocaleInt, retryAfterAt, dailyQuotaResetAt, BRIEF_RETRY_MS } = require('./limits');

const IS_WIN = process.platform === 'win32';

// PATH 里找不到时，再去这些常见安装位置找
const CANDIDATES = IS_WIN
  ? {
      claude: ['%USERPROFILE%\\.local\\bin\\claude.exe', '%APPDATA%\\npm\\claude.cmd'],
      agy: [
        '%LOCALAPPDATA%\\agy\\bin\\agy.exe',
        '%LOCALAPPDATA%\\Antigravity\\bin\\agy.exe',
        '%LOCALAPPDATA%\\Antigravity\\agy.exe',
        '%LOCALAPPDATA%\\Programs\\Antigravity\\bin\\agy.exe',
        '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\agy.exe',
        '%USERPROFILE%\\.local\\bin\\agy.exe',
      ],
      codex: ['%APPDATA%\\npm\\codex.cmd', '%USERPROFILE%\\.local\\bin\\codex.exe'],
    }
  : {
      claude: ['~/.local/bin/claude', '~/.claude/local/claude'],
      agy: ['~/.local/bin/agy'],
      codex: ['~/.local/bin/codex'],
    };

const MAX_CHARS_FIELD = { key: 'maxChars', label: L('最多带多少字的聊天记录', 'Max characters of chat history to send'), type: 'number' };

// 思考强度：留空 = 用工具或模型自己的默认值
const EFFORT_LABELS = { low: L('低（回复更快）', 'Low (faster replies)'), medium: L('中', 'Medium'), high: L('高', 'High'), xhigh: L('很高', 'Extra high'), max: L('最高（最慢）', 'Max (slowest)') };
const EFFORTS = {
  'claude-cli': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex-cli': ['low', 'medium', 'high', 'xhigh'],
  'github-models': ['low', 'medium', 'high'],
  'openai-compatible': ['low', 'medium', 'high'],
  'gemini-api': ['low', 'high'],
};
const effortField = (pid, help) => ({
  key: 'effort',
  label: L('思考强度', 'Reasoning effort'),
  type: 'select',
  options: [['', L('默认', 'Default')], ...EFFORTS[pid].map((v) => [v, EFFORT_LABELS[v]])],
  help,
});
function effortLabel(v) {
  if (!v) return '';
  const zh = EFFORT_LABELS[v] ? EFFORT_LABELS[v].zh.replace(/（.*）$/, '') : v;
  const en = EFFORT_LABELS[v] ? EFFORT_LABELS[v].en.replace(/ \(.*\)$/, '') : v;
  return tr(`思考${zh}`, `${en} effort`);
}
function pickEffort(pid, v) {
  const e = String(v || '').trim();
  return EFFORTS[pid] && EFFORTS[pid].includes(e) ? e : '';
}

const PROVIDERS = {
  'claude-cli': {
    member: 'claude',
    label: L('Claude Code（Max 订阅）', 'Claude Code (Max subscription)'),
    kind: 'cli',
    bin: 'claude',
    fields: [
      { key: 'command', label: L('命令或完整路径', 'Command or full path'), placeholder: 'claude', help: L('一般保持 claude 即可；提示找不到时，填 claude.exe 的完整路径。', 'Usually just claude. If it is not found, enter the full path to claude.exe.') },
      {
        key: 'model',
        label: L('模型', 'Model'),
        type: 'model',
        choices: [
          ['opus', L('Opus（最强）', 'Opus (strongest)')],
          ['sonnet', L('Sonnet（均衡）', 'Sonnet (balanced)')],
          ['haiku', L('Haiku（最快）', 'Haiku (fastest)')],
        ],
        placeholder: L('例如 claude-opus-4-8', 'e.g. claude-opus-4-8'),
        help: L('“默认”= 你在 Claude Code 里设置的模型。Opus、Sonnet、Haiku 会自动用各自的最新版本。', '"Default" uses the model set in Claude Code. Opus, Sonnet and Haiku always use their latest version.'),
      },
      effortField('claude-cli', L('越高想得越久、回复越慢，也更耗 Max 额度。', 'Higher means more thinking, slower replies, and more of your Max usage.')),
      MAX_CHARS_FIELD,
      { key: 'extraArgs', label: L('额外命令行参数（高级）', 'Extra command-line arguments (advanced)'), placeholder: L('例如 --fallback-model sonnet', 'e.g. --fallback-model sonnet'), advanced: true },
    ],
  },
  'agy-cli': {
    member: 'gemini',
    label: L('Antigravity CLI（AI Pro 订阅）', 'Antigravity CLI (AI Pro subscription)'),
    kind: 'cli',
    bin: 'agy',
    fields: [
      { key: 'command', label: L('命令或完整路径', 'Command or full path'), placeholder: 'agy', help: L('先在命令行运行一次 agy，用你的 Google 账号登录。', 'Run agy once in a terminal first and sign in with your Google account.') },
      { key: 'model', label: L('模型', 'Model'), type: 'model', choices: [], placeholder: L('模型名称', 'Model name'), help: L('Antigravity CLI 不一定支持选模型；不支持时会自动用默认模型。', 'Antigravity CLI may not support choosing a model; if not, the default model is used.') },
      { ...MAX_CHARS_FIELD, help: L('提示词通过命令行参数传递，Windows 对长度有限制，建议不超过 20000。', 'The prompt is passed as a command-line argument, which Windows limits in length. Keep this at 20000 or less.') },
      {
        key: 'promptVia',
        label: L('提示词传递方式（高级）', 'How to pass the prompt (advanced)'),
        type: 'select',
        options: [
          ['arg', L('命令行参数（默认）', 'Command-line argument (default)')],
          ['stdin', L('标准输入', 'Standard input')],
        ],
        advanced: true,
      },
      { key: 'extraArgs', label: L('额外命令行参数（高级）', 'Extra command-line arguments (advanced)'), advanced: true },
    ],
  },
  'gemini-api': {
    member: 'gemini',
    label: L('Gemini API Key（备选，不走订阅）', 'Gemini API Key (alternative, not your subscription)'),
    kind: 'http',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, help: L('在 Google AI Studio 创建。这条路不走 AI Pro 订阅，费用和免费额度以官网为准。', 'Create one in Google AI Studio. This does not use your AI Pro subscription; see Google for pricing and free quota.') },
      { key: 'model', label: L('模型', 'Model'), placeholder: 'gemini-flash-latest', suggestions: ['gemini-flash-latest', 'gemini-flash-lite-latest'] },
      effortField('gemini-api', L('只有支持“思考”的模型才有效；模型不支持时会自动忽略。', 'Only works with thinking models; ignored automatically otherwise.')),
      MAX_CHARS_FIELD,
      { key: 'baseUrl', label: L('接口地址（高级）', 'API base URL (advanced)'), placeholder: 'https://generativelanguage.googleapis.com', advanced: true },
    ],
  },
  'codex-cli': {
    member: 'gpt',
    label: L('Codex CLI（ChatGPT 账号，免费账号也能用）', 'Codex CLI (ChatGPT account, free accounts work)'),
    kind: 'cli',
    bin: 'codex',
    fields: [
      {
        key: 'command',
        label: L('命令或完整路径', 'Command or full path'),
        placeholder: 'codex',
        help: L('没装的话先在 PowerShell 运行 npm i -g @openai/codex，再运行一次 codex，选择用 ChatGPT 账号登录（免费账号也可以）。', 'If not installed, run npm i -g @openai/codex in PowerShell, then run codex once and sign in with your ChatGPT account (free accounts work).'),
      },
      {
        key: 'model',
        label: L('模型', 'Model'),
        type: 'model',
        choices: [],
        placeholder: L('例如 gpt-5.5', 'e.g. gpt-5.5'),
        help: L('“默认”= 你的账号在 Codex 里的默认模型。想换的话选“自定义”，填 Codex 里输入 /model 时看到的名字。', '"Default" uses your account\'s default model in Codex. To change it, choose "Custom" and enter a name shown by /model in Codex.'),
      },
      effortField('codex-cli', L('越高想得越久、回复越慢；免费账号建议用低或中。“很高”只有部分模型支持。', 'Higher means more thinking and slower replies. Low or Medium is best for free accounts. Extra high only works on some models.')),
      MAX_CHARS_FIELD,
      { key: 'extraArgs', label: L('额外命令行参数（高级）', 'Extra command-line arguments (advanced)'), placeholder: L('例如 -c model_verbosity=low', 'e.g. -c model_verbosity=low'), advanced: true },
    ],
  },
  'github-models': {
    member: 'gpt',
    label: L('GitHub Models（备选，免费额度）', 'GitHub Models (alternative, free quota)'),
    kind: 'http',
    fields: [
      { key: 'token', label: 'GitHub Token', secret: true, help: L('在 GitHub 创建 Fine-grained token，权限里把 Models 设为 Read-only（具体步骤见 README）。', 'Create a fine-grained token on GitHub with Models set to Read-only (see the README for steps).') },
      { key: 'model', label: L('模型', 'Model'), placeholder: 'openai/gpt-4.1', suggestions: ['openai/gpt-4.1', 'openai/gpt-4o', 'openai/gpt-4.1-mini'], loadModels: true },
      effortField('github-models', L('只对推理模型（如 o 系列、GPT-5 系列）有效；模型不支持时会自动忽略。', 'Only works with reasoning models (o-series, GPT-5 series); ignored automatically otherwise.')),
      { ...MAX_CHARS_FIELD, help: L('免费额度每次请求最多约 8000 token，建议不超过 5000 字。', 'The free tier allows about 8000 tokens per request, so keep this at 5000 or less.') },
      { key: 'baseUrl', label: L('接口地址（高级）', 'API base URL (advanced)'), placeholder: 'https://models.github.ai/inference', advanced: true },
    ],
  },
  'openai-compatible': {
    member: 'gpt',
    label: L('自定义 OpenAI 兼容接口', 'Custom OpenAI-compatible API'),
    kind: 'http',
    fields: [
      { key: 'baseUrl', label: L('接口地址', 'API base URL'), placeholder: L('例如 https://openrouter.ai/api/v1 或 http://localhost:11434/v1', 'e.g. https://openrouter.ai/api/v1 or http://localhost:11434/v1') },
      { key: 'apiKey', label: 'API Key', secret: true, help: L('本地 Ollama 可以留空。', 'Leave empty for a local Ollama.') },
      { key: 'model', label: L('模型', 'Model'), placeholder: L('例如 gpt-oss:20b', 'e.g. gpt-oss:20b') },
      effortField('openai-compatible', L('只对推理模型有效；接口不支持时会自动忽略。', 'Only works with reasoning models; ignored automatically if the API does not support it.')),
      MAX_CHARS_FIELD,
    ],
  },
};

function merged(prompt) {
  return `${prompt.system}\n\n${prompt.user}`;
}

function cliEnv(proxy) {
  const env = { ...process.env, NO_COLOR: '1' };
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    if (!IS_WIN) {
      env.https_proxy = proxy;
      env.http_proxy = proxy;
    }
  }
  return env;
}

function outputTail(res) {
  return tail(stripAnsi(`${res.stderr || ''}\n${res.stdout || ''}`), 400);
}

// 报错时把工具自己说的话带上（不含被回显的聊天内容），用来判断是不是额度用完了
function withRaw(err, raw) {
  err.raw = String(raw || '');
  return err;
}

// 一段输出的最后几行（报错一般在最后）
function lastLines(text, n = 10) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n');
}

// ---------- Claude Code ----------

function claudeHint(text) {
  const t = String(text);
  if (/inside another Claude Code session|nested/i.test(t)) return tr('不要在 Claude Code 里面启动圆桌，直接双击 start.bat', 'Do not start the roundtable from inside Claude Code; double-click start.bat instead');
  if (detectLimit(t)) return tr('Max 订阅的额度暂时用完了，等恢复后再试；也可以在设置里给 Claude 换一个模型', 'Your Max usage is used up for now; try again after it resets, or pick another model for Claude in Settings');
  if (/log ?in|not logged|auth|credential|oauth|401|403/i.test(t)) return tr('先在命令行运行一次 claude，用 Max 账号登录', 'Run claude once in a terminal and sign in with your Max account');
  // 例如 “Server is temporarily limiting requests (not your usage limit)”、“Request rejected (429)”、“529 Overloaded”
  if (/temporarily limiting|rate limit|overloaded|capacity|\b(?:429|529)\b/i.test(t)) return tr('Anthropic 的服务器暂时繁忙（不是你的额度用完了），等一会儿再试', "Anthropic's servers are busy right now (this is not your usage limit); try again in a moment");
  if (/git-?bash/i.test(t)) return tr('Claude Code 在 Windows 上需要 Git for Windows，先去 git-scm.com 安装', 'Claude Code on Windows needs Git for Windows; install it from git-scm.com');
  return tr('在命令行里手动运行一次 claude -p "你好" 看看能不能正常回复', 'Run claude -p "hello" in a terminal to check that it replies');
}

async function callClaudeCli(c, prompt, ctx) {
  const model = String(c.model || '').trim();
  const effort = pickEffort('claude-cli', c.effort);
  const res = await runAdaptive({
    cacheKey: 'claude',
    command: c.command || 'claude',
    candidates: CANDIDATES.claude,
    before: ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), ...splitArgs(c.extraArgs)],
    groups: [
      { key: 'nosession', args: ['--no-session-persistence'] },
      { key: 'strictmcp', args: ['--strict-mcp-config'] },
      { key: 'system', args: ['--system-prompt', prompt.system] },
      { key: 'tools', args: ['--tools', ''] },
      ...(effort ? [{ key: 'effort', args: ['--effort', effort] }] : []),
    ],
    input: (keys) => (keys.includes('system') ? prompt.user : merged(prompt)),
    cwd: ctx.workdir,
    env: ctx.env,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });

  const out = stripAnsi(res.stdout).trim();
  let obj = null;
  const lines = out.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && !obj; i--) {
    const l = lines[i].trim();
    if (l.startsWith('{')) obj = safeJson(l);
  }
  if (!obj) obj = safeJson(out);
  // 加了 --verbose 时输出的是一个数组（每条消息一项），结果在最后那个 type 为 result 的对象里
  if (Array.isArray(obj)) obj = obj.filter((x) => x && typeof x === 'object' && x.type === 'result').pop() || null;

  // 输出是一个 JSON（type: "result"），出错时也是：is_error 为 true、退出码非 0，原因写在 result 里。
  // 额度用完长这样：{"subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 3:45pm"}
  // 有的版本没有 result，原因在 api_error（例如 usage_limit_reached）或 errors 数组里
  if (obj && typeof obj === 'object' && ('result' in obj || obj.type === 'result')) {
    const text = String(obj.result || '').trim();
    if (obj.is_error || (obj.subtype && obj.subtype !== 'success') || Number(obj.api_error_status) >= 400) {
      const why = [text, ...(Array.isArray(obj.errors) ? obj.errors : []), obj.api_error].filter((x) => x && typeof x === 'string').join('\n') || String(obj.subtype || '');
      throw withRaw(new UserError(tr(`Claude 返回错误：${tail(why, 300)}`, `Claude returned an error: ${tail(why, 300)}`), claudeHint(why)), why);
    }
    if (!text) throw new UserError(tr('Claude 没有返回内容', 'Claude returned nothing'));
    const models = obj.modelUsage && typeof obj.modelUsage === 'object' ? Object.keys(obj.modelUsage) : [];
    return { text, usage: claudeUsage(obj), meta: { model: models[0] || model, ...effortMeta(effort, res.activeKeys.includes('effort'), tr('这个版本的 Claude Code', 'This version of Claude Code ')) } };
  }
  if (res.code !== 0) {
    const said = lastLines(stripEcho(stripAnsi(`${res.stderr}\n${res.stdout}`), prompt.system, prompt.user));
    throw withRaw(new UserError(tr(`Claude Code 运行失败（退出码 ${res.code}）：${outputTail(res)}`, `Claude Code failed (exit code ${res.code}): ${outputTail(res)}`), claudeHint(`${res.stderr}${res.stdout}`)), said);
  }
  if (out) return { text: out, meta: { model, ...effortMeta(effort, res.activeKeys.includes('effort'), tr('这个版本的 Claude Code', 'This version of Claude Code ')) } };
  throw new UserError(tr('Claude 没有返回内容', 'Claude returned nothing'), claudeHint(res.stderr));
}

// Claude Code 报的用量。modelUsage 是这次运行里所有模型调用的合计（包括它内部的辅助调用），优先用它；
// 没有的话用 usage（只算主对话）。读缓存的部分单独记：它便宜得多，不算进合计
function claudeUsage(obj) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const sum = { input: 0, output: 0, cached: 0 };
  const perModel = obj.modelUsage && typeof obj.modelUsage === 'object' ? Object.values(obj.modelUsage) : [];
  for (const m of perModel) {
    if (!m || typeof m !== 'object') continue;
    sum.input += n(m.inputTokens) + n(m.cacheCreationInputTokens);
    sum.output += n(m.outputTokens);
    sum.cached += n(m.cacheReadInputTokens);
  }
  if (sum.input || sum.output || sum.cached) return sum;
  const u = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
  if (!u) return null;
  return { input: n(u.input_tokens) + n(u.cache_creation_input_tokens), output: n(u.output_tokens), cached: n(u.cache_read_input_tokens) };
}

// 回复上显示的思考强度；用户选了但对方不支持时，说明一下
function effortMeta(effort, applied, who) {
  if (!effort) return {};
  return applied ? { effort: effortLabel(effort) } : { note: tr(`${who}不支持选择思考强度，已用默认`, `${who}does not support reasoning effort; used the default`) };
}

// ---------- Antigravity CLI（Gemini，走 AI Pro 订阅） ----------

async function callAgyCli(c, prompt, ctx) {
  const text = merged(prompt);
  const viaStdin = c.promptVia === 'stdin';
  if (!viaStdin && text.length > 30000) {
    throw new UserError(tr('发给 Gemini 的内容太长，超过了 Windows 命令行的长度上限', 'The text for Gemini is longer than the Windows command-line limit'), tr('在设置里把 Gemini 的「最多带多少字的聊天记录」调小，或者开一个新对话', 'Lower Gemini\'s "Max characters of chat history" in Settings, or start a new chat'));
  }
  const model = String(c.model || '').trim();
  const res = await runAdaptive({
    cacheKey: 'agy',
    command: c.command || 'agy',
    candidates: CANDIDATES.agy,
    before: splitArgs(c.extraArgs),
    groups: model ? [{ key: 'model', args: ['--model', model] }] : [],
    after: viaStdin ? ['-p'] : ['-p', text],
    input: viaStdin ? text : null,
    requireDirect: !viaStdin,
    cwd: ctx.workdir,
    env: ctx.env,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  const out = stripAnsi(res.stdout).trim();
  if (res.code !== 0 || !out) {
    // agy 出错时在 stderr 上说原因：“error: …” 开头的一行，加上一行 “AGY_ERROR: {…}”（退出码 3）。
    // 只看它自己说的话：优先 stderr；提示词万一被回显，先去掉
    const errOut = stripAnsi(res.stderr).trim() ? res.stderr : res.stdout;
    const said = lastLines(stripEcho(stripAnsi(errOut), text, prompt.system, prompt.user), 15);
    const ae = agyError(said);
    // 额度用完：AGY_ERROR 里是 429 / RESOURCE_EXHAUSTED；旧版本没有这一行，就看文字（Individual quota reached. …）
    const limit = ae && (Number(ae.error_code) === 429 || ae.status === 'RESOURCE_EXHAUSTED') ? { resetAt: parseResetAt(said) } : detectLimit(said);
    const hint = limit
      ? tr('AI Pro 的额度暂时用完了，等恢复后再试；也可以在设置里把 Gemini 切换成「Gemini API Key」方式', 'Your AI Pro quota is used up for now; try again after it resets, or switch Gemini to "Gemini API Key" in Settings')
      : /log ?in|auth|credential|sign in/i.test(said)
        ? tr('先在命令行运行一次 agy，用 Google 账号登录', 'Run agy once in a terminal and sign in with your Google account')
        : res.code !== 0
          ? tr('在命令行里手动运行一次 agy -p "你好" 看看能不能正常回复', 'Run agy -p "hello" in a terminal to check that it replies')
          : tr('有用户反馈 agy 被程序调用时可能不输出。先运行 agy --version 确认是最新版；还不行的话，在设置里把 Gemini 切换成「Gemini API Key」方式', 'agy sometimes prints nothing when run by another program. Run agy --version to make sure it is up to date; if that does not help, switch Gemini to "Gemini API Key" in Settings');
    const message =
      res.code !== 0
        ? tr(`Antigravity CLI 运行失败（退出码 ${res.code}）：${outputTail(res)}`, `Antigravity CLI failed (exit code ${res.code}): ${outputTail(res)}`)
        : tr(`Antigravity CLI 没有输出任何内容${said ? `：${tail(said, 300)}` : ''}`, `Antigravity CLI produced no output${said ? `: ${tail(said, 300)}` : ''}`);
    const err = withRaw(new UserError(message, hint), said);
    err.limit = limit;
    throw err;
  }
  const note = model && !res.activeKeys.includes('model') ? tr('（agy 不支持 --model，已用默认模型）', '(agy does not support --model; used the default model)') : '';
  return { text: out, meta: { model: model && !note ? model : '', note } };
}

// agy 出错时在 stderr 上打的那一行：AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): …","status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true,…}
function agyError(output) {
  const lines = String(output || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*AGY_ERROR:\s*(\{.*\})\s*$/);
    const obj = m && safeJson(m[1]);
    if (obj && typeof obj === 'object') return obj;
  }
  return null;
}

// ---------- Codex CLI（GPT 的默认方式：ChatGPT 账号，免费账号也能用） ----------

// codex exec 结束时在 stderr 的最后打印两行：“tokens used” 和一个数字。
// 这个数字是“没走缓存的输入 + 输出”，按系统语言加分隔符（12,345 / 12.345 / 12 345）。
// 提示词和模型的话也会出现在输出里，所以取最后一次出现的那个。
function codexTokensUsed(output) {
  const hits = [...stripAnsi(output).matchAll(/tokens used:?[ \t]*\r?\n?[ \t]*([^\r\n]*)/gi)];
  if (!hits.length) return null;
  const n = parseLocaleInt(hits[hits.length - 1][1]);
  return n == null ? null : { total: n };
}

async function callCodexCli(c, prompt, ctx) {
  const outFile = path.join(os.tmpdir(), `ai-roundtable-codex-${uid()}.txt`);
  const model = String(c.model || '').trim();
  const effort = pickEffort('codex-cli', c.effort);
  const input = merged(prompt);
  try {
    const res = await runAdaptive({
      cacheKey: 'codex',
      command: c.command || 'codex',
      candidates: CANDIDATES.codex,
      before: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', outFile, ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), ...splitArgs(c.extraArgs)],
      groups: [
        { key: 'ephemeral', args: ['--ephemeral'] },
        { key: 'color', args: ['--color', 'never'] },
      ],
      after: ['-'],
      input,
      cwd: ctx.workdir,
      env: ctx.env,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    }).catch((e) => {
      if (e.userFacing && /找不到命令|Command not found/.test(e.message)) {
        e.hint = tr('先装 Codex：在 PowerShell 运行 npm i -g @openai/codex（需要先装 Node.js），再运行一次 codex，用 ChatGPT 账号登录。装好后重新打开 AI 圆桌', 'Install Codex first: run npm i -g @openai/codex in PowerShell (needs Node.js), then run codex once and sign in with your ChatGPT account. Then reopen AI Roundtable');
      }
      throw e;
    });
    let text = '';
    try {
      text = fs.readFileSync(outFile, 'utf8').trim();
    } catch {
      /* no file */
    }
    if (!text && res.code === 0) text = stripAnsi(res.stdout).trim();
    if (!text) {
      // codex exec 会把提示词原样回显在 stderr 里（“user” 下面那一段），模型说到一半的话也在里面。
      // 判断原因时只看它自己的 “ERROR: …” 那几行；没有的话，看去掉回显后的最后几行
      const own = stripEcho(stripAnsi(`${res.stderr}\n${res.stdout}`), input);
      const errors = own.split(/\r?\n/).filter((l) => /^\s*ERROR:/.test(l));
      const all = errors.length ? errors.join('\n') : lastLines(own);
      const limit = detectLimit(all);
      const hint = limit
        ? tr('Codex 的额度暂时用完了（免费账号额度比较小），晚点再试；也可以在设置里把 GPT 换成 GitHub Models', 'Your Codex quota is used up for now (free accounts get less); try later, or switch GPT to GitHub Models in Settings')
        : /To use Codex with your ChatGPT plan/i.test(all)
          ? // 这个账号的套餐不含 Codex（OpenAI 对免费账号可能只是限时开放）：等多久都没用，所以不算“额度用完”
            tr('你的 ChatGPT 套餐现在不包含 Codex：升级套餐，或者在设置里把 GPT 换成 GitHub Models（免费）', 'Your ChatGPT plan does not include Codex right now: upgrade the plan, or switch GPT to GitHub Models (free) in Settings')
          : /log ?in|auth|401|unauthori/i.test(all)
            ? tr('先在 PowerShell 运行一次 codex，选择用 ChatGPT 账号登录', 'Run codex once in PowerShell and sign in with your ChatGPT account')
            : effort && /reasoning|effort/i.test(all)
              ? tr('这个模型可能不支持所选的思考强度，在设置里把 GPT 的「思考强度」改成默认或低一档', 'This model may not support the chosen reasoning effort; set GPT\'s reasoning effort to Default or one level lower in Settings')
              : tr('在 PowerShell 里手动运行一次 codex exec "你好" 看看能不能正常回复', 'Run codex exec "hello" in PowerShell to check that it replies');
      const err = withRaw(new UserError(res.code !== 0 ? tr(`Codex 运行失败（退出码 ${res.code}）：${outputTail(res)}`, `Codex failed (exit code ${res.code}): ${outputTail(res)}`) : tr('Codex 没有返回内容', 'Codex returned nothing'), hint), all);
      err.limit = limit;
      throw err;
    }
    return { text, usage: codexTokensUsed(res.stderr) || codexTokensUsed(res.stdout), meta: { model, ...effortMeta(effort, true) } };
  } finally {
    fs.rm(outFile, { force: true }, () => {});
  }
}

// ---------- HTTP 接口 ----------

function httpError(label, res, json) {
  const raw =
    (json && json.error && (json.error.message || (typeof json.error === 'string' ? json.error : ''))) ||
    (json && json.message) ||
    res.text ||
    '';
  const msg = tail(String(raw).replace(/\s+/g, ' '), 300);
  const s = res.status;
  // 这一次请求本身太大（有的接口用 429 报这个）：不是额度用完，等多久都没用
  const tooLarge = s === 413 || /too large|max(imum)? (size|context)|context length|token(s)? (limit|exceeded)/i.test(msg);
  let hint;
  if (s === 401) hint = tr('Token / API Key 无效或已过期，请重新生成后填到设置里', 'The token or API key is invalid or expired; create a new one and enter it in Settings');
  else if (s === 403) hint = label === 'GitHub Models' ? tr('Token 缺少 Models 权限：创建 Fine-grained token 时把 Models 设为 Read-only', 'The token lacks the Models permission: set Models to Read-only when creating the fine-grained token') : tr('没有权限使用这个模型', 'No permission to use this model');
  else if (s === 404 || /unknown model|model .*not (found|supported)|does not exist/i.test(msg)) hint = tr('模型名称可能不对，去设置里换一个模型（GitHub Models 可以点「加载可用模型」）', 'The model name may be wrong; pick another model in Settings (for GitHub Models, click "Load available models")');
  else if (tooLarge) {
    hint = tr('聊天记录太长了：在设置里把「最多带多少字的聊天记录」调小，或者开一个新对话', 'The chat history is too long: lower "Max characters of chat history" in Settings, or start a new chat');
  } else if (s === 429) hint = tr('免费额度用完了或请求太频繁，等一会儿（或明天）再试，也可以换一个模型', 'Free quota used up or too many requests; try again later (or tomorrow), or switch models');
  else if (s === 400 && /api key|API_KEY/i.test(msg)) hint = tr('API Key 不对，检查一下是否复制完整', 'The API key is wrong; check that you copied all of it');
  else if (s >= 500) hint = tr('对方服务器出错了，稍后再试', 'The service had a server error; try again later');
  const err = withRaw(new UserError(tr(`${label} 请求失败（HTTP ${s}）：${msg || '没有错误详情'}`, `${label} request failed (HTTP ${s}): ${msg || 'no error details'}`), hint), raw);
  // 429 = 额度用完或请求太频繁，402 = 余额不足。多久后能再试：按天算的额度等到第二天；
  // 否则先看 Retry-After 这类明确的字段，再看报错里的文字
  if (tooLarge) err.limit = null;
  else if (s === 429 || s === 402) {
    const resetAt = dailyQuotaResetAt(json) || retryAfterAt(res.headers, json) || parseResetAt(raw);
    // 只说“请求太多”，既没提额度也没说要等多久（本地模型排队时就是这样）：多半是暂时的，过几分钟再试，不用等一小时
    const said = detectLimit(raw);
    const brief = resetAt == null && s === 429 && (!said || said.retryInMs);
    err.limit = { resetAt, ...(brief ? { retryInMs: BRIEF_RETRY_MS } : {}) };
  }
  return err;
}

async function callOpenAICompatible({ baseUrl, apiKey, model, effort = '', extraHeaders = {}, label }, prompt, ctx) {
  if (!baseUrl) throw new UserError(tr(`${label}：还没填写接口地址`, `${label}: no API base URL entered yet`));
  if (!model) throw new UserError(tr(`${label}：还没填写模型`, `${label}: no model entered yet`));
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let useEffort = Boolean(effort);
  const body = (mergeSystem) => ({
    model,
    ...(useEffort ? { reasoning_effort: effort } : {}),
    messages: mergeSystem
      ? [{ role: 'user', content: merged(prompt) }]
      : [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
  });
  const opts = { method: 'POST', headers, proxy: ctx.proxy, timeoutMs: ctx.timeoutMs, signal: ctx.signal };
  let res = await request(url, { ...opts, body: body(false) });
  // 不是推理模型时，接口可能不认 reasoning_effort：去掉后重试一次
  if (useEffort && res.status === 400 && /reasoning/i.test(res.text)) {
    useEffort = false;
    res = await request(url, { ...opts, body: body(false) });
  }
  // 少数模型不接受 system 消息，合并后重试一次
  if (res.status === 400 && /system/i.test(res.text) && /role|message/i.test(res.text)) {
    res = await request(url, { ...opts, body: body(true) });
  }
  const json = safeJson(res.text);
  if (res.status < 200 || res.status >= 300) throw httpError(label, res, json);
  const choice = json && json.choices && json.choices[0];
  const content = choice && choice.message ? choice.message.content : '';
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text || '').join('') : '').trim();
  if (!text) throw new UserError(tr(`${label} 没有返回内容`, `${label} returned nothing`), choice && choice.finish_reason ? tr(`结束原因：${choice.finish_reason}`, `Finish reason: ${choice.finish_reason}`) : undefined);
  return { text, usage: openAiUsage(json && json.usage), meta: { model: (json && json.model) || model, ...effortMeta(effort, useEffort, tr('这个模型', 'This model ')) } };
}

// prompt_tokens 里包含走缓存的部分（prompt_tokens_details.cached_tokens），单独拿出来
function openAiUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const prompt = n(u.prompt_tokens) || n(u.input_tokens);
  const details = u.prompt_tokens_details || u.input_tokens_details || {};
  const cached = Math.min(prompt, n(details.cached_tokens));
  const usage = { input: prompt - cached, output: n(u.completion_tokens) || n(u.output_tokens), cached };
  // 只给了合计的接口
  if (!usage.input && !usage.output) usage.total = n(u.total_tokens);
  return usage;
}

function callGithubModels(c, prompt, ctx) {
  if (!c.token) throw new UserError(tr('还没有填写 GitHub Token', 'No GitHub token entered yet'), tr('点右上角「设置」→ GPT → 填入 GitHub Token', 'Open Settings (top right) → GPT → enter your GitHub token'));
  return callOpenAICompatible(
    {
      baseUrl: c.baseUrl || 'https://models.github.ai/inference',
      apiKey: c.token,
      model: c.model || 'openai/gpt-4.1',
      effort: pickEffort('github-models', c.effort),
      extraHeaders: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      label: 'GitHub Models',
    },
    prompt,
    ctx
  );
}

async function callGeminiApi(c, prompt, ctx) {
  if (!c.apiKey) throw new UserError(tr('还没有填写 Gemini API Key', 'No Gemini API key entered yet'), tr('在 Google AI Studio 创建 API Key 后填到设置里', 'Create an API key in Google AI Studio and enter it in Settings'));
  const model = String(c.model || 'gemini-flash-latest').replace(/^models\//, '');
  const base = String(c.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const effort = pickEffort('gemini-api', c.effort);
  let useEffort = Boolean(effort);
  const send = () =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.apiKey },
      body: {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        ...(useEffort ? { generationConfig: { thinkingConfig: { thinkingLevel: effort } } } : {}),
      },
      proxy: ctx.proxy,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
  let res = await send();
  // 不支持 thinkingLevel 的模型会报 400：去掉后重试一次
  if (useEffort && res.status === 400 && /think/i.test(res.text)) {
    useEffort = false;
    res = await send();
  }
  const json = safeJson(res.text);
  if (res.status !== 200) throw httpError('Gemini API', res, json);
  const cand = json && json.candidates && json.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) {
    const block = json && json.promptFeedback && json.promptFeedback.blockReason;
    throw new UserError(tr('Gemini API 没有返回内容', 'Gemini API returned nothing'), block ? tr(`被安全策略拦截：${block}`, `Blocked by safety filters: ${block}`) : cand && cand.finishReason ? tr(`结束原因：${cand.finishReason}`, `Finish reason: ${cand.finishReason}`) : undefined);
  }
  // promptTokenCount 里包含走缓存的部分（cachedContentTokenCount），单独拿出来；思考用的 token 算在输出里
  const u = json && json.usageMetadata && typeof json.usageMetadata === 'object' ? json.usageMetadata : null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const cached = u ? Math.min(n(u.promptTokenCount), n(u.cachedContentTokenCount)) : 0;
  const usage = u ? { input: n(u.promptTokenCount) - cached + n(u.toolUsePromptTokenCount), output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount), cached } : null;
  if (usage && !usage.input && !usage.output) usage.total = n(u.totalTokenCount);
  return { text, usage, meta: { model: (json && json.modelVersion) || model, ...effortMeta(effort, useEffort, tr('这个模型', 'This model ')) } };
}

// ---------- 对外接口 ----------

// 统一入口：调用对应的接入方式。额度用完的报错会带上 e.limit = { resetAt }（resetAt 可能是 null）
async function callProvider(providerId, cfg, prompt, ctx) {
  let res;
  try {
    res = await dispatch(providerId, cfg, prompt, ctx);
  } catch (e) {
    // 只看工具自己说的话（e.raw），而且先去掉可能被回显的聊天内容
    if (e && e.userFacing && e.limit === undefined) e.limit = e.raw ? detectLimit(stripEcho(e.raw, prompt.system, prompt.user)) : null;
    throw e;
  }
  // 有的工具额度用完时不报错，而是把那句提示当成回复正常输出
  const limit = limitReply(res.text);
  if (limit) {
    const e = new UserError(tr(`额度用完了：${String(res.text).trim()}`, `Out of usage: ${String(res.text).trim()}`));
    e.limit = limit;
    throw e;
  }
  return res;
}

function dispatch(providerId, cfg, prompt, ctx) {
  const c = { ...ctx, env: cliEnv(ctx.proxy) };
  switch (providerId) {
    case 'claude-cli':
      return callClaudeCli(cfg, prompt, c);
    case 'agy-cli':
      return callAgyCli(cfg, prompt, c);
    case 'codex-cli':
      return callCodexCli(cfg, prompt, c);
    case 'github-models':
      return callGithubModels(cfg, prompt, c);
    case 'gemini-api':
      return callGeminiApi(cfg, prompt, c);
    case 'openai-compatible':
      return callOpenAICompatible(
        { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, effort: pickEffort('openai-compatible', cfg.effort), label: tr('自定义接口', 'Custom API') },
        prompt,
        c
      );
    default:
      throw new UserError(tr(`未知的接入方式：${providerId}`, `Unknown connection type: ${providerId}`));
  }
}

function readiness(providerId, cfg = {}) {
  const meta = PROVIDERS[providerId];
  if (!meta) return { ready: false, reason: tr('接入方式无效', 'Invalid connection type') };
  if (meta.kind === 'cli') {
    const cmd = cfg.command || meta.bin;
    const d = detectCommand(cmd, CANDIDATES[meta.bin]);
    return d.found ? { ready: true, path: d.path } : { ready: false, reason: tr(`没找到 ${cmd} 命令`, `${cmd} command not found`) };
  }
  if (providerId === 'github-models') return cfg.token ? { ready: true } : { ready: false, reason: tr('还没填 GitHub Token', 'No GitHub token yet') };
  if (providerId === 'gemini-api') return cfg.apiKey ? { ready: true } : { ready: false, reason: tr('还没填 API Key', 'No API key yet') };
  if (providerId === 'openai-compatible') return cfg.baseUrl && cfg.model ? { ready: true } : { ready: false, reason: tr('还没填接口地址或模型', 'No API base URL or model yet') };
  return { ready: true };
}

async function listGithubModels(cfg, ctx) {
  if (!cfg.token) throw new UserError(tr('先填写并保存 GitHub Token', 'Enter and save a GitHub token first'));
  const base = String(cfg.baseUrl || 'https://models.github.ai/inference').replace(/\/+$/, '');
  const url = `${base.replace(/\/inference$/, '')}/catalog/models`;
  const res = await request(url, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    proxy: ctx.proxy,
    timeoutMs: 30000,
  });
  const json = safeJson(res.text);
  if (res.status !== 200) throw httpError('GitHub Models', res, json);
  const list = Array.isArray(json) ? json : json && (json.data || json.models || json.items);
  if (!Array.isArray(list)) {
    const snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 200) || tr('（空）', '(empty)');
    throw new UserError(tr(`GitHub Models 返回的模型列表格式看不懂：${snippet}`, `Could not read the model list from GitHub Models: ${snippet}`), tr('可以不加载列表，直接在「模型」里填 openai/gpt-4.1，再点「保存并测试」', 'You can skip the list: enter openai/gpt-4.1 as the model and click "Save and test"'));
  }
  const isOpenAI = (m) => (String(m.id).startsWith('openai/') ? 0 : 1);
  return list
    .filter((m) => m && m.id)
    .map((m) => ({ id: m.id, name: m.name || m.id, publisher: m.publisher || '', tier: m.rate_limit_tier || '' }))
    .sort((a, b) => isOpenAI(a) - isOpenAI(b) || a.id.localeCompare(b.id));
}

module.exports = { PROVIDERS, CANDIDATES, callProvider, readiness, listGithubModels };
