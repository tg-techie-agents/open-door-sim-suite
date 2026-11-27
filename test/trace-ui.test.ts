// The traceability tools: the DXL the wizard writes, run by the engine and
// checked against the links themselves; the operations behind the overview,
// matrix and suspect links; and what the page adds.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { VirtualDisk } from "../src/dxl/files.ts";
import { layout, run } from "../src/dxl/index.ts";
import { Obj, Store } from "../src/store.ts";
import { Api, plain } from "../src/web/api.ts";
import "../src/web/trace-ops.ts";
import { traceability_columns } from "../src/web/trace-wizard.ts";
import type { TraceOptions } from "../src/web/trace-wizard.ts";
import { demo, example, read_file, REQS, TESTS } from "./helpers.ts";

const BASE = "/Greenhouse Demo/";
const NEEDS = BASE + "Stakeholder Needs", SYSTEM = BASE + "System Requirements", CHECKS = BASE + "Verification";

const call = (store: Store, operation: string, args: Record<string, unknown> = {}): any => {
  const api = new Api(store, "t", { names: {}, layout: {} }, new VirtualDisk()) as any;
  const result = api["op_" + operation](args);
  return result === undefined ? null : JSON.parse(JSON.stringify(plain(result)));
};

// Each column the wizard writes, run: absno -> the text of the cell.
function cells(store: Store, module: string, options: Partial<TraceOptions>): Map<number, string>[] {
  const id = store.module_at(module)!;
  return traceability_columns(options).map((c) => layout(c.dxl, store, id, { write: () => 0 }));
}

// The identifiers `hops` links away, found without DXL.
function reached(store: Store, start: Obj, outgoing: boolean, hops: number, through = "*"): string[] {
  if (!hops) return [store.identifier(start)];
  return store.links(start, outgoing, through).map((l) => (outgoing ? l.target : l.source))
    .filter((o) => !store.is_deleted(o)).flatMap((o) => reached(store, o, outgoing, hops - 1, through));
}

const ids = (text: string): string[] => text.match(/\b(STK|SRS|SUB|TC)-\d+\b/g) ?? [];
const objects = (store: Store, module: string): Obj[] => Array.from(store.objects(store.module_at(module)!));
const sorted = (list: string[]) => [...list].sort();
const bare = { moduleName: "" as const, attributes: [] };

