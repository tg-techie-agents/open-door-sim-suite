// Name checks, folders, open modes, heading split, platform and the user's locale.

import assert from "node:assert/strict";
import { test } from "node:test";

import { VirtualDisk, run } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";

const output = (source: string, disk: VirtualDisk = new VirtualDisk(), store: Store = new Store()): string => {
  let out = "";
  run(source, store, { write: (t: string) => { out += t; } }, null, ".", null, false, false, disk);
  return out;
};

const MODULE = 'Module m = create("/M", "d", "R-", 1)\nObject o = create m\n'
  + 'o."Object Heading" = "Pumps"\no."Object Text" = "The pump shall run."\n';

test("the first character a name may not hold, or the null char", () => {
  assert.equal(output('char c = getInvalidCharInModuleName("Pump rev_1.a-2")\nif (null c) print "ok "\n'
    + 'print getInvalidCharInProjectName("a/b:c") ""'), "ok /");
  assert.throws(() => output('char c = getInvalidCharInModuleName("caf\\351")'), /not documented/);
});

test("downgrade lowers the mode after a save, and fails on a closed module", () => {
  assert.equal(output(MODULE + 'save m\nif (downgrade m) print (isRead m) " "\nclose m\nprint (downgrade m) ""'),
    "true false");
  assert.throws(() => output(MODULE + "downgrade m"), /save the module first/);
  assert.equal(output(MODULE + 'print (downgradeShare m) " " (isShare m) ""'), "true true");
});

test("splitting gives the heading to a new parent of the object", () => {
  assert.equal(output(MODULE + 'string e = splitHeadingAndText o\nObject p = parent o\n'
    + 'print p."Object Heading" "|" o."Object Heading" "|" o."Object Text" "|" (null e) ""'),
    "Pumps||The pump shall run.|true");
  assert.equal(output(MODULE + 'print unicodeString(o."Object Heading")'), "Pumps");
});

test("platform answers as the Windows client", () => {
  assert.equal(output("print platform"), "WIN32");
});

test("the user's locale changes nothing about a date", () => {
  assert.equal(output('Locale loc = userLocale\nDate d = date("4 Oct 2031", loc)\n'
    + 'print (stringOf(d, loc) == stringOf(d)) " " stringOf(d, loc, "yyyy-MM-dd")'), "true 2031-10-04");
  assert.throws(() => output("Locale loc\nprint stringOf(today, loc)"), /null/);
});

test("mkdir makes a folder a script may then write in, and refuses the rest", () => {
  const disk = new VirtualDisk();
  assert.equal(output('mkdir "out"\nStat s = create "out"\nif (directory s) print "made "\n'
    + 'Stream f = write "out/a.csv"\nf << "x"\nclose f\nprint readFile "out/a.csv"', disk), "made x");
  assert.throws(() => output('mkdir "out"', disk), /already exists/);
  assert.throws(() => output('mkdir "a/b"'), /does not exist/);
  assert.throws(() => output('mkdir "/elsewhere"'), /may not make the folder/);
  assert.throws(() => output('mkdir ".hidden"'), /may not make the folder/);
});
