"use strict";
// The one list of what this tool offers. Every menu entry is made from it, so a
// greyed entry's reason and the Help page cannot say different things. Loaded
// last: the functions it names are in app.js, trace.js and extras.js.
//
// id: [area, label, status, note, where]
//   status: "full", "part" (works, with the limit in the note), "no" (not offered; the note says why).
//   where: for what no menu holds.

const ONE_USER = "one person, one browser: there is nobody to share or lock with";
const NO_RICH = "not built: formatted text holds no links or pictures";
const NO_TABLES = "tables are not built";
const NO_PROPOSALS = "change proposals are not built";
const NO_EXTERNAL = "external links are not built";

const FEATURES = {
  // database explorer
  treePane: ["Database", "Database tree and contents", "full", "", "left of the window; a folder's contents in the main area"],
  newProject: ["Database", "New project...", "full", ""],
  newFolder: ["Database", "New folder...", "full", ""],
  newFormal: ["Database", "New formal module...", "part", "name, description, starting number and ID prefix; no templates"],
  newLinkModule: ["Database", "New link module...", "part", "name and description; always many-to-many, with no choice of mapping"],
  openDialog: ["Database", "Open module...", "full", ""],
  openExclusive: ["Database", "Open (exclusive edit)", "part", "you are the only user, so no lock is taken"],
  openReadOnly: ["Database", "Open read-only", "part", "holds for editing on screen; a DXL run then has its database changes undone, but a script's dialog box buttons are not held to it"],
  openShareable: ["Database", "Open shareable edit", "no", ONE_USER],
  closeModule: ["Database", "Close module", "full", ""],
  saveModule: ["Database", "Save", "no", "every change is saved as you make it (to keep a copy: Database, Save database to a file)"],
  upLevel: ["Database", "Up one level", "full", ""],
  location: ["Database", "Go to location...", "full", ""],
  searchDatabase: ["Database", "Search database...", "part", "finds items by name and description, not by what objects hold"],
  itemProperties: ["Database", "Item properties / rename...", "full", ""],
  deleteItem: ["Database", "Delete item...", "full", ""],
  undeleteItem: ["Database", "Undelete item", "full", ""],
  purgeItem: ["Database", "Purge item...", "part", "only an item already deleted, with all it holds; cannot be undone"],
  projectToggle: ["Database", "Make project / make folder", "full", ""],
  moveItem: ["Database", "Cut, copy or paste item", "no", "moving folders or modules and copying folders is not built; to copy a module use Copy module"],
  copyModule: ["Database", "Copy module...", "part", "a formal module beside itself under a new name, with views and out-links; not in-links or baselines. Refused where what DOORS does is not documented: deleted objects, links inside the module, access rights of its own"],
  showDeletedItems: ["Database", "Show deleted items", "full", ""],
  accessRights: ["Database", "Access rights...", "part", "read, create, modify, delete and admin, for a folder, project, module or object, by user or group name; enforced on changes. Rights on attributes and views are set from a script, not here. Nothing can be hidden from you"],
  users: ["Database", "Manage users and groups...", "no", "no screen for it: a script makes users and groups (addUser, addGroup, addMember, saveDirectory), and access rights then go by them"],
  copyUrl: ["Database", "Copy URL", "no", "there are no DOORS addresses here"],
  favouriteAdd: ["Database", "Add to favourites", "part", "favourites are kept in this browser, not in the database"],
  favouriteOrganise: ["Database", "Organise favourites...", "part", "remove and reorder; kept in this browser"],
  favouriteOpen: ["Database", "Open a favourite", "full", "", "Favourites menu, once you have added one"],
  moduleProperties: ["Database", "Module properties...", "part", "no access settings"],
  statistics: ["Database", "Module statistics...", "full", ""],
  importCsv: ["Import and export", "Import CSV...", "part", "this tool's column names; no import wizard to map other layouts"],
  exportCsv: ["Import and export", "Export CSV...", "full", ""],
  exportView: ["Import and export", "Export view to CSV", "full", ""],
  importReqif: ["Import and export", "Import ReqIF...", "part", "pictures and embedded objects are dropped, and it says so"],
  exportReqif: ["Import and export", "Export ReqIF...", "part", "not checked by importing the file into DOORS"],
  exportWord: ["Import and export", "Export to Word", "no", "not built; export CSV or ReqIF, or print to PDF"],
  print: ["Import and export", "Print...", "part", "the columns and rows on screen through the browser; not just the selected objects"],
  pageSetup: ["Import and export", "Page setup...", "no", "use the browser's own print settings"],
  reports: ["Import and export", "Saved reports...", "no", "make reports with Export view, Print, or a DXL script"],
  saveDatabase: ["Import and export", "Save database to a file", "full", ""],
  openDatabase: ["Import and export", "Open database file...", "full", ""],
  writtenFiles: ["Import and export", "Files written by scripts...", "full", ""],
  resetExample: ["Import and export", "Reset to the example project...", "full", ""],
  // modes and locks
  modeExclusive: ["Editing", "Exclusive edit", "part", "you are the only user, so no lock is taken"],
  modeReadOnly: ["Editing", "Read-only", "part", "holds for editing on screen; a DXL run then has its database changes undone, but a script's dialog box buttons are not held to it"],
  modeShareable: ["Editing", "Shareable edit", "no", ONE_USER],
  locks: ["Editing", "Lock or unlock section", "no", ONE_USER],
  manageLocks: ["Editing", "Manage locks and open modules...", "no", "one module is open at a time, and nothing is locked"],
  sharing: ["Editing", "Set up for sharing...", "no", ONE_USER],
  // editing
  undo: ["Editing", "Undo", "part", "value edits, replacements, deletions and Move up or down made on screen; not promote, demote, split, paste, new objects or links"],
  extendedUndo: ["Editing", "Extended undo...", "no", "only one step at a time: use Undo repeatedly"],
  cut: ["Editing", "Cut", "part", "the object or selection with everything below; nothing moves until you paste (DOORS takes them out at once). Within one module"],
  copy: ["Editing", "Copy", "part", "the current object only, or the whole selection; links are not copied. Unlike DOORS it can be pasted into another module"],
  copyHierarchy: ["Editing", "Copy with hierarchy", "part", "links are not copied. Unlike DOORS it can be pasted into another module"],
  paste: ["Editing", "Paste after", "full", ""],
  pasteChild: ["Editing", "Paste below (child)", "full", ""],
  pasteModule: ["Editing", "Paste special: new module...", "no", "make the module, then paste into it"],
  copier: ["Editing", "Object copier...", "no", "use Copy and Paste, or export and import CSV"],
  selectAll: ["Editing", "Select all objects", "full", ""],
  setMany: ["Editing", "Edit attribute of several objects...", "full", "the current object, the selected objects, or those in the current view"],
  find: ["Editing", "Find...", "part", "plain text over the ID and every attribute of the objects on screen; no regular expressions or choice of attributes"],
  findNext: ["Editing", "Find next", "full", ""],
  findPrevious: ["Editing", "Find previous", "full", ""],
  replace: ["Editing", "Replace...", "part", "plain text, no regular expressions. Replace: every occurrence in the current object; Replace all: the whole module. In heading and text, or all String and Text attributes"],
  goTo: ["Editing", "Go to...", "part", "section number (2.1 or 2.), absolute number or ID, among the objects on screen; no list of earlier entries"],
  properties: ["Editing", "Object properties", "part", "attribute values and links; no per-object access settings"],
  editText: ["Editing", "Edit text", "full", ""],
  editHeading: ["Editing", "Edit heading", "full", ""],
  editObjectText: ["Editing", "Edit Object Text", "full", ""],
  accept: ["Editing", "Accept and discard buttons", "full", "", "beside a cell being edited (also Ctrl+Enter and Esc)"],
  nextAttribute: ["Editing", "Edit next attribute", "no", "double-click the next cell"],
  resetDefault: ["Editing", "Reset to default", "no", "type the default, or clear the value"],
  newObject: ["Editing", "Object (same level)", "full", ""],
  newChild: ["Editing", "Object below (child)", "full", ""],
  newBefore: ["Editing", "Object before", "full", ""],
  newEnd: ["Editing", "Object at end of module", "full", ""],
  moveUp: ["Editing", "Move up", "full", "not while a sort or filter is on"],
  moveDown: ["Editing", "Move down", "full", "not while a sort or filter is on"],
  promote: ["Editing", "Promote", "full", "one object or the selection; not while a sort or filter is on"],
  demote: ["Editing", "Demote", "full", "one object or the selection; not while a sort or filter is on"],
  swap: ["Editing", "Swap heading and text", "full", ""],
  splitHeading: ["Editing", "Split heading from text", "full", "a new object takes the heading; this one keeps its text and links and goes below it"],
  splitObject: ["Editing", "Split object at blank lines", "part", "splits Object Text at its blank lines, not at the cursor"],
  merge: ["Editing", "Merge object text", "no", "not built: edit one object's text by hand"],
  deleteObject: ["Editing", "Delete object...", "full", "with everything below; refused while any of them has an in-link"],
  undeleteObject: ["Editing", "Undelete object", "full", ""],
  purge: ["Editing", "Purge deleted objects...", "full", ""],
  purgeObject: ["Editing", "Purge this object...", "full", "with everything below it"],
  spelling: ["Editing", "Spelling...", "no", "no spell checker here; your browser may underline words as you type"],
  symbol: ["Editing", "Insert symbol", "no", "type or paste the character; text is Unicode"],
  insertUrl: ["Editing", "Insert URL", "no", NO_RICH],
  template: ["Editing", "Insert template", "no", "templates are not built"],
  picture: ["Editing", "Insert picture or OLE object", "no", NO_RICH],
  oleProperties: ["Editing", "OLE object properties and size", "no", "there are no OLE objects here"],
  richText: ["Editing", "Bold, italic, underline, indent, bullets", "part", "strikethrough, subscript and superscript too, in String and Text values; no fonts, colours, numbered lists or tables"],
  tables: ["Editing", "Table: insert, rows, columns, properties", "no", NO_TABLES],
  forms: ["Editing", "Forms: new, run, edit, delete", "no", "forms are not built; edit in Properties"],
  dragObjects: ["Editing", "Drag and drop objects or items", "part", "drag one object by its ID onto another in the same module: before, after, or as its child. Not several objects, items in the explorer, links, or touch screens", "mouse"],
  multiSelect: ["Editing", "Select several objects", "part", "neighbours at one level with everything below them, widened to a common parent, including objects a filter hides (no Ctrl+click: a DOORS module window has none either). Move, delete, copy, cut, link and Edit attribute act on them; not printed or saved with a view", "Shift+click an object; Esc clears"],
  explorerSelect: ["Database", "Select several items", "no", "one item at a time in the database tree", "Ctrl or Shift click"],
  objectKeys: ["Editing", "Keyboard movement", "part", "up, down, parent (Left), first child (Right), first and last; the keys do not extend a selection", "arrow keys, Home, End"],
  // view
  columns: ["Views", "Columns...", "full", ""],
  columnInsert: ["Views", "Insert column...", "part", "attribute columns; DXL and traceability columns have their own entries"],
  columnProperties: ["Views", "Column properties...", "part", "title, width, alignment, attribute and position"],
  columnRemove: ["Views", "Remove column", "full", ""],
  columnHeader: ["Views", "Column heading menu", "full", "", "click or right-click a column heading"],
  autoIndent: ["Views", "Auto-indent main column", "part", "always on", "the main column"],
  dxlColumn: ["Views", "DXL column...", "part", "layout DXL as far as the DXL engine here goes (see DXL coverage)"],
  columnWizards: ["Views", "Graph or icon column wizard...", "no", "not built; a DXL column can compute text"],
  moduleExplorer: ["Views", "Module Explorer", "full", ""],
  showInExplorer: ["Views", "Show in Module Explorer", "full", ""],
  explorerFilter: ["Views", "Apply filtering to Module Explorer", "full", ""],
  graphics: ["Views", "Graphics mode", "no", "no diagram view of the hierarchy or of links"],
  documentMode: ["Views", "Document mode", "full", ""],
  outlining: ["Views", "Outlining", "full", "shows only objects that have a heading, without their text"],
  level: ["Views", "Show levels", "full", "an object with objects below the level shown is marked >"],
  collapse: ["Views", "Collapse below this object", "full", ""],
  expand: ["Views", "Expand this object", "full", ""],
  expandAll: ["Views", "Expand all", "full", ""],
  savedViews: ["Views", "Saved views list", "full", "", "the view list on the toolbar"],
  saveView: ["Views", "Save view...", "part", "columns, filter, sort and link columns; not levels, outlining, descending order, advanced filter or selection"],
  deleteView: ["Views", "Delete view...", "part", "no default view or view ordering"],
  reloadView: ["Views", "Reload view", "full", ""],
  defaultView: ["Views", "Set default view", "no", "a module always opens in the Standard view"],
  filter: ["Filter and sort", "Filter...", "full", ""],
  advancedFilter: ["Filter and sort", "Advanced filter...", "part", "several conditions joined by all or any; no nesting; not saved with views"],
  filterOn: ["Filter and sort", "Filtering on", "part", "the filter follows the current values at once; DOORS keeps its last result until you reapply"],
  sort: ["Filter and sort", "Sort...", "part", "one attribute, ascending or descending (DOORS can sort on several)"],
  sortOn: ["Filter and sort", "Sorting on", "part", "the sort follows the current values at once; DOORS keeps its last order until you reapply"],
  reapply: ["Filter and sort", "Reapply filter and sort", "part", "not needed here, as filter and sort follow the current values; this redraws"],
  clearFilter: ["Filter and sort", "Clear filter and sort", "full", ""],
  linkColumnFilter: ["Filter and sort", "Filter on links and columns...", "full", ""],
  showDeleted: ["Views", "Show deleted objects", "full", ""],
  outColumn: ["Views", "Out-links column", "full", ""],
  inColumn: ["Views", "In-links column", "full", ""],
  linkArrows: ["Views", "Link arrows", "full", ""],
  showPictures: ["Views", "Show pictures, table cells or markup", "no", "there are no pictures, tables or markup here"],
  colour: ["Views", "Colour coding and display schemes...", "no", "one fixed set of colours"],
  options: ["Views", "User options and toolbars...", "no", "nothing to customise"],
  refresh: ["Views", "Refresh", "full", ""],
  // history and baselines
  objectHistory: ["History and baselines", "Object history...", "full", ""],
  moduleHistory: ["History and baselines", "Module history...", "full", ""],
  baselines: ["History and baselines", "Baselines...", "part", "view and compare; describe sets. No copy, delete or signing"],
  newBaseline: ["History and baselines", "New baseline...", "full", ""],
  copyBaseline: ["History and baselines", "Copy baseline...", "no", "not built: Copy module copies the current version, not a baseline"],
  deleteBaseline: ["History and baselines", "Delete baseline...", "no", "not built (DOORS lets only a database manager do this, and by default nobody)"],
  baselineSets: ["History and baselines", "Baseline sets...", "part", "define, create, add modules and close; no signing or comparing of sets, and a definition with sets is not deleted. Refused where DOORS numbering is not documented: a set with a suffix, or a module whose own next number differs"],
  compare: ["History and baselines", "Compare with baseline...", "part", "attribute values and which objects exist; not moves or links"],
  compareModules: ["History and baselines", "Compare two modules...", "no", "compares a module with its own baselines only"],
  changeBars: ["History and baselines", "Change bars", "part", "marks objects added or with changed values since the latest baseline; not moves or links"],
  redline: ["History and baselines", "Redline column...", "part", "word changes against one baseline of this module"],
  signatures: ["History and baselines", "Electronic signatures...", "no", "not built: a signature here would prove nothing"],
  // links
  startLink: ["Links", "Start link", "full", "with several selected, asks for all of them or only the current object"],
  linkFrom: ["Links", "Make link from start", "full", "with several selected, asks for all or the current one"],
  linkTo: ["Links", "Make link to start", "full", "with several selected, asks for all or the current one"],
  clearStart: ["Links", "Clear link start", "full", ""],
  createLink: ["Links", "Create link...", "full", ""],
  editLinks: ["Links", "Show or edit object's links", "part", "follow, delete and clear suspect; link attributes are not shown"],
  linkMenu: ["Links", "Link arrow menu", "full", "", "click or right-click a link arrow"],
  showLinked: ["Links", "Go to linked object", "full", ""],
  deleteLinks: ["Links", "Delete out-links of current or selected...", "full", "all the out-links of the current object or the selection"],
  createLinks: ["Links", "Create links...", "part", "from the current object, selection or view of this module to every object of a target module, or those picked from a list (the target is not opened, so its own view and selection are not used); every source is linked to every target"],
  deleteLinksBulk: ["Links", "Delete links...", "part", "out-links from the current object, selection or view to a target module through one link module; the target's objects are picked from a list, not selected in its window"],
  deleteAllLinks: ["Links", "Delete all links in this module...", "full", ""],
  linkByAttribute: ["Links", "Link by attribute...", "part", "absolute numbers (or identifiers) listed in a String or Text attribute, to one target module, in either or both directions"],
  linkModuleWindow: ["Links", "Link module window", "part", "list by linkset, open either end, delete links, make and delete linksets; no new link, link attributes or graph", "open a link module"],
  linkAttributes: ["Links", "Edit link attributes...", "no", "link attributes are not shown or edited on screen"],
  externalLinks: ["Links", "External links...", "no", NO_EXTERNAL],
  linkSettings: ["Links", "Link module rules...", "part", "default linkset pairings and link limits, kept per folder (also from Module properties, Linksets); both modules must already exist"],
  defaultLink: ["Links", "Set default link module...", "full", ""],
  linksets: ["Links", "New and delete linkset", "part", "deleting a linkset deletes its links; no new single link from this window", "open a link module"],
  triggers: ["DXL", "Triggers...", "part", "lists every stored trigger with its DXL, and removes one. A script defines them (module open, object sync, attribute save), and they run for what you do here"],
  // analysis
  wizard: ["Traceability", "Traceability wizard...", "part", "writes layout DXL columns; run here only, not checked in DOORS"],
  traceColumns: ["Traceability", "Traceability columns...", "full", ""],
  traceExplorer: ["Traceability", "Traceability Explorer", "no", "not built; the wizard columns and the matrix cover chains"],
  linkAnalysis: ["Traceability", "Link overview and matrix...", "part", "coverage per link module pair, matrix and CSV; this tool's own layout"],
  suspectFilter: ["Suspect links", "Suspect links: filter...", "full", ""],
  suspectBoth: ["Suspect links", "Suspect links: indicators...", "full", ""],
  suspectIn: ["Suspect links", "Indicators: in-links (all modules)", "full", ""],
  suspectOut: ["Suspect links", "Indicators: out-links (all modules)", "full", ""],
  suspectOpen: ["Suspect links", "Indicators: open modules only", "no", "one module is open at a time here"],
  suspectLast: ["Suspect links", "Suspect links: last change...", "full", ""],
  suspectAll: ["Suspect links", "Suspect links: all changes...", "full", ""],
  suspectClear: ["Suspect links", "Suspect links: clear...", "full", ""],
  suspectClearAll: ["Suspect links", "Suspect links: clear all...", "full", ""],
  // attributes
  attributes: ["Attributes", "Attribute definitions...", "part", "add, copy, edit and delete; for objects or the module, not both; no access settings on definitions or values"],
  newAttribute: ["Attributes", "New attribute...", "full", ""],
  types: ["Attributes", "Attribute types...", "part", "new, copy, edit and delete; no Username base type, related numbers, colours or access settings. A value in use can be renamed or added to, not removed"],
  recalculate: ["Attributes", "Recalculate DXL attributes", "full", ""],
  copyAttributes: ["Attributes", "Copy attributes...", "no", "not built; a DXL script can copy values"],
  // DXL
  dxl: ["DXL", "DXL editor...", "part", "runs the DXL this engine implements (see DXL coverage); anything else is refused by name"],
  dxlLibrary: ["DXL", "Browse DXL library...", "part", "the supplied scripts, from the list in the DXL window"],
  dxlEditing: ["DXL", "Find, replace, go to line in the DXL editor", "no", "only the browser's own editing; clicking an error goes to its line", "DXL window"],
  dxlCoverage: ["Help", "DXL coverage...", "full", ""],
  layoutConvert: ["DXL", "Convert layout DXL to attribute DXL", "no", "make a new attribute and paste the code"],
  // not offered at all
  discussions: ["Other", "Discussions...", "no", "discussions are not built"],
  proposals: ["Other", "Change proposals: submit, review, apply", "no", NO_PROPOSALS],
  testTracking: ["Other", "Test tracking...", "no", "not built; keep tests as objects in a module, and link them"],
  markup: ["Other", "Descriptive module markup", "no", "not built"],
  partitions: ["Other", "Partition and rejoin", "no", "there is no second database to send to"],
  // status and indicators
  statusBar: ["Indicators", "Status bar: edit mode and current object", "full", "", "bottom of the window"],
  suspectMark: ["Indicators", "Suspect link marker", "full", "", "S beside the object, SUSPECT beside the link"],
  deletedStyle: ["Indicators", "Deleted objects in red, struck out", "full", "", "View, Show deleted objects"],
  startMark: ["Indicators", "Link start marker", "full", "", "beside the object a link starts at"],
  lockMarks: ["Indicators", "Lock icons and section colours", "no", ONE_USER, "tree and module window"],
  unsavedBar: ["Indicators", "Change bar for unsaved changes", "no", "nothing is ever left unsaved", "left of an object"],
  // help
  helpPage: ["Help", "What this tool does and does not do...", "full", ""],
  keys: ["Help", "Keys and markers...", "full", ""],
};

