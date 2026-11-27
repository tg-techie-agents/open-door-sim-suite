import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { dxl } from "./helpers.ts";

test("a script cannot make a name DOORS would refuse", () => {
  const bad = new Store(":memory:", "tester");
  assert.throws(() => dxl(bad, 'Folder f = create("pumps: old", "")'), /does not allow/);
  const good = new Store(":memory:", "tester");
  dxl(good, 'Folder f = create("pumps-old_2.1 spares", "")');
  assert.ok(good.find("pumps-old_2.1 spares"));
});
