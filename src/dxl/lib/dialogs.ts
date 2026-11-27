// DXL dialog boxes, written from the "Dialog boxes" chapter of the DXL Reference
// Manual 9.2.
//
// The boxes are a model held here. A host that can show them (the browser)
// gets a description from DialogSession.spec() and sends back what the person
// did; the script's variables stay alive and its callbacks run one event at a
// time. Without such a host (the command line, tests) show() draws the box as
// text and nothing more happens.
//
// Two statements shape the flow of a script:
//   show(box)   as the manual says, nothing after it ever runs; only callbacks.
//   block(box)  the statements after it run once the box is released or
//               closed. Only offered as a statement of the script's top level,
//               because only there can the rest be put aside and run later.
//
// What the manual does not settle is refused where it is met rather than guessed.

import { is_formatted, parse, plain_of, RichError } from "../../rich.ts";
import type { Doc } from "../../rich.ts";
import { carry_out } from "./pending.ts";
import type { Library } from "../registry.ts";
import { Callback, Fault, Halt } from "../runtime.ts";
import { confirm } from "./core.ts";
import { call_back, choose_path, empty_tree, follow, menu_text, paint, part_spec, part_text, put_inside,
  register_parts, use_tool } from "./dialog-parts.ts";
import { Buffer } from "./text.ts";
import type { Canvas, Menu, Popup, Slider, Status, ToolBar, Tree } from "./dialog-parts.ts";

const STATE = "dialogs"; // the key in rt.state
const MAX_ROWS = 20000;
const MAX_MESSAGES = 20;

export type Progress = { title: string; message: string; position: number; limit: number };

/** What shows the boxes. `interactive`: a person can press their buttons. */
export type DialogHost = { interactive: boolean; progress?: (progress: Progress | null) => void };

export type Kind = "label" | "separator" | "field" | "text" | "fileName" | "toggle" | "radioBox" | "checkBox"
  | "choice" | "list" | "multiList" | "listView" | "button"
  | "frame" | "tab" | "splitter" | "treeView" | "slider" | "statusBar" | "menuBar" | "canvas"
  | "richField" | "richText" | "toolBar";

/** The elements a person types into. */
const TYPED: Kind[] = ["field", "text", "fileName", "richField", "richText"];
const RICH: Kind[] = ["richField", "richText"];

type Place = "below" | "beside" | "right" | "opposite";

/** One option, item or list view row. Selection travels with it, so that
 * inserting and deleting cannot leave it pointing at the wrong one. */
type Row = { cells: string[]; selected: boolean; checked: boolean };

const row_of = (text: string): Row => ({ cells: [text], selected: false, checked: false });

type Callbacks = {
  press?: Callback; select?: Callback; activate?: Callback; deselect?: Callback; check?: Callback;
  expand?: Callback; repaint?: Callback;
};

let next_id = 1;

export class Element {
  id: number = next_id++;
  box: Box;
  kind: Kind;
  label: string;
  text = ""; // field, text, fileName, label; what was typed into an editable choice
  on = false; // toggle
  formatted: Doc | null = null; // a rich element holding formatting: shown, not edited
  edited = false; // typed into since the script last set it
  rows: Row[] = [];
  columns: { title: string; width: number }[] = [];
  multi = false; // more than one row may be selected
  checkboxes = false; // list view
  editable = false; // choice: may be typed into
  vertical = false;
  read_only = false;
  inactive = false;
  hidden = false;
  place: Place = "below";
  full = false;
  width = 0;
  height = 0;
  standard: "ok" | "apply" | null = null; // in the row of standard buttons
  is_default = false;
  unsettled = false; // a choice given new values: its selection is not known
  callbacks: Callbacks = {};
  parent: Element | null = null; // the frame or tab strip it is inside
  said_inside = false;
  menus: Menu[] = [];
  tree: Tree | null = null;
  slider: Slider | null = null;
  status: Status | null = null;
  canvas: Canvas | null = null;
  toolbar: ToolBar | null = null;
  pair: [Element, Element] | null = null; // what a splitter stands between

  constructor(box: Box, kind: Kind, label: string) {
    this.box = box;
    this.kind = kind;
    this.label = label;
  }
}

export class Box {
  id: number = next_id++;
  title: string;
  elements: Element[] = [];
  buttons: Element[] = []; // the standard row
  close_button = true;
  close_action: Callback | null = null;
  place: Place = "below";
  full = false;
  realized = false;
  on_screen = false;
  blocking = false; // displayed by block()
  destroyed = false;
  /** Where and how big the script said, in pixels. */
  geometry: { x?: number; y?: number; width?: number; height?: number; centred?: boolean } | null = null;

  constructor(title: string) {
    this.title = title;
  }
}

/** show(box): leave the script here. */
export class ShowStop {}

/** block(box): put the rest of the script aside until the box goes. */
export class Block {
  box: Box;
  constructor(box: Box) {
    this.box = box;
  }
}

type Message = { kind: string; text: string };

export class Dialogs {
  host: DialogHost;
  boxes: Box[] = [];
  shown = false; // show() or block() has been called
  messages: Message[] = []; // message boxes since the host last looked
  progress: Progress | null = null;
  callback: "DB" | "DBE" | null = null; // the kind of callback running
  painting: Element | null = null; // the canvas whose repaint callback is running
  popup: Popup | null = null; // a menu opened, until the host has been told
  focus: number | null = null; // the element setFocus named, until the host has been told
  blocked: { box: Box; steps: Array<(env: any) => any>; env: any } | null = null;
  _told = 0;

  constructor(host: DialogHost) {
    this.host = host;
  }

  message(kind: string, text: string): void {
    this.messages.push({ kind, text });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
  }

  /** Can a person still do something that runs the script? */
  live(): boolean {
    return this.host.interactive && this.shown && this.boxes.some((b) => b.on_screen);
  }

  tell_progress(now: boolean = false): void {
    if (!this.host.progress) return;
    // not on every step of a long loop
    if (!now && Date.now() - this._told < 100) return;
    this._told = Date.now();
    this.host.progress(this.progress && { ...this.progress });
  }

  stop_progress(): void {
    if (!this.progress) return;
    this.progress = null;
    this.tell_progress(true);
  }
}

export function dialogs_of(rt: any): Dialogs | null {
  return rt.state.get(STATE) ?? null;
}

/** Called by the engine before a script runs. */
export function open_dialogs(rt: any, host: DialogHost): Dialogs {
  const made = new Dialogs(host);
  rt.state.set(STATE, made);
  return made;
}

function state(rt: any): Dialogs {
  const found = dialogs_of(rt);
  if (!found) throw new Fault("a dialog box cannot be used in layout or attribute DXL");
  return found;
}

