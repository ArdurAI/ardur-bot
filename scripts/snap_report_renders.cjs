const { chromium } = require('./node_modules/.pnpm/playwright@1.63.0/node_modules/playwright');
const path = require('path');
async function render() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${path.join(__dirname, 'render-icons.html')}`);
  async function snap(selector, dest, width, height) {
    const el = await page.$(selector);
    await el.evaluate((node, dims) => {
      node.style.width = dims.w + 'px';
      node.style.height = dims.h + 'px';
    }, { w: width, h: height });
    await el.screenshot({ path: dest, omitBackground: true });
  }
  await snap('#favicon-16', 'report-16.png', 16, 16);
  await snap('#favicon-32', 'report-32.png', 32, 32);
  await snap('#favicon-32', 'report-64.png', 64, 64);
  await browser.close();
}
render().catch(console.error);
