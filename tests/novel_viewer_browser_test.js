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
const { dispatchKey, formatCaseLine, terminateBrowserTree, waitForCondition, createCdpClient, classifyBrowserFailure } = require('./test_utils');

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
let lastBrowserAttempt = null;
let activeCleanup = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function removeTemporaryProfile(profile) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await sleep(100);
    }
  }
  throw lastError;
}
async function waitForDevToolsPort(profile, child, timeoutMs = 8000) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    let timeout;
    const onStderr = chunk => {
      const match = String(chunk).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, Number(match[1]));
    };
    const finish = (error, portNumber) => {
      if (settled) return;
      settled = true;
      if (watcher) watcher.close();
      clearTimeout(timeout);
      child.stderr?.off('data', onStderr);
      error ? reject(error) : resolve(portNumber);
    };
    const readPort = () => {
      try {
        const value = Number(fs.readFileSync(portFile, 'utf8').split(/\s+/)[0]);
        if (value > 0) finish(null, value);
      } catch (_) {}
    };
    child.stderr?.on('data', onStderr);
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
  try {
    return await waitForCondition(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(400) });
        const targets = await response.json();
        const page = targets.find(target => target.type === 'page' && target.url === expectedUrl);
        if (page) return page;
      } catch (error) { lastError = `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`; }
      return false;
    }, { timeoutMs: 8000, intervalMs: 50, message: 'CDPターゲット取得がタイムアウトしました' });
  } catch (_) {
    throw new Error(`CDPターゲットを取得できません (port=${port}, url=${expectedUrl}, lastError=${lastError || '対象ページなし'})`);
  }
}

async function waitForSocketOpen(socket) {
  await waitForCondition(() => {
    if (socket.readyState === 1) return true;
    if (socket.readyState === 3) throw new Error('CDP WebSocketが接続前に閉じました');
    return false;
  }, { timeoutMs: 5000, intervalMs: 25, message: 'CDP WebSocket接続がタイムアウトしました' });
}

function cdpPipe(input, output, onEvent = () => {}) {
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
        if (Number.isInteger(response.id)) pending.get(response.id)?.(null, response);
        else onEvent(response);
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
    const timeout = setTimeout(() => finish(new Error(`CDPパイプが応答しません (${method}, 8000ms)`)), 8000);
    pending.set(requestId, finish);
    input.write(JSON.stringify({ id: requestId, method, params, sessionId }) + '\0');
  });
}

