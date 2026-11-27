// Where a visit starts: what to work on, chosen before the practice DOORS is
// shown. None of this is part of DOORS.
import type { Snapshot } from "./storage.ts";

// app.js's globals.
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function chooseFile(accept: string, onFile: (file: File) => unknown): void;

export type Host = {
  kept(): Promise<string | null>; // the name of the database kept in this browser, if there is one
  read_file(file: File): Promise<Snapshot>;
  replace(snapshot: Snapshot | null): Promise<void>; // null: the demo
  create(name: string): Promise<void>; // an empty database
  save_file(): Promise<void>;
};

const ENTERED = "opendoor-entered:" + new URL(".", globalThis.location?.href ?? "http://localhost/").pathname;

// A reload in the same tab goes straight back to the work.
export function entered(): boolean {
  try {
    return sessionStorage.getItem(ENTERED) !== null;
  } catch {
    return false;
  }
}

export async function start_screen(host: Host): Promise<void> {
  if (document.querySelector("dialog.start")) return;
  const problem = h("p", { class: "problem", role: "alert" });
  const choices = h("div", { class: "choices" }, h("p", { role: "status" }, "Loading..."));
  const box = h("dialog", { class: "start", "aria-label": "Start" },
    h("div", { class: "start-body" },
      h("h1", {}, "OpenDoor"),
      h("p", {}, "A practice tool for DOORS and DXL; not DOORS. Made-up data only. Everything stays in this browser: "
        + "save a database to a file to keep a copy of it."),
      choices, problem));
  const leave = () => {
    try {
      sessionStorage.setItem(ENTERED, "yes");
    } catch {
      // the start screen then shows again after a reload
    }
    box.remove();
  };
  box.addEventListener("cancel", (event: Event) => event.preventDefault());
  // A browser closes a dialog on a second Escape whatever the page says.
  box.addEventListener("close", () => { if (box.isConnected) box.showModal(); });
  document.body.append(box);
  box.showModal();

  let name: string | null = null;
  let broken: string | null = null;
  try {
    name = await host.kept();
  } catch (e: any) {
    broken = e.message;
    problem.textContent = broken;
  }

  let busy = false;
  const attempt = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    problem.textContent = "";
    try {
      await work();
      leave();
    } catch (e: any) {
      problem.textContent = e.message;
    } finally {
      busy = false;
    }
  };
  // Only one database is kept, so anything that takes its place asks first.
  const replacing = (work: () => Promise<void>) => {
    if (broken) {
      dialog("Replace what is in this browser?",
        h("div", {}, "The database kept here could not be opened. Going on replaces it."),
        [{ label: "Replace it", action: () => attempt(work) }, { label: "Cancel", primary: true }]);
    } else if (name === null) {
      attempt(work);
    } else {
      dialog("Replace the database in this browser?",
        h("div", {}, `This browser keeps one database. "${name}" will be gone unless it is saved to a file.`), [
          { label: "Save it to a file, then replace", primary: true,
            action: async () => { await host.save_file(); await attempt(work); } },
          { label: "Replace without saving", action: () => attempt(work) },
          { label: "Cancel" },
        ]);
    }
  };

  const open = async (file: File) => {
    problem.textContent = "";
    try {
      const snapshot = await host.read_file(file);
      replacing(() => host.replace(snapshot));
    } catch (e: any) {
      problem.textContent = e.message;
    }
  };
  const create = () => {
    const input = h("input", { type: "text", value: "Practice", "aria-label": "Database name" });
    dialog("New database", h("label", {}, "Name ", input), [
      { label: "Create", primary: true, action: () => {
        const wanted = input.value.trim();
        if (!wanted) throw new Error("Give the database a name.");
        replacing(() => host.create(wanted));
      } },
      { label: "Cancel" },
    ]);
  };

  const choice = (title: string, detail: string, onclick: () => unknown, primary = false) =>
    h("button", { type: "button", class: primary ? "primary" : "", onclick }, h("strong", {}, title), h("span", {}, detail));
  choices.replaceChildren(
    ...(name === null ? [] : [choice(`Continue with "${name}"`, "The database kept in this browser.", leave, true)]),
    choice("Explore the demo", "A small made-up project with requirements, tests, links and baselines.",
      () => (name === null && !broken ? leave() : replacing(() => host.replace(null))), name === null && !broken),
    choice("Start a new database", "Empty, for your own projects and modules.", create),
    choice("Open a database file", "One saved from this page. You can also drop it here.",
      () => chooseFile(".json,application/json", open)));
  box.addEventListener("dragover", (event: DragEvent) => event.preventDefault());
  box.addEventListener("drop", (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) open(file);
  });
  (choices.querySelector("button.primary") ?? choices.querySelector("button")).focus();
}
