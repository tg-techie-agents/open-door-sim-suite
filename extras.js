"use strict";
// The module window and database explorer functions beyond app.js: modes,
// finding, undo, clipboard, content operations, levels and the Module Explorer,
// columns, sorting and filtering, change bars, links, the link module window,
// favourites, module dialogs and the DXL coverage page. As in app.js, database
// text only ever becomes text, never markup.

const wideBox = (box) => box.problem.closest("dialog").classList.add("page");

// ---------------------------------------------------------------- opening, modes, places

function setReadOnly(on) {
  if (!on && S.readOnly && current()) act(() => api("record_session", { module: S.moduleId }));
  S.readOnly = on;
  render();
  say(on ? "Read-only: nothing on screen can change this module." : "Exclusive edit.");
}

async function openModuleAs(id, readOnly) {
  const node = S.items.get(id);
  for (let up = node.parent; up; up = up.parent) S.expanded.add(up.id);
  S.openingReadOnly = readOnly;
  try {
    await pickItem(id);
  } finally {
    S.openingReadOnly = false;
  }
  if (node.kind === "formal") {
    setReadOnly(readOnly);
  }
}

function openDialog() {
  const modules = [...S.items.values()].filter((n) => (n.kind === "formal" || n.kind === "link") && !n.deleted);
  if (!modules.length) throw new Error("There is no module to open.");
  formDialog("Open module", [
    { name: "id", label: "Module", type: "select", options: modules.map((n) => [n.id, n.path]), value: String(S.picked) },
    { name: "readOnly", label: "Open read-only", type: "checkbox" },
  ], "Open", (v) => openModuleAs(Number(v.id) || modules[0].id, v.readOnly));
}

async function closeModule() {
  const m = needModule();
  const node = S.items.get(m.owner);
  await pickItem(node.parent.id);
}

async function upLevel() {
  const node = pickedItem();
  if (node.parent) await pickItem(node.parent.id);
}

async function goPath(path) {
  const wanted = "/" + path.trim().replace(/^\/+|\/+$/g, "");
  const node = [...S.items.values()].find((n) => n.path.toLowerCase() === wanted.toLowerCase());
  if (!node) throw new Error(`There is no ${wanted} in this database.`);
  for (let up = node.parent; up; up = up.parent) S.expanded.add(up.id);
  await pickItem(node.id);
}

function locationDialog() {
  const input = h("input", { type: "text", value: pickedItem().path, "aria-label": "Location" });
  input.setAttribute("list", "places");
  dialog("Go to location", h("div", {}, input,
    h("datalist", { id: "places" }, [...S.items.values()].map((n) => h("option", { value: n.path })))), [
    { label: "Go", primary: true, action: () => goPath(input.value) }, { label: "Cancel" }]);
}

function searchDialog() {
  const text = h("input", { type: "search", "aria-label": "Search for" });
  const kind = h("select", { "aria-label": "Kind" }, [["", "Anything"], ["formal", "Formal modules"], ["link", "Link modules"],
    ["folder", "Folders"], ["project", "Projects"]].map(([value, label]) => h("option", { value }, label)));
  const holder = h("div", {});
  let box = null;
  const run = () => {
    const want = text.value.toLowerCase();
    const found = [...S.items.values()].filter((n) => n.id !== 1 && (!kind.value || n.kind === kind.value)
      && `${n.name}\n${n.description}`.toLowerCase().includes(want));
    holder.replaceChildren(found.length ? listTable(["Location", "Type", "Description"], found.map((n) => h("tr", {},
      h("td", {}, h("a", { class: "go", onclick: () => { box.problem.closest("dialog").close(); act(() => goPath(n.path)); } }, n.path)),
      h("td", {}, n.kind), h("td", {}, n.description)))) : h("p", {}, "Nothing matches."));
    return false;
  };
  box = dialog("Search database", h("div", {}, text, " ", kind, holder),
    [{ label: "Search", primary: true, action: run }, { label: "Close" }]);
}

// -- favourites: kept in this browser ---------------------------------------

function favourites() {
  try {
    const held = JSON.parse(stored("favourites") || "[]");
    return Array.isArray(held) ? held.filter((p) => typeof p === "string") : [];
  } catch (e) {
    return [];
  }
}

const keepFavourites = (list) => stored("favourites", JSON.stringify(list));

function addFavourite() {
  const path = pickedItem().path;
  const list = favourites();
  if (!list.includes(path)) keepFavourites([...list, path]);
  say(`${path} is in Favourites.`);
}

function organiseFavourites() {
  const holder = h("div", {});
  const draw = () => {
    const list = favourites();
    const change = (next) => () => { keepFavourites(next); draw(); };
    holder.replaceChildren(list.length ? listTable(["Location", ""], list.map((path, i) => h("tr", {}, h("td", {}, path),
      h("td", {}, h("button", { type: "button", disabled: !i, onclick: change([...list.slice(0, i - 1), path, list[i - 1], ...list.slice(i + 1)]) }, "Up"), " ",
        h("button", { type: "button", onclick: change(list.filter((_, at) => at !== i)) }, "Remove")))))
      : h("p", {}, "There are no favourites."));
  };
  draw();
  dialog("Organise favourites", holder);
}

// ---------------------------------------------------------------- module dialogs

function moduleCounts() {
  const live = S.data.rows.filter((r) => !r.deleted);
  const links = (list) => live.reduce((n, r) => n + r[list].length, 0);
  return [
    ["Objects", live.length],
    ["Deleted objects shown", S.data.rows.length - live.length],
    ["Headings", live.filter((r) => r.values["Object Heading"]).length],
    ["Out-links", links("out")],
    ["In-links", links("in")],
    ["Objects with no out-link", live.filter((r) => !r.out.length).length],
    ["Objects with no in-link", live.filter((r) => !r.in.length).length],
    ["Objects with a suspect link", live.filter(isSuspectRow).length],
    ["Baselines", S.data.baselines.length],
  ];
}

function statisticsDialog() {
  const m = needModule();
  const live = S.data.rows.filter((r) => !r.deleted);
  const values = S.data.attributes.filter((a) => a.scope === "object" && a.base === "Enumeration").map((a) => {
    const tally = new Map([...a.values, "(empty)"].map((v) => [v, 0]));
    for (const row of live) {
      for (const v of (row.values[a.name] || "(empty)").split("\n")) tally.set(v, (tally.get(v) || 0) + 1);
    }
    return h("section", {}, h("h4", {}, a.name), listTable(["Value", "Objects"],
      [...tally].map(([v, n]) => h("tr", {}, h("td", {}, v), h("td", {}, String(n))))));
  });
  dialog("Statistics of " + m.name, h("div", {},
    listTable(["Count", ""], moduleCounts().map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, String(v))))), values));
}

function modulePropertiesDialog() {
  const m = needModule();
  const node = S.items.get(m.owner);
  const name = field({ value: node.name }), description = field({ value: node.description }), prefix = field({ value: node.prefix });
  const editable = writable();
  for (const input of [name, description, prefix]) input.disabled = !editable;
  const counts = moduleCounts().map(([k, v]) => `${k}: ${v}`).join("\n");
  let box = null;
  const history = () => { box.problem.closest("dialog").close(); act(() => historyDialog()); };
  box = dialog("Properties of " + m.path, h("div", {},
    h("div", { class: "form" }, h("label", {}, "Name"), name, h("label", {}, "Description (heads the main column)"), description,
      h("label", {}, "ID prefix"), prefix),
    h("h4", {}, "About"), h("pre", { class: "filetext" }, counts + (m.baseline ? `\nBaseline: ${m.baseline}` : "")),
    h("p", {}, h("button", { type: "button", onclick: history }, "History..."), " ",
      h("button", { type: "button", onclick: () => { box.problem.closest("dialog").close(); act(() => accessDialog({ item: m.owner }, m.path)); } }, "Access..."), " ",
      h("button", { type: "button", onclick: () => { box.problem.closest("dialog").close(); act(() => linkRulesDialog(node.name)); } }, "Linksets...")),
    ), [
    editable ? { label: "Save", primary: true, action: async () => {
      await api("update_item", { id: node.id, name: name.value, description: description.value, prefix: prefix.value });
      await loadTree();
      await refresh();
    } } : null,
    { label: "Close" }].filter(Boolean));
}

