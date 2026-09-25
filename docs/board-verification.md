# Board verification — 2026-09-24

## Automated checks

| Command | Result |
| --- | --- |
| `pnpm -r --workspace-concurrency=4 run check` | Passed across the workspace, including Expo. |
| `pnpm exec biome check --write .` followed by `pnpm lint` | Passed; existing repository warnings remain. |
| Targeted Vitest command below | 47 suites and 504 tests passed offline. The 4 initially skipped PostgreSQL tests subsequently passed on a disposable database. |
| `pnpm db:generate` | Passed; migration SQL is included. |
| `pnpm --filter @ardurbot/db migrate` on disposable PostgreSQL | Passed; table and run-column presence verified. |
| `VERIFY_DATABASE=1 pnpm exec vitest run --maxWorkers=1 packages/adapters/src/wakeup.postgres.test.ts` | All 4 tests passed on disposable PostgreSQL. |
| Final API / Board / Team / routing follow-up | 6 suites and 22 tests passed. |
| Date-preservation regression and Board / Team / routing follow-up | 3 suites and 10 tests passed, including unchanged timestamp preservation and date clearing. |
| Headless web Board and Team E2E | Both tests passed; local screenshots captured. |
| `pnpm --filter @ardurbot/host-service build` | Passed. |
| `pnpm --filter @ardurbot/web intl:extract` | Passed for all nine catalogs. |
| Real `BeadsBoardProvider` and `BoardRunner` smoke | Passed with `bd version 1.2.2 (6c124203e)`. |

The PostgreSQL follow-up used the cached postgres:16-alpine image on a loopback
port. All migrations applied successfully, including board_workspaces,
board_commands and the four new run columns. The disposable container was
removed afterward. The owner's application database was not changed. The desktop
Playwright suite was not run because it opens native windows. Windows bundle
tests cover staging behavior, not a Windows runtime.

```sh
pnpm exec vitest run --maxWorkers=4 \
  packages/host-runtime apps/host-service \
  packages/adapters/src/executor packages/adapters/src/board \
  packages/adapter-kit/src/registry.test.ts \
  packages/adapter-kit/src/background-jobs.test.ts \
  packages/adapters/src/background-job-handlers.test.ts \
  packages/adapters/src/wakeup.test.ts \
  packages/adapters/src/wakeup-graphile-host.test.ts \
  packages/adapters/src/wakeup.postgres.test.ts \
  packages/adapters/src/connector-registry.test.ts \
  packages/adapters/src/job-reconciler.test.ts \
  packages/core/src/action-approval.test.ts \
  packages/contracts/src/host-bridge.test.ts \
  apps/api/src/board.test.ts apps/api/src/board-bridge.test.ts \
  apps/api/src/host-bridge.test.ts apps/api/src/host-hub.test.ts \
  apps/api/src/thread-target.test.ts apps/api/src/remote-devices.test.ts \
  apps/web/src/pages/TeamBoard.test.tsx apps/web/src/pages/board \
  apps/web/src/App.test.tsx apps/mobile/lib/board.test.ts \
  apps/mobile/lib/board-screen.test.ts apps/mobile/lib/team-screen.test.ts
```

The fixtures invoke an offline fake `bd` executable. They cover parsing,
literal argv values, serialized access and queue deadlines, unsupported versions,
missing binaries, workspace and metadata confinement, bridge authorization,
tool approval behavior, dispatch metadata, completion recovery, job replay
prevention, all five columns, empty state, graph keyboard access, routing and
mobile rendering/translations.

## Manual acceptance

1. Apply the included migration through the normal app migration workflow, start
   the application, and open `/app/board` from Board beside Team. In packaged
   mode, keep the owner host service connected; source mode needs the worker.
2. Choose the default space board. It initializes on first use. For a registered
   empty folder, choose Start a board in this folder and inspect the file list.
3. Create Prepare schema as a P1 task with acceptance criteria. Create Build view
   as a feature; under More, choose Prepare schema in Blocked by.
4. Confirm Prepare schema appears under Ready and Build view under Blocked. Open
   each item and check the Blocks / Blocked by direction.
5. Open Prepare schema and choose Send to a reachable bot. Confirm In progress
   and the bot assignee, then inspect the normal conversation turn. Leave Close
   when the bot reports done off to retain human closing.
6. Let the bot finish. Confirm the outcome comment, then choose Close. The item
   moves to Done and Build view becomes Ready.
