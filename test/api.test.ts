// The operations the page calls, with results as the page receives them.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { VirtualDisk } from "../src/dxl/files.ts";
import { Store } from "../src/store.ts";
import { Api, MAX_OUTPUT, plain } from "../src/web/api.ts";

const SCRIPTS = { names: { "hello.dxl": 'print "hello\\n"\n' }, layout: { "id.dxl": "display(identifier(obj))" } };

let api: Api;
beforeEach(() => {
  api = new Api(new Store(":memory:", "tester"), "work", SCRIPTS, new VirtualDisk());
});

// Through JSON, as the worker sends it.
function call(operation: string, args: Record<string, unknown> = {}): any {
  const result = (api as any)["op_" + operation](args);
  return result === undefined ? null : JSON.parse(JSON.stringify(plain(result)));
}

const refused = (message: RegExp, operation: string, args: Record<string, unknown>) =>
  assert.throws(() => call(operation, args), message);

describe("module window", () => {
  let reqs: number, tests: number, head: number, requirement: number, checking: number;

  const add = (module: number, args: Record<string, unknown> = {}): number =>
    call("add_object", { module, ...args }).absno;
  const rows = (module: number, args: Record<string, unknown> = {}): any[] =>
    call("module", { module, ...args }).rows;
  const row = (module: number, absno: number): any => rows(module).find((r) => r.absno === absno);
  const link = () => call("create_link", {
    source: { module: tests, absno: checking }, target_module: reqs, target: `R-${requirement}` });

  beforeEach(() => {
    const project = call("create_item", { parent: 1, name: "Demo", kind: "project" }).id;
    reqs = call("create_item", { parent: project, name: "Reqs", kind: "formal", prefix: "R-" }).id;
    tests = call("create_item", { parent: project, name: "Tests", kind: "formal", prefix: "T-" }).id;
    head = add(reqs, { values: { "Object Heading": "Power" } });
    requirement = add(reqs, { ref: head, where: "child",
      values: { "Object Text": "<script>alert(1)</script> shall hold." } });
    checking = add(tests, { values: { "Object Text": "Measure it." } });
  });

  test("rows carry number, level, identifier and text as typed", () => {
    assert.deepEqual(rows(reqs).map((r) => r.number), ["1", "1.0-1"]);
    const found = row(reqs, requirement);
    assert.equal(found.level, 2);
    assert.equal(found.id, "R-2");
    assert.ok(found.values["Object Text"].startsWith("<script>"));
  });

  test("enumeration attribute, and edits that are all or nothing", () => {
    call("create_attribute", { module: reqs, name: "Priority", type: "Priority",
      new_type: { base: "Enumeration", values: ["Low", "High"] } });
    call("set_values", { module: reqs, absno: requirement, values: { Priority: "High" } });
    refused(/not one of/, "set_values",
      { module: reqs, absno: requirement, values: { "Object Text": "changed", Priority: "Urgent" } });
    const { values } = row(reqs, requirement);
    assert.equal(values.Priority, "High");
    assert.notEqual(values["Object Text"], "changed");
    // A refused attribute must not leave its new type behind.
    assert.throws(() => call("create_attribute",
      { module: reqs, name: "Priority", type: "Other", new_type: { base: "Enumeration", values: ["x"] } }));
    assert.ok(!call("module", { module: reqs }).types.some((t: any) => t.name === "Other"));
  });

  test("traceability and suspect links", () => {
    link();
    const incoming = row(reqs, requirement).in;
    assert.deepEqual(incoming.map((l: any) => [l.other.id, l.other.text]), [["T-1", "Measure it."]]);
    assert.ok(!incoming[0].source_changed && !incoming[0].target_changed);
    call("set_values", { module: reqs, absno: requirement, values: { "Object Text": "New." } });
    const out = row(tests, checking).out[0];
    assert.deepEqual([out.other.id, out.target_changed], [`R-${requirement}`, true]);
    call("clear_suspect", { source: out.source, link: out.id });
    assert.equal(row(tests, checking).out[0].target_changed, false);
    call("delete_link", { source: out.source, link: out.id });
    assert.deepEqual(row(reqs, requirement).in, []);
  });

  test("links to deleted objects are hidden", () => {
    link();
    call("delete_object", { module: tests, absno: checking });
    assert.deepEqual(row(reqs, requirement).in, []);
  });

  test("a link to an object that is not there is refused", () => {
    refused(/no object/, "create_link",
      { source: { module: tests, absno: checking }, target_module: reqs, target: "R-99" });
  });

  test("move, delete and undelete", () => {
    const other = add(reqs, { ref: head, where: "after", values: { "Object Heading": "Mass" } });
    const order = () => rows(reqs).map((r) => [r.absno, r.level]);
    call("move_object", { module: reqs, absno: other, direction: "up" });
    assert.deepEqual(order(), [[other, 1], [head, 1], [requirement, 2]]);
    call("move_object", { module: reqs, absno: head, direction: "demote" });
    assert.deepEqual(order(), [[other, 1], [head, 2], [requirement, 3]]);
    call("move_object", { module: reqs, absno: head, direction: "promote" });
    assert.deepEqual(order(), [[other, 1], [head, 1], [requirement, 2]]);
    refused(/cannot move/, "move_object", { module: reqs, absno: other, direction: "up" });
    refused(/children/, "delete_object", { module: reqs, absno: head });
    call("delete_object", { module: reqs, absno: requirement });
    assert.ok(!row(reqs, requirement));
    assert.equal(rows(reqs, { show_deleted: true }).find((r) => r.absno === requirement).deleted, true);
    call("undelete_object", { module: reqs, absno: requirement });
    assert.ok(row(reqs, requirement));
  });

  test("a baseline is read-only and comparable, and history is kept", () => {
    link();
    const baseline = call("create_baseline", { module: reqs, annotation: "first" });
    call("set_values", { module: reqs, absno: requirement, values: { "Object Text": "Revised." } });
    const added = add(reqs);
    const frozen = call("module", { module: baseline.id });
    assert.equal(frozen.module.baseline, "0.1");
    assert.match(frozen.rows[1].values["Object Text"], /shall hold/);
    refused(/baseline/, "set_values", { module: baseline.id, absno: requirement, values: { "Object Text": "no" } });
    assert.deepEqual(call("compare", { old: baseline.id, new: reqs }).map((c: any) => [c.id, c.change]),
      [[`R-${requirement}`, "modified"], [`R-${added}`, "added"]]);
    const actions = call("history", { module: reqs, absno: requirement }).map((h: any) => h.action);
    assert.equal(actions[0], "createObject");
    assert.ok(actions.includes("modifyObject"));
  });

  test("saved views", () => {
    const definition = { columns: ["Absolute Number"], filter: null, sort: "ID" };
    call("save_view", { module: reqs, name: "Mine", definition });
    assert.deepEqual(call("module", { module: reqs }).views, { Mine: definition });
    call("delete_view", { module: reqs, name: "Mine" });
    assert.deepEqual(call("module", { module: reqs }).views, {});
  });

  test("a deleted module can be brought back", () => {
    const names = (args: Record<string, unknown> = {}) =>
      call("tree", args).root.children[0].children.map((c: any) => c.name);
    call("delete_item", { id: tests });
    assert.ok(!names().includes("Tests"));
    assert.ok(names({ show_deleted: true }).includes("Tests"));
    call("delete_item", { id: tests, deleted: false });
    assert.ok(names().includes("Tests"));
  });

  test("CSV out and back in; a refused file changes nothing", () => {
    const exported = call("export_csv", { module: reqs });
    assert.equal(exported.filename, "Reqs.csv");
    assert.match(exported.text, /shall hold/);
    const edited = exported.text.replace("shall hold", "shall last");
    assert.equal(call("import_csv", { module: reqs, text: edited }).created, 0);
    assert.match(row(reqs, requirement).values["Object Text"], /shall last/);
    const before = rows(tests);
    refused(/row 2/, "import_csv", { module: tests, text: edited });
    assert.deepEqual(rows(tests), before);
  });
});

