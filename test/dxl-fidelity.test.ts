// Behaviour checked against the DXL Reference Manual 9.2 (pages by each group).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";
import { REQS, demo, dxl } from "./helpers.ts";

const prints = (source: string, expected: string, store: Store = demo()) =>
  assert.equal(dxl(store, source).printed, expected);

const refused = (source: string, message: RegExp, line?: number, store: Store = demo()) =>
  assert.throws(() => dxl(store, source), (e: unknown) => e instanceof DxlError && message.test(e.message)
    && (line === undefined || e.line === line), source);

const READ = `Module m = read("${REQS}", false)\ncurrent = m\n`;

describe("null of an attribute (p370)", () => {
  test("true only when it holds nothing", () => {
    prints(`${READ}Object o = first m
      print (null o."Object Text") " " (!null o."Object Heading") ""`, "true true");
  });
});

describe("real (^) (p81)", () => {
  test("raises to a power", () => {
    prints(`real side = 3.0
      real cube = side ^ 3.0
      print cube " " ((side + 1.0) ^ 0.5) ""`, "27.000000 2.000000");
  });

  test("refused beside another operator, whose grouping is not documented", () => {
    refused(`real r = 2.0 * 3.0 ^ 2.0`, /parentheses/, 1);
    refused(`real r = 3.0 ^ 2.0 + 1.0`, /parentheses/, 1);
    refused(`real r = -3.0 ^ 2.0`, /parentheses/, 1);
    refused(`real r = 3.0 ^ 2`, /incorrect arguments for \(\^\)/, 1);
  });
});

describe("references (p17)", () => {
  test("another name for the same variable", () => {
    prints(`int crates = 2
      int& stock = crates
      stock += 3
      crates++
      print crates " " stock ""`, "6 6");
    prints(`void bump() {
        string name = "oak"
        string &alias = name
        alias = alias "s"
        print name ""
      }
      bump`, "oaks");
  });

  test("must name a variable of its own type", () => {
    refused(`int &r = 3`, /must name a int variable/, 1);
    refused(`real x = 1.0\nint &r = x`, /must name a int variable/, 2);
    refused(`int a = 1, b = 2\nint &r = a, s = b`, /one reference/, 2);
  });
});

describe("operator functions (p17)", () => {
  test("gives an operator a meaning for new operand types", () => {
    prints(`string ::*(string s, int n) {
        string out = ""
        int i
        for i in 0 : n - 1 do out = out s
        return out
      }
      print ("ab" * 2) " " (3 * 4) ""`, "abab 12");
  });

  test("redefining what DXL already does is refused", () => {
    refused(`int ::+(int a, int b) { return 0 }`, /already works/, 1);
    refused(`string ::..(real r, int n) { return "" }`, /not offered/, 1);
    refused(`print ("ab" * 2)`, /incorrect arguments for \(\*\)/, 1);
  });
});

describe("uniqueID (p223)", () => {
  test("one per item, kept through a rename", () => {
    prints(`Module m = edit("${REQS}", false)
      string before = uniqueID m
      string other = uniqueID(item "/Demo")
      rename(module "${REQS}", "Renamed", "")
      print (before == uniqueID(m)) " " (before == other) " " (length before) ""`, "true false 8");
  });
});
