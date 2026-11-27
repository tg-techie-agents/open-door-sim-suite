// The desktop the practice DOORS runs on: where a visit starts, where databases
// and files are kept, and what DOORS itself has no command for.
import type { Snapshot } from "./storage.ts";

// app.js's globals.
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function chooseFile(accept: string, onFile: (file: File) => unknown): void;
declare function download(filename: string, data: string, type: string): void;
declare function fileSize(text: string): string;

export type Kept = { key: string; name: string; open: boolean };

export type Host = {
  databases(): Promise<Kept[]>;
  open(key: string): Promise<void>;
  demo(): Promise<void>;
  create(name: string): Promise<void>; // an empty database
  add_database(file: File): Promise<void>;
  save(key: string): Promise<void>; // to a file on the computer
  remove(key: string): Promise<void>;
  files(): Promise<[string, string][]>; // of the database that is open
  add_file(file: File): Promise<void>;
  remove_file(path: string): Promise<void>;
  // What the file can be used for in DOORS now: nothing, or a verb and the doing.
  use(path: string, text: string): { label: string; run: () => Promise<void> } | null;
};

const ENTERED = "opendoor-entered:" + new URL(".", globalThis.location?.href ?? "http://localhost/").pathname;
const DATABASE_FILE = /\.opendoor\.json$/i;

// A reload in the same tab goes straight back to the work.
export function entered(): boolean {
  try {
    return sessionStorage.getItem(ENTERED) !== null;
  } catch {
    return false;
  }
}

const short = (path: string) => path.replace(/^\/work\//, "");

export async function desktop(host: Host): Promise<void> {
  if (document.querySelector("dialog.desktop")) return;
  const problem = h("p", { class: "problem", role: "alert" });
  const databases = h("div", { class: "tiles" });
  const files = h("section", { hidden: true });
  const back = h("button", { type: "button", class: "primary back", hidden: true, onclick: () => leave() }, "Back to DOORS");
  const box = h("dialog", { class: "desktop", "aria-label": "Desktop" },
    h("div", { class: "desk" },
      h("header", {}, h("h1", {}, "OpenDoor desktop"), back),
      h("p", {}, "A practice tool for DOORS and DXL; not DOORS. Made-up data only. Everything stays in this browser, "
        + "which can lose it: save a database to a file to keep a copy."),
      problem,
      h("h2", {}, "Databases"), databases, files));
  const leave = () => {
    try {
      sessionStorage.setItem(ENTERED, "yes");
    } catch {
      // the desktop then shows again after a reload
    }
    box.remove();
  };
  // A browser closes a dialog on a second Escape whatever the page says.
  box.addEventListener("cancel", (event: Event) => event.preventDefault());
  box.addEventListener("close", () => { if (box.isConnected) box.showModal(); });
  document.body.append(box);
  box.showModal();

  let busy = false;
  const attempt = async (work: () => Promise<unknown>, then?: () => unknown) => {
    if (busy) return;
    busy = true;
    problem.textContent = "";
    try {
      await work();
      await then?.();
    } catch (e: any) {
      problem.textContent = e.message;
    } finally {
      busy = false;
    }
  };
  const button = (label: string, onclick: () => unknown) => h("button", { type: "button", onclick }, label);
  const tile = (title: string, detail: string, onclick: () => unknown, extra: any[] = [], mark = "") =>
    h("div", { class: "tile " + mark },
      h("button", { type: "button", class: "main", onclick }, h("strong", {}, title), h("span", {}, detail)),
      extra.length ? h("div", { class: "actions" }, extra) : null);

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

  // Files from the computer: a saved database joins the databases, anything else
  // joins the open database's files.
  const take = (list: FileList | File[]) => attempt(async () => {
    const dropped = Array.from(list);
    try {
      for (const file of dropped.filter((f) => !DATABASE_FILE.test(f.name))) await host.add_file(file);
      for (const file of dropped.filter((f) => DATABASE_FILE.test(f.name))) await host.add_database(file);
      if (dropped.length === 1 && DATABASE_FILE.test(dropped[0].name)) leave();
    } finally {
      await draw(); // what did come in, even if the next one was refused
    }
  });
  box.addEventListener("dragover", (event: DragEvent) => event.preventDefault());
  box.addEventListener("drop", (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer?.files.length) take(event.dataTransfer.files);
  });

  const file_tile = ([path, text]: [string, string]) => {
    const name = short(path);
    const save = () => download(name.split("/").pop()!, text, /\.csv$/i.test(name) ? "text/csv" : "text/plain");
    const use = host.use(path, text);
    const made = tile(name, fileSize(text), save, [
      use ? button(use.label, () => attempt(use.run, leave)) : null,
      button("Delete", () => dialog("Delete file", h("div", {}, `Delete ${name}?`), [
        { label: "Delete", action: () => attempt(() => host.remove_file(path), draw) },
        { label: "Cancel", primary: true },
      ])),
    ].filter(Boolean), "file");
    made.draggable = true;
    // Dragging a file out of the page to the computer works in Chromium browsers only.
    made.addEventListener("dragstart", (event: DragEvent) => {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      event.dataTransfer?.setData("DownloadURL", `text/plain:${name.split("/").pop()}:${url}`);
    });
    return made;
  };

  async function draw(): Promise<void> {
    let kept: Kept[] = [];
    try {
      kept = await host.databases();
    } catch (e: any) {
      problem.textContent = e.message;
    }
    const open = kept.find((k) => k.open);
    databases.replaceChildren(
      ...kept.map((k) => tile(k.name, k.open ? "Open now" : "Kept in this browser", () => attempt(() => host.open(k.key), leave), [
        button("Save to file", () => attempt(() => host.save(k.key))),
        button("Delete", () => dialog("Delete database", h("div", {},
          `Delete "${k.name}" from this browser? Unless it is saved to a file, it is gone for good.`), [
          { label: "Delete", action: () => attempt(() => host.remove(k.key), draw) },
          { label: "Cancel", primary: true },
        ])),
      ], k.open ? "database open" : "database")),
      tile("Explore the demo", "A fresh copy of a small made-up project", () => attempt(host.demo, leave), [], "new"),
      tile("Start a new database", "Empty, for your own work", create, [], "new"),
      tile("Open a database file", "Or drop it on this page", () => chooseFile(".json,application/json", (f) => take([f])), [], "new"));
    // Something is open to go back to once the desktop has been left, or is kept.
    back.hidden = !(open || entered());
    files.hidden = back.hidden;
    if (!files.hidden) {
      let list: [string, string][] = [];
      try {
        list = await host.files();
      } catch (e: any) {
        problem.textContent = e.message;
      }
      files.replaceChildren(
        h("h2", {}, open ? `Files of "${open.name}"` : "Files"),
        h("p", {}, "Drop text files here (CSV, ReqIF, DXL, ...): a script finds them by name. What scripts and exports write lands here too. "
          + "Click a file to download it."),
        h("div", { class: "tiles drop" }, list.map(file_tile),
          tile("Add files", "From your computer", () => chooseFile("", (f) => take([f])), [], "new")));
    }
    (box.querySelector(".tile.open button") ?? box.querySelector(".tile button"))?.focus();
  }

  databases.replaceChildren(h("p", { role: "status" }, "Loading..."));
  await draw();
}
