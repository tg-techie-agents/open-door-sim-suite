"use strict";
// Everything shown from the database goes through h() or textContent, so it is
// always text and never markup.

const $ = (id) => document.getElementById(id);

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value; // the page's policy refuses style attributes
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// Every operation goes through transport.js, which is loaded before this file.
const api = (operation, args) => window.opendoorTransport(operation, args || {});

function say(text, isError) {
  $("message").textContent = text;
  $("message").className = isError ? "error" : "";
}

// Run a user action, showing any failure in the status bar.
async function act(work) {
  try {
    say("");
    await work();
  } catch (e) {
    say(e.message, true);
  }
}

const S = {
  tree: null, items: new Map(), expanded: new Set([1]), picked: 1, showDeletedItems: false,
  moduleId: null, data: null, selected: null, showDeleted: false,
  columns: [], inLinks: true, outLinks: true, filter: null, sort: null, quick: "", view: "", dxlColumn: null,
  layout: null, layoutCells: [], // a view made by a script: every column in its order
  linkStart: null, props: false,
};

const OPERATORS = [["contains", "contains"], ["!contains", "does not contain"], ["==", "equals"],
  ["!=", "does not equal"], ["empty", "is empty"], ["!empty", "is not empty"]];

// What the traceability tools (trace.js) add to the module window.
const TRACE = {
  passes: (row) => true,
  filtering: () => false,
  clear: () => {},          // drop its filters
  columns: () => [],        // extra columns: { title, cell(row) }
  status: () => [],         // notes for the status bar
  reset: () => {},          // another view of things from the start
  apply: (definition) => {},
  definition: () => ({}),   // what a saved view keeps for it
  load: async () => {},     // the module has been read again
};

// ---------------------------------------------------------------- dialogs

function dialog(title, content, buttons) {
  const problem = h("div", { class: "problem" });
  const box = h("dialog", {});
  const close = () => { box.close(); box.remove(); };
  const press = async (button) => {
    problem.textContent = "";
    try {
      if (!button.action || (await button.action()) !== false) close();
    } catch (e) {
      problem.textContent = e.message;
    }
  };
  const row = (buttons || [{ label: "Close" }]).map((b) =>
    h("button", { type: "button", class: b.primary ? "primary" : "", onclick: () => press(b) }, b.label));
  box.append(
    h("div", { class: "titlebar" }, title, h("button", { type: "button", onclick: close, title: "Close" }, "x")),
    h("div", { class: "content" }, content), problem, h("div", { class: "buttons" }, row));
  box.addEventListener("cancel", () => box.remove());
  // A Stop button lent to this dialog goes back to the page when the dialog closes.
  box.addEventListener("close", () => {
    const stop = box.querySelector("#stop");
    if (stop) document.body.append(stop);
  });
  box.addEventListener("keydown", (event) => {
    const primary = (buttons || []).find((b) => b.primary);
    if (event.key === "Enter" && primary && event.target.tagName === "INPUT") {
      event.preventDefault();
      press(primary);
    }
  });
  document.body.append(box);
  box.showModal();
  return { close, problem };
}

function field(spec) {
  let input;
  if (spec.type === "select") {
    input = h("select", {}, spec.options.map((o) => {
      const [value, label] = Array.isArray(o) ? o : [o, o];
      return h("option", { value }, label);
    }));
    if (spec.value !== undefined) input.value = spec.value;
  } else if (spec.type === "checkbox") {
    input = h("input", { type: "checkbox", checked: !!spec.value });
  } else if (spec.type === "textarea") {
    input = h("textarea", { value: spec.value || "" });
  } else {
    input = h("input", { type: "text", value: spec.value || "" });
  }
  return input;
}

function formDialog(title, specs, okLabel, onOk) {
  const inputs = new Map(specs.map((s) => [s.name, field(s)]));
  const form = h("div", { class: "form" },
    specs.map((s) => [h("label", {}, s.label), inputs.get(s.name)]));
  return dialog(title, form, [
    { label: okLabel, primary: true, action: () => {
      const values = {};
      for (const [name, input] of inputs) values[name] = input.type === "checkbox" ? input.checked : input.value;
      return onOk(values);
    } },
    { label: "Cancel" },
  ]);
}

function confirmDialog(title, text, okLabel, onOk) {
  dialog(title, h("div", {}, text), [{ label: okLabel, primary: true, action: onOk }, { label: "Cancel" }]);
}

function listTable(headings, rows) {
  for (const row of rows) [...row.children].forEach((cell, i) => { if (headings[i]) cell.dataset.label = headings[i]; });
  return h("table", { class: "list" },
    h("thead", {}, h("tr", {}, headings.map((t) => h("th", {}, t)))), h("tbody", {}, rows));
}

// listTable for what may be a hundred thousand long: the rows are made a
// thousand at a time, the first at once and more on request.
const LIST_PAGE = 1000;
function longTable(headings, items, row) {
  const table = listTable(headings, items.slice(0, LIST_PAGE).map(row));
  if (items.length <= LIST_PAGE) return table;
  const body = table.querySelector("tbody");
  let shown = LIST_PAGE;
  const count = h("span", {});
  const tell = () => { count.textContent = `Showing ${shown} of ${items.length} rows. `; };
  const more = h("button", { type: "button", onclick: () => {
    const next = listTable(headings, items.slice(shown, shown + LIST_PAGE).map(row));
    for (const line of [...next.querySelector("tbody").children]) body.append(line);
    shown = Math.min(items.length, shown + LIST_PAGE);
    tell();
    if (shown === items.length) more.remove();
  } }, "Show more");
  tell();
  return h("div", {}, table, h("p", {}, count, more));
}

// ---------------------------------------------------------------- database explorer

async function loadTree() {
  const reply = await api("tree", { show_deleted: S.showDeletedItems });
  S.tree = reply.root;
  S.database = reply.database;
  S.items.clear();
  const index = (node, parent) => {
    node.parent = parent;
    S.items.set(node.id, node);
    node.children.forEach((c) => index(c, node));
  };
  index(S.tree, null);
  if (!S.items.has(S.picked)) S.picked = 1;
  renderTree();
}

function renderTree() {
  const draw = (node) => {
    const open = S.expanded.has(node.id);
    const label = node.id === 1 ? S.database || "Database" : node.name;
    const letter = { folder: "", project: "P", formal: "M", link: "L" }[node.kind];
    const row = h("div", {
      class: "node" + (node.id === S.picked ? " picked" : "") + (node.deleted ? " deleted" : ""),
      title: node.description || node.path,
      onclick: () => act(() => pickItem(node.id)),
      ondblclick: () => toggle(node.id),
      oncontextmenu: (event) => {
        event.preventDefault();
        act(async () => { await pickItem(node.id); showMenu(itemMenu(), event.clientX, event.clientY); });
      },
    },
    h("span", { class: "twisty", onclick: (e) => { e.stopPropagation(); toggle(node.id); } },
      node.children.length ? (open ? "-" : "+") : ""),
    h("span", { class: "icon " + node.kind }, letter),
    h("span", { class: "name" }, label));
    return [row, open && node.children.length ? h("div", { class: "branch" }, node.children.map(draw)) : null];
  };
  const scroll = $("explorer").scrollTop;
  $("explorer").replaceChildren(...draw(S.tree).filter(Boolean));
  $("explorer").scrollTop = scroll;
}

function toggle(id) {
  if (!S.expanded.delete(id)) S.expanded.add(id);
  renderTree();
}

async function pickItem(id) {
  const node = S.items.get(id);
  S.picked = id;
  if (node.kind === "formal" && !node.deleted) {
    if (id !== S.moduleId) await openModule(id);
  } else {
    S.moduleId = S.data = S.selected = null;
    if (!node.deleted) S.expanded.add(id);
    render();
  }
  renderTree();
}

const pickedItem = () => S.items.get(S.picked);

function containerForNew() {
  const node = pickedItem();
  return node.kind === "folder" || node.kind === "project" ? node : node.parent;
}

function newItem(kind, title) {
  const parent = containerForNew();
  const specs = [{ name: "name", label: "Name" }, { name: "description", label: "Description" }];
  if (kind === "formal") specs.push({ name: "prefix", label: "ID prefix (e.g. SR-)" });
  formDialog(`New ${title} in ${parent.path}`, specs, "Create", async (v) => {
    const made = await api("create_item", { parent: parent.id, kind, ...v });
    S.expanded.add(parent.id);
    await loadTree();
    await pickItem(made.id);
  });
}

function itemProperties() {
  const node = pickedItem();
  const specs = [{ name: "name", label: "Name", value: node.name },
    { name: "description", label: "Description", value: node.description }];
  if (node.kind === "formal") specs.push({ name: "prefix", label: "ID prefix", value: node.prefix });
  formDialog("Properties of " + node.path, specs, "Save", async (v) => {
    await api("update_item", { id: node.id, ...v });
    await loadTree();
    if (S.moduleId === node.id) await refresh();
    else render();
  });
}

function deleteItem() {
  const node = pickedItem();
  confirmDialog("Delete", `Delete ${node.path}? It can be undeleted later (File, Show deleted items).`, "Delete",
    async () => {
      await api("delete_item", { id: node.id });
      S.picked = node.parent.id;
      S.moduleId = S.data = S.selected = null;
      await loadTree();
      render();
    });
}

const undeleteItem = () => act(async () => {
  await api("delete_item", { id: S.picked, deleted: false });
  await loadTree();
  await pickItem(S.picked);
});

// ---------------------------------------------------------------- module window

function resetView() {
  Object.assign(S, { columns: [], inLinks: true, outLinks: true, filter: null, sort: null, quick: "", view: "", dxlColumn: null,
    layout: null, layoutCells: [] });
  TRACE.reset();
}

