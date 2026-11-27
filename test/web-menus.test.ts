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
    call("split_heading", { module: system, absno: obj.absno });
    assert.equal(store.value(obj, "Object Text"), "");
    assert.equal(store.value(store.child_objects(system, obj.absno)[0], "Object Text"), "one");
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
    const reply = call("replace_text", { module: system, absnos: [child.absno, parent.absno], find: "water", replace: "steam" });
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
