'use strict';

const { test } = require('node:test');
const assert = require('assert');
require('../lib/i18n').setLang('zh'); // 下面的断言按中文写；英文版另有测试
const { resolveCommand, parseCmdShim, quoteForCmd, findUnknownFlag } = require('../lib/spawn');
const { parseMentions, cleanReply, buildTranscript, buildSystemPrompt } = require('../lib/prompt');
const { splitArgs, maskSecret } = require('../lib/util');

// 用假的文件系统模拟一台 Windows 电脑（用户名带中文）
const HOME = 'C:\\Users\\张三';
const files = new Set([
  `${HOME}\\AppData\\Roaming\\npm\\claude.cmd`,
  `${HOME}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
  `${HOME}\\.local\\bin\\claude.exe`,
  `${HOME}\\AppData\\Local\\agy\\bin\\agy.exe`,
  `${HOME}\\AppData\\Roaming\\npm\\codex.cmd`,
  `${HOME}\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`,
]);
const win = {
  platform: 'win32',
  exists: (p) => files.has(p),
  env: { Path: `C:\\Windows\\system32;${HOME}\\AppData\\Roaming\\npm`, USERPROFILE: HOME, LOCALAPPDATA: `${HOME}\\AppData\\Local`, APPDATA: `${HOME}\\AppData\\Roaming` },
};

test('Windows：在 PATH 和常见安装位置里找到命令', () => {
  assert.strictEqual(resolveCommand('claude', win), `${HOME}\\AppData\\Roaming\\npm\\claude.cmd`);
  assert.strictEqual(resolveCommand('agy', win), null);
  assert.strictEqual(resolveCommand('agy', { ...win, candidates: ['%LOCALAPPDATA%\\agy\\bin\\agy.exe'] }), `${HOME}\\AppData\\Local\\agy\\bin\\agy.exe`);
  assert.strictEqual(resolveCommand(`"${HOME}\\.local\\bin\\claude.exe"`, win), `${HOME}\\.local\\bin\\claude.exe`);
  assert.strictEqual(resolveCommand('%USERPROFILE%\\.local\\bin\\claude', win), `${HOME}\\.local\\bin\\claude.exe`);
});

test('Windows：解析 npm 生成的 .cmd 文件（新旧两种格式）', () => {
  const npmShim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');
  assert.deepStrictEqual(parseCmdShim(`${HOME}\\AppData\\Roaming\\npm\\claude.cmd`, { ...win, readFile: () => npmShim }), {
    script: `${HOME}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
  });
  const oldShim = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)';
  assert.deepStrictEqual(parseCmdShim(`${HOME}\\AppData\\Roaming\\npm\\codex.cmd`, { ...win, readFile: () => oldShim }), {
    script: `${HOME}\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`,
  });
  assert.strictEqual(parseCmdShim('x.cmd', { ...win, readFile: () => '@echo off\r\nfoo.exe %*' }), null);
});

test('cmd.exe 参数转义：只允许安全的参数', () => {
  assert.strictEqual(quoteForCmd(''), '""');
  assert.strictEqual(quoteForCmd('--output-format'), '--output-format');
  assert.strictEqual(quoteForCmd('C:\\Program Files\\x.cmd'), '"C:\\Program Files\\x.cmd"');
  assert.throws(() => quoteForCmd('a "b"'));
  assert.throws(() => quoteForCmd('第一行\n第二行'));
  assert.throws(() => quoteForCmd('100%'));
});

test('识别“不认识的参数”报错（不同命令行框架的写法）', () => {
  assert.strictEqual(findUnknownFlag("error: unknown option '--safe-mode'"), '--safe-mode');
  assert.strictEqual(findUnknownFlag("error: unexpected argument '--ephemeral' found"), '--ephemeral');
  assert.strictEqual(findUnknownFlag('Error: unknown flag: --model'), '--model');
  assert.strictEqual(findUnknownFlag('flag provided but not defined: -model'), '-model');
  assert.strictEqual(findUnknownFlag('everything is fine'), null);
});

test('@点名解析', () => {
  assert.deepStrictEqual(parseMentions('@Gemini你怎么看？@claude 呢'), { all: false, ids: ['gemini', 'claude'] });
  assert.deepStrictEqual(parseMentions('＠GPT，说说'), { all: false, ids: ['gpt'] });
  assert.deepStrictEqual(parseMentions('@ChatGPT 和 @Codex'), { all: false, ids: ['gpt'] });
  assert.deepStrictEqual(parseMentions('@所有人 开会'), { all: true, ids: [] });
  assert.deepStrictEqual(parseMentions('邮箱 a@b.com 不算点名'), { all: false, ids: [] });
});

test('去掉 AI 自己加的名字前缀', () => {
  assert.strictEqual(cleanReply('Claude：你好', 'claude'), '你好');
  assert.strictEqual(cleanReply('**Claude**: hi', 'claude'), 'hi');
  assert.strictEqual(cleanReply('【GPT】\n内容', 'gpt'), '内容');
  assert.strictEqual(cleanReply('【Gemini（你）】：内容', 'gemini'), '内容');
  assert.strictEqual(cleanReply('Gemini 说得对', 'claude'), 'Gemini 说得对');
});

test('聊天记录：系统提示不发给 AI，标出“你”，各自回答模式隐藏别人这一轮的回答', () => {
  const msgs = [
    { speaker: 'user', text: '要不要学 Rust？' },
    { speaker: 'claude', text: 'C1' },
    { speaker: 'system', text: '系统提示不应出现' },
    { speaker: 'gemini', text: 'G1' },
    { speaker: 'gpt', text: 'P1' },
    { speaker: 'user', text: '第二个问题' },
    { speaker: 'claude', text: 'C2' },
    { speaker: 'gemini', text: 'G2' },
  ];
  const t = buildTranscript(msgs, { speaker: 'claude', mode: 'discuss', maxChars: 100000 });
  assert(t.includes('【Claude（你）】\nC1') && t.includes('【Gemini】\nG1') && !t.includes('系统提示'));
  const ind = buildTranscript(msgs, { speaker: 'gpt', mode: 'independent', maxChars: 100000 });
  assert(ind.includes('第二个问题') && !ind.includes('C2') && !ind.includes('G2') && ind.includes('P1'));
});

test('聊天记录太长时：保留第一条话题和最近的消息', () => {
  const long = Array.from({ length: 50 }, (_, i) => ({ speaker: i % 2 ? 'claude' : 'gemini', text: 'x'.repeat(300) }));
  const t = buildTranscript([{ speaker: 'user', text: '最初的话题' }, ...long], { speaker: 'gpt', mode: 'discuss', maxChars: 2000 });
  assert(t.startsWith('【用户】\n最初的话题'));
  assert(t.includes('中间省略了'));
  assert(t.length < 2700, `transcript too long: ${t.length}`);
  const huge = buildTranscript([{ speaker: 'user', text: 'y'.repeat(50000) }], { speaker: 'gpt', mode: 'discuss', maxChars: 3000 });
  assert(huge.length < 3500, `single huge message not clipped: ${huge.length}`);
});

