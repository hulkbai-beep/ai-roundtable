'use strict';

// 浏览器版入口：双击 start.bat（或 npm start）启动，然后在浏览器里打开 http://127.0.0.1:3939
// 桌面版的入口是 electron/main.js，两者共用 lib/ 里的代码。

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`需要 Node.js 18 或更高版本（你现在是 ${process.version}）。请到 https://nodejs.org 下载安装 LTS 版本。`);
  process.exit(1);
}

const path = require('path');
const { spawn } = require('child_process');
const { createAppServer, pingExisting } = require('./lib/app-server');

const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const portIdx = argv.indexOf('--port');
const PORT_OVERRIDE = portIdx >= 0 ? Number(argv[portIdx + 1]) : null;

const app = createAppServer({ dataDir: __dirname, publicDir: path.join(__dirname, 'public') });

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

async function main() {
  const first = PORT_OVERRIDE || app.getConfig().port || 3939;
  const attempts = PORT_OVERRIDE ? 1 : 10;
  for (let i = 0; i < attempts; i++) {
    const port = first + i;
    try {
      await app.listen(port);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (await pingExisting(port)) {
        const url = `http://127.0.0.1:${port}`;
        console.log(`AI 圆桌已经在运行了：${url}（已帮你打开浏览器）`);
        openBrowser(url);
        setTimeout(() => process.exit(0), 500);
        return;
      }
      if (i === attempts - 1) {
        console.error(`端口 ${port} 被占用了。可以在 config.json 里把 port 改成别的数字再试。`);
        process.exit(1);
      }
    }
  }

  console.log('');
  console.log('  AI 圆桌 已启动');
  console.log(`  在浏览器打开：${app.url}`);
  console.log('  关闭这个窗口就会退出');
  console.log('');
  for (const m of app.memberSummary()) {
    const status = !m.enabled ? '已关闭' : m.ready ? '就绪' : `需要设置（${m.reason}）`;
    console.log(`  - ${m.name.padEnd(7)} ${m.providerLabel}：${status}`);
  }
  console.log('');
  openBrowser(app.url);
}

function shutdown() {
  app.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('启动失败：', e.message);
  process.exit(1);
});
