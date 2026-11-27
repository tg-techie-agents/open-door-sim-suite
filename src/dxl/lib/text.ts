// General-purpose DXL: strings, characters, math, Buffer, Regexp, Skip, Date,
// Stream files and string array sorting.
//
// Compiler assignment operators change the left value in place, so a declared but
// unassigned Buffer or Date is an empty object rather than null. Both are kept out
// of `lib.handles` so that `null` and `== null` can recognise that empty state.
//
// Other library files that return a Date use `DxlDate`.
//
// Strings are indexed in UTF-16 units; DOORS may count characters. The two agree
// for everything in the Basic Multilingual Plane.

import { Ellipsis, Fault, Typed, compare_text } from "../runtime.ts";
import { py_repr } from "../syntax.ts";
import { OSError, join_path } from "../files.ts";

// -- text and number helpers ------------------------------------------------

// What counts as white space here (wider than JavaScript \s).
const PY_SPACE = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_BLANK = new RegExp(PY_SPACE);
const PY_SPLIT = new RegExp(`${PY_SPACE}+`);

function pyStrip(text: string): string {
  let start = 0, end = text.length;
  while (start < end && PY_BLANK.test(text[start])) start++;
  while (end > start && PY_BLANK.test(text[end - 1])) end--;
  return text.slice(start, end);
}

