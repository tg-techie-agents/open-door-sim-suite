// DOORS only marks a deleted link until the script ends or flushDeletions().
// Whatever could show the difference stops the script. All data is made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dxl } from "./helpers.ts";
import { Store } from "../src/store.ts";

const TESTS = "/Kettle/Tests", SYSTEM = "/Kettle/System";

// three tests, each verifying its own requirement; one of them also traces to another
function kettle(): Store {
  const store = new Store(":memory:", "tester");
  dxl(store, `Project p
create("Kettle", "made up", p)
current = folder("/Kettle")
Module reqs = create("System", "made up", "SYS-", 1)
Module checks = create("Tests", "made up", "T-", 1)
Module a = create("verifies", "made up", manyToMany)
Module b = create("traces", "made up", manyToMany)
int i
for i in 1:3 do {
  Object r = create(reqs)
  Object c = create(checks)
  c -> "/Kettle/verifies" -> r
}
object(1, checks) -> "/Kettle/traces" -> object(2, reqs)
save(reqs)
save(checks)`);
  return store;
}

const OPEN = `Module reqs = edit("${SYSTEM}", false)
Module m = edit("${TESTS}", false)
Object o = object(1, m)
Link l
`;
const DELETE_FIRST = OPEN + `for l in o -> "*" do delete(l)
`;
const STOPPED = /only marked in DOORS/;

describe("deleting links across a module keeps working", () => {
  const strip = `for o in m do { for l in o -> "*" do delete(l) }
`;
  const count = `int n = 0
for o in m do { for l in o -> "*" do n++ }
print n "\\n"
`;
  test("outgoing, object by object, then flush, save and read", () => {
    const { printed, result } = dxl(kettle(), OPEN + strip + "flushDeletions()\nsave(m)\n" + count);
    assert.equal(printed, "0\n");
    assert.deepEqual(result.unsaved, []);
  });
  test("incoming, object by object", () => {
    const { printed } = dxl(kettle(), OPEN + `for o in reqs do { for l in o <- "*" do delete(l) }
flushDeletions()
` + count);
    assert.equal(printed, "0\n");
  });
  test("saved before the marked links went, the module is said to be unsaved", () => {
    const { result } = dxl(kettle(), OPEN + strip + "save(m)\n");
    assert.deepEqual(result.unsaved, [TESTS]);
  });
  test("another link module, and the other direction, still answer", () => {
    const { printed } = dxl(kettle(), OPEN + `for l in o -> "/Kettle/verifies" do delete(l)
for l in o -> "/Kettle/traces" do print targetAbsNo(l) "\\n"
for l in o <- "*" do print "none"
`);
    assert.equal(printed, "2\n");
  });
});

describe("what would show a marked link stops", () => {
  const cases: [string, string][] = [
    ["a loop over the same links", `for l in o -> "*" do print "x"`],
    ["a loop over the links arriving", `Object r = object(1, reqs)\nfor l in r <- "*" do print "x"`],
    ["the source modules of the target", `string s\nfor s in object(1, reqs) <- "*" do print s`],
    ["making the same link again", `o -> "/Kettle/verifies" -> object(1, reqs)`],
    ["deleting the target object", `softDelete(object(1, reqs))`],
    ["the module's history", `History h\nfor h in m do print "x"`],
    ["a baseline of the source module", `save(m)\ncreate(m, nextMajor, "made up")`],
    ["closing the source module", `save(m)\nclose(m)`],
  ];
  for (const [what, script] of cases) {
    test(what, () => {
      assert.throws(() => dxl(kettle(), DELETE_FIRST + "noError\n" + script), STOPPED);
    });
    test(`${what}, after flushDeletions(), does not`, () => {
      assert.doesNotThrow(() => dxl(kettle(), DELETE_FIRST + "flushDeletions()\n" + script));
    });
  }
  test("a marked link's handle answers; after the flush it stops", () => {
    const use = `for l in o -> "/Kettle/verifies" do { delete(l)\nprint targetAbsNo(l) "\\n"\n`;
    assert.equal(dxl(kettle(), OPEN + use + "}").printed, "1\n");
    assert.throws(() => dxl(kettle(), OPEN + `for l in o -> "/Kettle/verifies" do delete(l)
flushDeletions()
print targetAbsNo(l) "\\n"`), /has been deleted/);
  });
  test("deleting a link twice", () => {
    assert.throws(() => dxl(kettle(), OPEN + `for l in o -> "/Kettle/verifies" do { delete(l)\ndelete(l) }`), STOPPED);
  });
  test("flushing inside a for loop", () => {
    assert.throws(() => dxl(kettle(), OPEN + `for o in m do {
  for l in o -> "*" do delete(l)
  flushDeletions()
}`), /after the loop/);
  });
});

describe("the record is one run's", () => {
  test("a later run starts clean, even after one that stopped", () => {
    const store = kettle();
    assert.throws(() => dxl(store, DELETE_FIRST + `for l in o -> "*" do print "x"`), STOPPED);
    const { printed } = dxl(store, OPEN + `int n = 0\nfor l in o -> "*" do n++\nprint n "\\n"`);
    assert.equal(printed, "0\n");
  });
});
