const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { FluentBundle, FluentResource } = require('@fluent/bundle');
const { DOMLocalization } = require('@fluent/dom');

function harness(words = []) {
  const dom = new JSDOM('<!doctype html><div id="body"></div>');
  const prefs = new Map([['extensions.vocabbook.words', JSON.stringify(words)]]);
  let hooks;
  const context = vm.createContext({
    TextEncoder, setTimeout, clearTimeout, console,
    Zotero: {
      Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      debug() {}, initializationPromise: Promise.resolve(), getMainWindows: () => [],
      Items: { get: () => null },
      PreferencePanes: { register: async options => options.id, unregister() {} },
      HTTP: { request: async () => ({ response: { trans_result: [{ dst: '测试' }] } }) },
      ItemPaneManager: { registerSection: options => { hooks = options; return 'test-pane'; }, unregisterSection() {} },
      Reader: { registerEventListener() {} },
    },
  });
  vm.runInContext(fs.readFileSync('bootstrap.js', 'utf8'), context);
  const state = { body: dom.window.document.querySelector('#body'), item: null,
    onlyCurrentPaper: false, viewMode: 'list', masteryFilter: -1, sortBy: 'date',
    searchQuery: '', flashcardIndex: 0, flashcardFlipped: false };
  context.activeSidebarContainers.add(state);
  context.renderSidebarContent(state);
  return { context, state, prefs, dom, hooks: () => hooks };
}
const word = (value, mastery = 0) => ({ word: value, meaning: '释义', mastery });
const button = (body, text) => [...body.querySelectorAll('button')].find(b => b.textContent.includes(text));

for (const locale of ['zh-CN', 'en-US']) {
  test(`Fluent ${locale} preserves the section body and icon children`, async () => {
    const { dom, state } = harness();
    const doc = dom.window.document;
    const section = doc.createElement('section');
    section.dataset.l10nId = 'vocab-book-section-header';
    section.setAttribute('data-l10n-attrs', 'label');
    doc.body.append(section);
    section.append(state.body);
    const nav = doc.createElement('button');
    nav.dataset.l10nId = 'vocab-book-section-sidenav';
    nav.setAttribute('data-l10n-attrs', 'tooltiptext');
    const icon = doc.createElement('img'); nav.append(icon); doc.body.append(nav);
    const bundle = new FluentBundle(locale);
    assert.deepEqual(bundle.addResource(new FluentResource(fs.readFileSync(`locale/${locale}/vocab-book-ui.ftl`, 'utf8'))), []);
    const l10n = new DOMLocalization([], function* () { yield bundle; });
    l10n.connectRoot(doc.documentElement);
    await l10n.translateRoots();
    await l10n.translateRoots();
    assert.equal(section.contains(state.body), true);
    assert.ok(button(state.body, '闪卡背词'));
    assert.ok(section.getAttribute('label'));
    assert.equal(nav.firstChild, icon);
    assert.equal(nav.textContent, '');
    l10n.disconnectRoot(doc.documentElement);
  });
}

test('empty library exposes study controls without sidebar settings or help', () => {
  const { state } = harness();
  for (const label of ['查词入库', '闪卡背词', '导出 Anki']) assert.ok(button(state.body, label));
  assert.match(state.body.textContent, /还没有生词/);
  assert.equal(button(state.body, '⚙️'), undefined);
  assert.equal(button(state.body, '❓'), undefined);
});

test('filtering a reviewed card out does not skip its successor', () => {
  const { context, state } = harness(['alpha', 'beta', 'gamma'].map(w => word(w)));
  Object.assign(state, { viewMode: 'flashcard', masteryFilter: 0, flashcardFlipped: true });
  context.renderSidebarContent(state);
  button(state.body, '掌握').click();
  assert.match(state.body.textContent, /beta/);
  assert.equal(state.flashcardFlipped, false);
});

test('search and manual add update the visible list', async () => {
  const { context, state } = harness([word('alpha'), word('beta')]);
  state.searchQuery = 'beta'; context.renderSidebarContent(state);
  assert.equal(state.body.querySelectorAll('strong').length, 1);
  assert.equal(state.body.querySelector('strong').textContent, 'beta');
  state.searchQuery = ''; context.renderSidebarContent(state);
  state.body.querySelector('input').value = 'gamma';
  button(state.body, '查词入库').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.getVocabList()[0].word, 'gamma');
  assert.match(state.body.textContent, /gamma/);
});

