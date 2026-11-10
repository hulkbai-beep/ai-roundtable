'use strict';

// 从文档里取出文字：纯文本（自动识别编码）、Word / Excel / PowerPoint（docx / xlsx / pptx）。
// docx / xlsx / pptx 都是 zip 包着的 XML，这里自己解包、自己解析，不依赖第三方库。
// PDF 见 lib/pdf-text.js。

const zlib = require('zlib');

const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // 单个 XML 解压后的上限，防止压缩炸弹
const MAX_TEXT = 400000; // 一份文档最多保留多少字

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
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    // 读出一个文件的内容；没有这个文件时返回 null
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size === 0xffffffff || e.local === 0xffffffff) throw new Error('zip64 is not supported');
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('broken zip entry');
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.size);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`unsupported zip compression method ${e.method}`);
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
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
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

// 关系文件（_rels/*.rels）：关系 Id → 指向的文件（按所在目录解析成 zip 里的完整路径）
function readRels(zip, relsPath, baseDir) {
  const xml = zip.text(relsPath);
  const map = new Map();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (!id || !target || attr(m[0], 'TargetMode') === 'External') continue;
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

// 把写满了的输出截住，避免一份超大的文档占满内存
class Out {
  constructor(max = MAX_TEXT) {
    this.parts = [];
    this.size = 0;
    this.max = max;
  }

  get full() {
    return this.size >= this.max;
  }

  add(s) {
    if (!s || this.full) return;
    this.parts.push(s);
    this.size += s.length;
  }

  toString() {
    return this.parts.join('');
  }
}

function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Word（docx） ----------

function docxText(zip) {
  const xml = zip.text('word/document.xml');
  if (xml == null) throw new Error('word/document.xml is missing');

  // 样式 Id → 标题级别（中文版 Word 里标题样式的 Id 是 "1" "2" 这样的数字，要看样式名才知道）
  const headings = new Map();
  const styles = zip.text('word/styles.xml') || '';
  for (const m of styles.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[1], 'w:styleId');
    const name = /<w:name\b[^>]*>/.exec(m[2]);
    const val = name ? attr(name[0], 'w:val') || '' : '';
    const h = /^heading (\d)$/i.exec(val);
    if (id && h) headings.set(id, Number(h[1]));
    else if (id && /^title$/i.test(val)) headings.set(id, 1);
  }

  const out = new Out();
  let cell = 0; // 在表格单元格里的嵌套层数
  let paraStart = true;
  // 备用内容（mc:Fallback）和正文是同一段话的两种写法，只留一份；制表位的定义（w:tabs）不是正文
  const body = xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '').replace(/<w:tabs>[\s\S]*?<\/w:tabs>/g, '');
  const re = /<w:t(?:\s[^>]*)?>(?<text>[\s\S]*?)<\/w:t>|<w:pStyle\b(?<style>[^>]*)>|<w:(?<mark>tab|br|cr)\b[^>]*\/>|<(?<close>\/?)w:(?<tag>p|tc|tr)(?<attrs>\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(body)) && !out.full) {
    const g = m.groups;
    if (g.text != null) {
      out.add(decodeXml(g.text));
      paraStart = false;
    } else if (g.mark) {
      out.add(g.mark === 'tab' ? (cell ? ' ' : '\t') : cell ? ' ' : '\n');
    } else if (g.style != null) {
      const level = paraStart && !cell ? headings.get(attr(g.style, 'w:val')) : 0;
      if (level) out.add(`${'#'.repeat(Math.min(level, 6))} `);
      paraStart = false;
    } else {
      const empty = Boolean(g.attrs && g.attrs.endsWith('/'));
      const open = !g.close;
      if (g.tag === 'p') {
        if (open) paraStart = true;
        if (!open || empty) out.add(cell ? ' ' : '\n');
      } else if (g.tag === 'tc') {
        if (open && !empty) cell++;
        else if (!open) {
          cell = Math.max(0, cell - 1);
          out.add('\t');
        }
      } else if (!open) out.add('\n');
    }
  }
  return tidy(tableTidy(out.toString()));
}

// 表格的一行：单元格之间用制表符隔开，去掉多余的空格和行尾的制表符
function tableTidy(text) {
  return text.replace(/ +\t/g, '\t').replace(/\t+\n/g, '\n');
}

// ---------- PowerPoint（pptx） ----------

function numericOrder(a, b) {
  const n = (s) => Number((/(\d+)\.xml$/.exec(s) || [0, 0])[1]);
  return n(a) - n(b);
}

