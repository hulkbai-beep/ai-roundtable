'use strict';

// 诊断记录：最近几十次发言里，每个命令行工具实际是怎么启动的、原样输出了什么。
// 各家工具的输出格式都是照着文档写的，还没有在真机上验证过；出了问题时，
// 用户在设置里点「保存诊断信息」，把这份记录发过来，就能照着真实的输出修。
//
// 怎么记：callProvider 用 track() 开一个“发言”，这期间 spawn.js 每启动一次程序就 addRun() 一条；
// 用 AsyncLocalStorage 把两者连起来，这样不用给每种接入方式都传一个参数。
// 存在数据目录的 diagnostics.json 里（重启之后还在），只留最近 MAX_CALLS 次。

const fs = require('fs');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');
const { stripAnsi } = require('./util');
const { tr } = require('./i18n');

const MAX_CALLS = 30;
const HEAD = 2000; // 每段输出留开头这么多字……
const TAIL = 4000; // ……和结尾这么多字
const LONG_ARG = 200; // 比这还长的参数是提示词，只记长度

const scope = new AsyncLocalStorage();

// 太长的输出只留头尾：工具自己的报错一般在最后，开头是版本和启动信息
function clip(s, head = HEAD, tailN = TAIL) {
  const t = stripAnsi(String(s || ''));
  if (t.length <= head + tailN + 100) return t;
  return `${t.slice(0, head)}\n…[${t.length - head - tailN} chars omitted]…\n${t.slice(-tailN)}`;
}

function shortArgs(args) {
  return (args || []).map((a) => {
    const s = String(a);
    return s.length > LONG_ARG ? `<${s.length} chars of prompt text>` : s;
  });
}

// spawn.js 每启动一次程序调用一次（同一次发言里，参数不被认时会去掉一组再启动一次，每次各记一条）
function addRun(run) {
  const call = scope.getStore();
  if (!call) return;
  call.runs.push({
    command: run.command,
    resolved: run.plan ? run.plan.resolved : '',
    started: run.plan ? [run.plan.file, ...run.plan.prefixArgs].join(' ') : '',
    viaShell: Boolean(run.plan && run.plan.viaShell),
    args: shortArgs(run.args),
    inputChars: run.input == null ? 0 : String(run.input).length,
    code: run.code === undefined ? null : run.code,
    ms: run.ms || 0,
    stdout: clip(run.stdout),
    stderr: clip(run.stderr),
    error: run.error || '',
  });
}

class DiagLog {
  constructor(file) {
    this.file = file;
    this.calls = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.calls)) this.calls = saved.calls.slice(-MAX_CALLS);
    } catch {
      /* 第一次运行，或者文件坏了：从空的开始 */
    }
  }

  // 记一次发言：fn 里启动的程序都记在这次发言下面；结束后写下结果
  async track(info, fn) {
    const call = { at: new Date().toISOString(), ...info, ms: 0, outcome: '', runs: [] };
    const started = Date.now();
    try {
      const res = await scope.run(call, fn);
      call.outcome = 'ok';
      call.replyChars = String((res && res.text) || '').length;
      if (res && res.usage) call.usage = res.usage;
      if (res && res.meta) call.meta = res.meta;
      return res;
    } catch (e) {
      call.outcome = e && e.aborted ? 'stopped' : e && e.limit ? 'limit' : 'error';
      call.error = String((e && e.message) || e);
      if (e && e.hint) call.hint = e.hint;
      if (e && e.limit) call.limit = { resetAt: e.limit.resetAt ? new Date(e.limit.resetAt).toISOString() : null };
      throw e;
    } finally {
      call.ms = Date.now() - started;
      this.calls.push(call);
      if (this.calls.length > MAX_CALLS) this.calls.splice(0, this.calls.length - MAX_CALLS);
      this.save();
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, calls: this.calls }));
    } catch {
      /* 写不了诊断记录不影响聊天 */
    }
  }

  clear() {
    this.calls = [];
    this.save();
  }
}

