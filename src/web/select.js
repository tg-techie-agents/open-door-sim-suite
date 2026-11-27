"use strict";
// Several objects at once, selected as a module window selects them: Shift+click
// takes a run of neighbours at one level with everything below them, and the
// commands here act on that run. S.selected stays the current object.

// The absnos selected from `a` to `b`, in document order: both ends, what is
// below them, and as much more as gives every selected object a common parent.
// `rows` are the module's objects in document order, each { absno, parent }.
function selectionRun(rows, a, b) {
  const byAbsno = new Map(rows.map((r) => [r.absno, r]));
  const path = (absno) => {
    const up = [];
    for (let r = byAbsno.get(absno); r; r = byAbsno.get(r.parent)) up.unshift(r);
    return up;
  };
  const pa = path(a), pb = path(b);
  if (!pa.length || !pb.length) return [];
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  let tops;
  if (i === pa.length || i === pb.length) tops = [pa[Math.min(pa.length, pb.length) - 1]];
  else {
    const level = rows.filter((r) => r.parent === pa[i].parent);
    const [from, to] = [level.indexOf(pa[i]), level.indexOf(pb[i])].sort((x, y) => x - y);
    tops = level.slice(from, to + 1);
  }
  const inside = new Set(tops.map((r) => r.absno));
  for (const r of rows) if (inside.has(r.parent)) inside.add(r.absno); // parents come first
  return rows.filter((r) => inside.has(r.absno)).map((r) => r.absno);
}

const several = () => !!S.data && S.picks.size > 1;

// What a command acts on: the selection, or else the current object.
function chosenRows() {
  if (!S.data) return [];
  if (S.picks.size) return S.data.rows.filter((r) => S.picks.has(r.absno));
  const row = selectedRow();
  return row ? [row] : [];
}

// Those of `rows` whose parent is not among them.
function topRows(rows) {
  const inside = new Set(rows.map((r) => r.absno));
  return rows.filter((r) => !inside.has(r.parent));
}

// `tops` and every loaded object below them.
function treeRows(tops) {
  const inside = new Set(tops.map((r) => r.absno));
  for (const r of S.data.rows) if (inside.has(r.parent)) inside.add(r.absno);
  return S.data.rows.filter((r) => inside.has(r.absno));
}

// "", or how many of `rows` the screen does not show.
function unseen(rows) {
  const seen = new Set(visibleRows().map((r) => r.absno));
  const hidden = rows.filter((r) => !seen.has(r.absno)).length;
  return hidden ? ` (${hidden} of them not on screen: filtered, collapsed, outlined away or below the level shown)` : "";
}

function paintSelection() {
  for (const row of document.querySelectorAll("#main tr[data-absno]"))
    row.classList.toggle("chosen", S.picks.has(Number(row.dataset.absno)));
  renderToolbar();
  renderProps();
  showStatus();
}

function extendSelection(absno) {
  // let an open editor save before the panel is rebuilt
  if (document.activeElement && document.activeElement.matches("input, textarea, select")) document.activeElement.blur();
  if (!selectedRow()) select(absno);
  S.picks = new Set(selectionRun(S.data.rows, S.selected, absno));
  paintSelection();
}

function selectAll() {
  needModule();
  S.picks = new Set(S.data.rows.map((r) => r.absno));
  if (!selectedRow() && S.data.rows.length) S.selected = S.data.rows[0].absno;
  paintSelection();
}

function clearSelection() {
  if (!S.picks.size) return;
  S.picks.clear();
  paintSelection();
}

// For a link command with several objects selected: all of them, or only the current one?
function allOrCurrent(title, then) {
  const row = needObject(true);
  const all = chosenRows().filter((r) => !r.deleted);
  if (!several() || all.length < 2) return then([row]);
  dialog(title, h("p", {}, `${all.length} objects are selected${unseen(all)}. Use all of them, or only the current object ${row.id}?`), [
    { label: `All ${all.length} selected`, primary: true, action: () => then(all) },
    { label: "Current object only", action: () => then([row]) },
    { label: "Cancel" },
  ]);
}

