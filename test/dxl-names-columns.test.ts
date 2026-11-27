// isOutline, modified(Object) and AttrDef useraccess; and the
// names that stay refused because the manuals do not settle them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demo, dxl, REQS } from "./helpers.ts";
import type { Store } from "../src/store.ts";

const open = `Module m = read("${REQS}", false)\n`;
const edit = `Module m = edit("${REQS}", false)\n`;
const printed = (store: Store, source: string, head = open) => dxl(store, head + source).printed;
const stops = (store: Store, source: string, reason: RegExp, head = open) =>
  assert.throws(() => dxl(store, head + source), (e: any) => reason.test(e.message));
// SYS-1 is the heading, SYS-2 to SYS-4 the requirements under it
const each = `Object o\nfor o in m do print identifier(o) " " `;

test("attrName of the ID column stays refused", () => {
  stops(demo(), `print attrName(column(m, 0))`, /ID column/);
});

test("isOutline is true of objects with a heading", () => {
  assert.equal(printed(demo(), each + `isOutline(o) ";"`),
    "SYS-1 true;SYS-2 false;SYS-3 false;SYS-4 false;");
});

const change = `Object o\nfor o in m do { if (identifier(o) == "SYS-2") { o."Object Text" = "Shall simmer." } }\n`;

test("modified(Object) is about changes since the last baseline", () => {
  const store = demo();
  stops(store, `Object o = first(m)\nprint modified(o)`, /no baseline/);
  store.create_baseline(store.module_at(REQS)!);
  assert.equal(printed(store, change + `for o in m do { bool b = modified(o)\nprint b ";" }`, edit), "false;true;false;false;");
});

test("modified(Object) stops where what counts is not documented", () => {
  const baselined = () => {
    const store = demo();
    store.create_baseline(store.module_at(REQS)!);
    return store;
  };
  stops(baselined(), `Object o = create(m)\nprint modified(o)`, /created since/, edit);
  stops(baselined(), `Object o\nfor o in m do { if (identifier(o) == "SYS-4") { softDelete(o)\nprint modified(o) } }`,
    /not by an attribute edit/, edit);
});

test("useraccess says which attributes users can update", () => {
  const source = ["Object Heading", "Object Text", "Last Modified On", "Created Thru", "Absolute Number"]
    .map((name, i) => `AttrDef a${i} = find(m, "${name}")\nbool b${i} = a${i}.useraccess\nprint b${i} ";"`)
    .join("\n");
  assert.equal(printed(demo(), source), "true;true;false;false;false;");
});

test("names the manuals do not settle are refused by name", () => {
  stops(demo(), `Object o = first(m)\nstring s = probeRichAttr_(o, "Object Text")`, /probeRichAttr_/);
  stops(demo(), `print version(m)`, /version/);
  stops(demo(), `History h\nfor h in m do print h.sessionNo`, /sessionNo/);
  stops(demo(), `Buffer a = create\nBuffer b = create\nBuffer r = create\nstring s = diff(r, a, b)`, /diff/);
});
