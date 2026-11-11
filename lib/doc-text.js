'use strict';

// 从文档里取出文字：纯文本（自动识别编码）、Word / Excel / PowerPoint（docx / xlsx / pptx）。
// docx / xlsx / pptx 都是 zip 包着的 XML，这里自己解包、自己解析，不依赖第三方库。
// PDF 见 lib/pdf-text.js。
//
// 文件是用户从别处拿来的，可能是坏的，也可能是故意做出来捣乱的，所以这里处处设了上限：
// - 解压：单个文件、整份文档各有大小上限（防压缩炸弹）；
// - 解析：全部用 indexOf 顺着往后扫，不用“<a>…</a>”这类会来回试的正则，标签没写完、没有结束标签也只扫一遍；
// - 时间：一份文档最多处理 MAX_MS，到时间就停，已经取出的文字照样用；
// - 输出：最多保留 MAX_TEXT 个字。

const zlib = require('zlib');

const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // 单个 XML 解压后的上限，防止压缩炸弹
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 一份文档总共最多解压出这么多
const MAX_TEXT = 400000; // 一份文档最多保留多少字
const MAX_MS = 10000; // 一份文档最多处理这么久
// 各种清单的条数也有上限（正常的文档差得很远）：解压后 64 MB 的 XML 可以写下上千万个空标签，每个记一条就是几百兆内存
const MAX_PARTS = 10000; // 工作表、幻灯片
const MAX_LIST = 100000; // 关系、样式
const MAX_SHARED = 2000000; // Excel 的共享字符串

// ---------- zip ----------

function openZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, {
      method: buf.readUInt16LE(off + 10),
      size: buf.readUInt32LE(off + 20),
      local: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  let left = MAX_TOTAL_BYTES; // 还可以读出多少字节
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    // 读出一个文件的内容；没有这个文件时返回 null
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size === 0xffffffff || e.local === 0xffffffff) throw new Error('zip64 is not supported');
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('broken zip entry');
      if (left <= 0) throw new Error('too much data in this zip file');
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const packed = buf.subarray(start, start + e.size);
      let data;
      if (e.method === 0) data = packed;
      else if (e.method === 8) data = zlib.inflateRawSync(packed, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, left) });
      else throw new Error(`unsupported zip compression method ${e.method}`);
      left -= data.length;
      return data;
    },
    text(name) {
      const data = this.read(name);
      return data ? data.toString('utf8') : null;
    },
  };
}

// ---------- XML 小工具 ----------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  const t = String(s);
  if (!t.includes('&')) return t;
  return t.replace(/&(#x[0-9a-fA-F]{1,8}|#\d{1,8}|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e];
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  });
}

