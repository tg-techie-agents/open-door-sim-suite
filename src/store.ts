// The database: a DOORS-classic-shaped model held in memory.
//
// This is the only module that holds the tables. The DXL engine, the web GUI and
// the import/export code all work through `Store`.
//
// Shape
// -----
// Items form one tree: folders and projects hold folders, projects and modules.
// A formal module holds a tree of objects. A link module owns links; a link joins
// two objects. A baseline is a frozen copy of a formal module, stored as a module
// of its own, so every read works on it and every write is refused.
//
// Handles
// -------
// Modules, folders and projects are identified by their item id (number). Objects
// are `Obj(module_id, absno)`; absolute numbers are never reused. Links are `Link`.
//
// The tables are Maps with indexes,
// and a transaction is an undo journal.

export class StoreError extends Error {
  // A request the database refuses. The message is meant for the user.
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }

  toString(): string {
    return this.message;
  }
}

// Attribute DXL that could not give a value. `shown` is what a view or an
// export puts in the value's place.
export class AttrDxlError extends StoreError {
  shown: string;
  constructor(message: string, shown: string) {
    super(message);
    this.shown = shown;
  }
}

export class Obj {
  readonly module_id: number;
  readonly absno: number;

  constructor(module_id: number, absno: number) {
    this.module_id = module_id;
    this.absno = absno;
  }

  get key(): string {
    return `${this.module_id}:${this.absno}`;
  }

  equals(other: unknown): boolean {
    return other instanceof Obj && other.module_id === this.module_id && other.absno === this.absno;
  }
}

export class Link {
  readonly id: number;
  readonly link_module: number;
  readonly source: Obj;
  readonly target: Obj;

  constructor(id: number, link_module: number, source: Obj, target: Obj) {
    this.id = id;
    this.link_module = link_module;
    this.source = source;
    this.target = target;
  }

  get key(): string {
    return `${this.id}:${this.link_module}:${this.source.key}:${this.target.key}`;
  }

  equals(other: unknown): boolean {
    return other instanceof Link && other.id === this.id && other.link_module === this.link_module
      && other.source.equals(this.source) && other.target.equals(this.target);
  }
}

// Field-by-field equality for the record classes .
function _same(a: any, b: any): boolean {
  if (!b || a.constructor !== b.constructor) return false;
  return Object.keys(a).every((k) => Array.isArray(a[k])
    ? a[k].length === b[k].length && a[k].every((v: unknown, i: number) => v === b[k][i])
    : a[k] === b[k]);
}

class _Record {
  get key(): string {
    return JSON.stringify(Object.values(this));
  }

  equals(other: unknown): boolean {
    return _same(this, other);
  }
}

export class Item extends _Record {
  readonly id: number;
  readonly parent: number | null;
  readonly name: string;
  readonly kind: string; // folder, project, formal, link
  readonly description: string;
  readonly deleted: boolean;

  constructor(id: number, parent: number | null, name: string, kind: string, description: string,
              deleted: boolean) {
    super();
    this.id = id;
    this.parent = parent;
    this.name = name;
    this.kind = kind;
    this.description = description;
    this.deleted = deleted;
  }
}

export class AttrType extends _Record {
  readonly module_id: number;
  readonly name: string;
  readonly base: string;
  readonly values: readonly string[]; // enumeration values, in order

  constructor(module_id: number, name: string, base: string, values: readonly string[]) {
    super();
    this.module_id = module_id;
    this.name = name;
    this.base = base;
    this.values = values;
  }
}

export class AttrDef extends _Record {
  readonly module_id: number;
  readonly name: string;
  readonly type_name: string;
  readonly base: string;
  readonly scope: string; // "object" or "module"
  readonly multi: boolean;
  readonly default: string;
  readonly values: readonly string[];
  readonly dxl: string; // attribute DXL that calculates the value, or ""

  constructor(module_id: number, name: string, type_name: string, base: string, scope: string,
              multi: boolean, default_: string, values: readonly string[], dxl: string = "") {
    super();
    this.module_id = module_id;
    this.name = name;
    this.type_name = type_name;
    this.base = base;
    this.scope = scope;
    this.multi = multi;
    this.default = default_;
    this.values = values;
    this.dxl = dxl;
  }
}

export class Baseline extends _Record {
  readonly module_id: number; // the module it is a baseline of
  readonly copy_id: number; // the frozen copy; read it like any module
  readonly major: number;
  readonly minor: number;
  readonly suffix: string;
  readonly annotation: string;
  readonly created_by: string;
  readonly created_on: string;

  constructor(module_id: number, copy_id: number, major: number, minor: number, suffix: string,
              annotation: string, created_by: string, created_on: string) {
    super();
    this.module_id = module_id;
    this.copy_id = copy_id;
    this.major = major;
    this.minor = minor;
    this.suffix = suffix;
    this.annotation = annotation;
    this.created_by = created_by;
    this.created_on = created_on;
  }

  get label(): string {
    return `${this.major}.${this.minor}` + (this.suffix ? ` (${this.suffix})` : "");
  }
}

export class History extends _Record {
  readonly seq: number;
  readonly when: string;
  readonly who: string;
  readonly module_id: number;
  readonly absno: number | null;
  readonly action: string;
  readonly attribute: string;
  readonly old: string;
  readonly new: string;
  readonly target_absno: number | null; // createLink, deleteLink
  readonly object_count: number | null; // moveObject: the object and all below it

  constructor(seq: number, when: string, who: string, module_id: number, absno: number | null,
              action: string, attribute: string, old: string, new_: string,
              target_absno: number | null = null, object_count: number | null = null) {
    super();
    this.seq = seq;
    this.when = when;
    this.who = who;
    this.module_id = module_id;
    this.absno = absno;
    this.action = action;
    this.attribute = attribute;
    this.old = old;
    this.new = new_;
    this.target_absno = target_absno;
    this.object_count = object_count;
  }
}

export const BASE_TYPES: readonly string[] = ["String", "Text", "Integer", "Real", "Date", "Enumeration"];
export const BOOLEAN_VALUES: readonly string[] = ["False", "True"]; // DOORS maps the first to false
export const STANDARD_ATTRIBUTES: readonly (readonly [string, string])[] = [
  ["Object Heading", "String"], ["Object Short Text", "String"], ["Object Text", "Text"]];
// Maintained by the database; readable like attributes, never written directly.
export const SYSTEM_ATTRIBUTES: readonly string[] = [
  "Absolute Number", "Created By", "Created On", "Created Thru", "Last Modified By", "Last Modified On"];

export const ROOT = 1;

// -- text behaviour, shared with io/ -------------------------------------------

export const _SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const _LEADING = new RegExp(`^[${_SPACE}]+`);
const _TRAILING = new RegExp(`(?<![${_SPACE}])[${_SPACE}]+$`);

// str.strip()
export function _strip(text: string): string {
  return text.replace(_LEADING, "").replace(_TRAILING, "");
}

// repr() of a str, number, bool, None, list or dict
export function _repr(value: any): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = "";
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      if (ch === quote || ch === "\\") out += "\\" + ch;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch !== " " && /[\p{C}\p{Z}]/u.test(ch)) {
        if (code < 0x100) out += "\\x" + code.toString(16).padStart(2, "0");
        else if (code < 0x10000) out += "\\u" + code.toString(16).padStart(4, "0");
        else out += "\\U" + code.toString(16).padStart(8, "0");
      } else out += ch;
    }
    return quote + out + quote;
  }
  if (Array.isArray(value)) return "[" + value.map(_repr).join(", ") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.entries(value).map(([k, v]) => `${_repr(k)}: ${_repr(v)}`).join(", ") + "}";
  }
  return String(value);
}

// string ordering by code point
export function _cmp(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x !== y) {
      if (x >= 0xd800) x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      if (y >= 0xd800) y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
      return x - y;
    }
  }
  return a.length - b.length;
}

