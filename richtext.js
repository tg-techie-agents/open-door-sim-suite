// Formatted text on the page. A document is a list of paragraphs
// {bullet, indent, runs: [{text, style}]}, as the engine gives and takes it
// (see ../rich.ts). Text only ever becomes text nodes; indent and bullets are
// data attributes the style sheet reads, since the page allows no style
// attributes.

const RICH_STEP = 360, RICH_LEVELS = 8; // twips; the deepest the editor indents
// [style bit, element, other elements meaning the same]
const RICH_MARKS = [[1, "B", "STRONG"], [2, "I", "EM"], [4, "U"], [8, "S", "STRIKE", "DEL"], [16, "SUB"], [32, "SUP"]];
const RICH_BLOCKS = new Set(["DIV", "P", "LI", "UL", "OL", "BLOCKQUOTE"]);

const richDoc = (text) => text.split("\n").map((line) => (
  { bullet: false, indent: 0, runs: line ? [{ text: line, style: 0 }] : [] }));
const richPlain = (doc) => doc.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

function richParagraph(p) {
  const line = document.createElement("div");
  line.className = "para";
  if (p.bullet) line.dataset.bullet = "yes";
  if (p.indent) line.dataset.indent = String(p.indent);
  for (const run of p.runs) {
    let node = document.createTextNode(run.text);
    for (let i = RICH_MARKS.length - 1; i >= 0; i--) {
      const [bit, tag] = RICH_MARKS[i];
      if (!(run.style & bit)) continue;
      const around = document.createElement(tag.toLowerCase());
      around.append(node);
      node = around;
    }
    line.append(node);
  }
  if (!p.runs.length) line.append(document.createElement("br"));
  return line;
}

const richNodes = (doc) => doc.map(richParagraph);

// What the editor holds, whatever elements the browser made while editing.
function richRead(area) {
  const doc = [];
  const plain = { bullet: false, indent: 0 };
  let current = null;
  const open = (format) => doc.push(current = { bullet: format.bullet, indent: format.indent, runs: [] });
  const add = (text, style, format) => {
    text.split("\n").forEach((piece, i) => {
      if (i) {
        if (!current) open(format);
        current = null;
      }
      if (!piece) return;
      if (!current) open(format);
      const last = current.runs[current.runs.length - 1];
      if (last && last.style === style) last.text += piece;
      else current.runs.push({ text: piece, style });
    });
  };
  const walk = (node, style, format) => {
    node.childNodes.forEach((child, i) => {
      if (child.nodeType === 3) return add(child.data, style, format);
      if (child.nodeType !== 1) return;
      const tag = child.tagName;
      if (tag === "BR") {
        // the last <br> of a line only holds the line open
        if (i === node.childNodes.length - 1 && (RICH_BLOCKS.has(node.tagName) || node === area)) return;
        if (!current) open(format);
        current = null;
      } else if (RICH_BLOCKS.has(tag)) {
        const inner = {
          bullet: tag === "LI" || !!child.dataset.bullet || format.bullet,
          indent: Number(child.dataset.indent) || format.indent,
        };
        current = null;
        const before = doc.length;
        walk(child, style, inner);
        if (doc.length === before && tag !== "UL" && tag !== "OL") open(inner);
        current = null;
      } else {
        let bits = style;
        for (const [bit, ...tags] of RICH_MARKS) if (tags.includes(tag)) bits |= bit;
        if (tag === "SUB") bits &= ~32;
        if (tag === "SUP") bits &= ~16;
        walk(child, bits, format);
      }
    });
  };
  walk(area, 0, plain);
  if (!doc.length) open(plain);
  return doc;
}

// The paragraphs the selection touches.
function richPicked(area) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return [];
  const range = selection.getRangeAt(0);
  return [...area.querySelectorAll("div.para")].filter((line) => range.intersectsNode(line));
}

function richShift(line, by) {
  const level = Math.max(0, Math.min(RICH_LEVELS, Math.round((Number(line.dataset.indent) || 0) / RICH_STEP) + by));
  if (level) line.dataset.indent = String(level * RICH_STEP);
  else delete line.dataset.indent;
}

// An editor for one document: [the whole control, the editable area, read()].
function richEditor(doc, label) {
  const area = document.createElement("div");
  area.className = "richarea";
  area.contentEditable = "true";
  area.spellcheck = false;
  area.setAttribute("role", "textbox");
  area.setAttribute("aria-multiline", "true");
  area.setAttribute("aria-label", label);
  area.append(...richNodes(doc));
  const paragraphs = (work) => () => richPicked(area).forEach(work);
  const command = (name) => () => document.execCommand(name);
  const tools = [
    ["B", "Bold", command("bold")], ["I", "Italic", command("italic")], ["U", "Underline", command("underline")],
    ["S", "Strikethrough", command("strikeThrough")], ["x₂", "Subscript", command("subscript")],
    ["x²", "Superscript", command("superscript")],
    ["•", "Bullet", () => {
      const lines = richPicked(area), on = lines.some((line) => !line.dataset.bullet);
      for (const line of lines) {
        if (on) line.dataset.bullet = "yes";
        else delete line.dataset.bullet;
      }
    }],
    ["⇤", "Less indent", paragraphs((line) => richShift(line, -1))],
    ["⇥", "More indent", paragraphs((line) => richShift(line, 1))],
  ];
  const bar = document.createElement("div");
  bar.className = "richtools";
  for (const [face, title, work] of tools) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = face;
    button.title = title;
    button.setAttribute("aria-label", title);
    // pressing it must not take the focus, and the selection, away
    button.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (area.getAttribute("contenteditable") !== "true") return;
      if (!area.contains(window.getSelection().anchorNode)) area.focus();
      work();
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    bar.append(button);
  }
  // only text comes in: nothing pasted or dropped brings its own markup
  area.addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
  });
  area.addEventListener("drop", (e) => e.preventDefault());
  const box = document.createElement("div");
  box.className = "richbox";
  box.append(bar, area);
  return [box, area, () => richRead(area)];
}
