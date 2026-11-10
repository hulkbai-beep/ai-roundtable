'use strict';

// 用量记录：每位成员每次发言用了多少 token，以及谁的额度用完了。
// 存在数据目录的 usage.json 里，只保留最近 30 天。
// 订阅的真实额度（Max、AI Pro、ChatGPT）官方不公开具体数字，所以这里只记“用了多少”；
// “用完了”靠命令行工具或接口返回的报错来判断（见 limits.js）。
//
// token 的算法各家统一成：合计 = 没走缓存的输入 + 输出（Codex 自己报的就是这个数）。
// 走缓存的输入另外记在 cached 里：它便宜得多，算进合计会让数字虚高。

const fs = require('fs');
const EventEmitter = require('events');

const MINUTE = 60 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX_EVENTS = 20000;
// 不知道什么时候恢复时，过一小时自动再试一次
const UNKNOWN_RESET_MS = 60 * MINUTE;
// 工具说的恢复时间只精确到分钟，到点后稍等一下再试（最多一分钟）
const RETRY_MARGIN_MS = MINUTE;
// 到了工具说的时间，一试又是额度用完：它报的时间不准，改成隔一段时间再试，越隔越久
const BACKOFF_MS = [5 * MINUTE, 15 * MINUTE, UNKNOWN_RESET_MS];
// 标记到时间后这么久之内又用完，算“一试又用完”
const STRIKE_WINDOW_MS = 10 * MINUTE;
// 存下来的再试时间比这还远，多半是文件坏了或者改过系统时间，不算数
const MAX_MARK_MS = 33 * 24 * 3600 * 1000;

const WINDOWS = {
  h5: 5 * 3600 * 1000,
  day: 24 * 3600 * 1000,
  week: 7 * 24 * 3600 * 1000,
};

// 粗略估算 token：中日韩文字约 1 字 1 token，其他约 4 个字符 1 token
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

// “额度用完”的标记按“成员 + 接入方式”分开存：额度是跟着账号走的，
// GPT 换成 GitHub Models 之后又被限了一次，不该把 Codex 那个标记盖掉（换回 Codex 时它还得在）
const markKey = (member, provider) => `${member}|${provider || ''}`;

