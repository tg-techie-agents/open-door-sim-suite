// ++ and --, appends, forward declarations, Array, versions, enumeration
// options, code pages, plain rich text and #include.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check, DxlError, run, VirtualDisk } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";
import { REQS, TESTS, demo, dxl } from "./helpers.ts";

const prints = (source: string, expected: string, store: Store = demo()) =>
  assert.equal(dxl(store, source).printed, expected);

const refused = (source: string, message: RegExp, line?: number, store: Store = demo()) =>
  assert.throws(() => dxl(store, source), (e: unknown) => e instanceof DxlError && message.test(e.message)
    && (line === undefined || e.line === line), source);

const READ = `Module m = read("${REQS}", false)\ncurrent = m\n`;
const EDIT = `Module m = edit("${REQS}", false)\ncurrent = m\n`;

describe("++ and --", () => {
  test("before gives the new value, after the old", () => {
    prints(`int tally = 7
      int ahead = ++tally
      int behind = tally--
      print ahead ":" behind ":" tally ":" (--tally) ":" (tally++) ":" tally ""`, "8:8:7:6:6:7");
    prints(`int i = 1
      ++i
      --i
      i++
      print "n " ++i ""`, "n 3");
  });

  test("array elements, the index worked out once", () => {
    prints(`int a[3] = {5, 5, 5}
      int i = 0
      a[0]++
      ++a[1]
      a[2]--
      print a[i++]++ " " --a[i] " "
      a[i++] += 10
      print i " " a[0] " " a[1] " " a[2] ""`, "6 5 2 7 15 4");
  });

  test("what cannot be stepped is refused", () => {
    refused(`int a[2]\na[0]++`, /has no value yet/, 2);
    refused(`int a[2] = {1, 2}\na[5]++`, /out of range/, 2);
    refused(`string s = "x"\ns[0]++`, /number variable or array element/, 2);
    refused(`int a[2] = {1, 2}\nint i = 0\nint x\nx = a[i++] = 3`, /own statement/, 4);
  });
});

describe("appends in parentheses", () => {
  test("(buffer += x) is the buffer", () => {
    prints(`Buffer b = create
      (((b += "<td ") += 'x') += ">")
      (b += "a") += "b"
      if (true) (b += "c")
      print b
      print " " length((b += "d")) ""`, "<td x>abc 10");
  });

  test("only for a Buffer", () => {
    refused(`int i = 0\nint j = (i += 2)`, /only appends to a Buffer/, 2);
    refused(`string s = "a"\n(s += "b")`, /only appends to a Buffer/, 2);
    refused(`string s = "a"\ns += "b"`, /not supported for string/, 2);
  });
});

describe("stream -> buffer", () => {
  test("-> drops leading white space, >= keeps it", () => {
    const disk = new VirtualDisk();
    disk.set(`${disk.cwd}/in.txt`, "  \tone \n   \n  two");
    assert.equal(dxl(demo(), `Stream s = read("in.txt")
      Buffer b = create
      s -> b
      print "[" b "]"
      s -> b
      print "[" b "]"
      s >= b
      print "[" b "]"`, { disk }).printed, "[one ][][  two]");
  });

  test("an arrow between other things is refused, not computed", () => {
    refused("print (7 -> 2)", /incorrect arguments for \(->\)/, 1);
    refused("int a = 1\nif (a <-1) print a", /incorrect arguments for \(<-\)/, 2);
  });
});

describe("forward declarations", () => {
  test("a call may come before the body", () => {
    prints(`bool odd(int n);
      bool even(int n)
      bool even(int n) { if (n == 0) return true
        return odd(n - 1) }
      bool odd(int n) { if (n == 0) return false
        return even(n - 1) }
      print odd(7) " " even(7) ""`, "true false");
  });

  test("a body that never comes, or does not match, is refused before anything runs", () => {
    refused(`print "x"\nvoid f(int n)\n`, /f is declared but its body never comes/, 2);
    refused(`void f(int n)\nvoid f(string s) {}`, /never comes/, 1);
    refused(`void f(int n)\nint f(int n) { return n }`, /declared earlier as returning void/, 2);
    refused(`void f(int n)\nvoid f(int n)\nvoid f(int n) {}`, /already declared/, 2);
    refused(`void f(int n) {}\nvoid f(int n)`, /already declared/, 2);
    refused(`int f(int n) return n`, /expected '\{'/, 1);
  });

  test("a brace on the next line still starts the body", () => {
    prints(`int twice(int n)
      {
        return 2 * n
      }
      print twice(4) ""`, "8");
  });
});

