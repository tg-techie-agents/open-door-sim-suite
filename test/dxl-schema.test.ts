// The database's own definitions: attribute types and definitions, from DXL and
// through saving.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { export_module, import_csv } from "../src/io/csvio.ts";
import { dump_project, load_project } from "../src/io/project.ts";
import { Obj, Store } from "../src/store.ts";
import { REQS, demo, dxl } from "./helpers.ts";

const OPEN = `Module m = edit("${REQS}", false)\ncurrent = m\n`;
const reqs = (store: Store) => store.module_at(REQS)!;
const at = (store: Store, absno: number) => new Obj(reqs(store), absno);

const SETUP = OPEN + `
  string err
  string names[] = {"Open", "Agreed", "Done"}
  int numbers[] = {10, 20, 30}
  int colors[] = {-1, 20, 14}
  string descs[] = {"not looked at", "agreed", "done"}
  AttrType t = create("Review State", names, numbers, colors, descs, err)
  if (!null err) print "ERR " err "\\n"
  AttrType r = create("Score", 1, 5, err)
  create object type "Review State" (default "Open") description "Where the review is" attribute "Review"
  create object type "Score" history false attribute "Rating"
  create object type "String" inherit true attribute "Owner"
`;

function made(): Store {
  const store = demo();
  assert.equal(dxl(store, SETUP).printed, "");
  return store;
}

describe("attribute types", () => {
  test("values carry related numbers, colours and a description; ranges are enforced", () => {
    const store = made();
    const { printed } = dxl(store, OPEN + `
      AttrType t = find(m, "Review State")
      print t.size " " t.strings[1] " " t.values[1] " " t.colors[2] " " t.colours[0] "\\n"
      AttrType r = find(m, "Score")
      if (r.maxValue) { int top = r.maxValue; print "max " top "\\n" }
      if (isRanged(r) && isUsed(r)) print "ranged, used\\n"
      noError()
      Object o = object 2
      o."Rating" = "9"
      string said = lastError()
      if (!null said) print "refused\\n"
    `);
    assert.equal(printed, "3 Agreed 20 14 -1\nmax 5\nranged, used\nrefused\n");
  });

  test("a type in use is extended only with arrMaps, renamed values follow, and it cannot be deleted", () => {
    const store = made();
    dxl(store, OPEN + 'Object o = object 2\no."Review" = "Agreed"');
    const { printed } = dxl(store, OPEN + `
      AttrType t = find(m, "Review State")
      string err
      string names[] = {"Open", "Accepted", "Done", "Closed"}
      int numbers[] = {10, 20, 30, 40}
      int colors[] = {-1, 20, 14, -1}
      string descs[] = {"a", "b", "c", "d"}
      int maps[] = {0, 1, 2, 3}
      noError()
      AttrType bad = modify(t, "Review State", names, numbers, colors, descs, err)
      if (!null lastError()) print "needs arrMaps\\n"
      AttrType u = modify(t, "Review State", names, numbers, colors, descs, maps, err)
      print u.size "\\n"
      if (!delete(u, err)) print "kept\\n"
    `);
    assert.equal(printed, "needs arrMaps\n4\nkept\n");
    assert.equal(store.value(at(store, 2), "Review"), "Accepted");
  });
});