const ATTR_RE = new Map();
function attrRe(key, source) {
  if (!ATTR_RE.has(key)) ATTR_RE.set(key, new RegExp(`(?:^|\\s)${source}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return ATTR_RE.get(key);
}

// 属性的值，没有这个属性返回 null。名字要写全（带前缀的连前缀一起写）
function attr(tag, name) {
  const m = attrRe(name, name).exec(tag);
  return m ? decodeXml(m[1] != null ? m[1] : m[2]) : null;
}

// 带前缀的属性，前缀是什么都行（w:val、r:id 的前缀可以随便起）。只认带前缀的：<p:sldId id="256" r:id="rId2"> 里要的是后一个
function attrNs(tag, local) {
  const m = attrRe(`:${local}`, `[A-Za-z_][\\w.-]*:${local}`).exec(tag);
  return m ? decodeXml(m[1] != null ? m[1] : m[2]) : null;
}

// 标签的前缀也可以随便起：<w:p> 写成 <ns0:p>、Excel 的 <row> 写成 <x:row>（.NET 的一些库就这么写）都是合法的。
// 下面按命名空间的网址认（看文件开头声明的 xmlns），把标签的前缀改回通常的写法，后面就可以按固定的名字找标签。
const OOXML = 'http://schemas.openxmlformats.org/';
const STRICT = 'http://purl.oclc.org/ooxml/';
const NS = {
  w: [`${OOXML}wordprocessingml/2006/main`, `${STRICT}wordprocessingml/main`],
  m: [`${OOXML}officeDocument/2006/math`, `${STRICT}officeDocument/math`],
  a: [`${OOXML}drawingml/2006/main`, `${STRICT}drawingml/main`],
  p: [`${OOXML}presentationml/2006/main`, `${STRICT}presentationml/main`],
  sheet: [`${OOXML}spreadsheetml/2006/main`, `${STRICT}spreadsheetml/main`],
  rels: [`${OOXML}package/2006/relationships`],
};
const XMLNS = /\sxmlns:([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// want：{ 通常的前缀: 命名空间 }，例如 { w: NS.w }；通常不带前缀的写成 { '': NS.sheet }
// 每种命名空间只换一个前缀（正常的文件也只有一个）：每换一次要把整份 XML 过一遍，不能让文件里声明几百个前缀就换几百遍
function canonical(xml, want) {
  if (!xml) return xml;
  let out = xml;
  const done = new Set();
  for (const m of xml.slice(0, 16384).matchAll(XMLNS)) {
    const used = m[1];
    const uri = m[2] != null ? m[2] : m[3];
    for (const [prefix, uris] of Object.entries(want)) {
      if (used === prefix || done.has(prefix) || !uris.includes(uri)) continue;
      done.add(prefix);
      const to = prefix ? `${prefix}:` : '';
      out = out.replaceAll(`<${used}:`, `<${to}`).replaceAll(`</${used}:`, `</${to}`);
    }
  }
  return out;
}

// 标签名到这里结束：空白、/、>，或者已经到了末尾
const nameEnds = (c) => c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13 || c !== c;

// 依次给出 xml 里的每个标签，顺着往后只扫一遍。
// 每个标签：{ name, close（是结束标签）, empty（<a/> 这样自己结束）, attrs（属性那一段的起止位置）, end（标签之后的位置） }
function* tags(xml) {
  let pos = 0;
  for (;;) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) return;
    if (xml.charCodeAt(lt + 1) === 33) {
      // 注释和 CDATA 里面可以有 >，要找它们自己的结束标记
      const stop = xml.startsWith('<!--', lt) ? xml.indexOf('-->', lt + 4) + 2 : xml.startsWith('<![CDATA[', lt) ? xml.indexOf(']]>', lt + 9) + 2 : xml.indexOf('>', lt);
      if (stop < lt) return;
      pos = stop + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return;
    pos = gt + 1;
    const close = xml.charCodeAt(lt + 1) === 47;
    const from = lt + (close ? 2 : 1);
    let to = from;
    while (to < gt && !nameEnds(xml.charCodeAt(to))) to++;
    const empty = !close && xml.charCodeAt(gt - 1) === 47;
    yield { name: xml.slice(from, to), close, empty, attrs: [to, empty ? gt - 1 : gt], end: gt + 1 };
  }
}

const attrsOf = (xml, tag) => xml.slice(tag.attrs[0], tag.attrs[1]);

// 标签后面紧跟着的文字（到下一个标签为止）
function textAfter(xml, tag) {
  const next = xml.indexOf('<', tag.end);
  return decodeXml(xml.slice(tag.end, next < 0 ? xml.length : next));
}

// 找下一个名字正好是 tag 的开始标签（<row> 不会把 <rowBreaks> 也算上），返回位置，没有返回 -1
function findOpen(xml, tag, pos) {
  const open = `<${tag}`;
  for (;;) {
    const at = xml.indexOf(open, pos);
    if (at < 0) return -1;
    if (nameEnds(xml.charCodeAt(at + open.length))) return at;
    pos = at + open.length;
  }
}

// 依次给出 xml 里所有的 <tag ...>...</tag>（或 <tag .../>）：{ attrs, body }，不考虑同名标签套同名标签。
// 遇到没写完的标签、没有结束标签的元素就停下，后面的不要了。
function* elements(xml, tag) {
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const at = findOpen(xml, tag, pos);
    if (at < 0) return;
    const gt = xml.indexOf('>', at);
    if (gt < 0) return;
    const from = at + tag.length + 1;
    if (xml.charCodeAt(gt - 1) === 47) {
      yield { attrs: xml.slice(from, gt - 1), body: '' };
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { attrs: xml.slice(from, gt), body: xml.slice(gt + 1, end) };
    pos = end + close.length;
  }
}

// 第一个 <tag>...</tag> 里面的内容，没有返回 null
function firstBody(xml, tag) {
  for (const el of elements(xml, tag)) return el.body;
  return null;
}

// 去掉所有的 <tag>...</tag>
function without(xml, tag) {
  if (findOpen(xml, tag, 0) < 0) return xml;
  const close = `</${tag}>`;
  let out = '';
  let pos = 0;
  for (;;) {
    const at = findOpen(xml, tag, pos);
    if (at < 0) break;
    const gt = xml.indexOf('>', at);
    if (gt < 0) break;
    const end = xml.charCodeAt(gt - 1) === 47 ? gt + 1 : xml.indexOf(close, gt + 1) + close.length;
    if (end < close.length) break;
    out += xml.slice(pos, at);
    pos = end;
  }
  return out + xml.slice(pos);
}

// 关系文件（_rels/*.rels）：关系 Id → 指向的文件（按所在目录解析成 zip 里的完整路径）。
// out：给了的话，顺便看时间（out.more），到时间就不往下读了
function readRels(zip, relsPath, baseDir, out) {
  const xml = canonical(zip.text(relsPath), { '': NS.rels });
  const map = new Map();
  if (!xml) return map;
  for (const t of tags(xml)) {
    if (out && !out.more) break;
    if (t.name !== 'Relationship' || t.close) continue;
    const a = attrsOf(xml, t);
    const id = attr(a, 'Id');
    const target = attr(a, 'Target');
    if (!id || !target || attr(a, 'TargetMode') === 'External') continue;
    map.set(id, resolvePath(baseDir, target));
    if (map.size >= MAX_LIST) break;
  }
  return map;
}

function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir ? baseDir.split('/') : [];
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}

// 一个文件的关系里，属于某几类（比如幻灯片的 notesSlide、Word 正文的 header 和 footer）的那些文件：[{ kind, file }]，最多 max 个
function relatedParts(zip, file, kinds, out, max = 64) {
  const slash = file.lastIndexOf('/');
  const dir = file.slice(0, slash);
  const relsPath = `${dir}/_rels/${file.slice(slash + 1)}.rels`;
  const found = [];
  if (!zip.has(relsPath)) return found;
  const xml = canonical(readPart(zip, relsPath, out), { '': NS.rels });
  for (const t of tags(xml)) {
    if (!out.more || found.length >= max) break;
    if (t.name !== 'Relationship' || t.close) continue;
    const a = attrsOf(xml, t);
    const target = attr(a, 'Target');
    const type = attr(a, 'Type') || '';
    const kind = type.slice(type.lastIndexOf('/') + 1);
    if (target && kinds.includes(kind) && attr(a, 'TargetMode') !== 'External') found.push({ kind, file: resolvePath(dir, target) });
  }
  return found;
}

// 读 zip 里的一个文件。读不出来（坏了，或者解压的总量超了）时：前面已经取到文字就到此为止，否则报错
function readPart(zip, file, out) {
  try {
    return zip.text(file) || '';
  } catch (e) {
    if (!out.size) throw e;
    out.cut = true;
    return '';
  }
}

// 写进文字里的几个说明用语。调用的地方（lib/attachments.js）会按界面语言换掉
const LABELS = { notes: '备注：', hidden: '（隐藏）', header: '页眉：', footer: '页脚：' };

// 取出来的文字攒在这里。写满了（MAX_TEXT）或者时间到了（MAX_MS）就不再往里加，cut 记下“没取全”。
class Out {
  constructor(max = MAX_TEXT, ms = MAX_MS) {
    this.parts = [];
    this.size = 0;
    this.max = max;
    this.deadline = Date.now() + ms;
    this.cut = false;
    this.ticks = 0;
  }

  get full() {
    return this.cut || this.size >= this.max;
  }

  // 循环里每处理一小段就问一次：还要不要继续。每隔一阵看一眼时间
  get more() {
    if (this.cut) return false;
    if (this.size >= this.max || ((++this.ticks & 1023) === 0 && Date.now() > this.deadline)) this.cut = true;
    return !this.cut;
  }

  add(s) {
    if (!s || this.full) return;
    const room = this.max - this.size;
    const part = s.length > room ? cutText(s, room) : s;
    if (part.length < s.length) this.cut = true;
    this.parts.push(part);
    this.size += part.length;
  }

  toString() {
    return this.parts.join('');
  }

  // 另开一小本（最多 max 个字），用的是同一个截止时间
  sub(max) {
    const o = new Out(max, 0);
    o.deadline = this.deadline;
    return o;
  }
}

// 取开头最多 n 个字，不把一个表情符号（代理对）切成两半
function cutText(s, n) {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

// 整理取出来的文字：统一换行、去掉控制字符、去掉行尾的空白、最多连续空一行。
// 正则前面的 (?<!…) 让它只从一串空白的开头试一次；不加的话，一长串空格会从每个位置各试一遍，慢得像卡死。
function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufeff]/g, '')
    .replace(/(?<![ \t])[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Word（docx） ----------

const DOCX_NS = { w: NS.w, m: NS.m };

// 用符号字体插入的符号（<w:sym w:font="Wingdings" w:char="F0FC"/>）：编号是那个字体自己的，换成通用的字
const SYMBOL_LOWER = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'; // Symbol 字体里 a～z 的位置上是这些希腊字母
const SYMBOL_UPPER = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';
const SYMBOL_MORE = { 0xa2: '′', 0xa3: '≤', 0xa5: '∞', 0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓', 0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xd6: '√', 0xd7: '⋅', 0xe5: '∑' };
const SYMBOL_PUNCT = { 0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2a: '∗', 0x2d: '−' };
const WINGDINGS = { 0x6c: '●', 0x6e: '■', 0xa7: '▪', 0xa8: '☐', 0xd8: '➢', 0xdf: '←', 0xe0: '→', 0xe1: '↑', 0xe2: '↓', 0xe8: '→', 0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑' };

function symbolChar(font, hex) {
  let code = parseInt(hex || '', 16);
  if (!Number.isFinite(code)) return '';
  if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000; // 符号字体的编号写在“私人使用区”里
  const f = String(font || '').toLowerCase();
  if (f === 'symbol') {
    if (code >= 0x61 && code <= 0x7a) return SYMBOL_LOWER[code - 0x61];
    if (code >= 0x41 && code <= 0x5a) return SYMBOL_UPPER[code - 0x41];
    // 数字和多数标点在 Symbol 字体里还是原来的样子
    if (code >= 0x20 && code <= 0x3f) return SYMBOL_PUNCT[code] || String.fromCharCode(code);
    return SYMBOL_MORE[code] || '';
  }
  if (f.startsWith('wingdings') || f.startsWith('webdings')) return code === 0x20 ? ' ' : f === 'wingdings' ? WINGDINGS[code] || '' : '';
  // 普通字体：编号就是 Unicode
  return code >= 0x20 && (code < 0xd800 || (code > 0xf8ff && code <= 0xffff)) ? String.fromCharCode(code) : '';
}

const NOTE_KIND = { 'w:footnote': 'f', 'w:endnote': 'e', 'w:comment': 'c', 'w:footnoteReference': 'f', 'w:endnoteReference': 'e', 'w:commentReference': 'c' };

// 脚注、尾注、批注在正文里留的记号：[^1]、[^e1]、[^c1]，各自按出现的先后编号
function noteMark(notes, kind, id) {
  if (notes.off) return '';
  const key = `${kind}:${id}`;
  let mark = notes.marks.get(key);
  if (!mark && notes.marks.size < MAX_LIST) {
    notes.count[kind] = (notes.count[kind] || 0) + 1;
    mark = `[^${kind === 'f' ? '' : kind}${notes.count[kind]}]`;
    notes.marks.set(key, mark);
  }
  return mark || '';
}

// 把一段 WordprocessingML 走一遍，文字写进 out。正文（document.xml）和装着脚注、尾注、批注的文件都用它。
// inNotes：这是装着脚注（尾注、批注）的文件。只要正文里提到过的那几条，每条前面写上它的记号
function docxWalk(xml, out, headings, notes, inNotes) {
  let cell = 0; // 在表格单元格里的嵌套层数
  let paraStart = true;
  // 下面这些里面的内容不要：备用内容（mc:Fallback，和正文是同一段话的两种写法）、制表位的定义（w:tabs）、
  // 修订里“从这里挪走”的那一份（w:moveFrom，新位置上还有一份）、正文没提到的脚注（分隔线也算一条“脚注”）
  let skip = '';
  let depth = 0;
  let lead = false; // 刚写完一条脚注的记号：它后面紧跟着的空格、制表符不要
  for (const t of tags(xml)) {
    if (!out.more) break;
    if (skip) {
      if (t.name === skip && !t.empty) depth += t.close ? -1 : 1;
      if (!depth) skip = '';
      continue;
    }
    switch (t.name) {
      case 'mc:Fallback':
      case 'w:tabs':
      case 'w:moveFrom':
        if (!t.close && !t.empty) {
          skip = t.name;
          depth = 1;
        }
        break;
      case 'w:footnote':
      case 'w:endnote':
      case 'w:comment': {
        if (!inNotes || t.close || t.empty) break;
        const a = attrsOf(xml, t);
        const mark = notes.marks.get(`${NOTE_KIND[t.name]}:${attrNs(a, 'id')}`);
        if (mark) {
          const author = t.name === 'w:comment' ? attrNs(a, 'author') : '';
          out.add(`${mark} ${author ? `${author}: ` : ''}`);
          lead = true;
        } else {
          skip = t.name;
          depth = 1;
        }
        break;
      }
      case 'w:footnoteReference':
      case 'w:endnoteReference':
      case 'w:commentReference':
        if (!t.close) out.add(noteMark(notes, NOTE_KIND[t.name], attrNs(attrsOf(xml, t), 'id')));
        break;
      case 'w:t':
      case 'm:t': // 公式里的字
        if (!t.close && !t.empty) {
          let text = textAfter(xml, t);
          if (lead) text = text.replace(/^\s+/, '');
          if (text) lead = false;
          out.add(text);
          paraStart = false;
        }
        break;
      case 'w:noBreakHyphen': // 不让断行的连字符：电话号码、年份范围里常见，漏掉的话 555-0199 就成了 5550199
        if (!t.close) out.add('-');
        break;
      case 'w:sym':
        if (!t.close) {
          const a = attrsOf(xml, t);
          out.add(symbolChar(attrNs(a, 'font'), attrNs(a, 'char')));
        }
        break;
      case 'w:tab':
        if (!t.close && !lead) out.add(cell ? ' ' : '\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (!t.close) out.add(cell ? ' ' : '\n');
        break;
      case 'w:pStyle': {
        const level = paraStart && !cell && !t.close ? headings.get(attrNs(attrsOf(xml, t), 'val')) : 0;
        if (level) out.add(`${'#'.repeat(Math.min(level, 6))} `);
        paraStart = false;
        break;
      }
      case 'w:p':
        if (!t.close) paraStart = true;
        if (t.close || t.empty) out.add(cell ? ' ' : '\n');
        break;
      case 'w:tc':
        if (!t.close && !t.empty) cell++;
        else if (t.close) {
          cell = Math.max(0, cell - 1);
          out.add('\t');
        }
        break;
      case 'w:tr':
        if (t.close) out.add('\n');
        break;
      default:
    }
  }
}

function docxText(zip, info = {}) {
  const xml = canonical(zip.text('word/document.xml'), DOCX_NS);
  if (xml == null) throw new Error('word/document.xml is missing');
  const out = new Out();

  // 样式 Id → 标题级别（中文版 Word 里标题样式的 Id 是 "1" "2" 这样的数字，要看样式名才知道）
  const headings = new Map();
  const styles = canonical(zip.text('word/styles.xml') || '', DOCX_NS);
  let styleId = null;
  for (const t of tags(styles)) {
    if (!out.more) break;
    if (t.name === 'w:style') styleId = t.close ? null : attrNs(attrsOf(styles, t), 'styleId');
    else if (t.name === 'w:name' && !t.close && styleId) {
      const val = attrNs(attrsOf(styles, t), 'val') || '';
      const h = /^heading (\d)$/i.exec(val);
      if (headings.size >= MAX_LIST) break;
      if (h) headings.set(styleId, Number(h[1]));
      else if (/^title$/i.test(val)) headings.set(styleId, 1);
    }
  }

  const notes = { marks: new Map(), count: {} };
  docxWalk(xml, out, headings, notes, false);
  // 页眉、页脚：同样的内容只写一遍（各节、首页、奇偶页常常是同一段话），只有页码的不要
  if (!out.full) {
    const labels = { ...LABELS, ...info.labels };
    const parts = relatedParts(zip, 'word/document.xml', ['header', 'footer'], out).sort((x, y) => (x.kind < y.kind ? 1 : x.kind > y.kind ? -1 : numericOrder(x.file, y.file)));
    const seen = new Set();
    let first = true;
    for (const part of parts) {
      if (out.full || !zip.has(part.file)) continue;
      const sub = out.sub(2000);
      docxWalk(canonical(readPart(zip, part.file, out), DOCX_NS), sub, headings, { off: true }, false);
      const text = tidy(tableTidy(sub.toString())).replace(/(?<!\s)\s*\n\s*/g, ' / ');
      if (!/[^\d\s\/|.·\-–—]/.test(text) || seen.has(part.kind + text)) continue;
      seen.add(part.kind + text);
      out.add(`${first ? '\n' : ''}${labels[part.kind]}${text}\n`);
      first = false;
    }
    if (Date.now() > out.deadline) out.cut = true;
  }
  // 脚注、尾注、批注：正文里留了记号，内容附在最后
  if (notes.marks.size) {
    out.add('\n');
    for (const file of ['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml']) {
      if (out.full || !zip.has(file)) continue;
      docxWalk(canonical(readPart(zip, file, out), DOCX_NS), out, headings, notes, true);
    }
  }
  if (out.cut) info.truncated = true;
  return tidy(tableTidy(out.toString()));
}

// 表格的一行：单元格之间用制表符隔开，去掉多余的空格和行尾的制表符
function tableTidy(text) {
  return text.replace(/(?<! ) +\t/g, '\t').replace(/(?<!\t)\t+\n/g, '\n');
}

// ---------- PowerPoint（pptx） ----------

function numericOrder(a, b) {
  const n = (s) => Number((/(\d+)\.xml$/.exec(s) || [0, 0])[1]);
  return n(a) - n(b);
}

const PPTX_NS = { a: NS.a, p: NS.p };
// 备注页上这几种占位符里的字不要：幻灯片的缩略图、页码、页眉、页脚、日期
const NOTES_SKIP = new Set(['sldImg', 'sldNum', 'hdr', 'ftr', 'dt']);

// 一页幻灯片（或者它的备注页）里的文字，写进 out。写了字返回 true。
// 页码占位符里的字不要（每页一个数字，没有意义）；notes = true 时是备注页，上面那几种都不要
function pptxWalk(xml, out, notes) {
  let cell = 0;
  let quiet = false; // 现在这个形状是一个不要的占位符
  let wrote = false;
  for (const t of tags(xml)) {
    if (!out.more) break;
    if (t.name === 'p:sp') quiet = false;
    else if (t.name === 'p:ph' && !t.close) {
      const type = attr(attrsOf(xml, t), 'type');
      quiet = notes ? NOTES_SKIP.has(type) : type === 'sldNum';
    }
    if (quiet) continue;
    switch (t.name) {
      case 'a:t':
        if (!t.close && !t.empty) {
          const text = textAfter(xml, t);
          if (/\S/.test(text)) wrote = true;
          out.add(text);
        }
        break;
      case 'a:tab':
        if (!t.close) out.add(cell ? ' ' : '\t');
        break;
      case 'a:br':
        if (!t.close) out.add(cell ? ' ' : '\n');
        break;
      case 'a:p':
        if (t.close || t.empty) out.add(cell ? ' ' : '\n');
        break;
      case 'a:tc':
        if (!t.close && !t.empty) cell++;
        else if (t.close) {
          cell = Math.max(0, cell - 1);
          out.add('\t');
        }
        break;
      case 'a:tr':
        if (t.close) out.add('\n');
        break;
      default:
    }
  }
  return wrote;
}

function pptxText(zip, info = {}) {
  const labels = { ...LABELS, ...info.labels };
  // 幻灯片的顺序写在 presentation.xml 里，文件名里的数字不一定是顺序
  let slides = [];
  const out = new Out();
  const pres = canonical(zip.text('ppt/presentation.xml'), PPTX_NS);
  if (pres) {
    const rels = readRels(zip, 'ppt/_rels/presentation.xml.rels', 'ppt', out);
    for (const t of tags(pres)) {
      if (!out.more) break;
      if (t.name !== 'p:sldId' || t.close) continue;
      const file = rels.get(attrNs(attrsOf(pres, t), 'id'));
      if (file && zip.has(file)) slides.push(file);
      if (slides.length >= MAX_PARTS) break;
    }
  }
  if (!slides.length) slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(numericOrder);
  if (!slides.length) throw new Error('no slides found');

  let any = false; // 读到过字（每一页都只有图片的话，光剩下页码的小标题，等于什么都没读到）
  for (let i = 0; i < slides.length && !out.full; i++) {
    const xml = canonical(readPart(zip, slides[i], out), PPTX_NS);
    // 放映时跳过的幻灯片（<p:sld show="0">）：照样读，标出来
    const root = findOpen(xml, 'p:sld', 0);
    const hidden = root >= 0 && attr(xml.slice(root, Math.max(root, xml.indexOf('>', root))), 'show') === '0';
    out.add(`${i ? '\n\n' : ''}--- ${i + 1}${hidden ? labels.hidden : ''} ---\n`);
    if (pptxWalk(xml, out, false)) any = true;
    // 演讲者备注：讲的人真正要说的话常常写在这里
    const related = out.full ? [] : relatedParts(zip, slides[i], ['notesSlide'], out, 1);
    const notesFile = related.length ? related[0].file : null;
    if (notesFile && zip.has(notesFile)) {
      const mark = { parts: out.parts.length, size: out.size };
      out.add(`\n${labels.notes}\n`);
      const wrote = pptxWalk(canonical(readPart(zip, notesFile, out), PPTX_NS), out, true);
      if (wrote) any = true;
      if (!wrote && !out.cut) {
        // 备注是空的（多数幻灯片都是）：刚才写的小标题也拿掉
        out.parts.length = mark.parts;
        out.size = mark.size;
      }
    }
  }
  if (out.cut) info.truncated = true;
  return any ? tidy(tableTidy(out.toString())) : '';
}

// ---------- Excel（xlsx） ----------

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Excel 把日期存成“从 1899-12-30 起的天数”，要看单元格格式才知道它是日期
function excelDate(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  // Excel 以为 1900 年是闰年（有 2 月 29 日，第 60 天），所以这一天之前的日期要往后挪一天才对
  const early = !date1904 && serial >= 1 && serial < 60;
  const ms = Math.round((serial + (early ? 1 : 0) - (date1904 ? -1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const date = !date1904 && serial >= 60 && serial < 61 ? '1900-02-29' : `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad2(d.getUTCSeconds())}` : ''}`;
  if (serial < 1) return time;
  return Number.isInteger(serial) ? date : `${date} ${time}`;
}

// 数字格式是哪一种：{ kind: 'date' } 日期或时间，{ kind: 'elapsed', … } 累计的时长（[h]:mm），{ kind: 'percent' } 百分比；
// 其余的返回 null，数字照原样写。只看格式的第一段（正数用的那一段），顺着扫一遍：
// 引号里的文字、\x（照写一个字符）、_x（留一个字符宽的空）、*x（用这个字符填满）、[红色] 这类方括号都不是格式本身。
// 不跳过 _x 的话，德文的会计格式 “_-* #,##0.00\ _D_M_-” 里的 D、M 会被当成“日”“月”，金额就成了日期
function formatKind(code) {
  const c = String(code).slice(0, 1000);
  let plain = '';
  let unit = ''; // [h]、[m]、[s]：累计的小时、分钟、秒
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === '"') {
      const end = c.indexOf('"', i + 1);
      i = end < 0 ? c.length : end;
    } else if (ch === '\\' || ch === '_' || ch === '*') i++;
    else if (ch === '[') {
      const end = c.indexOf(']', i + 1);
      const inner = end < 0 ? '' : c.slice(i + 1, end).toLowerCase();
      if (!unit && inner && (inner === 'h'.repeat(inner.length) || inner === 'm'.repeat(inner.length) || inner === 's'.repeat(inner.length))) unit = inner[0];
      i = end < 0 ? c.length : end;
    } else if (ch === ';') break;
    else plain += ch.toLowerCase();
  }
  if (unit) return { kind: 'elapsed', unit, minutes: plain.includes('m'), seconds: plain.includes('s') };
  if (/[ymdhs]/.test(plain)) return { kind: 'date' };
  return plain.includes('%') ? { kind: 'percent' } : null;
}