const STATUS_NAMES = { full: "Full", part: "Partial", no: "Not offered" };

// A menu entry: [label, action, key hint, why it cannot be done now, feature id].
function M(id, action, why, key, label) {
  return [label || FEATURES[id][1], action, key || "", why || "", id];
}
// One that is not offered: greyed, with the catalogue's reason.
const X = (id, label) => [label || FEATURES[id][1], null, "", FEATURES[id][3], id];
const SUB = (label, entries) => [label, entries, "", "", null];

const editModeEntries = () => [
  M("modeExclusive", () => setReadOnly(false), can.current(), "", tick(!!S.data && !S.readOnly, FEATURES.modeExclusive[1])),
  M("modeReadOnly", () => setReadOnly(true), can.current(), "", tick(!!S.data && S.readOnly, FEATURES.modeReadOnly[1])),
  X("modeShareable"),
];

function itemMenu() {
  const node = pickedItem();
  const newWhy = containerForNew().deleted ? "that folder is deleted" : "";
  const own = node.id === 1 ? "pick a folder, project, or module in the tree" : "";
  const openWhy = node.kind === "formal" || node.kind === "link" ? (node.deleted ? "the item is deleted" : "") : "pick a module";
  const formalWhy = node.kind === "formal" && !node.deleted ? "" : "pick a formal module";
  return [
    M("openExclusive", () => openModuleAs(node.id, false), openWhy),
    M("openReadOnly", () => openModuleAs(node.id, true), formalWhy),
    X("openShareable"),
    null,
    M("newProject", () => newItem("project", "project"), newWhy),
    M("newFolder", () => newItem("folder", "folder"), newWhy),
    M("newFormal", () => newItem("formal", "formal module"), newWhy),
    M("newLinkModule", () => newItem("link", "link module"), newWhy),
    null,
    M("itemProperties", itemProperties, own || (node.deleted ? "the item is deleted" : "")),
    M("deleteItem", deleteItem, own || (node.deleted ? "already deleted" : "")),
    M("undeleteItem", undeleteItem, node.deleted ? "" : "the item is not deleted"),
    M("showDeletedItems", async () => { S.showDeletedItems = !S.showDeletedItems; await loadTree(); }, "", "",
      tick(S.showDeletedItems, FEATURES.showDeletedItems[1])),
    M("favouriteAdd", addFavourite, own),
    SUB("More", [
      M("purgeItem", purgeItemDialog, own || (node.deleted ? "" : "delete the item first")),
      M("projectToggle", toggleProject, node.kind === "folder" || node.kind === "project" ? own : "pick a folder or project",
        "", node.kind === "project" ? "Make folder" : "Make project"),
      M("linkSettings", linkRulesDialog, containerForNew().id === 1 ? "pick something inside a folder or project" : ""),
      M("accessRights", itemAccess, node.deleted ? "the item is deleted" : ""),
      M("copyModule", () => copyModuleDialog(node), formalWhy), X("moveItem"), X("copyUrl")]),
  ];
}

