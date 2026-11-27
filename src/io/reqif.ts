// ReqIF 1.2 (OMG) exchange of formal modules and the links between them.
//
// Each module is one SPECIFICATION with its own object type; each link module one
// relation type. The standard attributes travel under the names DOORS uses
// (ReqIF.ChapterName, ReqIF.Text, ...). Baselines, views, history and deleted
// objects are not exchanged.
//
// There are no files in the browser: export_reqif returns the text and
// import_reqif takes the bytes (.reqif or .reqifz) or the text. A file may come
// from anywhere, so reading one is bounded in size, element count and depth,
// declares no entities, and never recurses on the shape of the input.

import {
  BOOLEAN_VALUES, StoreError, SYSTEM_ATTRIBUTES, _SPACE, _repr, _strip, parse_date,
} from "../store.ts";
import type { AttrDef, Obj, Store } from "../store.ts";
import { ensure_folder } from "./project.ts";

export const NS = "http://www.omg.org/spec/ReqIF/20110401/reqif.xsd";
export const XHTML = "http://www.w3.org/1999/xhtml";
export const MAX_BYTES = 200 * 1024 * 1024; // a file, or what a .reqifz unpacks to, may not be larger
export const MAX_DEPTH = 4000; // XML elements inside one another
export const MAX_ELEMENTS = 5_000_000;
export const MAX_LEVELS = 1000; // object levels in one specification
export const MAX_ENUM_VALUES = 10_000; // in one enumeration
export const MAX_STRING = 32000; // MAX-LENGTH of a string datatype, unless a value is longer

// DOORS name in ReqIF -> name here
const NAMES: ReadonlyMap<string, string> = new Map([
  ["ReqIF.ChapterName", "Object Heading"], ["ReqIF.Text", "Object Text"],
  ["ReqIF.Name", "Object Short Text"], ["ReqIF.ForeignID", "Foreign ID"]]);
const EXPORT_NAMES: ReadonlyMap<string, string> = new Map([...NAMES].map(([there, here]) => [here, there]));
const KINDS: readonly string[] = ["STRING", "XHTML", "INTEGER", "REAL", "DATE", "BOOLEAN", "ENUMERATION"];
const BASE_OF: Readonly<Record<string, string>> = {
  STRING: "String", XHTML: "Text", INTEGER: "Integer", REAL: "Real", DATE: "Date" };
// What XML 1.0 cannot hold.
const ILLEGAL = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const ILLEGAL_ALL = new RegExp(ILLEGAL.source, "gu");

function _clean(text: string): string {
  return text.replace(ILLEGAL_ALL, "\uFFFD");
}

function _q(tag: string): string {
  return `{${NS}}${tag}`;
}

// A file that cannot be read as what it claims to be.
class _BadFile extends Error {}

// =========================================================================
// XML
// =========================================================================

// Names are "{namespace}local" after parsing, and written as they stand.
class _Element {
  tag: string;
  attrib: Map<string, string>;
  text: string; // before the first child
  tail: string; // after the end tag, inside the parent
  children: _Element[];

  constructor(tag: string, attrib: Map<string, string> = new Map()) {
    this.tag = tag;
    this.attrib = attrib;
    this.text = "";
    this.tail = "";
    this.children = [];
  }

  get(name: string): string | null {
    return this.attrib.get(name) ?? null;
  }

  // The first child with this tag.
  find(tag: string): _Element | null {
    return this.children.find((c) => c.tag === tag) ?? null;
  }

  // This element and everything below it with this tag, in document order.
  *iter(tag: string): Generator<_Element> {
    const stack: _Element[] = [this];
    while (stack.length) {
      const element = stack.pop()!;
      if (element.tag === tag) yield element;
      for (let i = element.children.length - 1; i >= 0; i--) stack.push(element.children[i]);
    }
  }
}

function _latin1(data: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += 0x8000) parts.push(String.fromCharCode(...data.subarray(i, i + 0x8000)));
  return parts.join("");
}

// The characters of an XML document, by its byte-order mark or declaration.
function _decode(data: Uint8Array): string {
  let encoding = "", start = 0;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) [encoding, start] = ["utf-8", 3];
  else if (data[0] === 0xff && data[1] === 0xfe) [encoding, start] = ["utf-16le", 2];
  else if (data[0] === 0xfe && data[1] === 0xff) [encoding, start] = ["utf-16be", 2];
  else if (data[0] === 0x3c && data[1] === 0) encoding = "utf-16le";
  else if (data[0] === 0 && data[1] === 0x3c) encoding = "utf-16be";
  else {
    const declared = /^<\?xml\s[^>]*?\sencoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/
      .exec(_latin1(data.subarray(0, 200)));
    encoding = declared ? declared[1].toLowerCase() : "utf-8";
    if (encoding.startsWith("utf-16")) throw new _BadFile("the declared encoding does not match the bytes");
  }
  let body = data.subarray(start);
  if (encoding === "iso-8859-1" || encoding === "latin-1" || encoding === "latin1") return _latin1(body);
  if (encoding === "us-ascii" || encoding === "ascii") {
    if (body.some((b) => b > 0x7f)) throw new _BadFile("a byte outside US-ASCII");
    return _latin1(body);
  }
  if (encoding === "utf-16be") {
    if (body.length % 2) throw new _BadFile("half a UTF-16 character");
    const swapped = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    [body, encoding] = [swapped, "utf-16le"];
  }
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new _BadFile(`the bytes cannot be read as ${encoding}`);
  }
}

const _ENTITIES: ReadonlyMap<string, string> = new Map([
  ["lt", "<"], ["gt", ">"], ["amp", "&"], ["apos", "'"], ["quot", '"']]);

type _Scope = Record<string, string>; // prefix -> namespace; inner scopes inherit by prototype