const FORMAT_DATE = { kind: 'date' };
const FORMAT_PERCENT = { kind: 'percent' };

// Excel 自带的格式（文件里只写编号，不写格式）
function builtinFormat(n) {
  if (n === 9 || n === 10) return FORMAT_PERCENT;
  if (n === 46) return { kind: 'elapsed', unit: 'h', minutes: true, seconds: true }; // [h]:mm:ss
  return (n >= 14 && n <= 22) || (n >= 27 && n <= 36) || n === 45 || n === 47 || (n >= 50 && n <= 58) ? FORMAT_DATE : null;
}

// 累计的时长：1.5625 天按 [h]:mm 是 37:30。没写出来的小单位直接舍掉，和 Excel 显示的一样
function elapsedText(days, f) {
  const total = Math.round(Math.abs(days) * 86400);
  const sign = days < 0 && total ? '-' : '';
  if (f.unit === 's') return `${sign}${total}`;
  const minutes = Math.floor(total / 60);
  const seconds = f.seconds ? `:${pad2(total % 60)}` : '';
  if (f.unit === 'm') return `${sign}${minutes}${seconds}`;
  return `${sign}${Math.floor(minutes / 60)}${f.minutes || f.seconds ? `:${pad2(minutes % 60)}` : ''}${seconds}`;
}

