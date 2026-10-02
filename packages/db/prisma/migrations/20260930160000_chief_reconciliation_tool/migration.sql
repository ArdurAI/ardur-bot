-- Retain the tool identity so reconciliation requires a successful read, not a status write.
ALTER TABLE chief_action_admissions ADD COLUMN tool TEXT;
