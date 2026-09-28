DO $$
DECLARE
    invalid_count INT;
BEGIN
    -- Validate expected old shape
    SELECT count(*)
    INTO invalid_count
    FROM "bots"
    WHERE "runtimeConfig" IS NOT NULL
      AND (
          jsonb_typeof("runtimeConfig") != 'object'
          OR ("runtimeConfig"->>'version') != '1'
          OR ("runtimeConfig"->'maxProviderRequests') IS NULL
          OR ("runtimeConfig"->'timeoutMs') IS NULL
      );
      
    IF invalid_count > 0 THEN
        RAISE EXCEPTION 'Cannot migrate: found % bots with invalid version-1 runtime configuration', invalid_count;
    END IF;

    -- Translate valid version-1 documents and dormant version-1 documents
    UPDATE "bots"
    SET "runtimeConfig" = jsonb_build_object(
        'version', 2,
        'runtimeKind', 'hermes',
        'limits', jsonb_build_object(
            'maxProviderRequests', "runtimeConfig"->'maxProviderRequests',
            'timeoutMs', "runtimeConfig"->'timeoutMs'
        ),
        'context', jsonb_build_object(
            'maxInputBytes', 16384,
            'overflow', 'trim'
        ),
        'harness', jsonb_build_object(
            'agent', jsonb_build_object(
                'api_max_retries', 1
            )
        )
    )
    WHERE "runtimeConfig" IS NOT NULL AND ("runtimeConfig"->>'version') = '1';

    -- Materialize defaults for existing Hermes bots whose configuration is null
    UPDATE "bots"
    SET "runtimeConfig" = jsonb_build_object(
        'version', 2,
        'runtimeKind', 'hermes',
        'limits', jsonb_build_object(
            'maxProviderRequests', 16,
            'timeoutMs', 180000
        ),
        'context', jsonb_build_object(
            'maxInputBytes', 16384,
            'overflow', 'trim'
        ),
        'harness', jsonb_build_object(
            'agent', jsonb_build_object(
                'api_max_retries', 1
            )
        )
    )
    WHERE "runtimeKind" = 'hermes' AND "runtimeConfig" IS NULL;

END $$;
