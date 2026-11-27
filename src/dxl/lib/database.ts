// The DOORS database: folders, projects, modules, objects, attribute values, links.
//
// Handles: Folder, Project, Item, Module and ModName_ are item ids; Object is
// store.Obj; Link is store.Link. Types ending in "_" are the helpers DXL writes as
// `below(o)`, `entire(m)` and so on; scripts cannot declare them.
//
// The "display set" DOORS loops follow is every object that is not deleted, as
// filtered and sorted by the script (displayset.ts).

import { invalid_char } from "./setup.ts";
import { ROOT, StoreError } from "../../store.ts";
import { assign_own, computing, reset_value } from "../attribute.ts";
import type { Link, Obj } from "../../store.ts";
import { check_end, check_link, check_new, check_source, flush, link_deleted, live_link, module_saved } from "./pending.ts";
import { Fault, ValueError, equals, is_limit, limit } from "../runtime.ts";
import type { AttrRef, Ref, Runtime } from "../runtime.ts";
import type { Library } from "../registry.ts";
import { accepted_objects, arranged, sorting, unfiltered_only } from "./displayset.ts";
import { set_visible } from "./views.ts";
import { date } from "./management.ts";

export const ITEM_HANDLES = ["Item", "Folder", "Project", "ModName_"]; // may name something closed
export const NAMED = [...ITEM_HANDLES, "Module"];
export const MANY_TO_MANY = 0;
export const MAPPINGS = ["manyToMany", "manyToOne", "oneToMany", "oneToOne"];

// `build()`, remembered until the database next changes.
export function cached(rt: Runtime, key: string, build: () => any): any {
  const stamp = rt.store.total_changes;
  let found = rt.state.get(key);
  if (found === undefined || found === null || found[0] !== stamp) {
    found = [stamp, build()];
    rt.state.set(key, found);
  }
  return found[1];
}

// -- hierarchy ----------------------------------------------------------------

export function parent_id(rt: Runtime, item_id: number): number | null {
  return rt.store.item(item_id).parent;
}

// The nearest project at or above `item_id`, or null. `current Project`
// arrives as the current folder, so every Project value goes through this.
export function project_of(rt: Runtime, item_id: number | null): number | null {
  while (item_id !== null) {
    const item = rt.store.item(item_id);
    if (item.kind === "project") return item_id;
    item_id = item.parent;
  }
  return null;
}

// The item id behind a non-null handle of one of the NAMED types.
export function handle(rt: Runtime, type_name: string, value: any): number {
  rt.need(value, type_name);
  if (type_name === "Project") return rt.need(project_of(rt, value), "Project");
  return value;
}

// The item id at `name` (relative to the current folder), or null.
export function find(rt: Runtime, name: string, kinds: string[] | null = null): number | null {
  const found = name ? rt.store.find(name, rt.folder) ?? null : null;
  if (found === null || (kinds && !kinds.includes(rt.store.item(found).kind))) return null;
  return found;
}

// The item whose uniqueID (as spelled here) is `id`, or null.
export function item_from_id(rt: Runtime, id: string): number | null {
  if (!/^[0-9a-f]{8}$/.test(id)) return null;
  const found = parseInt(id, 16);
  if (!rt.store.has_item(found) || rt.store.is_baseline(found)) return null;
  if (item_deleted(rt, found)) throw new Fault("itemFromID of a deleted item is not offered here");
  return found;
}

// [parent folder path, leaf] for something about to be created.
export function split_name(rt: Runtime, name: string): [string, string] {
  const at = name.lastIndexOf("/");
  const head = at < 0 ? "" : name.slice(0, at);
  const slash = at < 0 ? "" : "/";
  const leaf = name.slice(at + 1);
  const parent = head ? find(rt, head) : (slash ? ROOT : rt.folder);
  if (parent === null) throw new Fault(`no folder ${_repr(head)}`);
  dxl_name(leaf);
  return [rt.store.path(parent), leaf];
}

/** A name DOORS would not take must not be made here. */
function dxl_name(name: string): void {
  const bad = invalid_char(name);
  if (bad !== "\0") throw new Fault(`${_repr(name)}: DOORS does not allow ${_repr(bad)} in a project, folder, or module name`);
}

export function item_deleted(rt: Runtime, item_id: number | null): boolean {
  while (item_id !== null) {
    const item = rt.store.item(item_id);
    if (item.deleted) return true;
    item_id = item.parent;
  }
  return false;
}

export function item_type(rt: Runtime, item_id: number): string {
  const names: Record<string, string> = { folder: "Folder", project: "Project", formal: "Formal", link: "Link" };
  return names[rt.store.item(item_id).kind];
}

// For the DOORS calls that return an error message, null on success.
export function attempt(change: () => any): string {
  try {
    change();
  } catch (e) {
    // a limit of this suite is no answer of DOORS's: it stops the script
    if (!(e instanceof StoreError) || is_limit(e.message)) throw e;
    return e.message;
  }
  return "";
}

export function delete_item(rt: Runtime, item_id: number, deleted = true): string {
  const change = () => {
    if (Boolean(rt.store.item(item_id).deleted) === deleted) {
      throw new StoreError(`${rt.store.path(item_id)} is ${deleted ? "already" : "not"} deleted`);
    }
    rt.store.delete_item(item_id, deleted);
  };
  return attempt(change);
}

export function open_modules(rt: Runtime, wanted: (m: number) => boolean): number[] {
  return (Array.from(rt.opened.keys()) as number[]).filter((m) => wanted(m));
}

export function in_project(rt: Runtime, module_id: number, project: number): boolean {
  return project_of(rt, parent_id(rt, module_id)) === project;
}

// `purge(x)` and `hardDelete(m)`: gone for good, and the handle becomes null.
// Both need it soft-deleted already, as the manual has it.
function purge_item(rt: Runtime, ref: Ref): string {
  const item_id = rt.need(ref.get(), "handle");
  if (open_modules(rt, () => true).some((m) => m === item_id || rt.store.path(m).startsWith(
    rt.store.path(item_id) + "/"))) {
    throw new Fault("close the modules in it before purging it");
  }
  for (let at: number | null = rt.folder; at !== null; at = parent_id(rt, at)) {
    if (at === item_id) throw new Fault("the current folder is inside what would be purged");
  }
  const message = attempt(() => rt.store.purge_item(item_id));
  if (!message) ref.set(null);
  return message;
}

