import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('D:/Projects/ChikatiStudio/tests-e2e/node_modules/playwright');

const SCREENSHOT_DIR = 'C:/Users/sagar/.gemini/antigravity/brain/60fb5097-3ca8-4f03-a626-d1ec5d8e6223/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function enterPin(page, pin) {
  for (const digit of pin.split('')) {
    const key = page.locator(`button.key[data-key="${digit}"]`);
    if (await key.isVisible()) {
      await key.click();
      await page.waitForTimeout(80);
    }
  }
}

async function audit() {
  const browser = await chromium.launch({ headless: true });

  const viewports = [
    { name: 'mobile', width: 393, height: 852 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'desktop', width: 1440, height: 900 },
  ];

  for (const vp of viewports) {
    console.log(`Auditing ${vp.name} (${vp.width}x${vp.height})...`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto('http://localhost:8080');
    await page.waitForTimeout(500);

    // 1. Welcome / Setup or Lock
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-01-welcome.png`) });
    const getStarted = page.locator('button[data-next]');
    if (await getStarted.isVisible()) {
      await getStarted.click();
      await page.waitForTimeout(300);

      // 2. PIN setup: choose PIN 1234
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-02-choose-pin.png`) });
      await enterPin(page, '1234');
      await page.waitForTimeout(300);

      // 2b. Confirm PIN 1234
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-02b-confirm-pin.png`) });
      await enterPin(page, '1234');
      await page.waitForTimeout(600);

      // 3. Permissions step
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-03-permissions.png`) });
      const continueBtn = page.locator('button[data-next]');
      if (await continueBtn.isVisible()) {
        await continueBtn.click();
        await page.waitForTimeout(300);
      }

      // 4. Household step
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-04-household.png`) });
      const finishBtn = page.locator('button[data-next]');
      if (await finishBtn.isVisible()) {
        await finishBtn.click();
        await page.waitForTimeout(800);
      }
    } else {
      // If lock screen is shown, unlock with PIN 1234
      await enterPin(page, '1234');
      await page.waitForTimeout(600);
    }

    // 5. Home Screen
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-05-home.png`) });

    // 6. Open Transaction Sheet (#fab)
    const fab = page.locator('#fab');
    if (await fab.isVisible()) {
      await fab.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-06-sheet.png`) });

      // Close sheet by pressing Escape or clicking dismiss/cancel
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const dismissBtn = page.locator('.sheet.open [data-dismiss], .sheet.open [data-cancel]');
      if (await dismissBtn.count() > 0 && await dismissBtn.first().isVisible()) {
        await dismissBtn.first().click();
        await page.waitForTimeout(300);
      }
    }

    // 7. Ledger View
    const ledger = page.locator('.nav-item:has-text("Ledger")');
    if (await ledger.isVisible()) {
      await ledger.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-07-ledger.png`) });
    }

    // 8. Budgets View
    const budgets = page.locator('.nav-item:has-text("Budgets")');
    if (await budgets.isVisible()) {
      await budgets.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-08-budgets.png`) });
    }

    // 9. Wealth View
    const wealth = page.locator('.nav-item:has-text("Wealth")');
    if (await wealth.isVisible()) {
      await wealth.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-09-wealth.png`) });
    }

    // 10. More View
    const more = page.locator('.nav-item:has-text("More")');
    if (await more.isVisible()) {
      await more.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-10-more.png`) });
    }

    await context.close();
  }

  await browser.close();
  console.log('Audit completed successfully. All screenshots saved.');
}

audit().catch((err) => {
  console.error(err);
  process.exit(1);
});