/** Run top-level statements until the script ends, or shows or blocks. */
export function run_steps(dialogs: Dialogs, steps: Array<(env: any) => any>, env: any): void {
  for (let i = 0; i < steps.length; i++) {
    try {
      steps[i](env);
    } catch (e) {
      if (e instanceof ShowStop) return;
      if (e instanceof Block) {
        dialogs.blocked = { box: e.box, steps: steps.slice(i + 1), env };
        return;
      }
      throw e;
    }
  }
}

// -- the session: what a person does with the boxes ------------------------------

export type DialogEvent = {
  box: number;
  kind: "press" | "close" | "select" | "activate" | "check" | "expand" | "collapse" | "menu" | "choose" | "tool";
  text?: string | null; // typed into a tool bar's editable combo
  path?: string | null; // of a tree view item
  menu?: number | null;
  entry?: number | null;
  element?: number | null;
  row?: number | null;
  // what the person has typed and chosen, for every element they can change
  values?: Array<{ id: number; text?: string; on?: boolean; selected?: number[]; checked?: number[];
    path?: string; position?: number }>;
};

export type Host = {
  out: { write(text: string): any };
  ask?: ((question: string) => boolean) | null;
  deadline?: number | null;
};

let next_session = 1;

/** A script whose boxes are on screen. */
export class DialogSession {
  id: number = next_session++;
  rt: any;
  dialogs: Dialogs;
  /** Runs a body with the engine's guards: errors as DxlError, dry run undone. */
  guard: (body: () => void) => void;
  ended = false;

  constructor(rt: any, dialogs: Dialogs, guard: (body: () => void) => void) {
    this.rt = rt;
    this.dialogs = dialogs;
    this.guard = guard;
  }

  get open(): boolean {
    return !this.ended && this.dialogs.live();
  }

  modified(): number[] {
    return [...this.rt.modified];
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.dialogs.stop_progress();
    for (const closer of this.rt.closers) closer();
    carry_out(this.rt);
  }

  /** What is on screen, as plain data. Message boxes are handed over once. */
  spec(): any {
    const messages = this.dialogs.messages;
    this.dialogs.messages = [];
    const popup = this.dialogs.popup;
    this.dialogs.popup = null;
    const focus = this.dialogs.focus;
    this.dialogs.focus = null;
    return {
      popup,
      focus,
      session: this.id,
      open: this.open,
      messages,
      boxes: this.open ? this.dialogs.boxes.filter((b) => b.on_screen).map(box_spec) : [],
    };
  }

  /** One thing the person did. Events for what is no longer on screen are
   * ignored. Throws DxlError if a callback fails; the boxes stay. */
  dispatch(event: DialogEvent, host: Host): void {
    if (!this.open) return;
    const { rt, dialogs } = this;
    const box = dialogs.boxes.find((b) => b.id === event.box);
    rt.out = host.out;
    rt.ask = host.ask || (() => false);
    rt.deadline = host.deadline ?? null;
    rt.trapping = false;
    rt.last_error = "";
    try {
      this.guard(() => {
        const previous = new Map<Element, boolean[]>();
        for (const each of dialogs.boxes) {
          if (each.on_screen) for (const e of each.elements) previous.set(e, e.rows.map((r) => r.selected));
        }
        apply_values(dialogs, event.values ?? []);
        if (!box?.on_screen) return;
        try {
          this.handle(box, event, previous);
        } catch (e) {
          if (e instanceof Halt) return;
          if (!(e instanceof ShowStop)) throw e;
        } finally {
          dialogs.callback = null;
        }
        // a released or closed block() lets the rest of the script run
        while (dialogs.blocked && !dialogs.blocked.box.on_screen) {
          const waiting = dialogs.blocked;
          dialogs.blocked = null;
          waiting.box.blocking = false;
          try {
            run_steps(dialogs, waiting.steps, waiting.env);
          } catch (e) {
            if (!(e instanceof Halt)) throw e;
          }
        }
        try {
          paint(rt, dialogs, dialogs.boxes);
        } catch (e) {
          if (!(e instanceof Halt)) throw e;
        }
      });
    } finally {
      dialogs.callback = null;
      dialogs.stop_progress();
      if (!dialogs.live()) this.end();
    }
  }

  handle(box: Box, event: DialogEvent, previous: Map<Element, boolean[]>): void {
    const dialogs = this.dialogs;
    if (event.kind === "close") {
      if (box.close_action) {
        dialogs.callback = "DB";
        this.call(box.close_action, [box]);
      } else box.on_screen = false;
      return;
    }
    const element = [...box.elements, ...box.buttons].find((e) => e.id === event.element);
    if (!element || !usable(element)) return;
    const callbacks = element.callbacks;
    if (event.kind === "tool") {
      dialogs.callback = "DBE";
      use_tool(this.rt, element, event);
      return;
    }
    if (event.kind === "menu" || event.kind === "choose") {
      this.menu(element, event);
      return;
    }
    if (event.kind === "expand" || event.kind === "collapse") {
      dialogs.callback = "DBE";
      this.expand(element, event);
      return;
    }
    if (event.kind === "press") {
      if (element.standard) {
        dialogs.callback = "DB";
        if (callbacks.press) this.call(callbacks.press, [box]);
        if (element.standard === "ok") box.on_screen = false;
      } else if (element.kind === "button" && callbacks.press) {
        dialogs.callback = "DBE";
        this.call(callbacks.press, [element]);
      }
      return;
    }
    dialogs.callback = "DBE";
    const at = event.row ?? -1;
    const valid = Number.isInteger(at) && at >= 0 && at < element.rows.length;
    if (element.kind === "listView") {
      if (event.kind === "check") {
        if (valid && callbacks.check) this.call(callbacks.check, [element, at]);
      } else if (event.kind === "activate") {
        if (valid && callbacks.activate) this.call(callbacks.activate, [element, at]);
      } else {
        const before = previous.get(element) ?? [];
        if (callbacks.deselect) {
          for (let i = 0; i < element.rows.length; i++) {
            if (before[i] && !element.rows[i]?.selected) this.call(callbacks.deselect, [element, i]);
          }
        }
        if (valid && element.rows[at]?.selected && callbacks.select) this.call(callbacks.select, [element, at]);
      }
      return;
    }
    const wanted = event.kind === "activate" ? callbacks.activate : event.kind === "select" ? callbacks.select : null;
    if (wanted) this.call(wanted, [element]);
  }

  /** A menu opened (ask how each entry stands) or one of its entries picked. */
  menu(element: Element, event: DialogEvent): void {
    const menu = element.menus[event.menu ?? -1];
    if (!menu) return;
    this.dialogs.callback = "DBE";
    const standing = (i: number): number => {
      const answer = this.call(menu.sensitive, [i]);
      if (typeof answer !== "number") throw new Fault(`the callback ${menu.sensitive.target.name} returned nothing`);
      if (answer === 3) throw new Fault("ddbInvisible for a menu entry is not verified");
      return answer;
    };
    if (event.kind === "menu") {
      this.dialogs.popup = { element: element.id, menu: event.menu!, states: menu.entries.map((_, i) => standing(i)) };
      return;
    }
    const at = event.entry ?? -1;
    if (Number.isInteger(at) && at >= 0 && at < menu.entries.length && standing(at) !== 0) this.call(menu.pick, [at]);
  }

