#!/usr/bin/env bash
# Creates a least-privilege account for Ardur computers in one namespace of a cluster (EKS, AKS,
# GKE or any other) and writes a kubeconfig that signs in with the account's token instead of a
# credential plugin. Run it with your own admin context. See docs/compute-profiles.md.
# Works with the bash 3.2 that macOS ships.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly ACCOUNT=ardurbot-computers
readonly MIN_MINOR=31
# Each check is "scope verb resource [subresource]". Tests keep these equal to the permissions the
# provider uses (packages/host-runtime/src/fleet/kubernetes-access.ts).
readonly REQUIRED=(
  "namespace get pods"
  "namespace create pods"
  "namespace delete pods"
  "namespace get persistentvolumeclaims"
  "namespace create persistentvolumeclaims"
  "namespace delete persistentvolumeclaims"
  "namespace get pods exec"
  "namespace create pods exec"
)
readonly CAPACITY=("cluster list nodes" "all list pods" "cluster list nodes.metrics.k8s.io")

usage() {
  cat <<'EOF'
Usage: make-kubeconfig.sh [options]

Creates the ardurbot-computers ServiceAccount, Role and RoleBinding in a namespace, then writes a
kubeconfig for Ardur that uses the account's token. Run it with an admin context for the cluster.

Options:
  --context NAME        Admin context to use (default: the current context)
  --namespace NAME      Namespace for computers (default: ardurbot)
  --create-namespace    Create the namespace if it does not exist
  --duration DURATION   Issue a token that expires after DURATION (for example 720h) instead of
                        a long-lived token Secret
  --with-capacity       Also grant read-only access to node and pod capacity
  --output FILE         Kubeconfig to write (default: ardurbot-NAMESPACE.kubeconfig); an existing
                        file is never overwritten
  --dry-run             Print the manifests and commands without changing anything
  -h, --help            Show this help
EOF
}

die() {
  printf 'make-kubeconfig: %s\n' "$*" >&2
  exit 1
}

context=""
namespace=ardurbot
create_namespace=false
duration=""
with_capacity=false
output=""
dry_run=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context | --namespace | --duration | --output)
      [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value."
      case "$1" in
        --context) context="$2" ;;
        --namespace) namespace="$2" ;;
        --duration) duration="$2" ;;
        --output) output="$2" ;;
      esac
      shift 2
      ;;
    --create-namespace) create_namespace=true && shift ;;
    --with-capacity) with_capacity=true && shift ;;
    --dry-run) dry_run=true && shift ;;
    -h | --help) usage && exit 0 ;;
    *) usage >&2 && die "Unknown option: $1" ;;
  esac
done

label_re='^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'
[[ "$namespace" =~ $label_re ]] || die "The namespace must be a DNS-1123 label, such as ardurbot."
duration_re='^([0-9]+(h|m|s))+$'
[[ -z "$duration" || "$duration" =~ $duration_re ]] ||
  die "Give --duration as hours, minutes or seconds, such as 720h."
output="${output:-ardurbot-${namespace}.kubeconfig}"
[[ "$output" != -* ]] || die "--output must be a file name."
[[ ! -e "$output" && ! -L "$output" ]] || die "$output already exists; choose another --output."

kube_args=()
[[ -z "$context" ]] || kube_args=(--context "$context")
kube() {
  kubectl ${kube_args[@]+"${kube_args[@]}"} "$@"
}
shown() {
  printf '$ kubectl'
  [[ -z "$context" ]] || printf ' --context %s' "$context"
  printf ' %s\n' "$*"
}

