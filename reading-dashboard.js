/* Local reading progress and vocabulary for the current Zotero item list. */
var VocabBookReadingDashboard = (() => {
  const PREF_READING = "extensions.vocabbook.readingProgress";
  const BUTTON_ID = "vocab-book-reading-button";
  const PANEL_ID = "vocab-book-reading-panel";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const windows = new Map();
  const ICON = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M10 4C7 2 4 2 2 3v13c3-1 5-1 8 1 3-2 5-2 8-1V3c-2-1-5-1-8 1Zm0 0v13" fill="none" stroke="#1672c4" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  );

  function html(doc, tag, text, styles = {}) {
    const element = doc.createElementNS(HTML_NS, tag);
    Object.assign(element.style, {
      boxSizing: "border-box", minWidth: "0", fontFamily: "system-ui, sans-serif",
      fontSize: "12px", lineHeight: "1.5", overflowWrap: "anywhere",
    }, styles);
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function button(doc, label, callback) {
    const element = html(doc, "button", label, {
      padding: "4px 9px", minHeight: "29px", border: "1px solid GrayText",
      borderRadius: "5px", cursor: "pointer", whiteSpace: "normal", flexShrink: "0",
    });
    element.type = "button";
    element.style.setProperty("appearance", "none", "important");
    element.style.setProperty("background-image", "none", "important");
    element.style.setProperty("background-color", "ButtonFace", "important");
    element.style.setProperty("color", "ButtonText", "important");
    element.addEventListener("click", callback);
    return element;
  }

  function readStore() {
    const raw = Zotero.Prefs.get(PREF_READING, true);
    if (!raw) return { version: 1, records: Object.create(null) };
    let data;
    try { data = JSON.parse(raw); }
    catch (error) { throw new Error("阅读记录格式错误，已保留原始数据，请先备份后修复。"); }
    if (!data || data.version !== 1 || !data.records || typeof data.records !== "object"
      || Array.isArray(data.records)) {
      throw new Error("无法识别阅读记录格式，已保留原始数据。");
    }
    return data;
  }

  function itemKey(item) {
    if (item.libraryID === undefined || item.libraryID === null || !item.key) return null;
    return `${item.libraryID}/${item.key}`;
  }

  function getRecord(item) {
    const value = readStore().records[itemKey(item)];
    return {
      read: value?.read === true,
      note: typeof value?.note === "string" ? value.note : "",
    };
  }

  function saveRecord(item, patch) {
    const key = itemKey(item);
    if (!key) throw new Error("此条目尚无文献标识，暂不能保存阅读记录。");
    // Re-read before each write so multiple windows do not replace one another's records.
    const data = readStore();
    const previous = data.records[key];
    data.records[key] = {
      ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}),
      ...patch, updatedAt: new Date().toISOString(),
    };
    Zotero.Prefs.set(PREF_READING, JSON.stringify(data), true);
  }

  function currentItems(window) {
    const pane = window.ZoteroPane || window.ZoteroPane_Local;
    // Both methods are supplied by Zotero; itemsView is the library's current filtered list.
    const items = pane?.itemsView?.getSortedItems
      ? pane.itemsView.getSortedItems()
      : pane?.getSortedItems?.();
    if (!Array.isArray(items)) throw new Error("当前文献列表尚未加载，请稍后点击刷新。");
    const result = [];
    const seen = new Set();
    for (let item of items) {
      if (!item || item.isNote?.() || item.isAnnotation?.()) continue;
      if (item.parentItemID) item = Zotero.Items.get(item.parentItemID);
      if (!item || item.isNote?.() || item.isAnnotation?.()) continue;
      if (item.isRegularItem && !item.isRegularItem() && !item.isAttachment?.()) continue;
      const key = itemKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  function wordsForItem(words, item) {
    const result = [];
    for (const entry of words) {
      if (!entry || !entry.word) continue;
      const locations = Array.isArray(entry.locations)
        ? entry.locations.filter(value => value && value.itemID === item.id).slice().reverse() : [];
      const hasAttachment = value => Number.isInteger(value.attachmentID) && value.attachmentID > 0;
      const hasPosition = value => Array.isArray(value.position?.rects)
        && value.position.rects.length > 0
        && value.position.rects.every(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite));
      // The most recent PDF selection is more useful than an earlier manual entry.
      const location = locations.find(value => hasAttachment(value) && hasPosition(value))
        || locations.find(hasAttachment) || locations[0];
      if (location) result.push({ ...entry, ...location });
      else if (entry.itemID === item.id) result.push(entry);
    }
    return result;
  }

  function report(state, message, isError = false) {
    state.status.textContent = message;
    state.status.setAttribute("role", isError ? "alert" : "status");
    state.status.style.color = isError ? "#b42318" : "CanvasText";
  }

  function updateReadButton(element, read) {
    element.textContent = read ? "✓ 已读" : "○ 未读";
    element.setAttribute("aria-pressed", String(read));
    element.setAttribute("title", read ? "点击标记为未读" : "点击标记为已读");
    element.style.setProperty("background-color", read ? "#176b3a" : "ButtonFace", "important");
    element.style.setProperty("color", read ? "#ffffff" : "ButtonText", "important");
  }

  function updateSummary(state) {
    const read = Array.from(state.rowButtons.values())
      .filter(element => element.getAttribute("aria-pressed") === "true").length;
    state.summary.textContent = `当前列表 ${state.rowButtons.size} 篇 · 已读 ${read} 篇`;
  }

  function renderRow(state, item, words, record) {
    const doc = state.window.document;
    const key = itemKey(item);
    const title = item.getDisplayTitle?.() || item.getField?.("title") || "无标题文献";
    const row = html(doc, "article", null, {
      border: "1px solid GrayText", borderRadius: "7px", padding: "9px", marginBottom: "8px",
      backgroundColor: "Canvas", color: "CanvasText",
    });
    row.dataset.itemKey = key;
    const heading = html(doc, "div", null, { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "start" });
    const titleElement = html(doc, "strong", title, { flex: "1 1 220px", fontWeight: "600" });
    heading.append(titleElement);
    const readButton = button(doc, "", () => {
      try {
        const read = !getRecord(item).read;
        saveRecord(item, { read });
        updateReadButton(readButton, read);
        updateSummary(state);
        for (const other of windows.values()) {
          if (other === state) continue;
          const otherButton = other.rowButtons.get(key);
          if (otherButton) {
            updateReadButton(otherButton, read);
            updateSummary(other);
          }
        }
        report(state, `已将“${title}”标记为${read ? "已读" : "未读"}。`);
      }
      catch (error) { report(state, String(error.message || error), true); }
    });
    readButton.setAttribute("aria-label", `${title}：切换已读状态`);
    updateReadButton(readButton, record.read);
    state.rowButtons.set(key, readButton);
    heading.append(readButton);
    row.append(heading);

    const details = html(doc, "details", null, { marginTop: "7px" });
    details.append(html(doc, "summary", `生词本 · ${words.length} 词`, { cursor: "pointer", fontWeight: "600" }));
    const preview = html(doc, "div", null, {
      display: "flex", flexDirection: "column", gap: "5px", marginTop: "6px", maxHeight: "180px", overflowY: "auto",
    });
    if (!words.length) preview.append(html(doc, "p", "这篇文献还没有生词。", { margin: "3px 0" }));
    for (const entry of words) {
      const word = button(doc, `${entry.word} — ${entry.meaning || "待补充释义"}`, async () => {
        try {
          if (typeof state.options.openWordLocation !== "function") throw new Error("暂时无法打开生词原文位置。");
          await state.options.openWordLocation(entry);
          report(state, `已打开 ${entry.word} 的原文位置。`);
        }
        catch (error) { report(state, String(error.message || error), true); }
      });
      word.style.textAlign = "left";
      word.setAttribute("title", entry.contextSentence || "点击打开原文位置");
      preview.append(word);
    }
    details.append(preview);
    row.append(details);

    const noteLabel = html(doc, "label", "阅读笔记 / 读后想法", { display: "block", marginTop: "8px" });
    const note = html(doc, "textarea", null, {
      width: "100%", minHeight: "60px", maxHeight: "200px", resize: "vertical",
      padding: "6px", backgroundColor: "Field", color: "FieldText", border: "1px solid GrayText", borderRadius: "4px",
    });
    note.rows = 2;
    note.setAttribute("aria-label", `${title}：阅读笔记`);
    note.placeholder = "记录这篇文献的主要观点、疑问或读后想法…";
    note.value = state.drafts.has(key) ? state.drafts.get(key) : record.note;
    noteLabel.append(note);
    row.append(noteLabel);
    const footer = html(doc, "div", null, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginTop: "5px" });
    const feedback = html(doc, "span", "", { flex: "1 1 150px" });
    feedback.setAttribute("role", "status");
    let savedNote = record.note;
    const updateDraftStatus = () => {
      const dirty = note.value !== savedNote;
      feedback.textContent = dirty ? "有未保存的修改" : "";
      save.disabled = !dirty;
    };
    const save = button(doc, "保存笔记", () => {
      try {
        saveRecord(item, { note: note.value });
        savedNote = note.value;
        state.drafts.delete(key);
        save.disabled = true;
        feedback.textContent = "笔记已保存到本机";
      }
      catch (error) { report(state, String(error.message || error), true); }
    });
    note.addEventListener("input", () => {
      state.drafts.set(key, note.value);
      updateDraftStatus();
    });
    updateDraftStatus();
    footer.append(save, feedback);
    row.append(footer);
    return row;
  }

  function refresh(state) {
    try {
      const items = currentItems(state.window);
      const store = readStore();
      const words = state.options.getVocabList?.() || [];
      if (!Array.isArray(words)) throw new Error("生词本格式错误，暂时无法显示生词预览。");
      const doc = state.window.document;
      const fragment = doc.createDocumentFragment();
      state.rowButtons.clear();
      for (const item of items) {
        const value = store.records[itemKey(item)];
        const record = { read: value?.read === true, note: typeof value?.note === "string" ? value.note : "" };
        const paperWords = state.options.getWordsForPaper
          ? state.options.getWordsForPaper(words, item.id) : wordsForItem(words, item);
        if (!Array.isArray(paperWords)) throw new Error("无法读取当前文献的生词。");
        fragment.append(renderRow(state, item, paperWords, record));
      }
      if (!items.length) fragment.append(html(doc, "p", "当前列表中没有文献。切换分类或调整搜索条件后点击刷新。"));
      state.list.replaceChildren(fragment);
      updateSummary(state);
      report(state, "已加载当前文献列表。笔记与已读标记保存在本机，编辑笔记后请点击保存。",
        false);
      return true;
    }
    catch (error) {
      report(state, String(error.message || error), true);
      return false;
    }
  }

  function setOpen(state, open) {
    state.open = open;
    state.panel.hidden = !open;
    state.panel.style.display = open ? "block" : "none";
    state.button.setAttribute("aria-expanded", String(open));
    if (open) refresh(state);
  }

  function install(window, options = {}) {
    if (windows.has(window)) return true;
    const doc = window.document;
    const toolbar = doc.getElementById("zotero-items-toolbar");
    const toolbarContainer = doc.getElementById("zotero-toolbar-item-tree");
    const host = doc.getElementById("zotero-items-pane-container");
    if (!toolbar || !toolbarContainer || !host) return false;

    const toolbarButton = doc.createXULElement ? doc.createXULElement("toolbarbutton") : html(doc, "button");
    toolbarButton.id = BUTTON_ID;
    toolbarButton.setAttribute("class", "zotero-tb-button");
    toolbarButton.setAttribute("image", ICON);
    toolbarButton.setAttribute("label", "阅读管理");
    toolbarButton.setAttribute("tooltiptext", "阅读管理：当前列表的阅读进度、笔记和生词本");
    toolbarButton.setAttribute("aria-label", "阅读管理");
    toolbarButton.setAttribute("aria-controls", PANEL_ID);
    toolbarButton.setAttribute("aria-expanded", "false");
    const spacer = Array.from(toolbar.children).find(element => element.localName === "spacer");
    toolbar.insertBefore(toolbarButton, spacer || null);

    const panel = html(doc, "section", null, {
      colorScheme: "light dark", backgroundColor: "Canvas", color: "CanvasText", borderBottom: "1px solid GrayText",
      padding: "9px", flex: "0 0 auto", width: "100%", maxWidth: "100%", overflow: "hidden",
    });
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "阅读管理");
    const state = {
      window, options, panel, button: toolbarButton, open: false, drafts: new Map(), rowButtons: new Map(),
    };
    const header = html(doc, "div", null, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" });
    header.append(html(doc, "strong", "📖 阅读管理", { fontSize: "14px" }));
    state.summary = html(doc, "span", "", { flex: "1 1 160px" });
    header.append(state.summary, button(doc, "刷新当前列表", () => refresh(state)), button(doc, "收起", () => setOpen(state, false)));
    state.status = html(doc, "p", "", { margin: "5px 0 8px" });
    state.status.setAttribute("aria-live", "polite");
    state.list = html(doc, "div", null, { maxHeight: "min(42vh, 430px)", overflowY: "auto", overscrollBehavior: "contain", paddingRight: "3px" });
    state.list.setAttribute("tabindex", "0");
    state.list.setAttribute("aria-label", "当前文献的阅读记录");
    panel.append(header, state.status, state.list);
    host.insertBefore(panel, toolbarContainer.nextSibling);
    // XUL toolbarbuttons emit command for both pointer and keyboard activation.
    state.onToggle = () => setOpen(state, !state.open);
    state.toggleEvent = doc.createXULElement ? "command" : "click";
    toolbarButton.addEventListener(state.toggleEvent, state.onToggle);
    state.onUnload = () => uninstall(window);
    window.addEventListener("unload", state.onUnload, { once: true });
    windows.set(window, state);
    setOpen(state, false);
    return true;
  }

  function uninstall(window) {
    const state = windows.get(window);
    if (!state) return;
    state.button.removeEventListener(state.toggleEvent, state.onToggle);
    window.removeEventListener("unload", state.onUnload);
    state.button.remove();
    state.panel.remove();
    state.drafts.clear();
    state.rowButtons.clear();
    windows.delete(window);
  }

  return { install, uninstall, shutdown() { for (const window of Array.from(windows.keys())) uninstall(window); } };
})();
