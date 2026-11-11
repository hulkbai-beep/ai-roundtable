'use strict';

// 用户发来的附件：图片和文档。
// - 图片原样保存，发言时交给各家 AI（各家的接收方式不一样，见 providers.js）。
// - 文档（纯文本、Word、Excel、PowerPoint、PDF）在本机取出文字，和聊天记录一起发给所有成员，
//   所以不管对方能不能直接读文件，都能看到内容。
// - 取不出文字的 PDF（扫描件、加密）只能把文件本身交给能直接读 PDF 的 AI。
// 文件保存在 workspace/attachments/ 下。workspace 是命令行工具运行时所在的目录，它们可以直接打开这些文件。

const fs = require('fs');
const path = require('path');
const { uid, cut, UserError } = require('./util');
const { tr } = require('./i18n');
const { openZip, officeKind, officeText, decodeText } = require('./doc-text');
const { pdfText } = require('./pdf-text');

const MAX_FILE_MB = 15;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_PER_MESSAGE = 10;
const MAX_PENDING = 100;
// 上传时文件用 base64 放在 JSON 里，体积会大三分之一
const MAX_UPLOAD_BODY = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64 * 1024;

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const ID_RE = /^f[0-9a-z]{6,40}$/;
const FILE_RE = /^f[0-9a-z]{6,40}\.[0-9a-z]{1,8}$/;

const supportedHint = () =>
  tr(
    '支持的类型：图片（PNG、JPG、GIF、WebP）、PDF、Word / Excel / PowerPoint（docx、xlsx、pptx），以及各种纯文本文件（txt、md、csv、json、代码等）',
    'Supported: images (PNG, JPG, GIF, WebP), PDF, Word / Excel / PowerPoint (docx, xlsx, pptx), and plain-text files (txt, md, csv, json, code and so on)'
  );

function cleanName(name) {
  const base = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()
    .trim();
  return cut(base || tr('未命名', 'untitled'), 120).trim();
}

