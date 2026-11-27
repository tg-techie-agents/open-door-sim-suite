// A script saved on Windows is often Windows-1252, not UTF-8.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decode_script, RealDisk } from "../src/node/disk.ts";

const bytes = Uint8Array.from([0x93, 0x63, 0x61, 0x66, 0xe9, 0x94, 0x20, 0x80]); // quoted "caf\u00e9", euro

test("a script that is not UTF-8 is read as Windows-1252", () => {
  assert.deepEqual(decode_script(bytes), { text: "\u201ccaf\u00e9\u201d \u20ac", ansi: true });
  assert.deepEqual(decode_script(new TextEncoder().encode("caf\u00e9")), { text: "caf\u00e9", ansi: false });
});

test("an included file is read the same way; a data file's bytes are not reread", () => {
  const folder = mkdtempSync(join(tmpdir(), "enc-"));
  try {
    const path = join(folder, "a.inc");
    writeFileSync(path, bytes);
    const disk = new RealDisk(folder, folder);
    assert.equal(disk.source(path), "\u201ccaf\u00e9\u201d \u20ac");
    assert.ok(disk.get(path)!.includes("\ufffd"));
  } finally {
    rmSync(folder, { recursive: true });
  }
});
