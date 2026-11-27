// The module window: columns, saved views, refresh, display state, and the
// can... predicates.
//
// A Column is a place in the loaded view: it stays good while the same column
// is still at the same position. A View names a saved view of one module. The
// saved definitions are the interface's (../../views.ts).
//
// There is one user here, who may do everything the database itself allows.
// Where DOORS behaviour is not documented, the script is stopped.

import { Obj, RIGHTS, _repr } from "../../store.ts";
import { STANDARD_VIEW, view_columns } from "../../views.ts";
import type { Justification, ViewColumn } from "../../views.ts";
import { check_layout, layout } from "../index.ts";
import type { Library } from "../registry.ts";
import { AttrRef, Fault } from "../runtime.ts";
import type { Runtime } from "../runtime.ts";
import { DxlError } from "../syntax.ts";
import { current_module, shown } from "./database.ts";
import { SYSTEM_BASES, accepted_objects, display, filtering, sorting } from "./displayset.ts";
import type { ViewWindow } from "./displayset.ts";
import { apply_filter, apply_sort } from "./filters.ts";
import { SYSTEM_TYPES } from "./management.ts";

// -- what is on screen ------------------------------------------------------

/** Record whether a module just opened (or opened again) is displayed. */
export function set_visible(rt: Runtime, module_id: number, visible: boolean, fresh: boolean): void {
  let hidden: Set<number> = rt.state.get("hidden modules");
  if (!hidden) rt.state.set("hidden modules", hidden = new Set());
  if (visible) hidden.delete(module_id);
  else if (fresh) hidden.add(module_id);
}

function is_visible(rt: Runtime, module_id: any): boolean {
  return !rt.state.get("hidden modules")?.has(rt.opened_module(module_id));
}

// A baseline has the views of its module.
function owner_of(rt: Runtime, module_id: number): number {
  return rt.store.baseline_of(module_id)?.module_id ?? module_id;
}

function attribute_names(rt: Runtime, module_id: number): Set<string> {
  return new Set([...SYSTEM_BASES.keys(),
    ...rt.store.attributes(module_id, "object").map((a) => a.name)]);
}

function not_in_layout(rt: Runtime): void {
  if (rt.state.has("layout row")) throw new Fault("columns and views cannot be used inside layout DXL here");
}

function window_of(rt: Runtime, module_id: any): ViewWindow {
  not_in_layout(rt);
  const state = display(rt, rt.opened_module(module_id));
  if (state.window === null) {
    state.window = {
      name: STANDARD_VIEW, columns: view_columns({}, () => true), in_links: false, out_links: false,
    };
  }
  return state.window;
}

// -- columns ------------------------------------------------------------------

export class ColumnRef {
  module_id: number;
  window: ViewWindow;
  index: number;
  column: ViewColumn | null; // null: the place just after the last column

  constructor(module_id: number, window: ViewWindow, index: number) {
    this.module_id = module_id;
    this.window = window;
    this.index = index;
    this.column = window.columns[index] ?? null;
  }

  equals(other: unknown): boolean {
    return other instanceof ColumnRef && this.window === other.window && this.index === other.index
      && this.column === other.column;
  }
}

function column_at(rt: Runtime, module_id: any, n: number): ColumnRef {
  const window = window_of(rt, module_id);
  if (n < 0 || n > window.columns.length) {
    throw new Fault(`there is no column ${n}: the view has ${window.columns.length}, numbered from 0`);
  }
  return new ColumnRef(module_id, window, n);
}

// A handle whose place still holds what it held.
function current_ref(rt: Runtime, ref: any): ColumnRef {
  rt.need(ref, "Column");
  rt.opened_module(ref.module_id);
  if (window_of(rt, ref.module_id) !== ref.window || ref.index > ref.window.columns.length
    || (ref.window.columns[ref.index] ?? null) !== ref.column) {
    throw new Fault("the columns have moved (or another view was loaded) since this Column was obtained, "
      + "and what DOORS does with it then is not documented; get it again with column(n)");
  }
  return ref;
}

function column_of(rt: Runtime, ref: any): ViewColumn {
  const found = current_ref(rt, ref);
  if (found.column === null) {
    throw new Fault(`there is no column ${found.index}: the view has ${found.window.columns.length}, `
      + "numbered from 0");
  }
  return found.column;
}

