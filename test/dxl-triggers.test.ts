import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { run } from "../src/dxl/index.ts";
import { VirtualDisk } from "../src/dxl/files.ts";
import { dump_project, load_project } from "../src/io/project.ts";
import { Api } from "../src/web/api.ts";

function setup() {
  const store = new Store(":memory:", "ann");
  store.create_project("/", "P");
  const m = store.create_module("/P", "M");
  store.create_attribute(m, "Cost", "Integer");
  const o = store.create_object(m, null, null, null, { "Object Text": "first" });
  const out: string[] = [];
  const dxl = (source: string) => run(source, store, { write: (s: string) => out.push(s) }, "/P/M");
  return { store, m, o, out, dxl };
}

const VETO = 'Trigger t = trigger("limit", module->"M"->attribute->"Cost", pre, modify, 10, '
  + '"Trigger me = current; int v = intOf(value me); if (v > 100) set trigPreConFail else set trigPreConPass")\n';

test("an attribute pre trigger vetoes the person's change and passes a good one", () => {
  const { store, o, dxl } = setup();
  dxl(VETO);
  assert.throws(() => store.by_hand(() => store.set_value(o, "Cost", "500")), /did not allow/);
  assert.equal(store.value(o, "Cost"), "");
  store.by_hand(() => store.set_value(o, "Cost", "5"));
  assert.equal(store.value(o, "Cost"), "5");
});

test("a script or other path reaching a watched attribute stops, even unchanged", () => {
  const { store, o, dxl } = setup();
  dxl(VETO);
  assert.throws(() => dxl('Object o = first current Module\no."Cost" = "5"\n'), /line 2|not documented/);
  assert.throws(() => dxl('noError\nObject o = first current Module\no."Cost" = "5"\nstring e = lastError\n'),
    /not documented/);
  assert.throws(() => store.set_value(o, "Cost", ""), /not documented/);
  dxl('Object o = first current Module\no."Object Text" = "other"\n'); // not watched
});

test("post triggers run after the change, in priority order, and are kept with the database", () => {
  const { store, o, dxl } = setup();
  dxl('trigger("b", attribute->"Cost", post, save, 20, "print \\"second \\"")\n'
    + 'trigger("a", attribute->"Cost", post, save, 10, "Trigger t = current; Object o = object t; '
    + 'print \\"first \\" (o.\\"Cost\\") \\" \\"")\n');
  const again = Store.loads(store.dumps());
  const obj = again.object(o.module_id, o.absno)!;
  again.by_hand(() => again.set_value(obj, "Cost", "7"));
  assert.equal(again.trigger_output.join(""), "first 7 second ");
});

test("a pre trigger that does not say, or equal priorities, are not guessed at", () => {
  const { store, o, dxl } = setup();
  dxl('trigger("quiet", attribute->"Cost", pre, save, 1, "int i = 0")\n');
  assert.throws(() => store.by_hand(() => store.set_value(o, "Cost", "1")), /not documented/);
  dxl('delete("quiet", attribute->"Cost", pre, save, 1)\n'
    + 'trigger("x", attribute->"Cost", post, save, 1, "int i = 0")\n'
    + 'trigger("y", attribute->"Cost", post, save, 1, "int i = 0")\n');
  // post triggers: the change has happened, so it stands; neither is run, and why is said
  store.by_hand(() => store.set_value(o, "Cost", "1"));
  assert.match(store.trigger_output.join(""), /same priority/);
  assert.equal(store.value(o, "Cost"), "1");
});

test("module open triggers: project and database wide; a script open stops", () => {
  const { store, m, out, dxl } = setup();
  dxl('trigger("hello", project->all->module->all, post, open, 5, "Trigger t = current; '
    + 'print \\"opened \\" name(module t)")\n');
  store.user_event("module", "open", m, null, () => {});
  assert.equal(store.trigger_output.join(""), "opened M");
  store.create_module("/P", "N");
  assert.throws(() => dxl('Module n = read("/P/N")\n'), /not documented/);
  dxl("Trigger t\nfor t in database do { print name(t) \" \" stringOf(level t) \" \" stringOf(event t) }\n"
    + "for t in database do delete t\n");
  assert.equal(out.join(""), "hello module open");
  dxl('Module n = read("/P/N")\n');
});

