'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { File } = require('node:buffer');
const { webcrypto } = require('node:crypto');
const { loadFunctionsFromHtml, formatCaseLine, assertUniqueHtmlIds, assertIconButtonsAccessible, classifyBrowserFailure, createCdpClient, createFakeClock, waitForCondition } = require('./test_utils');

const html = fs.readFileSync(path.join(__dirname, '..', 'hitohira.html'), 'utf8');
const spec = fs.readFileSync(path.join(__dirname, '..', 'docs', 'SPECIFICATION.md'), 'utf8');
const issueTable = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ISSUES.md'), 'utf8');
const knowledgeTable = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DEVELOPMENT_KNOWLEDGE.md'), 'utf8');
const docsIndex = fs.readFileSync(path.join(__dirname, '..', 'docs', 'README.md'), 'utf8');
const testingGuide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'TESTING.md'), 'utf8');
const decisions = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DECISIONS.md'), 'utf8');
const requirements = fs.readFileSync(path.join(__dirname, '..', 'docs', 'REQUIREMENTS.md'), 'utf8');
const identifierConventions = fs.readFileSync(path.join(__dirname, '..', 'docs', 'IDENTIFIERS.md'), 'utf8');
const terminology = fs.readFileSync(path.join(__dirname, '..', 'docs', 'TERMINOLOGY.md'), 'utf8');
const testSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'novel-viewer-tests', 'SKILL.md'), 'utf8');
const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const japaneseReadme = fs.readFileSync(path.join(__dirname, '..', 'readme', 'ja', 'README.md'), 'utf8');
const englishReadme = fs.readFileSync(path.join(__dirname, '..', 'readme', 'en', 'README.md'), 'utf8');
const tests = [];
const test = (suite, name, run) => tests.push({ suite, name, run });
const localizationDictionary = JSON.parse(html.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const defaultTranslate = (key, values = {}) => (localizationDictionary.ja[key] ?? key).replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(values[name] ?? ''));
const load = (names, globals = {}) => {
  const dependencies = {
    translate: defaultTranslate,
    currentLanguage: 'ja',
    applyLanguage() {},
    supportsVerticalWriting: true,
    resolveBrowserLanguage: languages => [...(Array.isArray(languages) ? languages : [languages])].find(language => typeof language === 'string' && /^(?:en|ja)(?:-|$)/i.test(language))?.slice(0, 2).toLowerCase() || 'ja',
    MEDIA_TRANSACTION_KEY: '__pending_transaction__',
    MEDIA_STORE_KEY: 'current',
    TEXT_STORE_KEY: 'current_text',
    STORAGE_KEYS: {
      SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position',
      BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content'
    },
    SAVED_DATA_JOURNAL_KEY: 'hitohira_pending_saved_data_transaction',
    SAVED_DATA_LOCK_KEY: 'hitohira_saved_data_lock',
    SAVED_DATA_LOCK_NAME: 'hitohira_saved_data',
    SAVED_DATA_LOCK_OWNER: 'test-owner',
    SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision',
    navigator: { locks: { request: (_name, _options, operation) => operation({}) } },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    settingsPersistence: { timer: 0, pending: null, inFlight: false, generation: 0, conflicted: false },
    tocRenderGeneration: 0,
    searchRenderGeneration: 0,
    viewerResetComparableContent: null
  };
  Object.defineProperties(dependencies, Object.getOwnPropertyDescriptors(globals));
  const backgroundMediaFields = {
    dataUrl: 'backgroundMediaDataUrl', objectUrl: 'backgroundMediaObjectUrl', mediaType: 'backgroundMediaType',
    fileBlob: 'backgroundMediaFileBlob', fileExtension: 'backgroundMediaFileExtension',
    lastLoadedImage: 'lastLoadedImageElement', naturalWidth: 'backgroundMediaNaturalWidth',
    naturalHeight: 'backgroundMediaNaturalHeight', offsetX: 'backgroundMediaOffsetX', offsetY: 'backgroundMediaOffsetY'
  };
  if (!Object.hasOwn(globals, 'backgroundMediaState')) {
    const state = {};
    for (const [field, legacyName] of Object.entries(backgroundMediaFields)) {
      if (Object.hasOwn(globals, legacyName)) {
        Object.defineProperty(state, field, {
          get: () => dependencies[legacyName],
          set: value => { dependencies[legacyName] = value; },
          enumerable: true
        });
      }
    }
    dependencies.backgroundMediaState = state;
  }
  return loadFunctionsFromHtml(html, names, dependencies);
};
const convert = (language = 'ja') => load(['plainTextToSafeHTML'], { currentLanguage: language }).plainTextToSafeHTML;

test('多言語対応', '翻訳辞書を構造化し、すべての静的UIキーと英語訳を備える', () => {
  const dictionaryText = html.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(dictionaryText, '翻訳辞書がHTML内にありません');
  const dictionary = JSON.parse(dictionaryText);
  const supportedLanguages = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'ja', 'ko', 'pt', 'ru', 'zh-Hans', 'zh-Hant'];
  assert.deepEqual(Object.keys(dictionary).sort(), supportedLanguages.sort());
  for (const language of supportedLanguages) {
    assert.deepEqual(Object.keys(dictionary[language]).sort(), Object.keys(dictionary.en).sort(), `${language} の翻訳キーが揃っていません`);
    for (const key of Object.keys(dictionary.en)) {
      assert.equal(typeof dictionary[language][key], 'string', `${language}.${key} が文字列ではありません`);
      assert.ok(dictionary[language][key].trim(), `${language}.${key} が空です`);
      const placeholders = value => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]).sort();
      assert.deepEqual(placeholders(dictionary[language][key]), placeholders(dictionary.en[key]), `${language}.${key} の置換項目が一致しません`);
    }
  }
  const keys = [...html.matchAll(/\bdata-i18n(?:-aria|-title|-placeholder)?="([^"]+)"/g)].map(match => match[1]);
  keys.push(...[...html.matchAll(/\btranslate\(['"]([^'"]+)['"]/g)].map(match => match[1]));
  for (const key of new Set(keys)) {
    assert.ok(dictionary.ja[key], `日本語訳がありません: ${key}`);
    assert.ok(dictionary.en[key], `英語訳がありません: ${key}`);
  }
  assert.equal(dictionary.en['settings.title'], 'Settings');
  assert.match(html, /<tr><td data-i18n="help\.arrowKeys">矢印キー<\/td><td data-i18n="help\.arrows">/);
});

test('多言語対応', '用語表に定めた12言語の標準訳と辞書の用語が一致する', () => {
  const dictionary = JSON.parse(html.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const exactGlossary = terminology.split('## 用語族')[0];
  const rows = exactGlossary.split(/\r?\n/).filter(line => /^\| [^|]+ \|/.test(line)).slice(1);
  assert.ok(rows.length > 0, '用語表に用語行がありません');
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    const [concept, keys, ...translations] = cells;
    assert.equal(translations.length, Object.keys(dictionary).length, `${concept} の用語表に12言語分ありません`);
    for (const [index, locale] of Object.keys(dictionary).entries()) {
      for (const key of keys.split(',').map(value => value.trim().replace(/`/g, ''))) {
        assert.equal(dictionary[locale][key], translations[index], `${locale}.${key} が用語表と異なります`);
      }
    }
  }

  const familyGlossary = terminology.split('## 用語族の統一')[1].split('## 運用')[0];
  const familyRows = familyGlossary.split(/\r?\n/).filter(line => /^\| [^|]+ \|/.test(line)).slice(1);
  assert.ok(familyRows.length > 0, '用語族の語幹行がありません');
  for (const row of familyRows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    const [family, keys, ...stems] = cells;
    for (const [index, locale] of Object.keys(dictionary).entries()) {
      const stem = stems[index].toLocaleLowerCase(locale);
      for (const key of keys.split(',').map(value => value.trim().replace(/`/g, ''))) {
        assert.ok(dictionary[locale][key].toLocaleLowerCase(locale).includes(stem), `${locale}.${key} が用語族「${family}」の標準語を含みません`);
      }
    }
  }
});

test('多言語対応', '翻訳・ブラウザー言語判定・表示言語属性を更新する', () => {
  const dictionaryText = html.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const localizationData = JSON.parse(dictionaryText);
  const { translate, resolveBrowserLanguage, applyLanguage } = loadFunctionsFromHtml(html, ['translate', 'resolveBrowserLanguage', 'applyLanguage'], {
    localizationData, currentLanguage: 'en',
    document: { documentElement: {}, querySelectorAll: () => [] }
  });
  assert.equal(translate('bookmark.delete', { name: 'Start' }), 'Delete bookmark "Start"');
  assert.equal(resolveBrowserLanguage('en-US'), 'en');
  assert.equal(resolveBrowserLanguage('ja-JP'), 'ja');
  assert.equal(resolveBrowserLanguage(['fr-FR', 'en-US', 'ja-JP']), 'fr');
  assert.equal(resolveBrowserLanguage(['it-IT', 'ja-JP']), 'ja');
  assert.equal(resolveBrowserLanguage('es-MX'), 'es');
  assert.equal(resolveBrowserLanguage('pt-BR'), 'pt');
  assert.equal(resolveBrowserLanguage('ru-RU'), 'ru');
  assert.equal(resolveBrowserLanguage('ar-SA'), 'ar');
  assert.equal(resolveBrowserLanguage('hi-IN'), 'hi');
  assert.equal(resolveBrowserLanguage('zh-CN'), 'zh-Hans');
  assert.equal(resolveBrowserLanguage('zh-TW'), 'zh-Hant');
  assert.equal(resolveBrowserLanguage('zh-Hant-HK'), 'zh-Hant');
  assert.equal(resolveBrowserLanguage([]), 'ja');
  assert.doesNotMatch(html, /id="ctrl-language"/, '表示言語の手動選択UIが残っています');

  const text = { dataset: { i18n: 'settings.title' } };
  const aria = { dataset: { i18nAria: 'settings.open' }, setAttribute(name, value) { this[name] = value; } };
  const titled = { dataset: { i18nTitle: 'common.close' } };
  const placeholder = { dataset: { i18nPlaceholder: 'search.placeholder' } };
  const nodes = { '[data-i18n]': [text], '[data-i18n-aria]': [aria], '[data-i18n-title]': [titled], '[data-i18n-placeholder]': [placeholder] };
  const target = { documentElement: {}, querySelectorAll(selector) { return nodes[selector]; } };
  const { applyLanguage: apply } = loadFunctionsFromHtml(html, ['applyLanguage'], {
    localizationData, currentLanguage: 'ja', document: target
  });
  apply('en');
  assert.equal(target.documentElement.lang, 'en');
  assert.equal(text.textContent, 'Settings');
  assert.equal(aria['aria-label'], 'Open settings');
  assert.equal(titled.title, 'Close');
  assert.equal(placeholder.placeholder, 'Search the text');
  apply('ar');
  assert.equal(target.documentElement.dir, 'rtl');
  apply('fr');
  assert.equal(target.documentElement.dir, 'ltr');
});

test('多言語対応', '複数形・数値・日付を書類の表示言語で整形する', () => {
  const dictionary = JSON.parse(html.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const english = load(['formatLocaleNumber', 'formatLocalePercent', 'formatSearchResultCount', 'formatLocaleDate'], {
    currentLanguage: 'en', localizationData: dictionary,
    translate: (key, values = {}) => (dictionary.en[key] || dictionary.ja[key] || key).replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(values[name] ?? ''))
  });
  assert.equal(english.formatSearchResultCount(1), '1 result');
  assert.equal(english.formatSearchResultCount(2), '2 results');
  assert.equal(english.formatSearchResultCount(512, true), '512 results (first 500)');
  assert.equal(english.formatLocaleNumber(1234.5), new Intl.NumberFormat('en').format(1234.5));
  assert.equal(english.formatLocalePercent(50), new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }).format(0.5));
  assert.equal(english.formatLocaleDate(0), new Date(0).toLocaleString('en'));

  const russian = load(['formatSearchResultCount'], {
    currentLanguage: 'ru', localizationData: dictionary,
    translate: (key, values = {}) => (dictionary.ru[key] || dictionary.ja[key] || key).replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(values[name] ?? ''))
  });
  assert.equal(russian.formatSearchResultCount(1), '1 результат');
  assert.equal(russian.formatSearchResultCount(2), '2 результата');
  assert.equal(russian.formatSearchResultCount(5), '5 результатов');

  for (const [locale, language] of Object.entries({ ar: 'ar', de: 'de', en: 'en', es: 'es', fr: 'fr', hi: 'hi', ja: 'ja', ko: 'ko', pt: 'pt', ru: 'ru', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' })) {
    const localized = load(['formatLocaleNumber', 'formatLocalePercent', 'formatLocaleDate', 'formatSearchResultCount'], {
      currentLanguage: locale, localizationData: dictionary,
      translate: (key, values = {}) => (dictionary[locale][key] || key).replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(values[name] ?? ''))
    });
    assert.equal(localized.formatLocaleNumber(1234.5), new Intl.NumberFormat(language).format(1234.5), `${locale} の数値書式`);
    assert.equal(localized.formatLocalePercent(50), new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(0.5), `${locale} の百分率書式`);
    assert.equal(localized.formatLocaleDate(0), new Date(0).toLocaleString(language), `${locale} の日付書式`);
    assert.doesNotMatch(localized.formatSearchResultCount(2, true), /\{(?:count|limit)\}/, `${locale} の検索結果数に未置換項目があります`);
  }
});

test('多言語対応', 'エラー通知の操作名とインポート失敗理由を翻訳定義から表示する', () => {
  const dictionary = JSON.parse(html.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const notices = [];
  const { reportOperationFailure, createUserFacingError, getImportFailureReason, formatImportFailureSummary } = load(
    ['reportOperationFailure', 'createUserFacingError', 'getImportFailureReason', 'formatImportFailureSummary'], {
      currentLanguage: 'fr', localizationData: dictionary,
      translate: (key, values = {}) => (dictionary.fr[key] || dictionary.ja[key] || key).replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(values[name] ?? '')),
      console: { error() {} }, showErrorNotice: message => notices.push(message)
    });
  reportOperationFailure('operation.htmlExport', new Error('environment-specific text'));
  assert.equal(notices[0], 'L’action « exporter le HTML » a échoué. Réessayez. Si le problème persiste, consultez la console de développement du navigateur.');
  const known = createUserFacingError('error.readText');
  assert.equal(getImportFailureReason(known, 'fallback'), dictionary.fr['error.readText']);
  assert.equal(getImportFailureReason(new Error('untranslated browser exception'), dictionary.fr['error.importText']), dictionary.fr['error.importText']);
  assert.equal(formatImportFailureSummary([
    { kind: 'text', filename: 'roman.txt', message: dictionary.fr['error.importText'] },
    { kind: 'unsupported', filename: 'archive.bin', message: dictionary.fr['error.unsupported'] }
  ]), 'Certains fichiers n’ont pas pu être importés : roman.txt : Impossible de lire le fichier texte. Vérifiez qu’il n’est pas endommagé et qu’il est accessible. et archive.bin : Format de fichier non pris en charge.');
});