  expand(element: Element, event: DialogEvent): void {
    if (element.kind !== "treeView") return;
    let nodes = element.tree!.root;
    for (const part of (event.path ?? "").split("/")) {
      const next = nodes.kids.get(part);
      if (!next) return;
      nodes = next;
    }
    const ask = element.callbacks.expand;
    if (event.kind === "expand" && ask) {
      const answer = this.call(ask, [element, event.path]);
      if (typeof answer !== "boolean") throw new Fault(`the callback ${ask.target.name} returned nothing`);
      if (!answer) return;
    }
    nodes.open = event.kind === "expand";
  }

  call(callback: Callback, args: any[]): any {
    return call_back(this.rt, callback, args);
  }
}

/** Neither it nor what it is inside is hidden, and it is not greyed. */
function usable(e: Element): boolean {
  if (e.inactive) return false;
  for (let at: Element | null = e; at; at = at.parent) if (at.hidden) return false;
  return true;
}

function apply_values(dialogs: Dialogs, values: NonNullable<DialogEvent["values"]>): void {
  const live = new Map<number, Element>();
  for (const box of dialogs.boxes) {
    if (box.on_screen) for (const e of box.elements) if (usable(e)) live.set(e.id, e);
  }
  for (const value of values) {
    const element = live.get(value?.id);
    if (!element) continue;
    const { kind, rows } = element;
    if (typeof value.text === "string" && !element.read_only && !element.formatted && TYPED.includes(kind)
      && value.text !== element.text) {
      element.text = value.text;
      element.edited = true;
    }
    if (kind === "toggle" && typeof value.on === "boolean") element.on = value.on;
    if (element.slider && Number.isInteger(value.position)) {
      element.slider.value = Math.min(element.slider.max, Math.max(element.slider.min, value.position!));
    }
    if (element.tree && typeof value.path === "string" && value.path && value.path !== element.tree.chosen) {
      try {
        choose_path(element, value.path);
      } catch (e) {
        if (!(e instanceof Fault)) throw e;
      }
    }
    if (kind === "tab" && Array.isArray(value.selected) && rows[value.selected[0]]) {
      rows.forEach((r, i) => { r.selected = i === value.selected![0]; });
    }
    if (Array.isArray(value.selected)
      && ["choice", "radioBox", "checkBox", "list", "multiList", "listView"].includes(kind)) {
      const wanted = new Set(value.selected.filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length));
      const many = element.multi || kind === "checkBox";
      const chosen = many ? wanted : new Set([...wanted].slice(0, 1));
      const changed = rows.some((r, i) => r.selected !== chosen.has(i));
      rows.forEach((r, i) => { r.selected = chosen.has(i); });
      if (kind === "choice" && element.editable && typeof value.text === "string" && !chosen.size) {
        element.text = value.text;
        element.unsettled = false;
      } else if (changed || chosen.size) {
        element.text = "";
        element.unsettled = false;
      }
    }
    if (kind === "listView" && element.checkboxes && Array.isArray(value.checked)) {
      const checked = new Set(value.checked);
      rows.forEach((r, i) => { r.checked = checked.has(i); });
    }
  }
}

// -- describing the boxes ------------------------------------------------------

/** A label as shown: on Windows `&` marks the shortcut letter. */
const shown_label = (label: string) => label.replace(/&(&?)/g, "$1");

function events_of(e: Element): string[] {
  const out: string[] = [];
  if (e.callbacks.select || e.callbacks.deselect) out.push(e.kind === "field" ? "enter" : "select");
  if (e.callbacks.activate) out.push("activate");
  if (e.callbacks.check) out.push("check");
  return out;
}

function element_spec(e: Element): any {
  return {
    ...part_spec(e),
    id: e.id, kind: e.kind, label: e.kind === "label" ? "" : shown_label(e.label), text: e.kind === "label" ? e.label : e.text,
    on: e.on, rows: e.rows.map((r) => ({ cells: [...r.cells], selected: r.selected, checked: r.checked })),
    columns: e.columns.map((c) => ({ ...c })), multi: e.multi, checkboxes: e.checkboxes, editable: e.editable,
    vertical: e.vertical, readOnly: e.read_only, inactive: e.inactive, hidden: e.hidden, place: e.place, full: e.full,
    width: e.width, height: e.height, isDefault: e.is_default, events: events_of(e), rich: e.formatted,
  };
}

function box_spec(box: Box): any {
  return {
    id: box.id, title: box.title, blocking: box.blocking, closeButton: box.close_button, geometry: box.geometry,
    elements: box.elements.map(element_spec),
    buttons: box.buttons.map(element_spec),
  };
}

/** A box as text, for where nobody can click. */
export function render_text(box: Box): string {
  const lines = [`+-- dialog box: ${box.title}`];
  const some = (rows: Row[], one: (r: Row) => string) => {
    for (const r of rows.slice(0, 15)) lines.push(`|     ${one(r)}`);
    if (rows.length > 15) lines.push(`|     ... ${rows.length - 15} more`);
  };
  const rank = (e: Element) => (e.kind === "menuBar" ? 0 : e.kind === "statusBar" ? 2 : 1);
  const order: Array<[Element, number]> = [];
  const gather = (parent: Element | null, depth: number) => {
    for (const e of box.elements.filter((x) => x.parent === parent).sort((a, b) => rank(a) - rank(b))) {
      if (e.hidden) continue;
      order.push([e, depth]);
      gather(e, depth + 1);
    }
  };
  gather(null, 0);
  for (const [e, depth] of order) {
    const from = lines.length;
    const name = shown_label(e.label);
    const head = name ? `${name.replace(/:\s*$/, "")}: ` : "";
    const off = e.inactive ? " (inactive)" : "";
    const mark = (r: Row) => (r.selected ? "(*) " : "( ) ") + r.cells.join(" | ");
    const part = part_text(e, name);
    if (part) lines.push(...part.map((l) => `|  ${l}`));
    else if (e.kind === "label") lines.push(`|  ${e.label}`);
    else if (e.kind === "separator") lines.push("|  " + "-".repeat(24));
    else if (e.kind === "button") lines.push(`|  <${name}>${off}`);
    else if (e.kind === "toggle") lines.push(`|  [${e.on ? "x" : " "}] ${name}${off}`);
    else if (TYPED.includes(e.kind)) {
      lines.push(`|  ${head}[${e.text.replace(/\n/g, "\\n")}]${e.read_only ? " (read only)" : off}`);
    } else if (e.kind === "choice") {
      lines.push(`|  ${head}[${e.rows.find((r) => r.selected)?.cells[0] ?? e.text} v]${off}`
        + ` of: ${e.rows.map((r) => r.cells[0]).join(", ")}`);
    } else if (e.kind === "checkBox") {
      lines.push(`|  ${head}${e.rows.map((r) => `[${r.selected ? "x" : " "}] ${r.cells[0]}`).join("  ")}${off}`);
    } else if (e.kind === "radioBox") {
      lines.push(`|  ${head}${e.rows.map(mark).join("  ")}${off}`);
    } else {
      lines.push(`|  ${head}${e.kind}, ${e.rows.length} ${e.rows.length === 1 ? "item" : "items"}${off}${menu_text(e)}`);
      if (e.columns.length) lines.push(`|     ${e.columns.map((c) => c.title).join(" | ")}`);
      some(e.rows, mark);
    }
    if (depth) for (let i = from; i < lines.length; i++) lines[i] = lines[i].replace(/^\|  /, "|  " + "  ".repeat(depth));
  }
  const buttons = box.buttons.filter((b) => !b.hidden).map((b) => `<${shown_label(b.label)}>`);
  if (box.close_button) buttons.push("<Close>");
  lines.push(`+-- ${buttons.join(" ")}`);
  return lines.join("\n") + "\n";
}

