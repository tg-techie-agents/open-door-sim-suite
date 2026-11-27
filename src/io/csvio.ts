// CSV export and import of one formal module, for spreadsheets.
//
// export_module writes to anything with a `write(text)` method; the caller adds
// the byte-order mark Excel needs to read UTF-8, and import accepts it either way.
//
// Columns: ID, Number, Level, the attributes by name, Links Out, Links In. An
// attribute that shares one of those names is headed "Attribute: <name>".

import { SYSTEM_ATTRIBUTES, Obj, StoreError, _SPACE, _is_float, _ascii_digits, _repr, _strip } from "../store.ts";
import type { Store } from "../store.ts";

export const RESERVED: readonly string[] = ["ID", "Number", "Level", "Links Out", "Links In"];
export const ESCAPE = "Attribute: ";
// A spreadsheet would run a cell starting like this as a formula. Quotes already
// in front are counted so that import can remove exactly the one export added.
export const FORMULA = /^'*[=+\-@\t\r\n]/;

function _guard(cell: string): string {
  if (!FORMULA.test(cell)) return cell;
  if (_is_float(cell)) return cell; // a plain signed number is data, not a formula
  return "'" + cell;
}

function _unguard(cell: string): string {
  return cell.startsWith("'") && FORMULA.test(cell) ? cell.slice(1) : cell;
}

function _heading(name: string): string {
  return RESERVED.includes(name) || name.startsWith(ESCAPE) ? ESCAPE + name : name;
}

// csv.writer's default ("excel") dialect
function _row(cells: string[]): string {
  if (cells.length === 1 && cells[0] === "") return '""\r\n';
  return cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(",") + "\r\n";
}

class _CsvError extends Error {}

// csv.reader(file_object, strict=True) over a file opened with newline=""
function _read_rows(text: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [], field = "", length = 0;
  let state: "record" | "field" | "plain" | "quoted" | "quote" | "eol" = "record";
  const add = (c: string) => {
    if (length === 16777216) throw new _CsvError("a cell is longer than 16 million characters");
    field += c;
    length += 1;
  };
  const save = () => {
    fields.push(field);
    field = "";
    length = 0;
  };
  // null is the end of a line
  const take = (c: string | null) => {
    const newline = c === "\n" || c === "\r";
    if (state === "record") {
      if (c === null) return;
      if (newline) {
        state = "eol";
        return;
      }
      state = "field";
    }
    if (state === "field" || state === "plain") {
      if (c === null || newline) {
        save();
        state = c === null ? "record" : "eol";
      } else if (c === '"' && state === "field") state = "quoted";
      else if (c === ",") {
        save();
        state = "field";
      } else {
        add(c);
        state = "plain";
      }
    } else if (state === "quoted") {
      if (c === null) return;
      if (c === '"') state = "quote";
      else add(c);
    } else if (state === "quote") {
      if (c === '"') {
        add(c);
        state = "quoted";
      } else if (c === ",") {
        save();
        state = "field";
      } else if (c === null || newline) {
        save();
        state = c === null ? "record" : "eol";
      } else throw new _CsvError("',' expected after '\"'");
    } else if (c === null) {
      state = "record";
    } else if (!newline) {
      throw new _CsvError("new-line character seen in unquoted field - do you need to open the file with newline=''?");
    }
  };
  for (const line of text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []) {
    for (const c of line) take(c);
    take(null);
    if ((state as string) === "record") {
      rows.push(fields);
      fields = [];
    }
  }
  if ((state as string) !== "record" && (length !== 0 || (state as string) === "quoted")) {
    throw new _CsvError("unexpected end of data");
  }
  return rows;
}