function insert_column(rt: Runtime, ref: any): ColumnRef {
  const place = current_ref(rt, ref);
  place.window.columns.splice(place.index, 0, { kind: "blank", title: null, width: null, justify: "left" });
  return new ColumnRef(place.module_id, place.window, place.index);
}

function delete_column(rt: Runtime, ref: any): void {
  column_of(rt, ref);
  ref.window.columns.splice(ref.index, 1);
}

function title(rt: Runtime, ref: any): string {
  const column = column_of(rt, ref);
  if (column.title !== null) return column.title;
  if (column.kind === "main") {
    throw new Fault("what title() gives for the main column is not documented here; test main(c) first, "
      + "or set the title");
  }
  throw new Fault("this column has no title set, and what DOORS then gives is not documented");
}

function width(rt: Runtime, ref: any): number {
  const column = column_of(rt, ref);
  if (column.width === null) throw new Fault("this column has no width set; set it with width(c, pixels)");
  return column.width;
}

function set_width(rt: Runtime, ref: any, pixels: number): void {
  if (pixels <= 0) throw new Fault("a column width must be more than 0 pixels");
  column_of(rt, ref).width = pixels;
}

function justify_text(rt: Runtime, ref: any): string {
  const { justify } = column_of(rt, ref);
  if (justify === "center") {
    throw new Fault('whether DOORS spells this "center" or "centre" is not documented; '
      + "compare with the constant: if (justify(c) == center)");
  }
  return justify;
}

function set_main(rt: Runtime, ref: any): void {
  const column = column_of(rt, ref);
  if (column.kind === "main") return;
  if (ref.window.columns.some((c: ViewColumn) => c.kind === "main")) {
    throw new Fault("there is already a main column; what DOORS does with it is not documented "
      + "(delete it first)");
  }
  if (column.kind !== "blank") throw new Fault("only a newly inserted column can be made the main column here");
  column.kind = "main";
}

function not_the_id_column(column: ViewColumn, what: string): void {
  if (column.kind === "id") {
    throw new Fault(`what ${what} gives for the ID column is not documented; test title(c) == "ID" first`);
  }
}

function attr_name(rt: Runtime, ref: any): string {
  const column = column_of(rt, ref);
  not_the_id_column(column, "attrName()");
  return column.kind === "attribute" ? column.attribute! : "";
}

function dxl_code(rt: Runtime, ref: any): string {
  const column = column_of(rt, ref);
  not_the_id_column(column, "dxl()");
  return column.kind === "dxl" ? column.dxl! : "";
}

// attribute(c, name) and dxl(c, code) replace what a column displays.
function show_in(rt: Runtime, ref: any): ViewColumn {
  const column = column_of(rt, ref);
  if (column.kind === "main") throw new Fault("changing what the main column displays is not supported here");
  delete column.attribute;
  delete column.dxl;
  return column;
}

function set_attribute(rt: Runtime, ref: any, name: string): void {
  column_of(rt, ref);
  if (!attribute_names(rt, ref.module_id).has(name)) {
    throw new Fault(`no object attribute ${_repr(name)} in ${rt.store.path(ref.module_id)}`);
  }
  const column = show_in(rt, ref);
  column.kind = "attribute";
  column.attribute = name;
}

function in_column_dxl<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (!(e instanceof DxlError)) throw e;
    throw new Fault(`in the column's DXL, line ${e.line}: ${e.message}`);
  }
}

// One run of a column's layout DXL over its module, kept until the database changes.
function layout_cells(rt: Runtime, module_id: number, source: string): Map<number, string> {
  let cache: Map<string, [number, Map<number, string>]> = rt.state.get("column cells");
  if (!cache) rt.state.set("column cells", cache = new Map());
  const at = `${module_id}\0${source}`;
  const found = cache.get(at);
  if (found && found[0] === rt.store.total_changes) return found[1];
  const cells = in_column_dxl(() =>
    layout(source, rt.store, module_id, rt.out, rt.base_dir, rt.files?.disk ?? null, rt.deadline));
  cache.set(at, [rt.store.total_changes, cells]);
  return cells;
}