describe("attribute definitions", () => {
  test("their properties are read back, and modify changes them", () => {
    const store = made();
    const { printed } = dxl(store, OPEN + `
      AttrDef a = find(m, "Review")
      print a.description "|" a.typeName "|" a.nohistory "|" a.inherit "\\n"
      AttrDef b = find(m, "Rating")
      if (b.nohistory) print "no history\\n"
      a = modify(a, setName, "Review status")
      a = modify(a, setDescription, "State of review")
      a = modify(a, setDefault, "Agreed")
      print a.name "|" a.description "\\n"
    `);
    assert.equal(printed, "Where the review is|Review State|false|false\nno history\nReview status|State of review\n");
    assert.equal(store.attribute(reqs(store), "Review"), null);
    assert.equal(store.attribute(reqs(store), "Review status")!.default, "Agreed");
  });

  test("an inherited attribute shows the parent's value until the object has its own", () => {
    const store = made();
    store.set_value(at(store, 1), "Owner", "systems");
    assert.equal(store.value(at(store, 2), "Owner"), "systems");
    assert.equal(store.values(reqs(store)).get(2)!.get("Owner"), "systems");
    assert.equal(store.values(reqs(store), true).get(2)!.has("Owner"), false);
    const { printed } = dxl(store, OPEN + `
      AttrDef a = find(m, "Owner")
      Object o = object 2
      print hasSpecificValue(o, a) " "
      o."Owner" = "systems"
      print hasSpecificValue(o, a) "\\n"
    `);
    assert.equal(printed, "false true\n");
  });

  test("history false keeps the edit out of the history", () => {
    const store = made();
    const before = store.history(reqs(store), 2).length;
    store.set_value(at(store, 2), "Rating", "3");
    assert.equal(store.history(reqs(store), 2).length, before);
  });

  test("everything survives saving, a project file and a baseline", () => {
    const store = made();
    store.set_value(at(store, 1), "Owner", "systems");
    store.set_value(at(store, 3), "Owner", "");
    store.create_baseline(reqs(store), "one");
    const schema = (s: Store) => ({
      types: s.types(reqs(s)).map((t) => ({ ...t, module_id: 0 })),
      defs: s.attributes(reqs(s), null).map((a) => ({ ...a, module_id: 0 })),
      owners: s.objects(reqs(s)).map((o) => s.value(o, "Owner")),
    });
    assert.deepEqual(schema(Store.loads(store.dumps())), schema(store));
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    assert.deepEqual(schema(copy), schema(store));
    assert.equal(dump_project(copy).includes('"Review State"'), true);
  });
});

describe("link module descriptors", () => {
  const setup = `
    Folder f = folder("/Demo")
    string e = addLinkModuleDescriptor(f, "Test Cases", "System Requirements", false, "Verifies", "unused")
    if (!null e) print e "\\n"
  `;

  test("they are listed, drive unnamed links, limit outgoing ones, and survive both formats", () => {
    const store = demo();
    const { printed } = dxl(store, setup + `
      LinkModuleDescriptor d
      for d in f do print getName(d) ": " getSourceName(d) " -> " getTargetName(d) " " getMandatory(d) "\\n"
      setLinkModuleDescriptorsExclusive(f, module("/Demo/Test Cases"), true)
      string twice = addLinkModuleDescriptor(f, "Test Cases", "System Requirements", false, "Verifies", "x")
      if (!null twice) print "no duplicate\\n"
    `);
    assert.equal(printed, "Verifies: Test Cases -> System Requirements false\nno duplicate\n");
    const tests = store.module_at("/Demo/Test Cases")!, source = new Obj(tests, 1);
    const link = store.create_link(source, at(store, 4));
    assert.equal(store.path(link.link_module), "/Demo/Verifies");
    assert.throws(() => store.create_link(source, at(store, 2), "/Demo/Other"), /descriptor is not overridable/);
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    for (const other of [copy, Store.loads(store.dumps())]) {
      const folder = other.find("/Demo")!;
      assert.deepEqual(other.link_descriptors(folder), store.link_descriptors(store.find("/Demo")!));
      assert.equal(other.links_exclusive(folder, other.module_at("/Demo/Test Cases")!), true);
    }
  });
});

