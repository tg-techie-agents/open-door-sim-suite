// Rich text: the formatting of a String or Text value, and the RTF-like markup
// DOORS writes it in. Pure functions, shared by the store, DXL, files and GUI.
//
// A value's text stays plain everywhere. Formatting is a second, optional thing:
// the canonical markup of the same text, which only `Store` holds.
//
// Markup understood (anything else is refused, never guessed):
//   {\b ..} {\i ..} {\ul ..} {\strike ..} {\sub ..} {\super ..} {\nosupersub ..}
//   \b0 \i0    \{ \} \\    a line break (or \par) ends a paragraph
//   \pard      \liN indent (twips)    {\*\pn..\pnlvlblt..} bullet
//   \fiN and {\pntext ..} are accepted and carry nothing

export const BOLD = 1, ITALIC = 2, UNDERLINE = 4, STRIKE = 8, SUB = 16, SUPER = 32;
export type Run = { text: string; style: number };
export type Para = { bullet: boolean; indent: number; runs: Run[] };
export type Doc = Para[]; // never empty

export const INDENT_STEP = 360; // twips; DOORS indents in these units

/** `broken`: the braces or escapes do not make sense at all; otherwise the
 * markup may be good DOORS rich text that is not understood here. */
export class RichError extends Error {
  broken: boolean;
  constructor(message: string, broken: boolean = false) {
    super(message);
    this.name = "RichError";
    this.broken = broken;
  }
  toString(): string {
    return this.message;
  }
}

// [style bit, control word], in the order the groups are nested
const WORDS: readonly (readonly [number, string])[] = [
  [BOLD, "b"], [ITALIC, "i"], [UNDERLINE, "ul"], [STRIKE, "strike"], [SUB, "sub"], [SUPER, "super"]];
const LISTED = new Set(["b", "i", "ul", "strike", "sub", "super", "nosupersub", "par", "pard", "li", "fi"]);

type Token = { at: number; end: number } & (
  | { kind: "char"; ch: string }
  | { kind: "open" } | { kind: "close" } | { kind: "star" }
  | { kind: "word"; word: string; number: number | null });

function tokens(markup: string): Token[] {
  const out: Token[] = [];
  const word = /\\([A-Za-z]+)(-?\d+)? ?/y;
  for (let at = 0; at < markup.length;) {
    const c = markup[at];
    if (c === "{" || c === "}") {
      out.push({ kind: c === "{" ? "open" : "close", at, end: ++at });
    } else if (c === "\r" && markup[at + 1] === "\n") {
      out.push({ kind: "char", ch: "\n", at, end: at += 2 });
    } else if (c !== "\\") {
      const ch = String.fromCodePoint(markup.codePointAt(at)!);
      out.push({ kind: "char", ch, at, end: at += ch.length });
    } else {
      const next = markup[at + 1];
      if (next === undefined) throw new RichError("rich text ending in a single \\ is not supported", true);
      word.lastIndex = at;
      const found = word.exec(markup);
      if (found) {
        out.push({ kind: "word", word: found[1], number: found[2] === undefined ? null : Number(found[2]),
                   at, end: at = word.lastIndex });
      } else if (next === "\\" || next === "{" || next === "}") {
        out.push({ kind: "char", ch: next, at, end: at += 2 });
      } else if (next === "*") {
        out.push({ kind: "star", at, end: at += 2 });
      } else {
        out.push({ kind: "word", word: next, number: null, at, end: at += 2 });
      }
    }
  }
  return out;
}

function closing(list: Token[], open: number): number {
  for (let i = open, depth = 0; i < list.length; i++) {
    if (list[i].kind === "open") depth++;
    else if (list[i].kind === "close" && --depth === 0) return i;
  }
  throw new RichError("rich text with a { that is never closed is not supported", true);
}

// A group that stands for list furniture rather than text: its last token index
// and whether it makes the paragraph a bullet. Null: an ordinary group.
function furniture(list: Token[], open: number): { end: number; bullet: boolean } | null {
  const first = list[open + 1], second = list[open + 2];
  if (first?.kind === "word" && first.word === "pntext") return { end: closing(list, open), bullet: false };
  if (first?.kind !== "star") return null;
  const end = closing(list, open);
  const inside = list.slice(open + 2, end);
  if (second?.kind !== "word" || second.word !== "pn"
      || !inside.some((t) => t.kind === "word" && t.word === "pnlvlblt")) {
    throw new RichError("rich text with a \\* group other than a bulleted list is not supported here");
  }
  return { end, bullet: true };
}

