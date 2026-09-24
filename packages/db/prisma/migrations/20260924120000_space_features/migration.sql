CREATE TABLE "space_features" (
    "spaceId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'disabled',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "space_features_pkey" PRIMARY KEY ("spaceId", "feature"),
    CONSTRAINT "space_features_feature_check" CHECK ("feature" IN ('governance')),
    CONSTRAINT "space_features_state_check" CHECK ("state" IN ('disabled', 'enabled')),
    CONSTRAINT "space_features_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
