// What a running DXL script holds, and the values the library passes around.

import type { Store } from "../store.ts";
import { DxlError } from "./syntax.ts";

/** A DXL run-time error. The engine adds the line number. */
export class Fault extends Error {
  constructor(message: string = "") {
    super(message);
    this.name = "Fault";
  }
  toString(): string {
    return this.message;
  }
}

/** `halt`: stop the script without an error. */
export class Halt extends Error {
  constructor() {
    super("");
    this.name = "Halt";
  }
}

// The exceptions the engine turns into run-time errors when a library
// function raises them. They are recognised by name, so a local class of the
// same name works too.
export class ValueError extends Error {
  constructor(message: string = "") { super(message); this.name = "ValueError"; }
  toString(): string { return this.message; }
}
export class OverflowError extends Error {
  constructor(message: string = "") { super(message); this.name = "OverflowError"; }
  toString(): string { return this.message; }
}
export class IndexError extends Error {
  constructor(message: string = "") { super(message); this.name = "IndexError"; }
  toString(): string { return this.message; }
}

/** An array element with no value yet. */
export const Ellipsis: undefined = undefined;

/** Equality for the values scripts hold. */
export function equals(a: any, b: any): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "object") {
    if (typeof a.equals === "function") return a.equals(b);
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, i) => equals(v, b[i]));
    }
  }
  return a === b;
}

/** Ordering of two strings (by code point, not by UTF-16 unit). */
export function compare_text(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    // surrogates stand for code points above every other unit
    if (x >= 0xd800 && x <= 0xdfff) x += 0x10000;
    if (y >= 0xd800 && y <= 0xdfff) y += 0x10000;
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** `x` with `digits` decimals: exact, rounding half to even. */
export function format_fixed(x: number, digits: number = 6): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (exponent !== 0) mantissa |= 1n << 52n;
  const e = (exponent === 0 ? 1 : exponent) - 1075;
  const scale = 10n ** BigInt(digits);
  let q: bigint;
  if (e >= 0) {
    q = (mantissa << BigInt(e)) * scale;
  } else {
    const num = mantissa * scale, den = 1n << BigInt(-e);
    q = num / den;
    const twice = (num % den) * 2n;
    if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  }
  const text = q.toString().padStart(digits + 1, "0");
  const body = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return (bits >> 63n) === 1n ? "-" + body : body;
}

/** A value whose DXL type is only known at run time ("any"). */
export class Typed {
  type: string;
  value: any;
  constructor(type: string, value: any) {
    this.type = type;
    this.value = value;
  }
  equals(other: any): boolean {
    return other instanceof Typed && other.constructor === this.constructor
      && this.type === other.type && equals(this.value, other.value);
  }
}

/** A DXL function passed as a callback: the compiler's Function and the
 * script's global variables. */
export class Callback {
  target: any;
  globals: Map<any, any>;
  constructor(target: any, globals: Map<any, any>) {
    this.target = target;
    this.globals = globals;
  }
}

/** A variable passed by reference. */
export class Ref {
  type: string;
  get: () => any;
  set: (value: any) => void;
  constructor(type_name: string, get: () => any, set_: (value: any) => void) {
    this.type = type_name;
    this.get = get;
    this.set = set_;
  }
}

/** `owner."name"`, before the context decides whether it is read or written. */
export class AttrRef {
  rt: Runtime;
  owner_type: string;
  owner: any;
  name: string;
  constructor(rt: Runtime, owner_type: string, owner: any, name: string) {
    this.rt = rt;
    this.owner_type = owner_type;
    this.owner = owner;
    this.name = name;
  }
  get(): string {
    return this.rt.lib.attrs.get(this.owner_type)![0](this.rt, this.owner, this.name);
  }
  set(text: string): void {
    this.rt.lib.attrs.get(this.owner_type)![1](this.rt, this.owner, this.name, text);
  }
  /** `owner."name" = (string null)` */
  reset(): void {
    const reset = this.rt.lib.resets.get(this.owner_type);
    if (!reset) throw new Fault("assigning (string null) to this attribute is not supported here");
    reset(this.rt, this.owner, this.name);
  }
}

/** DXL's conversion of a base value to text. A number is a real only if
 * `type_name` says so: int and real are both JavaScript numbers. */
