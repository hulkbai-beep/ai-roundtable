'use strict';

// 本地 HTTP 服务：给网页界面提供接口和实时推送（SSE）。
// 浏览器版（server.js）和桌面版（electron/main.js）共用这一份。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ConfigStore, ConversationStore } = require('./store');
const { Roundtable } = require('./orchestrator');
const { AttachmentStore, MAX_UPLOAD_BODY, MAX_FILE_MB, MAX_PER_MESSAGE } = require('./attachments');
const { UsageStore } = require('./usage');
const { PROVIDERS, CANDIDATES, readiness, listGithubModels } = require('./providers');
const { detectCommand, planCommand, runProcess } = require('./spawn');
const diag = require('./diag');
const { MEMBERS, MODES, LENGTHS } = require('./prompt');
const { UserError } = require('./util');
const { tr, loc, getLang, setLang } = require('./i18n');

const VERSION = require('../package.json').version;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createAppServer({ dataDir, publicDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const config = new ConfigStore(path.join(dataDir, 'config.json'));
  const conversations = new ConversationStore(path.join(dataDir, 'data'));
  // 每次打开都从一个新的空对话开始：上次的对话存进「历史对话」（空的不存，不会越攒越多）
  conversations.startNew();
  const workdir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workdir, { recursive: true });
  setLang(config.get().lang);
  // 用户发来的图片和文档放在 workspace 里：命令行工具就在这个目录下运行，可以直接打开
  const attachments = new AttachmentStore(path.join(workdir, 'attachments'));
  const usage = new UsageStore(path.join(dataDir, 'usage.json'));
  const diagLog = new diag.DiagLog(path.join(dataDir, 'diagnostics.json'));
  const table = new Roundtable({ config, conversations, workdir, attachments, usage, diag: diagLog });
  const PUBLIC = path.resolve(publicDir);
  let port = 0;

  // ---------- 实时推送 ----------

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
        providerLabel: loc(PROVIDERS[m.provider].label),
        model: pcfg.model || '',
        ready: r.ready,
        reason: r.reason || '',
        limited: table.limitOf(id),
        usage: usage.summary(id),
      };
    });
  }

  function snapshot() {
    const conv = conversations.current;
    return {
      app: 'ai-roundtable',
      version: VERSION,
      lang: getLang(),
      conversation: { id: conv.id, createdAt: conv.createdAt, title: ConversationStore.title(conv) },
      messages: conv.messages,
      state: table.state(),
      members: memberSummary(),
      modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, loc(v.label)])),
      lengths: Object.fromEntries(Object.entries(LENGTHS).map(([k, v]) => [k, loc(v.label)])),
      limits: { fileMB: MAX_FILE_MB, perMessage: MAX_PER_MESSAGE },
    };
  }

  table.on('msg', (m) => broadcast('msg', m));
  table.on('typing', (t) => broadcast('typing', t));
  table.on('state', (s) => broadcast('state', s));
  usage.on('change', () => broadcast('members', memberSummary()));
  const pingTimer = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20000);
  pingTimer.unref();

  // ---------- 工具函数 ----------

  // 请求里的成员 id 必须是三位成员之一（"constructor" 这种对象自带的属性名不算）
  const isMember = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(MEMBERS, id);

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function readBody(req, limit = 2 * 1024 * 1024, tooLarge = () => new UserError(tr('请求内容太大', 'Request too large'))) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let over = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (over) {
          // 已经超了：把剩下的内容读完再回复，浏览器才收得到错误提示；大得离谱就直接断开
          if (size > limit * 8) {
            reject(tooLarge());
            req.destroy();
          }
        } else if (size > limit) {
          over = true;
          chunks.length = 0;
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (over) return reject(tooLarge());
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        // 内容必须是一个对象：null、数字、数组这些，后面的代码都没法用
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return reject(new UserError(tr('请求格式不对', 'Invalid request')));
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  // 只接受来自本机页面的请求，防止其他网站借你的浏览器调用本地服务
  function hostOk(req) {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }
  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function serveStatic(res, pathname) {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
    } catch {
      return sendJson(res, 400, { error: 'bad path' });
    }
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 404, { error: 'not found' });
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  // 附件：图片可以在页面里直接显示，其他文件一律当作下载（不让浏览器把用户上传的文件当网页打开）
  function sendFile(res, name) {
    const f = attachments.resolve(name);
    if (!f) return sendJson(res, 404, { error: tr('这个文件已经不在了', 'This file is no longer available') });
    res.writeHead(200, {
      'Content-Type': f.mime,
      'Content-Disposition': f.inline ? 'inline' : 'attachment',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    return fs
      .createReadStream(f.path)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  function exportMarkdown() {
    const conv = conversations.current;
    const fmt = (ts) => new Date(ts).toLocaleString(tr('zh-CN', 'en-US'), { hour12: false });
    const lines = [tr(`# AI 圆桌：${ConversationStore.title(conv)}`, `# AI Roundtable: ${ConversationStore.title(conv)}`), '', tr(`> 导出时间：${fmt(Date.now())}`, `> Exported: ${fmt(Date.now())}`), ''];
    for (const m of conv.messages) {
      if (m.speaker === 'system') {
        lines.push(`> ${m.text.replace(/\n/g, '\n> ')}`, '');
        continue;
      }
      const name = m.speaker === 'user' ? tr('我', 'Me') : MEMBERS[m.speaker] ? MEMBERS[m.speaker].name : m.speaker;
      lines.push(`### ${name}　<small>${fmt(m.ts)}</small>`, '');
      if (m.text) lines.push(m.text, '');
      const files = m.speaker === 'user' && Array.isArray(m.attachments) ? m.attachments.map((a) => a.name) : [];
      if (files.length) lines.push(tr(`> 附件：${files.join('、')}`, `> Attachments: ${files.join(', ')}`), '');
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
    return { config: config.publicView(), providers: loc(PROVIDERS), members: MEMBERS, detect, port, lang: getLang() };
  }

  // 诊断信息（lib/diag.js）：成员用到的命令行工具各自在哪、--version 说了什么，加上最近的发言记录。
  // 跑 --version 不花额度
  async function diagnostics() {
    const cfg = config.get();
    const tools = [];
    for (const [pid, meta] of Object.entries(PROVIDERS)) {
      if (meta.kind !== 'cli' || cfg.members[meta.member].provider !== pid) continue;
      const command = (cfg.members[meta.member][pid] || {}).command || meta.bin;
      const t = { command, ...detectCommand(command, CANDIDATES[meta.bin]) };
      if (t.found) {
        try {
          const r = await runProcess({ command, plan: planCommand(command, { candidates: CANDIDATES[meta.bin] }), args: ['--version'], cwd: workdir, timeoutMs: 20000 });
          Object.assign(t, { code: r.code, stdout: diag.clip(r.stdout, 1000, 1000), stderr: diag.clip(r.stderr, 1000, 1000) });
        } catch (e) {
          t.error = String(e.message || e);
        }
      }
      tools.push(t);
    }
    const marks = Object.fromEntries(Object.keys(cfg.members).map((id) => [id, usage.marksOf(id)]));
    return diag.report({ version: VERSION, config: cfg, providers: PROVIDERS, tools, calls: diagLog.calls, marks });
  }

  // ---------- 路由 ----------

  async function handleApi(req, res, pathname) {
    const method = req.method;

    if (method === 'GET' && pathname === '/api/ping') {
      return sendJson(res, 200, { app: 'ai-roundtable', version: VERSION, clients: clients.size });
    }
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
      const name = tr(`AI圆桌-${new Date().toISOString().slice(0, 10)}.md`, `AI-Roundtable-${new Date().toISOString().slice(0, 10)}.md`);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="ai-roundtable.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return res.end(exportMarkdown());
    }

    if (method === 'GET' && pathname === '/api/diagnostics') {
      const text = await diagnostics();
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="ai-roundtable-diagnostics-${new Date().toISOString().slice(0, 10)}.md"`,
      });
      return res.end(text);
    }

    const file = method === 'GET' && pathname.match(/^\/api\/file\/([^/]+)$/);
    if (file) return sendFile(res, file[1]);

    if (method === 'GET' && pathname === '/api/config') return sendJson(res, 200, fullConfig());
    if (method === 'GET' && pathname === '/api/history') return sendJson(res, 200, { items: conversations.list() });

    if (method !== 'POST') return sendJson(res, 404, { error: tr('没有这个接口', 'No such endpoint') });
    // 只认 application/json（后面可以带 charset 之类的参数）；“text/plain; application/json” 这样的写法不算
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return sendJson(res, 415, { error: tr('请求格式不对', 'Invalid request') });
    }
    // 上传的文件用 base64 放在 JSON 里，所以这一个接口允许的内容大得多
    const upload = pathname === '/api/upload';
    const body = upload
      ? await readBody(req, MAX_UPLOAD_BODY, () => new UserError(tr(`文件太大了（超过 ${MAX_FILE_MB} MB）`, `The file is too large (over ${MAX_FILE_MB} MB)`)))
      : await readBody(req);

    if (upload) return sendJson(res, 200, { attachment: attachments.save(body) });
    if (pathname === '/api/discard') return sendJson(res, 200, { ok: true, removed: attachments.discard(String(body.id || '')) });
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
      const membersBefore = JSON.parse(JSON.stringify(config.get().members));
      config.update(body);
      // 改了某种接入方式的设置（换了账号、Key、模型……）：它之前的“额度用完”不一定还成立，去掉标记，下次直接试。
      // 每种接入方式的标记分开看：没在用的那种也一样
      for (const id of Object.keys(MEMBERS)) {
        for (const mark of usage.marksOf(id)) {
          const pid = mark.provider || membersBefore[id].provider;
          if (JSON.stringify(membersBefore[id][pid] || {}) !== JSON.stringify(config.get().members[id][pid] || {})) usage.clearLimited(id, mark.provider);
        }
      }
      const langBefore = getLang();
      setLang(config.get().lang);
      if (langBefore !== getLang()) broadcast('snapshot', snapshot());
      else broadcast('members', memberSummary());
      return sendJson(res, 200, fullConfig());
    }
    const test = pathname.match(/^\/api\/test\/(\w+)$/);
    if (test) {
      if (!isMember(test[1])) throw new UserError(tr('没有这个成员', 'No such member'));
      return sendJson(res, 200, await table.test(test[1]));
    }
    if (pathname === '/api/usage/retry') {
      if (!isMember(body.member)) throw new UserError(tr('没有这个成员', 'No such member'));
      // 再试的是现在用的这种接入方式；别的接入方式留下的标记不动
      usage.clearLimited(body.member, config.get().members[body.member].provider);
      return sendJson(res, 200, { ok: true, members: memberSummary() });
    }
    if (pathname === '/api/usage/reset') {
      if (body.member != null && body.member !== '' && !isMember(body.member)) throw new UserError(tr('没有这个成员', 'No such member'));
      usage.resetCounts(body.member || null);
      return sendJson(res, 200, { ok: true, members: memberSummary() });
    }
    if (pathname === '/api/github-models') {
      const cfg = config.get();
      const items = await listGithubModels(cfg.members.gpt['github-models'], { proxy: cfg.proxy });
      return sendJson(res, 200, { items });
    }
    return sendJson(res, 404, { error: tr('没有这个接口', 'No such endpoint') });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req) || !originOk(req)) return sendJson(res, 403, { error: tr('只允许本机访问', 'Only local access is allowed') });
      const { pathname } = new URL(req.url, `http://127.0.0.1:${port}`);
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return serveStatic(res, pathname);
    } catch (e) {
      if (!e.userFacing) console.error(e);
      if (!res.headersSent) sendJson(res, e.userFacing ? 400 : 500, { error: e.message, hint: e.hint || '', ...(e.userFacing && e.code ? { code: e.code } : {}) });
      else res.end();
    }
  });

  // 监听本机端口；端口被占用时 reject（err.code === 'EADDRINUSE'）
  function listen(wanted) {
    return new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        port = server.address().port;
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(wanted, '127.0.0.1');
    });
  }

  function close() {
    table.stop();
    conversations.saveNow();
    attachments.clearPending();
    usage.close();
    clearInterval(pingTimer);
    for (const res of clients) res.end();
    clients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return {
    listen,
    close,
    memberSummary,
    getConfig: () => config.get(),
    get port() {
      return port;
    },
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    version: VERSION,
    dataDir,
  };
}

// 检查某个端口上是不是已经有一个 AI 圆桌在运行
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

module.exports = { createAppServer, pingExisting, VERSION };
