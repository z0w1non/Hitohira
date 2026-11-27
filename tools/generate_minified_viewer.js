'use strict';

const fs = require('node:fs');
const path = require('node:path');
const terser = require('terser');
const acorn = require('acorn');

const root = path.resolve(__dirname, '..');
const inputPath = path.join(root, 'hitohira.html');
const localesPath = path.join(__dirname, 'locales.json');
const publicDirectory = path.join(root, 'public');
const source = fs.readFileSync(inputPath, 'utf8');
const locales = JSON.parse(fs.readFileSync(localesPath, 'utf8'));

function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function replaceFontValue(html, property, value) {
  const pattern = new RegExp(`(${property}:\\s*)[^;]+;`);
  if (!pattern.test(html)) throw new Error(`${property}のCSS変数を確認できません。`);
  return html.replace(pattern, (_, prefix) => `${prefix}${value};`);
}

function removeEnclosingDiv(html, searchText, containerText) {
  const targetIndex = html.indexOf(searchText);
  if (targetIndex < 0) throw new Error(`${searchText}がHTML内にありません。`);
  const containerIndex = html.lastIndexOf(containerText, targetIndex);
  const start = html.indexOf('<div class="icon-control-group">', containerIndex + containerText.length);
  if (containerIndex < 0 || start < 0 || start > targetIndex) throw new Error(`${searchText}の親divを特定できません。`);

  const tags = /<div\b[^>]*>|<\/div>/gi;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(html))) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + html.slice(tags.lastIndex);
  }
  throw new Error(`${searchText}の親divが閉じられていません。`);
}

