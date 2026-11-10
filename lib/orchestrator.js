'use strict';

// 群聊调度：决定谁发言、按什么顺序，把聊天记录交给对应的 AI，再把回复放回群里

const EventEmitter = require('events');
const { MEMBERS, MODES, LENGTHS, buildSystemPrompt, buildTranscript, buildUserPrompt, parseMentions, cleanReply, turnPosition } = require('./prompt');
const { callProvider, PROVIDERS } = require('./providers');
const { uid, clamp, tail, UserError } = require('./util');
const { tr, loc } = require('./i18n');
const { estimateTokens } = require('./usage');

const names = (ids) => ids.map((id) => MEMBERS[id].name).join(tr('、', ', '));

// 这两种模式里大家轮流发言、互相接话，谁先说会影响后面的人，所以每条消息换一个顺序
const SHUFFLED_MODES = ['discuss', 'debate'];

// 随机排一个发言顺序。avoid 里的成员尽量不排第一个（写在前面的优先避开），
// 例如刚说完话的那位、上次第一个发言的那位。
function shuffled(ids, { avoid = [], random = Math.random } = {}) {
  if (ids.length < 2) return ids.slice();
  const pick = (n) => Math.min(n - 1, Math.floor(random() * n));
  const rest = ids.slice();
  let firsts = rest;
  for (let n = avoid.length; n > 0; n--) {
    const ok = rest.filter((id) => !avoid.slice(0, n).includes(id));
    if (ok.length) {
      firsts = ok;
      break;
    }
  }
  const first = firsts[pick(firsts.length)];
  rest.splice(rest.indexOf(first), 1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest];
}

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
    // 发言计划：一步一步来，每一步里的成员同时发言（多数时候一步只有一个人，见 plan）
    this.queue = [];
    // 正在发言的成员：成员 id → 这次调用
    this.active = new Map();
    this.running = false;
    this.lastFirst = null;
    this.random = Math.random;
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

  // 把某位成员还没轮到的发言都去掉，返回去掉了几次。
  // 合作模式里最后一次发言要做总结：这一次如果也被去掉了，改由剩下的最后一位来总结
  dropTurns(speaker) {
    const before = this.queued();
    const hadFinal = this.queue.some((step) => step.some((t) => t.speaker === speaker && t.isFinal));
    this.queue = this.queue.map((step) => step.filter((t) => t.speaker !== speaker)).filter((step) => step.length);
    if (hadFinal && this.queue.length) {
      const last = this.queue[this.queue.length - 1];
      last[last.length - 1].isFinal = true;
    }
    return before - this.queued();
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

  // 自由讨论和辩论：每条消息换一个发言顺序（设置里可以关掉），免得总是同一位先说、同一位压轴。
  // 合作模式按设置里排好的顺序；各自回答是大家同时回答，没有先后。
  lineup(ids, mode, avoidFirst = []) {
    if (!this.config.get().shuffleOrder || ids.length < 2 || !SHUFFLED_MODES.includes(mode)) return ids;
    const order = shuffled(ids, { avoid: [...avoidFirst, this.lastFirst].filter(Boolean), random: this.random });
    this.lastFirst = order[0];
    return order;
  }

  // 发言计划是一串“步骤”，每一步里的成员同时发言。
  // 各自回答：大家互相不看这一轮的回答，所以同一轮的人放在同一步里一起回答；
  // 其他模式：后面的人要看前面的人说了什么，所以一步只有一个人。
  plan(ids, rounds, mode, length) {
    const steps = [];
    if (!ids.length) return steps;
    for (let r = 0; r < rounds; r++) {
      const turns = ids.map((id) => ({ speaker: id, mode, length, isFinal: false }));
      if (mode === 'independent') steps.push(turns);
      else for (const t of turns) steps.push([t]);
    }
    const last = steps[steps.length - 1];
    last[last.length - 1].isFinal = true;
    return steps;
  }

  // 还有几次发言在排队
  queued() {
    return this.queue.reduce((n, step) => n + step.length, 0);
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
    let steps;
    if (ids.length && !all) {
      const off = ids.filter((id) => !enabled.includes(id));
      if (off.length) this.note(tr(`${names(off)} 在设置里是关闭状态`, `${names(off)} turned off in Settings`), 'warn');
      const speakers = ids.filter((id) => enabled.includes(id));
      // 点名额度用完的成员：照样试一次（可能已经恢复了），成功就去掉标记
      const retry = speakers.filter((id) => this.isLimited(id));
      if (retry.length) this.note(tr(`${names(retry)} 之前额度用完了，按你的点名再试一次`, `${names(retry)} ran out of usage earlier; trying again because you asked`));
      // 点了两位以上的名：按点名的顺序一个一个说，后面的人能看到前面的回答。
      // “各自回答”模式下也这样（不然“@Claude 先写，@GPT 来改”里 GPT 看不到 Claude 写的东西），这时按自由讨论来。
      const turnMode = mode === 'independent' && speakers.length > 1 ? 'discuss' : mode;
      steps = this.plan(speakers, 1, turnMode, length);
    } else {
      if (!this.noteLimited(enabled)) return;
      // 发这条消息时还在说话的那位，说完之后别紧接着又第一个说
      steps = this.plan(this.lineup(this.activeOrder(), mode, [...this.active.keys()]), rounds, mode, length);
    }
    // 新消息会替换掉还没轮到的发言计划（正在说话的成员会先说完）
    this.queue = steps;
    this.kick();
  }

  continueRound(body) {
    if (!this.messages.some((m) => m.speaker === 'user')) throw new UserError(tr('先发一条消息开个头吧', 'Send a message first to get things started'));
    const enabled = this.enabledOrder();
    if (!enabled.length) throw new UserError(tr('所有 AI 都关掉了，去「设置」里至少打开一位', 'All AIs are turned off. Turn at least one on in Settings'));
    const { mode, rounds, length } = Roundtable.opts(body || {});
    if (!this.noteLimited(enabled)) return;
    // 接着聊时，别让刚说完话的那位紧接着再说一次
    const last = [...this.messages].reverse().find((m) => MEMBERS[m.speaker]);
    this.queue = this.plan(this.lineup(this.activeOrder(), mode, last ? [last.speaker] : []), rounds, mode, length);
    this.kick();
  }

  stop() {
    const had = this.queue.length > 0 || this.active.size > 0;
    this.queue = [];
    for (const call of this.active.values()) call.abort.abort();
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
      while (this.queue.length) await this.runStep(this.queue.shift());
    } finally {
      this.running = false;
      this.active.clear();
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
      position: turnPosition(this.messages, speaker),
      customInstruction: member.instruction,
    });
    const transcript = buildTranscript(this.messages, { speaker, mode: turn.mode, maxChars: pcfg.maxChars || 20000 });
    return { system, user: buildUserPrompt({ speaker, transcript }) };
  }

  // 跑一步：这一步里的成员同时发言。
  // 先按同一份聊天记录把每个人的提示词都准备好，再一起发出去，所以同一步里的人互相看不到对方这次的回答。
  async runStep(turns) {
    const conv = this.conversations.current;
    const calls = turns.map((turn) => this.prepare(turn)).filter(Boolean);
    if (!calls.length) return;
    this.emitTyping();
    this.emitState();
    const stopped = [];
    const results = await Promise.allSettled(calls.map((call) => this.runCall(call, conv, stopped)));
    for (const r of results) if (r.status === 'rejected') console.error(r.reason);
    if (stopped.length && this.conversations.current === conv) {
      // 几位一起被停掉时只说明一次，名字按这一步里排好的顺序写
      const who = turns.map((t) => t.speaker).filter((id) => stopped.includes(id));
      this.note(tr(`已停止 ${names(who)} 的发言`, `Stopped ${names(who)}`));
    }
  }

  prepare(turn) {
    const member = this.config.get().members[turn.speaker];
    if (!member || !member.enabled) return null;
    const providerId = member.provider;
    const call = {
      turn,
      providerId,
      pcfg: member[providerId] || {},
      prompt: this.buildPrompt(turn.speaker, turn),
      abort: new AbortController(),
      startedAt: Date.now(),
    };
    this.active.set(turn.speaker, call);
    return call;
  }

  // 调用一位成员，把回复放回群里。被「停止」打断的成员记进 stopped，由 runStep 统一说明。
  async runCall({ turn, providerId, pcfg, prompt, abort, startedAt }, conv, stopped) {
    const cfg = this.config.get();
    try {
      const res = await callProvider(providerId, pcfg, prompt, {
        signal: abort.signal,
        timeoutMs: cfg.timeoutSec * 1000,
        proxy: cfg.proxy,
        workdir: this.workdir,
      });
      const usage = this.recordUsage(turn.speaker, providerId, prompt, res);
      if (this.usage && this.usage.clearLimited(turn.speaker)) {
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
        stopped.push(turn.speaker);
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
      this.active.delete(turn.speaker);
      this.emitTyping();
      // 大家同时回答时，有人出错会去掉他后面的发言，而别人还在说：排队的次数变了，马上告诉界面
      this.emitState();
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
    return this.usage.setLimited(member, { resetAt: e.limit.resetAt, provider: providerId, message: e.message });
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
      if (this.usage) this.usage.clearLimited(memberId);
      return { ok: true, ms: Date.now() - started, reply: String(res.text).trim().slice(0, 200), model: (res.meta && res.meta.model) || '', effort: (res.meta && res.meta.effort) || '', note: (res.meta && res.meta.note) || '' };
    } catch (e) {
      if (!e.userFacing) console.error(e);
      if (e.limit) this.markLimited(memberId, providerId, e);
      return { ok: false, ms: Date.now() - started, error: e.message, hint: e.hint || '', limited: Boolean(e.limit) };
    }
  }

  // 正在发言的成员（同时回答时有好几位）
  typing() {
    return [...this.active.values()].map((call) => ({ speaker: call.turn.speaker, startedAt: call.startedAt }));
  }

  emitTyping() {
    this.emit('typing', this.typing());
  }

  state() {
    return { busy: this.running, queued: this.queued(), typing: this.typing() };
  }

  emitState() {
    this.emit('state', this.state());
  }
}

module.exports = { Roundtable, shuffled };
