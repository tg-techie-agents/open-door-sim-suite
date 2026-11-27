// Display filters and sorts: `set(attribute "A" == "v")`, `filtering on`,
// accept/reject, `sort`ing.
//
// A Filter is a test `fn(rt, object) -> bool`, run over the module when it is
// set. An attribute handle is the AttrName_ that `attribute "x"` already builds
// for attribute definitions (see management.ts).

import { check_end } from "./pending.ts";
import { parse_date, _SPACE, _ascii_digits, _repr, _strip } from "../../store.ts";
import { Fault } from "../runtime.ts";
import { current_module, shown } from "./database.ts";
import { definition, display } from "./displayset.ts";
import { translate_regexp } from "./text.ts";

export const COMPARE = new Map<string, (a: any, b: any) => boolean>([
  ["==", (a, b) => a === b], ["!=", (a, b) => a !== b], ["<", (a, b) => a < b], ["<=", (a, b) => a <= b],
  [">", (a, b) => a > b], [">=", (a, b) => a >= b]]);
export const LINK_FILTERS = new Map<string, boolean[]>([
  ["linkFilterIncoming", [true, false]], ["linkFilterOutgoing", [false, true]],
  ["linkFilterBoth", [true, true]]]); // (incoming, outgoing)

// str.casefold(), as displayset.ts does it
function casefold(text: string): string {
  let out = "";
  for (const c of text) {
    if (c === "\u0131") out += c; // dotless i folds to itself
    else if (/[\u13a0-\u13fd\uab70-\uabbf]/.test(c)) out += c.toUpperCase(); // Cherokee folds upwards
    // final sigma folds to sigma
    else out += c.toLowerCase().toUpperCase().toLowerCase().replaceAll("\u03c2", "\u03c3");
  }
  return out;
}

export function attribute_name(spec: Map<string, any>): string {
  if (!(spec.size === 1 && spec.has("name"))) {
    throw new Fault('a filter takes a plain attribute "name"');
  }
  return spec.get("name");
}

/** (base, enumeration values, multi, the object's text) for one attribute. */
export function look(rt: any, obj: any, name: string): [string, string[], boolean, string] {
  const [base, values, multi] = definition(rt, obj.module_id, name) as any;
  return [base, values, multi, rt.store.value(obj, name)];
}

// -- comparisons --------------------------------------------------------------

export function compare(rt: any, obj: any, name: string, op: string, wanted: string): boolean {
  const [base, values, multi, text] = look(rt, obj, name);
  const test = COMPARE.get(op)!;
  const ordering = op !== "==" && op !== "!=";
  if (multi) {
    throw new Fault(`${_repr(name)} is multi-valued: filter it with includes or excludes`);
  }
  if (base === "Integer" || base === "Real" || base === "Date") {
    const convert: (t: string) => any = base === "Date" ? parse_date : _number;
    if (wanted === "" && !ordering) {
      return test(text, "");
    }
    const goal = convert(wanted);
    if (goal === null) {
      throw new Fault(`${_repr(wanted)} is not a ${base} value for ${_repr(name)}`);
    }
    if (text === "") {
      if (ordering) {
        throw new Fault(`${rt.store.identifier(obj)} has no ${_repr(name)}; whether DOORS includes an `
          + `empty value in a ${op} filter is not documented (add notNull(attribute `
          + `"${name}") && first)`);
      }
      return op === "!=";
    }
    const value = convert(text);
    if (base === "Date") {
      // parse_date keeps the wall-clock time in the UTC fields
      const a = value.getTime(), b = goal.getTime();
      if (Math.floor(a / 86400000) === Math.floor(b / 86400000) && a !== b) {
        throw new Fault(`comparing a date with a time to ${_repr(wanted)} on the same day is not supported here`);
      }
      return test(a, b);
    }
    return test(value, goal);
  }
  if (ordering) {
    throw new Fault(`${op} on the ${base} attribute ${_repr(name)}: how DOORS orders these is not documented`);
  }
  if (base === "Enumeration" && wanted !== "" && !values.includes(wanted)) {
    throw new Fault(`${_repr(wanted)} is not a value of ${_repr(name)} (${values.join(", ")})`);
  }
  if (text !== wanted && casefold(text) === casefold(wanted)) {
    throw new Fault(`${_repr(name)}: ${_repr(text)} and ${_repr(wanted)} differ only in case, and whether the DOORS `
      + "filter minds is not documented");
  }
  return test(text, wanted);
}

const _NUMBER = new RegExp(`^[${_SPACE}]*[-+]?(\\p{Nd}+(\\.\\p{Nd}*)?|\\.\\p{Nd}+)([eE][-+]?\\p{Nd}+)?[${_SPACE}]*$`, "u");

export function _number(text: string): number | null {
  return _NUMBER.test(text) ? Number(_ascii_digits(_strip(text))) : null;
}

