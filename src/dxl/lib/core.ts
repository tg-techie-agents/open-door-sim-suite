// print, halt, error trapping, message boxes.

import type { Library } from "../registry.ts";
import { Halt, base_text } from "../runtime.ts";

function _print(rt: any, value: any, type_name?: string): void {
  rt.out.write(base_text(value, type_name));
}

function _halt(_rt: any): never {
  throw new Halt();
}

function _no_error(rt: any): void {
  rt.trapping = true;
  rt.last_error = "";
}

function _last_error(rt: any): string {
  rt.trapping = false;
  const message = rt.last_error;
  rt.last_error = "";
  return message;
}

export function confirm(rt: any, question: string): boolean {
  const answer = Boolean(rt.ask(question));
  rt.out.write(`[confirm] ${question} -> ${answer ? "yes" : "no"}\n`);
  rt.state.get("dialogs")?.message("confirm", `${question} -> ${answer ? "yes" : "no"}`);
  return answer;
}

function _box(kind: string) {
  return (rt: any, message: string): void => {
    rt.out.write(`[${kind}] ${message}\n`);
    rt.state.get("dialogs")?.message(kind, message);
  };
}

export function register(lib: Library): void {
  for (const type_name of ["string", "int", "real", "char", "bool"]) {
    lib.add("print", [type_name], "void", (rt, value) => _print(rt, value, type_name));
  }
  lib.add("halt", [], "void", _halt);
  // this suite answers as an interactive client does, never as a batch run
  lib.add("isBatch", [], "bool", () => false);
  lib.add("noError", [], "void", _no_error);
  lib.add("lastError", [], "string", _last_error);
  lib.add("confirm", ["string"], "bool", confirm);
  for (const [name, kind] of [["ack", "ack"], ["infoBox", "info"], ["warningBox", "warning"], ["errorBox", "error"]]) {
    lib.add(name, ["string"], "void", _box(kind));
  }
  lib.add("null", ["string"], "bool", (_rt, s) => s === "");
  // `null o."Object Text"`: an attribute with nothing in it
  lib.add("null", ["attr"], "bool", (_rt, ref) => ref.get() === "");
}