async function main() {
  const testStartedAt = performance.now();
  let lastTimingCheckpoint = testStartedAt;
  const timingCheckpoints = [];
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
      await Promise.race([childClosed, sleep(3000)]);
    }
    await removeTemporaryProfile(profile);
  };
  try {
    // Given: 対象HTMLが読み込まれた読書画面。When: 利用者の操作を送る。Then: 可視状態を確認する。
    const categories = new Map();
    let reportedCategory = '';
    const record = (category, name) => {
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category).push(name);
      if (process.env.NOVEL_VIEWER_TEST_TIMINGS === '1') {
        const now = performance.now();
        timingCheckpoints.push({ category, name, durationMs: Math.round(now - lastTimingCheckpoint) });
        lastTimingCheckpoint = now;
      }
      if (reportedCategory !== category) {
        reportedCategory = category;
        console.log(`[----------] ${category}`);
      }
      console.log(formatCaseLine('ok', 'ブラウザー操作', `${category}.${name}`));
    };
    const connect = async (browserProfile = profile, startUrl = fileUrl) => {
      const args = [...browserArgs, `--user-data-dir=${browserProfile}`, usePipe ? 'about:blank' : startUrl];
      child = spawn(browser.path, args, { stdio });
      const attempt = lastBrowserAttempt = {
        browser: `${browser.name} (${browser.path})`, transport: usePipe ? 'pipe' : 'TCP', stage: 'browser startup',
        args, url: startUrl, exit: null, stderr: ''
      };
      childClosed = new Promise(resolve => child.once('close', resolve));
      child.on('error', error => { childError += `spawn error: ${error.message}\n`; });
      child.on('exit', (code, signal) => { childExit = attempt.exit = { code, signal }; });
      child.stderr.on('data', chunk => { const output = chunk.toString(); childError += output; attempt.stderr += output; });
      let send;
      try {
        if (usePipe) {
          attempt.stage = 'CDP pipe handshake';
          const sendBrowser = cdpPipe(child.stdio[3], child.stdio[4]);
          const { targetInfos } = await sendBrowser('Target.getTargets');
          const target = targetInfos.find(info => info.type === 'page' && info.url === 'about:blank');
          assert.ok(target, 'CDPパイプで初期ページを取得できません');
          const { sessionId } = await sendBrowser('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          send = (method, params) => sendBrowser(method, params, method.startsWith('Browser.') ? undefined : sessionId);
          const navigation = await send('Page.navigate', { url: startUrl });
          assert.ok(!navigation.errorText, navigation.errorText);
        } else {
          attempt.stage = 'CDP port announcement';
          const port = requestedPort || await waitForDevToolsPort(browserProfile, child);
          attempt.stage = 'CDP target discovery';
          const target = await waitForTarget(port, startUrl);
          attempt.stage = 'CDP WebSocket connection';
          ws = new WebSocket(target.webSocketDebuggerUrl);
          await waitForSocketOpen(ws);
          send = createCdpClient(ws, { timeoutMs: 8000 });
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
    const connectIsolated = async (startUrl, browserProfile, options = {}) => {
      const initialUrl = options.offline || usePipe ? 'about:blank' : startUrl;
      const isolatedCdpArgs = usePipe ? ['--remote-debugging-pipe'] : ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'];
      const isolatedStdio = usePipe ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'];
      const isolatedArgs = [...headlessArgs, '--disable-gpu', ...sandboxArgs, '--no-first-run', ...edgeArgs,
        ...isolatedCdpArgs, `--user-data-dir=${browserProfile}`, initialUrl];
      const isolatedChild = spawn(browser.path, isolatedArgs, { stdio: isolatedStdio });
      const attempt = lastBrowserAttempt = {
        browser: `${browser.name} (${browser.path})`, transport: usePipe ? 'pipe' : 'TCP', stage: 'isolated browser startup',
        args: isolatedArgs, url: initialUrl, exit: null, stderr: ''
      };
      const isolatedClosed = new Promise(resolve => isolatedChild.once('close', resolve));
      isolatedChild.on('exit', (code, signal) => { attempt.exit = { code, signal }; });
      isolatedChild.stderr.on('data', chunk => { const output = chunk.toString(); childError += output; attempt.stderr += output; });
      let isolatedSocket;
      let isolatedSend;
      const networkRequests = [];
      try {
        const standaloneHtml = fs.readFileSync(new URL(startUrl), 'utf8');
        assert.doesNotMatch(standaloneHtml, /<script\b[^>]*\bsrc\s*=/i, '単体HTMLが外部スクリプトを参照しています');
        assert.doesNotMatch(standaloneHtml, /<link\b[^>]*\brel\s*=\s*["']?stylesheet[^>]*\bhref\s*=/i, '単体HTMLが外部スタイルシートを参照しています');
        if (usePipe) {
          attempt.stage = 'isolated CDP pipe handshake';
          const sendBrowser = cdpPipe(isolatedChild.stdio[3], isolatedChild.stdio[4], message => {
            if (message.method === 'Network.requestWillBeSent') networkRequests.push(message.params.request.url);
          });
          const { targetInfos } = await sendBrowser('Target.getTargets');
          const target = targetInfos.find(info => info.type === 'page' && info.url === 'about:blank');
          assert.ok(target, '隔離プロファイルのCDPパイプから初期ページを取得できません');
          const { sessionId } = await sendBrowser('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          isolatedSend = (method, params = {}) => sendBrowser(method, params, method.startsWith('Browser.') ? undefined : sessionId);
        } else {
          attempt.stage = 'isolated CDP port announcement';
          const port = Number(requestedPort) || await waitForDevToolsPort(browserProfile, isolatedChild);
          attempt.stage = 'isolated CDP target discovery';
          const target = await waitForTarget(port, initialUrl);
          attempt.stage = 'isolated CDP WebSocket connection';
          isolatedSocket = new WebSocket(target.webSocketDebuggerUrl);
          await waitForSocketOpen(isolatedSocket);
          isolatedSend = createCdpClient(isolatedSocket, { timeoutMs: 8000 });
          isolatedSocket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.method === 'Network.requestWillBeSent') networkRequests.push(message.params.request.url);
          });
        }
        await isolatedSend('Runtime.enable');
        await isolatedSend('Page.enable');
        if (usePipe && !options.offline) {
          const navigation = await isolatedSend('Page.navigate', { url: startUrl });
          assert.ok(!navigation.errorText, navigation.errorText);
        }
        if (options.offline) {
          await isolatedSend('Network.enable');
          await isolatedSend('Network.emulateNetworkConditions', {
            offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none'
          });
          const navigation = await isolatedSend('Page.navigate', { url: startUrl });
          assert.equal(navigation.errorText, undefined, navigation.errorText);
        }
        await isolatedSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: options.downloadPath || downloadPath });
        const evaluateIsolated = async expression => {
          const result = await isolatedSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          return result.result.value;
        };
        if (options.exercise) await options.exercise({
          send: isolatedSend, evaluate: evaluateIsolated, networkRequests, socket: isolatedSocket
        });
        const value = await isolatedSend('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        assert.equal(value.result.value, 'complete');
        const documentState = await isolatedSend('Runtime.evaluate', {
          expression: `({ title: document.title, inlineApplicationScript: [...document.scripts].some(script => script.type !== 'application/json' && script.textContent.trim().length > 1000), text: document.getElementById('novel-content')?.textContent.trim() })`,
          returnByValue: true
        });
        assert.equal(documentState.result.value.title.length > 0, true);
        assert.ok(documentState.result.value.inlineApplicationScript);
        if (!options.exercise) assert.ok(documentState.result.value.text.includes('Hitohira'));
        await isolatedSend('Browser.close').catch(() => {});
        isolatedSocket?.close();
        isolatedSocket = null;
        terminateBrowserTree(isolatedChild);
        if (usePipe) {
          isolatedChild.stdio[3]?.destroy();
          isolatedChild.stdio[4]?.destroy();
        }
        await Promise.race([isolatedClosed, sleep(2000)]);
      } finally {
        isolatedSocket?.close();
        terminateBrowserTree(isolatedChild);
        if (usePipe) {
          isolatedChild.stdio[3]?.destroy();
          isolatedChild.stdio[4]?.destroy();
        }
        await Promise.race([isolatedClosed, sleep(2000)]);
        await removeTemporaryProfile(browserProfile);
      }
    };
    const closeBrowser = async command => {
      const closingChild = child;
      await command('Browser.close').catch(() => {});
      terminateBrowserTree(closingChild);
      const exited = await Promise.race([childClosed.then(() => true), sleep(2000).then(() => false)]);
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
    const formatFileSize = bytes => {
      if (bytes < 1000) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let size = bytes;
      let unit = -1;
      do { size /= 1000; unit++; } while (size >= 1000 && unit < units.length - 1);
      const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
      return `${Number(size.toFixed(digits))} ${units[unit]}`;
    };
    const exportRows = () => evaluate(`[...document.querySelectorAll('#loaded-file-downloads .file-action-group')]
      .filter(row => !row.querySelector('#btn-export-html'))
      .map(row => [...row.children].filter(element => !element.classList.contains('file-action-size')).map(element => element.id || element.textContent))`);
    const textRow = ['テキスト', 'btn-download-text-delete', 'btn-download-text'];
    const imageRow = ['画像', 'btn-download-image-delete', 'btn-download-image'];
    const videoRow = ['動画', 'btn-download-video-delete', 'btn-download-video'];
    await waitForCondition(() => evaluate('document.readyState === "complete" && !!document.getElementById("shortcut-modal")'), {
      timeoutMs: 5000, intervalMs: 50, message: '本文ビューアーの初期化が完了しません'
    });
    const initialExportSize = await waitForCondition(async () => {
      const value = await evaluate('document.getElementById("html-export-size").textContent');
      return value !== '計算中' ? value : false;
    }, { timeoutMs: 5000, intervalMs: 50, message: 'HTMLエクスポートサイズの計算が完了しません' });
    assert.match(initialExportSize, /^\d+(?:\.\d+)? (?:B|KB|MB|GB|TB)$/);
    record('起動・初期化', '対象HTMLの読み込みとDOM初期化');
    const browserLanguageCases = [
      { tag: 'en-US', lang: 'en', label: 'Open settings' },
      { tag: 'ja-JP', lang: 'ja', label: '設定を開く' },
      { tag: 'zh-CN', lang: 'zh-Hans', label: '打开设置' },
      { tag: 'zh-TW', lang: 'zh-Hant', label: '開啟設定' },
      { tag: 'es-MX', lang: 'es', label: 'Abrir configuración' },
      { tag: 'fr-FR', lang: 'fr', label: 'Ouvrir les paramètres' },
      { tag: 'de-DE', lang: 'de', label: 'Einstellungen öffnen' },
      { tag: 'pt-BR', lang: 'pt', label: 'Abrir configurações' },
      { tag: 'ko-KR', lang: 'ko', label: '설정 열기' },
      { tag: 'ru-RU', lang: 'ru', label: 'Открыть настройки' },
      { tag: 'ar-SA', lang: 'ar', label: 'فتح الإعدادات', dir: 'rtl' },
      { tag: 'hi-IN', lang: 'hi', label: 'सेटिंग खोलें' }
    ];
    await evaluate(`localStorage.setItem('hitohira_settings', JSON.stringify({ language: 'ja' }))`);
    for (const { tag, lang, label, dir = 'ltr' } of browserLanguageCases) {
      const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(Object.getPrototypeOf(navigator), 'languages', { configurable: true, get: () => [${JSON.stringify(tag)}, 'en-US'] }); Object.defineProperty(Object.getPrototypeOf(navigator), 'language', { configurable: true, get: () => ${JSON.stringify(tag)} });` });
      await send('Page.reload', { ignoreCache: true });
      await waitForCondition(() => evaluate(`document.documentElement.lang === ${JSON.stringify(lang)}`), {
        timeoutMs: 5000, intervalMs: 50, message: `ブラウザー言語 ${tag} に対応する表示へ切り替わりません`
      });
      assert.equal(await evaluate('document.getElementById("btn-open-settings").getAttribute("aria-label")'), label, `${tag} の設定ボタン名が翻訳されません`);
      assert.equal(await evaluate('document.documentElement.dir'), dir, `${tag} の表示方向が正しくありません`);
      if (tag === 'en-US') {
        assert.equal(await evaluate('document.getElementById("ctrl-language")'), null, '手動の表示言語選択UIが残っています');
        assert.equal(await evaluate('localStorage.getItem("hitohira_settings")'), JSON.stringify({ language: 'ja' }), '旧言語設定が変更されました');
      }
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    }
    await evaluate('localStorage.removeItem("hitohira_settings")');
    await send('Page.reload', { ignoreCache: true });
    await waitForCondition(() => evaluate('document.documentElement.lang === "ja" && document.getElementById("error-notice").hidden'), {
      timeoutMs: 5000, intervalMs: 50, message: '言語テスト後に通常起動へ戻りません'
    });
    record('表示言語', '起動ごとにブラウザー優先言語へ追従し、保存済み言語設定を無視');
    const recoveryKey = 'hitohira_pending_saved_data_transaction';
    await evaluate(`localStorage.setItem('hitohira_content', '<p>RECOVERY_SENTINEL</p>'); localStorage.setItem(${JSON.stringify(recoveryKey)}, '{')`);
    await send('Page.reload', { ignoreCache: true });
    await waitForCondition(() => evaluate('document.readyState === "complete" && !document.getElementById("error-notice").hidden'), {
      timeoutMs: 5000, intervalMs: 50, message: '破損した復旧マーカーを起動時に通知しません'
    });
    assert.ok(await evaluate('!document.getElementById("novel-content").textContent.includes("RECOVERY_SENTINEL")'),
      '復旧失敗後に保存本文を読み込みました');
    assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(recoveryKey)})`), '{', '復旧マーカーを消去しました');
    record('保存・復旧', '破損した復旧マーカーで起動を止め、保存本文とマーカーを保持');
    const validMarker = JSON.stringify({ version: 1, hasIndexedDbOperations: true });
    await evaluate(`localStorage.setItem(${JSON.stringify(recoveryKey)}, ${JSON.stringify(validMarker)})`);
    await send('Page.reload', { ignoreCache: true });
    await waitForCondition(() => evaluate('document.readyState === "complete" && !document.getElementById("error-notice").hidden'), {
      timeoutMs: 5000, intervalMs: 50, message: 'IndexedDB記録欠落を起動時に通知しません'
    });
    assert.ok(await evaluate('!document.getElementById("novel-content").textContent.includes("RECOVERY_SENTINEL")'),
      'IndexedDB記録欠落後に保存本文を読み込みました');
    assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(recoveryKey)})`), validMarker, '対応するIndexedDB記録なしで復旧マーカーを消去しました');
    record('保存・復旧', '対応するIndexedDB記録の欠落で起動を止め、保存本文とマーカーを保持');
    await evaluate(`localStorage.removeItem(${JSON.stringify(recoveryKey)}); localStorage.removeItem('hitohira_content')`);
    await send('Page.reload', { ignoreCache: true });
    await waitForCondition(() => evaluate('document.readyState === "complete" && document.getElementById("error-notice").hidden'), {
      timeoutMs: 5000, intervalMs: 50, message: '復旧テスト後に通常起動へ戻りません'
    });
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
    const settingRanges = [
      ['font-size', 'fontSize', value => `${value}px`],
      ['line-height', 'lineHeight', value => Number(value).toFixed(1)],
      ['letter-spacing', 'letterSpacing', value => `${Number(value).toFixed(2)}em`],
      ['content-width', 'contentWidth', value => `${value}px`],
      ['content-padding', 'contentPadding', value => `${value}px`],
      ['background-blur', 'backgroundBlur', value => `${value}px`],
      ['ruby-scale', 'rubyScale', value => `${Math.round(value * 100)}%`],
      ['panel-bg-alpha', 'panelBgAlpha', value => `${Math.round(value * 100)}%`]
    ];
    const setAndReadRangeBoundary = async boundary => {
      await evaluate(`(() => {
      const ranges = ${JSON.stringify(settingRanges.map(([id, key]) => [id, key]))};
      for (const [id] of ranges) {
        const input = document.getElementById('ctrl-' + id);
        input.value = input[${JSON.stringify(boundary)}];
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      })()`);
      const expected = boundary === 'min' ? rangeMinimums : rangeMaximums;
      await waitForCondition(() => evaluate(`(() => {
        const ranges = ${JSON.stringify(settingRanges.map(([id, key]) => [id, key]))};
        const stored = JSON.parse(localStorage.getItem('hitohira_settings') || 'null');
        return document.getElementById('settings-save-status').dataset.state === 'saved' && !!stored &&
          ranges.every(([, key], index) => stored[key] === ${JSON.stringify(expected)}[index]);
      })()`), { timeoutMs: 3000, intervalMs: 25, message: `${boundary}設定が保存済み状態になりません` });
      return evaluate(`(() => {
      const ranges = ${JSON.stringify(settingRanges.map(([id, key]) => [id, key]))};
      const articleStyle = getComputedStyle(document.getElementById('novel-content'));
      const rootStyle = getComputedStyle(document.documentElement);
      const saved = JSON.parse(localStorage.getItem('hitohira_settings'));
      return {
        values: ranges.map(([id]) => document.getElementById('ctrl-' + id).valueAsNumber),
        labels: ranges.map(([id]) => document.getElementById('val-' + id).textContent),
        stored: ranges.map(([, key]) => saved[key]),
        saveState: document.getElementById('settings-save-status').dataset.state,
        css: ['font-size', 'line-height', 'letter-spacing', 'content-width', 'content-padding', 'background-blur', 'ruby-scale', 'panel-bg-alpha']
          .map(key => rootStyle.getPropertyValue('--' + key).trim())
      };
    })()`);
    };
    const rangeMinimums = [10, 1, 0, 480, 16, 0, 0.3, 0];
    const rangeMaximums = [22, 3, 0.08, 960, 80, 24, 0.7, 1];
    for (const [edge, expected] of [['min', rangeMinimums], ['max', rangeMaximums]]) {
      const actual = await setAndReadRangeBoundary(edge);
      assert.deepEqual(actual.values, expected, `${edge}imum設定値を選択できません`);
      assert.deepEqual(actual.stored, expected, `${edge}imum設定値が保存されません`);
      assert.equal(actual.saveState, 'saved', `${edge}imum設定の保存済み状態が表示されません`);
      assert.deepEqual(actual.labels, expected.map((value, index) => settingRanges[index][2](value)),
        `${edge}imum設定値と表示ラベルが一致しません`);
      assert.deepEqual(actual.css, [
        `${expected[0]}px`, String(expected[1]), `${expected[2]}em`, `${expected[3]}px`,
        `${expected[4]}px`, `${expected[5]}px`, String(expected[6]), String(expected[7])
      ]);
    }
    await evaluate('document.getElementById("btn-reset-all").click()');
    for (let i = 0; i < 40; i++) {
      if (await evaluate('document.getElementById("btn-reset-all").disabled')) break;
      await sleep(50);
    }
    const resetRanges = await evaluate(`(() => {
      const ranges = ${JSON.stringify(settingRanges.map(([id]) => id))};
      const style = getComputedStyle(document.documentElement);
      return {
        values: ranges.map(id => document.getElementById('ctrl-' + id).valueAsNumber),
        css: ['font-size', 'line-height', 'letter-spacing', 'content-width', 'content-padding', 'background-blur', 'ruby-scale', 'panel-bg-alpha']
          .map(key => style.getPropertyValue('--' + key).trim()),
        resetDisabled: document.getElementById('btn-reset-all').disabled,
        errorNotice: document.getElementById('error-notice').textContent.trim()
      };
    })()`);
    assert.deepEqual(resetRanges, {
      values: [16, 2, 0.04, 720, 48, 12, 0.5, 0.75],
      css: ['16px', '2', '0.04em', '720px', '48px', '12px', '0.5', '0.75'],
      resetDisabled: true,
      errorNotice: ''
    }, '境界値テスト後に設定・CSSを既定状態へ戻せません');
    record('設定', '文字組み8項目の最小・最大値をUI・保存値と照合');
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

    await evaluate('document.getElementById("ctrl-show-progress").click()');
    await send('Page.reload', { ignoreCache: true });
    await waitForCondition(() => evaluate('document.readyState === "complete" && !!document.getElementById("ctrl-show-progress") && document.getElementById("ctrl-show-progress").checked'), {
      timeoutMs: 4000, intervalMs: 50, message: '再読み込み後に表示設定が復元されません'
    });
    record('保存・復元', '再読み込み後に設定を復元');
    assert.equal(await evaluate('(async () => (await indexedDB.databases()).some(db => db.name === "hitohira_media_db"))()'), true, '媒体保存用IndexedDBが初期化されません');
    record('保存・復元', '媒体保存用IndexedDBを初期化');
    assert.equal(await evaluate('!!document.getElementById("btn-export-html")'), true, 'HTMLエクスポート操作がありません');
    assert.equal(await evaluate('document.getElementById("btn-export-html").disabled'), false, 'HTMLエクスポート操作が無効です');
    record('エクスポート', 'HTMLエクスポート操作を有効化');
    assert.equal(await evaluate('(() => { document.getElementById("btn-export-html").click(); return true; })()'), true, 'HTMLエクスポート操作を実行できません');
    await waitForCondition(() => fs.readdirSync(downloadPath).some(name => name.endsWith('.html')), {
      timeoutMs: 5000, intervalMs: 50, message: 'HTMLエクスポートファイルが生成されません'
    });
    const downloadedFiles = fs.readdirSync(downloadPath).filter(name => name.endsWith('.html'));
    assert.ok(downloadedFiles.length > 0, 'HTMLエクスポートファイルが生成されません');
    const downloadedHtmlBytes = fs.statSync(path.join(downloadPath, downloadedFiles[0])).size;
    await waitForCondition(() => evaluate('document.getElementById("html-export-size").textContent !== "計算中"'), {
      timeoutMs: 5000, intervalMs: 50, message: 'HTMLエクスポートサイズの表示が更新されません'
    });
    assert.equal(await evaluate('document.getElementById("html-export-size").textContent'), formatFileSize(downloadedHtmlBytes),
      'HTMLエクスポート欄のサイズが実際のダウンロードと一致しません');
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
      '</div>'
    ].join(''), 'HTML取り込み後の本文DOMがサニタイズ結果と一致しません');
    await waitForCondition(() => evaluate('document.getElementById("file-input").value === ""'), {
      timeoutMs: 4000, intervalMs: 50, message: 'HTML取り込みの後処理が完了しません'
    });
    record('インポート', 'HTML取り込み後の本文DOMをサニタイズ');
    const bodyFixture = path.join(profile, 'different-stem.html');
    fs.writeFileSync(bodyFixture, [
      '<title>表示題名</title>',
      '<!-- コメント --><h2 id="untrusted">章内リンク</h2>',
      '<a href="#chapter" target="_blank" rel="opener">章内</a>',
      '<a href="javascript:alert(1)">危険</a>',
      '<img src="data:image/png;base64,AA==" alt="表紙" onerror="">'
    ].join(''), 'utf8');
    const bodyDocument = await send('DOM.getDocument', { depth: -1 });
    const bodyInput = await send('DOM.querySelector', { nodeId: bodyDocument.root.nodeId, selector: '#file-input' });
    await send('DOM.setFileInputFiles', { nodeId: bodyInput.nodeId, files: [bodyFixture] });
    for (let i = 0; i < 30; i++) {
      if (await evaluate('document.title === "表示題名"')) break;
      await sleep(100);
    }
    assert.equal(await evaluate('document.querySelector("#novel-content").innerHTML.replace(/ id="heading-\\d+"/g, "")'),
      '<h2>章内リンク</h2><a href="#chapter">章内</a><a>危険</a><img src="data:image/png;base64,AA==" alt="表紙">',
      'bodyフォールバック、コメント、属性、URLの処理が不正です');
    record('インポート', 'bodyフォールバックとページ内・不正URLをDOMでサニタイズ');
    const stemExport = path.join(downloadPath, 'different-stem.html');
    await evaluate('document.getElementById("btn-export-html").click()');
    for (let i = 0; i < 50 && !fs.existsSync(stemExport); i++) await sleep(100);
    assert.ok(fs.existsSync(stemExport), 'エクスポートファイル名が読み込み元stemと一致しません');
    const stemExportHtml = fs.readFileSync(stemExport, 'utf8');
    assert.match(stemExportHtml, /<title>表示題名<\/title>/, 'HTML題名が読み込んだtitleと一致しません');
    assert.match(stemExportHtml, /<h2 id="heading-0">章内リンク<\/h2>/, 'サニタイズ済み本文がHTMLへ埋め込まれていません');
    assert.equal((stemExportHtml.match(/id="viewer-download-data"/g) || []).length, 1, 'エクスポート用データが重複しています');
    assert.equal((stemExportHtml.match(/id="viewer-reset-defaults"/g) || []).length, 1, '初期化データが重複しています');
    assert.doesNotMatch(stemExportHtml, /<(?:html|body|video)\b[^>]*\bblob:/i, 'エクスポートHTMLに実行元Blob URLが残っています');
    record('エクスポート', 'HTML題名・ファイルstem・本文・埋め込み一意性を照合');
    const dropFile = async file => {
      const drop = { x: 20, y: 20, data: { items: [], files: [file], dragOperationsMask: 1 } };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { ...drop, type });
    };
    await dropFile(textFixture);
    await waitForCondition(() => evaluate('document.title === ".tmp-browser-text" && document.getElementById("novel-content").textContent.trim() === "ブラウザー操作テスト本文" && !!document.getElementById("btn-download-text")'), {
      timeoutMs: 5000, intervalMs: 50, message: 'テキストファイルをドロップして本文へ反映できません'
    });
    assert.equal(await evaluate('document.title'), '.tmp-browser-text', 'テキストファイルstemがタイトルへ反映されません');
    assert.equal(await evaluate('document.getElementById("novel-content").textContent.trim()'), 'ブラウザー操作テスト本文');
    assert.equal(await evaluate('document.querySelector("#btn-download-text").closest(".file-action-group").querySelector(".file-action-size").textContent'),
      formatFileSize(fs.statSync(textFixture).size), '個別元ファイルのサイズ表示が元データと一致しません');
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
      await waitForCondition(() => evaluate('document.body.classList.contains("has-bg") && !!document.getElementById("btn-download-image")'), {
        timeoutMs: 5000, intervalMs: 50, message: '画像が背景・保存データへ反映されません'
      });
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
      await waitForCondition(() => fs.readdirSync(downloadPath).some(name => name.endsWith('.html')), {
        timeoutMs: 5000, intervalMs: 50, message: '画像付きHTMLが生成されません'
      });
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
      await evaluate('document.querySelector("#btn-download-image-delete svg path").dispatchEvent(new MouseEvent("click", { bubbles: true }))');
      await waitForCondition(() => evaluate('!document.body.classList.contains("has-bg")'), {
        timeoutMs: 3000, intervalMs: 50, message: '画像削除が画面へ反映されません'
      });
      assert.deepEqual(await exportRows(), [textRow]);
      record('メディア・エクスポート', 'SVG子要素からの委譲クリックで画像を削除し、行を同期');

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
      await waitForCondition(() => evaluate('document.body.classList.contains("video-bg") && document.getElementById("background-video")?.readyState >= 3 && !document.getElementById("background-video").paused'), {
        timeoutMs: 5000, intervalMs: 50, message: '背景動画の読み込み・再生が完了しません'
      });
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
      const videoBeforeResize = await evaluate(`(() => {
        const video = document.getElementById('background-video');
        return { src: video.src, paused: video.paused, currentTime: video.currentTime, readyState: video.readyState };
      })()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 540, height: 960, deviceScaleFactor: 1, mobile: false });
      await sleep(150);
      const videoAfterResize = await evaluate(`(() => {
        const video = document.getElementById('background-video');
        const vw = innerWidth, vh = innerHeight;
        const scale = Math.max(vw / video.videoWidth, vh / video.videoHeight);
        const maxX = Math.max(0, (video.videoWidth * scale - vw) / 2);
        const maxY = Math.max(0, (video.videoHeight * scale - vh) / 2);
        const offset = name => Number((document.documentElement.style.getPropertyValue(name).match(/[+-]\\s*([\\d.]+)px/) || [0, 0])[1]) *
          (document.documentElement.style.getPropertyValue(name).includes('-') ? -1 : 1);
        return {
          src: video.src, paused: video.paused, currentTime: video.currentTime, readyState: video.readyState,
          offsetX: offset('--bg-pos-x'), offsetY: offset('--bg-pos-y'), maxX, maxY,
          left: video.style.left, top: video.style.top
        };
      })()`);
      assert.equal(videoAfterResize.src, videoBeforeResize.src);
      assert.equal(videoAfterResize.paused, videoBeforeResize.paused);
      assert.equal(videoAfterResize.readyState, videoBeforeResize.readyState);
      assert.ok(videoAfterResize.currentTime >= videoBeforeResize.currentTime);
      assert.ok(Math.abs(videoAfterResize.offsetX) <= videoAfterResize.maxX + 1);
      assert.ok(Math.abs(videoAfterResize.offsetY) <= videoAfterResize.maxY + 1);
      await evaluate('document.body.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))');
      const videoAfterReset = await evaluate(`(() => {
        const video = document.getElementById('background-video');
        return { src: video.src, paused: video.paused, currentTime: video.currentTime, readyState: video.readyState,
          position: ['--bg-pos-x', '--bg-pos-y'].map(name => document.documentElement.style.getPropertyValue(name)) };
      })()`);
      assert.deepEqual(videoAfterReset.position, ['calc(50% + 0px)', 'calc(50% + 0px)']);
      assert.equal(videoAfterReset.src, videoBeforeResize.src);
      assert.equal(videoAfterReset.paused, videoBeforeResize.paused);
      assert.equal(videoAfterReset.readyState, videoBeforeResize.readyState);
      assert.ok(videoAfterReset.currentTime >= videoBeforeResize.currentTime);
      await send('Emulation.clearDeviceMetricsOverride');
      record('背景操作', '動画の画面サイズ変更と位置リセット後も再生状態を維持');
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
    assert.equal(await evaluate('document.getElementById("btn-open-settings").getAttribute("aria-expanded")'), 'true');
    assert.equal(await evaluate('document.activeElement.id'), 'settings-drawer', '設定ドロワーを開いてパネルへフォーカスしません');
    assert.equal(await evaluate('document.getElementById("settings-drawer").getAttribute("aria-hidden")'), 'false');
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
    assert.equal(await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=vertical]").getAttribute("aria-pressed")'), 'true', '縦書きアイコンの選択状態が支援技術へ反映されません');
    record('設定', '書字方向切替');
    await evaluate('document.querySelector("#ctrl-font button[data-value=sans]").click()');
    assert.equal(await evaluate('document.querySelector("#ctrl-font button[data-value=sans]").classList.contains("is-active")'), true, 'フォント切替を操作できません');
    assert.equal(await evaluate('document.querySelector("#ctrl-font button[data-value=sans]").textContent.trim()'), 'ゴ', 'ゴシック体アイコンの表示が誤っています');
    assert.equal(await evaluate('document.querySelector("#ctrl-font button[data-value=sans]").getAttribute("aria-pressed")'), 'true', '書体アイコンの選択状態が支援技術へ反映されません');
    assert.deepEqual(await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('#ctrl-writing-mode button, #ctrl-font button')];
      const boxes = buttons.map(button => button.getBoundingClientRect());
      const divider = document.querySelector('.icon-control-divider').getBoundingClientRect();
      const row = document.querySelector('.icon-control-row').getBoundingClientRect();
      const writingGroup = document.querySelector('.icon-control-group:first-child').getBoundingClientRect();
      const fontGroup = document.querySelector('.icon-control-font-group').getBoundingClientRect();
      const writingLabel = document.querySelector('.icon-control-group:first-child .control-label').getBoundingClientRect();
      const fontLabel = document.querySelector('.icon-control-font-group .control-label').getBoundingClientRect();
      const writingButtons = [...document.querySelectorAll('#ctrl-writing-mode button')].map(button => button.getBoundingClientRect());
      const fontButtons = [...document.querySelectorAll('#ctrl-font button')].map(button => button.getBoundingClientRect());
      return {
        fixedHeight: boxes.every(box => Math.abs(box.height - 40) <= 1),
        stretchedWidth: boxes.every(box => box.width > box.height),
        equalWidths: [...writingButtons, ...fontButtons].every((box, index, all) => index % 2 === 0 || Math.abs(box.width - all[index - 1].width) <= 1),
        sameRow: Math.max(...boxes.map(box => box.top)) - Math.min(...boxes.map(box => box.top)) <= 1,
        dividerBetweenGroups: divider.left > boxes[1].right && divider.right < boxes[2].left,
        dividerCentered: Math.abs((divider.left + divider.right) / 2 - (row.left + row.right) / 2) <= 1,
        dividerAlignedWithButtons: Math.abs(divider.top - boxes[0].top) <= 1 && Math.abs(divider.bottom - boxes[0].bottom) <= 1,
        fontLabelNextToDivider: Math.abs(fontLabel.left - (divider.right + 10)) <= 1,
        labelsAboveButtons: writingLabel.bottom <= writingButtons[0].top && fontLabel.bottom <= fontButtons[0].top,
        writingGroupStartsAtRow: Math.abs(writingGroup.left - row.left) <= 1,
        fontGroupEndsAtRow: Math.abs(fontGroup.right - row.right) <= 1
      };
    })()`), { fixedHeight: true, stretchedWidth: true, equalWidths: true, sameRow: true, dividerBetweenGroups: true, dividerCentered: true, dividerAlignedWithButtons: true, fontLabelNextToDivider: true, labelsAboveButtons: true, writingGroupStartsAtRow: true, fontGroupEndsAtRow: true }, '書字方向・書体の高さ・伸長幅・同一行配置・縦棒・ラベル配置が仕様と一致しません');
    record('設定', 'フォント切替');
    assert.equal(await evaluate('document.getElementById("ctrl-show-progress").checked'), true, '進捗表示切替を操作できません');
    record('設定', '進捗表示切替');
    await evaluate('document.getElementById("btn-reset-all").click()');
    await waitForCondition(() => evaluate('document.getElementById("btn-reset-all").disabled'), {
      timeoutMs: 3000, intervalMs: 50, message: '設定初期化後にボタンが無効化されません'
    });
    record('設定', '設定初期化');

    await evaluate('document.getElementById("viewer-container").focus()');
    await dispatchKey(send, 'f', 'KeyF', { text: 'f', modifiers: 2, windowsVirtualKeyCode: 70 });
    assert.equal(await evaluate('document.getElementById("search-drawer").classList.contains("is-open")'), true, 'Ctrl+Fで検索ドロワーが開きません');
    assert.equal(await evaluate('document.getElementById("settings-drawer").classList.contains("is-open")'), false, '検索を開いたとき設定ドロワーが閉じません');
    assert.equal(await evaluate('document.getElementById("btn-open-search").getAttribute("aria-expanded")'), 'true');
    assert.equal(await evaluate('document.activeElement.id'), 'search-query', `検索ドロワーを開いて検索欄へフォーカスしません: ${JSON.stringify(await evaluate(`(() => { const drawer = document.getElementById('search-drawer'); return { inert: drawer.inert, ariaHidden: drawer.getAttribute('aria-hidden'), visibility: getComputedStyle(drawer).visibility, focusable: document.getElementById('search-query').tabIndex }; })()`))}`);
    await evaluate(`(() => {
      const article = document.getElementById('novel-content');
      window.__searchTestOriginalContent = article.innerHTML;
      article.innerHTML = '<h1>第一章</h1><p>章をまたぐ共通語です。</p><h1>第二章</h1><p>こちらにも共通語があります。</p>';
      const input = document.getElementById('search-query');
      input.value = '共通語';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.equal(await evaluate('document.querySelectorAll("#search-results .search-result-button").length'), 2, '結合本文の複数章にある一致箇所を検索できません');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#search-results .search-result-heading")].map(element => element.textContent)'), ['第一章', '第二章']);
    await evaluate('document.querySelectorAll("#search-results .search-result-button")[1].click()');
    assert.equal(await evaluate('document.querySelector("#novel-content .search-current-block").textContent'), 'こちらにも共通語があります。');
    await evaluate(`(() => {
      document.getElementById('novel-content').innerHTML = window.__searchTestOriginalContent;
      delete window.__searchTestOriginalContent;
      const input = document.getElementById('search-query');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluate(`(() => {
      const input = document.getElementById('search-query');
      input.value = '本文';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const searchResultCount = await evaluate('document.querySelectorAll("#search-results .search-result-button").length');
    assert.ok(searchResultCount > 1, '複数の本文一致箇所が一覧されません');
    assert.ok(await evaluate('!!document.querySelector("#search-results mark")'), '検索結果の一致語句が文脈内で強調されません');
    const firstSearchResult = await evaluate('document.querySelector("#search-results .search-result-button").getAttribute("aria-label")');
    assert.match(firstSearchResult, /本文/);
    await evaluate('document.querySelector("#search-results .search-result-button").click()');
    assert.equal(await evaluate('document.getElementById("search-drawer").classList.contains("is-open")'), true, '結果選択後に検索一覧が閉じています');
    assert.equal(await evaluate('!!document.querySelector("#novel-content .search-current-block")'), true, '選択した一致箇所が本文上で強調されません');
    assert.equal(await evaluate('document.querySelector("#search-results .search-result-button").getAttribute("aria-current")'), 'location');
    await evaluate('document.getElementById("btn-search-next").click()');
    assert.match(await evaluate('document.getElementById("search-result-status").textContent'), /^2 \/ /, '次の検索結果へ移動しません');
    await evaluate(`(() => {
      document.getElementById('search-include-body').checked = false;
      document.getElementById('search-include-body').dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    assert.ok(await evaluate('document.querySelectorAll("#search-results [data-search-kind=heading]").length > 0'), '見出しのみの検索に一致箇所がありません');
    assert.equal(await evaluate('document.querySelectorAll("#search-results [data-search-kind=body]").length'), 0, '見出しのみの検索へ本文の結果が混入しています');
    await evaluate(`(() => {
      document.getElementById('search-include-headings').checked = true;
      document.getElementById('search-include-body').checked = true;
      const input = document.getElementById('search-query');
      input.value = 'ｈｉｔｏｈｉｒａ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.ok(await evaluate('document.querySelectorAll("#search-results .search-result-button").length > 0'), '全半角・英字大小を無視した検索が一致しません');
    await evaluate(`(() => {
      const exact = document.getElementById('search-distinguish-variants');
      exact.checked = true;
      exact.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    assert.equal(await evaluate('document.querySelectorAll("#search-results .search-result-button").length'), 0, '全半角・英字大小の区別が検索へ反映されません');
    await evaluate(`(() => {
      const article = document.getElementById('novel-content');
      window.__searchStressOriginalContent = article.innerHTML;
      article.innerHTML = Array.from({ length: 620 }, (_, index) => '<p>stressneedle ' + index + '</p>').join('');
      const input = document.getElementById('search-query');
      input.value = 'stressneedle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitForCondition(() => evaluate('document.querySelectorAll("#search-results .search-result-button").length === 500'), {
      timeoutMs: 5000, intervalMs: 20, message: '大量本文の分割検索が500件の上限まで完了しません'
    });
    assert.match(await evaluate('document.getElementById("search-result-status").textContent'), /500/);
    await evaluate(`(() => {
      document.getElementById('novel-content').innerHTML = window.__searchStressOriginalContent;
      delete window.__searchStressOriginalContent;
      const input = document.getElementById('search-query');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluate('document.getElementById("btn-close-search").click()');
    assert.equal(await evaluate('document.getElementById("search-drawer").classList.contains("is-open")'), false, '検索ドロワーを閉じられません');
    assert.equal(await evaluate('document.getElementById("btn-open-search").getAttribute("aria-expanded")'), 'false');
    assert.equal(await evaluate('document.activeElement.id'), 'btn-open-settings', '閉鎖後に可視の開閉ボタンへフォーカスが戻りません');
    record('検索', '複数結果、見出しフィルター、表記正規化、選択位置、一覧維持を確認');

    await evaluate('document.getElementById("viewer-container").focus()');
    await dispatchKey(send, 'o', 'KeyO', { text: 'o' });
    assert.equal(await evaluate('document.getElementById("toc-drawer").classList.contains("is-open")'), true, 'Oで目次が開きません');
    assert.equal(await evaluate('document.getElementById("btn-open-toc").getAttribute("aria-expanded")'), 'true');
    assert.equal(await evaluate('document.activeElement.id'), 'toc-drawer', '目次ドロワーを開いてパネルへフォーカスしません');
    record('ドロワー・キーボード', 'Oで目次ドロワーを開く');

    await dispatchKey(send, 'Escape', 'Escape', { windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate('document.getElementById("toc-drawer").classList.contains("is-open")'), false, 'Escapeで目次が閉じません');
    assert.equal(await evaluate('document.getElementById("settings-drawer").classList.contains("is-open")'), false, 'Escapeで設定が閉じません');
    assert.equal(await evaluate('document.activeElement.id'), 'btn-open-settings', 'Escapeで閉じた後に可視の開閉ボタンへフォーカスが戻りません');
    record('ドロワー・キーボード', 'Escapeでドロワーを閉じる');
    const readingViewer = path.join(profile, 'reading-viewer.html');
      fs.copyFileSync(path.join(root, 'hitohira.html'), readingViewer);
    const readingDocument = path.join(profile, 'reading-chapters.html');
    const chapters = Array.from({ length: 7 }, (_, chapter) =>
      `<h1>第${chapter + 1}章</h1>` + Array.from({ length: 16 }, (_, paragraph) =>
        `<p>Hitohira 章${chapter + 1}・段落${paragraph + 1}。${'窓から差し込む光が、机の上をゆっくり移動した。'.repeat(7)}<ruby>光<rt>ひかり</rt></ruby></p>`).join('')).join('');
    fs.writeFileSync(readingDocument, chapters, 'utf8');
    const readingUrl = pathToFileURL(readingViewer).href;
    const waitForReading = (condition, message) => waitForCondition(
      () => evaluate(condition), { timeoutMs: 5000, intervalMs: 50, message }
    );
    await send('Page.navigate', { url: readingUrl });
    await waitForReading(`location.href === ${JSON.stringify(readingUrl)} && document.readyState === 'complete'`, '読書位置の検証用ビューアを開けません');
    await evaluate('document.getElementById("btn-open-settings").click()');
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

    await evaluate(`(() => {
      const nativeSet = Storage.prototype.setItem;
      window.storageFailureProbe = { nativeSet, writes: 0 };
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('hitohira_position:')) { window.storageFailureProbe.writes++; throw new DOMException('quota', 'QuotaExceededError'); }
        return nativeSet.call(this, key, value);
      };
      document.querySelectorAll('#novel-content p')[20].scrollIntoView({ block: 'start' });
    })()`);
    await waitForReading('!document.getElementById("error-notice").hidden && window.storageFailureProbe.writes > 0', '読書位置保存失敗が通知されません');
    await evaluate('document.querySelectorAll("#novel-content p")[21].scrollIntoView({ block: "start" })');
    assert.equal(await evaluate('window.storageFailureProbe.writes > 1'), true, '連続した保存失敗が発生していません');
    assert.equal(await evaluate('document.getElementById("error-notice-message").textContent.includes("保存できませんでした")'), true);
    assert.ok(await evaluate('document.getElementById("viewer-container").scrollTop > 0'), '保存失敗で現在の読書位置が失われました');
    await evaluate('Storage.prototype.setItem = window.storageFailureProbe.nativeSet');
    await evaluate('document.querySelectorAll("#novel-content p")[22].scrollIntoView({ block: "start" })');
    await waitForReading(`${savedReadingPosition}?.lineIndex === 25 || ${savedReadingPosition}?.scrollTop > 0`, '保存領域復旧後に読書位置が再保存されません');
    await waitForReading('document.getElementById("error-notice").hidden', '再保存後も保存失敗通知が残ります');
    await evaluate('delete window.storageFailureProbe');
    record('読書位置', '保存失敗を通知・集約し、復旧後のスクロール操作で再保存');

    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const tapElement = async selector => {
      const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const responsiveState = async drawer => evaluate(`(() => {
      const panel = document.getElementById(${JSON.stringify(drawer)});
      const r = panel.getBoundingClientRect();
      return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth,
        panel: [r.left, r.top, r.right, r.bottom], visible: getComputedStyle(panel).visibility,
        bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight };
    })()`);
    const narrowPage = await evaluate('({ width: document.documentElement.scrollWidth, viewport: innerWidth })');
    assert.ok(narrowPage.width <= 320 && narrowPage.viewport === 320, '幅320pxでページが横にはみ出します');
    await tapElement('#btn-open-settings');
    await waitForReading('getComputedStyle(document.getElementById("settings-drawer")).visibility === "visible" && Math.abs(document.getElementById("settings-drawer").getBoundingClientRect().right - innerWidth) <= 0.25', '設定ドロワーの開閉アニメーションが完了しません');
    const settingsGeometry = await responsiveState('settings-drawer');
    assert.deepEqual(settingsGeometry.viewport, [320, 640]);
    assert.equal(settingsGeometry.documentWidth, 320);
    assert.ok(settingsGeometry.panel[0] >= -1 && settingsGeometry.panel[2] <= 321 && settingsGeometry.panel[3] <= 640,
      `設定ドロワーが狭い画面からはみ出します: ${JSON.stringify(settingsGeometry)}`);
    assert.equal(settingsGeometry.visible, 'visible');
    await tapElement('#btn-close-settings');
    await waitForReading('getComputedStyle(document.getElementById("settings-drawer")).visibility === "hidden"', 'タッチで設定を閉じられません');
    await tapElement('#btn-open-settings');
    await waitForReading('getComputedStyle(document.getElementById("settings-drawer")).visibility === "visible" && Math.abs(document.getElementById("settings-drawer").getBoundingClientRect().right - innerWidth) <= 0.25', '設定ドロワーの再表示アニメーションが完了しません');
    await tapElement('#btn-open-toc');
    await waitForReading('getComputedStyle(document.getElementById("toc-drawer")).visibility === "visible" && Math.abs(document.getElementById("toc-drawer").getBoundingClientRect().right - innerWidth) <= 0.25', '目次ドロワーの開閉アニメーションが完了しません');
    const tocGeometry = await responsiveState('toc-drawer');
    assert.ok(tocGeometry.panel[0] >= -1 && tocGeometry.panel[2] <= 321 && tocGeometry.panel[3] <= 640,
      '目次ドロワーが狭い画面からはみ出します');
    await tapElement('#btn-close-toc');
    await waitForReading('getComputedStyle(document.getElementById("toc-drawer")).visibility === "hidden"', 'タッチで目次を閉じられません');
    await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=vertical]").click()');
    assert.equal(await evaluate('document.documentElement.dataset.writingMode'), 'vertical');
    await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=horizontal]").click()');
    assert.equal(await evaluate('document.documentElement.dataset.writingMode'), 'horizontal');
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');
    record('レスポンシブ表示', '幅320pxの縦長画面で本文・設定・目次を表示し、タッチ操作と書字方向切替を確認');

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
    await waitForCondition(() => evaluate('window.getSelection().toString().trim() === "Hitohira"'), {
      timeoutMs: 2000, intervalMs: 25, message: 'ブラウザーの単語選択が反映されません'
    });
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
    await send('Browser.setDownloadBehavior', { behavior: 'deny', downloadPath: failureDownloads });
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
      await evaluate('document.getElementById("btn-close-error-notice").click()');
      assert.equal(await evaluate('document.getElementById("error-notice").hidden'), true, '閉じる操作で失敗通知が消えません');
      assert.deepEqual(fs.readdirSync(failureDownloads), [], '失敗時に不完全なファイルが生成されました');
      record('エクスポート', '失敗を通知し、手動閉鎖と例外ログを確認');
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
      await waitForReading('location.pathname === "/restricted" && !!document.getElementById("ctrl-wake-lock") && document.readyState === "complete"', '制約検証ページを読み込めません');
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
      await waitForReading('document.getElementById("wake-lock-status").textContent === "（取得失敗）"', 'ポリシーによるWake Lock取得失敗が表示されません');
      record('ブラウザーポリシー', 'Permissions-PolicyでWake Lockを拒否');

      await send('Page.navigate', { url: origin + '/storage' });
      await waitForReading('location.pathname === "/storage" && !!document.getElementById("file-input") && document.readyState === "complete"', '容量検証ページを読み込めません');
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
        await waitForReading('document.title === "既存本文"', '容量上限内の本文を保存できません');
        await importText('容量超過.txt', 2 * quotaSize);
        await waitForReading('!document.getElementById("error-notice").hidden || document.title === "容量超過"', '容量超過の入力が完了しません');
        assert.equal(await evaluate('document.title'), '既存本文', '制限中に本文が置き換わりました');
        assert.match(await evaluate('document.getElementById("error-notice-message").textContent'), /容量超過\.txt.*保存領域が不足/);
        assert.equal(await evaluate('document.getElementById("novel-content").textContent.trim()'), 'AAAAAAAA');
      } finally {
        await send('Storage.overrideQuotaForOrigin', { origin });
      }
      await importText('容量解除後.txt', 12);
      await waitForReading('document.title === "容量解除後"', '容量上限の解除後に本文を保存できません');
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
        await waitForReading(ready, `${name}を取り込めません`);
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
        await waitForReading('document.getElementById("html-export-size").textContent !== "計算中"', `${name}のHTMLエクスポートサイズを計算できません`);
        const exportSizeLabel = await evaluate('document.getElementById("html-export-size").textContent');
        const sizeUnits = ['B', 'KB', 'MB', 'GB', 'TB'];
        let displayedSize = outputBytes;
        let displayedUnit = 0;
        while (displayedSize >= 1000 && displayedUnit < sizeUnits.length - 1) { displayedSize /= 1000; displayedUnit++; }
        const displayedPrecision = displayedSize >= 100 ? 0 : displayedSize >= 10 ? 1 : 2;
        const expectedSizeLabel = `${Number(displayedSize.toFixed(displayedPrecision))} ${sizeUnits[displayedUnit]}`;
        assert.equal(exportSizeLabel, expectedSizeLabel, `${name}のHTMLエクスポートサイズ表示が実ファイルと一致しません`);
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
        await waitForReading('location.pathname === "/restricted-video" && document.body?.classList.contains("video-bg")', '自動再生制約下で背景動画を復元できません');
        assert.equal(await evaluate('document.featurePolicy.allowsFeature("autoplay")'), false);
        await waitForReading('document.getElementById("background-video").readyState >= 3', '自動再生制約下で動画をデコードできません');
        const playing = '!document.getElementById("background-video").paused';
        const rejected = '!document.getElementById("error-notice").hidden && document.getElementById("error-notice-message").textContent.includes("自動再生を拒否")';
        await waitForReading(`${playing} || (${rejected})`, 'ミュート動画の再生結果を確認できません');
        const outcome = await evaluate(playing) ? '再生' : 'NotAllowedError';
        console.log(`  自動再生ポリシー適用時のミュート動画: ${outcome}`);
        record('ブラウザーポリシー', 'Permissions-Policy適用時のミュート動画の再生可否を観測');
      }
    }

    const minifierProfile = path.join(profile, 'minifier-profile');
    await closeBrowser(send);
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    const minifierUrl = pathToFileURL(path.join(root, 'public', 'hitohira.html')).href;
    const offlineDownloadPath = path.join(profile, 'offline-downloads');
    fs.mkdirSync(offlineDownloadPath);
    await connectIsolated(minifierUrl, minifierProfile, {
      offline: true,
      downloadPath: offlineDownloadPath,
      exercise: async ({ send: offlineSend, evaluate: offlineEvaluate, networkRequests }) => {
        const waitForOffline = async (expression, message) => {
          for (let i = 0; i < 100; i++) {
            if (await offlineEvaluate(expression)) return;
            await sleep(50);
          }
          assert.fail(message);
        };
        await waitForOffline('document.readyState === "complete" && !!document.getElementById("novel-content")', 'オフラインで公開HTMLを起動できません');
        assert.equal(await offlineEvaluate('navigator.onLine'), false, 'ブラウザーがオフライン状態になっていません');
        assert.ok((await offlineEvaluate('document.getElementById("novel-content").textContent')).includes('Hitohira'));
        const networkProbe = await offlineEvaluate(`(async () => {
          try { await fetch('https://example.com/', { cache: 'no-store' }); return '接続'; }
          catch (_) { return '遮断'; }
        })()`);
        assert.equal(networkProbe, '遮断', 'オフライン状態で外部接続を遮断できません');
        const applicationRequestStart = networkRequests.length;

        await offlineEvaluate('document.getElementById("btn-theme-toggle").click()');
        assert.equal(await offlineEvaluate('document.documentElement.dataset.theme'), 'dark', 'オフラインでテーマを変更できません');
        const documentTree = await offlineSend('DOM.getDocument', { depth: -1 });
        const fileInput = await offlineSend('DOM.querySelector', { nodeId: documentTree.root.nodeId, selector: '#file-input' });
        await offlineSend('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [textFixture] });
        await waitForOffline('document.title === ".tmp-browser-text" && !!document.getElementById("btn-download-text")', 'オフラインでテキスト本文を読み込めません');
        assert.equal(await offlineEvaluate('document.getElementById("novel-content").textContent.trim()'), 'ブラウザー操作テスト本文');
        assert.equal(await offlineEvaluate('document.querySelector("#btn-download-text").closest(".file-action-group").querySelector(".file-action-size").textContent'),
          formatFileSize(fs.statSync(textFixture).size), 'オフラインで読み込んだ元ファイルのサイズが一致しません');
        assert.equal(await offlineEvaluate('(async () => new Promise(resolve => { const request = indexedDB.open("hitohira_media_db"); request.onerror = () => resolve(false); request.onsuccess = () => { const db = request.result; const tx = db.transaction("background_media", "readonly"); const get = tx.objectStore("background_media").get("current_text"); get.onsuccess = () => resolve(!!get.result && get.result.blob instanceof Blob); get.onerror = () => resolve(false); }; }))()'), true,
          'オフラインで読み込んだ元ファイルを保存できません');
        assert.equal(await offlineEvaluate('(async () => new Promise(resolve => { const request = indexedDB.open("hitohira_media_db"); request.onerror = () => resolve(-1); request.onsuccess = () => { const db = request.result; const get = db.transaction("background_media", "readonly").objectStore("background_media").get("current_text"); get.onsuccess = () => resolve(get.result.blob.size); get.onerror = () => resolve(-1); }; }))()'),
          fs.statSync(textFixture).size, 'オフラインで保存した元ファイルのバイト数が一致しません');
        assert.equal(await offlineEvaluate('localStorage.getItem("hitohira_content")?.includes("ブラウザー操作テスト本文")'), true,
          'オフラインで読み込んだ本文を保存できません');
        await offlineSend('Page.reload', { ignoreCache: true });
        await waitForOffline('document.readyState === "complete" && document.documentElement.dataset.theme === "dark" && !!document.getElementById("btn-download-text")',
          'オフライン再読み込み後に設定と元ファイルを復元できません');
        assert.equal(await offlineEvaluate('document.getElementById("novel-content").textContent.trim()'), 'ブラウザー操作テスト本文');
        assert.equal(await offlineEvaluate('(async () => new Promise(resolve => { const request = indexedDB.open("hitohira_media_db"); request.onerror = () => resolve(-1); request.onsuccess = () => { const db = request.result; const get = db.transaction("background_media", "readonly").objectStore("background_media").get("current_text"); get.onsuccess = () => resolve(get.result.blob.size); get.onerror = () => resolve(-1); }; }))()'),
          fs.statSync(textFixture).size, 'オフラインで復元した元ファイルのバイト数が一致しません');

        await offlineEvaluate('document.getElementById("btn-export-html").click()');
        let exportedFile = null;
        for (let i = 0; i < 200; i++) {
          exportedFile = fs.readdirSync(offlineDownloadPath).find(name => name.endsWith('.html'));
          if (exportedFile) break;
          await sleep(50);
        }
        assert.ok(exportedFile, 'オフラインでHTMLを書き出せません');
        const exportedHtmlPath = path.join(offlineDownloadPath, exportedFile);
        const exportedHtml = fs.readFileSync(exportedHtmlPath, 'utf8');
        assert.doesNotMatch(exportedHtml, /<script\b[^>]*\bsrc\s*=/i, 'オフラインHTMLに外部スクリプト参照が含まれます');
        assert.doesNotMatch(exportedHtml, /<link\b[^>]*\brel\s*=\s*["']?stylesheet[^>]*\bhref\s*=/i, 'オフラインHTMLに外部スタイル参照が含まれます');
        assert.doesNotMatch(exportedHtml, /<(?:html|body|video)\b[^>]*\bblob:/i, 'オフラインHTMLに実行元Blob URLが残っています');
        const downloadData = JSON.parse(exportedHtml.match(/<script[^>]+id="viewer-download-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
        assert.deepEqual(Buffer.from(downloadData.textBase64, 'base64'), fs.readFileSync(textFixture), 'オフラインHTMLの埋め込み元ファイルが元バイト列と一致しません');
        await waitForOffline('document.getElementById("html-export-size").textContent !== "計算中"', 'オフラインHTMLのサイズ表示を計算できません');
        assert.equal(await offlineEvaluate('document.getElementById("html-export-size").textContent'),
          formatFileSize(fs.statSync(exportedHtmlPath).size), 'オフラインHTMLの表示サイズが出力ファイルと一致しません');
        assert.deepEqual(networkRequests.slice(applicationRequestStart).filter(url => /^https?:/i.test(url)), [],
          '本文・保存・再読み込み・エクスポート中にアプリがHTTP(S)通信を要求しました');
        record('オフライン配布', 'ネットワーク遮断下で公開HTMLの起動、テーマ設定、本文取込、保存復元、HTML出力を確認');
        record('オフライン配布', 'HTTP(S)接続遮断とアプリ操作中の外部通信なしを確認');
      }
    });
    record('公開用ビルド', '公開用圧縮版をオフラインで起動');
    if (!exportedVideoHtml) {
      console.log('[  SKIPPED ] 動画を含むHTMLの独立起動（NOVEL_VIEWER_POLICY_TESTS=1で実行）');
    } else {
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
    }

    const total = [...categories.values()].reduce((count, cases) => count + cases.length, 0);
    if (process.env.NOVEL_VIEWER_TEST_TIMINGS === '1') {
      console.log(`[ TIMER    ] ブラウザーテスト本体: ${Math.round(performance.now() - testStartedAt)} ms`);
      for (const item of timingCheckpoints.sort((a, b) => b.durationMs - a.durationMs).slice(0, 8)) {
        console.log(`[ TIMER    ] ${item.category}.${item.name}: ${item.durationMs} ms (前チェックポイントから)`);
      }
    }
    console.log(`[==========] ${total} tests ran.`);
    console.log(`[  PASSED  ] ${total} tests.`);
  } finally {
    const cleanupStartedAt = performance.now();
    await activeCleanup();
    activeCleanup = null;
    if (process.env.NOVEL_VIEWER_TEST_TIMINGS === '1') {
      console.log(`[ TIMER    ] テスト終了処理: ${Math.round(performance.now() - cleanupStartedAt)} ms`);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    Promise.resolve(activeCleanup?.())
      .finally(() => process.exit(130));
  });
}
main().catch(error => {
  console.error(`[  FAILED  ] ブラウザー操作.実行 (終了コード: 1)\n  ${error.stack || error.message}`);
  if (lastBrowserAttempt) {
    const diagnosis = classifyBrowserFailure(error, lastBrowserAttempt);
    console.error(`  [原因分類] ${diagnosis.code}: ${diagnosis.cause}`);
    console.error(`  Browser: ${lastBrowserAttempt.browser}`);
    console.error(`  CDP: ${lastBrowserAttempt.transport} / stage=${lastBrowserAttempt.stage}`);
    console.error(`  Target URL: ${lastBrowserAttempt.url}`);
    console.error(`  Launch args: ${JSON.stringify(lastBrowserAttempt.args)}`);
    const exit = lastBrowserAttempt.exit || childExit;
    if (exit) console.error(`  Browser exit: code=${exit.code}, signal=${exit.signal || 'none'}`);
    const stderr = (lastBrowserAttempt.stderr || childError).trim();
    if (stderr) console.error(`  Browser stderr: ${stderr}`);
  }
  process.exitCode = 1;
});
