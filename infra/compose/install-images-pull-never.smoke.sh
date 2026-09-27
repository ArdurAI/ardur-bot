#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
# BSD grep needs -e so patterns starting with -- are not flags.
g() { grep -F -e "$1" "$src" >/dev/null || fail "missing $1"; }
g '--pull-never)'
g '--offline)'
g 'ARDURBOT_PULL_NEVER'
g 'Skipping image pull'
g '--pull never'
g 'cannot enforce pull-never on this Compose version'
g '${up_pull_args[@]+"${up_pull_args[@]}"}'
g 'HTTP_PROXY/HTTPS_PROXY'
g '[--prepare-only] [--local] [--pull-never] [--offline]'
set +e
out="$(bash "$src" --not-a-flag 2>&1)"
code=$?
set -e
[[ "$code" -eq 2 ]] || fail "expected exit 2 for unknown flag, got $code"
[[ "$out" == *"Usage: bash install-images.sh"* ]] || fail "usage missing from stderr"
bash -n "$src" || fail "bash -n failed"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-images-smoke.XXXXXX")"
cleanup_tmp() { rm -rf "$tmp"; }
trap cleanup_tmp EXIT

# Exercise the POSIX JSON-field fallback with jq hidden from PATH.
mkdir -p "$tmp/fallback-bin"
ln -s "$(command -v awk)" "$tmp/fallback-bin/awk"
if ! PATH="/bin:$tmp/fallback-bin" command -v jq >/dev/null 2>&1; then
  (
    eval "$(sed -n '/^compose_field() {/,/^}/p' "$src")"
    image=$(PATH="/bin:$tmp/fallback-bin" compose_field computer image < "$root/computer-config.fixture.json")
    channel=$(PATH="/bin:$tmp/fallback-bin" compose_field selection channel < "$root/computer-config.fixture.json")
    [[ "$image" == "ghcr.io/ardurai/ardur-bot/computer:1.2.3" && "$channel" == release ]] \
      || fail "POSIX Compose JSON extraction disagreed with the recorded config"

    # A host without jq must drain large configurations without SIGPIPE (141) under pipefail.
    large_config=$(
      sed '$d' "$root/computer-config.fixture.json"
      printf ',\n  "x-trailing": {\n    "data": "%200000s"\n  }\n}\n' ' '
    )
    image_large=$(printf '%s\n' "$large_config" | PATH="/bin:$tmp/fallback-bin" compose_field computer image)
    [[ "$image_large" == "ghcr.io/ardurai/ardur-bot/computer:1.2.3" ]] \
      || fail "POSIX Compose JSON extraction failed to drain large configuration"
  )
fi

write_stubs() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
log="${STUB_DOCKER_LOG:?}"
{
  printf 'docker'
  for a in "$@"; do
    printf ' %s' "$a"
  done
  printf '\n'
} >> "$log"

if [[ "${1:-}" != compose ]]; then
  echo "STUB: unexpected docker $*" >&2
  exit 1
fi
shift

help=false
short=false
verb=""
for a in "$@"; do
  case "$a" in
    --help|-h) help=true ;;
    --short) short=true ;;
    version|up|pull|config)
      if [[ -z "$verb" ]]; then
        verb="$a"
      fi
      ;;
  esac
done

echo "VERB=${verb:-none}" >> "$log"
echo "COMPUTER_REF=${ARDURBOT_COMPUTER_IMAGE_REF:-}" >> "$log"

if [[ "$verb" == config && " $* " != *" --format json "* ]]; then
  cat >/dev/null || true
fi

if [[ "$help" == true ]]; then
  printf '%s\n' "${STUB_COMPOSE_UP_HELP:-Usage: docker compose up

Options:
  --pull string     Pull image before running
  --wait
  --wait-timeout int
}"
  exit 0
fi