test("object sync triggers can refuse the person's move; a script's current = stops", () => {
  const { store, m, o, dxl } = setup();
  dxl('trigger("stay", object, pre, sync, 1, "set trigPreConFail")\n');
  let moved = false;
  assert.throws(() => store.user_event("object", "sync", m, o.absno, () => { moved = true; }), /did not allow/);
  assert.equal(moved, false);
  assert.throws(() => dxl("current = first current Module\n"), /not documented/);
});

test("kinds nothing here would ever fire are refused when defined", () => {
  const { dxl } = setup();
  for (const [level, event] of [["module", "close"], ["object", "open"], ["object", "drag"], ["project", "open"],
    ["module", "save"], ["attribute", "open"]]) {
    assert.throws(() => dxl(`trigger("n", ${level}, pre, ${event}, 1, "int i = 0")\n`),
      /not offered|not supported|current project/, `${level} ${event}`);
  }
  assert.throws(() => dxl('trigger("n", attribute, pre, save, 1, "no such thing")\n'), /not offered/);
});

test("renaming a watched attribute stops", () => {
  const { store, m, dxl } = setup();
  dxl(VETO);
  assert.throws(() => store.modify_attribute(m, "Cost", { name: "Price" }), /not offered/);
});

test("the interface's own edits fire triggers; project files keep them", async () => {
  const { store, o, m, dxl } = setup();
  dxl(VETO + 'trigger("said", attribute->"Cost", post, save, 1, "print \\"saved\\"")\n');
  const api = new Api(store, "t", [], new VirtualDisk());
  assert.throws(() => api.op_set_values({ module: m, absno: o.absno, values: { Cost: "900" } }), /did not allow/);
  api.op_set_values({ module: m, absno: o.absno, values: { Cost: "9" } });
  assert.equal(api.op_trigger_output().text, "saved");
  assert.equal(api.op_module({ module: m }).watched.open, false);

  const text = dump_project(store);
  const again = new Store(":memory:", "ann");
  load_project(again, text);
  assert.deepEqual(again.trigger_holders().flatMap((at) => again.own_triggers(at).map((t) => t.row.name)),
    ["limit", "said"]);
});

test("database and project wide triggers survive a project file", () => {
  const { store, dxl } = setup();
  dxl('trigger("all", project->all->module->all, post, open, 1, "int i = 0")\n'
    + 'trigger("here", module->all->formal->object->all, pre, sync, 2, "set trigPreConPass")\n');
  const again = new Store(":memory:", "ann");
  load_project(again, dump_project(store));
  assert.deepEqual(again.trigger_holders().map((at) => again.path(at)).sort(), ["/", "/P"]);
});

test("a failing or clashing post trigger never keeps a module shut, and can be removed without DXL", () => {
  const { store, m, dxl } = setup();
  dxl('trigger("bad", project->all->module->all, post, open, 1, "int x = 1 / 0")\n');
  const api = new Api(store, "t", [], new VirtualDisk());
  api.op_user_event({ module: m });
  assert.match(api.op_trigger_output().text, /'bad' could not run here: .*division by zero/);
  dxl('trigger("twin", project->all->module->all, post, open, 1, "int i = 0")\n');
  api.op_user_event({ module: m });
  assert.match(api.op_trigger_output().text, /same priority/);
  for (let left = api.op_triggers().triggers; left.length; left = api.op_triggers().triggers) {
    api.op_remove_trigger(left[0]);
  }
  api.op_user_event({ module: m });
  assert.equal(api.op_trigger_output().text, "");
});

test("a failing pre-open trigger stops the opening, and its removal lets it open", () => {
  const { store, m, dxl } = setup();
  dxl('trigger("shut", project->all->module->all, pre, open, 1, "int x = 1 / 0")\n');
  const api = new Api(store, "t", [], new VirtualDisk());
  assert.throws(() => api.op_user_event({ module: m }), /'shut' could not run here/);
  api.op_remove_trigger(api.op_triggers().triggers[0]);
  api.op_user_event({ module: m });
});

test("the database manager's reset gives back an attribute locked to someone else", () => {
  const { store, m, o } = setup();
  const others = [{ name: "bob", rights: 31 }, { name: null, rights: 1 }];
  store.change_attribute_access(m, "Cost", "values", () => others);
  assert.throws(() => store.set_value(o, "Cost", "1"), /access/);
  new Api(store, "t", [], new VirtualDisk()).op_change_access({ item: m, action: "reset" });
  store.set_value(o, "Cost", "1");
  assert.equal(store.value(o, "Cost"), "1");
});
