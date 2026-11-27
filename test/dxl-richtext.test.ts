// Rich text: the markup, the DXL that reads and writes it, and where the
// formatting is kept.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError } from "../src/dxl/index.ts";
import { export_module, import_csv } from "../src/io/csvio.ts";
import { dump_project, load_project } from "../src/io/project.ts";
import { export_reqif, import_reqif } from "../src/io/reqif.ts";
import { RichError, markup_of, parse, plain_of } from "../src/rich.ts";
import { Obj, Store } from "../src/store.ts";
import { REQS, demo, dxl } from "./helpers.ts";

const EDIT = `Module m = edit("${REQS}", false)\ncurrent = m\nObject o = object 2\n`;
const MIXED = "{\\b The pump is fil{\\i ling and warm}}";
// the same, as a DXL string literal
const LITERAL = JSON.stringify(MIXED);

const prints = (source: string, expected: string, store: Store = demo()) =>
  assert.equal(dxl(store, EDIT + source).printed, expected);

const refused = (source: string, message: RegExp, line?: number, store: Store = demo()) =>
  assert.throws(() => dxl(store, EDIT + source), (e: unknown) => e instanceof DxlError && message.test(e.message)
    && (line === undefined || e.line === line + 3), source);

const second = (store: Store) => new Obj(store.find(REQS)!, 2);

describe("markup", () => {
  test("reads back as it was written", () => {
    for (const markup of [MIXED, "plain \\{ \\\\ \\}", "{\\b {\\i x}} y", "H{\\sub 2}O and x{\\super 2}",
      "{\\ul a{\\strike b}}", "top\n\\pard{\\*\\pn\\pnlvlblt}\\li360 one\ntwo\n\\pard after"]) {
      assert.equal(markup_of(parse(markup)), markup);
    }
  });

  test("takes the other documented spellings", () => {
    const doc = parse("\\b bold\\b0  not\\par {\\pntext\\'B7\\tab}{\\*\\pn\\pnlvlblt{\\pntxtb\\'B7}}\\fi-360\\li720 item");
    assert.equal(plain_of(doc), "bold not\nitem");
    assert.deepEqual([doc[1].bullet, doc[1].indent], [true, 720]);
  });

  test("refuses what it does not understand", () => {
    for (const markup of ["\\cf1 x", "{\\fonttbl x}", "\\'e9", "{\\*\\other x}", "a\\", "{\\b x", "x}",
      "a\\par\nb", "\\b1 x"]) {
      assert.throws(() => parse(markup), (e: unknown) => e instanceof RichError && /not supported/.test(e.message),
        markup);
    }
  });
});

describe("assigning rich text", () => {
  test("keeps the formatting and shows the plain text", () => {
    prints(`o."Object Text" = richText ${LITERAL}
      print o."Object Text" "|" richText(o."Object Text") ""`, `The pump is filling and warm|${MIXED}`);
  });

  test("without richText the markup is only text", () => {
    prints(`o."Object Heading" = "{\\\\b x}"
      print o."Object Heading" "|" richText o."Object Heading" ""`, "{\\b x}|\\{\\\\b x\\}");
  });

  test("a plain assignment takes the formatting away, even of the same text", () => {
    const store = demo();
    prints(`o."Object Text" = richText "{\\\\b same}"
      o."Object Text" = "same"
      print richText o."Object Text" ""`, "same", store);
    assert.equal(store.formatting(second(store), "Object Text"), null);
  });

  test("copies from one attribute to another", () => {
    prints(`o."Object Text" = richText "{\\\\i x}"
      o."Object Heading" = richText(o."Object Text")
      o."Object Short Text" = richText(o."Object Text", false)
      string kept = richText o."Object Heading"
      print kept richText(o."Object Short Text") ""`, "{\\i x}{\\i x}");
  });

  test("formatting alone is a change, with a history record", () => {
    const store = demo();
    const before = store.history(second(store).module_id).length;
    prints(`o."Object Text" = richText "{\\\\b Shall boil.}"
      o."Object Text" = richText "{\\\\b Shall boil.}"`, "", store);
    assert.equal(store.history(second(store).module_id).length, before + 1);
    assert.equal(store.value(second(store), "Object Text"), "Shall boil.");
  });

  test("on a number it stops", () => {
    const store = demo();
    store.create_attribute(store.find(REQS)!, "Count", "Integer");
    refused('o."Count" = richText "{\\\\b 1}"', /not supported/, 1, store);
    prints('o."Count" = richText "7"\nprint o."Count" ""', "7", store);
  });

  test("beside other text on the right it stops", () => {
    refused('o."Object Text" = richText "a" "b"', /not documented/, 1);
    refused('o."Object Text" = "a " richText(o."Object Heading")', /not documented/, 1);
  });

  test("markup that is not understood stops", () => {
    refused('o."Object Text" = richText "{\\\\cf1 x}"', /not supported/, 1);
    refused('o."Object Text" = richText "{\\\\b x"', /not supported/, 1);
  });

  test("in a module attribute formatting stops", () => {
    const store = demo();
    store.create_attribute(store.find(REQS)!, "Owner", "String", "module");
    refused('m."Owner" = richText "{\\\\b x}"', /not supported/, 1, store);
    prints('m."Owner" = richText "x\\\\{"\nprint m."Owner" ""', "x{", store);
  });

  test("richText before more text means richText of the first only", () => {
    prints('print richText o."Object Text" "!"', "Shall boil.!");
    prints('string s = richText o."Object Text" ""\nprint s', "Shall boil.");
  });
});

