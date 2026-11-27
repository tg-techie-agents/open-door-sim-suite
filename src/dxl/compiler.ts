// Type-check a whole script, then run it.
//
// DXL is statically typed: DOORS rejects a bad script before any of it runs, so
// this does too. Each expression compiles to a list of alternatives
// [type, closure]; overloads and juxtaposition produce several, and the context
// picks the one it needs. Two that fit is an error asking for parentheses, since
// guessing which DOORS would choose could make a wrong script look right.
//
// A closure takes `env`: [globals Map, locals Map], keyed by Var.
//
// The compiler knows the language only. Every DOORS function, type, loop and
// operator comes from the Library (see registry.ts).

import { other_forms, unavailable } from "./unavailable.ts";
import { StoreError } from "../store.ts";
import { here_text } from "./lib/session.ts";
import { OSError, join_path, normpath } from "./files.ts";
import { Overload, key, same_params } from "./registry.ts";
import type { Library } from "./registry.ts";
import { AttrRef, Callback, Ellipsis, Fault, IndexError, OverflowError, Ref, Runtime, Typed, ValueError, compare_text, equals, is_limit } from "./runtime.ts";
import { DxlError, Parser, RESERVED, TYPES, py_repr } from "./syntax.ts";
import type { Node } from "./syntax.ts";

export type Env = [Map<Var, any>, Map<Var, any>];
export type Fn = (env: Env) => any;
export type Cand = [string, Fn];

export const BASE: readonly string[] = ["string", "int", "real", "char", "bool"];
/** What `null` assigned to each base type leaves in the variable. */
const NULL_VALUES: { [type: string]: any } = { string: "", int: 0, real: 0, bool: false, char: "\0" };
const BASE_DEFAULTS: Map<string, any> = new Map<string, any>(
  [["int", 0], ["real", 0], ["bool", false], ["char", "\0"], ["string", ""]]);
const CURRENT: Map<string, string> = new Map(
  [["Module", "module"], ["Object", "object"], ["Folder", "folder"], ["Project", "folder"]]);

export class Var {
  name: string;
  type: string;
  is_global: boolean;
  by_ref: boolean;
  constructor(name: string, type_name: string, is_global: boolean, by_ref: boolean = false) {
    this.name = name;
    this.type = type_name;
    this.is_global = is_global;
    this.by_ref = by_ref;
  }
}

// The name for it here. Inside this file it hides JavaScript's own Function.
export class Function {
  name: string;
  params: string[];
  return_type: string;
  body: Fn | null = null;
  param_vars: Var[] = [];
  constructor(name: string, params: string[], return_type: string) {
    this.name = name;
    this.params = params;
    this.return_type = return_type;
  }
}

/** Two readings fit. Never swallowed while trying overloads. */
export class Ambiguous extends DxlError {
  constructor(line: number, message: string, file: string | null = null) {
    super(line, message, file);
    this.name = "Ambiguous";
  }
}

// Control flow, not errors: no stack to capture.
export class Break {}
export class Continue {}
export class Return {
  value: any;
  constructor(value: any) {
    this.value = value;
  }
}

/** A compiled argument: its alternatives and, for a plain variable, how to
 * get a reference to it. */
export class Arg {
  cands: Cand[];
  ref: Fn | null;
  temporary: boolean; // may be used at once, not kept
  functions: Function[] | null; // for a script function's name: what a callback may take
  constructor(cands: Cand[], ref: Fn | null = null, temporary: boolean = false, functions: Function[] | null = null) {
    this.cands = cands;
    this.ref = ref;
    this.temporary = temporary;
    this.functions = functions;
  }
}

export function constant(type_name: string, value: any): Cand {
  return [type_name, () => value];
}

export function show(cands: Cand[]): string {
  const names = new Map([["attr", "attribute value"], ["null", "null"], ["any", "value of unknown type"]]);
  const shown = new Set(cands.map(([t]) => names.get(t) ?? t.replace(/_+$/, "")));
  return [...shown].sort(compare_text).join(" or ") || "nothing";
}

export function is_stack_overflow(e: any): boolean {
  // No regex literals here: this runs with the stack nearly full, where V8
  // fails to compile one (and says so with a SyntaxError "... Stack overflow").
  const message = String(e?.message);
  return (e instanceof RangeError && (message.includes("call stack") || message.includes("stack size")))
    || (e instanceof SyntaxError && message.includes("Stack overflow"))
    || (e?.name === "InternalError" && message.includes("recursion"));
}

const FAILURES = new Set(["OSError", "ValueError", "OverflowError", "IndexError"]);

/** What a library function may raise that becomes a run-time error. */
/** Mark each `dxlHere()` that a print statement shows as it is, joined only to
 * text: `print dxlHere() "\n"`, `print "at " dxlHere()`, `print(dxlHere() "")`. */
function mark_printed_here(expr: Node): void {
  let parts: Node[];
  if (expr[0] === "juxta" && expr[2][0][0] === "name" && expr[2][0][2] === "print") parts = expr[2].slice(1);
  else if (expr[0] === "call" && expr[2] === "print" && expr[3].length === 1) {
    parts = expr[3][0][0] === "juxta" ? expr[3][0][2] : [expr[3][0]];
  } else return;
  const here = (n: Node) => n[0] === "call" && n[2] === "dxlHere" && n[3].length === 0;
  parts.forEach((part, i) => {
    // after anything but text, it could be that thing's argument
    if (here(part) && (i === 0 || parts[i - 1][0] === "string" || here(parts[i - 1]))) (part as any).printed = true;
  });
}

function library_failure(e: any): boolean {
  if (e instanceof OSError || e instanceof ValueError || e instanceof OverflowError || e instanceof IndexError) {
    return true;
  }
  if (e instanceof RangeError) return !is_stack_overflow(e);
  return e instanceof Error && (FAILURES.has(e.name) || FAILURES.has(e.constructor.name));
}

/** A whole or real number read from attribute text; null if it is not one. */
function number_of(raw: string, kind: "int" | "real"): number | null {
  const text = raw.trim();
  const digits = String.raw`\d(?:_?\d)*`;
  const pattern = kind === "int" ? `^[+-]?${digits}$`
    : `^[+-]?(?:inf(?:inity)?|nan|(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:e[+-]?${digits})?)$`;
  if (!new RegExp(pattern, "i").test(text)) return null;
  const plain = text.replace(/_/g, "").replace(/inf(inity)?$/i, "Infinity").replace(/^[+-]?nan$/i, "NaN");
  const value = Number(plain);
  return kind === "int" ? value + 0 : value;
}

export class Compiler {
  rt: Runtime;
  lib: Library;
  scopes: Array<Map<string, Var | Function[]>>;
  function: Function | null; // the Function being compiled
  loops: number;
  including: Set<string>;
  file: string | null = null; // the included file being compiled
  forwards: Map<Function, [number, string | null]> = new Map(); // declared, body not yet seen: [line, file]

  constructor(runtime: Runtime) {
    this.rt = runtime;
    this.lib = runtime.lib;
    this.scopes = [new Map()];
    this.function = null;
    this.loops = 0;
    this.including = new Set();
  }

  // -- names ---------------------------------------------------------------