describe("DXL column and ReqIF", () => {
  let module: number;
  beforeEach(() => {
    const project = call("create_item", { parent: 1, name: "P", kind: "project" }).id;
    module = call("create_item", { parent: project, name: "M", kind: "formal", prefix: "M-" }).id;
    call("add_object", { module, values: { "Object Text": "one" } });
  });

  test("a DXL column gives one cell per object and changes nothing", () => {
    const reply = call("dxl_column", { module, source: "display(identifier(obj))" });
    assert.deepEqual([reply.error, reply.cells], [null, { "1": "M-1" }]);
    const writing = call("dxl_column", { module, source: 'obj."Object Text" = "changed"' });
    assert.match(writing.error.message, /read-only/);
    assert.equal(call("module", { module }).rows[0].values["Object Text"], "one");
    assert.equal(call("dxl_column", { module, source: "nonsense(" }).error.line, 1);
  });

  test("ReqIF out and back in", () => {
    const exported = call("export_reqif", { modules: [module] });
    assert.equal(exported.filename, "M.reqif");
    assert.match(Buffer.from(exported.base64, "base64").toString("utf8"), /<REQ-IF\b/);
    call("create_item", { parent: 1, name: "In", kind: "folder" });
    const made = call("import_reqif", { folder: "/In", filename: "x.reqif", base64_data: exported.base64 });
    assert.deepEqual([made.modules, made.objects], [["/In/M"], 1]);
    refused(/intact/, "import_reqif", { folder: "/In", filename: "x.reqif", base64_data: "not base64!" });
  });
});