describe("loops", () => {
  const SET = `o."Object Text" = richText "{\\\\b Bold} and\\n\\\\pard{\\\\*\\\\pn\\\\pnlvlblt}\\\\li360 {\\\\i item}"
    string s = richText o."Object Text"
`;

  test("over chunks", () => {
    prints(SET + `RichText rt
      for rt in s do print "[" rt.text "|" rt.bold " " rt.italic " " rt.newline " " rt.last " " rt.indentLevel "]"`,
    "[Bold|true false false false 0][ and|false false true false 0][item|false true false true 360]");
  });

  test("over paragraphs and the chunks of each", () => {
    prints(SET + `RichTextParagraph rp
      RichText rt
      for rp in s do {
        print rp.text ":" rp.isBullet ":" rp.bulletStyle ":" rp.indentLevel ""
        for rt in rp do print "<" rt.text ">"
        print ";"
      }`, "Bold and:false:0:0<Bold>< and>;item:true:1:360<item>;");
  });

  test("an empty line is a chunk with a newline, and a final newline adds none", () => {
    prints(`RichText rt
      for rt in "a\\n\\nb\\n" do print "[" rt.text " " rt.newline "]"`, "[a true][ true][b true]");
  });

  test("over an attribute itself, or what cannot be answered, stops", () => {
    refused('RichText rt\nfor rt in o."Object Text" do print rt.text', /not documented/, 2);
    refused('RichText rt\nfor rt in "x" do print rt.charset ""', /not supported/, 2);
    refused('RichText rt\nfor rt in "see http://a.test" do print rt.isUrl ""', /not documented/, 2);
  });
});

describe("functions on markup", () => {
  test("find and replace count in the markup, cut in the shown text", () => {
    prints(`string s = ${LITERAL}
      int at, size
      print findRichText(s, "FILL", at, size, false) " " at " " size "\\n"
      print replaceRichText(s, at, size, "SEAL") "\\n"
      print cutRichText("{\\\\b abcdefg}", 1, 3) ""`,
    "true 16 8\n{\\b The pump is SEA{\\i Ling and warm}}\n{\\b aefg}");
  });

  test("isRichText, removeUnlistedRichText and richText of a string", () => {
    prints(`print isRichText("{\\\\i ok}") " " isRichText("{\\\\b unclosed") "\\n"
      print removeUnlistedRichText("{\\\\i \\\\mystery slanted words}") "\\n"
      print richText("{ \\\\gauge }") ""`, "true false\n{\\i slanted words}\n\\{ \\\\gauge \\}");
  });

  test("applyTextFormattingToParagraph sets bullets and indent", () => {
    const store = demo();
    prints(`o."Object Text" = "one\\ntwo"
      string s = richText o."Object Text"
      o."Object Text" = richText(applyTextFormattingToParagraph(s, true, 360, 2))`, "", store);
    assert.deepEqual(parse(store.formatting(second(store), "Object Text")!).map((p) => [p.bullet, p.indent]),
      [[false, 0], [true, 360]]);
    refused('print applyTextFormattingToParagraph("x", true, 100, 0)', /not documented/, 1);
  });

  test("replacing across a change of formatting with another length stops", () => {
    refused(`print replaceRichText(${LITERAL}, 16, 8, "strong")`, /not documented/, 1);
  });
});