  lookup(name: string): Var | Function[] | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i].get(name);
      if (found !== undefined) return found;
    }
    return null;
  }

  check_name(line: number, name: string): void {
    if (RESERVED.has(name) || TYPES.has(name)) throw new DxlError(line, `${name} is a reserved word`);
    if (name.startsWith("_")) throw new DxlError(line, `${name}: a DXL name must begin with a letter`);
  }

  declare(line: number, name: string, type_name: string, by_ref: boolean = false): Var {
    this.check_name(line, name);
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) throw new DxlError(line, `${name} is already declared`);
    const var_ = new Var(name, type_name, this.function === null, by_ref);
    scope.set(name, var_);
    return var_;
  }

  static slot(var_: Var): 0 | 1 {
    return var_.is_global ? 0 : 1;
  }

  load(line: number, var_: Var): Fn {
    const where = Compiler.slot(var_);
    return (env) => {
      const values = env[where];
      if (!values.has(var_)) throw new DxlError(line, `variable ${var_.name} has no value yet`);
      const value = values.get(var_);
      return var_.by_ref ? value.get() : value;
    };
  }

  store_to(var_: Var): (env: Env, value: any) => void {
    const where = Compiler.slot(var_);
    return (env, value) => {
      if (var_.by_ref) env[where].get(var_).set(value);
      else env[where].set(var_, value);
    };
  }

  /** env -> Ref for `var_`. */
  reference(line: number, var_: Var): Fn {
    const where = Compiler.slot(var_), get = this.load(line, var_), put = this.store_to(var_);
    return (env) => {
      if (var_.by_ref) return env[where].get(var_);
      return new Ref(var_.type, () => get(env), (value) => put(env, value));
    };
  }

  // -- choosing among alternatives -----------------------------------------

  /** The one closure among `cands` that yields a `want`. */
  coerce(line: number, cands: Cand[], want: string, attr_ok: boolean = false): Fn {
    if (want === "any") return this.anything(line, cands);
    let hits = cands.filter(([t]) => t === want).map(([, fn]) => fn);
    const nulls = () => cands.filter(([t]) => t === "null");
    if (!hits.length && this.lib.handles.has(want)) hits = nulls().map(([, fn]) => fn);
    if (!hits.length && attr_ok && BASE.includes(want)) {
      hits = nulls().map(() => constant(want, this.lib.defaults.has(want)
        ? this.lib.defaults.get(want)!(this.rt) : BASE_DEFAULTS.get(want))[1]);
    }
    if (!hits.length && attr_ok) {
      const convert = this.from_attr(want);
      if (convert) hits = cands.filter(([t]) => t === "attr").map(([, fn]) => convert(fn));
    }
    if (hits.length === 1) return hits[0];
    if (hits.length) throw new Ambiguous(line, "ambiguous expression: add parentheses");
    let hint = cands.some(([t]) => t === "attr")
      ? ' (append "" to an attribute value to make it a string)' : "";
    if (cands.some(([t]) => t === "any")) hint = ` (cast it, e.g. (${want} key skipList))`;
    throw new DxlError(line, `expected ${want}, got ${show(cands)}${hint}`);
  }

  anything(line: number, cands: Cand[]): Fn {
    const usable = cands.filter(([t]) => t !== "void" && t !== "null");
    if (usable.length > 1) {
      throw new Ambiguous(line, "ambiguous expression: cast it, e.g. (string x), or add parentheses");
    }
    if (!usable.length) throw new DxlError(line, `expected a value, got ${show(cands)}`);
    const [t, fn] = usable[0];
    if (t === "any") return fn;
    if (t === "attr") return (env) => new Typed("string", fn(env).get());
    return (env) => new Typed(t, fn(env));
  }

  static checked(fn: Fn, want: string): Fn {
    return (env) => {
      const typed = fn(env);
      if (typed === null || typed === undefined) throw new Fault(`there is no ${want} value here`);
      if (typed.type !== want) throw new Fault(`expected a ${want} but the value is a ${typed.type}`);
      return typed.value;
    };
  }

  /** How an attribute's text becomes `want`, or null if it cannot. */
  from_attr(want: string): ((fn: Fn) => Fn) | null {
    const rt = this.rt;

    const no_value = (kind: string): never => {
      throw new Fault(`the attribute has no value, and what DOORS gives a ${kind} then is not documented; `
        + 'test it first, e.g. if (!null o."Name" "")');
    };
    const number = (raw: string, kind: "int" | "real") => {
      if (!raw) no_value(kind);
      const value = number_of(raw, kind);
      if (value === null) throw new Fault(`attribute value ${py_repr(raw)} is not a number`);
      return value;
    };
    const boolean = (raw: string) => {
      if (!raw) no_value("bool");
      if (raw === "True" || raw === "False") return raw === "True";
      throw new Fault(`attribute value ${py_repr(raw)} is not a boolean`);
    };

    const converters = new Map<string, (raw: string) => any>([
      ["string", (raw) => raw], ["int", (raw) => number(raw, "int")],
      ["real", (raw) => number(raw, "real")], ["bool", boolean]]);
    let convert = converters.get(want);
    if (!convert) {
      const registered = this.lib.from_attr.get(want);
      if (!registered) return null;
      convert = (raw: string) => registered(rt, raw);
    }
    const chosen = convert;
    return (fn) => (env) => chosen(fn(env).get());
  }

  /** Coercion for assignment, which (unlike arithmetic) converts an int to a real. */
  assigned(line: number, cands: Cand[], want: string): Fn {
    if (want === "real" && !cands.some(([t]) => t === "real") && cands.some(([t]) => t === "int")) {
      return this.coerce(line, cands, "int", true);
    }
    return this.coerce(line, cands, want, true);
  }

  value(node: Node, want: string, attr_ok: boolean = false): Fn {
    return this.coerce(node[1], this.expr(node), want, attr_ok);
  }

  // -- expressions ---------------------------------------------------------

  expr(node: Node): Cand[] {
    const cands: Cand[] = (this as any)["e_" + node[0]](node);
    if (!cands.length) {
      throw new DxlError(node[1], "incorrect arguments or concatenation"
        + (node[0] === "juxta" ? ' (when joining values, end with a string, such as "" or "\\n")' : ""));
    }
    return cands;
  }

  arg(node: Node): Arg {
    let ref: Fn | null = null;
    if (node[0] === "name") {
      const var_ = this.lookup(node[2]);
      if (Array.isArray(var_)) {
        // it need not make sense as a call: it may be wanted as a callback
        let called: Cand[] = [];
        try {
          called = this.expr(node);
        } catch (e) {
          if (e instanceof Ambiguous || !(e instanceof DxlError)) throw e;
        }
        return new Arg(called, null, false, var_);
      }
      if (var_ instanceof Var) ref = this.reference(node[1], var_);
      // An unset variable may still be passed to an "&" parameter.
    }
    return new Arg(this.expr(node), ref, this.is_temporary(node));
  }

  e_int(node: Node): Cand[] {
    return [constant("int", node[2])];
  }

  e_real(node: Node): Cand[] {
    return [constant("real", node[2])];
  }

  e_string(node: Node): Cand[] {
    return [constant("string", node[2])];
  }

  e_char(node: Node): Cand[] {
    return [constant("char", node[2])];
  }

  e_bool(node: Node): Cand[] {
    return [constant("bool", node[2])];
  }

  e_group(node: Node): Cand[] {
    return this.expr(node[2]);
  }

  e_tuple(node: Node): Cand[] {
    throw new DxlError(node[1], "unexpected ','");
  }

  e_name(node: Node): Cand[] {
    const [, line, name] = node;
    const var_ = this.lookup(name);
    if (var_ instanceof Var) return [[var_.type, this.load(line, var_)]];
    if (name === "null") return [constant("null", null)];
    if (name === "current") {
      const rt = this.rt;
      return [["Module", () => rt.module], ["Object", () => rt.object], ["Folder", () => rt.folder],
        // in a running trigger's DXL, also the trigger
        ...(this.lib.functions.has(name) ? this.apply(line, name, []).filter(([t]) => t === "Trigger") : [])];
    }
    if (var_ === null && !this.lib.functions.has(name)) {
      if (TYPES.has(name)) throw new DxlError(line, `${name} is a type, not a value`);
      throw new DxlError(line, unavailable(name) ?? `undeclared or unsupported name: ${name}`);
    }
    const out = this.apply(line, name, []);
    if (!out.length) throw new DxlError(line, `${name} needs arguments`);
    return out;
  }

  e_sizeof(node: Node): Cand[] {
    const arrays = this.expr(node[2]).filter(([t]) => t.endsWith("[]")).map(([, fn]) => fn);
    if (!arrays.length) throw new DxlError(node[1], "sizeof needs an array");
    return [["int", (env) => arrays[0](env).length]];
  }

  e_current(node: Node): Cand[] {
    const rt: any = this.rt, kind: string = node[2];
    const attribute = CURRENT.get(kind)!, found = this.lib.currents.get(kind);
    return [[kind, found ? () => found(rt) : () => rt[attribute]]];
  }

  /** `Project p = current`: the variable's type says which current is meant. */
  meant(node: Node, type_name: string): Node {
    const plain = node[0] === "name" && node[2] === "current" && this.lookup("current") === null;
    return plain && type_name === "Project" ? ["current", node[1], "Project"] : node;
  }

  e_postfix(node: Node): Cand[] {
    return this.step(node, false);
  }

  e_prefix(node: Node): Cand[] {
    return this.step(node, true);
  }

  /** ++ and -- on a variable or array element. x++ is the old value, ++x the new. */
  step(node: Node, before: boolean): Cand[] {
    const [, line, op, target] = node;
    const element = target[0] === "index" && target[2][0] === "name";
    const var_ = element ? this.lookup(target[2][2]) : target[0] === "name" ? this.lookup(target[2]) : null;
    const type = var_ instanceof Var && var_.type.endsWith("[]") === element
      ? var_.type.replace("[]", "") : "";
    if (!["int", "real", "char"].includes(type)) {
      throw new DxlError(line, `(${op}) needs a number variable or array element`);
    }
    const by = op === "++" ? 1 : -1;
    const next = (old: any): any => {
      if (type === "int") return Compiler.int32(old + by);
      if (type === "real") return old + by;
      const code = old.codePointAt(0) + by;
      if (code < 0 || code > 0x10ffff) throw new ValueError("no character has that code");
      return String.fromCodePoint(code);
    };
    if (!element) {
      const get = this.load(line, var_ as Var), put = this.store_to(var_ as Var);
      return [[type, (env) => {
        const old = get(env), now = next(old);
        put(env, now);
        return before ? now : old;
      }]];
    }
    const seq = this.load(line, var_ as Var), index = this.value(target[3], "int");
    return [[type, (env) => {
      const array = seq(env), i = index(env);
      const old = Compiler.element_at(array, i), now = next(old);
      array[i] = now;
      return before ? now : old;
    }]];
  }

  /** array[i], checked to exist and to have a value. */
  static element_at(array: any, i: number): any {
    if (!(0 <= i && i < array.length)) throw new Fault(`index ${i} is out of range`);
    const value = array[i];
    if (value === Ellipsis) throw new Fault(`array element ${i} has no value yet`);
    return value;
  }

  /** `(buf += x)`: append, and be the thing appended to. */
  e_append(node: Node): Cand[] {
    const [, line, target, source] = node;
    const rt = this.rt;
    const targets = this.expr(target), sources = this.expr(source);
    const found: Cand[] = [];
    for (const [t, into] of targets) {
      if (!this.lib.chains.has(t)) continue;
      for (const [u, from] of sources) {
        const registered = this.lib.operators.get(key("+=", t, u));
        if (!registered) continue;
        const impl = registered[1];
        found.push([t, (env) => {
          const left = into(env);
          impl(rt, left, from(env));
          return left;
        }]);
      }
    }
    if (found.length > 1) throw new Ambiguous(line, "ambiguous expression: add parentheses");
    if (!found.length) {
      // `print (x += 2.0)`: a real assignment is also the new value
      const var_ = target[0] === "name" ? this.lookup(target[2]) : null;
      if (var_ instanceof Var && var_.type === "real") {
        const assign = this.s_assign(["assign", line, "+=", target, source]), get = this.load(line, var_);
        return [["real", (env) => { assign(env); return get(env); }]];
      }
      throw new DxlError(line, `(+=) inside or after parentheses only appends to a Buffer or adds to a real variable: `
        + `got ${show(targets)} and ${show(sources)}`);
    }
    return found;
  }

  /** Is this a value that may be used at once but not kept? */
  is_temporary(node: Node): boolean {
    if (node[0] === "group") return this.is_temporary(node[2]);
    if (node[0] === "ternary") return this.is_temporary(node[3]) || this.is_temporary(node[4]);
    if (node[0] === "call") return this.lib.temporaries.has(node[2]);
    if (node[0] !== "juxta" || node[2].length !== 2) return false;
    const first = node[2][0];
    return first[0] === "name" && this.lib.temporaries.has(first[2]);
  }

  not_kept(node: Node): void {
    if (!this.is_temporary(node)) return;
    throw new DxlError(node[1], "a tempStringOf result changes with its Buffer, so it may not be kept: "
      + "use stringOf here");
  }

  // -- calls and casts -----------------------------------------------------

  overloads(line: number, name: string): Overload[] {
    const user = this.lookup(name);
    const builtin = [...(this.lib.functions.get(name) ?? [])];
    if (user === null) return builtin;
    if (!Array.isArray(user)) throw new DxlError(line, `${name} is a variable, not a function`);
    const mine = user.map((f) => new Overload([...f.params], f.return_type, f));
    return [...mine, ...builtin.filter((o) => !mine.some((m) => same_params(m.params, o.params)))];
  }

  /** Every overload of `name` that accepts these Args. */
  apply(line: number, name: string, args: Arg[]): Cand[] {
    const out: Cand[] = [];
    for (const overload of this.overloads(line, name)) {
      if (overload.params.length !== args.length) continue;
      let fns: Fn[];
      try {
        fns = args.map((arg, i) => this.bind(line, arg, overload.params[i]));
      } catch (e) {
        if (e instanceof Ambiguous || !(e instanceof DxlError)) throw e;
        continue;
      }
      out.push([overload.returns, this.invoke(line, name, overload.impl, fns)]);
    }
    return out;
  }

  bind(line: number, arg: Arg, param: string): Fn {
    const callback = /^(\w+)\((.*)\)$/.exec(param);
    if (callback) {
      const signature = callback[2] ? callback[2].split(",") : [];
      const found = arg.functions?.find((f) => f.return_type === callback[1] && same_params(f.params, signature));
      if (!found) throw new DxlError(line, `this argument must be the name of a function ${param}`);
      return (env) => new Callback(found, env[0]);
    }
    if (param.startsWith("&")) {
      const want = param.slice(1);
      if (arg.ref === null) throw new DxlError(line, "this argument must be a variable");
      if (want !== "any" && !arg.cands.some(([t]) => t === want)) {
        throw new DxlError(line, `expected a ${want} variable`);
      }
      return arg.ref;
    }
    // an "any" parameter (put into a Skip list or Array) keeps what it is given.
    // Thrown as Ambiguous so that trying other overloads does not swallow it.
    if (param === "any" && arg.temporary) {
      throw new Ambiguous(line, "a tempStringOf result changes with its Buffer, so it may not be kept: "
        + "use stringOf here");
    }
    return this.coerce(line, arg.cands, param);
  }

  invoke(line: number, name: string, impl: any, fns: Fn[]): Fn {
    const rt = this.rt;
    if (!(impl instanceof Function)) {
      const called: Fn & { flow?: string } = (env) => {
        try {
          const n = fns.length;
          const result = n === 0 ? impl(rt) : n === 1 ? impl(rt, fns[0](env))
            : impl(rt, ...fns.map((f) => f(env)));
          return result === undefined ? null : result;
        } catch (e: any) {
          if (e instanceof StoreError || library_failure(e)) throw new Fault(`${name}: ${e.message}`);
          throw e;
        }
      };
      if (impl.flow) called.flow = impl.flow; // see lib/dialogs.ts
      return called;
    }

    return (env) => {
      rt.tick(line);
      const local = new Map<Var, any>();
      const count = Math.min(impl.param_vars.length, fns.length);
      for (let i = 0; i < count; i++) local.set(impl.param_vars[i], fns[i](env));
      try {
        impl.body!([env[0], local]);
      } catch (e) {
        if (e instanceof Return) return e.value;
        if (is_stack_overflow(e)) throw new DxlError(line, "stack overflow");
        throw e;
      }
      if (impl.return_type !== "void") throw new DxlError(line, `${impl.name} ended without returning a value`);
      return null;
    };
  }

  cast(line: number, type_name: string, cands: Cand[]): Cand[] {
    const hits: Cand[] = [];
    for (const [t, fn] of cands) {
      if (t === type_name) hits.push([type_name, fn]);
      else if (t === "any") hits.push([type_name, Compiler.checked(fn, type_name)]);
    }
    return hits;
  }

  e_call(node: Node): Cand[] {
    const [, line, name, arg_nodes] = node;
    // say what is not offered before complaining about its arguments
    if (!this.lib.functions.has(name) && this.lookup(name) === null) {
      const missing = unavailable(name);
      if (missing) throw new DxlError(line, missing);
    }
    if ((node as any).printed && this.lookup(name) === null) {
      const text = here_text(this.file, line);
      return [["string", () => text]];
    }
    const args: Arg[] = arg_nodes.map((a: Node, i: number) => {
      // a rich dialog element's initial value written `richText ...` is markup
      if (i === 2 && arg_nodes.length > 3 && (name === "richField" || name === "richText") && this.lookup(name) === null) {
        const markup = this.rich_markup(line, a);
        if (markup) return new Arg([["RichString_", markup]]);
      }
      return this.arg(a);
    });
    const out = this.apply(line, name, args);
    if (TYPES.has(name) && args.length === 1) out.push(...this.cast(line, name, args[0].cands));
    if (!out.length) {
      if (!this.lib.functions.has(name) && this.lookup(name) === null) {
        throw new DxlError(line, unavailable(name) ?? `undeclared or unsupported function: ${name}`);
      }
      const got = args.map((a) => (a.functions && !a.cands.length ? "a function" : show(a.cands))).join(", ");
      throw new DxlError(line, `incorrect arguments for function ${name} (${got})${other_forms(name)}`);
    }
    return out;
  }

  is_function(node: Node): boolean {
    if (node[0] !== "name") return false;
    const found = this.lookup(node[2]);
    return Array.isArray(found) || (found === null && (this.lib.functions.has(node[2]) || TYPES.has(node[2])));
  }

  /** Every well-typed reading of `a b c`, grouping from the right. */
  e_juxta(node: Node): Cand[] {
    const [, line, items] = node;
    const memo = new Map<string, Cand[]>();
    const compiler = this;

    /** [next index, alternatives] for the operand starting at i. */
    function* units(i: number, end: number): Generator<[number, Cand[]]> {
      const item = items[i];
      if (!compiler.is_function(item)) {
        yield [i + 1, compiler.expr(item)];
        return;
      }
      const name: string = item[2];
      if (i + 1 < end && items[i + 1][0] === "tuple") {
        yield [i + 2, compiler.apply(line, name, items[i + 1][2].map((a: Node) => compiler.arg(a)))];
        return;
      }
      for (let j = i + 2; j <= end; j++) {
        // richText takes the one operand after it, so `richText o."A" "\n"` is
        // (richText o."A") "\n", never richText of the two joined
        if (name === "richText" && j > i + 2 && !compiler.is_function(items[i + 1])
          && compiler.lookup(name) === null) break;
        let argument: Arg;
        if (j === i + 2) {
          argument = !compiler.is_function(items[i + 1]) ? compiler.arg(items[i + 1]) : new Arg(value(i + 1, j));
        } else {
          argument = new Arg(value(i + 1, j));
        }
        if (!argument.cands.length) continue;
        const out = compiler.apply(line, name, [argument]);
        if (TYPES.has(name)) out.push(...compiler.cast(line, name, argument.cands));
        yield [j, out];
      }
      if (!TYPES.has(name) && compiler.overloads(line, name).some((o) => !o.params.length)) {
        yield [i + 1, compiler.apply(line, name, [])];
      }
    }

    function value(i: number, end: number): Cand[] {
      const at = `${i},${end}`;
      let out = memo.get(at);
      if (out === undefined) {
        memo.set(at, out = []);
        for (const [j, left] of units(i, end)) {
          if (j === end) {
            out.push(...left);
            continue;
          }
          for (const [right_type, right_fn] of value(j, end)) {
            for (const [left_type, left_fn] of left) {
              const joined = compiler.join(left_type, left_fn, right_type, right_fn);
              if (joined) out.push(joined);
            }
          }
        }
      }
      return out;
    }

    const out = value(0, items.length);
    if (!out.length) {
      for (const item of items) {
        if (this.is_function(item) && !this.overloads(line, item[2]).length && !TYPES.has(item[2])) {
          throw new DxlError(line, unavailable(item[2]) ?? `undeclared or unsupported function: ${item[2]}`);
        }
      }
    }
    return out;
  }

  /** `left right`: a registered operator, or string concatenation. */
  join(left_type: string, left: Fn, right_type: string, right: Fn): Cand | null {
    const rt = this.rt;
    const registered = this.lib.juxtas.get(key(left_type, right_type));
    if (registered) {
      const [returns, impl] = registered;
      return [returns, (env) => impl(rt, left(env), right(env))];
    }
    if (right_type === "string" && (BASE.includes(left_type) || left_type === "attr"
      || this.lib.strings.has(left_type))) {
      return ["string", (env) => rt.text(left_type, left(env)) + right(env)];
    }
    return null;
  }

  // -- . [] unary binary ---------------------------------------------------

  e_attr(node: Node): Cand[] {
    const [, line, owner_node, name_node] = node;
    const owners = this.expr(owner_node);
    const rt = this.rt;
    const out: Cand[] = [];
    if (name_node[0] === "name") {
      for (const [t, fn] of owners) {
        const found = this.lib.properties.get(key(t, name_node[2]));
        if (found) {
          const [returns, getter] = found;
          out.push([returns, (env) => getter(rt, fn(env))]);
        }
        const second = this.lib.second_readings.get(key(t, name_node[2]));
        if (second) {
          const [returns, getter] = second;
          out.push([returns, (env) => getter(rt, fn(env))]);
        }
      }
      if (out.length) return out;
    }
    const with_attrs = owners.filter(([t]) => this.lib.attrs.has(t));
    if (with_attrs.length !== 1) {
      throw new DxlError(line, `${show(owners)} has no attributes or property of that name`);
    }
    const [owner_type, owner] = with_attrs[0];
    const name = this.value(name_node, "string");
    return [["attr", (env) => new AttrRef(rt, owner_type, owner(env), name(env))]];
  }

  e_index(node: Node): Cand[] {
    const [, line, base, index_node] = node;
    const cands = this.expr(base), indexes = this.expr(index_node);
    const rt = this.rt;

    const element = (seq_fn: Fn, position: Fn): Fn => (env) => {
      const seq = seq_fn(env), i = position(env);
      if (!(0 <= i && i < seq.length)) throw new Fault(`index ${i} is out of range`);
      const value = seq[i];
      if (value === Ellipsis) throw new Fault(`array element ${i} has no value yet`);
      return value;
    };

    const out: Cand[] = [];
    for (const [t, fn] of cands) {
      for (const [u, index] of indexes) {
        const registered = this.lib.indexes.get(key(t, u));
        if (registered) {
          const [returns, impl] = registered;
          out.push([returns, (env) => impl(rt, fn(env), index(env))]);
        } else if (u === "int" && (t.endsWith("[]") || t === "string")) {
          out.push([t.endsWith("[]") ? t.slice(0, -2) : "char", element(fn, index)]);
        }
      }
    }
    return out;
  }

  e_slice(node: Node): Cand[] {
    const [, line, base, start_node, stop_node] = node;
    const cands = this.expr(base);
    const start = this.value(start_node, "int");
    const stop = stop_node ? this.value(stop_node, "int") : null;
    const rt = this.rt;
    for (const [t, fn] of cands) {
      const sliced = this.lib.slices.get(t);
      if (sliced) {
        const [returns, impl] = sliced;
        return [[returns, (env) => impl(rt, fn(env), start(env), stop ? stop(env) : null)]];
      }
    }
    const s = this.coerce(line, cands, "string");

    return [["string", (env) => {
      const string = s(env), a = start(env);
      const b = stop === null ? string.length - 1 : stop(env);
      if (!(0 <= a && a <= string.length && a - 1 <= b && b < string.length)) {
        throw new Fault(`substring ${a}:${b} is out of range`);
      }
      return string.slice(a, b + 1);
    }]];
  }

  e_unary(node: Node): Cand[] {
    const [, line, op, operand] = node;
    const cands = this.expr(operand);
    if (op === "!") {
      const rt = this.rt;
      for (const [t, fn] of cands) {
        const registered = this.lib.operators.get(key("!", t, null));
        if (registered) {
          const [returns, impl] = registered;
          return [[returns, (env) => impl(rt, fn(env))]];
        }
      }
      const f = this.coerce(line, cands, "bool");
      return [["bool", (env) => !f(env)]];
    }
    if (op === "~") {
      const f = this.coerce(line, cands, "int");
      return [["int", (env) => ~f(env)]];
    }
    for (const t of ["int", "real"]) {
      if (cands.some(([c]) => c === t)) {
        const f = this.coerce(line, cands, t);
        return [[t, t === "int" ? (env) => 0 - f(env) : (env) => -f(env)]];
      }
    }
    throw new DxlError(line, `incorrect argument for (-): ${show(cands)}`);
  }

  e_ternary(node: Node): Cand[] {
    const [, , cond, yes, no] = node;
    const c = this.value(cond, "bool");
    const a = this.expr(yes), b = this.expr(no);
    const out: Cand[] = [];
    for (const [t, fa] of a) {
      for (const [u, fb] of b) {
        if (t === u) out.push([t, (env) => (c(env) ? fa(env) : fb(env))]);
      }
    }
    return out;
  }

  registered_operator(op: string, a: Cand[], b: Cand[]): Cand[] {
    const rt = this.rt;
    const found: Cand[] = [];
    for (const [t, x] of a) {
      for (const [u, y] of b) {
        const registered = this.lib.operators.get(key(op, t, u));
        if (registered) {
          const [returns, impl] = registered;
          found.push([returns, (env) => impl(rt, x(env), y(env))]);
        }
      }
    }
    return found;
  }

  /** An operand already compiled. */
  e_given(node: Node): Cand[] {
    return node[2];
  }

  /** A script's own `::op` for these operand types, else what DXL has. */
  e_binary(node: Node): Cand[] {
    const [, line, op, left, right] = node;
    const own = this.lookup("::" + op);
    if (!Array.isArray(own)) return this.builtin_binary(node);
    const a = this.expr(left), b = this.expr(right);
    const hits = own.filter((f) => a.some(([t]) => t === f.params[0]) && b.some(([t]) => t === f.params[1]));
    if (!hits.length) return this.builtin_binary(["binary", line, op, ["given", line, a], ["given", line, b]]);
    if (hits.length > 1 || a.length > 1 || b.length > 1) throw new Ambiguous(line, "ambiguous expression: add parentheses");
    return [[hits[0].return_type, this.invoke(line, "::" + op, hits[0], [a[0][1], b[0][1]])]];
  }

  /** Does DXL itself give `t op u` a meaning? */
  has_builtin(line: number, op: string, t: string, u: string): boolean {
    const operand = (type_name: string): Node => ["given", line, [constant(type_name, null)]];
    try {
      return this.builtin_binary(["binary", line, op, operand(t), operand(u)]).length > 0;
    } catch (e) {
      if (e instanceof DxlError) return false;
      throw e;
    }
  }

  builtin_binary(node: Node): Cand[] {
    const [, line, op, left, right] = node;
    if (op === "&&" || op === "||") {
      const a = this.expr(left), b = this.expr(right);
      const found = this.registered_operator(op, a, b);
      if (found.length) return found;
      const x = this.coerce(line, a, "bool"), y = this.coerce(line, b, "bool");
      if (op === "&&") return [["bool", (env) => x(env) && y(env)]];
      return [["bool", (env) => x(env) || y(env)]];
    }
    if (op === ">>") return this.read_into(line, left, right);
    let a = this.expr(left);
    let b = this.expr(right);
    const found = this.registered_operator(op, a, b);
    if (found.length) return found;
    if (op === "<<" || op === "->" || op === "<-") {
      throw new DxlError(line, `incorrect arguments for (${op}): ${show(a)} and ${show(b)}`);
    }
    const types = (c: Cand[]) => new Set(c.map(([t]) => t));
    const only_null = (c: Cand[]) => c.length > 0 && c.every(([t]) => t === "null");
    let common = new Set([...types(a)].filter((t) => types(b).has(t)));
    if (types(a).has("any")) for (const t of types(b)) common.add(t);
    if (types(b).has("any")) for (const t of types(a)) common.add(t);
    let allowed: Set<string>;
    if (op === "==" || op === "!=") {
      const handles = (c: Cand[]) => [...types(c)].filter((t) => this.lib.handles.has(t));
      if (only_null(a)) common = new Set(handles(b));
      else if (only_null(b)) common = new Set(handles(a));
      else if (b.some(([t]) => t === "null")) for (const t of handles(a)) common.add(t);
      // `name() == null`: DXL compares a string with null
      if (only_null(a) && b.some(([t]) => t === "string")) {
        common = new Set(["string"]);
        a = [constant("string", "")];
      } else if (only_null(b) && a.some(([t]) => t === "string")) {
        common = new Set(["string"]);
        b = [constant("string", "")];
      }
      allowed = new Set([...BASE, ...this.lib.handles]);
    } else if (op === "<" || op === ">" || op === "<=" || op === ">=") {
      allowed = new Set(["int", "real", "char", "string"]);
    } else if (op === "%" || op === "|" || op === "&" || op === "<?" || op === ">?") {
      allowed = new Set(["int"]);
    } else if (op === "^") {
      allowed = new Set(["real"]); // a power; DXL documents no int (^)
    } else {
      allowed = new Set(["int", "real"]);
    }
    const kinds = [...common].filter((t) => allowed.has(t)).sort(compare_text);
    if (kinds.length !== 1) {
      const printed = left[0] === "juxta" && left[2][0][0] === "name" && left[2][0][2] === "print";
      const hint = printed
        ? ` (print takes only what is next to it here; bracket the whole expression: print (x ${op} y))`
        : [...a, ...b].some(([t]) => t === "attr")
          ? ' (append "" to an attribute value to make it a string)' : "";
      throw new DxlError(line, `incorrect arguments for (${op}): ${show(a)} and ${show(b)}${hint}`);
    }
    const kind = kinds[0];
    // real ^ is a power. How tightly it binds is not documented, and this parser
    // reads it as loosely as bitwise or, so only single operands are taken.
    const loose = (n: Node) => ["binary", "juxta", "ternary"].includes(n[0]);
    if (op === "^" && (loose(left) || loose(right) || left[0] === "unary")) {
      throw new DxlError(line, "put parentheses around each side of a real (^)");
    }
    const x = this.coerce(line, a, kind), y = this.coerce(line, b, kind);
    const text = kind === "string" || kind === "char";
    const order = (test: (p: any, q: any) => boolean): Fn => text
      ? (env) => { const p = x(env), q = y(env); return test(compare_text(p, q), 0); }
      : (env) => test(x(env), y(env));
    switch (op) {
      case "==": return [["bool", (env) => equals(x(env), y(env))]];
      case "!=": return [["bool", (env) => !equals(x(env), y(env))]];
      case "<": return [["bool", order((p, q) => p < q)]];
      case ">": return [["bool", order((p, q) => p > q)]];
      case "<=": return [["bool", order((p, q) => p <= q)]];
      case ">=": return [["bool", order((p, q) => p >= q)]];
      case "<?": return [["int", (env) => Math.min(x(env), y(env))]];
      case ">?": return [["int", (env) => Math.max(x(env), y(env))]];
    }
    return [[kind, Compiler.arithmetic(op, kind, x, y)]];
  }

  /** stream >> variable */
  read_into(line: number, left: Node, right: Node): Cand[] {
    const a = this.expr(left);
    const var_ = right[0] === "name" ? this.lookup(right[2]) : null;
    if (!(var_ instanceof Var)) throw new DxlError(line, ">> needs a variable on the right");
    const rt = this.rt, ref = this.reference(line, var_);
    for (const [t, fn] of a) {
      const registered = this.lib.operators.get(key(">>", t, var_.type));
      if (registered) {
        const [returns, impl] = registered;
        return [[returns, (env) => impl(rt, fn(env), ref(env))]];
      }
    }
    throw new DxlError(line, `cannot read ${show(a)} into a ${var_.type}`);
  }

  /** `n` if it fits in a DXL int. What DOORS does on overflow is not verified, so stop. */
  static int32(n: number): number {
    if (n > 2147483647 || n < -2147483648) throw new Fault("int overflow: DXL ints are 32 bits");
    return n + 0;
  }

  static arithmetic(op: string, kind: string, x: Fn, y: Fn): Fn {
    // an int has no negative zero, and is 32 bits
    const whole = kind === "int" ? Compiler.int32 : (n: number) => n;
    return (env) => {
      const p = x(env), q = y(env);
      if (op === "|") return p | q;
      if (op === "&") return p & q;
      if (op === "^") {
        const power = Math.pow(p, q);
        if (!Number.isFinite(power)) throw new Fault("(^): the result is not a number");
        return power;
      }
      if (op === "+") return whole(p + q);
      if (op === "-") return whole(p - q);
      if (op === "*") return whole(p * q);
      if (q === 0) throw new Fault("division by zero");
      if (kind === "real") return p / q;
      const remainder = p % q; // truncates, as C does
      return whole(op === "/" ? (p - remainder) / q : remainder);
    };
  }

  // -- statements ----------------------------------------------------------

  statement(node: Node): Fn {
    const line = node[1];
    const run: Fn = (this as any)["s_" + node[0]](node);
    const rt = this.rt;

    const guarded: Fn & { flow?: string } = (env) => {
      try {
        run(env);
      } catch (fault: any) {
        if (fault instanceof Fault || fault instanceof StoreError || fault instanceof OSError) {
          if (rt.trapping && !is_limit(fault.message)) {
            rt.last_error = fault.message;
            return;
          }
          throw new DxlError(line, `run-time error: ${fault.message}`);
        }
        throw fault;
      }
    };
    const flow = (run as Fn & { flow?: string }).flow;
    if (flow) guarded.flow = flow;
    return guarded;
  }

  /** show(box) and block(box) where they would not mean what DOORS means.
   * `top`: these are the script's own top-level statements. */
  check_flow(nodes: Node[], steps: Array<Fn & { flow?: string }>, top: boolean = false): void {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].flow === "show" && i < steps.length - 1) {
        throw new DxlError(nodes[i + 1][1], "nothing may follow show of a dialog box: as the DXL manual says, "
          + "it would never be executed");
      }
      if (steps[i].flow === "block" && !top) {
        throw new DxlError(nodes[i][1], "block is only offered as a statement of the script's top level, "
          + "not inside braces, if, a loop, a function or an include");
      }
    }
  }

  block(nodes: Node[]): Fn {
    this.scopes.push(new Map());
    let steps: Fn[];
    try {
      steps = nodes.map((n) => this.statement(n));
    } finally {
      this.scopes.pop();
    }
    this.check_flow(nodes, steps);
    return (env) => {
      for (const step of steps) step(env);
    };
  }

  s_block(node: Node): Fn {
    return this.block(node[2]);
  }

  /** The one file `#include name` means, looked for beside the script and in
   * each --include folder. DOORS searches its own library folders; where two
   * of ours hold the name, which it would take is not known, so stop. */
  include_path(line: number, name: string): string {
    const files = this.rt.files;
    const folders = /^[\/\\]/.test(name) ? [""] : [this.rt.base_dir, ...files.include_dirs];
    const candidates = folders.map((folder) => files.realpath(normpath(join_path(folder, name))));
    const found = [...new Set(candidates)].filter((path) => files.exists(path) && !files.isdir(path));
    if (found.length > 1) {
      throw new DxlError(line, `#include ${py_repr(name)} is in more than one folder: ${found.join(", ")}`);
    }
    try {
      return files.include(found[0] ?? candidates[0]);
    } catch (fault: any) {
      if (fault instanceof Fault) throw new DxlError(line, fault.message);
      throw fault;
    }
  }

  s_include(node: Node): Fn {
    const [, line, name] = node;
    const path = this.include_path(line, name);
    if (this.including.has(path)) throw new DxlError(line, `#include loop at ${name}`);
    let source: string;
    try {
      source = this.rt.files.readText(path);
    } catch (e: any) {
      if (e instanceof OSError) throw new DxlError(line, `cannot include ${py_repr(name)}: ${e.strerror}`);
      throw e;
    }
    this.including.add(path);
    const outer = this.file;
    this.file = name;
    let steps: Fn[];
    try {
      // Included declarations land in the including scope.
      const nodes = new Parser(source).program();
      steps = nodes.map((n) => this.statement(n));
      this.check_flow(nodes, steps);
    } catch (e: any) {
      if (e instanceof DxlError) throw new DxlError(e.line, e.message, e.file || name);
      throw e;
    } finally {
      this.including.delete(path);
      this.file = outer;
    }
    return (env) => {
      for (const step of steps) step(env);
    };
  }

  s_expr(node: Node): Fn {
    const expr = node[2];
    mark_printed_here(expr);
    const cands = this.expr(expr);
    let effects = cands.filter(([t]) => t === "void" || t === "Stream");
    if (!effects.length) effects = cands;
    if (effects.length !== 1) throw new DxlError(node[1], "ambiguous statement: add parentheses");
    const kind = effects[0][0];
    if (kind === "Stream" && cands.some(([t]) => t === "Module")) {
      throw new DxlError(node[1], "this could open a module or a text file: assign the result "
        + '(Module m = read ...) or use read("name", false)');
    }
    let inner = expr;
    while (inner[0] === "group") inner = inner[2];
    if (kind !== "void" && inner[0] !== "append"
      && !["call", "juxta", "name", "postfix", "prefix", "binary"].includes(expr[0])) {
      throw new DxlError(node[1], "this statement does nothing");
    }
    if (expr[0] === "binary" && kind === "bool") {
      throw new DxlError(node[1], "this statement only compares; did you mean = ?");
    }
    if (kind === "string" && expr[0] === "juxta" && !this.is_function(expr[2][0])) {
      throw new DxlError(node[1], "this statement only builds a string; is a print missing?");
    }
    return effects[0][1];
  }

  s_reference(node: Node): Fn {
    const [, line, type_name, name, target] = node;
    const source = target[0] === "name" ? this.lookup(target[2]) : null;
    if (!(source instanceof Var) || source.type !== type_name) {
      throw new DxlError(line, `${name} must name a ${type_name} variable`);
    }
    const refer = this.reference(line, source);
    const var_ = this.declare(line, name, type_name, true);
    const where = Compiler.slot(var_);
    return (env) => {
      env[where].set(var_, refer(env));
    };
  }

  s_declare(node: Node): Fn {
    const [, line, type_name, items] = node;
    if (type_name === "void") throw new DxlError(line, "a variable cannot be void");
    if (!this.lib.types.has(type_name)) throw new DxlError(line, unavailable(type_name) ?? `type ${type_name} is not supported`);
    const rt = this.rt;
    const steps: Array<[0 | 1, Var, Fn | null]> = [];
    for (const [name, array, init, size] of items) {
      let make: Fn | null, var_: Var;
      if (init && type_name === "string") for (const each of array ? init : [init]) this.not_kept(each);
      if (array) {
        const values: Fn[] | null = init ? init.map((i: Node) => this.assigned(i[1], this.expr(i), type_name)) : null;
        const length = size ? this.value(size, "int") : null;
        var_ = this.declare(line, name, type_name + "[]");
        make = (env) => {
          const out: any[] = values ? values.map((v) => v(env)) : [];
          if (length) {
            const count = length(env);
            if (count < 0) throw new Fault("an array cannot have a negative size");
            if (count < out.length) throw new Fault("too many initial values for the array");
            const empty = this.lib.defaults.get(type_name);
            const filler = empty ? empty(rt) : Ellipsis;
            for (let n = out.length; n < count; n++) {
              if (n % 100000 === 0) rt.tick(line);
              out.push(filler);
            }
          }
          return out;
        };
      } else {
        // compile the initialiser before the name comes into scope
        make = this.initialiser(line, type_name, init && this.meant(init, type_name));
        var_ = this.declare(line, name, type_name);
      }
      steps.push([Compiler.slot(var_), var_, make]);
    }
    return (env) => {
      for (const [where, var_, make] of steps) {
        if (make === null) env[where].delete(var_);
        else env[where].set(var_, make(env));
      }
    };
  }

  initialiser(line: number, type_name: string, init: Node | null): Fn | null {
    const rt = this.rt;
    const default_ = this.lib.defaults.get(type_name);
    if (init === null) return default_ ? () => default_(rt) : null;
    const cands = this.expr(init);
    if (Object.hasOwn(NULL_VALUES, type_name) && cands.length === 1 && cands[0][0] === "null") {
      return () => NULL_VALUES[type_name];
    }
    // e.g. Buffer b = "text": build the default, then assign into it.
    if (!cands.some(([t]) => t === type_name)) {
      for (const [t, fn] of cands) {
        const registered = this.lib.operators.get(key("=", type_name, t));
        if (registered) {
          const impl = registered[1];
          return (env) => {
            const target = default_!(rt);
            impl(rt, target, fn(env));
            return target;
          };
        }
      }
    }
    return this.assigned(line, cands, type_name);
  }

  s_chain(node: Node): Fn {
    const [, line, op, target, rest] = node;
    // the inner target is read again for the outer assignment, so it must not move
    const steps = (n: any): boolean => Array.isArray(n)
      && (n[0] === "postfix" || n[0] === "prefix" || n.some(steps));
    if (steps(rest[3])) throw new DxlError(line, "write ++ or -- in a chained assignment as its own statement");
    const inner = this.statement(rest);
    const outer = this.statement(["assign", line, op, target, rest[3]]);
    return (env) => {
      inner(env);
      outer(env);
    };
  }

  s_assign(node: Node): Fn {
    const [, line, op, target, source] = node;
    const rt = this.rt;
    if (target[0] === "name" && target[2] === "current") return this.assign_current(line, op, source);
    if (target[0] === "attr") return this.assign_member(line, op, target, source);
    if (target[0] === "index") return this.assign_element(line, op, target, source);
    if (target[0] === "group" && op === "+=") {
      return this.e_append(["append", line, target, source])[0][1];
    }
    if (target[0] !== "name") {
      // `Trigger t = ...`: a type this suite does not offer reads as two words
      const first = target[0] === "juxta" ? target[2][0] : null;
      const missing = first?.[0] === "name" && this.lookup(first[2]) === null ? unavailable(first[2]) : null;
      if (missing) throw new DxlError(line, missing);
      throw new DxlError(line, "only a variable, array element or attribute can be assigned to");
    }
    const name = target[2];
    let var_ = this.lookup(name);
    if (var_ === null && op === "=" && !this.lib.functions.has(name)) {
      // DXL's immediate declaration
      const kinds = new Set(this.expr(source).map(([t]) => t));
      if (kinds.size !== 1 || ["void", "null", "attr", "any"].some((t) => kinds.has(t))) {
        throw new DxlError(line, `cannot infer a type for ${name}; declare it`);
      }
      var_ = this.declare(line, name, [...kinds][0]);
    }
    if (!(var_ instanceof Var) || var_.type.endsWith("[]")) throw new DxlError(line, `cannot assign to ${name}`);
    if (var_.type === "string") this.not_kept(source);
    const put = this.store_to(var_);
    const cands = this.expr(this.meant(source, var_.type));
    if (op === "=" && Object.hasOwn(NULL_VALUES, var_.type) && cands.length === 1 && cands[0][0] === "null") {
      const empty = NULL_VALUES[var_.type];
      return (env) => put(env, empty);
    }
    for (const [t, fn] of cands) {
      const registered = this.lib.operators.get(key(op, var_.type, t));
      if (registered) {
        const [returns, impl] = registered;
        const get = this.load(line, var_);
        if (returns === "void") return (env) => impl(rt, get(env), fn(env)); // mutates the existing value
        return (env) => put(env, impl(rt, op !== "=" ? get(env) : null, fn(env)));
      }
    }
    let f: Fn;
    if (op === "=") {
      f = this.assigned(line, cands, var_.type);
    } else {
      if (var_.type === "Buffer" && op === "+=") {
        throw new DxlError(line, `(+=) appends a string, char or Buffer to a Buffer, not ${show(cands)}; make it a string `
          + `first by joining "" to it, as in: b += o."Object Text" ""`);
      }
      if (var_.type !== "int" && var_.type !== "real") {
        throw new DxlError(line, `(${op}) is not supported for ${var_.type}`);
      }
      Compiler.int_only(line, op, var_.type);
      f = Compiler.arithmetic(op[0], var_.type, this.load(line, var_), this.coerce(line, cands, var_.type, true));
    }
    return (env) => put(env, f(env));
  }

  /** The manual gives these three assignment forms to int alone. */
  static int_only(line: number, op: string, type_name: string): void {
    if ((op === "%=" || op === "|=" || op === "&=") && type_name !== "int") {
      throw new DxlError(line, `(${op}) is not supported for ${type_name}`);
    }
  }

  assign_current(line: number, op: string, source: Node): Fn {
    if (op !== "=") throw new DxlError(line, "bad assignment to current");
    const rt: any = this.rt;
    const cands = this.expr(source);
    const kinds = new Set(cands.map(([t]) => t).filter((t) => CURRENT.has(t)));
    if (kinds.size !== 1) throw new DxlError(line, "current takes a Module, Object, Folder or Project");
    const kind = [...kinds][0];
    const f = this.coerce(line, cands, kind);
    const attribute = CURRENT.get(kind)!;
    return (env) => { rt[attribute] = f(env); };
  }

  assign_member(line: number, op: string, target: Node, source: Node): Fn {
    const rt = this.rt;
    const [, , owner_node, name_node] = target;
    if (name_node[0] === "name") {
      for (const [t, fn] of this.expr(owner_node)) {
        const found = this.lib.properties.get(key(t, name_node[2]));
        if (found) {
          const [returns, , setter] = found;
          if (setter === null || op !== "=") throw new DxlError(line, `${name_node[2]} cannot be assigned`);
          const value = this.value(source, returns, true);
          return (env) => setter(rt, fn(env), value(env));
        }
      }
    }
    const reference = this.value(target, "attr");
    if (op === "=" && Compiler.is_string_null(source)) return (env) => reference(env).reset();
    if (op !== "=") {
      const registered = this.lib.operators.get(key(op, "attr", "string"));
      if (!registered) throw new DxlError(line, `(${op}) is not supported on an attribute`);
      const impl = registered[1], text = this.value(source, "string");
      return (env) => impl(rt, reference(env), text(env));
    }
    const rich = this.rich_markup(line, source);
    if (rich) return (env) => reference(env).set_rich(rich(env));
    const cands = this.expr(source);
    const writable = cands.filter(([t]) => BASE.includes(t) || t === "attr" || this.lib.strings.has(t));
    if (writable.length !== 1) throw new DxlError(line, `cannot assign ${show(cands)} to an attribute`);
    const [kind, value] = writable[0];

    return (env) => {
      const raw = value(env);
      const text = kind === "bool" ? (raw ? "True" : "False") : rt.text(kind, raw);
      reference(env).set(text);
    };
  }

  /** `o."Name" = richText ...` reads the right hand side as markup rather
   * than storing it as text. The markup, or null for any other right hand side. */
  rich_markup(line: number, source: Node): Fn | null {
    let node = source;
    while (node[0] === "group") node = node[2];
    const rich = (n: Node): boolean => (n[0] === "call" && n[2] === "richText")
      || (n[0] === "name" && n[2] === "richText");
    let args: Node[];
    if (node[0] === "call" && node[2] === "richText") {
      args = node[3];
    } else if (node[0] === "juxta" && node[2].some(rich)) {
      if (node[2].length !== 2 || node[2][0][0] !== "name" || node[2][0][2] !== "richText") {
        throw new DxlError(line, "richText beside other text on the right of an attribute assignment is not "
          + "documented: build the markup in a string, then assign richText of that");
      }
      args = [node[2][1]];
    } else {
      return null;
    }
    if (this.lookup("richText") !== null) return null; // the script's own name
    if (args.length === 1 && !this.expr(args[0]).some(([t]) => t === "attr")) {
      return this.value(args[0], "string"); // the string is the markup itself
    }
    return args.length === 1 || args.length === 2 ? this.value(node, "string") : null;
  }

  /** Is this the cast `(string null)`? */
  static is_string_null(node: Node): boolean {
    while (node[0] === "group") node = node[2];
    const parts: Node[] = node[0] === "juxta" ? node[2]
      : node[0] === "call" && node[2] === "string" ? [["name", node[1], "string"], ...node[3]] : [];
    return parts.length === 2 && parts[0][0] === "name" && parts[0][2] === "string"
      && parts[1][0] === "name" && parts[1][2] === "null";
  }

  assign_element(line: number, op: string, target: Node, source: Node): Fn {
    const [, , base, index_node] = target;
    const arrays = this.expr(base).filter(([t]) => t.endsWith("[]"));
    if (arrays.length !== 1) throw new DxlError(line, "only array elements can be assigned by index");
    const kind = arrays[0][0].slice(0, -2), seq = arrays[0][1];
    const index = this.value(index_node, "int");
    if (kind === "string") this.not_kept(source);
    let value = this.assigned(line, this.expr(source), kind);
    let held: any; // the element before a compound assignment, so the index is worked out once
    if (op !== "=") {
      if (kind !== "int" && kind !== "real") throw new DxlError(line, `(${op}) needs a number`);
      Compiler.int_only(line, op, kind);
      value = Compiler.arithmetic(op[0], kind, () => held, value);
    }
    return (env) => {
      const array = seq(env), i = index(env);
      if (op !== "=") held = Compiler.element_at(array, i);
      else if (!(0 <= i && i < array.length)) throw new Fault(`index ${i} is out of range`);
      array[i] = value(env);
    };
  }

  s_if(node: Node): Fn {
    const [, , cond, then, other] = node;
    const c = this.value(cond, "bool");
    const a = this.block([then]);
    const b = other ? this.block([other]) : null;
    return (env) => {
      if (c(env)) a(env);
      else if (b) b(env);
    };
  }

  loop_body(node: Node): Fn {
    this.loops += 1;
    try {
      return this.block([node]);
    } finally {
      this.loops -= 1;
    }
  }

  s_while(node: Node): Fn {
    const [, line, cond, body] = node;
    const c = this.value(cond, "bool");
    const b = this.loop_body(body);
    const rt = this.rt;
    return (env) => {
      while (c(env)) {
        rt.tick(line);
        try {
          b(env);
        } catch (e) {
          if (e instanceof Break) break;
          if (!(e instanceof Continue)) throw e;
        }
      }
    };
  }

  s_cfor(node: Node): Fn {
    const [, line, init, cond, step, body] = node;
    const i = init ? this.statement(init) : null;
    const c = cond ? this.value(cond, "bool") : null;
    const s = step ? this.statement(step) : null;
    const b = this.loop_body(body);
    const rt = this.rt;
    return Compiler.in_for(rt, (env) => {
      if (i) i(env);
      while (c === null || c(env)) {
        rt.tick(line);
        try {
          b(env);
        } catch (e) {
          if (e instanceof Break) break;
          if (!(e instanceof Continue)) throw e;
        }
        if (s) s(env);
      }
    });
  }

  /** Count the for loops running: DOORS restricts what open modes do in one. */
  static in_for(rt: Runtime, loop: Fn): Fn {
    return (env) => {
      rt.for_depth += 1;
      try {
        loop(env);
      } finally {
        rt.for_depth -= 1;
      }
    };
  }

  s_forin(node: Node): Fn {
    const [, line, name, original, body] = node;
    const var_ = this.lookup(name);
    if (!(var_ instanceof Var)) throw new DxlError(line, `declare the loop variable ${name} first`);
    const source = this.versioned_links(original);
    const items: (env: Env) => Iterable<any> = source[0] === "links" ? this.arrow_source(source, var_.type)
      : source[0] === "range" ? this.range_source(source, var_.type)
        : this.loop_source(source, var_.type);
    const put = this.store_to(var_);
    const b = this.loop_body(body);
    const rt = this.rt;

    return Compiler.in_for(rt, (env) => {
      for (let item of items(env)) {
        rt.tick(line);
        if (item instanceof Typed) {
          if (item.type !== var_.type) throw new Fault(`a ${var_.type} loop variable cannot hold a ${item.type}`);
          item = item.value;
        }
        put(env, item);
        try {
          b(env);
        } catch (e) {
          if (e instanceof Break) break;
          if (!(e instanceof Continue)) throw e;
        }
      }
    });
  }

  /** `all(o -> "x")` and `all(o) -> "x"` become a "links" node whose arrow
   * starts with "all"; anything else is returned as it is. */
  versioned_links(node: Node): Node {
    const inside_all = (n: Node): Node | null => {
      if (n[0] === "call" && n[2] === "all" && n[3].length === 1) {
        n = n[3][0];
      } else if (n[0] === "juxta" && n[2].length === 2 && n[2][0][0] === "name" && n[2][0][2] === "all") {
        n = n[2][1];
      } else {
        return null;
      }
      while (n[0] === "group") n = n[2];
      return n;
    };

    const inner = inside_all(node);
    if (inner && inner[0] === "binary" && (inner[2] === "->" || inner[2] === "<-")) {
      return ["links", node[1], "all" + inner[2], inner[3], inner[4]];
    }
    if (node[0] === "links") {
      const owner = inside_all(node[3]);
      if (owner && this.expr(owner).some(([t]) => t === "Object")) {
        return ["links", node[1], "all" + node[2], owner, node[4]];
      }
    }
    return node;
  }

  range_source(node: Node, var_type: string): (env: Env) => Iterable<number> {
    const [, line, start, stop, step] = node;
    if (var_type !== "int") throw new DxlError(line, "a range loop needs an int variable");
    const a = this.value(start, "int"), b = this.value(stop, "int"), c = this.value(step, "int");

    function* range(from: number, to: number, by: number): Generator<number> {
      for (let n = from; by > 0 ? n < to : n > to; n += by) yield n;
    }
    return (env) => {
      const by = c(env);
      if (by === 0) throw new Fault("range step is 0");
      const from = a(env), to = b(env) + (by > 0 ? 1 : -1);
      return range(from, to, by);
    };
  }

  loop_source(node: Node, var_type: string): (env: Env) => any[] {
    const line = node[1], rt = this.rt;
    const cands = this.expr(node);
    const matches: Array<[any, Fn]> = [];
    for (const [t, fn] of cands) {
      const impl = this.lib.loops.get(key(t, var_type)) ?? this.lib.loops.get(key(t, "any"));
      if (impl) matches.push([impl, fn]);
    }
    if (matches.length !== 1) {
      if (var_type.startsWith("RichText") && cands.some(([t]) => t === "attr")) {
        throw new DxlError(line, "looping over an attribute itself is not documented here: loop over richText of it");
      }
      throw new DxlError(line, `no loop over ${show(cands)} with a ${var_type} variable`);
    }
    const [impl, fn] = matches[0];
    // A snapshot, so the body may add or delete what is being looped over.
    return (env) => Array.from(impl(rt, fn(env)));
  }

  arrow_source(node: Node, var_type: string): (env: Env) => any[] {
    const [, line, arrow, owner_node, name_node] = node;
    const owners = this.expr(owner_node);
    const name = this.value(name_node, "string");
    const rt = this.rt;
    const matches: Array<[any, Fn]> = [];
    for (const [t, fn] of owners) {
      const impl = this.lib.arrows.get(key(arrow, t, var_type));
      if (impl) matches.push([impl, fn]);
    }
    if (matches.length !== 1) {
      throw new DxlError(line, `no ${arrow} loop over ${show(owners)} with a ${var_type} variable`);
    }
    const [impl, owner] = matches[0];
    return (env) => Array.from(impl(rt, owner(env), name(env)));
  }

  s_break(node: Node): Fn {
    return this.jump(node, new Break());
  }

  s_continue(node: Node): Fn {
    return this.jump(node, new Continue());
  }

  jump(node: Node, signal: Break | Continue): Fn {
    if (!this.loops) throw new DxlError(node[1], `${node[0]} outside a loop`);
    return () => {
      throw signal;
    };
  }

  s_return(node: Node): Fn {
    const [, line, expr] = node;
    if (this.function === null) throw new DxlError(line, "return outside a function (use halt)");
    const want = this.function.return_type;
    if ((want === "void") !== (expr === null)) throw new DxlError(line, `${this.function.name} returns ${want}`);
    if (expr && want === "string") this.not_kept(expr);
    const f = expr ? this.value(expr, want) : null;
    return (env) => {
      throw new Return(f ? f(env) : null);
    };
  }

  /** The checks a function and its forward declaration share. Returns the
   * parameter signature and the functions already known by that name. */
  function_head(node: Node): [string[], Function[]] {
    const [, line, , name, params] = node;
    if (this.function || this.scopes.length > 1) {
      throw new DxlError(line, "functions must be declared at the top level");
    }
    this.check_name(line, name);
    const signature: string[] = [];
    for (const [type_name, , by_ref, array] of params) {
      if (!this.lib.types.has(type_name)) throw new DxlError(line, unavailable(type_name) ?? `type ${type_name} is not supported`);
      signature.push((by_ref ? "&" : "") + type_name + (array ? "[]" : ""));
    }
    if (name.startsWith("::")) {
      const op = name.slice(2), [t, u] = signature;
      if (signature.length !== 2 || node[2] === "void" || params.some((p: any[]) => p[2] || p[3])) {
        throw new DxlError(line, `${name} must take two plain values and return one`);
      }
      // which one DXL would then use, inside the new body too, is not documented
      if (this.has_builtin(line, op, t, u)) {
        throw new DxlError(line, `(${op}) already works on ${t} and ${u}; redefining it is not offered`);
      }
    }
    const existing = this.scopes[0].get(name) ?? [];
    if (!Array.isArray(existing)) throw new DxlError(line, `${name} is already declared`);
    return [signature, existing];
  }

  s_forward(node: Node): Fn {
    const [, line, return_type, name] = node;
    const [signature, existing] = this.function_head(node);
    if (existing.some((f) => same_params(f.params, signature))) {
      throw new DxlError(line, `${name} is already declared`);
    }
    const made = new Function(name, signature, return_type);
    this.scopes[0].set(name, [...existing, made]);
    this.forwards.set(made, [line, this.file]);
    return () => {};
  }

  /** Call once the whole script has been compiled. */
  finish(): void {
    for (const [made, [line, file]] of this.forwards) {
      throw new DxlError(line, `${made.name} is declared but its body never comes (the parameter types must match)`,
        file);
    }
  }

  s_function(node: Node): Fn {
    const [, line, return_type, name, params, body] = node;
    const [signature, existing] = this.function_head(node);
    let made = existing.find((f) => same_params(f.params, signature));
    if (made) {
      if (!this.forwards.has(made)) throw new DxlError(line, `${name} is already declared`);
      if (made.return_type !== return_type) {
        throw new DxlError(line, `${name} was declared earlier as returning ${made.return_type}`);
      }
      this.forwards.delete(made);
    } else {
      made = new Function(name, signature, return_type);
      this.scopes[0].set(name, [...existing, made]);
    }
    const loops = this.loops;
    this.loops = 0;
    this.function = made;
    this.scopes.push(new Map());
    try {
      made.param_vars = params.map(([type_name, pname, by_ref, array]: any[]) =>
        this.declare(line, pname, type_name + (array ? "[]" : ""), by_ref));
      made.body = this.block(body[2]);
    } finally {
      this.scopes.pop();
      this.loops = loops;
      this.function = null;
    }
    return () => {};
  }
}
