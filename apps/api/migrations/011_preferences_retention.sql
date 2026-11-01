ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light' CHECK(theme IN ('light','dark'));
UPDATE documents SET trash_batch=gen_random_uuid()::text WHERE deleted_at IS NOT NULL AND trash_batch IS NULL;
-- Shared legacy assets may survive their original library through note references.
ALTER TABLE assets ALTER COLUMN space_id DROP NOT NULL;
CREATE TABLE storage_gc (
 area TEXT NOT NULL CHECK(area IN ('originals','uploads','derived')),
 key TEXT NOT NULL,
 not_before TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 hour',
 attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(area,key)
);