test('人设：只列出参加的成员，合作模式最后一位负责总结，附加额外设定', () => {
  const sys = buildSystemPrompt({ speaker: 'gemini', members: ['claude', 'gemini'], mode: 'collab', length: 'short', isFinal: true, customInstruction: '你是投资人' });
  assert(sys.includes('你是 Gemini'));
  assert(sys.includes('Gemini：Google 开发的 AI（就是你）'));
  assert(!sys.includes('GPT'));
  assert(sys.includes('最后一个发言'));
  assert(sys.includes('你是投资人'));
});

test('发言顺序：随机排，尽量不让指定的成员排第一个', () => {
  const { shuffled } = require('../lib/orchestrator');
  const ids = ['claude', 'gemini', 'gpt'];
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    const order = shuffled(ids);
    assert.deepStrictEqual([...order].sort(), ids, '每位成员正好出现一次');
    seen.add(order.join(' '));
  }
  assert.strictEqual(seen.size, 6, '六种顺序都会出现');
  assert.deepStrictEqual(ids, ['claude', 'gemini', 'gpt'], '不改动传进来的数组');

  for (let i = 0; i < 100; i++) {
    assert.notStrictEqual(shuffled(ids, { avoid: ['claude'] })[0], 'claude');
    assert.strictEqual(shuffled(ids, { avoid: ['claude', 'gpt'] })[0], 'gemini');
    // 都避不开时，先保证写在前面的那位不排第一个
    assert.strictEqual(shuffled(['claude', 'gemini'], { avoid: ['claude', 'gemini'] })[0], 'gemini');
    assert.strictEqual(shuffled(ids, { avoid: ['gpt', 'claude', 'gemini'] })[0], 'gemini');
  }

  // 随机数固定时结果也固定
  assert.deepStrictEqual(shuffled(ids, { random: () => 0 }), ['claude', 'gpt', 'gemini']);
  assert.deepStrictEqual(shuffled(ids, { random: () => 0.999 }), ['gpt', 'claude', 'gemini']);
  assert.deepStrictEqual(shuffled(ids, { random: () => 1 }), ['gpt', 'claude', 'gemini'], '随机数取到 1 也不会越界');
  assert.deepStrictEqual(shuffled(['gpt'], { avoid: ['gpt'] }), ['gpt']);
  assert.deepStrictEqual(shuffled([]), []);
});

test('发言计划：各自回答时同一轮的人一起回答，其他模式一个一个来；只有自由讨论和辩论换顺序', () => {
  const { Roundtable } = require('../lib/orchestrator');
  const ids = ['claude', 'gemini', 'gpt'];
  const cfg = { shuffleOrder: true, order: ids, members: {} };
  const table = new Roundtable({ config: { get: () => cfg }, conversations: { current: { id: 'c', messages: [] } } });
  const speakers = (steps) => steps.map((step) => step.map((t) => t.speaker));

  const together = table.plan(ids, 2, 'independent', 'short');
  assert.deepStrictEqual(speakers(together), [ids, ids]);
  for (const mode of ['discuss', 'debate', 'collab']) {
    const turns = table.plan(ids, 2, mode, 'short');
    assert.deepStrictEqual(speakers(turns), [['claude'], ['gemini'], ['gpt'], ['claude'], ['gemini'], ['gpt']]);
    assert.deepStrictEqual(turns.flat().map((t) => t.isFinal), [false, false, false, false, false, true], '只有最后一次发言是 isFinal');
  }
  assert.deepStrictEqual(table.plan([], 3, 'discuss', 'short'), []);

  table.queue = table.plan(ids, 2, 'independent', 'short');
  assert.strictEqual(table.queued(), 6);
  assert.strictEqual(table.dropTurns('gemini'), 2);
  assert.deepStrictEqual(speakers(table.queue), [['claude', 'gpt'], ['claude', 'gpt']]);
  table.queue = table.plan(ids, 1, 'discuss', 'short');
  assert.strictEqual(table.dropTurns('gpt'), 1);
  assert.deepStrictEqual(speakers(table.queue), [['claude'], ['gemini']], '空了的步骤要去掉');
  assert.deepStrictEqual(table.queue.flat().map((t) => t.isFinal), [false, true], '负责总结的那位被去掉了，改由剩下的最后一位总结');
  table.queue = table.plan(ids, 2, 'collab', 'short');
  table.dropTurns('claude');
  assert.deepStrictEqual(table.queue.flat().map((t) => t.isFinal), [false, false, false, true], '去掉的不是最后一位时不变');
  table.queue = [];

  table.random = () => 0;
  assert.strictEqual(table.lineup(ids, 'collab'), ids, '合作模式按排好的顺序');
  assert.strictEqual(table.lineup(ids, 'independent'), ids, '各自回答没有先后');
  assert.deepStrictEqual(table.lineup(ids, 'discuss'), ['claude', 'gpt', 'gemini']);
  assert.deepStrictEqual(table.lineup(ids, 'debate'), ['gemini', 'gpt', 'claude'], '上一条消息是 Claude 先说的，这次换一位');
  // 继续聊：刚说完话的 GPT 不排第一个，上次先说的 Gemini 也不排第一个
  assert.deepStrictEqual(table.lineup(ids, 'discuss', ['gpt']), ['claude', 'gpt', 'gemini']);
  // 只有两位时：两个条件顾不过来，先保证刚说完话的那位不排第一个
  assert.deepStrictEqual(table.lineup(['claude', 'gemini'], 'discuss', ['gemini']), ['claude', 'gemini']);
  assert.deepStrictEqual(table.lineup(['gpt'], 'discuss'), ['gpt']);

  cfg.shuffleOrder = false;
  assert.strictEqual(table.lineup(ids, 'discuss'), ids, '设置里关掉后按排好的顺序');
});

test('插话：发新消息时还在说话的那位，新的一轮不会紧接着又第一个说', () => {
  const { Roundtable } = require('../lib/orchestrator');
  const ids = ['claude', 'gemini', 'gpt'];
  const cfg = { shuffleOrder: true, order: ids, members: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) };
  const table = new Roundtable({ config: { get: () => cfg }, conversations: { current: { id: 'c', messages: [] }, saveSoon() {} } });
  table.kick = () => {}; // 只看排出来的计划，不真的去调用
  for (let i = 0; i < 60; i++) {
    const talking = ids[i % 3];
    table.active.clear();
    table.active.set(talking, {});
    const prevFirst = table.lastFirst;
    table.send({ text: `话题 ${i}`, mode: i % 2 ? 'debate' : 'discuss', rounds: 2 });
    const order = table.queue.map((step) => step[0].speaker);
    assert.deepStrictEqual([...order.slice(0, 3)].sort(), ids);
    assert.notStrictEqual(order[0], talking, `${talking} 还在说话，却又排在第一个`);
    assert.notStrictEqual(order[0], prevFirst, '上一条消息先说的那位也不排第一个');
  }
  // 合作模式不换顺序
  table.send({ text: '一起写', mode: 'collab' });
  assert.deepStrictEqual(table.queue.map((step) => step[0].speaker), ids);
});

