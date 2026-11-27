// A script's dialog boxes on the page. The engine in the worker holds the model
// (dxl/lib/dialogs.ts); this draws what it describes and sends back what the
// person does. The boxes do not block the rest of the page. Bundled into
// transport.js, so it runs before app.js and uses app.js's helpers only once
// the page is up.

declare const DXL: any;
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function act(work: () => unknown): Promise<void>;
declare function writtenFile(path: string, text: string): any;
declare function loadTree(): Promise<void>;
declare function refresh(): Promise<void>;
declare function richNodes(doc: any): any[];

/** Passes one event to the engine; resolves with its reply. */
export type Send = (session: number, event: any) => Promise<any>;

type Widget = {
  node: any;
  spec: any;
  /** What the person has set, as the engine takes it; null if nothing can be set. */
  read(): any;
  /** Where the elements inside a frame or tab strip go. */
  inner?: any;
};
type Panel = { node: any; menu: any; body: any; foot: any; status: any; fault: any; title: any; layout: string;
  placed: string; widgets: Map<number, Widget> };

let session = 0;
let send: Send | null = null;
let panels = new Map<number, Panel>();
let message_box: any = null;
let progress_box: any = null;
let popup_node: any = null;
let anchor = { x: 8, y: 80 }; // where the last menu was asked for

/** Take every box off the page (a new run, a stopped or replaced engine). */
export function clear(): void {
  for (const panel of panels.values()) panel.node.remove();
  panels = new Map();
  message_box?.remove();
  message_box = null;
  close_popup();
  session = 0;
}

export function progress(state: any): void {
  if (!state) {
    progress_box?.remove();
    progress_box = null;
    return;
  }
  if (!progress_box) {
    progress_box = h("div", { class: "dxlprogress", role: "status" },
      h("div", { class: "heading" }), h("div", {}), h("progress", {}));
    document.body.append(progress_box);
  }
  const [heading, message, bar] = progress_box.children;
  heading.textContent = state.title;
  message.textContent = state.message;
  bar.max = Math.max(1, state.limit);
  bar.value = state.position;
}

export function show(spec: any, sender: Send): void {
  send = sender;
  session = spec.session;
  draw(spec);
}

function draw(spec: any): void {
  const wanted = new Set<number>(spec.boxes.map((b: any) => b.id));
  for (const [id, panel] of panels) {
    if (!wanted.has(id)) {
      panel.node.remove();
      panels.delete(id);
    }
  }
  spec.boxes.forEach((box: any, i: number) => {
    let panel = panels.get(box.id);
    if (!panel) {
      panel = make_panel(box);
      panels.set(box.id, panel);
      document.body.append(panel.node);
      fill(panel, box);
      const width = panel.node.offsetWidth;
      panel.node.style.left = Math.max(4, (window.innerWidth - width) / 2 + i * 24) + "px";
      panel.node.style.top = 64 + i * 24 + "px";
    } else fill(panel, box);
    place(panel, box.geometry);
  });
  if (spec.focus) focus_on(spec.focus);
  if (spec.popup) show_popup(spec.popup);
  if (spec.messages?.length) show_messages(spec.messages);
}

/** Where and how big the script said. Applied when it changes, so that a box the
 * person has since dragged stays put. Screen places become places on the page. */
function place(panel: Panel, geometry: any): void {
  const key = JSON.stringify(geometry ?? null);
  if (key === panel.placed) return;
  panel.placed = key;
  if (!geometry) return;
  const { x, y, width, height, centred } = geometry, style = panel.node.style;
  const within = (value: number, most: number) => Math.max(0, Math.min(value, most)) + "px";
  if (width) {
    style.minWidth = "0";
    style.maxWidth = "calc(100vw - 8px)";
    style.width = Math.max(120, Math.min(width, window.innerWidth - 8)) + "px";
  }
  if (height) style.height = Math.max(60, Math.min(height, window.innerHeight - 8)) + "px";
  if (centred) {
    style.left = within((window.innerWidth - panel.node.offsetWidth) / 2, window.innerWidth);
    style.top = within((window.innerHeight - panel.node.offsetHeight) / 2, window.innerHeight);
  } else if (x !== undefined) {
    style.left = within(x, window.innerWidth - 60);
    style.top = within(y, window.innerHeight - 40);
  }
}

