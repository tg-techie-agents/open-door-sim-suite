// The catalogue of what the tool offers (menus.js): every menu entry comes from
// it, so the Help page cannot drift from the menus. And the operations behind
// the editing and link entries.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { VirtualDisk } from "../src/dxl/files.ts";
import { Obj, Store } from "../src/store.ts";
import { Api, plain } from "../src/web/api.ts";
import { example, read_file } from "./helpers.ts";

// menus.js with the page around it stood in for, in a given state.
function menus(state: "no module" | "module" | "baseline"): any {
  const node = { id: 1, kind: "folder", deleted: false, path: "/", children: [] };
  const stub = new Proxy(() => "", { get: () => stub });
  const names = new Set<string>();
  const source = read_file("src/web/menus.js");
  // every name menus.js calls from the other files stands for nothing
  for (const m of source.matchAll(/\b([a-zA-Z][A-Za-z0-9]*)\b/g)) names.add(m[1]);
  const page: any = {};
  for (const name of names) {
    if (!/^(FEATURES|MENUS|STATUS_NAMES|ONE_USER|NO_\w+|M|X|SUB|itemMenu|objectMenu|editModeEntries|moveEntries|insertObjectEntries|clipboardEntries|contentEntries|linkEntries|keysDialog|menuPlaces|helpPage|needs)$/.test(name)
      && !(name in globalThis)) page[name] = stub;
  }
  Object.assign(page, {
    S: { data: state === "no module" ? null : { attributes: [], baselines: [] }, undo: [], find: {}, tree: node, picked: 1 },
    can: new Proxy({}, { get: () => () => (state === "no module" ? "open a formal module first" : "") }),
    pickedItem: () => node, containerForNew: () => node, favourites: () => [], formalModules: () => [],
    linkedEntries: () => [["▶ SRS-1", () => {}, "", "", "showLinked"]],
    selectedRow: () => null, tick: (_: boolean, label: string) => label, buildMenubar: () => {},
    TRACE: { filtering: () => false },
  });
  return runInNewContext(source + "\n;({ FEATURES, MENUS, objectMenu, menuPlaces })", page);
}

function leaves(entries: any[]): any[] {
  return entries.flatMap((e) => (!e ? [] : Array.isArray(e[1]) ? leaves(e[1]) : [e]));
}

describe("what the menus offer", () => {
  for (const state of ["no module", "module", "baseline"] as const) {
    test(`every entry is in the catalogue, and what is not offered is greyed with its reason (${state})`, () => {
      const page = menus(state);
      const entries = [...Object.values(page.MENUS).flatMap((menu: any) => leaves(menu())), ...leaves(page.objectMenu())];
      assert.ok(entries.length > 150);
      for (const [label, action, , why, id] of entries) {
        const feature = page.FEATURES[id];
        assert.ok(feature, `${label}: ${id} is not in the catalogue`);
        if (feature[2] === "no") {
          assert.equal(action, null, label);
          assert.equal(why, feature[3], label);
        } else assert.equal(typeof action, "function", label);
      }
    });
  }

  test("every feature is in a menu or says where it is, and one not offered says why", () => {
    const page = menus("module");
    const places = page.menuPlaces();
    for (const [id, [area, label, status, note, where]] of Object.entries(page.FEATURES) as any) {
      assert.ok(area && label && ["full", "part", "no"].includes(status), id);
      assert.ok(status === "full" || note, `${id} needs a note`);
      // favourites appear only once there are some
      assert.ok(places.has(id) || where || id === "favouriteOpen", `${id} is in no menu and says no place`);
      if (status === "no" && !where) assert.ok(places.has(id), id);
    }
  });
});

// ---------------------------------------------------------------- operations

const SYSTEM = "/Greenhouse Demo/System Requirements", NEEDS = "/Greenhouse Demo/Stakeholder Needs";

function setup() {
  const store = example();
  const api = new Api(store, "t", { names: {}, layout: {} }, new VirtualDisk()) as any;
  const call = (operation: string, args: Record<string, unknown> = {}): any => {
    const result = api["op_" + operation](args);
    return result === undefined ? null : JSON.parse(JSON.stringify(plain(result)));
  };
  return { store, call, system: store.module_at(SYSTEM)!, needs: store.module_at(NEEDS)! };
}

const texts = (store: Store, module: number) => [...store.objects(module)].map((o) => store.value(o, "Object Heading") + "|" + store.value(o, "Object Text"));

