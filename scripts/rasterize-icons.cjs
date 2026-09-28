const { chromium } = require('../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright');
const path = require('path');
const fs = require('fs');

async function render() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${path.join(__dirname, 'render-icons.html')}`);

  async function snap(selector, dest, width, height, omitBackground = false) {
    const el = await page.$(selector);
    if (width && height) {
      await el.evaluate((node, dims) => {
        node.style.width = dims.w + 'px';
        node.style.height = dims.h + 'px';
        if (node.querySelector('svg') && node.id === 'app-icon') {
            node.querySelector('svg').setAttribute('width', Math.round(dims.w * 0.724));
            node.querySelector('svg').setAttribute('height', Math.round(dims.h * 0.724));
        }
      }, { w: width, h: height });
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await el.screenshot({ path: dest, omitBackground });
    console.log(`Rendered ${dest}`);
  }

  await snap('#favicon-16', 'apps/web/public/favicon-16x16.png', null, null, true);
  await snap('#favicon-32', 'apps/web/public/favicon-32x32.png', null, null, true);
  await snap('#app-icon', 'apps/web/public/apple-touch-icon.png', 180, 180, false);
  await snap('#app-icon', 'apps/web/public/icon-192.png', 192, 192, false);
  await snap('#app-icon', 'apps/web/public/icon-512.png', 512, 512, false);
  await snap('#favicon-16', 'apps/www/public/favicon-16x16.png', null, null, true);
  await snap('#favicon-32', 'apps/www/public/favicon-32x32.png', null, null, true);
  await snap('#app-icon', 'apps/www/public/apple-touch-icon.png', 180, 180, false);
  await snap('#app-icon', 'apps/www/public/icon-192.png', 192, 192, false);
  await snap('#app-icon', 'apps/www/public/icon-512.png', 512, 512, false);
  await snap('#app-icon', 'apps/desktop/assets/icon.png', 1024, 1024, false);
  await snap('#app-icon', 'apps/desktop/assets/icon-macos.png', 1024, 1024, false);
  await snap('#app-icon', 'apps/mobile/assets/icon.png', 1024, 1024, false);
  await snap('#app-icon', 'apps/mobile/assets/splash-icon.png', 1024, 1024, false);
  await snap('#adaptive-icon', 'apps/mobile/assets/adaptive-icon.png', 1024, 1024, true);
  await snap('#monochrome-icon', 'apps/mobile/assets/monochrome-icon.png', 1024, 1024, true);
  await snap('#icon-background', 'apps/mobile/assets/icon-background.png', 1024, 1024, false);
  await snap('#favicon-32', 'apps/mobile/assets/favicon.png', 48, 48, true);
  await snap('#notification-icon', 'apps/mobile/assets/notification-icon.png', 96, 96, true);

  await browser.close();
}

render().catch(console.error);
