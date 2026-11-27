// Attribute definitions and types, baselines, history.
//
// AttrDef, AttrType and History values are the store's own records. A Baseline
// is a store.Baseline (from a loop) or a Wanted (a handle that only names one).
// AttrBaseType and HistoryType values are the strings DOORS prints for them.

import { AttrDef, AttrType, Baseline, Store, StoreError, _repr } from "../../store.ts";
import { key } from "../registry.ts";
import { Fault, is_limit } from "../runtime.ts";
import { attempt, current_module } from "./database.ts";
import { check_source } from "./pending.ts";

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
// the system attributes nobody can edit
const READ_ONLY = new Set(["Absolute Number", "Created By", "Created On", "Created Thru", "Last Modified By",
  "Last Modified On"]);
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

// spec key -> store key, for the settings that are not positional
const SPEC_EXTRAS = ["description", "inherit", "hidden", "history", "bars", "dates"];

function spec_extras(spec: Map<string, any>): any {
  return Object.fromEntries(SPEC_EXTRAS.filter((k) => spec.has(k)).map((k) => [k, spec.get(k)]));
}

export function create_definition(rt: any, spec: Map<string, any>): any {
  const module_id = rt.editing(current_module(rt));
  const name = spec.get("name");
  rt.store.create_attribute(module_id, name,
    spec.has("type") ? spec.get("type") : "String",
    spec.has("scope") ? spec.get("scope") : "object",
    spec.has("multi") ? spec.get("multi") : false,
    spec.has("default") ? spec.get("default") : "",
    spec.has("dxl") ? spec.get("dxl") : "", spec_extras(spec));
  return rt.store.attribute(module_id, name);
}

// A definition's module, ready to be changed.
function changing(rt: any, definition: any): number {
  rt.need(definition, "AttrDef");
  const module_id = rt.editing(definition.module_id);
  if (!rt.store.attribute(module_id, definition.name)) {
    throw new Fault(`${_repr(definition.name)} is a system attribute, or the definition has gone: it cannot be `
      + "modified here");
  }
  return module_id;
}

function modified(rt: any, definition: any, changes: any): any {
  const module_id = changing(rt, definition);
  rt.store.modify_attribute(module_id, definition.name, changes);
  return rt.store.attribute(module_id, changes.name ?? definition.name);
}

// `modify(ad, object type "Integer" attribute "x")`
export function redefine(rt: any, definition: any, spec: Map<string, any>): any {
  const old = rt.store.attribute(changing(rt, definition), definition.name);
  // what DOORS does with a setting the new definition leaves out is not documented
  const kept: [string, any, any][] = [["type", old.type_name, "String"], ["scope", old.scope, "object"],
    ["multi", old.multi, false], ["default", old.default, ""], ["dxl", old.dxl, ""],
    ["description", old.description, ""], ["inherit", old.inherit, false], ["hidden", old.hidden, false],
    ["history", old.history, true], ["bars", old.bars, true], ["dates", old.dates, true]];
  for (const [key, held, usual] of kept) {
    if (!spec.has(key) && held !== usual) {
      throw new Fault(`modify: say what ${key === "scope" ? "object or module" : key} the attribute is to have; `
        + "what DOORS does when the new definition leaves it out is not documented");
    }
  }
  if ((spec.get("scope") ?? "object") !== old.scope) {
    throw new Fault("modify: moving an attribute between objects and the module is not supported here");
  }
  return modified(rt, definition, { name: spec.get("name"), type_name: spec.get("type"), multi: spec.get("multi"),
    default: spec.get("default"), dxl: spec.get("dxl"), ...spec_extras(spec) });
}

// `modify(ad, setHistory, true)`: constant -> [value type, change]
const SETTERS: [string, string, (d: any, v: any) => any][] = [
  ["setName", "string", (d, v) => ({ name: v })],
  ["setDefault", "string", (d, v) => ({ default: v })],
  ["setDXL", "string", (d, v) => ({ dxl: v })],
  ["setDescription", "string", (d, v) => ({ description: v })],
  ["setBars", "bool", (d, v) => ({ bars: v })],
  ["setDates", "bool", (d, v) => ({ dates: v })],
  ["setHidden", "bool", (d, v) => ({ hidden: v })],
  ["setHistory", "bool", (d, v) => ({ history: v })],
  ["setInherit", "bool", (d, v) => ({ inherit: v })],
  ["setMulti", "bool", (d, v) => ({ multi: v })],
  ["setObject", "bool", (d, v) => keep_scope(d, "object", v)],
  ["setModule", "bool", (d, v) => keep_scope(d, "module", v)]];

