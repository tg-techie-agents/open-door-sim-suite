// What a script may reach on a real disk.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/dxl/index.ts";
import { RealDisk } from "../src/node/disk.ts";
import { Store } from "../src/store.ts";

function folder() {
  const base = mkdtempSync(join(tmpdir(), "dxl-test-"));
  mkdirSync(join(base, "in"));
  mkdirSync(join(base, "out"));
  const inside = join(base, "in");
  symlinkSync("../out", join(inside, "dir"));
  symlinkSync("../out/new.csv", join(inside, "dangling.csv"));
  return { base, inside };
}

function script(inside: string, source: string): string {
  let out = "";
  run(source, new Store(), { write: (s: string) => { out += s; } }, undefined, inside, undefined, false, false,
    new RealDisk(inside, join(inside, "program")));
  return out;
}

const writing = (path: string) => `Stream s = write("${path}"); s << "x"; close s`;

test("a data file in the working folder can be written", () => {
  const { inside } = folder();
  script(inside, writing("a.csv"));
  assert.ok(existsSync(join(inside, "a.csv")));
});

test("nothing outside it can, by any route", () => {
  const { base, inside } = folder();
  for (const path of ["../out/a.csv", "dir/a.csv", "dangling.csv", ".profile", "a.sh"]) {
    assert.throws(() => script(inside, writing(path)), /may not write/, path);
  }
  for (const name of ["a.csv", "new.csv"]) assert.ok(!existsSync(join(base, "out", name)), name);
});

test("hidden folders are closed, both ways", () => {
  const { inside } = folder();
  mkdirSync(join(inside, ".hidden"));
  assert.throws(() => script(inside, writing(".hidden/a.json")), /may not write/);
  assert.throws(() => script(inside, 'print readFile(".hidden/a.json")'), /may read/);
});

test("a Windows-style path inside the folder works", () => {
  const { inside } = folder();
  mkdirSync(join(inside, "sub"));
  script(inside, writing("sub\\\\a.csv"));
  assert.ok(existsSync(join(inside, "sub", "a.csv")));
});

test("appending, copying and renaming leave other encodings as they were", () => {
  const { inside } = folder();
  writeFileSync(join(inside, "a.txt"), Buffer.from([0x63, 0xe9, 0x0a]));
  script(inside, 'canOpenFile("a.txt", true)\ncopyFile("a.txt", "b.txt")\nrenameFile("b.txt", "c.txt")');
  for (const name of ["a.txt", "c.txt"]) assert.deepEqual([...readFileSync(join(inside, name))], [0x63, 0xe9, 0x0a]);
});
