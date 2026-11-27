// The DXL engine.
//
//     import { run, layout } from "./dxl/index.ts";
//     const result = run(source, store, out, "/Project/Module");
//     const column = layout(source, store, module_id); // Map absolute number -> text

import "./attribute.ts"; // gives the store its way to run attribute DXL
import { StoreError } from "../store.ts";
import { Compiler, is_stack_overflow } from "./compiler.ts";
import type { Env, Fn } from "./compiler.ts";
import { Files, OSError, VirtualDisk } from "./files.ts";
import { DialogSession, open_dialogs, run_steps } from "./lib/dialogs.ts";
import type { DialogHost } from "./lib/dialogs.ts";
import { build_library } from "./lib/index.ts";
import { carry_out, forget } from "./lib/pending.ts";
import { load_view } from "./lib/views.ts";
import { name_status } from "./unavailable.ts";
import type { NameStatus } from "./unavailable.ts";
import { Fault, Halt, Runtime, compare_text } from "./runtime.ts";
import { DxlError, Parser, py_repr } from "./syntax.ts";

export { DialogSession, DxlError, VirtualDisk };
export type { DialogHost, NameStatus };

/** Every DXL name this suite knows, with whether it is offered and why not. */
export function coverage(): NameStatus[] {
  return name_status([build_library(), build_library(true)]);
}

export class RunResult {
  unsaved: string[]; // paths of modules changed but never save()d
  rolled_back: boolean;
  dialogs: DialogSession | null = null; // dialog boxes left on screen
  constructor(unsaved: string[], rolled_back: boolean = false) {
    this.unsaved = unsaved;
    this.rolled_back = rolled_back;
  }
}

export class _Rollback extends Error {}

export type Out = { write(text: string): any };

const stdout: Out = {
  write(text: string) {
    const process = (globalThis as any).process;
    if (process?.stdout) process.stdout.write(text);
    else console.log(text);
  },
};

function _prepare(source: string, store: any, out: Out | null, open_module: string | null, base_dir: string,
  ask: any, any_file: boolean = false, disk: VirtualDisk | null = null, deadline: number | null = null,
  include_dirs: string[] = [], view: string | null = null): [Runtime, Fn[]] {
  const runtime = new Runtime(build_library(), store, out || stdout, base_dir, ask,
    new Files(base_dir, true, any_file, disk, include_dirs));
  runtime.deadline = deadline;
  if (open_module) {
    const module_id = store.module_at(open_module);
    if (module_id === null) throw new DxlError(0, `no module ${py_repr(open_module)}`);
    runtime.module = runtime.open(module_id, "edit");
    runtime.folder = store.item(module_id).parent;
    if (view) {
      try {
        load_view(runtime, module_id, view);
      } catch (e) {
        if (!(e instanceof Fault)) throw e;
        throw new DxlError(0, `the view ${py_repr(view)} cannot be applied to the script: ${e.message}`);
      }
    }
  }
  const compiler = new Compiler(runtime);
  return [runtime, _compile(compiler, source)];
}

/** All checks happen here, before any of the script runs. */
function _compile(compiler: Compiler, source: string): Fn[] {
  return _contained(() => {
    const nodes = new Parser(source).program();
    const steps = nodes.map((node) => compiler.statement(node));
    compiler.finish();
    compiler.check_flow(nodes, steps, true);
    return steps;
  });
}

/** A script, however broken, fails as a DxlError, never as a JavaScript one. */
function _contained<T>(body: () => T): T {
  try {
    return body();
  } catch (e: any) {
    if (e instanceof DxlError || e instanceof Halt || e instanceof _Rollback || e instanceof OSError
      || e instanceof StoreError) {
      throw e;
    }
    if (is_stack_overflow(e)) {
      throw new DxlError(0, "the script is nested or recurses too deeply for this engine");
    }
    throw new DxlError(0, `this engine failed on the script (${e?.constructor?.name}: ${e?.message ?? e})`);
  }
}

/** Check the DXL of a layout column without running it. Throws DxlError. */
export function check_layout(source: string, store: any, base_dir: string = ".",
  disk: VirtualDisk | null = null): void {
  const runtime = new Runtime(build_library(true), store, stdout, base_dir, null,
    new Files(base_dir, false, false, disk));
  const compiler = new Compiler(runtime);
  compiler.declare(0, "obj", "Object");
  _contained(() => new Parser(source).program().map((node) => compiler.statement(node)));
}

/** Type-check without running. Throws DxlError. */
export function check(source: string, store: any, base_dir: string = ".", disk: VirtualDisk | null = null,
  include_dirs: string[] = []): void {
  _prepare(source, store, null, null, base_dir, null, false, disk, null, include_dirs);
}

