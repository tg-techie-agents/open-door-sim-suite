// The dialog box elements beyond the plain controls: frames, tab strips,
// splitters, tree views, sliders, status bars, menus and canvases, written from
// the "Dialog boxes" chapter of the DXL Reference Manual 9.2. The box model and
// the session are in dialogs.ts.
//
// What a script can read back follows the manual, and what the manual does not
// settle is refused. What is only seen (colour shades, fonts, pixel sizes) is
// approximated.

import type { Library } from "../registry.ts";
import { Return } from "../compiler.ts";
import { Callback, Fault } from "../runtime.ts";
import { Element, add_element, box_of, dialogs_of, element_of, strings } from "./dialogs.ts";
import type { Box, Dialogs, Kind } from "./dialogs.ts";

const MAX_NODES = 20000;
const MAX_OPS = 20000;

type TreeNode = { name: string; open: boolean; kids: Map<string, TreeNode> };
export type Tree = { root: TreeNode; chosen: string; sorted: boolean; count: number };
export type Status = { ends: number[]; cells: string[]; full: string };
export type Slider = { value: number; min: number; max: number };
export type Menu = { title: string; entries: string[]; help: string[]; off_help: string[];
  sensitive: Callback; pick: Callback };
export type Canvas = { width: number; height: number; ops: any[]; color: string; size: number; bold: boolean };
/** `state` is what the sensitivity function last said; null before it is asked. */
export type Tool = { type: number; width: number; tip: string; help: string; off_help: string; state: number | null;
  items: string[]; chosen: number; typed: string };
export type ToolBar = { name: string; show_name: boolean; tools: Tool[]; sensitive: Callback; pick: Callback };
/** The menu a person has just opened: how each entry stands (0 grey, 1 usable, 2 ticked). */
export type Popup = { element: number; menu: number; states: number[] };

export const CONTAINERS: Kind[] = ["frame", "tab"];
const WITH_MENUS: Kind[] = ["menuBar", "listView", "treeView", "canvas"];

/** Run a script function as a callback and hand back what it returned. */
export function call_back(rt: any, callback: Callback, args: any[]): any {
  const fn = callback.target;
  if (!fn.body) throw new Fault(`the callback ${fn.name} has no body`);
  const local = new Map();
  fn.param_vars.forEach((v: any, i: number) => local.set(v, args[i]));
  try {
    rt.tick(0);
    fn.body([callback.globals, local]);
  } catch (e) {
    if (!(e instanceof Return)) throw e;
    return e.value;
  }
  return undefined;
}

/** Is `element` the container `outer` or somewhere inside it? */
function within(element: Element | null, outer: Element): boolean {
  for (let at = element; at; at = at.parent) if (at === outer) return true;
  return false;
}

/** `element->side->"inside"->container` */
export function put_inside(element: Element, container: Element): void {
  if (!CONTAINERS.includes(container.kind)) throw new Fault("only a frame or a tab strip can have elements inside it");
  if (element.kind === "menuBar" || element.kind === "statusBar" || element.standard) {
    throw new Fault("menu bars, status bars and the standard buttons cannot be placed inside another element");
  }
  if (within(container, element)) throw new Fault("an element cannot be placed inside itself");
  element.parent = container;
  element.said_inside = true;
}

/** Placed against something in a frame or tab strip, an element goes in there
 * with it, unless it has said itself what it is inside. */
export function follow(element: Element, target: Element): void {
  if (element.said_inside || element.standard || element.kind === "menuBar" || element.kind === "statusBar") return;
  if (!within(target.parent, element)) element.parent = target.parent;
}

// -- tree views ------------------------------------------------------------------

const node_of = (name: string): TreeNode => ({ name, open: false, kids: new Map() });

function parts_of(path: string): string[] {
  const parts = (path ?? "").split("/");
  if (parts.some((p) => !p)) throw new Fault(`'${path}' is not a path of a tree view: it has an empty part`);
  return parts;
}

/** The nodes along a path, or null where there is none. */
function walk(tree: Tree, path: string): TreeNode[] | null {
  let at = tree.root;
  const out: TreeNode[] = [];
  for (const part of (path ?? "").split("/")) {
    const next = at.kids.get(part);
    if (!next) return null;
    out.push(at = next);
  }
  return out;
}

function need_path(tree: Tree, path: string): TreeNode[] {
  const found = walk(tree, path);
  if (!found) throw new Fault(`the tree view has no item '${path}'`);
  return found;
}

export function choose_path(element: Element, path: string): void {
  const tree = element.tree!;
  for (const node of need_path(tree, path).slice(0, -1)) node.open = true;
  tree.chosen = path;
}

export function empty_tree(element: Element): void {
  const tree = element.tree!;
  tree.root = node_of("");
  tree.chosen = "";
  tree.count = 0;
}

