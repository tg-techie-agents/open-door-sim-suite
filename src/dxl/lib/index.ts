// Everything DXL offers here. Each module listed defines register(lib).

import { Library } from "../registry.ts";
import * as core from "./core.ts";
import * as database from "./database.ts";
import * as dialogs from "./dialogs.ts";
import * as filters from "./filters.ts";
import * as layout from "./layout.ts";
import * as management from "./management.ts";
import * as access from "./access.ts";
import * as schema from "./schema.ts";
import * as setup from "./setup.ts";
import * as text from "./text.ts";
import * as views from "./views.ts";

const _built = new Map<boolean, Library>();

/** `for_layout` adds what only layout DXL can call. */
export function build_library(for_layout: boolean = false): Library {
  let lib = _built.get(for_layout);
  if (lib) return lib;
  lib = new Library();
  // listed here, not at the top level: the modules import one another
  const MODULES = [core, text, database, management, schema, access, setup, filters, views, dialogs];
  for (const module of for_layout ? [...MODULES, layout] : MODULES) module.register(lib);
  for (const handle of [...lib.handles].sort()) {
    lib.add("null", [handle], "bool", (_rt, value) => value === null || value === undefined);
  }
  _built.set(for_layout, lib);
  return lib;
}
