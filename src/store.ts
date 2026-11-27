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

import { escape_text, is_formatted, markup_of, parse, plain_of } from "./rich.ts";

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

// What an attribute type may carry beyond its base type and value names.
// `numbers`, `colours` and `descriptions` run parallel to the values.
export type TypeExtras = {
  description?: string;
  numbers?: readonly number[];
  colours?: readonly number[];
  real_colours?: boolean; // the colours are real colour numbers, not logical ones
  descriptions?: readonly string[];
  min?: string; // limits of an Integer, Real or Date type
  max?: string;
};

// Which link module links from `source` to `target` go in. The three names are
// as given, read from the folder that holds the descriptor.
export type LinkDescriptor = {
  source: string;
  target: string;
  linkmod: string;
  overridable: boolean;
  mandatory: boolean;
};

// Access rights, as bits. A list is a thing's own (specific) access rights; a
// thing without one has its parent's. The entry named null is for everyone else.
export const RIGHTS = { read: 1, modify: 2, create: 4, delete: 8, control: 16 } as const;
export const ALL_RIGHTS = 31;
const _DATA_RIGHTS = RIGHTS.read | RIGHTS.modify | RIGHTS.create | RIGHTS.delete;
export type AccessEntry = { name: string | null; rights: number };
// a folder, project or module by id, or an object
export type Guarded = number | Obj;

// the rights each right brings with it, as DOORS confers them
export function closed_rights(rights: number): number {
  let out = rights;
  if (out & RIGHTS.control) out |= RIGHTS.modify | RIGHTS.create | RIGHTS.read;
  if (out & RIGHTS.delete) out |= RIGHTS.modify | RIGHTS.read;
  if (out & (RIGHTS.modify | RIGHTS.create)) out |= RIGHTS.read;
  return out;
}

export function rights_names(rights: number): string[] {
  return Object.entries(RIGHTS).filter(([, bit]) => rights & bit).map(([name]) => name);
}

// The users and groups of the database. A group's members are user names.
export type Directory = {
  users: { name: string; uid: string }[];
  groups: { name: string; members: string[] }[];
};

// Persistent triggers. Each is held by the thing it watches: a module, or a
// project or the database root for all the formal modules inside it. Only the
// kinds the interface itself can fire are held, so none is stored and never run.
export type TriggerRow = {
  name: string;
  level: "module" | "object" | "attribute";
  when: "pre" | "post";
  event: "open" | "sync" | "save";
  word: string; // the event as it was written: open or read; save, write, or modify
  priority: number;
  dxl: string;
  formal?: boolean; // written with ->formal
  attribute?: string; // attribute level: one attribute only
  absno?: number; // object and attribute level: one object only
};
export type Trigger = { at: number; row: TriggerRow };
// what a trigger is running about
export type TriggerContext = {
  module: number; absno: number | null; attribute: string | null; value: string | null;
};
export type TriggerEngine = {
  // Runs one trigger's DXL. For a pre trigger, answers whether it passed.
  run(store: Store, trigger: Trigger, context: TriggerContext): boolean;
  // Refuses DXL that would not run here.
  check(store: Store, dxl: string): void;
};

export function trigger_covers(row: TriggerRow, level: string, event: string, absno: number | null,
  attribute: string | null): boolean {
  return row.level === level && row.event === event && (row.absno === undefined || row.absno === absno)
    && (row.attribute === undefined || row.attribute === attribute);
}

// Baseline set definitions are held by a folder or project. A baseline set is
// one round of baselining the modules a definition names.
export type BaselineSetRow = {
  major: number; minor: number; suffix: string; annotation: string;
  open: boolean; user: string; date: string;
  members: number[]; // the baseline copies in the set
};
export type SetDefinition = {
  id: number; name: string; description: string; modules: number[]; sets: BaselineSetRow[];
};

function _next_version(last: { major: number; minor: number } | undefined, major: boolean): [number, number] {
  if (!last) return major ? [1, 0] : [0, 1];
  return major ? [last.major + 1, 0] : [last.major, last.minor + 1];
}

export class AttrType extends _Record {
  readonly module_id: number;
  readonly name: string;
  readonly base: string;
  readonly values: readonly string[]; // enumeration values, in order
  readonly description: string;
  readonly numbers: readonly number[];
  readonly colours: readonly number[];
  readonly real_colours: boolean;
  readonly descriptions: readonly string[];
  readonly min: string;
  readonly max: string;

  constructor(module_id: number, name: string, base: string, values: readonly string[], extras: TypeExtras = {}) {
    super();
    this.module_id = module_id;
    this.name = name;
    this.base = base;
    this.values = values;
    this.description = extras.description ?? "";
    this.numbers = [...extras.numbers ?? []];
    this.colours = [...extras.colours ?? []];
    this.real_colours = extras.real_colours ?? false;
    this.descriptions = [...extras.descriptions ?? []];
    this.min = extras.min ?? "";
    this.max = extras.max ?? "";
  }
}

// Settings of an attribute definition beyond its type, default and DXL.
export type DefExtras = {
  description?: string;
  inherit?: boolean; // objects without a value of their own show their parent's
  hidden?: boolean;
  history?: boolean; // false: edits are not recorded in the history
  bars?: boolean; // false: edits do not alter change bars (none are shown here)
  dates?: boolean; // false: edits do not alter Last Modified By / On
  min?: string; // from the type
  max?: string;
};

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

  readonly description: string;
  readonly inherit: boolean;
  readonly hidden: boolean;
  readonly history: boolean;
  readonly bars: boolean;
  readonly dates: boolean;
  readonly min: string;
  readonly max: string;

  constructor(module_id: number, name: string, type_name: string, base: string, scope: string,
              multi: boolean, default_: string, values: readonly string[], dxl: string = "",
              extras: DefExtras = {}) {
    super();
    this.description = extras.description ?? "";
    this.inherit = extras.inherit ?? false;
    this.hidden = extras.hidden ?? false;
    this.history = extras.history ?? true;
    this.bars = extras.bars ?? true;
    this.dates = extras.dates ?? true;
    this.min = extras.min ?? "";
    this.max = extras.max ?? "";
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

// the base types whose values can carry formatting
export const RICH_BASES: readonly string[] = ["String", "Text"];

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
  // folders and projects: link module descriptors, and the modules limited to them
  descriptors?: LinkDescriptor[];
  exclusive?: number[];
  // link modules: linksets made before any link was, as [source, target] module ids
  linksets?: [number, number][];
  access?: AccessEntry[]; // own access rights; absent: inherited
  triggers?: TriggerRow[];
  baseline_sets?: SetDefinition[];
  sessions?: { user: string; date: string }[]; // each opening for editing, in order
};
type _TypeRow = { base: string; vals: string[] } & TypeExtras;
type _DefRow = { type_name: string; scope: string; multi: number; dflt: string; position: number; dxl?: string }
  & Omit<DefExtras, "min" | "max">
  // own access rights over the definition, and over its values; absent: inherited
  & { def_access?: AccessEntry[]; val_access?: AccessEntry[] };
export type AttrPart = "definition" | "values";
const _PART = { definition: "def_access", values: "val_access" } as const;
type _ObjectRow = {
  absno: number; parent: number | null; position: number; deleted: number; created_by: string;
  created_on: string; modified_by: string; modified_on: string; changed_seq: number;
  access?: AccessEntry[];
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
  // formatting of some of those values, as canonical markup of the same text
  rich: Map<number, Map<string, string>>;
  views: Map<string, string>;
  history: History[];
  object_history: Map<number, History[]>;
};

function _empty_module(): _ModuleData {
  return { types: new Map(), defs: new Map(), module_values: new Map(), objects: new Map(), kids: new Map(),
           values: new Map(), rich: new Map(), views: new Map(), history: [], object_history: new Map() };
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

// types DOORS itself defines
const SYSTEM_TYPE_NAMES = ["String", "Text", "Integer", "Real", "Date", "Boolean", "Username"];

const _TYPE_EXTRAS = ["description", "numbers", "colours", "real_colours", "descriptions", "min", "max"] as const;

// the keys of a type's extras that were actually given
function _type_extras(extras: TypeExtras): TypeExtras {
  const out: any = {};
  for (const key of _TYPE_EXTRAS) {
    const value: any = extras[key];
    if (value === undefined) continue;
    const empty = value === "" || value === false || (Array.isArray(value) && !value.length);
    out[key] = empty ? undefined : Array.isArray(value) ? [...value] : value;
  }
  return JSON.parse(JSON.stringify(out));
}

function _check_type(base: string, values: readonly string[], extras: TypeExtras): void {
  if (!BASE_TYPES.includes(base)) throw new StoreError(`unknown base type ${_repr(base)}`);
  if ((base === "Enumeration") !== (values.length > 0)) {
    throw new StoreError("an enumeration type needs values, and no other type takes them");
  }
  if (new Set(values).size !== values.length) throw new StoreError("enumeration values must be unique");
  for (const key of ["numbers", "colours", "descriptions"] as const) {
    const given = extras[key];
    if (given?.length && given.length !== values.length) {
      throw new StoreError(`an enumeration type needs one of its ${key} for each value`);
    }
  }
  const ends = [extras.min, extras.max].filter((v) => v !== undefined && v !== "") as string[];
  if (ends.length && !["Integer", "Real", "Date"].includes(base)) {
    throw new StoreError("only Integer, Real and Date types have limits");
  }
  if (extras.min && extras.max && _compare_as(base, extras.max, extras.min) < 0) {
    throw new StoreError("the maximum is less than the minimum");
  }
}

function _compare_as(base: string, a: string, b: string): number {
  if (base === "Date") return parse_date(a)!.getTime() - parse_date(b)!.getTime();
  return Number(a) - Number(b);
}

function _check_range(definition: AttrDef, value: string): void {
  const low = definition.min && _compare_as(definition.base, value, definition.min) < 0;
  const high = definition.max && _compare_as(definition.base, value, definition.max) > 0;
  if (low || high) {
    throw new StoreError(`${definition.name}: ${_repr(value)} is outside the range of type `
      + `${_repr(definition.type_name)}`);
  }
}

// the definition settings that were given; only what differs from the usual is kept
function _def_extras(extras: DefExtras): Partial<_DefRow> {
  const out: any = {};
  const usual = { description: "", inherit: false, hidden: false, history: true, bars: true, dates: true };
  for (const [key, plain] of Object.entries(usual)) {
    const value = (extras as any)[key];
    if (value !== undefined) out[key] = value === plain ? undefined : value;
  }
  return out;
}

function _check_inherit(name: string, scope: string, inherit: boolean, dxl: string): void {
  if (inherit && scope === "object" && dxl) {
    throw new StoreError(`${name}: an inherited object attribute with DXL is not supported here`);
  }
}

// rename an attribute wherever a saved view names it
function _rename_in_view(node: any, from: string, to: string): boolean {
  let changed = false;
  if (!node || typeof node !== "object") return false;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if ((key === "attribute" || key === "sort") && value === from) {
      node[key] = to;
      changed = true;
    } else if (key === "columns" && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] === from) {
          value[i] = to;
          changed = true;
        } else if (_rename_in_view(value[i], from, to)) changed = true;
      }
    } else if (_rename_in_view(value, from, to)) changed = true;
  }
  return changed;
}

