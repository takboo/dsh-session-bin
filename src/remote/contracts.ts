import { z } from 'zod';
import type { InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { operationSchema } from '../operations/schema.js';
import type { BinOperation } from '../operations/schema.js';
import { archiveEntrySchema, archiveOperationSchema, archivePlanSchema, archivePrepareRequestSchema, archiveResultSchema } from '../operations/archive.js';
import type { ArchiveEntry, ArchiveOperation, ArchivePlan, ArchivePrepareRequest, ArchiveResult } from '../operations/archive.js';

export const sessionBinRemoteNamespace = 'sessionBin';
export const sessionBinRemoteServiceKey = 'sessionBinRemote';
export const snapshotSchema = z.object({ schemaVersion: z.literal(2), entries: z.array(archiveEntrySchema) }).strict();
export type BinSnapshot = z.infer<typeof snapshotSchema>;
export type ArchiveSnapshot = BinSnapshot;
export const operationIdSchema = z.string().min(1).max(1024);
export const entriesSchema = z.array(archiveEntrySchema);
export const optionalOperationSchema = z.union([archiveOperationSchema, operationSchema]).nullable();

/** Browser-safe contract. Native archive is the sole entry path. */
export interface SessionBinRemoteApi {
  prepare(request: ArchivePrepareRequest, signal?: AbortSignal): Promise<RemoteResult<ArchivePlan>>;
  execute(plan: ArchivePlan, signal?: AbortSignal): Promise<RemoteResult<ArchiveResult>>;
  list(signal?: AbortSignal): Promise<RemoteResult<ArchiveEntry[]>>;
  getOperation(operationId: string, signal?: AbortSignal): Promise<RemoteResult<ArchiveOperation | BinOperation | null>>;
  follow(signal?: AbortSignal): RemoteStreamHandle<BinSnapshot, never>;
}
export const binRemoteErrorCodes = ['bin/closed', 'bin/recovery-required', 'bin/not-ready', 'bin/operation-id-reused'] as const;
export type BinRemoteErrorCode = typeof binRemoteErrorCodes[number];
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'bin/closed': {};
    'bin/recovery-required': {};
    'bin/not-ready': {};
    'bin/operation-id-reused': {};
  }
}
function strictCodec<Output>(name: string, schema: z.ZodType<Output>): TypertCodec {
  return { mode: 'strict', typeSymbol: `dsh-session-bin#${name}`, create: () => schema,
    encode: value => schema.parse(value), decode: value => schema.parse(value) };
}
const codecs = {
  request: strictCodec('ArchivePrepareRequest', archivePrepareRequestSchema),
  plan: strictCodec('ArchivePlan', archivePlanSchema),
  result: strictCodec('ArchiveResult', archiveResultSchema),
  entries: strictCodec('ArchiveEntries', entriesSchema),
  operationId: strictCodec('OperationId', operationIdSchema),
  operation: strictCodec('OptionalArchiveOperation', optionalOperationSchema),
  snapshot: strictCodec('ArchiveSnapshot', snapshotSchema),
};
function descriptor(method: string, parameters: InvocationDescriptor['parameters'], result: TypertCodec,
  mode?: 'stream'): InvocationDescriptor {
  return { id: `dsh-session-bin#sessionBin/${method}`, service: sessionBinRemoteServiceKey,
    namespace: sessionBinRemoteNamespace, method, invocation: { kind: 'direct' }, parameters, result,
    cancellation: { parameter: 'signal' }, ...(mode === undefined ? {} : { mode }) };
}
const descriptors: readonly InvocationDescriptor[] = [
  descriptor('prepare', [{ name: 'request', wire: 'request', source: 'json', codec: codecs.request }], codecs.plan),
  descriptor('execute', [{ name: 'plan', wire: 'plan', source: 'json', codec: codecs.plan }], codecs.result),
  descriptor('list', [], codecs.entries),
  descriptor('getOperation', [{ name: 'operationId', wire: 'operationId', source: 'json', codec: codecs.operationId }], codecs.operation),
  descriptor('follow', [], codecs.snapshot, 'stream'),
];
export const sessionBinRemoteContribution: TypertRemoteContribution = { package: 'dsh-session-bin', descriptors };
export const sessionBinHostContribution: TypertContribution = {
  package: 'dsh-session-bin', face: 'host',
  schemas: [
    { name: 'ArchivePrepareRequest', create: () => archivePrepareRequestSchema },
    { name: 'ArchiveEntry', create: () => archiveEntrySchema },
    { name: 'ArchivePlan', create: () => archivePlanSchema },
    { name: 'ArchiveResult', create: () => archiveResultSchema },
    { name: 'ArchiveOperation', create: () => archiveOperationSchema },
    { name: 'ArchiveEntries', create: () => entriesSchema },
    { name: 'OperationId', create: () => operationIdSchema },
    { name: 'OptionalArchiveOperation', create: () => optionalOperationSchema },
    { name: 'ArchiveSnapshot', create: () => snapshotSchema },
  ],
  model: { services: [{ key: sessionBinRemoteServiceKey, exportName: 'SessionBinRemote',
    description: 'Typed native archive management adapter.', tags: [], members: [
      { kind: 'method', name: 'prepare', signature: 'prepare(request: ArchivePrepareRequest, signal: AbortSignal): Promise<ArchivePlan>' },
      { kind: 'method', name: 'execute', signature: 'execute(plan: ArchivePlan, signal: AbortSignal): Promise<ArchiveResult>' },
      { kind: 'method', name: 'list', signature: 'list(signal: AbortSignal): Promise<ArchiveEntry[]>' },
      { kind: 'method', name: 'getOperation', signature: 'getOperation(operationId: string, signal: AbortSignal): Promise<ArchiveOperation | BinOperation | null>' },
      { kind: 'method', name: 'follow', signature: 'follow(signal: AbortSignal): RemoteStream<ArchiveSnapshot>' },
    ], types: [] }], events: [], objects: [] }, invocations: descriptors,
};
