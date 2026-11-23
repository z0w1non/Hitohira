'use strict';

const { spawnSync } = require('node:child_process');

const suites = {
  unit: 'novel_viewer_unit_test.js',
  browser: 'novel_viewer_browser_test.js',
  firefox: 'novel_viewer_firefox_test.js'
};
const requested = process.argv.slice(2);
const names = requested.length === 0 || requested.includes('all')
  ? ['unit', 'browser', ...requested.filter(name => name === 'firefox')]
  : requested;
const unknown = names.filter(name => !suites[name]);

if (unknown.length) {
  console.error(`不明なテスト単位: ${unknown.join(', ')}`);
  console.error('使用方法: node tests/run_tests.js [unit] [browser] [firefox] [all]');
  process.exit(2);
}

let failed = false;
for (const name of names) {
  console.log(`\n=== ${name} テスト ===`);
  const result = spawnSync(process.execPath, [`${__dirname}/${suites[name]}`], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    failed = true;
    console.error(`✗ ${name} テスト失敗 (終了コード: ${result.status ?? 1})`);
  }
}

process.exitCode = failed ? 1 : 0;
if (!failed) console.log('\n✓ テスト実行成功');