const lines = (text) => text.split("\n").map((v) => v.trim()).filter(Boolean);

// A new type (starting as a copy of `like`), or `type` changed.
function typeForm(type, done, like) {
  const m = needModule();
  const name = field({ value: type?.name }), description = field({ value: type?.description });
  const base = field({ type: "select", options: ["Enumeration", "String", "Text", "Integer", "Real", "Date"], value: type?.base });
  const values = field({ type: "textarea", value: type?.values.join("\n") });
  const min = field({ value: type?.min }), max = field({ value: type?.max });
  if (like) {
    base.value = like.base;
    description.value = like.description || "";
    values.value = like.values.join("\n");
    min.value = like.min || "";
    max.value = like.max || "";
  }
  dialog(type ? "Edit type " + type.name : "New attribute type", h("div", {}, h("div", { class: "form" },
    h("label", {}, "Name"), name, h("label", {}, "Description"), description, h("label", {}, "Base"), base,
    h("label", {}, "Values, one per line (Enumeration)"), values,
    h("label", {}, "Lowest (Integer, Real, Date)"), min, h("label", {}, "Highest"), max),
    type?.users.length ? h("p", { class: "hint" }, `Used by ${type.users.join(", ")}: the base stays; values can be renamed in place or added at the end.`) : null), [
    { label: type ? "Save" : "Add type", primary: true, action: async () => {
      const list = base.value === "Enumeration" ? lines(values.value) : [];
      const ranged = ["Integer", "Real", "Date"].includes(base.value);
      const extras = { description: description.value };
      if (ranged && min.value.trim()) extras.min = min.value.trim();
      if (ranged && max.value.trim()) extras.max = max.value.trim();
      if (!type) await api("create_type", { module: m.id, name: name.value.trim(), base: base.value, values: list, extras });
      else {
        await api("modify_type", { module: m.id, name: type.name, keeping: true,
          changes: { ...extras, name: name.value.trim(), base: base.value, values: list,
            ...(ranged ? { min: min.value.trim(), max: max.value.trim() } : {}) } });
      }
      await refresh();
      done();
    } },
    { label: "Cancel" },
  ]);
}

const BUILT_IN_TYPES = ["String", "Text", "Integer", "Real", "Date", "Boolean", "Username"];

function typesDialog() {
  const m = needModule();
  const holder = h("div", {});
  const draw = () => {
    holder.replaceChildren(listTable(["Type", "Base", "Values or range", "Used by", ""], S.data.types.map((t) =>
      h("tr", {}, h("td", { title: t.description }, t.name), h("td", {}, t.base),
        h("td", {}, t.values.join(", ") || [t.min, t.max].filter(Boolean).join(" to ")), h("td", {}, t.users.join(", ")),
        // DOORS' own types can be copied but not changed
        h("td", {}, writable() ? [BUILT_IN_TYPES.includes(t.name) ? null : [h("button", { type: "button", onclick: () => act(() => typeForm(t, draw)) }, "Edit"), " "],
          h("button", { type: "button", onclick: () => act(() => typeForm(null, draw, t)) }, "Copy"), " ",
          BUILT_IN_TYPES.includes(t.name) ? null : h("button", { type: "button", disabled: !!t.users.length, title: t.users.length ? "in use" : undefined,
            onclick: () => confirmDialog("Delete type", `Delete the type "${t.name}"?`, "Delete", async () => {
              await api("delete_type", { module: m.id, name: t.name });
              await refresh();
              draw();
            }) }, "Delete")] : null)))),
    writable() ? h("p", {}, h("button", { type: "button", onclick: () => act(() => typeForm(null, draw)) }, "New type...")) : "");
  };
  draw();
  dialog("Attribute types of " + m.name, holder);
}

function attributeEditDialog(a, done) {
  const m = needModule();
  const name = field({ value: a.name }), description = field({ value: a.description });
  const type = field({ type: "select", options: S.data.types.map((t) => [t.name, t.name]), value: a.type });
  type.disabled = true;
  type.title = "An attribute's type cannot be changed once it is created";
  const multi = field({ type: "checkbox", value: a.multi }), initial = field({ value: a.default });
  const object = a.scope === "object";
  const checks = [["inherit", "Inherit from the parent object"], ["history", "Record edits in history"],
    ["bars", "Edits show change bars"], ["dates", "Edits update Last Modified"]].map(([key, label]) =>
    [key, label, h("input", { type: "checkbox", checked: a[key], disabled: key === "inherit" && !object })]);
  const dxl = h("textarea", { class: "code", wrap: "off", spellcheck: false, "aria-label": "Attribute DXL", value: a.dxl });
  dialog("Edit attribute " + a.name, h("div", { class: "form" },
    h("label", {}, "Name"), name, h("label", {}, "Description"), description, h("label", {}, "Type"), type,
    h("label", {}, "Multi-valued"), multi, h("label", {}, "Default"), initial,
    checks.map(([, label, box]) => [h("label", {}, label), box]),
    h("label", {}, "Attribute DXL"), dxl), [
    { label: "Save", primary: true, action: async () => {
      const changes = { name: name.value, description: description.value, multi: multi.checked,
        default: initial.value, dxl: dxl.value.trim() ? dxl.value : "" };
      for (const [key, , box] of checks) if (!box.disabled) changes[key] = box.checked;
      await api("modify_attribute", { module: m.id, name: a.name, changes });
      S.undo = [];
      await refresh();
      done();
    } },
    { label: "Cancel" },
  ]);
}

// -- link module rules: which link module a folder's links go in ----------------

function containerFolder() {
  const node = S.data ? S.items.get(S.data.module.owner) : pickedItem();
  return node.kind === "folder" || node.kind === "project" ? node : node.parent;
}

function linkRulesDialog(from) {
  const folder = containerFolder();
  if (!folder || folder.id === 1) throw new Error("Rules belong to a folder or project below the database root.");
  const holder = h("div", {});
  const source = h("select", { "aria-label": "Source module" }), target = h("select", { "aria-label": "Target module" });
  const linkmod = field({ value: "" });
  const mandatory = h("input", { type: "checkbox" }), overridable = h("input", { type: "checkbox", checked: true });
  let box = null;
  const draw = async () => {
    const info = await api("link_rules", { folder: folder.id });
    for (const [select, names] of [[source, info.sources.map((x) => x.name)], [target, info.targets]]) {
      const chosen = select.value || (select === source && typeof from === "string" ? from : "");
      select.replaceChildren(...names.map((n) => h("option", { value: n }, n)));
      if (names.includes(chosen)) select.value = chosen;
    }
    const inside = (work) => async () => {
      try {
        box.problem.textContent = "";
        await work();
        await draw();
      } catch (e) {
        box.problem.textContent = e.message;
      }
    };
    holder.replaceChildren(info.rules.length ? listTable(["Source", "Target", "Link module", "Rule", ""], info.rules.map((r) =>
      h("tr", {}, h("td", {}, r.source), h("td", {}, r.target), h("td", {}, r.linkmod),
        h("td", {}, [r.mandatory ? "mandatory" : "", r.overridable ? "overridable" : ""].filter(Boolean).join(", ")),
        h("td", {}, h("button", { type: "button", onclick: inside(() => api("remove_link_rule", { folder: folder.id, source: r.source, target: r.target })) }, "Remove")))))
      : h("p", {}, "No rules yet."),
    h("div", { class: "checks" }, info.sources.map((x) => h("label", {}, h("input", { type: "checkbox", checked: x.exclusive,
      onchange: (e) => inside(() => api("set_links_exclusive", { folder: folder.id, module: x.id, exclusive: e.target.checked }))() }),
    ` Links out of ${x.name} only as the rules allow`))));
  };
  box = dialog("Link module rules of " + folder.path, h("div", {}, holder,
    h("fieldset", {}, h("legend", {}, "New rule"), h("div", { class: "form" }, h("label", {}, "Source module"), source,
      h("label", {}, "Target module"), target, h("label", {}, "Link module name"), linkmod,
      h("label", {}, "Mandatory"), mandatory, h("label", {}, "Overridable"), overridable))), [
    { label: "Add rule", primary: true, action: async () => {
      await api("add_link_rule", { folder: folder.id, source: source.value, target: target.value, linkmod: linkmod.value.trim(),
        mandatory: mandatory.checked, overridable: overridable.checked });
      linkmod.value = "";
      await loadTree();
      await draw();
      return false;
    } },
    { label: "Close" }]);
  draw().catch((e) => { box.problem.textContent = e.message; });
}

