'use strict';

// 设置里的「加载可用模型」：问各个工具 / 接口“这个账号现在能用哪些模型”；
// 再记下每个名字实际用的是哪个模型（“默认”“Opus”背后是哪个版本），显示在模型的下拉框里。
//
// 各家怎么问（都还没有在真机上验证过，出处见 CLAUDE.md 的“模型列表”一节）：
//   Codex：`codex debug models`，stdout 上是一行 JSON：{"models":[{slug, display_name, description, visibility, priority, …}]}
//   Antigravity：`agy models --output-format json`（1.1.12 起）；旧版本不认 --output-format，去掉以后读文字。
//     输出具体长什么样官方没有写，所以认得宽一些（parseModelList），认不出来就把原样输出放进报错里
//   Gemini API：GET /v1beta/models，只要支持 generateContent 的
//   自定义接口：GET <接口地址>/models（OpenAI 的格式：{data:[{id}]}）
//   GitHub Models：GET /catalog/models
//   Claude Code：没有能列出模型的命令，列表是固定的那几个名字（providers.js）；版本号靠下面的 ModelStore 记下来的“实际用的模型”显示

const fs = require('fs');
const crypto = require('crypto');
const { runAdaptive } = require('./spawn');
const { request } = require('./http');
const { stripAnsi, safeJson, cut, tail, UserError } = require('./util');
const { tr } = require('./i18n');
const { CANDIDATES, cliEnv, httpError } = require('./providers');

const LIST_TIMEOUT_MS = 45000; // 列模型不该很久；工具卡住时不让设置页一直转
const MAX_ITEMS = 1000;
const NOTES_UP_TO = 100; // 模型多于这个数（OpenRouter 有几百个）就不留说明，列表才不会太大
const MAX_SEEN = 40;

const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const snippet = (text, n = 300) => cut(oneLine(stripAnsi(text)), n) || tr('（空）', '(empty)');
const CUSTOM_HINT = () => tr('也可以不用列表：在「模型」里选“自定义”，直接填模型的名字', 'You can skip the list: choose "Custom" under Model and type the model name');

// 整理成界面要的样子：[{ id, name, note }]，去掉重复的和空的
function clean(list) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const id = cut(str(m && m.id), 200);
    if (!id || /[\r\n]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = cut(oneLine(m.name), 100);
    out.push({ id, name: name && name !== id ? name : '', note: cut(oneLine(m.note), 160) });
    if (out.length >= MAX_ITEMS) break;
  }
  if (out.length > NOTES_UP_TO) for (const m of out) m.note = '';
  return out;
}

// 从工具的输出里找出那个 JSON：整段就是；或者是某一行；或者前后夹着别的文字
function findJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const whole = safeJson(t);
  if (whole && typeof whole === 'object') return whole;
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    const v = l.startsWith('{') || l.startsWith('[') ? safeJson(l) : null;
    if (v && typeof v === 'object') return v;
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  const inner = a >= 0 && b > a ? safeJson(t.slice(a, b + 1)) : null;
  return inner && typeof inner === 'object' ? inner : null;
}

// ---------- Codex ----------

function codexModels(json) {
  const models = Array.isArray(json) ? json : json && (json.models || json.data);
  if (!Array.isArray(models)) return null;
  const all = models.filter((m) => m && typeof m === 'object' && str(m.slug || m.id));
  // 和 Codex 自己的 /model 一样：只要 visibility 是 list 的，按 priority 从小到大排
  const listed = all.some((m) => m.visibility === 'list') ? all.filter((m) => m.visibility === 'list') : all;
  const priority = (m) => (Number.isFinite(Number(m.priority)) ? Number(m.priority) : 0);
  return [...listed].sort((x, y) => priority(x) - priority(y)).map((m) => ({ id: m.slug || m.id, name: m.display_name, note: m.description }));
}

