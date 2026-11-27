// The engine against cases.json: what each script prints, which error it stops
// with and on what line, which modules it leaves unsaved, and what a layout
// column shows. Each case names the made-up database it starts from.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError, layout, run, VirtualDisk } from "../src/dxl/index.ts";
import { load_project_data } from "../src/io/project.ts";
import { Store } from "../src/store.ts";
import { read_file } from "./helpers.ts";

type Case = {
  name: string;
  project: string;
  source: string;
  layout?: string; // the module path: the script is a column over it
  open_module?: string;
  dry_run?: boolean;
  error?: { line: number; message: string };
  output?: string;
  unsaved?: string[];
  cells?: Record<string, string>;
  files?: Record<string, string>; // in the working folder afterwards
};

const { projects, cases }: { projects: Record<string, unknown>; cases: Case[] } =
  JSON.parse(read_file("test/cases.json"));

describe("recorded DXL cases", () => {
  for (const c of cases) {
    test(c.name, () => {
      const store = new Store(":memory:", "tester");
      load_project_data(store, structuredClone(projects[c.project]));
      const disk = new VirtualDisk();
      let output = "";
      const sink = { write: (s: string) => { output += s; } };
      const deadline = Date.now() + 20000;
      let unsaved: string[] | undefined, cells: Record<string, string> | undefined, error: Case["error"];
      try {
        if (c.layout) {
          cells = Object.fromEntries(layout(c.source, store, store.module_at(c.layout)!, sink, ".", disk, deadline));
        } else {
          unsaved = run(c.source, store, sink, c.open_module ?? null, ".", null, c.dry_run ?? false, false,
            disk, deadline).unsaved;
        }
      } catch (e) {
        if (!(e instanceof DxlError)) throw e;
        error = { line: e.line, message: e.message };
      }
      assert.deepEqual(error, c.error);
      if (c.output !== undefined) assert.equal(output, c.output);
      if (c.unsaved !== undefined) assert.deepEqual(unsaved, c.unsaved);
      if (c.cells !== undefined) assert.deepEqual(cells, c.cells);
      for (const [name, text] of Object.entries(c.files ?? {})) assert.equal(disk.get(`${disk.cwd}/${name}`), text);
    });
  }
});
