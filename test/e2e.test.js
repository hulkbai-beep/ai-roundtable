'use strict';

// 端到端测试：启动真实的本地服务，用模拟的 claude / agy / codex 和模拟接口跑完整的群聊流程。
// Windows 上模拟命令是 npm 格式的 .cmd，正好覆盖“解析 npm 脚本、直接启动 node”这条路径。

const { test, before, after } = require('node:test');
const assert = require('assert');
const path = require('path');
const { createAppServer } = require('../lib/app-server');
const { startMockApi } = require('./mocks/api');
const { ROOT, MOCKS, IS_WIN, tmpDir, makeBin, makeMockBins, client, sendAndWait, waitIdle, aiMessages, parseInfo, sleep } = require('./helpers');

let app;
let api;
let c;

before(async () => {
  const bin = makeMockBins(tmpDir('rt-bin-'));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  api = await startMockApi();
  app = createAppServer({ dataDir: tmpDir('rt-data-'), publicDir: path.join(ROOT, 'public') });
  await app.listen(0);
  c = client(app.port);
  const r = await c.post('/api/config', {
    lang: 'zh',
    members: { gpt: { 'github-models': { token: 'good-token', baseUrl: `http://127.0.0.1:${api.port}/inference` } } },
  });
  assert.strictEqual(r.status, 200);
});

after(async () => {
  await app.close();
  await api.close();
});

test('能找到三个命令行工具，网页能打开', async () => {
  const cfg = (await c.get('/api/config')).json;
  for (const pid of ['claude-cli', 'agy-cli', 'codex-cli']) assert.ok(cfg.detect[pid].found, `${pid} not found`);
  const page = await c.get('/');
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('AI 圆桌'));
  const ping = (await c.get('/api/ping')).json;
  assert.strictEqual(ping.app, 'ai-roundtable');
});

test('默认配置：GPT 用 Codex CLI', async () => {
  const cfg = (await c.get('/api/config')).json;
  assert.strictEqual(cfg.config.members.gpt.provider, 'codex-cli');
  const options = Object.entries(cfg.providers)
    .filter(([, p]) => p.member === 'gpt')
    .map(([id]) => id);
  assert.strictEqual(options[0], 'codex-cli', '设置里 Codex 应该排在第一个');
});

test('三位成员都能通过连接测试', async () => {
  for (const id of ['claude', 'gemini', 'gpt']) {
    const r = (await c.post(`/api/test/${id}`)).json;
    assert.ok(r.ok, `${id}: ${r.error} ${r.hint}`);
    assert.strictEqual(r.reply, '在线');
  }
});

test('两轮讨论：每人轮流发言，后面的人能看到前面的发言，参数都传对了', async () => {
  await c.post('/api/new');
  const s = await sendAndWait(c, { text: '周末爬山还是看电影？带个"引号"试试', mode: 'discuss', rounds: 2, length: 'short' });
  const ai = aiMessages(s);
  assert.deepStrictEqual(
    ai.map((m) => m.speaker),
    ['claude', 'gemini', 'gpt', 'claude', 'gemini', 'gpt']
  );

  const c1 = parseInfo(ai[0].text, 'MOCK-CLAUDE');
  assert.ok(!ai[0].text.startsWith('Claude：'), '名字前缀应该被去掉');
  assert.deepStrictEqual(
    { print: c1.print, json: c1.json, systemArg: c1.systemArg, toolsDisabled: c1.toolsDisabled, stdinHasSystem: c1.stdinHasSystem, quote: c1.quote },
    { print: true, json: true, systemArg: true, toolsDisabled: true, stdinHasSystem: false, quote: true }
  );
  assert.ok(c1.systemLines > 5, '多行的人设应该完整传给 claude');
  assert.strictEqual(c1.blocks, 1);

  assert.ok(ai[1].text.startsWith('MOCK-AGY'), '终端颜色控制符应该被去掉');
  const g1 = parseInfo(ai[1].text, 'MOCK-AGY');
  assert.deepStrictEqual({ blocks: g1.blocks, hasSystem: g1.hasSystem, quote: g1.quote }, { blocks: 2, hasSystem: true, quote: true });
  assert.ok(g1.lines > 10, '多行提示词应该完整传给 agy');

  const p1 = parseInfo(ai[2].text, 'MOCK-CODEX');
  assert.deepStrictEqual(p1, { exec: true, sandbox: 'read-only', stdinDash: true, hasSystem: true, blocks: 3 });

  assert.strictEqual(parseInfo(ai[3].text, 'MOCK-CLAUDE').blocks, 4);
  assert.strictEqual(parseInfo(ai[5].text, 'MOCK-CODEX').blocks, 6);
});

