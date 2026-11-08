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

// 解析 npm 生成的 xxx.cmd，找到它真正要运行的脚本或程序
function parseCmdShim(shimPath, opts = {}) {
  const {
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    exists = isFile,
    platform = process.platform,
    nodePath = process.execPath,
  } = opts;
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
  if (['.js', '.cjs', '.mjs'].includes(ext)) return { file: nodePath, prefixArgs: [target] };
  if (['.exe', '.com'].includes(ext)) return { file: target, prefixArgs: [] };
  return null;
}

function planCommand(cmd, opts = {}) {
  const resolved = resolveCommand(cmd, opts);
  if (!resolved) return null;
  if (!IS_WIN) return { file: resolved, prefixArgs: [], viaShell: false, resolved };
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: resolved, prefixArgs: [], viaShell: false, resolved };
  const shim = parseCmdShim(resolved);
  if (shim) return { ...shim, viaShell: false, resolved };
  return { file: resolved, prefixArgs: [], viaShell: true, resolved };
}

function cmdSafe(arg) {
  return !/["%!\r\n]/.test(String(arg));
}

function quoteForCmd(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (/^[\w\-+=.,:/\\@]+$/.test(s)) return s;
  if (!cmdSafe(s)) {
    throw new UserError('这个参数包含特殊字符，无法通过 .cmd 脚本安全传递', '请在设置里把命令改成对应 .exe 程序的完整路径');
  }
  return `"${s}"`;
}

function notFound(command) {
  return new UserError(
    `找不到命令「${command}」`,
    '确认已经安装好；刚装完的话，关掉圆桌的黑色窗口再重新双击 start.bat；还不行就在设置里填写它的完整路径'
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
        env,
        shell: p.viaShell,
        windowsHide: true,
        detached: !IS_WIN,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new UserError(`无法启动「${command}」：${e.message}`));
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
      if (reason === 'abort') {
        const e = new Error('已停止');
        e.aborted = true;
        return reject(e);
      }
      if (reason === 'timeout') {
        return reject(
          new UserError(
            `等了 ${Math.round(timeoutMs / 1000)} 秒还没有回复，已放弃`,
            '可以在设置里把超时调长一些；如果每次都这样，先在命令行里手动运行一次，确认它本身能正常工作'
          )
        );
      }
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    };

    child.on('error', (e) => {
      if (settled) return;
      cleanup();
      reject(e.code === 'ENOENT' ? notFound(command) : new UserError(`运行「${command}」出错：${e.message}`));
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
      `「${command}」是通过 .cmd/.bat 脚本启动的，没法安全地传递长文本`,
      '在设置里把命令改成对应 .exe 程序的完整路径，或者把「提示词传递方式」改成「标准输入」'
    );
  }
  let active = groups.filter((g) => !droppedGroups.has(`${cacheKey}:${g.key}`) && (!plan.viaShell || g.args.every(cmdSafe)));
  for (let attempt = 0; attempt <= groups.length; attempt++) {
    const args = [...before, ...active.flatMap((g) => g.args), ...after];
    const keys = active.map((g) => g.key);
    const res = await runProcess({
      ...rest,
      command,
      plan,
      args,
      input: typeof input === 'function' ? input(keys) : input,
    });
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
  throw new UserError(`「${command}」的参数不兼容`, '请把它更新到最新版本');
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
