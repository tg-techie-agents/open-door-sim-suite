// What a setup script does around a module: checking names, lowering the open
// mode, splitting a heading from its text, and reading an attribute as text.

import type { Library } from "../registry.ts";
import { Fault } from "../runtime.ts";
import type { Runtime } from "../runtime.ts";
import { create_before, move } from "./database.ts";

/** Using DOORS 9.2: projects, folders and modules may be named with letters,
 * digits, spaces, periods, underscores and hyphens. The answer is the first
 * other character, or the null char when there is none. */
export function invalid_char(name: string): string {
  for (const c of name) {
    if (c > "\x7f" && /\p{L}|\p{N}/u.test(c)) {
      throw new Fault("whether DOORS accepts a letter or digit outside ASCII in a name is not documented");
    }
    if (!/[A-Za-z0-9 ._-]/.test(c)) return c;
  }
  return "\0";
}

/** false for a closed module; the open modes the manual names go to `to`. */
function lower_mode(rt: Runtime, module_id: any, name: string, from: string[], to: string): boolean {
  rt.need(module_id, "Module");
  const mode = rt.opened.get(module_id);
  if (mode === undefined) return false;
  if (!from.includes(mode) || rt.store.is_baseline(module_id)) {
    throw new Fault(`${name}: what DOORS answers for a module open in ${mode} mode is not documented`);
  }
  rt.opened.set(module_id, to);
  return true;
}

/** The heading goes to a new object in this one's place, which becomes its parent. */
function split_heading_and_text(rt: Runtime, object: any): string {
  const old = rt.obj(object);
  rt.editing(old.module_id);
  const heading = rt.store.value(old, "Object Heading");
  if (heading === "" || rt.store.is_deleted(old)) {
    throw new Fault("splitHeadingAndText: what DOORS does with a deleted object or one with no heading "
      + "is not documented");
  }
  const made = create_before(rt, old);
  rt.store.set_value(made, "Object Heading", heading);
  rt.store.set_value(old, "Object Heading", "");
  move(rt, old, new Map([["parent", made]]));
  return "";
}

export function register(lib: Library): void {
  for (const name of ["getInvalidCharInModuleName", "getInvalidCharInProjectName"]) {
    lib.add(name, ["string"], "char", (_rt, s) => invalid_char(s));
  }
  lib.add("downgrade", ["Module"], "bool", (rt: any, m: any) => {
    if (rt.modified.has(m)) {
      throw new Fault("downgrade: save the module first; what becomes of unsaved changes is not documented");
    }
    return lower_mode(rt, m, "downgrade", ["edit", "share"], "read");
  });
  lib.add("downgradeShare", ["Module"], "bool",
    (rt: any, m: any) => lower_mode(rt, m, "downgradeShare", ["edit"], "share"));
  lib.add("splitHeadingAndText", ["Object"], "string", split_heading_and_text);
  // text is stored without formatting here, so there are no Symbol-font characters to convert
  lib.add("unicodeString", ["attr"], "string", (_rt, ref) => ref.get());
}