function keep_scope(definition: any, scope: string, wanted: boolean): any {
  if (wanted !== (definition.scope === scope)) {
    throw new Fault("an attribute here applies to objects or to the module, and that cannot be changed");
  }
  return {};
}

function own_value(rt: any, owner: any, definition: any): boolean {
  rt.need(definition, "AttrDef");
  if (!definition.inherit) {
    throw new Fault("hasSpecificValue is only supported here for an inherited attribute");
  }
  return rt.store.has_own_value(rt.obj(owner), definition.name);
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

export function create_type(rt: any, name: string, base: string, values: any[], error: any,
  extras: any = {}): any {
  const module_id = rt.editing(current_module(rt));
  try {
    rt.store.create_type(module_id, name, base, [...values], extras);
  } catch (e) {
    if (!(e instanceof StoreError) || is_limit(e.message)) throw e;
    error.set(e.message);
    return null;
  }
  error.set("");
  return find_type(rt, module_id, name);
}

// a DXL array handed over whole: every element must have been given a value
function whole(array: any[], what: string): any[] {
  rt_need(array, what);
  if (array.some((v) => v === undefined || v === null)) {
    throw new Fault(`the array of ${what} has elements with no value; size it to the number of values`);
  }
  return [...array];
}

function rt_need(value: any, what: string): void {
  if (value === null || value === undefined) throw new Fault(`null ${what}`);
}

function real_colours(rt: any): boolean {
  return rt.state.get("real colours") === true;
}

// the numbers, colours or descriptions of an enumeration, if it was given them
function related(type: any, list: readonly any[], what: string): any[] {
  if (!list.length) {
    throw new Fault(`type ${_repr(type.name)} was given no ${what}, and what DOORS gives then is not documented`);
  }
  return [...list];
}

function type_to_change(rt: any, type: any): number {
  rt.need(type, "AttrType");
  return rt.editing(type.module_id);
}

function type_named(rt: any, module_id: number, name: string): any {
  return rt.store.types(module_id).find((t: any) => t.name === name) ?? null;
}

// `modify`, as documented, leaves errmess unused: a failure is a run-time error (see noError).
function modify_type(rt: any, type: any, name: string, changes: any, maps: any[] | null, error: any): any {
  const module_id = type_to_change(rt, type);
  const now = type_named(rt, module_id, type.name);
  rt.need(now, `type ${_repr(type.name)} (it has gone)`);
  if (maps !== null && maps.some((v, i) => v !== undefined && v !== i)) {
    throw new Fault("modify: only an identity mapping (arrMaps[i] = i) is supported here");
  }
  if (changes.values && rt.store.type_users(module_id, now.name).length) {
    const same = changes.values.length === now.values.length
      && changes.values.every((v: string, i: number) => v === now.values[i]);
    if (!same && maps === null) {
      throw new StoreError(`type ${_repr(now.name)} is in use: arrMaps must say where the old values go`);
    }
  }
  rt.store.modify_type(module_id, now.name, { ...changes, name }, maps !== null);
  error.set("");
  return type_named(rt, module_id, name);
}

function register_type_changes(lib: any): void {
  lib.add("modify", ["AttrType", "string", "&string"], "AttrType",
    (rt: any, t: any, name: string, error: any) => modify_type(rt, t, name, {}, null, error));
  for (const maps of [false, true]) {
    lib.add("modify", ["AttrType", "string", "string[]", "int[]", "int[]", "string[]", ...(maps ? ["int[]"] : []),
      "&string"], "AttrType", (rt: any, t: any, name: string, codes: any[], numbers: any[], colours: any[],
      descriptions: any[], ...rest: any[]) => {
      const error = rest.pop();
      return modify_type(rt, t, name, { values: whole(codes, "names"), numbers: whole(numbers, "numbers"),
        colours: whole(colours, "colours"), descriptions: whole(descriptions, "descriptions"),
        real_colours: real_colours(rt) }, maps ? rt_array(rest[0]) : null, error);
    });
  }
  lib.add("modify", ["AttrType", "AttrBaseType", "&string"], "AttrType",
    (rt: any, t: any, base: string, error: any) => {
      const module_id = type_to_change(rt, t);
      rt.store.modify_type(module_id, t.name, { base });
      error.set("");
      return type_named(rt, module_id, t.name);
    });
  lib.add("delete", ["AttrType", "&string"], "bool", (rt: any, t: any, error: any) => {
    const module_id = type_to_change(rt, t);
    const message = attempt(() => rt.store.delete_type(module_id, t.name));
    error.set(message);
    return !message;
  });
  lib.add("setDescription", ["AttrType", "string", "&string"], "AttrType",
    (rt: any, t: any, text: string, error: any) => {
      const module_id = type_to_change(rt, t);
      const message = attempt(() => rt.store.modify_type(module_id, t.name, { description: text }));
      error.set(message);
      return message ? null : type_named(rt, module_id, t.name);
    });
  lib.add("isRanged", ["AttrType"], "bool",
    (rt: any, t: any) => ["Integer", "Real", "Date"].includes(rt.need(t, "AttrType").base));
  lib.add("isUsed", ["AttrType"], "bool",
    (rt: any, t: any) => rt.store.type_users(rt.need(t, "AttrType").module_id, t.name).length > 0);
  for (const spelling of ["Color", "Colour"]) {
    lib.add(`getReal${spelling}OptionForTypes`, [], "bool", real_colours);
    lib.add(`setReal${spelling}OptionForTypes`, ["bool"], "void",
      (rt: any, real: boolean) => { rt.state.set("real colours", real); });
  }
}

function rt_array(array: any[]): any[] {
  rt_need(array, "arrMaps");
  return [...array];
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

  // a handle shows the definition as it is now
  const current = (rt: any, d: any) => rt.store.attribute(d.module_id, d.name) ?? d;
  const live_def = (read: (rt: any, d: any) => any) =>
    (rt: any, d: any) => read(rt, current(rt, rt.need(d, "AttrDef")));

  const def_props: [string, string, (rt: any, d: any) => any][] = [
    ["description", "string", (rt, d) => d.description],
    ["hidden", "bool", (rt, d) => d.hidden],
    ["inherit", "bool", (rt, d) => d.inherit],
    ["nobars", "bool", (rt, d) => !d.bars],
    ["nochanges", "bool", (rt, d) => !d.dates],
    ["nohistory", "bool", (rt, d) => !d.history],
    ["name", "string", (rt, d) => d.name],
    ["typeName", "string", (rt, d) => d.type_name],
    ["type", "AttrType", (rt, d) => find_type(rt, d.module_id, d.type_name)],
    ["object", "bool", (rt, d) => applies(d, "object")],
    ["module", "bool", (rt, d) => applies(d, "module")],
    ["multi", "bool", (rt, d) => d.multi],
    ["system", "bool", (rt, d) => SYSTEM_NAMES.has(d.name)],
    ["defval", "string", (rt, d) => d.default]];
  for (const [name, returns, read] of def_props) {
    lib.prop("AttrDef", name, returns, live_def(read));
  }
  // Whether users can update the value, whatever access controls say. Which system
  // attributes are read-only is Using DOORS' table of them.
  lib.prop("AttrDef", "useraccess", "bool", live_def((_rt, d) => {
    if (READ_ONLY.has(d.name)) return false;
    if (d.dxl !== "") throw new Fault("useraccess of an attribute with DXL is not documented");
    return true;
  }));
  // `ad.dxl` is the code where a string is wanted, and whether there is any in a condition
  lib.prop("AttrDef", "dxl", "bool", need_def((rt, d) => d.dxl !== ""));
  lib.second_readings.set(key("AttrDef", "dxl"), ["string", need_def((rt, d) => d.dxl)]);

  const type_props: [string, string, (t: any) => any][] = [
    ["name", "string", (t) => t.name],
    ["type", "AttrBaseType", (t) => t.base],
    ["size", "int", (t) => t.values.length],
    ["strings", "string[]", (t) => [...t.values]],
    ["system", "bool", (t) => SYSTEM_TYPES.includes(t.name)],
    ["description", "string", (t) => t.description],
    ["values", "int[]", (t) => related(t, t.numbers, "related numbers")],
    ["minValue", "bool", (t) => t.min !== ""],
    ["maxValue", "bool", (t) => t.max !== ""]];
  const live_type = (name: string, read: (rt: any, t: any) => any) => (rt: any, handle: any) => {
    rt.need(handle, "AttrType");
    if (handle.name === "Created Thru" && (name === "size" || name === "strings")) {
      throw new Fault('the values of the "Created Thru" type are not available here');
    }
    return read(rt, rt.store.types(handle.module_id).find((t: any) => t.name === handle.name) ?? handle);
  };
  for (const [name, returns, read] of type_props) {
    lib.prop("AttrType", name, returns, live_type(name, (rt, t) => read(t)));
  }
  for (const name of ["colors", "colours"]) {
    lib.prop("AttrType", name, "int[]", live_type(name, (rt, t) => {
      if (t.colours.length && t.real_colours !== real_colours(rt)) {
        throw new Fault(`${name}: the colours were set with setRealColorOptionForTypes(${t.real_colours}); `
          + "converting between logical and real colours is not supported here");
      }
      return related(t, t.colours, "colours");
    }));
  }
  // a type's minimum or maximum, read as a number; `if (at.minValue)` asks whether it has one
  for (const [name, field] of [["minValue", "min"], ["maxValue", "max"]]) {
    lib.second_readings.set(key("AttrType", name), ["int", live_type(name, (rt, t) => {
      if (t.base !== "Integer" || t[field] === "") {
        throw new Fault(`${name}: only the limit of an Integer type that has one can be read here`);
      }
      return Number(t[field]);
    })]);
  }
  // `at.description[n]` would be a value's description, which the manual does not settle how to index
  lib.second_readings.set(key("AttrType", "description"), ["string[]", live_type("description", () => {
    throw new Fault("the descriptions of an enumeration's values cannot be read here");
  })]);

  for (const owner of ["AttrDef", "AttrType"]) {
    lib.prop(owner, "canWrite", "bool", (rt: any, handle: any) => {
      rt.need(handle, owner);
      const system = owner === "AttrDef" ? SYSTEM_NAMES : new Set(SYSTEM_TYPES);
      return !system.has(handle.name) && rt.opened.get(handle.module_id) !== "read"
        && !rt.store.is_baseline(handle.module_id);
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
  for (const [prop, takes, field] of [["type", "string", "type"], ["default", "string", "default"],
    ["multi", "bool", "multi"], ["description", "string", "description"], ["inherit", "bool", "inherit"],
    ["hidden", "bool", "hidden"], ["history", "bool", "history"], ["changeBars", "bool", "bars"],
    ["date", "bool", "dates"]]) {
    lib.add(prop, [takes], "AttrProp_", (rt: any, value: any) => new Map([[field, value]]));
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

  lib.add("modify", ["AttrDef", "AttrName_"], "AttrDef", redefine);
  lib.add("modify", ["AttrDef", "AttrNameDXL_"], "AttrDef", redefine);
  for (const [constant, takes, change] of SETTERS) {
    const type_name = `Set_${constant}`;
    lib.type(type_name);
    lib.add(constant, [], type_name, () => constant);
    lib.add("modify", ["AttrDef", type_name, takes], "AttrDef",
      (rt: any, d: any, which: any, value: any) => modified(rt, d, change(rt.need(d, "AttrDef"), value)));
  }
  lib.add("hasSpecificValue", ["Object", "AttrDef"], "bool", own_value);
  lib.add("isVisibleAttribute", ["AttrDef"], "bool", (rt: any, d: any) => {
    rt.need(d, "AttrDef");
    return d.scope === "object" && !d.hidden;
  });

  // attribute types
  for (const [constant, base] of BASE_CONSTANTS) {
    lib.add(constant, [], "AttrBaseType", (rt: any) => base);
  }
  lib.add("stringOf", ["AttrBaseType"], "string", (rt: any, base: string) => base);
  lib.add("print", ["AttrBaseType"], "void", (rt: any, base: string) => { rt.out.write(base); });
  lib.add("create", ["string", "AttrBaseType", "&string"], "AttrType",
    (rt: any, name: string, base: string, error: any) => create_type(rt, name, base, [], error));
  // names [, values [, colours] [, descriptions]]
  for (const [params, fields] of [
    [[], []],
    [["int[]"], ["numbers"]],
    [["int[]", "int[]"], ["numbers", "colours"]],
    [["int[]", "string[]"], ["numbers", "descriptions"]],
    [["int[]", "int[]", "string[]"], ["numbers", "colours", "descriptions"]]] as [string[], string[]][]) {
    lib.add("create", ["string", "string[]", ...params, "&string"], "AttrType",
      (rt: any, name: string, codes: string[], ...rest: any[]) => {
        const error = rest.pop();
        const given = Object.fromEntries(fields.map((f, i) => [f, whole(rest[i], f)]));
        return create_type(rt, name, "Enumeration", whole(codes, "names"), error,
          { ...given, real_colours: fields.includes("colours") && real_colours(rt) });
      });
  }
  for (const [number, base] of [["int", "Integer"], ["real", "Real"]]) {
    lib.add("create", ["string", number, number, "&string"], "AttrType",
      (rt: any, name: string, min: number, max: number, error: any) =>
        create_type(rt, name, base, [], error, { min: String(min), max: String(max) }));
    for (const [call, field] of [["setMinValue", "min"], ["setMaxValue", "max"]]) {
      lib.add(call, ["AttrType", number, "bool"], "bool", (rt: any, t: any, value: number, applies: boolean) => {
        const module_id = type_to_change(rt, t);
        const now = rt.store.types(module_id).find((x: any) => x.name === t.name);
        if (now.base !== base) throw new Fault(`${call}: ${_repr(t.name)} is not a ${base} type`);
        if (!applies) {
          // "ignored": with a limit already set, that could mean it stays or goes
          if (now[field] !== "") {
            throw new Fault(`${call}: whether false removes the limit the type already has is not documented`);
          }
          return true;
        }
        return !attempt(() => rt.store.modify_type(module_id, t.name, { [field]: String(value) }));
      });
    }
  }
  register_type_changes(lib);

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
  check_source(rt, module_id, "create baseline");
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

/** `baseline(modver)`: only the version's major, minor and suffix are filled in. */
export class Designation extends Wanted {}

const DESIGNATION = new Set(["major", "minor", "suffix"]);

export function read_baseline(field: string): (rt: any, baseline: any) => any {
  return (rt: any, baseline: any) => {
    if (rt.need(baseline, "Baseline") instanceof Designation && DESIGNATION.has(field)) {
      return (baseline as any)[field];
    }
    if (!(baseline instanceof Baseline)) {
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
    ["suffix", "suffix", "string"], ["user", "created_by", "string"]]) {
    lib.add(name, ["Baseline"], returns, read_baseline(field));
  }
  const annotation = read_baseline("annotation");
  lib.add("annotation", ["Baseline"], "string", (rt: any, b: any) => {
    const text = annotation(rt, b);
    const set = rt.store.baseline_set_of(b.copy_id);
    if (set && rt.store.set_definition(set.folder, set.id).sets[set.index].annotation) {
      throw new Fault("whether a baseline made in a baseline set takes the set's annotation is not documented");
    }
    return text;
  });
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
  // a ModuleVersion of a current version is no baseline
  lib.add("baseline", ["ModuleVersion"], "Baseline", (rt: any, v: any) => {
    const found = rt.store.baseline_of(rt.need(v, "ModuleVersion"));
    return found ? new Designation(found.major, found.minor, found.suffix) : null;
  });
  lib.add("baselineExists", ["ModuleVersion"], "bool",
    (rt: any, v: any) => Boolean(rt.store.baseline_of(rt.need(v, "ModuleVersion"))));
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
  check_source(rt, module_id, "history", absno);
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

// `modified(o)`: changed since the module's last baseline. True where an attribute
// edit is on record since then, false where nothing at all has touched the object.
// Whether being created, moved, deleted or linked counts is not documented.
function modified_since_baseline(rt: any, o: any): boolean {
  const module_id = rt.obj(o).module_id;
  if (rt.store.is_baseline(module_id)) throw new Fault("modified(Object) in a baseline is not documented");
  const last = rt.store.baselines(module_id).at(-1);
  if (!last) throw new Fault("what modified(Object) gives in a module with no baseline is not documented");
  const module_history = history(rt, module_id);
  const mark = module_history.findLast((h: any) =>
    h.action === "createBaseline" && h.new === `${last.major}.${last.minor}`);
  if (!mark) throw new Fault("modified(Object): the history does not show when the last baseline was made");
  const since = history(rt, module_id, o.absno).filter((h: any) => h.seq > mark.seq);
  if (since.some((h: any) => h.action === "createObject" || h.action === "copyObject")) {
    throw new Fault("whether modified(Object) is true of an object created since the last baseline "
      + "is not documented");
  }
  if (since.some((h: any) => h.action === "modifyObject")) return true;
  if (since.length || rt.store._object_row(o).changed_seq > mark.seq) {
    throw new Fault("this object has changed since the last baseline, but not by an attribute edit, and "
      + "whether modified(Object) counts that is not documented");
  }
  const unseen = rt.store.attributes(module_id, "object").some((a: any) => !a.history || a.inherit)
    || module_history.some((h: any) => h.seq > mark.seq
      && ["modifyAttr", "deleteAttr", "modifyType", "deleteType"].includes(h.action));
  if (unseen) {
    throw new Fault("modified(Object): this object's values may have changed without a history record "
      + "(an attribute without history or inherited, or a changed definition)");
  }
  return false;
}

export function register_history(lib: any): void {
  lib.add("modified", ["Object"], "bool", modified_since_baseline);
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

  lib.prop("History", "sessionNo", "int", () => {
    throw new Fault("History.sessionNo: how DOORS numbers it is not documented");
  });

  lib.add("lastModifiedTime", ["Object"], "Date",
    (rt: any, o: any) => date(rt, rt.store.value(rt.obj(o), "Last Modified On")));
}

export function register(lib: any): void {
  register_attributes(lib);
  register_baselines(lib);
  register_history(lib);
}
