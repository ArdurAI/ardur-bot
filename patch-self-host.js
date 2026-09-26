import fs from "node:fs";

let text = fs.readFileSync("docs/self-host.md", "utf8");

const oldIntro = `The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, or Box). It is not a static site. The marketing site in \`apps/www\` can be hosted separately.

## Local (source checkout)

Same as the README quick start: \`.env\` from \`.env.example\`, Postgres via Compose, \`pnpm sandbox:build\`, \`pnpm dev\`, then [http://127.0.0.1:5173](http://127.0.0.1:5173) (or \`http://localhost:5173\` — both loopback hosts are trusted). Electron during source development: \`pnpm --filter @ardurbot/desktop dev\` while that stack is up, choosing **Existing instance** with that address.`;

const newIntro = `The signed-in product is a long-running API, a Graphile Worker, and Postgres. It uses the computer it is installed on by default. Docker, Podman, Kubernetes, and SSH are optional added computers. It is not a static site. The marketing site in \`apps/www\` can be hosted separately.

## Local (source checkout)

Same as the README quick start: \`.env\` from \`.env.example\`, Postgres via embedded binary, \`pnpm dev\`, then [http://127.0.0.1:5173](http://127.0.0.1:5173) (or \`http://localhost:5173\` — both loopback hosts are trusted). Electron during source development: \`pnpm --filter @ardurbot/desktop dev\` while that stack is up, choosing **Existing instance** with that address.`;

text = text.replace(oldIntro, newIntro);
fs.writeFileSync("docs/self-host.md", text);