function purgeItemDialog() {
  const node = pickedItem();
  confirmDialog("Purge item", `Remove ${node.path} and everything in it for good, with the links to and from it? This cannot be undone.`,
    "Purge", async () => {
      await api("purge_item", { id: node.id });
      S.undo = [];
      S.picked = node.parent.id;
      S.moduleId = S.data = S.selected = S.linkStart = S.clip = null;
      await loadTree();
      render();
    });
}

async function defaultLinkDialog() {
  const held = await api("default_link");
  formDialog("Default link module", [{ name: "name", label: "Name, or full path", value: held.name }], "Set", async ({ name }) => {
    await api("set_default_link", { name: name.trim() });
    say(`Links made without naming a link module now go in ${name.trim()}, unless a folder rule says otherwise.`);
  });
}

// ---------------------------------------------------------------- access rights

const RIGHT_NAMES = ["read", "modify", "create", "delete", "control"];

// `thing` is { item } or { module, absno }.
function accessDialog(thing, title) {
  const holder = h("div", {});
  const name = field({}), everyone = h("input", { type: "checkbox" });
  const boxes = RIGHT_NAMES.map((r) => h("input", { type: "checkbox", value: r, checked: r === "read" }));
  const shown = (r) => (r === "control" ? "admin" : r); // the engine's name for it is control
  const adding = h("fieldset", {}, h("legend", {}, "Set an entry"), h("div", { class: "form" },
    h("label", {}, "User name"), name, h("label", {}, "Everyone else instead"), everyone),
  h("p", {}, boxes.map((b) => h("label", {}, b, ` ${shown(b.value)} `))));
  let box = null;
  const change = (args) => act(async () => {
    box.problem.textContent = "";
    try {
      await api("change_access", { ...thing, ...args });
      await draw();
    } catch (e) {
      box.problem.textContent = e.message;
    }
  });
  const button = (label, args) => h("button", { type: "button", onclick: () => change(args) }, label);
  const draw = async () => {
    const info = await api("access", thing);
    adding.hidden = info.inherited || info.root;
    holder.replaceChildren(
      h("p", {}, `You are ${info.user}. `, info.root ? "The database root's rights cannot be changed here."
        : info.inherited ? "These rights are inherited from above." : "These rights are this item's own."),
      listTable(["Name", "Rights", ""], info.entries.map((e) => h("tr", {}, h("td", {}, e.name ?? "Everyone else"),
        h("td", {}, e.rights.map(shown).join(", ") || "none"),
        h("td", {}, !info.inherited && !info.root && e.name !== null ? button("Remove", { action: "unset", name: e.name }) : null)))),
      info.root ? "" : h("p", {}, info.inherited ? button("Make specific", { action: "specific" })
        : [button("Inherit from above", { action: "inherit" }), " ",
          h("button", { type: "button", title: "Skips the check: the way out if nobody here may change these rights",
            onclick: () => change({ action: "reset" }) }, "Reset (as database manager)")]));
  };
  box = dialog("Access rights: " + title, h("div", {}, holder, adding,
    h("p", { class: "hint" }, "Enforced on changes. Not here: read restrictions, rights on views or attributes, and groups.")), [
    { label: "Set entry", primary: true, action: async () => {
      await api("change_access", { ...thing, action: "set", name: everyone.checked ? null : name.value.trim() || (() => { throw new Error("Name a user, or tick Everyone else."); })(),
        rights: boxes.filter((b) => b.checked).map((b) => b.value) });
      await draw();
      return false;
    } },
    { label: "Close" }]);
  draw().catch((e) => { box.problem.textContent = e.message; });
}

function itemAccess() {
  const node = pickedItem();
  accessDialog({ item: node.id }, node.path);
}

function objectAccess() {
  const row = needObject();
  accessDialog({ module: S.moduleId, absno: row.absno }, row.id);
}

async function toggleProject() {
  const node = pickedItem();
  await api("set_project", { id: node.id, project: node.kind === "folder" });
  await loadTree();
  render();
}

// ---------------------------------------------------------------- undo

// Each entry: { label, run }. `run` refuses if the database has since changed there.
function remember(label, run) {
  S.undo.push({ label, run });
  if (S.undo.length > 100) S.undo.shift();
}

// Undo of one object's values: only while they are still what the change left.
function rememberValues(label, module, changes) {
  remember(label, async () => {
    const reply = await api("restore_values", { module, changes });
    say(`Undid ${label}${reply.skipped ? `; ${reply.skipped} value(s) changed since and were left alone` : ""}.`,
      !!reply.skipped);
  });
}

const undo = () => act(async () => {
  if (S.data && S.readOnly) throw new Error("The module is open read-only.");
  const last = S.undo.pop();
  if (!last) return say("Nothing to undo.");
  say("Undid " + last.label + ".");
  await last.run();
  await loadTree();
  await refresh();
});

// One value set from the screen, undoably.
async function setValue(module, absno, name, before, value) {
  const reply = await api("set_values", { module, absno, values: { [name]: value } });
  // there is no giving a value back to its parent, so Undo would not be undoing
  if (reply && reply.made_own.includes(name)) say(`${name} now has its own value here instead of the inherited one. Undo cannot reverse that.`);
  else rememberValues(`edit of ${name}`, module, [{ absno, name, before, after: value }]);
}

// The same for a value given with its formatting; `kept` is what it had, or null.
async function setFormatted(module, absno, name, before, kept, doc) {
  const reply = await api("set_values", { module, absno, rich: { [name]: doc } });
  if (reply && reply.made_own.includes(name)) {
    say(`${name} now has its own value here instead of the inherited one. Undo cannot reverse that.`);
  } else {
    // Undo gives back the formatting too; the engine reads it from these paragraphs
    rememberValues(`edit of ${name}`, module,
      [{ absno, name, before, after: richPlain(doc), doc: kept || undefined }]);
  }
}

// ---------------------------------------------------------------- clipboard

// Copy takes the current object alone unless `hierarchy`; cut, and a selection,
// always take what is below.
function clipTake(cut, hierarchy = cut) {
  const row = needObject(cut);
  const rows = several() ? topRows(chosenRows()).filter((r) => !r.deleted) : [row];
  if (!rows.length) throw new Error("Nothing here can be copied: the selection is deleted.");
  const whole = cut || hierarchy || several();
  const id = rows.length > 1 ? `${rows.length} objects from ${rows[0].id}` : rows[0].id;
  S.clip = { module: S.moduleId, absnos: rows.map((r) => r.absno), id, cut, hierarchy: whole };
  say(`${cut ? "Cut" : "Copied"} ${id}${whole ? " with what is below" : " (this object only)"}. Select an object, then Paste.`
    + (cut ? " Nothing moves until you paste." : ""));
}

const paste = (where) => act(async () => {
  const why = can.paste();
  if (why) throw new Error(why);
  const row = selectedRow();
  const clip = S.clip;
  const made = await api("paste_object", { source: { module: clip.module, absnos: clip.absnos }, module: S.moduleId,
    ref: row ? row.absno : null, where: row ? where : "end", cut: clip.cut, hierarchy: clip.hierarchy });
  if (clip.cut) S.clip = null;
  clearFilters();
  S.picks = new Set();
  S.selected = made.absno;
  await refresh();
  syncNotRun();
  reveal(made.absno);
  say(clip.cut ? `Moved ${clip.id}.` : `Pasted a copy of ${clip.id}: ${made.count} object(s)`
    + (made.skipped.length ? `; not copied: ${made.skipped.join(", ")}` : "") + ".", !clip.cut && !!made.skipped.length);
});