# The checked-in manifests use the ardurbot namespace; render them for the chosen one.
render() {
  sed -e "s/^\([[:space:]]*namespace:\) ardurbot\$/\1 ${namespace}/" \
    -e "s/^\([[:space:]]*name: ardurbot-computers-capacity-\)ardurbot\$/\1${namespace}/" \
    "$SCRIPT_DIR/$1"
}
account_manifests() {
  local file
  for file in serviceaccount.yaml role.yaml rolebinding.yaml; do
    printf -- '---\n'
    render "$file"
  done
}
namespace_manifest() {
  cat <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    pod-security.kubernetes.io/enforce: restricted
EOF
}
token_manifest() {
  cat <<EOF
apiVersion: v1
kind: Secret
type: kubernetes.io/service-account-token
metadata:
  name: ${ACCOUNT}-token
  namespace: ${namespace}
  annotations:
    kubernetes.io/service-account.name: ${ACCOUNT}
EOF
}
# can_i SCOPE VERB RESOURCE [SUBRESOURCE] asks the API server as the new account, with the new file.
can_i() {
  local args=(auth can-i --quiet "$2" "$3")
  [[ -z "${4:-}" ]] || args+=("--subresource=$4")
  case "$1" in
    namespace) args+=(-n "$namespace") ;;
    all) args+=(--all-namespaces) ;;
  esac
  kubectl --kubeconfig "$output" "${args[@]}"
}
command_for() {
  # shellcheck disable=SC2086 # A check is words: scope, verb, resource and subresource.
  set -- $1
  printf 'auth can-i %s %s' "$2" "$3"
  [[ -z "${4:-}" ]] || printf ' --subresource=%s' "$4"
  case "$1" in
    namespace) printf ' -n %s' "$namespace" ;;
    all) printf ' --all-namespaces' ;;
  esac
}

if $dry_run; then
  printf '# Dry run: nothing is applied. These are the commands and manifests.\n'
  shown "version -o json   # the server must be Kubernetes 1.${MIN_MINOR} or newer"
  shown "config view --minify --flatten --raw -o jsonpath=...   # HTTPS server and CA data"
  shown "get namespace ${namespace} --ignore-not-found -o name"
  if $create_namespace; then
    shown "create -f -   # only when the namespace is missing"
    namespace_manifest
  fi
  shown "apply -f -"
  account_manifests
  if $with_capacity; then
    shown "apply -f -"
    render capacity-clusterrole.yaml
  fi
  if [[ -n "$duration" ]]; then
    shown "create token ${ACCOUNT} -n ${namespace} --duration ${duration}"
  else
    shown "apply -f -"
    token_manifest
    shown "get secret ${ACCOUNT}-token -n ${namespace} -o jsonpath={.data.token}"
  fi
  printf '# Write %s (mode 600) with the server, CA data, token and namespace %s.\n' \
    "$output" "$namespace"
  for check in "${REQUIRED[@]}" "${CAPACITY[@]}"; do
    printf '$ kubectl --kubeconfig %s %s\n' "$output" "$(command_for "$check")"
  done
  exit 0
fi

command -v kubectl >/dev/null 2>&1 || die "kubectl is not installed or not on PATH."

version="$(kube version -o json 2>/dev/null | tr -d '\n' |
  sed -n 's/.*"serverVersion": *{[^}]*"gitVersion": *"\([^"]*\)".*/\1/p')" || version=""
version_re='^v([0-9]+)\.([0-9]+)'
[[ "$version" =~ $version_re ]] || die "Could not read the cluster's version; check the context."
if ((BASH_REMATCH[1] == 1 && BASH_REMATCH[2] < MIN_MINOR)); then
  die "The cluster runs ${version}; Ardur needs Kubernetes 1.${MIN_MINOR} or newer."
fi

# Check the connection details before changing anything in the cluster.
cluster() {
  kube config view --minify --flatten --raw -o "jsonpath={.clusters[0].cluster.$1}"
}
server="$(cluster server)"
ca="$(cluster certificate-authority-data)"
server_re='^https://[^[:space:]"\\]+$'
[[ "$server" =~ $server_re ]] || die "The cluster's API server must use HTTPS."
[[ "$(cluster insecure-skip-tls-verify)" != "true" ]] ||
  die "The context skips TLS verification; Ardur needs verified HTTPS."
