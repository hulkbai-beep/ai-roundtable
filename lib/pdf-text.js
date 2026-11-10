'use strict';

// 从 PDF 里取出文字（尽力而为，不依赖第三方库）。
//
// 做法：扫描出文件里所有的对象 → 沿着页面树找到每一页的内容流 → 解析里面的文字指令，
// 按字体的 ToUnicode 表（没有就按编码）把字节换成文字，再根据每段文字的位置判断哪里该加空格、哪里该换行。
//
// 取不出文字的情况：扫描件（整页是图片）、加密的 PDF、字体既没有 ToUnicode 也没有标准编码。
// 这时返回的 text 是空的（或很少），调用方会改为把 PDF 文件本身交给能直接读 PDF 的 AI。

const zlib = require('zlib');

const MAX_STREAM_BYTES = 64 * 1024 * 1024; // 一个流解码后最多这么大
const MAX_DECODED_BYTES = 256 * 1024 * 1024; // 一份文件总共最多解码出这么多（同一个流被反复引用也算）
const MAX_FORMS = 20000; // 一份文件里最多展开多少次表单对象（表单套表单可以成倍地放大工作量）
const FORM_CACHE_BYTES = 16 * 1024 * 1024; // 解码过的小表单留着，重复使用时不用再解一遍

// 解析出来的东西在内存里大约占多少，也有上限。只限制“解压出多少字节”不够：
// 压缩过的流里 4 个字节就能写出一个空字典，放进内存要一百多字节。分两本账，各有各的上限：
// - 对象表（文件里有哪些对象、各在哪里，加上对象流解码后的内容）；
// - 解析出来的对象和字体的对照表（用不到的对象根本不解析，见 Entry）。
// 一本账用完了，另一本照常用。正常的文件离上限很远：试过的一百多份真实 PDF，两本账都没用到 2 MB。
const MAX_ROOM = 64 * 1024 * 1024; // 解析出来的对象和对照表
const MIN_INDEX = 64 * 1024 * 1024; // 对象表：不超过这么多，文件大的话再放宽到文件大小的 INDEX_PER_BYTE 倍
const INDEX_PER_BYTE = 8;
const TOKEN_ROOM = 8 * 1024 * 1024; // 内容流、对照表里的一个数组（或字典、字符串）最多这么大
const COST_DICT = 128; // 一个字典
const COST_ARRAY = 32; // 一个数组
const COST_ITEM = 16; // 数组里的一项、字典里的一对
const COST_VALUE = 32; // 一个字符串、名字或者引用（字符串和名字另外按长度算）
const COST_ENTRY = 112; // 对象表里的一条
const COST_MAPPING = 64; // 对照表里的一条

// ---------- 词法分析：PDF 对象和内容流共用 ----------

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
const REF_RE = /[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+R(?![A-Za-z0-9])/y;
const END = Symbol('end');
const SKIPPED = Object.freeze({ op: '' }); // “只跳过不解析”时用来占位

class Lexer {
  // refs = true：把 "12 0 R" 读成引用（解析对象时用）；内容流里没有引用。
  // room：{ left }，还可以解析出多少东西（按上面的估算，单位是字节）。用完以后 read() 只返回 END，
  // 读到一半的数组、字典到此为止。不给就是不限。
  constructor(s, pos = 0, refs = false, room = null) {
    this.s = s;
    this.pos = pos;
    this.refs = refs;
    this.room = room || { left: Infinity };
    this.dry = false; // true：只往后跳，不把读到的东西建出来（用来找一个对象到哪里结束，走的是同一套规则）
  }

  skipWs() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.pos);
      if (isWs(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < s.length && s.charCodeAt(this.pos) !== 10 && s.charCodeAt(this.pos) !== 13) this.pos++;
      } else break;
    }
  }

  // 读出下一个对象。数字 → number；名字 → '/Name'；字符串 → { s }；数组 → []；字典 → { 键: 值 }；
  // 引用 → { ref }；其他关键字（内容流里的指令）→ { op }；读完了 → END
  read(depth = 0) {
    const room = this.room;
    if (room.left < 0) return END;
    this.skipWs();
    const s = this.s;
    const dry = this.dry;
    if (this.pos >= s.length) return END;
    const c = s.charCodeAt(this.pos);
    if (c === 47) return this.readName();
    if (c === 40) return this.str(this.readLiteral());
    if (c === 60) {
      if (s.charCodeAt(this.pos + 1) === 60) return this.readDict(depth);
      return this.str(this.readHex());
    }
    if (c === 91) {
      this.pos++;
      const arr = dry ? null : [];
      room.left -= COST_ARRAY;
      for (;;) {
        this.skipWs();
        if (this.pos >= s.length) break;
        if (s.charCodeAt(this.pos) === 93) {
          this.pos++;
          break;
        }
        const v = depth > 100 ? END : this.read(depth + 1);
        if (v === END) break;
        if (arr) {
          arr.push(v);
          room.left -= COST_ITEM;
        }
      }
      return arr || SKIPPED;
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) {
      this.pos += c === 62 && s.charCodeAt(this.pos + 1) === 62 ? 2 : 1;
      return dry ? SKIPPED : { op: '' };
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      NUM_RE.lastIndex = this.pos;
      const m = NUM_RE.exec(s);
      if (m) {
        this.pos = NUM_RE.lastIndex;
        if (this.refs && /^\d+$/.test(m[0])) {
          REF_RE.lastIndex = this.pos;
          if (REF_RE.exec(s)) {
            this.pos = REF_RE.lastIndex;
            if (dry) return SKIPPED;
            room.left -= COST_VALUE;
            return { ref: Number(m[0]) };
          }
        }
        return Number(m[0]);
      }
    }
    const start = this.pos;
    while (this.pos < s.length) {
      const k = s.charCodeAt(this.pos);
      if (isWs(k) || isDelim(k)) break;
      this.pos++;
    }
    if (this.pos === start) this.pos++;
    if (dry) return SKIPPED;
    const word = s.slice(start, this.pos);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    room.left -= COST_VALUE + word.length;
    return { op: word };
  }

  // 字符串：{ s }
  str(text) {
    if (this.dry) return SKIPPED;
    this.room.left -= COST_VALUE + text.length;
    return { s: text };
  }

  readName() {
    const s = this.s;
    const start = ++this.pos;
    while (this.pos < s.length) {
      const k = s.charCodeAt(this.pos);
      if (isWs(k) || isDelim(k)) break;
      this.pos++;
    }
    if (this.dry) return '/';
    const raw = s.slice(start, this.pos);
    this.room.left -= COST_VALUE + raw.length;
    return `/${raw.includes('#') ? raw.replace(/#([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))) : raw}`;
  }

  readLiteral() {
    const s = this.s;
    const dry = this.dry;
    let out = '';
    let depth = 1;
    let i = this.pos + 1;
    let from = i;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 92) {
        if (dry) {
          i++; // 反斜杠后面那个字不算括号
          continue;
        }
        out += s.slice(from, i);
        const n = s[++i];
        if (n === 'n') out += '\n';
        else if (n === 'r') out += '\r';
        else if (n === 't') out += '\t';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (n === '\r') {
          if (s[i + 1] === '\n') i++;
        } else if (n !== '\n' && n !== undefined) out += n;
        from = i + 1;
      } else if (c === 40) depth++;
      else if (c === 41 && --depth === 0) break;
    }
    if (!dry) out += s.slice(from, i);
    this.pos = i + 1;
    return out;
  }

  readHex() {
    const s = this.s;
    const end = s.indexOf('>', this.pos);
    const stop = end < 0 ? s.length : end;
    const from = this.pos + 1;
    this.pos = stop + 1;
    if (this.dry) return '';
    let hex = s.slice(from, stop).replace(/[^0-9A-Fa-f]/g, '');
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  readDict(depth) {
    const s = this.s;
    this.pos += 2;
    const room = this.room;
    const dict = this.dry ? null : Object.create(null); // 不带原型：键名叫 __proto__ 也只是普通的键
    room.left -= COST_DICT;
    for (;;) {
      this.skipWs();
      if (this.pos >= s.length) break;
      if (s.charCodeAt(this.pos) === 62) {
        this.pos += s.charCodeAt(this.pos + 1) === 62 ? 2 : 1;
        break;
      }
      const key = this.read(depth + 1);
      if (key === END) break;
      if (typeof key !== 'string') continue; // 坏掉的字典：跳过不认识的东西
      const val = depth > 100 ? END : this.read(depth + 1);
      if (val === END) break;
      if (dict) {
        dict[key.slice(1)] = val;
        room.left -= COST_ITEM;
      }
    }
    return dict || SKIPPED;
  }
}

