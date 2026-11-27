// Check accepts a first assignment to an undeclared name, as DOORS does by
// default, and says which line did it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";
import { Api } from "../src/web/api.ts";

const found = (source: string) => check(source, new Store()).map((w) => [w.line, w.message.split(" ")[0]]);

test("each variable declared by assignment is warned about, once, by line", () => {
  assert.deepEqual(found("int total = 0\ntotl = total + 1\ntotl = 2\n"), [[2, "totl"]]);
  assert.deepEqual(found("a = b = 7\n").map(([, name]) => name).sort(), ["a", "b"]);
  assert.deepEqual(found("for (i = 0; i < 2; i++) {\n  print i \"\"\n}\n"), [[1, "i"]]);
});

test("a declared variable draws no warning, and an error is still an error", () => {
  assert.deepEqual(found("int n\nn = 7\n"), []);
  assert.throws(() => check("x = 1\nprint nothing\n", new Store()), /undeclared or unsupported/);
});

test("the page's Check answers with the warnings beside the errors", () => {
  const api = new Api(new Store()) as any;
  assert.equal(api.op_check({ source: "undeclared = 7;" }).warnings[0].line, 1);
  assert.deepEqual(api.op_check({ source: "int n = 7" }), { error: null, warnings: [] });
});
