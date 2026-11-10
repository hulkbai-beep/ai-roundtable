'use strict';

// 桌面版入口（Electron）：在本机启动 AI 圆桌的服务，然后在独立窗口里显示界面。
// 界面和浏览器版完全一样（public/），后台逻辑在 lib/。

const { app, BrowserWindow, Menu, shell, dialog, session, nativeTheme, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tr, onLangChange } = require('../lib/i18n');

const ROOT = path.join(__dirname, '..');
const HOMEPAGE = 'https://github.com/hulkbai-beep/ai-roundtable#readme';

// ---------- 命令行参数（主要给自动测试用） ----------
//   --data-dir=<目录>    使用指定的数据目录（默认是 %APPDATA%\AI Roundtable）
//   --port=<端口>        固定端口（默认 3939，被占用时随机挑一个）
//   --smoke-out=<文件>   冒烟测试：界面加载成功后把结果写进文件并退出

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const SMOKE_OUT = argValue('smoke-out');
const DATA_DIR = argValue('data-dir');
const PORT_ARG = argValue('port');

if (DATA_DIR) app.setPath('userData', path.resolve(DATA_DIR));
const userData = app.getPath('userData');

// ---------- 日志：写到 数据目录\logs\main.log ----------

const logDir = path.join(userData, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'main.log');
try {
  if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
} catch {
  /* 还没有日志 */
}
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function fmtLog(x) {
  if (x instanceof Error) return x.stack || x.message;
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    orig(...a);
    logStream.write(`[${new Date().toISOString()}] [${level}] ${a.map(fmtLog).join(' ')}\n`);
  };
}
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

// ---------- Windows：从注册表补全 PATH ----------
// 刚装好的 claude / agy 可能还没进到当前进程的 PATH 里，这里再读一遍用户和系统的 PATH。

function refreshWindowsPath() {
  if (process.platform !== 'win32' || process.env.AI_ROUNDTABLE_NO_PATH_REFRESH) return;
  const read = (key) => {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      const m = out.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
      return m ? m[1].trim() : '';
    } catch {
      return '';
    }
  };
  const expand = (s) => s.replace(/%([^%]+)%/g, (m, name) => (process.env[name] == null ? m : process.env[name]));
  const parts = [
    ...String(process.env.PATH || '').split(';'),
    ...expand(read('HKCU\\Environment')).split(';'),
    ...expand(read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')).split(';'),
  ];
  const seen = new Set();
  const merged = [];
  for (const p of parts) {
    const t = p.trim();
    const key = t.toLowerCase().replace(/\\+$/, '');
    if (!t || seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  process.env.PATH = merged.join(';');
}

// ---------- 窗口位置和大小 ----------

const windowStateFile = path.join(userData, 'window.json');

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width - 80 && s.x + s.width > a.x + 80 && s.y >= a.y - 20 && s.y < a.y + a.height - 80;
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return {};
  }
}

function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(windowStateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* 存不了就算了 */
  }
}

// ---------- 菜单 ----------