7. Inspect Dependencies and Epics, then Export and check the displayed JSONL path.
8. On mobile, open Board from the home screen and verify the Ready list and item
   view. Creating, updating and closing are not offered on this surface.

The complete UI-to-real-bot walkthrough has not been driven manually. The
headless browser run exercised real signup, onboarding and shell navigation with
fixture Board RPC data; both Board and Team passed. The screenshot is written to
`apps/web/test-results/board-Board-route-shows-dependencies-across-five-columns-chromium/beads-board.png`.
The new `apps/web/e2e/board.spec.ts` will also capture it in CI after publication.
There is no CI artifact link because these changes were not pushed.

```sh
pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec='(^|/)(board|team-board)\.spec\.ts$'
```

The local run used dedicated API/web ports and set `DOCKER_HOST` to the current
Docker context, with `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
The harness supplied disposable PostgreSQL and offline runtime/provider
emulators. The initial broader filename match exposed an existing Team test
locator ambiguity: its Tokens assertion matched two bot rows. Scoping the
assertion to the expanded Reviewer row fixed it without changing Team behavior.

## Real Beads command evidence

The actual provider ran in a newly created system temporary directory. The
commands below spell out the argv passed through the runner; placeholders
replace only temporary filesystem locations. `board-owner` and `bot:builder`
are synthetic actors. Command JSON is the real output, not fixture output.
Init and export show the runner's structured result; export file contents follow
the export result. Repeated version probes are omitted.

All calls use the child-only environment documented in [Board](board.md).
`$TMP_BOARD` denotes the confined workspace. The init command used that cwd
rather than `-C`; subsequent calls use `-C`. Initialization also ran:

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" config set types.custom spike,story,milestone
```

The provider first checked `bd --version --json --actor board-owner` and parsed
`bd version 1.2.2 (6c124203e)`. The full operation sequence follows.

### 1. init

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off init --non-interactive --skip-agents --skip-hooks --stealth --prefix board
```

```json
{
  "ok": true,
  "version": "1.2.2",
  "path": "$TMP_BOARD"
}
```

### 2. create --title 'Prepare schema' --description 'Define the shared contract' --acceptance 'Contract tests pass' --type task --priority 1

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" create --title 'Prepare schema' --description 'Define the shared contract' --acceptance 'Contract tests pass' --type task --priority 1
```

```json
{
  "acceptance_criteria": "Contract tests pass",
  "created_at": "2026-09-24T21:16:44.171317Z",
  "created_by": "board-owner",
  "description": "Define the shared contract",
  "id": "board-9ae",
  "issue_type": "task",
  "priority": 1,
  "schema_version": 1,
  "status": "open",
  "title": "Prepare schema",
  "updated_at": "2026-09-24T21:16:44.171317Z"
}
```

### 3. show --include-comments --include-dependents board-9ae

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" show --include-comments --include-dependents board-9ae
```

```json
[
  {
    "id": "board-9ae",
    "title": "Prepare schema",
    "description": "Define the shared contract",
    "acceptance_criteria": "Contract tests pass",
    "status": "open",
    "priority": 1,
    "issue_type": "task",
    "created_at": "2026-09-24T21:16:44Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:44Z",
    "dependent_count": 0,
    "dependency_count": 0,
    "comment_count": 0
  }
]
```

### 4. history board-9ae --limit 100

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" history board-9ae --limit 100
```

```json
null
```

### 5. create --title 'Build view' --type feature --priority 2

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" create --title 'Build view' --type feature --priority 2
```

```json
{
  "created_at": "2026-09-24T21:16:45.681603Z",
  "created_by": "board-owner",
  "id": "board-5fr",
  "issue_type": "feature",
  "priority": 2,
  "schema_version": 1,
  "status": "open",
  "title": "Build view",
  "updated_at": "2026-09-24T21:16:45.681603Z"
}
```

### 6. dep add board-5fr board-9ae --type blocks

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" dep add board-5fr board-9ae --type blocks
```

```json
{
  "depends_on_id": "board-9ae",
  "issue_id": "board-5fr",
  "schema_version": 1,
  "status": "added",
  "type": "blocks"
}
```

