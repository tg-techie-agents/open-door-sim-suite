// Link deletions DOORS would not have carried out yet.
//
// In DOORS delete(link) only marks the link; it goes when the script ends or at
// flushDeletions(). Here it goes at once. What a script is then shown in between
// is not offered: whatever could show the difference asks this module first, and
// stops. The record is the database's, so that attribute DXL and column DXL,
// which run apart from the script, see it too.

import type { Link, Obj, Store } from "../../store.ts";
import { Fault } from "../runtime.ts";
import type { Runtime } from "../runtime.ts";

type Deletion = { link: Link; saved: boolean }; // saved: its source module was, since

const records = new WeakMap<Store, Deletion[]>();
const held = (rt: Runtime): Deletion[] => records.get(rt.store) ?? [];

function stop_if(shows: boolean, call: string): void {
  if (shows) {
    throw new Fault(`${call}: a link deleted here is only marked in DOORS until the script ends or `
      + "flushDeletions() runs, and what DOORS answers meanwhile is not offered; call flushDeletions() "
      + "first, outside any for loop");
  }
}

export function link_deleted(rt: Runtime, link: Link): void {
  records.set(rt.store, [...held(rt), { link, saved: false }]);
}

// not the id alone: a new link can be given the id of one just deleted
const same = (a: Link, b: Link): boolean => a.id === b.id && a.link_module === b.link_module
  && a.source.equals(b.source) && a.target.equals(b.target);

const marked = (rt: Runtime, link: Link): boolean => held(rt).some((d) => same(d.link, link));

/** Using the deleted link itself for what its deletion would change. */
export function check_link(rt: Runtime, link: Link, call: string): void {
  stop_if(marked(rt, link), call);
}

/** The link a handle names. One still only marked answers for itself; one that
 * has gone (flushed, or removed with its object) does not. */
export function live_link(rt: Runtime, value: unknown): Link {
  const link: Link = rt.need(value, "Link");
  if (!marked(rt, link) && !rt.store.links(link.source, true).some((l: Link) => same(l, link))) {
    throw new Fault("this link has been deleted, and what DOORS does with its handle then is not offered");
  }
  return link;
}

/** Reading the links at one end of an object, through the modules `name` takes in. */
export function check_end(rt: Runtime, obj: Obj, outgoing: boolean, name: string, call: string): void {
  if (!held(rt).length) return;
  const wanted = rt.store.link_modules(name);
  stop_if(held(rt).some(({ link }) => (outgoing ? link.source : link.target).equals(obj)
    && wanted.has(link.link_module)), call);
}

/** Making a link where one like it is still marked. `path` null: any link module. */
export function check_new(rt: Runtime, source: Obj, target: Obj, path: string | null): void {
  stop_if(held(rt).some(({ link }) => link.source.equals(source) && link.target.equals(target)
    && (path === null || rt.store.path(link.link_module) === path)), "creating a link");
}

/** Anything that takes in a module's outgoing links, or its history of them. */
export function check_source(rt: Runtime, module_id: number, call: string, absno: number | null = null): void {
  stop_if(held(rt).some(({ link }) => link.source.module_id === module_id
    && (absno === null || link.source.absno === absno)), call);
}

export function module_saved(rt: Runtime, module_id: number): void {
  for (const d of held(rt)) if (d.link.source.module_id === module_id) d.saved = true;
}

/** The marked links go now. A module saved in between has changed again. */
export function carry_out(rt: Runtime): void {
  for (const d of held(rt)) if (d.saved) rt.modified.add(d.link.source.module_id);
  records.delete(rt.store);
}

export function flush(rt: Runtime): void {
  if (held(rt).length && rt.for_depth > 0) {
    throw new Fault("flushDeletions: the DXL manual says not to flush inside a for loop, so that is not offered "
      + "here: call it after the loop");
  }
  carry_out(rt);
}

/** A new run starts with nothing marked. */
export function forget(store: Store): void {
  records.delete(store);
}