function register_removal(lib: Library): void {
  for (const type_name of ["Item", "Folder", "Project", "ModName_"]) {
    lib.add("purge", ["&" + type_name], "string", purge_item);
  }
  lib.add("hardDelete", ["&ModName_"], "bool", (rt: Runtime, ref: Ref) => !purge_item(rt, ref));

  const convert = (rt: Runtime, item_id: any, project: boolean, ref: Ref) => attempt(() => {
    rt.store.set_project(rt.need(item_id, project ? "Folder" : "Project"), project);
    ref.set(item_id);
  });
  lib.add("convertFolderToProject", ["Folder", "&Project"], "string",
    (rt: Runtime, f: any, ref: Ref) => convert(rt, f, true, ref));
  lib.add("convertProjectToFolder", ["Project", "&Folder"], "string",
    (rt: Runtime, p: any, ref: Ref) => convert(rt, handle(rt, "Project", p), false, ref));
}

export function register_hierarchy(lib: Library): void {
  register_removal(lib);
  for (const type_name of ["Folder", "Project", "Item", "Database_", "AllFolder_"]) lib.type(type_name);

  for (const t of NAMED) {
    const on = (fn: any) => (rt: Runtime, value: any, ...rest: any[]) => fn(rt, handle(rt, t, value), ...rest);

    lib.add("name", [t], "string", on((rt: Runtime, i: number) => rt.store.item(i).name));
    lib.add("fullName", [t], "string", on((rt: Runtime, i: number) => rt.store.path(i)));
    // kept through rename and move; the manual leaves its spelling open, so only compare it
    lib.add("uniqueID", [t], "string", on((rt: Runtime, i: number) => {
      if (rt.store.is_baseline(i)) throw new Fault("uniqueID of a baseline is not offered here");
      return i.toString(16).padStart(8, "0");
    }));
    lib.add("path", [t], "string", on((rt: Runtime, i: number) => rt.store.path(parent_id(rt, i) || ROOT)));
    lib.add("description", [t], "string", on((rt: Runtime, i: number) => rt.store.item(i).description));
    lib.add("getParentFolder", [t], "Folder", on(parent_id));
    lib.add("getParentProject", [t], "Project",
      on((rt: Runtime, i: number) => project_of(rt, parent_id(rt, i))));
    if (t !== "Project") lib.add("type", [t], "string", on(item_type));
  }

  for (const t of ITEM_HANDLES) {
    const on = (fn: any) => (rt: Runtime, value: any, ...rest: any[]) => fn(rt, handle(rt, t, value), ...rest);

    lib.add("isDeleted", [t], "bool", on(item_deleted));
    lib.add("undelete", [t], "string", on((rt: Runtime, i: number) => delete_item(rt, i, false)));
    lib.add("rename", [t, "string", "string"], "string",
      on((rt: Runtime, i: number, name: string, desc: string) => {
        dxl_name(name);
        return attempt(() => rt.store.set_item(i, name, desc));
      }));
    if (t !== "ModName_") lib.add("delete", [t], "string", on(delete_item));
  }
  lib.add("softDelete", ["ModName_"], "bool",
    (rt: Runtime, i: any) => !delete_item(rt, rt.need(i, "ModName_")));

  lib.add("item", ["string"], "Item", find);
  lib.add("itemFromID", ["string"], "Item", item_from_id);
  lib.add("folder", ["string"], "Folder", (rt: Runtime, s: string) => find(rt, s, ["folder", "project"]));
  lib.add("folder", ["Item"], "Folder",
    (rt: Runtime, i: any) => ["folder", "project"].includes(rt.store.item(rt.need(i, "Item")).kind) ? i : null);
  lib.add("project", ["string"], "Project", (rt: Runtime, s: string) => find(rt, s, ["project"]));
  lib.add("folder", ["string"], "bool", (rt: Runtime, s: string) => find(rt, s, ["folder", "project"]) !== null);
  lib.add("project", ["string"], "bool", (rt: Runtime, s: string) => find(rt, s, ["project"]) !== null);
  lib.add("module", ["string"], "bool", (rt: Runtime, s: string) => find(rt, s, ["formal", "link"]) !== null);
  lib.add("module", ["string"], "ModName_", (rt: Runtime, s: string) => find(rt, s, ["formal", "link"]));
  lib.add("module", ["Item"], "Module", (rt: Runtime, i: any) => rt.opened.has(rt.need(i, "Item")) ? i : null);

  // -- loops
  lib.add("database", [], "Database_", (rt: Runtime) => ROOT);
  // the DOORS user, who history and "Created By" record; not the operating system's
  lib.add("doorsname", [], "string", (rt: Runtime) => rt.store.user);
  lib.add("all", ["Folder"], "AllFolder_", (rt: Runtime, f: any) => rt.need(f, "Folder"));
  lib.loop("Folder", "Item",
    (rt: Runtime, f: any) => Array.from(rt.store.children(rt.need(f, "Folder")), (i: any) => i.id));
  lib.loop("AllFolder_", "Item",
    (rt: Runtime, f: number) => Array.from(rt.store.children(f, true), (i: any) => i.id));
  lib.loop("Project", "Item",
    (rt: Runtime, p: any) => Array.from(rt.store.walk(handle(rt, "Project", p)), (i: any) => i.id));
  lib.loop("Database_", "Project", (rt: Runtime, d: number) =>
    Array.from(rt.store.walk() as Iterable<any>).filter((i) => i.kind === "project").map((i) => i.id));

  function* project_names(rt: Runtime, folder: number): Generator<string> {
    for (const item of rt.store.children(folder, true)) {
      if (item.kind === "project") yield item.name;
      if (item.kind === "folder" || item.kind === "project") yield* project_names(rt, item.id);
    }
  }

  lib.loop("Database_", "string", project_names);
  lib.loop("Database_", "Module", (rt: Runtime, d: number) => open_modules(rt, (m) => true));
  lib.loop("Folder", "Module", (rt: Runtime, f: any) =>
    open_modules(rt, (m) => parent_id(rt, m) === rt.need(f, "Folder")));
  lib.loop("Project", "Module", (rt: Runtime, p: any) =>
    open_modules(rt, (m) => in_project(rt, m, handle(rt, "Project", p))));
  lib.loop("Project", "string", (rt: Runtime, p: any) =>
    Array.from(rt.store.children(handle(rt, "Project", p)) as Iterable<any>)
      .filter((i) => i.kind === "formal" || i.kind === "link").map((i) => i.name));

  // -- creation
  for (const [kind, type_name] of [[false, "Folder"], [true, "Project"]] as Array<[boolean, string]>) {
    const make = (rt: Runtime, name: string, desc: string) => {
      const [parent, leaf] = split_name(rt, name);
      return rt.store.create_folder(parent, leaf, desc, kind);
    };

    const make_into = (rt: Runtime, name: string, desc: string, ref: Ref) =>
      attempt(() => ref.set(make(rt, name, desc)));

    lib.add("create", ["string", "string"], type_name, make);
    lib.add("create", ["string", "string", "&" + type_name], "string", make_into);
  }

  const close_folder = (rt: Runtime) => {
    if (rt.folder === ROOT) return "the current folder is the database root";
    rt.folder = parent_id(rt, rt.folder)!;
    return "";
  };

  lib.add("closeFolder", [], "string", close_folder);
}