function set_dxl(rt: Runtime, ref: any, source: string): void {
  column_of(rt, ref);
  // DOORS would only show a broken script as an error in the column; better to stop here
  in_column_dxl(() => check_layout(source, rt.store, rt.base_dir, rt.files?.disk ?? null));
  const column = show_in(rt, ref);
  column.kind = "dxl";
  column.dxl = source;
}

function column_text(rt: Runtime, ref: any, obj: any): string {
  const column = column_of(rt, ref);
  rt.obj(obj);
  if (obj.module_id !== ref.module_id) throw new Fault("the Column and the Object belong to different modules");
  if (column.kind === "main") return "";
  if (column.kind === "id") return rt.store.identifier(obj);
  if (column.kind === "attribute") {
    if (!attribute_names(rt, obj.module_id).has(column.attribute!)) {
      throw new Fault(`the column shows ${_repr(column.attribute!)}, which the module no longer has`);
    }
    return rt.store.value(obj, column.attribute!);
  }
  if (column.kind === "dxl") {
    const found = layout_cells(rt, obj.module_id, column.dxl!).get(obj.absno);
    if (found === undefined) throw new Fault("the text of a DXL column for a deleted object is not supported here");
    return found;
  }
  throw new Fault("this column displays nothing yet");
}

function register_columns(lib: Library): void {
  lib.type("Column");
  lib.type("Justification");
  for (const [name, value] of [["left", "left"], ["right", "right"], ["center", "center"], ["centre", "center"],
    ["full", "full"]] as Array<[string, Justification]>) {
    lib.add(name, [], "Justification", () => value);
  }
  lib.add("column", ["int"], "Column", (rt, n) => column_at(rt, current_module(rt), n));
  lib.add("column", ["Module", "int"], "Column", column_at);
  lib.loop("Module", "Column", (rt, m) => {
    const window = window_of(rt, m);
    return window.columns.map((_c, i) => new ColumnRef(m, window, i));
  });
  lib.add("insert", ["Column"], "Column", insert_column);
  lib.add("delete", ["Column"], "void", delete_column);

  lib.add("title", ["Column"], "string", title);
  lib.add("title", ["Column", "string"], "void", (rt, c, text) => { column_of(rt, c).title = text; });
  lib.add("width", ["Column"], "int", width);
  lib.add("width", ["Column", "int"], "void", set_width);
  lib.add("justify", ["Column"], "string", justify_text);
  lib.add("justify", ["Column"], "Justification", (rt, c) => column_of(rt, c).justify);
  lib.add("justify", ["Column", "Justification"], "void",
    (rt, c, j) => { column_of(rt, c).justify = rt.need(j, "Justification"); });
  lib.add("main", ["Column"], "bool", (rt, c) => column_of(rt, c).kind === "main");
  lib.add("main", ["Column"], "void", set_main);
  lib.add("attrName", ["Column"], "string", attr_name);
  lib.add("attribute", ["Column", "string"], "void", set_attribute);
  lib.add("dxl", ["Column"], "string", dxl_code);
  lib.add("dxl", ["Column", "string"], "void", set_dxl);
  lib.add("text", ["Column", "Object"], "string", column_text);
}

// -- saved views --------------------------------------------------------------

export class ViewRef {
  module_id: number;
  name: string;
  constructor(module_id: number, name: string) {
    this.module_id = module_id;
    this.name = name;
  }
  equals(other: unknown): boolean {
    return other instanceof ViewRef && this.module_id === other.module_id && this.name === other.name;
  }
}

// The handle, checked to be of the module it is being used in.
function view_in(rt: Runtime, module_id: number, view: any): ViewRef {
  rt.need(view, "View");
  if (view.module_id !== module_id) {
    throw new Fault(`this View is of ${rt.store.path(view.module_id)}, not ${rt.store.path(module_id)}; `
      + "make that module current before view(), or use view(item, name)");
  }
  return view;
}

