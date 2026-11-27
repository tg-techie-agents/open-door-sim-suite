// Runs the Api off the page's thread, so that a runaway script can be stopped by
// terminating this worker. Holds no storage of its own: the page sends the last
// saved snapshot to start from, and gets a new one after each change.

import { Store, StoreError } from "../store.ts";
import { VirtualDisk } from "../dxl/files.ts";
import { load_project } from "../io/project.ts";
import { Api, plain as plain_result } from "./api.ts";
import "./trace-ops.ts";
import { EXAMPLE, SCRIPTS } from "./generated/embeds.ts";
import type { Snapshot } from "./storage.ts";

const CHANGES = new Set(["create_item", "update_item", "delete_item", "add_object", "set_values", "move_object",
  "delete_object", "undelete_object", "create_link", "delete_link", "clear_suspect", "create_attribute",
  "delete_attribute", "set_module_value", "save_view", "delete_view", "create_baseline", "run_dxl",
  "import_csv", "import_reqif", "trace_clear_suspect", "dxl_event", "paste_object", "split_heading", "split_object",
  "purge", "replace_text", "restore_values", "create_type", "link_by_attribute", "modify_type", "delete_type",
  "modify_attribute", "purge_object", "purge_item", "set_project", "add_link_rule", "remove_link_rule",
  "set_links_exclusive", "create_linkset", "delete_linkset", "set_default_link", "change_access",
  "move_objects", "delete_objects", "undelete_objects", "set_value_many", "create_links", "delete_out_links", "delete_links_between", "delete_all_links",
  "record_session", "user_event", "remove_trigger", "copy_module", "create_set_definition", "update_set_definition", "delete_set_definition",
  "create_baseline_set", "add_to_baseline_set", "close_baseline_set"]);

const scope = self as any;
let api: Api;

function snapshot(): Snapshot {
  return { dump: api.store.dumps(), database: api.database, files: Array.from(api.disk) };
}

function start(saved: Snapshot | null): void {
  const disk = new VirtualDisk();
  let store: Store;
  if (saved) {
    store = Store.loads(saved.dump);
    for (const [path, text] of saved.files) disk.set(path, text);
  } else {
    store = new Store();
    load_project(store, EXAMPLE);
  }
  api = new Api(store, saved ? saved.database : "demo", SCRIPTS, disk);
}

// Output is sent as it appears, so that it survives if the script has to be stopped.
function streamer(id: number): { listener: (text: string) => void; flush: () => void } {
  let held = "";
  let sent = 0;
  const flush = () => {
    if (held) scope.postMessage({ type: "output", id, text: held });
    held = "";
    sent++;
  };
  return {
    listener: (text) => {
      held += text;
      if (sent < 500 || held.length > 8192) flush();
    },
    flush,
  };
}

function describe(e: any): string {
  if (e instanceof StoreError) return e.message;
  console.error(e);
  return `${e?.name || "Error"}: ${e?.message ?? e}`;
}

scope.onmessage = ({ data }: any) => {
  if (data.type === "init") {
    try {
      start(data.snapshot);
      scope.postMessage({ type: "ready", snapshot: data.snapshot ? null : snapshot() });
    } catch (e) {
      scope.postMessage({ type: "init_error", message: describe(e) });
    }
    return;
  }
  if (data.type === "save") {
    const saved: any = { type: "reply", id: data.id };
    try {
      saved.result = snapshot();
      scope.postMessage(saved);
    } catch (e) {
      // a throw out of here would stop the engine, and what it holds with it
      scope.postMessage({ type: "reply", id: data.id, error: describe(e) });
    }
    return;
  }
  const { id, operation, args } = data;
  const reply: any = { type: "reply", id };
  try {
    const name = "op_" + operation;
    if (!Object.prototype.hasOwnProperty.call(Api.prototype, name)) throw new StoreError("no such operation");
    const stream = operation === "run_dxl" || operation === "dxl_event" ? streamer(id) : null;
    api.on_output = stream && stream.listener;
    api.on_progress = stream && ((progress) => scope.postMessage({ type: "progress", id, progress }));
    const result = (api as any)[name](args);
    // Through JSON, so the page gets plain data.
    reply.result = result === undefined ? null : JSON.parse(JSON.stringify(plain_result(result)));
  } catch (e) {
    reply.error = describe(e);
  }
  // The change has been made. A database too big to write out must say so, not
  // look like a failed change.
  if (CHANGES.has(operation) && reply.error === undefined) {
    try {
      reply.snapshot = snapshot();
    } catch (e) {
      reply.not_saved = describe(e);
    }
  }
  api.on_output = null;
  api.on_progress = null;
  try {
    scope.postMessage(reply);
  } catch (e) {
    // no room to copy the database to the page
    delete reply.snapshot;
    scope.postMessage({ ...reply, not_saved: describe(e) });
  }
};
