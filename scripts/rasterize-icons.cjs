const { chromium } = require("../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const brandDir = path.join(__dirname, "../packages/ui-tokens/assets/brand");
fs.mkdirSync(brandDir, { recursive: true });

const ink = "#1C1A17";
const paper = "#F6F3EC";
const clay = "#9A3B1E";

function writeSvg(name, content) {
  fs.writeFileSync(path.join(brandDir, name), content);
}

const svg3 = `<path fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path><rect x="322" y="118" width="38" height="232" rx="19" fill="currentColor"></rect>`;
const svg4 = `<path fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path><rect x="322" y="118" width="40" height="232" rx="20" fill="currentColor"></rect>`;
const svg5 = `<path fill="none" stroke="currentColor" stroke-width="44" stroke-linecap="round" d="M 318 104 A 150 150 0 1 0 334 296"></path><rect x="318" y="118" width="48" height="232" rx="24" fill="currentColor"></rect>`;
const svg6 = `<path fill="none" stroke="currentColor" stroke-width="56" stroke-linecap="round" d="M 312 110 A 150 150 0 1 0 334 296"></path><rect x="312" y="120" width="60" height="230" rx="30" fill="currentColor"></rect>`;
const svg7 = `<path fill="none" stroke="currentColor" stroke-width="80" stroke-linecap="round" d="M 300 120 A 150 150 0 1 0 334 296"></path>`;
const svg8 = svg5; // 44 stroke

const markInner = svg4; // SVG 10 geometry (stroke 36)

const markInk = `<svg viewBox="0 0 400 400" aria-hidden="true" style="color: ${ink}" xmlns="http://www.w3.org/2000/svg">${markInner}</svg>`;
const markPaper = `<svg viewBox="0 0 400 400" aria-hidden="true" style="color: ${paper}" xmlns="http://www.w3.org/2000/svg">${markInner}</svg>`;
const wordmarkInk = `<svg viewBox="0 0 160 50" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><text x="0" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${ink}" letter-spacing="-0.02em">Ardur</text></svg>`;
const wordmarkPaper = `<svg viewBox="0 0 160 50" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><text x="0" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${paper}" letter-spacing="-0.02em">Ardur</text></svg>`;

// "at cap height left of the Instrument Serif wordmark with one mark-width of space"
// Scale 0.085 means the mark is 400 * 0.085 = 34px wide.
// Text starts at 34 + 34 = 68.
const lockupInk = `<svg viewBox="0 0 228 50" aria-hidden="true" style="color: ${ink}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0, 8) scale(0.085)">${markInner}</g><text x="68" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${ink}" letter-spacing="-0.02em">Ardur</text></svg>`;
const lockupPaper = `<svg viewBox="0 0 228 50" aria-hidden="true" style="color: ${paper}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0, 8) scale(0.085)">${markInner}</g><text x="68" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${paper}" letter-spacing="-0.02em">Ardur</text></svg>`;

writeSvg("mark-ink.svg", markInk);
writeSvg("mark-paper.svg", markPaper);
writeSvg("wordmark-ink.svg", wordmarkInk);
writeSvg("wordmark-paper.svg", wordmarkPaper);
writeSvg("lockup-ink.svg", lockupInk);
writeSvg("lockup-paper.svg", lockupPaper);

function appIcon(id, size, svgContext, isAdaptive = false) {
  const radius = Math.round(size * 0.225);
  const bg = isAdaptive ? "transparent" : clay;
  const br = isAdaptive ? "0" : radius + "px";
  return `<div id="${id}" class="box" style="width: ${size}px; height: ${size}px; background: ${bg}; border-radius: ${br}; color: ${paper}; display: flex; align-items: center; justify-content: center;"><svg viewBox="0 0 400 400" style="width: 72.5%; height: 72.5%;">${svgContext}</svg></div>`;
}

function monochromeIcon(id, size, svgContext) {
  // Monochrome: black with alpha for macOS template images, no tile.
  return `<div id="${id}" class="box" style="width: ${size}px; height: ${size}px; background: transparent; color: #000000; display: flex; align-items: center; justify-content: center;"><svg viewBox="0 0 400 400" width="100%" height="100%">${svgContext}</svg></div>`;
}

const html = `<!DOCTYPE html><html><head><style>body{margin:0;padding:0;background:transparent;}.box{display:inline-block;}</style></head><body>
${appIcon("favicon-16", 16, svg7)}
${appIcon("favicon-32", 32, svg6)}
${appIcon("favicon-48", 48, svg5)}
${appIcon("favicon-64", 64, svg5)}
${appIcon("icon-96", 96, svg4)}
${appIcon("icon-128", 128, svg3)}
${appIcon("icon-160", 160, svg3)}
${appIcon("icon-180", 180, svg3)}
${appIcon("icon-192", 192, svg3)}
${appIcon("icon-256", 256, svg3)}
${appIcon("icon-512", 512, svg3)}
${appIcon("icon-1024", 1024, svg3)}
${appIcon("adaptive-icon", 1024, svg3, true)}

<div id="notification-icon" class="box" style="width: 96px; height: 96px; background: transparent; color: ${paper}; display: flex; align-items: center; justify-content: center;"><svg viewBox="0 0 400 400" width="100%" height="100%">${svg4}</svg></div>
${monochromeIcon("tray-icon", 1024, svg8)}
${monochromeIcon("monochrome-icon", 1024, svg3)}
<div id="icon-background" class="box" style="width: 1024px; height: 1024px; background: ${clay};"></div>
</body></html>`;

async function render() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html);

  async function snap(selector, dest, width, height, omitBackground = false) {
    const el = await page.$(selector);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await el.screenshot({ path: dest, omitBackground });
  }

  await snap("#favicon-16", "apps/web/public/favicon-16x16.png", null, null, true);
  await snap("#favicon-32", "apps/web/public/favicon-32x32.png", null, null, true);
  await snap("#favicon-16", "apps/www/public/favicon-16x16.png", null, null, true);
  await snap("#favicon-32", "apps/www/public/favicon-32x32.png", null, null, true);

  await snap("#icon-180", "apps/web/public/apple-touch-icon.png", null, null, true);
  await snap("#icon-192", "apps/web/public/icon-192.png", null, null, true);
  await snap("#icon-512", "apps/web/public/icon-512.png", null, null, true);

  await snap("#icon-180", "apps/www/public/apple-touch-icon.png", null, null, true);
  await snap("#icon-192", "apps/www/public/icon-192.png", null, null, true);
  await snap("#icon-512", "apps/www/public/icon-512.png", null, null, true);

  await snap("#icon-1024", "apps/desktop/assets/icon.png", null, null, true);
  await snap("#icon-1024", "apps/desktop/assets/icon-macos.png", null, null, true);

  // Tray icon is monochrome black for macos Template
  await snap("#tray-icon", "apps/desktop/assets/trayTemplate.png", null, null, true);

  // Clean up old tray.png if it exists
  if (fs.existsSync("apps/desktop/assets/tray.png")) {
    fs.unlinkSync("apps/desktop/assets/tray.png");
  }

  await snap("#icon-1024", "apps/mobile/assets/icon.png", null, null, true);
  await snap("#icon-1024", "apps/mobile/assets/splash-icon.png", null, null, true);
  await snap("#adaptive-icon", "apps/mobile/assets/adaptive-icon.png", null, null, true);

  // "monochrome: black with alpha for macOS template images (*Template.png so macOS tints them), no tile"
  // Let's use #monochrome-icon (which is monochromeIcon helper) but it should be named appropriately if it's meant for Android monochrome
  // The spec says "monochrome: black with alpha for macOS template images (*Template.png so macOS tints them), no tile."
  // Wait, Expo's monochrome icon might be for Android. Android monochrome icons are just flat svgs or pngs.
  // The previous code had "apps/mobile/assets/monochrome-icon.png". Android monochrome icons are usually one color.
  await snap("#monochrome-icon", "apps/mobile/assets/monochrome-icon.png", null, null, true);
  await snap("#icon-background", "apps/mobile/assets/icon-background.png", null, null, false);

  await snap("#favicon-48", "apps/mobile/assets/favicon.png", null, null, true);
  await snap("#notification-icon", "apps/mobile/assets/notification-icon.png", null, null, true);

  await browser.close();

  execSync(
    "sips -s format ico apps/web/public/favicon-32x32.png --out apps/web/public/favicon.ico",
  );
  execSync(
    "sips -s format ico apps/www/public/favicon-32x32.png --out apps/www/public/favicon.ico",
  );
  execSync(
    "sips -s format ico -z 256 256 apps/desktop/assets/icon.png --out apps/desktop/assets/icon.ico",
  );

  const rendersDir = "/Users/nutakki/repos/ardur-bot-wt/.work/sessions/mark-renders/";
  fs.mkdirSync(rendersDir, { recursive: true });

  const sampleBrowser = await chromium.launch();
  const samplePage = await sampleBrowser.newPage();
  await samplePage.setContent(html);

  async function sampleSnap(selector, name) {
    const el = await samplePage.$(selector);
    await el.screenshot({ path: path.join(rendersDir, name), omitBackground: true });
  }

  await sampleSnap("#favicon-16", "16.png");
  await sampleSnap("#favicon-32", "32.png");
  await sampleSnap("#favicon-48", "48.png");
  await sampleSnap("#icon-96", "96.png");
  await sampleSnap("#icon-160", "160.png");
  await sampleSnap("#icon-1024", "1024.png");

  await sampleBrowser.close();
}
render().catch(console.error);
