import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('D:/Projects/ChikatiStudio/tests-e2e/node_modules/playwright');

const SCREENSHOT_DIR = 'C:/Users/sagar/.gemini/antigravity/brain/60fb5097-3ca8-4f03-a626-d1ec5d8e6223/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: 'iphone-se', width: 375, height: 667, isMobile: true, hasTouch: true },
  { name: 'iphone-15', width: 393, height: 852, isMobile: true, hasTouch: true },
  { name: 'ipad-portrait', width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: 'ipad-landscape', width: 1024, height: 768, isMobile: true, hasTouch: true },
  { name: 'desktop-standard', width: 1280, height: 800, isMobile: false, hasTouch: false },
  { name: 'desktop-wide', width: 1440, height: 900, isMobile: false, hasTouch: false },
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  console.log('Testing responsive layout across viewports...');

  const results = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    const consoleLogs = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleLogs.push(msg.text());
    });

    await page.goto('http://localhost:8080', { waitUntil: 'networkidle' });

    // Wait for the main elements to render
    await page.waitForTimeout(500);

    // Check for horizontal overflow
    const overflowCheck = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      const bodyWidth = document.body.scrollWidth;
      const viewEl = document.getElementById('view');
      const viewScrollWidth = viewEl ? viewEl.scrollWidth : 0;
      const viewClientWidth = viewEl ? viewEl.clientWidth : 0;

      // Find overflowing elements
      const allEls = Array.from(document.querySelectorAll('*'));
      const overflowingEls = [];
      for (const el of allEls) {
        const rect = el.getBoundingClientRect();
        if (rect.right > docWidth + 1) {
          overflowingEls.push({
            tag: el.tagName,
            className: el.className,
            id: el.id,
            right: rect.right,
            docWidth,
          });
        }
      }

      return {
        hasBodyOverflow: bodyWidth > docWidth + 1,
        bodyWidth,
        docWidth,
        viewScrollWidth,
        viewClientWidth,
        overflowCount: overflowingEls.length,
        overflowingEls: overflowingEls.slice(0, 5),
      };
    });

    const shotPath = path.join(SCREENSHOT_DIR, `${vp.name}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });

    results.push({
      viewport: vp.name,
      size: `${vp.width}x${vp.height}`,
      overflowCheck,
      consoleErrors: consoleLogs,
      screenshot: shotPath,
    });

    await context.close();
  }

  await browser.close();

  console.log('\n--- Responsive Audit Results ---');
  console.log(JSON.stringify(results, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
