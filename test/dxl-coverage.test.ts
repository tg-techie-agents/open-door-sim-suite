// Every known DXL name works or is refused by name, and the coverage list says which.

import assert from "node:assert/strict";
import { test } from "node:test";

import { check, coverage } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";

const refusal = (source: string): string => {
  try {
    check(source, new Store());
  } catch (e: any) {
    return String(e);
  }
  return "";
};

test("a real name that is not offered is told apart from a typo", () => {
  assert.match(refusal("getRegistry(\"a\")"), /line 1: getRegistry .*a DOORS function this practice suite does not offer \(reason: cannot be done here/);
  assert.match(refusal("PageLayout p"), /PageLayout .*a DOORS type .*\(reason: not built\)/);
  assert.match(refusal("gtRegistry(\"a\")"), /undeclared or unsupported function: gtRegistry/);
  assert.match(refusal("switch (1) {}"), /switch is a word DXL reserves/);
  assert.match(refusal("int a := 1"), /:= is a DXL operator this practice suite does not offer/);
});

test("the coverage list has each name once, with a reason exactly when it is not offered", () => {
  const list = coverage();
  assert.equal(new Set(list.map((e) => `${e.kind} ${e.name}`)).size, list.length);
  for (const e of list) assert.equal(e.reason === null, e.offered, e.name);
  assert.ok(list.find((e) => e.name === "print")!.offered);
});

test("every name listed as not offered is refused by name when a script uses it", () => {
  for (const e of coverage()) {
    if (e.offered || e.kind === "operator" || e.kind === "keyword") continue;
    if (e.name === "display" || e.name === "displayRich") continue;
    const source = e.kind === "type" ? `${e.name} x` : `print(${e.name})`;
    assert.ok(refusal(source).includes(e.name), `${source}: ${refusal(source)}`);
    assert.match(refusal(source), /does not offer \(reason: /, source);
  }
});
