// Access rights from DXL. The store keeps and enforces them.
//
// A Permission is the store's bits, already closed over what each right brings.
// An AccessRec is one entry of a thing's own list; the name is null for the
// entry that covers everyone else. Not offered: access to views, attribute
// types, groups' own lists, partitions and the rights create propagates.

import { RIGHTS, StoreError, closed_rights } from "../../store.ts";
import type { AccessEntry } from "../../store.ts";
import type { Library } from "../registry.ts";
import { Fault, limit } from "../runtime.ts";
import type { Ref, Runtime } from "../runtime.ts";
import { attempt, handle } from "./database.ts";

const THINGS = ["Object", "Module", "Folder", "Project", "Item"];
const WRITE = RIGHTS.modify | RIGHTS.create | RIGHTS.delete;

// A call DOORS fails for want of control access returns a message. Anything
// else the store refuses is a limit of this suite, and stops the script.
function changing(run: () => void): string {
  const message = attempt(run);
  if (message === "" || message.startsWith("no access:")) return message;
  throw limit(message);
}

// the store's name for what a handle means, with the module open where it must be
function guarded(rt: Runtime, type_name: string, value: any): any {
  if (type_name === "Object") return rt.obj(value);
  if (type_name === "Module") return rt.need(value, "Module");
  return handle(rt, type_name, value);
}

// DOORS takes a null name to mean everyone else
function entry_name(name: string): string | null {
  if (name.toLowerCase() === "everyone else") {
    throw new Fault('name everyone else with a null string, not "Everyone Else"');
  }
  return name === "" ? null : name;
}

function register_permissions(lib: Library): void {
  lib.type("Permission");
  const constants: [string, number][] = [["none", 0], ["read", RIGHTS.read], ["modify", RIGHTS.modify],
    ["create", RIGHTS.create], ["delete", RIGHTS.delete], ["control", RIGHTS.control], ["write", WRITE],
    ["change", RIGHTS.control]];
  for (const [name, bits] of constants) lib.add(name, [], "Permission", () => closed_rights(bits));
  lib.operator("|", "Permission", "Permission", "Permission", (rt: Runtime, a: number, b: number) => a | b);
  lib.operator("&", "Permission", "Permission", "Permission", (rt: Runtime, a: number, b: number) => a & b);
  lib.operator("==", "Permission", "Permission", "bool", (rt: Runtime, a: number, b: number) => a === b);
  lib.operator("!=", "Permission", "Permission", "bool", (rt: Runtime, a: number, b: number) => a !== b);
}

function register_changes(lib: Library): void {
  for (const type_name of THINGS) {
    const on = (rt: Runtime, value: any) => guarded(rt, type_name, value);
    const set_for = (rt: Runtime, x: any, rights: number, name: string | null) => {
      const thing = on(rt, x), who = entry_name(name ?? "");
      return changing(() => rt.store.set_access(thing, who, rights));
    };
    lib.add("set", [type_name, "Permission", "string"], "string", set_for);
    lib.add("set", [type_name, "Permission", "null"], "string", set_for); // a literal null: everyone else
    lib.add("unset", [type_name, "string"], "string", (rt: Runtime, x: any, name: string) => {
      const thing = on(rt, x), who = entry_name(name);
      if (who === null) return "no user or group was named";
      return changing(() => rt.store.unset_access(thing, who));
    });
    lib.add("specific", [type_name], "string", (rt: Runtime, x: any) => {
      const thing = on(rt, x);
      return changing(() => rt.store.make_access_specific(thing));
    });
    lib.add("inherited", [type_name], "string", (rt: Runtime, x: any) => {
      const thing = on(rt, x);
      return changing(() => rt.store.make_access_inherited(thing));
    });
    lib.add("isAccessInherited", [type_name, "&bool"], "string", (rt: Runtime, x: any, out: Ref) => {
      const thing = on(rt, x);
      return attempt(() => out.set(rt.store.is_access_inherited(thing)));
    });

    // -- records: only a thing's own list, as DOORS leaves inherited rights out
    const own = (rt: Runtime, x: any): AccessEntry[] => {
      const thing = on(rt, x);
      return rt.store.is_access_inherited(thing) ? [] : rt.store.access_list(thing);
    };
    lib.loop(type_name, "AccessRec", own);
    const get = (rt: Runtime, x: any, name: string | null, message: Ref) => {
        const who = entry_name(name ?? "");
        const found = own(rt, x).find((e) => e.name === who) ?? null;
        // whether DOORS reports a missing entry as an error is not documented
        if (found === null && own(rt, x).length) {
          throw new Fault(`get: there is no access entry for ${name || "everyone else"}, and what DOORS then `
            + "answers is not documented");
        }
        message.set("");
        return found;
      };
    lib.add("get", [type_name, "string", "&string"], "AccessRec", get);
    lib.add("get", [type_name, "null", "&string"], "AccessRec", get);
  }
}

