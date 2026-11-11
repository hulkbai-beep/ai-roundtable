'use strict';

// 端到端测试：启动真实的本地服务，用模拟的 claude / agy / codex 和模拟接口跑完整的群聊流程。
// Windows 上模拟命令是 npm 格式的 .cmd，正好覆盖“解析 npm 脚本、直接启动 node”这条路径。

const { test, before, after } = require('node:test');
const assert = require('assert');
const path = require('path');
const { createAppServer } = require('../lib/app-server');
const { startMockApi } = require('./mocks/api');
const { ROOT, MOCKS, IS_WIN, tmpDir, makeBin, makeMockBins, client, listen, sendAndWait, waitIdle, waitFor, aiMessages, parseInfo, sleep } = require('./helpers');

let app;
let api;
let c;

const TAGS = { claude: 'MOCK-CLAUDE', gemini: 'MOCK-AGY', gpt: 'MOCK-CODEX' };
const ALL = ['claude', 'gemini', 'gpt'];
// 模拟的 AI 会报告自己看到了几条聊天记录
const blocksOf = (m) => parseInfo(m.text, TAGS[m.speaker]).blocks;
const typingNow = async () => (await c.get('/api/state')).json.state.typing.map((t) => t.speaker).sort();

before(async () => {
  const bin = makeMockBins(tmpDir('rt-bin-'));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  api = await startMockApi();
  app = createAppServer({ dataDir: tmpDir('rt-data-'), publicDir: path.join(ROOT, 'public') });
  await app.listen(0);
  c = client(app.port);
  // 默认每条消息会换一个发言顺序；这里先关掉，下面的测试才能按固定的顺序检查（换顺序另有测试）
  const r = await c.post('/api/config', {
    lang: 'zh',
    shuffleOrder: false,
    members: { gpt: { 'github-models': { token: 'good-token', baseUrl: `http://127.0.0.1:${api.port}/inference` } } },
  });
  assert.strictEqual(r.status, 200);
});

after(async () => {
  await app.close();
  await api.close();
});

const memberOf = async (id) => (await c.get('/api/state')).json.members.find((x) => x.id === id);
const limitedOf = async (id) => (await memberOf(id)).limited;
const near = (actual, expected, toleranceMs) => typeof actual === 'number' && Math.abs(actual - expected) < toleranceMs;

// 模拟的命令行工具靠环境变量切换行为：设置好，跑完再恢复
async function withEnv(vars, fn) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
  }
}

test('能找到三个命令行工具，网页能打开', async () => {
  const cfg = (await c.get('/api/config')).json;
  for (const pid of ['claude-cli', 'agy-cli', 'codex-cli']) assert.ok(cfg.detect[pid].found, `${pid} not found`);
  const page = await c.get('/');
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('AI 圆桌'));
  const ping = (await c.get('/api/ping')).json;
  assert.strictEqual(ping.app, 'ai-roundtable');
});

