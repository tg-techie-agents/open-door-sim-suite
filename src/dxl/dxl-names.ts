// Every DXL name this suite knows to be real: names only, grouped by what they
// belong to and why one that is not offered is not. Whether a name is offered is
// not recorded here; unavailable.ts asks the library.

export type NameGroup = {
  area: string;
  reason: string; // "not built", or "cannot be done here: ..."
  functions: string;
  types: string;
  constants: string;
};

export const NAME_GROUPS: NameGroup[] = [
  {
    area: "the parts of dialog boxes (canvases, frames, tabs, tree views and the like)",
    reason: "not built",
    functions: "canvas frame slider splitter statusBar tab treeView menuBar addMenu toolBar htmlView htmlEdit "
      + "richText richField richFileName query messageBox baseWin setParent setPos getPos setSize getSize "
      + "setCenteredSize getBorderSize getCaptionHeight help gluedHelp setFocus setGotFocus setLostFocus "
      + "setSortColumn getSortColumn deleteColumn setDXLWindowAsParent setExtraWidthShare setExtraHeightShare "
      + "templates layoutDXL modified getBuffer setFromBuffer setLimits getDate styleIsCloseBtn iconFolder "
      + "iconProject iconFormal iconLink",
    types: "",
    constants: "",
  },
  {
    area: "OLE automation (Excel, Word)",
    reason: "cannot be done here: it needs Windows OLE",
    functions: "oleCreateAutoObject oleGetAutoObject oleCloseAutoObject oleMethod oleGet olePut oleGetResult create "
      + "createAutoArgs oleActivate oleDeactivate oleCopy oleCut oleDelete oleInsert oleIsObject oleOpen "
      + "olePaste olePasteLink oleSaveBitmap oleCount oleSetMaxWidth oleSetMinWidth oleResetSize "
      + "oleLoadBitmap oleSetResult",
    types: "OleAutoObj OleAutoArgs EmbeddedOleObject",
    constants: "insertOLE removeOLE changeOLE pasteOLE cutOLE",
  },
  {
    area: "triggers",
    reason: "not built",
    functions: "trigger attrdef kind levelModifier link value priority stored scope createDropCallback "
      + "registeredFormat dropDataAvailable droppedString droppedAttrTextAvailable droppedAttributeText "
      + "droppedAttrRichTextAvailable droppedAttributeRichText droppedAttrOLETextAvailable "
      + "droppedAttributeOLEText draggedObjects droppedList setDropString setDropList insertDroppedPicture "
      + "saveDroppedPicture",
    types: "Trigger TriggerStatus",
    constants: "",
  },
  {
    area: "the clipboard",
    reason: "not built",
    functions: "copyToClipboard",
    types: "",
    constants: "",
  },
  {
    area: "view definitions (ViewDef)",
    reason: "not built",
    functions: "useColumns useFiltering useSorting",
    types: "ViewDef",
    constants: "",
  },
  {
    area: "rich text decomposition and editing",
    reason: "not built",
    functions: "isRichText removeUnlistedRichText findRichText replaceRichText cutRichText richTextFragment",
    types: "RichText RichTextParagraph",
    constants: "",
  },
  {
    area: "loop sources for locales, code pages and fonts",
    reason: "not built",
    functions: "availableFonts installedLocales supportedLocales installedCodepages supportedCodepages",
    types: "SpellingErrors__ Languages__",
    constants: "",
  },
  {
    area: "script control and introduction",
    reason: "not built",
    functions: "halt checkDXL checkDXLFile sort activateURL batchMode",
    types: "char int real string array function reference Object Module Template",
    constants: "true on false off",
  },
  {
    area: "discussions and web controls added in DOORS 9.0",
    reason: "not built",
    functions: "addComment closeDiscussion reopenDiscussion delete sortDiscussions getDiscussions "
      + "getObjectDiscussions getComments mayModifyDiscussionStatus baselineIndex comment discussion dispose "
      + "setViewDescription getViewDescription setDescription modify applyFiltering unApplyFiltering "
      + "applyingFiltering set setURL getURL get setHTML getHTML getInnerText setInnerText getInnerHTML "
      + "setInnerHTML backSlasher",
    types: "Discussion Project Folder AttrType DB DBE",
    constants: "",
  },
  {
    area: "a directory server and its settings",
    reason: "cannot be done here: it needs a directory server",
    functions: "getTDSSOToken loadDirectory saveDirectory ldapGroupsForUser forename surname saveLdapConfig "
      + "loadLdapConfig getUseLdap setUseLdap updateUserList updateGroupList findUserRDNFromName "
      + "findUserRDNFromLoginName findGroupRDNFromName findUserInfoFromDN checkConnect checkDN "
      + "getLdapServerName setLdapServerName getPortNo setPortNo getDoorsBindNameDN setDoorsBindNameDN "
      + "setDoorsBindPassword setDoorsBindPasswordDB getDoorsUserGroupDN setDoorsUserGroupDN "
      + "getDoorsGroupGroupDN setDoorsGroupGroupDN getLoginNameAttribute setLoginNameAttribute "
      + "getEmailAttribute setEmailAttribute getDescriptionAttribute setDescriptionAttribute "
      + "getTelephoneAttribute setTelephoneAttribute getAddressAttribute setAddressAttribute "
      + "getGroupObjectClass setGroupObjectClass getGroupMemberAttribute setGroupMemberAttribute "
      + "getGroupNameAttribute setGroupNameAttribute getUseTelelogicDirectory setUseTelelogicDirectory "
      + "getTDServerName setTDServerName getTDPortNumber setTDPortNumber getTDBindName setTDBindName "
      + "setTDBindPassword getTDUseDirectoryPasswordPolicy setTDUseDirectoryPasswordPolicy",
    types: "",
    constants: "",
  },
  {
    area: "additions in DOORS 9.1",
    reason: "not built",
    functions: "regexp2",
    types: "",
    constants: "",
  },
  {
    area: "login security added in DOORS 9.2",
    reason: "not built",
    functions: "getAdditionalAuthenticationEnabled getAdditionalAuthenticationPrompt "
      + "getSystemLoginConformityRequired getCommandLinePasswordDisabled toolBarComboGetEditBoxSelection "
      + "toolBarComboCutCopySelectedText toolBarComboPasteText hasFocus addAwayModule addAwayLinkModule "
      + "exportPackage importRifFile rifMerge",
    types: "mayUseCommandLinePassword additionalAuthenticationRequired iconAuthenticatingUse PartitionDefinition "
      + "RifDefinition RifImport",
    constants: "",
  },
  {
    area: "fundamental types",
    reason: "not built",
    functions: "print null isalpha charOf intOf isValidInt random realOf cos sin tan exp log pow sqrt cistrcmp "
      + "length lower soundex findPlainText",
    types: "",
    constants: "nl pi",
  },
  {
    area: "general language facilities (files, dates, locales, configuration)",
    reason: "not built",
    functions: "canOpenFile read close flush readFile goodFileName tempFileName currentDirectory copyFile deleteFile "
      + "renameFile end format confMkdir confDeleteDirectory confRead confWrite confAppend confRenameFile "
      + "confCopyFile confDeleteFile confFileExists confUploadFile confDownloadFile today session dateOf "
      + "stringOf date shortDateFormats longDateFormats includesTime dateOnly dateAndTime find put matches "
      + "regexp start combine contains getDOSstring firstNonSpace keyword setempty setupper search putString "
      + "printCharArray",
    types: "Stream ConfType ConfStream Date Locale Skip Buffer Regexp Array",
    constants: "",
  },
  {
    area: "the operating system interface",
    reason: "not built",
    functions: "platform getenv hostname fullHostname mkdir setenv setServerMonitor serverMonitorIsOn username "
      + "system accessed directory user ipcHostname server getPort client accept send recv disconnect "
      + "setRichClip",
    types: "Stat IPC RTF_string__",
    constants: "",
  },
  {
    area: "the Windows registry",
    reason: "cannot be done here: it needs the Windows registry",
    functions: "getRegistry setRegistry deleteKeyRegistry deleteValueRegistry",
    types: "",
    constants: "",
  },
  {
    area: "client customisation, locales and code pages",
    reason: "not built",
    functions: "getDefaultColorScheme getDefaultColourScheme setDefaultColorScheme setDefaultColourScheme "
      + "optionsExist resetColors resetColor getFontSettings setFontSettings refreshExplorer synchExplorer "
      + "refreshDBExplorer setShowFormalModules showFormalModules getSelectedItem getDateFormat userLocale "
      + "name language region id locale installed attributeValue setLocale getLegacyLocale setLegacyLocale "
      + "setLineSpacing getLineSpacing getDefaultLineSpacing currentANSIcodepage codepageName write append "
      + "isValidChar convertToCodepage convertFromCodepage setMessageOfTheDay setMessageOfTheDayOption "
      + "getMessageOfTheDay getMessageOfTheDayOption setLoginFailureText getLoginFailureText "
      + "setDatabaseMailPrefixText getDatabaseMailPrefixText setEditDXLControlled getEditDXLControlled",
    types: "GraphicsFont single onePointFive AttrDef",
    constants: "CP_LATIN1 CP_UTF8 CP_UNICODE CP_UTF16_LE CP_UTF16_BE CP_JAP CP_CHS CP_KOR CP_CHT",
  },
  {
    area: "database administration, users and groups",
    reason: "not built",
    functions: "getDatabaseName setDatabaseName getAccountsDisabled setAccountsDisabled getDatabaseIdentifier "
      + "getDatabasePasswordRequired setDatabasePasswordRequired getDatabaseMinimumPasswordLength "
      + "setDatabaseMinimumPasswordLength getLoginPolicy setLoginPolicy getDisableLoginThreshold "
      + "setDisableLoginThreshold getFailedLoginThreshold setFailedLoginThreshold getLoginLoggingPolicy "
      + "setLoginLoggingPolicy setMinClientVersion getMinClientVersion setMaxClientVersion "
      + "getMaxClientVersion doorsInfo addNotifyUser deleteNotifyUser createPasswordDialog "
      + "changePasswordDialog confirmPasswordDialog copyPassword getAdministratorName findByID existsGroup "
      + "loadUserRecord ensureUserRecordLoaded saveUserRecord fullName mayEditDXL synergyUsername isAttribute "
      + "setGroup setUser addGroup deleteGroup addUser deleteUser addMember deleteMember deleteAllMembers "
      + "member getDoorsUserRoot setDoorsUserRoot getDoorsGroupRoot setDoorsGroupRoot "
      + "getDoorsUsernameAttribute setDoorsUsernameAttribute utf8 ansi",
    types: "LoginPolicy User Group UserClass",
    constants: "sUserName sUserLogin",
  },
  {
    area: "mail and broadcast messages",
    reason: "cannot be done here: it needs a mail or DOORS database server",
    functions: "getDatabaseMailServer setDatabaseMailServer getDatabaseMailServerAccount "
      + "setDatabaseMailServerAccount sendEMailNotification sendEMailMessage sendBroadcastMessage",
    types: "",
    constants: "",
  },
  {
    area: "folders, projects and items",
    reason: "not built",
    functions: "canCreate canControl canRead canModify canDelete clipCut clipCopy clipClear clipPaste clipUndo "
      + "clipLastOp itemClipboardIsEmpty inClipboard folder description path getParentFolder getParentProject "
      + "isDeleted setShowDeletedItems type uniqueID qualifiedUniqueID getReference itemFromReference "
      + "undelete purge move rename item itemFromID current convertProjectToFolder convertFolderToProject "
      + "closeFolder project getInvalidCharInProjectName closeProject openProject doorsVersion",
    types: "Item ModName_",
    constants: "",
  },
  {
    area: "modules, baselines and module loading",
    reason: "not built",
    functions: "module baseline version getSelectedCol isRead getInvalidCharInModuleName isValidDescription "
      + "isValidName isValidPrefix isVisible downgrade downgradeShare printModule save copy hardDelete "
      + "softDelete formalStatus autoIndent level filtering refresh bringToFront baselineExists major "
      + "getMostRecentBaseline getInvalidCharInSuffix load nextMajor suffix data moduleVersion isBaseline "
      + "baselineInfo versionString addModule removeModule lock unlock isAnyBaselineSetOpen inherited "
      + "specific isAccessInherited unset unsetAll isBaselinePresent minor versionID annotation isOpen "
      + "setAnnotation addBaselines baselineSet goodStringOf number when who diff lastModifiedTime markUp "
      + "undoMarkUp setUpExtraction extractAfter extractBelow addRecentlyOpenModule removeRecentlyOpenModule "
      + "getProperties",
    types: "String Baseline ModuleVersion BaselineSetDefinition Permission BaselineSet HistoryType "
      + "HistorySession ModuleProperties",
    constants: "deleteAttr manyToMany manyToOne oneToMany oneToOne unknown createType modifyType deleteType "
      + "createAttr modifyAttr createObject copyObject modifyObject deleteObject unDeleteObject purgeObject "
      + "clipCutObject clipMoveObject clipCopyObject createModule baselineModule partitionModule acceptModule "
      + "returnModule rejoinModule createLink modifyLink deleteLink readLocked LINK_HISTORY_ATTRNAME",
  },
  {
    area: "electronic signatures",
    reason: "not built",
    functions: "specifier hasPermission do getSignatureInfo isBaselineSignatureConfigured getLabelSpecifier "
      + "setLabelSpecifier appendSignatureEntry getUserName getUserFullName getEmail getLocalDate "
      + "getFormattedLocalDate getLabel getLabelOptions getComment allAttributesReadable getIsValid",
    types: "SignatureInfo SignatureInfoSpecifier__ SignatureInfoSpecifer__ SignatureEntry",
    constants: "",
  },
  {
    area: "objects",
    reason: "not built",
    functions: "canLock canUnlock object gotoObject first flushDeletions sectionNeedsSaved purgeObjects_ "
      + "getColumnBottom getColumnTop identifier getSelection setSelection deselect setSearchObject "
      + "getSearchObject clearSearchObject highlightText getInPlaceColumnIndex inplaceEditing cut "
      + "splitHeadingAndText getCursorPosition",
    types: "",
    constants: "",
  },
  {
    area: "links and external links",
    reason: "not built",
    functions: "all in sourceVersion targetVersion echo getSourceVersion addLinkModuleDescriptor "
      + "removeLinkModuleDescriptor setLinkModuleDescriptorsExclusive getLinkModuleDescriptorsExclusive "
      + "getDescription getName getSourceName getTargetName getOverridable setOverridable getMandatory "
      + "setMandatory source sourceAbsNo target targetAbsNo getDefaultLinkModule setDefaultLinkModule "
      + "getSource linkset setSource side1 side2 unload getTarget decodeURL validateDOORSURL isDefaultURL",
    types: "extLinkDir extLinkBeh Link LinkRef Linkset LinkModuleDescriptor ExternalLinkDirection "
      + "ExternalLinkBehaviour ExternalLink Database__",
    constants: "",
  },
  {
    area: "attributes and attribute types",
    reason: "not built",
    functions: "unicodeString getBoundedUnicode isMember exists getBoundedAttr hasSpecificValue isVisibleAttribute "
      + "canCreateDef canCreateVal canControlDef canControlVal canDeleteDef canDeleteVal isRanged isUsed "
      + "getRealColorOptionForTypes getRealColourOptionForTypes setRealColorOptionForTypes "
      + "setRealColourOptionForTypes setMaxValue setMinValue",
    types: "maximumAttributeLength Attr__ AttrBaseType",
    constants: "attrDXLName ACreatedBy",
  },
  {
    area: "access control and locking",
    reason: "not built",
    functions: "partition getImplied isDefault setImplied isLockedByUser",
    types: "bool AccessRec View",
    constants: "",
  },
  {
    area: "dialog boxes",
    reason: "not built",
    functions: "destroy ack acknowledge errorBox infoBox warningBox confirm block busy centred centered getTitle elp "
      + "helpOn hide raise ready realize release show showing getParent setTitle setBaseWindowContext "
      + "startConfiguringMenus stopConfiguringMenus topMost active inactive empty insert noElems select "
      + "selected useRTFColour label separator fileName field heckBox adioBox toggle choice list multiList "
      + "selectedElems listView insertColumn getColumnValue getCheck setCheck attributeDXL getDXLFileHelp "
      + "getTemplateFileName text home ok apply button background realBackground color colour realColor "
      + "realColour font height width rectangle box line ellipse draw drawAngle polarLine polygon bitmap "
      + "loadBitmap drawBitmap destroyBitmap export startPrintJob hasInPlace inPlaceMove inPlaceShow "
      + "inPlaceChoiceAdd inPlaceGet inPlaceSet inPlaceReset inPlaceTextHeight addToolTip clearToolTips "
      + "hasHeader headerAddColumn headerChange headerRemoveColumn headerReset headerSelect "
      + "headerSetHighlight headerShow hasScrollbars scrollSet updateToolBars toolBarComboGetSelection "
      + "toolBarComboGetItem toolBarComboSelect toolBarComboCount toolBarComboEmpty toolBarComboAdd "
      + "toolBarComboInsert toolBarComboDelete toolBarVisible toolBarMove toolBarShow createEditableCombo "
      + "getLogicalColorName getLogicalColourName getRealColor getRealColour getRealColorIcon "
      + "getRealColourIcon getRealColorName getRealColourName setRealColor setRealColour beside below left "
      + "leftAligned right opposite full stacked progressStart progressStep progressMessage progressRange "
      + "progressCancelled progressStop",
    types: "void Icon DropEvent Bitmap ScrollSide Sensitivity ToolType",
    constants: "keyDelete logicalGraphicsBoxEdgeColor colorGrey formatMenu SARR_DUMMY TREE_WIDTH TREE_HEIGHT "
      + "LIST_WIDTH LIST_HEIGHT tabStrings INITIAL_TREE_WIDTH INITIAL_TREE_HEIGHT keyInsert keyHome keyEnd "
      + "keyPageUp keyPageDown keyUp keyDown keyLeft keyRight keyHelp keyF1 keyF2 keyF3 keyF4 keyF5 keyF6 "
      + "keyF7 keyF8 keyF9 keyF10 keyF11 keyF12",
  },
  {
    area: "templates",
    reason: "not built",
    functions: "template instance",
    types: "",
    constants: "",
  },
  {
    area: "DOORS window control",
    reason: "not built",
    functions: "status menuStatus createButtonBar createItem createPopup",
    types: "",
    constants: "",
  },
  {
    area: "display, views, filters and sorting",
    reason: "not built",
    functions: "addFilter contents excludeCurrent excludeLeaves filterTables includeCurrent includeLeaves hasLinks "
      + "hasNoLinks isNull notNull reject ancestors includes excludes ascending descending sorting "
      + "isAscending isDescending destroySort currentView descendants view setPreloadedView preloadedView "
      + "isInheritedView linkIndicators next clearDefaultViewForModule clearDefaultViewForUser "
      + "getDefaultViewForModule getDefaultViewForUser setDefaultViewForModule setDefaultViewForUser "
      + "showDeletedObjects showChangeBars showGraphicsDatatips showGraphicsLinks showingExplorer "
      + "showExplorer showPrintDialogs canInheritView clearInvalidInheritanceOf invalidInheritedView canWrite "
      + "createPrivate createPublic change useAncestors useDescendants useCurrent useSelection "
      + "useFilterTables useGraphicsColumn useShowExplorer useGraphics useOutlining useCompression useLevel "
      + "useShowDeleted useShowPictures useShowTables useShowLinkIndicators useShowLinks useTooltipColumn "
      + "useWindows useAutoIndentation column attribute attrName dxl graphics info justify main title display "
      + "displayRich displayRichWithColor displayRichWithColour getCanvas hasPicture isFirstObjectInDXLSet "
      + "isLastObjectInDXLSet",
    types: "LinkFilter Filter Sort Column Justification",
    constants: "",
  },
  {
    area: "partitions",
    reason: "not built",
    functions: "loadInPartitionDef saveModified addLinkModule findModule findLinkset findAttribute findView "
      + "addAttribute addAwayAttribute addLinkset addAwayLinkset addView addAwayView removeAttribute "
      + "removeLinkset removeView allowsAccess setAccess open acceptReport acceptPartition returnPartition "
      + "rejoinReport rejoinPartition removePartition isPartitionedOut getPartitionMask",
    types: "PartitionModule PartitionView PartitionPermission PartitionFile",
    constants: "",
  },
  {
    area: "pictures and embedded objects",
    reason: "not built",
    functions: "isOleObjectSelected showOlePropertiesDialog containsOle getOleWidthHeight changePicture "
      + "copyPictureObject deletePicture exportPicture getPictBB getPictFormat getPictName getPictWidthHeight "
      + "importPicture insertBitmapFromClipboard saveClipboardBitmapToFile insertPictureAfter "
      + "insertPictureBelow insertPictureFile insertPictureFileAfter insertPictureFileBelow openPictFile "
      + "pictureCopy reimportPicture supportedPictureFormat pictureCompatible clear",
    types: "",
    constants: "",
  },
  {
    area: "page setup and printing",
    reason: "not built",
    functions: "pageChangeBars pageSize pageBreakLevel pageHeaderFooter pageExpandHF pageColumns pageTitlePage "
      + "pageSignaturePage pageIncludeFilters pageIncludeSort pageLayout pageName",
    types: "PageLayout",
    constants: "paperA4",
  },
  {
    area: "tables",
    reason: "not built",
    functions: "table row cell tableContents deleteCell undeleteCell appendCell appendColumn appendRow insertCell "
      + "insertRow getTable getRow getCellAlignment getCellWidth getCellShowChangeBars getCellShowLinkArrows "
      + "getShowTableAcrossModule setAllCellsAlignment setAllCellsBorder setAllCellsShowChangeBars "
      + "setAllCellsShowLinkArrows setAllCellsWidth setCellAlignment setCellBorder setCellShowChangeBars "
      + "setCellShowLinkArrows setCellWidth setColumnAlignment setColumnShowChangeBars "
      + "setColumnShowLinkArrows setColumnWidth setRowWidth setShowTableAcrossModule toTable "
      + "useDefaultTableAttribute enableDefaultTableAttribute overrideTableAttribute defaultTableAttribute",
    types: "TableBorderPosition TableBorderStyle",
    constants: "bottom noborder solidBorder dottedborder top",
  },
  {
    area: "rich text",
    reason: "not built",
    functions: "richTextWithOle richTextNoOle richtext_identifier pasteToEditbox rtfSubString "
      + "applyTextFormattingToParagraph exportRTFString charsetDefault characterSet fontTable importRTF "
      + "enableObjectTextAssignmentWarnings disableObjectTextAssignmentWarnings "
      + "enableObjectTextRichTextWarnings disableObjectTextRichTextWarnings enableGeneralRichTextWarnings "
      + "disableGeneralRichTextWarnings enableRepeatWarnings disableRepeatWarnings disableDisplayWarnings "
      + "enableDisplayWarnings dxlWarningFilename dxlWarningLineNumber",
    types: "",
    constants: "",
  },
  {
    area: "the spelling checker",
    reason: "not built",
    functions: "spell spellFix alternative alternatives getNextError spellingErrors getErrorString getErrorStartPos "
      + "getErrorStopPos getSentenceStartPos getSentenceStopPos getCorrectionComplete ignoreWord languages "
      + "spGetLanguages getLanguage getId isSupported getGrammarRules getExplanation getOptions setLanguage "
      + "getEnglishOptions setEnglishOptions getUKOptions setUKOptions getFrenchOptions setFrenchOptions "
      + "getGermanOptions setGermanOptions getGreekOptions setGreekOptions getSpanishOptions "
      + "setSpanishOptions getCatalanOptions setCatalanOptions getRussianOptions setRussianOptions "
      + "getGrammarLevel setGrammarLevel setSpellingCheckingMode getSpellingCheckingMode getSpellingFirst "
      + "setSpellingFirst getIgnoreReadOnly setIgnoreReadOnly getWord getAlternative remove isDatabaseDict "
      + "anagram wildcard",
    types: "lang alternativeWord SpellingError Language SpellOptions GrammarRules SpellingOptions Dictionary",
    constants: "",
  },
  {
    area: "the database integrity checker",
    reason: "not built",
    functions: "checkDatabaseIntegrity checkFolderIntegrity cancelled problems timestamp parentRefID parentRef "
      + "addProjectEntry convertToFolder repaired checkItem everSectioned",
    types: "IntegrityResultsData IntegrityCheckItem IntegrityProblem ProblemItem",
    constants: "",
  },
  {
    area: "general functions (archive, restore, locks, errors)",
    reason: "not built",
    functions: "error lastError noError unixerror warn dxlHere archive archiveFiles getArchiveType getModuleDetails "
      + "getProjectDetails getUserlistDetails restore restoreModule restoreFiles restoreProject "
      + "restoreUserlist getLocksInDatabase getLocksInFolder getLocksInModule isLocked isLockedClosed "
      + "shareLock requestLock htmlText setAttrFromHTML helpOnEx",
    types: "ArchiveInclusionDescriptor ArchiveData ArchiveItem LockList Lock",
    constants: "",
  },
  {
    area: "server archives",
    reason: "cannot be done here: it needs a DOORS database server",
    functions: "canCreateServerArchive canRestoreServerArchive canReadServerArchiveFile canWriteServerArchiveFile "
      + "canUseServerArchive",
    types: "",
    constants: "",
  },
];
