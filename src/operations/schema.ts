import { z } from 'zod';

const identity = z.string().min(1).max(1024);
export const actionSchema = z.enum(['bin', 'restore']);
export const blockerSchema = z.object({
  code: z.string().min(1),
  activity: z.array(z.string()).optional(),
}).strict();
export const entrySchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: identity,
  entryId: z.uuid(),
  operationId: identity,
  binnedAt: z.iso.datetime(),
  workspaceIdAtBin: identity.nullable(),
  wasArchived: z.boolean(),
}).strict();
export const planSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: identity,
  action: actionSchema,
  sessionId: identity,
  expected: z.object({ archived: z.boolean(), entryId: z.uuid().nullable() }).strict(),
  blockers: z.array(blockerSchema),
}).strict();
export const resultSchema = z.object({
  operationId: identity,
  action: actionSchema,
  sessionId: identity,
  status: z.enum(['success', 'rejected', 'conflict']),
  reason: z.string().min(1).nullable(),
  entryId: z.uuid().nullable(),
}).strict();
export const operationSchema = z.object({
  schemaVersion: z.literal(1),
  plan: planSchema,
  createdAt: z.iso.datetime(),
  phase: z.enum(['intent', 'applied', 'done']),
  ownershipInvalidated: z.boolean(),
  entry: entrySchema.nullable(),
  result: resultSchema.nullable(),
}).strict().superRefine((operation, ctx) => {
  const { plan, entry, result, phase } = operation;
  if ((phase === 'done') !== (result !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Only a done operation has a result.' });
  }
  if (phase !== 'done' && entry === null) {
    ctx.addIssue({ code: 'custom', message: 'An unfinished operation requires its entry snapshot.' });
  }
  if (entry && (entry.sessionId !== plan.sessionId
    || (plan.action === 'bin' && (entry.operationId !== plan.operationId
      || entry.wasArchived !== plan.expected.archived))
    || (plan.action === 'restore' && entry.entryId !== plan.expected.entryId))) {
    ctx.addIssue({ code: 'custom', message: 'Entry snapshot does not match the operation.' });
  }
  if (result && ((result.status === 'success') !== (result.reason === null)
    || result.entryId !== (entry?.entryId ?? null)
    || (result.status === 'success' && !entry))) {
    ctx.addIssue({ code: 'custom', message: 'Result outcome or entry snapshot is inconsistent.' });
  }
  if (operation.ownershipInvalidated && !entry) {
    ctx.addIssue({ code: 'custom', message: 'Ownership invalidation requires an entry identity.' });
  }
  if (result && (result.operationId !== plan.operationId
    || result.sessionId !== plan.sessionId || result.action !== plan.action)) {
    ctx.addIssue({ code: 'custom', message: 'Result does not match the operation.' });
  }
});
export const prepareRequestSchema = z.object({
  action: actionSchema,
  sessionId: identity,
  operationId: identity.optional(),
}).strict();

export type BinEntry = z.infer<typeof entrySchema>;
export type BinPlan = z.infer<typeof planSchema>;
export type BinResult = z.infer<typeof resultSchema>;
export type BinOperation = z.infer<typeof operationSchema>;
export type BinBlocker = z.infer<typeof blockerSchema>;
export type PrepareRequest = z.infer<typeof prepareRequestSchema>;