// Write the module's undeleted objects. `columns` picks and orders the
// columns, by attribute name or one of RESERVED; null means all of them.
export function export_module(store: Store, module_id: number, file_object: { write(text: string): unknown },
                              columns: readonly string[] | null = null): void {
  const attributes = store.attributes(module_id).map((a) => a.name);
  const headings = columns === null
    ? ["ID", "Number", "Level", ...attributes.map(_heading), "Links Out", "Links In"]
    : columns.map((c) => (RESERVED.includes(c) || c.startsWith(ESCAPE) ? c : _heading(c)));
  const known = new Set([...RESERVED, ...[...attributes, ...SYSTEM_ATTRIBUTES].map(_heading)]);
  for (const column of headings) {
    if (!known.has(column)) throw new StoreError(`no column ${_repr(column)} in ${store.path(module_id)}`);
  }

  const numbers = store.numbers(module_id);

  const cell = (obj: Obj, column: string): string => {
    if (column === "ID") return store.identifier(obj);
    if (column === "Number") return numbers.get(obj.absno) ?? "";
    if (column === "Level") return String(store.level(obj));
    if (column === "Links Out" || column === "Links In") {
      const outgoing = column === "Links Out";
      const ends = store.links(obj, outgoing).map((link) => (outgoing ? link.target : link.source));
      return [...new Set(ends.map((end) => store.identifier(end)))].join("; ");
    }
    return store.shown_value(obj, column.startsWith(ESCAPE) ? column.slice(ESCAPE.length) : column);
  };

  file_object.write(_row(headings.map(_guard)));
  for (const obj of store.objects(module_id)) {
    file_object.write(_row(headings.map((column) => _guard(cell(obj, column)))));
  }
}

const _LEADING_BOM = /^﻿+/;
const _BLANK = new RegExp(`^[${_SPACE}]*$`);