test('設定', '書字方向と書体の選択状態をアクセシブルな押下状態へ同期する', () => {
  const buttons = ['horizontal', 'vertical'].map(value => ({
    dataset: { value },
    attributes: {},
    classList: {
      active: value === 'horizontal',
      toggle(name, enabled) { if (name === 'is-active') this.active = enabled; }
    },
    setAttribute(name, state) { this.attributes[name] = state; }
  }));
  const container = { querySelectorAll: () => buttons };
  const { syncSegmented } = load(['syncSegmented']);

  syncSegmented(container, 'vertical');

  assert.deepEqual(buttons.map(button => button.classList.active), [false, true]);
  assert.deepEqual(buttons.map(button => button.attributes['aria-pressed']), ['false', 'true']);
  assert.match(html, /id="ctrl-writing-mode"[^>]*aria-label="書字方向"/);
  assert.match(html, /id="ctrl-font"[^>]*aria-label="書体"/);
  assert.match(html, /data-value="serif"[^>]*aria-label="明朝体"[^>]*>明<\/button>/);
  assert.match(html, /data-value="sans"[^>]*aria-label="ゴシック体"[^>]*>ゴ<\/button>/);
  assert.match(html, /\.segmented-control\.font-control button\[data-value="serif"\]\s*\{\s*font-family:[^}]*serif;/);
  assert.match(html, /\.segmented-control\.font-control button\[data-value="sans"\]\s*\{\s*font-family:[^}]*sans-serif;/);
  assert.match(html, /class="icon-control-row"[\s\S]*id="ctrl-writing-mode"[\s\S]*class="icon-control-divider"[^>]*role="separator"[\s\S]*id="ctrl-font"/);
  assert.match(html, /\.icon-control-row\s*\{[^}]*display:\s*flex/);
  assert.match(html, /\.icon-control-group\s+\.segmented-control\s*\{[^}]*width:\s*100%[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(html, /\.icon-control-row\s+\.segmented-control button\s*\{[^}]*width:\s*100%[^}]*height:\s*40px/);
  assert.match(html, /\.icon-control-font-group\s*\{[^}]*align-items:\s*flex-start/);
  assert.match(html, /\.icon-control-divider\s*\{[^}]*height:\s*40px/);
});

test('設定', '縦書きUIを含まない言語版では保存済み方向を横書きへ正規化する', () => {
  const { normalizeViewerSettings } = load(['normalizeViewerSettings'], { supportsVerticalWriting: false });
  assert.equal(normalizeViewerSettings({ writingMode: 'vertical' }, { writingMode: 'horizontal' }).writingMode, 'horizontal');
});

test('設定・保存データ', '設定変更は即時反映し、遅延保存の失敗状態と成功状態を通知する', async () => {
  const settings = { theme: 'light', fontSize: 16 };
  const writes = new Map();
  const errors = [];
  const rendered = [];
  let failWrite = true;
  let nextTimerId = 0;
  const timers = new Map();
  const { commitSettings } = load(['commitSettings'], {
    activeViewerSettings: settings,
    STORAGE_KEYS: { SETTINGS: 'settings' },
    setTimeout(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { setItem(key, value) {
      if (failWrite) throw new Error('保存拒否');
      writes.set(key, value);
    } },
    reportLocalStorageWrite(key, error) { errors.push([key, error.message]); },
    confirmLocalStorageWrite() {},
    scheduleHtmlExportSizeUpdate() {},
    applySettings(value) { rendered.push({ ...value }); }
  });

  commitSettings({ fontSize: 20 }, { preserveReadingPosition: false, refreshReadingState: false });
  assert.deepEqual(settings, { theme: 'light', fontSize: 20 });
  assert.deepEqual(rendered, [{ theme: 'light', fontSize: 20 }]);
  const failedTimer = [...timers.values()][0];
  assert.equal(failedTimer.delay, 250);
  timers.clear();
  await failedTimer.callback();
  assert.deepEqual(errors, [['settings', '保存拒否']]);

  failWrite = false;
  commitSettings({ fontSize: 21 }, { preserveReadingPosition: false, refreshReadingState: false });
  const savedTimer = [...timers.values()][0];
  timers.clear();
  await savedTimer.callback();
  assert.deepEqual(settings, { theme: 'light', fontSize: 21 });
  assert.deepEqual(JSON.parse(writes.get('settings')), settings);
  assert.deepEqual(rendered.at(-1), settings);
});

test('設定・保存データ', '別タブの保存変更を検知した後は設定と本文の上書きを停止する', async () => {
  const settings = { theme: 'light', fontSize: 16 };
  const notices = [];
  const persistence = { timer: 0, pending: null, inFlight: false, generation: 0, conflicted: false };
  const { handleExternalSavedDataChange, commitSettings, commitSavedData } = load(
    ['handleExternalSavedDataChange', 'commitSettings', 'commitSavedData'], {
      settingsPersistence: persistence,
      activeViewerSettings: settings,
      STORAGE_KEYS: { SETTINGS: 'settings', CONTENT: 'content', BOOKMARKS: 'bookmarks' },
      clearTimeout() {},
      showErrorNotice(message) { notices.push(message); },
      applySettings() { throw new Error('競合後に設定が描画されました'); }
    });

  handleExternalSavedDataChange({ key: 'settings' });
  commitSettings({ fontSize: 22 }, { preserveReadingPosition: false, refreshReadingState: false });
  assert.equal(await commitSavedData([['content', '<p>stale write</p>']]), false);
  handleExternalSavedDataChange({ key: 'hitohira_saved_data_revision' });

  assert.equal(persistence.conflicted, true);
  assert.deepEqual(settings, { theme: 'light', fontSize: 16 });
  assert.equal(notices.length, 2);
});

test('設定・保存データ', 'ページ離脱時に保留中の設定を同期的に書き出す', () => {
  const persistence = {
    timer: 7, pending: JSON.stringify({ theme: 'dark', fontSize: 19 }),
    inFlight: false, generation: 0, conflicted: false
  };
  const pendingValue = persistence.pending;
  const writes = [];
  const cleared = [];
  const confirmations = [];
  const status = { dataset: {}, textContent: '' };
  const { flushPendingSettingsSynchronously } = load(['flushPendingSettingsSynchronously'], {
    settingsPersistence: persistence,
    STORAGE_KEYS: { SETTINGS: 'settings' },
    settingsSaveStatusEl: status,
    localStorage: { setItem(key, value) { writes.push([key, value]); } },
    confirmLocalStorageWrite(key) { confirmations.push(key); },
    clearTimeout(id) { cleared.push(id); }
  });

  flushPendingSettingsSynchronously();

  assert.deepEqual(writes, [['settings', pendingValue]]);
  assert.deepEqual(confirmations, ['settings']);
  assert.deepEqual(cleared, [7]);
  assert.equal(persistence.pending, null);
  assert.equal(status.dataset.state, 'saved');
});

test('設定・保存データ', '保存状態を意味の分かるアイコンと支援技術向けラベルで表示する', () => {
  assert.match(html, /\.settings-save-status\s*\{[^}]*width:\s*36px[^}]*height:\s*36px[^}]*color:\s*var\(--text-primary\)/);
  assert.match(html, /<div class="drawer-header-actions">\s*<span id="settings-save-status"[^>]*>\s*<\/span>/);
  assert.match(html, /\.settings-save-status\[data-state="saved"\]\s*\{[^}]*color:\s*var\(--save-status-success\)/);
  assert.match(html, /\.settings-save-status\[data-state="failed"\]\s*\{[^}]*color:\s*var\(--save-status-error\)/);
  assert.match(html, /\.settings-save-status\[data-state="conflict"\]\s*\{[^}]*color:\s*var\(--save-status-warning\)/);
  assert.match(html, /--save-status-success:\s*#18794e/);
  assert.match(html, /--save-status-error:\s*#b42318/);
  assert.match(html, /--save-status-warning:\s*#8a5a00/);
  assert.match(html, /--save-status-success:\s*#75d69c/);
  assert.match(html, /--save-status-error:\s*#ff7b72/);
  assert.match(html, /--save-status-warning:\s*#f2cc60/);
  assert.match(html, /\.save-status-icon\s*\{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*stroke-width:\s*1\.75/);
  const status = { dataset: {}, innerHTML: '' };
  const { setSettingsSaveStatus } = load(['setSettingsSaveStatus'], {
    settingsSaveStatusEl: status,
    translate: key => ({
      'settings.save.saving': 'Saving', 'settings.save.saved': 'Saved',
      'settings.save.failed': 'Save failed', 'settings.save.conflict': 'Changed elsewhere'
    })[key] || key
  });
  for (const [state, label] of [['saving', 'Saving'], ['saved', 'Saved'], ['failed', 'Save failed'], ['conflict', 'Changed elsewhere']]) {
    setSettingsSaveStatus(state);
    assert.equal(status.dataset.state, state);
    assert.match(status.innerHTML, /<svg class="save-status-icon"[^>]*aria-hidden="true">/);
    assert.ok(status.innerHTML.includes(`<span class="visually-hidden">${label}</span>`));
  }
  setSettingsSaveStatus('');
  assert.equal(status.innerHTML, '');
});

test('設定・保存データ', '古い保存失敗は後から成立した別タブ競合状態を上書きしない', async () => {
  const persistence = { timer: 0, pending: '{}', inFlight: false, generation: 1, conflicted: false };
  const status = { dataset: {}, innerHTML: '' };
  let rejectWrite;
  const write = new Promise((_, reject) => { rejectWrite = reject; });
  const { flushSettingsSave } = load(['flushSettingsSave'], {
    settingsPersistence: persistence,
    settingsSaveStatusEl: status,
    STORAGE_KEYS: { SETTINGS: 'settings' },
    SAVED_DATA_LOCK_NAME: 'saved-data',
    navigator: { locks: { request: () => write } },
    reportLocalStorageWrite() {}, confirmLocalStorageWrite() {}, scheduleHtmlExportSizeUpdate() {},
    translate: key => key
  });
  const flushing = flushSettingsSave();
  persistence.generation += 1;
  persistence.conflicted = true;
  status.dataset.state = 'conflict';
  rejectWrite(new Error('stale write failed'));
  await flushing;
  assert.equal(status.dataset.state, 'conflict');
});

test('設定・保存データ', 'Web Locksの空き待ちは取得可能になるまで再試行し、操作を一度だけ実行する', async () => {
  let requests = 0;
  let operations = 0;
  let waits = 0;
  const { withSavedDataLock } = load(['withSavedDataLock'], {
    navigator: { locks: { async request(name, options, callback) {
      assert.equal(name, 'hitohira_saved_data');
      assert.equal(options.mode, 'exclusive');
      assert.equal(options.ifAvailable, true);
      requests += 1;
      return callback(requests === 1 ? null : {});
    } } },
    setTimeout(callback) { waits += 1; callback(); return waits; }
  });

  const value = await withSavedDataLock(() => { operations += 1; return 'saved'; });

  assert.equal(value, 'saved');
  assert.equal(requests, 2);
  assert.equal(waits, 1);
  assert.equal(operations, 1);
});

test('本文検索', '全半角・英字大小を同一視する場合も元本文の位置で全一致箇所を返す', () => {
  const { findTextMatches } = load(['findTextMatches']);
  const text = 'ＡＢＣ abc ｶﾅ';
  assert.deepEqual(JSON.parse(JSON.stringify(findTextMatches(text, 'abc', true))), [
    { start: 0, end: 3 }, { start: 4, end: 7 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(findTextMatches(text, 'カナ', true))), [{ start: 8, end: 10 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(findTextMatches('ｶﾞ', 'ガ', true))), [{ start: 0, end: 2 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(findTextMatches(text, 'abc', false))), [{ start: 4, end: 7 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(findTextMatches(text, '', true))), []);
});

test('本文検索', '分割検索中に検索語が変わったら古い検索結果を表示しない', async () => {
  const timers = [];
  const makeNode = tagName => ({
    tagName: String(tagName || '').toUpperCase(), textContent: '', children: [], dataset: {}, attributes: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return null; },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }
  });
  const blocks = Array.from({ length: 250 }, (_, index) => ({
    tagName: 'P', textContent: index < 100 ? `alpha ${index}` : `beta ${index}`,
    querySelector() { return null; }, classList: { add() {}, remove() {} }, scrollIntoView() {}
  }));
  const resultList = {
    children: [],
    replaceChildren(fragment) { this.children = fragment ? fragment.children.slice() : []; }
  };
  const status = { textContent: '' };
  const previous = { disabled: false };
  const next = { disabled: false };
  const query = { value: 'alpha' };
  const { renderSearchResults } = load(['renderSearchResults', 'findTextMatches', 'normalizeSearchText'], {
    novelContentElement: { querySelectorAll: () => blocks },
    searchQueryInput: query,
    searchIncludeHeadings: { checked: false }, searchIncludeBody: { checked: true },
    searchDistinguishVariants: { checked: false }, searchResultList: resultList,
    searchResultStatus: status, btnSearchPrevious: previous, btnSearchNext: next,
    activeSearchElement: null, activeSearchResultIndex: -1, searchResults: [],
    currentLanguage: 'ja', localizationData: localizationDictionary,
    setSearchResultStatus(text) { status.textContent = text; },
    clearActiveSearchBlock() {}, selectSearchResult() {}, reportNavigationDuration() {},
    maxSearchResults: 500,
    setTimeout(callback) { timers.push(callback); return timers.length; },
    document: {
      createDocumentFragment: () => makeNode('fragment'),
      createElement: tagName => makeNode(tagName),
      createTextNode: text => ({ textContent: text })
    }
  });

  renderSearchResults();
  assert.equal(status.textContent, '計算中');
  query.value = 'beta';
  renderSearchResults();
  while (timers.length) {
    timers.shift()();
    await Promise.resolve();
  }

  assert.equal(resultList.children.length, 150);
  assert.ok(resultList.children.every(item => item.children[0].attributes['aria-label'].includes('beta')));
  assert.equal(status.textContent, '150件');
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, false);
});

test('本文検索', '検索ボタン・検索語・結果一覧と対象フィルターを備える', () => {
  assert.match(html, /id="btn-open-search"[^>]*aria-label="本文を検索"/);
  const settingsHeaderActions = html.slice(html.indexOf('<div class="drawer-header-actions">'), html.indexOf('</div>', html.indexOf('<div class="drawer-header-actions">')));
  assert.match(settingsHeaderActions, /id="btn-open-toc"[\s\S]*id="btn-open-search"[\s\S]*id="btn-close-settings"/);
  assert.doesNotMatch(html.slice(0, html.indexOf('<aside id="settings-drawer"')), /id="btn-open-search"/);
  assert.match(html, /id="search-drawer"[^>]*aria-label="検索"/);
  const searchDrawer = html.slice(html.indexOf('<aside id="search-drawer"'), html.indexOf('</aside>', html.indexOf('<aside id="search-drawer"')));
  assert.match(searchDrawer, /<span class="drawer-title" data-i18n="search\.title">検索<\/span>/);
  assert.match(searchDrawer, /class="search-drawer-body"[\s\S]*class="search-controls search-drawer-controls"[\s\S]*class="search-results-scroll"[\s\S]*<ol id="search-results"/);
  assert.match(html, /\.search-drawer-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/);
  assert.match(html, /\.search-results-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
  assert.match(searchDrawer, /id="search-query"[^>]*type="search"[^>]*aria-label="本文を検索"/);
  assert.doesNotMatch(searchDrawer, /検索語|検索語を入力/);
  assert.match(html, /id="search-include-headings"[^>]*type="checkbox" checked/);
  assert.match(html, /id="search-include-body"[^>]*type="checkbox" checked/);
  assert.match(searchDrawer, /role="group" aria-label="文字種の区別"[^>]*data-i18n-aria="search\.variants"[\s\S]*<label><input id="search-distinguish-variants" type="checkbox"[^>]*data-i18n-aria="search\.variants"><span data-i18n="search\.variants">大文字・小文字と全角・半角を区別する<\/span><\/label>/);
  assert.doesNotMatch(searchDrawer, /class="search-variant-toggle"|<svg[^>]*><text[^>]*>Aa<\/text>/);
  assert.match(html, /#search-drawer input\[type="checkbox"\]\s*\{[^}]*accent-color:\s*var\(--text-secondary\)/);
  assert.match(html, /#search-query\s*\{[^}]*min-height:\s*34px[^}]*font-size:\s*14px[^}]*\}/);
  assert.match(html, /#search-query::-[\w-]+-search-cancel-button\s*\{[^}]*filter:\s*grayscale\(1\)/);
  assert.match(html, /input:not\(\[type="checkbox"\]\):not\(\[type="range"\]\):not\(\[type="color"\]\):not\(\[type="file"\]\):focus-visible,[\s\n]*textarea:focus-visible,[\s\n]*select:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--text-secondary\)/);
  assert.match(html, /#novel-content \.search-current-block\s*\{[^}]*outline:\s*1px solid var\(--text-secondary\)[^}]*outline-offset:\s*2px/);
  assert.match(html, /<ol id="search-results"[^>]*aria-label="検索結果一覧"/);
  assert.match(html, /id="btn-search-previous"[^>]*aria-label="前の検索結果へ"[^>]*>[\s\S]*?<svg[^>]*aria-hidden="true"/);
  assert.match(html, /id="btn-search-next"[^>]*aria-label="次の検索結果へ"[^>]*>[\s\S]*?<svg[^>]*aria-hidden="true"/);
  assert.match(html, /\.search-result-navigation \.action-btn svg\s*\{[^}]*stroke:\s*currentColor/);
  assert.match(html, /\.search-result-navigation \.action-btn\s*\{[^}]*place-items:\s*center[^}]*justify-content:\s*center/);
  assert.match(html, /\.search-result-navigation \.action-btn svg\s*\{[^}]*justify-self:\s*center[^}]*align-self:\s*center/);
  assert.match(html, /\.search-filter-navigation\s*\{[^}]*display:\s*flex/);
  assert.match(searchDrawer, /class="search-filter-navigation"[\s\S]*class="search-filter-group"[\s\S]*id="search-result-status"[\s\S]*class="search-result-navigation"[^>]*aria-label="検索結果の移動"[\s\S]*id="btn-search-previous"[\s\S]*id="btn-search-next"/);
  assert.match(html, /\.search-result-navigation\s*\{[^}]*width:\s*56px[^}]*height:\s*56px/);
  assert.match(html, /\.search-result-navigation\s*\{[^}]*gap:\s*4px/);
  assert.match(html, /\.search-result-navigation\s*\{[^}]*grid-template-areas:\s*"previous"\s*"next"/);
  assert.match(html, /html\[data-writing-mode="vertical"\] \.search-result-navigation\s*\{[^}]*grid-template-areas:\s*"next previous"/);
  assert.match(html, /html\[data-writing-mode="vertical"\] #btn-search-previous svg,[\s\n]*html\[data-writing-mode="vertical"\] #btn-search-next svg\s*\{[^}]*transform:\s*rotate\(90deg\)/);
});

test('目次・しおり', 'しおり名・保存一覧と文書別保存キーを用意する', () => {
  assert.match(html, /id="bookmark-name"[^>]*maxlength="80"/);
  assert.match(html, /id="btn-add-bookmark"[^>]*aria-label="現在位置にしおりを追加"[^>]*>[\s\S]*?<svg[^>]*viewBox="0 0 24 24"/);
  assert.match(html, /class="bookmark-controls"[\s\S]*id="bookmark-name"[\s\S]*id="btn-add-bookmark"/);
  assert.match(html, /class="bookmark-heading-icon"[^>]*role="img" aria-label="保存したしおり"/);
  assert.match(html, /id="bookmark-list"[^>]*aria-label="保存したしおり"/);
  assert.match(html, /remove\.className = 'bookmark-delete'/);
  assert.match(html, /deleteIcon\.setAttribute\('viewBox', '0 0 24 24'\)/);
  assert.match(html, /deletePath\.setAttribute\('d', '[^']*'\)/);
  assert.match(html, /clonedDoc\.querySelector\('#bookmark-list'\)\?\.replaceChildren\(\)/);
  assert.match(html, /BOOKMARKS:\s*'hitohira_bookmarks'/);
  assert.match(html, /getBookmarksStorageKey\s*=\s*\(\)\s*=>\s*`\$\{STORAGE_KEYS\.BOOKMARKS\}:\$\{currentDocumentId\}`/);
});

test('目次・しおり', 'しおりは読書状態を保存し、文書別に復元・削除して失敗を通知する', () => {
  const values = new Map();
  const messages = [];
  const context = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    },
    getBookmarksStorageKey: () => 'bookmarks:first',
    captureReadingPosition: () => ({ scrollTop: 220, headingId: 'chapter-2' }),
    restoreReadingPosition: position => { context.restoredPosition = position; },
    closeAllDrawers: () => { context.closed = true; },
    bookmarkListEl: {
      children: [],
      replaceChildren() { this.children = []; },
      appendChild(element) { this.children.push(element); }
    },
    bookmarkNameInput: { value: '' },
    document: {
      createElement: tag => ({ tag, children: [], attributes: {}, className: '', textContent: '',
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, callback) { this[name] = callback; },
        append(...elements) { this.children.push(...elements); },
        appendChild(element) { this.children.push(element); }
      }),
      createElementNS: (namespace, tag) => ({ namespace, tag, children: [], attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        appendChild(element) { this.children.push(element); }
      })
    },
    console: { warn() {} },
    confirmLocalStorageWrite() {},
    reportLocalStorageWrite(key, error) { messages.push([key, error.message]); }
  };
  const { addBookmark, readBookmarks, renderBookmarks } = load(['addBookmark', 'readBookmarks', 'renderBookmarks'], context);

  context.bookmarkNameInput.value = '  続きから読む  ';
  const dependencies = { now: () => 1234, random: () => 0.5, formatTimestamp: () => '2026/11/27 12:00' };
  assert.equal(addBookmark(context.bookmarkNameInput.value, null, dependencies), true);
  assert.equal(context.bookmarkNameInput.value, '');
  assert.deepEqual(JSON.parse(JSON.stringify(readBookmarks())), [{
    id: '1234-i', name: '続きから読む', position: { scrollTop: 220, headingId: 'chapter-2' }
  }]);
  renderBookmarks();
  const [row] = context.bookmarkListEl.children;
  row.children[0].click();
  assert.deepEqual(JSON.parse(JSON.stringify(context.restoredPosition)), { scrollTop: 220, headingId: 'chapter-2' });
  assert.equal(context.closed, true);
  row.children[1].click();
  assert.equal(row.children[1].children[0].tag, 'svg');
  assert.equal(row.children[1].attributes['aria-label'], 'しおり「続きから読む」を削除');
  assert.deepEqual(JSON.parse(JSON.stringify(readBookmarks())), []);

  values.set('bookmarks:first', '{');
  assert.throws(() => readBookmarks(), /JSON/);
  assert.equal(addBookmark('破損時に上書きしない', null, dependencies), false);
  assert.equal(values.get('bookmarks:first'), '{');
  context.localStorage.setItem = () => { throw new Error('容量不足'); };
  values.set('bookmarks:first', '[]');
  assert.equal(addBookmark('保存できない', null, dependencies), false);
  assert.equal(messages.at(-1)[0], 'bookmarks:first');
  assert.equal(messages.at(-1)[1], '容量不足');
});

test('ブラウザー操作基盤', 'CDP応答が止まった場合に期限で失敗し、切断時は保留要求をすぐ解除する', async () => {
  const socket = new EventTarget();
  socket.send = () => {};
  const clock = createFakeClock();
  const send = createCdpClient(socket, { timeoutMs: 30, clock });
  await assert.rejects(clock.runUntil(send('Runtime.evaluate')), /CDP応答タイムアウト.*Runtime\.evaluate/);

  const pending = send('Page.enable');
  socket.dispatchEvent(new Event('close'));
  await assert.rejects(pending, /CDP接続が閉じました/);
  await assert.rejects(send('Network.enable'), /CDP接続が閉じました/);
});

test('ブラウザー操作基盤', 'ブラウザー起動・CDP接続の失敗を原因別に分類する', () => {
  assert.equal(classifyBrowserFailure(new Error('fetch failed (EACCES)'), { transport: 'TCP', stage: 'CDP target discovery' }).code,
    'CDP_LOOPBACK_DENIED');
  assert.equal(classifyBrowserFailure(new Error('ブラウザーがCDPポート通知前に終了しました (code=1)'), {
    transport: 'TCP', stage: 'port announcement', stderr: 'crash server failed to launch, self-terminating'
  }).code, 'BROWSER_CRASHPAD_STARTUP');
  assert.equal(classifyBrowserFailure(new Error('CDPターゲットを取得できません (port=1234)'), { transport: 'TCP' }).code,
    'CDP_TARGET_UNAVAILABLE');
  assert.equal(classifyBrowserFailure(new Error('CDP WebSocket接続がタイムアウトしました'), { transport: 'TCP' }).code,
    'CDP_WEBSOCKET_FAILED');
  assert.equal(classifyBrowserFailure(new Error('CDPパイプが応答しません'), { transport: 'pipe' }).code,
    'CDP_PIPE_FAILED');
});

test('ブラウザー操作基盤', '状態ポーリングは注入時計で条件成立・期限終了を待たずに検証する', async () => {
  const clock = createFakeClock();
  let attempts = 0;
  const value = await clock.runUntil(waitForCondition(async () => ++attempts === 3, {
    timeoutMs: 500, intervalMs: 1, message: 'テスト条件が成立しません', clock
  }));
  assert.equal(value, true);
  assert.equal(attempts, 3);
  const timeoutClock = createFakeClock();
  await assert.rejects(timeoutClock.runUntil(waitForCondition(() => false, {
    timeoutMs: 10, intervalMs: 1, message: '状態待ちがタイムアウトしました', clock: timeoutClock
  })), /状態待ちがタイムアウトしました/);
  const stalledClock = createFakeClock();
  await assert.rejects(stalledClock.runUntil(waitForCondition(() => new Promise(() => {}), {
    timeoutMs: 10, message: '状態確認の応答自体が停止しました', clock: stalledClock
  })), /状態確認の応答自体が停止しました/);
});

test('テスト基盤', '課題表には完了条件を持つ未解決行だけが優先度順で並ぶ', () => {
  const [header, separator, ...rows] = issueTable.split(/\r?\n/)
    .filter(line => line.startsWith('|'))
    .map(line => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim()));
  assert.deepEqual(header, [
    'ID', '優先度', '状態', '対象', '課題・利用者への影響', '確認事実・原因仮説',
    '再現条件・入力', '解決策候補', '検証方法・完了条件', '阻害要因・再開条件', '次の作業'
  ]);
  assert.equal(separator.length, header.length);
  const ids = new Set();
  let previousPriority = 'P0';
  for (const row of rows) {
    const [id, priority, status] = row;
    assert.equal(row.length, header.length, id);
    assert.ok(row.every(Boolean), id);
    assert.match(id, /^ISS-\d{3,}$/);
    assert.ok(!ids.has(id), `課題IDが重複しています: ${id}`);
    ids.add(id);
    assert.match(priority, /^P[012]$/);
    assert.ok(previousPriority <= priority, `優先度順が不正です: ${id}`);
    previousPriority = priority;
    assert.match(status, /^(未着手|対応中|検証待ち|保留|解決不可)$/);
    assert.notEqual(row[8], '—', `完了条件がありません: ${id}`);
    if (status === '保留' || status === '解決不可') {
      assert.notEqual(row[9], '—', `阻害要因・再開条件がありません: ${id}`);
    }
  }
});
test('テスト基盤', '開発知見表の列・ID・根拠・適用範囲・制約・再確認条件が揃う', () => {
  const section = knowledgeTable.split('## 知見一覧')[1];
  assert.ok(section, '知見一覧がありません');
  const rows = section.split(/\r?\n/).filter(line => line.startsWith('|'))
    .map(line => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim()));
  const [header, separator, ...entries] = rows;
  assert.deepEqual(header, ['ID', '確認日', '分類・対象', '知見', '根拠・確認方法', '適用範囲', '制約・注意', '再確認条件', '関連資料']);
  assert.equal(separator.length, header.length);
  assert.ok(entries.length > 0, '知見が登録されていません');
  const ids = new Set();
  for (const entry of entries) {
    assert.equal(entry.length, header.length);
    assert.ok(entry.every(Boolean), entry[0]);
    assert.match(entry[0], /^KNW-\d{3,}$/);
    assert.ok(!ids.has(entry[0]), `知見IDが重複しています: ${entry[0]}`);
    ids.add(entry[0]);
    assert.match(entry[1], /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(agents.includes('./docs/DEVELOPMENT_KNOWLEDGE.md'));
});
test('テスト基盤', '開発資料一覧の相対リンクが実在する資料を指す', () => {
  const links = [...docsIndex.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.doesNotMatch(link, /^https?:/i, `外部リンクはこの資料一覧の対象外です: ${link}`);
    const target = link.split('#')[0];
    assert.ok(fs.existsSync(path.resolve(__dirname, '..', 'docs', target)), `資料リンクが見つかりません: ${link}`);
  }
  assert.doesNotMatch(testSkill + readme, /docs\/novel_viewer_spec_revised\.md/);
});
test('テスト基盤', '設計決定表に判断理由・影響・再検討条件と有効な参照先がある', () => {
  const section = decisions.split('## 決定一覧')[1];
  assert.ok(section, '決定一覧がありません');
  const rows = section.split(/\r?\n/).filter(line => line.startsWith('|'))
    .map(line => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim()));
  const [header, separator, ...entries] = rows;
  assert.deepEqual(header, ['ID', '記録日', '状態', '決定', '背景・論点', '判断理由', '影響・制約', '再検討条件', '関連資料']);
  assert.equal(separator.length, header.length);
  assert.ok(entries.length > 0, '設計決定がありません');
  const ids = new Set();
  for (const entry of entries) {
    assert.equal(entry.length, header.length);
    assert.ok(entry.every(Boolean), entry[0]);
    assert.match(entry[0], /^ADR-\d{3,}$/);
    assert.ok(!ids.has(entry[0]), `設計決定IDが重複しています: ${entry[0]}`);
    ids.add(entry[0]);
    assert.match(entry[2], /^(採用|廃止)$/);
  }
  for (const [, target] of decisions.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const pathPart = target.split('#')[0];
    assert.ok(fs.existsSync(path.resolve(__dirname, '..', 'docs', pathPart)), `設計決定の参照先が見つかりません: ${target}`);
  }
  assert.ok(agents.includes('./docs/DECISIONS.md'));
});
test('テスト基盤', '要求IDと資料別接頭辞が共通採番規則に従う', () => {
  const requirementIds = [...requirements.matchAll(/^### (REQ-\d{3,}) /gm)].map(match => match[1]);
  assert.ok(requirementIds.length > 0, '宣言的要求がありません');
  assert.equal(new Set(requirementIds).size, requirementIds.length, '要求IDが重複しています');
  for (const [kind, prefix] of [['宣言的要求', 'REQ'], ['未解決課題', 'ISS'], ['再利用可能な知見', 'KNW'], ['設計決定', 'ADR']]) {
    assert.ok(identifierConventions.includes('| ' + kind + ' | `' + prefix + '` |'), `${prefix}の種別接頭辞が登録されていません`);
  }
  assert.match(identifierConventions, /削除・置換後も番号を再利用しない/);
  assert.ok(agents.includes('./docs/IDENTIFIERS.md'));
});
test('テスト基盤', 'テスト後の副作用を成否に関わらず除去する方針がある', () => {
  assert.ok(testSkill.includes('成否・例外・中断に関わらず環境を復元する'));
  assert.ok(agents.includes('成否や例外に関わらず'));
  assert.ok(testingGuide.includes('正常終了・失敗・例外・中断を問わず'));
});
test('テスト基盤', '製品の実行時ネットワーク不要方針が仕様にある', () => {
  assert.ok(spec.includes('実行時にネットワーク接続を要求しない'));
});
test('公開用配布', 'GitHubのREADMEから公開HTMLを直接ダウンロードする', () => {
  assert.match(readme, /\[Hitohiraをダウンロード\]\(https:\/\/github\.com\/z0w1non\/Hitohira\/raw\/HEAD\/public\/hitohira-jp\.html\?download=1\)/);
  assert.match(readme.split(/\r?\n/)[0], /^日本語 \| /);
  assert.doesNotMatch(readme.split(/\r?\n/)[0], /\[日本語\]\(/);
  assert.match(readme, /小説を1つのHTMLファイルで読むための単体型ビューアです/);
  assert.doesNotMatch(readme, /A standalone novel viewer/);
  assert.match(japaneseReadme.split(/\r?\n/)[0], /^日本語 \| .*\[العربية\]/);
  assert.match(englishReadme.split(/\r?\n/)[0], /\[日本語\].*\[العربية\]/);
  assert.match(japaneseReadme.split(/\r?\n/)[0], /^日本語 \| /);
  assert.match(englishReadme.split(/\r?\n/)[0], /\[日本語\]\(\.\.\/\.\.\/README\.md\)/);
  assert.match(japaneseReadme, /public\/hitohira-jp\.html\?download=1/);
  assert.match(englishReadme, /public\/hitohira-en\.html\?download=1/);
  assert.match(englishReadme, /\[Download Hitohira\]/);
  assert.match(japaneseReadme, /スクリーンショット/);
  assert.match(englishReadme, /Screenshots/);
  assert.doesNotMatch(readme, /public\/hitohira\.html/);
  const locales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'locales.json'), 'utf8'));
  const labels = { ja: '日本語', en: 'English', es: 'Español', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', fr: 'Français', de: 'Deutsch', pt: 'Português', ko: '한국어', ru: 'Русский', hi: 'हिन्दी', ar: 'العربية' };
  for (const [locale, metadata] of Object.entries(locales)) {
    const publicFile = path.join(__dirname, '..', 'public', `hitohira-${metadata.suffix}.html`);
    assert.ok(fs.existsSync(publicFile), `${locale}の公開HTMLがありません`);
    const languageReadme = fs.readFileSync(path.join(__dirname, '..', 'readme', locale, 'README.md'), 'utf8');
    assert.ok(languageReadme.includes(`public/hitohira-${metadata.suffix}.html?download=1`), `${locale}のREADMEが別言語版へリンクしています`);
    const navigation = languageReadme.split(/\r?\n/)[0];
    assert.ok(navigation.includes(labels[locale]), `${locale}のREADMEに現在言語がありません`);
    assert.doesNotMatch(navigation, new RegExp(`\\[${labels[locale]}\\]\\(`), `${locale}のREADMEで現在言語がリンクになっています`);
    assert.equal([...navigation.matchAll(/\[[^\]]+\]\([^)]+\)/g)].length, 11, `${locale}のREADMEで他言語の切替リンク数が不正です`);
  }
  assert.ok(spec.includes('日本語（同ファイル）と他11言語のREADMEへの切替リンク'));
});

test('画面構成', '静的なUIのIDは一意で、アイコンボタンに操作名がある', () => {
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assertUniqueHtmlIds(markup);
  assertIconButtonsAccessible(markup);
});

test('画面構成・ドロワー', '設定・目次・検索を切り替えると常に一つだけが開き、閉鎖ですべて閉じる', () => {
  const makePanel = () => {
    const classes = new Set();
    const attributes = {};
    return { classes, attributes, inert: true, focused: 0, focus() { this.focused++; }, setAttribute(name, value) { attributes[name] = value; }, classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name)
    } };
  };
  const settingsDrawer = makePanel();
  const tocDrawer = makePanel();
  const searchDrawer = makePanel();
  const makeTrigger = () => ({ attributes: {}, focused: 0, setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused++; } });
  const btnOpenSettings = makeTrigger();
  const btnOpenToc = makeTrigger();
  const btnOpenSearch = makeTrigger();
  let scrolled = 0;
  let searchHighlightPresent = false;
  const activeSearchElement = { classList: { remove: name => { if (name === 'search-current-block') searchHighlightPresent = false; } } };
  const currentButton = { scrollIntoView: () => { scrolled++; } };
  const { openSettingsDrawer, openTocDrawer, openSearchDrawer, closeAllDrawers } = load(
    ['openSettingsDrawer', 'openTocDrawer', 'openSearchDrawer', 'closeAllDrawers', 'clearActiveSearchBlock'], {
      settingsDrawer, tocDrawer, searchDrawer, btnOpenSettings, btnOpenToc, btnOpenSearch, activeSearchElement, renderSearchResults() {},
      searchQueryInput: { focus() {}, value: '', setSelectionRange() {} },
      tocListEl: { querySelector: () => currentButton }
    });

  openSettingsDrawer();
  assert.equal(settingsDrawer.classList.contains('is-open'), true);
  assert.equal(tocDrawer.classList.contains('is-open'), false);
  assert.equal(searchDrawer.classList.contains('is-open'), false);
  assert.equal(btnOpenSettings.attributes['aria-expanded'], 'true');
  assert.equal(settingsDrawer.attributes['aria-hidden'], 'false');
  assert.equal(settingsDrawer.inert, false);
  openTocDrawer();
  assert.equal(settingsDrawer.classList.contains('is-open'), false);
  assert.equal(tocDrawer.classList.contains('is-open'), true);
  assert.equal(searchDrawer.classList.contains('is-open'), false);
  assert.equal(scrolled, 1);
  assert.equal(btnOpenSettings.attributes['aria-expanded'], 'false');
  assert.equal(btnOpenToc.attributes['aria-expanded'], 'true');
  assert.equal(settingsDrawer.inert, true);
  openSearchDrawer();
  assert.equal(settingsDrawer.classList.contains('is-open'), false);
  assert.equal(tocDrawer.classList.contains('is-open'), false);
  assert.equal(searchDrawer.classList.contains('is-open'), true);
  assert.equal(btnOpenSearch.attributes['aria-expanded'], 'true');
  searchHighlightPresent = true;
  closeAllDrawers();
  assert.equal(searchHighlightPresent, false);
  assert.equal(settingsDrawer.classList.contains('is-open'), false);
  assert.equal(tocDrawer.classList.contains('is-open'), false);
  assert.equal(searchDrawer.classList.contains('is-open'), false);
  assert.equal(btnOpenSearch.attributes['aria-expanded'], 'false');
  assert.equal(btnOpenSearch.focused, 1);
});

test('画面構成・ヘルプモーダル', 'モーダル表示中は背景ドラッグを開始せず、閉じると再開できる', () => {
  const visible = new Set();
  let updates = 0;
  const shortcutModal = { open: true };
  const { startDrag } = load(['startDrag'], {
    shortcutModal, backgroundMediaDataUrl: 'data:image/png;base64,AA==',
    backgroundMediaOffsetX: 0, backgroundMediaOffsetY: 0,
    bgViewportIndicator: { classList: { add: value => visible.add(value) } },
    updateBackgroundViewportIndicator: () => { updates++; }
  });
  const target = { closest: () => null };

  assert.equal(startDrag(10, 20, target), false);
  assert.deepEqual([...visible], []);
  assert.equal(updates, 0);
  shortcutModal.open = false;
  assert.equal(startDrag(10, 20, target), true);
  assert.equal(visible.has('is-visible'), true);
  assert.equal(updates, 1);
});

test('エクスポートHTML', '開発用HTMLは通常版だけを書き出す', () => {
  assert.match(html, /id="btn-export-html"/);
  assert.doesNotMatch(html, /btn-export-html-minified|function minifyExportHtml/);
  assert.match(html, /const exportFileName = `\$\{fileStem\}\.html`/);
});

test('エクスポートHTML・セキュリティ', 'ユーザー由来JSONをscript要素へ埋めてもHTMLタグとして解釈されない', () => {
  const { serializeEmbeddedJson } = load(['serializeEmbeddedJson']);
  const value = { title: '</script><script>alert(1)</script>', media: 'data:image/svg+xml,<svg></svg>' };
  const serialized = serializeEmbeddedJson(value);
  assert.doesNotMatch(serialized, /<|>|&|\u2028|\u2029/);
  assert.equal(JSON.parse(serialized).title, value.title);
  assert.equal(JSON.parse(serialized).media, value.media);
  assert.match(html, /configScript\.textContent = '[^']*' \+ serializeEmbeddedJson\(activeViewerSettings, 2\)/);
  assert.match(html, /createEmbeddedResetDefaults\(resetData\.settings, resetData\.content\)/);
  assert.match(html, /downloadData\.textContent = serializeEmbeddedJson\(createEmbeddedDownloadData/);
});

test('エクスポート', 'ファイルサイズを簡潔な十進単位で整形する', () => {
  const { formatFileSize } = load(['formatFileSize'], { currentLanguage: 'ja' });
  assert.equal(formatFileSize(5), '5 B');
  assert.equal(formatFileSize(1200), '1.2 KB');
  assert.equal(formatFileSize(5_000_000), '5 MB');
  assert.equal(formatFileSize(5_500_000), '5.5 MB');
  assert.equal(formatFileSize(-1), '—');
});

test('エクスポート', 'HTML生成サイズ表示の更新を遅延し連続要求をまとめる', () => {
  const pending = new Map();
  let nextId = 0;
  let textContent = '';
  const { scheduleHtmlExportSizeUpdate } = load(['scheduleHtmlExportSizeUpdate', 'htmlExportSizeTimer'], {
    document: { getElementById: () => ({ set textContent(value) { textContent = value; }, get textContent() { return textContent; } }) },
    setTimeout(callback, delay) { const id = ++nextId; pending.set(id, { callback, delay }); return id; },
    clearTimeout(id) { pending.delete(id); }
  });
  scheduleHtmlExportSizeUpdate();
  scheduleHtmlExportSizeUpdate();
  assert.equal(textContent, '計算中');
  assert.equal(pending.size, 1);
  assert.equal([...pending.values()][0].delay, 160);
});

test('公開用ビルド', '生成HTMLに実行時辞書・復元ハーネスを埋め込まない', async () => {
  const { buildMinifiedHtml } = require('../tools/generate_minified_viewer');
  const generated = await buildMinifiedHtml(html, 'en');
  assert.ok(generated.includes('MIT License'));
  assert.doesNotMatch(generated, /viewer-minifier-map|viewer-minified-script/);
  assert.doesNotMatch(generated, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(generated, /<link\b[^>]*\brel\s*=\s*["']?stylesheet[^>]*\bhref\s*=/i);
  assert.ok(generated.includes('--bg-panel: #ffffff'));
  assert.match(generated, /<html lang="en"[^>]*data-vertical-writing="false"/);
  assert.match(generated, /"en":\{/);
  assert.doesNotMatch(generated, /"ja":\{/);
  assert.match(generated, /data-value="serif"[^>]*>S<\/button>/);
  assert.match(generated, /data-value="sans"[^>]*>G<\/button>/);
  assert.doesNotMatch(generated, /id="ctrl-writing-mode"|class="icon-control-divider"/);
  assert.ok(generated.includes(JSON.parse(generated.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]).en['intro.summary']));
  assert.ok(Buffer.byteLength(generated) < Buffer.byteLength(html));
});

test('公開用ビルド', '各言語の公開HTMLを一辞書・対応本文・縦書き可否で生成する', () => {
  const { localizeHtml } = require('../tools/generate_minified_viewer');
  const locales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'locales.json'), 'utf8'));
  for (const [locale, metadata] of Object.entries(locales)) {
    const localized = localizeHtml(html, locale);
    const dictionary = JSON.parse(localized.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.deepEqual(Object.keys(dictionary), [locale]);
    assert.match(localized, new RegExp(`<html lang="${locale}"[^>]*dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`));
    assert.match(localized, new RegExp(`data-vertical-writing="${metadata.vertical}"`));
    assert.match(localized, new RegExp(`data-value="serif"[^>]*>${metadata.fonts.serifIcon}<\\/button>`));
    assert.match(localized, new RegExp(`data-value="sans"[^>]*>${metadata.fonts.sansIcon}<\\/button>`));
    assert.ok(localized.includes(`--font-serif: ${metadata.fonts.serifStack};`), `${locale}の本文向けフォントスタックがありません`);
    assert.ok(localized.includes(`--font-sans: ${metadata.fonts.sansStack};`), `${locale}のゴシック体フォントスタックがありません`);
    assert.match(localized, /<h1[^>]*>Hitohira<\/h1>/);
    assert.ok(localized.includes(dictionary[locale]['intro.summary']), `${locale}の既定本文が未翻訳です`);
    assert.ok(localized.includes(dictionary[locale]['intro.dialogue']), `${locale}の既定本文に台詞引用符の説明がありません`);
    if (locale !== 'ja') assert.doesNotMatch(dictionary[locale]['intro.markdown'], /[｜《》]|漢字/, `${locale}の既定本文に日本語専用ルビ記法が含まれています`);
    assert.match(localized, new RegExp(`"settings\\.serif":"${metadata.fonts.serifLabel}"`));
    if (metadata.vertical) assert.match(localized, /id="ctrl-writing-mode"/);
    else {
      assert.doesNotMatch(localized, /id="ctrl-writing-mode"|class="icon-control-divider"/);
      assert.equal(dictionary[locale]['intro.display'], metadata.displayWithoutVertical, `${locale}の既定本文が非対応の書字方向機能を紹介しています`);
      assert.equal(dictionary[locale]['intro.shortcuts'], metadata.shortcutsWithoutVertical, `${locale}の既定本文に非対応の書字方向操作が含まれています`);
    }
  }
});

test('本文表示・インポート', '見出しは6段まで変換し、7段目は文章として残す', () => {
  const render = convert();
  const levels = [1, 2, 3, 4, 5, 6];
  const input = [...levels.map(level => '#'.repeat(level) + ' 章'), '####### 章'].join('\r\n');
  assert.equal(render(input), [...levels.map(level => '<h' + level + '>章</h' + level + '>'), '<p>####### 章</p>'].join('\n'));
});

test('本文表示・インポート', '表の見出しとデータ行を分け、次の段落を巻き込まない', () => {
  assert.equal(convert()('名前 | 値\n--- | ---\n雨 | **強い**\n続き'),
    '<table><thead><tr><th>名前</th><th>値</th></tr></thead><tbody><tr><td>雨</td><td><strong>強い</strong></td></tr></tbody></table>\n<p>続き</p>');
});

const markdownBlocks = {
  表: ['項目 | 値\n--- | ---\nA | 1', '<table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>'],
  箇条書き: ['- 左 | 右\n- 次', '<ul><li>左 | 右</li><li>次</li></ul>'],
  番号付きリスト: ['1. 左 | 右\n2. 次', '<ol><li>左 | 右</li><li>次</li></ol>'],
  コード: ['```text | 備考\n- 左 | 右\n```', '<pre><code>- 左 | 右</code></pre>']
};

for (const list of ['箇条書き', '番号付きリスト']) {
  const blocks = ['表', list, 'コード'];
  for (const first of blocks) {
    for (const second of blocks.filter(block => block !== first)) {
      const third = blocks.find(block => block !== first && block !== second);
      const order = [first, second, third];
      test('本文表示・インポート', `${order.join(' → ')}の境界を空行の有無で検証する`, () => {
        const render = convert();
        for (const firstGap of ['\n', '\n\n']) {
          for (const secondGap of ['\n', '\n\n']) {
            const [start, middle, end] = order.map(block => markdownBlocks[block][0]);
            const input = start + firstGap + middle + secondGap + end + '\n後続段落';
            const expected = [...order.map(block => markdownBlocks[block][1]), '<p>後続段落</p>'];
            assert.deepEqual(render(input).split('\n').filter(Boolean), expected, JSON.stringify(input));
          }
        }
      });
    }
  }
}

test('本文表示・インポート', '引用・リスト・水平線・コードブロックを本文から分離する', () => {
  assert.equal(convert()('> 引用\n> 二行目\n- *雨*\n- ~~雪~~\n1. `n`\n2. 晴\n---\n```\n# <b>\n```'),
    '<blockquote>引用<br>二行目</blockquote>\n<ul><li><em>雨</em></li><li><del>雪</del></li></ul>\n<ol><li><code>n</code></li><li>晴</li></ol>\n<hr>\n<pre><code># &lt;b&gt;</code></pre>');
});

test('本文表示・インポート', '台詞とルビを表示できる形へ変換する', () => {
  assert.equal(convert()('「漢字《かんじ》…」'), '<p><span class="dialogue">「<ruby>漢字<rt>かんじ</rt></ruby><span class="ellipsis">…</span>」</span></p>');
});

test('本文表示・インポート', '各言語圏の対応する引用符を台詞として扱い、非対応の引用符は変更しない', () => {
  const convertText = convert();
  const cases = [
    ['“Hello.”', '<span class="dialogue">“Hello.”</span>'],
    ['"Hello."', '<span class="dialogue">"Hello."</span>'],
    ["'Hello.'", "<span class=\"dialogue\">'Hello.'</span>"],
    ['‘Hello.’', '<span class="dialogue">‘Hello.’</span>'],
    ['„Guten Tag.“', '<span class="dialogue">„Guten Tag.“</span>'],
    ['«Bonjour !»', '<span class="dialogue">«Bonjour !»</span>'],
    ['»Hallo!«', '<span class="dialogue">»Hallo!«</span>'],
    ['‹Hello›', '<span class="dialogue">‹Hello›</span>'],
    ['『こんにちは』', '<span class="dialogue">『こんにちは』</span>'],
    ['〝こんにちは〟', '<span class="dialogue">〝こんにちは〟</span>'],
    ["It's a story.", "It's a story."],
    ['“閉じていない', '“閉じていない']
  ];
  for (const [input, expected] of cases) {
    const actual = convertText(input);
    assert.equal(actual, `<p>${expected}</p>`, `引用符入力 ${input}`);
  }
  assert.equal(convertText('“**Hello**”'), '<p><span class="dialogue">“<strong>Hello</strong>”</span></p>');
  assert.equal(convert('en')('「こんにちは」'), '<p><span class="dialogue">「こんにちは」</span></p>');
  assert.equal(convertText("It's a 'great' story."), '<p>It\'s a <span class="dialogue">\'great\'</span> story.</p>');
});

test('本文表示・インポート', 'HTMLルビ記法と日本語向け入力記法を安全な本文へ変換する', () => {
  const convertJapanese = load(['plainTextToSafeHTML'], { currentLanguage: 'ja' }).plainTextToSafeHTML;
  assert.equal(convertJapanese('<ruby>漢字<rt>かんじ</rt></ruby>'), '<p><ruby>漢字<rt>かんじ</rt></ruby></p>');
  assert.equal(convertJapanese('｜今日《こんにち》 漢字《かんじ》'), '<p><ruby>今日<rt>こんにち</rt></ruby> <ruby>漢字<rt>かんじ</rt></ruby></p>');
  assert.equal(convertJapanese('<ruby onclick="alert(1)">base<rt>note</rt></ruby>'), '<p>&lt;ruby onclick="alert(1)"&gt;base<rt>note</rt></ruby></p>');
  assert.equal(convertJapanese('<script>bad</script>'), '<p>&lt;script&gt;bad&lt;/script&gt;</p>');
});

test('本文表示・インポート', '日本語以外ではHTMLルビを扱い日本語専用入力記法を変換しない', () => {
  const convertEnglish = load(['plainTextToSafeHTML'], { currentLanguage: 'en' }).plainTextToSafeHTML;
  assert.equal(convertEnglish('<ruby>漢字<rt>かんじ</rt></ruby>'), '<p><ruby>漢字<rt>かんじ</rt></ruby></p>');
  assert.equal(convertEnglish('｜今日《こんにち》 漢字《かんじ》'), '<p>｜今日《こんにち》 漢字《かんじ》</p>');
});

test('本文表示・インポート', '長い漢字の連続や空白を含む本文でもルビと段落を保つ', () => {
  const kanji = '漢'.repeat(65536);
  const spaces = ' '.repeat(32768);
  const input = `${kanji}。漢字《かんじ》\n${spaces}本文\n次の段落`;
  assert.equal(convert('ja')(input), `<p>${kanji}。<ruby>漢字<rt>かんじ</rt></ruby></p>\n<p>本文</p>\n<p>次の段落</p>`);
});

test('本文表示・インポート', '対応する相対・外部リンクを変換する', () => {
  assert.equal(convert()('[次](../next.md) [仕様](docs/SPECIFICATION.md) [参照](https://example.test) [章](#chapter)'),
    '<p><a href="../next.md">次</a> <a href="docs/SPECIFICATION.md">仕様</a> <a href="https://example.test">参照</a> <a href="#chapter">章</a></p>');
});

test('本文表示・インポート', '本文中のHTMLタグを文字として扱い、未許可スキームをリンクにしない', () => {
  const input = '<b>雨</b> [参照](file:///local.md)';
  assert.equal(convert()(input), '<p>&lt;b&gt;雨&lt;/b&gt; [参照](file:///local.md)</p>');
});

test('本文表示・インポート', 'リンクと画像の許可URLだけを通し、危険スキームを拒否する', () => {
  const { isAllowedResourceUrl } = load(['isAllowedResourceUrl']);
  assert.equal(isAllowedResourceUrl('https://example.test/a', 'href'), true);
  assert.equal(isAllowedResourceUrl('../chapter.md', 'href'), true);
  assert.equal(isAllowedResourceUrl('javascript:alert(1)', 'href'), false);
  assert.equal(isAllowedResourceUrl('data:image/png;base64,AA==', 'image'), true);
  assert.equal(isAllowedResourceUrl('https://tracker.example/pixel.png', 'image'), false);
  assert.equal(isAllowedResourceUrl('../outside.png', 'image'), false);
  assert.equal(isAllowedResourceUrl('data:text/html;base64,AA==', 'image'), false);
});

test('本文表示・インポート', 'サニタイズ属性は許可された識別子・クラス・媒体属性だけを残す', () => {
  const { isAllowedSanitizedAttribute } = load(['isAllowedSanitizedAttribute']);
  assert.equal(isAllowedSanitizedAttribute('h2', 'id', 'heading-2'), true);
  assert.equal(isAllowedSanitizedAttribute('span', 'class', 'dialogue'), true);
  assert.equal(isAllowedSanitizedAttribute('span', 'style', 'color:red'), false);
  assert.equal(isAllowedSanitizedAttribute('img', 'src', 'javascript:alert(1)'), false);
  assert.equal(isAllowedSanitizedAttribute('img', 'alt', '背景'), true);
});

test('本文表示・インポート・セキュリティ', '未許可要素とその内容を本文から除去する', () => {
  assert.match(html, /if \(!ALLOWED_TAGS\.has\(child\.tagName\)\)\s*\{\s*node\.removeChild\(child\);/);
  assert.doesNotMatch(html, /createTextNode\(child\.textContent \|\| ''\)/);
});

test('本文表示・インポート・セキュリティ', '未信頼HTMLは不活性なtemplate内容で解析してからサニタイズする', () => {
  const sanitizer = html.slice(html.indexOf('function sanitizeHTML'), html.indexOf('function processPunctuation'));
  const importer = html.slice(html.indexOf('async function handleFiles'), html.indexOf("btnImportFile.addEventListener('click'"));
  assert.match(sanitizer, /document\.createElement\('template'\)/);
  assert.match(sanitizer, /cleanNode\(fragment\)/);
  assert.doesNotMatch(sanitizer, /new DOMParser/);
  assert.match(importer, /const template = document\.createElement\('template'\)/);
  assert.doesNotMatch(importer, /new DOMParser/);
});

const readText = () => load(['readTextFile'], { TextDecoder }).readTextFile;

test('インポート', 'UTF-8とBOM付きUTF-16を同じ本文へ復号する', async () => {
  const read = readText();
  for (const bytes of ['雨', [0xff, 0xfe, 0xe8, 0x96], [0xfe, 0xff, 0x96, 0xe8]]) {
    assert.equal(await read(new Blob([typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)])), '雨');
  }
});

test('インポート', '復号できないバイトが続く場合は読み込み失敗を返す', async () => {
  await assert.rejects(readText()(new Blob([Uint8Array.of(255, 255, 255)])), /文字コード/);
});

test('インポート', '複数ファイルの結果をファイル別の成功・失敗として返す', async () => {
  const fixture = importFixture();
  const result = await fixture.handleFiles([
    new File(['本文'], 'chapter.txt'),
    new File(['ignored'], 'notes.bin')
  ]);
  assert.equal(result.textStatus, 'committed');
  assert.deepEqual(Array.from(result.text, item => [item.filename, item.status]), [['chapter.txt', 'committed']]);
  assert.deepEqual(Array.from(result.failures, item => [item.kind, item.filename]), [['unsupported', 'notes.bin']]);
});

function importFixture(storeText = () => {}, options = {}) {
  const content = { innerHTML: '<p>既存本文</p>' };
  const viewer = { scrollTop: 260, scrollLeft: -120 };
  const settings = {};
  const storage = new Map([['position:old', '以前の位置']]);
  const notices = [];
  const originals = [];
  const mediaWrites = [];
  const mediaSelections = [];
  const noop = () => {};
  const { readTextFile, getFileExtension } = load(['readTextFile', 'getFileExtension'], { TextDecoder });
  const { getFileStem } = load(['getFileStem']);
  const importedSource = { blob: null, extension: '' };
  const importGlobals = {
    readTextFile, getFileExtension, getFileStem, plainTextToSafeHTML: convert(),
    sanitizeHTML: markup => {
      options.sanitizedInputs?.push(markup);
      return options.sanitize ? options.sanitize(markup) : markup;
    },
    document: options.document,
    getExportSource: () => ({ blob: importedSource.blob, extension: importedSource.extension }),
    async storeImportedText(blob, extension) {
      await storeText(blob, extension);
      importedSource.blob = blob;
      importedSource.extension = extension;
      originals.push({ blob, extension });
    },
    async commitSavedData(changes, persistAdditionalData) {
      const previous = changes.map(([key]) => [key, storage.has(key) ? storage.get(key) : null]);
      try {
        for (const [key, value] of changes) {
          if (value === null) importGlobals.localStorage.removeItem(key);
          else importGlobals.localStorage.setItem(key, value);
        }
        if (persistAdditionalData?.[0]?.key === 'current_text') {
          const record = persistAdditionalData[0].value;
          await storeText(record.blob, record.fileExtension);
          importedSource.blob = record.blob;
          importedSource.extension = record.fileExtension;
          originals.push({ blob: record.blob, extension: record.fileExtension });
        }
        return true;
      } catch (error) {
        for (const [key, value] of previous) {
          if (value === null) storage.delete(key);
          else storage.set(key, value);
        }
        throw error;
      }
    },
    async validateImageFile() {}, async validateVideoFile() {},
    async storeBackgroundMedia(file, mediaType) {
      if (options.failMediaName === file.name) throw new Error('媒体保存拒否');
      mediaWrites.push({ file, mediaType });
    },
    URL: { createObjectURL: file => `blob:${file.name}`, revokeObjectURL: noop },
    applyBackgroundImage: (url, _restore, mediaType) => mediaSelections.push({ url, mediaType }),
    activeViewerSettings: settings, novelContentElement: content, viewerContainer: viewer,
    STORAGE_KEYS: { CONTENT: 'content', SETTINGS: 'settings' }, getPositionStorageKey: () => 'position:old', getBookmarksStorageKey: () => 'bookmarks:old',
    TEXT_STORE_KEY: 'current_text',
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) {
        if (options.failWriteKey === key) {
          options.failWriteKey = null;
          throw new Error(`保存拒否: ${key}`);
        }
        storage.set(key, value);
      },
      removeItem: key => storage.delete(key)
    },
    console: { error: noop }, refreshExportButtons: noop, refreshDocumentNavigation: noop,
    updateReadingState: noop, applySettings: noop, saveSettings: noop, closeAllDrawers: noop,
    showErrorNotice: message => notices.push(message)
  };
  Object.defineProperties(importGlobals, {
    importedTextFileBlob: { get: () => importedSource.blob, set: value => { importedSource.blob = value; }, configurable: true },
    importedTextFileExtension: { get: () => importedSource.extension, set: value => { importedSource.extension = value; }, configurable: true }
  });
  const { handleFiles, getExportSource } = load(['handleFiles', 'getExportSource'], importGlobals);
  return { handleFiles, getExportSource, content, viewer, settings, storage, notices, originals, mediaWrites, mediaSelections };
}

for (const scenario of [
  {
    name: 'HTML内に#novel-contentがあればbodyより優先して本文・題名・保存内容へ反映する',
    articleHtml: '<h1>作品本文</h1><p>続き</p>',
    bodyHtml: '<p>本文ではないナビゲーション</p>',
    expectedHtml: '<h1>作品本文</h1><p>続き</p>'
  },
  {
    name: '#novel-contentがないHTMLではbodyを本文として取り込む',
    articleHtml: null,
    bodyHtml: '<h2>本文へフォールバック</h2><p>段落</p>',
    expectedHtml: '<h2>本文へフォールバック</h2><p>段落</p>'
  }
]) {
  test('インポート', scenario.name, async () => {
    const sanitizedInputs = [];
    const fixture = importFixture(() => {}, {
      sanitizedInputs,
      document: { createElement(tag) {
        assert.equal(tag, 'template');
        return { content: {
          querySelector(selector) {
            if (selector === 'title') return { textContent: ' 章タイトル ' };
            return selector === '#novel-content' && scenario.articleHtml !== null
              ? { innerHTML: scenario.articleHtml }
              : null;
          },
          get innerHTML() { return scenario.bodyHtml; },
          set innerHTML(source) { assert.equal(source, '<html>raw source</html>'); }
        }, get innerHTML() { return this.content.innerHTML; }, set innerHTML(source) { this.content.innerHTML = source; } };
      } }
    });
    await fixture.handleFiles([new File(['<html>raw source</html>'], 'chapter.html', { type: 'text/html' })]);
    assert.deepEqual(sanitizedInputs, [scenario.expectedHtml]);
    assert.equal(fixture.content.innerHTML, scenario.expectedHtml);
    assert.equal(fixture.storage.get('content'), scenario.expectedHtml);
    assert.equal(fixture.settings.documentTitle, '章タイトル');
    assert.equal(fixture.settings.fileStem, 'chapter');
    assert.equal(fixture.originals.length, 1);
    assert.equal(fixture.originals[0].extension, '.html');
    assert.deepEqual(fixture.notices, []);
  });
}

test('インポート', 'Markdownを取り込むと先頭へ移動し、元ファイルのバイト列を別に保存する', async () => {
  const fixture = importFixture();
  const file = new File(['# 雨\r\n本文'], '雨.第一章.MD');
  await fixture.handleFiles([file]);
  assert.equal(fixture.content.innerHTML, '<h1>雨</h1>\n<p>本文</p>');
  assert.equal(fixture.storage.get('content'), fixture.content.innerHTML);
  assert.equal(fixture.settings.fileStem, '雨.第一章');
  assert.deepEqual(fixture.viewer, { scrollTop: 0, scrollLeft: 0 });
  assert.equal(fixture.storage.has('position:old'), false);
  assert.equal(fixture.originals.length, 1);
  assert.equal(fixture.originals[0].extension, '.MD');
  assert.deepEqual(await fixture.originals[0].blob.arrayBuffer(), await file.arrayBuffer());
  assert.deepEqual(fixture.notices, []);
});

test('インポート', '複数の有効なテキストを順番に結合し、最後の元ファイルと題名情報を一度だけ保存する', async () => {
  const fixture = importFixture();
  const first = new File(['# 第一章\n本文A'], '第一章.md');
  const last = new File(['本文B'], '第二章.txt');
  await fixture.handleFiles([first, last]);

  assert.equal(fixture.content.innerHTML, '<h1>第一章</h1>\n<p>本文A</p><hr><p>本文B</p>');
  assert.equal(fixture.storage.get('content'), fixture.content.innerHTML);
  assert.equal(fixture.settings.fileStem, '第二章');
  assert.equal(fixture.settings.documentTitle, '');
  assert.equal(fixture.storage.get('settings'), JSON.stringify(fixture.settings));
  assert.deepEqual(fixture.originals.map(({ extension }) => extension), ['.txt']);
  assert.deepEqual(await fixture.originals[0].blob.arrayBuffer(), await last.arrayBuffer());
  assert.equal(fixture.storage.has('position:old'), false);
  assert.deepEqual(fixture.notices, []);
});

test('インポート', '混在リストでは有効ファイルだけを順番どおり反映し、失敗名を通知する', async () => {
  const fixture = importFixture();
  const accepted = new File(['有効本文'], '有効.md');
  await fixture.handleFiles([
    accepted,
    new File([Uint8Array.of(255, 255, 255)], '破損.txt'),
    new File(['?'], '非対応.bin')
  ]);

  assert.equal(fixture.content.innerHTML, '<p>有効本文</p>');
  assert.equal(fixture.storage.get('content'), fixture.content.innerHTML);
  assert.equal(fixture.settings.fileStem, '有効');
  assert.deepEqual(fixture.originals.map(({ extension }) => extension), ['.md']);
  assert.deepEqual(await fixture.originals[0].blob.arrayBuffer(), await accepted.arrayBuffer());
  assert.equal(fixture.storage.has('position:old'), false);
  assert.equal(fixture.notices.length, 1);
  assert.match(fixture.notices[0], /破損\.txt/);
  assert.match(fixture.notices[0], /非対応\.bin/);
});

test('インポート・背景メディア', 'MIMEが空でも拡張子で画像から動画へ置換し、保存失敗時は直前の表示を保つ', async () => {
  const options = {};
  const fixture = importFixture(() => {}, options);
  const image = new File(['image bytes'], 'cover.jpg', { type: '' });
  const video = new File(['video bytes'], 'scene.webm', { type: '' });
  await fixture.handleFiles([image, video]);

  assert.deepEqual(fixture.mediaWrites.map(({ mediaType, file }) => [mediaType, file.name]), [
    ['image', 'cover.jpg'], ['video', 'scene.webm']
  ]);
  assert.deepEqual(fixture.mediaSelections, [
    { url: 'blob:cover.jpg', mediaType: 'image' },
    { url: 'blob:scene.webm', mediaType: 'video' }
  ]);
  options.failMediaName = 'replacement.png';
  await fixture.handleFiles([new File(['new image'], 'replacement.png', { type: '' })]);

  assert.equal(fixture.mediaWrites.length, 2);
  assert.equal(fixture.mediaSelections.length, 2);
  assert.equal(fixture.notices.length, 1);
  assert.match(fixture.notices[0], /replacement\.png.*画像・動画を読み込めませんでした/);
  assert.doesNotMatch(fixture.notices[0], /媒体保存拒否/);
});

test('インポート・保存データ', '設定保存に失敗したら本文・位置・題名・元ファイルを以前の状態へ戻す', async () => {
  const options = {};
  const fixture = importFixture(() => {}, options);
  const original = new File(['保存済み本文'], 'original.txt');
  await fixture.handleFiles([original]);
  const previousContent = fixture.content.innerHTML;
  const previousExport = fixture.getExportSource();
  const previousSettings = JSON.stringify(fixture.settings);
  fixture.storage.set('position:old', '以前の位置');
  options.failWriteKey = 'settings';

  await fixture.handleFiles([new File(['置き換え本文'], 'replacement.md')]);

  assert.equal(fixture.content.innerHTML, previousContent);
  assert.equal(fixture.storage.get('content'), previousContent);
  assert.equal(fixture.storage.get('settings'), previousSettings);
  assert.equal(fixture.storage.get('position:old'), '以前の位置');
  assert.equal(fixture.settings.fileStem, 'original');
  assert.equal(fixture.getExportSource().blob, previousExport.blob);
  assert.equal(fixture.originals.length, 1);
  assert.equal(fixture.notices.length, 1);
  assert.match(fixture.notices[0], /replacement\.md.*本文を保存できませんでした/);
  assert.doesNotMatch(fixture.notices[0], /保存拒否: settings/);
});

test('インポート・保存データ', 'IndexedDBへの元ファイル保存に失敗したら本文と設定の保存を戻す', async () => {
  let rejectTextStore = false;
  const fixture = importFixture(() => {
    if (rejectTextStore) throw new Error('IndexedDB拒否');
  });
  const original = new File(['保存済み本文'], 'original.txt');
  await fixture.handleFiles([original]);
  const previousContent = fixture.content.innerHTML;
  const previousExport = fixture.getExportSource();
  const previousSettings = fixture.storage.get('settings');
  fixture.storage.set('position:old', '以前の位置');
  rejectTextStore = true;

  await fixture.handleFiles([new File(['置き換え本文'], 'replacement.md')]);

  assert.equal(fixture.content.innerHTML, previousContent);
  assert.equal(fixture.storage.get('content'), previousContent);
  assert.equal(fixture.storage.get('settings'), previousSettings);
  assert.equal(fixture.storage.get('position:old'), '以前の位置');
  assert.equal(fixture.settings.fileStem, 'original');
  assert.equal(fixture.getExportSource().blob, previousExport.blob);
  assert.equal(fixture.originals.length, 1);
  assert.match(fixture.notices[0], /replacement\.md.*本文を保存できませんでした/);
  assert.doesNotMatch(fixture.notices[0], /IndexedDB拒否/);
});

test('インポート', '破損した本文と非対応ファイルを通知し、既存表示と読書位置を保つ', async () => {
  const fixture = importFixture();
  await fixture.handleFiles([new File([Uint8Array.of(255, 255, 255)], '破損.txt'), new File(['?'], '非対応.bin')]);
  assert.equal(fixture.content.innerHTML, '<p>既存本文</p>');
  assert.equal(fixture.storage.get('position:old'), '以前の位置');
  assert.deepEqual(fixture.viewer, { scrollTop: 260, scrollLeft: -120 });
  assert.deepEqual(fixture.originals, []);
  assert.equal(fixture.notices.length, 1);
  assert.match(fixture.notices[0], /破損\.txt/);
  assert.match(fixture.notices[0], /非対応\.bin/);
});

for (const { width, decodeFails, error } of [
  { width: 10, decodeFails: false },
  { width: 0, decodeFails: false, error: /幅または高さ/ },
  { width: 10, decodeFails: true, error: /デコード失敗/ }
]) {
  test('インポート', error ? '画像検証の失敗後も一時URLを解放する ' + error.source : '画像の寸法を取得して一時URLを解放する', async () => {
    const image = { naturalWidth: width, naturalHeight: 20, async decode() {
      assert.equal(this.src, 'blob:temporary');
      if (decodeFails) throw new Error('デコード失敗');
    } };
    const file = new Blob(['image']);
    const revoked = [];
    const { validateImageFile } = load(['validateImageFile'], {
      Image: function () { return image; },
      URL: { createObjectURL: input => { assert.equal(input, file); return 'blob:temporary'; }, revokeObjectURL: url => revoked.push(url) }
    });
    if (error) await assert.rejects(validateImageFile(file), error);
    else {
      const result = await validateImageFile(file);
      assert.equal(result.width, 10);
      assert.equal(result.height, 20);
    }
    assert.deepEqual(revoked, ['blob:temporary']);
  });
}

test('エクスポート', '元ファイルをSHA-256と元の拡張子で命名し、同じBlobをダウンロードする', async () => {
  const source = new Blob(['abc']);
  const anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } };
  const revoked = [];
  let cleanup;
  const { downloadWithHash } = load(['downloadWithHash'], {
    Blob, crypto: webcrypto,
    document: { createElement: () => anchor, body: { appendChild: node => assert.equal(node, anchor) } },
    URL: { createObjectURL: blob => { assert.equal(blob, source); return 'blob:download'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: callback => { cleanup = callback; }
  });
  await downloadWithHash(source, '.TXT', '.txt');
  assert.equal(anchor.download, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.TXT');
  assert.equal(anchor.href, 'blob:download');
  assert.equal(anchor.clicked, true);
  assert.equal(anchor.removed, true);
  cleanup();
  assert.deepEqual(revoked, ['blob:download']);
});

test('エクスポート', 'SHA-256が利用できない環境では元ファイルのダウンロードを開始しない', async () => {
  const { downloadWithHash } = load(['downloadWithHash'], {
    Blob, crypto: {}, URL: { createObjectURL: () => assert.fail('ダウンロードURLが生成された') }
  });
  await assert.rejects(downloadWithHash(new Blob(['abc']), '.txt'), /SHA-256/);
});

const media = () => load(['arrayBufferToBase64', 'dataUrlToBlob'], { Blob, btoa, atob });

test('エクスポートHTML内のデータ', 'Base64変換のチャンク境界をまたいでも元のバイト列とMIMEが復元される', async () => {
  const { arrayBufferToBase64, dataUrlToBlob } = media();
  const bytes = Uint8Array.from({ length: 0x8001 }, (_, index) => index % 251);
  const encoded = arrayBufferToBase64(bytes.buffer);
  assert.equal(encoded, Buffer.from(bytes).toString('base64'));
  const restored = dataUrlToBlob('data:video/webm;base64,' + encoded);
  assert.equal(restored.type, 'video/webm');
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), bytes);
});

test('エクスポートHTML内のデータ', 'ペイロード区切りのないデータと不正なBase64を拒否する', () => {
  const { dataUrlToBlob } = media();
  assert.throws(() => dataUrlToBlob('data:image/png;base64'), error => error.message === localizationDictionary.ja['error.embeddedMedia']);
  assert.throws(() => dataUrlToBlob('data:image/png;base64,!!!'), { name: 'InvalidCharacterError' });
});

test('保存データとストレージ', '復元した背景移動量を画面サイズ内に制限する', () => {
  const block = html.slice(html.indexOf('function applyBackgroundImage'), html.indexOf('function updateDocumentTitle'));
  assert.match(block, /backgroundMediaState\.offsetX = Math\.max\(-window\.innerWidth, Math\.min\(window\.innerWidth, savedPosition\.bgOffsetX\)\)/);
  assert.match(block, /backgroundMediaState\.offsetY = Math\.max\(-window\.innerHeight, Math\.min\(window\.innerHeight, savedPosition\.bgOffsetY\)\)/);
});

test('エクスポートHTML内のデータ', '埋め込みData URLは背景メディア種別と一致するものだけを許可する', () => {
  const { isEmbeddableMediaDataUrl } = load(['isEmbeddableMediaDataUrl']);
  assert.equal(isEmbeddableMediaDataUrl('data:image/png;base64,AA==', 'image'), true);
  assert.equal(isEmbeddableMediaDataUrl('data:video/webm;base64,AA==', 'video'), true);
  assert.equal(isEmbeddableMediaDataUrl('data:image/png;base64,AA==', 'video'), false);
  assert.equal(isEmbeddableMediaDataUrl('blob:null/abc', 'image'), false);
});

test('エクスポートHTML内のデータ', '埋め込みペイロードは無効な媒体を空状態へ正規化する', () => {
  const { createEmbeddedDownloadData } = load(['createEmbeddedDownloadData', 'EMBEDDED_DATA_SCHEMA_VERSION']);
  const payload = createEmbeddedDownloadData('abc', '.txt', 'text/plain', 'blob:null/1', 'image', '.png');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.textBase64, 'abc');
  assert.equal(payload.mediaIncluded, false);
  assert.equal(payload.mediaType, null);
  assert.equal(payload.mediaDataUrl, '');
});

test('エクスポートHTML内のデータ', '初期化データを現行スキーマ版で書き出す', () => {
  const { createEmbeddedResetDefaults, EMBEDDED_DATA_SCHEMA_VERSION } =
    load(['createEmbeddedResetDefaults', 'EMBEDDED_DATA_SCHEMA_VERSION']);
  assert.deepEqual(JSON.parse(JSON.stringify(createEmbeddedResetDefaults({ theme: 'light' }, '<p>既定</p>'))), {
    schemaVersion: EMBEDDED_DATA_SCHEMA_VERSION,
    settings: { theme: 'light' },
    content: '<p>既定</p>'
  });
});

test('エクスポートHTML内のデータ', '埋め込みJSONを検証し、破損した媒体だけを本文元データから分離する', () => {
  const { readEmbeddedDownloadData } = load(['readEmbeddedDownloadData', 'isMediaType', 'EMBEDDED_DATA_SCHEMA_VERSION']);
  const valid = {
    schemaVersion: 1,
    textBase64: '5pel', textExtension: '.txt', textMimeType: 'text/plain',
    mediaIncluded: true, mediaType: 'image', mediaExtension: '.png', mediaDataUrl: 'data:image/png;base64,AA=='
  };
  assert.deepEqual(JSON.parse(JSON.stringify(readEmbeddedDownloadData({ textContent: JSON.stringify(valid) }))), {
    ...valid, mediaInvalid: false
  });

  const damagedMedia = readEmbeddedDownloadData({ textContent: JSON.stringify({
    ...valid, mediaDataUrl: 'data:image/png;base64,!!!'
  }) });
  assert.equal(damagedMedia.textBase64, valid.textBase64);
  assert.equal(damagedMedia.mediaIncluded, false);
  assert.equal(damagedMedia.mediaInvalid, true);
  assert.equal(readEmbeddedDownloadData({ textContent: JSON.stringify({ ...valid, textBase64: '!!!' }) }), null);
  assert.equal(readEmbeddedDownloadData({ textContent: JSON.stringify({ ...valid, schemaVersion: 99 }) }), null);
  const legacy = { ...valid };
  delete legacy.schemaVersion;
  assert.equal(readEmbeddedDownloadData({ textContent: JSON.stringify(legacy) }).schemaVersion, 1);
});

test('エクスポートHTML内のデータ', '埋め込みペイロードは本文と有効な画像・動画情報を保持する', () => {
  const { createEmbeddedDownloadData } = load(['createEmbeddedDownloadData', 'EMBEDDED_DATA_SCHEMA_VERSION']);
  const image = createEmbeddedDownloadData('txt', '.md', 'text/markdown', 'data:image/png;base64,AA==', 'image', '.png');
  assert.equal(JSON.stringify(image), JSON.stringify({ schemaVersion: 1, textBase64: 'txt', textExtension: '.md', textMimeType: 'text/markdown', mediaIncluded: true, mediaType: 'image', mediaExtension: '.png', mediaDataUrl: 'data:image/png;base64,AA==' }));
  const video = createEmbeddedDownloadData('', '', '', 'data:video/webm;base64,AA==', 'video', '.webm');
  assert.equal(video.mediaIncluded, true);
  assert.equal(video.mediaType, 'video');
});

test('エクスポート', '失敗を通知して再試行を案内し、例外の詳細をログに記録する', () => {
  const notices = [];
  const logs = [];
  const dictionary = JSON.parse(html.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const { reportOperationFailure } = load(['reportOperationFailure'], {
    currentLanguage: 'ja', localizationData: dictionary,
    translate: (key, values = {}) => (dictionary.ja[key] || key).replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(values[name] ?? '')),
    console: { error: (...args) => logs.push(args) },
    showErrorNotice: message => notices.push(message)
  });
  const failure = new Error('保存領域へのアクセスが拒否されました');
  reportOperationFailure('operation.htmlExport', failure);
  assert.match(notices[0], /HTMLのエクスポートに失敗しました。操作をやり直してください/);
  assert.ok(!notices[0].includes(failure.message));
  assert.deepEqual(logs, [[failure]]);
});

test('エクスポート', '個別ファイル行は実行時Blobと媒体種別に応じて生成対象を決める', () => {
  const { getExportButtonDefinitions } = load(['getExportButtonDefinitions'], { Blob });
  const text = new Blob(['本文'], { type: 'text/plain' });
  const image = new Blob(['画像'], { type: 'image/png' });
  const imageRows = getExportButtonDefinitions(text, image, 'image');
  assert.equal(JSON.stringify(imageRows.map(row => row.available)), JSON.stringify([true, true, false]));
  const videoRows = getExportButtonDefinitions(null, image, 'video');
  assert.equal(JSON.stringify(videoRows.map(row => row.available)), JSON.stringify([false, false, true]));
});

test('エクスポート', '削除操作はテキスト・画像・動画以外を対象にしない', () => {
  const { getRuntimeDataDeleteType } = load(['getRuntimeDataDeleteType']);
  assert.equal(getRuntimeDataDeleteType({ dataset: { deleteType: 'text' } }), 'text');
  assert.equal(getRuntimeDataDeleteType({ dataset: { deleteType: 'video' } }), 'video');
  assert.equal(getRuntimeDataDeleteType({ dataset: { deleteType: 'unknown' } }), null);
  assert.equal(getRuntimeDataDeleteType(null), null);
});

test('エクスポートHTML', '内蔵初期化データを復元し、不正なデータでは既定値を維持する', () => {
  const { readEmbeddedResetDefaults } = load(['readEmbeddedResetDefaults', 'EMBEDDED_DATA_SCHEMA_VERSION']);
  const fallback = { theme: 'light' };
  const element = { textContent: JSON.stringify({ schemaVersion: 1, settings: { theme: 'dark' }, content: '<p>初期本文</p>' }) };
  const restored = readEmbeddedResetDefaults(element, fallback, '<p>既定</p>');
  assert.equal(restored.settings.theme, 'dark');
  assert.equal(restored.content, '<p>初期本文</p>');
  const legacy = readEmbeddedResetDefaults({ textContent: JSON.stringify({ settings: { theme: 'dark' }, content: '<p>旧データ</p>' }) }, fallback, '<p>既定</p>');
  assert.equal(legacy.content, '<p>旧データ</p>');
  const invalid = readEmbeddedResetDefaults({ textContent: '{' }, fallback, '<p>既定</p>');
  assert.equal(invalid.settings, fallback);
  assert.equal(invalid.content, '<p>既定</p>');
  const future = readEmbeddedResetDefaults({ textContent: JSON.stringify({ schemaVersion: 99, settings: { theme: 'dark' }, content: '<p>未知</p>' }) }, fallback, '<p>既定</p>');
  assert.equal(future.settings, fallback);
  assert.equal(future.content, '<p>既定</p>');
  const normalized = readEmbeddedResetDefaults({
    textContent: JSON.stringify({ settings: { theme: 'attacker', fontSize: 999 }, content: '<script>bad()</script>' })
  }, { theme: 'light', fontSize: 16 }, '<p>既定</p>');
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.settings)), { theme: 'light', fontSize: 22 });
  assert.equal(normalized.content, '<script>bad()</script>');
});