test('轮到谁：主持人最新一条消息之后，是第一个回答、接着别人回答，还是已经回答过', () => {
  const { turnPosition } = require('../lib/prompt');
  const msgs = [
    { speaker: 'user', text: '第一个问题' },
    { speaker: 'claude', text: 'C1' },
    { speaker: 'system', text: '提示' },
  ];
  assert.strictEqual(turnPosition([{ speaker: 'user', text: '问题' }], 'claude'), 'first');
  assert.strictEqual(turnPosition(msgs, 'gemini'), 'later');
  assert.strictEqual(turnPosition(msgs, 'claude'), 'again');
  assert.strictEqual(turnPosition([{ speaker: 'user', text: '问题' }, { speaker: 'system', text: '提示' }], 'gpt'), 'first', '系统提示不算发言');
  assert.strictEqual(turnPosition([...msgs, { speaker: 'user', text: '第二个问题' }], 'claude'), 'first', '新消息之后重新算');
  assert.strictEqual(turnPosition([], 'claude'), 'first');
});

test('人设：自由讨论和辩论按轮到时的情况写规则，后说的人先说自己的看法；其他情况不变', () => {
  const base = { speaker: 'gemini', members: ['claude', 'gemini', 'gpt'], length: 'short' };
  const OLD = '先看清楚前面每个人说了什么再接话';
  const first = buildSystemPrompt({ ...base, mode: 'discuss', position: 'first' });
  assert(first.includes('由你第一个回答') && !first.includes(OLD) && !first.includes('然后再接别人的话'));
  const later = buildSystemPrompt({ ...base, mode: 'debate', position: 'later' });
  assert(later.includes('先用一两句话说出你自己的看法') && later.includes('然后再接别人的话') && !later.includes(OLD));
  // 这条消息已经回答过（多轮、继续聊），或者没说明情况：原来的写法
  const again = buildSystemPrompt({ ...base, mode: 'discuss', position: 'again' });
  assert(again.includes(OLD));
  assert(buildSystemPrompt({ ...base, mode: 'discuss' }).includes(OLD));
  // 合作和各自回答不看这个
  for (const mode of ['collab', 'independent']) {
    for (const position of ['first', 'later', 'again']) assert(buildSystemPrompt({ ...base, mode, position }).includes(OLD), `${mode} ${position}`);
  }
  for (const p of [first, later, again]) {
    assert.deepStrictEqual(p.split('\n').filter((l) => /^\d\. /.test(l)).map((l) => l[0]), ['1', '2', '3', '4', '5', '6', '7'], '规则还是 1 到 7 条');
  }

  const i18n = require('../lib/i18n');
  i18n.setLang('en');
  try {
    const en = buildSystemPrompt({ ...base, mode: 'discuss', position: 'later' });
    assert(en.includes('Start with your own view in one or two sentences') && en.includes('Then respond to the others'));
    assert(!/[一-鿿]/.test(en), '英文人设里不应该有中文');
    const enFirst = buildSystemPrompt({ ...base, mode: 'debate', position: 'first' });
    assert(enFirst.includes("You are the first to answer the host's latest message") && !/[一-鿿]/.test(enFirst));
    assert(buildSystemPrompt({ ...base, mode: 'collab', position: 'later' }).includes('Read what everyone said before you reply'));
  } finally {
    i18n.setLang('zh');
  }
});

test('配置：“每条消息换一个发言顺序”默认打开，以前的配置升级后也是；关掉后保持关掉', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { ConfigStore } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cfg-'));

  assert.strictEqual(new ConfigStore(path.join(dir, 'new.json')).get().shuffleOrder, true);

  // 1.0.2 的配置：没有这个选项，有旧的“每次换一位成员先发言”
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(old, JSON.stringify({ version: 2, rotateFirst: true, order: ['gpt', 'claude', 'gemini'] }));
  const store = new ConfigStore(old);
  assert.strictEqual(store.get().shuffleOrder, true);
  assert.ok(!('rotateFirst' in JSON.parse(fs.readFileSync(old, 'utf8'))), '旧选项不再保留');
  assert.deepStrictEqual(store.get().order, ['gpt', 'claude', 'gemini'], '排好的顺序还在（合作模式、关掉换顺序时用）');

  store.update({ shuffleOrder: false });
  assert.strictEqual(new ConfigStore(old).get().shuffleOrder, false);
});

test('配置升级：1.0.0 默认的 GitHub Models 自动换成 Codex；新装默认 Codex；明确选过的保持不变', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { ConfigStore } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cfg-'));

  const v1 = path.join(dir, 'v1.json');
  fs.writeFileSync(v1, JSON.stringify({ version: 1, members: { gpt: { provider: 'github-models', 'github-models': { token: 'tok-1234567890ab' } } } }));
  const a = new ConfigStore(v1).get();
  assert.strictEqual(a.members.gpt.provider, 'codex-cli');
  assert.strictEqual(a.members.gpt['github-models'].token, 'tok-1234567890ab', '原来的 token 要保留');
  assert.strictEqual(JSON.parse(fs.readFileSync(v1, 'utf8')).version, 2);
  assert.strictEqual(new ConfigStore(v1).get().members.gpt.provider, 'codex-cli');

  const v2 = path.join(dir, 'v2.json');
  fs.writeFileSync(v2, JSON.stringify({ version: 2, members: { gpt: { provider: 'github-models' } } }));
  assert.strictEqual(new ConfigStore(v2).get().members.gpt.provider, 'github-models');

  assert.strictEqual(new ConfigStore(path.join(dir, 'new.json')).get().members.gpt.provider, 'codex-cli');
});

test('小工具', () => {
  assert.deepStrictEqual(splitArgs('--effort low "a b" \'\''), ['--effort', 'low', 'a b', '']);
  assert.strictEqual(maskSecret('github_pat_1234567890abcdef'), 'gith****cdef');
  assert.strictEqual(maskSecret('short'), '****');
});

// ---------- 额度用完 ----------
// 下面的句子逐字取自公开的文档和源码（来源写在每一组前面），新版本改了说法时在这里加一条。