function register_records(lib: Library): void {
  lib.type("AccessRec");
  const need = (rt: Runtime, a: any): AccessEntry => rt.need(a, "AccessRec");
  // the manual: a null name means the record is the default one
  lib.add("username", ["AccessRec"], "string", (rt: Runtime, a: any) => need(rt, a).name ?? "");
  lib.add("isDefault", ["AccessRec"], "bool", (rt: Runtime, a: any) => need(rt, a).name === null);
  for (const [call, right] of [["read", "read"], ["create", "create"], ["modify", "modify"], ["delete", "delete"],
    ["control", "control"], ["write", "modify"], ["change", "control"]] as const) {
    lib.add(call, ["AccessRec"], "bool", (rt: Runtime, a: any) => (need(rt, a).rights & RIGHTS[right]) !== 0);
  }
}

type Change = (own: AccessEntry[] | undefined, effective: AccessEntry[]) => AccessEntry[] | undefined;
type Target = {
  read(): { entries: AccessEntry[]; inherited: boolean };
  change(change: Change): void;
};

const specific: Change = (own, effective) => own ?? effective;
const inherit: Change = () => undefined;

function listed(own: AccessEntry[] | undefined): AccessEntry[] {
  if (!own) throw new StoreError("the access rights are inherited; make them specific first");
  return own;
}

// The calls for one kind of thing with a list of its own, found from `params`.
function register_inner(lib: Library, params: string[], suffix: string,
  target: (rt: Runtime, args: any[]) => Target): void {
  const n = params.length;
  const add = (name: string, more: string[], impl: (t: Target, ...rest: any[]) => string) =>
    lib.add(name + suffix, [...params, ...more], "string",
      (rt: Runtime, ...args: any[]) => impl(target(rt, args.slice(0, n)), ...args.slice(n)));

  for (const who of ["string", "null"]) {
    add("set", ["Permission", who], (t, rights: number, name: string | null) => {
      const entry = entry_name(name ?? "");
      return changing(() => t.change((own) => [...listed(own).filter((e) => e.name !== entry),
        { name: entry, rights: closed_rights(rights) }]));
    });
  }
  add("specific", [], (t) => changing(() => t.change(specific)));
  add("inherited", [], (t) => changing(() => t.change(inherit)));
  add("unset", ["string"], (t, name: string) => {
    const entry = entry_name(name);
    if (entry === null) return "no user or group was named";
    return changing(() => t.change((own) => {
      if (!listed(own).some((e) => e.name === entry)) throw new StoreError(`there is no access entry for ${entry}`);
      return listed(own).filter((e) => e.name !== entry);
    }));
  });
  add("unsetAll", [], (t) => changing(() => t.change((own) => listed(own).filter((e) => e.name === null))));
  add("isAccessInherited", ["&bool"], (t, out: Ref) => attempt(() => out.set(t.read().inherited)));
}

function view_of(rt: Runtime, view: any): { module_id: number; name: string } {
  const v = rt.need(view, "View");
  rt.opened_module(v.module_id);
  if (!rt.store.views(v.module_id).has(v.name)) {
    throw new Fault(`access rights of the view ${v.name} are not offered here: it is not a saved view`);
  }
  return v;
}

function register_inner_lists(lib: Library): void {
  for (const [suffix, part] of [["Def", "definition"], ["Val", "values"]] as const) {
    register_inner(lib, ["Module", "AttrDef"], suffix, (rt, [m, d]) => {
      const module_id = rt.opened_module(m), name: string = rt.need(d, "AttrDef").name;
      return {
        read: () => rt.store.attribute_access(module_id, name, part),
        change: (change) => rt.store.change_attribute_access(module_id, name, part, change),
      };
    });
  }
  register_inner(lib, ["View"], "", (rt, [view]) => {
    const { module_id, name } = view_of(rt, view);
    return {
      read: () => rt.store.view_access(module_id, name),
      change: (change) => rt.store.change_view_access(module_id, name, change),
    };
  });
  lib.loop("View", "AccessRec", (rt: Runtime, view: any) => {
    const { module_id, name } = view_of(rt, view);
    const { entries, inherited } = rt.store.view_access(module_id, name);
    return inherited ? [] : entries;
  });
  for (const type_name of THINGS) {
    lib.add("unsetAll", [type_name], "string", (rt: Runtime, x: any) => {
      const thing = guarded(rt, type_name, x);
      return changing(() => rt.store.unset_access(thing, null));
    });
  }
}

export function register(lib: Library): void {
  register_inner_lists(lib);
  register_permissions(lib);
  register_changes(lib);
  register_records(lib);
}

