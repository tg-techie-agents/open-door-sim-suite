// Users and groups from DXL.
//
// Changes are held by the run until saveDirectory(), as DOORS holds them. What
// DOORS answers about a change before it is saved is not documented, so a
// question whose answer such a change would alter stops the script. Accounts
// have a name and a system login name only: no passwords or other details.

import { StoreError } from "../../store.ts";
import type { Directory } from "../../store.ts";
import type { Library } from "../registry.ts";
import { Fault, limit } from "../runtime.ts";
import type { Runtime } from "../runtime.ts";

type Handle = { name: string };

const DRAFT = "user directory";

function draft(rt: Runtime): Directory {
  let held: Directory | undefined = rt.state.get(DRAFT);
  if (!held) rt.state.set(DRAFT, held = JSON.parse(JSON.stringify(rt.store.directory)));
  return held!;
}

// `question` of the saved directory, if the unsaved changes do not alter it
function asked<T>(rt: Runtime, call: string, question: (d: Directory) => T): T {
  const saved = question(rt.store.directory);
  const held: Directory | undefined = rt.state.get(DRAFT);
  if (held && JSON.stringify(question(held)) !== JSON.stringify(saved)) {
    throw new Fault(`${call}: what DOORS answers before saveDirectory() is not documented; save first`);
  }
  return saved;
}

const user_named = (d: Directory, name: string) => d.users.find((u) => u.name === name);
const group_named = (d: Directory, name: string) => d.groups.find((g) => g.name === name);

// the draft's group and user behind two handles
function pair(rt: Runtime, group: any, user: any): [{ name: string; members: string[] }, string] {
  const g = group_named(draft(rt), rt.need(group, "Group").name);
  const name: string = rt.need(user, "User").name;
  if (!g || !user_named(draft(rt), name)) throw new Fault("that user or group has been deleted");
  return [g, name];
}

function adding(rt: Runtime, name: string): string {
  if (!name) return "a name is needed";
  if (name.toLowerCase() === "everyone else") return "that name is reserved";
  const d = draft(rt);
  return user_named(d, name) || group_named(d, name) ? "that name is already used" : "";
}

function register_lookup(lib: Library): void {
  lib.type("User");
  lib.type("Group");
  lib.add("existsUser", ["string"], "bool",
    (rt: Runtime, name: string) => asked(rt, "existsUser", (d) => Boolean(user_named(d, name))));
  lib.add("existsGroup", ["string"], "bool",
    (rt: Runtime, name: string) => asked(rt, "existsGroup", (d) => Boolean(group_named(d, name))));
  lib.add("find", ["string"], "User", (rt: Runtime, name: string): Handle => {
    if (!asked(rt, "find", (d) => Boolean(user_named(d, name)))) throw new Fault(`find: there is no user ${name}`);
    return { name };
  });
  lib.add("find", ["string"], "Group", (rt: Runtime, name: string): Handle => {
    if (!asked(rt, "find", (d) => Boolean(group_named(d, name)))) throw new Fault(`find: there is no group ${name}`);
    return { name };
  });
  lib.prop("User", "name", "string", (rt: Runtime, u: any) => rt.need(u, "User").name);
  lib.prop("Group", "name", "string", (rt: Runtime, g: any) => rt.need(g, "Group").name);

  lib.type("UserList_");
  lib.type("GroupList_");
  lib.add("userList", [], "UserList_", () => ({}));
  lib.add("groupList", [], "GroupList_", () => ({}));
  lib.loop("UserList_", "User", (rt: Runtime) =>
    asked(rt, "for user in userList", (d) => d.users.map((u) => u.name)).map((name) => ({ name })));
  lib.loop("GroupList_", "Group", (rt: Runtime) =>
    asked(rt, "for group in groupList", (d) => d.groups.map((g) => g.name)).map((name) => ({ name })));
  const members = (rt: Runtime, g: any, call: string): string[] => {
    const name: string = rt.need(g, "Group").name;
    return asked(rt, call, (d) => group_named(d, name)?.members ?? []);
  };
  lib.loop("Group", "User", (rt: Runtime, g: any) => members(rt, g, "for user in group").map((name) => ({ name })));
  lib.add("member", ["Group", "User"], "bool",
    (rt: Runtime, g: any, u: any) => members(rt, g, "member").includes(rt.need(u, "User").name));
}

function register_changes(lib: Library): void {
  lib.add("addUser", ["string", "string"], "string", (rt: Runtime, name: string, uid: string) => {
    const refused = adding(rt, name);
    if (!refused) draft(rt).users.push({ name, uid });
    return refused;
  });
  lib.add("addGroup", ["string"], "string", (rt: Runtime, name: string) => {
    const refused = adding(rt, name);
    if (!refused) draft(rt).groups.push({ name, members: [] });
    return refused;
  });
  lib.add("deleteUser", ["User"], "string", (rt: Runtime, u: any) => {
    const name: string = rt.need(u, "User").name;
    const d = draft(rt);
    if (!user_named(d, name)) return "there is no such user";
    d.users = d.users.filter((o) => o.name !== name);
    for (const g of d.groups) g.members = g.members.filter((m) => m !== name);
    return "";
  });
  lib.add("deleteGroup", ["Group"], "string", (rt: Runtime, g: any) => {
    const name: string = rt.need(g, "Group").name;
    const d = draft(rt);
    if (!group_named(d, name)) return "there is no such group";
    d.groups = d.groups.filter((o) => o.name !== name);
    return "";
  });
  lib.add("addMember", ["Group", "User"], "void", (rt: Runtime, group: any, user: any) => {
    const [g, name] = pair(rt, group, user);
    if (g.members.includes(name)) {
      throw new Fault("addMember: the user is already a member; what DOORS then does is not documented");
    }
    g.members.push(name);
  });
  lib.add("deleteMember", ["Group", "User"], "bool", (rt: Runtime, group: any, user: any) => {
    const [g, name] = pair(rt, group, user);
    const was = g.members.includes(name);
    g.members = g.members.filter((m) => m !== name);
    return was;
  });
  lib.add("deleteAllMembers", ["Group"], "bool", (rt: Runtime, group: any) => {
    const g = group_named(draft(rt), rt.need(group, "Group").name);
    if (!g) return false;
    g.members = [];
    return true;
  });
  lib.add("saveDirectory", [], "string", (rt: Runtime) => {
    const held: Directory | undefined = rt.state.get(DRAFT);
    if (!held) return "";
    try {
      rt.store.set_directory(held);
    } catch (e) {
      if (e instanceof StoreError) throw limit(e.message);
      throw e;
    }
    rt.state.delete(DRAFT);
    return "";
  });
  lib.add("loadDirectory", [], "string", (rt: Runtime) => {
    rt.state.delete(DRAFT);
    return "";
  });
}

export function register(lib: Library): void {
  register_lookup(lib);
  register_changes(lib);
}