const LIMIT_MESSAGES = [
  // Claude Code 官方的 Error reference（code.claude.com/docs/en/errors）
  "You've hit your session limit · resets 3:45pm",
  "You've hit your weekly limit · resets Mon 12:00am",
  "You've hit your Opus limit · resets 3:45pm",
  "You've hit your Sonnet limit · resets 3:45pm",
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message",
  "You've hit your individual spend limit · ask your admin for a higher limit",
  "You've hit your org's monthly spend limit · visit https://claude.ai/admin-settings/usage to raise it",
  "You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage",
  "You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings",
  "You've hit your individual usage limit",
  'spend limit reached · resets Dec 1',
  "This request exceeds your group's budget. Ask your organization's admins to raise it, or try again after it resets on November 1 at 00:00 UTC.",
  'Credit balance is too low',
  'Fable limit reached · continuing on Fable 5.1 uses usage credits, and the prompt to confirm went unanswered — nothing was sent · answer it where this session is running, or /model to change',
  // Claude Code：用户贴出来的输出（新旧版本）
  "You've hit your 5-hour limit · resets 5:20am (UTC)",
  "You've hit your session limit · resets 8:10pm (Asia/Tokyo)",
  "You're out of extra usage · resets 9am (America/Cordoba)",
  "You're out of usage credits · resets 2:50pm (America/New_York)",
  'Weekly limit reached · resets 10am (Asia/Seoul) · /upgrade to Max or turn on /extra-usage',
  '5-hour limit reached ∙ resets 9pm',
  'Claude AI usage limit reached|1749924000',
  'Claude usage limit reached. Your limit will reset at 1pm (Etc/GMT+5).',
  'API Error: Rate limit reached',
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
  'Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
  '{"type":"result","subtype":"success","terminal_reason":"api_error","is_error":true,"api_error_status":429,"api_error":"usage_limit_reached"}',
  // Codex：codex-rs/protocol/src/error.rs（注意是弯引号 ’）
  'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:05 PM.',
  'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Jan 2nd, 2026 3:05 PM.',
  'You’ve hit your usage limit. To get more access now, send a request to your admin or try again later.',
  'You’ve hit your usage limit. Try again later.',
  'You’ve hit your usage limit for GPT-5.5. Switch to another model now, or try again at 3:05 PM.',
  'Your workspace is out of credits. Add credits to continue.',
  'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
  'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
  'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
  'Quota exceeded. Check your plan and billing details.',
  'rate limit exceeded: Rate limit reached for organization org-abc',
  'exceeded retry limit, last status: 429 Too Many Requests, request id: req_0123',
  'unexpected status 429 Too Many Requests: {"detail":"slow down"}, url: https://chatgpt.com/backend-api/codex/responses',
  // Antigravity CLI：用户贴出来的输出
  '⚠ Individual quota reached. Please upgrade your subscription to increase your limits.\nResets in 143h57m55s.',
  'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages.',
  'error: Your AI credits balance is too low to continue.',
  'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
  // Gemini CLI（googleQuotaErrors.ts）和 Gemini API 的 429
  'You have exhausted your capacity on this model. Your quota will reset after 19h14m47s.',
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50\nPlease retry in 34.074824224s.',
  // GitHub Models、OpenAI
  'Rate limit of 50 per 86400s exceeded for UserByModelByDay. Please wait 12345 seconds before retrying.',
  'Rate limit reached for gpt-4o in organization org-abc on requests per day (RPD): Limit 200, Used 200, Requested 1. Please try again in 7m12s.',
  'Error: insufficient_quota',
];

const NOT_LIMIT_MESSAGES = [
  // Claude Code 官方的 Error reference：这些看着像，但不是额度用完
  'API Error: Server is temporarily limiting requests (not your usage limit)',
  'API Error: Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.',
  'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check https://status.claude.com.',
  'Context limit reached · /compact or /clear to continue',
  "Prompt is too long · the request is ~214000 tokens (limit 200000) and this conversation's own content is most of it. A single-exchange conversation cannot be compacted; start with less content (smaller files or pasted text).",
  'API Error: Usage credits required for 1M context · run /usage-credits to turn them on (they take effect after you restart Claude Code), or /model to switch to standard context',
  "API Error: Claude's response exceeded the 64000 output token maximum for a request sent without streaming. The CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable cannot raise this limit.",
  "You've used 85% of your session limit · resets 3:45pm",
  'Fable 5.1 now uses usage credits · the prompt to confirm went unanswered — nothing was sent · answer it where this session is running, or /model to change',
  'Opus is experiencing high load, please use /model to switch to Sonnet',
  'Not logged in · Please run /login',
  'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again in a minute; if it keeps happening, close other Claude Code windows or sign in again with /login',
  'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit. Run /compact, or double press esc to go back and remove attachments.',
  'Context exceeds the 200k-token limit by 94k tokens — run /compact or /clear to continue.',
  'Error: Settings file exceeds the 2MiB limit: /path/to/settings.json',
  // Codex：codex-rs/protocol/src/error.rs
  'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
  'agent thread limit reached',
  'budget reached',
  'Selected model is at capacity. Please try a different model.',
  'Policy-restricted capacity is unavailable. Please try again later.',
  'We’re currently experiencing high demand, which may cause temporary errors.',
  "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
  'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.',
  'exceeded retry limit, last status: 503 Service Unavailable, request id: req_0123',
  'unexpected status 500 Internal Server Error: {"detail":"oops"}, url: https://chatgpt.com/backend-api/codex/responses',
  // 只有状态码（RESOURCE_EXHAUSTED、429），原因是别的事：消息太大（gRPC）、服务器上这个模型没有容量
  // （gemini-cli 的 googleQuotaErrors.test.ts）、这一次请求太大（OpenAI 的 429，Codex 会把状态和返回内容原样报出来）
  'UNAVAILABLE (code 503): The model is overloaded. Please try again later.',
  'RESOURCE_EXHAUSTED: grpc: received message larger than max (5000000 vs. 4194304)',
  'RESOURCE_EXHAUSTED: gRPC message exceeds maximum size 4194304: 5000000',
  'RESOURCE_EXHAUSTED (code 429): No capacity available for model gemini-3.1-pro-preview on the server',
  'unexpected status 429 Too Many Requests: {"error":{"message":"Request too large for gpt-5 in organization org-abc on tokens per min (TPM): Limit 30000, Requested 44000. The input or output tokens must be reduced in order to run successfully.","type":"tokens","code":"rate_limit_exceeded"}}, url: https://api.openai.com/v1/responses',
  // 操作系统自己的“配额”报错：磁盘配额（Linux / macOS）、Windows 的内存配额。和账号的额度无关
  'Disk quota exceeded (os error 122)',
  'Error: EDQUOT: disk quota exceeded, write',
  'Insufficient quota to complete the requested service. (os error 1453)',
  '[WinError 1453] Insufficient quota to complete the requested service',
  'Not enough quota is available to process this command. (os error 1816)',
  // 其他
  'warning: run ended with no output and no recorded error',
  'Error: ENOENT',
  'The usage of this function is limited',
];

test('模拟的命令行工具各自只有一个文件：Windows 上的测试会把它单独复制到别处运行', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mock-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_')));
  for (const [name, args] of [
    ['claude', ['-p', '--output-format', 'json']],
    ['agy', ['-p', '你好']],
    ['codex', ['exec', '-o', path.join(dir, 'codex-out.txt'), '-']],
  ]) {
    const file = path.join(dir, `${name}.js`);
    fs.copyFileSync(path.join(__dirname, 'mocks', `${name}.js`), file);
    const r = spawnSync(process.execPath, [file, ...args], { input: '你好', encoding: 'utf8', env, timeout: 20000 });
    assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
    assert.ok(r.stdout.includes('MOCK-'), `${name}: ${r.stdout}`);
  }
});