function clearFilters() {
  S.quick = "";
  S.filter = null;
  TRACE.clear();
}

// The engine keeps an attribute DXL value once calculated. Forget them first, so
// that what is shown matches the database as it is now.
async function readModule(id) {
  await api("recalculate", { module: id });
  return api("module", { module: id, show_deleted: S.showDeleted });
}

async function openModule(id, absno) {
  const data = await readModule(id);
  if (S.moduleId !== id) resetView();
  S.moduleId = id;
  S.data = data;
  S.selected = data.rows.some((r) => r.absno === absno) ? absno : (data.rows[0] || {}).absno ?? null;
  await computeLayoutCells();
  await TRACE.load();
  render();
  $("main").scrollTop = 0;
  if (absno !== undefined) scrollToSelected();
}

// Re-read the open module, keeping selection and scroll position.
async function refresh(options) {
  if (S.moduleId === null) return render();
  const scroll = [$("main").scrollTop, $("main").scrollLeft];
  S.data = await readModule(S.moduleId);
  if (!S.data.rows.some((r) => r.absno === S.selected)) S.selected = (S.data.rows[0] || {}).absno ?? null;
  if (S.dxlColumn) await computeDxlColumn();
  await computeLayoutCells();
  await TRACE.load();
  render(options);
  if (options && options.keepProps) showCalculated();
  [$("main").scrollTop, $("main").scrollLeft] = scroll;
}

async function goTo(module, absno) {
  const node = S.items.get(module);
  if (node) {
    S.picked = module;
    for (let up = node.parent; up; up = up.parent) S.expanded.add(up.id);
  }
  clearFilters();
  if (module === S.moduleId) {
    S.selected = absno;
    render();
    scrollToSelected();
  } else {
    await openModule(module, absno);
  }
  renderTree();
}

function scrollToSelected() {
  if (gridWindowed()) {
    const index = GRID.rows.findIndex((r) => r.absno === S.selected);
    if (index >= 0) revealRow(index);
  }
  const row = document.querySelector("#main tr.picked");
  if (row) row.scrollIntoView({ block: "nearest" });
}

const selectedRow = () => S.data && S.data.rows.find((r) => r.absno === S.selected);
const attribute = (name) => S.data.attributes.find((a) => a.name === name && a.scope === "object");
const writable = () => S.data && !S.data.module.baseline;

function cellText(row, name) {
  if (name === "ID") return row.id;
  if (name === "Absolute Number") return String(row.absno);
  return row.values[name] || "";
}

function passes(row) {
  if (!TRACE.passes(row)) return false;
  if (S.quick) {
    const all = [row.id, row.number, ...Object.values(row.values)].join("\n").toLowerCase();
    if (!all.includes(S.quick.toLowerCase())) return false;
  }
  if (!S.filter) return true;
  const have = cellText(row, S.filter.attribute).toLowerCase();
  const want = (S.filter.value || "").toLowerCase();
  switch (S.filter.op) {
    case "contains": return have.includes(want);
    case "!contains": return !have.includes(want);
    case "==": return have === want;
    case "!=": return have !== want;
    case "empty": return have === "";
    case "!empty": return have !== "";
    default: return true;
  }
}