test('エクスポートHTML', '内蔵ダウンロードデータをJSONとして読み込み、破損時は無効化する', () => {
  const { readEmbeddedDownloadData } = load(['readEmbeddedDownloadData', 'EMBEDDED_DATA_SCHEMA_VERSION']);
  assert.equal(readEmbeddedDownloadData({ textContent: '{"mediaType":"image"}' }), null);
  assert.equal(readEmbeddedDownloadData({ textContent: '{' }), null);
  assert.equal(readEmbeddedDownloadData(null), null);
});

for (const [mode, key, shift, expected] of [
  ['horizontal', 'ArrowDown', false, 180], ['horizontal', 'ArrowUp', false, -180],
  ['vertical', 'ArrowLeft', false, -180], ['vertical', 'ArrowRight', false, 180],
  ['horizontal', 'PageDown', false, 540], ['horizontal', 'PageUp', false, -540],
  ['vertical', 'PageDown', false, -540], ['vertical', 'PageUp', false, 540],
  ['horizontal', ' ', false, 540], ['horizontal', ' ', true, -540],
  ['vertical', ' ', false, -540], ['vertical', ' ', true, 540],
  ['horizontal', 'ArrowLeft', false, null], ['vertical', 'ArrowDown', false, null]
]) {
  test('ページ送り', mode + 'で' + (key === ' ' ? (shift ? 'Shift+Space' : 'Space') : key) + 'を押したときの移動量は' + expected, () => {
    const { getPageScrollDelta } = load(['getPageScrollDelta']);
    assert.equal(getPageScrollDelta(mode, key, shift, 540), expected);
  });
}

