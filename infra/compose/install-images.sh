#!/usr/bin/env bash

set -Eeuo pipefail

DOWNLOAD_BASE="${ARDURBOT_DOWNLOAD_BASE:-https://raw.githubusercontent.com/ardurai/ardur-bot/main/infra/compose}"
while [[ "$DOWNLOAD_BASE" == */ ]]; do
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"
done
case "$DOWNLOAD_BASE" in
  https://*) ;;
  *)
    echo "Ardur setup failed: ARDURBOT_DOWNLOAD_BASE must use https." >&2
    exit 1
    ;;
esac
readonly DOWNLOAD_BASE

readonly COMPOSE_FILE="docker-compose.images.yml"
readonly ENV_EXAMPLE=".env.images.example"
readonly ENV_FILE=".env"

prepare_only=false
skip_existing=false
pull_never=false
if [[ "${ARDURBOT_DOWNLOAD_SKIP_EXISTING:-}" == "1" ]]; then
  skip_existing=true
fi
if [[ "${ARDURBOT_PULL_NEVER:-}" == "1" ]]; then
  pull_never=true
fi

for arg in "$@"; do
  case "$arg" in
    --prepare-only)
      prepare_only=true
      ;;
    --local)
      skip_existing=true
      ;;
    --pull-never)
      pull_never=true
      ;;
    --offline)
      # Air-gap bootstrap: keep local Compose/env files and do not pull images.
      skip_existing=true
      pull_never=true
      ;;
    *)
      echo "Usage: bash install-images.sh [--prepare-only] [--local] [--pull-never] [--offline]" >&2
      exit 2
      ;;
  esac
done

temporary_file=""
cleanup() {
  if [[ -n "$temporary_file" ]]; then
    rm -f -- "$temporary_file"
  fi
}
trap cleanup EXIT

fail() {
  echo "Ardur setup failed: $*" >&2
  exit 1
}

for command_name in curl docker openssl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "'$command_name' is required."
done

docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is required."