type Shown = { at: number; end: number; ch: string };

function walk(markup: string): { doc: Doc; shown: Shown[] } {
  const list = tokens(markup);
  const doc: Doc = [], shown: Shown[] = [], outer: number[] = [];
  let style = 0, bullet = false, indent = 0, runs: Run[] = [];
  let broke: "" | "par" | "line" = ""; // what the token before was, if a break
  const add = (ch: string) => {
    const last = runs[runs.length - 1];
    if (last && last.style === style) last.text += ch;
    else runs.push({ text: ch, style });
  };
  const end_paragraph = () => {
    doc.push({ bullet, indent, runs });
    runs = [];
  };
  const refuse = (what: string): never => {
    throw new RichError(`rich text markup ${what} is not supported here`);
  };
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    let now: "" | "par" | "line" = "";
    if (t.kind === "open") {
      const skip = furniture(list, i);
      if (skip) {
        if (skip.bullet) bullet = true;
        i = skip.end;
      } else outer.push(style);
    } else if (t.kind === "close") {
      if (!outer.length) throw new RichError("rich text with a } that closes nothing is not supported", true);
      style = outer.pop()!;
    } else if (t.kind === "star") {
      refuse("\\*");
    } else if (t.kind === "char") {
      if (t.ch === "\n") now = "line";
      if (now && broke === "par") refuse("\\par beside a line break");
      shown.push({ at: t.at, end: t.end, ch: t.ch });
      if (t.ch === "\n") end_paragraph();
      else add(t.ch);
    } else {
      const { word, number } = t;
      const name = `\\${word}${number ?? ""}`;
      const bit = WORDS.find(([, w]) => w === word)?.[0];
      if (bit !== undefined) {
        if (number === 0 && (word === "b" || word === "i")) style &= ~bit;
        else if (number !== null) refuse(name);
        else {
          if (bit === SUB) style &= ~SUPER;
          if (bit === SUPER) style &= ~SUB;
          style |= bit;
        }
      } else if (word === "nosupersub" && number === null) {
        style &= ~(SUB | SUPER);
      } else if (word === "par" && number === null) {
        if (broke === "line") refuse("\\par beside a line break");
        now = "par";
        shown.push({ at: t.at, end: t.end, ch: "\n" });
        end_paragraph();
      } else if (word === "pard" && number === null) {
        bullet = false;
        indent = 0;
      } else if (word === "li" && number !== null && number >= 0) {
        indent = number;
      } else if (word !== "fi") {
        refuse(name);
      }
    }
    broke = now;
  }
  if (outer.length) throw new RichError("rich text with a { that is never closed is not supported", true);
  end_paragraph();
  return { doc, shown };
}

export function parse(markup: string): Doc {
  return walk(markup).doc;
}