// 小数在文件里常常带着一点点误差（0.3 存成 0.30000000000000004，7% 存成 7.0000000000000007E-2）：去掉
const tidyNumber = (n) => String(Number(n.toPrecision(12)));

// 文字里的 _x000D_ 这种写法是一个控制字符（这里是回车）；_x005F_ 是下划线本身
function plainText(s) {
  return s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))) : s;
}

// 一段带格式的文字（<si> 或 <is> 里面）：把各个 <t> 连起来，注音（rPh）不要
function richText(body) {
  let text = '';
  for (const t of elements(without(body, 'rPh'), 't')) text += decodeXml(t.body);
  return plainText(text);
}

const SHEET_NS = { '': NS.sheet };

function xlsxText(zip, info = {}) {
  const labels = { ...LABELS, ...info.labels };
  const wb = canonical(zip.text('xl/workbook.xml'), SHEET_NS);
  if (wb == null) throw new Error('xl/workbook.xml is missing');
  const out = new Out();
  const rels = readRels(zip, 'xl/_rels/workbook.xml.rels', 'xl', out);

  let date1904 = false;
  let sheets = [];
  for (const t of tags(wb)) {
    if (!out.more) break;
    if (t.close) continue;
    if (t.name === 'workbookPr') date1904 = /^(1|true)$/.test(attr(attrsOf(wb, t), 'date1904') || '');
    else if (t.name === 'sheet') {
      const a = attrsOf(wb, t);
      const file = rels.get(attrNs(a, 'id'));
      // 隐藏的工作表（state 是 hidden 或 veryHidden）：照样读，标出来
      if (file && zip.has(file)) sheets.push({ name: attr(a, 'name') || '', file, hidden: /hidden/i.test(attr(a, 'state') || '') });
      if (sheets.length >= MAX_PARTS) break;
    }
  }
  if (!sheets.length) {
    sheets = zip.names
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort(numericOrder)
      .map((file, i) => ({ name: `Sheet${i + 1}`, file, hidden: false }));
  }
  if (!sheets.length) throw new Error('no worksheets found');

  const shared = [];
  const sst = canonical(zip.text('xl/sharedStrings.xml') || '', SHEET_NS);
  let sharedCut = false; // 共享字符串多得不正常，后面的没有读
  for (const si of elements(sst, 'si')) {
    if (!out.more) break;
    if (shared.length >= MAX_SHARED) {
      sharedCut = true;
      break;
    }
    shared.push(cutText(richText(si.body), MAX_TEXT)); // 再长也用不上：整份文档最多留这么多字
  }

  // 每个单元格样式用的是哪一种数字格式（日期、时长、百分比；其余的是 null）
  const styles = [];
  const st = canonical(zip.text('xl/styles.xml') || '', SHEET_NS);
  const custom = new Map(); // 文件里自己定义的格式：编号 → 哪一种
  let inCellXfs = false;
  for (const t of tags(st)) {
    if (!out.more) break;
    if (t.name === 'cellXfs') inCellXfs = !t.close && !t.empty;
    else if (t.close || custom.size >= MAX_LIST || styles.length >= MAX_LIST) continue;
    else if (t.name === 'numFmt') {
      const a = attrsOf(st, t);
      custom.set(attr(a, 'numFmtId'), formatKind(attr(a, 'formatCode') || ''));
    } else if (t.name === 'xf' && inCellXfs) {
      const id = attr(attrsOf(st, t), 'numFmtId') || '0';
      styles.push(custom.has(id) ? custom.get(id) : builtinFormat(Number(id)));
    }
  }

  let any = false; // 读到过单元格（一个都没有的话，光剩下工作表的名字，等于什么都没读到）
  let wide = false; // 有的行特别宽，第 2000 列以后的没有要（后面的行、后面的工作表照常读）
  for (let i = 0; i < sheets.length && !out.full; i++) {
    const xml = canonical(readPart(zip, sheets[i].file, out), SHEET_NS);
    out.add(`${i ? '\n\n' : ''}--- ${sheets[i].name}${sheets[i].hidden ? labels.hidden : ''} ---\n`);
    for (const row of elements(xml, 'row')) {
      if (!out.more) break;
      const cells = [];
      let next = 0;
      // 这一行已经攒了多少字。同一段很长的文字可以被很多个单元格引用，每个单元格都要复制一份，
      // 所以一行里加起来够了（超过整份文档还能放的字数）就不再往下读，不然几千个单元格能占掉上千兆内存
      let rowSize = 0;
      let short = false; // 这一行没有读全
      for (const c of elements(row.body, 'c')) {
        if (!out.more) break;
        const left = out.max - out.size - rowSize;
        if (left <= 0) {
          short = true;
          break;
        }
        const ref = attr(c.attrs, 'r');
        const idx = ref ? colIndex(ref) : next;
        next = idx + 1;
        const type = attr(c.attrs, 't');
        const v = firstBody(c.body, 'v');
        let val = v ? decodeXml(v) : '';
        if (type === 's') val = shared[Number(val)] || '';
        else if (type === 'inlineStr') val = richText(c.body);
        else if (type === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str') val = plainText(val);
        else if (val && (!type || type === 'n')) {
          const format = styles[Number(attr(c.attrs, 's') || 0)];
          const n = Number(val);
          if (format && Number.isFinite(n)) {
            if (format.kind === 'date') val = excelDate(n, date1904) || val;
            else if (format.kind === 'elapsed') val = elapsedText(n, format);
            else val = `${tidyNumber(n * 100)}%`; // 0.18 在表格里显示的是 18%
          } else if (Number.isFinite(n) && (val.includes('E') || val.includes('e') || /\.\d{10}/.test(val))) val = tidyNumber(n);
        }
        if (!val && (!type || type === 'n' || type === 'str')) {
          // 没有算好的结果（少数工具生成的文件会这样），就把公式本身写出来
          const f = firstBody(c.body, 'f');
          if (f) val = `=${decodeXml(f)}`;
        }
        if (val === '' || idx < 0) continue;
        if (idx >= 2000) {
          wide = true;
          continue;
        }
        if (val.length > left) {
          val = cutText(val, left);
          short = true;
        }
        cells[idx] = val.replace(/(?<!\s)\s*[\n\r]\s*/g, ' ').replace(/\t/g, ' ');
        rowSize += cells[idx].length + 1;
      }
      if (cells.length) {
        out.add(`${Array.from(cells, (x) => x || '').join('\t')}\n`);
        any = true;
      }
      if (short) out.cut = true;
    }
  }
  if (out.cut || sharedCut || wide) info.truncated = true;
  return any ? tidy(out.toString()) : '';
}

// ---------- 纯文本 ----------

const isAsciiLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

// 没有 BOM、又不是 UTF-8 的文字，是中文 Windows 的 GB18030，还是西欧 Windows 的 Windows-1252？
// 拿不准的时候算中文（用这个程序的人多数在中文 Windows 上）。两种情况算西文：
// 1. 数一数：中文里绝大多数字是“两个高位字节”；西文里带重音的字母后面几乎都是普通字母。
// 2. 一个常用汉字的样子都没有，而且每个高位字节都是带重音的字母、长在英文单词里（Grüße、ação 这样连着两个的）。
function looksWestern(buf) {
  const n = Math.min(buf.length, 65536);
  let pairs = 0;
  let mixed = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] < 0x80) continue;
    const next = i + 1 < buf.length ? buf[i + 1] : 0;
    if (next >= 0xa1) pairs++;
    else if (next >= 0x30 && next <= 0x39) {
      // GB18030 的四字节字
      pairs++;
      i += 2;
    } else mixed++;
    i++;
  }
  if (mixed > pairs * 4) return true;

  let words = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] < 0x80) continue;
    let j = i;
    for (; j < n && buf[j] >= 0x80; j++) {
      const c = buf[j];
      if (c < 0xc0 || c === 0xd7 || c === 0xf7) return false; // 不是带重音的字母
      // 常用汉字：第一个字节在 0xB0～0xD7（对应西文里大写的带重音字母），第二个字节在 0xA1 以上
      if (c <= 0xd7 && j + 1 < n && buf[j + 1] >= 0xa1) return false;
    }
    if (!isAsciiLetter(buf[i - 1]) && !isAsciiLetter(buf[j])) return false; // 前后都不是英文字母
    words++;
    i = j;
  }
  return words > 0;
}