export function comparison(op: string): (rt: any, spec: any, wanted: string) => any {
  return (rt: any, spec: any, wanted: string) => {
    const name = attribute_name(spec);
    return (rt: any, obj: any) => compare(rt, obj, name, op, wanted);
  };
}

// -- text -----------------------------------------------------------------------

/** text -> bool. With caseSensitive omitted DOORS takes a regular expression
 * but does not say whether case counts: only answer when it would not matter. */
export function matcher(wanted: string, case_: boolean | null, use_regexp: boolean): (text: string) => boolean {
  if (case_ === null) {
    const sensitive = matcher(wanted, true, true), loose = matcher(wanted, false, true);
    return (text: string) => {
      if (sensitive(text) !== loose(text)) {
        throw new Fault(`the match for ${_repr(wanted)} depends on upper/lower case: pass true or false `
          + "as the caseSensitive argument");
      }
      return sensitive(text);
    };
  }
  if (use_regexp) {
    const source = translate_regexp(wanted);
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, case_ ? "u" : "iu");
    } catch (e: any) {
      throw new Fault(`regexp ${_repr(wanted)}: ${e.message}`);
    }
    return (text: string) => pattern.test(text);
  }
  if (case_) {
    return (text: string) => text.includes(wanted);
  }
  return (text: string) => casefold(text).includes(casefold(wanted));
}

export function contains(rt: any, spec: any, wanted: string, case_: boolean | null = null,
  use_regexp: boolean = false): any {
  const name = attribute_name(spec), matches = matcher(wanted, case_, use_regexp);
  return (rt: any, obj: any) => matches(look(rt, obj, name)[3]);
}

export function contents(rt: any, wanted: string, case_: boolean | null = null, use_regexp: boolean = false): any {
  const matches = matcher(wanted, case_, use_regexp);
  return (rt: any, obj: any) => {
    const names: string[] = rt.store.attributes(obj.module_id)
      .filter((a: any) => a.base === "String" || a.base === "Text").map((a: any) => a.name);
    if (names.some((n) => matches(rt.store.value(obj, n)))) {
      return true;
    }
    if (["Created By", "Last Modified By"].some((n) => matches(rt.store.value(obj, n)))) {
      throw new Fault(`${_repr(wanted)} matches only a user name; whether DOORS contents() searches those `
        + "is not documented: use contains(attribute ..)");
    }
    return false;
  };
}

export function empty_test(want_empty: boolean): (rt: any, spec: any) => any {
  return (rt: any, spec: any) => {
    const name = attribute_name(spec);
    return (rt: any, obj: any) => (look(rt, obj, name)[3] === "") === want_empty;
  };
}

export function member_test(include: boolean): (rt: any, spec: any, wanted: string) => any {
  return (rt: any, spec: any, wanted: string) => {
    const name = attribute_name(spec);
    return (rt: any, obj: any) => {
      const [, values, multi, text] = look(rt, obj, name);
      if (!multi) {
        throw new Fault(`includes/excludes need a multi-valued attribute; ${_repr(name)} is not one`);
      }
      if (!values.includes(wanted)) {
        throw new Fault(`${_repr(wanted)} is not a value of ${_repr(name)}`);
      }
      return text.split("\n").includes(wanted) === include;
    };
  };
}

// -- links ----------------------------------------------------------------------

export function link_test(has: boolean): (rt: any, ends: boolean[], name: string) => any {
  return (rt: any, ends: boolean[], name: string) => {
    const [incoming, outgoing] = ends;
    if (name !== "*" && rt.store.link_modules(name).size === 0) {
      throw new Fault(`no link module ${_repr(name)}`);
    }
    return (rt: any, obj: any) => {
      if (outgoing) check_end(rt, obj, true, name, "a link filter");
      if (incoming) check_end(rt, obj, false, name, "a link filter");
      let found = Boolean(outgoing && rt.store.links(obj, true, name).length);
      if (!found && incoming) {
        const inward = rt.store.links(obj, false, name);
        found = inward.some((l: any) => rt.opened.has(l.source.module_id));
        if (inward.length && !found) {
          const source = rt.store.path(inward[0].source.module_id);
          throw new Fault(`${rt.store.identifier(obj)} has incoming links only from modules that `
            + `are not open (${source}); whether the DOORS filter counts them is not `
            + "documented, so read() the source modules first");
        }
      }
      return found === has;
    };
  };
}

// -- applying -------------------------------------------------------------------

export function apply_filter(rt: any, module_id: any, test: any, accepted: any = null, rejected: any = null): void {
  rt.need(test, "Filter");
  const state = display(rt, rt.opened_module(module_id));
  const marks = new Map<string, boolean>();
  for (const o of shown(rt, module_id)) {
    marks.set(o.key, Boolean(test(rt, o)));
  }
  state.marks = marks;
  state.filtered = true;
  if (accepted !== null) {
    const kept = [...marks.values()].filter(Boolean).length;
    accepted.set(kept);
    rejected.set(marks.size - kept);
  }
}

