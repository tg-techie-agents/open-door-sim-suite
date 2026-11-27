import assert from "node:assert/strict";
import { test } from "node:test";
import { demo, dxl, REQS } from "./helpers.ts";

const open = `Module m = edit("${REQS}", false)\ncurrent = m\n`;
const run = (script: string): string => dxl(demo(), open + script).printed;

test("a handle to an object removed for good is refused, not read as empty", () => {
  const gone = "Object o = create(first m)\ndelete(o)\n";
  for (const use of ['print o."Object Text" ""', "print identifier o", "Object p = next o", "delete(o)"]) {
    assert.throws(() => run(gone + use), /line 5.*no longer exists/s, use);
  }
  assert.throws(() => run(`Object o = create(first m)
softDelete(o)
purgeObjects_(m)
print identifier o`), /no longer exists/);
});

test("module explorer filtering is forgotten when the module is closed and opened again", () => {
  assert.throws(() => run(`applyFiltering(m)
save(m)
close(m)
m = edit("${REQS}", false)
print applyingFiltering(m) ""`), /not documented/);
});

test("next and previous with a filter stay among the siblings", () => {
  // the heading has matching objects below it, but no sibling at all
  assert.equal(run(`Object top = first m
Filter f = notNull(attribute "Object Text")
bool after = null next(top, f)
bool before = null previous(top, f)
print after " " before ""`), "true true");
});

test("a range is still refused beside a real with a bare point", () => {
  for (const source of ['string s = "abc"\nprint s[1..2]', "print 1..", "int a = 1..3", "print ..5"]) {
    assert.throws(() => run(source), /\.\. is a DXL operator/, source);
  }
});

test("a bare point makes a real only outside strings and comments", () => {
  assert.equal(run(`// 1..2 and .5
print "1..2 .5" /* ..5 */
Regexp re = regexp "a..b\\\\.5"
if (re "axxb.5") print " y "
real r = .5
real t = 1.
print (r + t) ""
real u = 5.E-1
print " " u ""`), "1..2 .5 y 1.500000 0.500000");
  assert.throws(() => run("int x = 3\nprint x .5"), /concatenation/);
});

test("a real += is a value in parentheses; an int one is refused", () => {
  assert.equal(run('real x = 1.1\nprint (x += 2.0) "|" x ""'), "3.100000|3.100000");
  assert.throws(() => run("int i = 1\nprint (i += 2)"), /only appends/);
});

test("static and a leading underscore are refused wherever a name is made", () => {
  assert.throws(() => run("void f() {\n static int x\n}"), /line 4.*static/s);
  for (const source of ["int _a = 1", "_a = 1", "void _f() {}", "void f(int &_a) {}", "int _a[] = {1}"]) {
    assert.throws(() => run(source), /must begin with a letter/, source);
  }
});