const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v.s === undefined && v.ref === undefined && v.op === undefined;
const isName = (v) => typeof v === 'string';
// 字符串的第 i 个字是不是空白
const isSpaceAt = (s, i) => {
  const c = s.charCodeAt(i);
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x3000;
};
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------- 流的解码 ----------

// 解压。解出来超过上限的返回 null，数据坏了的返回空
function inflate(data) {
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_STREAM_BYTES };
  const tooBig = (e) => Boolean(e) && e.code === 'ERR_BUFFER_TOO_LARGE';
  try {
    return zlib.inflateSync(data, opts);
  } catch (e) {
    if (tooBig(e)) return null;
    try {
      return zlib.inflateRawSync(data, opts);
    } catch (e2) {
      return tooBig(e2) ? null : Buffer.alloc(0);
    }
  }
}

// ASCII85：每 5 个字符表示 4 个字节，一个 z 表示 4 个 0（所以解出来可能比原来大 4 倍）。
// 结果直接写进一块缓冲区，到了上限就停。
function ascii85(data, max = MAX_STREAM_BYTES) {
  let out = Buffer.allocUnsafe(Math.min(max, Math.max(64, data.length)));
  let size = 0;
  const put = (v, n) => {
    if (size + 4 > out.length) {
      if (out.length >= max) return false;
      const bigger = Buffer.allocUnsafe(Math.min(max, out.length * 2 + 4));
      out.copy(bigger, 0, 0, size);
      out = bigger;
      if (size + 4 > out.length) return false;
    }
    out.writeUInt32BE(v >>> 0, size);
    size += n;
    return true;
  };
  let v = 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 126) break; // "~>" 结束
    if (isWs(c)) continue;
    if (c === 122 && !n) {
      if (!put(0, 4)) break;
      continue;
    }
    if (c < 33 || c > 117) continue;
    v = v * 85 + (c - 33);
    if (++n === 5) {
      if (!put(v, 4)) break;
      v = 0;
      n = 0;
    }
  }
  if (n > 1) {
    for (let k = n; k < 5; k++) v = v * 85 + 84;
    put(v, n - 1);
  }
  return out.subarray(0, size);
}

function asciiHex(data) {
  const text = data.toString('latin1');
  const end = text.indexOf('>');
  let hex = (end < 0 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length % 2) hex += '0';
  return Buffer.from(hex, 'hex');
}

// ---------- 文档结构 ----------

// 文件里的一个对象。内容等用到的时候才解析（entry.v）：一份文件里大部分对象（书签、标签结构、批注……）
// 和取文字没有关系，全部解析出来既慢又占内存。
class Entry {
  constructor(pdf, src, pos) {
    this.pdf = pdf;
    this.src = src; // 对象写在哪段文字里：整个文件，或者某个对象流解码后的内容
    this.pos = pos; // 从哪里开始
    this.val = undefined; // 解析出来的内容；undefined = 还没解析
    this.start = -1; // 后面跟着流的话：流的数据在文件里从哪里到哪里
    this.end = -1;
  }

  get v() {
    if (this.val === undefined) {
      const pdf = this.pdf;
      let v = END;
      if (!pdf.late()) {
        const lex = new Lexer(this.src, this.pos, true, pdf.room);
        v = lex.read();
        pdf.work((lex.pos - this.pos) >> 4);
      }
      this.val = v === END ? null : v;
    }
    return this.val;
  }
}

class Pdf {
  // deadline：到这个时间（毫秒时间戳）还没处理完就不再往下做了，免得特别复杂（或故意构造）的文件把程序卡住
  constructor(buf, deadline = Infinity) {
    this.buf = buf;
    this.deadline = deadline;
    this.timedOut = false;
    this.steps = 0;
    this.checkAt = 1024; // 走到第几步再看一眼时间
    this.index = { left: Math.max(MIN_INDEX, buf.length * INDEX_PER_BYTE) }; // 对象表还可以占多少内存（估算）
    this.room = { left: MAX_ROOM }; // 解析出来的对象和对照表还可以占多少
    this.decoded = 0; // 已经解码出多少字节
    this.forms = 0; // 已经展开了多少次表单对象
    this.formCache = new Map(); // 表单对象 → 解码后的内容
    this.formCacheBytes = 0;
    this.plainForms = new Set(); // 看过了、里面没有文字的表单
    this.cmaps = new Map(); // ToUnicode 流 → 解析好的对照表（好几个字体共用一张表时只解析一次）
    this.objs = new Map(); // 对象号 → Entry
    this.roots = []; // 文件里写的“目录是哪个对象”
    this.encrypted = false;
    this.morePages = false;
    this.skipped = false; // 有的流因为太大、总量超了或者时间用完了，没有解码（或者只解了开头）
    this.scan(buf.toString('latin1'));
  }

  late() {
    if (Date.now() > this.deadline) this.timedOut = true;
    return this.timedOut;
  }

  // 循环里每走一步问一次“是不是该停了”，每 1024 步才真的看一眼时间。
  // 步数记在整份文件上：一层套一层的小表单各自只有几步，分开数的话永远数不到 1024。
  busy() {
    if (++this.steps < this.checkAt) return this.timedOut;
    this.checkAt = this.steps + 1024;
    return this.late();
  }

  // 做了一件费事的事（比如解一个很长的字符串），折合成 n 步记上：“一步”不都是一样快的
  work(n) {
    this.steps += n;
  }

  scan(s) {
    const index = this.index;
    const re = /(?:^|[^0-9A-Za-z])(\d{1,10})[\x00\t\n\f\r ]+\d{1,5}[\x00\t\n\f\r ]+obj(?![A-Za-z0-9])/g;
    let m;
    while (index.left >= 0 && (m = re.exec(s))) {
      // 先只看这个对象到哪里结束
      const from = re.lastIndex;
      const lex = new Lexer(s, from, true);
      lex.dry = true;
      if (lex.read() === END) break;
      lex.skipWs();
      const entry = new Entry(this, s, from);
      index.left -= COST_ENTRY;
      this.objs.set(Number(m[1]), entry);
      // 后面跟着流的话，字典现在就要用：流有多长、里面是不是装着别的对象
      const v = s.startsWith('stream', lex.pos) ? entry.v : null;
      if (isDict(v)) {
        let p = lex.pos + 6;
        if (s.charCodeAt(p) === 13 && s.charCodeAt(p + 1) === 10) p += 2;
        else if (s.charCodeAt(p) === 10 || s.charCodeAt(p) === 13) p += 1;
        let end = -1;
        if (typeof v.Length === 'number' && v.Length >= 0 && /^[\x00\t\n\f\r ]*endstream/.test(s.substr(p + v.Length, 24))) end = p + v.Length;
        if (end < 0) {
          end = s.indexOf('endstream', p);
          if (end < 0) end = s.length;
        }
        entry.start = p;
        entry.end = end;
        lex.pos = end;
        if (v.Type === '/XRef') {
          if (v.Encrypt !== undefined) this.encrypted = true;
          if (v.Root !== undefined) this.roots.push(v.Root);
        }
        if (v.Type === '/ObjStm' && !this.late()) this.expandObjectStream(entry);
      }
      re.lastIndex = Math.max(lex.pos, re.lastIndex);
    }
    // 结尾的 trailer 字典：有没有 Encrypt，目录（Root）是哪个对象。每个字典读完以后从它后面接着找：
    // 不然“字典里的文字又写着 trailer<<”这样的文件，会从每一处都把后面整个读一遍
    const trailer = /trailer[\x00\t\n\f\r ]*<</g;
    let t;
    while (!this.encrypted && (t = trailer.exec(s)) && !this.late()) {
      const lex = new Lexer(s, trailer.lastIndex - 2, true, { left: TOKEN_ROOM });
      const d = lex.read();
      if (isDict(d)) {
        if (d.Encrypt !== undefined) this.encrypted = true;
        if (d.Root !== undefined) this.roots.push(d.Root);
      }
      trailer.lastIndex = Math.max(trailer.lastIndex, lex.pos);
    }
  }