describe("DXL window", () => {
  const dxl = (source: string, args: Record<string, unknown> = {}) => call("run_dxl", { source, ...args });

  test("output, and errors with line numbers before anything runs", () => {
    assert.equal(dxl('print "one\\n"').output, "one\n");
    const reply = dxl('print "a"\nint x = "text"\n');
    assert.equal(reply.error.line, 2);
    assert.equal(reply.output, "");
  });

  test("confirm() follows the checkbox", () => {
    const source = 'if (confirm("go?")) print "yes" else print "no"';
    assert.equal(dxl(source).output, "[confirm] go? -> no\nno");
    assert.equal(dxl(source, { confirm_yes: true }).output, "[confirm] go? -> yes\nyes");
  });

  test("the open module, and trying without saving", () => {
    const module = call("create_item", { parent: 1, name: "M", kind: "formal" }).id;
    const reply = dxl('Module m = current\nObject o = create m\nprint "ok"', { module, dry_run: true });
    assert.equal(reply.error, null);
    assert.equal(reply.output, "ok");
    assert.equal(reply.rolled_back, true);
    assert.deepEqual(call("module", { module }).rows, []);
  });

  test("a script that prints without end is stopped, and the next one still runs", () => {
    const reply = dxl(`while (true) { print "${"0123456789".repeat(100)}" }`);
    assert.match(reply.error.message, /too much output/);
    assert.ok(reply.output.length <= MAX_OUTPUT + 1000);
    assert.equal(dxl('print "still here"').output, "still here");
  });

  test("files a script writes come back with the reply", () => {
    const reply = dxl('Stream s = write "a.csv"\ns << "x,y\\n"\nclose s');
    assert.deepEqual(reply.files, [{ name: "/work/a.csv", text: "x,y\n" }]);
    assert.deepEqual(dxl('print "nothing new"').files, []);
  });

  test("the scripts that come with the page", () => {
    assert.deepEqual(call("scripts").names, ["hello.dxl"]);
    assert.deepEqual(call("scripts").layout, ["id.dxl"]);
    assert.equal(dxl(call("load_script", { name: "hello.dxl" }).source).output, "hello\n");
    assert.equal(call("load_script", { name: "id.dxl", column: true }).source, "display(identifier(obj))");
  });

  test("only a listed script can be loaded", () => {
    for (const name of ["../outside.dxl", "/etc/hosts", "constructor", "id.dxl"]) {
      refused(/no script/, "load_script", { name });
    }
  });
});
