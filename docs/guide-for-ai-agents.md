# Guide for an AI assistant helping to write DXL here

Copy this into your assistant's instructions (many tools read a file named
`AGENTS.md` in the project folder).

## Boundaries

- Work only with made-up data in this folder. Never ask for, or accept, exports,
  names, screenshots, or scripts from the user's real DOORS database or employer.
- You never connect to or run anything in real DOORS. The user carries a script
  there, if their rules allow it.

## How to work

1. Ask what the report or tool is for, which links count, and what the output
   must look like. Invent matching sample data (`docs/project-format.md`).
2. Look up what exists before using it: `node src/cli.ts functions <word>`.
   Do not use a function from memory if it is not listed.
3. `node src/cli.ts check script.dxl`, then
   `node src/cli.ts run script.dxl --db sample.odb --dry-run`.
4. Verify the output against facts you planted in the sample data, including an
   item with no link, a deleted object, and an unopened source module.
5. Say what you could not verify. A pass here is not a pass in DOORS.

## DXL habits that matter

- Open the source modules before reading incoming links, or they are silently
  missing (see `openSources` in `scripts/orphan_report.dxl`).
- Skip deleted objects and table structure when counting requirements.
- Put `pragma runLim, 0` at the top of long reports.
- Settings go in one block at the top; reports only read.
- Declare every variable, and clear every `check` warning. Do not name a variable
  after a built-in word.
- Call `softDelete` before `hardDelete`: whether DOORS needs that for an object
  is not confirmed.
- Dialog boxes: build the box, then `show` it as the last statement. Callbacks
  only run in the browser interface, so test them there.
- Avoid a comment that ends in `-`: DXL treats it as joining the next line.
- If the engine refuses something, do not work around it with a guess. Tell the
  user, and point to the DXL Reference Manual.
