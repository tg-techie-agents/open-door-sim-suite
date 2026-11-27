// Attribute definitions and types, baselines, history.
//
// AttrDef, AttrType and History values are the store's own records. A Baseline
// is a store.Baseline (from a loop) or a Wanted (a handle that only names one).
// AttrBaseType and HistoryType values are the strings DOORS prints for them.

import { AttrDef, AttrType, Baseline, Store, StoreError, _repr } from "../../store.ts";
import { key } from "../registry.ts";
import { Fault } from "../runtime.ts";
import { attempt, current_module } from "./database.ts";

export const BASE_CONSTANTS = new Map<string, string>([
  ["attrText", "Text"], ["attrString", "String"], ["attrInteger", "Integer"],
  ["attrReal", "Real"], ["attrDate", "Date"], ["attrEnumeration", "Enumeration"]]);

// Maintained by DOORS itself: (name, type name, scope)
export const SYSTEM: string[][] = [
  ["Absolute Number", "Integer", "object"], ["Created By", "Username", "object"],
  ["Created On", "Date", "object"], ["Created Thru", "Created Thru", "object"],
  ["Last Modified By", "Username", "object"],
  ["Last Modified On", "Date", "object"], ["Name", "String", "module"],
  ["Description", "Text", "module"], ["Prefix", "String", "module"]];
export const SYSTEM_NAMES = new Set<string>([...SYSTEM.map(([name]) => name),
  "Object Heading", "Object Short Text", "Object Text"]);
// object attributes that modules have too
export const OF_BOTH = ["Created By", "Created On", "Last Modified By", "Last Modified On"];
export const SYSTEM_TYPES = ["String", "Text", "Integer", "Real", "Date", "Boolean", "Username"];

// store history action -> DXL HistoryType constant
export const HISTORY_TYPES = ("unknown createType modifyType deleteType createAttr modifyAttr deleteAttr createObject "
  + "copyObject modifyObject deleteObject unDeleteObject purgeObject clipCutObject "
  + "clipMoveObject clipCopyObject createModule baselineModule createLink modifyLink "
  + "deleteLink").split(" ");
export const ACTIONS = new Map<string, string>([
  ["createBaseline", "baselineModule"], ["moveObject", "clipMoveObject"]]);

export function date(rt: any, text: string): any {
  return rt.lib.from_attr.get("Date")(rt, text);
}

// -- attribute definitions and types ------------------------------------------

export function definitions(rt: any, module_id: any): any[] {
  const system = SYSTEM.map(([name, type_name, scope]) =>
    new AttrDef(module_id, name, type_name, type_name === "Created Thru" ? "Enumeration" : type_name, scope, false,
      name === "Created Thru" ? "Manual Input" : "", []));
  return [...system, ...rt.store.attributes(rt.opened_module(module_id), null)];
}

export function find_definition(rt: any, module_id: any, name: string): any {
  return definitions(rt, module_id).find((d) => d.name === name) ?? null;
}

export function find_type(rt: any, module_id: any, name: string): any {
  const found = rt.store.types(rt.opened_module(module_id)).find((t: any) => t.name === name) ?? null;
  if (found === null && name === "Username") {
    return new AttrType(module_id, name, name, []);
  }
  if (found === null && name === "Created Thru") {
    return new AttrType(module_id, name, "Enumeration", []);
  }
  return found;
}

export function applies(definition: any, scope: string): boolean {
  return definition.scope === scope || OF_BOTH.includes(definition.name);
}

export function names_for(rt: any, module_id: any, scope: string): string[] {
  return definitions(rt, module_id).filter((d) => applies(d, scope)).map((d) => d.name);
}

export function create_definition(rt: any, spec: Map<string, any>): any {
  const module_id = rt.editing(current_module(rt));
  const name = spec.get("name");
  rt.store.create_attribute(module_id, name,
    spec.has("type") ? spec.get("type") : "String",
    spec.has("scope") ? spec.get("scope") : "object",
    spec.has("multi") ? spec.get("multi") : false,
    spec.has("default") ? spec.get("default") : "",
    spec.has("dxl") ? spec.get("dxl") : "");
  return rt.store.attribute(module_id, name);
}

export function delete_definition(rt: any, module_id: any, definition: any): string {
  rt.need(definition, "AttrDef");
  rt.editing(module_id);
  return attempt(() => rt.store.delete_attribute(module_id, definition.name));
}