// ---------------------------------------------------------------- content

const swapHeadingText = () => act(async () => {
  const row = needObject(true), module = S.moduleId;
  const heading = row.values["Object Heading"] || "", text = row.values["Object Text"] || "";
  // formatting goes across with its text, and comes back on Undo
  const was = { "Object Heading": row.rich?.["Object Heading"], "Object Text": row.rich?.["Object Text"] };
  const given = was["Object Heading"] || was["Object Text"]
    ? { rich: { "Object Heading": was["Object Text"] || richDoc(text), "Object Text": was["Object Heading"] || richDoc(heading) } }
    : { values: { "Object Heading": text, "Object Text": heading } };
  await api("set_values", { module, absno: row.absno, ...given });
  rememberValues("swap of heading and text", module, [
    { absno: row.absno, name: "Object Heading", before: heading, after: text, doc: was["Object Heading"] },
    { absno: row.absno, name: "Object Text", before: text, after: heading, doc: was["Object Text"] }]);
  await refresh();
});

const splitHeading = () => objectOperation("split_heading", {});
const splitObject = () => objectOperation("split_object", {});

function purgeDialog() {
  const m = needModule();
  confirmDialog("Purge deleted objects", `Remove every deleted object of ${m.name} for good, with its links? This cannot be undone.`,
    "Purge", async () => {
      const reply = await api("purge", { module: m.id });
      S.undo = [];
      await refresh();
      say(`Purged ${reply.purged} object(s).`);
    });
}

function purgeObject() {
  needObject(true);
  const module = S.moduleId, tops = topRows(chosenRows()).filter((r) => r.deleted);
  if (!tops.length) throw new Error("Delete it first.");
  const going = treeRows(tops);
  const what = tops.length === 1 ? tops[0].id : `${tops.length} objects`;
  confirmDialog("Purge", `Remove ${what}${going.length > tops.length ? " and everything below" : ""} for good, with their links? `
    + "This cannot be undone.", "Purge", async () => {
      try {
        for (const top of tops) await api("purge_object", { module, absno: top.absno });
      } finally {
        S.undo = [];
        S.picks = new Set();
        await refresh();
      }
    });
}

// Edit one of the two text attributes in place, whether or not it shows yet.
function editNamed(name) {
  const row = needObject(true);
  if (row.deleted) throw new Error(`${row.id} is deleted.`);
  reveal(row.absno);
  const tr = document.querySelector("#main tr.picked");
  if (!tr) return say(`${row.id} is hidden by the filter. Clear the filter to edit it.`, true);
  let holder = tr.querySelector(name === "Object Heading" ? ".heading" : ".text");
  if (!holder && name === "Object Heading" && tr.querySelector(".text")) {
    holder = h("span", { class: "heading" });
    tr.querySelector(".text").before(holder);
  }
  if (!holder) return say("This view has no main column. Edit the text in Properties, or choose Standard view.", true);
  editCell(row, name, holder);
}

// ---------------------------------------------------------------- find, replace, go to

// Bring an object into sight: out of collapsed branches and below no level limit.
function reveal(absno) {
  const rows = new Map(S.data.rows.map((r) => [r.absno, r]));
  let row = rows.get(absno);
  if (!row) return;
  let hidden = !!S.maxLevel && row.level > S.maxLevel;
  if (hidden) S.maxLevel = 0;
  for (let up = rows.get(row.parent); up; up = rows.get(up.parent)) hidden = S.collapsed.delete(up.absno) || hidden;
  if (S.outlining && !row.values["Object Heading"]) {
    S.outlining = false;
    hidden = true;
  }
  if (hidden) render();
  select(absno);
  scrollToSelected();
}

const searched = (row) => [row.id, ...Object.values(row.values)].join("\n");

function findStep(by) {
  if (!S.data) return;
  const { text, matchCase } = S.find;
  if (!text) return openFind(false);
  const fold = (s) => (matchCase ? s : s.toLowerCase());
  const rows = visibleRows();
  const hits = rows.map((r, i) => [r, i]).filter(([r]) => fold(searched(r)).includes(fold(text)));
  if (!hits.length) return tellFind("Not found.");
  const at = rows.findIndex((r) => r.absno === S.selected);
  const next = by > 0 ? hits.find(([, i]) => i > at) || hits[0] : [...hits].reverse().find(([, i]) => i < at) || hits.at(-1);
  reveal(next[0].absno);
  tellFind(`${hits.indexOf(next) + 1} of ${hits.length} objects (${next[0].id})`);
}

function tellFind(text) {
  const out = $("findbar").querySelector(".found");
  if (out) out.textContent = text;
  say(text);
}

async function replaceMatches(all) {
  if (!writable()) throw new Error("The module is read only.");
  const { text, matchCase, with: to, allText } = S.find;
  if (!text) throw new Error("Type what to find.");
  const module = S.moduleId;
  const row = selectedRow();
  if (!all && !row) throw new Error("Select an object first.");
  const go = async () => {
    const reply = await api("replace_text", { module, absnos: all ? null : [row.absno], find: text, replace: to,
      match_case: matchCase, all_text: !!allText });
    if (reply.changes.length) rememberValues("replacement", module, reply.changes);
    await refresh();
    tellFind(`Replaced ${reply.count} occurrence(s) in ${new Set(reply.changes.map((c) => c.absno)).size} object(s).`);
  };
  if (!all) return go();
  confirmDialog("Replace all", `Replace "${text}" with "${to}" in ${allText ? "every String and Text attribute" : "Object Heading and Object Text"} `
    + "of every object in the module, including objects not on screen?", "Replace all", go);
}

function openFind(replacing) {
  needModule();
  const bar = $("findbar");
  const input = h("input", { type: "search", value: S.find.text, placeholder: "Find...", "aria-label": "Find",
    oninput: (e) => { S.find.text = e.target.value; } });
  const to = h("input", { type: "text", value: S.find.with, placeholder: "Replace with...", "aria-label": "Replace with",
    oninput: (e) => { S.find.with = e.target.value; } });
  const matchCase = h("input", { type: "checkbox", checked: S.find.matchCase,
    onchange: (e) => { S.find.matchCase = e.target.checked; } });
  const button = (label, work) => h("button", { type: "button", onclick: () => act(work) }, label);
  const close = () => { bar.hidden = true; bar.replaceChildren(); };
  const within = h("select", { "aria-label": "Replace in", onchange: (e) => { S.find.allText = e.target.value === "all"; } },
    h("option", { value: "" }, "In heading and text"), h("option", { value: "all" }, "In all text attributes"));
  within.value = S.find.allText ? "all" : "";
  bar.replaceChildren(input, button("Next", () => findStep(1)), button("Previous", () => findStep(-1)),
    h("label", {}, matchCase, " Match case"),
    ...(replacing && writable() ? [to, within, button("Replace", async () => { await replaceMatches(false); }),
      button("Replace all", () => replaceMatches(true))] : []),
    h("span", { class: "found", "aria-live": "polite" }), button("Close", close));
  bar.onkeydown = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && e.target === input) { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  };
  bar.hidden = false;
  input.focus();
  input.select();
}

// A number with a point is a section number, a whole number an absolute number,
// and anything else an identifier. Only what the view shows can be gone to.
function goToDialog() {
  needModule();
  formDialog("Go to", [{ name: "where", label: "Section number (2.1 or 2.), absolute number or ID" }], "Go", ({ where }) => {
    const want = where.trim().toLowerCase();
    const row = /^[0-9]+$/.test(want) ? S.data.rows.find((r) => String(r.absno) === want)
      : /^[0-9]+\.[0-9.-]*$/.test(want) ? S.data.rows.find((r) => r.number.toLowerCase() === want.replace(/\.$/, ""))
        : S.data.rows.find((r) => r.id.toLowerCase() === want);
    if (!row) throw new Error(`There is no object "${where}" in this module.`);
    if (!visibleRows().includes(row)) {
      throw new Error(`${row.id} is not in the current view: it is filtered out, collapsed, outlined away or below the level shown.`);
    }
    select(row.absno);
    scrollToSelected();
  });
}