# Optional proxy knobs from an existing .env (operators often set them there for
# containers). Do not override values already present in the shell. Treat each
# HTTP/HTTPS/NO_PROXY pair as one family so either case in the shell wins.
# Within .env, later assignments for a family win (shell presence is snapshotted
# before the file is read). Comment stripping is quote-aware so `#` inside
# matching quotes is kept; this is not a full dotenv parser.
load_proxy_vars_from_env_file() {
  local file="$1"
  local line key value
  local i c quote out
  local shell_http=0 shell_https=0 shell_no=0
  [[ -f "$file" ]] || return 0
  [[ -n "${HTTP_PROXY+x}" || -n "${http_proxy+x}" ]] && shell_http=1
  [[ -n "${HTTPS_PROXY+x}" || -n "${https_proxy+x}" ]] && shell_https=1
  [[ -n "${NO_PROXY+x}" || -n "${no_proxy+x}" ]] && shell_no=1
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Windows/.editorconfig CRLF: drop trailing CR so quoted values still match.
    line="${line%$'\r'}"
    out=""
    quote=""
    for ((i = 0; i < ${#line}; i++)); do
      c="${line:i:1}"
      if [[ -n "$quote" ]]; then
        # Inside double quotes, treat \" and \\ as escaped so \# stays in-value.
        if [[ "$quote" == '"' && "$c" == '\' ]] && ((i + 1 < ${#line})); then
          out+="$c"
          i=$((i + 1))
          out+="${line:i:1}"
          continue
        fi
        out+="$c"
        [[ "$c" == "$quote" ]] && quote=""
      elif [[ "$c" == "'" || "$c" == '"' ]]; then
        quote="$c"
        out+="$c"
      elif [[ "$c" == "#" ]]; then
        break
      else
        out+="$c"
      fi
    done
    line="$out"
    [[ "$line" =~ ^[[:space:]]*(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
      value="${value//\\\"/\"}"
      value="${value//\\\\/\\}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "$key" in
      HTTP_PROXY|http_proxy)
        if ((shell_http)); then
          continue
        fi
        unset -v HTTP_PROXY http_proxy
        ;;
      HTTPS_PROXY|https_proxy)
        if ((shell_https)); then
          continue
        fi
        unset -v HTTPS_PROXY https_proxy
        ;;
      NO_PROXY|no_proxy)
        if ((shell_no)); then
          continue
        fi
        unset -v NO_PROXY no_proxy
        ;;
    esac
    export "${key}=${value}"
  done <"$file"
}

# curl uses lowercase http_proxy for http:// URLs; many Mainland hosts only export HTTP_PROXY.
sync_curl_proxy_env() {
  if [[ -n "${HTTP_PROXY+x}" && -z "${http_proxy+x}" ]]; then
    export http_proxy="$HTTP_PROXY"
  fi
  if [[ -n "${HTTPS_PROXY+x}" && -z "${https_proxy+x}" ]]; then
    export https_proxy="$HTTPS_PROXY"
  fi
  if [[ -n "${NO_PROXY+x}" && -z "${no_proxy+x}" ]]; then
    export no_proxy="$NO_PROXY"
  fi
}

prepare_proxy_env() {
  load_proxy_vars_from_env_file "$ENV_FILE"
  sync_curl_proxy_env
}
prepare_proxy_env

curl_download() {
  local url="$1"
  local out="$2"
  local attempt
  local max_attempts=3

  if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
    curl -fsSL --proto-redir =https --retry 3 --retry-delay 2 --retry-all-errors "$url" -o "$out"
    return $?
  fi

  attempt=1
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if curl -fsSL --proto-redir =https "$url" -o "$out"; then
      return 0
    fi
    if [[ "$attempt" -eq "$max_attempts" ]]; then
      return 1
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

download() {
  local filename="$1"
  local url="${DOWNLOAD_BASE}/${filename}"

  if [[ "$skip_existing" == true && -e "$filename" ]]; then
    echo "Using local ${filename}"
    return 0
  fi

  temporary_file=$(mktemp "./${filename}.tmp.XXXXXX")
  if ! curl_download "$url" "$temporary_file"; then
    fail "could not download ${filename} from ${url}. Set HTTP_PROXY/HTTPS_PROXY in the shell or .env (NO_PROXY for localhost), or pre-place the file and use --local / --offline."
  fi
  mv -- "$temporary_file" "$filename"
  temporary_file=""
}

create_env() {
  umask 077
  temporary_file=$(mktemp "./${ENV_FILE}.tmp.XXXXXX")

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "POSTGRES_PASSWORD=")
        printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)"
        ;;
      "BETTER_AUTH_SECRET=")
        printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
        ;;
      "ENCRYPTION_KEY=")
        printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
        ;;
      "SCREEN_PROXY_SECRET=")
        printf 'SCREEN_PROXY_SECRET=%s\n' "$(openssl rand -hex 32)"
        ;;
      "SANDBOX_SUPERVISOR_TOKEN=")
        printf 'SANDBOX_SUPERVISOR_TOKEN=%s\n' "$(openssl rand -hex 32)"
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done < "$ENV_EXAMPLE" > "$temporary_file"

  chmod 600 "$temporary_file"
  mv -- "$temporary_file" "$ENV_FILE"
  temporary_file=""
  echo "Created .env with random secrets."
}

