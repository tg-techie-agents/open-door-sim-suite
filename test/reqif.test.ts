// node --test test/reqif.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { load_project } from "../src/io/project.ts";
import {
  MAX_BYTES, MAX_DEPTH, MAX_LEVELS, _inflate, export_reqif, import_reqif, write_zip,
} from "../src/io/reqif.ts";
import { Obj, Store, StoreError } from "../src/store.ts";
import { Api } from "../src/web/api.ts";

const EXAMPLE = readFileSync(new URL("../examples/example-project.json", import.meta.url), "utf8");
const DEMO = "/Greenhouse Demo";
const SRS = DEMO + "/System Requirements";
const NS = "http://www.omg.org/spec/ReqIF/20110401/reqif.xsd";

function example(): Store {
  const store = new Store(":memory:", "tester");
  load_project(store, EXAMPLE);
  return store;
}

const formal = (store: Store) => [...store.walk()].filter((i) => i.kind === "formal");

// A module as ReqIF carries it: no numbers, no paths above the module.
function content(store: Store, module: number) {
  const held = store.values(module);
  return {
    name: store.item(module).name,
    description: store.item(module).description,
    prefix: store.prefix(module),
    attributes: store.attributes(module, null)
      .map((a) => [a.name, a.base, a.scope, a.multi, a.default, [...a.values]])
      .filter(([name]) => name !== "Foreign ID")
      .sort(),
    module_values: store.attributes(module, "module").map((a) => [a.name, store.module_value(module, a.name)]).sort(),
    objects: store.objects(module).map((o) => ({
      level: store.level(o),
      values: [...held.get(o.absno) ?? []].filter(([name, v]) => v !== "" && name !== "Foreign ID").sort(),
      links: store.links(o, true).map((l) => {
        const target = store.item(l.target.module_id).name;
        const order = store.objects(l.target.module_id).findIndex((t) => t.equals(l.target));
        return `${store.item(l.link_module).name} -> ${target} #${order}`;
      }).sort(),
    })),
  };
}

test("the example project round-trips", () => {
  const first = example();
  first.set_value(new Obj(first.module_at(SRS)!, 2), "Object Text",
    "  two <lines> & \"quotes\"\n\n\tindented °C \u{1F331}  x\n");
  const modules = formal(first);
  const made = export_reqif(first, modules.map((m) => m.id));
  assert.equal(made.skipped_links, 0);
  assert.ok(made.relations > 0);

  const second = new Store(":memory:", "tester");
  const result = import_reqif(second, "/In/Here", new TextEncoder().encode(made.text));
  assert.deepEqual([result.objects, result.links, result.skipped_relations, result.unplaced_objects],
    [made.objects, made.relations, 0, 0]);
  assert.equal(result.modules.length, modules.length);
  for (const module of modules) {
    const copy = second.module_at(`/In/Here/${module.name}`)!;
    // Objects not shown (deleted ones) are not exchanged.
    assert.deepEqual(content(second, copy), content(first, module.id), module.name);
  }
  const copy = second.module_at("/In/Here/System Requirements")!;
  assert.equal(second.value(second.objects(copy)[1], "Foreign ID"), "SRS-2");

  // The same database gives the same document, apart from the time and the header's identifier.
  const settle = (text: string) => text.replace(/LAST-CHANGE="[^"]*"/g, "").replace(/<THE-HEADER>.*<\/THE-HEADER>/, "");
  assert.equal(settle(export_reqif(first, modules.map((m) => m.id)).text), settle(made.text));
});

test("links to modules left out are counted, not written", () => {
  const store = example();
  const made = export_reqif(store, [store.module_at(SRS)!]);
  assert.ok(made.skipped_links > 0);
  assert.equal(made.relations, 0);
  assert.throws(() => export_reqif(store, [store.find(DEMO)!]), /is not a formal module/);
});

test("MAX-LENGTH covers the longest string, and nothing is cut", () => {
  const store = new Store(":memory:", "tester");
  const module = store.create_module("/", "M");
  const lengths = () => [...export_reqif(store, [module]).text.matchAll(/MAX-LENGTH="(\d+)"/g)].map((m) => Number(m[1]));
  const object = store.create_object(module, null, null, null, { "Object Short Text": "short" });
  assert.deepEqual([...new Set(lengths())], [32000]);

  const long = "\u{1F331}".repeat(40000); // 40000 characters, 80000 UTF-16 units
  store.set_value(object, "Object Short Text", long);
  assert.equal(Math.max(...lengths()), 40000);
  const copy = new Store(":memory:", "tester");
  import_reqif(copy, "/", export_reqif(store, [module]).text);
  assert.equal(copy.value(copy.objects(copy.module_at("/M")!)[0], "Object Short Text"), long);
});

