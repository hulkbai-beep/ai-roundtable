'use strict';

// 附件的端到端测试：启动真实的本地服务，上传图片和文档，
// 检查模拟的 claude / agy / codex 和模拟接口各自收到了什么。

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createAppServer } = require('../lib/app-server');
const { startMockApi } = require('./mocks/api');
const { ROOT, MOCKS, IS_WIN, tmpDir, makeBin, makeMockBins, client, sendAndWait, aiMessages, parseInfo } = require('./helpers');
const { fixture, PNG, JPG, makeZip } = require('./files');

let app;
let api;
let c;
let dataDir;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const attachDir = () => path.join(dataDir, 'workspace', 'attachments');

async function upload(name, buf, on = c) {
  const r = await on.post('/api/upload', { name, data: b64(buf) });
  assert.strictEqual(r.status, 200, r.text);
  return r.json.attachment;
}

// 取回一个文件的原始内容（helpers 里的 request 会把内容当文字解码）
function getRaw(p, port = app.port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

const last = (s, who) => aiMessages(s).filter((m) => m.speaker === who).pop();
const userMessages = (s) => s.messages.filter((m) => m.speaker === 'user');
const setMembers = (members) => c.post('/api/config', { members });
const SCAN = fixture('scan.pdf');
const DOCX = fixture('report.docx');

before(async () => {
  const bin = makeMockBins(tmpDir('rt-bin-'));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  api = await startMockApi();
  dataDir = tmpDir('rt-data-');
  app = createAppServer({ dataDir, publicDir: path.join(ROOT, 'public') });
  await app.listen(0);
  c = client(app.port);
  // 默认每条消息会换一个发言顺序；这里关掉，下面的测试按固定的顺序检查（换顺序的测试在 e2e.test.js 里）。
  // 上网搜索默认是打开的；这里也关掉，下面检查的是“只为附件打开了什么”，带附件又能上网的情况单独有一个测试
  const r = await c.post('/api/config', {
    lang: 'zh',
    shuffleOrder: false,
    webSearch: false,
    members: {
      gpt: { 'github-models': { token: 'good-token', baseUrl: `http://127.0.0.1:${api.port}/inference` } },
      gemini: { 'gemini-api': { apiKey: 'good-key', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
  });
  assert.strictEqual(r.status, 200);
});

after(async () => {
  await app.close();
  await api.close();
});

test('上传：图片和文档各得到一条记录，文件能原样取回', async () => {
  const limits = (await c.get('/api/state')).json.limits;
  assert.deepStrictEqual(limits, { fileMB: 15, perMessage: 10 });

  const img = await upload('截图.png', PNG);
  assert.deepStrictEqual(img, { id: img.id, name: '截图.png', kind: 'image', mime: 'image/png', size: PNG.length, file: `${img.id}.png`, chars: 0 });
  const got = await getRaw(`/api/file/${img.file}`);
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(got.body, PNG);
  assert.strictEqual(got.headers['content-type'], 'image/png');
  assert.strictEqual(got.headers['content-disposition'], 'inline');
  assert.strictEqual(got.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(got.headers['content-security-policy'], 'sandbox');
  assert.ok(got.headers['cache-control'].includes('immutable'));

  // 文档：取出的文字有多少字记在 chars 里；取回文件时一律当作下载，不让浏览器直接打开
  const doc = await upload('report.docx', DOCX);
  assert.strictEqual(doc.kind, 'doc');
  assert.strictEqual(doc.file, `${doc.id}.docx`);
  assert.strictEqual(doc.chars, 173);
  const file = await getRaw(`/api/file/${doc.file}`);
  assert.deepStrictEqual(file.body, DOCX);
  assert.strictEqual(file.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(file.headers['content-disposition'], 'attachment');
  assert.strictEqual(file.headers['content-security-policy'], 'sandbox');

  const scan = await upload('scan.pdf', SCAN);
  assert.deepStrictEqual({ kind: scan.kind, chars: scan.chars, pages: scan.pages }, { kind: 'pdf', chars: 0, pages: 1 });
  const pdf = await upload('review.pdf', fixture('review-reportlab.pdf'));
  assert.deepStrictEqual({ kind: pdf.kind, pages: pdf.pages }, { kind: 'doc', pages: 2 });
  assert.strictEqual((await getRaw(`/api/file/${pdf.file}`)).headers['content-disposition'], 'attachment', 'PDF 也不在页面里直接打开');

  // 文件放在 workspace/attachments 下：命令行工具就在 workspace 里运行，能直接打开
  assert.deepStrictEqual(fs.readFileSync(path.join(attachDir(), img.file)), PNG);
  assert.ok(fs.existsSync(path.join(attachDir(), `${doc.id}-text.txt`)));

  // 只认自己起的文件名
  for (const bad of ['nope.png', `${doc.id}-text.txt`, '..%2F..%2Fconfig.json', `${img.id}.jpg`, img.id, '%00', '%E0%A4%A']) {
    const r = await c.get(`/api/file/${bad}`);
    assert.strictEqual(r.status, 404, bad);
    assert.strictEqual(r.json.error, '这个文件已经不在了');
  }
  assert.strictEqual((await c.get(`/api/file/${img.file}/x`)).status, 404);
  for (const a of [img, doc, scan, pdf]) assert.deepStrictEqual((await c.post('/api/discard', { id: a.id })).json, { ok: true, removed: true });
});

test('上传：不支持的、空的、太大的文件都有明确的提示', async () => {
  const fail = async (name, data) => {
    const r = await c.post('/api/upload', { name, data });
    assert.strictEqual(r.status, 400, `${name}: ${r.text}`);
    return r.json;
  };
  const exe = await fail('setup.exe', b64(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300)])));
  assert.strictEqual(exe.error, '「setup.exe」这种文件读不了');
  assert.ok(exe.hint.startsWith('支持的类型：'));
  assert.strictEqual((await fail('资料.zip', b64(makeZip({ 'a.txt': 'x' })))).error, '「资料.zip」是一个压缩包，没法直接读');
  assert.strictEqual((await fail('空.txt', '')).error, '「空.txt」是空的');
  assert.strictEqual((await fail('空白.txt', b64(Buffer.from('  \n')))).error, '「空白.txt」是空的');
  // 文件本身超过 15 MB
  assert.strictEqual((await fail('大文件.txt', b64(Buffer.alloc(15 * 1024 * 1024 + 1, 0x61)))).error, '「大文件.txt」太大了（超过 15 MB）');
  // 整个请求大得多：不等读完就知道超了，但浏览器仍然能收到提示
  assert.strictEqual((await fail('更大.bin', 'A'.repeat(26 * 1024 * 1024))).error, '文件太大了（超过 15 MB）');
  const notJson = await c.post('/api/upload', 'oops');
  assert.strictEqual(notJson.status, 400);
  assert.deepStrictEqual(fs.readdirSync(attachDir()), [], '被拒绝的文件不会留在硬盘上');
  // 服务还活着
  assert.strictEqual((await c.get('/api/ping')).status, 200);
});

test('发送前拿掉的附件会被删掉', async () => {
  const img = await upload('a.jpg', JPG);
  assert.strictEqual(img.mime, 'image/jpeg');
  assert.strictEqual(img.file, `${img.id}.jpg`);
  const doc = await upload('notes.md', Buffer.from('# 标题\n正文'));
  assert.strictEqual(fs.readdirSync(attachDir()).length, 3);
  assert.deepStrictEqual((await c.post('/api/discard', { id: img.id })).json, { ok: true, removed: true });
  assert.deepStrictEqual((await c.post('/api/discard', { id: img.id })).json, { ok: true, removed: false });
  assert.deepStrictEqual((await c.post('/api/discard', { id: '../../config' })).json, { ok: true, removed: false });
  assert.deepStrictEqual((await c.post('/api/discard', {})).json, { ok: true, removed: false });
  assert.strictEqual((await c.get(`/api/file/${img.file}`)).status, 404);
  assert.deepStrictEqual((await c.post('/api/discard', { id: doc.id })).json, { ok: true, removed: true });
  assert.deepStrictEqual(fs.readdirSync(attachDir()), []);
});

test('三位成员都能拿到附件：Claude 用 Read 工具，Codex 用 --image，Antigravity 自己打开', async () => {
  await c.post('/api/new');
  const img = await upload('截图.png', PNG);
  const doc = await upload('report.docx', DOCX);
  const scan = await upload('scan.pdf', SCAN);
  const s = await sendAndWait(c, { text: '看看这三个附件', attachments: [img.id, doc.id, scan.id], rounds: 1 });

  const mine = userMessages(s).pop();
  assert.deepStrictEqual(mine.attachments, [img, doc, scan], '消息里记着附件');
  assert.deepStrictEqual(aiMessages(s).map((m) => m.speaker), ['claude', 'gemini', 'gpt']);
  assert.deepStrictEqual(s.messages.filter((m) => m.speaker === 'system'), [], JSON.stringify(s.messages));
  for (const m of aiMessages(s)) assert.strictEqual(m.meta.note, '', `${m.speaker}: ${m.meta.note}`);

  const imgPath = path.join(attachDir(), img.file);
  const scanPath = path.join(attachDir(), scan.file);
  // 图片和扫描件是文件；Word 文档的文字已经写在提示词里，不用再给文件
  const expected = [
    { n: 1, text: false, path: imgPath, size: PNG.length },
    { n: 3, text: false, path: scanPath, size: SCAN.length },
  ];

  const cl = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
  assert.strictEqual(cl.tools, 'Read', '只打开 Read 这一个工具');
  assert.strictEqual(cl.toolsDisabled, false);
  assert.strictEqual(cl.permissionMode, 'default', '明说用 default 权限模式：读运行目录以外的文件会被拒绝，不跟着用户自己的 Claude Code 设置走');
  assert.strictEqual(cl.filesRule, true, '人设里说明可以查看附件');
  assert.strictEqual(cl.attachments, 3, '三个附件都列在提示词里');
  assert.deepStrictEqual(cl.files, expected, 'Claude 拿到的是完整路径，而且按这个路径读得到文件');
  assert.ok(cl.files.every((f) => path.isAbsolute(f.path)));
  assert.strictEqual(cl.blocks, 1);

  const ag = parseInfo(last(s, 'gemini').text, 'MOCK-AGY');
  assert.deepStrictEqual(ag.files, expected);
  assert.strictEqual(ag.hasSystem, true);

  const cx = parseInfo(last(s, 'gpt').text, 'MOCK-CODEX');
  assert.strictEqual(cx.images.length, 1, '只有图片用 --image 附上');
  assert.deepStrictEqual({ path: cx.images[0].path, size: cx.images[0].size }, { path: `attachments/${img.file}`, size: PNG.length }, '路径相对于运行目录，用正斜杠');
  assert.ok(/^--?[a-z]/.test(cx.images[0].next), `--image 后面必须紧跟另一个参数，不能是代表标准输入的 "-"：${cx.images[0].next}`);
  assert.deepStrictEqual(cx.files, [
    { n: 1, text: false, path: `attachments/${img.file}`, size: PNG.length },
    { n: 3, text: false, path: `attachments/${scan.file}`, size: SCAN.length },
  ]);
  assert.deepStrictEqual({ exec: cx.exec, sandbox: cx.sandbox, stdinDash: cx.stdinDash, hasSystem: cx.hasSystem }, { exec: true, sandbox: 'read-only', stdinDash: true, hasSystem: true });
});

test('附件在后面的发言里一直带着；没有附件的对话和以前一样不开工具', async () => {
  let s = await sendAndWait(c, { text: '@Claude @GPT 再看一眼' });
  const cl = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
  assert.strictEqual(cl.tools, 'Read');
  assert.strictEqual(cl.files.length, 2);
  assert.strictEqual(parseInfo(last(s, 'gpt').text, 'MOCK-CODEX').images.length, 1);

  await c.post('/api/new');
  s = await sendAndWait(c, { text: '@Claude @GPT 这次没有附件' });
  const plain = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
  assert.deepStrictEqual(
    { tools: plain.tools, toolsDisabled: plain.toolsDisabled, files: plain.files, attachments: plain.attachments, filesRule: plain.filesRule },
    { tools: '', toolsDisabled: true, files: undefined, attachments: undefined, filesRule: undefined }
  );
  const cx = parseInfo(last(s, 'gpt').text, 'MOCK-CODEX');
  assert.deepStrictEqual({ images: cx.images, files: cx.files }, { images: undefined, files: undefined });
});

test('各自回答时带附件：三位同时回答，每一位都拿到了附件', async () => {
  await c.post('/api/new');
  const img = await upload('截图.png', PNG);
  const scan = await upload('scan.pdf', SCAN);
  const s = await sendAndWait(c, { text: '各自看看这两个附件', attachments: [img.id, scan.id], mode: 'independent', rounds: 1 });
  assert.deepStrictEqual(aiMessages(s).map((m) => m.speaker).sort(), ['claude', 'gemini', 'gpt']);
  assert.deepStrictEqual(s.messages.filter((m) => m.speaker === 'system'), [], JSON.stringify(s.messages));
  for (const m of aiMessages(s)) assert.strictEqual(m.meta.note, '', `${m.speaker}: ${m.meta.note}`);

  const sizes = [PNG.length, SCAN.length];
  const cl = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
  const ag = parseInfo(last(s, 'gemini').text, 'MOCK-AGY');
  const cx = parseInfo(last(s, 'gpt').text, 'MOCK-CODEX');
  assert.deepStrictEqual(cl.files.map((f) => f.size), sizes, 'Claude');
  assert.deepStrictEqual(ag.files.map((f) => f.size), sizes, 'Antigravity');
  assert.deepStrictEqual(cx.images.map((f) => f.size), [PNG.length], 'Codex 的 --image');
  assert.deepStrictEqual(cx.files.map((f) => f.size), sizes, 'Codex');
  // 同时回答：每一位的聊天记录里只有主持人这一条，看不到别人这一轮的回答
  assert.deepStrictEqual([cl.blocks, ag.blocks, cx.blocks], [1, 1, 1]);
});

test('只发附件不写字也可以；标题、导出和历史记录里都有附件', async () => {
  await c.post('/api/new');
  const empty = await c.post('/api/send', { text: '  ' });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.json.error, '消息不能为空');
  assert.strictEqual((await c.post('/api/send', { text: '', attachments: [] })).json.error, '消息不能为空');
  assert.strictEqual((await c.post('/api/send', { text: '', attachments: 'x' })).json.error, '消息不能为空');

  const img = await upload('旅行照片.jpg', JPG);
  const doc = await upload('行程.csv', Buffer.from('日期,城市\n10-01,杭州\n'));
  let s = await sendAndWait(c, { attachments: [img.id, doc.id], rounds: 1 });
  const mine = userMessages(s).pop();
  assert.strictEqual(mine.text, '');
  assert.deepStrictEqual(mine.attachments.map((a) => a.name), ['旅行照片.jpg', '行程.csv']);
  assert.strictEqual(s.conversation.title, '旅行照片.jpg、行程.csv');
  assert.strictEqual(aiMessages(s).length, 3);
  const cl = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
  assert.deepStrictEqual({ blocks: cl.blocks, attachments: cl.attachments, files: cl.files.length }, { blocks: 1, attachments: 2, files: 1 });

  const md = (await c.get('/api/export')).text;
  assert.ok(md.startsWith('# AI 圆桌：旅行照片.jpg、行程.csv'), md.slice(0, 80));
  assert.ok(md.includes('\n> 附件：旅行照片.jpg、行程.csv\n'), md);

  // 换一个对话再回来：附件还在，文件也还能取到
  await c.post('/api/new');
  const hit = (await c.get('/api/history')).json.items.find((it) => it.title === '旅行照片.jpg、行程.csv');
  assert.ok(hit, '历史记录里用附件的名字当标题');
  await c.post('/api/history/open', { file: hit.file });
  s = (await c.get('/api/state')).json;
  assert.deepStrictEqual(s.messages[0].attachments, [img, doc]);
  assert.deepStrictEqual((await getRaw(`/api/file/${img.file}`)).body, JPG);
  // 已经发出去的附件不能再被“拿掉”
  assert.deepStrictEqual((await c.post('/api/discard', { id: img.id })).json, { ok: true, removed: false });
  assert.strictEqual((await c.get(`/api/file/${img.file}`)).status, 200);
});

test('文件被删掉以后不再发送，并告诉 AI 这次看不到', async () => {
  await c.post('/api/new');
  const img = await upload('会被删掉.png', PNG);
  let s = await sendAndWait(c, { text: '@Claude 看图', attachments: [img.id] });
  assert.strictEqual(parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE').files.length, 1);
  fs.rmSync(path.join(attachDir(), img.file));
  s = await sendAndWait(c, { text: '@Claude @GPT 再看看' });
  const cl = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
  assert.deepStrictEqual({ files: cl.files, tools: cl.tools, attachments: cl.attachments }, { files: undefined, tools: '', attachments: 1 }, '附件还列在提示词里（注明没发），但不再给文件');
  assert.strictEqual(parseInfo(last(s, 'gpt').text, 'MOCK-CODEX').images, undefined);
  assert.strictEqual((await c.get(`/api/file/${img.file}`)).status, 404);
  // 回复上注明是文件不在了（调大字数上限也没用，所以不提设置）
  const note = '附件 1（会被删掉.png） 的文件已经不在了，这次没有带上';
  assert.strictEqual(last(s, 'claude').meta.note, note);
  assert.strictEqual(last(s, 'gpt').meta.note, note);

  // 文档取出来的文字不在了，也是同样的说明，而不是“篇幅不够”
  const doc = await upload('笔记.txt', Buffer.from('一些笔记'));
  fs.rmSync(path.join(attachDir(), `${doc.id}-text.txt`));
  await setMembers({ gpt: { provider: 'github-models' } });
  try {
    s = await sendAndWait(c, { text: '@GPT 还有这个', attachments: [doc.id] });
    assert.strictEqual(last(s, 'gpt').meta.note, '附件 1（会被删掉.png）、附件 2（笔记.txt） 的文件已经不在了，这次没有带上');
    const sent = api.requests[api.requests.length - 1].body.messages.find((m) => m.role === 'user').content;
    assert.strictEqual(typeof sent, 'string');
    assert.ok(sent.includes('<附件 编号="1" 文件名="会被删掉.png" 说明="图片，文件已经不在了，你看不到" />\n\n<附件 编号="2" 文件名="笔记.txt" 说明="文档，保存的内容已经不在了，你看不到" />'), sent);
  } finally {
    await setMembers({ gpt: { provider: 'codex-cli' } });
  }
});

test('太长的文档：命令行工具自己去读完整的文字，HTTP 接口注明只看到了开头', async () => {
  const cfg = (await c.get('/api/config')).json.config.members;
  const claudeMax = cfg.claude['claude-cli'].maxChars;
  const gptMax = cfg.gpt['github-models'].maxChars;
  const text = `开头。${'这是一份很长的文档。'.repeat(Math.ceil(claudeMax / 10))}结尾。`;
  assert.ok(text.length > claudeMax / 2);
  await setMembers({ gpt: { provider: 'github-models' } });
  try {
    await c.post('/api/new');
    const doc = await upload('长文档.txt', Buffer.from(text));
    assert.strictEqual(doc.chars, text.length);
    const s = await sendAndWait(c, { text: '@Claude @GPT 总结一下', attachments: [doc.id] });

    const claude = last(s, 'claude');
    const cl = parseInfo(claude.text, 'MOCK-CLAUDE');
    const textPath = path.join(attachDir(), `${doc.id}-text.txt`);
    assert.deepStrictEqual(cl.files, [{ n: 1, text: true, path: textPath, size: Buffer.byteLength(text) }], 'Claude 拿到完整文字所在的文件');
    assert.strictEqual(cl.tools, 'Read');
    assert.strictEqual(claude.meta.note, '', '能自己读全文的，不用提示');
    assert.strictEqual(fs.readFileSync(textPath, 'utf8'), text);

    const gpt = last(s, 'gpt');
    // 附件这一段（说明 + 文字）最多占一半篇幅
    const shown = Number((/只发了开头 (\d+) 字/.exec(gpt.meta.note) || [])[1]);
    assert.ok(shown > gptMax / 2 - 200 && shown < gptMax / 2, `文档的文字应该接近一半篇幅，实际 ${shown}`);
    assert.strictEqual(gpt.meta.note, `附件 1（长文档.txt） 太长，只发了开头 ${shown} 字，可在设置里调大字数上限`);
    const sent = api.requests[api.requests.length - 1].body.messages.find((m) => m.role === 'user').content;
    assert.strictEqual(typeof sent, 'string', '没有图片时还是普通的文字消息');
    assert.ok(sent.includes(`<附件 编号="1" 文件名="长文档.txt" 说明="文档，共约 ${text.length} 字，下面只有开头的 ${shown} 字">\n${text.slice(0, shown)}\n</附件>`));
    assert.ok(!sent.includes('完整的文字'), 'HTTP 接口读不了文件，不提文件');
    assert.ok(sent.length < gptMax + 300, `提示词应该控制在字数上限以内（另加几句固定的话），实际 ${sent.length}`);
  } finally {
    await setMembers({ gpt: { provider: 'codex-cli' } });
  }
});

test('HTTP 接口：图片和读不出文字的 PDF 放进请求里（GitHub Models、Gemini API）', async () => {
  await setMembers({ gpt: { provider: 'github-models' }, gemini: { provider: 'gemini-api' } });
  try {
    await c.post('/api/new');
    const img = await upload('截图.png', PNG);
    const doc = await upload('report.docx', DOCX);
    const scan = await upload('scan.pdf', SCAN);
    const from = api.requests.length;
    const s = await sendAndWait(c, { text: '@GPT @Gemini 看看', attachments: [img.id, doc.id, scan.id] });
    assert.strictEqual(last(s, 'gpt').meta.note, '');
    assert.strictEqual(last(s, 'gemini').meta.note, '');
    const reqs = api.requests.slice(from);
    assert.strictEqual(reqs.length, 2);

    const openai = reqs.find((r) => r.url === '/inference/chat/completions').body;
    const content = openai.messages.find((m) => m.role === 'user').content;
    assert.deepStrictEqual(content.slice(1), [
      { type: 'text', text: '附件 1（截图.png）：' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64(PNG)}` } },
      { type: 'text', text: '附件 3（scan.pdf）：' },
      { type: 'file', file: { filename: 'scan.pdf', file_data: `data:application/pdf;base64,${b64(SCAN)}` } },
    ]);
    assert.strictEqual(content[0].type, 'text');
    assert.ok(content[0].text.includes('<附件 编号="2" 文件名="report.docx" 说明="文档">\n# 季度总结 Quarterly Review\n'), 'Word 文档的文字在提示词里');
    assert.ok(content[0].text.includes('（附件 1：截图.png；附件 2：report.docx；附件 3：scan.pdf）'));
    assert.ok(!content[0].text.includes('没能发给你'));
    assert.ok(!content[0].text.includes(attachDir()), 'HTTP 接口不需要知道文件在哪');
    assert.strictEqual(openai.messages[0].role, 'system');
    assert.ok(openai.messages[0].content.includes('除了查看主持人发来的附件'));

    const gemini = reqs.find((r) => r.url.includes(':generateContent')).body;
    const parts = gemini.contents[0].parts;
    assert.deepStrictEqual(parts.slice(1), [
      { text: '附件 1（截图.png）：' },
      { inlineData: { mimeType: 'image/png', data: b64(PNG) } },
      { text: '附件 3（scan.pdf）：' },
      { inlineData: { mimeType: 'application/pdf', data: b64(SCAN) } },
    ]);
    assert.ok(parts[0].text.includes('<附件 编号="3" 文件名="scan.pdf" 说明="PDF，取不出文字，多半是扫描件" />'));
  } finally {
    await setMembers({ gpt: { provider: 'codex-cli' }, gemini: { provider: 'agy-cli' } });
  }
});

test('HTTP 接口不接受图片时：去掉文件重试，告诉 AI 它看不到，并在回复上注明', async () => {
  await setMembers({ gpt: { provider: 'github-models' }, gemini: { provider: 'gemini-api' } });
  api.setMode('no-vision');
  try {
    await c.post('/api/new');
    const img = await upload('截图.png', PNG);
    const scan = await upload('scan.pdf', SCAN);
    const from = api.requests.length;
    const s = await sendAndWait(c, { text: '@GPT @Gemini 图里是什么', attachments: [img.id, scan.id] });
    const note = '附件 1（截图.png）、附件 2（scan.pdf） 没能发过去：带上以后请求被对方拒绝了（对方的说明：';
    assert.strictEqual(last(s, 'gpt').meta.note, `${note}Invalid content type. image_url is only supported by certain models.）`);
    assert.strictEqual(last(s, 'gemini').meta.note, `${note}Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting）`);
    assert.deepStrictEqual(s.messages.filter((m) => m.speaker === 'system'), [], '不算出错');

    // 每家三次请求：全带上 → 只带图片 → 什么文件都不带
    const reqs = api.requests.slice(from);
    assert.strictEqual(reqs.length, 6);
    const userOf = (r) => r.body.messages.find((m) => m.role === 'user').content;
    assert.deepStrictEqual(userOf(reqs[0]).map((p) => p.type), ['text', 'text', 'image_url', 'text', 'file']);
    assert.deepStrictEqual(userOf(reqs[1]).map((p) => p.type), ['text', 'text', 'image_url']);
    assert.ok(userOf(reqs[1])[0].text.endsWith('（注意：附件 2（scan.pdf） 的文件没能发给你，你看不到里面的内容。需要看了才能回答的话，请直接说明你看不到。）'));
    const warning = '（注意：附件 1（截图.png）、附件 2（scan.pdf） 的文件没能发给你，你看不到里面的内容。需要看了才能回答的话，请直接说明你看不到。）';
    const retry = userOf(reqs[2]);
    assert.strictEqual(typeof retry, 'string');
    assert.ok(retry.endsWith(warning), retry.slice(-200));
    assert.deepStrictEqual(reqs.slice(3).map((r) => r.body.contents[0].parts.length), [5, 3, 1]);
    assert.ok(reqs[5].body.contents[0].parts[0].text.endsWith(warning));
  } finally {
    api.setMode('ok');
    await setMembers({ gpt: { provider: 'codex-cli' }, gemini: { provider: 'agy-cli' } });
  }
});

test('带上文件后请求太大、接口报 429 时：去掉文件重试，不会被当成额度用完', async () => {
  await setMembers({ gpt: { provider: 'github-models' }, gemini: { provider: 'gemini-api' } });
  api.setMode('files-429');
  try {
    await c.post('/api/new');
    const img = await upload('大图.png', PNG);
    const from = api.requests.length;
    let s = await sendAndWait(c, { text: '@GPT @Gemini 看图', attachments: [img.id] });
    assert.deepStrictEqual(s.messages.filter((m) => m.speaker === 'system'), [], JSON.stringify(s.messages.filter((m) => m.speaker === 'system')));
    const note = '附件 1（大图.png） 没能发过去：带上以后请求被对方拒绝了（对方的说明：';
    assert.strictEqual(last(s, 'gpt').meta.note, `${note}Request too large for this model on tokens per min (TPM): Limit 30000, Requested 45210.）`);
    assert.strictEqual(last(s, 'gemini').meta.note, `${note}Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 250000.）`);
    assert.strictEqual(api.requests.length - from, 4);
    assert.deepStrictEqual(s.members.map((m) => m.limited), [null, null, null], '没有人被标成“额度用完”');
    // 真的额度用完（不带文件也是 429）时，照样按额度用完处理
    api.setMode('429');
    s = await sendAndWait(c, { text: '@GPT 再来' });
    const gpt = s.members.find((m) => m.id === 'gpt');
    assert.ok(gpt.limited, '这次是真的额度用完');
    assert.strictEqual(s.messages[s.messages.length - 1].speaker, 'system');
    // 测试连接成功后恢复，不影响后面的测试
    api.setMode('ok');
    assert.ok((await c.post('/api/test/gpt')).json.ok);
    assert.strictEqual((await c.get('/api/state')).json.members.find((m) => m.id === 'gpt').limited, null);
  } finally {
    api.setMode('ok');
    await setMembers({ gpt: { provider: 'codex-cli' }, gemini: { provider: 'agy-cli' } });
  }
});

test('接口只是不收 PDF 时：图片照样发过去，只注明 PDF 没发', async () => {
  await setMembers({ gpt: { provider: 'github-models' }, gemini: { provider: 'gemini-api' } });
  api.setMode('no-pdf');
  try {
    await c.post('/api/new');
    const img = await upload('照片.png', PNG);
    let from = api.requests.length;
    let s = await sendAndWait(c, { text: '@GPT 看图', attachments: [img.id] });
    assert.strictEqual(last(s, 'gpt').meta.note, '');
    assert.strictEqual(api.requests.length - from, 1, '只有图片时一次就成');

    const scan = await upload('合同扫描件.pdf', SCAN);
    const userOf = (r) => r.body.messages.find((m) => m.role === 'user').content;
    const warning = '（注意：附件 2（合同扫描件.pdf） 的文件没能发给你，你看不到里面的内容。需要看了才能回答的话，请直接说明你看不到。）';
    // 后面每一轮都一样：先全带上，被拒绝后去掉 PDF，图片还在
    for (const [text, attachments] of [['@GPT @Gemini 再看看这份合同', [scan.id]], ['@GPT @Gemini 图里那个人是谁', []]]) {
      from = api.requests.length;
      s = await sendAndWait(c, { text, attachments });
      assert.deepStrictEqual(s.messages.filter((m) => m.speaker === 'system'), []);
      const note = '附件 2（合同扫描件.pdf） 没能发过去：带上以后请求被对方拒绝了（对方的说明：';
      assert.strictEqual(last(s, 'gpt').meta.note, `${note}Invalid value: 'file'. Supported values are: 'text' and 'image_url'.）`);
      assert.strictEqual(last(s, 'gemini').meta.note, `${note}The document has no pages.）`);
      const reqs = api.requests.slice(from);
      assert.strictEqual(reqs.length, 4);
      assert.deepStrictEqual(userOf(reqs[0]).map((p) => p.type), ['text', 'text', 'image_url', 'text', 'file']);
      assert.deepStrictEqual(userOf(reqs[1]).slice(1), [
        { type: 'text', text: '附件 1（照片.png）：' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64(PNG)}` } },
      ]);
      assert.ok(userOf(reqs[1])[0].text.endsWith(warning));
      const parts = reqs[3].body.contents[0].parts;
      assert.deepStrictEqual(parts.slice(1), [{ text: '附件 1（照片.png）：' }, { inlineData: { mimeType: 'image/png', data: b64(PNG) } }]);
      assert.ok(parts[0].text.endsWith(warning));
    }
  } finally {
    api.setMode('ok');
    await setMembers({ gpt: { provider: 'codex-cli' }, gemini: { provider: 'agy-cli' } });
  }
});

