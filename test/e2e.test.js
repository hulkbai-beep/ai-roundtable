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
