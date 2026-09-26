#!/usr/bin/env bash
set -euo pipefail

if [[ "${ARDURBOT_DEV_POSTGRES:-}" != "embedded" ]]; then
  echo "ARDURBOT_DEV_POSTGRES is not embedded. If you want Compose, run docker compose ... up postgres -d"
  # Actually, the user should have run docker compose manually.
  # So dev.sh doesn't need to run docker compose. Wait, the prompt says "the source dev script path does not call docker compose when ARDURBOT_DEV_POSTGRES=embedded is set."
  # Maybe the prompt implies that the user USED to run a script that called `docker compose`?
fi

cross-env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 turbo dev --filter=@ardurbot/api --filter=@ardurbot/worker --filter=@ardurbot/web --filter=@ardurbot/sandbox-supervisor --filter=@ardurbot/host-service
