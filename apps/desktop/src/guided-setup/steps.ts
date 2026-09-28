import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SetupDetail } from "@ardurbot/contracts/desktop-setup";
import type { LocalModeController } from "../local-mode.js";
import type { ArdurCommandInstaller } from "./command.js";
import type { SetupStep, StepVerification } from "./engine.js";
import type { StepReceipt } from "./store.js";

/** Provisional headroom for the embedded database and migrations; verify against packaged builds experimentally. */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const execFileAsync = promisify(execFile);
export interface PrerequisiteBoundary {
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  binaries(): Promise<boolean>;
  writable(): Promise<boolean>;
  freeBytes(): Promise<number>;
  translated(): Promise<boolean | null>;
  now(): number;
}

export function systemPrerequisites(input: {
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  userDataDir: string;
  binaries(): Promise<unknown>;
}): PrerequisiteBoundary {
  return {
    platform: input.platform,
    arch: input.arch,
    packaged: input.packaged,
    binaries: async () =>
      input.binaries().then(
        () => true,
        () => false,
      ),
    writable: async () => {
      const temporary = path.join(input.userDataDir, `.setup-${randomUUID()}.tmp`);
      try {
        await access(input.userDataDir, constants.W_OK);
        const file = await open(temporary, "wx", 0o600);
        await file.close();
        return true;
      } catch {
        return false;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
    freeBytes: async () => {
      const info = await statfs(input.userDataDir);
      return info.bavail * info.bsize;
    },
    translated: async () => {
      if (input.platform !== "darwin") return null;
      try {
        const result = await execFileAsync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], {
          timeout: 3000,
        });
        return result.stdout.trim() === "1";
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

export interface GuidedStepsDependencies {
  prerequisites: PrerequisiteBoundary;
  localMode: Pick<
    LocalModeController,
    "databaseReady" | "migrationsReady" | "prepareDatabase" | "applyMigrations" | "stop"
  >;
  command: ArdurCommandInstaller;
  ownership?: { databaseStartedHere: boolean };
}

function satisfied(now: number, evidence: string, details: SetupDetail[] = []): StepVerification {
  return { kind: "satisfied", checkedAt: now, evidence, details };
}
const noMutation: StepReceipt = { kind: "verified", proof: "preflight" };

export function firstGuidedSteps(deps: GuidedStepsDependencies): SetupStep[] {
  const stopOwnedDatabase = async () => {
    if (deps.ownership && !deps.ownership.databaseStartedHere) return;
    await deps.localMode.stop();
    if (deps.ownership) deps.ownership.databaseStartedHere = false;
  };
  const preflight = async (): Promise<StepVerification> => {
    const { prerequisites: p } = deps;
    const supported =
      (p.platform === "darwin" && ["arm64", "x64"].includes(p.arch)) ||
      (p.platform === "linux" && ["arm64", "x64"].includes(p.arch)) ||
      (p.platform === "win32" && p.arch === "x64");
    if (!supported) return { kind: "blocked", reasonCode: "unsupported-computer" };
    if (!(await p.binaries())) return { kind: "blocked", reasonCode: "embedded-binaries-missing" };
    if (!(await p.writable())) return { kind: "blocked", reasonCode: "app-data-unwritable" };
    let freeBytes: number;
    try {
      freeBytes = await p.freeBytes();
    } catch {
      return { kind: "blocked", reasonCode: "space-check-unavailable" };
    }
    if (freeBytes < MIN_FREE_BYTES) return { kind: "blocked", reasonCode: "insufficient-space" };
    const details: SetupDetail[] = [];
    if (p.platform === "darwin" && p.packaged) {
      details.push({
        code: "unsigned-preview",
        text: "This preview is unsigned and not notarized.",
      });
      if ((await p.translated()) === true) {
        details.push({ code: "rosetta", text: "This app is running with Rosetta." });
        details.push({ code: "native-download", text: "Download the Apple Silicon version" });
      }
    }
    return satisfied(p.now(), "computer-checked", details);
  };

  const databaseCheck = async (signal: AbortSignal): Promise<StepVerification> =>
    (await deps.localMode.databaseReady(signal))
      ? satisfied(deps.prerequisites.now(), "owned-data-folder")
      : { kind: "needed", reasonCode: "database-not-ready" };
  const migrationCheck = async (signal: AbortSignal): Promise<StepVerification> => {
    try {
      return (await deps.localMode.migrationsReady(signal))
        ? satisfied(deps.prerequisites.now(), "migration-history-checked")
        : { kind: "needed", reasonCode: "migrations-pending" };
    } catch {
      return { kind: "blocked", reasonCode: "migration-history-unsafe" };
    }
  };
  const commandCheck = async (): Promise<StepVerification> => {
    if (deps.prerequisites.platform === "win32")
      return { kind: "notApplicable", reasonCode: "command-unavailable" };
    const result = await deps.command.check();
    if (result === "ready") return satisfied(deps.prerequisites.now(), "command-target-checked");
    if (result === "collision")
      return {
        kind: "blocked",
        reasonCode: "command-collision",
        details: [
          {
            code: "command-collision",
            text: "Another app owns the ardur command. Skip this step, or remove or rename that command and retry.",
          },
        ],
      };
    return {
      kind: "needed",
      reasonCode: result === "waiting-path" ? "add-folder-to-path" : "command-absent",
      details:
        result === "waiting-path"
          ? [{ code: "add-folder-to-path", text: "Installed; add its folder to PATH" }]
          : [],
    };
  };

  return [
    {
      id: "prerequisites",
      revision: 1,
      requires: [],
      canSkip: false,
      check: preflight,
      run: async () => noMutation,
      verify: preflight,
      cancel: async () => undefined,
    },
    {
      id: "database",
      revision: 1,
      requires: ["prerequisites"],
      canSkip: false,
      check: (_, signal) => databaseCheck(signal),
      run: async (_, signal) => {
        const state = await deps.localMode.prepareDatabase(signal);
        if (state.phase === "failed") throw new Error("database-failed");
        if (deps.ownership) deps.ownership.databaseStartedHere = true;
        return { kind: "owned", proof: "owned-data-folder" };
      },
      verify: async (_, _receipt, signal) =>
        (await deps.localMode.databaseReady(signal))
          ? satisfied(deps.prerequisites.now(), "owned-data-folder")
          : { kind: "blocked", reasonCode: "database-ownership-unconfirmed" },
      cancel: stopOwnedDatabase,
    },
    {
      id: "migrations",
      revision: 1,
      requires: ["database"],
      canSkip: false,
      check: (_, signal) => migrationCheck(signal),
      run: async (_, signal) => {
        const state = await deps.localMode.applyMigrations(signal);
        if (state.phase === "failed") throw new Error("migration-failed");
        return { kind: "verified", proof: "migration-runner-settled" };
      },
      verify: (_, _receipt, signal) => migrationCheck(signal),
      cancel: stopOwnedDatabase,
    },
    {
      id: "command",
      revision: 1,
      requires: ["migrations"],
      canSkip: true,
      check: commandCheck,
      run: async () => deps.command.install(),
      verify: commandCheck,
      cancel: async () => {
        await deps.command.reconcile();
        await stopOwnedDatabase();
      },
      rollback: async () => deps.command.reconcile(),
    },
  ];
}
