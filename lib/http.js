'use strict';

// 不依赖第三方库的 HTTP 请求，支持 HTTP 代理（例如 Clash 的 http://127.0.0.1:7890）

const http = require('http');
const https = require('https');
const tls = require('tls');
const { UserError } = require('./util');
const { tr } = require('./i18n');
const { httpRecorder } = require('./diag');

function networkError(e, url, proxy) {
  const code = e && e.code ? e.code : '';
  return new UserError(
    tr(`连不上 ${url.hostname}${code ? `（${code}）` : ''}：${e.message}`, `Could not reach ${url.hostname}${code ? ` (${code})` : ''}: ${e.message}`),
    proxy ? tr('检查设置里的代理地址是否正确、代理软件是否开着', 'Check the proxy address in Settings and that your proxy app is running') : tr('如果你访问这个服务需要代理，在设置里填写代理地址，例如 http://127.0.0.1:7890', 'If you need a proxy to reach this service, enter it in Settings, e.g. http://127.0.0.1:7890')
  );
}

function request(urlStr, { method = 'GET', headers = {}, body, proxy, timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return reject(new UserError(tr(`接口地址格式不对：${urlStr}`, `Invalid API URL: ${urlStr}`)));
    }
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const hdrs = { 'User-Agent': 'ai-roundtable/1.0', ...headers };
    if (payload != null) hdrs['Content-Length'] = Buffer.byteLength(payload);

    let settled = false;
    let req = null;
    const sockets = [];
    // 记进诊断记录（lib/diag.js）：网址只记到路径，请求头和请求内容不记；不在一次发言里时什么也不做
    const started = Date.now();
    const record = httpRecorder();
    const note = (o) => record({ method, url: `${url.protocol}//${url.host}${url.pathname}`, requestChars: payload == null ? 0 : payload.length, ms: Date.now() - started, ...o });
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const fail = (e) => {
      sockets.forEach((s) => s.destroy());
      if (req) req.destroy();
      if (!settled) note({ error: e && e.aborted ? 'stopped' : String((e && e.message) || e) });
      finish(reject, e);
    };
    const onAbort = () => {
      const e = new Error(tr('已停止', 'Stopped'));
      e.aborted = true;
      fail(e);
    };
    const timer = setTimeout(() => fail(new UserError(tr(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, `Request timed out (${Math.round(timeoutMs / 1000)} s)`), tr('网络慢或服务繁忙，稍后再试', 'The network is slow or the service is busy; try again later'))), timeoutMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const send = (opts, lib) => {
      req = lib.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!settled) note({ status: res.statusCode, headers: res.headers, text });
          finish(resolve, { status: res.statusCode, headers: res.headers, text });
        });
        res.on('error', (e) => fail(networkError(e, url, proxy)));
      });
      req.on('error', (e) => fail(networkError(e, url, proxy)));
      if (payload != null) req.write(payload);
      req.end();
    };

    const direct = { method, headers: hdrs, host: url.hostname, port, path: url.pathname + url.search, servername: url.hostname };
    if (!proxy) return send(direct, isHttps ? https : http);

    let p;
    try {
      p = new URL(/^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
    } catch {
      return fail(new UserError(tr(`代理地址格式不对：${proxy}`, `Invalid proxy address: ${proxy}`), tr('应该像 http://127.0.0.1:7890 这样', 'It should look like http://127.0.0.1:7890')));
    }
    if (p.protocol !== 'http:') {
      return fail(new UserError(tr('目前只支持 http:// 开头的代理地址', 'Only http:// proxies are supported'), tr('Clash 等软件的“混合端口”一般就是 http 代理，例如 http://127.0.0.1:7890', 'The "mixed port" in apps like Clash is usually an http proxy, e.g. http://127.0.0.1:7890')));
    }
    const proxyPort = Number(p.port) || 80;
    const proxyAuth = p.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`
      : null;

    if (!isHttps) {
      const h = { ...hdrs, Host: url.host };
      if (proxyAuth) h['Proxy-Authorization'] = proxyAuth;
      return send({ method, headers: h, host: p.hostname, port: proxyPort, path: url.href }, http);
    }

    const target = `${url.hostname}:${port}`;
    const connectHeaders = { Host: target };
    if (proxyAuth) connectHeaders['Proxy-Authorization'] = proxyAuth;
    const connectReq = http.request({ host: p.hostname, port: proxyPort, method: 'CONNECT', path: target, headers: connectHeaders });
    req = connectReq;
    connectReq.on('connect', (res, socket) => {
      sockets.push(socket);
      if (res.statusCode !== 200) {
        return fail(new UserError(tr(`代理拒绝连接 ${url.hostname}（HTTP ${res.statusCode}）`, `The proxy refused to connect to ${url.hostname} (HTTP ${res.statusCode})`), tr('检查设置里的代理地址', 'Check the proxy address in Settings')));
      }
      const tlsSock = tls.connect({ socket, servername: url.hostname });
      sockets.push(tlsSock);
      tlsSock.on('error', (e) => fail(networkError(e, url, proxy)));
      send({ ...direct, agent: false, createConnection: () => tlsSock }, https);
    });
    connectReq.on('error', (e) => fail(new UserError(tr(`连不上代理 ${p.host}：${e.message}`, `Could not reach the proxy ${p.host}: ${e.message}`), tr('确认代理软件已经打开，地址和端口正确', 'Make sure your proxy app is running and the address and port are right'))));
    connectReq.end();
  });
}

module.exports = { request };