const size_of = (node: TreeNode): number => [...node.kids.values()].reduce((n, kid) => n + size_of(kid), 1);

function ordered(tree: Tree, node: TreeNode): TreeNode[] {
  const kids = [...node.kids.values()];
  return tree.sorted ? kids.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())) : kids;
}

function tree_spec(tree: Tree, node: TreeNode): any[] {
  return ordered(tree, node).map((kid) => ({ name: kid.name, open: kid.open, kids: tree_spec(tree, kid) }));
}

// -- canvases --------------------------------------------------------------------

// The names are DXL's. The shades are this suite's: DOORS takes the logical ones
// from the user's display settings.
const LOGICAL: Array<[string, string]> = ("CurrentObjectOutline #000000,GridLines #c0c0c0,DefaultColor #000000,"
  + "PageBackgroundColor #ffffff,TextBackgroundColor #ffffff,CurrentBackgroundColor #ffffe0,"
  + "CurrentCellBackgroundColor #fffacd,TitleBackgroundColor #d4d0c8,ReadOnlyTextBackgroundColor #ececec,"
  + "UnlockedTextBackgroundColor #ffffff,DataTextColor #000000,TitleTextColor #000000,SelectedTextColor #316ac5,"
  + "ReadOnlyTextColor #555555,DeletedTextColor #888888,HighIndicatorColor #cc0000,MediumIndicatorColor #e6a100,"
  + "LowIndicatorColor #2e8b57,GraphicsBackgroundColor #ffffff,GraphicsShadeColor #a0a0a0,"
  + "GraphicsElideBoxColor #808080,GraphicsTextColor #000000,GraphicsBoxColor #dbe7f5,GraphicsLinkColor #1f4e9c,"
  + "GraphicsCurrentColor #ffd54f,GraphicsSelectedColor #316ac5,GraphicsBoxEdgeColor #33475b")
  .split(",").map((each) => each.split(" ") as [string, string]);
const REAL: Array<[string, string]> = ("Light_Blue2 #b2dfee,Light_Blue #add8e6,Dark_Turquoise #00ced1,Pink #ffc0cb,"
  + "Blue #0000ff,Maroon #800000,Red #ff0000,Yellow #ffff00,Green #00ff00,Cyan #00ffff,Magenta #ff00ff,"
  + "White #ffffff,Orange #ffa500,Brown #a52a2a,Purple #800080,Navy #000080,Sea_Green #2e8b57,Lime_Green #32cd32,"
  + "Rosy_Brown #bc8f8f,Peru #cd853f,Red_Grey #8b7d7b,Firebrick #b22222,Thistle #d8bfd8,Grey82 #d1d1d1,"
  + "Grey77 #c4c4c4,Grey66 #a8a8a8,Grey55 #8c8c8c,Grey44 #707070,Grey33 #545454,Grey22 #383838,Grey11 #1c1c1c,"
  + "Black #000000").split(",").map((each) => each.split(" ") as [string, string]);

function shade(table: Array<[string, string]>, n: number): string {
  if (!(n >= 0 && n < table.length)) throw new Fault(`there is no colour number ${n}`);
  return table[n][1];
}

const [BUTTON, TOGGLE, RADIO, COMBO, SPACER, EDITABLE] = [0, 1, 2, 3, 4, 5];
const TOOL_TYPES = [["toolButton", BUTTON], ["toolToggle", TOGGLE], ["toolRadio", RADIO], ["toolCombo", COMBO],
  ["toolSpacer", SPACER], ["toolEditableCombo", EDITABLE]] as const;
const is_combo = (tool: Tool) => tool.type === COMBO || tool.type === EDITABLE;

/** Ask the script how each tool of a bar stands. */
function ask_tools(rt: any, element: Element): void {
  const bar = element.toolbar!, dialogs = dialogs_of(rt)!, before = dialogs.callback;
  dialogs.callback = "DBE";
  try {
    bar.tools.forEach((tool, i) => {
      if (tool.type === SPACER) return;
      const answer = call_back(rt, bar.sensitive, [i]);
      if (typeof answer !== "number") throw new Fault(`the callback ${bar.sensitive.target.name} returned nothing`);
      tool.state = answer;
    });
  } finally {
    dialogs.callback = before;
  }
}

/** A person pressed a tool or picked from its combo. */
export function use_tool(rt: any, element: Element, event: { entry?: number | null; row?: number | null;
  text?: string | null }): void {
  const bar = element.toolbar;
  const at = event.entry ?? -1;
  const tool = bar?.tools[at];
  if (!bar || !tool || tool.type === SPACER || tool.state === null || tool.state === 0 || tool.state === 3) return;
  if (is_combo(tool)) {
    const row = event.row ?? -1;
    if (Number.isInteger(row) && row >= 0 && row < tool.items.length) {
      tool.chosen = row;
      tool.typed = "";
    } else if (tool.type === EDITABLE && typeof event.text === "string") {
      tool.chosen = -1;
      tool.typed = event.text;
    } else return;
  }
  call_back(rt, bar.pick, [at]);
}