// The interface's saved filter, matched as the interface matches it.
function saved_filter(rt: Runtime, module_id: number, wanted: any): (rt: Runtime, obj: Obj) => boolean {
  const { attribute, op } = wanted;
  if (attribute !== "ID" && !attribute_names(rt, module_id).has(attribute)) {
    throw new Fault(`the view filters on ${_repr(String(attribute))}, which the module does not have`);
  }
  const want = String(wanted.value ?? "").toLowerCase();
  const tests: Record<string, (have: string) => boolean> = {
    "contains": (have) => have.includes(want), "!contains": (have) => !have.includes(want),
    "==": (have) => have === want, "!=": (have) => have !== want,
    "empty": (have) => have === "", "!empty": (have) => have !== "",
  };
  const test = Object.hasOwn(tests, op) ? tests[op] : null;
  if (!test) throw new Fault(`the view's filter condition ${_repr(String(op))} is not supported here`);
  return (_rt, obj) => test(
    (attribute === "ID" ? rt.store.identifier(obj) : rt.store.value(obj, attribute)).toLowerCase());
}

export function load_view(rt: Runtime, module_id: any, name: string): boolean {
  not_in_layout(rt);
  rt.opened_module(module_id);
  let definition: any = null;
  if (name !== STANDARD_VIEW) {
    const views = rt.store.views(owner_of(rt, module_id));
    if (!views.has(name)) return false;
    definition = views.get(name);
  }
  if ((filtering(rt, module_id) && !definition?.filter) || (sorting(rt, module_id) && !definition?.sort)) {
    throw new Fault("whether loading this view keeps the filtering or sorting now on depends on settings "
      + "saved in DOORS; write `filtering off` and `sorting off` before load");
  }
  const names = attribute_names(rt, module_id);
  const test = definition?.filter ? saved_filter(rt, module_id, definition.filter) : null;
  const state = display(rt, module_id);
  state.window = {
    name,
    columns: view_columns(definition, (n) => names.has(n)),
    in_links: definition !== null && definition.in_links !== false,
    out_links: definition !== null && definition.out_links !== false,
  };
  if (test) {
    apply_filter(rt, module_id, test);
    state.filtering = true;
    state.ancestors = false; // the interface shows matching objects only
  }
  if (definition?.sort) {
    apply_sort(rt, module_id, [[definition.sort === "ID" ? "Absolute Number" : definition.sort, false]]);
    state.sorting = true;
  }
  return true;
}

// What a ViewDef asks to be kept; null: the plain `save(view)`, which refuses
// where DOORS would go by settings it holds.
export type ViewSettings = { useColumns?: boolean; useFiltering?: boolean; useSorting?: boolean };

function save_view(rt: Runtime, view: any): void {
  save_view_in(rt, current_module(rt), view, null);
}

export function save_view_in(rt: Runtime, target: any, view: any, settings: ViewSettings | null): void {
  const module_id = rt.opened_module(target);
  const { name } = view_in(rt, module_id, view);
  const window = window_of(rt, module_id);
  if (rt.store.is_baseline(module_id)) throw new Fault("a view cannot be saved in a baseline here");
  if (!is_visible(rt, module_id)) {
    throw new Fault("a view can only be saved while its module is displayed: open it without `false`");
  }
  if (name === STANDARD_VIEW) throw new Fault("the Standard view cannot be altered; save under another name");
  if (!name) throw new Fault("a view needs a name");
  if (settings === null) {
    if (filtering(rt, module_id) || sorting(rt, module_id)) {
      throw new Fault("whether DOORS keeps the filter or sort with this view depends on its view definition; "
        + "turn filtering and sorting off, or save(view, viewDef) saying useFiltering and useSorting");
    }
  } else {
    if (settings.useColumns !== true) {
      throw new Fault("only a view definition with useColumns true can be saved here");
    }
    for (const [on, kept, what] of [[filtering(rt, module_id), settings.useFiltering, "useFiltering"],
      [sorting(rt, module_id), settings.useSorting, "useSorting"]] as const) {
      if (on && kept !== false) {
        throw new Fault(`a script's filter or sort cannot be kept in a view here: write ${what}(viewDef, false), `
          + "or turn it off before save");
      }
    }
  }
  const unsized = window.columns.findIndex((c) => c.width === null);
  if (unsized >= 0) {
    throw new Fault(`column ${unsized} has no width, and in DOORS it may not appear; set width() before save`);
  }
  rt.store.save_view(module_id, name, {
    layout: window.columns.map((c) => ({ ...c })), filter: null, sort: null,
    in_links: window.in_links, out_links: window.out_links,
    ...(settings ? { settings } : {}),
  });
  window.name = name;
}