describe("traceability wizard DXL", () => {
  test("a column's code runs from a module already open in edit mode", () => {
    const store = example();
    const needs = store.module_at(NEEDS)!, [a, b] = objects(store, NEEDS).slice(1, 3);
    store.create_link(a, b, BASE + "satisfies"); // so a far end is the module being looked at
    for (const direction of ["in", "out"] as const) {
      const from = direction === "in" ? b : a;
      const [column] = traceability_columns({ ...bare, direction, depth: 2 });
      // display() is layout DXL only; print what it would have shown
      const source = `Object obj = object(${from.absno}, edit("${NEEDS}", false))\n`
        + column.dxl.replace(/display\((.*)\)$/gm, 'print $1 "\\n"');
      let out = "";
      run(source, store, { write: (text: string) => { out += text; return text.length; } });
      assert.ok(ids(out).includes(store.identifier(direction === "in" ? a : b)), out);
      assert.equal(needs, from.module_id);
    }
  });

  for (const [direction, module] of [["in", NEEDS], ["out", CHECKS]] as const) {
    test(`${direction}-links, one column per level, match the links`, () => {
      const store = example();
      const columns = cells(store, module, { ...bare, direction, depth: 3, multipleColumns: true });
      assert.equal(columns.length, 3);
      let found = 0;
      columns.forEach((column, i) => {
        for (const obj of objects(store, module)) {
          const expected = reached(store, obj, direction === "out", i + 1);
          assert.deepEqual(sorted(ids(column.get(obj.absno)!)), sorted(expected), `${store.identifier(obj)} level ${i + 1}`);
          found += expected.length;
        }
      });
      assert.ok(found > 20);
    });
  }

  test("several levels in one column are indented by level", () => {
    const store = example();
    const [column] = cells(store, NEEDS, { ...bare, depth: 2 });
    const text = column.get(2)!.split("\n");
    assert.equal(text[0], "SRS-2");
    assert.equal(text[1], "    SUB-2");
    assert.deepEqual(sorted(ids(column.get(2)!)),
      sorted([...reached(store, objects(store, NEEDS)[1], false, 1), ...reached(store, objects(store, NEEDS)[1], false, 2)]));
  });

  test("a chain of modules gives one column each, holding only that module", () => {
    const store = example();
    const [first, second] = cells(store, NEEDS, { ...bare, chain: [SYSTEM, CHECKS] });
    for (const obj of objects(store, NEEDS)) {
      assert.ok(ids(first.get(obj.absno)!).every((id) => id.startsWith("SRS-")));
      const expected = reached(store, obj, false, 2).filter((id) => id.startsWith("TC-"));
      assert.deepEqual(sorted(ids(second.get(obj.absno)!)), sorted(expected));
    }
  });

  test("a specific module and link module restrict the analysis", () => {
    const store = example();
    const [scoped] = cells(store, SYSTEM, { ...bare, scope: CHECKS });
    const [through] = cells(store, SYSTEM, { ...bare, linkModule: BASE + "verifies" });
    const [any] = cells(store, SYSTEM, bare);
    for (const obj of objects(store, SYSTEM)) {
      const tests = sorted(reached(store, obj, false, 1).filter((id) => id.startsWith("TC-")));
      assert.deepEqual(sorted(ids(scoped.get(obj.absno)!)), tests);
      assert.deepEqual(sorted(ids(through.get(obj.absno)!)), tests);
    }
    assert.notDeepEqual([...any], [...scoped]);
  });

  test("attributes, names, module names, link attributes and trimming", () => {
    const store = demo();
    const [column] = cells(store, REQS, { attributes: ["Object Text", "Test Status", "No Such"], showNames: true,
      moduleName: "name", linkAttributes: ["Created By"] });
    assert.equal(column.get(2), ["ID: TST-1", "  Module: Test Cases", "  Object Text: Try it.", "  Test Status: Passed",
      "  No Such: ", "  Link Created By: tester"].join("\n"));
    assert.equal(column.get(4), "");
    const [short] = cells(store, REQS, { attributes: ["Object Text"], moduleName: "path", perLine: false, trimDatum: 4 });
    assert.equal(short.get(2), "TST-1 /Demo/Test Cases Try ...");
    const [clipped] = cells(store, REQS, { attributes: ["Object Text"], moduleName: "relative", trimAll: 9 });
    assert.equal(clipped.get(2), "TST-1\n  T...");
  });

  test("a deleted object is not shown", () => {
    const store = demo();
    store.delete_object(objects(store, TESTS)[0]);
    assert.equal(cells(store, REQS, bare)[0].get(2), "");
  });

  test("names holding quotes and backslashes are written as DXL strings", () => {
    const store = demo();
    const name = 'Say "when" \\ why';
    store.create_attribute(store.module_at(TESTS)!, name);
    store.set_value(objects(store, TESTS)[0], name, "soon");
    assert.equal(cells(store, REQS, { identifier: false, moduleName: "", attributes: [name] })[0].get(2), "soon");
  });

  test("choices that cannot be written are refused", () => {
    for (const [options, why] of [
      [{ depth: 11 }, /depth/], [{ depth: 0 }, /depth/], [{ width: 1 }, /width/],
      [{ identifier: false, moduleName: "", attributes: [] }, /at least one/],
      [{ linkAttributes: ["Last Modified On"] }, /not available/],
      [{ attributes: ["two\nlines"] }, /control character/],
      [{ chain: [""] }, /every step/],
    ] as Array<[Partial<TraceOptions>, RegExp]>) {
      assert.throws(() => traceability_columns(options), why);
    }
  });

  test("the columns save in a view and run again from it", () => {
    const store = example();
    const module = store.module_at(NEEDS)!;
    const made = call(store, "trace_columns", { depth: 2, multipleColumns: true });
    assert.deepEqual(made.map((c: any) => c.title), ["In-links, level 1", "In-links, level 2"]);
    call(store, "save_view", { module, name: "Trace", definition: { layout: made,
      link_filter: { have: false, direction: "in", linkModule: "", module: "", skipHeadings: true } } });
    const view = call(store, "module", { module }).views.Trace;
    assert.equal(view.link_filter.have, false);
    const reply = call(store, "dxl_column", { module, source: view.layout[1].dxl });
    assert.equal(reply.error, null);
    assert.match(reply.cells[2], /SUB-2/);
  });
});

