var registeredSectionID = null;
var activeSidebarContainers = new Set();

const PLUGIN_ID = "vocab-book@custom.zotero.org";
const PREF_WORDS = "extensions.vocabbook.words";
const PREF_BAIDU_KEY = "extensions.vocabbook.baiduKey";

// ==========================================
// 1. 工具函数：DOM 创建、纯正 UTF-8 MD5 与剪贴板兼容
// ==========================================
function createHTML(doc, tag, styles = {}, attrs = {}) {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  Object.assign(el.style, {
    boxSizing: "border-box", minWidth: "0", lineHeight: "1.5",
    fontFamily: "system-ui, sans-serif", overflowWrap: "anywhere",
    ...(["button", "input"].includes(tag) ? {
      fontSize: "12px", minHeight: "28px", maxWidth: "100%",
      color: "inherit", backgroundColor: "transparent",
      ...(tag === "button" ? { whiteSpace: "normal", flexShrink: "0" } : {}),
    } : {}),
  }, styles);
  if (tag === "button") el.setAttribute("type", "button");
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

// 兼容 Zotero 10 的剪贴板写入函数
async function copyToClipboard(doc, text) {
  try {
    if (doc?.defaultView?.navigator?.clipboard?.writeText) {
      await doc.defaultView.navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const clipboard = Components.classes[
      "@mozilla.org/widget/clipboardhelper;1"
    ].getService(Components.interfaces.nsIClipboardHelper);
    clipboard.copyString(text);
    return true;
  } catch (e) {
    Zotero.debug("[VocabBook] 复制失败: " + e);
    return false;
  }
}

// 纯 JS UTF-8 MD5 实现（无需旧版 XPCOM 组件，100% 兼容 Zotero 10）
function md5(str) {
  const bytes = new TextEncoder().encode(str);
  function rotl(x, n) {
    return (x << n) | (x >>> (32 - n));
  }
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 8) >>> 6) * 64 + 64;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  for (let offset = 0; offset < padLen; offset += 64) {
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const M = view.getUint32(offset + g * 4, true);
      const temp = D;
      D = C;
      C = B;
      B = (B + rotl((A + F + K[i] + M) >>> 0, S[i])) >>> 0;
      A = temp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out, (b) => ("0" + b.toString(16)).slice(-2)).join("");
}

// 播放英文发音
function playAudio(doc, word) {
  try {
    const WinAudio = doc.defaultView?.Audio || Audio;
    const audio = new WinAudio(
      "https://dict.youdao.com/dictvoice?type=2&audio=" +
        encodeURIComponent(word.trim())
    );
    audio.play().catch((e) => Zotero.debug("[VocabBook] 语音播放失败: " + e));
  } catch (e) {
    Zotero.debug("[VocabBook] 语音播放失败: " + e);
  }
}

// ==========================================
// 2. 百度翻译 API 与词典音标双引擎接口
// ==========================================
function getBaiduCredentials() {
  const raw = String(Zotero.Prefs.get(PREF_BAIDU_KEY, true) || "");
  const [appid, secret] = raw.trim().split("#");
  return { appid: (appid || "").trim(), secret: (secret || "").trim(), raw };
}

async function translateWithBaidu(queryText) {
  const q = (queryText || "").replace(/\s+/g, " ").trim();
  if (!q) return { ok: false, text: "" };

  const { appid, secret } = getBaiduCredentials();
  if (!appid || !secret) {
    return { ok: false, text: "未配置百度 API 密钥 (格式: APPID#密钥)" };
  }

  const salt = Date.now().toString();
  const sign = md5(appid + q + salt + secret);
  const url =
    `https://fanyi-api.baidu.com/api/trans/vip/translate?q=${encodeURIComponent(
      q
    )}` +
    `&from=auto&to=zh&appid=${encodeURIComponent(appid)}&salt=${salt}&sign=${sign}`;

  try {
    const data = await requestJSON(url);
    if (data.error_code) {
      return {
        ok: false,
        text: `百度API报错 (${data.error_code}): ${data.error_msg || "请检查密钥或额度"}`,
      };
    }
    if (data.trans_result && data.trans_result.length > 0) {
      const dst = data.trans_result.map((r) => r.dst).join("\n");
      return { ok: true, text: dst };
    }
  } catch (e) {
    return { ok: false, text: "网络请求失败: " + e.message };
  }
  return { ok: false, text: "暂无翻译结果" };
}

async function requestJSON(url) {
  // Zotero supplies a timeout-capable HTTP client in bootstrap scopes.
  const response = await Zotero.HTTP.request("GET", url, {
    responseType: "json", timeout: 15000,
  });
  return response.response;
}

async function fetchWordRichInfo(word) {
  const clean = (word || "").trim();
  let phonetic = "";
  let dictExplain = "";

  const [baiduRes, dictRes] = await Promise.allSettled([
    translateWithBaidu(clean),
    requestJSON(
      `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(
        clean
      )}&dicts={"count":1,"dicts":[["ec"]]}`
    ),
  ]);

  if (dictRes.status === "fulfilled" && dictRes.value) {
    try {
      const wordObj = dictRes.value?.ec?.word?.[0];
      if (wordObj) {
        const us = wordObj.usphone ? `/${wordObj.usphone}/` : "";
        const uk = wordObj.ukphone ? `/${wordObj.ukphone}/` : "";
        phonetic = us || uk;
        if (Array.isArray(wordObj.trs)) {
          dictExplain = wordObj.trs
            .map((t) => t?.tr?.[0]?.l?.i?.[0] || "")
            .filter(Boolean)
            .slice(0, 3)
            .join("；");
        }
      }
    } catch (e) {}
  }

  const baiduText =
    baiduRes.status === "fulfilled" && baiduRes.value.ok
      ? baiduRes.value.text
      : "";

  let combinedMeaning = "";
  if (baiduText && dictExplain) {
    combinedMeaning = `【百度】${baiduText} | ${dictExplain}`;
  } else {
    combinedMeaning = baiduText || dictExplain || "暂无释义";
  }

  return { phonetic, baiduText, dictExplain, combinedMeaning };
}

