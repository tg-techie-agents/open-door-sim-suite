// Lexer and parser for the supported DXL subset.
//
// Juxtaposition (`f x`, `a "b"`) is left as a flat ["juxta", line, [items]] node;
// only types can say whether it is a call or a concatenation, so the checker
// decides. Nodes are arrays: [kind, line, ...].

import { unavailable } from "./unavailable.ts";

export type Node = any[];

export class DxlError extends Error {
  line: number;
  file: string | null;
  constructor(line: number, message: string, file: string | null = null) {
    super(message);
    this.name = "DxlError";
    this.line = line;
    this.file = file;
  }
  /** The message with its place. */
  toString(): string {
    const where = this.file ? `${this.file}, ` : "";
    return `${where}line ${this.line}: ${this.message}`;
  }
}

/** `text` in quotes with escapes, as error messages show it. */
export function py_repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const c of text) {
    if (c === "\\" || c === quote) out += "\\" + c;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c !== " " && /[\p{C}\p{Z}]/u.test(c)) {
      const n = c.codePointAt(0)!;
      const hex = n.toString(16);
      out += n <= 0xff ? "\\x" + hex.padStart(2, "0")
        : n <= 0xffff ? "\\u" + hex.padStart(4, "0") : "\\U" + hex.padStart(8, "0");
    } else out += c;
  }
  return quote + out + quote;
}

// Every DXL type name this engine knows. A library file may only declare types listed here.
export const TYPES: Set<string> = new Set(["int", "string", "bool", "char", "real", "void",
  "Object", "Module", "Link", "LinkRef", "ModName_", "Stream", "AttrDef", "AttrType",
  "Buffer", "Skip", "Regexp", "Date", "Range", "Folder", "Project", "Item",
  "Baseline", "History", "HistoryType", "AttrBaseType", "View", "Column", "Filter", "Sort", "Array",
  "LinkFilter", "ModuleVersion", "Justification", "Stat", "Locale", "LinkModuleDescriptor", "Linkset", "Permission", "AccessRec", "BaselineSetDefinition", "BaselineSet", "HistorySession", "ConfType", "ConfStream",
  "ViewDef",
  "DB", "DBE", "Icon", "Sensitivity"]);
// Reserved by the manual; none may name a variable or function.
export const RESERVED: Set<string> = new Set(
  ("and bool break by case char const continue default do else enum for if in int "
    + "module object or pragma real return sizeof static struct string switch then union "
    + "void while").split(" "));

export class Token {
  kind: string; // name, int, real, string, char, op, nl, end
  text: string;
  line: number;
  spaced: boolean; // whitespace before it
  constructor(kind: string, text: string, line: number, spaced: boolean) {
    this.kind = kind;
    this.text = text;
    this.line = line;
    this.spaced = spaced;
  }
}

const TOKEN = new RegExp([
  String.raw`(?<space>[ \t\r]+)`,
  String.raw`(?<block>\/\*.*?\*\/)`,
  String.raw`(?<comment>\/\/[^\n]*)`,
  String.raw`(?<nl>\n)`,
  String.raw`(?<include>#include[ \t]*(?:"[^"\n]*"|<[^>\n]*>))`,
  String.raw`(?<hashpragma>#pragma[^\n]*)`,
  String.raw`(?<real>\d+\.\d+(?:[eE][+\-]?\d+)?|\d+[eE][+\-]?\d+)`,
  String.raw`(?<int>0[xX][0-9A-Fa-f]+|0[bB][01]+|\d+)`,
  String.raw`(?<name>[A-Za-z_][A-Za-z0-9_']*)`,
  // a string may run over lines; a backslash at the end of a line has no documented meaning
  String.raw`(?<string>"(?:[^"\\]|\\[^\r\n])*")`,
  String.raw`(?<char>'(?:[^'\\\n]|\\[0-7]{1,3}|\\[^\r\n])')`,
  // operators DXL has and this engine does not: refused by name
  String.raw`(?<missing><<=|>>=|\^\^|\^=|<>|:=|=>|\.\.|\\)`,
  String.raw`(?<op><<|>>|<-|->|<\?|>\?|<=|>=|==|!=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|\|=|&=|[|~^\-+*\/%<>=!\(\)\{\}\[\],;.:&?])`,
].join("|"), "suy");

