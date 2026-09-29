-- Store what each delegation attempt actually reserved and why a cancellation was
-- requested, so settlement and stop reporting never fall back to a current constant.
-- Rows without a stored amount keep their legacy 10,000 reservation semantics in code.
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "attemptReservedTokens" INTEGER;
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;
ALTER TABLE "comparisons" ADD COLUMN IF NOT EXISTS "mergeReservedTokens" INTEGER;