// -- modules ------------------------------------------------------------------

export function open_as(mode: string) {
  const open_module = (rt: Runtime, name: string, ...flags: boolean[]) => {
    const found = find(rt, name, ["formal", "link"]);
    if (found === null) return null;
    if (rt.store.item(found).kind === "link") {
      throw new Fault(`opening a link module (${name}) is not supported here`);
    }
    if (mode !== "read" && !rt.store.may_edit(found)) {
      throw new Fault(`${name}: ${rt.store.user} may not change anything in this module, and what DOORS does when it `
        + `is then opened with ${mode}() is not documented; open it with read()`);
    }
    const fresh = !rt.opened.has(found);
    const held = rt.opened.get(found);
    if (held !== undefined && held !== mode && rt.for_depth) {
      throw new Fault(`${name} is open in ${held} mode, and DOORS does not allow it to be opened in ${mode} `
        + "mode inside a for loop: open it before the loop, or test open(ModName_) first");
    }
    rt.open(found, mode);
    if (fresh && mode !== "read" && !rt.store.is_baseline(found)) rt.store.record_session(found);
    set_visible(rt, found, flags[0] !== false, fresh); // the first flag: display
    return found;
  };
  return open_module;
}

export function close(rt: Runtime, module_id: any, save: boolean | null = null): boolean {
  rt.need(module_id, "Module");
  if (!rt.opened.has(module_id)) return false;
  if (save === null && rt.modified.has(module_id)) {
    throw new Fault("whether close(m) alone saves the unsaved changes is not documented; "
      + "save(m) first, or write close(m, true)");
  }
  if (save === false && rt.modified.has(module_id)) {
    throw new Fault("DOORS would discard the unsaved changes here, but this stand-in has already "
      + "stored them; save() before close()");
  }
  check_source(rt, module_id, "close");
  rt.opened.delete(module_id);
  if (rt.module === module_id) rt.module = null;
  if (rt.object !== null && rt.object.module_id === module_id) rt.object = null;
  return true;
}

export function save(rt: Runtime, module_id: any): void {
  rt.opened_module(module_id);
  if (rt.opened.get(module_id) === "read" || rt.store.is_baseline(module_id)) {
    throw new Fault("the module is open read-only and cannot be saved");
  }
  rt.modified.delete(module_id);
  module_saved(rt, module_id);
}

export function create_formal(rt: Runtime, name: string, desc: string, prefix: string, absno: number,
  display = true): any {
  if (absno !== 1) throw new Fault("only a starting absolute number of 1 is supported here");
  const [parent, leaf] = split_name(rt, name);
  const made = rt.open(rt.store.create_module(parent, leaf, desc, prefix), "edit");
  rt.store.record_session(made);
  set_visible(rt, made, display, true);
  return made;
}

export function create_link_module(rt: Runtime, name: string, desc: string, mapping: number,
  display = false): any {
  if (mapping !== MANY_TO_MANY) throw new Fault("only manyToMany link modules are supported here");
  const [parent, leaf] = split_name(rt, name);
  return rt.store.create_link_module(parent, leaf, desc);
}

// Failing for a taken name or for want of access returns false, as DOORS can
// only; what this suite cannot copy faithfully stops the script.
function copy_module(rt: Runtime, m: any, name: string, description: string): boolean {
  const module: number = rt.need(m, "ModName_");
  if (rt.modified.has(module)) {
    throw new Fault("copy: the module has unsaved changes, which DOORS would leave out; save it first");
  }
  check_source(rt, module, "copy");
  dxl_name(name);
  const message = attempt(() => rt.store.copy_module(module, name, description));
  if (message === "" || message.startsWith("no access:") || message.endsWith("already exists")) return message === "";
  throw limit(`copy: ${message}`);
}

export function register_modules(lib: Library): void {
  lib.type("Module");
  lib.type("ModName_");

  for (const [name, mode, most] of [["read", "read", 2], ["edit", "edit", 3], ["share", "share", 3]] as
    Array<[string, string, number]>) {
    for (let flags = 0; flags <= most; flags++) {
      lib.add(name, ["string", ...Array(flags).fill("bool")], "Module", open_as(mode));
    }
  }
  lib.add("close", ["Module"], "bool", close);
  lib.add("close", ["Module", "bool"], "bool", close);
  lib.add("save", ["Module"], "void", save);
  lib.add("copy", ["ModName_", "string", "string"], "bool", copy_module);

  lib.add("exists", ["ModName_"], "bool", (rt: Runtime, m: any) => !item_deleted(rt, rt.need(m, "ModName_")));
  lib.add("open", ["ModName_"], "bool", (rt: Runtime, m: any) => rt.opened.has(rt.need(m, "ModName_")));
  lib.add("unsaved", ["Module"], "bool", (rt: Runtime, m: any) => rt.modified.has(rt.opened_module(m)));
  for (const [name, mode] of [["isRead", "read"], ["isEdit", "edit"], ["isShare", "share"]]) {
    lib.add(name, ["Module"], "bool", (rt: Runtime, m: any) => rt.opened.get(rt.opened_module(m)) === mode);
  }

  MAPPINGS.forEach((name, value) => {
    lib.add(name, [], "int", (rt: Runtime) => value);
  });
  for (const display of [[], ["bool"]] as string[][]) {
    lib.add("create", ["string", "string", "string", "int", ...display], "Module", create_formal);
    lib.add("create", ["string", "string", "int", ...display], "Module", create_link_module);
  }
  lib.add("create", ["string", "string", "string", "int", "&Module"], "string",
    (rt: Runtime, name: string, desc: string, prefix: string, absno: number, ref: Ref) =>
      attempt(() => ref.set(create_formal(rt, name, desc, prefix, absno))));
  lib.add("create", ["string", "string", "int", "&Module"], "string",
    (rt: Runtime, name: string, desc: string, mapping: number, ref: Ref) =>
      attempt(() => ref.set(create_link_module(rt, name, desc, mapping))));
}

// -- objects ------------------------------------------------------------------

