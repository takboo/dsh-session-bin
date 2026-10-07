import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { retirementCapabilitiesSchema } from '../operations/retirement.js';
import type { RetirementCapabilities } from '../operations/retirement.js';
import { retirementOwnerGlobalSchema, retirementOwnerRecordSchema } from '../operations/retirement-owner.js';
import type { RetirementOwnerRecord } from '../operations/retirement-owner.js';
import { retirementManifestDigest } from './retirement.js';

export const retirementOwnerDomainSpec = defineDomain({
  name: 'session_bin_retirement_owner', version: 1, layout: 'single',
  global: { schema: retirementOwnerGlobalSchema, initial: { schemaVersion: 1, capabilities: null } },
  tables: { operations: domainTable(retirementOwnerRecordSchema) },
} as const);
export interface RetirementOwnerStore {
  bindCapabilities(capabilities: RetirementCapabilities): Promise<void>;
  operation(operationId: string): RetirementOwnerRecord | undefined;
  operations(): RetirementOwnerRecord[];
  putOperation(record: RetirementOwnerRecord): Promise<void>;
  close(): Promise<void>;
}
export function sameRetirementCapabilities(a: RetirementCapabilities, b: RetirementCapabilities): boolean {
  const canonical = (value: RetirementCapabilities) => JSON.stringify([
    value.protocolVersion, value.ownerId, value.hostVersion, value.providerId, value.storeId,
    value.participants.map(participant => [participant.id, participant.version]).sort((first, second) =>
      JSON.stringify(first) < JSON.stringify(second) ? -1 : JSON.stringify(first) > JSON.stringify(second) ? 1 : 0),
  ]);
  return canonical(retirementCapabilitiesSchema.parse(a)) === canonical(retirementCapabilitiesSchema.parse(b));
}
function validateRecord(value: RetirementOwnerRecord): RetirementOwnerRecord {
  const record = retirementOwnerRecordSchema.parse(value);
  if (record.state.request.manifestDigest !== retirementManifestDigest(record.state.manifest)) {
    throw new Error('Owner record does not carry its original frozen manifest digest.');
  }
  return record;
}
function assertMonotonic(previous: RetirementOwnerRecord, next: RetirementOwnerRecord): void {
  const a = previous.state;
  const b = next.state;
  if (JSON.stringify(a.request) !== JSON.stringify(b.request)
    || retirementManifestDigest(a.manifest) !== retirementManifestDigest(b.manifest)
    || a.authorizationId !== b.authorizationId) throw new Error('Owner journal cannot change a saved request, manifest or grant.');
  const phases = ['fenced', 'quiesced', 'erasing', 'converging', 'done'];
  if (['rejected', 'conflict', 'done'].includes(a.phase)) {
    if (JSON.stringify(previous) !== JSON.stringify(next)) throw new Error('Terminal owner receipts are immutable.');
    return;
  }
  if (phases.indexOf(b.phase) < phases.indexOf(a.phase)) throw new Error('Owner journal phase cannot regress.');
  for (const part of previous.participants) {
    const current = next.participants.find(value => value.id === part.id && value.version === part.version);
    if (!current || (part.fenced && !current.fenced) || (part.quiesced && !current.quiesced) || (part.converged && !current.converged)) {
      throw new Error('Owner journal cannot lose a participant acknowledgement.');
    }
  }
  if ((previous.lifecycleQuiesced && !next.lifecycleQuiesced) || (previous.lifecycleFinalized && !next.lifecycleFinalized)) {
    throw new Error('Owner journal cannot lose lifecycle settlement.');
  }
  for (const receipt of a.resources.filter(value => value.status !== 'failed')) {
    const current = b.resources.find(value => value.ownerId === receipt.ownerId && value.resourceId === receipt.resourceId);
    if (!current || JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error('Owner journal cannot lose a resource acknowledgement.');
  }
}

/** The caller must hold the composition's lifetime lease before opening this domain. */
export class DomainRetirementOwnerStore implements RetirementOwnerStore {
  constructor(private readonly domain: Domain<typeof retirementOwnerDomainSpec>) {
    const capabilities = domain.global.get().capabilities;
    for (const [key, value] of domain.table('operations').entries()) {
      const record = validateRecord(value);
      if (key !== record.state.request.operationId || !capabilities
        || !sameRetirementCapabilities(capabilities, record.state.manifest.capabilities)) {
        throw new Error('Owner operation has no matching journal identity and capability binding.');
      }
    }
  }
  async bindCapabilities(input: RetirementCapabilities): Promise<void> {
    const capabilities = retirementCapabilitiesSchema.parse(input);
    const previous = this.domain.global.get().capabilities;
    if (previous) {
      if (!sameRetirementCapabilities(previous, capabilities)) throw new Error('Owner journal belongs to a different composition.');
      return;
    }
    if (this.operations().length) throw new Error('Owner records cannot be adopted without their capability binding.');
    await this.domain.global.set({ schemaVersion: 1, capabilities });
  }
  operation(operationId: string): RetirementOwnerRecord | undefined {
    const value = this.domain.table('operations').get(operationId);
    return value === undefined ? undefined : validateRecord(value);
  }
  operations(): RetirementOwnerRecord[] {
    return [...this.domain.table('operations').entries()].map(([, value]) => validateRecord(value));
  }
  putOperation(input: RetirementOwnerRecord): Promise<void> {
    const record = validateRecord(input);
    const capabilities = this.domain.global.get().capabilities;
    if (!capabilities || !sameRetirementCapabilities(capabilities, record.state.manifest.capabilities)) {
      throw new Error('Cannot write an owner operation for an unbound composition.');
    }
    const previous = this.operation(record.state.request.operationId);
    if (previous) assertMonotonic(previous, record);
    return this.domain.table('operations').put(record.state.request.operationId, record);
  }
  close(): Promise<void> { return this.domain.close(); }
}
