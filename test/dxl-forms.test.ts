// The shape of the language as the manual's lexical rules give it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError } from "../src/dxl/index.ts";
import { demo, dxl } from "./helpers.ts";

const prints = (source: string, expected: string) => assert.equal(dxl(demo(), source).printed, expected, source);

const refused = (source: string, message: RegExp, line: number) =>
  assert.throws(() => dxl(demo(), source),
    (e: unknown) => e instanceof DxlError && message.test(e.message) && e.line === line, source);

describe("real constants", () => {
  test("the integer part or the fraction part may be left out", () => {
    prints(`real a = 1.\nreal b = .5\nprint (a + b) ""`, "1.500000");
    prints(`real a = 1.e3\nreal b = -.5\nprint (a * b) ""`, "-500.000000");
    prints(`real r[] = {.5, 2.}\nprint (r[0] * r[1]) ""`, "1.000000");
  });

  test("two points are still not a real", () => {
    refused(`int i\nfor i in 1..2 do {}`, /\.\. is a DXL operator/, 2);
  });
});

describe("assignment as a value", () => {
  test("adding to a real gives the new value", () => {
    prints(`real x = 1.5\nprint (x += 2.0)\nprint " " x ""`, "3.500000 3.500000");
  });

  test("it is not offered for a string", () => {
    refused(`string s = "a"\nprint (s += "b")`, /adds to a real variable/, 2);
  });
});

describe("refused by name", () => {
  test("static", () => {
    refused(`int n\nstatic int kept = 3`, /static is a DXL keyword/, 2);
  });

  test("a name that does not begin with a letter", () => {
    refused(`int ok_1 = 1\nint _hidden = 2`, /must begin with a letter/, 2);
  });

  test("text that was not UTF-8, in a string or a character", () => {
    refused(`int n\nprint "25 �C"`, /not saved as UTF-8/, 2);
    refused(`char c = '�'`, /not saved as UTF-8/, 1);
  });

  test("such a character in a comment does no harm", () => {
    prints(`// 25 �C\n/* � */ print "ok"`, "ok");
  });
});