test('接口的几种退让互不妨碍：不管对方先报哪个错，都能一步步退到能用为止', async () => {
  await setMembers({
    gpt: { provider: 'github-models', 'github-models': { effort: 'high' } },
    gemini: { provider: 'gemini-api', 'gemini-api': { model: 'gemini-flash-lite-latest', effort: 'low' } },
  });
  try {
    await c.post('/api/new');
    const img = await upload('图.png', PNG);
    // 对方先检查内容（不收图片），再检查参数（不认思考强度）
    api.setMode('files-first');
    let from = api.requests.length;
    let s = await sendAndWait(c, { text: '@GPT @Gemini 看图', attachments: [img.id] });
    assert.deepStrictEqual(s.messages.filter((m) => m.speaker === 'system'), [], JSON.stringify(s.messages.filter((m) => m.speaker === 'system')));
    const gpt = last(s, 'gpt');
    assert.ok(gpt.meta.note.startsWith('这个模型不支持选择思考强度，已用默认；附件 1（图.png） 没能发过去：'), gpt.meta.note);
    assert.strictEqual(parseInfo(gpt.text, 'MOCK-GPT').effort, undefined);
    assert.ok(last(s, 'gemini').meta.note.startsWith('这个模型不支持选择思考强度，已用默认；附件 1（图.png） 没能发过去：'), last(s, 'gemini').meta.note);
    assert.strictEqual(api.requests.length - from, 6, '每家三次：原样 → 去掉图片 → 再去掉思考强度');

    // 用 404 表示“没有能看图的模型”的接口（例如 OpenRouter）：同样去掉文件重试
    api.setMode('no-vision-404');
    await setMembers({ gpt: { 'github-models': { effort: '' } } });
    from = api.requests.length;
    s = await sendAndWait(c, { text: '@GPT 再看' });
    assert.strictEqual(last(s, 'gpt').meta.note, '附件 1（图.png） 没能发过去：带上以后请求被对方拒绝了（对方的说明：No endpoints found that support image input）');
    assert.strictEqual(api.requests.length - from, 2);

    // 报错的文字里正好有 system 和 messages：先试了“合并 system 消息”，发现没用就改回去，再去掉文件
    api.setMode('no-vision-system');
    from = api.requests.length;
    s = await sendAndWait(c, { text: '@GPT 第三次' });
    const reqs = api.requests.slice(from);
    assert.deepStrictEqual(
      reqs.map((r) => r.body.messages.map((m) => `${m.role}:${Array.isArray(m.content) ? 'files' : 'text'}`).join(',')),
      ['system:text,user:files', 'user:files', 'system:text,user:text']
    );
    assert.strictEqual(parseInfo(last(s, 'gpt').text, 'MOCK-GPT').system, true, '最后成功的请求里，人设还是单独的 system 消息');
  } finally {
    api.setMode('ok');
    await setMembers({
      gpt: { provider: 'codex-cli', 'github-models': { effort: '' } },
      gemini: { provider: 'agy-cli', 'gemini-api': { model: 'gemini-flash-latest', effort: '' } },
    });
  }
});

