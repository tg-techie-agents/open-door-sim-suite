// display and displayRich, which only layout DXL has (see dxl.layout).

import type { Library } from "../registry.ts";
import { Fault } from "../runtime.ts";

export const RICH = /\\([\\{}])|\\([a-z]+)(-?\d+)? ?|([{}])/g;
export const BREAKS: Map<string, string> = new Map([["par", "\n"], ["line", "\n"], ["tab", "\t"]]);
export const STYLES: Set<string> = new Set(["pard", "b", "i", "ul", "ulnone", "strike", "nosupersub", "super",
  "sub", "li", "fi"]);

/** The text of the simple rich text that traceability columns write. */
export function plain_text(rich: string): string {
  return rich.replace(RICH, (_m, escaped?: string, word?: string, _number?: string, brace?: string) => {
    if (escaped) return escaped;
    if (brace || STYLES.has(word!)) return "";
    const found = BREAKS.get(word!);
    if (found !== undefined) return found;
    throw new Fault(`displayRich: the rich text markup \\${word} is not supported here`);
  });
}

export function row(rt: any): string[] {
  return rt.state.get("layout row");
}

export function register(lib: Library): void {
  lib.add("display", ["string"], "void", (rt, s) => { row(rt).push(s); });
  lib.add("display", ["attr"], "void", (rt, a) => { row(rt).push(a.get()); });
  lib.add("displayRich", ["string"], "void", (rt, s) => { row(rt).push(plain_text(s)); });
}