/** Whether `text` is acceptable data for the attribute. */
export function valid_value(rt: any, definition: any, text: string, locale_date: boolean | null = null): boolean {
  rt.need(definition, "AttrDef");
  if (locale_date !== null && definition.base !== "Date") {
    throw new Fault("attributeValue: the third argument is only for date attributes");
  }
  if (definition.base === "String" || definition.base === "Text") {
    return true;
  }
  if (!["Integer", "Real", "Date", "Enumeration"].includes(definition.base)) {
    throw new Fault(`attributeValue is not supported for ${_repr(definition.name)}`);
  }
  if (text === "") {
    throw new Fault("attributeValue: whether an empty string is valid data is not documented");
  }
  if (definition.base === "Real" && !/^-?\p{Nd}+(\.\p{Nd}+)?([eE][-+]?\p{Nd}+)?$/u.test(text)) {
    if (/^[-+ .\p{Nd}]*\p{Nd}[-+ .\p{Nd}eE]*$/u.test(text)) {
      throw new Fault(`attributeValue: whether ${_repr(text)} is a valid real is not documented`);
    }
    return false;
  }
  try {
    Store.check_value(definition, text);
  } catch (e) {
    if (e instanceof StoreError) return false;
    throw e;
  }
  return true;
}

export function good_string(rt: any, kind: string): string {
  if (kind !== "createObject") { // the only wording the manual gives
    throw new Fault(`goodStringOf(${kind}): the DOORS wording is not documented; use stringOf`);
  }
  return "Create Object";
}

export function create_type(rt: any, name: string, base: string, values: any[], error: any): any {
  const module_id = rt.editing(current_module(rt));
  try {
    rt.store.create_type(module_id, name, base, [...values]);
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
    error.set(e.message);
    return null;
  }
  error.set("");
  return find_type(rt, module_id, name);
}

export function value_type(rt: any, module_id: any, name: string): string {
  return rt.need(find_definition(rt, module_id, name), `attribute ${_repr(name)}`).type_name;
}

export function attribute_type_name(rt: any, attribute: any): string {
  if (attribute.owner_type === "Link") {
    throw new Fault("link attribute types are not supported here");
  }
  const module_id = attribute.owner_type === "Module" ? attribute.owner : rt.obj(attribute.owner).module_id;
  return value_type(rt, module_id, attribute.name);
}

