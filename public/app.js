'use strict';

(() => {
  const $ = (s, root = document) => root.querySelector(s);

  // 桌面版（Electron）和浏览器版共用这一份界面
  const DESKTOP = /Electron\//.test(navigator.userAgent);
  // 界面语言由服务端决定（设置里可以改）；T('中文', 'English') 选当前语言的文字
  let LANG = document.documentElement.lang === 'en' ? 'en' : 'zh';
  const T = (zh, en) => (LANG === 'en' ? en : zh);
  const restartHint = () =>
    DESKTOP
      ? T('请关掉 AI 圆桌再重新打开', 'Close AI Roundtable and open it again')
      : T('确认黑色的命令行窗口还开着；关掉了就重新双击 start.bat', 'Make sure the black terminal window is still open; if you closed it, double-click start.bat again');
  const appName = () => T('AI 圆桌', 'AI Roundtable');

  const AVATAR_TEXT = { claude: 'C', gemini: 'G', gpt: 'GPT', user: '我' };
  const avatarText = (id) => (id === 'user' ? T('我', 'Me') : AVATAR_TEXT[id]);

  // index.html 里的固定文字：中文写在页面里，英文写在 data-en* 属性里
  function applyStaticLang() {
    document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
    const swap = (node, attr, get, set) => {
      const keep = `zh${attr}`;
      if (node.dataset[keep] == null) node.dataset[keep] = get();
      set(LANG === 'en' ? node.dataset[`en${attr}`] : node.dataset[keep]);
    };
    for (const n of document.querySelectorAll('[data-en]')) swap(n, '', () => n.textContent, (v) => (n.textContent = v));
    for (const n of document.querySelectorAll('[data-en-html]')) swap(n, 'Html', () => n.innerHTML, (v) => (n.innerHTML = v));
    for (const n of document.querySelectorAll('[data-en-placeholder]')) swap(n, 'Placeholder', () => n.placeholder, (v) => (n.placeholder = v));
    for (const n of document.querySelectorAll('[data-en-title]')) {
      swap(n, 'Title', () => n.getAttribute('title') || n.getAttribute('aria-label'), (v) => {
        if (n.hasAttribute('title')) n.title = v;
        if (n.hasAttribute('aria-label')) n.setAttribute('aria-label', v);
      });
    }
    $('#conn-banner').textContent = T(`与本地服务断开了，正在重连……（${restartHint()}）`, `Lost the connection to the local service; reconnecting... (${restartHint()})`);
  }
  const NAMES = { claude: 'Claude', gemini: 'Gemini', gpt: 'GPT' };
  const SECRET_KEYS = ['token', 'apiKey'];

  const state = {
    messages: [],
    members: [],
    modes: {},
    lengths: {},
    busy: false,
    queued: 0,
    typing: null,
    lastTs: 0,
    limits: { fileMB: 15, perMessage: 10 },
  };
  let optionsFilled = false;
  let typingTimer = null;

  // ---------- 小工具 ----------

  const prefs = {
    get(k, d) {
      try {
        const v = localStorage.getItem(`roundtable.${k}`);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`roundtable.${k}`, JSON.stringify(v));
      } catch {
        /* 浏览器不让存就算了 */
      }
    },
  };

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  async function api(path, body) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      const e = new Error(T('连不上本地服务', 'Could not reach the local service'));
      e.hint = restartHint();
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || T(`请求失败（${res.status}）`, `Request failed (${res.status})`));
      e.hint = data.hint;
      e.code = data.code;
      throw e;
    }
    return data;
  }

  let toastTimer;
  // 提示显示在输入区上方：输入区带着附件、或者窗口变窄时会变高，位置跟着调整
  function placeToast() {
    $('#toast').style.bottom = `${$('.composer').offsetHeight + 14}px`;
  }

  // msg 也可以是一组 { message, hint }：一次出了好几个错时一起显示（提示条只有一个，分开显示的话后一条会盖掉前一条）
  function toast(msg, kind = 'info', hint) {
    const t = $('#toast');
    const items = Array.isArray(msg) ? msg : [{ message: msg, hint }];
    t.className = `toast ${kind}`;
    placeToast();
    t.replaceChildren(...items.flatMap((it) => [el('div', { class: 'toast-msg' }, it.message), it.hint ? el('div', { class: 'toast-hint' }, it.hint) : null]).filter(Boolean));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 8000 + 2000 * (items.length - 1) : 3000);
  }

  function showError(e) {
    toast(e.message || String(e), 'error', e.hint);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (d.toDateString() === now.toDateString()) return hm;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return T(`昨天 ${hm}`, `Yesterday ${hm}`);
    if (LANG === 'en') return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })} ${hm}`;
    return `${d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }

  // token 数写成 860 / 12.3k / 1.2M
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    if (v < 1e6) return `${(v / 1000).toFixed(v < 1e4 ? 1 : 0)}k`;
    return `${(v / 1e6).toFixed(1)}M`;
  }

  // 恢复时间：今天写 15:00，明天写“明天 15:00”
  function fmtReset(ts) {
    const d = new Date(ts);
    const now = new Date();
    const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (d.toDateString() === now.toDateString()) return hm;
    const t = new Date(now);
    t.setDate(now.getDate() + 1);
    if (d.toDateString() === t.toDateString()) return T(`明天 ${hm}`, `tomorrow ${hm}`);
    return LANG === 'en' ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }

  function limitText(l) {
    if (!l) return '';
    return l.resetAt
      ? T(`预计 ${fmtReset(l.resetAt)} 恢复`, `expected back at ${fmtReset(l.resetAt)}`)
      : T(`恢复时间未知，${fmtReset(l.retryAt)} 自动再试`, `reset time unknown; trying again at ${fmtReset(l.retryAt)}`);
  }

  // ---------- Markdown（够用的精简版，先转义再排版，不会执行任何 HTML） ----------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inline(text) {
    let s = esc(text);
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    const links = [];
    const link = (href, label) => {
      links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      return `\u0001${links.length - 1}\u0001`;
    };
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t));
    s = s.replace(/(^|[\s(（:：])(https?:\/\/[^\s<)）\u0001，。；！？、]+)/g, (_, pre, u) => {
      const m = u.match(/^(.*?)([.,;:!?]*)$/);
      return `${pre}${link(m[1], m[1])}${m[2]}`;
    });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)]);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
    return s;
  }

  const LIST_RE = /^(\s*)([-*+•]|\d+[.)、])\s+(.*)$/;
  const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line || '');
  const splitRow = (line) => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };
  const isBlockStart = (line, next) =>
    /^\s*```/.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || LIST_RE.test(line) || HR_RE.test(line) || (line.includes('|') && isTableSep(next));

  function renderMarkdown(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lv = Math.min(6, h[1].length + 2);
        out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
        i++;
        continue;
      }
      if (HR_RE.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      if (line.includes('|') && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`
        );
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (LIST_RE.test(line)) {
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(LIST_RE);
          if (m) {
            const lvl = Math.min(4, Math.floor(m[1].replace(/\t/g, '    ').length / 2));
            items.push({ lvl, marker: /\d/.test(m[2]) ? m[2] : '•', text: m[3] });
            i++;
            continue;
          }
          if (items.length && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1].text += `\n${lines[i].trim()}`;
            i++;
            continue;
          }
          break;
        }
        out.push(
          `<div class="list">${items
            .map((it) => `<div class="li" style="--lvl:${it.lvl}"><span class="mk">${esc(it.marker)}</span><div>${it.text.split('\n').map(inline).join('<br>')}</div></div>`)
            .join('')}</div>`
        );
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i], lines[i + 1]))) buf.push(lines[i++]);
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function userHtml(text) {
    return esc(text).replace(/([@＠])(所有人|全体成员|全体|大家|all|everyone|claude|克劳德|gemini|双子座|双子|chatgpt|gpt|openai|codex)/gi, '<span class="mention">$1$2</span>');
  }

  // ---------- 聊天区 ----------

  const chat = () => $('#chat');
  const nearBottom = () => {
    const c = chat();
    return c.scrollHeight - c.scrollTop - c.clientHeight < 160;
  };
  const toBottom = () => {
    const c = chat();
    c.scrollTop = c.scrollHeight;
  };

  function avatar(id) {
    return el('div', { class: `avatar ${id}`, 'aria-hidden': 'true' }, avatarText(id) || '?');
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.textContent = T('已复制', 'Copied');
    setTimeout(() => (btn.textContent = T('复制', 'Copy')), 1200);
  }

  function messageNode(m) {
    if (m.speaker === 'system') {
      if (m.alert !== 'limit') return el('div', { class: `notice ${m.level || 'info'}` }, m.text);
      return el(
        'div',
        { class: `notice ${m.level || 'error'} limit-notice` },
        m.text,
        el('div', { class: 'notice-actions' }, el('button', { class: 'btn ghost sm', type: 'button', onclick: openUsage }, T('查看用量', 'View usage')))
      );
    }
    if (m.speaker === 'user') {
      return userMessageNode(m);
    }
    const meta = m.meta || {};
    const tokens = meta.tokens ? `${meta.tokensEstimated ? '≈' : ''}${fmtTokens(meta.tokens)} tokens` : '';
    const metaText = [meta.model, meta.effort, meta.ms ? T(`${(meta.ms / 1000).toFixed(1)} 秒`, `${(meta.ms / 1000).toFixed(1)}s`) : '', tokens, meta.note].filter(Boolean).join(' · ');
    const copyBtn = el('button', { class: 'copy', type: 'button', title: T('复制这条回复', 'Copy this reply') }, T('复制', 'Copy'));
    copyBtn.addEventListener('click', () => copyText(m.text, copyBtn));
    return el(
      'div',
      { class: `msg ai ${m.speaker}`, 'data-id': m.id },
      avatar(m.speaker),
      el(
        'div',
        { class: 'body' },
        el('div', { class: 'name' }, NAMES[m.speaker] || m.speaker, metaText ? el('span', { class: 'meta', title: meta.providerLabel || '' }, metaText) : null),
        el('div', { class: 'bubble md', html: renderMarkdown(m.text) }),
        el('div', { class: 'msg-tools' }, copyBtn)
      )
    );
  }

  function appendMessage(m, animate) {
    const box = $('#messages');
    const stick = nearBottom() || m.speaker === 'user';
    if (!state.lastTs || m.ts - state.lastTs > 5 * 60 * 1000) box.append(el('div', { class: 'timestamp' }, fmtTime(m.ts)));
    state.lastTs = m.ts;
    const node = messageNode(m);
    if (animate) node.classList.add('enter');
    box.append(node);
    updateWelcome();
    if (stick) requestAnimationFrame(toBottom);
  }

  function renderMessages() {
    $('#messages').replaceChildren();
    state.lastTs = 0;
    for (const m of state.messages) appendMessage(m, false);
    updateWelcome();
    requestAnimationFrame(toBottom);
  }

  function updateWelcome() {
    $('#welcome').classList.toggle('hidden', state.messages.length > 0);
    const needSetup = state.members.some((m) => m.enabled && !m.ready);
    $('#setup-tip').classList.toggle('hidden', !needSetup);
  }

  function renderTyping() {
    const box = $('#typing');
    clearInterval(typingTimer);
    if (!state.typing) {
      box.className = 'hidden';
      box.replaceChildren();
      return;
    }
    const { speaker, startedAt } = state.typing;
    const elapsed = el('span', { class: 'elapsed' });
    box.className = `msg ai ${speaker}`;
    box.replaceChildren(
      avatar(speaker),
      el('div', { class: 'body' }, el('div', { class: 'name' }, NAMES[speaker] || speaker), el('div', { class: 'bubble' }, el('span', { class: 'dots' }, el('i'), el('i'), el('i')), elapsed))
    );
    const tick = () => {
      const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      elapsed.textContent = T(`正在输入… ${sec} 秒`, `typing... ${sec}s`);
    };
    tick();
    typingTimer = setInterval(tick, 1000);
    if (nearBottom()) requestAnimationFrame(toBottom);
  }

  function renderMembers() {
    const box = $('#members');
    box.replaceChildren(
      ...state.members.map((m) => {
        const speaking = state.typing && state.typing.speaker === m.id;
        const limited = m.enabled && m.limited;
        const title = !m.enabled
          ? T(`${m.name}：已关闭`, `${m.name}: off`)
          : limited
            ? `${m.name}${T('：额度用完了，', ': out of usage, ')}${limitText(m.limited)}`
            : `${m.name}${T('：', ': ')}${m.ready ? `${m.providerLabel}${m.model ? ` · ${m.model}` : ''}` : m.reason}`;
        const warn = m.enabled && !m.ready && !limited;
        const cls = ['member', m.id, m.enabled ? '' : 'off', speaking ? 'speaking' : '', warn ? 'warn' : '', limited ? 'limited' : ''].filter(Boolean).join(' ');
        const badge = limited ? T('额度用完', 'Out of usage') : warn ? T('需设置', 'Needs setup') : null;
        return el('button', { class: cls, type: 'button', title, 'data-badge': badge, onclick: openUsage }, el('span', { class: 'dot' }), m.name);
      })
    );
    $('#mention-chips').replaceChildren(
      ...state.members
        .filter((m) => m.enabled)
        .map((m) =>
          el(
            'button',
            {
              class: `chip ${m.id}${m.limited ? ' limited' : ''}`,
              type: 'button',
              title: m.limited ? T(`${m.name} 额度用完了；点名会再试一次`, `${m.name} is out of usage; mentioning them tries again`) : T(`只让 ${m.name} 回答`, `Ask only ${m.name}`),
              onclick: () => insertMention(m.name),
            },
            `@${m.name}`
          )
        )
    );
    updateWelcome();
    renderLimitBanner();
    if (!$('#usage-modal').classList.contains('hidden')) renderUsage();
  }

  function updateButtons() {
    const hasText = $('#input').value.trim().length > 0;
    // 附件还在读取时先不让发；只有附件、没有文字也可以发
    $('#btn-send').disabled = pending.some((p) => p.status === 'uploading') || !(hasText || pending.length);
    $('#btn-stop').classList.toggle('hidden', !state.busy);
    $('#btn-continue').classList.toggle('hidden', state.busy);
    $('#btn-continue').disabled = !state.messages.some((m) => m.speaker === 'user');
    let hint = '';
    if (state.busy) hint = state.queued
        ? T(`后面还有 ${state.queued} 次发言在排队；这时发新消息会改变后面的安排`, `${state.queued} more ${state.queued === 1 ? 'reply is' : 'replies are'} queued; a new message now will change the plan`)
        : T('最后一位正在发言', 'The last member is replying');
    $('#queue-hint').textContent = hint;
  }

  // ---------- 附件（图片和文档） ----------

  // 输入区里还没发出去的附件：{ name, status: 'uploading' | 'ready', att（服务端返回的记录）, thumb（图片的预览地址） }
  const pending = [];

  function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  const extOf = (name) => (/\.([0-9A-Za-z]{1,8})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();
  const fileUrl = (a) => `/api/file/${encodeURIComponent(a.file)}`;

  // 文件名下面那行小字：页数、读出了多少字，或者为什么读不出来。
  // “不完整”这个记号（flag）单独拿出来：地方不够时省略前面的，不能把它省略掉
  function fileFacts(a) {
    if (a.kind === 'image') return { main: fmtSize(a.size), flag: '' };
    const parts = [];
    if (a.pages) parts.push(T(`${a.pages} 页`, `${a.pages} page${a.pages === 1 ? '' : 's'}`));
    const chars = Number(a.chars || 0).toLocaleString('en-US');
    if (a.chars) parts.push(T(`读出 ${chars} 字`, `${chars} character${a.chars === 1 ? '' : 's'} read`));
    else parts.push(a.encrypted ? T('加了密，读不出文字', 'encrypted, no text read') : T('读不出文字', 'no readable text'));
    return { main: parts.join(' · '), flag: a.chars && a.partial ? T('（不完整）', ' (incomplete)') : '' };
  }

  function fileMeta(a) {
    const { main, flag } = fileFacts(a);
    return main + flag;
  }

  // 鼠标停在附件上时的说明：文件名、下面那行小字（地方不够时显示不全），再加上需要解释的情况
  function fileTip(a) {
    const lines = [a.name, fileMeta(a)];
    if (a.kind === 'pdf') {
      if (a.encrypted) {
        lines.push(
          T(
            '这个 PDF 加了密，文字读不出来。会把文件本身交给各位成员，但他们多半也打不开；去掉密码（比如另存或者打印成一份新的 PDF）再添加更稳妥。',
            'This PDF is encrypted, so its text could not be read. The file itself is passed to each member, but they will probably not be able to open it either. Removing the password (for example by saving or printing it as a new PDF) and adding it again works better.'
          )
        );
      } else if (a.chars) {
        lines.push(
          T(
            '这个 PDF 里的文字只读出了一部分（有的页多半是扫描的图片），所以把文件本身也交给各位成员；看不了 PDF 的成员只看得到读出来的这部分。',
            'Only part of the text in this PDF could be read (some pages are probably scanned pictures), so the file itself is also passed to each member. Members that cannot read PDFs only see the part that was read.'
          )
        );
      } else {
        lines.push(
          T(
            '这个 PDF 里的文字读不出来（多半是扫描件），会把文件本身交给各位成员；看不了 PDF 的成员会说明自己看不到。',
            'The text in this PDF could not be read (it is probably a scan), so the file itself is passed to each member. Members that cannot read PDFs will say so.'
          )
        );
      }
    } else if (a.kind === 'doc' && a.chars && a.partial) {
      lines.push(T('文件太长，或者有的部分读不出来：各位成员只看得到读出来的这些文字。', 'The file is too long, or parts of it could not be read: members only see the text that was read.'));
    }
    return lines.join('\n');
  }

  function fileBadge(name) {
    const ext = extOf(name);
    return el('span', { class: `file-badge${ext ? ` ext-${ext}` : ''}`, 'aria-hidden': 'true' }, (ext || '?').slice(0, 4).toUpperCase());
  }

  const fileText = (name, meta, flag) =>
    el('span', { class: 'att-text' }, el('span', { class: 'att-name' }, name), el('span', { class: 'att-meta' }, el('span', { class: 'att-meta-main' }, meta), flag ? el('span', { class: 'att-flag' }, flag) : null));
  const fileFactsText = (a) => {
    const { main, flag } = fileFacts(a);
    return fileText(a.name, main, flag);
  };

  function openLightbox(src, name) {
    const img = $('#lightbox-img');
    img.src = src;
    img.alt = name || '';
    openModal('#lightbox');
  }

  // 聊天记录里的文档：点一下保存到电脑上
  function fileCard(a) {
    return el('a', { class: 'att-file', href: fileUrl(a), download: a.name, title: T(`${fileTip(a)}\n点击保存`, `${fileTip(a)}\nClick to save`) }, fileBadge(a.file), fileFactsText(a));
  }

  // 聊天记录里的图片：缩略图，点开看大图
  function imageThumb(a) {
    const img = el('img', { src: fileUrl(a), alt: a.name, loading: 'lazy' });
    const btn = el('button', { class: 'att-image', type: 'button', title: a.name, onclick: () => openLightbox(fileUrl(a), a.name) }, img);
    img.addEventListener('load', () => {
      // 图片加载出来会把下面的内容往下顶；原来在底部的话，继续贴着底部
      const c = chat();
      if (c.scrollHeight - c.scrollTop - c.clientHeight < 160 + img.height) toBottom();
    });
    // 加载不出来：文件已经不在了，或者浏览器打不开它
    img.addEventListener('error', () => btn.replaceWith(el('span', { class: 'att-file missing' }, fileBadge(a.file), fileText(a.name, T('这张图片显示不出来', 'this image cannot be displayed')))));
    return btn;
  }

  function userMessageNode(m) {
    const files = Array.isArray(m.attachments) ? m.attachments : [];
    const images = files.filter((a) => a.kind === 'image');
    return el(
      'div',
      { class: 'msg user', 'data-id': m.id },
      el(
        'div',
        { class: 'body' },
        images.length ? el('div', { class: `att-images${images.length > 1 ? ' multi' : ''}` }, ...images.map(imageThumb)) : null,
        ...files.filter((a) => a.kind !== 'image').map(fileCard),
        m.text ? el('div', { class: 'bubble', html: userHtml(m.text) }) : null
      ),
      avatar('user')
    );
  }

  function releaseThumb(p) {
    if (p.thumb) URL.revokeObjectURL(p.thumb);
    p.thumb = null;
  }

  let shown = []; // 上一次画出来的附件，和页面上的小卡片一一对应

  function renderPending() {
    const box = $('#attach-list');
    // 重画会把原来的按钮换成新的。键盘焦点正在某个附件的按钮上时先记下来，画完放回去；
    // 那个附件刚被去掉的话，交给补到它位置上的那一个，一个都不剩就回到输入框
    const active = document.activeElement;
    const at = active && box.contains(active) ? Array.from(box.children).indexOf(active.closest('.attach-item')) : -1;
    const was = at >= 0 ? shown[at] : null;
    const onThumb = Boolean(was) && active.classList.contains('attach-thumb');
    box.classList.toggle('hidden', !pending.length);
    box.replaceChildren(
      ...pending.map((p) => {
        const lead = p.thumb
          ? el('button', { class: 'attach-thumb', type: 'button', title: T('看大图', 'View larger'), onclick: () => openLightbox(p.thumb, p.name) }, el('img', { src: p.thumb, alt: '' }))
          : fileBadge(p.att ? p.att.file : p.name);
        const remove = el('button', { class: 'attach-remove', type: 'button', title: T('不发这个附件', 'Remove this attachment'), 'aria-label': T(`不发 ${p.name}`, `Remove ${p.name}`), onclick: () => removePending(p) }, '\u00d7');
        return el('div', { class: `attach-item ${p.status}`, title: p.att ? fileTip(p.att) : p.name }, lead, p.att ? fileFactsText(p.att) : fileText(p.name, T('读取中……', 'Reading...')), remove);
      })
    );
    shown = pending.slice();
    if (was) {
      const now = pending.indexOf(was);
      const item = box.children[now >= 0 ? now : Math.min(at, pending.length - 1)];
      const target = item ? (now >= 0 && onThumb && item.querySelector('.attach-thumb')) || item.querySelector('.attach-remove') : $('#input');
      target.focus();
    }
    updateButtons();
  }

  function removePending(p) {
    const i = pending.indexOf(p);
    if (i >= 0) pending.splice(i, 1);
    p.removed = true;
    if (p.att) api('/api/discard', { id: p.att.id }).catch(() => {});
    releaseThumb(p);
    renderPending();
  }

  const IMAGE_MAX_SIDE = 2400; // 图片的长边超过这个数就先缩小：各家 AI 看图时本来也会缩，原图只是白白多占上传时间和额度
  const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  // 文件的内容是不是 PNG / JPG / GIF / WebP：和服务端一样看开头的字节，不看扩展名。返回 'png'、'jpeg'、'gif'、'webp' 或 ''
  async function imageKind(file) {
    let b;
    try {
      b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    } catch {
      return '';
    }
    const has = (sig, from = 0) => sig.every((v, i) => b[from + i] === v);
    if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (has([0xff, 0xd8, 0xff])) return 'jpeg';
    if (has([0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
    if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
    return '';
  }

  // 图片在上传前整理一下：不大的 PNG / JPG 原样发；太大的缩小；其他格式（GIF、WebP、BMP……）转成 PNG 或 JPG，
  // 因为不是每家 AI 都认这些格式。浏览器打不开的图片（比如 HEIC）原样交给服务端，由它给出提示。
  async function prepareImage(file) {
    const same = { blob: file, name: file.name };
    if (typeof createImageBitmap !== 'function') return same;
    const kind = await imageKind(file);
    const type = kind ? `image/${kind}` : file.type;
    if (!/^image\//.test(type) || type === 'image/svg+xml') return same;
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      // 内容确实是这四种格式之一，浏览器却打不开：文件坏了（或者大得离谱）。现在就说，
      // 不然发出去以后界面上显示不出来，各家 AI 也看不了
      if (kind) {
        throw Object.assign(new Error(T(`「${file.name}」打不开，图片可能已经损坏`, `"${file.name}" could not be opened. The image may be damaged`)), {
          hint: T('换一张，或者重新保存一遍再添加', 'Try another one, or save it again and add that'),
        });
      }
      return same;
    }
    try {
      const side = Math.max(bmp.width, bmp.height);
      const plain = type === 'image/png' || type === 'image/jpeg';
      if (plain && side <= IMAGE_MAX_SIDE && file.size <= IMAGE_MAX_BYTES) return same;
      const scale = Math.min(1, IMAGE_MAX_SIDE / side);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      let blob = null;
      // 截图、图标这类图用 PNG 保持清晰；照片（或者 PNG 还是太大）用 JPG，透明的地方垫白底
      if (!/jpe?g|webp|avif/.test(type)) {
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        blob = await toBlob(canvas, 'image/png');
      }
      if (!blob || blob.size > IMAGE_MAX_BYTES) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        blob = await toBlob(canvas, 'image/jpeg', 0.9);
      }
      if (!blob) return same;
      return { blob, name: `${file.name.replace(/\.[^.]*$/, '') || 'image'}.${blob.type === 'image/png' ? 'png' : 'jpg'}` };
    } finally {
      bmp.close();
    }
  }

  function readBase64(blob, name) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const url = String(r.result);
        resolve(url.slice(url.indexOf(',') + 1));
      };
      r.onerror = () => reject(new Error(T(`「${name}」读不了`, `"${name}" could not be read`)));
      r.readAsDataURL(blob);
    });
  }

  // 一批文件里没加上的，攒在一起显示（一个一个显示的话，只看得到最后一个）
  const uploadErrors = [];
  const UPLOAD_ERRORS_SHOWN = 4;

  function showUploadErrors() {
    const items = uploadErrors.slice(0, UPLOAD_ERRORS_SHOWN).map((e) => ({ message: e.message || String(e), hint: e.hint }));
    // 连着几条的建议一样时，只在最后一条下面写一次
    items.forEach((it, i) => {
      if (items[i + 1] && items[i + 1].hint === it.hint) it.hint = '';
    });
    const more = uploadErrors.length - UPLOAD_ERRORS_SHOWN;
    if (more > 0) items.push({ message: T(`另外还有 ${more} 个文件没加上`, `${more} more ${more === 1 ? 'file' : 'files'} could not be added`) });
    toast(items, 'error');
  }

  async function uploadPending(p, file) {
    try {
      const { blob, name } = await prepareImage(file);
      const max = state.limits.fileMB;
      if (blob.size > max * 1024 * 1024) throw new Error(T(`「${name}」太大了（超过 ${max} MB）`, `"${name}" is too large (over ${max} MB)`));
      const data = await readBase64(blob, name);
      if (p.removed) return;
      const { attachment } = await api('/api/upload', { name, data });
      if (p.removed) {
        api('/api/discard', { id: attachment.id }).catch(() => {});
        return;
      }
      p.att = attachment;
      p.name = attachment.name;
      p.status = 'ready';
      if (attachment.kind === 'image') p.thumb = URL.createObjectURL(blob);
    } catch (e) {
      const i = pending.indexOf(p);
      if (i >= 0) pending.splice(i, 1);
      if (!p.removed) {
        uploadErrors.push(e);
        showUploadErrors();
      }
    } finally {
      renderPending();
    }
  }

  // 把用户选的、拖进来的或粘贴的文件加到输入区，并上传到本地服务（由它判断类型、取出文字）
  async function addFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    // 上一批都读完了，这才算新的一批；还在读的时候又加了几个，出的错接着攒在一起
    if (!pending.some((p) => p.status === 'uploading')) uploadErrors.length = 0;
    const max = state.limits.perMessage;
    const room = Math.max(0, max - pending.length);
    if (files.length > room) {
      uploadErrors.push(new Error(T(`一条消息最多带 ${max} 个附件`, `A message can have at most ${max} attachments`)));
      showUploadErrors();
    }
    const jobs = files.slice(0, room).map((file) => ({ p: { name: file.name || T('未命名', 'untitled'), status: 'uploading' }, file }));
    pending.push(...jobs.map((j) => j.p));
    renderPending();
    // 一个一个来，免得同时把好几个大文件读进内存
    for (const { p, file } of jobs) if (!p.removed) await uploadPending(p, file);
  }

  function initAttachments() {
    const input = $('#file-input');
    $('#btn-attach').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });

    // 粘贴：剪贴板里只有图片或文件时（截图、从资源管理器复制的文件）加成附件；带文字的照常粘贴文字
    document.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      if (!cd || !cd.files || !cd.files.length || cd.getData('text/plain')) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select') && e.target.id !== 'input') return;
      e.preventDefault();
      addFiles(cd.files);
    });

    // 拖放：整个窗口都可以放。不拦下来的话，浏览器会直接打开拖进来的文件，把聊天页面换掉
    const overlay = $('#drop-overlay');
    const hasFiles = (e) => Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types || []).includes('Files');
    let depth = 0;
    const hide = () => {
      depth = 0;
      overlay.classList.add('hidden');
    };
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay.classList.remove('hidden');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) hide();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      const files = [];
      let folders = 0;
      for (const item of Array.from(e.dataTransfer.items || [])) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) folders++;
        else {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (folders) toast(T('文件夹不能直接添加，请把里面的文件拖进来', 'Folders cannot be added; drag in the files inside instead'), 'error');
      addFiles(files.length || folders ? files : e.dataTransfer.files);
    });

    $('#lightbox').addEventListener('click', () => closeModal('#lightbox'));
  }

  // ---------- 输入区 ----------

  function fillOptions() {
    const mode = $('#opt-mode');
    mode.replaceChildren(...Object.entries(state.modes).map(([k, v]) => el('option', { value: k }, v)));
    mode.value = prefs.get('mode', 'discuss');
    if (!mode.value) mode.value = 'discuss';
    const len = $('#opt-length');
    len.replaceChildren(...Object.entries(state.lengths).map(([k, v]) => el('option', { value: k }, v)));
    len.value = prefs.get('length', 'medium');
    if (!len.value) len.value = 'medium';
    const rounds = $('#opt-rounds');
    rounds.value = String(prefs.get('rounds', 1));
    if (!rounds.value) rounds.value = '1';
  }

  function currentOpts() {
    return { mode: $('#opt-mode').value, rounds: Number($('#opt-rounds').value) || 1, length: $('#opt-length').value };
  }

  function autosize() {
    const ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }

  function insertMention(name) {
    const ta = $('#input');
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const pre = value.slice(0, s);
    const lead = pre && !/\s$/.test(pre) ? ' ' : '';
    const insert = `${lead}@${name} `;
    ta.value = pre + insert + value.slice(e);
    const pos = (pre + insert).length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    autosize();
    updateButtons();
  }

  async function send() {
    const ta = $('#input');
    const text = ta.value.trim();
    if (pending.some((p) => p.status === 'uploading')) return toast(T('附件还在读取，稍等一下再发', 'Still reading the attachments; send in a moment'));
    if (!text && !pending.length) return;
    // 先把输入区清空；发送失败再放回去
    const files = pending.splice(0, pending.length);
    ta.value = '';
    renderPending();
    autosize();
    try {
      await api('/api/send', { text, attachments: files.map((p) => p.att.id), ...currentOpts() });
      files.forEach(releaseThumb);
    } catch (e) {
      ta.value = text;
      // 服务重启过的话，之前上传的附件已经失效，只能重新添加
      if (e.code === 'attachments-gone') files.forEach(releaseThumb);
      else pending.unshift(...files);
      renderPending();
      autosize();
      showError(e);
    }
  }

  // ---------- 弹窗 ----------

  function openModal(sel) {
    $(sel).classList.remove('hidden');
  }

  function closeModal(sel) {
    $(sel).classList.add('hidden');
  }

  // ---------- 设置 ----------

  let settings = null;
  let draft = null;
  let settingsLang = '';
  const secretEdits = {};

  function field(label, control, help, extra, cls) {
    return el('div', { class: `field${cls ? ` ${cls}` : ''}` }, el('span', { class: 'field-label' }, label), control, extra || null, help ? el('span', { class: 'field-help' }, help) : null);
  }

  function toggle(checked, onChange, label) {
    const input = el('input', { type: 'checkbox', 'aria-label': label || T('启用', 'Enable') });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'switch', title: label || T('启用', 'Enable') }, input, el('span'));
  }

  async function openSettings() {
    try {
      settings = await api('/api/config');
    } catch (e) {
      showError(e);
      return;
    }
    draft = JSON.parse(JSON.stringify(settings.config));
    for (const k of Object.keys(secretEdits)) delete secretEdits[k];
    $('#settings-status').textContent = '';
    renderSettings();
    openModal('#settings-modal');
  }

  function renderSettings() {
    settingsLang = LANG;
    const body = $('#settings-body');
    body.classList.toggle('show-advanced', Boolean(prefs.get('advanced', false)));

    const timeout = el('input', { class: 'input', type: 'number', min: '30', max: '1800', step: '10' });
    timeout.value = draft.timeoutSec;
    timeout.addEventListener('input', () => (draft.timeoutSec = Number(timeout.value)));
    const proxy = el('input', { class: 'input', type: 'text', spellcheck: 'false', placeholder: T('例如 http://127.0.0.1:7890（不需要就留空）', 'e.g. http://127.0.0.1:7890 (leave empty if not needed)') });
    proxy.value = draft.proxy || '';
    proxy.addEventListener('input', () => (draft.proxy = proxy.value));
    const langSel = el(
      'select',
      { class: 'input' },
      el('option', { value: '' }, '跟随系统 / Follow system'),
      el('option', { value: 'zh' }, '中文'),
      el('option', { value: 'en' }, 'English')
    );
    langSel.value = draft.lang || '';
    langSel.addEventListener('change', () => (draft.lang = langSel.value));
    const rotate = el('input', { type: 'checkbox' });
    rotate.checked = Boolean(draft.rotateFirst);
    rotate.addEventListener('change', () => (draft.rotateFirst = rotate.checked));
    const adv = el('input', { type: 'checkbox' });
    adv.checked = Boolean(prefs.get('advanced', false));
    adv.addEventListener('change', () => {
      prefs.set('advanced', adv.checked);
      body.classList.toggle('show-advanced', adv.checked);
    });

    body.replaceChildren(
      el(
        'section',
        { class: 'card' },
        el('h3', null, T('通用', 'General')),
        field('语言 / Language', langSel),
        field(T('单次发言最长等多久（秒）', 'Max wait per reply (seconds)'), timeout, T('有的模型想得比较久；超过这个时间还没回复就放弃这次发言。', 'Some models think for a long time. A reply that takes longer than this is abandoned.')),
        field(T('代理地址（可选）', 'Proxy (optional)'), proxy, T('只有访问 GitHub / Google 接口需要代理时才填，也会传给三个命令行工具。', 'Only needed if you reach the GitHub / Google APIs through a proxy. It is also passed to the three command-line tools.')),
        el('label', { class: 'check' }, rotate, T('每次换一位成员先发言', 'Rotate who speaks first')),
        el('label', { class: 'check' }, adv, T('显示高级选项', 'Show advanced options'))
      ),
      ...draft.order.map((id, idx) => memberCard(id, idx))
    );
  }

  function move(idx, delta) {
    const j = idx + delta;
    if (j < 0 || j >= draft.order.length) return;
    [draft.order[idx], draft.order[j]] = [draft.order[j], draft.order[idx]];
    renderSettings();
  }

  function memberCard(id, idx) {
    const m = draft.members[id];
    const info = settings.members[id];
    const card = el('section', { class: `card member-card ${id}${m.enabled ? '' : ' disabled'}` });

    card.append(
      el(
        'div',
        { class: 'card-head' },
        avatar(id),
        el('div', { class: 'card-title' }, el('strong', null, info.name), el('span', { class: 'muted' }, `${info.maker} · ${T(`第 ${idx + 1} 个发言`, `speaks #${idx + 1}`)}`)),
        el(
          'div',
          { class: 'card-tools' },
          el('button', { class: 'icon-btn sm', type: 'button', title: T('往前挪', 'Move earlier'), disabled: idx === 0, onclick: () => move(idx, -1) }, '↑'),
          el('button', { class: 'icon-btn sm', type: 'button', title: T('往后挪', 'Move later'), disabled: idx === draft.order.length - 1, onclick: () => move(idx, 1) }, '↓'),
          toggle(
            m.enabled,
            (v) => {
              m.enabled = v;
              card.classList.toggle('disabled', !v);
            },
            T(`启用 ${info.name}`, `Enable ${info.name}`)
          )
        )
      )
    );

    const options = Object.entries(settings.providers).filter(([, p]) => p.member === id);
    const sel = el('select', { class: 'input' }, ...options.map(([pid, p]) => el('option', { value: pid }, p.label)));
    sel.value = m.provider;
    const fieldsBox = el('div', { class: 'provider-fields' });
    const renderFields = () => fieldsBox.replaceChildren(...providerFields(id, m.provider));
    sel.addEventListener('change', () => {
      m.provider = sel.value;
      renderFields();
    });
    card.append(field(T('接入方式', 'Connect via'), sel));
    card.append(fieldsBox);
    renderFields();

    const instr = el('textarea', { class: 'input', rows: '2', placeholder: T('例如：你是一位挑剔的投资人，说话犀利、爱追问', 'e.g. You are a picky investor: blunt, and you keep asking follow-up questions') });
    instr.value = m.instruction || '';
    instr.addEventListener('input', () => (m.instruction = instr.value));
    card.append(field(T('额外人设（可选）', 'Extra persona (optional)'), instr, T('会附加在它的群聊规则后面。', 'Added after its group-chat rules.')));

    const result = el('div', { class: 'test-result' });
    const btn = el('button', { class: 'btn ghost sm', type: 'button' }, T('保存并测试', 'Save and test'));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      result.className = 'test-result pending';
      result.textContent = T('测试中……命令行工具第一次启动可能要十几秒', 'Testing... a command-line tool can take ten seconds or more on first start');
      try {
        await saveSettings({ silent: true });
        const r = await api(`/api/test/${id}`, {});
        if (r.ok) {
          result.className = 'test-result ok';
          const extra = [r.model, r.effort, r.note].filter(Boolean).map((x) => ` · ${x}`).join('');
          const secs = (r.ms / 1000).toFixed(1);
          result.textContent = T(`✓ 连上了（${secs} 秒）回复：“${r.reply}”${extra}`, `✓ Connected (${secs}s). Reply: "${r.reply}"${extra}`);
        } else {
          result.className = 'test-result bad';
          result.replaceChildren(...[el('div', null, `✗ ${r.error}`), r.hint ? el('div', null, T(`建议：${r.hint}`, `Tip: ${r.hint}`)) : null].filter(Boolean));
        }
      } catch (e) {
        result.className = 'test-result bad';
        result.textContent = `✗ ${e.message}`;
      } finally {
        btn.disabled = false;
      }
    });
    card.append(el('div', { class: 'test-row' }, btn, result));
    return card;
  }

  function providerFields(id, pid) {
    const p = settings.providers[pid];
    const values = draft.members[id][pid] || (draft.members[id][pid] = {});
    const nodes = [];
    for (const f of p.fields) {
      let control;
      let input;
      if (f.secret) {
        const key = `${id}.${pid}.${f.key}`;
        const saved = values[`${f.key}Set`];
        input = el('input', {
          class: 'input',
          type: 'password',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: saved ? T(`已保存（${values[f.key]}），留空表示不修改`, `Saved (${values[f.key]}); leave empty to keep it`) : T('粘贴到这里', 'Paste here'),
        });
        input.value = secretEdits[key] || '';
        input.addEventListener('input', () => (secretEdits[key] = input.value.trim()));
        control = input;
      } else if (f.type === 'select') {
        input = el('select', { class: 'input' }, ...f.options.map(([v, label]) => el('option', { value: v }, label)));
        input.value = values[f.key] || f.options[0][0];
        input.addEventListener('change', () => (values[f.key] = input.value));
        control = input;
      } else if (f.type === 'model') {
        // 下拉选常用模型；“自定义”时显示输入框
        const CUSTOM = '__custom__';
        const cur = values[f.key] || '';
        const known = f.choices.some(([v]) => v === cur);
        const sel = el(
          'select',
          { class: 'input' },
          el('option', { value: '' }, T('默认', 'Default')),
          ...f.choices.map(([v, label]) => el('option', { value: v }, label)),
          el('option', { value: CUSTOM }, T('自定义…', 'Custom...'))
        );
        input = el('input', { class: 'input', type: 'text', spellcheck: 'false', placeholder: f.placeholder || '' });
        input.value = known ? '' : cur;
        sel.value = !cur ? '' : known ? cur : CUSTOM;
        const sync = () => {
          input.classList.toggle('hidden', sel.value !== CUSTOM);
          values[f.key] = sel.value === CUSTOM ? input.value.trim() : sel.value;
        };
        sel.addEventListener('change', () => {
          sync();
          if (sel.value === CUSTOM) input.focus();
        });
        input.addEventListener('input', sync);
        input.classList.toggle('hidden', sel.value !== CUSTOM);
        control = el('div', { class: 'model-pick' }, sel, input);
      } else if (f.type === 'number') {
        input = el('input', { class: 'input', type: 'number', min: '1000', step: '1000' });
        input.value = values[f.key] == null ? '' : values[f.key];
        input.addEventListener('input', () => (values[f.key] = Number(input.value)));
        control = input;
      } else {
        const listId = f.suggestions || f.loadModels ? `dl-${id}-${pid}-${f.key}` : null;
        input = el('input', { class: 'input', type: 'text', spellcheck: 'false', placeholder: f.placeholder || '', list: listId });
        input.value = values[f.key] || '';
        input.addEventListener('input', () => (values[f.key] = input.value));
        control = listId
          ? el('div', { class: 'with-btn' }, input, el('datalist', { id: listId }, ...(f.suggestions || []).map((s) => el('option', { value: s }))))
          : input;
        if (f.loadModels) {
          const btn = el('button', { class: 'btn ghost sm', type: 'button' }, T('加载可用模型', 'Load available models'));
          btn.addEventListener('click', () => loadGithubModels(btn, input, listId));
          control.append(btn);
        }
      }
      let extra = null;
      if (f.key === 'command' && settings.detect[pid]) {
        const d = settings.detect[pid];
        extra = el(
          'div',
          { class: `detect ${d.found ? 'ok' : 'bad'}` },
          d.found ? T(`已找到：${d.path}`, `Found: ${d.path}`) : T('还没找到这个命令（装好后关掉圆桌窗口重新打开，或者在这里填完整路径）', 'Command not found yet (after installing, restart AI Roundtable, or enter the full path here)')
        );
      }
      nodes.push(field(f.label, control, f.help, extra, f.advanced ? 'advanced' : ''));
    }
    return nodes;
  }

  function buildPatch() {
    const patch = JSON.parse(JSON.stringify(draft));
    for (const id of Object.keys(patch.members)) {
      for (const [pid, vals] of Object.entries(patch.members[id])) {
        if (!vals || typeof vals !== 'object') continue;
        for (const k of Object.keys(vals)) if (k.endsWith('Set') || SECRET_KEYS.includes(k)) delete vals[k];
        for (const k of SECRET_KEYS) {
          const edit = secretEdits[`${id}.${pid}.${k}`];
          if (edit) vals[k] = edit;
        }
      }
    }
    return patch;
  }

  async function saveSettings({ silent } = {}) {
    const res = await api('/api/config', buildPatch());
    settings = res;
    setLang(res.lang);
    if (settingsLang !== LANG && !$('#settings-modal').classList.contains('hidden')) {
      draft = JSON.parse(JSON.stringify(res.config));
      renderSettings();
    }
    if (!silent) toast(T('设置已保存', 'Settings saved'), 'ok');
    return res;
  }

  async function loadGithubModels(btn, input, listId) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = T('加载中…', 'Loading...');
    try {
      await saveSettings({ silent: true });
      const { items } = await api('/api/github-models', {});
      const dl = document.getElementById(listId);
      dl.replaceChildren(...items.map((m) => el('option', { value: m.id }, `${m.name}${m.tier ? `（${m.tier}）` : ''}`)));
      toast(T(`找到 ${items.length} 个模型：点一下模型输入框就能选`, `Found ${items.length} models: click the model box to choose one`), 'ok');
      input.focus();
    } catch (e) {
      showError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  // ---------- 用量和额度 ----------

  let bannerDismissed = '';
  const limitedMembers = () => state.members.filter((m) => m.enabled && m.limited);

  // 顶部的红色提醒：谁的额度用完了、什么时候恢复；点 × 收起，情况变了会再出来
  function renderLimitBanner() {
    const box = $('#limit-banner');
    const out = limitedMembers();
    const key = out.map((m) => `${m.id}:${m.limited.since}`).join(',');
    if (!out.length || key === bannerDismissed) {
      box.classList.add('hidden');
      box.replaceChildren();
      return;
    }
    const left = state.members.filter((m) => m.enabled && !m.limited).map((m) => m.name);
    const who = out.map((m) => T(`${m.name} 额度用完了，${limitText(m.limited)}`, `${m.name} is out of usage, ${limitText(m.limited)}`)).join(T('；', '; '));
    const rest = left.length ? T(`先由 ${left.join('、')} 继续聊。`, `${left.join(', ')} will carry on.`) : T('现在没有成员能发言。', 'No member can reply right now.');
    const text = `⚠ ${who}${T('。', '. ')}${rest}`;
    box.replaceChildren(
      el('span', { class: 'lb-text' }, text),
      el('button', { class: 'btn ghost sm', type: 'button', onclick: openUsage }, T('用量', 'Usage')),
      el('button', { class: 'icon-btn sm', type: 'button', title: T('收起', 'Dismiss'), 'aria-label': T('收起', 'Dismiss'), onclick: () => {
        bannerDismissed = key;
        renderLimitBanner();
      } }, '×')
    );
    box.classList.remove('hidden');
  }

  // 额度用完时响两声，窗口不在前台时再发一条系统通知
  function alarm(m) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        [0, 0.22].forEach((t, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = i ? 660 : 880;
          g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
          g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.18);
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + t);
          o.stop(ctx.currentTime + t + 0.2);
        });
        setTimeout(() => ctx.close(), 800);
      }
    } catch {
      /* 没有声音也没关系 */
    }
    try {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(appName(), { body: m.text.split('\n')[0] });
      }
    } catch {
      /* 不支持通知就算了 */
    }
  }

  function openUsage() {
    renderUsage();
    openModal('#usage-modal');
  }

  function renderUsage() {
    const body = $('#usage-body');
    const rows = [
      ['h5', T('最近 5 小时', 'Last 5 hours')],
      ['day', T('最近 24 小时', 'Last 24 hours')],
      ['week', T('最近 7 天', 'Last 7 days')],
    ];
    const cards = state.members.map((m) => {
      const u = m.usage || {};
      const status = !m.enabled
        ? el('span', { class: 'u-status off' }, T('已关闭', 'Off'))
        : m.limited
          ? el('span', { class: 'u-status bad' }, `${T('额度用完', 'Out of usage')} · ${limitText(m.limited)}`)
          : el('span', { class: 'u-status ok' }, T('可以发言', 'Available'));
      const table = el(
        'table',
        { class: 'usage-table' },
        el('thead', null, el('tr', null, el('th', null, ''), el('th', null, T('合计', 'Total')), el('th', null, T('输入', 'Input')), el('th', null, T('输出', 'Output')), el('th', null, T('次数', 'Calls')))),
        el(
          'tbody',
          null,
          ...rows.map(([k, label]) => {
            const w = u[k] || {};
            const est = w.estimated ? '≈' : '';
            // 走缓存的输入便宜得多，不算进合计，鼠标停在合计上能看到
            const cached = w.cached ? { title: T(`另有 ${fmtTokens(w.cached)} 走缓存的输入，没有计入合计`, `Plus ${fmtTokens(w.cached)} cached input tokens, not counted in the total`) } : null;
            return el(
              'tr',
              null,
              el('th', null, label),
              el('td', cached, `${est}${fmtTokens(w.total)}${w.cached ? ' *' : ''}`),
              el('td', null, w.input ? `${est}${fmtTokens(w.input)}` : '–'),
              el('td', null, w.output ? `${est}${fmtTokens(w.output)}` : '–'),
              el('td', null, String(w.calls || 0))
            );
          })
        )
      );
      const tools = el('div', { class: 'usage-tools' });
      if (m.limited) {
        tools.append(
          el('button', { class: 'btn primary sm', type: 'button', title: T('去掉“额度用完”的标记，下次照常让它发言', 'Clear the out-of-usage mark so it speaks again next time'), onclick: () => usageAction('/api/usage/retry', { member: m.id }) }, T('再试一次', 'Try again'))
        );
      }
      tools.append(
        el('button', { class: 'btn ghost sm', type: 'button', onclick: () => {
          if (confirm(T(`把 ${m.name} 的用量记录清零？`, `Reset ${m.name}'s usage counts?`))) usageAction('/api/usage/reset', { member: m.id });
        } }, T('清零', 'Reset'))
      );
      return el(
        'section',
        { class: `card usage-card ${m.id}${m.limited ? ' limited' : ''}` },
        el('div', { class: 'card-head' }, avatar(m.id), el('div', { class: 'card-title' }, el('strong', null, m.name), el('span', { class: 'muted' }, m.providerLabel)), status),
        m.limited && m.limited.message ? el('div', { class: 'usage-msg' }, m.limited.message) : null,
        table,
        tools
      );
    });
    body.replaceChildren(
      ...cards,
      el(
        'p',
        { class: 'field-help usage-note' },
        T(
          '订阅（Max、AI Pro、ChatGPT）的具体额度官方没有公开，这里只统计在 AI 圆桌里用了多少。合计 = 输入 + 输出；带 * 的另有走缓存的输入（便宜得多，没有计入合计，鼠标停在数字上可以看到）。“额度用完”是根据工具返回的报错判断的：到了恢复时间会自动回到群里；点名它或者在设置里点「保存并测试」也会再试一次。带 ≈ 的是按字数估算的（Antigravity CLI 不报告用量）。',
          'Subscriptions (Max, AI Pro, ChatGPT) do not publish exact limits, so this only counts what AI Roundtable used. Total = input + output; a * means there were also cached input tokens (much cheaper, not counted in the total; hover over the number to see them). "Out of usage" comes from the error the tool returns: the member rejoins automatically at the reset time, and mentioning them or clicking "Save and test" in Settings tries again. Numbers with ≈ are estimated from text length (Antigravity CLI does not report usage).'
        )
      )
    );
  }

  async function usageAction(path, body) {
    try {
      const r = await api(path, body);
      state.members = r.members;
      renderMembers();
    } catch (e) {
      showError(e);
    }
  }

  // ---------- 历史 ----------

  async function openHistory() {
    const body = $('#history-body');
    body.replaceChildren(el('div', { class: 'empty-history' }, T('加载中……', 'Loading...')));
    openModal('#history-modal');
    try {
      const { items } = await api('/api/history');
      if (!items.length) {
        body.replaceChildren(el('div', { class: 'empty-history' }, T('还没有历史对话。', 'No past chats yet.'), el('br'), T('点「新对话」时，当前对话会自动存到这里。', 'When you start a new chat, the current one is saved here.')));
        return;
      }
      body.replaceChildren(
        ...items.map((it) => {
          const b = el('button', { class: 'history-item', type: 'button' }, el('span', { class: 'h-title' }, it.title), el('span', { class: 'h-meta' }, `${fmtTime(it.createdAt)} · ${T(`${it.count} 条消息`, `${it.count} message${it.count === 1 ? '' : 's'}`)}`));
          b.addEventListener('click', async () => {
            try {
              await api('/api/history/open', { file: it.file });
              closeModal('#history-modal');
            } catch (e) {
              showError(e);
            }
          });
          return b;
        })
      );
    } catch (e) {
      body.replaceChildren(el('div', { class: 'empty-history' }, e.message));
    }
  }

  // ---------- 实时连接 ----------

  let bannerTimer = null;
  function setConnected(ok) {
    clearTimeout(bannerTimer);
    if (ok) $('#conn-banner').classList.add('hidden');
    else bannerTimer = setTimeout(() => $('#conn-banner').classList.remove('hidden'), 1500);
  }

  // 换语言：固定文字和下拉选项要重画（打开着的设置窗口在保存后重画）
  function setLang(v) {
    const lang = v === 'en' ? 'en' : 'zh';
    if (lang === LANG) return;
    LANG = lang;
    prefs.set('lang', lang);
    applyStaticLang();
    optionsFilled = false;
    // 输入区里还没发出去的附件，上面的文字也跟着换
    if (pending.length) renderPending();
  }

  function applySnapshot(s) {
    setLang(s.lang);
    state.messages = s.messages || [];
    state.members = s.members || [];
    state.modes = s.modes || state.modes;
    state.lengths = s.lengths || state.lengths;
    state.limits = s.limits || state.limits;
    state.busy = s.state.busy;
    state.queued = s.state.queued;
    state.typing = s.state.typing;
    if (!optionsFilled) {
      fillOptions();
      optionsFilled = true;
    }
    renderMessages();
    renderMembers();
    renderTyping();
    updateButtons();
    document.title = state.messages.length ? `${appName()} · ${s.conversation.title}` : appName();
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('snapshot', (e) => applySnapshot(JSON.parse(e.data)));
    es.addEventListener('msg', (e) => {
      const m = JSON.parse(e.data);
      if (state.messages.some((x) => x.id === m.id)) return;
      state.messages.push(m);
      appendMessage(m, true);
      updateButtons();
      if (m.alert === 'limit') alarm(m);
    });
    es.addEventListener('typing', (e) => {
      state.typing = JSON.parse(e.data);
      renderTyping();
      renderMembers();
    });
    es.addEventListener('state', (e) => {
      const s = JSON.parse(e.data);
      state.busy = s.busy;
      state.queued = s.queued;
      const before = JSON.stringify(state.typing);
      state.typing = s.typing;
      if (before !== JSON.stringify(state.typing)) {
        renderTyping();
        renderMembers();
      }
      updateButtons();
    });
    es.addEventListener('members', (e) => {
      state.members = JSON.parse(e.data);
      renderMembers();
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
  }

  // ---------- 绑定事件 ----------

  function init() {
    if (DESKTOP) document.documentElement.classList.add('desktop');
    LANG = prefs.get('lang', LANG) === 'en' ? 'en' : 'zh';
    applyStaticLang();
    initAttachments();
    if (window.ResizeObserver) new ResizeObserver(placeToast).observe($('.composer'));
    const ta = $('#input');
    ta.addEventListener('input', () => {
      autosize();
      updateButtons();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send();
      }
    });
    $('#btn-send').addEventListener('click', send);
    $('#btn-stop').addEventListener('click', () => api('/api/stop', {}).catch(showError));
    $('#btn-continue').addEventListener('click', () => api('/api/continue', currentOpts()).catch(showError));
    $('#btn-new').addEventListener('click', () => {
      if (state.messages.length && !confirm(T('开始新对话？当前对话会保存到「历史对话」里。', 'Start a new chat? The current one will be saved to chat history.'))) return;
      api('/api/new', {}).catch(showError);
    });
    $('#btn-export').addEventListener('click', () => {
      if (!state.messages.length) return toast(T('现在还没有内容可以导出', 'Nothing to export yet'));
      window.location.href = '/api/export';
    });
    $('#btn-history').addEventListener('click', openHistory);
    $('#btn-usage').addEventListener('click', openUsage);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-save-settings').addEventListener('click', async () => {
      try {
        await saveSettings();
        closeModal('#settings-modal');
      } catch (e) {
        showError(e);
      }
    });

    for (const id of ['opt-mode', 'opt-rounds', 'opt-length']) {
      $(`#${id}`).addEventListener('change', (e) => {
        const key = id.replace('opt-', '');
        prefs.set(key, key === 'rounds' ? Number(e.target.value) : e.target.value);
      });
    }

    document.querySelectorAll('.example').forEach((b) => {
      b.addEventListener('click', () => {
        $('#opt-mode').value = b.dataset.mode;
        prefs.set('mode', b.dataset.mode);
        ta.value = LANG === 'en' ? b.dataset.enText : b.dataset.text;
        autosize();
        updateButtons();
        ta.focus();
      });
    });

    document.querySelectorAll('.modal').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.closest('[data-close]')) modal.classList.add('hidden');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach((m) => m.classList.add('hidden'));
    });

    autosize();
    connect();
  }

  init();
})();
