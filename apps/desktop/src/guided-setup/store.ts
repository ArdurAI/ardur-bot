import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  SetupJournal,
  SetupSnapshot,
  SetupStepId,
  StepReceipt,
} from "@ardurbot/contracts/desktop-setup";
import { SetupJournalSchema } from "@ardurbot/contracts/desktop-setup";
import { readPrivateFile, writePrivateFile } from "../setup-store.js";

const MAX_JOURNAL_BYTES = 64 * 1024;

export type { SetupJournal, StepReceipt };
export type JournalLoad =
  | { kind: "fresh" | "corrupt" }
  | { kind: "newer" }
  | { kind: "loaded"; journal: SetupJournal };

export interface JournalFileBoundary {
  read(file: string, maxBytes: number): Promise<string | null>;
  write(file: string, text: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  ensure(dir: string): Promise<void>;
}

const realFiles: JournalFileBoundary = {
  read: readPrivateFile,
  write: writePrivateFile,
  exists: async (file) =>
    lstat(file).then(
      () => true,
      () => false,
    ),
  ensure: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
};

export class SetupJournalStore {
  readonly file: string;
  constructor(
    userDataDir: string,
    private readonly files: JournalFileBoundary = realFiles,
  ) {
    this.file = path.join(userDataDir, "guided-setup.json");
  }

  async load(): Promise<JournalLoad> {
    const raw = await this.files.read(this.file, MAX_JOURNAL_BYTES);
    if (raw === null) return { kind: (await this.files.exists(this.file)) ? "corrupt" : "fresh" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "corrupt" };
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (("version" in parsed && typeof parsed.version === "number" && parsed.version > 1) ||
        ("snapshot" in parsed &&
          typeof parsed.snapshot === "object" &&
          parsed.snapshot !== null &&
          (("schemaVersion" in parsed.snapshot &&
            typeof parsed.snapshot.schemaVersion === "number" &&
            parsed.snapshot.schemaVersion > 1) ||
            ("planVersion" in parsed.snapshot &&
              typeof parsed.snapshot.planVersion === "number" &&
              parsed.snapshot.planVersion > 1))))
    )
      return { kind: "newer" };
    const result = SetupJournalSchema.safeParse(parsed);
    return result.success ? { kind: "loaded", journal: result.data } : { kind: "corrupt" };
  }

  async save(journal: SetupJournal): Promise<void> {
    const value = SetupJournalSchema.parse(journal);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error("Setup journal is too large.");
    await this.files.ensure(path.dirname(this.file));
    await this.files.write(this.file, text);
  }
}

export function freshJournal(snapshot: SetupSnapshot): SetupJournal {
  return {
    version: 1,
    snapshot,
    pending: null,
    receipts: {} as Partial<Record<SetupStepId, StepReceipt>>,
  };
}