export function register_attributes(lib: any): void {
  for (const type_name of ["AttrDef", "AttrType", "AttrProp_", "AttrName_", "AttrDXL_", "AttrNameDXL_", "ModAttrs_"]) {
    lib.type(type_name);
  }
  lib.type("AttrBaseType", (rt: any, base: string) => base);

  const need_def = (read: (rt: any, d: any) => any) =>
    (rt: any, d: any) => read(rt, rt.need(d, "AttrDef"));

  const def_props: [string, string, (rt: any, d: any) => any][] = [
    ["name", "string", (rt, d) => d.name],
    ["typeName", "string", (rt, d) => d.type_name],
    ["type", "AttrType", (rt, d) => find_type(rt, d.module_id, d.type_name)],
    ["object", "bool", (rt, d) => applies(d, "object")],
    ["module", "bool", (rt, d) => applies(d, "module")],
    ["multi", "bool", (rt, d) => d.multi],
    ["system", "bool", (rt, d) => SYSTEM_NAMES.has(d.name)],
    ["defval", "string", (rt, d) => d.default]];
  for (const [name, returns, read] of def_props) {
    lib.prop("AttrDef", name, returns, need_def(read));
  }
  // `ad.dxl` is the code where a string is wanted, and whether there is any in a condition
  lib.prop("AttrDef", "dxl", "bool", need_def((rt, d) => d.dxl !== ""));
  lib.second_readings.set(key("AttrDef", "dxl"), ["string", need_def((rt, d) => d.dxl)]);

  const type_props: [string, string, (t: any) => any][] = [
    ["name", "string", (t) => t.name],
    ["type", "AttrBaseType", (t) => t.base],
    ["size", "int", (t) => t.values.length],
    ["strings", "string[]", (t) => [...t.values]],
    ["system", "bool", (t) => SYSTEM_TYPES.includes(t.name)]];
  for (const [name, returns, read] of type_props) {
    lib.prop("AttrType", name, returns, (rt: any, t: any) => {
      rt.need(t, "AttrType");
      if (t.name === "Created Thru" && (name === "size" || name === "strings")) {
        throw new Fault('the values of the "Created Thru" type are not available here');
      }
      return read(t);
    });
  }

  lib.add("find", ["Module", "string"], "AttrDef", find_definition);
  lib.add("find", ["Module", "string"], "AttrType", find_type);
  lib.add("attributeValue", ["AttrDef", "string"], "bool", valid_value);
  lib.add("attributeValue", ["AttrDef", "string", "bool"], "bool", valid_value);
  lib.loop("Module", "AttrDef", definitions);
  lib.loop("Module", "AttrType", (rt: any, m: any) => rt.store.types(rt.opened_module(m)));
  lib.loop("Module", "string", (rt: any, m: any) => names_for(rt, m, "object"));
  lib.add("attributes", ["Module"], "ModAttrs_", (rt: any, m: any) => rt.opened_module(m));
  lib.loop("ModAttrs_", "string", (rt: any, m: any) => names_for(rt, m, "module"));
  lib.loop("ModAttrs_", "AttrDef",
    (rt: any, m: any) => definitions(rt, m).filter((d) => applies(d, "module")));

  // `create object type "Integer" (default "0") attribute "Cost"`: the
  // properties merge from right to left into one specification.
  lib.add("attribute", ["string"], "AttrName_", (rt: any, name: string) => new Map([["name", name]]));
  for (const [prop, takes] of [["type", "string"], ["default", "string"], ["multi", "bool"]]) {
    lib.add(prop, [takes], "AttrProp_", (rt: any, value: any) => new Map([[prop, value]]));
  }
  const merge = (rt: any, a: Map<string, any>, b: Map<string, any>) => new Map([...a, ...b]);
  for (const right of ["AttrProp_", "AttrName_"]) {
    lib.juxta("AttrProp_", right, right, merge);
  }
  // attribute DXL: `(dxl code)` with the other properties, or after `attribute "x"`
  lib.add("dxl", ["string"], "AttrDXL_", (rt: any, code: string) => {
    if (!code) throw new Fault("dxl: the code is empty");
    return new Map([["dxl", code]]);
  });
  lib.juxta("AttrDXL_", "AttrProp_", "AttrProp_", merge);
  lib.juxta("AttrDXL_", "AttrName_", "AttrName_", merge);
  lib.juxta("AttrProp_", "AttrDXL_", "AttrProp_", merge);
  // a type of its own, or `object attribute "x" dxl c` would read two ways
  lib.juxta("AttrName_", "AttrDXL_", "AttrNameDXL_", merge);
  lib.juxta("AttrProp_", "AttrNameDXL_", "AttrNameDXL_", merge);
  lib.add("create", ["AttrNameDXL_"], "AttrDef", create_definition);
  // nothing here is inherited or hidden, so only `false` can be honoured
  for (const prop of ["inherit", "hidden"]) {
    lib.add(prop, ["bool"], "AttrProp_", (rt: any, value: boolean) => {
      if (value) throw new Fault(`${prop} true is not supported here`);
      return new Map();
    });
  }
  for (const scope of ["object", "module"]) {
    lib.add(scope, ["AttrName_"], "AttrName_",
      (rt: any, spec: Map<string, any>) => new Map([...spec, ["scope", scope]]));
  }
  lib.add("create", ["AttrName_"], "AttrDef", create_definition);
  lib.add("exists", ["AttrName_"], "bool",
    (rt: any, spec: Map<string, any>) => find_definition(rt, current_module(rt), spec.get("name")) !== null);
  lib.add("delete", ["AttrDef"], "string",
    (rt: any, d: any) => delete_definition(rt, current_module(rt), d));
  lib.add("delete", ["Module", "AttrDef"], "string", delete_definition);

  // attribute types
  for (const [constant, base] of BASE_CONSTANTS) {
    lib.add(constant, [], "AttrBaseType", (rt: any) => base);
  }
  lib.add("stringOf", ["AttrBaseType"], "string", (rt: any, base: string) => base);
  lib.add("print", ["AttrBaseType"], "void", (rt: any, base: string) => { rt.out.write(base); });
  lib.add("create", ["string", "AttrBaseType", "&string"], "AttrType",
    (rt: any, name: string, base: string, error: any) => create_type(rt, name, base, [], error));
  // names [, values [, colours [, descriptions]]]; only the names are kept.
  const extras: string[] = [];
  for (const extra of [null, "int[]", "int[]", "string[]"]) {
    if (extra) extras.push(extra);
    lib.add("create", ["string", "string[]", ...extras, "&string"], "AttrType",
      (rt: any, name: string, codes: string[], ...rest: any[]) =>
        create_type(rt, name, "Enumeration", codes, rest[rest.length - 1]));
  }

  lib.add("type", ["attr"], "string", attribute_type_name);
  lib.add("type", ["Module", "string"], "string", value_type);
}

// -- baselines ----------------------------------------------------------------

