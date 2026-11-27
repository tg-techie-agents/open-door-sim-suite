// Lets `node --test test/` run every *.test.ts here. Under a bare `node --test`,
// which finds those files by itself, this one does nothing.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  for (const name of readdirSync(new URL(".", import.meta.url)).sort()) {
    if (name.endsWith(".test.ts")) await import("./" + name);
  }
}
import "./reqif.test.ts";
import "./dxl-views.test.ts";