function visibleRows() {
  const rows = S.data.rows.filter(passes);
  if (!S.sort) return rows;
  const definition = attribute(S.sort);
  const key = (row) => {
    const text = cellText(row, S.sort);
    if (S.sort === "ID" || S.sort === "Absolute Number") return row.absno;
    if (definition && definition.base === "Enumeration") return definition.values.indexOf(text);
    if (definition && (definition.base === "Integer" || definition.base === "Real")) return text === "" ? -Infinity : Number(text);
    return text.toLowerCase();
  };
  return rows.sort((a, b) => {
    const x = key(a), y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function render(options) {
  renderToolbar();
  renderMain();
  if (!(options && options.keepProps)) renderProps();
  renderDxlContext();
  document.title = (S.data ? S.data.module.name + " - " : "") + "OpenDoor";
}

// A module of thousands of objects is too many elements for a page to hold and
// stay usable. Past GRID_ALL rows, only those on and near the screen are built;
// spacer rows stand for the rest. Printing builds them all.
const GRID_ALL = 500;
// `heights` are rows as measured; every other row counts as `estimate`, which is
// taken once for a `shape` (module and columns) so that the list keeps its length.
const GRID = { body: null, rows: [], build: null, columns: 0, built: new Map(), heights: new Map(),
  shape: "", estimate: 0, printing: false };

const gridWindowed = () => !!GRID.body && GRID.body.isConnected && GRID.rows.length > GRID_ALL;
const rowHeight = (row) => GRID.heights.get(row.absno) || GRID.estimate || 40;

// Where row `index` starts, counted from the first row.
function rowTop(index) {
  let top = 0;
  for (let i = 0; i < index; i++) top += rowHeight(GRID.rows[i]);
  return top;
}

// Build the rows that are near `scrollTop`, keeping those already there. The row
// being edited stays however far it is, and is never moved: that would end the edit.
function drawRows(scrollTop) {
  const { body, rows, built } = GRID;
  const main = $("main");
  const wanted = new Set();
  if (GRID.printing) {
    rows.forEach((row, i) => wanted.add(i));
  } else {
    const screen = main.clientHeight || window.innerHeight;
    const from = scrollTop - screen, to = scrollTop + 2 * screen;
    let top = 0, first = 0;
    while (first < rows.length - 1 && top + rowHeight(rows[first]) < from) top += rowHeight(rows[first++]);
    // past the end (the list has just become shorter): the last screenful
    if (first === rows.length - 1) {
      const end = top + rowHeight(rows[first]);
      while (first > 0 && top > end - 2 * screen) top -= rowHeight(rows[--first]);
    }
    for (let i = first; i < rows.length && (top < to || i < first + 30); i++) {
      wanted.add(i);
      top += rowHeight(rows[i]);
    }
    for (const [index, tr] of built) if (tr.querySelector(".editor")) wanted.add(index);
  }
  const spacer = (height) => h("tr", { class: "spacer", "aria-hidden": "true" },
    h("td", { colSpan: GRID.columns, style: `height:${height}px` }));
  const nodes = [], kept = new Map();
  let gap = 0;
  rows.forEach((row, i) => {
    if (!wanted.has(i)) {
      gap += rowHeight(row);
      return;
    }
    if (gap) nodes.push(spacer(gap));
    gap = 0;
    const tr = built.get(i) || GRID.build(row);
    kept.set(i, tr);
    nodes.push(tr);
  });
  if (gap) nodes.push(spacer(gap));
  const staying = new Set(nodes);
  for (const node of [...body.children]) if (!staying.has(node)) node.remove();
  let at = body.firstChild;
  for (const node of nodes) {
    if (node === at) at = at.nextSibling;
    else body.insertBefore(node, at);
  }
  GRID.built = kept;
}

// What the built rows measure, for the spacers.
function measureRows() {
  let total = 0, count = 0;
  for (const [index, tr] of GRID.built) {
    const height = tr.offsetHeight;
    if (!height) continue;
    GRID.heights.set(GRID.rows[index].absno, height);
    total += height;
    count++;
  }
  if (count && !GRID.estimate) GRID.estimate = total / count;
}

// The first built row showing below the column headings, and how far down it is.
function gridAnchor() {
  const { top: edge, bottom: end } = $("main").getBoundingClientRect();
  for (const [index, tr] of [...GRID.built].sort((a, b) => a[0] - b[0])) {
    const box = tr.getBoundingClientRect();
    if (box.bottom > edge && box.top < end && box.height) return { absno: GRID.rows[index].absno, offset: box.top - edge };
  }
  return null;
}

// Redraw around where the window now is, without what is on screen moving as rows
// that were only estimated get measured.
function updateRows() {
  if (!gridWindowed()) return;
  const main = $("main");
  const anchor = gridAnchor(); // nothing built is on screen after a long jump
  drawRows(main.scrollTop);
  measureRows();
  if (!anchor) return;
  const found = [...GRID.built].find(([index]) => GRID.rows[index].absno === anchor.absno);
  if (!found) return;
  const moved = found[1].getBoundingClientRect().top - main.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(moved) >= 1) main.scrollTop += moved;
}

// Bring row `index` into the built range and the window.
function revealRow(index) {
  const main = $("main");
  const head = GRID.body.offsetTop, screen = main.clientHeight || window.innerHeight;
  const top = rowTop(index), bottom = head + top + rowHeight(GRID.rows[index]);
  let to = main.scrollTop;
  if (top < to) to = top;
  else if (bottom > to + screen) to = bottom - screen;
  drawRows(to); // build there before going there
  main.scrollTop = to;
  measureRows();
}

function renderMain() {
  const main = $("main");
  if (!S.data) {
    GRID.body = null;
    main.classList.remove("windowed");
    const node = pickedItem();
    $("counts").textContent = "";
    if (node.deleted) return main.replaceChildren(h("div", { class: "empty" }, node.path + " is deleted. Use File, Undelete item."));
    if (node.kind === "link") return main.replaceChildren(h("div", { class: "empty" }, node.path + " is a link module. Its links show in the link columns of formal modules."));
    return main.replaceChildren(h("div", { class: "empty" },
      h("h3", {}, node.path),
      node.children.length ? listTable(["Name", "Type", "Description"], node.children.map((c) =>
        h("tr", {}, h("td", {}, h("a", { class: "go", onclick: () => act(() => pickItem(c.id)) }, c.name)),
          h("td", {}, c.kind), h("td", {}, c.description))))
        : h("p", {}, "This is empty. Use File, New project / formal module.")));
  }
  const m = S.data.module;
  const rows = visibleRows();
  // the ID column is always first, so a view that also names it does not show it twice
  const attributeColumns = S.columns.filter((c) => c !== "ID" && (attribute(c) || S.data.system_attributes.includes(c) || c === "Absolute Number"));
  const extra = TRACE.columns();
  const head = h("tr", {},
    S.layout ? S.layout.map((c) => h("th", c.width ? { style: `width:${c.width}px;min-width:${c.width}px` } : {},
      c.title ?? ({ id: "ID", main: m.name, attribute: c.attribute, dxl: "DXL" }[c.kind] || "")))
      : [h("th", {}, "ID"), h("th", {}, m.name), attributeColumns.map((c) => h("th", {}, c))],
    S.outLinks ? h("th", {}, "Out-links") : null, S.inLinks ? h("th", {}, "In-links") : null,
    S.dxlColumn ? h("th", {}, S.dxlColumn.title) : null,
    extra.map((c) => h("th", {}, c.title)));
  const body = h("tbody", {});
  const scrolled = main.scrollTop;
  const shape = `${S.moduleId}\n${head.textContent}`;
  if (GRID.shape !== shape) {
    GRID.heights.clear();
    GRID.estimate = 0;
  }
  Object.assign(GRID, { body, rows, shape, built: new Map(), columns: head.children.length,
    build: (row) => renderRow(row, attributeColumns, extra) });
  const windowed = rows.length > GRID_ALL;
  main.classList.toggle("windowed", windowed);
  if (windowed) drawRows(scrolled);
  else body.append(...rows.map(GRID.build));
  main.replaceChildren(...[
    m.baseline ? h("div", { class: "banner" }, `Baseline ${m.baseline} of ${m.path} - read only. `,
      h("a", { class: "go", onclick: () => act(() => goTo(m.owner)) }, "Return to the current version")) : null,
    h("table", { class: "grid" }, h("thead", {}, head), body),
    S.data.rows.length ? null : h("div", { class: "empty" }, "This module has no objects. Use Insert, Object (or the New object button)."),
    S.data.rows.length && !rows.length ? h("div", { class: "empty" }, "No object matches the filter.") : null,
  ].filter(Boolean));
  const parts = [`${rows.length} of ${S.data.rows.length} objects`];
  if (S.filter) parts.push("filter on");
  parts.push(...TRACE.status());
  if (windowed) {
    // the same place in the list as before the redraw, then true heights
    main.scrollTop = scrolled;
    measureRows();
    drawRows(main.scrollTop);
  }
  if (S.sort) parts.push("sorted by " + S.sort);
  if (S.linkStart) parts.push("link start: " + S.linkStart.id);
  $("counts").textContent = parts.join(" | ");
}

function renderRow(row, attributeColumns, extra) {
  const heading = row.values["Object Heading"] || "";
  const short = row.values["Object Short Text"] || "";
  const text = row.values["Object Text"] || "";
  const editable = writable() && !row.deleted;
  const part = (name, className, content) => h("span", {
    class: className,
    ondblclick: editable ? (e) => { e.stopPropagation(); editCell(row, name, e.currentTarget); } : null,
  }, content);

  const main = h("td", {
    class: "main",
    "data-level": Math.min(row.level, 6),
    ondblclick: editable ? (e) => editCell(row, heading && !text ? "Object Heading" : "Object Text",
      e.currentTarget.querySelector(heading && !text ? ".heading" : ".text")) : null,
  },
  row.in.length ? h("span", { class: "mark in", title: `${row.in.length} in-link(s)` }, "◀") : null,
  row.out.length ? h("span", { class: "mark out", title: `${row.out.length} out-link(s)` }, "▶") : null,
  isSuspectRow(row) ? h("span", { class: "mark suspect", title: "Suspect link" }, "S") : null,
  h("div", { style: `padding-left:${(row.level - 1) * 16}px` },
    h("span", { class: "number" }, row.number),
    heading ? part("Object Heading", "heading", heading) : null,
    !heading && !text && short ? part("Object Short Text", "short", short) : null,
    h("div", { class: "text" }, text)));
  if (heading && !text) main.querySelector(".text").style.minHeight = "0";

  return h("tr", {
    class: [`level${Math.min(row.level, 3)}`, row.deleted ? "deleted" : "", row.absno === S.selected ? "picked" : ""].join(" "),
    "data-absno": row.absno,
    onmousedown: () => select(row.absno),
    oncontextmenu: (e) => {
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      e.preventDefault();
      select(row.absno);
      showMenu(objectMenu(), e.clientX, e.clientY);
    },
  },
  S.layout ? S.layout.map((c, i) => layoutCell(c, i, row, main, editable))
    : [h("td", { class: "id" }, row.id), main, attributeColumns.map((name) => attributeCell(row, name, name, editable))],
  S.outLinks ? h("td", { class: "trace" + (row.out.length ? "" : " blank"), "data-label": "Out-links" },
    row.out.map((l) => traceEntry(l, "out"))) : null,
  S.inLinks ? h("td", { class: "trace" + (row.in.length ? "" : " blank"), "data-label": "In-links" },
    row.in.map((l) => traceEntry(l, "in"))) : null,
  S.dxlColumn ? h("td", { class: "trace computed" + (S.dxlColumn.cells[row.absno] ? "" : " blank"),
    "data-label": S.dxlColumn.title }, S.dxlColumn.cells[row.absno] || "") : null,
  extra.map((c) => {
    const content = c.cell(row);
    return h("td", { class: "trace computed" + (content.length ? "" : " blank"), "data-label": c.title }, content);
  }));
}

const isCalculated = (name) => !!attribute(name)?.dxl;

function attributeCell(row, name, label, editable, style) {
  const calculated = isCalculated(name), failed = calculated && row.failed.includes(name);
  return h("td", {
    class: "attr" + (cellText(row, name) ? "" : " blank") + (calculated ? " calculated" : "") + (failed ? " dxl-failed" : ""),
    "data-label": label,
    ...(style ? { style } : {}),
    ...(calculated ? { title: "Calculated by attribute DXL: read only" } : {}),
    ondblclick: calculated ? () => say(`${name} is calculated by attribute DXL and cannot be edited.`)
      : editable && attribute(name) ? (e) => editCell(row, name, e.currentTarget) : null,
  }, cellText(row, name));
}

// The properties panel is kept while an edit is saved: bring its calculated values up to date.
function showCalculated() {
  const row = selectedRow();
  for (const box of $("props").querySelectorAll("textarea[data-calculated]")) {
    const name = box.dataset.calculated;
    box.value = row?.values[name] || "";
    box.classList.toggle("dxl-failed", !!row?.failed.includes(name));
  }
}

function layoutCell(column, index, row, main, editable) {
  const style = column.justify === "left" ? "" : `text-align:${column.justify === "full" ? "justify" : column.justify}`;
  if (column.kind === "main") {
    if (style) main.style.cssText = style;
    return main;
  }
  if (column.kind === "id") return h("td", { class: "id", ...(style ? { style } : {}) }, row.id);
  const label = column.title ?? column.attribute ?? "";
  if (column.kind === "attribute") return attributeCell(row, column.attribute, label, editable, style);
  const text = (S.layoutCells[index] || {})[row.absno] || "";
  return h("td", { class: "trace computed" + (text ? "" : " blank"), "data-label": label, ...(style ? { style } : {}) }, text);
}

// The DXL columns of a script's view, run as the DXL column menu runs them.
async function computeLayoutCells() {
  const cells = [];
  if (S.layout) {
    for (const [index, column] of S.layout.entries()) {
      if (column.kind !== "dxl") continue;
      if (!writable()) {
        cells[index] = Object.fromEntries(S.data.rows.map((r) => [r.absno, "(DXL columns are not run on a baseline)"]));
        continue;
      }
      const reply = await api("dxl_column", { module: S.moduleId, source: column.dxl });
      cells[index] = reply.cells;
      if (reply.error) say(`DXL column "${column.title ?? index}": ${dxlError(reply.error)}`, true);
    }
  }
  S.layoutCells = cells;
}

// A link is suspect at one end when the object at the other end has changed.
const isSuspect = (link, direction) => direction === "out" ? link.target_changed : link.source_changed;
const isSuspectRow = (row) => row.out.some((l) => isSuspect(l, "out")) || row.in.some((l) => isSuspect(l, "in"));

function suspectBadge(link, direction) {
  if (!isSuspect(link, direction)) return null;
  const end = direction === "out" ? "target" : "source";
  return h("span", { class: "suspect", title: `Suspect: the ${end} changed since the link was made or cleared` }, "SUSPECT");
}

function traceEntry(link, direction) {
  const other = link.other;
  return h("div", { class: "entry", title: `${other.module_path} (${link.link_module})` },
    h("span", { class: "arrow " + direction }, direction === "out" ? "▶ " : "◀ "),
    h("a", { class: "go", onclick: () => act(() => goTo(other.module, other.absno)) }, other.id),
    suspectBadge(link, direction), " ",
    other.text.length > 140 ? other.text.slice(0, 140) + "..." : other.text);
}

function select(absno) {
  if (S.selected === absno) return;
  // Let an open editor save (for the object it belongs to) before the panel is rebuilt.
  if (document.activeElement && $("props").contains(document.activeElement)) document.activeElement.blur();
  S.selected = absno;
  for (const row of document.querySelectorAll("#main tr[data-absno]"))
    row.classList.toggle("picked", Number(row.dataset.absno) === absno);
  renderToolbar();
  renderProps();
}

// An input for one attribute value, and a way to read it back as stored text.
function valueInput(definition, value) {
  if (definition && definition.base === "Enumeration") {
    if (definition.multi) {
      const chosen = value.split("\n");
      const input = h("select", { multiple: true, size: Math.min(definition.values.length, 6) },
        definition.values.map((v) => h("option", { value: v, selected: chosen.includes(v) }, v)));
      return [input, () => [...input.selectedOptions].map((o) => o.value).join("\n")];
    }
    const input = h("select", {}, ["", ...definition.values].map((v) => h("option", { value: v }, v)));
    input.value = value;
    return [input, () => input.value];
  }
  const long = !definition || definition.base === "Text" || definition.base === "String" || value.includes("\n");
  const input = long ? h("textarea", { value }) : h("input", { type: "text", value });
  if (definition && definition.base === "Date") input.placeholder = "YYYY-MM-DD";
  return [input, () => input.value];
}

function editCell(row, name, holder) {
  if (holder.querySelector(".editor")) return;
  const before = row.values[name] || "";
  const shown = [...holder.childNodes];
  const [input, read] = valueInput(attribute(name), before);
  input.classList.add("editor");
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = read();
    // Unchanged: put the cell back without rebuilding the page under the next click.
    if (!save || value === before) return holder.replaceChildren(...shown);
    act(async () => {
      try {
        await api("set_values", { module: S.moduleId, absno: row.absno, values: { [name]: value } });
      } finally {
        await refresh();
      }
    });
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") finish(false);
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || input.tagName === "INPUT")) { e.preventDefault(); finish(true); }
  });
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  holder.replaceChildren(input);
  input.focus();
  say("Editing " + name + ". Ctrl+Enter or click away saves; Esc cancels.");
}

