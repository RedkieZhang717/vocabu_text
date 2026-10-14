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

test('empty library still exposes search, add, review, settings and help', () => {
  const { state } = harness();
  for (const label of ['查词入库', '闪卡背词', '导出 Anki', '⚙️', '❓']) assert.ok(button(state.body, label));
  assert.match(state.body.textContent, /还没有生词/);
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
