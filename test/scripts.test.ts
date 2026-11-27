// Every script that ships, run on the example project: it finds what is planted there.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { layout } from "../src/dxl/index.ts";
import { EXAMPLE as EMBEDDED_EXAMPLE, SCRIPTS as EMBEDDED } from "../src/web/generated/embeds.ts";
import { EXAMPLE, REQS, csv_rows, demo, dxl, example, read_file } from "./helpers.ts";

const names = (folder: string) =>
  readdirSync(new URL(`../${folder}/`, import.meta.url)).filter((n) => n.endsWith(".dxl")).sort();

// What each prints, and the rows its CSV file has below the header.
const REPORTS: Record<string, { printed: string; rows: number }> = {
  baseline_changes: {
    printed: "Compared with baseline 0.1 \nAdded: 1\nDeleted: 1\nEdited: 2\nReport written to baseline_changes.csv\n",
    rows: 5,
  },
  changed_since_linked: {
    printed: "Links checked: 48\nChanged since linked: 9\nReport written to changed_since_linked.csv\n",
    rows: 9,
  },
  export_attributes: { printed: "19 objects written to export_attributes.csv\n", rows: 19 },
  module_inventory: {
    printed: "Stakeholder Needs: 10 objects, 8 with text, latest baseline 0.1\n"
      + "Subsystem Requirements: 16 objects, 12 with text, latest baseline 0.1\n"
      + "System Requirements: 19 objects, 15 with text, latest baseline 0.1\n"
      + "Verification: 18 objects, 16 with text, latest baseline 0.1\n",
    rows: 0,
  },
  orphan_report: {
    printed: "Requirements checked: 15\nWith something missing: 6\nReport written to orphan_report.csv\n",
    rows: 6,
  },
  requirement_quality: {
    printed: "Requirements checked: 27\nTo look at: 2\nReport written to requirement_quality.csv\n",
    rows: 2,
  },
  trace_report: {
    printed: "Requirements: 15\nVerified: 7\nNot passed: 4\nNo link: 4\nReport written to trace_report.csv\n",
    rows: 15,
  },
};

/** Run a shipped report; the rows below the header of the CSV file it wrote. */
function report(name: string): { printed: string; rows: string[][] } {
  const { printed, result, disk } = dxl(example(), read_file(`scripts/${name}.dxl`));
  assert.deepEqual(result.unsaved, []);
  return { printed, rows: csv_rows(disk.get(`${disk.cwd}/${name}.csv`) ?? "").slice(1) };
}

describe("shipped report scripts", () => {
  test("every one of them is covered here", () => {
    // dialog_trace.dxl waits for a person: dxl-dialogs.test.ts drives it
    assert.deepEqual(names("scripts"), [...Object.keys(REPORTS), "dialog_trace"].sort().map((n) => n + ".dxl"));
  });

  for (const [name, wanted] of Object.entries(REPORTS)) {
    test(`${name} runs completely`, () => {
      const { printed, rows } = report(name);
      assert.equal(printed, wanted.printed);
      assert.equal(rows.length, wanted.rows);
    });
  }

  test("orphan report names what each requirement lacks", () => {
    const missing = Object.fromEntries(report("orphan_report").rows.map((r) => [r[1], r[3].trim()]));
    assert.equal(missing["SRS-18"], "parent child test");
  });

  test("changed since linked names the link's two ends", () => {
    const ends = report("changed_since_linked").rows.map((r) => `${r[0]} ${r[1]}`);
    assert.ok(ends.includes("SUB-2 SRS-2"), ends.join(", "));
  });

  test("wording check finds the planted faults", () => {
    assert.deepEqual(report("requirement_quality").rows.map((r) => r[1]), ["SRS-4", "SRS-7"]);
  });

  test("baseline changes include object text", () => {
    assert.deepEqual(report("baseline_changes").rows.map((r) => r.slice(0, 3).join("|")).sort(), [
      "SRS-14|changed|Object Text", "SRS-14|changed|Rationale", "SRS-19|deleted|",
      "SRS-20|added|", "SRS-2|changed|Object Text"]);
  });

  test("trace report works on another database with only its settings changed", () => {
    let script = read_file("scripts/trace_report.dxl");
    for (const [shipped, ours] of [
      ['"/Greenhouse Demo/System Requirements"', `"${REQS}"`],
      ['"/Greenhouse Demo/verifies"', '"*"'],
      ['"Verification Status"', '"Test Status"'],
    ]) {
      assert.ok(script.includes(shipped), shipped);
      script = script.replaceAll(shipped, ours);
    }
    const { printed, disk } = dxl(demo(), script);
    assert.ok(printed.includes("Verified: 1\nNot passed: 1\nNo link: 1\n"), printed);
    const rows = csv_rows(disk.get(`${disk.cwd}/trace_report.csv`)!).slice(1);
    assert.deepEqual(rows.map((r) => [r[1], r[3], r[4], r[6]]), [
      ["SYS-2", "Verified", "TST-1", "Passed"],
      ["SYS-3", "Not passed", "TST-2", "Failed"],
      ["SYS-4", "No link", "", ""]]);
  });
});

describe("shipped layout columns", () => {
  for (const name of names("scripts/layout")) {
    test(`${name} gives every requirement a cell and some a link`, () => {
      const store = example();
      const module = store.module_at("/Greenhouse Demo/System Requirements")!;
      const cells = layout(read_file("scripts/layout/" + name), store, module);
      assert.deepEqual([...cells.keys()], store.objects(module).map((o) => o.absno));
      assert.ok([...cells.values()].some((text) => text !== ""));
    });
  }
});

test("the browser app carries the same scripts and example project (rebuild if this fails)", () => {
  const strip = (text: string) => text.replace(/^﻿/, "");
  const folder = (path: string) => Object.fromEntries(names(path).map((n) => [n, strip(read_file(`${path}/${n}`))]));
  assert.deepEqual(EMBEDDED, { names: folder("scripts"), layout: folder("scripts/layout") });
  assert.equal(EMBEDDED_EXAMPLE, strip(read_file(EXAMPLE)));
});