function tryDecode(buf, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

// 终端输出里的颜色、光标控制码（ESC [ … m 之类）和窗口标题：日志文件里常见，不是文字内容
const ANSI = /\u001b(?:\[[0-9:;<=>?]*[ -\/]*[@-~]|\][^\u0007\u001b\n]{0,256}(?:\u0007|\u001b\\)|[@-Z\\^_])/g;

// 控制字符（或者解不出来的字）多不多：多的是二进制文件
function looksBinary(s) {
  const odd = (s.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) || []).length;
  return odd > Math.max(2, s.length * 0.01);
}

// 开头、中间、结尾各取一段来看（短的整个看）。只看开头的话，“开头是文字、后面是二进制内容”的文件会混过去
function samples(text) {
  const n = text.length;
  if (n <= 60000) return [text];
  const mid = n >> 1;
  return [text.slice(0, 20000), text.slice(mid - 10000, mid + 10000), text.slice(n - 20000)];
}

// 自动识别编码：UTF-8 / UTF-16（看 BOM）/ GB18030（中文 Windows 上很多 txt、csv 还是这个编码）/ Windows-1252（西欧）。
// 认不出来（多半是二进制文件）时返回 null。其他编码（Big5、日文、韩文、俄文等）认不出来，会被当成上面某一种。
// info.truncated：文字太长，只留了开头
function decodeText(buf, info = {}) {
  let text = null;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buf.subarray(2));
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be').decode(buf.subarray(2));
  else {
    text = tryDecode(buf, 'utf-8');
    if (text == null && !looksWestern(buf)) text = tryDecode(buf, 'gb18030');
    if (text == null) {
      // Windows-1252 里什么字节都“解得出来”，所以多看一眼：里面不该有它没定义的那几个字节
      text = new TextDecoder('windows-1252').decode(buf);
      if (samples(text).some((s) => /[\u0081\u008d\u008f\u0090\u009d]/.test(s))) return null;
    }
  }
  if (text.includes('\u001b')) text = text.replace(ANSI, '');
  if (samples(text).some(looksBinary)) return null;
  if (text.length > MAX_TEXT) info.truncated = true;
  return tidy(cutText(text, MAX_TEXT));
}

// zip 里装的是哪种 Office 文档
function officeKind(zip) {
  if (zip.has('word/document.xml')) return 'docx';
  if (zip.has('xl/workbook.xml')) return 'xlsx';
  if (zip.has('ppt/presentation.xml')) return 'pptx';
  return null;
}

// info.truncated：文字没有取全（太长、文件有问题或者处理超时）
function officeText(zip, kind, info = {}) {
  if (kind === 'docx') return docxText(zip, info);
  if (kind === 'xlsx') return xlsxText(zip, info);
  if (kind === 'pptx') return pptxText(zip, info);
  throw new Error('not an Office document');
}

module.exports = { openZip, officeKind, officeText, docxText, xlsxText, pptxText, decodeText, decodeXml, tidy, MAX_TEXT, MAX_MS };