function editMain() {
  const row = selectedRow();
  if (!row || !writable() || row.deleted) return;
  if (!document.querySelector("#main tr.picked")) scrollToSelected(); // scrolled out of the built rows
  const tr = document.querySelector("#main tr.picked");
  if (!tr) return say(`${row.id} is hidden by the filter. Clear the filter to edit it.`, true);
  const name = row.values["Object Heading"] && !row.values["Object Text"] ? "Object Heading" : "Object Text";
  const holder = tr.querySelector(name === "Object Heading" ? ".heading" : ".text");
  if (!holder) return say("This view has no main column. Edit the text in Properties, or choose Standard view.", true);
  editCell(row, name, holder);
}

// ---------------------------------------------------------------- object properties

function renderProps() {
  const panel = $("props");
  const row = selectedRow();
  panel.hidden = !S.props || !S.data;
  if (panel.hidden) return;
  const close = h("button", { onclick: () => { S.props = false; render(); } }, "Close");
  if (!row) return panel.replaceChildren(h("h3", {}, "No object selected", close));
  const module = S.moduleId, absno = row.absno;
  const editable = writable() && !row.deleted;

  const fields = S.data.attributes.filter((a) => a.scope === "object").map((a) => {
    if (a.dxl) {
      const box = h("textarea", { readOnly: true, value: row.values[a.name] || "", "data-calculated": a.name,
        class: "calculated" + (row.failed.includes(a.name) ? " dxl-failed" : "") });
      return h("label", {}, `${a.name} (calculated by DXL)`, box);
    }
    let current = row.values[a.name] || "";
    const [input, read] = valueInput(a, current);
    input.disabled = !editable;
    input.addEventListener("change", () => act(async () => {
      const value = read();
      if (value === current) return;
      try {
        await api("set_values", { module, absno, values: { [a.name]: value } });
      } catch (e) {
        renderProps();  // show the stored value again
        throw e;
      }
      current = value;
      if (module === S.moduleId) await refresh({ keepProps: true });
      say("Saved " + a.name);
    }));
    return h("label", {}, a.name, input);
  });

  const links = (list, outgoing) => list.map((link) => {
    const source = { module: link.source.module, absno: link.source.absno };
    return h("div", { class: "entry" }, traceEntry(link, outgoing ? "out" : "in"),
      writable() && isSuspect(link, outgoing ? "out" : "in") ? h("button", { onclick: () => confirmDialog("Clear suspect link",
        `Clear the suspicion on the link ${outgoing ? "to" : "from"} ${link.other.id}?`, "Clear", async () => {
          await api("clear_suspect", { source, link: link.id });
          await refresh();
        }) }, "Clear suspect") : null,
      writable() ? h("button", { onclick: () => confirmDialog("Delete link",
        `Delete the link ${outgoing ? "to" : "from"} ${link.other.id}?`, "Delete", async () => {
          await api("delete_link", { source, link: link.id });
          await refresh();
        }) }, "Delete link") : null);
  });

  panel.replaceChildren(...[
    h("h3", {}, `${row.id}  ${row.number}`, close),
    row.deleted ? h("p", {}, "This object is deleted. ", h("button", { onclick: undeleteObject }, "Undelete")) : null,
    ...fields,
    h("h4", {}, "Out-links"), ...links(row.out, true),
    editable ? h("button", { onclick: () => act(linkDialog) }, "New link...") : null,
    h("h4", {}, "In-links"), ...links(row.in, false),
    h("h4", {}, "Record"),
    h("div", { class: "meta" }, S.data.system_attributes.map((n) => h("div", {}, `${n}: ${row.values[n] || ""}`))),
    h("p", {}, h("button", { onclick: () => act(() => historyDialog(absno)) }, "History...")),
  ].filter(Boolean));
}

function showProps() {
  S.props = true;
  renderProps();
}

// ---------------------------------------------------------------- object actions

function needObject(editing) {
  const row = selectedRow();
  if (!row) throw new Error("Select an object first.");
  if (editing && !writable()) throw new Error("A baseline is read only.");
  return row;
}

const addObject = (where) => act(async () => {
  if (!S.data) throw new Error("Open a formal module first.");
  if (!writable()) throw new Error("A baseline is read only.");
  const ref = where === "end" ? null : needObject(true).absno;
  const made = await api("add_object", { module: S.moduleId, ref, where });
  clearFilters();
  S.selected = made.absno;
  S.props = true;
  await refresh();
  scrollToSelected();
  const first = $("props").querySelector("textarea");
  if (first) first.focus();
});

const objectOperation = (operation, extra) => act(async () => {
  const row = needObject(true);
  await api(operation, { module: S.moduleId, absno: row.absno, ...extra });
  await refresh();
  scrollToSelected();
});

const move = (direction) => objectOperation("move_object", { direction });
const undeleteObject = () => objectOperation("undelete_object");

const deleteObject = () => act(async () => {
  const row = needObject(true);
  if (row.deleted) throw new Error(`${row.id} is already deleted.`);
  confirmDialog("Delete object", `Delete ${row.id}? It can be undeleted (View, Deleted objects).`, "Delete", async () => {
    await api("delete_object", { module: S.moduleId, absno: row.absno });
    await refresh();
  });
});

async function historyDialog(absno) {
  const entries = await api("history", { module: S.moduleId, absno: absno === undefined ? null : absno });
  const title = absno === undefined ? "Module history" : "History of " + needObject().id;
  dialog(title, longTable(["When", "Who", "ID", "Action", "Attribute", "Old value", "New value"], entries.reverse(),
    (e) => h("tr", {}, [e.when, e.who, e.id, e.action, e.attribute, e.old, e.new].map((v) => h("td", {}, v)))));
}

// ---------------------------------------------------------------- links

function formalModules() {
  return [...S.items.values()].filter((n) => n.kind === "formal" && !n.deleted);
}

async function linkDialog() {
  const row = needObject(true);
  const source = { module: S.moduleId, absno: row.absno };
  const modules = field({ type: "select", options: formalModules().map((n) => [n.id, n.path]), value: String(S.moduleId) });
  const target = h("select", { size: 10 });
  const names = [...S.items.values()].filter((n) => n.kind === "link" && !n.deleted).map((n) => n.path);
  const linkModule = field({ type: "select", options: [["", "(default)"], ...names] });
  const fill = async () => {
    const objects = await api("objects", { module: Number(modules.value) });
    target.replaceChildren(...objects.map((o) => h("option", { value: o.id },
      `${o.id}  ${o.number}  ${o.text.slice(0, 90)}`)));
  };
  modules.addEventListener("change", () => act(fill));
  await fill();
  dialog("New link from " + row.id, h("div", { class: "form" },
    h("label", {}, "Target module"), modules, h("label", {}, "Target object"), target,
    h("label", {}, "Link module"), linkModule), [
    { label: "Create link", primary: true, action: async () => {
      if (!target.value) throw new Error("Choose a target object.");
      const { note } = await api("create_link", { source, target_module: Number(modules.value), target: target.value, link_module: linkModule.value });
      await loadTree();
      await refresh();
      if (note) say(note);
    } },
    { label: "Cancel" },
  ]);
}

const startLink = () => act(async () => {
  const row = needObject(true);
  S.linkStart = { module: S.moduleId, absno: row.absno, id: row.id };
  renderMain();
  say(`Link starts at ${row.id}. Select the target, then Link, Make link from start.`);
});

const finishLink = () => act(async () => {
  if (!S.linkStart) throw new Error("First select the source object and choose Link, Start link.");
  const row = needObject(true);
  const { module, absno, id } = S.linkStart;
  const { note } = await api("create_link", { source: { module, absno }, target_module: S.moduleId, target: row.id });
  await loadTree();
  await refresh();
  say(`Linked ${id} to ${row.id}${note ? ". " + note : ""}`);
});

// ---------------------------------------------------------------- views, columns, filters

function sortableNames() {
  return ["ID", ...S.data.attributes.filter((a) => a.scope === "object").map((a) => a.name), ...S.data.system_attributes];
}

function toolButton(label, why, action, options) {
  const { title, ...rest } = options || {};
  return h("button", { type: "button", onclick: action, disabled: !!why, title: why ? `${title || label}: ${why}` : title, ...rest }, label);
}