### 7. show --include-comments --include-dependents board-5fr

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" show --include-comments --include-dependents board-5fr
```

```json
[
  {
    "id": "board-5fr",
    "title": "Build view",
    "status": "open",
    "priority": 2,
    "issue_type": "feature",
    "created_at": "2026-09-24T21:16:46Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:46Z",
    "dependencies": [
      {
        "id": "board-9ae",
        "title": "Prepare schema",
        "description": "Define the shared contract",
        "acceptance_criteria": "Contract tests pass",
        "status": "open",
        "priority": 1,
        "issue_type": "task",
        "created_at": "2026-09-24T21:16:44Z",
        "created_by": "board-owner",
        "updated_at": "2026-09-24T21:16:44Z",
        "dependency_type": "blocks"
      }
    ],
    "dependent_count": 0,
    "dependency_count": 1,
    "comment_count": 0
  }
]
```

### 8. history board-5fr --limit 100

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" history board-5fr --limit 100
```

```json
null
```

### 9. ready --limit 0

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" ready --limit 0
```

```json
[
  {
    "id": "board-9ae",
    "title": "Prepare schema",
    "description": "Define the shared contract",
    "acceptance_criteria": "Contract tests pass",
    "status": "open",
    "priority": 1,
    "issue_type": "task",
    "created_at": "2026-09-24T21:16:44Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:44Z",
    "dependency_count": 0,
    "dependent_count": 1,
    "comment_count": 0
  }
]
```

### 10. blocked

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" blocked
```

```json
[
  {
    "id": "board-5fr",
    "title": "Build view",
    "status": "open",
    "priority": 2,
    "issue_type": "feature",
    "created_at": "2026-09-24T21:16:46Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:46Z",
    "blocked_by_count": 1,
    "blocked_by": [
      "board-9ae"
    ]
  }
]
```

### 11. ready --claim

```sh
bd --json --actor bot:builder --sandbox --dolt-auto-commit off -C "$TMP_BOARD" ready --claim
```

```json
[
  {
    "id": "board-9ae",
    "title": "Prepare schema",
    "description": "Define the shared contract",
    "acceptance_criteria": "Contract tests pass",
    "status": "in_progress",
    "priority": 1,
    "issue_type": "task",
    "assignee": "bot:builder",
    "created_at": "2026-09-24T21:16:44Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:48Z",
    "started_at": "2026-09-24T21:16:48Z",
    "dependency_count": 0,
    "dependent_count": 1,
    "comment_count": 0
  }
]
```

### 12. update board-9ae --description 'Contract verified' --set-metadata ardur_close_when_done=true

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" update board-9ae --description 'Contract verified' --set-metadata ardur_close_when_done=true
```

```json
[
  {
    "id": "board-9ae",
    "title": "Prepare schema",
    "description": "Contract verified",
    "acceptance_criteria": "Contract tests pass",
    "status": "in_progress",
    "priority": 1,
    "issue_type": "task",
    "assignee": "bot:builder",
    "created_at": "2026-09-24T21:16:44Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:48Z",
    "started_at": "2026-09-24T21:16:48Z",
    "metadata": {
      "ardur_close_when_done": true
    }
  }
]
```

### 13. show --include-comments --include-dependents board-9ae

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" show --include-comments --include-dependents board-9ae
```

```json
[
  {
    "id": "board-9ae",
    "title": "Prepare schema",
    "description": "Contract verified",
    "acceptance_criteria": "Contract tests pass",
    "status": "in_progress",
    "priority": 1,
    "issue_type": "task",
    "assignee": "bot:builder",
    "created_at": "2026-09-24T21:16:44Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:48Z",
    "started_at": "2026-09-24T21:16:48Z",
    "metadata": {
      "ardur_close_when_done": true
    },
    "dependents": [
      {
        "id": "board-5fr",
        "title": "Build view",
        "status": "open",
        "priority": 2,
        "issue_type": "feature",
        "created_at": "0001-01-01T00:00:00Z",
        "updated_at": "0001-01-01T00:00:00Z",
        "dependency_type": "blocks"
      }
    ],
    "dependent_count": 1,
    "dependency_count": 0,
    "comment_count": 0
  }
]
```

### 14. history board-9ae --limit 100

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" history board-9ae --limit 100
```

```json
null
```

### 15. comments add -- board-9ae 'Contract checked'

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" comments add -- board-9ae 'Contract checked'
```

```json
{
  "author": "board-owner",
  "created_at": "2026-09-24T21:16:49.410159Z",
  "id": "01a0d547-3782-7efb-874e-8daf7241d00b",
  "issue_id": "board-9ae",
  "schema_version": 1,
  "text": "Contract checked"
}
```