export function plain_of(doc: Doc): string {
  return doc.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

/** The text with no formatting at all. */
export function doc_of(text: string): Doc {
  return text.split("\n").map((line) => ({ bullet: false, indent: 0, runs: line ? [{ text: line, style: 0 }] : [] }));
}

export function is_formatted(doc: Doc): boolean {
  return doc.some((p) => p.bullet || p.indent > 0 || p.runs.some((r) => r.style !== 0));
}

/** Plain text written as rich text markup. */
export function escape_text(text: string): string {
  return text.replace(/[\\{}]/g, "\\$&");
}

/** As escape_text, but leaving what is already escaped as it is. */
export function escape_unescaped(text: string): string {
  return text.replace(/\\[\\{}]|[\\{}]/g, (found) => found.length > 1 ? found : "\\" + found);
}

function groups(runs: Run[]): string {
  let out = "";
  for (let i = 0; i < runs.length;) {
    if (!runs[i].style) {
      out += escape_text(runs[i++].text);
      continue;
    }
    let bit = 0, word = "", end = i;
    for (const [b, w] of WORDS) {
      if (!(runs[i].style & b)) continue;
      let j = i;
      while (j < runs.length && runs[j].style & b) j++;
      if (j > end) [bit, word, end] = [b, w, j];
    }
    const inside: Run[] = [];
    for (const run of runs.slice(i, end)) {
      const style = run.style & ~bit, last = inside[inside.length - 1];
      if (last && last.style === style) last.text += run.text;
      else inside.push({ text: run.text, style });
    }
    out += `{\\${word} ${groups(inside)}}`;
    i = end;
  }
  return out;
}

/** The one way a document is written: reading it back gives the same document. */
export function markup_of(doc: Doc): string {
  let bullet = false, indent = 0;
  return doc.map((p) => {
    let head = "";
    if (p.bullet !== bullet || p.indent !== indent) {
      ({ bullet, indent } = p);
      head = "\\pard" + (bullet ? "{\\*\\pn\\pnlvlblt}" : "") + (indent ? `\\li${indent}` : "");
      if (!head.endsWith("}")) head += " ";
    }
    return head + groups(p.runs);
  }).join("\n");
}

// -- what the DXL loops give ---------------------------------------------------

export type Chunk = { text: string; style: number; newline: boolean; last: boolean; bullet: boolean; indent: number };
export type Paragraph = { text: string; bullet: boolean; indent: number; chunks: Chunk[] };

/** Paragraphs and their chunks. A final line break ends the last paragraph
 * rather than starting an empty one. */
export function paragraphs(markup: string): Paragraph[] {
  const doc = parse(markup);
  const count = doc.length - (doc[doc.length - 1].runs.length ? 0 : 1);
  const out = doc.slice(0, count).map((p, at) => {
    const runs = p.runs.length ? p.runs : [{ text: "", style: 0 }];
    return {
      text: p.runs.map((r) => r.text).join(""), bullet: p.bullet, indent: p.indent,
      chunks: runs.map((r, i) => ({
        text: r.text, style: r.style, newline: i === runs.length - 1 && at < doc.length - 1, last: false,
        bullet: p.bullet, indent: p.indent,
      })),
    };
  });
  const final = out[out.length - 1]?.chunks;
  if (final) final[final.length - 1].last = true;
  return out;
}

// -- editing the markup itself ---------------------------------------------------

/** Whether it reads as rich text at all; throws where that cannot be told. */
export function is_rich_text(markup: string): boolean {
  try {
    walk(markup);
    return true;
  } catch (error) {
    if (error instanceof RichError && error.broken) return false;
    throw error;
  }
}

/** Where `sub` first shows, as a position and length in the markup, or null. */
export function find(markup: string, sub: string, match_case: boolean): [number, number] | null {
  const { shown } = walk(markup);
  const wanted = Array.from(sub);
  if (!wanted.length) throw new RichError("searching rich text for an empty string is not documented");
  const fold = (c: string) => match_case ? c : c.toLowerCase();
  for (let i = 0; i + wanted.length <= shown.length; i++) {
    if (wanted.every((c, k) => fold(shown[i + k].ch) === fold(c))) {
      return [shown[i].at, shown[i + wanted.length - 1].end - shown[i].at];
    }
  }
  return null;
}

export function replace(markup: string, offset: number, length: number, text: string): string {
  const { shown } = walk(markup);
  if (/[\\{}\r\n]/.test(text)) {
    throw new RichError("a replacement containing \\ { } or a line break is not documented");
  }
  const end = offset + length;
  const inside = shown.filter((c) => c.at >= offset && c.end <= end);
  if (!inside.length || inside[0].at !== offset || inside[inside.length - 1].end !== end
      || inside.some((c) => c.ch === "\n")) {
    throw new RichError("replacing anything but a run of shown characters within a line is not documented");
  }
  // within one stretch of formatting the replacement can be any length
  if (inside.every((c, i) => i === 0 || inside[i - 1].end === c.at)) {
    return markup.slice(0, offset) + text + markup.slice(end);
  }
  const given = Array.from(text);
  if (given.length !== inside.length) {
    throw new RichError("how a replacement of another length takes formatting that changes part way is not documented");
  }
  let out = "", done = 0;
  inside.forEach((c, i) => {
    out += markup.slice(done, c.at) + given[i];
    done = c.end;
  });
  return out + markup.slice(done);
}

/** Without the shown characters `start` to `end`, counted from 0, both included. */
export function cut(markup: string, start: number, end: number): string {
  const { shown } = walk(markup);
  if (start < 0 || end < start || end >= shown.length) {
    throw new RichError(`what cutting characters ${start} to ${end} of ${shown.length} gives is not documented`);
  }
  let out = "", done = 0;
  for (const c of shown.slice(start, end + 1)) {
    out += markup.slice(done, c.at);
    done = c.end;
  }
  return out + markup.slice(done);
}

/** Without the control words DOORS does not list; the rest untouched. */
export function remove_unlisted(markup: string): string {
  const list = tokens(markup);
  let out = "", done = 0, depth = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.kind === "open") {
      const skip = furniture(list, i);
      if (skip) i = skip.end;
      else depth++;
    } else if (t.kind === "close") {
      if (--depth < 0) throw new RichError("rich text with a } that closes nothing is not supported", true);
    } else if (t.kind === "word" && !LISTED.has(t.word)) {
      if (/^(rtf|fonttbl|colortbl|stylesheet|info|object|pict|field|')$/.test(t.word)) {
        throw new RichError(`rich text with \\${t.word} (a whole RTF document or embedded data) is not supported here`);
      }
      out += markup.slice(done, t.at);
      done = t.end;
    }
  }
  if (depth) throw new RichError("rich text with a { that is never closed is not supported", true);
  return out + markup.slice(done);
}