// ---------------------------------------------------------------- levels and the Module Explorer

function setLevel(level) {
  S.maxLevel = level;
  render();
}

function setCollapsed(on) {
  const row = needObject();
  if (on) S.collapsed.add(row.absno);
  else S.collapsed.delete(row.absno);
  render();
}

function expandAll() {
  S.collapsed.clear();
  S.outlineClosed.clear();
  S.maxLevel = 0;
  render();
}

// The rows neither below the level shown nor inside a collapsed branch.
function outlineRows(rows) {
  if (!S.maxLevel && !S.collapsed.size) return rows;
  const hidden = new Set(); // inside a collapsed branch; parents come before children
  for (const row of S.data.rows) {
    if (row.parent !== null && (hidden.has(row.parent) || S.collapsed.has(row.parent))) hidden.add(row.absno);
  }
  return rows.filter((r) => !hidden.has(r.absno) && (!S.maxLevel || r.level <= S.maxLevel));
}

const OUTLINE_MAX = 3000;

function toggleOutline() {
  S.outline = !S.outline;
  render();
}

// The headings and parents of the module, as a tree.
function renderOutline() {
  const pane = $("outline");
  pane.hidden = !S.outline || !S.data;
  if (pane.hidden) return pane.replaceChildren();
  const kids = new Map();
  const shown = S.outlineFiltered ? new Set(S.data.rows.filter(passes).map((r) => r.absno)) : null;
  for (const row of S.data.rows) {
    if (!kids.has(row.parent)) kids.set(row.parent, []);
    kids.get(row.parent).push(row);
  }
  let count = 0;
  const draw = (row) => {
    const below = (kids.get(row.absno) || []).flatMap(draw);
    const heading = row.values["Object Heading"];
    if ((!heading && !below.length) || count >= OUTLINE_MAX) return [];
    count++;
    const open = !S.outlineClosed.has(row.absno);
    const flip = () => { if (!S.outlineClosed.delete(row.absno)) S.outlineClosed.add(row.absno); renderOutline(); };
    const text = heading || row.values["Object Short Text"] || row.values["Object Text"] || row.id;
    return [h("div", { class: "node" + (row.absno === S.selected ? " picked" : "") + (row.deleted ? " deleted" : "")
      + (shown && !shown.has(row.absno) ? " excluded" : ""),
      "data-absno": row.absno, title: row.id,
      onclick: () => {
        if (shown && !shown.has(row.absno)) return say(`${row.id} is left out by the filter.`);
        document.body.classList.remove("outline-open");
        reveal(row.absno);
        markOutline();
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        showMenu([M("showInExplorer", () => reveal(row.absno), "", "", "Show object"),
          M("collapse", () => { S.outlineClosed.add(row.absno); renderOutline(); }, below.length ? "" : "nothing below", "", "Collapse"),
          M("expand", () => { S.outlineClosed.delete(row.absno); renderOutline(); }, below.length ? "" : "nothing below", "", "Expand"),
          M("expandAll", () => { S.outlineClosed.clear(); renderOutline(); })], e.clientX, e.clientY);
      } },
    h("span", { class: "twisty", onclick: (e) => { e.stopPropagation(); flip(); } }, below.length ? (open ? "-" : "+") : ""),
    h("span", { class: "name" }, `${row.number} ${text.slice(0, 70)}`)),
    below.length && open ? h("div", { class: "branch" }, below) : null];
  };
  const scroll = pane.scrollTop;
  const tree = (kids.get(null) || []).flatMap(draw).filter(Boolean);
  pane.replaceChildren(h("div", { class: "pane-title" }, "Module Explorer",
    h("button", { type: "button", title: "Close", onclick: toggleOutline }, "x")),
  ...(tree.length ? tree : [h("p", {}, "No headings to show.")]),
  ...(count >= OUTLINE_MAX ? [h("p", {}, `Only the first ${OUTLINE_MAX} entries are listed.`)] : []));
  pane.scrollTop = scroll;
}

function markOutline() {
  for (const node of $("outline").querySelectorAll(".node")) node.classList.toggle("picked", Number(node.dataset.absno) === S.selected);
}

function showInOutline() {
  const row = needObject();
  const rows = new Map(S.data.rows.map((r) => [r.absno, r]));
  for (let up = rows.get(row.parent); up; up = rows.get(up.parent)) S.outlineClosed.delete(up.absno);
  S.outline = true;
  document.body.classList.add("outline-open");
  render();
  let at = row, node = null;
  while (at && !(node = $("outline").querySelector(`.node[data-absno="${at.absno}"]`))) at = rows.get(at.parent);
  if (node) {
    node.classList.add("picked");
    node.scrollIntoView({ block: "nearest" });
  }
}

// ---------------------------------------------------------------- columns

// The view as a layout, so that one column of it can be changed.
function editableLayout() {
  const known = S.columns.filter((c) => attribute(c) || S.data.system_attributes.includes(c) || c === "Absolute Number");
  return (S.layout || plainColumns(known)).map((c) => ({ ...c }));
}

async function setLayout(layout, picked) {
  S.layout = layout;
  S.columns = layout.filter((c) => c.kind === "attribute").map((c) => c.attribute);
  S.column = picked ?? null;
  S.layoutCells = [];
  await computeLayoutCells();
  render();
}

const columnNames = () => [...S.data.attributes.filter((a) => a.scope === "object").map((a) => a.name), ...S.data.system_attributes];

function columnInsertDialog(after) {
  needModule();
  const names = columnNames();
  const at = after ?? S.column;
  formDialog("Insert column", [
    { name: "attribute", label: "Attribute", type: "select", options: names },
    { name: "title", label: "Title (optional)" },
  ], "Insert", async (v) => {
    const layout = editableLayout();
    const place = at === null || at === undefined ? layout.length : at + 1;
    layout.splice(place, 0, { kind: "attribute", title: v.title || v.attribute, width: 150, justify: "left", attribute: v.attribute });
    await setLayout(layout, place);
  });
}

function columnPropertiesDialog(index = S.column) {
  needModule();
  const layout = editableLayout();
  const column = layout[index];
  if (!column) throw new Error("Click a column heading first.");
  const specs = [
    { name: "title", label: "Title", value: column.title ?? "" },
    { name: "width", label: "Width (pixels)", value: String(column.width || "") },
    { name: "justify", label: "Alignment", type: "select", value: column.justify,
      options: [["left", "Left"], ["center", "Center"], ["right", "Right"], ["full", "Justify"]] },
    ...(column.kind === "attribute" ? [{ name: "attribute", label: "Attribute", type: "select", options: columnNames(), value: column.attribute }] : []),
    { name: "position", label: "Position", type: "select", value: String(index),
      options: layout.map((_, i) => [String(i), String(i + 1)]) },
  ];
  formDialog("Column properties", specs, "Apply", async (v) => {
    const width = v.width.trim() ? Number(v.width) : null;
    if (width !== null && !(Number.isInteger(width) && width >= 20 && width <= 2000)) throw new Error("Width: a whole number from 20 to 2000.");
    Object.assign(column, { title: v.title || null, width, justify: v.justify }, v.attribute ? { attribute: v.attribute } : {});
    layout.splice(index, 1);
    layout.splice(Number(v.position), 0, column);
    await setLayout(layout, Number(v.position));
  });
}

function removeColumn(index = S.column) {
  needModule();
  const layout = editableLayout();
  if (!layout[index]) throw new Error("Click a column heading first.");
  if (layout.length === 1) throw new Error("A view needs a column.");
  layout.splice(index, 1);
  return setLayout(layout, null);
}

async function justify(index, how) {
  const layout = editableLayout();
  layout[index].justify = how;
  await setLayout(layout, index);
}

