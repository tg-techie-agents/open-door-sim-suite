// Persistent triggers from DXL: defining, deleting, inspecting, and what a
// running trigger can ask. The store holds them and decides when they fire.
//
// Offered: module open, object sync, and attribute save, pre and post. Not
// offered: dynamic and drag-and-drop triggers, project level, and the events
// nothing at this interface does as DOORS does (module close, object open).
// A Trigger handle names the item holding it and the trigger itself.

import { Obj, ROOT, Store, StoreError } from "../../store.ts";
import type { Trigger, TriggerContext, TriggerRow } from "../../store.ts";
import type { Library } from "../registry.ts";
import { Fault, limit } from "../runtime.ts";
import type { Ref, Runtime } from "../runtime.ts";
import { find, project_of } from "./database.ts";

// What `module->"URD"->attribute->"Cost"` builds: one part per level word
type Part = { level: string; name?: string; all?: boolean; kind?: string };
type Level = { parts: Part[] };
type Event = { word: string };
// the state of the trigger whose DXL is running
export type Running = { trigger: Trigger; context: TriggerContext; status: string | null };
export const RUNNING = "trigger";

const LEVELS = ["project", "module", "object", "attribute"];
const MODIFIERS = ["all", "formal", "link", "descriptive"];
const EVENTS = ["open", "read", "close", "save", "modify", "write", "sync", "drag", "drop"];
const STATUSES = ["trigPreConPass", "trigPreConFail", "trigRunOK", "trigError"];
// the word the manual's table of events gives each; others are synonyms
const PLAIN = ["open", "close", "save", "sync", "drag", "drop"];

function refine(level: Level, change: Partial<Part>): Level {
  const last = level.parts[level.parts.length - 1];
  if (last.name !== undefined || last.kind !== undefined || (last.all && change.kind === undefined)) {
    throw new Fault("that trigger level description is not supported here");
  }
  return { parts: [...level.parts.slice(0, -1), { ...last, ...change }] };
}

// where a description says a trigger is held, and what of it it watches
function resolve(rt: Runtime, level: Level): { at: number; level: TriggerRow["level"]; formal?: boolean;
  attribute?: string; absno?: number } {
  const parts = [...level.parts];
  const take = (word: string): Part | null => parts[0]?.level === word ? parts.shift()! : null;
  const project = take("project"), module = take("module");
  const last = parts.length ? parts.shift()! : null;
  if (parts.length || (last && last.level !== "object" && last.level !== "attribute")) {
    throw new Fault("that trigger level description is not supported here");
  }
  if (last?.kind !== undefined || project?.kind !== undefined) {
    throw new Fault("that trigger level description is not supported here");
  }
  if (project && !module) throw new Fault("project level triggers are not supported");
  const kind = module?.kind;
  if (kind !== undefined && kind !== "formal") {
    throw new Fault(`triggers on ${kind} modules are not offered here`);
  }

  let holder: number | null = null; // the project a description names
  if (project) {
    if (project.all) holder = ROOT;
    else if (project.name !== undefined) {
      holder = find(rt, project.name, ["project"]);
      if (holder === null) throw new Fault(`no project ${project.name}`);
    }
  }
  const current_project = (): number => {
    const found = project_of(rt, rt.folder);
    if (found === null) throw new Fault("this trigger level needs a current project, and there is none");
    return found;
  };

  let at: number;
  const generic = Boolean(module && (module.all || kind === "formal"));
  if (generic) {
    if (module!.name !== undefined) throw new Fault("that trigger level description is not supported here");
    at = holder ?? current_project();
  } else {
    if (holder === ROOT) throw new Fault("that trigger level description is not supported here");
    if (module?.name !== undefined) {
      const base = holder ?? (project ? current_project() : null);
      const found = base === null ? find(rt, module.name, ["formal"]) : rt.store.find(module.name, base) ?? null;
      if (found === null || rt.store.item(found).kind !== "formal") throw new Fault(`no formal module ${module.name}`);
      at = found;
    } else {
      if (project) throw new Fault("that trigger level description is not supported here");
      at = rt.need(rt.module, "current Module");
      if (rt.store.item(at).kind !== "formal") throw new Fault("triggers on link modules are not offered here");
    }
  }

  const out: ReturnType<typeof resolve> = { at, level: (last?.level ?? "module") as TriggerRow["level"] };
  if (kind === "formal") out.formal = true;
  if (last?.name !== undefined) {
    if (last.level === "attribute") {
      if (!generic && !rt.store.attribute(at, last.name)) throw new Fault(`no attribute ${last.name}`);
      out.attribute = last.name;
    } else {
      if (generic || !/^[1-9]\d*$/.test(last.name)) {
        throw new Fault("an object trigger names one object by its absolute number, in one module");
      }
      out.absno = Number(last.name);
    }
  }
  return out;
}

