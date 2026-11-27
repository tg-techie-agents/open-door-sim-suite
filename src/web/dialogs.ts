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

/** Passes one event to the engine; resolves with its reply. */
export type Send = (session: number, event: any) => Promise<any>;

type Widget = {
  node: any;
  spec: any;
  /** What the person has set, as the engine takes it; null if nothing can be set. */
  read(): any;
};
type Panel = { node: any; body: any; foot: any; fault: any; title: any; layout: string; widgets: Map<number, Widget> };

let session = 0;
let send: Send | null = null;
let panels = new Map<number, Panel>();
let message_box: any = null;
let progress_box: any = null;

/** Take every box off the page (a new run, a stopped or replaced engine). */
export function clear(): void {
  for (const panel of panels.values()) panel.node.remove();
  panels = new Map();
  message_box?.remove();
  message_box = null;
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
  });
  if (spec.messages?.length) show_messages(spec.messages);
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
  const node = h("section", { class: "dxlbox", role: "dialog", "data-box": String(box.id),
    onkeydown: (e: any) => e.stopPropagation() }, bar, body, fault, foot);
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
  return { node, body, foot, fault, title, layout: "", widgets: new Map() };
}

/** The widget's description as it would be had the engine taken what the person set. */
function as_set(widget: Widget): any {
  const spec = JSON.parse(JSON.stringify(widget.spec));
  const value = widget.read();
  if (!value) return spec;
  if (value.text !== undefined) spec.text = value.text;
  if (value.on !== undefined) spec.on = value.on;
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
  }
  const layout = JSON.stringify([box.closeButton, all.map((e: any) => [e.id, e.place, e.hidden])]);
  if (layout === panel.layout) return;
  panel.layout = layout;
  const rows: any[] = [];
  for (const spec of box.elements) {
    if (spec.hidden) continue;
    const joined = (spec.place === "beside" || spec.place === "opposite") && rows.length;
    if (!joined) rows.push(h("div", { class: spec.place === "right" ? "row end" : "row" }));
    const node = panel.widgets.get(spec.id)!.node;
    node.classList.toggle("opposite", spec.place === "opposite");
    rows[rows.length - 1].append(node);
  }
  panel.body.replaceChildren(...rows);
  const standard = box.buttons.filter((b: any) => !b.hidden).map((b: any) => panel.widgets.get(b.id)!.node);
  if (box.closeButton) {
    standard.push(h("button", { type: "button", onclick: () => event(box.id, { kind: "close" }) }, "Close"));
  }
  panel.foot.replaceChildren(...standard);
}

function make_widget(box: number, spec: any): Widget {
  const off = spec.inactive;
  const has = (name: string) => spec.events.includes(name);
  const fire = (kind: string, row?: number) => event(box, { kind, element: spec.id, row: row ?? null });
  const labelled = (control: any, extra: string = "") => h("label", { class: "element " + extra + (spec.full ? " full" : "") },
    spec.label ? h("span", { class: "name" }, spec.label) : null, control);
  const plain = (node: any): Widget => ({ node, spec, read: () => null });

  if (spec.kind === "label") return plain(h("div", { class: "element label" + (spec.full ? " full" : "") }, spec.text));
  if (spec.kind === "separator") return plain(h("hr", { class: "element full" }));
  if (spec.kind === "button") {
    return plain(h("button", { type: "button", disabled: off,
      class: "element" + (spec.isDefault ? " primary" : "") + (spec.full ? " full" : ""),
      onclick: () => fire("press") }, spec.label));
  }
  if (spec.kind === "field" || spec.kind === "fileName") {
    const input = h("input", { type: "text", value: spec.text, disabled: off, readOnly: spec.readOnly });
    if (spec.width > 0) input.size = Math.min(spec.width, 100);
    if (has("enter")) {
      input.addEventListener("keydown", (e: any) => { if (e.key === "Enter") fire("select"); });
    }
    const node = spec.kind === "fileName"
      ? labelled(h("span", {}, input, h("span", { class: "hint" }, " a file kept in this page")), "full")
      : labelled(input);
    return { node, spec, read: () => ({ id: spec.id, text: input.value }) };
  }
  if (spec.kind === "text") {
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
  return make_list(box, spec, fire);
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
