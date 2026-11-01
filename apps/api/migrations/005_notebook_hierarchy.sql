-- Existing knowledge bases retain their team permissions and contents.
ALTER TABLE spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('personal','team'));
CREATE INDEX spaces_owner_kind_idx ON spaces(created_by,kind);
