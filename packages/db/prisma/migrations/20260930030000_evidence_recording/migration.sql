ALTER TABLE "runs" ADD COLUMN "evidenceGapCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "evidence_keys" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "kid" TEXT NOT NULL UNIQUE,
  "publicKeyPem" TEXT NOT NULL,
  "privateKeyCiphertext" TEXT NOT NULL,
  "secretRecordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3)
);
CREATE INDEX "evidence_keys_spaceId_idx" ON "evidence_keys"("spaceId");
CREATE UNIQUE INDEX "evidence_keys_active_space" ON "evidence_keys"("spaceId") WHERE "revokedAt" IS NULL;

CREATE TABLE "evidence_records" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "runId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL CHECK ("seq" >= 0),
  "receiptId" TEXT NOT NULL UNIQUE,
  "kid" TEXT NOT NULL,
  "jws" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "parentSha256" TEXT,
  "verdict" TEXT NOT NULL,
  "decisionKind" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_records_runId_seq_key" UNIQUE ("runId", "seq")
);
CREATE INDEX "evidence_records_runId_idx" ON "evidence_records"("runId");
CREATE INDEX "evidence_records_spaceId_idx" ON "evidence_records"("spaceId");

CREATE TABLE "evidence_seals" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "runId" TEXT NOT NULL UNIQUE,
  "jws" TEXT NOT NULL,
  "headSha256" TEXT NOT NULL,
  "recordCount" INTEGER NOT NULL,
  "gapCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "evidence_seals_spaceId_idx" ON "evidence_seals"("spaceId");

CREATE FUNCTION ardur_evidence_add_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ardur.evidence_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Evidence is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER evidence_records_add_only BEFORE UPDATE OR DELETE ON "evidence_records"
  FOR EACH ROW EXECUTE FUNCTION ardur_evidence_add_only();
CREATE TRIGGER evidence_seals_add_only BEFORE UPDATE OR DELETE ON "evidence_seals"
  FOR EACH ROW EXECUTE FUNCTION ardur_evidence_add_only();

CREATE FUNCTION ardur_evidence_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('ardur.evidence_delete', true) = 'on' THEN RETURN OLD; END IF;
  ELSIF OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL
    AND (to_jsonb(NEW) - 'revokedAt') = (to_jsonb(OLD) - 'revokedAt') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Evidence keys may only be revoked once' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER evidence_keys_guard BEFORE UPDATE OR DELETE ON "evidence_keys"
  FOR EACH ROW EXECUTE FUNCTION ardur_evidence_key_guard();
