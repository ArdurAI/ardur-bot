import fs from "node:fs";

let code = fs.readFileSync("scripts/desktop-release-assets.mjs", "utf8");

const oldCask = `await generateCask(version, destination, path.join(destination, "ardur-bot.rb"));`;
const newCask = `await generateCask(version, destination, path.join(destination, "ardur-bot.rb"));
import { generateWinget } from "./desktop-release.mjs";
await generateWinget(version, destination, destination);
`;

code = code.replace(oldCask, newCask);
fs.writeFileSync("scripts/desktop-release-assets.mjs", code);