// A well-formed document without a DTD, as a tree. `budget` counts down the
// elements still allowed.
function _parse_xml(source: Uint8Array | string, budget: { elements: number }): _Element {
  let text = typeof source === "string" ? source.replace(/^\uFEFF/, "") : _decode(source);
  text = text.replace(/\r\n?/g, "\n");
  const end = text.length;
  let at = 0;

  const fail = (message: string, where: number = at): never => {
    let line = 1, from = 0;
    for (let i = text.indexOf("\n"); i >= 0 && i < where; i = text.indexOf("\n", i + 1)) {
      line += 1;
      from = i + 1;
    }
    throw new _BadFile(`${message}: line ${line}, column ${where - from + 1}`);
  };
  const illegal = ILLEGAL.exec(text);
  if (illegal) fail("a character XML does not allow", illegal.index);

  const references = (raw: string, where: number): string => {
    if (!raw.includes("&")) return raw;
    return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][A-Za-z0-9._-]*)?(;)?/g, (_, name, semicolon) => {
      if (name === undefined || semicolon === undefined) return fail("not a reference: '&'", where);
      if (name[0] !== "#") return _ENTITIES.get(name) ?? fail(`undefined entity &${name};`, where);
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (code > 0x10ffff || ILLEGAL.test(String.fromCodePoint(code))) {
        return fail("a reference to a character XML does not allow", where);
      }
      return String.fromCodePoint(code);
    });
  };

  const stack: { element: _Element; name: string; scope: _Scope }[] = [];
  let root: _Element | null = null;
  const top_scope: _Scope = Object.create(null);
  top_scope.xml = "http://www.w3.org/XML/1998/namespace";

  const characters = (chunk: string) => {
    const element = stack[stack.length - 1].element;
    const last = element.children[element.children.length - 1];
    if (last) last.tail += chunk;
    else element.text += chunk;
  };

  const NAME = /[^ \t\n<>\/="'&;?!]+/y;
  const name = (): string => {
    NAME.lastIndex = at;
    const found = NAME.exec(text);
    if (!found || /^[0-9.\-]/.test(found[0])) fail("not well-formed (a name was expected)");
    at = NAME.lastIndex;
    return found![0];
  };
  const space = (): boolean => {
    const before = at;
    while (text[at] === " " || text[at] === "\n" || text[at] === "\t") at++;
    return at > before;
  };
  const past = (mark: string, from: number, what: string): string => {
    const found = text.indexOf(mark, from);
    if (found < 0) fail(`unclosed ${what}`);
    at = found + mark.length;
    return text.slice(from, found);
  };

  const qualified = (raw: string, scope: _Scope, is_attribute: boolean): string => {
    const colon = raw.indexOf(":");
    if (colon < 0) return !is_attribute && scope[""] ? `{${scope[""]}}${raw}` : raw;
    const prefix = raw.slice(0, colon), local = raw.slice(colon + 1);
    if (!prefix || !local || local.includes(":")) fail(`not a usable name: ${raw}`);
    if (scope[prefix] === undefined) fail(`unbound namespace prefix ${prefix}`);
    return `{${scope[prefix]}}${local}`;
  };

  const start_tag = () => {
    at += 1;
    const raw = name();
    const given = new Map<string, string>();
    let closed = false;
    for (;;) {
      const separated = space();
      if (text[at] === ">") {
        at += 1;
        break;
      }
      if (text.startsWith("/>", at)) {
        at += 2;
        closed = true;
        break;
      }
      if (!separated) fail("not well-formed (in a start tag)");
      const attribute = name();
      space();
      if (text[at] !== "=") fail("an attribute without a value");
      at += 1;
      space();
      const quote = text[at];
      if (quote !== '"' && quote !== "'") fail("an attribute value without quotes");
      const where = at;
      const value = past(quote, at + 1, "attribute value");
      if (value.includes("<")) fail("'<' in an attribute value", where);
      if (given.has(attribute)) fail(`attribute ${attribute} given twice`, where);
      given.set(attribute, references(value.replace(/[\t\n]/g, " "), where));
    }

    const outer = stack.length ? stack[stack.length - 1].scope : top_scope;
    let scope = outer;
    for (const [attribute, value] of given) {
      if (attribute !== "xmlns" && !attribute.startsWith("xmlns:")) continue;
      if (scope === outer) scope = Object.create(outer) as _Scope;
      scope[attribute.slice(6)] = value;
    }
    const attrib = new Map<string, string>();
    for (const [attribute, value] of given) {
      if (attribute === "xmlns" || attribute.startsWith("xmlns:")) continue;
      const full = qualified(attribute, scope, true);
      if (attrib.has(full)) fail(`attribute ${attribute} given twice`);
      attrib.set(full, value);
    }
    if (--budget.elements < 0) throw new StoreError("this XML holds too many elements to read");
    if (stack.length >= MAX_DEPTH) throw new StoreError("this XML is nested too deeply to read");
    const element = new _Element(qualified(raw, scope, false), attrib);
    if (stack.length) stack[stack.length - 1].element.children.push(element);
    else if (root) fail("a second top-level element");
    else root = element;
    if (!closed) stack.push({ element, name: raw, scope });
  };

  if (/^<\?xml[ \t\n]/.test(text)) past("?>", 5, "XML declaration");
  while (at < end) {
    if (text[at] !== "<") {
      const where = at;
      const next = text.indexOf("<", at);
      at = next < 0 ? end : next;
      const chunk = text.slice(where, at);
      if (!stack.length) {
        if (/[^ \t\n]/.test(chunk)) fail("text outside the top-level element", where);
        continue;
      }
      if (chunk.includes("]]>")) fail("']]>' in text", where);
      characters(references(chunk, where));
    } else if (text.startsWith("<!--", at)) {
      const comment = past("-->", at + 4, "comment");
      if (comment.includes("--") || comment.endsWith("-")) fail("'--' in a comment");
    } else if (text.startsWith("<![CDATA[", at)) {
      if (!stack.length) fail("CDATA outside the top-level element");
      characters(past("]]>", at + 9, "CDATA section"));
    } else if (text.startsWith("<!DOCTYPE", at) || text.startsWith("<!ENTITY", at)) {
      // Entity declarations are how XML bombs and file disclosure work.
      throw new StoreError("this XML declares a DTD or entities; ReqIF needs neither, so it is refused");
    } else if (text.startsWith("<!", at)) {
      fail("not well-formed");
    } else if (text.startsWith("<?", at)) {
      if (/^<\?xml(?=[ \t\n?])/i.test(text.slice(at, at + 6))) fail("an XML declaration that is not at the start");
      past("?>", at + 2, "processing instruction");
    } else if (text[at + 1] === "/") {
      const where = at;
      at += 2;
      const closing = name();
      space();
      if (text[at] !== ">") fail("not well-formed (in an end tag)");
      at += 1;
      if (stack.pop()?.name !== closing) fail(`mismatched end tag </${closing}>`, where);
    } else {
      start_tag();
    }
  }
  if (stack.length) fail(`the file ends inside <${stack[stack.length - 1].name}>`);
  if (!root) fail("no element found");
  return root!;
}

function _escape_text(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

const _ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\r": "&#13;", "\n": "&#10;", "\t": "&#09;" };

function _serialize(root: _Element): string {
  const out: string[] = ["<?xml version='1.0' encoding='utf-8'?>\n"];
  const stack: { element: _Element; next: number }[] = [];
  const open = (element: _Element) => {
    out.push("<" + element.tag);
    for (const [name, value] of element.attrib) {
      out.push(` ${name}="${value.replace(/[&<>"\r\n\t]/g, (c) => _ATTRIBUTE_ESCAPES[c])}"`);
    }
    if (element.text || element.children.length) {
      out.push(">", _escape_text(element.text));
      stack.push({ element, next: 0 });
    } else out.push(" />", _escape_text(element.tail));
  };
  open(root);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.next < frame.element.children.length) open(frame.element.children[frame.next++]);
    else {
      stack.pop();
      out.push(`</${frame.element.tag}>`, _escape_text(frame.element.tail));
    }
  }
  return out.join("");
}

// =========================================================================
// Zip (.reqifz) and DEFLATE
// =========================================================================

const _CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function _crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = _CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type _Huffman = { bits: number; table: Uint32Array }; // entry: symbol << 4 | code length