// A newline after one of these continues the statement.
export const CONTINUES: Set<string> = new Set(["<<", ">>", "*=", "/=", "%=", "|=", "&=", "<-", "->", "<=", ">=", "==", "!=", "&&",
  "||", "|", "&", "^", "+=", "-=", "+", "-", "*", "/", "%", "<", ">", "=", "!", "(", "[", "{", ",", "and", "or",
  "?", ":", ".", "~"]);

export function continues(token: Token): boolean {
  return (token.kind === "op" || token.kind === "name") && CONTINUES.has(token.text);
}

export const ESCAPES: Map<string, string> = new Map([["n", "\n"], ["t", "\t"], ["r", "\r"], ["b", "\b"],
  ["f", "\f"]]);

export function unescape(body: string): string {
  return body.replace(/\\([0-7]{1,3}|[^\n])/gu, (_, c) =>
    /^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ESCAPES.get(c) ?? c);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0, line = 1, spaced = false, join = false;
  while (pos < source.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(source);
    if (source.startsWith("/*", pos) && !m?.groups?.block) throw new DxlError(line, "this /* comment is never closed");
    if (!m) {
      const seen = Array.from(source.slice(pos, pos + 20)).slice(0, 10).join("");
      throw new DxlError(line, source[pos] === '"' ? `this string is never closed: ${py_repr(seen)}`
        : `cannot read ${py_repr(seen)}`);
    }
    let kind = "";
    for (const name in m.groups) if (m.groups[name] !== undefined) { kind = name; break; }
    let text = m[0];
    if (kind === "missing") {
      // after `::` the parser names the definition it refuses
      if (tokens.slice(-2).map((t) => t.text).join("") !== "::") {
        throw new DxlError(line, `${text} is a DXL operator this practice suite does not offer (reason: not built)`);
      }
      kind = "op";
      text = text[0];
      TOKEN.lastIndex = pos + 1;
    }
    pos = TOKEN.lastIndex;
    if (kind === "space" || kind === "block") {
      spaced = true;
    } else if (kind === "hashpragma") {
      spaced = true;
    } else if (kind === "include") {
      const open = text.trim().slice(8).trim()[0];
      tokens.push(new Token("include", text.slice(text.indexOf(open) + 1, -1), line, spaced));
    } else if (kind === "comment") {
      join = text.length === 2 || text.trimEnd().endsWith("-");
    } else if (kind === "nl") {
      const last = tokens[tokens.length - 1];
      if (!join && last && last.kind !== "nl" && !continues(last)) {
        tokens.push(new Token("nl", "\n", line, spaced));
      }
      spaced = true;
      join = false;
    } else {
      if (tokens.length && tokens[tokens.length - 1].kind === "nl" && (kind === "op" || kind === "name")
        && (text === ")" || text === "else")) {
        tokens.pop();
      }
      if (kind === "string" || kind === "char") text = unescape(text.slice(1, -1).replace(/\r\n/g, "\n"));
      tokens.push(new Token(kind, text, line, spaced));
      spaced = false;
    }
    for (let i = m[0].indexOf("\n"); i >= 0; i = m[0].indexOf("\n", i + 1)) line++;
  }
  tokens.push(new Token("end", "", line, true));
  return tokens;
}