### 16. show --include-comments --include-dependents board-9ae

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" show --include-comments --include-dependents board-9ae
```

```json
[
  {
    "id": "board-9ae",
    "title": "Prepare schema",
    "description": "Contract verified",
    "acceptance_criteria": "Contract tests pass",
    "status": "in_progress",
    "priority": 1,
    "issue_type": "task",
    "assignee": "bot:builder",
    "created_at": "2026-09-24T21:16:44Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:48Z",
    "started_at": "2026-09-24T21:16:48Z",
    "metadata": {
      "ardur_close_when_done": true
    },
    "dependents": [
      {
        "id": "board-5fr",
        "title": "Build view",
        "status": "open",
        "priority": 2,
        "issue_type": "feature",
        "created_at": "0001-01-01T00:00:00Z",
        "updated_at": "0001-01-01T00:00:00Z",
        "dependency_type": "blocks"
      }
    ],
    "comments": [
      {
        "id": "01a0d547-3782-7efb-874e-8daf7241d00b",
        "issue_id": "board-9ae",
        "author": "board-owner",
        "text": "Contract checked",
        "created_at": "2026-09-24T21:16:49Z"
      }
    ],
    "dependent_count": 1,
    "dependency_count": 0,
    "comment_count": 1
  }
]
```

### 17. history board-9ae --limit 100

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" history board-9ae --limit 100
```

```json
null
```

### 18. graph --all

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" graph --all
```

```json
[
  {
    "Root": {
      "id": "board-9ae",
      "title": "Prepare schema",
      "description": "Contract verified",
      "acceptance_criteria": "Contract tests pass",
      "status": "in_progress",
      "priority": 1,
      "issue_type": "task",
      "assignee": "bot:builder",
      "created_at": "2026-09-24T21:16:44Z",
      "created_by": "board-owner",
      "updated_at": "2026-09-24T21:16:48Z",
      "started_at": "2026-09-24T21:16:48Z",
      "metadata": {
        "ardur_close_when_done": true
      }
    },
    "Issues": [
      {
        "id": "board-5fr",
        "title": "Build view",
        "status": "open",
        "priority": 2,
        "issue_type": "feature",
        "created_at": "2026-09-24T21:16:46Z",
        "created_by": "board-owner",
        "updated_at": "2026-09-24T21:16:46Z"
      },
      {
        "id": "board-9ae",
        "title": "Prepare schema",
        "description": "Contract verified",
        "acceptance_criteria": "Contract tests pass",
        "status": "in_progress",
        "priority": 1,
        "issue_type": "task",
        "assignee": "bot:builder",
        "created_at": "2026-09-24T21:16:44Z",
        "created_by": "board-owner",
        "updated_at": "2026-09-24T21:16:48Z",
        "started_at": "2026-09-24T21:16:48Z",
        "metadata": {
          "ardur_close_when_done": true
        }
      }
    ],
    "Dependencies": [
      {
        "issue_id": "board-5fr",
        "depends_on_id": "board-9ae",
        "type": "blocks",
        "created_at": "2026-09-24T16:16:46Z",
        "created_by": "board-owner",
        "metadata": "{}"
      }
    ],
    "IssueMap": {
      "board-5fr": {
        "id": "board-5fr",
        "title": "Build view",
        "status": "open",
        "priority": 2,
        "issue_type": "feature",
        "created_at": "2026-09-24T21:16:46Z",
        "created_by": "board-owner",
        "updated_at": "2026-09-24T21:16:46Z"
      },
      "board-9ae": {
        "id": "board-9ae",
        "title": "Prepare schema",
        "description": "Contract verified",
        "acceptance_criteria": "Contract tests pass",
        "status": "in_progress",
        "priority": 1,
        "issue_type": "task",
        "assignee": "bot:builder",
        "created_at": "2026-09-24T21:16:44Z",
        "created_by": "board-owner",
        "updated_at": "2026-09-24T21:16:48Z",
        "started_at": "2026-09-24T21:16:48Z",
        "metadata": {
          "ardur_close_when_done": true
        }
      }
    },
    "VarDefs": null,
    "Phase": "",
    "Pour": false
  }
]
```

### 19. close board-9ae --reason Verified

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" close board-9ae --reason Verified
```

