'use strict';

// 负责在 Windows（以及 macOS/Linux）上可靠地启动命令行工具。
// 关键点：
//  - 优先直接启动 .exe，参数由 Node 正确转义，可以安全传递长文本；
//  - npm 装的 xxx.cmd 会被解析成 "node 脚本.js"，同样不经过 cmd.exe；
//  - 实在只能走 cmd.exe 时，只传简单参数，长文本一律走标准输入。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { UserError } = require('./util');
const { tr } = require('./i18n');
const { addRun } = require('./diag');

const IS_WIN = process.platform === 'win32';
const WIN_EXTS = ['.exe', '.cmd', '.bat', '.com'];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function envGet(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function expandPath(p, env = process.env) {
  return String(p)
    .replace(/%([^%]+)%/g, (m, name) => {
      const v = envGet(env, name);
      return v == null ? m : v;
    })
    .replace(/^~(?=$|[\\/])/, os.homedir());
}

// 在 PATH 和常见安装位置里找到命令对应的文件
function resolveCommand(cmd, opts = {}) {
  const { candidates = [], env = process.env, platform = process.platform, exists = isFile } = opts;
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const raw = expandPath(String(cmd || '').trim().replace(/^"(.*)"$/, '$1'), env);
  if (!raw) return null;

  const variants = (base) => {
    if (!win) return [base];
    return WIN_EXTS.includes(P.extname(base).toLowerCase()) ? [base] : WIN_EXTS.map((e) => base + e);
  };
  const tryAll = (base) => variants(base).find((c) => exists(c)) || null;

  if (/[\\/]/.test(raw)) return tryAll(raw);

  const dirs = String(envGet(env, 'PATH') || '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  for (const dir of dirs) {
    const hit = tryAll(P.join(dir, raw));
    if (hit) return hit;
  }
  for (const c of candidates) {
    const hit = tryAll(expandPath(c, env));
    if (hit) return hit;
  }
  return null;
}

// 解析 npm 生成的 xxx.cmd，找到它真正要运行的脚本（{ script }）或程序（{ file }）
function parseCmdShim(shimPath, opts = {}) {
  const { readFile = (p) => fs.readFileSync(p, 'utf8'), exists = isFile, platform = process.platform } = opts;
  let text;
  try {
    text = readFile(shimPath);
  } catch {
    return null;
  }
  const m = text.match(/"%~?dp0%?\\([^"\r\n]+?)"\s+%\*/i);
  if (!m) return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const target = P.join(P.dirname(shimPath), m[1]);
  if (!exists(target)) return null;
  const ext = P.extname(target).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) return { script: target };
  if (['.exe', '.com'].includes(ext)) return { file: target };
  return null;
}

// npm 脚本需要用 Node 运行：优先用 npm 目录里的 node.exe，其次 PATH 里的 node；
// 都没有时，桌面版（Electron）可以用自带的 Node。
function findNode(shimDir) {
  const local = path.join(shimDir, 'node.exe');
  if (isFile(local)) return { file: local, env: null };
  const onPath = resolveCommand('node');
  if (onPath && /\.exe$/i.test(onPath)) return { file: onPath, env: null };
  if (process.versions.electron) return { file: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { file: process.execPath, env: null };
}

function planCommand(cmd, opts = {}) {
  const resolved = resolveCommand(cmd, opts);
  if (!resolved) return null;
  if (!IS_WIN) return { file: resolved, prefixArgs: [], env: null, viaShell: false, resolved };
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: resolved, prefixArgs: [], env: null, viaShell: false, resolved };
  const shim = parseCmdShim(resolved);
  if (shim && shim.script) {
    const node = findNode(path.dirname(resolved));
    return { file: node.file, prefixArgs: [shim.script], env: node.env, viaShell: false, resolved };
  }
  if (shim && shim.file) return { file: shim.file, prefixArgs: [], env: null, viaShell: false, resolved };
  return { file: resolved, prefixArgs: [], env: null, viaShell: true, resolved };
}