describe("keeping formatting", () => {
  const formatted = () => {
    const store = demo();
    store.set_rich(second(store), "Object Text", "{\\b Shall} boil.");
    return store;
  };

  test("saved databases keep it, and older ones load", () => {
    const store = formatted();
    const again = Store.loads(store.dumps());
    assert.equal(again.rich_value(second(again), "Object Text"), "{\\b Shall} boil.");
    assert.ok(!demo().dumps().includes('"rich"'));
  });

  test("baselines keep it as it was", () => {
    const store = formatted();
    const copy = store.create_baseline(store.find(REQS)!, "one").copy_id;
    store.set_value(second(store), "Object Text", "new");
    assert.equal(store.rich_value(new Obj(copy, 2), "Object Text"), "{\\b Shall} boil.");
  });

  test("a failed transaction undoes it", () => {
    const store = formatted();
    assert.throws(() => store.transaction(() => {
      store.set_value(second(store), "Object Text", "gone");
      throw new Error("stop");
    }));
    assert.equal(store.rich_value(second(store), "Object Text"), "{\\b Shall} boil.");
  });

  test("renaming an attribute takes it along, and a type that has none drops it", () => {
    const store = demo();
    const module = store.find(REQS)!;
    store.create_attribute(module, "Note", "Text");
    store.set_rich(second(store), "Note", "{\\i 12}");
    store.modify_attribute(module, "Note", { name: "Remark" });
    assert.equal(store.rich_value(second(store), "Remark"), "{\\i 12}");
    store.modify_attribute(module, "Remark", { type_name: "Integer" });
    assert.equal(store.formatting(second(store), "Remark"), null);
  });
});

describe("files that carry formatting", () => {
  const TEXT = "plain {\\b bold {\\i both}} {\\ul u}{\\strike s} H{\\sub 2}{\\super x}\n"
    + "\\pard{\\*\\pn\\pnlvlblt}one\n\\pard{\\*\\pn\\pnlvlblt}\\li360 two\n\\pard after\n\nlast";
  const source = () => {
    const store = demo();
    store.set_rich(second(store), "Object Text", TEXT);
    store.set_rich(second(store), "Object Heading", "{\\i head}");
    return store;
  };
  const same = (store: Store, path: string = REQS) => {
    const obj = new Obj(store.find(path)!, 2);
    assert.equal(store.rich_value(obj, "Object Text"), markup_of(parse(TEXT)));
    assert.equal(store.rich_value(obj, "Object Heading"), "{\\i head}");
  };

  test("project files, baselines too", () => {
    const store = source();
    store.create_baseline(store.find(REQS)!, "one");
    store.set_value(second(store), "Object Text", "now plain");
    const again = new Store(":memory:", "tester");
    load_project(again, dump_project(store));
    const [baseline] = again.baselines(again.find(REQS)!);
    assert.equal(again.rich_value(new Obj(baseline.copy_id, 2), "Object Text"), markup_of(parse(TEXT)));
    assert.equal(again.formatting(second(again), "Object Text"), null);
    const current = new Store(":memory:", "tester");
    load_project(current, dump_project(source()));
    same(current);
  });

  test("ReqIF", () => {
    const store = source();
    const made = export_reqif(store, [store.find(REQS)!]).text;
    const again = new Store(":memory:", "tester");
    import_reqif(again, "/", made, "made.reqif");
    const imported = REQS.slice(REQS.lastIndexOf("/"));
    same(again, imported);
    assert.equal(again.attribute(again.find(imported)!, "Object Heading")!.base, "String");
  });

  test("ReqIF writes a formatted String attribute so that it comes back a String", () => {
    const store = demo();
    const module = store.find(REQS)!;
    store.create_attribute(module, "Note", "String");
    store.set_rich(second(store), "Note", "{\\b n}");
    const again = new Store(":memory:", "tester");
    import_reqif(again, "/", export_reqif(store, [module]).text, "made.reqif");
    const imported = again.find(REQS.slice(REQS.lastIndexOf("/")))!;
    assert.equal(again.attribute(imported, "Note")!.base, "String");
    assert.equal(again.rich_value(new Obj(imported, 2), "Note"), "{\\b n}");
  });

  test("a CSV update that leaves a value as it is leaves its formatting", () => {
    const store = source();
    const module = store.find(REQS)!;
    let csv = "";
    export_module(store, module, { write: (s: string) => { csv += s; } });
    import_csv(store, module, csv);
    same(store);
  });
});
