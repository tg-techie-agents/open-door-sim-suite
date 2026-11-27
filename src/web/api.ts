// The operations behind the browser interface. Each op_ takes one object of
// arguments and returns a JSON result.
//
// The scripts folder is a set of embedded texts; a script's files go to a
// VirtualDisk and come back in `files`; the time limit is enforced outside, by
// terminating the worker. Binary files travel as base64.

import { ROOT, RIGHTS, SYSTEM_ATTRIBUTES, AttrDxlError, Obj, Store, StoreError, rights_names } from "../store.ts";
import { DxlError, coverage, layout, run } from "../dxl/index.ts";
import type { DialogSession } from "../dxl/index.ts";
import type { DialogEvent, Progress } from "../dxl/lib/dialogs.ts";
import type { VirtualDisk } from "../dxl/files.ts";
import { export_module, import_csv } from "../io/csvio.ts";
import { export_reqif, import_reqif } from "../io/reqif.ts";

export const MAX_OUTPUT = 2 * 1024 * 1024;
// A column is one short cell per object, shown a screenful at a time: a large
// module's traceability column is far more text than a script should print.
export const MAX_COLUMN = 32 * 1024 * 1024;

export type Scripts = { names: Record<string, string>; layout: Record<string, string> };

class _Stopped extends Error {}

class _Output {
  text = "";
  stopped: string | null = null;
  listener: ((text: string) => void) | null;
  constructor(listener: ((text: string) => void) | null) {
    this.listener = listener;
  }
  write(text: string): number {
    if (this.text.length > MAX_OUTPUT) {
      // Remembered as well as thrown, in case the engine wraps what we throw.
      this.stopped = "the script printed too much output and was stopped";
      throw new _Stopped(this.stopped);
    }
    this.text += text;
    if (this.listener) this.listener(text);
    return text.length;
  }
  getvalue(): string {
    return this.text;
  }
}

// Maps to plain JSON objects, all the way down.
export function plain(value: any): any {
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([k, v]) => [k, plain(v)]));
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function int(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (value === null || value === "" || !Number.isFinite(n)) throw new Error(`invalid number: ${value}`);
  return Math.trunc(n);
}

const _obj_values = (values: Record<string, string> | null | undefined) =>
  new Map(Object.entries(values || {}));

export class Api {
  store: Store;
  database: string;
  scripts: Scripts;
  disk: VirtualDisk;
  on_output: ((text: string) => void) | null = null;
  on_progress: ((progress: Progress | null) => void) | null = null;
  dialogs: DialogSession | null = null; // the script whose dialog boxes are open

  constructor(store: Store, database: string, scripts: Scripts, disk: VirtualDisk) {
    this.store = store;
    this.database = database;
    this.scripts = scripts;
    this.disk = disk;
  }

  _existing(module: unknown, absno: unknown): Obj {
    const obj = this.store.object(int(module), int(absno));
    if (obj === null) throw new StoreError("that object no longer exists");
    return obj;
  }

  _formal(module: unknown): any {
    const item = this.store.item(int(module));
    if (item.kind !== "formal") throw new StoreError(`${item.name} is not a formal module`);
    return item;
  }

  // -- database explorer ----------------------------------------------------

  op_tree({ show_deleted = false }: any = {}): any {
    const node = (item: any): any => {
      const inner = item.kind === "folder" || item.kind === "project"
        ? Array.from(this.store.children(item.id, show_deleted)) : [];
      return {
        id: item.id, name: item.name, kind: item.kind, deleted: item.deleted,
        description: item.description, path: this.store.path(item.id),
        prefix: this.store.prefix(item.id), children: inner.map(node),
      };
    };
    return { root: node(this.store.item(ROOT)), database: this.database };
  }

  op_create_item({ parent, name, kind, description = "", prefix = "" }: any): any {
    const path = this.store.path(int(parent));
    if (kind === "formal") return { id: this.store.create_module(path, name, description, prefix) };
    if (kind === "link") return { id: this.store.create_link_module(path, name, description) };
    if (kind === "folder" || kind === "project") {
      return { id: this.store.create_folder(path, name, description, kind === "project") };
    }
    throw new StoreError(`unknown kind of item '${kind}'`);
  }

  op_update_item({ id, name = null, description = null, prefix = null }: any): void {
    this.store.set_item(int(id), name, description, prefix);
  }