/** `nextMajor`, `nextMinor` or `baseline(1,0,"x")`. */
export class Wanted {
  major: number | null;
  minor: number | null;
  suffix: string;
  step: string; // "major" or "minor" for the next one

  constructor(major: number | null, minor: number | null, suffix: string, step: string = "") {
    this.major = major;
    this.minor = minor;
    this.suffix = suffix;
    this.step = step;
  }

  get key(): string {
    return JSON.stringify(["Wanted", this.major, this.minor, this.suffix, this.step]);
  }

  equals(other: unknown): boolean {
    return other instanceof Wanted && this.major === other.major && this.minor === other.minor
      && this.suffix === other.suffix && this.step === other.step;
  }
}

export function upcoming(rt: any, module_id: any, major: boolean): number[] {
  const existing = rt.store.baselines(module_id);
  if (existing.length === 0) {
    return major ? [1, 0] : [0, 1];
  }
  const last = existing[existing.length - 1];
  return major ? [last.major + 1, 0] : [last.major, last.minor + 1];
}

export function create_baseline(rt: any, module_id: any, wanted: any, annotation: string): void {
  rt.need(wanted, "Baseline");
  rt.editing(module_id);
  const step: string = wanted.step ?? "";
  let major: boolean;
  if (step) {
    major = step === "major";
  } else {
    const is = (number: number[]) => wanted.major === number[0] && wanted.minor === number[1];
    if (is(upcoming(rt, module_id, true))) {
      major = true;
    } else if (is(upcoming(rt, module_id, false))) {
      major = false;
    } else {
      throw new Fault("only the next major or next minor version can be baselined here");
    }
  }
  rt.store.create_baseline(module_id, annotation, major, wanted.suffix);
  // DOORS closes the module it has just baselined.
  rt.opened.delete(module_id);
  rt.modified.delete(module_id);
  if (rt.module === module_id) {
    rt.module = null;
  }
  if (rt.object !== null && rt.object.module_id === module_id) {
    rt.object = null;
  }
}

export function matching(rt: any, module_id: any, wanted: any): any {
  rt.need(module_id, "Module");
  rt.need(wanted, "Baseline");
  return rt.store.baselines(module_id).find((b: any) =>
    b.major === wanted.major && b.minor === wanted.minor && b.suffix === wanted.suffix) ?? null;
}

export function load(rt: any, module_id: any, wanted: any, display: boolean): any {
  const found = matching(rt, module_id, wanted);
  return found ? rt.open(found.copy_id, "read") : null;
}

export function read_baseline(field: string): (rt: any, baseline: any) => any {
  return (rt: any, baseline: any) => {
    if (!(rt.need(baseline, "Baseline") instanceof Baseline)) {
      throw new Fault("use this on a Baseline from a `for b in module` loop");
    }
    return baseline[field];
  };
}

export function most_recent(rt: any, module_id: any, deleted: boolean = false): any {
  const found = rt.store.baselines(rt.need(module_id, "Module"));
  return found.length ? found[found.length - 1] : null;
}

export function register_baselines(lib: any): void {
  lib.type("Baseline");
  lib.loop("Module", "Baseline", (rt: any, m: any) => rt.store.baselines(rt.opened_module(m)));
  for (const [name, field, returns] of [["major", "major", "int"], ["minor", "minor", "int"],
    ["suffix", "suffix", "string"], ["annotation", "annotation", "string"],
    ["user", "created_by", "string"]]) {
    lib.add(name, ["Baseline"], returns, read_baseline(field));
  }
  const created_on = read_baseline("created_on");
  lib.add("dateOf", ["Baseline"], "Date", (rt: any, b: any) => date(rt, created_on(rt, b)));

  lib.add("baseline", ["int", "int", "string"], "Baseline",
    (rt: any, a: number, b: number, s: string) => new Wanted(a, b, s));
  for (const [name, step] of [["nextMajor", "major"], ["nextMinor", "minor"]]) {
    lib.add(name, [], "Baseline", (rt: any) => new Wanted(null, null, "", step));
    lib.add(name, ["string"], "Baseline", (rt: any, s: string) => new Wanted(null, null, s, step));
  }
  lib.add("create", ["Baseline", "string"], "void",
    (rt: any, b: any, note: string) => create_baseline(rt, current_module(rt), b, note));
  lib.add("create", ["Module", "Baseline", "string"], "void", create_baseline);
  lib.add("load", ["Baseline", "bool"], "Module",
    (rt: any, b: any, show: boolean) => load(rt, current_module(rt), b, show));
  lib.add("load", ["Module", "Baseline", "bool"], "Module", load);
  lib.add("baselineExists", ["Module", "Baseline"], "bool",
    (rt: any, m: any, b: any) => matching(rt, m, b) !== null);
  lib.add("getMostRecentBaseline", ["Module"], "Baseline", most_recent);
  lib.add("getMostRecentBaseline", ["Module", "bool"], "Baseline", most_recent);
  for (const name of ["baseline", "isBaseline"]) {
    lib.add(name, ["Module"], "bool", (rt: any, m: any) => rt.store.is_baseline(rt.opened_module(m)));
  }
  lib.add("baselineInfo", ["Module"], "Baseline",
    (rt: any, m: any) => rt.store.baseline_of(rt.opened_module(m)));
}

