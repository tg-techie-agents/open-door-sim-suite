// The first thing a new tab shows: what this is, and what to do next. Not part
// of DOORS.
import { SHOTS } from "./generated/shots.ts";
import type { Host } from "./host.ts";

// base.js's globals.
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function chooseFile(accept: string, onFile: (file: File) => unknown): void;

// `entered` is called once a database has been chosen; `browse` goes to the
// desktop without choosing.
export async function launcher(host: Host, entered: () => void, browse: () => void): Promise<void> {
  if (document.querySelector("dialog.launcher")) return;
  const wide = innerWidth > 700;
  const problem = h("p", { class: "problem", role: "alert" });
  const actions = h("div", { class: "actions" }, h("p", { role: "status" }, "Loading..."));
  const box = h("dialog", { class: "launcher", "aria-label": "Start" },
    h("nav", {}, h("h1", {}, "OpenDoor"), h("p", { class: "tag" }, "Practice DOORS and DXL in your browser"),
      actions, problem),
    h("main", {},
      h("img", { class: wide ? "wide" : "narrow", src: wide ? SHOTS.wide : SHOTS.narrow,
        alt: wide ? "The tool: a Database Explorer window and a requirements module on a small desktop"
          : "The tool: a requirements module with its links" }),
      h("h2", {}, "What this is"),
      h("p", {}, "A practice copy of the DOORS \"classic\" way of working that runs entirely in this browser."),
      h("ul", {},
        h("li", {}, "Requirements modules, links, baselines and traceability reports."),
        h("li", {}, "Write and run DXL scripts, with files in and out."),
        h("li", {}, wide ? "Windows on a small desktop, where your databases and files are kept."
          : "A desktop where your databases and files are kept.")),
      h("p", {}, "It is not DOORS, it has no connection with IBM, and it has never been compared with a running copy "
        + "of DOORS. IBM, Rational, and DOORS are IBM's trademarks."),
      h("p", {}, h("strong", {}, "Use made-up data only. "),
        "Nothing you do here is sent anywhere. A browser can discard what it keeps, so save to a file what matters.")));
  // A browser closes a dialog on a second Escape whatever the page says.
  box.addEventListener("cancel", (event: Event) => event.preventDefault());
  box.addEventListener("close", () => { if (box.isConnected) box.showModal(); });
  document.body.append(box);
  box.showModal();

  let busy = false;
  const attempt = async (work: () => Promise<unknown>, then: () => void = entered) => {
    if (busy) return;
    busy = true;
    problem.textContent = "";
    try {
      await work();
      box.remove();
      then();
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

  let kept: { key: string; name: string; open: boolean }[] = [];
  try {
    kept = await host.databases();
  } catch (e: any) {
    problem.textContent = e.message;
  }
  const last = kept.find((k) => k.open) ?? kept[0];
  const action = (title: string, detail: string, onclick: () => unknown, primary = false) =>
    h("button", { type: "button", class: primary ? "primary" : "", onclick }, h("strong", {}, title), h("span", {}, detail));
  actions.replaceChildren(
    ...(last ? [action(`Continue "${last.name}"`, "Where you left off", () => attempt(() => host.open(last.key)), true)] : []),
    action("Explore the demo", "A small made-up project to look around in", () => attempt(host.demo), !last),
    action("Start a new database", "Empty, for your own work", create),
    action("Open a database file", "One saved here earlier; or drop it on this page",
      () => chooseFile(".json,application/json", open)),
    h("button", { type: "button", class: "link", onclick: () => attempt(async () => {}, browse) },
      "Go to the desktop: all databases and files"));
  actions.querySelector("button.primary").focus();
}
