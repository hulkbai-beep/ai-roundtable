'use strict';

// 测试用：现做各种文件（zip、Office 文档、PDF、图片），读取 test/fixtures 里用真实软件生成的样本

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

// 4×4 的小图片，四种格式各一张（用 Pillow 生成）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=', 'base64');
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDCooorzj7E/9k=',
  'base64'
);
const GIF = Buffer.from('R0lGODdhBAAEAIEAAMgeHgAAAAAAAAAAACwAAAAABAAEAAAICQABCBxIsCCAgAA7', 'base64');
const WEBP = Buffer.from('UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoEAAQAAsBMJaACdLoAA5gA/u2QP4hd7G2//PTP62/j/xkAAAA=', 'base64');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 生成一个 zip：files = { 'word/document.xml': '<xml…>' }。
// store：不压缩；comment：zip 末尾的注释；method：硬写一个压缩方式编号（用来模拟不支持的格式）
function makeZip(files, { store = false, comment = '', method } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  const names = Object.keys(files);
  for (const name of names) {
    const content = files[name];
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const body = store ? data : zlib.deflateRawSync(data);
    const how = method != null ? method : store ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(how, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(how, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(central);
  const note = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...locals, dir, end, note]);
}

// ---------- Office 文档：只放取文字需要的那几个文件 ----------

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

// body：<w:body> 里面的内容；styles：<w:styles> 里面的内容；
// parts：{ footnotes, endnotes, comments }，各自是 <w:footnotes>、<w:endnotes>、<w:comments> 里面的内容；
// files：另外放进压缩包的文件（页眉、页脚和指向它们的关系文件），原样写进去
function makeDocx(body, { styles = '', parts = {}, files: more = {} } = {}) {
  const files = { 'word/document.xml': `${XML_HEAD}<w:document ${W_NS}><w:body>${body}</w:body></w:document>`, ...more };
  if (styles) files['word/styles.xml'] = `${XML_HEAD}<w:styles ${W_NS}>${styles}</w:styles>`;
  for (const [name, inner] of Object.entries(parts)) files[`word/${name}.xml`] = `${XML_HEAD}<w:${name} ${W_NS}>${inner}</w:${name}>`;
  return makeZip(files);
}

const REL_TYPES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
// targets：[[Id, 指向的文件, 类型（可以不写）]]
const rels = (targets) =>
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets
    .map(([id, target, type]) => `<Relationship Id="${id}" Type="${type ? REL_TYPES + type : 't'}" Target="${target}"/>`)
    .join('')}</Relationships>`;

// sheets：[{ name, file: 'sheet1.xml', rows: '<row>…</row>' }]，按工作簿里的顺序
function makeXlsx(sheets, { sharedStrings = '', styles = '', date1904 = false, noRels = false } = {}) {
  const files = {
    'xl/workbook.xml': `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${
      date1904 ? '<workbookPr date1904="1"/>' : ''
    }<sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  };
  if (!noRels) files['xl/_rels/workbook.xml.rels'] = rels(sheets.map((s, i) => [`rId${i + 1}`, `worksheets/${s.file}`]));
  for (const s of sheets) files[`xl/worksheets/${s.file}`] = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows}</sheetData></worksheet>`;
  if (sharedStrings) files['xl/sharedStrings.xml'] = `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sharedStrings}</sst>`;
  if (styles) files['xl/styles.xml'] = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${styles}</styleSheet>`;
  return makeZip(files);
}

// slides：[{ file: 'slide1.xml', body: '<a:p>…</a:p>', notes: 备注页 <p:spTree> 里面的内容, hidden: 放映时跳过 }]，按放映的顺序
function makePptx(slides, { noRels = false } = {}) {
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files = {
    'ppt/presentation.xml': `${XML_HEAD}<p:presentation ${ns}><p:sldIdLst>${noRels ? '' : slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
  };
  if (!noRels) files['ppt/_rels/presentation.xml.rels'] = rels(slides.map((s, i) => [`rId${i + 1}`, `slides/${s.file}`]));
  for (const s of slides) {
    files[`ppt/slides/${s.file}`] = `${XML_HEAD}<p:sld ${ns}${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${s.body}</p:spTree></p:cSld></p:sld>`;
    if (s.notes === undefined) continue;
    files[`ppt/slides/_rels/${s.file}.rels`] = rels([
      ['rId1', '../slideLayouts/slideLayout1.xml', 'slideLayout'],
      ['rId2', `../notesSlides/notes-${s.file}`, 'notesSlide'],
    ]);
    files[`ppt/notesSlides/notes-${s.file}`] = `${XML_HEAD}<p:notes ${ns}><p:cSld><p:spTree>${s.notes}</p:spTree></p:cSld></p:notes>`;
  }
  return makeZip(files);
}

// ---------- PDF ----------

// 生成一个 PDF。objects 按对象号排列（第一个是 1 号）：
//   字符串：对象的内容（字典、数组……）；{ dict, stream }：流对象，/Length 会自动加上。
// 1 号对象必须是目录（/Catalog）。trailer：加在 trailer 字典里的内容（比如 /Encrypt）。
function makePdf(objects, { trailer = '', version = '1.4' } = {}) {
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    pos += buf.length;
  };
  push(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
  objects.forEach((obj, i) => {
    offsets.push(pos);
    if (typeof obj === 'string') push(`${i + 1} 0 obj\n${obj}\nendobj\n`);
    else {
      const data = Buffer.isBuffer(obj.stream) ? obj.stream : Buffer.from(obj.stream, 'latin1');
      push(`${i + 1} 0 obj\n<< ${obj.dict || ''} /Length ${data.length} >>\nstream\n`);
      push(data);
      push('\nendstream\nendobj\n');
    }
  });
  const xref = pos;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

// 只有文字的 PDF：pages 里每一项是一页的内容流（文字指令）；字体 /F1 默认是 Helvetica。
// stream(data)：把内容流包装成 { dict, stream }，用来测试各种压缩方式。more：追加在后面的对象（从 4 + 2 × 页数 号开始）。
function textPdf(pages, { font = HELVETICA, stream = (data) => ({ stream: data }), more = [], trailer = '', version } = {}) {
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`, font];
  pages.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(stream(content));
  });
  return makePdf([...objects, ...more], { trailer, version });
}

// 把二进制数据编码成 ASCII85（PDF 里的 /ASCII85Decode）
function ascii85(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 4) {
    const chunk = buf.subarray(i, i + 4);
    const n = chunk.length;
    const padded = Buffer.concat([chunk, Buffer.alloc(4 - n)]);
    let v = padded.readUInt32BE(0);
    if (n === 4 && v === 0) {
      out += 'z';
      continue;
    }
    const digits = [];
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += digits.slice(0, n + 1).join('');
  }
  return `${out}~>`;
}

module.exports = { FIXTURES, fixture, PNG, JPG, GIF, WEBP, crc32, makeZip, makeDocx, makeXlsx, makePptx, makePdf, textPdf, HELVETICA, ascii85 };