describe("link overview and matrix", () => {
  test("coverage counts leave out headings unless asked", () => {
    const store = demo();
    const overview = call(store, "trace_overview");
    const [set] = overview.linksets;
    assert.deepEqual([set.source_path, set.target_path, set.links, set.sources_linked, set.sources_total,
      set.targets_linked, set.targets_total], [TESTS, REQS, 2, 2, 2, 2, 3]);
    const reqs = overview.modules.find((m: any) => m.path === REQS);
    assert.deepEqual([reqs.total, reqs.no_in, reqs.no_out, reqs.no_links], [3, 1, 3, 1]);
    const all = call(store, "trace_overview", { headings: true });
    assert.equal(all.linksets[0].targets_total, 4);
  });

  test("the matrix marks each link where its ends cross", () => {
    const store = demo();
    const [set] = call(store, "trace_overview").linksets;
    const matrix = call(store, "trace_matrix", set);
    assert.deepEqual(matrix.rows.map((r: any) => r.id), ["TST-1", "TST-2"]);
    assert.deepEqual(matrix.columns.map((c: any) => c.id), ["SYS-1", "SYS-2", "SYS-3", "SYS-4"]);
    assert.deepEqual(matrix.marks.map(([r, c]: number[]) => [r, c]), [[0, 1], [1, 2]]);
  });
});

describe("suspect links", () => {
  const changed = () => {
    const store = demo();
    const requirement = objects(store, REQS)[1];
    store.set_value(requirement, "Object Text", "Shall boil water.");
    store.set_value(requirement, "Object Text", "Shall boil water quickly.");
    return store;
  };
  const suspects = (store: Store, module: string) => call(store, "trace_suspects", { module: store.module_at(module) })
    .objects.filter((o: any) => o.in.length || o.out.length);

  test("the object linked to the changed one is marked, not the changed one", () => {
    const store = changed();
    assert.deepEqual(suspects(store, REQS), []);
    const [test_case] = suspects(store, TESTS);
    assert.equal(test_case.id, "TST-1");
    const [entry] = test_case.out;
    assert.equal(entry.other.id, "SYS-2");
    assert.deepEqual(entry.changes.map((c: any) => [c.attribute, c.old, c.new]), [
      ["Object Text", "Shall boil.", "Shall boil water."],
      ["Object Text", "Shall boil water.", "Shall boil water quickly."],
    ]);
  });

  test("clearing is all or none, starts the history again, and refuses a baseline", () => {
    const store = changed();
    const [{ out: [entry] }] = suspects(store, TESTS);
    const item = { source: entry.source, link: entry.link };
    assert.throws(() => call(store, "trace_clear_suspect", { items: [item, { ...item, link: 999 }] }), /no longer/);
    assert.equal(suspects(store, TESTS).length, 1);
    assert.throws(() => call(store, "trace_clear_suspect", { items: [] }), /choose/);
    const baseline = store.create_baseline(store.module_at(TESTS)!, "one");
    assert.throws(() => call(store, "trace_suspects", { module: baseline.copy_id }), /baseline/);
    assert.throws(() => call(store, "trace_clear_suspect",
      { items: [{ source: { module: baseline.copy_id, absno: 1 }, link: entry.link }] }), /baseline/);
    assert.deepEqual(call(store, "trace_clear_suspect", { items: [item] }), { cleared: 1 });
    assert.deepEqual(suspects(store, TESTS), []);
    store.set_value(objects(store, REQS)[1], "Object Text", "Shall boil.");
    assert.equal(suspects(store, TESTS)[0].out[0].changes.length, 1);
  });
});

describe("the page's part", () => {
  // trace.js with just enough of app.js to load.
  const page: any = { TRACE: {}, MENUS: { File: () => [] } };
  runInNewContext(read_file("src/web/trace.js"), page);

  test("exported cells cannot run as spreadsheet formulas", () => {
    assert.equal(page.csvCell("=1+1"), "'=1+1");
    assert.equal(page.csvCell("@cmd"), "'@cmd");
    assert.equal(page.csvCell("-12.5"), "-12.5");
    assert.equal(page.csvCell('a "b",\nc'), '"a ""b"",\nc"');
  });

  test("coverage rounds to the nearest percent, and says 100% or 0% only when exactly so", () => {
    for (const [part, whole, shown] of [[10, 15, 67], [1, 3, 33], [199, 200, 99], [1, 500, 1], [15, 15, 100], [0, 15, 0]]) {
      assert.equal(page.coverage(part, whole), `${part} of ${whole} (${shown}%)`);
    }
    assert.equal(page.coverage(0, 0), "none to cover");
  });

  test("it is built, loaded, saves its change, and never parses database text as markup", () => {
    assert.match(read_file("src/web/build.sh"), /trace\.js src\/web\/trace\.css/);
    const index = read_file("src/web/index.html");
    assert.ok(index.indexOf('src="app.js"') < index.indexOf('src="trace.js"'));
    assert.match(index, /href="trace\.css"/);
    assert.match(read_file("src/web/worker.ts"), /"trace_clear_suspect"/);
    const script = read_file("src/web/trace.js");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      assert.ok(!script.includes(sink), sink);
    }
  });
});
