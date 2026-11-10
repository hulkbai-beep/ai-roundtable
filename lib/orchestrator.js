'use strict';

// 群聊调度：决定谁发言、按什么顺序，把聊天记录交给对应的 AI，再把回复放回群里

const EventEmitter = require('events');
const { MEMBERS, MODES, LENGTHS, buildSystemPrompt, buildTranscript, buildUserPrompt, parseMentions, cleanReply } = require('./prompt');
const { callProvider, PROVIDERS } = require('./providers');
const { uid, clamp, UserError } = require('./util');
const { tr, loc } = require('./i18n');

class Roundtable extends EventEmitter {
  constructor({ config, conversations, workdir }) {
    super();
    this.config = config;
    this.conversations = conversations;
    this.workdir = workdir;
    this.queue = [];
    this.current = null;
    this.running = false;
    this.rotation = 0;
  }

  get messages() {
    return this.conversations.current.messages;
  }

  enabledOrder() {
    const cfg = this.config.get();
    return cfg.order.filter((id) => cfg.members[id] && cfg.members[id].enabled);
  }

  addMessage(msg) {
    const m = { id: uid('m'), ts: Date.now(), ...msg };
    this.messages.push(m);
    this.conversations.saveSoon();
    this.emit('msg', m);
    return m;
  }

  note(text, level = 'info') {
    return this.addMessage({ speaker: 'system', text, level });
  }

  rotated(ids) {
    if (!this.config.get().rotateFirst || ids.length < 2) return ids;
    const k = this.rotation++ % ids.length;
    return [...ids.slice(k), ...ids.slice(0, k)];
  }

  plan(ids, rounds, mode, length) {
    const turns = [];
    for (let r = 0; r < rounds; r++) for (const id of ids) turns.push({ speaker: id, mode, length, isFinal: false });
    if (turns.length) turns[turns.length - 1].isFinal = true;
    return turns;
  }

  static opts({ mode, rounds, length }) {
    return {
      mode: MODES[mode] ? mode : 'discuss',
      rounds: clamp(parseInt(rounds, 10) || 1, 1, 5),
      length: LENGTHS[length] ? length : 'medium',
    };
  }

  send(body) {
    const text = String((body && body.text) || '').trim();
    if (!text) throw new UserError(tr('消息不能为空', 'The message is empty'));
    if (text.length > 50000) throw new UserError(tr('消息太长了（超过 5 万字）', 'The message is too long (over 50,000 characters)'));
    const { mode, rounds, length } = Roundtable.opts(body);
    this.addMessage({ speaker: 'user', text, mode });

    const enabled = this.enabledOrder();
    if (!enabled.length) {
      this.note(tr('所有 AI 都关掉了，去「设置」里至少打开一位。', 'All AIs are turned off. Turn at least one on in Settings.'), 'warn');
      return;
    }
    const { all, ids } = parseMentions(text);
    let speakers;
    let r = rounds;
    if (ids.length && !all) {
      const off = ids.filter((id) => !enabled.includes(id));
      if (off.length) this.note(tr(`${off.map((id) => MEMBERS[id].name).join('、')} 在设置里是关闭状态`, `${off.map((id) => MEMBERS[id].name).join(', ')} turned off in Settings`), 'warn');
      speakers = ids.filter((id) => enabled.includes(id));
      r = 1;
    } else {
      speakers = this.rotated(enabled);
    }
    // 新消息会替换掉还没轮到的发言计划（正在说话的那位会先说完）
    this.queue = this.plan(speakers, r, mode, length);
    this.kick();
  }

  continueRound(body) {
    if (!this.messages.some((m) => m.speaker === 'user')) throw new UserError(tr('先发一条消息开个头吧', 'Send a message first to get things started'));
    const enabled = this.enabledOrder();
    if (!enabled.length) throw new UserError(tr('所有 AI 都关掉了，去「设置」里至少打开一位', 'All AIs are turned off. Turn at least one on in Settings'));
    const { mode, rounds, length } = Roundtable.opts(body || {});
    this.queue = this.plan(this.rotated(enabled), rounds, mode, length);
    this.kick();
  }

  stop() {
    const had = this.queue.length > 0 || Boolean(this.current);
    this.queue = [];
    if (this.current) this.current.abort.abort();
    this.emitState();
    return had;
  }

  kick() {
    this.emitState();
    if (!this.running) this.loop();
  }

  async loop() {
    this.running = true;
    this.emitState();
    try {
      while (this.queue.length) {
        const turn = this.queue.shift();
        await this.runTurn(turn);
      }
    } finally {
      this.running = false;
      this.current = null;
      this.emitState();
    }
  }