// Unicode decimal digits to ASCII, so that int() can be reproduced
export function _ascii_digits(text: string): string {
  return text.replace(/\p{Nd}/gu, (ch) => {
    const code = ch.codePointAt(0)!;
    let start = code;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((code - start) % 10);
  });
}

// whether float(text) would succeed
export function _is_float(text: string): boolean {
  const d = "\\p{Nd}(?:_?\\p{Nd})*";
  return new RegExp(`^[+-]?(?:(?:${d}(?:\\.(?:${d})?)?|\\.${d})(?:[eE][+-]?${d})?|`
    + "[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aA][nN])$", "u").test(_strip(text));
}

const _MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
                 "september", "october", "november", "december"];
const _DIRECTIVES: Record<string, string> = {
  d: "(?<d>3[01]|[12][0-9]|0[1-9]|[1-9]| [1-9])",
  m: "(?<m>1[0-2]|0[1-9]|[1-9])",
  Y: "(?<Y>[0-9]{4})",
  y: "(?<y>[0-9]{2})",
  H: "(?<H>2[0-3]|[01][0-9]|[0-9]| [0-9])",
  M: "(?<M>[0-5][0-9]|[0-9])",
  S: "(?<S>6[01]|[0-5][0-9]|[0-9])",
  B: `(?<B>${[..._MONTHS].sort((a, b) => b.length - a.length).join("|")})`,
  b: `(?<b>${_MONTHS.map((m) => m.slice(0, 3)).join("|")})`,
};
const _layouts = new Map<string, RegExp>();

function _value_error(message: string): Error {
  const error = new Error(message);
  error.name = "ValueError";
  return error;
}

// datetime.strptime for the layouts used here. The Date holds the wall-clock
// time in its UTC fields.
function _strptime(text: string, layout: string): Date {
  if (typeof text !== "string") {
    throw new TypeError(`strptime() argument 1 must be str, not ${_type_name(text)}`);
  }
  let pattern = _layouts.get(layout);
  if (!pattern) {
    const source = layout.replace(/\s+/g, `[${_SPACE}]+`).replace(/%(.)/g, (_, c) => _DIRECTIVES[c]);
    pattern = new RegExp("^" + source, "i");
    _layouts.set(layout, pattern);
  }
  const found = pattern.exec(text);
  if (!found) throw _value_error(`time data ${_repr(text)} does not match format ${_repr(layout)}`);
  if (found[0].length !== text.length) {
    throw _value_error(`unconverted data remains: ${text.slice(found[0].length)}`);
  }
  const g = found.groups!;
  let year = 1900, month = 1;
  if (g.Y !== undefined) year = Number(g.Y);
  else if (g.y !== undefined) year = Number(g.y) + (Number(g.y) <= 68 ? 2000 : 1900);
  if (g.m !== undefined) month = Number(g.m);
  else if (g.B !== undefined) month = _MONTHS.indexOf(g.B.toLowerCase()) + 1;
  else if (g.b !== undefined) month = _MONTHS.findIndex((m) => m.startsWith(g.b.toLowerCase())) + 1;
  const day = Number(g.d ?? 1), hour = Number(g.H ?? 0), minute = Number(g.M ?? 0), second = Number(g.S ?? 0);
  if (year < 1) throw _value_error(`year must be in 1..9999, not ${year}`);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > days) throw _value_error(`day ${day} must be in range 1..${days} for month ${month} in year ${year}`);
  if (second > 59) throw _value_error(`second must be in 0..59, not ${second}`);
  const date = new Date(Date.UTC(2000, 0, 1, hour, minute, second));
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

// type(value).__name__ for JSON values
export function _type_name(value: any): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

export function now(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function _user(): string {
  const env = (globalThis as any).process?.env ?? {};
  return env.LOGNAME || env.USER || env.LNAME || env.USERNAME || "Administrator";
}

// -- table rows ----------------------------------------------------------------

type _ItemRow = {
  id: number; parent: number | null; name: string; kind: string; description: string; deleted: number;
  prefix: string; next_absno: number; baseline_of: number | null; major: number | null;
  minor: number | null; suffix: string | null; annotation: string | null;
  created_by: string; created_on: string; modified_by?: string; modified_on?: string;
};
type _TypeRow = { base: string; vals: string[] };
type _DefRow = { type_name: string; scope: string; multi: number; dflt: string; position: number; dxl?: string };
type _ObjectRow = {
  absno: number; parent: number | null; position: number; deleted: number; created_by: string;
  created_on: string; modified_by: string; modified_on: string; changed_seq: number;
};
type _LinkRow = {
  id: number; link_module: number; source_module: number; source_absno: number;
  target_module: number; target_absno: number; reviewed_seq: number;
  created_by: string; created_on: string;
  cleared?: boolean; // someone has cleared its suspicion
};
type _ModuleData = {
  types: Map<string, _TypeRow>;
  defs: Map<string, _DefRow>;
  module_values: Map<string, string>;
  objects: Map<number, _ObjectRow>;
  // children of each parent absno (null: top level), kept sorted by position, absno
  kids: Map<number | null, _ObjectRow[]>;
  values: Map<number, Map<string, string>>;
  views: Map<string, string>;
  history: History[];
  object_history: Map<number, History[]>;
};

function _empty_module(): _ModuleData {
  return { types: new Map(), defs: new Map(), module_values: new Map(), objects: new Map(), kids: new Map(),
           values: new Map(), views: new Map(), history: [], object_history: new Map() };
}

// where `row` is, or belongs, in a sibling list
function _slot(list: _ObjectRow[], row: _ObjectRow): number {
  let low = 0, high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const other = list[mid];
    if (other.position < row.position || (other.position === row.position && other.absno < row.absno)) low = mid + 1;
    else high = mid;
  }
  return low;
}

function _nocase(text: string): string {
  return text.replace(/[A-Z]+/g, (s) => s.toLowerCase());
}

// An in-memory database. The `path` is only remembered; use `dumps` and `loads`
// to keep it.
//
// Every public write is one transaction. Wrap several in `store.transaction(() => ...)`
// to make them one.
export class Store {
  // Runs attribute DXL. The DXL engine puts itself here when it is loaded.
  static dxl_engine: ((store: Store, obj: Obj, name: string, code: string) => string) | null = null;
  // What attribute DXL has calculated, by "module:absno:name". Like DOORS, a
  // value is kept until it is reset; unlike stored values it is never saved.
  _computed: Map<string, { value: string } | { error: string }>;
  _timeouts: Map<string, number>; // by "module:name": objects whose DXL ran too long
  db_path: string;
  user: string;
  total_changes: number;
  _depth: number;
  _clock: string | null;
  _journal: (() => void)[];
  _items: Map<number, _ItemRow>;
  _item_children: Map<number, Set<number>>; // by parent, baselines left out
  _names: Map<number, Map<string, number>>; // by parent then name, baselines left out
  _baselines: Map<number, Set<number>>; // copy ids by module
  _modules: Map<number, _ModuleData>;
  _links: Map<number, _LinkRow>;
  _outgoing: Map<string, Set<number>>; // link ids by source object
  _incoming: Map<string, Set<number>>; // link ids by target object
  _max_item: number;
  _max_link: number;
  _seq: number;
  _link_module_paths: Map<number, string> | null;

  constructor(path: string = ":memory:", user: string | null = null) {
    this.db_path = String(path);
    this.user = user || _user();
    this.total_changes = 0;
    this._depth = 0;
    this._clock = null;
    this._journal = [];
    this._items = new Map();
    this._item_children = new Map();
    this._names = new Map();
    this._baselines = new Map();
    this._modules = new Map();
    this._links = new Map();
    this._outgoing = new Map();
    this._incoming = new Map();
    this._max_item = 0;
    this._max_link = 0;
    this._seq = 0;
    this._link_module_paths = null;
    this._computed = new Map();
    this._timeouts = new Map();
    this._insert_item({
      id: ROOT, parent: null, name: "", kind: "folder", description: "", deleted: 0, prefix: "", next_absno: 1,
      baseline_of: null, major: null, minor: null, suffix: null, annotation: null,
      created_by: this.user, created_on: this.now(),
    });
  }