case "$verb" in
  version)
    if [[ "$short" == true ]]; then
      printf '%s\n' "${STUB_COMPOSE_SHORT:-2.24.0}"
    else
      echo "Docker Compose version v${STUB_COMPOSE_SHORT:-2.24.0}"
    fi
    ;;
  config)
    if [[ " $* " == *" --format json "* ]]; then
      if [[ -n "${STUB_REAL_DOCKER:-}" ]]; then
        exec "$STUB_REAL_DOCKER" compose "$@"
      fi
      image="${STUB_CONFIG_EXPLICIT_IMAGE:-${ARDURBOT_COMPUTER_IMAGE_REF:-${STUB_CONFIG_EXPLICIT_REF:-${ARDURBOT_COMPUTER_IMAGE_REF_BOOTSTRAP:-}}}}"
      cat <<EOF
{
  "services": {
    "computer": {
      "image": "$image"
    }
  },
  "x-ardurbot-image-selection": {
    "app_version": "${STUB_CONFIG_APP_VERSION:-0.1.0-alpha.1}",
    "image_tag": "${STUB_CONFIG_IMAGE_TAG:-}",
    "channel": "${STUB_CONFIG_CHANNEL:-}",
    "explicit_image": "${STUB_CONFIG_EXPLICIT_IMAGE:-}",
    "explicit_ref": "${STUB_CONFIG_EXPLICIT_REF:-}"
  }
}
EOF
      exit 0
    fi
    cat <<'EOF'
POSTGRES_PASSWORD=test-postgres
BETTER_AUTH_SECRET=test-auth-secret
ENCRYPTION_KEY=test-encryption-key
SCREEN_PROXY_SECRET=test-screen-secret
SANDBOX_SUPERVISOR_TOKEN=test-supervisor-token
EOF
    ;;
  pull|up)
    ;;
  *)
    echo "STUB: unexpected compose verb ${verb:-none} $*" >&2
    exit 1
    ;;
esac
STUB
  cat > "$bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
log="${STUB_CURL_LOG:?}"
{
  printf 'curl'
  for a in "$@"; do
    printf ' %s' "$a"
  done
  printf '\n'
} >> "$log"
if [[ " $* " == *" --help "* ]]; then
  echo "--retry-all-errors"
  exit 0
fi
out=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    out="$a"
  fi
  prev="$a"
done
if [[ -n "$out" ]]; then
  if [[ " $* " == *".env.images.example"* ]]; then
    printf 'ARDURBOT_APP_VERSION=0.1.0-alpha.1\n' > "$out"
  else
    printf 'stub-download\n' > "$out"
  fi
  exit 0
fi
exit 1
STUB
  chmod +x "$bin/docker" "$bin/curl"
}

setup_work() {
  local work="$1"
  mkdir -p "$work/cwd"
  write_stubs "$work/bin"
  : > "$work/cwd/docker-compose.images.yml"
  printf 'ARDURBOT_APP_VERSION=0.1.0-alpha.1\n' > "$work/cwd/.env.images.example"
  cat > "$work/cwd/.env" <<'EOF'
POSTGRES_PASSWORD=test-postgres
BETTER_AUTH_SECRET=test-auth-secret
ENCRYPTION_KEY=test-encryption-key
SCREEN_PROXY_SECRET=test-screen-secret
SANDBOX_SUPERVISOR_TOKEN=test-supervisor-token
EOF
  : > "$work/docker.log"
  : > "$work/curl.log"
  : > "$work/stub-config"
}

run_install() {
  local work="$1"
  shift
  (
    unset ARDURBOT_IMAGE_TAG ARDURBOT_COMPUTER_IMAGE ARDURBOT_COMPUTER_IMAGE_TAG ARDURBOT_COMPUTER_CHANNEL ARDURBOT_COMPUTER_IMAGE_REF
    export FIXTURE_CHANNEL=release
    export STUB_DOCKER_LOG="$work/docker.log"
    export STUB_CURL_LOG="$work/curl.log"
    source "$work/stub-config"
    export PATH="$work/bin:$PATH"
    cd "$work/cwd"
    bash "$src" "$@"
  )
}