function focus_on(element: number): void {
  const can = "input, textarea, select, button, [tabindex], [contenteditable]";
  for (const panel of panels.values()) {
    const node = panel.widgets.get(element)?.node;
    if (node) (node.matches(can) ? node : node.querySelector(can))?.focus();
  }
}

function show_messages(messages: any[]): void {
  message_box?.remove();
  const close = () => { message_box?.remove(); message_box = null; };
  const names: Record<string, string> = { ack: "Message", info: "Information", warning: "Warning", error: "Error",
    confirm: "confirm() was answered by the checkbox in the DXL window" };
  message_box = h("section", { class: "dxlbox dxlmessage", role: "alertdialog", "aria-label": "Script message",
    onkeydown: (e: any) => e.stopPropagation() },
    h("div", { class: "titlebar" }, "Script message"),
    h("div", { class: "content" }, messages.map((m) => h("div", { class: "message " + m.kind },
      h("div", { class: "heading" }, names[m.kind] ?? m.kind), h("div", { class: "text" }, m.text)))),
    h("div", { class: "buttons" }, h("button", { type: "button", class: "primary", onclick: close }, "OK")));
  document.body.append(message_box);
}

function make_panel(box: any): Panel {
  const title = h("span", {});
  const bar = h("div", { class: "titlebar" }, title,
    h("button", { type: "button", title: "Close", onclick: () => event(box.id, { kind: "close" }) }, "x"));
  const body = h("div", { class: "content" });
  const fault = h("div", { class: "problem" });
  const foot = h("div", { class: "buttons" });
  const menu = h("div", { class: "dxlmenubar" });
  const status = h("div", { class: "dxlstatuses" });
  const node = h("section", { class: "dxlbox", role: "dialog", "data-box": String(box.id),
    onkeydown: (e: any) => e.stopPropagation() }, bar, menu, body, fault, foot, status);
  // drag by the title bar
  bar.addEventListener("pointerdown", (down: any) => {
    if (down.target.tagName === "BUTTON" || down.pointerType === "touch") return;
    const dx = down.clientX - node.offsetLeft, dy = down.clientY - node.offsetTop;
    const move = (e: any) => {
      node.style.left = Math.min(window.innerWidth - 60, Math.max(60 - node.offsetWidth, e.clientX - dx)) + "px";
      node.style.top = Math.min(window.innerHeight - 40, Math.max(0, e.clientY - dy)) + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  return { node, menu, body, foot, status, fault, title, layout: "", placed: "null", widgets: new Map() };
}

/** The widget's description as it would be had the engine taken what the person set. */
function as_set(widget: Widget): any {
  const spec = JSON.parse(JSON.stringify(widget.spec));
  const value = widget.read();
  if (!value) return spec;
  if (value.text !== undefined) spec.text = value.text;
  if (value.on !== undefined) spec.on = value.on;
  if (value.path !== undefined) spec.chosen = value.path;
  if (value.position !== undefined) spec.slider.value = value.position;
  if (value.selected) spec.rows.forEach((r: any, i: number) => { r.selected = value.selected.includes(i); });
  if (value.checked) spec.rows.forEach((r: any, i: number) => { r.checked = value.checked.includes(i); });
  return spec;
}

function fill(panel: Panel, box: any): void {
  panel.title.textContent = box.title;
  panel.node.setAttribute("aria-label", box.title);
  const all = [...box.elements, ...box.buttons];
  // a widget is remade only if the script changed it, so that typing and focus survive
  for (const spec of all) {
    const old = panel.widgets.get(spec.id);
    if (old && JSON.stringify(as_set(old)) === JSON.stringify(spec)) {
      old.spec = spec;
      continue;
    }
    const made = make_widget(box.id, spec);
    if (old) old.node.replaceWith(made.node);
    panel.widgets.set(spec.id, made);
    if (made.inner) panel.layout = ""; // what was inside has to go back in
  }
  const layout = JSON.stringify([box.closeButton, all.map((e: any) => [e.id, e.place, e.hidden, e.parent, e.pair])]);
  if (layout === panel.layout) return;
  panel.layout = layout;
  arrange(panel, box);
  const standard = box.buttons.filter((b: any) => !b.hidden).map((b: any) => panel.widgets.get(b.id)!.node);
  if (box.closeButton) {
    standard.push(h("button", { type: "button", onclick: () => event(box.id, { kind: "close" }) }, "Close"));
  }
  panel.foot.replaceChildren(...standard);
}

/** Put the elements where they go: rows, inside frames and tab strips, either
 * side of a splitter, menu bar at the top and status bar at the bottom. */
function arrange(panel: Panel, box: any): void {
  const node_of = (id: number) => panel.widgets.get(id)!.node;
  const shown = box.elements.filter((e: any) => !e.hidden);
  const edge = (kind: string) => shown.filter((e: any) => e.kind === kind).map((e: any) => node_of(e.id));
  panel.menu.replaceChildren(...edge("menuBar"));
  panel.status.replaceChildren(...edge("statusBar"));
  const splits = new Map<number, any>();
  for (const split of shown.filter((e: any) => e.kind === "splitter")) {
    const pair = split.pair.map((id: number) => shown.find((e: any) => e.id === id));
    if (pair.every((e: any) => e && e.parent === split.parent)) {
      for (const id of [split.id, ...split.pair]) splits.set(id, split);
    }
  }
  const placed = new Set<number>();
  const rows_in = (parent: number | undefined): any[] => {
    const rows: any[] = [];
    for (const spec of shown) {
      if (spec.parent !== parent || spec.kind === "menuBar" || spec.kind === "statusBar" || placed.has(spec.id)) continue;
      const split = splits.get(spec.id);
      let node = node_of(spec.id);
      if (split) {
        for (const id of [split.id, ...split.pair]) placed.add(id);
        node = h("div", { class: "element dxlsplit full" },
          node_of(split.pair[0]), node_of(split.id), node_of(split.pair[1]));
      } else if (spec.kind === "splitter") continue;
      const joined = (spec.place === "beside" || spec.place === "opposite") && rows.length;
      if (!joined) rows.push(h("div", { class: spec.place === "right" ? "row end" : "row" }));
      node.classList.toggle("opposite", spec.place === "opposite");
      rows[rows.length - 1].append(node);
      const inner = panel.widgets.get(spec.id)!.inner;
      if (inner) inner.replaceChildren(...rows_in(spec.id));
    }
    return rows;
  };
  panel.body.replaceChildren(...rows_in(undefined));
}

// -- menus: the engine is asked how the entries stand each time one is opened ----

function close_popup(): void {
  if (!popup_node) return;
  popup_node.node.remove();
  document.removeEventListener("pointerdown", popup_node.outside, true);
  popup_node = null;
}

function ask_menu(box: number, element: number, menu: number, at: { clientX: number; clientY: number }): void {
  close_popup();
  anchor = { x: at.clientX, y: at.clientY };
  event(box, { kind: "menu", element, menu });
}

function show_popup(popup: any): void {
  close_popup();
  let owner: any = null, box = 0;
  for (const [id, panel] of panels) {
    const widget = panel.widgets.get(popup.element);
    if (widget) { owner = widget.spec; box = id; }
  }
  if (!owner?.entries) return;
  const { entries, help, offHelp } = owner.entries[popup.menu];
  const items = entries.map((entry: string, i: number) => {
    const sub = entry.startsWith(">"), label = sub ? entry.slice(1) : entry;
    const state = popup.states[i];
    // an entry with a sub-menu under it only heads it
    if (!sub && entries[i + 1]?.startsWith(">")) return h("div", { class: "group" }, label);
    return h("button", { type: "button", role: "menuitem", disabled: state === 0, class: sub ? "sub" : "",
      title: (state === 0 ? offHelp[i] : help[i]) || "",
      "aria-checked": state === 2 ? "true" : null,
      onclick: () => { close_popup(); event(box, { kind: "choose", element: popup.element, menu: popup.menu, entry: i }); } },
      h("span", { class: "tick" }, state === 2 ? "\u2713" : ""), label);
  });
  const node = h("div", { class: "dxlpopup", role: "menu",
    onkeydown: (e: any) => { e.stopPropagation(); if (e.key === "Escape") close_popup(); } }, items);
  const outside = (e: any) => { if (!node.contains(e.target)) close_popup(); };
  document.addEventListener("pointerdown", outside, true);
  document.body.append(node);
  node.style.left = Math.max(2, Math.min(anchor.x, window.innerWidth - node.offsetWidth - 4)) + "px";
  node.style.top = Math.max(2, Math.min(anchor.y, window.innerHeight - node.offsetHeight - 4)) + "px";
  popup_node = { node, outside };
  node.querySelector("button:not([disabled])")?.focus();
}

/** A list, tree or canvas with a right-click menu also gets a button for it, for
 * where there is no right click. */
function with_menu(box: number, spec: any, widget: Widget): Widget {
  if (!spec.menus || spec.inactive) return widget;
  widget.node.addEventListener("contextmenu", (e: any) => { e.preventDefault(); ask_menu(box, spec.id, 0, e); });
  const button = h("button", { type: "button", class: "dxlmenubutton",
    onclick: (e: any) => ask_menu(box, spec.id, 0, e) }, `${spec.menus[0] || "Menu"} \u25be`);
  return { ...widget, node: h("div", { class: "element stacked" + (spec.full ? " full" : "") }, widget.node, button) };
}

// -- tree views ------------------------------------------------------------------

function make_tree(box: number, spec: any): Widget {
  let chosen: string = spec.chosen;
  const labels = new Map<string, any>();
  const paint = () => labels.forEach((label, path) => {
    label.classList.toggle("picked", path === chosen);
    label.setAttribute("aria-selected", String(path === chosen));
  });
  const send_path = (kind: string, path: string) => event(box, { kind, element: spec.id, path });
  const choose = (path: string) => {
    if (spec.inactive || chosen === path) return;
    chosen = path;
    paint();
    if (spec.events.includes("select")) send_path("select", path);
  };
  const list = (nodes: any[], above: string, role: string): any => h("ul", { role },
    nodes.map((node: any) => {
      const path = above ? `${above}/${node.name}` : node.name;
      const more = node.kids.length > 0;
      const turn = () => { if (!spec.inactive && more) send_path(node.open ? "collapse" : "expand", path); };
      const label = h("span", { class: "name", tabindex: "0", onclick: () => choose(path),
        ondblclick: () => {
          if (spec.inactive) return;
          if (spec.events.includes("activate")) send_path("activate", path);
          else turn();
        },
        onkeydown: (e: any) => {
          if (e.key === " ") { e.preventDefault(); choose(path); }
          else if (e.key === "Enter" && spec.events.includes("activate")) send_path("activate", path);
          else if (e.key === "ArrowRight" && !node.open) turn();
          else if (e.key === "ArrowLeft" && node.open) turn();
        } }, node.name);
      labels.set(path, label);
      const knob = more
        ? h("button", { type: "button", class: "knob", disabled: spec.inactive,
          "aria-label": `${node.open ? "close" : "open"} ${node.name}`, onclick: turn }, node.open ? "-" : "+")
        : h("span", { class: "knob" });
      return h("li", { role: "treeitem", "aria-expanded": more ? String(node.open) : null }, knob, label,
        more && node.open ? list(node.kids, path, "group") : null);
    }));
  const holder = h("div", { class: "dxllist dxltree" + (spec.inactive ? " off" : "") }, list(spec.tree, "", "tree"));
  if (spec.height > 0) holder.style.height = Math.min(Math.max(spec.height, 3), 25) * 1.7 + "em";
  if (spec.width > 0) holder.style.width = Math.min(spec.width, 900) + "px";
  paint();
  const node = h("div", { class: "element stacked" + (spec.full || !spec.width ? " full" : "") }, holder);
  return { node, spec, read: () => ({ id: spec.id, path: chosen }) };
}

// -- canvases --------------------------------------------------------------------

function make_canvas(spec: any): Widget {
  const { width, height, ops } = spec.canvas;
  const canvas = h("canvas", { class: "element dxlcanvas", width, height, role: "img",
    "aria-label": ops.filter((o: any) => o[0] === "text").map((o: any) => o[4]).join(", ") || "drawing" });
  const g = canvas.getContext("2d");
  for (const [op, colour, ...rest] of ops) {
    const [a, b, c, d, size, bold] = rest;
    g.fillStyle = g.strokeStyle = colour;
    if (op === "polygon") {
      g.beginPath();
      for (let i = 0; i < rest.length; i += 2) g[i ? "lineTo" : "moveTo"](rest[i] + 0.5, rest[i + 1] + 0.5);
      g.closePath();
      g.stroke();
    } else if (op === "rect") g.fillRect(a, b, c, d);
    else if (op === "box") g.strokeRect(a + 0.5, b + 0.5, c, d);
    else if (op === "ellipse") {
      g.beginPath();
      g.ellipse(a + c / 2, b + d / 2, Math.abs(c / 2), Math.abs(d / 2), 0, 0, 2 * Math.PI);
      g.fill();
    } else if (op === "line") {
      g.beginPath();
      g.moveTo(a + 0.5, b + 0.5);
      g.lineTo(c + 0.5, d + 0.5);
      g.stroke();
    } else {
      // text: [x, y, string, angle anticlockwise, size, bold]
      g.save();
      g.translate(a, b);
      g.rotate(-d * Math.PI / 180);
      g.font = `${bold ? "bold " : ""}${size}px sans-serif`;
      g.fillText(c, 0, 0);
      g.restore();
    }
  }
  return { node: canvas, spec, read: () => null };
}

// -- tool bars: each tool is a button named by its tool tip, since there are no icons

function make_tools(box: number, spec: any): Widget {
  const { name, tools } = spec.toolbar;
  const use = (entry: number, more: any = {}) => event(box, { kind: "tool", element: spec.id, entry, ...more });
  const items = tools.map((tool: any, i: number) => {
    if (tool.state === 3) return null;
    if (tool.type === 4) return h("span", { class: "gap" });
    const off = spec.inactive || tool.state === 0 || tool.state === null;
    const title = (off ? tool.off_help : tool.help) || tool.tip;
    if (tool.type !== 3 && tool.type !== 5) {
      return h("button", { type: "button", disabled: off, title, "aria-pressed": tool.state === 2 ? "true" : null,
        onclick: () => use(i) }, tool.tip || `tool ${i}`);
    }
    const select = h("select", { disabled: off, title, "aria-label": tool.tip },
      h("option", { value: "-1" }, ""), tool.items.map((text: string, n: number) => h("option", { value: String(n) }, text)));
    select.value = String(tool.chosen);
    if (tool.width > 0) select.style.width = Math.min(Math.max(tool.width, 40), 400) + "px";
    select.addEventListener("change", () => { if (select.value !== "-1") use(i, { row: Number(select.value) }); });
    if (tool.type === 3) return select;
    const typed = h("input", { type: "text", value: tool.typed, disabled: off, placeholder: "or type",
      "aria-label": tool.tip + ", typed" });
    typed.addEventListener("change", () => use(i, { text: typed.value }));
    return h("span", {}, select, typed);
  });
  const node = h("div", { class: "element dxltools", role: "toolbar", "aria-label": name || "tool bar" },
    name ? h("span", { class: "name" }, name) : null, items);
  return { node, spec, read: () => null };
}

// -- frames, tabs, sliders, bars and splitters -------------------------------------

function sized(node: any, spec: any): any {
  if (spec.width > 0) node.style.minWidth = `min(${Math.min(spec.width, 900)}px, 100%)`;
  if (spec.height > 0) node.style.minHeight = Math.min(spec.height, 600) + "px";
  return node;
}

function make_part(box: number, spec: any, fire: (kind: string) => void): Widget | null {
  if (spec.kind === "treeView") return with_menu(box, spec, make_tree(box, spec));
  if (spec.kind === "canvas") return with_menu(box, spec, make_canvas(spec));
  if (spec.kind === "toolBar") return make_tools(box, spec);
  if (spec.kind === "frame") {
    const inner = h("div", { class: "inner" });
    const node = sized(h("div", { class: "element dxlframe" + (spec.full ? " full" : ""), role: "group",
      "aria-label": spec.label }, spec.label ? h("div", { class: "legend" }, spec.label) : null, inner), spec);
    return { node, spec, read: () => null, inner };
  }
  if (spec.kind === "tab") {
    let at = spec.rows.findIndex((r: any) => r.selected);
    const inner = h("div", { class: "inner" });
    const tabs = spec.rows.map((r: any, i: number) => h("button", { type: "button", role: "tab", disabled: spec.inactive,
      "aria-selected": String(i === at), onclick: () => {
        if (i === at) return;
        at = i;
        tabs.forEach((t: any, n: number) => t.setAttribute("aria-selected", String(n === at)));
        fire("select");
      } }, r.cells[0]));
    const node = sized(h("div", { class: "element dxltabs full" }, h("div", { class: "strip", role: "tablist" }, tabs), inner),
      spec);
    return { node, spec, read: () => ({ id: spec.id, selected: [at] }), inner };
  }
  if (spec.kind === "slider") {
    const { value, min, max } = spec.slider;
    const input = h("input", { type: "range", min, max, step: 1, disabled: spec.inactive });
    input.value = String(value); // after min and max, or it is clipped to 0..100
    const shows = h("output", {}, String(value));
    input.addEventListener("input", () => { shows.textContent = input.value; });
    if (spec.events.includes("select")) input.addEventListener("change", () => fire("select"));
    const node = h("label", { class: "element dxlslider" + (spec.full ? " full" : "") },
      spec.label ? h("span", { class: "name" }, spec.label) : null, input, shows);
    return { node, spec, read: () => ({ id: spec.id, position: Number(input.value) }) };
  }
  if (spec.kind === "statusBar") {
    const { ends, cells, full } = spec.status;
    const parts = full ? [h("span", { class: "whole" }, full)] : cells.map((text: string, i: number) => {
      const part = h("span", {}, text);
      part.style.flexBasis = "0";
      part.style.flexGrow = String(ends[i] - (i ? ends[i - 1] : 0));
      return part;
    });
    return { node: h("div", { class: "dxlstatus", role: "status" }, parts), spec, read: () => null };
  }
  if (spec.kind === "menuBar") {
    const menus = (spec.menus ?? []).map((title: string, i: number) => h("button", { type: "button", "aria-haspopup": "menu",
      disabled: spec.inactive, onclick: (e: any) => {
        const at = e.target.getBoundingClientRect();
        ask_menu(box, spec.id, i, { clientX: at.left, clientY: at.bottom });
      } }, title));
    return { node: h("div", { class: "menus", role: "menubar" }, menus), spec, read: () => null };
  }
  if (spec.kind === "splitter") {
    const node = h("div", { class: "dxlhandle", role: "separator", tabindex: "0", "aria-orientation": "vertical",
      "aria-label": "resize" });
    if (spec.width > 0) node.style.width = Math.min(Math.max(spec.width, 4), 16) + "px";
    const resize = (by: number, from?: number) => {
      const left: any = node.previousElementSibling;
      if (!left) return;
      const room = node.parentElement!.offsetWidth - node.offsetWidth - 60;
      const width = Math.max(60, Math.min(room, (from ?? left.offsetWidth) + by));
      left.style.flex = `0 0 ${width}px`;
      const view = left.querySelector(".dxllist");
      if (view) view.style.width = "100%";
    };
    node.addEventListener("keydown", (e: any) => {
      if (e.key === "ArrowLeft") resize(-20);
      else if (e.key === "ArrowRight") resize(20);
    });
    node.addEventListener("pointerdown", (down: any) => {
      down.preventDefault();
      const start = (node.previousElementSibling as any)?.offsetWidth ?? 0;
      const move = (e: any) => resize(e.clientX - down.clientX, start);
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
    return { node, spec, read: () => null };
  }
  return null;
}

function make_widget(box: number, spec: any): Widget {
  const off = spec.inactive;
  const has = (name: string) => spec.events.includes(name);
  const fire = (kind: string, row?: number) => event(box, { kind, element: spec.id, row: row ?? null });
  const labelled = (control: any, extra: string = "") => h("label", { class: "element " + extra + (spec.full ? " full" : "") },
    spec.label ? h("span", { class: "name" }, spec.label) : null, control);
  const plain = (node: any): Widget => ({ node, spec, read: () => null });
  const part = make_part(box, spec, fire);
  if (part) return part;

  if (spec.kind === "label") return plain(h("div", { class: "element label" + (spec.full ? " full" : "") }, spec.text));
  if (spec.kind === "separator") return plain(h("hr", { class: "element full" }));
  if (spec.kind === "button") {
    return plain(h("button", { type: "button", disabled: off,
      class: "element" + (spec.isDefault ? " primary" : "") + (spec.full ? " full" : ""),
      onclick: () => fire("press") }, spec.label));
  }
  // a rich element holding formatting is shown; without any it is typed into
  if (spec.rich) {
    const view = h("div", { class: "dxlrich", role: "document", tabindex: "0", "aria-label": spec.label || "text" });
    view.append(...richNodes(spec.rich));
    if (spec.kind === "richText" && spec.width > 0) view.style.width = Math.min(spec.width, 900) + "px";
    if (spec.height > 0) view.style.height = Math.min(Math.max(spec.height, 40), 600) + "px";
    return plain(labelled(view, spec.kind === "richText" && spec.width > 0 ? "stacked" : "stacked full"));
  }
  const kind = spec.kind === "richField" ? "field" : spec.kind === "richText" ? "text" : spec.kind;
  if (kind === "field" || kind === "fileName") {
    const input = h("input", { type: "text", value: spec.text, disabled: off, readOnly: spec.readOnly });
    if (spec.width > 0) input.size = Math.min(spec.width, 100);
    if (has("enter")) {
      input.addEventListener("keydown", (e: any) => { if (e.key === "Enter") fire("select"); });
    }
    const node = kind === "fileName"
      ? labelled(h("span", {}, input, h("span", { class: "hint" }, " a file kept in this page")), "full")
      : labelled(input);
    return { node, spec, read: () => ({ id: spec.id, text: input.value }) };
  }
  if (kind === "text") {
    const area = h("textarea", { value: spec.text, disabled: off, readOnly: spec.readOnly });
    if (spec.width > 0) area.style.width = Math.min(spec.width, 900) + "px";
    if (spec.height > 0) area.style.height = Math.min(Math.max(spec.height, 40), 600) + "px";
    return { node: labelled(area, spec.width > 0 ? "stacked" : "stacked full"), spec,
      read: () => ({ id: spec.id, text: area.value }) };
  }
  if (spec.kind === "toggle") {
    const input = h("input", { type: "checkbox", checked: spec.on, disabled: off });
    if (has("select")) input.addEventListener("change", () => fire("select"));
    return { node: h("label", { class: "element" + (spec.full ? " full" : "") }, input, " " + spec.label), spec,
      read: () => ({ id: spec.id, on: input.checked }) };
  }
  if (spec.kind === "radioBox" || spec.kind === "checkBox") {
    const inputs = spec.rows.map((r: any) => h("input", { type: spec.kind === "radioBox" ? "radio" : "checkbox",
      name: "dxl" + spec.id, checked: r.selected, disabled: off }));
    if (has("select")) for (const input of inputs) input.addEventListener("change", () => fire("select"));
    const node = h("fieldset", { class: "element" + (spec.vertical ? " vertical" : "") + (spec.full ? " full" : "") },
      spec.label ? h("legend", {}, spec.label) : null,
      spec.rows.map((r: any, i: number) => h("label", {}, inputs[i], " " + r.cells[0])));
    return { node, spec,
      read: () => ({ id: spec.id, selected: inputs.flatMap((x: any, i: number) => (x.checked ? [i] : [])) }) };
  }
  if (spec.kind === "choice") {
    const chosen = spec.rows.findIndex((r: any) => r.selected);
    const select = h("select", { disabled: off },
      h("option", { value: "-1" }, ""), spec.rows.map((r: any, i: number) => h("option", { value: String(i) }, r.cells[0])));
    select.value = String(chosen);
    const typed = spec.editable ? h("input", { type: "text", value: spec.text, disabled: off, placeholder: "or type" }) : null;
    select.addEventListener("change", () => {
      if (typed) typed.value = "";
      if (has("select")) fire("select");
    });
    typed?.addEventListener("input", () => { select.value = "-1"; });
    typed?.addEventListener("change", () => { if (has("select")) fire("select"); });
    return { node: labelled(h("span", {}, select, typed)), spec, read: () => {
      const at = Number(select.value);
      return { id: spec.id, selected: at < 0 ? [] : [at], ...(typed ? { text: typed.value } : {}) };
    } };
  }
  return with_menu(box, spec, make_list(box, spec, fire));
}

// list, multiList and listView: a table whose rows are picked by clicking (a
// multiple selection is built by clicking each row, which also works by touch).
function make_list(box: number, spec: any, fire: (kind: string, row?: number) => void): Widget {
  const selected = new Set<number>(spec.rows.flatMap((r: any, i: number) => (r.selected ? [i] : [])));
  const checks: any[] = [];
  const lines: any[] = [];
  const paint = () => lines.forEach((line, i) => {
    line.classList.toggle("picked", selected.has(i));
    line.setAttribute("aria-selected", String(selected.has(i)));
  });
  const pick = (i: number) => {
    if (spec.inactive) return;
    if (spec.multi) {
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
    } else {
      if (selected.has(i)) return;
      selected.clear();
      selected.add(i);
    }
    paint();
    if (spec.events.includes("select")) fire("select", i);
  };
  const columns = spec.columns.length;
  spec.rows.forEach((row: any, i: number) => {
    let check = null;
    if (spec.checkboxes) {
      check = h("input", { type: "checkbox", checked: row.checked, disabled: spec.inactive, "aria-label": "check " + row.cells[0],
        onclick: (e: any) => e.stopPropagation(), ondblclick: (e: any) => e.stopPropagation(),
        onchange: () => { if (spec.events.includes("check")) fire("check", i); } });
      checks.push(check);
    }
    const cells = Array.from({ length: Math.max(1, columns) }, (_, c) => h("td", {}, c === 0 && check ? [check, " "] : null,
      row.cells[c] ?? ""));
    lines.push(h("tr", { role: "option", tabindex: "0", onclick: () => pick(i),
      ondblclick: () => { if (!spec.inactive && spec.events.includes("activate")) fire("activate", i); },
      onkeydown: (e: any) => {
        if (e.key === " ") { e.preventDefault(); pick(i); }
        else if (e.key === "Enter" && spec.events.includes("activate")) fire("activate", i);
      } }, cells));
  });
  const head = columns ? h("thead", {}, h("tr", {}, spec.columns.map((c: any) => {
    const th = h("th", {}, c.title);
    if (c.width > 0) th.style.minWidth = Math.min(c.width, 600) + "px";
    return th;
  }))) : null;
  const holder = h("div", { class: "dxllist" + (spec.inactive ? " off" : ""), role: "listbox",
    "aria-label": spec.label || "list", "aria-multiselectable": String(spec.multi) },
    h("table", {}, head, h("tbody", {}, lines)));
  // `visible` is a number of rows
  if (spec.height > 0) holder.style.height = Math.min(Math.max(spec.height, 2) + (columns ? 1 : 0), 25) * 1.7 + "em";
  if (spec.width > 0) holder.style.width = Math.min(spec.width, 900) + "px";
  paint();
  const node = h("div", { class: "element stacked" + (spec.full || !spec.width ? " full" : "") },
    spec.label ? h("span", { class: "name" }, spec.label) : null, holder);
  return { node, spec, read: () => ({ id: spec.id, selected: [...selected].sort((a, b) => a - b),
    ...(spec.checkboxes ? { checked: checks.flatMap((c, i) => (c.checked ? [i] : [])) } : {}) }) };
}

function event(box: number, what: any): void {
  const panel = panels.get(box);
  if (!panel || !send) return;
  const values: any[] = [];
  for (const each of panels.values()) {
    for (const widget of each.widgets.values()) {
      const value = widget.spec.inactive || widget.spec.hidden ? null : widget.read();
      if (value) values.push(value);
    }
  }
  const mine = session;
  panel.fault.textContent = "";
  panel.node.classList.add("busy");
  act(async () => {
    let reply: any;
    try {
      reply = await send!(mine, { ...what, box, values });
    } finally {
      panel.node.classList.remove("busy");
    }
    // another script has run since; a stopped engine has already taken the boxes down
    if (mine !== session && !reply.discarded) return;
    report(panel, reply);
    if (reply.dialogs?.open) draw(reply.dialogs);
    else {
      // a stopped script, or one with nothing left on screen
      const messages = [...(reply.dialogs?.messages ?? [])];
      // an error that took the box with it would otherwise only show in the DXL window
      if (reply.error) messages.push({ kind: "error", text: panel.fault.textContent });
      clear();
      if (messages.length) show_messages(messages);
    }
    await loadTree();
    await refresh();
  });
}

// What a callback printed, wrote and got wrong goes where a script's does.
function report(panel: Panel, reply: any): void {
  const parts: any[] = [];
  if (reply.output) parts.push(h("div", {}, reply.output));
  if (reply.error) {
    const { line, file, message } = reply.error;
    const text = (line ? `${file ? file + ", " : ""}line ${line}: ` : "") + message;
    parts.push(h("div", { class: "fault" }, text));
    panel.fault.textContent = text;
  }
  for (const f of reply.files ?? []) parts.push(writtenFile(f.name, f.text));
  if (reply.files?.length) {
    panel.fault.append(h("div", { class: "note" }, `Wrote ${reply.files.map((f: any) => f.name.split("/").pop()).join(", ")}: `
      + "see the DXL window to view or download."));
  }
  if (reply.rolled_back && parts.length) parts.push(h("div", { class: "note" }, "Try without saving: database changes were undone."));
  if (!reply.dialogs?.open) parts.push(h("div", { class: "note" }, "The dialog box is closed; the script is finished."));
  if (DXL.result && parts.length) {
    DXL.result.append(...parts);
    DXL.result.scrollTop = DXL.result.scrollHeight;
  }
}
