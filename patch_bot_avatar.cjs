const fs = require('fs');
let content = fs.readFileSync('packages/ui-web/src/bot-avatar.tsx', 'utf8');
const oldWordmark = `<div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Ardur
      </span>`;
const newWordmark = `<svg viewBox="0 0 400 400" className="h-[34px] w-[34px] text-foreground" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path stroke="currentColor" strokeWidth="36" strokeLinecap="round" d="M 322 100 A 150 150 0 1 0 334 296" />
        <rect x="324" y="118" width="36" height="232" rx="18" fill="currentColor" />
      </svg>
      <span className="font-['Instrument_Serif',Georgia,serif] text-[34px] tracking-tight text-foreground leading-none" style={{ letterSpacing: "-0.02em" }}>
        Ardur
      </span>`;
if (content.includes(oldWordmark)) {
  fs.writeFileSync('packages/ui-web/src/bot-avatar.tsx', content.replace(oldWordmark, newWordmark));
  console.log("Patched bot-avatar.tsx");
} else {
  console.log("oldWordmark not found in bot-avatar.tsx");
}