test('@点名：只有被点到的人按顺序回答', async () => {
  const s = await sendAndWait(c, { text: '@GPT 你先说，@Claude 再补充', mode: 'discuss', rounds: 3 });
  const tail = s.messages.slice(-3);
  assert.deepStrictEqual(
    tail.map((m) => m.speaker),
    ['user', 'gpt', 'claude']
  );
});

test('各自回答：看不到别人这一轮的回答', async () => {
  await c.post('/api/new');
  const s = await sendAndWait(c, { text: '用一句话解释量子纠缠', mode: 'independent', rounds: 1 });
  const ai = aiMessages(s);
  assert.strictEqual(parseInfo(ai[1].text, 'MOCK-AGY').blocks, 1);
  assert.strictEqual(parseInfo(ai[2].text, 'MOCK-CODEX').blocks, 1);
});

test('停止：打断正在说话的成员，取消后面的发言', async () => {
  process.env.MOCK_DELAY = '3000';
  try {
    await c.post('/api/send', { text: '来一场三轮辩论', mode: 'debate', rounds: 3 });
    await sleep(500);
    const r = (await c.post('/api/stop')).json;
    assert.strictEqual(r.stopped, true);
    const s = await waitIdle(c, 10000);
    const last = s.messages[s.messages.length - 1];
    assert.strictEqual(last.speaker, 'system');
    assert.ok(last.text.includes('已停止'));
    assert.strictEqual(s.state.queued, 0);
  } finally {
    delete process.env.MOCK_DELAY;
  }
});

test('继续聊：不发新消息，大家再聊一轮', async () => {
  const before = (await c.get('/api/state')).json.messages.length;
  const r = await c.post('/api/continue', { mode: 'collab', rounds: 1 });
  assert.strictEqual(r.status, 200);
  const s = await waitIdle(c);
  assert.deepStrictEqual(
    s.messages.slice(before).map((m) => m.speaker),
    ['claude', 'gemini', 'gpt']
  );
});

test('某位成员出错：显示原因和建议，其他人照常发言', async () => {
  process.env.MOCK_AGY_SILENT = '1';
  try {
    await c.post('/api/new');
    const s = await sendAndWait(c, { text: '测试出错', mode: 'discuss', rounds: 2 });
    const errors = s.messages.filter((m) => m.speaker === 'system');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].text.includes('Gemini 发言失败'));
    assert.ok(errors[0].text.includes('建议'));
    assert.deepStrictEqual(
      aiMessages(s).map((m) => m.speaker),
      ['claude', 'gpt', 'claude', 'gpt']
    );
  } finally {
    delete process.env.MOCK_AGY_SILENT;
  }
});

