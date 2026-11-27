// The project file: a whole database as human-editable JSON.
//
// The format is described in docs/project-format.md. A module is written as its
// current state plus the states its baselines froze; loading replays them oldest
// first, so baselines, comparisons and suspect links come back. "steps" are edits
// a person writes to happen after everything else is loaded.
//
// There are no files in the browser: dump_project returns the text and
// load_project takes it.

import { RIGHTS, STANDARD_ATTRIBUTES, Obj, StoreError, _ascii_digits, _cmp, _repr, _type_name,
         rights_names } from "../store.ts";
import type { Store, Link, AttrDef } from "../store.ts";

export const FORMAT = "opendoor-project", VERSION = 1;

export const STANDARD: ReadonlyMap<string, string> = new Map(STANDARD_ATTRIBUTES);
export const SHORTHAND: Readonly<Record<string, string>> = {
  heading: "Object Heading", short_text: "Object Short Text", text: "Object Text" };
export const BUILT_IN_TYPES: ReadonlySet<string> = new Set([
  ...["String", "Text", "Integer", "Real", "Date"].map((n) => JSON.stringify([n, n, []])),
  JSON.stringify(["Boolean", "Enumeration", ["False", "True"]])]);

export const STATE_KEYS: readonly string[] = [
  "description", "prefix", "types", "attributes", "module_values", "next_number", "objects"];
export const OBJECT_KEYS: readonly string[] = ["number", "values", "deleted", "children", ...Object.keys(SHORTHAND)];
export const STEP_KEYS: Readonly<Record<string, readonly string[]>> = {
  baseline: ["module", "annotation", "major", "suffix"],
  set: ["object", "values", ...Object.keys(SHORTHAND)],
  add: ["module", "under", "after", "before", "values", ...Object.keys(SHORTHAND)],
  delete: ["object"],
  link: ["module", "from", "to"],
  unlink: ["module", "from", "to"],
};

// =========================================================================
// Reading JSON strictly, and saying what is wrong with its shape
// =========================================================================

// A float (or an integer too big for a number), kept apart from whole numbers.
class _Num {
  value: number;
  text: string;
  constructor(value: number, text: string) {
    this.value = value;
    this.text = text;
  }
  valueOf(): number { return this.value; }
  toString(): string { return this.text; }
  toJSON(): number { return this.value; }
}

function _float_repr(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const [mantissa, e] = v.toExponential().split("e");
  const exp = Number(e);
  if (exp < -4 || exp >= 16) return `${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  const s = String(v);
  return s.includes(".") ? s : s + ".0";
}

class _JsonError extends Error {}

function _parse_json(text: string): any {
  let at = 0;
  const fail = (message: string, pos: number): never => {
    const before = text.slice(0, pos);
    const line = before.split("\n").length;
    const column = [...before.slice(before.lastIndexOf("\n") + 1)].length + 1;
    throw new _JsonError(`${message}: line ${line} column ${column} (char ${[...before].length})`);
  };
  const space = () => {
    while (" \t\n\r".includes(text[at] ?? "x")) at++;
  };
  const string = (): string => {
    const start = at++;
    let out = "";
    for (;;) {
      let end = at;
      while (end < text.length && text[end] !== '"' && text[end] !== "\\" && text[end] >= " ") end++;
      out += text.slice(at, end);
      at = end;
      if (at >= text.length) fail("Unterminated string starting at", start);
      const c = text[at];
      if (c === '"') {
        at++;
        return out;
      }
      if (c !== "\\") fail("Invalid control character at", at);
      const next = text[at + 1];
      if (next === undefined) fail("Unterminated string starting at", start);
      if (next === "u") {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\uXXXX escape", at + 1);
        out += String.fromCharCode(parseInt(hex, 16));
        at += 6;
        continue;
      }
      const plain = ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as
        Record<string, string>)[next];
      if (plain === undefined) fail("Invalid \\escape", at);
      out += plain;
      at += 2;
    }
  };
  const number = /(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
  const words: [string, () => any][] = [
    ["null", () => null], ["true", () => true], ["false", () => false],
    ["NaN", () => new _Num(NaN, "nan")], ["Infinity", () => new _Num(Infinity, "inf")],
    ["-Infinity", () => new _Num(-Infinity, "-inf")]];
  const value = (): any => {
    const c = text[at];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      const object = c === "{", close = object ? "}" : "]";
      const out: any = object ? {} : [];
      at++;
      space();
      if (text[at] === close) {
        at++;
        return out;
      }
      for (;;) {
        if (object) {
          if (text[at] !== '"') fail("Expecting property name enclosed in double quotes", at);
          const key = string();
          space();
          if (text[at] !== ":") fail("Expecting ':' delimiter", at);
          at++;
          space();
          const held = value();
          Object.defineProperty(out, key, { value: held, enumerable: true, writable: true, configurable: true });
        } else out.push(value());
        space();
        if (text[at] === close) {
          at++;
          return out;
        }
        if (text[at] !== ",") fail("Expecting ',' delimiter", at);
        const comma = at++;
        space();
        if (text[at] === close) fail(`Illegal trailing comma before end of ${object ? "object" : "array"}`, comma);
      }
    }
    for (const [word, make] of words) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return make();
      }
    }
    number.lastIndex = at;
    const found = number.exec(text);
    if (!found) fail("Expecting value", at);
    at = number.lastIndex;
    const n = Number(found![0]);
    if (found![2] !== undefined || found![3] !== undefined) return new _Num(n, _float_repr(n));
    return Number.isSafeInteger(n) ? n : new _Num(n, BigInt(found![0]).toString());
  };
  space();
  const out = value();
  space();
  if (at < text.length) fail("Extra data", at);
  return out;
}

class _KeyError extends Error {}

function _error(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function _kind(value: unknown): string {
  return value instanceof _Num ? "float" : _type_name(value);
}

function _is_dict(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof _Num);
}

// entry[key]
function _key(entry: any, key: string): any {
  if (!_is_dict(entry)) {
    if (typeof entry === "string") throw new TypeError("string indices must be integers, not 'str'");
    if (Array.isArray(entry)) throw new TypeError("list indices must be integers or slices, not str");
    throw new TypeError(`'${_kind(entry)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(entry, key)) throw new _KeyError(_repr(key));
  return entry[key];
}

