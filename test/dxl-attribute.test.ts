// Attribute DXL: made from DXL, calculated on read, kept until reset, bounded,
// harmless to the database, and carried by every place a database is written.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError, layout } from "../src/dxl/index.ts";
import { VirtualDisk } from "../src/dxl/files.ts";
import { export_module, import_csv } from "../src/io/csvio.ts";
import { dump_project, load_project } from "../src/io/project.ts";
import { export_reqif } from "../src/io/reqif.ts";
import { Obj, Store } from "../src/store.ts";
import { Api } from "../src/web/api.ts";
import { REQS, TESTS, csv_rows, demo, dxl } from "./helpers.ts";

const OPEN = `Module m = edit("${REQS}", false)\ncurrent = m\n`;
// demo(): object 1 is a heading; 2 and 3 are each verified by one test; 4 by none
const COUNT = 'int n = 0\nLinkRef l\nfor l in obj <- "*" do n++\nobj.attrDXLName = n ""';

const reqs = (store: Store) => store.module_at(REQS)!;
const at = (store: Store, absno: number) => new Obj(reqs(store), absno);

/** demo() with one DXL attribute on the requirements. */
function made(code: string, type = "String", name = "Calc"): Store {
  const store = demo();
  store.create_attribute(reqs(store), name, type, "object", false, "", code);
  return store;
}

const values = (store: Store, name = "Calc") => store.objects(reqs(store)).map((o) => store.value(o, name));

describe("creating attribute DXL from DXL", () => {
  test("the code goes with the other properties or after the attribute's name", () => {
    const store = demo();
    const { printed } = dxl(store, OPEN + `
      string code = "obj.attrDXLName = identifier(obj) \\"/\\" attrDXLName"
      AttrDef a = create object (dxl code) (inherit false) (hidden false) type "String" attribute "Before"
      AttrDef b = create object type "Integer" attribute "After" dxl "int i = 7\\nobj.attrDXLName = i"
      AttrDef c = create attribute "Bare" dxl code
      if (a.dxl) print "yes "
      AttrDef plain = find(m, "Object Text")
      if (!plain.dxl) print "no\\n"
      string held = a.dxl
      print held "\\n"
      Object o = object 2
      print o."Before" " " o."After" " " o."Bare" ""
    `);
    assert.equal(printed, 'yes no\nobj.attrDXLName = identifier(obj) "/" attrDXLName\nSYS-2/Before 7 SYS-2/Bare');
    assert.equal(store.attribute(reqs(store), "After")!.dxl, "int i = 7\nobj.attrDXLName = i");
  });

  test("what is not covered is refused", () => {
    const cases: [string, RegExp][] = [
      ['create module attribute "x" dxl "halt"', /only supported here/],
      ['create (default "1") (dxl "halt") attribute "x"', /only supported here/],
      ['create (dxl "halt") (inherit true) attribute "x"', /inherited object attribute with DXL/],
      ['create (dxl "") attribute "x"', /code is empty/],
      ['print attrDXLName', /attrDXLName/],
    ];
    for (const [script, message] of cases) {
      assert.throws(() => dxl(demo(), OPEN + script), message, script);
    }
  });

  test("deleting the attribute forgets what it calculated", () => {
    const store = made('obj.attrDXLName = "old"');
    assert.equal(store.value(at(store, 2), "Calc"), "old");
    store.delete_attribute(reqs(store), "Calc");
    store.create_attribute(reqs(store), "Calc", "String", "object", false, "", 'obj.attrDXLName = "new"');
    assert.equal(store.value(at(store, 2), "Calc"), "new");
  });
});