// -- history ------------------------------------------------------------------

export function history(rt: any, module_id: any, absno: number | null = null): any[] {
  if (rt.store.is_baseline(module_id)) {
    throw new Fault("the history of a baseline is not kept here");
  }
  return rt.store.history(module_id, absno);
}

export function history_type(record: any): string {
  const action = ACTIONS.get(record.action) ?? record.action;
  return HISTORY_TYPES.includes(action) ? action : "unknown";
}

export function absolute_number(record: any): number {
  if (record.absno === null) {
    throw new Fault("this history record is not about an object");
  }
  return record.absno;
}

// Which kinds of record carry these, and what DOORS gives for the others, is
// not documented: stop rather than invent a number.
function link_record(record: any, property: string): void {
  if (record.action !== "createLink" && record.action !== "deleteLink") {
    throw new Fault(`${property} is only available here on createLink and deleteLink records; `
      + "test the record's type first");
  }
}

function target_number(record: any): number {
  if (record.target_absno === null) throw new Fault("this old record did not note the target's number");
  return record.target_absno;
}

function object_count(record: any): number {
  if (record.object_count === null) {
    throw new Fault("numberOfObjects is only available here on records of moved objects; "
      + "test the record's type first");
  }
  return record.object_count;
}

/** Only changes to attribute values carry an old and a new value. */
export function changed(record: any, value: string): string {
  return record.action === "modifyObject" ? value : "";
}

export function register_history(lib: any): void {
  lib.type("History");
  lib.type("HistoryType", (rt: any, kind: string) => kind);
  for (const kind of HISTORY_TYPES) {
    // createAttr and the rest are constants, so they are functions of no arguments
    lib.add(kind, [], "HistoryType", (rt: any) => kind);
  }
  lib.add("stringOf", ["HistoryType"], "string", (rt: any, kind: string) => kind);
  lib.add("goodStringOf", ["HistoryType"], "string", good_string);
  lib.add("print", ["HistoryType"], "void", (rt: any, kind: string) => { rt.out.write(kind); });

  lib.loop("Module", "History", (rt: any, m: any) => history(rt, rt.opened_module(m)));
  lib.loop("Object", "History", (rt: any, o: any) => history(rt, rt.obj(o).module_id, o.absno));
  lib.loop("Top_", "History",
    (rt: any, m: any) => history(rt, m).filter((h) => h.absno === null));

  const props: [string, string, (rt: any, h: any) => any][] = [
    ["type", "HistoryType", (rt, h) => history_type(h)],
    ["author", "string", (rt, h) => h.who],
    ["attrName", "string", (rt, h) => h.attribute],
    ["absNo", "int", (rt, h) => absolute_number(h)],
    ["sourceAbsNo", "int", (rt, h) => { link_record(h, "sourceAbsNo"); return absolute_number(h); }],
    ["targetAbsNo", "int", (rt, h) => { link_record(h, "targetAbsNo"); return target_number(h); }],
    ["numberOfObjects", "int", (rt, h) => object_count(h)],
    ["date", "Date", (rt, h) => date(rt, h.when)],
    ["oldValue", "string", (rt, h) => changed(h, h.old)],
    ["newValue", "string", (rt, h) => changed(h, h.new)],
    ["plainOldValue", "string", (rt, h) => changed(h, h.old)],
    ["plainNewValue", "string", (rt, h) => changed(h, h.new)]];
  for (const [name, returns, read] of props) {
    lib.prop("History", name, returns, (rt: any, h: any) => read(rt, rt.need(h, "History")));
  }

  lib.add("lastModifiedTime", ["Object"], "Date",
    (rt: any, o: any) => date(rt, rt.store.value(rt.obj(o), "Last Modified On")));
}

export function register(lib: any): void {
  register_attributes(lib);
  register_baselines(lib);
  register_history(lib);
}