function _huffman(lengths: ArrayLike<number>): _Huffman {
  const count = new Array<number>(16).fill(0);
  let bits = 1;
  for (let i = 0; i < lengths.length; i++) {
    count[lengths[i]] += 1;
    if (lengths[i] > bits) bits = lengths[i];
  }
  let left = 1;
  for (let length = 1; length <= 15; length++) {
    left = left * 2 - count[length];
    if (left < 0) throw new _BadFile("damaged compressed data (too many codes)");
  }
  // Only a code with at most one symbol may leave patterns unused.
  if (left > 0 && lengths.length - count[0] > 0 && bits !== 1) {
    throw new _BadFile("damaged compressed data (incomplete code)");
  }
  const next = new Array<number>(16).fill(0);
  for (let length = 1, code = 0; length <= 15; length++) {
    code = (code + (length > 1 ? count[length - 1] : 0)) << 1;
    next[length] = code;
  }
  const table = new Uint32Array(1 << bits);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (!length) continue;
    let code = next[length]++, reversed = 0;
    for (let i = 0; i < length; i++, code >>= 1) reversed = (reversed << 1) | (code & 1);
    for (let at = reversed; at < table.length; at += 1 << length) table[at] = (symbol << 4) | length;
  }
  return { bits, table };
}

const _LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
                      131, 163, 195, 227, 258];
const _LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const _DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
                        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const _DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
                         13, 13];
const _CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
let _fixed: [_Huffman, _Huffman] | null = null;

// Raw DEFLATE (RFC 1951) to exactly `size` bytes; never writes more than that.
export function _inflate(input: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let written = 0, at = 0, buffer = 0, held = 0;

  const fill = (n: number) => {
    while (held < n && at < input.length) {
      buffer |= input[at++] << held;
      held += 8;
    }
  };
  const drop = (n: number) => {
    if (n > held) throw new _BadFile("the compressed data ends too soon");
    buffer >>>= n;
    held -= n;
  };
  const take = (n: number): number => {
    fill(n);
    const value = buffer & ((1 << n) - 1);
    drop(n);
    return value;
  };
  const symbol = (code: _Huffman): number => {
    fill(code.bits);
    const entry = code.table[buffer & ((1 << code.bits) - 1)];
    if (!(entry & 15)) throw new _BadFile("damaged compressed data (unknown code)");
    drop(entry & 15);
    return entry >>> 4;
  };
  const room = (n: number) => {
    if (written + n > size) throw new _BadFile("a member unpacks to more than the archive declares");
  };

  const dynamic = (): [_Huffman, _Huffman] => {
    const literals = take(5) + 257, distances = take(5) + 1, codes = take(4) + 4;
    const code_lengths = new Array<number>(19).fill(0);
    for (let i = 0; i < codes; i++) code_lengths[_CODE_ORDER[i]] = take(3);
    const code = _huffman(code_lengths);
    const lengths: number[] = [];
    while (lengths.length < literals + distances) {
      const s = symbol(code);
      if (s < 16) {
        lengths.push(s);
        continue;
      }
      if (s === 16 && !lengths.length) throw new _BadFile("damaged compressed data (nothing to repeat)");
      const value = s === 16 ? lengths[lengths.length - 1] : 0;
      let repeat = s === 16 ? 3 + take(2) : s === 17 ? 3 + take(3) : 11 + take(7);
      if (lengths.length + repeat > literals + distances) throw new _BadFile("damaged compressed data (code lengths)");
      while (repeat--) lengths.push(value);
    }
    if (!lengths[256]) throw new _BadFile("damaged compressed data (no end of block)");
    return [_huffman(lengths.slice(0, literals)), _huffman(lengths.slice(literals))];
  };

  for (let last = 0; !last;) {
    last = take(1);
    const type = take(2);
    if (type === 3) throw new _BadFile("damaged compressed data (block type)");
    if (type === 0) { // stored: back to a byte boundary
      at -= held >> 3;
      buffer = held = 0;
      const length = input[at] | (input[at + 1] << 8), check = input[at + 2] | (input[at + 3] << 8);
      if (at + 4 + length > input.length || (length ^ 0xffff) !== check) {
        throw new _BadFile("damaged compressed data (stored block)");
      }
      room(length);
      out.set(input.subarray(at + 4, at + 4 + length), written);
      written += length;
      at += 4 + length;
      continue;
    }
    if (type === 1) {
      _fixed ??= [
        _huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8))),
        _huffman(new Array<number>(32).fill(5))];
    }
    const [literal, distance] = type === 1 ? _fixed! : dynamic();
    for (;;) {
      const s = symbol(literal);
      if (s < 256) {
        room(1);
        out[written++] = s;
        continue;
      }
      if (s === 256) break;
      if (s > 285) throw new _BadFile("damaged compressed data (length)");
      const length = _LENGTH_BASE[s - 257] + take(_LENGTH_EXTRA[s - 257]);
      const d = symbol(distance);
      if (d > 29) throw new _BadFile("damaged compressed data (distance)");
      const back = _DISTANCE_BASE[d] + take(_DISTANCE_EXTRA[d]);
      if (back > written) throw new _BadFile("damaged compressed data (distance)");
      room(length);
      for (let i = 0; i < length; i++, written++) out[written] = out[written - back];
    }
  }
  if (written !== size) throw new _BadFile("a member unpacks to less than the archive declares");
  return out;
}

const _END = 0x06054b50, _CENTRAL = 0x02014b50, _LOCAL = 0x04034b50;
const _END64 = 0x06064b50, _LOCATOR64 = 0x07064b50;

// Where the end-of-central-directory record is, or -1: not a zip.
function _zip_end(data: Uint8Array): number {
  for (let at = data.length - 22; at >= 0 && at >= data.length - 22 - 0xffff; at--) {
    if (data[at] === 0x50 && data[at + 1] === 0x4b && data[at + 2] === 5 && data[at + 3] === 6) return at;
  }
  return -1;
}

type _Member = { name: string; flags: number; method: number; crc: number; packed: number; size: number;
                 offset: number };

function _zip_members(data: Uint8Array, end: number): _Member[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const inside = (at: number, length: number) => {
    if (at < 0 || at + length > data.length) throw new _BadFile("the zip archive is damaged");
    return at;
  };
  const u16 = (at: number) => view.getUint16(inside(at, 2), true);
  const u32 = (at: number) => view.getUint32(inside(at, 4), true);
  const u64 = (at: number) => u32(at) + u32(at + 4) * 0x100000000;
  if (u32(end) !== _END) throw new _BadFile("the zip archive is damaged");

  let length = u32(end + 12), offset = u32(end + 16), directory_end = end;
  if (end >= 76 && u32(end - 20) === _LOCATOR64 && u32(end - 76) === _END64) {
    directory_end = end - 76;
    length = u64(directory_end + 40);
    offset = u64(directory_end + 48);
  }
  const shift = directory_end - length - offset; // bytes put before the archive
  if (shift < 0) throw new _BadFile("the zip archive is damaged");

  const members: _Member[] = [];
  for (let at = offset + shift; at < directory_end;) {
    if (u32(at) !== _CENTRAL) throw new _BadFile("the zip directory is damaged");
    const name_length = u16(at + 28), extra_length = u16(at + 30), comment_length = u16(at + 32);
    const member: _Member = {
      name: _latin1(data.subarray(inside(at + 46, name_length), at + 46 + name_length)),
      flags: u16(at + 8), method: u16(at + 10), crc: u32(at + 16),
      packed: u32(at + 20), size: u32(at + 24), offset: u32(at + 42),
    };
    for (let extra = at + 46 + name_length; extra + 4 <= at + 46 + name_length + extra_length;
         extra += 4 + u16(extra + 2)) {
      if (u16(extra) !== 1) continue; // zip64 sizes
      let value = extra + 4;
      for (const field of ["size", "packed", "offset"] as const) {
        if (member[field] === 0xffffffff) {
          member[field] = u64(value);
          value += 8;
        }
      }
    }
    member.offset += shift;
    members.push(member);
    at += 46 + name_length + extra_length + comment_length;
  }
  return members;
}