// entry.get(key, fallback)
function _get(entry: any, key: string, fallback: any = null): any {
  if (!_is_dict(entry)) throw _error("AttributeError", `'${_kind(entry)}' object has no attribute 'get'`);
  return Object.hasOwn(entry, key) ? entry[key] : fallback;
}

function _iter(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (_is_dict(value)) return Object.keys(value);
  throw new TypeError(`'${_kind(value)}' object is not iterable`);
}

function _items(value: any): [string, any][] {
  if (!_is_dict(value)) throw _error("AttributeError", `'${_kind(value)}' object has no attribute 'items'`);
  return Object.entries(value);
}

function _str(value: any, method: string): string {
  if (typeof value !== "string") {
    throw _error("AttributeError", `'${_kind(value)}' object has no attribute '${method}'`);
  }
  return value;
}

// the text the database holds for it
function _column(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || value instanceof _Num) return String(value);
  throw new TypeError(`a text value cannot be of type '${_kind(value)}'`);
}

function _truthy(value: any): boolean {
  if (value instanceof _Num) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (_is_dict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function _numeric(value: any): boolean {
  return typeof value === "number" || typeof value === "boolean" || value instanceof _Num;
}

// a < b ordering of sort keys, as -1, 0, 1
function _order(a: any, b: any): number {
  if (typeof a === "string" && typeof b === "string") return Math.sign(_cmp(a, b));
  if (_numeric(a) && _numeric(b)) return Math.sign(Number(a) - Number(b));
  throw new TypeError(`'<' not supported between instances of '${_kind(a)}' and '${_kind(b)}'`);
}

function _order_all(a: any[], b: any[]): number {
  for (let i = 0; i < a.length; i++) {
    const found = _order(a[i], b[i]);
    if (found) return found;
  }
  return 0;
}

// =========================================================================

// A misspelt key would otherwise drop content without a word.
function _only(entry: any, allowed: readonly string[], what: unknown): any {
  if (!_is_dict(entry)) throw new StoreError(`${what} must be a JSON object`);
  const unknown = Object.keys(entry).filter((k) => !allowed.includes(k)).sort(_cmp);
  if (unknown.length) throw new StoreError(`${what}: unknown key ${unknown.map(_repr).join(", ")}`);
  return entry;
}

// The id of the folder or project at `path`, creating whatever is missing.
export function ensure_folder(store: Store, path: string, description: string = "", project: boolean = false): number {
  const parts = _str(path, "split").split("/").filter((p) => p);
  let current = "";
  parts.forEach((name, index) => {
    const parent = current || "/";
    current = `${current}/${name}`;
    if (store.find(current) === null) {
      const last = index + 1 === parts.length;
      store.create_folder(parent, name, last ? _column(description) : "", _truthy(project) && last);
    }
  });
  const found = store.find(path || "/")!;
  if (!["folder", "project"].includes(store.item(found).kind)) {
    throw new StoreError(`${path} is not a folder or project`);
  }
  return found;
}

function _split(path: any): [string, string] {
  const trimmed = _str(path, "rstrip").replace(/(?<!\/)\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return [(slash < 0 ? "" : trimmed.slice(0, slash)) || "/", trimmed.slice(slash + 1)];
}

// =========================================================================
// Writing
// =========================================================================

// project-file key, AttrType field
const TYPE_KEYS = [["description", "description"], ["numbers", "numbers"], ["colours", "colours"],
  ["real_colours", "real_colours"], ["descriptions", "descriptions"], ["min", "min"], ["max", "max"]] as const;
// project-file key, AttrDef field, the value that is not written
const DEF_FLAGS = [["inherit", "inherit", false], ["hidden", "hidden", false], ["history", "history", true],
  ["change_bars", "bars", true], ["change_dates", "dates", true]] as const;

function _written_type(type: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, field] of TYPE_KEYS) {
    const value = type[field];
    if (Array.isArray(value) ? value.length : value) out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

// the extras a project file's type entry holds, checked
function _read_type(entry: any, where: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, field] of TYPE_KEYS) {
    if (!Object.hasOwn(entry, key)) continue;
    const value = entry[key];
    if (key === "numbers" || key === "colours") {
      const numbers = _iter(value).map((v) => Number(v instanceof _Num ? v.value : v));
      if (!numbers.every(Number.isInteger)) throw new StoreError(`${where}: a type's ${key} are whole numbers`);
      out[field] = numbers;
    } else if (key === "descriptions") out[field] = _iter(value).map(_column);
    else if (key === "real_colours") out[field] = _truthy(value);
    else out[field] = _column(value);
  }
  return out;
}

// The things with access rights of their own (baselines left out).
function _written_access(store: Store): any[] {
  const out: any[] = [];
  const add = (thing: number | Obj, entry: Record<string, any>) => {
    if (store.is_access_inherited(thing)) return;
    entry.entries = store.access_list(thing).map((e) => ({ name: e.name, rights: rights_names(e.rights) }));
    out.push(entry);
  };
  for (const item of store.walk()) {
    add(item.id, { path: store.path(item.id) });
    if (item.kind !== "formal") continue;
    for (const obj of store.objects(item.id, true)) add(obj, { path: store.path(item.id), object: obj.absno });
  }
  return out;
}

// Applied last, so that no restriction stands in the way of loading the rest,
// and deepest first, so that none stands in the way of the others.
function _load_access(store: Store, data: any): void {
  const entries = _iter(_get(data, "access", [])).map((entry) => {
    _only(entry, ["path", "object", "entries"], "an access entry");
    const path = _column(_key(entry, "path")), number = _get(entry, "object");
    const item = store.find(path);
    const thing = item === null || number === null ? item : store.object(item, Number(_column(number)));
    if (thing === null) throw new StoreError(`access: nothing at ${path}`);
    const list = _iter(_key(entry, "entries")).map((e) => {
      _only(e, ["name", "rights"], "an access entry");
      let rights = 0;
      for (const name of _iter(_key(e, "rights"))) {
        if (!Object.hasOwn(RIGHTS, name)) throw new StoreError(`access: no right called ${_repr(name)}`);
        rights |= (RIGHTS as Record<string, number>)[name];
      }
      return { name: _get(e, "name") === null ? null : _column(_get(e, "name")), rights };
    });
    const depth = path.split("/").length + (thing instanceof Obj ? 1000 + store.level(thing) : 0);
    return { thing, list, depth };
  });
  for (const { thing, list } of entries.sort((a, b) => b.depth - a.depth)) store.restore_access(thing, list);
}

// Everything a baseline freezes, apart from links.
function _state(store: Store, module_id: number): Record<string, any> {
  const item = store.item(module_id);
  const types = store.types(module_id)
    .filter((t) => !BUILT_IN_TYPES.has(JSON.stringify([t.name, t.base, t.values])))
    .map((t) => ({ name: t.name, base: t.base, ...(t.values.length ? { values: [...t.values] } : {}),
                   ..._written_type(t) }));
  const definitions = store.attributes(module_id, null);
  const attributes: Record<string, any>[] = [];
  for (const a of definitions) {
    if (STANDARD.has(a.name)) continue;
    const entry: Record<string, any> = { name: a.name, type: a.type_name };
    if (a.scope !== "object") entry.scope = a.scope;
    if (a.multi) entry.multi = true;
    if (a.default) entry.default = a.multi ? a.default.split("\n") : a.default;
    if (a.dxl) entry.dxl = a.dxl;
    if (a.description) entry.description = a.description;
    for (const [key, field, usual] of DEF_FLAGS) {
      if (a[field] !== usual) entry[key] = a[field];
    }
    attributes.push(entry);
  }
  const by_name = new Map<string, AttrDef>(definitions.map((a) => [a.name, a]));

  const written = (name: string, value: string) =>
    by_name.get(name)!.multi && value ? value.split("\n") : value;

  const module_values = Object.fromEntries(definitions
    .filter((a) => a.scope === "module" && store.module_value(module_id, a.name) !== a.default)
    .map((a) => [a.name, written(a.name, store.module_value(module_id, a.name))]));

  const held = store.values(module_id, true);
  const entries = new Map<number, Record<string, any>>(), tree: Record<string, any>[] = [];
  for (const obj of store.objects(module_id, true)) {
    const mine = held.get(obj.absno) ?? new Map<string, string>();
    const entry: Record<string, any> = { number: obj.absno };
    for (const [key, name] of Object.entries(SHORTHAND)) {
      if (mine.get(name)) entry[key] = mine.get(name);
    }
    const values: [string, string | string[]][] = [];
    for (const a of definitions) {
      if (a.scope !== "object" || STANDARD.has(a.name)) continue;
      const value = mine.get(a.name) ?? "";
      // an emptied default must be written, or it comes back; so must an emptied inherited value
      if (a.inherit ? mine.has(a.name) : value || a.default) values.push([a.name, written(a.name, value)]);
    }
    if (values.length) entry.values = Object.fromEntries(values);
    if (store.is_deleted(obj)) entry.deleted = true;
    entries.set(obj.absno, entry);
    const parent = store.parent_object(obj);
    const siblings = parent === null ? tree : (entries.get(parent.absno)!.children ??= []);
    siblings.push(entry);
  }

  const state: Record<string, any> = { description: item.description, prefix: store.prefix(module_id) };
  for (const [key, content] of [["types", types], ["attributes", attributes]] as const) {
    if (content.length) state[key] = content;
  }
  if (Object.keys(module_values).length) state.module_values = module_values;
  state.objects = tree;
  return state;
}

type _Table = Map<string, [string, (number: any) => boolean]>;

// [module path, number] for "SRS-4" or {"module": path, "number": 4}.
// `table` is Map module path -> [prefix, has(number)].
function _resolve(ref: any, table: _Table): [string, number] {
  if (_is_dict(ref)) {
    _only(ref, ["module", "number"], "object reference");
    const path = _key(ref, "module"), number = _key(ref, "number");
    const n = _numeric(number) ? Number(number) : number;
    if (!table.has(path) || !table.get(path)![1](n)) {
      throw new StoreError(`no object number ${number === true ? "True" : number ?? "None"} in ${path}`);
    }
    return [path, n];
  }
  const found: [string, number][] = [];
  for (const [path, [prefix, has]] of table) {
    if (typeof ref !== "string" && !Array.isArray(ref)) {
      throw new TypeError(`'${_kind(ref)}' object is not subscriptable`);
    }
    const text = _str(ref, "startswith");
    const digits = text.slice(_str(prefix, "startswith").length);
    if (text.startsWith(prefix) && /^\p{Nd}+$/u.test(digits)) {
      const n = Number(_ascii_digits(digits));
      if (has(n)) found.push([path, n]);
    }
  }
  if (found.length !== 1) {
    const why = !found.length ? "no object" : "more than one object";
    throw new StoreError(`${why} is identified as ${_repr(ref)}`
      + (found.length ? ' (write {"module": path, "number": n})' : ""));
  }
  return found[0];
}

// The whole database as the text of a project file.
//
// Kept: folders, modules, objects with their numbers, soft deletions, links and
// whether they are suspect, views, baselines. Not kept: history, who and when,
// and anything soft-deleted at folder or module level.
export function dump_project(store: Store): string {
  const folders: any[] = [], formal = new Map<number, string>(), link_modules: any[] = [];
  for (const item of store.walk()) {
    const where = store.path(item.id);
    const entry: Record<string, any> = { path: where };
    if (item.description && item.kind !== "formal") entry.description = item.description;
    if (item.kind === "folder" || item.kind === "project") {
      if (item.kind === "project") entry.project = true;
      // one naming a module that has gone could not be loaded again
      const descriptors = store.link_descriptors(item.id);
      if (descriptors.length) entry.link_descriptors = descriptors;
      const exclusive = store.children(item.id).filter((c) => store.links_exclusive(item.id, c.id));
      if (exclusive.length) entry.links_exclusive = exclusive.map((c) => c.name);
      folders.push(entry);
    } else if (item.kind === "link") {
      const linksets = store.linksets(item.id).map(([a, b]) => [a, b].map((m) => store.path(m)))
        .filter(([a, b]) => store.module_at(a) !== null && store.module_at(b) !== null);
      if (linksets.length) entry.linksets = linksets.sort((x, y) => _cmp(x.join("\n"), y.join("\n")));
      link_modules.push(entry);
    } else formal.set(item.id, where);
  }

  const numbers = new Map<number, Set<number>>(
    [...formal.keys()].map((m) => [m, new Set(store.objects(m, true).map((o) => o.absno))]));
  const table: _Table = new Map([...formal].map(([m, where]) =>
    [where, [store.prefix(m), (n: number) => numbers.get(m)!.has(n)]]));

  const reference = (obj: Obj): any => {
    const text = store.identifier(obj);
    try {
      const [where, number] = _resolve(text, table);
      if (where === formal.get(obj.module_id) && number === obj.absno) return text;
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
    }
    return { module: formal.get(obj.module_id), number: obj.absno };
  };

  // Links leaving a module or baseline whose far end is being written too,
  // in an order that does not depend on how the database numbered things.
  function* outgoing(module_id: number): Generator<[Link, Obj, Obj]> {
    const order = (link: Link) =>
      [store.path(link.link_module), store.path(link.target.module_id), link.target.absno];
    for (const obj of store.objects(module_id, true)) {
      const sorted = store.links(obj, true).map((link) => [order(link), link] as const)
        .sort((a, b) => _order_all(a[0], b[0]));
      for (const [, link] of sorted) {
        let target = link.target;
        if (target.module_id === module_id) {
          const owner = store.baseline_of(module_id);
          if (owner) target = new Obj(owner.module_id, target.absno);
        }
        if (formal.has(target.module_id) && numbers.get(target.module_id)!.has(target.absno)) {
          yield [link, obj, target];
        }
      }
    }
  }

  const modules: any[] = [], links: any[] = [];
  for (const [module_id, where] of formal) {
    const entry: Record<string, any> = { path: where, ..._state(store, module_id) };
    let created = 0, highest = 0;
    for (const h of store.history(module_id)) {
      if (h.action === "createObject" && h.absno! > created) created = h.absno!;
    }
    for (const n of numbers.get(module_id)!) highest = Math.max(highest, n);
    if (created && created > highest) entry.next_number = created + 1;
    const views = store.views(module_id);
    if (views.size) entry.views = Object.fromEntries(views);
    const baselines: any[] = [];
    for (const b of store.baselines(module_id)) {
      const frozen: Record<string, any> = {
        major: b.major, minor: b.minor, suffix: b.suffix, annotation: b.annotation,
        created_on: b.created_on, ..._state(store, b.copy_id) };
      frozen.links = [...outgoing(b.copy_id)].map(([link, source, target]) =>
        ({ module: store.path(link.link_module), from: source.absno, to: reference(target) }));
      baselines.push(frozen);
    }
    if (baselines.length) entry.baselines = baselines;
    modules.push(entry);

    for (const [link, source, target] of outgoing(module_id)) {
      const written: Record<string, any> = {
        module: store.path(link.link_module), from: reference(source), to: reference(target) };
      const changed = store.suspect(link);
      const suspect = ["source", "target"].filter((_, i) => changed[i]);
      if (suspect.length) written.suspect = suspect;
      links.push(written);
    }
  }

  const data: Record<string, any> = { format: FORMAT, version: VERSION, folders, modules, link_modules, links };
  const access = _written_access(store);
  if (access.length) data.access = access;
  return JSON.stringify(data, null, 2) + "\n";
}

// =========================================================================
// Reading
// =========================================================================

// Add the project file's contents to the database, all or nothing.
//
// `text` is the file's contents; `path` is only its name, for messages.
// Folders and link modules that exist are reused; a formal module that already
// exists is refused.
export function load_project(store: Store, text: string | Uint8Array, path: string = "project file"): void {
  let data: any;
  try {
    const decoded = typeof text === "string" ? text.replace(/^﻿/, "")
      : new TextDecoder("utf-8", { fatal: true }).decode(text);
    data = _parse_json(decoded);
  } catch (error) {
    if (!(error instanceof _JsonError || error instanceof TypeError || error instanceof RangeError)) throw error;
    throw new StoreError(`${path} is not a UTF-8 JSON file: ${(error as Error).message}`);
  }
  load_project_data(store, data, path);
}

// load_project for contents already parsed from JSON.
export function load_project_data(store: Store, data: any, path: string = "project file"): void {
  const version = _is_dict(data) ? _get(data, "version") : null;
  if (!_is_dict(data) || _get(data, "format") !== FORMAT || !(_numeric(version) && Number(version) === VERSION)) {
    throw new StoreError(`${path} is not a project file ("format": "${FORMAT}", "version": ${VERSION})`);
  }
  _only(data, ["format", "version", "folders", "modules", "link_modules", "links", "steps", "created_on", "access"],
    path);
  try {
    store.transaction(() => _load(store, data));
  } catch (error) {
    if (error instanceof _KeyError) throw new StoreError(`${path}: an entry lacks the key ${error.message}`);
    const e = error as Error;
    if (e instanceof TypeError || e instanceof RangeError || e.name === "ValueError" || e.name === "AttributeError") {
      throw new StoreError(`${path}: something has the wrong shape (${e.message})`);
    }
    throw error;
  }
}

function _load(store: Store, data: any): void {
  const ids = store.dated(_get(data, "created_on"), () => _load_content(store, data));
  _iter(_get(data, "steps", [])).forEach((step, index) => {
    try {
      _step(store, step, ids);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      throw new StoreError(`step ${index + 1}: ${error.message}`);
    }
  });
  _load_access(store, data);
}

type _Wanted = Map<string, [any, any, Obj, Set<string>]>;

function _link_key(link_module: unknown, number: unknown, target: Obj): string {
  return JSON.stringify([link_module, number, target.module_id, target.absno]);
}

function _load_content(store: Store, data: any): Map<string, number> {
  for (const entry of _iter(_get(data, "folders", []))) {
    _only(entry, ["path", "description", "project", "link_descriptors", "links_exclusive"], "folder");
    ensure_folder(store, _key(entry, "path"), _get(entry, "description", ""), _get(entry, "project", false));
  }
  for (const entry of _iter(_get(data, "link_modules", []))) {
    _only(entry, ["path", "description", "linksets"], "link module");
    const [parent, name] = _split(_key(entry, "path"));
    ensure_folder(store, parent);
    if (store.module_at(_key(entry, "path"), "link") === null) {
      store.create_link_module(parent, name, _column(_get(entry, "description", "")));
    }
  }

  const specs = new Map<string, any>(), ids = new Map<string, number>();
  for (const spec of _iter(_get(data, "modules", []))) {
    const where = _key(spec, "path");
    _only(spec, [...STATE_KEYS, "path", "views", "baselines"], where);
    const [parent, name] = _split(where);
    ensure_folder(store, parent);
    ids.set(where, store.create_module(parent, name));
    specs.set(where, spec);
  }

  const table: _Table = new Map();
  for (const [where, spec] of specs) {
    const present = new Set(_flatten(spec, where).map((o) => o[0]));
    table.set(where, [_get(spec, "prefix", ""), (n: number) => present.has(n)]);
  }

  const obj = (ref: any): Obj => {
    const [where, number] = _resolve(ref, table);
    return new Obj(ids.get(where)!, number);
  };

  // Each module's states, oldest first; the last is how it is now.
  const timelines = new Map<string, any[]>();
  for (const [where, spec] of specs) {
    const frozen = _iter(_get(spec, "baselines", []));
    for (const b of frozen) {
      _only(b, [...STATE_KEYS, "major", "minor", "suffix", "annotation", "created_on", "links"], `${where} baseline`);
    }
    timelines.set(where, [...frozen, spec]);
    _apply(store, ids.get(where)!, timelines.get(where)![0], where);
  }

  // Baselines in the order they were made, each module then moving to its next state.
  const done = new Map([...specs.keys()].map((w) => [w, 0]));
  for (;;) {
    const waiting = [...specs.keys()].filter((w) => done.get(w)! < timelines.get(w)!.length - 1);
    if (!waiting.length) break;
    const made = (w: string) => _get(timelines.get(w)![done.get(w)!], "created_on", "");
    let where = waiting[0], earliest = made(where);
    for (const w of waiting.slice(1)) {
      const stamp = made(w);
      if (_order(stamp, earliest) < 0) {
        where = w;
        earliest = stamp;
      }
    }
    const module = ids.get(where)!, frozen = timelines.get(where)![done.get(where)!];
    _set_links(store, module, _iter(_get(frozen, "links", [])).map((l) => {
      const link_module = _key(l, "module"), number = _key(l, "from");
      return [link_module, number, obj(_key(l, "to"))] as [any, any, Obj];
    }));
    const last = store.baselines(module);
    const wanted_major = _get(frozen, "major", 0);
    if (!_numeric(wanted_major)) {
      throw new TypeError(`'>' not supported between instances of '${_kind(wanted_major)}' and 'int'`);
    }
    const major = Number(wanted_major) > (last.length ? last[last.length - 1].major : 0);
    store.create_baseline(module, _column(_get(frozen, "annotation", "")), major, _column(_get(frozen, "suffix", "")));
    done.set(where, done.get(where)! + 1);
    _apply(store, module, timelines.get(where)![done.get(where)!], where);
  }

  const wanted = new Map<number, _Wanted>([...ids.values()].map((module) => [module, new Map()]));
  for (const entry of _iter(_get(data, "links", []))) {
    _only(entry, ["module", "from", "to", "suspect"], "link");
    const source = obj(_key(entry, "from"));
    const suspect = new Set<string>(_iter(_get(entry, "suspect", [])));
    if ([...suspect].some((end) => end !== "source" && end !== "target")) {
      throw new StoreError('a link\'s "suspect" lists "source" and/or "target"');
    }
    const link_module = _key(entry, "module");
    const target = obj(_key(entry, "to"));
    wanted.get(source.module_id)!.set(_link_key(link_module, source.absno, target),
                                      [link_module, source.absno, target, suspect]);
  }
  for (const [module, links] of wanted) {
    _set_links(store, module, [...links.values()].map(([m, n, t]) => [m, n, t] as [any, any, Obj]));
  }
  _set_suspect(store, wanted);
  for (const entry of _iter(_get(data, "link_modules", []))) {
    const link_module = store.module_at(_key(entry, "path"), "link")!;
    for (const pair of _iter(_get(entry, "linksets", []))) {
      const [a, b] = _iter(pair).map((path) => store.module_at(_column(path)));
      if (a === null || b === null || a === undefined || b === undefined) {
        throw new StoreError("a linkset names two formal modules by their full paths");
      }
      if (!store.linksets(link_module).some(([x, y]) => x === a && y === b)) store.create_linkset(link_module, a, b);
    }
  }
  // after the links, so that a limit does not stand in the way of loading them
  for (const entry of _iter(_get(data, "folders", []))) {
    const folder = store.find(_key(entry, "path"))!;
    for (const d of _iter(_get(entry, "link_descriptors", []))) {
      _only(d, ["source", "target", "linkmod", "overridable", "mandatory"], "link descriptor");
      const descriptor = { source: _column(_key(d, "source")), target: _column(_key(d, "target")),
        linkmod: _column(_key(d, "linkmod")), overridable: _truthy(_get(d, "overridable")),
        mandatory: _truthy(_get(d, "mandatory")) };
      const held = store.link_descriptors(folder)
        .find((h) => h.source === descriptor.source && h.target === descriptor.target);
      if (!held) store.add_link_descriptor(folder, descriptor);
      else if (held.linkmod !== descriptor.linkmod) {
        throw new StoreError("a link descriptor is already defined differently here");
      }
    }
    for (const name of _iter(_get(entry, "links_exclusive", []))) {
      const module = store.find(_column(name), folder);
      if (module === null) throw new StoreError(`links_exclusive: no module ${_repr(name)}`);
      store.set_links_exclusive(folder, module, true);
    }
  }

  for (const [where, spec] of specs) {
    for (const [name, definition] of _items(_get(spec, "views", {}))) {
      store.save_view(ids.get(where)!, name, definition);
    }
  }

  return ids;
}

type _Flat = [number, number | null, Map<string, string>, boolean];

// [[number, parent number, values, deleted]] in document order.
function _flatten(state: any, where: string): _Flat[] {
  const used = new Set<number>();
  let free = 0;

  const collect = (entries: any) => {
    for (const entry of _iter(entries)) {
      _only(entry, OBJECT_KEYS, `an object in ${where}`);
      const number = _get(entry, "number");
      if (number !== null) {
        if (typeof number !== "number" || number < 1 || used.has(number)) {
          throw new StoreError(`${where}: object number ${_repr(number)} is repeated or not a positive integer`);
        }
        used.add(number);
        free = Math.max(free, number);
      }
      collect(_get(entry, "children", []));
    }
  };

  collect(_get(state, "objects", []));
  const out: _Flat[] = [];

  const visit = (entries: any, parent: number | null) => {
    for (const entry of _iter(entries)) {
      let number = _get(entry, "number");
      if (number === null) {
        free += 1;
        number = free;
      }
      out.push([number, parent, _values(entry), _truthy(_get(entry, "deleted"))]);
      visit(_get(entry, "children", []), number);
    }
  };

  visit(_get(state, "objects", []), null);
  return out;
}

function _text(value: any): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return value.map(_text).join("\n");
  if (typeof value === "string" || typeof value === "number" || value instanceof _Num) return String(value);
  throw new StoreError(`an attribute value must be text, a number or a list, not ${_repr(value)}`);
}