// The menu of one column heading. `index` is null for a column that is not part
// of the view's layout (links, DXL column, suspect, redline).
function columnMenu(event, index, sortName) {
  event.preventDefault();
  S.column = index;
  for (const th of document.querySelectorAll("#main th")) th.classList.toggle("picked", th === event.currentTarget);
  const why = index === null ? "not a column of the view" : "";
  const sortWhy = sortName ? "" : "cannot sort on this column";
  const order = (descending) => () => { S.sort = sortName; S.sortDescending = descending; S.sortOn = true; render(); };
  showMenu([
    M("columnProperties", () => columnPropertiesDialog(index), why),
    M("columnInsert", () => columnInsertDialog(index), ""),
    M("columnRemove", () => removeColumn(index), why),
    null,
    M("sort", order(false), sortWhy, "", "Sort ascending"),
    M("sort", order(true), sortWhy, "", "Sort descending"),
    null,
    ...[["left", "Align left"], ["center", "Align center"], ["right", "Align right"], ["full", "Justify"]].map(([how, label]) =>
      M("columnProperties", () => justify(index, how), why, "", label)),
  ], event.clientX, event.clientY);
}

// ---------------------------------------------------------------- sorting and filtering

function sortDialog() {
  needModule();
  formDialog("Sort", [
    { name: "attribute", label: "Sort by", type: "select", value: S.sort || "",
      options: [["", "Document order"], ...sortableNames().map((n) => [n, n])] },
    { name: "order", label: "Order", type: "select", options: [["up", "Ascending"], ["down", "Descending"]],
      value: S.sortDescending ? "down" : "up" },
  ], "Sort", (v) => {
    S.sort = v.attribute || null;
    S.sortDescending = v.order === "down";
    S.sortOn = true;
    render();
  });
}

function matches(row, rule) {
  const have = cellText(row, rule.attribute).toLowerCase(), want = (rule.value || "").toLowerCase();
  switch (rule.op) {
    case "contains": return have.includes(want);
    case "!contains": return !have.includes(want);
    case "==": return have === want;
    case "!=": return have !== want;
    case "empty": return have === "";
    case "!empty": return have !== "";
    default: return true;
  }
}

function advancedPasses(row) {
  const f = S.advanced;
  if (!f) return true;
  return f.any ? f.rules.some((r) => matches(row, r)) : f.rules.every((r) => matches(row, r));
}

function advancedFilterDialog() {
  needModule();
  const start = S.advanced || { any: false, rules: [S.filter || { attribute: "Object Text", op: "contains", value: "" }] };
  const join = field({ type: "select", options: [["all", "all of these are true"], ["any", "any of these is true"]], value: start.any ? "any" : "all" });
  const holder = h("div", {});
  const rules = [];
  const add = (rule) => {
    const line = {
      attribute: field({ type: "select", options: sortableNames(), value: rule.attribute }),
      op: field({ type: "select", options: OPERATORS, value: rule.op }),
      value: field({ value: rule.value }),
    };
    const node = h("div", { class: "rule" }, line.attribute, line.op, line.value,
      h("button", { type: "button", onclick: () => { rules.splice(rules.indexOf(line), 1); node.remove(); } }, "Remove"));
    rules.push(line);
    holder.append(node);
  };
  start.rules.forEach(add);
  dialog("Advanced filter", h("div", {}, h("p", {}, "Show objects where ", join), holder,
    h("p", {}, h("button", { type: "button", onclick: () => add({ attribute: "Object Text", op: "contains", value: "" }) }, "Add condition")),
    h("p", { class: "hint" }, "Applies together with the simple filter. Not saved with views.")), [
    { label: "Apply", primary: true, action: () => {
      const chosen = rules.map((l) => ({ attribute: l.attribute.value, op: l.op.value, value: l.value.value }));
      S.advanced = chosen.length ? { any: join.value === "any", rules: chosen } : null;
      if (S.filter) S.filter = null;
      S.filterOn = true;
      render();
    } },
    { label: "Remove filter", action: () => { S.advanced = null; render(); } },
    { label: "Cancel" },
  ]);
}

// ---------------------------------------------------------------- change bars and redline

// What differs from a baseline, by object: absno -> changes.
async function changesFrom(baseline) {
  const out = new Map();
  for (const c of await api("compare", { old: baseline, new: S.moduleId })) {
    if (!out.has(c.absno)) out.set(c.absno, []);
    out.get(c.absno).push(c);
  }
  return out;
}

async function loadChanges() {
  S.changes = new Map();
  S.redlineCells = new Map();
  if (!current() || !S.data.baselines.length) {
    S.redline = null;
    return;
  }
  const latest = S.data.baselines.at(-1);
  if (S.changeBars) {
    const quiet = new Set(S.data.attributes.filter((a) => a.bars === false).map((a) => a.name));
    S.changes = await changesFrom(latest.id);
    for (const [absno, list] of S.changes) {
      if (list.every((c) => c.change === "modified" && quiet.has(c.attribute))) S.changes.delete(absno);
    }
  }
  if (S.redline && !S.data.baselines.some((b) => b.id === S.redline.id)) S.redline = null;
  if (S.redline) S.redlineCells = await changesFrom(S.redline.id);
}

async function toggleChangeBars() {
  S.changeBars = !S.changeBars;
  await loadChanges();
  render();
}

function changeTitle(row) {
  return S.changes.has(row.absno) ? `Changed since baseline ${S.data.baselines.at(-1).label}` : "";
}

function redlineDialog() {
  needModule();
  formDialog("Redline column", [{ name: "baseline", label: "Compare with", type: "select",
    value: String(S.redline?.id ?? S.data.baselines.at(-1).id),
    options: [["", "(no redline column)"], ...S.data.baselines.map((b) => [b.id, `Baseline ${b.label}`])] }], "Apply", async (v) => {
    const baseline = S.data.baselines.find((b) => String(b.id) === v.baseline);
    S.redline = baseline ? { id: baseline.id, label: baseline.label } : null;
    await loadChanges();
    render();
  });
}

// Columns after the view's own and the link columns.
function redlineColumns() {
  if (!S.redline) return [];
  return [{ title: `Redline from ${S.redline.label}`, cell: (row) => (S.redlineCells.get(row.absno) || []).map((c) => {
    if (c.change === "added") return h("div", { class: "entry" }, h("ins", {}, "added"));
    if (c.change === "deleted") return h("div", { class: "entry" }, h("del", {}, "deleted"));
    return h("div", { class: "entry" }, h("b", {}, c.attribute + ": "), redline(c.old, c.new));
  }) }];
}

const extraColumns = () => [...TRACE.columns(), ...redlineColumns()];

// ---------------------------------------------------------------- links

const linkToStart = () => act(async () => {
  if (!S.linkStart) throw new Error("First choose Start link.");
  allOrCurrent("Make link to start", (rows) => linkWithStart(rows, false));
});

function clearLinkStart() {
  S.linkStart = null;
  render();
  say("Link start cleared.");
}

// The out-links of the current object, or of every selected object.
function deleteAllLinks() {
  needObject(true);
  const module = S.moduleId, rows = chosenRows().filter((r) => r.out.length);
  const count = rows.reduce((n, r) => n + r.out.length, 0);
  if (!count) throw new Error("There are no out-links here.");
  const what = rows.length === 1 ? rows[0].id : `${rows.length} objects`;
  confirmDialog("Delete links", `Delete all ${count} out-link(s) of ${what}${unseen(rows)}? This cannot be undone.`, "Delete", async () => {
    await api("delete_out_links", { module, absnos: rows.map((r) => r.absno) });
    await refresh();
  });
}

function dropLink(link, direction) {
  const source = { module: link.source.module, absno: link.source.absno };
  confirmDialog("Delete link", `Delete the link ${direction === "out" ? "to" : "from"} ${link.other.id}?`, "Delete", async () => {
    await api("delete_link", { source, link: link.id });
    await refresh();
  });
}

// Follow each of a row's links, one direction or both.
function linkedEntries(row, only) {
  if (!row) return [M("showLinked", () => {}, "select an object first")];
  const lists = [["out", row.out, "▶"], ["in", row.in, "◀"]].filter(([d]) => !only || d === only);
  const entries = lists.flatMap(([, list, arrow]) => list.map((link) => M("showLinked",
    () => goTo(link.other.module, link.other.absno), "", "",
    `${arrow} ${link.other.id} in ${link.other.module_path}: ${link.other.text.slice(0, 40)}`)));
  return entries.length ? entries : [M("showLinked", () => {}, "the object has no links")];
}