function _zip_read(data: Uint8Array, member: _Member): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = member.offset;
  if (at + 30 > data.length || view.getUint32(at, true) !== _LOCAL) throw new _BadFile("the zip archive is damaged");
  if (member.flags & 1) throw new _BadFile("the archive is encrypted");
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  if (start + member.packed > data.length) throw new _BadFile("the zip archive is cut short");
  const packed = data.subarray(start, start + member.packed);
  let out: Uint8Array;
  if (member.method === 8) out = _inflate(packed, member.size);
  else if (member.method === 0 && member.packed === member.size) out = packed;
  else if (member.method === 0) throw new _BadFile("the zip archive is damaged");
  else throw new _BadFile(`the archive uses compression method ${member.method}; only deflate is read`);
  if (_crc32(out) !== member.crc) throw new _BadFile("a member of the archive is damaged (bad CRC)");
  return out;
}

// A zip archive of [name, content] entries, stored uncompressed: what a .reqifz is.
export function write_zip(entries: readonly (readonly [string, Uint8Array | string])[]): Uint8Array {
  const parts: Uint8Array[] = [], directory: Uint8Array[] = [];
  let offset = 0;
  const record = (length: number, fields: readonly (readonly [number, number])[]): Uint8Array => {
    const out = new Uint8Array(length);
    const view = new DataView(out.buffer);
    let at = 0;
    for (const [width, value] of fields) {
      if (width === 2) view.setUint16(at, value, true);
      else view.setUint32(at, value, true);
      at += width;
    }
    return out;
  };
  for (const [name, content] of entries) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const label = new TextEncoder().encode(name);
    // version, UTF-8 names, stored, time, date (1980-01-01), CRC, sizes, name and extra lengths
    const common = [[2, 20], [2, 0x800], [2, 0], [2, 0], [2, 0x21], [4, _crc32(bytes)], [4, bytes.length],
                    [4, bytes.length], [2, label.length], [2, 0]] as const;
    const local = record(30, [[4, _LOCAL], ...common]);
    // ...then comment length, disk, internal and external attributes, offset
    const central = record(46, [[4, _CENTRAL], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]);
    parts.push(local, label, bytes);
    directory.push(central, label);
    offset += local.length + label.length + bytes.length;
  }
  const length = directory.reduce((sum, part) => sum + part.length, 0);
  const end = record(22, [[4, _END], [2, 0], [2, 0], [2, entries.length], [2, entries.length], [4, length],
                          [4, offset], [2, 0]]);
  const all = [...parts, ...directory, end];
  const out = new Uint8Array(offset + length + end.length);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// =========================================================================
// Identifiers
// =========================================================================

function _sha1(data: Uint8Array): Uint8Array {
  const blocks = ((data.length + 8) >> 6) + 1;
  const padded = new Uint8Array(blocks * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length << 3) >>> 0);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const words = new Int32Array(80);
  const rotate = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(block * 64 + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = state;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 || i >= 60 ? b ^ c ^ d : (b & c) | (b & d) | (c & d);
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotate(a, 5) + f + e + k + words[i]) | 0;
      [a, b, c, d, e] = [next, a, rotate(b, 30), c, d];
    }
    [a, b, c, d, e].forEach((v, i) => { state[i] = (state[i] + v) | 0; });
  }
  const out = new Uint8Array(20);
  state.forEach((v, i) => new DataView(out.buffer).setInt32(i * 4, v));
  return out;
}

