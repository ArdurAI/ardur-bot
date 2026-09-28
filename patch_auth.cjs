const fs = require('fs');
let content = fs.readFileSync('apps/web/src/pages/Auth.tsx', 'utf8');
const oldMark = `<div className="flex h-[74px] w-[74px] items-center justify-center gap-[11px] rounded-full bg-muted">
          <span className="h-5 w-[9px] rounded-full bg-primary" />
          <span className="h-5 w-[9px] rounded-full bg-primary" />
        </div>`;
const newMark = `<svg viewBox="0 0 400 400" className="h-[74px] w-[74px] text-foreground" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path stroke="currentColor" strokeWidth="32" strokeLinecap="round" d="M 322 100 A 150 150 0 1 0 334 296" />
          <rect x="324" y="118" width="36" height="232" rx="18" fill="currentColor" />
        </svg>`;
if (content.includes(oldMark)) {
  fs.writeFileSync('apps/web/src/pages/Auth.tsx', content.replace(oldMark, newMark));
  console.log("Patched Auth.tsx");
} else {
  console.log("oldMark not found in Auth.tsx");
}