function arrowMenu(event, row, direction) {
  event.preventDefault();
  event.stopPropagation();
  select(row.absno);
  const list = direction === "out" ? row.out : row.in;
  showMenu([
    ...linkedEntries(row, direction),
    null,
    SUB("Delete link", list.map((link) => M("linkMenu", () => dropLink(link, direction), writable() ? "" : "the module is read only",
      "", `Delete link ${direction === "out" ? "to" : "from"} ${link.other.id}`))),
  ], event.clientX, event.clientY);
}

function showIndicators(incoming, outgoing) {
  T.suspectColumn = { kind: "indicators", in: incoming, out: outgoing };
  return TRACE.load().then(() => render());
}

function linkByAttributeDialog() {
  const m = needModule();
  const strings = S.data.attributes.filter((a) => a.scope === "object" && (a.base === "String" || a.base === "Text")).map((a) => a.name);
  const direction = field({ type: "select", options: [["out", "From this module to the target"],
    ["in", "From the target to this module"], ["both", "Both directions"]] });
  const others = formalModules().filter((n) => n.id !== m.id);
  if (!others.length) throw new Error("There is no other formal module to link to.");
  const attributeName = field({ type: "select", options: strings });
  const target = field({ type: "select", options: others.map((n) => [n.id, `${n.path} (${n.prefix || "no prefix"})`]) });
  const links = [...S.items.values()].filter((n) => n.kind === "link" && !n.deleted).map((n) => n.path);
  const linkModule = field({ type: "select", options: [["", "(default)"], ...links] });
  const result = h("div", { "aria-live": "polite" });
  const run = async (preview) => {
    const reply = await api("link_by_attribute", { module: m.id, attribute: attributeName.value,
      target_module: Number(target.value), link_module: linkModule.value, direction: direction.value, preview });
    const lines = [`${preview ? "Would make" : "Made"} ${reply.made} link(s); ${reply.existing} already there.`];
    if (reply.refused.length) lines.push(`Refused: ${reply.refused.slice(0, 5).join("; ")}`);
    if (reply.missing.length) lines.push(`Not found in the target module: ${reply.missing.slice(0, 30).join(", ")}${reply.missing.length > 30 ? " ..." : ""}`);
    result.replaceChildren(...lines.map((l) => h("p", {}, l)));
    if (!preview) {
      await loadTree();
      await refresh();
    }
    return false;
  };
  dialog("Link by attribute", h("div", {},
    h("p", {}, "Each object of this module is linked with the target objects its attribute lists: "
      + "absolute numbers, one per line (or the target's identifiers)."),
    h("div", { class: "form" }, h("label", {}, "Attribute holding the numbers"), attributeName,
      h("label", {}, "Target module"), target, h("label", {}, "Link module"), linkModule,
      h("label", {}, "Link direction"), direction), result), [
    { label: "Preview", primary: true, action: () => run(true) },
    { label: "Make links", action: () => run(false) },
    { label: "Close" },
  ]);
}

// ---------------------------------------------------------------- copying modules, baseline sets

function copyModuleDialog(node) {
  formDialog("Copy module " + node.path, [
    { name: "name", label: "Name of the copy", value: node.name + " copy" },
    { name: "description", label: "Description", value: node.description },
  ], "Copy", async (v) => {
    const made = await api("copy_module", { module: node.id, ...v });
    await loadTree();
    await pickItem(made.id);
    say(`Copied ${node.path}: its objects, views and out-links; not its in-links or baselines.`);
  });
}

const tickList = (items, chosen) => {
  const boxes = items.map(([value]) => h("input", { type: "checkbox", value: String(value), checked: chosen.includes(value) }));
  return [h("div", { class: "checks" }, items.map(([, label], i) => h("label", {}, boxes[i], " " + label))),
    () => boxes.filter((b) => b.checked).map((b) => Number(b.value))];
};

// A definition names modules at or below the folder or project holding it.
function setDefinitionDialog(definition, done) {
  const places = [...S.items.values()].filter((n) => (n.kind === "folder" || n.kind === "project") && !n.deleted && n.id !== 1);
  if (!places.length) throw new Error("There is no folder or project to hold a definition.");
  const near = containerForNew().id;
  const folder = field({ type: "select", options: places.map((n) => [n.id, n.path]),
    value: String(definition ? definition.folder : places.some((n) => n.id === near) ? near : places[0].id) });
  folder.disabled = !!definition;
  const name = field({ value: definition?.name }), description = field({ value: definition?.description });
  const holder = h("div", {});
  let read = () => [];
  const draw = () => {
    const path = places.find((n) => n.id === Number(folder.value)).path;
    const below = formalModules().filter((n) => n.path.startsWith(path.replace(/\/$/, "") + "/"));
    let list;
    [list, read] = tickList(below.map((n) => [n.id, n.path]), definition ? definition.modules.map((m) => m.id) : below.map((n) => n.id));
    holder.replaceChildren(list);
  };
  folder.addEventListener("change", draw);
  draw();
  dialog(definition ? "Edit baseline set definition" : "New baseline set definition", h("div", {},
    h("div", { class: "form" }, h("label", {}, "Held by"), folder, h("label", {}, "Name"), name,
      h("label", {}, "Description"), description), h("p", {}, "Modules:"), holder), [
    { label: "OK", primary: true, action: async () => {
      await api(definition ? "update_set_definition" : "create_set_definition", { folder: Number(folder.value),
        id: definition?.id, name: name.value, description: description.value, modules: read() });
      await done();
    } },
    { label: "Cancel" },
  ]);
}

function baselineSetsDialog() {
  const holder = h("div", {});
  let box = null;
  const draw = async () => {
    const { definitions } = await api("baseline_sets");
    holder.replaceChildren(...(definitions.length ? definitions.map(card) : [h("p", {}, "There are no baseline set definitions yet.")]));
  };
  const redraw = async () => { await draw(); await refresh(); };
  const button = (label, work) => h("button", { type: "button", onclick: () => act(async () => work()) }, label);
  const card = (d) => {
    const at = { folder: d.folder, id: d.id };
    const addModules = (set) => {
      const left = d.modules.filter((m) => !set.members.some((x) => x.module === m.id));
      if (!left.length) throw new Error("Every module of the definition is in this set.");
      const [list, read] = tickList(left.map((m) => [m.id, m.path]), left.map((m) => m.id));
      dialog(`Baseline into ${d.name} ${set.label}`, list, [
        { label: "Baseline them", primary: true, action: async () => {
          await api("add_to_baseline_set", { ...at, index: set.index, modules: read() });
          await redraw();
        } },
        { label: "Cancel" },
      ]);
    };
    const rows = d.sets.map((set) => h("tr", {},
      h("td", {}, set.label, set.annotation ? h("div", { class: "hint" }, set.annotation) : null),
      h("td", {}, set.open ? "open" : "closed"), h("td", {}, `${set.user}, ${set.date}`),
      h("td", {}, set.members.map((m) => h("div", {}, button(`${m.path} ${m.label}`, async () => {
        box.close();
        S.picked = m.module;
        await openModule(m.copy);
        renderTree();
      })))),
      h("td", {}, set.open ? [button("Add modules...", () => addModules(set)), " ", button("Close set", () =>
        confirmDialog("Close baseline set", `Close ${d.name} ${set.label}? Nothing more can be added to it.`, "Close set", async () => {
          await api("close_baseline_set", { ...at, index: set.index });
          await redraw();
        }))] : null)));
    return h("section", {}, h("h4", {}, `${d.name} (held by ${d.folder_path})`),
      d.description ? h("p", {}, d.description) : null,
      h("p", {}, "Modules: " + (d.modules.map((m) => m.path).join(", ") || "none")),
      h("p", {}, button("Edit...", () => setDefinitionDialog(d, draw)), " ",
        button("New baseline set...", () => formDialog("New baseline set of " + d.name, [
          { name: "major", label: "Major version", type: "checkbox" }, { name: "suffix", label: "Suffix (optional)" },
          { name: "annotation", label: "Annotation", type: "textarea" }], "Create", async (v) => {
          await api("create_baseline_set", { ...at, ...v });
          await redraw();
        })), " ",
        button("Delete definition", () => confirmDialog("Delete definition", `Delete ${d.name}?`, "Delete", async () => {
          await api("delete_set_definition", at);
          await draw();
        }))),
      rows.length ? listTable(["Set", "State", "Made", "Baselines (open read-only)", ""], rows) : h("p", {}, "No baseline sets yet."));
  };
  box = dialog("Baseline sets", h("div", {}, h("p", {}, button("New definition...", () => setDefinitionDialog(null, draw))), holder));
  wideBox(box);
  draw().catch((e) => { box.problem.textContent = e.message; });
}

