'use strict';

// 诊断记录：最近几十次发言里，每个命令行工具实际是怎么启动的、原样输出了什么；走接口的，对方原样返回了什么。
// 各家工具的输出格式都是照着文档写的，还没有在真机上验证过；出了问题时，
// 用户在设置里点「保存诊断信息」，把这份记录发过来，就能照着真实的输出修。
//
// 怎么记：callProvider 用 track() 开一个“发言”，这期间 spawn.js 每启动一次程序就 addRun() 一条，
// http.js 每发一次请求就记一条（httpRecorder）；用 AsyncLocalStorage 把它们连起来，不用给每种接入方式都传一个参数，
// 几位成员同时回答时也不会记串。
// 存在数据目录的 diagnostics.json 里（重启之后还在），只留最近 MAX_CALLS 次。
//
// 这里的代码只是旁观：记录时出任何错都不能影响发言本身（所以到处是 try / catch）。

const fs = require('fs');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');
const { stripAnsi } = require('./util');
const { tr } = require('./i18n');

const MAX_CALLS = 30;
const MAX_RUNS = 12; // 一次发言最多记这么多次启动 / 请求
const HEAD = 2000; // 每段输出留开头这么多字……
const TAIL = 4000; // ……和结尾这么多字
const LONG_ARG = 200; // 比这还长的参数是提示词，只记长度
const KEEP_HEADERS = /^(?:content-type|retry-after|x-ratelimit-.*|x-request-id|request-id)$/i;

const scope = new AsyncLocalStorage();

// 太长的输出只留头尾：工具自己的报错和用量一般在最后，开头是版本和启动信息。
// 先截再去颜色码：输出可能有几 MB，只处理留下来的那两段
function clip(s, head = HEAD, tailN = TAIL) {
  const raw = String(s == null ? '' : s);
  if (raw.length <= head + tailN + 100) return stripAnsi(raw);
  let a = stripAnsi(raw.slice(0, head * 2)).slice(0, head);
  let b = stripAnsi(raw.slice(-tailN * 2)).slice(-tailN);
  // 一个表情符号占两个位置，不留半个
  const last = a.charCodeAt(a.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) a = a.slice(0, -1);
  const first = b.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) b = b.slice(1);
  return `${a}\n…[${raw.length - a.length - b.length} chars omitted]…\n${b}`;
}

function shortArgs(args) {
  return (args || []).map((a) => {
    const s = String(a);
    return s.length > LONG_ARG ? `<${s.length} chars of prompt text>` : s;
  });
}

// spawn.js 每启动一次程序调用一次（同一次发言里，参数不被认时会去掉一组再启动一次，每次各记一条）。
// 超时或被停止的也记：那时候已经输出的内容在 run.stdout / run.stderr 里
function addRun(run) {
  try {
    const call = scope.getStore();
    if (!call || call.runs.length >= MAX_RUNS) return;
    const plan = run.plan || {};
    call.runs.push({
      command: String(run.command || ''),
      resolved: plan.resolved || '',
      started: plan.file ? [plan.file, ...(plan.prefixArgs || [])].join(' ') : '',
      viaShell: Boolean(plan.viaShell),
      args: shortArgs(run.args),
      inputChars: run.input == null ? 0 : String(run.input).length,
      code: run.code === undefined ? null : run.code,
      ms: run.ms || 0,
      stdout: clip(run.stdout),
      stderr: clip(run.stderr),
      error: run.error ? clip(run.error, 500, 500) : '',
    });
  } catch {
    /* 记不下来不影响发言 */
  }
}

// http.js 每发一次请求先要一个 httpRecorder()，请求结束（或失败）时用它记一条。
// 发请求的那一刻就认准是哪一次发言：回应是在网络事件里收到的，那时候再问“现在是哪次发言”不一定可靠（连接会被复用）。
// 网址只记到路径（? 后面可能带着 Key），请求头和请求内容不记
function httpRecorder() {
  const call = scope.getStore();
  return (req) => {
    try {
      if (!call || call.http.length >= MAX_RUNS) return;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers || {})) if (KEEP_HEADERS.test(k)) headers[k] = String(v);
      call.http.push({
        method: String(req.method || 'GET'),
        url: String(req.url || ''),
        requestChars: req.requestChars || 0,
        status: req.status === undefined ? null : req.status,
        ms: req.ms || 0,
        headers,
        body: clip(req.text),
        error: req.error ? clip(req.error, 500, 500) : '',
      });
    } catch {
      /* 记不下来不影响发言 */
    }
  };
}