/** Draw every canvas of the boxes again, as DOORS does whenever one is uncovered:
 * here, when a box is shown and after each thing the person does. */
export function paint(rt: any, dialogs: Dialogs, boxes: Box[]): void {
  const before = dialogs.callback;
  for (const box of boxes) {
    for (const element of box.elements) {
      // the first time a tool bar is on screen
      if (element.toolbar && box.on_screen && element.toolbar.tools.some((t) => t.type !== SPACER && t.state === null)) {
        ask_tools(rt, element);
      }
      const canvas = element.canvas;
      if (!canvas || !box.on_screen || element.hidden) continue;
      canvas.ops = [];
      Object.assign(canvas, { color: "#000000", size: 12, bold: false });
      dialogs.painting = element;
      dialogs.callback = "DBE";
      try {
        call_back(rt, element.callbacks.repaint!, [element]);
      } finally {
        dialogs.painting = null;
        dialogs.callback = before;
      }
    }
  }
}

function drawing(rt: any, value: any): [Element, Canvas] {
  const element = element_of(rt, value, "canvas");
  if (dialogs_of(rt)?.painting !== element) {
    throw new Fault("draw on a canvas only from its repaint callback (the manual: graphics drawn elsewhere are lost)");
  }
  return [element, element.canvas!];
}

function put(canvas: Canvas, op: any): void {
  if (canvas.ops.length >= MAX_OPS) throw new Fault(`more than ${MAX_OPS} things drawn on a canvas`);
  canvas.ops.push(op);
}

// -- describing them -------------------------------------------------------------

export function part_spec(e: Element): any {
  const out: any = {};
  if (e.parent) out.parent = e.parent.id;
  if (e.menus.length) {
    out.menus = e.menus.map((m) => m.title);
    out.entries = e.menus.map((m) => ({ entries: [...m.entries], help: [...m.help], offHelp: [...m.off_help] }));
  }
  if (e.tree) {
    out.tree = tree_spec(e.tree, e.tree.root);
    out.chosen = e.tree.chosen;
  }
  if (e.status) out.status = { ends: [...e.status.ends], cells: [...e.status.cells], full: e.status.full };
  if (e.slider) out.slider = { ...e.slider };
  if (e.pair) out.pair = [e.pair[0].id, e.pair[1].id];
  if (e.toolbar) {
    out.toolbar = { name: e.toolbar.show_name ? e.toolbar.name : "",
      tools: e.toolbar.tools.map((t) => ({ ...t, items: [...t.items] })) };
  }
  if (e.canvas) out.canvas = { width: e.canvas.width, height: e.canvas.height, ops: [...e.canvas.ops] };
  return out;
}

/** The lines of one of these elements for a box drawn as text, or null. */
export function part_text(e: Element, name: string): string[] | null {
  if (e.kind === "frame") return [`${name || "frame"}:`];
  if (e.kind === "tab") return [`tabs: ${e.rows.map((r) => (r.selected ? `[${r.cells[0]}]` : r.cells[0])).join("  ")}`];
  if (e.kind === "splitter") return [];
  if (e.kind === "slider") return [`${name.replace(/:\s*$/, "")}: ${e.slider!.value} (slider ${e.slider!.min} to ${e.slider!.max})`];
  if (e.kind === "canvas") {
    return [`canvas ${e.canvas!.width}x${e.canvas!.height}${menu_text(e)} (drawn only in the browser interface)`];
  }
  if (e.kind === "toolBar") {
    return [`tool bar: ${e.toolbar!.tools.map((t) => (t.type === SPACER ? " " : `<${t.tip || "tool"}>`)).join(" ")}`];
  }
  if (e.kind === "statusBar") return [`status: ${e.status!.full || e.status!.cells.join(" | ")}`];
  if (e.kind === "menuBar") {
    return [`menu bar: ${e.menus.map((m) => `${m.title} (${m.entries.map((x) => x.replace(/^>/, "- ")).join(", ")})`).join("; ")}`];
  }
  if (e.kind === "treeView") {
    const tree = e.tree!;
    const items: string[] = [];
    const add = (node: TreeNode, depth: number, above: string) => {
      for (const kid of ordered(tree, node)) {
        const path = above ? `${above}/${kid.name}` : kid.name;
        items.push(`   ${"  ".repeat(depth)}${path === tree.chosen ? "(*) " : ""}${kid.name}`);
        add(kid, depth + 1, path);
      }
    };
    add(tree.root, 0, "");
    return [`tree view, ${tree.count} ${tree.count === 1 ? "item" : "items"}${menu_text(e)}`, ...items.slice(0, 30),
      ...(items.length > 30 ? [`   ... ${items.length - 30} more`] : [])];
  }
  return null;
}

