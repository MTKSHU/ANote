// One implementation is shared with the hash-pinned y-tiptap dependency patch.
export {
  MIGRATION_ENCODING_VERSION,
  encodePositionMigration,
  decodePositionMigration,
  isEncodedPositionMigration,
  inspectPositionMigration,
  scanDocumentMigrationEncoding,
  validateDocumentMigrationValues,
  setDocumentMigrationEncoding,
  compactDocumentMigrationValues,
  type PositionMigration,
  type PositionTransfer,
  type MigrationCompaction,
} from '../../../patches/y-tiptap-migration-codec.mjs';