const moveEntries = () => [M("moveUp", () => move("up"), can.move("up")), M("moveDown", () => move("down"), can.move("down")),
  M("promote", () => move("promote"), can.move("promote")), M("demote", () => move("demote"), can.move("demote"))];

const insertObjectEntries = () => [
  M("newObject", () => addObject("after"), can.insert(), "Ins"),
  M("newChild", () => addObject("child"), can.change(), "Shift+Ins"),
  M("newBefore", () => addObject("before"), can.change()),
];

const clipboardEntries = () => [
  M("cut", () => clipTake(true), can.change(), "Ctrl+X"),
  M("copy", () => clipTake(false), can.object(), "Ctrl+C"),
  M("copyHierarchy", () => clipTake(false, true), can.object()),
  M("paste", () => paste("after"), can.paste(), "Ctrl+V"),
  M("pasteChild", () => paste("child"), can.paste()),
];

// "" when the selected object has what an operation needs, else the reason.
const needs = (test, why) => {
  const row = S.data && selectedRow();
  return row && test(row) ? "" : why;
};

const contentEntries = () => [
  M("swap", swapHeadingText, can.change()),
  M("splitHeading", splitHeading, can.change()
    || needs((row) => row.values["Object Heading"] && row.values["Object Text"], "needs both a heading and text")),
  M("splitObject", splitObject, can.change()
    || needs((row) => /\n[ \t]*\n/.test(row.values["Object Text"] || ""), "no blank line in the text")),
  X("merge"),
];

