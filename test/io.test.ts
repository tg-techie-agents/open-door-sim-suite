// The example project, project files, and CSV.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { export_module, import_csv } from "../src/io/csvio.ts";
import { dump_project, load_project } from "../src/io/project.ts";
import { Obj, Store, StoreError } from "../src/store.ts";
import { EXAMPLE, csv_rows, example, read_file } from "./helpers.ts";

const DEMO = "/Greenhouse Demo";
const SRS = DEMO + "/System Requirements";

const empty = () => new Store(":memory:", "tester");

function suspects(store: Store): string[] {
  const out: string[] = [];
  for (const item of store.walk()) {
    if (item.kind !== "formal") continue;
    for (const o of store.objects(item.id)) {
      for (const link of store.links(o)) {
        if (store.suspect(link).some(Boolean)) {
          out.push(`${store.identifier(link.source)} ${store.identifier(link.target)}`);
        }
      }
    }
  }
  return out.sort();
}

const refused = (message: string | RegExp) => (e: unknown) =>
  e instanceof StoreError && (typeof message === "string" ? e.message.includes(message) : message.test(e.message));

describe("the example project", () => {
  test("edits made after its baseline show as differences and suspect links", () => {
    const store = example();
    const module = store.module_at(SRS)!;
    const changes = store.compare(store.baselines(module)[0].copy_id, module).map((c) => `${c.absno} ${c.change}`);
    assert.deepEqual([...new Set(changes)].sort(), ["14 modified", "19 deleted", "2 modified", "20 added"]);
    const found = suspects(store);
    assert.ok(found.includes("SRS-2 STK-2"));
    assert.ok(found.includes("TC-2 SRS-2"));
    assert.ok(!found.includes("SRS-3 STK-2"));
  });

  test("has its deliberate gaps", () => {
    const store = example();
    const module = store.module_at(SRS)!;
    const verification = store.module_at(DEMO + "/Verification");
    const unverified: number[] = [], orphans: number[] = [];
    for (const o of store.objects(module)) {
      if (!store.values(module).get(o.absno)?.get("Object Text")) continue;
      if (!store.links(o, false).some((l) => l.source.module_id === verification)) unverified.push(o.absno);
      if (!store.links(o, true).length) orphans.push(o.absno);
    }
    assert.deepEqual(unverified.sort((a, b) => a - b), [4, 7, 18, 20]);
    assert.deepEqual(orphans, [18]);
  });
});

describe("project files", () => {
  // The creation date is when the file was written, so it is not content.
  const dumped = (store: Store) => dump_project(store).replace(/"created_on": "[^"]*"/g, "");

  const shape = (store: Store, module: number) => store.objects(module, true).map((o) =>
    [o.absno, store.level(o), store.is_deleted(o), store.values(module).get(o.absno)?.get("Object Text")]);

  test("a round trip keeps the content", () => {
    const first = example();
    const module = first.module_at(SRS)!;
    // The awkward cases: a purged number, a moved object, a soft-deleted object that
    // keeps its link, an emptied default, a cleared suspect link.
    first.delete_object(new Obj(module, 4));
    first.delete_object(first.create_object(module));
    first.purge(module); // takes SRS-4, SRS-19 and the extra one
    first.move_object(new Obj(module, 20), null, null, new Obj(module, 2));
    first.delete_object(new Obj(module, 18));
    const needs = new Obj(first.module_at(DEMO + "/Stakeholder Needs")!, 4);
    first.create_link(new Obj(module, 3), needs, DEMO + "/satisfies");
    first.delete_object(new Obj(module, 3));
    first.set_value(new Obj(module, 6), "Priority", "");
    first.clear_suspect(first.links(new Obj(module, 14))[0]);
    first.create_baseline(module, "second", true, "CDR");

    const second = empty();
    load_project(second, dump_project(first));
    assert.equal(dumped(second), dumped(first));

    const again = second.module_at(SRS)!;
    assert.deepEqual(shape(second, again), shape(first, module));
    assert.deepEqual(second.baselines(again).map((b) => b.label), ["0.1", "1.0 (CDR)"]);
    first.baselines(module).forEach((old, i) => {
      assert.deepEqual(shape(second, second.baselines(again)[i].copy_id), shape(first, old.copy_id));
    });
    assert.deepEqual(suspects(second), suspects(first));
    assert.equal(second.value(new Obj(again, 6), "Priority"), "");
    assert.equal(second.create_object(again).absno, first.create_object(module).absno);
  });

  test("a bad file is refused and changes nothing", () => {
    const data = JSON.parse(read_file(EXAMPLE));
    for (const [key, entry, message] of [
      ["links", { module: DEMO + "/verifies", from: "TC-99", to: "SRS-2" }, "TC-99"],
      ["steps", { op: "set", object: "SRS-2", txet: "x" }, "txet"],
    ] as const) {
      const changed = structuredClone(data);
      changed[key].push(entry);
      const store = empty();
      assert.throws(() => load_project(store, JSON.stringify(changed)), refused(message));
      assert.deepEqual([...store.walk()], []);
    }
  });
});