// -- the DXL functions ---------------------------------------------------------

export function box_of(rt: any, value: any): Box {
  const box: Box = rt.need(value, "DB");
  if (box.destroyed) throw new Fault("the dialog box has been destroyed");
  return box;
}

export function element_of(rt: any, value: any, ...kinds: Kind[]): Element {
  const element: Element = rt.need(value, "DBE");
  if (element.box.destroyed) throw new Fault("the element's dialog box has been destroyed");
  if (kinds.length && !kinds.includes(element.kind)) {
    throw new Fault(`this is not supported for a ${element.kind} element (only ${kinds.join(", ")})`);
  }
  return element;
}

export function add_element(rt: any, box_value: any, kind: Kind, label: string, standard: "ok" | "apply" | null = null): Element {
  const box = box_of(rt, box_value);
  if (box.realized) throw new Fault("add every element before the dialog box is realized or shown");
  const element = new Element(box, kind, label ?? "");
  element.standard = standard;
  if (standard) box.buttons.push(element);
  else {
    element.place = box.place;
    element.full = box.full;
    box.elements.push(element);
  }
  return element;
}

/** The first `count` of a string array, every one with a value. */
export function strings(values: any[], count: number | null): string[] {
  const n = count ?? values.length;
  if (n < 0 || n > values.length) throw new Fault(`the array has ${values.length} elements, not ${n}`);
  if (n > MAX_ROWS) throw new Fault(`more than ${MAX_ROWS} items`);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (values[i] === undefined || values[i] === null) throw new Fault(`array element ${i} has no value`);
    out.push(values[i]);
  }
  return out;
}

function index_in(element: Element, i: number): Row {
  if (!(i >= 0 && i < element.rows.length)) throw new Fault(`index ${i} is out of range`);
  return element.rows[i];
}

/** Select row `i` and no other; -1 selects nothing. */
function select_only(element: Element, i: number): void {
  if (i !== -1) index_in(element, i);
  element.rows.forEach((r, n) => { r.selected = n === i; });
  element.text = "";
  element.unsettled = false;
}

const selected_index = (e: Element) => e.rows.findIndex((r) => r.selected);

function selection_known(e: Element): void {
  if (e.unsettled) {
    throw new Fault("what a choice selects after set(choice, values) is not verified: set(choice, index) first");
  }
}

const LISTS: Kind[] = ["list", "multiList", "listView"];
const OPTIONS: Kind[] = ["choice", "list", "multiList", "listView"];

/** A rich element's text, where markup and plain text would be the same string:
 * which of the two DOORS hands back or reads is not documented. */
function rich_plain(text: string, doing: string): string {
  if (/[\\{}]/.test(text)) {
    throw new Fault(`what ${doing} does with \\ { } in a rich text element is not documented, so it is not offered here`);
  }
  return text;
}

function get_string(rt: any, value: any): string {
  const e = element_of(rt, value, "field", "text", "fileName", "choice", "list", "multiList", "listView", "treeView",
    "tab", ...RICH);
  if (e.tree) return e.tree.chosen;
  if (RICH.includes(e.kind)) {
    if (e.formatted) {
      throw new Fault("what get() gives for a rich text element holding formatting is not documented, so it is "
        + "not offered here");
    }
    return rich_plain(e.text, "get()");
  }
  if (TYPED.includes(e.kind)) return e.text;
  if (e.kind === "choice") selection_known(e);
  const at = selected_index(e);
  return at < 0 ? e.text : e.rows[at].cells[0];
}

function get_int(rt: any, value: any): number {
  const e = element_of(rt, value, "checkBox", "choice", "list", "multiList", "listView", "radioBox", "slider", "tab");
  if (e.slider) return e.slider.value;
  if (e.kind === "checkBox") return e.rows.reduce((mask, r, i) => (r.selected ? mask | (1 << i) : mask), 0);
  if (e.kind === "choice") selection_known(e);
  return selected_index(e);
}

function get_bool(rt: any, value: any): boolean {
  const e = element_of(rt, value, "toggle", "field", "text", ...RICH);
  return e.kind === "toggle" ? e.on : e.read_only;
}

function flow<T extends (...args: any[]) => any>(kind: "show" | "block", impl: T): T {
  return Object.assign(impl, { flow: kind });
}

function show_box(rt: any, value: any): never {
  const dialogs = state(rt), box = box_of(rt, value);
  box.realized = box.on_screen = true;
  dialogs.shown = true;
  if (dialogs.host.interactive) paint(rt, dialogs, [box]);
  else {
    rt.out.write(render_text(box));
    rt.out.write("(Drawn as text only: nobody can use this box here, so its callbacks never run. "
      + "Run the script in the browser interface to use it.)\n");
  }
  throw new ShowStop();
}

function block_box(rt: any, value: any): never {
  const dialogs = state(rt), box = box_of(rt, value);
  box.realized = box.on_screen = box.blocking = true;
  dialogs.shown = true;
  if (!dialogs.host.interactive) {
    rt.out.write(render_text(box));
    rt.out.write("(block(): the rest of the script runs only after somebody releases or closes the box. "
      + "Nobody can here, so the script stops at this line. Run it in the browser interface.)\n");
    throw new ShowStop();
  }
  paint(rt, dialogs, [box]);
  throw new Block(box);
}