// [every object of the module in document order, Map {object key: position},
// Set of deleted object keys, Map {parent absno: children}].
export function tree(rt: Runtime, module_id: number):
  [Obj[], Map<string, number>, Set<string>, Map<number | null, Obj[]>] {
  const build = () => {
    const store = rt.store;
    const everything: Obj[] = store.objects(module_id, true);
    const shown = new Set<string>(Array.from(store.objects(module_id) as Obj[], (o) => o.key));
    const children = new Map<number | null, Obj[]>();
    for (const obj of everything) {
      const up = store.parent_object(obj);
      const key = up ? up.absno : null;
      let row = children.get(key);
      if (row === undefined) children.set(key, row = []);
      row.push(obj);
    }
    const position = new Map<string, number>(everything.map((o, i) => [o.key, i]));
    const deleted = new Set<string>(everything.filter((o) => !shown.has(o.key)).map((o) => o.key));
    return [everything, position, deleted, children];
  };
  return cached(rt, `tree:${module_id}`, build);
}

export function entire(rt: Runtime, module_id: any): Obj[] {
  return tree(rt, rt.opened_module(module_id))[0];
}

export function shown(rt: Runtime, module_id: any): Obj[] {
  const [everything, , deleted] = tree(rt, rt.opened_module(module_id));
  return everything.filter((o) => !deleted.has(o.key));
}

// What `for o in module` visits.
export function displayed(rt: Runtime, module_id: any): Obj[] {
  return arranged(rt, module_id, shown(rt, module_id));
}

export function end_of_display(rt: Runtime, module_id: any, index: number): Obj | null {
  if (sorting(rt, rt.opened_module(module_id))) {
    throw new Fault("first/last of a sorted module is not supported here; use a loop");
  }
  const found = displayed(rt, module_id);
  return found.length ? found.at(index)! : null;
}

export function children_of(rt: Runtime, module_id: any, absno: number | null = null): Obj[] {
  const [, , deleted, children] = tree(rt, module_id);
  return (children.get(absno) ?? []).filter((o) => !deleted.has(o.key));
}

export function child_objects(rt: Runtime, obj: any): Obj[] {
  rt.obj(obj);
  return children_of(rt, obj.module_id, obj.absno);
}

// `for c in o` ignores filters, as documented.
export function loop_children(rt: Runtime, obj: any): Obj[] {
  if (sorting(rt, rt.obj(obj).module_id)) {
    throw new Fault("looping over an object's children while sorting is on is not supported here");
  }
  return child_objects(rt, obj);
}

export function navigable_children(rt: Runtime, obj: any): Obj[] {
  unfiltered_only(rt, rt.obj(obj).module_id, "navigating to a child");
  return child_objects(rt, obj);
}

export function top_child(rt: Runtime, module_id: any, n: number): Obj | null {
  unfiltered_only(rt, rt.opened_module(module_id), "indexing a module");
  return pick(children_of(rt, module_id), n - 1);
}

export function pick<T>(objects: T[], index: number): T | null {
  return 0 <= index && index < objects.length ? objects[index] : null;
}

// The next (+1) or previous (-1) object not deleted, in document order.
export function step(rt: Runtime, obj: any, direction: number): Obj | null {
  rt.obj(obj);
  if (sorting(rt, obj.module_id)) {
    throw new Fault("next/previous in a sorted module is not supported here; use a loop");
  }
  const [everything, position] = tree(rt, obj.module_id);
  const visible = new Set<string>(
    accepted_objects(rt, obj.module_id, shown(rt, obj.module_id)).map((o: Obj) => o.key));
  let i = _position(position, obj) + direction;
  while (0 <= i && i < everything.length) {
    if (visible.has(everything[i].key)) return everything[i];
    i += direction;
  }
  return null;
}

export function sibling_step(rt: Runtime, obj: any, direction: number): Obj | null {
  unfiltered_only(rt, rt.obj(obj).module_id, "sibling navigation");
  const up = rt.store.parent_object(rt.obj(obj));
  const [, , deleted, children] = tree(rt, obj.module_id);
  let row = children.get(up ? up.absno : null) ?? [];
  row = row.filter((o) => o.equals(obj) || !deleted.has(o.key));
  const at = row.findIndex((o) => o.equals(obj));
  if (at < 0) throw new ValueError("the object is not in list");
  return pick(row, at + direction);
}

export function sibling_end(rt: Runtime, obj: any, index: number): Obj | null {
  unfiltered_only(rt, rt.obj(obj).module_id, "sibling navigation");
  const up = rt.store.parent_object(rt.obj(obj));
  const row = children_of(rt, obj.module_id, up ? up.absno : null);
  return row.length ? row.at(index)! : null;
}

export function number(rt: Runtime, obj: any): string {
  rt.obj(obj);
  const numbers = cached(rt, `numbers:${obj.module_id}`, () => rt.store.numbers(obj.module_id));
  return numbers.get(obj.absno) ?? "";
}

export function current_object(rt: Runtime, module_id: any): Obj | null {
  return rt.current_object(rt.opened_module(module_id));
}

export function current_module(rt: Runtime): any {
  return rt.opened_module(rt.module);
}

export function object_by_number(rt: Runtime, absno: number, module_id: any): Obj | null {
  return rt.store.object(rt.opened_module(module_id), absno);
}

// `where`: Map with "parent", "after" or "before" -> Obj.
export function new_object(rt: Runtime, module_id: any, where: Map<string, Obj | null> = new Map()): Obj {
  rt.editing(module_id);
  return rt.store.create_object(module_id, where.get("parent") ?? null, where.get("after") ?? null,
    where.get("before") ?? null);
}

export function create_first(rt: Runtime, module_id: any): Obj {
  rt.opened_module(module_id);
  const top = rt.store.child_objects(module_id);
  return new_object(rt, module_id, new Map([["before", top.length ? top[0] : null]]));
}

export function create_after(rt: Runtime, obj: any): Obj {
  return new_object(rt, rt.obj(obj).module_id, new Map([["after", obj]]));
}

export function create_before(rt: Runtime, obj: any): Obj {
  return new_object(rt, rt.obj(obj).module_id, new Map([["before", obj]]));
}

export function first_below(rt: Runtime, obj: any): Map<string, Obj> {
  const kids = rt.store.child_objects(rt.obj(obj).module_id, obj.absno);
  return kids.length ? new Map([["before", kids[0]]]) : new Map([["parent", obj]]);
}

export function create_first_below(rt: Runtime, obj: any): Obj {
  return new_object(rt, rt.obj(obj).module_id, first_below(rt, obj));
}