describe("removal and conversion", () => {
  test("purge needs a deleted item; hardDelete takes the module, its links and its name", () => {
    const store = demo();
    const { printed } = dxl(store, `
      ModName_ tests = module("/Demo/Test Cases")
      string early = purge(tests)
      if (!null early) print "not yet\\n"
      if (hardDelete(tests)) print "gone " (null tests) "\\n"
      Folder made = create("/Spare", "")
      Project p
      string e = convertFolderToProject(made, p)
      if (null e) print "now a project\\n"
      Module m = edit("/Demo/System Requirements", false)
      Object o = gotoObject(4, m)
      print getBoundedAttr(o."Object Text", 5) "\\n"
      hardDelete(o)
    `);
    assert.equal(printed, "not yet\ngone true\nnow a project\nShall\n");
    assert.equal(store.module_at("/Demo/Test Cases"), null);
    assert.equal(store.links(at(store, 2), false).length, 0);
    assert.equal(store.object(reqs(store), 4), null);
    const again = Store.loads(store.dumps());
    assert.equal(again.module_at("/Demo/Test Cases"), null);
    again.create_module("/Demo", "Test Cases");
  });
});

describe("defaults", () => {
  test("changing a default moves the values that still hold the old one", () => {
    const store = made();
    const module = reqs(store);
    const fresh = store.create_object(module);
    store.set_value(at(store, 2), "Review", "Done");
    store.modify_attribute(module, "Review", { default: "Agreed" });
    assert.equal(store.value(fresh, "Review"), "Agreed");
    assert.equal(store.value(at(store, 2), "Review"), "Done");
  });

  test("an inherited attribute's default shows only where no ancestor has a value", () => {
    const store = made();
    const module = reqs(store);
    store.modify_attribute(module, "Owner", { default: "nobody" });
    const child = store.create_object(module, at(store, 1));
    assert.equal(store.value(child, "Owner"), "nobody");
    store.set_value(at(store, 1), "Owner", "systems");
    assert.equal(store.value(child, "Owner"), "systems");
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    assert.equal(copy.has_own_value(new Obj(reqs(copy), child.absno), "Owner"), false);
  });
});

describe("view definitions", () => {
  test("a view is saved with a definition while a filter is on, and the settings are read back", () => {
    const store = demo();
    const { printed } = dxl(store, `Module m = edit("${REQS}")
      current = m
      Column c
      for c in m do { width(c, 100) }
      ViewDef vd = create(m, true)
      useFiltering(vd, false)
      useSorting(vd, false)
      set(m, contains(attribute "Object Text", "boil", false))
      filtering on
      save(view("Mine"), vd)
      ViewDef held = get(view("Mine"))
      print useColumns(held) " " useFiltering(held) "\\n"
      delete(held)
    `);
    assert.equal(printed, "true false\n");
    assert.equal(store.views(reqs(store)).get("Mine").filter, null);
  });
});

describe("what a later change must not break", () => {
  test("a type changed or deleted since a baseline still loads from a project file", () => {
    const store = made();
    const module = reqs(store);
    store.create_type(module, "Spare", "String");
    store.create_baseline(module, "one");
    store.modify_type(module, "Review State", { description: "changed", values: ["Open", "Agreed", "Done", "Shut"],
      numbers: [], colours: [], descriptions: [] }, true);
    store.delete_type(module, "Spare");
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    const shape = (s: Store, m: number) => s.types(m).map((t) => ({ ...t, module_id: 0 }))
      .sort((a, b) => a.name < b.name ? -1 : 1);
    assert.deepEqual(shape(copy, reqs(copy)), shape(store, module));
    const frozen = (s: Store) => s.baselines(reqs(s))[0].copy_id;
    assert.deepEqual(shape(copy, frozen(copy)), shape(store, frozen(store)));
  });

  test("importing an export leaves inherited values inherited", () => {
    const store = made();
    store.set_value(at(store, 1), "Owner", "systems");
    let csv = "";
    export_module(store, reqs(store), { write: (s: string) => { csv += s; } });
    import_csv(store, reqs(store), csv);
    assert.equal(store.has_own_value(at(store, 2), "Owner"), false);
  });

  test("a descriptor whose module has been deleted is left out of the project file", () => {
    const store = demo();
    const folder = store.find("/Demo")!;
    store.add_link_descriptor(folder, { source: "Test Cases", target: "System Requirements", linkmod: "Verifies",
      overridable: false, mandatory: false });
    store.delete_item(store.module_at("/Demo/Test Cases")!);
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    assert.equal(copy.link_descriptors(copy.find("/Demo")!).length, 1);
  });

  test("a script cannot empty an inherited value", () => {
    assert.throws(() => dxl(made(), OPEN + 'Object o = object 2\no."Owner" = ""'), /inherited/);
  });
});

