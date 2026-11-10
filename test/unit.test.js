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

test('额度用完：识别各家的报错，读出恢复时间', () => {
  const { detectLimit, parseResetAt } = require('../lib/providers');
  const now = new Date(2026, 10, 10, 10, 0, 0).getTime(); // 2026-11-10 10:00（本地时间）
  assert.strictEqual(detectLimit('Claude AI usage limit reached|1762800000', now).resetAt, 1762800000 * 1000);
  assert.strictEqual(detectLimit("You've hit your usage limit. Upgrade to Plus, or try again in 2 hours 5 minutes.", now).resetAt, now + (2 * 60 + 5) * 60000);
  assert.strictEqual(detectLimit('RESOURCE_EXHAUSTED: Quota exceeded. Please retry in 37.5s.', now).resetAt, now + 37500);
  assert.strictEqual(detectLimit("You've hit your limit · resets 3pm (America/Los_Angeles)", now).resetAt, new Date(2026, 10, 10, 15, 0).getTime());
  assert.strictEqual(detectLimit('usage limit reached, try again at 9:30 AM', now).resetAt, new Date(2026, 10, 11, 9, 30).getTime(), '已经过了的时间算明天');
  assert.strictEqual(detectLimit("You've reached your usage limit. Resets Nov 12, 2026 at 3:05 PM", now).resetAt, new Date(2026, 10, 12, 15, 5).getTime());
  assert.deepStrictEqual(detectLimit('Error: insufficient_quota', now), { resetAt: null });
  assert.strictEqual(detectLimit('Error: ENOENT', now), null);
  assert.strictEqual(detectLimit('The usage of this function is limited', now), null);
  assert.strictEqual(parseResetAt('try again later', now), null);
});

test('用量记录：按 5 小时 / 24 小时 / 7 天统计，额度用完的标记到时间自动清掉', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { UsageStore, estimateTokens } = require('../lib/usage');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-usage-')), 'usage.json');
  const u = new UsageStore(file);
  u.record('claude', 'claude-cli', { input: 100, output: 50 });
  u.record('claude', 'claude-cli', { total: 30, estimated: true });
  u.data.events.push({ ts: Date.now() - 2 * 24 * 3600 * 1000, member: 'claude', input: 1, output: 1, total: 2 });
  const s = u.summary('claude');
  assert.deepStrictEqual(s.h5, { input: 100, output: 50, total: 180, calls: 2, estimated: true });
  assert.strictEqual(s.week.total, 182);
  assert.strictEqual(u.summary('gpt').day.calls, 0);

  u.setLimited('gpt', { resetAt: Date.now() + 60000, provider: 'codex-cli', message: 'limit' });
  assert.ok(u.isLimited('gpt'));
  u.data.limits.gpt.retryAt = Date.now() - 1;
  assert.ok(!u.isLimited('gpt'), '过了恢复时间就不再算额度用完');
  const l = u.setLimited('gemini', {});
  assert.strictEqual(l.resetAt, null);
  assert.ok(l.retryAt > Date.now() + 50 * 60000, '不知道恢复时间时，一小时后再试');
  u.close();
  const again = new UsageStore(file);
  assert.ok(again.isLimited('gemini'), '重启后还记得');
  assert.strictEqual(again.summary('claude').week.calls, 3);
  again.resetCounts('claude');
  assert.strictEqual(again.summary('claude').week.calls, 0);
  again.close();

  assert.strictEqual(estimateTokens('你好世界'), 4);
  assert.strictEqual(estimateTokens('abcdefgh'), 2);
});