  // 对象流（PDF 1.5 起）：很多小对象压缩在一个流里。这里只登记每个对象从哪里开始，用到了再解析
  expandObjectStream(entry) {
    const data = this.streamBytes(entry);
    if (!data || !data.length) return;
    const index = this.index;
    index.left -= data.length; // 解码后的内容要一直留着，也记在账上
    if (index.left < 0) return;
    const text = data.toString('latin1');
    const n = num(this.resolve(entry.v.N));
    const first = num(this.resolve(entry.v.First));
    const head = new Lexer(text, 0, false, { left: TOKEN_ROOM });
    for (let i = 0; i < n; i++) {
      const id = head.read();
      const off = head.read();
      if (typeof id !== 'number' || typeof off !== 'number') break;
      const at = first + off;
      // 位置不在这个流里的不要（负数的位置会让后面的解析从“很远的前面”一步步走过来）
      if (at >= 0 && at < text.length) {
        this.objs.set(id, new Entry(this, text, at));
        index.left -= COST_ENTRY;
      }
      if (index.left < 0 || this.busy()) break;
    }
  }

  resolve(v) {
    for (let i = 0; i < 20 && v && typeof v === 'object' && v.ref !== undefined; i++) {
      const o = this.objs.get(v.ref);
      v = o ? o.v : null;
    }
    return v;
  }

  entry(v) {
    return v && typeof v === 'object' && v.ref !== undefined ? this.objs.get(v.ref) : null;
  }

  // 解码一个流；遇到不支持的压缩方式（图片用的那些）返回 null。
  // 每次解码都记在总量里，也都看一眼时间：同一个流可以被引用成千上万遍，每一遍都是实打实的工作量。
  streamBytes(entry) {
    if (!entry || entry.start < 0) return null;
    if (this.decoded >= MAX_DECODED_BYTES || this.late()) {
      this.skipped = true;
      return null;
    }
    let data = this.buf.subarray(entry.start, entry.end);
    let filters = this.resolve(entry.v.Filter);
    if (filters == null) filters = [];
    else if (!Array.isArray(filters)) filters = [filters];
    if (filters.length > 8) return null;
    for (const f of filters) {
      const name = this.resolve(f);
      if (name === '/FlateDecode' || name === '/Fl') data = inflate(data);
      else if (name === '/ASCII85Decode' || name === '/A85') data = ascii85(data);
      else if (name === '/ASCIIHexDecode' || name === '/AHx') data = asciiHex(data);
      else return null;
      // 超过上限的流不要了（ASCII85 的只留到上限为止），工作量照样按上限记
      const over = !data || data.length >= MAX_STREAM_BYTES;
      this.decoded += over ? MAX_STREAM_BYTES : data.length;
      if (over) this.skipped = true;
      if (!data) return null;
    }
    return data;
  }

  streamText(ref) {
    const data = this.streamBytes(this.entry(ref));
    return data ? data.toString('latin1') : '';
  }

  // 按顺序列出每一页：{ node, resources }
  pages(maxPages) {
    const pages = [];
    const seen = new Set();
    const walk = (ref, inherited, depth) => {
      if (pages.length >= maxPages) this.morePages = true; // 页数超过上限，后面的不读了
      if (pages.length >= maxPages || depth > 64 || this.busy()) return;
      const node = this.resolve(ref);
      // 同一个节点只走一次。按节点本身认，不按引用的编号认：节点可以直接写在一个被共用的数组里，
      // 那样的话一层只有两个节点、套上几十层，不去重就要走 2 的几十次方遍
      if (!isDict(node) || seen.has(node)) return;
      seen.add(node);
      const resources = node.Resources !== undefined ? node.Resources : inherited;
      const kids = this.resolve(node.Kids);
      if (Array.isArray(kids)) {
        for (const k of kids) {
          if (this.timedOut) break;
          walk(k, resources, depth + 1);
        }
      } else if (node.Type === '/Page' || node.Contents !== undefined) pages.push({ node, resources });
    };
    // 目录是哪个对象，写在结尾的 trailer 或者交叉引用流里；文件改过几次的话有好几处，后面的新
    for (let i = this.roots.length - 1; i >= 0 && !pages.length; i--) {
      const catalog = this.resolve(this.roots[i]);
      if (isDict(catalog) && catalog.Pages !== undefined) walk(catalog.Pages, undefined, 0);
    }
    if (!pages.length) {
      // 没写，或者写的不对（文件有损坏）：把对象挨个看一遍，找目录
      for (const o of this.objs.values()) {
        if (this.timedOut) break;
        const v = o.v;
        if (isDict(v) && v.Type === '/Catalog' && v.Pages !== undefined) walk(v.Pages, undefined, 0);
        if (pages.length) break;
      }
    }
    if (!pages.length) {
      // 找不到目录：按对象号的顺序把所有页面找出来
      const ids = [...this.objs.keys()].sort((a, b) => a - b);
      for (const id of ids) {
        if (this.timedOut) break;
        const v = this.objs.get(id).v;
        if (!isDict(v) || v.Type !== '/Page') continue;
        if (pages.length < maxPages) pages.push({ node: v, resources: v.Resources });
        else this.morePages = true;
      }
    }
    return pages;
  }
}

// ---------- 字体：字节 → 文字 ----------

function utf16(hex) {
  const h = hex.replace(/[^0-9A-Fa-f]/g, '');
  if (h.length <= 2) return h ? String.fromCharCode(parseInt(h, 16)) : '';
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
  return out;
}

const MAX_MAP_WORK = 2000000; // 一张表最多登记这么多条，够用很多倍了；再多就是文件有问题

// 很多个 { from, to } 区间，按 from 排好序、互不重叠：k 落在哪一个里（二分查找），都不在返回 null
function findRange(ranges, k) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (k < r.from) hi = mid - 1;
    else if (k > r.to) lo = mid + 1;
    else return r;
  }
  return null;
}

// ToUnicode 表里的目标文字（已经从十六进制换成了字节）：每两个字节是一个 UTF-16 单元，只有一个字节的就是那个字
function utf16be(bytes) {
  if (bytes.length < 2) return bytes;
  let out = '';
  for (let i = 0; i + 2 <= bytes.length; i += 2) out += String.fromCharCode(bytes.charCodeAt(i) * 256 + bytes.charCodeAt(i + 1));
  return out;
}

// ToUnicode 表：编码 → 文字。
// 一个编码对一段文字的，放在 map 里；“从 A 到 B 依次对应”的区间只记头尾（ranges），不一个个展开：
// 有的字体一个区间就是六万多个编码，几十个这样的字体全展开要占上千兆内存。
class CMap {
  constructor() {
    this.map = new Map(); // 字节数 × 0x1000000 + 编码 → 文字
    this.ranges = []; // { from, to, head, last }：from、to 和 map 的写法一样；对应的文字是 head 加上“last + 第几个”
    this.lens = []; // 编码有几种长度（字节数），长的在前
  }

  get size() {
    return this.map.size + this.ranges.length;
  }

  get(len, code) {
    const k = len * 0x1000000 + code;
    const hit = this.map.get(k);
    if (hit !== undefined) return hit;
    const r = this.ranges.length ? findRange(this.ranges, k) : null;
    return r ? r.head + String.fromCharCode((r.last + k - r.from) & 0xffff) : undefined;
  }
}

