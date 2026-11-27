// What sets a project up around its modules: link module descriptors.
//
// A LinkModuleDescriptor handle names a folder's descriptor by its source and
// target, so it always shows the descriptor as it is now.

import type { LinkDescriptor } from "../../store.ts";
import type { Library } from "../registry.ts";
import { Fault } from "../runtime.ts";
import type { Runtime } from "../runtime.ts";
import { attempt, current_module, find } from "./database.ts";
import { save_view_in } from "./views.ts";
import type { ViewSettings } from "./views.ts";
import { SYSTEM_NAMES, SYSTEM_TYPES } from "./management.ts";

type Handle = { folder: number; source: string; target: string };

function descriptor(rt: Runtime, handle: any): LinkDescriptor {
  rt.need(handle, "LinkModuleDescriptor");
  const found = rt.store.link_descriptors(handle.folder)
    .find((d: LinkDescriptor) => d.source === handle.source && d.target === handle.target);
  if (!found) throw new Fault("that link module descriptor has been removed");
  return found;
}

// A descriptor's names come back as they were given; DOORS's choice of name or
// full path is not documented.
function bare(name: string, what: string): string {
  if (name.includes("/")) {
    throw new Fault(`${what}: this descriptor was given a path, and whether DOORS answers with the path or the `
      + "name is not documented");
  }
  return name;
}

function register_descriptors(lib: Library): void {
  lib.type("LinkModuleDescriptor");
  lib.loop("Folder", "LinkModuleDescriptor", (rt: Runtime, folder: any) =>
    rt.store.link_descriptors(rt.need(folder, "Folder"))
      .map((d: LinkDescriptor) => ({ folder, source: d.source, target: d.target })));

  for (const mandatory of [false, true]) {
    lib.add("addLinkModuleDescriptor",
      ["Folder", "string", "string", "bool", ...(mandatory ? ["bool"] : []), "string", "string"], "string",
      (rt: Runtime, folder: any, source: string, target: string, overridable: boolean, ...rest: any[]) => {
        const [linkmod, description] = rest.slice(-2);
        return attempt(() => rt.store.add_link_descriptor(rt.need(folder, "Folder"),
          { source, target, linkmod, overridable, mandatory: mandatory ? rest[0] : false }, description));
      });
  }
  lib.add("removeLinkModuleDescriptor", ["Folder", "string", "string"], "string",
    (rt: Runtime, folder: any, source: string, target: string) =>
      attempt(() => rt.store.remove_link_descriptor(rt.need(folder, "Folder"), source, target)));
  lib.add("setLinkModuleDescriptorsExclusive", ["Folder", "ModName_", "bool"], "void",
    (rt: Runtime, folder: any, module: any, flag: boolean) =>
      rt.store.set_links_exclusive(rt.need(folder, "Folder"), rt.need(module, "ModName_"), flag));
  lib.add("getLinkModuleDescriptorsExclusive", ["Folder", "ModName_"], "bool",
    (rt: Runtime, folder: any, module: any) =>
      rt.store.links_exclusive(rt.need(folder, "Folder"), rt.need(module, "ModName_")));

  for (const [call, field] of [["getName", "linkmod"], ["getSourceName", "source"], ["getTargetName", "target"]] as
    const) {
    lib.add(call, ["LinkModuleDescriptor"], "string",
      (rt: Runtime, handle: any) => bare(descriptor(rt, handle)[field], call));
  }
  lib.add("getDescription", ["LinkModuleDescriptor"], "string", (rt: Runtime, handle: any) => {
    const module = rt.store.module_at(descriptor(rt, handle).linkmod, "link", handle.folder);
    return module === null ? null : rt.store.item(module).description;
  });
  for (const [what, field] of [["Overridable", "overridable"], ["Mandatory", "mandatory"]] as const) {
    lib.add(`get${what}`, ["LinkModuleDescriptor"], "bool",
      (rt: Runtime, handle: any) => descriptor(rt, handle)[field]);
    lib.add(`set${what}`, ["LinkModuleDescriptor", "bool"], "void", (rt: Runtime, handle: any, flag: boolean) => {
      // the manual: the call fails on a descriptor that already is so, whichever value it is given
      if (descriptor(rt, handle)[field]) {
        throw new Fault(`set${what}: the descriptor is already ${what.toLowerCase()}, and DOORS fails this call`);
      }
      rt.store.set_link_descriptor(handle.folder, handle.source, handle.target, { [field]: flag });
    });
  }
}

// -- default link module and linksets -----------------------------------------

type Linkset = { link_module: number; source: number; target: number };

function formal(rt: Runtime, name: string): number {
  const found = find(rt, name, ["formal"]);
  if (found === null) throw new Fault(`no formal module ${name}`);
  return found;
}

function default_name(rt: Runtime, source: number | null, target: number | null): string {
  if (source !== null && target !== null) {
    const covering = rt.store.descriptors_between(source, target);
    if (covering.length) return bare(covering[0].descriptor.linkmod, "getDefaultLinkModule");
  }
  if (rt.store.default_link_name === null) {
    throw new Fault("getDefaultLinkModule: none has been set here, and the name DOORS then answers with is not "
      + "verified");
  }
  return rt.store.default_link_name;
}

