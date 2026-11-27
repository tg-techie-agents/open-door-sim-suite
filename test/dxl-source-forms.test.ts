// Ways of writing DXL that real scripts use, and the few builtins that came with them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DxlError } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";
import { demo, dxl } from "./helpers.ts";

const prints = (source: string, expected: string, store: Store = demo()) =>
  assert.equal(dxl(store, source).printed, expected);

const refused = (source: string, message: RegExp, line?: number) =>
  assert.throws(() => dxl(demo(), source), (e: unknown) => e instanceof DxlError && message.test(e.message)
    && (line === undefined || e.line === line), source);

describe("an empty statement as a body", () => {
  test("what follows `if (x) ;` is not part of the if", () => {
    prints(`bool wet = false\nif (wet) ;\nprint "always"`, "always");
    prints(`int n = 0\nwhile (++n < 3) ;\nprint n ""`, "3");
    prints(`int i\nfor (i = 0; i < 4; i++);\nprint i ""`, "4");
  });

  test("with an else", () => {
    prints(`if (1 == 2) ; // nothing to do\nelse {\n print "other"\n}`, "other");
    prints(`if (1 == 1) print "yes" else ;\nprint "."`, "yes.");
  });
});

describe("literals", () => {
  test("a string may run over lines, with either line ending", () => {
    prints(`print "one\ntwo" ""`, "one\ntwo");
    prints(`print "one\r\ntwo" ""\r\n`, "one\ntwo");
    refused(`print "a\nb"\nint n = "x"`, /expected int/, 3);
  });

  test("a string never closed, or broken by a backslash, is refused", () => {
    refused(`int n = 1\nprint "open`, /never closed/, 2);
    refused(`print "half \\\nrest"`, /never closed|cannot read/, 1);
  });

  test("a character may be written in octal", () => {
    prints(`char a = '\\101'\nchar b = '\\12'\nprint a "" b "|"`, "A\n|");
  });
});

describe("spacing", () => {
  test("an index or ++ may stand apart from its name", () => {
    prints(`int a[3] = {4, 5, 6}\nint i = 0\ni ++\nif (true) { i ++}\nprint a [i] " " i ""`, "6 2");
    prints(`int i = 0\nfor (i = 0; i < 3; i ++) {}\nprint i ""`, "3");
  });

  test("a line ending in ? : . or ~ goes on", () => {
    prints(`int n = 3\nstring s = n > 2 ?\n "big" :\n "small"\nprint s " " (~\n n) ""`, "big -4");
  });
});

describe("minimum and maximum", () => {
  test("<? and >? of two ints", () => {
    prints(`int a = 7\nint low = a <? 3\nint high = a >? 3\nprint low " " high " " (-a <? 2) ""`, "3 7 -7");
  });

  test("beside another operator they need parentheses", () => {
    refused(`int i = 1\nint n = i + 1 <? 10`, /put parentheses/, 2);
    refused(`int n = 1 <? 2 >? 3`, /put parentheses/, 1);
    refused(`int n = 1 <? 2 == 1`, /put parentheses/, 1);
    prints(`int i = 1\nprint ((i + 1) <? 10) ""`, "2");
    refused(`real r = 1.0 <? 2.0`, /incorrect arguments/, 1);
  });
});

test("f(void) takes nothing", () => {
  prints(`void hello(void)\nvoid hello(void) { print "hi" }\nhello()`, "hi");
});

describe("current Project", () => {
  test("a Project variable takes the project the current folder is in", () => {
    prints(`Folder f = create("/Demo/Inner", "")\ncurrent = folder "/Demo/Inner"
      Project p = current\nProject q\nq = current
      print name(p) " " name(q) " " name(current Project) ""`, "Demo Demo Demo");
  });

  test("outside any project it is null", () => {
    prints(`current = folder "/"\nProject p = current\nprint (null p) " " (null current Project) ""`, "true true");
  });
});

describe("itemFromID, goodFileName, isBatch", () => {
  test("itemFromID finds what uniqueID named", () => {
    prints(`Item it = item "/Demo/Test Cases"\nstring id = uniqueID(it)
      Item again = itemFromID(id)\nprint name(again) " " (null itemFromID("nonsense")) " " (null itemFromID("ffffffff")) ""`,
    "Test Cases true true");
  });

  test("a deleted item is refused, not guessed", () => {
    refused(`Folder f = create("/Demo/Gone", "")\nItem it = item "/Demo/Gone"\nstring id = uniqueID(it)
      string err = delete(it)\nItem back = itemFromID(id)`, /deleted item/, 5);
  });

  test("goodFileName changes spaces and refuses what is not documented", () => {
    prints(`print goodFileName("Trial run 2") ""`, "Trial_run_2");
    refused(`string s = goodFileName("a/b")`, /not documented/, 1);
    refused(`string s = goodFileName("a.txt")`, /not documented/, 1);
  });

  test("this is not a batch run", () => {
    prints(`print isBatch() ""`, "false");
  });
});
