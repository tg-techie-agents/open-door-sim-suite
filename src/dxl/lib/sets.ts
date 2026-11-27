// Baseline sets from DXL: definitions, their lock and save cycle, and sets.
//
// A definition handle names a folder and an id. Changes made under a lock are
// kept apart for the length of the run, and reach the store only on save().
// Not offered: setAnnotation (the manual's declaration takes no text), access
// rights on definitions, and the `all` form of the baseline loop.

import { RIGHTS } from "../../store.ts";
import type { BaselineSetRow, SetDefinition } from "../../store.ts";
import type { Library } from "../registry.ts";
import { Fault, limit } from "../runtime.ts";
import type { Ref, Runtime } from "../runtime.ts";
import { attempt } from "./database.ts";
import { date } from "./management.ts";
import { invalid_char } from "./setup.ts";
import { check_source } from "./pending.ts";
import type { SkipList } from "./text.ts";

type Definition = { folder: number; id: number };
type Round = { folder: number; id: number; index: number };
type Draft = { name: string; description: string; modules: number[] };

// the definitions this run holds locked, with their unsaved changes
const locks = new WeakMap<Runtime, Map<string, Draft>>();
const held = (rt: Runtime) => locks.get(rt) ?? locks.set(rt, new Map()).get(rt)!;
const key = (d: Definition) => `${d.folder}:${d.id}`;
const module_of = (rt: Runtime, copy: number): number => rt.store.baseline_of(copy)!.module_id;

const handle = (rt: Runtime, value: any): Definition => rt.need(value, "BaselineSetDefinition");
const saved = (rt: Runtime, d: Definition): SetDefinition => rt.store.set_definition(d.folder, d.id);

// what the script sees: its own unsaved changes while it holds the lock
function seen(rt: Runtime, value: any): Draft {
  const d = handle(rt, value);
  const stored = saved(rt, d);
  return held(rt).get(key(d)) ?? stored;
}

function draft_of(stored: SetDefinition): Draft {
  return { name: stored.name, description: stored.description, modules: [...stored.modules] };
}

// "" or the message DOORS' call would return for want of access
function allowed(rt: Runtime, folder: number, right: number, doing: string): string {
  const answer = rt.store.may(folder, right);
  if (answer === "unknown") {
    throw new Fault(`${doing}: the answer depends on which named groups ${rt.store.user} belongs to`);
  }
  return answer === "yes" ? "" : `no access: ${rt.store.user} may not ${doing}`;
}

// a store refusal that is not about access is a limit of this suite
function changing(run: () => void): string {
  const message = attempt(run);
  if (message === "" || message.startsWith("no access:")) return message;
  throw limit(message);
}

// a change to a locked definition
function edit(rt: Runtime, value: any, change: (draft: Draft) => string): string {
  const d = handle(rt, value);
  saved(rt, d);
  const denied = allowed(rt, d.folder, RIGHTS.modify, "change this baseline set definition");
  if (denied) return denied;
  const draft = held(rt).get(key(d));
  return draft ? change(draft) : "the baseline set definition is not locked";
}

// a definition's name follows the rules for a folder's, and is its folder's own
function name_problem(rt: Runtime, folder: number, id: number, name: string): string {
  if (!name || invalid_char(name) !== "\0") return "that is not a valid name";
  return rt.store.set_definitions(folder).some((o) => o.id !== id && o.name === name)
    ? "there is already a baseline set definition with that name" : "";
}

