var registeredSectionID = null;
var registeredPreferencesID = null;
var readingDashboard = null;
var activeSidebarContainers = new Set();

const PLUGIN_ID = "vocab-book@custom.zotero.org";
const PREF_WORDS = "extensions.vocabbook.words";
const PREF_BAIDU_KEY = "extensions.vocabbook.baiduKey";
const PREF_POPUP = "extensions.vocabbook.selectionPopup";
const PREF_DICTIONARY = "extensions.vocabbook.dictionary";
const PREF_AUTO_TRANSLATE = "extensions.vocabbook.autoTranslate";
const PREFERENCES_ID = "vocab-book-preferences";

function isPreferenceEnabled(key) {
  return Zotero.Prefs.get(key, true) !== false;
}

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
      color: "ButtonText", backgroundColor: "ButtonFace",
      ...(tag === "button" ? { appearance: "none", backgroundImage: "none" } : {}),
      ...(tag === "button" ? { whiteSpace: "normal", flexShrink: "0" } : {}),
    } : {}),
    ...(["input", "textarea"].includes(tag) ? { userSelect: "text", MozUserSelect: "text" } : {}),
  }, styles);
  if (tag === "button") {
    el.setAttribute("type", "button");
    // Zotero's native button theme can otherwise override the background alone.
    setButtonColors(el, el.style.backgroundColor || "ButtonFace", el.style.color || "ButtonText");
    el.style.setProperty("appearance", "none", "important");
    el.style.setProperty("background-image", "none", "important");
  }
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function setButtonColors(button, background, color) {
  button.style.setProperty("background-color", background, "important");
  button.style.setProperty("color", color, "important");
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

// The reader document cannot decode remote media reliably. Download through
// Zotero's HTTP client and play a retained blob in the main application window.
var activePronunciation = null;

function stopPronunciation() {
  activePronunciation?.finish("idle");
}

async function playAudio(doc, word, onState = () => {}) {
  stopPronunciation();
  const text = String(word || "").trim();
  if (!text) return false;
  const owner = Zotero.getMainWindow?.() || Zotero.getMainWindows?.()[0] || doc.defaultView;
  const state = { owner, audio: null, objectURL: null, timer: null, resolve: null, finished: false, started: false };
  const notify = (phase, message = "") => {
    try { onState(phase, message); } catch (_) {}
  };
  const playing = () => {
    if (state.finished || state.started) return;
    state.started = true;
    clearTimeout(state.timer);
    notify("playing", "正在播放发音…");
    state.timer = setTimeout(() => state.finish("error", "发音播放超时，点击重试"), 45000);
  };
  const ended = () => state.finish("ended", "播放结束");
  const failed = () => state.finish("error", "发音播放失败，点击重试");
  state.finish = (phase, message = "") => {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.timer);
    if (state.audio) {
      state.audio.removeEventListener("playing", playing);
      state.audio.removeEventListener("ended", ended);
      state.audio.removeEventListener("error", failed);
      try { state.audio.pause(); state.audio.removeAttribute("src"); state.audio.load(); } catch (_) {}
    }
    if (state.objectURL) { try { owner.URL.revokeObjectURL(state.objectURL); } catch (_) {} }
    if (activePronunciation === state) activePronunciation = null;
    notify(phase, message);
    state.resolve?.(phase === "ended");
  };
  activePronunciation = state;
  notify("loading", "正在加载发音…");
  try {
    if (!owner?.Audio || !owner.Blob || !owner.URL?.createObjectURL) throw new Error("Audio window unavailable");
    const response = await Zotero.HTTP.request("GET",
      "https://dict.youdao.com/dictvoice?type=2&audio=" + encodeURIComponent(text),
      { responseType: "arraybuffer", timeout: 12000 });
    if (state.finished || activePronunciation !== state) return false;
    const bytes = new Uint8Array(response.response);
    const mp3 = bytes.length > 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    if (!mp3) throw new Error("Invalid pronunciation audio");
    state.objectURL = owner.URL.createObjectURL(new owner.Blob([response.response], { type: "audio/mpeg" }));
    const audio = state.audio = new owner.Audio();
    audio.preload = "auto"; audio.volume = 1; audio.muted = false;
    audio.addEventListener("playing", playing);
    audio.addEventListener("ended", ended);
    audio.addEventListener("error", failed);
    audio.src = state.objectURL;
    return await new Promise(resolve => {
      state.resolve = resolve;
      state.timer = setTimeout(() => state.finish("error", "发音加载超时，点击重试"), 10000);
      try { Promise.resolve(audio.play()).catch(failed); }
      catch (_) { failed(); }
    });
  } catch (error) {
    if (!state.finished) state.finish("error", "发音加载失败，请检查网络后点击重试");
    return false;
  }
}

function bindAudioControl(doc, control, word, container) {
  if (control.localName !== "button") {
    control.setAttribute("role", "button"); control.tabIndex = 0;
    control.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); control.click(); }
    });
  }
  control.setAttribute("aria-label", `播放 ${word} 的发音`);
  const feedback = createHTML(doc, "span", { display: "none", fontSize: "11px", overflowWrap: "anywhere" }, { role: "status", "aria-live": "polite" });
  feedback.hidden = true;
  container.appendChild(feedback);
  control.addEventListener("click", () => {
    playAudio(doc, word, (phase, message) => {
      control.dataset.audioState = phase;
      control.setAttribute("aria-busy", String(phase === "loading"));
      control.title = phase === "error" ? message : phase === "playing" ? "正在播放；再次点击可重播" : "点击播放发音";
      feedback.textContent = message;
      feedback.hidden = !["loading", "playing", "ended", "error"].includes(phase);
      feedback.style.display = feedback.hidden ? "none" : "block";
    });
  });
  return feedback;
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
    return { ok: false, text: "请在 Zotero 设置 → 多功能单词本中填写百度 APP ID 和密钥" };
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
    isPreferenceEnabled(PREF_DICTIONARY) ? requestJSON(
      `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(
        clean
      )}&dicts={"count":1,"dicts":[["ec"]]}`
    ) : Promise.resolve(null),
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

  return { phonetic, baiduText, dictExplain, combinedMeaning, ok: !!(baiduText || dictExplain) };
}