function extOf(name) {
  const m = /\.([0-9A-Za-z]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

const startsWith = (buf, bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

// 看文件开头的几个字节判断类型（不相信扩展名）
function sniff(buf) {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'gif';
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'webp';
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (startsWith(buf, ascii('{\\rtf'))) return 'rtf';
  // BMP：开头是 “BM”，后面第 6～9 个字节固定是 0（只看 “BM” 的话，以 BM 开头的文本文件也会被当成图片）
  if (startsWith(buf, ascii('BM')) && startsWith(buf, [0, 0, 0, 0], 6) && buf.length >= 26) return 'other-image';
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'other-image';
  if (startsWith(buf, ascii('ftyp'), 4) && /heic|heix|hevc|mif1|msf1|avif/.test(buf.toString('latin1', 8, 32))) return 'other-image';
  return '';
}

// 判断文件是什么、取出文字。返回 { kind, ext, mime, text, pages, partial }
function inspect(buf, name) {
  const type = sniff(buf);
  if (IMAGE_MIME[type]) return { kind: 'image', ext: type, mime: IMAGE_MIME[type], text: '' };

  if (type === 'pdf') {
    // 有的页有字、有的页是图片（扫描的）时，在图片页的位置写上这句话
    const imageNote = tr('（图片，没有能读出来的文字）', '(picture, no readable text)');
    let r;
    try {
      r = pdfText(buf, { imageNote });
    } catch {
      r = { text: '', pages: 0, objects: 0, encrypted: false, coverage: 0, scanned: 0 };
    }
    // 开头一小段里有 “%PDF-” 不一定就是 PDF：一份提到了 “%PDF-” 的笔记、日志或代码也是这样。
    // 一页都没读出来，“%PDF-” 又不在最开头（或者整个文件里连一个 PDF 对象都没有），而且全文是看得懂的文字：按文本处理
    const maybeText = !r.pages && !r.encrypted && (!startsWith(buf, ascii('%PDF-')) || !r.objects);
    if (!maybeText || decodeText(buf) == null) {
      const scanned = r.scanned || 0; // 有几页是图片
      const dense = (scanned ? r.text.split(imageNote).join('') : r.text).replace(/\s/g, '').length;
      // 文字够多（图片页不算）、认得出来的字符比例够高，才算“读出来了”；否则把 PDF 文件本身也交给能直接读 PDF 的 AI
      const good = dense >= Math.max(20, (r.pages - scanned) * 20) && r.coverage >= 0.85;
      // 图片页占到五分之一：光看读出来的文字会漏掉一大块，文件本身也交过去。只有零星一两页的，在文字里注明就行
      const whole = good && scanned < Math.max(1, r.pages * 0.2);
      // partial：读出来的文字不完整（good 时是太长、处理超时，或者图片页太多；否则是只认出了一部分）
      return { kind: whole ? 'doc' : 'pdf', ext: 'pdf', mime: 'application/pdf', text: r.text, pages: r.pages, partial: good ? Boolean(r.truncated) || !whole : dense > 0, encrypted: r.encrypted };
    }
  }

  if (type === 'zip') {
    let kind = null;
    let zip;
    try {
      zip = openZip(buf);
      kind = officeKind(zip);
    } catch {
      kind = null;
    }
    if (!kind) throw new UserError(tr(`「${name}」是一个压缩包，没法直接读`, `"${name}" is an archive and cannot be read directly`), tr('把里面的文件解压出来再添加', 'Extract the files and add them instead'));
    let text;
    // 写进文字里的几个小标题，跟着界面语言走
    const info = { labels: { notes: tr('备注：', 'Speaker notes:'), hidden: tr('（隐藏）', ' (hidden)'), header: tr('页眉：', 'Header: '), footer: tr('页脚：', 'Footer: ') } };
    try {
      text = officeText(zip, kind, info);
    } catch {
      throw new UserError(tr(`「${name}」读不出来，文件可能已经损坏`, `"${name}" could not be read; the file may be damaged`));
    }
    if (!text) throw new UserError(tr(`「${name}」里没有找到文字`, `No text was found in "${name}"`));
    return { kind: 'doc', ext: kind, mime: OFFICE_MIME[kind], text, partial: Boolean(info.truncated) };
  }

  if (type === 'ole' || type === 'rtf') {
    throw new UserError(
      tr(`「${name}」是旧版的文档格式（或者加了密码），读不了`, `"${name}" is in an old document format (or password-protected) and cannot be read`),
      tr('用 Word / Excel / PowerPoint 另存为 .docx / .xlsx / .pptx 或 PDF 再添加', 'Save it as .docx / .xlsx / .pptx or PDF in Word / Excel / PowerPoint, then add it again')
    );
  }
  if (type === 'other-image') {
    throw new UserError(tr(`「${name}」这种图片格式不支持`, `The image format of "${name}" is not supported`), tr('请换成 PNG 或 JPG 再添加', 'Convert it to PNG or JPG and add it again'));
  }

  const info = {};
  const text = decodeText(buf, info);
  if (text == null) throw new UserError(tr(`「${name}」这种文件读不了`, `"${name}" is not a supported file type`), supportedHint());
  if (!text) throw new UserError(tr(`「${name}」是空的`, `"${name}" is empty`));
  // 保存时用原来的扩展名，除非它是另一种文件的扩展名（内容其实是文本）
  const ext = extOf(name);
  const other = IMAGE_MIME[ext] || OFFICE_MIME[ext] || ext === 'jpeg' || ext === 'pdf';
  return { kind: 'doc', ext: ext && !other ? ext : 'txt', mime: 'text/plain', text, partial: Boolean(info.truncated) };
}

class AttachmentStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.pending = new Map(); // 已经上传、还没随消息发出去的附件
    this.texts = new Map(); // 最近读过的文档文字
  }

  // 保存用户上传的一个文件（data 是 base64），返回附件记录
  save({ name, data } = {}) {
    const clean = cleanName(name);
    if (typeof data !== 'string' || !data) throw new UserError(tr(`「${clean}」是空的`, `"${clean}" is empty`));
    if (data.length > MAX_UPLOAD_BODY) throw tooBig(clean);
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) throw new UserError(tr(`「${clean}」是空的`, `"${clean}" is empty`));
    if (buf.length > MAX_FILE_BYTES) throw tooBig(clean);
    const info = inspect(buf, clean);
    const id = uid('f');
    const file = `${id}.${info.ext}`;
    fs.writeFileSync(path.join(this.dir, file), buf);
    if (info.text) fs.writeFileSync(this.textPath(id), info.text, 'utf8');
    const record = { id, name: clean, kind: info.kind, mime: info.mime, size: buf.length, file, chars: info.text.length };
    if (info.pages) record.pages = info.pages;
    if (info.partial) record.partial = true;
    if (info.encrypted) record.encrypted = true;
    this.pending.set(id, record);
    if (this.pending.size > MAX_PENDING) this.discard(this.pending.keys().next().value);
    return record;
  }

  // 用户在发送前把附件拿掉了：删掉文件
  discard(id) {
    const record = this.pending.get(id);
    if (!record) return false;
    this.pending.delete(id);
    for (const file of [path.join(this.dir, record.file), this.textPath(id)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 删不掉就留着 */
      }
    }
    return true;
  }

  // 消息发出时，把这条消息带的附件取出来
  take(ids) {
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (list.length > MAX_PER_MESSAGE) throw new UserError(tr(`一条消息最多带 ${MAX_PER_MESSAGE} 个附件`, `A message can have at most ${MAX_PER_MESSAGE} attachments`));
    const records = list.map((id) => this.pending.get(id));
    if (records.some((r) => !r)) {
      // 多半是程序重启过：之前上传的附件只记在内存里。界面看到这个 code 会把输入区里失效的附件清掉
      const err = new UserError(tr('有附件已经失效了，请重新添加', 'An attachment is no longer available; please add it again'));
      err.code = 'attachments-gone';
      throw err;
    }
    for (const id of list) this.pending.delete(id);
    return records;
  }

  textPath(id) {
    return path.join(this.dir, `${id}-text.txt`);
  }

  // 文档里取出来的文字
  text(att) {
    if (!att || !ID_RE.test(String(att.id)) || !att.chars) return '';
    if (this.texts.has(att.id)) return this.texts.get(att.id);
    let text = '';
    try {
      text = fs.readFileSync(this.textPath(att.id), 'utf8');
    } catch {
      text = '';
    }
    if (this.texts.size >= 20) this.texts.delete(this.texts.keys().next().value);
    this.texts.set(att.id, text);
    return text;
  }

  // 取出来的文字所在的文件（给能自己读文件的命令行工具用）；没有返回 null
  textFile(att) {
    if (!att || !ID_RE.test(String(att.id)) || !att.chars) return null;
    const full = this.textPath(att.id);
    return fs.existsSync(full) ? full : null;
  }

  // 还没发出去的附件全部删掉（程序关闭时）
  clearPending() {
    for (const id of [...this.pending.keys()]) this.discard(id);
  }

  // 附件文件的完整路径；文件不在了返回 null
  filePath(att) {
    if (!att || !FILE_RE.test(String(att.file))) return null;
    const full = path.join(this.dir, att.file);
    return fs.existsSync(full) ? full : null;
  }

  // 给网页显示 / 下载用：只认我们自己起的文件名，图片可以直接显示，其他一律按下载处理
  resolve(file) {
    if (!FILE_RE.test(String(file))) return null;
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) return null;
    const mime = IMAGE_MIME[extOf(file)];
    return { path: full, mime: mime || 'application/octet-stream', inline: Boolean(mime) };
  }
}

function tooBig(name) {
  return new UserError(tr(`「${name}」太大了（超过 ${MAX_FILE_MB} MB）`, `"${name}" is too large (over ${MAX_FILE_MB} MB)`));
}

module.exports = { AttachmentStore, inspect, sniff, MAX_FILE_BYTES, MAX_FILE_MB, MAX_PER_MESSAGE, MAX_UPLOAD_BODY };
