ALTER TABLE "instance_identity" ALTER COLUMN "homeName" SET DEFAULT 'Ardur';
UPDATE "instance_identity" SET "homeName" = 'Ardur' WHERE "homeName" = 'Ardur Bot';
