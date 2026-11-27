// Access rights from DXL. The store keeps and enforces them.
//
// A Permission is the store's bits, already closed over what each right brings.
// An AccessRec is one entry of a thing's own list; the name is null for the
// entry that covers everyone else. Not offered: access to views, attribute
// definitions and types, groups, partitions and the rights create propagates.

import { RIGHTS, closed_rights } from "../../store.ts";
import type { AccessEntry } from "../../store.ts";
import type { Library } from "../registry.ts";
import { Fault } from "../runtime.ts";
import type { Ref, Runtime } from "../runtime.ts";
import { attempt, handle } from "./database.ts";

const THINGS = ["Object", "Module", "Folder", "Project", "Item"];
const WRITE = RIGHTS.modify | RIGHTS.create | RIGHTS.delete;

// A call DOORS fails for want of control access returns a message. Anything
// else the store refuses is a limit of this suite, and stops the script.
function changing(run: () => void): string {
  const message = attempt(run);
  if (message === "" || message.startsWith("no access:")) return message;
  throw new Fault(message);
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
  lib.add("username", ["AccessRec"], "string", (rt: Runtime, a: any) => {
    const name = need(rt, a).name;
    if (name === null) {
      throw new Fault("username of the entry for everyone else is not documented; test isDefault(ar) first");
    }
    return name;
  });
  lib.add("isDefault", ["AccessRec"], "bool", (rt: Runtime, a: any) => need(rt, a).name === null);
  for (const [call, right] of [["read", "read"], ["create", "create"], ["modify", "modify"], ["delete", "delete"],
    ["control", "control"], ["write", "modify"], ["change", "control"]] as const) {
    lib.add(call, ["AccessRec"], "bool", (rt: Runtime, a: any) => (need(rt, a).rights & RIGHTS[right]) !== 0);
  }
}

export function register(lib: Library): void {
  register_permissions(lib);
  register_changes(lib);
  register_records(lib);
}

