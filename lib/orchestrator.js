'use strict';

// 群聊调度：决定谁发言、按什么顺序，把聊天记录交给对应的 AI，再把回复放回群里

const EventEmitter = require('events');
const { MEMBERS, MODES, LENGTHS, buildSystemPrompt, buildTranscript, buildUserPrompt, parseMentions, cleanReply } = require('./prompt');
const { callProvider, PROVIDERS } = require('./providers');
const { uid, clamp, tail, UserError } = require('./util');
const { tr, loc } = require('./i18n');
const { estimateTokens } = require('./usage');

const names = (ids) => ids.map((id) => MEMBERS[id].name).join(tr('、', ', '));

// 恢复时间写成“15:00”或“明天 15:00”这样
function fmtReset(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return tr(`明天 ${hm}`, `tomorrow ${hm}`);
  return tr(`${d.getMonth() + 1}月${d.getDate()}日 ${hm}`, `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`);
}

class Roundtable extends EventEmitter {
  constructor({ config, conversations, workdir, usage }) {
    super();
    this.config = config;
    this.usage = usage || null;
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

  // 额度是跟着账号走的：换了接入方式（例如 GPT 从 Codex 换成 GitHub Models），之前的标记就不算数
  limitOf(id) {
    const l = this.usage && this.usage.limit(id);
    if (!l) return null;
    const m = this.config.get().members[id];
    return m && l.provider && l.provider !== m.provider ? null : l;
  }

  isLimited(id) {
    return Boolean(this.limitOf(id));
  }

  // 这位成员用 providerId 成功了一次：去掉它的“额度用完”标记，返回之前是不是标记着。
  // 别的接入方式留下的标记不动（那个账号的额度不一定恢复了）
  clearLimit(id, providerId) {
    return Boolean(this.usage) && this.usage.succeeded(id, providerId);
  }

  // 把某位成员还没轮到的发言从队列里拿掉，返回拿掉了几次。
  // 协作模式最后一次发言要做总结：这一次如果也被拿掉了，改由队列里最后一位来总结
  dropTurns(speaker) {
    const before = this.queue.length;
    const hadFinal = this.queue.some((t) => t.speaker === speaker && t.isFinal);
    this.queue = this.queue.filter((t) => t.speaker !== speaker);
    if (hadFinal && this.queue.length) this.queue[this.queue.length - 1].isFinal = true;
    return before - this.queue.length;
  }

  // 打开着、而且额度没用完的成员
  activeOrder() {
    return this.enabledOrder().filter((id) => !this.isLimited(id));
  }

  // 有人额度用完时，提醒一下由谁来说（同一个对话里情况没变就不重复提醒）
  noteLimited(enabled) {
    const out = enabled.filter((id) => this.isLimited(id));
    const key = `${this.conversations.current.id}:${out.join(',')}`;
    if (!out.length) {
      this.lastLimitNote = '';
      return true;
    }
    const left = enabled.filter((id) => !out.includes(id));
    if (!left.length) {
      this.note(
        tr(
          `${names(out)} 的额度都用完了，现在没人能发言。等额度恢复后再试，或者在「用量」里点「再试一次」。`,
          `${names(out)} ${out.length > 1 ? 'are all' : 'is'} out of usage, so nobody can reply right now. Wait for usage to reset, or click "Try again" under Usage.`
        ),
        'warn'
      );
      return false;
    }
    if (key === this.lastLimitNote) return true;
    this.lastLimitNote = key;
    this.note(tr(`${names(out)} 额度用完了，这次由 ${names(left)} 继续。`, `${names(out)} ${out.length > 1 ? 'are' : 'is'} out of usage; ${names(left)} will carry on.`), 'warn');
    return true;
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
      if (off.length) this.note(tr(`${names(off)} 在设置里是关闭状态`, `${names(off)} turned off in Settings`), 'warn');
      speakers = ids.filter((id) => enabled.includes(id));
      // 点名额度用完的成员：照样试一次（可能已经恢复了），成功就去掉标记
      const retry = speakers.filter((id) => this.isLimited(id));
      if (retry.length) this.note(tr(`${names(retry)} 之前额度用完了，按你的点名再试一次`, `${names(retry)} ran out of usage earlier; trying again because you asked`));
      r = 1;
    } else {
      if (!this.noteLimited(enabled)) return;
      speakers = this.rotated(this.activeOrder());
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
    if (!this.noteLimited(enabled)) return;
    this.queue = this.plan(this.rotated(this.activeOrder()), rounds, mode, length);
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
    // 额度用完的成员这次不在场，别让其他人去点他的名
    const members = this.enabledOrder().filter((id) => id === speaker || !this.isLimited(id));
    const system = buildSystemPrompt({
      speaker,
      members,
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
      const usage = this.recordUsage(turn.speaker, providerId, prompt, res);
      if (this.clearLimit(turn.speaker, providerId)) {
        if (this.conversations.current === conv) this.note(tr(`${MEMBERS[turn.speaker].name} 的额度恢复了，回到群里`, `${MEMBERS[turn.speaker].name} has usage again and is back in the chat`));
      }
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
          tokens: usage.total,
          tokensEstimated: Boolean(usage.estimated),
        },
      });
    } catch (e) {
      if (e.limit) this.markLimited(turn.speaker, providerId, e);
      if (this.conversations.current !== conv) return;
      const name = MEMBERS[turn.speaker].name;
      if (e.limit) {
        this.dropTurns(turn.speaker);
        this.limitNotice(turn.speaker, e);
      } else if (e.aborted) {
        this.note(tr(`已停止 ${name} 的发言`, `Stopped ${name}`));
      } else {
        // 同一轮里这位后面的发言先跳过，免得连续报同样的错
        const skipped = this.dropTurns(turn.speaker);
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

  // 记下这次用了多少 token；工具没告诉我们时按字数估算
  recordUsage(member, providerId, prompt, res) {
    let usage = res.usage && (res.usage.input || res.usage.output || res.usage.total) ? { ...res.usage } : null;
    if (!usage) {
      usage = { input: estimateTokens(`${prompt.system}\n${prompt.user}`), output: estimateTokens(res.text), estimated: true };
    }
    usage.total = usage.total || (usage.input || 0) + (usage.output || 0);
    if (this.usage) this.usage.record(member, providerId, usage);
    return usage;
  }

  markLimited(member, providerId, e) {
    if (!this.usage) return null;
    return this.usage.setLimited(member, { resetAt: e.limit.resetAt, retryInMs: e.limit.retryInMs, provider: providerId, message: e.message });
  }

  // 额度用完：在群里提醒（界面会响一声、把这位成员标成“额度用完”），后面由其他人继续
  limitNotice(member, e) {
    const name = MEMBERS[member].name;
    const l = this.limitOf(member);
    const when = l && l.resetAt
      ? tr(`预计 ${fmtReset(l.resetAt)} 恢复`, `expected to reset at ${fmtReset(l.resetAt)}`)
      : l
        ? tr(`不知道什么时候恢复，${fmtReset(l.retryAt)} 会自动再试`, `reset time unknown; will try again at ${fmtReset(l.retryAt)}`)
        : '';
    const left = this.activeOrder();
    const next = left.length
      ? tr(`接下来先跳过 ${name}，由 ${names(left)} 继续。`, `${name} is skipped for now; ${names(left)} will carry on.`)
      : tr('现在所有成员的额度都用完了。', 'Every member is now out of usage.');
    this.lastLimitNote = `${this.conversations.current.id}:${this.enabledOrder().filter((id) => this.isLimited(id)).join(',')}`;
    const detail = tail(String(e.raw || e.message).replace(/\s+/g, ' '), 200);
    this.addMessage({
      speaker: 'system',
      level: 'error',
      alert: 'limit',
      member,
      text: tr(
        `${name} 的额度用完了${when ? `（${when}）` : ''}。${next}${detail ? `\n原始信息：${detail}` : ''}`,
        `${name} is out of usage${when ? ` (${when})` : ''}. ${next}${detail ? `\nDetails: ${detail}` : ''}`
      ),
    });
  }

  async test(memberId) {
    const cfg = this.config.get();
    const member = cfg.members[memberId];
    if (!member) throw new UserError(tr('没有这个成员', 'No such member'));
    const providerId = member.provider;
    const started = Date.now();
    const prompt = tr(
      { system: '你是连通性测试助手，只按要求回复，不要多说。', user: '请只回复两个字：在线' },
      { system: 'You are a connectivity test assistant. Reply exactly as asked and nothing more.', user: 'Reply with exactly one word: online' }
    );
    try {
      const res = await callProvider(providerId, member[providerId] || {}, prompt, { timeoutMs: cfg.timeoutSec * 1000, proxy: cfg.proxy, workdir: this.workdir });
      this.recordUsage(memberId, providerId, prompt, res);
      this.clearLimit(memberId, providerId);
      return { ok: true, ms: Date.now() - started, reply: String(res.text).trim().slice(0, 200), model: (res.meta && res.meta.model) || '', effort: (res.meta && res.meta.effort) || '', note: (res.meta && res.meta.note) || '' };
    } catch (e) {
      if (!e.userFacing) console.error(e);
      if (e.limit) this.markLimited(memberId, providerId, e);
      return { ok: false, ms: Date.now() - started, error: e.message, hint: e.hint || '', limited: Boolean(e.limit) };
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