function delete_view(rt: Runtime, module_id: any, view: any): string {
  not_in_layout(rt);
  const { name } = view_in(rt, rt.opened_module(module_id), view);
  if (rt.store.is_baseline(module_id)) return "the views of a baseline cannot be deleted";
  if (name === STANDARD_VIEW) return "the Standard view cannot be deleted";
  if (!rt.store.views(module_id).has(name)) return `there is no view ${_repr(name)}`;
  rt.store.delete_view(module_id, name);
  const window = display(rt, module_id).window;
  if (window?.name === name) window.name = null;
  return "";
}

function current_view(rt: Runtime, module_id: any): string {
  const { name } = window_of(rt, module_id);
  if (name === null) throw new Fault("the current view has been deleted; load a view");
  return name;
}

// canRead(module "...", view "...") and the rest.
function view_right(changes: boolean) {
  return (rt: Runtime, module_id: any, view: any): boolean => {
    rt.need(module_id, "ModName_");
    view_in(rt, module_id, view);
    if (view.name === STANDARD_VIEW) return !changes;
    if (!rt.store.views(module_id).has(view.name)) {
      throw new Fault(`there is no saved view ${_repr(view.name)}, and what DOORS then answers is not documented`);
    }
    return true;
  };
}

function register_view_functions(lib: Library): void {
  lib.type("View");
  lib.type("ViewNames_");

  lib.add("view", ["string"], "View", (rt, name) => new ViewRef(current_module(rt), name));
  lib.add("view", ["Item", "string"], "View",
    (rt, item, name) => rt.store.item(rt.need(item, "Item")).kind === "formal" ? new ViewRef(item, name) : null);
  lib.add("name", ["View"], "string", (rt, v) => rt.need(v, "View").name);

  lib.add("load", ["View"], "bool",
    (rt, v) => load_view(rt, current_module(rt), view_in(rt, current_module(rt), v).name));
  const load_into = (rt: Runtime, m: any, v: any) => load_view(rt, m, view_in(rt, rt.opened_module(m), v).name);
  lib.add("load", ["Module", "View"], "bool", load_into);
  // the flag only asks whether to warn about unsaved view changes
  lib.add("load", ["Module", "View", "bool"], "bool", load_into);

  lib.add("save", ["View"], "void", save_view);
  lib.add("delete", ["View"], "string", (rt, v) => delete_view(rt, current_module(rt), v));
  lib.add("delete", ["Module", "View"], "string", delete_view);
  lib.add("currentView", ["Module"], "string", current_view);

  lib.add("views", ["Module"], "ViewNames_", (rt, m) => rt.opened_module(m));
  // saved views only; whether DOORS also lists the Standard view is not verified
  lib.loop("ViewNames_", "string", (rt, m: number) => [...rt.store.views(owner_of(rt, m)).keys()]);

  lib.add("canRead", ["ModName_", "View"], "bool", view_right(false));
  for (const name of ["canModify", "canWrite", "canDelete", "canControl"]) {
    lib.add(name, ["ModName_", "View"], "bool", view_right(true));
  }
  lib.add("canCreate", ["ModName_", "View"], "bool", (rt, m, v) => {
    view_in(rt, rt.need(m, "ModName_"), v);
    if (v.name === STANDARD_VIEW) throw new Fault("canCreate of the Standard view is not documented");
    return true;
  });
}

// -- refresh and display state ------------------------------------------------

function register_display(lib: Library): void {
  // The interface redraws when the script ends; there is nothing to do before then.
  lib.add("refresh", ["Module"], "void", (rt, m) => { rt.opened_module(m); });
  lib.add("isVisible", ["Module"], "bool", is_visible);
  lib.add("isVisible", ["Object"], "bool", (rt, o) => {
    rt.obj(o);
    return accepted_objects(rt, o.module_id, shown(rt, o.module_id)).some((x) => x.equals(o));
  });

  // Graphics mode, outlining and showing deleted objects are never on here.
  for (const name of ["graphics", "outlining"]) {
    lib.add(name, ["Module"], "bool", (rt, m) => { rt.opened_module(m); return false; });
  }
  lib.add("showDeletedObjects", [], "bool", (rt) => { current_module(rt); return false; });
  for (const name of ["graphics", "outlining", "showDeletedObjects"]) {
    lib.add(name, ["bool"], "void", (rt, on: boolean) => {
      current_module(rt);
      if (on) throw new Fault(`${name}(true) is not supported here`);
    });
  }
}

