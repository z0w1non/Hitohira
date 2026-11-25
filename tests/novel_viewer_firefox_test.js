'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { formatCaseLine, terminateBrowserTree } = require('./test_utils');

async function run() {
  const executable = process.env.NOVEL_VIEWER_FIREFOX_PATH || path.join(process.env.ProgramFiles || '', 'Mozilla Firefox', 'firefox.exe');
  assert.ok(fs.existsSync(executable), 'Firefoxが見つかりません。NOVEL_VIEWER_FIREFOX_PATHで実行ファイルを指定してください');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-viewer-firefox-'));
  const child = spawn(executable, ['-headless', '-no-remote', '-profile', profile, '--remote-debugging-port', '0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const closed = new Promise(resolve => child.once('close', resolve));
  let socket;
  let cleanup;
  const dispose = () => cleanup ??= (async () => {
    socket?.close();
    terminateBrowserTree(child);
    await closed;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4 });
  })();
  const interrupted = () => dispose().then(() => process.exit(130), error => {
    console.error(error);
    process.exit(1);
  });
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);

  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`Firefox BiDiの起動が時間切れになりました\n${output}`)), 15000);
      const fail = error => { clearTimeout(timeout); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error(`Firefoxの終了コード: ${code}\n${output}`)));
      child.stderr.on('data', chunk => {
        output += chunk;
        const address = output.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/);
        if (address) {
          clearTimeout(timeout);
          resolve(address[1] + '/session');
        }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`BiDiに接続できません: ${endpoint}`)), 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error(`BiDi接続失敗: ${endpoint}`)); }, { once: true });
    });
    let id = 0;
    // This smoke test sends one command at a time.
    const send = (method, params) => new Promise((resolve, reject) => {
      const commandId = ++id;
      const timeout = setTimeout(() => finish(new Error(`BiDi応答待ちが時間切れになりました: ${method}`)), 10000);
      const listener = event => {
        const response = JSON.parse(event.data);
        if (response.id !== commandId) return;
        if (response.type === 'error') finish(new Error(`${method}: ${response.message}`));
        else finish(null, response.result);
      };
      const finish = (error, result) => {
        clearTimeout(timeout);
        socket.removeEventListener('message', listener);
        if (error) reject(error);
        else resolve(result);
      };
      socket.addEventListener('message', listener);
      try { socket.send(JSON.stringify({ id: commandId, method, params })); }
      catch (error) { finish(error); }
    });
    const { capabilities } = await send('session.new', { capabilities: {} });
    console.log(`  ブラウザー: ${capabilities.browserName} ${capabilities.browserVersion} / WebDriver BiDi`);
    const { contexts } = await send('browsingContext.getTree', {});
    const { context } = contexts[0];
    const url = pathToFileURL(path.join(__dirname, '..', 'hitohira.html')).href;
    await send('browsingContext.navigate', { context, url, wait: 'complete' });
    const evaluate = async expression => {
      const result = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
      assert.equal(result.type, 'success', result.exceptionDetails?.text);
      return result.result.value;
    };
    const test = async (name, execute) => {
      console.log(formatCaseLine('run', 'Firefox操作', name));
      await execute();
      console.log(formatCaseLine('ok', 'Firefox操作', name));
    };
    await test('単体HTMLを起動して既定本文を表示', async () => {
    assert.equal(await evaluate('document.title'), 'Hitohira');
      assert.equal(await evaluate('document.getElementById("novel-content").textContent.includes("本文を読む")'), true);
    });
    await test('実キー入力で設定を開閉', async () => {
      const press = value => send('input.performActions', {
        context,
        actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }]
      });
      await evaluate('document.getElementById("viewer-container").focus()');
      await press('s');
      assert.equal(await evaluate('document.getElementById("settings-drawer").classList.contains("is-open")'), true);
      await press('\uE00C');
      assert.equal(await evaluate('document.getElementById("settings-drawer").classList.contains("is-open")'), false);
    });
    await test('横書き・縦書きを切り替えて表示状態を確認', async () => {
      for (const mode of ['vertical', 'horizontal']) {
        await evaluate(`document.querySelector('#ctrl-writing-mode button[data-value=${mode}]').click()`);
        assert.equal(await evaluate('document.documentElement.dataset.writingMode'), mode);
      }
    });
    await test('TXTを取り込み、本文と設定を保存後に復元', async () => {
      await evaluate(`(() => {
        const input = document.getElementById('file-input');
        const file = new File(['Firefox integration novel'], 'firefox-test.txt', { type: 'text/plain' });
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      for (let i = 0; i < 50 && !await evaluate('document.getElementById("novel-content").textContent.includes("Firefox integration novel")'); i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(await evaluate('document.getElementById("novel-content").textContent.includes("Firefox integration novel")'), true);
      await evaluate('document.querySelector("#ctrl-writing-mode button[data-value=vertical]").click()');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      assert.equal(await evaluate('localStorage.getItem("hitohira_content").includes("Firefox integration novel")'), true);
      await send('browsingContext.navigate', { context, url, wait: 'complete' });
      assert.equal(await evaluate('document.getElementById("novel-content").textContent.includes("Firefox integration novel")'), true);
      assert.equal(await evaluate('document.documentElement.dataset.writingMode'), 'vertical');
      assert.equal(await evaluate('performance.getEntriesByType("resource").some(entry => /^https?:/i.test(entry.name))'), false,
        '起動時に外部HTTP(S)リソースを要求しました');
    });
    await test('HTMLエクスポートを生成し、埋め込み本文を検査', async () => {
      await evaluate(`(() => {
        window.exportProbe = {};
        URL.createObjectURL = blob => { window.exportProbe.blob = blob; return 'blob:firefox-test'; };
        HTMLAnchorElement.prototype.click = function() {};
        document.getElementById('btn-export-html').click();
      })()`);
      for (let i = 0; i < 100 && !await evaluate('window.exportProbe.blob instanceof Blob'); i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const exported = await evaluate('window.exportProbe.blob ? window.exportProbe.blob.text() : ""');
      assert.ok(exported.includes('Firefox integration novel'));
      assert.ok(exported.includes('id="viewer-download-data"'));
      assert.ok(!/<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//i.test(exported),
        'エクスポートHTMLの実行時リソースが外部URLを参照しています');
      await evaluate('delete window.exportProbe');
    });
    await send('session.end', {});
  } finally {
    await dispose();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
  console.log('[==========] 5 tests ran.');
  console.log('[  PASSED  ] 5 tests.');
}

run().catch(error => {
  console.error(formatCaseLine('failed', 'Firefox操作', '実行') + '\n' + error.stack);
  process.exitCode = 1;
});