function cmdSafe(arg) {
  return !/["%!\r\n]/.test(String(arg));
}

function quoteForCmd(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (/^[\w\-+=.,:/\\@]+$/.test(s)) return s;
  if (!cmdSafe(s)) {
    throw new UserError(tr('这个参数包含特殊字符，无法通过 .cmd 脚本安全传递', 'This argument has special characters that cannot be passed safely through a .cmd script'), tr('请在设置里把命令改成对应 .exe 程序的完整路径', 'In Settings, change the command to the full path of the matching .exe'));
  }
  return `"${s}"`;
}

function notFound(command) {
  return new UserError(
    tr(`找不到命令「${command}」`, `Command not found: ${command}`),
    tr('确认已经安装好；刚装完的话，关掉圆桌的黑色窗口再重新双击 start.bat；还不行就在设置里填写它的完整路径', 'Make sure it is installed. If you just installed it, restart AI Roundtable. If it still fails, enter its full path in Settings')
  );
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000).unref();
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function runProcess({ command, plan, args = [], input = null, cwd, env, timeoutMs = 180000, signal }) {
  return new Promise((resolve, reject) => {
    const p = plan || planCommand(command);
    if (!p) return reject(notFound(command));
    let file = p.file;
    let argv = [...p.prefixArgs, ...args];
    if (p.viaShell) {
      try {
        file = quoteForCmd(file);
        argv = argv.map(quoteForCmd);
      } catch (e) {
        return reject(e);
      }
    }

    const started = Date.now();
    let child;
    try {
      child = spawn(file, argv, {
        cwd,
        env: p.env ? { ...(env || process.env), ...p.env } : env,
        shell: p.viaShell,
        windowsHide: true,
        detached: !IS_WIN,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new UserError(tr(`无法启动「${command}」：${e.message}`, `Could not start ${command}: ${e.message}`)));
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let reason = null;
    let exitTimer = null;
    const LIMIT = 8 * 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < LIMIT) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < LIMIT) stderr += d;
    });

    const onAbort = () => {
      reason = 'abort';
      killTree(child);
    };
    const timer = setTimeout(() => {
      reason = 'timeout';
      killTree(child);
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (code) => {
      if (settled) return;
      cleanup();
      // 被停止或超时的，把到那时为止的输出带在报错上（e.partial），只给诊断记录用：工具卡住之前说了什么，正是要看的。
      // 不让它被列出来：报错被打进日志时，输出（里面有聊天内容）不会跟着进去
      const partial = { code, stdout, stderr, ms: Date.now() - started };
      const withPartial = (e) => Object.defineProperty(e, 'partial', { value: partial, enumerable: false });
      if (reason === 'abort') {
        const e = new Error(tr('已停止', 'Stopped'));
        e.aborted = true;
        return reject(withPartial(e));
      }
      if (reason === 'timeout') {
        const e = new UserError(
          tr(`等了 ${Math.round(timeoutMs / 1000)} 秒还没有回复，已放弃`, `No reply after ${Math.round(timeoutMs / 1000)} seconds; gave up`),
          tr('可以在设置里把超时调长一些；如果每次都这样，先在命令行里手动运行一次，确认它本身能正常工作', 'You can raise the timeout in Settings. If this happens every time, run the tool by hand in a terminal to check that it works')
        );
        return reject(withPartial(e));
      }
      resolve(partial);
    };

    child.on('error', (e) => {
      if (settled) return;
      cleanup();
      reject(e.code === 'ENOENT' ? notFound(command) : new UserError(tr(`运行「${command}」出错：${e.message}`, `Error running ${command}: ${e.message}`)));
    });
    // 有些程序退出后，残留的子进程还占着输出管道；退出 1.5 秒后不再等
    child.on('exit', (code) => {
      exitTimer = setTimeout(() => finish(code), 1500);
    });
    child.on('close', (code) => finish(code));

    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

// 不同版本的命令行工具支持的参数不一样：遇到“不认识的参数”就去掉那一组再试
const UNKNOWN_FLAG_PATTERNS = [
  /unknown option ['"`]?(--?[\w-]+)/i,
  /unexpected argument ['"`]?(--?[\w-]+)/i,
  /unknown (?:shorthand )?flag:? ['"`]?(--?[\w-]+)/i,
  /unrecognized (?:option|argument)s?:? ['"`]?(--?[\w-]+)/i,
  /flag provided but not defined:? ['"`]?(-{1,2}[\w-]+)/i,
];

function findUnknownFlag(text) {
  for (const re of UNKNOWN_FLAG_PATTERNS) {
    const m = String(text).match(re);
    if (m) return m[1];
  }
  return null;
}

const droppedGroups = new Set();

async function runAdaptive({ cacheKey, command, candidates, before = [], groups = [], after = [], input, requireDirect = false, ...rest }) {
  const plan = planCommand(command, { candidates });
  if (!plan) throw notFound(command);
  if (requireDirect && plan.viaShell) {
    throw new UserError(
      tr(`「${command}」是通过 .cmd/.bat 脚本启动的，没法安全地传递长文本`, `${command} starts through a .cmd/.bat script, which cannot safely pass long text`),
      tr('在设置里把命令改成对应 .exe 程序的完整路径，或者把「提示词传递方式」改成「标准输入」', 'In Settings, change the command to the full path of the .exe, or set "How to pass the prompt" to "Standard input"')
    );
  }
  let active = groups.filter((g) => !droppedGroups.has(`${cacheKey}:${g.key}`) && (!plan.viaShell || g.args.every(cmdSafe)));
  for (let attempt = 0; attempt <= groups.length; attempt++) {
    const args = [...before, ...active.flatMap((g) => g.args), ...after];
    const keys = active.map((g) => g.key);
    const text = typeof input === 'function' ? input(keys) : input;
    let res;
    try {
      res = await runProcess({ ...rest, command, plan, args, input: text });
    } catch (e) {
      addRun({ command, plan, args, input: text, ...(e && e.partial), error: e && e.aborted ? 'stopped' : String((e && e.message) || e) });
      throw e;
    }
    // 记进诊断记录（lib/diag.js）；不在一次发言里时什么也不做
    addRun({ command, plan, args, input: text, ...res });
    if (res.code !== 0) {
      const flag = findUnknownFlag(`${res.stderr}\n${res.stdout}`);
      const g = flag && active.find((x) => x.args.some((a) => a === flag || a.startsWith(`${flag}=`)));
      if (g) {
        droppedGroups.add(`${cacheKey}:${g.key}`);
        active = active.filter((x) => x !== g);
        continue;
      }
    }
    return { ...res, activeKeys: keys, plan };
  }
  throw new UserError(tr(`「${command}」的参数不兼容`, `${command} does not accept these arguments`), tr('请把它更新到最新版本', 'Update it to the latest version'));
}

function detectCommand(command, candidates) {
  try {
    const plan = planCommand(command, { candidates });
    return plan ? { found: true, path: plan.resolved, viaShell: plan.viaShell } : { found: false };
  } catch {
    return { found: false };
  }
}

module.exports = {
  resolveCommand,
  parseCmdShim,
  planCommand,
  quoteForCmd,
  runProcess,
  runAdaptive,
  detectCommand,
  findUnknownFlag,
  killTree,
};
