// The first thing a new tab shows: what this is, and what to do next. Not part
// of DOORS.
import { SHOTS } from "./generated/shots.ts";
import { type Host, NOT_NATIVE } from "./host.ts";

// base.js's globals.
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function chooseFile(accept: string, onFile: (file: File) => unknown): void;

// `entered` is called once a database has been chosen.
export async function launcher(host: Host, entered: () => void): Promise<void> {
  if (document.querySelector("dialog.launcher")) return;
  const problem = h("p", { class: "problem", role: "alert" });
  const actions = h("div", { class: "actions" }, h("p", { role: "status" }, "Loading..."));
  const box = h("dialog", { class: "launcher", "aria-label": "Start" },
    h("div", { class: "page" },
      h("h1", {}, "OpenDoor"),
      h("p", { class: "tag" }, "Practice DOORS and DXL in your browser."),
      h("img", { src: SHOTS.view, width: 360, height: 225,
        alt: "The desktop: icons, a window with a requirements module, and a taskbar" }),
      actions, problem,
      h("p", {}, "Requirements, links, and DXL scripts. Everything stays in this browser; save to a file what matters."),
      h("p", { class: "quiet" }, "Not DOORS, not affiliated with IBM. Made-up data only.")));
  // A browser closes a dialog on a second Escape whatever the page says.
  box.addEventListener("cancel", (event: Event) => event.preventDefault());
  box.addEventListener("close", () => { if (box.isConnected) box.showModal(); });
  document.body.append(box);
  box.showModal();

  let busy = false;
  const attempt = async (work: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    problem.textContent = "";
    try {
      await work();
      box.remove();
      entered();
    } catch (e: any) {
      problem.textContent = e.message;
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
        attempt(() => host.create(wanted));
      } },
      { label: "Cancel" },
    ]);
  };
  const open = (file: File) => attempt(() => host.add_database(file));
  box.addEventListener("dragover", (event: DragEvent) => event.preventDefault());
  box.addEventListener("drop", (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) open(file);
  });

  let kept: { key: string; name: string; open: boolean; demo?: boolean }[] = [];
  try {
    kept = await host.databases();
  } catch (e: any) {
    problem.textContent = e.message;
  }
  const last = kept.find((k) => k.open) ?? kept[0];
  const action = (title: string, onclick: () => unknown, primary = false) =>
    h("button", { type: "button", class: primary ? "primary" : "", onclick }, title);
  actions.replaceChildren(
    ...(last ? [action(`Continue "${last.name}"`, () => attempt(() => host.open(last.key)), true)] : []),
    // An untouched demo is what Continue already opens.
    ...(last?.demo ? [] : [action("Open the demo", () => attempt(host.demo), !last)]),
    action("Start an empty database", create),
    h("button", { type: "button", onclick: () => chooseFile(".json,application/json", open) },
      "Open a database file", h("small", {}, NOT_NATIVE)));
  actions.querySelector("button.primary").focus();
}
