# open-door-sim-suite

A practice copy of the DOORS "classic" way of working that runs entirely on your
own computer or in a browser tab: a requirements database, a graphical
interface, and a DXL engine. Use it to write and try scripts and to set up
example modules without touching a real database.

It is not DOORS, it has no connection with IBM, and it has never been compared
with a running copy of DOORS. IBM, Rational, and DOORS are IBM's trademarks.

**Use made-up data only.** Do not copy in exports, names, or scripts from a
confidential or controlled environment, even edited ones. Check your
organisation's rules before you take a script from here into real DOORS.

## Start

**In a browser.** The built interface is a folder of static files (`dist/`).
Served from any web server it needs nothing installed; the database stays in
that browser.

**On your computer.** You need [Node.js](https://nodejs.org) 22.18 or later. A
fresh copy of the source has no built interface (`dist/`), so you also need
[bun](https://bun.sh) once, to build it. The command line below needs only
Node.js.

    sh src/web/build.sh            # once; on Windows run it from Git Bash
    node src/cli.ts serve          # then open http://127.0.0.1:8765/

After the build, `start-mac.command` and `start-windows.bat` start it by
double-click.

The first start shows an invented hobby-greenhouse project with planted faults:
missing links, a "TBD", failed tests, and edits since the last baseline.

## Command line

    node src/cli.ts run scripts/trace_report.dxl          # on a throwaway copy of the example
    node src/cli.ts new work.odb --example                # a database file that keeps changes
    node src/cli.ts run my.dxl --db work.odb --dry-run    # undo database changes afterwards
    node src/cli.ts run my.dxl --data project.json --open "/Project/Module"
    node src/cli.ts check my.dxl                          # find errors without running
    node src/cli.ts functions link                        # what the engine offers
    node src/cli.ts help

Script output goes to standard output. An error goes to standard error with its
line number, and the exit code is 1.

## Scripts to start from

In `scripts/`, each with a settings block at the top. All only read the database.

| Script | Answers |
| --- | --- |
| `trace_report.dxl` | What verifies each requirement, and did it pass? |
| `orphan_report.dxl` | Which requirements lack a parent, a child, or a test? |
| `changed_since_linked.dxl` | Which linked items changed after the link was made? (by date; not the suspect flag) |
| `baseline_changes.dxl` | What was added, deleted, or edited since the last baseline? |
| `requirement_quality.dxl` | Where are TBDs, vague words, or a missing "shall"? |
| `export_attributes.dxl` | Chosen attributes of a module, as CSV |
| `module_inventory.dxl` | How big is each module, and when was it last baselined? |
| `dialog_trace.dxl` | A dialog box: pick modules, write their trace report (browser interface only) |

`scripts/layout/` holds layout DXL for a column: View > DXL column, load
`verified_by.dxl` or `traces_to.dxl`, Apply.

## Files a script may use

A script may have been written by someone else or by an AI, so by default it
reads only inside the folder you started in and the script's own folder, and
writes only data files (`.csv`, `.txt`, and the like) inside the folder you
started in, never into this program. Hidden files and folders are closed to it.
Start it from a project folder, not your home folder. `--any-file` lets a script
read, change, and delete any of your files; use it only for scripts you have
read. In the browser, files live inside the page; download the
ones you want.

`#include` looks in the script's folder and in each folder given with
`--include DIR` (repeatable), which `#include` alone may then read. A name found
in more than one of them stops the script.

## Before you run a script in real DOORS

1. Edit the settings block, with a full path for the output file.
2. Try it first on a small or copied module.
3. Check a few rows by hand, including one you know has a link and one you know
   has none.
4. Passing here does **not** mean DOORS will accept it, or answer the same way.

## Dialog boxes

In the browser interface `show` and `block` put the box on the page, and its
callbacks run when you use it; each one has the same time limit and Stop button
as a script. The command line draws the box as text and runs no callback.

- Offered: fields, text, choices, toggles, radio and check boxes, lists, list
  views with columns, buttons (`apply`, `ok`, `close`), message boxes,
  `confirm`, and progress bars.
- Also offered: frames and tab strips (with `inside` placement), splitters,
  tree views, sliders, status bars, menu bars, right-click menus on lists,
  trees and canvases (also on a button, for touch), and canvases with
  `rectangle`, `box`, `line`, `ellipse`, `polarLine`, `draw`, `drawAngle`,
  `font`, the colour functions, `polygon`, and `width`/`height`.
- Also: `richField` and the `richText` box; `setPos`, `setSize`,
  `setCenteredSize`, `setParent`, `setFocus`, `getBuffer`, `setFromBuffer`, and
  `modified`.
- Tool bars with buttons, toggles, spacers, and combos. There are no icons (the
  include file that names them is not here), so each tool is a button labelled
  with its tool tip. `toolBarMove`, and radio behaviour beyond what the
  script's sensitivity function reports, are not offered.
- Rich elements show formatting given as `richText ...` in their initial value.
  A formatted one is shown, not edited. `get`, `set`, and a plain initial value
  work only for text without `\ { }` and, for `get`, without formatting: the
  manual does not say whether they deal in markup.
- On those: a canvas is repainted when its box is shown and after each action;
  its colour shades and fonts are this suite's. Icons, menu mnemonics and
  Ctrl hot keys are accepted and do nothing. Refused because the manual does not
  settle them: a tree item with no parent or a repeated name, `inactive` on a
  frame, and a second right-click menu.
- Not offered: HTML controls, canvas bitmaps (a script's files here
  are text only), `query` and `messageBox` (a script here cannot wait for the
  answer), reading positions and sizes (`getPos`, `getSize`), printing, mouse
  callbacks and scroll bars, and drag and drop.
- Approximated: placement (`left`, `beside`, `full`, ...) and sizes only roughly
  match; styles and `stacked` are ignored. `setPos` places a box on the page,
  not the screen, and a box is never made larger than the window. A polygon is
  drawn as a closed outline. `modified` is true once the text has been changed
  by hand since the script last set it, as seen when a callback runs. Message boxes do not pause the
  script. The "Answer Yes to confirm()" tick answers `confirm`; you are not
  asked. There is no file browser, and `progressCancelled` is always false.
- Stricter than DOORS may be: nothing may follow `show` where it is written,
  and `block` is only offered as a top-level statement.
- None of it has been compared with a real DOORS. Look at every box there
  before relying on it.

## Formatted text

`String` and `Text` values can be bold, italic, underlined, struck through,
subscript, superscript, bulleted, and indented. In the interface, edit a value
and press Format; a value that is already formatted opens that way. Formatting
is kept in the saved database, baselines, project files, copy and paste, and
ReqIF. CSV carries text only; importing a row whose text is unchanged leaves
its formatting alone.

In DXL: `o."Object Text" = richText "..."` reads the right side as markup,
`richText(o."Object Text")` gives a value as markup, and `for` loops over
`RichTextParagraph` and `RichText` take it apart. Also `isRichText`,
`removeUnlistedRichText`, `findRichText`, `replaceRichText`, `cutRichText`,
`applyTextFormattingToParagraph`, and `richtext_identifier`. A plain assignment
removes formatting. Reading an attribute without `richText` gives plain text, so
history, baseline compare, filters, and exports to CSV see plain text.

Check these in real DOORS before you rely on them:

- How DOORS writes bullets and indent in the markup is not published. Here they
  are `\pard`, `\liN`, and `{\*\pn\pnlvlblt}`. Read formatting through the loops;
  do not pick the markup string apart.
- An empty line comes out of the chunk loop as an empty chunk with `newline`
  set; DOORS may differ.
- Refused: markup other than the above (fonts, colours, tables, whole RTF
  documents), `richText` of characters outside the Windows Western set,
  `richText` beside other text on the right of an attribute assignment,
  `.charset`, `.isUrl` on text that looks like a link, `richTextFragment`,
  `exportRTFString`, `importRTF`, and the clipboard functions.
- A ReqIF file's bulleted list is read as bulleted paragraphs; numbered list
  items keep a "- " instead.

## Analysis menu

In the browser interface: a traceability wizard that builds link columns (and
the DXL behind them), suspect link filters, columns, details and clearing, and a
link overview and matrix. Project files keep which links are suspect but not the
edits behind them, so a freshly loaded project has no change details to show.

## What it does not do

Run `node src/cli.ts functions` for the DXL that is offered; it is a part of
DXL, not all of it. Anything else is refused by name with a line number, and
a real DOORS name that is not here says so, so you can tell it from a typo.
`copyToClipboard` and `activateURL` show what they would copy or open; neither
is done. `platform` answers `WIN32`, and `userLocale` is the US-style locale
dates are already read and written in. `dxlHere()` can only be printed, and
what it prints is this suite's own wording.

- No OLE (Excel and Word automation). No HTML controls in
  dialog boxes (see Dialog boxes above).
- Triggers: persistent module open, object sync, and attribute save triggers,
  pre and post. They run for what you do in the interface. A script, an import,
  or anything else that would reach one stops, because the manuals do not say
  whether DOORS fires it then. No dynamic, drag-and-drop, project level, module
  close, or object open triggers.
- A trigger cannot keep you out of your data. A post trigger that fails or runs
  past 5 seconds is reported and the action stands (only its own changes are
  dropped). If a module is kept shut, the interface offers to open it without
  its open triggers, and Tools, Triggers... lists and removes any trigger. Those
  two are this suite's own; opening a link module's list runs no triggers. A pre
  trigger that fails still stops what it watches. What DOORS does when a trigger
  fails has not been checked.
- Access rights that stop you changing something are cleared by Database,
  Access rights..., Reset (as database manager), also this suite's own.
- Users, groups, and access rights can be set and are enforced, including on
  attribute definitions, attribute values, and views. You are one user, and
  rights under which you could not read something are refused: nothing is ever
  hidden. No passwords, LDAP, or user details beyond names.
- A view definition (`ViewDef`) keeps columns only: not a script's filter or
  sort, and a view is saved only with its other settings off.
- In the interface, Help lists what is full, partial, and not offered, and DXL
  coverage name by name. Offered there means at least one form works.
- Baseline sets, module copy, and history sessions work in part; a script stops
  where the manuals do not say what DOORS would do.
- One person at a time. A script can lock and unlock a closed module, for that
  run only; there are no lock lists, section locks, or shareable editing.
- Columns and saved views work, and are shared with the interface. Built-in
  columns have stand-in widths.
- Formatted text has no fonts, colours, links, pictures, tables, or numbered
  lists (see Formatted text above).
- The only code page is `CP_UTF8`.
- A script or include file that is not UTF-8 is read as Windows-1252 (Western
  European). One saved in another code page would be misread: save it as UTF-8.
  A script given other text with unreadable characters is refused.
- `pragma runLim` is accepted and not enforced; the command line stops a script after 10 minutes (`--timeout`). Recursion is limited to a few
  hundred levels. No function-pointer parameters; of operator definitions, only `::` ones.
- ReqIF has not been checked against DOORS.
- Large modules: timed only headless on one machine, up to 20,000 objects per
  module. Every edit saves the whole database, so edits take about a second at
  that size. Above 500 rows the grid draws only the rows near the screen, so the
  browser's own find and copy reach only those (the filter and exports cover
  everything), and column widths can shift while scrolling.
- Changes are written at once; there is no "close without saving".
- The interface looks like DOORS from general knowledge, not from a copy of it.
- DOORS Next is a different product and is out of scope.

## Where it is stricter than DOORS, or may differ

It refuses rather than guesses, so some scripts DOORS accepts are refused:

- Loop variables must be declared (`Object o` before `for o in m do`).
- To compare or index an attribute value as text, append `""` first.
- An `int` result outside 32 bits stops the script.
- A join that does not end with a string (`print "count: " n`) is refused; add
  `""` or `"\n"`.
- A `Skip` list made with `create` refuses string keys; use `createString`.
- Reading an empty integer, real, or Boolean attribute into a variable stops.
  So does reading, from DXL, an attribute on an object older than the attribute
  until the object is given a value.
- Opening an already open module in another mode inside a `for` loop stops, and
  so does `close(m)` with unsaved changes (use `close(m, true)`, or save first).
- A day-first slash date such as `23/05/2031` is invalid: slash dates are read
  month first, as in a US locale. Your DOORS may read and print dates differently.
- `contains()` on a buffer stops where the word starts exactly at the offset.
- After `delete(link)`, anything that would show whether the link is gone yet
  stops until `flushDeletions()`; call it before `close` of that module.
- `softDelete` and `hardDelete` stop on an object with incoming links or with
  objects below it.
- Project, folder, and module names take only letters, digits, spaces, periods,
  underscores, and hyphens.
- `<?` and `>?` need parentheses when another operator is beside them.
- `goodFileName()` takes letters, digits, spaces, `_` and `-`; anything else
  stops the script. `itemFromID()` of a deleted item stops it too, and it knows
  only this database's own IDs, not any from real DOORS.
- A few cases whose DOORS behaviour is unclear stop with a message: case in
  `contains()` filters without the case argument, ordering comparisons on string
  or empty values, sorting with empty values, incoming-link filters while a
  source module is closed.

It may also accept something DOORS rejects. For example, it does not stop you
from naming a variable after a built-in DOORS word.

As in DOORS, an incoming link is invisible until its source module is open.

## How far to trust it

Behaviour was written from IBM's public DXL Reference Manual 9.2 and Using DOORS
9.2 (not included here):
<https://public.dhe.ibm.com/software/rationalsdp/documentation/product_doc/DOORS/version_9-2/>

Tests: `node --test test/`. They show the engine does what was intended, not
that DOORS does the same.

## Layout

`src/` the program (`store.ts` the database, `dxl/` the engine, `io/` import and
export, `web/` the interface, `cli.ts` the command line), `scripts/` DXL,
`examples/` the greenhouse project, `docs/project-format.md` how to write your
own example projects in JSON, `docs/guide-for-ai-agents.md` what to give an AI
assistant, `test/`.
