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

function attr(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXml(m[1] != null ? m[1] : m[2]) : null;
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

// 关系文件（_rels/*.rels）：关系 Id → 指向的文件（按所在目录解析成 zip 里的完整路径）
function readRels(zip, relsPath, baseDir) {
  const xml = zip.text(relsPath);
  const map = new Map();
  if (!xml) return map;
  for (const t of tags(xml)) {
    if (t.name !== 'Relationship' || t.close) continue;
    const a = attrsOf(xml, t);
    const id = attr(a, 'Id');
    const target = attr(a, 'Target');
    if (!id || !target || attr(a, 'TargetMode') === 'External') continue;
    map.set(id, resolvePath(baseDir, target));
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

function docxText(zip, info = {}) {
  const xml = zip.text('word/document.xml');
  if (xml == null) throw new Error('word/document.xml is missing');
  const out = new Out();

  // 样式 Id → 标题级别（中文版 Word 里标题样式的 Id 是 "1" "2" 这样的数字，要看样式名才知道）
  const headings = new Map();
  const styles = zip.text('word/styles.xml') || '';
  let styleId = null;
  for (const t of tags(styles)) {
    if (!out.more) break;
    if (t.name === 'w:style') styleId = t.close ? null : attr(attrsOf(styles, t), 'w:styleId');
    else if (t.name === 'w:name' && !t.close && styleId) {
      const val = attr(attrsOf(styles, t), 'w:val') || '';
      const h = /^heading (\d)$/i.exec(val);
      if (h) headings.set(styleId, Number(h[1]));
      else if (/^title$/i.test(val)) headings.set(styleId, 1);
    }
  }

  let cell = 0; // 在表格单元格里的嵌套层数
  let paraStart = true;
  // 备用内容（mc:Fallback）和正文是同一段话的两种写法，只留一份；制表位的定义（w:tabs）不是正文
  let skip = '';
  let depth = 0;
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
        if (!t.close && !t.empty) {
          skip = t.name;
          depth = 1;
        }
        break;
      case 'w:t':
        if (!t.close && !t.empty) {
          out.add(textAfter(xml, t));
          paraStart = false;
        }
        break;
      case 'w:tab':
        if (!t.close) out.add(cell ? ' ' : '\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (!t.close) out.add(cell ? ' ' : '\n');
        break;
      case 'w:pStyle': {
        const level = paraStart && !cell && !t.close ? headings.get(attr(attrsOf(xml, t), 'w:val')) : 0;
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

function pptxText(zip, info = {}) {
  // 幻灯片的顺序写在 presentation.xml 里，文件名里的数字不一定是顺序
  let slides = [];
  const pres = zip.text('ppt/presentation.xml');
  if (pres) {
    const rels = readRels(zip, 'ppt/_rels/presentation.xml.rels', 'ppt');
    for (const t of tags(pres)) {
      if (t.name !== 'p:sldId' || t.close) continue;
      const file = rels.get(attr(attrsOf(pres, t), 'r:id'));
      if (file && zip.has(file)) slides.push(file);
    }
  }
  if (!slides.length) slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(numericOrder);
  if (!slides.length) throw new Error('no slides found');

  const out = new Out();
  for (let i = 0; i < slides.length && !out.full; i++) {
    const xml = readPart(zip, slides[i], out);
    out.add(`${i ? '\n\n' : ''}--- ${i + 1} ---\n`);
    let cell = 0;
    for (const t of tags(xml)) {
      if (!out.more) break;
      switch (t.name) {
        case 'a:t':
          if (!t.close && !t.empty) out.add(textAfter(xml, t));
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
  }
  if (out.cut) info.truncated = true;
  return tidy(tableTidy(out.toString()));
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
  const ms = Math.round((serial - (date1904 ? -1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad2(d.getUTCSeconds())}` : ''}`;
  if (serial < 1) return time;
  return Number.isInteger(serial) ? date : `${date} ${time}`;
}

function isDateFormat(code) {
  const c = String(code)
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[ymdhs]/i.test(c) && !/^general$/i.test(c.trim());
}

// 一段带格式的文字（<si> 或 <is> 里面）：把各个 <t> 连起来，注音（rPh）不要
function richText(body) {
  let text = '';
  for (const t of elements(without(body, 'rPh'), 't')) text += decodeXml(t.body);
  return text;
}

function xlsxText(zip, info = {}) {
  const wb = zip.text('xl/workbook.xml');
  if (wb == null) throw new Error('xl/workbook.xml is missing');
  const rels = readRels(zip, 'xl/_rels/workbook.xml.rels', 'xl');
  const out = new Out();

  let date1904 = false;
  let sheets = [];
  for (const t of tags(wb)) {
    if (t.close) continue;
    if (t.name === 'workbookPr') date1904 = /^(1|true)$/.test(attr(attrsOf(wb, t), 'date1904') || '');
    else if (t.name === 'sheet') {
      const a = attrsOf(wb, t);
      const file = rels.get(attr(a, 'r:id'));
      if (file && zip.has(file)) sheets.push({ name: attr(a, 'name') || '', file });
    }
  }
  if (!sheets.length) {
    sheets = zip.names
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort(numericOrder)
      .map((file, i) => ({ name: `Sheet${i + 1}`, file }));
  }
  if (!sheets.length) throw new Error('no worksheets found');

  const shared = [];
  const sst = zip.text('xl/sharedStrings.xml') || '';
  for (const si of elements(sst, 'si')) {
    if (!out.more) break;
    shared.push(richText(si.body));
  }

  // 哪些单元格样式是日期
  const dateStyles = [];
  const st = zip.text('xl/styles.xml') || '';
  const custom = new Map();
  let inCellXfs = false;
  for (const t of tags(st)) {
    if (!out.more) break;
    if (t.name === 'cellXfs') inCellXfs = !t.close && !t.empty;
    else if (t.close) continue;
    else if (t.name === 'numFmt') {
      const a = attrsOf(st, t);
      custom.set(attr(a, 'numFmtId'), attr(a, 'formatCode') || '');
    } else if (t.name === 'xf' && inCellXfs) {
      const id = attr(attrsOf(st, t), 'numFmtId') || '0';
      const n = Number(id);
      dateStyles.push(custom.has(id) ? isDateFormat(custom.get(id)) : (n >= 14 && n <= 22) || (n >= 27 && n <= 36) || (n >= 45 && n <= 47) || (n >= 50 && n <= 58));
    }
  }

  for (let i = 0; i < sheets.length && !out.full; i++) {
    const xml = readPart(zip, sheets[i].file, out);
    out.add(`${i ? '\n\n' : ''}--- ${sheets[i].name} ---\n`);
    for (const row of elements(xml, 'row')) {
      if (!out.more) break;
      const cells = [];
      let next = 0;
      for (const c of elements(row.body, 'c')) {
        if (!out.more) break;
        const ref = attr(c.attrs, 'r');
        const idx = ref ? colIndex(ref) : next;
        next = idx + 1;
        const type = attr(c.attrs, 't');
        const v = firstBody(c.body, 'v');
        let val = v ? decodeXml(v) : '';
        if (type === 's') val = shared[Number(val)] || '';
        else if (type === 'inlineStr') val = richText(c.body);
        else if (type === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
        else if (val && (!type || type === 'n')) {
          if (dateStyles[Number(attr(c.attrs, 's') || 0)]) val = excelDate(Number(val), date1904) || val;
          else if (/^-?\d+\.\d{10,}$/.test(val)) val = String(Number(Number(val).toPrecision(12)));
        } else if (!val && (!type || type === 'n' || type === 'str')) {
          // 没有算好的结果（少数工具生成的文件会这样），就把公式本身写出来
          const f = firstBody(c.body, 'f');
          if (f) val = `=${decodeXml(f)}`;
        }
        if (val !== '' && idx >= 0 && idx < 2000) cells[idx] = val.replace(/(?<!\s)\s*\n\s*/g, ' ').replace(/\t/g, ' ');
      }
      if (cells.length) out.add(`${Array.from(cells, (x) => x || '').join('\t')}\n`);
    }
  }
  if (out.cut) info.truncated = true;
  return tidy(out.toString());
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