describe("editing operations", () => {
  test("copy takes an object and its children, not its links; cut moves it", () => {
    const { store, call, system } = setup();
    const top = [...store.objects(system)][0];
    const branch = 1 + store.child_objects(system, top.absno).length;
    const before = [...store.objects(system)].length;
    const made = call("paste_object", { source: { module: system, absno: top.absno }, module: system, ref: top.absno, where: "child" });
    assert.ok(made.count >= branch);
    assert.equal([...store.objects(system)].length, before + made.count);
    assert.equal(store.links(new Obj(system, made.absno), true).length, 0);

    const last = store.child_objects(system, null).at(-1)!;
    call("paste_object", { source: { module: system, absno: made.absno }, module: system, ref: last.absno, where: "after", cut: true });
    assert.equal(store.child_objects(system, null).at(-1)!.absno, made.absno);
    assert.throws(() => call("paste_object", { source: { module: system, absno: top.absno }, module: system,
      ref: store.child_objects(system, top.absno)[0].absno, where: "child", cut: true }), /inside itself/);
  });

  test("splitting an object, and a heading from its text", () => {
    const { store, call, system } = setup();
    const obj = store.create_object(system);
    store.set_value(obj, "Object Text", "one\n\ntwo\n \nthree");
    call("split_object", { module: system, absno: obj.absno });
    assert.deepEqual(texts(store, system).slice(-3), ["|one", "|two", "|three"]);
    assert.throws(() => call("split_object", { module: system, absno: obj.absno }), /no blank line/);
    store.set_value(obj, "Object Heading", "Head");
    // the object keeps its identity and text, and goes below a new one holding the heading
    const kid = store.create_object(system, obj);
    const made = call("split_heading", { module: system, absno: obj.absno });
    const above = store.object(system, made.absno)!;
    assert.deepEqual([store.value(above, "Object Heading"), store.value(obj, "Object Heading"), store.value(obj, "Object Text")], ["Head", "", "one"]);
    assert.deepEqual(store.child_objects(system, made.absno).map((o) => o.absno), [obj.absno, kid.absno]);
  });

  test("replace is plain text, and restoring leaves later changes alone", () => {
    const { store, call, system } = setup();
    const a = store.create_object(system), b = store.create_object(system);
    for (const o of [a, b]) store.set_value(o, "Object Text", "a.b A.B axb");
    const reply = call("replace_text", { module: system, absnos: [a.absno, b.absno], find: "a.b", replace: "$&" });
    assert.equal(reply.count, 4);
    assert.equal(store.value(a, "Object Text"), "$& $& axb");
    store.set_value(b, "Object Text", "edited since");
    assert.equal(call("restore_values", { module: system, changes: reply.changes }).skipped, 1);
    assert.equal(store.value(a, "Object Text"), "a.b A.B axb");
    assert.equal(store.value(b, "Object Text"), "edited since");
  });

  test("link by attribute previews, then makes each link once", () => {
    const { store, call, system, needs } = setup();
    const target = [...store.objects(needs)][1];
    const id = store.identifier(target);
    const obj = store.create_object(system);
    store.set_value(obj, "Object Text", `traces to ${id}, ${store.prefix(needs)}9999 and X${id}`);
    const args = { module: system, attribute: "Object Text", target_module: needs };
    const preview = call("link_by_attribute", { ...args, preview: true });
    assert.equal(store.links(obj, true).length, 0);
    assert.ok(preview.missing.includes(`${store.prefix(needs)}9999`));
    const done = call("link_by_attribute", { ...args, preview: false });
    assert.equal(done.made, preview.made);
    assert.equal(store.links(obj, true).length, 1);
    assert.equal(call("link_by_attribute", { ...args, preview: false }).made, 0);
  });

  test("the link module window lists the links it holds", () => {
    const { store, call } = setup();
    const modules = [...store.walk()].filter((i) => i.kind === "link");
    const held = modules.map((m) => call("link_module", { module: m.id }).links);
    assert.ok(held.some((links) => links.length > 0));
    for (const link of held.flat()) assert.ok(link.source.id && link.target.id);
  });

  test("DXL coverage is served from the engine's own list", () => {
    const names = setup().call("dxl_coverage");
    assert.ok(names.length > 1000);
    for (const n of names) assert.equal(n.offered, n.reason === null, n.name);
  });
});