test('existing credentials are preserved and missing credentials stay unset', () => {
  const { context, prefs } = harness();
  assert.equal(context.getBaiduCredentials().raw, '');
  assert.equal(prefs.has('extensions.vocabbook.baiduKey'), false);
  prefs.set('extensions.vocabbook.baiduKey', 'test-app#test-secret');
  assert.equal(context.getBaiduCredentials().secret, 'test-secret');
});

test('invalid stored data is not silently overwritten', () => {
  const { context, prefs, state } = harness();
  prefs.set('extensions.vocabbook.words', '{invalid');
  context.renderSidebarContent(state);
  assert.ok(state.body.querySelector('[role="alert"]'));
  assert.throws(() => context.addOrUpdateWord({ word: 'new' }));
  assert.equal(prefs.get('extensions.vocabbook.words'), '{invalid');
});

test('destroy releases sidebar state and item changes restore enabled state', async () => {
  const { context, state, hooks } = harness();
  await context.startup({});
  let enabled;
  hooks().onItemChange({ item: { id: 1 }, setEnabled: value => enabled = value });
  assert.equal(enabled, true);
  hooks().onDestroy({ body: state.body });
  assert.equal(context.activeSidebarContainers.size, 0);
});

test('export escapes HTML and MD5 handles UTF-8', () => {
  const { context } = harness();
  assert.equal(context.escapeExportHTML('<script>&'), '&lt;script&gt;&amp;');
  assert.equal(context.md5('中文'), require('node:crypto').createHash('md5').update('中文').digest('hex'));
});

test('batch tokens preserve hyphens and contractions and remove duplicates', () => {
  const { context } = harness();
  assert.deepEqual(Array.from(context.extractWords("To side-step, namely: side-step. Don't don't")), ['To', 'side-step', 'namely', "Don't"]);
});

test('batch collection saves separate entries with shared context and retries only failures', async () => {
  const { context } = harness([word('old')]);
  const shared = { contextSentence: 'We side-step this, namely uncertainty.', contextTrans: '例句译文', itemID: 3, attachmentID: 4, pageIndex: 8 };
  const options = { delay: async () => {}, lookup: async value => ({ ok: value !== 'namely', combinedMeaning: '独立释义' }) };
  const result = await context.collectWords(['side-step', 'namely', 'SIDE-STEP'], shared, options);
  assert.equal(result.saved.length, 1);
  assert.equal(result.failed[0], 'namely');
  assert.equal(context.getVocabList().length, 2);
  const entry = context.getVocabList()[0];
  for (const [key, value] of Object.entries(shared)) assert.equal(entry[key], value);
  assert.equal(entry.meaning, '独立释义');
  options.lookup = async () => ({ ok: true, combinedMeaning: '即' });
  await context.collectWords(result.failed, shared, options);
  assert.equal(context.getVocabList().length, 3);
  assert.equal(context.getVocabList()[0].word, 'namely');
});

test('picker awaits sentence translation, saves chosen words and retains failures', async () => {
  const { context, dom } = harness();
  const box = dom.window.document.createElement('div');
  let release;
  let received;
  context.collectWords = async (words, shared) => {
    received = { words: Array.from(words), shared };
    return { saved: ['side-step'], failed: ['namely'] };
  };
  const ready = new Promise(resolve => { release = resolve; });
  context.appendWordPicker(dom.window.document, box, 'We side-step, namely this problem.', () => ({ contextTrans: '译文' }), ready);
  button(box, 'side-step').click(); button(box, 'namely').click();
  const save = button(box, '加入 2'); save.click();
  assert.equal(received, undefined);
  assert.equal(save.disabled, true);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received.words, ['side-step', 'namely']);
  assert.equal(received.shared.contextTrans, '译文');
  assert.equal(button(box, 'side-step').getAttribute('aria-pressed'), 'false');
  assert.equal(button(box, 'namely').getAttribute('aria-pressed'), 'true');
  assert.match(box.querySelector('[role=status]').textContent, /未保存：namely/);
});

