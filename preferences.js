var VocabBookPreferences = {
  init() {
    const doc = document;
    const api = Zotero.VocabBook;
    const credentials = api.getBaiduCredentials();
    doc.getElementById("vocab-appid").value = credentials.appid;
    doc.getElementById("vocab-secret").value = credentials.secret;
    const status = doc.getElementById("vocab-status");
    const save = () => {
      const appid = doc.getElementById("vocab-appid").value.trim();
      const secret = doc.getElementById("vocab-secret").value.trim();
      if ((appid || secret) && (!/^\d+$/.test(appid) || !secret || secret.includes("#"))) {
        status.textContent = "请填写数字 APP ID 和完整密钥；同时留空可清除配置。";
        return false;
      }
      Zotero.Prefs.set("extensions.vocabbook.baiduKey", appid ? `${appid}#${secret}` : "", true);
      status.textContent = "配置已保存。";
      return true;
    };
    doc.getElementById("vocab-save").addEventListener("click", save);
    doc.getElementById("vocab-test").addEventListener("click", async event => {
      if (!save()) return;
      event.target.disabled = true;
      status.textContent = "正在测试连接…";
      try {
        const result = await api.translateWithBaidu("deep learning");
        status.textContent = result.ok ? `连接成功：${result.text}` : result.text;
      } catch (error) {
        status.textContent = "连接失败，请检查网络后重试。";
      } finally {
        event.target.disabled = false;
      }
    });
    for (const [id, key] of [["vocab-popup", "selectionPopup"], ["vocab-auto-translate", "autoTranslate"], ["vocab-dictionary", "dictionary"]]) {
      const input = doc.getElementById(id);
      const pref = `extensions.vocabbook.${key}`;
      input.checked = Zotero.Prefs.get(pref, true) !== false;
      input.addEventListener("change", () => Zotero.Prefs.set(pref, input.checked, true));
    }
  },
};
// Pane scripts run in a sandbox; inline XUL handlers resolve names on the window.
window.VocabBookPreferences = VocabBookPreferences;
