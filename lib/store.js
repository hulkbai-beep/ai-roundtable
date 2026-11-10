'use strict';

// 配置（config.json）和对话记录（data/）的读写

const fs = require('fs');
const path = require('path');
const { uid, maskSecret, clamp, UserError } = require('./util');
const { MEMBER_IDS } = require('./prompt');
const { PROVIDERS } = require('./providers');

const SECRET_KEYS = ['token', 'apiKey'];

const CONFIG_VERSION = 2;

const DEFAULTS = {
  version: CONFIG_VERSION,
  port: 3939,
  timeoutSec: 240,
  proxy: '',
  rotateFirst: false,
  order: ['claude', 'gemini', 'gpt'],
  members: {
    claude: {
      enabled: true,
      provider: 'claude-cli',
      instruction: '',
      'claude-cli': { command: 'claude', model: '', effort: '', extraArgs: '', maxChars: 60000 },
    },
    gemini: {
      enabled: true,
      provider: 'agy-cli',
      instruction: '',
      'agy-cli': { command: 'agy', model: '', extraArgs: '', promptVia: 'arg', maxChars: 20000 },
      'gemini-api': { apiKey: '', model: 'gemini-flash-latest', effort: '', baseUrl: '', maxChars: 60000 },
    },
    gpt: {
      enabled: true,
      provider: 'codex-cli',
      instruction: '',
      'codex-cli': { command: 'codex', model: '', effort: '', extraArgs: '', maxChars: 40000 },
      'github-models': { token: '', model: 'openai/gpt-4.1', effort: '', baseUrl: '', maxChars: 5000 },
      'openai-compatible': { baseUrl: '', apiKey: '', model: '', effort: '', maxChars: 20000 },
    },
  },
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function isObj(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}

// 只合并默认配置里已有的字段，并按默认值的类型转换
function mergeKnown(base, patch) {
  const out = clone(base);
  if (!isObj(patch)) return out;
  for (const k of Object.keys(base)) {
    if (!(k in patch)) continue;
    const bv = base[k];
    const pv = patch[k];
    if (isObj(bv)) out[k] = mergeKnown(bv, pv);
    else if (Array.isArray(bv)) out[k] = Array.isArray(pv) ? pv.slice() : bv;
    else if (typeof bv === 'number') {
      const n = Number(pv);
      out[k] = Number.isFinite(n) ? n : bv;
    } else if (typeof bv === 'boolean') out[k] = Boolean(pv);
    else out[k] = pv == null ? '' : String(pv);
  }
  return out;
}

// 密钥字段：空 = 不修改；"__CLEAR__" = 清空；带 **** 的是界面上的掩码，忽略
function prepareSecrets(patch) {
  if (!isObj(patch)) return patch;
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (SECRET_KEYS.includes(k)) {
      if (v === '__CLEAR__') out[k] = '';
      else if (typeof v === 'string' && v.trim() && !v.includes('****')) out[k] = v.trim();
    } else out[k] = isObj(v) ? prepareSecrets(v) : v;
  }
  return out;
}

function maskSecrets(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.includes(k)) {
      obj[`${k}Set`] = Boolean(v);
      obj[k] = maskSecret(v);
    } else if (isObj(v)) maskSecrets(v);
  }
  return obj;
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