function renderToolbar() {
  const bar = $("toolbar");
  const dxl = toolButton("DXL...", "", () => act(openDxl), { class: "dxl" });
  if (!S.data) {
    return bar.replaceChildren(dxl, h("span", { class: "hint" }, "For the other tools, open a formal module (blue M): pick it in the list below or in the tree."));
  }
  const quick = h("input", { type: "search", id: "quick", placeholder: "Filter text...", value: S.quick,
    "aria-label": "Filter text", oninput: (e) => { S.quick = e.target.value; renderMain(); } });
  const views = field({ type: "select", options: [["", "Standard view"], ...Object.keys(S.data.views)], value: S.view });
  views.setAttribute("aria-label", "View");
  views.addEventListener("change", () => act(() => applyView(views.value)));
  const sort = field({ type: "select", options: [["", "Document order"], ...sortableNames().map((n) => [n, "Sort: " + n])], value: S.sort || "" });
  sort.setAttribute("aria-label", "Sort");
  sort.addEventListener("change", () => { S.sort = sort.value || null; renderMain(); });
  const actions = toolButton("Object...", can.object(), (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    showMenu(objectMenu(), box.left, box.bottom);
  }, { title: "What can be done with the selected object" });
  bar.replaceChildren(
    toolButton("New object", can.write(), () => addObject(selectedRow() ? "after" : "end")),
    toolButton("New child", can.change(), () => addObject("child"), { class: "wide-only" }),
    ...[["Up", "up", "Move up"], ["Down", "down", "Move down"], ["Promote", "promote", "Out one level"],
      ["Demote", "demote", "In one level"]].map(([label, direction, title]) =>
      toolButton(label, can.move(direction), () => move(direction), { title, class: "wide-only" })),
    actions,
    toolButton("Properties", "", () => { S.props = !S.props; renderProps(); }),
    h("span", { class: "gap wide-only" }), h("span", { class: "wide-only" }, "View"), views, sort, quick,
    toolButton("Filter...", "", () => act(filterDialog)),
    toolButton("Clear", "", () => { clearFilters(); S.sort = null; render(); }),
    h("span", { class: "gap wide-only" }), dxl);
}

async function applyView(name) {
  S.layout = null;
  if (!name) {
    resetView();
  } else {
    const d = S.data.views[name];
    Object.assign(S, { view: name, filter: d.filter || null, sort: d.sort || null,
      columns: d.layout ? d.layout.filter((c) => c.kind === "attribute").map((c) => c.attribute) : d.columns || [],
      layout: d.layout || null, inLinks: d.in_links !== false, outLinks: d.out_links !== false, quick: "" });
    TRACE.apply(d);
    if (S.filter && !OPERATORS.some(([op]) => op === S.filter.op))
      say(`This view's filter operator "${S.filter.op}" is not supported here; showing everything.`, true);
  }
  await computeLayoutCells();
  render();
}

function needModule() {
  if (!S.data) throw new Error("Open a formal module first.");
  return S.data.module;
}

// -- why something cannot be done now ("" when it can) ------------------------
// Menus and toolbar grey out what cannot be done and say why.

const NO_MODULE = "open a formal module first";
const BASELINE = "a baseline is read only";
const can = {
  module: () => S.data ? "" : NO_MODULE,
  write: () => !S.data ? NO_MODULE : writable() ? "" : BASELINE,
  object: () => !S.data ? NO_MODULE : selectedRow() ? "" : "select an object first",
  change: () => can.object() || can.write() || (selectedRow().deleted ? "the object is deleted" : ""),
  move: (direction) => {
    const why = can.change();
    if (why) return why;
    const row = selectedRow();
    const siblings = S.data.rows.filter((r) => r.parent === row.parent && (r === row || !r.deleted));
    const at = siblings.indexOf(row);
    if (direction === "up") return at > 0 ? "" : "already first at its level";
    if (direction === "down") return at < siblings.length - 1 ? "" : "already last at its level";
    if (direction === "promote") return row.parent !== null ? "" : "already at the top level";
    return at > 0 ? "" : "no object above it at its level";
  },
  remove: () => can.change()
    || (S.data.rows.some((r) => r.parent === S.selected && !r.deleted) ? "delete its children first" : ""),
  undelete: () => can.object() || can.write() || (selectedRow().deleted ? "" : "not deleted (see View, Deleted objects)"),
  compare: () => can.module() || (S.data.baselines.length ? "" : "no baselines yet"),
  baseline: () => !S.data ? NO_MODULE : writable() ? "" : "open the current version first",
  savedView: () => can.write() || (S.view ? "" : "choose a saved view first"),
  linkEnd: () => can.change() || (S.linkStart ? "" : "use Start link first"),
};

// The ID, main and attribute columns as a view's layout holds them.
const plainColumns = (names) => [
  { kind: "id", title: "ID", width: 80, justify: "left" },
  { kind: "main", title: null, width: 400, justify: "left" },
  ...names.filter((n) => n !== "ID").map((n) => ({ kind: "attribute", title: n, width: 150, justify: "left", attribute: n }))];

function columnsDialog() {
  needModule();
  const names = [...S.data.attributes.filter((a) => a.scope === "object").map((a) => a.name), ...S.data.system_attributes];
  const boxes = names.map((n) => h("input", { type: "checkbox", checked: S.columns.includes(n), value: n }));
  const incoming = h("input", { type: "checkbox", checked: S.inLinks });
  const outgoing = h("input", { type: "checkbox", checked: S.outLinks });
  dialog("Columns", h("div", { class: "checks" },
    boxes.map((b) => h("label", {}, b, " " + b.value)),
    h("hr"), h("label", {}, outgoing, " Out-links (traceability)"), h("label", {}, incoming, " In-links (traceability)")), [
    { label: "Apply", primary: true, action: () => {
      S.columns = boxes.filter((b) => b.checked).map((b) => b.value);
      // choosing columns here replaces a script's arrangement; its DXL columns stay, at the end
      const computed = (S.layout || []).filter((c) => c.kind === "dxl");
      S.layout = computed.length ? [...plainColumns(S.columns), ...computed] : null;
      S.layoutCells = [];
      S.inLinks = incoming.checked;
      S.outLinks = outgoing.checked;
      return computeLayoutCells().then(() => render());
    } },
    { label: "Cancel" },
  ]);
}

// -- DXL column: layout DXL run once for each object ------------------------

function dxlError(error) {
  return (error.line ? `line ${error.line}: ` : "") + error.message;
}

async function computeDxlColumn() {
  const column = S.dxlColumn;
  const reply = await api("dxl_column", { module: S.moduleId, source: column.source });
  column.cells = reply.cells;
  if (reply.error) {
    S.dxlColumn = null;
    say("DXL column removed. " + dxlError(reply.error), true);
  }
}

async function dxlColumnDialog() {
  needModule();
  if (!writable()) throw new Error("DXL columns work on the current version, not a baseline.");
  const scripts = await api("scripts");
  const source = h("textarea", { class: "layout", wrap: "off", "aria-label": "Layout DXL",
    value: stored("dxl-column") ?? "display(identifier(obj))\n" });
  source.spellcheck = false;
  const title = h("input", { type: "text", value: S.dxlColumn ? S.dxlColumn.title : "DXL column" });
  const pick = h("select", {}, h("option", { value: "" }, "Load layout script..."),
    scripts.layout.map((n) => h("option", { value: n }, n)));
  pick.addEventListener("change", () => act(async () => {
    if (!pick.value) return;
    source.value = (await api("load_script", { name: pick.value, column: true })).source.replace(/\r\n/g, "\n");
    title.value = pick.value.replace(/\.dxl$/, "").replace(/_/g, " ");
  }));
  dialog("DXL column", h("div", {}, h("p", {}, "Runs once for each object, as obj. display() writes into the cell."),
    h("p", {}, pick, " Column title ", title), source), [
    { label: "Apply", primary: true, action: async () => {
      stored("dxl-column", source.value);
      const reply = await api("dxl_column", { module: S.moduleId, source: source.value });
      if (reply.error) throw new Error(dxlError(reply.error));
      S.dxlColumn = { title: title.value || "DXL column", source: source.value, cells: reply.cells };
      render();
    } },
    { label: "Remove column", action: () => { S.dxlColumn = null; render(); } },
    { label: "Cancel" },
  ]);
}

const importReqif = () => act(async () => {
  const folder = containerForNew().path;
  chooseFile(".reqif,.reqifz,.xml", async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    confirmDialog("Import ReqIF", `Import ${file.name} as new modules in ${folder}?`, "Import", async () => {
      const reply = await api("import_reqif", { folder, filename: file.name, base64_data: btoa(text) });
      await loadTree();
      const done = `Imported ${reply.modules.length} module(s), ${reply.objects} objects, ${reply.links} links`;
      // What the file held that did not come in. Said in a box as well, so it is not missed.
      const dropped = [
        reply.embedded_objects && `${reply.embedded_objects} picture(s) or embedded (OLE) object(s) dropped; only their fallback text was kept`,
        reply.unplaced_objects && `${reply.unplaced_objects} object(s) in no specification not imported`,
        reply.skipped_relations && `${reply.skipped_relations} relation(s) to objects that were not imported skipped`,
      ].filter(Boolean);
      say([done, ...dropped].join("; "));
      if (dropped.length) {
        dialog("Not everything was imported", h("div", {}, h("p", {}, done + "."),
          h("ul", {}, dropped.map((line) => h("li", {}, line)))));
      }
    });
  });
});

function filterDialog() {
  needModule();
  const now = S.filter || { attribute: "Object Text", op: "contains", value: "" };
  formDialog("Filter", [
    { name: "attribute", label: "Attribute", type: "select", options: sortableNames(), value: now.attribute },
    { name: "op", label: "Condition", type: "select", options: OPERATORS, value: now.op },
    { name: "value", label: "Value", value: now.value },
  ], "Apply", (v) => { S.filter = v; render(); });
}