export function apply_sort(rt: any, module_id: any, keys: any[]): void {
  rt.need(keys, "Sort");
  rt.opened_module(module_id);
  for (const [name] of keys) {
    definition(rt, module_id, name);
  }
  display(rt, module_id).sort = keys as any;
}

export function mark(accepted: boolean): (rt: any, obj: any) => void {
  return (rt: any, obj: any) => {
    display(rt, rt.obj(obj).module_id).marks.set(obj.key, accepted);
  };
}

export function switch_(field: string): (rt: any, value: boolean) => void {
  return (rt: any, value: boolean) => {
    (display(rt, current_module(rt)) as any)[field] = value;
  };
}

export function current_state(field: string): (rt: any, m: any) => any {
  return (rt: any, m: any) => (display(rt, rt.opened_module(m)) as any)[field];
}

export function register(lib: any): void {
  lib.type("Filter");
  lib.type("Sort");
  lib.type("LinkFilter");
  lib.add("on", [], "bool", (rt: any) => true);
  lib.add("off", [], "bool", (rt: any) => false);

  for (const op of COMPARE.keys()) {
    lib.operator(op, "AttrName_", "string", "Filter", comparison(op));
  }
  lib.operator("&&", "Filter", "Filter", "Filter",
    (rt: any, a: any, b: any) => (rt: any, o: any) => rt.need(a, "Filter")(rt, o) && rt.need(b, "Filter")(rt, o));
  lib.operator("||", "Filter", "Filter", "Filter",
    (rt: any, a: any, b: any) => (rt: any, o: any) => rt.need(a, "Filter")(rt, o) || rt.need(b, "Filter")(rt, o));
  lib.operator("!", "Filter", null, "Filter",
    (rt: any, a: any) => (rt: any, o: any) => !rt.need(a, "Filter")(rt, o));

  for (const extra of [[], ["bool"], ["bool", "bool"]]) {
    lib.add("contains", ["AttrName_", "string", ...extra], "Filter",
      (rt: any, spec: any, text: string, case_: boolean | null = null, regexp: boolean = false) =>
        contains(rt, spec, text, case_, regexp));
    lib.add("contents", ["string", ...extra], "Filter",
      (rt: any, text: string, case_: boolean | null = null, regexp: boolean = false) =>
        contents(rt, text, case_, regexp));
  }
  lib.add("isNull", ["AttrName_"], "Filter", empty_test(true));
  lib.add("notNull", ["AttrName_"], "Filter", empty_test(false));
  lib.add("includes", ["AttrName_", "string"], "Filter", member_test(true));
  lib.add("excludes", ["AttrName_", "string"], "Filter", member_test(false));
  for (const [name, ends] of LINK_FILTERS) {
    lib.add(name, [], "LinkFilter", (rt: any) => ends);
  }
  lib.add("hasLinks", ["LinkFilter", "string"], "Filter", link_test(true));
  lib.add("hasNoLinks", ["LinkFilter", "string"], "Filter", link_test(false));

  lib.add("set", ["Filter"], "void", (rt: any, f: any) => apply_filter(rt, current_module(rt), f));
  lib.add("set", ["Module", "Filter"], "void", apply_filter);
  lib.add("set", ["Module", "Filter", "&int", "&int"], "void", apply_filter);
  lib.add("accept", ["Object"], "void", mark(true));
  lib.add("reject", ["Object"], "void", mark(false));
  for (const name of ["filtering", "sorting"]) {
    lib.add(name, ["bool"], "void", switch_(name));
    lib.add(name, ["Module"], "bool", current_state(name));
  }
  lib.add("ancestors", ["bool"], "void", switch_("ancestors"));
  lib.add("ancestors", ["Module"], "bool", ancestors_shown);

  lib.add("ascending", ["string"], "Sort", (rt: any, name: string) => [[name, false]]);
  lib.add("descending", ["string"], "Sort", (rt: any, name: string) => [[name, true]]);
  lib.operator("&&", "Sort", "Sort", "Sort",
    (rt: any, a: any, b: any) => [...rt.need(a, "Sort"), ...rt.need(b, "Sort")]);
  lib.add("set", ["Sort"], "void", (rt: any, s: any) => apply_sort(rt, current_module(rt), s));
  lib.add("set", ["Module", "Sort"], "void", apply_sort);
}

export function ancestors_shown(rt: any, module_id: any): boolean {
  const value = display(rt, rt.opened_module(module_id)).ancestors;
  if (value === null) {
    throw new Fault("whether ancestors are shown depends on the view; set it with ancestors(true/false)");
  }
  return value;
}