function readingFixture() {
  const values = new Map();
  const settings = { writingMode: 'horizontal' };
  const viewer = { scrollHeight: 1000, clientHeight: 500, scrollWidth: 1400, clientWidth: 400, scrollTop: 125, scrollLeft: 0 };
  const visits = [];
  const messages = [];
  const context = {
    activeViewerSettings: settings, viewerContainer: viewer,
    documentKey: 'first', getPositionStorageKey: () => 'hitohira_position:' + context.documentKey,
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    findCurrentReadingContext: () => ({ currentHeading: 'chapter', lineIndex: 0 }),
    novelContentElement: { querySelectorAll: () => [{ scrollIntoView: options => visits.push(options) }] },
    console: { warn: error => messages.push(error), error: (...args) => messages.push(args) },
    failedLocalStorageWrites: new Set(),
    reportLocalStorageWrite(key, error) {
      if (!context.failedLocalStorageWrites.has(key)) {
        context.failedLocalStorageWrites.add(key);
        messages.push(`notice:${key}:${error.message}`);
      }
    },
    confirmLocalStorageWrite(key) {
      context.failedLocalStorageWrites.delete(key);
    },
    backgroundMediaOffsetX: 15, backgroundMediaOffsetY: -5, isRestoringReadingPosition: false, changingSavedData: false
  };
  const { computeProgressRatio } = load(['computeProgressRatio'], context);
  Object.assign(context, { computeProgressRatio });
  const operations = load(['executeSavePosition', 'restoreReadingPosition'], context);
  return { ...operations, computeProgressRatio, context, values, viewer, settings, visits, messages };
}

