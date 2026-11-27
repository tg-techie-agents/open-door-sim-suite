// Columns, saved views, display state, access predicates, and the history and
// system properties that go with traceability reports.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check, run, VirtualDisk } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";
import { REQS, TESTS, demo, dxl } from "./helpers.ts";

const open = `Module m = edit("${REQS}", true)\ncurrent = m\n`;
const printed = (store: Store, source: string) => dxl(store, open + source).printed;
const stops = (store: Store, source: string, reason: RegExp) =>
  assert.throws(() => dxl(store, open + source), (e: any) => reason.test(e.message));
const module_id = (store: Store, path = REQS) => store.module_at(path)!;

// Delete the standard columns and build ID, main, and one attribute column.
const build = `
Column c
int n = 0
for c in m do n++
int i
for i in 1:n do delete(column 0)
c = insert(column 0)
title(c, "ID")
width(c, 60)
dxl(c, "display identifier(obj)")
c = insert(column 1)
main(c)
width(c, 400)
c = insert(column 2)
attribute(c, "Object Text")
title(c, "Text")
width(c, 150)
justify(c, right)
`;

describe("columns", () => {
  test("the Standard view is the ID column and the main column", () => {
    assert.equal(printed(demo(), `
Column c
for c in m do {
    if (main c) print "main\\n"
    else print title(c) " " justify(c) "\\n"
}
print currentView(m) "\\n"`), "ID left\nmain\nStandard view\n");
  });

  test("a built view gives its titles, attributes, code, and text", () => {
    assert.equal(printed(demo(), build + `
Object o = first m
o = next o
for c in m do {
    if (main c) print "[main:" text(c, o) "]"
    else print "[" title(c) ":" text(c, o) "]"
}
print "\\n" attrName(column 2) " " width(column 2) " " justify(column 2) "\\n"
print dxl(column 0) " [" dxl(column 2) "]\\n"
if (justify(column 2) == right) print "right\\n"`),
      "[ID:SYS-2][main:][Text:Shall boil.]\nObject Text 150 right\ndisplay identifier(obj) []\nright\n");
  });

  test("what DOORS does not document stops the script", () => {
    stops(demo(), `print title(column 1)`, /title\(\) gives for the main column/);
    stops(demo(), `print attrName(column 0)`, /ID column/);
    stops(demo(), `Column c = column 1\ninsert(column 0)\nprint main(c)`, /columns have moved/);
    stops(demo(), `Column c = column 5`, /no column 5/);
    stops(demo(), `print title(column 2)`, /no column 2/);
    stops(demo(), `Column c = insert(column 2)\nprint width(c)`, /no width/);
    stops(demo(), `Column c = insert(column 2)\nattribute(c, "Nonsense")`, /no object attribute/);
    stops(demo(), `Column c = insert(column 2)\ndxl(c, "display nonsense")`, /column's DXL/);
    stops(demo(), `Column c = insert(column 2)\njustify(c, centre)\nprint justify(c) ""`, /center" or "centre/);
  });

  test("a column handle stays good while its column stays put", () => {
    assert.equal(printed(demo(), `Column c = column 0\ninsert(column 2)\nprint title(c)`), "ID");
  });

  test("column functions are refused inside layout DXL", () => {
    stops(demo(), `Column c = insert(column 2)\ndxl(c, "display title(column 0)")\nprint text(c, first m)`,
      /inside layout DXL/);
  });
});

describe("saved views", () => {
  test("a view saved by a script is the interface's, and loads again", () => {
    const store = demo();
    assert.equal(printed(store, build + `
save view "Trace"
print currentView(m) "\\n"
load view "Standard view"
string v
for v in views m do print v "\\n"
print load(view "Nothing") "\\n"
print load(view "Trace") " " attrName(column 2) " " title(column 2) " " width(column 0) "\\n"`),
      "Trace\nTrace\nfalse\ntrue Object Text Text 60\n");
    const saved = store.views(module_id(store)).get("Trace");
    assert.deepEqual(saved.layout.map((c: any) => c.kind), ["dxl", "main", "attribute"]);
    assert.equal(saved.in_links, false);
  });

  test("a view saved by the interface loads with its columns, filter, and sort", () => {
    const store = demo();
    store.save_view(module_id(store, TESTS), "Failed", {
      columns: ["ID", "Test Status"], filter: { attribute: "Test Status", op: "==", value: "failed" }, sort: null,
    });
    assert.equal(dxl(store, `
Module t = read("${TESTS}", false)
print load(t, view("Failed")) "\\n"
`.replace('view("Failed")', 'view(item "' + TESTS + '", "Failed")') + `
print filtering(t) " " currentView(t) "\\n"
Object o
Column c
for o in t do for c in t do if (!main c) print title(c) "=" text(c, o) "\\n"`).printed,
      "true\ntrue Failed\nID=TST-2\nTest Status=Failed\n");
  });

  test("loading over a filter the view does not set stops", () => {
    stops(demo(), `set(attribute "Object Text" == "x")\nfiltering on\nload view "Standard view"`, /filtering off/);
  });

  test("saving needs a displayed module, a new name, sized columns, and no filter", () => {
    stops(demo(), `save view "Standard view"`, /cannot be altered/);
    stops(demo(), `insert(column 2)\nsave view "X"`, /no width/);
    stops(demo(), `filtering on\nsave view "X"`, /filtering and sorting off/);
    assert.throws(() => dxl(demo(), `Module m = read("${REQS}", false)\ncurrent = m\nsave view "X"`),
      /only be saved while its module is displayed/);
  });

  test("delete returns a message when it cannot", () => {
    const store = demo();
    assert.equal(printed(store, `
save view "A"
print "[" delete(view "A") "]\\n"
print null(delete(view "A")) " " null(delete(view "Standard view")) "\\n"`), "[]\nfalse false\n");
    assert.equal(store.views(module_id(store)).size, 0);
  });

  test("a dry run saves no view", () => {
    const store = demo();
    dxl(store, open + `save view "A"`, { dry_run: true });
    assert.equal(store.views(module_id(store)).size, 0);
  });

  test("a script run from a window with a view loaded starts in it", () => {
    const store = demo();
    dxl(store, open + build + `save view "Trace"`);
    let out = "";
    run(`print currentView(current Module) " " title(column 2)`, store, { write: (s: string) => { out += s; } },
      REQS, ".", null, false, false, new VirtualDisk(), null, [], "Trace");
    assert.equal(out, "Trace Text");
  });
});

describe("display state and access", () => {
  test("one local user may read and change what the database allows", () => {
    assert.equal(printed(demo(), `
refresh m
Object o = first m
print isVisible(m) canRead(m) canModify(m) canWrite(m) canRead(o) canModify(o) isVisible(o) "\\n"
print canModify(m, "Object Text") canRead(o."Created By") canWrite(o."Object Text") "\\n"
print canRead(module "${REQS}", view "Standard view") canModify(module "${REQS}", view "Standard view") "\\n"
print graphics(m) outlining(m) showDeletedObjects() "\\n"`),
      "truetruetruetruetruetruetrue\ntruetruetrue\ntruefalse\nfalsefalsefalse\n");
  });

  test("isVisible follows the filter, and a hidden module is not visible", () => {
    assert.equal(printed(demo(), `
Object o = first m
ancestors false
set(attribute "Object Text" == "Shall boil.")
filtering on
print isVisible(o) "\\n"
Module t = read("${TESTS}", false)
print isVisible(t) "\\n"`), "false\nfalse\n");
  });

  test("answers that are not known stop", () => {
    assert.throws(() => dxl(demo(), `Module m = read("${REQS}")\ncurrent = m\nprint canModify(first m)`),
      /needs the module open with edit/);
    stops(demo(), `print canModify(m, "Created On")`, /not verified/);
    stops(demo(), `print canRead(m, "Nonsense")`, /no attribute/);
    stops(demo(), `showDeletedObjects true`, /not supported/);
  });
});

describe("history and system attributes", () => {
  test("link records give both ends, and a move says how many objects", () => {
    assert.equal(printed(demo(), `
Module t = edit("${TESTS}", true)
History h
for h in t do if (h.type == createLink) print h.sourceAbsNo ">" h.targetAbsNo " "
Object a = object(2, m)
move(a, object(4, m))
for h in object(2, m) do if (h.type == clipMoveObject) print h.numberOfObjects`), "1>2 2>3 1");
  });

  test("properties a record does not carry stop", () => {
    for (const name of ["sourceAbsNo", "targetAbsNo", "numberOfObjects"]) {
      stops(demo(), `History h\nfor h in m do { print h.${name}\nbreak }`, /only available here/);
    }
  });

  test("history survives saving the database", () => {
    const store = Store.loads(demo().dumps());
    assert.equal(dxl(store, `Module t = read("${TESTS}")\nHistory h
for h in t do if (h.type == createLink) print h.targetAbsNo ""`).printed, "23");
  });

  test("Created Thru and Last Modified are readable on objects, links, and modules", () => {
    const store = demo();
    store.dated("2030-01-02 03:04:05", () => {
      store.create_object(module_id(store), null, null, null, { "Object Text": "Later." });
    });
    assert.equal(dxl(store, `
Module reqs = read("${REQS}")
Module checks = read("${TESTS}")
AttrDef made = find(reqs, "Created Thru")
print made.typeName "/" made.defval "\\n"
print reqs."Last Modified On" " by " reqs."Last Modified By" "\\n"
Object item = first checks
Link edge
for edge in item->"*" do print edge."Last Modified By" "\\n"
print item."Created Thru" ""`).printed,
      "Created Thru/Manual Input\n2030-01-02 03:04:05 by tester\ntester\nManual Input");
  });

  test("a link someone has cleared no longer says when it was last modified", () => {
    const store = demo();
    const source = store.objects(module_id(store, TESTS))[0];
    store.clear_suspect(store.links(source)[0]);
    assert.throws(() => dxl(store, `Module t = read("${TESTS}")\nModule m = read("${REQS}")
Link l\nfor l in (first t)->"*" do print l."Last Modified On" ""`), /not verified/);
  });

  test("the new names type-check", () => {
    check(`Column c
View v
Justification j = left
ModName_ n = module "x"
j = justify(c)
bool b = canCreate(n, v) || canControl(n, v) || canDelete(n, v) || canWrite(n, v)
b = canRead(item "x") && canModify(folder "x")
b = load(current Module, v, true)
string problem
problem = delete(current Module, v)`, demo());
  });
});