/** Sets bullet and indent on one paragraph (counted from 1) or, for 0, all. */
export function format_paragraphs(markup: string, bullet: boolean, indent: number, number: number): string {
  const doc = parse(markup);
  if (indent < 0 || indent % INDENT_STEP) {
    throw new RichError(`an indent that is not a multiple of ${INDENT_STEP} twips is not documented`);
  }
  if (number < 0 || number > doc.length) {
    throw new RichError(`paragraph ${number} of ${doc.length}: what DOORS does then is not documented`);
  }
  doc.forEach((p, i) => {
    if (!number || number === i + 1) Object.assign(p, { bullet, indent });
  });
  return markup_of(doc);
}

// -- editing by position in the plain text -------------------------------------

type Format = { bullet: boolean; indent: number };
// one UTF-16 unit of the plain text, with its paragraph's formatting
type Spot = Format & { ch: string; style: number };

function spots(doc: Doc): Spot[] {
  const out: Spot[] = [];
  doc.forEach(({ bullet, indent, runs }, at) => {
    for (const run of runs) {
      for (let i = 0; i < run.text.length; i++) out.push({ ch: run.text[i], style: run.style, bullet, indent });
    }
    if (at < doc.length - 1) out.push({ ch: "\n", style: 0, bullet, indent });
  });
  return out;
}

function from_spots(list: Spot[], tail: Format): Doc {
  const doc: Doc = [];
  let runs: Run[] = [], first: Format | null = null;
  for (const spot of list) {
    first ??= spot;
    if (spot.ch === "\n") {
      doc.push({ bullet: first.bullet, indent: first.indent, runs });
      runs = [];
      first = null;
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && last.style === spot.style) last.text += spot.ch;
    else runs.push({ text: spot.ch, style: spot.style });
  }
  const { bullet, indent } = first ?? tail;
  doc.push({ bullet, indent, runs });
  return doc;
}

/** The part of a document that shows plain_of(doc).slice(from, to). */
export function slice(doc: Doc, from: number, to: number): Doc {
  const list = spots(doc);
  return from_spots(list.slice(from, to), list[to] ?? doc[doc.length - 1]);
}

/** Text in place of the characters `from` to `to`, formatted as the first of them. */
export function splice(doc: Doc, from: number, to: number, text: string): Doc {
  const list = spots(doc);
  const { style, bullet, indent } = list[from] ?? list[list.length - 1] ?? { ...doc[0], style: 0 };
  list.splice(from, to - from, ...Array.from({ length: text.length }, (_, i) => (
    { ch: text[i], style: text[i] === "\n" ? 0 : style, bullet, indent })));
  return from_spots(list, doc[doc.length - 1]);
}

/** A document that came from outside as data, checked field by field. */
export function checked_doc(given: unknown): Doc {
  const bad = (): never => {
    throw new RichError("this formatted text is not supported");
  };
  if (!Array.isArray(given) || !given.length) bad();
  return (given as any[]).map((p) => {
    if (!p || !Array.isArray(p.runs)) bad();
    const indent = Number.isInteger(p.indent) && p.indent >= 0 ? p.indent : bad();
    const runs = (p.runs as any[]).map((r) => {
      if (typeof r?.text !== "string" || /[\r\n]/.test(r.text) || !Number.isInteger(r.style)
          || r.style < 0 || r.style > 63 || (r.style & SUB && r.style & SUPER)) bad();
      return { text: r.text, style: r.style };
    }).filter((r) => r.text);
    return { bullet: p.bullet === true, indent, runs };
  });
}

/** A document from a text and the formatting of each of its characters. */
export function doc_from(text: string, formats: readonly (Format & { style: number })[]): Doc {
  return from_spots(Array.from({ length: text.length }, (_, i) => (
    { ...formats[i], ch: text[i], style: text[i] === "\n" ? 0 : formats[i].style })), { bullet: false, indent: 0 });
}
