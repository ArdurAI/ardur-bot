const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");

// Playwright is a devDependency of the desktop app; @playwright/test re-exports
// the chromium browser type, so normal module resolution finds the browser.
const requireFromDesktop = createRequire(path.join(root, "apps", "desktop", "package.json"));
const { chromium } = require(requireFromDesktop.resolve("@playwright/test"));

const brandDir = path.join(root, "packages/ui-tokens/assets/brand");
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
  const br = isAdaptive ? "0" : `${radius}px`;
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

// A .ico file is a 6-byte header, one 16-byte directory entry per image, then the
// image payloads. Windows Vista and later read PNG-encoded entries directly.
function writeIco(dest, pngPaths) {
  const pngs = pngPaths.map((file) => fs.readFileSync(file));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  const parts = [header, entries];
  let offset = header.length + entries.length;
  pngs.forEach((png, i) => {
    const size = png.readUInt32BE(16); // width from the PNG IHDR chunk
    const dimension = size >= 256 ? 0 : size; // 0 means 256
    entries.writeUInt8(dimension, i * 16);
    entries.writeUInt8(dimension, i * 16 + 1);
    entries.writeUInt16LE(1, i * 16 + 4); // color planes
    entries.writeUInt16LE(32, i * 16 + 6); // bits per pixel
    entries.writeUInt32LE(png.length, i * 16 + 8);
    entries.writeUInt32LE(offset, i * 16 + 12);
    parts.push(png);
    offset += png.length;
  });
  fs.writeFileSync(dest, Buffer.concat(parts));
}

// electron-builder derives the packaged .icns itself; this keeps a reference
// .icns next to the samples for review. iconutil only exists on macOS.
function writeIcnsIfSupported(bySize, workDir) {
  if (process.platform !== "darwin") {
    console.log("Skipping icon.icns: iconutil is only available on macOS.");
    return;
  }
  const iconsetDir = path.join(workDir, "icon.iconset");
  fs.mkdirSync(iconsetDir, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    fs.copyFileSync(bySize.get(size), path.join(iconsetDir, `icon_${size}x${size}.png`));
    fs.copyFileSync(bySize.get(size * 2), path.join(iconsetDir, `icon_${size}x${size}@2x.png`));
  }
  try {
    execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", path.join(workDir, "icon.icns")]);
    console.log(`Reference icon.icns written to ${workDir}`);
  } catch (error) {
    console.log(`Skipping icon.icns: ${error.message}`);
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);

    const rendered = new Map();
    const snap = async (dest, selector, omitBackground = true) => {
      const el = await page.$(selector);
      const absolute = path.join(root, dest);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      await el.screenshot({ path: absolute, omitBackground });
      rendered.set(dest, absolute);
      return absolute;
    };

    await snap("apps/web/public/favicon-16x16.png", "#favicon-16");
    await snap("apps/web/public/favicon-32x32.png", "#favicon-32");
    await snap("apps/www/public/favicon-16x16.png", "#favicon-16");
    await snap("apps/www/public/favicon-32x32.png", "#favicon-32");

    await snap("apps/web/public/apple-touch-icon.png", "#icon-180");
    await snap("apps/web/public/icon-192.png", "#icon-192");
    await snap("apps/web/public/icon-512.png", "#icon-512");

    await snap("apps/www/public/apple-touch-icon.png", "#icon-180");
    await snap("apps/www/public/icon-192.png", "#icon-192");
    await snap("apps/www/public/icon-512.png", "#icon-512");

    await snap("apps/desktop/assets/icon.png", "#icon-1024");
    await snap("apps/desktop/assets/icon-macos.png", "#icon-1024");

    // macOS menu bar icon: monochrome black with alpha, tinted by the system.
    await snap("apps/desktop/assets/trayTemplate.png", "#tray-icon");
    // Linux tray icon: the clay tile with the paper mark at 32 px, visible on
    // dark and light panels (Linux does not tint *Template.png like macOS).
    await snap("apps/desktop/assets/tray-32.png", "#favicon-32");

    // Remove the pre-rename tray asset if an earlier checkout still has it.
    const staleTray = path.join(root, "apps/desktop/assets/tray.png");
    if (fs.existsSync(staleTray)) fs.unlinkSync(staleTray);

    await snap("apps/mobile/assets/icon.png", "#icon-1024");
    await snap("apps/mobile/assets/splash-icon.png", "#icon-1024");
    await snap("apps/mobile/assets/adaptive-icon.png", "#adaptive-icon");
    await snap("apps/mobile/assets/monochrome-icon.png", "#monochrome-icon");
    await snap("apps/mobile/assets/icon-background.png", "#icon-background", false);

    await snap("apps/mobile/assets/favicon.png", "#favicon-48");
    await snap("apps/mobile/assets/notification-icon.png", "#notification-icon");

    // Intermediates (per-size renders and the review samples) stay out of the
    // repository; they are written to a temp dir and thrown away with it.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ardur-icons-"));
    // Small sizes use the tuned favicon variants; 128 px and up use the icon set.
    const sizeSelectors = new Map([
      [16, "#favicon-16"],
      [32, "#favicon-32"],
      [64, "#favicon-64"],
      [128, "#icon-128"],
      [256, "#icon-256"],
      [512, "#icon-512"],
      [1024, "#icon-1024"],
    ]);
    const bySize = new Map();
    for (const [size, selector] of sizeSelectors) {
      const el = await page.$(selector);
      const dest = path.join(workDir, `icon-${size}.png`);
      await el.screenshot({ path: dest, omitBackground: true });
      bySize.set(size, dest);
    }

    writeIco(
      path.join(root, "apps/web/public/favicon.ico"),
      ["apps/web/public/favicon-16x16.png", "apps/web/public/favicon-32x32.png"].map((file) =>
        rendered.get(file),
      ),
    );
    writeIco(
      path.join(root, "apps/www/public/favicon.ico"),
      ["apps/www/public/favicon-16x16.png", "apps/www/public/favicon-32x32.png"].map((file) =>
        rendered.get(file),
      ),
    );
    writeIco(
      path.join(root, "apps/desktop/assets/icon.ico"),
      [16, 32, 64, 128, 256].map((size) => bySize.get(size)),
    );

    const samples = [
      ["#favicon-16", "16.png"],
      ["#favicon-32", "32.png"],
      ["#favicon-48", "48.png"],
      ["#icon-96", "96.png"],
      ["#icon-160", "160.png"],
      ["#icon-1024", "1024.png"],
    ];
    for (const [selector, name] of samples) {
      const el = await page.$(selector);
      await el.screenshot({
        path: path.join(workDir, name),
        omitBackground: true,
      });
    }

    writeIcnsIfSupported(bySize, workDir);
    console.log(`Icon samples and intermediates written to ${workDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
