// Names that are real DXL but that this suite does not offer. Saying so is more
// use than "undeclared": it tells the writer the script is not at fault. The
// same data gives the coverage list: every known name, offered or not.

import { NAME_GROUPS } from "./dxl-names.ts";
import type { Library } from "./registry.ts";

export type NameKind = "function" | "type" | "constant" | "keyword" | "operator";

export type NameStatus = {
  name: string;
  kind: NameKind;
  area: string; // what it belongs to, in this suite's own words
  offered: boolean; // at least one form works here; other forms may still be refused
  reason: string | null; // when not offered: "not built", or "cannot be done here: ..."
};

type Known = { kind: NameKind; area: string; reason: string };

const NAMES: Map<string, Known> = new Map();
for (const group of NAME_GROUPS) {
  for (const [kind, names] of [["function", group.functions], ["type", group.types],
    ["constant", group.constants]] as const) {
    for (const name of names.split(" ")) {
      // not predefined: scripts declare it themselves (const char nl = charOf 10)
      if (name && name !== "nl") NAMES.set(name, { kind, area: group.area, reason: group.reason });
    }
  }
}

/** Names the compiler itself handles, so no library entry shows they work. */
const LANGUAGE_NAMES = new Set(["true", "false", "on", "off", "null", "current", "array", "function", "reference", "void"]);

// The language's reserved words and operators: [kind, offered, names, reason]
const LANGUAGE: Array<[NameKind, boolean, string, string]> = [
  ["keyword", true, "and bool break by char const continue do else for if in int module object or pragma "
    + "real return sizeof string then void while", ""],
  ["keyword", false, "case default enum struct switch union",
    "cannot be done here: DXL reserves the word, and DOORS itself does not support it in scripts"],
  ["keyword", false, "static", "not built"],
  ["operator", true, "space . [] + - * / % | & ~ ^ ++ -- = += -= *= /= %= |= &= == != < > <= >= && || ! : "
    + "<< >> -> <? >? ? <- :: ?: and or", ""],
  ["operator", false, "<> ^^ <<= >>= ^= := => .. \\", "not built"],
];

const WHAT: Record<NameKind, string> = {
  function: "a DOORS function",
  type: "a DOORS type",
  constant: "a DOORS constant",
  keyword: "a DXL keyword",
  operator: "a DXL operator",
};

/** Offered, but to layout DXL alone: elsewhere they are simply not declared. */
const LAYOUT_ONLY = new Set(["display", "displayRich"]);

/** Why `name` is refused, or null if it is not a name this suite knows. */
export function unavailable(name: string): string | null {
  const known = NAMES.get(name);
  if (!known || LAYOUT_ONLY.has(name)) return null;
  return `${name} belongs to ${known.area}: it is ${WHAT[known.kind]} this practice suite does not offer `
    + `(reason: ${known.reason})`;
}

/** What to add when a real name is called in a way no offered form takes. */
export function other_forms(name: string): string {
  return NAMES.has(name) ? ". If DOORS accepts this form, this practice suite does not offer it" : "";
}

/** Every known name with its status against what the libraries declare. */
export function name_status(libraries: Library[]): NameStatus[] {
  const has = (name: string) => LANGUAGE_NAMES.has(name)
    || libraries.some((lib) => lib.functions.has(name) || lib.types.has(name));
  const out: NameStatus[] = [];
  for (const [name, known] of NAMES) {
    const offered = has(name);
    out.push({ name, kind: known.kind, area: known.area, offered, reason: offered ? null : known.reason });
  }
  for (const [kind, offered, names, reason] of LANGUAGE) {
    for (const name of names.split(" ")) {
      out.push({ name, kind, area: "the language itself", offered, reason: offered ? null : reason });
    }
  }
  return out.sort((a, b) => a.area < b.area ? -1 : a.area > b.area ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
