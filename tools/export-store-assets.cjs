const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const outputDir = path.resolve('D:/Projects/moneytree/store-graphics');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function exportAssets() {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 1400, height: 2600 }
  });
  const page = await context.newPage();

  const fileUrl = 'https://chikatistudio.com/vitta-vriksha/store-assets.html';
  console.log('Loading:', fileUrl);
  await page.goto(fileUrl, { waitUntil: 'networkidle' });

  // 1. Capture Feature Graphic (1024x500)
  const featureBanner = await page.$('.feature-banner-box');
  if (featureBanner) {
    console.log('Capturing Feature Graphic...');
    await featureBanner.screenshot({
      path: path.join(outputDir, 'google_play_feature_graphic_1024x500.png')
    });
  }

  // 2. Capture Each Screen Card
  const screenCards = await page.$$('.screen-card');
  const names = [
    '01_track_net_worth',
    '02_cas_portfolio_intelligence',
    '03_sms_expense_heatmap',
    '04_fire_freedom_planner',
    '05_private_offline_vault'
  ];

  for (let i = 0; i < screenCards.length; i++) {
    const card = screenCards[i];
    const name = names[i] || `screen_${i + 1}`;
    console.log(`Capturing screen ${i + 1}: ${name}...`);
    
    // Screenshot promo card
    await card.screenshot({
      path: path.join(outputDir, `store_promo_${name}.png`)
    });

    // Screenshot phone frame alone
    const phone = await card.$('.phone-frame');
    if (phone) {
      await phone.screenshot({
        path: path.join(outputDir, `phone_mockup_${name}.png`)
      });
    }
  }

  // 3. App Icon
  const iconSource = path.resolve('D:/Projects/ChikatiStudio/site/assets/vittavriksha-icon.png');
  if (fs.existsSync(iconSource)) {
    fs.copyFileSync(iconSource, path.join(outputDir, 'app_icon_512x512.png'));
  }

  await browser.close();
  console.log('Done! All assets exported to:', outputDir);
}

exportAssets().catch(err => {
  console.error('Error in exportAssets:', err);
  process.exit(1);
});