export function create_last_below(rt: Runtime, obj: any): Obj {
  return new_object(rt, rt.obj(obj).module_id, new Map([["parent", obj]]));
}

export function move(rt: Runtime, obj: any, where: Map<string, Obj | null> = new Map()): void {
  rt.editing(rt.obj(obj).module_id);
  if (!equals(where.get("before") ?? null, obj)) {
    rt.store.move_object(obj, where.get("parent") ?? null, where.get("after") ?? null,
      where.get("before") ?? null);
  }
}

// The client will not delete an object with a link coming in, and the manual
// does not say what these calls do with one, or with the objects below one.
function deletable(rt: Runtime, obj: any, call: string, deleted_too: boolean): void {
  const name = rt.store.identifier(obj);
  check_end(rt, obj, false, "*", call);
  if (rt.store.links(obj, false).length) {
    throw new Fault(`${call}: ${name} has incoming links, which the DOORS client will not delete; what the DXL `
      + "call does then is not documented (delete those links and call flushDeletions() first)");
  }
  if (rt.store.child_objects(obj.module_id, obj.absno).some((c: Obj) => deleted_too || !rt.store.is_deleted(c))) {
    throw new Fault(`${call}: ${name} has objects below it, and what DOORS does with them is not documented `
      + "(delete them first, lowest first)");
  }
}

export function soft_delete(rt: Runtime, obj: any): void {
  rt.editing(rt.obj(obj).module_id);
  deletable(rt, obj, "softDelete", false);
  rt.store.delete_object(obj);
}

export function undelete_object(rt: Runtime, obj: any): string {
  rt.editing(rt.obj(obj).module_id);
  return attempt(() => rt.store.undelete_object(obj));
}

export function purge_objects(rt: Runtime, module_id: any): string {
  rt.editing(module_id);
  return attempt(() => rt.store.purge(module_id));
}

export function set_selection(rt: Runtime, start: any, finish: any): void {
  rt.obj(start), rt.obj(finish);
  if (start.module_id !== finish.module_id
    || !equals(rt.store.parent_object(start), rt.store.parent_object(finish))) {
    throw new Fault("a selection must start and end on siblings");
  }
  let selections = rt.state.get("selection");
  if (selections === undefined) rt.state.set("selection", selections = new Map());
  selections.set(start.module_id, [start, finish]);
}

export function selection(rt: Runtime, module_id: any): [Obj | null, Obj | null] {
  const opened = rt.opened_module(module_id);
  return rt.state.get("selection")?.get(opened) ?? [null, null];
}

export function is_selected(rt: Runtime, obj: any): boolean {
  const [start, finish] = selection(rt, rt.obj(obj).module_id);
  if (start === null) return false;
  const [, position] = tree(rt, obj.module_id);
  if (!position.has(start.key) || !position.has(finish!.key)) return false;
  const [low, high] = [position.get(start.key)!, position.get(finish!.key)!].sort((a, b) => a - b);
  // the selected siblings and everything under them
  let up: Obj | null = obj;
  while (up !== null) {
    if (equals(rt.store.parent_object(up), rt.store.parent_object(start))) {
      const at = _position(position, up);
      return low <= at && at <= high;
    }
    up = rt.store.parent_object(up);
  }
  return false;
}

export function get_selection(rt: Runtime, module_id: any, start: Ref, finish: Ref): void {
  const [first, last] = selection(rt, module_id);
  start.set(first);
  finish.set(last);
}

export function deselect_object(rt: Runtime, obj: any): void {
  if (is_selected(rt, obj)) rt.state.get("selection").delete(obj.module_id);
}

