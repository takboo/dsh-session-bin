import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { purgeOperationSchema, retirementBindingSchema } from '../operations/retirement.js';
import type { PurgeOperation, RetirementBinding } from '../operations/retirement.js';

/** Separate sidecar: the existing Bin domain and Remote DTOs keep their v1 shape. */
export const retirementDomainSpec = defineDomain({
  name: 'session_bin_purge', version: 1, layout: 'single',
  tables: { bindings: domainTable(retirementBindingSchema), operations: domainTable(purgeOperationSchema) },
} as const);
export interface RetirementStore {
  binding(entryId: string): RetirementBinding | undefined;
  putBinding(binding: RetirementBinding): Promise<void>;
  operation(operationId: string): PurgeOperation | undefined;
  operations(): PurgeOperation[];
  putOperation(operation: PurgeOperation): Promise<void>;
  close(): Promise<void>;
}
export class DomainRetirementStore implements RetirementStore {
  constructor(private readonly domain: Domain<typeof retirementDomainSpec>) {
    for (const [key, value] of domain.table('bindings').entries()) {
      if (key !== value.entryId) throw new Error('Retirement binding key differs from its entry.');
    }
    for (const [key, value] of domain.table('operations').entries()) {
      if (key !== value.plan.operationId) throw new Error('Retirement operation key differs from its request.');
    }
  }
  binding(entryId: string): RetirementBinding | undefined {
    const value = this.domain.table('bindings').get(entryId);
    return value === undefined ? undefined : retirementBindingSchema.parse(value);
  }
  putBinding(value: RetirementBinding): Promise<void> {
    const snapshot = retirementBindingSchema.parse(value);
    const existing = this.binding(snapshot.entryId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
      throw new Error('An immutable entry lifecycle binding cannot be replaced.');
    }
    return this.domain.table('bindings').put(snapshot.entryId, snapshot);
  }
  operation(operationId: string): PurgeOperation | undefined {
    const value = this.domain.table('operations').get(operationId);
    return value === undefined ? undefined : purgeOperationSchema.parse(value);
  }
  operations(): PurgeOperation[] {
    return [...this.domain.table('operations').entries()].map(([, value]) => purgeOperationSchema.parse(value));
  }
  putOperation(value: PurgeOperation): Promise<void> {
    const snapshot = purgeOperationSchema.parse(value);
    return this.domain.table('operations').put(snapshot.plan.operationId, snapshot);
  }
  close(): Promise<void> { return this.domain.close(); }
}