function _uuid(bytes: Uint8Array, version: number): string {
  const b = bytes.slice(0, 16);
  b[6] = (b[6] & 0x0f) | (version << 4);
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const _NAMESPACE_URL = [0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8];

type _Key = readonly (string | number)[];

// The same key gives the same identifier on every export (a version 5 UUID).
function _identifier(key: _Key): string {
  const name = new TextEncoder().encode(key.join("\x1f"));
  const data = new Uint8Array(16 + name.length);
  data.set(_NAMESPACE_URL);
  data.set(name, 16);
  return "_" + _uuid(_sha1(data), 5);
}

// =========================================================================
// Export
// =========================================================================

class _Writer {
  stamp: string;
  root: _Element;
  datatypes: Map<string, _Element>; // declared datatypes by key
  xhtml: boolean;

  constructor() {
    this.stamp = new Date().toISOString().slice(0, 19) + "+00:00";
    this.root = new _Element("REQ-IF", new Map([["xmlns", NS]]));
    this.datatypes = new Map();
    this.xhtml = false;
  }

  add(parent: _Element, tag: string, text: string = "", attributes: Record<string, string | number> = {}): _Element {
    const element = new _Element(tag, new Map(Object.entries(attributes).map(([k, v]) => [k, _clean(String(v))])));
    element.text = _clean(text);
    parent.children.push(element);
    return element;
  }

  // An identifiable element.
  named(parent: _Element, tag: string, key: _Key, attributes: Record<string, string | number> = {}): _Element {
    return this.add(parent, tag, "", { IDENTIFIER: _identifier(key), "LAST-CHANGE": this.stamp, ...attributes });
  }

  ref(parent: _Element, wrapper: string, tag: string, key: _Key): void {
    this.add(this.add(parent, wrapper), tag, _identifier(key));
  }
}

function _kind(definition: AttrDef): string {
  if (definition.base === "Enumeration") {
    if (definition.type_name === "Boolean" && !definition.multi && definition.values.length === BOOLEAN_VALUES.length
        && definition.values.every((v, i) => v === BOOLEAN_VALUES[i])) {
      return "BOOLEAN";
    }
    return "ENUMERATION";
  }
  return ({ String: "STRING", Text: "XHTML", Integer: "INTEGER", Real: "REAL", Date: "DATE" } as
    Record<string, string>)[definition.base];
}

// One attribute definition of a spec type, and how to write its values.
class _Attribute {
  writer: _Writer;
  name: string;
  kind: string;
  definition: AttrDef | null;
  key: _Key;
  type_name: string;
  datatype: _Key;

  constructor(writer: _Writer, owner: _Key, name: string, kind: string, definition: AttrDef | null = null) {
    this.writer = writer;
    this.name = name;
    this.kind = kind;
    this.definition = definition;
    this.key = [...owner, "attribute", name];
    this.type_name = definition ? definition.type_name : kind[0] + kind.slice(1).toLowerCase();
    this.datatype = [...owner, "datatype", this.type_name, kind];
  }

  declare_type(datatypes: _Element): void {
    const key = JSON.stringify(this.datatype);
    if (this.writer.datatypes.has(key)) return;
    const extra: Record<string, string | number> =
      this.kind === "STRING" ? { "MAX-LENGTH": MAX_STRING }
      : this.kind === "INTEGER" ? { MIN: "-9223372036854775808", MAX: "9223372036854775807" }
      : this.kind === "REAL" ? { ACCURACY: 15, MIN: "-1.0E308", MAX: "1.0E308" }
      : {};
    const element = this.writer.named(datatypes, `DATATYPE-DEFINITION-${this.kind}`, this.datatype,
                                      { "LONG-NAME": this.type_name, ...extra });
    this.writer.datatypes.set(key, element);
    if (this.kind === "ENUMERATION") {
      const values = this.writer.add(element, "SPECIFIED-VALUES");
      this.definition!.values.forEach((value, position) => {
        const entry = this.writer.named(values, "ENUM-VALUE", [...this.datatype, value], { "LONG-NAME": value });
        this.writer.add(this.writer.add(entry, "PROPERTIES"), "EMBEDDED-VALUE", "",
                        { KEY: position, "OTHER-CONTENT": "" });
      });
    }
  }

  define(attributes: _Element): void {
    const extra: Record<string, string> =
      this.kind === "ENUMERATION" ? { "MULTI-VALUED": String(this.definition!.multi) } : {};
    const element = this.writer.named(attributes, `ATTRIBUTE-DEFINITION-${this.kind}`, this.key,
                                      { "LONG-NAME": this.name, ...extra });
    this.writer.ref(element, "TYPE", `DATATYPE-DEFINITION-${this.kind}-REF`, this.datatype);
    if (this.definition && this.definition.default) {
      this.value(this.writer.add(element, "DEFAULT-VALUE"), this.definition.default);
    }
  }

  // A value longer than the datatype allows raises what it allows: nothing is cut.
  _allow(value: string): void {
    const datatype = this.writer.datatypes.get(JSON.stringify(this.datatype))!;
    let length = 0;
    for (const _ of value) length += 1; // characters, not UTF-16 units
    if (length > Number(datatype.get("MAX-LENGTH"))) datatype.attrib.set("MAX-LENGTH", String(length));
  }

  // Append the ATTRIBUTE-VALUE for `text`. An empty value is only written
  // where its absence would mean the default instead.
  value(parent: _Element, text: string): void {
    const defaulted = Boolean(this.definition && this.definition.default);
    if (!text && !(defaulted && ["STRING", "XHTML", "ENUMERATION"].includes(this.kind))) return;
    const element = this.writer.add(parent, `ATTRIBUTE-VALUE-${this.kind}`);
    this.writer.ref(element, "DEFINITION", `ATTRIBUTE-DEFINITION-${this.kind}-REF`, this.key);
    if (this.kind === "XHTML") {
      this.writer.xhtml = true;
      const div = new _Element("xhtml:div");
      this.writer.add(element, "THE-VALUE").children.push(div);
      const lines = _clean(text).replaceAll("\r\n", "\n").split("\n");
      div.text = lines[0];
      for (let i = 1; i < lines.length; i++) {
        const br = new _Element("xhtml:br");
        br.tail = lines[i];
        div.children.push(br);
      }
    } else if (this.kind === "ENUMERATION") {
      const values = this.writer.add(element, "VALUES");
      for (const value of text.split("\n")) {
        if (value) this.writer.add(values, "ENUM-VALUE-REF", _identifier([...this.datatype, value]));
      }
    } else if (this.kind === "BOOLEAN") {
      element.attrib.set("THE-VALUE", text === "True" ? "true" : "false");
    } else if (this.kind === "DATE") {
      const date = parse_date(text);
      if (date === null) throw new StoreError(`${this.name}: ${_repr(text)} is not a date (use YYYY-MM-DD)`);
      element.attrib.set("THE-VALUE", date.toISOString().slice(0, 19) + "+00:00");
    } else {
      const value = _clean(text);
      if (this.kind === "STRING") this._allow(value);
      element.attrib.set("THE-VALUE", value);
    }
  }
}

export type ReqifExport = {
  text: string; // the .reqif document, to be saved as UTF-8
  modules: number; objects: number; relations: number; skipped_links: number;
};

// The formal modules, and the links among them, as a ReqIF document. A skipped
// link leads from or to a module that was not asked for.
export function export_reqif(store: Store, module_ids: Iterable<number>): ReqifExport {
  const wanted = [...new Set(module_ids)];
  for (const module of wanted) {
    if (store.item(module).kind !== "formal") throw new StoreError(`${store.path(module)} is not a formal module`);
  }
  const writer = new _Writer();
  const header = writer.add(writer.add(writer.root, "THE-HEADER"), "REQ-IF-HEADER", "", {
    IDENTIFIER: "_" + _uuid(crypto.getRandomValues(new Uint8Array(16)), 4) });
  writer.add(header, "CREATION-TIME", writer.stamp);
  writer.add(header, "REQ-IF-TOOL-ID", "open-door-sim-suite");
  writer.add(header, "REQ-IF-VERSION", "1.0"); // the schema's fixed value, also for 1.2
  writer.add(header, "SOURCE-TOOL-ID", "open-door-sim-suite");
  writer.add(header, "TITLE", wanted.map((m) => store.item(m).name).join(", "));
  const content = writer.add(writer.add(writer.root, "CORE-CONTENT"), "REQ-IF-CONTENT");
  const [datatypes, spec_types, spec_objects, spec_relations, specifications] =
    ["DATATYPES", "SPEC-TYPES", "SPEC-OBJECTS", "SPEC-RELATIONS", "SPECIFICATIONS"]
      .map((tag) => writer.add(content, tag));
  const exported = new Map<string, { obj: Obj; key: _Key }>(); // by Obj.key
  const paths = new Map<number, string>();

  for (const module of wanted) {
    const item = store.item(module), where = store.path(module);
    paths.set(module, where);
    const definitions = store.attributes(module, null);
    const names = new Set(definitions.map((a) => a.name));

    const attributes_of = (owner: _Key, scope: string) => new Map<string, _Attribute>(
      definitions.filter((a) => a.scope === scope).map((a) => {
        const name = EXPORT_NAMES.get(a.name) ?? a.name;
        const kind = a.name === "Object Text" ? "XHTML" : _kind(a);
        return [a.name, new _Attribute(writer, owner, name, kind, a)];
      }));

    const object_type: _Key = ["object type", where], spec_type: _Key = ["specification type", where];
    const on_object = attributes_of(object_type, "object");
    if (!names.has("Foreign ID")) {
      on_object.set("Foreign ID", new _Attribute(writer, object_type, "ReqIF.ForeignID", "STRING"));
    }
    const on_module = attributes_of(spec_type, "module");
    if (!names.has("Prefix")) on_module.set("Prefix", new _Attribute(writer, spec_type, "Prefix", "STRING"));

    for (const [tag, key, attributes] of [["SPEC-OBJECT-TYPE", object_type, on_object],
                                          ["SPECIFICATION-TYPE", spec_type, on_module]] as const) {
      const element = writer.named(spec_types, tag, key, { "LONG-NAME": item.name });
      const holder = writer.add(element, "SPEC-ATTRIBUTES");
      for (const attribute of attributes.values()) {
        attribute.declare_type(datatypes);
        attribute.define(holder);
      }
    }

    const specification = writer.named(specifications, "SPECIFICATION", ["specification", where],
                                       { "LONG-NAME": item.name, DESC: item.description });
    const module_values = writer.add(specification, "VALUES");
    for (const [name, attribute] of on_module) {
      attribute.value(module_values, name === "Prefix" && !names.has(name) ? store.prefix(module)
                      : store.module_value(module, name));
    }
    writer.ref(specification, "TYPE", "SPECIFICATION-TYPE-REF", spec_type);

    const held = store.values(module);
    // CHILDREN elements by parent absno (null: top level)
    const hierarchy = new Map<number | null, _Element>([[null, writer.add(specification, "CHILDREN")]]);
    const nodes = new Map<number, _Element>();
    for (const obj of store.objects(module)) {
      const key: _Key = ["object", where, obj.absno];
      exported.set(obj.key, { obj, key });
      const mine = held.get(obj.absno);
      const element = writer.named(spec_objects, "SPEC-OBJECT", key);
      const values = writer.add(element, "VALUES");
      for (const [name, attribute] of on_object) {
        // attribute DXL: its value now; a failing one stops the export rather than send wrong data
        let text = attribute.definition?.dxl ? store.value(obj, name) : mine?.get(name) ?? "";
        if (name === "Foreign ID") text = text || store.identifier(obj);
        attribute.value(values, text);
      }
      writer.ref(element, "TYPE", "SPEC-OBJECT-TYPE-REF", object_type);

      const parent = store.parent_object(obj);
      const up = parent ? parent.absno : null;
      let children = hierarchy.get(up);
      if (!children) {
        const above = nodes.get(up!);
        if (!above) {
          throw new StoreError(`${store.identifier(obj)} is under a deleted object; undelete or move it first`);
        }
        hierarchy.set(up, children = writer.add(above, "CHILDREN"));
      }
      const node = writer.named(children, "SPEC-HIERARCHY", ["node", where, obj.absno]);
      nodes.set(obj.absno, node);
      writer.ref(node, "OBJECT", "SPEC-OBJECT-REF", key);
    }
  }

  const relation_types = new Set<string>();
  let relations = 0, skipped = 0;
  for (const { obj, key } of exported.values()) {
    skipped += store.links(obj, false).filter((link) => !paths.has(link.source.module_id)).length;
    for (const link of store.links(obj, true)) {
      const target = exported.get(link.target.key);
      if (!target) {
        skipped += 1;
        continue;
      }
      const name = store.item(link.link_module).name;
      const type_key: _Key = ["relation type", name];
      if (!relation_types.has(name)) {
        relation_types.add(name);
        writer.named(spec_types, "SPEC-RELATION-TYPE", type_key, { "LONG-NAME": name });
      }
      const relation = writer.named(spec_relations, "SPEC-RELATION",
                                    ["relation", store.path(link.link_module), ...key, ...target.key]);
      writer.ref(relation, "SOURCE", "SPEC-OBJECT-REF", key);
      writer.ref(relation, "TARGET", "SPEC-OBJECT-REF", target.key);
      writer.ref(relation, "TYPE", "SPEC-RELATION-TYPE-REF", type_key);
      relations += 1;
    }
  }

  if (writer.xhtml) writer.root.attrib.set("xmlns:xhtml", XHTML);
  return { text: _serialize(writer.root), modules: wanted.length, objects: exported.size, relations,
           skipped_links: skipped };
}

// =========================================================================
// Reading the file
// =========================================================================

// The parsed root of the .reqif document, or of each one inside a .reqifz.
function _documents(data: Uint8Array | string, path: string): _Element[] {
  const budget = { elements: MAX_ELEMENTS };
  let roots: _Element[];
  try {
    let sources: (Uint8Array | string)[] = [data];
    const end = typeof data === "string" ? -1 : _zip_end(data);
    if (typeof data !== "string" && end >= 0) {
      const members = _zip_members(data, end).filter((m) => m.name.toLowerCase().endsWith(".reqif"));
      if (!members.length) throw new StoreError("the archive holds no .reqif file");
      if (members.reduce((sum, m) => sum + m.size, 0) > MAX_BYTES) {
        throw new StoreError("the archive is too large to unpack");
      }
      sources = members.map((m) => _zip_read(data, m));
    } else if (data.length > MAX_BYTES) {
      throw new StoreError("the file is too large to read");
    }
    roots = sources.map((source) => _parse_xml(source, budget));
  } catch (error) {
    if (!(error instanceof _BadFile)) throw error;
    throw new StoreError(`${path} is not readable XML: ${error.message}`);
  }
  if (roots.some((root) => root.tag !== _q("REQ-IF"))) throw new StoreError(`${path} is not a ReqIF file`);
  return roots;
}

const _LINES: ReadonlySet<string> = new Set(
  ["p", "div", "li", "tr", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6"]);
const _SPACES = new RegExp(`[${_SPACE}]+`, "g");
const _VISIBLE = new RegExp(`[^${_SPACE}]`);

// Plain text of an XHTML value. Paragraph-like elements end lines, <br/> is a
// line break, and source indentation counts as one space.
function _xhtml_text(holder: _Element, lost: Set<_Element>): string {
  // Marks that cannot occur in XML text: collapsible space, end of line, end of cell.
  const soft = "\x00", block = "\x01", cell = "\x02";
  const out: string[] = [];
  let visible = 0; // how many pieces of source text were more than space

  const add = (text: string) => {
    if (!text) return;
    if (_VISIBLE.test(text)) visible += 1;
    out.push(text.includes("\n") ? text.replace(_SPACES, soft) : text);
  };

  type Frame = { node: _Element; tag: string; next: number; slot: number; seen: number };
  const stack: Frame[] = [];
  const enter = (node: _Element) => {
    const tag = node.tag.slice(node.tag.lastIndexOf("}") + 1);
    let slot = -1;
    if (tag === "object") { // a picture or OLE object; its content is the fallback text
      lost.add(node);
      slot = out.push("") - 1;
    }
    const seen = visible;
    if (tag === "br") out.push("\n");
    if (_LINES.has(tag)) out.push(block);
    if (tag === "li") out.push("- ");
    add(node.text);
    stack.push({ node, tag, next: 0, slot, seen });
  };

  add(holder.text);
  for (const top of holder.children) {
    enter(top);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next < frame.node.children.length) {
        enter(frame.node.children[frame.next++]);
        continue;
      }
      stack.pop();
      if (frame.slot >= 0 && visible === frame.seen) out[frame.slot] = "[embedded object]";
      if (_LINES.has(frame.tag)) out.push(block);
      else if (frame.tag === "td" || frame.tag === "th") out.push(cell);
      add(frame.node.tail);
    }
  }

  const text = out.join("").replace(/[\x00-\x02]+/g, (run) => (run.includes(block) ? block : run));
  let start = 0, end = text.length;
  while (start < end && text[start] <= cell) start++;
  while (end > start && text[end - 1] <= cell) end--;
  return text.slice(start, end).replace(/\x00?\n\x00?/g, "\n")
    .replaceAll(block, "\n").replaceAll(soft, " ").replaceAll(cell, "\t");
}

// The identifier that `element`'s `wrapper` child refers to.
function _ref(element: _Element, wrapper: string): string | null {
  const found = element.find(_q(wrapper));
  if (found === null || !found.children.length) return null;
  return _strip(found.children[0].text);
}

function* _all(roots: _Element[], section: string): Generator<_Element> {
  for (const root of roots) {
    for (const holder of root.iter(_q(section))) yield* holder.children;
  }
}

type _Definition = {
  id: string | null; name: string; kind: string; type: string; values: readonly string[]; multi: boolean;
  default: string;
};

// The files' definitions and objects, by identifier.
class _Content {
  enum_names: Map<string | null, string>;
  datatypes: Map<string | null, [string, readonly string[]]>;
  definitions: Map<string | null, _Definition>;
  types: Map<string | null, [string, _Definition[]]>;
  objects: Map<string | null, _Element>;
  relations: _Element[];
  specifications: _Element[];
  lost: Set<_Element>;

  constructor(roots: _Element[]) {
    this.enum_names = new Map();
    this.datatypes = new Map();
    this.definitions = new Map();
    this.types = new Map();
    this.lost = new Set();
    for (const element of _all(roots, "DATATYPES")) {
      const names = new Set<string>(), ordered: string[] = [];
      for (const value of element.iter(_q("ENUM-VALUE"))) {
        const identifier = value.get("IDENTIFIER");
        const embedded = value.children.filter((c) => c.tag === _q("PROPERTIES"))
          .map((c) => c.find(_q("EMBEDDED-VALUE"))).find((c) => c !== null);
        let name = value.get("LONG-NAME") || embedded?.get("KEY") || identifier || "";
        if (ordered.length >= MAX_ENUM_VALUES) throw new StoreError("an enumeration has too many values");
        while (names.has(name)) name += " (2)";
        const written = name.replaceAll("\n", " ");
        names.add(written);
        ordered.push(written);
        this.enum_names.set(identifier, written);
      }
      this.datatypes.set(element.get("IDENTIFIER"), [element.get("LONG-NAME") || "", ordered]);
    }
    for (const element of _all(roots, "SPEC-TYPES")) {
      const attributes: _Definition[] = [];
      for (const entry of element.find(_q("SPEC-ATTRIBUTES"))?.children ?? []) {
        const kind = entry.tag.slice(entry.tag.lastIndexOf("-") + 1);
        if (!KINDS.includes(kind)) continue;
        const datatype = this.datatypes.get(_ref(entry, "TYPE")) ?? ["", []];
        const fallback = entry.find(_q("DEFAULT-VALUE"));
        let name = entry.get("LONG-NAME") || entry.get("IDENTIFIER") || "";
        name = NAMES.get(name) ?? name;
        if (SYSTEM_ATTRIBUTES.includes(name)) name = "Imported " + name;
        const definition: _Definition = {
          id: entry.get("IDENTIFIER"), name, kind, type: datatype[0],
          values: kind === "BOOLEAN" ? BOOLEAN_VALUES : datatype[1],
          multi: entry.get("MULTI-VALUED") === "true", default: "" };
        this.definitions.set(definition.id, definition);
        if (fallback !== null && fallback.children.length) {
          definition.default = this.value(fallback.children[0], definition);
        }
        attributes.push(definition);
      }
      this.types.set(element.get("IDENTIFIER"), [element.get("LONG-NAME") || "", attributes]);
    }
    this.objects = new Map();
    for (const element of _all(roots, "SPEC-OBJECTS")) this.objects.set(element.get("IDENTIFIER"), element);
    this.relations = [..._all(roots, "SPEC-RELATIONS")];
    this.specifications = [..._all(roots, "SPECIFICATIONS")];
  }

  value(element: _Element, definition: _Definition): string {
    const kind = element.tag.slice(element.tag.lastIndexOf("-") + 1);
    if (kind === "XHTML") {
      const holder = element.find(_q("THE-VALUE"));
      return holder === null ? "" : _xhtml_text(holder, this.lost);
    }
    if (kind === "ENUMERATION") {
      return [...element.iter(_q("ENUM-VALUE-REF"))].map((r) => {
        const chosen = _strip(r.text);
        const name = this.enum_names.get(chosen);
        if (name === undefined) {
          throw new StoreError(`${definition.name}: undeclared enumeration value ${_repr(chosen)}`);
        }
        return name;
      }).join("\n");
    }
    const text = element.get("THE-VALUE") ?? "";
    if (kind === "BOOLEAN") return ["true", "1"].includes(_strip(text)) ? "True" : "False";
    if (kind === "DATE") {
      const stripped = _strip(text);
      const t = stripped.indexOf("T");
      const date = (t < 0 ? stripped : stripped.slice(0, t)).slice(0, 10);
      const time = t < 0 ? "" : stripped.slice(t + 1, t + 9);
      return time === "" || time === "00:00:00" ? date : `${date} ${time}`;
    }
    return text;
  }

  // attribute name -> text, for a SPEC-OBJECT or SPECIFICATION.
  values(element: _Element): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of element.find(_q("VALUES"))?.children ?? []) {
      const definition = this.definitions.get(_ref(entry, "DEFINITION"));
      if (definition) {
        const text = this.value(entry, definition);
        out.set(definition.name, out.get(definition.name) || text); // ReqIF.Text and Object Text may both be there
      }
    }
    return out;
  }
}

