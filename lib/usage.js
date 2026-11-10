'use strict';

// 用量记录：每位成员每次发言用了多少 token，以及谁的额度用完了。
// 存在数据目录的 usage.json 里，只保留最近 30 天。
// 订阅的真实额度（Max、AI Pro、ChatGPT）官方不公开具体数字，所以这里只记“用了多少”；
// “用完了”靠命令行工具或接口返回的报错来判断（见 providers.js 的 detectLimit）。

const fs = require('fs');
const EventEmitter = require('events');

const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX_EVENTS = 20000;
// 不知道什么时候恢复时，过一小时自动再试一次
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

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

class UsageStore extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = this.read();
    this.saveTimer = null;
    this.expiryTimer = null;
    this.scheduleExpiry();
  }

  read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && Array.isArray(d.events)) return { events: d.events, limits: d.limits && typeof d.limits === 'object' ? d.limits : {} };
    } catch {
      /* missing or broken */
    }
    return { events: [], limits: {} };
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

  // usage: { input, output, total, estimated }
  record(member, provider, usage) {
    const input = num(usage && usage.input);
    const output = num(usage && usage.output);
    const total = num(usage && usage.total) || input + output;
    const now = Date.now();
    this.data.events.push({ ts: now, member, provider, input, output, total, ...(usage && usage.estimated ? { est: 1 } : {}) });
    const cut = now - KEEP_MS;
    if (this.data.events.length > MAX_EVENTS || (this.data.events[0] && this.data.events[0].ts < cut)) {
      this.data.events = this.data.events.filter((e) => e.ts >= cut).slice(-MAX_EVENTS);
    }
    this.saveSoon();
    this.emit('change');
  }

  summary(member, now = Date.now()) {
    const out = {};
    for (const [k, ms] of Object.entries(WINDOWS)) out[k] = { input: 0, output: 0, total: 0, calls: 0, estimated: false };
    for (const e of this.data.events) {
      if (e.member !== member) continue;
      for (const [k, ms] of Object.entries(WINDOWS)) {
        if (now - e.ts > ms) continue;
        const w = out[k];
        w.input += e.input || 0;
        w.output += e.output || 0;
        w.total += e.total || 0;
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

  // 返回当前的“额度用完”记录；到了预计恢复时间就自动清掉
  limit(member, now = Date.now()) {
    const l = this.data.limits[member];
    if (!l) return null;
    if (l.retryAt && l.retryAt <= now) {
      delete this.data.limits[member];
      this.saveSoon();
      return null;
    }
    return l;
  }

  isLimited(member) {
    return Boolean(this.limit(member));
  }

  // info: { resetAt (毫秒时间戳或 null), message, provider }
  setLimited(member, info = {}) {
    const now = Date.now();
    const resetAt = Number(info.resetAt) > now ? Number(info.resetAt) : null;
    this.data.limits[member] = {
      since: now,
      resetAt,
      retryAt: resetAt || now + UNKNOWN_RESET_MS,
      provider: info.provider || '',
      message: String(info.message || '').slice(0, 300),
    };
    this.saveSoon();
    this.scheduleExpiry();
    this.emit('change');
    return this.data.limits[member];
  }

  clearLimited(member) {
    if (!this.data.limits[member]) return false;
    delete this.data.limits[member];
    this.saveSoon();
    this.scheduleExpiry();
    this.emit('change');
    return true;
  }

  // 到了恢复时间，通知界面把“额度用完”的标记去掉
  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    const times = Object.values(this.data.limits)
      .map((l) => l.retryAt)
      .filter(Boolean);
    if (!times.length) return;
    const wait = Math.max(1000, Math.min(...times) - Date.now() + 500);
    this.expiryTimer = setTimeout(() => {
      for (const id of Object.keys(this.data.limits)) this.limit(id);
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
