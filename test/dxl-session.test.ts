// dxlHere, module and section lock calls, and createPublic/createPrivate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";

function output(source: string, store: any = new Store()): string {
  let out = "";
  run(source, store, { write: (t: string) => { out += t; } });
  return out;
}

const closed = 'Module m = create("M", "d", "R", 1)\nsave m\nclose m\nModName_ r = module("M")\n';
const open = 'Module m = create("M", "d", "R", 1)\nObject o = create m\ncurrent = m\n';

test("dxlHere is shown by print, with the line, in this suite's own words", () => {
  const shown = (line: number) => `[dxlHere: the script itself, line ${line}; DOORS words this differently]`;
  assert.equal(output('print dxlHere() "\\n"'), shown(1) + "\n");
  assert.equal(output('\nprint(dxlHere() "")'), shown(2));
  assert.equal(output('void f() {\n  print "at " dxlHere()\n}\nf'), "at " + shown(2));
});

test("dxlHere's text cannot be kept or taken apart, even under noError", () => {
  for (const source of ["string s = dxlHere()", "print length dxlHere()", "noError\nstring s = dxlHere()",
    'if (dxlHere() == "") halt']) {
    assert.throws(() => output(source), /dxlHere: the layout of its text is not documented/, source);
  }
});

test("a module is locked and unlocked while closed", () => {
  assert.equal(output(closed + 'print "[" lock(r) "] " isLocked(r) " " isLockedClosed(r) "\\n"\n'
    + 'print "[" unlock(r) "] " isLocked(r) " " isLockedClosed(r) "\\n"\nbool refused = !null(unlock(r))\nprint refused'),
  "[] true true\n[] false false\ntrue");
});

test("what a lock does where DOORS does not say stops the script", () => {
  assert.throws(() => output(closed + 'string s = lock(r)\nModule n = edit("M", false)'), /locked does is not documented/);
  assert.throws(() => output(closed + "string s = lock(r)\ns = lock(r)"), /already locked/);
  assert.throws(() => output(open + 'bool b = isLocked(module("M"))'), /not verified/);
  assert.throws(() => output(open + 'string s = lock(module("M"))'), /not documented/);
});

test("no section is lockable or locked in a module not open shareable", () => {
  assert.equal(output(open + 'print canLock(o) " " canUnlock(o) " " isLockedByUser(o) " " oleIsObject(o) ""\n'
    + 'Object none = null\nprint " " canLock(none) canUnlock(none) ""'), "false false false false falsefalse");
});

test("createPublic and createPrivate give a view definition to fill in", () => {
  for (const call of ["createPublic", "createPrivate"]) {
    assert.equal(output(open + `ViewDef v = ${call}(m, true)\nprint useColumns(v)`), "true", call);
    assert.equal(output(open + `ViewDef w = ${call}()\nuseColumns(w, false)\nprint useColumns(w)`), "false", call);
  }
});