test('preferences load existing credentials, validate edits and save options without touching words', () => {
  const { context, prefs } = harness([word('old')]);
  const dom = new JSDOM(fs.readFileSync('preferences.xhtml', 'utf8'), { contentType: 'application/xhtml+xml' });
  prefs.set('extensions.vocabbook.baiduKey', '123#existing-secret');
  context.document = dom.window.document;
  context.window = dom.window;
  context.Zotero.VocabBook = { getBaiduCredentials: context.getBaiduCredentials, translateWithBaidu: context.translateWithBaidu };
  vm.runInContext(fs.readFileSync('preferences.js', 'utf8'), context);
  dom.window.VocabBookPreferences.init();
  const get = id => dom.window.document.getElementById(id);
  assert.equal(get('vocab-secret').value, 'existing-secret');
  assert.equal(get('vocab-secret').type, 'password');
  get('vocab-appid').value = 'invalid'; get('vocab-save').click();
  assert.equal(prefs.get('extensions.vocabbook.baiduKey'), '123#existing-secret');
  get('vocab-appid').value = '456'; get('vocab-save').click();
  assert.equal(prefs.get('extensions.vocabbook.baiduKey'), '456#existing-secret');
  get('vocab-popup').checked = false;
  get('vocab-popup').dispatchEvent(new dom.window.Event('change'));
  assert.equal(prefs.get('extensions.vocabbook.selectionPopup'), false);
  assert.equal(context.getVocabList()[0].word, 'old');
});

test('a newly opened sidebar defaults to the current paper', async () => {
  const { context, dom, hooks } = harness([ { ...word('alpha'), itemID: 9 }, { ...word('beta'), itemID: 10 } ]);
  await context.startup({});
  const body = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(body);
  hooks().onRender({ body, item: { id: 9, isRegularItem: () => true, getField: () => 'Paper A' } });
  assert.ok(button(body, '当前文献'));
  assert.equal(body.querySelectorAll('strong').length, 1);
  assert.equal(body.querySelector('strong').textContent, 'alpha');
});

test('one word retains sources in two papers and manual corrections survive a new lookup', () => {
  const { context } = harness();
  context.addOrUpdateWord({ word: 'evidence', meaning: '原释义', itemID: 9, attachmentID: 90, pageIndex: 3 });
  context.updateWordMeaning('evidence', '人工纠正');
  context.addOrUpdateWord({ word: 'evidence', meaning: '机器翻译', itemID: 10, attachmentID: 100, pageIndex: 7 });
  const entries = context.getVocabList();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].meaning, '人工纠正');
  assert.equal(context.getWordsForPaper(entries, 9)[0].pageIndex, 3);
  assert.equal(context.getWordsForPaper(entries, 10)[0].pageIndex, 7);
});

test('a manual add in another paper cannot inherit the previous paper PDF location', () => {
  const { context } = harness();
  context.addOrUpdateWord({ word: 'evidence', sourceTitle: 'Paper A', itemID: 9, attachmentID: 90, pageIndex: 3,
    position: { pageIndex: 3, rects: [[1, 2, 3, 4]] }, contextSentence: 'Original context' });
  context.addOrUpdateWord({ word: 'evidence', sourceTitle: 'Paper B', itemID: 10 });
  const entry = context.getVocabList()[0];
  assert.equal(entry.source, 'Paper B');
  assert.equal(entry.attachmentID, null);
  assert.equal(entry.position, null);
  assert.equal(entry.contextSentence, '');
  assert.equal(context.getWordsForPaper([entry], 9)[0].attachmentID, 90);
});

test('paper vocabulary prefers a precise PDF source over an earlier manual addition', () => {
  const { context } = harness();
  context.addOrUpdateWord({ word: 'evidence', itemID: 9 });
  context.addOrUpdateWord({ word: 'evidence', itemID: 9, attachmentID: 90, pageIndex: 3,
    position: { pageIndex: 3, rects: [[1, 2, 3, 4]] } });
  const entry = context.getWordsForPaper(context.getVocabList(), 9)[0];
  assert.equal(entry.attachmentID, 90);
  assert.equal(entry.pageIndex, 3);
});

test('meaning editor saves corrected text and cancel keeps the stored definition', () => {
  const { context, state } = harness([word('evidence')]);
  button(state.body, '修改释义').click();
  state.body.querySelector('textarea').value = '证据；依据';
  button(state.body, '保存释义').click();
  assert.equal(context.getVocabList()[0].meaning, '证据；依据');
  button(state.body, '修改释义').click();
  state.body.querySelector('textarea').value = '不保存';
  button(state.body, '取消').click();
  assert.equal(context.getVocabList()[0].meaning, '证据；依据');
});