// A made-up document using the attribute names DOORS uses.
function document(text_value: string, hierarchy: string): string {
  const ref = (kind: string, id: string) =>
    `<DEFINITION><ATTRIBUTE-DEFINITION-${kind}-REF>${id}</ATTRIBUTE-DEFINITION-${kind}-REF></DEFINITION>`;
  const definition = (kind: string, id: string, name: string) =>
    `<ATTRIBUTE-DEFINITION-${kind} IDENTIFIER="${id}" LONG-NAME="${name}"/>`;
  const object = (id: string, values: string) =>
    `<SPEC-OBJECT IDENTIFIER="${id}"><VALUES>${values}</VALUES><TYPE><SPEC-OBJECT-TYPE-REF>ot</SPEC-OBJECT-TYPE-REF></TYPE></SPEC-OBJECT>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<REQ-IF xmlns="${NS}" xmlns:xhtml="http://www.w3.org/1999/xhtml"><CORE-CONTENT><REQ-IF-CONTENT>
 <SPEC-TYPES><SPEC-OBJECT-TYPE IDENTIFIER="ot"><SPEC-ATTRIBUTES>
  ${definition("STRING", "fid", "ReqIF.ForeignID")}${definition("XHTML", "head", "ReqIF.ChapterName")}${definition("XHTML", "body", "ReqIF.Text")}
 </SPEC-ATTRIBUTES></SPEC-OBJECT-TYPE></SPEC-TYPES>
 <SPEC-OBJECTS>
  ${object("o1", `<ATTRIBUTE-VALUE-XHTML>${ref("XHTML", "head")}<THE-VALUE><xhtml:div>Pumping</xhtml:div></THE-VALUE></ATTRIBUTE-VALUE-XHTML>`)}
  ${object("o2", `<ATTRIBUTE-VALUE-STRING THE-VALUE="17">${ref("STRING", "fid")}</ATTRIBUTE-VALUE-STRING>
   <ATTRIBUTE-VALUE-XHTML>${ref("XHTML", "body")}<THE-VALUE>${text_value}</THE-VALUE></ATTRIBUTE-VALUE-XHTML>`)}
 </SPEC-OBJECTS>
 <SPECIFICATIONS><SPECIFICATION IDENTIFIER="sp" LONG-NAME="Pump spec"><CHILDREN>${hierarchy}</CHILDREN></SPECIFICATION></SPECIFICATIONS>
</REQ-IF-CONTENT></CORE-CONTENT></REQ-IF>
`;
}

const NODE = (object: string, children: string = "") =>
  `<SPEC-HIERARCHY><OBJECT><SPEC-OBJECT-REF>${object}</SPEC-OBJECT-REF></OBJECT>${children && `<CHILDREN>${children}</CHILDREN>`}</SPEC-HIERARCHY>`;

const RICH = `
  <xhtml:div>
    <xhtml:p>The pump <xhtml:b>shall</xhtml:b>
      start within 2 s.</xhtml:p>
    <xhtml:ul>
      <xhtml:li>quietly</xhtml:li>
    </xhtml:ul>
    <xhtml:object data="a.ole" type="text/rtf"/>
  </xhtml:div>
`;

test("DOORS-style names and XHTML are read from a .reqifz", () => {
  const archive = write_zip([["x.reqif", document(RICH, NODE("o1", NODE("o2")))], ["picture.png", "not read"]]);
  const store = new Store(":memory:", "tester");
  const result = import_reqif(store, "/", archive, "x.reqifz");
  assert.deepEqual(result.modules, ["/Pump spec"]);
  assert.equal(result.embedded_objects, 1);
  const [heading, text] = store.objects(store.module_at("/Pump spec")!);
  assert.equal(store.value(heading, "Object Heading"), "Pumping");
  // the list item is a bulleted paragraph and the bold word is bold, not "- " and plain
  assert.equal(store.value(text, "Object Text"), "The pump shall start within 2 s.\nquietly\n[embedded object]");
  assert.equal(store.rich_value(text, "Object Text"),
    "The pump {\\b shall} start within 2 s.\n\\pard{\\*\\pn\\pnlvlblt}quietly\n\\pard [embedded object]");
  assert.equal(store.value(text, "Foreign ID"), "17");
  assert.ok(store.parent_object(text)!.equals(heading));
});

