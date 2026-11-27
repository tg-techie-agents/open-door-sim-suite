// Frames, tabs, splitters, tree views, sliders, status bars, menus and
// canvases: what the engine holds, tells the page and takes back from it. The
// drawing on the page needs a real browser and is not covered here.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError, run } from "../src/dxl/index.ts";
import type { DialogSession } from "../src/dxl/index.ts";
import { demo, dxl } from "./helpers.ts";

function open(source: string) {
  let printed = "";
  const out = { write: (s: string) => { printed += s; } };
  const result = run(source, demo(), out, null, ".", null, false, false, undefined, Date.now() + 20000, [], null,
    { interactive: true });
  const session: DialogSession = result.dialogs!;
  assert.ok(session, "no dialog box was left open: " + printed);
  let last = session.spec();
  const all = () => [...last.boxes[0].elements, ...last.boxes[0].buttons];
  const of = (kind: string) => {
    const found = all().find((e: any) => e.kind === kind);
    assert.ok(found, `no ${kind}`);
    return found;
  };
  return {
    of, spec: () => last, printed: () => printed,
    send(kind: string, element: string, more: any = {}) {
      session.dispatch({ box: last.boxes[0].id, kind: kind as any, element: of(element).id, ...more },
        { out, ask: () => false, deadline: Date.now() + 20000 });
      return (last = session.spec());
    },
    value(element: string, value: any) { return { values: [{ id: of(element).id, ...value }] }; },
  };
}

function refused(source: string, wanted: RegExp, line?: number): void {
  assert.throws(() => dxl(demo(), source), (e: any) => {
    assert.ok(e instanceof DxlError, String(e));
    assert.match(e.message, wanted);
    if (line !== undefined) assert.equal(e.line, line);
    return true;
  }, source);
}

const BOX = 'DB b = create "t"\n';

describe("frames, tabs and splitters", () => {
  const SOURCE = `
DB box = create("Tabs")
string names[] = {"One", "Two"}
DBE first, second
void turned(DBE t) {
  int i = get t
  string s = get t
  print i " " s "\\n"
  if (i == 0) { show first; hide second } else { hide first; show second }
}
DBE strip = tab(box, names, 300, 200, turned)
first = frame(box, "First", 100, 50)
first->"left"->"inside"->strip
second = frame(box, "Second")
second->"top"->"inside"->strip
DBE deep = toggle(box, "Deep", false)
deep->"top"->"inside"->first
DBE under = field(box, "Under", "", 10)
under->"top"->"spaced"->deep
hide second
void go(DB b) { set(strip, "Two"); turned strip; print noElems(strip) "\\n" }
apply(box, "Go", go)
show box
`;

  test("elements placed inside go with their container, and so do those placed against them", () => {
    const o = open(SOURCE);
    const [strip, first, second, deep, under] = o.spec().boxes[0].elements;
    assert.equal(first.parent, strip.id);
    assert.equal(second.parent, strip.id);
    assert.equal(deep.parent, first.id);
    assert.equal(under.parent, first.id);
    assert.equal(strip.parent, undefined);
    assert.equal(second.hidden, true);
  });

  test("choosing a tab runs its callback; set() changes it without running it", () => {
    const o = open(SOURCE);
    o.send("select", "tab", o.value("tab", { selected: [1] }));
    assert.equal(o.printed(), "1 Two\n");
    assert.equal(o.spec().boxes[0].elements[1].hidden, true);
    o.send("press", "button");
    assert.match(o.printed(), /1 Two\n2\n$/);
  });

  test("what is inside a hidden frame takes nothing from the page", () => {
    const o = open(SOURCE.replace("hide second\n", "hide first\n"));
    o.send("press", "button", o.value("toggle", { on: true }));
    assert.equal(o.of("toggle").on, false);
  });

  test("a splitter stands between two views", () => {
    const o = open(`${BOX}string a[] = {"x"}\nDBE t = treeView(b, 0, 100, 5)\nDBE v = listView(b, 0, 100, 5, a)
DBE s = splitter(b, t, v, 4)\nshow b`);
    assert.deepEqual(o.of("splitter").pair, [o.of("treeView").id, o.of("listView").id]);
  });

  test("what a container cannot be or hold is refused", () => {
    refused(BOX + 'DBE a = toggle(b, "a", false)\nDBE c = toggle(b, "c", false)\nc->"top"->"inside"->a', /only a frame or a tab/, 4);
    refused(BOX + 'DBE f = frame(b, "f")\nDBE g = frame(b, "g")\ng->"top"->"inside"->f\nf->"top"->"inside"->g', /inside itself/, 5);
    refused(BOX + 'DBE f = frame(b, "f")\ninactive f', /not verified/, 3);
    refused(BOX + 'DBE f = frame(b, "f")\nstring s = get f', /not supported for a frame/, 3);
    refused(BOX + 'DBE t = toggle(b, "a", false)\nDBE s = splitter(b, t, t, 4)', /not supported for a toggle/, 3);
  });
});