test('用量：记下每位成员用了多少 token，回复上标出来', async () => {
  await c.post('/api/usage/reset', {});
  await c.post('/api/new');
  const s = await sendAndWait(c, { text: '聊聊用量', rounds: 1 });
  const ai = aiMessages(s);
  const by = (who) => ai.find((m) => m.speaker === who);
  assert.strictEqual(by('claude').meta.tokens, 1150, 'Claude Code 的 usage 里的输入、缓存和输出都算上');
  assert.strictEqual(by('gpt').meta.tokens, 1234, 'Codex 输出里的 tokens used');
  assert.ok(by('gemini').meta.tokens > 0 && by('gemini').meta.tokensEstimated, 'agy 不报用量，按字数估算');
  const m = Object.fromEntries(s.members.map((x) => [x.id, x]));
  assert.deepStrictEqual(
    { total: m.claude.usage.h5.total, calls: m.claude.usage.h5.calls, est: m.claude.usage.h5.estimated },
    { total: 1150, calls: 1, est: false }
  );
  assert.strictEqual(m.gpt.usage.day.total, 1234);
  assert.ok(m.gemini.usage.week.estimated);
  await c.post('/api/usage/reset', { member: 'claude' });
  const after = (await c.get('/api/state')).json.members.find((x) => x.id === 'claude');
  assert.strictEqual(after.usage.week.calls, 0);
});

test('额度用完：提醒、标出来，其他成员继续；点名会再试，成功就恢复', async () => {
  const limitedOf = async (id) => (await c.get('/api/state')).json.members.find((x) => x.id === id).limited;
  process.env.MOCK_CODEX_LIMIT = '1';
  try {
    await c.post('/api/new');
    let s = await sendAndWait(c, { text: '两轮讨论', rounds: 2 });
    const alerts = s.messages.filter((x) => x.alert === 'limit');
    assert.strictEqual(alerts.length, 1, '只提醒一次');
    assert.strictEqual(alerts[0].member, 'gpt');
    assert.ok(alerts[0].text.includes('GPT 的额度用完了') && alerts[0].text.includes('Claude、Gemini'), alerts[0].text);
    assert.deepStrictEqual(aiMessages(s).map((x) => x.speaker), ['claude', 'gemini', 'claude', 'gemini']);
    const lim = await limitedOf('gpt');
    assert.strictEqual(lim.provider, 'codex-cli');
    assert.ok(Math.abs(lim.resetAt - (Date.now() + 125 * 60000)) < 60000, '读出“2 hours 5 minutes”');

    // 继续聊：直接跳过 GPT（刚提醒过，不再重复说明）
    const before = s.messages.length;
    await c.post('/api/continue', { rounds: 1 });
    s = await waitIdle(c);
    assert.deepStrictEqual(s.messages.slice(before).map((x) => x.speaker), ['claude', 'gemini']);

    // 新对话里第一次发言时说明一下
    await c.post('/api/new');
    s = await sendAndWait(c, { text: '新话题' });
    assert.ok(s.messages[1].speaker === 'system' && s.messages[1].text.includes('GPT 额度用完了，这次由 Claude、Gemini 继续'), s.messages[1].text);
    assert.deepStrictEqual(aiMessages(s).map((x) => x.speaker), ['claude', 'gemini']);
  } finally {
    delete process.env.MOCK_CODEX_LIMIT;
  }
  // 额度恢复后点名 GPT：再试一次，成功就去掉标记
  const s = await sendAndWait(c, { text: '@GPT 你回来了吗' });
  const tail = s.messages.slice(-4);
  assert.ok(tail[1].text.includes('按你的点名再试一次'), tail[1].text);
  assert.ok(tail[2].text.includes('额度恢复了'), tail[2].text);
  assert.strictEqual(tail[3].speaker, 'gpt');
  assert.strictEqual(await limitedOf('gpt'), null);
});