export function register_objects(lib: Library): void {
  lib.type("Object");

  // -- loops
  for (const [helper, type_name] of [["entire", "Entire_"], ["all", "All_"], ["document", "Document_"],
    ["top", "Top_"]]) {
    lib.type(type_name);
    lib.add(helper, ["Module"], type_name, (rt: Runtime, m: any) => rt.opened_module(m));
  }
  lib.loop("Module", "Object", displayed);
  lib.loop("Entire_", "Object", entire);
  lib.loop("All_", "Object", displayed);
  lib.loop("Document_", "Object", displayed);
  lib.loop("Top_", "Object", children_of);
  lib.loop("Object", "Object", loop_children);

  // -- navigation
  lib.add("first", ["Module"], "Object", (rt: Runtime, m: any) => end_of_display(rt, m, 0));
  lib.add("last", ["Module"], "Object", (rt: Runtime, m: any) => end_of_display(rt, m, -1));
  lib.add("first", ["Object"], "Object", (rt: Runtime, o: any) => pick(navigable_children(rt, o), 0));
  lib.add("last", ["Object"], "Object", (rt: Runtime, o: any) => navigable_children(rt, o).at(-1) ?? null);
  lib.add("next", ["Object"], "Object", (rt: Runtime, o: any) => step(rt, o, 1));
  lib.add("previous", ["Object"], "Object", (rt: Runtime, o: any) => step(rt, o, -1));
  lib.add("parent", ["Object"], "Object", (rt: Runtime, o: any) => rt.store.parent_object(rt.obj(o)));
  lib.type("Sibling_");
  lib.add("sibling", ["Object"], "Sibling_", (rt: Runtime, o: any) => rt.obj(o));
  lib.add("first", ["Sibling_"], "Object", (rt: Runtime, o: any) => sibling_end(rt, o, 0));
  lib.add("last", ["Sibling_"], "Object", (rt: Runtime, o: any) => sibling_end(rt, o, -1));
  lib.add("next", ["Sibling_"], "Object", (rt: Runtime, o: any) => sibling_step(rt, o, 1));
  lib.add("previous", ["Sibling_"], "Object", (rt: Runtime, o: any) => sibling_step(rt, o, -1));
  lib.index("Object", "int", "Object",
    (rt: Runtime, o: any, n: number) => pick(navigable_children(rt, o), n - 1));
  lib.index("Module", "int", "Object", top_child);

  lib.add("object", ["int"], "Object", (rt: Runtime, n: number) => object_by_number(rt, n, current_module(rt)));
  lib.add("object", ["int", "Module"], "Object", object_by_number);
  lib.add("module", ["Object"], "Module", (rt: Runtime, o: any) => rt.obj(o).module_id);

  // `current` on its own is the compiler's; these let it sit inside `identifier current`.
  lib.add("current", [], "Module", (rt: Runtime) => rt.module);
  lib.add("current", [], "Object", (rt: Runtime) => rt.object);
  lib.add("current", [], "Folder", (rt: Runtime) => rt.folder);
  // the project the current folder is in, so `null current Project` is true outside one
  lib.currents.set("Project", (rt: Runtime) => project_of(rt, rt.folder));
  lib.add("current", ["Module"], "Object", current_object);

  // -- information
  lib.add("identifier", ["Object"], "string", (rt: Runtime, o: any) => rt.store.identifier(rt.obj(o)));
  lib.add("level", ["Object"], "int", (rt: Runtime, o: any) => rt.store.level(rt.obj(o)));
  lib.add("number", ["Object"], "string", number);
  lib.add("isDeleted", ["Object"], "bool", (rt: Runtime, o: any) => rt.store.is_deleted(rt.obj(o)));
  lib.add("leaf", ["Object"], "bool", (rt: Runtime, o: any) => !child_objects(rt, o).length);
  for (const name of ["table", "row", "cell"]) { // there are no tables in this database
    lib.add(name, ["Object"], "bool", (rt: Runtime, o: any) => rt.obj(o) === null);
  }

  // -- management
  const places = [["after", "Object", "After_"], ["before", "Object", "Before_"],
    ["below", "Object", "Below_"], ["first", "Below_", "FirstBelow_"],
    ["last", "Below_", "LastBelow_"]];
  for (const [helper, takes, gives] of places) {
    lib.type(gives);
    lib.add(helper, [takes], gives, (rt: Runtime, o: any) => rt.obj(o));
  }
  for (const [param, impl] of [["Module", create_first], ["Object", create_after], ["After_", create_after],
    ["Before_", create_before], ["Below_", create_first_below],
    ["FirstBelow_", create_first_below], ["LastBelow_", create_last_below]] as
    Array<[string, (rt: Runtime, value: any) => Obj]>) {
    lib.add("create", [param], "Object", impl);
  }
  lib.add("move", ["Object", "Object"], "void",
    (rt: Runtime, o: any, to: any) => move(rt, o, new Map([["after", rt.obj(to)]])));
  lib.add("move", ["Object", "Below_"], "void", (rt: Runtime, o: any, to: any) => move(rt, o, first_below(rt, to)));
  lib.add("move", ["Object", "LastBelow_"], "void",
    (rt: Runtime, o: any, to: any) => move(rt, o, new Map([["parent", to]])));
  lib.add("softDelete", ["Object"], "void", soft_delete);
  lib.add("hardDelete", ["Object"], "void", (rt: Runtime, o: any) => {
    rt.editing(rt.obj(o).module_id);
    deletable(rt, o, "hardDelete", true);
    rt.store.purge_object(o);
    if (rt.object !== null && equals(rt.object, o)) rt.object = null;
  });
  lib.add("gotoObject", ["int", "Module"], "Object", (rt: Runtime, absno: number, m: any) => {
    const found = object_by_number(rt, absno, m);
    if (found !== null) rt._current.set(found.module_id, found);
    return found;
  });
  lib.add("undelete", ["Object"], "string", undelete_object);
  lib.add("purgeObjects_", ["Module"], "string", purge_objects);
  lib.add("flushDeletions", [], "void", flush);

  // -- selection
  lib.add("setSelection", ["Object"], "void", (rt: Runtime, o: any) => set_selection(rt, o, o));
  lib.add("setSelection", ["Object", "Object"], "void", set_selection);
  lib.add("getSelection", ["Module"], "Object", (rt: Runtime, m: any) => selection(rt, m)[0]);
  lib.add("getSelection", ["Module", "&Object", "&Object"], "void", get_selection);
  lib.add("isSelected", ["Object"], "bool", is_selected);
  lib.add("deselect", ["Object"], "void", deselect_object);
  lib.add("deselect", ["Module"], "void", (rt: Runtime, m: any) => {
    const opened = rt.opened_module(m);
    rt.state.get("selection")?.delete(opened);
  });
}

// -- attribute values ---------------------------------------------------------

export function get_object_value(rt: Runtime, obj: any, name: string): string {
  const value = rt.store.value(rt.obj(obj), name);
  // only an object older than the attribute's default holds nothing at all of its own
  if (value === "") {
    const definition = rt.store.attribute(obj.module_id, name);
    if (definition?.default && !definition.inherit && !rt.store.has_own_value(obj, name)) {
      throw new Fault(`${_repr(name)}: this object was there before the attribute had its default, and what DOORS `
        + "then shows is not documented; give it a value first");
    }
  }
  return value;
}

export function set_object_value(rt: Runtime, obj: any, name: string, text: string): void {
  if (computing(rt)) return assign_own(rt, rt.obj(obj), name, text);
  rt.editing(rt.obj(obj).module_id);
  if (text === "" && rt.store.attribute(obj.module_id, name)?.inherit) {
    throw new Fault(`${_repr(name)} is inherited, and whether an empty value is kept or the attribute goes back to `
      + "inheriting is not verified");
  }
  rt.store.set_value(obj, name, text);
}

// Link modules are only ever named, never opened, here.
export function readable_module(rt: Runtime, module_id: any): number {
  rt.need(module_id, "Module");
  if (rt.store.item(module_id).kind !== "link") rt.opened_module(module_id);
  return module_id;
}

export function get_module_value(rt: Runtime, module_id: any, name: string): string {
  readable_module(rt, module_id);
  if (name === "Created By" || name === "Created On") {
    return rt.store.item_info(module_id)[name === "Created On" ? 1 : 0];
  }
  if (name === "Last Modified By" || name === "Last Modified On") {
    if (rt.store.item(module_id).kind === "link") {
      throw new Fault(`${_repr(name)} of a link module is not supported here`);
    }
    return rt.store.module_modified(module_id)[name === "Last Modified On" ? 1 : 0];
  }
  return rt.store.module_value(module_id, name);
}

export function set_module_value(rt: Runtime, module_id: any, name: string, text: string): void {
  rt.editing(module_id);
  rt.store.set_module_value(module_id, name, text);
}

export function get_link_value(rt: Runtime, link: any, name: string): string {
  live_link(rt, link);
  const when = name === "Created On" || name === "Last Modified On" ? 1 : 0;
  if (!["Created By", "Created On", "Last Modified By", "Last Modified On"].includes(name)) {
    throw new Fault(`link attribute ${_repr(name)} is not supported here`);
  }
  check_link(rt, link, name);
  const info = rt.need(rt.store.link_info(link) ?? null, "Link (it was deleted)");
  if (!name.startsWith("Last")) return info[when];
  const modified = rt.store.link_modified(link);
  if (modified === null) {
    throw new Fault(`this link's suspicion has been cleared, and whether DOORS then changes its ${_repr(name)} `
      + "is not verified");
  }
  return modified[when];
}

