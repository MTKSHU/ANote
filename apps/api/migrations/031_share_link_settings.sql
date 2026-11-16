-- Old links remain valid and keep their existing appearance.
ALTER TABLE document_share_links ADD COLUMN token_encrypted text NOT NULL DEFAULT '';
ALTER TABLE document_share_links ADD COLUMN watermark_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE document_share_links ADD COLUMN watermark_text text NOT NULL DEFAULT '';
ALTER TABLE library_share_links ADD COLUMN token_encrypted text NOT NULL DEFAULT '';
ALTER TABLE library_share_links ADD COLUMN watermark_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE library_share_links ADD COLUMN watermark_text text NOT NULL DEFAULT '';
