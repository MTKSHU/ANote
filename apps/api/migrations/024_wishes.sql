CREATE TABLE wishes (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 5000),
  category TEXT NOT NULL CHECK (category IN ('feature','improvement')),
  anonymous BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','planned','in_progress','completed','declined')),
  reply TEXT NOT NULL DEFAULT '' CHECK (length(reply) <= 3000),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wishes_created_idx ON wishes(created_at DESC, id DESC);
CREATE INDEX wishes_author_idx ON wishes(created_by,created_at DESC);