// =========================================================================
// Import
// =========================================================================

// One attribute per name from the definitions of possibly several types.
function _merge(definitions: _Definition[]): Map<string, _Definition> {
  const out = new Map<string, _Definition>();
  for (const d of definitions) {
    const known = out.get(d.name);
    if (known === undefined) out.set(d.name, { ...d });
    else if (known.kind === d.kind) {
      known.values = [...new Set([...known.values, ...d.values])];
      known.multi = known.multi || d.multi;
    } else Object.assign(known, { kind: "STRING", type: "", values: [], multi: false, default: "" });
  }
  return out;
}

// The name of a module type fitting the definition, creating it if needed.
function _type_for(store: Store, module: number, d: _Definition): string {
  if (d.kind === "BOOLEAN") return "Boolean";
  if (d.kind === "ENUMERATION" && !d.values.length) return "String";
  const base = d.kind === "ENUMERATION" ? "Enumeration" : BASE_OF[d.kind];
  const values = base === "Enumeration" ? d.values : [];
  const wanted = d.type || (base === "Enumeration" ? d.name : base);
  let name = wanted;
  for (let serial = 2; ; serial++) {
    const known = store.types(module).find((t) => t.name === name);
    if (!known) {
      store.create_type(module, name, base, values);
      return name;
    }
    if (known.base === base && known.values.length === values.length
        && known.values.every((v, i) => v === values[i])) {
      return name;
    }
    name = `${wanted} ${serial}`;
  }
}

