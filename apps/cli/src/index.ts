import { pairDevice } from "./client.js";
import { saveHome } from "./config.js";
import { CliError } from "./transport.js";

async function main() {
  const [command, code, ...extra] = process.argv.slice(2);
  if (command !== "pair" || !code || extra.length)
    throw new CliError("Usage: ardur pair <pairing-code>", 3);
  const home = await pairDevice(code);
  await saveHome(home);
  process.stdout.write(`Paired with ${home.homeName}.\n`);
}
void main().catch((error) => {
  process.stderr.write(
    `${error instanceof CliError ? error.message : "This request could not finish; try again."}\n`,
  );
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
