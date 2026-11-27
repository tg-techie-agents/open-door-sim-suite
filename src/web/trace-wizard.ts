// The layout DXL behind the traceability wizard. Given what was chosen in the
// wizard it writes the columns of a view: each is DXL that runs once per object
// as obj, follows links in one direction, and displays what it finds. The code
// is meant to be read, saved with a view, and edited.

import { StoreError } from "../store.ts";

export const MAX_DEPTH = 10;
export const LINK_ATTRIBUTES = ["Created By", "Created On"];

export type TraceOptions = {
  direction: "in" | "out";
  linkModule: string; // "*" or a link module's full path
  scope: string | null; // only objects of this formal module; null: any
  identifier: boolean;
  moduleName: "" | "relative" | "path" | "name"; // relative: path only for another folder
  attributes: string[];
  linkAttributes: string[];
  perLine: boolean;
  showNames: boolean;
  trimDatum: number; // characters, 0: no limit
  trimAll: number;
  depth: number;
  multipleColumns: boolean;
  chain: string[]; // module paths: column i shows the objects i links away in chain[i]
  width: number;
  title: string; // "": made from the choices
};

export type TraceColumn = { kind: "dxl"; title: string; width: number; justify: "left"; dxl: string };

const DEFAULTS: TraceOptions = {
  direction: "in", linkModule: "*", scope: null, identifier: true, moduleName: "relative",
  attributes: ["Object Heading"], linkAttributes: [], perLine: true, showNames: false, trimDatum: 0, trimAll: 0,
  depth: 1, multipleColumns: false, chain: [], width: 240, title: "",
};

/** A DXL string literal. */
export function quoted(text: string): string {
  if (/[\x00-\x08\x0a-\x1f]/.test(text)) throw new StoreError("a name with a control character cannot be written in DXL");
  return '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\t", "\\t") + '"';
}

function checked(given: Partial<TraceOptions>): TraceOptions {
  const o: TraceOptions = { ...DEFAULTS, ...given };
  const whole = (value: number, least: number, most: number, what: string) => {
    if (!Number.isInteger(value) || value < least || value > most) {
      throw new StoreError(`${what} must be a whole number from ${least} to ${most}`);
    }
  };
  if (o.direction !== "in" && o.direction !== "out") throw new StoreError("choose in-links or out-links");
  if (!["", "relative", "path", "name"].includes(o.moduleName)) throw new StoreError("unknown module name form");
  whole(o.depth, 1, MAX_DEPTH, "the depth of analysis");
  whole(o.trimDatum, 0, 100000, "the length to trim each datum to");
  whole(o.trimAll, 0, 100000, "the length to trim the entire string to");
  whole(o.width, 40, 2000, "the column width");
  if (o.chain.length > MAX_DEPTH) throw new StoreError(`a chain has at most ${MAX_DEPTH} modules`);
  if (o.chain.some((path) => !path)) throw new StoreError("choose a module for every step of the chain");
  for (const name of o.linkAttributes) {
    if (!LINK_ATTRIBUTES.includes(name)) throw new StoreError(`link attribute '${name}' is not available here`);
  }
  if (!o.identifier && !o.moduleName && !o.attributes.length && !o.linkAttributes.length) {
    throw new StoreError("choose at least one thing to display");
  }
  return o;
}

