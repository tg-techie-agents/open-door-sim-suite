// error, warn, the clipboard, null for the base types, file status and getDOSstring.

import assert from "node:assert/strict";
import { test } from "node:test";

import { VirtualDisk, run } from "../src/dxl/index.ts";
import { Store } from "../src/store.ts";

const output = (source: string, disk: VirtualDisk = new VirtualDisk()): string => {
  let out = "";
  run(source, new Store(), { write: (t: string) => { out += t; } }, null, ".", null, false, false, disk);
  return out;
};

test("error shows its message and ends the script; warn carries on", () => {
  assert.equal(output('warn "low"\nprint "a\\n"\nerror "stop"\nprint "never"'), "[warn] low\na\n[error] stop\n");
});

test("copyToClipboard shows the text and answers true", () => {
  assert.equal(output('if (copyToClipboard "row") print "ok"'), "[clipboard] row\nok");
});

test("a script's own name wins over error and warn", () => {
  assert.equal(output('string error = "mine"\nint warn = 2\nprint error " " warn ""'), "mine 2");
});

test("null can be assigned to and asked of a base type", () => {
  assert.equal(output('int i = 3\ni = null\nchar c = null\nprint (null i) (null c) (null 1) (null false) ""'),
    "truetruefalsetrue");
});

test("a Stat handle says whether a path is a folder, a file or nothing", () => {
  const disk = new VirtualDisk();
  disk.set("/work/out/a.csv", "x");
  const source = ["string paths[] = {\"out\", \"out/a.csv\", \"gone\"}", "int i", "for i in 0:2 do {",
    "  Stat s = create paths[i]", "  if (null s) print \"none \"", "  else if (directory s) print \"folder \"",
    "  else if (regular s) print \"file \"", "}"].join("\n");
  assert.equal(output(source, disk), "folder file none ");
});

test("getDOSstring gives every newline one carriage return", () => {
  assert.equal(output('Buffer b = create\nb = "a\\nb\\r\\nc"\nprint stringOf(getDOSstring b)'), "a\r\nb\r\nc");
});

test("a real name used in a form that is not offered says so", () => {
  assert.throws(() => output('print(length(1, 2, 3))'), /incorrect arguments for function length .*does not offer/);
});