const TREE = `
DB box = create("Tree")
DBE tree = treeView(box, 0, 200, 10)
DBE out = field(box, "Out", "", 20)
void chose(DBE t) { string s = get t; set(out, s) }
void twice(DBE t) { string s = get t; print "open " s "\\n" }
bool grow(DBE t, string path) {
  if (path == "Shut") return false
  if (!exists(t, path "/late")) insert(t, path "/late", iconNone, iconNone)
  return true
}
set(tree, chose, twice)
set(tree, grow)
insert(tree, "Top", iconFolder, iconFolderOpen)
insert(tree, "Top/a", iconNone, iconNone)
insert(tree, "Shut", iconNone, iconNone)
insert(tree, "Shut/b", iconNone, iconNone)
void go(DB x) {
  print exists(tree, "Top/a") " " exists(tree, "Top/z") " " selected(tree, "Top/a") "\\n"
  delete(tree, "Top")
  string s = get tree
  print "[" s "] " exists(tree, "Top/a") "\\n"
  set(tree, "Shut/b")
  s = get tree
  print s "\\n"
  empty tree
  print exists(tree, "Shut") "\\n"
}
apply(box, "Go", go)
show box
`;

describe("tree views", () => {
  test("choosing, double-clicking, expanding and refusing to expand", () => {
    const o = open(TREE);
    o.send("select", "treeView", { path: "Top/a", ...o.value("treeView", { path: "Top/a" }) });
    assert.equal(o.of("field").text, "Top/a");
    o.send("activate", "treeView", { path: "Top/a" });
    assert.equal(o.printed(), "open Top/a\n");
    let tree = o.send("expand", "treeView", { path: "Top" }).boxes[0].elements[0].tree;
    assert.equal(tree[0].open, true);
    assert.deepEqual(tree[0].kids.map((k: any) => k.name), ["a", "late"]);
    tree = o.send("expand", "treeView", { path: "Shut" }).boxes[0].elements[0].tree;
    assert.equal(tree[1].open, false);
    o.send("press", "button");
    assert.equal(o.printed(), "open Top/a\ntrue false true\n[] false\nShut/b\nfalse\n");
  });

  test("a missing parent, a second item of one name and an unknown path are refused", () => {
    const T = BOX + "DBE t = treeView(b, 0, 100, 5)\n";
    refused(T + 'insert(t, "a/b", iconNone, iconNone)', /insert the parent 'a' first/, 3);
    refused(T + 'insert(t, "a", iconNone, iconNone)\ninsert(t, "a", iconNone, iconNone)', /not verified/, 4);
    refused(T + 'set(t, "nowhere")', /no item 'nowhere'/, 3);
    refused(T + 'insert(t, "a//b", iconNone, iconNone)', /empty part/, 3);
    refused(T + "int n = noElems t", /not supported for a treeView/, 3);
  });
});

describe("sliders and status bars", () => {
  const SOURCE = `
DB box = create("S")
DBE level = slider(box, "Level", 5, 0, 10)
int ends[] = {100, 250}
DBE status = statusBar(box, "ready", ends)
void moved(DBE s) { int v = get s; set(status, 1, "at " v "") }
set(level, moved)
void go(DB x) { set(status, ddbFullStatus, "all of it"); set(level, 9) }
apply(box, "Go", go)
show box
`;

  test("the slider reports where it was put, and the status bar shows what it is told", () => {
    const o = open(SOURCE);
    assert.deepEqual(o.of("statusBar").status, { ends: [100, 250], cells: ["ready", ""], full: "" });
    o.send("select", "slider", o.value("slider", { position: 7 }));
    assert.deepEqual(o.of("statusBar").status.cells, ["ready", "at 7"]);
    o.send("press", "button", o.value("slider", { position: 99 }));
    assert.equal(o.of("statusBar").status.full, "all of it");
    assert.equal(o.of("slider").slider.value, 9);
  });

  test("values outside the range are refused", () => {
    refused(BOX + 'DBE s = slider(b, "s", 20, 0, 10)', /outside 0 to 10/, 2);
    refused(BOX + 'DBE s = slider(b, "s", 1, 0, 10)\nset(s, 11)', /outside the slider/, 3);
    refused(BOX + 'int e[] = {100, 50}\nDBE s = statusBar(b, "", e)', /beyond the one before/, 3);
    refused(BOX + 'int e[] = {100}\nDBE s = statusBar(b, "", e)\nset(s, 1, "x")', /no section 1/, 4);
  });
});