describe("Array", () => {
  test("put, get, grow, delete", () => {
    prints(`Array grid = create(2, 3)
      put(grid, "valve", 1, 1)
      put(grid, 42, 0, 1)
      put(grid, 'z', 5, 6)
      Array child = create(1, 1)
      put(child, "leaf", 0, 0)
      put(grid, child, 2, 0)
      string part = (string get(grid, 1, 1))
      int count = (int get(grid, 0, 1))
      Array back = (Array get(grid, 2, 0))
      print part "/" count "/" (char get(grid, 5, 6)) "/" (string get(back, 0, 0)) "/"
      putString(grid, "pressure", 3, 0)
      print get(grid, 6, 0, 4)
      delete grid
      print "/" null(back) ""`, "valve/42/z/leaf/ssur/false");
  });

  test("what DOORS leaves undefined stops here", () => {
    const made = "Array a = create(2, 2)\n";
    refused(made + "print (string get(a, 0, 0))", /nothing has been put/, 2);
    refused(made + 'put(a, 1, 0, 0)\nprint (string get(a, 0, 0))', /expected a string but the value is a int/, 3);
    refused(made + 'put(a, 1, -1, 0)', /neither may be negative/, 2);
    refused(made + 'delete a\nput(a, 1, 0, 0)', /has been deleted/, 3);
    refused("Array a = create(0, 1)", /at least 1/, 1);
    refused(made + 'put(a, 1, 0, 0)\nint n = get(a, 0, 0)', /cast it/, 3);
  });
});

describe("module versions", () => {
  test("a baseline has a version string, the current module none", () => {
    const store = demo();
    const reqs = store.module_at(REQS)!;
    store.create_baseline(reqs, "first", true);
    store.create_baseline(reqs, "second", false, "draft");
    prints(`${READ}
      print "[" versionString(moduleVersion(m)) "]"
      Baseline b
      for b in m do {
        ModuleVersion v = moduleVersion(module("${REQS}"), b)
        print " " versionString(v)
        Module old = load(m, b, false)
        print " " versionString(moduleVersion(old)) " " isBaseline(v) ""
      }
      print " " versionString(moduleVersion(module("${REQS}"))) "."`,
    "[] 1.0 1.0 true 1.1(draft) 1.1(draft) true .", store);
  });

  test("echo is true only for a baseline's links outward", () => {
    const store = demo();
    store.create_baseline(store.module_at(TESTS)!, "first", true);
    prints(`Module t = read("${TESTS}", false)
      Link l
      for l in (first t)->"*" do print echo(l) " "
      Baseline b = getMostRecentBaseline(t)
      Module old = load(t, b, false)
      for l in (first old)->"*" do print echo(l) ""`, "false true", store);
  });
});

describe("multi-valued enumerations", () => {
  function store() {
    const made = demo();
    const reqs = made.module_at(REQS)!;
    made.create_type(reqs, "Rigs", "Enumeration", ["Bench", "Rover", "Flight"]);
    made.create_attribute(reqs, "Used On", "Rigs", "object", true);
    made.create_attribute(reqs, "Primary Rig", "Rigs");
    return made;
  }

  test("+= and -= add and take one option, listed in the type's order", () => {
    prints(`${EDIT}Object o = object 2
      o."Used On" += "Flight"
      o."Used On" += "Bench"
      o."Used On" += "Flight"
      print o."Used On" ";"
      o."Used On" -= "Bench"
      o."Used On" -= "Rover"
      print o."Used On" ""`, "Bench\nFlight;Flight", store());
  });

  test("refused elsewhere", () => {
    const at = `${EDIT}Object o = object 2\n`;
    refused(at + 'o."Used On" += "Submarine"', /is not one of/, 4, store());
    refused(at + 'o."Primary Rig" += "Flight"', /multi-valued/, 4, store());
    refused(at + 'o."Object Text" += "more"', /multi-valued/, 4, store());
    refused(at + 'o."Used On" *= "Flight"', /not supported on an attribute/, 4, store());
  });
});