// 设置里不能外传的部分：标了 secret 的字段，和网址里的账号密码
function redactUrl(u) {
  return String(u || '').replace(/(\/\/)[^/@\s]+@/, '$1***@');
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
      if (secret.has(k)) out[pid][k] = v ? '(set)' : '';
      else if (/url/i.test(k)) out[pid][k] = redactUrl(v);
      else out[pid][k] = v;
    }
  }
  return out;
}

function fence(text) {
  const t = String(text || '');
  const longest = Math.max(2, ...(t.match(/`+/g) || []).map((x) => x.length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${t}\n${f}`;
}

// 整理成一份 Markdown：环境、各成员的设置（去掉密钥）、各工具的版本、最近的发言（新的在前）
function report({ version, config, providers, tools = [], calls = [], marks = {} }) {
  const lines = [];
  lines.push('# AI Roundtable diagnostics', '');
  lines.push(`- App: ${version}`);
  lines.push(`- Created: ${new Date().toISOString()}`);
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
    if (marks[id] && marks[id].length) lines.push(`Out-of-usage marks: \`${JSON.stringify(marks[id])}\``, '');
  }

  lines.push('## Command-line tools', '');
  if (!tools.length) lines.push('(no member uses a command-line tool)', '');
  for (const t of tools) {
    lines.push(`### ${t.command}`, '');
    lines.push(`- Found: ${t.found ? t.path : 'no'}${t.viaShell ? ' (started through cmd.exe)' : ''}`);
    if (t.found) lines.push(`- \`--version\`: exit ${t.code}${t.error ? `, ${t.error}` : ''}`, '', fence(`${t.stdout || ''}${t.stderr ? `\n[stderr]\n${t.stderr}` : ''}`.trim()));
    lines.push('');
  }

  lines.push(`## Recent calls (${calls.length}, newest first)`, '');
  if (!calls.length) lines.push(tr('（还没有记录：先发一条消息，或者在设置里点「保存并测试」，再保存一次诊断信息）', '(none yet: send a message or use "Save and test" in Settings, then save diagnostics again)'), '');
  [...calls].reverse().forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.at} ${c.member || ''} via ${c.provider} (${c.kind}): ${c.outcome}, ${(c.ms / 1000).toFixed(1)}s`, '');
    if (c.error) lines.push(`- Error shown: ${c.error}`);
    if (c.hint) lines.push(`- Tip shown: ${c.hint}`);
    if (c.limit) lines.push(`- Read as out of usage, resets ${c.limit.resetAt || 'unknown'}`);
    if (c.outcome === 'ok') lines.push(`- Reply: ${c.replyChars} chars`);
    if (c.usage) lines.push(`- Usage read: \`${JSON.stringify(c.usage)}\``);
    if (c.meta) lines.push(`- Meta: \`${JSON.stringify(c.meta)}\``);
    if (!c.runs.length) lines.push('- No program was started (HTTP API, or the command was not found)');
    lines.push('');
    c.runs.forEach((r, j) => {
      lines.push(`#### Run ${j + 1}: exit ${r.code === null ? '(none)' : r.code}, ${(r.ms / 1000).toFixed(1)}s${r.error ? `, ${r.error}` : ''}`, '');
      lines.push(`- Command: \`${r.command}\` → ${r.resolved || '?'}${r.viaShell ? ' (through cmd.exe)' : ''}`);
      if (r.started && r.started !== r.resolved) lines.push(`- Started as: ${r.started}`);
      lines.push(`- Standard input: ${r.inputChars} chars`);
      lines.push('', 'Arguments:', '', fence(JSON.stringify(r.args)), '');
      lines.push('stdout:', '', fence(r.stdout || '(empty)'), '');
      lines.push('stderr:', '', fence(r.stderr || '(empty)'), '');
    });
  });
  return lines.join('\n');
}

module.exports = { DiagLog, addRun, report, redactMember, redactUrl, clip, MAX_CALLS };