export function register(lib: Library): void {
  lib.type("DB");
  lib.type("DBE");
  lib.type("Icon");
  lib.type("DBSide_");
  lib.type("DBPlace_");

  const add = (name: string, params: string[], returns: string, impl: (...args: any[]) => any) =>
    lib.add(name, params, returns, impl);
  const constant = (name: string, value: any, type = "int") => add(name, [], type, () => value);

  // the values are this suite's own; scripts only combine them with |
  const STYLES = ["styleStandard", "styleFixed", "styleCentered", "styleFloating", "styleNoBorder", "styleThemed",
    "styleAutoParent", "styleStandardSize", "styleIsDefault"];
  STYLES.forEach((name, i) => constant(name, i ? 1 << (i - 1) : 0));
  constant("styleCentred", 1 << 1);
  ["msgInfo", "msgWarning", "msgError", "msgQuery"].forEach((name, i) => constant(name, i));
  constant("listViewOptionCheckboxes", 1);
  constant("listViewOptionMultiselect", 2);
  constant("iconNone", Object.freeze({ icon: "none" }), "Icon");

  // -- the box -----------------------------------------------------------------

  const create = (rt: any, title: string): Box => {
    const dialogs = state(rt);
    if (dialogs.boxes.length >= 100) throw new Fault("more than 100 dialog boxes");
    const box = new Box(title ?? "");
    dialogs.boxes.push(box);
    return box;
  };
  add("create", ["string"], "DB", (rt, title) => create(rt, title));
  add("create", ["string", "int"], "DB", (rt, title) => create(rt, title));
  for (const parent of ["DB", "Module"]) {
    add("create", [parent, "string"], "DB", (rt, _parent, title) => create(rt, title));
    add("create", [parent, "string", "int"], "DB", (rt, _parent, title) => create(rt, title));
  }
  for (const name of ["centered", "centred", "topMost"]) add(name, ["string"], "DB", (rt, title) => create(rt, title));

  add("show", ["DB"], "void", flow("show", show_box));
  add("block", ["DB"], "void", flow("block", block_box));
  add("release", ["DB"], "void", (rt, b) => {
    const box = box_of(rt, b);
    if (!box.blocking) throw new Fault("release: the box was not displayed with block()");
    box.on_screen = box.blocking = false;
  });
  add("realize", ["DB"], "void", (rt, b) => {
    state(rt);
    const box = box_of(rt, b);
    box.realized = box.on_screen = true;
  });
  add("hide", ["DB"], "void", (rt, b) => { box_of(rt, b).on_screen = false; });
  add("destroy", ["DB"], "void", (rt, b) => {
    const dialogs = state(rt), box = box_of(rt, b);
    if (dialogs.callback === "DBE") {
      throw new Fault("destroy must not be used within an element's callback (the manual forbids it)");
    }
    box.on_screen = false;
    box.destroyed = true;
    dialogs.boxes = dialogs.boxes.filter((each) => each !== box);
  });
  add("showing", ["DB"], "bool", (rt, b) => box_of(rt, b).on_screen);
  for (const name of ["raise", "busy", "ready"]) add(name, ["DB"], "void", (rt, b) => { box_of(rt, b); });
  add("setTitle", ["DB", "string"], "void", (rt, b, title) => { box_of(rt, b).title = title; });
  add("getTitle", ["DB"], "string", (rt, b) => box_of(rt, b).title);
  add("getParent", ["DBE"], "DB", (rt, e) => element_of(rt, e).box);

  // -- placement: accepted and approximated ------------------------------------

  const placements: Array<[string, Place, boolean | null]> = [["beside", "beside", false], ["below", "below", null],
    ["left", "below", null], ["flushLeft", "below", null], ["leftAligned", "below", null], ["right", "right", false],
    ["flushRight", "right", false], ["opposite", "opposite", false], ["full", "below", true]];
  for (const [name, place, full] of placements) {
    add(name, ["DB"], "void", (rt, b) => {
      const box = box_of(rt, b);
      box.place = place;
      if (full !== null) box.full = full;
    });
  }
  add("stacked", ["DBE"], "void", (rt, e) => { element_of(rt, e); });

  lib.operator("->", "DBE", "string", "DBSide_", (rt, e, side: string) => {
    const element = element_of(rt, e), name = side.toLowerCase();
    if (!["left", "right", "top", "bottom"].includes(name)) throw new Fault(`'${side}' is not a side of an element`);
    return { element, side: name };
  });
  lib.operator("->", "DBSide_", "string", "DBPlace_", (rt, at, how: string) => {
    const attachment = how.toLowerCase();
    if (!["flush", "spaced", "aligned", "unattached", "form", "inside"].includes(attachment)) {
      throw new Fault(`'${how}' is not an attachment`);
    }
    return { ...rt.need(at, "attachment"), attachment };
  });
  lib.operator("->", "DBPlace_", "DBE", "void", (rt, place, other) => {
    const { element, side, attachment } = rt.need(place, "attachment");
    const target = element_of(rt, other);
    if (attachment === "form" || attachment === "unattached") throw new Fault(`'${attachment}' takes no other element`);
    if (target.box !== element.box) throw new Fault("the elements are on different dialog boxes");
    if (attachment === "inside") {
      put_inside(element, target);
      return;
    }
    follow(element, target);
    const beside = (side === "left" && attachment !== "aligned") || (side === "top" && attachment === "aligned");
    if (!beside || target === element) return;
    const list: Element[] = element.box.elements;
    if (!list.includes(element) || !list.includes(target)) return;
    list.splice(list.indexOf(element), 1);
    list.splice(list.indexOf(target) + 1, 0, element);
    element.place = "beside";
  });

  // -- elements ----------------------------------------------------------------

  add("label", ["DB", "string"], "DBE", (rt, b, text) => add_element(rt, b, "label", text));
  add("separator", ["DB"], "DBE", (rt, b) => add_element(rt, b, "separator", ""));

  const field = (rt: any, b: any, label: string, initial: string, width: number, read_only = false) => {
    const e = add_element(rt, b, "field", label);
    e.text = initial ?? "";
    e.width = width;
    e.read_only = read_only;
    return e;
  };
  add("field", ["DB", "string", "string", "int"], "DBE", field);
  add("field", ["DB", "string", "string", "int", "bool"], "DBE", field);

  const text = (rt: any, b: any, label: string, initial: string, width: number, height: number, read_only: boolean) => {
    const e = add_element(rt, b, "text", label);
    e.text = initial ?? "";
    e.width = width;
    e.height = height;
    e.read_only = read_only;
    return e;
  };
  add("text", ["DB", "string", "string", "int", "bool"], "DBE",
    (rt, b, label, initial, height, read_only) => text(rt, b, label, initial, 0, height, read_only));
  add("text", ["DB", "string", "string", "int", "int", "bool"], "DBE", text);

  const file_name = (rt: any, b: any, label: string, initial: string, read_only = false) => {
    const e = add_element(rt, b, "fileName", label);
    e.text = initial ?? "";
    // `read only` here is the file selector's "open as read-only" box, which is not drawn
    void read_only;
    return e;
  };
  // fileName(box, string) is left out: the manual does not settle whether the
  // string is the label or the initial file name
  add("fileName", ["DB"], "DBE", (rt, b) => file_name(rt, b, "", ""));
  add("fileName", ["DB", "string", "string"], "DBE", (rt, b, label, initial) => file_name(rt, b, label, initial));
  add("fileName", ["DB", "string", "string", "string"], "DBE", (rt, b, initial) => file_name(rt, b, "", initial));
  add("fileName", ["DB", "string", "string", "string", "bool"], "DBE", (rt, b, initial) => file_name(rt, b, "", initial));
  add("fileName", ["DB", "string", "string", "string", "string"], "DBE",
    (rt, b, label, initial) => file_name(rt, b, label, initial));
  add("fileName", ["DB", "string", "string", "string", "string", "bool"], "DBE",
    (rt, b, label, initial) => file_name(rt, b, label, initial));
  add("set", ["DBE", "string", "string"], "void", (rt, e) => { element_of(rt, e, "fileName"); });

  // The initial value written `richText ...` arrives as markup (compiler.ts).
  const rich = (kind: "richField" | "richText", markup: boolean) =>
    (rt: any, b: any, label: string, initial: string, width: number, height: number, read_only: boolean) => {
      let doc: Doc | null = null, text = initial ?? "";
      if (markup) {
        try {
          doc = parse(text);
        } catch (e) {
          if (e instanceof RichError) throw new Fault(e.message);
          throw e;
        }
        text = plain_of(doc);
      } else rich_plain(text, "a plain initial value");
      const e = add_element(rt, b, kind, label);
      e.text = text;
      e.formatted = doc && is_formatted(doc) ? doc : null;
      e.width = Math.max(0, width);
      e.height = Math.max(0, height);
      e.read_only = read_only;
      return e;
    };
  for (const [initial, markup] of [["string", false], ["RichString_", true]] as const) {
    const one = rich("richField", markup), many = rich("richText", markup);
    add("richField", ["DB", "string", initial, "int"], "DBE", (rt, b, l, v, w) => one(rt, b, l, v, w, 0, false));
    add("richField", ["DB", "string", initial, "int", "bool"], "DBE", (rt, b, l, v, w, r) => one(rt, b, l, v, w, 0, r));
    add("richText", ["DB", "string", initial, "int", "bool"], "DBE", (rt, b, l, v, w, r) => many(rt, b, l, v, w, 0, r));
    add("richText", ["DB", "string", initial, "int", "int", "bool"], "DBE", many);
  }

  add("toggle", ["DB", "string", "bool"], "DBE", (rt, b, label, initial) => {
    const e = add_element(rt, b, "toggle", label);
    e.on = initial;
    return e;
  });

  const boxes_of = (kind: "radioBox" | "checkBox", vertical: boolean) =>
    (rt: any, b: any, label: string, choices: any[], initial: number) => {
      const names = strings(choices, null);
      if (kind === "checkBox") {
        if (names.length > 31) throw new Fault("more than 31 check boxes do not fit in an int");
        if (initial < 0 || initial >= 2 ** names.length) throw new Fault(`${initial} is not a mask of ${names.length} boxes`);
      } else if (initial < -1 || initial >= names.length) {
        throw new Fault(`index ${initial} is out of range`);
      }
      const e = add_element(rt, b, kind, label);
      e.vertical = vertical;
      e.rows = names.map(row_of);
      e.rows.forEach((r, i) => { r.selected = kind === "checkBox" ? Boolean(initial & (1 << i)) : i === initial; });
      return e;
    };
  const shape = ["DB", "string", "string[]", "int"];
  add("radioBox", shape, "DBE", boxes_of("radioBox", false));
  add("verticalRadioBox", shape, "DBE", boxes_of("radioBox", true));
  add("checkBox", shape, "DBE", boxes_of("checkBox", false));
  add("verticalCheckBox", shape, "DBE", boxes_of("checkBox", true));

  const choice = (rt: any, b: any, label: string, values: any[], count: number | null, initial: number,
    width = 0, editable = false) => {
    const names = strings(values, count);
    if (!(initial >= -1 && (initial < names.length || (initial === 0 && !names.length)))) {
      throw new Fault(`index ${initial} is out of range`);
    }
    const e = add_element(rt, b, "choice", label);
    e.rows = names.map(row_of);
    if (e.rows[initial]) e.rows[initial].selected = true;
    e.width = Math.max(0, width);
    e.editable = editable;
    return e;
  };
  add("choice", ["DB", "string", "string[]", "int"], "DBE", (rt, b, l, v, initial) => choice(rt, b, l, v, null, initial));
  add("choice", ["DB", "string", "string[]", "int", "int"], "DBE",
    (rt, b, l, v, count, initial) => choice(rt, b, l, v, count, initial));
  add("choice", ["DB", "string", "string[]", "int", "int", "bool"], "DBE",
    (rt, b, l, v, initial, width, editable) => choice(rt, b, l, v, null, initial, width, editable));
  add("choice", ["DB", "string", "string[]", "int", "int", "int", "bool"], "DBE",
    (rt, b, l, v, count, initial, width, editable) => choice(rt, b, l, v, count, initial, width, editable));

  for (const kind of ["list", "multiList"] as const) {
    const list = (rt: any, b: any, label: string, width: number, visible: number, values: any[], count: number | null) => {
      const e = add_element(rt, b, kind, label);
      e.rows = strings(values, count).map(row_of);
      e.multi = kind === "multiList";
      e.width = width;
      e.height = visible;
      return e;
    };
    add(kind, ["DB", "string", "int", "string[]"], "DBE", (rt, b, l, visible, v) => list(rt, b, l, 0, visible, v, null));
    add(kind, ["DB", "string", "int", "string[]", "int"], "DBE",
      (rt, b, l, visible, v, n) => list(rt, b, l, 0, visible, v, n));
    add(kind, ["DB", "string", "int", "int", "string[]"], "DBE",
      (rt, b, l, width, visible, v) => list(rt, b, l, width, visible, v, null));
    add(kind, ["DB", "string", "int", "int", "string[]", "int"], "DBE", list);
  }

  // the drag-and-drop callback form of listView is not offered
  const list_view = (rt: any, b: any, options: number, width: number, lines: number, values: any[],
    count: number | null) => {
    if (options & ~3) throw new Fault("only the check box and multi-select list view options are offered");
    const e = add_element(rt, b, "listView", "");
    e.rows = strings(values, count).map(row_of);
    e.checkboxes = Boolean(options & 1);
    e.multi = Boolean(options & 2);
    e.width = width;
    e.height = lines;
    return e;
  };
  add("listView", ["DB", "int", "int", "int", "string[]"], "DBE",
    (rt, b, options, width, lines, v) => list_view(rt, b, options, width, lines, v, null));
  add("listView", ["DB", "int", "int", "int", "string[]", "int"], "DBE", list_view);

  const view_of = (rt: any, value: any): Element => {
    const e = element_of(rt, value, "listView");
    if (!e.box.realized) throw new Fault("realize the dialog box before working with list view columns and rows");
    return e;
  };
  add("insertColumn", ["DBE", "int", "string", "int", "Icon"], "void", (rt, v, at, title, width) => {
    const e = view_of(rt, v);
    if (at !== e.columns.length) {
      throw new Fault(`add list view columns in order: the next one is ${e.columns.length}, not ${at}`);
    }
    if (e.columns.length >= 100) throw new Fault("more than 100 columns");
    e.columns.push({ title: title ?? "", width });
  });
  const cell = (e: Element, row: number, column: number): Row => {
    const found = index_in(e, row);
    if (!(column >= 0 && column < e.columns.length)) throw new Fault(`there is no column ${column}`);
    return found;
  };
  add("set", ["DBE", "int", "int", "string"], "void", (rt, v, row, column, value) => {
    const found = cell(view_of(rt, v), row, column);
    while (found.cells.length < column) found.cells.push("");
    found.cells[column] = value;
  });
  add("getColumnValue", ["DBE", "int", "int"], "string",
    (rt, v, row, column) => cell(view_of(rt, v), row, column).cells[column] ?? "");
  const checked = (rt: any, v: any, i: number): Row => {
    const e = element_of(rt, v, "listView");
    if (!e.checkboxes) throw new Fault("the list view was not created with check boxes");
    return index_in(e, i);
  };
  add("getCheck", ["DBE", "int"], "bool", (rt, v, i) => checked(rt, v, i).checked);
  add("setCheck", ["DBE", "int", "bool"], "void", (rt, v, i, on) => { checked(rt, v, i).checked = on; });
  add("selectedElems", ["DBE"], "int", (rt, v) => element_of(rt, v, "listView").rows.filter((r) => r.selected).length);

  // -- element operations ------------------------------------------------------

  add("get", ["DBE"], "string", get_string);
  add("get", ["DBE"], "int", get_int);
  add("get", ["DBE"], "bool", get_bool);
  add("get", ["DBE", "int"], "string", (rt, v, i) => index_in(element_of(rt, v, "listView", "choice", "list",
    "multiList"), i).cells[0]);

  add("set", ["DBE", "string"], "void", (rt, v, value) => {
    const e = element_of(rt, v, "field", "text", "fileName", "label", "frame", "treeView", "tab", ...RICH);
    if (RICH.includes(e.kind)) {
      e.text = rich_plain(value ?? "", "set()");
      e.formatted = null;
      e.edited = false;
    } else if (e.tree) choose_path(e, value);
    else if (e.kind === "tab") {
      const at = e.rows.findIndex((r) => r.cells[0] === value);
      if (at < 0) throw new Fault(`there is no tab '${value}'`);
      select_only(e, at);
    } else if (e.kind === "label" || e.kind === "frame") e.label = value;
    else {
      e.text = value;
      e.edited = false;
    }
  });
  const from_buffer = (rt: any, v: any, buffer: any) => {
    const e = element_of(rt, v, "field", "text");
    e.text = rt.text("Buffer", rt.need(buffer, "Buffer"));
    e.edited = false;
  };
  add("set", ["DBE", "Buffer"], "void", from_buffer);
  add("setFromBuffer", ["DBE", "Buffer"], "void", from_buffer);
  add("getBuffer", ["DBE"], "Buffer", (rt, v) => new Buffer(element_of(rt, v, "field", "text").text));
  add("modified", ["DBE"], "bool", (rt, v) => element_of(rt, v, "field", "text", ...RICH).edited);
  add("setFocus", ["DBE"], "void", (rt, v) => { state(rt).focus = element_of(rt, v).id; });
  add("set", ["DBE", "bool"], "void", (rt, v, value) => {
    const e = element_of(rt, v, "toggle", "field", "text", ...RICH);
    if (e.kind === "toggle") e.on = value;
    else e.read_only = value;
  });
  add("set", ["DBE", "int"], "void", (rt, v, value) => {
    const e = element_of(rt, v, "choice", "checkBox", "list", "multiList", "listView", "radioBox", "slider", "tab");
    if (e.slider) {
      if (!(value >= e.slider.min && value <= e.slider.max)) {
        throw new Fault(`${value} is outside the slider's ${e.slider.min} to ${e.slider.max}`);
      }
      e.slider.value = value;
      return;
    }
    if (e.kind === "tab") index_in(e, value);
    if (e.kind === "checkBox") {
      if (value < -1 || value >= 2 ** e.rows.length) throw new Fault(`${value} is not a mask of these boxes`);
      e.rows.forEach((r, i) => { r.selected = value > 0 && Boolean(value & (1 << i)); });
      return;
    }
    if (e.multi && value !== -1 && e.rows.some((r, i) => r.selected && i !== value)) {
      throw new Fault("what set(element, index) does to the other selected items is not verified: "
        + "use set(element, index, bool)");
    }
    select_only(e, value);
  });
  add("set", ["DBE", "int", "bool"], "void", (rt, v, i, on) => {
    const e = element_of(rt, v, ...LISTS);
    const found = index_in(e, i);
    if (on && !e.multi) select_only(e, i);
    else found.selected = on;
  });
  const replace = (rt: any, v: any, values: any[], count: number | null) => {
    const e = element_of(rt, v, "choice");
    e.rows = strings(values, count).map(row_of);
    e.text = "";
    e.unsettled = true;
  };
  add("set", ["DBE", "string[]"], "void", (rt, v, values) => replace(rt, v, values, null));
  add("set", ["DBE", "string[]", "int"], "void", replace);

  add("selected", ["DBE", "int"], "bool", (rt, v, i) => index_in(element_of(rt, v, ...LISTS), i).selected);
  add("noElems", ["DBE"], "int", (rt, v) => element_of(rt, v, ...OPTIONS, "tab").rows.length);
  add("empty", ["DBE"], "void", (rt, v) => {
    const e = element_of(rt, v, ...OPTIONS, "treeView");
    if (e.tree) return empty_tree(e);
    e.rows = [];
    e.text = "";
    e.unsettled = false;
  });
  add("delete", ["DBE", "int"], "void", (rt, v, i) => {
    const e = element_of(rt, v, ...OPTIONS);
    index_in(e, i);
    e.rows.splice(i, 1);
  });
  const insert = (rt: any, v: any, i: number, value: string) => {
    let e = element_of(rt, v, ...OPTIONS);
    if (e.kind === "listView") {
      e = view_of(rt, v);
      if (!e.columns.length) throw new Fault("insert a column before inserting list view rows");
    }
    if (!(i >= 0 && i <= e.rows.length)) throw new Fault(`index ${i} is out of range`);
    if (e.rows.length >= MAX_ROWS) throw new Fault(`more than ${MAX_ROWS} items`);
    e.rows.splice(i, 0, row_of(value ?? ""));
  };
  add("insert", ["DBE", "int", "string"], "void", insert);
  add("insert", ["DBE", "int", "string", "Icon"], "void", (rt, v, i, value) => {
    element_of(rt, v, "listView");
    insert(rt, v, i, value);
  });

  for (const [var_type, pick] of [["string", (r: Row, _i: number) => r.cells[0]], ["int", (_r: Row, i: number) => i]] as const) {
    lib.loop("DBE", var_type, (rt, v) => element_of(rt, v, ...LISTS).rows
      .flatMap((r, i) => (r.selected ? [pick(r, i)] : [])));
  }

  add("active", ["DBE"], "void", (rt, v) => { element_of(rt, v).inactive = false; });
  add("inactive", ["DBE"], "void", (rt, v) => {
    const e = element_of(rt, v);
    if (e.kind === "frame") throw new Fault("whether inactive(frame) greys what is inside is not verified: grey each element");
    e.inactive = true;
  });
  add("hide", ["DBE"], "void", (rt, v) => { element_of(rt, v).hidden = true; });
  add("show", ["DBE"], "void", (rt, v) => { element_of(rt, v).hidden = false; });

  // -- callbacks on elements ----------------------------------------------------

  add("set", ["DBE", "void(DBE)"], "void", (rt, v, callback) => {
    const e = element_of(rt, v);
    if (e.kind === "listView") throw new Fault("set(listView, void(DBE)) is a run-time error in DXL");
    element_of(rt, v, "toggle", "radioBox", "checkBox", "choice", "list", "multiList", "field", "treeView", "slider",
      "tab").callbacks.select = callback;
  });
  add("set", ["DBE", "void(DBE)", "void(DBE)"], "void", (rt, v, select, activate) => {
    Object.assign(element_of(rt, v, "list", "multiList", "treeView").callbacks, { select, activate });
  });
  add("set", ["DBE", "void(DBE,int)"], "void", (rt, v, check) => {
    checked_view(rt, v).callbacks.check = check;
  });
  const checked_view = (rt: any, v: any): Element => {
    const e = element_of(rt, v, "listView");
    if (!e.checkboxes) throw new Fault("the list view was not created with check boxes");
    return e;
  };
  add("set", ["DBE", "void(DBE,int)", "void(DBE,int)", "void(DBE,int)"], "void", (rt, v, select, deselect, activate) => {
    Object.assign(element_of(rt, v, "listView").callbacks, { select, deselect, activate });
  });

  // -- buttons ------------------------------------------------------------------

  const button = (rt: any, b: any, label: string, press: Callback, style = 0) => {
    const e = add_element(rt, b, "button", label);
    e.callbacks.press = press;
    e.is_default = Boolean(style & (1 << 7));
    return e;
  };
  add("button", ["DB", "string", "void(DBE)"], "DBE", (rt, b, label, cb) => button(rt, b, label, cb));
  add("button", ["DB", "string", "void(DBE)", "bool"], "DBE", (rt, b, label, cb) => button(rt, b, label, cb));
  add("button", ["DB", "string", "void(DBE)", "int"], "DBE", button);
  add("button", ["DB", "string", "void(DBE)", "bool", "int"], "DBE", (rt, b, label, cb) => button(rt, b, label, cb));
  add("button", ["DB", "string", "void(DBE)", "int", "int"], "DBE", (rt, b, label, cb, style) => button(rt, b, label, cb, style));

  for (const [name, standard, usual] of [["ok", "ok", "OK"], ["apply", "apply", "Apply"]] as const) {
    const make = (rt: any, b: any, label: string, press: Callback) => {
      const e = add_element(rt, b, "button", label, standard);
      e.callbacks.press = press;
      return e;
    };
    add(name, ["DB", "string", "void(DB)"], "DBE", make);
    add(name, ["DB", "void(DB)"], "DBE", (rt, b, press) => make(rt, b, usual, press));
  }
  add("close", ["DB", "bool", "void(DB)"], "void", (rt, b, include, action) => {
    const box = box_of(rt, b);
    box.close_button = include;
    box.close_action = action;
  });

  // -- message boxes ------------------------------------------------------------

  for (const [name, kind] of [["ack", "ack"], ["acknowledge", "ack"], ["infoBox", "info"], ["warningBox", "warning"],
    ["errorBox", "error"]]) {
    const say = (rt: any, message: string) => {
      rt.out.write(`[${kind}] ${message}\n`);
      dialogs_of(rt)?.message(kind, message);
    };
    // the one-argument forms of all but acknowledge are in core.ts
    if (name === "acknowledge") add(name, ["string"], "void", say);
    add(name, ["DB", "string"], "void", (rt, _box, message) => say(rt, message));
  }
  add("confirm", ["DB", "string"], "bool", (rt, _box, question) => confirm(rt, question));
  add("confirm", ["string", "int"], "bool", (rt, question) => confirm(rt, question));
  add("confirm", ["DB", "string", "int"], "bool", (rt, _box, question) => confirm(rt, question));

  // -- progress bar --------------------------------------------------------------

  const running = (rt: any): [Dialogs, Progress] => {
    const dialogs = state(rt);
    if (!dialogs.progress) throw new Fault("there is no progress bar: call progressStart first");
    return [dialogs, dialogs.progress];
  };
  const within = (position: number, limit: number) => {
    if (!(position >= 0 && position <= limit)) throw new Fault(`progress ${position} is outside 0 to ${limit}`);
  };
  add("progressStart", ["DB", "string", "string", "int"], "void", (rt, b, title, message, limit) => {
    const dialogs = state(rt);
    if (b !== null && b !== undefined) box_of(rt, b);
    if (limit < 0) throw new Fault("the limit of a progress bar cannot be negative");
    dialogs.progress = { title, message, position: 0, limit };
    dialogs.tell_progress(true);
  });
  add("progressStep", ["int"], "void", (rt, position) => {
    const [dialogs, progress] = running(rt);
    within(position, progress.limit);
    progress.position = position;
    dialogs.tell_progress();
  });
  add("progressMessage", ["string"], "void", (rt, message) => {
    const [dialogs, progress] = running(rt);
    progress.message = message;
    dialogs.tell_progress();
  });
  add("progressRange", ["string", "int", "int"], "void", (rt, message, position, limit) => {
    const [dialogs, progress] = running(rt);
    within(position, limit);
    Object.assign(progress, { message, position, limit });
    dialogs.tell_progress();
  });
  // its Cancel button cannot reach a running script here; the Stop button ends one
  add("progressCancelled", [], "bool", (rt) => { running(rt); return false; });
  add("progressStop", [], "void", (rt) => { state(rt).stop_progress(); });

  register_parts(lib);
}