const linkEntries = () => [
  M("startLink", startLink, can.change()),
  M("linkFrom", finishLink, can.linkEnd()),
  M("linkTo", linkToStart, can.linkEnd()),
  M("clearStart", clearLinkStart, S.linkStart ? "" : "no link has been started"),
  M("createLink", linkDialog, can.change()),
];

function objectMenu() {
  const row = S.data && selectedRow();
  return [
    M("properties", showProps, can.object(), "Enter"),
    M("setMany", manyDialog, can.change()),
    M("editHeading", () => editNamed("Object Heading"), can.change()),
    M("editObjectText", () => editNamed("Object Text"), can.change(), "F2"),
    null,
    ...insertObjectEntries(),
    null,
    ...clipboardEntries(),
    null,
    ...moveEntries(),
    M("deleteObject", deleteObject, can.remove(), "Del"),
    M("undeleteObject", undeleteObject, can.undelete()),
    null,
    ...linkEntries(),
    SUB("Linked objects", linkedEntries(row)),
    null,
    M("objectHistory", () => historyDialog(needObject().absno), can.object()),
    M("showInExplorer", showInOutline, can.object()),
    M("collapse", () => setCollapsed(true), can.object()),
    M("expand", () => setCollapsed(false), can.object()),
    M("accessRights", objectAccess, can.object()),
    SUB("More", [...contentEntries(), X("discussions"), M("richText", formatMain, can.change()), X("externalLinks")]),
  ];
}

