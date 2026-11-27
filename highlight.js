// DXL colours for the DXL window's source box. The coloured text sits behind the
// <textarea>, which stays the editor: its own text is transparent, and it keeps the
// caret, selection, undo, scrolling and Tab. The word lists are copies of the
// engine's (src/dxl/syntax.ts and src/dxl/dxl-names.ts); test/dxl-highlight.test.ts
// fails when they disagree. Only classes and text nodes are built; no markup is parsed.

var DxlHighlight = (function () {
  // Copies of the engine's lists: change them with the engine, and test/dxl-highlight.test.ts checks they agree.
  const KEYWORDS = new Set((
    "and break by case const continue default do else enum false for if in module object " +
    "or pragma return sizeof static struct switch then true union while").split(" "));
  const TYPES = new Set((
    "AccessRec ArchiveData ArchiveInclusionDescriptor ArchiveItem Array AttrBaseType " +
    "AttrDef AttrType Attr__ Baseline BaselineSet BaselineSetDefinition Bitmap Buffer " +
    "Column ConfStream ConfType DB DBE Database__ Date Dictionary Discussion DropEvent " +
    "EmbeddedOleObject ExternalLink ExternalLinkBehaviour ExternalLinkDirection Filter " +
    "Folder GrammarRules GraphicsFont Group History HistorySession HistoryType IPC Icon " +
    "IntegrityCheckItem IntegrityProblem IntegrityResultsData Item Justification Language " +
    "Languages__ Link LinkFilter LinkModuleDescriptor LinkRef Linkset Locale Lock " +
    "LockList LoginPolicy ModName_ Module ModuleProperties ModuleVersion Object " +
    "OleAutoArgs OleAutoObj PageLayout PartitionDefinition PartitionFile PartitionModule " +
    "PartitionPermission PartitionView Permission ProblemItem Project RTF_string__ Range " +
    "Regexp RichText RichTextParagraph RifDefinition RifImport ScrollSide Sensitivity " +
    "SignatureEntry SignatureInfo SignatureInfoSpecifer__ SignatureInfoSpecifier__ Skip " +
    "Sort SpellOptions SpellingError SpellingErrors__ SpellingOptions Stat Stream String " +
    "TableBorderPosition TableBorderStyle Template ToolType Trigger TriggerStatus User " +
    "UserClass View ViewDef additionalAuthenticationRequired alternativeWord array bool " +
    "char extLinkBeh extLinkDir function iconAuthenticatingUse int lang " +
    "maximumAttributeLength mayUseCommandLinePassword onePointFive real reference single " +
    "string void").split(" "));
  const BUILTINS = new Set((
    "ACreatedBy CP_CHS CP_CHT CP_JAP CP_KOR CP_LATIN1 CP_UNICODE CP_UTF16_BE CP_UTF16_LE " +
    "CP_UTF8 INITIAL_TREE_HEIGHT INITIAL_TREE_WIDTH LINK_HISTORY_ATTRNAME LIST_HEIGHT " +
    "LIST_WIDTH SARR_DUMMY TREE_HEIGHT TREE_WIDTH accept acceptModule acceptPartition " +
    "acceptReport accessed ack acknowledge activateURL active addAttribute " +
    "addAwayAttribute addAwayLinkModule addAwayLinkset addAwayModule addAwayView " +
    "addBaselines addComment addFilter addGroup addLinkModule addLinkModuleDescriptor " +
    "addLinkset addMember addMenu addModule addNotifyUser addProjectEntry " +
    "addRecentlyOpenModule addToolTip addUser addView adioBox all allAttributesReadable " +
    "allowsAccess alternative alternatives anagram ancestors annotation ansi append " +
    "appendCell appendColumn appendRow appendSignatureEntry apply applyFiltering " +
    "applyTextFormattingToParagraph applyingFiltering archive archiveFiles ascending " +
    "attrDXLName attrName attrdef attribute attributeDXL attributeValue autoIndent " +
    "availableFonts backSlasher background baseWin baseline baselineExists baselineIndex " +
    "baselineInfo baselineModule baselineSet batchMode below beside bitmap block bottom " +
    "box bringToFront busy button canControl canControlDef canControlVal canCreate " +
    "canCreateDef canCreateServerArchive canCreateVal canDelete canDeleteDef canDeleteVal " +
    "canInheritView canLock canModify canOpenFile canRead canReadServerArchiveFile " +
    "canRestoreServerArchive canUnlock canUseServerArchive canWrite " +
    "canWriteServerArchiveFile cancelled canvas cell centered centred change changeOLE " +
    "changePasswordDialog changePicture charOf characterSet charsetDefault checkConnect " +
    "checkDN checkDXL checkDXLFile checkDatabaseIntegrity checkFolderIntegrity checkItem " +
    "choice cistrcmp clear clearDefaultViewForModule clearDefaultViewForUser " +
    "clearInvalidInheritanceOf clearSearchObject clearToolTips client clipClear clipCopy " +
    "clipCopyObject clipCut clipCutObject clipLastOp clipMoveObject clipPaste clipUndo " +
    "close closeDiscussion closeFolder closeProject codepageName color colorGrey colour " +
    "column combine comment confAppend confCopyFile confDeleteDirectory confDeleteFile " +
    "confDownloadFile confFileExists confMkdir confRead confRenameFile confUploadFile " +
    "confWrite confirm confirmPasswordDialog contains containsOle contents " +
    "convertFolderToProject convertFromCodepage convertProjectToFolder convertToCodepage " +
    "convertToFolder copy copyFile copyObject copyPassword copyPictureObject " +
    "copyToClipboard cos create createAttr createAutoArgs createButtonBar " +
    "createDropCallback createEditableCombo createItem createLink createModule " +
    "createObject createPasswordDialog createPopup createPrivate createPublic createType " +
    "current currentANSIcodepage currentDirectory currentView cut cutOLE cutRichText data " +
    "date dateAndTime dateOf dateOnly decodeURL defaultTableAttribute delete " +
    "deleteAllMembers deleteAttr deleteCell deleteColumn deleteFile deleteGroup " +
    "deleteKeyRegistry deleteLink deleteMember deleteNotifyUser deleteObject " +
    "deletePicture deleteType deleteUser deleteValueRegistry descendants descending " +
    "description deselect destroy destroyBitmap destroySort diff directory " +
    "disableDisplayWarnings disableGeneralRichTextWarnings " +
    "disableObjectTextAssignmentWarnings disableObjectTextRichTextWarnings " +
    "disableRepeatWarnings disconnect discussion display displayRich displayRichWithColor " +
    "displayRichWithColour dispose doorsInfo doorsVersion dottedborder downgrade " +
    "downgradeShare draggedObjects draw drawAngle drawBitmap dropDataAvailable " +
    "droppedAttrOLETextAvailable droppedAttrRichTextAvailable droppedAttrTextAvailable " +
    "droppedAttributeOLEText droppedAttributeRichText droppedAttributeText droppedList " +
    "droppedString dxl dxlHere dxlWarningFilename dxlWarningLineNumber echo ellipse elp " +
    "empty enableDefaultTableAttribute enableDisplayWarnings " +
    "enableGeneralRichTextWarnings enableObjectTextAssignmentWarnings " +
    "enableObjectTextRichTextWarnings enableRepeatWarnings end ensureUserRecordLoaded " +
    "error errorBox everSectioned excludeCurrent excludeLeaves excludes exists " +
    "existsGroup exp export exportPackage exportPicture exportRTFString extractAfter " +
    "extractBelow field fileName filterTables filtering find findAttribute findByID " +
    "findGroupRDNFromName findLinkset findModule findPlainText findRichText " +
    "findUserInfoFromDN findUserRDNFromLoginName findUserRDNFromName findView first " +
    "firstNonSpace flush flushDeletions folder font fontTable forename formalStatus " +
    "format formatMenu frame full fullHostname fullName get getAccountsDisabled " +
    "getAdditionalAuthenticationEnabled getAdditionalAuthenticationPrompt " +
    "getAddressAttribute getAdministratorName getAlternative getArchiveType getBorderSize " +
    "getBoundedAttr getBoundedUnicode getBuffer getCanvas getCaptionHeight " +
    "getCatalanOptions getCellAlignment getCellShowChangeBars getCellShowLinkArrows " +
    "getCellWidth getCheck getColumnBottom getColumnTop getColumnValue " +
    "getCommandLinePasswordDisabled getComment getComments getCorrectionComplete " +
    "getCursorPosition getDOSstring getDXLFileHelp getDatabaseIdentifier " +
    "getDatabaseMailPrefixText getDatabaseMailServer getDatabaseMailServerAccount " +
    "getDatabaseMinimumPasswordLength getDatabaseName getDatabasePasswordRequired getDate " +
    "getDateFormat getDefaultColorScheme getDefaultColourScheme getDefaultLineSpacing " +
    "getDefaultLinkModule getDefaultViewForModule getDefaultViewForUser getDescription " +
    "getDescriptionAttribute getDisableLoginThreshold getDiscussions getDoorsBindNameDN " +
    "getDoorsGroupGroupDN getDoorsGroupRoot getDoorsUserGroupDN getDoorsUserRoot " +
    "getDoorsUsernameAttribute getEditDXLControlled getEmail getEmailAttribute " +
    "getEnglishOptions getErrorStartPos getErrorStopPos getErrorString getExplanation " +
    "getFailedLoginThreshold getFontSettings getFormattedLocalDate getFrenchOptions " +
    "getGermanOptions getGrammarLevel getGrammarRules getGreekOptions " +
    "getGroupMemberAttribute getGroupNameAttribute getGroupObjectClass getHTML getId " +
    "getIgnoreReadOnly getImplied getInPlaceColumnIndex getInnerHTML getInnerText " +
    "getInvalidCharInModuleName getInvalidCharInProjectName getInvalidCharInSuffix " +
    "getIsValid getLabel getLabelOptions getLabelSpecifier getLanguage getLdapServerName " +
    "getLegacyLocale getLineSpacing getLinkModuleDescriptorsExclusive getLocalDate " +
    "getLocksInDatabase getLocksInFolder getLocksInModule getLogicalColorName " +
    "getLogicalColourName getLoginFailureText getLoginLoggingPolicy getLoginNameAttribute " +
    "getLoginPolicy getMandatory getMaxClientVersion getMessageOfTheDay " +
    "getMessageOfTheDayOption getMinClientVersion getModuleDetails getMostRecentBaseline " +
    "getName getNextError getObjectDiscussions getOleWidthHeight getOptions " +
    "getOverridable getParent getParentFolder getParentProject getPartitionMask getPictBB " +
    "getPictFormat getPictName getPictWidthHeight getPort getPortNo getPos " +
    "getProjectDetails getProperties getRealColor getRealColorIcon getRealColorName " +
    "getRealColorOptionForTypes getRealColour getRealColourIcon getRealColourName " +
    "getRealColourOptionForTypes getReference getRegistry getRow getRussianOptions " +
    "getSearchObject getSelectedCol getSelectedItem getSelection getSentenceStartPos " +
    "getSentenceStopPos getShowTableAcrossModule getSignatureInfo getSize getSortColumn " +
    "getSource getSourceName getSourceVersion getSpanishOptions getSpellingCheckingMode " +
    "getSpellingFirst getSystemLoginConformityRequired getTDBindName getTDPortNumber " +
    "getTDSSOToken getTDServerName getTDUseDirectoryPasswordPolicy getTable getTarget " +
    "getTargetName getTelephoneAttribute getTemplateFileName getTitle getUKOptions getURL " +
    "getUseLdap getUseTelelogicDirectory getUserFullName getUserName getUserlistDetails " +
    "getViewDescription getWord getenv gluedHelp goodFileName goodStringOf gotoObject " +
    "graphics halt hardDelete hasFocus hasHeader hasInPlace hasLinks hasNoLinks " +
    "hasPermission hasPicture hasScrollbars hasSpecificValue headerAddColumn headerChange " +
    "headerRemoveColumn headerReset headerSelect headerSetHighlight headerShow heckBox " +
    "height help helpOn helpOnEx hide highlightText home hostname htmlEdit htmlText " +
    "htmlView iconFolder iconFormal iconLink iconProject id identifier ignoreWord " +
    "importPicture importRTF importRifFile inClipboard inPlaceChoiceAdd inPlaceGet " +
    "inPlaceMove inPlaceReset inPlaceSet inPlaceShow inPlaceTextHeight inactive " +
    "includeCurrent includeLeaves includes includesTime info infoBox inherited " +
    "inplaceEditing insert insertBitmapFromClipboard insertCell insertColumn " +
    "insertDroppedPicture insertOLE insertPictureAfter insertPictureBelow " +
    "insertPictureFile insertPictureFileAfter insertPictureFileBelow insertRow installed " +
    "installedCodepages installedLocales instance intOf invalidInheritedView ipcHostname " +
    "isAccessInherited isAnyBaselineSetOpen isAscending isAttribute isBaseline " +
    "isBaselinePresent isBaselineSignatureConfigured isDatabaseDict isDefault " +
    "isDefaultURL isDeleted isDescending isFirstObjectInDXLSet isInheritedView " +
    "isLastObjectInDXLSet isLocked isLockedByUser isLockedClosed isMember isNull " +
    "isOleObjectSelected isOpen isPartitionedOut isRanged isRead isRichText isSupported " +
    "isUsed isValidChar isValidDescription isValidInt isValidName isValidPrefix isVisible " +
    "isVisibleAttribute isalpha item itemClipboardIsEmpty itemFromID itemFromReference " +
    "justify keyDelete keyDown keyEnd keyF1 keyF10 keyF11 keyF12 keyF2 keyF3 keyF4 keyF5 " +
    "keyF6 keyF7 keyF8 keyF9 keyHelp keyHome keyInsert keyLeft keyPageDown keyPageUp " +
    "keyRight keyUp keyword kind label language languages lastError lastModifiedTime " +
    "layoutDXL ldapGroupsForUser left leftAligned length level levelModifier line link " +
    "linkIndicators linkset list listView load loadBitmap loadDirectory " +
    "loadInPartitionDef loadLdapConfig loadUserRecord locale lock log " +
    "logicalGraphicsBoxEdgeColor longDateFormats lower main major manyToMany manyToOne " +
    "markUp matches mayEditDXL mayModifyDiscussionStatus member menuBar menuStatus " +
    "messageBox minor mkdir modified modify modifyAttr modifyLink modifyObject modifyType " +
    "moduleVersion move multiList name next nextMajor noElems noError noborder notNull " +
    "null number off ok oleActivate oleCloseAutoObject oleCopy oleCount " +
    "oleCreateAutoObject oleCut oleDeactivate oleDelete oleGet oleGetAutoObject " +
    "oleGetResult oleInsert oleIsObject oleLoadBitmap oleMethod oleOpen olePaste " +
    "olePasteLink olePut oleResetSize oleSaveBitmap oleSetMaxWidth oleSetMinWidth " +
    "oleSetResult on oneToMany oneToOne open openPictFile openProject opposite " +
    "optionsExist overrideTableAttribute pageBreakLevel pageChangeBars pageColumns " +
    "pageExpandHF pageHeaderFooter pageIncludeFilters pageIncludeSort pageLayout pageName " +
    "pageSignaturePage pageSize pageTitlePage paperA4 parentRef parentRefID partition " +
    "partitionModule pasteOLE pasteToEditbox path pi pictureCompatible pictureCopy " +
    "platform polarLine polygon pow preloadedView print printCharArray printModule " +
    "priority problems progressCancelled progressMessage progressRange progressStart " +
    "progressStep progressStop project purge purgeObject purgeObjects_ put putString " +
    "qualifiedUniqueID query raise random read readFile readLocked ready realBackground " +
    "realColor realColour realOf realize rectangle recv refresh refreshDBExplorer " +
    "refreshExplorer regexp regexp2 region registeredFormat reimportPicture reject " +
    "rejoinModule rejoinPartition rejoinReport release remove removeAttribute " +
    "removeLinkModuleDescriptor removeLinkset removeModule removeOLE removePartition " +
    "removeRecentlyOpenModule removeUnlistedRichText removeView rename renameFile " +
    "reopenDiscussion repaired replaceRichText requestLock resetColor resetColors restore " +
    "restoreFiles restoreModule restoreProject restoreUserlist returnModule " +
    "returnPartition richField richFileName richText richTextFragment richTextNoOle " +
    "richTextWithOle richtext_identifier rifMerge right row rtfSubString sUserLogin " +
    "sUserName save saveClipboardBitmapToFile saveDirectory saveDroppedPicture " +
    "saveLdapConfig saveModified saveUserRecord scope scrollSet search sectionNeedsSaved " +
    "select selected selectedElems send sendBroadcastMessage sendEMailMessage " +
    "sendEMailNotification separator server serverMonitorIsOn session set setAccess " +
    "setAccountsDisabled setAddressAttribute setAllCellsAlignment setAllCellsBorder " +
    "setAllCellsShowChangeBars setAllCellsShowLinkArrows setAllCellsWidth setAnnotation " +
    "setAttrFromHTML setBaseWindowContext setCatalanOptions setCellAlignment " +
    "setCellBorder setCellShowChangeBars setCellShowLinkArrows setCellWidth " +
    "setCenteredSize setCheck setColumnAlignment setColumnShowChangeBars " +
    "setColumnShowLinkArrows setColumnWidth setDXLWindowAsParent " +
    "setDatabaseMailPrefixText setDatabaseMailServer setDatabaseMailServerAccount " +
    "setDatabaseMinimumPasswordLength setDatabaseName setDatabasePasswordRequired " +
    "setDefaultColorScheme setDefaultColourScheme setDefaultLinkModule " +
    "setDefaultViewForModule setDefaultViewForUser setDescription setDescriptionAttribute " +
    "setDisableLoginThreshold setDoorsBindNameDN setDoorsBindPassword " +
    "setDoorsBindPasswordDB setDoorsGroupGroupDN setDoorsGroupRoot setDoorsUserGroupDN " +
    "setDoorsUserRoot setDoorsUsernameAttribute setDropList setDropString " +
    "setEditDXLControlled setEmailAttribute setEnglishOptions setExtraHeightShare " +
    "setExtraWidthShare setFailedLoginThreshold setFocus setFontSettings setFrenchOptions " +
    "setFromBuffer setGermanOptions setGotFocus setGrammarLevel setGreekOptions setGroup " +
    "setGroupMemberAttribute setGroupNameAttribute setGroupObjectClass setHTML " +
    "setIgnoreReadOnly setImplied setInnerHTML setInnerText setLabelSpecifier setLanguage " +
    "setLdapServerName setLegacyLocale setLimits setLineSpacing " +
    "setLinkModuleDescriptorsExclusive setLocale setLoginFailureText " +
    "setLoginLoggingPolicy setLoginNameAttribute setLoginPolicy setLostFocus setMandatory " +
    "setMaxClientVersion setMaxValue setMessageOfTheDay setMessageOfTheDayOption " +
    "setMinClientVersion setMinValue setOverridable setParent setPortNo setPos " +
    "setPreloadedView setRealColor setRealColorOptionForTypes setRealColour " +
    "setRealColourOptionForTypes setRegistry setRichClip setRowWidth setRussianOptions " +
    "setSearchObject setSelection setServerMonitor setShowDeletedItems " +
    "setShowFormalModules setShowTableAcrossModule setSize setSortColumn setSource " +
    "setSpanishOptions setSpellingCheckingMode setSpellingFirst setTDBindName " +
    "setTDBindPassword setTDPortNumber setTDServerName setTDUseDirectoryPasswordPolicy " +
    "setTelephoneAttribute setTitle setUKOptions setURL setUpExtraction setUseLdap " +
    "setUseTelelogicDirectory setUser setViewDescription setempty setenv setupper " +
    "shareLock shortDateFormats show showChangeBars showDeletedObjects showExplorer " +
    "showFormalModules showGraphicsDatatips showGraphicsLinks showOlePropertiesDialog " +
    "showPrintDialogs showing showingExplorer side1 side2 sin slider softDelete " +
    "solidBorder sort sortDiscussions sorting soundex source sourceAbsNo sourceVersion " +
    "spGetLanguages specific specifier spell spellFix spellingErrors splitHeadingAndText " +
    "splitter sqrt stacked start startConfiguringMenus startPrintJob status statusBar " +
    "stopConfiguringMenus stored stringOf styleIsCloseBtn suffix supportedCodepages " +
    "supportedLocales supportedPictureFormat surname synchExplorer synergyUsername system " +
    "tab tabStrings table tableContents tan target targetAbsNo targetVersion tempFileName " +
    "template templates text timestamp title toTable today toggle toolBar toolBarComboAdd " +
    "toolBarComboCount toolBarComboCutCopySelectedText toolBarComboDelete " +
    "toolBarComboEmpty toolBarComboGetEditBoxSelection toolBarComboGetItem " +
    "toolBarComboGetSelection toolBarComboInsert toolBarComboPasteText toolBarComboSelect " +
    "toolBarMove toolBarShow toolBarVisible top topMost treeView trigger type " +
    "unApplyFiltering unDeleteObject undelete undeleteCell undoMarkUp unicodeString " +
    "uniqueID unixerror unknown unload unlock unset unsetAll updateGroupList " +
    "updateToolBars updateUserList useAncestors useAutoIndentation useColumns " +
    "useCompression useCurrent useDefaultTableAttribute useDescendants useFilterTables " +
    "useFiltering useGraphics useGraphicsColumn useLevel useOutlining useRTFColour " +
    "useSelection useShowDeleted useShowExplorer useShowLinkIndicators useShowLinks " +
    "useShowPictures useShowTables useSorting useTooltipColumn useWindows user userLocale " +
    "username utf8 validateDOORSURL value version versionID versionString view warn " +
    "warningBox when who width wildcard write").split(" "));

  // Lexer states carried from one line to the next: a /* comment or a "string" can run over lines.
  const PLAIN = 0, BLOCK = 1, STRING = 2;

  const NAME = /[A-Za-z_][A-Za-z0-9_']*/y;
  const SPACE = /\s+/y;
  const CHAR = /'(?:[^'\\]|\\[0-7]{1,3}|\\.)'/y;
  const NUMBER = /(?:\d+\.(?!\.)\d*|(?<![\w'\)\]\.])\.\d+)(?:[eE][+\-]?\d+)?|\d+[eE][+\-]?\d+|0[xX][0-9A-Fa-f]+|0[bB][01]+|\d+/y;
  const PREPROCESSOR = /#(?:include|pragma)/y;

  function at(re, text, pos) {
    re.lastIndex = pos;
    const m = re.exec(text);
    return m ? m[0] : null;
  }

  function wordClass(word) {
    if (TYPES.has(word)) return "ty";
    if (KEYWORDS.has(word)) return "kw";
    if (BUILTINS.has(word)) return "bi";
    return "";
  }

  // The index of the quote that closes a string from `from`, or -1 when the line ends first.
  function stringEnd(text, from) {
    for (let i = from; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') return i;
    }
    return -1;
  }

  // One line, given the state it starts in: [code, text, code, text, ...] and the state it ends in.
  // code is "" for plain text, else cm (comment), st (string), ch (character), nu (number),
  // kw (keyword), ty (type), bi (built-in), pp (preprocessor).
  function lexLine(line, enter) {
    const parts = [];
    const put = (code, s) => {
      if (!s) return;
      const last = parts.length - 2;
      if (!code && last >= 0 && parts[last] === "") parts[last + 1] += s;
      else parts.push(code, s);
    };
    let pos = 0;
    if (enter === BLOCK) {
      const end = line.indexOf("*/");
      if (end < 0) { put("cm", line); return { parts, exit: BLOCK }; }
      put("cm", line.slice(0, end + 2));
      pos = end + 2;
    } else if (enter === STRING) {
      const close = stringEnd(line, 0);
      if (close < 0) { put("st", line); return { parts, exit: STRING }; }
      put("st", line.slice(0, close + 1));
      pos = close + 1;
    }
    while (pos < line.length) {
      const c = line[pos];
      let s;
      if (c === "/" && line[pos + 1] === "/") {
        put("cm", line.slice(pos));
        break;
      }
      if (c === "/" && line[pos + 1] === "*") {
        const end = line.indexOf("*/", pos + 2);
        if (end < 0) { put("cm", line.slice(pos)); return { parts, exit: BLOCK }; }
        put("cm", line.slice(pos, end + 2));
        pos = end + 2;
      } else if (c === "#" && at(PREPROCESSOR, line, pos)) {
        put("pp", line.slice(pos));
        break;
      } else if (c === '"') {
        const close = stringEnd(line, pos + 1);
        if (close < 0) { put("st", line.slice(pos)); return { parts, exit: STRING }; }
        put("st", line.slice(pos, close + 1));
        pos = close + 1;
      } else if (c === "'" && (s = at(CHAR, line, pos))) {
        put("ch", s);
        pos += s.length;
      } else if ((s = (c === "." || (c >= "0" && c <= "9")) ? at(NUMBER, line, pos) : null)) {
        put("nu", s);
        pos += s.length;
      } else if ((s = at(NAME, line, pos))) {
        put(wordClass(s), s);
        pos += s.length;
      } else if ((s = at(SPACE, line, pos))) {
        put("", s);
        pos += s.length;
      } else {
        put("", c);
        pos++;
      }
    }
    return { parts, exit: PLAIN };
  }

  const TEXT_STYLES = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant",
    "lineHeight", "letterSpacing", "wordSpacing", "tabSize", "textIndent", "textTransform", "textRendering",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];

  function lineNode(parts) {
    const div = document.createElement("div");
    div.className = "hl-line";
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i]) {
        const span = document.createElement("span");
        span.className = "hl-" + parts[i];
        span.textContent = parts[i + 1];
        div.appendChild(span);
      } else {
        div.appendChild(document.createTextNode(parts[i + 1]));
      }
    }
    // an empty line has no text, so it would have no height
    if (!div.firstChild) div.appendChild(document.createTextNode(" "));
    return div;
  }

  // Puts a coloured copy of `textarea`'s text behind it. Returns { update }: call it after every
  // change to the textarea's value (typing and Tab fire input; a value set in code does not).
  function attach(textarea) {
    const host = textarea.parentNode;
    const layer = document.createElement("div");
    layer.className = "hl-layer";
    layer.setAttribute("aria-hidden", "true");
    const code = document.createElement("div");
    code.className = "hl-code";
    layer.appendChild(code);
    host.insertBefore(layer, textarea);
    host.classList.add("hl-host");
    textarea.classList.add("hl-input");

    let shown = null; // the text the layer shows
    let rows = []; // one {key, exit, el} per line, in order; a line's key is its start state and text

    // The layer takes the textarea's box and the font and padding it draws with.
    function place() {
      const cs = getComputedStyle(textarea);
      for (const name of TEXT_STYLES) code.style[name] = cs[name];
      layer.style.left = textarea.offsetLeft + textarea.clientLeft + "px";
      layer.style.top = textarea.offsetTop + textarea.clientTop + "px";
      layer.style.width = textarea.clientWidth + "px";
      layer.style.height = textarea.clientHeight + "px";
    }

    // A transform, not scrollTop: the layer has no scrollbars, so its own scroll would clamp differently.
    function scrolled() {
      code.style.transform = "translate(" + -textarea.scrollLeft + "px, " + -textarea.scrollTop + "px)";
    }

    function update() {
      const text = textarea.value;
      if (text !== shown) {
        shown = text;
        const pool = new Map();
        for (const row of rows) {
          const same = pool.get(row.key);
          if (same) same.push(row); else pool.set(row.key, [row]);
        }
        const next = [];
        let enter = PLAIN;
        for (const line of text.split("\n")) {
          const key = enter + line;
          const same = pool.get(key);
          let row;
          if (same && same.length) {
            row = same.shift();
          } else {
            const lexed = lexLine(line, enter);
            row = { key, exit: lexed.exit, el: lineNode(lexed.parts) };
          }
          next.push(row);
          enter = row.exit;
        }
        // Only the lines between the first and last change are touched.
        const old = rows;
        let head = 0;
        while (head < old.length && head < next.length && old[head] === next[head]) head++;
        let tail = 0;
        while (tail < old.length - head && tail < next.length - head
          && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
        for (let i = head; i < old.length - tail; i++) old[i].el.remove();
        const fragment = document.createDocumentFragment();
        for (let i = head; i < next.length - tail; i++) fragment.appendChild(next[i].el);
        const after = next.length - tail < next.length ? next[next.length - tail].el : null;
        code.insertBefore(fragment, after);
        rows = next;
      }
    }

    // Geometry is read only when it can change (size, window, or shown after hidden), not on every
    // keystroke: reading it forces a layout of the whole layer.
    textarea.addEventListener("scroll", scrolled);
    window.addEventListener("resize", place);
    if (window.ResizeObserver) new ResizeObserver(place).observe(textarea);
    place();
    scrolled();
    update();
    return { update };
  }

  return { attach, lexLine, lists: { keywords: KEYWORDS, types: TYPES, builtins: BUILTINS } };
})();