  now(): string {
    return this._clock || now();
  }

  // Record the writes inside as made at `stamp` ("YYYY-MM-DD HH:MM:SS"); null: now.
  dated<T>(stamp: string | null, work: () => T): T {
    if (stamp !== null && stamp !== undefined) _strptime(stamp, "%Y-%m-%d %H:%M:%S");
    const before = this._clock;
    this._clock = stamp ?? null;
    try {
      return work();
    } finally {
      this._clock = before;
    }
  }

  close(): void {}

  // All writes inside happen together or not at all. `work` must be synchronous.
  transaction<T>(work: (store: Store) => T): T {
    const mark = this._journal.length;
    this._depth += 1;
    try {
      return work(this);
    } catch (error) {
      while (this._journal.length > mark) this._journal.pop()!();
      this._link_module_paths = null;
      throw error;
    } finally {
      this._depth -= 1;
      if (this._depth === 0) this._journal.length = 0;
    }
  }

  // -- journalled writes ---------------------------------------------------

  _undo(step: () => void): void {
    if (this._depth) this._journal.push(step);
  }

  _put<K, V>(map: Map<K, V>, key: K, value: V): void {
    const had = map.has(key), old = map.get(key);
    map.set(key, value);
    this._undo(() => { if (had) map.set(key, old as V); else map.delete(key); });
  }

  _drop<K, V>(map: Map<K, V>, key: K): boolean {
    if (!map.has(key)) return false;
    const old = map.get(key) as V;
    map.delete(key);
    this._undo(() => { map.set(key, old); });
    return true;
  }

  _assign<R, F extends keyof R>(row: R, field: F, value: R[F]): void {
    const old = row[field];
    row[field] = value;
    this._undo(() => { row[field] = old; });
  }

  _add<K>(index: Map<K, Set<number>>, key: K, id: number): void {
    let set = index.get(key);
    if (!set) index.set(key, set = new Set());
    set.add(id);
    this._undo(() => { set.delete(id); });
  }

  _remove<K>(index: Map<K, Set<number>>, key: K, id: number): void {
    const set = index.get(key);
    if (set && set.delete(id)) this._undo(() => { set.add(id); });
  }

  _push<V>(list: V[], value: V): void {
    list.push(value);
    this._undo(() => { list.pop(); });
  }

  _attach(data: _ModuleData, row: _ObjectRow): void {
    let list = data.kids.get(row.parent);
    if (!list) data.kids.set(row.parent, list = []);
    const at = _slot(list, row);
    list.splice(at, 0, row);
    this._undo(() => { list.splice(at, 1); });
  }

  _detach(data: _ModuleData, row: _ObjectRow): void {
    const list = data.kids.get(row.parent)!;
    const at = list.indexOf(row);
    list.splice(at, 1);
    this._undo(() => { list.splice(at, 0, row); });
  }

  _data(module_id: number): _ModuleData {
    let data = this._modules.get(module_id);
    if (!data) {
      if (!this._items.has(module_id)) throw new Error("FOREIGN KEY constraint failed");
      this._put(this._modules, module_id, data = _empty_module());
    }
    return data;
  }

  _insert_item(row: _ItemRow): number {
    const old = this._max_item;
    this._max_item = Math.max(old, row.id);
    this._undo(() => { this._max_item = old; });
    this._put(this._items, row.id, row);
    if (row.baseline_of !== null) this._add(this._baselines, row.baseline_of, row.id);
    else if (row.parent !== null) {
      this._add(this._item_children, row.parent, row.id);
      let names = this._names.get(row.parent);
      if (!names) this._names.set(row.parent, names = new Map());
      this._put(names, row.name, row.id);
    }
    this._link_module_paths = null;
    this.total_changes += 1;
    return row.id;
  }

  _update_item<F extends keyof _ItemRow>(item_id: number, field: F, value: _ItemRow[F]): void {
    const row = this._items.get(item_id);
    if (!row) return;
    if (field === "name" && row.parent !== null && row.baseline_of === null) {
      const names = this._names.get(row.parent)!;
      this._drop(names, row.name);
      this._put(names, value as string, item_id);
    }
    this._assign(row, field, value);
    this._link_module_paths = null;
    this.total_changes += 1;
  }

  _record(module_id: number, absno: number | null, action: string, attribute: string = "",
          old: string = "", new_: string = "", target_absno: number | null = null,
          object_count: number | null = null): number {
    const data = this._data(module_id);
    const before = this._seq;
    const seq = this._seq = before + 1;
    this._undo(() => { this._seq = before; });
    const entry = new History(seq, this.now(), this.user, module_id, absno, action, attribute, old, new_,
                              target_absno, object_count);
    this._push(data.history, entry);
    this._stamp(module_id);
    if (absno !== null) {
      let list = data.object_history.get(absno);
      if (!list) data.object_history.set(absno, list = []);
      this._push(list, entry);
    }
    this.total_changes += 1;
    return seq;
  }

  _stamp(item_id: number): void {
    const row = this._items.get(item_id);
    if (!row) return;
    this._assign(row, "modified_by", this.user);
    this._assign(row, "modified_on", this.now());
  }

  // [who, when] last changed a formal module or anything in it.
  module_modified(module_id: number): [string, string] {
    const row = this._items.get(module_id);
    if (!row) throw new StoreError(`no item with id ${module_id}`);
    return [row.modified_by ?? row.created_by, row.modified_on ?? row.created_on];
  }

  // =====================================================================
  // Items: folders, projects, modules
  // =====================================================================

  has_item(item_id: number): boolean {
    return this._items.has(item_id);
  }

  item(item_id: number): Item {
    const row = this._items.get(item_id);
    if (!row) throw new StoreError(`no item with id ${item_id ?? "None"}`);
    return new Item(row.id, row.parent, row.name, row.kind, row.description, Boolean(row.deleted));
  }