export function set_link_value(rt: Runtime, link: any, name: string, text: string): void {
  throw new Fault(`link attribute ${_repr(name)} cannot be changed here`);
}

export function is_member(rt: Runtime, attribute: AttrRef, option: string): boolean {
  return (attribute.get() as string).split("\n").includes(option);
}

/** `o."Name" += "Option"` and `-=`: one option into or out of a multi-valued
 * enumeration. The result lists the options in the type's order. */
function change_option(symbol: string, adding: boolean) {
  return (rt: Runtime, attribute: AttrRef, option: string): void => {
    const held = attribute.get() as string; // checks the owner and the name
    const owner: any = attribute.owner;
    const definition = attribute.owner_type === "Link" ? null
      : rt.store.attribute(attribute.owner_type === "Module" ? owner : owner.module_id, attribute.name);
    if (!definition || definition.base !== "Enumeration" || !definition.multi) {
      throw new Fault(`(${symbol}) needs a multi-valued enumeration attribute; ${_repr(attribute.name)} is not one`);
    }
    if (!definition.values.includes(option)) {
      throw new Fault(`(${symbol}): ${_repr(option)} is not one of ${definition.values.join(", ")}`);
    }
    const chosen = new Set(held ? held.split("\n") : []);
    if (adding) chosen.add(option);
    else chosen.delete(option);
    attribute.set(definition.values.filter((v: string) => chosen.has(v)).join("\n"));
  };
}

/** The rich text of a value, only where it is certainly the value itself: this
 * database keeps no formatting, and how DOORS would mark up anything but
 * plain one-line ASCII is not verified. */
function plain_rich_text(rt: Runtime, attribute: AttrRef): string {
  const value = attribute.get() as string;
  if (!/^[ -~]*$/.test(value) || /[\\{}]/.test(value)) {
    throw new Fault(`rich text of ${_repr(attribute.name)}: only one line of plain ASCII without \\ { or } `
      + "is supported here");
  }
  return value;
}

function register_rich_text(lib: Library): void {
  for (const name of ["richText", "richTextWithOle", "richTextNoOle"]) {
    lib.add(name, ["attr"], "string", plain_rich_text);
  }
  lib.add("richText", ["attr", "bool"], "string", (rt: Runtime, a: AttrRef, font_table: boolean) => {
    if (font_table) throw new Fault("richText with a font table is not supported here");
    return plain_rich_text(rt, a);
  });
  // there are no OLE objects in this database
  lib.add("containsOle", ["attr"], "bool", (rt: Runtime, a: AttrRef) => { a.get(); return false; });
}

export function register_values(lib: Library): void {
  register_rich_text(lib);
  lib.add("getBoundedAttr", ["attr", "int"], "string", (rt: Runtime, a: AttrRef, n: number) => {
    const characters = Array.from(a.get() as string);
    if (n < 0) throw new Fault("getBoundedAttr: the number of characters cannot be negative");
    return characters.slice(0, n).join("");
  });
  lib.operator("+=", "attr", "string", "void", change_option("+=", true));
  lib.operator("-=", "attr", "string", "void", change_option("-=", false));
  lib.attributes("Object", get_object_value, set_object_value);
  lib.resets.set("Object", reset_value);
  lib.attributes("Module", get_module_value, set_module_value);
  lib.attributes("Link", get_link_value, set_link_value);
  lib.add("isMember", ["attr", "string"], "bool", is_member);
}

// -- links --------------------------------------------------------------------

// The path of an existing link module: a full path, or a name seen from the
// source module's folder.
export function link_module_for(rt: Runtime, source: any, name: string | null): string | null {
  if (name === null) return null;
  const found = rt.store.module_at(name, "link", parent_id(rt, source.module_id));
  if (found === null) throw new Fault(`no link module ${_repr(name)}`);
  return rt.store.path(found);
}

export function make_link(rt: Runtime, source: any, target: any, name: string | null = null): void {
  rt.obj(source), rt.obj(target);
  rt.editing(source.module_id); // links are stored with their source
  const path = link_module_for(rt, source, name);
  check_new(rt, source, target, path);
  rt.store.create_link(source, target, path);
}

// Incoming links only exist for DXL once their source module is loaded.
export function links(rt: Runtime, obj: any, name: string, outgoing: boolean): Link[] {
  check_end(rt, rt.obj(obj), outgoing, name, outgoing ? "->" : "<-");
  const found: Link[] = rt.store.links(rt.obj(obj), outgoing, name);
  return outgoing ? found : found.filter((l) => rt.opened.has(l.source.module_id));
}

// The module a handle belongs to: a baseline copy answers as its module.
export function versioned(rt: Runtime, module_id: number): number {
  const baseline = rt.store.baseline_of(module_id);
  return baseline ? baseline.module_id : module_id;
}

// Every incoming link, loaded or not.
export function incoming(rt: Runtime, obj: any, name: string, baselines = false): Link[] {
  check_end(rt, rt.obj(obj), false, name, "<-");
  return rt.store.links(rt.obj(obj), false, name, baselines);
}

// `for l in all(o <- "*")`: links from baselines too, if loaded.
export function loaded_incoming(rt: Runtime, obj: any, name: string): Link[] {
  return incoming(rt, obj, name, true).filter((l) => rt.opened.has(l.source.module_id));
}

export function source_modules(rt: Runtime, obj: any, name: string, baselines = false): number[] {
  return incoming(rt, obj, name, baselines).map((l) => versioned(rt, l.source.module_id));
}

export function loaded(rt: Runtime, obj: Obj): Obj | null {
  return rt.opened.has(obj.module_id) ? obj : null;
}

export function delete_link(rt: Runtime, link: any): void {
  rt.need(link, "Link");
  rt.editing(link.source.module_id);
  check_link(rt, link, "delete");
  live_link(rt, link);
  rt.store.delete_link(link);
  link_deleted(rt, link);
}

