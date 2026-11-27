// Places where a script could have run here and behaved differently in DOORS.
// All data is made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dxl } from "./helpers.ts";
import { Store } from "../src/store.ts";

const empty = (): Store => new Store(":memory:", "tester");

// a project with one formal module open as the current one
const KETTLE = `Project p
create("Kettle", "made up", p)
current = folder("/Kettle")
Module m = create("System", "made up", "SYS-", 1)
current = m
string err
`;

describe("noError does not swallow what this suite cannot settle", () => {
  test("a refusal still stops the script, by line", () => {
    assert.throws(() => dxl(empty(), `noError
string s = goodStringOf(modifyType)
print "carried on\\n"`), /not documented/);
  });
  test("an error DOORS would report is still trapped", () => {
    const { printed } = dxl(empty(), `noError
int i = 1 / 0
string said = lastError
print (!null said) "\\n"`);
    assert.equal(printed, "true\n");
  });
  test("error() under noError is refused rather than guessed", () => {
    assert.throws(() => dxl(empty(), `noError
error "stop"`), /noError/);
  });
});

describe("access records", () => {
  test("the default record has a null user name", () => {
    const { printed } = dxl(empty(), KETTLE + `specific(m)
set(m, read|modify|create|delete|control, null)
AccessRec ar
for ar in m do { if (isDefault(ar)) print "[" username(ar) "]\\n" }`);
    assert.equal(printed, "[]\n");
  });
});

describe("definitions", () => {
  test("setting a descriptor to what it already is stops the script", () => {
    assert.throws(() => dxl(empty(), `Project p
create("Kettle", "made up", p)
Folder f = folder("/Kettle")
addLinkModuleDescriptor(f, "Software", "System", true, "satisfies", "made up")
LinkModuleDescriptor d
for d in f do setOverridable(d, true)`), /already overridable/);
  });
  test("false for a limit the type already has is refused; with none it does nothing", () => {
    const make = KETTLE + `AttrType t = create("Percent", 0, 100, err)
`;
    assert.throws(() => dxl(empty(), make + "setMaxValue(t, 50, false)"), /removes the limit/);
  });
});

test("hardDelete of a module needs it soft-deleted first", () => {
  const { printed } = dxl(empty(), KETTLE + `close(m)
ModName_ n = module("/Kettle/System")
print hardDelete(n) "\\n"
softDelete(n)
n = module("/Kettle/System")
`);
  assert.equal(printed, "false\n");
});

// the whole chain a setup script goes through, from an empty database
const SETUP = `// invented data: a kettle
void must(string err) {
    if (!null err) { print "FAILED: " err "\\n"; halt }
}

Project p
must(create("Kettle", "Kettle controller", p))
current = folder("/Kettle")
Folder specs
must(create("Specs", "Requirement modules", specs))
Folder links
must(create("Links", "Link modules", links))

string err
current = specs
Module sys = create("System", "System requirements", "SYS-", 1)
current = sys
string levels[] = {"High", "Medium", "Low"}
int vals[] = {3, 2, 1}
AttrType level = create("Level", levels, vals, err)
must(err)
AttrType pct = create("Percent", 0, 100, err)
must(err)
AttrDef pri = create object type "Level" (default "Medium") attribute "Priority"
AttrDef cov = create object type "Percent" attribute "Coverage"
create module type "String" attribute "Owner"
(current Module)."Owner" = "Systems"

Object h = create(current Module)
h."Object Heading" = "Heating"
Object a = create(below(h))
a."Object Text" = "The kettle shall boil one litre within four minutes."
a."Priority" = "High"
a."Coverage" = "50"
Object b = create(after(a))
b."Object Text" = "The kettle shall switch off when boiling."
save(current Module)

Module sw = create("Software", "Software requirements", "SW-", 1)
current = sw
Object s1 = create(current Module)
s1."Object Text" = "The controller shall sample temperature every second."
save(current Module)

must(addLinkModuleDescriptor(specs, "Software", "System", false, "/Kettle/Links/satisfies", "Software satisfies system"))

Module t = read("/Kettle/Specs/System", false)
Module src = edit("/Kettle/Specs/Software", false)
Object so = first src
Object to_ = first t
to_ = object(2, t)
so -> "/Kettle/Links/satisfies" -> to_
save(src)

current = edit("/Kettle/Specs/System", true)
View v = view "Review"
ViewDef vd = create(current Module, true)
Column c
for c in current Module do width(c)
Column col = insert(column 1)
attribute(col, "Priority")
title(col, "Priority")
width(col, 90)
useFiltering(vd, false)
useSorting(vd, false)
save(current Module, v, vd)
save(current Module)

create(current Module, nextMajor, "first issue")

Module again = read("/Kettle/Specs/Software", false)
Object o
Link l
int n = 0
for o in again do {
    for l in o -> "/Kettle/Links/satisfies" do {
        print identifier(o) " -> " fullName(target(l)) " " targetAbsNo(l) "\\n"
        n++
    }
}
print "links " n "\\n"
Module m = read("/Kettle/Specs/System", false)
Baseline bl
for bl in m do print major(bl) "." minor(bl) " " annotation(bl) "\\n"
for o in m do print identifier(o) " [" o."Priority" "] [" o."Coverage" "]\\n"
string vv
for vv in views(m) do print vv "\\n"`;

