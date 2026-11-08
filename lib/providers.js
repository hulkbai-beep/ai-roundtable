'use strict';

// 三位成员的各种“接入方式”：命令行工具（走订阅）或 HTTP 接口（走免费额度 / API Key）

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAdaptive, detectCommand } = require('./spawn');
const { request } = require('./http');
const { stripAnsi, splitArgs, tail, uid, safeJson, UserError } = require('./util');

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

const MAX_CHARS_FIELD = { key: 'maxChars', label: '最多带多少字的聊天记录', type: 'number' };

const PROVIDERS = {
  'claude-cli': {
    member: 'claude',
    label: 'Claude Code（Max 订阅）',
    kind: 'cli',
    bin: 'claude',
    fields: [
      { key: 'command', label: '命令或完整路径', placeholder: 'claude', help: '一般保持 claude 即可；提示找不到时，填 claude.exe 的完整路径。' },
      { key: 'model', label: '模型', placeholder: '留空 = 你的默认模型', suggestions: ['opus', 'sonnet', 'haiku'] },
      MAX_CHARS_FIELD,
      { key: 'extraArgs', label: '额外命令行参数（高级）', placeholder: '例如 --effort low', advanced: true },
    ],
  },
  'agy-cli': {
    member: 'gemini',
    label: 'Antigravity CLI（AI Pro 订阅）',
    kind: 'cli',
    bin: 'agy',
    fields: [
      { key: 'command', label: '命令或完整路径', placeholder: 'agy', help: '先在命令行运行一次 agy，用你的 Google 账号登录。' },
      { key: 'model', label: '模型', placeholder: '留空 = 默认模型' },
      { ...MAX_CHARS_FIELD, help: '提示词通过命令行参数传递，Windows 对长度有限制，建议不超过 20000。' },
      {
        key: 'promptVia',
        label: '提示词传递方式（高级）',
        type: 'select',
        options: [
          ['arg', '命令行参数（默认）'],
          ['stdin', '标准输入'],
        ],
        advanced: true,
      },
      { key: 'extraArgs', label: '额外命令行参数（高级）', advanced: true },
    ],
  },
  'gemini-api': {
    member: 'gemini',
    label: 'Gemini API Key（备选，不走订阅）',
    kind: 'http',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, help: '在 Google AI Studio 创建。这条路不走 AI Pro 订阅，费用和免费额度以官网为准。' },
      { key: 'model', label: '模型', placeholder: 'gemini-flash-latest', suggestions: ['gemini-flash-latest', 'gemini-flash-lite-latest'] },
      MAX_CHARS_FIELD,
      { key: 'baseUrl', label: '接口地址（高级）', placeholder: 'https://generativelanguage.googleapis.com', advanced: true },
    ],
  },
  'github-models': {
    member: 'gpt',
    label: 'GitHub Models（免费额度）',
    kind: 'http',
    fields: [
      { key: 'token', label: 'GitHub Token', secret: true, help: '在 GitHub 创建 Fine-grained token，权限里把 Models 设为 Read-only（具体步骤见 README）。' },
      { key: 'model', label: '模型', placeholder: 'openai/gpt-4.1', suggestions: ['openai/gpt-4.1', 'openai/gpt-4o', 'openai/gpt-4.1-mini'], loadModels: true },
      { ...MAX_CHARS_FIELD, help: '免费额度每次请求最多约 8000 token，建议不超过 5000 字。' },
      { key: 'baseUrl', label: '接口地址（高级）', placeholder: 'https://models.github.ai/inference', advanced: true },
    ],
  },
  'codex-cli': {
    member: 'gpt',
    label: 'Codex CLI（免费 ChatGPT 账号）',
    kind: 'cli',
    bin: 'codex',
    fields: [
      { key: 'command', label: '命令或完整路径', placeholder: 'codex', help: '先在命令行运行一次 codex，用 ChatGPT 账号登录。' },
      { key: 'model', label: '模型', placeholder: '留空 = 默认模型' },
      MAX_CHARS_FIELD,
      { key: 'extraArgs', label: '额外命令行参数（高级）', advanced: true },
    ],
  },
  'openai-compatible': {
    member: 'gpt',
    label: '自定义 OpenAI 兼容接口',
    kind: 'http',
    fields: [
      { key: 'baseUrl', label: '接口地址', placeholder: '例如 https://openrouter.ai/api/v1 或 http://localhost:11434/v1' },
      { key: 'apiKey', label: 'API Key', secret: true, help: '本地 Ollama 可以留空。' },
      { key: 'model', label: '模型', placeholder: '例如 gpt-oss:20b' },
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

// ---------- Claude Code ----------

function claudeHint(text) {
  const t = String(text);
  if (/inside another Claude Code session|nested/i.test(t)) return '不要在 Claude Code 里面启动圆桌，直接双击 start.bat';
  if (/log ?in|not logged|auth|credential|oauth|401|403/i.test(t)) return '先在命令行运行一次 claude，用 Max 账号登录';
  if (/usage limit|rate limit|limit reached|429/i.test(t)) return 'Max 订阅的额度暂时用完了，等一会儿再试';
  if (/git-?bash/i.test(t)) return 'Claude Code 在 Windows 上需要 Git for Windows，先去 git-scm.com 安装';
  return '在命令行里手动运行一次 claude -p "你好" 看看能不能正常回复';
}

async function callClaudeCli(c, prompt, ctx) {
  const model = String(c.model || '').trim();
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

  if (obj && typeof obj === 'object' && 'result' in obj) {
    const text = String(obj.result || '').trim();
    if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
      throw new UserError(`Claude 返回错误：${tail(text || obj.subtype, 300)}`, claudeHint(text));
    }
    if (!text) throw new UserError('Claude 没有返回内容');
    const usage = obj.modelUsage && typeof obj.modelUsage === 'object' ? Object.keys(obj.modelUsage) : [];
    return { text, meta: { model: usage[0] || model } };
  }
  if (res.code !== 0) {
    throw new UserError(`Claude Code 运行失败（退出码 ${res.code}）：${outputTail(res)}`, claudeHint(`${res.stderr}${res.stdout}`));
  }
  if (out) return { text: out, meta: { model } };
  throw new UserError('Claude 没有返回内容', claudeHint(res.stderr));
}

// ---------- Antigravity CLI（Gemini，走 AI Pro 订阅） ----------

async function callAgyCli(c, prompt, ctx) {
  const text = merged(prompt);
  const viaStdin = c.promptVia === 'stdin';
  if (!viaStdin && text.length > 30000) {
    throw new UserError('发给 Gemini 的内容太长，超过了 Windows 命令行的长度上限', '在设置里把 Gemini 的「最多带多少字的聊天记录」调小，或者开一个新对话');
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
  if (res.code !== 0) {
    const all = `${res.stderr}\n${res.stdout}`;
    const hint = /log ?in|auth|credential|sign in/i.test(all)
      ? '先在命令行运行一次 agy，用 Google 账号登录'
      : /quota|limit|429|exhausted/i.test(all)
        ? 'AI Pro 的额度暂时用完了，等一会儿再试'
        : '在命令行里手动运行一次 agy -p "你好" 看看能不能正常回复';
    throw new UserError(`Antigravity CLI 运行失败（退出码 ${res.code}）：${outputTail(res)}`, hint);
  }
  if (!out) {
    throw new UserError(
      'Antigravity CLI 没有输出任何内容',
      '有用户反馈 agy 被程序调用时可能不输出。先运行 agy --version 确认是最新版；还不行的话，在设置里把 Gemini 切换成「Gemini API Key」方式'
    );
  }
  const note = model && !res.activeKeys.includes('model') ? '（agy 不支持 --model，已用默认模型）' : '';
  return { text: out, meta: { model: model && !note ? model : '', note } };
}

// ---------- Codex CLI（GPT，免费 ChatGPT 账号） ----------

async function callCodexCli(c, prompt, ctx) {
  const outFile = path.join(os.tmpdir(), `ai-roundtable-codex-${uid()}.txt`);
  const model = String(c.model || '').trim();
  try {
    const res = await runAdaptive({
      cacheKey: 'codex',
      command: c.command || 'codex',
      candidates: CANDIDATES.codex,
      before: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', outFile, ...(model ? ['-m', model] : []), ...splitArgs(c.extraArgs)],
      groups: [
        { key: 'ephemeral', args: ['--ephemeral'] },
        { key: 'color', args: ['--color', 'never'] },
      ],
      after: ['-'],
      input: merged(prompt),
      cwd: ctx.workdir,
      env: ctx.env,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    let text = '';
    try {
      text = fs.readFileSync(outFile, 'utf8').trim();
    } catch {
      /* no file */
    }
    if (!text && res.code === 0) text = stripAnsi(res.stdout).trim();
    if (!text) {
      const all = `${res.stderr}\n${res.stdout}`;
      const hint = /log ?in|auth|401|unauthori/i.test(all)
        ? '先在命令行运行一次 codex，用 ChatGPT 账号登录'
        : /limit|quota|429/i.test(all)
          ? '免费账号的 Codex 额度用完了，晚点再试，或者换回 GitHub Models'
          : '在命令行里手动运行一次 codex exec "你好" 看看能不能正常回复';
      throw new UserError(res.code !== 0 ? `Codex 运行失败（退出码 ${res.code}）：${outputTail(res)}` : 'Codex 没有返回内容', hint);
    }
    return { text, meta: { model } };
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
  let hint;
  if (s === 401) hint = 'Token / API Key 无效或已过期，请重新生成后填到设置里';
  else if (s === 403) hint = label === 'GitHub Models' ? 'Token 缺少 Models 权限：创建 Fine-grained token 时把 Models 设为 Read-only' : '没有权限使用这个模型';
  else if (s === 404 || /unknown model|model .*not (found|supported)|does not exist/i.test(msg)) hint = '模型名称可能不对，去设置里换一个模型（GitHub Models 可以点「加载可用模型」）';
  else if (s === 413 || /too large|max(imum)? (size|context)|context length|token(s)? (limit|exceeded)/i.test(msg)) {
    hint = '聊天记录太长了：在设置里把「最多带多少字的聊天记录」调小，或者开一个新对话';
  } else if (s === 429) hint = '免费额度用完了或请求太频繁，等一会儿（或明天）再试，也可以换一个模型';
  else if (s === 400 && /api key|API_KEY/i.test(msg)) hint = 'API Key 不对，检查一下是否复制完整';
  else if (s >= 500) hint = '对方服务器出错了，稍后再试';
  return new UserError(`${label} 请求失败（HTTP ${s}）：${msg || '没有错误详情'}`, hint);
}

async function callOpenAICompatible({ baseUrl, apiKey, model, extraHeaders = {}, label }, prompt, ctx) {
  if (!baseUrl) throw new UserError(`${label}：还没填写接口地址`);
  if (!model) throw new UserError(`${label}：还没填写模型`);
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = (mergeSystem) => ({
    model,
    messages: mergeSystem
      ? [{ role: 'user', content: merged(prompt) }]
      : [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
  });
  const opts = { method: 'POST', headers, proxy: ctx.proxy, timeoutMs: ctx.timeoutMs, signal: ctx.signal };
  let res = await request(url, { ...opts, body: body(false) });
  // 少数模型不接受 system 消息，合并后重试一次
  if (res.status === 400 && /system/i.test(res.text) && /role|message/i.test(res.text)) {
    res = await request(url, { ...opts, body: body(true) });
  }
  const json = safeJson(res.text);
  if (res.status < 200 || res.status >= 300) throw httpError(label, res, json);
  const choice = json && json.choices && json.choices[0];
  const content = choice && choice.message ? choice.message.content : '';
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text || '').join('') : '').trim();
  if (!text) throw new UserError(`${label} 没有返回内容`, choice && choice.finish_reason ? `结束原因：${choice.finish_reason}` : undefined);
  return { text, meta: { model: (json && json.model) || model } };
}

function callGithubModels(c, prompt, ctx) {
  if (!c.token) throw new UserError('还没有填写 GitHub Token', '点右上角「设置」→ GPT → 填入 GitHub Token');
  return callOpenAICompatible(
    {
      baseUrl: c.baseUrl || 'https://models.github.ai/inference',
      apiKey: c.token,
      model: c.model || 'openai/gpt-4.1',
      extraHeaders: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      label: 'GitHub Models',
    },
    prompt,
    ctx
  );
}

async function callGeminiApi(c, prompt, ctx) {
  if (!c.apiKey) throw new UserError('还没有填写 Gemini API Key', '在 Google AI Studio 创建 API Key 后填到设置里');
  const model = String(c.model || 'gemini-flash-latest').replace(/^models\//, '');
  const base = String(c.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.apiKey },
    body: {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    },
    proxy: ctx.proxy,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
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
    throw new UserError('Gemini API 没有返回内容', block ? `被安全策略拦截：${block}` : cand && cand.finishReason ? `结束原因：${cand.finishReason}` : undefined);
  }
  return { text, meta: { model: (json && json.modelVersion) || model } };
}

// ---------- 对外接口 ----------

async function callProvider(providerId, cfg, prompt, ctx) {
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
      return callOpenAICompatible({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, label: '自定义接口' }, prompt, c);
    default:
      throw new UserError(`未知的接入方式：${providerId}`);
  }
}

function readiness(providerId, cfg = {}) {
  const meta = PROVIDERS[providerId];
  if (!meta) return { ready: false, reason: '接入方式无效' };
  if (meta.kind === 'cli') {
    const cmd = cfg.command || meta.bin;
    const d = detectCommand(cmd, CANDIDATES[meta.bin]);
    return d.found ? { ready: true, path: d.path } : { ready: false, reason: `没找到 ${cmd} 命令` };
  }
  if (providerId === 'github-models') return cfg.token ? { ready: true } : { ready: false, reason: '还没填 GitHub Token' };
  if (providerId === 'gemini-api') return cfg.apiKey ? { ready: true } : { ready: false, reason: '还没填 API Key' };
  if (providerId === 'openai-compatible') return cfg.baseUrl && cfg.model ? { ready: true } : { ready: false, reason: '还没填接口地址或模型' };
  return { ready: true };
}

async function listGithubModels(cfg, ctx) {
  if (!cfg.token) throw new UserError('先填写并保存 GitHub Token');
  const base = String(cfg.baseUrl || 'https://models.github.ai/inference').replace(/\/+$/, '');
  const url = `${base.replace(/\/inference$/, '')}/catalog/models`;
  const res = await request(url, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    proxy: ctx.proxy,
    timeoutMs: 30000,
  });
  const json = safeJson(res.text);
  if (res.status !== 200 || !Array.isArray(json)) throw httpError('GitHub Models', res, json);
  const isOpenAI = (m) => (String(m.id).startsWith('openai/') ? 0 : 1);
  return json
    .filter((m) => m && m.id)
    .map((m) => ({ id: m.id, name: m.name || m.id, publisher: m.publisher || '', tier: m.rate_limit_tier || '' }))
    .sort((a, b) => isOpenAI(a) - isOpenAI(b) || a.id.localeCompare(b.id));
}

module.exports = { PROVIDERS, CANDIDATES, callProvider, readiness, listGithubModels };
