import { z } from 'zod';
import type { InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { entrySchema, operationSchema, planSchema, prepareRequestSchema, resultSchema } from '../operations/schema.js';
import type { BinEntry, BinOperation, BinPlan, BinResult, PrepareRequest } from '../operations/schema.js';

export const sessionBinRemoteNamespace = 'sessionBin';
export const sessionBinRemoteServiceKey = 'sessionBinRemote';
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(entrySchema),
}).strict();
export type BinSnapshot = z.infer<typeof snapshotSchema>;
export const operationIdSchema = z.string().min(1).max(1024);
export const entriesSchema = z.array(entrySchema);
export const optionalOperationSchema = operationSchema.nullable();

/** Browser-safe contract. No Host Context declaration or Node runtime import. */
export interface SessionBinRemoteApi {
  prepare(request: PrepareRequest, signal?: AbortSignal): Promise<RemoteResult<BinPlan>>;
  execute(plan: BinPlan, signal?: AbortSignal): Promise<RemoteResult<BinResult>>;
  list(signal?: AbortSignal): Promise<RemoteResult<BinEntry[]>>;
  getOperation(operationId: string, signal?: AbortSignal): Promise<RemoteResult<BinOperation | null>>;
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
  return {
    mode: 'strict',
    typeSymbol: `dsh-session-bin#${name}`,
    create: () => schema,
    // The SDK does not parse JSON results by default. These explicit codecs
    // keep the unary result boundary validated on both sides of this plugin.
    encode: value => schema.parse(value),
    decode: value => schema.parse(value),
  };
}
const codecs = {
  request: strictCodec('PrepareRequest', prepareRequestSchema),
  plan: strictCodec('BinPlan', planSchema),
  result: strictCodec('BinResult', resultSchema),
  entries: strictCodec('BinEntries', entriesSchema),
  operationId: strictCodec('OperationId', operationIdSchema),
  operation: strictCodec('OptionalBinOperation', optionalOperationSchema),
  snapshot: strictCodec('BinSnapshot', snapshotSchema),
};
function descriptor(method: string, parameters: InvocationDescriptor['parameters'], result: TypertCodec,
  mode?: 'stream'): InvocationDescriptor {
  return {
    id: `dsh-session-bin#sessionBin/${method}`,
    service: sessionBinRemoteServiceKey,
    namespace: sessionBinRemoteNamespace,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result,
    cancellation: { parameter: 'signal' },
    ...(mode === undefined ? {} : { mode }),
  };
}
const descriptors: readonly InvocationDescriptor[] = [
  descriptor('prepare', [{ name: 'request', wire: 'request', source: 'json', codec: codecs.request }], codecs.plan),
  descriptor('execute', [{ name: 'plan', wire: 'plan', source: 'json', codec: codecs.plan }], codecs.result),
  descriptor('list', [], codecs.entries),
  descriptor('getOperation', [{ name: 'operationId', wire: 'operationId', source: 'json', codec: codecs.operationId }], codecs.operation),
  descriptor('follow', [], codecs.snapshot, 'stream'),
];

/** Public hand-authored strict descriptors, shared by Host register and Client mount. */
export const sessionBinRemoteContribution: TypertRemoteContribution = {
  package: 'dsh-session-bin', descriptors,
};
export const sessionBinHostContribution: TypertContribution = {
  package: 'dsh-session-bin',
  face: 'host',
  schemas: [
    { name: 'PrepareRequest', create: () => prepareRequestSchema },
    { name: 'BinEntry', create: () => entrySchema },
    { name: 'BinPlan', create: () => planSchema },
    { name: 'BinResult', create: () => resultSchema },
    { name: 'BinOperation', create: () => operationSchema },
    { name: 'BinEntries', create: () => entriesSchema },
    { name: 'OperationId', create: () => operationIdSchema },
    { name: 'OptionalBinOperation', create: () => optionalOperationSchema },
    { name: 'BinSnapshot', create: () => snapshotSchema },
  ],
  model: {
    services: [{
      key: sessionBinRemoteServiceKey,
      exportName: 'SessionBinRemote',
      description: 'Typed archive-backed Session Bin Remote adapter.',
      tags: [],
      members: [
        { kind: 'method', name: 'prepare', signature: 'prepare(request: PrepareRequest, signal: AbortSignal): Promise<BinPlan>' },
        { kind: 'method', name: 'execute', signature: 'execute(plan: BinPlan, signal: AbortSignal): Promise<BinResult>' },
        { kind: 'method', name: 'list', signature: 'list(signal: AbortSignal): Promise<BinEntry[]>' },
        { kind: 'method', name: 'getOperation', signature: 'getOperation(operationId: string, signal: AbortSignal): Promise<BinOperation | null>' },
        { kind: 'method', name: 'follow', signature: 'follow(signal: AbortSignal): RemoteStream<BinSnapshot>' },
      ],
      types: [],
    }],
    events: [], objects: [],
  },
  invocations: descriptors,
};