test('额度用完：认得出各家真实的报错，不把别的错误当成额度用完', () => {
  const { detectLimit, BRIEF_RETRY_MS } = require('../lib/limits');
  for (const text of LIMIT_MESSAGES) assert.ok(detectLimit(text), `应该认出来：${text}`);
  for (const text of NOT_LIMIT_MESSAGES) assert.strictEqual(detectLimit(text), null, `不应该当成额度用完：${text}`);
  // 只是请求太频繁、又没说等多久：过几分钟再试，不用等一小时
  assert.deepStrictEqual(detectLimit('API Error: Rate limit reached', 0), { resetAt: null, retryInMs: BRIEF_RETRY_MS });
  assert.deepStrictEqual(detectLimit('You’ve hit your usage limit. Try again later.', 0), { resetAt: null });
  assert.strictEqual(detectLimit(''), null);
  assert.strictEqual(detectLimit(null), null);
  // 操作系统的报错只去掉它自己那一行，别的行照常判断
  assert.ok(detectLimit('ERROR: Disk quota exceeded (os error 122)\nERROR: You’ve hit your usage limit. Try again later.'));
  // 请求太频繁的说法本身就算；只有 429 这个状态码、原因是请求太大时才不算
  assert.ok(detectLimit('Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s.'));
});

test('额度用完：很长的输出也很快判断完（关键词后面跟着一大片空白时不能反复回溯）', () => {
  const { detectLimit, parseResetAt, limitReply } = require('../lib/limits');
  const big = 50000;
  const inputs = [
    `usage limit reached. resets${' '.repeat(big)}x`,
    `usage limit reached. retry${' '.repeat(big)}x`,
    `usage limit reached. back${'\t'.repeat(big)}x`,
    `usage limit reached. resets${'\n'.repeat(big)}x`,
    `usage limit reached. try again at${' '.repeat(big)}x`,
    `usage limit reached. please wait${' '.repeat(big)}x`,
    `usage limit reached. ${'resets '.repeat(big / 7)}`,
    `usage limit reached. ${'retry in 1s '.repeat(big / 12)}`,
    `${'You have hit your '.repeat(big / 18)}limit`,
  ];
  const t0 = Date.now();
  for (const text of inputs) {
    detectLimit(text);
    parseResetAt(text);
    limitReply(text);
  }
  // 修好之前，头几条每条都要好几秒
  assert.ok(Date.now() - t0 < 2000, `用了 ${Date.now() - t0} 毫秒`);
});

test('额度用完：读出恢复时间（钟点、带时区的钟点、日期、时长）', () => {
  const { parseResetAt } = require('../lib/limits');
  const now = Date.UTC(2026, 10, 10, 10, 0, 0); // 2026-11-10 10:00 UTC，星期二
  const at = (text, t = now) => parseResetAt(text, t);
  const iso = (ts) => (ts == null ? null : new Date(ts).toISOString().slice(0, 16));
  // 本机时区的下一个 h:mi（刚过去十分钟以内算“刚恢复”：一秒后就能再试）
  const nextLocal = (h, mi, t = now) => {
    const d = new Date(t);
    d.setHours(h, mi, 0, 0);
    if (d.getTime() < t - 10 * 60000) d.setDate(d.getDate() + 1);
    return Math.max(d.getTime(), t + 1000);
  };

  // 没写时区：按本机时区
  assert.strictEqual(at("You've hit your session limit · resets 3:45pm"), nextLocal(15, 45));
  assert.strictEqual(at('5-hour limit reached ∙ resets 9pm'), nextLocal(21, 0));
  assert.strictEqual(at('…or try again at 3:05 PM.'), nextLocal(15, 5));
  assert.strictEqual(at('resets at 15:00'), nextLocal(15, 0));
  assert.strictEqual(at('Usage limit reached — your limit will reset at 12:00 AM. Subscribe to Max'), nextLocal(0, 0));
  assert.strictEqual(at('resets 3pm (Mars/Olympus_Mons)'), nextLocal(15, 0), '不认识的时区按本机时区');
  const monday = new Date(at("You've hit your weekly limit · resets Mon 12:00am"));
  assert.deepStrictEqual([monday.getDay(), monday.getHours(), monday.getMinutes()], [1, 0, 0]);
  assert.ok(monday.getTime() > now - 10 * 60000 && monday.getTime() - now <= 7 * 86400000 + 3600000);
  const nov12 = new Date(now);
  nov12.setMonth(10, 12);
  nov12.setHours(15, 5, 0, 0);
  assert.strictEqual(at('…or try again at Nov 12th, 2026 3:05 PM.'), nov12.getTime());
  assert.strictEqual(at("You've reached your usage limit. Resets Nov 12, 2026 at 3:05 PM"), nov12.getTime());

  // 写了时区：按它写的时区算
  assert.strictEqual(iso(at("You've hit your 5-hour limit · resets 5:20am (UTC)")), '2026-11-11T05:20');
  assert.strictEqual(iso(at("You've hit your session limit · resets 8:10pm (Asia/Tokyo)")), '2026-11-10T11:10');
  assert.strictEqual(iso(at("You've hit your limit · resets 3pm (America/Los_Angeles)")), '2026-11-10T23:00');
  assert.strictEqual(iso(at('Claude usage limit reached. Your limit will reset at 1pm (Etc/GMT+5).')), '2026-11-10T18:00');
  assert.strictEqual(iso(at("You've hit your weekly limit · resets May 31 at 5pm (Asia/Shanghai)", Date.UTC(2026, 4, 28, 2, 0))), '2026-05-31T09:00');
  assert.strictEqual(iso(at("You've hit your limit · resets Feb 4, 9pm (Africa/Johannesburg)", Date.UTC(2026, 1, 1, 10, 0))), '2026-02-04T19:00');
  assert.strictEqual(iso(at("You've hit your limit · resets 3pm (America/New_York)", Date.UTC(2026, 6, 1, 12, 0))), '2026-07-01T19:00', '夏令时');
  assert.strictEqual(iso(at("You've hit your weekly limit · resets Mon 12:00am (Asia/Tokyo)")), '2026-11-15T15:00');
  assert.strictEqual(iso(at('…or try again after it resets on December 1 at 00:00 UTC.')), '2026-12-01T00:00');
  // 24 小时制后面直接写 UTC / GMT（没有 am/pm、没有括号）
  assert.strictEqual(iso(at('spend limit reached · resets at 15:00 UTC')), '2026-11-10T15:00');
  assert.strictEqual(iso(at('spend limit reached · resets 15:00 GMT')), '2026-11-10T15:00');
  assert.strictEqual(iso(at('spend limit reached · resets 3:00pm UTC')), '2026-11-10T15:00');
  assert.strictEqual(iso(at('spend limit reached (daily; resets 2026-11-11 00:00 UTC)')), '2026-11-11T00:00');
  assert.strictEqual(iso(at('spend limit reached · resets Dec 1')), '2026-12-01T00:00', '只有日期：那天 UTC 0 点');

  // 时长
  assert.strictEqual(at('Individual quota reached.\nResets in 143h57m55s.'), now + (143 * 3600 + 57 * 60 + 55) * 1000);
  assert.strictEqual(at('Individual quota reached. Resets in 141h 35m 51s.'), now + (141 * 3600 + 35 * 60 + 51) * 1000);
  assert.strictEqual(at('Your quota will reset after 19h14m47s.'), now + (19 * 3600 + 14 * 60 + 47) * 1000);
  assert.strictEqual(at('Please retry in 34.074824224s.'), now + 34075);
  assert.strictEqual(at('Suggested retry after 60s.'), now + 60000);
  assert.strictEqual(at('Please try again in 7m12s.'), now + 432000);
  assert.strictEqual(at('Please try again in 6m0s.'), now + 360000);
  assert.strictEqual(at('try again in 2 hours 5 minutes.'), now + 125 * 60000);
  assert.strictEqual(at('Please wait 12345 seconds before retrying.'), now + 12345000);
  assert.strictEqual(at('Please retry in 0s.'), now + 1000, '已经到点：马上再试');
  assert.strictEqual(at('Claude AI usage limit reached|1762800000', 1762790000000), 1762800000 * 1000);

  // 夏令时结束那天（纽约 2026-11-01），凌晨 1 点到 2 点会出现两次。现在是第一次的 1:50
  const fallBack = Date.UTC(2026, 10, 1, 5, 50);
  assert.strictEqual(iso(at("You've hit your session limit · resets 1:30am (America/New_York)", fallBack)), '2026-11-01T06:30', '前一次 1:30 已经过去，说的是后一次（不是明天）');
  assert.strictEqual(iso(at("You've hit your session limit · resets 1:55am (America/New_York)", fallBack)), '2026-11-01T05:55', '前一次还没到');
  assert.strictEqual(iso(at("You've hit your session limit · resets 3:30am (America/New_York)", fallBack)), '2026-11-01T08:30');
  assert.strictEqual(iso(at("You've hit your session limit · resets 1:30am (America/New_York)", Date.UTC(2026, 10, 2, 5, 50))), '2026-11-02T06:30', '平常的日子不受影响');

  // 读不出来，或者离谱的时间：当成不知道
  for (const text of ['try again later', 'Retry 3 times', 'resets monthly at 3pm', 'resets soon', 'resets Feb 30 at 5pm', 'resets 25:00', 'resets Mar 3 at 5pm', 'Resets in 9000h.', 'presets 3pm', 'fallback 10:30', '']) {
    assert.strictEqual(at(text), null, text);
  }
});