function saveViewDialog() {
  const m = needModule();
  if (!writable()) throw new Error("A baseline is read only.");
  formDialog("Save view", [{ name: "name", label: "View name", value: S.view }], "Save", async ({ name }) => {
    await api("save_view", { module: m.id, name, definition: {
      ...(S.layout ? { layout: S.layout } : { columns: S.columns }),
      filter: S.filter, sort: S.sort, in_links: S.inLinks, out_links: S.outLinks, ...TRACE.definition() } });
    S.view = name;
    await refresh();
  });
}

function deleteViewDialog() {
  const m = needModule();
  if (!S.view) throw new Error("Choose a saved view first.");
  confirmDialog("Delete view", `Delete the view "${S.view}"?`, "Delete", async () => {
    await api("delete_view", { module: m.id, name: S.view });
    resetView();
    await refresh();
  });
}

// ---------------------------------------------------------------- attribute definitions

function attributesDialog() {
  const m = needModule();
  const editable = writable();
  const holder = h("div", {});
  const draw = () => {
    const rows = S.data.attributes.map((a) => {
      let value = null;
      if (a.scope === "module") {
        const [input, read] = valueInput(a, a.module_value || "");
        input.disabled = !editable;
        input.addEventListener("change", () => inside(async () => {
          await api("set_module_value", { module: m.id, name: a.name, value: read() });
        }));
        value = input;
      }
      const standard = ["Object Heading", "Object Short Text", "Object Text"].includes(a.name);
      return h("tr", {},
        h("td", {}, a.name), h("td", {}, a.type + (a.type === a.base ? "" : ` (${a.base}${a.multi ? ", multi-valued" : ""})`)),
        h("td", {}, a.scope), h("td", {}, a.values.join(", ")), h("td", {}, a.default), h("td", {}, value),
        h("td", { class: "code" }, a.dxl),
        h("td", {}, !editable || standard ? null : h("button", { onclick: () => confirmDialog("Delete attribute",
          `Delete "${a.name}" and every value it holds in this module?`, "Delete", async () => {
            await api("delete_attribute", { module: m.id, name: a.name });
            await refresh();
            draw();
          }) }, "Delete")));
    });
    holder.replaceChildren(listTable(["Name", "Type", "Scope", "Values", "Default", "Module value", "Attribute DXL", ""], rows),
      editable ? h("p", {}, h("button", { onclick: () => newAttributeDialog(draw) }, "New attribute...")) : "");
  };
  let box = null;
  const inside = async (work) => {
    try {
      box.problem.textContent = "";
      await work();
      await refresh();
      draw();
    } catch (e) {
      box.problem.textContent = e.message;
    }
  };
  draw();
  box = dialog("Attributes of " + m.name, holder);
}

function newAttributeDialog(after) {
  const m = needModule();
  const NEW = "\u0000new";
  const name = field({}), scope = field({ type: "select", options: ["object", "module"] });
  const type = field({ type: "select", options: [...S.data.types.map((t) => [t.name, t.name]), [NEW, "New enumeration type..."]], value: "String" });
  const typeName = field({}), values = field({ type: "textarea" });
  const multi = field({ type: "checkbox" }), initial = field({});
  const dxl = h("textarea", { class: "code", wrap: "off", spellcheck: false, "aria-label": "Attribute DXL",
    placeholder: "obj.attrDXLName = identifier(obj)" });
  const extra = [h("label", {}, "New type name"), typeName, h("label", {}, "Values, one per line"), values];
  const show = () => extra.forEach((node) => { node.hidden = type.value !== NEW; });
  type.addEventListener("change", show);
  show();
  dialog("New attribute", h("div", { class: "form" },
    h("label", {}, "Name"), name, h("label", {}, "Type"), type, ...extra,
    h("label", {}, "Scope"), scope, h("label", {}, "Multi-valued"), multi, h("label", {}, "Default"), initial,
    h("label", {}, "Attribute DXL (optional)"), h("div", {}, dxl,
      h("div", { class: "meta" }, "Calculates the value of each object. Object scope, single value, no default."))), [
    { label: "Create", primary: true, action: async () => {
      const args = { module: m.id, name: name.value, type: type.value, scope: scope.value, multi: multi.checked, default: initial.value,
        dxl: dxl.value.trim() ? dxl.value : "" };
      if (type.value === NEW) {
        args.type = typeName.value.trim();
        if (!args.type) throw new Error("Name the new type.");
        args.new_type = { base: "Enumeration", values: values.value.split("\n").map((v) => v.trim()).filter(Boolean) };
      }
      await api("create_attribute", args);
      await refresh();
      if (after) after();
    } },
    { label: "Cancel" },
  ]);
}

// ---------------------------------------------------------------- baselines

function newBaselineDialog() {
  const m = needModule();
  if (!writable()) throw new Error("Open the current version to baseline it.");
  formDialog("New baseline of " + m.name, [
    { name: "major", label: "Major version", type: "checkbox" },
    { name: "suffix", label: "Suffix (optional)" },
    { name: "annotation", label: "Annotation", type: "textarea" },
  ], "Create baseline", async (v) => {
    const made = await api("create_baseline", { module: m.id, ...v });
    await refresh();
    say(`Created baseline ${made.label}`);
  });
}

function baselinesDialog() {
  const m = needModule();
  let box = null;
  const rows = S.data.baselines.map((b) => h("tr", {},
    h("td", {}, b.label), h("td", {}, b.annotation), h("td", {}, b.created_by), h("td", {}, b.created_on),
    h("td", {},
      h("button", { onclick: () => { box.close(); act(() => openModule(b.id)); } }, "Open read-only"), " ",
      h("button", { onclick: () => { box.close(); act(() => compareDialog(b.id)); } }, "Compare"))));
  box = dialog("Baselines of " + m.name,
    rows.length ? listTable(["Version", "Annotation", "By", "On", ""], rows) : h("p", {}, "There are no baselines yet."),
    [writable() ? { label: "New baseline...", action: () => { setTimeout(() => act(newBaselineDialog)); } } : null,
      { label: "Close" }].filter(Boolean));
}

function compareDialog(preselect) {
  const m = needModule();
  const all = S.data.baselines.map((b) => [b.id, `Baseline ${b.label}`]);
  if (!all.length) throw new Error("This module has no baselines to compare with.");
  const old = field({ type: "select", options: all, value: String(preselect || all[all.length - 1][0]) });
  const current = field({ type: "select", options: [[m.owner, "Current version"], ...all] });
  const result = h("div", {});
  let box = null;
  const run = async () => {
    const changes = await api("compare", { old: Number(old.value), new: Number(current.value) });
    const target = Number(current.value);
    result.replaceChildren(
      h("p", {}, changes.length ? `${changes.length} difference(s). Attribute values, additions and deletions are compared; moves and links are not.`
        : "No differences in attribute values or in which objects exist."),
      changes.length ? longTable(["ID", "Change", "Attribute", "Old", "New"], changes, (c) =>
        h("tr", { class: c.change },
          h("td", {}, c.change === "deleted" ? c.id : h("a", { class: "go", onclick: () => { box.close(); act(() => goTo(target, c.absno)); } }, c.id)),
          h("td", {}, c.change), h("td", {}, c.attribute), h("td", {}, c.old), h("td", {}, c.new))) : "");
    return false;
  };
  box = dialog("Compare " + m.name, h("div", {}, "From ", old, " to ", current, result),
    [{ label: "Compare", primary: true, action: run }, { label: "Close" }]);
  run().catch((e) => { box.problem.textContent = e.message; });
}

// ---------------------------------------------------------------- import and export

function download(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function chooseFile(accept, onFile) {
  document.querySelectorAll("input.chooser").forEach((old) => old.remove());
  // Phones grey out file types they do not know (.dxl, .reqif), so touch screens get no filter.
  const filter = matchMedia("(pointer: coarse)").matches ? undefined : accept;
  const input = h("input", { type: "file", accept: filter, class: "chooser", hidden: true });
  input.addEventListener("change", () => act(() => { input.remove(); return onFile(input.files[0]); }));
  document.body.append(input);
  input.click();
}

async function readUtf8(file) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch (e) {
    throw new Error(`${file.name} is not UTF-8 text. In Excel, save it as "CSV UTF-8".`);
  }
}

const exportCsv = () => act(async () => {
  const m = needModule();
  const save = async (columns) => {
    const file = await api("export_csv", { module: m.id, columns });
    // The marker lets Excel recognise UTF-8.
    download(file.filename, "﻿" + file.text.replace(/^﻿/, ""), "text/csv");
    say("Exported " + file.filename);
  };
  if (!S.columns.length) return save(null);
  dialog("Export CSV", h("p", {}, "Which attributes?"), [
    { label: "All", primary: true, action: () => save(null) },
    // ID and Level stay in, so the file can be imported again.
    { label: "Only the columns shown", action: () => save(["ID", "Number", "Level", "Object Heading", "Object Text",
      ...S.columns.filter((c) => !["Object Heading", "Object Text", "ID"].includes(c)),
      ...(S.outLinks ? ["Links Out"] : []), ...(S.inLinks ? ["Links In"] : [])]) },
    { label: "Cancel" },
  ]);
});

const importCsv = () => act(async () => {
  const m = needModule();
  if (!writable()) throw new Error("A baseline is read only.");
  chooseFile(".csv,text/csv", async (file) => {
    const text = await readUtf8(file);
    confirmDialog("Import CSV", `Import ${file.name} into ${m.path}?`, "Import", async () => {
      const reply = await api("import_csv", { module: m.id, text });
      await refresh();
      const ignored = reply.ignored_columns.length ? `; columns not imported: ${reply.ignored_columns.join(", ")}` : "";
      say(`Imported ${file.name}: ${reply.created} created, ${reply.updated} updated${ignored}`);
    });
  });
});