// ==========================================
// 3. 本地生词库数据管理 (CRUD + 熟练度 + 页码定位)
// ==========================================
function getVocabList() {
  const raw = Zotero.Prefs.get(PREF_WORDS, true);
  const list = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(list) || list.some(w => !w || typeof w.word !== "string")) {
    throw new Error("生词数据格式异常，请先备份 extensions.vocabbook.words；原数据未被覆盖。");
  }
  return list;
}

function saveVocabList(list) {
  Zotero.Prefs.set(PREF_WORDS, JSON.stringify(list), true);
  refreshAllSidebars();
}

function addOrUpdateWord({
  word,
  phonetic = "",
  meaning = "",
  contextSentence = "",
  contextTrans = "",
  note = "",
  sourceTitle = "手动添加",
  itemID = null,
  attachmentID = null,
  pageIndex = null,
}) {
  const cleanWord = (word || "").trim();
  if (!cleanWord) return;

  const list = getVocabList();
  const idx = list.findIndex(
    (w) => w.word.toLowerCase() === cleanWord.toLowerCase()
  );

  if (idx >= 0) {
    const old = list[idx];
    list[idx] = {
      ...old,
      phonetic: phonetic || old.phonetic || "",
      meaning: meaning || old.meaning || "暂无释义",
      contextSentence: contextSentence || old.contextSentence || "",
      contextTrans: contextTrans || old.contextTrans || "",
      note: note || old.note || "",
      source: sourceTitle || old.source,
      itemID: itemID ?? old.itemID,
      attachmentID: attachmentID ?? old.attachmentID,
      pageIndex: pageIndex ?? old.pageIndex,
      reviewCount: (old.reviewCount || 0) + 1,
      date: new Date().toISOString().slice(0, 10),
    };
  } else {
    list.unshift({
      word: cleanWord,
      phonetic: phonetic || "",
      meaning: meaning || "暂无释义",
      contextSentence: contextSentence || "",
      contextTrans: contextTrans || "",
      note: note || "",
      source: sourceTitle || "手动添加",
      itemID: itemID || null,
      attachmentID: attachmentID || null,
      pageIndex: pageIndex ?? null,
      mastery: 0,
      reviewCount: 0,
      date: new Date().toISOString().slice(0, 10),
    });
  }
  saveVocabList(list);
}

function updateMastery(word, newMastery, incrementReview = false) {
  const list = getVocabList();
  const target = list.find(
    (w) => w.word.toLowerCase() === word.toLowerCase()
  );
  if (target) {
    target.mastery = newMastery;
    if (incrementReview) {
      target.reviewCount = (target.reviewCount || 0) + 1;
    }
    saveVocabList(list);
  }
}

function removeWord(word) {
  const list = getVocabList().filter(
    (w) => w.word.toLowerCase() !== word.toLowerCase()
  );
  saveVocabList(list);
}

async function jumpToPDFPage(attachmentID, pageIndex) {
  if (!attachmentID) return;
  const page = typeof pageIndex === "number" ? pageIndex : 0;
  try {
    // Zotero.Reader.open(itemID, location, options): location is an object
    // ({ pageIndex, annotationID, ... }), not a bare number.
    const reader = await Zotero.Reader.open(attachmentID, { pageIndex: page }, {
      openInWindow: false,
    });
    if (reader && typeof reader.navigate === "function") {
      reader.navigate({ pageIndex: page });
    }
  } catch (e) {
    Zotero.debug("[VocabBook] 跳转 PDF 失败: " + e);
  }
}

// ==========================================
// 4. 右侧边栏 UI 渲染
// ==========================================
function refreshAllSidebars() {
  for (const state of activeSidebarContainers) {
    if (state.body && state.body.isConnected) {
      renderSidebarContent(state);
    } else {
      activeSidebarContainers.delete(state);
    }
  }
}

function renderSidebarContent(state) {
  try {
    renderSidebarView(state);
    ensureSectionBodyVisible(state.body);
  } catch (error) {
    Zotero.debug("[VocabBook] 侧栏渲染失败: " + error);
    const message = createHTML(state.body.ownerDocument, "div", { padding: "12px" }, { role: "alert" });
    message.textContent = "生词本暂时无法显示：" + error.message;
    state.body.replaceChildren(message);
  }
}

