'use strict';

// 识别“额度用完了”，并读出什么时候恢复。
//
// 各家的说法取自公开的文档和源码，test/unit.test.js 里有逐字的例子：
//  - Claude Code：官方的 Error reference（code.claude.com/docs/en/errors）
//  - Codex：openai/codex 的 codex-rs/protocol/src/error.rs（UsageLimitReachedError）
//  - Antigravity CLI：google-antigravity/antigravity-cli 的 CHANGELOG，加上用户贴出来的报错
//  - Gemini：google-gemini/gemini-cli 的 googleQuotaErrors.ts 和 Gemini API 的 429 返回
//  - 接口：HTTP 429 / 402 和 Retry-After（在 providers.js 的 httpError 里处理）
// 宁可漏认，不要错认：漏认只是这一轮报一次错、下一轮再试；错认会让这位成员被跳过。

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
const MINUTE = 60000;
const DAY = 86400000;
// 读出来的恢复时间比这还远，多半是读错了，当成不知道
const MAX_AHEAD_MS = 32 * DAY;
// 钟面时间刚过去一小会儿：是刚恢复，不是“明天这个点”
const JUST_PASSED_MS = 10 * MINUTE;

// ---------- 时区 ----------
// Claude Code 报的恢复时间后面带时区，例如 resets 3pm (America/Los_Angeles)。
// 一般就是本机时区，但按它写的时区来算更保险。

const zoneFormats = new Map();

// 认识这个时区就返回格式化工具；不认识（或者系统里没有时区数据）返回 null，调用方按本机时区算
function zoneFormat(tz) {
  if (!tz) return null;
  if (!zoneFormats.has(tz)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    } catch {
      /* 不认识的时区 */
    }
    if (zoneFormats.size > 100) zoneFormats.clear();
    zoneFormats.set(tz, f);
  }
  return zoneFormats.get(tz);
}

// ts 这一刻，在某个时区（tz 为空 = 本机时区）里是几年几月几日几点几分
function fieldsAt(ts, tz) {
  const d = new Date(ts);
  const f = zoneFormat(tz);
  if (!f) return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  const p = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
}

// 反过来：某个时区里的年月日时分 → 时间戳。日期可以越界（例如 d + 1），会自动进位
function toTs(y, mo, d, h, mi, tz) {
  if (!zoneFormat(tz)) return new Date(y, mo, d, h, mi, 0, 0).getTime();
  const wall = Date.UTC(y, mo, d, h, mi);
  const offsetAt = (ts) => {
    const f = fieldsAt(ts, tz);
    return Date.UTC(f.y, f.mo, f.d, f.h, f.mi) - ts;
  };
  // 算两遍：夏令时切换前后，第一遍用的偏移可能差一小时
  return wall - offsetAt(wall - offsetAt(wall));
}

function validDate(y, mon, day) {
  if (mon < 0 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(y, mon, day));
  return probe.getUTCMonth() === mon && probe.getUTCDate() === day;
}

// ---------- 什么时候恢复 ----------

