const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PREF_READING = 'extensions.vocabbook.readingProgress';
const source = fs.readFileSync('reading-dashboard.js', 'utf8');
function paper(id, key = `KEY${id}`, libraryID = 1) {
  return { id, key, libraryID, getDisplayTitle: () => `Paper ${id}`,
    isNote: () => false, isAnnotation: () => false, isRegularItem: () => true };
}
function harness(items = [paper(1)], words = []) {
  const prefs = new Map();
  const doms = [];
  const opened = [];
  const context = vm.createContext({
    Zotero: {
      Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      Items: { get: id => items.find(item => item.id === id) },
    },
  });
  vm.runInContext(source, context);
  const api = context.VocabBookReadingDashboard;
  function makeWindow(list = items) {
    const dom = new JSDOM('<!doctype html><div id="zotero-items-pane-container"><div id="zotero-toolbar-item-tree"><div id="zotero-items-toolbar"><button>Existing</button><spacer flex="1"></spacer></div></div><div id="zotero-items-pane"></div></div>');
    doms.push(dom);
    dom.window.ZoteroPane = { itemsView: { getSortedItems: () => list } };
    api.install(dom.window, { getVocabList: () => words, openWordLocation: entry => opened.push(entry) });
    return dom;
  }
  const dom = makeWindow();
  return { api, context, prefs, dom, makeWindow, opened, doms };
}
function open(dom) { dom.window.document.getElementById('vocab-book-reading-button').click(); }
const buttons = dom => [...dom.window.document.querySelectorAll('#vocab-book-reading-panel button')];
function button(dom, text) { return buttons(dom).find(element => element.textContent.includes(text)); }
function records(prefs) { return JSON.parse(prefs.get(PREF_READING)).records; }

test('reading toolbar toggles a scrolling panel from the current filtered item list', () => {
  const root = paper(1);
  const attachment = { id: 2, key: 'ATTACH', libraryID: 1, parentItemID: 1, isNote: () => false };
  const note = { id: 3, isNote: () => true };
  const { dom, prefs, api } = harness([root, attachment, note]);
  const doc = dom.window.document;
  const entry = doc.getElementById('vocab-book-reading-button');
  assert.equal(entry.nextElementSibling.localName, 'spacer');
  assert.equal(entry.getAttribute('aria-expanded'), 'false');
  open(dom);
  assert.match(doc.body.textContent, /当前列表 1 篇 · 已读 0 篇/);
  assert.equal(doc.querySelectorAll('article').length, 1);
  assert.equal(doc.querySelector('[aria-label="当前文献的阅读记录"]').style.overflowY, 'auto');
  assert.equal(prefs.size, 0);
  api.install(dom.window, {});
  assert.equal(doc.querySelectorAll('#vocab-book-reading-button').length, 1);
  button(dom, '收起').click();
  assert.equal(doc.getElementById('vocab-book-reading-panel').hidden, true);
});

test('read flags are scoped by library and item key, and preserve saved notes', () => {
  const { dom, prefs } = harness([paper(1, 'SAME', 1), paper(2, 'SAME', 2)]);
  prefs.set(PREF_READING, JSON.stringify({ version: 1, records: { '1/SAME': { note: 'Existing note' } } }));
  open(dom);
  const readButtons = buttons(dom).filter(element => element.getAttribute('aria-label')?.includes('切换已读状态'));
  readButtons[0].click();
  assert.equal(records(prefs)['1/SAME'].read, true);
  assert.equal(records(prefs)['1/SAME'].note, 'Existing note');
  assert.equal(records(prefs)['2/SAME'], undefined);
  assert.match(dom.window.document.body.textContent, /已读 1 篇/);
  assert.equal(readButtons[0].style.getPropertyPriority('color'), 'important');
  assert.equal(readButtons[0].style.color, 'rgb(255, 255, 255)');
  readButtons[0].click();
  assert.equal(records(prefs)['1/SAME'].read, false);
});

test('note edits require explicit saving and survive refreshing the current list as drafts', () => {
  const { dom, prefs } = harness();
  open(dom);
  let note = dom.window.document.querySelector('textarea');
  note.value = 'An interesting explanation <script>unsafe</script>';
  note.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(prefs.size, 0);
  assert.match(dom.window.document.body.textContent, /有未保存的修改/);
  button(dom, '刷新当前列表').click();
  note = dom.window.document.querySelector('textarea');
  assert.equal(note.value, 'An interesting explanation <script>unsafe</script>');
  button(dom, '保存笔记').click();
  assert.equal(records(prefs)['1/KEY1'].note, note.value);
  assert.equal(dom.window.document.querySelector('script'), null);
  assert.match(dom.window.document.body.textContent, /笔记已保存到本机/);
});

