// Rich dialog elements, window position and size, focus, buffers, modified,
// setParent and polygon. What the page does with them needs a browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError, run } from "../src/dxl/index.ts";
import type { DialogSession } from "../src/dxl/index.ts";
import { demo, dxl } from "./helpers.ts";

const BOX = 'DB b = create("t")\n';

function open(source: string) {
  let printed = "";
  const out = { write: (s: string) => { printed += s; } };
  const result = run(source, demo(), out, null, ".", null, false, false, undefined, Date.now() + 20000, [], null,
    { interactive: true });
  const session: DialogSession = result.dialogs!;
  assert.ok(session, "no dialog box was left open: " + printed);
  let spec = session.spec();
  const all = () => spec.boxes.flatMap((b: any) => [...b.elements, ...b.buttons]);
  const find = (label: string) => all().find((e: any) => e.label === label);
  return {
    spec: () => spec,
    printed: () => printed,
    find,
    press(label: string, typed: Record<string, string> = {}) {
      const values = Object.entries(typed).map(([name, text]) => ({ id: find(name).id, text }));
      session.dispatch({ box: spec.boxes[0].id, kind: "press", element: find(label).id, values },
        { out, deadline: Date.now() + 20000 });
      spec = session.spec();
    },
  };
}

function refused(source: string, wanted: RegExp): void {
  assert.throws(() => dxl(demo(), source), (e: any) => {
    assert.ok(e instanceof DxlError, String(e));
    assert.match(e.message, wanted);
    return true;
  }, source);
}

describe("rich dialog elements", () => {
  test("a richText initial value is read as markup and shown formatted", () => {
    const box = open(BOX + [
      'DBE one = richField(b, "one", richText "{\\\\b Seal} the pump", 30)',
      'DBE two = richText(b, "two", richText "{\\\\i drain} line", 200, 80, true)',
      'DBE three = richText(b, "three", "plain words", 200, false)',
      "show b",
    ].join("\n"));
    assert.equal(box.find("one").text, "Seal the pump");
    assert.deepEqual(box.find("one").rich[0].runs, [{ text: "Seal", style: 1 }, { text: " the pump", style: 0 }]);
    assert.equal(box.find("two").readOnly, true);
    assert.equal(box.find("three").rich, null);
  });

  test("plain contents are read back; typing sets modified", () => {
    const box = open(BOX + [
      'DBE r = richField(b, "note", "first", 20)',
      "void report(DB x) {",
      "  string s = get(r)",
      '  print s " " modified(r) "\\n"',
      "}",
      'apply(b, "Report", report)',
      "show b",
    ].join("\n"));
    box.press("Report");
    box.press("Report", { note: "second" });
    assert.equal(box.printed(), "first false\nsecond true\n");
  });

  test("what markup would change the answer is refused", () => {
    refused(BOX + 'DBE r = richField(b, "n", "a {brace}", 20)', /not documented/);
    refused(BOX + 'DBE r = richField(b, "n", "ok", 20)\nset(r, "a \\\\ b")', /not documented/);
    refused(BOX + 'DBE r = richField(b, "n", richText "{\\\\b x}", 20)\nstring s = get(r)', /not documented/);
    refused(BOX + 'DBE r = richField(b, "n", richText "{\\\\unknownword x}", 20)', /here/);
  });
});

