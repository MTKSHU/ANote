# ANote position migration encoding 2

This encoding is a lossless representation of one y-tiptap version-1 position
migration record. It changes only a migration map value from PlainJSON to
`Uint8Array`. Map keys, record order, causal metadata, transfer order, text
items, node items, relative-position identities, and delete sets remain intact.
It is not a document epoch reset and does not remove historical transfers.

The map name remains `__tiptap_position_migrations:<fragment-key>`. A document
using this encoding has `__anote_sync_meta.migrationEncoding = 2`. The default
without a marker is encoding 1. A binary value also requires encoding 2 even if
an incoming update changes the marker. Service capability checks must reject
clients that cannot read encoding 2; the codec cannot prevent an unfenced old
client from writing a conflicting map value. Normal helpers reject downgrade;
an explicit maintenance rollback may decode every value before removing the
marker and changing the service's persisted encoding fence.

## Primitive representation

Every number is a JavaScript safe integer. Negative zero is rejected rather
than silently normalized. `u` uses unsigned base-128 little-endian varints.
`s` uses a first byte containing six magnitude bits, a sign bit `0x40`, and a
continuation bit `0x80`; subsequent bytes contain seven magnitude bits and a
continuation bit. Strings contain a `u` UTF-16 code-unit count followed by that
many `u` code units, preserving unpaired surrogates as well as Unicode text.

Each value starts with bytes `41 4e 4d 02` (hex, `ANM` + version 2), then:

1. `u clientCount`, then `u clientID` for each dictionary entry.
2. `u recordClientIndex`, `u recordClock`.
3. `u seenCount`, then `(u clientIndex, u clock)` pairs in original order.
4. `u transferCount`, `u sourceGroupCount`.
5. Each source group: `u sourceClientIndex`, `u rowCount`, `u blockCount`,
   followed by the blocks described below.

Client dictionary order is first occurrence while visiting record client,
`seen`, and transfers in their original order. Source groups are ordered by
their first occurrence. Transfers inside a group are ordered by source clock,
then original transfer ordinal. A group is split into blocks of at most 64
rows; block count is `ceil(rowCount / 64)`.

## Block and transfer representation

Each block contains `u minimumSourceClock`, `u sourceClockSpan`, `u rowCount`,
`u payloadByteCount`, and exactly that many payload bytes. The span ends at the
maximum source `clock + length` in the block. The decoder keeps a cumulative
maximum end for overlapping blocks, allowing interval queries to skip blocks
that cannot contain a requested source identity.

At the start of a block, previous ordinal is -1, previous source clock is the
block minimum, and previous target/type clocks are 0. Each row contains:

1. `s ordinalDelta`, `u flags`, `u sourceClockDelta`, `u sourceLength`.
2. When target-present flag is set: `u targetClientIndex`,
   `s targetClockDelta`.
3. When type mode is object: `u typeClientIndex`, `s typeClockDelta`.
4. When assoc mode is numeric: `s assoc`.
5. When tname mode is string: the UTF-16 string primitive.

Flags occupy bits 0 through 12; all other bits must be zero:

| Bits | Meaning |
| --- | --- |
| 0–2 | source boundary: absent=0, start=1, end=2, undefined=3, null=4 |
| 3 | target present; otherwise target is null and bits 4–12 must be zero |
| 4–6 | target boundary, with the same five modes |
| 7–8 | assoc: absent=0, number=1, undefined=2, null=3 |
| 9–10 | tname: absent=0, string=1, undefined=2, null=3 |
| 11–12 | target type: null=0, identity object=1, undefined=2, absent=3 |

Original ordinals restore the exact transfer array order. Optional own-property
presence is preserved independently from its value. Unknown legacy fields,
unknown binary versions, truncated payloads, invalid identities, and malformed
rows fail closed before a compaction transaction changes a value.

## Read, write, and compaction interfaces

`packages/document-model/src/migration-codec.ts` reexports the standalone
implementation. The hash-pinned ESM and CJS vendor patch embeds exactly its
factory, so all read and write paths use the same schema:

- `decodePositionMigration(value)` accepts legacy JSON or binary. The binary
  `transfers` array is an enumerable lazy getter and is materialized only by a
  full-history consumer such as undo restoration or rollback.
- `scanDocumentMigrationEncoding(doc)` checks markers and binary headers.
  Cold document loading does not reconstruct transfer objects.
- `validateDocumentMigrationValues(doc)` additionally validates all row
  primitives and transfer ordinals without constructing transfer objects.
- `compactDocumentMigrationValues(doc)` validates and plans all changes, then
  replaces legacy values in one transaction and persists marker 2. Its caller
  must use a shadow `Y.Doc` with GC enabled and compare-and-swap the resulting
  complete state only after preserving/validating the current document.
- `setDocumentMigrationEncoding(doc, 2)` is idempotent and cannot downgrade.
  Normal new documents remain encoding 1 until explicitly migrated.

Cursor lookup uses source-client groups and block intervals, parses only
matching blocks, and returns transfers in original order before applying the
original causal override rule. Query caches are cleared by map observers on
every replacement, including replacements that preserve map size. Queries
inside a Yjs transaction bypass the cache because map observers have not run.

Replaying the original pre-compaction state cannot revive overwritten JSON:
Yjs retains the causal replacement and deletion information. New legacy keys
from a delayed update remain readable and can be compacted again. Concurrent
same-key writes from old clients still require the service's encoding fence.