test('额度用完：所有人都用完时提示；换接入方式或点“再试一次”就清掉', async () => {
  process.env.MOCK_CLAUDE_LIMIT = '1';
  process.env.MOCK_AGY_LIMIT = '1';
  process.env.MOCK_CODEX_LIMIT = '1';
  try {
    await c.post('/api/new');
    let s = await sendAndWait(c, { text: '大家都没额度了' });
    assert.strictEqual(s.messages.filter((x) => x.alert === 'limit').length, 3);
    const m = Object.fromEntries(s.members.map((x) => [x.id, x]));
    assert.ok(m.claude.limited.resetAt > Date.now() + 2 * 3600 * 1000, 'Claude 的恢复时间来自 “|时间戳”');
    assert.strictEqual(m.gemini.limited.resetAt, null);
    assert.ok(s.messages[s.messages.length - 1].text.includes('所有成员的额度都用完了'));

    s = await sendAndWait(c, { text: '还有人吗' });
    const last = s.messages[s.messages.length - 1];
    assert.ok(last.speaker === 'system' && last.text.includes('现在没人能发言'), last.text);

    // 连接测试遇到额度用完也会标记
    const t = (await c.post('/api/test/claude')).json;
    assert.ok(!t.ok && t.limited);
  } finally {
    delete process.env.MOCK_CLAUDE_LIMIT;
    delete process.env.MOCK_AGY_LIMIT;
    delete process.env.MOCK_CODEX_LIMIT;
  }
  // GPT 换成 GitHub Models：之前 Codex 的标记不算数
  await c.post('/api/config', { members: { gpt: { provider: 'github-models' } } });
  try {
    const gpt = (await c.get('/api/state')).json.members.find((x) => x.id === 'gpt');
    assert.strictEqual(gpt.limited, null);
  } finally {
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
  // “再试一次”：手动清掉标记；连接测试成功也会清掉
  const r = (await c.post('/api/usage/retry', { member: 'claude' })).json;
  assert.strictEqual(r.members.find((x) => x.id === 'claude').limited, null);
  assert.ok((await c.post('/api/test/gemini')).json.ok);
  await c.post('/api/usage/retry', { member: 'gpt' });
  const s = await sendAndWait(c, { text: '都回来了吗' });
  assert.deepStrictEqual(aiMessages(s).slice(-3).map((x) => x.speaker).sort(), ['claude', 'gemini', 'gpt']);
});

test('额度用完（接口）：HTTP 429 标记为额度用完，Retry-After 给出恢复时间', async () => {
  await c.post('/api/config', { members: { gpt: { provider: 'github-models' } } });
  api.setMode('429');
  try {
    await c.post('/api/new');
    const s = await sendAndWait(c, { text: '@GPT 你好' });
    const gpt = s.members.find((x) => x.id === 'gpt');
    assert.strictEqual(gpt.limited.provider, 'github-models');
    assert.ok(Math.abs(gpt.limited.resetAt - (Date.now() + 120000)) < 10000, gpt.limited.resetAt);
  } finally {
    api.setMode('ok');
    await c.post('/api/usage/retry', { member: 'gpt' });
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
});

test('模型和思考强度：传给命令行和接口，回复上标出来；不支持时自动忽略', async () => {
  await c.post('/api/config', {
    members: {
      claude: { 'claude-cli': { model: 'opus', effort: 'high' } },
      gpt: { 'codex-cli': { model: 'gpt-x', effort: 'low' } },
    },
  });
  try {
    await c.post('/api/new');
    let s = await sendAndWait(c, { text: '@Claude @GPT 你好' });
    const cl = aiMessages(s).find((m) => m.speaker === 'claude');
    const gp = aiMessages(s).find((m) => m.speaker === 'gpt');
    const ci = parseInfo(cl.text, 'MOCK-CLAUDE');
    assert.strictEqual(ci.model, 'opus');
    assert.strictEqual(ci.effort, 'high');
    assert.strictEqual(cl.meta.effort, '思考高');
    const gi = parseInfo(gp.text, 'MOCK-CODEX');
    assert.strictEqual(gi.model, 'gpt-x');
    assert.strictEqual(gi.config, 'model_reasoning_effort=low');
    assert.strictEqual(gp.meta.effort, '思考低');

    // 不认识的值不会传下去
    await c.post('/api/config', { members: { claude: { 'claude-cli': { effort: 'bogus' } } } });
    s = await sendAndWait(c, { text: '@Claude 再来' });
    assert.strictEqual(parseInfo(aiMessages(s).pop().text, 'MOCK-CLAUDE').effort, undefined);

    // 旧版 Claude Code 不认 --effort：去掉后照常回复，并注明
    await c.post('/api/config', { members: { claude: { 'claude-cli': { effort: 'max' } } } });
    process.env.MOCK_OLD_CLAUDE = '1';
    const old = (await c.post('/api/test/claude')).json;
    assert.ok(old.ok, old.error);
    assert.ok(old.note.includes('思考强度'));
  } finally {
    delete process.env.MOCK_OLD_CLAUDE;
    await c.post('/api/config', {
      members: { claude: { 'claude-cli': { model: '', effort: '' } }, gpt: { 'codex-cli': { model: '', effort: '' } } },
    });
  }
});

test('接口的思考强度：推理模型带上 reasoning_effort / thinkingLevel，不支持的模型去掉后重试', async () => {
  await c.post('/api/config', {
    members: {
      gpt: { provider: 'github-models', 'github-models': { effort: 'high' } },
      gemini: { provider: 'gemini-api', 'gemini-api': { apiKey: 'good-key', baseUrl: `http://127.0.0.1:${api.port}`, effort: 'low' } },
    },
  });
  try {
    await c.post('/api/new');
    let s = await sendAndWait(c, { text: '@GPT @Gemini 你好' });
    const pick = (st, who) => aiMessages(st).filter((m) => m.speaker === who).pop();
    let gp = pick(s, 'gpt');
    let ge = pick(s, 'gemini');
    assert.strictEqual(parseInfo(gp.text, 'MOCK-GPT').effort, undefined, 'gpt-4.1 不支持，应去掉后重试');
    assert.ok(gp.meta.note.includes('思考强度'));
    assert.strictEqual(parseInfo(ge.text, 'MOCK-GEMINI-API').level, 'low');
    assert.strictEqual(ge.meta.effort, '思考低');

    await c.post('/api/config', {
      members: { gpt: { 'github-models': { model: 'openai/o4-mini' } }, gemini: { 'gemini-api': { model: 'gemini-flash-lite-latest' } } },
    });
    s = await sendAndWait(c, { text: '@GPT @Gemini 再来' });
    gp = pick(s, 'gpt');
    ge = pick(s, 'gemini');
    assert.strictEqual(parseInfo(gp.text, 'MOCK-GPT').effort, 'high');
    assert.strictEqual(gp.meta.effort, '思考高');
    assert.strictEqual(parseInfo(ge.text, 'MOCK-GEMINI-API').level, undefined);
    assert.ok(ge.meta.note.includes('思考强度'));
  } finally {
    await c.post('/api/config', {
      members: {
        gpt: { provider: 'codex-cli', 'github-models': { model: 'openai/gpt-4.1', effort: '' } },
        gemini: { provider: 'agy-cli', 'gemini-api': { model: 'gemini-flash-latest', effort: '' } },
      },
    });
  }
});

test('英文版：界面文字、AI 的人设和错误提示都换成英文，再换回中文', async () => {
  let cfg = (await c.post('/api/config', { lang: 'en' })).json;
  try {
    assert.strictEqual(cfg.lang, 'en');
    assert.strictEqual(cfg.providers['claude-cli'].label, 'Claude Code (Max subscription)');
    const effort = cfg.providers['claude-cli'].fields.find((f) => f.key === 'effort');
    assert.deepStrictEqual(effort.options[0], ['', 'Default']);
    assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify(cfg.providers)), '接入方式的说明里不应该还有中文');

    await c.post('/api/new');
    const s = await sendAndWait(c, { text: '@Claude hello' });
    assert.strictEqual(s.lang, 'en');
    assert.strictEqual(s.modes.debate, 'Debate');
    const info = parseInfo(aiMessages(s)[0].text, 'MOCK-CLAUDE');
    assert.strictEqual(info.systemArg, false, '英文人设里不应该有“你是 Claude”');
    assert.strictEqual(info.systemEn, true);

    const bad = await c.post('/api/send', { text: '' });
    assert.strictEqual(bad.json.error, 'The message is empty');
    assert.ok((await c.post('/api/test/claude')).json.ok);
  } finally {
    cfg = (await c.post('/api/config', { lang: 'zh' })).json;
  }
  assert.strictEqual(cfg.providers['claude-cli'].label, 'Claude Code（Max 订阅）');
});

