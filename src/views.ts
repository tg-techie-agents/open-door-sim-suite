// What a saved view holds, shared by the interface and by DXL.
//
// A definition has either `columns`, a list of attribute names shown after the
// ID and main columns (what the interface's Columns box makes), or `layout`,
// every column in order (what a script makes). Both also hold `filter`
// ({attribute, op, value} or null), `sort` (a name or null), `in_links` and
// `out_links` (the interface's own link columns, which DXL does not see).

export type Justification = "left" | "right" | "center" | "full";

export type ViewColumn = {
  kind: "id" | "main" | "attribute" | "dxl" | "blank";
  title: string | null; // null: never set
  width: number | null; // screen pixels; null: never set
  justify: Justification;
  attribute?: string; // kind "attribute"
  dxl?: string; // kind "dxl"
};

export const STANDARD_VIEW = "Standard view";

// Widths for columns nobody has sized. Real widths are a matter of one's screen.
export const ID_WIDTH = 80, MAIN_WIDTH = 400, ATTRIBUTE_WIDTH = 150;

/** Every column of a definition, as fresh copies. `shows(name)` says whether the
 * interface would show `name` as a column of this module. */
export function view_columns(definition: any, shows: (name: string) => boolean): ViewColumn[] {
  if (definition?.layout) return definition.layout.map((c: ViewColumn) => ({ ...c }));
  const out: ViewColumn[] = [
    { kind: "id", title: "ID", width: ID_WIDTH, justify: "left" },
    { kind: "main", title: null, width: MAIN_WIDTH, justify: "left" }];
  for (const name of definition?.columns ?? []) {
    if (name !== "ID" && shows(name)) {
      out.push({ kind: "attribute", title: name, width: ATTRIBUTE_WIDTH, justify: "left", attribute: name });
    }
  }
  return out;
}
