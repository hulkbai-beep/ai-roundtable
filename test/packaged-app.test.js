'use strict';

// 测试打包好的桌面版（CI 在 Windows 上打包后运行）：
//   node test/packaged-app.test.js -- "dist/win-unpacked/AI Roundtable.exe"
// 本机开发时也可以测未打包的版本：
//   xvfb-run -a node test/packaged-app.test.js -- node_modules/electron/dist/electron --no-sandbox .
//
// 1. 冒烟测试：窗口能打开、界面能显示
// 2. 用模拟的 claude / agy / codex 跑一轮真实的群聊，再跑一轮带附件的
// 3. （Windows）电脑上没有装 Node.js 时，npm 装的命令行工具也能靠桌面版自带的 Node 运行

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WIN, tmpDir, makeMockBins, client, waitFor, sendAndWait, aiMessages, parseInfo, sleep } = require('./helpers');
const { PNG, fixture } = require('./files');

const sep = process.argv.indexOf('--');
const [APP, ...APP_ARGS] = sep >= 0 ? process.argv.slice(sep + 1) : [];
if (!APP) {
  console.error('用法：node test/packaged-app.test.js -- <应用程序路径> [参数...]');
  process.exit(2);
}

const running = new Set();

function launch(extraArgs, env = process.env) {
  const child = spawn(APP, [...APP_ARGS, ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  child.output = () => output;
  running.add(child);
  child.on('exit', () => running.delete(child));
  return child;
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

after(() => {
  for (const child of running) kill(child);
});

function waitExit(child, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`app did not exit in time\n${child.output()}`)), timeout);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function startAppWithMocks(env, port) {
  const app = launch([`--data-dir=${tmpDir('rt-app-')}`, `--port=${port}`], env);
  const c = client(port);
  await waitFor(
    async () => {
      if (app.exitCode !== null) throw new Error(`app exited early (${app.exitCode})\n${app.output()}`);
      try {
        const ping = (await c.get('/api/ping')).json;
        return ping && ping.clients >= 1; // 界面已经连上了实时推送
      } catch {
        return false;
      }
    },
    { timeout: 60000, label: 'app window to load' }
  );
  return { app, c };
}

test('冒烟测试：窗口打开，界面正常显示', async () => {
  const out = path.join(tmpDir('rt-smoke-'), 'smoke.json');
  const app = launch([`--smoke-out=${out}`, `--data-dir=${tmpDir('rt-smoke-data-')}`]);
  const code = await waitExit(app, 120000);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  console.log('smoke result:', result);
  assert.strictEqual(code, 0, app.output());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.members, 3);
});

test('桌面版里跑一轮完整的群聊（模拟的 AI）', async () => {
  const bin = makeMockBins(tmpDir('rt-pkg-bin-'));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const { app, c } = await startAppWithMocks(env, 39391);
  try {
    const s = await sendAndWait(c, { text: '桌面版测试："引号"和换行\n第二行', rounds: 1 }, 60000);
    const ai = aiMessages(s);
    assert.deepStrictEqual(
      ai.map((m) => m.speaker),
      ['claude', 'gemini', 'gpt']
    );
    assert.ok(ai[0].text.startsWith('MOCK-CLAUDE'), ai[0].text);
    assert.ok(ai[1].text.startsWith('MOCK-AGY'), ai[1].text);
    assert.ok(ai[2].text.startsWith('MOCK-CODEX'), ai[2].text);

    // 带附件的一轮：图片和扫描的 PDF 保存在桌面版的数据目录里，三位都按拿到的路径读到了文件
    const scan = fixture('scan.pdf');
    const upload = async (name, buf) => {
      const r = await c.post('/api/upload', { name, data: buf.toString('base64') });
      assert.strictEqual(r.status, 200, r.text);
      return r.json.attachment;
    };
    const img = await upload('截图 1.png', PNG);
    const pdf = await upload('扫描件.pdf', scan);
    const s2 = await sendAndWait(c, { text: '看看这两个附件', attachments: [img.id, pdf.id], rounds: 1 }, 60000);
    const info = (who, tag) => parseInfo(aiMessages(s2).filter((m) => m.speaker === who).pop().text, tag);
    const sizes = [PNG.length, scan.length];
    assert.deepStrictEqual(info('claude', 'MOCK-CLAUDE').files.map((f) => f.size), sizes, 'Claude');
    assert.deepStrictEqual(info('gemini', 'MOCK-AGY').files.map((f) => f.size), sizes, 'Antigravity');
    const codex = info('gpt', 'MOCK-CODEX');
    assert.deepStrictEqual(codex.images.map((f) => f.size), [PNG.length], 'Codex 的 --image');
    assert.deepStrictEqual(codex.files.map((f) => f.size), sizes, 'Codex');
    for (const m of aiMessages(s2).slice(-3)) assert.strictEqual(m.meta.note, '', `${m.speaker}: ${m.meta.note}`);
  } finally {
    kill(app);
    await sleep(1000);
  }
});

test('Windows：电脑上没装 Node.js 时，npm 装的命令行工具也能用', { skip: !IS_WIN }, async () => {
  const bin = makeMockBins(tmpDir('rt-pkg-nonode-'));
  const pathWithoutNode = String(process.env.PATH)
    .split(';')
    .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')))
    .join(';');
  // 不让桌面版从注册表把带 node 的 PATH 补回来，这样才测得到“没有 Node.js”的情况
  const env = { ...process.env, PATH: `${bin};${pathWithoutNode}`, AI_ROUNDTABLE_NO_PATH_REFRESH: '1' };
  const { app, c } = await startAppWithMocks(env, 39392);
  try {
    for (const id of ['claude', 'gemini', 'gpt']) {
      const r = (await c.post(`/api/test/${id}`)).json;
      assert.ok(r.ok, `${id}: ${r.error}`);
    }
  } finally {
    kill(app);
    await sleep(1000);
  }
});