describe("inherited values stay inherited", () => {
  function family() {
    const s = setup();
    s.call("create_attribute", { module: s.system, name: "Area", type: "String", extras: { inherit: true } });
    const parent = s.store.create_object(s.system), child = s.store.create_object(s.system, parent);
    s.store.set_value(parent, "Area", "water");
    return { ...s, parent, child };
  }

  test("an unchanged cell is not written back, and a changed one is said to be the object's own", () => {
    const { store, call, system, parent, child } = family();
    assert.equal(call("set_values", { module: system, absno: child.absno, values: { Area: "water" } }), null);
    assert.equal(store.has_own_value(child, "Area"), false);
    store.set_value(parent, "Area", "air");
    assert.equal(store.value(child, "Area"), "air");
    assert.deepEqual(call("set_values", { module: system, absno: child.absno, values: { Area: "heat" } }), { made_own: ["Area"] });
    assert.equal(store.has_own_value(child, "Area"), true);
  });

  test("copy and replace leave them inherited", () => {
    const { store, call, system, parent, child } = family();
    const made = call("paste_object", { source: { module: system, absno: parent.absno }, module: system, ref: null });
    const copy = store.child_objects(system, made.absno)[0];
    assert.equal(store.has_own_value(copy, "Area"), false);
    assert.equal(store.value(copy, "Area"), "water");
    const reply = call("replace_text", { module: system, absnos: [child.absno, parent.absno], find: "water", replace: "steam", all_text: true });
    assert.equal(reply.count, 1);
    assert.equal(store.has_own_value(child, "Area"), false);
    assert.equal(store.value(child, "Area"), "steam");
  });
});

test("link module rules, and a preview that refuses what making would", () => {
  const { store, call, system, needs } = setup();
  const folder = store.item(system).parent!;
  call("add_link_rule", { folder, source: "System Requirements", target: "Stakeholder Needs", linkmod: "only", mandatory: true });
  assert.equal(call("link_rules", { folder }).rules.length, 1);
  call("set_links_exclusive", { folder, module: system, exclusive: true });
  const obj = store.create_object(system);
  store.set_value(obj, "Object Text", store.identifier([...store.objects(needs)][1]));
  const args = { module: system, attribute: "Object Text", target_module: needs, link_module: "/Greenhouse Demo/other" };
  const preview = call("link_by_attribute", { ...args, preview: true });
  const done = call("link_by_attribute", { ...args, preview: false });
  assert.deepEqual([preview.made, preview.refused], [done.made, done.refused]);
  assert.equal(store.links(obj, true).length, done.made);
});

test("access rights are enforced on changes, refusals say why, and reset is the way out", () => {
  const { store, call, system } = setup();
  const obj = [...store.objects(system)][0];
  assert.equal(call("access", { item: system }).inherited, true);
  call("change_access", { item: system, action: "specific" });
  call("change_access", { item: system, action: "set", name: "other person", rights: ["control"] });
  call("change_access", { item: system, action: "set", name: store.user, rights: ["read"] });
  assert.throws(() => call("set_values", { module: system, absno: obj.absno, values: { "Object Text": "x" } }), /no access/);
  assert.deepEqual(call("access", { module: system, absno: obj.absno }).entries.find((e: any) => e.name === store.user).rights, ["read"]);
  assert.throws(() => call("change_access", { item: system, action: "inherit" }), /no access/);
  call("change_access", { item: system, action: "reset" });
  call("set_values", { module: system, absno: obj.absno, values: { "Object Text": "x" } });
});

test("linksets are made and deleted with their links, and the default link module is used", () => {
  const { store, call, system, needs } = setup();
  const held = store.create_link_module("/Greenhouse Demo", "extra");
  call("create_linkset", { module: held, source: system, target: needs });
  assert.equal(call("link_module", { module: held }).linksets.length, 1);
  call("set_default_link", { name: "extra" });
  assert.equal(call("default_link").name, "extra");
  const from = store.create_object(system);
  call("create_link", { source: { module: system, absno: from.absno }, target_module: needs,
    target: store.identifier([...store.objects(needs)][1]) });
  assert.equal(call("link_module", { module: held }).links.length, 1);
  call("delete_linkset", { module: held, source: system, target: needs });
  assert.deepEqual(call("link_module", { module: held }), { links: [], linksets: [] });
  assert.equal(store.links(from, true).length, 0);
});

// -- several objects at once, as the module window's commands act on them ------

function outline() {
  const made = setup();
  const { store, system } = made;
  const add = (parent: Obj | null, text: string) => store.create_object(system, parent, null, null, new Map([["Object Text", text]]));
  const one = add(null, "one"), kid = add(one, "kid"), two = add(null, "two"), three = add(null, "three");
  const shape = () => {
    const walk = (parent: number | null, depth: number): string[] => store.child_objects(system, parent)
      .filter((o) => !store.is_deleted(o) && [one, kid, two, three].some((x) => x.equals(o)))
      .flatMap((o) => [`${"-".repeat(depth)}${store.value(o, "Object Text")}`, ...walk(o.absno, depth + 1)]);
    return walk(null, 0);
  };
  return { ...made, one, kid, two, three, shape };
}