/** The shortest text that reads back as this real. */
function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, power] = x.toExponential().split("e");
  const e = Number(power);
  if (e < -4 || e >= 16) {
    return `${mantissa}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  const s = String(x);
  if (e < 0) return (x < 0 ? "-" : "") + "0." + "0".repeat(-e - 1) + mantissa.replace(/[-.]/g, "");
  return s.includes(".") ? s : s + ".0";
}

/** An int this engine can hold exactly. */
function exact(name: string, n: number): number {
  if (!Number.isSafeInteger(n)) throw new Fault(`${name}: the number is too large for this engine`);
  return n + 0; // never -0
}

// -- strings and characters ------------------------------------------------

export const SPACE = " \t\n\r\x0b";

function _is(test: (c: string) => boolean) {
  return (rt: any, c: string) => test(c);
}

function _alpha(c: string): boolean {
  return ("a" <= c && c <= "z") || ("A" <= c && c <= "Z");
}

function _digit(c: string): boolean {
  return "0" <= c && c <= "9";
}

export const CLASSES = new Map<string, (c: string) => boolean>([
  ["isalpha", _alpha],
  ["isupper", (c) => "A" <= c && c <= "Z"],
  ["islower", (c) => "a" <= c && c <= "z"],
  ["isdigit", _digit],
  ["isxdigit", (c) => "0123456789abcdefABCDEF".includes(c)],
  ["isalnum", (c) => _alpha(c) || _digit(c)],
  ["isspace", (c) => SPACE.includes(c)],
  ["ispunct", (c) => c !== " " && !_alpha(c) && !_digit(c)],
  ["isprint", (c) => " " <= c && c <= "~"],
  ["iscntrl", (c) => c < " " || c === "\x7f"],
  ["isascii", (c) => c <= "\x7f"],
  ["isgraph", (c) => "!" <= c && c <= "~"],
]);

function _cistrcmp(rt: any, a: string, b: string): number {
  return compare_text(a.toLowerCase(), b.toLowerCase());
}

function _find_plain_text(rt: any, s: string, sub: string, offset: any, length: any,
  match_case: boolean, reverse = false): boolean {
  const hay = match_case ? s : s.toLowerCase();
  const needle = match_case ? sub : sub.toLowerCase();
  const at = reverse ? hay.lastIndexOf(needle) : hay.indexOf(needle);
  if (at < 0) return false;
  offset.set(at);
  length.set(needle.length);
  return true;
}

const INT_TEXT = new RegExp(`^${PY_SPACE}*[+-]?\\p{Nd}+${PY_SPACE}*(?![\\s\\S])`, "u");

/** Any Unicode decimal digit as its value; each script's ten are contiguous. */
function digitValue(c: string): number {
  const n = c.codePointAt(0)!;
  let start = n;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return (n - start) % 10;
}

function toInt(text: string): number {
  return Number(pyStrip(text).replace(/\p{Nd}/gu, (c) => String(c >= "0" && c <= "9" ? c : digitValue(c))));
}

function _int_of_string(rt: any, s: string): number {
  if (!INT_TEXT.test(s)) throw new Fault(`intOf: ${py_repr(s)} is not an integer`);
  return exact("intOf", toInt(s));
}

const DIGITS = "\\p{Nd}(?:_?\\p{Nd})*";
const FLOAT_TEXT = new RegExp(
  `^[+-]?(?:(?:(?:${DIGITS})(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?`
  + "|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aA][nN])(?![\\s\\S])", "u");

function _real_of_string(rt: any, s: string): number {
  const text = pyStrip(s);
  if (!FLOAT_TEXT.test(text)) throw new Fault(`realOf: ${py_repr(s)} is not a number`);
  const word = /^([+-]?)(inf|nan)/i.exec(text);
  if (word) {
    if (word[2].toLowerCase() === "nan") return NaN;
    return word[1] === "-" ? -Infinity : Infinity;
  }
  return Number(text.replace(/_/g, "").replace(/\p{Nd}/gu,
    (c) => String(c >= "0" && c <= "9" ? c : digitValue(c))));
}

function _is_valid_int(rt: any, s: string): boolean {
  if (s === "") throw new Fault("isValidInt: empty string");
  return INT_TEXT.test(s);
}

function _round(rt: any, r: number): number {
  if (Number.isNaN(r)) throw new Fault("intOf: cannot convert float NaN to integer");
  if (!Number.isFinite(r)) throw new Fault("intOf: cannot convert float infinity to integer");
  return exact("intOf", Math.floor(Math.abs(r) + 0.5) * (r >= 0 ? 1 : -1));
}

export const SOUNDEX = new Map<string, string>(
  ["bfpv", "cgjkqsxz", "dt", "l", "mn", "r"].flatMap(
    (group, i) => [...group].map((c): [string, string] => [c, String(i + 1)])));

/** The letter and three digits. The two common rules for h and w, and what
 * a space or digit inside the string does, can disagree: refuse those. */
function _soundex(rt: any, text: string): string {
  const word = text.replace(/^[^A-Za-z]+/, "");
  if (!word) throw new Fault("soundex: there is no letter in the string");

  const code = (hw_separates: boolean): string => {
    let out = word[0].toUpperCase();
    let last = SOUNDEX.get(word[0].toLowerCase()) ?? "";
    for (const c of word.slice(1)) {
      if (out.length === 4) break;
      if (!_alpha(c)) {
        throw new Fault(`soundex ${py_repr(text)}: only a single word of letters is supported here`);
      }
      const digit = SOUNDEX.get(c.toLowerCase()) ?? "";
      if (digit && digit !== last) out += digit;
      if (!"hw".includes(c.toLowerCase()) || hw_separates) last = digit;
    }
    return out.padEnd(4, "0");
  };

  if (code(true) !== code(false)) {
    throw new Fault(`soundex ${py_repr(text)}: the result depends on a rule DOORS does not document`);
  }
  return code(true);
}

/** Ragged-right word wrapping; a word wider than the column continues on
 * the next line. */
function _format(rt: any, stream: any, text: string, width: number): void {
  if (width < 1) throw new Fault("format: the width must be at least 1");
  if (/[\n\r\t]/.test(text)) throw new Fault("format: text with newlines or tabs is not supported here");
  const lines: string[] = [];
  let line: string[] = []; // code points
  for (const part of text.split(PY_SPLIT)) {
    if (!part) continue;
    let word = Array.from(part);
    if (line.length && line.length + 1 + word.length <= width) {
      line.push(" ");
      for (const c of word) line.push(c);
      continue;
    }
    if (line.length) lines.push(line.join(""));
    while (word.length > width) {
      lines.push(word.slice(0, width).join(""));
      word = word.slice(width);
    }
    line = word;
  }
  if (line.length) lines.push(line.join(""));
  _write(rt, stream, lines.map((l) => l + "\n").join(""));
}

function _char_of(rt: any, n: number): string {
  if (!(n >= 0 && n <= 0x10ffff)) throw new Fault("charOf: no character has that code");
  return String.fromCodePoint(n);
}

function _strings(lib: any): void {
  lib.add("length", ["string"], "int", (rt: any, s: string) => s.length);
  lib.add("upper", ["string"], "string", (rt: any, s: string) => s.toUpperCase());
  lib.add("goodFileName", ["string"], "string", good_file_name);
  lib.add("lower", ["string"], "string", (rt: any, s: string) => s.toLowerCase());
  lib.add("cistrcmp", ["string", "string"], "int", _cistrcmp);
  lib.add("soundex", ["string"], "string", _soundex);
  const params = ["string", "string", "&int", "&int", "bool"];
  lib.add("findPlainText", params, "bool", _find_plain_text);
  lib.add("findPlainText", [...params, "bool"], "bool", _find_plain_text);
  for (const [name, test] of CLASSES) lib.add(name, ["char"], "bool", _is(test));
  lib.add("charOf", ["int"], "char", _char_of);
  lib.add("intOf", ["char"], "int", (rt: any, c: string) => c.codePointAt(0)!);
  lib.add("intOf", ["real"], "int", _round);
  lib.add("intOf", ["string"], "int", _int_of_string);
  lib.add("realOf", ["int"], "real", (rt: any, i: number) => i);
  lib.add("realOf", ["string"], "real", _real_of_string);
  lib.add("isValidInt", ["string"], "bool", _is_valid_int);
  lib.add("sort", ["string[]"], "void", _sort);
}

function _sort(rt: any, array: any[]): void {
  for (let i = 0; i < array.length; i++) {
    if (array[i] === Ellipsis) throw new Fault("sort: an array element has no value yet");
  }
  array.sort(compare_text);
}

// -- math ------------------------------------------------------------------

function _random_below(rt: any, limit: number): number {
  if (limit <= 0) throw new Fault("random: the limit must be positive");
  return Math.floor(Math.random() * limit);
}

// Messages for arguments outside a function's domain.
function _function(name: string): (rt: any, x: number) => number {
  const f: (x: number) => number = (Math as any)[name];
  return (rt: any, x: number) => {
    if (name === "sqrt" && x < 0) throw new Fault(`sqrt: expected a nonnegative input, got ${floatRepr(x)}`);
    if (name === "log" && x <= 0) throw new Fault(`log: expected a positive input, got ${floatRepr(x)}`);
    if ((name === "sin" || name === "cos" || name === "tan") && (x === Infinity || x === -Infinity)) {
      throw new Fault(`${name}: expected a finite input, got ${floatRepr(x)}`);
    }
    const y = f(x);
    if (y === Infinity && Number.isFinite(x)) throw new Fault(`${name}: math range error`);
    return y;
  };
}

function _pow(rt: any, x: number, y: number): number {
  if (x === 1 || y === 0) return 1;
  if (x === -1 && (y === Infinity || y === -Infinity)) return 1;
  const z = Math.pow(x, y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    if ((x === 0 && y < 0) || Number.isNaN(z)) throw new Fault("pow: math domain error");
    if (!Number.isFinite(z)) throw new Fault("pow: math range error");
  }
  return z;
}

function _math(lib: any): void {
  lib.add("pi", [], "real", (rt: any) => Math.PI);
  for (const name of ["sin", "cos", "tan", "exp", "log", "sqrt"]) {
    lib.add(name, ["real"], "real", _function(name));
  }
  lib.add("pow", ["real", "real"], "real", _pow);
  lib.add("random", ["int"], "int", _random_below);
  lib.add("random", [], "real", (rt: any) => Math.random());
}

// -- Buffer ----------------------------------------------------------------

/** `created` is false for `Buffer b` before anything is put in it. */
export class Buffer {
  created: boolean;
  _parts: string[];

  constructor(text: string | null = null) {
    this.created = text !== null;
    this._parts = [text ?? ""];
  }

  get text(): string {
    if (!this.created) throw new Fault("null Buffer");
    if (this._parts.length > 1) this._parts = [this._parts.join("")];
    return this._parts[0];
  }

  set text(value: string) {
    this.created = true;
    this._parts = [value];
  }

  append(value: string): void {
    if (!this.created) throw new Fault("null Buffer");
    this._parts.push(value);
  }
}

function _buffer(value: any): Buffer {
  if (value === null || value === undefined) throw new Fault("null Buffer");
  return value;
}

function _text_of(rt: any, b: any): string {
  return _buffer(b).text;
}

function _assign_buffer(rt: any, target: any, value: string): void {
  _buffer(target).text = value;
}

function _substring(text: string, a: number, b: number | null = null): string {
  b = b === null ? text.length - 1 : b;
  if (!(0 <= a && a <= text.length && a - 1 <= b && b < text.length)) {
    throw new Fault(`substring ${a}:${b} is out of range`);
  }
  return text.slice(a, b + 1);
}

function _char_at(text: string, i: number): string {
  if (!(0 <= i && i < text.length)) throw new Fault(`index ${i} is out of range`);
  return text[i];
}

function _combine(rt: any, target: any, source: any, start: number, finish: number | null = null): void {
  _buffer(target).append(_substring(_text_of(rt, source), start, finish));
}

function _set_length(rt: any, b: any, size: number): void {
  if (size < 0) throw new Fault("length: negative length");
  const text = _text_of(rt, b);
  b.text = text.slice(0, size) + "\0".repeat(Math.max(size - text.length, 0));
}

function _set_char(rt: any, b: any, i: number, c: string): void {
  const text = _text_of(rt, b);
  _char_at(text, i);
  b.text = text.slice(0, i) + c + text.slice(i + 1);
}

function _contains_char(rt: any, b: any, c: string, offset: number | null = null): number {
  // As the manual has it: with an offset, the search starts after it.
  return _text_of(rt, b).indexOf(c, offset === null ? 0 : Math.max(offset + 1, 0));
}

const SYNTAX = /[\^$\\.*+?()[\]{}|\/]/g;

function _find_word(text: string, word: string, offset: number, bounded_after: boolean): number {
  const pattern = new RegExp("(?<![A-Za-z0-9])" + word.replace(SYNTAX, "\\$&")
    + (bounded_after ? "(?![A-Za-z0-9])" : ""), "g");
  pattern.lastIndex = Math.min(Math.max(offset, 0), text.length);
  const found = pattern.exec(text);
  return found ? found.index : -1;
}

function _delete_buffer(rt: any, ref: any): void {
  ref.set(null);
}

function _first_non_space(rt: any, b: any): number {
  const text = _text_of(rt, b);
  for (let i = 0; i < text.length; i++) {
    if (!SPACE.includes(text[i])) return i;
  }
  return -1;
}

function _is_null_buffer(b: any): boolean {
  return b === null || b === undefined || !b.created;
}

function _buffers(lib: any): void {
  lib.type("Buffer", _text_of, (rt: any) => new Buffer());
  lib.handles.delete("Buffer");
  lib.add("null", ["Buffer"], "bool", (rt: any, b: any) => _is_null_buffer(b));
  for (const [op, wanted] of [["==", true], ["!=", false]] as [string, boolean][]) {
    lib.operator(op, "Buffer", "null", "bool",
      (rt: any, b: any, _: any) => _is_null_buffer(b) === wanted);
    lib.operator(op, "null", "Buffer", "bool",
      (rt: any, _: any, b: any) => _is_null_buffer(b) === wanted);
  }

  // every newline gets the carriage return Windows expects, once
  lib.add("getDOSstring", ["Buffer"], "Buffer",
    (rt: any, b: any) => new Buffer(_text_of(rt, b).replace(/(?<!\r)\n/g, "\r\n")));
  lib.add("create", [], "Buffer", (rt: any) => new Buffer(""));
  lib.add("create", ["int"], "Buffer", (rt: any, size: number) => new Buffer(""));
  lib.add("delete", ["&Buffer"], "void", _delete_buffer);

  // No Buffer = Buffer operator: as in DOORS that makes both names one buffer.
  lib.operator("=", "Buffer", "string", "void", _assign_buffer);
  lib.operator("=", "Buffer", "null", "void",
    (rt: any, b: any, _: any) => { _buffer(b).created = false; });
  lib.from_attr.set("Buffer", (rt: any, raw: string) => new Buffer(raw));
  lib.chains.add("Buffer"); // `(b += "a") += "b"`
  lib.operator("+=", "Buffer", "string", "void", (rt: any, b: any, s: string) => _buffer(b).append(s));
  lib.operator("+=", "Buffer", "char", "void", (rt: any, b: any, c: string) => _buffer(b).append(c));
  lib.operator("+=", "Buffer", "Buffer", "void",
    (rt: any, b: any, other: any) => _buffer(b).append(_text_of(rt, other)));
  for (const [op, compare] of COMPARISONS) {
    lib.operator(op, "Buffer", "Buffer", "bool",
      (rt: any, a: any, b: any) => compare(compare_text(_text_of(rt, a), _text_of(rt, b))));
  }

  lib.add("print", ["Buffer"], "void", (rt: any, b: any) => { rt.out.write(_text_of(rt, b)); });
  lib.add("stringOf", ["Buffer"], "string", _text_of);
  // In DOORS the result shares the Buffer's memory, so the compiler stops a script keeping it.
  lib.add("tempStringOf", ["Buffer"], "string", _text_of);
  lib.temporaries.add("tempStringOf");
  lib.add("length", ["Buffer"], "int", (rt: any, b: any) => _text_of(rt, b).length);
  lib.add("length", ["Buffer", "int"], "void", _set_length);
  lib.add("set", ["Buffer", "int", "char"], "void", _set_char);
  lib.add("setempty", ["Buffer"], "void", (rt: any, b: any) => { _buffer(b).text = ""; });
  lib.add("setupper", ["Buffer"], "void", (rt: any, b: any) => { const t = _text_of(rt, b); b.text = t.toUpperCase(); });
  lib.add("setlower", ["Buffer"], "void", (rt: any, b: any) => { const t = _text_of(rt, b); b.text = t.toLowerCase(); });
  lib.add("firstNonSpace", ["Buffer"], "int", _first_non_space);
  lib.add("combine", ["Buffer", "Buffer", "int"], "void", _combine);
  lib.add("combine", ["Buffer", "Buffer", "int", "int"], "void", _combine);
  lib.add("contains", ["Buffer", "char"], "int", _contains_char);
  lib.add("contains", ["Buffer", "char", "int"], "int", _contains_char);
  lib.add("contains", ["Buffer", "string", "int"], "int",
    (rt: any, b: any, word: string, at: number) => {
      const found = _find_word(_text_of(rt, b), word, at, false);
      if (found >= 0 && found === at) {
        throw new Fault(`contains: ${py_repr(word)} starts exactly at offset ${at}, and whether DOORS counts `
          + "that position is not documented; use keyword, or findPlainText");
      }
      return found;
    });
  lib.add("keyword", ["Buffer", "string", "int"], "int",
    (rt: any, b: any, word: string, at: number) => _find_word(_text_of(rt, b), word, at, true));
  lib.index("Buffer", "int", "char", (rt: any, b: any, i: number) => _char_at(_text_of(rt, b), i));
  lib.slice("Buffer", "string",
    (rt: any, b: any, a: number, z: number | null) => _substring(_text_of(rt, b), a, z));
}

export const COMPARISONS = new Map<string, (order: number) => boolean>([
  ["==", (c) => c === 0], ["!=", (c) => c !== 0], ["<", (c) => c < 0],
  [">", (c) => c > 0], ["<=", (c) => c <= 0], [">=", (c) => c >= 0]]);

// -- Regexp ----------------------------------------------------------------

export class Range {
  start: number;
  end: number;

  constructor(start: number, end: number) {
    this.start = start; // first and last character, inclusive
    this.end = end;
  }
}

// One piece of a translated pattern: `written` is its text in a
// neutral translation (error positions count in that), `js` its text here.
type Piece = { kind: string; written: string; js: string; atoms?: Atom[]; offset?: number };
type Atom = { written: string; js: string; char: string; dash: boolean };

function pyEscape(c: string): string {
  return "()[]{}?*+-|^$\\.&~# \t\n\r\v\f".includes(c) ? "\\" + c : c;
}

function jsEscape(c: string, in_class = false): string {
  return "^$\\.*+?()[]{}|/".includes(c) || (in_class && c === "-") ? "\\" + c : c;
}

/** DXL's regular expressions in this engine's syntax (use the "u" flag; the
 * anchors are spelt out, so the "m" flag changes nothing). DXL documents only
 * * + . \ ^ $ ( ) [ ] |, so anything beyond those is either literal or refused. */
export function translate_regexp(source: string): string {
  return _translate(source).map((p) => p.js).join("");
}

function _translate(source: string): Piece[] {
  const chars = Array.from(source);
  const out: Piece[] = [];
  let i = 0, quantified = false;
  const literal = (c: string) => out.push({ kind: "literal", written: pyEscape(c), js: jsEscape(c) });
  while (i < chars.length) {
    const c = chars[i];
    const was_quantified = quantified;
    quantified = false;
    if (c === "\\") {
      if (i + 1 === chars.length) throw new Fault(`regexp ${py_repr(source)}: nothing after \\`);
      literal(chars[i + 1]);
      i += 2;
      continue;
    }
    if (c === "[") {
      i = _translate_class(source, chars, i, out);
      continue;
    }
    if (c === "?" || c === "{") {
      throw new Fault(`regexp ${py_repr(source)}: ${py_repr(c)} is not a documented DXL regexp symbol; `
        + "write \\\\ before it to match it literally");
    }
    if (c === "*" || c === "+") {
      if (was_quantified) throw new Fault(`regexp ${py_repr(source)}: two repeat symbols together`);
      quantified = true;
      out.push({ kind: c, written: c, js: c });
    } else if (c === "^") {
      if (i === 0 || "(|".includes(chars[i - 1])) {
        out.push({ kind: "anchor", written: "^", js: "(?<![^\\n])" }); // start of the text or of a line
      } else literal("^");
    } else if (c === "$") {
      if (i + 1 === chars.length || ")|".includes(chars[i + 1])) {
        out.push({ kind: "anchor", written: "\\Z", js: "(?![\\s\\S])" });
      } else literal("$");
    } else if (c === ".") {
      out.push({ kind: "literal", written: ".", js: "[^\\n]" });
    } else if (c === "(" || c === ")" || c === "|") {
      out.push({ kind: c, written: c, js: c });
    } else {
      literal(c);
    }
    i += 1;
  }
  _check_pattern(source, out);
  _unreliable_groups(source, out); // refuses what would match differently
  return out;
}

/** Translate the [...] starting at i; return the index after it. */
function _translate_class(source: string, chars: string[], i: number, out: Piece[]): number {
  let j = i + 1;
  let negated = "";
  if (chars[j] === "^") {
    negated = "^";
    j += 1;
  }
  const atoms: Atom[] = [];
  const atom = (c: string) => atoms.push({ written: pyEscape(c), js: jsEscape(c, true), char: c, dash: false });
  let first = true;
  while (j < chars.length && (chars[j] !== "]" || first)) {
    const c = chars[j];
    if (c === "\\" && j + 1 < chars.length) {
      j += 1;
      atom(chars[j]);
    } else if (c === "-" && !first && j + 1 < chars.length && chars[j + 1] !== "]") {
      atoms.push({ written: "-", js: "-", char: "-", dash: true });
    } else {
      atom(c);
    }
    first = false;
    j += 1;
  }
  if (j >= chars.length) throw new Fault(`regexp ${py_repr(source)}: missing ]`);
  out.push({
    kind: "class", atoms, offset: 1 + negated.length,
    written: "[" + negated + atoms.map((a) => a.written).join("") + "]",
    js: "[" + negated + atoms.map((a) => a.js).join("") + "]",
  });
  return j + 1;
}

/** Refuse patterns that cannot be given a certain meaning. */
function _check_pattern(source: string, pieces: Piece[]): void {
  const whole = Array.from(pieces.map((p) => p.written).join(""));
  const fail = (why: string, position: number): never => {
    let message = `regexp ${py_repr(source)}: ${why} at position ${position}`;
    if (whole.includes("\n")) {
      const before = whole.slice(0, position);
      message += ` (line ${before.filter((c) => c === "\n").length + 1}, `
        + `column ${position - before.lastIndexOf("\n")})`;
    }
    throw new Fault(message);
  };
  const open: number[] = [];
  let at = 0, previous = "";
  for (const piece of pieces) {
    const kind = piece.kind;
    if (kind === "*" || kind === "+") {
      if (previous === "" || previous === "(" || previous === "|" || previous === "anchor") {
        fail("nothing to repeat", at);
      }
    } else if (kind === "(") {
      open.push(at);
    } else if (kind === ")") {
      if (!open.length) fail("unbalanced parenthesis", at);
      open.pop();
    } else if (kind === "class") {
      const atoms = piece.atoms!;
      let p = at + piece.offset!; // where its first character starts
      for (let k = 0; k < atoms.length;) {
        const low = atoms[k];
        if (atoms[k + 1]?.dash && k + 2 < atoms.length) {
          const high = atoms[k + 2];
          if (high.char.codePointAt(0)! < low.char.codePointAt(0)!) {
            fail(`bad character range ${low.written}-${high.written}`, p);
          }
          p += Array.from(low.written + "-" + high.written).length;
          k += 3;
        } else {
          p += Array.from(low.written).length;
          k += 1;
        }
      }
    }
    previous = kind;
    at += Array.from(piece.written).length;
  }
  if (open.length) fail("missing ), unterminated subpattern", open[open.length - 1]);
}

type Group = {
  number: number; parent: Group | null; children: Group[];
  repeat: string; alternates: boolean; nullable: boolean;
};

/** Groups whose captured text engines disagree on:
 * those inside a repeated group that a later repetition may skip (JavaScript
 * forgets them, others keep the earlier text). A repeated group that can match
 * nothing changes what the whole pattern matches, so it is refused. */
function _unreliable_groups(source: string, pieces: Piece[]): Set<number> {
  const root: Group = { number: 0, parent: null, children: [], repeat: "", alternates: false, nullable: false };
  const groups: Group[] = [];
  // for each open group: can the current alternative, and any earlier one, match nothing?
  const stack = [{ group: root, branch: true, earlier: false }];
  for (let i = 0; i < pieces.length; i++) {
    const kind = pieces[i].kind;
    const top = stack[stack.length - 1];
    const next = pieces[i + 1]?.kind;
    if (kind === "(") {
      const group: Group = { number: groups.length + 1, parent: top.group, children: [],
        repeat: "", alternates: false, nullable: false };
      groups.push(group);
      top.group.children.push(group);
      stack.push({ group, branch: true, earlier: false });
    } else if (kind === ")") {
      const done = stack.pop()!;
      done.group.nullable = done.branch || done.earlier;
      done.group.repeat = next === "*" || next === "+" ? next : "";
      if (!done.group.nullable && next !== "*") stack[stack.length - 1].branch = false;
    } else if (kind === "|") {
      top.group.alternates = true;
      top.earlier = top.earlier || top.branch;
      top.branch = true;
    } else if ((kind === "literal" || kind === "class") && next !== "*") {
      top.branch = false;
    }
  }
  if (groups.some((g) => g.repeat && g.nullable)) {
    throw new Fault(`regexp ${py_repr(source)}: a repeated group that can match nothing is not supported here`);
  }
  const out = new Set<number>();
  for (const group of groups) {
    let skippable = false;
    for (let g: Group | null = group; g && g !== root; g = g.parent) {
      if (g.repeat && g !== group && skippable) out.add(group.number);
      skippable = skippable || g.repeat === "*" || (g.parent !== root && g.parent!.alternates);
    }
  }
  return out;
}

/** A compiled DXL regexp. */
export class Regexp {
  pattern: RegExp;
  unreliable: Set<number>;

  constructor(pattern: RegExp, unreliable: Set<number>) {
    this.pattern = pattern;
    this.unreliable = unreliable;
  }

  search(text: string): { found: RegExpExecArray; unreliable: Set<number> } | null {
    const found = this.pattern.exec(text);
    return found ? { found, unreliable: this.unreliable } : null;
  }
}

function _regexp(rt: any, source: string): Regexp {
  const pieces = _translate(source);
  let pattern: RegExp;
  try {
    pattern = new RegExp(pieces.map((p) => p.js).join(""), "du");
  } catch (e: any) {
    throw new Fault(`regexp ${py_repr(source)}: ${e.message}`);
  }
  return new Regexp(pattern, _unreliable_groups(source, pieces));
}

/** Remembers the match for match, start and end. */
function _apply_regexp(rt: any, pattern: any, text: string): boolean {
  const found = rt.need(pattern, "Regexp").search(text);
  rt.state.set("regexp", found);
  return found !== null;
}

function _search(rt: any, pattern: any, b: any, start: number, finish: number | null = null): boolean {
  const text = _text_of(rt, b);
  if (start < 0) throw new Fault("search: negative start");
  if (start > text.length) {
    rt.state.set("regexp", null);
    return false;
  }
  // offsets reported afterwards are relative to `start`, as documented
  return _apply_regexp(rt, pattern, text.slice(start, finish === null ? undefined : finish + 1));
}

function _group(rt: any, n: number): Range {
  const match = rt.state.get("regexp") ?? null;
  if (match === null) throw new Fault("there is no successful regular expression match");
  if (!(0 <= n && n <= Math.min(match.found.length - 1, 9))) {
    throw new Fault(`the regular expression has no match ${n}`);
  }
  if (match.unreliable.has(n)) {
    throw new Fault(`match ${n}: a group inside a repeated group is not supported here`);
  }
  const span = match.found.indices[n];
  return span === undefined ? new Range(0, -1) : new Range(span[0], span[1] - 1);
}

function _regexps(lib: any): void {
  lib.type("Regexp");
  lib.type("Range");
  lib.add("regexp", ["string"], "Regexp", _regexp);
  lib.add("regexp2", ["string"], "Regexp", _regexp);
  lib.juxta("Regexp", "string", "bool", _apply_regexp);
  lib.juxta("Regexp", "Buffer", "bool",
    (rt: any, pattern: any, b: any) => _apply_regexp(rt, pattern, _text_of(rt, b)));
  lib.add("matches", ["string", "string"], "bool",
    (rt: any, source: string, text: string) => _apply_regexp(rt, _regexp(rt, source), text));
  lib.add("search", ["Regexp", "Buffer", "int"], "bool", _search);
  lib.add("search", ["Regexp", "Buffer", "int", "int"], "bool", _search);
  lib.add("match", ["int"], "Range", _group);
  lib.add("start", ["int"], "int", (rt: any, n: number) => _group(rt, n).start);
  lib.add("end", ["int"], "int", (rt: any, n: number) => _group(rt, n).end);
  lib.add("delete", ["Regexp"], "void", (rt: any, pattern: any) => { });
  lib.index("string", "Range", "string", (rt: any, s: string, r: any) => _substring(s, r.start, r.end));
  lib.index("Buffer", "Range", "string",
    (rt: any, b: any, r: any) => _substring(_text_of(rt, b), r.start, r.end));
}

// -- Skip lists ------------------------------------------------------------

const IDS = new WeakMap<object, number>();

/** A number standing for an object's identity, in order of first use. */
function _id(value: object): number {
  let n = IDS.get(value);
  if (n === undefined) {
    n = _next_id++;
    IDS.set(value, n);
  }
  return n;
}

let _next_id = 1;

/** What stands for `value` as a Map key: store values that are compared by
 * value carry a `key`; so must a Wanted baseline. */
function _hash(value: any): any {
  if (value === null || typeof value !== "object") return value;
  const kind = value.constructor?.name;
  if (typeof value.key === "string") return `${kind}:${value.key}`;
  if (kind === "Wanted") return `${kind}:${JSON.stringify(value)}`;
  return value;
}

/** Keys come out in order. String keys need createString (see lookup). */
export class SkipList {
  string_keys: boolean;
  entries: Map<any, any[]>; // lookup key -> [Typed key, Typed data]
  key_type: string | null;
  current: any; // Typed key of the element a for loop is on
  deleted: boolean;

  constructor(string_keys: boolean) {
    this.string_keys = string_keys;
    this.entries = new Map();
    this.key_type = string_keys ? "string" : null;
    this.current = null;
    this.deleted = false;
  }

  live(): SkipList {
    if (this.deleted) throw new Fault("the Skip list has been deleted");
    return this;
  }

  lookup(key: any, adding = false): any {
    // The manual: a `create` list compares keys by address, so two equal strings
    // need not be the same key. Only createString compares their text.
    if (key.type === "string" && !this.string_keys) {
      throw new Fault("string keys in a Skip list made with create are compared by address in DOORS, "
        + "not by their text: make the list with createString");
    }
    if (this.key_type !== null && this.key_type !== key.type) {
      throw new Fault(`this Skip list has ${this.key_type} keys, not ${key.type}`);
    }
    if (adding) this.key_type = key.type;
    return _hash(key.value);
  }

  ordered(): any[][] {
    const pairs = [...this.entries.values()];
    return pairs.sort((a, b) => _key_order(a[0].value, b[0].value));
  }
}

function _key_order(a: any, b: any): number {
  if (typeof a === "string" && typeof b === "string") return compare_text(a, b);
  if (typeof a === "number" || typeof a === "boolean") return Number(a) - Number(b) || 0;
  if (a !== null && typeof a === "object" && "absno" in a) {
    return (a.module_id - b.module_id) || (a.absno - b.absno);
  }
  if (a !== null && typeof a === "object") return _id(a) - _id(b);
  return 0;
}

/** What a loop over a Skip list yields. The compiler reads `.value` as it
 * assigns the loop variable, which is when `key` has to move on. */
function _element(skip: SkipList, key: any, data: any): any {
  const element = Object.create(Typed.prototype);
  Object.defineProperties(element, {
    type: { value: data.type, enumerable: true },
    skip: { value: skip },
    key: { value: key },
    data: { value: data },
    value: {
      enumerable: true,
      get() {
        skip.current = key;
        return data.value;
      },
    },
  });
  return element;
}

function _skip(skip: any): SkipList {
  if (skip === null || skip === undefined) throw new Fault("null Skip");
  return skip.live();
}

function _put(rt: any, skip: any, key: any, data: any): boolean {
  const found = _skip(skip).lookup(key, true);
  if (skip.entries.has(found)) return false;
  skip.entries.set(found, [key, data]);
  return true;
}

function _find(rt: any, skip: any, key: any, into: any = null): boolean {
  const entry = _skip(skip).entries.get(skip.lookup(key));
  if (entry === undefined) return false;
  if (into !== null) {
    const data = entry[1];
    if (data.type !== into.type) throw new Fault(`find: the data is a ${data.type}, not a ${into.type}`);
    into.set(data.value);
  }
  return true;
}

function _delete_entry(rt: any, skip: any, key: any): boolean {
  return _skip(skip).entries.delete(skip.lookup(key));
}

function _delete_skip(rt: any, skip: any): void {
  _skip(skip).deleted = true;
}

function _key(rt: any, skip: any): any {
  if (_skip(skip).current === null) {
    throw new Fault("key is only meaningful inside a for loop over the Skip list");
  }
  return skip.current;
}

function _loop_skip(rt: any, skip: any): any[] {
  return _skip(skip).ordered().map(([key, data]) => _element(skip, key, data));
}

function _skips(lib: any): void {
  lib.type("Skip");
  lib.add("create", [], "Skip", (rt: any) => new SkipList(false));
  lib.add("createString", [], "Skip", (rt: any) => new SkipList(true));
  lib.add("put", ["Skip", "any", "any"], "bool", _put);
  lib.add("find", ["Skip", "any"], "bool", _find);
  lib.add("find", ["Skip", "any", "&any"], "bool", _find);
  lib.add("delete", ["Skip"], "void", _delete_skip);
  lib.add("delete", ["Skip", "any"], "bool", _delete_entry);
  lib.add("key", ["Skip"], "any", _key);
  lib.loop("Skip", "any", _loop_skip);
}

// -- Date ------------------------------------------------------------------

/** A calendar moment held in the UTC fields of a Date, so that no time zone
 * or summer time takes part in the arithmetic. */
function _datetime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): globalThis.Date | null {
  if (!(year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1
    && hour <= 23 && minute <= 59 && second <= 59)) return null;
  const moment = new globalThis.Date(0);
  moment.setUTCFullYear(year, month - 1, day);
  moment.setUTCHours(hour, minute, second, 0);
  return moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day ? moment : null;
}

export const EPOCH = new globalThis.Date(0);
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const TIME = `(?:${PY_SPACE}+(\\p{Nd}{1,2}):(\\p{Nd}\\p{Nd})(?::(\\p{Nd}\\p{Nd})(?:\\.\\p{Nd}+)?)?)?`;

const D = "\\p{Nd}";
const DATE_PATTERNS: [string, string][] = [
  [`(${D}{4})-(${D}{1,2})-(${D}{1,2})` + TIME, "ymd"],
  [`(${D}{1,2})/(${D}{1,2})/(${D}${D}|${D}{4})` + TIME, "mdy"],
  [`(${D}{1,2})[ -]([A-Za-z]+)[ -](${D}${D}|${D}{4})`, "dBy"],
  [`(${D}{4}),${PY_SPACE}*(${D}{1,2})${PY_SPACE}+([A-Za-z]+)`, "ydB"]];

const two = (n: number) => String(n).padStart(2, "0");

/** A DXL Date. `moment` is null for a null date; `show_time` selects the
 * short format with time. No time zones: calendar arithmetic only, so read
 * `moment` with its getUTC... methods. */
export class DxlDate {
  moment: globalThis.Date | null;
  show_time: boolean;

  constructor(moment: globalThis.Date | null = null, show_time = false) {
    this.moment = moment;
    this.show_time = show_time;
  }

  /** The date `text` spells, or null. Numeric dates with slashes are month
   * first (a US locale); DOORS reads them by the user's locale. */
  static parse(text: string): DxlDate | null {
    text = pyStrip(text);
    for (const [pattern, order] of DATE_PATTERNS) {
      const found = new RegExp(`^(?:${pattern})(?![\\s\\S])`, "u").exec(text);
      if (!found) continue;
      const groups = found.slice(1);
      const part: Record<string, string> = {};
      for (let i = 0; i < order.length; i++) part[order[i]] = groups[i];
      let month: number;
      if ("B" in part) {
        const name = part.B.toLowerCase();
        month = MONTHS.findIndex((m) => name === m.toLowerCase() || name === m.slice(0, 3).toLowerCase()) + 1;
      } else {
        month = toInt(part.m);
      }
      let day = toInt(part.d), year = toInt(part.y);
      if (part.y.length === 2) year += year >= 70 ? 1900 : 2000;
      const clock = order === "ymd" || order === "mdy" ? groups.slice(3) : [];
      const [hour, minute, second] = clock.length ? clock.map((x) => (x ? toInt(x) : 0)) : [0, 0, 0];
      const moment = _datetime(year, month, day, hour, minute, second);
      if (moment === null) return null;
      return new DxlDate(moment, Boolean(clock.length && clock[0]));
    }
    return null;
  }

  toString(): string {
    const m = this.moment;
    if (m === null) return "";
    if (this.show_time) {
      return `${two(m.getUTCMonth() + 1)}/${two(m.getUTCDate())}/${two(m.getUTCFullYear() % 100)} `
        + `${two(m.getUTCHours())}:${two(m.getUTCMinutes())}:${two(m.getUTCSeconds())}`;
    }
    return `${two(m.getUTCDate())} ${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}`;
  }

  format(layout: string): string {
    const m = this.moment!;
    const day = m.getUTCDate(), month = m.getUTCMonth() + 1, year = m.getUTCFullYear();
    const weekday = DAYS[(m.getUTCDay() + 6) % 7];
    const values = new Map<string, string>([
      ["d", String(day)], ["dd", two(day)],
      ["ddd", weekday.slice(0, 3)], ["dddd", weekday],
      ["M", String(month)], ["MM", two(month)],
      ["MMM", MONTHS[month - 1].slice(0, 3)], ["MMMM", MONTHS[month - 1]],
      ["yy", two(year % 100)], ["yyyy", String(year)]]);
    return layout.replace(/([A-Za-z])\1*/g, (found) => {
      const value = values.get(found);
      if (value === undefined) throw new Fault(`stringOf: unsupported date format ${py_repr(layout)}`);
      return value;
    });
  }
}

function _moment(date: any): globalThis.Date {
  if (date === null || date === undefined || date.moment === null) throw new Fault("null Date");
  return date.moment;
}

function _date(rt: any, text: string): DxlDate {
  const date = DxlDate.parse(text);
  if (date === null) throw new Fault(`${py_repr(text)} is not a valid date`);
  return date;
}

const DATE_TOKENS = new Map<string, string>([
  ["dddd", "[A-Za-z]+"], ["ddd", "[A-Za-z]+"],
  ["dd", `(?<d>${D}${D}?)`], ["d", `(?<d>${D}${D}?)`],
  ["MMMM", "(?<B>[A-Za-z]+)"], ["MMM", "(?<B>[A-Za-z]+)"],
  ["MM", `(?<m>${D}${D}?)`], ["M", `(?<m>${D}${D}?)`],
  ["yyyy", `(?<y>${D}{4})`], ["yy", `(?<y>${D}${D})`]]);

function _date_with_format(rt: any, text: string, layout: string): DxlDate {
  // Accept only what formatting with `layout` would produce (leading zeros aside).
  let pattern = "";
  const named = new Set<string>();
  let repeated = false;
  for (const piece of layout.matchAll(/([A-Za-z])\1*|[^A-Za-z]+/g)) {
    if (piece[1] && !DATE_TOKENS.has(piece[0])) {
      throw new Fault(`date: unsupported date format ${py_repr(layout)}`);
    }
    const part = piece[1] ? DATE_TOKENS.get(piece[0])! : piece[0].replace(SYNTAX, "\\$&");
    const name = piece[1] ? /^\(\?<(\w)>/.exec(part)?.[1] : undefined;
    if (name) {
      repeated = repeated || named.has(name);
      named.add(name);
    }
    pattern += part;
  }
  if (repeated) throw new Fault(`date: unsupported date format ${py_repr(layout)}`);
  const found = new RegExp(`^(?:${pattern})(?![\\s\\S])`, "u").exec(pyStrip(text));
  const part: Record<string, string> = found?.groups ?? {};
  if ("d" in part && "y" in part && ("m" in part || "B" in part)) {
    const month = part.B || MONTHS[(((toInt(part.m) - 1) % 12) + 12) % 12];
    if (!("m" in part) || (1 <= toInt(part.m) && toInt(part.m) <= 12)) {
      return _date(rt, `${part.d} ${month} ${part.y}`);
    }
  }
  throw new Fault(`date: ${py_repr(text)} does not match the format ${py_repr(layout)}`);
}

function _assign_date(rt: any, target: any, text: string): void {
  if (target === null || target === undefined) throw new Fault("null Date");
  const parsed = _date(rt, text);
  target.moment = parsed.moment;
  target.show_time = parsed.show_time;
}

function _clear_date(rt: any, target: any, _: any): void {
  if (target !== null && target !== undefined) {
    target.moment = null;
    target.show_time = false;
  }
}

function _from_attr_date(rt: any, raw: string): DxlDate {
  return raw ? _date(rt, raw) : new DxlDate();
}

function _int_of_date(rt: any, date: any): number {
  const moment = _moment(date);
  if (!(1970 <= moment.getUTCFullYear() && moment.getUTCFullYear() < 2037)) return -1;
  return Math.trunc((moment.getTime() - EPOCH.getTime()) / 1000);
}

function _today(rt: any): DxlDate {
  const now = new globalThis.Date();
  return new DxlDate(_datetime(now.getFullYear(), now.getMonth() + 1, now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds()));
}

function _date_only(rt: any, date: any): DxlDate {
  const moment = new globalThis.Date(_moment(date).getTime());
  moment.setUTCHours(0, 0, 0, 0);
  return new DxlDate(moment);
}

function _date_of_int(rt: any, secs: number): DxlDate {
  const moment = new globalThis.Date(secs * 1000);
  const year = moment.getUTCFullYear();
  if (!(year >= 1 && year <= 9999)) throw new Fault("dateOf: date value out of range");
  return new DxlDate(moment, true);
}

function _dates(lib: any): void {
  lib.type("Date", (rt: any, d: any) => (d === null || d === undefined ? "" : String(d)),
    (rt: any) => new DxlDate());
  lib.handles.delete("Date");

  const is_null = (date: any): boolean => date === null || date === undefined || date.moment === null;

  lib.add("null", ["Date"], "bool", (rt: any, d: any) => is_null(d));
  lib.operator("==", "Date", "null", "bool", (rt: any, d: any, _: any) => is_null(d));
  lib.operator("!=", "Date", "null", "bool", (rt: any, d: any, _: any) => !is_null(d));
  lib.operator("==", "null", "Date", "bool", (rt: any, _: any, d: any) => is_null(d));
  lib.operator("!=", "null", "Date", "bool", (rt: any, _: any, d: any) => !is_null(d));
  lib.operator("=", "Date", "string", "void", _assign_date);
  lib.operator("=", "Date", "null", "void", _clear_date);
  for (const [op, compare] of COMPARISONS) {
    lib.operator(op, "Date", "Date", "bool",
      (rt: any, a: any, b: any) => compare(Math.sign(_moment(a).getTime() - _moment(b).getTime())));
  }
  lib.from_attr.set("Date", _from_attr_date);

  lib.add("print", ["Date"], "void", (rt: any, d: any) => { rt.out.write(rt.text("Date", d)); });
  lib.add("today", [], "Date", _today);
  lib.add("date", ["string"], "Date", _date);
  lib.add("date", ["string", "string"], "Date", _date_with_format);
  lib.add("intOf", ["Date"], "int", _int_of_date);
  lib.add("dateOf", ["int"], "Date", _date_of_int);
  lib.add("stringOf", ["Date"], "string", (rt: any, d: any) => rt.text("Date", d));
  lib.add("stringOf", ["Date", "string"], "string", (rt: any, d: any, layout: string) => {
    _moment(d);
    return layout ? d.format(layout) : String(d);
  });
  lib.add("includesTime", ["Date"], "bool", (rt: any, d: any) => { _moment(d); return d.show_time; });
  lib.add("dateOnly", ["Date"], "Date", _date_only);
  lib.add("dateAndTime", ["Date"], "Date", (rt: any, d: any) => new DxlDate(_moment(d), true));
}

// -- the user's locale ------------------------------------------------------

/** The one locale here: the one dates are already read and written in. A
 * function given it does what it does when no locale is given. */
const USER_LOCALE = Object.freeze({ locale: "user" });

function _locales(lib: any): void {
  lib.type("Locale");
  lib.add("userLocale", [], "Locale", () => USER_LOCALE);
  const given = (rt: any, l: any) => { rt.need(l, "Locale"); };
  lib.add("stringOf", ["Date", "Locale"], "string", (rt: any, d: any, l: any) => {
    given(rt, l);
    return rt.text("Date", d);
  });
  lib.add("stringOf", ["Date", "Locale", "string"], "string", (rt: any, d: any, l: any, layout: string) => {
    given(rt, l);
    _moment(d);
    return layout ? d.format(layout) : String(d);
  });
  lib.add("date", ["string", "Locale"], "Date", (rt: any, text: string, l: any) => {
    given(rt, l);
    return _date(rt, text);
  });
  lib.add("date", ["string", "Locale", "string"], "Date", (rt: any, text: string, l: any, layout: string) => {
    given(rt, l);
    return _date_with_format(rt, text, layout);
  });
}

// -- Stream files ----------------------------------------------------------

/** Text with every line ending "\n" (Files.readText has already
 * dropped the byte order mark). */
function _decoded(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** An open file on the virtual disk. Writes reach it on flush and close (or
 * every 8192 characters), as a buffered file's do. */
export class _File {
  files: any;
  path: string;
  closed: boolean;
  _text: string; // what a reader reads, taken when it is opened
  _at: number;
  _pending: string;

  constructor(files: any, path: string, mode: string) {
    this.files = files;
    this.path = path;
    this.closed = false;
    this._text = "";
    this._at = 0;
    this._pending = "";
    if (mode === "r") this._text = _decoded(files.readText(path));
    else if (mode === "w") files.writeText(path, "");
    else files.appendText(path, "");
  }

  readline(): string {
    const end = this._text.indexOf("\n", this._at);
    const line = this._text.slice(this._at, end < 0 ? undefined : end + 1);
    this._at += line.length;
    return line;
  }

  read1(): string {
    if (this._at >= this._text.length) return "";
    const c = String.fromCodePoint(this._text.codePointAt(this._at)!);
    this._at += c.length;
    return c;
  }

  write(value: string): void {
    this._pending += value;
    if (this._pending.length >= 8192) this.flush();
  }

  flush(): void {
    if (this.closed || !this._pending) return;
    // a file deleted or renamed while open stays gone
    if (this.files.exists(this.path)) this.files.appendText(this.path, this._pending);
    this._pending = "";
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}

export class Stream {
  file: _File;
  reading: boolean;
  eof: boolean; // a read has run into the end of the file

  constructor(files: any, path: string, mode: string) {
    this.file = new _File(files, path, mode);
    this.reading = mode === "r";
    this.eof = false;
  }

  line(): string {
    const line = this.file.readline();
    if (!line.endsWith("\n")) this.eof = true;
    return line.endsWith("\n") ? line.slice(0, -1) : line;
  }

  char(): string {
    const c = this.file.read1();
    if (!c) this.eof = true;
    return c || "\0";
  }
}

function _stream(stream: any, reading: boolean | null = null): Stream {
  if (stream === null || stream === undefined || stream.file.closed) {
    throw new Fault("the Stream is not open");
  }
  if (reading !== null && stream.reading !== reading) {
    throw new Fault("the Stream is not open for " + (reading ? "reading" : "writing"));
  }
  return stream;
}

function _opener(mode: string) {
  return (rt: any, path: string): Stream => {
    const full = mode === "r" ? rt.files.read(path) : rt.files.write(path);
    const stream = new Stream(rt.files, full, mode);
    rt.closers.push(() => stream.file.close());
    return stream;
  };
}

function _write(rt: any, stream: any, value: string): any {
  _stream(stream, false).file.write(value);
  return stream;
}

function _reader(take: (s: Stream) => any) {
  return (rt: any, stream: any, ref: any) => {
    ref.set(take(_stream(stream, true)));
    return stream;
  };
}

function _read_into_buffer(rt: any, stream: any, b: any): any {
  _buffer(b).text = _stream(stream, true).line();
  return stream;
}

function _read_file(rt: any, path: string): string {
  return _decoded(rt.files.readText(rt.files.read(path)));
}

/** `->` is `>=` without the leading white space. */
function _read_trimmed(rt: any, stream: any, b: any): any {
  _buffer(b).text = _stream(stream, true).line().replace(/^[ \t\r\x0b\x0c]+/, "");
  return stream;
}

/** Windows' number for UTF-8, the one code page offered: files here are UTF-8. */
const CP_UTF8 = 65001;

function _utf8(page: number): void {
  if (page !== CP_UTF8) throw new Fault("only the CP_UTF8 code page is supported here");
}

/** Operations that report failure as a message and success as null. */
function _file_operation(action: (files: any, ...paths: string[]) => void, reads_first = false) {
  return (rt: any, ...given: string[]): string => {
    const paths = given.map((p, i) => (reads_first && i === 0 ? rt.files.read(p) : rt.files.write(p)));
    try {
      action(rt.files, ...paths);
    } catch (e: any) {
      if (!(e instanceof OSError)) throw e;
      return e.strerror || String(e);
    }
    return "";
  };
}

/** Asks only: the file is left as it was. */
function _can_open(rt: any, path: string, for_write: boolean): boolean {
  try {
    const full = for_write ? rt.files.write(path) : rt.files.read(path);
    const existed = rt.files.exists(full);
    if (for_write) {
      rt.files.appendText(full, "");
      if (!existed) rt.files.remove(full);
    } else {
      rt.files.readText(full);
    }
    return true;
  } catch (e) {
    if (e instanceof OSError || e instanceof Fault) return false;
    throw e;
  }
}

function _temp_file_name(rt: any): string {
  let hex = "";
  for (let i = 0; i < 10; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return join_path(rt.files.gettempdir(), "DOORS" + hex);
}

function _streams(lib: any): void {
  lib.type("Stream");
  lib.add("CP_UTF8", [], "int", () => CP_UTF8);
  for (const [name, mode] of [["read", "r"], ["write", "w"], ["append", "a"]]) {
    const open = _opener(mode);
    lib.add(name, ["string"], "Stream", open);
    lib.add(name, ["string", "int"], "Stream",
      (rt: any, path: string, page: number) => { _utf8(page); return open(rt, path); });
  }
  lib.add("close", ["Stream"], "void", (rt: any, s: any) => _stream(s).file.close());
  lib.add("format", ["Stream", "string", "int"], "void", _format);
  lib.add("flush", ["Stream"], "void", (rt: any, s: any) => _stream(s).file.flush());
  lib.add("end", ["Stream"], "bool", (rt: any, s: any) => _stream(s).eof);
  lib.add("of", ["Stream"], "Stream", (rt: any, s: any) => s); // `if end of input then`
  lib.operator("<<", "Stream", "string", "Stream", _write);
  lib.operator("<<", "Stream", "char", "Stream", _write);
  lib.operator("<<", "Stream", "Buffer", "Stream",
    (rt: any, s: any, b: any) => _write(rt, s, _text_of(rt, b)));
  lib.operator(">>", "Stream", "string", "Stream", _reader((s) => s.line()));
  lib.operator(">>", "Stream", "char", "Stream", _reader((s) => s.char()));
  lib.operator(">>", "Stream", "int", "Stream", _reader((s) => _int_of_string(null, s.line())));
  lib.operator(">>", "Stream", "real", "Stream", _reader((s) => _real_of_string(null, s.line())));
  lib.operator(">=", "Stream", "Buffer", "Stream", _read_into_buffer);
  lib.operator("->", "Stream", "Buffer", "Stream", _read_trimmed);
  lib.add("readFile", ["string"], "string", _read_file);
  lib.add("readFile", ["string", "int"], "string",
    (rt: any, path: string, page: number) => { _utf8(page); return _read_file(rt, path); });
  lib.add("canOpenFile", ["string", "bool"], "bool", _can_open);
  lib.add("deleteFile", ["string"], "string",
    _file_operation((files, path) => files.remove(path)));
  lib.add("renameFile", ["string", "string"], "string",
    _file_operation((files, a, b) => files.rename(a, b)));
  lib.add("copyFile", ["string", "string"], "string",
    _file_operation((files, a, b) => files.copy(a, b), true));
  lib.add("tempFileName", [], "string", _temp_file_name);
  lib.add("currentDirectory", [], "string", (rt: any) => rt.files.getcwd());
  lib.add("mkdir", ["string"], "void", (rt: any, path: string) => rt.files.mkdir(path));
  lib.add("directory", ["string"], "Directory_", (rt: any, path: string) => rt.files.read(path));
  lib.loop("Directory_", "string", (rt: any, path: string) => rt.files.list(path));
}

// -- status handles -----------------------------------------------------------

/** What is at a path, as far as this suite can tell: a folder or a file. */
type Status = { folder: boolean };

function _status(rt: any, path: string): Status | null {
  const full = rt.files.read(path); // refuses a path outside what a script may read
  if (!rt.files.exists(full)) return null;
  return { folder: rt.files.isdir(full) };
}

function _live_status(s: Status | null): Status {
  if (s === null) throw new Fault("null Stat handle");
  return s;
}

/** The existence, folder and file tests. Dates, sizes, owners and modes would
 * not be those of the computer DOORS runs on, so they are not offered. */
function _statuses(lib: any): void {
  lib.type("Stat");
  lib.add("create", ["string"], "Stat", _status);
  lib.add("delete", ["Stat"], "void", () => {});
  lib.add("directory", ["Stat"], "bool", (_rt: any, s: Status | null) => _live_status(s).folder);
  lib.add("regular", ["Stat"], "bool", (_rt: any, s: Status | null) => !_live_status(s).folder);
}

// -- dynamic arrays --------------------------------------------------------

/** DXL's two-dimensional `Array`. It grows to wherever something is put. */
export class DynamicArray {
  cells: Map<string, Typed> = new Map(); // "x,y" -> what was put there
  deleted: boolean = false;
}

function _array(array: any): DynamicArray {
  if (array === null || array === undefined) throw new Fault("null Array");
  if (array.deleted) throw new Fault("the Array has been deleted");
  return array;
}

function _place(x: number, y: number): string {
  if (x < 0 || y < 0) throw new Fault(`Array position (${x}, ${y}): neither may be negative`);
  return `${x},${y}`;
}

function _held(array: any, x: number, y: number): Typed {
  const found = _array(array).cells.get(_place(x, y));
  if (!found) throw new Fault(`nothing has been put at Array position (${x}, ${y})`);
  return found;
}

function _arrays(lib: any): void {
  lib.type("Array");
  lib.add("create", ["int", "int"], "Array", (rt: any, x: number, y: number) => {
    if (x < 1 || y < 1) throw new Fault("Array create: both bounds must be at least 1");
    return new DynamicArray();
  });
  lib.add("put", ["Array", "any", "int", "int"], "void",
    (rt: any, a: any, data: Typed, x: number, y: number) => { _array(a).cells.set(_place(x, y), data); });
  lib.add("get", ["Array", "int", "int"], "any", (rt: any, a: any, x: number, y: number) => {
    const found = _held(a, x, y);
    return new Typed(found.type, found.value);
  });
  // a string stored one char to a place along x, and read back with a length
  lib.add("putString", ["Array", "string", "int", "int"], "void",
    (rt: any, a: any, text: string, x: number, y: number) => {
      for (let i = 0; i < text.length; i++) _array(a).cells.set(_place(x + i, y), new Typed("char", text[i]));
    });
  lib.add("get", ["Array", "int", "int", "int"], "string", (rt: any, a: any, x: number, y: number, length: number) => {
    if (length < 0) throw new Fault("get: negative length");
    let out = "";
    for (let i = 0; i < length; i++) {
      const found = _held(a, x + i, y);
      if (found.type !== "char") throw new Fault(`get: Array position (${x + i}, ${y}) does not hold a char`);
      out += found.value;
    }
    return out;
  });
  lib.add("delete", ["Array"], "void", (rt: any, a: any) => { _array(a).deleted = true; });
}

// The manual shows only that a space becomes "_". What DOORS does with any other
// doubtful character is its platform's business and not documented, so stop there.
function good_file_name(_rt: any, name: string): string {
  const found = /[^A-Za-z0-9_ -]/u.exec(name);
  if (found) throw new Fault(`goodFileName: what DOORS makes of ${py_repr(found[0])} is not documented`);
  if (!name || name.length > 200) throw new Fault("goodFileName: what DOORS makes of an empty or very long name is not documented");
  return name.replace(/ /g, "_");
}

export function register(lib: any): void {
  _strings(lib);
  _math(lib);
  _buffers(lib);
  _regexps(lib);
  _skips(lib);
  _dates(lib);
  _streams(lib);
  _statuses(lib);
  _locales(lib);
  _arrays(lib);
}
