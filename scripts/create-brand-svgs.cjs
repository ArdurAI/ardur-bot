const fs = require('fs');
const path = require('path');

const brandDir = path.join(__dirname, '../packages/ui-tokens/assets/brand');
fs.mkdirSync(brandDir, { recursive: true });

const ink = '#1C1A17';
const paper = '#FFFFFF';

function writeSvg(name, content) {
  fs.writeFileSync(path.join(brandDir, name), content);
}

const markInk = `<svg viewBox="0 0 400 400" width="20" height="20" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path stroke="${ink}" stroke-width="32" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path>
  <rect x="324" y="118" width="36" height="232" rx="18" fill="${ink}"></rect>
</svg>`;
const markPaper = `<svg viewBox="0 0 400 400" width="20" height="20" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path stroke="${paper}" stroke-width="32" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path>
  <rect x="324" y="118" width="36" height="232" rx="18" fill="${paper}"></rect>
</svg>`;

const wordmarkInk = `<svg viewBox="0 0 160 50" width="160" height="50" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${ink}" letter-spacing="-0.02em">Ardur</text>
</svg>`;
const wordmarkPaper = `<svg viewBox="0 0 160 50" width="160" height="50" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${paper}" letter-spacing="-0.02em">Ardur</text>
</svg>`;

const lockupInk = `<svg viewBox="0 0 200 50" width="200" height="50" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(0, 8) scale(0.085)">
    <path stroke="${ink}" stroke-width="32" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path>
    <rect x="324" y="118" width="36" height="232" rx="18" fill="${ink}"></rect>
  </g>
  <text x="44" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${ink}" letter-spacing="-0.02em">Ardur</text>
</svg>`;
const lockupPaper = `<svg viewBox="0 0 200 50" width="200" height="50" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(0, 8) scale(0.085)">
    <path stroke="${paper}" stroke-width="32" stroke-linecap="round" d="M 322 100 A 150 150 0 1 0 334 296"></path>
    <rect x="324" y="118" width="36" height="232" rx="18" fill="${paper}"></rect>
  </g>
  <text x="44" y="40" font-family="'Instrument Serif', Georgia, serif" font-size="44px" fill="${paper}" letter-spacing="-0.02em">Ardur</text>
</svg>`;

writeSvg('mark-ink.svg', markInk);
writeSvg('mark-paper.svg', markPaper);
writeSvg('wordmark-ink.svg', wordmarkInk);
writeSvg('wordmark-paper.svg', wordmarkPaper);
writeSvg('lockup-ink.svg', lockupInk);
writeSvg('lockup-paper.svg', lockupPaper);

console.log("Done");