test("neighbours move, demote and promote as a block", () => {
  const { call, system, two, three, shape } = outline();
  const absnos = [two.absno, three.absno];
  call("move_objects", { module: system, absnos, direction: "demote" });
  assert.deepEqual(shape(), ["one", "-kid", "-two", "-three"]);
  call("move_objects", { module: system, absnos, direction: "promote" });
  assert.deepEqual(shape(), ["one", "-kid", "two", "three"]);
  call("move_objects", { module: system, absnos, direction: "up" });
  assert.deepEqual(shape(), ["two", "three", "one", "-kid"]);
});

test("deleting several takes what is below, and is refused whole while a link comes in", () => {
  const { store, call, system, needs, one, kid, two, shape } = outline();
  const from = [...store.objects(needs)][1];
  store.create_link(from, kid);
  assert.throws(() => call("delete_objects", { module: system, absnos: [one.absno, two.absno] }), /delete the in-links first/);
  assert.equal(shape().length, 4);
  for (const link of store.links(from, true).filter((l) => l.target.equals(kid))) store.delete_link(link);
  const { deleted } = call("delete_objects", { module: system, absnos: [one.absno, two.absno] });
  assert.deepEqual(deleted, [one.absno, kid.absno, two.absno]);
  assert.deepEqual(shape(), ["three"]);
  assert.equal(call("undelete_objects", { module: system, absnos: deleted }).count, 3);
  assert.deepEqual(shape(), ["one", "-kid", "two", "three"]);
});

test("one value for several objects, and chosen values added to a multi-valued one", () => {
  const { store, call, system, one, two } = outline();
  store.create_type(system, "Phases", "Enumeration", ["A", "B", "C"]);
  store.create_attribute(system, "Phase", "Phases", "object", true);
  store.set_value(one, "Phase", "A\nB");
  store.set_value(two, "Phase", "C");
  const absnos = [one.absno, two.absno];
  const reply = call("set_value_many", { module: system, absnos, name: "Phase", add: ["C"], remove: ["A"] });
  assert.deepEqual([store.value(one, "Phase"), store.value(two, "Phase")], ["B\nC", "C"]);
  assert.equal(reply.changed, 1);
  call("restore_values", { module: system, changes: reply.changes });
  assert.equal(store.value(one, "Phase"), "A\nB");
  assert.throws(() => call("set_value_many", { module: system, absnos, name: "Object Text", add: ["x"] }), /one value/);
});

test("links from several objects to several, and their out-links removed", () => {
  const { store, call, system, needs, one, two } = outline();
  const ends = [...store.objects(needs)].slice(0, 2).map((o) => ({ module: needs, absno: o.absno }));
  const sources = [one, two].map((o) => ({ module: system, absno: o.absno }));
  assert.equal(call("create_links", { sources, targets: ends }).made, 4);
  assert.equal(call("create_links", { sources, targets: ends }).existing, 4);
  assert.equal(call("delete_out_links", { module: system, absnos: [one.absno, two.absno] }).count, 4);
  assert.equal(store.links(one, true).length, 0);
});

test("link by attribute reads absolute numbers even when the target has a prefix, in either direction", () => {
  const { store, call, system, needs, one } = outline();
  const target = [...store.objects(needs)][2];
  assert.ok(store.prefix(needs));
  store.create_attribute(system, "Satisfies", "Text");
  store.set_value(one, "Satisfies", `${target.absno}\n9999`);
  const args = { module: system, attribute: "Satisfies", target_module: needs, direction: "in", preview: false };
  const reply = call("link_by_attribute", args);
  assert.deepEqual([reply.made, reply.missing], [1, ["9999"]]);
  assert.ok(store.links(target, true).some((l) => l.target.equals(one)));
});

test("a copy takes what is below only when asked, and several are pasted in order", () => {
  const { store, call, system, one, two, three } = outline();
  const source = { module: system, absnos: [one.absno, two.absno] };
  assert.equal(call("paste_object", { source, module: system, ref: three.absno, where: "after", hierarchy: false }).count, 2);
  const made = call("paste_object", { source, module: system, ref: null });
  assert.equal(made.count, 3);
  call("paste_object", { source, module: system, ref: three.absno, where: "child", cut: true });
  assert.deepEqual(store.child_objects(system, three.absno).map((o) => o.absno), [one.absno, two.absno]);
});

