-- Remove metadata left behind by user deletions before adding owner constraints.
DELETE FROM "customization_marketplaces" WHERE NOT EXISTS (
    SELECT 1 FROM "user" WHERE "user"."id" = "customization_marketplaces"."userId"
);
DELETE FROM "plugin_installs" WHERE NOT EXISTS (
    SELECT 1 FROM "user" WHERE "user"."id" = "plugin_installs"."userId"
);

ALTER TABLE "customization_marketplaces" ADD CONSTRAINT "customization_marketplaces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_installs" ADD CONSTRAINT "plugin_installs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
