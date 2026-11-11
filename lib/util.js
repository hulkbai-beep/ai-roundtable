'use strict';

const crypto = require('crypto');

// 去掉终端颜色控制符
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

// 一个表情符号在字符串里占两个位置（代理对）。截断时不能只留半个：
// 半个字符写进请求以后，有的接口会拒收整个请求。
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;

// 取开头最多 n 个字
function cut(s, n) {
  const t = String(s == null ? '' : s);
  if (t.length <= n) return t;
  return t.slice(0, isHighSurrogate(t.charCodeAt(n - 1)) ? n - 1 : n);
}

// 取字符串末尾一段（用于错误信息）
function tail(s, n = 500) {
  const t = String(s == null ? '' : s).trim();
  if (t.length <= n) return t;
  const from = t.length - n;
  return `…${t.slice(isLowSurrogate(t.charCodeAt(from)) ? from + 1 : from)}`;
}

function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// 把 "a b 'c d'" 这样的字符串拆成参数数组
function splitArgs(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(str || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

function maskSecret(s) {
  if (!s) return '';
  const t = String(s);
  if (t.length <= 10) return '****';
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 给用户看的错误：message 说明发生了什么，hint 说明怎么办
class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
    this.userFacing = true;
  }
}

module.exports = { stripAnsi, tail, cut, uid, splitArgs, maskSecret, clamp, safeJson, UserError };