export const BINARY: string[][] = [["||", "or"], ["&&", "and"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"],
  ["*", "/", "%"], ["<?", ">?"]];

/** Minimum and maximum. Where they bind beside other operators is not documented. */
const EXTREMES: Set<string> = new Set(["<?", ">?"]);

/** The operators a script may define for its own types of operand. */
export const OVERLOADABLE: Set<string> = new Set(["+", "-", "*", "/", "%", "==", "!=", "<", ">", "<=", ">="]);

export class Parser {
  tokens: Token[];
  i: number;

  constructor(source: string) {
    this.tokens = tokenize(source);
    this.i = 0;
  }

  // -- token helpers -------------------------------------------------------

  get tok(): Token {
    return this.tokens[this.i];
  }

  peek(n: number = 1): Token {
    return this.tokens[Math.min(this.i + n, this.tokens.length - 1)];
  }

  next(): Token {
    const tok = this.tok;
    this.i += 1;
    return tok;
  }

  at(...texts: string[]): boolean {
    const tok = this.tok;
    return (tok.kind === "op" || tok.kind === "name") && texts.includes(tok.text);
  }

  accept(text: string): Token | null {
    return this.at(text) ? this.next() : null;
  }

  expect(text: string): Token {
    return this.accept(text) ?? this.fail(`expected ${py_repr(text)}`);
  }

  fail(message: string): never {
    const tok = this.tok;
    const found = tok.kind === "nl" ? "end of line" : tok.kind === "end" ? "end of script" : py_repr(tok.text);
    throw new DxlError(tok.line, `${message}, found ${found}`);
  }

  skip_newlines(): void {
    while (this.tok.kind === "nl" || this.at(";")) this.next();
  }

  // -- statements ----------------------------------------------------------

  program(): Node[] {
    const body: Node[] = [];
    this.skip_newlines();
    while (this.tok.kind !== "end") {
      body.push(this.statement());
      this.skip_newlines();
    }
    return body;
  }

  end_statement(): void {
    if (this.tok.kind === "nl" || this.tok.kind === "end" || this.at(";")) {
      this.skip_newlines();
    } else if (!(this.at("}", "else", "elseif") || this.tokens[this.i - 1].text === "}")) {
      if (this.at(",")) {
        throw new DxlError(this.tok.line, "a comma list after a call written without parentheses is not offered: "
          + "DXL reads `f a, b` as `(f a), b`. Use parentheses, or one statement for each value");
      }
      this.fail("expected end of statement");
    }
  }

  body(): Node {
    while (this.tok.kind === "nl") this.next();
    // `if (x) ;`: the statement is empty, and what follows is not part of it
    if (this.at(";")) return ["block", this.next().line, []];
    return this.statement();
  }

  statement(): Node {
    const line = this.tok.line;
    if (this.accept("{")) {
      const items: Node[] = [];
      this.skip_newlines();
      while (!this.accept("}")) {
        if (this.tok.kind === "end") this.fail("expected '}'");
        items.push(this.statement());
        this.skip_newlines();
      }
      return ["block", line, items];
    }
    if (this.tok.kind === "include") {
      const name = this.next().text;
      this.end_statement();
      return ["include", line, name];
    }
    if (this.at("switch", "struct", "union", "enum")) {
      throw new DxlError(line, `${this.tok.text} is a word DXL reserves but DOORS does not support in scripts`);
    }
    if (this.accept("const")) return this.statement();
    if (this.accept("if") || this.accept("elseif")) {
      let cond: Node;
      if (this.at("(")) {
        cond = this.parenthesised();
        this.accept("then");
      } else {
        cond = this.expression();
        this.expect("then");
      }
      const then = this.body();
      const mark = this.i;
      this.skip_newlines();
      if (this.at("elseif")) return ["if", line, cond, then, this.statement()];
      if (this.accept("else")) return ["if", line, cond, then, this.body()];
      this.i = mark;
      return ["if", line, cond, then, null];
    }
    if (this.accept("while")) {
      let cond: Node;
      if (this.at("(")) {
        cond = this.parenthesised();
        this.accept("do");
      } else {
        cond = this.expression();
        this.expect("do");
      }
      return ["while", line, cond, this.body()];
    }
    if (this.accept("for")) return this.for_statement(line);
    if (this.accept("pragma")) {
      const name = this.next().text;
      this.expect(",");
      this.expression();
      // The file has been decoded before it gets here, so `encoding` has nothing left to do.
      if (name !== "runLim" && name !== "stack" && name !== "encoding") throw new DxlError(line, `unsupported pragma ${name}`);
      this.end_statement();
      return ["block", line, []];
    }
    for (const word of ["break", "continue"]) {
      if (this.accept(word)) {
        this.end_statement();
        return [word, line];
      }
    }
    if (this.accept("return")) {
      const value = this.tok.kind === "nl" || this.tok.kind === "end" || this.at("}", ";")
        ? null : this.expression();
      this.end_statement();
      return ["return", line, value];
    }
    if (this.tok.kind === "name" && TYPES.has(this.tok.text)) {
      const then = this.peek();
      if (then.kind === "name") return this.declaration(line);
      if (then.text === "&" && this.peek(2).kind === "name") return this.reference_declaration(line);
      if (then.text === ":" && this.peek(2).text === ":") return this.operator_function(line);
    }
    const node = this.simple();
    this.end_statement();
    return node;
  }

  simple(): Node {
    const line = this.tok.line;
    const target = this.expression();
    for (const op of ["=", "+=", "-=", "*=", "/=", "%=", "|=", "&="]) {
      if (this.accept(op)) {
        const value = this.simple();
        if (value[0] === "expr") return ["assign", line, op, target, value[2]];
        return ["chain", line, op, target, value];
      }
    }
    return ["expr", line, target];
  }

  for_statement(line: number): Node {
    if (this.at("(")) {
      this.next();
      const init = this.at(";") ? null : this.simple();
      this.expect(";");
      const cond = this.at(";") ? null : this.expression();
      this.expect(";");
      const step = this.at(")") ? null : this.simple();
      this.expect(")");
      return ["cfor", line, init, cond, step, this.body()];
    }
    if (this.tok.kind !== "name") this.fail("expected a loop variable");
    const var_ = this.next().text;
    this.expect("in");
    let source = this.ternary(); // not expression(): the arrow belongs to the loop
    if (this.at("->", "<-")) {
      const arrow = this.next().text;
      source = ["links", line, arrow, source, this.ternary()];
    } else if (this.accept(":")) {
      const stop = this.expression();
      const step = this.accept("by") ? this.expression() : ["int", line, 1];
      source = ["range", line, source, stop, step];
    }
    this.expect("do");
    return ["forin", line, var_, source, this.body()];
  }

  /** `int& z = x`: another name for a variable. */
  reference_declaration(line: number): Node {
    const type_name = this.next().text;
    this.next(); // &
    const name = this.next().text;
    if (!this.accept("=")) this.fail("a reference needs '=' and the variable it names");
    const target = this.expression();
    if (this.at(",")) this.fail("declare one reference in each statement");
    this.end_statement();
    return ["reference", line, type_name, name, target];
  }

  /** `string ::*(string s, int n) {...}`: a function that is an operator. */
  operator_function(line: number): Node {
    const type_name = this.next().text;
    this.next(); // :
    this.next(); // :
    const op = this.next().text;
    if (!OVERLOADABLE.has(op)) {
      throw new DxlError(line, `defining the operator ::${op === "." ? ".." : op} is not offered`);
    }
    return this.function(line, type_name, "::" + op);
  }

  declaration(line: number): Node {
    const type_name = this.next().text;
    let name = this.next().text;
    if (this.at("(")) return this.function(line, type_name, name);
    const items: any[] = [];
    for (;;) {
      let array = false, size: Node | null = null, init: any = null;
      if (this.accept("[")) {
        array = true;
        if (!this.at("]")) size = this.expression();
        this.expect("]");
      }
      if (this.accept("=")) {
        if (array) {
          this.expect("{");
          this.skip_newlines();
          init = this.at("}") ? [] : [this.expression()];
          while (this.accept(",")) init.push(this.expression());
          this.skip_newlines();
          this.expect("}");
        } else {
          init = this.expression();
        }
      } else if (array && size === null) {
        this.fail("an array needs a size or a {...} initialiser");
      }
      items.push([name, array, init, size]);
      if (!this.accept(",")) break;
      name = this.next().text;
    }
    this.end_statement();
    return ["declare", line, type_name, items];
  }

  /** params are [type name, name, by reference, is array]. */
  function(line: number, return_type: string, name: string): Node {
    this.expect("(");
    const params: any[] = [];
    let type_name: string | null = null;
    if (this.at("void") && this.peek().text === ")") this.next(); // `f(void)` takes nothing
    while (!this.accept(")")) {
      if (TYPES.has(this.tok.text)) type_name = this.next().text;
      const by_ref = Boolean(this.accept("&"));
      const missing = this.tok.kind === "name" ? unavailable(this.tok.text) : null;
      if (type_name === null && missing) throw new DxlError(this.tok.line, missing);
      if (type_name === null || this.tok.kind !== "name") this.fail("expected 'type name'");
      const param = this.next().text;
      const array = Boolean(this.accept("["));
      if (array) this.expect("]");
      params.push([type_name, param, by_ref, array]);
      if (!this.at(")")) this.expect(",");
    }
    // A `;` or the end of the line with no `{` to follow makes a forward declaration.
    let closed = false;
    while (this.tok.kind === "nl" || this.at(";")) closed = this.next().text === ";" || closed;
    if (!closed && this.at("{")) return ["function", line, return_type, name, params, this.statement()];
    if (closed || this.tokens[this.i - 1].kind === "nl" || this.tok.kind === "end") {
      return ["forward", line, return_type, name, params];
    }
    return this.fail("expected '{'");
  }

  // -- expressions ---------------------------------------------------------

  parenthesised(): Node {
    this.expect("(");
    const inner = this.expression();
    this.expect(")");
    return inner;
  }

  expression(): Node {
    let node = this.ternary();
    while (this.at("<<", ">>", "->", "<-")) {
      const tok = this.next();
      node = ["binary", tok.line, tok.text, node, this.ternary()];
    }
    return node;
  }

  ternary(): Node {
    const cond = this.binary(0);
    if (this.at("?")) {
      const line = this.next().line;
      const yes = this.ternary();
      this.expect(":");
      return ["ternary", line, cond, yes, this.ternary()];
    }
    return cond;
  }

  binary(level: number): Node {
    if (level === BINARY.length) return this.unary();
    let node = this.binary(level + 1);
    while (this.at(...BINARY[level])) {
      const tok = this.next();
      const op = tok.text === "or" ? "||" : tok.text === "and" ? "&&" : tok.text;
      const right = this.binary(level + 1);
      if ([node, right].some((n) => n[0] === "binary" && EXTREMES.has(n[2]))) {
        throw new DxlError(tok.line, "put parentheses around <? and >? when another operator is beside them");
      }
      node = ["binary", tok.line, op, node, right];
    }
    return node;
  }

  unary(): Node {
    if (this.at("!", "-", "~")) {
      const tok = this.next();
      return ["unary", tok.line, tok.text, this.unary()];
    }
    return this.juxtaposition();
  }

  starts_operand(): boolean {
    const tok = this.tok;
    if (tok.kind === "int" || tok.kind === "real" || tok.kind === "string" || tok.kind === "char") return true;
    if (tok.kind === "name") return !["and", "or", "do", "then", "else", "elseif", "in", "by"].includes(tok.text);
    // `print "n " ++i`: the sign sits against its name and apart from what is before it
    if (tok.kind === "op" && (tok.text === "++" || tok.text === "--")) {
      return tok.spaced && this.peek().kind === "name" && !this.peek().spaced;
    }
    return tok.kind === "op" && tok.text === "(";
  }

  juxtaposition(): Node {
    const line = this.tok.line;
    const items = [this.operand()];
    while (this.starts_operand()) items.push(this.operand());
    return items.length === 1 ? items[0] : ["juxta", line, items];
  }

  /** A postfix expression, perhaps with ++ or -- in front of it. */
  operand(): Node {
    if (this.at("++", "--")) {
      const tok = this.next();
      return ["prefix", tok.line, tok.text, this.postfix()];
    }
    return this.postfix();
  }

  postfix(): Node {
    let node = this.primary();
    for (;;) {
      if (this.at(".")) {
        const line = this.next().line;
        node = ["attr", line, node, this.primary()];
      } else if (this.at("[")) {
        const line = this.next().line;
        const start = this.expression();
        let stop: Node | null = null, is_range = false;
        if (this.accept(":")) {
          is_range = true;
          stop = this.at("]") ? null : this.expression();
        }
        this.expect("]");
        node = is_range ? ["slice", line, node, start, stop] : ["index", line, node, start];
      } else if (this.at("++", "--") && (!this.tok.spaced || this.nothing_follows())) {
        const tok = this.next();
        node = ["postfix", tok.line, tok.text, node];
      } else if (this.at("(") && !this.tok.spaced && node[0] === "name") {
        node = ["call", node[1], node[2], this.arguments()];
      } else {
        return node;
      }
    }
  }

  /** After the next token the expression must end, so `i ++` can only be postfix. */
  nothing_follows(): boolean {
    const after = this.peek();
    return after.kind === "nl" || after.kind === "end" || (after.kind === "op" && [";", "}", ")"].includes(after.text));
  }

  arguments(): Node[] {
    this.expect("(");
    const args: Node[] = [];
    while (!this.accept(")")) {
      args.push(this.expression());
      if (!this.at(")")) this.expect(",");
    }
    return args;
  }

  primary(): Node {
    const tok = this.tok;
    if (tok.kind === "int") {
      this.next();
      const text = tok.text.toLowerCase();
      let value: number;
      if (text.startsWith("0x") || text.startsWith("0b")) value = Number(text);
      else if (text.length > 1 && text[0] === "0") {
        if (/[89]/.test(text)) throw new DxlError(tok.line, "a leading 0 means octal in DXL, which has no 8 or 9");
        value = parseInt(text, 8);
      } else value = Number(text);
      if (value > 2147483647) throw new DxlError(tok.line, `${tok.text} does not fit in a 32-bit DXL int`);
      return ["int", tok.line, value];
    }
    if (tok.kind === "real" || tok.kind === "string" || tok.kind === "char") {
      this.next();
      return [tok.kind, tok.line, tok.kind === "real" ? Number(tok.text) : tok.text];
    }
    if (tok.kind === "name") {
      this.next();
      if (tok.text === "true" || tok.text === "false") return ["bool", tok.line, tok.text === "true"];
      if (tok.text === "sizeof") return ["sizeof", tok.line, this.postfix()];
      if (tok.text === "current" && this.at("Module", "Object", "Folder", "Project")) {
        return ["current", tok.line, this.next().text];
      }
      return ["name", tok.line, tok.text];
    }
    if (this.at("(")) {
      this.next();
      const args = [this.expression()];
      // `(buf += "a") += "b"`: inside parentheses += is a value
      if (this.at("+=")) {
        const line = this.next().line;
        const appended = ["append", line, args[0], this.expression()];
        this.expect(")");
        return ["group", tok.line, appended];
      }
      while (this.accept(",")) args.push(this.expression());
      this.expect(")");
      return args.length === 1 ? ["group", tok.line, args[0]] : ["tuple", tok.line, args];
    }
    return this.fail("expected a value");
  }
}
