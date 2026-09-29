# Computer profiles, Podman, and Kubernetes

For Fleet targets, capacity, placement, transport limits and verification, see [Fleet P1](fleet.md).

Status: implemented for offline verification; live acceptance is still required.

## Decisions and boundaries

`packages/contracts/src/computer-profiles.ts` is the profile registry. Standard is `base` and
remains the default. Developer is selected explicitly per computer. It contains Python,
Chromium, git, gh, glab, jq, Node.js 24.13.1 LTS, npm, ripgrep and curl. It adds no cloud CLIs.
Both profiles use `infra/sandboxes/computer/Dockerfile`; `IMAGE_PROFILE` selects the final stage.
Developer adds a dated Debian package snapshot (including Bookworm backports for the pinned
`glab` package) and the versioned Node image. These inputs are
versioned but are not content-addressed until real image digests are recorded.
The null digests in `packages/contracts/src/computer-image.js` mean no verified digest has been
recorded; they do not establish publication status. After publishing, record each manifest
SHA-256 there; every computer then prefers that digest over its tag.

`pnpm build:computers` (also `pnpm sandbox:build`) builds both profile tags and a `:local` alias for Standard.
`pnpm sandbox:build --podman` uses Podman. CI builds both profiles in an advisory job. The publish
workflow pushes both to `ghcr.io/ardurai/ardur-bot/computer`: Standard as `:dev` for prerelease app
versions and the exact version tag for releases, and Developer as the same tags with a
`-developer` suffix (`:dev-developer`, `:1.2.3-developer`). The organization owner must make the
GHCR `computer` package public after its first publish for anonymous pulls; Developer shares it.

Every computer resolves its image in one order (`resolveComputerImage` in
`packages/contracts/src/computer-image.js`): the image set on its connection, then
`ARDURBOT_COMPUTER_IMAGE` for Standard (with the legacy `ARDURBOT_COMPUTER_IMAGE_TAG` appended as
Compose does), then, on local Docker only, a local build, then a recorded digest, then the
published channel tag. `ARDURBOT_COMPUTER_CHANNEL=dev|release` overrides the channel. Local Docker
downloads a missing published image, Standard or Developer, once for concurrent bots, and never
silently replaces a locally built image. Kubernetes pods use `imagePullPolicy: IfNotPresent`, so
nodes pull the resolved name once and an image loaded into kind or minikube under that name works
offline. Docker and Podman engines added in Computers never pull during placement: pull the
resolved image into the engine first, or a computer stops with **Pull {image} into this engine,
then try again.**

When the desktop's host service reaches a cluster or engine for a server or Compose stack, it
cannot see the server's environment. It resolves the channel from its own app version and starts
only a published image. Set a mirror or private image on the
connection rather than in `ARDURBOT_COMPUTER_IMAGE`. A Kubernetes computer whose server image the
host would refuse stops with **Set this cluster's image under Advanced on its connection:
ARDURBOT_COMPUTER_IMAGE does not reach the machine that runs kubectl.**

Computer connections use the existing `connections` table with `connectorId=computer` and the
existing encrypted secret store. Only the deployment owner can add a connection or replace a
computer's configuration. **Edit** in Computers renames a connection or replaces its settings and
credentials, and asks first when runs are active on it. Web and Electron share Settings →
Computers. Mobile displays the image profile and unavailable capabilities without editing the
binding.

Kubeconfig accepts either a path on the server or inline contents. The server snapshots the
configuration, including certificate file references, into the encrypted secret store. Context
names are returned for selection; cluster names beginning `kind-` are marked local. Authentication
requires certificate or token credentials and verified HTTPS. Credential plugins (`exec` and
`auth-provider`) are refused: configuration does not authorize arbitrary programs on the server.
No kubeconfig, engine socket, host credential directory, or vendor login is placed in a computer.
Interactive vendor authentication and integration execution remain outside this change.

A confirmed profile/connection change is durable `ComputerUpdate.configuration` intent.
`queueComputerUpdate` refuses unconfirmed intent. The worker uses `replaceComputer` to claim the
existing maintenance reservation, checkpoint with the old connection, destroy the old computer,
save the new binding, and provision/restore. A checkpoint failure prevents an ordinary update
from destroying the computer. An already suspended Kubernetes computer uses its saved checkpoint.
The external `AgentHomeStore` checkpoint is never deleted by this flow. As in existing maintenance,
interrupted destructive work is not automatically replayed.
Kubernetes destroy waits for both pod and PVC deletion before a replacement can reuse their names;
sleep deletes only the pod.

