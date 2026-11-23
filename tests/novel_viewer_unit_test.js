'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { File } = require('node:buffer');
const { webcrypto } = require('node:crypto');
const { loadFunctionsFromHtml, formatCaseLine, assertUniqueHtmlIds, assertIconButtonsAccessible } = require('./test_utils');

const html = fs.readFileSync(path.join(__dirname, '..', 'hitohira.html'), 'utf8');
const spec = fs.readFileSync(path.join(__dirname, '..', 'docs', 'SPECIFICATION.md'), 'utf8');
const issueTable = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ISSUES.md'), 'utf8');
const testSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'novel-viewer-tests', 'SKILL.md'), 'utf8');
const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
const tests = [];
const test = (suite, name, run) => tests.push({ suite, name, run });
const load = (start, end, names, globals) => loadFunctionsFromHtml(html, start, end, names, globals);
const convert = () => load('function processPunctuation', 'function analyzeImageAndComputeAuto', ['plainTextToSafeHTML']).plainTextToSafeHTML;

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
    assert.match(id, /^NV-\d+$/);
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
test('テスト基盤', 'テスト後の副作用を成否に関わらず除去する方針がある', () => {
  assert.ok(testSkill.includes('成否・例外・中断に関わらず環境を復元する'));
  assert.ok(agents.includes('成否や例外に関わらず'));
  assert.ok(spec.includes('成否に関わらず'));
});