// One attribute, on the current object, the selection, or everything in the view.
function manyDialog() {
  needModule();
  const row = needObject(true);
  const attributes = S.data.attributes.filter((a) => a.scope === "object" && !a.dxl);
  const selected = several() ? chosenRows() : [], view = visibleRows();
  const scope = field({ type: "select", value: selected.length ? "selected" : "current", options: [
    ["current", `Current object (${row.id})`],
    ...(selected.length ? [["selected", `Selected objects (${selected.length})`]] : []),
    ["view", `Objects in current view (${view.length})`]] });
  const which = field({ type: "select", options: attributes.map((a) => a.name) });
  const holder = h("div", {});
  const note = h("p", { class: "hint" });
  let read = null;
  const draw = () => {
    const a = attributes.find((x) => x.name === which.value);
    const targets = scope.value === "selected" ? selected : scope.value === "view" ? view : [row];
    note.textContent = scope.value === "selected" ? `${targets.length} selected objects${unseen(targets)}.` : "";
    if (a.base === "Enumeration" && a.multi) {
      const boxes = a.values.map((v) => h("input", { type: "checkbox", value: v }));
      const add = h("input", { type: "checkbox", checked: true }), remove = h("input", { type: "checkbox" });
      const one = scope.value === "current";
      if (one) for (const b of boxes) b.checked = (row.values[a.name] || "").split("\n").includes(b.value);
      holder.replaceChildren(h("p", {}, boxes.map((b) => h("label", {}, b, ` ${b.value} `))),
        ...(one ? [] : [h("p", {}, h("label", {}, add, " Add checked values"), " ", h("label", {}, remove, " Remove unchecked values"))]));
      read = () => {
        const on = boxes.filter((b) => b.checked).map((b) => b.value);
        if (one) return { value: on.join("\n") };
        if (!add.checked && !remove.checked) throw new Error("Tick Add checked values, Remove unchecked values, or both.");
        return { add: add.checked ? on : [], remove: remove.checked ? boxes.filter((b) => !b.checked).map((b) => b.value) : [] };
      };
    } else {
      const [input, value] = valueInput(a, "");
      input.setAttribute("aria-label", "New value");
      holder.replaceChildren(input);
      read = () => ({ value: value() });
    }
  };
  which.addEventListener("change", draw);
  scope.addEventListener("change", draw);
  draw();
  dialog("Edit attribute", h("div", {}, h("div", { class: "form" },
    h("label", {}, "Attribute"), which, h("label", {}, "Apply to"), scope, h("label", {}, "New value"), holder), note), [
    { label: "OK", primary: true, action: async () => {
      const module = S.moduleId, name = which.value;
      const targets = scope.value === "selected" ? selected : scope.value === "view" ? view : [row];
      const reply = await api("set_value_many", { module, absnos: targets.map((r) => r.absno), name, ...read() });
      if (reply.changes.length) rememberValues(`edit of ${name} on ${reply.changes.length} object(s)`, module, reply.changes);
      await refresh();
      say(`Set ${name} on ${reply.changed} object(s)`
        + (reply.deleted ? `; ${reply.deleted} deleted object(s) left alone` : "")
        + (reply.made_own ? `; ${reply.made_own} now hold their own value instead of the inherited one, which Undo cannot reverse` : "") + ".",
      !!reply.made_own);
    } },
    { label: "Cancel" },
  ]);
}

// ---------------------------------------------------------------- links in bulk

