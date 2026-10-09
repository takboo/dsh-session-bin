import type { PurgePlan, PurgeResult } from '../operations/retirement.js';

export type PurgeBatchScope =
  | { kind: 'selection'; entryIds: readonly string[] }
  | { kind: 'all-archived' };

export interface PurgeClientOutcome {
  operationId: string;
  sessionId: string;
  entryId: string | null;
  status: PurgeResult['status'] | 'pending';
  reason: string | null;
}

export interface PurgeBatchTarget {
  sessionId: string;
  entryId: string;
  title: string;
}

export interface PurgeBatchItem {
  target: PurgeBatchTarget;
  state: 'preparing' | 'blocked' | 'ready' | 'running' | 'settled' | 'cancelled';
  plan: PurgePlan | null;
  reason: string | null;
  outcome: PurgeClientOutcome | null;
}

export interface PurgeBatchResourceCounts {
  erase: number;
  releaseReference: number;
  retainShared: number;
  retainCoordination: number;
}

export interface PurgeBatchState {
  batchId: string;
  scope: 'selection' | 'all-archived';
  phase: 'preparing' | 'confirming' | 'running' | 'paused' | 'done' | 'cancelled';
  frozenCount: number;
  acknowledged: boolean;
  stopRequested: boolean;
  items: PurgeBatchItem[];
  resourceCounts: PurgeBatchResourceCounts;
}

export function emptyPurgeBatchResourceCounts(): PurgeBatchResourceCounts {
  return { erase: 0, releaseReference: 0, retainShared: 0, retainCoordination: 0 };
}

export function countPurgeBatchResources(items: readonly PurgeBatchItem[]): PurgeBatchResourceCounts {
  const counts = emptyPurgeBatchResourceCounts();
  for (const resource of items.flatMap(item => item.plan?.manifest?.resources ?? [])) {
    if (resource.disposition === 'erase') counts.erase += 1;
    else if (resource.disposition === 'release-reference') counts.releaseReference += 1;
    else if (resource.disposition === 'retain-shared') counts.retainShared += 1;
    else counts.retainCoordination += 1;
  }
  return counts;
}

export function clonePurgeBatch(batch: PurgeBatchState | null): PurgeBatchState | null {
  return batch === null ? null : structuredClone(batch);
}