class UsageStore extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = this.read();
    // 刚到时间的标记（只在内存里，键和 limits 一样）：用来发现“一试又用完”
    this.expired = Object.create(null);
    this.saveTimer = null;
    this.expiryTimer = null;
    this.scheduleExpiry();
  }

  // 读文件时逐项检查：文件可能被手动改过，或者写到一半断电
  read() {
    const data = { events: [], limits: Object.create(null) };
    let d = null;
    try {
      d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* 没有文件或者内容坏了 */
    }
    if (!d || typeof d !== 'object') return data;
    const now = Date.now();
    if (Array.isArray(d.events)) {
      for (const e of d.events) {
        if (!e || typeof e !== 'object' || typeof e.member !== 'string' || !Number.isFinite(e.ts) || e.ts < now - KEEP_MS) continue;
        data.events.push({
          ts: e.ts,
          member: e.member,
          provider: String(e.provider || ''),
          input: num(e.input),
          output: num(e.output),
          total: num(e.total),
          ...(num(e.cached) ? { cached: num(e.cached) } : {}),
          ...(e.est ? { est: 1 } : {}),
        });
      }
      data.events = data.events.slice(-MAX_EVENTS);
    }
    if (d.limits && typeof d.limits === 'object' && !Array.isArray(d.limits)) {
      for (const [key, l] of Object.entries(d.limits)) {
        if (!l || typeof l !== 'object' || !Number.isFinite(l.retryAt) || l.retryAt > now + MAX_MARK_MS) continue;
        // 键是 “成员|接入方式”；早先一位成员只存一个标记，键就是成员 id
        const provider = String(l.provider || '');
        data.limits[markKey(key.split('|')[0], provider)] = {
          since: Number.isFinite(l.since) ? l.since : now,
          resetAt: Number.isFinite(l.resetAt) ? l.resetAt : null,
          retryAt: l.retryAt,
          provider,
          message: String(l.message || '').slice(0, 300),
          ...(num(l.strikes) ? { strikes: num(l.strikes) } : {}),
        };
      }
    }
    return data;
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...this.data }), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('保存用量失败：', e.message);
    }
  }

  // usage: { input, output, total, cached, estimated }。input 不含走缓存的部分；没给 total 时 total = input + output
  record(member, provider, usage) {
    const input = num(usage && usage.input);
    const output = num(usage && usage.output);
    const total = num(usage && usage.total) || input + output;
    const cached = num(usage && usage.cached);
    const now = Date.now();
    this.data.events.push({ ts: now, member, provider, input, output, total, ...(cached ? { cached } : {}), ...(usage && usage.estimated ? { est: 1 } : {}) });
    const cut = now - KEEP_MS;
    if (this.data.events.length > MAX_EVENTS || (this.data.events[0] && this.data.events[0].ts < cut)) {
      this.data.events = this.data.events.filter((e) => e.ts >= cut).slice(-MAX_EVENTS);
    }
    this.saveSoon();
    this.emit('change');
  }

  summary(member, now = Date.now()) {
    const out = {};
    for (const k of Object.keys(WINDOWS)) out[k] = { input: 0, output: 0, total: 0, cached: 0, calls: 0, estimated: false };
    for (const e of this.data.events) {
      if (e.member !== member) continue;
      for (const [k, ms] of Object.entries(WINDOWS)) {
        if (now - e.ts > ms) continue;
        const w = out[k];
        w.input += e.input || 0;
        w.output += e.output || 0;
        w.total += e.total || 0;
        w.cached += e.cached || 0;
        w.calls += 1;
        if (e.est) w.estimated = true;
      }
    }
    return out;
  }

  resetCounts(member) {
    this.data.events = member ? this.data.events.filter((e) => e.member !== member) : [];
    this.saveSoon();
    this.emit('change');
  }

  // ---------- 额度用完 ----------

  // 到了再试时间的标记自动去掉，并记下它刚到时间（用来发现“一试又用完”）
  sweep(now = Date.now()) {
    for (const [key, l] of Object.entries(this.data.limits)) {
      if (l.retryAt > now) continue;
      this.expired[key] = { at: l.retryAt, strikes: l.strikes || 0 };
      delete this.data.limits[key];
      this.saveSoon();
    }
  }

  // 这位成员用 provider 这种接入方式时，当前的“额度用完”记录（没有就是 null）。
  // 没写接入方式的标记（旧文件里可能有）对哪种接入方式都算
  limit(member, provider = '', now = Date.now()) {
    this.sweep(now);
    return this.data.limits[markKey(member, provider)] || this.data.limits[markKey(member, '')] || null;
  }

  isLimited(member, provider = '') {
    return Boolean(this.limit(member, provider));
  }

  // 这位成员所有的标记（每种接入方式最多一个）
  marksOf(member, now = Date.now()) {
    this.sweep(now);
    return Object.entries(this.data.limits)
      .filter(([key]) => key.startsWith(`${member}|`))
      .map(([, l]) => l);
  }

  // info: { resetAt (毫秒时间戳或 null), retryInMs (不知道恢复时间时，多久后再试；默认一小时), message, provider }
  setLimited(member, info = {}) {
    const now = Date.now();
    const provider = info.provider || '';
    const key = markKey(member, provider);
    let resetAt = Number(info.resetAt) > now ? Number(info.resetAt) : null;
    let retryAt = resetAt
      ? resetAt + Math.min(RETRY_MARGIN_MS, Math.max(1000, Math.round((resetAt - now) / 10)))
      : now + Math.min(num(info.retryInMs) || UNKNOWN_RESET_MS, MAX_MARK_MS);

    // 这种接入方式的上一个标记刚到时间，一试又用完：工具报的恢复时间不准，至少等 5 分钟、15 分钟、1 小时
    this.sweep(now);
    const last = this.expired[key];
    const strikes = last && now - last.at < STRIKE_WINDOW_MS ? last.strikes + 1 : 0;
    delete this.expired[key];
    if (strikes) {
      const floor = now + BACKOFF_MS[Math.min(strikes, BACKOFF_MS.length) - 1];
      if (retryAt < floor) {
        retryAt = floor;
        resetAt = null;
      }
    }

    // 有了写明接入方式的标记，没写接入方式的旧标记就不要了
    if (provider) delete this.data.limits[markKey(member, '')];
    this.data.limits[key] = {
      since: now,
      resetAt,
      retryAt,
      provider,
      message: String(info.message || '').slice(0, 300),
      ...(strikes ? { strikes } : {}),
    };
    this.saveSoon();
    this.scheduleExpiry();
    this.emit('change');
    return this.data.limits[key];
  }

  // 用户要求再试（或者确实又能用了）：去掉这种接入方式的标记，也不再记“一试又用完”。
  // 别的接入方式留下的标记不动（那个账号的额度不一定恢复了）
  clearLimited(member, provider = '') {
    let had = false;
    for (const key of new Set([markKey(member, provider), markKey(member, '')])) {
      delete this.expired[key];
      if (!this.data.limits[key]) continue;
      delete this.data.limits[key];
      had = true;
    }
    if (!had) return false;
    this.saveSoon();
    this.scheduleExpiry();
    this.emit('change');
    return true;
  }

  // 这位成员用 provider 这种接入方式成功了一次：它留下的标记可以去掉了，返回之前是不是标记着
  succeeded(member, provider) {
    this.sweep();
    return this.clearLimited(member, provider);
  }

  // 到了再试的时间，通知界面把“额度用完”的标记去掉
  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    const times = Object.values(this.data.limits).map((l) => l.retryAt);
    if (!times.length) return;
    const wait = Math.max(1000, Math.min(...times) - Date.now() + 500);
    this.expiryTimer = setTimeout(() => {
      this.sweep();
      this.scheduleExpiry();
      this.emit('change');
    }, Math.min(wait, 2 ** 31 - 1));
    if (this.expiryTimer.unref) this.expiryTimer.unref();
  }

  close() {
    clearTimeout(this.expiryTimer);
    this.saveNow();
  }
}

module.exports = { UsageStore, estimateTokens, UNKNOWN_RESET_MS };
