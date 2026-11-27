"use strict";
// The top page of windows.html. It owns the one engine (transport.js) and a desk
// of windows; each window is the app itself in a frame, which reaches the engine
// through window.opendoorHost.

// transport.js draws a script's progress bar with the app's h().
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

(() => {
  const desk = document.getElementById("desk");
  const engine = window.opendoorEngine;
  const windows = new Map(); // module id (0: the Database Explorer) -> window
  const shared = new Map(); // what the windows hold in common: link start, clipboard
  let layoutKey = "opendoor-windows:" + location.pathname; // and the database, once known
  const EXPLORER_WIDTH = 360;
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

  function front(w) {
    if (w.node.classList.contains("front")) return;
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

  // Half the room beside the Explorer each, so that two modules sit side by side.
  function place() {
    const n = windows.size - 2; // modules open before this one
    const room = desk.clientWidth - EXPLORER_WIDTH;
    const width = Math.max(420, Math.floor(room / 2));
    const step = n < 2 ? 0 : (n - 1) * 28;
    return { x: Math.min(EXPLORER_WIDTH + (n % 2) * width + step, desk.clientWidth - width), y: step, w: width, h: desk.clientHeight - step };
  }

  function tile() {
    const explorer = windows.get(0);
    const modules = [...windows.values()].filter((w) => w.id);
    put(explorer, { x: 0, y: 0, w: modules.length ? 300 : EXPLORER_WIDTH, h: desk.clientHeight });
    const columns = Math.max(1, Math.min(modules.length, Math.floor((desk.clientWidth - 300) / 360) || 1));
    const rows = Math.ceil(modules.length / columns);
    const width = Math.floor((desk.clientWidth - 300) / columns), height = Math.floor(desk.clientHeight / (rows || 1));
    modules.forEach((w, i) => put(w, { x: 300 + (i % columns) * width, y: Math.floor(i / columns) * height, w: width, h: height }));
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
    const title = h("span", {}, name);
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
      h("button", { type: "button", title: "Maximise or restore", onclick: maximise }, "□"),
      id ? h("button", { type: "button", title: "Close window", onclick: () => close(w) }, "x") : "");
    const grip = h("div", { class: "grip", title: "Resize" });
    w.node = h("section", { class: "win", "aria-label": name }, head, frame, grip);
    w.node.addEventListener("pointerdown", () => front(w));
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
    const next = [...windows.values()].sort((a, b) => b.z - a.z)[0];
    next.node.classList.remove("front");
    front(next);
    tasks();
    save();
  }

  const changed = (from) => others(from).forEach((w) => child(w)?.stale());

  // To another page: editors are left first, which saves them, and what they
  // sent reaches the engine before the page goes.
  async function leave(url) {
    for (const w of windows.values()) w.frame.contentDocument?.activeElement?.blur();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await engine.perform("tree", {}, () => {}).catch(() => {});
    if (window.opendoorUnsaved()
      && !confirm("The latest changes are not saved in this browser and will be lost. Leave anyway?")) return;
    location.assign(url);
  }
  for (const [id, url] of [["to-single", "index.html"], ["to-desktop", "index.html#desktop"]]) {
    document.getElementById(id).onclick = () => leave(url);
  }

  window.opendoorShell = {
    leave,
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
    explorer() { front(windows.get(0)); },
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

  document.getElementById("tile").onclick = tile;

  // A narrow screen has room for one window: the app as it is.
  if (innerWidth <= 700) return void location.replace("index.html");

  (async () => {
    const tree = (await engine.perform("tree", { show_deleted: false }, () => {})).root;
    layoutKey += ":" + engine.database();
    const names = new Map();
    const index = (node) => { if (!node.deleted) names.set(node.id, node.name); node.children.forEach(index); };
    index(tree);
    let layout = [];
    try {
      layout = JSON.parse(localStorage.getItem(layoutKey) || "[]");
    } catch (e) { /* start afresh */ }
    const held = layout.find((w) => w.id === 0);
    create(0, "Database Explorer", held || { x: 0, y: 0, w: EXPLORER_WIDTH, h: desk.clientHeight });
    for (const w of layout) if (w.id && names.has(w.id)) create(w.id, names.get(w.id), w);
    const asked = Number(new URLSearchParams(location.search).get("open"));
    if (asked && names.has(asked)) window.opendoorShell.open(asked);
    history.replaceState(null, "", location.pathname);
  })().catch((e) => desk.replaceChildren(h("p", { role: "alert" }, "OpenDoor could not start: " + e.message)));
})();
