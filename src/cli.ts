#!/usr/bin/env node
// The command line: `node src/cli.ts help`. Needs Node 22.18 or later; no packages.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DxlError, check, run, signatures } from "./dxl/index.ts";
import { export_module, import_csv } from "./io/csvio.ts";
import { dump_project, load_project } from "./io/project.ts";
import { decode_script, RealDisk } from "./node/disk.ts";
import { Store, StoreError } from "./store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = join(ROOT, "examples", "example-project.json");

const USAGE = `usage: node src/cli.ts <command> ...

  run SCRIPT.dxl [--db DB | --data PROJECT.json] [--open /Project/Module] [--dry-run] [--any-file] [--timeout S]
      [--include DIR]...
                       run DXL; with neither --db nor --data, on a throwaway copy of the example
  check SCRIPT.dxl... [--include DIR]...         find errors without running
                       --include: a folder #include also looks in (and may read from)
  functions [TEXT]     the DXL this engine offers
  new DB [--example]   create a database file
  ls DB [PATH]         folders, projects and modules
  show DB MODULE       a formal module with its links
  import DB FILE [--module M] [--into FOLDER]    .json (project), .csv, .reqif, .reqifz
  export DB OUT [--module M]...                  .json, .csv, .reqif
  serve [--port N]     the graphical interface, on this computer only
`;

class Problem extends Error {}

const note = (text: string) => process.stderr.write(text + "\n");
/** Stored text and script output must not drive the terminal. */
const printable = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "\ufffd");
const say = (text: string) => process.stdout.write(printable(text) + "\n");
const read_text = (path: string) => readFileSync(path, "utf8").replace(/^﻿/, "");

function read_script(path: string): string {
  const { text, ansi } = decode_script(readFileSync(path));
  if (ansi) process.stderr.write(`(${basename(path)} is not UTF-8: read as Windows-1252)\n`);
  return text.replace(/^\ufeff/, "");
}

function need(value: string | undefined, what: string): string {
  if (value === undefined) throw new Problem(`missing ${what} (see: node src/cli.ts help)`);
  return value;
}

function save(store: Store, path: string): void {
  writeFileSync(path + ".tmp", store.dumps(), "utf8");
  renameSync(path + ".tmp", path);
}

function open_db(path: string): Store {
  if (!existsSync(path)) throw new Problem(`no database at ${path}; make one with: node src/cli.ts new ${path} --example`);
  return Store.loads(readFileSync(path, "utf8"));
}

function formal(store: Store, path: string): number {
  const found = store.module_at(path);
  if (found === null) throw new Problem(`no formal module '${path}' (see: node src/cli.ts ls DB)`);
  return found;
}

/** One line from the keyboard, waiting for it. */
function ask(question: string): boolean {
  process.stdout.write(`${question} [y/N] `);
  const byte = Buffer.alloc(1);
  let line = "";
  try {
    while (readSync(0, byte, 0, 1, null) === 1 && byte[0] !== 10) line += byte.toString();
  } catch {
    // no input available: the answer is no
  }
  return line.trim().toLowerCase() === "y";
}

type Options = { [name: string]: any };

/** When to stop a script that runs on (pragma runLim is not enforced); 0 seconds: never. */
function deadline(seconds: string = "600"): number | null {
  const n = Number(seconds);
  if (!(n >= 0)) throw new Problem("--timeout takes a number of seconds");
  return n ? Date.now() + n * 1000 : null;
}

/** The folders given with --include, as full paths. */
function include_dirs(options: Options): string[] {
  return ((options.include ?? []) as string[]).map((dir) => {
    const full = resolve(dir);
    if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new Problem(`--include: no folder '${dir}'`);
    return full;
  });
}

