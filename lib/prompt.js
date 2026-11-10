'use strict';

// 群聊“人设”和聊天记录的拼装。想调整 AI 的说话风格，改这个文件就行。

const MEMBERS = {
  claude: { id: 'claude', name: 'Claude', maker: 'Anthropic' },
  gemini: { id: 'gemini', name: 'Gemini', maker: 'Google' },
  gpt: { id: 'gpt', name: 'GPT', maker: 'OpenAI' },
};
const MEMBER_IDS = Object.keys(MEMBERS);
const { tr, L } = require('./i18n');

const host = () => tr('用户', 'User');

const MODES = {
  discuss: {
    label: L('自由讨论', 'Open discussion'),
    rule: L(
      '自由讨论。像几个有见地的朋友一起聊天：有观点就直说，可以有分歧，也可以被别人说服。',
      'Open discussion. Talk like a few thoughtful friends: say what you think, feel free to disagree, and be open to changing your mind.'
    ),
  },
  debate: {
    label: L('辩论', 'Debate'),
    rule: L(
      '辩论。先亮明你的立场（主持人指定了立场就按指定的来），抓住其他成员论证里的漏洞反驳或追问，不要轻易附和；真被说服了可以坦率承认。',
      "Debate. State your position first (use the one the host assigned, if any). Find the holes in the other members' arguments and rebut or press them; do not agree easily. If you are truly persuaded, say so plainly."
    ),
  },
  collab: {
    label: L('合作', 'Collaborate'),
    rule: L(
      '合作完成任务。大家一起完成主持人交代的任务：在前面成员已有成果的基础上继续推进（补充、修正、细化），不要推倒重来，也不要重复已有内容。',
      "Collaborate on a task. Work together on what the host asked for: build on what earlier members produced (add, correct, refine). Do not start over and do not repeat what is already there."
    ),
  },
  independent: {
    label: L('各自回答', 'Answer separately'),
    rule: L(
      '各自回答。独立回答主持人最新的问题——你看不到其他成员这一轮的回答，也不用提到他们。',
      "Answer separately. Answer the host's latest question on your own. You cannot see the other members' answers this round, and you do not need to mention them."
    ),
  },
};

const LENGTHS = {
  short: { label: L('简短', 'Short'), rule: L('像群聊一样简短：一般 2～4 句话，不超过 150 字。', 'Keep it short like a group chat: usually 2 to 4 sentences, at most 80 words.') },
  medium: { label: L('适中', 'Medium'), rule: L('简洁为主：一般不超过 300 字，需要时可以用简短的列表。', 'Stay concise: usually at most 180 words, with a short list when it helps.') },
  long: { label: L('详细', 'Detailed'), rule: L('可以展开详细说明，但不要说空话、不要重复。', 'You may go into detail, but no filler and no repetition.') },
};

function buildSystemPrompt(opts) {
  return tr(systemPromptZh, systemPromptEn)(opts);
}

function systemPromptZh({ speaker, members, mode, length, isFinal, customInstruction }) {
  const me = MEMBERS[speaker];
  const lines = ['你正在参加一个多人群聊。群成员有：', '- 用户：真人，也是这个群的主持人'];
  for (const id of members) {
    const m = MEMBERS[id];
    lines.push(`- ${m.name}：${m.maker} 开发的 AI${id === speaker ? '（就是你）' : ''}`);
  }
  lines.push(
    '',
    `你是 ${me.name}。`,
    '',
    '发言规则：',
    `1. 只代表你自己发言。不要替别人说话，开头也不要写「${me.name}：」这样的名字前缀。`,
    '2. 先看清楚前面每个人说了什么再接话：可以赞同、补充、质疑或反驳；提到别人的观点时直接点名，比如「我同意 XX 说的……」。',
    '3. 不要重复别人已经说过的内容；没有新东西可说时，简单表个态就好。',
    '4. 用主持人使用的语言回复（默认中文）。',
    `5. 篇幅：${(LENGTHS[length] || LENGTHS.medium).rule.zh}`,
    '6. 这里是纯聊天：不要读写文件、不要运行命令、不要调用任何工具，直接用文字回复。',
    '7. 主持人的要求优先于以上所有规则。',
    '',
    `当前模式：${(MODES[mode] || MODES.discuss).rule.zh}`
  );
  if (isFinal && mode === 'collab') {
    lines.push('你是这一轮最后一个发言的人：发言最后请用几句话总结大家目前的结论，以及还没解决的分歧。');
  }
  if (customInstruction && customInstruction.trim()) {
    lines.push('', `主持人给你的额外设定：${customInstruction.trim()}`);
  }
  return lines.join('\n');
}