export function register_links(lib: Library): void {
  lib.type("Link");

  lib.arrow("->", "Object", "Link", (rt: Runtime, o: any, name: string) => links(rt, o, name, true));
  lib.arrow("<-", "Object", "Link", (rt: Runtime, o: any, name: string) => links(rt, o, name, false));
  lib.arrow("<-", "Object", "ModName_", source_modules);
  lib.arrow("<-", "Object", "string",
    (rt: Runtime, o: any, name: string) => source_modules(rt, o, name).map((m) => rt.store.item(m).name));
  lib.type("LinkRef");
  lib.arrow("<-", "Object", "LinkRef", incoming);

  // the `all( )` forms add links that involve baselines
  lib.arrow("all->", "Object", "Link", (rt: Runtime, o: any, name: string) => links(rt, o, name, true));
  lib.arrow("all<-", "Object", "Link", loaded_incoming);
  lib.arrow("all<-", "Object", "LinkRef", (rt: Runtime, o: any, name: string) => incoming(rt, o, name, true));
  lib.arrow("all<-", "Object", "ModName_",
    (rt: Runtime, o: any, name: string) => source_modules(rt, o, name, true));
  lib.arrow("all<-", "Object", "string",
    (rt: Runtime, o: any, name: string) => source_modules(rt, o, name, true).map((m) => rt.store.item(m).name));

  // `a -> b`, `a -> "name" -> b` and the `<-` forms. The parser does not read
  // these as statements yet; the meanings are ready for when it does.
  lib.operator("->", "Object", "Object", "void", make_link);
  lib.operator("<-", "Object", "Object", "void", (rt: Runtime, to: any, source: any) => make_link(rt, source, to));
  for (const arrow of ["->", "<-"]) {
    const half = arrow === "->" ? "OutHalf_" : "InHalf_";
    lib.type(half);
    lib.operator(arrow, "Object", "string", half, (rt: Runtime, o: any, name: string) => [o, name]);
  }
  lib.operator("->", "OutHalf_", "Object", "void",
    (rt: Runtime, half: any, target: any) => make_link(rt, half[0], target, half[1]));
  lib.operator("<-", "InHalf_", "Object", "void",
    (rt: Runtime, half: any, source: any) => make_link(rt, source, half[0], half[1]));

  for (const [name, end] of [["source", (l: Link) => l.source], ["target", (l: Link) => l.target]] as
    Array<[string, (l: Link) => Obj]>) {
    const module_of = (rt: Runtime, link: any) => versioned(rt, end(live_link(rt, link)).module_id);

    lib.add(name, ["Link"], "Object", (rt: Runtime, l: any) => loaded(rt, end(live_link(rt, l))));
    // a LinkRef names where an incoming link comes from without loading it
    for (const kind of name === "source" ? ["Link", "LinkRef"] : ["Link"]) {
      lib.add(name, [kind], "ModName_", module_of);
      lib.add(name, [kind], "string", (rt: Runtime, l: any) => rt.store.item(module_of(rt, l)).name);
      lib.add(name + "AbsNo", [kind], "int", (rt: Runtime, l: any) => end(live_link(rt, l)).absno);
      lib.add(name + "Version", [kind], "ModuleVersion",
        (rt: Runtime, l: any) => end(live_link(rt, l)).module_id);
    }
  }
  lib.add("module", ["Link"], "Module", (rt: Runtime, l: any) => live_link(rt, l).link_module);
  lib.add("delete", ["Link"], "void", delete_link);
  // an echoed outlink: held by a baseline, to something outside that baseline
  // (there are no baseline sets here)
  lib.add("echo", ["Link"], "bool", (rt: Runtime, l: any) => {
    const from = live_link(rt, l).source.module_id;
    return rt.store.is_baseline(from) && l.target.module_id !== from;
  });
}

// ModuleVersion: the id of a module or of one of its baselines.
export function register_versions(lib: Library): void {
  lib.type("ModuleVersion");

  // history sessions: what a script may ask of one is its number, time and user
  lib.type("HistorySession");
  lib.loop("Module", "HistorySession", (rt: Runtime, m: any) => rt.store.sessions(rt.opened_module(m)));
  const session = (rt: Runtime, hs: any) => rt.need(hs, "HistorySession");
  lib.add("number", ["HistorySession"], "int", (rt: Runtime, hs: any) => session(rt, hs).number);
  lib.add("who", ["HistorySession"], "string", (rt: Runtime, hs: any) => session(rt, hs).user);
  lib.add("when", ["HistorySession"], "Date", (rt: Runtime, hs: any) => date(rt, session(rt, hs).date));

  const on = (fn: any) => (rt: Runtime, v: any, ...rest: any[]) => fn(rt, rt.need(v, "ModuleVersion"), ...rest);

  lib.add("module", ["ModuleVersion"], "ModName_", on(versioned));
  lib.add("name", ["ModuleVersion"], "string", on((rt: Runtime, v: number) => rt.store.item(v).name));
  lib.add("fullName", ["ModuleVersion"], "string", on((rt: Runtime, v: number) => rt.store.path(v)));
  lib.add("isBaseline", ["ModuleVersion"], "bool", on((rt: Runtime, v: number) => rt.store.is_baseline(v)));
  lib.add("data", ["ModuleVersion"], "Module", on((rt: Runtime, v: number) => rt.opened.has(v) ? v : null));
  lib.add("load", ["ModuleVersion", "bool"], "Module",
    (rt: Runtime, v: any, show: boolean) => v === null ? null : rt.open(v, "read"));

  lib.add("moduleVersion", ["Module"], "ModuleVersion", (rt: Runtime, m: any) => rt.opened_module(m));
  lib.add("moduleVersion", ["ModName_"], "ModuleVersion", (rt: Runtime, m: any) => rt.need(m, "ModName_"));
  lib.add("moduleVersion", ["ModName_", "Baseline"], "ModuleVersion", (rt: Runtime, m: any, wanted: any) => {
    rt.need(wanted, "Baseline");
    const found = rt.store.baselines(rt.need(m, "ModName_")).find((b: any) =>
      b.major === wanted.major && b.minor === wanted.minor && b.suffix === wanted.suffix);
    if (!found) throw new Fault("the module has no such baseline");
    return found.copy_id;
  });
  // "1.0" or "1.0(suffix)"; a current version has none, which DXL gives as null
  lib.add("versionString", ["ModuleVersion"], "string", on((rt: Runtime, v: number) => {
    const baseline = rt.store.baseline_of(v);
    if (!baseline) return "";
    return `${baseline.major}.${baseline.minor}` + (baseline.suffix ? `(${baseline.suffix})` : "");
  }));
}

export function register(lib: Library): void {
  register_modules(lib);
  register_objects(lib);
  register_hierarchy(lib);
  register_values(lib);
  register_links(lib);
  register_versions(lib);
}

// -- ordering and folding ----------------------------------------------------------

// position[obj]
function _position(position: Map<string, number>, obj: Obj): number {
  const found = position.get(obj.key);
  if (found === undefined) {
    const error = new Error(`Obj(module_id=${obj.module_id}, absno=${obj.absno})`);
    error.name = "KeyError";
    throw error;
  }
  return found;
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
