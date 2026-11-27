"use strict";
// Traceability tools: the analysis wizard, link and column filters, suspect
// links, the link overview and matrix, and export of the view. Loaded after
// app.js, whose helpers it uses and whose TRACE hooks it fills in. As there,
// database text only ever becomes text, never markup.

const T = {
  linkFilter: null,     // { have, direction: "in"|"out"|"either", linkModule, module, skipHeadings }
  columnFilter: null,   // { title, op, value }: on the text of a traceability or DXL column
  suspectFilter: null,  // { in, out }; not saved in views
  suspectColumn: null,  // { kind: "indicators"|"last"|"all", in, out }; not saved in views
  suspects: new Map(),  // absno -> { in: [...], out: [...] } for that column
};

const isHeadingOnly = (row) => !!row.values["Object Heading"] && !row.values["Object Text"];

// The text columns made by DXL: those of the view, and the one from View, DXL column.
function computedColumns() {
  const columns = [];
  (S.layout || []).forEach((c, i) => {
    if (c.kind === "dxl") columns.push({ title: c.title ?? "DXL", index: i, text: (row) => (S.layoutCells[i] || {})[row.absno] || "" });
  });
  if (S.dxlColumn) columns.push({ title: S.dxlColumn.title, index: null, text: (row) => S.dxlColumn.cells[row.absno] || "" });
  return columns;
}

function linkFilterPasses(row, f) {
  if (row.deleted) return false;
  if (f.skipHeadings && isHeadingOnly(row)) return false;
  const lists = f.direction === "in" ? row.in : f.direction === "out" ? row.out : [...row.in, ...row.out];
  const found = lists.some((l) => (!f.linkModule || l.link_module_path === f.linkModule)
    && (!f.module || l.other.module_path === f.module));
  return found === f.have;
}

function columnFilterPasses(row, f) {
  const column = computedColumns().find((c) => c.title === f.title);
  if (!column) return true;
  const have = column.text(row).toLowerCase(), want = (f.value || "").toLowerCase();
  if (f.op === "empty") return have === "";
  if (f.op === "!empty") return have !== "";
  if (f.op === "!contains") return !have.includes(want);
  return have.includes(want);
}

Object.assign(TRACE, {
  passes(row) {
    if (T.linkFilter && !linkFilterPasses(row, T.linkFilter)) return false;
    if (T.columnFilter && !columnFilterPasses(row, T.columnFilter)) return false;
    const s = T.suspectFilter;
    if (s && !((s.in && row.in.some((l) => isSuspect(l, "in"))) || (s.out && row.out.some((l) => isSuspect(l, "out"))))) return false;
    return true;
  },
  filtering: () => !!(T.linkFilter || T.columnFilter || T.suspectFilter),
  clear() { T.linkFilter = T.columnFilter = T.suspectFilter = null; },
  reset() {
    TRACE.clear();
    T.suspectColumn = null;
    T.suspects = new Map();
  },
  apply(definition) {
    T.linkFilter = definition.link_filter || null;
    T.columnFilter = definition.column_filter || null;
    T.suspectFilter = null;
  },
  definition: () => ({ link_filter: T.linkFilter, column_filter: T.columnFilter }),
  status() {
    const parts = [];
    if (T.linkFilter) {
      const f = T.linkFilter;
      const leaf = (path) => path.split("/").pop();
      parts.push(`link filter: ${f.have ? "has" : "no"} ${f.direction === "either" ? "" : f.direction + "-"}links`
        + (f.linkModule ? ` through ${leaf(f.linkModule)}` : "")
        + (f.module ? ` ${{ out: "to", in: "from", either: "with" }[f.direction]} ${leaf(f.module)}` : "")
        + (f.skipHeadings ? ", headings left out" : ""));
    }
    if (T.columnFilter) parts.push("column filter on");
    if (T.suspectFilter) parts.push("suspect link filter on");
    return parts;
  },
  columns() {
    const c = T.suspectColumn;
    if (!c) return [];
    const title = { indicators: "Suspect", last: "Last suspect change", all: "All suspect changes" }[c.kind];
    return [{ title, cell: (row) => suspectCell(row, c) }];
  },
  async load() {
    T.suspects = new Map();
    if (!T.suspectColumn || T.suspectColumn.kind === "indicators" || !writable()) return;
    const reply = await api("trace_suspects", { module: S.moduleId });
    T.suspects = new Map(reply.objects.map((o) => [o.absno, o]));
  },
});

function modalOf(box) {
  return box.problem.closest("dialog");
}

function wideDialog(title, content, buttons) {
  const box = dialog(title, content, buttons);
  modalOf(box).classList.add("trace-wide");
  return box;
}

// Run something from inside a dialog, showing a failure in that dialog.
function within(box, work) {
  return async () => {
    try {
      box().problem.textContent = "";
      await work();
    } catch (e) {
      box().problem.textContent = e.message;
    }
  };
}

const choice = (type, label, options) => {
  const input = h("input", { type, ...options });
  return [input, h("label", { class: "choice" + (input.disabled ? " greyed" : "") }, input, " " + label)];
};

// A choice DOORS has and this does not, with the reason.
const greyed = (type, label, why) => choice(type, `${label} (not available: ${why})`, { disabled: true })[1];

// ---------------------------------------------------------------- the analysis wizard

const SYSTEM_CHOICES = ["Object Heading", "Object Text", "Object Short Text", "Absolute Number", "Created By", "Created On",
  "Last Modified By", "Last Modified On"];

