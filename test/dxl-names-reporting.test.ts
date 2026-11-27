import assert from "node:assert/strict";
import { test } from "node:test";
import { demo, dxl, REQS } from "./helpers.ts";

const open = `Module m = edit("${REQS}", false)\ncurrent = m\n`;

test("delete(Object) removes a soft-deleted object for good", () => {
  const { printed } = dxl(demo(), `${open}Object o = last(first(m))
Object e = create(first m)
softDelete(e)
delete(e)
int n = 0
for o in entire m do n++
print n`);
  assert.equal(printed, "4");
});

test("next and previous with a filter walk the siblings that match", () => {
  const { printed } = dxl(demo(), `${open}Object a = first(first m)
Filter f = contains(attribute "Object Text", "dry", false)
Object b = next(a, f)
print b."Object Text" ""
print " "
print (null previous(a, f))`);
  assert.equal(printed, "Shall not run dry. true");
});

test("a ModuleVersion gives its baseline designation, and nothing else of it", () => {
  const script = `${open}create(m, nextMajor, "first")
m = edit("${REQS}", false)
print (null baseline(moduleVersion(m)))
print " " baselineExists(moduleVersion(m)) ""
Baseline b
for b in m do {
  Module old = load(m, b, false)
  Baseline d = baseline(moduleVersion(old))
  print " " major(d) "." minor(d) " " baselineExists(moduleVersion(old)) ""
`;
  assert.equal(dxl(demo(), script + "}").printed, "true false 1.0 true");
  assert.throws(() => dxl(demo(), script + "print user(d)\n}"), /for b in module/);
});

test("a column says how the module is sorted on it, until the sort is destroyed", () => {
  const { printed } = dxl(demo(), `${open}insert(column 0)
attribute(column 0, "Object Text")
set(descending "Object Text")
sorting on
print isDescending(column 0) ""
print " " isAscending(column 0) ""
destroySort(m)
print " " isDescending(column 0) ""`);
  assert.equal(printed, "true false false");
});

test("module explorer filtering is remembered once the script has set it", () => {
  const { printed } = dxl(demo(), `${open}applyFiltering(m)
print applyingFiltering(m) ""
unApplyFiltering(m)
print " " applyingFiltering(m) ""`);
  assert.equal(printed, "true false");
  assert.throws(() => dxl(demo(), `${open}print applyingFiltering(m) ""`), /not documented/);
});