// Create and update objects from CSV rows, all or nothing.
//
// A row with an ID updates that object; a row without one creates an object,
// placed by its Level among the rows around it (no Level: that of the row above). An attribute column is taken as
// given (an empty cell empties the value); a column left out is untouched.
// Number, link and system columns are not imported. Existing objects are never
// moved or deleted. Errors name the spreadsheet row (the header is row 1).
//
// `file_object` is the text itself, its bytes, or anything with `read()`.
// Returns {"created": n, "updated": n, "ignored_columns": [...]}.
export function import_csv(store: Store, module_id: number,
                           file_object: string | Uint8Array | { read(): string }):
    { created: number; updated: number; ignored_columns: string[] } {
  let rows: string[][];
  let text: string;
  if (typeof file_object === "string") text = file_object;
  else if (file_object instanceof Uint8Array) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file_object);
    } catch {
      throw new StoreError("the file is not UTF-8 text; save it as \"CSV UTF-8\"");
    }
  } else text = file_object.read();
  try {
    rows = _read_rows(text);
  } catch (error) {
    if (!(error instanceof _CsvError)) throw error;
    throw new StoreError(`not a readable CSV file: ${error.message}`);
  }
  if (!rows.length) throw new StoreError("the file is empty");
  const headings = rows[0].map((h) => _unguard(_strip(h.replace(_LEADING_BOM, ""))));
  if (headings.length === 1 && headings[0].includes(";")) {
    throw new StoreError("row 1: this file is separated by semicolons; save it with commas");
  }
  const definitions = new Set(store.attributes(module_id).map((a) => a.name));
  // calculated by attribute DXL: exported, but there is nothing to import into
  const calculated = new Set(store.attributes(module_id).filter((a) => a.dxl).map((a) => a.name));
  const ignored: string[] = [], attributes = new Map<number, string>(), special = new Map<string, number>();
  headings.forEach((heading, position) => {
    const name = heading.startsWith(ESCAPE) ? heading.slice(ESCAPE.length) : heading;
    if (headings.indexOf(heading) < position && heading) {
      throw new StoreError(`row 1: column ${_repr(heading)} appears twice`);
    }
    if (heading === "ID" || heading === "Level") special.set(heading, position);
    else if (RESERVED.includes(heading) || SYSTEM_ATTRIBUTES.includes(name) || calculated.has(name)) {
      ignored.push(heading);
    }
    else if (definitions.has(name)) {
      if ([...attributes.values()].includes(name)) {
        throw new StoreError(`row 1: two columns are the attribute ${_repr(name)}`);
      }
      attributes.set(position, name);
    }
    else if (heading) {
      throw new StoreError(`row 1: ${store.path(module_id)} has no attribute ${_repr(name)}`);
    } else if (rows.slice(1).some((row) => position < row.length && row[position] !== "")) {
      throw new StoreError(`row 1: column ${position + 1} has values but no name`);
    }
  });

  const table: [number, string[]][] = []; // [row number, cells]
  rows.slice(1).forEach((row, index) => {
    const number = index + 2;
    if (!row.some((c) => !_BLANK.test(c))) return;
    if (row.slice(headings.length).some((c) => !_BLANK.test(c))) {
      throw new StoreError(`row ${number}: more cells than the header has columns`);
    }
    const cells = row.map((c) => _unguard(c.replaceAll("\r\n", "\n")));
    while (cells.length < headings.length) cells.push("");
    table.push([number, cells]);
  });

  const read = (cells: string[], column: string) =>
    special.has(column) ? _strip(cells[special.get(column)!]) : "";

  const existing = (number: number, identifier: string): Obj => {
    const obj = store.by_identifier(module_id, identifier);
    if (obj === null) {
      throw new StoreError(`row ${number}: no object ${_repr(identifier)}; leave ID empty to create one`);
    }
    if (store.is_deleted(obj)) throw new StoreError(`row ${number}: ${identifier} is deleted`);
    return obj;
  };

  let created = 0, updated = 0;
  const seen = new Set<string>();
  let trail: Obj[] = []; // the latest row's object and its ancestors, top level first
  store.transaction(() => {
    table.forEach(([number, cells], index) => {
      const identifier = read(cells, "ID"), level_text = read(cells, "Level");
      if (level_text && !(/^\p{Nd}+$/u.test(level_text) && Number(_ascii_digits(level_text)) > 0)) {
        throw new StoreError(`row ${number}: Level must be 1, 2, 3, ... not ${_repr(level_text)}`);
      }
      let level = level_text ? Number(_ascii_digits(level_text)) : null;
      const values = new Map<string, string>([...attributes].map(([position, name]) => [name, cells[position]]));
      let obj: Obj;
      try {
        if (identifier) {
          obj = existing(number, identifier);
          if (seen.has(obj.key)) throw new StoreError(`${identifier} is on an earlier row too`);
          if (level && level !== store.level(obj)) {
            throw new StoreError(`${identifier} is at level ${store.level(obj)}, not ${level}; `
              + "CSV import does not move objects");
          }
          let changed = false;
          for (const [name, value] of values) {
            const old = store.value(obj, name);
            // stores nothing if it is the same; an inherited value left as it was stays inherited, and a
            // formatted one keeps its formatting, which CSV does not carry
            if (value !== old || !(store.attribute(module_id, name)?.inherit || store.formatting(obj, name) !== null)) {
              store.set_value(obj, name, value);
            }
            changed = changed || store.value(obj, name) !== old;
          }
          updated += Number(changed);
        } else {
          level = level || trail.length || 1;
          if (level > 1 && trail.length < level - 1) {
            throw new StoreError(`Level ${level} has no row of level ${level - 1} above it`);
          }
          const parent = level > 1 ? trail[level - 2] : null;
          const following = index + 1 < table.length ? table[index + 1][1] : null;
          const place = _placement(store, module_id, parent, trail.slice(level - 1, level),
                                   following ? read(following, "ID") : "");
          obj = store.create_object(module_id, place.parent ?? null, place.after ?? null, place.before ?? null,
                                    new Map([...values].filter(([, v]) => v)));
          created += 1;
        }
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        const message = error.message;
        throw new StoreError(message.startsWith("row ") ? message : `row ${number}: ${message}`);
      }
      seen.add(obj.key);
      trail = _ancestry(store, obj);
    });
  });
  return { created, updated, ignored_columns: ignored };
}

function _ancestry(store: Store, obj: Obj | null): Obj[] {
  const chain: Obj[] = [];
  while (obj) {
    chain.push(obj);
    obj = store.parent_object(obj);
  }
  return chain.reverse();
}

// Where a new row goes: after the previous row at its level, else before the
// next row if that is already a child of the same parent, else last.
function _placement(store: Store, module_id: number, parent: Obj | null, sibling: Obj[], next_id: string):
    { parent?: Obj | null; after?: Obj; before?: Obj } {
  const same = (a: Obj | null) => (a === null ? parent === null : a.equals(parent));
  if (sibling.length && same(store.parent_object(sibling[0]))) return { after: sibling[0] };
  const following = next_id ? store.by_identifier(module_id, next_id) : null;
  if (following instanceof Obj && same(store.parent_object(following))) return { before: following };
  return { parent };
}