function localizeHtml(html, localeCode) {
  const locale = locales[localeCode];
  if (!locale) throw new Error(`未対応の公開言語です: ${localeCode}`);
  const dictionaryPattern = /<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/;
  const dictionaryMatch = html.match(dictionaryPattern);
  if (!dictionaryMatch) throw new Error('翻訳辞書scriptを確認できません。');
  const allDictionaries = JSON.parse(dictionaryMatch[1]);
  const dictionary = allDictionaries[localeCode];
  if (!dictionary) throw new Error(`${localeCode}の翻訳辞書がありません。`);
  const localizedDictionary = { ...dictionary, 'settings.serif': locale.fonts.serifLabel, 'settings.sans': locale.fonts.sansLabel };
  if (!locale.vertical) {
    localizedDictionary['intro.display'] = locale.displayWithoutVertical;
    localizedDictionary['intro.shortcuts'] = locale.shortcutsWithoutVertical;
  }

  let localized = html.replace(dictionaryPattern, `<script id="viewer-localization-data" type="application/json">${JSON.stringify({ [localeCode]: localizedDictionary })}</script>`);
  localized = localized.replace(/<html\b([^>]*)>/, (_, originalAttributes) => {
    let attributes = originalAttributes.replace(/\blang="[^"]*"/i, `lang="${localeCode}"`);
    if (/\bdir="[^"]*"/i.test(attributes)) {
      attributes = attributes.replace(/\bdir="[^"]*"/i, `dir="${localeCode === 'ar' ? 'rtl' : 'ltr'}"`);
    } else {
      attributes += ` dir="${localeCode === 'ar' ? 'rtl' : 'ltr'}"`;
    }
    attributes = attributes.replace(/\bdata-vertical-writing="[^"]*"/i, '');
    return `<html${attributes} data-vertical-writing="${locale.vertical ? 'true' : 'false'}">`;
  });

  localized = replaceFontValue(localized, '--font-sans', locale.fonts.sansStack);
  localized = replaceFontValue(localized, '--font-serif', locale.fonts.serifStack);
  localized = localized.replace(/(\.segmented-control\.font-control button\[data-value="serif"\]\s*\{\s*font-family:\s*)[^;]+;/, (_, prefix) => `${prefix}${locale.fonts.serifStack};`);
  localized = localized.replace(/(\.segmented-control\.font-control button\[data-value="sans"\]\s*\{\s*font-family:\s*)[^;]+;/, (_, prefix) => `${prefix}${locale.fonts.sansStack};`);
  localized = localized.replace(/(<button\b(?=[^>]*\bdata-value="serif")[^>]*>)[\s\S]*?(<\/button>)/, (_, open, close) => `${open}${escapeHtml(locale.fonts.serifIcon)}${close}`);
  localized = localized.replace(/(<button\b(?=[^>]*\bdata-value="sans")[^>]*>)[\s\S]*?(<\/button>)/, (_, open, close) => `${open}${escapeHtml(locale.fonts.sansIcon)}${close}`);

  if (!locale.vertical) {
    localized = removeEnclosingDiv(localized, 'id="ctrl-writing-mode"', '<div class="icon-control-row">');
    localized = localized.replace(/\s*<span class="icon-control-divider"[^>]*><\/span>/, '');
    localized = localized.replace('</style>', 'html[data-vertical-writing="false"] .icon-control-row > .icon-control-font-group { flex-basis: 100%; padding-inline: 0; }\nhtml[data-vertical-writing="false"] .icon-control-row > .icon-control-group:first-child { padding-right: 0; }\n</style>');
  }

  const articlePattern = /(<article id="novel-content">)([\s\S]*?)(<\/article>)/;
  if (!articlePattern.test(localized)) throw new Error('既定本文を確認できません。');
  localized = localized.replace(articlePattern, (_, open, content, close) => {
    const translated = content.replace(/(<([a-z][\w:-]*)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)[\s\S]*?(<\/\2>)/gi,
      (element, start, _tag, key, end) => {
        if (!Object.hasOwn(localizedDictionary, key)) throw new Error(`${localeCode}の既定本文翻訳がありません: ${key}`);
        return `${start}${escapeHtml(localizedDictionary[key])}${end}`;
      });
    return `${open}${translated}${close}`;
  });
  return localized;
}

async function minifyHtml(html) {
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
  if ((output.match(/<script id="viewer-localization-data"/g) || []).length !== 1) throw new Error('公開HTMLの翻訳辞書が一つではありません。');
  const embeddedDictionary = JSON.parse(output.match(/<script id="viewer-localization-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  if (Object.keys(embeddedDictionary).length !== 1) throw new Error('公開HTMLに複数言語の辞書が残っています。');
  return output;
}

async function buildMinifiedHtml(html, localeCode = 'ja') {
  return minifyHtml(localizeHtml(html, localeCode));
}

async function buildAllMinifiedHtml(html) {
  const outputs = [];
  for (const [localeCode, locale] of Object.entries(locales)) {
    outputs.push({ locale: localeCode, filename: `hitohira-${locale.suffix}.html`, html: await buildMinifiedHtml(html, localeCode) });
  }
  return outputs;
}

async function main() {
  const outputs = await buildAllMinifiedHtml(source);
  fs.mkdirSync(publicDirectory, { recursive: true });
  const localeFiles = new Set(outputs.map(output => output.filename));
  for (const filename of fs.readdirSync(publicDirectory)) {
    if (/^hitohira(?:-[a-z]{2}(?:-[a-z]{2})?)?\.html$/i.test(filename) && !localeFiles.has(filename)) {
      fs.rmSync(path.join(publicDirectory, filename));
    }
  }
  const summary = [];
  for (const output of outputs) {
    const outputPath = path.join(publicDirectory, output.filename);
    fs.writeFileSync(outputPath, output.html, 'utf8');
    const outputBytes = Buffer.byteLength(output.html);
    summary.push({
      locale: output.locale, output: path.relative(root, outputPath), outputBytes,
      inputBytes: Buffer.byteLength(source), reductionBytes: Buffer.byteLength(source) - outputBytes,
      runtimeMinifierBytes: 0, runtimeRestoreCodeBytes: 0
    });
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { buildMinifiedHtml, buildAllMinifiedHtml, localizeHtml };
