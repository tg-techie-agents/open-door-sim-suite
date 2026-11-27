"use strict";
// The app's part in windows.html: in a frame there, this makes it one window (the
// Database Explorer, or one module). On its own page it only offers the way there.
// Loaded last; it wraps app.js's functions rather than changing them.

(() => {
  let host = null;
  try {
    host = window.parent === window ? null : window.parent.opendoorShell;
  } catch (e) { /* framed by someone else's page */ }

  if (!host) {
    window.opendoorWindows = () => {
      if (window.opendoorUnsaved()) return say("The latest changes are not saved in this browser: save the database to a file first.", true);
      location.assign("windows.html" + (S.moduleId ? "?open=" + S.moduleId : ""));
    };
    window.addEventListener("DOMContentLoaded", () => {
      if (innerWidth <= 700) return;
      const button = h("button", { type: "button", id: "to-windows",
        title: "Several modules side by side, each in its own window", onclick: () => window.opendoorWindows() }, "Windows");
      $("menubar").insertBefore(button, $("to-desktop"));
    });
    return;
  }

  const mine = Number(window.frameElement.dataset.module) || 0;
  document.body.classList.add("win", mine ? "win-module" : "win-explorer");

  // A window narrower than a phone's breakpoint is still a desktop window.
  const phone = [];
  const collect = () => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule.media?.mediaText.includes("max-width: 700px")) phone.push([rule, rule.media.mediaText]);
      }
    }
  };
  const layout = () => {
    const narrow = window.parent.innerWidth <= 700;
    for (const [rule, text] of phone) rule.media.mediaText = narrow ? text : "not all";
  };
  collect();
  layout();
  window.parent.addEventListener("resize", layout);
  window.addEventListener("pagehide", () => window.parent.removeEventListener("resize", layout));

  // Link start and the clipboard are the database's, not one window's.
  for (const key of ["linkStart", "clip"]) {
    Object.defineProperty(S, key, { get: () => JSON.parse(host.get(key)),
      set: (value) => host.set(window, key, JSON.stringify(value ?? null)) });
  }

  // Anything with a window of its own is opened there.
  const away = (id) => {
    const node = S.items.get(id);
    return !!node && (node.kind === "formal" || node.kind === "link") && !node.deleted && id !== mine;
  };
  const openHere = openModule, goHere = goTo, pickHere = pickItem, openAsHere = openModuleAs;
  openModule = async (id, absno, unwatched) => (away(id) ? host.open(id, absno) : openHere(id, absno, unwatched));
  goTo = async (module, absno) => (away(module) ? host.open(module, absno) : goHere(module, absno));
  openModuleAs = async (id, readOnly) => (away(id) ? host.open(id, undefined, readOnly) : openAsHere(id, readOnly));
  pickItem = async (id) => {
    if (away(id)) {
      S.picked = id;
      renderTree();
      return host.open(id);
    }
    if (mine && id !== mine) return host.explorer(); // folders belong to the Explorer
    return pickHere(id);
  };

  let booted = false, stale = false, timer = null;
  const renderHere = render;
  render = (options) => {
    renderHere(options);
    if (mine) host.title(window, S.data ? S.data.module.name + (S.data.module.baseline ? " (baseline)" : "")
      : S.items.get(mine)?.name || "Module");
    if (!booted) {
      booted = true;
      setTimeout(start, 0);
    }
  };

  async function start() {
    const asked = host.started(window);
    if (mine) {
      await act(async () => {
        S.picked = mine;
        for (let up = S.items.get(mine).parent; up; up = up.parent) S.expanded.add(up.id);
        if (S.items.get(mine).kind === "formal") {
          if (asked.readOnly !== undefined) await openAsHere(mine, asked.readOnly);
          else await pickHere(mine);
          if (asked.absno !== undefined && asked.absno !== null) await goHere(mine, asked.absno);
        } else await pickHere(mine);
        renderTree();
      });
    }
    if (stale) later();
  }

  // Another window changed something. Redrawing would end an edit in progress or
  // pull a form from under the person, so that waits until they are done.
  const busy = () => {
    const at = document.activeElement;
    return !!document.querySelector("#main .editor, dialog[open]")
      || (document.hasFocus() && !!at?.closest("#props, #findbar, #toolbar") && at.matches("input, textarea, [contenteditable=true]"));
  };
  const later = (wait = 30) => {
    clearTimeout(timer);
    timer = setTimeout(catchUp, wait);
  };
  let running = false;
  async function catchUp() {
    if (running || busy()) return later(250);
    running = true;
    stale = false;
    try {
      await loadTree();
      const node = S.items.get(mine);
      if (mine && (!node || node.deleted)) return host.close(window);
      if (busy()) stale = true;
      else await refresh();
    } catch (e) {
      say("This window could not be brought up to date: " + e.message, true);
    } finally {
      running = false;
      if (stale) later(250);
    }
  }

  window.opendoorWindow = {
    stale() {
      stale = true;
      if (booted) later();
    },
    show: (absno, readOnly) => act(async () => {
      if (readOnly !== undefined) await openAsHere(mine, readOnly);
      if (absno !== undefined && absno !== null) await goHere(mine, absno);
    }),
    endBoxes() {
      if (!document.querySelector(".dxlbox")) return;
      window.opendoorCloseBoxes();
      say("This window's script dialog boxes were closed: a script was run in another window.", true);
    },
  };

  window.addEventListener("blur", closeMenus); // a click in another window never reaches this document
  for (const event of ["pointerdown", "focusin"]) document.addEventListener(event, () => host.front(window), true);
})();