test('附件很多的长对话：提示词仍然控制在字数上限以内，较早的附件不再带上并注明', async () => {
  const cfg = (await c.get('/api/config')).json.config.members;
  const gptMax = cfg.gpt['github-models'].maxChars;
  const agyMax = cfg.gemini['agy-cli'].maxChars;
  await setMembers({ gpt: { provider: 'github-models' } });
  try {
    await c.post('/api/new');
    let s;
    for (let batch = 0; batch < 5; batch++) {
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const k = batch * 10 + i + 1;
        const att = k % 2 ? await upload(`第 ${k} 号 会议记录（讨论稿）.txt`, Buffer.from(`第 ${k} 份记录。${'要点很多。'.repeat(400)}`)) : await upload(`第 ${k} 号 现场照片.png`, PNG);
        ids.push(att.id);
      }
      s = await sendAndWait(c, { text: `@GPT @Gemini 第 ${batch + 1} 批材料`, attachments: ids });
      assert.deepStrictEqual(s.messages.filter((m) => m.speaker === 'system'), [], `第 ${batch + 1} 批：${JSON.stringify(s.messages.filter((m) => m.speaker === 'system'))}`);
    }
    // GitHub Models：一共只带 5000 字
    const sent = api.requests[api.requests.length - 1].body.messages.find((m) => m.role === 'user').content;
    const text = sent[0].text;
    assert.ok(text.length < gptMax + 300, `GPT 的提示词 ${text.length} 字，上限 ${gptMax}`);
    const images = sent.filter((p) => p.type === 'image_url').length;
    assert.ok(images >= 4 && images <= 8, `带了 ${images} 张图片`);
    assert.strictEqual(images, (text.match(/说明="图片" \/>/g) || []).length, '只带列出来的附件里的图片');
    const hidden = Number((/另外 (\d+) 个较早的这次没有列出/.exec(text) || [])[1]);
    assert.ok(hidden >= 35 && hidden < 45, `hidden = ${hidden}`);
    const note = last(s, 'gpt').meta.note;
    assert.ok(/^附件 \d+（第 \d+ 号 会议记录（讨论稿）.txt） 太长，只发了开头 \d+ 字；附件 \d+（[^）]+）.txt）、附件 \d+（[^）]+）.txt）、附件 \d+（[^）]+）.txt） 等 \d+ 个附件 的内容没带上（篇幅不够）；另外 \d+ 个较早的附件没有带上，可在设置里调大字数上限$/.test(note), note);
    assert.ok(note.includes(`另外 ${hidden} 个较早的附件没有带上`));
    assert.ok(note.length < 300, `说明不要太长：${note.length}`);

    // Antigravity：整个命令行参数（人设 + 聊天记录 + 文件位置）离 Windows 的上限还远
    const gemini = parseInfo(last(s, 'gemini').text, 'MOCK-AGY');
    assert.ok(gemini.chars < agyMax + 2500, `agy 收到 ${gemini.chars} 字，上限 ${agyMax}`);
    assert.strictEqual(gemini.files.filter((f) => !f.text).length, 8);
    assert.strictEqual(gemini.files.filter((f) => f.text).length, 8);
    assert.ok(/ 等 \d+ 个附件 的内容没带上（篇幅不够），可在设置里调大字数上限$/.test(last(s, 'gemini').meta.note), `列不下的“完整文字”文件，和读不了文件的接入方式一样注明：${last(s, 'gemini').meta.note}`);
  } finally {
    await setMembers({ gpt: { provider: 'codex-cli' } });
  }
});