  op_delete_item({ id, deleted = true }: any): void {
    this.store.delete_item(int(id), deleted);
  }

  // -- formal modules -------------------------------------------------------

  op_module({ module: module_arg, show_deleted = false }: any): any {
    const store = this.store;
    const item = this._formal(module_arg);
    const module = item.id;
    const live = new Set<number>(Array.from(store.walk() as Iterable<any>, (i: any) => i.id));
    live.add(module);
    const cache = new Map<number, any[]>(); // module id -> [prefix, values, path]

    const about = (m: number): any[] => {
      if (!cache.has(m)) cache.set(m, [store.prefix(m), store.values(m), store.path(m)]);
      return cache.get(m)!;
    };

    const links = (obj: Obj, outgoing: boolean): any[] => {
      const out: any[] = [];
      for (const link of store.links(obj, outgoing)) {
        const other = outgoing ? link.target : link.source;
        if (!live.has(other.module_id) || store.is_deleted(other)) continue;
        const [prefix, values, path] = about(other.module_id);
        const held: Map<string, string> = values.get(other.absno) || new Map();
        const [source_changed, target_changed] = store.suspect(link);
        out.push({
          id: link.id, link_module: store.item(link.link_module).name, link_module_path: store.path(link.link_module),
          source: { module: link.source.module_id, absno: link.source.absno },
          other: {
            module: other.module_id, absno: other.absno, id: `${prefix}${other.absno}`, module_path: path,
            text: held.get("Object Heading") || held.get("Object Text") || (held.get("Object Short Text") ?? ""),
          },
          source_changed, target_changed,
        });
      }
      return out;
    };

    const attributes: any[] = Array.from(store.attributes(module, null));
    const system = Array.from(SYSTEM_ATTRIBUTES as readonly string[]).filter((n) => n !== "Absolute Number");
    const values: any = store.values(module);
    const numbers: any = store.numbers(module);
    const prefix = store.prefix(module);
    const levels = new Map<number, number>();
    const rows: any[] = [];
    for (const obj of store.objects(module, true)) {
      const parent = store.parent_object(obj);
      const level = parent ? levels.get(parent.absno)! + 1 : 1;
      levels.set(obj.absno, level);
      const deleted = store.is_deleted(obj);
      if (deleted && !show_deleted) continue;
      const held = new Map<string, any>(values.get(obj.absno) || []);
      for (const name of system) held.set(name, store.value(obj, name));
      // attribute DXL: calculated now, or its error in the value's place and its name in `failed`
      const failed: string[] = [];
      for (const a of attributes) {
        if (!a.dxl) continue;
        try {
          held.set(a.name, store.value(obj, a.name));
        } catch (e) {
          if (!(e instanceof AttrDxlError)) throw e;
          held.set(a.name, e.shown);
          failed.push(a.name);
        }
      }
      rows.push({
        failed,
        absno: obj.absno, id: `${prefix}${obj.absno}`, level,
        parent: parent ? parent.absno : null, deleted,
        number: numbers.get(obj.absno) ?? "", values: held,
        out: links(obj, true), in: links(obj, false),
      });
    }
    const baseline = store.baseline_of(module);
    const owner = baseline ? baseline.module_id : module;
    return {
      module: {
        id: module, name: item.name, path: store.path(module), prefix,
        description: item.description, owner, baseline: baseline ? baseline.label : null,
      },
      attributes: attributes.map((a) => ({
        name: a.name, type: a.type_name, base: a.base, scope: a.scope,
        multi: a.multi, default: a.default, values: Array.from(a.values), dxl: a.dxl,
        description: a.description, inherit: a.inherit, history: a.history, bars: a.bars, dates: a.dates,
        module_value: a.scope === "module" ? store.module_value(module, a.name) : null,
      })),
      types: Array.from(store.types(module) as Iterable<any>, (t: any) => ({
        name: t.name, base: t.base, values: Array.from(t.values), description: t.description,
        numbers: Array.from(t.numbers), min: t.min, max: t.max, users: store.type_users(module, t.name),
      })),
      system_attributes: system,
      rows,
      views: store.views(owner),
      baselines: Array.from(store.baselines(owner) as Iterable<any>, (b: any) => Api._baseline(b)),
    };
  }

