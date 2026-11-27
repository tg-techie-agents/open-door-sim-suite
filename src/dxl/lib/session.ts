// dxlHere, oleIsObject, and the locks one user can take and ask about.
//
// A module lock lasts for the run that takes it. Where what DOORS does with a
// locked module is not documented, the script is stopped.

import { RIGHTS } from "../../store.ts";
import type { Library } from "../registry.ts";
import { Fault } from "../runtime.ts";
import type { Runtime } from "../runtime.ts";

// The layout of dxlHere's text is not documented, and scripts that take it apart
// depend on that layout. So only printing it is offered: the compiler puts this
// text in where a print statement shows the value, and nowhere else.
export function here_text(file: string | null, line: number): string {
  return `[dxlHere: ${file ?? "the script itself"}, line ${line}; DOORS words this differently]`;
}

function here_elsewhere(): never {
  throw new Fault("dxlHere: the layout of its text is not documented, so it can only be printed here "
    + "(print dxlHere() \"\\n\"), not stored, compared or taken apart");
}

const locks = (rt: Runtime): Set<number> => {
  let held: Set<number> = rt.state.get("module locks");
  if (!held) rt.state.set("module locks", held = new Set());
  return held;
};

function lockable(rt: Runtime, module_id: any): number {
  rt.need(module_id, "ModName_");
  if (rt.store.is_baseline(module_id)) throw new Fault("locking a baseline is not offered here");
  return module_id;
}

// "" for success, otherwise what stopped it, as DOORS returns a message.
function lock(rt: Runtime, module_id: any): string {
  lockable(rt, module_id);
  if (rt.opened.has(module_id)) throw new Fault("what lock does to a module the script has open is not documented");
  if (locks(rt).has(module_id)) throw new Fault("lock: the module is already locked; what DOORS then does is not documented");
  const answers = [RIGHTS.modify, RIGHTS.create, RIGHTS.delete, RIGHTS.control].map((r) => rt.store.may(module_id, r));
  if (answers.every((a) => a === "no")) return "no access to lock this module";
  if (!answers.every((a) => a === "yes")) {
    throw new Fault("whether lock succeeds with only some of modify, create, delete and control is not verified");
  }
  locks(rt).add(module_id);
  return "";
}

function unlock(rt: Runtime, module_id: any): string {
  lockable(rt, module_id);
  if (rt.opened.has(module_id)) return "the module is open";
  return locks(rt).delete(module_id) ? "" : "you have no exclusive lock on this module";
}

function is_locked(rt: Runtime, module_id: any): boolean {
  lockable(rt, module_id);
  if (locks(rt).has(module_id)) return true;
  const mode = rt.opened.get(module_id);
  if (mode === "edit" || mode === "share") {
    throw new Fault("isLocked of a module the script has open to change is not verified");
  }
  return false;
}

// Section locks exist only in a module opened shareable, and are not offered.
function no_section_lock(rt: Runtime, o: any, call: string): boolean {
  rt.obj(o);
  if (rt.opened.get(o.module_id) === "share") {
    throw new Fault(`${call}: locking sections of a shareable module is not offered here`);
  }
  return false;
}

export function register(lib: Library): void {
  lib.add("dxlHere", [], "string", here_elsewhere);

  // nothing embedded is ever stored here, so no object holds an OLE object
  lib.add("oleIsObject", ["Object"], "bool", (rt: Runtime, o: any) => { rt.obj(o); return false; });

  lib.add("lock", ["ModName_"], "string", lock);
  // the annotation is read back only through lock lists, which are not offered
  lib.add("lock", ["ModName_", "string"], "string", (rt: Runtime, m: any, _note: string) => lock(rt, m));
  lib.add("unlock", ["ModName_"], "string", unlock);
  lib.add("isLocked", ["ModName_"], "bool", is_locked);
  // a locked module cannot be opened here, so locked is also closed
  lib.add("isLockedClosed", ["ModName_"], "bool", (rt: Runtime, m: any) => locks(rt).has(lockable(rt, m)));

  for (const name of ["canLock", "canUnlock"]) {
    lib.add(name, ["Object"], "bool", (rt: Runtime, o: any) => o !== null && no_section_lock(rt, o, name));
  }
  lib.add("isLockedByUser", ["Object"], "bool", (rt: Runtime, o: any) => no_section_lock(rt, o, "isLockedByUser"));
}