test('Claude Code 没有权限打开附件时，在回复上注明', async () => {
  process.env.MOCK_CLAUDE_DENY = '1';
  try {
    await c.post('/api/new');
    const img = await upload('截图.png', PNG);
    let s = await sendAndWait(c, { text: '@Claude 看图', attachments: [img.id] });
    assert.strictEqual(last(s, 'claude').text, '我打不开这些文件。');
    assert.strictEqual(last(s, 'claude').meta.note, 'Claude Code 没有权限打开附件');
    // 没有附件的对话里，同样的情况不用提
    await c.post('/api/new');
    s = await sendAndWait(c, { text: '@Claude 你好' });
    assert.strictEqual(last(s, 'claude').meta.note, '');
  } finally {
    delete process.env.MOCK_CLAUDE_DENY;
  }
});

test('带附件又能上网：Read 和上网的工具都打开，事先批准的只有上网的那两个', async () => {
  await c.post('/api/config', { webSearch: true });
  try {
    await c.post('/api/new');
    const img = await upload('截图.png', PNG);
    const s = await sendAndWait(c, { text: '@Claude @GPT 看图，再查一下', attachments: [img.id] });
    const cl = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
    assert.deepStrictEqual(
      { tools: cl.tools, allowedTools: cl.allowedTools, permissionMode: cl.permissionMode, files: cl.files.length },
      { tools: 'Read,WebSearch,WebFetch', allowedTools: 'WebSearch,WebFetch', permissionMode: 'default', files: 1 },
      'Read 不在事先批准的工具里：读 workspace 以外的文件还是会被拒绝'
    );
    assert.strictEqual(cl.webRule, 'files', '人设里用的是“除了上网和查看主持人发来的附件”那一条');
    const cx = parseInfo(last(s, 'gpt').text, 'MOCK-CODEX');
    assert.deepStrictEqual({ webSearch: cx.webSearch, sandbox: cx.sandbox, images: cx.images.length }, { webSearch: 'live', sandbox: 'read-only', images: 1 });

    // 被拒绝的是上网的工具：注明的是“没有权限上网”，不说成打不开附件
    process.env.MOCK_CLAUDE_DENY = 'web';
    const denied = await sendAndWait(c, { text: '@Claude 再查一下' });
    assert.strictEqual(last(denied, 'claude').meta.note, 'Claude Code 没有权限上网');
  } finally {
    delete process.env.MOCK_CLAUDE_DENY;
    await c.post('/api/config', { webSearch: false });
  }
});