test('默认配置：GPT 用 Codex CLI，每条消息换一个发言顺序', async () => {
  const { DEFAULTS } = require('../lib/store');
  assert.strictEqual(DEFAULTS.shuffleOrder, true);
  const cfg = (await c.get('/api/config')).json;
  assert.strictEqual(cfg.config.shuffleOrder, false, '上面关掉了，设置要能存住');
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

test('各自回答：大家同时回答，互相看不到这一轮的回答', async () => {
  // 模拟的 claude 和 agy 等 2.5 秒才回复，codex 马上回复
  process.env.MOCK_DELAY = '2500';
  try {
    await c.post('/api/new');
    const r = await c.post('/api/send', { text: '用一句话解释量子纠缠', mode: 'independent', rounds: 1 });
    assert.strictEqual(r.status, 200);
    // 一发出去三位就一起开始回答，后面没有排队的发言。模拟的 codex 不会等，有可能这时已经答完了
    const start = (await c.get('/api/state')).json;
    const typing = start.state.typing.map((t) => t.speaker);
    assert.deepStrictEqual([...typing, ...aiMessages(start).map((m) => m.speaker)].sort(), ALL, '三位要么正在回答，要么已经答完');
    assert.ok(typing.includes('claude') && typing.includes('gemini'), `Claude 和 Gemini 这时都应该在回答：${typing}`);
    assert.deepStrictEqual({ busy: start.state.busy, queued: start.state.queued }, { busy: true, queued: 0 });
    // 排在最后的 GPT 先答完了，这时排在前面的 Claude 和 Gemini 还在回答：说明不是一个一个轮着来的
    const mid = await waitFor(
      async () => {
        const s = (await c.get('/api/state')).json;
        return aiMessages(s).length > 0 && s;
      },
      { timeout: 10000, interval: 50, label: 'the first answer to arrive' }
    );
    assert.deepStrictEqual(aiMessages(mid).map((m) => m.speaker), ['gpt']);
    assert.deepStrictEqual(mid.state.typing.map((t) => t.speaker).sort(), ['claude', 'gemini']);

    const s = await waitIdle(c);
    const ai = aiMessages(s);
    assert.deepStrictEqual(ai.map((m) => m.speaker).sort(), ALL);
    for (const m of ai) assert.strictEqual(blocksOf(m), 1, `${m.speaker} 不应该看到别人这一轮的回答`);
    assert.deepStrictEqual(s.state, { busy: false, queued: 0, typing: [] });
  } finally {
    delete process.env.MOCK_DELAY;
  }
});

test('各自回答两轮：每一轮都是大家一起回答，第二轮只看得到自己上一轮说的', async () => {
  // 模拟的 claude 和 agy 等 2 秒才回复，codex 马上回复
  process.env.MOCK_DELAY = '2000';
  try {
    await c.post('/api/new');
    await c.post('/api/send', { text: '各自说两轮', mode: 'independent', rounds: 2 });
    // 第二轮也是一起回答：第一轮三位都说完之后，第二轮最先到的是 GPT，这时 Claude 和 Gemini 还在回答
    const mid = await waitFor(
      async () => {
        const s = (await c.get('/api/state')).json;
        return aiMessages(s).length > 3 && s;
      },
      { timeout: 15000, interval: 50, label: 'the first answer of round two' }
    );
    assert.deepStrictEqual(aiMessages(mid).slice(3).map((m) => m.speaker), ['gpt']);
    assert.deepStrictEqual(mid.state.typing.map((t) => t.speaker).sort(), ['claude', 'gemini']);

    const s = await waitIdle(c);
    const ai = aiMessages(s);
    assert.strictEqual(ai.length, 6);
    assert.deepStrictEqual(ai.slice(0, 3).map((m) => m.speaker).sort(), ALL, '第一轮三位都说完，才开始第二轮');
    assert.deepStrictEqual(ai.slice(3).map((m) => m.speaker).sort(), ALL);
    assert.deepStrictEqual(ai.map(blocksOf), [1, 1, 1, 2, 2, 2]);
  } finally {
    delete process.env.MOCK_DELAY;
  }
});

test('大家同时回答时有人出错：其他人照常回答，界面马上知道排队的次数变了', async () => {
  // Gemini 一上来就出错，Claude 等 1.5 秒才回复
  process.env.MOCK_AGY_SILENT = '1';
  process.env.MOCK_DELAY = '1500';
  const feed = listen(app.port);
  try {
    await waitFor(() => feed.events.length, { timeout: 5000, interval: 20, label: 'the event stream to open' });
    await c.post('/api/new');
    await c.post('/api/send', { text: '各自说两轮，其中一位出错', mode: 'independent', rounds: 2 });
    // 界面靠 state 事件知道“后面还有几次发言在排队”。Gemini 第二轮的发言去掉之后（3 次变 2 次），
    // 不用等 Claude 说完就要收到新的数字
    const n = await waitFor(() => feed.events.findIndex((e) => e.event === 'state' && e.data.queued === 2) + 1, {
      timeout: 10000,
      interval: 20,
      label: 'a state event with two replies queued',
    });
    const sofar = feed.events.slice(0, n);
    assert.ok(sofar[n - 1].data.typing.some((t) => t.speaker === 'claude'), '这时 Claude 还在回答');
    assert.ok(!sofar.some((e) => e.event === 'msg' && e.data.speaker === 'claude'));

    const s = await waitIdle(c, 15000);
    const errors = s.messages.filter((m) => m.speaker === 'system');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].text.includes('Gemini 发言失败') && errors[0].text.includes('这一轮 Gemini 后面的发言先跳过'), errors[0].text);
    const ai = aiMessages(s);
    assert.deepStrictEqual(ai.slice(0, 2).map((m) => m.speaker).sort(), ['claude', 'gpt']);
    assert.deepStrictEqual(ai.slice(2).map((m) => m.speaker).sort(), ['claude', 'gpt'], '第二轮只剩 Claude 和 GPT');
    assert.deepStrictEqual(ai.map(blocksOf), [1, 1, 2, 2]);
  } finally {
    feed.close();
    delete process.env.MOCK_AGY_SILENT;
    delete process.env.MOCK_DELAY;
  }
});

test('停止：大家同时回答时，一次停掉所有还在回答的成员', async () => {
  process.env.MOCK_DELAY = '3000';
  try {
    await c.post('/api/new');
    await c.post('/api/send', { text: '各自说说，说两轮', mode: 'independent', rounds: 2 });
    // 等 GPT 先答完（模拟的 codex 不会等），这时 Claude 和 Gemini 还在回答，第二轮在排队
    await waitFor(async () => aiMessages((await c.get('/api/state')).json).length === 1, { timeout: 10000, interval: 50, label: 'the first answer to arrive' });
    assert.deepStrictEqual(await typingNow(), ['claude', 'gemini']);
    const r = (await c.post('/api/stop')).json;
    assert.strictEqual(r.stopped, true);
    const s = await waitIdle(c, 10000);
    const notes = s.messages.filter((m) => m.speaker === 'system');
    assert.strictEqual(notes.length, 1, '两位一起停，只说明一次');
    assert.strictEqual(notes[0].text, '已停止 Claude、Gemini 的发言');
    assert.deepStrictEqual(aiMessages(s).map((m) => m.speaker), ['gpt'], '已经答完的留着，没答完的不会出现，第二轮也取消了');
    assert.deepStrictEqual(s.state, { busy: false, queued: 0, typing: [] });
  } finally {
    delete process.env.MOCK_DELAY;
  }
});

