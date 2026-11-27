// Places where a script must not get an answer here that DOORS would not give.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError, run, VirtualDisk } from "../src/dxl/index.ts";
import { Obj } from "../src/store.ts";
import { REQS, TESTS, demo, dxl, example, read_file } from "./helpers.ts";

const OPEN = `Module m = edit("${REQS}", false)\ncurrent = m\nObject o = object 2\n`;

const refused = (source: string, line: number, why: RegExp, store = demo()) =>
  assert.throws(() => dxl(store, OPEN + source), (e: unknown) => {
    assert.ok(e instanceof DxlError, String(e));
    assert.match(e.message, why);
    assert.equal(e.line, 3 + line);
    return true;
  });

const printed = (source: string, store = demo()) => dxl(store, OPEN + source).printed;

describe("Skip lists", () => {
  test("a create list does not take string keys, however they are made", () => {
    refused(`Skip s = create\nput(s, "valve", 1)`, 2, /createString/);
    refused(`Skip s = create\nput(s, identifier o, o)`, 2, /createString/);
    refused(`Skip s = create\nprint find(s, "pump" "")`, 2, /createString/);
  });

  test("createString matches the text; create still takes objects and numbers", () => {
    assert.equal(printed(`Skip s = createString\nput(s, identifier o, 1)\nprint find(s, "SYS-" "2")`), "true");
    assert.equal(printed(`Skip s = create\nput(s, 7, 1)\nput(s, o, 2)`.split("\n").slice(0, 2).join("\n")
      + `\nprint find(s, 7)`), "true");
    assert.equal(printed(`Skip s = create\nput(s, o, 2)\nprint find(s, object 2)`), "true");
  });
});

describe("an attribute with no value", () => {
  test("is not read as zero or false", () => {
    const with_cost = `create object type "Integer" attribute "Cost"\nObject p = object 2\n`;
    refused(with_cost + `int c = p."Cost"`, 3, /no value/);
    refused(with_cost + `int c = 0\nc = p."Cost"`, 4, /no value/);
    assert.equal(printed(with_cost + `if (null p."Cost") print "none"`), "none");
  });
});

describe("opening and closing modules", () => {
  test("another mode inside a for loop is refused", () => {
    refused(`int i\nfor (i = 0; i < 1; i++) { Module again = read("${REQS}", false) }`, 2, /inside a for loop/);
    refused(`Object x\nfor x in m do { Module again = read("${REQS}", false) }`, 2, /inside a for loop/);
    refused(`void look() { Module again = read("${REQS}", false) }\nint i\nfor i in 1:1 do look()`, 1,
      /inside a for loop/);
  });

  test("the same mode in a loop, and another mode outside one, are taken", () => {
    assert.equal(printed(`int i\nfor i in 1:2 do { Module a = edit("${REQS}", false) }\n`
      + `Module b = read("${REQS}", false)\nprint "ok"`), "ok");
  });

  test("close(m) alone does not decide what happens to unsaved changes", () => {
    refused(`o."Object Text" = "Shall hum."\nclose(m)`, 2, /save\(m\) first/);
    assert.equal(printed(`o."Object Text" = "Shall hum."\nsave m\nprint close(m)`), "true");
    assert.equal(printed(`print close(m)`), "true");
  });
});

describe("text and dates", () => {
  test("a day-first numeric date is not silently swapped", () => {
    refused(`Date d = date "23/05/2031"`, 1, /not a valid date/);
  });

  test("contains of a word that starts at the offset itself", () => {
    refused(`Buffer b = create\nb = "valve closes"\nprint contains(b, "valve", 0)`, 3, /offset 0/);
    assert.equal(printed(`Buffer b = create\nb = "the valve"\nprint contains(b, "valve", 0) ""`), "4");
  });
});

describe("the supplied scripts", () => {
  const SCRIPTS = ["trace_report", "orphan_report", "changed_since_linked", "requirement_quality",
    "export_attributes", "baseline_changes", "module_inventory"];

  // As when run from the window of a module that is open for editing.
  for (const name of SCRIPTS) {
    test(`${name} runs from a module open in edit`, () => {
      const source = read_file(`scripts/${name}.dxl`);
      for (const open of ["/Greenhouse Demo/System Requirements", "/Greenhouse Demo/Verification"]) {
        let out = "";
        run(source, example(), { write: (s) => { out += s; } }, open, ".", null, false, false, new VirtualDisk(),
          Date.now() + 20000);
        assert.doesNotMatch(out, /WARNING|cannot open/);
      }
    });
  }

  test("none declares a variable under the name of a DXL function", () => {
    for (const name of [...SCRIPTS, "dialog_trace"]) {
      assert.doesNotMatch(read_file(`scripts/${name}.dxl`),
        /^\s*(string|int|bool|Module|Baseline|Object)\s+(first|last|next|previous|name|prefix|column)\b/m, name);
    }
  });
});
