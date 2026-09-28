-- Keep version-1 rows and null defaults readable by the preceding release.
-- The application migrates a document only when a compatible client saves it.
DO $$
DECLARE invalid_count integer;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM "bots"
  WHERE "runtimeConfig" IS NOT NULL
    AND NOT (
      CASE WHEN jsonb_typeof("runtimeConfig") = 'object' THEN
        "runtimeConfig"->>'version' = '1'
        AND (SELECT count(*) FROM jsonb_object_keys("runtimeConfig")) = 3
        AND jsonb_typeof("runtimeConfig"->'maxProviderRequests') = 'number'
        AND jsonb_typeof("runtimeConfig"->'timeoutMs') = 'number'
        AND CASE WHEN ("runtimeConfig"->>'maxProviderRequests') ~ '^[0-9]+$'
          THEN ("runtimeConfig"->>'maxProviderRequests')::numeric BETWEEN 1 AND 64
          ELSE false END
        AND CASE WHEN ("runtimeConfig"->>'timeoutMs') ~ '^[0-9]+$'
          THEN ("runtimeConfig"->>'timeoutMs')::numeric BETWEEN 1000 AND 600000
            AND mod(("runtimeConfig"->>'timeoutMs')::numeric, 1000) = 0
          ELSE false END
      ELSE false END
    );
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Cannot prepare runtime configuration: % invalid rows', invalid_count;
  END IF;
END $$;