test('额度用完：机器在别的时区时，时间也读得对（把这个文件放到别的时区里再跑一遍）', { skip: Boolean(process.env.RT_OTHER_ZONE) }, (t) => {
  const { spawnSync } = require('child_process');
  // 一个在 UTC 东边、没有夏令时；一个在西边、有夏令时。1 月 1 日这两个时区和 UTC 差的分钟数：
  for (const [zone, offset] of [['Asia/Shanghai', -480], ['America/Los_Angeles', 480]]) {
    const env = { ...process.env, TZ: zone, RT_OTHER_ZONE: '1' };
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()))'], { env, encoding: 'utf8' });
    if (probe.stdout !== String(offset)) {
      t.diagnostic(`这台机器上 TZ=${zone} 不起作用，跳过`);
      continue;
    }
    const r = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, `TZ=${zone}：\n${r.stdout}\n${r.stderr}`);
  }
});

test('额度用完：工具不报错、把那句话当成回复时也认得出来；正常的聊天不会被误认', () => {
  const { limitReply } = require('../lib/limits');
  for (const text of [
    "You've hit your session limit · resets 3:45pm",
    "You've hit your 5-hour limit · resets 5:20am (UTC)",
    "You've hit your org's monthly spend limit · visit https://claude.ai/admin-settings/usage to raise it",
    "You're out of extra usage · resets 9am (America/Cordoba)",
    'Weekly limit reached · resets 10am (Asia/Seoul) · /upgrade to Max or turn on /extra-usage',
    'Claude AI usage limit reached|1749924000',
    'API Error: Rate limit reached',
    'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:05 PM.',
    '⚠ Individual quota reached. Please upgrade your subscription to increase your limits.\nResets in 2h57m45s.',
    'You have exhausted your capacity on this model. Your quota will reset after 19h14m47s.',
    'Credit balance is too low',
    'Credit balance is too low.',
    "You've hit your individual usage limit",
    "You've hit your individual spend limit · ask your admin for a higher limit",
    'You’ve hit your usage limit for GPT-5.5. Switch to another model now, or try again at 3:05 PM.',
    'Claude usage limit reached. Your limit will reset at 1pm (Etc/GMT+5).',
    'Individual quota reached. Contact your administrator to enable overages.',
    "You've hit your limit · resets 3pm (America/Los_Angeles)",
    "You've hit your Opus limit · resets 3:45pm",
    "You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage",
    "You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings",
    'You’ve hit your usage limit. Try again later.',
    'You’ve hit your usage limit. To get more access now, send a request to your admin or try again later.',
    'spend limit reached · resets Dec 1',
    '5-hour limit reached ∙ resets 9pm',
    "You're out of usage credits · resets 2:50pm (America/New_York)",
  ]) {
    assert.ok(limitReply(text), `应该认出来：${text}`);
  }
  for (const text of [
    '我觉得 usage limit reached 这个报错说明额度用完了。',
    'When Claude Code says "You\'ve hit your session limit", it means the 5-hour window is used up.',
    "You've hit your context limit, so let me summarise what we have so far.",
    "You've hit on a good point about limits.",
    // 开头像，但接着往下说的是聊天
    "You've hit your limit of patience with this debate, Gemini!",
    "You've reached your limit, so let's wrap up here.",
    "You've hit your limit. Take a break and come back tomorrow!",
    'Rate limit reached is the error you get when you call the API too often.',
    "You're out of credits, I'm afraid, so the plan needs a cheaper option.",
    'Weekly limit reached — that is the banner Claude Code shows.',
    // 很短、开头也像，但说的不是额度（有人问“今天第四杯咖啡了，再来一杯？”）
    "You've reached your limit for today.",
    "You've hit your limit.",
    '"You have reached your limit."',
    "You've reached your daily caffeine limit.",
    "You've reached your word limit.",
    'You have reached your budget.',
    "You've hit your limit. Try again tomorrow.",
    "You've reached your daily limit. Try again tomorrow.",
    "You've hit your quota for bad puns.",
    'Session limit reached. I would reset the router and try again.',
    'Monthly limit reached. Upgrade your phone plan.',
    "You're out of credits. Game over!",
    `You've hit your session limit · resets 3:45pm\n${'这是一条很长的正常回复。'.repeat(40)}`,
    'Usage limits are a common topic.\n\n1. Session limit\n2. Weekly limit\n3. Opus limit\n4. Spend limit',
    '在线',
    '',
  ]) {
    assert.strictEqual(limitReply(text), null, `不应该当成额度用完：${text.slice(0, 60)}`);
  }
});

