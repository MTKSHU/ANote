-- NULL expiry represents a revocable link with no time limit.
-- Existing dated links retain their expiry and revocation state.
ALTER TABLE document_share_links ALTER COLUMN expires_at DROP NOT NULL;
