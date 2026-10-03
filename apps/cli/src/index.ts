import { runCli } from "./commands.js";

process.exitCode = await runCli(process.argv.slice(2));