function isoTime(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// 抄一份只有普通数据的副本：记录里混进一个存不了的东西（比如绕回自己的对象），以后每次保存都会失败
function plain(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

const validCall = (c) => Boolean(c) && typeof c === 'object' && Array.isArray(c.runs);

class DiagLog {
  constructor(file) {
    this.file = file;
    this.calls = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.calls)) this.calls = saved.calls.filter(validCall).slice(-MAX_CALLS);
    } catch {
      /* 第一次运行，或者文件坏了：从空的开始 */
    }
  }

  // 记一次发言：fn 里启动的程序、发出的请求都记在这次发言下面；结束后写下结果。
  // fn 的结果和报错原样交回去
  async track(info, fn) {
    const call = { at: new Date().toISOString(), ...info, ms: 0, outcome: '', runs: [], http: [] };
    const started = Date.now();
    let res;
    let err;
    let failed = false;
    try {
      res = await scope.run(call, fn);
    } catch (e) {
      failed = true;
      err = e;
    }
    try {
      call.ms = Date.now() - started;
      if (failed) this.describeError(call, err);
      else this.describeResult(call, res);
      this.calls.push(call);
      if (this.calls.length > MAX_CALLS) this.calls.splice(0, this.calls.length - MAX_CALLS);
      this.save();
    } catch {
      /* 记不下来不影响发言 */
    }
    if (failed) throw err;
    return res;
  }

  describeResult(call, res) {
    call.outcome = 'ok';
    const text = String((res && res.text) || '');
    call.replyChars = text.length;
    call.reply = clip(text, 300, 300); // 取出来的回复的头尾：对照下面的原样输出，看有没有取错
    if (res && res.usage) call.usage = plain(res.usage);
    if (res && res.meta) call.meta = plain(res.meta);
  }

  describeError(call, e) {
    call.outcome = e && e.aborted ? 'stopped' : e && e.limit ? 'limit' : 'error';
    call.error = clip(String((e && e.message) || e), 1000, 1000);
    if (e && e.hint) call.hint = String(e.hint);
    if (e && e.limit) call.limit = { resetAt: isoTime(e.limit.resetAt), ...(e.limit.retryInMs ? { retryInMs: e.limit.retryInMs } : {}) };
  }

  // 先写到旁边再改名：写到一半程序被关掉，原来的文件还在
  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, calls: this.calls }));
      fs.renameSync(tmp, this.file);
    } catch {
      /* 写不了诊断记录不影响聊天 */
    }
  }
}

