import type * as Y from 'yjs';
export interface PositionTransfer { source:{client:number;clock:number;length:number;boundary?:'start'|'end'|null};target:{client:number;clock:number;type?:{client:number;clock:number}|null;tname?:string|null;assoc?:number|null;boundary?:'start'|'end'|null}|null; }
export interface PositionMigration {version:1;client:number;clock:number;seen:[number,number][];transfers:PositionTransfer[];}
export interface MigrationCompaction {changed:boolean;records:number;converted:number;transfers:number;beforeRecordJsonBytes:number;afterBinaryBytes:number;encoding:2;}
export const MIGRATION_ENCODING_VERSION:2;
export function encodePositionMigration(value:PositionMigration|Uint8Array):Uint8Array;
export function decodePositionMigration(value:PositionMigration|Uint8Array):PositionMigration;
export function isEncodedPositionMigration(value:unknown):value is Uint8Array;
export function inspectPositionMigration(value:PositionMigration|Uint8Array):{encoding:1|2;client:number;clock:number;transfers:number;bytes?:number};
export function scanDocumentMigrationEncoding(document:Y.Doc):1|2;
export function validateDocumentMigrationValues(document:Y.Doc):1|2;
export function setDocumentMigrationEncoding(document:Y.Doc,encoding?:1|2):1|2;
export function compactDocumentMigrationValues(document:Y.Doc):MigrationCompaction;
export function createANoteMigrationCodec():{encode:typeof encodePositionMigration;decode:typeof decodePositionMigration;isEncoded:typeof isEncodedPositionMigration;inspect:typeof inspectPositionMigration;documentEncoding:typeof scanDocumentMigrationEncoding;validateDocument:typeof validateDocumentMigrationValues;setEncoding:typeof setDocumentMigrationEncoding;compact:typeof compactDocumentMigrationValues;candidates:(store:Y.Map<PositionMigration|Uint8Array>,position:{item?:{client:number;clock:number}|null;type?:{client:number;clock:number}|null;assoc:number})=>{migration:PositionMigration;transfer:PositionTransfer}[]};