function pptxText(zip) {
  // 幻灯片的顺序写在 presentation.xml 里，文件名里的数字不一定是顺序
  let slides = [];
  const pres = zip.text('ppt/presentation.xml');
  if (pres) {
    const rels = readRels(zip, 'ppt/_rels/presentation.xml.rels', 'ppt');
    for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
      const file = rels.get(attr(m[0], 'r:id'));
      if (file && zip.has(file)) slides.push(file);
    }
  }
  if (!slides.length) slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(numericOrder);
  if (!slides.length) throw new Error('no slides found');

  const out = new Out();
  slides.forEach((file, i) => {
    if (out.full) return;
    const xml = zip.text(file) || '';
    out.add(`${i ? '\n\n' : ''}--- ${i + 1} ---\n`);
    const re = /<a:t(?:\s[^>]*)?>(?<text>[\s\S]*?)<\/a:t>|<a:(?<mark>br|tab)\b[^>]*\/>|<(?<close>\/?)a:(?<tag>p|tc|tr)(?<attrs>\s[^>]*)?>/g;
    let m;
    let cell = 0;
    while ((m = re.exec(xml)) && !out.full) {
      const g = m.groups;
      if (g.text != null) out.add(decodeXml(g.text));
      else if (g.mark) out.add(g.mark === 'tab' ? (cell ? ' ' : '\t') : cell ? ' ' : '\n');
      else {
        const empty = Boolean(g.attrs && g.attrs.endsWith('/'));
        const open = !g.close;
        if (g.tag === 'p') {
          if (!open || empty) out.add(cell ? ' ' : '\n');
        } else if (g.tag === 'tc') {
          if (open && !empty) cell++;
          else if (!open) {
            cell = Math.max(0, cell - 1);
            out.add('\t');
          }
        } else if (!open) out.add('\n');
      }
    }
  });
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

function xlsxText(zip) {
  const wb = zip.text('xl/workbook.xml');
  if (wb == null) throw new Error('xl/workbook.xml is missing');
  const rels = readRels(zip, 'xl/_rels/workbook.xml.rels', 'xl');
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*"(1|true)"/.test(wb);

  let sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const file = rels.get(attr(m[0], 'r:id'));
    if (file && zip.has(file)) sheets.push({ name: attr(m[0], 'name') || '', file });
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
  for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    const body = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    shared.push([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(''));
  }

  // 哪些单元格样式是日期
  const dateStyles = [];
  const st = zip.text('xl/styles.xml') || '';
  const custom = new Map();
  for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) custom.set(attr(m[0], 'numFmtId'), attr(m[0], 'formatCode') || '');
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st);
  if (xfs) {
    for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) {
      const id = attr(m[0], 'numFmtId') || '0';
      const n = Number(id);
      dateStyles.push(custom.has(id) ? isDateFormat(custom.get(id)) : (n >= 14 && n <= 22) || (n >= 27 && n <= 36) || (n >= 45 && n <= 47) || (n >= 50 && n <= 58));
    }
  }

  const out = new Out();
  sheets.forEach((sheet, i) => {
    if (out.full) return;
    const xml = zip.text(sheet.file) || '';
    out.add(`${i ? '\n\n' : ''}--- ${sheet.name} ---\n`);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (out.full) break;
      const cells = [];
      let next = 0;
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], 'r');
        const idx = ref ? colIndex(ref) : next;
        next = idx + 1;
        const type = attr(c[1], 't');
        const body = c[2] || '';
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        let val = v ? decodeXml(v[1]) : '';
        if (type === 's') val = shared[Number(val)] || '';
        else if (type === 'inlineStr') val = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
        else if (type === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
        else if (val && (!type || type === 'n')) {
          if (dateStyles[Number(attr(c[1], 's') || 0)]) val = excelDate(Number(val), date1904) || val;
          else if (/^-?\d+\.\d{10,}$/.test(val)) val = String(Number(Number(val).toPrecision(12)));
        } else if (!val && (!type || type === 'n' || type === 'str')) {
          // 没有算好的结果（少数工具生成的文件会这样），就把公式本身写出来
          const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body);
          if (f && f[1]) val = `=${decodeXml(f[1])}`;
        }
        if (val !== '' && idx >= 0 && idx < 2000) cells[idx] = val.replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ');
      }
      if (cells.length) out.add(`${Array.from(cells, (x) => x || '').join('\t')}\n`);
    }
  });
  return tidy(out.toString());
}

// ---------- 纯文本 ----------

// 自动识别编码：UTF-8 / UTF-16（看 BOM）/ GB18030（中文 Windows 上很多 txt、csv 还是这个编码）。
// 认不出来（多半是二进制文件）时返回 null。
function decodeText(buf) {
  let text = null;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buf.subarray(2));
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be').decode(buf.subarray(2));
  else {
    for (const enc of ['utf-8', 'gb18030']) {
      try {
        text = new TextDecoder(enc, { fatal: true }).decode(buf);
        break;
      } catch {
        /* \u6362\u4e0b\u4e00\u79cd\u7f16\u7801 */
      }
    }
  }
  if (text == null) return null;
  const sample = text.slice(0, 20000);
  const odd = (sample.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) || []).length;
  if (odd > Math.max(2, sample.length * 0.01)) return null;
  return tidy(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);
}

// zip 里装的是哪种 Office 文档
function officeKind(zip) {
  if (zip.has('word/document.xml')) return 'docx';
  if (zip.has('xl/workbook.xml')) return 'xlsx';
  if (zip.has('ppt/presentation.xml')) return 'pptx';
  return null;
}

function officeText(zip, kind) {
  if (kind === 'docx') return docxText(zip);
  if (kind === 'xlsx') return xlsxText(zip);
  if (kind === 'pptx') return pptxText(zip);
  throw new Error('not an Office document');
}

module.exports = { openZip, officeKind, officeText, docxText, xlsxText, pptxText, decodeText, decodeXml, tidy, MAX_TEXT };