  buildPrompt(speaker, turn) {
    const cfg = this.config.get();
    const member = cfg.members[speaker];
    const pcfg = member[member.provider] || {};
    const system = buildSystemPrompt({
      speaker,
      members: this.enabledOrder(),
      mode: turn.mode,
      length: turn.length,
      isFinal: turn.isFinal,
      customInstruction: member.instruction,
    });
    const transcript = buildTranscript(this.messages, { speaker, mode: turn.mode, maxChars: pcfg.maxChars || 20000 });
    return { system, user: buildUserPrompt({ speaker, transcript }) };
  }

  async runTurn(turn) {
    const cfg = this.config.get();
    const member = cfg.members[turn.speaker];
    if (!member || !member.enabled) return;
    const providerId = member.provider;
    const pcfg = member[providerId] || {};
    const conv = this.conversations.current;
    const prompt = this.buildPrompt(turn.speaker, turn);
    const abort = new AbortController();
    const startedAt = Date.now();
    this.current = { speaker: turn.speaker, startedAt, abort };
    this.emit('typing', { speaker: turn.speaker, startedAt });
    this.emitState();
    try {
      const res = await callProvider(providerId, pcfg, prompt, {
        signal: abort.signal,
        timeoutMs: cfg.timeoutSec * 1000,
        proxy: cfg.proxy,
        workdir: this.workdir,
      });
      if (this.conversations.current !== conv) return;
      const text = cleanReply(res.text, turn.speaker);
      this.addMessage({
        speaker: turn.speaker,
        text: text || tr('（空回复）', '(empty reply)'),
        meta: {
          provider: providerId,
          providerLabel: loc(PROVIDERS[providerId].label),
          model: (res.meta && res.meta.model) || '',
          effort: (res.meta && res.meta.effort) || '',
          note: (res.meta && res.meta.note) || '',
          ms: Date.now() - startedAt,
        },
      });
    } catch (e) {
      if (this.conversations.current !== conv) return;
      const name = MEMBERS[turn.speaker].name;
      if (e.aborted) {
        this.note(tr(`已停止 ${name} 的发言`, `Stopped ${name}`));
      } else {
        // 同一轮里这位后面的发言先跳过，免得连续报同样的错
        const before = this.queue.length;
        this.queue = this.queue.filter((t) => t.speaker !== turn.speaker);
        const skipped = before - this.queue.length;
        const msg = e.userFacing ? e.message : tr(`出错了：${e.message}`, `Error: ${e.message}`);
        const hint = e.hint ? tr(`\n建议：${e.hint}`, `\nTip: ${e.hint}`) : '';
        const skip = skipped ? tr(`\n（这一轮 ${name} 后面的发言先跳过）`, `\n(${name}'s remaining turns this round are skipped)`) : '';
        this.note(`${tr(`${name} 发言失败：`, `${name} failed: `)}${msg}${hint}${skip}`, 'error');
        if (!e.userFacing) console.error(e);
      }
    } finally {
      this.current = null;
      this.emit('typing', null);
    }
  }

  async test(memberId) {
    const cfg = this.config.get();
    const member = cfg.members[memberId];
    if (!member) throw new UserError(tr('没有这个成员', 'No such member'));
    const providerId = member.provider;
    const started = Date.now();
    try {
      const res = await callProvider(
        providerId,
        member[providerId] || {},
        tr(
          { system: '你是连通性测试助手，只按要求回复，不要多说。', user: '请只回复两个字：在线' },
          { system: 'You are a connectivity test assistant. Reply exactly as asked and nothing more.', user: 'Reply with exactly one word: online' }
        ),
        { timeoutMs: cfg.timeoutSec * 1000, proxy: cfg.proxy, workdir: this.workdir }
      );
      return { ok: true, ms: Date.now() - started, reply: String(res.text).trim().slice(0, 200), model: (res.meta && res.meta.model) || '', effort: (res.meta && res.meta.effort) || '', note: (res.meta && res.meta.note) || '' };
    } catch (e) {
      if (!e.userFacing) console.error(e);
      return { ok: false, ms: Date.now() - started, error: e.message, hint: e.hint || '' };
    }
  }

  state() {
    return {
      busy: this.running,
      queued: this.queue.length,
      typing: this.current ? { speaker: this.current.speaker, startedAt: this.current.startedAt } : null,
    };
  }

  emitState() {
    this.emit('state', this.state());
  }
}

module.exports = { Roundtable };