const MENUS = {
  File: () => [
    M("openDialog", openDialog),
    M("closeModule", closeModule, can.module()),
    X("saveModule"),
    SUB("Database item", itemMenu()),
    M("upLevel", upLevel, S.picked === 1 ? "already at the top" : "", "Alt+Up"),
    M("location", locationDialog),
    M("searchDatabase", searchDialog),
    null,
    M("moduleProperties", modulePropertiesDialog, can.module()),
    M("statistics", statisticsDialog, can.module()),
    M("baselines", baselinesDialog, can.module()),
    M("newBaseline", newBaselineDialog, can.newBaseline()),
    M("baselineSets", baselineSetsDialog),
    X("copyBaseline"),
    X("deleteBaseline"),
    null,
    SUB("Import", [M("importCsv", importCsv, can.write()),
      M("importReqif", importReqif, containerForNew().deleted ? "that folder is deleted" : "")]),
    SUB("Export", [M("exportCsv", exportCsv, can.module()), M("exportView", exportView, can.module()),
      M("exportReqif", exportReqifDialog, formalModules().length ? "" : "there is no formal module"), X("exportWord")]),
    M("print", () => window.print(), can.module(), "Ctrl+P"),
    X("pageSetup"),
    X("reports"),
  ],
  Edit: () => [
    M("undo", undo, S.data && S.readOnly ? "the module is open read-only" : S.undo.length ? "" : "nothing to undo", "Ctrl+Z", S.undo.length ? `Undo ${S.undo.at(-1).label}` : "Undo"),
    X("extendedUndo"),
    null,
    ...clipboardEntries(),
    X("pasteModule"),
    M("selectAll", selectAll, can.module()),
    M("setMany", manyDialog, can.write()),
    null,
    M("find", () => openFind(false), can.module(), "Ctrl+F"),
    M("findNext", () => findStep(1), can.module() || (S.find.text ? "" : "use Find first"), "Ctrl+G"),
    M("findPrevious", () => findStep(-1), can.module() || (S.find.text ? "" : "use Find first")),
    M("replace", () => openFind(true), can.write()),
    M("goTo", goToDialog, can.module()),
    M("attributes", attributesDialog, can.module()),
    M("types", typesDialog, can.module()),
    null,
    M("properties", showProps, can.object(), "Enter"),
    M("editText", editMain, can.change(), "F2"),
    M("editHeading", () => editNamed("Object Heading"), can.change()),
    M("editObjectText", () => editNamed("Object Text"), can.change()),
    SUB("Object", [...insertObjectEntries(), ...moveEntries(), ...contentEntries(),
      M("deleteObject", deleteObject, can.remove(), "Del"), M("undeleteObject", undeleteObject, can.undelete()),
      M("purgeObject", purgeObject, can.undelete()), M("purge", purgeDialog, can.write()), X("copier")]),
    SUB("In place", [X("nextAttribute"), X("resetDefault"), X("spelling")]),
    SUB("Edit mode", editModeEntries()),
    SUB("Locks", [X("locks"), X("manageLocks"), X("sharing")]),
  ],
  View: () => [
    M("moduleExplorer", toggleOutline, can.module(), "", tick(S.outline, FEATURES.moduleExplorer[1])),
    M("outlining", () => { S.outlining = !S.outlining; render(); }, can.module(), "", tick(S.outlining, FEATURES.outlining[1])),
    SUB("Levels", [
      M("level", () => setLevel(0), can.module(), "", tick(!S.maxLevel, "All levels")),
      ...[1, 2, 3, 4, 5, 6].map((n) => M("level", () => setLevel(n), can.module(), "", tick(S.maxLevel === n, `Level ${n}`))),
      M("collapse", () => setCollapsed(true), can.object()),
      M("expand", () => setCollapsed(false), can.object()),
      M("expandAll", expandAll, can.module())]),
    M("documentMode", () => say("This is document mode, the only mode here."), can.module(), "", tick(true, FEATURES.documentMode[1])),
    X("graphics"),
    null,
    SUB("Columns", [M("columns", columnsDialog, can.module()),
      M("columnInsert", () => columnInsertDialog(), can.module()),
      M("columnProperties", () => columnPropertiesDialog(), can.column()),
      M("columnRemove", () => removeColumn(), can.column()),
      M("dxlColumn", () => act(dxlColumnDialog), can.baseline()),
      M("redline", redlineDialog, can.compare()),
      X("columnWizards")]),
    SUB("Show", [
      M("outColumn", () => { S.outLinks = !S.outLinks; render(); }, can.module(), "", tick(S.outLinks, FEATURES.outColumn[1])),
      M("inColumn", () => { S.inLinks = !S.inLinks; render(); }, can.module(), "", tick(S.inLinks, FEATURES.inColumn[1])),
      M("linkArrows", () => { S.arrows = !S.arrows; render(); }, can.module(), "", tick(S.arrows, FEATURES.linkArrows[1])),
      M("showDeleted", async () => { S.showDeleted = !S.showDeleted; await refresh(); }, can.module(), "",
        tick(S.showDeleted, FEATURES.showDeleted[1])),
      M("changeBars", toggleChangeBars, can.compare(), "", tick(S.changeBars, FEATURES.changeBars[1])),
      M("explorerFilter", () => { S.outlineFiltered = !S.outlineFiltered; render(); }, can.module(), "",
        tick(S.outlineFiltered, FEATURES.explorerFilter[1])),
      X("showPictures")]),
    null,
    M("filter", filterDialog, can.module()),
    M("advancedFilter", advancedFilterDialog, can.module()),
    M("filterOn", () => { S.filterOn = !S.filterOn; render(); }, can.module(), "", tick(S.filterOn, FEATURES.filterOn[1])),
    M("sort", sortDialog, can.module()),
    M("sortOn", () => { S.sortOn = !S.sortOn; render(); }, can.module() || (S.sort ? "" : "no sort is set"), "",
      tick(S.sortOn && !!S.sort, FEATURES.sortOn[1])),
    M("reapply", () => render(), can.module()),
    M("clearFilter", () => { clearFilters(); S.sort = null; S.sortDescending = false; render(); },
      can.module() || (S.quick || S.filter || S.advanced || S.sort || TRACE.filtering() ? "" : "nothing is filtered or sorted")),
    null,
    SUB("Saved views", [M("saveView", saveViewDialog, can.write()), M("deleteView", deleteViewDialog, can.savedView()),
      M("reloadView", () => applyView(S.view), can.module()), X("defaultView")]),
    M("refresh", async () => { await loadTree(); await refresh(); }),
    SUB("Appearance", [X("colour"), X("options")]),
  ],
  Insert: () => [
    ...insertObjectEntries(),
    M("newEnd", () => addObject("end"), can.write()),
    null,
    M("newAttribute", () => newAttributeDialog(), can.write(), "", "Attribute..."),
    M("columnInsert", () => columnInsertDialog(), can.module(), "", "Column..."),
    M("createLink", linkDialog, can.change(), "", "Link..."),
    M("newBaseline", newBaselineDialog, can.newBaseline(), "", "Baseline..."),
    null,
    X("externalLinks", "External link..."),
    X("discussions", "Discussion..."),
    X("tables", "Table..."),
    X("picture", "Picture or OLE object..."),
    SUB("Other", [X("symbol"), X("insertUrl"), X("template"), X("forms"), X("oleProperties"), M("richText", formatMain, can.change())]),
  ],
  Link: () => [
    ...linkEntries(),
    null,
    M("editLinks", showProps, can.object()),
    SUB("Linked objects", linkedEntries(S.data && selectedRow())),
    M("deleteLinks", deleteAllLinks, can.outLinks()),
    M("linkByAttribute", linkByAttributeDialog, can.write()),
    M("createLinks", () => bulkLinksDialog(false), can.change()),
    M("deleteLinksBulk", () => bulkLinksDialog(true), can.change()),
    M("deleteAllLinks", () => act(deleteModuleLinks), can.write()),
    null,
    M("linkSettings", linkRulesDialog),
    M("defaultLink", defaultLinkDialog),
    X("externalLinks"),
    X("linkAttributes"),
  ],
  Analysis: () => {
    const columns = S.data && (S.layout || []).some((c) => c.kind === "dxl");
    const shown = can.baseline();
    return [
      M("wizard", traceWizard, can.write()),
      M("traceColumns", traceColumnsDialog, can.module() || (columns ? "" : "this view has none")),
      X("traceExplorer"),
      M("linkAnalysis", overviewDialog),
      M("linkColumnFilter", linkFilterDialog, can.module()),
      null,
      M("suspectFilter", suspectFilterDialog, can.module()),
      M("suspectBoth", () => suspectColumnDialog("indicators", "Display suspect indicators"), shown),
      SUB("Suspect indicators", [
        M("suspectIn", () => showIndicators(true, false), shown), M("suspectOut", () => showIndicators(false, true), shown),
        X("suspectOpen", "Indicators: in-links (open modules)"), X("suspectOpen", "Indicators: out-links (open modules)")]),
      M("suspectLast", () => suspectColumnDialog("last", "Display last change"), shown),
      M("suspectAll", () => suspectColumnDialog("all", "Display all changes"), shown),
      M("suspectClear", clearSuspectDialog, can.write() || can.object()),
      M("suspectClearAll", clearAllDialog, can.write()),
      null,
      M("exportView", exportView, can.module()),
      M("compare", () => compareDialog(), can.compare()),
      M("redline", redlineDialog, can.compare()),
      X("compareModules"),
      M("baselines", baselinesDialog, can.module()),
    ];
  },
  Tools: () => [
    M("dxl", openDxl),
    M("dxlLibrary", openDxl),
    X("layoutConvert"),
    null,
    M("attributes", attributesDialog, can.module()),
    M("types", typesDialog, can.module()),
    M("recalculate", async () => { needModule(); await refresh(); say("Attribute DXL values recalculated."); },
      can.module() || (S.data.attributes.some((a) => a.dxl) ? "" : "no attribute DXL in this module")),
    X("copyAttributes"),
    null,
    M("moduleHistory", () => { needModule(); return historyDialog(); }, can.module()),
    M("objectHistory", () => historyDialog(needObject().absno), can.object()),
    M("statistics", statisticsDialog, can.module()),
    null,
    SUB("Change proposals", [X("proposals")]),
    X("testTracking"),
    X("signatures"),
    M("triggers", triggersDialog),
    SUB("Other", [X("users"), X("manageLocks"), X("sharing"), X("spelling"), X("markup"), X("partitions")]),
  ],
  Favourites: () => [
    M("favouriteAdd", addFavourite, S.picked === 1 ? "pick a folder, project, or module in the tree" : ""),
    M("favouriteOrganise", organiseFavourites, favourites().length ? "" : "there are no favourites yet"),
    null,
    ...favourites().map((path) => M("favouriteOpen", () => goPath(path), "", "", path)),
  ],
  Database: () => [
    M("saveDatabase", () => window.opendoorFiles.save()),
    M("openDatabase", () => window.opendoorFiles.open()),
    M("writtenFiles", () => window.opendoorScriptFiles()),
    null,
    M("resetExample", () => window.opendoorFiles.reset()),
  ],
  Help: () => [
    M("helpPage", () => helpPage()),
    M("dxlCoverage", () => coveragePage()),
    M("keys", keysDialog),
  ],
};