test('附件失效或太多时不发送消息，并说明原因', async () => {
  await c.post('/api/new');
  const img = await upload('a.png', PNG);
  const count = (await c.get('/api/state')).json.messages.length;
  const gone = await c.post('/api/send', { text: '看看', attachments: [img.id, 'f00000000'] });
  assert.strictEqual(gone.status, 400);
  assert.deepStrictEqual(gone.json, { error: '有附件已经失效了，请重新添加', hint: '', code: 'attachments-gone' });
  assert.strictEqual((await c.get('/api/state')).json.messages.length, count, '消息没有发出去');

  const many = [];
  for (let i = 0; i < 11; i++) many.push((await upload(`${i}.txt`, Buffer.from(`第 ${i} 个文件`))).id);
  const tooMany = await c.post('/api/send', { text: '太多了', attachments: many });
  assert.strictEqual(tooMany.status, 400);
  assert.deepStrictEqual(tooMany.json, { error: '一条消息最多带 10 个附件', hint: '' });
  assert.strictEqual((await c.get('/api/state')).json.messages.length, count);

  // 没发出去的附件还在，可以分两条发
  let s = await sendAndWait(c, { text: '@Claude 第一批', attachments: [img.id, ...many.slice(0, 9)] });
  assert.strictEqual(userMessages(s).pop().attachments.length, 10);
  s = await sendAndWait(c, { text: '@Claude 第二批', attachments: many.slice(9) });
  assert.strictEqual(parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE').attachments, 12);
  // 同一个附件不能发两次
  assert.strictEqual((await c.post('/api/send', { text: '再发一次', attachments: [img.id] })).json.code, 'attachments-gone');
});

test('英文界面：附件的提示词、说明和错误都是英文', async () => {
  await c.post('/api/config', { lang: 'en' });
  try {
    await c.post('/api/new');
    const bad = await c.post('/api/upload', { name: 'setup.exe', data: b64(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300)])) });
    assert.strictEqual(bad.json.error, '"setup.exe" is not a supported file type');
    assert.ok(bad.json.hint.startsWith('Supported: images (PNG, JPG, GIF, WebP), PDF'));
    assert.strictEqual((await c.post('/api/send', { text: 'hi', attachments: ['f00000000'] })).json.error, 'An attachment is no longer available; please add it again');
    assert.strictEqual((await c.get('/api/file/nope.png')).json.error, 'This file is no longer available');

    const img = await upload('photo.png', PNG);
    const scan = await upload('scan.pdf', SCAN);
    await setMembers({ gpt: { provider: 'github-models' } });
    api.setMode('no-vision');
    const from = api.requests.length;
    const s = await sendAndWait(c, { text: '@Claude @GPT what is in the picture?', attachments: [img.id, scan.id] });
    const cl = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
    assert.deepStrictEqual(
      cl.files.map((f) => ({ n: f.n, size: f.size })),
      [
        { n: 1, size: PNG.length },
        { n: 2, size: SCAN.length },
      ],
      '英文的提示词里也列出了文件的位置'
    );
    assert.strictEqual(cl.systemEn, true);
    assert.strictEqual(
      last(s, 'gpt').meta.note,
      'Attachment 1 (photo.png), Attachment 2 (scan.pdf) could not be sent: the service rejected the request with them attached (it said: Invalid content type. image_url is only supported by certain models.)'
    );
    const retry = api.requests.slice(from)[2].body.messages.find((m) => m.role === 'user').content;
    assert.ok(retry.includes('<attachment number="1" name="photo.png" note="image" />\n\n<attachment number="2" name="scan.pdf" note="PDF, no text could be extracted, probably a scan" />'), retry);
    assert.ok(retry.includes('(Attachment 1: photo.png; Attachment 2: scan.pdf)'));
    assert.ok(retry.endsWith('(Note: the files for Attachment 1 (photo.png), Attachment 2 (scan.pdf) could not be sent to you, so you cannot see what is in them. If you need them to answer, say that you cannot see them.)'));
    assert.ok((await c.get('/api/export')).text.includes('\n> Attachments: photo.png, scan.pdf\n'));
  } finally {
    api.setMode('ok');
    await setMembers({ gpt: { provider: 'codex-cli' } });
    await c.post('/api/config', { lang: 'zh' });
  }
});

