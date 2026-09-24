CREATE TABLE "host_registrations" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "hostRoots" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "generation" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "host_registrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "host_registrations_single_host" CHECK ("id" = 'default')
);
CREATE UNIQUE INDEX "host_registrations_tokenHash_key" ON "host_registrations"("tokenHash");
