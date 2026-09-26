import fs from "node:fs";

let readme = fs.readFileSync("README.md", "utf8");

const oldSection = `## Run from source

You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+; pnpm 9;
and Docker. Node.js 23.x and 25.x are not supported.

\`\`\`sh
git clone https://github.com/ArdurAI/ardur-bot.git
cd ardur-bot
git checkout dev
cp .env.example .env
\`\`\`

In \`.env\`, set \`POSTGRES_PASSWORD\` (for example \`openssl rand -hex 16\`) and put the same
value in \`DATABASE_URL\`. Set \`BETTER_AUTH_SECRET\`, \`ENCRYPTION_KEY\`, \`SCREEN_PROXY_SECRET\`
and \`SANDBOX_SUPERVISOR_TOKEN\` to separate long random values (\`openssl rand -hex 32\`).
Model credentials are added in the app, or set \`OPENROUTER_API_KEY\` here.

\`\`\`sh
docker compose --env-file .env \\
  -f infra/compose/docker-compose.yml \\
  -f infra/compose/docker-compose.postgres-host.yml \\
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
\`\`\`

On first run it starts its own database and services on this computer; its setup window can
connect it to an existing server instead.`;

const newSection = `## Run from source

You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+ and pnpm 9. Node.js 23.x and 25.x are not supported.

\`\`\`sh
git clone https://github.com/ArdurAI/ardur-bot.git
cd ardur-bot
git checkout dev
cp .env.example .env
\`\`\`

In \`.env\`, set \`POSTGRES_PASSWORD\` (for example \`openssl rand -hex 16\`) and put the same
value in \`DATABASE_URL\`. Set \`BETTER_AUTH_SECRET\`, \`ENCRYPTION_KEY\`, \`SCREEN_PROXY_SECRET\`
and \`SANDBOX_SUPERVISOR_TOKEN\` to separate long random values (\`openssl rand -hex 32\`).
Model credentials are added in the app, or set \`OPENROUTER_API_KEY\` here.

To run with an embedded Postgres database (no Docker required):

\`\`\`sh
export ARDURBOT_DEV_POSTGRES=embedded
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
\`\`\`

To run with Docker Compose as the database host:

\`\`\`sh
docker compose --env-file .env \\
  -f infra/compose/docker-compose.yml \\
  -f infra/compose/docker-compose.postgres-host.yml \\
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
\`\`\`

On first run it starts its own database and services on this computer; its setup window can
connect it to an existing server instead.`;

readme = readme.replace(oldSection, newSection);
fs.writeFileSync("README.md", readme);