## Provider behavior

| Operation | Docker / Podman | Kubernetes / kind |
| --- | --- | --- |
| Shell, files, checkpoint | Supervisor transports | Kubernetes API exec; files use Python and stdin |
| Sleep | Stop container, keep home | Delete pod, retain PVC |
| Wake | Start container | Recreate pod using retained PVC |
| Destroy | Remove container, retain external home | Remove pod then PVC, retain external checkpoint |
| Screen / takeover | Existing revocable screen gateway | Not available on this computer |
| Interactive terminal | Existing supervisor terminal contract | Not available on this computer |

The Kubernetes adapter uses one pod per computer in an existing, selected namespace. The home PVC
is `ReadWriteOnce`, defaults to 10Gi, and may select a storage class. CPU defaults are a 250m
request and a 2-core limit; memory defaults are a 256Mi request and a 2Gi limit. These are editable
connection settings. The pod runs as UID/GID 1000 with `fsGroup=1000`, drops capabilities, refuses
privilege escalation, uses RuntimeDefault seccomp, and does not mount a service-account token.
It requests no host paths, host networking, or privileged containers.

The transport is direct `pods/exec` over the API server websocket, using
`@kubernetes/client-node` **1.4.0**, **Apache-2.0**, the sole new external runtime dependency.
Stdout, stderr and remote exit status are separate; disconnect without status is a failure with
an uncertain outcome. Shell commands have an in-pod timeout so disconnect cannot leave unlimited
work. File writes use stdin, not the request URL, with a 16MiB per-file write limit. File reads
are bounded and paths are traversed with directory descriptors and no symlink following.
Writes are staged and atomically replaced. Kubernetes 1.31+ with exec protocol v5 is required
for file transfer's stdin half-close. Large workspaces may take longer than a shared local home.

No screen sidecar or port-forward is added in P1. The current supervisor gateway assumes Docker
container networking and owns per-bot screen leases and revocation. Port-forwarding a desktop
without adapting those controls would grant the wrong access. Files use exec instead; the
provider reports `graphical=false`, `takeover=false`, and `interactiveTerminal=false`. The API,
web/Electron and mobile render the unavailable state from capability flags. Screen and terminal
support need a later transport with the same lease and revocation tests.

Podman uses Docker's compatibility API through the same supervisor. The engine is detected from
version/info responses; rootless Podman uses `UsernsMode=keep-id:uid=1000,gid=1000` and `User=1000:1000`.
The generic connection `socket` accepts an absolute path or `unix://` URI. Supervisor startup
accepts `DOCKER_SOCKET`, `CONTAINER_HOST`, or a Unix `DOCKER_HOST`, then discovers an existing
Docker socket, a running macOS Podman machine socket, or Linux's rootless socket. It creates no
machine. Use a host-run supervisor and bind-mounted data with Podman; Docker volume-subpath
mounts are explicitly refused on Podman. The computer lifecycle needs no Compose command.
Readiness uses the existing computer control transport rather than Docker healthcheck JSON.
Docker inspects the selected image before create and downloads a missing published image once for
concurrent bots. Podman still requires an image already in its own store. The resolved name can be
pre-pulled into Docker or Podman. Kubernetes nodes pull the resolved name themselves.
A selected engine that disagrees with the socket's detected engine fails instead of falling back.
The deployment default preserves existing Dockerode `DOCKER_HOST`/TLS handling and its precedence
over socket discovery. Each saved connection is limited to a local Unix socket.

The namespace and PVC are local storage on kind. On hosted Kubernetes, requested resources and
retained PVC storage may incur charges even while a computer sleeps. No hosted service is needed.

## Hosted clusters (EKS, AKS, GKE)

Any cluster whose nodes pull images from a registry works the same way, managed or your own.