test("a setup script builds a project from nothing and reads it back", () => {
  const { printed, result } = dxl(empty(), SETUP);
  assert.equal(printed, "SW-1 -> /Kettle/Specs/System 2\nlinks 1\n1.0 first issue\nSYS-1 [Medium] []\n"
    + "SYS-2 [High] [50]\nSYS-3 [Medium] []\nReview\n");
  assert.deepEqual(result.unsaved, []);
});

describe("deleting objects", () => {
  const tree = KETTLE + `Object top = create(m)
Object under = create(below(top))
Module t = create("Tests", "made up", "T-", 1)
Object check = create(t)
Module lm = create("verifies", "made up", manyToMany)
check -> "/Kettle/verifies" -> under
`;
  for (const call of ["softDelete", "hardDelete"]) {
    test(`${call} stops at an incoming link, even under noError`, () => {
      assert.throws(() => dxl(empty(), tree + `noError\n${call}(under)`), /incoming links/);
    });
    test(`${call} stops at an object with objects below it`, () => {
      assert.throws(() => dxl(empty(), tree + `noError\n${call}(top)`), /objects below it/);
    });
  }
  test("a leaf with only outgoing links is deleted", () => {
    const { printed } = dxl(empty(), tree + `softDelete(check)\nprint isDeleted(check) "\\n"`);
    assert.equal(printed, "true\n");
  });
});

describe("baseline sets", () => {
  const start = KETTLE + `Object o = create(m)
save(m)
Folder f = folder("/Kettle")
BaselineSetDefinition bsd
err = create(f, "Release", "made up", bsd)
err = lock(bsd)
err = addModule(module("/Kettle/System"), bsd)
BaselineSet bs
Skip mods = create
ModName_ n = module("/Kettle/System")
put(mods, 1, n)
`;
  const take = `err = create(bsd, true, "", "", bs)
err = addBaselines(mods, bs)
`;
  test("a name no folder could have is a returned message", () => {
    const { printed } = dxl(empty(), KETTLE + `BaselineSetDefinition bsd
print (!null create(folder("/Kettle"), "a/b?", "", bsd)) " " (null bsd) "\\n"`);
    assert.equal(printed, "true true\n");
  });
  test("a set is not made over unsaved changes to its definition", () => {
    assert.throws(() => dxl(empty(), start + take), /unsaved changes/);
  });
  test("saved first, it takes the baseline", () => {
    const { printed } = dxl(empty(), start + "err = save(bsd)\n" + take
      + `print "[" err "] " isBaselinePresent(bs, n) "\\n"`);
    assert.equal(printed, "[] true\n");
  });
  test("a module with unsaved changes is not baselined", () => {
    assert.throws(() => dxl(empty(), start + `err = save(bsd)
m = edit("/Kettle/System", false)
Object late = create(m)
` + take), /module has unsaved changes/);
  });
});