// An in-memory database. The `path` is only remembered; use `dumps` and `loads`
// to keep it.
//
// Every public write is one transaction. Wrap several in `store.transaction(() => ...)`
// to make them one.
export class Store {
  // Runs attribute DXL. The DXL engine puts itself here when it is loaded.
  static dxl_engine: ((store: Store, obj: Obj, name: string, code: string) => string) | null = null;
  // Runs trigger DXL. The DXL engine puts itself here too.
  static trigger_engine: TriggerEngine | null = null;
  // set while the person at the interface is doing the thing a trigger watches
  _by_hand: boolean;
  directory: Directory; // replaced whole by set_directory, never changed in place
  trigger_output: string[]; // what triggers printed, until the interface takes it
  // What attribute DXL has calculated, by "module:absno:name". Like DOORS, a
  // value is kept until it is reset; unlike stored values it is never saved.
  _computed: Map<string, { value: string } | { error: string }>;
  _timeouts: Map<string, number>; // by "module:name": objects whose DXL ran too long
  db_path: string;
  user: string;
  default_link_name: string | null; // the user's default link module, if set
  _conf: Map<string, string | null>; // the configuration area: text, or null for a folder
  _guarded: boolean; // some thing has had access rights of its own
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
    this.default_link_name = null;
    this._conf = new Map();
    this._guarded = false;
    this._by_hand = false;
    this.directory = { users: [], groups: [] };
    this.trigger_output = [];
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
    this._require(parent, RIGHTS.create, "create something in a folder");
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
  // "Start at": the absolute number the first object of a new module takes.
  set_first_number(module_id: number, first: number): void {
    this.transaction(() => {
      this._writable(module_id);
      const row = this._items.get(module_id);
      if (!row || row.kind !== "formal" || row.next_absno !== 1) {
        throw new StoreError("only a module that has never held an object takes a starting number");
      }
      if (!Number.isSafeInteger(first) || first < 1) throw new StoreError("the starting number is a whole number from 1");
      this._update_item(module_id, "next_absno", first);
    });
  }

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
      this._require(item_id, RIGHTS.modify, "change a name, description or prefix");
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
    this.transaction(() => {
      this._require_within(item_id, RIGHTS.delete, deleted ? "delete" : "undelete");
      this._update_item(item_id, "deleted", Number(deleted));
    });
  }

  // Remove a soft-deleted folder, project or module for good, with everything
  // in it, its baselines and the links to and from its objects.
  purge_item(item_id: number): void {
    this.transaction(() => {
      if (item_id === ROOT) throw new StoreError("the database root cannot be purged");
      this._writable(item_id);
      if (!this.item(item_id).deleted) throw new StoreError(`${this.path(item_id)} is not deleted`);
      this._require_within(item_id, RIGHTS.delete, "purge");
      const gone: number[] = [];
      const collect = (id: number) => {
        for (const child of this._item_children.get(id) ?? []) collect(child);
        gone.push(...this._baselines.get(id) ?? [], id);
      };
      collect(item_id);
      const doomed = new Set(gone);
      for (const link of [...this._links.values()]) {
        if (doomed.has(link.source_module) || doomed.has(link.target_module) || doomed.has(link.link_module)) {
          this._delete_link_row(link.id);
        }
      }
      for (const id of gone) {
        const row = this._items.get(id)!;
        this.forget_computed(id);
        if (row.baseline_of !== null) this._remove(this._baselines, row.baseline_of, id);
        else if (row.parent !== null) {
          this._remove(this._item_children, row.parent, id);
          const names = this._names.get(row.parent);
          if (names?.get(row.name) === id) this._drop(names, row.name);
        }
        this._drop(this._modules, id);
        this._drop(this._items, id);
        this.total_changes += 1;
      }
      this._link_module_paths = null;
    });
  }

  // A folder becomes a project, or a project a folder.
  set_project(item_id: number, project: boolean): void {
    this.transaction(() => {
      const item = this.item(item_id);
      if (item_id === ROOT || item.kind !== (project ? "folder" : "project")) {
        throw new StoreError(`${this.path(item_id)} is not a ${project ? "folder" : "project"}`);
      }
      this._require(item_id, _DATA_RIGHTS, "convert between folder and project");
      this._update_item(item_id, "kind", project ? "project" : "folder");
      this._stamp(item_id);
    });
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

  _insert_type(module_id: number, name: string, base: string, values: readonly string[],
               extras: TypeExtras = {}): void {
    this._put(this._data(module_id).types, name, { ..._type_extras(extras), base, vals: [...values] });
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
      out.push(new AttrType(module_id, name, row.base, [...row.vals], row));
    }
    return out;
  }

  create_type(module_id: number, name: string, base: string, values: readonly string[] = [],
              extras: TypeExtras = {}): void {
    this.transaction(() => {
      this._writable(module_id);
      this._require(module_id, RIGHTS.create, "create an attribute type");
      _check_type(base, values, extras);
      if (this._modules.get(module_id)?.types.has(name)) {
        throw new StoreError(`type ${_repr(name)} already exists`);
      }
      this._insert_type(module_id, name, base, values, extras);
      this._stamp(module_id);
    });
  }

  // Names of the attributes defined with a type.
  type_users(module_id: number, name: string): string[] {
    return [...this._modules.get(module_id)?.defs ?? []]
      .filter(([, def]) => def.type_name === name).map(([attr]) => attr);
  }

  _own_type(module_id: number, name: string): _TypeRow {
    this._writable(module_id);
    if (SYSTEM_TYPE_NAMES.includes(name)) throw new StoreError(`${_repr(name)} is a system type`);
    const row = this._modules.get(module_id)?.types.get(name);
    if (!row) throw new StoreError(`no attribute type ${_repr(name)} in this module`);
    return row;
  }

  // Change a type. `changes` holds only what is to change. While the type is in
  // use its base type stays, and its values can be renamed in place or added at
  // the end (`keeping` says the caller means that), never removed or reordered.
  modify_type(module_id: number, name: string,
              changes: TypeExtras & { name?: string; base?: string; values?: readonly string[] },
              keeping: boolean = false): void {
    this.transaction(() => {
      const row = this._own_type(module_id, name);
      this._require(module_id, RIGHTS.modify, "modify an attribute type");
      const data = this._modules.get(module_id)!;
      const users = this.type_users(module_id, name);
      const base = changes.base ?? row.base;
      const values = changes.values ?? (base === "Enumeration" ? row.vals : []);
      const renamed = changes.name ?? name;
      if (!renamed) throw new StoreError("a type needs a name");
      if (renamed !== name && data.types.has(renamed)) throw new StoreError(`type ${_repr(renamed)} already exists`);
      const next: _TypeRow = { ...row, base, vals: [...values] };
      for (const key of _TYPE_EXTRAS) if (changes[key] !== undefined) delete next[key];
      Object.assign(next, _type_extras(changes));
      if (base !== row.base) {
        for (const key of _TYPE_EXTRAS) if (key !== "description" && changes[key] === undefined) delete next[key];
      }
      _check_type(base, values, next);
      const same = values.length === row.vals.length && values.every((v, i) => v === row.vals[i]);
      if (users.length && base !== row.base) {
        throw new StoreError(`type ${_repr(name)} is in use, so its base type cannot be changed`);
      }
      if (users.length && !same && !(keeping && values.length >= row.vals.length)) {
        throw new StoreError(`type ${_repr(name)} is in use: its values can only be renamed in place or added to`);
      }
      const renames = new Map(row.vals.map((v, i) => [v, values[i]]));
      this._drop(data.types, name);
      this._put(data.types, renamed, next);
      for (const attr of users) {
        const def = data.defs.get(attr)!;
        this._assign(def, "type_name", renamed);
        if (same) continue;
        const moved = (held: string) => held ? held.split("\n").map((v) => renames.get(v) ?? v).join("\n") : "";
        this._assign(def, "dflt", moved(def.dflt));
        for (const held of data.values.values()) {
          if (held.has(attr)) this._put(held, attr, moved(held.get(attr)!));
        }
        if (data.module_values.has(attr)) this._put(data.module_values, attr, moved(data.module_values.get(attr)!));
      }
      for (const attr of users) this._check_values(module_id, attr);
      for (const attr of users) this.forget_computed(module_id, attr);
      this.total_changes += 1;
      this._record(module_id, null, "modifyType", renamed);
    });
  }

  delete_type(module_id: number, name: string): void {
    this.transaction(() => {
      this._own_type(module_id, name);
      this._require(module_id, RIGHTS.delete, "delete an attribute type");
      const users = this.type_users(module_id, name);
      if (users.length) throw new StoreError(`type ${_repr(name)} is used by ${users.map(_repr).join(", ")}`);
      this._drop(this._modules.get(module_id)!.types, name);
      this.total_changes += 1;
      this._record(module_id, null, "deleteType", name);
    });
  }

  // Refuse if a value already held no longer suits the attribute's definition.
  _check_values(module_id: number, name: string): void {
    const definition = this.attribute(module_id, name)!;
    const data = this._modules.get(module_id)!;
    const held = [definition.default, data.module_values.get(name) ?? "",
                  ...[...data.values.values()].map((v) => v.get(name) ?? "")];
    for (const value of held) {
      if (Store.check_value(definition, value) !== value) {
        throw new StoreError(`${name}: the value ${_repr(value)} would have to be converted; change it first`);
      }
    }
  }

  _definition(module_id: number, name: string, def: _DefRow): AttrDef {
    const type = this._modules.get(module_id)!.types.get(def.type_name)!;
    return new AttrDef(module_id, name, def.type_name, type.base, def.scope, Boolean(def.multi), def.dflt,
                       [...type.vals], def.dxl ?? "", { ...def, min: type.min, max: type.max });
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
                   multi: boolean = false, default_: string = "", dxl: string = "",
                   extras: DefExtras = {}): void {
    this.transaction(() => {
      this._writable(module_id);
      this._require(module_id, RIGHTS.create, "create an attribute");
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
      Object.assign(this._modules.get(module_id)!.defs.get(name)!, _def_extras(extras));
      _check_inherit(name, scope, extras.inherit ?? false, dxl);
      if (default_) {
        default_ = Store.check_value(this.attribute(module_id, name)!, default_);
        this._assign(this._modules.get(module_id)!.defs.get(name)!, "dflt", default_);
        this.total_changes += 1;
      }
      this._record(module_id, null, "createAttr", name);
    });
  }

  // Change an attribute definition; `changes` holds only what is to change.
  modify_attribute(module_id: number, name: string, changes: Omit<DefExtras, "min" | "max"> &
    { name?: string; type_name?: string; multi?: boolean; default?: string; dxl?: string }): void {
    this.transaction(() => {
      this._writable(module_id);
      this._require_both(this._modules.get(module_id)?.defs.get(name)?.def_access, module_id, RIGHTS.modify,
        "modify an attribute", `the definition of ${_repr(name)}`);
      const old = this.attribute(module_id, name);
      if (!old) throw new StoreError(`no attribute ${_repr(name)}`);
      const data = this._modules.get(module_id)!;
      if (STANDARD_ATTRIBUTES.some(([n]) => n === name)) {
        throw new StoreError(`${_repr(name)} is a standard attribute and is not changed here`);
      }
      const renamed = changes.name ?? name;
      if (!renamed || SYSTEM_ATTRIBUTES.includes(renamed)) {
        throw new StoreError(`not a usable attribute name: ${_repr(renamed)}`);
      }
      if (renamed !== name && data.defs.has(renamed)) {
        throw new StoreError(`attribute ${_repr(renamed)} already exists`);
      }
      if (renamed !== name) this._unwatched(module_id, name, "renaming");
      const row: _DefRow = { ...data.defs.get(name)!, ..._def_extras(changes) };
      row.type_name = changes.type_name ?? row.type_name;
      const type = data.types.get(row.type_name);
      if (!type) throw new StoreError(`no attribute type ${_repr(row.type_name)} in this module`);
      row.multi = Number(changes.multi ?? Boolean(row.multi));
      if (row.multi && type.base !== "Enumeration") {
        throw new StoreError("only an enumeration attribute can be multi-valued");
      }
      row.dflt = changes.default ?? row.dflt;
      const dxl = changes.dxl ?? row.dxl ?? "";
      if (dxl) row.dxl = dxl; else delete row.dxl;
      if (dxl && (row.scope !== "object" || row.multi || row.dflt)) {
        throw new StoreError(`${renamed}: attribute DXL is only supported here on a single-valued object attribute `
          + "without a default");
      }
      _check_inherit(renamed, row.scope, row.inherit ?? false, dxl);
      if (dxl && !old.dxl && [...data.values.values()].some((held) => held.get(name))) {
        throw new StoreError(`${renamed}: objects hold values for it, which attribute DXL would replace`);
      }
      this._drop(data.defs, name);
      this._put(data.defs, renamed, row);
      if (renamed !== name) {
        for (const held of [data.module_values, ...data.values.values()]) {
          if (!held.has(name)) continue;
          this._put(held, renamed, held.get(name)!);
          this._drop(held, name);
        }
        for (const held of data.rich.values()) {
          if (!held.has(name)) continue;
          this._put(held, renamed, held.get(name)!);
          this._drop(held, name);
        }
        for (const [view, json] of data.views) {
          const definition = JSON.parse(json);
          if (_rename_in_view(definition, name, renamed)) this._put(data.views, view, JSON.stringify(definition));
        }
      }
      if (row.dflt) row.dflt = Store.check_value(this.attribute(module_id, renamed)!, row.dflt);
      // as in DOORS, values still holding the old default follow it to the new one
      if (old.default && row.dflt !== old.default) {
        for (const held of [data.module_values, ...data.values.values()]) {
          if (held.get(renamed) === old.default) this._put(held, renamed, row.dflt);
        }
        for (const [absno, held] of data.rich) {
          if (data.values.get(absno)?.get(renamed) !== plain_of(parse(held.get(renamed) ?? ""))) {
            this._drop(held, renamed);
          }
        }
      }
      if (!RICH_BASES.includes(type.base)) for (const held of data.rich.values()) this._drop(held, renamed);
      this._check_values(module_id, renamed);
      this.forget_computed(module_id, name);
      this.total_changes += 1;
      this._record(module_id, null, "modifyAttr", renamed);
    });
  }

  delete_attribute(module_id: number, name: string): void {
    this.transaction(() => {
      this._writable(module_id);
      if (STANDARD_ATTRIBUTES.some(([n]) => n === name)) {
        throw new StoreError(`${_repr(name)} is a standard attribute`);
      }
      this._require_both(this._modules.get(module_id)?.defs.get(name)?.def_access, module_id, RIGHTS.delete,
        "delete an attribute", `the definition of ${_repr(name)}`);
      if (!this.attribute(module_id, name)) throw new StoreError(`no attribute ${_repr(name)}`);
      this._unwatched(module_id, name, "deleting");
      const data = this._modules.get(module_id)!;
      this._drop(data.defs, name);
      this._drop(data.module_values, name);
      for (const held of data.values.values()) this._drop(held, name);
      for (const held of data.rich.values()) this._drop(held, name);
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
      const whole = String(BigInt(_ascii_digits(_strip(value))));
      _check_range(definition, whole);
      return whole;
    }
    if (base === "Real") {
      if (!_is_float(value)) throw new StoreError(`${name}: ${_repr(value)} is not a number`);
      _check_range(definition, value);
    } else if (base === "Date") {
      if (parse_date(value) === null) {
        throw new StoreError(`${name}: ${_repr(value)} is not a date (use YYYY-MM-DD)`);
      }
      _check_range(definition, _strip(value));
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
      this._require_both(this._modules.get(module_id)!.defs.get(name)!.val_access, module_id, RIGHTS.modify,
        "change a module attribute", `the values of ${_repr(name)}`);
      value = Store.check_value(definition, value);
      this.refuse_triggered({ module: module_id, absno: null, attribute: name, value }, "attribute", "save",
        `a value given to the module attribute ${_repr(name)}`);
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
      const anchor = after || before;
      const under = anchor ? this.parent_object(anchor) : parent;
      this._require(under ?? module_id, RIGHTS.create, "create an object");
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
      const wanted = new Map<string, string>(values instanceof Map ? values : Object.entries(values ?? {}));
      // defaults are the database's own doing, so creating needs no modify access for them
      const guarded = this._guarded;
      this._guarded = false;
      try {
        // an inherited attribute's default is only seen where no ancestor has a value
        for (const a of this.attributes(module_id)) {
          if (a.default && !a.inherit && !wanted.has(a.name)) this.set_value(obj, a.name, a.default);
        }
      } finally {
        this._guarded = guarded;
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
      if (this._guarded) { // which rights a move needs is not settled, so it needs them all
        for (const thing of [obj, this.parent_object(obj) ?? obj.module_id,
          (anchor ? this.parent_object(anchor) : parent) ?? obj.module_id]) {
          this._require(thing, _DATA_RIGHTS, "move an object");
        }
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
      this._require(obj, RIGHTS.delete, "delete an object");
      this._set_deleted(obj, 1);
      this._touch(obj, "deleteObject");
    });
  }

  undelete_object(obj: Obj): void {
    this.transaction(() => {
      this._writable(obj.module_id);
      const up = this.parent_object(obj);
      if (up && this.is_deleted(up)) throw new StoreError("undelete its parent first");
      this._require(obj, RIGHTS.delete, "undelete an object");
      this._set_deleted(obj, 0);
      this._touch(obj, "unDeleteObject");
    });
  }

  // Remove one object for good, with its links. It may have no children at all.
  purge_object(obj: Obj): void {
    this.transaction(() => {
      this._writable(obj.module_id);
      const data = this._modules.get(obj.module_id)!;
      const row = this._object_row(obj);
      if (data.kids.get(obj.absno)?.length) throw new StoreError(`${this.identifier(obj)} still has children`);
      this._require(obj, RIGHTS.delete, "purge an object");
      for (const index of [this._outgoing, this._incoming]) {
        for (const id of [...index.get(obj.key) ?? []]) this._delete_link_row(id);
      }
      this._detach(data, row);
      this._drop(data.objects, obj.absno);
      this._drop(data.values, obj.absno);
      this._drop(data.rich, obj.absno);
      this.total_changes += 1;
      this._record(obj.module_id, obj.absno, "purgeObject");
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
        this._require(obj, RIGHTS.delete, "purge an object");
        for (const index of [this._outgoing, this._incoming]) {
          for (const id of [...index.get(obj.key) ?? []]) this._delete_link_row(id);
        }
        const row = data!.objects.get(obj.absno)!;
        this._detach(data!, row);
        this._drop(data!.objects, obj.absno);
        this._drop(data!.values, obj.absno);
        this._drop(data!.rich, obj.absno);
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
    if (definition.inherit) { // top-level objects take nothing from the module
      const up = this.parent_object(obj);
      return up ? this.value(up, name) : definition.dflt;
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

  // Whether the object holds a value of its own (and so does not inherit one).
  has_own_value(obj: Obj, name: string): boolean {
    this._object_row(obj);
    return this._modules.get(obj.module_id)!.values.get(obj.absno)?.has(name) ?? false;
  }

  // Map absno -> Map name -> value, for a whole module in one go. Attributes
  // calculated by DXL are not among them. Inherited values are, unless `own`.
  values(module_id: number, own: boolean = false): Map<number, Map<string, string>> {
    const out = new Map<number, Map<string, string>>();
    const data = this._modules.get(module_id);
    if (!data) return out;
    const held = data.values;
    const inherited = own ? [] : [...data.defs].filter(([, d]) => d.inherit && d.scope === "object").map(([n]) => n);
    const absnos = inherited.length ? data.objects.keys() : held.keys();
    for (const absno of [...absnos].sort((a, b) => a - b)) {
      const mine = new Map(held.get(absno) ?? []);
      for (const name of inherited) {
        const value = this.value(new Obj(module_id, absno), name);
        if (value && !mine.has(name)) mine.set(name, value);
      }
      if (mine.size) out.set(absno, new Map([...mine].sort((a, b) => _cmp(a[0], b[0]))));
    }
    return out;
  }

  // The formatting the value shown for this attribute has, as markup, or null.
  formatting(obj: Obj, name: string): string | null {
    const data = this._modules.get(obj.module_id);
    if (data?.values.get(obj.absno)?.has(name)) return data.rich.get(obj.absno)?.get(name) ?? null;
    if (!data?.defs.get(name)?.inherit) return null;
    const up = this.parent_object(obj);
    return up ? this.formatting(up, name) : null;
  }

  // value() as rich text markup, formatted or not.
  rich_value(obj: Obj, name: string): string {
    const value = this.value(obj, name);
    return this.formatting(obj, name) ?? escape_text(value);
  }

  // Map absno -> Map name -> markup: the formatted values of a module, those
  // inherited too unless `own`.
  formattings(module_id: number, own: boolean = false): Map<number, Map<string, string>> {
    const out = new Map<number, Map<string, string>>();
    const data = this._modules.get(module_id);
    if (!data || ![...data.rich.values()].some((held) => held.size)) return out;
    const inherited = own ? [] : [...data.defs].filter(([, d]) => d.inherit && d.scope === "object").map(([n]) => n);
    for (const absno of [...(inherited.length ? data.objects.keys() : data.rich.keys())].sort((a, b) => a - b)) {
      const mine = new Map(data.rich.get(absno) ?? []);
      for (const name of inherited) {
        const markup = this.formatting(new Obj(module_id, absno), name);
        if (markup !== null) mine.set(name, markup);
      }
      if (mine.size) out.set(absno, new Map([...mine].sort((a, b) => _cmp(a[0], b[0]))));
    }
    return out;
  }

  // Plain text, which takes the place of any formatting the value had.
  set_value(obj: Obj, name: string, value: string): void {
    this._set_value(obj, name, value, null);
  }

  // Rich text markup: the value becomes the text it shows, with its formatting.
  set_rich(obj: Obj, name: string, markup: string): void {
    let doc;
    try {
      doc = parse(markup);
    } catch (error) {
      throw new StoreError(`${name}: ${(error as Error).message}`);
    }
    const value = plain_of(doc);
    this._set_value(obj, name, value, value && is_formatted(doc) ? markup_of(doc) : null);
  }

  _set_value(obj: Obj, name: string, value: string, markup: string | null): void {
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
      this._require_both(this._modules.get(obj.module_id)!.defs.get(name)!.val_access, obj, RIGHTS.modify,
        "change an attribute value", `the values of ${_repr(name)}`);
      value = Store.check_value(definition, value);
      this._object_row(obj);
      if (markup !== null && !RICH_BASES.includes(definition.base)) {
        throw new StoreError(`${name}: formatting on a ${definition.base} attribute is not supported here`);
      }
      const about = { module: obj.module_id, absno: obj.absno, attribute: name, value };
      // before the unchanged case: whether DOORS then fires is not settled either
      if (!this._by_hand) {
        this.refuse_triggered(about, "attribute", "save", `a value given to ${_repr(name)}`);
      }
      const unchanged = this.value(obj, name) === value && this.formatting(obj, name) === markup;
      if (!unchanged) this.fire("pre", "attribute", "save", about);
      this._write_value(obj, definition, value, markup);
      if (!unchanged) this.fire("post", "attribute", "save", about);
    });
  }

  _write_value(obj: Obj, definition: AttrDef, value: string, markup: string | null): void {
      const name = definition.name;
      const old = this.value(obj, name);
      // an inherited value given again becomes the object's own
      if (old === value && this.formatting(obj, name) === markup
          && !(definition.inherit && !this.has_own_value(obj, name))) {
        // an object older than its attribute's default, given the value it showed:
        // note that it now has been given one
        if (definition.default && !definition.inherit && !this.has_own_value(obj, name)) {
          const data = this._modules.get(obj.module_id)!;
          let held = data.values.get(obj.absno);
          if (!held) this._put(data.values, obj.absno, held = new Map());
          this._put(held, name, value);
          this.total_changes += 1;
        }
        return;
      }
      const data = this._modules.get(obj.module_id)!;
      let held = data.values.get(obj.absno);
      if (!held) this._put(data.values, obj.absno, held = new Map());
      this._put(held, name, value);
      let rich = data.rich.get(obj.absno);
      if (markup !== null) {
        if (!rich) this._put(data.rich, obj.absno, rich = new Map());
        this._put(rich, name, markup);
      } else if (rich) this._drop(rich, name);
      this.total_changes += 1;
      if (definition.history && definition.dates) {
        this._touch(obj, "modifyObject", name, old, value);
        return;
      }
      if (definition.history) this._record(obj.module_id, obj.absno, "modifyObject", name, old, value);
      else this._stamp(obj.module_id);
      const row = this._object_row(obj);
      this._assign(row, "changed_seq", this._seq); // still a change as far as suspect links go
      if (definition.dates) {
        this._assign(row, "modified_by", this.user);
        this._assign(row, "modified_on", this.now());
      }
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

  // The user's default link module, if one was set: a name, looked for beside
  // the source module, or a full path. Created if missing.
  set_default_link_name(name: string): void {
    this.transaction(() => {
      if (!name || (name.includes("/") && !name.startsWith("/"))) {
        throw new StoreError("the default link module is a name, or a full path starting with /");
      }
      const before = this.default_link_name;
      this.default_link_name = name;
      this._undo(() => { this.default_link_name = before; });
      this.total_changes += 1;
    });
  }

  _user_default_module(source_module: number): number {
    const wanted = this.default_link_name!;
    const beside = this.item(source_module).parent!;
    const found = this.module_at(wanted, "link", beside);
    if (found !== null) return found;
    if (!wanted.startsWith("/")) return this.create_link_module(this.path(beside), wanted);
    const slash = wanted.lastIndexOf("/");
    return this.create_link_module(wanted.slice(0, slash) || "/", wanted.slice(slash + 1));
  }

  // =====================================================================
  // Linksets: a link module's links from one module to another
  // =====================================================================

  linksets(link_module: number): [number, number][] {
    const seen = new Map<string, [number, number]>();
    for (const [a, b] of this._items.get(link_module)?.linksets ?? []) {
      if (this._items.has(a) && this._items.has(b)) seen.set(`${a}:${b}`, [a, b]);
    }
    for (const row of this._links.values()) {
      if (row.link_module !== link_module || this.is_baseline(row.source_module)) continue;
      seen.set(`${row.source_module}:${row.target_module}`, [row.source_module, row.target_module]);
    }
    return [...seen.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }

  create_linkset(link_module: number, source_module: number, target_module: number): void {
    this.transaction(() => {
      if (this.item(link_module).kind !== "link") throw new StoreError("linksets belong to a link module");
      for (const end of [source_module, target_module]) {
        if (this.item(end).kind !== "formal") throw new StoreError("a linkset joins two formal modules");
      }
      if (this.linksets(link_module).some(([a, b]) => a === source_module && b === target_module)) {
        throw new StoreError("that linkset already exists");
      }
      this._require(link_module, RIGHTS.create, "create a linkset");
      const row = this._items.get(link_module)!;
      this._assign(row, "linksets", [...row.linksets ?? [], [source_module, target_module]]);
      this.total_changes += 1;
    });
  }

  // Deleting a linkset deletes the links in it.
  delete_linkset(link_module: number, source_module: number, target_module: number): void {
    this.transaction(() => {
      if (!this.linksets(link_module).some(([a, b]) => a === source_module && b === target_module)) {
        throw new StoreError("there is no such linkset");
      }
      this._require(link_module, RIGHTS.delete, "delete a linkset");
      for (const row of [...this._links.values()]) {
        if (row.link_module === link_module && row.source_module === source_module
            && row.target_module === target_module) {
          this.delete_link(new Link(row.id, link_module, new Obj(source_module, row.source_absno),
                                    new Obj(target_module, row.target_absno)));
        }
      }
      const row = this._items.get(link_module)!;
      this._assign(row, "linksets",
        (row.linksets ?? []).filter(([a, b]) => a !== source_module || b !== target_module));
      this.total_changes += 1;
    });
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
      this._require(source, RIGHTS.modify, "create a link");
      const covering = this.descriptors_between(source.module_id, target.module_id);
      let module: number;
      if (link_module === null && new Set(covering.map((c) => c.module)).size === 1) {
        module = covering[0].module;
      } else if (link_module === null && this.default_link_name !== null) {
        module = this._user_default_module(source.module_id);
      } else if (link_module === null) {
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
      const bound = covering.find((c) => !c.descriptor.overridable);
      if (bound && module !== bound.module) {
        throw new StoreError(`links from ${this.path(source.module_id)} to ${this.path(target.module_id)} must go `
          + `through ${this.path(bound.module)}: its link module descriptor is not overridable`);
      }
      this._require(module, _DATA_RIGHTS, "create a link through a link module");
      const folder = this.item(source.module_id).parent!;
      if (this.links_exclusive(folder, source.module_id) && !covering.some((c) => c.module === module)) {
        throw new StoreError(`links out of ${this.path(source.module_id)} are limited to its link module `
          + `descriptors, and none allows this one through ${this.path(module)}`);
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
      this._require(link.source, RIGHTS.modify, "delete a link");
      this._require(link.link_module, _DATA_RIGHTS, "delete a link through a link module");
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
        if (by_hand) this._require(link.source, RIGHTS.modify, "clear a suspect link");
        this._assign(row, "reviewed_seq", this._seq);
        if (by_hand) this._assign(row, "cleared", true);
        this.total_changes += 1;
      }
    });
  }

  // =====================================================================
  // Access rights
  //
  // Rights are inherited down the tree: root, folders, modules, objects. The
  // root gives everyone everything. There is no list of users or groups here,
  // so a name that is not the current user's may be a group the user is in.
  // Nothing may take away reading, so only changes have to be checked.
  // =====================================================================

  _access_row(thing: Guarded): { access?: AccessEntry[] } {
    if (thing instanceof Obj) return this._object_row(thing);
    const row = this._items.get(thing);
    if (!row) throw new StoreError(`no item with id ${thing}`);
    return row;
  }

  // The list that applies to a thing: its own or the nearest inherited one.
  access_list(thing: Guarded): AccessEntry[] {
    const own = this._access_row(thing).access;
    if (own) return own.map((e) => ({ ...e }));
    if (thing instanceof Obj) return this.access_list(this.parent_object(thing) ?? thing.module_id);
    const row = this._items.get(thing)!;
    const up = row.baseline_of ?? row.parent;
    return up === null ? [{ name: null, rights: ALL_RIGHTS }] : this.access_list(up);
  }

  is_access_inherited(thing: Guarded): boolean {
    return this._access_row(thing).access === undefined && thing !== ROOT;
  }

  // Whether the current user has every one of `rights`: "unknown" when that
  // depends on which groups the user belongs to.
  may(thing: Guarded, rights: number): "yes" | "no" | "unknown" {
    if (!this._guarded) return "yes";
    return this._decide(this.access_list(thing), rights);
  }

  // A name in a list that the directory does not hold may be a group the
  // current user is in; one it does hold is settled by it.
  _decide(list: AccessEntry[], rights: number, directory: Directory = this.directory): "yes" | "no" | "unknown" {
    const mine = list.find((e) => e.name === this.user);
    const has = (e: AccessEntry | undefined) => ((e?.rights ?? 0) & rights) === rights;
    if (mine) return has(mine) ? "yes" : "no";
    const everyone = list.find((e) => e.name === null);
    const group_of = (name: string | null) => directory.groups.find((g) => g.name === name);
    const in_groups = list.filter((e) => group_of(e.name)?.members.includes(this.user));
    // names that may or may not be groups of the current user's
    const named = list.filter((e) => e.name !== null && !group_of(e.name)
      && !directory.users.some((u) => u.name === e.name));
    if (in_groups.length) {
      const sure = in_groups.reduce((sum, e) => sum | e.rights, 0);
      if ((sure & rights) === rights) return "yes";
      const most = named.reduce((sum, e) => sum | e.rights, sure);
      return (most & rights) === rights ? "unknown" : "no";
    }
    // in none of the named groups, the entry for everyone else; in some, their rights together
    if (has(everyone) && named.every(has)) return "yes";
    const together = named.reduce((sum, e) => sum | e.rights, 0);
    return !has(everyone) && (together & rights) !== rights ? "no" : "unknown";
  }

  _require(thing: Guarded, rights: number, doing: string): void {
    if (!this._guarded) return;
    const list = this.access_list(thing);
    const answer = this._decide(list, rights);
    if (answer === "yes") return;
    const what = thing instanceof Obj ? this.identifier(thing) : this.path(thing);
    const need = rights_names(rights).join(", ");
    if (answer === "no") {
      throw new StoreError(`no access: ${doing} needs ${need} access to ${what}, which ${this.user} does not have`);
    }
    const names = list.filter((e) => e.name !== null).map((e) => _repr(e.name)).join(", ");
    throw new StoreError(`cannot ${doing}: whether ${this.user} has ${need} access to ${what} depends on belonging `
      + `to ${names}; give ${this.user} an entry to say`);
  }

  // Whether there is anything in a module the current user may certainly change.
  may_edit(module_id: number): boolean {
    if (!this._guarded) return true;
    const changes = [RIGHTS.modify, RIGHTS.create, RIGHTS.delete];
    const on = (thing: Guarded) => changes.some((right) => this.may(thing, right) === "yes");
    return on(module_id) || this.objects(module_id, true).some((obj) => on(obj));
  }

  // every thing at and below an item must allow it
  _require_within(item_id: number, rights: number, doing: string): void {
    if (!this._guarded) return;
    this._require(item_id, rights, doing);
    for (const obj of this._modules.has(item_id) ? this.objects(item_id, true) : []) {
      if (this._object_row(obj).access) this._require(obj, rights, doing);
    }
    for (const child of this._item_children.get(item_id) ?? []) this._require_within(child, rights, doing);
  }

  _set_access_list(thing: Guarded, list: AccessEntry[] | undefined): void {
    if (thing === ROOT) throw new StoreError("the access rights of the database root cannot be changed here");
    const module = thing instanceof Obj ? thing.module_id : thing;
    this._writable(module);
    if (list) this._acceptable(list);
    this._assign(this._access_row(thing), "access", list);
    this._stamp(module);
    this.total_changes += 1;
  }

  // Refuse a list this suite cannot hold; from then on changes are checked.
  _acceptable(list: AccessEntry[]): void {
    if (!list.some((e) => e.rights & RIGHTS.control)) {
      throw new StoreError("access rights in which nobody has control are not supported here");
    }
    if (this._decide(list, RIGHTS.read) !== "yes") {
      throw new StoreError(`access rights under which ${this.user} might not be able to read are not supported `
        + "here: nothing can be hidden");
    }
    const before = this._guarded;
    this._guarded = true;
    this._undo(() => { this._guarded = before; });
  }

  // For something with a list of its own inside a module or object (an
  // attribute definition, its values, a view), both have to allow a change.
  _require_both(own: AccessEntry[] | undefined, thing: Guarded, rights: number, doing: string, what: string): void {
    if (!this._guarded) return;
    if (!own) return this._require(thing, rights, doing);
    const answer = this._decide(own, rights);
    if (answer === "no") {
      throw new StoreError(`no access: ${doing} needs ${rights_names(rights).join(", ")} access to ${what}, which `
        + `${this.user} does not have`);
    }
    if (answer === "unknown") {
      throw new StoreError(`cannot ${doing}: whether ${this.user} has access to ${what} depends on named groups; `
        + `give ${this.user} an entry to say`);
    }
    if (this.may(thing, rights) !== "yes") {
      throw new StoreError(`cannot ${doing}: ${what} allows it and what holds it does not, and which DOORS goes `
        + "by is not documented");
    }
  }

  attribute_access(module_id: number, name: string, part: AttrPart): { entries: AccessEntry[]; inherited: boolean } {
    const row = this._modules.get(module_id)?.defs.get(name);
    if (!row) throw new StoreError(`no attribute ${_repr(name)}`);
    const own = row[_PART[part]];
    return { entries: own ? own.map((e) => ({ ...e })) : this.access_list(module_id), inherited: !own };
  }

  // `change` gets the thing's own list (undefined while inherited) and answers
  // the new one. Needs control access.
  change_attribute_access(module_id: number, name: string, part: AttrPart,
    change: (own: AccessEntry[] | undefined, effective: AccessEntry[]) => AccessEntry[] | undefined): void {
    this.transaction(() => {
      this._writable(module_id);
      const { entries, inherited } = this.attribute_access(module_id, name, part);
      this._require_control(entries, _repr(name));
      const next = change(inherited ? undefined : entries, entries);
      if (next) this._acceptable(next);
      const data = this._modules.get(module_id)!;
      const row = { ...data.defs.get(name)! };
      if (next) row[_PART[part]] = next;
      else delete row[_PART[part]];
      this._put(data.defs, name, row);
      this._stamp(module_id);
      this.total_changes += 1;
    });
  }

  _require_control(entries: AccessEntry[], what: string): void {
    if (!this._guarded) return;
    const answer = this._decide(entries, RIGHTS.control);
    if (answer === "no") throw new StoreError(`no access: changing access rights needs control access to ${what}`);
    if (answer === "unknown") {
      throw new StoreError(`cannot change access rights: whether ${this.user} controls ${what} depends on named `
        + "groups not known here");
    }
  }

  view_access(module_id: number, name: string): { entries: AccessEntry[]; inherited: boolean } {
    const view = this.views(module_id).get(name);
    if (!view) throw new StoreError(`there is no saved view ${_repr(name)}`);
    return { entries: view.access ?? this.access_list(module_id), inherited: !view.access };
  }

  change_view_access(module_id: number, name: string,
    change: (own: AccessEntry[] | undefined, effective: AccessEntry[]) => AccessEntry[] | undefined): void {
    this.transaction(() => {
      this._writable(module_id);
      const { entries, inherited } = this.view_access(module_id, name);
      this._require_control(entries, `the view ${_repr(name)}`);
      const next = change(inherited ? undefined : entries, entries);
      if (next) this._acceptable(next);
      const definition = this.views(module_id).get(name);
      if (next) definition.access = next;
      else delete definition.access;
      this._put(this._modules.get(module_id)!.views, name, JSON.stringify(definition));
      this.total_changes += 1;
    });
  }

  // Give a thing a list of its own, the same as the one it inherits.
  make_access_specific(thing: Guarded): void {
    this.transaction(() => {
      this._require(thing, RIGHTS.control, "change access rights");
      if (this._access_row(thing).access === undefined) this._set_access_list(thing, this.access_list(thing));
    });
  }

  make_access_inherited(thing: Guarded): void {
    this.transaction(() => {
      this._require(thing, RIGHTS.control, "change access rights");
      if (this._access_row(thing).access !== undefined) {
        this._set_access_list(thing, undefined);
        if (this.may(thing, RIGHTS.read) !== "yes") throw new StoreError("nothing can be hidden here");
      }
    });
  }

  _own_access(thing: Guarded): AccessEntry[] {
    this._require(thing, RIGHTS.control, "change access rights");
    const own = this._access_row(thing).access;
    if (!own) throw new StoreError("the access rights are inherited; make them specific first");
    return own;
  }

  set_access(thing: Guarded, name: string | null, rights: number): void {
    this.transaction(() => {
      const others = this._own_access(thing).filter((e) => e.name !== name);
      this._set_access_list(thing, [...others, { name, rights: closed_rights(rights) }]);
    });
  }

  // Remove one name's entry; `name` null removes every entry but everyone else's.
  unset_access(thing: Guarded, name: string | null): void {
    this.transaction(() => {
      const own = this._own_access(thing);
      if (name !== null && !own.some((e) => e.name === name)) {
        throw new StoreError(`there is no access entry for ${_repr(name)}`);
      }
      this._set_access_list(thing, own.filter((e) => name === null ? e.name === null : e.name !== name));
    });
  }

  // A whole list at once, as a file being loaded gives it.
  restore_access(thing: Guarded, list: AccessEntry[]): void {
    this.transaction(() => {
      this._require(thing, RIGHTS.control, "change access rights");
      this._set_access_list(thing, list.map((e) => ({ name: e.name, rights: closed_rights(e.rights) })));
    });
  }

  // What a Database Manager does for a list that has shut everyone present out.
  // Not checked, and for no script: the interface may offer it.
  reset_access(thing: Guarded): void {
    this.transaction(() => this._set_access_list(thing, undefined));
  }

  // The lists held by attribute definitions and views.
  _inner_lists(): AccessEntry[][] {
    return [...this._modules.values()].flatMap((m) => [
      ...[...m.defs.values()].flatMap((d) => [d.def_access, d.val_access].filter(Boolean) as AccessEntry[][]),
      ...[...m.views.values()].flatMap((json) => { const held = JSON.parse(json).access; return held ? [held] : []; }),
    ]);
  }

  // Replace the users and groups, as saveDirectory does.
  set_directory(next: Directory): void {
    this.transaction(() => {
      if (this._guarded) {
        const things = [...this._items.values(), ...[...this._modules.values()].flatMap((m) => [...m.objects.values()])];
        for (const access of [...things.map((t) => t.access), ...this._inner_lists()]) {
          if (access && this._decide(access, RIGHTS.read, next) !== "yes") {
            throw new StoreError(`a change of groups under which ${this.user} might not be able to read something `
              + "is not supported here: nothing can be hidden");
          }
        }
      }
      const old = this.directory;
      this.directory = JSON.parse(JSON.stringify(next));
      this._undo(() => { this.directory = old; });
      this.total_changes += 1;
    });
  }

  // =====================================================================
  // Triggers
  //
  // The person's own actions at the interface fire them (by_hand). Whether a
  // script, an import, or anything else the database does for itself fires a
  // trigger is not documented, so those stop where one would apply.
  // =====================================================================

  by_hand<T>(work: () => T): T {
    const before = this._by_hand;
    this._by_hand = true;
    try {
      return work();
    } finally {
      this._by_hand = before;
    }
  }

  // The triggers a thing holds itself.
  own_triggers(at: number): Trigger[] {
    return (this._items.get(at)?.triggers ?? []).map((row) => ({ at, row }));
  }

  // Those that reach a module: its own, and those of the projects around it.
  _reaching(module_id: number): Trigger[] {
    const module = this._items.get(module_id);
    if (!module || module.baseline_of !== null) return [];
    const out = this.own_triggers(module_id);
    if (module.kind === "formal") {
      for (let at = module.parent; at !== null; at = this._items.get(at)!.parent) out.push(...this.own_triggers(at));
    } else {
      // a link module is not a formal one: only a trigger naming no kind reaches it
      for (let at = module.parent; at !== null; at = this._items.get(at)!.parent) {
        out.push(...this.own_triggers(at).filter((t) => t.row.level === "module" && !t.row.formal));
      }
    }
    return out;
  }

  triggers_for(module_id: number, level: string, event: string, absno: number | null = null,
    attribute: string | null = null): Trigger[] {
    return this._reaching(module_id).filter((t) => trigger_covers(t.row, level, event, absno, attribute));
  }

  // Stop, because something a trigger watches is about to happen by a path
  // for which firing is not documented.
  refuse_triggered(about: { module: number; absno?: number | null; attribute?: string | null },
    level: string, event: string, doing: string): void {
    const [found] = this.triggers_for(about.module, level, event, about.absno ?? null, about.attribute ?? null);
    if (!found) return;
    throw new StoreError(`${doing} is not offered here while the trigger ${_repr(found.row.name)} watches it: `
      + "whether DOORS fires the trigger for this is not documented (it fires here for changes made in the "
      + "interface)");
  }

  // Run the triggers for something the person is doing. A pre trigger that
  // does not pass stops it.
  fire(when: "pre" | "post", level: string, event: string, context: TriggerContext): void {
    const found = this.triggers_for(context.module, level, event, context.absno, context.attribute)
      .filter((t) => t.row.when === when);
    if (!found.length) return;
    const engine = Store.trigger_engine;
    if (!engine) throw new StoreError("triggers are not offered here without the DXL engine");
    found.sort((a, b) => a.row.priority - b.row.priority);
    for (let i = 1; i < found.length; i++) {
      if (found[i].row.priority === found[i - 1].row.priority) {
        throw new StoreError(`the triggers ${_repr(found[i - 1].row.name)} and ${_repr(found[i].row.name)} have `
          + "the same priority, and the order DOORS then runs them in is not documented");
      }
    }
    const by_hand = this._by_hand;
    this._by_hand = false; // what the trigger's own DXL does is a script's doing
    try {
      for (const [i, trigger] of found.entries()) {
        if (!engine.run(this, trigger, context)) {
          throw new StoreError(`the trigger ${_repr(trigger.row.name)} did not allow this`
            + (i + 1 < found.length ? " (the triggers after it were not run here)" : ""));
        }
      }
    } finally {
      this._by_hand = by_hand;
    }
  }

  // The person opens a module, or makes an object current. `work` is what
  // happens between the pre and the post triggers.
  user_event<T>(level: "module" | "object", event: "open" | "sync", module_id: number, absno: number | null,
    work: () => T): T {
    const context = { module: module_id, absno, attribute: null, value: null };
    return this.transaction(() => this.by_hand(() => {
      this.fire("pre", level, event, context);
      const out = work();
      this.fire("post", level, event, context);
      return out;
    }));
  }

  add_trigger(at: number, row: TriggerRow): void {
    this.transaction(() => {
      this._require(at, RIGHTS.modify, "create a trigger");
      const held = this._items.get(at)!;
      if (held.baseline_of !== null) throw new StoreError("a baseline cannot be changed");
      const same = (o: TriggerRow) => o.name === row.name && o.level === row.level && o.when === row.when
        && o.event === row.event && o.priority === row.priority && o.attribute === row.attribute
        && o.absno === row.absno;
      if (held.triggers?.some(same)) {
        throw new StoreError(`there is already a trigger ${_repr(row.name)} like this; what defining it again does `
          + "is not documented, so delete it first");
      }
      this._assign(held, "triggers", [...held.triggers ?? [], { ...row }]);
      this._stamp(at);
      this.total_changes += 1;
    });
  }

  delete_trigger(at: number, row: TriggerRow): void {
    this.transaction(() => {
      this._require(at, RIGHTS.modify, "delete a trigger");
      const held = this._items.get(at)!;
      const left = (held.triggers ?? []).filter((o) => o !== row);
      if (left.length === (held.triggers ?? []).length) throw new StoreError("that trigger no longer exists");
      this._assign(held, "triggers", left.length ? left : undefined);
      this._stamp(at);
      this.total_changes += 1;
    });
  }

  // Every item holding triggers, for loops and project files.
  trigger_holders(): number[] {
    return [...this._items.values()].filter((i) => i.baseline_of === null && i.triggers?.length).map((i) => i.id);
  }

  _unwatched(module_id: number, attribute: string, doing: string): void {
    const found = this._reaching(module_id).find((t) => t.row.attribute === attribute);
    if (found) {
      throw new StoreError(`${doing} ${_repr(attribute)} is not offered here while the trigger `
        + `${_repr(found.row.name)} names it`);
    }
  }

  // =====================================================================
  // Link module descriptors
  // =====================================================================

  link_descriptors(folder_id: number): LinkDescriptor[] {
    return (this._items.get(folder_id)?.descriptors ?? []).map((d) => ({ ...d }));
  }

  _descriptor_folder(folder_id: number): _ItemRow {
    const item = this.item(folder_id);
    if (folder_id === ROOT || (item.kind !== "folder" && item.kind !== "project")) {
      throw new StoreError("link module descriptors belong to a folder or project below the database root");
    }
    this._require(folder_id, _DATA_RIGHTS, "change link module descriptors");
    return this._items.get(folder_id)!;
  }

  add_link_descriptor(folder_id: number, descriptor: LinkDescriptor, description: string = ""): void {
    this.transaction(() => {
      const row = this._descriptor_folder(folder_id);
      const { source, target, linkmod } = descriptor;
      // the modules named need not exist yet; a source that does must be in this folder
      const from = this.find(source, folder_id);
      if (!source || !target || !linkmod) throw new StoreError("a descriptor names a source, target and link module");
      if (from !== null && (this.item(from).kind !== "formal" || this.item(from).parent !== folder_id)) {
        throw new StoreError(`${_repr(source)} is not a formal module in ${this.path(folder_id)}`);
      }
      if ((row.descriptors ?? []).some((d) => d.source === source && d.target === target)) {
        throw new StoreError(`there is already a descriptor for ${_repr(source)} and ${_repr(target)}`);
      }
      if (this.module_at(linkmod, "link", folder_id) === null) {
        const slash = linkmod.lastIndexOf("/");
        const parent = slash < 0 ? folder_id : this.find(linkmod.slice(0, slash) || "/", folder_id);
        if (parent === null) throw new StoreError(`no folder for link module ${_repr(linkmod)}`);
        this.create_link_module(this.path(parent), linkmod.slice(slash + 1), description);
      }
      this._assign(row, "descriptors", [...row.descriptors ?? [], { ...descriptor }]);
      this._stamp(folder_id);
      this.total_changes += 1;
    });
  }

  remove_link_descriptor(folder_id: number, source: string, target: string): void {
    this.transaction(() => {
      const row = this._descriptor_folder(folder_id);
      const at = (row.descriptors ?? []).findIndex((d) => d.source === source && d.target === target);
      if (at < 0) throw new StoreError(`no descriptor for ${_repr(source)} and ${_repr(target)}`);
      this._assign(row, "descriptors", row.descriptors!.filter((_, i) => i !== at));
      this._stamp(folder_id);
      this.total_changes += 1;
    });
  }

  set_link_descriptor(folder_id: number, source: string, target: string,
                      changes: { overridable?: boolean; mandatory?: boolean }): void {
    this.transaction(() => {
      const row = this._descriptor_folder(folder_id);
      const found = (row.descriptors ?? []).find((d) => d.source === source && d.target === target);
      if (!found) throw new StoreError(`no descriptor for ${_repr(source)} and ${_repr(target)}`);
      this._assign(row, "descriptors", row.descriptors!.map((d) => d === found ? { ...d, ...changes } : d));
      this.total_changes += 1;
    });
  }

  // Whether links out of a module in the folder are limited to its descriptors.
  links_exclusive(folder_id: number, module_id: number): boolean {
    return this._items.get(folder_id)?.exclusive?.includes(module_id) ?? false;
  }

  set_links_exclusive(folder_id: number, module_id: number, flag: boolean): void {
    this.transaction(() => {
      const row = this._descriptor_folder(folder_id);
      if (this.item(module_id).parent !== folder_id || this.item(module_id).kind !== "formal") {
        throw new StoreError("the module is not a formal module of that folder");
      }
      const others = (row.exclusive ?? []).filter((m) => m !== module_id);
      this._assign(row, "exclusive", flag ? [...others, module_id] : others);
      this.total_changes += 1;
    });
  }

  // The descriptors that cover links from one module to another, with the ids
  // of their link modules.
  descriptors_between(source_module: number, target_module: number): { descriptor: LinkDescriptor; module: number }[] {
    const folder = this._items.get(source_module)?.parent;
    if (folder === null || folder === undefined) return [];
    const out: { descriptor: LinkDescriptor; module: number }[] = [];
    for (const descriptor of this.link_descriptors(folder)) {
      const module = this.module_at(descriptor.linkmod, "link", folder);
      if (module !== null && this.find(descriptor.source, folder) === source_module
          && this.find(descriptor.target, folder) === target_module) {
        out.push({ descriptor, module });
      }
    }
    return out;
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

  // A module copied beside itself under a new name. Outgoing links are copied,
  // incoming links and baselines are not. What the manuals leave open (deleted
  // objects, links inside the module, access rights of its own) stops it.
  copy_module(module_id: number, name: string, description: string): number {
    return this.transaction(() => {
      const row = this._items.get(module_id);
      if (!row || row.kind !== "formal" || row.baseline_of !== null) {
        throw new StoreError("only formal modules are copied here");
      }
      this._require(row.parent!, RIGHTS.create, "copy a module");
      if (row.triggers?.length) {
        throw new StoreError("copying a module that holds triggers is not offered here: whether the copy takes them "
          + "is not documented");
      }
      if (!name || name.includes("/") || name === "." || name === "..") {
        throw new StoreError(`not a usable name: ${_repr(name)}`);
      }
      if (this._names.get(row.parent!)?.has(name)) throw new StoreError(`${_repr(name)} already exists`);
      const objects = this.objects(module_id, true);
      if (objects.some((o) => this.is_deleted(o))) {
        throw new StoreError("whether a module copy takes deleted objects is not documented: purge them first");
      }
      if (row.access || objects.some((o) => this._object_row(o).access)) {
        throw new StoreError("what access rights a module copy takes is not documented");
      }
      const outgoing: _LinkRow[] = [];
      for (const obj of objects) {
        for (const id of this._outgoing.get(obj.key) ?? []) outgoing.push(this._links.get(id)!);
      }
      if (outgoing.some((link) => link.target_module === module_id)) {
        throw new StoreError("where a copy of a link inside the module then points is not documented");
      }
      const { sessions: _sessions, ...kept } = row;
      const copy = this._insert_item({
        ...kept, id: this._max_item + 1, name, description, created_by: this.user, created_on: this.now(),
      });
      this._copy_content(module_id, copy);
      const views = this._data(module_id).views;
      for (const [view, held] of views) this._put(this._data(copy).views, view, structuredClone(held));
      for (const link of outgoing.sort((a, b) => a.source_absno - b.source_absno || a.id - b.id)) {
        this._insert_link({ ...link, id: this._max_link + 1, source_module: copy });
      }
      return copy;
    });
  }

  create_baseline(module_id: number, annotation: string = "", major: boolean = false,
                  suffix: string = ""): Baseline {
    return this.transaction(() => {
      this._writable(module_id);
      const item = this.item(module_id);
      if (item.kind !== "formal") throw new StoreError("only formal modules are baselined");
      this._require(module_id, RIGHTS.modify, "create a baseline");
      const existing = this.baselines(module_id);
      const number = _next_version(existing[existing.length - 1], major);
      const stamp = this.now();
      const { access: _access, sessions: _sessions, ...frozen } = this._items.get(module_id)!;
      const copy = this._insert_item({
        ...frozen, id: this._max_item + 1, deleted: 0, baseline_of: module_id,
        major: number[0], minor: number[1], suffix, annotation, created_by: this.user, created_on: stamp,
      });
      this._copy_content(module_id, copy);
      const from = this._data(module_id);
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

  // =====================================================================
  // History sessions: one for each time a module is opened for editing.
  // Not counted as a change to the data.
  // =====================================================================

  record_session(module_id: number): void {
    this.transaction(() => {
      const row = this._items.get(module_id);
      if (!row || row.baseline_of !== null) throw new StoreError("only a current module has history sessions");
      this._assign(row, "sessions", [...row.sessions ?? [], { user: this.user, date: this.now() }]);
    });
  }

  sessions(module_id: number): { number: number; user: string; date: string }[] {
    return (this._items.get(module_id)?.sessions ?? []).map((s, number) => ({ number, ...s }));
  }

  // =====================================================================
  // The configuration area (see dxl/lib/conf.ts)
  // =====================================================================

  conf_entry(key: string): string | null | undefined {
    return this._conf.get(key);
  }

  conf_below(key: string): boolean {
    return [...this._conf.keys()].some((k) => k.startsWith(key + "/"));
  }

  set_conf_entry(key: string, text: string | null): void {
    this.transaction(() => {
      this._put(this._conf, key, text);
      this.total_changes += 1;
    });
  }

  delete_conf_entry(key: string): void {
    this.transaction(() => {
      if (this._drop(this._conf, key)) this.total_changes += 1;
    });
  }

  // =====================================================================
  // Baseline sets
  // =====================================================================

  // The definitions a folder holds, without modules or baselines since purged.
  set_definitions(folder_id: number): SetDefinition[] {
    const held = this._items.get(folder_id)?.baseline_sets ?? [];
    return held.map((d) => ({ ...d, modules: d.modules.filter((m) => this._items.has(m)),
      sets: d.sets.map((s) => ({ ...s, members: s.members.filter((m) => this._items.has(m)) })) }));
  }

  set_definition(folder_id: number, id: number): SetDefinition {
    const found = this.set_definitions(folder_id).find((d) => d.id === id);
    if (!found) throw new StoreError("the baseline set definition no longer exists");
    return found;
  }

  // every [folder, definition] in the database
  all_set_definitions(): [number, SetDefinition][] {
    return [...this._items.values()].filter((row) => row.baseline_sets)
      .flatMap((row) => this.set_definitions(row.id).map((d): [number, SetDefinition] => [row.id, d]));
  }

  _change_set_definitions(folder_id: number, change: (held: SetDefinition[]) => void): void {
    const item = this.item(folder_id);
    if (item.kind !== "folder" && item.kind !== "project" && folder_id !== ROOT) {
      throw new StoreError("baseline set definitions are held by a folder or project");
    }
    this._writable(folder_id);
    const held: SetDefinition[] = structuredClone(this._items.get(folder_id)!.baseline_sets ?? []);
    change(held);
    this._assign(this._items.get(folder_id)!, "baseline_sets", held.length ? held : undefined);
    this.total_changes += 1;
  }

  _in_definition(folder_id: number, id: number, change: (d: SetDefinition) => void): void {
    this._change_set_definitions(folder_id, (held) => {
      const found = held.find((d) => d.id === id);
      if (!found) throw new StoreError("the baseline set definition no longer exists");
      change(found);
    });
  }

  _check_definition(folder_id: number, held: SetDefinition[], id: number, name: string, modules: number[]): void {
    if (!name || name.includes("/") || name === "." || name === "..") {
      throw new StoreError(`not a usable name: ${_repr(name)}`);
    }
    if (held.some((d) => d.id !== id && d.name === name)) {
      throw new StoreError(`there is already a baseline set definition called ${_repr(name)}`);
    }
    for (const module of modules) {
      if (this.item(module).kind !== "formal" || this.is_baseline(module)) {
        throw new StoreError("a baseline set definition names formal modules");
      }
      let up: number | null = module;
      while (up !== null && up !== folder_id) up = this._items.get(up)!.parent;
      if (up === null && folder_id !== ROOT) {
        throw new StoreError(`${this.path(module)} is outside the definition's folder, which is not supported here`);
      }
    }
  }

  create_set_definition(folder_id: number, name: string, description: string = "", modules: number[] = []): number {
    return this.transaction(() => {
      this._require(folder_id, RIGHTS.create, "create a baseline set definition");
      let id = 0;
      this._change_set_definitions(folder_id, (held) => {
        id = held.reduce((most, d) => Math.max(most, d.id), 0) + 1;
        this._check_definition(folder_id, held, id, name, modules);
        held.push({ id, name, description, modules: [...new Set(modules)], sets: [] });
      });
      return id;
    });
  }

  update_set_definition(folder_id: number, id: number,
                        wanted: { name: string; description: string; modules: number[] }): void {
    this.transaction(() => {
      this._require(folder_id, RIGHTS.modify, "change a baseline set definition");
      this._change_set_definitions(folder_id, (held) => {
        const found = held.find((d) => d.id === id);
        if (!found) throw new StoreError("the baseline set definition no longer exists");
        this._check_definition(folder_id, held, id, wanted.name, wanted.modules);
        found.name = wanted.name;
        found.description = wanted.description;
        found.modules = [...new Set(wanted.modules)];
      });
    });
  }

  delete_set_definition(folder_id: number, id: number): void {
    this.transaction(() => {
      this._require(folder_id, RIGHTS.delete, "delete a baseline set definition");
      if (this.set_definition(folder_id, id).sets.length) {
        throw new StoreError("deleting a definition that has baseline sets is not supported here");
      }
      this._change_set_definitions(folder_id, (held) => { held.splice(held.findIndex((d) => d.id === id), 1); });
    });
  }

  // A new open set: the next major or minor number after the definition's last.
  create_baseline_set(folder_id: number, id: number, major: boolean, suffix: string = "",
                      annotation: string = ""): number {
    return this.transaction(() => {
      this._require(folder_id, RIGHTS.create, "create a baseline set");
      let index = 0;
      this._in_definition(folder_id, id, (d) => {
        if (d.sets.some((s) => s.open)) throw new StoreError("there is already an open baseline set");
        const [major_number, minor] = _next_version(d.sets[d.sets.length - 1], major);
        index = d.sets.length;
        d.sets.push({ major: major_number, minor, suffix, annotation, open: true, user: this.user,
          date: this.now(), members: [] });
      });
      return index;
    });
  }

  _open_set(d: SetDefinition, index: number): BaselineSetRow {
    const set = d.sets[index];
    if (!set) throw new StoreError("there is no such baseline set");
    if (!set.open) throw new StoreError("the baseline set is closed");
    return set;
  }

  close_baseline_set(folder_id: number, id: number, index: number): void {
    this.transaction(() => {
      this._require(folder_id, RIGHTS.modify, "close a baseline set");
      this._in_definition(folder_id, id, (d) => { this._open_set(d, index).open = false; });
    });
  }

  // Baseline modules into an open set. DOORS' version for such a baseline is
  // not documented, so it is only done where the set's number and the module's
  // own next number agree.
  add_to_baseline_set(folder_id: number, id: number, index: number, modules: number[]): void {
    this.transaction(() => {
      this._require(folder_id, RIGHTS.modify, "add to a baseline set");
      this._in_definition(folder_id, id, (d) => {
        const set = this._open_set(d, index);
        const present = new Set(set.members.map((m) => this._items.get(m)?.baseline_of));
        for (const module of modules) {
          if (!d.modules.includes(module)) {
            throw new StoreError(`${this.path(module)} is not in the baseline set definition`);
          }
          if (present.has(module)) throw new StoreError(`${this.path(module)} is already in the baseline set`);
          present.add(module);
        }
        for (const module of modules) {
          if (set.suffix) {
            throw new StoreError("whether the baselines in a set with a suffix take that suffix is not documented, "
              + "so adding to such a set is not supported here");
          }
          const existing = this.baselines(module);
          const major = set.minor === 0 && set.major > 0;
          const [own_major, own_minor] = _next_version(existing[existing.length - 1], major);
          if (own_major !== set.major || own_minor !== set.minor) {
            throw new StoreError(`${this.path(module)}: its own next baseline would be ${own_major}.${own_minor} and `
              + `the set is ${set.major}.${set.minor}; which number DOORS gives is not documented`);
          }
          set.members.push(this.create_baseline(module, "", major, "").copy_id);
        }
      });
    });
  }

  // the set holding a baseline, if any
  baseline_set_of(copy_id: number): { folder: number; id: number; index: number } | null {
    for (const [folder, d] of this.all_set_definitions()) {
      const index = d.sets.findIndex((s) => s.members.includes(copy_id));
      if (index >= 0) return { folder, id: d.id, index };
    }
    return null;
  }

  // A definition with its sets, as a file being loaded gives it.
  restore_set_definition(folder_id: number, definition: Omit<SetDefinition, "id">): void {
    this.transaction(() => {
      const id = this.create_set_definition(folder_id, definition.name, definition.description, definition.modules);
      this._in_definition(folder_id, id, (d) => { d.sets = structuredClone(definition.sets); });
    });
  }

  // types, definitions, module values and objects with their values
  _copy_content(source: number, copy: number): void {
    const from = this._data(source), to = this._data(copy);
    for (const [name, row] of from.types) this._put(to.types, name, { ...row, vals: [...row.vals] });
    for (const [name, row] of from.defs) this._put(to.defs, name, { ...row });
    for (const [name, value] of from.module_values) this._put(to.module_values, name, value);
    for (const [absno, row] of from.objects) this._put(to.objects, absno, { ...row });
    for (const [parent, list] of from.kids) {
      to.kids.set(parent, list.map((row) => to.objects.get(row.absno)!));
      this._undo(() => { to.kids.delete(parent); });
    }
    for (const [absno, held] of from.values) this._put(to.values, absno, new Map(held));
    for (const [absno, held] of from.rich) this._put(to.rich, absno, new Map(held));
    this.total_changes += from.types.size + from.defs.size + from.module_values.size + from.objects.size;
    for (const held of from.values.values()) this.total_changes += held.size;
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
      // a view saved over keeps its own access rights
      const old = this.views(module_id).get(name)?.access;
      this._require_both(old, module_id, _DATA_RIGHTS, "save a view", `the view ${_repr(name)}`);
      if (definition?.access) this._acceptable(definition.access);
      else if (old) definition = { ...definition, access: old };
      const json = JSON.stringify(definition, (_, v) => (v instanceof Map ? Object.fromEntries(v) : v));
      this._put(this._data(module_id).views, name, json);
      this.total_changes += 1;
    });
  }

  delete_view(module_id: number, name: string): void {
    this.transaction(() => {
      const held = this._modules.get(module_id)?.views;
      if (held?.has(name)) {
        this._require_both(this.views(module_id).get(name).access, module_id, _DATA_RIGHTS, "delete a view",
          `the view ${_repr(name)}`);
      }
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
      max_item: this._max_item,
      ...(this.default_link_name === null ? {} : { default_link_module: this.default_link_name }),
      ...(this._conf.size ? { conf: [...this._conf] } : {}),
      ...(this.directory.users.length || this.directory.groups.length ? { directory: this.directory } : {}),
      items: [...this._items.values()],
      modules: [...this._modules].map(([id, m]) => ({
        id,
        types: [...m.types],
        defs: [...m.defs],
        module_values: [...m.module_values],
        objects: [...m.objects.values()],
        values: [...m.values].map(([absno, held]) => [absno, [...held]]),
        ...([...m.rich.values()].some((held) => held.size)
          ? { rich: [...m.rich].filter(([, held]) => held.size).map(([absno, held]) => [absno, [...held]]) } : {}),
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
      m.rich = new Map((saved.rich ?? [])
        .map(([absno, held]: [number, [string, string][]]) => [absno, new Map(held)]));
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
    store._max_item = Math.max(store._max_item, data.max_item ?? 0);
    store.default_link_name = data.default_link_module ?? null;
    store._conf = new Map(data.conf ?? []);
    store.directory = data.directory ?? { users: [], groups: [] };
    store._guarded = [...store._items.values(), ...[...store._modules.values()].flatMap((m) => [...m.objects.values()])]
      .some((row) => row.access !== undefined) || store._inner_lists().length > 0;
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