```json
[
  {
    "id": "board-9ae",
    "title": "Prepare schema",
    "description": "Contract verified",
    "acceptance_criteria": "Contract tests pass",
    "status": "closed",
    "priority": 1,
    "issue_type": "task",
    "assignee": "bot:builder",
    "created_at": "2026-09-24T21:16:44Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:51Z",
    "started_at": "2026-09-24T21:16:48Z",
    "closed_at": "2026-09-24T21:16:51Z",
    "close_reason": "Verified",
    "metadata": {
      "ardur_close_when_done": true
    }
  }
]
```

### 20. export

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" export
```

```json
{
  "ok": true,
  "path": "$APP_HOME/board-exports/space/<export id>.jsonl"
}
```

The exported file contained these two JSONL records:

```jsonl
{"_type":"issue","id":"board-9ae","title":"Prepare schema","description":"Contract verified","acceptance_criteria":"Contract tests pass","status":"closed","priority":1,"issue_type":"task","assignee":"bot:builder","created_at":"2026-09-24T21:16:44Z","created_by":"board-owner","updated_at":"2026-09-24T21:16:51Z","started_at":"2026-09-24T21:16:48Z","closed_at":"2026-09-24T21:16:51Z","close_reason":"Verified","metadata":{"ardur_close_when_done":true},"comments":[{"id":"01a0d547-3782-7efb-874e-8daf7241d00b","issue_id":"board-9ae","author":"board-owner","text":"Contract checked","created_at":"2026-09-24T21:16:49Z"}],"dependency_count":0,"dependent_count":1,"comment_count":1}
{"_type":"issue","id":"board-5fr","title":"Build view","status":"open","priority":2,"issue_type":"feature","created_at":"2026-09-24T21:16:46Z","created_by":"board-owner","updated_at":"2026-09-24T21:16:46Z","dependencies":[{"issue_id":"board-5fr","depends_on_id":"board-9ae","type":"blocks","created_at":"2026-09-24T16:16:46Z","created_by":"board-owner","metadata":"{}"}],"dependency_count":1,"dependent_count":0,"comment_count":0}
```

### 21. ready --limit 0

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" ready --limit 0
```

```json
[
  {
    "id": "board-5fr",
    "title": "Build view",
    "status": "open",
    "priority": 2,
    "issue_type": "feature",
    "created_at": "2026-09-24T21:16:46Z",
    "created_by": "board-owner",
    "updated_at": "2026-09-24T21:16:46Z",
    "dependencies": [
      {
        "issue_id": "board-5fr",
        "depends_on_id": "board-9ae",
        "type": "blocks",
        "created_at": "2026-09-24T16:16:46Z",
        "created_by": "board-owner",
        "metadata": "{}"
      }
    ],
    "dependency_count": 1,
    "dependent_count": 0,
    "comment_count": 0
  }
]
```

## Filing metadata in one update — 2026-09-25

`bd update --help` from `bd version 1.2.2` lists the flag as repeatable:

```text
      --set-metadata stringArray     Set metadata key=value (repeatable, e.g., --set-metadata team=platform)
```

On a new temporary board initialized as above, one update carried all three
filing keys, and `show` returned them together:

```sh
bd --json --actor board-owner --sandbox --dolt-auto-commit off -C "$TMP_BOARD" update board-<id> --set-metadata ardur_run_id=run-1 --set-metadata ardur_bot_id=builder --set-metadata ardur_filed_by=Builder
```

```json
{ "ardur_bot_id": "builder", "ardur_run_id": "run-1", "ardur_filed_by": "Builder" }
```

The temporary board was removed afterwards.

## Initialization isolation evidence

A separate temporary folder test used a Git repository with a sentinel agents
file. A hash inventory of every Git file was identical before and after init,
and the agents file was unchanged. The child PATH then omitted `dolt`; embedded
initialization and a Ready read still succeeded. Both temporary workspaces were
removed in finally blocks after recording these results.

```json
{
  "version": "bd version 1.2.2 (6c124203e)",
  "withoutDolt": {
    "ok": true
  },
  "initialFiles": [
    ".gitignore",
    ".local_version",
    "README.md",
    "config.yaml",
    "embeddeddolt",
    "interactions.jsonl",
    "metadata.json"
  ],
  "withoutDoltReady": {
    "ok": true,
    "stdout": "[]\n"
  },
  "prefixResult": "{\n  \"key\": \"issue_prefix\",\n  \"schema_version\": 1,\n  \"value\": \"isolated\"\n}\n",
  "folderInit": {
    "ok": true,
    "version": "1.2.2"
  },
  "gitUnchanged": true,
  "agentsUnchanged": true
}
```

## Remaining acceptance boundaries