function register_definitions(lib: Library): void {
  lib.type("BaselineSetDefinition");
  lib.add("create", ["Folder", "string", "string", "&BaselineSetDefinition"], "string",
    (rt: Runtime, folder: any, name: string, description: string, out: Ref) => {
      const at: number = rt.need(folder, "Folder");
      out.set(null);
      const refused = allowed(rt, at, RIGHTS.create, "create a baseline set definition")
        || name_problem(rt, at, 0, name);
      if (refused) return refused;
      return changing(() => out.set({ folder: at, id: rt.store.create_set_definition(at, name, description) }));
    });

  lib.add("name", ["BaselineSetDefinition"], "string", (rt: Runtime, d: any) => seen(rt, d).name);
  lib.add("description", ["BaselineSetDefinition"], "string", (rt: Runtime, d: any) => seen(rt, d).description);
  lib.add("rename", ["BaselineSetDefinition", "string"], "string", (rt: Runtime, d: any, name: string) => {
    return edit(rt, d, (draft) => {
      const clash = name_problem(rt, d.folder, d.id, name);
      if (!clash) draft.name = name;
      return clash;
    });
  });
  lib.add("setDescription", ["BaselineSetDefinition", "string"], "string", (rt: Runtime, d: any, text: string) =>
    edit(rt, d, (draft) => { draft.description = text; return ""; }));
  lib.add("addModule", ["ModName_", "BaselineSetDefinition"], "string", (rt: Runtime, m: any, d: any) => {
    const module: number = rt.need(m, "ModName_");
    return edit(rt, d, (draft) => {
      if (draft.modules.includes(module)) {
        throw new Fault("addModule: the module is already in the definition; what DOORS then returns is not documented");
      }
      draft.modules.push(module);
      return "";
    });
  });
  lib.add("removeModule", ["ModName_", "BaselineSetDefinition"], "string", (rt: Runtime, m: any, d: any) => {
    const module: number = rt.need(m, "ModName_");
    return edit(rt, d, (draft) => {
      if (!draft.modules.includes(module)) {
        throw new Fault("removeModule: the module is not in the definition; what DOORS then returns is not documented");
      }
      draft.modules.splice(draft.modules.indexOf(module), 1);
      return "";
    });
  });

  lib.add("lock", ["BaselineSetDefinition"], "string", (rt: Runtime, value: any) => {
    const d = handle(rt, value);
    const stored = saved(rt, d);
    const denied = allowed(rt, d.folder, RIGHTS.modify, "lock this baseline set definition");
    if (denied) return denied;
    if (held(rt).has(key(d))) {
      throw new Fault("lock: the definition is already locked; what DOORS then does is not documented");
    }
    held(rt).set(key(d), draft_of(stored));
    return "";
  });
  lib.add("unlock", ["BaselineSetDefinition"], "string", (rt: Runtime, value: any) => {
    if (!held(rt).delete(key(handle(rt, value)))) {
      throw new Fault("unlock: the definition is not locked; what DOORS then returns is not documented");
    }
    return "";
  });
  lib.add("save", ["BaselineSetDefinition"], "string", (rt: Runtime, value: any) => {
    const d = handle(rt, value);
    saved(rt, d);
    const draft = held(rt).get(key(d));
    if (!draft) return "the baseline set definition is not locked";
    return name_problem(rt, d.folder, d.id, draft.name)
      || changing(() => rt.store.update_set_definition(d.folder, d.id, draft));
  });
  lib.add("read", ["BaselineSetDefinition"], "string", (rt: Runtime, value: any) => {
    const d = handle(rt, value);
    const stored = saved(rt, d);
    if (held(rt).has(key(d))) held(rt).set(key(d), draft_of(stored));
    return "";
  });
  lib.add("delete", ["&BaselineSetDefinition"], "string", (rt: Runtime, ref: Ref) => {
    const d = handle(rt, ref.get());
    const denied = allowed(rt, d.folder, RIGHTS.delete, "delete this baseline set definition");
    if (denied) return denied;
    const message = changing(() => rt.store.delete_set_definition(d.folder, d.id));
    if (!message) {
      held(rt).delete(key(d));
      ref.set(null);
    }
    return message;
  });
  // a null definition is a run-time error here as in DOORS
  lib.add("isAnyBaselineSetOpen", ["BaselineSetDefinition"], "bool", (rt: Runtime, value: any) =>
    saved(rt, handle(rt, value)).sets.some((s) => s.open));

  lib.loop("Folder", "BaselineSetDefinition", (rt: Runtime, folder: any) => {
    const at: number = rt.need(folder, "Folder");
    return rt.store.set_definitions(at).map((d) => ({ folder: at, id: d.id }));
  });
  lib.loop("ModName_", "BaselineSetDefinition", (rt: Runtime, m: any) => {
    const module: number = rt.need(m, "ModName_");
    return rt.store.all_set_definitions().filter(([, d]) => d.modules.includes(module))
      .map(([folder, d]) => ({ folder, id: d.id }));
  });
  lib.loop("BaselineSetDefinition", "ModName_", (rt: Runtime, d: any) => seen(rt, d).modules);
}

function round(rt: Runtime, value: any): [Round, BaselineSetRow] {
  const r: Round = rt.need(value, "BaselineSet");
  return [r, saved(rt, r).sets[r.index]];
}

// Which list of modules DOORS goes by while the definition has unsaved changes
// is not documented.
function all_saved(rt: Runtime, d: Definition, call: string): void {
  const draft = held(rt).get(key(d));
  if (draft && JSON.stringify(draft) !== JSON.stringify(draft_of(saved(rt, d)))) {
    throw new Fault(`${call}: the definition has unsaved changes, and what DOORS does with them here is not `
      + "documented; save(bsd) first");
  }
}