// Links > Create links and Delete links: from the object, selection or view of
// this module to objects of a target module, through one link module. The target
// is not open here, so its objects are all of them or those picked in the list.
function bulkLinksDialog(deleting) {
  needModule();
  const row = needObject(true), module = S.moduleId;
  const selected = several() ? chosenRows().filter((r) => !r.deleted) : [];
  const view = visibleRows().filter((r) => !r.deleted);
  const sources = { current: [row], selected, view };
  const from = field({ type: "select", value: selected.length ? "selected" : "current", options: [
    ["current", `Current object (${row.id})`],
    ...(selected.length ? [["selected", `Selected objects (${selected.length})`]] : []),
    ["view", `Every object in the current view (${view.length})`]] });
  const modules = formalModules();
  const target = field({ type: "select", options: modules.map((n) => [n.id, n.path]),
    value: String((modules.find((n) => n.id !== module) || modules[0]).id) });
  const to = field({ type: "select", options: [["all", "Every object of the target module"], ["chosen", "Only those picked below"]] });
  const list = h("select", { multiple: true, size: 8, "aria-label": "Target objects", hidden: true });
  const names = [...S.items.values()].filter((n) => n.kind === "link" && !n.deleted).map((n) => n.path);
  const linkModule = field({ type: "select", options: deleting ? names : [["", "(default)"], ...names] });
  const ask = h("input", { type: "checkbox", checked: true });
  let objects = [];
  const fill = async () => {
    objects = await api("objects", { module: Number(target.value) });
    list.replaceChildren(...objects.map((o) => h("option", { value: String(o.absno) }, `${o.id}  ${o.number}  ${o.text.slice(0, 70)}`)));
  };
  target.addEventListener("change", () => act(fill));
  to.addEventListener("change", () => { list.hidden = to.value !== "chosen"; });
  act(fill);
  const title = deleting ? "Delete links" : "Create links";
  dialog(title, h("div", {}, h("div", { class: "form" },
    h("label", {}, "From"), from, h("label", {}, "Target module"), target, h("label", {}, "To"), to,
    h("label", {}, "Link module"), linkModule), list,
  h("p", {}, h("label", {}, ask, " Confirm: say how many links first"))), [
    { label: "OK", primary: true, action: async () => {
      const other = Number(target.value);
      const ends = to.value === "all" ? objects.map((o) => o.absno) : [...list.selectedOptions].map((o) => Number(o.value));
      if (!ends.length) throw new Error("Pick at least one target object.");
      if (deleting && !linkModule.value) throw new Error("There is no link module.");
      const args = { sources: sources[from.value].map((r) => ({ module, absno: r.absno })),
        targets: ends.map((absno) => ({ module: other, absno })), link_module: linkModule.value || null };
      const operation = deleting ? "delete_links_between" : "create_links";
      const told = (reply) => (deleting ? `${reply.count} link(s)` : `${reply.made} link(s) (${reply.existing} already there)`
        + (reply.refused.length ? `; refused: ${reply.refused.slice(0, 3).join("; ")}` : ""));
      const go = async () => {
        const reply = await api(operation, args);
        await loadTree();
        await refresh();
        say(`${deleting ? "Deleted" : "Made"} ${told(reply)}.`, !!reply.refused?.length);
      };
      if (!ask.checked) return go();
      const preview = await api(operation, { ...args, preview: true });
      if (!(deleting ? preview.count : preview.made)) {
        throw new Error(deleting ? "There are no such links." : `No link would be made: ${told(preview)}.`);
      }
      confirmDialog(title, `${told(preview)} will be ${deleting ? "deleted. This cannot be undone" : "made"}.`, title, go);
    } },
    { label: "Cancel" },
  ]);
}

// Links > Delete all links: every link into or out of this module.
async function deleteModuleLinks() {
  const m = needModule();
  const counts = await api("delete_all_links", { module: m.id, preview: true });
  if (!counts.out && !counts.in) return say("This module has no links.");
  confirmDialog("Delete all links", `Delete all ${counts.out} out-link(s) and ${counts.in} in-link(s) of ${m.name}? `
    + "This cannot be undone.", "Delete", async () => {
      await api("delete_all_links", { module: m.id });
      await refresh();
    });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.target.closest("input, textarea, select, dialog") && !document.querySelector(".menu")) clearSelection();
}, true); // before the menus close on the same key