describe("CSV", () => {
  function setup() {
    const store = empty();
    const module = store.create_module("/", "M", "", "R-");
    store.create_attribute(module, "Count", "Integer");
    const head = store.create_object(module, null, null, null, { "Object Heading": "Top" });
    const child = store.create_object(module, head, null, null,
      { "Object Text": '=cmd|"x", a\nsecond line', Count: "-5" });
    const exported = () => {
      let out = "";
      export_module(store, module, { write: (s: string) => { out += s; } });
      return out;
    };
    const load = (text: string) => import_csv(store, module, text);
    return { store, module, child, exported, load };
  }

  test("an export cannot run as a formula, and imports back unchanged", () => {
    const { store, child, exported, load } = setup();
    const text = exported();
    const [header, , second] = csv_rows(text);
    const row = Object.fromEntries(header.map((name, i) => [name, second[i]]));
    assert.deepEqual([row.ID, row.Level, row.Count], ["R-2", "2", "-5"]);
    assert.ok(row["Object Text"].startsWith("'="));
    assert.equal(load("﻿" + text).updated, 0);
    assert.ok(store.value(child, "Object Text").startsWith("=cmd"));
  });

  test("import creates by level and updates by ID", () => {
    const { store, module, child, load } = setup();
    const result = load("ID,Level,Object Heading,Object Text\n"
      + "R-1,1,Top,\n"
      + ",2,,first child\n"
      + "R-2,2,,changed\n"
      + ",,,sibling\n"
      + ",1,Next,\n"
      + ",2,,under next\n");
    assert.deepEqual([result.created, result.updated], [4, 1]);
    assert.deepEqual(
      store.objects(module).map((o) =>
        [store.level(o), store.value(o, "Object Text") || store.value(o, "Object Heading")]),
      [[1, "Top"], [2, "first child"], [2, "changed"], [2, "sibling"], [1, "Next"], [2, "under next"]]);
    assert.equal(store.value(child, "Count"), "-5"); // column left out: untouched
  });

  test("one bad row is named and changes nothing", () => {
    const { exported, load } = setup();
    const before = exported();
    for (const [rows, message] of [
      ["ID,Count\nR-2,7\n,many\n", /row 3: Count/],
      ["ID,Object Text\nR-9,x\n", /row 2: no object 'R-9'/],
      ["ID,Level\nR-2,1\n", /row 2: R-2 is at level 2/],
      ["ID,Level\n,3\n", /row 2: Level 3/],
      ["ID,Nonsense\n", /row 1/],
    ] as const) {
      assert.throws(() => load(rows), refused(message), rows);
      assert.equal(exported(), before);
    }
  });
});

describe("a baseline's date through a project file", () => {
  test("is kept, and the same objects are dated after it", () => {
    const first = example();
    const second = empty();
    load_project(second, dump_project(first));
    const facts = (store: Store) => {
      const data = JSON.parse(store.dumps());
      return [...store.walk()].filter((i) => i.kind === "formal").map((item) => {
        const baselines = store.baselines(item.id);
        const last = baselines[baselines.length - 1].created_on;
        const objects = data.modules.find((m: any) => m.id === item.id).objects;
        return [item.name, baselines.map((b) => b.created_on),
          objects.filter((o: any) => o.modified_on > last).map((o: any) => o.absno).sort((a: number, b: number) => a - b)];
      });
    };
    assert.deepEqual(facts(second), facts(first));
    assert.ok(facts(first).some((f) => (f[2] as number[]).length), "the example has edits after a baseline");
  });
});
