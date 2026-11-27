// The operations behind the browser interface. Each op_ takes one object of
// arguments and returns a JSON result.
//
// The scripts folder is a set of embedded texts; a script's files go to a
// VirtualDisk and come back in `files`; the time limit is enforced outside, by
// terminating the worker. Binary files travel as base64.

import { ROOT, RIGHTS, SYSTEM_ATTRIBUTES, AttrDxlError, Obj, Store, StoreError, rights_names } from "../store.ts";
import { checked_doc, markup_of, parse, plain_of, slice, splice } from "../rich.ts";
import { DxlError, check, coverage, layout, run, signatures } from "../dxl/index.ts";
import type { DialogSession } from "../dxl/index.ts";
import type { DialogEvent, Progress } from "../dxl/lib/dialogs.ts";
import type { VirtualDisk } from "../dxl/files.ts";
import { export_module, import_csv } from "../io/csvio.ts";
import { export_reqif, import_reqif } from "../io/reqif.ts";

export const MAX_OUTPUT = 2 * 1024 * 1024;
// A column is one short cell per object, shown a screenful at a time: a large
// module's traceability column is far more text than a script should print.
export const MAX_COLUMN = 32 * 1024 * 1024;
const MAX_PAIRS = 20000;

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

  // The characters DOORS allows in the name of a project, folder or module.
  _name(name: unknown): string {
    if (typeof name !== "string" || !/^[\p{L}\p{N} ._-]+$/u.test(name)) {
      throw new StoreError("a name holds letters, numbers, spaces, periods, underscores and hyphens, as in DOORS");
    }
    return name;
  }

  op_create_item({ parent, name, kind, description = "", prefix = "", start = "" }: any): any {
    const path = this.store.path(int(parent));
    this._name(name);
    if (kind === "formal") {
      return this.store.transaction(() => {
        const id = this.store.create_module(path, name, description, prefix);
        if (String(start).trim()) this.store.set_first_number(id, Number(start));
        return { id };
      });
    }
    if (kind === "link") return { id: this.store.create_link_module(path, name, description) };
    if (kind === "folder" || kind === "project") {
      return { id: this.store.create_folder(path, name, description, kind === "project") };
    }
    throw new StoreError(`unknown kind of item '${kind}'`);
  }

  op_update_item({ id, name = null, description = null, prefix = null }: any): void {
    // a name that is not changing is left as it is, whatever made it
    if (name !== null && name !== this.store.item(int(id)).name) this._name(name);
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
    const formattings = store.formattings(module);
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
        // the formatted values among them, as paragraphs of styled runs
        rich: Object.fromEntries([...formattings.get(obj.absno) ?? []].map(([name, markup]) => [name, parse(markup)])),
        out: links(obj, true), in: links(obj, false),
      });
    }
    const baseline = store.baseline_of(module);
    const owner = baseline ? baseline.module_id : module;
    // what the page must tell the engine about, for the triggers
    const watched = { open: store.triggers_for(module, "module", "open").length > 0,
      sync: store._reaching(module).some((t) => t.row.level === "object") };
    return {
      watched,
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
      id: b.copy_id, label: b.label, annotation: b.annotation, major: b.major, minor: b.minor,
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
  // `values` are plain text and take away any formatting, unless the text is
  // unchanged; `rich` gives values as paragraphs of styled runs.
  op_set_values({ module, absno, values = {}, rich = {} }: any): { made_own: string[] } | void {
    const obj = this._existing(module, absno);
    const made_own: string[] = [];
    // the person's own change: attribute triggers fire for it
    this.store.by_hand(() => this.store.transaction(() => {
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== "string") throw new StoreError(`${name}: the value must be text`);
        const text = value.replaceAll("\r\n", "\n");
        const inherited = this._inherited(obj, name);
        if ((inherited || this.store.formatting(obj, name) !== null) && this.store.value(obj, name) === text) continue;
        this.store.set_value(obj, name, text);
        if (inherited) made_own.push(name);
      }
      for (const [name, given] of Object.entries(rich)) {
        const doc = checked_doc(given);
        const markup = markup_of(doc);
        const inherited = this._inherited(obj, name);
        if (inherited && this.store.rich_value(obj, name) === markup) continue;
        this.store.set_rich(obj, name, markup);
        if (inherited) made_own.push(name);
      }
    }));
    if (made_own.length) return { made_own };
  }

  // The objects named, each followed by everything below it, deleted ones included.
  _trees(module: number, absnos: number[]): Obj[] {
    const found: Obj[] = [], seen = new Set<number>();
    const walk = (obj: Obj) => {
      if (seen.has(obj.absno)) return;
      seen.add(obj.absno);
      found.push(obj);
      this.store.child_objects(obj.module_id, obj.absno).forEach(walk);
    };
    for (const absno of absnos) walk(this._existing(module, absno));
    return found;
  }

  op_move_object({ module, absno, direction }: any): void {
    this.op_move_objects({ module, absnos: [absno], direction });
  }

  // An object dropped before, after, or as a child of another in its module.
  // Answers where it was, in the same terms, for Undo.
  op_drag_object({ module, absno, target, where }: any): { target: number; where: string } {
    const store = this.store;
    return store.transaction(() => {
      const obj = this._existing(module, absno), to = this._existing(module, target);
      if (store.is_deleted(obj) || store.is_deleted(to)) throw new StoreError("a deleted object cannot be moved");
      if (!["before", "after", "child"].includes(where)) throw new StoreError(`unknown place ${where}`);
      const parent = store.parent_object(obj);
      const siblings = store.child_objects(obj.module_id, parent ? parent.absno : null);
      const at = siblings.findIndex((o) => o.equals(obj));
      const was = at > 0 ? { target: siblings[at - 1].absno, where: "after" }
        : at + 1 < siblings.length ? { target: siblings[at + 1].absno, where: "before" }
          : { target: parent ? parent.absno : obj.absno, where: "child" };
      if (where === "child") store.move_object(obj, to);
      else store.move_object(obj, null, where === "after" ? to : null, where === "before" ? to : null);
      return was;
    });
  }

  // Neighbours at one level, moved as a block: one place up or down, out a level
  // or in a level. Deleted objects among them stay where they are.
  op_move_objects({ module, absnos, direction }: any): void {
    const store = this.store;
    store.transaction(() => {
      const named: Obj[] = absnos.map((a: number) => this._existing(module, a));
      const tops = named.filter((o) => !store.is_deleted(o));
      if (!tops.length) throw new StoreError("a deleted object cannot be moved");
      const parent = store.parent_object(tops[0]);
      const siblings = store.child_objects(tops[0].module_id, parent ? parent.absno : null).filter((o) => !store.is_deleted(o));
      const places = tops.map((t) => siblings.findIndex((o) => o.equals(t))).sort((a, b) => a - b);
      const first = places[0], last = places[places.length - 1];
      if (first < 0 || last - first !== places.length - 1) throw new StoreError("only neighbours at one level move together");
      const run = siblings.slice(first, last + 1);
      if (direction === "up" && first > 0) store.move_object(siblings[first - 1], undefined, run[run.length - 1]);
      else if (direction === "down" && last < siblings.length - 1) store.move_object(siblings[last + 1], undefined, undefined, run[0]);
      else if (direction === "demote" && first > 0) for (const top of run) store.move_object(top, siblings[first - 1]);
      else if (direction === "promote" && parent) for (const top of [...run].reverse()) store.move_object(top, undefined, parent);
      else throw new StoreError(`${store.identifier(run[0])} cannot move ${direction} from here`);
    });
  }

  // As Edit, Object, Delete does it: the objects and everything below them, and
  // refused while any of them still has a link coming in.
  op_delete_object({ module, absno }: any): { deleted: number[] } {
    return this.op_delete_objects({ module, absnos: [absno] });
  }

  op_delete_objects({ module, absnos }: any): { deleted: number[] } {
    const store = this.store;
    return store.transaction(() => {
      const going = this._trees(int(module), absnos).filter((o) => !store.is_deleted(o));
      if (!going.length) throw new StoreError("already deleted");
      const linked = going.filter((o) => store.links(o, false).length);
      if (linked.length) {
        const named = linked.slice(0, 4).map((o) => `${store.identifier(o)} (from ${
          store.links(o, false).slice(0, 3).map((l) => store.identifier(l.source)).join(", ")})`);
        throw new StoreError(`delete the in-links first: ${named.join("; ")}${linked.length > 4 ? ` and ${linked.length - 4} more` : ""}`);
      }
      for (const obj of [...going].reverse()) store.delete_object(obj);
      return { deleted: going.map((o) => o.absno) };
    });
  }

  op_undelete_object({ module, absno }: any): void {
    this.store.undelete_object(this._existing(module, absno));
  }

  // `absnos` list parents before their children, as delete_objects returns them.
  op_undelete_objects({ module, absnos }: any): { count: number } {
    const store = this.store;
    return store.transaction(() => {
      const back: Obj[] = absnos.map((a: number) => this._existing(module, a)).filter((o: Obj) => store.is_deleted(o));
      for (const obj of back) store.undelete_object(obj);
      return { count: back.length };
    });
  }

  // One attribute set on several objects. For a multi-valued enumeration `add`
  // and `remove` change those choices and leave each object's others alone.
  // `changes` can be given to restore_values; an inherited cell that now holds a
  // value of its own is not among them, as that cannot be undone.
  op_set_value_many(args: any): any {
    return this.store.by_hand(() => this._set_value_many(args));
  }

  _set_value_many({ module, absnos, name, value = null, add = null, remove = null }: any): any {
    const store = this.store;
    const id = this._formal(module).id;
    const definition = store.attribute(id, name);
    if (!definition) throw new StoreError(`there is no attribute '${name}'`);
    if (definition.dxl) throw new StoreError(`${name} is calculated by attribute DXL`);
    const choosing = add !== null || remove !== null;
    if (choosing && !definition.multi) throw new StoreError(`${name} holds one value`);
    if (!choosing && typeof value !== "string") throw new StoreError(`${name}: the value must be text`);
    const changes: Array<{ absno: number; name: string; before: string; after: string; rich?: string }> = [];
    let changed = 0, made_own = 0, deleted = 0;
    store.transaction(() => {
      for (const absno of absnos) {
        const obj = this._existing(id, absno);
        if (store.is_deleted(obj)) { deleted++; continue; }
        const before = store.value(obj, name);
        let next = choosing ? "" : value.replaceAll("\r\n", "\n");
        if (choosing) {
          const held = new Set(before.split("\n").filter(Boolean));
          for (const v of remove ?? []) held.delete(v);
          for (const v of add ?? []) held.add(v);
          next = definition.values.filter((v: string) => held.has(v)).join("\n");
        }
        if (next === before) continue;
        const inherited = this._inherited(obj, name);
        const rich = store.formatting(obj, name) ?? undefined;
        store.set_value(obj, name, next);
        changed++;
        if (inherited) made_own++;
        else changes.push({ absno: obj.absno, name, before, after: store.value(obj, name), rich });
      }
    });
    return { changed, made_own, deleted, changes };
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

  // Do `work`, or with `preview` do it and undo it, so that the answer says what
  // the real thing would do and refuse.
  _preview<T>(preview: boolean, work: () => T): T {
    const undo = new Error("preview");
    let result!: T;
    try {
      this.store.transaction(() => {
        result = work();
        if (preview) throw undo;
      });
    } catch (e) {
      if (e !== undo) throw e;
    }
    return result;
  }

  // A link from every source to every target, as one change. A pair already
  // linked through the link module used is left; what is refused is named.
  op_create_links({ sources, targets, link_module = null, preview = false }: any): any {
    const store = this.store;
    const from: Obj[] = sources.map((s: any) => this._existing(s.module, s.absno));
    const to: Obj[] = targets.map((t: any) => this._existing(t.module, t.absno));
    if (from.length * to.length > MAX_PAIRS) {
      throw new StoreError(`that is ${from.length * to.length} pairs; at most ${MAX_PAIRS} are linked at once here`);
    }
    return this._preview(preview, () => {
      const refused = new Set<string>();
      let made = 0, existing = 0;
      for (const start of from) {
        const had = new Set(store.links(start, true).map((l) => l.id));
        for (const end of to) {
          if (start.equals(end)) continue;
          try {
            if (had.has(store.create_link(start, end, link_module || null).id)) existing++;
            else made++;
          } catch (e) {
            if (!(e instanceof StoreError)) throw e;
            refused.add(e.message);
          }
        }
      }
      return { made, existing, refused: [...refused] };
    });
  }

  // The links from any source to any target through one link module.
  op_delete_links_between({ sources, targets, link_module, preview = false }: any): { count: number } {
    const store = this.store;
    const ends = new Set(targets.map((t: any) => this._existing(t.module, t.absno).key));
    return this._preview(preview, () => {
      let count = 0;
      for (const s of sources) {
        for (const link of store.links(this._existing(s.module, s.absno), true)) {
          if (!ends.has(link.target.key) || store.path(link.link_module) !== link_module) continue;
          store.delete_link(link);
          count++;
        }
      }
      return { count };
    });
  }

  // Every link into or out of the objects of a module.
  op_delete_all_links({ module, preview = false }: any): { out: number; in: number } {
    const store = this.store;
    const id = this._formal(module).id;
    return this._preview(preview, () => {
      const counts = { out: 0, in: 0 };
      for (const outgoing of [true, false]) {
        for (const obj of store.objects(id)) {
          for (const link of store.links(obj, outgoing)) {
            store.delete_link(link);
            counts[outgoing ? "out" : "in"]++;
          }
        }
      }
      return counts;
    });
  }

  op_delete_out_links({ module, absnos }: any): { count: number } {
    const store = this.store;
    return store.transaction(() => {
      let count = 0;
      for (const absno of absnos) {
        for (const link of store.links(this._existing(module, absno), true)) {
          store.delete_link(link);
          count++;
        }
      }
      return { count };
    });
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

  // Move (cut) or copy objects after `ref`, below it, or at the end. `source`
  // names one object (`absno`) or neighbours (`absnos`); a copy takes what is
  // below them unless `hierarchy` is false.
  op_paste_object({ source, module: module_arg, ref = null, where = "end", cut = false, hierarchy = true }: any): any {
    const store = this.store;
    const module = this._formal(module_arg).id;
    const from: Obj[] = (source.absnos ?? [source.absno]).map((a: number) => this._existing(source.module, a));
    for (const obj of from) if (store.is_deleted(obj)) throw new StoreError(`${store.identifier(obj)} is deleted`);
    const place = ref === null ? null : this._existing(module, ref);
    const parent = place && where === "child" ? place : null;
    const after = place && where !== "child" ? place : null;
    if (cut) {
      if (from.some((o) => o.module_id !== module)) throw new StoreError("a cut object moves within its own module; use Copy to put it in another");
      store.transaction(() => {
        from.forEach((obj, i) => store.move_object(obj, i ? null : parent, i ? from[i - 1] : after));
      });
      return { absno: from[0].absno, count: from.length, skipped: [] };
    }
    // Read everything first: it may be pasted inside itself.
    const known = new Map(store.attributes(module).map((a) => [a.name, a]));
    const values: any = store.values(from[0].module_id, true); // inherited values stay inherited
    const formattings = store.formattings(from[0].module_id, true);
    const skipped = new Set<string>();
    type Branch = { values: Map<string, string>; rich: Map<string, string>; children: Branch[] };
    const read = (obj: Obj): Branch => {
      const held = new Map<string, string>();
      for (const [name, value] of (values.get(obj.absno) ?? []) as Iterable<[string, string]>) {
        const target = known.get(name);
        if (!value || target?.dxl) continue;
        if (!target || (target.base === "Enumeration" && !value.split("\n").every((v) => target.values.includes(v)))) skipped.add(name);
        else held.set(name, value);
      }
      const rich = new Map([...formattings.get(obj.absno) ?? []].filter(([name]) => held.has(name)
        && ["String", "Text"].includes(known.get(name)!.base)));
      return { values: held, rich, children: !hierarchy ? [] : store.child_objects(obj.module_id, obj.absno).filter((o) => !store.is_deleted(o)).map(read) };
    };
    const branches = from.map(read);
    let count = 0;
    return store.transaction(() => {
      const make = (node: Branch, up: Obj | null, behind: Obj | null): Obj => {
        const made = store.create_object(module, up, behind, null, node.values);
        for (const [name, markup] of node.rich) store.set_rich(made, name, markup);
        count++;
        for (const child of node.children) make(child, made, null);
        return made;
      };
      let first: Obj | null = null, last: Obj | null = null;
      for (const branch of branches) {
        last = make(branch, last ? null : parent, last ?? after);
        first ??= last;
      }
      return { absno: first!.absno, count, skipped: [...skipped] };
    });
  }

  // A new object takes the heading and the place; this object, with its text and
  // links, becomes its first child, and this object's children follow it there.
  op_split_heading({ module, absno }: any): { absno: number } {
    const store = this.store;
    const obj = this._existing(module, absno);
    const heading = store.value(obj, "Object Heading");
    if (!heading || !store.value(obj, "Object Text")) {
      throw new StoreError(`${store.identifier(obj)} needs both a heading and text to split them`);
    }
    return store.transaction(() => {
      const markup = store.formatting(obj, "Object Heading");
      const made = store.create_object(obj.module_id, null, null, obj, new Map([["Object Heading", heading]]));
      if (markup !== null) store.set_rich(made, "Object Heading", markup);
      const kids = store.child_objects(obj.module_id, obj.absno);
      store.set_value(obj, "Object Heading", "");
      store.move_object(obj, made);
      let last = obj;
      for (const kid of kids) {
        store.move_object(kid, null, last);
        last = kid;
      }
      return { absno: made.absno };
    });
  }

  // Each paragraph of the text after the first becomes an object of its own, after this one.
  op_split_object({ module, absno }: any): void {
    const store = this.store;
    const obj = this._existing(module, absno);
    const parts = store.value(obj, "Object Text").split(/\n[ \t]*\n/).map((p) => p.replace(/^\n+|\s+$/g, "")).filter(Boolean);
    if (parts.length < 2) throw new StoreError(`${store.identifier(obj)} has no blank line in its Object Text to split at`);
    const markup = store.formatting(obj, "Object Text");
    const whole = store.value(obj, "Object Text");
    let from = 0;
    store.transaction(() => {
      let last = obj;
      parts.forEach((text, i) => {
        if (i) last = store.create_object(obj.module_id, null, last, null, new Map([["Object Text", text]]));
        else if (markup === null) store.set_value(obj, "Object Text", text);
        if (markup === null) return;
        from = whole.indexOf(text, from);
        store.set_rich(last, "Object Text", markup_of(slice(parse(markup), from, from + text.length)));
        from += text.length;
      });
    });
  }

  op_purge({ module }: any): any {
    return { purged: this.store.purge(this._formal(module).id) };
  }

  // Replacement in the text of the String and Text attributes of the objects
  // named; what a match is replaced with takes the formatting where it began.
  // Replaces in Object Heading and Object Text, or with `all_text` in every
  // String and Text attribute; without `absnos`, in every object of the module.
  op_replace_text({ module: module_arg, absnos = null, find, replace, match_case = false, all_text = false }: any): any {
    const store = this.store;
    const module = this._formal(module_arg).id;
    if (typeof find !== "string" || !find) throw new StoreError("type what to find");
    const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), match_case ? "g" : "gi");
    const names = store.attributes(module).filter((a) => !a.dxl && (a.base === "String" || a.base === "Text")
      && (all_text || a.name === "Object Heading" || a.name === "Object Text")).map((a) => a.name);
    const changes: Array<{ absno: number; name: string; before: string; after: string; rich?: string }> = [];
    let count = 0;
    store.transaction(() => {
      for (const absno of absnos ?? store.objects(module).map((o) => o.absno)) {
        const obj = this._existing(module, absno);
        for (const name of names) {
          if (this._inherited(obj, name)) continue; // replaced where it is held
          const before = store.value(obj, name);
          let found = 0;
          const after = before.replace(pattern, () => { found++; return String(replace); });
          if (!found || after === before) continue;
          const rich = store.formatting(obj, name) ?? undefined;
          if (rich === undefined) store.set_value(obj, name, after);
          else {
            let doc = parse(rich);
            for (const match of [...before.matchAll(pattern)].reverse()) {
              doc = splice(doc, match.index, match.index + match[0].length, String(replace));
            }
            if (plain_of(doc) !== after) throw new StoreError(`${name}: this replacement is not supported`);
            store.set_rich(obj, name, markup_of(doc));
          }
          count += found;
          changes.push({ absno: obj.absno, name, before, after: store.value(obj, name), rich });
        }
      }
    });
    return { count, changes };
  }

  // Undo of values: put `before` back where `after` is still what is held.
  op_restore_values({ module, changes }: any): any {
    let skipped = 0;
    this.store.transaction(() => {
      for (const { absno, name, before, after, rich, doc } of changes) {
        const obj = this.store.object(int(module), int(absno));
        if (obj === null || this.store.value(obj, name) !== after) skipped++;
        else if (typeof rich === "string") this.store.set_rich(obj, name, rich);
        else if (doc) this.store.set_rich(obj, name, markup_of(checked_doc(doc)));
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

  // A deleted object and everything below it, gone for good.
  op_purge_object({ module, absno }: any): { purged: number } {
    const store = this.store;
    const obj = this._existing(module, absno);
    if (!store.is_deleted(obj)) throw new StoreError(`delete ${store.identifier(obj)} first`);
    return store.transaction(() => {
      const going = this._trees(obj.module_id, [obj.absno]);
      for (const each of [...going].reverse()) store.purge_object(each);
      return { purged: going.length };
    });
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
  // The attribute lists objects of the target module, by absolute number or by
  // identifier. `direction` is from this module ("out"), to it ("in"), or "both".
  op_link_by_attribute({ module: module_arg, attribute, target_module, link_module = null, preview = true, direction = "out" }: any): any {
    const store = this.store;
    const module = this._formal(module_arg).id;
    const target = this._formal(target_module).id;
    if (target === module) throw new StoreError("choose another module as the target");
    if (!store.has_attribute(module, attribute)) throw new StoreError(`there is no attribute '${attribute}'`);
    const prefix = store.prefix(target);
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!["out", "in", "both"].includes(direction)) throw new StoreError("choose a link direction");
    // A value that is only numbers lists absolute numbers. In other text, only
    // the target's identifiers are read: other digits are not references.
    const listed = (text: string): string[] => {
      const parts = text.split(/[\s,;]+/).filter(Boolean);
      if (parts.every((p) => /^[0-9]+$/.test(p))) return parts;
      if (!prefix) return [];
      return [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_-])${escaped}[0-9]+(?![A-Za-z0-9_])`, "g"))].map((m) => m[0]);
    };
    const missing = new Set<string>(), refused = new Set<string>();
    let made = 0, existing = 0;
    const path = link_module || null;
    const rolled_back = new Error("preview");
    try {
      store.transaction(() => {
        for (const obj of store.objects(module)) {
          for (const name of new Set(listed(store.value(obj, attribute)))) {
            const other = /^[0-9]+$/.test(name) ? store.object(target, Number(name)) : store.by_identifier(target, name);
            if (other === null || store.is_deleted(other)) { missing.add(name); continue; }
            for (const [start, end] of [...(direction !== "in" ? [[obj, other]] : []), ...(direction !== "out" ? [[other, obj]] : [])]) {
              const held = store.links(start, true).some((l) => l.target.equals(end)
                && (!path || store.path(l.link_module) === path));
              if (held) { existing++; continue; }
              try {
                store.create_link(start, end, path);
                made++;
              } catch (e) {
                if (!(e instanceof StoreError)) throw e;
                refused.add(e.message);
              }
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

  // -- triggers ----------------------------------------------------------------

  // The person has opened a module, or (with `absno`) made an object current.
  op_user_event({ module, absno = null }: any): { note: string | null } {
    const id = int(module);
    const level = absno === null ? "module" : "object";
    this.store.user_event(level, absno === null ? "open" : "sync", id, absno === null ? null : int(absno), () => {});
    const unsettled = absno === null && this.store._reaching(id).some((t) => t.row.level === "object");
    return { note: unsettled ? "Sync triggers did not run for the object current on opening: whether DOORS "
      + "runs them then is not documented." : null };
  }

  // Every stored trigger, so that one can be seen and removed without DXL.
  op_triggers(_args: any = {}): any {
    const store = this.store;
    return {
      triggers: store.trigger_holders().flatMap((at) => store.own_triggers(at).map(({ row }, index) => ({
        at, index, path: store.path(at), name: row.name, dxl: row.dxl, priority: row.priority,
        fires: `${row.when}-${row.event}, ${row.level}` + (row.attribute ? ` ${row.attribute}` : "")
          + (row.absno === undefined ? "" : ` ${row.absno}`),
      }))),
    };
  }

  op_remove_trigger({ at, index }: any): void {
    const found = this.store.own_triggers(int(at))[int(index)];
    if (!found) throw new StoreError("that trigger no longer exists");
    this.store.delete_trigger(found.at, found.row, false);
  }

  // What triggers have printed since this was last asked.
  op_trigger_output(_args: any = {}): { text: string } {
    return { text: this.store.trigger_output.splice(0).join("") };
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

  // -- opening, copying modules, baseline sets -------------------------------

  // A history session starts each time a module is opened for editing.
  op_record_session({ module }: any): void {
    this.store.record_session(this._formal(module).id);
  }

  op_copy_module({ module, name, description = "" }: any): { id: number } {
    return { id: this.store.copy_module(this._formal(module).id, this._name(String(name).trim()), String(description)) };
  }

  // Every baseline set definition, with its sets and the baselines in them.
  op_baseline_sets(_args: any = {}): any {
    const store = this.store;
    return {
      definitions: store.all_set_definitions().map(([folder, d]) => ({
        folder, folder_path: store.path(folder), id: d.id, name: d.name, description: d.description,
        modules: d.modules.map((m) => ({ id: m, path: store.path(m) })),
        sets: d.sets.map((set, index) => ({
          index, label: `${set.major}.${set.minor}${set.suffix ? ` ${set.suffix}` : ""}`, open: set.open,
          annotation: set.annotation, user: set.user, date: set.date,
          members: set.members.map((copy) => {
            const baseline = store.baseline_of(copy)!;
            return { copy, module: baseline.module_id, path: store.path(baseline.module_id), label: baseline.label };
          }),
        })),
      })),
    };
  }

  // Which baseline set each of a module's baselines belongs to, if any.
  op_baseline_set_names({ module }: any): Record<number, string> {
    const store = this.store;
    const names: Record<number, string> = {};
    for (const baseline of store.baselines(this._formal(module).id)) {
      const held = store.baseline_set_of(baseline.copy_id);
      if (!held) continue;
      const d = store.set_definitions(held.folder).find((each) => each.id === held.id)!;
      const set = d.sets[held.index];
      names[baseline.copy_id] = `${d.name} ${set.major}.${set.minor}`;
    }
    return names;
  }

  op_create_set_definition({ folder, name, description = "", modules = [] }: any): { id: number } {
    return { id: this.store.create_set_definition(int(folder), String(name).trim(), description, modules.map(int)) };
  }

  op_update_set_definition({ folder, id, name, description = "", modules = [] }: any): void {
    this.store.update_set_definition(int(folder), int(id), { name: String(name).trim(), description, modules: modules.map(int) });
  }

  op_delete_set_definition({ folder, id }: any): void {
    this.store.delete_set_definition(int(folder), int(id));
  }

  op_create_baseline_set({ folder, id, major = false, suffix = "", annotation = "" }: any): { index: number } {
    return { index: this.store.create_baseline_set(int(folder), int(id), !!major, suffix, annotation) };
  }

  op_add_to_baseline_set({ folder, id, index, modules }: any): void {
    this.store.add_to_baseline_set(int(folder), int(id), int(index), modules.map(int));
  }

  op_close_baseline_set({ folder, id, index }: any): void {
    this.store.close_baseline_set(int(folder), int(id), int(index));
  }

  op_dxl_coverage(_args: any = {}): any {
    return coverage();
  }

  op_dxl_functions(_args: any = {}): any {
    return signatures();
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

  // Find the errors a run would find before running, without running.
  op_check({ source }: any): any {
    try {
      check(source, this.store, ".", this.disk);
    } catch (e) {
      return { error: _error(e) };
    }
    return { error: null };
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

  // Files of the person's own, where a script that names them finds them.
  op_add_file({ name, text }: any): { path: string } {
    const bare = String(name).split(/[\\/]/).pop()!.trim();
    if (!bare || bare === "." || bare === "..") throw new StoreError("the file needs a name");
    const path = this.disk.cwd.replace(/\/$/, "") + "/" + bare;
    this.disk.set(path, String(text));
    return { path };
  }

  op_remove_file({ path }: any): void {
    if (!this.disk.delete(String(path))) throw new StoreError("there is no such file");
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