test('旧版本命令行工具：不认识的参数会自动去掉再试', async () => {
  process.env.MOCK_OLD_CLAUDE = '1';
  process.env.MOCK_OLD_CODEX = '1';
  try {
    assert.ok((await c.post('/api/test/claude')).json.ok);
    const r = (await c.post('/api/test/gpt')).json;
    assert.ok(r.ok, r.error);
  } finally {
    delete process.env.MOCK_OLD_CLAUDE;
    delete process.env.MOCK_OLD_CODEX;
  }
});

test('GPT 默认用 Codex CLI：只读模式，提示词从标准输入传', async () => {
  await c.post('/api/new');
  const s = await sendAndWait(c, { text: '@GPT 你好' });
  const info = parseInfo(aiMessages(s)[0].text, 'MOCK-CODEX');
  assert.deepStrictEqual(info, { exec: true, sandbox: 'read-only', stdinDash: true, hasSystem: true, blocks: 1 });
});

test('Gemini 换成 API Key：密钥错误有提示，正确时能用', async () => {
  await c.post('/api/config', { members: { gemini: { provider: 'gemini-api', 'gemini-api': { apiKey: 'bad-key', baseUrl: `http://127.0.0.1:${api.port}` } } } });
  try {
    const bad = (await c.post('/api/test/gemini')).json;
    assert.ok(!bad.ok && bad.error.includes('HTTP 400') && bad.hint.includes('API Key'));
    await c.post('/api/config', { members: { gemini: { 'gemini-api': { apiKey: 'good-key' } } } });
    const good = (await c.post('/api/test/gemini')).json;
    assert.ok(good.ok, good.error);
    assert.strictEqual(good.reply, '在线');
  } finally {
    await c.post('/api/config', { members: { gemini: { provider: 'agy-cli' } } });
  }
});