async function traceWizard() {
  const m = needModule();
  if (!writable()) throw new Error("Traceability columns work on the current version, not a baseline.");
  const info = await api("trace_info");
  const here = info.formalModules.find((x) => x.id === m.id);
  const w = {
    direction: "in", scope: "all", scopeModule: here.path, links: "all", linkModule: (info.linkModules[0] || {}).path || "",
    identifier: true, moduleName: "relative", attributes: new Set(["Object Heading"]), linkAttributes: new Set(),
    width: "240", perLine: true, showNames: false, trimDatum: false, trimDatumTo: "80", trimAll: false, trimAllTo: "500",
    recursive: false, multiple: true, depth: "2", selected: false, chain: [here.path],
    title: "", hideBuiltin: true, saveAs: "",
  };
  let step = 0, box = null;
  const body = h("div", { class: "wizard" });
  const heading = h("h4", {});

  const bind = (input, key, property = "value") => {
    if (property === "checked") input.checked = w[key];
    else input.value = w[key];
    input.addEventListener(property === "checked" || input.tagName === "SELECT" ? "change" : "input", () => { w[key] = input[property]; });
    return input;
  };
  const check = (key, label, extra) => {
    const [input, node] = choice("checkbox", label, extra);
    bind(input, key, "checked");
    return node;
  };
  const radio = (key, value, label) => {
    const [input, node] = choice("radio", label, { name: "wizard-" + key, checked: w[key] === value });
    input.addEventListener("change", () => { w[key] = value; draw(); });
    return node;
  };
  const member = (set, name, label) => {
    const [input, node] = choice("checkbox", label || name, { checked: set.has(name) });
    input.addEventListener("change", () => { if (input.checked) set.add(name); else set.delete(name); });
    return node;
  };
  const modulePick = (key) => bind(field({ type: "select", options: info.formalModules.map((x) => x.path) }), key);
  const number = (key, label) => bind(h("input", { type: "number", class: "short", min: 1, "aria-label": label }), key);

  const options = () => {
    const whole = (text, what) => {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a whole number, 1 or more.`);
      return n;
    };
    const chain = w.recursive && w.selected ? w.chain : [];
    const offered = new Set(attributeChoices().all);
    return {
      direction: w.direction,
      linkModule: w.links === "one" ? w.linkModule : "*",
      scope: w.scope === "one" ? w.scopeModule : null,
      identifier: w.identifier, moduleName: w.moduleName,
      attributes: [...w.attributes].filter((n) => offered.has(n)),
      linkAttributes: [...w.linkAttributes],
      width: whole(w.width, "Column width"),
      perLine: w.perLine, showNames: w.showNames,
      trimDatum: w.trimDatum ? whole(w.trimDatumTo, "Trim each datum to") : 0,
      trimAll: w.trimAll ? whole(w.trimAllTo, "Trim entire string to") : 0,
      depth: w.recursive && !chain.length ? whole(w.depth, "Depth of analysis") : 1,
      multipleColumns: w.recursive && w.multiple,
      chain, title: w.title,
    };
  };

  function attributeChoices() {
    const specific = w.scope === "one" && !(w.recursive && w.selected);
    const own = specific ? info.formalModules.find((x) => x.path === w.scopeModule).attributes : [];
    const first = [...new Set([...own, ...SYSTEM_CHOICES])];
    const more = specific ? [] : [...new Set(info.formalModules.flatMap((x) => x.attributes))].filter((n) => !first.includes(n));
    return { first, more, all: [...first, ...more] };
  }

  const steps = [
    ["Link direction and type", () => [
      h("fieldset", {}, h("legend", {}, "Link direction"), radio("direction", "in", "In-links"), radio("direction", "out", "Out-links")),
      h("fieldset", {}, h("legend", {}, "Link types"),
        choice("checkbox", "Rational DOORS links", { checked: true, disabled: true })[1],
        greyed("checkbox", "External links", "this database has no external links")),
    ]],
    ["Scope of analysis", () => [
      h("fieldset", {}, h("legend", {}, "Select formal module"),
        greyed("radio", "All open modules", "one module is open at a time here"),
        radio("scope", "all", "All modules"), radio("scope", "one", "Specific"),
        w.scope === "one" ? modulePick("scopeModule") : null),
      h("fieldset", {}, h("legend", {}, "Select link module"),
        radio("links", "all", "All modules"), radio("links", "one", "Specific"),
        w.links === "one" ? bind(field({ type: "select", options: info.linkModules.map((x) => x.path) }), "linkModule") : null),
    ]],
    ["Attributes", () => {
      const { first, more } = attributeChoices();
      const names = bind(field({ type: "select", options: [["relative", "path only if in another folder"],
        ["path", "including path"], ["name", "no path"], ["", "do not show"]] }), "moduleName");
      return [
        h("fieldset", {}, h("legend", {}, "Module and object attributes"),
          check("identifier", "Object identifier"), h("label", { class: "choice" }, "Module name: ", names),
          h("div", { class: "pick-list" }, first.map((n) => member(w.attributes, n))),
          more.length ? h("details", { open: more.some((n) => w.attributes.has(n)) },
            h("summary", {}, "Attributes of particular modules"),
            h("p", { class: "hint" }, "Shown for objects whose module has them. DOORS lists these only for a Specific module."),
            h("div", { class: "pick-list" }, more.map((n) => member(w.attributes, n)))) : null),
        h("fieldset", {}, h("legend", {}, "DOORS link attributes"),
          member(w.linkAttributes, "Created By"), member(w.linkAttributes, "Created On"),
          greyed("checkbox", "Last Modified By / On", "not known here once suspicion is cleared")),
        h("fieldset", {}, h("legend", {}, "External link attributes"), greyed("checkbox", "Description", "no external links")),
      ];
    }],
    ["Other information", () => [
      h("p", {}, "Column width (pixels) ", number("width", "Column width")),
      check("perLine", "One attribute per line"), check("showNames", "Show attribute names"),
      greyed("checkbox", "Include OLE objects in text", "there are no OLE objects here"),
      h("p", {}, check("trimDatum", "Trim each datum to"), number("trimDatumTo", "Characters per datum"), " characters"),
      h("p", {}, check("trimAll", "Trim entire string to"), number("trimAllTo", "Characters per cell"), " characters"),
    ]],
    ["Recursion", () => {
      const toggle = (key, label, off) => {
        const [input, node] = choice("checkbox", label, { checked: w[key], disabled: !!off });
        input.addEventListener("change", () => { w[key] = input.checked; draw(); });
        return node;
      };
      const chained = w.recursive && w.selected;
      return [
        toggle("recursive", "Recursive analysis (more than one level)"),
        w.recursive ? [
          toggle("selected", "Display information only from selected modules"),
          chained ? chainRows() : [
            toggle("multiple", "Multiple columns (one for each level)"),
            h("p", {}, "Depth of analysis (up to 10) ", number("depth", "Depth of analysis")),
          ],
        ] : null,
        h("hr"),
        h("div", { class: "form" },
          h("label", {}, "Column title"), bind(h("input", { type: "text", placeholder: "from the choices" }), "title"),
          h("label", {}, "Save as view"), bind(h("input", { type: "text", placeholder: "name (optional)" }), "saveAs")),
        check("hideBuiltin", "Hide the built-in Out-links and In-links columns"),
        h("p", {}, h("button", { type: "button", onclick: within(() => box, async () => {
          showDxl(await api("trace_columns", options()));
        }) }, "Show the DXL...")),
      ];
    }],
  ];

  // Column 1 holds objects of the first module linked to this one, column 2 those linked to column 1, and so on.
  function chainRows() {
    return h("fieldset", {}, h("legend", {}, "The chain of modules, one column each"),
      w.chain.map((path, i) => {
        const pick = field({ type: "select", options: info.formalModules.map((x) => x.path), value: path });
        pick.setAttribute("aria-label", `Module for column ${i + 1}`);
        pick.addEventListener("change", () => { w.chain[i] = pick.value; });
        return h("p", {}, `Column ${i + 1} `, pick);
      }),
      w.chain.length < 10 ? h("button", { type: "button", onclick: () => { w.chain.push(w.chain.at(-1)); draw(); } }, "Add a column") : null,
      w.chain.length > 1 ? h("button", { type: "button", onclick: () => { w.chain.pop(); draw(); } }, "Remove the last column") : null);
  }

  let back = null, next = null;
  function draw() {
    const [title, content] = steps[step];
    heading.textContent = `Step ${step + 1} of ${steps.length}: ${title}`;
    const scroll = body.parentNode ? body.parentNode.scrollTop : 0;
    body.replaceChildren(...content().flat(Infinity).filter(Boolean));
    if (body.parentNode) body.parentNode.scrollTop = scroll;
    if (back) {
      back.disabled = step === 0;
      next.textContent = step === steps.length - 1 ? "Finish" : "Next >";
    }
  }

  box = dialog("Traceability analysis wizard", h("div", {}, heading, body), [
    { label: "< Back", action: () => { step = Math.max(0, step - 1); draw(); return false; } },
    { label: "Next >", primary: true, action: async () => {
      if (step < steps.length - 1) {
        step++;
        draw();
        return false;
      }
      await finishWizard(m, options(), w);
      return true;
    } },
    { label: "Cancel" },
  ]);
  [back, next] = modalOf(box).querySelectorAll(".buttons button");
  draw();
}

async function finishWizard(m, options, w) {
  const made = await api("trace_columns", options);
  const base = S.layout ? [...S.layout] : plainColumns(S.columns.filter((n) => attribute(n) || S.data.system_attributes.includes(n) || n === "Absolute Number"));
  // titles tell columns apart, for filtering on them
  const taken = new Set(base.map((c) => c.title));
  if (!w.hideBuiltin && S.inLinks) taken.add("In-links");
  if (!w.hideBuiltin && S.outLinks) taken.add("Out-links");
  for (const column of made) {
    let title = column.title;
    for (let n = 2; taken.has(title); n++) title = `${column.title} (${n})`;
    taken.add(title);
    base.push({ ...column, title });
  }
  S.layout = base;
  if (w.hideBuiltin) S.inLinks = S.outLinks = false;
  say("");
  await computeLayoutCells();
  const name = w.saveAs.trim();
  if (name) {
    await api("save_view", { module: m.id, name, definition: { layout: S.layout, filter: S.filter, sort: S.sort,
      in_links: S.inLinks, out_links: S.outLinks, ...TRACE.definition() } });
    S.view = name;
    await refresh();
  } else {
    render();
  }
  if (!$("message").classList.contains("error")) {
    say(`Added ${made.length} traceability column${made.length === 1 ? "" : "s"}. `
      + (name ? `Saved as view "${name}".` : "To keep it, use View, Save view."));
  }
}

function showDxl(columns) {
  const boxes = columns.map((c) => h("div", {},
    h("h4", {}, c.title),
    h("textarea", { class: "layout", readOnly: true, wrap: "off", spellcheck: false, "aria-label": "Layout DXL of " + c.title, value: c.dxl }),
    h("p", {}, h("button", { type: "button", onclick: () => download(`${c.title.replace(/[^\w .()-]+/g, "_")}.dxl`, c.dxl, "text/plain") },
      "Download .dxl"))));
  wideDialog("Layout DXL", h("div", {},
    h("p", { class: "hint" }, "Each column runs once for every object. This code has been run only in this practice tool, not in DOORS."),
    boxes));
}

function traceColumnsDialog() {
  needModule();
  const holder = h("div", {});
  let box = null;
  const draw = () => {
    const rows = (S.layout || []).map((c, i) => [c, i]).filter(([c]) => c.kind === "dxl").map(([c, i]) =>
      h("tr", {}, h("td", {}, c.title ?? "DXL"),
        h("td", {}, h("button", { type: "button", onclick: () => showDxl([{ ...c, title: c.title ?? "DXL" }]) }, "Show DXL"), " ",
          h("button", { type: "button", onclick: within(() => box, async () => {
            S.layout = S.layout.filter((_, at) => at !== i);
            if (T.columnFilter?.title === c.title) T.columnFilter = null;
            await computeLayoutCells();
            render();
            draw();
          }) }, "Remove"))));
    holder.replaceChildren(rows.length ? listTable(["Column", ""], rows) : h("p", {}, "This view has no traceability or DXL column."));
  };
  draw();
  box = dialog("Traceability columns", h("div", {}, holder,
    h("p", { class: "hint" }, "Removing a column changes what is on screen. Save the view to keep the change.")));
}

// ---------------------------------------------------------------- filters on links and columns

async function linkFilterDialog() {
  needModule();
  const info = await api("trace_info");
  const f = T.linkFilter || { have: false, direction: "in", linkModule: "", module: "", skipHeadings: false };
  const [useLinks, useLinksLabel] = choice("checkbox", "Filter on links", { checked: !!T.linkFilter || !T.columnFilter });
  const have = field({ type: "select", options: [["yes", "have"], ["no", "do not have"]], value: f.have ? "yes" : "no" });
  const direction = field({ type: "select", options: [["in", "in-links"], ["out", "out-links"], ["either", "in-links or out-links"]], value: f.direction });
  const linkModule = field({ type: "select", options: [["", "any link module"], ...info.linkModules.map((x) => [x.path, x.path])], value: f.linkModule });
  const module = field({ type: "select", options: [["", "any module"], ...info.formalModules.map((x) => [x.path, x.path])], value: f.module });
  const skip = field({ type: "checkbox", value: f.skipHeadings });

  const columns = computedColumns().map((c) => c.title);
  const c = T.columnFilter || { title: "", op: "empty", value: "" };
  const column = field({ type: "select", options: [["", columns.length ? "(none)" : "(this view has no DXL column)"], ...columns], value: c.title });
  const op = field({ type: "select", options: [["contains", "contains"], ["!contains", "does not contain"], ["empty", "is empty"], ["!empty", "is not empty"]], value: c.op });
  const value = field({ value: c.value });
  column.disabled = !columns.length;
  for (const input of [have, direction, linkModule, module, skip]) input.addEventListener("change", () => { useLinks.checked = true; });

  dialog("Filter on links and columns", h("div", {},
    h("fieldset", {}, h("legend", {}, "Links"), useLinksLabel, h("div", { class: "form" },
      h("label", {}, "Show objects that"), have, h("label", {}, "Links"), direction,
      h("label", {}, "Going through"), linkModule, h("label", {}, "To or from"), module,
      h("label", {}, "Leave out headings"), skip)),
    h("fieldset", {}, h("legend", {}, "Column contents"), h("div", { class: "form" },
      h("label", {}, "Column"), column, h("label", {}, "Condition"), op, h("label", {}, "Value"), value)),
    h("p", { class: "hint" }, "Combines with the other filters. Saved with the view. \"To or from\" and \"Leave out headings\" are additions of this tool.")), [
    { label: "Apply", primary: true, action: () => {
      T.linkFilter = useLinks.checked ? { have: have.value === "yes", direction: direction.value,
        linkModule: linkModule.value, module: module.value, skipHeadings: skip.checked } : null;
      T.columnFilter = column.value ? { title: column.value, op: op.value, value: value.value } : null;
      render();
    } },
    { label: "Remove these filters", action: () => { T.linkFilter = T.columnFilter = null; render(); } },
    { label: "Cancel" },
  ]);
}

// ---------------------------------------------------------------- suspect links

function suspectCell(row, c) {
  if (!writable()) return "(not shown on a baseline)";
  if (c.kind === "indicators") {
    const marks = [];
    if (c.in && row.in.some((l) => isSuspect(l, "in"))) marks.push(h("span", { class: "arrow in", title: "Suspect in-link" }, "◀? "));
    if (c.out && row.out.some((l) => isSuspect(l, "out"))) marks.push(h("span", { class: "arrow out", title: "Suspect out-link" }, "▶?"));
    return marks;
  }
  const held = T.suspects.get(row.absno);
  if (!held) return [];
  const entries = [...(c.in ? held.in.map((e) => ["in", e]) : []), ...(c.out ? held.out.map((e) => ["out", e]) : [])];
  return entries.map(([direction, e]) => {
    const lines = [`${direction === "in" ? "◀" : "▶"} ${e.other.path}`, e.other.id];
    if (c.kind === "last") {
      const last = e.changes.at(-1);
      lines.push(`modified ${last ? last.when : e.modified_on}`);
      if (e.never_cleared) lines.push("suspicion never cleared");
    } else {
      lines.push(`${e.changes.length} change${e.changes.length === 1 ? "" : "s"} since ${e.never_cleared ? "the link was made" : "last cleared"}`);
      for (const change of e.changes) lines.push(`  ${change.attribute || changeName(change)}: ${change.when}`);
    }
    return h("div", { class: "entry" }, lines.join("\n"));
  });
}

const changeName = (change) => ({ deleteObject: "object deleted", unDeleteObject: "object undeleted" }[change.action] || change.action);

// Which links a suspect filter or column looks at.
function suspectChooser(title, current, okLabel, apply, remove) {
  const [incoming, incomingLabel] = choice("checkbox", "In-links (all modules)", { checked: current ? current.in : true });
  const [outgoing, outgoingLabel] = choice("checkbox", "Out-links (all modules)", { checked: current ? current.out : true });
  dialog(title, h("div", { class: "checks" }, incomingLabel, outgoingLabel,
    greyed("checkbox", "Open modules only", "one module is open at a time here"),
    h("p", { class: "hint" }, "Not saved with views.")), [
    { label: okLabel, primary: true, action: async () => {
      if (!incoming.checked && !outgoing.checked) throw new Error("Choose in-links, out-links, or both.");
      await apply({ in: incoming.checked, out: outgoing.checked });
    } },
    current ? { label: "Remove", action: remove } : null,
    { label: "Cancel" },
  ].filter(Boolean));
}

function suspectFilterDialog() {
  needModule();
  suspectChooser("Filter on suspect links", T.suspectFilter, "Apply",
    (which) => { T.suspectFilter = which; render(); },
    () => { T.suspectFilter = null; render(); });
}

function suspectColumnDialog(kind, title) {
  needModule();
  if (!writable()) throw new Error("Suspect links are shown on the current version, not a baseline.");
  suspectChooser(title, T.suspectColumn?.kind === kind ? T.suspectColumn : null, "Show column",
    async (which) => {
      T.suspectColumn = { kind, ...which };
      await TRACE.load();
      render();
    },
    () => { T.suspectColumn = null; render(); });
}

// What was there struck out, what is new underlined, word by word.
function redline(before, after) {
  const a = before.split(/(\s+)/).filter(Boolean), b = after.split(/(\s+)/).filter(Boolean);
  if (a.length * b.length > 4000000) return h("div", { class: "redline" }, h("del", {}, before), " ", h("ins", {}, after));
  const width = b.length + 1;
  const same = new Uint32Array((a.length + 1) * width); // longest common run of words from here on
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      same[i * width + j] = a[i] === b[j] ? same[(i + 1) * width + j + 1] + 1
        : Math.max(same[(i + 1) * width + j], same[i * width + j + 1]);
    }
  }
  const parts = [];
  const add = (tag, word) => {
    if (parts.length && parts.at(-1)[0] === tag) parts.at(-1)[1] += word;
    else parts.push([tag, word]);
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { add("span", a[i]); i++; j++; }
    else if (i < a.length && (j === b.length || same[(i + 1) * width + j] >= same[i * width + j + 1])) add("del", a[i++]);
    else add("ins", b[j++]);
  }
  return h("div", { class: "redline" }, parts.map(([tag, text]) => h(tag, {}, text)));
}

// The changes behind one suspect link, oldest first (the first is what made it suspect).
function suspectDetails(here, entry) {
  let at = 0, box = null;
  const holder = h("div", {});
  const [marked, markedLabel] = choice("checkbox", "View change as redlining", { checked: false });
  const draw = () => {
    const change = entry.changes[at];
    holder.replaceChildren(...(change ? [
      h("p", {}, `Change ${at + 1} of ${entry.changes.length}: ${change.attribute || changeName(change)}`),
      h("p", {}, `${change.when} by ${change.who}`),
      !change.attribute ? null : marked.checked ? redline(change.old, change.new) : h("div", {},
        h("h4", {}, "Old value"), h("div", { class: "value" }, change.old || "(empty)"),
        h("h4", {}, "New value"), h("div", { class: "value" }, change.new || "(empty)")),
    ] : [h("p", {}, "The history here does not hold the change that made this link suspect.")]).filter(Boolean));
    if (box) {
      const [previous, next] = modalOf(box).querySelectorAll(".buttons button");
      previous.disabled = at === 0;
      next.disabled = at >= entry.changes.length - 1;
    }
  };
  marked.addEventListener("change", draw);
  box = dialog(`${here}: changes to ${entry.other.id}`, h("div", { class: "details" },
    h("p", {}, `${entry.other.path}, through ${entry.link_module}`), markedLabel, holder), [
    { label: "Previous", action: () => { at = Math.max(0, at - 1); draw(); return false; } },
    { label: "Next", action: () => { at = Math.min(entry.changes.length - 1, at + 1); draw(); return false; } },
    { label: "OK", primary: true },
  ]);
  draw();
}

// Clear suspect links of the current object; Previous and Next move through the view.
async function clearSuspectDialog() {
  const m = needModule();
  needObject(true);
  let data = await api("trace_suspects", { module: m.id });
  let tab = null, box = null;
  const chosen = new Set();
  const holder = h("div", {});
  const current = () => data.objects.find((o) => o.absno === S.selected) || { in: [], out: [], id: selectedRow()?.id };
  const key = (e) => `${e.source.module}:${e.source.absno}:${e.link}`;

  const draw = () => {
    const object = current();
    if (tab === null) tab = !object.in.length && object.out.length ? "out" : "in";
    const entries = object[tab];
    const button = (name, label) => h("button", { type: "button", class: tab === name ? "primary" : "", "aria-pressed": String(tab === name),
      onclick: () => { tab = name; chosen.clear(); draw(); } }, `${label} (${object[name].length})`);
    const rows = entries.map((e) => {
      const [tick, label] = choice("checkbox", "Select", { checked: chosen.has(key(e)) });
      tick.addEventListener("change", () => { if (tick.checked) chosen.add(key(e)); else chosen.delete(key(e)); draw(); });
      return h("tr", {}, h("td", {}, label), h("td", {}, e.other.path), h("td", {}, e.other.id), h("td", {}, e.modified_on),
        h("td", {}, h("button", { type: "button", onclick: () => suspectDetails(object.id, e) }, "Details...")));
    });
    holder.replaceChildren(
      h("p", {}, h("strong", {}, object.id), " ", h("span", { class: "tabs" }, button("in", "Incoming links"), button("out", "Outgoing links"))),
      rows.length ? listTable(["", "Module", "ID", "Last modified", ""], rows)
        : h("p", {}, `No suspect ${tab === "in" ? "incoming" : "outgoing"} links for this object.`));
    if (box) {
      const [previous, next, clear] = modalOf(box).querySelectorAll(".buttons button");
      previous.disabled = !neighbour(-1);
      next.disabled = !neighbour(1);
      clear.disabled = !chosen.size;
    }
  };
  // The next object of the view in that direction. The current one may no longer
  // be in the view, if a suspect link filter is on and its links were cleared.
  const neighbour = (by) => {
    const shown = visibleRows();
    const here = new Set(shown.map((r) => r.absno));
    const order = S.sort ? shown : S.data.rows;
    for (let i = order.findIndex((r) => r.absno === S.selected) + by; i >= 0 && i < order.length; i += by) {
      if (here.has(order[i].absno)) return order[i];
    }
    return null;
  };
  const move = (by) => {
    const to = neighbour(by);
    if (to) {
      select(to.absno);
      scrollToSelected();
    }
    tab = null;
    chosen.clear();
    draw();
    return false;
  };
  box = wideDialog("Clear suspect links", holder, [
    { label: "Previous object", action: () => move(-1) },
    { label: "Next object", action: () => move(1) },
    { label: "Clear", action: () => {
      const picked = current()[tab].filter((e) => chosen.has(key(e)));
      if (!picked.length) throw new Error("Select the links to clear.");
      confirmDialog("Clear suspect links",
        `Clear the suspicion on ${picked.length} link${picked.length === 1 ? "" : "s"} (${picked.map((e) => e.other.id).join(", ")})? The suspicion is cleared at both ends.`,
        "Clear", async () => {
          const reply = await api("trace_clear_suspect", { items: picked.map((e) => ({ source: e.source, link: e.link })) });
          chosen.clear();
          await refresh();
          data = await api("trace_suspects", { module: m.id });
          draw();
          say(`Cleared ${reply.cleared} suspect link(s).`);
        });
      return false;
    } },
    { label: "Close", primary: true },
  ]);
  draw();
}

async function clearAllDialog() {
  const m = needModule();
  if (!writable()) throw new Error("A baseline is read only.");
  const data = await api("trace_suspects", { module: m.id });
  const all = (direction) => data.objects.flatMap((o) => o[direction]);
  const incoming = all("in"), outgoing = all("out");
  if (!incoming.length && !outgoing.length) {
    return dialog("Clear all suspect links", h("p", {}, `${m.name} has no suspect links.`));
  }
  const [inTick, inLabel] = choice("checkbox", `Clear suspect in-links (${incoming.length})`, { checked: false });
  const [outTick, outLabel] = choice("checkbox", `Clear suspect out-links (${outgoing.length})`, { checked: false });
  dialog("Clear all suspect links", h("div", { class: "checks" }, inLabel, outLabel), [
    { label: "OK", primary: true, action: () => {
      const picked = [...(inTick.checked ? incoming : []), ...(outTick.checked ? outgoing : [])];
      if (!picked.length) throw new Error(inTick.checked || outTick.checked ? "There are none of those to clear." : "Select in-links, out-links, or both.");
      // asked from its own box, over this one: closing this first keeps one question on screen
      setTimeout(() => confirmDialog("Clear all suspect links",
        `Clear ${picked.length} suspect link${picked.length === 1 ? "" : "s"} in ${m.path}? The suspicion is cleared at both ends of each and cannot be undone.`,
        "Clear all", async () => {
          const reply = await api("trace_clear_suspect", { items: picked.map((e) => ({ source: e.source, link: e.link })) });
          await refresh();
          say(`Cleared ${reply.cleared} suspect link(s).`);
        }));
    } },
    { label: "Cancel" },
  ]);
}

// ---------------------------------------------------------------- link overview and matrix

// One CSV cell. A spreadsheet would run text starting like a formula, so it is quoted off.
function csvCell(text) {
  let cell = String(text);
  if (/^'*[=+\-@\t\r\n]/.test(cell) && !/^[+-]?\d+(\.\d+)?$/.test(cell)) cell = "'" + cell;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function downloadCsv(name, rows) {
  const filename = name.replace(/[^\w .()-]+/g, "_") + ".csv";
  // The marker lets Excel recognise UTF-8.
  download(filename, "﻿" + rows.map((r) => r.map(csvCell).join(",") + "\r\n").join(""), "text/csv");
  say("Exported " + filename);
}

// Coverage as text. Rounded to the nearest whole percent, but 100% only when
// complete and 0% only when there is none.
function coverage(part, whole) {
  if (!whole) return "none to cover";
  let percent = Math.round((100 * part) / whole);
  if (part < whole) percent = Math.min(percent, 99);
  if (part > 0) percent = Math.max(percent, 1);
  return `${part} of ${whole} (${percent}%)`;
}

// Open a module with a link filter on.
async function showFiltered(module, filter) {
  await goTo(module, undefined);
  T.linkFilter = filter;
  render();
}

async function overviewDialog() {
  let box = null, data = null;
  const holder = h("div", {});
  const [headings, headingsLabel] = choice("checkbox", "Count heading-only objects", { checked: false });
  const unlinked = (module, direction, linkModule, other) => within(() => box, async () => {
    box.close();
    await showFiltered(module, { have: false, direction, linkModule, module: other, skipHeadings: !headings.checked });
  });
  const link = (text, action, title) => h("button", { type: "button", class: "plain", title, onclick: action }, text);
  const draw = async () => {
    data = await api("trace_overview", { headings: headings.checked });
    const sets = data.linksets.map((s) => h("tr", {},
      h("td", {}, s.link_module.split("/").pop()), h("td", {}, s.source_path), h("td", {}, s.target_path), h("td", {}, String(s.links)),
      h("td", {}, link(coverage(s.sources_linked, s.sources_total), unlinked(s.source, "out", s.link_module, s.target_path),
        "Show the source objects without such a link")),
      h("td", {}, link(coverage(s.targets_linked, s.targets_total), unlinked(s.target, "in", s.link_module, s.source_path),
        "Show the target objects without such a link")),
      h("td", {}, `${s.suspect_at_source} at source, ${s.suspect_at_target} at target`),
      h("td", {}, h("button", { type: "button", onclick: () => act(() => matrixDialog(s, headings.checked)) }, "Matrix..."))));
    const modules = data.modules.map((x) => h("tr", {},
      h("td", {}, link(x.path, within(() => box, async () => { box.close(); await goTo(x.id, undefined); }), "Open")),
      h("td", {}, String(x.total)),
      h("td", {}, link(String(x.no_in), unlinked(x.id, "in", "", ""), "Show the objects without in-links")),
      h("td", {}, link(String(x.no_out), unlinked(x.id, "out", "", ""), "Show the objects without out-links")),
      h("td", {}, link(String(x.no_links), unlinked(x.id, "either", "", ""), "Show the objects without any link"))));
    holder.replaceChildren(
      h("h4", {}, "Links between modules"),
      sets.length ? listTable(["Link module", "Source", "Target", "Links", "Source objects linked", "Target objects linked", "Suspect", ""], sets)
        : h("p", {}, "There are no links."),
      h("h4", {}, "Unlinked objects in each module"),
      listTable(["Module", "Objects", "No in-links", "No out-links", "No links"], modules));
  };
  headings.addEventListener("change", within(() => box, draw));
  await draw();
  box = wideDialog("Link overview", h("div", {}, headingsLabel,
    h("p", { class: "hint" }, "A link goes from its source to its target. Select a count to see the objects that are not linked."),
    holder), [
    { label: "Export CSV", action: () => {
      downloadCsv("link overview", [
        ["Link module", "Source", "Target", "Links", "Source objects linked", "Source objects", "Target objects linked", "Target objects",
          "Suspect at source", "Suspect at target"],
        ...data.linksets.map((s) => [s.link_module, s.source_path, s.target_path, s.links, s.sources_linked, s.sources_total,
          s.targets_linked, s.targets_total, s.suspect_at_source, s.suspect_at_target]),
        [],
        ["Module", "Objects", "No in-links", "No out-links", "No links"],
        ...data.modules.map((x) => [x.path, x.total, x.no_in, x.no_out, x.no_links]),
      ]);
      return false;
    } },
    { label: "Close", primary: true },
  ]);
}

const MATRIX_LIMIT = 150; // rows or columns drawn; the CSV has them all

async function matrixDialog(set, countHeadings) {
  const data = await api("trace_matrix", { link_module: set.link_module, source: set.source, target: set.target });
  const marks = new Map(data.marks.map(([r, c, atSource, atTarget]) => [`${r}:${c}`, atSource || atTarget]));
  const linkedRows = new Set(data.marks.map((x) => x[0])), linkedColumns = new Set(data.marks.map((x) => x[1]));
  let box = null;
  const holder = h("div", {});
  const picked = h("div", { class: "picked-link" }, "Select a filled square to go to either end.");
  const [only, onlyLabel] = choice("checkbox", "Only rows and columns with links", { checked: false });
  const kept = (list, linked) => list.map((x, i) => [x, i])
    .filter(([x, i]) => !x.deleted && (only.checked ? linked.has(i) : linked.has(i) || countHeadings || !x.heading));
  const go = (module, absno) => within(() => box, async () => {
    // close every box over the module window first
    for (const open of document.querySelectorAll("dialog[open]")) { open.close(); open.remove(); }
    await goTo(module, absno);
  });
  const draw = () => {
    const rows = kept(data.rows, linkedRows), columns = kept(data.columns, linkedColumns);
    const shownRows = rows.slice(0, MATRIX_LIMIT), shownColumns = columns.slice(0, MATRIX_LIMIT);
    holder.replaceChildren(...[
      rows.length > MATRIX_LIMIT || columns.length > MATRIX_LIMIT
        ? h("p", {}, `Showing the first ${MATRIX_LIMIT} rows and columns of ${rows.length} by ${columns.length}. The CSV holds them all.`) : null,
      h("div", { class: "matrix-scroll" }, h("table", { class: "matrix" },
        h("thead", {}, h("tr", {}, h("th", {}, "source \\ target"),
          shownColumns.map(([c]) => h("th", { class: "across", title: c.text }, h("span", {}, c.id))))),
        h("tbody", {}, shownRows.map(([row, r]) => h("tr", {}, h("th", { title: row.text }, row.id),
          shownColumns.map(([column, c]) => {
            const key = `${r}:${c}`;
            if (!marks.has(key)) return h("td", {});
            const suspect = marks.get(key);
            return h("td", { class: "linked" + (suspect ? " suspect-cell" : "") }, h("button", { type: "button",
              "aria-label": `${row.id} links to ${column.id}${suspect ? ", suspect" : ""}`, title: `${row.id} -> ${column.id}${suspect ? " (suspect)" : ""}`,
              onclick: () => picked.replaceChildren(
                h("p", {}, h("strong", {}, `${row.id} → ${column.id}`), suspect ? " (suspect)" : ""),
                h("p", {}, `${row.id}: ${row.text.slice(0, 160)}`), h("p", {}, `${column.id}: ${column.text.slice(0, 160)}`),
                h("button", { type: "button", onclick: go(set.source, row.absno) }, "Go to link source"), " ",
                h("button", { type: "button", onclick: go(set.target, column.absno) }, "Go to link target")) },
            suspect ? "?" : ""));
          })))))),
    ].filter(Boolean));
  };
  only.addEventListener("change", draw);
  draw();
  const name = set.link_module.split("/").pop();
  // one link module can join several pairs of modules: the file name says which
  const file = `matrix ${name} ${set.source_path.split("/").pop()} to ${set.target_path.split("/").pop()}`;
  box = wideDialog(`Matrix: ${name}`, h("div", {},
    h("p", {}, `Source (down): ${set.source_path}. Target (across): ${set.target_path}.`), onlyLabel, holder, picked), [
    { label: "Export CSV", action: () => {
      const rows = kept(data.rows, linkedRows), columns = kept(data.columns, linkedColumns);
      downloadCsv(file, [["Source \\ Target", ...columns.map(([c]) => c.id)],
        ...rows.map(([row, r]) => [row.id, ...columns.map(([, c]) => (!marks.has(`${r}:${c}`) ? "" : marks.get(`${r}:${c}`) ? "?" : "X"))])]);
      return false;
    } },
    { label: "Close", primary: true },
  ]);
}

// ---------------------------------------------------------------- export of the view

// The rows and columns on screen, as they are filtered and sorted.
function viewRows() {
  const m = needModule();
  const columns = [];
  const add = (title, text) => columns.push({ title, text });
  const main = (row) => [row.values["Object Heading"], row.values["Object Text"] || (row.values["Object Heading"] ? "" : row.values["Object Short Text"])]
    .filter(Boolean).join("\n");
  const layout = S.layout || plainColumns(S.columns.filter((n) => attribute(n) || S.data.system_attributes.includes(n) || n === "Absolute Number"));
  layout.forEach((c, i) => {
    if (c.kind === "id") add(c.title ?? "ID", (row) => row.id);
    else if (c.kind === "main") {
      add("Number", (row) => row.number);
      add(c.title ?? m.name, main);
    } else if (c.kind === "attribute") add(c.title ?? c.attribute, (row) => cellText(row, c.attribute));
    else if (c.kind === "dxl") add(c.title ?? "DXL", (row) => (S.layoutCells[i] || {})[row.absno] || "");
    else add(c.title ?? "", () => "");
  });
  const ends = (list) => list.map((l) => l.other.id).join("; ");
  if (S.outLinks) add("Out-links", (row) => ends(row.out));
  if (S.inLinks) add("In-links", (row) => ends(row.in));
  if (S.dxlColumn) add(S.dxlColumn.title, (row) => S.dxlColumn.cells[row.absno] || "");
  for (const extra of TRACE.columns()) {
    add(extra.title, (row) => {
      const content = extra.cell(row);
      return typeof content === "string" ? content : content.map((node) => node.textContent).join(T.suspectColumn.kind === "indicators" ? "" : "\n");
    });
  }
  return [columns.map((c) => c.title), ...visibleRows().map((row) => columns.map((c) => c.text(row)))];
}

function exportView() {
  const rows = viewRows();
  downloadCsv(S.data.module.name + (S.view ? " - " + S.view : ""), rows);
}

// ---------------------------------------------------------------- menus

const fileMenu = MENUS.File;
MENUS.File = () => {
  const entries = fileMenu();
  const at = entries.findIndex((e) => e && e[0] === "Export CSV...");
  entries.splice(at + 1, 0, ["Export view to CSV", exportView, "", can.module()]);
  return entries;
};

MENUS.Analysis = () => {
  const columns = S.data && (S.layout || []).some((c) => c.kind === "dxl");
  const suspectShown = can.baseline();
  return [
    ["Traceability wizard...", traceWizard, "", can.baseline()],
    ["Traceability columns...", traceColumnsDialog, "", can.module() || (columns ? "" : "this view has none")],
    ["Traceability Explorer", () => {}, "", "not built here"],
    null,
    ["Link overview and matrix...", overviewDialog, "", ""],
    ["Filter on links and columns...", linkFilterDialog, "", can.module()],
    null,
    ["Suspect links: filter...", suspectFilterDialog, "", can.module()],
    ["Suspect links: indicators...", () => suspectColumnDialog("indicators", "Display suspect indicators"), "", suspectShown],
    ["Suspect links: last change...", () => suspectColumnDialog("last", "Display last change"), "", suspectShown],
    ["Suspect links: all changes...", () => suspectColumnDialog("all", "Display all changes"), "", suspectShown],
    ["Suspect links: clear...", clearSuspectDialog, "", can.write() || can.object()],
    ["Suspect links: clear all...", clearAllDialog, "", can.write()],
    null,
    ["Export view to CSV", exportView, "", can.module()],
    ["Compare with baseline...", () => compareDialog(), "", can.compare()],
    ["Baselines...", baselinesDialog, "", can.module()],
  ];
};