  static _baseline(b: any): any {
    return {
      id: b.copy_id, label: b.label, annotation: b.annotation,
      created_by: b.created_by, created_on: b.created_on,
    };
  }

  op_objects({ module: module_arg }: any): any {
    const module = this._formal(module_arg).id;
    const values: any = this.store.values(module);
    const numbers: any = this.store.numbers(module);
    const out: any[] = [];
    for (const obj of this.store.objects(module)) {
      const held: Map<string, string> = values.get(obj.absno) || new Map();
      out.push({
        absno: obj.absno, id: this.store.identifier(obj),
        number: numbers.get(obj.absno) ?? "",
        text: held.get("Object Heading") || (held.get("Object Text") ?? ""),
      });
    }
    return out;
  }

  // -- objects --------------------------------------------------------------

  op_add_object({ module: module_arg, ref = null, where = "end", values = null }: any): any {
    const module = this._formal(module_arg).id;
    let parent: Obj | null = null, after: Obj | null = null, before: Obj | null = null;
    if (ref !== null) {
      if (where !== "after" && where !== "before" && where !== "child") {
        throw new StoreError(`cannot add '${where}' an object`);
      }
      const place = this._existing(module, ref);
      if (where === "child") parent = place;
      else if (where === "after") after = place;
      else before = place;
    }
    return { absno: this.store.create_object(module, parent, after, before, _obj_values(values)).absno };
  }

  // Does an object only show its parent's (or the default) value of this attribute?
  _inherited(obj: Obj, name: string): boolean {
    return !!this.store.attribute(obj.module_id, name)?.inherit && !this.store.has_own_value(obj, name);
  }

