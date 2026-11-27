"use strict";
// What the app and the desktop page (windows.html) both build with.
// Everything shown from the database goes through h() or textContent, so it is
// always text and never markup.

const $ = (id) => document.getElementById(id);

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value; // the page's policy refuses style attributes
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function say(text, isError) {
  $("message").textContent = text;
  $("message").className = isError ? "error" : "";
}

// Run a user action, showing any failure in the status bar.
async function act(work) {
  try {
    say("");
    await work();
  } catch (e) {
    say(e.message, true);
  }
}

function dialog(title, content, buttons) {
  const problem = h("div", { class: "problem" });
  const box = h("dialog", {});
  const close = () => { box.close(); box.remove(); };
  const press = async (button) => {
    problem.textContent = "";
    try {
      if (!button.action || (await button.action()) !== false) close();
    } catch (e) {
      problem.textContent = e.message;
    }
  };
  const row = (buttons || [{ label: "Close" }]).map((b) =>
    h("button", { type: "button", class: b.primary ? "primary" : "", onclick: () => press(b) }, b.label));
  box.append(
    h("div", { class: "titlebar" }, title, h("button", { type: "button", onclick: close, title: "Close" }, "x")),
    h("div", { class: "content" }, content), problem, h("div", { class: "buttons" }, row));
  box.addEventListener("cancel", () => box.remove());
  // A Stop button lent to this dialog goes back to the page when the dialog closes.
  box.addEventListener("close", () => {
    const stop = box.querySelector("#stop");
    if (stop) document.body.append(stop);
  });
  box.addEventListener("keydown", (event) => {
    const primary = (buttons || []).find((b) => b.primary);
    if (event.key === "Enter" && primary && event.target.tagName === "INPUT") {
      event.preventDefault();
      press(primary);
    }
  });
  document.body.append(box);
  box.showModal();
  return { close, problem };
}

function download(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function chooseFile(accept, onFile) {
  document.querySelectorAll("input.chooser").forEach((old) => old.remove());
  // Phones grey out file types they do not know (.dxl, .reqif), so touch screens get no filter.
  const filter = matchMedia("(pointer: coarse)").matches ? undefined : accept;
  const input = h("input", { type: "file", accept: filter, class: "chooser", hidden: true });
  input.addEventListener("change", () => act(() => { input.remove(); return onFile(input.files[0]); }));
  document.body.append(input);
  input.click();
}

function fileSize(text) {
  const bytes = new TextEncoder().encode(text).length;
  const lines = text ? text.replace(/\n$/, "").split("\n").length : 0;
  return `${lines} line${lines === 1 ? "" : "s"}, ${bytes < 1024 ? bytes + " bytes" : (bytes / 1024).toFixed(1) + " KB"}`;
}