const commands: Record<string, (args: string[], options: Options) => void | Promise<void>> = {
  help() {
    process.stdout.write(USAGE);
  },

  new([db], options) {
    need(db, "the database file");
    if (existsSync(db)) throw new Problem(`${db} already exists; choose another name`);
    const store = new Store(db);
    if (options.example) load_project(store, read_text(EXAMPLE), EXAMPLE);
    save(store, db);
    say(`created ${db}` + (options.example ? " with the example project" : ""));
  },

  run([script], options) {
    need(script, "the script");
    if (options.db && options.data) throw new Problem("give --db or --data, not both");
    let store: Store;
    if (options.db) {
      store = open_db(options.db);
    } else {
      const data = options.data ?? EXAMPLE;
      store = new Store();
      load_project(store, read_text(data), data);
      note(`(no --db: running on a temporary copy of ${basename(data)}; changes are discarded)`);
    }
    const disk = new RealDisk(process.cwd(), ROOT);
    // A script may use everything under the folder it is started in.
    if (!options["any-file"] && (disk.resolve(homedir()) + "/").startsWith(disk.cwd.replace(/\/?$/, "/"))) {
      throw new Problem("start this from a project folder: here a script could reach your whole home folder");
    }
    let result;
    try {
      result = run(read_script(script), store, { write: (s: string) => process.stdout.write(printable(s)) }, options.open, dirname(resolve(script)), ask,
        options["dry-run"] ?? false, options["any-file"] ?? false, disk, deadline(options.timeout),
        include_dirs(options));
    } catch (e) {
      // A DOORS script that fails part-way keeps what it had already done.
      if (e instanceof DxlError) {
        if (options.db && !options["dry-run"]) save(store, options.db);
        throw new Problem(`${script}: ${e}`);
      }
      throw e;
    }
    if (options.db && !options["dry-run"]) save(store, options.db);
    if (result.rolled_back) {
      note("(dry run: database changes were undone)");
    } else if (result.unsaved.length) {
      note(`note: changed without save(): ${result.unsaved.join(", ")}. `
        + "DOORS would hold these unsaved; here they are already written.");
    }
  },

  check(scripts, options) {
    need(scripts[0], "a script");
    const included = include_dirs(options);
    for (const script of scripts) {
      try {
        const warnings = check(read_script(script), new Store(), dirname(resolve(script)),
          new RealDisk(process.cwd(), ROOT), included);
        for (const w of warnings) note(printable(`${script}: ${w.file ? w.file + ", " : ""}line ${w.line}: warning: ${w.message}`));
        say(`${script}: ok`);
      } catch (e) {
        if (!(e instanceof DxlError)) throw e;
        say(`${script}: ${e}`);
        process.exitCode = 1;
      }
    }
  },

  functions([name]) {
    const lines = signatures(name ?? "");
    if (!lines.length) throw new Problem(`nothing matching '${name}': this engine does not offer it`);
    say(lines.join("\n"));
  },

  ls([db, path = "/"]) {
    const store = open_db(need(db, "the database file"));
    const start = store.find(path);
    if (start === null) throw new Problem(`nothing at '${path}'`);
    const show = (id: number, depth: number) => {
      for (const item of store.children(id)) {
        const extra = item.kind === "formal"
          ? `  [${store.objects(item.id).length} objects, ${store.baselines(item.id).length} baselines]` : "";
        say(`${"  ".repeat(depth)}${item.name}  (${item.kind})${extra}`);
        show(item.id, depth + 1);
      }
    };
    show(start, 0);
  },

  show([db, path]) {
    const store = open_db(need(db, "the database file"));
    const module = formal(store, need(path, "the module"));
    const numbers = store.numbers(module), values = store.values(module);
    for (const object of store.objects(module)) {
      const mine = values.get(object.absno);
      const text = mine?.get("Object Heading") || mine?.get("Object Text") || "";
      const outs = store.links(object, true).map((l) => store.identifier(l.target)).join(", ");
      const ins = store.links(object, false).map((l) => store.identifier(l.source)).join(", ");
      say(`${store.identifier(object).padEnd(10)} ${(numbers.get(object.absno) ?? "").padEnd(12)} ${text}`
        + (outs ? `  -> ${outs}` : "") + (ins ? `  <- ${ins}` : ""));
    }
  },

  async import([db, file], options) {
    const store = open_db(need(db, "the database file"));
    const kind = extname(need(file, "the file")).toLowerCase();
    if (kind === ".json") {
      load_project(store, read_text(file), file);
    } else if (kind === ".csv") {
      if (!options.module) throw new Problem("CSV import needs --module");
      const result: any = import_csv(store, formal(store, options.module[0]), read_text(file));
      say(`${result.created} created, ${result.updated} updated`);
      if (result.ignored_columns.length) say("columns not imported: " + result.ignored_columns.join(", "));
      if (result.blank_rows) say("blank rows skipped: " + result.blank_rows.join(", "));
    } else if (kind === ".reqif" || kind === ".reqifz" || kind === ".xml") {
      const { import_reqif } = await import("./io/reqif.ts");
      import_reqif(store, options.into ?? "/", new Uint8Array(readFileSync(file)), file);
    } else {
      throw new Problem("import takes .json (project), .csv or .reqif");
    }
    save(store, db);
    say(`imported ${file}`);
  },

  async export([db, out], options) {
    const store = open_db(need(db, "the database file"));
    const kind = extname(need(out, "the output file")).toLowerCase();
    const modules = ((options.module ?? []) as string[]).map((m) => formal(store, m));
    if (kind === ".json") {
      writeFileSync(out, dump_project(store), "utf8");
    } else if (kind === ".csv") {
      if (modules.length !== 1) throw new Problem("CSV export needs exactly one --module");
      let text = "﻿";
      export_module(store, modules[0], { write: (s: string) => { text += s; } });
      writeFileSync(out, text, "utf8");
    } else if (kind === ".reqif") {
      const { export_reqif } = await import("./io/reqif.ts");
      const chosen = modules.length ? modules : [...store.walk()].filter((i) => i.kind === "formal").map((i) => i.id);
      writeFileSync(out, export_reqif(store, chosen).text, "utf8");
    } else {
      throw new Problem("export writes .json (whole database), .csv or .reqif (not .reqifz)");
    }
    say(`wrote ${out}`);
  },

  serve(_args, options) {
    const dist = join(ROOT, "dist");
    if (!existsSync(join(dist, "index.html"))) {
      try {
        execFileSync("sh", [join(ROOT, "src", "web", "build.sh")], { stdio: "inherit" });
      } catch {
        throw new Problem("the interface is not built, and building it needs bun (https://bun.sh)");
      }
    }
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".txt": "text/plain" };
    const port = Number(options.port ?? 8765);
    const serve_file = (request: IncomingMessage, response: ServerResponse) => {
      const path = (request.url ?? "/").split("?")[0];
      const file = normalize(join(dist, path === "/" ? "index.html" : path));
      if (!file.startsWith(dist + sep) || !types[extname(file)]
        || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": types[extname(file)] + "; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'self'", "x-content-type-options": "nosniff", "x-frame-options": "SAMEORIGIN" }); // windows.html frames the app
      response.end(readFileSync(file));
    };
    const server = createServer((request, response) => {
      try {
        serve_file(request, response);
      } catch {
        // e.g. a name too long for the file system
        response.writeHead(404).end();
      }
    });
    server.on("error", (e) => {
      note(`error: ${e.message}`);
      process.exit(1);
    });
    server.listen(port, "127.0.0.1", () => say(`open http://127.0.0.1:${port}/  (Ctrl-C stops)`));
  },
};

async function main(argv: string[]): Promise<void> {
  const [name = "help", ...rest] = argv;
  const command = Object.hasOwn(commands, name) ? commands[name] : name === "-h" || name === "--help" ? commands.help : null;
  if (!command) throw new Problem(`no command '${name}' (see: node src/cli.ts help)`);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" }, data: { type: "string" }, open: { type: "string" }, into: { type: "string" },
      port: { type: "string" }, timeout: { type: "string" }, module: { type: "string", multiple: true },
      include: { type: "string", multiple: true },
      "dry-run": { type: "boolean" }, "any-file": { type: "boolean" }, example: { type: "boolean" },
    },
  });
  await command(positionals, values);
}

main(process.argv.slice(2)).catch((e) => {
  // Anything expected is one line; anything else keeps its trace.
  const expected = e instanceof Problem || e instanceof StoreError || e instanceof DxlError || e?.code;
  note(`error: ${expected ? e.message : e?.stack ?? e}`);
  process.exitCode = 1;
});