class ConfigStore {
  constructor(file) {
    this.file = file;
    let loaded = {};
    try {
      loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
    const data = mergeKnown(DEFAULTS, loaded);
    // 1.0.0 的配置（version 1）里 GPT 默认是 GitHub Models；从 1.0.1 起默认改成 Codex CLI
    const firstRun = Object.keys(loaded).length === 0;
    if (!firstRun && (Number(loaded.version) || 1) < 2 && data.members.gpt.provider === 'github-models') {
      data.members.gpt.provider = 'codex-cli';
    }
    data.version = CONFIG_VERSION;
    this.data = this.normalize(data);
    this.save();
  }

  get() {
    return this.data;
  }

  normalize(c) {
    const seen = new Set();
    const order = [];
    for (const id of c.order || []) {
      if (MEMBER_IDS.includes(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    for (const id of MEMBER_IDS) if (!seen.has(id)) order.push(id);
    c.order = order;
    c.timeoutSec = clamp(Math.round(c.timeoutSec) || DEFAULTS.timeoutSec, 30, 1800);
    c.port = clamp(Math.round(c.port) || DEFAULTS.port, 1024, 65535);
    c.proxy = String(c.proxy || '').trim();
    for (const id of MEMBER_IDS) {
      const m = c.members[id];
      if (!PROVIDERS[m.provider] || PROVIDERS[m.provider].member !== id) m.provider = DEFAULTS.members[id].provider;
      for (const pid of Object.keys(PROVIDERS)) {
        const p = m[pid];
        if (!p) continue;
        p.maxChars = clamp(Math.round(p.maxChars) || DEFAULTS.members[id][pid].maxChars, 1000, 400000);
        for (const k of Object.keys(p)) if (typeof p[k] === 'string') p[k] = p[k].trim();
      }
      if (m['agy-cli'] && !['arg', 'stdin'].includes(m['agy-cli'].promptVia)) m['agy-cli'].promptVia = 'arg';
    }
    return c;
  }

  update(patch) {
    if (!isObj(patch)) throw new UserError('配置格式不对');
    this.data = this.normalize(mergeKnown(this.data, prepareSecrets(patch)));
    this.save();
    return this.data;
  }

  save() {
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (e) {
      console.error('保存配置失败：', e.message);
    }
  }

  publicView() {
    return maskSecrets(clone(this.data));
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

class ConversationStore {
  constructor(dir) {
    this.dir = dir;
    this.histDir = path.join(dir, 'history');
    fs.mkdirSync(this.histDir, { recursive: true });
    this.currentFile = path.join(dir, 'current.json');
    this.current = this.read(this.currentFile) || this.fresh();
    this.timer = null;
  }

  fresh() {
    return { id: uid('c'), createdAt: Date.now(), messages: [] };
  }

  read(file) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (c && Array.isArray(c.messages)) return c;
    } catch {
      /* missing or broken */
    }
    return null;
  }

  static title(conv) {
    const first = conv.messages.find((m) => m.speaker === 'user');
    return first ? first.text.replace(/\s+/g, ' ').trim().slice(0, 40) : '（空对话）';
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this.timer);
    try {
      writeJsonAtomic(this.currentFile, this.current);
    } catch (e) {
      console.error('保存对话失败：', e.message);
    }
  }

  archive() {
    if (!this.current.messages.some((m) => m.speaker !== 'system')) return null;
    const d = new Date(this.current.createdAt || Date.now());
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const file = path.join(this.histDir, `${stamp}-${this.current.id}.json`);
    writeJsonAtomic(file, this.current);
    return file;
  }

  startNew() {
    this.saveNow();
    this.archive();
    this.current = this.fresh();
    this.saveNow();
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.histDir).filter((f) => /^[\w.-]+\.json$/.test(f));
    } catch {
      /* none */
    }
    return files
      .map((f) => {
        const c = this.read(path.join(this.histDir, f));
        if (!c) return null;
        return {
          file: f,
          title: ConversationStore.title(c),
          createdAt: c.createdAt || 0,
          count: c.messages.filter((m) => m.speaker !== 'system').length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 300);
  }

  open(file) {
    if (!/^[\w.-]+\.json$/.test(String(file))) throw new UserError('文件名不对');
    const full = path.join(this.histDir, file);
    const conv = this.read(full);
    if (!conv) throw new UserError('找不到这个历史对话');
    this.saveNow();
    this.archive();
    this.current = conv;
    fs.rmSync(full, { force: true });
    this.saveNow();
  }
}

module.exports = { ConfigStore, ConversationStore, DEFAULTS };
