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

  function html(doc, tag, text, className = "") {
    const element = doc.createElementNS(HTML_NS, tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function button(doc, label, callback, className = "") {
    const element = html(doc, "button", label, `vb-button ${className}`);
    element.type = "button";
    element.addEventListener("click", callback);
    return element;
  }

  function icon(doc, name) {
    const paths = {
      book: "M10 4C7 2 4 2 2 3v13c3-1 5-1 8 1 3-2 5-2 8-1V3c-2-1-5-1-8 1Zm0 0v13",
      note: "M12 3H4v14h12V9M10 11l1-4 5-5 3 3-5 5-4 1Z",
      check: "m5 10 3 3 7-7",
      circle: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
      chevron: "m6 8 4 4 4-4",
      refresh: "M16 7a7 7 0 1 0 1 6M16 2v5h-5",
      close: "m5 5 10 10M15 5 5 15",
      arrow: "M5 15 15 5M5 5h10v10",
    };
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("class", "vb-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = doc.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[name] || paths.book);
    svg.append(path);
    return svg;
  }

  function labelButton(doc, element, name, label) {
    element.replaceChildren(icon(doc, name), html(doc, "span", label));
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
    state.status.hidden = !message;
    state.status.setAttribute("role", isError ? "alert" : "status");
  }

  function updateReadButton(element, read) {
    labelButton(element.ownerDocument, element, read ? "check" : "circle", read ? "已读" : "未读");
    element.setAttribute("aria-pressed", String(read));
    element.setAttribute("aria-label", `${element.dataset.title}：${read ? "标记为未读" : "标记为已读"}`);
    element.title = read ? "点击标记为未读" : "点击标记为已读";
    element.closest("article").dataset.read = String(read);
  }

  function updateSummary(state) {
    const total = state.rowButtons.size;
    const read = Array.from(state.rowButtons.values())
      .filter(element => element.getAttribute("aria-pressed") === "true").length;
    state.summary.textContent = `当前列表 ${total} 篇 · 已读 ${read} 篇`;
    state.progress.max = total || 1;
    state.progress.value = read;
    state.progress.setAttribute("aria-label", `阅读进度：${read} / ${total} 篇`);
    const counts = { all: total, unread: total - read, read };
    let visible = 0;
    for (const [key, element] of state.filters) {
      element.querySelector(".vb-count").textContent = counts[key];
      element.setAttribute("aria-pressed", String(state.filter === key));
    }
    for (const element of state.rowButtons.values()) {
      const row = element.closest("article");
      const isRead = element.getAttribute("aria-pressed") === "true";
      const show = state.filter === "all" || (state.filter === "read") === isRead;
      if (!show && row.contains(state.window.document.activeElement)) state.filters.get(state.filter).focus();
      row.hidden = !show;
      if (show) visible++;
    }
    state.empty.hidden = visible > 0;
    state.empty.textContent = total === 0
      ? "当前列表中没有文献。切换分类或调整搜索条件后刷新。"
      : state.filter === "unread" ? "当前列表的文献都已读完。" : "还没有标记为已读的文献。";
  }

  function renderWords(state, words) {
    const doc = state.window.document;
    const preview = html(doc, "div", null, "vb-word-grid");
    if (!words.length) {
      preview.append(html(doc, "p", "还没有收录生词。在 PDF 中选词后，可在这里回顾。", "vb-empty"));
    }
    for (const entry of words) {
      const card = html(doc, "div", null, "vb-word-card");
      const heading = html(doc, "div", null, "vb-word-heading");
      const level = [0, 1, 2].includes(entry.mastery) ? entry.mastery : 0;
      heading.append(html(doc, "strong", entry.word, "vb-word"),
        html(doc, "span", ["待熟悉", "复习中", "已掌握"][level], `vb-mastery vb-level-${level}`));
      card.append(heading, html(doc, "p", entry.meaning || "待补充释义", "vb-meaning"));
      if (entry.contextSentence) {
        const context = html(doc, "p", entry.contextSentence, "vb-context");
        context.title = entry.contextSentence;
        card.append(context);
      }
      const footer = html(doc, "div", null, "vb-word-footer");
      const pageIndex = entry.position?.pageIndex ?? entry.pageIndex;
      footer.append(html(doc, "span", Number.isInteger(pageIndex) && pageIndex >= 0 ? `第 ${pageIndex + 1} 页` : "文献来源", "vb-muted"));
      const locate = button(doc, "", async () => {
        locate.disabled = true;
        try {
          if (typeof state.options.openWordLocation !== "function") throw new Error("暂时无法打开生词原文位置。");
          const opened = await state.options.openWordLocation(entry);
          if (opened === false) throw new Error("未能打开原文，请检查对应 PDF 附件是否仍可访问。");
          report(state, `已打开 ${entry.word} 的原文位置。`);
        }
        catch (error) { report(state, String(error.message || error), true); }
        finally { locate.disabled = false; }
      }, "vb-locate");
      labelButton(doc, locate, "arrow", "定位原词");
      locate.setAttribute("aria-label", `定位原词：${entry.word}`);
      if (!entry.attachmentID) {
        locate.disabled = true;
        labelButton(doc, locate, "arrow", "无原文位置");
        locate.title = "此词没有关联 PDF 附件，可从阅读器重新收录以记录位置";
      }
      footer.append(locate);
      card.append(footer);
      preview.append(card);
    }
    return preview;
  }

  function renderRow(state, item, words, record) {
    const doc = state.window.document;
    const key = itemKey(item);
    const title = item.getDisplayTitle?.() || item.getField?.("title") || "无标题文献";
    const row = html(doc, "article", null, "vb-paper-card");
    row.dataset.itemKey = key;
    const heading = html(doc, "div", null, "vb-card-heading");
    const titleBlock = html(doc, "div", null, "vb-title-block");
    const titleElement = html(doc, "h3", title, "vb-paper-title");
    titleElement.title = title;
    titleBlock.append(titleElement);
    // Standalone attachments do not support every bibliographic field.
    const field = name => { try { return item.getField?.(name) || ""; } catch (_) { return ""; } };
    const meta = [field("firstCreator"), String(field("date")).match(/\b\d{4}\b/)?.[0], field("publicationTitle")].filter(Boolean).join(" · ");
    if (meta) titleBlock.append(html(doc, "p", meta, "vb-paper-meta"));
    const readButton = button(doc, "", () => {
      try {
        const read = !getRecord(item).read;
        saveRecord(item, { read });
        for (const other of windows.values()) {
          const otherButton = other.rowButtons.get(key);
          if (otherButton) {
            updateReadButton(otherButton, read);
            updateSummary(other);
          }
        }
        report(state, read ? "已标记为已读，可再次点击撤回。" : "已标记为未读。");
      }
      catch (error) { report(state, String(error.message || error), true); }
    }, "vb-read-toggle");
    readButton.dataset.title = title;
    heading.append(titleBlock, readButton);
    row.append(heading);
    updateReadButton(readButton, record.read);
    state.rowButtons.set(key, readButton);

    const actions = html(doc, "div", null, "vb-card-actions");
    const content = html(doc, "div", null, "vb-card-content");
    content.id = `vocab-book-detail-${item.libraryID}-${item.key}`;
    content.hidden = true;
    let savedNote = record.note;
    let section = "";
    const toggle = target => {
      section = section === target ? "" : target;
      if (section) state.sections.set(key, section); else state.sections.delete(key);
      renderContent(true);
      if (section && state.window.requestAnimationFrame) state.window.requestAnimationFrame(() => {
        if (!content.isConnected || content.hidden) return;
        const bounds = content.getBoundingClientRect();
        const viewport = state.list.getBoundingClientRect();
        const overflow = bounds.bottom - viewport.bottom + 6;
        // Scroll only our list, leaving Zotero's surrounding panes in place.
        if (overflow > 0) state.list.scrollTop += Math.min(overflow, Math.max(0, bounds.top - viewport.top - 44));
      });
    };
    const vocabButton = button(doc, "", () => toggle("words"), "vb-section-button");
    labelButton(doc, vocabButton, "book", `生词本 · ${words.length}`);
    vocabButton.append(icon(doc, "chevron"));
    const noteButton = button(doc, "", () => toggle("note"), "vb-section-button");
    for (const element of [vocabButton, noteButton]) {
      element.setAttribute("aria-controls", content.id);
      element.setAttribute("aria-expanded", "false");
    }
    actions.append(vocabButton, noteButton);
    const excerpt = html(doc, "p", "", "vb-note-excerpt");
    const updateNoteLabel = () => {
      const dirty = state.drafts.has(key) && state.drafts.get(key) !== savedNote;
      labelButton(doc, noteButton, "note", dirty ? "笔记 · 未保存" : savedNote ? "阅读笔记 · 已记录" : "写笔记");
      noteButton.append(icon(doc, "chevron"));
      noteButton.dataset.dirty = String(dirty);
      excerpt.textContent = savedNote;
      excerpt.hidden = !savedNote || section === "note";
    };

    function renderNote(editing, focus) {
      content.replaceChildren();
      if (!editing && savedNote) {
        content.append(html(doc, "p", savedNote, "vb-note-text"));
        const edit = button(doc, "编辑笔记", () => {
          state.editing.add(key);
          renderNote(true, true);
        }, "vb-secondary");
        content.append(edit);
        return;
      }
      state.editing.add(key);
      const note = html(doc, "textarea", null, "vb-note-input");
      note.rows = 4;
      note.setAttribute("aria-label", `${title}：阅读笔记`);
      note.placeholder = "记下这篇文献的观点、疑问或下一步想法…";
      note.value = state.drafts.has(key) ? state.drafts.get(key) : savedNote;
      const footer = html(doc, "div", null, "vb-note-footer");
      const feedback = html(doc, "span", "", "vb-draft-status");
      feedback.setAttribute("role", "status");
      const updateDraftStatus = () => {
        const dirty = note.value !== savedNote;
        feedback.textContent = dirty ? "有未保存的修改" : "笔记保存在本机";
        save.disabled = !dirty;
        updateNoteLabel();
      };
      const save = button(doc, "保存笔记", () => {
        try {
          saveRecord(item, { note: note.value });
          savedNote = note.value;
          state.drafts.delete(key);
          state.editing.delete(key);
          if (!savedNote) { section = ""; state.sections.delete(key); }
          renderContent(false);
          noteButton.focus();
          report(state, "笔记已保存到本机。");
          // Refresh other windows only when this paper has no unsaved draft there.
          for (const other of windows.values()) {
            if (other !== state && other.open && !other.drafts.has(key) && !other.editing.has(key)) refresh(other, false);
          }
        }
        catch (error) { report(state, String(error.message || error), true); }
      }, "vb-primary");
      const cancel = button(doc, "取消", () => {
        state.drafts.delete(key);
        state.editing.delete(key);
        if (!savedNote) { section = ""; state.sections.delete(key); }
        renderContent(false);
        noteButton.focus();
      }, "vb-secondary");
      cancel.title = "放弃本次未保存的修改";
      note.addEventListener("input", () => {
        if (note.value === savedNote) state.drafts.delete(key); else state.drafts.set(key, note.value);
        updateDraftStatus();
      });
      note.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); if (!save.disabled) save.click(); }
      });
      updateDraftStatus();
      footer.append(feedback, cancel, save);
      content.append(note, footer);
      if (focus) note.focus();
    }

    function renderContent(focus = false) {
      content.hidden = !section;
      vocabButton.setAttribute("aria-expanded", String(section === "words"));
      noteButton.setAttribute("aria-expanded", String(section === "note"));
      updateNoteLabel();
      if (section === "words") content.replaceChildren(renderWords(state, words));
      else if (section === "note") renderNote(state.editing.has(key) || state.drafts.has(key) || !savedNote, focus);
      else content.replaceChildren();
    }
    row.append(actions, excerpt, content);
    section = state.sections.get(key) || "";
    renderContent();
    return row;
  }

  function refresh(state, announce = true) {
    try {
      const items = currentItems(state.window);
      const store = readStore();
      const words = state.options.getVocabList?.() || [];
      if (!Array.isArray(words)) throw new Error("生词本格式错误，暂时无法显示生词预览。");
      const doc = state.window.document;
      const fragment = doc.createDocumentFragment();
      const previousButtons = state.rowButtons;
      state.rowButtons = new Map();
      try {
        for (const item of items) {
          const value = store.records[itemKey(item)];
          const record = { read: value?.read === true, note: typeof value?.note === "string" ? value.note : "" };
          const paperWords = state.options.getWordsForPaper
            ? state.options.getWordsForPaper(words, item.id) : wordsForItem(words, item);
          if (!Array.isArray(paperWords)) throw new Error("无法读取当前文献的生词。");
          fragment.append(renderRow(state, item, paperWords, record));
        }
      }
      catch (error) { state.rowButtons = previousButtons; throw error; }
      const scrollTop = state.list.scrollTop;
      state.cards.replaceChildren(fragment);
      updateSummary(state);
      state.list.scrollTop = scrollTop;
      if (announce) report(state, "");
      return true;
    }
    catch (error) { report(state, String(error.message || error), true); return false; }
  }

  function setOpen(state, open) {
    state.open = open;
    state.panel.hidden = !open;
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
    const stylesheet = html(doc, "link");
    stylesheet.rel = "stylesheet";
    if (typeof stylesheetURI === "string") stylesheet.href = stylesheetURI;
    (doc.head || doc.documentElement).append(stylesheet);

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

    const panel = html(doc, "section");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "阅读管理");
    const state = {
      window, options, panel, stylesheet, button: toolbarButton, open: false, filter: "all",
      drafts: new Map(), rowButtons: new Map(), filters: new Map(), sections: new Map(), editing: new Set(),
    };
    const header = html(doc, "div", null, "vb-header");
    const brand = html(doc, "div", null, "vb-brand");
    const brandIcon = html(doc, "span", null, "vb-brand-icon");
    brandIcon.append(icon(doc, "book"));
    const heading = html(doc, "div");
    heading.append(html(doc, "h2", "阅读管理"));
    state.summary = html(doc, "p", "", "vb-summary");
    heading.append(state.summary);
    brand.append(brandIcon, heading);
    const controls = html(doc, "div", null, "vb-header-actions");
    const reload = button(doc, "", () => refresh(state), "vb-secondary");
    labelButton(doc, reload, "refresh", "刷新列表");
    reload.title = "刷新当前分类或搜索列表";
    const collapse = button(doc, "", () => { setOpen(state, false); toolbarButton.focus(); }, "vb-icon-button");
    collapse.append(icon(doc, "close"));
    collapse.setAttribute("aria-label", "收起阅读管理");
    collapse.title = "收起阅读管理";
    controls.append(reload, collapse);
    header.append(brand, controls);
    const filterbar = html(doc, "div", null, "vb-filterbar");
    const filters = html(doc, "div", null, "vb-filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "筛选阅读状态");
    for (const [key, label] of [["all", "全部"], ["unread", "未读"], ["read", "已读"]]) {
      const filter = button(doc, "", () => { state.filter = key; updateSummary(state); }, "vb-filter");
      filter.append(html(doc, "span", label), html(doc, "span", "0", "vb-count"));
      filter.setAttribute("aria-label", `筛选${label}文献`);
      state.filters.set(key, filter);
      filters.append(filter);
    }
    state.progress = html(doc, "progress", null, "vb-progress");
    filterbar.append(filters, state.progress);
    state.status = html(doc, "p", "", "vb-status");
    state.status.hidden = true;
    state.status.setAttribute("aria-live", "polite");
    state.list = html(doc, "div", null, "vb-list");
    state.list.setAttribute("tabindex", "0");
    state.list.setAttribute("aria-label", "当前文献的阅读记录");
    state.cards = html(doc, "div", null, "vb-paper-grid");
    state.empty = html(doc, "p", "", "vb-empty");
    state.empty.hidden = true;
    state.list.append(state.cards, state.empty);
    panel.append(header, filterbar, state.status, state.list);
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
    state.stylesheet.remove();
    windows.delete(window);
  }

  return { install, uninstall, shutdown() { for (const window of Array.from(windows.keys())) uninstall(window); } };
})();