const MENUS = `
DB box = create("M")
string rows[] = {"x"}
DBE bar = menuBar(box)
DBE view = listView(box, 0, 100, 4, rows)
bool allowed = false
Sensitivity can(int i) {
  if (i == 0) return ddbAvailable
  if (i == 1) return allowed ? ddbChecked : ddbUnavailable
  return ddbAvailable
}
void picked(int i) { print "picked " i "\\n"; allowed = true }
string entries[] = {"Run", "Mark", "More", ">Deeper", ""}
char keys[] = {'R', ddbNone, ddbNone, ddbNone, ddbNone}
string help[] = {"", "", "", "", ""}
addMenu(bar, "&File", 'F', entries, keys, keys, help, help, 4, can, picked)
addMenu(view, "Row", ddbNone, entries, keys, keys, help, help, 1, can, picked)
show box
`;

describe("menus", () => {
  test("opening asks how each entry stands, and only a usable one can be picked", () => {
    const o = open(MENUS);
    assert.deepEqual(o.of("menuBar").menus, ["File"]);
    assert.deepEqual(o.of("listView").menus, ["Row"]);
    let spec = o.send("menu", "menuBar", { menu: 0 });
    assert.deepEqual(spec.popup.states, [1, 0, 1, 1]);
    o.send("choose", "menuBar", { menu: 0, entry: 1 });
    assert.equal(o.printed(), "");
    o.send("choose", "menuBar", { menu: 0, entry: 3 });
    assert.equal(o.printed(), "picked 3\n");
    spec = o.send("menu", "menuBar", { menu: 0 });
    assert.deepEqual(spec.popup.states, [1, 2, 1, 1]);
    assert.deepEqual(o.send("menu", "listView", { menu: 0 }).popup.states, [1]);
  });

  test("a menu belongs only where a person can open one, and cascades one level", () => {
    const M = BOX + 'string e[] = {">a"}\nchar k[] = {ddbNone}\nSensitivity c(int i) { return ddbAvailable }\n'
      + "void p(int i) {}\nDBE m = menuBar(b)\n";
    refused(M + "addMenu(m, \"t\", ddbNone, e, k, k, e, e, c, p)", /needs an entry above/, 7);
    refused(M + 'DBE t = toggle(b, "t", false)\naddMenu(t, "t", ddbNone, e, k, k, e, e, c, p)', /not supported for a toggle/, 8);
  });
});

describe("canvases", () => {
  const SOURCE = `
DB box = create("C")
int times = 0
void art(DBE c) {
  times++
  background(c, logicalPageBackgroundColor)
  realColor(c, realColor_Red)
  rectangle(c, 1, 2, width(c) / 2, height(c))
  line(c, 0, 0, 10, 10)
  font(c, 1, 1)
  draw(c, 5, 20, "drawn " times "")
  polarLine(c, 50, 50, 10, 90)
}
DBE view = canvas(box, 200, 100, art)
void go(DB x) {}
apply(box, "Go", go)
show box
`;

  test("the repaint callback draws when the box is shown and again after each action", () => {
    const o = open(SOURCE);
    const ops = o.of("canvas").canvas.ops;
    assert.deepEqual(ops.map((p: any) => p[0]), ["rect", "rect", "line", "text", "line"]);
    assert.deepEqual(ops[1], ["rect", "#ff0000", 1, 2, 100, 100]);
    assert.equal(ops[3][4], "drawn 1");
    assert.deepEqual(ops[4].slice(2), [50, 50, 50, 60]);
    o.send("press", "button");
    assert.equal(o.of("canvas").canvas.ops[3][4], "drawn 2");
  });

  test("drawing outside the repaint callback is refused", () => {
    refused(BOX + "void r(DBE c) {}\nDBE c = canvas(b, 10, 10, r)\nline(c, 0, 0, 1, 1)", /only from its repaint/, 4);
  });
});

describe("on the command line", () => {
  test("the new elements are drawn as text, nested", () => {
    const printed = dxl(demo(), `${BOX}DBE f = frame(b, "Group")\nDBE t = toggle(b, "Deep", true)
t->"top"->"inside"->f\nDBE tree = treeView(b, 0, 100, 5)\ninsert(tree, "A", iconNone, iconNone)
insert(tree, "A/B", iconNone, iconNone)\nshow b`).printed;
    assert.match(printed, /\|  Group:\n\|    \[x\] Deep\n\|  tree view, 2 items\n\|     A\n\|       B\n/);
  });
});
