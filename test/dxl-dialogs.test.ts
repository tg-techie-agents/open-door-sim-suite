// Dialog boxes: what show() and block() do to a script, callbacks run one event
// at a time, what is refused, and the shipped dialog report. The page that draws
// the boxes needs a real browser and is not covered here.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError, VirtualDisk, layout, run } from "../src/dxl/index.ts";
import type { DialogSession } from "../src/dxl/index.ts";
import { Api } from "../src/web/api.ts";
import { REQS, csv_rows, demo, dxl, example, read_file } from "./helpers.ts";

type Opened = {
  session: DialogSession;
  spec: () => any;
  printed: () => string;
  disk: VirtualDisk;
  /** Press, choose or close: `label` names a button or element; `set` is what the person typed or picked first. */
  act: (label: string | null, kind?: string, options?: { set?: Record<string, any>; row?: number; yes?: boolean }) => any;
};

/** Run a script whose boxes somebody can use. */
function open(source: string, { store = demo(), dry_run = false } = {}): Opened {
  let printed = "";
  const out = { write: (s: string) => { printed += s; } };
  const disk = new VirtualDisk();
  const result = run(source, store, out, null, ".", null, dry_run, false, disk, Date.now() + 20000, [], null,
    { interactive: true });
  const session = result.dialogs!;
  assert.ok(session, "no dialog box was left open: " + printed);
  let last = session.spec();
  const all = () => last.boxes.flatMap((b: any) => [...b.elements, ...b.buttons].map((e: any) => ({ ...e, box: b.id })));
  const find = (label: string) => {
    const found = all().find((e: any) => e.label === label);
    assert.ok(found, `nothing labelled ${label}`);
    return found;
  };
  return {
    session, disk, spec: () => last, printed: () => printed,
    act(label, kind = "press", { set = {}, row, yes = false } = {}) {
      const values = Object.entries(set).map(([name, value]) => ({ id: find(name).id, ...value }));
      const target = label === null ? null : find(label);
      session.dispatch({ box: target?.box ?? last.boxes[0].id, kind: kind as any, element: target?.id, row, values },
        { out, ask: () => yes, deadline: Date.now() + 20000 });
      last = session.spec();
      return last;
    },
  };
}

const element = (spec: any, label: string) =>
  spec.boxes.flatMap((b: any) => b.elements).find((e: any) => e.label === label);

function refused(source: string, wanted: RegExp, line?: number): void {
  assert.throws(() => dxl(demo(), source), (e: any) => {
    assert.ok(e instanceof DxlError, String(e));
    assert.match(e.message, wanted);
    if (line !== undefined) assert.equal(e.line, line);
    return true;
  }, source);
}

const FORM = `
DB box = create("Form", styleCentered|styleFixed)
string colours[] = {"red", "green", "blue"}
DBE name = field(box, "Name", "kettle", 20)
DBE notes = text(box, "Notes", "", 80, false)
DBE deep = toggle(box, "Deep", false)
DBE way = radioBox(box, "Way", colours, 0)
DBE marks = checkBox(box, "Marks", colours, 5)
DBE one = choice(box, "One", colours, 1)
DBE many = multiList(box, "Many", 3, colours)
DBE seen = field(box, "Seen", "", 40, true)
void go(DB b) {
  string n = get(name)
  string t = get(notes)
  bool d = get(deep)
  int w = get(way)
  int m = get(marks)
  string c = get(one)
  int ci = get(one)
  print n "|" t "|" d "|" w "|" m "|" c "|" ci "|"
  string s
  for s in many do print s ";"
  int i
  for i in many do print i ""
  print "\\n"
  set(seen, n " seen")
}
apply(box, "Go", go)
show box
`;

