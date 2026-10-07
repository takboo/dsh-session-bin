import { z } from 'zod';
import { retirementCapabilitiesSchema, retirementParticipantSchema, retirementStateSchema } from './retirement.js';

export const retirementOwnerParticipantProgressSchema = retirementParticipantSchema.extend({
  fenced: z.boolean(), quiesced: z.boolean(), converged: z.boolean(),
}).strict();
export const retirementOwnerRecordSchema = z.object({
  schemaVersion: z.literal(1), state: retirementStateSchema,
  participants: z.array(retirementOwnerParticipantProgressSchema).min(1).max(64),
  lifecycleQuiesced: z.boolean(), lifecycleFinalized: z.boolean(),
  blockedReason: z.string().min(1).max(1024).nullable(),
}).strict().superRefine((record, ctx) => {
  const declared = record.state.manifest.capabilities.participants;
  const { phase } = record.state;
  const terminalRefusal = phase === 'rejected' || phase === 'conflict';
  if (record.participants.length !== declared.length
    || new Set(record.participants.map(participant => participant.id)).size !== record.participants.length
    || record.participants.some(participant => !declared.some(expected => expected.id === participant.id && expected.version === participant.version))) {
    ctx.addIssue({ code: 'custom', message: 'Owner progress must cover exactly the frozen participants.' });
  }
  if ((record.lifecycleQuiesced && record.participants.some(participant => !participant.fenced))
    || (!record.lifecycleQuiesced && record.participants.some(participant => participant.quiesced))) {
    ctx.addIssue({ code: 'custom', message: 'Lifecycle quiescence follows every fence and precedes participant quiescence.' });
  }
  if (record.participants.some(participant => (participant.quiesced && !participant.fenced)
    || (participant.converged && !participant.quiesced))) {
    ctx.addIssue({ code: 'custom', message: 'Participant confirmation stages must be ordered.' });
  }
  if (terminalRefusal && (record.lifecycleQuiesced || record.lifecycleFinalized
    || record.participants.some(participant => participant.fenced || participant.quiesced || participant.converged))) {
    ctx.addIssue({ code: 'custom', message: 'Refusal cannot acknowledge retirement effects.' });
  }
  if (['quiesced', 'erasing', 'converging', 'done'].includes(phase)
    && (!record.lifecycleQuiesced || record.participants.some(participant => !participant.fenced || !participant.quiesced))) {
    ctx.addIssue({ code: 'custom', message: 'Resource erasure requires every quiescence confirmation.' });
  }
  if ((record.lifecycleFinalized || record.participants.some(participant => participant.converged))
    && !['converging', 'done'].includes(phase)) {
    ctx.addIssue({ code: 'custom', message: 'Convergence cannot precede resource erasure.' });
  }
  if (['converging', 'done'].includes(phase) && (record.state.resources.length !== record.state.manifest.resources.length
    || record.state.resources.some(receipt => receipt.status === 'failed'))) {
    ctx.addIssue({ code: 'custom', message: 'Convergence requires every successful resource acknowledgement.' });
  }
  if (record.lifecycleFinalized && record.participants.some(participant => !participant.converged)) {
    ctx.addIssue({ code: 'custom', message: 'Lifecycle finalization requires every participant convergence acknowledgement.' });
  }
  if (phase === 'done' && (!record.lifecycleFinalized || record.participants.some(participant => !participant.converged))) {
    ctx.addIssue({ code: 'custom', message: 'Owner completion requires the lifecycle and every participant.' });
  }
});
export const retirementOwnerGlobalSchema = z.object({
  schemaVersion: z.literal(1), capabilities: retirementCapabilitiesSchema.nullable(),
}).strict();
export type RetirementOwnerRecord = z.infer<typeof retirementOwnerRecordSchema>;
export type RetirementOwnerParticipantProgress = z.infer<typeof retirementOwnerParticipantProgressSchema>;