function _values(entry: any): Map<string, string> {
  const values = new Map<string, string>(
    _items(_get(entry, "values", {})).map(([name, value]) => [name, _text(value)]));
  for (const [key, name] of Object.entries(SHORTHAND)) {
    if (Object.hasOwn(entry, key)) values.set(name, _text(entry[key]));
  }
  return values;
}

// Bring a module (new, or holding an earlier state) to `state`, links aside.
function _apply(store: Store, module: number, state: any, where: string): void {
  store.set_item(module, null, _column(_get(state, "description", "")), _column(_get(state, "prefix", "")));
  _apply_definitions(store, module, state, where);

  const flat = _flatten(state, where);
  const numbers = new Set(flat.map(([number]) => number));
  const existing = new Set(store.objects(module, true).map((o) => o.absno));
  for (const obj of store.objects(module, true)) { // parents come first
    if (store.is_deleted(obj)) store.undelete_object(obj);
  }

  // Absolute numbers are handed out in order, so create up to the highest one
  // wanted; the ones the state does not hold are purged below.
  const next = _get(state, "next_number", 1);
  if (!_numeric(next)) throw new TypeError(`unsupported operand type(s) for -: '${_kind(next)}' and 'int'`);
  let top = Number(next) - 1;
  for (const n of numbers) top = Math.max(top, n);
  let last = 0;
  for (const n of existing) last = Math.max(last, n);
  const created = new Set<number>();
  while (last < top) {
    last = store.create_object(module).absno;
    created.add(last);
  }
  const gone = [...numbers].filter((n) => !existing.has(n) && !created.has(n));
  if (gone.length) {
    const least = gone.reduce((a, b) => Math.min(a, b));
    throw new StoreError(`${where}: object number ${least} was purged and cannot be used again`);
  }

  const placed = store.objects(module, true).filter((o) => numbers.has(o.absno))
    .map((o) => [o.absno, store.parent_object(o)?.absno ?? null]);
  if (placed.length !== flat.length
      || placed.some(([number, parent], i) => number !== flat[i][0] || parent !== flat[i][1])) {
    for (const [number, parent] of flat) {
      store.move_object(new Obj(module, number), parent === null ? null : new Obj(module, parent));
    }
  }

  const unwanted = store.objects(module, true).filter((o) => !numbers.has(o.absno));
  if (unwanted.length) {
    for (let i = unwanted.length - 1; i >= 0; i--) store.delete_object(unwanted[i]);
    store.purge(module);
  }

  const shorthand = Object.values(SHORTHAND);
  const definitions = store.attributes(module).filter((a) => !shorthand.includes(a.name));
  const blank = [...definitions.filter((a) => !a.default && !a.dxl && !a.inherit).map((a) => a.name), ...shorthand];
  for (let [number, , values] of flat) {
    const obj = new Obj(module, number);
    if (existing.has(number)) { // an attribute the state leaves out was emptied
      values = new Map([...blank.map((name) => [name, ""] as [string, string]), ...values]);
    }
    for (const [name, value] of values) store.set_value(obj, name, value);
  }
  for (let i = flat.length - 1; i >= 0; i--) {
    if (flat[i][3]) store.delete_object(new Obj(module, flat[i][0]));
  }
}

