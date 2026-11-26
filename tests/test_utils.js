'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

function terminateBrowserTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
    if (result.error || result.status !== 0) child.kill('SIGKILL');
  } else {
    child.kill('SIGTERM');
  }
}

function assertUniqueHtmlIds(html) {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], 'HTML内に重複IDがあります');
}

function assertIconButtonsAccessible(html) {
  const buttons = [...html.matchAll(/<button\b[^>]*class=["'][^"']*icon-btn[^"']*["'][^>]*>/gi)];
  for (const [tag] of buttons) assert.match(tag, /\baria-label=["'][^"']+["']/i, `アイコンボタンにaria-labelがありません: ${tag}`);
}

async function dispatchKey(send, key, code, options = {}) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...options });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, ...options });
}

function formatCaseLine(status, suite, name) {
  const labels = { run: '[ RUN      ]', ok: '[       OK ]', failed: '[  FAILED  ]' };
  assert.ok(labels[status], `不明なテスト状態: ${status}`);
  return `${labels[status]} ${suite}.${name}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForCondition(probe, { timeoutMs = 5000, intervalMs = 50, message = '状態待ちがタイムアウトしました' } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timeout;
    let value;
    try {
      value = await Promise.race([
        Promise.resolve().then(probe),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), remaining); })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (value) return value;
    const remainingAfterProbe = deadline - Date.now();
    if (remainingAfterProbe <= 0) break;
    await sleep(Math.min(intervalMs, remainingAfterProbe));
  } while (Date.now() <= deadline);
  throw new Error(message);
}

function createCdpClient(ws, { timeoutMs = 5000 } = {}) {
  let id = 0;
  let failure;
  const pending = new Map();
  const rejectPending = error => {
    failure ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
  };
  ws.addEventListener('message', event => {
    let response;
    try { response = JSON.parse(event.data); }
    catch (error) { rejectPending(new Error(`CDP応答を解析できません: ${error.message}`)); return; }
    const entry = pending.get(response.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(response.id);
    if (response.error) entry.reject(new Error(response.error.message));
    else entry.resolve(response.result);
  });
  ws.addEventListener('close', () => rejectPending(new Error('CDP接続が閉じました')));
  ws.addEventListener('error', () => rejectPending(new Error('CDP接続でエラーが発生しました')));
  return (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`CDP応答タイムアウト (${method}, ${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id: requestId, method, params })); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

function loadFunctionsFromHtml(html, startMarker, endMarker, names, globals = {}) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, '実行対象の関数範囲を抽出できません');
  const context = { ...globals };
  vm.runInNewContext(`${html.slice(start, end)}\nthis.__exports = { ${names.join(', ')} };`, context);
  return context.__exports;
}

module.exports = { assertUniqueHtmlIds, assertIconButtonsAccessible, createCdpClient, dispatchKey, formatCaseLine, loadFunctionsFromHtml, terminateBrowserTree, waitForCondition };