test('vocabulary preview uses each paper’s own matching source location', async () => {
  const words = [
    { word: 'alpha', meaning: '释义', itemID: 5, attachmentID: 6,
      locations: [{ itemID: 1, attachmentID: 2, pageIndex: 7, position: { rects: [[1, 2, 3, 4]] } }] },
    { word: '<beta>', meaning: '<script>text</script>', itemID: 1, pageIndex: 3 },
    { word: 'elsewhere', itemID: 999 },
  ];
  const { dom, opened } = harness([paper(1)], words);
  open(dom);
  assert.match(dom.window.document.querySelector('summary').textContent, /2 词/);
  button(dom, 'alpha —').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened[0].itemID, 1);
  assert.equal(opened[0].attachmentID, 2);
  assert.equal(opened[0].pageIndex, 7);
  assert.deepEqual(opened[0].position, words[0].locations[0].position);
  assert.equal(dom.window.document.querySelector('script'), null);
  assert.match(dom.window.document.body.textContent, /<beta>/);
  assert.doesNotMatch(dom.window.document.body.textContent, /elsewhere/);
});

test('preview prefers exact PDF sources over manual sources and newest sources within the same quality', async () => {
  const manual = { itemID: 1, attachmentID: null, contextSentence: 'manual' };
  const exact = { itemID: 1, attachmentID: 10, pageIndex: 3, position: { rects: [[0, 1, 2, 3]] } };
  const latestExact = { itemID: 1, attachmentID: 11, pageIndex: 7, position: { rects: [[1, 2, 3, 4]] } };
  const page = { itemID: 1, attachmentID: 12, pageIndex: 9, position: null };
  const words = [
    { word: 'manual-first', itemID: 1, locations: [manual, exact, page] },
    { word: 'page-first', itemID: 1, locations: [page, manual] },
    { word: 'newest-exact', itemID: 1, locations: [exact, latestExact] },
    { word: 'manual-only', itemID: 1, locations: [manual, { ...manual, contextSentence: 'latest manual' }] },
  ];
  const { dom, opened } = harness([paper(1)], words);
  open(dom);
  for (const word of words) button(dom, `${word.word} —`).click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened[0].attachmentID, 10);
  assert.equal(opened[0].pageIndex, 3);
  assert.equal(opened[1].attachmentID, 12);
  assert.equal(opened[2].attachmentID, 11);
  assert.equal(opened[2].pageIndex, 7);
  assert.equal(opened[3].contextSentence, 'latest manual');
});

test('corrupt reading records are preserved and reported rather than replaced', () => {
  const { dom, prefs } = harness();
  prefs.set(PREF_READING, '{broken');
  open(dom);
  assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /格式错误/);
  assert.equal(prefs.get(PREF_READING), '{broken');
  assert.equal(dom.window.document.querySelector('textarea'), null);
});

test('read flags update other open windows and notes do not overwrite other records', () => {
  const { dom, makeWindow, prefs } = harness([paper(1), paper(2)]);
  const second = makeWindow();
  open(dom); open(second);
  button(dom, '未读').click();
  assert.equal(button(second, '已读').getAttribute('aria-pressed'), 'true');
  const notes = second.window.document.querySelectorAll('textarea');
  notes[1].value = 'Second paper note';
  notes[1].dispatchEvent(new second.window.Event('input'));
  buttons(second).filter(element => element.textContent === '保存笔记')[1].click();
  assert.equal(records(prefs)['1/KEY1'].read, true);
  assert.equal(records(prefs)['1/KEY2'].note, 'Second paper note');
});

test('closing a window and plugin shutdown remove every installed element', () => {
  const { dom, api, makeWindow } = harness();
  const second = makeWindow();
  dom.window.dispatchEvent(new dom.window.Event('unload'));
  assert.equal(dom.window.document.getElementById('vocab-book-reading-button'), null);
  api.shutdown();
  assert.equal(second.window.document.getElementById('vocab-book-reading-panel'), null);
  assert.equal(second.window.document.querySelector('#zotero-items-toolbar button').textContent, 'Existing');
});

test('native XUL toolbar entry responds to command and injected paper-word resolver', () => {
  const { dom, api } = harness([paper(1)]);
  api.uninstall(dom.window);
  dom.window.document.createXULElement = name => dom.window.document.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', name);
  let requestedID;
  api.install(dom.window, {
    getVocabList: () => [],
    getWordsForPaper: (words, id) => { requestedID = id; return [{ word: 'injected', meaning: '词义' }]; },
  });
  const entry = dom.window.document.getElementById('vocab-book-reading-button');
  entry.dispatchEvent(new dom.window.Event('command'));
  assert.equal(requestedID, 1);
  assert.equal(entry.getAttribute('aria-expanded'), 'true');
  assert.match(dom.window.document.querySelector('article').textContent, /injected — 词义/);
});