describe("calculating", () => {
  test("obj is the object being read, and the module is current", () => {
    const store = made('obj.attrDXLName = identifier(obj) " " identifier(first current Module)');
    assert.equal(store.value(at(store, 3), "Calc"), "SYS-3 SYS-1");
  });

  test("a value is kept until a script sets it to (string null)", () => {
    const store = made('obj.attrDXLName = obj."Object Text" ""', "Text");
    const { printed } = dxl(store, OPEN + `
      Object o = object 2
      print o."Calc" "|"
      o."Object Text" = "changed"
      print o."Calc" "|"
      o."Calc" = (string null)
      print o."Calc" ""
    `);
    assert.equal(printed, "Shall boil.|Shall boil.|changed");
    // and across runs, while the database stays loaded
    dxl(store, OPEN + 'object(2)."Object Text" = "again"');
    assert.equal(store.value(at(store, 2), "Calc"), "changed");
    assert.equal(Store.loads(store.dumps()).value(at(store, 2), "Calc"), "again");
  });

  test("assigning the attribute by its own name works as attrDXLName does", () => {
    const store = made('obj."Calc" = 3', "Integer");
    const { printed } = dxl(store, OPEN + 'int n = object(2)."Calc"\nprint (n + 1) ""');
    assert.equal(printed, "4");
  });

  test("code that assigns nothing leaves the value empty and is run again", () => {
    const store = made('if (obj."Object Text" "" == "later") obj.attrDXLName = "now"');
    assert.equal(store.value(at(store, 2), "Calc"), "");
    store.set_value(at(store, 2), "Object Text", "later");
    assert.equal(store.value(at(store, 2), "Calc"), "now");
  });

  test("a value may be read from other objects' values", () => {
    const store = made('int n = 1\nObject c\nfor c in obj do { int k = c."Calc"\n n += k }\nobj.attrDXLName = n ""',
      "Integer");
    assert.deepEqual(values(store), ["4", "1", "1", "1"]);
  });

  test("a value that depends on itself says so", () => {
    const itself = made('string s = obj."Calc"\nobj.attrDXLName = s');
    assert.match(itself.shown_value(at(itself, 2), "Calc"), /depends on itself/);
    const ring = made('Object other = next obj\nif (null other) other = first current Module\n'
      + 'obj.attrDXLName = other."Calc" ""');
    assert.match(ring.shown_value(at(ring, 2), "Calc"), /depends on itself/);
  });

  test("only obj's module is open to it, whatever the reading script has open", () => {
    const store = made('int n = 0\nLink l\nfor l in obj <- "*" do n++\nobj.attrDXLName = n ""', "Integer");
    const { printed } = dxl(store, `Module t = read("${TESTS}", false)\n` + OPEN + 'print object(2)."Calc" ""');
    assert.equal(printed, "0"); // a Link loop sees only links from loaded modules; LinkRef sees all
  });

  test("reading never changes the database", () => {
    const store = made(COUNT, "Integer");
    const before = store.dumps();
    assert.deepEqual(values(store), ["0", "1", "1", "0"]);
    assert.equal(store.dumps(), before);
  });

  test("code that tries to change the database fails and nothing is kept", () => {
    const attempts = [
      'obj."Object Text" = "x"',
      'Object o = first current Module\no."Calc" = "x"\nif (o != obj) halt',
      `Module m = edit("${REQS}", false)\nObject o = create m`,
      'Object o = obj\nsoftDelete(o)',
      'create attribute "Another"',
      'Folder f = folder("/Demo")\ncurrent = f\nModule other = create("Sneaked", "d", "X-", 1)',
      `noError()\nObject o = create last below obj\nstring e = lastError()\nModule m = edit("${REQS}", false)\no = create m\n`
        + 'obj.attrDXLName = "hid it"',
    ];
    for (const code of attempts) {
      const store = made(code);
      const before = store.dumps();
      assert.match(store.shown_value(at(store, 2), "Calc"), /^#DXL error: /, code);
      assert.equal(store.dumps(), before, code);
    }
  });

  test("no files and no confirm", () => {
    for (const code of ['Stream s = write("out.txt")', 'if (confirm("sure?")) halt', '#include <nothing.inc>']) {
      assert.match(made(code).shown_value(new Obj(reqs(demo()), 2), "Calc"), /^#DXL error: /, code);
    }
  });

  test("code that runs on is stopped, remembered, and given up after five objects", () => {
    const store = made("while (true) {}");
    for (let i = 0; i < 4; i++) store.create_object(reqs(store));
    const started = Date.now();
    const shown = store.objects(reqs(store)).map((o) => store.shown_value(o, "Calc"));
    const took = Date.now() - started;
    assert.ok(took < 8000, `took ${took} ms`);
    assert.equal(shown.filter((s) => s === "#DXL error: ran past its time limit").length, 5);
    assert.equal(shown.filter((s) => /not run/.test(s)).length, 3);
    const again = Date.now();
    store.shown_value(at(store, 1), "Calc");
    assert.ok(Date.now() - again < 200);
  });

  test("a value of the wrong type, a bad script, and a run-time error are shown", () => {
    assert.match(made('obj.attrDXLName = "ten"', "Integer").shown_value(at(demo(), 2), "Calc"), /not an integer/);
    assert.match(made("\nnonsense()").shown_value(at(demo(), 2), "Calc"), /line 2: .*nonsense/);
    assert.match(made("int i = 1 / 0").shown_value(at(demo(), 2), "Calc"), /line 1: .*division by zero/);
  });

  test("a script reading a failing value stops, naming the attribute, unless it traps errors", () => {
    const store = made("int i = 1 / 0");
    assert.throws(() => dxl(store, OPEN + 'print object(2)."Calc" ""'),
      (e: any) => e instanceof DxlError && e.line === 3 && /attribute DXL of 'Calc' failed at object SYS-2/.test(e.message));
    const { printed } = dxl(store, OPEN + 'noError()\nstring s = object(2)."Calc"\nstring e = lastError()\n'
      + 'if (!null e) print "trapped"');
    assert.equal(printed, "trapped");
  });

  test("scripts cannot give it a value", () => {
    const store = made('obj.attrDXLName = "x"');
    for (const script of ['object(2)."Calc" = "y"', 'object(2)."Calc" = ""', 'Object o = create m\no."Calc" = "y"']) {
      assert.throws(() => dxl(store, OPEN + script), /calculated by attribute DXL/, script);
    }
    assert.throws(() => dxl(store, OPEN + 'object(2)."Object Text" = (string null)'), /not calculated by attribute DXL/);
    assert.throws(() => dxl(store, `Module m = read("${REQS}", false)\ncurrent = m\nobject(2)."Calc" = (string null)`),
      /read-only/);
  });

  test("a dry run keeps nothing it calculated or reset", () => {
    const store = made('obj.attrDXLName = obj."Object Text" ""', "Text");
    store.value(at(store, 2), "Calc");
    dxl(store, OPEN + `
      object(2)."Object Text" = "dry"
      object(2)."Calc" = (string null)
      print object(2)."Calc" ""
      print object(3)."Calc" ""
      object(3)."Object Text" = "dry too"
    `, { dry_run: true });
    store.set_value(at(store, 2), "Object Text", "real");
    store.set_value(at(store, 3), "Object Text", "real");
    assert.equal(store.value(at(store, 2), "Calc"), "Shall boil."); // still the value from before the run
    assert.equal(store.value(at(store, 3), "Calc"), "real"); // first calculated inside it: forgotten
  });

  test("layout DXL can read it", () => {
    const store = made(COUNT, "Integer");
    const cells = layout('display obj."Calc" ""', store, reqs(store));
    assert.deepEqual([...cells.values()], ["0", "1", "1", "0"]);
  });

  test("a baseline calculates from its own copy", () => {
    const store = made('obj.attrDXLName = obj."Object Text" ""', "Text");
    const { copy_id } = store.create_baseline(reqs(store));
    store.set_value(at(store, 2), "Object Text", "after the baseline");
    assert.equal(store.value(new Obj(copy_id, 2), "Calc"), "Shall boil.");
  });
});

describe("where the database goes", () => {
  const CODE = 'obj.attrDXLName = identifier(obj) ""';

  test("the saved database and the project file keep the code and no values", () => {
    const store = made(CODE);
    store.create_baseline(reqs(store));
    values(store);
    const saved = Store.loads(store.dumps());
    assert.equal(saved.attribute(reqs(saved), "Calc")!.dxl, CODE);
    assert.equal(saved.value(at(saved, 2), "Calc"), "SYS-2");

    const text = dump_project(store);
    assert.ok(!text.includes('"Calc":')); // the attribute is named, but no object holds a value for it
    const loaded = new Store(":memory:", "tester");
    load_project(loaded, text);
    assert.equal(loaded.attribute(reqs(loaded), "Calc")!.dxl, CODE);
    assert.equal(loaded.value(at(loaded, 2), "Calc"), "SYS-2");
    assert.equal(loaded.baselines(reqs(loaded)).length, 1);
  });

  test("a project file cannot give a calculated value", () => {
    const project = {
      format: "opendoor-project", version: 1,
      modules: [{ path: "/P/M", attributes: [{ name: "C", dxl: 'obj.attrDXLName = "x"' }],
        objects: [{ number: 1, values: { C: "typed" } }] }],
    };
    assert.throws(() => load_project(new Store(), JSON.stringify(project)), /calculated by attribute DXL/);
  });

  test("CSV shows values or errors, and import leaves them alone", () => {
    const store = made('if (obj."Object Text" "" == "Shall not run dry.") { int i = 1 / 0 }\nobj.attrDXLName = "ok"');
    let text = "";
    export_module(store, reqs(store), { write: (s: string) => { text += s; } });
    const rows = csv_rows(text);
    const column = rows[0].indexOf("Calc");
    assert.deepEqual(rows.slice(1).map((r) => r[column]),
      ["ok", "ok", "ok", "#DXL error: line 1: run-time error: division by zero"]);
    const result = import_csv(store, reqs(store), text);
    assert.deepEqual(result.ignored_columns.includes("Calc"), true);
    assert.equal(result.created, 0);
  });

  test("ReqIF carries the values, and refuses rather than send an error as data", () => {
    const good = made('obj.attrDXLName = "calculated-" obj."Absolute Number" ""');
    assert.match(export_reqif(good, [reqs(good)]).text, /calculated-2/);
    const bad = made("int i = 1 / 0");
    assert.throws(() => export_reqif(bad, [reqs(bad)]), /attribute DXL of 'Calc' failed/);
  });

  test("the browser interface gets values, errors, the code, and a way to recalculate", () => {
    const store = made('if (obj."Object Text" "" == "x") { int i = 1 / 0 }\nobj.attrDXLName = obj."Object Text" ""');
    const api = new Api(store, "demo", { names: {}, layout: {} }, new VirtualDisk());
    const module = reqs(store);
    const row = (data: any, absno: number) => data.rows.find((r: any) => r.absno === absno);
    let data = api.op_module({ module });
    assert.equal(row(data, 2).values.get("Calc"), "Shall boil.");
    assert.equal(data.attributes.find((a: any) => a.name === "Calc").dxl.length > 0, true);
    api.op_set_values({ module, absno: 2, values: { "Object Text": "x" } });
    assert.equal(row(api.op_module({ module }), 2).values.get("Calc"), "Shall boil.");
    api.op_recalculate({ module });
    data = api.op_module({ module });
    assert.match(row(data, 2).values.get("Calc"), /^#DXL error: .*division by zero/);
    assert.deepEqual(row(data, 2).failed, ["Calc"]);
    assert.deepEqual(row(data, 3).failed, []);
    assert.throws(() => api.op_set_values({ module, absno: 2, values: { Calc: "y" } }), /calculated by attribute DXL/);
    api.op_create_attribute({ module, name: "Two", type: "Integer", dxl: "obj.attrDXLName = 2" });
    assert.equal(row(api.op_module({ module }), 3).values.get("Two"), "2");
  });

  test("a script's filter and CSV-style loop use the calculated value", () => {
    const store = made(`int n = 0\nModule t = read("${TESTS}", false)\nLink l\nfor l in obj <- "*" do n++\n`
      + 'obj.attrDXLName = n ""', "Integer");
    const { printed } = dxl(store, `
      Module m = read("${REQS}", false)
      current = m
      Filter f = attribute "Calc" == "0"
      set f
      ancestors(false)
      filtering on
      Object o
      for o in m do print identifier(o) " "
    `);
    assert.equal(printed.trim(), "SYS-1 SYS-4");
  });
});
