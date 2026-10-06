import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { entrySchema, operationSchema } from '../operations/schema.js';
import type { BinEntry, BinOperation } from '../operations/schema.js';

export const binDomainSpec = defineDomain({
  name: 'session_bin',
  version: 1,
  layout: 'single',
  tables: {
    entries: domainTable(entrySchema),
    operations: domainTable(operationSchema),
  },
} as const);

export interface BinStore {
  entries(): BinEntry[];
  operations(): BinOperation[];
  entry(sessionId: string): BinEntry | undefined;
  operation(operationId: string): BinOperation | undefined;
  putEntry(entry: BinEntry): Promise<void>;
  deleteEntry(sessionId: string): Promise<void>;
  putOperation(operation: BinOperation): Promise<void>;
  close(): Promise<void>;
}

// Domain.put/update do not validate in the pinned SDK. Keep the handle private;
// parse synchronously before enqueuing, and return independent read snapshots.
export class DomainBinStore implements BinStore {
  constructor(private readonly domain: Domain<typeof binDomainSpec>) {
    for (const [key, entry] of domain.table('entries').entries()) {
      if (key !== entry.sessionId) throw new Error('Bin entry key does not match its session.');
      const owner = domain.table('operations').get(entry.operationId);
      if (!owner || owner.plan.action !== 'bin' || owner.entry?.entryId !== entry.entryId
        || owner.entry.sessionId !== entry.sessionId) {
        throw new Error('Bin entry has no matching ownership journal.');
      }
    }
    for (const [key, operation] of domain.table('operations').entries()) {
      if (key !== operation.plan.operationId) throw new Error('Bin operation key does not match its identity.');
    }
  }
  entries(): BinEntry[] {
    return [...this.domain.table('entries').entries()].map(([, value]) => entrySchema.parse(value));
  }
  operations(): BinOperation[] {
    return [...this.domain.table('operations').entries()].map(([, value]) => operationSchema.parse(value));
  }
  entry(sessionId: string): BinEntry | undefined {
    const value = this.domain.table('entries').get(sessionId);
    return value === undefined ? undefined : entrySchema.parse(value);
  }
  operation(operationId: string): BinOperation | undefined {
    const value = this.domain.table('operations').get(operationId);
    return value === undefined ? undefined : operationSchema.parse(value);
  }
  putEntry(value: BinEntry): Promise<void> {
    const snapshot = entrySchema.parse(value);
    return this.domain.table('entries').put(snapshot.sessionId, snapshot);
  }
  async deleteEntry(sessionId: string): Promise<void> {
    await this.domain.table('entries').delete(sessionId);
  }
  putOperation(value: BinOperation): Promise<void> {
    const snapshot = operationSchema.parse(value);
    return this.domain.table('operations').put(snapshot.plan.operationId, snapshot);
  }
  close(): Promise<void> { return this.domain.close(); }
}