// 设置里不能外传的部分：标了 secret 的字段，网址里的账号密码和 ? 后面的值（有的接口把 Key 放在那里）。
// 代理地址可以不写 http://，所以开头的 “账号:密码@” 也认
function redactUrl(u) {
  return String(u || '')
    .replace(/^(\s*(?:[a-z][a-z0-9+.-]*:\/\/)?)[^/@\s]+@/i, '$1***@')
    .replace(/([?&][^=&#\s]*=)[^&#\s]*/g, '$1***');
}

function redactMember(member, providers) {
  const out = {};
  for (const [pid, value] of Object.entries(member || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      out[pid] = value;
      continue;
    }
    const secret = new Set(((providers[pid] && providers[pid].fields) || []).filter((f) => f.secret).map((f) => f.key));
    out[pid] = {};
    for (const [k, v] of Object.entries(value)) {
      if (secret.has(k) || /key|token|secret|password/i.test(k)) out[pid][k] = v ? '(set)' : '';
      else if (/url/i.test(k)) out[pid][k] = redactUrl(v);
      else out[pid][k] = v;
    }
  }
  return out;
}

// 用比内容里最长的一串 ` 还长的围栏包起来，内容里的 ``` 就不会把围栏提前结束
function fence(text) {
  const t = String(text == null ? '' : text);
  const longest = Math.max(2, ...(t.match(/`+/g) || []).map((x) => x.length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${t}\n${f}`;
}

// 这台机器的时区，例如 “America/New_York (UTC-05:00)”
function timeZone() {
  let name = '';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    /* 没有时区数据 */
  }
  const min = -new Date().getTimezoneOffset();
  const pad = (n) => String(n).padStart(2, '0');
  const offset = `UTC${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
  return name ? `${name} (${offset})` : offset;
}

// 标记里的时间是毫秒数，写成看得懂的时间（JSON.stringify 的第二个参数）
function readableTimes(key, value) {
  return /^(?:since|\w+At)$/.test(key) && typeof value === 'number' ? isoTime(value) || value : value;
}

const secs = (ms) => `${((Number(ms) || 0) / 1000).toFixed(1)}s`;
const oneLine = (s) => String(s || '').replace(/\s*\r?\n\s*/g, ' / ');

function describeCall(c, i) {
  const lines = [];
  lines.push(`### ${i + 1}. ${c.at} ${c.member || ''} via ${c.provider} (${c.kind}): ${c.outcome}, ${secs(c.ms)}`, '');
  if (c.hint) lines.push(`- Tip shown: ${oneLine(c.hint)}`);
  if (c.limit) lines.push(`- Read as out of usage, resets ${c.limit.resetAt || 'unknown'}${c.limit.retryInMs ? `, retry in ${Math.round(c.limit.retryInMs / 1000)}s` : ''}`);
  if (c.usage) lines.push(`- Usage read: \`${JSON.stringify(c.usage)}\``);
  if (c.meta) lines.push(`- Meta: \`${JSON.stringify(c.meta)}\``);
  const http = Array.isArray(c.http) ? c.http : [];
  if (!c.runs.length && !http.length) lines.push('- No program was started and no request was sent (for example, the command was not found)');
  if (c.error) lines.push('', 'Error shown:', '', fence(c.error));
  if (c.outcome === 'ok') lines.push('', `Reply as read by the app (${c.replyChars} chars):`, '', fence(c.reply || ''));
  lines.push('');
  c.runs.forEach((r, j) => {
    lines.push(`#### Run ${j + 1}: exit ${r.code === null ? '(none)' : r.code}, ${secs(r.ms)}`, '');
    if (r.error) lines.push(`- Ended early: ${oneLine(r.error)}`);
    lines.push(`- Command: \`${r.command}\` → ${r.resolved || '?'}${r.viaShell ? ' (through cmd.exe)' : ''}`);
    if (r.started && r.started !== r.resolved) lines.push(`- Started as: ${r.started}`);
    lines.push(`- Standard input: ${r.inputChars} chars`);
    lines.push('', 'Arguments:', '', fence(JSON.stringify(r.args)), '');
    lines.push('stdout:', '', fence(r.stdout || '(empty)'), '');
    lines.push('stderr:', '', fence(r.stderr || '(empty)'), '');
  });
  http.forEach((r, j) => {
    lines.push(`#### Request ${j + 1}: ${r.method} ${r.url} → ${r.status === null ? '(no response)' : r.status}, ${secs(r.ms)}`, '');
    if (r.error) lines.push(`- Failed: ${oneLine(r.error)}`);
    lines.push(`- Request body: ${r.requestChars} chars`);
    if (r.headers && Object.keys(r.headers).length) lines.push(`- Response headers: \`${JSON.stringify(r.headers)}\``);
    lines.push('', 'Response body:', '', fence(r.body || '(empty)'), '');
  });
  return lines;
}

// 整理成一份 Markdown：环境、各成员的设置（去掉密钥）、各工具的版本、最近的发言（新的在前）
function report({ version, config, providers, tools = [], calls = [], marks = {} }) {
  const lines = [];
  lines.push('# AI Roundtable diagnostics', '');
  lines.push(`- App: ${version}`);
  lines.push(`- Created: ${new Date().toISOString()}`);
  lines.push(`- Time zone: ${timeZone()}`); // 工具报的恢复时间多半是本地的钟点（resets 3pm），对照时要知道这台机器在哪个时区
  lines.push(`- OS: ${os.platform()} ${os.release()} ${os.arch()}`);
  lines.push(`- Node: ${process.versions.node}${process.versions.electron ? `, Electron ${process.versions.electron}` : ''}`);
  lines.push(`- Language: ${config.lang || '(system)'}; timeout ${config.timeoutSec}s; proxy: ${config.proxy ? redactUrl(config.proxy) : 'none'}`);
  lines.push('');
  lines.push(tr('这份文件里有最近聊天的部分内容（回复和工具打印的文字），发给别人之前先看一遍。', 'This file contains parts of your recent chats (the replies and what the tools printed). Read it before sharing.'), '');

  lines.push('## Members', '');
  for (const [id, m] of Object.entries(config.members || {})) {
    lines.push(`### ${id}: ${m.provider}${m.enabled === false ? ' (turned off)' : ''}`, '');
    const settings = redactMember({ [m.provider]: m[m.provider] || {} }, providers)[m.provider];
    lines.push(fence(JSON.stringify(settings, null, 2)), '');
    if (marks[id] && marks[id].length) lines.push('Out-of-usage marks:', '', fence(JSON.stringify(marks[id], readableTimes, 2)), '');
  }

  lines.push('## Command-line tools', '');
  if (!tools.length) lines.push('(no member uses a command-line tool)', '');
  for (const t of tools) {
    lines.push(`### ${t.command}`, '');
    lines.push(`- Found: ${t.found ? t.path : 'no'}${t.viaShell ? ' (started through cmd.exe)' : ''}`);
    if (t.found) {
      lines.push(`- \`--version\`: ${t.error ? oneLine(t.error) : `exit ${t.code}`}`, '');
      lines.push(fence(`${t.stdout || ''}${t.stderr ? `\n[stderr]\n${t.stderr}` : ''}`.trim() || '(no output)'));
    }
    lines.push('');
  }

  lines.push(`## Recent calls (${calls.length}, newest first)`, '');
  if (!calls.length) lines.push(tr('（还没有记录：先发一条消息，或者在设置里点「保存并测试」，再保存一次诊断信息）', '(none yet: send a message or use "Save and test" in Settings, then save diagnostics again)'), '');
  [...calls].reverse().forEach((c, i) => {
    try {
      lines.push(...describeCall(c, i));
    } catch {
      lines.push(`### ${i + 1}. (this record could not be read)`, '');
    }
  });
  return lines.join('\n');
}

module.exports = { DiagLog, addRun, httpRecorder, report, redactMember, redactUrl, clip, MAX_CALLS };