// A new module; a name already taken, even by a deleted item, gets a number.
function _create_module(store: Store, folder_path: string, name: string, description: string): number {
  const base = _strip(_clean(name).replaceAll("/", "-").replaceAll("\n", " ")).replace(/^\.+|(?<!\.)\.+$/g, "")
    || "Imported module";
  let candidate = base;
  for (let serial = 2; serial < 1000; serial++) {
    try {
      return store.create_module(folder_path, candidate, description);
    } catch (error) {
      if (!(error instanceof StoreError) || !error.message.includes("already exists")) throw error;
    }
    candidate = `${base} (${serial})`;
  }
  throw new StoreError(`too many modules are named ${_repr(base)}`);
}

export type ReqifImport = {
  modules: string[]; // paths of the new modules
  objects: number; links: number;
  skipped_relations: number; // relations to objects that were not imported
  unplaced_objects: number; // objects in no specification
  embedded_objects: number; // pictures or OLE objects that only left their fallback text
};

// Read a .reqif or .reqifz into new modules in `folder_path`, all or nothing.
// Object numbers are assigned afresh. `data` is the file's contents; `path` is
// only its name, for messages.
export function import_reqif(store: Store, folder_path: string, data: Uint8Array | ArrayBuffer | string,
                             path: string = "ReqIF file"): ReqifImport {
  const content = new _Content(_documents(data instanceof ArrayBuffer ? new Uint8Array(data) : data, path));
  if (!content.specifications.length) {
    throw new StoreError("the file holds no specification, so there is nothing to make a module from");
  }
  const folder = "/" + (folder_path || "/").replace(/^\/+|(?<!\/)\/+$/g, "");
  return store.transaction(() => {
    ensure_folder(store, folder);
    const placed = new Map<string | null, Obj>(), modules: string[] = [];
    let count = 0;
    for (const specification of content.specifications) {
      const [module, made] = _import_specification(store, folder, content, specification, placed);
      modules.push(store.path(module));
      count += made;
    }
    const [links, skipped] = _import_relations(store, folder, content, placed);
    return {
      modules, objects: count, links, skipped_relations: skipped,
      unplaced_objects: [...content.objects.keys()].filter((id) => !placed.has(id)).length,
      embedded_objects: content.lost.size,
    };
  });
}