test('额度用完（接口）：Retry-After、retryDelay、按天算的额度', () => {
  const { retryAfterAt, dailyQuotaResetAt } = require('../lib/limits');
  const now = Date.UTC(2026, 10, 10, 10, 0, 0);
  assert.strictEqual(retryAfterAt({ 'retry-after': '120' }, null, now), now + 120000);
  assert.strictEqual(retryAfterAt({ 'retry-after': '0' }, null, now), now + 1000);
  assert.strictEqual(retryAfterAt({ 'retry-after': 'Tue, 10 Nov 2026 10:05:00 GMT' }, null, now), now + 300000);
  assert.strictEqual(retryAfterAt({ 'retry-after-ms': '1500' }, null, now), now + 1500);
  assert.strictEqual(retryAfterAt({}, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }] } }, now), now + 34000);
  assert.strictEqual(retryAfterAt({ 'retry-after': '999999999' }, null, now), null, '离谱的时间不算');
  assert.strictEqual(retryAfterAt({ 'retry-after': 'soon' }, null, now), null);
  assert.strictEqual(retryAfterAt(undefined, undefined, now), null);

  const quota = (quotaId) => ({ error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }, { retryDelay: '34s' }] } });
  // 10:00 UTC 是太平洋时间凌晨 2 点：下一个午夜是 11 月 11 日 08:00 UTC
  assert.strictEqual(new Date(dailyQuotaResetAt(quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), now)).toISOString(), '2026-11-11T08:00:00.000Z');
  // 夏令时期间是 07:00 UTC
  assert.strictEqual(new Date(dailyQuotaResetAt(quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), Date.UTC(2026, 6, 1, 12, 0))).toISOString(), '2026-07-02T07:00:00.000Z');
  assert.strictEqual(dailyQuotaResetAt(quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), now), null);
  assert.strictEqual(dailyQuotaResetAt({ error: { message: 'x' } }, now), null);
  assert.strictEqual(dailyQuotaResetAt(null, now), null);
});

test('额度用完：去掉被回显的提示词；读带分隔符的数字', () => {
  const { stripEcho, parseLocaleInt, detectLimit } = require('../lib/limits');
  const prompt = '你是 GPT。\n\n【主持人】\n为什么会报 You’ve hit your usage limit？\n';
  const output = `OpenAI Codex v0.167.0\n--------\nuser\n${prompt}\nERROR: stream disconnected before completion: timeout\n`;
  assert.ok(detectLimit(output), '不去掉回显的话，聊天内容会被当成报错');
  assert.strictEqual(detectLimit(stripEcho(output, prompt)), null);
  assert.ok(stripEcho(output, prompt).includes('ERROR: stream disconnected'));
  assert.strictEqual(stripEcho('a\r\n  b  \r\nc', 'b'), 'a\nc');
  assert.strictEqual(stripEcho('a\nb', '', null), 'a\nb');

  assert.strictEqual(parseLocaleInt('12,345'), 12345);
  assert.strictEqual(parseLocaleInt('12.345'), 12345);
  assert.strictEqual(parseLocaleInt('12 345'), 12345);
  assert.strictEqual(parseLocaleInt('1’234’567'), 1234567);
  assert.strictEqual(parseLocaleInt('१२,३४५'), 12345);
  assert.strictEqual(parseLocaleInt('٣٤٥'), 345);
  assert.strictEqual(parseLocaleInt('860'), 860);
  assert.strictEqual(parseLocaleInt('n/a'), null);
  assert.strictEqual(parseLocaleInt('12k'), null);
  assert.strictEqual(parseLocaleInt(''), null);
});

test('用量记录：按 5 小时 / 24 小时 / 7 天统计，额度用完的标记到时间自动清掉', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { UsageStore, estimateTokens } = require('../lib/usage');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-usage-')), 'usage.json');
  const u = new UsageStore(file);
  u.record('claude', 'claude-cli', { input: 100, output: 50, cached: 1000 });
  u.record('claude', 'claude-cli', { total: 30, estimated: true });
  u.data.events.push({ ts: Date.now() - 2 * 24 * 3600 * 1000, member: 'claude', input: 1, output: 1, total: 2 });
  const s = u.summary('claude');
  assert.deepStrictEqual(s.h5, { input: 100, output: 50, total: 180, cached: 1000, calls: 2, estimated: true }, '走缓存的输入单独记，不算进合计');
  assert.strictEqual(s.week.total, 182);
  assert.strictEqual(u.summary('gpt').day.calls, 0);

  u.setLimited('gpt', { resetAt: Date.now() + 60000, provider: 'codex-cli', message: 'limit' });
  assert.ok(u.isLimited('gpt', 'codex-cli'));
  assert.ok(!u.isLimited('gpt', 'github-models'), '额度跟着接入方式走');
  u.limit('gpt', 'codex-cli').retryAt = Date.now() - 1;
  assert.ok(!u.isLimited('gpt', 'codex-cli'), '过了恢复时间就不再算额度用完');
  const l = u.setLimited('gemini', {});
  assert.strictEqual(l.resetAt, null);
  assert.ok(l.retryAt > Date.now() + 50 * 60000, '不知道恢复时间时，一小时后再试');
  u.close();
  const again = new UsageStore(file);
  assert.ok(again.isLimited('gemini'), '重启后还记得');
  assert.strictEqual(again.summary('claude').week.calls, 3);
  assert.strictEqual(again.summary('claude').week.cached, 1000);
  again.resetCounts('claude');
  assert.strictEqual(again.summary('claude').week.calls, 0);
  again.close();

  assert.strictEqual(estimateTokens('你好世界'), 4);
  assert.strictEqual(estimateTokens('abcdefgh'), 2);
});