// The module window's Shift+click rule (select.js), on a small tree.
test("a selection takes what is below its ends and widens to a common parent", () => {
  const run = runInNewContext(read_file("src/web/select.js") + "\n;selectionRun", { document: { addEventListener() {} } });
  // 1 (2 (3), 4), 5 (6), 7
  const rows = [[1, null], [2, 1], [3, 2], [4, 1], [5, null], [6, 5], [7, null]].map(([absno, parent]) => ({ absno, parent }));
  const taken = (a: number, b: number) => [...run(rows, a, b)];
  assert.deepEqual(taken(2, 4), [2, 3, 4]);
  assert.deepEqual(taken(2, 2), [2, 3]);
  assert.deepEqual(taken(3, 4), [2, 3, 4]); // different levels
  assert.deepEqual(taken(3, 6), [1, 2, 3, 4, 5, 6]); // different parents
  assert.deepEqual(taken(7, 6), [5, 6, 7]); // upwards
  assert.deepEqual(taken(3, 1), [1, 2, 3, 4]); // one end above the other
});

test("module copy, history sessions and baseline sets answer through the page's operations", () => {
  const { store, call, system } = setup();
  const before = store.sessions(system).length;
  call("record_session", { module: system });
  assert.equal(store.sessions(system).length, before + 1);

  const made = call("create_item", { parent: store.item(system).parent, kind: "formal", name: "Alone" });
  const copy = call("copy_module", { module: made.id, name: "Alone copy" });
  assert.equal(store.item(copy.id).name, "Alone copy");

  const folder = store.item(system).parent!;
  const { id } = call("create_set_definition", { folder, name: "Release", modules: [made.id] });
  const { index } = call("create_baseline_set", { folder, id, major: false });
  call("add_to_baseline_set", { folder, id, index, modules: [made.id] });
  call("close_baseline_set", { folder, id, index });
  const [definition] = call("baseline_sets").definitions;
  assert.deepEqual([definition.name, definition.sets[0].label, definition.sets[0].open, definition.sets[0].members.length],
    ["Release", "0.1", false, 1]);
  assert.deepEqual(Object.values(call("baseline_set_names", { module: made.id })), ["Release 0.1"]);
  assert.throws(() => call("add_to_baseline_set", { folder, id, index, modules: [made.id] }), /closed/);
  assert.throws(() => call("delete_set_definition", { folder, id }), /has baseline sets/);
});

test("bulk links preview without changing, delete by link module, and clear a whole module", () => {
  const { store, call, system, needs, one, two } = outline();
  const sources = [one, two].map((o) => ({ module: system, absno: o.absno }));
  const targets = [...store.objects(needs)].slice(0, 2).map((o) => ({ module: needs, absno: o.absno }));
  const folder = store.path(store.item(system).parent!);
  const first = `${folder}/first`, second = `${folder}/second`;
  const args = { sources, targets, link_module: first };
  assert.equal(call("create_links", { ...args, preview: true }).made, 4);
  assert.equal(store.links(one, true).length, 0);
  call("create_links", args);
  assert.equal(call("create_links", args).existing, 4);
  // the same pair through another link module is another link
  assert.equal(call("create_links", { ...args, link_module: second }).made, 4);
  assert.equal(call("delete_links_between", { ...args, targets: targets.slice(0, 1), preview: true }).count, 2);
  assert.equal(call("delete_links_between", args).count, 4);
  assert.equal(store.links(one, true).length, 2);
  const gone = call("delete_all_links", { module: needs, preview: true });
  assert.ok(gone.in >= 4);
  call("delete_all_links", { module: needs });
  assert.deepEqual(call("delete_all_links", { module: needs, preview: true }), { out: 0, in: 0 });
});

test("a new module may start its IDs higher, and names are held to the characters DOORS allows", () => {
  const { store, call, system } = setup();
  const parent = store.item(system).parent!;
  const { id } = call("create_item", { parent, kind: "formal", name: "Numbered v1.0", prefix: "N-", start: "100" });
  const made = call("add_object", { module: id, where: "end" });
  assert.equal(made.absno, 100);
  assert.throws(() => call("create_item", { parent, kind: "formal", name: "Late", start: "0" }), /whole number/);
  assert.throws(() => call("create_item", { parent, kind: "folder", name: "A (draft)" }), /as in DOORS/);
  assert.throws(() => call("update_item", { id, name: "x:y" }), /as in DOORS/);
  call("update_item", { id, name: "Numbered v1.0", description: "Heads the column" });
  assert.throws(() => call("copy_module", { module: id, name: "a&b" }), /as in DOORS/);
  assert.equal(call("module", { module: id }).module.description, "Heads the column");
  call("create_baseline", { module: id, major: true });
  const [baseline] = call("module", { module: id }).baselines;
  assert.deepEqual([baseline.major, baseline.minor], [1, 0]);
});