function _apply_definitions(store: Store, module: number, state: any, where: string): void {
  const given_types = new Map<string, any>(_iter(_get(state, "types", [])).map((e) => [_key(e, "name"), e]));
  const shape = (base: unknown, values: unknown, extras: unknown) => JSON.stringify([base, values, extras]);
  // A type of the module's own that this state changes or drops goes, with the
  // attributes using it, which are made again below from the state.
  for (const t of store.types(module)) {
    if (BUILT_IN_TYPES.has(JSON.stringify([t.name, t.base, t.values])) && !given_types.has(t.name)) continue;
    const entry = given_types.get(t.name);
    if (entry !== undefined && shape(t.base, [...t.values], _read_type(_written_type(t), where))
        === shape(_get(entry, "base"), _iter(_get(entry, "values", [])).map((v) => (v instanceof _Num ? v.value : v)),
                  _read_type(entry, where))) continue;
    for (const name of store.type_users(module, t.name)) store.delete_attribute(module, name);
    store.delete_type(module, t.name);
  }
  const types = new Map(store.types(module).map((t) => [t.name, t]));
  for (const entry of _iter(_get(state, "types", []))) {
    _only(entry, ["name", "base", "values", ...TYPE_KEYS.map(([key]) => key)], `a type in ${where}`);
    const values = _iter(_get(entry, "values", [])).map((v) => (v instanceof _Num ? v.value : v));
    const extras = _read_type(entry, where);
    const known = types.get(_key(entry, "name"));
    if (known === undefined) {
      store.create_type(module, _key(entry, "name"), _key(entry, "base"), values, extras);
    } else if (known.base !== _key(entry, "base") || known.values.length !== values.length
               || known.values.some((v, i) => v !== values[i])
               || JSON.stringify(_read_type(_written_type(known), where)) !== JSON.stringify(extras)) {
      throw new StoreError(`${where}: type ${_repr(_key(entry, "name"))} is defined differently elsewhere`);
    }
  }

  type Shape = [any, any, boolean, string, string, string];
  const wanted = new Map<string, Shape>();
  for (const entry of _iter(_get(state, "attributes", []))) {
    _only(entry, ["name", "type", "scope", "multi", "default", "dxl", "description",
                  ...DEF_FLAGS.map(([key]) => key)], `an attribute in ${where}`);
    const dxl = _get(entry, "dxl", "");
    if (typeof dxl !== "string") throw new StoreError(`${where}: an attribute's "dxl" is its code, as text`);
    if (!STANDARD.has(_key(entry, "name"))) {
      const extras: Record<string, any> = {};
      if (_get(entry, "description")) extras.description = _column(_get(entry, "description"));
      for (const [key, field, usual] of DEF_FLAGS) {
        const flag = _truthy(_get(entry, key, usual));
        if (flag !== usual) extras[field] = flag;
      }
      wanted.set(_key(entry, "name"), [_get(entry, "type", "String"), _get(entry, "scope", "object"),
                                       _truthy(_get(entry, "multi")), _text(_get(entry, "default", "")), dxl,
                                       JSON.stringify(extras)]);
    }
  }
  const current = new Map<string, Shape>(store.attributes(module, null)
    .filter((a) => !STANDARD.has(a.name)).map((a) => {
      const extras: Record<string, any> = {};
      if (a.description) extras.description = a.description;
      for (const [, field, usual] of DEF_FLAGS) {
        if (a[field] !== usual) extras[field] = a[field];
      }
      return [a.name, [a.type_name, a.scope, a.multi, a.default, a.dxl, JSON.stringify(extras)]];
    }));
  const same = (a: Shape | undefined, b: Shape | undefined) => !!a && !!b && a.every((v, i) => v === b[i]);
  for (const [name, shape] of current) {
    if (!same(wanted.get(name), shape)) store.delete_attribute(module, name);
  }
  for (const [name, shape] of wanted) {
    if (!same(current.get(name), shape)) {
      const [type_name, scope, multi, default_, dxl, extras] = shape;
      if (scope !== "object" && scope !== "module") {
        throw new StoreError(`${where}: attribute scope is "object" or "module"`);
      }
      store.create_attribute(module, name, type_name, scope, multi, default_, dxl, JSON.parse(extras));
    }
  }

  const given = new Map<string, string>(
    _items(_get(state, "module_values", {})).map(([name, value]) => [name, _text(value)]));
  for (const definition of store.attributes(module, "module")) {
    const value = given.get(definition.name) ?? definition.default;
    given.delete(definition.name);
    if (value !== store.module_value(module, definition.name)) {
      store.set_module_value(module, definition.name, value);
    }
  }
  if (given.size) {
    throw new StoreError(`${where}: no module attribute ${_repr([...given.keys()].sort(_cmp)[0])}`);
  }
}