// ---------------------------------------------------------------- the link module window

async function showLinkModule(node) {
  const data = await api("link_module", { module: node.id });
  if (S.data || S.picked !== node.id) return;
  const pair = (l) => `${l.source.path} → ${l.target.path}`;
  const pairs = [...new Set([...data.links.map(pair), ...data.linksets.map(pair)])].sort();
  const choose = h("select", { "aria-label": "Linkset" }, [h("option", { value: "" }, `All linksets (${pairs.length})`),
    pairs.map((p) => h("option", { value: p }, p))]);
  const holder = h("div", {});
  const open = (end) => h("a", { class: "go", title: end.path, onclick: () => act(() => goTo(end.module, end.absno)) }, end.id);
  const draw = () => {
    const rows = data.links.filter((l) => !choose.value || pair(l) === choose.value);
    $("counts").textContent = `${rows.length} link(s)`;
    holder.replaceChildren(rows.length ? longTable(["Source", "Source text", "Target", "Target text", "Suspect", ""], rows, (l) =>
      h("tr", {}, h("td", {}, open(l.source)), h("td", {}, l.source.text.slice(0, 120)), h("td", {}, open(l.target)),
        h("td", {}, l.target.text.slice(0, 120)),
        h("td", {}, [l.source_changed ? "source changed" : "", l.target_changed ? "target changed" : ""].filter(Boolean).join(", ")),
        h("td", {}, h("button", { type: "button", onclick: () => confirmDialog("Delete link",
          `Delete the link from ${l.source.id} to ${l.target.id}?`, "Delete", async () => {
            await api("delete_link", { source: { module: l.source.module, absno: l.source.absno }, link: l.id });
            await showLinkModule(node);
          }) }, "Delete link"))))
      : h("p", {}, "No links are held here."));
  };
  choose.addEventListener("change", draw);
  const removeSet = (set) => confirmDialog("Delete linkset", `Delete the linkset ${pair(set)} and every link in it?`, "Delete",
    async () => {
      await api("delete_linkset", { module: node.id, source: set.source.id, target: set.target.id });
      await showLinkModule(node);
    });
  const newSet = () => {
    const options = formalModules().map((n) => [n.id, n.path]);
    if (!options.length) throw new Error("There is no formal module.");
    formDialog("New linkset", [{ name: "source", label: "Source module", type: "select", options },
      { name: "target", label: "Target module", type: "select", options }], "Create", async (v) => {
      await api("create_linkset", { module: node.id, source: Number(v.source), target: Number(v.target) });
      await showLinkModule(node);
    });
  };
  $("main").replaceChildren(h("div", { class: "linkwindow" }, h("h3", {}, node.path), h("p", {}, "Linkset ", choose, " ",
    h("button", { type: "button", onclick: () => act(newSet) }, "New linkset..."), " ",
    h("button", { type: "button", onclick: () => act(() => {
      const set = data.linksets.find((s) => pair(s) === choose.value);
      if (!set) throw new Error("Choose a linkset in the list first.");
      removeSet(set);
    }) }, "Delete linkset...")), holder));
  draw();
}

// ---------------------------------------------------------------- DXL coverage

async function coveragePage() {
  const names = await api("dxl_coverage");
  const offered = names.filter((n) => n.offered).length;
  const search = h("input", { type: "search", placeholder: "Search a name...", "aria-label": "Search DXL names" });
  const which = h("select", { "aria-label": "Show" }, [["", "Everything"], ["offered", "Offered"], ["not built", "Not built"],
    ["cannot", "Cannot be done here"]].map(([value, label]) => h("option", { value }, label)));
  const holder = h("div", {});
  const group = (n) => (n.offered ? "offered" : n.reason.startsWith("cannot") ? "cannot" : "not built");
  const draw = () => {
    const want = search.value.trim().toLowerCase();
    const rows = names.filter((n) => (!which.value || group(n) === which.value) && (!want || n.name.toLowerCase().includes(want)));
    const areas = new Map();
    for (const n of rows) {
      if (!areas.has(n.area)) areas.set(n.area, []);
      areas.get(n.area).push(n);
    }
    const open = !!(want || which.value) && rows.length <= 200;
    holder.replaceChildren(...[...areas].map(([area, list]) => {
      const total = names.filter((n) => n.area === area);
      const table = () => h("table", { class: "list coverage" }, h("tbody", {}, list.map((n) =>
        h("tr", { class: n.offered ? "cov-full" : "cov-no" }, h("td", { class: "cov-name" }, n.name),
          h("td", { class: "cov-status" }, n.kind), h("td", {}, n.offered ? "offered" : n.reason)))));
      // rows are made when an area is opened: there are well over a thousand names
      const body = h("div", {}, open ? table() : null);
      return h("details", { open, ontoggle: (e) => { if (e.target.open && !body.firstChild) body.append(table()); } },
        h("summary", {}, `${area}: ${total.filter((n) => n.offered).length} of ${total.length} offered`), body);
    }), ...(rows.length ? [] : [h("p", {}, "No name matches.")]));
  };
  search.addEventListener("input", draw);
  which.addEventListener("change", draw);
  draw();
  const count = (g) => names.filter((n) => group(n) === g).length;
  wideBox(dialog("DXL coverage", h("div", {},
    h("p", {}, `${offered} of ${names.length} names offered; ${count("not built")} not built; ${count("cannot")} cannot be done here.`),
    h("p", { class: "hint" }, "\"Offered\" means at least one form of the name works, not every form. The names are those found in "
      + "IBM's DXL Reference Manual 9.2, and the list may not be complete. A script that works here still needs running in DOORS."),
    h("div", { class: "cov-controls" }, search, " ", which), holder)));
}

// ---------------------------------------------------------------- keys

document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowUp" && !e.target.closest("input, textarea, select, dialog, .richbox")) {
    e.preventDefault();
    act(upLevel);
    return;
  }
  if (e.target.closest("input, textarea, select, dialog, #dxl, .dxlbox, .richbox") || !S.data) return;
  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase();
    // a text selection on the page is still copied as text
    const keys = {
      f: e.shiftKey ? (S.linkStart ? finishLink : null) : () => openFind(false),
      m: e.shiftKey && S.linkStart ? linkToStart : null,
      g: () => findStep(e.shiftKey ? -1 : 1), z: undo,
      c: String(getSelection()) ? null : () => clipTake(false),
      x: String(getSelection()) || !writable() ? null : () => clipTake(true),
      v: S.clip && writable() ? () => paste("after") : null,
    };
    if (keys[key]) {
      e.preventDefault();
      act(async () => keys[key]());
    }
    return;
  }
  if (e.altKey || e.target.closest("button")) return;
  const rows = visibleRows(), row = selectedRow();
  const go = {
    Home: () => rows[0], End: () => rows.at(-1),
    ArrowLeft: () => row && rows.find((r) => r.absno === row.parent),
    ArrowRight: () => row && rows.find((r) => r.parent === row.absno),
  }[e.key];
  if (go) {
    const to = go();
    if (to) {
      e.preventDefault();
      select(to.absno);
      scrollToSelected();
    }
  }
});