function keysDialog() {
  dialog("Keys and markers", listTable(["Key or mark", "Meaning"], [
    ["Up / Down, Home / End", "Previous / next object, first / last"], ["Left / Right", "Parent / first child"],
    ["F2 or double-click", "Edit in place"], ["Ctrl+Enter", "Save the edit; in the DXL window, run"], ["Esc", "Cancel the edit"],
    ["Enter", "Object properties"], ["Insert / Shift+Insert", "New object / new child"],
    ["Delete", "Delete the object or selection, with everything below"],
    ["Shift+click, Esc", "Select a run of objects; clear the selection"],
    ["Ctrl+X, C, V", "Cut (with what is below), copy (this object, or the selection), paste"], ["Ctrl+Z", "Undo"],
    ["Ctrl+Shift+F, Ctrl+Shift+M", "Link from the link start, to it (a browser may keep these for itself)"],
    ["Ctrl+F, Ctrl+G", "Find, find next"], ["Alt+Up", "Up one level in the database"],
    ["Right-click, or Object...", "Everything that can be done with the selected object"],
    ["▶ red", "The object has out-links (click it)"], ["◀ yellow", "The object has in-links (click it)"],
    ["SUSPECT / S", "The object at the other end of a link changed since the link was made or cleared"],
    ["Bar left of an object", "Added or changed since the latest baseline"],
    ["◆", "A link has been started at this object"],
  ].map((r) => h("tr", {}, r.map((c) => h("td", {}, c))))));
}