describe("default link module and linksets", () => {
  test("an unnamed link goes by the pairing, else the user's default, which is saved", () => {
    const store = demo();
    const { printed } = dxl(store, `
      setDefaultLinkModule("Traces")
      Module r = edit("${REQS}", false)
      Module t = edit("/Demo/Test Cases", false)
      (object(2, t)) -> (object(2, r))
      print getDefaultLinkModule() "\\n"
      Object o = object(2, t)
      Link l
      for l in o -> "Traces" do print "traced " targetAbsNo(l) "\\n"
    `);
    assert.equal(printed, "Traces\ntraced 2\n");
    assert.equal(Store.loads(store.dumps()).default_link_name, "Traces");
  });

  test("a linkset is made empty, kept through both formats, and deleting it deletes its links", () => {
    const store = demo();
    dxl(store, `current = folder("/Demo")
      Module lm = create("Derives", "", manyToMany)
      Linkset ls = create(lm, "Test Cases", "System Requirements")
      Module lm2 = create("Checks", "", manyToMany)
      Linkset gone = create(lm2, "Test Cases", "System Requirements")
      delete(gone)`);
    const lm = store.module_at("/Demo/Derives", "link")!;
    assert.equal(store.linksets(lm).length, 1);
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    for (const other of [copy, Store.loads(store.dumps())]) {
      assert.equal(other.linksets(other.module_at("/Demo/Derives", "link")!).length, 1);
    }
    const tests = store.module_at("/Demo/Test Cases")!;
    const verifies = store.module_at("/Demo/Verifies", "link")!;
    assert.equal(store.links(new Obj(tests, 1)).length, 1);
    store.delete_linkset(verifies, tests, reqs(store));
    assert.equal(store.links(new Obj(tests, 1)).length, 0);
  });
});

describe("a default added after the object", () => {
  test("reading it from DXL is refused until the object is given a value", () => {
    const store = demo();
    store.create_attribute(reqs(store), "State", "String", "object", false, "new");
    assert.throws(() => dxl(store, OPEN + 'Object o = object 2\nprint o."State" ""'), /before the attribute/);
    const { printed } = dxl(store, OPEN + 'Object o = object 2\no."State" = ""\nprint "[" o."State" "]"');
    assert.equal(printed, "[]");
  });
});

