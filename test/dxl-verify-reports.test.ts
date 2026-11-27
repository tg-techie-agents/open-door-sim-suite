// What report scripts met when run against the example project.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError } from "../src/dxl/index.ts";
import { demo, dxl, example } from "./helpers.ts";

describe("the example project has a past", () => {
  const since_baseline = `
Module m = read("/Greenhouse Demo/System Requirements", false)
current = m
Date since = dateOf(getMostRecentBaseline(m))
Object o
for o in m do {
  Date changed = o."Last Modified On"
  if (changed > since) print identifier(o) " "
}`;

  test("a report by date finds what was edited after the baseline, and only that", () => {
    const printed = dxl(example(), since_baseline).printed;
    for (const id of ["SRS-2 ", "SRS-14 ", "SRS-20 "]) assert.ok(printed.includes(id), printed);
    assert.ok(!printed.includes("SRS-3 "), printed);
  });

  test("history entries after the baseline are dated after it", () => {
    const printed = dxl(example(), `
Module m = read("/Greenhouse Demo/System Requirements", false)
current = m
Date since = dateOf(getMostRecentBaseline(m))
History h
for h in object(2) do {
  Date d = h.date
  if (d > since && h.type == modifyObject) print h.attrName ";"
}`).printed;
    assert.equal(printed, "Object Text;");
  });
});

describe("+= on a Buffer with an attribute value", () => {
  test("is still refused, by line, saying what to write instead", () => {
    assert.throws(
      () => dxl(demo(), `Module m = read("/Demo/System Requirements", false)\ncurrent = m\nObject o = first m\n`
        + `Buffer b = create\nb += o."Object Text"`),
      (e: unknown) => e instanceof DxlError && e.line === 5 && /b \+= o\."Object Text" ""/.test(e.message));
  });

  test("with a string joined to it, it appends", () => {
    assert.equal(dxl(demo(), `Module m = read("/Demo/System Requirements", false)\ncurrent = m\n`
      + `Object o = first m\nBuffer b = create\nb += o."Object Heading" ""\nprint stringOf(b)`).printed, "Kettle");
  });
});
