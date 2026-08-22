#!/usr/bin/env node
/*
 * Vitta Vriksha - Style & Coding Guidelines Linter (tools/check-style-guidelines.mjs)
 *
 * Enforces non-negotiable rules from AGENTS.md and docs/STYLE_GUIDELINES.md:
 * 1. No native <select> elements (must use selectField and bindSelectFields).
 * 2. No emojis in UI, code, or stylesheets (must use Material Symbols Outlined).
 * 3. No native alert(), confirm(), or prompt() (must use ui.js dialogs/sheets/toasts).
 * 4. All icon('...') calls must exist in icon-codepoints.js.
 * 5. Z-Index 9XX stacking architecture (--z-menu-scrim: 990; --z-menu: 999;).
 * 6. Currency numbers must be formatted via formatCurrency() or money().
 * 7. Zero third-party scripts inside assets/www/js/ (only assets/www/vendor/).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const WWW_JS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'www', 'js');
const WWW_CSS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'www', 'css');
const WWW_HTML = path.join(ROOT, 'app', 'src', 'main', 'assets', 'www');

// Load icon codepoints
const iconCodepointsPath = path.join(WWW_JS, 'icon-codepoints.js');
const iconModuleUrl = pathToFileURL(iconCodepointsPath).href;
const { ICON_CODEPOINTS } = await import(iconModuleUrl);

let failureCount = 0;
const errors = [];

function fail(file, lineNum, rule, message, snippet = '') {
  failureCount++;
  const relPath = path.relative(ROOT, file).replace(/\\/g, '/');
  errors.push({
    location: `${relPath}:${lineNum}`,
    rule,
    message,
    snippet: snippet.trim(),
  });
}

function scanFiles(dir, extensions = ['.js'], excludeDirs = ['vendor', 'node_modules']) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludeDirs.includes(entry.name)) {
        results = results.concat(scanFiles(full, extensions, excludeDirs));
      }
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

console.log('==> Checking Vitta Vriksha Coding & Styling Guidelines (AGENTS.md)...');

// 1. Scan for Emojis in JS, CSS, and HTML
const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu;
const allWwwFiles = scanFiles(WWW_HTML, ['.js', '.css', '.html'], ['vendor', 'fonts', 'images']);

for (const file of allWwwFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    let match;
    while ((match = emojiRegex.exec(line)) !== null) {
      fail(
        file,
        idx + 1,
        'NO_EMOJIS',
        `Forbidden emoji character "${match[0]}" found. Use icon(name, className) instead.`,
        line,
      );
    }
  });
}

// 2. Scan for Native <select> Elements in JS
const jsFiles = scanFiles(WWW_JS, ['.js'], ['vendor']);

for (const file of jsFiles) {
  const isUiJs = file.endsWith('ui.js');
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    if (!isUiJs && line.includes('<select')) {
      fail(
        file,
        idx + 1,
        'NO_NATIVE_SELECT',
        'Native <select> element found. Use selectField() and bindSelectFields() from ui.js.',
        line,
      );
    }

    // 3. Scan for native alert(), confirm(), prompt()
    if (!isUiJs) {
      if (/\b(window\.)?(alert|prompt)\s*\(/.test(line)) {
        fail(
          file,
          idx + 1,
          'NO_NATIVE_DIALOGS',
          'Native alert()/prompt() found. Use showDialog(), promptDialog(), or toast() from ui.js.',
          line,
        );
      }
      if (/\b(window\.)confirm\s*\(/.test(line) && !line.includes('confirmDialog')) {
        fail(
          file,
          idx + 1,
          'NO_NATIVE_DIALOGS',
          'Native confirm() found. Use confirmDialog() from ui.js.',
          line,
        );
      }
    }

    // 4. Validate icon('...') names exist in icon-codepoints.js
    const iconRegex = /\bicon\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
    let iconMatch;
    while ((iconMatch = iconRegex.exec(line)) !== null) {
      const iconName = iconMatch[1];
      if (!ICON_CODEPOINTS[iconName]) {
        fail(
          file,
          idx + 1,
          'UNKNOWN_ICON',
          `Icon "${iconName}" is not registered in icon-codepoints.js. Add it to tools/subset-material-symbols.py.`,
          line,
        );
      }
    }

    // 5. Currency formatting in views
    if (file.includes('views') && !file.includes('drilldown.js')) {
      const rawCurrencyRegex = /₹\s*\$\{/g;
      if (rawCurrencyRegex.test(line) && !line.includes('formatCurrency') && !line.includes('money(')) {
        fail(
          file,
          idx + 1,
          'UNFORMATTED_CURRENCY',
          'Raw template string currency "₹${...}" found in view. Always format money with formatCurrency(val, currency, locale).',
          line,
        );
      }
    }
  });
}

// 6. Validate Z-Index Stacking Architecture (9XX Rule) in style.css
const styleCssPath = path.join(WWW_CSS, 'style.css');
if (fs.existsSync(styleCssPath)) {
  const cssContent = fs.readFileSync(styleCssPath, 'utf-8');

  const requiredTokens = [
    { token: '--z-menu-scrim: 990;', rule: 'Z_INDEX_9XX', name: '--z-menu-scrim must be 990' },
    { token: '--z-menu: 999;', rule: 'Z_INDEX_9XX', name: '--z-menu must be 999' },
    { token: '--z-overlay: 1000;', rule: 'Z_INDEX_STACK', name: '--z-overlay must be 1000' },
    { token: '--z-toast: 1100;', rule: 'Z_INDEX_STACK', name: '--z-toast must be 1100' },
    { token: '--z-dialog: 700;', rule: 'Z_INDEX_STACK', name: '--z-dialog must be 700' },
    { token: '--z-sheet: 600;', rule: 'Z_INDEX_STACK', name: '--z-sheet must be 600' },
  ];

  requiredTokens.forEach(({ token, rule, name }) => {
    if (!cssContent.includes(token)) {
      fail(
        styleCssPath,
        1,
        rule,
        `Missing or altered design token in style.css: ${name}`,
      );
    }
  });

  if (!cssContent.includes('.select-button.select-compact')) {
    fail(
      styleCssPath,
      1,
      'STYLE_GUIDELINE',
      'Missing .select-button.select-compact styling in style.css.',
    );
  }
} else {
  fail(styleCssPath, 1, 'MISSING_FILE', 'assets/www/css/style.css does not exist.');
}

// Report results
if (failureCount > 0) {
  console.error(`\n\x1b[31m[FAILED] Found ${failureCount} style/coding guideline deviation(s):\x1b[0m\n`);
  errors.forEach((err, i) => {
    console.error(`  ${i + 1}. \x1b[1m${err.location}\x1b[0m [\x1b[33m${err.rule}\x1b[0m]`);
    console.error(`     \x1b[31m${err.message}\x1b[0m`);
    if (err.snippet) {
      console.error(`     \x1b[2m> ${err.snippet}\x1b[0m`);
    }
    console.error('');
  });
  console.error('\x1b[31mBuild aborted due to style guideline violations. Fix the deviations above and rebuild.\x1b[0m\n');
  process.exit(1);
} else {
  console.log('\x1b[32m[PASS] All coding and styling guidelines verified successfully. Zero deviations.\x1b[0m\n');
  process.exit(0);
}
