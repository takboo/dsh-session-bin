import { z } from 'zod';
import { blockerSchema, entrySchema } from './schema.js';

const key = z.string().min(1).max(1024);
export const lifecycleKeySchema = z.object({ storeId: key, sessionId: key, lifecycleId: key }).strict();
export const retirementParticipantSchema = z.object({ id: key, version: key }).strict();
export const retirementCapabilitiesSchema = z.object({
  protocolVersion: z.literal(1), ownerId: key, hostVersion: key, providerId: key, storeId: key,
  participants: z.array(retirementParticipantSchema).min(1).max(64),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.participants.map(item => item.id)).size !== value.participants.length) {
    ctx.addIssue({ code: 'custom', message: 'Participant identities must be unique.' });
  }
});
export const retirementBindingSchema = z.object({
  schemaVersion: z.literal(1), entryId: z.uuid(), entryVersion: z.literal(1),
  lifecycle: lifecycleKeySchema, capabilities: retirementCapabilitiesSchema,
}).strict().superRefine((value, ctx) => {
  if (value.lifecycle.storeId !== value.capabilities.storeId) {
    ctx.addIssue({ code: 'custom', message: 'Binding store differs from its owner.' });
  }
});
export const retirementResourceSchema = z.object({
  ownerId: key, resourceId: key, revision: key,
  kind: z.enum(['transcript', 'workspace', 'index', 'cache', 'attachment', 'spill', 'coordination']),
  disposition: z.enum(['erase', 'release-reference', 'retain-shared', 'retain-coordination']),
  retention: z.object({
    reason: z.enum(['shared-reference', 'coordination-identity']),
    retainedBy: z.array(lifecycleKeySchema).max(4096),
  }).strict().nullable(),
}).strict();
export const retirementManifestSchema = z.object({
  schemaVersion: z.literal(1), lifecycle: lifecycleKeySchema,
  capabilities: retirementCapabilitiesSchema,
  resources: z.array(retirementResourceSchema).min(1).max(4096),
}).strict().superRefine((value, ctx) => {
  const owners = new Set(value.capabilities.participants.map(item => item.id));
  const resourceKeys = value.resources.map(item => JSON.stringify([item.ownerId, item.resourceId]));
  if (new Set(resourceKeys).size !== resourceKeys.length || value.resources.some(item => !owners.has(item.ownerId))) {
    ctx.addIssue({ code: 'custom', message: 'Resources require unique keys and declared owners.' });
  }
  if (value.lifecycle.storeId !== value.capabilities.storeId
    || !value.resources.some(item => item.kind === 'transcript' && item.disposition === 'erase')) {
    ctx.addIssue({ code: 'custom', message: 'Manifest must identify its store and erase the target transcript.' });
  }
  for (const resource of value.resources) {
    if (resource.kind === 'coordination' && resource.disposition !== 'retain-coordination') {
      ctx.addIssue({ code: 'custom', message: 'Stable coordination identity must be retained.' });
    }
    const retained = resource.retention;
    if (resource.disposition === 'retain-shared') {
      if (!retained || retained.reason !== 'shared-reference' || !retained.retainedBy.length
        || retained.retainedBy.some(key => lifecycleEqual(key, value.lifecycle))
        || new Set(retained.retainedBy.map(key => JSON.stringify([key.storeId, key.sessionId, key.lifecycleId]))).size !== retained.retainedBy.length) {
        ctx.addIssue({ code: 'custom', message: 'Shared retention requires distinct surviving lifecycle witnesses.' });
      }
    } else if (resource.disposition === 'retain-coordination') {
      if (resource.kind !== 'coordination' || !retained || retained.reason !== 'coordination-identity' || retained.retainedBy.length) {
        ctx.addIssue({ code: 'custom', message: 'Coordination retention must state its identity purpose.' });
      }
    } else if (retained !== null) {
      ctx.addIssue({ code: 'custom', message: 'Erasure/reference release does not retain this resource.' });
    }
  }
});
export const retirementRequestSchema = z.object({
  operationId: key, expected: lifecycleKeySchema,
  bin: z.object({ entryId: z.uuid(), entryVersion: z.literal(1) }).strict(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const retirementResourceReceiptSchema = z.object({
  ownerId: key, resourceId: key,
  status: z.enum(['erased', 'reference-released', 'retained', 'failed']), reason: key.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'failed' || value.status === 'retained') !== (value.reason !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Failure and retention require a reason; erased/released resources do not.' });
  }
});
export const retirementAuthorizationSchema = z.discriminatedUnion('authorized', [
  z.object({ authorized: z.literal(true), authorizationId: z.uuid() }).strict(),
  z.object({ authorized: z.literal(false), reason: key }).strict(),
]);
export const retirementStateSchema = z.object({
  schemaVersion: z.literal(1), request: retirementRequestSchema, manifest: retirementManifestSchema,
  authorizationId: z.uuid().nullable(),
  phase: z.enum(['rejected', 'conflict', 'fenced', 'quiesced', 'erasing', 'converging', 'done']),
  reason: key.nullable(), resources: z.array(retirementResourceReceiptSchema).max(4096),
}).strict().superRefine((value, ctx) => {
  if (!lifecycleEqual(value.request.expected, value.manifest.lifecycle)) {
    ctx.addIssue({ code: 'custom', message: 'Owner state changed the requested lifecycle.' });
  }
  const refused = value.phase === 'rejected' || value.phase === 'conflict';
  if (refused !== (value.authorizationId === null)) {
    ctx.addIssue({ code: 'custom', message: 'Admitted owner state requires its handed-off authorization grant.' });
  }
  if (refused !== (value.reason !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Admission refusal requires a reason.' });
  }
  const keys = value.resources.map(item => JSON.stringify([item.ownerId, item.resourceId]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate resource receipts.' });
  for (const receipt of value.resources) {
    const resource = value.manifest.resources.find(item => item.ownerId === receipt.ownerId && item.resourceId === receipt.resourceId);
    if (!resource) ctx.addIssue({ code: 'custom', message: 'Receipt is outside the frozen manifest.' });
    if (resource && receipt.status !== 'failed') {
      const expected = resource.disposition === 'erase' ? 'erased'
        : resource.disposition === 'release-reference' ? 'reference-released' : 'retained';
      if (receipt.status !== expected || (receipt.status === 'retained' && receipt.reason !== resource.retention?.reason)) {
        ctx.addIssue({ code: 'custom', message: 'Resource acknowledgement did not satisfy its frozen disposition and retention reason.' });
      }
    }
  }
  if (value.phase === 'done' && (value.resources.length !== value.manifest.resources.length
    || value.resources.some(receipt => receipt.status === 'failed'))) {
    ctx.addIssue({ code: 'custom', message: 'Completion requires every resource receipt without failures.' });
  }
  if (['rejected', 'conflict', 'fenced', 'quiesced'].includes(value.phase) && value.resources.length) {
    ctx.addIssue({ code: 'custom', message: 'Admission and quiescence phases cannot include resource erasure effects.' });
  }
});
export const preparePurgeRequestSchema = z.object({ sessionId: key, operationId: key.optional() }).strict();
export const purgePlanSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal('purge'), operationId: key, sessionId: key,
  expectedEntryId: z.uuid().nullable(), binding: retirementBindingSchema.nullable(),
  manifest: retirementManifestSchema.nullable(), blockers: z.array(blockerSchema),
}).strict().superRefine((value, ctx) => {
  if (value.binding && (value.binding.entryId !== value.expectedEntryId || value.binding.lifecycle.sessionId !== value.sessionId)) {
    ctx.addIssue({ code: 'custom', message: 'Purge binding differs from its target entry.' });
  }
  if (value.manifest && (!value.binding || !lifecycleEqual(value.binding.lifecycle, value.manifest.lifecycle))) {
    ctx.addIssue({ code: 'custom', message: 'Purge manifest differs from its bound lifecycle.' });
  }
});
export const purgeResultSchema = z.object({
  action: z.literal('purge'), operationId: key, sessionId: key, entryId: z.uuid().nullable(),
  status: z.enum(['success', 'rejected', 'conflict', 'pending-recovery', 'partial-failure']), reason: key.nullable(),
  ownerState: retirementStateSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'success') !== (value.reason === null)
    || (value.status === 'success' && value.ownerState?.phase !== 'done')) {
    ctx.addIssue({ code: 'custom', message: 'Success requires a complete owner receipt.' });
  }
  if (value.ownerState && (value.ownerState.request.operationId !== value.operationId
    || value.ownerState.request.expected.sessionId !== value.sessionId
    || value.ownerState.request.bin.entryId !== value.entryId)) {
    ctx.addIssue({ code: 'custom', message: 'Purge result differs from its owner receipt.' });
  }
});
export const purgeOperationSchema = z.object({
  schemaVersion: z.literal(1), plan: purgePlanSchema, createdAt: z.iso.datetime(),
  phase: z.enum(['intent', 'authorizing', 'owner-pending', 'done']), entry: entrySchema.nullable(),
  authorizationId: z.uuid().nullable(),
  ownerState: retirementStateSchema.nullable(), result: purgeResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const { plan, entry, result, ownerState } = value;
  if (entry && (entry.entryId !== plan.expectedEntryId || entry.sessionId !== plan.sessionId)) {
    ctx.addIssue({ code: 'custom', message: 'Purge journal entry differs from the plan.' });
  }
  if (value.phase !== 'done' && (!entry || !plan.binding || !plan.manifest)) {
    ctx.addIssue({ code: 'custom', message: 'Unfinished purge requires an entry, binding and manifest.' });
  }
  const terminalResult = result && ['success', 'rejected', 'conflict'].includes(result.status);
  if ((value.phase === 'done') !== Boolean(terminalResult)
    || (['intent', 'authorizing'].includes(value.phase) && (ownerState !== null || result !== null))
    || (value.phase === 'intent' && value.authorizationId !== null)
    || (value.phase === 'authorizing' && value.authorizationId === null)
    || (ownerState && ownerState.authorizationId !== null && ownerState.authorizationId !== value.authorizationId)
    || (value.phase === 'owner-pending' && (ownerState === null || result === null))) {
    ctx.addIssue({ code: 'custom', message: 'Purge journal phase and receipt are inconsistent.' });
  }
  if (result && (result.operationId !== plan.operationId || result.sessionId !== plan.sessionId
    || result.entryId !== (entry?.entryId ?? null) || JSON.stringify(result.ownerState) !== JSON.stringify(ownerState))) {
    ctx.addIssue({ code: 'custom', message: 'Purge journal result differs from its saved state.' });
  }
});

export type LifecycleKey = z.infer<typeof lifecycleKeySchema>;
export type RetirementCapabilities = z.infer<typeof retirementCapabilitiesSchema>;
export type RetirementBinding = z.infer<typeof retirementBindingSchema>;
export type RetirementManifest = z.infer<typeof retirementManifestSchema>;
export type RetirementRequest = z.infer<typeof retirementRequestSchema>;
export type RetirementAuthorization = z.infer<typeof retirementAuthorizationSchema>;
export type RetirementState = z.infer<typeof retirementStateSchema>;
export type PurgePlan = z.infer<typeof purgePlanSchema>;
export type PurgeResult = z.infer<typeof purgeResultSchema>;
export type PurgeOperation = z.infer<typeof purgeOperationSchema>;
export type PreparePurgeRequest = z.infer<typeof preparePurgeRequestSchema>;
export function lifecycleEqual(a: LifecycleKey, b: LifecycleKey): boolean {
  return a.storeId === b.storeId && a.sessionId === b.sessionId && a.lifecycleId === b.lifecycleId;
}