// -- access -------------------------------------------------------------------

const RIGHT_ASKED: Record<string, number> = { canRead: RIGHTS.read, canModify: RIGHTS.modify,
  canWrite: RIGHTS.modify, canCreate: RIGHTS.create, canDelete: RIGHTS.delete, canControl: RIGHTS.control };

function allowed(rt: Runtime, thing: any, call: string): boolean {
  const answer = rt.store.may(thing, RIGHT_ASKED[call]);
  if (answer === "unknown") {
    throw new Fault(`${call}: the answer depends on which of the named groups ${rt.store.user} belongs to; `
      + `give ${rt.store.user} an access entry to say`);
  }
  return answer === "yes";
}

function not_a_baseline(rt: Runtime, module_id: number): void {
  if (rt.store.is_baseline(module_id)) {
    throw new Fault("what DOORS answers for change rights in a baseline is not verified");
  }
}

function attribute_right(rt: Runtime, module_id: any, name: string, changes: boolean, scope: string | null): boolean {
  rt.opened_module(module_id);
  const found = rt.store.attribute(module_id, name);
  const system = scope !== "module" && SYSTEM_BASES.has(name);
  const builtin = scope !== "object" && ["Name", "Description", "Prefix"].includes(name);
  if (!system && !builtin && (found === null || (scope !== null && found.scope !== scope))) {
    throw new Fault(`no attribute ${_repr(name)} in ${rt.store.path(module_id)}`);
  }
  if (changes) {
    not_a_baseline(rt, module_id);
    if (system) throw new Fault(`what DOORS answers for changing the system attribute ${_repr(name)} is not verified`);
  }
  return allowed(rt, module_id, changes ? "canModify" : "canRead");
}

function register_access(lib: Library): void {
  const rights = ["canRead", "canModify", "canCreate", "canControl", "canDelete"];

  for (const type_name of ["Item", "Folder"]) {
    for (const name of rights) {
      lib.add(name, [type_name], "bool", (rt, i) => allowed(rt, rt.need(i, type_name), name));
    }
  }

  for (const name of [...rights, "canWrite"]) {
    lib.add(name, ["Module"], "bool", (rt, m) => {
      rt.opened_module(m);
      if (name !== "canRead") not_a_baseline(rt, m);
      return allowed(rt, m, name);
    });
    lib.add(name, ["Object"], "bool", (rt, o) => {
      rt.obj(o);
      if (name !== "canRead") {
        not_a_baseline(rt, o.module_id);
        // the manual: these need the module open for exclusive edit
        if (rt.opened.get(o.module_id) !== "edit") {
          throw new Fault(`${name}(Object) needs the module open with edit()`);
        }
      }
      return allowed(rt, o, name);
    });
  }

  for (const [name, changes] of [["canRead", false], ["canWrite", true], ["canModify", true]] as
    Array<[string, boolean]>) {
    lib.add(name, ["Module", "string"], "bool", (rt, m, a) => attribute_right(rt, m, a, changes, null));
    lib.add(name, ["attr"], "bool", (rt, a: AttrRef) => {
      if (a.owner_type === "Object") {
        const answer = attribute_right(rt, rt.obj(a.owner).module_id, a.name, changes, "object");
        return changes ? allowed(rt, a.owner, "canModify") : answer; // an object may have rights of its own
      }
      if (a.owner_type === "Module") return attribute_right(rt, a.owner, a.name, changes, "module");
      a.get(); // a link: that the attribute exists
      if (changes) throw new Fault("link attributes cannot be changed here");
      return true;
    });
  }

  lib.add("canRead", ["AttrType"], "bool", (rt, t) => { rt.need(t, "AttrType"); return true; });
  lib.add("canModify", ["AttrType"], "bool", (rt, t) => {
    rt.need(t, "AttrType");
    if (SYSTEM_TYPES.includes(t.name)) throw new Fault("what DOORS answers for a system type is not verified");
    return true;
  });
}

export function register(lib: Library): void {
  register_columns(lib);
  register_view_functions(lib);
  register_display(lib);
  register_access(lib);
}
