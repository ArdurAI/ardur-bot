-- Goal conditions carry support links.
--
-- Each condition in goal_revisions.conditions may now name the records that
-- support it: owner-attested "support" and bot "proposedSupport", each an
-- array of { kind, recordId, revision } where kind is an artifact revision,
-- a tool-result record, or a run record. Older condition entries simply omit
-- the new fields; the contract schema defaults them to empty arrays, so this
-- migration is intentionally additive and rewrites no existing rows.
SELECT 1;