function exportReqifDialog() {
  const boxes = formalModules().map((n) => h("input", { type: "checkbox", value: n.id, checked: n.id === S.moduleId }));
  const paths = formalModules().map((n) => n.path);
  dialog("Export ReqIF", h("div", { class: "checks" }, boxes.length
    ? boxes.map((b, i) => h("label", {}, b, " " + paths[i])) : "There are no formal modules."), [
    { label: "Export", primary: true, action: async () => {
      const file = await api("export_reqif", { modules: boxes.filter((b) => b.checked).map((b) => Number(b.value)) });
      // a loop: Uint8Array.from takes seconds over a large module
      const binary = atob(file.base64), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      download(file.filename, bytes, "application/xml");
      say("Exported " + file.filename);
    } },
    { label: "Cancel" },
  ]);
}

// ---------------------------------------------------------------- files written by scripts

// The path as the script gave it, without the folder every relative name lands in.
const shownPath = (path) => path.replace(/^\/work\//, "");
const fileName = (path) => path.split(/[\\/]/).pop();

function fileSize(text) {
  const bytes = new TextEncoder().encode(text).length;
  const lines = text ? text.replace(/\n$/, "").split("\n").length : 0;
  return `${lines} line${lines === 1 ? "" : "s"}, ${bytes < 1024 ? bytes + " bytes" : (bytes / 1024).toFixed(1) + " KB"}`;
}

// Rows of comma (or tab) separated text, with double-quoted fields.
function parseSeparated(text, separator) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') value += c;
      else if (text[i + 1] === '"') { value += c; i++; }
      else quoted = false;
    } else if (c === '"' && value === "") quoted = true;
    else if (c === separator) { row.push(value); value = ""; }
    else if (c === "\n") { row.push(value); rows.push(row); row = []; value = ""; }
    else if (c !== "\r") value += c;
  }
  if (value !== "" || row.length) { row.push(value); rows.push(row); }
  return rows;
}

const VIEW_ROWS = 2000, VIEW_CHARS = 200000;

function viewFile(path, text) {
  const body = text.replace(/^\uFEFF/, "");
  const kind = (path.match(/\.(csv|tsv)$/i) || [])[1];
  const raw = () => h("pre", { class: "filetext" },
    body.length > VIEW_CHARS ? body.slice(0, VIEW_CHARS) + "\n... (download the file to see the rest)" : body || "(the file is empty)");
  const table = () => {
    const [head, ...rows] = parseSeparated(body, kind.toLowerCase() === "tsv" ? "\t" : ",");
    return h("div", {},
      h("table", { class: "list report" }, h("thead", {}, h("tr", {}, head.map((c) => h("th", {}, c)))),
        h("tbody", {}, rows.slice(0, VIEW_ROWS).map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))),
      rows.length > VIEW_ROWS ? h("p", {}, `First ${VIEW_ROWS} of ${rows.length} rows; download the file to see them all.`) : null);
  };
  const holder = h("div", {});
  const asTable = h("input", { type: "checkbox", checked: !!(kind && body) });
  const draw = () => holder.replaceChildren(asTable.checked ? table() : raw());
  asTable.addEventListener("change", draw);
  draw();
  dialog(shownPath(path), h("div", {}, kind && body ? h("label", {}, asTable, " Show as a table") : null, holder), [
    { label: "Download", primary: true, action: () => {
      download(fileName(path), text, kind ? "text/csv" : "text/plain");
      return false;
    } },
    { label: "Close" }]);
}

// One written file: its name and size, to look at or to download.
function writtenFile(path, text) {
  return h("div", { class: "written" },
    h("span", { class: "filename" }, shownPath(path)), h("span", { class: "size" }, fileSize(text)),
    h("span", { class: "actions" },
      h("button", { type: "button", onclick: () => viewFile(path, text) }, "View"),
      h("button", { type: "button", onclick: () => download(fileName(path), text,
        /\.csv$/i.test(path) ? "text/csv" : "text/plain") }, "Download")));
}

// ---------------------------------------------------------------- DXL window

const DXL = {};

function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* storage is a convenience only */ }
  return null;
}

function buildDxl() {
  DXL.scripts = h("select", {});
  DXL.context = h("div", { class: "context" });
  DXL.gutter = h("div", { class: "gutter" });
  DXL.source = h("textarea", { wrap: "off", "aria-label": "DXL source",
    value: stored("dxl") ?? 'print "Hello from DXL\\n"\n' });
  DXL.source.spellcheck = false;
  DXL.result = h("div", { class: "result", "aria-live": "polite" });
  DXL.dry = h("input", { type: "checkbox" });
  DXL.yes = h("input", { type: "checkbox" });
  DXL.run = h("button", { class: "primary", onclick: () => act(runDxl), title: "Ctrl+Enter" }, "Run");

  DXL.source.addEventListener("input", sourceChanged);
  DXL.source.addEventListener("scroll", () => { DXL.gutter.scrollTop = DXL.source.scrollTop; });
  DXL.source.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      DXL.source.setRangeText("\t", DXL.source.selectionStart, DXL.source.selectionEnd, "end");
      sourceChanged();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      act(runDxl);
    }
  });
  DXL.scripts.addEventListener("change", () => act(async () => {
    if (!DXL.scripts.value) return;
    const script = await api("load_script", { name: DXL.scripts.value });
    setSource(script.source, DXL.scripts.value);
  }));

  $("dxl").replaceChildren(
    h("div", { class: "titlebar" }, "DXL Interaction", h("button", { onclick: () => { $("dxl").hidden = true; }, title: "Close" }, "x")),
    h("div", { class: "tools" },
      DXL.run, h("label", { title: "Database changes are undone after the run. Files the script writes stay written." }, DXL.dry, " Try without saving"),
      h("label", { title: "What confirm() returns" }, DXL.yes, " Answer Yes to confirm()"),
      DXL.scripts,
      h("button", { onclick: () => chooseFile(".dxl,.inc,.txt", async (f) => setSource(await readUtf8(f), f.name)) }, "Open file..."),
      h("button", { onclick: () => download(DXL.name || "script.dxl", DXL.source.value, "text/plain") }, "Save as..."),
      h("button", { onclick: () => { DXL.result.replaceChildren(); } }, "Clear output"),
      h("button", { onclick: () => act(window.opendoorScriptFiles), title: "Every file a script has written" }, "Written files...")),
    DXL.context,
    h("div", { class: "source" }, DXL.gutter, DXL.source),
    DXL.result);
}

function sourceChanged() {
  const lines = DXL.source.value.split("\n").length;
  DXL.gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n") + "\n\n";
  DXL.gutter.scrollTop = DXL.source.scrollTop;
  stored("dxl", DXL.source.value);
}

function setSource(text, name) {
  DXL.name = name;
  DXL.source.value = text.replace(/\r\n/g, "\n");
  DXL.source.scrollTop = 0;
  sourceChanged();
}

async function openDxl() {
  if (!DXL.source) { buildDxl(); sourceChanged(); }
  $("dxl").hidden = false;
  renderDxlContext();
  const list = await api("scripts");
  DXL.scripts.replaceChildren(
    h("option", { value: "" }, list.names.length ? "Load script..." : "(no scripts folder)"),
    ...list.names.map((n) => h("option", { value: n }, n)));
  DXL.scripts.title = list.folder || "";
  DXL.source.focus();
}

function renderDxlContext() {
  if (!DXL.context) return;
  const m = S.data && S.data.module;
  DXL.context.textContent = !m ? "No current module. Open a formal module to make it current."
    : m.baseline ? "A baseline is open, so the script runs with no current module."
      : "Current module: " + m.path;
}

function goToLine(line) {
  const lines = DXL.source.value.split("\n");
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  DXL.source.focus();
  DXL.source.setSelectionRange(start, start + (lines[line - 1] || "").length);
  DXL.source.scrollTop = Math.max(0, (line - 5) * (parseFloat(getComputedStyle(DXL.source).lineHeight) || 17));
}

async function runDxl() {
  if (DXL.run.disabled) return;
  DXL.run.disabled = true;
  DXL.result.replaceChildren(h("div", { class: "note" }, "Running..."));
  const shownView = S.view, shownAs = JSON.stringify(S.data?.views[S.view]);
  $("dxl").classList.add("ran");
  try {
    const module = S.data && !S.data.module.baseline ? S.moduleId : null;
    const dry = DXL.dry.checked;
    const reply = await api("run_dxl", { source: DXL.source.value, module, view: module === null ? null : S.view || null,
      dry_run: dry, confirm_yes: DXL.yes.checked });
    const parts = [reply.output ? h("div", {}, reply.output) : null];
    if (reply.error) {
      const { line, file, message } = reply.error;
      const where = line ? `${file ? file + ", " : ""}line ${line}: ` : "";
      parts.push(h("div", { class: "fault", onclick: () => { if (line && !file) goToLine(line); } }, where + message));
      if (!dry && !reply.discarded) parts.push(h("div", { class: "note" }, "Changes made before an error are kept. (An error found before running changes nothing.)"));
    } else {
      parts.push(h("div", { class: "note" }, reply.dialogs?.open
        ? "Dialog box open: its callbacks run when you use it." : "Script finished."));
    }
    if (reply.rolled_back) parts.push(h("div", { class: "note" }, "Try without saving: database changes were undone. Files written by the script remain."));
    else if (reply.unsaved.length) parts.push(h("div", { class: "note" }, "Changed without save(). Kept here, but real DOORS would not keep these unless the script saves: " + reply.unsaved.join(", ")));
    // What the script wrote goes first, above however much it printed.
    const files = reply.files || [];
    if (files.length) {
      parts.unshift(h("div", { class: "files" },
        h("div", { class: "heading" }, files.length === 1 ? "The script wrote a file:" : `The script wrote ${files.length} files:`),
        files.map((f) => writtenFile(f.name, f.text)),
        h("div", { class: "note" }, "Download puts a copy in your downloads folder. The files also stay in this browser: Written files, or Database, Files written by scripts.")));
      say(`Script wrote ${files.map((f) => shownPath(f.name)).join(", ")}: View or Download it in the DXL window.`);
    }
    DXL.result.replaceChildren(...parts.filter(Boolean));
    DXL.result.scrollTop = 0;
  } catch (e) {
    DXL.result.replaceChildren(h("div", { class: "fault" }, e.message));
    throw e;
  } finally {
    DXL.run.disabled = false;
  }
  await loadTree();
  if (S.moduleId !== null && !S.items.has(S.moduleId) && !(S.data && S.data.module.baseline)) S.moduleId = S.data = S.selected = null;
  await refresh();
  // the script saved over, or deleted, the view on screen
  if (shownView && S.view === shownView && S.data && JSON.stringify(S.data.views[shownView]) !== shownAs) {
    await applyView(S.data.views[shownView] ? shownView : "");
  }
}

