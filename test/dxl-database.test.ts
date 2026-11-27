// What a script leaves behind in the database, which its printed output cannot show.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError, layout } from "../src/dxl/index.ts";
import { Obj } from "../src/store.ts";
import type { Store } from "../src/store.ts";
import { REQS, TESTS, demo, dxl } from "./helpers.ts";

const OPEN = `Module m = edit("${REQS}", false)\ncurrent = m\n`;

const order = (store: Store) => store.objects(store.module_at(REQS)!).map((o) => o.absno);

describe("scripts that change the database", () => {
  test("each form of create puts the object where it says", () => {
    const store = demo();
    dxl(store, OPEN + `
      Object head = first m
      Object a = create m                    // 5: first in the module
      Object b = create head                 // 6: after head
      Object c = create before head          // 7
      Object d = create below head           // 8: first child
      Object e = create first below head     // 9: first child
      Object f = create last below head      // 10: last child
      Object g = create after object(2)      // 11
    `);
    assert.deepEqual(order(store), [5, 7, 1, 9, 8, 2, 11, 3, 4, 10, 6]);
  });

  test("move", () => {
    const store = demo();
    dxl(store, OPEN + `
      move(object(4), object(2))
      move(object(2), last below object(1))
      move(object(3), below object(1))
      move(object(3), below object(1))
    `);
    assert.deepEqual(order(store), [1, 3, 4, 2]);
  });

  test("attribute writes are made, and reported unsaved until save", () => {
    const store = demo();
    const reqs = store.module_at(REQS)!;
    const { result } = dxl(store, OPEN + `
      Object o = object 2
      o."Object Text" = "Shall boil fast."
      m."Description" = "Updated"
    `);
    assert.deepEqual(result.unsaved, [REQS]);
    assert.equal(store.value(new Obj(reqs, 2), "Object Text"), "Shall boil fast.");
    assert.equal(store.item(reqs).description, "Updated");
    const saved = dxl(store, OPEN + 'object(2)."Object Text" = "x"\nsave m\nprint close(m, false) ""');
    assert.deepEqual(saved.result.unsaved, []);
  });

  test("deleting a link needs its source module open for editing, and changes that module", () => {
    const store = demo();
    const script = (how: string) => `
      Module t = ${how}("${TESTS}", false)
      Module m = read("${REQS}", false)
      Link l
      for l in (first t)->"*" do delete l
    `;
    const requirement = new Obj(store.module_at(REQS)!, 2);
    assert.throws(() => dxl(store, script("read")), /read-only/);
    assert.equal(store.links(requirement, false).length, 1);
    assert.deepEqual(dxl(store, script("edit")).result.unsaved, [TESTS]);
    assert.deepEqual(store.links(requirement, false), []);
  });

  test("a dry run undoes what the script changed", () => {
    const store = demo();
    const before = store.dumps();
    const { printed, result } = dxl(store, OPEN + 'object(2)."Object Text" = "x"\nObject o = create m\nprint "done"',
      { dry_run: true });
    assert.equal(printed, "done");
    assert.equal(result.rolled_back, true);
    assert.equal(store.dumps(), before);
  });

  test("a layout column never changes the database, even when it tries", () => {
    const store = demo();
    const before = store.dumps();
    const script = `Module e = edit "${TESTS}"\nObject t = first e\nt."Object Text" = "changed"\n`;
    assert.throws(() => layout(script, store, store.module_at(REQS)!), /must not change/);
    assert.equal(store.dumps(), before);
  });
});

test("a script that runs past its deadline is stopped, keeping what it printed", () => {
  let printed = "";
  const store = demo();
  assert.throws(
    () => layout('print "start"\nint i = 0\nwhile (true) { i++ }', store, store.module_at(REQS)!,
      { write: (s: string) => { printed += s; } }, ".", null, Date.now() + 100),
    (e: unknown) => e instanceof DxlError && e.line === 3 && /ran past its time limit/.test(e.message));
  assert.equal(printed, "start");
});