test('各自回答时点名两位：按点名的顺序轮流说，后面的人能看到前面的回答', async () => {
  await c.post('/api/new');
  const s = await sendAndWait(c, { text: '@GPT 你先写，@Claude 来改', mode: 'independent', rounds: 2 });
  const ai = aiMessages(s);
  assert.deepStrictEqual(
    ai.map((m) => m.speaker),
    ['gpt', 'claude']
  );
  assert.strictEqual(blocksOf(ai[0]), 1);
  assert.strictEqual(blocksOf(ai[1]), 2, 'Claude 要能看到 GPT 刚写的内容');

  // 只点一位：还是各自回答，看不到别人在这条消息之后说的话
  const one = await sendAndWait(c, { text: '@Gemini 你也说说', mode: 'independent' });
  const last = aiMessages(one).pop();
  assert.strictEqual(last.speaker, 'gemini');
  assert.strictEqual(blocksOf(last), 4, '前面的 3 条记录 + 这条消息');
});

test('换顺序：自由讨论和辩论每条消息换一个发言顺序，合作模式按排好的顺序', async () => {
  await c.post('/api/config', { shuffleOrder: true });
  try {
    await c.post('/api/new');
    let seen = 0;
    let prevFirst = null;
    const orders = [];
    for (let i = 0; i < 4; i++) {
      const s = await sendAndWait(c, { text: `第 ${i + 1} 个话题`, mode: i % 2 ? 'debate' : 'discuss', rounds: 2 });
      const ai = aiMessages(s).slice(seen);
      seen += ai.length;
      const order = ai.slice(0, 3).map((m) => m.speaker);
      assert.deepStrictEqual([...order].sort(), ALL, '每一轮三位都说一次');
      assert.deepStrictEqual(ai.slice(3).map((m) => m.speaker), order, '同一条消息的第二轮顺序不变');
      assert.notStrictEqual(order[0], prevFirst, '不会连着两条消息都由同一位先说');
      prevFirst = order[0];
      orders.push(order.join(' '));
    }
    // 还是轮流说：后面的人能看到前面所有人的发言
    const all = (await c.get('/api/state')).json.messages.filter((m) => m.speaker !== 'system');
    all.forEach((m, i) => {
      if (m.speaker !== 'user') assert.strictEqual(blocksOf(m), i, `第 ${i + 1} 条消息应该看得到前面的 ${i} 条`);
    });

    // 继续聊：刚说完话的那位不会紧接着再说
    for (let i = 0; i < 3; i++) {
      const before = (await c.get('/api/state')).json.messages;
      await c.post('/api/continue', { mode: 'discuss', rounds: 1 });
      const s = await waitIdle(c);
      const added = s.messages.slice(before.length).map((m) => m.speaker);
      assert.deepStrictEqual([...added].sort(), ALL);
      assert.notStrictEqual(added[0], before[before.length - 1].speaker, `刚说完的又先说了：${added}`);
    }

    // 合作模式要在前面的人的成果上接着做，所以不换顺序
    for (let i = 0; i < 2; i++) {
      const s = await sendAndWait(c, { text: `一起写点东西 ${i}`, mode: 'collab' });
      assert.deepStrictEqual(aiMessages(s).slice(-3).map((m) => m.speaker), ALL);
    }
    console.log('shuffled orders:', orders.join(' | '));
  } finally {
    await c.post('/api/config', { shuffleOrder: false });
  }
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
  assert.strictEqual(by('claude').meta.tokens, 170, 'Claude Code：输入（含写进缓存的）+ 输出；读缓存的部分不算进合计');
  assert.strictEqual(by('gpt').meta.tokens, 1234, 'Codex 输出里的 tokens used');
  assert.ok(by('gemini').meta.tokens > 0 && by('gemini').meta.tokensEstimated, 'agy 不报用量，按字数估算');
  const m = Object.fromEntries(s.members.map((x) => [x.id, x]));
  assert.deepStrictEqual(m.claude.usage.h5, { input: 120, output: 50, total: 170, cached: 1000, calls: 1, estimated: false });
  assert.strictEqual(m.gpt.usage.day.total, 1234);
  assert.ok(m.gemini.usage.week.estimated);
  await c.post('/api/usage/reset', { member: 'claude' });
  const after = await memberOf('claude');
  assert.strictEqual(after.usage.week.calls, 0);
});

