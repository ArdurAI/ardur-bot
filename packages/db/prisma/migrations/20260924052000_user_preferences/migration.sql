CREATE TABLE "user_preferences" (
  "user_id" TEXT NOT NULL,
  "theme" TEXT NOT NULL DEFAULT 'system',
  "chat_font" TEXT NOT NULL DEFAULT 'sans',
  "motion" TEXT NOT NULL DEFAULT 'system',
  "response_completions" BOOLEAN NOT NULL DEFAULT true,
  "routines" BOOLEAN NOT NULL DEFAULT true,
  "approvals_needed" BOOLEAN NOT NULL DEFAULT true,
  "dispatch_messages" BOOLEAN NOT NULL DEFAULT true,
  "preferred_browser" TEXT NOT NULL DEFAULT 'builtin',
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_preferences_theme_check" CHECK ("theme" IN ('system', 'light', 'dark')),
  CONSTRAINT "user_preferences_chat_font_check" CHECK ("chat_font" IN ('sans', 'serif', 'system')),
  CONSTRAINT "user_preferences_motion_check" CHECK ("motion" IN ('system', 'reduced')),
  CONSTRAINT "user_preferences_browser_check" CHECK ("preferred_browser" = 'builtin')
);

CREATE INDEX "runs_userId_updatedAt_id_idx" ON "runs"("userId", "updatedAt", "id");
CREATE INDEX "artifacts_userId_runId_id_idx" ON "artifacts"("userId", "runId", "id");
