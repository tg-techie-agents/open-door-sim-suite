// The operations behind the traceability tools (trace.js). They are added to
// Api, so the worker finds them like any other operation.
//
// Suspicion is seen from one end of a link: an object is marked when the object
// at the other end has changed since the link was made or last cleared. So an
// out-link is suspect when its target changed, an in-link when its source did.

import { ROOT, StoreError } from "../store.ts";
import type { Link, Obj, Store } from "../store.ts";
import { Api } from "./api.ts";
import { traceability_columns } from "./trace-wizard.ts";

const _text = (store: Store, obj: Obj): string =>
  store.value(obj, "Object Heading") || store.value(obj, "Object Text") || store.value(obj, "Object Short Text");

// A heading with nothing else: usually not something to be traced.
const _is_heading = (store: Store, obj: Obj): boolean =>
  !!store.value(obj, "Object Heading") && !store.value(obj, "Object Text");

// Folders, projects and modules that are not deleted, by id.
function _live(store: Store): Set<number> {
  return new Set<number>(Array.from(store.walk() as Iterable<any>, (item: any) => item.id));
}

function _formal(store: Store): any[] {
  return Array.from(store.walk() as Iterable<any>).filter((item: any) => item.kind === "formal");
}

// The links of one object whose far end can be shown.
function _links(store: Store, live: Set<number>, obj: Obj, outgoing: boolean): Link[] {
  return store.links(obj, outgoing).filter((link) => {
    const other = outgoing ? link.target : link.source;
    return live.has(other.module_id) && !store.is_deleted(other);
  });
}

const _is_suspect = (store: Store, link: Link, outgoing: boolean): boolean =>
  store.suspect(link)[outgoing ? 1 : 0];

function _op_info(this: Api): any {
  const store = this.store;
  const items = Array.from(store.walk() as Iterable<any>);
  return {
    linkModules: items.filter((i) => i.kind === "link").map((i) => ({ path: store.path(i.id), name: i.name })),
    formalModules: items.filter((i) => i.kind === "formal").map((i) => ({
      id: i.id, path: store.path(i.id), name: i.name,
      attributes: Array.from(store.attributes(i.id) as Iterable<any>).filter((a: any) => a.scope === "object")
        .map((a: any) => a.name),
    })),
  };
}

function _op_columns(this: Api, options: any): any {
  return traceability_columns(options);
}

// Which modules link to which, and how much of each is covered.
function _op_overview(this: Api, { headings = false }: any = {}): any {
  const store = this.store;
  const live = _live(store);
  const modules = new Map<number, any>();
  const counted = new Map<number, Set<number>>();
  const sets = new Map<string, any>();
  for (const item of _formal(store)) {
    const mine = new Set<number>();
    counted.set(item.id, mine);
    const row = { id: item.id, path: store.path(item.id), name: item.name, total: 0, no_out: 0, no_in: 0, no_links: 0 };
    modules.set(item.id, row);
    for (const obj of store.objects(item.id)) {
      const out = _links(store, live, obj, true);
      for (const link of out) {
        const key = `${link.link_module}:${item.id}:${link.target.module_id}`;
        let set = sets.get(key);
        if (!set) {
          sets.set(key, set = { link_module: store.path(link.link_module), source: item.id,
            target: link.target.module_id, links: 0, suspect_at_source: 0, suspect_at_target: 0,
            sources: new Set<number>(), targets: new Set<number>() });
        }
        set.links++;
        set.sources.add(obj.absno);
        set.targets.add(link.target.absno);
        if (_is_suspect(store, link, true)) set.suspect_at_source++;
        if (_is_suspect(store, link, false)) set.suspect_at_target++;
      }
      if (!headings && _is_heading(store, obj)) continue;
      mine.add(obj.absno);
      const incoming = _links(store, live, obj, false).length;
      row.total++;
      if (!out.length) row.no_out++;
      if (!incoming) row.no_in++;
      if (!out.length && !incoming) row.no_links++;
    }
  }
  const covered = (module: number, linked: Set<number>) =>
    [...linked].filter((absno) => counted.get(module)!.has(absno)).length;
  const linksets = [...sets.values()].map(({ sources, targets, ...set }) => ({
    ...set,
    source_path: modules.get(set.source).path, target_path: modules.get(set.target).path,
    sources_linked: covered(set.source, sources), sources_total: counted.get(set.source)!.size,
    targets_linked: covered(set.target, targets), targets_total: counted.get(set.target)!.size,
  })).sort((a, b) => a.link_module.localeCompare(b.link_module) || a.source_path.localeCompare(b.source_path)
    || a.target_path.localeCompare(b.target_path));
  return { modules: [...modules.values()], linksets };
}