test('目次・読書進捗・読書位置', '書字方向に合った軸で進捗を求め、範囲外とスクロール不能を扱う', () => {
  const fixture = readingFixture();
  assert.equal(fixture.computeProgressRatio(), 0.25);
  fixture.viewer.scrollTop = -10;
  assert.equal(fixture.computeProgressRatio(), 0);
  fixture.settings.writingMode = 'vertical';
  fixture.viewer.scrollLeft = -400;
  assert.equal(fixture.computeProgressRatio(), 0.4);
  fixture.viewer.scrollLeft = -1200;
  assert.equal(fixture.computeProgressRatio(), 1);
  fixture.viewer.scrollWidth = fixture.viewer.clientWidth;
  assert.equal(fixture.computeProgressRatio(), 0);
});

test('保存データとストレージ', '設定保存の失敗を一度通知し、再保存後に失敗状態を解除する', async () => {
  const settings = { theme: 'light' };
  const failed = new Set();
  const notices = [];
  let rejectWrite = true;
  const { saveSettings, flushSettingsSave } = load(['saveSettings', 'flushSettingsSave'], {
    activeViewerSettings: settings,
    STORAGE_KEYS: { SETTINGS: 'settings' },
    localStorage: { setItem(key, value) { if (rejectWrite) throw new Error('拒否'); this.value = [key, value]; } },
    failedLocalStorageWrites: failed,
    reportLocalStorageWrite(key, error) {
      if (!failed.has(key)) { failed.add(key); notices.push(error.message); }
    },
    confirmLocalStorageWrite(key) { failed.delete(key); },
    scheduleHtmlExportSizeUpdate() {}
  });
  saveSettings();
  saveSettings();
  await flushSettingsSave();
  assert.deepEqual(notices, ['拒否']);
  assert.equal(failed.has('settings'), true);
  rejectWrite = false;
  saveSettings();
  await flushSettingsSave();
  assert.equal(failed.has('settings'), false);
});

test('保存データとストレージ', '背景位置の保存失敗を通知し、保存領域復旧後に位置を保存する', () => {
  const values = new Map();
  const failures = [];
  let rejectWrite = true;
  const globals = {
    getPositionStorageKey: () => 'position',
    backgroundMediaOffsetX: 24, backgroundMediaOffsetY: -8,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem(key, value) { if (rejectWrite) throw new Error('拒否'); values.set(key, value); }
    },
    reportLocalStorageWrite(key, error) { failures.push([key, error.message]); },
    confirmLocalStorageWrite() {}
  };
  const { saveBackgroundPosition } = load(['saveBackgroundPosition'], globals);
  saveBackgroundPosition();
  assert.deepEqual(failures, [['position', '拒否']]);
  rejectWrite = false;
  saveBackgroundPosition();
  assert.deepEqual(JSON.parse(values.get('position')), { bgOffsetX: 24, bgOffsetY: -8 });
});

test('目次・読書進捗・読書位置', '横書き・縦書きの見出し境界と現在ブロックを実DOM矩形から選ぶ', () => {
  const heading = (id, top, right) => ({ id, getBoundingClientRect: () => ({ top, right }) });
  const block = (bottom, left) => ({ getBoundingClientRect: () => ({ bottom, left }) });
  const headings = [heading('heading-0', 40, 650), heading('heading-1', 110, 510), heading('heading-2', 220, 390)];
  const blocks = [block(90, 520), block(130, 480), block(240, 350)];
  const settings = { writingMode: 'horizontal' };
  const viewer = { getBoundingClientRect: () => ({ top: 120, right: 500 }) };
  const { findCurrentReadingContext } = load(['findCurrentReadingContext'], {
      activeViewerSettings: settings, viewerContainer: viewer,
      tableOfContentsEntries: headings.map(element => ({ id: element.id, element })),
      novelContentElement: { querySelectorAll: () => blocks }
    });

  const horizontal = findCurrentReadingContext();
  assert.equal(horizontal.currentHeading, 'heading-1');
  assert.equal(horizontal.lineIndex, 1);
  settings.writingMode = 'vertical';
  const vertical = findCurrentReadingContext();
  assert.equal(vertical.currentHeading, 'heading-1');
  assert.equal(vertical.lineIndex, 1);
  settings.writingMode = 'horizontal';
  const noHeadings = load(['findCurrentReadingContext'], {
      activeViewerSettings: settings, viewerContainer: viewer, tableOfContentsEntries: [],
      novelContentElement: { querySelectorAll: () => [] }
    }).findCurrentReadingContext;
  const empty = noHeadings();
  assert.equal(empty.currentHeading, null);
  assert.equal(empty.lineIndex, 0);
});

test('保存データとストレージ', '保存した読書位置は別文書へ反映せず、同じ文書でスクロール位置を復元する', () => {
  const fixture = readingFixture();
  fixture.executeSavePosition();
  const saved = JSON.parse(fixture.values.get('hitohira_position:first'));
  assert.equal(saved.progressRatio, 0.25);
  assert.equal(saved.headingId, 'chapter');
  assert.equal(saved.lineIndex, 0);
  assert.equal(saved.bgOffsetX, 15);
  assert.equal(saved.bgOffsetY, -5);

  fixture.viewer.scrollTop = 0;
  fixture.context.documentKey = 'second';
  fixture.restoreReadingPosition();
  assert.equal(fixture.viewer.scrollTop, 0);
  fixture.context.documentKey = 'first';
  fixture.restoreReadingPosition();
  assert.equal(fixture.viewer.scrollTop, 125);
  fixture.values.set('hitohira_position:first', JSON.stringify({ writingMode: 'horizontal', scrollTop: 9000, scrollLeft: -9000 }));
  fixture.restoreReadingPosition();
  assert.equal(fixture.viewer.scrollTop, 500);
  assert.equal(fixture.viewer.scrollLeft, -1000);
  fixture.values.set('hitohira_position:first', JSON.stringify({ writingMode: 'horizontal', scrollTop: -20, scrollLeft: 20 }));
  fixture.restoreReadingPosition();
  assert.equal(fixture.viewer.scrollTop, 0);
  assert.equal(fixture.viewer.scrollLeft, 0);
});

test('保存データとストレージ', '読書位置の読み取り拒否・破損JSONでは現在位置を維持して続行する', () => {
  const rejectedRead = readingFixture();
  rejectedRead.viewer.scrollTop = 210;
  rejectedRead.context.localStorage.getItem = () => { throw new Error('読み取り拒否'); };
  rejectedRead.restoreReadingPosition();
  assert.equal(rejectedRead.viewer.scrollTop, 210);
  assert.ok(rejectedRead.messages.some(message => String(message).includes('保存済み読書位置を読み出せませんでした')));

  const malformedValue = readingFixture();
  malformedValue.viewer.scrollTop = 315;
  malformedValue.context.localStorage.getItem = () => '{';
  malformedValue.restoreReadingPosition();
  assert.equal(malformedValue.viewer.scrollTop, 315);
  assert.ok(malformedValue.messages.some(message => String(message).includes('保存済み読書位置を復元できませんでした')));
});

