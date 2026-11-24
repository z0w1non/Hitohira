'use strict';

const fs = require('node:fs');
const path = require('node:path');
const terser = require('terser');
const acorn = require('acorn');

const root = path.resolve(__dirname, '..');
const inputPath = path.join(root, 'hitohira.html');
const outputPath = path.join(root, 'public', 'hitohira.html');
const source = fs.readFileSync(inputPath, 'utf8');

async function buildMinifiedHtml(html) {
  const licenseMatch = html.match(/<!--[\s\S]*?MIT License[\s\S]*?-->/);
  if (!licenseMatch) throw new Error('MITライセンス表記を確認できません。');
  const license = licenseMatch[0];
  const licensePlaceholder = '__HITOHIRA_MIT_LICENSE_PRESERVED__';
  if (html.indexOf(license) !== html.lastIndexOf(license)) throw new Error('MIT表記が複数あるため処理を中断します。');
  const protectedHtml = html.replace(license, licensePlaceholder);
  const scripts = [...protectedHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const maps = new Map();
  for (const script of scripts) {
    if (/\bsrc\s*=/.test(script[1]) || /\btype\s*=\s*["']application\/json/i.test(script[1])) continue;
    maps.set(script.index, script);
  }
  let output = '';
  let offset = 0;
  for (const script of maps.values()) {
    output += protectedHtml.slice(offset, script.index).replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><');
    const code = script[2];
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
    const result = await terser.minify(code, { compress: true, mangle: true, format: { comments: false } });
    const minified = result.code;
    if (!minified) throw new Error('JavaScriptの圧縮結果が空です。');
    acorn.parse(minified, { ecmaVersion: 'latest', sourceType: 'script' });
    output += `<script${script[1]}>${minified.replace(/<\/script/gi, '<\\/script')}</script>`;
    offset = script.index + script[0].length;
  }
  output += protectedHtml.slice(offset).replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><');
  output = output.replace(licensePlaceholder, license);
  if (!output.includes(license)) throw new Error('圧縮後にMIT表記が保持されませんでした。');
  return output;
}

async function main() {
  const output = await buildMinifiedHtml(source);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  const inputBytes = Buffer.byteLength(source);
  const outputBytes = Buffer.byteLength(output);
  console.log(JSON.stringify({
    input: path.relative(root, inputPath), output: path.relative(root, outputPath),
    inputBytes, outputBytes, reductionBytes: inputBytes - outputBytes,
    reductionPercent: Number(((inputBytes - outputBytes) / inputBytes * 100).toFixed(2)),
    runtimeMinifierBytes: 0, runtimeRestoreCodeBytes: 0
  }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { buildMinifiedHtml };
