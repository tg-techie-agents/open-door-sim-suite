import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";

test("arithmetic after print says to bracket it", () => {
  assert.throws(() => check("int a = 1\nprint a + 2", new Store()), /bracket the whole expression/);
});