function escapeExportHTML(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function renderSidebarView(state) {
  const { body, item } = state;
  const doc = body.ownerDocument;
  body.innerHTML = "";
  Object.assign(body.style, { minWidth: "0", maxWidth: "100%", boxSizing: "border-box" });
  const section = body.closest("collapsible-section");
  // A label fallback also covers live upgrades while Zotero refreshes Fluent.
  if (section && !section.getAttribute("label")) {
    section.setAttribute("label", String(Zotero.locale || "zh-CN").startsWith("zh") ? "生词本" : "Vocab Book");
  }

  const wrapper = createHTML(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "10px 12px",
    fontSize: "12px",
    boxSizing: "border-box",
    width: "auto",
    maxWidth: "100%",
  });

  let currentPaperID = null;
  let currentPaperTitle = "";
  let currentAttachmentID = null;
  if (item) {
    if (item.isAttachment && item.isAttachment()) {
      currentAttachmentID = item.id;
    }
    const topItem = item.isRegularItem()
      ? item
      : item.parentItemID
      ? Zotero.Items.get(item.parentItemID)
      : item;
    if (topItem) {
      currentPaperID = topItem.id;
      currentPaperTitle = topItem.getField("title") || "";
    }
  }

  const navBar = createHTML(doc, "div", {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 100px), 1fr))",
    gap: "4px",
    justifyContent: "space-between",
    alignItems: "center",
  });

  const btnStyle = {
    padding: "3px 7px",
    cursor: "pointer",
    borderRadius: "4px",
    border: "1px solid rgba(128,128,128,0.4)",
    fontSize: "11px",
  };

  const levelLabels = {
    "-1": "📚 全部等级",
    0: "🔴 仅生疏",
    1: "🟡 仅熟悉",
    2: "🟢 已掌握",
  };
  const cycleMasteryFilter = () => {
    const order = [-1, 0, 1, 2];
    state.masteryFilter =
      order[(order.indexOf(state.masteryFilter) + 1) % order.length];
    state.flashcardIndex = 0;
    renderSidebarContent(state);
  };

  const scopeBtn = createHTML(doc, "button", btnStyle);
  scopeBtn.textContent = state.onlyCurrentPaper ? "📖 当前文献" : "📚 全部生词";
  scopeBtn.addEventListener("click", () => {
    state.onlyCurrentPaper = !state.onlyCurrentPaper;
    state.flashcardIndex = 0;
    renderSidebarContent(state);
  });

  const modeBtn = createHTML(doc, "button", {
    ...btnStyle,
    backgroundColor: state.viewMode === "flashcard" ? "#6f42c1" : "",
    color: state.viewMode === "flashcard" ? "#fff" : "",
  });
  modeBtn.textContent =
    state.viewMode === "flashcard" ? "🎴 退出闪卡" : "🎴 闪卡背词";
  modeBtn.addEventListener("click", () => {
    state.viewMode = state.viewMode === "flashcard" ? "list" : "flashcard";
    state.flashcardFlipped = false;
    renderSidebarContent(state);
  });

  const exportBtn = createHTML(doc, "button", btnStyle);
  exportBtn.textContent = "📤 导出 Anki";
  exportBtn.addEventListener("click", async () => {
    const list = getVocabList();
    if (!list.length) return;
    const lines = list.map((w) => {
      const front = escapeExportHTML(w.phonetic ? `${w.word} ${w.phonetic}` : w.word).replace(/[\t\r\n]/g, " ");
      const ctx = w.contextSentence
        ? `<br><i>例: ${escapeExportHTML(w.contextSentence)}</i> (${escapeExportHTML(w.contextTrans)})`
        : "";
      const back = `${escapeExportHTML(w.meaning)}${ctx}<br><small>来源: ${escapeExportHTML(w.source)}</small>`;
      return `${front}\t${back.replace(/\t|\n/g, " ")}`;
    });
    const copied = await copyToClipboard(doc, lines.join("\n"));
    exportBtn.textContent = copied ? "✅ 已复制Anki格式" : "复制失败，请重试";
    setTimeout(() => {
      exportBtn.textContent = "📤 导出 Anki";
    }, 1500);
  });

  const settingBtn = createHTML(doc, "button", btnStyle);
  settingBtn.textContent = "⚙️";
  settingBtn.title = "配置百度翻译 API 密钥";
  settingBtn.addEventListener("click", () => {
    state.showSettings = !state.showSettings;
    renderSidebarContent(state);
  });

  const helpBtn = createHTML(doc, "button", btnStyle);
  helpBtn.textContent = "❓";
  helpBtn.title = "使用说明 / 怎么复习";
  helpBtn.addEventListener("click", () => {
    state.showHelp = !state.showHelp;
    renderSidebarContent(state);
  });

  navBar.appendChild(scopeBtn);
  navBar.appendChild(modeBtn);
  navBar.appendChild(exportBtn);
  navBar.appendChild(settingBtn);
  navBar.appendChild(helpBtn);
  wrapper.appendChild(navBar);

  if (state.showSettings) {
    const settingBox = createHTML(doc, "div", {
      padding: "8px",
      borderRadius: "6px",
      border: "1px dashed #0066cc",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      backgroundColor: "rgba(0,102,204,0.05)",
    });

    const label = createHTML(doc, "div", {
      fontSize: "11px",
      fontWeight: "bold",
    });
    label.textContent = "🔑 百度翻译 API 密钥 (格式: APPID#密钥)";

    const keyInput = createHTML(
      doc,
      "input",
      {
        padding: "4px",
        borderRadius: "4px",
        border: "1px solid #ccc",
        fontSize: "11px",
      },
      { type: "password", autocomplete: "off", value: getBaiduCredentials().raw }
    );

    const saveKeyBtn = createHTML(doc, "button", {
      ...btnStyle,
      backgroundColor: "#0066cc",
      color: "#fff",
    });
    saveKeyBtn.textContent = "保存并测试百度 API";
    saveKeyBtn.addEventListener("click", async () => {
      Zotero.Prefs.set(PREF_BAIDU_KEY, keyInput.value.trim(), true);
      saveKeyBtn.textContent = "⏳ 正在测试连接...";
      const testRes = await translateWithBaidu("deep learning");
      saveKeyBtn.textContent = testRes.ok
        ? `✅ 测试成功: "${testRes.text}"`
        : `❌ 失败: ${testRes.text}`;
    });

    settingBox.appendChild(label);
    settingBox.appendChild(keyInput);
    settingBox.appendChild(saveKeyBtn);
    wrapper.appendChild(settingBox);
  }

  if (state.showHelp) {
    const helpBox = createHTML(doc, "div", {
      padding: "8px 9px",
      borderRadius: "6px",
      border: "1px dashed #28a745",
      backgroundColor: "rgba(40,167,69,0.06)",
      fontSize: "11px",
      lineHeight: "1.6",
      whiteSpace: "pre-line",
    });
    helpBox.textContent = [
      "📖 收录生词（划词）",
      "1. 在主窗口双击文献的 PDF，用鼠标划选单词或整句",
      "2. 在浮窗里点「➕ 加入生词本」（可先填例句）",
      "3. 短词 = 词典音标 + 翻译，长句 = 整句翻译并可提词入库",
      "",
      "🎴 复习（闪卡背词）",
      "1. 在主窗口选中文献，右侧栏「生词本」里点「🎴 闪卡背词」",
      "2. 看单词和例句先回忆，点「👀 点击显示释义与译文」翻面",
      "3. 按 🔴生疏 / 🟡模糊 / 🟢掌握 打分，自动跳下一个",
      "4. 用等级按钮只刷某一档，例如「🔴 仅生疏」反复巩固",
      "",
      "💡 其他",
      "· 顶部输入框可手动查词入库（不用打开 PDF）",
      "· 「📚 全部生词/📖 当前文献」切换范围，「🔍」搜索，「🕒最新/🔥生疏优先/🔤A-Z」排序",
      "· 「📤 导出 Anki」把全部生词按 正面(TAB)背面 复制到剪贴板，可直接粘进 Anki",
      "· 卡片上的 🔴🟡🟢 徽章点一下改熟练度，「✖」删除",
      "· 带「📍 P.x 跳转」的词条可回到 PDF 对应页",
    ].join("\n");
    wrapper.appendChild(helpBox);
  }

  const allWords = getVocabList();
  let filtered = state.onlyCurrentPaper
    ? allWords.filter((w) => w.itemID === currentPaperID)
    : allWords;

  if (state.masteryFilter !== -1) {
    filtered = filtered.filter((w) => (w.mastery || 0) === state.masteryFilter);
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(
      (w) =>
        w.word.toLowerCase().includes(q) ||
        (w.meaning && w.meaning.toLowerCase().includes(q)) ||
        (w.contextSentence && w.contextSentence.toLowerCase().includes(q))
    );
  }

  if (state.sortBy === "alpha") {
    filtered.sort((a, b) => a.word.localeCompare(b.word));
  } else if (state.sortBy === "mastery") {
    filtered.sort((a, b) => (a.mastery || 0) - (b.mastery || 0));
  }

  // 闪卡模式
  if (state.viewMode === "flashcard") {
    const deckRow = createHTML(doc, "div", {
      display: "flex",
      gap: "4px",
      alignItems: "center",
      justifyContent: "space-between",
    });
    const deckFilterBtn = createHTML(doc, "button", btnStyle);
    deckFilterBtn.title = "只复习某一档熟练度：全部 → 生疏 → 熟悉 → 已掌握";
    deckFilterBtn.textContent = levelLabels[String(state.masteryFilter)];
    deckFilterBtn.addEventListener("click", cycleMasteryFilter);
    const deckHint = createHTML(doc, "span", {
      fontSize: "10px",
      color: "#888",
    });
    deckHint.textContent = "选择复习范围";
    deckRow.appendChild(deckFilterBtn);
    deckRow.appendChild(deckHint);
    wrapper.appendChild(deckRow);

    const cardBox = createHTML(doc, "div", {
      padding: "14px 10px",
      borderRadius: "8px",
      border: "2px solid #6f42c1",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "10px",
      textAlign: "center",
      minHeight: "180px",
      justifyContent: "center",
    });

    if (filtered.length === 0) {
      const empty = createHTML(doc, "div", { color: "#888" });
      empty.textContent = "当前筛选条件下没有可复习的生词";
      cardBox.appendChild(empty);
    } else {
      if (state.flashcardIndex >= filtered.length) {
        state.flashcardIndex = 0;
      }
      const cur = filtered[state.flashcardIndex];

      const progress = createHTML(doc, "div", {
        fontSize: "11px",
        color: "#888",
      });
      progress.textContent = `复习进度: ${state.flashcardIndex + 1} / ${
        filtered.length
      } (已复习 ${cur.reviewCount || 0} 次)`;

      const wordBig = createHTML(doc, "div", {
        fontSize: "18px",
        fontWeight: "bold",
        color: "#d9534f",
        cursor: "pointer",
      });
      wordBig.textContent = `${cur.word} 🔊`;
      wordBig.addEventListener("click", () => playAudio(doc, cur.word));

      const phoneEl = createHTML(doc, "div", {
        fontSize: "12px",
        color: "#666",
      });
      phoneEl.textContent = cur.phonetic || "";

      cardBox.appendChild(progress);
      cardBox.appendChild(wordBig);
      if (cur.phonetic) cardBox.appendChild(phoneEl);

      if (cur.contextSentence) {
        const ctxEl = createHTML(doc, "div", {
          fontSize: "11px",
          fontStyle: "italic",
          color: "#555",
          padding: "4px 6px",
          backgroundColor: "rgba(128,128,128,0.1)",
          borderRadius: "4px",
        });
        ctxEl.textContent = `"${cur.contextSentence}"`;
        cardBox.appendChild(ctxEl);
      }

      if (!state.flashcardFlipped) {
        const showAnsBtn = createHTML(doc, "button", {
          ...btnStyle,
          marginTop: "8px",
          padding: "5px 14px",
          backgroundColor: "#6f42c1",
          color: "#fff",
        });
        showAnsBtn.textContent = "👀 点击显示释义与译文";
        showAnsBtn.addEventListener("click", () => {
          state.flashcardFlipped = true;
          renderSidebarContent(state);
        });
        cardBox.appendChild(showAnsBtn);
      } else {
        const ansBox = createHTML(doc, "div", {
          padding: "6px",
          borderTop: "1px solid rgba(128,128,128,0.25)",
          width: "100%",
        });
        const meanEl = createHTML(doc, "div", {
          fontSize: "13px",
          fontWeight: "bold",
          marginBottom: "4px",
        });
        meanEl.textContent = cur.meaning;
        ansBox.appendChild(meanEl);

        if (cur.contextTrans) {
          const transEl = createHTML(doc, "div", {
            fontSize: "11px",
            color: "#666",
          });
          transEl.textContent = `译: ${cur.contextTrans}`;
          ansBox.appendChild(transEl);
        }
        cardBox.appendChild(ansBox);

        const rateRow = createHTML(doc, "div", {
          display: "flex",
          gap: "6px",
          marginTop: "6px",
        });

        const rateOptions = [
          { label: "🔴 生疏", level: 0, color: "#d9534f" },
          { label: "🟡 模糊", level: 1, color: "#f0ad4e" },
          { label: "🟢 掌握", level: 2, color: "#28a745" },
        ];

        for (const opt of rateOptions) {
          const b = createHTML(doc, "button", {
            ...btnStyle,
            backgroundColor: opt.color,
            color: "#fff",
            border: "none",
          });
          b.textContent = opt.label;
          b.addEventListener("click", () => {
            state.flashcardFlipped = false;
            // If this card leaves the filtered deck, the next card takes its index.
            state.flashcardIndex =
              state.masteryFilter !== -1 && state.masteryFilter !== opt.level
                ? state.flashcardIndex % Math.max(1, filtered.length - 1)
                : (state.flashcardIndex + 1) % Math.max(1, filtered.length);
            updateMastery(cur.word, opt.level, true);
          });
          rateRow.appendChild(b);
        }
        cardBox.appendChild(rateRow);
      }
    }
    wrapper.appendChild(cardBox);
    body.appendChild(wrapper);
    return;
  }

  // 列表模式
  const addRow = createHTML(doc, "div", { display: "flex", flexWrap: "wrap", gap: "4px" });
  const wordInput = createHTML(
    doc,
    "input",
    {
      flex: "1 1 120px",
      padding: "4px",
      borderRadius: "4px",
      border: "1px solid #ccc",
      fontSize: "11px",
    },
    { type: "text", placeholder: "输入生词或短语(百度翻译)..." }
  );
  const addBtn = createHTML(doc, "button", {
    ...btnStyle,
    backgroundColor: "#0066cc",
    color: "#fff",
  });
  addBtn.textContent = "➕ 查词入库";

  addBtn.addEventListener("click", async () => {
    const w = wordInput.value.trim();
    if (!w) {
      wordInput.focus();
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = "⏳ 查询中...";
    try {
      const info = await fetchWordRichInfo(w);
      addOrUpdateWord({
        word: w,
        phonetic: info.phonetic,
        meaning: info.combinedMeaning,
        sourceTitle: currentPaperTitle || "手动添加",
        itemID: currentPaperID,
        attachmentID: currentAttachmentID,
      });
      wordInput.value = "";
      addBtn.textContent = "✅ 已入库";
      setTimeout(() => {
        addBtn.textContent = "➕ 查词入库";
      }, 1200);
    } catch (e) {
      addBtn.textContent = "❌ 失败，重试";
      Zotero.debug("[VocabBook] 查词入库失败: " + e);
    } finally {
      addBtn.disabled = false;
    }
  });

  addRow.appendChild(wordInput);
  addRow.appendChild(addBtn);
  wrapper.appendChild(addRow);

  wordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addBtn.click();
    }
  });

  const filterRow = createHTML(doc, "div", {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    alignItems: "center",
  });

  const searchInput = createHTML(
    doc,
    "input",
    {
      flex: "1 1 120px",
      padding: "3px 6px",
      borderRadius: "4px",
      border: "1px solid #ccc",
      fontSize: "11px",
    },
    {
      type: "text",
      placeholder: "🔍 搜索单词/释义/例句...",
      value: state.searchQuery || "",
    }
  );
  searchInput.addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderSidebarContent(state);
    const newInput = body.querySelector('input[placeholder^="🔍"]');
    if (newInput) {
      newInput.focus();
      newInput.setSelectionRange(
        newInput.value.length,
        newInput.value.length
      );
    }
  });

  const levelBtn = createHTML(doc, "button", btnStyle);
  levelBtn.title = "切换显示的熟练度：全部 → 生疏 → 熟悉 → 已掌握";
  levelBtn.textContent = levelLabels[String(state.masteryFilter)];
  levelBtn.addEventListener("click", cycleMasteryFilter);

  const sortBtn = createHTML(doc, "button", btnStyle);
  const sortLabels = {
    date: "🕒最新",
    mastery: "🔥生疏优先",
    alpha: "🔤A-Z",
  };
  sortBtn.textContent = sortLabels[state.sortBy] || "🕒最新";
  sortBtn.addEventListener("click", () => {
    const order = ["date", "mastery", "alpha"];
    state.sortBy = order[(order.indexOf(state.sortBy) + 1) % order.length];
    renderSidebarContent(state);
  });

  filterRow.appendChild(searchInput);
  filterRow.appendChild(levelBtn);
  filterRow.appendChild(sortBtn);
  wrapper.appendChild(filterRow);

  const statBar = createHTML(doc, "div", {
    fontSize: "11px",
    color: "#666",
    display: "flex",
    justifyContent: "space-between",
  });
  const c0 = allWords.filter((w) => (w.mastery || 0) === 0).length;
  const c1 = allWords.filter((w) => w.mastery === 1).length;
  const c2 = allWords.filter((w) => w.mastery === 2).length;
  statBar.textContent = `显示 ${filtered.length} 词 | 🔴${c0}  🟡${c1}  🟢${c2}`;
  wrapper.appendChild(statBar);

  const listContainer = createHTML(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: "420px",
    overflowY: "auto",
  });

  const masteryBadges = [
    { text: "🔴 生疏", color: "#d9534f" },
    { text: "🟡 熟悉", color: "#f0ad4e" },
    { text: "🟢 掌握", color: "#28a745" },
  ];

  if (filtered.length === 0) {
    const emptyTip = createHTML(doc, "div", {
      color: "#777",
      padding: "12px 8px",
      textAlign: "left",
      lineHeight: "1.7",
      whiteSpace: "pre-line",
      border: "1px dashed rgba(128,128,128,0.45)",
      borderRadius: "6px",
      backgroundColor: "rgba(128,128,128,0.06)",
    });
    emptyTip.textContent = allWords.length
      ? "当前筛选/搜索条件下没有生词。\n点「📚 全部等级」或清空搜索框即可看到全部生词。"
      : [
          "📖 还没有生词，四步开始：",
          "1️⃣ 在主窗口双击文献的 PDF 打开阅读器",
          "2️⃣ 用鼠标划选单词（≤4 词）或整句",
          "3️⃣ 在浮窗里点「➕ 加入生词本」",
          "4️⃣ 回主窗口选中该文献 → 右侧栏「生词本」",
          "",
          "🎴 复习：点上面的「🎴 闪卡背词」，翻面后按 🔴🟡🟢 打分",
          "❓ 详细说明点右上角「❓」；本框也可直接输入单词回车入库",
        ].join("\n");
    listContainer.appendChild(emptyTip);
  } else {
    for (const itemObj of filtered) {
      const card = createHTML(doc, "div", {
        padding: "7px 8px",
        borderRadius: "6px",
        border: "1px solid rgba(128,128,128,0.28)",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      });

      const row1 = createHTML(doc, "div", {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        justifyContent: "space-between",
        alignItems: "center",
      });

      const leftGroup = createHTML(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "5px",
        flexWrap: "wrap",
      });

      const wordTitle = createHTML(doc, "strong", {
        fontSize: "13px",
        color: "#d9534f",
        cursor: "pointer",
      });
      wordTitle.textContent = itemObj.word;
      wordTitle.title = "点击朗读发音";
      wordTitle.addEventListener("click", () => playAudio(doc, itemObj.word));

      const audioIcon = createHTML(doc, "span", {
        cursor: "pointer",
        fontSize: "11px",
        color: "#555",
      });
      audioIcon.textContent = itemObj.phonetic
        ? `${itemObj.phonetic} 🔊`
        : "🔊";
      audioIcon.addEventListener("click", () => playAudio(doc, itemObj.word));

      leftGroup.appendChild(wordTitle);
      leftGroup.appendChild(audioIcon);

      const rightGroup = createHTML(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexShrink: "0",
      });

      const mLevel = [0, 1, 2].includes(itemObj.mastery) ? itemObj.mastery : 0;
      const badge = createHTML(doc, "span", {
        fontSize: "10px",
        padding: "1px 5px",
        borderRadius: "3px",
        cursor: "pointer",
        border: `1px solid ${masteryBadges[mLevel].color}`,
        color: masteryBadges[mLevel].color,
      });
      badge.textContent = masteryBadges[mLevel].text;
      badge.title = "点击切换熟练度";
      badge.addEventListener("click", () => {
        updateMastery(itemObj.word, (mLevel + 1) % 3, false);
      });

      const delBtn = createHTML(doc, "span", {
        cursor: "pointer",
        color: "#999",
        fontSize: "11px",
      });
      delBtn.textContent = "✖";
      delBtn.title = "删除该生词";
      delBtn.addEventListener("click", () => removeWord(itemObj.word));

      rightGroup.appendChild(badge);
      rightGroup.appendChild(delBtn);

      row1.appendChild(leftGroup);
      row1.appendChild(rightGroup);
      card.appendChild(row1);

      const meanText = createHTML(doc, "div", {
        fontSize: "12px",
        lineHeight: "1.4",
      });
      meanText.textContent = itemObj.meaning;
      card.appendChild(meanText);

      if (itemObj.contextSentence) {
        const ctxBox = createHTML(doc, "div", {
          fontSize: "11px",
          color: "#555",
          padding: "4px 6px",
          borderLeft: "2px solid #0066cc",
          backgroundColor: "rgba(128,128,128,0.08)",
          lineHeight: "1.35",
        });
        ctxBox.textContent = itemObj.contextTrans
          ? `例: "${itemObj.contextSentence}" (${itemObj.contextTrans})`
          : `例: "${itemObj.contextSentence}"`;
        card.appendChild(ctxBox);
      }

      const metaRow = createHTML(doc, "div", {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px",
        justifyContent: "space-between",
        alignItems: "center",
        fontSize: "10px",
        color: "#888",
      });

      const srcSpan = createHTML(doc, "span", {
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "190px",
      });
      srcSpan.textContent = `📄 ${itemObj.source} (${itemObj.date})`;
      metaRow.appendChild(srcSpan);

      if (itemObj.attachmentID) {
        const jumpBtn = createHTML(doc, "span", {
          cursor: "pointer",
          color: "#0066cc",
          fontWeight: "bold",
          flexShrink: "0",
        });
        const pageNum =
          typeof itemObj.pageIndex === "number" ? itemObj.pageIndex + 1 : 1;
        jumpBtn.textContent = `📍 P.${pageNum} 跳转`;
        jumpBtn.title = "打开对应 PDF 并跳转到该词所在页码";
        jumpBtn.addEventListener("click", () =>
          jumpToPDFPage(itemObj.attachmentID, itemObj.pageIndex)
        );
        metaRow.appendChild(jumpBtn);
      }

      card.appendChild(metaRow);
      listContainer.appendChild(card);
    }
  }

  wrapper.appendChild(listContainer);
  body.appendChild(wrapper);
}

