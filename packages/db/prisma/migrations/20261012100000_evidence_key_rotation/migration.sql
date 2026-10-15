-- Evidence signing key rotation and emergency revocation (#254).
-- Additive: old rows keep version 1; public keys are retained for historical
-- verification and journals are never rewritten.

ALTER TABLE "evidence_keys" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "evidence_keys" ADD COLUMN "replacedAt" TIMESTAMP(3);
ALTER TABLE "evidence_keys" ADD COLUMN "revokedReason" TEXT;

CREATE UNIQUE INDEX "evidence_keys_spaceId_version_key" ON "evidence_keys"("spaceId", "version");

-- The guard still allows only the one-way move to a revoked state. That single
-- update may also set replacedAt/revokedReason: replacement and emergency
-- revocation write them together with revokedAt, so their nullness may change.
CREATE OR REPLACE FUNCTION ardur_evidence_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('ardur.evidence_delete', true) = 'on' THEN RETURN OLD; END IF;
  ELSIF OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['revokedAt','replacedAt','revokedReason'])
      = (to_jsonb(OLD) - ARRAY['revokedAt','replacedAt','revokedReason']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Evidence keys may only be revoked once' USING ERRCODE = '23514';
END;
$$;