validate_required_secrets() {
  if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f - config --environment <<'YAML' | awk '
    BEGIN {
      required["POSTGRES_PASSWORD"] = 1
      required["BETTER_AUTH_SECRET"] = 1
      required["ENCRYPTION_KEY"] = 1
      required["SCREEN_PROXY_SECRET"] = 1
      required["SANDBOX_SUPERVISOR_TOKEN"] = 1
    }
    {
      name = $0
      sub(/=.*/, "", name)
      if (!(name in required)) next
      seen[name]++

      value = $0
      sub(/^[^=]*=/, "", value)
      gsub(/[[:space:]]/, "", value)
      if (value != "") nonempty[name]++
    }
    END {
      for (name in required) {
        if (seen[name] != 1 || nonempty[name] != 1) exit 1
      }
    }
  '
services:
  api:
    environment:
      _ARDURBOT_VALIDATE_POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      _ARDURBOT_VALIDATE_BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET in .env}
      _ARDURBOT_VALIDATE_ENCRYPTION_KEY: ${ENCRYPTION_KEY:?Set ENCRYPTION_KEY in .env}
      _ARDURBOT_VALIDATE_SCREEN_PROXY_SECRET: ${SCREEN_PROXY_SECRET:?Set SCREEN_PROXY_SECRET in .env}
      _ARDURBOT_VALIDATE_SANDBOX_SUPERVISOR_TOKEN: ${SANDBOX_SUPERVISOR_TOKEN:?Set SANDBOX_SUPERVISOR_TOKEN in .env}
YAML
  then
    fail "set every required secret in .env to a non-empty value."
  fi
}

