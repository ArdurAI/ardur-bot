ALTER TABLE "chat_group_members"
  ADD COLUMN "runtimePin" JSONB,
  ADD COLUMN "modelPinRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "chat_group_members"
  ADD CONSTRAINT "chat_group_members_modelPinRevision_nonnegative"
    CHECK ("modelPinRevision" >= 0),
  ADD CONSTRAINT "chat_group_members_runtimePin_shape"
    CHECK (
      "runtimePin" IS NULL OR (
        jsonb_typeof("runtimePin") = 'object'
        AND "runtimePin" ?& ARRAY[
          'runtimeKind', 'provider', 'modelId', 'effort', 'credentialId', 'revision'
        ]
        AND jsonb_typeof("runtimePin"->'revision') = 'number'
        AND ("runtimePin"->>'revision')::numeric = "modelPinRevision"
      )
    );

ALTER TABLE "runs"
  ADD COLUMN "runtimePinSource" JSONB,
  ADD COLUMN "usageGroupId" TEXT;

ALTER TABLE "usage_records"
  ADD COLUMN "groupId" TEXT,
  ADD COLUMN "threadId" TEXT,
  ADD COLUMN "runtimePinSource" JSONB;

CREATE INDEX "usage_records_spaceId_userId_groupId_createdAt_idx"
  ON "usage_records"("spaceId", "userId", "groupId", "createdAt");
