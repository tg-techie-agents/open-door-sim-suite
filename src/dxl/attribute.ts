// Attribute DXL: the code on an attribute definition that calculates its value.
//
// The store asks for a value through Store.dxl_engine. As in DOORS the code runs
// when the value is first read, with `obj` and `attrDXLName` declared, and what
// it assigns is kept until a script sets the value to (string null). It may
// assign its own value and nothing else, and it is stopped if it runs on.

import { AttrDxlError, Store, StoreError, _repr } from "../store.ts";
import type { Obj } from "../store.ts";
import { Compiler, Function, Return, is_stack_overflow } from "./compiler.ts";
import type { Env } from "./compiler.ts";
import { Files, VirtualDisk } from "./files.ts";
import { build_library } from "./lib/index.ts";
import { Fault, Halt, Runtime } from "./runtime.ts";
import { DxlError, Parser } from "./syntax.ts";

const LIMIT_MS = 1000; // one value, together with any it reads in turn
const MAX_TIMEOUTS = 5; // after this many objects, an attribute's code is not run again
const MAX_DEPTH = 40; // values read from within one another

const OWN = "attribute DXL"; // the key in rt.state of the value being calculated

type Frame = { obj: Obj; name: string; value: string | null };
// One read from outside, and the reads its code makes.
type Session = { deadline: number; frames: Frame[]; computed: Map<string, string> };

const sessions = new WeakMap<Store, Session>();

class _Undo extends Error {}

// -- what the attribute DXL itself may do -------------------------------------

export function computing(rt: any): boolean {
  return rt.state.has(OWN);
}

/** `obj.attrDXLName = ...`: the only change attribute DXL may make. */
export function assign_own(rt: any, obj: Obj, name: string, text: string): void {
  const frame: Frame = rt.state.get(OWN);
  if (!frame.obj.equals(obj) || frame.name !== name) {
    throw new Fault("attribute DXL may only assign its own value (obj.attrDXLName): "
      + "calculating a value must not change the database");
  }
  frame.value = text;
}

/** `o."Name" = (string null)`: have DXL calculate the value again when next read. */
export function reset_value(rt: any, obj: any, name: string): void {
  rt.obj(obj);
  if (computing(rt)) throw new Fault("(string null) inside attribute DXL is not supported here");
  if (!rt.store.attribute(obj.module_id, name)?.dxl) {
    throw new Fault(`${_repr(name)} is not calculated by attribute DXL: assigning (string null) to such an `
      + "attribute is not supported here");
  }
  rt.editing(obj.module_id);
  rt.store.reset_computed(obj, name);
}

// -- calculating --------------------------------------------------------------

function run_code(store: Store, frame: Frame, code: string, deadline: number): void {
  const refuse = () => {
    throw new Fault("confirm is not supported in attribute DXL");
  };
  // what it prints is discarded; it has no files
  const runtime = new Runtime(build_library(false), store, { write: () => {} }, ".", refuse,
    new Files(".", false, false, new VirtualDisk()));
  runtime.deadline = deadline;
  runtime.opened.set(frame.obj.module_id, "read");
  runtime.module = frame.obj.module_id;
  runtime.folder = store.item(frame.obj.module_id).parent!;
  runtime._current.set(frame.obj.module_id, frame.obj);
  runtime.state.set(OWN, frame);

  const compiler = new Compiler(runtime);
  const obj = compiler.declare(0, "obj", "Object");
  // a constant: a function of no arguments cannot be assigned to
  const constant = new Function("attrDXLName", [], "string");
  constant.body = () => {
    throw new Return(frame.name);
  };
  compiler.scopes[0].set("attrDXLName", [constant]);
  const steps = new Parser(code).program().map((node) => compiler.statement(node));
  compiler.finish();

  const before = store.total_changes;
  try {
    store.transaction(() => {
      runtime.tick(0);
      const env: Env = [new Map([[obj, frame.obj]]), new Map()];
      for (const step of steps) step(env);
      throw new _Undo();
    });
  } catch (e) {
    if (!(e instanceof _Undo || e instanceof Halt)) throw e;
  } finally {
    for (const closer of runtime.closers) closer();
    if (store.total_changes !== before) {
      throw new Fault("attribute DXL must not change the database; nothing it changed was kept");
    }
  }
}

function describe(e: any): string {
  if (e instanceof DxlError) return (e.line ? `line ${e.line}: ` : "") + e.message;
  if (e instanceof Fault || e instanceof StoreError) return e.message;
  if (is_stack_overflow(e)) return "it recurses too deeply";
  return `this engine failed on it (${e?.constructor?.name}: ${e?.message ?? e})`;
}

function evaluate(store: Store, obj: Obj, name: string, code: string): string {
  const fail = (why: string) => new AttrDxlError(
    `attribute DXL of ${_repr(name)} failed at object ${store.identifier(obj)}: ${why}`, `#DXL error: ${why}`);
  const key = `${obj.key}:${name}`, attribute = `${obj.module_id}:${name}`;

  let session = sessions.get(store);
  if (session) {
    const running = session.frames.find((f) => f.name === name && f.obj.equals(obj));
    if (running) {
      if (running === session.frames[session.frames.length - 1] && running.value !== null) return running.value;
      throw fail("the value depends on itself");
    }
    const fresh = session.computed.get(key);
    if (fresh !== undefined) return fresh;
  }
  const kept = store._computed.get(key);
  if (kept) {
    if ("error" in kept) throw fail(kept.error);
    return kept.value;
  }
  if ((store._timeouts.get(attribute) ?? 0) >= MAX_TIMEOUTS) {
    throw fail(`not run: it already ran past its time limit on ${MAX_TIMEOUTS} objects`);
  }

  const outermost = !session;
  if (!session) sessions.set(store, session = { deadline: Date.now() + LIMIT_MS, frames: [], computed: new Map() });
  if (session.frames.length >= MAX_DEPTH) throw fail(`more than ${MAX_DEPTH} values read from within one another`);
  const frame: Frame = { obj, name, value: null };
  session.frames.push(frame);
  let value: string | null = null, failure: string | null = null;
  try {
    run_code(store, frame, code, session.deadline);
    // code that assigns nothing leaves the value empty, to be calculated again
    if (frame.value !== null) value = Store.check_value(store.attribute(obj.module_id, name)!, frame.value);
  } catch (e) {
    failure = describe(e);
  } finally {
    session.frames.pop();
    if (outermost) sessions.delete(store);
  }

  if (failure === null && value !== null) session.computed.set(key, value);
  if (outermost) {
    // Kept only now, outside the transaction the code ran in. A script's own
    // rollback (a dry run) still forgets them.
    for (const [each, text] of session.computed) store._put(store._computed, each, { value: text });
    if (failure !== null && Date.now() > session.deadline) {
      failure = "ran past its time limit";
      store._put(store._computed, key, { error: failure });
      store._timeouts.set(attribute, (store._timeouts.get(attribute) ?? 0) + 1);
    }
  }
  if (failure !== null) throw fail(failure);
  return value ?? "";
}

Store.dxl_engine = evaluate;
