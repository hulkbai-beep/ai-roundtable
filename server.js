'use strict';

// AI 圆桌：本地服务器。双击 start.bat 启动，然后在浏览器里打开 http://127.0.0.1:3939

const VERSION = '1.0.0';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`需要 Node.js 18 或更高版本（你现在是 ${process.version}）。请到 https://nodejs.org 下载安装 LTS 版本。`);
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ConfigStore, ConversationStore } = require('./lib/store');
const { Roundtable } = require('./lib/orchestrator');
const { PROVIDERS, CANDIDATES, readiness, listGithubModels } = require('./lib/providers');
const { detectCommand } = require('./lib/spawn');
const { MEMBERS, MODES, LENGTHS } = require('./lib/prompt');
const { UserError } = require('./lib/util');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const portArgIdx = argv.indexOf('--port');
const PORT_OVERRIDE = portArgIdx >= 0 ? Number(argv[portArgIdx + 1]) : null;

const config = new ConfigStore(path.join(ROOT, 'config.json'));
const conversations = new ConversationStore(path.join(ROOT, 'data'));
const workdir = path.join(ROOT, 'workspace');
fs.mkdirSync(workdir, { recursive: true });
const table = new Roundtable({ config, conversations, workdir });

let PORT = PORT_OVERRIDE || config.get().port;

// ---------- 实时推送（SSE） ----------

const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function memberSummary() {
  const cfg = config.get();
  return cfg.order.map((id) => {
    const m = cfg.members[id];
    const pcfg = m[m.provider] || {};
    const r = readiness(m.provider, pcfg);
    return {
      id,
      name: MEMBERS[id].name,
      maker: MEMBERS[id].maker,
      enabled: m.enabled,
      provider: m.provider,
      providerLabel: PROVIDERS[m.provider].label,
      model: pcfg.model || '',
      ready: r.ready,
      reason: r.reason || '',
    };
  });
}

function snapshot() {
  const conv = conversations.current;
  return {
    app: 'ai-roundtable',
    version: VERSION,
    conversation: { id: conv.id, createdAt: conv.createdAt, title: ConversationStore.title(conv) },
    messages: conv.messages,
    state: table.state(),
    members: memberSummary(),
    modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])),
    lengths: Object.fromEntries(Object.entries(LENGTHS).map(([k, v]) => [k, v.label])),
  };
}

table.on('msg', (m) => broadcast('msg', m));
table.on('typing', (t) => broadcast('typing', t));
table.on('state', (s) => broadcast('state', s));
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 20000).unref();

// ---------- 工具函数 ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new UserError('请求内容太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new UserError('请求格式不对'));
      }
    });
    req.on('error', reject);
  });
}

// 只接受来自本机页面的请求，防止其他网站借你的浏览器调用本地服务
function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function exportMarkdown() {
  const conv = conversations.current;
  const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const lines = [`# AI 圆桌：${ConversationStore.title(conv)}`, '', `> 导出时间：${fmt(Date.now())}`, ''];
  for (const m of conv.messages) {
    if (m.speaker === 'system') {
      lines.push(`> ${m.text.replace(/\n/g, '\n> ')}`, '');
      continue;
    }
    const name = m.speaker === 'user' ? '我' : MEMBERS[m.speaker] ? MEMBERS[m.speaker].name : m.speaker;
    lines.push(`### ${name}　<small>${fmt(m.ts)}</small>`, '', m.text, '');
  }
  return lines.join('\n');
}

function fullConfig() {
  const cfg = config.get();
  const detect = {};
  for (const [pid, meta] of Object.entries(PROVIDERS)) {
    if (meta.kind !== 'cli') continue;
    const cmd = (cfg.members[meta.member][pid] || {}).command || meta.bin;
    detect[pid] = detectCommand(cmd, CANDIDATES[meta.bin]);
  }
  return {
    config: config.publicView(),
    providers: PROVIDERS,
    members: MEMBERS,
    detect,
    port: PORT,
  };
}

// ---------- 路由 ----------

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/ping') return sendJson(res, 200, { app: 'ai-roundtable', version: VERSION });
  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, snapshot());

  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return undefined;
  }

  if (method === 'GET' && pathname === '/api/export') {
    const name = `AI圆桌-${new Date().toISOString().slice(0, 10)}.md`;
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="ai-roundtable.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    return res.end(exportMarkdown());
  }

  if (method === 'GET' && pathname === '/api/config') return sendJson(res, 200, fullConfig());
  if (method === 'GET' && pathname === '/api/history') return sendJson(res, 200, { items: conversations.list() });

  if (method !== 'POST') return sendJson(res, 404, { error: '没有这个接口' });
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return sendJson(res, 415, { error: '请求格式不对' });
  }
  const body = await readBody(req);

  if (pathname === '/api/send') {
    table.send(body);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/continue') {
    table.continueRound(body);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/stop') return sendJson(res, 200, { ok: true, stopped: table.stop() });
  if (pathname === '/api/new') {
    table.stop();
    conversations.startNew();
    broadcast('snapshot', snapshot());
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/history/open') {
    table.stop();
    conversations.open(body.file);
    broadcast('snapshot', snapshot());
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/config') {
    config.update(body);
    broadcast('members', memberSummary());
    return sendJson(res, 200, fullConfig());
  }
  const test = pathname.match(/^\/api\/test\/(\w+)$/);
  if (test) {
    if (!MEMBERS[test[1]]) throw new UserError('没有这个成员');
    return sendJson(res, 200, await table.test(test[1]));
  }
  if (pathname === '/api/github-models') {
    const cfg = config.get();
    const items = await listGithubModels(cfg.members.gpt['github-models'], { proxy: cfg.proxy });
    return sendJson(res, 200, { items });
  }
  return sendJson(res, 404, { error: '没有这个接口' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req) || !originOk(req)) return sendJson(res, 403, { error: '只允许本机访问' });
    const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (!e.userFacing) console.error(e);
    if (!res.headersSent) sendJson(res, e.userFacing ? 400 : 500, { error: e.message, hint: e.hint || '' });
    else res.end();
  }
});

// ---------- 启动 ----------

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    let child;
    if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 打不开就让用户自己复制地址 */
  }
}

function pingExisting(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { Host: `127.0.0.1:${port}` }, timeout: 1500 }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve(t.includes('ai-roundtable')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function listen(port, attemptsLeft) {
  PORT = port;
  server.once('error', async (e) => {
    if (e.code !== 'EADDRINUSE') {
      console.error('启动失败：', e.message);
      process.exit(1);
    }
    if (await pingExisting(port)) {
      const url = `http://127.0.0.1:${port}`;
      console.log(`AI 圆桌已经在运行了：${url}（已帮你打开浏览器）`);
      openBrowser(url);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (attemptsLeft <= 0) {
      console.error(`端口 ${port} 被占用，换个端口试试：在 config.json 里修改 port`);
      process.exit(1);
    }
    listen(port + 1, attemptsLeft - 1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  AI 圆桌 已启动');
    console.log(`  在浏览器打开：${url}`);
    console.log('  关闭这个窗口就会退出');
    console.log('');
    for (const m of memberSummary()) {
      const status = !m.enabled ? '已关闭' : m.ready ? '就绪' : `需要设置（${m.reason}）`;
      console.log(`  - ${m.name.padEnd(7)} ${m.providerLabel}：${status}`);
    }
    console.log('');
    openBrowser(url);
  });
}

function shutdown() {
  table.stop();
  conversations.saveNow();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

listen(PORT, PORT_OVERRIDE ? 0 : 10);
