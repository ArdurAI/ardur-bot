// Offline measure of how much of each pi turn a provider prompt cache can reuse.
// Run: pnpm perf:prompt-cache
import {
  estimatedTokens,
  measurePrefixReuse,
} from "../packages/adapters/src/context/prefix-reuse.ts";
import { groupThreadTurns } from "../packages/adapters/src/context/prefix-reuse-fixture.ts";

const rows = await measurePrefixReuse(groupThreadTurns());
const later = rows.slice(1);
const count = (characters: number) =>
  `${characters.toLocaleString("en-US")} chars (~${estimatedTokens(characters).toLocaleString("en-US")} tokens)`;
const average = (values: number[]) =>
  Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

console.log("Ten-turn launch group thread: shared prefix with the previous request");
for (const row of later)
  console.log(
    `turn ${String(row.turn).padStart(2)}: request ${count(row.requestChars)}, shared ${count(row.sharedChars)}, sent again ${count(row.requestChars - row.sharedChars)}`,
  );
console.log(`average shared prefix: ${count(average(later.map((row) => row.sharedChars)))}`);
console.log(
  `average sent again: ${count(average(later.map((row) => row.requestChars - row.sharedChars)))}`,
);