describe("dialog boxes", () => {
  test("without anybody to use it a box is drawn as text and the script ends there", () => {
    const { printed } = dxl(demo(), 'print "before\\n"\n' + FORM);
    assert.match(printed, /^before\n\+-- dialog box: Form/);
    assert.match(printed, /Name: \[kettle\]/);
    assert.match(printed, /<Go> <Close>\n\(Drawn as text only/);
  });

  test("callbacks see what the person typed and picked, and keep the script's variables", () => {
    const o = open(FORM);
    o.act("Go");
    assert.equal(o.printed(), "kettle||false|0|5|green|1|\n");
    const spec = o.act("Go", "press", { set: {
      Name: { text: "pump" }, Notes: { text: "two\nlines" }, Deep: { on: true }, Way: { selected: [2] },
      Marks: { selected: [1] }, One: { selected: [2] }, Many: { selected: [0, 2] },
    } });
    assert.ok(o.printed().endsWith("pump|two\nlines|true|2|2|blue|2|red;blue;02\n"), o.printed());
    assert.equal(element(spec, "Seen").text, "pump seen");
    assert.equal(spec.open, true);
  });

  test("a read-only or inactive element ignores what the page sends", () => {
    const o = open(`
DB box = create "b"
DBE fixed = field(box, "Fixed", "a", 5, true)
DBE grey = field(box, "Grey", "b", 5)
inactive grey
void go(DB b) {
  string x = get(fixed)
  string y = get(grey)
  print x y
}
apply(box, "Go", go)
show box`);
    o.act("Go", "press", { set: { Fixed: { text: "z" }, Grey: { text: "z" } } });
    assert.equal(o.printed(), "ab");
  });

  test("selection callbacks, element callbacks and getParent", () => {
    const o = open(`
DB box = create "b"
string items[] = {"one", "two"}
DBE pick = list(box, "Pick", 4, items)
DBE name = field(box, "Name", "", 10)
void chosen(DBE l) {
  string s = get(l)
  print "chose " s "\\n"
}
void twice(DBE l) {
  int i = get(l)
  print "activated " i "\\n"
}
void entered(DBE f) {
  string s = get(f)
  print "entered " s "\\n"
}
void titled(DBE b) { setTitle(getParent(b), "renamed") }
set(pick, chosen, twice)
set(name, entered)
button(box, "Title", titled)
show box`);
    o.act("Pick", "select", { set: { Pick: { selected: [1] } } });
    o.act("Pick", "activate");
    o.act("Name", "select", { set: { Name: { text: "x" } } });
    assert.equal(o.printed(), "chose two\nactivated 1\nentered x\n");
    assert.equal(o.act("Title").boxes[0].title, "renamed");
  });

  test("ok() runs its callback and takes the box away, which ends the script and closes its files", () => {
    const o = open(`
DB box = create "b"
Stream out = write "kept.txt"
out << "opened\\n"
void done(DB b) { out << "done\\n" }
ok(box, done)
show box`);
    const spec = o.act("OK");
    assert.deepEqual([spec.open, spec.boxes.length, o.session.ended], [false, 0, true]);
    assert.equal(o.disk.get(`${o.disk.cwd}/kept.txt`), "opened\ndone\n");
  });

  test("close() can replace what closing does; Close alone just closes", () => {
    const o = open(`
DB box = create "b"
int asked = 0
void leaving(DB b) {
  asked++
  if (asked > 1) hide b else print "not yet\\n"
}
close(box, true, leaving)
show box`);
    assert.equal(o.act(null, "close").open, true);
    assert.equal(o.act(null, "close").open, false);
    assert.equal(o.printed(), "not yet\n");
    assert.equal(open('DB b = create "b"\nshow b').act(null, "close").open, false);
  });

  test("after block() the rest of the script waits for release or close", () => {
    const source = `
DB box = create "b"
DBE name = field(box, "Name", "", 10)
void go(DB b) {
  print "go "
  release b
}
apply(box, "Go", go)
print "before "
block box
string s = get(name)
print "after " s
destroy box`;
    const released = open(source);
    assert.equal(released.printed(), "before ");
    assert.equal(released.act("Go", "press", { set: { Name: { text: "n" } } }).open, false);
    assert.equal(released.printed(), "before go after n");
    const closed = open(source);
    closed.act(null, "close");
    assert.equal(closed.printed(), "before after ");
    assert.match(dxl(demo(), source).printed, /block\(\): the rest of the script runs only after/);
    assert.doesNotMatch(dxl(demo(), source).printed, /after n/);
  });

  test("a second block() after the first shows the second box", () => {
    const o = open(`
DB a = create "a"
DB b = create "b"
block a
print "one "
block b
print "two"`);
    assert.equal(o.act(null, "close").boxes[0].title, "b");
    assert.equal(o.act(null, "close").open, false);
    assert.equal(o.printed(), "one two");
  });

  test("a list view with columns, rows, check boxes and its callback", () => {
    const o = open(`
DB box = create "b"
string rows[] = {"SYS-1", "SYS-2"}
DBE view = listView(box, listViewOptionCheckboxes, 300, 5, rows)
void ticked(DBE v, int i) {
  bool on = getCheck(v, i)
  string id = getColumnValue(v, i, 0)
  print id " " on "\\n"
}
set(view, ticked)
void report(DB b)
apply(box, "Report", report)
realize box
insertColumn(view, 0, "ID", 80, iconNone)
insertColumn(view, 1, "Text", 200, iconNone)
set(view, 0, 1, "boils")
insert(view, 2, "SYS-3", iconNone)
setCheck(view, 2, true)
void report(DB b) {
  int i
  for i in view do print "row " i " "
  string s = getColumnValue(view, 0, 1)
  int n = noElems(view)
  print s " " n "\\n"
  delete(view, 0)
}
show box`);
    const list = o.spec().boxes[0].elements[0];
    assert.deepEqual(list.rows.map((r: any) => [r.cells.join("/"), r.checked]),
      [["SYS-1/boils", false], ["SYS-2", false], ["SYS-3", true]]);
    const id = list.id;
    o.session.dispatch({ box: o.spec().boxes[0].id, kind: "check", element: id, row: 1,
      values: [{ id, checked: [1, 2], selected: [] }] }, { out: { write: (s) => assert.equal(s.trim() !== "", true) } });
    o.act("Report", "press", { set: {} });
    assert.equal(o.printed(), "boils 3\n");
    assert.equal(o.spec().boxes[0].elements[0].rows.length, 2);
  });

  test("messages and confirm() come with the reply; confirm follows the host's answer", () => {
    const o = open(`
DB box = create "b"
void go(DB b) {
  if (confirm(b, "sure?")) ack(b, "yes") else warningBox "no"
}
apply(box, "Go", go)
show box`);
    assert.deepEqual(o.act("Go").messages.map((m: any) => [m.kind, m.text]), [["confirm", "sure? -> no"], ["warning", "no"]]);
    assert.deepEqual(o.act("Go", "press", { yes: true }).messages.map((m: any) => m.kind), ["confirm", "ack"]);
    assert.deepEqual(o.act("Go", "close").messages, []);
  });

  test("halt and errors in a callback leave the box open", () => {
    const o = open(`
DB box = create "b"
void stop(DB b) {
  print "a"
  halt
}
void broken(DB b) {
  int zero = 0
  print (1 / zero) ""
}
apply(box, "Stop", stop)
apply(box, "Broken", broken)
show box`);
    assert.equal(o.act("Stop").open, true);
    assert.throws(() => o.act("Broken"), (e: any) => e instanceof DxlError && e.line === 9 && /division by zero/.test(e.message));
    assert.equal(o.session.open, true);
    o.act("Stop");
    assert.equal(o.printed(), "aa");
  });

  test("a dry run undoes what each callback changes", () => {
    const store = demo();
    const o = open(`
Module m = edit("${REQS}", false)
DB box = create "b"
void add(DB b) {
  create(m)
  print "added "
}
apply(box, "Add", add)
show box`, { store, dry_run: true });
    const before = store.objects(store.module_at(REQS)!).length;
    o.act("Add");
    assert.equal(store.objects(store.module_at(REQS)!).length, before);
  });

  test("a progress bar reaches the host and is gone at the end", () => {
    const seen: any[] = [];
    run(`
progressStart(null, "Working", "start", 3)
progressStep 1
progressMessage "more"
bool c = progressCancelled()
progressRange("last", 3, 3)
progressStop`, demo(), { write: () => {} }, null, ".", null, false, false, null, null, [], null,
      { interactive: true, progress: (p) => seen.push(p && p.message) });
    assert.equal(seen[0], "start");
    assert.equal(seen[seen.length - 1], null);
    refused("progressStep 1", /call progressStart first/);
    refused('progressStart(null, "t", "m", 2)\nprogressStep 3', /outside 0 to 2/, 2);
  });

  test("what would not mean the same in DOORS is refused by name and line", () => {
    const BOX = 'DB b = create "b"\n';
    refused(BOX + 'show b\nprint "never"', /nothing may follow show/, 3);
    refused(BOX + "void f() {\n  show b\n  print 1\n}", /nothing may follow show/, 4);
    refused(BOX + "if (true) block b", /only offered as a statement of the script's top level/, 2);
    refused(BOX + "void f() {\n  block b\n}", /top level/, 3);
    refused(BOX + "{\n  block b\n}", /top level/, 3);
    refused(BOX + "DBE t = toolBar(b)", /toolBar belongs to/, 2);
    refused(BOX + "DBE h = htmlView(b, 1, 1)", /htmlView/, 2);
    refused(BOX + 'DBE f = fileName(b, "x.csv")', /incorrect arguments for function fileName/, 2);
    refused(BOX + "void f(DBE x) {}\nok(b, f)", /incorrect arguments for function ok \(DB, a function\)/, 3);
    refused(BOX + 'button(b, "x", 3)', /incorrect arguments for function button/, 2);
    refused(BOX + 'release b', /was not displayed with block/, 2);
    refused(BOX + 'DBE f = field(b, "f", "", 5)\nint i = get(f)', /not supported for a field/, 3);
    refused(BOX + 'realize b\nlabel(b, "late")', /before the dialog box is realized/, 3);
    refused(BOX + 'string a[] = {}\nDBE v = listView(b, 0, 100, 3, a)\ninsertColumn(v, 0, "c", 50, iconNone)',
      /realize the dialog box before/, 4);
    refused(BOX + 'string a[] = {"x", "y"}\nDBE m = multiList(b, "m", 3, a)\nset(m, 0, true)\nset(m, 1)',
      /not verified/, 5);
    refused(BOX + 'string a[] = {"x"}\nDBE c = choice(b, "c", a, 0)\nset(c, a)\nstring s = get(c)', /not verified/, 5);
    refused(BOX + 'string a[3]\na[0] = "x"\nDBE c = choice(b, "c", a, 0)', /array element 1 has no value/, 4);
    refused(BOX + 'destroy b\nlabel(b, "x")', /destroyed/, 3);
  });

  test("destroy is refused in an element's callback", () => {
    const o = open('DB box = create "b"\nvoid f(DBE x) {\n  destroy box\n}\nbutton(box, "Go", f)\nshow box');
    assert.throws(() => o.act("Go"), /destroy must not be used within an element's callback/);
  });

  test("a layout column cannot open a box", () => {
    const store = demo();
    assert.throws(() => layout('DB b = create "b"\nshow b', store, store.module_at(REQS)!),
      /cannot be used in layout or attribute DXL/);
  });

  test("placement is accepted", () => {
    const o = open(`
DB box = create "b"
DBE a = field(box, "A", "", 5)
beside box
DBE b = field(box, "B", "", 5)
left box
full box
DBE c = field(box, "C", "", 5)
DBE d = field(box, "D", "", 5)
d->"left"->"flush"->a
d->"top"->"form"
leftAligned box
right box
opposite box
below box
show box`);
    assert.deepEqual(o.spec().boxes[0].elements.map((e: any) => [e.label, e.place, e.full]),
      [["A", "below", false], ["D", "beside", true], ["B", "beside", false], ["C", "below", true]]);
  });
});

describe("dialog boxes behind the browser interface", () => {
  const api = () => new Api(demo(), "demo", { names: {}, layout: {} }, new VirtualDisk());

  test("the run returns the box, an event runs the callback, and a stale event does nothing", () => {
    const a = api();
    const source = 'DB box = create "b"\nvoid go(DB b) {\n  Stream s = write "x.csv"\n  s << "1\\n"\n  close s\n'
      + '  print "ran"\n}\nok(box, "Write", go)\nshow box';
    const first = a.op_run_dxl({ source });
    assert.equal(first.error, null);
    const box = first.dialogs.boxes[0];
    const event = { box: box.id, kind: "press" as const, element: box.buttons[0].id, values: [] };
    const reply = a.op_dxl_event({ session: first.dialogs.session, event });
    assert.deepEqual([reply.error, reply.output, reply.dialogs.open], [null, "ran", false]);
    assert.deepEqual(reply.files.map((f: any) => f.text), ["1\n"]);
    assert.equal(a.op_dxl_event({ session: first.dialogs.session, event }).output, "");
    assert.equal(JSON.parse(JSON.stringify(first.dialogs)).open, true);
  });

  test("a new run closes the boxes of the one before", () => {
    const a = api();
    const first = a.op_run_dxl({ source: 'DB b = create "b"\nshow b' });
    const old = a.dialogs!;
    assert.equal(a.op_run_dxl({ source: 'print "next"' }).dialogs, null);
    assert.equal(old.ended, true);
    assert.equal(a.op_dxl_event({ session: first.dialogs.session, event: { box: 0, kind: "close" } }).dialogs.open, false);
  });

  test("an error in a callback comes back with its line and the box stays", () => {
    const a = api();
    const first = a.op_run_dxl({ source: 'DB box = create "b"\nvoid f(DB b) {\n  Object o\n  print o."x" ""\n}\n'
      + 'apply(box, f)\nshow box' });
    const box = first.dialogs.boxes[0];
    const reply = a.op_dxl_event({ session: first.dialogs.session,
      event: { box: box.id, kind: "press", element: box.buttons[0].id } });
    assert.equal(reply.error.line, 4);
    assert.equal(reply.dialogs.open, true);
  });
});

describe("dialog_trace.dxl", () => {
  test("on the command line it draws its box", () => {
    const { printed } = dxl(example(), read_file("scripts/dialog_trace.dxl"));
    assert.match(printed, /dialog box: Traceability report/);
    assert.match(printed, /System Requirements/);
  });

  test("it writes a report for the chosen module and sums it up", () => {
    const o = open(read_file("scripts/dialog_trace.dxl"), { store: example() });
    const names = element(o.spec(), "Requirement modules:").rows.map((r: any) => r.cells[0]);
    assert.ok(o.act("Write report").messages.some((m: any) => /Choose at least one/.test(m.text)));
    const spec = o.act("Write report", "press",
      { set: { "Requirement modules:": { selected: [names.indexOf("System Requirements")] } } });
    // the same module and link module as trace_report.dxl: 15 requirements, 4 with no link
    assert.match(o.printed(), /Requirements: 15, with no link: 4\. Written to dialog_trace\.csv/);
    const rows = csv_rows(o.disk.get(`${o.disk.cwd}/dialog_trace.csv`)!).slice(1);
    assert.equal(rows.filter((r) => r[3] === "No link").length, 4);
    assert.equal(new Set(rows.map((r) => r[1])).size, 15);
    assert.deepEqual(spec.boxes[0].elements.find((e: any) => e.kind === "listView").rows.map((r: any) => r.cells),
      [["System Requirements", "15", "4"]]);
    o.act("Select all modules");
    assert.ok(element(o.spec(), "Requirement modules:").rows.every((r: any) => r.selected));
  });
});

test("the page code for dialog boxes never parses text as markup", () => {
  const script = read_file("src/web/dialogs.ts");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
    assert.ok(!script.includes(sink), sink);
  }
});
