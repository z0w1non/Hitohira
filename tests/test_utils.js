'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const acorn = require('acorn');

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

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

function classifyBrowserFailure(error, { transport = '', stage = '', stderr = '' } = {}) {
  const message = `${error?.message || error || ''} ${error?.cause?.message || ''}`;
  const details = `${message}\n${stderr}`;
  if (/EACCES|EPERM/.test(details) && transport === 'TCP') {
    return { code: 'CDP_LOOPBACK_DENIED', cause: '実行環境がCDPのループバック接続を拒否しています。テスト実行権限または接続方式を確認してください。' };
  }
  if (/crashpad.*(?:failed|終了)|crash server failed|TransactNamedPipe/i.test(stderr) && /startup|port announcement|CDP port|起動|通知/i.test(`${stage} ${message}`)) {
    return { code: 'BROWSER_CRASHPAD_STARTUP', cause: 'ブラウザーの起動時にCrashpadが開始できず、ブラウザーが終了した可能性があります。標準エラーとプロセス終了情報を確認してください。' };
  }
  if (/CDPポート通知前に終了|exited before.*(?:CDP|port)/i.test(message)) {
    return { code: 'BROWSER_EXITED_BEFORE_CDP', cause: 'ブラウザーがCDPポート通知前に終了しました。起動引数、標準エラー、終了コードを確認してください。' };
  }
  if (/DevToolsActivePort|CDPポートを通知しません/.test(message)) {
    return { code: 'CDP_PORT_NOT_ANNOUNCED', cause: 'ブラウザーが制限時間内にCDPポートを通知しませんでした。ブラウザー起動状態とプロファイルへの書き込みを確認してください。' };
  }
  if (/CDPターゲットを取得できません|ターゲット取得がタイムアウト/.test(message)) {
    return { code: 'CDP_TARGET_UNAVAILABLE', cause: 'CDPには到達しましたが対象ページを取得できませんでした。URL、ポート、ブラウザーの起動状態を確認してください。' };
  }
  if (/WebSocket/.test(message)) {
    return { code: 'CDP_WEBSOCKET_FAILED', cause: 'CDP WebSocketの接続または応答に失敗しました。対象URLと接続エラーを確認してください。' };
  }
  if (/CDPパイプ/.test(message) || transport === 'pipe' && /timeout|closed/i.test(message)) {
    return { code: 'CDP_PIPE_FAILED', cause: 'CDPパイプが閉じたか応答しませんでした。ブラウザーがパイプ接続を維持したか確認してください。' };
  }
  if (/timeout|timed out|タイムアウト/i.test(message)) {
    return { code: 'BROWSER_OPERATION_TIMEOUT', cause: 'ブラウザー操作が制限時間を超えました。該当段階と直前の状態を確認してください。' };
  }
  return { code: 'BROWSER_FAILURE_UNCLASSIFIED', cause: '既知の分類に一致しません。起動引数、終了情報、標準エラーを確認してください。' };
}

function createFakeClock(startAt = 0) {
  let now = startAt;
  let nextId = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(callback, delay = 0) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advanceBy(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback();
        await flushMicrotasks();
      }
      now = target;
      await flushMicrotasks();
    },
    async runUntil(promise) {
      let settled = false;
      let result;
      let failure;
      Promise.resolve(promise).then(value => { settled = true; result = value; }, error => { settled = true; failure = error; });
      await flushMicrotasks();
      while (!settled) {
        const next = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
        if (!next) throw new Error('Fake clock has no timer capable of settling the operation');
        await clock.advanceBy(next.dueAt - now);
        await flushMicrotasks();
      }
      if (failure) throw failure;
      return result;
    }
  };
  return clock;
}

const systemClock = {
  now: () => Date.now(),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: id => clearTimeout(id)
};

async function waitForCondition(probe, { timeoutMs = 5000, intervalMs = 50, message = '状態待ちがタイムアウトしました', clock = systemClock } = {}) {
  const deadline = clock.now() + timeoutMs;
  do {
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    let timeout;
    let value;
    try {
      value = await Promise.race([
        Promise.resolve().then(probe),
        new Promise((_, reject) => { timeout = clock.setTimeout(() => reject(new Error(message)), remaining); })
      ]);
    } finally {
      clock.clearTimeout(timeout);
    }
    if (value) return value;
    const remainingAfterProbe = deadline - clock.now();
    if (remainingAfterProbe <= 0) break;
    await new Promise(resolve => clock.setTimeout(resolve, Math.min(intervalMs, remainingAfterProbe)));
  } while (clock.now() <= deadline);
  throw new Error(message);
}

function createCdpClient(ws, { timeoutMs = 5000, clock = systemClock } = {}) {
  let id = 0;
  let failure;
  const pending = new Map();
  const rejectPending = error => {
    failure ??= error;
    for (const entry of pending.values()) {
      clock.clearTimeout(entry.timer);
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
    clock.clearTimeout(entry.timer);
    pending.delete(response.id);
    if (response.error) entry.reject(new Error(response.error.message));
    else entry.resolve(response.result);
  });
  ws.addEventListener('close', () => rejectPending(new Error('CDP接続が閉じました')));
  ws.addEventListener('error', () => rejectPending(new Error('CDP接続でエラーが発生しました')));
  return (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const requestId = ++id;
    const timer = clock.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`CDP応答タイムアウト (${method}, ${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id: requestId, method, params })); }
    catch (error) {
      clock.clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

function loadFunctionsFromHtml(html, names, globals = {}) {
  const script = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .find(([, attributes, source]) => !/\btype\s*=\s*["']application\/json["']/i.test(attributes) && /\(\(\)\s*=>/.test(source));
  assert.ok(script, 'ビューアのJavaScriptが見つかりません');
  const ast = acorn.parse(script[2], { ecmaVersion: 'latest' });
  const initializer = ast.body.find(statement => statement.type === 'ExpressionStatement' &&
    statement.expression.type === 'CallExpression' && statement.expression.callee.type === 'ArrowFunctionExpression');
  assert.ok(initializer, 'ビューア初期化関数を解析できません');
  const declarations = initializer.expression.callee.body.body;
  const allFunctions = declarations.filter(node => node.type === 'FunctionDeclaration' && node.id);
  const functions = allFunctions.filter(node => !Object.hasOwn(globals, node.id.name));
  const variables = new Map();
  for (const declaration of declarations.filter(node => node.type === 'VariableDeclaration')) {
    for (const item of declaration.declarations) {
      if (item.id.type === 'Identifier') variables.set(item.id.name, declaration);
    }
  }
  const available = new Set(allFunctions.map(node => node.id.name));
  const requestedVariables = new Map();
  for (const name of names) {
    if (available.has(name) || Object.hasOwn(globals, name)) continue;
    const declaration = variables.get(name);
    assert.ok(declaration, `実行単位が見つかりません: ${name}`);
    requestedVariables.set(declaration.start, declaration);
  }
  const source = script[2];
  const units = [
    ...functions.map(node => source.slice(node.start, node.end)),
    ...[...requestedVariables.values()].map(node => source.slice(node.start, node.end))
  ];
  const context = Object.create(null);
  Object.defineProperties(context, Object.getOwnPropertyDescriptors(globals));
  vm.runInNewContext(`${units.join('\n')}\nthis.__exports = { ${names.join(', ')} };`, context);
  return context.__exports;
}

module.exports = { assertUniqueHtmlIds, assertIconButtonsAccessible, classifyBrowserFailure, createCdpClient, createFakeClock, dispatchKey, formatCaseLine, loadFunctionsFromHtml, terminateBrowserTree, waitForCondition };