function register_linksets(lib: Library): void {
  lib.add("setDefaultLinkModule", ["string"], "void",
    (rt: Runtime, name: string) => rt.store.set_default_link_name(name));
  lib.add("getDefaultLinkModule", [], "string", (rt: Runtime) => default_name(rt, null, null));
  lib.add("getDefaultLinkModule", ["ModName_", "ModName_"], "string",
    (rt: Runtime, a: any, b: any) => default_name(rt, rt.need(a, "ModName_"), rt.need(b, "ModName_")));

  lib.type("Linkset");
  // linkMod left out would read as the call that makes a folder
  lib.add("create", ["Module", "string", "string"], "Linkset",
    (rt: Runtime, m: any, source: string, target: string): Linkset => {
      const made = { link_module: rt.need(m, "Module"), source: formal(rt, source), target: formal(rt, target) };
      rt.store.create_linkset(made.link_module, made.source, made.target);
      return made;
    });
  lib.add("delete", ["Linkset"], "void", (rt: Runtime, ls: any) => {
    const { link_module, source, target } = rt.need(ls, "Linkset");
    if (rt.opened.get(source) === "read") {
      throw new Fault(`${rt.store.path(source)} is open read-only; its links cannot be deleted`);
    }
    rt.store.delete_linkset(link_module, source, target);
  });
  lib.add("getTarget", ["Linkset"], "ModName_", (rt: Runtime, ls: any) => rt.need(ls, "Linkset").target);
}

// -- view definitions ---------------------------------------------------------

type ViewDefinition = { settings: ViewSettings };

// A saved view's settings; a view saved without a definition has none to read.
function definition_of(rt: Runtime, module_id: any, view: any): ViewDefinition {
  rt.opened_module(module_id);
  rt.need(view, "View");
  const owner = rt.store.baseline_of(module_id)?.module_id ?? module_id;
  const saved = rt.store.views(owner).get(view.name);
  if (!saved) throw new Fault(`there is no saved view ${view.name}`);
  return { settings: { ...saved.settings } };
}

function register_view_definitions(lib: Library): void {
  lib.type("ViewDef");
  lib.add("get", ["View"], "ViewDef", (rt: Runtime, v: any) => definition_of(rt, current_module(rt), v));
  lib.add("get", ["Module", "View"], "ViewDef", definition_of);
  const create = (rt: Runtime, m: any, all: boolean): ViewDefinition => {
    rt.opened_module(m);
    return { settings: all ? { useColumns: true, useFiltering: true, useSorting: true } : {} };
  };
  // only with both arguments: `create(m)` alone is how an object is made
  lib.add("create", ["Module", "bool"], "ViewDef", create);

  for (const flag of ["useColumns", "useFiltering", "useSorting"] as const) {
    lib.add(flag, ["ViewDef"], "bool", (rt: Runtime, d: any) => {
      const value = rt.need(d, "ViewDef").settings[flag];
      if (value === undefined) {
        throw new Fault(`${flag}: this view definition has not been given it, and the DOORS default is not documented`);
      }
      return value;
    });
    lib.add(flag, ["ViewDef", "bool"], "void",
      (rt: Runtime, d: any, on: boolean) => { rt.need(d, "ViewDef").settings[flag] = on; });
  }
  lib.add("save", ["View", "ViewDef"], "void",
    (rt: Runtime, v: any, d: any) => save_view_in(rt, current_module(rt), v, rt.need(d, "ViewDef").settings));
  lib.add("save", ["Module", "View", "ViewDef"], "void",
    (rt: Runtime, m: any, v: any, d: any) => save_view_in(rt, m, v, rt.need(d, "ViewDef").settings));
  lib.add("delete", ["ViewDef"], "void", (rt: Runtime, d: any) => { rt.need(d, "ViewDef"); });
}

// -- what the one user here may do with definitions ---------------------------

// There are no access controls here, so a user definition or type allows all.
function register_rights(lib: Library): void {
  const user_made = (system: boolean, name: string) => (rt: Runtime, handle: any) => {
    rt.need(handle, name);
    if (system) throw new Fault("what DOORS answers for a system attribute or type is not verified");
    return true;
  };
  for (const what of ["Create", "Control", "Delete"]) {
    for (const part of ["Def", "Val"]) {
      lib.add(`can${what}${part}`, ["AttrDef"], "bool", (rt: Runtime, d: any) =>
        user_made(SYSTEM_NAMES.has(rt.need(d, "AttrDef").name), "AttrDef")(rt, d));
    }
    lib.add(`can${what}`, ["AttrType"], "bool", (rt: Runtime, t: any) =>
      user_made(SYSTEM_TYPES.includes(rt.need(t, "AttrType").name), "AttrType")(rt, t));
  }
}

export function register(lib: Library): void {
  register_descriptors(lib);
  register_linksets(lib);
  register_view_definitions(lib);
  register_rights(lib);
}
