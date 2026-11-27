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

**On your computer.** You need [Node.js](https://nodejs.org) 22.18 or later, and
nothing else if `dist/` is already built.

    node src/cli.ts serve          # then open http://127.0.0.1:8765/

`start-mac.command` and `start-windows.bat` do the same by double-click.
Building `dist/` from source needs [bun](https://bun.sh): `sh src/web/build.sh`.

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
- Approximated: placement (`left`, `beside`, `full`, ...) and sizes only roughly
  match; styles and `stacked` are ignored. Message boxes do not pause the
  script. The "Answer Yes to confirm()" tick answers `confirm`; you are not
  asked. There is no file browser, and `progressCancelled` is always false.
- Stricter than DOORS may be: nothing may follow `show` where it is written,
  and `block` is only offered as a top-level statement.
- None of it has been compared with a real DOORS. Look at every box there
  before relying on it.

## Analysis menu

In the browser interface: a traceability wizard that builds link columns (and
the DXL behind them), suspect link filters, columns, details and clearing, and a
link overview and matrix. Project files keep which links are suspect but not the
edits behind them, so a freshly loaded project has no change details to show.

## What it does not do

Run `node src/cli.ts functions` for the DXL that is offered; it is a part of
DXL, not all of it. Anything else is refused by name with a line number.

- No canvases, frames, tabs, splitters, tree views or menu bars in dialog
  boxes (see Dialog boxes above), no OLE (Excel and Word automation), triggers, setting
  access rights, or view definitions (`ViewDef`).
- Columns and saved views work, and are shared with the interface; there is one
  user, so the `can...` questions answer yes where the database allows it.
  Built-in columns have stand-in widths.
- Text is stored without formatting. `richText()` answers only for one line of
  plain ASCII without `\ { }`; there is no `RichText` loop.
- The only code page is `CP_UTF8`.
- `pragma runLim` is accepted and not enforced; the command line stops a script after 10 minutes (`--timeout`). Recursion is limited to a few
  hundred levels. No function-pointer parameters; of operator definitions, only `::` ones.
- ReqIF has not been checked against DOORS.
- Large modules have not been timed.
- Changes are written at once; there is no "close without saving".
- The interface looks like DOORS from general knowledge, not from a copy of it.
- DOORS Next is a different product and is out of scope.

## Where it is stricter than DOORS, or may differ

It refuses rather than guesses, so some scripts DOORS accepts are refused:

- Loop variables must be declared (`Object o` before `for o in m do`).
- To compare or index an attribute value as text, append `""` first.
- An `int` result outside 32 bits stops the script.
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