const AFTER = String.raw`(?:resets?|try again|available again|retry|back)\b\s*(?:at|after|on|by)?\s*`;
// 月份和星期：缩写或全称（monthly、sunset 这样的词不算）
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const WEEKDAY = String.raw`(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b\.?`;
// 一段时长：2 hours 5 minutes / 1 day 3 hours / 34.07s / 16h20m33s / 143h57m55s / 6m0s
const DUR_PART = String.raw`\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec|ms|d|h|m|s)(?![a-z])`;
const DUR = `(?:${DUR_PART}[\\s,]*(?:and\\s+)?)+`;
// try again in 2 hours 5 minutes / Please retry in 34.07s / Your quota will reset after 16h20m33s / Resets in 143h57m55s.
const REL_RE = new RegExp(String.raw`(?:retry|try again|resets?|available|back)\b[^.\n|]{0,24}?\b(?:in|after|within)\s+(${DUR})`, 'i');
// Please wait 12345 seconds before retrying
const WAIT_RE = new RegExp(String.raw`\bwait(?:ing)?\s+(?:for\s+)?(?:about\s+)?(${DUR})`, 'i');
const SOON_RE = /(?:retry|try again|resets?|available|back)\b[^.\n|]{0,24}?\bin less than (?:a|one|1) minute/i;
// resets 2026-08-09 00:00 UTC
const ISO_RE = new RegExp(`${AFTER}(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})(?::\\d{2}(?:\\.\\d+)?)?\\s*(Z|UTC|GMT|[+-]\\d{2}:?\\d{2})?`, 'i');
// resets 3:45pm / resets 3pm (America/Los_Angeles) / resets Mon 12:00am / resets May 31 at 5pm (Asia/Shanghai) /
// try again at 3:05 PM / try again at Jan 2nd, 2026 9:36 PM / resets on November 1 at 00:00 UTC / resets at 15:00
const ABS_RE = new RegExp(
  AFTER +
    `(?:(?<weekday>${WEEKDAY}),?\\s+)?` +
    `(?:(?<month>${MONTH})\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?,?\\s*(?:(?<year>\\d{4}),?\\s*)?)?` +
    String.raw`(?:at\s+)?(?<hh>\d{1,2})(?::(?<mm>\d{2}))?(?::\d{2})?\s*(?:(?<ampm>[ap])\.?m\b\.?)?` +
    String.raw`(?:\s*\((?<tz>[A-Za-z][\w+-]*(?:\/[\w+-]+)*)\)|\s+(?<utc>UTC|GMT)\b)?`,
  'gi'
);
// 只有日期、没有钟点：resets Dec 1（Claude 的网关限额，说明是那天 UTC 0 点恢复）
const DATE_RE = new RegExp(`\\bresets?\\b\\s*(?:on\\s+)?(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'i');

function durationMs(s) {
  let ms = 0;
  for (const [, n, u] of String(s).matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = u.toLowerCase();
    ms += Number(n) * (unit === 'ms' ? 1 : UNIT_MS[unit[0]] || 0);
  }
  return ms;
}

function isoTime(m) {
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const zone = m[6];
  if (!zone) return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const off = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
  return off ? wall - (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * MINUTE : wall;
}

function clockTime(g, now) {
  // 只有一个数字（没有分钟也没有 am/pm）不算时间
  if (g.mm == null && !g.ampm) return null;
  let h = Number(g.hh);
  const mi = Number(g.mm || 0);
  if (g.ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (g.ampm.toLowerCase() === 'p' ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;

  const tz = zoneFormat(g.tz) ? g.tz : g.utc ? 'UTC' : null;
  const today = fieldsAt(now, tz);
  const at = (y, mo, d) => toTs(y, mo, d, h, mi, tz);
  const passed = (ts) => ts < now - JUST_PASSED_MS;

  if (g.month) {
    const mon = MONTHS.indexOf(g.month.slice(0, 3).toLowerCase());
    const day = Number(g.day);
    const y = g.year ? Number(g.year) : today.y;
    if (!validDate(g.year ? y : 2024, mon, day)) return null; // 2 月 30 日这种不存在的日期
    // 没写年份、算出来又早就过去了：说的是明年
    return !g.year && passed(at(y, mon, day)) ? at(y + 1, mon, day) : at(y, mon, day);
  }
  if (g.weekday) {
    const todayWd = new Date(Date.UTC(today.y, today.mo, today.d)).getUTCDay();
    const diff = (WEEKDAYS.indexOf(g.weekday.slice(0, 3).toLowerCase()) - todayWd + 7) % 7;
    const ts = at(today.y, today.mo, today.d + diff);
    return passed(ts) ? at(today.y, today.mo, today.d + diff + 7) : ts;
  }
  const ts = at(today.y, today.mo, today.d);
  return passed(ts) ? at(today.y, today.mo, today.d + 1) : ts;
}

function dateOnly(m, now) {
  const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]);
  const y = m[3] ? Number(m[3]) : new Date(now).getUTCFullYear();
  if (!validDate(m[3] ? y : 2024, mon, day)) return null;
  const ts = Date.UTC(y, mon, day);
  return !m[3] && ts < now - JUST_PASSED_MS ? Date.UTC(y + 1, mon, day) : ts;
}

// 从工具的报错里找出“什么时候恢复”（毫秒时间戳）；找不到返回 null
function parseResetAt(text, now = Date.now()) {
  const t = String(text || '');
  let ts = null;
  let m;
  // 旧版 Claude Code：Claude AI usage limit reached|1736000000
  if ((m = t.match(/\|(\d{10})(?!\d)/))) ts = Number(m[1]) * 1000;
  else if ((m = t.match(ISO_RE))) ts = isoTime(m);
  else if ((m = t.match(REL_RE)) || (m = t.match(WAIT_RE))) ts = now + durationMs(m[1]);
  else if (SOON_RE.test(t)) ts = now + MINUTE;
  else {
    for (const hit of t.matchAll(ABS_RE)) {
      ts = clockTime(hit.groups, now);
      if (ts != null) break;
    }
    if (ts == null && (m = t.match(DATE_RE))) ts = dateOnly(m, now);
  }
  if (ts == null || !Number.isFinite(ts)) return null;
  if (ts - now > MAX_AHEAD_MS) return null;
  // 已经到点（或者工具说“0 秒后再试”）：马上就能再试
  return Math.round(Math.max(ts, now + 1000));
}

// ---------- 是不是额度用完了 ----------

// 说的是别的“上限”（上下文太长、输出太长、轮数、线程数……），不是账号的额度
const NOT_USAGE_RE = /context|token|turn|output|length|size|thread|depth|recursion|file|upload|attachment|character|iteration|step|tool|timeout|retr(?:y|ies)/i;

// 只说“请求太频繁”、没说要等多久时，先过这么久再试（额度用完则是一小时，见 usage.js）
const BRIEF_RETRY_MS = 5 * MINUTE;

// “某某 limit reached”里的某某。Context limit reached、agent thread limit reached 这些不算
const KINDS = 'usage|5-hour|five-hour|hourly|session|daily|weekly|monthly|opus|sonnet|haiku|fable|model|plan|message|request|spend|spending|credit|quota';

// 额度（订阅的用量、余额、配额）用完了
const LIMIT_PATTERNS = [
  // Claude AI usage limit reached|… / 5-hour limit reached ∙ resets 9pm / Weekly limit reached / spend limit reached
  new RegExp(String.raw`\b(?:${KINDS}) limit (?:has been |was )?(?:reached|exceeded|hit)\b`, 'i'),
  // Codex：Your workspace is out of credits. ／ Claude Code：You're out of extra usage · resets 9am
  /\bout of (?:extra )?(?:usage|credits|quota)\b/i,
  // Antigravity：Individual quota reached. ／ Codex：Quota exceeded. Check your plan and billing details. ／ Gemini：Quota exceeded for metric …
  /\bquota(?: limit)? (?:has been |was )?(?:reached|exceeded|exhausted)\b/i,
  /\bexceeded\b[^.\n]{0,20}\bquota\b/i,
  // Google 的 429：Resource has been exhausted (e.g. check quota).
  /\bresource has been exhausted\b/i,
  /insufficient_quota|usage_limit_reached|QUOTA_EXHAUSTED|INSUFFICIENT_G1_CREDITS_BALANCE/,
  // Claude Code：Credit balance is too low ／ Antigravity：Your AI credits balance is too low to continue. ／ OpenRouter：Insufficient credits
  /\bcredits? balance is too low\b|\binsufficient (?:credits?|balance|funds|quota)\b/i,
  // Gemini API：… exceeded its monthly spending cap
  /\b(?:hit|reached|exceeded)\b[^.\n]{0,40}\bspend(?:ing)? cap\b/i,
];

// 请求太频繁（rate limit）：也要先跳过这位成员，但一般过几分钟就好
const RATE_PATTERNS = [
  // 旧版 Claude Code：API Error: Rate limit reached ／ Codex：rate limit exceeded: … ／ OpenAI：Rate limit reached for gpt-4o in organization …
  /\brate limit (?:has been |was )?(?:reached|exceeded|hit)\b/i,
  // GitHub Models：Rate limit of 50 per 86400s exceeded for UserByModelByDay.
  /\brate limit of \d+ per \d+s exceeded\b/i,
  // Codex 自己重试了几次，服务器一直回 429：exceeded retry limit, last status: 429 Too Many Requests ／ unexpected status 429 Too Many Requests: …
  /\b(?:last|unexpected) status:? 429\b/i,
];

// You've hit your session limit · resets 3:45pm ／ You’ve hit your usage limit. ／ You hit your spend cap set in your workspace. ／
// You've hit your team's shared budget ／ You have exhausted your capacity on this model. ／ You exceeded your current quota ／
// This request would exceed your account's rate limit.
const YOUR_LIMIT_RE = /\b(?:hit|reached|exceed(?:s|ed)?|exhausted) your\b((?:[^.\n]|\.(?=\S)){0,40}?)\b(?:limit|quota|cap|capacity|credits|budget)\b/gi;

// gRPC 也用 RESOURCE_EXHAUSTED 表示“消息太大”，那不是额度
function resourceExhausted(t) {
  return /RESOURCE_EXHAUSTED/.test(t) && !/larger than max|message size|too large|too long/i.test(t);
}

// 'usage' = 额度用完，'rate' = 只是请求太频繁，null = 都不是
function limitKind(t) {
  if (LIMIT_PATTERNS.some((re) => re.test(t)) || resourceExhausted(t)) return 'usage';
  let rate = RATE_PATTERNS.some((re) => re.test(t));
  for (const m of t.matchAll(YOUR_LIMIT_RE)) {
    if (NOT_USAGE_RE.test(m[1])) continue;
    if (!/\brate\b/i.test(m[1])) return 'usage';
    rate = true;
  }
  return rate ? 'rate' : null;
}

// 判断一段工具输出是不是“额度用完了”；是的话返回 { resetAt }（读不出时间时 resetAt 为 null），否则返回 null。
// 只是请求太频繁、又没说等多久时，另外带上 retryInMs（过几分钟再试，不用等一小时）。
// 传进来的应该只是工具自己说的话：聊天内容要先用 stripEcho 去掉。
function detectLimit(text, now = Date.now()) {
  const t = String(text || '');
  const kind = limitKind(t);
  if (!kind) return null;
  const resetAt = parseResetAt(t, now);
  return kind === 'rate' && resetAt == null ? { resetAt, retryInMs: BRIEF_RETRY_MS } : { resetAt };
}

// 有的工具额度用完时不报错，而是把那句话当成回复正常输出。
// 只认“整条回复就是工具的这句话”的情况：很短，开头就是，后面跟的也是工具才会说的内容；聊天里提到这些词不算。
const LIMIT_REPLY_RE = new RegExp(
  '^(?:' +
    String.raw`(?:claude(?: ai)? )?usage limit reached` +
    String.raw`|you(?:['’]ve| have)? (?:hit|reached) your (?<what>(?:[\w'’.-]+ ){0,4}?)(?:limit|budget|quota)\b(?: for [\w.-]+)?` +
    String.raw`|you(?:['’]re| are) out of (?:extra usage|usage credits|usage|credits)\b` +
    String.raw`|(?:5-hour|five-hour|session|weekly|daily|monthly|opus|sonnet|haiku|fable|spend|rate) limit reached` +
    String.raw`|individual quota reached` +
    String.raw`|you have exhausted your capacity(?: on this model)?` +
    String.raw`|credit balance is too low` +
    ')' +
    // 这句话到这里就完了：后面是结尾、句号，或者 “ · resets 3pm”“|时间戳” 这样的分隔。接着往下说的（…limit, so let's…）是聊天
    String.raw`(?=\s*(?:$|[·∙•|.]))`,
  'i'
);
// 那句话后面还有内容的话，得是工具才会说的：什么时候恢复、怎么升级、找谁加额度
const REPLY_TAIL_RE = /\bresets?\b|\bwill reset\b|\btry again\b|\bupgrade\b|\braise it\b|\badmin(?:s|istrators?)?\b|\/extra-usage\b|claude\.ai\/|chatgpt\.com\/|^\d{10}$/i;

function limitReply(text, now = Date.now()) {
  const t = String(text || '').trim();
  if (!t || t.length > 300 || t.split('\n').length > 3) return null;
  // 开头可能有 ⚠ 这样的符号，或者 “API Error: ”（只去掉符号和空白：前面有别的字，就是在聊天里提到这句话）
  const body = t.replace(/^[\s\p{P}\p{S}\p{M}\p{Cf}]*(?:(?:API )?Error:\s*)?/iu, '');
  const m = body.match(LIMIT_REPLY_RE);
  if (!m || (m.groups.what && NOT_USAGE_RE.test(m.groups.what))) return null;
  const rest = body.slice(m[0].length).replace(/^[\s\p{P}\p{S}]+/u, '');
  if (rest && !REPLY_TAIL_RE.test(rest)) return null;
  return detectLimit(t, now) || { resetAt: parseResetAt(t, now) };
}

// ---------- 接口返回里的恢复时间 ----------

// 接口说的“多久之后再试”：Retry-After 头（秒数或日期）、retry-after-ms，或者 Gemini 报错里的 retryDelay（"34s"）
function retryAfterAt(headers, body, now = Date.now()) {
  const h = headers || {};
  const ahead = (ms) => (ms >= 0 && ms <= MAX_AHEAD_MS ? now + Math.max(ms, 1000) : null);
  const ra = String(h['retry-after'] == null ? '' : h['retry-after']).trim();
  if (/^\d+(?:\.\d+)?$/.test(ra)) return ahead(Number(ra) * 1000);
  if (ra && Number.isFinite(Date.parse(ra))) return ahead(Math.max(Date.parse(ra) - now, 0));
  const raMs = String(h['retry-after-ms'] == null ? '' : h['retry-after-ms']).trim();
  if (/^\d+(?:\.\d+)?$/.test(raMs)) return ahead(Number(raMs));
  const details = body && body.error && Array.isArray(body.error.details) ? body.error.details : [];
  for (const d of details) {
    if (d && typeof d.retryDelay === 'string' && /^\s*\d/.test(d.retryDelay)) return ahead(durationMs(d.retryDelay));
  }
  return null;
}

// Gemini API 的 429：按天算的额度（quotaId 里带 PerDay）要到太平洋时间午夜才恢复。
// 这种时候返回里的 retryDelay 常常只有几十秒，不能信
function dailyQuotaResetAt(body, now = Date.now()) {
  const details = body && body.error && Array.isArray(body.error.details) ? body.error.details : [];
  const perDay = details.some((d) => d && Array.isArray(d.violations) && d.violations.some((v) => v && /PerDay|Daily/i.test(String(v.quotaId || ''))));
  const tz = 'America/Los_Angeles';
  if (!perDay || !zoneFormat(tz)) return null;
  const f = fieldsAt(now, tz);
  return toTs(f.y, f.mo, f.d + 1, 0, 0, tz);
}

// ---------- 小工具 ----------

// 有的命令行工具（codex exec）会把收到的提示词原样打印出来。
// 判断额度之前先把这些行去掉，免得聊天内容里的“额度用完了”被当成工具的报错。
function stripEcho(output, ...prompts) {
  const echoed = new Set();
  for (const p of prompts) {
    for (const line of String(p || '').split(/\r?\n/)) {
      const l = line.trim();
      if (l) echoed.add(l);
    }
  }
  if (!echoed.size) return String(output || '');
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => !echoed.has(line.trim()))
    .join('\n');
}

// 按系统语言加了分隔符的整数：12,345 / 12.345 / 12 345 / 12’345 / ١٢٬٣٤٥。读不出来返回 null
function parseLocaleInt(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t || t.length > 40 || /[a-z]/i.test(t)) return null;
  let digits = '';
  for (const ch of t) {
    if (ch >= '0' && ch <= '9') digits += ch;
    else if (/\p{Nd}/u.test(ch)) {
      // 其他文字的数字：每一组都是 0 到 9 连着排的
      const cp = ch.codePointAt(0);
      let zero = cp;
      while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
      digits += (cp - zero) % 10;
    }
  }
  if (!digits || digits.length > 15) return null;
  return Number(digits);
}

module.exports = { detectLimit, parseResetAt, limitReply, retryAfterAt, dailyQuotaResetAt, stripEcho, parseLocaleInt, BRIEF_RETRY_MS };