// 解析 ToUnicode 表。用词法分析器从头到尾读一遍，不用正则去配“<..> <..> [ … ]”：
// 少了右括号的坏文件会让那样的正则从每一处都把后面整个读一遍。
function parseCMap(text, pdf) {
  const cmap = new CMap();
  const lens = new Set();
  const room = { left: TOKEN_ROOM };
  const lex = new Lexer(text, 0, false, room);
  let work = 0;
  // 编码：最多 4 个字节（正常的表就是 1～4 个；随便多长都认的话，解一个字要把每种长度都试一遍）。
  // 返回 [字节数, 编码]，不对的返回 null
  const code = (tok) => {
    const b = tok.s;
    if (b === undefined || b.length > 4) return null;
    let c = 0;
    for (let i = 0; i < b.length; i++) c = c * 256 + b.charCodeAt(i);
    return [Math.max(1, b.length), c];
  };
  const charge = (value) => {
    work++;
    pdf.room.left -= COST_MAPPING + value.length * 2;
  };
  const set = (len, c, value) => {
    charge(value);
    cmap.map.set(len * 0x1000000 + c, value);
  };
  let mode = ''; // 现在在哪一段里：codespacerange / bfchar / bfrange
  let args = [];
  let complete = false;
  for (;;) {
    room.left = TOKEN_ROOM;
    const tok = lex.read();
    if (tok === END) {
      complete = true;
      break;
    }
    if (room.left < 0 || pdf.room.left < 0 || work > MAX_MAP_WORK || pdf.busy()) break;
    if (!Array.isArray(tok) && (tok === null || typeof tok !== 'object' || tok.s === undefined)) {
      // 不是字符串也不是数组（关键字、数字、名字）：正在凑的那一条不要了
      args = [];
      const op = tok !== null && typeof tok === 'object' && typeof tok.op === 'string' ? tok.op : '';
      if (op === 'begincodespacerange' || op === 'beginbfchar' || op === 'beginbfrange') mode = op.slice(5);
      else if (op.startsWith('begin') || op.startsWith('end')) mode = '';
      continue;
    }
    if (!mode) continue;
    args.push(tok);
    if (args.length < (mode === 'bfrange' ? 3 : 2)) continue;
    const [first, second, dst] = args;
    args = [];
    const lo = code(first);
    if (!lo || Array.isArray(second)) continue;
    const len = lo[0];
    if (mode === 'codespacerange') lens.add(len);
    else if (mode === 'bfchar') {
      lens.add(len);
      set(len, lo[1], utf16be(second.s));
    } else {
      const top = code(second);
      if (!top) continue;
      lens.add(len);
      const hi = Math.min(top[1], 256 ** len - 1);
      if (hi < lo[1]) continue;
      if (Array.isArray(dst)) {
        // 每个编码各写了一段文字
        const list = dst.filter((x) => x !== null && typeof x === 'object' && x.s !== undefined);
        for (let i = 0; i < list.length && lo[1] + i <= hi; i++) set(len, lo[1] + i, utf16be(list[i].s));
      } else {
        const base = utf16be(dst.s);
        if (!base) continue;
        if (hi === lo[1]) set(len, hi, base);
        else {
          charge(base);
          cmap.ranges.push({ from: len * 0x1000000 + lo[1], to: len * 0x1000000 + hi, head: base.slice(0, -1), last: base.charCodeAt(base.length - 1) });
        }
      }
    }
  }
  if (!complete) pdf.skipped = true; // 表大得不正常，或者时间、内存用完了：没有读全
  cmap.ranges.sort((x, y) => x.from - y.from);
  cmap.lens = [...lens].sort((x, y) => y - x);
  return cmap;
}

// 字形名 → 文字（用在没有 ToUnicode、靠 /Differences 重新编码的字体上，LaTeX 生成的 PDF 常见）
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteleft: '\u2018', quoteright: '\u2019', quotedblleft: '\u201c', quotedblright: '\u201d', quotesinglbase: '\u201a', quotedblbase: '\u201e',
  guillemotleft: '\u00ab', guillemotright: '\u00bb', guilsinglleft: '\u2039', guilsinglright: '\u203a', endash: '\u2013', emdash: '\u2014',
  minus: '\u2212', bullet: '\u2022', periodcentered: '\u00b7', ellipsis: '\u2026', dagger: '\u2020', daggerdbl: '\u2021', section: '\u00a7',
  paragraph: '\u00b6', copyright: '\u00a9', registered: '\u00ae', trademark: '\u2122', degree: '\u00b0', plusminus: '\u00b1', multiply: '\u00d7',
  divide: '\u00f7', fraction: '\u2044', ff: 'ff', fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl', germandbls: '\u00df', ae: '\u00e6', AE: '\u00c6',
  oe: '\u0153', OE: '\u0152', oslash: '\u00f8', Oslash: '\u00d8', lslash: '\u0142', Lslash: '\u0141', dotlessi: '\u0131', dotlessj: '\u0237',
  eth: '\u00f0', Eth: '\u00d0', thorn: '\u00fe', Thorn: '\u00de', exclamdown: '\u00a1', questiondown: '\u00bf', cent: '\u00a2', sterling: '\u00a3',
  yen: '\u00a5', Euro: '\u20ac', currency: '\u00a4', florin: '\u0192', brokenbar: '\u00a6', logicalnot: '\u00ac', mu: '\u00b5', onehalf: '\u00bd',
  onequarter: '\u00bc', threequarters: '\u00be', onesuperior: '\u00b9', twosuperior: '\u00b2', threesuperior: '\u00b3', ordfeminine: '\u00aa',
  ordmasculine: '\u00ba', perthousand: '\u2030', acute: '\u00b4', dieresis: '\u00a8', circumflex: '\u02c6', tilde: '\u02dc', macron: '\u00af',
  cedilla: '\u00b8', nbspace: ' ', nonbreakingspace: ' ', sfthyphen: '', softhyphen: '', visiblespace: ' ',
  lessequal: '\u2264', greaterequal: '\u2265', notequal: '\u2260', approxequal: '\u2248', equivalence: '\u2261', infinity: '\u221e',
  summation: '\u2211', product: '\u220f', integral: '\u222b', radical: '\u221a', partialdiff: '\u2202', element: '\u2208', proportional: '\u221d',
  arrowright: '\u2192', arrowleft: '\u2190', arrowup: '\u2191', arrowdown: '\u2193', arrowboth: '\u2194', arrowdblright: '\u21d2',
  asteriskmath: '\u2217', prime: '\u2032', similar: '\u223c', universal: '\u2200', existential: '\u2203', emptyset: '\u2205', gradient: '\u2207',
  intersection: '\u2229', union: '\u222a', propersubset: '\u2282', reflexsubset: '\u2286', angle: '\u2220', perpendicular: '\u22a5', dotmath: '\u22c5',
};
// 数学符号（LaTeX 的数学字体用的字形名）
const MATH = 'owner:\u220b logicaland:\u2227 logicalor:\u2228 arrowdblleft:\u21d0 arrowdblboth:\u21d4 arrowdblup:\u21d1 arrowdbldown:\u21d3 negationslash:! nabla:\u2207 minusplus:\u2213 '
  + 'propersuperset:\u2283 reflexsuperset:\u2287 mapsto:\u21a6 angbracketleft:\u27e8 angbracketright:\u27e9 bardbl:\u2016 floorleft:\u230a floorright:\u230b ceilingleft:\u2308 ceilingright:\u2309 '
  + 'circleplus:\u2295 circleminus:\u2296 circlemultiply:\u2297 circledivide:\u2298 circledot:\u2299 aleph:\u2135 lscript:\u2113 weierstrass:\u2118 Rfractur:\u211c Ifractur:\u2111 epsilon1:\u03b5 theta1:\u03d1 '
  + 'pi1:\u03d6 rho1:\u03f1 phi1:\u03c6 star:\u22c6 openbullet:\u25e6 turnstileleft:\u22a2 turnstileright:\u22a3 similarequal:\u2243 equivasymptotic:\u224d lessmuch:\u226a greatermuch:\u226b precedes:\u227a '
  + 'follows:\u227b precedesequal:\u2aaf followsequal:\u2ab0 wreathproduct:\u2240 coproduct:\u2210 unionsq:\u2294 intersectionsq:\u2293 subsetsqequal:\u2291 supersetsqequal:\u2292 unionmulti:\u228e '
  + 'club:\u2663 diamond:\u2662 heart:\u2661 spade:\u2660 triangle:\u25b3 triangleinv:\u25bd latticetop:\u22a4 arrownortheast:\u2197 arrowsoutheast:\u2198 arrownorthwest:\u2196 arrowsouthwest:\u2199 '
  + 'arrowbothv:\u2195 arrowdblbothv:\u21d5 diamondmath:\u22c4 flat:\u266d natural:\u266e sharp:\u266f triangleright:\u25b7 triangleleft:\u25c1 circlecopyrt:\u00a9 tie:\u2040 vector:\u20d7';