test('程序重启后：发出去的附件还在（在历史对话里），没发出去的已经清掉', async () => {
  const dir = tmpDir('rt-data-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 2, lang: 'zh', members: { gemini: { enabled: false }, gpt: { enabled: false } } }));
  const first = createAppServer({ dataDir: dir, publicDir: path.join(ROOT, 'public') });
  await first.listen(0);
  let sent;
  let unsent;
  try {
    const c1 = client(first.port);
    sent = await upload('留下.png', PNG, c1);
    unsent = await upload('没发.png', PNG, c1);
    const s = await sendAndWait(c1, { text: '存一张图', attachments: [sent.id] });
    assert.strictEqual(aiMessages(s).length, 1);
  } finally {
    await first.close();
  }
  const files = fs.readdirSync(path.join(dir, 'workspace', 'attachments'));
  assert.deepStrictEqual(files, [sent.file], '关闭时删掉没发出去的');

  const second = createAppServer({ dataDir: dir, publicDir: path.join(ROOT, 'public') });
  await second.listen(0);
  try {
    const c2 = client(second.port);
    // 重启后从新的空对话开始，上次的对话在「历史对话」里，打开它接着聊
    assert.deepStrictEqual((await c2.get('/api/state')).json.messages, []);
    const [prev] = (await c2.get('/api/history')).json.items;
    await c2.post('/api/history/open', { file: prev.file });
    const s = (await c2.get('/api/state')).json;
    assert.deepStrictEqual(s.messages[0].attachments, [sent]);
    assert.deepStrictEqual((await getRaw(`/api/file/${sent.file}`, second.port)).body, PNG);
    // 重启前上传、还留在输入框里的附件：发送时提示重新添加
    const gone = await c2.post('/api/send', { text: '接着发', attachments: [unsent.id] });
    assert.strictEqual(gone.json.code, 'attachments-gone');
    // 以前的图片在重启后的发言里照样带上
    const again = await sendAndWait(c2, { text: '再看看那张图' });
    assert.deepStrictEqual(parseInfo(last(again, 'claude').text, 'MOCK-CLAUDE').files, [{ n: 1, text: false, path: path.join(dir, 'workspace', 'attachments', sent.file), size: PNG.length }]);
  } finally {
    await second.close();
  }
});

test('Windows：走 cmd.exe 启动的 Claude 也能拿到附件', { skip: !IS_WIN }, async () => {
  const file = makeBin(tmpDir('rt-plain-'), 'claude', path.join(MOCKS, 'claude.js'), 'plain');
  await setMembers({ claude: { 'claude-cli': { command: file } } });
  try {
    await c.post('/api/new');
    const img = await upload('截图 1.png', PNG);
    const s = await sendAndWait(c, { text: '@Claude 看图', attachments: [img.id] });
    const info = parseInfo(last(s, 'claude').text, 'MOCK-CLAUDE');
    assert.deepStrictEqual({ tools: info.tools, stdinHasSystem: info.stdinHasSystem }, { tools: 'Read', stdinHasSystem: true });
    assert.deepStrictEqual(info.files, [{ n: 1, text: false, path: path.join(attachDir(), img.file), size: PNG.length }]);
  } finally {
    await setMembers({ claude: { 'claude-cli': { command: 'claude' } } });
  }
});

test('附件的文件名像一句“额度用完”：Codex 失败时不把回显出来的文件清单当成它自己的话', async () => {
  // codex exec 会把整段提示词回显在 stderr 上；带附件时提示词后面多一段文件清单，文件名是用户起的。
  // 找失败原因之前要把这一段也去掉：不然 GPT 会被标成“额度用完”，文件名还会出现在报错和「用量」里
  await c.post('/api/new');
  const img = await upload("You've hit your usage limit.png", PNG);
  process.env.MOCK_CODEX_FAIL = 'empty';
  try {
    const s = await sendAndWait(c, { text: '@GPT 看图', attachments: [img.id] });
    const end = s.messages[s.messages.length - 1];
    assert.ok(end.speaker === 'system' && end.level === 'error' && end.text.includes('Codex 没有返回内容'), JSON.stringify(end));
    assert.ok(!/usage limit/i.test(end.text), end.text);
    assert.strictEqual(s.members.find((m) => m.id === 'gpt').limited, null, 'GPT 没有被标成“额度用完”');
  } finally {
    delete process.env.MOCK_CODEX_FAIL;
  }
});

// 放在最后：被拒绝过的参数在这次运行里不会再试
test('旧版 Codex 不能附图片：去掉 --image 重试，让它自己打开文件，并在回复上注明', async () => {
  process.env.MOCK_CODEX_NO_IMAGE = '1';
  try {
    await c.post('/api/new');
    const img = await upload('截图.png', PNG);
    const s = await sendAndWait(c, { text: '@GPT 看图', attachments: [img.id] });
    const gpt = last(s, 'gpt');
    assert.ok(gpt, JSON.stringify(s.messages));
    const info = parseInfo(gpt.text, 'MOCK-CODEX');
    assert.strictEqual(info.images, undefined);
    assert.deepStrictEqual(info.files, [{ n: 1, text: false, path: `attachments/${img.file}`, size: PNG.length }]);
    assert.strictEqual(info.stdinDash, true);
    assert.strictEqual(gpt.meta.note, '这个版本的 Codex 不能直接附图片，改为让它自己打开文件');
  } finally {
    delete process.env.MOCK_CODEX_NO_IMAGE;
  }
});
