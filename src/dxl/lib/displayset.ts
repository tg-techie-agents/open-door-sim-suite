// What a module window would show: the filter marks and sort of each open module.
//
// Loops and navigation that DOORS ties to "the current display set" go through
// here. Where DOORS behaviour is not documented, the script is stopped with a
// message saying what to write instead; nothing is guessed.

import { parse_date } from "../../store.ts";
import type { Obj } from "../../store.ts";
import type { ViewColumn } from "../../views.ts";
import { Fault, ValueError, compare_text } from "../runtime.ts";
import type { Runtime } from "../runtime.ts";

export const SYSTEM_BASES = new Map<string, string>([
  ["Absolute Number", "Integer"], ["Created By", "String"], ["Created On", "Date"], ["Created Thru", "String"],
  ["Last Modified By", "String"], ["Last Modified On", "Date"]]);

// The view a module window has loaded, with whatever the script has since
// done to its columns (lib/views.ts).
export type ViewWindow = {
  name: string | null; // null: the loaded view has been deleted
  columns: ViewColumn[];
  in_links: boolean; // the interface's own link columns, kept for save()
  out_links: boolean;
};

export class Display {
  window: ViewWindow | null = null; // null: the Standard view, untouched
  marks: Map<string, boolean>; // Obj.key -> accepted
  filtered: boolean; // set(filter) has been applied
  filtering: boolean;
  ancestors: boolean | null; // null: the script has not said
  sort: Array<[string, boolean]>; // [[attribute name, descending], ...]
  sorting: boolean;
  explorer: boolean | null = null; // module explorer filtering; null: the script has not said

  constructor(marks: Map<string, boolean> = new Map(), filtered = false, filtering = false,
    ancestors: boolean | null = null, sort: Array<[string, boolean]> = [], sorting = false) {
    this.marks = marks;
    this.filtered = filtered;
    this.filtering = filtering;
    this.ancestors = ancestors;
    this.sort = sort;
    this.sorting = sorting;
  }
}

export function display(rt: Runtime, module_id: number): Display {
  let state = rt.displays.get(module_id);
  if (state === undefined) {
    state = new Display();
    rt.displays.set(module_id, state);
  }
  return state;
}

// [base type, enumeration values, multi-valued] of an object attribute.
export function definition(rt: Runtime, module_id: number, name: string): [string, string[], boolean] {
  const system = SYSTEM_BASES.get(name);
  if (system !== undefined) return [system, [], false];
  const found = rt.store.attribute(module_id, name);
  if (found === null || found === undefined || found.scope !== "object") {
    throw new Fault(`no object attribute ${_repr(name)} in ${rt.store.path(module_id)}`);
  }
  return [found.base, found.values, found.multi];
}

export function filtering(rt: Runtime, module_id: number): boolean {
  const state = rt.displays.get(module_id);
  return Boolean(state && state.filtering);
}

export function sorting(rt: Runtime, module_id: number): boolean {
  const state = rt.displays.get(module_id);
  return Boolean(state && state.sorting && state.sort && state.sort.length);
}

export function unfiltered_only(rt: Runtime, module_id: number, what: string): void {
  if (filtering(rt, module_id) || sorting(rt, module_id)) {
    throw new Fault(`${what} while filtering or sorting is on is not supported here (how DOORS `
      + "treats hidden or reordered objects is not documented); turn them off, or use "
      + "`for o in module`");
  }
}

// The objects (given in document order) the display set holds.
export function accepted_objects(rt: Runtime, module_id: number, objects: Obj[]): Obj[] {
  const state = rt.displays.get(module_id);
  if (state === undefined || state === null || !state.filtering) return Array.from(objects);
  const marks = state.marks;
  const unmarked = objects.filter((o) => !marks.has(o.key));
  if (unmarked.length) {
    throw new Fault(`${rt.store.identifier(unmarked[0])} was never filtered (it was neither accepted `
      + "nor rejected, or was created after set()); apply the filter again with set(), "
      + "or accept/reject every object");
  }
  const keep = new Set<string>();
  for (const o of objects) if (marks.get(o.key)) keep.add(o.key);
  const above = new Set<string>();
  for (const obj of objects) {
    if (!marks.get(obj.key)) continue;
    let up = rt.store.parent_object(obj);
    while (up !== null) {
      if (!marks.get(up.key)) above.add(up.key);
      up = rt.store.parent_object(up);
    }
  }
  if (above.size && state.ancestors === null) {
    throw new Fault("an accepted object has a rejected parent, and whether DOORS shows it depends "
      + "on the view: write ancestors(false) or ancestors(true) before filtering on");
  }
  if (state.ancestors) for (const key of above) keep.add(key);
  return objects.filter((o) => keep.has(o.key));
}

