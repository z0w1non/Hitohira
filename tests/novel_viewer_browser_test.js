'use strict';

// Chrome/Edge系ブラウザーをCDPで起動し、実際のDOMへキーイベントを送るブラウザー操作テスト。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { dispatchKey, formatCaseLine, terminateBrowserTree } = require('./test_utils');

const browserCandidates = [
  { name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Google Chrome (x86)', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Google Chrome (user)', path: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe') },
  { name: 'Microsoft Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'Microsoft Edge (64-bit)', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' }
];
const requestedPort = Number(process.env.NOVEL_VIEWER_CDP_PORT || 0);
const usePipe = process.env.NOVEL_VIEWER_CDP_PIPE === '1';
const requestedBrowser = process.env.NOVEL_VIEWER_BROWSER?.trim().toLowerCase();
const testPolicies = process.env.NOVEL_VIEWER_POLICY_TESTS === '1';
const root = path.resolve(__dirname, '..');
const fileUrl = pathToFileURL(path.join(root, 'hitohira.html')).href;
let childError = '';
let childExit = null;
let activeCleanup = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForDevToolsPort(profile, child, timeoutMs = 10000) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    let timeout;
    const finish = (error, portNumber) => {
      if (settled) return;
      settled = true;
      if (watcher) watcher.close();
      clearTimeout(timeout);
      error ? reject(error) : resolve(portNumber);
    };
    const readPort = () => {
      try {
        const value = Number(fs.readFileSync(portFile, 'utf8').split(/\s+/)[0]);
        if (value > 0) finish(null, value);
      } catch (_) {}
    };
    try { watcher = fs.watch(profile, readPort); } catch (_) {}
    readPort();
    timeout = setTimeout(() => finish(new Error(`ブラウザーがCDPポートを通知しませんでした (profile=${profile})`)), timeoutMs);
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(`ブラウザーがCDPポート通知前に終了しました (code=${code}, signal=${signal || 'none'})`));
    });
  });
}
async function waitForTarget(port, expectedUrl) {
  let lastError = '';
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find(target => target.type === 'page' && target.url === expectedUrl);
      if (page) return page;
    } catch (error) { lastError = `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`; }
    await sleep(100);
  }
  throw new Error(`CDPターゲットを取得できません (port=${port}, url=${expectedUrl}, lastError=${lastError || '対象ページなし'})`);
}

function cdpPipe(input, output) {
  let id = 0;
  let buffer = '';
  let failure;
  const pending = new Map();
  const fail = error => {
    failure ??= error;
    for (const reject of pending.values()) reject(failure);
  };
  input.on('error', fail);
  output.on('error', fail);
  output.on('close', () => fail(new Error('CDPパイプが閉じました')));
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(frame);
        pending.get(response.id)?.(null, response);
      } catch (error) {
        fail(error);
      }
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const requestId = ++id;
    const finish = (error, response) => {
      clearTimeout(timeout);
      pending.delete(requestId);
      if (error || response.error) reject(error || new Error(response.error.message));
      else resolve(response.result);
    };
    const timeout = setTimeout(() => finish(new Error(`CDPパイプが応答しません (${method})`)), 10000);
    pending.set(requestId, finish);
    input.write(JSON.stringify({ id: requestId, method, params, sessionId }) + '\0');
  });
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
}