// the event kept, or a refusal naming why nothing here would ever fire it
function event_for(level: string, event: Event): TriggerRow["event"] {
  const word = event.word;
  if (level === "module") {
    if (word === "open" || word === "read") return "open";
    if (word === "close") {
      throw new Fault("module close triggers are not offered here: nothing here closes a module as DOORS does");
    }
  } else if (level === "object") {
    if (word === "sync") return "sync";
    if (word === "open" || word === "read") {
      throw new Fault("object open triggers are not offered here: DOORS fires them on a double-click, which "
        + "edits here");
    }
    if (word === "drag" || word === "drop") throw new Fault("drag-and-drop triggers are not offered here");
  } else if (word === "save" || word === "modify" || word === "write") {
    return "save";
  }
  throw new Fault(`the ${level} level does not have the ${word} event: this combination is not supported`);
}

const live = (rt: Runtime, value: any): Trigger => {
  const t: Trigger = rt.need(value, "Trigger");
  if (!rt.store.has_item(t.at) || !rt.store.own_triggers(t.at).some((o: Trigger) => o.row === t.row)) {
    throw new Fault("that trigger has been deleted");
  }
  return t;
};

function running(rt: Runtime, call: string): Running {
  const found = rt.state.get(RUNNING);
  if (!found) throw new Fault(`${call}: not supported here outside a running trigger`);
  return found;
}

// what only the trigger now running can be asked
function firing(rt: Runtime, value: any, call: string): Running {
  const t = live(rt, value);
  const now = running(rt, call);
  if (now.trigger.row !== t.row) throw new Fault(`${call}: not supported here for a trigger that is not running`);
  return now;
}

function changing(run: () => void): void {
  try {
    run();
  } catch (e) {
    if (e instanceof StoreError) throw limit(e.message);
    throw e;
  }
}

function register_words(lib: Library): void {
  for (const type_name of ["TriggerLevel_", "TriggerType_", "TriggerEvent_", "TriggerStatus", "Trigger"]) {
    lib.type(type_name);
  }
  lib.type("TriggerMod_");
  for (const word of LEVELS) lib.add(word, [], "TriggerLevel_", () => ({ parts: [{ level: word }] }));
  for (const word of MODIFIERS) lib.add(word, [], "TriggerMod_", () => word);
  for (const word of ["pre", "post"]) lib.add(word, [], "TriggerType_", () => word);
  for (const word of EVENTS) lib.add(word, [], "TriggerEvent_", () => ({ word }));
  for (const word of STATUSES) lib.add(word, [], "TriggerStatus", () => word);

  lib.operator("->", "TriggerLevel_", "TriggerLevel_", "TriggerLevel_",
    (_rt: Runtime, a: Level, b: Level) => ({ parts: [...a.parts, ...b.parts] }));
  lib.operator("->", "TriggerLevel_", "string", "TriggerLevel_",
    (_rt: Runtime, a: Level, name: string) => refine(a, { name }));
  lib.operator("->", "TriggerLevel_", "TriggerMod_", "TriggerLevel_",
    (_rt: Runtime, a: Level, word: string) => refine(a, word === "all" ? { all: true } : { kind: word }));

  const one = (level: Level): string => {
    const [part, ...rest] = level.parts;
    if (rest.length || part.name !== undefined || part.all || part.kind !== undefined) {
      throw new Fault("a compound trigger level here has no one name");
    }
    return part.level;
  };
  const synonymless = (event: Event): string => {
    if (!PLAIN.includes(event.word)) {
      throw new Fault(`which synonym DOORS answers with for the event written ${event.word} is not documented`);
    }
    return event.word;
  };
  lib.add("stringOf", ["TriggerLevel_"], "string", (_rt: Runtime, level: Level) => one(level));
  lib.add("stringOf", ["TriggerType_"], "string", (_rt: Runtime, word: string) => word);
  lib.add("stringOf", ["TriggerEvent_"], "string", (_rt: Runtime, event: Event) => event.word);
  for (const [op, wanted] of [["==", true], ["!=", false]] as const) {
    lib.operator(op, "TriggerLevel_", "TriggerLevel_", "bool",
      (_rt: Runtime, a: Level, b: Level) => (one(a) === one(b)) === wanted);
    lib.operator(op, "TriggerType_", "TriggerType_", "bool",
      (_rt: Runtime, a: string, b: string) => (a === b) === wanted);
    lib.operator(op, "TriggerEvent_", "TriggerEvent_", "bool",
      (_rt: Runtime, a: Event, b: Event) => (synonymless(a) === synonymless(b)) === wanted);
  }
}

