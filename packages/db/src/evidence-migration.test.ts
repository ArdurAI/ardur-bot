import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const migration = read("../prisma/migrations/20261011000000_evidence_key_rotation/migration.sql");
const schema = read("../prisma/schema.prisma");
const dbSource = read("./evidence.ts");

describe("evidence key rotation migration", () => {
  it("adds every metadata column the EvidenceKey model declares", () => {
    const model = schema.match(/model EvidenceKey \{[\s\S]*?\n\}/)?.[0] ?? "";
    for (const field of [
      "version Int",
      "replacedAt DateTime?",
      "revokedAt DateTime?",
      "revokedReason String?",
    ]) {
      expect(model).toContain(field);
    }
    expect(migration).toContain('ADD COLUMN "version"');
    expect(migration).toContain('ADD COLUMN "replacedAt"');
    expect(migration).toContain('ADD COLUMN "revokedReason"');
    expect(migration).toContain('"evidence_keys_spaceId_version_key"');
  });

  it("permits the metadata written by replacement and emergency revocation", () => {
    // The only two transitions the store performs on an existing key row.
    expect(dbSource).toContain("data: { revokedAt: new Date(), replacedAt: new Date() }");
    expect(dbSource).toContain("data: { revokedAt: new Date(), revokedReason: args.reason }");
    // The guard must allow those metadata columns to change in the same single
    // update that revokes; requiring them to keep their nullness would reject
    // both transitions on a real database.
    expect(migration).not.toContain('(NEW."replacedAt" IS NULL) = (OLD."replacedAt" IS NULL)');
    expect(migration).not.toContain(
      '(NEW."revokedReason" IS NULL) = (OLD."revokedReason" IS NULL)',
    );
    // Every other column stays unchanged, and only null -> non-null revocation passes.
    expect(migration).toContain('OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL');
    expect(migration).toContain("to_jsonb(NEW) - ARRAY['revokedAt','replacedAt','revokedReason']");
    expect(migration).toContain("to_jsonb(OLD) - ARRAY['revokedAt','replacedAt','revokedReason']");
  });

  it("still refuses deletes and any second change to a key row", () => {
    expect(migration).toContain("TG_OP = 'DELETE'");
    expect(migration).toContain("ardur.evidence_delete");
    expect(migration).toContain("RAISE EXCEPTION 'Evidence keys may only be revoked once'");
  });
});
