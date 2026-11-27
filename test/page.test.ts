// The browser app around the operations: its static files, the worker that runs
// the operations, the page-side transport that can stop a script, and the local
// file server. Browser objects are stood in for; no real browser is involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { read_file } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCES = ["app.js", "extras.js", "menus.js", "api.ts", "transport.ts", "worker.ts", "storage.ts", "index.html", "style.css", "web.css"];

function put_global(name: string, value: unknown): () => void {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete (globalThis as any)[name];
  };
}

describe("page files", () => {
  test("database text is never parsed as markup", () => {
    for (const name of ["app.js", "extras.js", "menus.js", "transport.ts"]) {
      const script = read_file("src/web/" + name);
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(",
        "new Function", "DOMParser", "createContextualFragment"]) {
        assert.ok(!script.includes(sink), `${name}: ${sink}`);
      }
    }
  });

  test("the page works offline and may not connect anywhere", () => {
    for (const name of SOURCES) {
      assert.doesNotMatch(read_file("src/web/" + name), /(src|href)=["']https?:|@import|url\(\s*["']?https?:/, name);
    }
    const index = read_file("src/web/index.html");
    assert.match(index, /default-src 'none'/);
    assert.match(index, /connect-src 'none'/);
  });
});

test("the worker answers bad requests and carries on, and what it saves can be reopened", async (t) => {
  const posted: any[] = [];
  const self: any = { postMessage: (message: any) => posted.push(message) };
  t.after(put_global("self", self));
  t.mock.method(console, "error", () => {});
  await import("../src/web/worker.ts");
  const send = (data: any) => {
    posted.length = 0;
    self.onmessage({ data });
    return posted.at(-1);
  };
  let id = 0;
  const call = (operation: string, args: unknown = {}) => send({ type: "call", id: ++id, operation, args });

  assert.equal(send({ type: "init", snapshot: null }).type, "ready");
  for (const operation of ["nothing", "constructor", "_existing"]) {
    assert.equal(call(operation).error, "no such operation", operation);
  }
  assert.ok(call("set_values", null).error);
  assert.ok(call("tree").result.root);

  const made = call("create_item", { parent: 1, name: "Kept", kind: "folder" });
  assert.ok(made.snapshot, "a change comes back with the database to save");
  assert.equal(call("tree").snapshot, undefined);
  assert.equal(send({ type: "init", snapshot: made.snapshot }).type, "ready");
  assert.ok(call("tree").result.root.children.some((c: any) => c.name === "Kept"));
});

test("a database that cannot be written out is said to be unsaved, and the engine keeps it", async (t) => {
  const posted: any[] = [];
  const scope: any = { postMessage: (message: any) => posted.push(message) };
  t.after(put_global("self", scope));
  await import("../src/web/worker.ts?unwritable" as string);
  const { Store } = await import("../src/store.ts");
  const send = (message: any) => { scope.onmessage({ data: message }); return posted.at(-1); };
  send({ type: "init", snapshot: null });
  t.mock.method(Store.prototype, "dumps", () => { throw new RangeError("Invalid string length"); });
  t.mock.method(console, "error", () => {});
  const made = send({ type: "call", id: 1, operation: "create_item", args: { parent: 1, name: "Kept", kind: "folder" } });
  assert.equal(made.error, undefined);
  assert.equal(made.snapshot, undefined);
  assert.match(made.not_saved, /Invalid string length/);
  assert.match(send({ type: "save", id: 2 }).error, /Invalid string length/);
  const tree = send({ type: "call", id: 3, operation: "tree", args: {} });
  assert.ok(tree.result.root.children.some((c: any) => c.name === "Kept"));
});

test("a script that never ends is stopped after the time limit, and the next call works", async (t) => {
  const workers: any[] = [];
  const snapshot = { dump: "saved", database: "demo", files: [] };
  class FakeWorker {
    onmessage: ((event: { data: any }) => void) | null = null;
    onerror = null;
    terminated = false;
    started_from: unknown;
    constructor() { workers.push(this); }
    reply(data: any) { queueMicrotask(() => this.onmessage!({ data })); }
    postMessage(message: any) {
      if (message.type === "init") {
        this.started_from = message.snapshot;
        this.reply({ type: "ready", snapshot: message.snapshot ? null : snapshot });
      } else if (message.operation === "run_dxl") {
        this.reply({ type: "output", id: message.id, text: "start" }); // and then never finishes
      } else {
        this.reply({ type: "reply", id: message.id, result: "still here" });
      }
    }
    terminate() { this.terminated = true; }
  }
  const elements = new Map<string, any>();
  const window: any = {};
  // Where the Stop button is: the page, or the dialog that would otherwise block it.
  const dialogs: any[] = [];
  let holder = "page";
  t.after(put_global("window", window));
  t.after(put_global("Worker", FakeWorker));
  t.after(put_global("document", {
    addEventListener: () => {},
    getElementById: (name: string) => elements.get(name) ?? elements.set(name, {}).get(name),
    querySelectorAll: () => dialogs,
    body: { append: () => { holder = "page"; } },
  }));
  await import("../src/web/transport.ts"); // no indexedDB here: it carries on, saying nothing is saved
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const running = window.opendoorTransport("run_dxl", { source: "while (true) {}" });
  await settle();
  t.mock.timers.tick(59_999);
  assert.equal(workers[0].terminated, false);
  t.mock.timers.tick(1);
  const reply = await running;
  assert.match(reply.error.message, /more than 60 seconds and was stopped/);
  assert.equal(reply.output, "start");
  assert.equal(reply.discarded, true);
  assert.equal(workers[0].terminated, true);

  assert.equal(await window.opendoorTransport("tree", {}), "still here");
  assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].started_from, snapshot);

  // With a dialog open the button goes into it, and comes back afterwards.
  dialogs.push({ append: () => { holder = "dialog"; } });
  const again = window.opendoorTransport("run_dxl", { source: "while (true) {}" });
  await settle();
  t.mock.timers.tick(700);
  assert.equal(holder, "dialog");
  assert.equal(elements.get("stop").hidden, false);
  elements.get("stop").onclick();
  assert.match((await again).error.message, /the script was stopped/);
  assert.equal(holder, "page");
});

const built = existsSync(ROOT + "dist/index.html");

test("the local file server serves the built page and nothing else",
  { skip: !built && "the page is not built (sh src/web/build.sh)", timeout: 20000 }, async (t) => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const server = spawn(process.execPath, [ROOT + "src/cli.ts", "serve", "--port", String(port)]);
    t.after(() => { server.kill(); });
    await new Promise((resolve, reject) => {
      server.stdout.once("data", resolve);
      server.once("exit", (code) => reject(new Error(`the server exited with ${code}`)));
    });
    // http.request sends the path as written, so ".." reaches the server.
    const get = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      }).on("error", reject).end();
    });
    assert.equal((await get("/")).body, readFileSync(ROOT + "dist/index.html", "utf8"));
    for (const path of ["/app.js", "/style.css", "/worker.js"]) assert.equal((await get(path)).status, 200, path);
    for (const path of ["/../src/cli.ts", "/%2e%2e/src/cli.ts", "/..%2fREADME.md", "/../dist/../src/web/app.js",
      "/src/cli.ts", "/missing.js"]) {
      assert.equal((await get(path)).status, 404, path);
    }
  });