  // `made_own` names the inherited cells that now hold a value of their own. An
  // inherited cell given back unchanged is left inherited.
  op_set_values({ module, absno, values }: any): { made_own: string[] } | void {
    const obj = this._existing(module, absno);
    const made_own: string[] = [];
    this.store.transaction(() => {
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== "string") throw new StoreError(`${name}: the value must be text`);
        const text = value.replaceAll("\r\n", "\n");
        const inherited = this._inherited(obj, name);
        if (inherited && this.store.value(obj, name) === text) continue;
        this.store.set_value(obj, name, text);
        if (inherited) made_own.push(name);
      }
    });
    if (made_own.length) return { made_own };
  }

  op_move_object({ module, absno, direction }: any): void {
    const store = this.store;
    const obj = this._existing(module, absno);
    const parent = store.parent_object(obj);
    const siblings: Obj[] = Array.from(store.child_objects(obj.module_id, parent ? parent.absno : null) as Iterable<Obj>)
      .filter((o) => o.equals(obj) || !store.is_deleted(o));
    const at = siblings.findIndex((o) => o.equals(obj));
    if (direction === "up" && at > 0) store.move_object(obj, undefined, undefined, siblings[at - 1]);
    else if (direction === "down" && at < siblings.length - 1) store.move_object(obj, undefined, siblings[at + 1]);
    else if (direction === "promote" && parent) store.move_object(obj, undefined, parent);
    else if (direction === "demote" && at > 0) store.move_object(obj, siblings[at - 1]);
    else throw new StoreError(`${store.identifier(obj)} cannot move ${direction} from here`);
  }

  op_delete_object({ module, absno }: any): void {
    this.store.delete_object(this._existing(module, absno));
  }

  op_undelete_object({ module, absno }: any): void {
    this.store.undelete_object(this._existing(module, absno));
  }

  op_history({ module, absno = null }: any): any {
    const item = this._formal(module);
    const prefix = this.store.prefix(item.id);
    return Array.from(this.store.history(item.id, absno === null ? null : int(absno)) as Iterable<any>, (h: any) => ({
      when: h.when, who: h.who, action: h.action, attribute: h.attribute,
      id: h.absno === null ? "" : `${prefix}${h.absno}`, old: h.old, new: h.new,
    }));
  }

  // -- links ----------------------------------------------------------------

  op_create_link({ source, target_module, target, link_module = null }: any): { note: string | null } {
    const start = this._existing(source.module, source.absno);
    const module = this._formal(target_module).id;
    const end = this.store.by_identifier(module, String(target).trim());
    if (end === null) throw new StoreError(`no object '${target}' in ${this.store.path(module)}`);
    const parent = this.store.item(start.module_id).parent!;
    const had = this.store.find("DOORS Links", parent);
    this.store.create_link(start, end, link_module || null);
    const made = had ? null : this.store.find("DOORS Links", parent);
    return { note: made ? `Made the link module ${this.store.path(made)} for this link.` : null };
  }

  _link(source: any, link_id: unknown): any {
    const obj = this._existing(source.module, source.absno);
    if (this.store.is_baseline(obj.module_id)) throw new StoreError("a baseline cannot be changed");
    for (const link of this.store.links(obj, true, undefined, true)) {
      if (link.id === link_id) return link;
    }
    throw new StoreError("that link no longer exists");
  }

  op_delete_link({ source, link }: any): void {
    this.store.delete_link(this._link(source, link));
  }

  op_clear_suspect({ source, link }: any): void {
    this.store.clear_suspect(this._link(source, link));
  }

  // -- editing more than one thing at once ----------------------------------

  // Move (cut) or copy an object with its children, after `ref`, below it, or at the end.
  op_paste_object({ source, module: module_arg, ref = null, where = "end", cut = false }: any): any {
    const store = this.store;
    const module = this._formal(module_arg).id;
    const from = this._existing(source.module, source.absno);
    if (store.is_deleted(from)) throw new StoreError(`${store.identifier(from)} is deleted`);
    const place = ref === null ? null : this._existing(module, ref);
    const parent = place && where === "child" ? place : null;
    const after = place && where !== "child" ? place : null;
    if (cut) {
      if (from.module_id !== module) throw new StoreError("a cut object moves within its own module; use Copy to put it in another");
      store.move_object(from, parent, after);
      return { absno: from.absno, count: 1, skipped: [] };
    }
    // Read the whole branch first: it may be pasted inside itself.
    const known = new Map(store.attributes(module).map((a) => [a.name, a]));
    const values: any = store.values(from.module_id, true); // inherited values stay inherited
    const skipped = new Set<string>();
    type Branch = { values: Map<string, string>; children: Branch[] };
    const read = (obj: Obj): Branch => {
      const held = new Map<string, string>();
      for (const [name, value] of (values.get(obj.absno) ?? []) as Iterable<[string, string]>) {
        const target = known.get(name);
        if (!value || target?.dxl) continue;
        if (!target || (target.base === "Enumeration" && !value.split("\n").every((v) => target.values.includes(v)))) skipped.add(name);
        else held.set(name, value);
      }
      return { values: held, children: store.child_objects(obj.module_id, obj.absno).filter((o) => !store.is_deleted(o)).map(read) };
    };
    const branch = read(from);
    let count = 0;
    return store.transaction(() => {
      const make = (node: Branch, up: Obj | null, behind: Obj | null): Obj => {
        const made = store.create_object(module, up, behind, null, node.values);
        count++;
        for (const child of node.children) make(child, made, null);
        return made;
      };
      const top = make(branch, parent, after);
      return { absno: top.absno, count, skipped: [...skipped] };
    });
  }

  // The text moves into a new first child, leaving the heading by itself.
  op_split_heading({ module, absno }: any): void {
    const store = this.store;
    const obj = this._existing(module, absno);
    const heading = store.value(obj, "Object Heading"), text = store.value(obj, "Object Text");
    if (!heading || !text) throw new StoreError(`${store.identifier(obj)} needs both a heading and text to split them`);
    store.transaction(() => {
      const first = store.child_objects(obj.module_id, obj.absno)[0];
      store.create_object(obj.module_id, first ? null : obj, null, first ?? null, new Map([["Object Text", text]]));
      store.set_value(obj, "Object Text", "");
    });
  }

  // Each paragraph of the text after the first becomes an object of its own, after this one.
  op_split_object({ module, absno }: any): void {
    const store = this.store;
    const obj = this._existing(module, absno);
    const parts = store.value(obj, "Object Text").split(/\n[ \t]*\n/).map((p) => p.replace(/^\n+|\s+$/g, "")).filter(Boolean);
    if (parts.length < 2) throw new StoreError(`${store.identifier(obj)} has no blank line in its Object Text to split at`);
    store.transaction(() => {
      store.set_value(obj, "Object Text", parts[0]);
      let last = obj;
      for (const text of parts.slice(1)) last = store.create_object(obj.module_id, null, last, null, new Map([["Object Text", text]]));
    });
  }

  op_purge({ module }: any): any {
    return { purged: this.store.purge(this._formal(module).id) };
  }

  // Plain-text replacement in the String and Text attributes of the objects named.
  op_replace_text({ module: module_arg, absnos, find, replace, match_case = false }: any): any {
    const store = this.store;
    const module = this._formal(module_arg).id;
    if (typeof find !== "string" || !find) throw new StoreError("type what to find");
    const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), match_case ? "g" : "gi");
    const names = store.attributes(module).filter((a) => !a.dxl && (a.base === "String" || a.base === "Text")).map((a) => a.name);
    const changes: Array<{ absno: number; name: string; before: string; after: string }> = [];
    let count = 0;
    store.transaction(() => {
      for (const absno of absnos) {
        const obj = this._existing(module, absno);
        for (const name of names) {
          if (this._inherited(obj, name)) continue; // replaced where it is held
          const before = store.value(obj, name);
          let found = 0;
          const after = before.replace(pattern, () => { found++; return String(replace); });
          if (!found || after === before) continue;
          store.set_value(obj, name, after);
          count += found;
          changes.push({ absno: obj.absno, name, before, after: store.value(obj, name) });
        }
      }
    });
    return { count, changes };
  }

  // Undo of values: put `before` back where `after` is still what is held.
  op_restore_values({ module, changes }: any): any {
    let skipped = 0;
    this.store.transaction(() => {
      for (const { absno, name, before, after } of changes) {
        const obj = this.store.object(int(module), int(absno));
        if (obj === null || this.store.value(obj, name) !== after) skipped++;
        else this.store.set_value(obj, name, before);
      }
    });
    return { skipped };
  }

  // -- types, attributes and removal for good ---------------------------------

  op_create_type({ module, name, base, values = [], extras = {} }: any): void {
    this.store.create_type(this._formal(module).id, name, base, Array.from(values), extras);
  }

  op_modify_type({ module, name, changes, keeping = false }: any): void {
    this.store.modify_type(this._formal(module).id, name, changes, Boolean(keeping));
  }

  op_delete_type({ module, name }: any): void {
    this.store.delete_type(this._formal(module).id, name);
  }

  op_modify_attribute({ module, name, changes }: any): void {
    this.store.modify_attribute(this._formal(module).id, name, changes);
  }

  op_purge_object({ module, absno }: any): void {
    const obj = this._existing(module, absno);
    if (!this.store.is_deleted(obj)) throw new StoreError(`delete ${this.store.identifier(obj)} first`);
    this.store.purge_object(obj);
  }

  op_purge_item({ id }: any): void {
    this.store.purge_item(int(id));
  }

  op_set_project({ id, project }: any): void {
    this.store.set_project(int(id), Boolean(project));
  }

  // -- link module rules of a folder ------------------------------------------

  op_link_rules({ folder }: any): any {
    const store = this.store;
    const id = int(folder);
    const here = Array.from(store.children(id) as Iterable<any>).filter((i: any) => i.kind === "formal");
    const all = Array.from(store.walk() as Iterable<any>).filter((i: any) => i.kind === "formal");
    return {
      rules: store.link_descriptors(id),
      sources: here.map((i: any) => ({ id: i.id, name: i.name, exclusive: store.links_exclusive(id, i.id) })),
      // a module of this folder goes by its name, one elsewhere by its path
      targets: all.map((i: any) => (i.parent === id ? i.name : store.path(i.id))),
    };
  }

  op_add_link_rule({ folder, source, target, linkmod, mandatory = false, overridable = true }: any): void {
    this.store.add_link_descriptor(int(folder), { source, target, linkmod, mandatory: Boolean(mandatory),
      overridable: Boolean(overridable) });
  }

  op_remove_link_rule({ folder, source, target }: any): void {
    this.store.remove_link_descriptor(int(folder), source, target);
  }

  op_set_links_exclusive({ folder, module, exclusive }: any): void {
    this.store.set_links_exclusive(int(folder), int(module), Boolean(exclusive));
  }

  // -- links in bulk --------------------------------------------------------

  // Out-links from each object to the target objects whose identifiers its attribute lists.
  op_link_by_attribute({ module: module_arg, attribute, target_module, link_module = null, preview = true }: any): any {
    const store = this.store;
    const module = this._formal(module_arg).id;
    const target = this._formal(target_module).id;
    if (target === module) throw new StoreError("choose another module as the target");
    if (!store.has_attribute(module, attribute)) throw new StoreError(`there is no attribute '${attribute}'`);
    const prefix = store.prefix(target);
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // With no prefix, only a list of bare numbers is read: other digits are not identifiers.
    const listed = (text: string): string[] => {
      if (prefix) return [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_-])${escaped}[0-9]+(?![A-Za-z0-9_])`, "g"))].map((m) => m[0]);
      const parts = text.split(/[\s,;]+/).filter(Boolean);
      return parts.every((p) => /^[0-9]+$/.test(p)) ? parts : [];
    };
    const missing = new Set<string>(), refused = new Set<string>();
    let made = 0, existing = 0;
    const path = link_module || null;
    const rolled_back = new Error("preview");
    try {
      store.transaction(() => {
        for (const obj of store.objects(module)) {
          for (const name of new Set(listed(store.value(obj, attribute)))) {
            const end = store.by_identifier(target, name);
            if (end === null || store.is_deleted(end)) { missing.add(name); continue; }
            const held = store.links(obj, true).some((l) => l.target.equals(end)
              && (!path || store.path(l.link_module) === path));
            if (held) { existing++; continue; }
            try {
              store.create_link(obj, end, path);
              made++;
            } catch (e) {
              if (!(e instanceof StoreError)) throw e;
              refused.add(e.message);
            }
          }
        }
        // a preview is the real thing undone, so that it refuses what the real thing would
        if (preview) throw rolled_back;
      });
    } catch (e) {
      if (e !== rolled_back) throw e;
    }
    return { made, existing, missing: [...missing], refused: [...refused] };
  }

  // Every link a link module holds, between objects that are not deleted.
  op_link_module({ module }: any): any {
    const store = this.store;
    const id = int(module);
    if (store.item(id).kind !== "link") throw new StoreError(`${store.item(id).name} is not a link module`);
    const links: any[] = [];
    const held = new Map<number, any>();
    const end = (obj: Obj) => {
      if (!held.has(obj.module_id)) held.set(obj.module_id, store.values(obj.module_id));
      const values: Map<string, string> = held.get(obj.module_id).get(obj.absno) ?? new Map();
      return { module: obj.module_id, absno: obj.absno, id: store.identifier(obj), path: store.path(obj.module_id),
        text: values.get("Object Heading") || values.get("Object Text") || "" };
    };
    const formal = Array.from(store.walk() as Iterable<any>).filter((i: any) => i.kind === "formal");
    const live = new Set<number>(formal.map((i: any) => i.id));
    for (const item of formal) {
      for (const obj of store.objects(item.id)) {
        for (const link of store.links(obj, true)) {
          if (link.link_module !== id || !live.has(link.target.module_id) || store.is_deleted(link.target)) continue;
          const [source_changed, target_changed] = store.suspect(link);
          links.push({ id: link.id, source: end(link.source), target: end(link.target), source_changed, target_changed });
        }
      }
    }
    const sets = store.linksets(id).filter(([a, b]) => live.has(a) && live.has(b))
      .map(([a, b]) => ({ source: { id: a, path: store.path(a) }, target: { id: b, path: store.path(b) } }));
    return { links, linksets: sets };
  }

  // -- linksets and the default link module -----------------------------------

  op_create_linkset({ module, source, target }: any): void {
    this.store.create_linkset(int(module), int(source), int(target));
  }

  op_delete_linkset({ module, source, target }: any): void {
    this.store.delete_linkset(int(module), int(source), int(target));
  }

  op_default_link(_args: any = {}): any {
    return { name: this.store.default_link_name ?? "" };
  }

  op_set_default_link({ name }: any): void {
    this.store.set_default_link_name(String(name));
  }

  // -- access rights -----------------------------------------------------------

  // A folder or module by `item`, or an object by `module` and `absno`.
  _guarded_thing({ item, module, absno }: any): number | Obj {
    return absno === undefined || absno === null ? int(item) : this._existing(module, absno);
  }

  op_access(args: any): any {
    const thing = this._guarded_thing(args);
    return {
      user: this.store.user, inherited: this.store.is_access_inherited(thing), root: thing === ROOT,
      entries: this.store.access_list(thing).map((e) => ({ name: e.name, rights: rights_names(e.rights) })),
    };
  }

  // `action`: specific, inherit, set, unset, or reset (not checked: the way out of a lockout).
  op_change_access(args: any): void {
    const thing = this._guarded_thing(args);
    const { action, name = null, rights = [] } = args;
    if (action === "specific") this.store.make_access_specific(thing);
    else if (action === "inherit") this.store.make_access_inherited(thing);
    else if (action === "reset") this.store.reset_access(thing);
    else if (action === "unset") this.store.unset_access(thing, name);
    else if (action === "set") {
      this.store.set_access(thing, name, (rights as Array<keyof typeof RIGHTS>).reduce((bits, r) => bits | RIGHTS[r], 0));
    } else throw new StoreError(`unknown access action '${action}'`);
  }

  // -- what of DXL is here --------------------------------------------------

  op_dxl_coverage(_args: any = {}): any {
    return coverage();
  }

  // -- attribute definitions ------------------------------------------------

  op_create_attribute({ module: module_arg, name, type, scope = "object", multi = false, default: initial = "",
    new_type = null, dxl = "", extras = {} }: any): void {
    const module = this._formal(module_arg).id;
    if (scope !== "object" && scope !== "module") throw new StoreError(`unknown scope '${scope}'`);
    this.store.transaction(() => {
      if (new_type) this.store.create_type(module, type, new_type.base, Array.from(new_type.values ?? []));
      this.store.create_attribute(module, name, type, scope, multi, initial, dxl, extras);
    });
  }

  // Forget what attribute DXL has calculated, so that op_module calculates it again.
  op_recalculate({ module }: any): void {
    this.store.forget_computed(this._formal(module).id);
  }

  op_delete_attribute({ module, name }: any): void {
    this.store.delete_attribute(int(module), name);
  }

  op_set_module_value({ module, name, value }: any): void {
    this.store.set_module_value(int(module), name, value);
  }

  // -- views and baselines --------------------------------------------------

  op_save_view({ module, name, definition }: any): void {
    this.store.save_view(int(module), name, definition);
  }

  op_delete_view({ module, name }: any): void {
    if (this.store.is_baseline(int(module))) throw new StoreError("a baseline cannot be changed");
    this.store.delete_view(int(module), name);
  }

  op_create_baseline({ module, annotation = "", major = false, suffix = "" }: any): any {
    return Api._baseline(this.store.create_baseline(int(module), annotation, major, suffix));
  }

  op_compare({ old, new: newer }: any): any {
    const before = this._formal(old).id;
    const after = this._formal(newer).id;
    const prefix = this.store.prefix(after);
    return Array.from(this.store.compare(before, after) as Iterable<any>, (change: any) => {
      const flat = plain(change);
      return { ...flat, id: `${prefix}${flat.absno}` };
    });
  }

  // -- DXL ------------------------------------------------------------------

  op_scripts(_args: any = {}): any {
    const sorted = (names: string[]) =>
      names.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    return {
      folder: "scripts",
      names: sorted(Object.keys(this.scripts.names)),
      layout: sorted(Object.keys(this.scripts.layout)),
    };
  }

  op_load_script({ name, column = false }: any): any {
    // only listed files; no path tricks
    if (!this.op_scripts()[column ? "layout" : "names"].includes(name)) {
      throw new StoreError(`no script '${name}' in the scripts folder`);
    }
    const source = this.scripts[column ? "layout" : "names"][name];
    return { source: source.replace(/^﻿/, "") };
  }

  op_run_dxl({ source, module = null, view = null, dry_run = false, confirm_yes = false }: any): any {
    this.op_dxl_close(); // a new run closes the boxes of the one before
    let open_module: string | null = null;
    if (module !== null && !this.store.is_baseline(int(module))) {
      open_module = this.store.path(this._formal(module).id);
    }
    const reply: any = { error: null, unsaved: [], rolled_back: Boolean(dry_run), files: [], dialogs: null };
    this._scripted(reply, (out) => {
      const host = { interactive: true, progress: (p: Progress | null) => this.on_progress?.(p) };
      const result = run(source, this.store, out, open_module, ".",
        () => Boolean(confirm_yes), Boolean(dry_run), false, this.disk, null, [], view, host);
      reply.unsaved = result.unsaved;
      this.dialogs = result.dialogs;
    });
    reply.dialogs = this.dialogs && this.dialogs.spec();
    return reply;
  }

  // One thing a person did with a script's dialog box: its callbacks run now.
  op_dxl_event({ session, event, confirm_yes = false }: { session: number; event: DialogEvent; confirm_yes?: boolean }): any {
    const live = this.dialogs;
    if (!live || live.id !== session) {
      return { error: null, output: "", unsaved: [], files: [], rolled_back: false,
        dialogs: { session, open: false, boxes: [], messages: [] } };
    }
    const reply: any = { error: null, unsaved: [], files: [] };
    this._scripted(reply, (out) => {
      live.dispatch(event, { out, ask: () => Boolean(confirm_yes) });
    });
    reply.unsaved = live.modified().map((m) => this.store.path(m)).sort();
    reply.rolled_back = Boolean(live.rt.state.get("dry run"));
    reply.dialogs = live.spec();
    if (!live.open) this.dialogs = null;
    return reply;
  }

  op_dxl_close(_args: any = {}): void {
    this.dialogs?.end();
    this.dialogs = null;
  }

  // Run DXL and gather into `reply` what it printed, what failed and the files it wrote.
  _scripted(reply: any, work: (out: _Output) => void): void {
    const out = new _Output(this.on_output);
    // Every file written, including one rewritten with the same text as before.
    const written = new Set<string>();
    const set = this.disk.set;
    this.disk.set = (path: string, text: string) => {
      written.add(path);
      return set.call(this.disk, path, text);
    };
    try {
      work(out);
    } catch (e) {
      reply.error = _error(e);
    } finally {
      this.disk.set = set;
    }
    if (out.stopped) reply.error = { line: 0, message: out.stopped, file: null };
    reply.output = out.getvalue();
    for (const [path, text] of this.disk) {
      if (written.has(path)) reply.files.push({ name: path, text });
    }
  }

  op_dxl_column({ module, source }: any): any {
    const item = this._formal(module);
    const out = new _Output(null);
    const reply: any = { error: null, cells: {} };
    try {
      const cells = plain(layout(source, this.store, item.id, out, ".", this.disk));
      reply.cells = cells;
      let size = 0;
      for (const text of Object.values(cells)) size += (text as string).length;
      if (size > MAX_COLUMN) {
        reply.cells = {};
        reply.error = { line: 0, message: "the column is too large to show", file: null };
      }
    } catch (e) {
      reply.error = _error(e);
    }
    if (out.stopped) reply.error = { line: 0, message: out.stopped, file: null };
    reply.output = out.getvalue();
    return reply;
  }

  // -- import and export ----------------------------------------------------

  op_export_csv({ module, columns = null }: any): any {
    const item = this._formal(module);
    const parts: string[] = [];
    export_module(this.store, item.id, { write: (text: string) => { parts.push(text); return text.length; } }, columns);
    return { filename: `${item.name}.csv`, text: parts.join("") };
  }

  op_import_csv({ module, text }: any): any {
    const item = this._formal(module);
    return this.store.transaction(() => import_csv(this.store, item.id, text));
  }

  op_import_reqif({ folder, filename, base64_data }: any): any {
    return import_reqif(this.store, folder, _from_base64(base64_data), String(filename));
  }

  op_export_reqif({ modules }: any): any {
    const items = Array.from(modules ?? [], (m) => this._formal(m));
    if (!items.length) throw new StoreError("choose a module to export");
    const { text } = export_reqif(this.store, items.map((i) => i.id));
    return { filename: `${items[0].name}.reqif`, base64: _to_base64(new TextEncoder().encode(text)) };
  }
}

function _from_base64(text: unknown): Uint8Array {
  if (typeof text !== "string" || text.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(text.replace(/={1,2}$/, ""))) {
    throw new StoreError("the file did not arrive intact");
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function _to_base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}

// What the DXL operations report for anything a run threw.
function _error(e: any): any {
  if (e instanceof DxlError) return { line: e.line, message: e.message, file: e.file ?? null };
  if (e instanceof _Stopped) return { line: 0, message: e.message, file: null };
  console.error(e); // a fault in the engine: show it, keep the output
  return { line: 0, file: null, message: `the DXL engine failed: ${e?.name || "Error"}: ${e?.message ?? e}` };
}
