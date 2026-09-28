/** Usage: node scripts/rasterize-icons.cjs to regenerate all SVG and PNG assets */
const { chromium } = require("../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const brandDir = path.join(__dirname, "../packages/ui-tokens/assets/brand");
fs.mkdirSync(brandDir, { recursive: true });

const ink = "#1C1A17";
const paper = "#FFFFFF";

function writeSvg(name, content) {
  fs.writeFileSync(path.join(brandDir, name), content);
}

const markInner = `<path fill="currentColor" d="M298 74.5L306.6 78.9L314.9 83.9L322.8 89.6L330.4 96L337.5 102.9L343.9 110.5L348.9 119.1L353.2 128L357 137.2L360.1 146.5L362.8 156.1L364.8 165.7L366.4 175.4L367.4 185.2L367.9 195.1L367.9 204.9L367.4 214.7L366.4 224.5L364.9 234.2L362.8 243.9L360.2 253.4L357 262.8L353.2 271.9L348.7 280.8L343.7 289.3L338 297.4L331.8 305.1L325 312.3L317.8 318.9L310 324.9L301.9 330.4L293.5 335.2L284.8 339.4L275.9 343L266.9 346.1L257.8 348.6L248.6 350.6L239.5 352.2L230.3 353.3L221.2 354.1L212.1 354.5L203 354.5L194 354.3L185 353.6L176 352.7L167 351.3L158.1 349.6L149.3 347.4L140.5 344.7L131.8 341.6L123.4 337.9L115.1 333.7L107.1 328.9L99.4 323.6L92.1 317.8L85.2 311.5L78.7 304.7L72.7 297.5L67.2 289.9L62.1 282L57.6 273.8L53.5 265.3L49.9 256.7L46.7 247.8L44 238.8L41.7 229.7L39.8 220.4L38.3 211.1L37.3 201.6L37.4 192.1L38.1 182.6L39.3 173.1L41 163.7L43.3 154.4L46.1 145.3L49.6 136.4L53.6 127.7L58.2 119.4L63.5 111.4L69.4 103.9L75.7 96.9L82.6 90.4L90 84.5L97.7 79.2L105.8 74.5L114.1 70.4L122.6 66.9L131.2 63.9L139.8 61.5L148.5 59.5L157.2 58L165.9 56.9L174.5 56.1L183 55.5L191.5 55.1L200 55.2L200 56.4L191.6 56.3L183.1 56.6L174.7 57.3L166.3 58.5L157.9 60.3L149.6 62.5L141.4 65.1L133.4 68.3L125.5 71.9L117.9 76.1L110.6 80.8L103.6 86.1L97 91.9L91 98.2L85.4 104.9L80.5 112.1L76.1 119.6L72.4 127.4L69.3 135.5L66.9 143.7L65 152L63.8 160.4L63.1 168.8L62.9 177.1L63.2 185.3L63.9 193.4L64.9 201.3L65.6 209.2L66.6 217L68 224.8L69.7 232.4L71.7 240L74.2 247.5L77 254.9L80.3 262L84 269L88.1 275.8L92.7 282.2L97.7 288.3L103.2 294.1L109 299.4L115.2 304.2L121.7 308.6L128.6 312.5L135.6 315.9L142.8 318.8L150.2 321.2L157.6 323.2L165.1 324.7L172.6 325.9L180.1 326.7L187.6 327.2L195 327.5L202.5 327.5L210 327.2L217.4 326.6L224.9 325.8L232.3 324.7L239.8 323.2L247.2 321.4L254.6 319.2L261.9 316.6L269.1 313.5L276.1 310L282.8 305.9L289.3 301.4L295.4 296.3L301.1 290.8L306.4 284.9L311.3 278.5L315.6 271.8L319.4 264.8L322.7 257.6L325.5 250.2L327.9 242.6L329.7 235L331.1 227.2L332.2 219.5L332.8 211.7L333.1 203.9L333 196.1L332.5 188.3L331.7 180.6L330.6 172.8L329 165.2L327.1 157.6L324.7 150.1L321.8 142.8L318.5 135.6L314.7 128.6L311.3 121.4L307.5 114.2L303.2 107.3L298.3 100.7L292.9 94.5L286.9 88.7Z"></path>`;
const markInk = `<svg viewBox="0 0 400 400" aria-hidden="true" style="color: ${ink}" xmlns="http://www.w3.org/2000/svg">${markInner}</svg>`;
const markPaper = `<svg viewBox="0 0 400 400" aria-hidden="true" style="color: ${paper}" xmlns="http://www.w3.org/2000/svg">${markInner}</svg>`;
const wordmarkInk = `<svg viewBox="0 0 160 50" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><text x="0" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${ink}" letter-spacing="-0.02em">Ardur</text></svg>`;
const wordmarkPaper = `<svg viewBox="0 0 160 50" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><text x="0" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${paper}" letter-spacing="-0.02em">Ardur</text></svg>`;
const lockupInk = `<svg viewBox="0 0 200 50" aria-hidden="true" style="color: ${ink}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0, 8) scale(0.085)">${markInner}</g><text x="44" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${ink}" letter-spacing="-0.02em">Ardur</text></svg>`;
const lockupPaper = `<svg viewBox="0 0 200 50" aria-hidden="true" style="color: ${paper}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0, 8) scale(0.085)">${markInner}</g><text x="44" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${paper}" letter-spacing="-0.02em">Ardur</text></svg>`;

writeSvg("mark-ink.svg", markInk);
writeSvg("mark-paper.svg", markPaper);
writeSvg("wordmark-ink.svg", wordmarkInk);
writeSvg("wordmark-paper.svg", wordmarkPaper);
writeSvg("lockup-ink.svg", lockupInk);
writeSvg("lockup-paper.svg", lockupPaper);

const html = `<!DOCTYPE html><html><head><style>body{margin:0;padding:0;background:transparent;}.box{display:inline-block;}</style></head><body>
<div id="favicon-16" class="box" style="width: 16px; height: 16px; background: transparent; color: ${ink};"><svg viewBox="0 0 400 400" width="100%" height="100%"><path fill="none" stroke="currentColor" stroke-width="80" stroke-linecap="round" d="M 300 120 A 150 150 0 1 0 334 296"></path></svg></div>
<div id="favicon-32" class="box" style="width: 32px; height: 32px; background: transparent; color: ${ink};"><svg viewBox="0 0 400 400" width="100%" height="100%"><path fill="none" stroke="currentColor" stroke-width="44" stroke-linecap="round" d="M 318 104 A 150 150 0 1 0 334 296"></path><rect x="318" y="118" width="48" height="232" rx="24" fill="currentColor"></rect></svg></div>
<div id="favicon-48" class="box" style="width: 48px; height: 48px; background: transparent; color: ${ink};"><svg viewBox="0 0 400 400" width="100%" height="100%"><path fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path><rect x="322" y="118" width="40" height="232" rx="20" fill="currentColor"></rect></svg></div>
<div id="favicon-64" class="box" style="width: 64px; height: 64px; background: transparent; color: ${ink};"><svg viewBox="0 0 400 400" width="100%" height="100%"><path fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path><rect x="322" y="118" width="40" height="232" rx="20" fill="currentColor"></rect></svg></div>
<div id="notification-icon" class="box" style="width: 96px; height: 96px; background: transparent; color: ${paper}; display: flex; align-items: center; justify-content: center;"><svg viewBox="0 0 400 400" width="100%" height="100%"><path fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path><rect x="322" y="118" width="38" height="232" rx="19" fill="currentColor"></rect></svg></div>
<div id="tray-icon" class="box" style="width: 1024px; height: 1024px; background: transparent; color: ${ink}; position: relative;"><div style="position: absolute; top: 102px; left: 102px; width: 820px; height: 820px;"><svg viewBox="0 0 400 400" width="100%" height="100%"><path fill="none" stroke="currentColor" stroke-width="56" stroke-linecap="round" d="M 312 110 A 150 150 0 1 0 334 296"></path><rect x="312" y="120" width="60" height="230" rx="30" fill="currentColor"></rect></svg></div></div>
<div id="app-icon-web" class="box" style="width: 1024px; height: 1024px; background: ${paper}; color: ${ink}; display: flex; align-items: center; justify-content: center;"><div style="width: 742px; height: 742px;"><svg viewBox="0 0 400 400" width="100%" height="100%">${markInner}</svg></div></div>
<div id="app-icon-native" class="box" style="width: 1024px; height: 1024px; background: #9A3B1E; color: ${paper}; display: flex; align-items: center; justify-content: center;"><div style="width: 742px; height: 742px;"><svg viewBox="0 0 400 400" width="100%" height="100%">${markInner}</svg></div></div>
<div id="adaptive-icon" class="box" style="width: 1024px; height: 1024px; background: transparent; color: ${paper}; position: relative;"><div style="position: absolute; top: 102px; left: 102px; width: 820px; height: 820px;"><svg viewBox="0 0 400 400" width="100%" height="100%">${markInner}</svg></div></div>
<div id="monochrome-icon" class="box" style="width: 1024px; height: 1024px; background: transparent; color: ${paper}; position: relative;"><div style="position: absolute; top: 102px; left: 102px; width: 820px; height: 820px;"><svg viewBox="0 0 400 400" width="100%" height="100%">${markInner}</svg></div></div>
<div id="icon-background" class="box" style="width: 1024px; height: 1024px; background: #0B0C0E;"></div>
</body></html>`;

async function render() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html);

  async function snap(selector, dest, width, height, omitBackground = false) {
    const el = await page.$(selector);
    if (width && height) {
      await el.evaluate(
        (node, dims) => {
          node.style.width = dims.w + "px";
          node.style.height = dims.h + "px";
          if (node.querySelector("svg") && node.id.startsWith("app-icon")) {
            const innerDiv = node.querySelector("div");
            if (innerDiv) {
              innerDiv.style.width = Math.round(dims.w * 0.724) + "px";
              innerDiv.style.height = Math.round(dims.h * 0.724) + "px";
            }
          }
        },
        { w: width, h: height },
      );
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await el.screenshot({ path: dest, omitBackground });
  }

  await snap("#favicon-16", "apps/web/public/favicon-16x16.png", null, null, true);
  await snap("#favicon-32", "apps/web/public/favicon-32x32.png", null, null, true);
  await snap("#favicon-16", "apps/www/public/favicon-16x16.png", null, null, true);
  await snap("#favicon-32", "apps/www/public/favicon-32x32.png", null, null, true);
  await snap("#app-icon-web", "apps/web/public/apple-touch-icon.png", 180, 180, false);
  await snap("#app-icon-web", "apps/web/public/icon-192.png", 192, 192, false);
  await snap("#app-icon-web", "apps/web/public/icon-512.png", 512, 512, false);
  await snap("#app-icon-web", "apps/www/public/apple-touch-icon.png", 180, 180, false);
  await snap("#app-icon-web", "apps/www/public/icon-192.png", 192, 192, false);
  await snap("#app-icon-web", "apps/www/public/icon-512.png", 512, 512, false);
  await snap("#app-icon-native", "apps/desktop/assets/icon.png", 1024, 1024, false);
  await snap("#app-icon-native", "apps/desktop/assets/icon-macos.png", 1024, 1024, false);
  await snap("#tray-icon", "apps/desktop/assets/tray.png", 1024, 1024, true);
  await snap("#app-icon-native", "apps/mobile/assets/icon.png", 1024, 1024, false);
  await snap("#app-icon-native", "apps/mobile/assets/splash-icon.png", 1024, 1024, false);
  await snap("#adaptive-icon", "apps/mobile/assets/adaptive-icon.png", 1024, 1024, true);
  await snap("#monochrome-icon", "apps/mobile/assets/monochrome-icon.png", 1024, 1024, true);
  await snap("#icon-background", "apps/mobile/assets/icon-background.png", 1024, 1024, false);
  await snap("#favicon-48", "apps/mobile/assets/favicon.png", 48, 48, true);
  await snap("#notification-icon", "apps/mobile/assets/notification-icon.png", 96, 96, true);

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

  async function sampleSnap(selector, name, width, height) {
    const el = await samplePage.$(selector);
    if (width && height) {
      await el.evaluate(
        (node, dims) => {
          node.style.width = dims.w + "px";
          node.style.height = dims.h + "px";
          if (node.querySelector("svg") && node.id.startsWith("app-icon")) {
            const innerDiv = node.querySelector("div");
            if (innerDiv) {
              innerDiv.style.width = Math.round(dims.w * 0.724) + "px";
              innerDiv.style.height = Math.round(dims.h * 0.724) + "px";
            }
          }
        },
        { w: width, h: height },
      );
    }
    await el.screenshot({ path: path.join(rendersDir, name), omitBackground: true });
  }

  await sampleSnap("#favicon-16", "16.png", 16, 16);
  await sampleSnap("#favicon-32", "32.png", 32, 32);
  await sampleSnap("#favicon-64", "64.png", 64, 64);
  await sampleSnap("#app-icon-web", "160.png", 160, 160);

  await sampleBrowser.close();
}
render().catch(console.error);
