'use strict';

// 界面语言：中文（zh）或英文（en）。设置里留空 = 跟随系统语言。
// 服务端的提示和错误用 tr('中文', 'English')；静态的说明文字用 L(...) 存两种语言，发给界面前再用 loc() 选一种。

const listeners = new Set();
let lang = 'zh';

function systemLang() {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    return /^zh/i.test(loc) ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

function resolveLang(v) {
  return v === 'en' || v === 'zh' ? v : systemLang();
}

function setLang(v) {
  const next = resolveLang(v);
  if (next === lang) return;
  lang = next;
  for (const fn of listeners) fn(lang);
}

const getLang = () => lang;
const tr = (zh, en) => (lang === 'en' ? en : zh);
const L = (zh, en) => ({ zh, en });
const isL = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && 'zh' in v && 'en' in v;

// 把对象里所有 L(...) 换成当前语言的文字
function loc(v) {
  if (isL(v)) return v[lang];
  if (Array.isArray(v)) return v.map(loc);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, loc(x)]));
  return v;
}

function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

setLang('');

module.exports = { tr, L, loc, getLang, setLang, resolveLang, onLangChange };