for (const pair of MATH.split(' ')) GLYPHS[pair.slice(0, pair.indexOf(':'))] = pair.slice(pair.indexOf(':') + 1);
const GREEK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma1 sigma tau upsilon phi chi psi omega'.split(' ');
GREEK.forEach((name, i) => {
  if (name !== 'mu') GLYPHS[name] = String.fromCharCode(0x3b1 + i);
  if (name !== 'sigma1') GLYPHS[name[0].toUpperCase() + name.slice(1)] = String.fromCharCode(0x391 + i);
});
const ACCENTS = {
  acute: '\u0301', grave: '\u0300', circumflex: '\u0302', dieresis: '\u0308', tilde: '\u0303', ring: '\u030a', cedilla: '\u0327', caron: '\u030c',
  macron: '\u0304', breve: '\u0306', ogonek: '\u0328', dotaccent: '\u0307', hungarumlaut: '\u030b',
};

function glyphChar(name) {
  const known = GLYPHS[name];
  if (typeof known === 'string') return known; // typeof：名字叫 constructor 之类的时候，查到的不是字
  if (name.length > 64) return ''; // 正常的字形名没有这么长；特别长的名字下面一层层拆起来很慢
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (m) return utf16(m[1]);
  m = /^u([0-9A-F]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  if (name.length === 1) return name;
  m = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut)$/.exec(name);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize('NFC');
  if (name.includes('.')) return glyphChar(name.split('.')[0]);
  m = /^(.+?)(display|text|bigg?|Bigg?)$/.exec(name); // 大号的求和号、括号等
  if (m) return glyphChar(m[1]);
  if (name.includes('_')) return name.split('_').map(glyphChar).join('');
  return '';
}

// StandardEncoding 和 WinAnsi 不一样的那些位置
const STANDARD_HIGH = {
  0x27: '\u2019', 0x60: '\u2018', 0xa1: '\u00a1', 0xa2: '\u00a2', 0xa3: '\u00a3', 0xa4: '\u2044', 0xa5: '\u00a5', 0xa6: '\u0192', 0xa7: '\u00a7',
  0xa8: '\u00a4', 0xa9: "'", 0xaa: '\u201c', 0xab: '\u00ab', 0xac: '\u2039', 0xad: '\u203a', 0xae: 'fi', 0xaf: 'fl', 0xb1: '\u2013', 0xb2: '\u2020',
  0xb3: '\u2021', 0xb4: '\u00b7', 0xb6: '\u00b6', 0xb7: '\u2022', 0xb8: '\u201a', 0xb9: '\u201e', 0xba: '\u201d', 0xbb: '\u00bb', 0xbc: '\u2026',
  0xbd: '\u2030', 0xbf: '\u00bf', 0xc1: '`', 0xc2: '\u00b4', 0xc3: '\u02c6', 0xc4: '\u02dc', 0xc5: '\u00af', 0xc8: '\u00a8', 0xd0: '\u2014',
  0xe1: '\u00c6', 0xe3: '\u00aa', 0xe8: '\u0141', 0xe9: '\u00d8', 0xea: '\u0152', 0xeb: '\u00ba', 0xf1: '\u00e6', 0xf5: '\u0131', 0xf8: '\u0142',
  0xf9: '\u00f8', 0xfa: '\u0153', 0xfb: '\u00df',
};

const byteTables = new Map();
function byteTable(encoding) {
  if (!byteTables.has(encoding)) {
    const bytes = Buffer.from(Array.from({ length: 256 }, (x, i) => i));
    const table = Array.from(new TextDecoder(encoding).decode(bytes));
    if (encoding === 'standard') throw new Error('unreachable');
    byteTables.set(encoding, table);
  }
  return byteTables.get(encoding);
}

function standardTable() {
  if (!byteTables.has('standard')) {
    const table = byteTable('windows-1252').map((ch, i) => (i >= 0x80 ? '' : ch));
    for (const [code, ch] of Object.entries(STANDARD_HIGH)) table[Number(code)] = ch;
    byteTables.set('standard', table);
  }
  return byteTables.get('standard');
}

// 没有嵌入宽度表的标准字体：按 Helvetica / Times 的宽度估算（ASCII 32～126）
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const TIMES = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541];

const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const TIMES_BOLD = [250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520];

function standardWidths(base) {
  const bold = /Bold|Black|Heavy/i.test(base);
  if (/Times|Serif|Roman|Georgia|Garamond|Palatino/i.test(base)) return bold ? TIMES_BOLD : TIMES;
  return bold ? HELVETICA_BOLD : HELVETICA;
}

// 旧式的中日韩编码（字体没有嵌入、也没有 ToUnicode 的老 PDF）
const LEGACY_CMAPS = [
  [/^Uni.*-(UCS2|UTF16)-/, 'utf-16be'],
  [/^Uni.*-UTF8-/, 'utf-8'],
  [/^(GBK|GBpc|GB|GBKp|GBK2K|GBT)-?(EUC)?-/, 'gb18030'],
  [/^(B5pc|ETen|ETenms|HKscs|HKdla|HKdlb|HKgccs|HKm314|HKm471|CNS-EUC)/, 'big5'],
  [/^(90ms|90msp|90pv|83pv|Add|Ext)-RKSJ-/, 'shift_jis'],
  [/^EUC-[HV]$/, 'euc-jp'],
  [/^(KSCms-UHC|KSC-EUC|KSCpc-EUC|KSCms-UHC-HW)/, 'euc-kr'],
];

