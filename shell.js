"use strict";
// The top page of windows.html. It owns the one engine (transport.js) and a
// desktop (host.ts draws its icons) with windows on it; each window is the app itself in a frame, which reaches the engine
// through window.opendoorHost.

(() => {
  const desk = document.getElementById("desk");
  const engine = window.opendoorEngine;
  const windows = new Map(); // module id (0: the Database Explorer) -> window
  const shared = new Map(); // what the windows hold in common: link start, clipboard
  let layoutKey = "opendoor-windows:" + location.pathname; // and the database, once known
  const EXPLORER_WIDTH = 420; // its menu bar fits on one line
  const ICONS = 100; // the column of icons that new windows leave in sight
  let top = 1;
  let boxOwner = null; // whose script has dialog boxes open

  const find = (frame) => [...windows.values()].find((w) => w.frame.contentWindow === frame);
  const child = (w) => w.frame.contentWindow?.opendoorWindow;
  const others = (from) => [...windows.values()].filter((w) => w.frame.contentWindow !== from);

  function save() {
    try {
      localStorage.setItem(layoutKey, JSON.stringify([...windows.values()].sort((a, b) => a.z - b.z)
        .map((w) => ({ id: w.id, x: w.node.offsetLeft, y: w.node.offsetTop, w: w.node.offsetWidth, h: w.node.offsetHeight }))));
    } catch (e) { /* the layout is a convenience only */ }
  }

  function tasks() {
    document.getElementById("tasks").replaceChildren(...[...windows.values()].map((w) =>
      h("button", { type: "button", class: w.node.classList.contains("front") ? "front" : "", onclick: () => front(w) },
        w.title.textContent)));
  }

  function minimise(w) {
    w.node.classList.add("min");
    w.node.classList.remove("front");
    tasks();
  }

  const showDesktop = () => [...windows.values()].forEach(minimise);

  function front(w) {
    if (w.node.classList.contains("front")) return;
    w.node.classList.remove("min");
    for (const other of windows.values()) other.node.classList.remove("front");
    w.node.classList.add("front");
    w.node.style.zIndex = w.z = ++top; // never reorder the nodes: a moved frame reloads
    tasks();
    save();
  }

  function put(w, { x, y, w: width, h: height }) {
    const W = desk.clientWidth, H = desk.clientHeight;
    width = Math.max(300, Math.min(width, W));
    height = Math.max(200, Math.min(height, H));
    Object.assign(w.node.style, {
      left: Math.max(0, Math.min(x, W - 80)) + "px", top: Math.max(0, Math.min(y, H - 30)) + "px",
      width: width + "px", height: height + "px",
    });
  }

  // A module takes the room beside the Explorer; a later one lies over it, stepped
  // so that each title stays in sight. Tile puts them side by side.
  function place() {
    const n = [...windows.keys()].filter((id) => id).length - 1; // modules open before this one
    const step = Math.max(0, n % 6) * 28;
    const x = Math.min(ICONS + EXPLORER_WIDTH, Math.max(0, desk.clientWidth - 640)) + step;
    return { x, y: step, w: desk.clientWidth - x, h: desk.clientHeight - step };
  }

  function tile() {
    for (const w of windows.values()) w.node.classList.remove("min");
    const explorer = windows.get(0);
    const modules = [...windows.values()].filter((w) => w.id);
    const left = ICONS + (explorer ? EXPLORER_WIDTH : 0);
    if (explorer) put(explorer, { x: ICONS, y: 0, w: EXPLORER_WIDTH, h: desk.clientHeight });
    const columns = Math.max(1, Math.min(modules.length, Math.floor((desk.clientWidth - left) / 360) || 1));
    const rows = Math.ceil(modules.length / columns);
    const width = Math.floor((desk.clientWidth - left) / columns), height = Math.floor(desk.clientHeight / (rows || 1));
    modules.forEach((w, i) => put(w, { x: left + (i % columns) * width, y: Math.floor(i / columns) * height, w: width, h: height }));
    tasks();
    save();
  }

  function drag(w, handle, apply) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || e.button !== 0) return;
      e.preventDefault();
      front(w);
      const from = { x: w.node.offsetLeft, y: w.node.offsetTop, w: w.node.offsetWidth, h: w.node.offsetHeight };
      desk.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
      const move = (m) => put(w, apply(from, m.clientX - e.clientX, m.clientY - e.clientY));
      const up = () => {
        desk.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function create(id, name, where, pending) {
    const title = h("span", {}, id ? name : "OpenDoor: " + name);
    const frame = h("iframe", { title: name, src: "index.html" });
    if (id) frame.dataset.module = id;
    const w = { id, frame, title, pending, ready: false, z: 0, restore: null };
    const maximise = () => {
      if (w.restore) {
        put(w, w.restore);
        w.restore = null;
      } else {
        w.restore = { x: w.node.offsetLeft, y: w.node.offsetTop, w: w.node.offsetWidth, h: w.node.offsetHeight };
        put(w, { x: 0, y: 0, w: desk.clientWidth, h: desk.clientHeight });
      }
      save();
    };
    const head = h("div", { class: "head", ondblclick: maximise }, title,
      h("button", { type: "button", title: "Minimise", onclick: (e) => { e.stopPropagation(); minimise(w); } }, "_"),
      h("button", { type: "button", class: "max", title: "Maximise or restore", onclick: maximise }, "□"),
      h("button", { type: "button", title: "Close window", onclick: () => close(w) }, "x"));
    const grip = h("div", { class: "grip", title: "Resize" });
    w.node = h("section", { class: "win", "aria-label": name }, head, frame, grip);
    w.node.addEventListener("pointerdown", (e) => { if (!e.target.closest(".head button")) front(w); });
    drag(w, head, (from, dx, dy) => ({ ...from, x: from.x + dx, y: from.y + dy }));
    drag(w, grip, (from, dx, dy) => ({ ...from, w: from.w + dx, h: from.h + dy }));
    windows.set(id, w);
    desk.append(w.node);
    put(w, where || place());
    front(w);
    return w;
  }

  async function close(w) {
    // Leaving an editor saves it: let that reach the engine before the frame goes.
    w.frame.contentDocument?.activeElement?.blur();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await engine.perform("tree", {}, () => {});
    if (boxOwner === w.frame.contentWindow) {
      boxOwner = null;
      await engine.perform("dxl_close", {}, () => {});
    }
    w.node.remove();
    windows.delete(w.id);
    const next = [...windows.values()].filter((o) => !o.node.classList.contains("min")).sort((a, b) => b.z - a.z)[0];
    if (next) {
      next.node.classList.remove("front");
      front(next);
    }
    tasks();
    save();
  }

  const changed = (from) => others(from).forEach((w) => child(w)?.stale());

  // The windows of the database now open, as they were left; at least the Explorer.
  async function openWindows() {
    const tree = (await engine.perform("tree", { show_deleted: false }, () => {})).root;
    const names = new Map();
    const index = (node) => { if (!node.deleted) names.set(node.id, node.name); node.children.forEach(index); };
    index(tree);
    layoutKey = "opendoor-windows:" + location.pathname + ":" + engine.database();
    let layout = [];
    try {
      layout = JSON.parse(localStorage.getItem(layoutKey) || "[]");
    } catch (e) { /* start afresh */ }
    const held = layout.find((w) => w.id === 0);
    if (!windows.has(0)) create(0, "Database Explorer", held || { x: ICONS, y: 0, w: EXPLORER_WIDTH, h: desk.clientHeight });
    for (const w of layout) if (w.id && names.has(w.id) && !windows.has(w.id)) create(w.id, names.get(w.id), w);
    return names;
  }

  let opening = null;
  const opened = () => opening ??= openWindows()
    .catch((e) => say("OpenDoor could not start: " + e.message, true))
    .finally(() => { opening = null; });

  // DOORS from the desktop: open it if it is not, and with `raise` bring it up.
  window.opendoorShow = async (raise) => {
    if (!windows.size) return opened();
    const all = [...windows.values()];
    // Nothing in sight: bring back what was put away, the last used in front.
    if (all.every((w) => w.node.classList.contains("min"))) {
      all.forEach((w) => w.node.classList.remove("min"));
      return front(all.sort((a, b) => b.z - a.z)[0]);
    }
    if (!raise) return;
    if (!windows.has(0)) create(0, "Database Explorer", { x: ICONS, y: 0, w: EXPLORER_WIDTH, h: desk.clientHeight });
    const explorer = windows.get(0);
    explorer.node.classList.remove("front");
    front(explorer);
  };

  // Another database: editors are left first, which saves them, and what they
  // sent reaches the engine; then the windows go.
  window.opendoorFlush = async () => {
    for (const w of windows.values()) w.frame.contentDocument?.activeElement?.blur();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await engine.perform("tree", {}, () => {}).catch(() => {});
  };
  window.opendoorCloseWindows = () => {
    const had = windows.size > 0;
    for (const w of windows.values()) w.node.remove();
    windows.clear();
    shared.clear();
    boxOwner = null;
    tasks();
    return had;
  };
  window.opendoorSwitched = (had) => {
    if (had) opened();
    redraw();
  };

  let drawing = null;
  function redraw() {
    clearTimeout(drawing);
    drawing = setTimeout(() => window.opendoorRedraw?.(), 150);
  }
  window.opendoorWritten = redraw;

  // What the desktop can do with a file in DOORS, in one of the windows.
  window.opendoorUse = (path, text) => {
    const modules = [...windows.values()].filter((w) => w.id && w.ready).sort((a, b) => b.z - a.z);
    const offer = (w) => w && w.frame.contentWindow.opendoorUse(path, text);
    const use = (w) => async () => {
      w.node.classList.remove("front");
      front(w);
      await offer(w).run();
    };
    if (/\.csv$/i.test(path)) {
      const w = modules.find((m) => offer(m));
      return w ? { label: offer(w).label, run: use(w) } : null;
    }
    const label = /\.(dxl|inc)$/i.test(path) ? "Open in DXL" : /\.(reqif|xml)$/i.test(path) ? "Import ReqIF" : null;
    return label && {
      label,
      run: async () => {
        await window.opendoorShow();
        const w = modules[0] || windows.get(0) || [...windows.values()][0];
        for (let i = 0; !w.ready && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 100));
        await use(w)();
      },
    };
  };

  window.opendoorShell = {
    showDesktop,
    async perform(from, operation, args) {
      if (operation === "run_dxl") {
        // The engine keeps one script's dialog boxes: a new run ends the earlier ones.
        others(from).forEach((w) => child(w)?.endBoxes());
        boxOwner = from;
      }
      return JSON.stringify(await engine.perform(operation, JSON.parse(args), () => changed(from)));
    },
    // Open a module's window, or bring the one it has to the front.
    open(module, absno, readOnly) {
      let w = windows.get(module);
      if (!w) create(module, "Opening...", null, { absno, readOnly });
      else {
        front(w);
        if (w.ready) child(w).show(absno, readOnly);
        else w.pending = { absno, readOnly };
        w.frame.contentWindow.focus();
      }
    },
    // A window has started: what it was asked to show.
    started(from) {
      const w = find(from);
      w.ready = true;
      const pending = w.pending;
      w.pending = null;
      return pending || {};
    },
    front(from) { const w = find(from); if (w) front(w); },
    // The DXL window lives inside its window, so that one is given room for it.
    widen(from) {
      const w = find(from);
      if (!w || w.node.offsetWidth >= 760) return;
      put(w, { x: Math.min(w.node.offsetLeft, desk.clientWidth - 760), y: 0, w: 760, h: desk.clientHeight });
      save();
    },
    explorer() { window.opendoorShow(true); },
    close(from) { const w = find(from); if (w && w.id) close(w); },
    title(from, text) {
      const w = find(from);
      if (!w || !w.id || w.title.textContent === text) return;
      w.title.textContent = w.frame.title = text;
      w.node.setAttribute("aria-label", text);
      tasks();
    },
    get: (key) => shared.get(key) ?? "null",
    set(from, key, value) {
      if ((shared.get(key) ?? "null") === value) return;
      shared.set(key, value);
      changed(from);
    },
  };

  window.opendoorTile = tile;

  // A note goes after a few seconds; an error stays until it is clicked.
  const note = document.getElementById("message");
  let fading = null;
  new MutationObserver(() => {
    clearTimeout(fading);
    if (note.textContent && note.className !== "error") fading = setTimeout(() => { note.textContent = ""; }, 4000);
  }).observe(note, { childList: true, characterData: true, subtree: true });
  note.onclick = () => { note.textContent = ""; };

  // A reload in a tab that was working goes back to it; a new one starts at the
  // bare desktop. (transport.js draws the desktop once the page has loaded.)
  window.addEventListener("DOMContentLoaded", () => {
    const asked = Number(new URLSearchParams(location.search).get("open"));
    if (asked || window.opendoorEntered?.()) {
      opened().then(() => { if (asked) window.opendoorShell.open(asked); });
    }
    history.replaceState(null, "", location.pathname);
  });
})();
