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
      e.hint = RESTART_HINT;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || T(`请求失败（${res.status}）`, `Request failed (${res.status})`));
      e.hint = data.hint;
      throw e;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, kind = 'info', hint) {
    const t = $('#toast');
    t.className = `toast ${kind}`;
    t.replaceChildren(...[el('div', null, msg), hint ? el('div', { class: 'toast-hint' }, hint) : null].filter(Boolean));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 8000 : 3000);
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
    if (m.speaker === 'system') return el('div', { class: `notice ${m.level || 'info'}` }, m.text);
    if (m.speaker === 'user') {
      return el('div', { class: 'msg user', 'data-id': m.id }, el('div', { class: 'body' }, el('div', { class: 'bubble', html: userHtml(m.text) })), avatar('user'));
    }
    const meta = m.meta || {};
    const metaText = [meta.model, meta.effort, meta.ms ? T(`${(meta.ms / 1000).toFixed(1)} 秒`, `${(meta.ms / 1000).toFixed(1)}s`) : '', meta.note].filter(Boolean).join(' · ');
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
        const title = !m.enabled ? T(`${m.name}：已关闭`, `${m.name}: off`) : `${m.name}${T('：', ': ')}${m.ready ? `${m.providerLabel}${m.model ? ` · ${m.model}` : ''}` : m.reason}`;
        const cls = ['member', m.id, m.enabled ? '' : 'off', speaking ? 'speaking' : '', m.enabled && !m.ready ? 'warn' : ''].filter(Boolean).join(' ');
        return el('span', { class: cls, title }, el('span', { class: 'dot' }), m.name);
      })
    );
    $('#mention-chips').replaceChildren(
      ...state.members
        .filter((m) => m.enabled)
        .map((m) => el('button', { class: `chip ${m.id}`, type: 'button', title: T(`只让 ${m.name} 回答`, `Ask only ${m.name}`), onclick: () => insertMention(m.name) }, `@${m.name}`))
    );
    updateWelcome();
  }

  function updateButtons() {
    const hasText = $('#input').value.trim().length > 0;
    $('#btn-send').disabled = !hasText;
    $('#btn-stop').classList.toggle('hidden', !state.busy);
    $('#btn-continue').classList.toggle('hidden', state.busy);
    $('#btn-continue').disabled = !state.messages.some((m) => m.speaker === 'user');
    let hint = '';
    if (state.busy) hint = state.queued
        ? T(`后面还有 ${state.queued} 次发言在排队；这时发新消息会改变后面的安排`, `${state.queued} more ${state.queued === 1 ? 'reply is' : 'replies are'} queued; a new message now will change the plan`)
        : T('最后一位正在发言', 'The last member is replying');
    $('#queue-hint').textContent = hint;
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
    if (!text) return;
    ta.value = '';
    autosize();
    updateButtons();
    try {
      await api('/api/send', { text, ...currentOpts() });
    } catch (e) {
      ta.value = text;
      autosize();
      updateButtons();
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
  }

  function applySnapshot(s) {
    setLang(s.lang);
    state.messages = s.messages || [];
    state.members = s.members || [];
    state.modes = s.modes || state.modes;
    state.lengths = s.lengths || state.lengths;
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