class Font {
  constructor(pdf, dict) {
    this.pdf = pdf;
    this.widthScale = 0.001;
    this.composite = dict.Subtype === '/Type0';
    this.cmap = null; // ToUnicode
    this.decoder = null; // 旧式中日韩编码
    this.table = null; // 单字节字体：256 个位置各是什么字
    this.widths = null;
    this.firstChar = 0;
    this.defaultWidth = 500;
    this.cidWidths = null;
    this.identity = false;

    const tu = pdf.entry(dict.ToUnicode);
    if (tu) {
      // 同一张对照表常常被好几个字体共用，解析一次就够了
      let cmap = pdf.cmaps.get(tu);
      if (cmap === undefined) {
        const text = pdf.streamText(dict.ToUnicode);
        cmap = text ? parseCMap(text, pdf) : null;
        pdf.cmaps.set(tu, cmap);
      }
      if (cmap && cmap.size) this.cmap = cmap;
    }

    if (this.composite) {
      const enc = pdf.resolve(dict.Encoding);
      const encName = isName(enc) ? enc.slice(1) : '';
      this.identity = /^Identity-[HV]$/.test(encName);
      if (!this.cmap) {
        const legacy = LEGACY_CMAPS.find(([re]) => re.test(encName));
        if (legacy) this.decoder = new TextDecoder(legacy[1]);
      }
      const kids = pdf.resolve(dict.DescendantFonts);
      const cid = pdf.resolve(Array.isArray(kids) ? kids[0] : kids);
      this.defaultWidth = 1000;
      if (isDict(cid)) {
        this.defaultWidth = num(pdf.resolve(cid.DW), 1000);
        const w = pdf.resolve(cid.W);
        if (Array.isArray(w) && this.identity) this.cidWidths = parseCidWidths(pdf, w);
      }
      return;
    }

    // 单字节字体
    const base = isName(dict.BaseFont) ? dict.BaseFont : '';
    let enc = pdf.resolve(dict.Encoding);
    let baseEnc = isName(enc) ? enc : '';
    let diffs = null;
    if (isDict(enc)) {
      baseEnc = isName(pdf.resolve(enc.BaseEncoding)) ? pdf.resolve(enc.BaseEncoding) : '';
      diffs = pdf.resolve(enc.Differences);
    }
    let table;
    if (baseEnc === '/WinAnsiEncoding') table = byteTable('windows-1252');
    else if (baseEnc === '/MacRomanEncoding') table = byteTable('macintosh');
    else if (baseEnc === '/StandardEncoding') table = standardTable();
    else table = (this.cmap ? null : builtinEncoding(pdf, dict)) || (dict.Subtype === '/Type1' && !/Symbol|Dingbats/i.test(base) ? standardTable() : byteTable('windows-1252'));
    if (Array.isArray(diffs)) {
      table = table.slice();
      let code = 0;
      for (const item of diffs) {
        if (pdf.busy()) break;
        const v = pdf.resolve(item);
        if (typeof v === 'number') code = v;
        else if (isName(v)) {
          if (code >= 0 && code < 256) table[code] = glyphChar(v.slice(1));
          code++;
        }
      }
    }
    this.table = table;

    const widths = pdf.resolve(dict.Widths);
    if (Array.isArray(widths)) {
      this.widths = widths.map((w) => num(pdf.resolve(w), -1));
      this.firstChar = num(pdf.resolve(dict.FirstChar), 0);
      const desc = pdf.resolve(dict.FontDescriptor);
      this.defaultWidth = isDict(desc) ? num(pdf.resolve(desc.MissingWidth), 0) : 0;
    } else if (/Courier/i.test(base)) this.defaultWidth = 600;
    else {
      this.widths = standardWidths(base);
      this.firstChar = 32;
      this.defaultWidth = 556;
    }
    if (dict.Subtype === '/Type3') {
      const fm = pdf.resolve(dict.FontMatrix);
      if (Array.isArray(fm) && num(fm[0]) > 0) this.widthScale = num(fm[0]);
    }
  }

  // 一个字符串 → { text, w: 总宽度（以字号为单位）, n: 字符数, sp: 单字节空格的个数 }
  // max：最多还要多少个字，够了就不往下解了。特别长的字符串解到一半也会看时间
  decode(str, max = Infinity) {
    const pdf = this.pdf;
    let text = '';
    let w = 0;
    let n = 0;
    let sp = 0;
    let unknown = 0;
    const len = str.length;
    if (!this.composite) {
      for (let i = 0; i < len && text.length < max; i++) {
        if ((i & 8191) === 8191 && pdf.late()) break;
        const code = str.charCodeAt(i);
        let ch = this.cmap ? this.cmap.get(1, code) : undefined;
        if (ch === undefined) ch = this.table[code] || '';
        if (!ch || ch === '\uffff' || ch === '\ufffd') unknown++;
        text += ch;
        let cw = this.widths ? this.widths[code - this.firstChar] : undefined;
        if (cw === undefined || cw < 0) cw = this.defaultWidth;
        w += cw;
        n++;
        if (code === 32) sp++;
      }
      return { text, w: w * this.widthScale, n, sp, unknown };
    }
    if (this.cmap) {
      const cmap = this.cmap;
      const lens = cmap.lens;
      const fallback = lens.includes(2) || !lens.length ? 2 : lens[0];
      for (let i = 0; i < len && text.length < max; ) {
        if ((n & 8191) === 8191 && pdf.late()) break;
        let used = 0;
        let code = 0;
        let mapped;
        for (const l of lens) {
          if (i + l > len) continue;
          let c = 0;
          for (let k = 0; k < l; k++) c = c * 256 + str.charCodeAt(i + k);
          const hit = cmap.get(l, c);
          if (hit !== undefined) {
            mapped = hit;
            used = l;
            code = c;
            break;
          }
        }
        if (!used) {
          used = Math.min(fallback, len - i);
          for (let k = 0; k < used; k++) code = code * 256 + str.charCodeAt(i + k);
        }
        if (mapped !== undefined && mapped !== '\uffff' && mapped !== '\ufffd') text += mapped;
        else unknown++;
        w += this.cidWidth(code);
        n++;
        i += used;
      }
      return { text, w: w / 1000, n, sp, unknown };
    }
    if (this.decoder) {
      // 这些编码一个字最多 4 个字节
      text = this.decoder.decode(Buffer.from(str.length > max * 4 ? str.slice(0, max * 4) : str, 'latin1'));
      for (const ch of text) {
        w += ch.charCodeAt(0) < 128 ? 500 : this.defaultWidth;
        n++;
      }
      return { text, w: w / 1000, n, sp, unknown: (text.match(/\ufffd/g) || []).length };
    }
    // Identity 编码又没有 ToUnicode：不知道每个编号是什么字，只能算出宽度
    for (let i = 0; i + 1 < len; i += 2) {
      if ((n & 8191) === 8191 && pdf.late()) break;
      w += this.cidWidth(str.charCodeAt(i) * 256 + str.charCodeAt(i + 1));
      n++;
    }
    return { text: '', w: w / 1000, n, sp, unknown: n };
  }

  cidWidth(cid) {
    const cw = this.cidWidths;
    if (cw) {
      const w = cw.map.get(cid);
      if (w !== undefined) return w;
      const r = cw.ranges.length ? findRange(cw.ranges, cid) : null;
      if (r) return r.w;
    }
    return this.defaultWidth;
  }
}

// 嵌入的 Type1 字体自带的编码（写在字体程序开头的明文部分）。LaTeX 的数学字体靠它才知道每个编号是什么符号。
function builtinEncoding(pdf, dict) {
  const desc = pdf.resolve(dict.FontDescriptor);
  const entry = isDict(desc) ? pdf.entry(desc.FontFile) : null;
  if (!entry) return null;
  const bytes = pdf.streamBytes(entry);
  if (!bytes || !bytes.length) return null;
  const clear = num(pdf.resolve(entry.v.Length1), 8192);
  const head = bytes.subarray(0, Math.max(0, Math.min(clear, 65536))).toString('latin1');
  if (/\/Encoding\s+StandardEncoding\s+def/.test(head)) return standardTable();
  const table = new Array(256).fill('');
  let found = 0;
  for (const m of head.matchAll(/dup\s+(\d+)\s*\/([^\s/]+)\s+put/g)) {
    const code = Number(m[1]);
    if (code < 256) {
      table[code] = glyphChar(m[2]);
      found++;
    }
  }
  return found ? table : null;
}

// CID 字体的宽度表：[ c [w1 w2 …] ]（从 c 起挨个给出宽度）或 [ c1 c2 w ]（c1～c2 都是 w）。
// 第二种是一个区间，只记头尾，不一个个展开。返回 { map: 编号 → 宽度, ranges: [{ from, to, w }] }
function parseCidWidths(pdf, arr) {
  const map = new Map();
  const ranges = [];
  let work = 0;
  for (let i = 0; i < arr.length && work < MAX_MAP_WORK && pdf.room.left >= 0 && !pdf.busy(); ) {
    const first = pdf.resolve(arr[i]);
    const second = pdf.resolve(arr[i + 1]);
    if (typeof first !== 'number') break;
    if (Array.isArray(second)) {
      for (let k = 0; k < second.length && work < MAX_MAP_WORK; k++, work++) map.set(first + k, num(pdf.resolve(second[k]), 1000));
      pdf.room.left -= second.length * COST_MAPPING;
      i += 2;
    } else if (typeof second === 'number') {
      ranges.push({ from: first, to: second, w: num(pdf.resolve(arr[i + 2]), 1000) });
      pdf.room.left -= COST_MAPPING;
      work++;
      i += 3;
    } else break;
  }
  ranges.sort((x, y) => x.from - y.from);
  return { map, ranges };
}