/** Check and run a DXL script against `store`. Throws DxlError.
 *
 * `ask(question) -> boolean` answers confirm(). With `dry_run` every database
 * change is undone afterwards (files the script wrote stay written). `disk` holds
 * the script's files; `deadline` (ms since the epoch) stops a script that runs on.
 * `include_dirs` are further folders `#include` looks in. `view` is the saved
 * view the open module's window is showing.
 *
 * With a `host` that is interactive, dialog boxes the script leaves on screen
 * come back as `dialogs`: pass it what the person does, and end() it. Without
 * one a box is only drawn as text. */
export function run(source: string, store: any, out: Out | null = null, open_module: string | null = null,
  base_dir: string = ".", ask: ((question: string) => boolean) | null = null, dry_run: boolean = false,
  any_file: boolean = false, disk: VirtualDisk | null = null, deadline: number | null = null,
  include_dirs: string[] = [], view: string | null = null, host: DialogHost | null = null): RunResult {
  const [runtime, steps] = _prepare(source, store, out, open_module, base_dir, ask, any_file, disk, deadline,
    include_dirs, view);

  const dialogs = open_dialogs(runtime, host || { interactive: false });
  runtime.state.set("dry run", dry_run);
  // errors as DxlError; a dry run is undone
  const guard = (body: () => void) => {
    const guarded = () => {
      try {
        _contained(body);
      } catch (e: any) {
        if (e instanceof Fault) throw new DxlError(0, `run-time error: ${e.message}`); // raised outside a statement guard
        if (!(e instanceof Halt)) throw e;
      }
    };
    if (!dry_run) return guarded();
    try {
      store.transaction(() => {
        guarded();
        throw new _Rollback();
      });
    } catch (e) {
      if (!(e instanceof _Rollback)) throw e;
    }
  };

  const env: Env = [new Map(), new Map()];
  let session: DialogSession | null = null;
  forget(store);
  try {
    guard(() => run_steps(dialogs, steps, env));
    if (dialogs.live()) session = new DialogSession(runtime, dialogs, guard);
  } finally {
    dialogs.stop_progress();
    if (!session) {
      for (const closer of runtime.closers) closer();
      carry_out(runtime); // the script has ended, and its marked links go
    }
  }
  const result = new RunResult([...runtime.modified].map((m) => store.path(m)).sort(compare_text), dry_run);
  result.dialogs = session;
  return result;
}

/** Run layout DXL (a column such as a traceability column) over a module.
 *
 * The script is checked once, then run for each object that is not deleted,
 * with `obj` predeclared; `display` and `displayRich` add lines to that
 * object's cell. Returns Map {absolute number: cell text}. The database is never
 * changed. Throws DxlError. */
export function layout(source: string, store: any, module_id: number, out: Out | null = null,
  base_dir: string = ".", disk: VirtualDisk | null = null, deadline: number | null = null): Map<number, string> {
  const runtime = new Runtime(build_library(true), store, out || stdout, base_dir, null,
    new Files(base_dir, false, false, disk));
  runtime.deadline = deadline;
  runtime.module = runtime.open(module_id, "read");
  runtime.folder = store.item(module_id).parent;
  const compiler = new Compiler(runtime);
  const obj = compiler.declare(0, "obj", "Object");
  const steps = _compile(compiler, source);
  const cells = new Map<number, string>();
  try {
    store.transaction(() => {
      for (const target of store.objects(module_id)) {
        const lines: string[] = [];
        runtime.state.set("layout row", lines);
        runtime.trapping = false;
        runtime.last_error = "";
        const env: Env = [new Map([[obj, target]]), new Map()];
        const before = store.total_changes;
        try {
          runtime.tick(0);
          _contained(() => {
            for (const step of steps) step(env);
          });
        } catch (e: any) {
          if (e instanceof Fault) throw new DxlError(0, `run-time error: ${e.message}`);
          if (e instanceof DxlError) {
            throw new DxlError(e.line, `${e.message} (at object ${store.identifier(target)})`, e.file);
          }
          if (!(e instanceof Halt)) throw e;
        }
        if (store.total_changes !== before) {
          throw new DxlError(0, "layout DXL must not change the database "
            + `(it did at object ${store.identifier(target)})`);
        }
        cells.set(target.absno, lines.join("\n"));
      }
      throw new _Rollback();
    });
  } catch (e) {
    if (!(e instanceof _Rollback)) throw e;
  } finally {
    for (const closer of runtime.closers) closer();
  }
  return cells;
}
