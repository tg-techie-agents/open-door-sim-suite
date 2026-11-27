// The page's side of the engine: app.js calls window.opendoorTransport, which
// passes each operation to the worker, one at a time, and saves what changed.
// Loaded before app.js; the menus it adds use app.js's own helpers.

import * as boxes from "./dialogs.ts";
import { desktop, entered } from "./host.ts";
import type { Host } from "./host.ts";
import { current_key, delete_database, list_databases, new_key, read_database, read_saved, use_database,
  write_saved } from "./storage.ts";
import type { Snapshot } from "./storage.ts";

// app.js's globals.
declare const S: any;
declare const DXL: any;
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function say(text: string, isError?: boolean): void;
declare function act(work: () => unknown): Promise<void>;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function download(filename: string, data: string, type: string): void;
declare function resetView(): void;
declare function loadTree(): Promise<void>;
declare function renderTree(): void;
declare function render(): void;

const SCRIPT_SECONDS = 60;
const TIMED = new Set(["run_dxl", "dxl_event", "dxl_column"]); // each event has the whole limit

type Pending = { id: number; output: string; resolve: (reply: any) => void; stop: (why: string) => void };

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let last: Snapshot | null = null; // what a new worker starts from
let kept = false; // this browser holds a database of the person's own
let unsaved = false; // the open database has changes only this page holds
let pending: Pending | null = null;
let queue: Promise<unknown> = Promise.resolve();
let next_id = 1;
let writes = 0; // snapshots kept: how windows.html knows that something changed

// In a window of windows.html the engine and its storage belong to the top page (shell.js).
const shell: any = (() => {
  try {
    return globalThis.window?.parent === globalThis.window ? null : (window.parent as any).opendoorShell ?? null;
  } catch {
    return null;
  }
})();

const element = (id: string) => document.getElementById(id)!;
const stop_button = element("stop"); // kept here: it moves between the page and dialogs

function storage_problem(e: any): void {
  unsaved = true;
  const box = element("storage-problem");
  box.textContent = "Changes are NOT being saved in this browser: " + (e?.message || e?.name || e) // some have no message
    + ". Use Desktop, Save to file.";
  box.hidden = false;
}

async function keep(snapshot: Snapshot, replace = false): Promise<void> {
  last = snapshot;
  kept = true;
  writes++;
  try {
    await write_saved(snapshot, replace);
    unsaved = false;
    element("storage-problem").hidden = true;
  } catch (e) {
    storage_problem(e);
  }
}

function discard_worker(): void {
  boxes.clear(); // the script behind any open dialog box goes with the worker
  worker?.terminate();
  worker = null;
  ready = null;
}

function start_worker(snapshot: Snapshot | null, empty: string | null = null,
  demo = "demo"): Promise<Snapshot | null> {
  worker?.terminate();
  const made = new Worker("worker.js");
  worker = made;
  return new Promise((resolve, reject) => {
    const fail = (message: string) => {
      if (worker === made) discard_worker();
      reject(new Error(message));
    };
    made.onerror = (event) => {
      event.preventDefault();
      const why = "the engine stopped: " + (event.message || "it could not be loaded");
      if (pending) pending.stop(why);
      else fail(why);
    };
    made.onmessage = ({ data }) => {
      if (data.type === "ready") resolve(data.snapshot);
      else if (data.type === "init_error") fail(data.message);
      else if (!pending || data.id !== pending.id) return;
      else if (data.type === "output") pending.output += data.text;
      else if (data.type === "progress") boxes.progress(data.progress);
      else pending.resolve(data);
    };
    made.postMessage({ type: "init", snapshot, empty, demo });
  });
}

async function boot(): Promise<void> {
  if (!last) {
    try {
      last = await read_saved();
    } catch (e) {
      storage_problem(e);
    }
  }
  const saved = last;
  if (saved) kept = true;
  try {
    const fresh = await start_worker(saved, null, saved ? undefined : await free_name("demo").catch(() => "demo"));
    // The untouched demo is not saved: nothing of the person's is in it yet.
    if (fresh) last = fresh;
  } catch (e: any) {
    if (!saved) throw e;
    // Keep what is saved: never overwrite it with the example unasked.
    throw new Error(`The saved database could not be opened (${e.message}). `
      + "It is on the Desktop, where you can delete it.");
  }
}

// A running worker that has the database, starting one if need be.
function engine(): Promise<void> {
  if (!ready) {
    const starting = boot();
    ready = starting;
    starting.catch(() => { if (ready === starting) ready = null; });
  }
  return ready;
}

