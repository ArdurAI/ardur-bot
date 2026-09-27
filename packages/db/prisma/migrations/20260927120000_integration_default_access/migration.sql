ALTER TABLE "mcp_servers" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bot_mcp_servers" ADD COLUMN "access" TEXT NOT NULL DEFAULT 'custom';

UPDATE "mcp_servers" AS server
SET "needsReview" = true
WHERE EXISTS (
  SELECT 1 FROM "bot_mcp_servers" AS grant_row
  WHERE grant_row."serverId" = server.id AND grant_row."needsReview" = true
);

-- Earlier connections with no bot rows had no way to grant tools. Restore the
-- captured space tools for connected accounts; catalog policy still filters them.
UPDATE "mcp_servers" AS server
SET "spaceAllowedTools" = (
  SELECT COALESCE(jsonb_agg(tool->>'id'), '[]'::jsonb)
  FROM jsonb_array_elements(server."manifest"->'tools') AS tool
  WHERE jsonb_typeof(tool->'id') = 'string'
)
WHERE server."catalogId" IS NOT NULL
  AND server."connectionState" = 'connected'
  AND server."manifest" IS NOT NULL
  AND jsonb_typeof(server."manifest"->'tools') = 'array'
  AND server."spaceAllowedTools" = '[]'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM "bot_mcp_servers" AS grant_row
    WHERE grant_row."serverId" = server.id
  );
