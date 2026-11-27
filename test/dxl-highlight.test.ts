// The DXL colours in the DXL window (src/web/highlight.js): its word lists must match the
// engine's, its lexer must split every line of every script into exactly that line's text,
// and the page files must keep to the rules the page keeps (no markup parsed, no style attributes).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, test } from "node:test";
import { NAME_GROUPS } from "../src/dxl/dxl-names.ts";
import { RESERVED, TYPES } from "../src/dxl/syntax.ts";
import { read_file } from "./helpers.ts";

const sandbox: any = {};
runInNewContext(read_file("src/web/highlight.js"), sandbox);
const H = sandbox.DxlHighlight;
const words = (set: Iterable<string>) => new Set(Array.from(set));

// The text of a lexed line, and the classes it used: [code, text] pairs joined back into the line.
function lex(line: string, enter = 0) {
  const r = H.lexLine(line, enter);
  const parts: string[] = [];
  for (let i = 0; i < r.parts.length; i += 2) parts.push(r.parts[i] + ":" + r.parts[i + 1]);
  const text = r.parts.filter((_: string, i: number) => i % 2 === 1).join("");
  return { text, parts, exit: r.exit };
}
const coloured = (line: string, enter = 0) => {
  const r = H.lexLine(line, enter);
  const out: Record<string, string> = {};
  for (let i = 0; i < r.parts.length; i += 2) if (r.parts[i]) out[r.parts[i + 1]] = r.parts[i];
  return out;
};

describe("DXL colours: word lists", () => {
  const types = words([...TYPES, ...NAME_GROUPS.flatMap((g) => g.types.split(" ")).filter(Boolean)]);
  const groupNames = NAME_GROUPS.flatMap((g) => [...g.functions.split(" "), ...g.constants.split(" ")])
    .filter((n) => n && n !== "nl");
  const keywords = words(H.lists.keywords);

  test("types are the engine's type names", () => {
    assert.deepEqual(words(H.lists.types), types);
  });

  test("keywords are the engine's reserved words that are not types, plus true and false", () => {
    const expected = new Set([...RESERVED].filter((w) => !TYPES.has(w)));
    for (const w of expected) assert.ok(keywords.has(w), w);
    // the language table in unavailable.ts holds the words the engine calls keywords and does not export
    const language = new Set(read_file("src/dxl/unavailable.ts").split(/\W+/));
    for (const w of keywords) {
      if (w === "true" || w === "false") continue;
      assert.ok(expected.has(w) || language.has(w), `not a DXL keyword in the engine: ${w}`);
    }
  });

  test("every name the engine knows as a function or constant is coloured as a built-in or a type", () => {
    for (const name of groupNames) {
      if (keywords.has(name) || types.has(name)) continue;
      assert.ok(H.lists.builtins.has(name), name);
    }
    for (const name of H.lists.builtins) {
      assert.ok(groupNames.includes(name) || name === "pi", name);
    }
  });

  test("a word gets one colour: keyword before type before built-in", () => {
    assert.equal(coloured("int x").int, "ty");
    assert.equal(coloured("for x").for, "kw");
    assert.equal(coloured("print x").print, "bi");
    assert.equal(coloured("true").true, "kw");
  });
});

describe("DXL colours: lexing", () => {
  test("comments run to the end of the line, and a // in a string is not a comment", () => {
    assert.equal(coloured('print "a//b" // note')["// note"], "cm");
    assert.equal(lex('print "a//b"').text, 'print "a//b"');
    assert.equal(coloured('print "a//b"')['"a//b"'], "st");
  });

  test("a block comment and a string can run over lines", () => {
    const first = lex("/* open");
    assert.equal(first.exit, 1);
    const second = lex("still */ int x", 1);
    assert.equal(second.exit, 0);
    assert.equal(coloured("still */ int x", 1)["still */"], "cm");
    assert.equal(lex('string s = "open', 0).exit, 2);
    assert.equal(lex("more\" + 1", 2).exit, 0);
    assert.equal(coloured("more\" + 1", 2)['more"'], "st");
  });

  test("escaped quotes do not end a string", () => {
    assert.equal(coloured('"a\\"b"')['"a\\"b"'], "st");
  });

  test("character literals, numbers and preprocessor lines", () => {
    assert.equal(coloured("'\\n'")["'\\n'"], "ch");
    assert.equal(coloured("0x1F")["0x1F"], "nu");
    assert.equal(coloured("2.5e3")["2.5e3"], "nu");
    assert.equal(coloured("x = .5")[".5"], "nu");
    assert.equal(coloured("1..2")["1"], "nu");
    assert.equal(coloured("#pragma getallreferences ignore")["#pragma getallreferences ignore"], "pp");
  });

  test("a name ending in a quote is one name, and an empty line still has a line box", () => {
    assert.equal(lex("name'x").text, "name'x");
    assert.equal(H.lexLine("", 0).parts.length, 0);
  });
});

describe("DXL colours: every line of every script keeps its text", () => {
  const files = [
    ...readdirSync("scripts").filter((f) => f.endsWith(".dxl")).map((f) => "scripts/" + f),
    ...readdirSync("scripts/layout").filter((f) => f.endsWith(".dxl")).map((f) => "scripts/layout/" + f),
  ];
  for (const file of files) {
    test(file, () => {
      let state = 0;
      for (const line of read_file(file).replace(/^﻿/, "").split("\n")) {
        const r = lex(line, state);
        assert.equal(r.text, line.length ? line : "", `${file}: ${JSON.stringify(line)}`);
        state = r.exit;
      }
    });
  }
});

describe("DXL colours: page files", () => {
  test("highlight.js builds nodes only, never parses markup or sets style attributes", () => {
    const src = read_file("src/web/highlight.js");
    assert.doesNotMatch(src, /setAttribute\(\s*["']style/);
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(",
      "new Function", "DOMParser", "createContextualFragment", "cssText"]) {
      assert.ok(!src.includes(sink), sink);
    }
  });

  test("highlight.css loads nothing and has no inline style", () => {
    const css = read_file("src/web/highlight.css");
    assert.doesNotMatch(css, /@import|url\(|https?:/);
  });

  test("index.html and build.sh name the new files", () => {
    assert.match(read_file("src/web/index.html"), /<link rel="stylesheet" href="highlight\.css">/);
    assert.match(read_file("src/web/index.html"), /<script src="highlight\.js"><\/script>/);
    assert.match(read_file("src/web/build.sh"), /src\/web\/highlight\.js/);
    assert.match(read_file("src/web/build.sh"), /src\/web\/highlight\.css/);
  });
});
