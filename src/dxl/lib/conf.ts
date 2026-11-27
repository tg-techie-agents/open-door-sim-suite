// The configuration area: files kept inside the database, one set for everyone
// (confSystem), one per user (confUser), and the unnamed default.
//
// Which named area the default is, is not documented, so a name may be used
// without an area or with one, but not both ways. Not offered: confProjUser,
// uploading and downloading, and the stream operations beyond text lines.

import type { Library } from "../registry.ts";
import { Fault } from "../runtime.ts";
import type { Ref, Runtime } from "../runtime.ts";
import { attempt } from "./database.ts";
import { Stream } from "./text.ts";

type Area = "default" | "system" | "user";
type Entry = { key: string; name: string; area: Area };

function prefix(rt: Runtime, area: Area): string {
  return area === "user" ? `user:${rt.store.user}/` : `${area}:/`;
}

function entry(rt: Runtime, call: string, name: string, area: Area): Entry {
  const parts = name.split("/");
  if (name.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Fault(`${call}: only a plain relative name, with / between folders, is supported here`);
  }
  const others: Area[] = area === "default" ? ["system", "user"] : ["default"];
  if (others.some((o) => rt.store.conf_entry(prefix(rt, o) + name) !== undefined)) {
    throw new Fault(`${call}: ${name} is used both with and without an area, and which area is the default `
      + "is not documented");
  }
  const parent = parts.slice(0, -1).join("/");
  if (parent && rt.store.conf_entry(prefix(rt, area) + parent) !== null) {
    throw new Fault(`${call}: there is no folder ${parent}; make it with confMkdir first`);
  }
  return { key: prefix(rt, area) + name, name, area };
}

// the text of a file that must be there
function file(rt: Runtime, call: string, at: Entry): string {
  const text = rt.store.conf_entry(at.key);
  if (typeof text !== "string") {
    throw new Fault(`${call}: there is no file ${at.name} there, and what DOORS then does is not documented`);
  }
  return text;
}

function vacant(rt: Runtime, call: string, at: Entry): void {
  if (rt.store.conf_entry(at.key) !== undefined) {
    throw new Fault(`${call}: ${at.name} already exists, and what DOORS then does is not documented`);
  }
}

// what a Stream needs of the disk it is on
function disk(rt: Runtime) {
  const store = rt.store;
  const text = (key: string) => store.conf_entry(key) as string;
  return {
    readText: text,
    exists: (key: string) => typeof store.conf_entry(key) === "string",
    writeText: (key: string, value: string) => store.set_conf_entry(key, value),
    appendText: (key: string, value: string) => store.set_conf_entry(key, text(key) + value),
  };
}

function opened(rt: Runtime, call: string, name: string, area: Area, mode: "r" | "w" | "a"): Stream {
  const at = entry(rt, call, name, area);
  if (mode !== "w") file(rt, call, at);
  else if (rt.store.conf_entry(at.key) === null) throw new Fault(`${call}: ${name} is a folder`);
  const stream = new Stream(disk(rt), at.key, mode);
  rt.closers.push(() => stream.file.close());
  return stream;
}

function stream(rt: Runtime, value: any, reading: boolean | null = null): Stream {
  const s: Stream = rt.need(value, "ConfStream");
  if (s.file.closed) throw new Fault("the ConfStream is not open");
  if (reading !== null && s.reading !== reading) {
    throw new Fault("the ConfStream is not open for " + (reading ? "reading" : "writing"));
  }
  return s;
}

// register `name(strings...)` both with and without a trailing area
function with_area(lib: Library, name: string, strings: number, returns: string,
                   impl: (rt: Runtime, area: Area, ...given: string[]) => any): void {
  const params = Array(strings).fill("string");
  lib.add(name, params, returns, (rt: Runtime, ...given: string[]) => impl(rt, "default", ...given));
  lib.add(name, [...params, "ConfType"], returns,
    (rt: Runtime, ...given: any[]) => impl(rt, given.pop() as Area, ...given));
}

export function register(lib: Library): void {
  lib.type("ConfType");
  lib.type("ConfStream");
  lib.add("confSystem", [], "ConfType", () => "system");
  lib.add("confUser", [], "ConfType", () => "user");

  for (const [name, mode] of [["confRead", "r"], ["confWrite", "w"], ["confAppend", "a"]] as const) {
    with_area(lib, name, 1, "ConfStream", (rt, area, path) => opened(rt, name, path, area, mode));
  }
  lib.add("close", ["ConfStream"], "void", (rt: Runtime, s: any) => stream(rt, s).file.close());
  lib.add("end", ["ConfStream"], "bool", (rt: Runtime, s: any) => stream(rt, s, true).eof);
  lib.operator("<<", "ConfStream", "string", "ConfStream", (rt: Runtime, s: any, text: string) => {
    stream(rt, s, false).file.write(text);
    return s;
  });
  lib.operator(">>", "ConfStream", "string", "ConfStream", (rt: Runtime, s: any, out: Ref) => {
    out.set(stream(rt, s, true).line());
    return s;
  });

  with_area(lib, "confFileExists", 1, "bool", (rt, area, path) => {
    const found = rt.store.conf_entry(entry(rt, "confFileExists", path, area).key);
    if (found === null) throw new Fault("confFileExists of a folder is not documented");
    return found !== undefined;
  });
  with_area(lib, "confMkdir", 1, "void", (rt, area, path) => {
    const at = entry(rt, "confMkdir", path, area);
    vacant(rt, "confMkdir", at);
    rt.store.set_conf_entry(at.key, null);
  });
  with_area(lib, "confDeleteFile", 1, "string", (rt, area, path) => {
    const at = entry(rt, "confDeleteFile", path, area);
    if (typeof rt.store.conf_entry(at.key) !== "string") return `there is no file ${path}`;
    return attempt(() => rt.store.delete_conf_entry(at.key));
  });
  for (const [name, keep] of [["confRenameFile", false], ["confCopyFile", true]] as const) {
    const run = (rt: Runtime, area: Area, from: string, to: string): string => {
      const source = entry(rt, name, from, area), target = entry(rt, name, to, area);
      if (typeof rt.store.conf_entry(source.key) !== "string") return `there is no file ${from}`;
      vacant(rt, name, target);
      return attempt(() => rt.store.transaction(() => {
        rt.store.set_conf_entry(target.key, rt.store.conf_entry(source.key) as string);
        if (!keep) rt.store.delete_conf_entry(source.key);
      }));
    };
    // the manual gives confCopyFile only with its area
    if (keep) {
      lib.add(name, ["string", "string", "ConfType"], "string",
        (rt: Runtime, from: string, to: string, area: Area) => run(rt, area, from, to));
    } else with_area(lib, name, 2, "string", run);
  }
  lib.add("confDeleteDirectory", ["string", "ConfType"], "string", (rt: Runtime, path: string, area: Area) => {
    const at = entry(rt, "confDeleteDirectory", path, area);
    if (rt.store.conf_entry(at.key) !== null) return `there is no folder ${path}`;
    if (rt.store.conf_below(at.key)) {
      throw new Fault("confDeleteDirectory of a folder that is not empty is not documented");
    }
    return attempt(() => rt.store.delete_conf_entry(at.key));
  });
}