has_compose_pull() {
  grep -q 'VERB=pull' "$1/docker.log"
}

has_up_pull_never() {
  grep -F -e 'VERB=up' "$1/docker.log" >/dev/null \
    && grep -F -e ' --pull never' "$1/docker.log" >/dev/null
}

# Flags accepted: --offline takes the local/pull-never path (no curl, no compose pull).
setup_work "$tmp/offline"
set +e
offline_out="$(run_install "$tmp/offline" --offline 2>&1)"
offline_code=$?
set -e
[[ "$offline_code" -eq 0 ]] || fail "--offline exited $offline_code: $offline_out"
[[ "$offline_out" != *"Usage: bash install-images.sh"* ]] || fail "--offline was rejected as unknown"
[[ "$offline_out" == *"Using local docker-compose.images.yml"* ]] || fail "--offline did not keep local compose file"
[[ "$offline_out" == *"Using local .env.images.example"* ]] || fail "--offline did not keep local env example"
[[ "$offline_out" == *"Skipping image pull"* ]] || fail "--offline did not skip image pull"
[[ "$offline_out" == *"Ardur is starting"* ]] || fail "--offline did not start"
[[ ! -s "$tmp/offline/curl.log" ]] || fail "--offline should not curl when files are local: $(cat "$tmp/offline/curl.log")"
has_compose_pull "$tmp/offline" && fail "--offline should not run compose pull"
has_up_pull_never "$tmp/offline" || fail "--offline should pass --pull never to compose up: $(cat "$tmp/offline/docker.log")"
grep -Fx 'COMPUTER_REF=ghcr.io/ardurai/ardur-bot/computer:dev' "$tmp/offline/docker.log" >/dev/null \
  || fail "the default computer reference did not use the prerelease channel"

setup_work "$tmp/release"
printf 'ARDURBOT_APP_VERSION=1.2.3\n' > "$tmp/release/cwd/.env.images.example"
printf 'export STUB_CONFIG_APP_VERSION=1.2.3\n' > "$tmp/release/stub-config"
run_install "$tmp/release" --offline >/dev/null
grep -Fx 'COMPUTER_REF=ghcr.io/ardurai/ardur-bot/computer:1.2.3' "$tmp/release/docker.log" >/dev/null \
  || fail "the release computer reference did not use the exact app version"

setup_work "$tmp/pinned-release"
printf 'ARDURBOT_IMAGE_TAG=v1.2.3\n' >> "$tmp/pinned-release/cwd/.env"
printf 'export STUB_CONFIG_IMAGE_TAG=v1.2.3\n' > "$tmp/pinned-release/stub-config"
run_install "$tmp/pinned-release" --offline >/dev/null
grep -Fx 'COMPUTER_REF=ghcr.io/ardurai/ardur-bot/computer:1.2.3' "$tmp/pinned-release/docker.log" >/dev/null \
  || fail "the pinned release computer reference did not use the exact app version"

# The desktop unit test runs this table through the real Compose CLI when available.
while IFS='|' read -r name key encoded expected reference; do
  [[ "$name" == \#* || -z "$name" ]] && continue
  setup_work "$tmp/setting-$name"
  printf '%b\n' "$encoded" >> "$tmp/setting-$name/cwd/.env"
  case "$key" in
    ARDURBOT_COMPUTER_CHANNEL) printf 'export STUB_CONFIG_CHANNEL=%q\n' "$expected" > "$tmp/setting-$name/stub-config" ;;
    ARDURBOT_IMAGE_TAG) printf 'export STUB_CONFIG_IMAGE_TAG=%q\n' "$expected" > "$tmp/setting-$name/stub-config" ;;
    ARDURBOT_COMPUTER_IMAGE_REF) printf 'export STUB_CONFIG_EXPLICIT_REF=%q\n' "$expected" > "$tmp/setting-$name/stub-config" ;;
  esac
  run_install "$tmp/setting-$name" --offline >/dev/null
  grep -Fx "COMPUTER_REF=$reference" "$tmp/setting-$name/docker.log" >/dev/null \
    || fail "$name selected a different computer reference"