**Sign-in.** Hosted clusters' kubeconfigs usually sign in through a credential plugin (`aws eks
get-token`, `kubelogin`, `gke-gcloud-auth-plugin`). Ardur refuses those: a kubeconfig is data, and
honouring a plugin would let a pasted file run any program on the machine that reads it. Instead,
run `infra/sandboxes/kubernetes/make-kubeconfig.sh` once with your own admin context. It creates a
least-privilege account and writes a kubeconfig that signs in with that account's token:

```bash
infra/sandboxes/kubernetes/make-kubeconfig.sh --context <admin-context> --create-namespace
```

Before changing anything it checks that the server runs Kubernetes 1.31 or newer and uses HTTPS
with embedded CA data and verified TLS. It then creates the `ardurbot` namespace (only with
`--create-namespace`, enforcing the restricted Pod Security level), applies `serviceaccount.yaml`,
`role.yaml` and `rolebinding.yaml`, and writes `ardurbot-ardurbot.kubeconfig` with mode 600. It never
prints the token and never overwrites a file. By default the token comes from a
`kubernetes.io/service-account-token` Secret and does not expire; delete the
`ardurbot-computers-token` Secret to revoke it. `--duration 720h` issues a bound token with
`kubectl create token` instead; the cluster may shorten it, so rerun the script and replace the
connection's kubeconfig with **Edit** before it expires. The script ends with `kubectl auth can-i`
checks as the new account. `--namespace`, `--output`, `--with-capacity` and `--dry-run` (print the
manifests and commands, change nothing) are optional. Then, in **Settings → Computers → Add
computer**, choose **Kubernetes context**, enter the context `ardurbot` and your namespace, and
paste the file under **Kubeconfig**.

**Permissions.** `role.yaml` grants only what computers use: get, create and delete on pods and
persistent volume claims, and get and create on `pods/exec`. Free capacity needs cluster-wide reads
of nodes and pods, so it is not in the Role; apply the optional `capacity-clusterrole.yaml`, or pass
`--with-capacity`, to show it. Without it, capacity is unknown and computers still work. Turning a
computer's network off on Kubernetes needs Cilium and more permissions than the example grants.
`packages/host-runtime/src/fleet/kubernetes-access.ts` lists every permission each transport uses.

**Images.** Nodes pull `ghcr.io/ardurai/ardur-bot/computer` from public GHCR by default. For a
private or air-gapped registry, mirror both profiles' tags, set **Standard image** and **Developer
image** under **Advanced** on the connection, and create an image pull Secret in the namespace
yourself (for example with `kubectl create secret docker-registry`); enter its name as **Image pull
secret**. Ardur never creates Secrets.

**Storage.** A computer's home is a persistent volume claim that names no storage class unless you
enter one under **Resources**, so the cluster needs a default StorageClass (`kubectl get
storageclass` marks it `(default)`). On EKS, install the Amazon EBS CSI driver add-on, which needs
an IAM role through EKS Pod Identity or IAM roles for service accounts, and make an EBS StorageClass
the default. EKS Auto Mode provisions EBS volumes without the add-on but creates no StorageClass:
create one with the `ebs.csi.eks.amazonaws.com` provisioner. Fargate pods cannot mount EBS volumes.

**Network.** Whatever talks to the cluster must reach its API endpoint: the computer running the
Ardur desktop app when it connects the cluster for a server or Compose stack, otherwise the
server's API and worker. A private endpoint needs a VPN, peering or an allowlist that covers it.
Nodes must reach the image registry.

**Costs.** Pods and volumes bill while they exist. Sleep deletes the pod but keeps its volume, so a
sleeping computer still costs its storage. Removing the computer deletes both.

## Manual verification on macOS

Do this only after installing dependencies, applying the migration, and rerunning the offline
checks. The commands below build images and create a disposable local cluster; they were not run
as part of this implementation.

1. **Developer on Docker.** Start the existing local deployment and host-run supervisor with a
   writable `DATA_DIR` shared by API/worker/supervisor. Apply
   `20260924020000_computer_profiles` using the normal migration workflow. Run
   `pnpm install --no-frozen-lockfile`, `pnpm db:generate`, then `pnpm sandbox:build`.
   For a host-run supervisor on macOS, use the existing
   `SANDBOX_CONTROL_VIA_LOOPBACK=true` setting. Create a bot (its computer record is created by
   the existing bot lifecycle), then open Settings → Computers. Select **Developer (git,
   GitHub and GitLab CLIs, node, jq)**, Apply, and confirm **This replaces the computer's files.
   Continue?** Wait for maintenance to finish, then boot the computer. Ask its shell to run:
   `git --version; gh --version; glab --version; node --version; jq --version; rg --version`.
   Verify no vendor account is already authenticated. Save a workspace file, switch to Standard,
   cancel once and verify nothing changed, then confirm and verify the file/checkpoint survives.
   A Standard `git status` failure must direct the owner to Developer in one sentence.
2. **Switch to Podman.** If no machine exists, run `podman machine init`; then
   `podman machine start`. Get the socket with
   `podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'`.
   Run `pnpm sandbox:build --podman` so both tags exist in Podman's image store. In Settings →
   Computers → Add computer connection, select **Podman**, enter that socket and save. Select
   the connection for the computer, Apply and confirm. Settings must report **Engine: Podman**.
   Verify `id` inside the computer reports UID 1000 and that a shell can write to its home,
   export/read that file, sleep, wake, and retain it. Check the screen and revocation behavior.
   The data directory must exist inside the machine's shared host paths; do not mount any CLI
   credential directory. Docker and Podman image stores are separate. Preserve the checkpoint
   before changing back to Docker; verify that the selected engine never falls back silently.