function refused(data: Uint8Array | string, message: RegExp): void {
  const store = new Store(":memory:", "tester");
  assert.throws(() => import_reqif(store, "/", data, "bad.reqif"),
    (error: unknown) => error instanceof StoreError && message.test(error.message));
  assert.deepEqual([...store.walk()], []);
}

test("a DTD or entity declarations are refused, in any encoding", () => {
  const bomb = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><REQ-IF xmlns="${NS}">&a;</REQ-IF>`;
  refused(bomb, /DTD/);
  refused(new TextEncoder().encode(bomb), /DTD/);
  refused(new Uint8Array(Buffer.from("﻿" + bomb, "utf16le")), /DTD/);
  refused(write_zip([["a.reqif", bomb]]), /DTD/);
  refused(`<REQ-IF xmlns="${NS}">&a;</REQ-IF>`, /not readable XML/);
});

test("damaged and foreign files are refused and change nothing", () => {
  const good = document(RICH, NODE("o1"));
  refused(good.slice(0, 400), /not readable XML/);
  refused(good.replace("</REQ-IF>", "</REQ>"), /mismatched end tag/);
  refused("<html/>", /not a ReqIF file/);
  refused(write_zip([["a.txt", "x"]]), /holds no \.reqif/);
  refused(document(RICH, NODE("nowhere")), /names an object the file lacks/);
  const damaged = write_zip([["a.reqif", good]]);
  damaged[60] ^= 1;
  refused(damaged, /bad CRC/);
});

test("an archive that declares too much is refused before unpacking", () => {
  const archive = write_zip([["a.reqif", "<a/>"]]);
  const view = new DataView(archive.buffer);
  const directory = view.getUint32(archive.length - 22 + 16, true);
  view.setUint32(directory + 24, MAX_BYTES + 1, true);
  refused(archive, /too large to unpack/);
});

test("depth is bounded, and deep input does not overflow the stack", () => {
  const levels = MAX_DEPTH - 20;
  const deep = "<xhtml:div>".repeat(levels) + "bottom" + "</xhtml:div>".repeat(levels);
  const store = new Store(":memory:", "tester");
  import_reqif(store, "/", document(deep, NODE("o2")));
  assert.equal(store.value(store.objects(store.module_at("/Pump spec")!)[0], "Object Text"), "bottom");
  refused(document("<xhtml:b>".repeat(100000) + "</xhtml:b>".repeat(100000), NODE("o2")), /nested too deeply/);

  const chain = (n: number) => {
    let nodes = NODE("o1");
    for (let i = 1; i < n; i++) nodes = NODE("o1", nodes);
    return nodes;
  };
  const tall = new Store(":memory:", "tester");
  assert.equal(import_reqif(tall, "/", document(RICH, chain(MAX_LEVELS))).objects, MAX_LEVELS);
  const again = export_reqif(tall, [tall.module_at("/Pump spec")!]);
  assert.equal(import_reqif(new Store(":memory:", "tester"), "/", again.text).objects, MAX_LEVELS);
  refused(document(RICH, chain(MAX_LEVELS + 1)), /hierarchy is nested too deeply/);
});

test("deflated data unpacks, and never past its declared size", () => {
  const source = new TextEncoder().encode(EXAMPLE.repeat(8));
  for (const level of [0, 1, 6, 9]) {
    assert.deepEqual(_inflate(deflateRawSync(source, { level }), source.length), source);
  }
  assert.throws(() => _inflate(deflateRawSync(source), 100), /more than the archive declares/);
  assert.throws(() => _inflate(deflateRawSync(source).subarray(0, 50), source.length), /./);
});

test("the web operations carry the file as base64", () => {
  const api = new Api(example(), "demo", { names: {}, layout: {} }, new Map() as any);
  const module = api.store.module_at(SRS)!;
  const file = api.op_export_reqif({ modules: [module] });
  assert.equal(file.filename, "System Requirements.reqif");
  const made = api.op_import_reqif({ folder: "/In", filename: "x.reqif", base64_data: file.base64 });
  assert.deepEqual(made.modules, ["/In/System Requirements"]);
  assert.equal(made.objects, api.store.objects(module).length);
  assert.throws(() => api.op_import_reqif({ folder: "/In", filename: "x.reqif", base64_data: "not base64!" }),
    /did not arrive intact/);
  assert.throws(() => api.op_export_reqif({ modules: [] }), /choose a module/);
});
