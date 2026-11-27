import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, RIGHTS } from "../src/store.ts";
import { run } from "../src/dxl/index.ts";
import { dump_project, load_project } from "../src/io/project.ts";

function setup() {
  const store = new Store(":memory:", "ann");
  store.create_project("/", "P");
  const m = store.create_module("/P", "M");
  const out: string[] = [];
  const dxl = (source: string) => run(source, store, { write: (s: string) => out.push(s) }, "/P/M");
  return { store, m, out, dxl };
}

const MADE = 'addUser("ann", "a1")\naddUser("bob", "b1")\naddGroup("eng")\nsaveDirectory()\n'
  + 'Group g = find("eng")\nUser u = find("ann")\naddMember(g, u)\nsaveDirectory()\n';

test("users and groups are made, listed, and kept", () => {
  const { store, out, dxl } = setup();
  dxl(MADE + 'User x\nfor x in userList do print x.name " "\nGroup h\nfor h in groupList do print h.name " "\n'
    + 'for x in g do print "in:" x.name " "\nprint member(g, find("bob")) ""\n');
  assert.equal(out.join(""), "ann bob eng in:ann false");
  assert.deepEqual(Store.loads(store.dumps()).directory, store.directory);
  const again = new Store(":memory:", "ann");
  load_project(again, dump_project(store));
  assert.deepEqual(again.directory, store.directory);
});

test("a question an unsaved change would alter stops", () => {
  const { dxl } = setup();
  assert.throws(() => dxl('addGroup("eng")\nbool b = existsGroup("eng")\n'), /not documented/);
  assert.throws(() => dxl('Group g = find("nobody")\n'), /no group/);
});

test("group membership settles what access checks could not", () => {
  const { store, m, dxl } = setup();
  const o = store.create_object(m);
  dxl(MADE);
  store.make_access_specific(m);
  store.set_access(m, "ann", 31);
  store.set_access(m, "eng", RIGHTS.control);
  store.set_access(m, null, RIGHTS.read);
  store.unset_access(m, "ann");
  assert.equal(store.may(m, RIGHTS.modify), "yes"); // through eng
  store.set_value(o, "Object Text", "x");
  dxl('Group g = find("eng")\ndeleteAllMembers(g)\nsaveDirectory()\n');
  assert.equal(store.may(m, RIGHTS.modify), "no");
  assert.throws(() => store.set_value(o, "Object Text", "y"), /no access/);
});

test("a change of groups that would hide something is refused", () => {
  const { store, m, dxl } = setup();
  dxl(MADE);
  store.make_access_specific(m);
  store.set_access(m, "eng", 31);
  store.set_access(m, null, 0);
  assert.equal(store.may(m, RIGHTS.read), "yes");
  assert.throws(() => dxl('Group g = find("eng")\ndeleteAllMembers(g)\nsaveDirectory()\n'), /not supported/);
});

const LIMITED = 'Module m = current\nAttrDef ad = find(m, "Cost")\n';
// someone else keeps control; the current user is left with read
const readOnly = (call: string, args: string) => `print ${call}(${args}read|control, "bob")\n`
  + `print ${call}(${args}read, null)\n`;

test("attribute value and definition access are enforced and kept", () => {
  const { store, m, dxl, out } = setup();
  dxl(MADE);
  store.create_attribute(m, "Cost", "Integer");
  const o = store.create_object(m);
  dxl(LIMITED + "print specificVal(m, ad)\n" + readOnly("setVal", "m, ad, ") + 'print unsetVal(m, ad, "bob")\n'
    + "print specificDef(m, ad)\n" + readOnly("setDef", "m, ad, ") + 'print canDeleteDef(ad) ""\n');
  // with read alone the user no longer controls the values' list
  assert.equal(out.join(""), "no access: changing access rights needs control access to 'Cost'false");
  assert.throws(() => store.set_value(o, "Cost", "1"), /no access/);
  assert.throws(() => store.delete_attribute(m, "Cost"), /no access/);
  store.set_value(o, "Object Text", "free");
  const again = new Store(":memory:", "ann");
  load_project(again, dump_project(store));
  assert.equal(again.attribute_access(again.find("/P/M")!, "Cost", "values").inherited, false);
});

test("view access is enforced, kept through a save, and can be undone", () => {
  const { store, m, dxl, out } = setup();
  dxl(MADE);
  store.save_view(m, "V", { columns: [] });
  dxl('View v = view "V"\nprint specific(v)\n' + readOnly("set", "v, ")
    + 'AccessRec a\nint n = 0\nfor a in v do n++\nprint n "" canModify(module "/P/M", v) ""\n');
  assert.match(out.join(""), /^\d+false$/);
  assert.throws(() => store.save_view(m, "V", { columns: [] }), /no access/);
  assert.throws(() => store.delete_view(m, "V"), /no access/);
  assert.equal(Store.loads(store.dumps())._guarded, true);
});

test("view definition settings beyond the three can be set, and only off is saved", () => {
  const { store, dxl, out } = setup();
  const made = 'Module m = current\nViewDef d = create(m, false)\nuseColumns(d, true)\n';
  assert.throws(() => dxl(made + 'useOutlining(d, true)\nsave(view "V", d)\n'), /cannot be kept/);
  dxl(made + 'useOutlining(d, false)\nprint useOutlining(d) ""\n');
  assert.equal(out.join(""), "false");
  assert.throws(() => dxl(made + "print useCompression(d)\n"), /not documented/);
});

test("openProject and closeProject move the current folder; isValidName reads both ways", () => {
  const { dxl, out } = setup();
  dxl('print openProject("/P") ""\nProject p = current\nprint name(p) " "\ncloseProject\n'
    + 'Folder f = current\nprint "[" fullName(f) "] "\n'
    + 'char c = isValidName("a*b")\nbool ok = isValidName("Plain name")\nprint c " " ok ""\n');
  assert.equal(out.join(""), "P [/] * true");
});