done < "$root/deployment-settings.fixtures.tsv"

# The real CLI renders image selection without contacting the daemon. Other
# lifecycle verbs remain stubbed, so this case cannot pull or start an image.
if command -v docker >/dev/null 2>&1 && docker compose version --short >/dev/null 2>&1; then
  setup_work "$tmp/real-config"
  cp "$root/docker-compose.images.yml" "$tmp/real-config/cwd/docker-compose.images.yml"
  printf 'ARDURBOT_COMPUTER_CHANNEL=${CHANNEL:-release}\n' >> "$tmp/real-config/cwd/.env"
  STUB_REAL_DOCKER="$(command -v docker)" run_install "$tmp/real-config" --offline >/dev/null
  grep -Fx 'COMPUTER_REF=ghcr.io/ardurai/ardur-bot/computer:0.1.0-alpha.1' "$tmp/real-config/docker.log" >/dev/null \
    || fail "real Compose selected a different computer reference"
else
  echo "skip: Docker Compose CLI unavailable for the rendered-config smoke" >&2
fi

# --pull-never is accepted and skips pull (may still download Compose files).
setup_work "$tmp/pull-never"
set +e
pull_never_out="$(run_install "$tmp/pull-never" --pull-never 2>&1)"
pull_never_code=$?
set -e
[[ "$pull_never_code" -eq 0 ]] || fail "--pull-never exited $pull_never_code: $pull_never_out"
[[ "$pull_never_out" != *"Usage: bash install-images.sh"* ]] || fail "--pull-never was rejected as unknown"
[[ "$pull_never_out" == *"Skipping image pull"* ]] || fail "--pull-never did not skip image pull"
has_compose_pull "$tmp/pull-never" && fail "--pull-never should not run compose pull"
has_up_pull_never "$tmp/pull-never" || fail "--pull-never should pass --pull never to compose up"

# Old Compose without up --pull: warn and continue instead of hard-fail.
setup_work "$tmp/old"
export STUB_COMPOSE_UP_HELP='Usage: docker compose up
  --wait
  --wait-timeout int
'
export STUB_COMPOSE_SHORT='2.10.1'
set +e
old_out="$(run_install "$tmp/old" --offline 2>&1)"
old_code=$?
set -e
unset STUB_COMPOSE_UP_HELP STUB_COMPOSE_SHORT
[[ "$old_code" -eq 0 ]] || fail "old Compose --offline exited $old_code: $old_out"
[[ "$old_out" == *"cannot enforce pull-never on this Compose version; startup fails if an image is missing locally"* ]] \
  || fail "old Compose --offline missing soft warning: $old_out"
[[ "$old_out" != *"Ardur setup failed:"* ]] || fail "old Compose --offline should not hard-fail: $old_out"
[[ "$old_out" == *"Ardur is starting"* ]] || fail "old Compose --offline should continue: $old_out"
has_compose_pull "$tmp/old" && fail "old Compose --offline should not run compose pull"
if grep -F -e ' --pull never' "$tmp/old/docker.log" >/dev/null; then
  fail "old Compose up should not receive --pull never: $(cat "$tmp/old/docker.log")"
fi
grep -q 'VERB=up' "$tmp/old/docker.log" || fail "old Compose --offline should still run compose up"

# Empty up arrays under set -u must not abort a normal install (bash 3.2).
setup_work "$tmp/default"
set +e
default_out="$(run_install "$tmp/default" 2>&1)"
default_code=$?
set -e
[[ "$default_code" -eq 0 ]] || fail "default install exited $default_code: $default_out"
[[ "$default_out" != *"unbound variable"* ]] || fail "empty array expansion aborted: $default_out"
has_compose_pull "$tmp/default" || fail "default install should run compose pull"
grep -q 'VERB=up' "$tmp/default/docker.log" || fail "default install should run compose up"

echo "ok"