async function listCodex(cfg, ctx) {
  const res = await runAdaptive({
    cacheKey: 'codex',
    command: cfg.command || 'codex',
    candidates: CANDIDATES.codex,
    before: ['debug', 'models'],
    cwd: ctx.workdir,
    env: ctx.env,
    timeoutMs: LIST_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const items = res.code === 0 ? codexModels(findJson(stripAnsi(res.stdout))) : null;
  if (items && items.length) return items;
  if (items) throw new UserError(tr('Codex 给的模型列表是空的', 'Codex returned an empty model list'), tr('先在 PowerShell 运行一次 codex，确认已经用 ChatGPT 账号登录；也可以选“自定义”，直接填模型的名字', 'Run codex once in PowerShell to check that you are signed in with your ChatGPT account, or choose "Custom" and type the model name'));
  const said = stripAnsi(`${res.stderr}\n${res.code === 0 ? res.stdout : ''}`);
  // 旧版本没有 debug models 这个命令（clap 的报错：unrecognized subcommand 'models'）
  if (/unrecognized subcommand|unknown (?:sub)?command|invalid (?:sub)?command|unexpected argument/i.test(said)) {
    throw new UserError(
      tr('这个版本的 Codex 还不能列出模型', 'This version of Codex cannot list its models'),
      tr('更新 Codex（在 PowerShell 运行 npm i -g @openai/codex@latest）；或者选“自定义”，填 Codex 里输入 /model 时看到的名字', 'Update Codex (run npm i -g @openai/codex@latest in PowerShell), or choose "Custom" and enter a name shown by /model in Codex')
    );
  }
  throw new UserError(
    res.code !== 0 ? tr(`Codex 没能列出模型（退出码 ${res.code}）：${snippet(tail(said, 400), 400)}`, `Codex could not list its models (exit code ${res.code}): ${snippet(tail(said, 400), 400)}`) : tr(`Codex 给的模型列表看不懂：${snippet(said)}`, `Could not read the model list from Codex: ${snippet(said)}`),
    /log ?in|auth|401|unauthori/i.test(said) ? tr('先在 PowerShell 运行一次 codex，选择用 ChatGPT 账号登录', 'Run codex once in PowerShell and sign in with your ChatGPT account') : CUSTOM_HINT()
  );
}

// ---------- Antigravity ----------

const ID_KEYS = ['slug', 'id', 'model', 'modelId', 'model_id', 'name'];
const NAME_KEYS = ['label', 'displayName', 'display_name', 'title', 'name'];
const LIST_KEYS = ['models', 'data', 'items', 'results', 'result'];
const DEFAULT_KEYS = ['default', 'isDefault', 'is_default', 'current', 'selected', 'active'];

function modelFromJson(m) {
  if (typeof m === 'string') return m.trim() ? [{ id: m }] : [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
  const id = ID_KEYS.map((k) => str(m[k])).find(Boolean);
  if (!id) return [];
  const name = NAME_KEYS.map((k) => str(m[k])).find((v) => v && v !== id);
  const isDefault = DEFAULT_KEYS.some((k) => m[k] === true);
  return [{ id, name, note: [isDefault ? tr('默认', 'default') : '', str(m.description)].filter(Boolean).join(tr('；', '; ')) }];
}

function modelsFromJson(v) {
  if (Array.isArray(v)) return v.flatMap(modelFromJson);
  if (!v || typeof v !== 'object') return [];
  for (const k of LIST_KEYS) if (v[k] && typeof v[k] === 'object') return modelsFromJson(v[k]);
  const one = modelFromJson(v);
  if (one.length) return one;
  // { "名字": {…}, … } 这样的写法：名字就是模型
  const entries = Object.entries(v);
  if (entries.length && entries.every(([id, x]) => looksLikeId(id) && x && typeof x === 'object' && !Array.isArray(x))) {
    return entries.map(([id, x]) => ({ id, name: NAME_KEYS.map((k) => str(x[k])).find((n) => n && n !== id), note: str(x.description) }));
  }
  return [];
}

const SLUG_RE = /^[a-z0-9](?:[\w.:/@-]{0,98}[a-z0-9])?$/i;
// 文字里哪一栏像模型的名字：没有空格，开头结尾是字母或数字，里面有字母，还有数字或者连接符
// （gemini-3-pro、gpt-oss:20b 都是这样；“Done”“12”“NAME” 这些不是）
const looksLikeId = (c) => SLUG_RE.test(c) && /[a-z]/i.test(c) && /[\d:/_.-]/.test(c);
const FLAG_RE = /[([](?:default|current|selected|active)[)\]]/gi;

// 文字的列表：一行一个模型。前面可能有项目符号，几栏之间用制表符或者两个以上的空格分开；
// 标题行（“Available models:”“NAME  SLUG”）和分隔线不算
function modelFromLine(raw) {
  const plain = raw.replace(FLAG_RE, ' ');
  const isDefault = plain !== raw || /^\s*\*\s/.test(raw);
  const line = plain
    .replace(/^[\s>*•●○◦▪·+✓✔→|-]+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
  if (!line || line.endsWith(':') || /^[-=_|+\s]+$/.test(line)) return null;
  const cols = line
    .split(/\t+|\s{2,}|\s+[|│]\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
  const at = cols.findIndex(looksLikeId);
  if (at < 0) return null;
  const rest = cols.filter((_, i) => i !== at);
  return { id: cols[at], name: rest[0] || '', note: [isDefault ? tr('默认', 'default') : '', ...rest.slice(1)].filter(Boolean).join(tr('；', '; ')) };
}

// 认得出的几种样子：一个 JSON（数组，或者 {models: […]}；每项是字符串或者对象）、一行一个 JSON、文字
function parseModelList(output) {
  const text = stripAnsi(output).trim();
  if (!text) return [];
  const whole = safeJson(text);
  if (whole && typeof whole === 'object') return modelsFromJson(whole);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const objs = lines.map((l) => (/^\s*[{[]/.test(l) ? safeJson(l) : null)).filter((v) => v && typeof v === 'object');
  if (objs.length) return objs.flatMap(modelsFromJson);
  return lines.map(modelFromLine).filter(Boolean);
}

async function listAgy(cfg, ctx) {
  const res = await runAdaptive({
    cacheKey: 'agy',
    command: cfg.command || 'agy',
    candidates: CANDIDATES.agy,
    before: ['models'],
    groups: [{ key: 'modelsjson', args: ['--output-format', 'json'] }],
    cwd: ctx.workdir,
    env: ctx.env,
    timeoutMs: LIST_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const items = res.code === 0 ? parseModelList(res.stdout) : [];
  if (items.length) return items;
  const said = stripAnsi(`${res.stderr}\n${res.stdout}`);
  throw new UserError(
    res.code !== 0
      ? tr(`Antigravity CLI 没能列出模型（退出码 ${res.code}）：${snippet(tail(said, 400), 400)}`, `Antigravity CLI could not list its models (exit code ${res.code}): ${snippet(tail(said, 400), 400)}`)
      : tr(`Antigravity CLI 给的模型列表看不懂：${snippet(said)}`, `Could not read the model list from Antigravity CLI: ${snippet(said)}`),
    /log ?in|auth|credential|sign in/i.test(said)
      ? tr('先在命令行运行一次 agy，用 Google 账号登录', 'Run agy once in a terminal and sign in with your Google account')
      : tr('在命令行里运行 agy models 可以看到列表；然后选“自定义”，把模型的名字填进来', 'Run agy models in a terminal to see the list, then choose "Custom" and type the model name')
  );
}

// ---------- HTTP 接口 ----------

function unreadable(label, res) {
  return new UserError(tr(`${label} 返回的模型列表格式看不懂：${snippet(res.text, 200)}`, `Could not read the model list from ${label}: ${snippet(res.text, 200)}`), CUSTOM_HINT());
}

async function listGemini(cfg, ctx) {
  if (!cfg.apiKey) throw new UserError(tr('先填写并保存 Gemini API Key', 'Enter and save a Gemini API key first'));
  const base = String(cfg.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const all = [];
  let pageToken = '';
  // 一页最多 1000 个；万一还有下一页，最多再翻两页
  for (let page = 0; page < 3; page++) {
    const res = await request(`${base}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-goog-api-key': cfg.apiKey },
      proxy: ctx.proxy,
      timeoutMs: LIST_TIMEOUT_MS,
      signal: ctx.signal,
    });
    const json = safeJson(res.text);
    if (res.status !== 200) throw httpError('Gemini API', res, json);
    if (!json || !Array.isArray(json.models)) throw unreadable('Gemini API', res);
    all.push(...json.models);
    pageToken = str(json.nextPageToken);
    if (!pageToken) break;
  }
  // 列表里还有只能做向量（embedContent）之类的模型，聊天用不了
  return all
    .filter((m) => m && str(m.name) && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent')))
    .map((m) => ({ id: str(m.name).replace(/^models\//, ''), name: m.displayName, note: m.description }));
}

async function listOpenAICompatible(cfg, ctx) {
  if (!cfg.baseUrl) throw new UserError(tr('先填写并保存接口地址', 'Enter and save the API base URL first'));
  const res = await request(`${String(cfg.baseUrl).replace(/\/+$/, '')}/models`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    proxy: ctx.proxy,
    timeoutMs: LIST_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const json = safeJson(res.text);
  const label = tr('自定义接口', 'Custom API');
  if (res.status !== 200) throw httpError(label, res, json);
  const list = Array.isArray(json) ? json : json && (json.data || json.models);
  if (!Array.isArray(list)) throw unreadable(label, res);
  return list.flatMap(modelFromJson);
}

async function listGithubModels(cfg, ctx) {
  if (!cfg.token) throw new UserError(tr('先填写并保存 GitHub Token', 'Enter and save a GitHub token first'));
  const base = String(cfg.baseUrl || 'https://models.github.ai/inference').replace(/\/+$/, '');
  const res = await request(`${base.replace(/\/inference$/, '')}/catalog/models`, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    proxy: ctx.proxy,
    timeoutMs: LIST_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const json = safeJson(res.text);
  if (res.status !== 200) throw httpError('GitHub Models', res, json);
  const list = Array.isArray(json) ? json : json && (json.data || json.models || json.items);
  if (!Array.isArray(list)) {
    throw new UserError(
      tr(`GitHub Models 返回的模型列表格式看不懂：${snippet(res.text, 200)}`, `Could not read the model list from GitHub Models: ${snippet(res.text, 200)}`),
      tr('可以不加载列表：在「模型」里选 openai/gpt-4.1，再点「保存并测试」', 'You can skip the list: choose openai/gpt-4.1 as the model and click "Save and test"')
    );
  }
  const isOpenAI = (m) => (String(m.id).startsWith('openai/') ? 0 : 1);
  return list
    .filter((m) => m && str(m.id))
    .sort((a, b) => isOpenAI(a) - isOpenAI(b) || String(a.id).localeCompare(String(b.id)))
    .map((m) => ({ id: m.id, name: m.name, note: str(m.rate_limit_tier) ? tr(`限速档位：${m.rate_limit_tier}`, `rate limit tier: ${m.rate_limit_tier}`) : '' }));
}

// ---------- 对外接口 ----------

const LISTERS = {
  'codex-cli': listCodex,
  'agy-cli': listAgy,
  'gemini-api': listGemini,
  'openai-compatible': listOpenAICompatible,
  'github-models': listGithubModels,
};
const canList = (providerId) => Object.prototype.hasOwnProperty.call(LISTERS, providerId);

// 列出这种接入方式现在能用的模型：[{ id, name, note }]。
// 和发言一样记进诊断记录（kind 是 models）：命令的原样输出、接口的原样返回，真机上读错了就照着改
async function listModels(providerId, cfg, ctx = {}) {
  if (!canList(providerId)) throw new UserError(tr('这种接入方式没有办法列出模型', 'This connection type cannot list its models'), CUSTOM_HINT());
  const { diag, diagInfo, ...rest } = ctx;
  const run = async () => {
    const items = clean(await LISTERS[providerId](cfg || {}, { ...rest, env: cliEnv(rest.proxy) }));
    if (!items.length) throw new UserError(tr('没有读到任何模型', 'No models were found'), CUSTOM_HINT());
    // text 是给诊断记录看的：读出来的名字，对照下面的原样输出
    return { text: items.map((m) => m.id).join('\n'), items };
  };
  const res = diag ? await diag.track({ provider: providerId, ...diagInfo }, run) : await run();
  return res.items;
}

// ---------- 记下来的列表，和每个名字实际用的模型 ----------

// 存在数据目录的 models.json 里：{ "成员|接入方式": { key, at, items, seen } }。
//   items：上一次加载的列表；seen：{ 设置里填的名字（'' = 默认）: 实际用的模型 }，从每次回复里记。
// 都跟着设置走（key）：换了命令、接口地址或者 Key，多半是换了账号，原来记的就不算了
class ModelStore {
  constructor(file) {
    this.file = file;
    this.data = Object.create(null);
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries((saved && saved.providers) || {})) {
        if (!v || typeof v !== 'object' || typeof v.key !== 'string') continue;
        const seen = {};
        for (const [name, model] of Object.entries(v.seen && typeof v.seen === 'object' ? v.seen : {}).slice(0, MAX_SEEN)) if (str(model)) seen[name] = cut(str(model), 200);
        this.data[k] = { key: v.key, at: Number.isFinite(v.at) ? v.at : 0, items: clean(v.items), seen };
      }
    } catch {
      /* 第一次运行，或者文件坏了：从空的开始 */
    }
  }

  static key(cfg) {
    const c = cfg || {};
    return crypto.createHash('sha256').update(JSON.stringify([c.command || '', c.baseUrl || '', c.apiKey || '', c.token || ''])).digest('hex').slice(0, 16);
  }

  entry(member, providerId, cfg) {
    const id = `${member}|${providerId}`;
    const key = ModelStore.key(cfg);
    if (!this.data[id] || this.data[id].key !== key) this.data[id] = { key, at: 0, items: [], seen: {} };
    return this.data[id];
  }

  setList(member, providerId, cfg, items) {
    const e = this.entry(member, providerId, cfg);
    e.items = clean(items);
    e.at = Date.now();
    this.save();
    return { at: e.at, items: e.items, seen: e.seen };
  }

  // 一次回复之后：设置里填的是 wanted（空 = 默认），实际用的是 actual
  noteSeen(member, providerId, cfg, wanted, actual) {
    try {
      const name = str(wanted);
      const model = cut(str(actual), 200);
      if (!model || model === name || name.length > 200) return;
      const e = this.entry(member, providerId, cfg);
      if (e.seen[name] === model) return;
      if (!(name in e.seen) && Object.keys(e.seen).length >= MAX_SEEN) delete e.seen[Object.keys(e.seen)[0]];
      e.seen[name] = model;
      this.save();
    } catch {
      /* 记不下来不影响发言 */
    }
  }

  // 给界面的：只给和现在的设置对得上的
  view(members) {
    const out = {};
    for (const [id, e] of Object.entries(this.data)) {
      const [member, providerId] = id.split('|');
      const cfg = members && members[member] && members[member][providerId];
      if (!cfg || ModelStore.key(cfg) !== e.key) continue;
      out[id] = { at: e.at, items: e.items, seen: e.seen };
    }
    return out;
  }

  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, providers: this.data }));
      fs.renameSync(tmp, this.file);
    } catch {
      /* 写不了不影响聊天：下次再加载一次列表就是了 */
    }
  }
}

module.exports = { listModels, canList, ModelStore, parseModelList, codexModels, findJson };