describe("code pages", () => {
  test("write, append and read as UTF-8", () => {
    const { printed, disk } = dxl(demo(), `Stream s = write("a.txt", CP_UTF8)
      s << "café\\n"
      close s
      Stream t = append("a.txt", CP_UTF8)
      t << "two"
      close t
      Stream r = read("a.txt", CP_UTF8)
      string line
      r >> line
      print line " " readFile("a.txt", CP_UTF8)`);
    assert.equal(disk.get(`${disk.cwd}/a.txt`), "café\ntwo");
    assert.equal(printed, "café café\ntwo");
  });

  test("any other code page stops", () => {
    refused(`Stream s = write("a.txt", 1200)`, /only the CP_UTF8 code page/, 1);
  });
});

describe("rich text of plain values", () => {
  test("is the value, with no OLE", () => {
    prints(`${READ}Object o = object 2
      string s = richText(o."Object Text")
      print s " " richTextWithOle(o."Object Text") " " containsOle(o."Object Text") ""`,
    "Shall boil. Shall boil. false");
  });

  test("anything it cannot be certain of stops", () => {
    for (const value of ["a {b}", "a\\\\b", "two\\nlines", "café"]) {
      refused(`${EDIT}Object o = object 2\no."Object Text" = "${value}"\nprint richText(o."Object Text")`,
        /plain ASCII/, 5);
    }
    refused(`${EDIT}object(2)."Object Text" = richText "{\\\\b x}"`, /incorrect/, 3);
    refused("RichText rt", /rich text decomposition/, 1);
  });
});

describe("tempStringOf", () => {
  test("may be used at once", () => {
    prints(`Buffer b = "abc"
      Buffer c = tempStringOf b
      print tempStringOf b
      b = "z"
      print " " c "" (tempStringOf b) ""`, "abc abcz");
  });

  test("may not be kept", () => {
    const made = 'Buffer b = "abc"\n';
    refused(made + "string s = tempStringOf b", /may not be kept/, 2);
    refused(made + "string s\ns = (tempStringOf(b))", /may not be kept/, 3);
    refused(made + "string a[1]\na[0] = tempStringOf b", /may not be kept/, 3);
    refused(made + "string f() { return tempStringOf b }", /may not be kept/, 2);
    refused(made + "Skip s = create\nput(s, 1, tempStringOf b)", /may not be kept/, 3);
  });
});

describe("#include", () => {
  const disk = () => {
    const made = new VirtualDisk();
    made.set(`${made.cwd}/near.inc`, 'string near = "near"\n');
    made.set("/library/utils/helpers.inc", 'int double(int n)\nint double(int n) { return 2 * n }\n');
    made.set("/library/near.inc", 'string near = "far"\n');
    made.set("/library/open.inc", "void lost()\n");
    made.set("/elsewhere/secret.inc", 'string secret = "s"\n');
    return made;
  };
  const go = (source: string, include_dirs: string[], files = disk()) => {
    let printed = "";
    run(source, new Store(), { write: (s: string) => { printed += s; } }, null, ".", null, false, false, files,
      null, include_dirs);
    return printed;
  };

  test("both forms look in the --include folders", () => {
    assert.equal(go('#include <utils/helpers.inc>\nprint double(4) ""', ["/library"]), "8");
    assert.equal(go('#include "utils/helpers.inc"\nprint double(5) ""', ["/library"]), "10");
    assert.equal(go("#include <near.inc>\nprint near", []), "near");
  });

  test("a name found in two folders stops", () => {
    assert.throws(() => go("#include <near.inc>", ["/library"]), /more than one folder/);
  });

  test("the file policy still holds", () => {
    assert.throws(() => go("#include <utils/helpers.inc>", []), /No such file/);
    assert.throws(() => go('#include "/elsewhere/secret.inc"', ["/library"]), /outside the folders/);
    assert.throws(() => go("#include <../elsewhere/secret.inc>", ["/library"]), /outside the folders/);
    // the folder is open to #include, not to the script
    assert.throws(() => go('print readFile("/library/near.inc")', ["/library"]), /outside the folders/);
  });

  test("a forward declaration left open in an included file names that file", () => {
    assert.throws(() => check("#include <open.inc>", new Store(), ".", disk(), ["/library"]),
      (e: unknown) => e instanceof DxlError && e.file === "open.inc" && e.line === 1);
  });
});