test('目次・読書進捗・読書位置', '書字方向が変わったときは本文ブロックを優先し、存在しなければ進捗を使う', () => {
  const fixture = readingFixture();
  fixture.executeSavePosition();
  fixture.settings.writingMode = 'vertical';
  fixture.restoreReadingPosition();
  assert.equal(fixture.visits.length, 1);
  assert.equal(fixture.visits[0].block, 'start');
  assert.equal(fixture.viewer.scrollLeft, 0);
  fixture.values.set('hitohira_position:first', JSON.stringify({ writingMode: 'horizontal', lineIndex: 4, progressRatio: 0.25 }));
  fixture.restoreReadingPosition();
  assert.equal(fixture.viewer.scrollLeft, -250);
  assert.equal(fixture.visits.length, 1);
});

test('保存データとストレージ', '読書位置の保存失敗を通知し、復旧後の保存で未保存状態を解消する', () => {
  const fixture = readingFixture();
  const originalTop = fixture.viewer.scrollTop;
  fixture.context.localStorage.setItem = () => { throw new Error('容量不足'); };
  fixture.executeSavePosition();
  fixture.executeSavePosition();
  assert.equal(fixture.messages.filter(message => typeof message === 'string' && message.startsWith('notice:')).length, 1);
  assert.equal(fixture.context.failedLocalStorageWrites.has('hitohira_position:first'), true);
  assert.equal(fixture.viewer.scrollTop, originalTop);
  fixture.context.localStorage.setItem = (key, value) => fixture.values.set(key, value);
  fixture.executeSavePosition();
  assert.equal(fixture.context.failedLocalStorageWrites.has('hitohira_position:first'), false);
  assert.equal(JSON.parse(fixture.values.get('hitohira_position:first')).scrollTop, originalTop);
});

test('目次・読書進捗・読書位置', '遅延画像の描画後に位置を復元し、復元中の保存を抑止する', async () => {
  const saved = new Map([['position', JSON.stringify({ writingMode: 'horizontal', scrollTop: 100, scrollLeft: -40 })]]);
  const writes = [];
  let savePosition;
  let scrollTop = 12;
  let scrollLeft = -10;
  let resolveImageDecode;
  const image = { complete: false, decode: () => new Promise(resolve => { resolveImageDecode = resolve; }) };
  const context = {
    novelContentElement: { querySelectorAll: selector => selector === 'img' ? [image] : [{ getBoundingClientRect: () => ({ bottom: 120, left: 400 }) }] },
    tableOfContentsEntries: [],
    activeViewerSettings: { writingMode: 'horizontal' },
    viewerContainer: {
      clientHeight: 100, scrollHeight: 500, clientWidth: 100, scrollWidth: 500,
      getBoundingClientRect: () => ({ top: 0, right: 500 }),
      get scrollTop() { return scrollTop; },
      set scrollTop(value) { scrollTop = value; savePosition?.(); },
      get scrollLeft() { return scrollLeft; },
      set scrollLeft(value) { scrollLeft = value; savePosition?.(); }
    },
    localStorage: {
      getItem: key => saved.get(key) ?? null,
      setItem(key, value) { writes.push([key, value]); saved.set(key, value); }
    },
    failedLocalStorageWrites: new Set(),
    reportLocalStorageWrite(key, error) { throw error; },
    confirmLocalStorageWrite(key) { context.failedLocalStorageWrites.delete(key); },
    getPositionStorageKey: () => 'position',
    document: { fonts: { ready: Promise.resolve() } },
    requestAnimationFrame(callback) { callback(); return 1; },
    backgroundMediaOffsetX: 0, backgroundMediaOffsetY: 0,
    changingSavedData: false, isRestoringReadingPosition: false
  };
  const operations = load(
    ['computeProgressRatio', 'findCurrentReadingContext', 'executeSavePosition', 'restoreReadingPosition', 'restoreReadingPositionAfterLayout'], context);
  savePosition = operations.executeSavePosition;

  let completed = false;
  const restoration = operations.restoreReadingPositionAfterLayout().then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, '画像のデコード完了を待たずに位置復元が完了しました');
  assert.equal(writes.length, 0);

  resolveImageDecode();
  await restoration;

  assert.equal(scrollTop, 100);
  assert.equal(scrollLeft, -40);
  assert.equal(writes.length, 1, 'レイアウト確定前のスクロール位置が一時保存されました');
  assert.equal(JSON.parse(saved.get('position')).scrollTop, 100);
});