// One linkset as a matrix: source objects down, target objects across.
function _op_matrix(this: Api, { link_module, source, target }: any): any {
  const store = this.store;
  const live = _live(store);
  if (!live.has(Number(source)) || !live.has(Number(target))) throw new StoreError("that module no longer exists");
  const end = (obj: Obj) => ({ absno: obj.absno, id: store.identifier(obj), text: _text(store, obj),
    heading: _is_heading(store, obj) });
  const rows = Array.from(store.objects(Number(source)) as Iterable<Obj>);
  const columns = Array.from(store.objects(Number(target)) as Iterable<Obj>);
  const at = new Map(columns.map((obj, i) => [obj.absno, i]));
  const marks: [number, number, boolean, boolean][] = [];
  rows.forEach((obj, r) => {
    for (const link of store.links(obj, true, link_module)) {
      const c = link.target.module_id === Number(target) ? at.get(link.target.absno) : undefined;
      if (c === undefined) continue;
      marks.push([r, c, _is_suspect(store, link, true), _is_suspect(store, link, false)]);
    }
  });
  return { rows: rows.map(end), columns: columns.map(end), marks };
}

// Every suspect link seen from the objects of a module, with the edits behind it.
function _op_suspects(this: Api, { module }: any): any {
  const store = this.store;
  const live = _live(store);
  const id = Number(module);
  if (store.item(id).kind !== "formal") throw new StoreError("choose a formal module");
  if (store.is_baseline(id)) throw new StoreError("suspect links are shown on the current version, not a baseline");
  const entry = (link: Link, outgoing: boolean) => {
    const other = outgoing ? link.target : link.source;
    return {
      link: link.id,
      source: { module: link.source.module_id, absno: link.source.absno },
      link_module: store.item(link.link_module).name,
      never_cleared: store.link_modified(link) !== null,
      other: { module: other.module_id, absno: other.absno, id: store.identifier(other),
        path: store.path(other.module_id), text: _text(store, other) },
      modified_on: store.value(other, "Last Modified On"),
      modified_by: store.value(other, "Last Modified By"),
      changes: store.suspect_changes(link, other).map((h: any) => ({
        when: h.when, who: h.who, action: h.action, attribute: h.attribute, old: h.old, new: h.new,
      })),
    };
  };
  const objects: any[] = [];
  for (const obj of store.objects(id)) {
    const of = (outgoing: boolean) => _links(store, live, obj, outgoing)
      .filter((link) => _is_suspect(store, link, outgoing)).map((link) => entry(link, outgoing));
    objects.push({ absno: obj.absno, id: store.identifier(obj), in: of(false), out: of(true) });
  }
  return { objects };
}

// Clear suspicion on the links named, all or none. Clearing at one end clears
// the link, so the other end is no longer marked either.
function _op_clear_suspect(this: Api, { items }: any): any {
  const store = this.store;
  if (!Array.isArray(items) || !items.length) throw new StoreError("choose a suspect link to clear");
  return store.transaction(() => {
    const done = new Set<number>();
    for (const { source, link } of items) {
      const start = store.object(Number(source.module), Number(source.absno));
      if (start === null || start.module_id === ROOT) throw new StoreError("that object no longer exists");
      if (store.is_baseline(start.module_id)) throw new StoreError("a baseline cannot be changed");
      const found = store.links(start, true).find((l) => l.id === link);
      if (!found) throw new StoreError("that link no longer exists");
      store.clear_suspect(found);
      done.add(found.id);
    }
    return { cleared: done.size };
  });
}

Object.assign(Api.prototype, {
  op_trace_info: _op_info,
  op_trace_columns: _op_columns,
  op_trace_overview: _op_overview,
  op_trace_matrix: _op_matrix,
  op_trace_suspects: _op_suspects,
  op_trace_clear_suspect: _op_clear_suspect,
});
