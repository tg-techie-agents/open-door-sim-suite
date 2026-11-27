// Shared by the tests: the repository's files, running DXL, and made-up databases.
import { readFileSync } from "node:fs";
import { run, VirtualDisk } from "../src/dxl/index.ts";
import type { RunResult } from "../src/dxl/index.ts";
import { load_project } from "../src/io/project.ts";
import { Store } from "../src/store.ts";

export const read_file = (path: string): string => readFileSync(new URL("../" + path, import.meta.url), "utf8");

export const EXAMPLE = "examples/example-project.json";

export function example(): Store {
  const store = new Store(":memory:", "tester");
  load_project(store, read_file(EXAMPLE));
  return store;
}

export type Ran = { printed: string; result: RunResult; disk: VirtualDisk };

/** Run a script. A script that never ends fails the test after 20 s instead of hanging it. */
export function dxl(store: Store, source: string,
  { dry_run = false, disk = new VirtualDisk() }: { dry_run?: boolean; disk?: VirtualDisk } = {}): Ran {
  let printed = "";
  const result = run(source, store, { write: (s: string) => { printed += s; } }, null, ".", null, dry_run, false,
    disk, Date.now() + 20000);
  return { printed, result, disk };
}

/** The rows of a CSV text, header included. */
export function csv_rows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { rows.push([...row, field]); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

export const REQS = "/Demo/System Requirements";
export const TESTS = "/Demo/Test Cases";

/** A heading over three requirements; TST-1 and TST-2 verify the first two. */
export function demo(): Store {
  const store = new Store(":memory:", "tester");
  store.create_project("/", "Demo");
  const reqs = store.create_module("/Demo", "System Requirements", "Requirements", "SYS-");
  const tests = store.create_module("/Demo", "Test Cases", "Tests", "TST-");
  store.create_link_module("/Demo", "Verifies");
  store.create_attribute(tests, "Test Status");
  const heading = store.create_object(reqs, null, null, null, { "Object Heading": "Kettle" });
  const [boil, off] = ["Shall boil.", "Shall switch off.", "Shall not run dry."]
    .map((text) => store.create_object(reqs, heading, null, null, { "Object Text": text }));
  for (const [requirement, status] of [[boil, "Passed"], [off, "Failed"]] as const) {
    const made = store.create_object(tests, null, null, null, { "Object Text": "Try it.", "Test Status": status });
    store.create_link(made, requirement, "Verifies");
  }
  return store;
}