- The migration applied successfully to disposable PostgreSQL; the owner's
  application database still needs the normal migration workflow.
- No complete packaged UI-to-host-to-real-bot turn or native device session was
  driven manually. The browser screenshot and offline boundary tests passed.
- New boards have no committed version history because automatic Dolt commits are
  disabled. Existing committed history is parsed and shown.
- Server-backed or redirected databases and versions outside 1.2.x are rejected.
- No commits, pushes, remotes, software installations or repository renames were
  performed for this feature.

## Files changed

- `apps/api/src/app.ts`
- `apps/api/src/board-bridge.test.ts`
- `apps/api/src/board.test.ts`
- `apps/api/src/board.ts`
- `apps/api/src/host-bridge.ts`
- `apps/api/src/host-hub.ts`
- `apps/api/src/remote-devices.test.ts`
- `apps/api/src/remote-devices.ts`
- `apps/api/src/router.ts`
- `apps/api/src/thread-target.test.ts`
- `apps/api/src/thread-target.ts`
- `apps/host-service/src/bundle.test.ts`
- `apps/mobile/app/board.tsx`
- `apps/mobile/app/index.tsx`
- `apps/mobile/lib/board-screen.test.ts`
- `apps/mobile/lib/board.test.ts`
- `apps/mobile/lib/board.ts`
- `apps/mobile/lib/locales/ru.ts`
- `apps/mobile/lib/locales/zh.ts`
- `apps/web/e2e/board.spec.ts`
- `apps/web/e2e/team-board.spec.ts`
- `apps/web/src/App.test.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/locales/de/messages.po`
- `apps/web/src/locales/en/messages.po`
- `apps/web/src/locales/es/messages.po`
- `apps/web/src/locales/hi/messages.po`
- `apps/web/src/locales/ko/messages.po`
- `apps/web/src/locales/pt-BR/messages.po`
- `apps/web/src/locales/ru/messages.po`
- `apps/web/src/locales/tr/messages.po`
- `apps/web/src/locales/zh-CN/messages.po`
- `apps/web/src/pages/Shell.tsx`
- `apps/web/src/pages/board/Board.test.tsx`
- `apps/web/src/pages/board/Board.tsx`
- `apps/web/src/pages/board/Graph.tsx`
- `apps/web/src/pages/board/ItemForm.tsx`
- `apps/worker/src/index.ts`
- `docs/board-verification.md`
- `docs/board.md`
- `packages/adapter-kit/src/background-jobs.test.ts`
- `packages/adapter-kit/src/background-jobs.ts`
- `packages/adapter-kit/src/board.ts`
- `packages/adapter-kit/src/index.ts`
- `packages/adapter-kit/src/types.ts`
- `packages/adapters/src/background-job-handlers.ts`
- `packages/adapters/src/board/beads.test.ts`
- `packages/adapters/src/board/beads.ts`
- `packages/adapters/src/board/fixtures/bd`
- `packages/adapters/src/board/fixtures/responses.json`
- `packages/adapters/src/board/reconcile.test.ts`
- `packages/adapters/src/board/reconcile.ts`
- `packages/adapters/src/board/service.test.ts`
- `packages/adapters/src/board/service.ts`
- `packages/adapters/src/board/test-fixture.ts`
- `packages/adapters/src/board/tools.test.ts`
- `packages/adapters/src/board/tools.ts`
- `packages/adapters/src/board/worker.test.ts`
- `packages/adapters/src/board/worker.ts`
- `packages/adapters/src/builtin-tools.ts`
- `packages/adapters/src/executor.ts`
- `packages/adapters/src/index.ts`
- `packages/adapters/src/job-reconciler.ts`
- `packages/adapters/src/wakeup-graphile-host.test.ts`
- `packages/adapters/src/wakeup.postgres.test.ts`
- `packages/adapters/src/wakeup.test.ts`
- `packages/contracts/package.json`
- `packages/contracts/src/board.ts`
- `packages/contracts/src/host-bridge.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/rpc.ts`
- `packages/core/src/action-approval.ts`
- `packages/db/prisma/migrations/20260925110000_beads_board/migration.sql`
- `packages/db/prisma/schema.prisma`
- `packages/host-runtime/src/board/argv.ts`
- `packages/host-runtime/src/board/runner.test.ts`
- `packages/host-runtime/src/board/runner.ts`
- `packages/host-runtime/src/host-agent.test.ts`
- `packages/host-runtime/src/host-agent.ts`