3. **Run kind.** With the Docker daemon running, run `kind create cluster --name ardurbot`.
   kind nodes pull the published images on first use. To work offline or test local builds, load
   the resolved names, for a prerelease app
   `kind load docker-image ghcr.io/ardurai/ardur-bot/computer:dev ghcr.io/ardurai/ardur-bot/computer:dev-developer --name ardurbot`
   (`docker tag` a local build with those names first). With minikube, run
   `minikube image load <resolved name>` once per image, and give Ardur a kubeconfig with its
   certificate files embedded: `kubectl config view --minify --flatten --context minikube`.
   Run `kubectl --context kind-ardurbot create namespace ardurbot`. Confirm the cluster offers a
   default StorageClass. In Settings → Computers, add a **Kubernetes / kind** connection using
   a kubeconfig path accessible to the server (or paste a flattened kubeconfig into its encrypted
   field), List contexts, select **kind-ardurbot**, namespace **ardurbot**, and 10Gi storage.
   Save it, bind a computer to it, select Developer, Apply and confirm. Verify one pod and one
   PVC appear in that namespace; the shell returns stdout, stderr and a nonzero exit code.
   Save a file, stop the computer, and verify the pod is gone but the PVC remains. Boot it and
   verify the file survives. Let the idle-release job run and repeat that check. Replace the
   profile and confirm restoration from the external checkpoint. Screen and terminal must say
   **Not available on this computer**. Inspect the pod specification to confirm it has no
   service-account token, kubeconfig, vendor credentials, host paths, or elevated privileges.

