'use strict';

// 测试用的小工具：生成模拟命令、发 HTTP 请求、等待对话结束

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MOCKS = path.join(__dirname, 'mocks');
const IS_WIN = process.platform === 'win32';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 生成一个可以在 PATH 里找到的模拟命令。
// Windows：style 'npm' 生成和 npm 一模一样格式的 xxx.cmd；style 'plain' 生成一个解析不了的 .cmd，只能走 cmd.exe。
// 其他系统：生成可执行的 sh 脚本。
function makeBin(dir, name, script, style = 'npm') {
  fs.mkdirSync(dir, { recursive: true });
  if (IS_WIN) {
    let text;
    if (style === 'npm') {
      // 和 npm 一样：脚本放进 node_modules，.cmd 用相对路径指向它（脚本和 .cmd 可能不在同一个盘）
      const pkgDir = path.join(dir, 'node_modules', `mock-${name}`);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.copyFileSync(script, path.join(pkgDir, path.basename(script)));
      const rel = `node_modules\\mock-${name}\\${path.basename(script)}`;
      text = [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        '',
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
        '',
      ].join('\r\n');
    } else {
      text = `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`;
    }
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, text);
    return file;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function makeMockBins(dir) {
  for (const name of ['claude', 'agy', 'codex']) makeBin(dir, name, path.join(MOCKS, `${name}.js`));
  return dir;
}

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${port}` };
    if (data != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, text: t, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

function client(port) {
  return {
    get: (p) => request(port, 'GET', p),
    post: (p, body = {}) => request(port, 'POST', p, body),
  };
}

// 像网页一样连上 /api/events，把推送过来的事件按顺序记下来：[{ event, data }]。用完要 close()
function listen(port) {
  const events = [];
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(frame);
        const data = /^data: (.*)$/m.exec(frame);
        if (event && data) events.push({ event: event[1], data: JSON.parse(data[1]) });
      }
    });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

// 发送一条消息，等所有成员说完
async function sendAndWait(c, body, timeout = 30000) {
  const r = await c.post('/api/send', body);
  if (r.status !== 200) throw new Error(`send failed: ${r.text}`);
  return waitIdle(c, timeout);
}

async function waitIdle(c, timeout = 30000) {
  await sleep(50);
  return waitFor(
    async () => {
      const s = (await c.get('/api/state')).json;
      return !s.state.busy && s;
    },
    { timeout, label: 'conversation to finish' }
  );
}

const aiMessages = (s) => s.messages.filter((m) => ['claude', 'gemini', 'gpt'].includes(m.speaker));
const parseInfo = (text, tag) => JSON.parse(text.slice(text.indexOf(tag) + tag.length + 1));

module.exports = {
  ROOT,
  MOCKS,
  IS_WIN,
  tmpDir,
  makeBin,
  makeMockBins,
  request,
  client,
  listen,
  sleep,
  waitFor,
  sendAndWait,
  waitIdle,
  aiMessages,
  parseInfo,
};