describe("windows, focus and buffers", () => {
  test("position, size and focus reach the page", () => {
    const box = open(BOX + [
      'DBE f = field(b, "name", "x", 10)',
      "realize b",
      "setPos(b, 30, 40)",
      "setCenteredSize(b, 500, 300)",
      "setFocus(f)",
      "setParent(b, current Module)",
      "show b",
    ].join("\n"));
    assert.deepEqual(box.spec().boxes[0].geometry, { x: 30, y: 40, width: 500, height: 300, centred: true });
    assert.equal(box.spec().focus, box.find("name").id);
  });

  test("buffers go into and out of a field, and setting it clears modified", () => {
    const box = open(BOX + [
      'DBE f = field(b, "name", "old", 10)',
      "void swap(DB x) {",
      "  Buffer got = getBuffer(f)",
      '  print tempStringOf(got) " " modified(f) "\\n"',
      '  Buffer next = create',
      '  next = "fresh"',
      "  setFromBuffer(f, next)",
      '  print modified(f) "\\n"',
      "}",
      'apply(b, "Swap", swap)',
      "show b",
    ].join("\n"));
    box.press("Swap", { name: "typed" });
    assert.equal(box.printed(), "typed true\nfalse\n");
    assert.equal(box.find("name").text, "fresh");
  });

  test("setParent puts an element in a frame, and only a frame", () => {
    const box = open(BOX + 'DBE f = frame(b, "group")\nDBE t = toggle(b, "in", false)\nsetParent(t, f)\nshow b');
    assert.equal(box.find("in").parent, box.find("group").id);
    refused(BOX + 'DBE t = toggle(b, "a", false)\nDBE u = toggle(b, "c", false)\nsetParent(t, u)', /only element/);
    refused(BOX + "setCenteredSize(b, 100, 100)", /after realize/);
    refused(BOX + "setSize(b, 0, 100)", /not offered/);
  });
});

describe("polygon", () => {
  const draw = (body: string) => BOX + `void paint(DBE c) {\n${body}\n}\nDBE c = canvas(b, 100, 100, paint)\nshow b`;

  test("the whole array is drawn as one outline", () => {
    const box = open(draw("int p[6]\np[0] = 5\np[1] = 6\np[2] = 70\np[3] = 8\np[4] = 30\np[5] = 90\npolygon(c, p)"));
    assert.deepEqual(box.spec().boxes[0].elements[0].canvas.ops, [["polygon", "#000000", 5, 6, 70, 8, 30, 90]]);
  });

  test("an array with a gap is refused", () => {
    assert.throws(() => open(draw("int p[6]\np[0] = 5\npolygon(c, p)")), /has no value/);
  });
});

describe("tool bars", () => {
  const BAR = BOX + [
    "ToolType kinds[] = {toolButton, toolCombo}",
    "int sizes[] = {0, 90}",
    'string tips[] = {"Go", "Pick"}',
    'string none[] = {"", ""}',
    "bool allow = false",
    "DBE bar",
    "Sensitivity how(int i) {",
    "  if (i == 0 && !allow) return ddbUnavailable",
    "  return ddbAvailable",
    "}",
    "void use(int i) {",
    "  if (i == 1) {",
    "    string s = toolBarComboGetSelection(bar, 1)",
    "    int n = toolBarComboGetSelection(bar, 1)",
    '    print s " " n "\\n"',
    "    allow = true",
    "    updateToolBars(b)",
    '  } else print "go\\n"',
    "}",
    "bar = toolBar(b, kinds, sizes, tips, none, none, how, use)",
    'toolBarComboAdd(bar, 1, "left")',
    'toolBarComboInsert(bar, 1, 0, "right")',
    "show b",
  ].join("\n");

  test("states come from the script, and a greyed tool does nothing", () => {
    let printed = "";
    const out = { write: (s: string) => { printed += s; } };
    const session = run(BAR, demo(), out, null, ".", null, false, false, undefined, Date.now() + 20000, [], null,
      { interactive: true }).dialogs!;
    const bar = () => session.spec().boxes[0].elements[0];
    const first = bar();
    assert.deepEqual(first.toolbar.tools.map((t: any) => t.state), [0, 1]);
    assert.deepEqual(first.toolbar.tools[1].items, ["right", "left"]);
    const at = { box: session.spec().boxes[0].id, kind: "tool" as const, element: first.id };
    session.dispatch({ ...at, entry: 0 }, { out });
    session.dispatch({ ...at, entry: 1, row: 1 }, { out });
    assert.equal(bar().toolbar.tools[0].state, 1);
    session.dispatch({ ...at, entry: 0 }, { out });
    assert.equal(printed, "left 1\ngo\n");
  });

  test("arrays of different sizes without a count are refused", () => {
    refused(BOX + [
      "ToolType kinds[] = {toolButton}",
      "int sizes[] = {0, 0}",
      'string tips[] = {"Go"}',
      "Sensitivity how(int i) { return ddbAvailable }",
      "void use(int i) {}",
      "DBE bar = toolBar(b, kinds, sizes, tips, tips, tips, how, use)",
    ].join("\n"), /same size/);
  });
});
