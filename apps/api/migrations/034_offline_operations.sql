-- An acknowledgement belongs to an account and operation, not a connection.
-- Keep it for the life of the note so a lost response cannot repeat a write.
CREATE TABLE offline_operations (
  actor TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor,op_id)
);
CREATE INDEX offline_operations_document ON offline_operations(doc_id);