function ensureSectionBodyVisible(body) {
  try {
    const root = body && body.getRootNode ? body.getRootNode() : null;
    const section =
      (root && root.host) ||
      (body && body.closest ? body.closest("collapsible-section") : null);
    if (section && section.hasAttribute("open") && section.style) {
      section.style.setProperty("--open-height", "auto");
    }
  } catch (e) {}
}

// ==========================================
// 5. 插件生命周期与 PDF 划词双模式弹窗
// ==========================================
function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  getBaiduCredentials();

  for (let win of Zotero.getMainWindows()) {
    if (win.MozXULElement) {
      win.MozXULElement.insertFTLIfNeeded("vocab-book-ui.ftl");
    }
  }

  const bookIcon =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
    );

  registeredSectionID = Zotero.ItemPaneManager.registerSection({
    paneID: "zotero-vocab-book-pane",
    pluginID: PLUGIN_ID,
    header: {
      l10nID: "vocab-book-section-header",
      icon: bookIcon,
    },
    sidenav: {
      l10nID: "vocab-book-section-sidenav",
      icon: bookIcon,
    },
    onItemChange: ({ item, setEnabled }) => setEnabled(!!item),
    onDestroy: ({ body }) => {
      for (const state of activeSidebarContainers) {
        if (state.body === body) activeSidebarContainers.delete(state);
      }
    },
    onRender: ({ body, item }) => {
      let state = Array.from(activeSidebarContainers).find(
        (s) => s.body === body
      );
      if (!state) {
        state = {
          body,
          item,
          onlyCurrentPaper: false,
          viewMode: "list",
          masteryFilter: -1,
          sortBy: "date",
          searchQuery: "",
          showSettings: false,
          showHelp: false,
          flashcardIndex: 0,
          flashcardFlipped: false,
        };
        activeSidebarContainers.add(state);
      } else {
        state.item = item;
      }
      renderSidebarContent(state);
      ensureSectionBodyVisible(body);
    },
  });

  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    async (event) => {
      const { reader, doc, params, append } = event;
      const selectedText = (params?.annotation?.text || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!selectedText || selectedText.length > 800) return;

      let paperTitle = "PDF 文献";
      let parentID = null;
      const attachmentID = reader.itemID || null;
      const pageIndex = params?.annotation?.position?.pageIndex ?? 0;

      try {
        const attItem = Zotero.Items.get(attachmentID);
        const parentItem =
          attItem && attItem.parentItemID
            ? Zotero.Items.get(attItem.parentItemID)
            : attItem;
        if (parentItem) {
          parentID = parentItem.id;
          paperTitle = parentItem.getField("title") || "PDF 文献";
        }
      } catch (e) {}

      const wordCount = selectedText.split(/\s+/).length;
      const isSingleOrShortPhrase =
        wordCount <= 4 && selectedText.length <= 40;

      const box = createHTML(doc, "div", {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px 12px",
        borderTop: "1px solid rgba(128,128,128,0.25)",
        marginTop: "4px",
        fontSize: "12px",
        maxWidth: "300px",
      });

      if (isSingleOrShortPhrase) {
        const headerRow = createHTML(doc, "div", {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        });

        const titleSpan = createHTML(doc, "strong", {
          color: "#d9534f",
          cursor: "pointer",
        });
        titleSpan.textContent = `${selectedText} 🔊`;
        titleSpan.addEventListener("click", () =>
          playAudio(doc, selectedText)
        );

        const pageTag = createHTML(doc, "span", {
          fontSize: "10px",
          color: "#888",
        });
        pageTag.textContent = `P.${pageIndex + 1}`;

        headerRow.appendChild(titleSpan);
        headerRow.appendChild(pageTag);
        box.appendChild(headerRow);

        const defText = createHTML(doc, "div", {
          color: "#444",
          fontSize: "11px",
          lineHeight: "1.35",
        });
        defText.textContent = "🔍 百度翻译与词典查询中...";
        box.appendChild(defText);

        const ctxInput = createHTML(
          doc,
          "input",
          {
            padding: "3px 6px",
            borderRadius: "4px",
            border: "1px solid #ccc",
            fontSize: "11px",
          },
          { type: "text", placeholder: "可选：添加原句例句或笔记..." }
        );
        box.appendChild(ctxInput);

        const saveBtn = createHTML(doc, "button", {
          padding: "4px 8px",
          cursor: "pointer",
          borderRadius: "4px",
          border: "none",
          backgroundColor: "#28a745",
          color: "#fff",
          fontWeight: "bold",
          fontSize: "11px",
        });
        saveBtn.textContent = "➕ 加入生词本";
        box.appendChild(saveBtn);
        append(box);

        let info = { phonetic: "", combinedMeaning: "待查询释义" };
        saveBtn.addEventListener("click", () => {
          addOrUpdateWord({
            word: selectedText,
            phonetic: info.phonetic,
            meaning: info.combinedMeaning,
            contextSentence: ctxInput.value.trim(),
            sourceTitle: paperTitle,
            itemID: parentID,
            attachmentID,
            pageIndex,
          });
          saveBtn.textContent = "✅ 已收入生词本 (含页码定位)";
          saveBtn.style.backgroundColor = "#6c757d";
        });
        info = await fetchWordRichInfo(selectedText);
        if (info.phonetic) titleSpan.textContent = `${selectedText} ${info.phonetic} 🔊`;
        defText.textContent = info.combinedMeaning;
      } else {
        const titleRow = createHTML(doc, "div", {
          fontSize: "11px",
          fontWeight: "bold",
          color: "#0066cc",
        });
        titleRow.textContent = `🌐 百度学术长句翻译 (P.${pageIndex + 1})`;
        box.appendChild(titleRow);

        const transBox = createHTML(doc, "div", {
          fontSize: "11px",
          lineHeight: "1.4",
          color: "#333",
          maxHeight: "110px",
          overflowY: "auto",
          padding: "4px",
          backgroundColor: "rgba(0,102,204,0.06)",
          borderRadius: "4px",
        });
        transBox.textContent = "⏳ 正在请求百度翻译 API...";
        box.appendChild(transBox);

        const extractRow = createHTML(doc, "div", {
          display: "flex",
          gap: "4px",
          marginTop: "2px",
        });
        const pickInput = createHTML(
          doc,
          "input",
          {
            flex: "1 1 120px",
            padding: "3px 5px",
            borderRadius: "4px",
            border: "1px solid #ccc",
            fontSize: "11px",
          },
          { type: "text", placeholder: "输入此句中的生词..." }
        );
        const pickBtn = createHTML(doc, "button", {
          padding: "3px 7px",
          cursor: "pointer",
          borderRadius: "4px",
          border: "none",
          backgroundColor: "#28a745",
          color: "#fff",
          fontSize: "11px",
        });
        pickBtn.textContent = "➕连同原句入库";

        extractRow.appendChild(pickInput);
        extractRow.appendChild(pickBtn);
        box.appendChild(extractRow);
        append(box);

        let baiduRes = { ok: false, text: "" };

        pickBtn.addEventListener("click", async () => {
          const targetWord = pickInput.value.trim();
          if (!targetWord || pickBtn.disabled) return;
          pickBtn.disabled = true;
          pickBtn.textContent = "入库中...";
          const wordInfo = await fetchWordRichInfo(targetWord);
          addOrUpdateWord({
            word: targetWord,
            phonetic: wordInfo.phonetic,
            meaning: wordInfo.combinedMeaning,
            contextSentence: selectedText,
            contextTrans: baiduRes.ok ? baiduRes.text : "",
            sourceTitle: paperTitle,
            itemID: parentID,
            attachmentID,
            pageIndex,
          });
          pickBtn.disabled = false;
          pickBtn.textContent = "✅ 已绑原句入库";
          pickInput.value = "";
          setTimeout(() => {
            pickBtn.textContent = "➕连同原句入库";
          }, 1500);
        });
        baiduRes = await translateWithBaidu(selectedText);
        transBox.textContent = baiduRes.text;
      }
    },
    PLUGIN_ID
  );
}

function onMainWindowLoad({ window }) {
  if (window.MozXULElement) {
    window.MozXULElement.insertFTLIfNeeded("vocab-book-ui.ftl");
  }
}

function onMainWindowUnload({ window }) {
  window.document.querySelector('[href="vocab-book-ui.ftl"]')?.remove();
}

function shutdown() {
  if (registeredSectionID) {
    Zotero.ItemPaneManager.unregisterSection(registeredSectionID);
    registeredSectionID = null;
  }
  activeSidebarContainers.clear();
}