test('用量：Claude Code 内部多次调用的合计、Codex 在别的语言系统上的写法、接口里走缓存的部分', async () => {
  await c.post('/api/new');
  // modelUsage 是所有模型调用的合计（主对话 120 + 50，加一次内部的辅助调用 7 + 3）
  let s = await withEnv({ MOCK_CLAUDE_MODEL_USAGE: '1' }, () => sendAndWait(c, { text: '@Claude 你好' }));
  assert.strictEqual(aiMessages(s).pop().meta.tokens, 180);
  // 德语系统上 codex 把 1234 写成 1.234
  s = await withEnv({ MOCK_CODEX_LOCALE: 'de' }, () => sendAndWait(c, { text: '@GPT 你好' }));
  assert.strictEqual(aiMessages(s).pop().meta.tokens, 1234);
  // 回复的最后一行正好是 “tokens used”：真正的那两行在它后面，照样读得出来
  s = await withEnv({ MOCK_CODEX_REPLY: 'footer' }, () => sendAndWait(c, { text: '@GPT 你好' }));
  const footer = aiMessages(s).pop();
  assert.ok(footer.text.endsWith('tokens used'), footer.text);
  assert.deepStrictEqual([footer.meta.tokens, footer.meta.tokensEstimated], [1234, false]);

  await c.post('/api/config', {
    members: { gpt: { provider: 'github-models' }, gemini: { provider: 'gemini-api', 'gemini-api': { apiKey: 'good-key', baseUrl: `http://127.0.0.1:${api.port}` } } },
  });
  try {
    const tokens = (st, who) => aiMessages(st).filter((x) => x.speaker === who).pop().meta.tokens;
    s = await sendAndWait(c, { text: '@GPT @Gemini 你好' });
    assert.strictEqual(tokens(s, 'gpt'), 340, 'prompt_tokens + completion_tokens');
    assert.strictEqual(tokens(s, 'gemini'), 250, '输入 + 输出 + 思考');
    await c.post('/api/usage/reset', {});
    api.setMode('cached');
    s = await sendAndWait(c, { text: '@GPT @Gemini 再来' });
    assert.strictEqual(tokens(s, 'gpt'), 140, 'prompt_tokens 里走缓存的 200 不算进合计');
    assert.strictEqual(tokens(s, 'gemini'), 100, 'promptTokenCount 里走缓存的 150 不算进合计');
    const m = Object.fromEntries(s.members.map((x) => [x.id, x]));
    assert.deepStrictEqual(m.gpt.usage.h5, { input: 100, output: 40, total: 140, cached: 200, calls: 1, estimated: false });
    assert.deepStrictEqual(m.gemini.usage.h5, { input: 50, output: 50, total: 100, cached: 150, calls: 1, estimated: false });
  } finally {
    api.setMode('ok');
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' }, gemini: { provider: 'agy-cli' } } });
  }
});

