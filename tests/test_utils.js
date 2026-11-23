'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

function terminateBrowserTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
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

function loadFunctionsFromHtml(html, startMarker, endMarker, names, globals = {}) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, '実行対象の関数範囲を抽出できません');
  const context = { ...globals };
  vm.runInNewContext(`${html.slice(start, end)}\nthis.__exports = { ${names.join(', ')} };`, context);
  return context.__exports;
}

module.exports = { assertUniqueHtmlIds, assertIconButtonsAccessible, dispatchKey, formatCaseLine, loadFunctionsFromHtml, terminateBrowserTree };
