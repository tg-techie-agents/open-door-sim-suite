// Drag and drop of an object, as the page asks for it, and its undo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualDisk } from "../src/dxl/files.ts";
import { Api } from "../src/web/api.ts";
import { demo, REQS } from "./helpers.ts";

test("an object dropped before, after, or into another moves, and the answer undoes it", () => {
  const store = demo(), module = store.module_at(REQS)!;
  const api = new Api(store, "t", [], new VirtualDisk());
  const order = () => store.objects(module).map((o) => `${o.absno}<${store.parent_object(o)?.absno ?? 0}`).join(" ");
  const start = order();
  const all = store.objects(module).map((o) => o.absno);
  const [top, a, b, c] = all;
  for (const [absno, target, where] of [[c, a, "before"], [a, c, "after"], [a, b, "child"], [c, top, "before"]] as const) {
    const was = api.op_drag_object({ module, absno, target, where });
    assert.notEqual(order(), start);
    api.op_drag_object({ module, absno, ...was });
    assert.equal(order(), start, `${absno} ${where} ${target}`);
  }
  assert.throws(() => api.op_drag_object({ module, absno: top, target: a, where: "after" }), /inside itself|relative/);
  assert.equal(order(), start);
});