// One message to the worker, and its reply. Rejects if the worker had to be stopped.
function send(message: any, limit: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = next_id++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let button_timer: ReturnType<typeof setTimeout> | undefined;
    const button = stop_button;
    const done = () => {
      boxes.progress(null);
      clearTimeout(timer);
      clearTimeout(button_timer);
      button.hidden = true;
      button.onclick = null;
      document.body.append(button);
      pending = null;
    };
    const mine: Pending = {
      id, output: "",
      resolve: (reply) => { done(); resolve(reply); },
      stop: (why) => {
        done();
        discard_worker(); // the next call starts a new one from the last saved database
        reject(Object.assign(new Error(why), { stopped: true, output: mine.output }));
      },
    };
    pending = mine;
    if (limit) {
      timer = setTimeout(() => mine.stop(`the script ran for more than ${SCRIPT_SECONDS} seconds and was stopped`),
        SCRIPT_SECONDS * 1000);
      button_timer = setTimeout(() => {
        // An open dialog makes everything outside it unclickable, so the button goes inside.
        const open = document.querySelectorAll("dialog[open]");
        (open.length ? open[open.length - 1] : document.body).append(button);
        button.hidden = false;
        button.onclick = () => mine.stop("the script was stopped");
      }, 700);
    }
    worker!.postMessage({ ...message, id });
  });
}

async function perform(operation: string, args: any): Promise<any> {
  if (shell) {
    try {
      return JSON.parse(await shell.perform(window, operation, JSON.stringify(args)));
    } catch (e: any) {
      throw new Error(e.message); // an Error of this window, not the top page's
    }
  }
  await engine();
  let reply: any;
  try {
    reply = await send({ type: "call", operation, args }, TIMED.has(operation));
  } catch (e: any) {
    if (!e.stopped || !TIMED.has(operation)) throw e;
    const error = { line: 0, file: null, message: e.message + "; none of its database changes or files were kept" };
    return operation === "dxl_column" ? { error, output: "", cells: {} }
      : { error, output: e.output, unsaved: [], rolled_back: Boolean(args.dry_run), discarded: true, files: [],
        dialogs: null };
  }
  if (reply.snapshot) await keep(reply.snapshot);
  if (reply.not_saved) storage_problem(new Error(reply.not_saved));
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.result;
}

// One operation at a time.
function in_turn<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}

(window as any).opendoorTransport = (operation: string, args: any) => {
  const copy = JSON.parse(JSON.stringify(args || {}));
  const result = in_turn(() => perform(operation, copy));
  if (operation !== "run_dxl") return result;
  boxes.clear();
  return result.then((reply: any) => {
    if (reply?.dialogs) boxes.show(reply.dialogs, send_event);
    return reply;
  });
};

// A dialog box button or selection: the callbacks run in the worker, with the
// same time limit and Stop button as a script.
const send_event: boxes.Send = (session, event) => in_turn(() => perform("dxl_event",
  { session, event, confirm_yes: Boolean(DXL.yes?.checked) }));

// -- the databases as wholes -------------------------------------------------

// Start again from `snapshot` (null: the demo, or empty if named) and show it,
// as the record `key`. An untouched demo is not kept. If it cannot be opened,
// what was there stays.
async function replace_database(key: string, snapshot: Snapshot | null, empty: string | null = null): Promise<void> {
  if (unsaved) {
    throw new Error("The open database has changes this browser could not save. Save it to a file first.");
  }
  boxes.clear(); // its script belongs to the database being left
  const demo = snapshot || empty !== null ? undefined : await free_name("demo").catch(() => "demo");
  await in_turn(async () => {
    const before = { last, kept, key: current_key() };
    try {
      const rev = (await read_database(key))?.rev ?? 0;
      const fresh = await start_worker(snapshot, empty, demo);
      ready = Promise.resolve();
      use_database(key, rev);
      if (snapshot || empty !== null) await keep(fresh ?? snapshot!, true);
      else {
        last = fresh;
        kept = false;
        element("storage-problem").hidden = true;
      }
    } catch (e) {
      discard_worker();
      ({ last, kept } = before);
      throw e;
    }
  });
  resetView();
  S.moduleId = S.data = S.selected = S.linkStart = S.clip = S.redline = null;
  S.undo = []; // it names objects of the database that is gone
  S.readOnly = false;
  S.picked = 1;
  S.expanded = new Set([1]);
  await loadTree();
  S.tree.children.forEach((c: any) => S.expanded.add(c.id));
  renderTree();
  render();
  if (DXL.result) DXL.result.replaceChildren();
}

