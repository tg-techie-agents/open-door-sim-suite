// Names that are real DXL but that this suite does not offer. Saying so is more
// use than "undeclared": it tells the writer the script is not at fault.

const GROUPS: Array<[string, string]> = [
  // lib/dialogs.ts offers the other dialog box functions
  ["the parts of dialog boxes (canvases, frames, tabs, tree views and the like)", "canvas frame slider splitter "
    + "statusBar tab treeView menuBar addMenu toolBar htmlView htmlEdit richText richField richFileName query "
    + "messageBox dxlHere baseWin setParent setPos getPos setSize getSize setCenteredSize getBorderSize "
    + "getCaptionHeight help gluedHelp setFocus setGotFocus setLostFocus setSortColumn getSortColumn deleteColumn "
    + "setDXLWindowAsParent setExtraWidthShare setExtraHeightShare templates layoutDXL modified getBuffer "
    + "setFromBuffer setLimits getDate styleIsCloseBtn iconFolder iconProject iconFormal iconLink"],
  ["OLE automation (Excel, Word)", "OleAutoObj OleAutoArgs oleCreateAutoObject oleGetAutoObject oleCloseAutoObject "
    + "oleMethod oleGet olePut oleGetResult create createAutoArgs"],
  ["triggers", "Trigger trigger"],
  ["the clipboard", "copyToClipboard"],
  ["view definitions (ViewDef)", "ViewDef useColumns useFiltering useSorting"],
  ["rich text decomposition and editing", "RichText RichTextParagraph isRichText removeUnlistedRichText "
    + "findRichText replaceRichText cutRichText richTextFragment"],
];

export function unavailable(name: string): string | null {
  for (const [what, names] of GROUPS) {
    if (names.split(" ").includes(name)) {
      return `${name} belongs to ${what}, which this practice suite does not offer`;
    }
  }
  return null;
}