test('额度用完：提醒、标出来，其他成员继续；点名会再试，成功就恢复', async () => {
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
    // codex 报的是钟点（try again at 3:05 PM.），只精确到分钟
    assert.ok(near(lim.resetAt, Date.now() + 125 * 60000, 2 * 60000), `读出恢复的钟点：${lim.resetAt}`);
    assert.ok(lim.retryAt > lim.resetAt && lim.retryAt <= lim.resetAt + 60000, '到点后稍等一下再试');
    assert.ok(alerts[0].text.includes('You’ve hit your usage limit'), '提醒里带上工具的原话');
    // 「用量」里显示的也是工具的原话。codex 会把提示词回显出来，聊天内容不能混进去（它还会存进 usage.json）
    assert.ok(lim.message.includes('You’ve hit your usage limit') && lim.message.includes('try again at'), lim.message);
    assert.ok(!lim.message.includes('两轮讨论') && !lim.message.includes('【'), lim.message);

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
    assert.ok(near(m.claude.limited.resetAt, Date.now() + 3 * 3600 * 1000, 2 * 60000), 'Claude 的恢复时间来自 “resets 3:45pm (时区)”');
    assert.strictEqual(m.gemini.limited.resetAt, null, 'agy 这种报错不说什么时候恢复');
    assert.ok(near(m.gemini.limited.retryAt, Date.now() + 3600 * 1000, 60000), '不知道恢复时间：一小时后自动再试');
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
  // GPT 换成 GitHub Models：之前 Codex 的标记不算数，GPT 照常发言，也不会说“额度恢复了”
  await c.post('/api/config', { members: { gpt: { provider: 'github-models' } } });
  try {
    assert.strictEqual(await limitedOf('gpt'), null);
    const before = (await c.get('/api/state')).json.messages.length;
    const st = await sendAndWait(c, { text: '@GPT 换了接入方式' });
    assert.deepStrictEqual(st.messages.slice(before).map((x) => x.speaker), ['user', 'gpt']);
  } finally {
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
  // 换回 Codex：那个账号的额度还没恢复，标记还在
  assert.strictEqual((await limitedOf('gpt')).provider, 'codex-cli');
  // “再试一次”：手动清掉标记；连接测试成功也会清掉
  const r = (await c.post('/api/usage/retry', { member: 'claude' })).json;
  assert.strictEqual(r.members.find((x) => x.id === 'claude').limited, null);
  assert.ok((await c.post('/api/test/gemini')).json.ok);
  await c.post('/api/usage/retry', { member: 'gpt' });
  const s = await sendAndWait(c, { text: '都回来了吗' });
  assert.deepStrictEqual(aiMessages(s).slice(-3).map((x) => x.speaker).sort(), ['claude', 'gemini', 'gpt']);
});

test('额度用完：Claude Code 几个版本的写法都认得出来', async () => {
  // 现在的写法（You've hit your session limit · resets 3:45pm (时区)）、旧版的 “|时间戳”、
  // 没有 result 只有 api_error 的、不报错而是把那句话当成回复的
  for (const [variant, hasTime] of [['1', true], ['legacy', true], ['bare', false], ['reply', true]]) {
    await c.post('/api/new');
    const s = await withEnv({ MOCK_CLAUDE_LIMIT: variant }, () => sendAndWait(c, { text: '@Claude 你好' }));
    try {
      assert.strictEqual(s.messages.filter((x) => x.alert === 'limit').length, 1, variant);
      assert.strictEqual(aiMessages(s).length, 0, `${variant}：那句话不应该当成 Claude 的发言`);
      const lim = s.members.find((x) => x.id === 'claude').limited;
      assert.strictEqual(lim && lim.provider, 'claude-cli', variant);
      if (hasTime) assert.ok(near(lim.resetAt, Date.now() + 3 * 3600 * 1000, 2 * 60000), `${variant}: ${lim.resetAt}`);
      else assert.strictEqual(lim.resetAt, null, variant);
    } finally {
      await c.post('/api/usage/retry', { member: 'claude' });
    }
  }
});

test('额度用完：Antigravity CLI 的几种报错都认得出来', async () => {
  const run = async (variant) => {
    await c.post('/api/new');
    const s = await withEnv({ MOCK_AGY_LIMIT: variant }, () => sendAndWait(c, { text: '@Gemini 你好' }));
    await c.post('/api/usage/retry', { member: 'gemini' });
    assert.strictEqual(s.messages.filter((x) => x.alert === 'limit').length, 1, variant);
    return s.members.find((x) => x.id === 'gemini').limited;
  };
  // ⚠ Individual quota reached. … Resets in 2h57m45s.
  let lim = await run('resets');
  assert.ok(near(lim.resetAt, Date.now() + (2 * 3600 + 57 * 60 + 45) * 1000, 30000), `读出 “Resets in 2h57m45s.”：${lim.resetAt}`);
  // 旧版本没有 AGY_ERROR 那一行；有时候退出码是 0、原因只在 stderr 上
  for (const variant of ['old', 'quiet']) {
    lim = await run(variant);
    assert.strictEqual(lim.provider, 'agy-cli', variant);
    assert.strictEqual(lim.resetAt, null, variant);
  }
});

test('和额度无关的失败不会被当成额度用完，哪怕大家正好在聊额度', async () => {
  const words = 'You’ve hit your usage limit. 这句话是什么意思？quota exceeded、rate limit reached、usage limit reached 又是什么？';
  await c.post('/api/new');
  // Codex 断网（它会把提示词原样回显出来）、Claude 的服务器繁忙（也是 429）、agy 报 503
  let s = await withEnv({ MOCK_CODEX_FAIL: '1', MOCK_CLAUDE_BUSY: '1', MOCK_AGY_FAIL: '1' }, () => sendAndWait(c, { text: words }));
  assert.strictEqual(s.messages.filter((x) => x.alert === 'limit').length, 0);
  const errors = s.messages.filter((x) => x.speaker === 'system' && x.level === 'error');
  assert.deepStrictEqual(errors.map((x) => x.text.split(' ')[0]), ['Claude', 'Gemini', 'GPT']);
  assert.ok(errors[0].text.includes('不是你的额度用完了'), errors[0].text);
  for (const m of s.members) assert.strictEqual(m.limited, null, m.id);

  // 这个账号的套餐不含 Codex：等多久都没用，不算额度用完，建议换一种接入方式
  s = await withEnv({ MOCK_CODEX_FAIL: 'plan' }, () => sendAndWait(c, { text: '@GPT 你好' }));
  const plan = s.messages[s.messages.length - 1];
  assert.ok(plan.level === 'error' && !plan.alert && plan.text.includes('不包含 Codex') && plan.text.includes('GitHub Models'), plan.text);
  assert.strictEqual(s.members.find((x) => x.id === 'gpt').limited, null);

  // Codex：磁盘配额满了（操作系统的报错里也有 quota）、服务器回 429 但原因是这一次请求太大
  for (const variant of ['disk', 'large']) {
    s = await withEnv({ MOCK_CODEX_FAIL: variant }, () => sendAndWait(c, { text: '@GPT 你好' }));
    const last = s.messages[s.messages.length - 1];
    assert.ok(last.level === 'error' && !last.alert && last.text.includes('GPT 发言失败'), `${variant}: ${last.text}`);
    assert.ok(!last.text.includes('额度暂时用完了'), `${variant}: ${last.text}`);
    assert.strictEqual(s.members.find((x) => x.id === 'gpt').limited, null, variant);
  }
  // agy：消息太大、服务器上这个模型没有容量。状态也是 RESOURCE_EXHAUSTED，但不是这个账号的额度
  for (const variant of ['large', 'capacity']) {
    s = await withEnv({ MOCK_AGY_FAIL: variant }, () => sendAndWait(c, { text: '@Gemini 你好' }));
    const last = s.messages[s.messages.length - 1];
    assert.ok(last.level === 'error' && !last.alert && last.text.includes('Gemini 发言失败'), `${variant}: ${last.text}`);
    assert.ok(!last.text.includes('额度暂时用完了'), `${variant}: ${last.text}`);
    assert.strictEqual(s.members.find((x) => x.id === 'gemini').limited, null, variant);
  }

  // 接口用 429 报“这一次请求太大”：也不是额度用完。报错很长（模型名字长）时也一样
  await c.post('/api/config', { members: { gpt: { provider: 'github-models' } } });
  try {
    for (const mode of ['429-large', '429-large-long']) {
      api.setMode(mode);
      s = await sendAndWait(c, { text: '@GPT 你好' });
      const last = s.messages[s.messages.length - 1];
      assert.ok(last.level === 'error' && !last.alert && last.text.includes('聊天记录太长'), `${mode}: ${last.text}`);
      assert.strictEqual(s.members.find((x) => x.id === 'gpt').limited, null, mode);
    }
  } finally {
    api.setMode('ok');
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
});

test('Codex 失败又没说原因时，不从它开头那段信息里猜原因', async () => {
  // 开头那段信息里有 “reasoning effort: …” 和 session id：选了思考强度时，以前会被当成“模型不支持这个思考强度”
  await c.post('/api/config', { members: { gpt: { 'codex-cli': { effort: 'low' } } } });
  try {
    await c.post('/api/new');
    const s = await withEnv({ MOCK_CODEX_FAIL: 'empty' }, () => sendAndWait(c, { text: '@GPT 你好' }));
    const last = s.messages[s.messages.length - 1];
    assert.ok(last.level === 'error' && last.text.includes('Codex 没有返回内容'), last.text);
    assert.ok(last.text.includes('codex exec') && !last.text.includes('思考强度') && !last.text.includes('登录'), last.text);
  } finally {
    await c.post('/api/config', { members: { gpt: { 'codex-cli': { effort: '' } } } });
  }
});

test('额度用完（接口）：HTTP 429 标记为额度用完，Retry-After 给出恢复时间；只说请求太多时过几分钟再试', async () => {
  // Codex 自己重试几次后还是 429：也是请求太频繁，5 分钟后再试
  await c.post('/api/new');
  const st = await withEnv({ MOCK_CODEX_LIMIT: '429' }, () => sendAndWait(c, { text: '@GPT 你好' }));
  const busy = st.members.find((x) => x.id === 'gpt').limited;
  assert.ok(busy && busy.resetAt === null && near(busy.retryAt, Date.now() + 5 * 60000, 30000), JSON.stringify(busy));
  await c.post('/api/usage/retry', { member: 'gpt' });

  await c.post('/api/config', { members: { gpt: { provider: 'github-models' } } });
  try {
    api.setMode('429');
    await c.post('/api/new');
    let s = await sendAndWait(c, { text: '@GPT 你好' });
    let gpt = s.members.find((x) => x.id === 'gpt');
    assert.strictEqual(gpt.limited.provider, 'github-models');
    assert.ok(near(gpt.limited.resetAt, Date.now() + 120000, 10000), gpt.limited.resetAt);
    await c.post('/api/usage/retry', { member: 'gpt' });

    // 没有 Retry-After，也没提额度：多半是暂时的，5 分钟后再试（不用等一小时）
    api.setMode('429-bare');
    s = await sendAndWait(c, { text: '@GPT 再来' });
    gpt = s.members.find((x) => x.id === 'gpt');
    assert.strictEqual(gpt.limited.resetAt, null);
    assert.ok(near(gpt.limited.retryAt, Date.now() + 5 * 60000, 30000), gpt.limited.retryAt);
  } finally {
    api.setMode('ok');
    await c.post('/api/usage/retry', { member: 'gpt' });
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
});

test('额度用完（Gemini API）：按天算的额度等到太平洋时间午夜；每分钟的限速按 retryDelay', async () => {
  await c.post('/api/config', { members: { gemini: { provider: 'gemini-api', 'gemini-api': { apiKey: 'good-key', baseUrl: `http://127.0.0.1:${api.port}` } } } });
  try {
    // 返回里的 retryDelay 是 34 秒，但 quotaId 说这是按天算的额度
    api.setMode('gemini-daily');
    await c.post('/api/new');
    let s = await sendAndWait(c, { text: '@Gemini 你好' });
    let lim = s.members.find((x) => x.id === 'gemini').limited;
    assert.strictEqual(lim.provider, 'gemini-api');
    const pacific = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(lim.resetAt));
    assert.strictEqual(pacific, '00:00', '太平洋时间午夜');
    assert.ok(lim.resetAt > Date.now() && lim.resetAt <= Date.now() + 25 * 3600 * 1000, lim.resetAt);
    await c.post('/api/usage/retry', { member: 'gemini' });

    api.setMode('gemini-minute');
    s = await sendAndWait(c, { text: '@Gemini 再来' });
    lim = s.members.find((x) => x.id === 'gemini').limited;
    assert.ok(near(lim.resetAt, Date.now() + 34000, 10000), lim.resetAt);
  } finally {
    api.setMode('ok');
    await c.post('/api/usage/retry', { member: 'gemini' });
    await c.post('/api/config', { members: { gemini: { provider: 'agy-cli' } } });
  }
});

test('额度用完：改了这位成员的接入设置就去掉标记，改别的不动', async () => {
  await c.post('/api/new');
  // “try again later”：没说什么时候恢复
  await withEnv({ MOCK_CODEX_LIMIT: 'later' }, () => sendAndWait(c, { text: '@GPT 你好' }));
  try {
    const lim = await limitedOf('gpt');
    assert.ok(lim && lim.resetAt === null);
    assert.ok(near(lim.retryAt, Date.now() + 3600 * 1000, 60000), '一小时后自动再试');
    // 改语言、改别人的设置、改 GPT 另一种接入方式的设置：标记还在
    await c.post('/api/config', { lang: 'zh', members: { claude: { 'claude-cli': { model: 'opus' } }, gpt: { 'github-models': { model: 'openai/gpt-4o' } } } });
    assert.ok(await limitedOf('gpt'));
    // 改了 Codex 自己的设置（可能换了账号或模型）：去掉标记，下次直接试
    await c.post('/api/config', { members: { gpt: { 'codex-cli': { model: 'gpt-x' } } } });
    assert.strictEqual(await limitedOf('gpt'), null);
  } finally {
    await c.post('/api/usage/retry', { member: 'gpt' });
    await c.post('/api/config', { members: { claude: { 'claude-cli': { model: '' } }, gpt: { 'codex-cli': { model: '' }, 'github-models': { model: 'openai/gpt-4.1' } } } });
  }
});

test('额度用完：协作模式里负责总结的人用完了，改由最后一位发言的人总结', async () => {
  await c.post('/api/new');
  // 两轮：Claude、Gemini、GPT、Claude、Gemini、GPT（总结）。GPT 第一轮就用完了
  const s = await withEnv({ MOCK_CODEX_LIMIT: '1' }, () => sendAndWait(c, { text: '一起写个方案', mode: 'collab', rounds: 2 }));
  try {
    const ai = aiMessages(s);
    assert.deepStrictEqual(ai.map((x) => x.speaker), ['claude', 'gemini', 'claude', 'gemini']);
    assert.strictEqual(parseInfo(ai[1].text, 'MOCK-AGY').final, undefined);
    assert.strictEqual(parseInfo(ai[2].text, 'MOCK-CLAUDE').final, undefined);
    assert.strictEqual(parseInfo(ai[3].text, 'MOCK-AGY').final, true, '最后发言的 Gemini 应该收到“请总结”');
  } finally {
    await c.post('/api/usage/retry', { member: 'gpt' });
  }
});

test('额度用完：负责总结的人正好在总结那一次用完了，请刚发过言的最后一位补一次总结', async () => {
  await c.post('/api/new');
  // 每人只说一轮：Claude、Gemini、GPT（总结）。GPT 一开口就发现额度用完了，这时队列里已经没有别人
  process.env.MOCK_CODEX_LIMIT = '1';
  try {
    let s = await sendAndWait(c, { text: '一起写个方案', mode: 'collab', rounds: 1 });
    const ai = aiMessages(s);
    assert.deepStrictEqual(ai.map((x) => x.speaker), ['claude', 'gemini', 'gemini']);
    assert.strictEqual(parseInfo(ai[1].text, 'MOCK-AGY').final, undefined);
    assert.strictEqual(parseInfo(ai[2].text, 'MOCK-AGY').final, true, 'Gemini 补一次总结');
    assert.strictEqual(s.messages.filter((x) => x.alert === 'limit').length, 1);
    // 只点了 GPT 一个人的名：这一轮没有别人发过言，不会拉别人来说
    const before = s.messages.length;
    s = await sendAndWait(c, { text: '@GPT 你来总结', mode: 'collab' });
    assert.deepStrictEqual(aiMessages({ messages: s.messages.slice(before) }), []);
  } finally {
    delete process.env.MOCK_CODEX_LIMIT;
    await c.post('/api/usage/retry', { member: 'gpt' });
  }
});

test('额度用完：每种接入方式各记各的，换一种又被限了也不会盖掉原来那种的标记', async () => {
  await c.post('/api/new');
  await withEnv({ MOCK_CODEX_LIMIT: '1' }, () => sendAndWait(c, { text: '@GPT 你好' }));
  assert.strictEqual((await limitedOf('gpt')).provider, 'codex-cli');
  await c.post('/api/config', { members: { gpt: { provider: 'github-models' } } });
  try {
    api.setMode('429-bare');
    await sendAndWait(c, { text: '@GPT 换一种接入方式' });
    assert.strictEqual((await limitedOf('gpt')).provider, 'github-models');
    // “再试一次”清掉的是现在用的这种
    await c.post('/api/usage/retry', { member: 'gpt' });
    assert.strictEqual(await limitedOf('gpt'), null);
  } finally {
    api.setMode('ok');
    await c.post('/api/config', { members: { gpt: { provider: 'codex-cli' } } });
  }
  try {
    // 换回 Codex：它的标记还在，恢复时间也还是原来那个
    const lim = await limitedOf('gpt');
    assert.ok(lim && lim.provider === 'codex-cli' && near(lim.resetAt, Date.now() + 125 * 60000, 3 * 60000), JSON.stringify(lim));
  } finally {
    await c.post('/api/usage/retry', { member: 'gpt' });
  }
  assert.strictEqual(await limitedOf('gpt'), null);
});

test('额度用完：发言期间改了这种接入方式的设置，旧设置的“额度用完”不记到新设置头上', async () => {
  await c.post('/api/new');
  process.env.MOCK_CLAUDE_LIMIT = '1';
  process.env.MOCK_DELAY = '1500';
  try {
    // Claude 正在用旧设置发言（要一秒半才出结果），这时用户改了模型
    assert.strictEqual((await c.post('/api/send', { text: '@Claude 你好' })).status, 200);
    await sleep(100);
    await c.post('/api/config', { members: { claude: { 'claude-cli': { model: 'opus' } } } });
    const s = await waitIdle(c);
    const last = s.messages[s.messages.length - 1];
    assert.ok(last.level === 'error' && !last.alert && last.text.includes('Claude 发言失败'), last.text);
    assert.strictEqual(s.members.find((x) => x.id === 'claude').limited, null, '新设置还没试过，不能直接跳过');
    // 连接测试也一样
    const pending = c.post('/api/test/claude');
    await sleep(100);
    await c.post('/api/config', { members: { claude: { 'claude-cli': { model: 'sonnet' } } } });
    const t = (await pending).json;
    assert.ok(!t.ok && !t.limited, JSON.stringify(t));
    assert.strictEqual(await limitedOf('claude'), null);
    // 设置没动时照常标记
    const again = (await c.post('/api/test/claude')).json;
    assert.ok(!again.ok && again.limited);
    assert.strictEqual((await limitedOf('claude')).provider, 'claude-cli');
  } finally {
    delete process.env.MOCK_CLAUDE_LIMIT;
    delete process.env.MOCK_DELAY;
    await c.post('/api/config', { members: { claude: { 'claude-cli': { model: '' } } } });
    await c.post('/api/usage/retry', { member: 'claude' });
  }
});

test('请求内容必须是一个对象：null、数组、数字都回 400，不会让服务出错', async () => {
  const before = (await c.get('/api/config')).json.config;
  for (const p of ['/api/send', '/api/continue', '/api/config', '/api/usage/retry', '/api/usage/reset', '/api/history/open', '/api/test/claude']) {
    for (const body of [null, [], 5, 'x']) {
      const r = await c.post(p, body);
      assert.strictEqual(r.status, 400, `${p} ${JSON.stringify(body)}: ${r.status} ${r.text}`);
    }
  }
  assert.deepStrictEqual((await c.get('/api/config')).json.config, before);
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
    await c.post('/api/usage/retry', { member: 'gpt' });
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
  const raw = (headers, method = 'GET', p = '/api/state', body = '{}') =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: app.port, path: p, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end(method === 'POST' ? body : undefined);
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
  // 成员 id 只认三位成员，对象自带的属性名（constructor、__proto__）不算
  assert.strictEqual((await c.post('/api/test/constructor')).status, 400);
  assert.strictEqual((await c.post('/api/usage/retry', { member: 'constructor' })).status, 400);
  assert.strictEqual((await c.post('/api/usage/reset', { member: '__proto__' })).status, 400);
  assert.strictEqual((await c.post('/api/usage/retry', { member: 'gpt' })).status, 200);
  // 内容必须是一个 JSON 对象：null、数字、数组、没写完的，都按“格式不对”回复（以前 null 会让服务端报出一段内部错误）
  for (const body of ['null', '7', '[]', '"x"', 'true', '{']) {
    for (const p of ['/api/upload', '/api/discard', '/api/send', '/api/stop']) {
      assert.strictEqual(await raw({ Host: `127.0.0.1:${app.port}`, 'Content-Type': 'application/json' }, 'POST', p, body), 400, `${p} ${body}`);
    }
  }
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
