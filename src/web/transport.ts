// The page's side of the engine: app.js calls window.opendoorTransport, which
// passes each operation to the worker, one at a time, and saves what changed.
// Loaded before app.js; the menus it adds use app.js's own helpers.

import * as boxes from "./dialogs.ts";
import { read_saved, write_saved } from "./storage.ts";
import type { Snapshot } from "./storage.ts";

// app.js's globals.
declare const MENUS: Record<string, () => unknown[]>;
declare const S: any;
declare const DXL: any;
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function say(text: string, isError?: boolean): void;
declare function act(work: () => unknown): Promise<void>;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function confirmDialog(title: string, text: string, okLabel: string, onOk: () => unknown): void;
declare function download(filename: string, data: string, type: string): void;
declare function chooseFile(accept: string, onFile: (file: File) => unknown): void;
declare function writtenFile(path: string, text: string): unknown;
declare function buildMenubar(): void;
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
let pending: Pending | null = null;
let queue: Promise<unknown> = Promise.resolve();
let next_id = 1;

const element = (id: string) => document.getElementById(id)!;
const stop_button = element("stop"); // kept here: it moves between the page and dialogs

function storage_problem(e: any): void {
  const box = element("storage-problem");
  box.textContent = "Changes are NOT being saved in this browser: " + (e?.message || e?.name || e) // some have no message
    + ". Use Database, Save database to a file.";
  box.hidden = false;
}

async function keep(snapshot: Snapshot, replace = false): Promise<void> {
  last = snapshot;
  try {
    await write_saved(snapshot, replace);
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

function start_worker(snapshot: Snapshot | null): Promise<Snapshot | null> {
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
    made.postMessage({ type: "init", snapshot });
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
  try {
    const fresh = await start_worker(saved);
    if (fresh) await keep(fresh);
  } catch (e: any) {
    if (!saved) throw e;
    // Keep what is saved: never overwrite it with the example unasked.
    throw new Error(`The saved database could not be opened (${e.message}). `
      + "Use Database, Reset to the example project.");
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

// -- the database as a whole ---------------------------------------------------

// Start again from `snapshot` (null: the example) and show it. If it cannot be
// opened, what was there stays.
async function replace_database(snapshot: Snapshot | null): Promise<void> {
  boxes.clear(); // its script belongs to the database being replaced
  await in_turn(async () => {
    const before = last;
    try {
      const fresh = await start_worker(snapshot);
      ready = Promise.resolve();
      await keep(fresh ?? snapshot!, true);
    } catch (e) {
      discard_worker();
      last = before;
      throw e;
    }
  });
  resetView();
  S.moduleId = S.data = S.selected = S.linkStart = null;
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

const save_file = async () => {
  const now = await current_snapshot();
  const name = now.database.replace(/\.opendoor\.json$|\.json$/i, "") + SUFFIX;
  download(name, JSON.stringify({ format: "opendoor-browser", version: 1, dump: now.dump, files: now.files }),
    "application/json");
  say("Saved " + name);
};

const open_file = () => chooseFile(".json,application/json", async (file) => {
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    data = null;
  }
  if (data?.format !== "opendoor-browser" || data.version !== 1 || typeof data.dump !== "string") {
    throw new Error(`${file.name} is not a database saved from this page.`);
  }
  confirmDialog("Open database file", `Replace the database in this browser with ${file.name}?`, "Open", async () => {
    await replace_database({ dump: data.dump, database: file.name.replace(/\.opendoor\.json$|\.json$/i, ""),
      files: Array.isArray(data.files) ? data.files : [] });
    say("Opened " + file.name);
  });
});

const reset_example = () => confirmDialog("Reset to the example",
  "Throw away the database and script files in this browser and load the example project again?", "Reset",
  async () => {
    await replace_database(null);
    element("storage-problem").hidden = true;
    say("The example project is loaded.");
  });

const script_files = async () => {
  const { files } = await current_snapshot();
  dialog("Files written by scripts", files.length
    ? h("div", {}, files.map(([path, text]) => writtenFile(path, text)),
      h("p", {}, "These are kept in this browser until you reset or open another database."))
    : h("div", {}, "No script has written a file yet."));
};
(window as any).opendoorScriptFiles = script_files;

document.addEventListener("DOMContentLoaded", () => {
  MENUS.Database = () => [["Save database to a file", save_file], ["Open database file...", open_file],
    ["Files written by scripts...", script_files], null, ["Reset to the example project...", reset_example]];
  buildMenubar();
  // The phone's way to the database tree.
  element("menubar").prepend(h("button", { type: "button", id: "tree-toggle",
    onclick: () => document.body.classList.toggle("tree-open") }, "Tree"));
  element("explorer").addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest(".node") && !target.closest(".twisty")) document.body.classList.remove("tree-open");
  });
});