export const menu_text = (e: Element): string =>
  e.menus.length ? ` (right-click menu: ${e.menus.map((m) => m.title).join(", ")})` : "";

// -- the DXL functions -----------------------------------------------------------

export function register_parts(lib: Library): void {
  lib.type("Sensitivity");
  const add = (name: string, params: string[], returns: string, impl: (...args: any[]) => any) =>
    lib.add(name, params, returns, impl);
  const constant = (name: string, value: any, type = "int") => add(name, [], type, () => value);

  // -- frames and tab strips ---------------------------------------------------

  const frame = (rt: any, b: any, label: string, width = 0, height = 0) => {
    const e = add_element(rt, b, "frame", label);
    e.width = Math.max(0, width);
    e.height = Math.max(0, height);
    return e;
  };
  add("frame", ["DB", "string"], "DBE", (rt, b, label) => frame(rt, b, label));
  add("frame", ["DB", "string", "int", "int"], "DBE", frame);

  const tab = (rt: any, b: any, values: any[], count: number | null, width: number, height: number, press: Callback) => {
    const names = strings(values, count);
    if (!names.length) throw new Fault("a tab strip needs at least one tab");
    if (names.length > 100) throw new Fault("more than 100 tabs");
    const e = add_element(rt, b, "tab", "");
    e.rows = names.map((name, i) => ({ cells: [name], selected: i === 0, checked: false }));
    e.width = Math.max(0, width);
    e.height = Math.max(0, height);
    e.callbacks.select = press;
    return e;
  };
  add("tab", ["DB", "string[]", "void(DBE)"], "DBE", (rt, b, v, cb) => tab(rt, b, v, null, 0, 0, cb));
  add("tab", ["DB", "string[]", "int", "void(DBE)"], "DBE", (rt, b, v, n, cb) => tab(rt, b, v, n, 0, 0, cb));
  add("tab", ["DB", "string[]", "int", "int", "void(DBE)"], "DBE", (rt, b, v, w, h, cb) => tab(rt, b, v, null, w, h, cb));
  add("tab", ["DB", "string[]", "int", "int", "int", "void(DBE)"], "DBE", tab);

  add("splitter", ["DB", "DBE", "DBE", "int"], "DBE", (rt, b, first, second, width) => {
    const box = box_of(rt, b);
    const pair = [element_of(rt, first, "listView", "treeView"), element_of(rt, second, "listView", "treeView")];
    if (pair.some((e) => e.box !== box)) throw new Fault("the elements are on different dialog boxes");
    if (pair[0] === pair[1]) throw new Fault("a splitter needs two different elements");
    if (box.elements.some((e) => e.pair?.some((p) => pair.includes(p)))) {
      throw new Fault("an element can be beside only one splitter here");
    }
    const e = add_element(rt, b, "splitter", "");
    e.pair = [pair[0], pair[1]];
    e.parent = pair[0].parent;
    e.width = Math.max(0, width);
    return e;
  });

  // -- tree views --------------------------------------------------------------

  constant("treeViewOptionSorted", 1);
  for (const name of ("Database Project ProjectCut ProjectDeleted ProjectOpen ProjectOpenDeleted Formal FormalCut "
    + "FormalDeleted Link LinkCut LinkDeleted Descriptive DescriptiveCut DescriptiveDeleted Folder FolderCut "
    + "FolderDeleted FolderOpen FolderOpenDeleted Group GroupDisabled User UserDisabled ReadOnly "
    + "AuthenticatingUser").split(" ")) {
    constant(`icon${name}`, Object.freeze({ icon: name }), "Icon"); // accepted, not drawn
  }
  // the drag-and-drop callback form is not offered
  add("treeView", ["DB", "int", "int", "int"], "DBE", (rt, b, options, width, visible) => {
    if (options & ~1) throw new Fault("the options of a tree view are 0 or treeViewOptionSorted");
    const e = add_element(rt, b, "treeView", "");
    e.tree = { root: node_of(""), chosen: "", sorted: Boolean(options), count: 0 };
    e.width = width;
    e.height = visible;
    return e;
  });
  const tree_of = (rt: any, v: any): Tree => element_of(rt, v, "treeView").tree!;
  add("insert", ["DBE", "string", "Icon", "Icon"], "void", (rt, v, path) => {
    const tree = tree_of(rt, v), parts = parts_of(path), name = parts.pop()!;
    let at = tree.root;
    if (parts.length) {
      const above = walk(tree, parts.join("/"));
      if (!above) throw new Fault(`insert the parent '${parts.join("/")}' first`);
      at = above[above.length - 1];
    }
    if (at.kids.has(name)) throw new Fault(`the tree view already has '${path}': what a second one does is not verified`);
    if (tree.count >= MAX_NODES) throw new Fault(`more than ${MAX_NODES} items`);
    at.kids.set(name, node_of(name));
    tree.count++;
  });
  add("delete", ["DBE", "string"], "void", (rt, v, path) => {
    const tree = tree_of(rt, v), nodes = need_path(tree, path), gone = nodes.pop()!;
    (nodes[nodes.length - 1] ?? tree.root).kids.delete(gone.name);
    tree.count -= size_of(gone);
    if (tree.chosen === path || tree.chosen.startsWith(path + "/")) tree.chosen = "";
  });
  add("exists", ["DBE", "string"], "bool", (rt, v, path) => walk(tree_of(rt, v), path) !== null);
  add("selected", ["DBE", "string"], "bool", (rt, v, path) => {
    const tree = tree_of(rt, v);
    need_path(tree, path);
    return tree.chosen === path;
  });
  add("set", ["DBE", "bool(DBE,string)"], "void", (rt, v, expand) => {
    element_of(rt, v, "treeView").callbacks.expand = expand;
  });

  // -- sliders -----------------------------------------------------------------

  add("slider", ["DB", "string", "int", "int", "int"], "DBE", (rt, b, label, initial, min, max) => {
    if (!(min < max)) throw new Fault("the minimum of a slider must be below its maximum");
    if (!(initial >= min && initial <= max)) throw new Fault(`${initial} is outside ${min} to ${max}`);
    const e = add_element(rt, b, "slider", label);
    e.slider = { value: initial, min, max };
    return e;
  });

  // -- status bars -------------------------------------------------------------

  constant("ddbFullStatus", -1);
  const status_bar = (rt: any, b: any, initial: string, ends: any[], count: number | null) => {
    const n = count ?? ends.length;
    if (n < 1 || n > ends.length || n > 50) throw new Fault(`a status bar cannot have ${n} sections`);
    const points = ends.slice(0, n) as number[];
    if (points.some((p, i) => !(p > (i ? points[i - 1] : 0)))) {
      throw new Fault("the end points of a status bar's sections must each be beyond the one before");
    }
    if (box_of(rt, b).elements.some((e) => e.kind === "statusBar")) throw new Fault("the box already has a status bar");
    const e = add_element(rt, b, "statusBar", "");
    e.parent = null;
    e.status = { ends: points, cells: points.map((_, i) => (i ? "" : initial ?? "")), full: "" };
    return e;
  };
  add("statusBar", ["DB", "string", "int[]"], "DBE", (rt, b, initial, ends) => status_bar(rt, b, initial, ends, null));
  add("statusBar", ["DB", "string", "int[]", "int"], "DBE", status_bar);
  add("set", ["DBE", "int", "string"], "void", (rt, v, section, message) => {
    const status = element_of(rt, v, "statusBar").status!;
    if (section === -1) status.full = message ?? "";
    else {
      if (!(section >= 0 && section < status.cells.length)) throw new Fault(`the status bar has no section ${section}`);
      status.cells[section] = message ?? "";
    }
  });

  // -- menus -------------------------------------------------------------------

  ["ddbUnavailable", "ddbAvailable", "ddbChecked"].forEach((name, i) => constant(name, i, "Sensitivity"));
  constant("ddbNone", "\0", "char");
  add("menuBar", ["DB"], "DBE", (rt, b) => {
    if (box_of(rt, b).elements.some((e) => e.kind === "menuBar")) throw new Fault("the box already has a menu bar");
    const e = add_element(rt, b, "menuBar", "");
    e.parent = null;
    return e;
  });
  // the mnemonic and hot keys are accepted and do nothing here
  const add_menu = (rt: any, v: any, title: string, entries: any[], help: any[], off_help: any[], count: number | null,
    sensitive: Callback, pick: Callback) => {
    const e = element_of(rt, v, ...WITH_MENUS);
    const names = strings(entries, count);
    if (!names.length || names.length > 200) throw new Fault(`a menu cannot have ${names.length} entries`);
    names.forEach((name, i) => {
      if (name.startsWith(">>")) throw new Fault("menus cascade one level only");
      if (name.startsWith(">") && !i) throw new Fault("a sub-menu entry needs an entry above it to hang from");
    });
    if (e.menus.length >= (e.kind === "menuBar" ? 20 : 1)) {
      throw new Fault(e.kind === "menuBar" ? "more than 20 menus" : "what a second right-click menu does is not verified");
    }
    e.menus.push({ title: (title ?? "").replace(/&(&?)/g, "$1"), entries: names,
      help: names.map((_, i) => help[i] ?? ""), off_help: names.map((_, i) => off_help[i] ?? ""), sensitive, pick });
  };
  const head = ["DBE", "string", "char", "string[]", "char[]", "char[]", "string[]", "string[]"];
  const tail = ["Sensitivity(int)", "void(int)"];
  add("addMenu", [...head, ...tail], "void", (rt, v, title, _m, entries, _ms, _hots, help, off, sensitive, pick) =>
    add_menu(rt, v, title, entries, help, off, null, sensitive, pick));
  add("addMenu", [...head, "int", ...tail], "void", (rt, v, title, _m, entries, _ms, _hots, help, off, n, sensitive, pick) =>
    add_menu(rt, v, title, entries, help, off, n, sensitive, pick));

  // -- windows: parent, position and size ----------------------------------------

  // which window a box belongs to changes nothing here
  add("setParent", ["DB", "Module"], "void", (rt, b) => { box_of(rt, b); });
  add("setParent", ["DB", "DB"], "void", (rt, b, other) => { box_of(rt, b); box_of(rt, other); });
  add("setParent", ["DBE", "DBE"], "void", (rt, child, parent) => {
    const inner = element_of(rt, child), outer = element_of(rt, parent);
    if (outer.kind !== "frame") throw new Fault("the only element that can be the parent of another is a frame");
    if (inner.box !== outer.box) throw new Fault("the elements are on different dialog boxes");
    put_inside(inner, outer);
  });
  const pixels = (w: number, h: number) => {
    if (!(w > 0 && w <= 4000 && h > 0 && h <= 4000)) {
      throw new Fault(`a size of ${w} by ${h} pixels is not offered (1 to 4000 each way)`);
    }
  };
  const place = (rt: any, b: any, change: NonNullable<Box["geometry"]>) => {
    const box = box_of(rt, b);
    box.geometry = { ...box.geometry, ...change };
  };
  add("setPos", ["DB", "int", "int"], "void", (rt, b, x, y) => {
    if (!(Math.abs(x) <= 10000 && Math.abs(y) <= 10000)) throw new Fault(`(${x}, ${y}) is not a place on a screen`);
    place(rt, b, { x, y, centred: false });
  });
  add("setSize", ["DB", "int", "int"], "void", (rt, b, width, height) => {
    pixels(width, height);
    place(rt, b, { width, height });
  });
  add("setCenteredSize", ["DB", "int", "int"], "void", (rt, b, width, height) => {
    pixels(width, height);
    if (!box_of(rt, b).realized) throw new Fault("setCenteredSize comes after realize (or show) of the box");
    place(rt, b, { width, height, centred: true });
  });

  // -- tool bars ---------------------------------------------------------------

  lib.type("ToolType");
  for (const [name, value] of TOOL_TYPES) constant(name, value, "ToolType");
  constant("ddbInvisible", 3, "Sensitivity");
  const tool_bar = (rt: any, b: any, name: string | null, types: any[], params: any[], tips: any[], helps: any[],
    off_helps: any[], count: number | null, sensitive: Callback, pick: Callback, new_row: boolean, show_name: boolean) => {
    const arrays = [types, params, tips, helps, off_helps];
    const n = count ?? types.length;
    if (count === null && arrays.some((a) => a.length !== n)) {
      throw new Fault("without a number of tools, the arrays of a tool bar must all be the same size");
    }
    if (n < 1 || n > 100 || arrays.some((a) => n > a.length)) throw new Fault(`a tool bar cannot have ${n} tools here`);
    const need = (a: any[], i: number, what: string) => {
      if (a[i] === undefined || a[i] === null) throw new Fault(`tool ${i} of the tool bar has no ${what}`);
      return a[i];
    };
    const tools: Tool[] = [];
    for (let i = 0; i < n; i++) {
      const type = need(types, i, "type") as number;
      const spacer = type === SPACER;
      const combo = type === COMBO || type === EDITABLE;
      tools.push({ type, width: combo ? need(params, i, "width") : 0, tip: spacer ? "" : need(tips, i, "tool tip"),
        help: helps[i] ?? "", off_help: off_helps[i] ?? "", state: null, items: [], chosen: -1, typed: "" });
    }
    const e = add_element(rt, b, "toolBar", "");
    e.toolbar = { name: name ?? "", show_name: show_name, tools, sensitive, pick };
    if (name !== null) e.place = new_row ? "below" : "beside";
    return e;
  };
  const arrays = ["ToolType[]", "int[]", "string[]", "string[]", "string[]"];
  const calls = ["Sensitivity(int)", "void(int)"];
  const named = ["DB", "string", "Sensitivity()"];
  add("toolBar", ["DB", ...arrays, ...calls], "DBE", (rt, b, t, p, tip, h, off, sensitive, pick) =>
    tool_bar(rt, b, null, t, p, tip, h, off, null, sensitive, pick, true, false));
  add("toolBar", ["DB", ...arrays, "int", ...calls], "DBE", (rt, b, t, p, tip, h, off, n, sensitive, pick) =>
    tool_bar(rt, b, null, t, p, tip, h, off, n, sensitive, pick, true, false));
  // how a named bar shows in the container's right-click menu does not arise here
  add("toolBar", [...named, ...arrays, ...calls, "bool", "bool"], "DBE",
    (rt, b, name, _map, t, p, tip, h, off, sensitive, pick, row, show) =>
      tool_bar(rt, b, name ?? "", t, p, tip, h, off, null, sensitive, pick, row, show));
  add("toolBar", [...named, ...arrays, "int", ...calls, "bool", "bool"], "DBE",
    (rt, b, name, _map, t, p, tip, h, off, n, sensitive, pick, row, show) =>
      tool_bar(rt, b, name ?? "", t, p, tip, h, off, n, sensitive, pick, row, show));
  add("updateToolBars", ["DB"], "void", (rt, b) => {
    const box = box_of(rt, b);
    for (const e of box.elements) if (e.toolbar && box.on_screen && dialogs_of(rt)!.host.interactive) ask_tools(rt, e);
  });
  const bar_of = (rt: any, v: any): Element => element_of(rt, v, "toolBar");
  const combo = (rt: any, v: any, index: number): Tool => {
    const tool = bar_of(rt, v).toolbar!.tools[index];
    if (!tool || !is_combo(tool)) throw new Fault(`tool ${index} of the tool bar is not a combo`);
    return tool;
  };
  const item = (tool: Tool, at: number) => {
    if (!(at >= 0 && at < tool.items.length)) throw new Fault(`the combo has no item ${at}`);
    return at;
  };
  const insert_item = (tool: Tool, at: number, value: string) => {
    if (!(at >= -1 && at <= tool.items.length)) throw new Fault(`${at} is not a position in the combo`);
    if (tool.items.length >= 20000) throw new Fault("more than 20000 items");
    const where = at < 0 ? tool.items.length : at;
    tool.items.splice(where, 0, value ?? "");
    if (tool.chosen >= where) tool.chosen++;
  };
  add("toolBarComboAdd", ["DBE", "int", "string"], "void", (rt, v, i, value) => insert_item(combo(rt, v, i), -1, value));
  add("toolBarComboInsert", ["DBE", "int", "int", "string"], "void",
    (rt, v, i, at, value) => insert_item(combo(rt, v, i), at, value));
  add("toolBarComboDelete", ["DBE", "int", "int"], "void", (rt, v, i, at) => {
    const tool = combo(rt, v, i);
    tool.items.splice(item(tool, at), 1);
    if (tool.chosen === at) tool.chosen = -1;
    else if (tool.chosen > at) tool.chosen--;
  });
  add("toolBarComboEmpty", ["DBE", "int"], "void", (rt, v, i) => {
    Object.assign(combo(rt, v, i), { items: [], chosen: -1, typed: "" });
  });
  add("toolBarComboCount", ["DBE", "int"], "int", (rt, v, i) => combo(rt, v, i).items.length);
  add("toolBarComboGetItem", ["DBE", "int", "int"], "string", (rt, v, i, at) => {
    const tool = combo(rt, v, i);
    return tool.items[item(tool, at)];
  });
  const selection = (rt: any, v: any, i: number): Tool => {
    const tool = combo(rt, v, i);
    if (tool.chosen < 0 && !tool.typed) {
      throw new Fault("what a tool bar combo gives when nothing is selected is not documented");
    }
    return tool;
  };
  add("toolBarComboGetSelection", ["DBE", "int"], "string", (rt, v, i) => {
    const tool = selection(rt, v, i);
    return tool.chosen < 0 ? tool.typed : tool.items[tool.chosen];
  });
  add("toolBarComboGetSelection", ["DBE", "int"], "int", (rt, v, i) => {
    const tool = selection(rt, v, i);
    if (tool.chosen < 0) throw new Fault("the index of text typed into a combo is not documented");
    return tool.chosen;
  });
  add("toolBarComboSelect", ["DBE", "int", "int"], "void", (rt, v, i, at) => {
    const tool = combo(rt, v, i);
    Object.assign(tool, { chosen: item(tool, at), typed: "" });
  });
  add("toolBarComboSelect", ["DBE", "int", "string"], "void", (rt, v, i, value) => {
    const tool = combo(rt, v, i), at = tool.items.indexOf(value);
    if (at < 0) throw new Fault(`the combo has no item '${value}'`);
    Object.assign(tool, { chosen: at, typed: "" });
  });
  // only a named bar sits in the container whose bars can be hidden
  const hosted = (rt: any, v: any): Element => {
    const e = bar_of(rt, v);
    if (!e.toolbar!.name) throw new Fault("this applies only to a tool bar created with a name");
    return e;
  };
  const by_name = (rt: any, b: any, name: string): Element => {
    const found = box_of(rt, b).elements.find((e) => e.toolbar && e.toolbar.name === name);
    if (!found || !name) throw new Fault(`the box has no tool bar named '${name}'`);
    return found;
  };
  add("toolBarVisible", ["DBE"], "bool", (rt, v) => !hosted(rt, v).hidden);
  add("toolBarVisible", ["DB", "string"], "bool", (rt, b, name) => !by_name(rt, b, name).hidden);
  add("toolBarShow", ["DBE", "bool"], "void", (rt, v, on) => { hosted(rt, v).hidden = !on; });
  add("toolBarShow", ["DB", "string", "bool"], "void", (rt, b, name, on) => { by_name(rt, b, name).hidden = !on; });

  // -- canvases ----------------------------------------------------------------

  add("canvas", ["DB", "int", "int", "void(DBE)"], "DBE", (rt, b, width, height, repaint) => {
    if (!(width > 0 && width <= 4000 && height > 0 && height <= 4000)) {
      throw new Fault(`a canvas of ${width} by ${height} pixels is not offered (1 to 4000 each way)`);
    }
    const e = add_element(rt, b, "canvas", "");
    e.canvas = { width, height, ops: [], color: "#000000", size: 12, bold: false };
    e.callbacks.repaint = repaint;
    return e;
  });
  add("width", ["DBE"], "int", (rt, v) => element_of(rt, v, "canvas").canvas!.width);
  add("height", ["DBE"], "int", (rt, v) => element_of(rt, v, "canvas").canvas!.height);

  LOGICAL.forEach(([name], i) => constant(`logical${name}`, i));
  REAL.forEach(([name], i) => constant(`realColor_${name}`, i));
  constant("TextFont", 0);
  constant("HeadingFont", 1);
  constant("GraphicsFont", 2);

  for (const [name, table] of [["color", LOGICAL], ["realColor", REAL]] as const) {
    add(name, ["DBE", "int"], "void", (rt, v, n) => { drawing(rt, v)[1].color = shade(table, n); });
  }
  for (const [name, table] of [["background", LOGICAL], ["realBackground", REAL]] as const) {
    add(name, ["DBE", "int"], "void", (rt, v, n) => {
      const [, canvas] = drawing(rt, v);
      canvas.ops = [["rect", shade(table, n), 0, 0, canvas.width, canvas.height]];
    });
  }
  for (const [name, op] of [["rectangle", "rect"], ["box", "box"], ["ellipse", "ellipse"], ["line", "line"]] as const) {
    add(name, ["DBE", "int", "int", "int", "int"], "void", (rt, v, a, b, c, d) => {
      const [, canvas] = drawing(rt, v);
      put(canvas, [op, canvas.color, a, b, c, d]);
    });
  }
  const text = (rt: any, v: any, x: number, y: number, value: string, angle: number) => {
    const [, canvas] = drawing(rt, v);
    put(canvas, ["text", canvas.color, x, y, value ?? "", angle, canvas.size, canvas.bold]);
  };
  add("draw", ["DBE", "int", "int", "string"], "void", (rt, v, x, y, s) => text(rt, v, x, y, s, 0));
  add("drawAngle", ["DBE", "int", "int", "string", "real"], "void", text);
  // pairs of x and y, drawn as a closed outline
  add("polygon", ["DBE", "int[]"], "void", (rt, v, coords: any[]) => {
    const [, canvas] = drawing(rt, v);
    if (coords.length < 6 || coords.length % 2) {
      throw new Fault(`polygon takes pairs of co-ordinates, at least three: the array has ${coords.length} elements`);
    }
    for (let i = 0; i < coords.length; i++) {
      if (coords[i] === undefined || coords[i] === null) {
        throw new Fault(`polygon: array element ${i} has no value, and what is drawn for it is not documented`);
      }
    }
    put(canvas, ["polygon", canvas.color, ...coords]);
  });
  // clockwise from three o'clock, as the manual has it; y grows downwards
  add("polarLine", ["DBE", "int", "int", "int", "int"], "void", (rt, v, x, y, length, degrees) => {
    const [, canvas] = drawing(rt, v), a = degrees * Math.PI / 180;
    put(canvas, ["line", canvas.color, x, y, Math.round(x + length * Math.cos(a)), Math.round(y + length * Math.sin(a))]);
  });
  add("font", ["DBE", "int", "int"], "void", (rt, v, level, mode) => {
    const [, canvas] = drawing(rt, v);
    if (!(level >= 1 && level <= 9)) throw new Fault("the font level is 1 to 9");
    if (!(mode >= 0 && mode <= 2)) throw new Fault("the font mode is 0, 1 or 2");
    canvas.size = Math.max(10, 20 - level * 2);
    canvas.bold = mode === 1;
  });
}