// create_link, also between soft-deleted objects (their links outlive them).
function _link(store: Store, source: Obj, target: Obj, link_module: any): void {
  if (!_str(link_module, "startswith").startsWith("/")) {
    throw new StoreError(`give the link module's full path, not ${_repr(link_module)}`);
  }
  const revived: Obj[] = [];

  const revive = (obj: Obj | null) => {
    if (obj === null) return;
    revive(store.parent_object(obj));
    if (store.is_deleted(obj)) {
      store.undelete_object(obj);
      revived.push(obj);
    }
  };

  revive(source);
  revive(target);
  store.create_link(source, target, link_module);
  for (let i = revived.length - 1; i >= 0; i--) store.delete_object(revived[i]);
}

function* _outgoing(store: Store, module: number): Generator<Link> {
  for (const obj of store.objects(module, true)) yield* store.links(obj, true);
}

// Make the links leaving `module` exactly [[link module path, number, target]].
function _set_links(store: Store, module: number, wanted: [any, any, Obj][]): void {
  const keyed = new Map(wanted.map((w) => [_link_key(...w), w]));
  const current = new Map<string, Link>();
  for (const l of _outgoing(store, module)) {
    current.set(_link_key(store.path(l.link_module), l.source.absno, l.target), l);
  }
  for (const [key, link] of current) {
    if (!keyed.has(key)) store.delete_link(link);
  }
  const ordered = [...keyed.values()].sort((a, b) =>
    _order_all([a[0], a[1], a[2].module_id, a[2].absno], [b[0], b[1], b[2].module_id, b[2].absno]));
  for (const [link_module, number, target] of ordered) {
    if (!current.has(_link_key(link_module, number, target))) {
      const source = store.object(module, _numeric(number) ? Number(number) : number);
      if (source === null) {
        throw new StoreError(`a link starts at object number ${number}, which ${store.path(module)} lacks`);
      }
      _link(store, source, target, link_module);
    }
  }
}