test('PDF word position distinguishes repeated words by the original selection', () => {
  const { context } = harness();
  const chars = [...'alpha beta alpha'].map((u, i) => ({ u, rect: [i * 5, 10, i * 5 + 5, 20] }));
  const position = context.findWordPosition(chars, 'alpha', 4, [[55, 10, 80, 20]]);
  assert.equal(position.pageIndex, 4);
  assert.equal(position.rects[0][0], 55);
  assert.equal(position.rects.length, 5);
  assert.equal(context.findWordPosition(chars, 'alp', 4), null);
});

test('source navigation highlights the precise word instead of only opening its page', async () => {
  const { context } = harness();
  let target;
  const chars = [...'alpha beta'].map((u, i) => ({ u, rect: [i * 5, 10, i * 5 + 5, 20] }));
  context.Zotero.Reader.open = async () => ({
    _internalReader: { _primaryView: { _pdfPages: [{ chars }], _ensureBasicPageData: async () => {} } },
    navigate: async location => { target = location; },
  });
  await context.openWordLocation({ word: 'beta', attachmentID: 30, pageIndex: 0 });
  assert.equal(target.position.rects[0][0], 30);
});

test('auto-translation off makes no selection request, but explicit collection saves a meaning', async () => {
  const { context, prefs, dom } = harness();
  prefs.set('extensions.vocabbook.autoTranslate', false);
  let requests = 0;
  context.Zotero.HTTP.request = async () => { requests++; return {response:{ec:{word:[{trs:[{tr:[{l:{i:['证据']}}]}]}]}}}; };
  const text = 'alpha beta gamma delta evidence '.repeat(50);
  let popup;
  await context.renderSelectionPopup({ reader: { itemID: 30 }, doc: dom.window.document,
    params: { annotation: { text, position: { pageIndex: 3, rects: [[1, 2, 3, 4]] } } }, append: node => { popup = node; } }, {delay:async()=>{}});
  assert.equal(requests, 0);
  const dropdown = popup.querySelector('[aria-controls]');
  const panel = popup.querySelector('#'+dropdown.getAttribute('aria-controls'));
  assert.equal(panel.hidden, true);
  assert.equal(popup.querySelector('[aria-label="翻译选区"]').textContent, '');
  dropdown.click();
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.overflowY, 'auto');
  assert.match(popup.style.maxHeight, /60vh/);
  const picker = popup.querySelector('[data-vocab-word-picker]');
  button(picker, 'evidence').click();
  button(picker, '加入 1').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(context.getVocabList()[0].meaning, '证据');
  assert.equal(context.getVocabList()[0].contextSentence, text.trim());
  assert.equal(context.getVocabList()[0].pageIndex, 3);
  dropdown.click();
  assert.equal(panel.hidden, true);
});

test('flashcard selected and answer buttons keep explicit contrasting theme colors', () => {
  const { context, state } = harness([word('evidence')]);
  state.viewMode = 'flashcard'; context.renderSidebarContent(state);
  for (const text of ['退出闪卡', '显示释义']) {
    const control = button(state.body, text);
    assert.equal(control.style.getPropertyPriority('background-color'), 'important');
    assert.equal(control.style.getPropertyPriority('color'), 'important');
    assert.equal(control.style.color, 'rgb(255, 255, 255)');
    assert.equal(control.style.backgroundColor, 'rgb(111, 66, 193)');
  }
});

test('short selection still offers pronunciation while automatic translation is off', async () => {
  const { context, prefs, dom } = harness();
  prefs.set('extensions.vocabbook.autoTranslate', false);
  let spoken;
  context.playAudio = (doc, value) => { spoken = value; };
  let popup;
  await context.renderSelectionPopup({ reader: {}, doc: dom.window.document,
    params: { annotation: { text: 'evidence' } }, append: value => { popup = value; } });
  popup.querySelector('[aria-controls]').click();
  popup.querySelector('[aria-label="播放 evidence 的发音"]').click();
  assert.equal(spoken, 'evidence');
});

