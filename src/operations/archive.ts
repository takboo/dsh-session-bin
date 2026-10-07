import { z } from 'zod';
import { blockerSchema } from './schema.js';

const identity = z.string().min(1).max(1024);
export const archiveEntrySchema = z.object({
  schemaVersion: z.literal(2), sessionId: identity, entryId: z.uuid(),
}).strict();
export const archivePlanSchema = z.object({
  schemaVersion: z.literal(2), operationId: identity, action: z.literal('unarchive'), sessionId: identity,
  expected: z.object({ archived: z.boolean(), entryId: z.uuid().nullable() }).strict(),
  blockers: z.array(blockerSchema),
}).strict();
export const archiveResultSchema = z.object({
  operationId: identity, action: z.literal('unarchive'), sessionId: identity,
  status: z.enum(['success', 'rejected', 'conflict']), reason: z.string().min(1).nullable(), entryId: z.uuid().nullable(),
}).strict();
export const archiveOperationSchema = z.object({
  schemaVersion: z.literal(2), plan: archivePlanSchema, createdAt: z.iso.datetime(),
  phase: z.enum(['intent', 'applied', 'done']), entry: archiveEntrySchema.nullable(), result: archiveResultSchema.nullable(),
}).strict().superRefine(({ plan, entry, result, phase }, ctx) => {
  if ((phase === 'done') !== (result !== null) || (phase !== 'done' && (entry === null || !plan.expected.archived))) {
    ctx.addIssue({ code: 'custom', message: 'Only done operations have results; unfinished operations require an entry.' });
  }
  if (entry && (entry.sessionId !== plan.sessionId || entry.entryId !== plan.expected.entryId)) {
    ctx.addIssue({ code: 'custom', message: 'Entry snapshot does not match the plan.' });
  }
  if (result && (result.operationId !== plan.operationId || result.sessionId !== plan.sessionId
    || result.action !== plan.action || result.entryId !== (entry?.entryId ?? null)
    || (result.status === 'success') !== (result.reason === null) || (result.status === 'success' && !entry))) {
    ctx.addIssue({ code: 'custom', message: 'Result does not match the operation.' });
  }
});
export const archivePrepareRequestSchema = z.object({
  action: z.literal('unarchive'), sessionId: identity, operationId: identity.optional(),
}).strict();
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
export type ArchivePlan = z.infer<typeof archivePlanSchema>;
export type ArchiveResult = z.infer<typeof archiveResultSchema>;
export type ArchiveOperation = z.infer<typeof archiveOperationSchema>;
export type ArchivePrepareRequest = z.infer<typeof archivePrepareRequestSchema>;