// The display set in display order.
export function arranged(rt: Runtime, module_id: number, objects: Obj[]): Obj[] {
  const shown = accepted_objects(rt, module_id, objects);
  if (!sorting(rt, module_id)) return shown;
  // stable sorts, last key first, give a compound sort
  for (const [name, descending] of Array.from(rt.displays.get(module_id)!.sort as Array<[string, boolean]>).reverse()) {
    const keys = sort_keys(rt, module_id, name, shown);
    // swapping the arguments keeps equal elements in order when sorting downwards
    shown.sort((a, b) => descending
      ? _compare(keys.get(b.key), keys.get(a.key))
      : _compare(keys.get(a.key), keys.get(b.key)));
  }
  return shown;
}

export function sort_keys(rt: Runtime, module_id: number, name: string, objects: Obj[]): Map<string, any> {
  const [base, values, multi] = definition(rt, module_id, name);
  if (multi) throw new Fault(`sorting on the multi-valued attribute ${_repr(name)} is not supported here`);
  const text = new Map<string, [Obj, string]>();
  for (const o of objects) text.set(o.key, [o, rt.store.value(o, name)]);
  for (const [obj, value] of text.values()) {
    if (value === "") {
      throw new Fault(`${rt.store.identifier(obj)} has no ${_repr(name)}; where DOORS sorts empty values `
        + "is not documented (filter them out first)");
    }
  }
  const keyed = (convert: (v: string) => any) =>
    new Map<string, any>(Array.from(text, ([key, [, v]]) => [key, convert(v)]));
  if (base === "Integer" || base === "Real") return keyed(_float);
  if (base === "Date") return keyed((v) => parse_date(v));
  const present = Array.from(new Set(Array.from(text.values(), ([, v]) => v)));
  if (base === "Enumeration") {
    const index = (v: string) => {
      const i = values.indexOf(v);
      if (i < 0) throw new ValueError(`${_repr(v)} is not in tuple`);
      return i;
    };
    const by_order = present.map((v): [number, string] => [index(v), v]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const by_name = _by_casefold(present);
    if (by_order.some((v, i) => v !== by_name[i])) {
      throw new Fault(`sorting on ${_repr(name)}: the enumeration order and the alphabetical order differ, `
        + "and which one DOORS uses is not documented");
    }
    return keyed(index);
  }
  const plain = Array.from(present).sort(compare_text);
  const folded = _by_casefold(present);
  if (plain.some((v, i) => v !== folded[i])) {
    throw new Fault(`sorting on ${_repr(name)}: the result depends on how upper and lower case are `
      + "ordered, which is not documented");
  }
  return new Map<string, any>(Array.from(text, ([key, [, v]]) => [key, v]));
}

// -- ordering and folding ----------------------------------------------------------

// sorted without regard to case
function _by_casefold(values: string[]): string[] {
  return values.map((v): [string, string] => [_casefold(v), v])
    .sort((a, b) => _compare(a[0], b[0])).map((p) => p[1]);
}

function _casefold(text: string): string {
  let out = "";
  for (const c of text) {
    if (c === "ı") out += c; // dotless i folds to itself
    else if (/[Ꭰ-ᏽꭰ-ꮿ]/.test(c)) out += c.toUpperCase(); // Cherokee folds upwards
    // final sigma folds to sigma
    else out += c.toLowerCase().toUpperCase().toLowerCase().replaceAll("ς", "σ");
  }
  return out;
}

// Ordering: strings by code point; numbers and dates by value.
function _compare(a: any, b: any): number {
  if (typeof a === "string") return compare_text(a, b);
  return a < b ? -1 : b < a ? 1 : 0;
}

// float(text)
function _float(text: string): number {
  const s = text.trim().replace(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    throw new ValueError(`could not convert string to float: ${_repr(text)}`);
  }
  return Number(s);
}

// repr(text)
function _repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const c of text) {
    if (c === "\\" || c === quote) out += "\\" + c;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c !== " " && /[\p{C}\p{Z}]/u.test(c)) {
      const n = c.codePointAt(0)!;
      const [letter, width] = n <= 0xff ? ["x", 2] : n <= 0xffff ? ["u", 4] : ["U", 8];
      out += "\\" + letter + n.toString(16).padStart(width as number, "0");
    } else out += c;
  }
  return quote + out + quote;
}