function register_rounds(lib: Library): void {
  lib.type("BaselineSet");
  lib.loop("BaselineSetDefinition", "BaselineSet", (rt: Runtime, value: any) => {
    const d = handle(rt, value);
    return saved(rt, d).sets.map((_, index) => ({ folder: d.folder, id: d.id, index }));
  });

  // the next three need the definition locked, and return a message when not
  const locked = (rt: Runtime, d: Definition, right: number, doing: string): string =>
    allowed(rt, d.folder, right, doing) || (held(rt).has(key(d)) ? "" : "the baseline set definition is not locked");

  lib.add("create", ["BaselineSetDefinition", "bool", "string", "string", "&BaselineSet"], "string",
    (rt: Runtime, value: any, major: boolean, suffix: string, annotation: string, out: Ref) => {
      const d = handle(rt, value);
      out.set(null);
      const refused = locked(rt, d, RIGHTS.create, "create a baseline set")
        || (saved(rt, d).sets.some((s) => s.open) ? "there is already an open baseline set" : "");
      if (refused) return refused;
      all_saved(rt, d, "create");
      return changing(() => {
        const index = rt.store.create_baseline_set(d.folder, d.id, major, suffix, annotation);
        out.set({ folder: d.folder, id: d.id, index });
      });
    });
  lib.add("close", ["BaselineSet"], "string", (rt: Runtime, value: any) => {
    const [r, row] = round(rt, value);
    return locked(rt, r, RIGHTS.modify, "close this baseline set")
      || (row.open ? changing(() => rt.store.close_baseline_set(r.folder, r.id, r.index))
        : "the baseline set is not open");
  });
  lib.add("addBaselines", ["Skip", "BaselineSet"], "string", (rt: Runtime, list: SkipList, value: any) => {
    const [r, row] = round(rt, value);
    const modules = [...list.live().entries.values()].map(([, data]) => {
      if (data.type !== "ModName_") throw new Fault("addBaselines: the Skip list must hold ModName_ values");
      return data.value as number;
    });
    const refused = locked(rt, r, RIGHTS.modify, "add to this baseline set");
    if (refused) return refused;
    if (!row.open) return "the baseline set is closed";
    const named = saved(rt, r).modules;
    const present = row.members.map((m) => module_of(rt, m));
    if (modules.some((m) => !named.includes(m))) return "a module is not in the baseline set definition";
    if (modules.some((m) => present.includes(m))) return "a module is already in the baseline set";
    all_saved(rt, r, "addBaselines");
    for (const m of modules) check_source(rt, m, "addBaselines");
    if (modules.some((m) => rt.modified.has(m))) {
      throw new Fault("addBaselines: a module has unsaved changes, and whether the baseline takes them is not "
        + "documented; save it first");
    }
    if (modules.some((m) => rt.modified.has(m))) {
      throw new Fault("addBaselines: a module has unsaved changes, which DOORS would leave out; save it first");
    }
    return changing(() => rt.store.add_to_baseline_set(r.folder, r.id, r.index, modules));
  });

  for (const [name, returns, get] of [
    ["major", "int", (s: BaselineSetRow) => s.major], ["minor", "int", (s: BaselineSetRow) => s.minor],
    ["suffix", "string", (s: BaselineSetRow) => s.suffix],
    ["annotation", "string", (s: BaselineSetRow) => s.annotation],
    ["user", "string", (s: BaselineSetRow) => s.user], ["isOpen", "bool", (s: BaselineSetRow) => s.open],
    ["versionID", "string", (s: BaselineSetRow) => `${s.major}.${s.minor}` + (s.suffix ? `(${s.suffix})` : "")],
  ] as Array<[string, string, (s: BaselineSetRow) => any]>) {
    lib.add(name, ["BaselineSet"], returns, (rt: Runtime, v: any) => get(round(rt, v)[1]));
  }
  lib.add("dateOf", ["BaselineSet"], "Date", (rt: Runtime, v: any) => date(rt, round(rt, v)[1].date));

  lib.add("isBaselinePresent", ["BaselineSet", "ModName_"], "bool", (rt: Runtime, v: any, m: any) => {
    const module = rt.need(m, "ModName_");
    return round(rt, v)[1].members.some((copy) => module_of(rt, copy) === module);
  });
  lib.loop("BaselineSet", "ModuleVersion", (rt: Runtime, v: any) => round(rt, v)[1].members);
  // the open sets a module can still be baselined into
  lib.loop("ModName_", "BaselineSet", (rt: Runtime, m: any) => {
    const module: number = rt.need(m, "ModName_");
    return rt.store.all_set_definitions().filter(([, d]) => d.modules.includes(module))
      .flatMap(([folder, d]) => d.sets.flatMap((s, index) =>
        s.open && !s.members.some((copy) => module_of(rt, copy) === module)
          ? [{ folder, id: d.id, index }] : []));
  });
  lib.add("baselineSet", ["ModuleVersion"], "BaselineSet", (rt: Runtime, v: any) =>
    rt.store.baseline_set_of(rt.need(v, "ModuleVersion")));
}

export function register(lib: Library): void {
  register_definitions(lib);
  register_rounds(lib);
}