async function main() {
  const executable = { chrome: 'chrome.exe', edge: 'msedge.exe' };
  assert.ok(!requestedBrowser || Object.hasOwn(executable, requestedBrowser), 'NOVEL_VIEWER_BROWSER は chrome または edge を指定してください');
  const browser = browserCandidates.find(candidate =>
    (!requestedBrowser || path.basename(candidate.path) === executable[requestedBrowser]) && fs.existsSync(candidate.path));
  assert.ok(browser, requestedBrowser ? `指定したブラウザー (${requestedBrowser}) が見つかりません` : 'Google ChromeまたはMicrosoft Edgeが見つかりません');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-viewer-cdp-'));
  const sandboxArgs = process.env.NOVEL_VIEWER_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [];
  const headlessArgs = process.env.NOVEL_VIEWER_SHOW_BROWSER === '1' ? [] : ['--headless'];
  const cdpArgs = usePipe ? ['--remote-debugging-pipe'] : ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${requestedPort}`];
  // Edge can relaunch through a compatibility layer that loses the inherited CDP pipe.
  const edgeArgs = path.basename(browser.path) === executable.edge ? ['--edge-skip-compat-layer-relaunch'] : [];
  const browserArgs = [...headlessArgs, '--disable-gpu', ...sandboxArgs, '--no-first-run', ...edgeArgs, ...cdpArgs];
  const stdio = usePipe ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'];
  console.log(`  ブラウザー: ${browser.name} (${browser.path}) / CDP: ${usePipe ? 'pipe' : 'TCP'}`);
  let child;
  let childClosed;
  let ws;
  let policyServer;
  let exportedVideoHtml;
  const downloadPath = path.join(profile, 'downloads');
  const textFixture = path.join(profile, '.tmp-browser-text.txt');
  let cleaned = false;
  activeCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (policyServer) {
      const closed = new Promise(resolve => policyServer.close(resolve));
      policyServer.closeAllConnections();
      await closed;
    }
    if (child) {
      ws?.close();
      terminateBrowserTree(child);
      if (usePipe) {
        child.stdio[3].destroy();
        child.stdio[4].destroy();
      }
      await Promise.race([childClosed, sleep(1000)]);
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4 });
  };
  try {
    // Given: 対象HTMLが読み込まれた読書画面。When: 利用者の操作を送る。Then: 可視状態を確認する。
    const categories = new Map();
    const record = (category, name) => {
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category).push(name);
    };
    const connect = async (browserProfile = profile, startUrl = fileUrl) => {
      const args = [...browserArgs, `--user-data-dir=${browserProfile}`, usePipe ? 'about:blank' : startUrl];
      child = spawn(browser.path, args, { stdio });
      childClosed = new Promise(resolve => child.once('close', resolve));
      child.on('error', error => { childError += `spawn error: ${error.message}\n`; });
      child.on('exit', (code, signal) => { childExit = { code, signal }; });
      child.stderr.on('data', chunk => { childError += chunk.toString(); });
      let send;
      try {
        if (usePipe) {
          const sendBrowser = cdpPipe(child.stdio[3], child.stdio[4]);
          const { targetInfos } = await sendBrowser('Target.getTargets');
          const target = targetInfos.find(info => info.type === 'page' && info.url === 'about:blank');
          assert.ok(target, 'CDPパイプで初期ページを取得できません');
          const { sessionId } = await sendBrowser('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          send = (method, params) => sendBrowser(method, params, method.startsWith('Browser.') ? undefined : sessionId);
          const navigation = await send('Page.navigate', { url: startUrl });
          assert.ok(!navigation.errorText, navigation.errorText);
        } else {
          const port = requestedPort || await waitForDevToolsPort(browserProfile, child);
          const target = await waitForTarget(port, startUrl);
          ws = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
          send = cdp(ws);
        }
      } catch (error) {
        throw new Error(`CDP接続に失敗しました (args=${JSON.stringify(args)}, url=${startUrl}): ${error.message}`, { cause: error });
      }
      await send('Runtime.enable');
      await send('Page.enable');
      await send('DOM.enable');
      await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
      return send;
    };
    const closeBrowser = async command => {
      command('Browser.close').catch(() => {});
      const exited = await Promise.race([childClosed.then(() => true), sleep(5000).then(() => false)]);
      assert.ok(exited, 'テスト用ブラウザーを終了できません');
      child = undefined;
      ws = undefined;
    };
    fs.mkdirSync(downloadPath, { recursive: true });
    let send = await connect();
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '評価に失敗しました';
        throw new Error(`CDP評価失敗: ${details}`);
      }
      return result.result.value;
    };
    const exportRows = () => evaluate(`[...document.querySelectorAll('#loaded-file-downloads .file-action-group')]
      .filter(row => !row.querySelector('#btn-export-html'))
      .map(row => [...row.children].map(element => element.id || element.textContent))`);
    const textRow = ['テキスト', 'btn-download-text-delete', 'btn-download-text'];
    const imageRow = ['画像', 'btn-download-image-delete', 'btn-download-image'];
    const videoRow = ['動画', 'btn-download-video-delete', 'btn-download-video'];
    for (let i = 0; i < 30; i++) {
      if (await evaluate('document.readyState === "complete" && !!document.getElementById("shortcut-modal")')) break;
      await sleep(100);
    }
    assert.equal(await evaluate('!!document.getElementById("shortcut-modal")'), true, '本文ビューアーの初期化が完了しません');
    record('起動・初期化', '対象HTMLの読み込みとDOM初期化');
    const defaultArticle = await evaluate('document.getElementById("novel-content").textContent.trim()');
    const defaultRanges = {
      'font-size': 16, 'line-height': 2, 'letter-spacing': 0.04, 'content-width': 720,
      'content-padding': 48, 'ruby-scale': 0.5, 'panel-bg-alpha': 0.75, 'background-blur': 12
    };
    const typography = () => evaluate(`(() => {
      const root = document.documentElement;
      const article = document.getElementById('novel-content');
      const style = getComputedStyle(article);
      const viewer = document.getElementById('viewer-container');
      const containerStyle = getComputedStyle(viewer);
      const usableWidth = viewer.clientWidth - parseFloat(containerStyle.paddingLeft) - parseFloat(containerStyle.paddingRight);
      const expectedWidth = Math.min(parseFloat(style.getPropertyValue('--content-width')), usableWidth);
      return {
        settings: Object.fromEntries(${JSON.stringify(Object.keys(defaultRanges))}.map(key =>
          [key, document.getElementById('ctrl-' + key).valueAsNumber])),
        theme: root.dataset.theme, writingMode: style.writingMode, font: style.fontFamily.split(',').pop().trim(),
        fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
        widthMatches: Math.abs(parseFloat(style.width) - expectedWidth) < 1,
        width: style.getPropertyValue('--content-width').trim(), padding: style.paddingTop,
        rubyScale: Number(style.getPropertyValue('--ruby-scale')),
        panel: style.backgroundColor, blur: style.backdropFilter,
        colors: ['bg-color', 'narration-color', 'dialogue-color', 'panel-color'].map(key =>
          document.getElementById('ctrl-' + key).value),
        progressHidden: getComputedStyle(document.getElementById('progress-indicator')).opacity === '0',
        wakeLock: document.getElementById('ctrl-wake-lock').checked,
        auto: document.getElementById('ctrl-auto-sync').checked
      };
    })()`);
    const defaultTypography = {
      settings: defaultRanges, theme: 'light', writingMode: 'horizontal-tb', font: 'serif',
      fontSize: '16px', lineHeight: '32px', letterSpacing: '0.64px',
      widthMatches: true, width: '720px', padding: '48px', rubyScale: 0.5,
      panel: 'rgba(255, 255, 255, 0.75)', blur: 'blur(12px)',
      colors: ['#f7f7f7', '#1c1c1c', '#595959', '#ffffff'],
      progressHidden: true, wakeLock: false, auto: false
    };
    assert.deepEqual(await typography(), defaultTypography);
    record('設定', '新規プロファイルの初期設定を設定欄と計算済みスタイルで確認');
    const wakeStatus = await evaluate('document.getElementById("wake-lock-status").textContent');
    assert.match(wakeStatus, /^(（有効）|（待機中）|（取得失敗）|（利用不可）|)$/);
    record('起動・初期化', 'Wake Lockステータス表示');

    const enabledWakeStatus = await evaluate(`(async () => {
      const control = document.getElementById('ctrl-wake-lock');
      const status = document.getElementById('wake-lock-status');
      if (control.disabled) return status.textContent;
      control.click();
      try {
        for (let i = 0; i < 30 && !status.textContent; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return status.textContent;
      } finally {
        control.click();
      }
    })()`);
    assert.match(enabledWakeStatus, /^(（有効）|（待機中）|（取得失敗）|（利用不可）)$/);
    console.log(`  Wake Lock: ${enabledWakeStatus}`);
    record('起動・初期化', 'ブラウザーのWake Lock要求結果を表示');

    await sleep(1000);
    await evaluate('document.getElementById("ctrl-show-progress").click()');
    await sleep(100);
    await send('Page.reload', { ignoreCache: true });
    let restored = false;
    for (let i = 0; i < 40; i++) {
      restored = await evaluate('document.readyState === "complete" && !!document.getElementById("ctrl-show-progress") && document.getElementById("ctrl-show-progress").checked');
      if (restored) break;
      await sleep(100);
    }
    assert.equal(restored, true, '再読み込み後に表示設定が復元されません');
    record('保存・復元', '再読み込み後に設定を復元');
    assert.equal(await evaluate('(async () => (await indexedDB.databases()).some(db => db.name === "hitohira_media_db"))()'), true, '媒体保存用IndexedDBが初期化されません');
    record('保存・復元', '媒体保存用IndexedDBを初期化');
    assert.equal(await evaluate('!!document.getElementById("btn-export-html")'), true, 'HTMLエクスポート操作がありません');
    assert.equal(await evaluate('document.getElementById("btn-export-html").disabled'), false, 'HTMLエクスポート操作が無効です');
    record('エクスポート', 'HTMLエクスポート操作を有効化');
    assert.equal(await evaluate('(() => { document.getElementById("btn-export-html").click(); return true; })()'), true, 'HTMLエクスポート操作を実行できません');
    await sleep(800);
    const downloadedFiles = fs.readdirSync(downloadPath).filter(name => name.endsWith('.html'));
    assert.ok(downloadedFiles.length > 0, 'HTMLエクスポートファイルが生成されません');
    record('エクスポート', 'HTMLエクスポート操作を実行');
    fs.writeFileSync(textFixture, 'ブラウザー操作テスト本文\n', 'utf8');
    const textDocument = await send('DOM.getDocument', { depth: -1 });
    const textInput = await send('DOM.querySelector', { nodeId: textDocument.root.nodeId, selector: '#file-input' });
    const htmlFixture = path.join(profile, 'sanitization.html');
    fs.writeFileSync(htmlFixture, [
      '<title>HTML本文の検証</title><p>取り込み範囲外</p>',
      '<div id="novel-content"><div id="extra" style="color:red" onclick="">',
      '<!-- コメント --><p><span class="dialogue" data-extra="x">「本文」</span>',
      '<a href="https://example.test/" target="_self" rel="opener">外部</a>',
      '<a href="../chapter.html" target="_blank">相対</a>',
      '<a href="file:///example.html">未許可</a>',
      '<img src="data:text/plain,example" alt="画像" onerror=""></p>',
      '<section><em>非対応要素内の文字</em></section></div></div>'
    ].join(''), 'utf8');
    await send('DOM.setFileInputFiles', { nodeId: textInput.nodeId, files: [htmlFixture] });
    for (let i = 0; i < 30; i++) {
      if (await evaluate('document.title === "HTML本文の検証"')) break;
      await sleep(100);
    }
    assert.equal(await evaluate('document.querySelector("#novel-content").innerHTML'), [
      '<div><p><span class="dialogue">「本文」</span>',
      '<a href="https://example.test/" target="_blank" rel="noopener noreferrer">外部</a>',
      '<a href="../chapter.html">相対</a><a>未許可</a><img alt="画像"></p>',
      '非対応要素内の文字</div>'
    ].join(''), 'HTML取り込み後の本文DOMがサニタイズ結果と一致しません');
    record('インポート', 'HTML取り込み後の本文DOMをサニタイズ');
    const dropFile = async file => {
      const drop = { x: 20, y: 20, data: { items: [], files: [file], dragOperationsMask: 1 } };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { ...drop, type });
    };
    await dropFile(textFixture);
    await sleep(500);
    assert.equal(await evaluate('document.title'), '.tmp-browser-text', 'テキストファイルstemがタイトルへ反映されません');
    assert.equal(await evaluate('document.getElementById("novel-content").textContent.trim()'), 'ブラウザー操作テスト本文');
    assert.equal(await evaluate('document.body.classList.contains("drag-over")'), false);
    record('インポート', '実ファイルをドロップして本文を取り込む');
    assert.equal(await evaluate('(async () => new Promise((resolve, reject) => { const request = indexedDB.open("hitohira_media_db"); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const tx = db.transaction("background_media", "readonly"); const get = tx.objectStore("background_media").get("current_text"); get.onsuccess = () => resolve(!!get.result && get.result.blob instanceof Blob); get.onerror = () => reject(get.error); }; }))()'), true, '本文元ファイルがIndexedDBへ保存されません');
    record('保存・復元', '本文元ファイルを保存');
    await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=vertical]").click()');
    await evaluate('document.getElementById("btn-theme-toggle").click()');
    assert.equal(await evaluate('document.documentElement.dataset.writingMode'), 'vertical');
    const exportedTheme = await evaluate('document.documentElement.dataset.theme');
    record('エクスポート', '現在の書字方向・テーマをエクスポート対象へ反映');

    const colorState = () => evaluate(`(() => {
      const root = document.documentElement;
      const auto = document.getElementById('ctrl-auto-sync');
      return {
        theme: root.dataset.theme, enabled: !auto.disabled, checked: auto.checked,
        backdrop: getComputedStyle(document.body).backgroundColor,
        article: getComputedStyle(document.getElementById('novel-content')).color,
        panel: getComputedStyle(document.getElementById('novel-content')).backgroundColor,
        dialogue: document.getElementById('ctrl-dialogue-color').value
      };
    })()`);
    const setSolidBackground = color => evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 50;
      const painter = canvas.getContext('2d');
      painter.fillStyle = ${JSON.stringify(color)};
      painter.fillRect(0, 0, canvas.width, canvas.height);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const input = document.getElementById('file-input');
      const transfer = new DataTransfer();
      transfer.items.add(new File([png], 'auto-color.png', { type: 'image/png' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const waitForColors = async expected => {
      for (let i = 0; i < 50; i++) {
        const actual = await colorState();
        if (Object.keys(expected).every(key => actual[key] === expected[key])) return;
        await sleep(100);
      }
      const actual = await colorState();
      assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected,
        '表示色が期待値に一致しません');
    };
    await waitForColors(exportedTheme === 'dark'
      ? { backdrop: 'rgb(10, 10, 10)', panel: 'rgba(0, 0, 0, 0.75)' }
      : { backdrop: 'rgb(247, 247, 247)', panel: 'rgba(255, 255, 255, 0.75)' });
    const manualColors = await colorState();
    assert.equal(manualColors.enabled, false);
    await setSolidBackground('#204060');
    await waitForColors({ enabled: true });
    await evaluate('document.getElementById("ctrl-auto-sync").click()');
    await waitForColors({
      ...manualColors, enabled: true, checked: true,
      article: 'rgb(219, 219, 219)', panel: 'rgba(32, 64, 96, 0.75)', dialogue: '#b8b8b8'
    });
    await setSolidBackground('#e0c0a0');
    await waitForColors({
      ...manualColors, enabled: true, checked: true,
      article: 'rgb(36, 36, 36)', panel: 'rgba(224, 192, 160, 0.75)', dialogue: '#474747'
    });
    await evaluate('document.getElementById("ctrl-auto-sync").click()');
    await waitForColors({ ...manualColors, enabled: true });
    await evaluate('document.getElementById("btn-download-image-delete").click()');
    await waitForColors(manualColors);
    record('設定', '暗いPNGと明るいPNGで自動配色を切り替え、個別色を復元');

    const imagePath = path.join(root, 'Anima_00036_.png');
    if (fs.existsSync(imagePath)) {
      await dropFile(imagePath);
      await sleep(800);
      assert.equal(await evaluate('document.body.classList.contains("has-bg")'), true, '画像が背景へ反映されません');
      record('インポート', '画像ファイルをドロップして背景へ反映');
    assert.equal(await evaluate('(async () => new Promise((resolve, reject) => { const request = indexedDB.open("hitohira_media_db"); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const tx = db.transaction("background_media", "readonly"); const get = tx.objectStore("background_media").get("current"); get.onsuccess = () => { resolve(!!get.result && get.result.mediaType === "image" && get.result.blob instanceof Blob); }; get.onerror = () => reject(get.error); }; }))()'), true, '画像がIndexedDBへ保存されません');
      record('保存・復元', '画像をIndexedDBへ保存');
      const png = fs.readFileSync(imagePath);
      const imageWidth = png.readUInt32BE(16);
      const imageHeight = png.readUInt32BE(20);
      const { width, height, x, y } = await evaluate(`(() => {
        const width = innerWidth;
        const height = innerHeight;
        const x = Math.floor(width / 2);
        const y = 5;
        if (document.elementFromPoint(x, y)?.closest('#novel-content, .drawer-panel, #btn-open-settings')) {
          throw new Error('背景をドラッグするための余白がありません');
        }
        return { width, height, x, y };
      })()`);
      const dragOffsets = (mediaWidth, mediaHeight) => {
        const coverScale = Math.max(width / mediaWidth, height / mediaHeight);
        const offsetX = Math.max(0, (mediaWidth * coverScale - width) / 2);
        const offsetY = Math.max(0, (mediaHeight * coverScale - height) / 2);
        const dx = offsetX > offsetY ? Math.min(40, Math.floor(offsetX), width - x - 1) : 0;
        const dy = offsetY >= offsetX ? Math.min(40, Math.floor(offsetY), height - y - 1) : 0;
        assert.ok(dx || dy, '検証メディアにドラッグ可能な範囲がありません');
        return [dx, dy];
      };
      const indicatorVisible = () => evaluate('getComputedStyle(document.getElementById("bg-viewport-indicator")).display !== "none"');
      const backgroundPosition = () => evaluate(`['--bg-pos-x', '--bg-pos-y'].map(name =>
        document.documentElement.style.getPropertyValue(name))`);
      const cssPosition = offsets => offsets.map(offset => `calc(50% + ${offset}px)`);
      const dragWithMouse = async ([dx, dy]) => {
        const end = { x: x + (dx || 20), y: y + (dy || 20) };
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x, y });
        assert.equal(await indicatorVisible(), true, '背景ドラッグ中に縮小図が表示されません');
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...end });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...end });
        assert.equal(await indicatorVisible(), false, '背景ドラッグ終了後も縮小図が表示されています');
        assert.deepEqual(await backgroundPosition(), cssPosition([dx, dy]));
      };
      const imageOffsets = dragOffsets(imageWidth, imageHeight);
      const draggedPosition = cssPosition(imageOffsets);
      await dragWithMouse(imageOffsets);
      await closeBrowser(send);
      fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
      send = await connect();
      for (let i = 0; i < 40; i++) {
        if (await evaluate('document.readyState === "complete" && !!document.getElementById("shortcut-modal")')) break;
        await sleep(100);
      }
      let restoredImage = false;
      for (let i = 0; i < 40; i++) {
        restoredImage = await evaluate('document.body.classList.contains("has-bg")');
        if (restoredImage) break;
        await sleep(100);
      }
      assert.equal(restoredImage, true, 'ブラウザー再起動後に保存済み画像が背景へ復元されません');
      assert.equal(await evaluate('!!document.getElementById("btn-download-text")'), true, '再起動後に本文の元ファイルが復元されません');
      assert.equal(await evaluate('document.title'), '.tmp-browser-text', '再起動後に本文のタイトルが復元されません');
      record('保存・復元', 'ブラウザー再起動後に背景画像と本文元ファイルを復元');
      for (let i = 0; i < 40; i++) {
        const position = await backgroundPosition();
        if (position.every((value, axis) => value === draggedPosition[axis])) break;
        await sleep(100);
      }
      assert.deepEqual(await backgroundPosition(), draggedPosition, '再起動後に背景画像のドラッグ位置が復元されません');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 2, x, y });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 2, x, y });
      assert.deepEqual(await backgroundPosition(), ['calc(50% + 0px)', 'calc(50% + 0px)'], 'ダブルクリックで背景位置が中央に戻りません');
      record('背景操作', '画像をドラッグして位置を保存・復元し、ダブルクリックで中央に戻す');
      const touch = (type, touchPoints) => send('Input.dispatchTouchEvent', { type, touchPoints });
      await touch('touchStart', [{ x, y }]);
      assert.equal(await indicatorVisible(), true, 'タッチ開始時に縮小図が表示されません');
      await touch('touchMove', [{ x: x + imageOffsets[0], y: y + imageOffsets[1] }]);
      await touch('touchEnd', []);
      assert.deepEqual(await backgroundPosition(), draggedPosition, 'タッチ操作で背景を移動できません');
      assert.equal(await indicatorVisible(), false, 'タッチ終了後も縮小図が表示されています');
      await touch('touchStart', [{ x, y }]);
      assert.equal(await indicatorVisible(), true);
      await touch('touchCancel', []);
      assert.equal(await indicatorVisible(), false, 'タッチ中断後も縮小図が表示されています');
      record('背景操作', 'タッチで背景を移動し、終了・中断で縮小図を閉じる');
      await evaluate('document.getElementById("btn-export-html").click()');
      await sleep(800);
      const exportedHtmlFiles = fs.readdirSync(downloadPath).filter(name => name.endsWith('.html'));
      assert.ok(exportedHtmlFiles.length > 0, '画像付きHTMLが生成されません');
      const latestExport = exportedHtmlFiles
        .map(name => ({ name, mtime: fs.statSync(path.join(downloadPath, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0].name;
      const exportedHtml = fs.readFileSync(path.join(downloadPath, latestExport), 'utf8');
      assert.ok(!/<(?:html|body)\b[^>]*\bblob:/i.test(exportedHtml), '画像エクスポートのルート要素に実行時Blob URLが残っています');
      assert.ok(!/<body\b[^>]*\b(?:has-bg|video-bg)\b/i.test(exportedHtml), '画像エクスポートに背景の実行時クラスが残っています');
      assert.match(exportedHtml, /viewer-download-data/);
      assert.match(exportedHtml, /data:image\//, 'エクスポートHTMLに画像Data URLが埋め込まれていません');
      record('メディア・エクスポート', '画像Data URLをHTMLへ埋め込む');
      assert.deepEqual(await exportRows(), [textRow, imageRow]);
      await evaluate('document.getElementById("btn-download-image-delete").click()');
      await sleep(300);
      assert.equal(await evaluate('document.body.classList.contains("has-bg")'), false, '画像削除が画面へ反映されません');
      assert.deepEqual(await exportRows(), [textRow]);
      record('メディア・エクスポート', '画像の個別削除を画面へ反映');

      const resetDocument = await send('DOM.getDocument');
      const resetInput = await send('DOM.querySelector', { nodeId: resetDocument.root.nodeId, selector: '#file-input' });
      await send('DOM.setFileInputFiles', { nodeId: resetInput.nodeId, files: [imagePath] });
      for (let i = 0; i < 50; i++) {
        if (await evaluate('!!document.getElementById("btn-download-image")')) break;
        await sleep(100);
      }
      const resetState = () => evaluate(`(async () => {
    const keys = ['hitohira_settings', 'hitohira_content', 'hitohira_position:default'];
        const local = keys.map(key => localStorage.getItem(key));
        const indexed = await new Promise((resolve, reject) => {
          const request = indexedDB.open('hitohira_media_db');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('background_media');
            const store = tx.objectStore('background_media');
            const requests = ['current', 'current_text'].map(key => store.get(key));
            tx.oncomplete = () => { db.close(); resolve(requests.map(entry => entry.result?.blob instanceof Blob)); };
            tx.onabort = () => { db.close(); reject(tx.error); };
          };
        });
        return { local, indexed, title: document.title, hasBackground: document.body.classList.contains('has-bg'),
          originalFiles: !!document.querySelector('#btn-download-text, #btn-download-image'),
          writingMode: document.documentElement.dataset.writingMode, exportEnabled: !document.getElementById('btn-export-html').disabled };
      })()`);
      await evaluate('localStorage.setItem("hitohira_position:default", JSON.stringify({ scrollLeft: -123, writingMode: "vertical" }))');
      const beforeReset = await resetState();
      assert.ok(beforeReset.local.every(value => value !== null), '初期化前の設定・本文・読書位置が揃いません');
      assert.deepEqual(beforeReset.indexed, [true, true]);
      await evaluate('document.getElementById("btn-reset-all").click()');
      for (let i = 0; i < 50; i++) {
        if (await evaluate('document.getElementById("btn-reset-all").disabled')) break;
        await sleep(100);
      }
      assert.deepEqual(await resetState(), {
        local: [null, null, null], indexed: [false, false], title: 'Hitohira',
        hasBackground: false, originalFiles: false, writingMode: 'horizontal', exportEnabled: true
      });
      assert.equal(await evaluate('document.getElementById("novel-content").textContent.trim()'), defaultArticle);
      record('保存・復元', '通常版の初期化で設定・本文・読書位置・元ファイルを一括削除');

      const exportedUrl = pathToFileURL(path.join(downloadPath, latestExport)).href;
      await send('Page.navigate', { url: exportedUrl });
      for (let i = 0; i < 40; i++) {
        if (await evaluate('document.readyState === "complete" && !!document.getElementById("shortcut-modal")')) break;
        await sleep(100);
      }
      assert.equal(await evaluate('document.body.classList.contains("has-bg")'), true, '再読込したエクスポートHTMLの背景が復元されません');
      record('メディア・エクスポート', 'エクスポートHTML再読込で背景を復元');
      assert.equal(await evaluate('document.title'), '.tmp-browser-text', 'エクスポートHTML再読込で本文ファイルstemがタイトルへ復元されません');
      record('保存・復元', 'エクスポートHTML再読込でタイトルを復元');
      assert.equal(await evaluate('document.documentElement.dataset.writingMode'), 'vertical', 'エクスポートHTML再読込で書字方向が復元されません');
      record('保存・復元', 'エクスポートHTML再読込で書字方向を復元');
      assert.equal(await evaluate('document.documentElement.dataset.theme'), exportedTheme, 'エクスポートHTML再読込でテーマが復元されません');
      record('保存・復元', 'エクスポートHTML再読込でテーマを復元');

      const embeddedDigest = () => evaluate(`(async () => {
        const data = document.getElementById('viewer-download-data').textContent;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
        return Array.from(new Uint8Array(digest));
      })()`);
      const exportedState = () => evaluate(`({
        article: document.getElementById('novel-content').textContent.trim(),
        title: document.title,
        theme: document.documentElement.dataset.theme,
        writingMode: document.documentElement.dataset.writingMode,
        background: document.body.classList.contains('has-bg'),
        originals: ['text', 'image', 'video'].map(type => !!document.getElementById('btn-download-' + type)),
        exportEnabled: !document.getElementById('btn-export-html').disabled
      })`);
      const beforeExportReset = await exportedState();
      assert.deepEqual(beforeExportReset.originals, [true, true, false]);
      assert.notEqual(beforeExportReset.article, defaultArticle);
      const digestBeforeReset = await embeddedDigest();
      await evaluate('document.getElementById("btn-reset-all").click()');
      for (let i = 0; i < 50; i++) {
        if (await evaluate('document.getElementById("btn-reset-all").disabled')) break;
        await sleep(100);
      }
      assert.deepEqual(await exportedState(), {
        article: defaultArticle, title: 'Hitohira', theme: 'light', writingMode: 'horizontal',
        background: false, originals: [false, false, false], exportEnabled: true
      });
      assert.deepEqual(await embeddedDigest(), digestBeforeReset, '初期化でHTML内蔵データが変化しました');
      await send('Page.reload', { ignoreCache: true });
      for (let i = 0; i < 50; i++) {
        if (await evaluate('!!document.getElementById("btn-download-image")')) break;
        await sleep(100);
      }
      assert.deepEqual(await exportedState(), beforeExportReset);
      record('保存・復元', 'エクスポートHTMLを初期化しても再読み込みで内蔵データが復元される');

      const embeddedDataScript = /(<script[^>]+id="viewer-download-data"[^>]*>)([\s\S]*?)(<\/script>)/;
      assert.match(exportedHtml, embeddedDataScript);
      for (const [name, corrupt, hasTextOriginal] of [
        ['invalid-json', () => '{', false],
        ['invalid-media', json => JSON.stringify({ ...JSON.parse(json), mediaDataUrl: 'data:image/png;base64,!' }), true],
        ['undecodable-image', json => JSON.stringify({ ...JSON.parse(json), mediaDataUrl: 'data:image/png;base64,AAAA' }), true],
        ['undecodable-video', json => JSON.stringify({
          ...JSON.parse(json), mediaType: 'video', mediaExtension: '.webm', mediaDataUrl: 'data:video/webm;base64,AAAA'
        }), true]
      ]) {
        const brokenPath = path.join(profile, name + '.html');
        const brokenHtml = exportedHtml.replace(embeddedDataScript, (_, open, json, close) => open + corrupt(json) + close);
        fs.writeFileSync(brokenPath, brokenHtml, 'utf8');
        const brokenUrl = pathToFileURL(brokenPath).href;
        await send('Page.navigate', { url: brokenUrl });
        for (let i = 0; i < 40; i++) {
          if (await evaluate(`location.href === ${JSON.stringify(brokenUrl)} && document.getElementById("error-notice")?.hidden === false`)) break;
          await sleep(100);
        }
        assert.equal(await evaluate('document.getElementById("error-notice").hidden'), false, name);
        assert.match(await evaluate('document.getElementById("error-notice-message").textContent'), /内蔵データを復元できませんでした/);
        assert.deepEqual(await exportedState(), {
          ...beforeExportReset, background: false, originals: [hasTextOriginal, false, false]
        }, name);
      }
      record('保存・復元', '内蔵JSON・背景データ破損と画像・動画のデコード失敗時に通知し、本文を表示');
      await send('Page.navigate', { url: exportedUrl });
      for (let i = 0; i < 40; i++) {
        if (await evaluate('!!document.getElementById("btn-download-image")')) break;
        await sleep(100);
      }
      const videoPath = path.join(root, 'tests', 'fixtures_background.webm');
      const reloadedDocument = await send('DOM.getDocument', { depth: -1 });
      const reloadedInput = await send('DOM.querySelector', { nodeId: reloadedDocument.root.nodeId, selector: '#file-input' });
      await send('DOM.setFileInputFiles', { nodeId: reloadedInput.nodeId, files: [videoPath] });
      await sleep(1000);
      assert.equal(await evaluate('document.body.classList.contains("video-bg")'), true, '動画が背景へ反映されません');
      assert.equal(await evaluate('document.getElementById("background-video").muted'), true, '背景動画がミュートされません');
      assert.equal(await evaluate('document.getElementById("background-video").loop'), true, '背景動画がループされません');
      assert.equal(await evaluate('document.getElementById("background-video").paused'), false, '背景動画が再生されません');
      record('メディア・エクスポート', '動画を背景へ反映して再生');
      assert.deepEqual(await exportRows(), [textRow, videoRow]);
      record('エクスポート', '個別行が追加・削除と画像から動画への置き換えに追従');
      const videoBeforeDrag = await evaluate(`(() => {
        const video = document.getElementById('background-video');
        return { src: video.src, width: video.videoWidth, height: video.videoHeight, left: video.style.left, top: video.style.top };
      })()`);
      await dragWithMouse(dragOffsets(videoBeforeDrag.width, videoBeforeDrag.height));
      const videoAfterDrag = await evaluate(`(() => {
        const video = document.getElementById('background-video');
        return { src: video.src, paused: video.paused, left: video.style.left, top: video.style.top };
      })()`);
      assert.equal(videoAfterDrag.src, videoBeforeDrag.src);
      assert.equal(videoAfterDrag.paused, false);
      assert.notDeepEqual([videoAfterDrag.left, videoAfterDrag.top], [videoBeforeDrag.left, videoBeforeDrag.top]);
      record('背景操作', '動画をドラッグして移動しても再生を継続');
      let storedVideo = false;
      for (let i = 0; i < 40; i++) {
        storedVideo = await evaluate('(async () => new Promise(resolve => { const request = indexedDB.open("hitohira_media_db"); request.onerror = () => resolve(false); request.onsuccess = () => { const tx = request.result.transaction("background_media", "readonly"); const get = tx.objectStore("background_media").get("current"); get.onsuccess = () => resolve(get.result?.mediaType === "video"); get.onerror = () => resolve(false); }; }))()');
        if (storedVideo) break;
        await sleep(100);
      }
      assert.equal(storedVideo, true, '動画がIndexedDBへ保存される前にエクスポートされました');
      const exportBeforeVideo = new Map(fs.readdirSync(downloadPath).filter(name => name.endsWith('.html')).map(name => [name, fs.statSync(path.join(downloadPath, name)).mtimeMs]));
      await evaluate('document.getElementById("btn-export-html").click()');
      let videoExport = null;
      let videoExportHtml = null;
      for (let i = 0; i < 60; i++) {
        const candidates = fs.readdirSync(downloadPath).filter(name => name.endsWith('.html')).map(name => ({ name, mtime: fs.statSync(path.join(downloadPath, name)).mtimeMs })).filter(file => !exportBeforeVideo.has(file.name) || file.mtime > exportBeforeVideo.get(file.name));
        for (const candidate of candidates) {
          const content = fs.readFileSync(path.join(downloadPath, candidate.name), 'utf8');
          if (/data:video\//.test(content)) { videoExport = candidate; videoExportHtml = content; break; }
        }
        if (videoExport) break;
        await sleep(100);
      }
      assert.ok(videoExport, '動画エクスポートファイルが生成されません');
      exportedVideoHtml = videoExportHtml;
      assert.match(videoExportHtml, /data:video\//, '動画Data URLがエクスポートされません');
      assert.ok(!/<(?:html|body|video)\b[^>]*\bblob:/i.test(videoExportHtml), '動画エクスポートに実行時Blob URLが残っています');
      assert.ok(!/<body\b[^>]*\b(?:has-bg|video-bg)\b/i.test(videoExportHtml), '動画エクスポートに背景の実行時クラスが残っています');
      const videoRoundtripPath = path.join(downloadPath, 'video-roundtrip.html');
      fs.writeFileSync(videoRoundtripPath, videoExportHtml, 'utf8');
      const videoExportUrl = pathToFileURL(videoRoundtripPath).href;
      await send('Page.navigate', { url: videoExportUrl });
      for (let i = 0; i < 40; i++) {
        if (await evaluate(`location.href === ${JSON.stringify(videoExportUrl)} && document.readyState === "complete" && !!document.getElementById("shortcut-modal")`)) break;
        await sleep(100);
      }
      let restoredVideo = false;
      for (let i = 0; i < 60; i++) {
        restoredVideo = await evaluate('document.body.classList.contains("video-bg")');
        if (restoredVideo) break;
        await sleep(100);
      }
      if (!restoredVideo) {
        const videoDiagnostics = await evaluate('(() => { const data = document.getElementById("viewer-download-data"); const parsed = data ? JSON.parse(data.textContent || "{}") : {}; const video = document.getElementById("background-video"); return { location: location.href, exported: document.documentElement.dataset.exported, mediaType: parsed.mediaType, mediaIncluded: parsed.mediaIncluded, dataUrlPrefix: String(parsed.mediaDataUrl || "").slice(0, 32), hasVideo: !!video, srcPrefix: video ? video.src.slice(0, 32) : "", readyState: video ? video.readyState : -1, paused: video ? video.paused : null }; })()');
        assert.fail(`動画エクスポートHTMLの背景が復元されません: ${JSON.stringify(videoDiagnostics)}`);
      }
      assert.equal(await evaluate('document.getElementById("background-video").paused'), false, '動画エクスポートHTMLの動画が再生されません');
      record('メディア・エクスポート', '動画エクスポートHTML再読込で背景・再生を復元');

      const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `HTMLMediaElement.prototype.play = function () {
          this.autoplay = false;
          this.pause();
          return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
        };`
      });
      try {
        await send('Page.reload', { ignoreCache: true });
        const rejectionNotice = 'document.getElementById("error-notice")';
        const noticeVisible = `!!${rejectionNotice} && !${rejectionNotice}.hidden`;
        for (let i = 0; i < 60; i++) {
          if (await evaluate(noticeVisible)) break;
          await sleep(100);
        }
        assert.equal(await evaluate(noticeVisible), true, '自動再生拒否が通知されません');
        assert.match(await evaluate(`${rejectionNotice}.textContent`), /背景動画の自動再生を拒否/);
        assert.equal(await evaluate('document.body.classList.contains("video-bg")'), true);
        assert.equal(await evaluate('document.getElementById("background-video").paused'), true);
        await evaluate('document.getElementById("btn-close-error-notice").click()');
        record('メディア・エクスポート', '背景動画の自動再生拒否時に通知し、背景と停止状態を維持');
      } finally {
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      }
    }


    await dispatchKey(send, 'F1', 'F1', { windowsVirtualKeyCode: 112 });
    assert.equal(await evaluate('document.getElementById("shortcut-modal").open'), true, 'F1でヘルプモーダルが開きません');
    record('ヘルプ・モーダル', 'F1で開く');

    await evaluate('document.getElementById("btn-close-help").click()');
    assert.equal(await evaluate('document.getElementById("shortcut-modal").open'), false, '閉じる操作でモーダルが閉じません');
    record('ヘルプ・モーダル', '閉じるボタンで閉じる');

    await evaluate('document.getElementById("btn-open-help").click()');
    assert.equal(await evaluate('document.getElementById("shortcut-modal").open'), true, 'ヘルプアイコンでモーダルが開きません');
    record('ヘルプ・モーダル', 'ヘルプアイコンで開く');
    await evaluate('document.getElementById("btn-close-help").click()');

    await evaluate('document.getElementById("viewer-container").focus()');
    await dispatchKey(send, 's', 'KeyS', { text: 's' });
    assert.equal(await evaluate('document.getElementById("settings-drawer").classList.contains("is-open")'), true, 'Sで設定が開きません');
    record('設定', 'Sで設定ドロワーを開く');
    await evaluate('(() => { const input = document.getElementById("ctrl-content-width"); input.value = "760"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    assert.equal(await evaluate('document.getElementById("ctrl-content-width").value'), '760', '本文幅スライダーを操作できません');
    record('設定', '本文幅スライダー');
    const themeBefore = await evaluate('document.documentElement.dataset.theme');
    const colorOverrides = { 'ctrl-bg-color': '#123456', 'ctrl-narration-color': '#234567', 'ctrl-panel-color': '#345678' };
    await evaluate(`(() => {
      for (const [id, value] of Object.entries(${JSON.stringify(colorOverrides)})) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await evaluate('document.getElementById("btn-theme-toggle").click()');
    assert.notEqual(await evaluate('document.documentElement.dataset.theme'), themeBefore, 'テーマ切替を操作できません');
    record('設定', 'テーマ切替');
    assert.deepEqual(await evaluate(`Object.fromEntries(${JSON.stringify(Object.keys(colorOverrides))}
      .map(id => [id, document.getElementById(id).value]))`), colorOverrides);
    assert.equal(await evaluate('document.getElementById("ctrl-dialogue-color").value'), themeBefore === 'dark' ? '#595959' : '#b8b8b8');
    const renderedColors = () => evaluate(`(() => {
      const article = getComputedStyle(document.getElementById('novel-content'));
      return [getComputedStyle(document.body).backgroundColor, article.color, article.backgroundColor];
    })()`);
    const expectedColors = ['rgb(18, 52, 86)', 'rgb(35, 69, 103)', 'rgba(52, 86, 120, 0.75)'];
    for (let i = 0; i < 20; i++) {
      if (JSON.stringify(await renderedColors()) === JSON.stringify(expectedColors)) break;
      await sleep(50);
    }
    assert.deepEqual(await renderedColors(), expectedColors, 'テーマ切り替え後の表示色が個別設定と一致しません');
    record('設定', 'テーマ切り替えで個別色を保持し、既定色は切り替え先の既定色に更新');
    await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=vertical]").click()');
    assert.equal(await evaluate('document.documentElement.dataset.writingMode'), 'vertical', '縦書き切替を操作できません');
    record('設定', '書字方向切替');
    await evaluate('document.querySelector("#ctrl-font button[data-value=sans]").click()');
    assert.equal(await evaluate('document.querySelector("#ctrl-font button[data-value=sans]").classList.contains("is-active")'), true, 'フォント切替を操作できません');
    record('設定', 'フォント切替');
    assert.equal(await evaluate('document.getElementById("ctrl-show-progress").checked'), true, '進捗表示切替を操作できません');
    record('設定', '進捗表示切替');
    await evaluate('document.getElementById("btn-reset-all").click()');
    await sleep(100);
    assert.equal(await evaluate('document.getElementById("btn-reset-all").disabled'), true, '設定初期化後にボタンが無効化されません');
    record('設定', '設定初期化');

    await evaluate('document.getElementById("viewer-container").focus()');
    await dispatchKey(send, 'o', 'KeyO', { text: 'o' });
    assert.equal(await evaluate('document.getElementById("toc-drawer").classList.contains("is-open")'), true, 'Oで目次が開きません');
    record('ドロワー・キーボード', 'Oで目次ドロワーを開く');

    await dispatchKey(send, 'Escape', 'Escape', { windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate('document.getElementById("toc-drawer").classList.contains("is-open")'), false, 'Escapeで目次が閉じません');
    assert.equal(await evaluate('document.getElementById("settings-drawer").classList.contains("is-open")'), false, 'Escapeで設定が閉じません');
    record('ドロワー・キーボード', 'Escapeでドロワーを閉じる');
    const readingViewer = path.join(profile, 'reading-viewer.html');
      fs.copyFileSync(path.join(root, 'hitohira.html'), readingViewer);
    const readingDocument = path.join(profile, 'reading-chapters.html');
    const chapters = Array.from({ length: 7 }, (_, chapter) =>
      `<h1>第${chapter + 1}章</h1>` + Array.from({ length: 16 }, (_, paragraph) =>
        `<p>Hitohira 章${chapter + 1}・段落${paragraph + 1}。${'窓から差し込む光が、机の上をゆっくり移動した。'.repeat(7)}<ruby>光<rt>ひかり</rt></ruby></p>`).join('')).join('');
    fs.writeFileSync(readingDocument, chapters, 'utf8');
    const readingUrl = pathToFileURL(readingViewer).href;
    const waitForReading = async (condition, message) => {
      for (let i = 0; i < 50; i++) {
        if (await evaluate(condition)) return;
        await sleep(100);
      }
      assert.fail(message);
    };
    await send('Page.navigate', { url: readingUrl });
    await waitForReading(`location.href === ${JSON.stringify(readingUrl)} && document.readyState === 'complete'`, '読書位置の検証用ビューアを開けません');
    await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=horizontal]").click()');
    await waitForReading('document.documentElement.dataset.writingMode === "horizontal"', '検証用ビューアを横書きにできません');
    await dropFile(readingDocument);
    await waitForReading("document.title === 'reading-chapters' && document.querySelectorAll('#novel-content h1').length === 7", '検証本文を取り込めません');
    const readingTarget = "document.querySelectorAll('#novel-content p')[53]";
    await evaluate(`${readingTarget}.scrollIntoView({ block: 'start', inline: 'start' })`);
    const savedReadingPosition = 'JSON.parse(localStorage.getItem("hitohira_position:default"))';
    await waitForReading(`${savedReadingPosition}?.lineIndex === 57`, '途中の本文ブロックが保存されません');
    const savedScrollTop = await evaluate(`${savedReadingPosition}.scrollTop`);
    assert.ok(savedScrollTop > 0);
    const previousDocumentTime = await evaluate('performance.timeOrigin');
    await send('Page.reload', { ignoreCache: true });
    await waitForReading(`performance.timeOrigin !== ${previousDocumentTime} && !!${readingTarget} &&
      document.getElementById('viewer-container').scrollTop === ${savedScrollTop}`,
      '再読み込み後に横書きの保存位置が復元されません');
    assert.equal(await evaluate(`${savedReadingPosition}.lineIndex`), 57);
    record('読書位置', '複数章の本文を再読み込みして横書きの保存位置を復元');

    await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=vertical]").click()');
    await waitForReading(`(() => {
      const viewer = document.getElementById('viewer-container');
      const block = ${readingTarget}.getBoundingClientRect();
      return viewer.scrollLeft < 0 && Math.abs(block.right - viewer.getBoundingClientRect().right) <= 2;
    })()`, '縦書きに切り替えると同じ本文ブロックへ移動できません');
    await waitForReading(`${savedReadingPosition}?.writingMode === 'vertical' && ${savedReadingPosition}.lineIndex === 57`,
      '縦書きの本文位置が保存されません');
    await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=horizontal]").click()');
    await waitForReading(`document.getElementById('viewer-container').scrollTop === ${savedScrollTop} &&
      ${savedReadingPosition}?.writingMode === 'horizontal' && ${savedReadingPosition}.lineIndex === 57`,
      '横書きに戻すと同じ本文ブロックへ移動できません');
    record('読書位置', '縦書きと横書きを切り替えても同じ本文ブロックを表示');

    const viewer = "document.getElementById('viewer-container')";
    const verifyHeldScroll = async (mode, key, keyCode, property, extent, direction) => {
      await evaluate(`(() => {
        document.querySelector('#ctrl-writing-mode button[data-value=${mode}]').click();
        ${viewer}.scrollTo({ left: 0, top: 0, behavior: 'instant' });
        ${viewer}.focus();
      })()`);
      const singleStep = await evaluate(`${viewer}.${extent} / 4`);
      const keyEvent = { key, code: key, windowsVirtualKeyCode: keyCode };
      await send('Input.dispatchKeyEvent', { ...keyEvent, type: 'keyDown' });
      try {
        await waitForReading(`${direction} * ${viewer}.${property} > ${singleStep * 1.5}`,
          `${mode}で長押ししても初回の移動を超えません`);
      } finally {
        await send('Input.dispatchKeyEvent', { ...keyEvent, type: 'keyUp' });
      }
      const stopped = await evaluate(`${viewer}.${property}`);
      await sleep(180);
      assert.equal(await evaluate(`${viewer}.${property}`), stopped, `${mode}でキーを離した後もスクロールしています`);
    };
    await verifyHeldScroll('horizontal', 'ArrowDown', 40, 'scrollTop', 'clientHeight', 1);
    await verifyHeldScroll('vertical', 'ArrowLeft', 37, 'scrollLeft', 'clientWidth', -1);
    record('ページ送り', '横書き・縦書きの長押しで進み、キーを離すと停止');

    await evaluate(`(() => {
      document.querySelector('#ctrl-writing-mode button[data-value=horizontal]').click();
      ${readingTarget}.scrollIntoView({ block: 'center' });
    })()`);
    const wordPoint = await evaluate(`(() => {
      const range = document.createRange();
      const text = ${readingTarget}.firstChild;
      range.setStart(text, 1);
      range.setEnd(text, 5);
      const rect = range.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...wordPoint });
    assert.equal(await evaluate(`getComputedStyle(${readingTarget}).cursor`), 'text');
    const selectionScrollTop = await evaluate(`${viewer}.scrollTop`);
    for (const clickCount of [1, 2]) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount, ...wordPoint });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount, ...wordPoint });
    }
    await sleep(300);
    assert.equal(await evaluate('window.getSelection().toString().trim()'), 'Hitohira');
    assert.equal(await evaluate(`${viewer}.scrollTop`), selectionScrollTop);
    const paddingPoint = await evaluate(`(() => {
      const rect = document.getElementById('novel-content').getBoundingClientRect();
      return { x: rect.left + 8, y: ${wordPoint.y} };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...paddingPoint });
    assert.equal(await evaluate('getComputedStyle(document.getElementById("novel-content")).cursor'), 'default');
    record('ページ送り', '実ブラウザーの単語選択を維持し、文字と余白のカーソルを切り替える');

    const changedRanges = {
      'font-size': 20, 'line-height': 2.5, 'letter-spacing': 0.05, 'content-width': 560,
      'content-padding': 24, 'ruby-scale': 0.65, 'panel-bg-alpha': 0.5, 'background-blur': 8
    };
    await evaluate(`(() => {
      for (const [key, value] of Object.entries(${JSON.stringify(changedRanges)})) {
        const control = document.getElementById('ctrl-' + key);
        control.value = value;
        control.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await waitForReading("getComputedStyle(document.getElementById('novel-content')).backgroundColor.endsWith(', 0.5)')",
      '本文パネルの不透明度が変更されません');
    const changedTypography = await typography();
    assert.deepEqual(changedTypography.settings, changedRanges);
    assert.deepEqual([
      changedTypography.fontSize, changedTypography.lineHeight, changedTypography.letterSpacing,
      changedTypography.widthMatches, changedTypography.width, changedTypography.padding,
      changedTypography.rubyScale, changedTypography.blur
    ], ['20px', '50px', '1px', true, '560px', '24px', 0.65, 'blur(8px)']);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#novel-content rt')).fontSize"), '13px');
    await evaluate('document.getElementById("btn-reset-all").click()');
    await waitForReading("document.getElementById('btn-reset-all').disabled && getComputedStyle(document.getElementById('novel-content')).backgroundColor === 'rgba(255, 255, 255, 0.75)' && getComputedStyle(document.getElementById('progress-indicator')).opacity === '0'",
      '初期化で既定の本文パネル色と不透明度に戻りません');
    assert.deepEqual(await typography(), defaultTypography);
    record('設定', '文字組みと本文パネルの変更が描画に反映され、初期化で復元');

    await dropFile(textFixture);
    await waitForReading('!!document.getElementById("btn-download-text")', '書き出し失敗の検証用本文を取り込めません');
    const failureDownloads = path.join(profile, 'failed-export-downloads');
    fs.mkdirSync(failureDownloads);
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: failureDownloads });
    await evaluate(`(() => {
      const create = URL.createObjectURL;
      const log = console.error;
      const errors = [];
      window.exportFailureProbe = {
        errors,
        restore() { URL.createObjectURL = create; console.error = log; }
      };
      URL.createObjectURL = () => { throw new Error('export-test-detail'); };
      console.error = (message, error) => {
        errors.push([message, error?.message]);
        log.call(console, message, error);
      };
    })()`);
    try {
      for (const [button, label] of [
        ['btn-export-html', 'HTMLのエクスポート'],
        ['btn-download-text', 'テキストのダウンロード']
      ]) {
        await evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
        await waitForReading(`!document.getElementById('error-notice').hidden &&
          document.getElementById('error-notice-message').textContent.startsWith(${JSON.stringify(label)})`,
          `${label}の失敗が表示されません`);
        const message = await evaluate('document.getElementById("error-notice-message").textContent');
        assert.match(message, /操作をやり直してください/);
        assert.ok(!message.includes('export-test-detail'));
      }
      assert.deepEqual(await evaluate('window.exportFailureProbe.errors'), [
        ['HTMLのエクスポートに失敗しました:', 'export-test-detail'],
        ['テキストのダウンロードに失敗しました:', 'export-test-detail']
      ]);
      await sleep(1000);
      assert.equal(await evaluate('document.getElementById("error-notice").hidden'), false, '通知が早く閉じました');
      await waitForReading('document.getElementById("error-notice").hidden', '通知が自動で閉じません');
      assert.deepEqual(fs.readdirSync(failureDownloads), [], '失敗時に不完全なファイルが生成されました');
      record('エクスポート', '失敗を通知して自動閉鎖し、例外の詳細をログに残す');
    } finally {
      await evaluate('window.exportFailureProbe.restore(); delete window.exportFailureProbe');
      await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
    }

    if (testPolicies) {
    const viewerHtml = fs.readFileSync(path.join(root, 'hitohira.html'));
      const audioFixture = fs.readFileSync(path.join(root, 'white-noise-rain-loop.wav'));
      policyServer = createServer((request, response) => {
        if (request.url === '/audio.wav') {
          response.setHeader('Content-Type', 'audio/wav');
          response.end(audioFixture);
          return;
        }
        const isVideo = request.url === '/restricted-video';
        if (request.url === '/restricted' || isVideo) {
          response.setHeader('Permissions-Policy', 'autoplay=(), screen-wake-lock=()');
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(isVideo ? exportedVideoHtml : viewerHtml);
      });
      await new Promise((resolve, reject) => {
        policyServer.once('error', reject);
        policyServer.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${policyServer.address().port}`;
      const waitFor = async (expression, message) => {
        for (let i = 0; i < 50; i++) {
          if (await evaluate(expression)) return;
          await sleep(100);
        }
        assert.fail(message);
      };
      await send('Page.navigate', { url: origin + '/restricted' });
      await waitFor('location.pathname === "/restricted" && !!document.getElementById("ctrl-wake-lock") && document.readyState === "complete"', '制約検証ページを読み込めません');
      assert.equal(await evaluate('document.featurePolicy.allowsFeature("screen-wake-lock")'), false);
      assert.equal(await evaluate('document.featurePolicy.allowsFeature("autoplay")'), false);
      const audioOutcome = await evaluate(`(async () => {
        const audio = new Audio('/audio.wav');
        try { await audio.play(); return 'playing'; }
        catch (error) { return error.name; }
        finally { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      })()`);
      assert.equal(audioOutcome, 'NotAllowedError', '利用者操作のない音声の自動再生が拒否されません');
      record('ブラウザーポリシー', 'ポリシー制約下で利用者操作のない音声の自動再生を拒否');
      await evaluate('document.getElementById("ctrl-wake-lock").click()');
      await waitFor('document.getElementById("wake-lock-status").textContent === "（取得失敗）"', 'ポリシーによるWake Lock取得失敗が表示されません');
      record('ブラウザーポリシー', 'Permissions-PolicyでWake Lockを拒否');

      await send('Page.navigate', { url: origin + '/storage' });
      await waitFor('location.pathname === "/storage" && !!document.getElementById("file-input") && document.readyState === "complete"', '容量検証ページを読み込めません');
      const importText = (name, length) => evaluate(`(() => {
        const bytes = new Uint8Array(${length});
        bytes.fill(65);
        for (let i = 79; i < bytes.length; i += 80) bytes[i] = 10;
        const data = new DataTransfer();
        data.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'text/plain' }));
        const input = document.getElementById('file-input');
        input.files = data.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      // Set the quota before the first write so IndexedDB caches the test limit.
      const quotaSize = 256 * 1024;
      await send('Storage.overrideQuotaForOrigin', { origin, quotaSize });
      try {
        const { quota } = await send('Storage.getUsageAndQuota', { origin });
        assert.equal(quota, quotaSize, 'IndexedDBのオリジン容量を設定できません');
        await importText('既存本文.txt', 8);
        await waitFor('document.title === "既存本文"', '容量上限内の本文を保存できません');
        await importText('容量超過.txt', 2 * quotaSize);
        await waitFor('!document.getElementById("error-notice").hidden || document.title === "容量超過"', '容量超過の入力が完了しません');
        assert.equal(await evaluate('document.title'), '既存本文', '制限中に本文が置き換わりました');
        assert.match(await evaluate('document.getElementById("error-notice-message").textContent'), /容量超過\.txt.*保存領域が不足/);
        assert.equal(await evaluate('document.getElementById("novel-content").textContent.trim()'), 'AAAAAAAA');
      } finally {
        await send('Storage.overrideQuotaForOrigin', { origin });
      }
      await importText('容量解除後.txt', 12);
      await waitFor('document.title === "容量解除後"', '容量上限の解除後に本文を保存できません');
      record('ブラウザーポリシー', 'IndexedDB容量超過時に既存本文を保持し、制限解除後に保存');

      const measurementPath = path.join(profile, 'export-measurements');
      fs.mkdirSync(measurementPath);
      const measureExport = async (name, size, importFile, ready) => {
        const destination = path.join(measurementPath, name);
        fs.mkdirSync(destination);
        await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: destination });
        const before = await send('Storage.getUsageAndQuota', { origin });
        const importStarted = performance.now();
        await importFile();
        await waitFor(ready, `${name}を取り込めません`);
        const importMs = Math.round(performance.now() - importStarted);
        const after = await send('Storage.getUsageAndQuota', { origin });
        const exportStarted = performance.now();
        await evaluate('document.getElementById("btn-export-html").click()');
        let output;
        for (let i = 0; i < 250; i++) {
          output = fs.readdirSync(destination).find(file => file.endsWith('.html'));
          if (output) break;
          await sleep(20);
        }
        assert.ok(output, `${name}のHTMLを書き出せません`);
        const exportMs = Math.round(performance.now() - exportStarted);
        const outputPath = path.join(destination, output);
        const outputHtml = fs.readFileSync(outputPath, 'utf8');
        const payload = outputHtml.match(/<script[^>]+id="viewer-download-data"[^>]*>([\s\S]*?)<\/script>/);
        assert.ok(payload, `${name}の書き出しに内蔵データがありません`);
        const { textBase64, mediaDataUrl } = JSON.parse(payload[1]);
        const embedded = name.startsWith('measure-text-') ? textBase64 : mediaDataUrl.split(',')[1];
        assert.equal(Buffer.from(embedded, 'base64').length, size, `${name}の書き出しで元ファイルサイズが変わりました`);
        const outputBytes = Buffer.byteLength(outputHtml, 'utf8');
        console.log(`  保存・書き出し計測 ${name}: input=${size} B, usageDelta=${after.usage - before.usage} B, import=${importMs} ms, export=${exportMs} ms, html=${outputBytes} B`);
      };
      const measurementQuota = 8 * 1024 * 1024;
      await send('Storage.overrideQuotaForOrigin', { origin, quotaSize: measurementQuota });
      try {
        assert.equal((await send('Storage.getUsageAndQuota', { origin })).quota, measurementQuota);
        for (const size of [32 * 1024, 512 * 1024]) {
          const stem = `measure-text-${size}`;
          await measureExport(stem, size, () => importText(stem + '.txt', size),
            `document.title === ${JSON.stringify(stem)}`);
        }
        const importMedia = async file => {
          const tree = await send('DOM.getDocument');
          const input = await send('DOM.querySelector', { nodeId: tree.root.nodeId, selector: '#file-input' });
          await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
        };
        for (const [name, file, ready] of [
          ['image', path.join(root, 'Anima_00036_.png'), '!!document.getElementById("btn-download-image") && !document.getElementById("ctrl-auto-sync").disabled'],
          ['video', path.join(root, 'tests', 'fixtures_background.webm'), '!!document.getElementById("btn-download-video") && !document.getElementById("background-video").paused']
        ]) {
          await measureExport(name, fs.statSync(file).size, () => importMedia(file), ready);
        }
        record('ブラウザーポリシー', '本文・画像・動画の保存とHTML書き出しの所要時間を計測');
      } finally {
        await send('Storage.overrideQuotaForOrigin', { origin });
        await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
      }

      if (exportedVideoHtml) {
        await send('Page.navigate', { url: origin + '/restricted-video' });
        await waitFor('location.pathname === "/restricted-video" && document.body?.classList.contains("video-bg")', '自動再生制約下で背景動画を復元できません');
        assert.equal(await evaluate('document.featurePolicy.allowsFeature("autoplay")'), false);
        await waitFor('document.getElementById("background-video").readyState >= 3', '自動再生制約下で動画をデコードできません');
        const playing = '!document.getElementById("background-video").paused';
        const rejected = '!document.getElementById("error-notice").hidden && document.getElementById("error-notice-message").textContent.includes("自動再生を拒否")';
        await waitFor(`${playing} || (${rejected})`, 'ミュート動画の再生結果を確認できません');
        const outcome = await evaluate(playing) ? '再生' : 'NotAllowedError';
        console.log(`  自動再生ポリシー適用時のミュート動画: ${outcome}`);
        record('ブラウザーポリシー', 'Permissions-Policy適用時のミュート動画の再生可否を観測');
      }
    }

    assert.ok(exportedVideoHtml, '独立起動を検証するエクスポートHTMLがありません');
    const standaloneProfile = path.join(profile, 'standalone-profile');
    const standalonePath = path.join(profile, 'standalone-viewer.html');
    const standaloneUrl = pathToFileURL(standalonePath).href;
    fs.mkdirSync(standaloneProfile);
    fs.writeFileSync(standalonePath, exportedVideoHtml, 'utf8');
    await closeBrowser(send);
    send = await connect(standaloneProfile, standaloneUrl);
    await waitForReading(`location.href === ${JSON.stringify(standaloneUrl)} &&
      !!document.getElementById('btn-download-text') && !!document.getElementById('btn-download-video') &&
      document.getElementById('background-video')?.paused === false`,
      '新規プロファイルで本文と背景動画を復元できません');
    assert.equal(await evaluate('document.getElementById("novel-content").textContent.trim()'), 'ブラウザー操作テスト本文');
    assert.deepEqual(await exportRows(), [textRow, videoRow]);
    const standaloneDownloads = path.join(profile, 'standalone-downloads');
    fs.mkdirSync(standaloneDownloads);
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: standaloneDownloads });
    for (const [type, source] of [['text', textFixture], ['video', path.join(root, 'tests', 'fixtures_background.webm')]]) {
      const bytes = fs.readFileSync(source);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const downloaded = path.join(standaloneDownloads, hash + path.extname(source));
      await evaluate(`document.getElementById('btn-download-${type}').click()`);
      for (let i = 0; i < 50 && !fs.existsSync(downloaded); i++) await sleep(100);
      assert.ok(fs.existsSync(downloaded), `${type}の元ファイルを個別エクスポートできません`);
      assert.ok(fs.readFileSync(downloaded).equals(bytes), `${type}の個別エクスポートが元ファイルと一致しません`);
    }
    await evaluate('document.getElementById("btn-download-video-delete").click()');
    assert.deepEqual(await exportRows(), [textRow]);
    await evaluate('document.getElementById("btn-download-text-delete").click()');
    assert.deepEqual(await exportRows(), []);
    assert.equal(await evaluate('document.getElementById("btn-export-html").disabled'), false);
    record('エクスポート', '元ブラウザーを終了し、新規プロファイルでHTML単体の起動と元ファイルの一致を確認');

    let total = 0;
    for (const [category, cases] of categories) {
      console.log(`[----------] ${category}`);
      for (const name of cases) {
        total++;
        console.log(formatCaseLine('run', 'ブラウザー操作', `${category}.${name}`));
        console.log(formatCaseLine('ok', 'ブラウザー操作', `${category}.${name}`));
      }
    }
    console.log(`[==========] ${total} tests ran.`);
    console.log(`[  PASSED  ] ${total} tests.`);
  } finally {
    await activeCleanup();
    activeCleanup = null;
  }
}

let browserAttempt = 0;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    Promise.resolve(activeCleanup?.())
      .finally(() => process.exit(130));
  });
}
async function runBrowserTest() {
  try { return await main(); }
  catch (error) {
    if (/CDPターゲットを取得できません/.test(error.message) && browserAttempt < 1) {
      browserAttempt++;
      childError = '';
      childExit = null;
      await sleep(300);
      return runBrowserTest();
    }
    throw error;
  }
}

runBrowserTest().catch(error => {
  console.error(`[  FAILED  ] ブラウザー操作.実行 (終了コード: 1)\n  ${error.stack || error.message}`);
  if (childExit) console.error(`  Browser exit: code=${childExit.code}, signal=${childExit.signal || 'none'}`);
  if (childError.trim()) console.error(`  Browser stderr: ${childError.trim()}`);
  process.exitCode = 1;
});