  // The item id at `path`, or null. Paths starting with "/" are from the root.
  find(path: string, parent: number = ROOT): number | null {
    let current: number = path.startsWith("/") ? ROOT : parent;
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        current = this._items.get(current)?.parent || ROOT;
        continue;
      }
      const found = this._names.get(current)?.get(part);
      if (found === undefined || this._items.get(found)!.deleted) return null;
      current = found;
    }
    return current;
  }

  module_at(path: string, kind: string = "formal", parent: number = ROOT): number | null {
    const found = this.find(path, parent);
    if (found === null || this.item(found).kind !== kind) return null;
    return found;
  }

  path(item_id: number): string {
    const parts: string[] = [];
    const start = this._items.get(item_id);
    let current: number | null = start ? start.baseline_of ?? start.id : null;
    while (current && current !== ROOT) {
      const row: _ItemRow = this._items.get(current)!;
      parts.push(row.name);
      current = row.parent;
    }
    return "/" + parts.reverse().join("/");
  }

  children(item_id: number, include_deleted: boolean = false): Item[] {
    const rows: _ItemRow[] = [];
    for (const id of this._item_children.get(item_id) ?? []) {
      const row = this._items.get(id)!;
      if (include_deleted || !row.deleted) rows.push(row);
    }
    rows.sort((a, b) => _cmp(_nocase(a.name), _nocase(b.name)) || _cmp(a.name, b.name));
    return rows.map((row) => this.item(row.id));
  }

  // Every live item below `item_id`, depth first.
  *walk(item_id: number = ROOT): Generator<Item> {
    for (const child of this.children(item_id)) {
      yield child;
      yield* this.walk(child.id);
    }
  }

  _create_item(parent_path: string, name: string, kind: string, description: string, prefix: string = ""): number {
    const parent = this.find(parent_path || "/");
    if (parent === null) throw new StoreError(`no folder ${_repr(parent_path)}`);
    if (!["folder", "project"].includes(this.item(parent).kind)) {
      throw new StoreError(`${parent_path} is not a folder or project`);
    }
    if (!name || name.includes("/") || name === "." || name === "..") {
      throw new StoreError(`not a usable name: ${_repr(name)}`);
    }
    if (this._names.get(parent)?.has(name)) {
      throw new StoreError(`${parent_path.replace(/\/+$/, "")}/${name} already exists (it may be deleted)`);
    }
    return this._insert_item({
      id: this._max_item + 1, parent, name, kind, description, deleted: 0, prefix, next_absno: 1,
      baseline_of: null, major: null, minor: null, suffix: null, annotation: null,
      created_by: this.user, created_on: this.now(),
    });
  }

  create_folder(parent_path: string, name: string, description: string = "", project: boolean = false): number {
    return this.transaction(() =>
      this._create_item(parent_path, name, project ? "project" : "folder", description));
  }

  create_project(parent_path: string, name: string, description: string = ""): number {
    return this.create_folder(parent_path, name, description, true);
  }

  // A formal module with the standard types and attributes.
  create_module(parent_path: string, name: string, description: string = "", prefix: string = ""): number {
    return this.transaction(() => {
      const module = this._create_item(parent_path, name, "formal", description, prefix);
      for (const base of BASE_TYPES.slice(0, 5)) this._insert_type(module, base, base, []);
      this._insert_type(module, "Boolean", "Enumeration", BOOLEAN_VALUES);
      for (const [attr, type_name] of STANDARD_ATTRIBUTES) this._insert_attr(module, attr, type_name);
      return module;
    });
  }

  create_link_module(parent_path: string, name: string, description: string = ""): number {
    return this.transaction(() => this._create_item(parent_path, name, "link", description));
  }

  set_item(item_id: number, name: string | null = null, description: string | null = null,
           prefix: string | null = null): void {
    this.transaction(() => {
      const item = this.item(item_id);
      this._writable(item_id);
      if (name !== null && name !== item.name) {
        if (!name || name.includes("/")) throw new StoreError(`not a usable name: ${_repr(name)}`);
        if (item.parent !== null && this._names.get(item.parent)?.has(name)) {
          throw new StoreError(`${name} already exists here`);
        }
        this._update_item(item_id, "name", name);
      }
      if (description !== null) this._update_item(item_id, "description", description);
      if (prefix !== null) this._update_item(item_id, "prefix", prefix);
      this._stamp(item_id);
    });
  }

  // Soft delete (or undelete) a folder, project or module with its contents.
  delete_item(item_id: number, deleted: boolean = true): void {
    if (item_id === ROOT) throw new StoreError("the database root cannot be deleted");
    this.transaction(() => this._update_item(item_id, "deleted", Number(deleted)));
  }

  prefix(module_id: number): string {
    return (this._items.get(module_id)?.prefix ?? null) as string;
  }

  _writable(module_id: number): void {
    if (this.is_baseline(module_id)) throw new StoreError("a baseline cannot be changed");
  }

  is_baseline(module_id: number): boolean {
    return (this._items.get(module_id)?.baseline_of ?? null) !== null;
  }

  // [created by, created on] for any item.
  item_info(item_id: number): [string, string] | null {
    const row = this._items.get(item_id);
    return row ? [row.created_by, row.created_on] : null;
  }

  // =====================================================================
  // Attribute types and definitions
  // =====================================================================

  _insert_type(module_id: number, name: string, base: string, values: readonly string[]): void {
    this._put(this._data(module_id).types, name, { base, vals: [...values] });
    this.total_changes += 1;
  }

  _insert_attr(module_id: number, name: string, type_name: string, scope: string = "object",
               multi: boolean = false, default_: string = "", dxl: string = ""): void {
    const data = this._data(module_id);
    let position = 0;
    for (const def of data.defs.values()) position = Math.max(position, def.position);
    this._put(data.defs, name, { type_name, scope, multi: Number(multi), dflt: default_, position: position + 1,
                                 ...(dxl ? { dxl } : {}) });
    this.total_changes += 1;
  }

  types(module_id: number): AttrType[] {
    const out: AttrType[] = [];
    for (const [name, row] of this._modules.get(module_id)?.types ?? []) {
      out.push(new AttrType(module_id, name, row.base, [...row.vals]));
    }
    return out;
  }

  create_type(module_id: number, name: string, base: string, values: readonly string[] = []): void {
    this.transaction(() => {
      this._writable(module_id);
      if (!BASE_TYPES.includes(base)) throw new StoreError(`unknown base type ${_repr(base)}`);
      if ((base === "Enumeration") !== (values.length > 0)) {
        throw new StoreError("an enumeration type needs values, and no other type takes them");
      }
      if (new Set(values).size !== values.length) throw new StoreError("enumeration values must be unique");
      if (this._modules.get(module_id)?.types.has(name)) {
        throw new StoreError(`type ${_repr(name)} already exists`);
      }
      this._insert_type(module_id, name, base, values);
      this._stamp(module_id);
    });
  }

  _definition(module_id: number, name: string, def: _DefRow): AttrDef {
    const type = this._modules.get(module_id)!.types.get(def.type_name)!;
    return new AttrDef(module_id, name, def.type_name, type.base, def.scope, Boolean(def.multi), def.dflt,
                       [...type.vals], def.dxl ?? "");
  }

  // Attribute definitions in creation order; scope null means both.
  attributes(module_id: number, scope: string | null = "object"): AttrDef[] {
    const defs = this._modules.get(module_id)?.defs;
    if (!defs) return [];
    return [...defs]
      .filter(([, d]) => scope === null || scope === d.scope)
      .sort((a, b) => a[1].position - b[1].position)
      .map(([name, d]) => this._definition(module_id, name, d));
  }

  attribute(module_id: number, name: string): AttrDef | null {
    const def = this._modules.get(module_id)?.defs.get(name);
    return def ? this._definition(module_id, name, def) : null;
  }

  has_attribute(module_id: number, name: string): boolean {
    return SYSTEM_ATTRIBUTES.includes(name) || this.attribute(module_id, name) !== null;
  }

  create_attribute(module_id: number, name: string, type_name: string = "String", scope: string = "object",
                   multi: boolean = false, default_: string = "", dxl: string = ""): void {
    this.transaction(() => {
      this._writable(module_id);
      if (!name || SYSTEM_ATTRIBUTES.includes(name)) {
        throw new StoreError(`not a usable attribute name: ${_repr(name)}`);
      }
      if (this.attribute(module_id, name)) throw new StoreError(`attribute ${_repr(name)} already exists`);
      const type = this._modules.get(module_id)?.types.get(type_name);
      if (!type) throw new StoreError(`no attribute type ${_repr(type_name)} in this module`);
      if (multi && type.base !== "Enumeration") {
        throw new StoreError("only an enumeration attribute can be multi-valued");
      }
      if (scope !== "object" && scope !== "module") {
        throw new Error("CHECK constraint failed: scope IN ('object','module')");
      }
      // how DOORS combines attribute DXL with these is not verified
      if (dxl && (scope !== "object" || multi || default_)) {
        throw new StoreError(`${name}: attribute DXL is only supported here on a single-valued object attribute `
          + "without a default");
      }
      this._insert_attr(module_id, name, type_name, scope, multi, "", dxl);
      if (default_) {
        default_ = Store.check_value(this.attribute(module_id, name)!, default_);
        this._assign(this._modules.get(module_id)!.defs.get(name)!, "dflt", default_);
        this.total_changes += 1;
      }
      this._record(module_id, null, "createAttr", name);
    });
  }

  delete_attribute(module_id: number, name: string): void {
    this.transaction(() => {
      this._writable(module_id);
      if (STANDARD_ATTRIBUTES.some(([n]) => n === name)) {
        throw new StoreError(`${_repr(name)} is a standard attribute`);
      }
      if (!this.attribute(module_id, name)) throw new StoreError(`no attribute ${_repr(name)}`);
      const data = this._modules.get(module_id)!;
      this._drop(data.defs, name);
      this._drop(data.module_values, name);
      for (const held of data.values.values()) this._drop(held, name);
      this.forget_computed(module_id, name);
      this.total_changes += 1;
      this._record(module_id, null, "deleteAttr", name);
    });
  }

  // The canonical text for `value`, or StoreError.
  static check_value(definition: AttrDef, value: string): string {
    const base = definition.base, name = definition.name;
    if (value === "") return "";
    if (base === "Integer") {
      if (!new RegExp(`^[${_SPACE}]*-?\\p{Nd}+[${_SPACE}]*$`, "u").test(value)) {
        throw new StoreError(`${name}: ${_repr(value)} is not an integer`);
      }
      return String(BigInt(_ascii_digits(_strip(value))));
    }
    if (base === "Real") {
      if (!_is_float(value)) throw new StoreError(`${name}: ${_repr(value)} is not a number`);
    } else if (base === "Date") {
      if (parse_date(value) === null) {
        throw new StoreError(`${name}: ${_repr(value)} is not a date (use YYYY-MM-DD)`);
      }
      return _strip(value);
    } else if (base === "Enumeration") {
      const chosen = definition.multi ? value.split("\n") : [value];
      for (const each of chosen) {
        if (!definition.values.includes(each)) {
          throw new StoreError(`${name}: ${_repr(each)} is not one of ${definition.values.join(", ")}`);
        }
      }
    }
    return value;
  }

  // -- module attribute values -------------------------------------------

  module_value(module_id: number, name: string): string {
    if (name === "Name") return this.item(module_id).name;
    if (name === "Description") return this.item(module_id).description;
    if (name === "Prefix") return this.prefix(module_id);
    const definition = this.attribute(module_id, name);
    if (definition === null || definition.scope !== "module") {
      throw new StoreError(`unknown module attribute ${_repr(name)}`);
    }
    return this._modules.get(module_id)!.module_values.get(name) ?? definition.default;
  }

  set_module_value(module_id: number, name: string, value: string): void {
    if (name === "Description") return this.set_item(module_id, null, value);
    if (name === "Prefix") return this.set_item(module_id, null, null, value);
    this.transaction(() => {
      this._writable(module_id);
      const definition = this.attribute(module_id, name);
      if (definition === null || definition.scope !== "module") {
        throw new StoreError(`unknown module attribute ${_repr(name)}`);
      }
      value = Store.check_value(definition, value);
      this._put(this._modules.get(module_id)!.module_values, name, value);
      this._stamp(module_id);
      this.total_changes += 1;
    });
  }

  // =====================================================================
  // Objects
  // =====================================================================

  object(module_id: number, absno: number): Obj | null {
    return this._modules.get(module_id)?.objects.has(absno) ? new Obj(module_id, absno) : null;
  }

  _object_row(obj: Obj): _ObjectRow {
    const row = this._modules.get(obj.module_id)?.objects.get(obj.absno);
    if (!row) throw new StoreError("that object no longer exists");
    return row;
  }

  // Children of absolute number `parent` (null: top level), deleted ones included.
  child_objects(module_id: number, parent: number | null = null): Obj[] {
    const list = this._modules.get(module_id)?.kids.get(parent) ?? [];
    return list.map((row) => new Obj(module_id, row.absno));
  }

  // Depth first, the order DOORS shows them. Deleted objects are skipped
  // unless asked for.
  objects(module_id: number, include_deleted: boolean = false, parent: number | null = null): Obj[] {
    const kids = this._modules.get(module_id)?.kids;
    const out: Obj[] = [];
    if (!kids) return out;
    const stack: _ObjectRow[] = [];
    const push = (list: _ObjectRow[] | undefined) => {
      if (list) for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]);
    };
    push(kids.get(parent));
    while (stack.length) {
      const row = stack.pop()!;
      if (include_deleted || !row.deleted) out.push(new Obj(module_id, row.absno));
      push(kids.get(row.absno));
    }
    return out;
  }

  parent_object(obj: Obj): Obj | null {
    const up = this._object_row(obj).parent;
    return up === null ? null : new Obj(obj.module_id, up);
  }

  level(obj: Obj): number {
    let depth = 1, up = this.parent_object(obj);
    while (up) {
      depth += 1;
      up = this.parent_object(up);
    }
    return depth;
  }

  is_deleted(obj: Obj): boolean {
    return Boolean(this._object_row(obj).deleted);
  }

  identifier(obj: Obj): string {
    return `${this.prefix(obj.module_id) ?? "None"}${obj.absno}`;
  }

  by_identifier(module_id: number, text: string): Obj | null {
    const prefix = this.prefix(module_id);
    const digits = text.startsWith(prefix) ? text.slice(prefix.length) : text;
    return /^\p{Nd}+$/u.test(digits) ? this.object(module_id, Number(_ascii_digits(digits))) : null;
  }

  // Map absno -> outline number. Headings are numbered 1, 1.1; other objects
  // under them 1.1.0-1, as DOORS writes them.
  numbers(module_id: number): Map<number, string> {
    const data = this._modules.get(module_id);
    const out = new Map<number, string>();
    if (!data) return out;
    const visit = (parent: number | null, base: string) => {
      let section = 0, text = 0;
      for (const child of data.kids.get(parent) ?? []) {
        if (child.deleted) continue;
        let number: string;
        if ((data.values.get(child.absno)?.get("Object Heading") ?? "") !== "") {
          section += 1;
          number = base ? `${base}.${section}` : String(section);
        } else {
          text += 1;
          number = `${base || "0"}.0-${text}`;
        }
        out.set(child.absno, number);
        visit(child.absno, number);
      }
    };
    visit(null, "");
    return out;
  }

  // New object as the last child of `parent` (an Obj), or beside `after` /
  // `before`. Returns its Obj.
  create_object(module_id: number, parent: Obj | null = null, after: Obj | null = null, before: Obj | null = null,
                values: Map<string, string> | Record<string, string> | null = null): Obj {
    return this.transaction(() => {
      this._writable(module_id);
      if (this.item(module_id).kind !== "formal") throw new StoreError("objects live in formal modules");
      const [up, position] = this._place(module_id, parent, after, before);
      const absno = this._items.get(module_id)!.next_absno;
      this._update_item(module_id, "next_absno", absno + 1);
      const stamp = this.now();
      const data = this._data(module_id);
      const row: _ObjectRow = {
        absno, parent: up, position, deleted: 0, created_by: this.user, created_on: stamp,
        modified_by: this.user, modified_on: stamp, changed_seq: 0,
      };
      this._put(data.objects, absno, row);
      this._attach(data, row);
      this.total_changes += 1;
      const obj = new Obj(module_id, absno);
      this._record(module_id, absno, "createObject");
      const wanted = new Map<string, string>();
      for (const a of this.attributes(module_id)) if (a.default) wanted.set(a.name, a.default);
      if (values) {
        for (const [name, value] of values instanceof Map ? values : Object.entries(values)) wanted.set(name, value);
      }
      for (const [name, value] of wanted) this.set_value(obj, name, value);
      return obj;
    });
  }

  // [parent absno, position], making room among the siblings.
  _place(module_id: number, parent: Obj | null, after: Obj | null, before: Obj | null): [number | null, number] {
    const anchor = after || before;
    for (const other of [parent, anchor]) {
      if (other !== null && other.module_id !== module_id) throw new StoreError("that object is in another module");
    }
    if (anchor !== null) {
      const row = this._object_row(anchor);
      const up = row.parent;
      const position = row.position + (after ? 1 : 0);
      const list = this._modules.get(module_id)!.kids.get(up)!;
      // shifting every sibling from `position` on keeps the list sorted
      for (const sibling of list) {
        if (sibling.position >= position) {
          this._assign(sibling, "position", sibling.position + 1);
          this.total_changes += 1;
        }
      }
      return [up, position];
    }
    const up = parent ? parent.absno : null;
    if (parent) this._object_row(parent);
    const list = this._modules.get(module_id)?.kids.get(up);
    const position = list && list.length ? list[list.length - 1].position + 1 : 0;
    return [up, position];
  }

  move_object(obj: Obj, parent: Obj | null = null, after: Obj | null = null, before: Obj | null = null): void {
    this.transaction(() => {
      this._writable(obj.module_id);
      const anchor = after || before;
      let target = anchor ? this.parent_object(anchor) : parent;
      if (anchor && anchor.equals(obj)) throw new StoreError("an object cannot be moved relative to itself");
      while (target) {
        if (target.equals(obj)) throw new StoreError("an object cannot be moved inside itself");
        target = this.parent_object(target);
      }
      const [up, position] = this._place(obj.module_id, parent, after, before);
      const data = this._modules.get(obj.module_id);
      const row = data?.objects.get(obj.absno);
      if (data && row) {
        this._detach(data, row);
        this._assign(row, "parent", up);
        this._assign(row, "position", position);
        this._attach(data, row);
        this.total_changes += 1;
      }
      let count = 0;
      const below = [obj.absno];
      const kids = this._modules.get(obj.module_id)!.kids;
      for (let at; (at = below.pop()) !== undefined; count++) {
        for (const child of kids.get(at) ?? []) below.push(child.absno);
      }
      this._record(obj.module_id, obj.absno, "moveObject", "", "", "", null, count);
    });
  }

  _set_deleted(obj: Obj, deleted: number): void {
    const row = this._modules.get(obj.module_id)?.objects.get(obj.absno);
    if (row) {
      this._assign(row, "deleted", deleted);
      this.total_changes += 1;
    }
  }

  // Soft delete. Refused while the object has undeleted children, as in DOORS.
  delete_object(obj: Obj): void {
    this.transaction(() => {
      this._writable(obj.module_id);
      const kids = this._modules.get(obj.module_id)?.kids.get(obj.absno) ?? [];
      if (kids.some((c) => !c.deleted)) {
        throw new StoreError(`${this.identifier(obj)} has children; delete them first`);
      }
      this._set_deleted(obj, 1);
      this._touch(obj, "deleteObject");
    });
  }

  undelete_object(obj: Obj): void {
    this.transaction(() => {
      this._writable(obj.module_id);
      const up = this.parent_object(obj);
      if (up && this.is_deleted(up)) throw new StoreError("undelete its parent first");
      this._set_deleted(obj, 0);
      this._touch(obj, "unDeleteObject");
    });
  }

  // Remove soft-deleted objects for good, with their links.
  purge(module_id: number): number {
    return this.transaction(() => {
      this._writable(module_id);
      const data = this._modules.get(module_id);
      const gone = this.objects(module_id, true).filter((o) => this.is_deleted(o));
      for (let i = gone.length - 1; i >= 0; i--) {
        const obj = gone[i];
        if (data!.kids.get(obj.absno)?.length) {
          throw new StoreError(`${this.identifier(obj)} still has children`);
        }
        for (const index of [this._outgoing, this._incoming]) {
          for (const id of [...index.get(obj.key) ?? []]) this._delete_link_row(id);
        }
        const row = data!.objects.get(obj.absno)!;
        this._detach(data!, row);
        this._drop(data!.objects, obj.absno);
        this._drop(data!.values, obj.absno);
        this.total_changes += 1;
        this._record(module_id, obj.absno, "purgeObject");
      }
      return gone.length;
    });
  }

  // Count an object as changed since earlier links without inventing history:
  // for loading a file that says a link is suspect but not what was edited.
  mark_changed(obj: Obj): void {
    this.transaction(() => {
      const row = this._modules.get(obj.module_id)?.objects.get(obj.absno);
      if (!row) return;
      const before = this._seq;
      this._seq = before + 1;
      this._undo(() => { this._seq = before; });
      this._assign(row, "changed_seq", this._seq);
      this.total_changes += 1;
    });
  }

  _touch(obj: Obj, action: string, attribute: string = "", old: string = "", new_: string = ""): void {
    const seq = this._record(obj.module_id, obj.absno, action, attribute, old, new_);
    const row = this._modules.get(obj.module_id)?.objects.get(obj.absno);
    if (!row) return;
    this._assign(row, "modified_by", this.user);
    this._assign(row, "modified_on", this.now());
    this._assign(row, "changed_seq", seq);
    this.total_changes += 1;
  }

  // The attribute's text ("" when unset). Multi-valued: newline separated.
  value(obj: Obj, name: string): string {
    if (name === "Absolute Number") return String(obj.absno);
    if (name === "Created By") return this._object_row(obj).created_by;
    if (name === "Created On") return this._object_row(obj).created_on;
    if (name === "Created Thru") return "Manual Input"; // nothing here copies or extracts objects
    if (name === "Last Modified By") return this._object_row(obj).modified_by;
    if (name === "Last Modified On") return this._object_row(obj).modified_on;
    const value = this._modules.get(obj.module_id)?.values.get(obj.absno)?.get(name);
    if (value !== undefined) return value;
    const definition = this._modules.get(obj.module_id)?.defs.get(name);
    if (!definition || definition.scope !== "object") {
      throw new StoreError(`unknown attribute ${_repr(name)} in ${this.path(obj.module_id)}`);
    }
    if (definition.dxl) {
      this._object_row(obj);
      if (!Store.dxl_engine) throw new AttrDxlError(`${_repr(name)} needs the DXL engine`, "#DXL error: no engine");
      return Store.dxl_engine(this, obj, name, definition.dxl);
    }
    return "";
  }

  // value(), except that failing attribute DXL gives its error as the text.
  shown_value(obj: Obj, name: string): string {
    try {
      return this.value(obj, name);
    } catch (error) {
      if (!(error instanceof AttrDxlError)) throw error;
      return error.shown;
    }
  }

  // Forget one calculated value, so that the next read calculates it again.
  reset_computed(obj: Obj, name: string): void {
    this._drop(this._computed, `${obj.key}:${name}`);
    this._timeouts.delete(`${obj.module_id}:${name}`);
  }

  // The same for a whole module, or one of its attributes.
  forget_computed(module_id: number, name: string | null = null): void {
    for (const key of [...this._computed.keys()]) {
      const [module, , ...rest] = key.split(":");
      if (module === String(module_id) && (name === null || rest.join(":") === name)) this._drop(this._computed, key);
    }
    for (const key of [...this._timeouts.keys()]) {
      if (name === null ? key.startsWith(`${module_id}:`) : key === `${module_id}:${name}`) this._timeouts.delete(key);
    }
  }

  // Map absno -> Map name -> value, for a whole module in one go. These are the
  // stored values: attributes calculated by DXL are not among them.
  values(module_id: number): Map<number, Map<string, string>> {
    const out = new Map<number, Map<string, string>>();
    const held = this._modules.get(module_id)?.values;
    if (!held) return out;
    for (const absno of [...held.keys()].sort((a, b) => a - b)) {
      const mine = held.get(absno)!;
      if (mine.size) out.set(absno, new Map([...mine].sort((a, b) => _cmp(a[0], b[0]))));
    }
    return out;
  }

  set_value(obj: Obj, name: string, value: string): void {
    this.transaction(() => {
      this._writable(obj.module_id);
      if (SYSTEM_ATTRIBUTES.includes(name)) throw new StoreError(`${_repr(name)} is set by the database`);
      const definition = this.attribute(obj.module_id, name);
      if (definition === null || definition.scope !== "object") {
        throw new StoreError(`unknown attribute ${_repr(name)} in ${this.path(obj.module_id)}`);
      }
      if (definition.dxl) {
        throw new StoreError(`${_repr(name)} is calculated by attribute DXL and cannot be given a value here `
          + "(in DXL, assign (string null) to have it calculated again)");
      }
      value = Store.check_value(definition, value);
      this._object_row(obj);
      const old = this.value(obj, name);
      if (old === value) return;
      const data = this._modules.get(obj.module_id)!;
      let held = data.values.get(obj.absno);
      if (!held) this._put(data.values, obj.absno, held = new Map());
      this._put(held, name, value);
      this.total_changes += 1;
      this._touch(obj, "modifyObject", name, old, value);
    });
  }

  // =====================================================================
  // Links
  // =====================================================================

  // Ids of link modules matching "*", a full path, or an unqualified name.
  link_modules(name: string = "*", near: number | null = null): Set<number> {
    if (!this._link_module_paths) {
      this._link_module_paths = new Map();
      for (const i of this.walk()) if (i.kind === "link") this._link_module_paths.set(i.id, this.path(i.id));
    }
    const out = new Set<number>();
    for (const [id, path] of this._link_module_paths) {
      if (name === "*" || path === name || path.slice(path.lastIndexOf("/") + 1) === name) out.add(id);
    }
    return out;
  }

  // The project's "satisfies" link module, created if missing, beside
  // the source module.
  default_link_module(source_module: number): number {
    const parent = this.item(source_module).parent!;
    const found = this.find("DOORS Links", parent);
    if (found) return found;
    return this.create_link_module(this.path(parent), "DOORS Links", "Default link module");
  }

  _insert_link(row: _LinkRow): void {
    const old = this._max_link;
    this._max_link = Math.max(old, row.id);
    this._undo(() => { this._max_link = old; });
    this._put(this._links, row.id, row);
    this._add(this._outgoing, `${row.source_module}:${row.source_absno}`, row.id);
    this._add(this._incoming, `${row.target_module}:${row.target_absno}`, row.id);
    this.total_changes += 1;
  }

  _delete_link_row(id: number): void {
    const row = this._links.get(id);
    if (!row) return;
    this._remove(this._outgoing, `${row.source_module}:${row.source_absno}`, id);
    this._remove(this._incoming, `${row.target_module}:${row.target_absno}`, id);
    this._drop(this._links, id);
    const old = this._max_link;
    while (this._max_link > 0 && !this._links.has(this._max_link)) this._max_link -= 1;
    this._undo(() => { this._max_link = old; });
    this.total_changes += 1;
  }

  // Link two objects. `link_module` is a path; it is created if missing.
  create_link(source: Obj, target: Obj, link_module: string | null = null): Link {
    return this.transaction(() => {
      this._writable(source.module_id);
      this._writable(target.module_id);
      for (const end of [source, target]) {
        if (this.is_deleted(end)) throw new StoreError(`${this.identifier(end)} is deleted`);
      }
      if (source.equals(target)) throw new StoreError("an object cannot link to itself");
      let module: number;
      if (link_module === null) {
        module = this.default_link_module(source.module_id);
      } else if (link_module.startsWith("/")) {
        const found = this.module_at(link_module, "link");
        if (found === null) {
          const slash = link_module.lastIndexOf("/");
          module = this.create_link_module(link_module.slice(0, slash) || "/", link_module.slice(slash + 1));
        } else module = found;
      } else {
        const matches = this.link_modules(link_module);
        if (matches.size > 1) {
          throw new StoreError(`several link modules are named ${_repr(link_module)}; give a full path`);
        }
        module = matches.size ? [...matches][0] : this.create_link_module(
          this.path(this.item(source.module_id).parent!), link_module);
      }
      for (const id of this._outgoing.get(source.key) ?? []) {
        const row = this._links.get(id)!;
        if (row.link_module === module && row.target_module === target.module_id
            && row.target_absno === target.absno) {
          return new Link(id, module, source, target);
        }
      }
      const seq = this._record(source.module_id, source.absno, "createLink", "", "", this.identifier(target),
                               target.absno);
      const link_id = this._max_link + 1;
      this._insert_link({
        id: link_id, link_module: module, source_module: source.module_id, source_absno: source.absno,
        target_module: target.module_id, target_absno: target.absno, reviewed_seq: seq,
        created_by: this.user, created_on: this.now(),
      });
      return new Link(link_id, module, source, target);
    });
  }

  delete_link(link: Link): void {
    this.transaction(() => {
      this._writable(link.source.module_id);
      this._delete_link_row(link.id);
      this._record(link.source.module_id, link.source.absno, "deleteLink", "", this.identifier(link.target), "",
                   link.target.absno);
    });
  }

  // Links leaving (outgoing) or arriving at `obj`. Links from baselines
  // are left out of incoming links unless asked for.
  links(obj: Obj, outgoing: boolean = true, link_module: string = "*", baselines: boolean = false): Link[] {
    const wanted = this.link_modules(link_module);
    const ids = (outgoing ? this._outgoing : this._incoming).get(obj.key);
    if (!ids || !ids.size) return [];
    const rows: _LinkRow[] = [];
    for (const id of ids) {
      const row = this._links.get(id)!;
      if (!(baselines || outgoing) && this.is_baseline(row.source_module)) continue;
      if (wanted.has(row.link_module)) rows.push(row);
    }
    rows.sort(outgoing
      ? (a, b) => a.target_module - b.target_module || a.target_absno - b.target_absno || a.id - b.id
      : (a, b) => a.source_module - b.source_module || a.source_absno - b.source_absno || a.id - b.id);
    return rows.map((r) => new Link(r.id, r.link_module, new Obj(r.source_module, r.source_absno),
                                    new Obj(r.target_module, r.target_absno)));
  }

  link_info(link: Link): [string, string] | null {
    const row = this._links.get(link.id);
    return row ? [row.created_by, row.created_on] : null;
  }

  // [source changed, target changed] since the link was made or last cleared.
  suspect(link: Link): [boolean, boolean] {
    const row = this._links.get(link.id);
    if (!row) throw new StoreError("that link no longer exists");
    return [this._object_row(link.source).changed_seq > row.reviewed_seq,
            this._object_row(link.target).changed_seq > row.reviewed_seq];
  }

  // The edits behind that: the history of one end since the link was made or
  // last cleared, oldest first.
  suspect_changes(link: Link, end: Obj): History[] {
    const row = this._links.get(link.id);
    if (!row) throw new StoreError("that link no longer exists");
    const edits = ["modifyObject", "deleteObject", "unDeleteObject"];
    return this.history(end.module_id, end.absno).filter((h) => h.seq > row.reviewed_seq && edits.includes(h.action));
  }

  // [who, when] last changed the link itself, or null if that is not known
  // (its suspicion has been cleared since it was made).
  link_modified(link: Link): [string, string] | null {
    const row = this._links.get(link.id);
    return row && !row.cleared ? [row.created_by, row.created_on] : null;
  }

  // `by_hand` false: loading a file is setting the state, nobody reviewed anything.
  clear_suspect(link: Link, by_hand: boolean = true): void {
    this.transaction(() => {
      const row = this._links.get(link.id);
      if (row) {
        this._assign(row, "reviewed_seq", this._seq);
        if (by_hand) this._assign(row, "cleared", true);
        this.total_changes += 1;
      }
    });
  }

  // =====================================================================
  // History
  // =====================================================================

  history(module_id: number, absno: number | null = null): History[] {
    const data = this._modules.get(module_id);
    if (!data) return [];
    return [...(absno === null ? data.history : data.object_history.get(absno) ?? [])];
  }

  // =====================================================================
  // Baselines
  // =====================================================================

  _baseline(row: _ItemRow): Baseline {
    return new Baseline(row.baseline_of!, row.id, row.major!, row.minor!, row.suffix!, row.annotation!,
                        row.created_by, row.created_on);
  }

  baselines(module_id: number): Baseline[] {
    return [...this._baselines.get(module_id) ?? []]
      .map((id) => this._items.get(id)!)
      .sort((a, b) => a.major! - b.major! || a.minor! - b.minor! || a.id - b.id)
      .map((row) => this._baseline(row));
  }

  baseline_of(copy_id: number): Baseline | null {
    const row = this._items.get(copy_id);
    return row && row.baseline_of !== null ? this._baseline(row) : null;
  }

  create_baseline(module_id: number, annotation: string = "", major: boolean = false,
                  suffix: string = ""): Baseline {
    return this.transaction(() => {
      this._writable(module_id);
      const item = this.item(module_id);
      if (item.kind !== "formal") throw new StoreError("only formal modules are baselined");
      const existing = this.baselines(module_id);
      let number: [number, number];
      if (!existing.length) {
        number = major ? [1, 0] : [0, 1];
      } else {
        const last = existing[existing.length - 1];
        number = major ? [last.major + 1, 0] : [last.major, last.minor + 1];
      }
      const stamp = this.now();
      const copy = this._insert_item({
        ...this._items.get(module_id)!, id: this._max_item + 1, deleted: 0, baseline_of: module_id,
        major: number[0], minor: number[1], suffix, annotation, created_by: this.user, created_on: stamp,
      });
      const from = this._data(module_id), to = this._data(copy);
      for (const [name, row] of from.types) this._put(to.types, name, { base: row.base, vals: [...row.vals] });
      for (const [name, row] of from.defs) this._put(to.defs, name, { ...row });
      for (const [name, value] of from.module_values) this._put(to.module_values, name, value);
      for (const [absno, row] of from.objects) this._put(to.objects, absno, { ...row });
      for (const [parent, list] of from.kids) {
        to.kids.set(parent, list.map((row) => to.objects.get(row.absno)!));
        this._undo(() => { to.kids.delete(parent); });
      }
      for (const [absno, held] of from.values) this._put(to.values, absno, new Map(held));
      this.total_changes += from.types.size + from.defs.size + from.module_values.size + from.objects.size;
      for (const held of from.values.values()) this.total_changes += held.size;
      const copied: _LinkRow[] = [];
      for (const absno of from.objects.keys()) {
        for (const id of this._outgoing.get(`${module_id}:${absno}`) ?? []) copied.push(this._links.get(id)!);
      }
      copied.sort((a, b) => a.source_absno - b.source_absno || a.id - b.id);
      for (const row of copied) {
        this._insert_link({
          ...row, id: this._max_link + 1, source_module: copy,
          target_module: row.target_module === module_id ? copy : row.target_module,
        });
      }
      this._record(module_id, null, "createBaseline", "", "", `${number[0]}.${number[1]}`);
      return this.baseline_of(copy)!;
    });
  }

  // Differences between two versions of a module (usually a baseline and
  // the current module): objects with absno, change, attribute, old, new.
  compare(old_module: number, new_module: number):
      { absno: number; change: string; attribute: string; old: string; new: string }[] {
    const snapshot = (module: number) => {
      const data = this._modules.get(module);
      return new Map(this.objects(module).map((o) => [o.absno, data!.values.get(o.absno) ?? new Map()]));
    };
    const before = snapshot(old_module), after = snapshot(new_module);
    const text = (held: Map<string, string>) => held.get("Object Text") || held.get("Object Heading") || "";
    const changes: { absno: number; change: string; attribute: string; old: string; new: string }[] = [];
    for (const absno of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)) {
      if (!after.has(absno)) {
        changes.push({ absno, change: "deleted", attribute: "", old: text(before.get(absno)!), new: "" });
      } else if (!before.has(absno)) {
        changes.push({ absno, change: "added", attribute: "", old: "", new: text(after.get(absno)!) });
      } else {
        const a = before.get(absno)!, b = after.get(absno)!;
        for (const name of [...new Set<string>([...a.keys(), ...b.keys()])].sort(_cmp)) {
          const old = a.get(name) ?? "", new_ = b.get(name) ?? "";
          if (old !== new_) changes.push({ absno, change: "modified", attribute: name, old, new: new_ });
        }
      }
    }
    return changes;
  }

  // =====================================================================
  // Views
  // =====================================================================

  // Map name -> definition (see views.ts).
  views(module_id: number): Map<string, any> {
    const held = this._modules.get(module_id)?.views;
    if (!held) return new Map();
    return new Map([...held].sort((a, b) => _cmp(a[0], b[0])).map(([n, d]) => [n, JSON.parse(d)]));
  }

  save_view(module_id: number, name: string, definition: any): void {
    this.transaction(() => {
      this._writable(module_id);
      if (!name) throw new StoreError("a view needs a name");
      const json = JSON.stringify(definition, (_, v) => (v instanceof Map ? Object.fromEntries(v) : v));
      this._put(this._data(module_id).views, name, json);
      this.total_changes += 1;
    });
  }

  delete_view(module_id: number, name: string): void {
    this.transaction(() => {
      const held = this._modules.get(module_id)?.views;
      if (held && this._drop(held, name)) this.total_changes += 1;
    });
  }

  // =====================================================================
  // Saving the whole database (history and baselines included)
  // =====================================================================

  dumps(): string {
    return JSON.stringify({
      format: "opendoor-store",
      version: 1,
      db_path: this.db_path,
      user: this.user,
      seq: this._seq,
      items: [...this._items.values()],
      modules: [...this._modules].map(([id, m]) => ({
        id,
        types: [...m.types],
        defs: [...m.defs],
        module_values: [...m.module_values],
        objects: [...m.objects.values()],
        values: [...m.values].map(([absno, held]) => [absno, [...held]]),
        views: [...m.views],
        history: m.history.map((h) => [h.seq, h.when, h.who, h.absno, h.action, h.attribute, h.old, h.new,
                                       h.target_absno, h.object_count]),
      })),
      links: [...this._links.values()],
    });
  }

  static loads(text: string): Store {
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data || data.format !== "opendoor-store" || data.version !== 1) {
      throw new StoreError("this is not a saved database");
    }
    const store = new Store(data.db_path, data.user);
    store._items.clear();
    store._max_item = 0;
    for (const row of data.items) store._insert_item(row);
    for (const saved of data.modules) {
      const m = _empty_module();
      m.types = new Map(saved.types);
      m.defs = new Map(saved.defs);
      m.module_values = new Map(saved.module_values);
      for (const row of saved.objects as _ObjectRow[]) {
        m.objects.set(row.absno, row);
        let list = m.kids.get(row.parent);
        if (!list) m.kids.set(row.parent, list = []);
        list.push(row);
      }
      for (const list of m.kids.values()) list.sort((a, b) => a.position - b.position || a.absno - b.absno);
      m.values = new Map(saved.values.map(([absno, held]: [number, [string, string][]]) => [absno, new Map(held)]));
      m.views = new Map(saved.views);
      for (const [seq, when, who, absno, action, attribute, old, new_, target, count] of saved.history) {
        const entry = new History(seq, when, who, saved.id, absno, action, attribute, old, new_,
                                  target ?? null, count ?? null);
        m.history.push(entry);
        if (absno !== null) {
          let list = m.object_history.get(absno);
          if (!list) m.object_history.set(absno, list = []);
          list.push(entry);
        }
      }
      store._modules.set(saved.id, m);
    }
    for (const row of data.links) store._insert_link(row);
    store._seq = data.seq;
    store.total_changes = 0;
    return store;
  }
}

// A Date for the date spellings DOORS users type, or null. The wall-clock time
// is in the Date's UTC fields (getUTCFullYear and so on).
export function parse_date(text: string): Date | null {
  for (const layout of ["%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d %B %Y", "%d %b %Y",
                        "%m/%d/%Y", "%m/%d/%y"]) {
    try {
      return _strptime(_strip(text), layout);
    } catch (error) {
      if ((error as Error).name !== "ValueError") throw error;
    }
  }
  return null;
}