test('画面構成', '静的なUIのIDは一意で、アイコンボタンに操作名がある', () => {
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assertUniqueHtmlIds(markup);
  assertIconButtonsAccessible(markup);
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

test('本文表示・インポート', '長い漢字の連続や空白を含む本文でもルビと段落を保つ', () => {
  const kanji = '漢'.repeat(65536);
  const spaces = ' '.repeat(32768);
  const input = `${kanji}。漢字《かんじ》\n${spaces}本文\n次の段落`;
  assert.equal(convert()(input), `<p>${kanji}。<ruby>漢字<rt>かんじ</rt></ruby></p>\n<p>本文</p>\n<p>次の段落</p>`);
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
  const { isAllowedResourceUrl } = load('function isAllowedResourceUrl', 'function sanitizeHTML', ['isAllowedResourceUrl']);
  assert.equal(isAllowedResourceUrl('https://example.test/a', 'href'), true);
  assert.equal(isAllowedResourceUrl('../chapter.md', 'href'), true);
  assert.equal(isAllowedResourceUrl('javascript:alert(1)', 'href'), false);
  assert.equal(isAllowedResourceUrl('data:image/png;base64,AA==', 'image'), true);
  assert.equal(isAllowedResourceUrl('data:text/html;base64,AA==', 'image'), false);
});

test('本文表示・インポート', 'サニタイズ属性は許可された識別子・クラス・媒体属性だけを残す', () => {
  const { isAllowedSanitizedAttribute } = load('function isAllowedResourceUrl', 'function sanitizeHTML', ['isAllowedSanitizedAttribute']);
  assert.equal(isAllowedSanitizedAttribute('h2', 'id', 'heading-2'), true);
  assert.equal(isAllowedSanitizedAttribute('span', 'class', 'dialogue'), true);
  assert.equal(isAllowedSanitizedAttribute('span', 'style', 'color:red'), false);
  assert.equal(isAllowedSanitizedAttribute('img', 'src', 'javascript:alert(1)'), false);
  assert.equal(isAllowedSanitizedAttribute('img', 'alt', '背景'), true);
});

const readText = () => load('function getFileExtension', 'function refreshExportButtons', ['readTextFile'], { TextDecoder }).readTextFile;

test('インポート', 'UTF-8とBOM付きUTF-16を同じ本文へ復号する', async () => {
  const read = readText();
  for (const bytes of ['雨', [0xff, 0xfe, 0xe8, 0x96], [0xfe, 0xff, 0x96, 0xe8]]) {
    assert.equal(await read(new Blob([typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)])), '雨');
  }
});

test('インポート', '復号できないバイトが続く場合は読み込み失敗を返す', async () => {
  await assert.rejects(readText()(new Blob([Uint8Array.of(255, 255, 255)])), /文字コード/);
});

function importFixture(storeText = () => {}) {
  const content = { innerHTML: '<p>既存本文</p>' };
  const viewer = { scrollTop: 260, scrollLeft: -120 };
  const settings = {};
  const storage = new Map([['position:old', '以前の位置']]);
  const notices = [];
  const originals = [];
  const noop = () => {};
  const { readTextFile, getFileExtension } = load('function getFileExtension', 'function refreshExportButtons',
    ['readTextFile', 'getFileExtension'], { TextDecoder });
  const { getFileStem } = load('function getFileStem', 'function rgbToHex', ['getFileStem']);
  const { handleFiles, getExportSource } = load('function getImportFailureReason', "btnImportFile.addEventListener('click'",
    ['handleFiles', 'getExportSource: () => ({ blob: importedTextFileBlob, extension: importedTextFileExtension })'], {
    readTextFile, getFileExtension, getFileStem, plainTextToSafeHTML: convert(),
    sanitizeHTML: markup => markup,
    importedTextFileBlob: null, importedTextFileExtension: '',
    async storeImportedText(blob, extension) {
      await storeText(blob, extension);
      originals.push({ blob, extension });
    },
    activeViewerSettings: settings, novelContentElement: content, viewerContainer: viewer,
    STORAGE_KEYS: { CONTENT: 'content' }, getPositionStorageKey: () => 'position:old',
    localStorage: { setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    console: { error: noop }, refreshExportButtons: noop, collectTableOfContentsEntries: noop,
    updateReadingState: noop, applySettings: noop, saveSettings: noop, closeAllDrawers: noop,
    showErrorNotice: message => notices.push(message)
  });
  return { handleFiles, getExportSource, content, viewer, settings, storage, notices, originals };
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
    const { validateImageFile } = load('async function validateImageFile', 'async function handleFiles', ['validateImageFile'], {
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
  const { downloadWithHash } = load('async function downloadWithHash', 'function arrayBufferToBase64', ['downloadWithHash'], {
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
  const { downloadWithHash } = load('async function downloadWithHash', 'function arrayBufferToBase64', ['downloadWithHash'], {
    Blob, crypto: {}, URL: { createObjectURL: () => assert.fail('ダウンロードURLが生成された') }
  });
  await assert.rejects(downloadWithHash(new Blob(['abc']), '.txt'), /SHA-256/);
});

const media = () => load('function arrayBufferToBase64', 'function getFileStem',
  ['arrayBufferToBase64', 'dataUrlToBlob'], { Blob, btoa, atob });

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
  assert.throws(() => dataUrlToBlob('data:image/png;base64'), /形式が不正/);
  assert.throws(() => dataUrlToBlob('data:image/png;base64,!!!'), { name: 'InvalidCharacterError' });
});

test('エクスポートHTML内のデータ', '埋め込みData URLは背景メディア種別と一致するものだけを許可する', () => {
  const { isEmbeddableMediaDataUrl } = load('function isAllowedResourceUrl', 'function sanitizeHTML', ['isEmbeddableMediaDataUrl']);
  assert.equal(isEmbeddableMediaDataUrl('data:image/png;base64,AA==', 'image'), true);
  assert.equal(isEmbeddableMediaDataUrl('data:video/webm;base64,AA==', 'video'), true);
  assert.equal(isEmbeddableMediaDataUrl('data:image/png;base64,AA==', 'video'), false);
  assert.equal(isEmbeddableMediaDataUrl('blob:null/abc', 'image'), false);
});

test('エクスポートHTML内のデータ', '埋め込みペイロードは無効な媒体を空状態へ正規化する', () => {
  const { createEmbeddedDownloadData } = load('function isAllowedResourceUrl', 'function sanitizeHTML', ['createEmbeddedDownloadData']);
  const payload = createEmbeddedDownloadData('abc', '.txt', 'text/plain', 'blob:null/1', 'image', '.png');
  assert.equal(payload.textBase64, 'abc');
  assert.equal(payload.mediaIncluded, false);
  assert.equal(payload.mediaType, null);
  assert.equal(payload.mediaDataUrl, '');
});

test('エクスポートHTML内のデータ', '埋め込みペイロードは本文と有効な画像・動画情報を保持する', () => {
  const { createEmbeddedDownloadData } = load('function isAllowedResourceUrl', 'function sanitizeHTML', ['createEmbeddedDownloadData']);
  const image = createEmbeddedDownloadData('txt', '.md', 'text/markdown', 'data:image/png;base64,AA==', 'image', '.png');
  assert.equal(JSON.stringify(image), JSON.stringify({ textBase64: 'txt', textExtension: '.md', textMimeType: 'text/markdown', mediaIncluded: true, mediaType: 'image', mediaExtension: '.png', mediaDataUrl: 'data:image/png;base64,AA==' }));
  const video = createEmbeddedDownloadData('', '', '', 'data:video/webm;base64,AA==', 'video', '.webm');
  assert.equal(video.mediaIncluded, true);
  assert.equal(video.mediaType, 'video');
});

test('エクスポート', '失敗を通知して再試行を案内し、例外の詳細をログに記録する', () => {
  const notices = [];
  const logs = [];
  const { reportOperationFailure } = load('function reportOperationFailure', 'function isAllowedSanitizedAttribute', ['reportOperationFailure'], {
    console: { error: (...args) => logs.push(args) },
    showErrorNotice: message => notices.push(message)
  });
  const failure = new Error('保存領域へのアクセスが拒否されました');
  reportOperationFailure('HTMLのエクスポート', failure);
  assert.match(notices[0], /HTMLのエクスポートに失敗しました。操作をやり直してください/);
  assert.ok(!notices[0].includes(failure.message));
  assert.deepEqual(logs, [['HTMLのエクスポートに失敗しました:', failure]]);
});

test('エクスポート', '個別ファイル行は実行時Blobと媒体種別に応じて生成対象を決める', () => {
  const { getExportButtonDefinitions } = load('function getExportButtonDefinitions', 'function refreshExportButtons', ['getExportButtonDefinitions'], { Blob });
  const text = new Blob(['本文'], { type: 'text/plain' });
  const image = new Blob(['画像'], { type: 'image/png' });
  const imageRows = getExportButtonDefinitions(text, image, 'image');
  assert.equal(JSON.stringify(imageRows.map(row => row.available)), JSON.stringify([true, true, false]));
  const videoRows = getExportButtonDefinitions(null, image, 'video');
  assert.equal(JSON.stringify(videoRows.map(row => row.available)), JSON.stringify([false, false, true]));
});

test('エクスポート', '削除操作はテキスト・画像・動画以外を対象にしない', () => {
  const { getRuntimeDataDeleteType } = load('function getExportButtonDefinitions', 'function refreshExportButtons', ['getRuntimeDataDeleteType']);
  assert.equal(getRuntimeDataDeleteType({ dataset: { deleteType: 'text' } }), 'text');
  assert.equal(getRuntimeDataDeleteType({ dataset: { deleteType: 'video' } }), 'video');
  assert.equal(getRuntimeDataDeleteType({ dataset: { deleteType: 'unknown' } }), null);
  assert.equal(getRuntimeDataDeleteType(null), null);
});

test('エクスポートHTML', '内蔵初期化データを復元し、不正なデータでは既定値を維持する', () => {
  const { readEmbeddedResetDefaults } = load('function readEmbeddedResetDefaults', 'btnResetAll.addEventListener', ['readEmbeddedResetDefaults']);
  const fallback = { theme: 'light' };
  const element = { textContent: JSON.stringify({ settings: { theme: 'dark' }, content: '<p>初期本文</p>' }) };
  const restored = readEmbeddedResetDefaults(element, fallback, '<p>既定</p>');
  assert.equal(restored.settings.theme, 'dark');
  assert.equal(restored.content, '<p>初期本文</p>');
  const invalid = readEmbeddedResetDefaults({ textContent: '{' }, fallback, '<p>既定</p>');
  assert.equal(invalid.settings, fallback);
  assert.equal(invalid.content, '<p>既定</p>');
});

test('エクスポートHTML', '内蔵ダウンロードデータをJSONとして読み込み、破損時は無効化する', () => {
  const { readEmbeddedDownloadData } = load('function resolveInitialContent', 'async function init', ['readEmbeddedDownloadData']);
  assert.equal(readEmbeddedDownloadData({ textContent: '{"mediaType":"image"}' }).mediaType, 'image');
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
    const { getPageScrollDelta } = load('function getPageScrollDelta', 'async function toggleFullscreen', ['getPageScrollDelta']);
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
    console: { warn: error => messages.push(error), error: error => messages.push(error) },
    backgroundMediaOffsetX: 15, backgroundMediaOffsetY: -5, isRestoringReadingPosition: false, changingSavedData: false
  };
  const { computeProgressRatio } = load('function computeProgressRatio', 'function findCurrentReadingContext', ['computeProgressRatio'], context);
  Object.assign(context, { computeProgressRatio });
  const operations = load('function executeSavePosition', 'async function restoreReadingPositionAfterLayout',
    ['executeSavePosition', 'restoreReadingPosition'], context);
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

test('保存データとストレージ', '読書位置の保存領域が拒否しても表示状態を維持する', () => {
  const fixture = readingFixture();
  fixture.context.localStorage.setItem = () => { throw new Error('容量不足'); };
  fixture.context.localStorage.getItem = () => { throw new Error('読込拒否'); };
  fixture.executeSavePosition();
  fixture.restoreReadingPosition();
  assert.equal(fixture.messages.length, 2);
  assert.equal(fixture.viewer.scrollTop, 125);
});

function mediaStorageFixture(localStorage) {
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
  const { getFileExtension } = load('function getFileExtension', 'function refreshExportButtons', ['getFileExtension']);
  const operations = load('const MEDIA_DB_NAME', 'function blobToDataUrl',
    ['storeBackgroundMedia', 'loadBackgroundMedia', 'deleteMediaRecords', 'changeSavedData', 'storeImportedText', 'loadImportedText'],
    { indexedDB, window: { indexedDB }, getFileExtension, localStorage });
  return { ...operations, records, closed: () => closed, abortNextWrite: error => { nextWriteError = error; } };
}

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
  const positionKey = exported ? 'position:exported' : 'position:default';
  const saved = new Map([['settings', JSON.stringify(settings)], ['content', content.innerHTML], [positionKey, '{"scrollTop":80}']]);
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
  const definition = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
  const source = [
    definition('function updateResetButtonState', 'const loadedFileDownloads'),
    definition("loadedFileDownloads.addEventListener('click'", "btnExportHtml.addEventListener('click'"),
    definition('function readEmbeddedResetDefaults', '// 本文クリックによるページ送り。'),
    '// end'
  ].join('\n');
  let updateResetButtonState;
  let clearBackground;
  const operations = loadFunctionsFromHtml(source, 'function updateResetButtonState', '// end',
    ['snapshot: () => ({ settings: { ...activeViewerSettings }, text: importedTextFileBlob, background: backgroundMediaFileBlob })',
      'clearBackground: () => { backgroundMediaDataUrl = null; }', 'updateResetButtonState'], {
      document: {
        documentElement: { dataset: { exported: String(exported) } },
        getElementById: () => embedded,
        createElement: () => ({ querySelectorAll: () => [] })
      },
      DEFAULT_SETTINGS: exported ? { ...settings } : defaults, activeViewerSettings: settings, viewerResetDefaults: null,
      THEME_PALETTES: { light: {} }, themeDerivedColors: {},
      novelContentElement: content, initialNovelContentHtml: exported ? content.innerHTML : defaultContent, viewerContainer: viewer,
      btnResetAll: Object.assign(resetButton, register('reset')), loadedFileDownloads: register('delete'),
      STORAGE_KEYS: { SETTINGS: 'settings', CONTENT: 'content' }, getPositionStorageKey: () => positionKey,
      MEDIA_STORE_KEY: 'current', TEXT_STORE_KEY: 'current_text', changeSavedData: database.changeSavedData,
      getRuntimeDataDeleteType: button => button.dataset.deleteType,
      importedTextFileBlob: text, importedTextFileExtension: '.txt',
      backgroundMediaFileBlob: image, backgroundMediaFileExtension: '.png', backgroundMediaDataUrl: 'blob:image',
      backgroundMediaType: 'image', applyBackgroundImage(url) { if (url === null) clearBackground(); },
      refreshExportButtons() {}, collectTableOfContentsEntries() {}, updateReadingState() {}, closeAllDrawers() {},
      applySettings() { updateResetButtonState(); },
      reportOperationFailure: (label, error) => notices.push({ label, error })
    });
  ({ updateResetButtonState, clearBackground } = operations);
  const pressDelete = type => handlers.delete({ target: { closest: () => ({ dataset: { deleteType: type } }) } });
  updateResetButtonState();
  return { saved, local, database, snapshot: operations.snapshot, content, viewer, defaultContent, embedded, notices, resetButton,
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
  assert.deepEqual(f.notices, [{ label: '設定の初期化', error }]);
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
    if (key === 'content') throw error;
    remove(key);
  };
  await f.pressDelete('text');
  assert.deepEqual(f.saved, previous);
  assert.deepEqual(f.snapshot(), initial);
  assert.equal((await f.database.loadImportedText()).blob, initial.text);
  assert.deepEqual(f.notices, [{ label: '元ファイルの削除', error }]);
});

test('初期化', 'エクスポートHTMLでは本文・媒体の実行時状態と読書位置だけを初期化する', async () => {
  const f = await removalFixture(true);
  const previousEmbedded = f.embedded.textContent;
  const initial = f.snapshot();
  await f.reset();
  assert.equal(f.embedded.textContent, previousEmbedded);
  assert.equal(f.saved.has('position:exported'), false);
  assert.equal(f.saved.get('settings'), JSON.stringify(initial.settings));
  assert.equal(f.saved.get('content'), '<p>保存済み本文</p>');
  assert.equal((await f.database.loadImportedText()).blob, initial.text);
  assert.equal((await f.database.loadBackgroundMedia()).blob, initial.background);
  assert.equal(f.snapshot().text, null);
  assert.equal(f.snapshot().background, null);
  assert.equal(f.content.innerHTML, f.defaultContent);
  assert.deepEqual(f.viewer, { scrollTop: 0, scrollLeft: 0 });
  assert.equal(f.resetButton.disabled, true);
});

test('背景メディア', '動画要素へミュート・自動再生・ループ・インライン再生を設定する', () => {
  const { configureBackgroundVideoElement } = load('function configureBackgroundVideoElement', 'function applyBackgroundImage', ['configureBackgroundVideoElement']);
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
  const { applyBackgroundImage, applySettings } = load('function getFileStem', 'function saveSettings',
    ['applyBackgroundImage', 'applySettings'], {
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
      btnThemeToggle: { querySelector: () => ({}) }, progressIndicator: { classList: { toggle() {} } },
      activeViewerSettings: settings, themeDerivedColors: {},
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
  const { updateScreenWakeLock } = load('async function releaseScreenWakeLock', 'function updateResetButtonState',
    ['updateScreenWakeLock'], { navigator, document, screenWakeLock: null, wakeLockStatus: status, wakeLockControl: control, activeViewerSettings: settings });
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
  const { getPageScrollDelta } = load('function getPageScrollDelta', 'async function toggleFullscreen', ['getPageScrollDelta']);
  assert.equal(getPageScrollDelta('horizontal', 'PageDown', false, 800), 800);
  assert.equal(getPageScrollDelta('horizontal', ' ', true, 800), -800);
  assert.equal(getPageScrollDelta('vertical', 'PageDown', false, 800), -800);
  assert.equal(getPageScrollDelta('vertical', ' ', true, 800), 800);
});

test('ページ送り・キーボード', '矢印キーは書字方向に対応する軸だけを移動する', () => {
  const { getPageScrollDelta } = load('function getPageScrollDelta', 'async function toggleFullscreen', ['getPageScrollDelta']);
  assert.equal(getPageScrollDelta('horizontal', 'ArrowDown', false, 900), 300);
  assert.equal(getPageScrollDelta('horizontal', 'ArrowLeft', false, 900), null);
  assert.equal(getPageScrollDelta('vertical', 'ArrowLeft', false, 900), -300);
  assert.equal(getPageScrollDelta('vertical', 'ArrowDown', false, 900), null);
});

test('タイトル・ファイル名', 'HTML題名、ファイルstem、既定題名の順で表示タイトルを決める', () => {
  const { getFileStem, resolveDocumentTitle } = load('function getFileStem', 'function rgbToHex', ['getFileStem', 'resolveDocumentTitle']);
  assert.equal(getFileStem('作品.改訂版.md'), '作品.改訂版');
  assert.equal(resolveDocumentTitle(' HTML題名 ', '作品', '既定'), 'HTML題名');
  assert.equal(resolveDocumentTitle('', ' 作品 ', '既定'), '作品');
  assert.equal(resolveDocumentTitle('', '', '既定'), '既定');
});

test('タイトル・ファイル名', 'ファイル名から拡張子だけを除去してstemを取得する', () => {
  const { getFileStem } = load('function getFileStem', 'function rgbToHex', ['getFileStem']);
  assert.equal(getFileStem('novel.md'), 'novel');
  assert.equal(getFileStem('novel.revised.html'), 'novel.revised');
  assert.equal(getFileStem('README'), 'README');
  assert.equal(getFileStem('.config'), '.config');
});

test('タイトル・ファイル名', 'HTML題名が空白だけならstem、stemも空なら既定題名を使う', () => {
  const { resolveDocumentTitle } = load('function getFileStem', 'function rgbToHex', ['resolveDocumentTitle']);
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

for (const { name, stored = null, savedSettings, expectedSettings, exported = false, expected = defaultStartupContent } of [
  { name: '保存済み本文がなければ既定本文を表示する', stored: null, expected: defaultStartupContent },
  { name: '保存済み本文が空白だけなら既定本文を表示する', stored: ' \n ', expected: defaultStartupContent },
  { name: '保存済み本文をサニタイズして目次生成と読書位置復元に渡す', stored: storedStartupContent, expected: storedStartupContent.trim() },
  { name: '起動時に保存済み設定の全項目を適用する', savedSettings: JSON.stringify(storedViewerSettings), expectedSettings: storedViewerSettings },
  { name: '一部だけ保存された旧設定は不足する項目を既定値で補う', savedSettings: '{"fontSize":20}', expectedSettings: { ...startupDefaults, fontSize: 20 } },
  { name: '壊れた設定から既定値に戻して起動する', savedSettings: '{', expectedSettings: startupDefaults },
  { name: 'エクスポートHTMLは埋め込まれた本文で起動する', stored: storedStartupContent, exported: true,
    savedSettings: JSON.stringify(storedViewerSettings), expectedSettings: startupDefaults, expected: exportedStartupContent }
]) {
  test('初期表示', name, async () => {
    const storage = new Map();
    if (stored !== null) storage.set('hitohira_content', stored);
    if (savedSettings !== undefined) storage.set('hitohira_settings', savedSettings);
    const reads = [];
    const sanitized = [];
    const rendered = [];
    const appliedSettings = [];
    const content = { innerHTML: exported ? exportedStartupContent : defaultStartupContent };
    const { STORAGE_KEYS } = load('const STORAGE_KEYS =', 'const MEDIA_DB_NAME', ['STORAGE_KEYS']);
    const { init } = load('function resolveInitialContent', '\n  init();', ['init'], {
      document: { documentElement: { dataset: { exported: String(exported) } }, getElementById: () => ({ textContent: '{}' }) },
      STORAGE_KEYS,
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
      novelContentElement: content,
      sanitizeHTML(markup) { sanitized.push(markup); return markup.trim(); },
      collectTableOfContentsEntries() { rendered.push(['目次', content.innerHTML]); },
      async restoreReadingPositionAfterLayout() { rendered.push(['読書位置', content.innerHTML]); },
      updateReadingState() {},
      updateResetButtonState() {}
    });

    await init();

    assert.equal(content.innerHTML, expected);
    assert.deepEqual(reads, exported ? [] : ['hitohira_settings', 'hitohira_content']);
    assert.deepEqual(sanitized, !exported && stored?.trim() ? [stored] : []);
    assert.deepEqual(rendered, [['目次', expected], ['読書位置', expected]]);
    assert.deepEqual(appliedSettings, [expectedSettings ?? startupDefaults]);
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
  const clock = timerFixture();
  const notice = { hidden: true };
  const message = {};
  const { showErrorNotice, hideErrorNotice } = load('function showErrorNotice', 'btnCloseErrorNotice.addEventListener',
    ['showErrorNotice', 'hideErrorNotice'], {
      errorNotice: notice, errorNoticeMessage: message, errorNoticeTimer: null,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    });
  showErrorNotice('最初の通知');
  const first = [...clock.pending.keys()][0];
  showErrorNotice('更新した通知');
  assert.equal(notice.hidden, false);
  assert.equal(message.textContent, '更新した通知');
  assert.equal(clock.pending.has(first), false);
  assert.deepEqual([...clock.pending.values()].map(timer => timer.delay), [5000]);
  clock.run();
  assert.equal(notice.hidden, true);
  showErrorNotice('手動で閉じる通知');
  hideErrorNotice();
  assert.equal(notice.hidden, true);
  assert.equal(clock.pending.size, 0);
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
  const { collectTableOfContentsEntries, updateActiveTableOfContentsEntry } =
    load('function collectTableOfContentsEntries', 'function computeProgressRatio',
      ['collectTableOfContentsEntries', 'updateActiveTableOfContentsEntry'], {
        novelContentElement: { querySelectorAll: () => headings },
        document: { createElement }, tocListEl: list,
        tableOfContentsEntries: [], activeTableOfContentsEntryId: null,
        closeAllDrawers() { closed = true; }
      });
  collectTableOfContentsEntries();
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

test('ページ送り', '縦書きで縦方向が優勢なホイール入力を横移動に変換する', () => {
  let wheel;
  let prevented = 0;
  const settings = { writingMode: 'vertical' };
  const viewer = { scrollLeft: -100, addEventListener(event, listener) { wheel = listener; } };
  load("viewerContainer.addEventListener('wheel'", 'function resolveInitialContent', [],
    { viewerContainer: viewer, activeViewerSettings: settings });
  const preventDefault = () => { prevented++; };
  wheel({ deltaX: 2, deltaY: 30, preventDefault });
  assert.equal(viewer.scrollLeft, -130);
  wheel({ deltaX: 30, deltaY: 2, preventDefault });
  settings.writingMode = 'horizontal';
  wheel({ deltaX: 0, deltaY: 30, preventDefault });
  assert.equal(viewer.scrollLeft, -130);
  assert.equal(prevented, 1);
});

test('ページ送り', 'ダブルクリックは予約したページ送りを取り消し、ブラウザーの選択を維持する', () => {
  const clock = timerFixture();
  const events = {};
  const positions = [];
  const selection = { isCollapsed: true, rangeCount: 0 };
  const register = (name, listener) => { events[name] = listener; };
  load('let pendingPageTurnTimer', 'const handleReadingPositionChange', [], {
    window: { addEventListener: register, getSelection: () => selection, setTimeout: clock.setTimeout },
    clearTimeout: clock.clearTimeout,
    novelContentElement: { contains: () => true, addEventListener: register },
    activeViewerSettings: { writingMode: 'horizontal' },
    viewerContainer: {
      clientHeight: 400, getBoundingClientRect: () => ({ top: 0, height: 400 }),
      scrollBy: options => positions.push({ ...options })
    }
  });
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
