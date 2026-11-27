import assert from "node:assert/strict";
import { test } from "node:test";
import { dump_project, load_project } from "../src/io/project.ts";
import { Store } from "../src/store.ts";
import { example } from "./helpers.ts";

test("loading a suspect link marks it without adding edit history", () => {
  const loaded = new Store(":memory:", "tester");
  load_project(loaded, dump_project(example()));
  let ends = 0;
  for (const item of loaded.walk()) {
    if (item.kind !== "formal") continue;
    for (const link of loaded.objects(item.id).flatMap((o) => loaded.links(o))) {
      const changed = loaded.suspect(link);
      for (const end of [link.source, link.target].filter((_, i) => changed[i])) {
        ends++;
        assert.deepEqual(loaded.suspect_changes(link, end), []);
      }
    }
  }
  assert.ok(ends > 0);
});