function mediaStorageFixture(localStorage = { getItem: () => null, setItem() {}, removeItem() {} }) {
  const records = new Map();
  let closed = 0;
  let nextWriteError;
  const database = {
    close() { closed++; },
    transaction(storeName, mode) {
      assert.equal(storeName, 'background_media');
      const transaction = {};
      const updates = [];
      transaction.objectStore = name => {
        assert.equal(name, storeName);
        const write = update => {
          assert.equal(mode, 'readwrite');
          updates.push(update);
          if (updates.length > 1) return;
          queueMicrotask(() => {
            if (nextWriteError) {
              transaction.onerror?.();
              transaction.error = nextWriteError;
              nextWriteError = null;
              transaction.onabort();
              return;
            }
            updates.forEach(commit => commit());
            transaction.oncomplete();
          });
        };
        return {
          put: (value, key) => write(() => records.set(key, value)),
          delete: key => write(() => records.delete(key)),
          get(key) {
            assert.equal(mode, 'readonly');
            const request = { result: records.get(key) };
            queueMicrotask(() => request.onsuccess());
            return request;
          }
        };
      };
      return transaction;
    }
  };
  const indexedDB = {
    open(name, version) {
    assert.equal(name, 'hitohira_media_db');
      assert.equal(version, 1);
      const request = { result: database };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };
  const { getFileExtension } = load(['getFileExtension']);
  const operations = load(['storeBackgroundMedia', 'loadBackgroundMedia', 'deleteMediaRecords', 'changeSavedData', 'commitSavedData', 'storeImportedText', 'loadImportedText', 'changingSavedData'],
    { indexedDB, window: { indexedDB }, getFileExtension, localStorage,
      MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1,
      MEDIA_STORE_NAME: 'background_media', MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text' });
  return { ...operations, indexedDB, records, closed: () => closed, abortNextWrite: error => { nextWriteError = error; } };
}

test('保存データとストレージ', '復旧記録の型・キー・操作を検証し、不正値をすべて拒否する', () => {
  const isValid = load(['isValidSavedDataTransaction'], {
    STORAGE_KEYS: { SETTINGS: 'settings', CONTENT: 'content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', MEDIA_TRANSACTION_KEY: '__pending_transaction__',
    SAVED_DATA_REVISION_KEY: 'revision'
  }).isValidSavedDataTransaction;
  assert.equal(isValid({ version: 1, localStorage: [['hitohira_content', '<p>本文</p>']], indexedDb: [{ type: 'put', key: 'current_text', value: { blob: {} } }] }), true);
  for (const invalid of [
    { version: 2, localStorage: [], indexedDb: [] },
    { version: 1, localStorage: [['unknown', 'value']], indexedDb: [] },
    { version: 1, localStorage: [['content', 12]], indexedDb: [] },
    { version: 1, localStorage: [], indexedDb: [{ type: 'clear', key: 'current_text' }] },
    { version: 1, localStorage: [], indexedDb: [{ type: 'put', key: 'unknown', value: {} }] },
    { version: 1, localStorage: [], indexedDb: [{ type: 'put', key: 'current_text', value: null }] }
  ]) assert.equal(isValid(invalid), false);
});

test('保存データとストレージ', '中断記録を次回起動時に再適用してLocalStorageとIndexedDBを揃える', async () => {
  const saved = new Map();
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  const importedText = { blob: new Blob(['復旧本文']), fileExtension: '.txt', updatedAt: 123 };
  storage.records.set('__pending_transaction__', {
    version: 1, localStorage: [['hitohira_content', '<p>復旧本文</p>']],
    indexedDb: [{ type: 'put', key: 'current_text', value: importedText }]
  });
  saved.set('hitohira_pending_saved_data_transaction', JSON.stringify({
    version: 1, hasIndexedDbOperations: true
  }));
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB: storage.indexedDB, window: { indexedDB: storage.indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  assert.equal(await recoverSavedDataTransaction(), true);
  assert.equal(saved.get('hitohira_content'), '<p>復旧本文</p>');
  assert.equal(saved.has('hitohira_pending_saved_data_transaction'), false);
  assert.equal(storage.records.has('__pending_transaction__'), false);
  assert.equal((await storage.loadImportedText()).blob, importedText.blob);
  assert.equal(await recoverSavedDataTransaction(), false);
});

test('保存データとストレージ', '不正な復旧マーカーは保持して復旧を中止する', async () => {
  const saved = new Map([['hitohira_pending_saved_data_transaction', '{']]);
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB: storage.indexedDB, window: { indexedDB: storage.indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  await assert.rejects(recoverSavedDataTransaction(), error => error.name === 'SyntaxError');
  assert.equal(saved.get('hitohira_pending_saved_data_transaction'), '{');
  assert.equal(storage.records.has('__pending_transaction__'), false);
});

test('保存データとストレージ', '復旧マーカーに対応するIndexedDB記録がない場合はマーカーを保持する', async () => {
  const serialized = JSON.stringify({ version: 1, hasIndexedDbOperations: true });
  const saved = new Map([['hitohira_pending_saved_data_transaction', serialized]]);
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB: storage.indexedDB, window: { indexedDB: storage.indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  await assert.rejects(recoverSavedDataTransaction(), error => error.message === localizationDictionary.ja['error.savedDataRecovery']);
  assert.equal(saved.get('hitohira_pending_saved_data_transaction'), serialized);
});

test('保存データとストレージ', '未知形式の復旧マーカーは保持して復旧を中止する', async () => {
  const serialized = JSON.stringify({ version: 2, hasIndexedDbOperations: true });
  const saved = new Map([['hitohira_pending_saved_data_transaction', serialized]]);
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB: storage.indexedDB, window: { indexedDB: storage.indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  await assert.rejects(recoverSavedDataTransaction(), error => error.message === localizationDictionary.ja['error.savedDataRecovery']);
  assert.equal(saved.get('hitohira_pending_saved_data_transaction'), serialized);
});

test('保存データとストレージ', '不正なIndexedDB復旧記録を保持して起動用復旧を中止する', async () => {
  const serialized = JSON.stringify({ version: 1, hasIndexedDbOperations: true });
  const saved = new Map([['hitohira_pending_saved_data_transaction', serialized]]);
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  storage.records.set('__pending_transaction__', { version: 2, localStorage: [], indexedDb: [] });
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB: storage.indexedDB, window: { indexedDB: storage.indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  await assert.rejects(recoverSavedDataTransaction(), error => error.message === localizationDictionary.ja['error.savedDataRecovery']);
  assert.equal(saved.get('hitohira_pending_saved_data_transaction'), serialized);
  assert.equal(storage.records.get('__pending_transaction__').version, 2);
});

test('保存データとストレージ', '復旧記録の不正なキーや操作を適用せず記録を保持する', async () => {
  const serialized = JSON.stringify({ version: 1, hasIndexedDbOperations: true });
  const saved = new Map([['hitohira_pending_saved_data_transaction', serialized]]);
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  storage.records.set('__pending_transaction__', {
    version: 1,
    localStorage: [['unknown', 'attacker-controlled']],
    indexedDb: [{ type: 'clear', key: 'current_text' }]
  });
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB: storage.indexedDB, window: { indexedDB: storage.indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  await assert.rejects(recoverSavedDataTransaction(), error => error.message === localizationDictionary.ja['error.savedDataRecovery']);
  assert.equal(saved.has('hitohira_saved_data_lock'), false);
  assert.equal(storage.records.has('current_text'), false);
  assert.equal(storage.records.has('__pending_transaction__'), true);
  assert.equal(saved.get('hitohira_pending_saved_data_transaction'), serialized);
});

test('保存データとストレージ', '復旧の再適用に失敗した場合はマーカーとステージ記録を残す', async () => {
  const serialized = JSON.stringify({ version: 1, hasIndexedDbOperations: true });
  const saved = new Map([['hitohira_pending_saved_data_transaction', serialized]]);
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem(key, value) { if (key === 'hitohira_content') throw new Error('LocalStorage書込拒否'); saved.set(key, value); },
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  storage.records.set('__pending_transaction__', {
    version: 1, localStorage: [['hitohira_content', '<p>復旧本文</p>']], indexedDb: []
  });
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB: storage.indexedDB, window: { indexedDB: storage.indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  await assert.rejects(recoverSavedDataTransaction(), /LocalStorage書込拒否/);
  assert.equal(saved.get('hitohira_pending_saved_data_transaction'), serialized);
  assert.equal(storage.records.get('__pending_transaction__').localStorage[0][1], '<p>復旧本文</p>');
});

test('保存データとストレージ', 'LocalStorageマーカーがない孤立した復旧記録でIndexedDB接続を開かない', async () => {
  let opened = 0;
  const indexedDB = { open() { opened++; throw new Error('孤立記録を検査できません'); } };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { recoverSavedDataTransaction } = load(['recoverSavedDataTransaction'], {
    indexedDB, window: { indexedDB }, localStorage,
    MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1, MEDIA_STORE_NAME: 'background_media',
    STORAGE_KEYS: { SETTINGS: 'hitohira_settings', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks', CONTENT: 'hitohira_content' },
    MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', SAVED_DATA_REVISION_KEY: 'hitohira_saved_data_revision'
  });

  await assert.rejects(recoverSavedDataTransaction(), /孤立記録を検査できません/);
  assert.equal(opened, 1);
});

test('保存データとストレージ', '通常の複数保存は完了後に中断記録を消し、LocalStorage失敗時は元へ戻す', async () => {
  const saved = new Map([['hitohira_content', '<p>旧本文</p>']]);
  let rejectedKey = null;
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem(key, value) {
      if (key === rejectedKey) { rejectedKey = null; throw new Error(`拒否: ${key}`); }
      saved.set(key, value);
    },
    removeItem: key => saved.delete(key)
  };
  const storage = mediaStorageFixture(localStorage);
  assert.equal(await storage.commitSavedData(
    [['hitohira_content', '<p>新本文</p>'], ['hitohira_settings', '{"theme":"dark"}']],
    [{ type: 'put', key: 'current_text', value: { blob: new Blob(['新原文']), fileExtension: '.txt' } }]
  ), true);
  assert.equal(saved.get('hitohira_content'), '<p>新本文</p>');
  assert.equal(saved.has('hitohira_pending_saved_data_transaction'), false);
  assert.equal(storage.records.has('__pending_transaction__'), false);
  assert.equal((await storage.loadImportedText()).fileExtension, '.txt');

  rejectedKey = 'hitohira_settings';
  await assert.rejects(storage.commitSavedData(
    [['hitohira_content', '<p>誤更新</p>'], ['hitohira_settings', '{"theme":"light"}']],
    [{ type: 'delete', key: 'current_text' }]
  ), /拒否: hitohira_settings/);
  assert.equal(saved.get('hitohira_content'), '<p>新本文</p>');
  assert.equal(saved.get('hitohira_settings'), '{"theme":"dark"}');
  assert.equal(saved.has('hitohira_pending_saved_data_transaction'), false);
  assert.equal(storage.records.has('__pending_transaction__'), false);
  assert.ok(await storage.loadImportedText());
});

test('保存データとストレージ', 'IndexedDBの初回作成・オープン拒否・読み取り失敗でストアを作成し接続を閉じる', async () => {
  const storeNames = [];
  let closed = 0;
  const database = {
    objectStoreNames: { contains: name => storeNames.includes(name) },
    createObjectStore(name) { storeNames.push(name); },
    close() { closed++; },
    transaction(name, mode) {
      assert.equal(name, 'background_media');
      assert.equal(mode, 'readonly');
      return { objectStore: () => ({ get: () => {
        const request = { error: new Error('読み取り拒否') };
        queueMicrotask(() => request.onerror());
        return request;
      } }) };
    }
  };
  let failOpen = false;
  const indexedDB = {
    open(name, version) {
      assert.equal(name, 'hitohira_media_db');
      assert.equal(version, 1);
      const request = { result: database, error: new Error('オープン拒否') };
      queueMicrotask(() => failOpen ? request.onerror() : (request.onupgradeneeded(), request.onsuccess()));
      return request;
    }
  };
  const operations = load(['openMediaDatabase', 'loadImportedText'], {
      indexedDB, window: { indexedDB }, MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1,
      MEDIA_STORE_NAME: 'background_media', MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text'
    });

  const opened = await operations.openMediaDatabase();
  assert.equal(opened, database);
  assert.deepEqual(storeNames, ['background_media']);
  opened.close();
  failOpen = true;
  await assert.rejects(operations.openMediaDatabase(), /オープン拒否/);
  await assert.rejects(operations.loadImportedText(), /オープン拒否/);
  assert.equal(closed, 1, '接続が開いていないときにcloseを呼びません');

  failOpen = false;
  await assert.rejects(operations.loadImportedText(), /読み取り拒否/);
  assert.equal(closed, 2, '読み取り失敗でもDB接続を閉じます');

  const unavailable = load(['openMediaDatabase'], {
    window: {}, MEDIA_DB_NAME: 'hitohira_media_db', MEDIA_DB_VERSION: 1,
    MEDIA_STORE_NAME: 'background_media', MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text'
  }).openMediaDatabase;
  await assert.rejects(unavailable(), error => error.message === localizationDictionary.ja['error.storage']);

  const startupCalls = [];
  const restoreDeferredData = load(['restoreDeferredData'], {
      loadBackgroundMedia: async () => { throw new Error('保存領域の読み取り拒否'); },
      loadImportedText: async () => null,
      activeViewerSettings: {}, refreshExportButtons: () => startupCalls.push('refresh'),
      applySettings: () => startupCalls.push('settings'),
      restoreReadingPositionAfterLayout: async () => startupCalls.push('position'),
      updateReadingState: () => startupCalls.push('reading'),
      updateResetButtonState: () => startupCalls.push('reset'),
      scheduleHtmlExportSizeUpdate: () => startupCalls.push('size')
    }).restoreDeferredData;
  await restoreDeferredData(false);
  assert.deepEqual(startupCalls, ['refresh', 'settings', 'position', 'reading', 'reset', 'size'],
    'DB読み取り失敗時も本文表示後の起動処理を継続します');
});

test('保存データとストレージ', '動画で画像を置き換えても本文の元ファイルを維持し、本文だけを削除できる', async () => {
  const storage = mediaStorageFixture();
  const text = new Blob(['原文']);
  const image = new File(['image'], 'paper.PNG');
  const video = new File(['video'], 'rain.WebM');
  await storage.storeImportedText(text, '.MD');
  await storage.storeBackgroundMedia(image, 'image');
  assert.equal((await storage.loadBackgroundMedia()).fileExtension, '.PNG');
  await storage.storeBackgroundMedia(video, 'video');
  assert.equal(storage.records.size, 2);
  const original = await storage.loadImportedText();
  assert.equal(original.fileExtension, '.MD');
  assert.equal(original.blob, text);
  await storage.deleteMediaRecords(['current_text']);
  assert.equal(await storage.loadImportedText(), null);
  const background = await storage.loadBackgroundMedia();
  assert.equal(background.blob, video);
  assert.equal(background.mediaType, 'video');
  assert.equal(background.fileExtension, '.WebM');
});

test('保存データとストレージ', '容量超過で背景の置き換えが中断しても以前の画像を保持し、削除後に再保存できる', async () => {
  const storage = mediaStorageFixture();
  const image = new File(['image'], 'paper.png');
  const video = new File(['video'], 'rain.webm');
  const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError');
  await storage.storeBackgroundMedia(image, 'image');
  storage.abortNextWrite(quotaError);
  await assert.rejects(storage.storeBackgroundMedia(video, 'video'), error => error === quotaError);
  assert.equal((await storage.loadBackgroundMedia()).blob, image);
  assert.equal(storage.closed(), 3);
  await storage.deleteMediaRecords(['current']);
  assert.equal(await storage.loadBackgroundMedia(), null);
  await storage.storeBackgroundMedia(video, 'video');
  assert.equal((await storage.loadBackgroundMedia()).blob, video);
});

async function removalFixture(exported = false) {
  const defaults = { theme: 'light', fileStem: '', documentTitle: '' };
  const settings = { ...defaults, theme: 'dark', fileStem: 'chapter' };
  const defaultContent = '<p>既定本文</p>';
  const content = { innerHTML: '<p>保存済み本文</p>' };
  const viewer = { scrollTop: 80, scrollLeft: -40 };
  const resetButton = { setAttribute(name, value) { this[name] = value; } };
  const embedded = { textContent: JSON.stringify({ settings: defaults, content: defaultContent }) };
  const positionKey = exported ? 'hitohira_position:exported' : 'hitohira_position:default';
  const bookmarkKey = 'hitohira_bookmarks:document';
  const saved = new Map([['hitohira_settings', JSON.stringify(settings)], ['hitohira_content', content.innerHTML], [positionKey, '{"scrollTop":80}'], [bookmarkKey, '[{"id":"a","name":"続き","position":{"scrollTop":20}}]']]);
  const notices = [];
  const local = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  const database = mediaStorageFixture(local);
  const text = new File(['原文'], 'chapter.txt');
  const image = new File(['画像'], 'paper.png');
  await database.storeImportedText(text, '.txt');
  await database.storeBackgroundMedia(image, 'image');
  const handlers = {};
  const register = type => ({ addEventListener(_, listener) { handlers[type] = listener; } });
  const state = { text, textExtension: '.txt', background: image, backgroundExtension: '.png', backgroundUrl: 'blob:image' };
  const globals = {
      document: {
        documentElement: { dataset: { exported: String(exported) } },
        getElementById: () => embedded,
        createElement: () => ({ querySelectorAll: () => [] })
      },
      DEFAULT_SETTINGS: exported ? { ...settings } : defaults, activeViewerSettings: settings, viewerResetDefaults: null,
      THEME_PALETTES: { light: {} }, themeDerivedColors: {},
      novelContentElement: content, initialNovelContentHtml: exported ? content.innerHTML : defaultContent, viewerContainer: viewer,
      sanitizeHTML: markup => markup,
      btnResetAll: Object.assign(resetButton, register('reset')), loadedFileDownloads: register('delete'),
      STORAGE_KEYS: { SETTINGS: 'hitohira_settings', CONTENT: 'hitohira_content', POSITION: 'hitohira_position', BOOKMARKS: 'hitohira_bookmarks' }, getPositionStorageKey: () => positionKey, getBookmarksStorageKey: () => bookmarkKey,
      readBookmarks: () => { try { return JSON.parse(local.getItem(bookmarkKey) || '[]'); } catch { return []; } },
      MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', changeSavedData: database.changeSavedData,
      getRuntimeDataDeleteType: button => button.dataset.deleteType,
      backgroundMediaType: 'image', backgroundMediaDataUrl: state.backgroundUrl,
      applyBackgroundImage(url) { if (url === null) state.backgroundUrl = null; },
      refreshExportButtons() {}, refreshDocumentNavigation() {}, updateReadingState() {}, closeAllDrawers() {},
      applySettings() {},
      reportOperationFailure: (label, error) => notices.push({ label, error })
  };
  for (const [name, key] of [['importedTextFileBlob', 'text'], ['importedTextFileExtension', 'textExtension'],
    ['backgroundMediaFileBlob', 'background'], ['backgroundMediaFileExtension', 'backgroundExtension'],
    ['backgroundMediaDataUrl', 'backgroundUrl']]) {
    Object.defineProperty(globals, name, { get: () => state[key], set: value => { state[key] = value; }, configurable: true });
  }
  const operations = load(['initializeLoadedFileDownloadHandler', 'initializeResetHandler', 'updateResetButtonState', 'EMBEDDED_DATA_SCHEMA_VERSION'], globals);
  operations.initializeLoadedFileDownloadHandler();
  operations.initializeResetHandler();
  const updateResetButtonState = operations.updateResetButtonState;
  const pressDelete = type => handlers.delete({ target: { closest: () => ({ dataset: { deleteType: type } }) } });
  updateResetButtonState();
  return { saved, local, database, snapshot: () => ({ settings: { ...settings }, text: state.text, background: state.background }), content, viewer, defaultContent, embedded, notices, resetButton,
    updateResetButtonState, pressDelete, reset: handlers.reset };
}

test('初期化', '二つの元ファイルの削除が中断された場合は両方と保存値を保持する', async () => {
  const f = await removalFixture();
  const initial = f.snapshot();
  const previous = new Map(f.saved);
  const error = new Error('トランザクションの中断');
  f.database.abortNextWrite(error);
  await f.reset();
  assert.deepEqual(f.saved, previous);
  assert.deepEqual(f.snapshot(), initial);
  assert.equal((await f.database.loadImportedText()).blob, initial.text);
  assert.equal((await f.database.loadBackgroundMedia()).blob, initial.background);
  assert.deepEqual(f.notices, [{ label: 'operation.reset', error }]);
  assert.equal(f.resetButton.disabled, false);
  await f.reset();
  assert.equal(f.saved.size, 0);
  assert.equal(await f.database.loadImportedText(), null);
  assert.equal(await f.database.loadBackgroundMedia(), null);
  f.saved.set('position:default', '{"scrollTop":12}');
  f.viewer.scrollTop = 12;
  f.updateResetButtonState();
  assert.equal(f.resetButton.disabled, true);
});

test('個別削除', 'LocalStorageの途中で拒否されたら変更を戻し、表示と元ファイルを保持する', async () => {
  const f = await removalFixture();
  const initial = f.snapshot();
  const previous = new Map(f.saved);
  const remove = f.local.removeItem;
  const error = new Error('本文の削除拒否');
  f.local.removeItem = key => {
    if (key === 'hitohira_content') throw error;
    remove(key);
  };
  await f.pressDelete('text');
  assert.deepEqual(f.saved, previous);
  assert.deepEqual(f.snapshot(), initial);
  assert.equal((await f.database.loadImportedText()).blob, initial.text);
  assert.deepEqual(f.notices, [{ label: 'operation.importDelete', error }]);
});

test('初期化', 'エクスポートHTMLでは本文・媒体の実行時状態と読書位置だけを初期化する', async () => {
  const f = await removalFixture(true);
  const previousEmbedded = f.embedded.textContent;
  const initial = f.snapshot();
  await f.reset();
  assert.equal(f.embedded.textContent, previousEmbedded);
  assert.equal(f.saved.has('hitohira_position:exported'), false);
  assert.equal(f.saved.has('hitohira_bookmarks:document'), false);
  assert.equal(f.saved.get('hitohira_settings'), JSON.stringify(initial.settings));
  assert.equal(f.saved.get('hitohira_content'), '<p>保存済み本文</p>');
  assert.equal((await f.database.loadImportedText()).blob, initial.text);
  assert.equal((await f.database.loadBackgroundMedia()).blob, initial.background);
  assert.equal(f.snapshot().text, null);
  assert.equal(f.snapshot().background, null);
  assert.equal(f.content.innerHTML, f.defaultContent);
  assert.deepEqual(f.viewer, { scrollTop: 0, scrollLeft: 0 });
  assert.equal(f.resetButton.disabled, true);
});

test('背景メディア', '動画要素へミュート・自動再生・ループ・インライン再生を設定する', () => {
  const { configureBackgroundVideoElement } = load(['configureBackgroundVideoElement']);
  const attrs = new Map();
  const video = { muted: false, autoplay: false, loop: false, playsInline: false, setAttribute(name, value) { attrs.set(name, value); } };
  configureBackgroundVideoElement(video);
  assert.equal(video.muted, true);
  assert.equal(video.autoplay, true);
  assert.equal(video.loop, true);
  assert.equal(video.playsInline, true);
  for (const name of ['muted', 'autoplay', 'loop', 'playsinline']) assert.equal(attrs.get(name), '');
});

function backgroundFixture() {
  const css = new Map();
  const classes = new Set();
  const images = [];
  const analyzedImages = [];
  const revoked = [];
  const notices = [];
  const settings = {
    theme: 'light', autoSync: true, bgColor: '#123456', narrationColor: '#223344',
    dialogueColor: '#334455', panelColor: '#445566'
  };
  const video = {
    style: {}, paused: true, videoWidth: 200, videoHeight: 100,
    setAttribute() {}, removeAttribute(name) { delete this[name]; }, load() {},
    pause() { this.paused = true; },
    async play() { this.paused = false; }
  };
  const control = {};
  const controls = Object.fromEntries([
    'ctrlBgColor', 'ctrlNarrationColor', 'ctrlDialogueColor', 'ctrlPanelColor', 'ctrlFont',
    'writingModeControl', 'fontSizeControl', 'valFontSize', 'lineHeightControl', 'valLineHeight',
    'letterSpacingControl', 'valLetterSpacing', 'contentWidthControl', 'valContentWidth',
    'contentPaddingControl', 'valContentPadding', 'backgroundBlurControl', 'valBackgroundBlur',
    'rubyScaleControl', 'valRubyScale', 'contentBackgroundOpacityControl', 'valContentBgAlpha',
    'readingProgressVisibilityControl', 'wakeLockControl'
  ].map(name => [name, { querySelectorAll: () => [] }]));
  const { applyBackgroundImage, applySettings } = load(['applyBackgroundImage', 'applySettings'], {
      ...controls,
      document: {
        documentElement: { setAttribute() {}, style: { setProperty: (name, value) => css.set(name, value) } },
        body: { classList: classes, style: {} },
        getElementById: () => ({ style: { setProperty() {} } }),
        createElement: () => ({ getContext: () => ({
          drawImage(image) { analyzedImages.push(image); },
          getImageData: () => ({ data: [32, 64, 96, 255] })
        }) })
      },
      window: { innerWidth: 100, innerHeight: 100 },
      backgroundVideo: video, automaticColorSyncControl: control,
      bgViewportMap: { style: { setProperty() {} } },
      btnThemeToggle: { querySelector: () => ({}) }, progressIndicator: { classList: { toggle() {} } },
      activeViewerSettings: settings, themeDerivedColors: {},
      currentLanguage: 'ja',
      DEFAULT_BACKGROUND_IMAGES: { light: 'paper.png' },
      backgroundMediaDataUrl: null, backgroundMediaObjectUrl: null, backgroundMediaType: null,
      backgroundMediaNaturalWidth: 0, backgroundMediaNaturalHeight: 0,
      backgroundMediaOffsetX: 0, backgroundMediaOffsetY: 0, lastLoadedImageElement: null,
      URL: { revokeObjectURL: url => revoked.push(url) },
      Image: class {
        constructor() { images.push(this); this.naturalWidth = 50; this.naturalHeight = 100; }
      },
      localStorage: { getItem: () => '{"bgOffsetX":999,"bgOffsetY":-999}' },
      getPositionStorageKey: () => 'position',
      setBackgroundImageStyle: value => css.set('--bg-image', value),
      showErrorNotice: message => notices.push(message),
      updateReadingState() {}, updateScreenWakeLock() {}, updateResetButtonState() {}, saveSettings() {}
    });
  classes.remove = name => classes.delete(name);
  return { applyBackgroundImage, applySettings, css, classes, images, analyzedImages, revoked, video, control, settings, notices };
}

test('背景メディア', '画像の表示位置を制限し、読み込み中と削除後は個別色に戻す', () => {
  const f = backgroundFixture();
  f.applyBackgroundImage('blob:portrait', true);
  f.applySettings(f.settings);
  assert.equal(f.control.disabled, true);
  assert.equal(f.css.get('--bg-image'), 'url("blob:portrait")');
  assert.equal(f.classes.has('has-bg'), true);
  f.images[0].onload();
  assert.equal(f.css.get('--bg-pos-x'), 'calc(50% + 0px)');
  assert.equal(f.css.get('--bg-pos-y'), 'calc(50% + -50px)');
  assert.equal(f.control.disabled, false);
  assert.equal(f.control.checked, true);
  assert.equal(f.css.get('--panel-rgb'), '32, 64, 96');
  assert.equal(f.css.get('--narration-color'), '#dbdbdb');
  assert.equal(f.css.get('--dialogue-color'), '#b8b8b8');
  assert.equal(f.css.get('--bg-color'), '#123456');
  f.settings.autoSync = false;
  f.applySettings(f.settings);
  assert.equal(f.control.disabled, false);
  assert.equal(f.control.checked, false);
  assert.equal(f.css.get('--panel-rgb'), '68, 85, 102');
  f.settings.autoSync = true;

  f.applyBackgroundImage('blob:pending');
  f.applySettings(f.settings);
  assert.equal(f.control.disabled, true);
  assert.equal(f.css.get('--panel-rgb'), '68, 85, 102');
  f.applyBackgroundImage(null);
  f.applySettings(f.settings);
  f.images[1].onload();
  assert.equal(f.classes.has('has-bg'), false);
  assert.equal(f.css.get('--bg-image'), "url('paper.png')");
  assert.equal(f.css.get('--bg-pos-y'), 'calc(50% + 0px)');
  assert.equal(f.css.get('--narration-color'), '#223344');
  assert.equal(f.css.get('--dialogue-color'), '#334455');
  assert.deepEqual(f.revoked, ['blob:portrait', 'blob:pending']);
  assert.deepEqual(f.analyzedImages, [f.images[0]]);
});

test('背景メディア', '動画の寸法取得後に表示位置を制限して再生し、画像の自動配色を適用しない', () => {
  const f = backgroundFixture();
  f.applyBackgroundImage('blob:pending');
  f.applyBackgroundImage('blob:video', true, 'video');
  f.applySettings(f.settings);
  f.images[0].onload();
  assert.deepEqual(f.analyzedImages, []);
  assert.equal(f.video.paused, true);
  f.video.onloadedmetadata();
  assert.equal(f.classes.has('video-bg'), true);
  assert.equal(f.css.get('--bg-image'), 'none');
  assert.equal(f.video.src, 'blob:video');
  assert.equal(f.video.paused, false);
  assert.equal(f.video.style.width, '200px');
  assert.equal(f.video.style.height, '100px');
  assert.equal(f.video.style.left, 'calc(50% - 100px + 50px)');
  assert.equal(f.video.style.top, 'calc(50% - 50px + 0px)');
  assert.equal(f.control.disabled, true);
  assert.equal(f.css.get('--panel-rgb'), '68, 85, 102');
});

test('背景メディア', '表示・保存・寸法・位置の状態を一つの実行時オブジェクトへまとめる', () => {
  const stateDeclaration = html.match(/const backgroundMediaState = \{([\s\S]*?)\n  \};/)?.[1] || '';
  for (const field of ['dataUrl', 'objectUrl', 'mediaType', 'fileBlob', 'fileExtension', 'lastLoadedImage', 'naturalWidth', 'naturalHeight', 'offsetX', 'offsetY']) {
    assert.match(stateDeclaration, new RegExp(`\\b${field}:`));
  }
  assert.doesNotMatch(html, /\blet backgroundMedia(?:DataUrl|ObjectUrl|Type|FileBlob|FileExtension|NaturalWidth|NaturalHeight|OffsetX|OffsetY)\b|\blastLoadedImageElement\b/);
});

test('背景メディア', 'メタデータ取得時と再生可能時の自動再生拒否を一度だけ通知する', async () => {
  const f = backgroundFixture();
  f.video.play = async () => { throw new DOMException('Autoplay blocked', 'NotAllowedError'); };
  f.applyBackgroundImage('blob:video', false, 'video');
  f.video.onloadedmetadata();
  f.video.oncanplay();
  await Promise.resolve();
  assert.equal(f.video.paused, true);
  assert.equal(f.classes.has('video-bg'), true);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /背景動画の自動再生を拒否/);
});

test('保存データとストレージ', '保存トランザクションの中断を通知し、DB接続を閉じる', async () => {
  const storage = mediaStorageFixture();
  const error = new Error('容量不足');
  storage.abortNextWrite(error);
  await assert.rejects(storage.storeImportedText(new Blob(['本文']), '.txt'), error);
  assert.equal(storage.closed(), 1);
  assert.equal(await storage.loadImportedText(), null);
});

test('インポート', '保存容量を超える本文への置き換えを拒否し、表示・元ファイル・保存済み本文を維持する', async () => {
  const database = mediaStorageFixture();
  const fixture = importFixture(database.storeImportedText);
  await fixture.handleFiles([new File(['既存本文'], 'original.md')]);
  const previousContent = fixture.content.innerHTML;
  const previousExport = fixture.getExportSource();
  fixture.viewer.scrollTop = 42;
  fixture.storage.set('position:old', '以前の位置');

  database.abortNextWrite(new DOMException('Storage quota exceeded', 'QuotaExceededError'));
  await fixture.handleFiles([new File(['置き換え本文'], 'replacement.txt')]);

  assert.equal(fixture.content.innerHTML, previousContent);
  assert.equal(fixture.storage.get('content'), previousContent);
  assert.equal(fixture.settings.fileStem, 'original');
  assert.equal(fixture.viewer.scrollTop, 42);
  assert.equal(fixture.storage.get('position:old'), '以前の位置');
  assert.equal(fixture.getExportSource().blob, previousExport.blob);
  assert.equal(fixture.getExportSource().extension, '.md');
  assert.equal((await database.loadImportedText()).blob, previousExport.blob);
  assert.equal(fixture.notices.length, 1);
  assert.match(fixture.notices[0], /replacement\.txt.*保存領域が不足/);
});

function wakeLockFixture(navigator) {
  const status = {};
  const control = {};
  const document = { visibilityState: 'visible' };
  const settings = { wakeLock: true };
  const { updateScreenWakeLock } = load(['updateScreenWakeLock'], { navigator, document, screenWakeLock: null, wakeLockStatus: status, wakeLockControl: control, activeViewerSettings: settings });
  return { updateScreenWakeLock, document, status, control };
}

test('テーマ・配色', '画面を隠すとスリープ防止を解放し、表示へ戻ると再取得する', async () => {
  const requests = [];
  let releases = 0;
  const fixture = wakeLockFixture({ wakeLock: { async request(kind) {
    requests.push(kind);
    return { addEventListener() {}, async release() { releases++; } };
  } } });
  await fixture.updateScreenWakeLock();
  assert.equal(fixture.status.textContent, '（有効）');
  fixture.document.visibilityState = 'hidden';
  await fixture.updateScreenWakeLock();
  assert.equal(fixture.status.textContent, '（待機中）');
  assert.equal(releases, 1);
  fixture.document.visibilityState = 'visible';
  await fixture.updateScreenWakeLock();
  assert.equal(fixture.status.textContent, '（有効）');
  assert.deepEqual(requests, ['screen', 'screen']);
});

test('テーマ・配色', 'スリープ防止のAPI非対応と取得失敗を区別する', async () => {
  const unavailable = wakeLockFixture({});
  await unavailable.updateScreenWakeLock();
  assert.equal(unavailable.control.disabled, true);
  assert.equal(unavailable.status.textContent, '（利用不可）');
  const rejected = wakeLockFixture({ wakeLock: { async request() { throw new Error('拒否'); } } });
  await rejected.updateScreenWakeLock();
  assert.equal(rejected.control.disabled, false);
  assert.equal(rejected.status.textContent, '（取得失敗）');
});

test('ページ送り・キーボード', 'PageDownとShift+Spaceは書字方向に応じた正反対の移動量を返す', () => {
  const { getPageScrollDelta } = load(['getPageScrollDelta']);
  assert.equal(getPageScrollDelta('horizontal', 'PageDown', false, 800), 800);
  assert.equal(getPageScrollDelta('horizontal', ' ', true, 800), -800);
  assert.equal(getPageScrollDelta('vertical', 'PageDown', false, 800), -800);
  assert.equal(getPageScrollDelta('vertical', ' ', true, 800), 800);
});

test('ページ送り・キーボード', '矢印キーは書字方向に対応する軸だけを移動する', () => {
  const { getPageScrollDelta } = load(['getPageScrollDelta']);
  assert.equal(getPageScrollDelta('horizontal', 'ArrowDown', false, 900), 300);
  assert.equal(getPageScrollDelta('horizontal', 'ArrowLeft', false, 900), null);
  assert.equal(getPageScrollDelta('vertical', 'ArrowLeft', false, 900), -300);
  assert.equal(getPageScrollDelta('vertical', 'ArrowDown', false, 900), null);
});

test('タイトル・ファイル名', 'HTML題名、ファイルstem、既定題名の順で表示タイトルを決める', () => {
  const { getFileStem, resolveDocumentTitle } = load(['getFileStem', 'resolveDocumentTitle']);
  assert.equal(getFileStem('作品.改訂版.md'), '作品.改訂版');
  assert.equal(resolveDocumentTitle(' HTML題名 ', '作品', '既定'), 'HTML題名');
  assert.equal(resolveDocumentTitle('', ' 作品 ', '既定'), '作品');
  assert.equal(resolveDocumentTitle('', '', '既定'), '既定');
});

test('タイトル・ファイル名', 'ファイル名から拡張子だけを除去してstemを取得する', () => {
  const { getFileStem } = load(['getFileStem']);
  assert.equal(getFileStem('novel.md'), 'novel');
  assert.equal(getFileStem('novel.revised.html'), 'novel.revised');
  assert.equal(getFileStem('README'), 'README');
  assert.equal(getFileStem('.config'), '.config');
});

test('タイトル・ファイル名', 'HTML題名が空白だけならstem、stemも空なら既定題名を使う', () => {
  const { resolveDocumentTitle } = load(['resolveDocumentTitle']);
  assert.equal(resolveDocumentTitle('   ', '作品', 'Hitohira'), '作品');
  assert.equal(resolveDocumentTitle('', '   ', 'Hitohira'), 'Hitohira');
});

const defaultStartupContent = '<p>既定本文</p>';
const storedStartupContent = ' <h1>保存済み本文</h1> ';
const exportedStartupContent = '<h1>エクスポート本文</h1>';
const startupDefaults = JSON.parse(html.match(/<script id="viewer-initial-config" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const storedViewerSettings = {
  writingMode: 'vertical', theme: 'dark', fontFamily: 'sans', fontSize: 20, lineHeight: 2.4,
  letterSpacing: 0.08, rubyScale: 0.6, panelBgAlpha: 0.8, contentWidth: 800, contentPadding: 52,
  backgroundBlur: 8, showProgress: true, wakeLock: true, bgColor: '#102030', narrationColor: '#abcdef',
  dialogueColor: '#fedcba', panelColor: '#223344', autoSync: true, fileStem: '保存名', documentTitle: '保存題名'
};

for (const { name, stored = null, savedSettings, expectedSettings, expectedLanguage, exported = false, browserLanguage = 'ja', browserLanguages, expected = defaultStartupContent } of [
  { name: '保存済み本文がなければ既定本文を表示する', stored: null, expected: defaultStartupContent },
  { name: '保存設定がない初回起動ではブラウザーが英語なら英語を選ぶ', stored: null, browserLanguage: 'en-US', expectedLanguage: 'en' },
  { name: '保存済み表示言語よりブラウザーの優先言語を使用する', savedSettings: JSON.stringify({ ...storedViewerSettings, language: 'en' }), browserLanguages: ['ja-JP', 'en-US'], expectedSettings: storedViewerSettings, expectedLanguage: 'ja' },
  { name: '保存済み本文が空白だけなら既定本文を表示する', stored: ' \n ', expected: defaultStartupContent },
  { name: '保存済み本文をサニタイズして目次生成と読書位置復元に渡す', stored: storedStartupContent, expected: storedStartupContent.trim() },
  { name: '起動時に保存済み設定の全項目を適用する', savedSettings: JSON.stringify(storedViewerSettings), expectedSettings: storedViewerSettings },
  { name: '一部だけ保存された旧設定は不足する項目を既定値で補う', savedSettings: '{"fontSize":20}', expectedSettings: { ...startupDefaults, fontSize: 20 } },
  { name: '壊れた設定から既定値に戻して起動する', savedSettings: '{', expectedSettings: startupDefaults },
  { name: '不正な保存設定を許容範囲と安全な色へ正規化する',
    savedSettings: JSON.stringify({ fontSize: 99999, lineHeight: -1, contentWidth: 1, backgroundBlur: 99, bgColor: 'url(javascript:alert(1))', panelColor: '#12zz45', theme: 'other', writingMode: 'diagonal', language: 'fr', wakeLock: 'yes', documentTitle: 'x'.repeat(600) }),
    expectedSettings: { ...startupDefaults, fontSize: 22, lineHeight: 1, contentWidth: 480, backgroundBlur: 24, documentTitle: 'x'.repeat(512) } },
  { name: 'エクスポートHTMLは埋め込まれた本文で起動する', stored: storedStartupContent, exported: true,
    savedSettings: JSON.stringify(storedViewerSettings), expectedSettings: startupDefaults, expected: exportedStartupContent },
  { name: 'エクスポートHTMLも起動したブラウザーの言語に従う', stored: storedStartupContent, exported: true,
    browserLanguages: ['en-GB', 'ja-JP'], expectedSettings: startupDefaults, expectedLanguage: 'en', expected: exportedStartupContent }
]) {
  test('初期表示', name, async () => {
    const storage = new Map();
    if (stored !== null) storage.set('hitohira_content', stored);
    if (savedSettings !== undefined) storage.set('hitohira_settings', savedSettings);
    const reads = [];
    const sanitized = [];
    const rendered = [];
    const appliedSettings = [];
    const appliedLanguages = [];
    let deferredCallback = null;
    const content = { innerHTML: exported ? exportedStartupContent : defaultStartupContent };
    const { STORAGE_KEYS } = load(['STORAGE_KEYS']);
    const { init } = load(['init', 'isMediaType', 'EMBEDDED_DATA_SCHEMA_VERSION'], {
      document: { documentElement: { dataset: { exported: String(exported) } }, getElementById: () => ({
        textContent: JSON.stringify({ textBase64: '', textExtension: '', textMimeType: '', mediaIncluded: false,
          mediaType: null, mediaExtension: '', mediaDataUrl: '' })
      }) },
      navigator: { language: browserLanguage, languages: browserLanguages },
      requestAnimationFrame(callback) { callback(); },
      setTimeout(callback) { deferredCallback = callback; return 1; },
      STORAGE_KEYS,
      recoverSavedDataTransaction: async () => false,
      localStorage: { getItem(key) { reads.push(key); return storage.get(key) ?? null; } },
      DEFAULT_SETTINGS: startupDefaults,
      activeViewerSettings: { ...startupDefaults },
      THEME_PALETTES: { light: {} },
      currentDocumentId: null,
      themeDerivedColors: null,
      loadBackgroundMedia: async () => null,
      loadImportedText: async () => null,
      refreshExportButtons() {},
      applySettings(settings) { appliedSettings.push({ ...settings }); },
      applyLanguage(language) { appliedLanguages.push(language); },
      novelContentElement: content,
      sanitizeHTML(markup) { sanitized.push(markup); return markup.trim(); },
      refreshDocumentNavigation() { rendered.push(['目次', content.innerHTML]); },
      async restoreReadingPositionAfterLayout() { rendered.push(['読書位置', content.innerHTML]); },
      updateReadingState() {},
      updateResetButtonState() {},
      scheduleHtmlExportSizeUpdate() {}
    });

    await init();

    assert.equal(content.innerHTML, expected);
    assert.deepEqual(reads, exported ? [] : ['hitohira_settings', 'hitohira_content']);
    assert.deepEqual(sanitized, !exported && stored?.trim() ? [stored] : []);
    assert.deepEqual(rendered, [['目次', expected]]);
    assert.deepEqual(appliedSettings, [expectedSettings ?? startupDefaults]);
    assert.deepEqual(appliedLanguages, [expectedLanguage ?? 'ja']);
    assert.equal(typeof deferredCallback, 'function');
    await deferredCallback();
    assert.deepEqual(rendered, [['目次', expected], ['読書位置', expected]]);
    assert.deepEqual(appliedSettings, [expectedSettings ?? startupDefaults, expectedSettings ?? startupDefaults]);
  });
}

function timerFixture() {
  let nextId = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) { pending.set(++nextId, { callback, delay }); return nextId; },
    clearTimeout(id) { pending.delete(id); },
    run() {
      for (const [id, { callback }] of pending) {
        pending.delete(id);
        callback();
      }
    }
  };
}

test('初期表示', '通知を更新すると閉鎖を延期し、最新の通知を5秒後に閉じる', () => {
  const firstClock = timerFixture();
  const updatedClock = timerFixture();
  const notice = { hidden: true };
  const message = {};
  const { showErrorNotice, hideErrorNotice } = load(['showErrorNotice', 'hideErrorNotice'], {
      errorNotice: notice, errorNoticeMessage: message, errorNoticeTimer: null,
      errorNoticeTimerCancel: () => {}, errorNoticeTimerDependencies: {
        setTimeout: () => assert.fail('既定タイマーが予期せず使用されました'),
        clearTimeout: () => assert.fail('既定タイマー解除が予期せず使用されました')
      },
      setTimeout: () => assert.fail('注入した通知タイマーが使われません'),
      clearTimeout: () => assert.fail('注入した通知タイマーの解除関数が使われません')
    });
  showErrorNotice('最初の通知', firstClock);
  const first = [...firstClock.pending.keys()][0];
  showErrorNotice('更新した通知', updatedClock);
  assert.equal(notice.hidden, false);
  assert.equal(message.textContent, '更新した通知');
  assert.equal(firstClock.pending.has(first), false);
  assert.deepEqual([...updatedClock.pending.values()].map(timer => timer.delay), [5000]);
  updatedClock.run();
  assert.equal(notice.hidden, true);
  showErrorNotice('手動で閉じる通知', firstClock);
  hideErrorNotice();
  assert.equal(notice.hidden, true);
  assert.equal(firstClock.pending.size, 0);
});

test('目次', '見出しから項目を作成し、選択した位置へ移動して現在の項目を強調する', () => {
  const scrolls = [];
  const headings = ['  第一章 ', '節'].map((textContent, index) => ({
    tagName: index === 0 ? 'H1' : 'H3', textContent,
    scrollIntoView(options) { scrolls.push({ index, ...options }); }
  }));
  const createElement = () => ({
    children: [], dataset: {}, classes: new Set(), listeners: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(event, listener) { this.listeners[event] = listener; },
    get classList() {
      return {
        add: name => this.classes.add(name),
        toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
      };
    }
  });
  const list = createElement();
  Object.defineProperty(list, 'innerHTML', { set() { this.children = []; } });
  list.querySelectorAll = () => list.children.flatMap(li => li.children);
  let closed = false;
  const { refreshDocumentNavigation, updateActiveTableOfContentsEntry } =
    load(['refreshDocumentNavigation', 'updateActiveTableOfContentsEntry'], {
        novelContentElement: { querySelectorAll: () => headings },
        document: { createElement }, tocListEl: list,
        tableOfContentsEntries: [], activeTableOfContentsEntryId: null,
        closeAllDrawers() { closed = true; }
      });
  refreshDocumentNavigation();
  const buttons = list.querySelectorAll();
  assert.deepEqual(buttons.map(btn => [btn.dataset.targetId, btn.dataset.level, btn.textContent]),
    [['heading-0', '1', '第一章'], ['heading-1', '3', '節']]);
  buttons[1].listeners.click();
  assert.deepEqual(scrolls, [{ index: 1, behavior: 'smooth', block: 'start', inline: 'start' }]);
  assert.equal(closed, true);
  updateActiveTableOfContentsEntry(headings[1].id);
  assert.deepEqual(buttons.map(btn => btn.classes.has('is-current')), [false, true]);
  updateActiveTableOfContentsEntry(headings[0].id);
  assert.deepEqual(buttons.map(btn => btn.classes.has('is-current')), [true, false]);
});

test('目次', '見出しがない本文では空の案内を表示し、目次ボタンを生成しない', () => {
  const list = {
    children: [],
    set innerHTML(_value) { this.children = []; },
    appendChild(child) { this.children.push(child); }
  };
  const { refreshDocumentNavigation } = load(
    ['refreshDocumentNavigation'], {
      novelContentElement: { querySelectorAll: () => [] }, tableOfContentsEntries: [], tocListEl: list,
      document: { createElement: () => ({ className: '', textContent: '' }) }
    });

  refreshDocumentNavigation();

  assert.deepEqual(list.children.map(({ className, textContent }) => [className, textContent]), [
    ['toc-empty', '見出しが見つかりませんでした']
  ]);
});

test('目次', '見出しが300件を超える場合も分割描画を完了する', async () => {
  const list = {
    children: [],
    set innerHTML(_value) { this.children = []; },
    appendChild(child) { this.children.push(child); }
  };
  const createElement = () => ({
    children: [], dataset: {}, classList: { add() {} },
    appendChild(child) { this.children.push(child); },
    addEventListener() {}
  });
  const entries = Array.from({ length: 305 }, (_, index) => ({
    id: `heading-${index}`, level: 2, text: `見出し${index}`, element: { scrollIntoView() {} }
  }));
  const scheduledTimers = [];
  const { renderTableOfContents } = load(['renderTableOfContents'], {
    tableOfContentsEntries: entries, activeTableOfContentsEntryId: null,
    tocListEl: list, document: { createElement },
    setTimeout(callback) { scheduledTimers.push(callback); return scheduledTimers.length; }
  });

  renderTableOfContents();
  assert.equal(list.children.length, 150, '最初の描画で全件を同期処理しました');
  while (scheduledTimers.length) {
    scheduledTimers.shift()();
    await Promise.resolve();
  }

  assert.equal(list.children.length, 305);
  assert.equal(list.children[0].children[0].dataset.targetId, 'heading-0');
  assert.equal(list.children.at(-1).children[0].dataset.targetId, 'heading-304');
});

test('ページ送り', '縦書きで縦方向が優勢なホイール入力を横移動に変換する', () => {
  let wheel;
  let prevented = 0;
  const settings = { writingMode: 'vertical' };
  const viewer = { scrollLeft: -100, addEventListener(event, listener) { wheel = listener; } };
  const { initializeWheelHandling } = load(['initializeWheelHandling'], {
    viewerContainer: viewer, activeViewerSettings: settings
  });
  initializeWheelHandling();
  const preventDefault = () => { prevented++; };
  wheel({ deltaX: 2, deltaY: 30, preventDefault });
  assert.equal(viewer.scrollLeft, -130);
  wheel({ deltaX: 30, deltaY: 2, preventDefault });
  settings.writingMode = 'horizontal';
  wheel({ deltaX: 0, deltaY: 30, preventDefault });
  assert.equal(viewer.scrollLeft, -130);
  assert.equal(prevented, 1);
});

test('ページ送り', 'キー入力の初回移動中・継続中・ウィンドウ離脱で停止し、入力欄では動かさない', () => {
  const makeFixture = () => {
    const timeouts = timerFixture();
    let nextInterval = 0;
    const intervals = new Map();
    const documentListeners = {};
    const windowListeners = {};
    const viewerListeners = {};
    const scrolls = [];
    const viewer = {
      clientHeight: 600, clientWidth: 800, scrollHeight: 3000, scrollWidth: 4000,
      addEventListener: (type, listener) => { viewerListeners[type] = listener; },
      scrollBy: options => scrolls.push({ ...options }), scrollTo: options => scrolls.push({ ...options })
    };
    const { initializeKeyboardHandling } = load(['initializeKeyboardHandling'], {
      document: { addEventListener: (type, listener) => { documentListeners[type] = listener; } },
      window: {
        addEventListener: (type, listener) => { windowListeners[type] = listener; },
        setTimeout: timeouts.setTimeout,
        setInterval(callback, delay) { intervals.set(++nextInterval, { callback, delay }); return nextInterval; },
        clearInterval: id => intervals.delete(id)
      },
      setTimeout: timeouts.setTimeout, clearTimeout: timeouts.clearTimeout,
      setInterval: (callback, delay) => { intervals.set(++nextInterval, { callback, delay }); return nextInterval; },
      clearInterval: id => intervals.delete(id),
      heldScrollTimer: null, heldScrollWaiting: false, heldScrollFallback: null,
      heldScrollDelta: 0, heldScrollVertical: false,
      stopHeldScroll() { intervals.clear(); timeouts.pending.clear(); },
      getPageScrollDelta(mode, key, shift, page) {
        const vertical = mode === 'vertical';
        if (!vertical && key === 'ArrowDown') return page / 3;
        if (!vertical && key === 'ArrowUp') return -page / 3;
        if (vertical && key === 'ArrowLeft') return -page / 3;
        if (vertical && key === 'ArrowRight') return page / 3;
        if (key === 'PageDown' || (key === ' ' && !shift)) return vertical ? -page : page;
        if (key === 'PageUp' || (key === ' ' && shift)) return vertical ? page : -page;
        return null;
      },
      viewerContainer: viewer, activeViewerSettings: { writingMode: 'horizontal' },
      closeAllDrawers() {}, shortcutModal: { showModal() {} }, toggleFullscreen() {},
      openSettingsDrawer() {}, openTocDrawer() {}, settingsDrawer: { classList: { contains: () => false } },
      tocDrawer: { classList: { contains: () => false } }
    });
    initializeKeyboardHandling();
    return { timeouts, intervals, documentListeners, windowListeners, viewerListeners, scrolls };
  };
  const keyEvent = (key, target = { closest: () => null }) => ({
    key, target, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    prevented: false, preventDefault() { this.prevented = true; }
  });

  const excludedFixture = makeFixture();
  const excluded = keyEvent('ArrowDown', { closest: () => ({}) });
  excludedFixture.documentListeners.keydown(excluded);
  assert.equal(excluded.prevented, false);
  assert.deepEqual(excludedFixture.scrolls, []);

  const initial = makeFixture();
  initial.documentListeners.keydown(keyEvent('ArrowDown'));
  assert.deepEqual(initial.scrolls, [{ top: 150, behavior: 'smooth' }]);
  initial.documentListeners.keyup({ key: 'ArrowDown' });
  assert.equal(initial.intervals.size, 0);
  assert.equal(initial.timeouts.pending.size, 0);

  const repeating = makeFixture();
  repeating.documentListeners.keydown(keyEvent('ArrowDown'));
  repeating.viewerListeners.scrollend();
  assert.deepEqual([...repeating.intervals.values()].map(timer => timer.delay), [40]);
  [...repeating.intervals.values()][0].callback();
  assert.deepEqual(repeating.scrolls.at(-1), { top: 150, behavior: 'auto' });
  repeating.documentListeners.keyup({ key: 'ArrowDown' });
  assert.equal(repeating.intervals.size, 0);

  const blurred = makeFixture();
  blurred.documentListeners.keydown(keyEvent('ArrowDown'));
  blurred.viewerListeners.scrollend();
  blurred.windowListeners.blur();
  assert.equal(blurred.intervals.size, 0);
  assert.equal(blurred.timeouts.pending.size, 0);
});

test('ページ送り', '縦書きのキーで横移動し、HomeとEndは現在の書字方向の端へ移動する', () => {
  const documentListeners = {};
  const scrolls = [];
  const viewer = {
    clientHeight: 600, clientWidth: 800, scrollHeight: 2400, scrollWidth: 3200,
    addEventListener() {}, scrollBy: options => scrolls.push({ ...options }),
    scrollTo: options => scrolls.push({ ...options })
  };
  const { initializeKeyboardHandling } = load(['initializeKeyboardHandling'], {
    document: { addEventListener: (type, listener) => { documentListeners[type] = listener; } },
    window: { addEventListener: () => {}, setTimeout: () => 1, setInterval: () => 2, clearInterval() {} },
    setInterval: () => 2, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    heldScrollTimer: null, heldScrollWaiting: false, heldScrollFallback: null,
    heldScrollDelta: 0, heldScrollVertical: false, stopHeldScroll() {},
    getPageScrollDelta(_mode, key, shift, page) {
      if (key === 'ArrowLeft') return -page / 3;
      if (key === 'Home' || key === 'End') return null;
      if (key === 'PageDown' || (key === ' ' && !shift)) return -page;
      if (key === 'PageUp' || (key === ' ' && shift)) return page;
      return null;
    },
    viewerContainer: viewer, activeViewerSettings: { writingMode: 'vertical' },
    closeAllDrawers() {}, shortcutModal: { showModal() {} }, toggleFullscreen() {},
    openSettingsDrawer() {}, openTocDrawer() {}, settingsDrawer: { classList: { contains: () => false } },
    tocDrawer: { classList: { contains: () => false } }
  });
  initializeKeyboardHandling();
  const event = key => ({ key, target: { closest: () => null }, preventDefault() {} });

  documentListeners.keydown(event('ArrowLeft'));
  assert.deepEqual(scrolls[0], { left: -200, behavior: 'smooth' });
  documentListeners.keydown(event('Home'));
  documentListeners.keydown(event('End'));
  assert.deepEqual(scrolls.slice(-2), [{ left: 0, behavior: 'auto' }, { left: -3200, behavior: 'auto' }]);
});

test('ページ送り', 'ダブルクリックは予約したページ送りを取り消し、ブラウザーの選択を維持する', () => {
  const clock = timerFixture();
  const events = {};
  const positions = [];
  const selection = { isCollapsed: true, rangeCount: 0 };
  const register = (name, listener) => { events[name] = listener; };
  const { initializePageTurnHandling } = load(['initializePageTurnHandling', 'pendingPageTurnTimer', 'hasActiveTextSelection'], {
    window: { addEventListener: register, getSelection: () => selection, setTimeout: clock.setTimeout },
    clearTimeout: clock.clearTimeout,
    novelContentElement: { contains: () => true, addEventListener: register },
    activeViewerSettings: { writingMode: 'horizontal' },
    viewerContainer: {
      clientHeight: 400, getBoundingClientRect: () => ({ top: 0, height: 400 }),
      scrollBy: options => positions.push({ ...options })
    }
  });
  initializePageTurnHandling();
  const click = {
    detail: 1, target: { closest: () => null }, clientY: 300,
    stopPropagation() {}, preventDefault() { assert.fail('標準の単語選択を妨げています'); }
  };
  events.click(click);
  clock.run();
  assert.deepEqual(positions, [{ top: 300, behavior: 'smooth' }]);
  events.click(click);
  assert.equal(clock.pending.size, 1);
  events.click({ ...click, detail: 2 });
  selection.isCollapsed = false;
  selection.rangeCount = 1;
  events.dblclick(click);
  assert.equal(clock.pending.size, 0);
  clock.run();
  assert.equal(positions.length, 1);
  assert.deepEqual(selection, { isCollapsed: false, rangeCount: 1 });
});

test('ページ送り', 'ビューアの入力初期化を通じて本文クリックページ送りを登録し実行する', async () => {
  const clock = timerFixture();
  const documentEvents = {};
  const windowEvents = {};
  const contentEvents = {};
  const scrolls = [];
  const { initializeViewerInputHandling } = load(['initializeViewerInputHandling', 'stopHeldScroll', 'hasActiveTextSelection', 'pendingPageTurnTimer'], {
    document: { addEventListener: (name, listener) => { documentEvents[name] = listener; } },
    window: {
      addEventListener: (name, listener) => { windowEvents[name] = listener; },
      getSelection: () => ({ isCollapsed: true, rangeCount: 0 }),
      setTimeout: clock.setTimeout
    },
    clearTimeout: clock.clearTimeout,
    novelContentElement: { contains: () => true, addEventListener: (name, listener) => { contentEvents[name] = listener; } },
    activeViewerSettings: { writingMode: 'horizontal' },
    viewerContainer: {
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 0, height: 400 }),
      scrollBy: options => scrolls.push({ ...options })
    }
  });

  initializeViewerInputHandling();
  assert.equal(typeof windowEvents.click, 'function');
  assert.equal(typeof contentEvents.dblclick, 'function');
  assert.equal(typeof documentEvents.keydown, 'function');
  windowEvents.click({
    detail: 1, target: { closest: () => null }, clientY: 300,
    stopPropagation() {}, preventDefault() { assert.fail('単一クリックのページ送りを抑止しました'); }
  });
  await clock.run();
  assert.deepEqual(scrolls, [{ top: 300, behavior: 'smooth' }]);
});

async function main() {
let passed = 0;
  for (const { suite, name, run } of tests) {
    console.log(formatCaseLine('run', suite, name));
    try {
      await run();
      passed++;
      console.log(formatCaseLine('ok', suite, name));
    } catch (error) {
      console.error(formatCaseLine('failed', suite, name) + '\n' + error.stack);
      process.exitCode = 1;
    }
  }
  console.log('[==========] ' + tests.length + ' tests ran.');
  console.log('[  PASSED  ] ' + passed + ' tests.');
  if (passed !== tests.length) console.error('[  FAILED  ] ' + (tests.length - passed) + ' tests.');
}

main();