function _import_specification(store: Store, folder: string, content: _Content, specification: _Element,
                               placed: Map<string | null, Obj>): [number, number] {
  // [spec object identifier, parent index or null], in document order
  const nodes: [string | null, number | null][] = [];
  const pending: { node: _Element; parent: number | null; level: number }[] = [];
  const push_children = (holder: _Element, parent: number | null, level: number) => {
    const children = holder.find(_q("CHILDREN"))?.children ?? [];
    if (children.length && level > MAX_LEVELS) throw new StoreError("the hierarchy is nested too deeply");
    for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], parent, level });
  };
  push_children(specification, null, 1);
  while (pending.length) {
    const { node, parent, level } = pending.pop()!;
    const reference = _ref(node, "OBJECT");
    if (!content.objects.has(reference)) {
      throw new StoreError(`the hierarchy names an object the file lacks: ${reference ?? "None"}`);
    }
    nodes.push([reference, parent]);
    push_children(node, nodes.length - 1, level + 1);
  }

  const values = content.values(specification);
  const pop = (name: string): string => {
    const value = values.get(name) ?? "";
    values.delete(name);
    return value;
  };
  const description = pop("Description") || pop("ReqIF.Description") || (specification.get("DESC") ?? "");
  const module = _create_module(store, folder, specification.get("LONG-NAME")
                                || values.get("Object Short Text") || "", description);
  store.set_item(module, null, null, pop("Prefix") || pop("ReqIF.Prefix"));

  const standard = ["Object Heading", "Object Text", "Object Short Text"];
  const spec_type = content.types.get(_ref(specification, "TYPE"))?.[1] ?? [];
  const used = new Set(nodes.map(([r]) => _ref(content.objects.get(r)!, "TYPE")));
  const object_definitions = _merge([...used].flatMap((t) => content.types.get(t)?.[1] ?? []));
  const module_definitions = _merge(spec_type.filter(
    (d) => !["Prefix", "ReqIF.Prefix", "Description", "ReqIF.Description"].includes(d.name)));
  for (const [scope, definitions] of [["object", object_definitions], ["module", module_definitions]] as const) {
    for (const [name, d] of definitions) {
      if (standard.includes(name) || store.attribute(module, name)) continue;
      store.create_attribute(module, name, _type_for(store, module, d), scope,
                             d.kind === "ENUMERATION" && d.multi && d.values.length > 0, d.default);
    }
  }
  for (const name of module_definitions.keys()) {
    if (values.has(name) && store.attribute(module, name)!.scope === "module") {
      store.set_module_value(module, name, values.get(name)!);
    }
  }

  const made: Obj[] = [];
  for (const [reference, parent] of nodes) {
    let obj: Obj;
    try {
      const mine = new Map<string, string>();
      for (const [name, text] of content.values(content.objects.get(reference)!)) {
        if (store.attribute(module, name)?.scope === "object") mine.set(name, _clean(text));
      }
      obj = store.create_object(module, parent === null ? null : made[parent], null, null, mine);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      throw new StoreError(`${specification.get("LONG-NAME") ?? "None"}, object ${reference}: ${error.message}`);
    }
    made.push(obj);
    if (!placed.has(reference)) placed.set(reference, obj);
  }
  return [module, made.length];
}

function _import_relations(store: Store, folder: string, content: _Content,
                           placed: Map<string | null, Obj>): [number, number] {
  const link_modules = new Map<string | null, string>(), links = new Set<number>();
  let skipped = 0;
  for (const relation of content.relations) {
    const source = placed.get(_ref(relation, "SOURCE")), target = placed.get(_ref(relation, "TARGET"));
    if (!source || !target || source.equals(target)) {
      skipped += 1;
      continue;
    }
    const type_id = _ref(relation, "TYPE");
    let link_module = link_modules.get(type_id);
    if (link_module === undefined) {
      const name = _strip((content.types.get(type_id)?.[0] ?? "").replaceAll("/", "-")) || "ReqIF Links";
      const beside = `${folder === "/" ? "" : folder}/${name}`;
      link_module = beside;
      let taken = store.find(link_module);
      for (let serial = 2; taken !== null && store.item(taken).kind !== "link"; serial++) {
        link_module = `${beside} (${serial})`;
        taken = store.find(link_module);
      }
      link_modules.set(type_id, link_module);
    }
    links.add(store.create_link(source, target, link_module).id);
  }
  return [links.size, skipped];
}