async function current_snapshot(): Promise<Snapshot> {
  return in_turn(async () => {
    await engine();
    const reply = await send({ type: "save" }, false);
    if (reply.error !== undefined) throw new Error("the database could not be written out: " + reply.error);
    return reply.result;
  });
}

const SUFFIX = ".opendoor.json";
const MAX_FILE = 5 * 1024 * 1024; // every change writes the files out with the database

async function read_file(file: File): Promise<Snapshot> {
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    data = null;
  }
  if (data?.format !== "opendoor-browser" || data.version !== 1 || typeof data.dump !== "string") {
    throw new Error(`${file.name} is not a database saved from this page.`);
  }
  return { dump: data.dump, database: file.name.replace(/\.opendoor\.json$|\.json$/i, ""),
    files: Array.isArray(data.files) ? data.files : [] };
}

// A name no kept database has yet.
async function free_name(wanted: string): Promise<string> {
  const taken = new Set((await list_databases()).map((d) => d.name));
  let name = wanted;
  for (let n = 2; taken.has(name); n++) name = `${wanted} (${n})`;
  return name;
}

const is_open = (key: string) => key === current_key() && kept;

const host: Host = {
  databases: () => in_turn(async () => {
    await engine().catch(() => {}); // a database that cannot be opened is still listed
    return (await list_databases()).map((d) => ({ ...d, open: is_open(d.key) && ready !== null }));
  }),
  async open(key) {
    if (is_open(key) && ready) return;
    const saved = await read_database(key);
    if (!saved) throw new Error("That database is no longer kept in this browser.");
    await replace_database(key, saved.snapshot);
  },
  demo: () => replace_database(new_key(), null),
  create: async (name) => replace_database(new_key(), null, await free_name(name)),
  async add_database(file) {
    const snapshot = await read_file(file);
    snapshot.database = await free_name(snapshot.database);
    await replace_database(new_key(), snapshot);
  },
  async save(key) {
    const snapshot = is_open(key) && ready ? await current_snapshot() : (await read_database(key))?.snapshot;
    if (!snapshot) throw new Error("That database is no longer kept in this browser.");
    const name = snapshot.database.replace(/\.opendoor\.json$|\.json$/i, "") + SUFFIX;
    download(name, JSON.stringify({ format: "opendoor-browser", version: 1, dump: snapshot.dump, files: snapshot.files }),
      "application/json");
    if (key === current_key()) unsaved = false;
    say("Saved " + name);
  },
  async remove(key) {
    const open = key === current_key();
    await delete_database(key);
    if (open) unsaved = false; // deleting it was asked for
    if (open) await replace_database(new_key(), null);
  },
  files: async () => (await current_snapshot()).files,
  async add_file(file) {
    if (file.size > MAX_FILE) throw new Error(`${file.name} is too large: files up to 5 MB are kept.`);
    const bytes = await file.arrayBuffer();
    if (new Uint8Array(bytes).includes(0)) {
      throw new Error(`${file.name} is not a text file. Only text is kept: save a spreadsheet as CSV first.`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (e) {
      text = new TextDecoder("windows-1252").decode(bytes);
    }
    await (window as any).opendoorTransport("add_file", { name: file.name, text });
  },
  remove_file: (path) => (window as any).opendoorTransport("remove_file", { path }),
  use: (path, text) => (window as any).opendoorUse(path, text),
};

(window as any).opendoorDesktop = () => (shell ? shell.leave("index.html#desktop") : desktop(host));

// What windows.html needs of the engine it holds for its windows.
(window as any).opendoorEngine = {
  perform: (operation: string, args: any, changed: () => void) => in_turn(async () => {
    const before = writes;
    try {
      return await perform(operation, args);
    } finally {
      if (writes !== before) changed();
    }
  }),
  database: () => current_key(),
};
(window as any).opendoorCloseBoxes = boxes.clear;
(window as any).opendoorUnsaved = () => unsaved; // leaving the page would lose changes

document.addEventListener("DOMContentLoaded", () => {
  // windows.html has no app of its own, and its windows have no desktop.
  if (shell || !document.getElementById("main")) return;
  if (!entered() || location.hash === "#desktop") desktop(host);
  if (location.hash) history.replaceState(null, "", location.pathname);
  element("menubar").append(h("button", { type: "button", id: "to-desktop", onclick: () => desktop(host) }, "Desktop"));
  // The phone's way to the database tree.
  element("menubar").prepend(h("button", { type: "button", id: "tree-toggle",
    onclick: () => document.body.classList.toggle("tree-open") }, "Tree"));
  element("explorer").addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest(".node") && !target.closest(".twisty")) document.body.classList.remove("tree-open");
  });
});