# Parse Compose's assignment, quoting, comment and simple ${VAR} interpolation
# rules without evaluating the env file as shell code.
parse_deployment_value() {
  local raw="$1" c next quote="" rest i
  parsed_value=""
  interpolate_value=true
  quote="${raw:0:1}"
  if [[ "$quote" == '"' || "$quote" == "'" ]]; then
    [[ "$quote" == "'" ]] && interpolate_value=false
    for ((i = 1; i < ${#raw}; i++)); do
      c="${raw:i:1}"
      if [[ "$quote" == '"' && "$c" == '\' && $((i + 1)) -lt ${#raw} ]]; then
        i=$((i + 1))
        next="${raw:i:1}"
        case "$next" in
          n) parsed_value+=$'\n' ;;
          r) parsed_value+=$'\r' ;;
          t) parsed_value+=$'\t' ;;
          '"'|'\') parsed_value+="$next" ;;
          *) parsed_value+="\\$next" ;;
        esac
      elif [[ "$quote" == "'" && "$c" == '\' && "${raw:i+1:1}" == "'" ]]; then
        parsed_value+="'"
        i=$((i + 1))
      elif [[ "$c" == "$quote" ]]; then
        rest="${raw:i+1}"
        [[ "$rest" =~ ^[[:space:]]*(#.*)?$ ]] || return 1
        return 0
      else
        parsed_value+="$c"
      fi
    done
    return 1
  fi
  for ((i = 0; i < ${#raw}; i++)); do
    c="${raw:i:1}"
    if [[ "$c" == '#' && $i -gt 0 && "${raw:i-1:1}" =~ [[:space:]] ]]; then
      break
    fi
    parsed_value+="$c"
  done
  parsed_value="${parsed_value%"${parsed_value##*[![:space:]]}"}"
}

# Read only the named setting; earlier assignments can supply interpolation values.
deployment_setting() {
  local key="$1" file="${2:-$ENV_FILE}" line name value="" variable replacement rest result i
  local -a names=() values=()
  if printenv "$key" >/dev/null 2>&1; then
    printenv "$key"
    return
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    parse_deployment_value "${BASH_REMATCH[2]}" || continue
    if [[ "$interpolate_value" == true ]]; then
      rest="$parsed_value"
      result=""
      while [[ -n "$rest" ]]; do
        if [[ "$rest" =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; then
          variable="${BASH_REMATCH[1]}"
          i="${#BASH_REMATCH[0]}"
          replacement=""
          if replacement=$(printenv "$variable" 2>/dev/null); then
            :
          else
            for ((i = ${#names[@]} - 1; i >= 0; i--)); do
              if [[ "${names[i]}" == "$variable" ]]; then
                replacement="${values[i]}"
                break
              fi
            done
            i="${#BASH_REMATCH[0]}"
          fi
          result+="$replacement"
          rest="${rest:i}"
        else
          result+="${rest:0:1}"
          rest="${rest:1}"
        fi
      done
      parsed_value="$result"
    fi
    names+=("$name")
    values+=("$parsed_value")
    [[ "$name" == "$key" ]] && value="$parsed_value"
  done < "$file"
  printf '%s' "$value"
}

resolve_computer_image_ref() {
  local explicit image tag channel version
  explicit=$(deployment_setting ARDURBOT_COMPUTER_IMAGE_REF)
  if [[ -n "$explicit" ]]; then
    export ARDURBOT_COMPUTER_IMAGE_REF="$explicit"
    return
  fi
  image=$(deployment_setting ARDURBOT_COMPUTER_IMAGE)
  if [[ -n "$image" ]]; then
    # Compose uses the name plus optional legacy tag instead of this default.
    export ARDURBOT_COMPUTER_IMAGE_REF="ghcr.io/ardurai/ardur-bot/computer:dev"
    return
  fi
  tag=$(deployment_setting ARDURBOT_IMAGE_TAG)
  channel=$(deployment_setting ARDURBOT_COMPUTER_CHANNEL)
  if [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
    version="${BASH_REMATCH[1]}"
  elif [[ "$tag" == "" || "$tag" == "edge" ]]; then
    version=$(deployment_setting ARDURBOT_APP_VERSION "$ENV_EXAMPLE")
  else
    fail "set ARDURBOT_COMPUTER_IMAGE_REF for this app image tag."
  fi
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
    || fail "the app version cannot select a computer image."
  case "$channel" in
    ""|dev) tag="dev" ;;
    release)
      tag="$version"
      ;;
    *) fail "ARDURBOT_COMPUTER_CHANNEL must be dev or release." ;;
  esac
  if [[ "$channel" == "" && -n "$version" && "$version" != *-* ]]; then
    tag="$version"
  fi
  export ARDURBOT_COMPUTER_IMAGE_REF="ghcr.io/ardurai/ardur-bot/computer:$tag"
}

download "$COMPOSE_FILE"
download "$ENV_EXAMPLE"

if [[ -e "$ENV_FILE" ]]; then
  echo "Keeping existing .env."
else
  create_env
fi

resolve_computer_image_ref
validate_required_secrets

if [[ "$prepare_only" == true ]]; then
  echo "Ardur files are ready. Edit .env, then run: bash install-images.sh"
  exit 0
fi

prepare_proxy_env
if [[ "$pull_never" == true ]]; then
  echo "Skipping image pull (--pull-never / --offline); images must already be on this Docker host."
else
  if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull; then
    fail "could not pull images. Shell HTTP_PROXY often does not reach the Docker daemon. Configure daemon proxy/registry-mirrors, set image env vars to a reachable registry, or preload images then compose up with --pull never."
  fi
fi
# `--wait` without `--wait-timeout` can hang on one-shot services (Compose < 2.7)
# or never return if a healthcheck stays red (Compose < 2.17). Prefer both flags.
compose_up_help=$(docker compose up --help 2>/dev/null || true)
up_pull_args=()
if [[ "$pull_never" == true ]]; then
  if grep -q -- '--pull' <<<"$compose_up_help"; then
    up_pull_args=(--pull never)
  else
    echo "cannot enforce pull-never on this Compose version; startup fails if an image is missing locally" >&2
  fi
fi
# bash 3.2 + set -u: "${arr[@]}" aborts when arr is empty.
if grep -q -- '--wait-timeout' <<<"$compose_up_help"; then
  echo "Waiting for healthy services."
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d ${up_pull_args[@]+"${up_pull_args[@]}"} --wait --wait-timeout 300
else
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d ${up_pull_args[@]+"${up_pull_args[@]}"}
fi

echo "Ardur is starting at http://127.0.0.1:5173"