describe("access rights", () => {
  // demo()'s user is "tester". Give "boss" full rights, everyone else read, then
  // cut tester down to read: the last call is made while tester still has control.
  const RESTRICT = `Module m = edit("${REQS}", false)
    current = m
    string e = specific(m)
    e = e set(m, read | modify | create | delete | control, "tester")
    e = e set(m, read | modify | create | delete | control, "boss")
    e = e set(m, read, null)
    e = e set(m, read, "tester")
    print "[" e "]\\n"
  `;

  test("a restriction stops scripts, the interface and imports, and the records say why", () => {
    const store = demo();
    assert.equal(dxl(store, RESTRICT).printed, "[]\n");
    const out = dxl(store, `Module m = read("${REQS}", false)
      print canModify(m) " " canRead(m) "\\n"
      AccessRec ar
      for ar in m do { if (isDefault(ar)) print "* " control(ar) "\\n" else print username(ar) " " modify(ar) "\\n" }
      bool inh
      string s = isAccessInherited(m, inh)
      print inh "\\n"
    `);
    assert.match(out.printed, /^false true\n/);
    assert.match(out.printed, /tester false\n/);
    assert.match(out.printed, /false\n$/);
    // a script that opened the module for editing before the access was taken away
    const again = demo();
    const refused = dxl(again, RESTRICT + `noError()
      object(2, m)."Object Text" = "changed"
      if (!null lastError()) print "refused\\n"
    `);
    assert.equal(refused.printed, "[]\nrefused\n");
    assert.throws(() => store.set_value(at(store, 2), "Object Text", "x"), /no access/);
    assert.throws(() => store.create_object(reqs(store)), /no access/);
    assert.throws(() => store.delete_object(at(store, 4)), /no access/);
    assert.throws(() => store.create_baseline(reqs(store)), /no access/);
    assert.throws(() => store.create_attribute(reqs(store), "More"), /no access/);
    assert.throws(() => store.make_access_inherited(reqs(store)), /no access/);
    let csv = "";
    export_module(store, reqs(store), { write: (s: string) => { csv += s; } });
    assert.throws(() => import_csv(store, reqs(store), csv.replace("Shall boil.", "Shall boil twice.")), /no access/);
    for (const other of [Store.loads(store.dumps())]) {
      assert.throws(() => other.set_value(at(other, 2), "Object Text", "x"), /no access/);
    }
  });

  test("a name that may be a group the user is in is refused, not guessed", () => {
    const store = demo();
    store.make_access_specific(reqs(store));
    store.set_access(reqs(store), "Engineering", 1);
    assert.equal(store.may(reqs(store), 1), "yes");
    assert.equal(store.may(reqs(store), 2), "unknown");
    assert.throws(() => store.set_value(at(store, 2), "Object Text", "x"), /depends on belonging to 'Engineering'/);
  });

  test("nothing can be hidden, and inherited rights cannot be changed", () => {
    const store = demo();
    assert.throws(() => store.set_access(reqs(store), "tester", 31), /make them specific first/);
    store.make_access_specific(reqs(store));
    assert.throws(() => store.set_access(reqs(store), null, 0), /nothing can be hidden|nobody has control/);
  });
});

describe("access rights in project files", () => {
  test("module and object rights are written, loaded and enforced again", () => {
    const store = demo();
    const { printed } = dxl(store, `Module m = edit("${REQS}", false)
      current = m
      Object o = object(2, m)
      string e = specific(o)
      e = e set(o, read | modify | create | delete | control, "boss")
      e = e set(o, read | control, "tester")
      e = e set(o, read, "temp")
      e = e unset(o, "temp")
      e = e set(o, read, null)
      e = e set(o, read, "tester")
      print "[" e "]" canModify(o) "\\n"
    `);
    assert.equal(printed, "[]false\n");
    const copy = new Store(":memory:", "tester");
    load_project(copy, dump_project(store));
    assert.deepEqual(copy.access_list(at(copy, 2)), store.access_list(at(store, 2)));
    assert.throws(() => copy.set_value(at(copy, 2), "Object Text", "x"), /no access/);
    copy.set_value(at(copy, 3), "Object Text", "still free");
  });
});

describe("access rights: what is not documented stops the script", () => {
  test("set on inherited rights, and edit() without any right to change", () => {
    const store = demo();
    assert.throws(() => dxl(store, `Module m = edit("${REQS}", false)
      string e = set(m, read, "tester")`), /make them specific first/);
    store.make_access_specific(reqs(store));
    store.set_access(reqs(store), "tester", 31);
    store.set_access(reqs(store), "boss", 31);
    store.set_access(reqs(store), null, 1);
    store.set_access(reqs(store), "tester", 1);
    assert.throws(() => dxl(store, `Module m = edit("${REQS}", false)`), /open it with read\(\)/);
    assert.equal(dxl(store, `Module m = read("${REQS}", false)
      string e = specific(m)
      print null e`).printed, "false");
  });
});