test('GitHub Models（备选）：能用；token 错误、额度用完都有提示；能加载模型列表', async () => {
  await c.post('/api/config', { members: { gpt: { provider: 'github-models' } } });
  try {
    const ok = (await c.post('/api/test/gpt')).json;
    assert.ok(ok.ok, ok.error);
    assert.strictEqual(ok.model, 'openai/gpt-4.1');

    await c.post('/api/config', { members: { gpt: { 'github-models': { token: 'wrong' } } } });
    const bad = (await c.post('/api/test/gpt')).json;
    assert.ok(!bad.ok && bad.error.includes('HTTP 401'));
    await c.post('/api/config', { members: { gpt: { 'github-models': { token: 'good-token' } } } });

    api.setMode('429');
    const limited = (await c.post('/api/test/gpt')).json;
    assert.ok(!limited.ok && limited.hint.includes('额度'));

    api.setMode('ok');
    const list = (await c.post('/api/github-models')).json;
    assert.strictEqual(list.items[0].id, 'openai/gpt-4.1', 'OpenAI 的模型排在前面');

    api.setMode('catalog-envelope');
    const wrapped = (await c.post('/api/github-models')).json;
    assert.strictEqual(wrapped.items.length, 2, '包了一层 {data: [...]} 的列表也要能读');

    api.setMode('catalog-text');
    const weird = await c.post('/api/github-models');
    assert.strictEqual(weird.status, 400);
    assert.ok(weird.json.error.includes('格式看不懂') && weird.json.error.includes('OK'), weird.json.error);
    assert.ok(!weird.json.error.includes('HTTP 200'), '成功的响应不应该报“请求失败（HTTP 200）”');
  } finally {
    api.setMode('ok');
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
});

test('密钥：界面上只显示打码后的值，不重新填写时保持不变', async () => {
  const cfg = (await c.post('/api/config', { members: { gpt: { provider: 'github-models', 'github-models': { token: '' } } } })).json;
  try {
    const gh = cfg.config.members.gpt['github-models'];
    assert.strictEqual(gh.tokenSet, true);
    assert.ok(!JSON.stringify(cfg).includes('good-token'), '完整的 token 不应该出现在接口返回里');
    assert.ok((await c.post('/api/test/gpt')).json.ok);
  } finally {
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
});

test('安全：拒绝其他网站和非本机 Host 的请求', async () => {
  const http = require('http');
  const raw = (headers, method = 'GET', p = '/api/state') =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: app.port, path: p, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end(method === 'POST' ? '{}' : undefined);
    });
  assert.strictEqual(await raw({ Host: 'evil.example.com' }), 403);
  assert.strictEqual(await raw({ Host: `127.0.0.1:${app.port}`, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' }, 'POST', '/api/stop'), 403);
  assert.strictEqual(await raw({ Host: `127.0.0.1:${app.port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', '/api/stop'), 415);
  // 只认 application/json：别的网站不经预检就能发的那几种类型（text/plain 等）一律不收，后面带上 “application/json” 字样也不行
  for (const type of ['text/plain', 'text/plain; application/json', 'text/plain;charset=application/json', 'multipart/form-data; boundary=application/json', 'application/jsonp', '']) {
    assert.strictEqual(await raw({ Host: `127.0.0.1:${app.port}`, 'Content-Type': type }, 'POST', '/api/stop'), 415, type);
  }
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8', ' application/json ']) {
    assert.strictEqual(await raw({ Host: `127.0.0.1:${app.port}`, 'Content-Type': type }, 'POST', '/api/stop'), 200, type);
  }
  assert.strictEqual(await raw({ Host: `127.0.0.1:${app.port}` }, 'GET', '/../package.json'), 404);
});

test('导出和历史对话', async () => {
  await c.post('/api/new');
  await sendAndWait(c, { text: '这是一条要存进历史的消息', rounds: 1 });
  const md = await c.get('/api/export');
  assert.ok(md.text.startsWith('# AI 圆桌：这是一条要存进历史的消息'));
  await c.post('/api/new');
  const items = (await c.get('/api/history')).json.items;
  const hit = items.find((it) => it.title.includes('要存进历史'));
  assert.ok(hit);
  await c.post('/api/history/open', { file: hit.file });
  const s = (await c.get('/api/state')).json;
  assert.ok(s.messages[0].text.includes('要存进历史'));
});

test('Windows：.cmd 解析不了时走 cmd.exe，人设改由标准输入传递', { skip: !IS_WIN }, async () => {
  const dir = tmpDir('rt-plain-');
  const file = makeBin(dir, 'claude', path.join(MOCKS, 'claude.js'), 'plain');
  await c.post('/api/config', { members: { claude: { 'claude-cli': { command: file } } } });
  try {
    await c.post('/api/new');
    const s = await sendAndWait(c, { text: '@Claude 你好' });
    const info = parseInfo(aiMessages(s)[0].text, 'MOCK-CLAUDE');
    assert.deepStrictEqual(
      { systemArg: info.systemArg, stdinHasSystem: info.stdinHasSystem, toolsDisabled: info.toolsDisabled },
      { systemArg: false, stdinHasSystem: true, toolsDisabled: true }
    );
  } finally {
    await c.post('/api/config', { members: { claude: { 'claude-cli': { command: 'claude' } } } });
  }
});