// ---------------------------------------------------------------- menus

function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  document.querySelectorAll("#menubar .open").forEach((b) => b.classList.remove("open"));
}

// entries: [label, action, key hint, why it cannot be done now] or null for a separator.
function showMenu(entries, x, y) {
  closeMenus();
  const menu = h("div", { class: "menu", role: "menu" }, entries.map((entry) => {
    if (entry === null) return h("hr");
    const [label, action, key, why] = entry;
    return h("button", { type: "button", role: "menuitem", disabled: !!why, title: why || undefined,
      onclick: () => { closeMenus(); act(async () => action()); } },
    h("span", { class: "label" }, label),
    why ? h("span", { class: "why" }, why) : h("span", { class: "key" }, key || ""));
  }));
  document.body.append(menu);
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 4)) + "px";
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 4)) + "px";
}

const tick = (on, label) => (on ? "✓ " : "") + label;

function itemMenu() {
  const node = pickedItem();
  const newWhy = containerForNew().deleted ? "that folder is deleted" : "";
  const own = node.id === 1 ? "pick a folder, project, or module in the tree" : "";
  return [
    ["New project...", () => newItem("project", "project"), "", newWhy],
    ["New folder...", () => newItem("folder", "folder"), "", newWhy],
    ["New formal module...", () => newItem("formal", "formal module"), "", newWhy],
    ["New link module...", () => newItem("link", "link module"), "", newWhy],
    null,
    ["Item properties / rename...", itemProperties, "", own || (node.deleted ? "the item is deleted" : "")],
    ["Delete item...", deleteItem, "", own || (node.deleted ? "already deleted" : "")],
    ["Undelete item", undeleteItem, "", node.deleted ? "" : "the item is not deleted"],
    [tick(S.showDeletedItems, "Show deleted items"), async () => { S.showDeletedItems = !S.showDeletedItems; await loadTree(); }],
  ];
}

const moveEntries = () => [["Move up", () => move("up"), "", can.move("up")], ["Move down", () => move("down"), "", can.move("down")],
  ["Promote", () => move("promote"), "", can.move("promote")], ["Demote", () => move("demote"), "", can.move("demote")]];

const objectEntries = () => [
  ["Edit text", editMain, "F2", can.change()],
  ["Object properties", showProps, "Enter", can.object()],
];

function objectMenu() {
  return [
    ...objectEntries(),
    null,
    ["Insert object (same level)", () => addObject("after"), "Ins", can.change()],
    ["Insert object below (child)", () => addObject("child"), "Shift+Ins", can.change()],
    ["Insert object before", () => addObject("before"), "", can.change()],
    null,
    ...moveEntries(),
    null,
    ["Start link", startLink, "", can.change()], ["Make link from start", finishLink, "", can.linkEnd()],
    ["Create link...", linkDialog, "", can.change()],
    null,
    ["Delete object...", deleteObject, "Del", can.remove()], ["Undelete object", undeleteObject, "", can.undelete()],
    ["Object history...", () => historyDialog(needObject().absno), "", can.object()],
  ];
}

const MENUS = {
  File: () => [...itemMenu(), null,
    ["Baselines...", baselinesDialog, "", can.module()], ["New baseline...", newBaselineDialog, "", can.baseline()], null,
    ["Import CSV...", importCsv, "", can.write()], ["Export CSV...", exportCsv, "", can.module()],
    ["Import ReqIF...", importReqif, "", containerForNew().deleted ? "that folder is deleted" : ""],
    ["Export ReqIF...", exportReqifDialog, "", formalModules().length ? "" : "there is no formal module"]],
  Edit: () => [...objectEntries(), null, ...moveEntries(), null,
    ["Delete object...", deleteObject, "Del", can.remove()], ["Undelete object", undeleteObject, "", can.undelete()], null,
    ["Object history...", () => historyDialog(needObject().absno), "", can.object()],
    ["Module history...", () => { needModule(); return historyDialog(); }, "", can.module()]],
  View: () => [["Columns...", columnsDialog, "", can.module()],
    ["DXL column...", () => act(dxlColumnDialog), "", can.baseline()],
    [tick(S.outLinks, "Out-links column"), () => { S.outLinks = !S.outLinks; render(); }, "", can.module()],
    [tick(S.inLinks, "In-links column"), () => { S.inLinks = !S.inLinks; render(); }, "", can.module()],
    [tick(S.showDeleted, "Deleted objects"), async () => { S.showDeleted = !S.showDeleted; await refresh(); }, "", can.module()],
    null, ["Filter...", filterDialog, "", can.module()],
    ["Clear filter and sort", () => { clearFilters(); S.sort = null; render(); }, "",
      can.module() || (S.quick || S.filter || S.sort || TRACE.filtering() ? "" : "nothing is filtered or sorted")],
    null, ["Save view...", saveViewDialog, "", can.write()], ["Delete view...", deleteViewDialog, "", can.savedView()],
    ["Refresh", async () => { await loadTree(); await refresh(); }]],
  Insert: () => [
    ["Object (same level)", () => addObject("after"), "Ins", can.change()],
    ["Object below (child)", () => addObject("child"), "Shift+Ins", can.change()],
    ["Object before", () => addObject("before"), "", can.change()],
    ["Object at end of module", () => addObject("end"), "", can.write()], null,
    ["Attribute...", () => newAttributeDialog(), "", can.write()]],
  Link: () => [["Start link", startLink, "", can.change()], ["Make link from start", finishLink, "", can.linkEnd()],
    ["Create link...", linkDialog, "", can.change()], null,
    ["Show object's links", showProps, "", can.object()]],
  Analysis: () => [["Compare with baseline...", () => compareDialog(), "", can.compare()],
    ["Baselines...", baselinesDialog, "", can.module()]],
  Tools: () => [["DXL editor...", openDxl], ["Attribute definitions...", attributesDialog, "", can.module()],
    ["Recalculate DXL attributes", async () => { needModule(); await refresh(); say("Attribute DXL values recalculated."); }, "",
      can.module() || (S.data.attributes.some((a) => a.dxl) ? "" : "no attribute DXL in this module")]],
  Help: () => [["Keys and markers", () => dialog("Keys and markers", listTable(["Key or mark", "Meaning"], [
    ["Up / Down", "Select the previous / next object"], ["F2 or double-click", "Edit in place"],
    ["Ctrl+Enter", "Save the edit; in the DXL window, run"], ["Esc", "Cancel the edit"],
    ["Enter", "Object properties"], ["Insert / Shift+Insert", "New object / new child"], ["Delete", "Delete object"],
    ["Right-click, or Object...", "Everything that can be done with the selected object"],
    ["▶ red", "The object has out-links"], ["◀ orange", "The object has in-links"],
    ["SUSPECT / S", "The object at the other end of a link changed since the link was made or cleared"],
  ].map((r) => h("tr", {}, r.map((c) => h("td", {}, c))))))]],
};

function buildMenubar() {
  const open = (button, name) => {
    const box = button.getBoundingClientRect();
    showMenu(MENUS[name](), box.left, box.bottom);
    button.classList.add("open");
  };
  $("menubar").replaceChildren(...Object.keys(MENUS).map((name) => h("button", {
    onclick: (e) => { const was = e.currentTarget.classList.contains("open"); closeMenus(); if (!was) open(e.currentTarget, name); },
    // Mouse only: a tap also "enters", and would open the menu just for the click to shut it.
    onpointerenter: (e) => { if (e.pointerType === "mouse" && document.querySelector("#menubar .open")) open(e.currentTarget, name); },
  }, name)));
}

// ---------------------------------------------------------------- keyboard and start

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".menu, #menubar")) closeMenus();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenus();
  if (e.target.closest("input, textarea, select, button, dialog, #dxl") || e.ctrlKey || e.metaKey || e.altKey || !S.data) return;
  const keys = {
    ArrowDown: () => step(1), ArrowUp: () => step(-1), F2: editMain, Enter: showProps,
    Insert: () => addObject(e.shiftKey ? "child" : selectedRow() ? "after" : "end"), Delete: deleteObject,
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
});

function step(by) {
  const rows = visibleRows();
  if (!rows.length) return;
  const at = rows.findIndex((r) => r.absno === S.selected);
  select(rows[Math.max(0, Math.min(rows.length - 1, at + by))].absno);
  scrollToSelected();
}

$("main").addEventListener("scroll", updateRows, { passive: true });
window.addEventListener("resize", updateRows);
for (const [event, printing] of [["beforeprint", true], ["afterprint", false]]) {
  window.addEventListener(event, () => {
    GRID.printing = printing;
    if (gridWindowed()) drawRows($("main").scrollTop);
  });
}

buildMenubar();
act(async () => {
  await loadTree();
  S.tree.children.forEach((c) => S.expanded.add(c.id));
  renderTree();
  render();
});
