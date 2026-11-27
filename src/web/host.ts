// The desktop the practice DOORS runs on: where a visit starts, where databases
// and files are kept, and what DOORS itself has no command for.
import type { Snapshot } from "./storage.ts";

// app.js's globals.
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function chooseFile(accept: string, onFile: (file: File) => unknown): void;
declare function download(filename: string, data: string, type: string): void;
declare function say(message: string, error?: boolean): void;

export type Kept = { key: string; name: string; open: boolean; demo?: boolean }; // demo: untouched

export type Host = {
  databases(): Promise<Kept[]>;
  open(key: string): Promise<void>;
  demo(): Promise<void>;
  create(name: string): Promise<void>; // an empty database
  add_database(file: File): Promise<void>;
  save(key: string): Promise<void>; // to a file on the computer
  save_project(key: string): Promise<void>; // the same as a project file, to read or edit outside
  remove(key: string): Promise<void>;
  files(): Promise<[string, string][]>; // of the database that is open
  files_of(key: string): Promise<[string, string][]>; // of any kept database
  add_file(file: File): Promise<void>;
  remove_file(path: string): Promise<void>;
  // What the file can be used for in DOORS now: nothing, or a verb and the doing.
  use(path: string, text: string): { label: string; run: () => Promise<void> } | null;
};

const ENTERED = "opendoor-entered:" + new URL(".", globalThis.location?.href ?? "http://localhost/").pathname;
const DATABASE_FILE = /\.opendoor(-project)?\.json$/i;

// A reload in the same tab goes straight back to the work.
export function entered(): boolean {
  try {
    return sessionStorage.getItem(ENTERED) !== null;
  } catch {
    return false;
  }
}

// For windows.html: has this tab already gone into a database?
(globalThis as any).opendoorEntered = entered;

// A database has been chosen in this tab: a reload goes back to the work.
export function enter(): void {
  try {
    sessionStorage.setItem(ENTERED, "yes");
  } catch {
    // a reload then starts at the start page again
  }
}

const short = (path: string) => path.replace(/^\/work\//, "");

const CELL_WIDTH = 88, CELL_HEIGHT = 92, EDGE = 6;
const PLACES = "opendoor-icons:" + new URL(".", globalThis.location?.href ?? "http://localhost/").pathname;
const HOLD_MS = 500; // a touch held this long asks for the icon's menu
const SLOP = 8; // movement under this is a click, not a drag

type Cell = [number, number]; // column, row
type Choice = [string, () => unknown];
type Icon = { id: string; label: string; kind: string; about: string; open: () => unknown; choices: Choice[];
  fixed?: boolean }; // in a folder, where it does not move
export const NOT_NATIVE = "Not yet compatible with the native database format";
const SHOWN = 200_000; // characters of a file the viewer shows

function places(): Record<string, Cell> {
  try {
    return JSON.parse(localStorage.getItem(PLACES) || "{}");
  } catch {
    return {};
  }
}

function keep_places(all: Record<string, Cell>): void {
  try {
    localStorage.setItem(PLACES, JSON.stringify(all));
  } catch {
    // where the icons stand is a convenience only
  }
}

// One menu at a time: the Start menu's, or an icon's.
// It stands clear of `anchor`: above it for the Start button, else beside it, else below or above.
function menu(choices: Choice[], anchor: HTMLElement, label: string, above = false): void {
  document.querySelector(".deskmenu")?.dispatchEvent(new Event("shut"));
  const from = document.activeElement as HTMLElement | null;
  const box = h("div", { class: "deskmenu", role: "menu", "aria-label": label });
  const outside = (event: Event) => { if (!box.contains(event.target as Node)) shut(); };
  const shut = () => {
    box.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("blur", shut); // a click inside a window
  };
  box.append(...choices.map(([text, run]) =>
    h("button", { type: "button", role: "menuitem", onclick: () => { shut(); run(); } }, text)));
  box.addEventListener("shut", shut);
  box.addEventListener("keydown", (event: KeyboardEvent) => {
    const items = Array.from(box.children) as HTMLElement[];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step) items[(at + step + items.length) % items.length].focus();
    else if (event.key === "Escape") { shut(); from?.focus(); }
    else return;
    event.preventDefault();
  });
  (anchor.closest("dialog") ?? document.body).append(box); // over a folder, if in one
  const by = anchor.getBoundingClientRect();
  const w = box.offsetWidth, tall = box.offsetHeight;
  const beside = !above && (by.right + w <= innerWidth || by.left - w >= 0);
  const x = !beside ? by.left : by.right + w <= innerWidth ? by.right : by.left - w;
  const y = beside ? by.top : !above && by.bottom + tall <= innerHeight ? by.bottom : by.top - tall;
  box.style.left = Math.max(0, Math.min(x, innerWidth - w - 2)) + "px";
  box.style.top = Math.max(0, Math.min(y, innerHeight - tall - 2)) + "px";
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("blur", shut);
  box.firstElementChild?.focus();
}

