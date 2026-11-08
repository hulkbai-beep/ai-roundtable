'use strict';

// 只在 Windows 上运行：检查长文本（多行、中文、引号、特殊符号）能原样传给 .exe 程序。
// agy.exe 和 claude.exe 都是这样收到提示词的。

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runProcess, resolveCommand, planCommand } = require('../lib/spawn');
const { IS_WIN, tmpDir } = require('./helpers');

const ECHO_CS = `
using System;
using System.Text;
class EchoArgs {
  static string Esc(string s) {
    var b = new StringBuilder("\\"");
    foreach (char c in s) {
      switch (c) {
        case '"': b.Append("\\\\\\""); break;
        case '\\\\': b.Append("\\\\\\\\"); break;
        case '\\n': b.Append("\\\\n"); break;
        case '\\r': b.Append("\\\\r"); break;
        case '\\t': b.Append("\\\\t"); break;
        default:
          if (c < 0x20) b.AppendFormat("\\\\u{0:x4}", (int)c); else b.Append(c);
          break;
      }
    }
    return b.Append('"').ToString();
  }
  static void Main(string[] a) {
    Console.OutputEncoding = new UTF8Encoding(false);
    var parts = new string[a.Length];
    for (int i = 0; i < a.Length; i++) parts[i] = Esc(a[i]);
    Console.Write("[" + string.Join(",", parts) + "]");
  }
}`;

function findCsc() {
  const root = process.env.WINDIR || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(root, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

test('Windows：找得到系统自带的命令', { skip: !IS_WIN }, () => {
  const cmd = resolveCommand('cmd');
  assert.ok(cmd && /cmd\.exe$/i.test(cmd), String(cmd));
  const plan = planCommand('cmd');
  assert.strictEqual(plan.viaShell, false);
});

test('Windows：长文本参数原样传给 .exe', { skip: !IS_WIN || !findCsc() }, async () => {
  const dir = tmpDir('rt-echo-');
  const src = path.join(dir, 'echo.cs');
  const exe = path.join(dir, 'echo-args.exe');
  fs.writeFileSync(src, ECHO_CS);
  execFileSync(findCsc(), ['/nologo', `/out:${exe}`, src], { windowsHide: true });

  const args = [
    '-p',
    '你正在参加一个多人群聊。\n第二行有"双引号"和 \\"反斜杠加引号\\"\n路径 C:\\Program Files\\x\\ 末尾反斜杠\\',
    '',
    '%PATH% 和 !不该被展开!',
    'a & b | c > d < e ^ f',
    'emoji 😀 结束',
  ];
  const res = await runProcess({ command: exe, args, timeoutMs: 20000 });
  assert.strictEqual(res.code, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout), args);
});