function register_changes(lib: Library): void {
  lib.add("trigger", ["string", "TriggerLevel_", "TriggerType_", "TriggerEvent_", "int", "string"], "Trigger",
    (rt: Runtime, name: string, level: Level, when: "pre" | "post", event: Event, priority: number,
      dxl: string): Trigger | null => {
      if (!name) throw new Fault("a trigger without a name is not supported here");
      const { at, ...where } = resolve(rt, level);
      const row: TriggerRow = { name, ...where, when, event: event_for(where.level, event), word: event.word,
        priority, dxl };
      Store.trigger_engine!.check(rt.store, dxl);
      try {
        rt.store.add_trigger(at, row);
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        if (e.message.startsWith("no access:")) return null; // the manual: the function returns null
        throw limit(e.message);
      }
      return rt.store.own_triggers(at).at(-1)!;
    });

  const remove = (rt: Runtime, t: Trigger): string => {
    try {
      rt.store.delete_trigger(t.at, t.row);
    } catch (e) {
      if (e instanceof StoreError && e.message.startsWith("no access:")) return e.message;
      if (e instanceof StoreError) throw limit(e.message);
      throw e;
    }
    return "";
  };
  lib.add("delete", ["string", "TriggerLevel_", "TriggerType_", "TriggerEvent_", "int"], "string",
    (rt: Runtime, name: string, level: Level, when: string, event: Event, priority: number) => {
      const where = resolve(rt, level), kept = event_for(where.level, event);
      const found: Trigger | undefined = rt.store.own_triggers(where.at).find(({ row }: Trigger) =>
        row.name === name && row.level === where.level && row.when === when && row.event === kept
        && row.priority === priority && row.attribute === where.attribute && row.absno === where.absno);
      return found ? remove(rt, found) : "there is no such trigger";
    });
  lib.add("delete", ["&Trigger"], "string", (rt: Runtime, ref: Ref) => {
    const message = remove(rt, live(rt, ref.get()));
    if (!message) ref.set(null);
    return message;
  });
}

function register_questions(lib: Library): void {
  const of = (name: string, returns: string, get: (row: TriggerRow) => any) =>
    lib.add(name, ["Trigger"], returns, (rt: Runtime, t: any) => get(live(rt, t).row));
  of("name", "string", (row) => row.name);
  of("priority", "int", (row) => row.priority);
  of("dxl", "string", (row) => row.dxl);
  of("kind", "string", () => "stored");
  of("level", "TriggerLevel_", (row) => ({ parts: [{ level: row.level }] }));
  of("type", "TriggerType_", (row) => row.when);
  of("event", "TriggerEvent_", (row) => {
    if (row.word !== row.event) {
      throw new Fault(`which synonym DOORS answers with for a trigger written with ${row.word} is not documented`);
    }
    return { word: row.event };
  });
  of("attribute", "string", (row) => row.attribute ?? "");
  of("levelModifier", "string", (row) => {
    if (!row.formal) throw new Fault("levelModifier: what DOORS answers where no module kind was written is "
      + "not documented");
    return "F";
  });

  lib.add("current", [], "Trigger", (rt: Runtime) => running(rt, "current").trigger);
  lib.add("value", ["Trigger"], "string", (rt: Runtime, t: any) => {
    const { context } = firing(rt, t, "value");
    if (context.value === null) throw new Fault("value: only an attribute trigger here has a value");
    return context.value;
  });
  lib.add("module", ["Trigger"], "Module", (rt: Runtime, t: any) => {
    const now = firing(rt, t, "module");
    if (now.trigger.row.level === "module" && now.trigger.row.when === "pre") {
      throw new Fault("module: what a pre-open trigger is given here is not documented");
    }
    return now.context.module;
  });
  lib.add("object", ["Trigger"], "Object", (rt: Runtime, t: any) => {
    const { context } = firing(rt, t, "object");
    if (context.absno === null) throw new Fault("object: a module trigger has no object here");
    return new Obj(context.module, context.absno);
  });
  lib.add("set", ["TriggerStatus"], "void", (rt: Runtime, status: string) => {
    const now = running(rt, "set");
    if (now.trigger.row.when !== "pre") throw new Fault("set: a trigger status is only supported here in a pre trigger");
    now.status = status;
  });

  lib.loop("Database_", "Trigger", (rt: Runtime) => rt.store.own_triggers(ROOT));
  lib.loop("Module", "Trigger", (rt: Runtime, m: any) => rt.store.own_triggers(rt.opened_module(m)));
  lib.loop("Project", "Trigger", (rt: Runtime, p: any) => {
    const project: number = rt.need(project_of(rt, p), "Project");
    return rt.store.trigger_holders().filter((at: number) => {
      const kind = rt.store.item(at).kind;
      if (at === ROOT || ((kind === "formal" || kind === "link") && !rt.opened.has(at))) return false;
      for (let up: number | null = at; up !== null; up = rt.store.item(up).parent) if (up === project) return true;
      return false;
    }).flatMap((at: number) => rt.store.own_triggers(at));
  });
}

export function register(lib: Library): void {
  register_words(lib);
  register_changes(lib);
  register_questions(lib);
}