function buildMenu(win) {
  const template = [
    {
      label: tr('文件', 'File'),
      submenu: [
        { label: tr('打开数据文件夹', 'Open data folder'), click: () => shell.openPath(userData) },
        { label: tr('打开日志', 'Open log'), click: () => shell.openPath(logFile) },
        { type: 'separator' },
        { role: 'quit', label: tr('退出', 'Quit') },
      ],
    },
    {
      label: tr('编辑', 'Edit'),
      submenu: [
        { role: 'undo', label: tr('撤销', 'Undo') },
        { role: 'redo', label: tr('重做', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: tr('剪切', 'Cut') },
        { role: 'copy', label: tr('复制', 'Copy') },
        { role: 'paste', label: tr('粘贴', 'Paste') },
        { role: 'selectAll', label: tr('全选', 'Select all') },
      ],
    },
    {
      label: tr('查看', 'View'),
      submenu: [
        { role: 'reload', label: tr('重新加载', 'Reload') },
        { role: 'toggleDevTools', label: tr('开发者工具', 'Developer tools') },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('实际大小', 'Actual size') },
        { role: 'zoomIn', label: tr('放大', 'Zoom in') },
        { role: 'zoomOut', label: tr('缩小', 'Zoom out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tr('全屏', 'Full screen') },
      ],
    },
    {
      label: tr('帮助', 'Help'),
      submenu: [
        { label: tr('使用说明', 'User guide'), click: () => shell.openExternal(HOMEPAGE) },
        {
          label: tr('关于 AI 圆桌', 'About AI Roundtable'),
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              title: tr('关于 AI 圆桌', 'About AI Roundtable'),
              message: tr(`AI 圆桌 ${app.getVersion()}`, `AI Roundtable ${app.getVersion()}`),
              detail: tr(`让 Claude、Gemini、GPT 在同一个群里聊天。\n\n数据保存在：${userData}`, `Claude, Gemini and GPT in one group chat.\n\nData folder: ${userData}`),
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 启动 ----------

let appServer = null;
let mainWindow = null;

async function startServer() {
  const { createAppServer } = require('../lib/app-server');
  appServer = createAppServer({ dataDir: userData, publicDir: path.join(ROOT, 'public') });
  const wanted = PORT_ARG ? Number(PORT_ARG) : 3939;
  try {
    await appServer.listen(wanted);
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || PORT_ARG) throw e;
    await appServer.listen(0); // 3939 被占用（比如浏览器版也开着），随便挑一个空闲端口
  }
  console.log(`AI Roundtable ${app.getVersion()} started: ${appServer.url}, data: ${userData}`);
  return appServer.url;
}

function createWindow(url) {
  const state = loadWindowState();
  const devIcon = path.join(ROOT, 'build', 'icon.png');
  const win = new BrowserWindow({
    width: state.width || 1120,
    height: state.height || 820,
    x: state.x,
    y: state.y,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: tr('AI 圆桌', 'AI Roundtable'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#ededed',
    autoHideMenuBar: true,
    ...(fs.existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => saveWindowState(win));

  // 消息里的外部链接用系统浏览器打开；窗口本身只显示本机页面
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (target === origin || target.startsWith(`${origin}/`)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
  });

  buildMenu(win);
  onLangChange(() => {
    if (!win.isDestroyed()) buildMenu(win);
  });
  win.loadURL(url);
  return win;
}

async function runSmokeTest(win) {
  const result = { ok: false, version: app.getVersion(), url: appServer && appServer.url, userData };
  try {
    await new Promise((resolve) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', resolve) : resolve()));
    const r = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        const members = document.querySelectorAll('#members .member').length;
        if (members >= 3) return resolve({ members, title: document.title, desktopClass: document.documentElement.classList.contains('desktop') });
        if (Date.now() - t0 > 20000) return resolve({ members });
        setTimeout(poll, 200);
      })();
    })`);
    Object.assign(result, r, { ok: r.members >= 3 && r.desktopClass === true });
  } catch (e) {
    result.error = String((e && e.stack) || e);
  }
  fs.writeFileSync(SMOKE_OUT, JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  if (process.platform === 'win32') app.setAppUserModelId('com.hulkbai.ai-roundtable');

  app.whenReady().then(async () => {
    if (SMOKE_OUT) {
      setTimeout(() => {
        fs.writeFileSync(SMOKE_OUT, JSON.stringify({ ok: false, error: 'timeout' }));
        app.exit(3);
      }, 90000).unref();
    }
    try {
      refreshWindowsPath();
      session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
      session.defaultSession.on('will-download', (e, item) => {
        item.setSaveDialogOptions({
          title: tr('导出对话', 'Export chat'),
          defaultPath: path.join(app.getPath('documents'), item.getFilename()),
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
      });
      const url = await startServer();
      mainWindow = createWindow(url);
      mainWindow.on('closed', () => (mainWindow = null));
      if (SMOKE_OUT) runSmokeTest(mainWindow);
    } catch (e) {
      console.error(tr('启动失败', 'Failed to start'), e);
      if (SMOKE_OUT) {
        fs.writeFileSync(SMOKE_OUT, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
        app.exit(1);
        return;
      }
      dialog.showErrorBox(tr('AI 圆桌启动失败', 'AI Roundtable failed to start'), `${e.message}\n\n日志：${logFile}`);
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());

  let closing = false;
  app.on('before-quit', (e) => {
    if (closing || !appServer) return;
    e.preventDefault();
    closing = true;
    setTimeout(() => app.exit(0), 2500).unref();
    appServer
      .close()
      .catch((err) => console.error(err))
      .finally(() => app.quit());
  });
}
