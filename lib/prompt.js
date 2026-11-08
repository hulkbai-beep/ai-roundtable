'use strict';

// 群聊“人设”和聊天记录的拼装。想调整 AI 的说话风格，改这个文件就行。

const MEMBERS = {
  claude: { id: 'claude', name: 'Claude', maker: 'Anthropic' },
  gemini: { id: 'gemini', name: 'Gemini', maker: 'Google' },
  gpt: { id: 'gpt', name: 'GPT', maker: 'OpenAI' },
};
const MEMBER_IDS = Object.keys(MEMBERS);
const HOST = '用户';

const MODES = {
  discuss: {
    label: '自由讨论',
    rule: '自由讨论。像几个有见地的朋友一起聊天：有观点就直说，可以有分歧，也可以被别人说服。',
  },
  debate: {
    label: '辩论',
    rule: '辩论。先亮明你的立场（主持人指定了立场就按指定的来），抓住其他成员论证里的漏洞反驳或追问，不要轻易附和；真被说服了可以坦率承认。',
  },
  collab: {
    label: '合作',
    rule: '合作完成任务。大家一起完成主持人交代的任务：在前面成员已有成果的基础上继续推进（补充、修正、细化），不要推倒重来，也不要重复已有内容。',
  },
  independent: {
    label: '各自回答',
    rule: '各自回答。独立回答主持人最新的问题——你看不到其他成员这一轮的回答，也不用提到他们。',
  },
};

const LENGTHS = {
  short: { label: '简短', rule: '像群聊一样简短：一般 2～4 句话，不超过 150 字。' },
  medium: { label: '适中', rule: '简洁为主：一般不超过 300 字，需要时可以用简短的列表。' },
  long: { label: '详细', rule: '可以展开详细说明，但不要说空话、不要重复。' },
};

function buildSystemPrompt({ speaker, members, mode, length, isFinal, customInstruction }) {
  const me = MEMBERS[speaker];
  const lines = ['你正在参加一个多人群聊。群成员有：', `- ${HOST}：真人，也是这个群的主持人`];
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
    `5. 篇幅：${(LENGTHS[length] || LENGTHS.medium).rule}`,
    '6. 这里是纯聊天：不要读写文件、不要运行命令、不要调用任何工具，直接用文字回复。',
    '7. 主持人的要求优先于以上所有规则。',
    '',
    `当前模式：${(MODES[mode] || MODES.discuss).rule}`
  );
  if (isFinal && mode === 'collab') {
    lines.push('你是这一轮最后一个发言的人：发言最后请用几句话总结大家目前的结论，以及还没解决的分歧。');
  }
  if (customInstruction && customInstruction.trim()) {
    lines.push('', `主持人给你的额外设定：${customInstruction.trim()}`);
  }
  return lines.join('\n');
}

function clip(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}……（太长，后面省略）` : t;
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
    const name = m.speaker === 'user' ? HOST : MEMBERS[m.speaker].name;
    const mine = m.speaker === speaker ? '（你）' : '';
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
  if (!keep.length) return '（还没有任何消息）';
  const first = keep[0];
  if (first === 0) return keep.map((i) => blocks[i]).join('\n\n');

  const topicIdx = msgs.findIndex((m) => m.speaker === 'user');
  const head = topicIdx >= 0 && topicIdx < first ? [clip(blocks[topicIdx], 600)] : [];
  const omitted = first - head.length;
  return [...head, `（……中间省略了 ${omitted} 条较早的消息……）`, ...keep.map((i) => blocks[i])].join('\n\n');
}

function buildUserPrompt({ speaker, transcript }) {
  return [
    '下面是群聊记录（按时间顺序）：',
    '',
    transcript,
    '',
    '（以上是到目前为止的全部记录）',
    '',
    `现在轮到你（${MEMBERS[speaker].name}）发言了。直接写出你要发的内容即可。`,
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
  t = t.replace(new RegExp(`^(?:\\*\\*)?[【\\[]?${name}(?:（你）)?[】\\]]?(?:\\*\\*)?\\s*[：:]\\s*`, 'i'), '');
  t = t.replace(new RegExp(`^[【\\[]${name}(?:（你）)?[】\\]]\\s*\\n`, 'i'), '');
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