ca_re='^[A-Za-z0-9+/=]+$'
[[ "$ca" =~ $ca_re ]] ||
  die "The context has no embedded CA data (certificate-authority-data) for its cluster."

if [[ -z "$(kube get namespace "$namespace" --ignore-not-found -o name)" ]]; then
  $create_namespace || die "Namespace ${namespace} does not exist. Create it, or add --create-namespace."
  namespace_manifest | kube create -f -
fi
account_manifests | kube apply -f -
if $with_capacity; then render capacity-clusterrole.yaml | kube apply -f -; fi

# Tokens stay in variables and the new file; nothing prints them.
if [[ -n "$duration" ]]; then
  token="$(kube create token "$ACCOUNT" -n "$namespace" --duration "$duration")"
else
  token_manifest | kube apply -f -
  # The token controller fills the Secret shortly after it is created.
  encoded=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    encoded="$(kube get secret "${ACCOUNT}-token" -n "$namespace" -o 'jsonpath={.data.token}')"
    [[ -z "$encoded" ]] || break
    sleep 3
  done
  [[ -n "$encoded" ]] || die "The cluster did not issue a token for ${ACCOUNT}-token."
  token="$(printf '%s' "$encoded" | base64 --decode)"
fi
token_re='^[A-Za-z0-9._-]+$'
[[ "$token" =~ $token_re ]] || die "The cluster returned a token in an unexpected format."

(
  umask 077
  set -o noclobber
  printf '%s\n' \
    "apiVersion: v1" \
    "kind: Config" \
    "clusters:" \
    "  - name: ardurbot" \
    "    cluster:" \
    "      server: \"${server}\"" \
    "      certificate-authority-data: ${ca}" \
    "users:" \
    "  - name: ${ACCOUNT}" \
    "    user:" \
    "      token: ${token}" \
    "contexts:" \
    "  - name: ardurbot" \
    "    context:" \
    "      cluster: ardurbot" \
    "      user: ${ACCOUNT}" \
    "      namespace: ${namespace}" \
    "current-context: ardurbot" >"$output"
)
chmod 600 "$output"

# New bindings reach the authorizer within moments; give them a few seconds before judging.
for _ in 1 2 3 4 5; do
  # shellcheck disable=SC2086 # A check is words: scope, verb, resource and subresource.
  ! can_i ${REQUIRED[0]} || break
  sleep 1
done
printf 'Permissions of %s in %s:\n' "$ACCOUNT" "$namespace"
missing=0
for check in "${REQUIRED[@]}"; do
  # shellcheck disable=SC2086
  if can_i $check; then printf '  yes  %s\n' "${check#* }"; else
    printf '  no   %s\n' "${check#* }"
    missing=1
  fi
done
for check in "${CAPACITY[@]}"; do
  # shellcheck disable=SC2086
  if can_i $check; then
    printf '  yes  %s (capacity)\n' "${check#* }"
  elif $with_capacity; then
    printf '  no   %s (capacity)\n' "${check#* }"
    missing=1
  else
    printf '  no   %s (optional; without it capacity shows as unknown)\n' "${check#* }"
  fi
done
((missing == 0)) || die "Some permissions are missing; check that the manifests applied."

printf '\nWrote %s (mode 600).\n' "$output"
printf 'In Ardur, open Settings, Computers, Add computer, Kubernetes context. Enter context "ardurbot"\n'
printf 'and namespace "%s", and paste this file under Kubeconfig.\n' "$namespace"
if [[ -n "$duration" ]]; then
  printf 'The token expires after %s or sooner if the cluster caps it; rerun this script and\n' \
    "$duration"
  printf 'replace the kubeconfig in the connection before then.\n'
else
  printf 'The token does not expire. Revoke it with: kubectl delete secret %s-token -n %s\n' \
    "$ACCOUNT" "$namespace"
fi