// 内容流里前后都是空白的关键字（内嵌图片结尾的 EI）：从 pos 往后找，返回它的位置，没有返回 -1。
// atEnd：正好在末尾、后面没有空白的也算
function findKeyword(data, word, pos, atEnd) {
  for (let at = data.indexOf(word, pos); at >= 0; at = data.indexOf(word, at + 1)) {
    if (at === 0 || !isWs(data.charCodeAt(at - 1))) continue;
    const after = at + word.length;
    if (after >= data.length ? atEnd : isWs(data.charCodeAt(after))) return at;
  }
  return -1;
}

// ---------- 内容流：文字指令 ----------

const IDENTITY = [1, 0, 0, 1, 0, 0];
// 矩阵相乘：先做 a，再做 b
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

// 两段文字之间的空隙超过字号的这个比例，就算一个空格（很多 PDF 里的空格不是字符，只是一段空隙）
const SPACE_GAP = 0.11;
// 超过这个比例算一个制表符（表格的列）
const TAB_GAP = 1.5;

// 字间距被整体拉大的一行（比如加宽的标题、两端对齐的中文）：每个字之间都有空隙，
// 这时要比平常的字间距明显更大才算空格。返回空格判断标准要放大的倍数。
function spreadFactor(chunks) {
  if (chunks.length < 6) return 1;
  const gaps = [];
  let chars = 0;
  for (let i = 0; i < chunks.length; i++) {
    chars += chunks[i].text.length;
    if (i) gaps.push((chunks[i].pos - chunks[i - 1].end) / (Math.max(chunks[i].fs, chunks[i - 1].fs) || 1));
  }
  if (chars / chunks.length > 1.5) return 1;
  const wide = gaps.filter((g) => g > SPACE_GAP).length;
  if (wide < gaps.length * 0.7) return 1;
  const median = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
  return median < 0.8 ? Math.max(1, (median * 1.6) / SPACE_GAP) : 1;
}

class PageText {
  constructor(pdf, fonts, limit) {
    this.pdf = pdf;
    this.fonts = fonts; // 对象号 → Font（整份文档共用）
    this.limit = limit;
    this.cut = false; // 字数够了或者时间用完了，这一页没有看完
    this.parts = [];
    this.size = 0;
    this.pending = 0; // 正在拼的这一行已经有多少字
    this.line = null; // 正在拼的这一行：{ ux, uy, perp, fs, chunks }
    this.prevLine = null;
    this.shown = 0; // 遇到的字符总数
    this.unknown = 0; // 其中认不出来的
    this.marks = 0; // 遇到了多少次“显示文字”和“画表单”的指令（用来判断一个表单里有没有文字）
  }

  font(resources, name) {
    const res = this.pdf.resolve(resources);
    const dict = isDict(res) ? this.pdf.resolve(res.Font) : null;
    const ref = isDict(dict) ? dict[name.slice(1)] : undefined;
    if (ref === undefined) return null;
    // 记住解析过的字体。钥匙：引用的话是对象号；字体直接写在资源字典里的话，就是那个字典本身
    const key = ref && typeof ref === 'object' && ref.ref !== undefined ? ref.ref : isDict(ref) ? ref : null;
    if (key !== null && this.fonts.has(key)) return this.fonts.get(key);
    if (this.pdf.late()) return null;
    const fd = this.pdf.resolve(ref);
    let font = null;
    try {
      font = isDict(fd) ? new Font(this.pdf, fd) : null;
    } catch {
      font = null;
    }
    if (key !== null) this.fonts.set(key, font);
    return font;
  }

  // 一段文字从 (x, y) 画到 (ex, ey)；ux/uy 是书写方向，fs 是字号（都已换算到页面坐标）。
  // 同一行的文字先攒起来，换行时再按位置排好顺序：有些软件（比如 LibreOffice）不按从左到右的顺序画字。
  emit(text, x, y, ex, ey, ux, uy, fs) {
    const perp = y * ux - x * uy;
    const line = this.line;
    if (line && (ux * line.ux + uy * line.uy < 0.95 || Math.abs(perp - line.perp) > Math.max(fs, line.fs) * 0.55)) this.flushLine();
    if (!this.line) this.line = { ux, uy, perp, fs, chunks: [] };
    else if (fs > this.line.fs) this.line.fs = fs;
    if (text) {
      this.line.chunks.push({ text, pos: x * ux + y * uy, end: ex * ux + ey * uy, fs, i: this.line.chunks.length });
      this.pending += text.length;
    }
  }

  flushLine() {
    const line = this.line;
    this.line = null;
    this.pending = 0;
    if (!line || !line.chunks.length) return;
    const chunks = line.chunks.sort((a, b) => a.pos - b.pos || a.i - b.i);
    const spaceGap = SPACE_GAP * spreadFactor(chunks);
    let text = '';
    let prev = null;
    let end = 0;
    for (const c of chunks) {
      if (prev) {
        const size = Math.max(c.fs, prev.fs) || 1;
        // 模拟加粗：同一段字在几乎同一个位置画了两遍，只留一遍
        if (c.text === prev.text && Math.abs(c.pos - prev.pos) < size * 0.1) continue;
        const gap = c.pos - end;
        if (gap > size * spaceGap && !isSpaceAt(text, text.length - 1) && !isSpaceAt(c.text, 0)) text += gap > size * Math.max(TAB_GAP, spaceGap) ? '\t' : ' ';
      }
      text += c.text;
      end = prev ? Math.max(end, c.end) : c.end;
      prev = c;
    }
    const before = this.prevLine;
    if (this.size) {
      // 行距明显变大：多空一行，表示换了一段
      const far = before && before.ux * line.ux + before.uy * line.uy > 0.95 && Math.abs(line.perp - before.perp) > Math.max(line.fs, before.fs) * 2.5;
      this.parts.push(far ? '\n\n' : '\n');
      this.size += 1;
    }
    this.parts.push(text);
    this.size += text.length;
    this.prevLine = line;
  }

  run(data, resources, ctm, depth) {
    const room = { left: TOKEN_ROOM };
    const lex = new Lexer(data, 0, false, room);
    const stack = [];
    let args = [];
    let st = { ctm, font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0 };
    let tm = IDENTITY;
    let tlm = IDENTITY;

    const show = (str) => {
      this.marks++;
      if (typeof str !== 'string' || !str) return;
      const want = this.limit - this.size - this.pending; // 还要多少个字。已经够了就不解了，外面的循环马上会停
      if (want <= 0) return;
      this.pdf.work(str.length >> 5);
      const d = st.font ? st.font.decode(str, want) : { text: '', w: str.length * 0.5, n: str.length, sp: 0, unknown: str.length };
      this.shown += d.n;
      this.unknown += d.unknown || 0;
      const m = mul(tm, st.ctm);
      const adv = (d.w * st.size + d.n * st.tc + d.sp * st.tw) * st.th;
      const ex = m[4] + adv * m[0];
      const ey = m[5] + adv * m[1];
      const hx = Math.hypot(m[0], m[1]) || 1;
      const fs = Math.abs(st.size) * (Math.hypot(m[2], m[3]) || hx);
      this.emit(d.text, m[4], m[5], ex, ey, m[0] / hx, m[1] / hx, fs);
      tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + adv * tm[0], tm[5] + adv * tm[1]];
    };
    const moveLine = (tx, ty) => {
      tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };

    for (;;) {
      room.left = TOKEN_ROOM;
      const tok = lex.read();
      if (tok === END) break;
      // 字数够了、时间用完了，或者这一个数组（字符串）大得不正常：后面的内容不看了
      if (this.size + this.pending >= this.limit || room.left < 0 || this.pdf.busy()) {
        this.cut = true;
        break;
      }
      if (tok === null || typeof tok !== 'object' || tok.op === undefined) {
        if (args.length < 64) args.push(tok);
        continue;
      }
      const a = args;
      args = [];
      switch (tok.op) {
        case 'BT':
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case 'Tf':
          if (isName(a[0])) st.font = this.font(resources, a[0]);
          st.size = num(a[1]);
          break;
        case 'Tc':
          st.tc = num(a[0]);
          break;
        case 'Tw':
          st.tw = num(a[0]);
          break;
        case 'Tz':
          st.th = num(a[0], 100) / 100;
          break;
        case 'TL':
          st.tl = num(a[0]);
          break;
        case 'Td':
          moveLine(num(a[0]), num(a[1]));
          break;
        case 'TD':
          st.tl = -num(a[1]);
          moveLine(num(a[0]), num(a[1]));
          break;
        case 'Tm':
          if (a.length >= 6) {
            tlm = a.slice(0, 6).map((v) => num(v));
            tm = tlm;
          }
          break;
        case 'T*':
          moveLine(0, -st.tl);
          break;
        case 'Tj':
          if (a[0] && a[0].s !== undefined) show(a[0].s);
          break;
        case "'":
          moveLine(0, -st.tl);
          if (a[0] && a[0].s !== undefined) show(a[0].s);
          break;
        case '"':
          st.tw = num(a[0]);
          st.tc = num(a[1]);
          moveLine(0, -st.tl);
          if (a[2] && a[2].s !== undefined) show(a[2].s);
          break;
        case 'TJ':
          if (Array.isArray(a[0])) {
            for (const item of a[0]) {
              if (typeof item === 'number') {
                const shift = (-item / 1000) * st.size * st.th;
                tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + shift * tm[0], tm[5] + shift * tm[1]];
              } else if (item && item.s !== undefined) show(item.s);
            }
          }
          break;
        case 'q':
          if (stack.length < 200) stack.push({ ...st });
          break;
        case 'Q':
          if (stack.length) st = stack.pop();
          break;
        case 'cm':
          if (a.length >= 6) st.ctm = mul(a.slice(0, 6).map((v) => num(v)), st.ctm);
          break;
        case 'Do':
          this.marks++;
          if (isName(a[0]) && depth < 6) this.form(resources, a[0], st.ctm, depth);
          break;
        case 'BI': {
          // 内嵌图片（BI 属性 ID 数据 EI）：直接跳到后面第一个 EI。属性里不会有单独的 EI，所以不用先找 ID；
          // 每次只往后找到最近的一个，找过的地方就跳过去了，很多个 BI 也只是把内容扫一遍
          const ei = findKeyword(data, 'EI', lex.pos + 1, true);
          lex.pos = ei < 0 ? data.length : ei + 2;
          this.pdf.work(8);
          break;
        }
        default:
      }
    }
  }

  // 表单对象（一段可以重复使用的内容），里面也可能有文字
  form(resources, name, ctm, depth) {
    const res = this.pdf.resolve(resources);
    const xobjects = isDict(res) ? this.pdf.resolve(res.XObject) : null;
    const ref = isDict(xobjects) ? xobjects[name.slice(1)] : undefined;
    const pdf = this.pdf;
    const entry = pdf.entry(ref);
    if (!entry || !isDict(entry.v) || entry.v.Subtype !== '/Form') return;
    if (pdf.plainForms.has(entry)) return; // 上次看过了，里面没有文字
    if (++pdf.forms > MAX_FORMS) {
      this.cut = true;
      return;
    }
    let data = pdf.formCache.get(entry);
    if (data === undefined) {
      const bytes = pdf.streamBytes(entry);
      data = bytes ? bytes.toString('latin1') : '';
      // 同一个表单（页眉、图标之类）常常每页都用：小的留着，下次不用再解码
      if (data.length <= 262144 && pdf.formCacheBytes + data.length <= FORM_CACHE_BYTES) {
        pdf.formCache.set(entry, data);
        pdf.formCacheBytes += data.length;
      }
    }
    if (!data) return;
    const matrix = pdf.resolve(entry.v.Matrix);
    const inner = Array.isArray(matrix) && matrix.length >= 6 ? mul(matrix.slice(0, 6).map((v) => num(v)), ctm) : ctm;
    const marks = this.marks;
    this.run(data, entry.v.Resources !== undefined ? entry.v.Resources : resources, inner, depth + 1);
    // 从头到尾看完了，里面既没有文字也没有别的表单（比如每一页都贴的矢量底图、图标）：记下来，以后遇到直接跳过
    if (this.marks === marks && !this.cut && !pdf.timedOut) pdf.plainForms.add(entry);
  }

  toString() {
    this.flushLine();
    return this.parts.join('');
  }
}

function cleanText(text) {
  return text
    .replace(/[\u2e80-\u2fdf\uf900-\ufaff\ufb00-\ufb06]/g, (c) => c.normalize('NFKC')) // 康熙部首、连字等“长得一样”的字换回普通的字
    .replace(/\uf0b7/g, '\u2022') // Word 的项目符号（Symbol 字体）
    .replace(/\uf0a7/g, '\u25aa')
    .replace(/\u00ad/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\ufffd\ufeff\ufffe\uffff]/g, '')
    .replace(/(?<![ \t])[ \t]+\n/g, '\n') // (?<!…)：只从一串空白的开头试一次，不然一长串空格会慢得像卡死
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 返回 { text, pages, objects, encrypted, truncated, coverage }
// objects：文件里找到了多少个 PDF 对象（一个都没有的话，多半根本不是 PDF）
// coverage：有多少比例的字符认出来了（0～1）；扫描件没有字符，coverage 是 0
function pdfText(buf, { maxChars = 400000, maxPages = 2000, maxMs = 8000 } = {}) {
  const pdf = new Pdf(buf, Date.now() + maxMs);
  if (pdf.encrypted) return { text: '', pages: 0, objects: pdf.objs.size, encrypted: true, truncated: false, coverage: 0 };
  const pages = pdf.pages(maxPages);
  const fonts = new Map();
  const out = [];
  let size = 0;
  let shown = 0;
  let unknown = 0;
  let truncated = false;
  for (let i = 0; i < pages.length; i++) {
    if (size >= maxChars || pdf.late()) {
      truncated = true;
      break;
    }
    const { node, resources } = pages[i];
    const page = new PageText(pdf, fonts, maxChars - size);
    try {
      const contents = pdf.resolve(node.Contents);
      const refs = Array.isArray(contents) ? contents : [node.Contents];
      // 一页的内容可以分成好几段。加起来太大（比如同一个大流被引用了很多遍）就不再往下接
      const parts = [];
      let bytes = 0;
      for (const r of refs) {
        if (bytes >= MAX_STREAM_BYTES) {
          truncated = true;
          break;
        }
        const part = pdf.streamText(r);
        parts.push(part);
        bytes += part.length;
      }
      const data = parts.join('\n');
      if (data) page.run(data, resources, IDENTITY, 0);
    } catch {
      /* 这一页解析不了，跳过 */
    }
    shown += page.shown;
    unknown += page.unknown;
    if (page.cut) truncated = true;
    const text = cleanText(page.toString());
    if (text) {
      out.push(pages.length > 1 ? `--- ${i + 1} ---\n${text}` : text);
      size += text.length;
    }
  }
  let text = out.join('\n\n');
  if (text.length > maxChars) {
    // 最后一行可能超出一点：截到正好不超过上限（不把表情符号这样占两个位置的字切成两半）
    const high = text.charCodeAt(maxChars - 1);
    text = text.slice(0, high >= 0xd800 && high <= 0xdbff ? maxChars - 1 : maxChars).trimEnd();
    truncated = true;
  }
  if (pdf.timedOut || pdf.morePages || pdf.skipped || pdf.room.left < 0 || pdf.index.left < 0) truncated = true;
  return { text, pages: pages.length, objects: pdf.objs.size, encrypted: false, truncated, coverage: shown ? (shown - unknown) / shown : 0 };
}

module.exports = { pdfText };