// Keep hyphenated words and contractions intact, deduplicating case-insensitively.
function extractWords(text) {
  const seen = new Set();
  return (String(text).match(/[A-Za-z]+(?:[-‐‑–‘’'][A-Za-z]+)*/g) || []).filter(word => {
    const key = wordKey(word);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function wordKey(text) {
  return normalizePDFText(text).replace(/\s+/g, " ").trim();
}

function findSavedWord(list, word) {
  const key = wordKey(word);
  return list.find(entry => entry.word === word) || list.find(entry => wordKey(entry.word) === key);
}

function getDuplicateGroups(list) {
  const groups = new Map();
  for (const entry of list) {
    const key = wordKey(entry.word);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return new Map([...groups].filter(([, entries]) => entries.length > 1));
}

function hasWordMeaning(meaning) {
  return typeof meaning === "string" && meaning.trim() !== ""
    && !["暂无释义", "待补充释义"].includes(meaning.trim());
}

async function collectWords(words, context, { lookup = fetchWordRichInfo,
  delay = () => new Promise(resolve => setTimeout(resolve, 1100)), onProgress = () => {},
  getPosition = async () => context.position || null, allowUntranslated = false } = {}) {
  const result = { saved: [], failed: [], missing: [] };
  const unique = [...new Map(words.map(word => [wordKey(word), word.trim()])).values()].filter(Boolean);
  for (const word of unique) {
    // Allow standard Baidu accounts (one request per second) to collect a batch.
    await delay();
    try {
      let info;
      try { info = await lookup(word); }
      catch (error) { if (!allowUntranslated) throw error; }
      if (!info?.ok || !hasWordMeaning(info.combinedMeaning)) {
        if (!allowUntranslated) throw new Error("释义查询失败，请检查网络或翻译配置");
        info = { phonetic: "", combinedMeaning: "" };
      }
      addOrUpdateWord({ ...context, word, phonetic: info.phonetic, meaning: info.combinedMeaning, position: await getPosition(word) }, { refresh: false });
      result.saved.push(word);
      if (!hasWordMeaning(findSavedWord(getVocabList(), word)?.meaning)) result.missing.push(word);
    } catch (error) {
      result.failed.push(word);
    }
    onProgress(result.saved.length + result.failed.length, unique.length);
  }
  if (result.saved.length) refreshAllSidebars();
  return result;
}

function getSavedWordKeys() {
  // A damaged wordbook should not prevent the reader from translating selections.
  try { return new Set(getVocabList().map(entry => wordKey(entry.word))); }
  catch (_) { return new Set(); }
}

function appendWordPicker(doc, box, text, getContext, ready = Promise.resolve(), { lookup = fetchWordRichInfo, getPosition, delay, allowUntranslated = false } = {}) {
  const picker = createHTML(doc, "div", { display: "flex", flexDirection: "column", gap: "6px" });
  picker.dataset.vocabWordPicker = "true";
  const label = createHTML(doc, "div");
  label.textContent = "点选要记住的词，点击收录时查询释义：";
  picker.appendChild(label);
  const chips = createHTML(doc, "div", { display: "flex", flexWrap: "wrap", gap: "4px", maxHeight: "140px", overflowY: "auto" });
  const words = extractWords(text);
  let savedKeys = getSavedWordKeys();
  const selected = new Set(words.length === 1 ? words : []);
  const buttons = new Map();
  const status = createHTML(doc, "div", { fontSize: "11px" }, { role: "status", "aria-live": "polite" });
  const save = createHTML(doc, "button", { padding: "5px 8px", backgroundColor: "#247a3c", color: "white", border: "none", borderRadius: "4px" });
  const update = () => {
    for (const [word, button] of buttons) {
      const checked = selected.has(word);
      const saved = savedKeys.has(wordKey(word));
      button.textContent = saved ? `${word} ✓` : word;
      button.title = saved ? "已收录，再次加入会补充出处" : word;
      button.setAttribute("aria-label", saved ? `${word}，已收录` : word);
      button.setAttribute("aria-pressed", String(checked));
      setButtonColors(button, checked ? "#0066cc" : "ButtonFace", checked ? "white" : "ButtonText");
    }
    save.disabled = selected.size === 0;
    save.textContent = `加入 ${selected.size} 个生词（保留原句）`;
  };
  for (const word of words) {
    const chip = createHTML(doc, "button", { padding: "2px 6px", border: "1px solid #aaa", borderRadius: "4px" }, { "aria-pressed": "false" });
    chip.textContent = word;
    chip.addEventListener("click", () => { selected.has(word) ? selected.delete(word) : selected.add(word); update(); });
    buttons.set(word, chip);
    chips.appendChild(chip);
  }
  save.addEventListener("click", async () => {
    if (save.disabled) return;
    save.disabled = true;
    for (const button of buttons.values()) button.disabled = true;
    status.textContent = "正在获取译文与释义…";
    try {
      await (typeof ready === "function" ? ready() : ready);
      const result = await collectWords([...selected], getContext(), {
        lookup, getPosition, delay, allowUntranslated,
        onProgress: (done, total) => { status.textContent = `正在入库 ${done}/${total}…`; },
      });
      for (const word of result.saved) selected.delete(word);
      status.textContent = `已保存 ${result.saved.length} 个生词。` + (result.missing?.length ? `待补充释义：${result.missing.join('、')}，可在单词本补查或手动修改。` : "")
        + (result.failed.length ? `未保存：${result.failed.join('、')}。可重试。` : "");
    } catch (error) {
      status.textContent = "收录失败，请重试。";
    } finally {
      savedKeys = getSavedWordKeys();
      for (const button of buttons.values()) button.disabled = false;
      update();
    }
  });
  picker.append(chips, save, status);
  box.appendChild(picker);
  update();
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

function saveVocabList(list, refresh = true) {
  Zotero.Prefs.set(PREF_WORDS, JSON.stringify(list), true);
  if (refresh) refreshAllSidebars();
}

function getWordLocations(entry) {
  const locations = Array.isArray(entry.locations) ? entry.locations : [];
  if (locations.length) return locations;
  return entry.itemID || entry.attachmentID ? [{
    itemID: entry.itemID, attachmentID: entry.attachmentID, pageIndex: entry.pageIndex,
    position: entry.position || null, contextSentence: entry.contextSentence || "",
    contextTrans: entry.contextTrans || "", source: entry.source,
  }] : [];
}

function locationKey(location) {
  return JSON.stringify([location.itemID ?? null, location.attachmentID ?? null, location.pageIndex ?? null,
    location.position ?? null, location.contextSentence || ""]);
}

function mergeDuplicateWords(list, groups) {
  const emitted = new Set();
  return list.flatMap(entry => {
    const key = wordKey(entry.word);
    const group = groups.get(key);
    if (!group) return [entry];
    if (emitted.has(key)) return [];
    emitted.add(key);
    const meanings = group.filter(value => hasWordMeaning(value.meaning));
    const edited = meanings.filter(value => value.meaningEdited);
    const join = (values, separator) => [...new Set(values.filter(Boolean))].join(separator);
    const locations = new Map();
    for (const location of group.flatMap(getWordLocations)) {
      const previous = locations.get(locationKey(location));
      locations.set(locationKey(location), { ...previous, ...location,
        source: previous?.source || location.source, contextTrans: previous?.contextTrans || location.contextTrans });
    }
    const preferred = [...locations.values()].find(value => value.position?.rects?.length)
      || [...locations.values()].find(value => value.attachmentID) || locations.values().next().value;
    return [{ ...entry, ...preferred, locations: [...locations.values()],
      phonetic: group.find(value => value.phonetic)?.phonetic || "",
      meaning: join([...edited, ...meanings].map(value => value.meaning.trim()), "\n") || "待补充释义",
      meaningEdited: edited.length > 0 || new Set(meanings.map(value => value.meaning.trim())).size > 1,
      meaningPending: meanings.length === 0,
      note: join(group.map(value => value.note), "\n\n"),
      mastery: Math.max(...group.map(value => value.mastery || 0)),
      reviewCount: group.reduce((total, value) => total + (Number(value.reviewCount) || 0), 0),
      date: group.map(value => value.date || "").sort().at(-1),
    }];
  });
}

function getWordsForPaper(words, itemID) {
  if (!itemID) return [];
  return words.flatMap(entry => {
    const quality = location => location.attachmentID ? (location.position?.rects?.length ? 2 : 1) : 0;
    const location = getWordLocations(entry).filter(location => location.itemID === itemID)
      .reverse().sort((a, b) => quality(b) - quality(a))[0];
    return location ? [{ ...entry, ...location }] : [];
  });
}

function updateWordMeaning(word, meaning) {
  const list = getVocabList();
  const entry = findSavedWord(list, word);
  if (!entry) throw new Error("该生词已被删除，请刷新后重试");
  if (!String(meaning).trim()) throw new Error("请填写释义");
  entry.meaning = String(meaning).trim();
  entry.meaningEdited = true;
  entry.meaningPending = false;
  saveVocabList(list);
}

function appendMeaningEditor(doc, container, entry) {
  if (!hasWordMeaning(entry.meaning)) {
    const lookup = createHTML(doc, "button", { alignSelf: "flex-start", fontSize: "11px", padding: "2px 7px" });
    lookup.textContent = "补查释义";
    lookup.addEventListener("click", async () => {
      lookup.disabled = true;
      lookup.textContent = "正在查词…";
      try {
        const info = await fetchWordRichInfo(entry.word);
        if (!info.ok || !hasWordMeaning(info.combinedMeaning)) throw new Error("暂未查到释义，请检查设置或手动修改");
        const list = getVocabList();
        const current = findSavedWord(list, entry.word);
        if (!current) throw new Error("该词已删除");
        // A lookup finishing later must not replace a correction made in the meantime.
        if (!current.meaningEdited) {
          current.meaning = info.combinedMeaning;
          current.phonetic = info.phonetic || current.phonetic || "";
          current.meaningPending = false;
          saveVocabList(list);
        }
      } catch (error) { lookup.textContent = "未查到释义，点击重试"; lookup.title = String(error.message || error); }
      finally { lookup.disabled = false; }
    });
    container.appendChild(lookup);
  }
  const edit = createHTML(doc, "button", { alignSelf: "flex-start", fontSize: "11px", padding: "2px 7px" });
  edit.textContent = "✎ 修改释义";
  edit.addEventListener("click", () => {
    if (container.querySelector('[data-vocab-meaning-editor]')) return;
    const form = createHTML(doc, "div", { display: "flex", flexDirection: "column", gap: "5px", width: "100%" }, { "data-vocab-meaning-editor": "true" });
    const input = createHTML(doc, "textarea", { width: "100%", minHeight: "72px", resize: "vertical", color: "FieldText", backgroundColor: "Field" }, { "aria-label": "修改生词释义", rows: "3" });
    input.value = entry.meaning || "";
    const status = createHTML(doc, "div", {}, { role: "status" });
    const row = createHTML(doc, "div", { display: "flex", gap: "5px", flexWrap: "wrap" });
    const save = createHTML(doc, "button", { backgroundColor: "#0066cc", color: "white" });
    save.textContent = "保存释义";
    save.addEventListener("click", () => {
      try { updateWordMeaning(entry.word, input.value); }
      catch (error) { status.textContent = error.message; }
    });
    const cancel = createHTML(doc, "button");
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => { form.remove(); edit.disabled = false; });
    row.append(save, cancel);
    form.append(input, row, status);
    container.appendChild(form);
    edit.disabled = true;
    input.focus();
  });
  container.appendChild(edit);
}

function addOrUpdateWord({
  word,
  phonetic = "",
  meaning = "",
  meaningEdited = false,
  contextSentence = "",
  contextTrans = "",
  note = "",
  sourceTitle = "手动添加",
  itemID = null,
  attachmentID = null,
  pageIndex = null,
  position = null,
}, { refresh = true } = {}) {
  const cleanWord = (word || "").trim().replace(/\s+/g, " ");
  if (!cleanWord) return;
  if (Number.isInteger(position?.pageIndex)) pageIndex = position.pageIndex;

  const list = getVocabList();
  const idx = list.indexOf(findSavedWord(list, cleanWord));
  const old = idx >= 0 ? list[idx] : null;
  const nextMeaning = old?.meaningEdited && !meaningEdited ? old.meaning : hasWordMeaning(meaning) ? meaning
    : hasWordMeaning(old?.meaning) ? old.meaning : "待补充释义";
  const locations = old ? getWordLocations(old).map(location => ({ ...location })) : [];
  if (itemID || attachmentID) {
    const location = { itemID, attachmentID, pageIndex, position, contextSentence, contextTrans, source: sourceTitle };
    const locationIndex = locations.findIndex(value => locationKey(value) === locationKey(location));
    if (locationIndex >= 0) locations[locationIndex] = { ...location, contextTrans: contextTrans || locations[locationIndex].contextTrans };
    else locations.push(location);
  }

  if (idx >= 0) {
    list[idx] = {
      ...old,
      phonetic: phonetic || old.phonetic || "",
      meaning: nextMeaning,
      meaningEdited: meaningEdited || !!old.meaningEdited,
      meaningPending: !hasWordMeaning(nextMeaning),
      contextSentence: itemID || attachmentID ? contextSentence : contextSentence || old.contextSentence || "",
      contextTrans: itemID || attachmentID ? contextTrans : contextTrans || old.contextTrans || "",
      note: note || old.note || "",
      source: itemID || attachmentID ? sourceTitle : old.source || sourceTitle,
      itemID: itemID ?? old.itemID,
      attachmentID: itemID || attachmentID ? attachmentID : old.attachmentID,
      pageIndex: itemID || attachmentID ? pageIndex : old.pageIndex,
      position: itemID || attachmentID ? position : old.position || null,
      locations,
      date: new Date().toISOString().slice(0, 10),
    };
  } else {
    list.unshift({
      word: cleanWord,
      phonetic: phonetic || "",
      meaning: nextMeaning,
      meaningEdited,
      meaningPending: !hasWordMeaning(nextMeaning),
      contextSentence: contextSentence || "",
      contextTrans: contextTrans || "",
      note: note || "",
      source: sourceTitle || "手动添加",
      itemID: itemID || null,
      attachmentID: attachmentID || null,
      pageIndex: pageIndex ?? null,
      position,
      locations,
      mastery: 0,
      reviewCount: 0,
      date: new Date().toISOString().slice(0, 10),
    });
  }
  saveVocabList(list, refresh);
}

function updateMastery(word, newMastery, incrementReview = false) {
  const list = getVocabList();
  const target = findSavedWord(list, word);
  if (target) {
    target.mastery = newMastery;
    if (incrementReview) {
      target.reviewCount = (target.reviewCount || 0) + 1;
    }
    saveVocabList(list);
  }
}

function removeWord(word) {
  const list = getVocabList();
  const index = list.findIndex(entry => entry.word === word);
  if (index < 0) return;
  list.splice(index, 1);
  saveVocabList(list);
}

function normalizePDFText(text) {
  return String(text || "").normalize("NFKC").replace(/[’‘]/g, "'").replace(/[‐‑–]/g, "-").toLowerCase();
}

function findWordPosition(chars, word, pageIndex, rects = null, contextSentence = "") {
  const normalize = normalizePDFText;
  const target = normalize(word).replace(/\s+/g, " ").trim();
  if (!target || !Array.isArray(chars)) return null;
  const inSelection = char => {
    if (!rects?.length) return true;
    const r = char.rect;
    if (!Array.isArray(r) || r.length !== 4) return false;
    const x = (r[0] + r[2]) / 2, y = (r[1] + r[3]) / 2;
    return rects.some(rect => x >= rect[0] - 0.5 && x <= rect[2] + 0.5 && y >= rect[1] - 0.5 && y <= rect[3] + 0.5);
  };
  let text = "", offsets = [], previousIndex = -1;
  const append = (value, char) => {
    for (const letter of value) {
      text += letter;
      for (let i = 0; i < letter.length; i++) offsets.push(char);
    }
  };
  chars.forEach((char, index) => {
    if (!inSelection(char)) return;
    if (previousIndex >= 0 && index !== previousIndex + 1) append(" ", null);
    const value = normalize(char.u);
    for (const letter of value) {
      if (/\s/.test(letter)) { if (!text.endsWith(" ")) append(" ", null); }
      else append(letter, char);
    }
    if ((char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) && !text.endsWith(" ")) append(" ", null);
    previousIndex = index;
  });
  let start = 0, end = text.length;
  // Legacy entries have only a page and context; use context to disambiguate repeats.
  if (!rects?.length && contextSentence) {
    const context = normalize(contextSentence).replace(/\s+/g, " ").trim();
    const contextStart = text.indexOf(context);
    if (contextStart >= 0) { start = contextStart; end = contextStart + context.length; }
  }
  for (let index = text.indexOf(target, start); index >= 0 && index + target.length <= end; index = text.indexOf(target, index + 1)) {
    const before = text[index - 1] || "", after = text[index + target.length] || "";
    if (/[a-z'-]/i.test(before) || /[a-z'-]/i.test(after)) continue;
    const matched = [...new Set(offsets.slice(index, index + target.length).filter(Boolean))];
    const foundRects = matched.map(char => char.rect).filter(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite));
    if (foundRects.length) return { pageIndex, rects: foundRects.map(rect => Array.from(rect)) };
  }
  return null;
}

async function resolveWordPosition(reader, word, selection, contextSentence = "") {
  const pageIndex = selection?.pageIndex ?? 0;
  try {
    await reader._initPromise;
    const view = reader._internalReader?._primaryView;
    if (!view?._pdfPages || typeof view._ensureBasicPageData !== "function") return selection || null;
    const pages = [{ pageIndex, rects: selection?.rects }];
    if (selection?.nextPageRects?.length) pages.push({ pageIndex: pageIndex + 1, rects: selection.nextPageRects });
    for (const page of pages) {
      await view._ensureBasicPageData(page.pageIndex);
      const found = findWordPosition(view._pdfPages[page.pageIndex]?.chars, word, page.pageIndex, page.rects, contextSentence);
      if (found) return found;
    }
  } catch (error) { Zotero.debug("[VocabBook] 原词定位降级到选区或页码"); }
  return selection?.rects?.length ? selection : null;
}

async function openWordLocation(entry) {
  if (!entry.attachmentID) return false;
  const page = typeof entry.pageIndex === "number" ? entry.pageIndex : 0;
  try {
    const reader = await Zotero.Reader.open(entry.attachmentID, { pageIndex: page }, {
      openInWindow: false,
    });
    if (reader && typeof reader.navigate === "function") {
      const position = await resolveWordPosition(reader, entry.word, entry.position || { pageIndex: page }, entry.contextSentence);
      await reader.navigate(position?.rects?.length ? { position } : { pageIndex: page });
    }
    return Boolean(reader);
  } catch (e) {
    Zotero.debug("[VocabBook] 跳转 PDF 失败: " + e);
    return false;
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
      state.resizeObserver?.disconnect();
      activeSidebarContainers.delete(state);
    }
  }
}

function renderSidebarContent(state) {
  try {
    renderSidebarView(state);
    ensureSectionBodyVisible(state.body);
    constrainSidebarWidth(state);
  } catch (error) {
    Zotero.debug("[VocabBook] 侧栏渲染失败: " + error);
    const message = createHTML(state.body.ownerDocument, "div", { padding: "12px" }, { role: "alert" });
    message.textContent = "生词本暂时无法显示：" + error.message;
    state.body.replaceChildren(message);
  }
}

function constrainSidebarWidth(state) {
  const body = state.body;
  const host = body.closest("item-details");
  if (!host) return;
  const view = body.ownerDocument.defaultView;
  if (!state.resizeObserver && view?.ResizeObserver) {
    state.resizeObserver = new view.ResizeObserver(() => constrainSidebarWidth(state));
    state.resizeObserver.observe(host);
  }
  if (!host.clientWidth) return;
  const content = body.closest(".zotero-view-item");
  const style = content && view.getComputedStyle(content);
  const inset = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
  // Some Zotero context panes keep their inner flex box wider than the visible pane.
  // Constrain our own content to the pane's measured width without changing Zotero's layout.
  body.style.maxWidth = Math.max(0, host.clientWidth - inset) + "px";
}

function escapeExportHTML(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function searchText(value) {
  return wordKey(value).normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/'/g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

// One typo for shorter words, two for longer ones. Adjacent swaps count as one.
function typoDistance(query, term) {
  const limit = query.length >= 8 ? 2 : 1;
  if (!/^[a-z]{4,48}$/.test(query) || Math.abs(query.length - term.length) > limit) return Infinity;
  let older, previous = Array.from({ length: term.length + 1 }, (_, i) => i);
  for (let i = 1; i <= query.length; i++) {
    const row = [i];
    for (let j = 1; j <= term.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (query[i - 1] === term[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && query[i - 1] === term[j - 2] && query[i - 2] === term[j - 1]) {
        row[j] = Math.min(row[j], older[j - 2] + 1);
      }
    }
    older = previous; previous = row;
  }
  return previous[term.length] <= limit ? previous[term.length] : Infinity;
}

function filterVocabWords(words, state) {
  const query = searchText(state.searchQuery);
  const parts = query ? query.split(" ") : [];
  const ranked = [];
  for (const entry of words) {
    if (state.masteryFilter !== -1 && (entry.mastery || 0) !== state.masteryFilter) continue;
    let rank = 0;
    if (query) {
      const name = searchText(entry.word);
      const joinedName = searchText(wordKey(entry.word).replace(/-/g, ""));
      const matchesParts = value => parts.every(part => value.includes(part));
      if (name === query) rank = 0;
      else if (name.startsWith(query)) rank = 1;
      else if (name.includes(query) || matchesParts(name) || joinedName === query) rank = 2;
      else {
        const terms = name.match(/[a-z]+/g) || [];
        const distances = parts.map(part => name.includes(part) ? 0
          : terms.reduce((best, term) => Math.min(best, typoDistance(part, term)), Infinity));
        if (distances.every(Number.isFinite)) {
          const worst = distances.reduce((max, distance) => Math.max(max, distance), 0);
          rank = 3 + 2 * (worst - 1) + Number(parts.length !== terms.length);
        } else if (matchesParts(searchText(entry.meaning))) rank = 7;
        else if (matchesParts(searchText(entry.contextSentence))) rank = 8;
        else continue;
      }
    }
    ranked.push({ entry, rank });
  }
  const sort = (a, b) => state.sortBy === "alpha" ? a.word.localeCompare(b.word)
    : state.sortBy === "mastery" ? (a.mastery || 0) - (b.mastery || 0) : 0;
  return ranked.sort((a, b) => a.rank - b.rank || sort(a.entry, b.entry)).map(({ entry }) => entry);
}

function createDuplicateCheck(doc, state, btnStyle) {
  const button = createHTML(doc, "button", btnStyle, { "aria-expanded": "false", title: "检查整个单词本中的重复词" });
  button.textContent = "检查重复";
  const results = createHTML(doc, "div", { fontSize: "11px", padding: "6px", borderRadius: "5px",
    border: "1px solid rgba(128,128,128,.35)" }, { "data-vocab-duplicate-results": "true" });
  results.hidden = true;
  const summary = createHTML(doc, "div", {}, { role: "status" });
  if (state.duplicateNotice) {
    summary.textContent = state.duplicateNotice;
    state.duplicateNotice = "";
    results.append(summary);
    results.hidden = false;
    button.setAttribute("aria-expanded", "true");
  }
  const display = list => {
    const groups = getDuplicateGroups(list);
    results.replaceChildren(summary);
    summary.textContent = groups.size ? `全库发现 ${groups.size} 组重复词：` : "已检查全库，没有重复词。";
    if (!groups.size) return;
    const preview = createHTML(doc, "ul", { margin: "4px 0", paddingInlineStart: "20px", maxHeight: "120px", overflowY: "auto" });
    for (const group of groups.values()) {
      const line = createHTML(doc, "li");
      line.textContent = `${[...new Set(group.map(entry => entry.word.trim()))].join(" / ")}（${group.length} 条）`;
      preview.appendChild(line);
    }
    const merge = createHTML(doc, "button", btnStyle);
    merge.textContent = "合并这些重复词";
    merge.addEventListener("click", () => {
      const current = getVocabList();
      if (JSON.stringify(current) !== JSON.stringify(list)) { display(current); return; }
      const merged = mergeDuplicateWords(current, groups);
      state.duplicateNotice = `已合并 ${groups.size} 组重复词，保留释义、笔记和出处。`;
      saveVocabList(merged);
    });
    results.append(preview, merge);
  };
  button.addEventListener("click", () => {
    results.hidden = !results.hidden;
    button.setAttribute("aria-expanded", String(!results.hidden));
    if (!results.hidden) display(getVocabList());
  });
  return { button, results };
}

function renderSidebarView(state) {
  const { body, item } = state;
  const doc = body.ownerDocument;
  const scrollTop = body.querySelector('[data-vocab-results]')?.scrollTop || 0;
  Object.assign(body.style, { minWidth: "0", maxWidth: "100%", boxSizing: "border-box" });
  const section = body.closest("collapsible-section");
  // A label fallback also covers live upgrades while Zotero refreshes Fluent.
  if (section && !section.getAttribute("label")) {
    section.setAttribute("label", String(Zotero.locale || "zh-CN").startsWith("zh") ? "多功能单词本" : "Multifunction Vocab Book");
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
  const mount = () => {
    body.replaceChildren(wrapper);
    state.renderedView = wrapper;
  };

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
    const list = state.onlyCurrentPaper ? getWordsForPaper(getVocabList(), currentPaperID) : getVocabList();
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

  navBar.append(scopeBtn, modeBtn, exportBtn);
  wrapper.appendChild(navBar);

  const allWords = getVocabList();
  const scopedWords = state.onlyCurrentPaper
    ? getWordsForPaper(allWords, currentPaperID)
    : allWords;

  // 闪卡模式
  if (state.viewMode === "flashcard") {
    const filtered = filterVocabWords(scopedWords, state);
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
      bindAudioControl(doc, wordBig, cur.word, cardBox);

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
        meanEl.textContent = hasWordMeaning(cur.meaning) ? cur.meaning : "待补充释义";
        ansBox.appendChild(meanEl);
        appendMeaningEditor(doc, ansBox, cur);

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
          flexWrap: "wrap",
          gap: "6px",
          marginTop: "6px",
        });

        const rateOptions = [
          { label: "🔴 生疏", level: 0, color: "#d9534f" },
          { label: "🟡 模糊", level: 1, color: "#8a5a05" },
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
    mount();
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
  const savedKeys = new Set(allWords.map(entry => wordKey(entry.word)));
  const updateAddLabel = () => {
    addBtn.textContent = savedKeys.has(wordKey(wordInput.value)) ? "已收录 · 补充出处" : "➕ 查词入库";
  };
  wordInput.addEventListener("input", () => { if (!addBtn.disabled) updateAddLabel(); });

  addBtn.addEventListener("click", async () => {
    const w = wordInput.value.trim();
    if (!w) {
      wordInput.focus();
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = "⏳ 查询中...";
    try {
      const saved = findSavedWord(getVocabList(), w);
      const info = hasWordMeaning(saved?.meaning)
        ? { phonetic: saved.phonetic, combinedMeaning: saved.meaning } : await fetchWordRichInfo(w);
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
  let composing = false;
  const updateSearch = () => {
    if (state.searchQuery === searchInput.value) return;
    state.searchQuery = searchInput.value;
    state.flashcardIndex = 0;
    state.flashcardFlipped = false;
    renderResults();
    listContainer.scrollTop = 0;
  };
  searchInput.addEventListener("compositionstart", () => { composing = true; });
  searchInput.addEventListener("compositionend", () => { composing = false; updateSearch(); });
  searchInput.addEventListener("input", event => { if (!composing && !event.isComposing) updateSearch(); });

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
  const duplicateCheck = createDuplicateCheck(doc, state, btnStyle);
  filterRow.appendChild(duplicateCheck.button);
  wrapper.appendChild(filterRow);
  wrapper.appendChild(duplicateCheck.results);

  const statBar = createHTML(doc, "div", {
    fontSize: "11px",
    color: "#666",
    display: "flex",
    justifyContent: "space-between",
  });
  const c0 = scopedWords.filter((w) => (w.mastery || 0) === 0).length;
  const c1 = scopedWords.filter((w) => w.mastery === 1).length;
  const c2 = scopedWords.filter((w) => w.mastery === 2).length;
  wrapper.appendChild(statBar);

  const listContainer = createHTML(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: "420px",
    overflowY: "auto",
  }, { "data-vocab-results": "true" });

  function renderResults() {
    const filtered = filterVocabWords(scopedWords, state);
    statBar.textContent = `显示 ${filtered.length} 词 | 🔴${c0}  🟡${c1}  🟢${c2}`;
    listContainer.replaceChildren(buildVocabCards(doc, filtered, allWords.length));
  }
  renderResults();
  wrapper.appendChild(listContainer);
  mount();
  listContainer.scrollTop = scrollTop;
}

function buildVocabCards(doc, filtered, hasWords) {
  const cards = doc.createDocumentFragment();
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
    emptyTip.textContent = hasWords
      ? "当前范围或筛选条件下没有生词。\n可清空搜索、切换等级，或点「当前文献」切换到全部生词。"
      : "还没有生词，可在 PDF 划选收录，或在上方输入单词查询。";
    cards.appendChild(emptyTip);
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
      bindAudioControl(doc, wordTitle, itemObj.word, card);

      const audioIcon = createHTML(doc, "span", {
        cursor: "pointer",
        fontSize: "11px",
        color: "#555",
      });
      audioIcon.textContent = itemObj.phonetic
        ? `${itemObj.phonetic} 🔊`
        : "🔊";
      bindAudioControl(doc, audioIcon, itemObj.word, card);

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
      meanText.textContent = hasWordMeaning(itemObj.meaning) ? itemObj.meaning : "待补充释义";
      card.appendChild(meanText);
      appendMeaningEditor(doc, card, itemObj);

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
        jumpBtn.textContent = `📍 P.${pageNum} 定位原词`;
        jumpBtn.title = "返回原词位置；旧数据将尝试在原页查找";
        jumpBtn.addEventListener("click", () =>
          openWordLocation(itemObj)
        );
        metaRow.appendChild(jumpBtn);
      }

      card.appendChild(metaRow);
      cards.appendChild(card);
    }
  }
  return cards;
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
  if (rootURI) {
    const scope = { Zotero, stylesheetURI: rootURI + "reading-dashboard.css" };
    Services.scriptloader.loadSubScript(rootURI + "reading-dashboard.js", scope);
    readingDashboard = scope.VocabBookReadingDashboard;
  }
  Zotero.VocabBook = { getBaiduCredentials, translateWithBaidu };
  registeredPreferencesID = await Zotero.PreferencePanes.register({
    pluginID: PLUGIN_ID, id: PREFERENCES_ID, label: "多功能单词本",
    src: "preferences.xhtml", scripts: ["preferences.js"], stylesheets: ["preferences.css"],
    image: "icons/icon.svg", helpURL: "https://github.com/RedkieZhang717/vocabu_text/blob/main/docs/USER_GUIDE.md",
  });

  for (let win of Zotero.getMainWindows()) {
    if (win.MozXULElement) {
      win.MozXULElement.insertFTLIfNeeded("vocab-book-ui.ftl");
    }
    readingDashboard?.install(win, { getVocabList, getWordsForPaper, openWordLocation });
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
        if (state.body === body) {
          state.resizeObserver?.disconnect();
          activeSidebarContainers.delete(state);
        }
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
          onlyCurrentPaper: true,
          viewMode: "list",
          masteryFilter: -1,
          sortBy: "date",
          searchQuery: "",
          flashcardIndex: 0,
          flashcardFlipped: false,
        };
        activeSidebarContainers.add(state);
      } else if (state.item === item && state.renderedView?.parentNode === body) {
        return;
      } else {
        state.item = item;
      }
      renderSidebarContent(state);
      ensureSectionBodyVisible(body);
    },
  });

  Zotero.Reader.registerEventListener("renderTextSelectionPopup", renderSelectionPopup, PLUGIN_ID);
}

function selectionIcon(doc, name) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  svg.style.display = "block";
  const paths = {
    translate: "M2 4h9M6 2v2m3 0c-1 5-3 7-7 9m1-7c1 3 3 5 6 6m2 5 3-9 4 9m-6-3h5",
    collect: "M3 3h10v14H3zM6 6h4M6 9h3m6-2v6m-3-3h6",
    chevron: "m6 8 4 4 4-4",
    audio: "M3 8v4h3l4 3V5L6 8H3m10-1c2 2 2 4 0 6m2-8c3 3 3 7 0 10",
  };
  const path = doc.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name]); path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function appendPhrasePicker(doc, box, text, getContext, { lookup, getPosition, ready = () => Promise.resolve() }) {
  const picker = createHTML(doc, "div", { display: "flex", flexDirection: "column", gap: "7px" }, { "data-vocab-phrase-picker": "true" });
  const hint = createHTML(doc, "div", { fontSize: "11px" });
  hint.textContent = "先点起词，再点结尾，连续词组自动合并；也可在下方编辑。";
  const tokens = [...text.matchAll(/[A-Za-z]+(?:[-‐‑–‘’'][A-Za-z]+)*/g)];
  const row = createHTML(doc, "div", { display: "flex", flexWrap: "wrap", gap: "4px", maxHeight: "112px", overflowY: "auto", overscrollBehavior: "contain" });
  const input = createHTML(doc, "input", { width: "100%", padding: "5px 7px", color: "FieldText", backgroundColor: "Field" }, { type: "text", placeholder: "例如：in terms of", "aria-label": "要收录的词组", maxlength: "240" });
  input.value = tokens.length > 1 && tokens.length <= 6 && text.length <= 80 ? text : "";
  const meaning = createHTML(doc, "input", { width: "100%", padding: "5px 7px", color: "FieldText", backgroundColor: "Field" }, { type: "text", placeholder: "可选：手填释义；留空时收录即查", "aria-label": "词组手动释义" });
  const status = createHTML(doc, "div", { fontSize: "11px" }, { role: "status", "aria-live": "polite" });
  const save = createHTML(doc, "button", { padding: "5px 8px", border: "none", borderRadius: "5px", color: "white", backgroundColor: "#285cba" });
  save.textContent = "收录词组";
  let start = null, range = null, busy = false;
  let savedKeys = getSavedWordKeys();
  const chips = [];
  const repaint = () => {
    chips.forEach((chip, index) => {
      const selected = range && index >= range[0] && index <= range[1];
      chip.setAttribute("aria-pressed", String(!!selected));
      setButtonColors(chip, selected ? "#285cba" : "ButtonFace", selected ? "white" : "ButtonText");
    });
    save.disabled = busy || !input.value.trim();
    save.textContent = savedKeys.has(wordKey(input.value)) ? "收录词组（已收录，补充出处）" : "收录词组";
  };
  tokens.forEach((token, index) => {
    const chip = createHTML(doc, "button", { padding: "2px 6px", fontSize: "11px", minHeight: "25px", border: "1px solid rgba(128,128,128,.35)", borderRadius: "4px" }, { "aria-pressed": "false", "data-phrase-index": String(index) });
    chip.textContent = token[0];
    chip.addEventListener("click", () => {
      if (busy) return;
      if (start === null) {
        start = index; range = [index, index]; input.value = token[0];
        status.textContent = "已选起词，请再点词组的结尾。";
      } else {
        range = [Math.min(start, index), Math.max(start, index)];
        input.value = text.slice(tokens[range[0]].index, tokens[range[1]].index + tokens[range[1]][0].length);
        start = null; status.textContent = "词组已合并，可编辑后收录。";
      }
      repaint();
    });
    chips.push(chip); row.appendChild(chip);
  });
  input.addEventListener("input", () => { start = null; range = null; status.textContent = ""; repaint(); });
  save.addEventListener("click", async () => {
    if (save.disabled) return;
    const phrase = input.value.trim().replace(/\s+/g, " ");
    const manualMeaning = meaning.value.trim();
    busy = true; input.disabled = true; meaning.disabled = true;
    chips.forEach(chip => { chip.disabled = true; }); repaint();
    status.textContent = manualMeaning ? "正在收录词组…" : "正在查询词组释义…";
    try {
      await ready();
      let info;
      try { info = manualMeaning ? { ok: true, combinedMeaning: manualMeaning } : await lookup(phrase); }
      catch (_) { info = null; }
      addOrUpdateWord({ ...getContext(), word: phrase, phonetic: info?.phonetic || "",
        meaning: info?.ok ? info.combinedMeaning : "", meaningEdited: !!manualMeaning, position: await getPosition(phrase) });
      const stored = findSavedWord(getVocabList(), phrase);
      status.textContent = hasWordMeaning(stored?.meaning) ? `已收录词组：${phrase}` : `已收录 ${phrase}，待补充释义；可在单词本补查或手动修改。`;
    } catch (error) { status.textContent = "收录失败，请重试。"; }
    finally {
      savedKeys = getSavedWordKeys();
      busy = false; input.disabled = false; meaning.disabled = false;
      chips.forEach(chip => { chip.disabled = false; }); repaint();
    }
  });
  picker.append(hint, row, input, meaning, save, status); box.appendChild(picker); repaint();
}

var selectionPopupSequence = 0;
async function renderSelectionPopup(event, { lookup = fetchWordRichInfo, delay } = {}) {
  if (!isPreferenceEnabled(PREF_POPUP)) return;
  const { reader, doc, params, append } = event;
  const selectedText = (params?.annotation?.text || "").replace(/\s+/g, " ").trim();
  if (!selectedText) return;
  const automatic = isPreferenceEnabled(PREF_AUTO_TRANSLATE);
  const position = params?.annotation?.position ? JSON.parse(JSON.stringify(params.annotation.position)) : null;
  const attachmentID = reader.itemID || null;
  const pageIndex = position?.pageIndex ?? 0;
  let paperTitle = "PDF 文献", parentID = null;
  try {
    const attachment = Zotero.Items.get(attachmentID);
    const item = attachment?.parentItemID ? Zotero.Items.get(attachment.parentItemID) : attachment;
    if (item) { parentID = item.id; paperTitle = item.getField("title") || paperTitle; }
  } catch (error) {}
  const short = selectedText.split(/\s+/).length <= 4 && selectedText.length <= 40;
  const box = createHTML(doc, "div", {
    display: "flex", flexDirection: "column", gap: "5px", padding: "4px 6px",
    borderTop: "1px solid rgba(128,128,128,.2)", marginTop: "3px", fontSize: "12px",
    width: "280px", maxWidth: "calc(100vw - 40px)", maxHeight: "min(60vh, 440px)",
    overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", scrollbarGutter: "stable",
    color: "CanvasText", backgroundColor: "Canvas", userSelect: "none", MozUserSelect: "none",
  }, { "data-vocab-selection-popup": "true" });
  const controls = createHTML(doc, "div", { display: "flex", alignItems: "center", gap: "4px" });
  const makeIconButton = (name, label) => {
    const button = createHTML(doc, "button", { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "2px",
      padding: "3px 5px", minHeight: "26px", border: "1px solid rgba(128,128,128,.3)", borderRadius: "5px", color: "CanvasText", backgroundColor: "Canvas" }, { "aria-label": label, title: label });
    button.appendChild(selectionIcon(doc, name)); return button;
  };
  const translate = makeIconButton("translate", "翻译选区");
  const dropdown = makeIconButton("collect", "展开收录单词或词组");
  const chevron = selectionIcon(doc, "chevron"); dropdown.appendChild(chevron);
  dropdown.setAttribute("aria-expanded", "false");
  const panel = createHTML(doc, "div", { display: "none", flexDirection: "column", gap: "8px", width: "100%", maxHeight: "260px", overflowY: "auto", overscrollBehavior: "contain", padding: "5px 2px" });
  panel.id = `vocab-selection-collector-${++selectionPopupSequence}`;
  panel.hidden = true; dropdown.setAttribute("aria-controls", panel.id);
  // Give the automatic translation its final space before inserting the popup.
  // Loading and long results then change only the text inside this scroll area.
  const output = createHTML(doc, "div", { display: automatic ? "block" : "none", flex: "0 0 auto",
    height: short ? "3.7em" : "5.1em", lineHeight: "1.35", whiteSpace: "pre-wrap", fontSize: "12px",
    overflowY: "auto", overscrollBehavior: "contain", scrollbarGutter: "stable", padding: "4px 2px" },
  { role: "status", "aria-live": "polite" });
  output.hidden = !automatic;
  if (automatic) output.textContent = "正在查询…";
  const clearPopupSelection = () => {
    if (!box.isConnected || doc.activeElement?.closest?.("input, textarea")) return;
    // PDF text is selected in its own inner frame. An outer reader selection
    // intersecting these tools only paints our labels blue/grey in Gecko.
    const selection = doc.defaultView?.getSelection?.();
    try {
      for (let i = 0; i < (selection?.rangeCount || 0); i++) {
        if (selection.getRangeAt(i).intersectsNode(box)) { selection.removeAllRanges(); break; }
      }
    } catch (_) {}
  };
  const scheduleSelectionCleanup = () => doc.defaultView?.requestAnimationFrame?.(clearPopupSelection);
  const setExpanded = expanded => {
    panel.hidden = !expanded; panel.style.display = expanded ? "flex" : "none";
    dropdown.setAttribute("aria-expanded", String(expanded));
    dropdown.setAttribute("aria-label", expanded ? "收起收词面板" : "展开收录单词或词组");
    dropdown.title = expanded ? "收起收词面板" : "收录单词或词组";
    chevron.style.transform = expanded ? "rotate(180deg)" : "";
    clearPopupSelection();
    scheduleSelectionCleanup();
  };
  dropdown.addEventListener("click", () => {
    if (panel.hidden) buildCollector();
    setExpanded(panel.hidden);
  });
  // A click or drag in the floating tools must not become a PDF text selection.
  for (const type of ["pointerdown", "mousedown", "dblclick"]) {
    box.addEventListener(type, event => { event.stopPropagation(); clearPopupSelection(); });
  }
  box.addEventListener("selectstart", event => {
    if (!event.target.closest("input, textarea")) event.preventDefault();
  });
  box.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.stopPropagation();
      if (!event.target.closest("input, textarea")) { event.preventDefault(); clearPopupSelection(); }
    }
    if (event.key === "Escape" && !panel.hidden) { event.stopPropagation(); setExpanded(false); dropdown.focus(); }
  });
  controls.append(translate, dropdown); box.append(controls, output, panel);
  const caption = createHTML(doc, "div", { fontSize: "11px", maxHeight: "36px", overflow: "hidden", color: "GrayText" }, { title: selectedText });
  caption.textContent = `${selectedText} · P.${pageIndex + 1}`;
  panel.appendChild(caption);
  if (short) {
    const speak = makeIconButton("audio", "播放发音");
    const line = createHTML(doc, "div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" });
    const label = createHTML(doc, "span", { fontSize: "11px" }); label.textContent = "收词选项";
    line.append(label, speak); panel.appendChild(line);
    bindAudioControl(doc, speak, selectedText, panel);
  }
  let translated = "", pending = Promise.resolve();
  const requests = new Map();
  const getInfo = word => {
    const key = wordKey(word);
    if (!requests.has(key)) {
      const promise = Promise.resolve().then(() => lookup(word)).then(info => {
        if (!info?.ok) requests.delete(key);
        return info;
      }, error => { requests.delete(key); throw error; });
      requests.set(key, promise);
    }
    return requests.get(key);
  };
  const lookupForSave = word => {
    const saved = findSavedWord(getVocabList(), word);
    return hasWordMeaning(saved?.meaning)
      ? Promise.resolve({ ok: true, phonetic: saved.phonetic, combinedMeaning: saved.meaning }) : getInfo(word);
  };
  const query = async () => {
    translate.disabled = true; output.hidden = false; output.style.display = "block";
    output.textContent = "正在查询…";
    try {
      let queryText = selectedText;
      while (new TextEncoder().encode(queryText).length > 5500) queryText = queryText.slice(0, -100);
      if (short) {
        const info = await getInfo(queryText);
        output.textContent = info?.ok ? [info.phonetic, info.combinedMeaning].filter(Boolean).join(" ") : "暂未查到释义，可重试或手动填写。";
      } else {
        const result = await translateWithBaidu(queryText);
        translated = result.ok ? result.text : "";
        if (translated && queryText.length < selectedText.length) translated = "（长选区，仅翻译开头部分）" + translated;
        output.textContent = result.ok ? translated : result.text;
      }
    } catch (error) { output.textContent = "查询失败，可重试或先收录后补充。"; }
    finally { translate.disabled = false; scheduleSelectionCleanup(); }
  };
  translate.addEventListener("click", () => { if (!translate.disabled) pending = query(); });
  const getContext = () => ({ contextSentence: selectedText, contextTrans: translated,
    sourceTitle: paperTitle, itemID: parentID, attachmentID, pageIndex, position });
  let collectorBuilt = false;
  function buildCollector() {
  if (collectorBuilt) return;
  collectorBuilt = true;
    const tabs = createHTML(doc, "div", { display: "flex", gap: "5px" }, { role: "group", "aria-label": "收录方式" });
    const wordTab = createHTML(doc, "button", { padding: "3px 9px", borderRadius: "5px", border: "1px solid rgba(128,128,128,.3)" }, { "aria-pressed": "true" }); wordTab.textContent = "单词";
    const phraseTab = createHTML(doc, "button", { padding: "3px 9px", borderRadius: "5px", border: "1px solid rgba(128,128,128,.3)" }, { "aria-pressed": "false" }); phraseTab.textContent = "词组";
    const wordPane = createHTML(doc, "div");
    const phrasePane = createHTML(doc, "div", { display: "none" }); phrasePane.hidden = true;
    const choose = phrase => {
      wordPane.hidden = phrase; wordPane.style.display = phrase ? "none" : "block";
      phrasePane.hidden = !phrase; phrasePane.style.display = phrase ? "block" : "none";
      for (const [tab, active] of [[wordTab, !phrase], [phraseTab, phrase]]) {
        tab.setAttribute("aria-pressed", String(active));
        setButtonColors(tab, active ? "#285cba" : "ButtonFace", active ? "white" : "ButtonText");
      }
    };
    wordTab.addEventListener("click", () => choose(false)); phraseTab.addEventListener("click", () => choose(true));
    tabs.append(wordTab, phraseTab); panel.append(tabs, wordPane, phrasePane);
    appendWordPicker(doc, wordPane, selectedText, getContext, () => pending, {
      lookup: lookupForSave, delay, allowUntranslated: true,
      getPosition: word => resolveWordPosition(reader, word, position, selectedText),
    });
    appendPhrasePicker(doc, phrasePane, selectedText, getContext, {
      lookup: lookupForSave, ready: () => pending,
      getPosition: phrase => resolveWordPosition(reader, phrase, position, selectedText),
    });
    choose(short && extractWords(selectedText).length > 1);
  }
  append(box);
  scheduleSelectionCleanup();
  if (automatic) pending = query();
}

function onMainWindowLoad({ window }) {
  if (window.MozXULElement) {
    window.MozXULElement.insertFTLIfNeeded("vocab-book-ui.ftl");
  }
  readingDashboard?.install(window, { getVocabList, getWordsForPaper, openWordLocation });
}

function onMainWindowUnload({ window }) {
  if (activePronunciation?.owner === window) stopPronunciation();
  readingDashboard?.uninstall(window);
  window.document.querySelector('[href="vocab-book-ui.ftl"]')?.remove();
}

function shutdown() {
  stopPronunciation();
  readingDashboard?.shutdown();
  readingDashboard = null;
  if (registeredSectionID) {
    Zotero.ItemPaneManager.unregisterSection(registeredSectionID);
    registeredSectionID = null;
  }
  if (registeredPreferencesID) {
    Zotero.PreferencePanes.unregister(registeredPreferencesID);
    registeredPreferencesID = null;
  }
  delete Zotero.VocabBook;
  for (const state of activeSidebarContainers) state.resizeObserver?.disconnect();
  activeSidebarContainers.clear();
}