// Where each feature sits in the menus, found by building the menus.
function menuPlaces() {
  const places = new Map();
  const walk = (entries, trail) => {
    for (const entry of entries) {
      if (!entry) continue;
      const [label, action, , , id] = entry;
      if (Array.isArray(action)) walk(action, `${trail}, ${label}`);
      else if (id && !places.has(id)) places.set(id, trail);
    }
  };
  for (const [name, entries] of Object.entries(MENUS)) walk(entries(), name);
  walk(objectMenu(), "Right-click an object");
  return places;
}

function helpPage() {
  const places = menuPlaces();
  const all = Object.entries(FEATURES).map(([id, [area, label, status, note, where]]) =>
    ({ area, label: label.replace(/\.\.\.$/, ""), status, note, where: places.get(id) || where || "" }));
  const search = h("input", { type: "search", placeholder: "Search...", "aria-label": "Search the list" });
  const kind = h("select", { "aria-label": "Status" }, [["", "Everything"], ...Object.entries(STATUS_NAMES)]
    .map(([value, label]) => h("option", { value }, label)));
  const holder = h("div", {});
  const draw = () => {
    const want = search.value.toLowerCase();
    const rows = all.filter((f) => (!kind.value || f.status === kind.value)
      && (!want || `${f.area} ${f.label} ${f.note} ${f.where}`.toLowerCase().includes(want)));
    const areas = [...new Set(rows.map((f) => f.area))];
    holder.replaceChildren(...areas.map((area) => h("section", {}, h("h4", {}, area),
      h("table", { class: "list coverage" }, h("tbody", {}, rows.filter((f) => f.area === area).map((f) =>
        h("tr", { class: "cov-" + f.status }, h("td", { class: "cov-name" }, f.label),
          h("td", { class: "cov-status" }, STATUS_NAMES[f.status]),
          h("td", {}, f.note, f.where ? h("div", { class: "cov-where" }, f.where) : null))))))),
    ...(rows.length ? [] : [h("p", {}, "Nothing matches.")]));
  };
  search.addEventListener("input", draw);
  kind.addEventListener("change", draw);
  draw();
  const count = (status) => all.filter((f) => f.status === status).length;
  const box = dialog("What this tool does and does not do", h("div", {},
    h("p", {}, "A practice tool, not DOORS. ",
      `${count("full")} features full, ${count("part")} partial, ${count("no")} not offered. `
      + "A greyed menu entry is either not offered or cannot be done just now; pointing at it says which. "
      + "What DXL runs is on its own page: Help, DXL coverage."),
    h("div", { class: "cov-controls" }, search, " ", kind), holder));
  box.problem.closest("dialog").classList.add("page");
}

buildMenubar();