test('用量记录：到点后稍等再试；一试又用完就隔久一点；文件坏了也能读', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { UsageStore } = require('../lib/usage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-usage-'));
  const u = new UsageStore(path.join(dir, 'usage.json'));
  const MIN = 60000;
  const near = (a, b, tol = 2000) => Math.abs(a - b) <= tol;

  // 工具说的恢复时间只精确到分钟：到点后再等一下（最多一分钟）
  let now = Date.now();
  let l = u.setLimited('claude', { resetAt: now + 120 * MIN, provider: 'claude-cli' });
  assert.strictEqual(l.retryAt, l.resetAt + MIN);
  l = u.setLimited('claude', { resetAt: now + 20000, provider: 'claude-cli' });
  assert.ok(l.retryAt - l.resetAt >= 1000 && l.retryAt - l.resetAt <= 3000, '等待本来就短时，只多等一点点');
  u.clearLimited('claude', 'claude-cli');

  // 只是请求太频繁：五分钟后再试
  l = u.setLimited('gpt', { resetAt: null, retryInMs: 5 * MIN, provider: 'github-models' });
  assert.ok(l.resetAt === null && near(l.retryAt, Date.now() + 5 * MIN));
  u.clearLimited('gpt', 'github-models');

  // 工具说“1 秒后再试”，到点一试又用完：它报的时间不准，改成 5 分钟、15 分钟、1 小时
  const expire = (id, provider) => {
    u.limit(id, provider).retryAt = Date.now() - 1;
    assert.strictEqual(u.limit(id, provider), null);
  };
  l = u.setLimited('gemini', { resetAt: Date.now() + 1500, provider: 'gemini-api' });
  assert.ok(l.resetAt && !l.strikes);
  for (const wait of [5 * MIN, 15 * MIN, 60 * MIN, 60 * MIN]) {
    expire('gemini', 'gemini-api');
    l = u.setLimited('gemini', { resetAt: Date.now() + 1500, provider: 'gemini-api' });
    assert.ok(near(l.retryAt, Date.now() + wait), `应该等 ${wait / MIN} 分钟`);
    assert.strictEqual(l.resetAt, null, '报的时间不可信，界面上显示“恢复时间未知”');
  }
  // 工具给出的时间比这还晚：听它的
  expire('gemini', 'gemini-api');
  now = Date.now();
  l = u.setLimited('gemini', { resetAt: now + 180 * MIN, provider: 'gemini-api' });
  assert.strictEqual(l.resetAt, now + 180 * MIN);
  // 换了接入方式，或者用户点了“再试一次”：重新算
  expire('gemini', 'gemini-api');
  l = u.setLimited('gemini', { resetAt: Date.now() + 1500, provider: 'agy-cli' });
  assert.ok(l.resetAt && !l.strikes);
  expire('gemini', 'agy-cli');
  u.clearLimited('gemini', 'agy-cli');
  l = u.setLimited('gemini', { resetAt: Date.now() + 1500, provider: 'agy-cli' });
  assert.ok(l.resetAt && !l.strikes);
  u.clearLimited('gemini', 'agy-cli');

  // 成功了一次：去掉这种接入方式留下的标记；别的接入方式成功不算数
  u.setLimited('gpt', { resetAt: Date.now() + 60 * MIN, provider: 'codex-cli' });
  assert.strictEqual(u.succeeded('gpt', 'github-models'), false);
  assert.ok(u.limit('gpt', 'codex-cli'), 'GitHub Models 能用，不代表 Codex 的额度恢复了');
  assert.strictEqual(u.succeeded('gpt', 'codex-cli'), true);
  assert.strictEqual(u.limit('gpt', 'codex-cli'), null);
  assert.strictEqual(u.succeeded('gpt', 'codex-cli'), false, '本来就没有标记');
  // 到点后一试成功了，过一会儿又用完：是新的一次，不算“一试又用完”
  u.setLimited('gpt', { resetAt: Date.now() + 1500, provider: 'codex-cli' });
  expire('gpt', 'codex-cli');
  u.succeeded('gpt', 'github-models');
  l = u.setLimited('gpt', { resetAt: Date.now() + 1500, provider: 'codex-cli' });
  assert.strictEqual(l.strikes, 1, '别的接入方式成功不算数');
  expire('gpt', 'codex-cli');
  assert.strictEqual(u.succeeded('gpt', 'codex-cli'), false, '标记已经到时间去掉了');
  l = u.setLimited('gpt', { resetAt: Date.now() + 1500, provider: 'codex-cli' });
  assert.ok(l.resetAt && !l.strikes);
  u.clearLimited('gpt', 'codex-cli');

  // 每种接入方式各记各的：Codex 用完后换成 GitHub Models，那边又被限了一次，Codex 的标记不能被盖掉
  const codex = u.setLimited('gpt', { resetAt: Date.now() + 125 * MIN, provider: 'codex-cli' });
  u.setLimited('gpt', { retryInMs: 5 * MIN, provider: 'github-models' });
  assert.strictEqual(u.limit('gpt', 'codex-cli'), codex);
  assert.ok(near(u.limit('gpt', 'github-models').retryAt, Date.now() + 5 * MIN));
  assert.strictEqual(u.limit('gpt', 'openai-compatible'), null);
  assert.deepStrictEqual(u.marksOf('gpt').map((x) => x.provider).sort(), ['codex-cli', 'github-models']);
  // “再试一次”和成功只去掉那一种的
  assert.strictEqual(u.clearLimited('gpt', 'github-models'), true);
  assert.strictEqual(u.limit('gpt', 'codex-cli'), codex);
  u.setLimited('gpt', { retryInMs: 5 * MIN, provider: 'github-models' });
  u.close();
  // 重启后两个都还在
  const reopened = new UsageStore(path.join(dir, 'usage.json'));
  assert.deepStrictEqual(reopened.marksOf('gpt').map((x) => x.provider).sort(), ['codex-cli', 'github-models']);
  assert.strictEqual(reopened.limit('gpt', 'codex-cli').resetAt, codex.resetAt);
  reopened.close();
  // 早先的文件一位成员只存一个标记（键就是成员 id）：照样读得出来，还是只对那种接入方式算数
  const oldFile = path.join(dir, 'old.json');
  fs.writeFileSync(oldFile, JSON.stringify({ version: 1, events: [], limits: { gpt: { since: 1, resetAt: null, retryAt: Date.now() + 60 * MIN, provider: 'codex-cli', message: 'x' } } }));
  const old = new UsageStore(oldFile);
  assert.ok(old.limit('gpt', 'codex-cli'));
  assert.strictEqual(old.limit('gpt', 'github-models'), null);
  old.close();

  // 文件被改坏了：能用的留下，其余的丢掉，不报错
  const bad = path.join(dir, 'bad.json');
  const t = Date.now();
  fs.writeFileSync(
    bad,
    JSON.stringify({
      version: 1,
      events: [null, 'x', { ts: 'now', member: 'claude' }, { ts: t, member: 42 }, { ts: t - 40 * 86400000, member: 'claude', total: 5 }, { ts: t, member: 'claude', input: -5, output: '7', total: 'NaN', cached: 3, est: true }],
      limits: { claude: { retryAt: t + 60000, resetAt: 'soon', message: 12345 }, gpt: 'limited', gemini: { retryAt: t + 400 * 86400000 }, constructor: { retryAt: t + 60000 } },
    })
  );
  const b = new UsageStore(bad);
  assert.deepStrictEqual(b.data.events, [{ ts: t, member: 'claude', provider: '', input: 0, output: 7, total: 0, cached: 3, est: 1 }]);
  assert.deepStrictEqual(b.limit('claude'), { since: b.limit('claude').since, resetAt: null, retryAt: t + 60000, provider: '', message: '12345' });
  assert.strictEqual(b.limit('gpt'), null);
  assert.strictEqual(b.limit('gemini'), null, '一年以后才再试的标记不算数');
  assert.strictEqual(b.limit('toString'), null);
  assert.strictEqual(b.limit('__proto__'), null);
  b.close();
  for (const content of ['', 'not json', '[]', 'null', '{"events":{}}']) {
    fs.writeFileSync(bad, content);
    const x = new UsageStore(bad);
    assert.deepStrictEqual([x.data.events.length, Object.keys(x.data.limits).length], [0, 0]);
    clearTimeout(x.saveTimer);
    clearTimeout(x.expiryTimer);
  }
});

test('诊断信息：去掉密钥和网址里的账号密码，长输出只留头尾', () => {
  const { redactMember, redactUrl, clip } = require('../lib/diag');
  const { PROVIDERS } = require('../lib/providers');
  const out = redactMember({ 'gemini-api': { apiKey: 'AIza-secret', model: 'gemini-flash-latest', baseUrl: 'https://u:p@example.com/x' }, 'agy-cli': { apiKey: '' } }, PROVIDERS);
  assert.deepStrictEqual(out['gemini-api'], { apiKey: '(set)', model: 'gemini-flash-latest', baseUrl: 'https://***@example.com/x' });
  assert.strictEqual(redactUrl('http://user:pass@127.0.0.1:7890'), 'http://***@127.0.0.1:7890');
  assert.strictEqual(redactUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  const long = `HEAD${'x'.repeat(20000)}TAIL`;
  const c = clip(long);
  assert.ok(c.startsWith('HEAD') && c.endsWith('TAIL') && c.length < 6500 && c.includes('chars omitted'));
  assert.strictEqual(clip('\u001b[31mred\u001b[0m'), 'red');
});
