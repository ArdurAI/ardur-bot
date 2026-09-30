-- A run put back to retry a provider's rate limit carries the moment it wakes again,
-- so the thread can say it is waiting for the model instead of for a free place.
ALTER TABLE "runs" ADD COLUMN "providerRetryAt" TIMESTAMP(3);
