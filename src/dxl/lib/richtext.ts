// Rich text: richText() in its forms, the loops over paragraphs and chunks, and
// the functions that edit markup. What the markup is, and which of it is
// understood, is in ../../rich.ts. Assigning `o."Name" = richText ...` is the
// compiler's, which calls the setters registered here.

import {
  BOLD, ITALIC, STRIKE, SUB, SUPER, UNDERLINE, RichError, cut, escape_text, escape_unescaped, find,
  format_paragraphs, is_formatted, is_rich_text, paragraphs, parse, plain_of, remove_unlisted, replace,
} from "../../rich.ts";
import type { Chunk, Paragraph } from "../../rich.ts";
import { _repr } from "../../store.ts";
import { computing } from "../attribute.ts";
import type { Library } from "../registry.ts";
import { AttrRef, Fault } from "../runtime.ts";
import type { Ref, Runtime } from "../runtime.ts";
import { set_module_value, set_object_value } from "./database.ts";
import { column_of } from "./views.ts";

// What DOORS writes for characters outside the Windows ANSI set (they carry font
// markup) is not published, so no markup is made up for them.
const ANSI = /^[\t\n\x20-\x7e\xa0-\xffŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]*$/;

function told<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof RichError) throw new Fault(error.message);
    throw error;
  }
}

function rich_of(rt: Runtime, attribute: AttrRef): string {
  const value = attribute.get() as string; // checks the owner and the name
  if (!ANSI.test(value)) {
    throw new Fault(`rich text of ${_repr(attribute.name)}: markup for characters outside the Windows ANSI set `
      + "is not verified, so it is not offered here");
  }
  const held = attribute.owner_type === "Object"
    ? rt.store.formatting(rt.obj(attribute.owner), attribute.name) : null;
  return held ?? escape_text(value);
}

function of_column(rt: Runtime, ref: any, obj: any): string {
  const column = column_of(rt, ref);
  if (column.kind !== "attribute") {
    throw new Fault("richText of a column: only a column showing an attribute is supported here (what the main "
      + "column or a DXL column gives as rich text is not documented)");
  }
  rt.obj(obj);
  return rich_of(rt, new AttrRef(rt, "Object", obj, column.attribute!));
}

function set_object_rich(rt: Runtime, obj: any, name: string, markup: string): void {
  const doc = told(() => parse(markup));
  const text = plain_of(doc);
  if (computing(rt)) {
    if (is_formatted(doc)) throw new Fault("formatted text from attribute DXL is not supported here");
    return set_object_value(rt, obj, name, text);
  }
  if (!is_formatted(doc)) return set_object_value(rt, obj, name, text);
  rt.editing(rt.obj(obj).module_id);
  rt.store.set_rich(obj, name, markup);
}

function set_module_rich(rt: Runtime, module_id: any, name: string, markup: string): void {
  const doc = told(() => parse(markup));
  if (is_formatted(doc)) throw new Fault("formatting in a module attribute is not supported here");
  set_module_value(rt, module_id, name, plain_of(doc));
}

function register_loops(lib: Library): void {
  lib.type("RichText");
  lib.type("RichTextParagraph");
  const all = (markup: string) => told(() => paragraphs(markup));
  lib.loop("string", "RichText", (_rt, s) => all(s).flatMap((p) => p.chunks));
  lib.loop("string", "RichTextParagraph", (_rt, s) => all(s));
  lib.loop("RichTextParagraph", "RichText", (rt: Runtime, p: any) => rt.need(p, "RichTextParagraph").chunks);

  const chunk = (name: string, returns: string, read: (c: Chunk) => any) => {
    lib.prop("RichText", name, returns, (rt: Runtime, c: any) => read(rt.need(c, "RichText")));
  };
  chunk("text", "string", (c) => c.text);
  for (const [name, bit] of [["bold", BOLD], ["italic", ITALIC], ["underline", UNDERLINE], ["strikethru", STRIKE],
    ["subscript", SUB], ["superscript", SUPER]] as const) {
    chunk(name, "bool", (c) => (c.style & bit) !== 0);
  }
  chunk("newline", "bool", (c) => c.newline);
  chunk("last", "bool", (c) => c.last);
  chunk("isBullet", "bool", (c) => c.bullet);
  chunk("bulletStyle", "int", (c) => c.bullet ? 1 : 0);
  chunk("indentLevel", "int", (c) => c.indent);
  chunk("isOle", "bool", () => false); // there are no OLE objects in this database
  chunk("isUrl", "bool", (c) => {
    if (/:\/\/|www\.|mailto:/i.test(c.text)) {
      throw new Fault(".isUrl: how DOORS picks out a URL is not documented, so text that may hold one is not "
        + "answered here");
    }
    return false;
  });
  chunk("charset", "int", () => {
    throw new Fault(".charset: fonts and character sets are not supported here");
  });

  const paragraph = (name: string, returns: string, read: (p: Paragraph) => any) => {
    lib.prop("RichTextParagraph", name, returns, (rt: Runtime, p: any) => read(rt.need(p, "RichTextParagraph")));
  };
  paragraph("text", "string", (p) => p.text);
  paragraph("isBullet", "bool", (p) => p.bullet);
  paragraph("bulletStyle", "int", (p) => p.bullet ? 1 : 0);
  paragraph("indentLevel", "int", (p) => p.indent);
}

export function register(lib: Library): void {
  for (const name of ["richText", "richTextWithOle", "richTextNoOle"]) {
    lib.add(name, ["attr"], "string", rich_of);
    lib.add(name, ["Column", "Object"], "string", of_column);
  }
  lib.add("richText", ["attr", "bool"], "string", (rt: Runtime, a: AttrRef, font_table: boolean) => {
    if (font_table) throw new Fault("richText with a font table is not supported here");
    return rich_of(rt, a);
  });
  lib.add("richText", ["string"], "string", (_rt, s: string) => escape_unescaped(s));
  lib.rich_attrs.set("Object", set_object_rich);
  lib.rich_attrs.set("Module", set_module_rich);

  register_loops(lib);

  lib.add("isRichText", ["string"], "bool", (_rt, s: string) => told(() => is_rich_text(s)));
  lib.add("removeUnlistedRichText", ["string"], "string", (_rt, s: string) => told(() => remove_unlisted(s)));
  lib.add("findRichText", ["string", "string", "&int", "&int", "bool"], "bool",
    (_rt, s: string, sub: string, offset: Ref, length: Ref, match_case: boolean) => {
      const found = told(() => find(s, sub, match_case));
      if (!found) return false;
      offset.set(found[0]);
      length.set(found[1]);
      return true;
    });
  lib.add("replaceRichText", ["string", "int", "int", "string"], "string",
    (_rt, s: string, offset: number, length: number, r: string) => told(() => replace(s, offset, length, r)));
  lib.add("cutRichText", ["string", "int", "int"], "string",
    (_rt, s: string, start: number, end: number) => told(() => cut(s, start, end)));
  lib.add("applyTextFormattingToParagraph", ["string", "bool", "int", "int"], "string",
    (_rt, s: string, bullets: boolean, indent: number, number: number) =>
      told(() => format_paragraphs(s, bullets, indent, number)));
  lib.add("richtext_identifier", ["Object"], "string",
    (rt: Runtime, o: any) => escape_text(rt.store.identifier(rt.obj(o))));
}