test('word position on the next selected page also updates the displayed page number', () => {
  const { context } = harness();
  context.addOrUpdateWord({ word: 'evidence', itemID: 9, attachmentID: 90, pageIndex: 3,
    position: { pageIndex: 4, rects: [[1, 2, 3, 4]] } });
  assert.equal(context.getVocabList()[0].pageIndex, 4);
  assert.equal(context.getWordsForPaper(context.getVocabList(), 9)[0].pageIndex, 4);
});


async function popupFor(h, text, options = {}, reader = {}) {
  let popup;
  await h.context.renderSelectionPopup({ reader, doc: h.dom.window.document,
    params: { annotation: { text, position: { pageIndex: 0, rects: [[0, 0, 1000, 30]] } } }, append: node => { popup = node; } },
    { delay: async () => {}, ...options });
  return popup;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('collecting a single word with auto-translation off queries on save, including an empty legacy meaning', async () => {
  const h = harness([{word:'evidence',meaning:''}]);
  h.prefs.set('extensions.vocabbook.autoTranslate',false);
  let queried=0;
  const popup=await popupFor(h,'evidence',{lookup:async()=>{queried++;return {ok:true,combinedMeaning:'证据'};}});
  assert.equal(queried,0);
  popup.querySelector('[aria-controls]').click();
  const picker=popup.querySelector('[data-vocab-word-picker]');
  button(picker,'加入 1').click(); await tick();
  assert.equal(queried,1);
  assert.equal(h.context.getVocabList()[0].meaning,'证据');
  assert.equal(h.context.getVocabList()[0].meaningPending,false);
  assert.match(h.state.body.textContent,/证据/);
});

test('manual translation results are reused when collecting instead of being discarded', async () => {
  const h=harness();h.prefs.set('extensions.vocabbook.autoTranslate',false);
  let queried=0;
  const popup=await popupFor(h,'evidence',{lookup:async()=>{queried++;return {ok:true,combinedMeaning:'证据'};}});
  popup.querySelector('[aria-label="翻译选区"]').click(); await tick();
  popup.querySelector('[aria-controls]').click();
  button(popup.querySelector('[data-vocab-word-picker]'),'加入 1').click();await tick();
  assert.equal(queried,1);
  assert.equal(h.context.getVocabList()[0].meaning,'证据');
});

test('a phrase is formed by contiguous token positions and saved as one entry with precise geometry', async () => {
  const h=harness();h.prefs.set('extensions.vocabbook.autoTranslate',false);
  const text='we learn in terms of evidence in practice';
  const chars=[...text].map((u,i)=>({u,rect:[i*5,10,i*5+5,20]}));
  const reader={itemID:30,_internalReader:{_primaryView:{_pdfPages:[{chars}],_ensureBasicPageData:async()=>{}}}};
  let query;
  const popup=await popupFor(h,text,{lookup:async word=>{query=word;return {ok:true,combinedMeaning:'就……而言'};}},reader);
  popup.querySelector('[aria-controls]').click();button(popup,'词组').click();
  const phrase=popup.querySelector('[data-vocab-phrase-picker]');
  phrase.querySelector('[data-phrase-index="2"]').click();
  phrase.querySelector('[data-phrase-index="4"]').click();
  assert.equal(phrase.querySelector('[aria-label="要收录的词组"]').value,'in terms of');
  button(phrase,'收录词组').click();await tick();
  const entry=h.context.getVocabList()[0];
  assert.equal(query,'in terms of');assert.equal(entry.word,'in terms of');
  assert.equal(entry.meaning,'就……而言');assert.equal(entry.contextSentence,text);
  assert.equal(entry.position.rects[0][0],text.indexOf('in terms of')*5);
  assert.equal(h.context.getVocabList().length,1);
});

test('phrase range handles repeated words, reverse endpoints and editable manual meanings without requests', async () => {
  const h=harness();h.prefs.set('extensions.vocabbook.autoTranslate',false);
  const popup=await popupFor(h,'in theory and in terms of data',{lookup:async()=>{throw new Error('must not query');}});
  popup.querySelector('[aria-controls]').click();button(popup,'词组').click();
  const phrase=popup.querySelector('[data-vocab-phrase-picker]');
  phrase.querySelector('[data-phrase-index="5"]').click();
  phrase.querySelector('[data-phrase-index="3"]').click();
  const input=phrase.querySelector('[aria-label="要收录的词组"]');
  assert.equal(input.value,'in terms of');
  input.value='in terms of data';input.dispatchEvent(new h.dom.window.Event('input'));
  assert.equal(phrase.querySelectorAll('[aria-pressed="true"]').length,0);
  phrase.querySelector('[aria-label="词组手动释义"]').value='从数据角度';
  button(phrase,'收录词组').click();await tick();
  const entry=h.context.getVocabList()[0];
  assert.equal(entry.word,'in terms of data');assert.equal(entry.meaning,'从数据角度');
  assert.equal(entry.meaningEdited,true);
});

test('failed lookups save an explicit pending meaning and support repairing the old entry', async () => {
  const h=harness();h.prefs.set('extensions.vocabbook.autoTranslate',false);
  const popup=await popupFor(h,'evidence',{lookup:async()=>{throw new Error('offline');}});
  popup.querySelector('[aria-controls]').click();
  const picker=popup.querySelector('[data-vocab-word-picker]');
  button(picker,'加入 1').click();await tick();
  let entry=h.context.getVocabList()[0];
  assert.equal(entry.meaning,'待补充释义');assert.equal(entry.meaningPending,true);
  assert.match(picker.textContent,/待补充释义/);
  h.context.fetchWordRichInfo=async()=>({ok:true,combinedMeaning:'依据',phonetic:'/test/'});
  button(h.state.body,'补查释义').click();await tick();
  entry=h.context.getVocabList()[0];
  assert.equal(entry.meaning,'依据');assert.equal(entry.meaningPending,false);
  assert.equal(entry.contextSentence,'evidence');
  assert.equal(button(h.state.body,'补查释义'),undefined);
});

test('late meaning repair cannot replace a manual correction made while the lookup is running', async () => {
  const h=harness([{word:'evidence',meaning:''}]);
  let release;
  h.context.fetchWordRichInfo=()=>new Promise(resolve=>{release=resolve;});
  button(h.state.body,'补查释义').click();
  h.context.updateWordMeaning('evidence','人工纠正');
  release({ok:true,combinedMeaning:'机器释义'});await tick();
  assert.equal(h.context.getVocabList()[0].meaning,'人工纠正');
});

test('a successful stored definition is retained if an empty lookup is saved later', () => {
  const h=harness([{word:'evidence',meaning:'证据'}]);
  h.context.addOrUpdateWord({word:'evidence',meaning:'暂无释义',itemID:9});
  assert.equal(h.context.getVocabList()[0].meaning,'证据');
  assert.equal(h.context.getVocabList()[0].meaningPending,false);
});


function audioHarness(options = {}) {
  const h = harness();
  const revoked = [], created = [], requests = [];
  class FakeAudio extends h.dom.window.EventTarget {
    constructor() { super(); this.paused=true;created.push(this); }
    play() {
      this.paused=false;
      if(options.reject) return Promise.reject(new Error('decoder rejected'));
      queueMicrotask(()=>{
        this.dispatchEvent(new h.dom.window.Event('playing'));
        if(options.end !== false) this.dispatchEvent(new h.dom.window.Event('ended'));
      });
      return Promise.resolve();
    }
    pause() { this.paused=true; }
    removeAttribute() {}
    load() {}
  }
  h.context.Zotero.getMainWindow=()=>({Audio:FakeAudio,Blob,URL:{
    createObjectURL:()=>`blob:test-${created.length}`,revokeObjectURL:value=>revoked.push(value),
  }});
  h.dom.window.Audio=function(){throw new Error('reader media must not be used');};
  h.context.Zotero.HTTP.request=async(method,url,config)=>{
    requests.push({method,url,config});
    return {response:new Uint8Array([0x49,0x44,0x33,0,1,2]).buffer};
  };
  return {...h,created,revoked,requests};
}

test('pronunciation plays a retained audio blob in the main window and releases it on completion', async () => {
  const h=audioHarness(), phases=[];
  const promise=h.context.playAudio(h.dom.window.document,'in terms of',(phase)=>phases.push(phase));
  assert.equal(await promise,true);
  assert.deepEqual(phases,['loading','playing','ended']);
  assert.equal(h.requests[0].config.responseType,'arraybuffer');
  assert.match(h.requests[0].url,/audio=in%20terms%20of/);
  assert.equal(h.created[0].muted,false);assert.equal(h.created[0].volume,1);
  assert.equal(h.created[0].paused,true);assert.equal(h.revoked.length,1);
  assert.equal(h.context.activePronunciation,null);
});

test('audio download and decoder failures produce visible retry feedback', async () => {
  for(const failure of ['network','invalid','decoder']) {
    const h=audioHarness({reject:failure==='decoder'});
    if(failure==='network')h.context.Zotero.HTTP.request=async()=>{throw new Error('offline');};
    if(failure==='invalid')h.context.Zotero.HTTP.request=async()=>({response:new TextEncoder().encode('<html>Not audio</html>').buffer});
    const doc=h.dom.window.document,control=doc.createElement('button'),container=doc.createElement('div');container.append(control);
    const feedback=h.context.bindAudioControl(doc,control,'opaque',container);
    control.click();await tick();
    assert.equal(control.dataset.audioState,'error',failure);
    assert.equal(feedback.hidden,false);assert.match(feedback.textContent,/失败|重试/);
    assert.equal(control.getAttribute('aria-busy'),'false');
    assert.equal(h.context.activePronunciation,null);
  }
});

test('replaying stops the previous audio and unload releases the active player', async () => {
  const h=audioHarness({end:false});
  const first=h.context.playAudio(h.dom.window.document,'first');await tick();
  const second=h.context.playAudio(h.dom.window.document,'second');await tick();
  assert.equal(await first,false);assert.equal(h.created[0].paused,true);
  assert.equal(h.created[1].paused,false);
  h.context.stopPronunciation();assert.equal(await second,false);
  assert.equal(h.created[1].paused,true);assert.equal(h.revoked.length,2);
});

test('cancelled audio downloads cannot start playing after a newer request', async () => {
  const h=audioHarness();let release;
  const original=h.context.Zotero.HTTP.request;
  h.context.Zotero.HTTP.request=(method,url,config)=>url.includes('slow')
    ?new Promise(resolve=>{release=resolve;}):original(method,url,config);
  const first=h.context.playAudio(h.dom.window.document,'slow');
  const second=h.context.playAudio(h.dom.window.document,'fast');
  assert.equal(await second,true);
  release({response:new Uint8Array([0x49,0x44,0x33,0]).buffer});
  assert.equal(await first,false);assert.equal(h.created.length,1);
});

test('popup controls isolate text selection while phrase inputs keep native editing shortcuts', async () => {
  const h=harness();h.prefs.set('extensions.vocabbook.autoTranslate',false);
  const popup=await popupFor(h,'in terms of');h.dom.window.document.body.append(popup);
  let leaked=0;
  h.dom.window.document.body.addEventListener('mousedown',()=>leaked++);
  h.dom.window.document.body.addEventListener('keydown',()=>leaked++);
  popup.querySelector('[aria-controls]').dispatchEvent(new h.dom.window.MouseEvent('mousedown',{bubbles:true}));
  const selectAll=new h.dom.window.KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true});
  popup.querySelector('[aria-controls]').dispatchEvent(selectAll);
  assert.equal(selectAll.defaultPrevented,true);assert.equal(leaked,0);
  popup.querySelector('[aria-controls]').click();
  const input=popup.querySelector('[aria-label="要收录的词组"]');
  const editing=new h.dom.window.KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true});
  input.dispatchEvent(editing);
  assert.equal(editing.defaultPrevented,false);assert.equal(leaked,0);
  assert.equal(input.style.userSelect,'text');
  assert.equal(popup.style.userSelect,'none');
});


test('opening popup clears only an intersecting outer-frame selection, preserving unrelated text ranges', async () => {
  const h=harness();h.prefs.set('extensions.vocabbook.autoTranslate',false);
  const doc=h.dom.window.document,popup=await popupFor(h,'in terms of');
  const source=doc.createElement('p');source.textContent='Original PDF context';doc.body.append(source,popup);
  const selection=h.dom.window.getSelection();
  const range=doc.createRange();range.selectNodeContents(source);selection.addRange(range);
  popup.querySelector('[aria-controls]').click();
  assert.equal(selection.toString(),'Original PDF context');
  const accidental=doc.createRange();accidental.selectNodeContents(popup);
  selection.removeAllRanges();selection.addRange(accidental);
  popup.querySelector('[aria-controls]').click();
  assert.equal(selection.rangeCount,0);
  assert.equal(popup.querySelector('[aria-label="要收录的词组"]').value,'in terms of');
});
