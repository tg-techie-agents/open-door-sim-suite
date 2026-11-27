// Baseline set definitions and baseline sets.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dump_project, load_project } from "../src/io/project.ts";
import { Store } from "../src/store.ts";
import { REQS, demo, dxl } from "./helpers.ts";

const reqs = (store: Store) => store.module_at(REQS)!;

const DEFINE = `Folder f = folder("/Demo")
  BaselineSetDefinition bsd
  string e = create(f, "Release", "all of it", bsd)
  if (!null e) print "ERR " e "\\n"
  e = lock(bsd)
  e = e addModule(module("${REQS}"), bsd)
  e = e save(bsd)
  e = e unlock(bsd)
  if (!null e) print "ERR " e "\\n"
`;

const FIND = `Folder f = folder("/Demo")
  BaselineSetDefinition bsd, d
  for d in f do bsd = d
`;

describe("baseline set definitions", () => {
  test("a definition is made, changed under a lock, saved and listed", () => {
    const store = demo();
    assert.equal(dxl(store, DEFINE).printed, "");
    const { printed } = dxl(store, FIND + `
      print name(bsd) ": " description(bsd) "\\n"
      ModName_ m
      for m in bsd do print fullName(m) "\\n"
      print setDescription(bsd, "x") "\\n"
      string e = lock(bsd)
      e = setDescription(bsd, "unsaved")
      print description(bsd) "\\n"
      e = unlock(bsd)
      print description(bsd) "\\n"
    `);
    assert.equal(printed, `Release: all of it\n${REQS}\nthe baseline set definition is not locked\nunsaved\nall of it\n`);
  });

  test("a second definition of the same name is a returned message", () => {
    const store = demo();
    dxl(store, DEFINE);
    const { printed } = dxl(store, `BaselineSetDefinition other
      string e = create(folder("/Demo"), "Release", "", other)
      print (!null e) " " (null other) "\\n"`);
    assert.equal(printed, "true true\n");
  });
});

describe("baseline sets", () => {
  test("a set takes baselines while open, and they are found again", () => {
    const store = demo();
    dxl(store, DEFINE);
    const { printed } = dxl(store, FIND + `
      BaselineSet bs
      print create(bsd, true, "", "first", bs) "\\n"
      string e = lock(bsd)
      e = create(bsd, true, "", "first", bs)
      print "[" e "] " versionID(bs) " " isOpen(bs) " " annotation(bs) " " isAnyBaselineSetOpen(bsd) "\\n"
      Skip mods = create
      ModName_ r = module("${REQS}")
      put(mods, 1, r)
      e = addBaselines(mods, bs)
      print "[" e "] " isBaselinePresent(bs, module("${REQS}")) "\\n"
      ModuleVersion mv
      for mv in bs do {
        print fullName(mv) " " versionString(mv) "\\n"
        BaselineSet held = baselineSet(mv)
        print versionID(held) "\\n"
      }
      print addBaselines(mods, bs) "\\n"
      e = close(bs)
      print isOpen(bs) " " close(bs) "\\n"
    `);
    assert.equal(printed, "the baseline set definition is not locked\n[] 1.0 true first true\n[] true\n"
      + `${REQS} 1.0\n1.0\na module is already in the baseline set\nfalse the baseline set is not open\n`);
    assert.equal(store.baselines(reqs(store)).length, 1);
    const copy = Store.loads(store.dumps());
    assert.deepEqual(copy.all_set_definitions(), store.all_set_definitions());
  });

  test("where the module's own number differs from the set's, nothing is baselined", () => {
    const store = demo();
    store.create_baseline(reqs(store), "", true);
    dxl(store, DEFINE);
    assert.throws(() => dxl(store, FIND + `
      string e = lock(bsd)
      BaselineSet bs
      e = create(bsd, true, "", "", bs)
      Skip mods = create
      ModName_ r = module("${REQS}")
      put(mods, 1, r)
      e = addBaselines(mods, bs)`), /own next baseline would be 2\.0 and the set is 1\.0/);
    assert.equal(store.baselines(reqs(store)).length, 1);
  });
});

describe("baseline sets in project files", () => {
  test("definitions, sets and their baselines are written and loaded", () => {
    const store = demo();
    dxl(store, DEFINE);
    const folder = store.find("/Demo")!;
    const [definition] = store.set_definitions(folder);
    store.create_baseline_set(folder, definition.id, true, "", "first");
    store.add_to_baseline_set(folder, definition.id, 0, [reqs(store)]);
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    const [loaded] = copy.set_definitions(copy.find("/Demo")!);
    assert.equal(loaded.name, "Release");
    assert.equal(loaded.sets[0].open, true);
    assert.equal(copy.baseline_of(loaded.sets[0].members[0])!.module_id, reqs(copy));
    assert.equal(dump_project(copy), dump_project(store));
  });
});