// Make exactly the links the file calls suspect so. Loading itself edits
// objects, so every other link is cleared. The file keeps no edit history, so a
// suspect end is marked changed without adding any.
function _set_suspect(store: Store, wanted: Map<number, _Wanted>): void {
  const flagged: Link[] = [], quiet: Link[] = [], touched = new Map<string, Obj>();
  for (const [module, links] of wanted) {
    for (const link of _outgoing(store, module)) {
      const ends = links.get(_link_key(store.path(link.link_module), link.source.absno, link.target))?.[3];
      if (ends && ends.size) {
        flagged.push(link);
        for (const end of ends) {
          const obj = end === "source" ? link.source : link.target;
          touched.set(obj.key, obj);
        }
      } else quiet.push(link);
    }
  }
  for (const link of flagged) store.clear_suspect(link, false);
  for (const obj of [...touched.values()].sort((a, b) => a.module_id - b.module_id || a.absno - b.absno)) {
    store.mark_changed(obj);
  }
  for (const link of quiet) store.clear_suspect(link, false);
}

function _step(store: Store, step: any, ids: Map<string, number>): void {
  const op = _get(step, "op");
  if (op !== null && typeof op === "object" && !(op instanceof _Num)) {
    throw new TypeError(`unhashable type: '${_kind(op)}'`);
  }
  if (typeof op !== "string" || !Object.hasOwn(STEP_KEYS, op)) throw new StoreError(`unknown op ${_repr(op)}`);
  _only(step, [...STEP_KEYS[op], "op"], op);

  const obj = (ref: any): Obj => {
    const table: _Table = new Map([...ids].map(([where, m]) =>
      [where, [store.prefix(m), (n: number) => store.object(m, n) !== null]]));
    const [where, number] = _resolve(ref, table);
    return new Obj(ids.get(where)!, number);
  };

  const module = (): number => {
    const path = _key(step, "module");
    _str(path, "startswith");
    const found = store.module_at(path);
    if (found === null) throw new StoreError(`no formal module ${_repr(path)}`);
    return found;
  };

  if (op === "baseline") {
    store.create_baseline(module(), _column(_get(step, "annotation", "")), _truthy(_get(step, "major", false)),
                          _column(_get(step, "suffix", "")));
  } else if (op === "set") {
    const target = obj(_key(step, "object"));
    for (const [name, value] of _values(step)) store.set_value(target, name, value);
  } else if (op === "add") {
    const place: Record<string, Obj> = {};
    for (const [key, argument] of [["under", "parent"], ["after", "after"], ["before", "before"]]) {
      if (_get(step, key) !== null) place[argument] = obj(step[key]);
    }
    const found = module();
    store.create_object(found, place.parent ?? null, place.after ?? null, place.before ?? null, _values(step));
  } else if (op === "delete") {
    store.delete_object(obj(_key(step, "object")));
  } else if (op === "link") {
    const source = obj(_key(step, "from"));
    const target = obj(_key(step, "to"));
    _link(store, source, target, _key(step, "module"));
  } else {
    const source = obj(_key(step, "from"));
    const target = obj(_key(step, "to"));
    const link = store.links(source, true).find((l) =>
      l.target.equals(target) && store.path(l.link_module) === _key(step, "module"));
    if (!link) throw new StoreError("there is no such link");
    store.delete_link(link);
  }
}