export function base_text(value: any, type_name?: string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (type_name === "real" && typeof value === "number") return format_fixed(value, 6);
  return String(value);
}

export class Runtime {
  lib: any;
  store: any;
  out: { write(text: string): any };
  base_dir: string;
  files: any;
  ask: (question: string) => any;
  opened: Map<number, string>;
  module: number | null;
  _current: Map<any, any>;
  folder: number;
  modified: Set<number>;
  trapping: boolean;
  last_error: string;
  closers: Array<() => any>;
  displays: Map<number, any>;
  state: Map<string, any>;
  deadline: number | null; // ms since the epoch; the script is stopped after it

  constructor(lib: any, store: Store | any, out: any, base_dir: string = ".", ask: any = null, files: any = null) {
    this.lib = lib;
    this.store = store;
    this.out = out;
    this.base_dir = base_dir;
    this.files = files; // which files the script may touch (files.ts)
    this.ask = ask || (() => false); // answers confirm()
    this.opened = new Map(); // module id -> "read" | "edit" | "share"
    this.module = null; // current Module
    this._current = new Map(); // module id -> its current Object
    this.folder = 1; // current Folder (item id)
    this.modified = new Set(); // module ids changed and not yet save()d
    this.trapping = false; // between noError() and lastError()
    this.last_error = "";
    this.closers = []; // run when the script ends
    this.displays = new Map(); // module id -> its filter and sort (lib/displayset.ts)
    this.state = new Map(); // scratch space for library files, keyed by their own names
    this.deadline = null;
  }

  /** How `value " "` renders. */
  text(type_name: string, value: any): string {
    if (type_name === "attr") return value.get();
    const converter = this.lib.strings.get(type_name);
    return converter ? converter(this, value) : base_text(value, type_name);
  }

  /** Called in every loop and function call: stops a script past its deadline. */
  tick(line: number): void {
    if (this.deadline !== null && Date.now() > this.deadline) {
      throw new DxlError(line, "the script ran past its time limit");
    }
  }

  need(value: any, what: string): any {
    if (value === null || value === undefined) throw new Fault(`null ${what}`);
    return value;
  }

  // -- current ---------------------------------------------------------

  /** Each module has its own current object; it starts at the first one. */
  current_object(module_id: number | null): any {
    if (module_id === null || !this.opened.has(module_id)) return null;
    let obj = this._current.get(module_id) ?? null;
    if (obj === null || !this.store.object(obj.module_id, obj.absno)) {
      const live = this.store.objects(module_id);
      obj = live.length ? live[0] : null;
    }
    return obj;
  }

  get object(): any {
    return this.current_object(this.module);
  }

  set object(value: any) {
    if (value === null) this._current.delete(this.module);
    else this._current.set(value.module_id, value);
  }

  // -- open modules ----------------------------------------------------

  /** Open a formal module. A stronger mode wins over a weaker one. */
  open(module_id: number, mode: string = "read"): number {
    if (!this.opened.has(module_id)) this.displays.delete(module_id);
    const held = this.opened.get(module_id);
    if (held === undefined || held === "read") this.opened.set(module_id, mode);
    return module_id;
  }

  is_open(module_id: number): boolean {
    return this.opened.has(module_id);
  }

  /** `module_id`, checked to be a non-null open module. */
  opened_module(module_id: any): number {
    this.need(module_id, "Module");
    if (!this.opened.has(module_id)) throw new Fault("the module is not open");
    return module_id;
  }

  /** An Object checked to be non-null with its module open. */
  obj(value: any): any {
    this.need(value, "Object");
    if (!this.opened.has(value.module_id)) throw new Fault("the Object's module is not open");
    return value;
  }

  /** Call before any change to a module: as in DOORS, a module opened
   * with read() cannot be changed. */
  editing(module_id: any): number {
    this.opened_module(module_id);
    if (this.store.is_baseline(module_id)) throw new Fault("a baseline cannot be changed");
    if (this.opened.get(module_id) === "read") {
      throw new Fault(`${this.store.path(module_id)} is open read-only; open it with edit() or share()`);
    }
    this.modified.add(module_id);
    return module_id;
  }
}