describe("module copy", () => {
  const COPY = `ModName_ r = module("${REQS}")
    print copy(r, "Copy", "a copy") "\\n"`;

  test("objects, numbers and outgoing links come across; incoming links and baselines do not", () => {
    const store = demo();
    store.create_baseline(reqs(store));
    const source = reqs(store);
    const links = (module: number, outgoing: boolean) =>
      store.objects(module).flatMap((o) => store.links(o, outgoing));
    assert.equal(dxl(store, COPY).printed, "true\n");
    const made = store.module_at("/Demo/Copy")!;
    assert.deepEqual(store.objects(made).map((o) => store.identifier(o)),
      store.objects(source).map((o) => store.identifier(o)));
    assert.deepEqual(store.objects(made).map((o) => store.value(o, "Object Text")),
      store.objects(source).map((o) => store.value(o, "Object Text")));
    assert.equal(links(made, true).length, links(source, true).length);
    assert.equal(links(made, false).length, 0);
    assert.equal(store.baselines(made).length, 0);
    assert.equal(dxl(store, COPY).printed, "false\n");
    const again = Store.loads(store.dumps());
    assert.equal(again.objects(again.module_at("/Demo/Copy")!).length, store.objects(made).length);
  });

  test("a module with a deleted object is not copied by guesswork", () => {
    const store = demo();
    const last = store.objects(reqs(store)).at(-1)!;
    for (const link of [...store.links(last, true), ...store.links(last, false)]) store.delete_link(link);
    store.delete_object(last);
    assert.throws(() => dxl(store, COPY), /deleted objects/);
  });
});

describe("history sessions", () => {
  test("each opening for editing is a session; reading is not; baselines take none", () => {
    const store = demo();
    const edit = `Module m = edit("${REQS}", false)`;
    dxl(store, edit);
    dxl(store, `Module m = read("${REQS}", false)`);
    const { printed } = dxl(store, edit + `
      HistorySession hs
      for hs in m do { Date d = when(hs); print number(hs) " " who(hs) " " (!null d) "\\n" }`);
    assert.equal(printed, "0 tester true\n1 tester true\n");
    const baseline = store.create_baseline(reqs(store));
    assert.deepEqual(store.sessions(baseline.copy_id), []);
    assert.equal(Store.loads(store.dumps()).sessions(reqs(store)).length, 2);
  });
});

describe("the configuration area", () => {
  const run = (store: Store, source: string) => dxl(store, source).printed;

  test("text written by one script is read by a later one, and is saved with the database", () => {
    const store = demo();
    run(store, `confMkdir("tools", confUser)
      ConfStream out = confWrite("tools/last.txt", confUser)
      out << "first\\n"
      out << "second\\n"
      close(out)`);
    const READ = `ConfStream s = confRead("tools/last.txt", confUser)
      string line
      while (true) {
        s >> line
        if (end(s)) break
        print line "|"
      }
      close(s)`;
    assert.equal(run(store, READ), "first|second|");
    assert.equal(run(Store.loads(store.dumps()), READ), "first|second|");
    const other = Store.loads(store.dumps());
    other.user = "someone else";
    assert.throws(() => run(other, READ), /there is no folder tools/);
  });

  test("a name used with and without an area stops the script", () => {
    const store = demo();
    run(store, `ConfStream out = confWrite("a.txt")
      close(out)`);
    assert.equal(run(store, `print confFileExists("a.txt") " " confFileExists("b.txt", confSystem) ""`), "true false");
    assert.throws(() => run(store, `print confFileExists("a.txt", confSystem)`), /which area is the default/);
  });

  test("deleting, renaming and copying", () => {
    const store = demo();
    const { printed } = dxl(store, `ConfStream out = confWrite("a", confSystem)
      out << "x"
      close(out)
      string e = confCopyFile("a", "b", confSystem)
      e = e confRenameFile("b", "c", confSystem)
      e = e confDeleteFile("a", confSystem)
      print "[" e "]" confFileExists("a", confSystem) confFileExists("b", confSystem) confFileExists("c", confSystem) ""
      print " " (!null confDeleteFile("a", confSystem)) ""`);
    assert.equal(printed, "[]falsefalsetrue true");
  });
});

describe("unsaved changes", () => {
  test("a module is not copied with changes DOORS has not been given", () => {
    const store = demo();
    assert.throws(() => dxl(store, `Module m = edit("${REQS}", false)
      Object o = first m
      o."Object Text" = "not saved"
      ModName_ r = module("${REQS}")
      print copy(r, "Copy", "") ""`), /unsaved changes/);
  });
});