function systemPromptEn({ speaker, members, mode, length, isFinal, customInstruction }) {
  const me = MEMBERS[speaker];
  const lines = ['You are taking part in a group chat. The members are:', '- User: a real person, and the host of this chat'];
  for (const id of members) {
    const m = MEMBERS[id];
    lines.push(`- ${m.name}: an AI made by ${m.maker}${id === speaker ? ' (this is you)' : ''}`);
  }
  lines.push(
    '',
    `You are ${me.name}.`,
    '',
    'Rules:',
    `1. Speak only for yourself. Do not speak for anyone else, and do not start with a name prefix like "${me.name}:".`,
    '2. Read what everyone said before you reply. You may agree, add, question or rebut. Name the person whose point you are responding to, for example "I agree with what XX said about...".',
    '3. Do not repeat what others already said. If you have nothing new, a brief reaction is enough.',
    '4. Reply in the language the host is using (English by default).',
    `5. Length: ${(LENGTHS[length] || LENGTHS.medium).rule.en}`,
    '6. This is a plain chat: do not read or write files, run commands, or call any tools. Just reply in text.',
    "7. The host's requests take priority over all of the rules above.",
    '',
    `Current mode: ${(MODES[mode] || MODES.discuss).rule.en}`
  );
  if (isFinal && mode === 'collab') {
    lines.push('You are the last speaker this round: end with a few sentences summing up what the group has concluded so far and what is still unresolved.');
  }
  if (customInstruction && customInstruction.trim()) {
    lines.push('', `Extra instructions from the host for you: ${customInstruction.trim()}`);
  }
  return lines.join('\n');
}

function clip(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}${tr('……（太长，后面省略）', '... (too long, rest omitted)')}` : t;
}

// 把聊天记录拼成文字。太长时保留第一条话题 + 最近的消息。
function buildTranscript(messages, { speaker, mode, maxChars = 20000 }) {
  let msgs = messages.filter((m) => (m.speaker === 'user' || MEMBERS[m.speaker]) && m.text);
  if (mode === 'independent') {
    let lastUser = -1;
    msgs.forEach((m, i) => {
      if (m.speaker === 'user') lastUser = i;
    });
    msgs = msgs.filter((m, i) => i <= lastUser || m.speaker === speaker);
  }
  const blocks = msgs.map((m) => {
    const name = m.speaker === 'user' ? host() : MEMBERS[m.speaker].name;
    const mine = m.speaker === speaker ? tr('（你）', ' (you)') : '';
    return `【${name}${mine}】\n${clip(String(m.text).trim(), Math.max(500, maxChars - 300))}`;
  });

  const keep = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const len = blocks[i].length + 2;
    if (keep.length && total + len > maxChars) break;
    keep.unshift(i);
    total += len;
  }
  if (!keep.length) return tr('（还没有任何消息）', '(no messages yet)');
  const first = keep[0];
  if (first === 0) return keep.map((i) => blocks[i]).join('\n\n');

  const topicIdx = msgs.findIndex((m) => m.speaker === 'user');
  const head = topicIdx >= 0 && topicIdx < first ? [clip(blocks[topicIdx], 600)] : [];
  const omitted = first - head.length;
  return [...head, tr(`（……中间省略了 ${omitted} 条较早的消息……）`, `(... ${omitted} earlier messages omitted ...)`), ...keep.map((i) => blocks[i])].join('\n\n');
}

function buildUserPrompt({ speaker, transcript }) {
  const name = MEMBERS[speaker].name;
  return [
    tr('下面是群聊记录（按时间顺序）：', 'Here is the chat so far, in order:'),
    '',
    transcript,
    '',
    tr('（以上是到目前为止的全部记录）', '(That is everything so far.)'),
    '',
    tr(`现在轮到你（${name}）发言了。直接写出你要发的内容即可。`, `It is now your turn (${name}). Write only the message you want to send.`),
  ].join('\n');
}

const MENTION_ALIASES = [
  { re: /^(所有人|全体成员|全体|大家|all|everyone)/i, ids: 'all' },
  { re: /^(claude|克劳德)/i, ids: ['claude'] },
  { re: /^(gemini|双子座|双子)/i, ids: ['gemini'] },
  { re: /^(chatgpt|gpt|openai|codex)/i, ids: ['gpt'] },
];

// 解析 @点名，按出现顺序返回
function parseMentions(text) {
  const ids = [];
  let all = false;
  const re = /[@＠]([^\s@＠,，。.!！?？:：;；、]+)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    for (const a of MENTION_ALIASES) {
      if (!a.re.test(m[1])) continue;
      if (a.ids === 'all') all = true;
      else for (const id of a.ids) if (!ids.includes(id)) ids.push(id);
      break;
    }
  }
  return { all, ids };
}

// 去掉 AI 自己加上的名字前缀，例如「Claude：」「**Claude**:」「【Claude】」
function cleanReply(text, speaker) {
  const name = MEMBERS[speaker].name;
  let t = String(text || '').trim();
  t = t.replace(new RegExp(`^(?:\\*\\*)?[【\\[]?${name}(?:（你）| \\(you\\))?[】\\]]?(?:\\*\\*)?\\s*[：:]\\s*`, 'i'), '');
  t = t.replace(new RegExp(`^[【\\[]${name}(?:（你）| \\(you\\))?[】\\]]\\s*\\n`, 'i'), '');
  return t.trim();
}

module.exports = {
  MEMBERS,
  MEMBER_IDS,
  MODES,
  LENGTHS,
  buildSystemPrompt,
  buildTranscript,
  buildUserPrompt,
  parseMentions,
  cleanReply,
};