// The DXL of one column: shows what is from `from` to `to` links away.
function code(o: TraceOptions, from: number, to: number): string {
  const out: string[] = [];
  const line = (text = "") => out.push(text);
  const outgoing = o.direction === "out";
  const arrow = outgoing ? "->" : "<-";
  const chain = o.chain.length > 0;
  const nested = to > from; // several levels in one column

  line("// Traceability column made by the analysis wizard.");
  line("// Layout DXL: it runs once for each object, which is obj.");
  line(`// ${outgoing ? "Out" : "In"}-links, ${from === to ? `level ${to}` : `levels ${from} to ${to}`}.`);
  line("pragma runLim, 0");
  line();
  line(`string LINK_MODULE = ${quoted(o.linkModule)}`);
  if (chain) line(`string CHAIN[] = {${o.chain.slice(0, to).map(quoted).join(", ")}}  // the module at each level`);
  else if (o.scope) line(`string SCOPE = ${quoted(o.scope)}  // only objects of this module`);
  line(`int FIRST_SHOWN = ${from}`);
  line(`int LAST_LEVEL = ${to}`);
  if (o.trimAll) line('string whole = ""');
  line();

  if (o.trimDatum || o.trimAll) {
    line("string clip(string s, int most) {");
    line('    if (most > 0 && length(s) > most) return s[0:most - 1] "..."');
    line("    return s");
    line("}");
    line();
  }
  if (o.attributes.length) {
    line("// An attribute of a linked object, empty if its module has no such attribute.");
    line("string valueOf(Object o, string attrName) {");
    line("    AttrDef definition = find(module(o), attrName)");
    line('    if (null definition) return ""');
    line('    return o.attrName ""');
    line("}");
    line();
  }
  if (o.moduleName === "relative") {
    line("string folderOf(string full) {");
    line("    int i");
    line("    for (i = length(full) - 1; i >= 0; i--) {");
    line('        if (full[i:i] == "/") return full[0:i]');
    line("    }");
    line('    return ""');
    line("}");
    line();
  }

  line("string addDatum(string sofar, string datumName, string datum, string pad) {");
  // Without names an empty value leaves nothing behind; with them the gap shows.
  if (o.showNames) line('    string piece = datumName ": " datum');
  else {
    line("    string piece = datum");
    line('    if (piece == "") return sofar');
  }
  line('    if (sofar == "") return piece');
  line(o.perLine ? '    return sofar "\\n" pad "  " piece' : '    return sofar " " piece');
  line("}");
  line();
  line("// The text shown for one linked object.");
  line("string entryFor(Object o, Link via, string pad) {");
  line('    string result = ""');
  // "Trim each datum" is for attribute values, not for the identifier or module name.
  const trimmed = (value: string) => (o.trimDatum ? `clip(${value}, ${o.trimDatum})` : value);
  if (o.identifier) line('    result = addDatum(result, "ID", identifier(o), pad)');
  if (o.moduleName) {
    line("    Module home = module(o)");
    if (o.moduleName === "name") line('    result = addDatum(result, "Module", name(home), pad)');
    else if (o.moduleName === "path") line('    result = addDatum(result, "Module", fullName(home), pad)');
    else {
      line("    Module here = module(obj)");
      line("    string homeName = name(home)");
      line("    if (folderOf(fullName(home)) != folderOf(fullName(here))) homeName = fullName(home)");
      line('    result = addDatum(result, "Module", homeName, pad)');
    }
  }
  for (const name of o.attributes) {
    line(`    result = addDatum(result, ${quoted(name)}, ${trimmed(`valueOf(o, ${quoted(name)})`)}, pad)`);
  }
  o.linkAttributes.forEach((name, i) => {
    line(`    string linkValue${i} = via.${quoted(name)} ""`);
    line(`    result = addDatum(result, ${quoted("Link " + name)}, ${trimmed(`linkValue${i}`)}, pad)`);
  });
  line("    return result");
  line("}");
  line();

  // -- the walk
  const pick = chain ? "CHAIN[hop - 1]" : o.scope ? "SCOPE" : null;
  line("// Follow the links of one object, one level further each call.");
  line("void follow(Object origin, int hop) {");
  line("    Link l");
  line("    ModName_ other");
  line("    // Open the modules at the far ends first: DXL cannot read what is not open.");
  if (outgoing) {
    line(`    for l in origin${arrow}LINK_MODULE do {`);
    line("        other = target(l)");
  } else {
    line(`    for other in origin${arrow}LINK_MODULE do {`);
  }
  if (pick) line(`        if (fullName(other) != ${pick}) continue`);
  line("        if (!isDeleted other) read(fullName(other), false)");
  line("    }");
  line(`    for l in origin${arrow}LINK_MODULE do {`);
  line(`        Object linked = ${outgoing ? "target" : "source"}(l)`);
  line("        if (null linked) continue");
  line("        if (isDeleted linked) continue");
  if (pick) {
    line("        Module found = module(linked)");
    line(`        if (fullName(found) != ${pick}) continue`);
  }
  line("        if (hop >= FIRST_SHOWN) {");
  if (nested && o.perLine) { // each level further in is indented further
    line('            string pad = ""');
    line("            int i");
    line('            for (i = FIRST_SHOWN; i < hop; i++) pad = pad "    "');
    line("            string shown = entryFor(linked, l, pad)");
    line("            shown = pad shown");
  } else line('            string shown = entryFor(linked, l, "")');
  if (o.trimAll) {
    line('            if (whole == "") whole = shown');
    line(`            else whole = whole ${o.perLine ? '"\\n"' : '"; "'} shown`);
  } else line("            display(shown)");
  line("        }");
  if (to > 1) line("        if (hop < LAST_LEVEL) follow(linked, hop + 1)");
  line("    }");
  line("}");
  line();
  line("follow(obj, 1)");
  if (o.trimAll) line(`if (whole != "") display(clip(whole, ${o.trimAll}))`);
  return out.join("\n") + "\n";
}

const _leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function traceability_columns(given: Partial<TraceOptions>): TraceColumn[] {
  const o = checked(given);
  const way = o.direction === "out" ? "Out-links" : "In-links";
  const through = o.linkModule === "*" ? "" : ` (${_leaf(o.linkModule)})`;
  const base = o.title.trim() || way + through;
  const column = (title: string, from: number, to: number): TraceColumn =>
    ({ kind: "dxl", title, width: o.width, justify: "left", dxl: code(o, from, to) });

  if (o.chain.length) {
    return o.chain.map((path, i) => column(`${base}: ${_leaf(path)}`, i + 1, i + 1));
  }
  if (o.depth > 1 && o.multipleColumns) {
    return Array.from({ length: o.depth }, (_, i) => column(`${base}, level ${i + 1}`, i + 1, i + 1));
  }
  return [column(base, 1, o.depth)];
}
