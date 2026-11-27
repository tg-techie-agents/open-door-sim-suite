// Forms that everyday report scripts use.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError } from "../src/dxl/index.ts";
import { demo, dxl } from "./helpers.ts";

const printed = (source: string, store = demo()) => dxl(store, source).printed;
const refused = (source: string, why: RegExp) =>
  assert.throws(() => dxl(demo(), source), (e: unknown) => e instanceof DxlError && why.test(e.message));

describe("int compound assignments", () => {
  test("%=, |= and &= work on a variable and on an array element", () => {
    assert.equal(printed(`int i = 17\ni %= 5\nprint i ""`), "2");
    assert.equal(printed(`int i = 5\ni |= 10\ni &= 6\nprint i ""`), "6");
    assert.equal(printed(`int a[] = {17}\na[0] %= 5\na[0] |= 8\na[0] &= 11\nprint a[0] ""`), "10");
  });

  test("a statement runs on after one of them at the end of a line", () => {
    assert.equal(printed(`int i = 5\ni |=\n  2\nprint i ""`), "7");
  });

  test("%= by zero stops, and none of the three takes another type", () => {
    refused(`int i = 1\ni %= 0`, /division by zero/);
    refused(`real r = 2.0\nr %= 1.0`, /not supported for real/);
    refused(`bool b = true\nb |= false`, /not supported for bool/);
    refused(`real a[] = {1.0}\na[0] &= 1.0`, /not supported for real/);
    refused(`string s = "a"\ns |= "b"`, /not supported for string/);
  });
});

describe("doorsname", () => {
  test("is the user the database records", () => {
    assert.equal(printed(`string who = doorsname\nprint who`), "tester");
  });
});