export type Desktop = { draw(): Promise<void>; start_menu(more: Choice[], from: HTMLElement): void };

// The desktop behind the windows: the program, the databases and the files of
// the open one, as icons that stay where they are put.
export function desktop(host: Host, surface: HTMLElement): Desktop {
  const box = h("div", { class: "desktop", "aria-label": "Desktop" });
  surface.replaceChildren(box);
  const leave = () => {
    enter();
    (window as any).opendoorShow();
  };

  let busy = false;
  const attempt = async (work: () => Promise<unknown>, then?: () => unknown) => {
    if (busy) return;
    busy = true;
    try {
      await work();
      await then?.();
    } catch (e: any) {
      say(e.message, true);
    } finally {
      busy = false;
    }
  };

  const create = () => {
    const input = h("input", { type: "text", value: "Practice", "aria-label": "Database name" });
    dialog("New database", h("label", {}, "Name ", input), [
      { label: "Create", primary: true, action: () => {
        const wanted = input.value.trim();
        if (!wanted) throw new Error("Give the database a name.");
        attempt(() => host.create(wanted), leave);
      } },
      { label: "Cancel" },
    ]);
  };

  // Files from the computer: a database joins the databases (by its name, unless it
  // was picked as one), anything else joins the open database's files. `at` is where
  // they were dropped.
  let dropped_at: Cell | null = null;
  const take = (list: FileList | File[], at: Cell | null = null,
    database = (f: File) => DATABASE_FILE.test(f.name)) => attempt(async () => {
    const dropped = Array.from(list);
    dropped_at = at;
    try {
      for (const file of dropped.filter((f) => !database(f))) await host.add_file(file);
      for (const file of dropped.filter(database)) await host.add_database(file);
      const added = dropped.filter((f) => !database(f)).length;
      if (added) say(added === 1 ? "Added to the open database's files folder" : `${added} files added to the open database's files folder`);
      if (dropped.length === 1 && database(dropped[0])) leave();
    } finally {
      await draw(); // what did come in, even if the next one was refused
      dropped_at = null; // only what this drop made stands there
    }
  });

  const columns = () => Math.max(1, Math.floor((surface.clientWidth - 2 * EDGE) / CELL_WIDTH));
  const rows = () => Math.max(1, Math.floor((surface.clientHeight - 2 * EDGE) / CELL_HEIGHT));
  // The cell under a point of the desktop, kept on the part of it that is in sight.
  const cell_at = (x: number, y: number): Cell => [
    Math.max(0, Math.min(columns() - 1, Math.floor((x - EDGE) / CELL_WIDTH))),
    Math.max(0, Math.min(Math.max(rows() - 1, Math.floor(surface.scrollTop / CELL_HEIGHT) + rows() - 1),
      Math.floor((y - EDGE) / CELL_HEIGHT)))];
  const stand = (node: HTMLElement, [column, row]: Cell) => {
    node.dataset.cell = column + "," + row;
    node.style.left = EDGE + column * CELL_WIDTH + "px";
    node.style.top = EDGE + row * CELL_HEIGHT + "px";
  };
  const taken = (but?: HTMLElement) => new Set((Array.from(box.children) as HTMLElement[])
    .filter((n) => n !== but).map((n) => n.dataset.cell));
  // The free cell nearest to `want`, or the first free one: down the left edge on
  // a wide screen, across the top on a phone.
  const free = (used: Set<string | undefined>, want?: Cell): Cell => {
    const across = columns(), down = innerWidth > 700 ? rows() : 0;
    if (want) {
      for (let far = 0; far < 40; far++) {
        for (let c = want[0] - far; c <= want[0] + far; c++) {
          for (let r = want[1] - far; r <= want[1] + far; r++) {
            if (c >= 0 && c < across && r >= 0 && !used.has(c + "," + r)) return [c, r];
          }
        }
      }
    }
    for (let n = 0; ; n++) {
      const cell: Cell = down ? [Math.floor(n / down), n % down] : [n % across, Math.floor(n / across)];
      if (!used.has(cell.join(","))) return cell;
    }
  };

  let dragging = false, stale = false;

  function icon(item: Icon): HTMLElement {
    const node = h("button", { type: "button", class: "icon " + item.kind, "data-id": item.id,
      "aria-label": item.about, title: item.about },
      h("span", { class: "glyph", "aria-hidden": "true" }), h("span", { class: "label" }, item.label));
    const offer = () => menu([["Open", item.open], ...item.choices], node, item.label);
    let pointer = "mouse", spent = false; // spent: the press became a drag or a menu
    node.addEventListener("pointerdown", (e: PointerEvent) => {
      pointer = e.pointerType;
      spent = false;
      if (e.button !== 0) return;
      const from = { x: node.offsetLeft, y: node.offsetTop };
      const hold = pointer === "mouse" ? undefined : setTimeout(() => { spent = true; offer(); }, HOLD_MS);
      node.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        if (item.fixed) {
          if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) >= SLOP) clearTimeout(hold); // a scroll
          return;
        }
        const dx = m.clientX - e.clientX, dy = m.clientY - e.clientY;
        if (!node.classList.contains("moving") && Math.hypot(dx, dy) < SLOP) return;
        clearTimeout(hold);
        document.querySelector(".deskmenu")?.dispatchEvent(new Event("shut"));
        dragging = spent = true;
        node.classList.add("moving");
        node.style.left = from.x + dx + "px";
        node.style.top = from.y + dy + "px";
      };
      const up = (u: PointerEvent) => {
        clearTimeout(hold);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
        if (!node.classList.contains("moving")) return;
        node.classList.remove("moving");
        const [c, r] = node.dataset.cell!.split(",").map(Number);
        const cell = u.type === "pointercancel" ? [c, r] as Cell
          : free(taken(node), cell_at(node.offsetLeft + CELL_WIDTH / 2, node.offsetTop + CELL_HEIGHT / 2));
        stand(node, cell);
        keep_places({ ...places(), [item.id]: cell });
        dragging = false;
        if (stale) draw();
      };
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", up);
    });
    // A mouse selects with one click and opens with two; a finger or a key opens.
    node.addEventListener("click", (e: MouseEvent) => {
      if (spent) return;
      if (e.detail === 0 || pointer !== "mouse") item.open();
      else node.focus();
    });
    node.addEventListener("dblclick", () => { if (!spent && pointer === "mouse") item.open(); });
    node.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      spent = true;
      offer();
    });
    return node;
  }

  // Each database's files are in a folder of its own: scripts find them only
  // while that database is open.
  type Folder = { key: string; name: string; open: boolean; files: [string, string][] };
  let folders: Folder[] = [];
  let current: Kept | undefined; // the open database, whether or not it has files
  let showing: { key: string; list: HTMLElement; close: () => void } | null = null;
  const leave_folder = () => showing?.close();

  const file_icon = (folder: Folder, [path, text]: [string, string]): Icon => {
    const name = short(path);
    const save = () => download(name.split("/").pop()!, text, /\.csv$/i.test(name) ? "text/csv" : "text/plain");
    const use = folder.open ? host.use(path, text) : null;
    const act = use ? () => { leave_folder(); attempt(use.run, leave); } : null;
    const view = () => dialog(name, h("pre", { class: "filetext viewer", tabindex: "0" },
      text.length > SHOWN ? text.slice(0, SHOWN) + "\n... the rest is not shown; save the file to see all of it" : text), [
      ...(use ? [{ label: use.label, action: () => { act!(); } }] : []),
      { label: "Save to file", action: () => { save(); return false; } },
      { label: "Close", primary: true },
    ]);
    const open = current;
    const copy = () => attempt(async () => {
      if ((await host.files()).some(([p]) => short(p) === name)) {
        dialog("Not copied", h("div", {}, `The open database already has a file called ${name}.`));
        return;
      }
      await (window as any).opendoorTransport("add_file", { name, text });
      say(`Copied ${name}`);
    }, draw);
    // A script's contents are best seen where it runs.
    const first = act && /\.(dxl|inc)$/i.test(name) ? act : view;
    return { id: "file:" + folder.key + ":" + path, label: name, kind: "file", about: "File " + name, fixed: true,
      open: first, choices: [
        ...(use ? [[use.label, act!] as Choice] : []),
        ["Save to file", save],
        ...(folder.open ? [["Delete", () => dialog("Delete file", h("div", {}, `Delete ${name}?`), [
          { label: "Delete", action: () => attempt(() => host.remove_file(path), draw) },
          { label: "Cancel", primary: true },
        ])] as Choice] : open ? [[`Copy to ${open.name}`, copy] as Choice] : []),
      ] };
  };

  // What is in the folder on show, again; it closes once there is nothing in it.
  const fill_folder = () => {
    if (!showing) return;
    const folder = folders.find((f) => f.key === showing!.key);
    if (!folder) return leave_folder();
    showing.list.replaceChildren(...folder.files.map((f) => icon(file_icon(folder, f))));
  };
  const show_folder = (key: string, title: string) => {
    const list = h("div", { class: "folderlist" });
    const note = folders.find((f) => f.key === key)?.open ? null
      : h("p", {}, "These belong to a database that is not open: open it to use them in scripts.");
    const made: any = dialog(title, h("div", {}, note, list));
    const box = list.closest("dialog");
    box.classList.add("folderbox");
    showing = { key, list, close: made.close };
    const gone = () => { if (showing?.list === list) showing = null; };
    box.addEventListener("close", gone);
    box.addEventListener("cancel", gone);
    fill_folder();
  };
  const folder_icon = (folder: Folder): Icon => {
    const title = folder.name ? folder.name + " files" : "Files";
    return { id: "folder:" + folder.key, label: title, kind: "folder", about: `Folder ${title}`,
      open: () => show_folder(folder.key, title), choices: [] };
  };

  const database_icon = (k: Kept): Icon => ({
    id: "db:" + k.key, label: k.name, kind: k.open ? "database open" : "database",
    about: `Database ${k.name}${k.open ? " (open)" : ""}`,
    open: () => attempt(() => host.open(k.key), () => { enter(); (window as any).opendoorShow(true); }),
    choices: [
      ["Save to file\n" + NOT_NATIVE, () => attempt(() => host.save(k.key))],
      ["Save as project file\nJSON, without history or files", () => attempt(() => host.save_project(k.key))],
      ["Delete", () => dialog("Delete database", h("div", {},
        `Delete "${k.name}" from this browser? Unless it is saved to a file, it is gone for good.`), [
        { label: "Delete", action: () => attempt(() => host.remove(k.key), draw) },
        { label: "Cancel", primary: true },
      ])],
    ],
  });

  let drawn = 0;
  async function draw(): Promise<void> {
    if (dragging) {
      stale = true;
      return;
    }
    stale = false;
    const turn = ++drawn;
    let kept: Kept[] = [];
    const found: Folder[] = [];
    try {
      kept = await host.databases();
      // The demo that stands in unasked is kept nowhere, but a script may have written there.
      if (!kept.some((k) => k.open) && entered()) found.push({ key: "new", name: "", open: true, files: await host.files() });
      for (const k of kept) found.push({ key: k.key, name: k.name, open: k.open, files: await host.files_of(k.key) });
    } catch (e: any) {
      say(e.message, true);
    }
    if (turn !== drawn || dragging) return;
    folders = found.filter((f) => f.files.length);
    const open = current = kept.find((k) => k.open);
    const program: Icon = { id: "program", label: "OpenDoor", kind: "program", about: "OpenDoor, the program",
      // With no database open there is none to look at: the demo is opened, and kept.
      open: () => (open ? (enter(), (window as any).opendoorShow(true)) : attempt(host.demo, leave)), choices: [] };
    const items = [program, ...kept.map(database_icon), ...folders.map(folder_icon)];
    const stored = places();
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.id;
    const had = new Set((Array.from(box.children) as HTMLElement[]).map((n) => n.dataset.id));
    box.replaceChildren();
    const nodes = items.map(icon);
    // Icons that have a place of their own first, so that a new one takes none of them.
    const settled = (item: Icon) => stored[item.id] && stored[item.id][0] < columns();
    const order = items.map((_, i) => i).sort((a, b) => Number(settled(items[b])) - Number(settled(items[a])));
    for (const i of order) {
      const item = items[i], want = stored[item.id] ?? (had.has(item.id) ? undefined : dropped_at ?? undefined);
      const cell = free(taken(), want);
      stand(nodes[i], cell);
      box.append(nodes[i]);
      if (!stored[item.id]) stored[item.id] = cell;
    }
    keep_places(stored);
    nodes.find((n) => n.dataset.id === focused)?.focus();
    fill_folder();
  }

  // A drop anywhere else would replace the page with the file.
  document.addEventListener("dragover", (event: DragEvent) => event.preventDefault());
  document.addEventListener("drop", (event: DragEvent) => event.preventDefault());
  surface.addEventListener("drop", (event: DragEvent) => {
    if (event.dataTransfer?.files.length) {
      const r = box.getBoundingClientRect();
      take(event.dataTransfer.files, cell_at(event.clientX - r.left, event.clientY - r.top));
    }
  });
  window.addEventListener("resize", () => draw());

  draw();
  return {
    draw,
    start_menu(more, from) {
      menu([
        ["New database...", create],
        ["Open a database file...\n" + NOT_NATIVE, () => chooseFile("", (f) => take([f], null, () => true))],
        ["Add files...", () => chooseFile("", (f) => take([f]))],
        ...more,
      ], from, "Start", true);
    },
  };
}
