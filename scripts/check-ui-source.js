'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function checkCss(source, label) {
  let depth = 0;
  let quote = '';
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      if (char === '*' && next === '/') {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '*') {
      comment = true;
      index += 1;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth < 0) throw new SyntaxError(`${label}: unexpected closing brace at offset ${index}`);
    }
  }
  if (comment) throw new SyntaxError(`${label}: unclosed comment`);
  if (quote) throw new SyntaxError(`${label}: unclosed string`);
  if (depth !== 0) throw new SyntaxError(`${label}: ${depth} unclosed block(s)`);
}

const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
let styleMatch;
let styleCount = 0;
while ((styleMatch = stylePattern.exec(html))) {
  styleCount += 1;
  checkCss(styleMatch[1], `index.html inline style ${styleCount}`);
}

const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let scriptMatch;
let inlineCount = 0;
let externalCount = 0;
while ((scriptMatch = scriptPattern.exec(html))) {
  const attributes = scriptMatch[1] || '';
  const sourceMatch = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  if (sourceMatch) {
    const sourcePath = sourceMatch[1].split(/[?#]/, 1)[0];
    if (/^(?:[a-z]+:)?\/\//i.test(sourcePath)) continue;
    const resolved = path.resolve(path.dirname(htmlPath), sourcePath);
    if (!resolved.startsWith(path.dirname(htmlPath) + path.sep)) {
      throw new Error(`External script escapes public directory: ${sourcePath}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`Missing external script: ${sourcePath}`);
    if (!sourcePath.startsWith('vendor/')) {
      new vm.Script(fs.readFileSync(resolved, 'utf8'), { filename: resolved });
    }
    externalCount += 1;
    continue;
  }
  const typeMatch = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i);
  const type = typeMatch ? typeMatch[1].toLowerCase() : '';
  if (type && type !== 'text/javascript' && type !== 'application/javascript' && type !== 'module') continue;
  inlineCount += 1;
  new vm.Script(scriptMatch[2], { filename: `${htmlPath}:inline-${inlineCount}` });
}

if (!styleCount || !inlineCount) throw new Error('Expected inline UI sources were not found');
console.log(`UI source check passed: ${styleCount} style block(s), ${inlineCount} inline script(s), ${externalCount} local script reference(s)`);