For the local kind check, keep the API and worker on the host: kind's loopback API endpoint in
its generated kubeconfig is not reachable from an unrelated service container. For a shared
cluster, issue a separate credential with `make-kubeconfig.sh` (see
[Hosted clusters](#hosted-clusters-eks-aks-gke)); its Role grants only pod/PVC lifecycle and exec.
The application never creates clusters, namespaces, roles, Secrets or credentials; the owner runs
the script. Do not use customer or production contexts for this check.

## Manual verification on Linux

Enable the rootless API with `systemctl --user enable --now podman.socket`. Its socket is normally
`unix://${XDG_RUNTIME_DIR}/podman/podman.sock`. Use that URI in the same shared engine connection,
run a host supervisor as the owning user, and build with `pnpm sandbox:build --podman`. Repeat the
file-write/sleep/wake/profile/checkpoint checks above. Confirm the owner has subordinate UID/GID
ranges configured. On SELinux hosts, apply an appropriate container-file label to the dedicated
data directory; do not relabel home-wide credential directories or disable host policy globally.

## Official sources verified

- [Podman API service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html):
  Docker compatibility API, rootless socket, and socket trust boundary.
- [Podman machine inspect](https://docs.podman.io/en/latest/markdown/podman-machine-inspect.1.html):
  `ConnectionInfo.PodmanSocket.Path` and machine state on macOS.
- [Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html): keep-id UID/GID mapping,
  local image naming, and remote bind-mount semantics.
- [Podman compatibility create implementation](https://github.com/containers/podman/blob/main/pkg/api/handlers/compat/containers_create.go):
  `HostConfig.UsernsMode` maps to `UserNS`; `NanoCpus` maps to quota/period.
- [Kubernetes security contexts](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/):
  non-root identity, volume group ownership, seccomp and privilege escalation controls.
- [Kubernetes volume protection](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#storage-object-in-use-protection):
  deletion can remain pending while a pod uses its claim; replacement waits for completion.
- [Official JavaScript client 1.4.0](https://github.com/kubernetes-client/javascript/tree/1.4.0):
  licence, kubeconfig loading, API request middleware and websocket exec.
- [Exec implementation](https://github.com/kubernetes-client/javascript/blob/1.4.0/src/exec.ts)
  and [websocket channels](https://github.com/kubernetes-client/javascript/blob/1.4.0/src/web-socket-handler.ts):
  stdout/stderr/status and v5 stdin half-close.
- [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/): cluster creation and loading
  images into the cluster's separate image store.
- [minikube image](https://minikube.sigs.k8s.io/docs/commands/image/): `minikube image load` takes
  one image per call.
- [ServiceAccounts](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
  and [ServiceAccount administration](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/):
  long-lived `kubernetes.io/service-account-token` Secrets, which the control plane fills with
  `token`, `ca.crt` and `namespace` and which deleting revokes; unused-token cleanup applies only
  to auto-generated tokens, which a ServiceAccount lists in its `secrets` field.
- [`kubectl create token`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_token/):
  `--duration`, which the server may lengthen or shorten.
- [`kubectl auth can-i`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_auth/kubectl_auth_can-i/):
  `--subresource`, `--quiet` and its exit codes; [`kubectl config view`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_config/kubectl_config_view/):
  `--minify`, `--flatten` and `--raw`; [`kubectl version`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_version/)
  JSON output.
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/) and
  [Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/):
  the restricted controls and the `pod-security.kubernetes.io/enforce` namespace label.
- [`AuthorizePodWebsocketUpgradeCreatePermission`](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/):
  from 1.35 WebSocket exec also needs `create` on `pods/exec`, which the Role grants with `get`.
- [Amazon EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html) and
  [EKS Auto Mode storage classes](https://docs.aws.amazon.com/eks/latest/userguide/create-storage-class.html):
  the add-on and its IAM role, Auto Mode needing no add-on but creating no StorageClass, and EBS
  volumes being unavailable to Fargate pods.
- [Node.js 24.13.1](https://nodejs.org/en/blog/release/v24.13.1): the selected LTS version.
- [Debian glab](https://packages.debian.org/bookworm-backports/vcs/glab): Bookworm backports
  supplies version `1.33.0-1~bpo12+1` for both amd64 and arm64.

## Visible copy and personas

Builder: sees the selected profile, engine, context and resources; gets Developer tools without
installing them manually. Local-first user: can select Podman or kind without a hosted account.
Operator: Standard stays the default and its size is unchanged; replacement asks for confirmation.
Researcher: workspace checkpoints survive a provider/profile replacement. Team lead: replacement
uses the existing durable maintenance reservation and progress record across a shared computer.
Mobile users see the same profile and unsupported capabilities without runtime setup controls.

The profile labels and **Image profile** identify the saved choice. **Developer is a larger
download and uses more disk space.** appears at that choice because size is its direct trade-off.
**This replaces the computer's files. Continue?** appears only in the confirmation dialog.
**Not available on this computer** appears only for unsupported capabilities. Connection details
and resources are progressively disclosed under Add computer connection and Resources. **Standard
image** and **Developer image** (and, for Kubernetes, **Image pull secret**) sit under a collapsed
**Advanced** because only owners of private or air-gapped registries need them. **Pull {image} into
this engine, then try again.** and the cluster image sentence appear only after that failure. The kind
creation hint appears only while configuring Kubernetes. These sentences are necessary at the
point where the owner makes the corresponding choice; persistent explanations elsewhere are
not added. CI's `computer-profiles.spec.ts` captures the choice and confirmation screens; link its
actual artifact in a future PR after CI runs.
