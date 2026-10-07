import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { acquireBinLease } from './host/lease.js';
import { DshBinPort } from './host/native.js';
import { archiveDomainSpec, DomainArchiveStore, binDomainSpec, DomainBinStore } from './host/store.js';
import { retirementDomainSpec, DomainRetirementStore } from './host/retirement-store.js';
import type { PreparePurgeRequest, PurgePlan } from './operations/retirement.js';
import { preparePurgeRequestSchema, purgePlanSchema } from './operations/retirement.js';
import { SessionBinModule, SessionBinError, sessionBinRefusal } from './host/module.js';
import { ArchiveModule } from './host/archive.js';
import { installSessionBinRemote } from './host/remote.js';
import { planSchema } from './operations/schema.js';
import type { BinPlan } from './operations/schema.js';
import type { ArchivePlan, ArchivePrepareRequest } from './operations/archive.js';

export { acquireBinLease, BinLeaseError } from './host/lease.js';
export { DshBinPort } from './host/native.js';
export { binDomainSpec, DomainBinStore, archiveDomainSpec, DomainArchiveStore } from './host/store.js';
export type { BinStore, ArchiveStore } from './host/store.js';
export { SessionBinModule, SessionBinError } from './host/module.js';
export { ArchiveModule } from './host/archive.js';
export type { NativeArchivePort, ArchiveOptions } from './host/archive.js';
export * from './operations/archive.js';
export { SessionBinRemote, installSessionBinRemote } from './host/remote.js';
export type { NativeBinPort, NativeSessionState, ReconcileReport } from './host/module.js';
export type { BinEntry, BinPlan, BinResult, BinOperation, PrepareRequest } from './operations/schema.js';
export * from './operations/retirement.js';
export * from './host/retirement-store.js';
export { retirementManifestDigest } from './host/retirement.js';
export type { SessionRetirementOwnerV1, RetirementOptions, PurgeReconcileReport } from './host/retirement.js';
export * from './operations/retirement-owner.js';
export * from './host/retirement-owner-store.js';
export { RetirementOwnerCoordinator, RetirementOwnerError } from './host/retirement-owner.js';
export type {
  RetirementOwnerGuards, RetirementLifecycleScope, RetirementLifecyclePort,
  RetirementResourceParticipant, RetirementOwnerCoordinatorOptions, RetirementOwnerCheckpoint,
  RetirementResource, RetirementResourceReceipt,
} from './host/retirement-owner.js';

export interface Config { coordinationDirectory?: string }
export const Config = schema.object({
  coordinationDirectory: schema.string().description('Absolute shared directory for this Bin domain’s lifetime lock; defaults to $DSH_HOME/session-bin.'),
});
export const name = 'session-bin';
export const inject = ['storageDomain', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'typert'];

declare module '@deepseek-ai/cordis' {
  interface Context { sessionBin: SessionBin }
}

/** Production native archive interface; v1 core is confined to compatibility. */
export class SessionBin extends Service {
  static inject = inject;
  private module!: ArchiveModule;
  private legacy!: SessionBinModule;
  private archiveStore!: DomainArchiveStore;
  private ready = false;
  constructor(ctx: Context, private readonly config: Config = {}) { super(ctx, 'sessionBin'); }

  async [Service.init](): Promise<void> {
    const directory = this.config.coordinationDirectory ?? join(resolveDshHome(), 'session-bin');
    const release = await acquireBinLease(directory);
    const domains: Array<() => Promise<void>> = [];
    let stopListening: (() => void) | undefined;
    let disposed = false;
    let finishInitializing!: () => void;
    const initializing = new Promise<void>(resolve => { finishInitializing = resolve; });
    const closeDomains = async () => {
      const errors: unknown[] = [];
      for (const close of [...domains].reverse()) try { await close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Session Bin domains failed to close.');
    };
    try {
      this.ctx.effect(() => async () => {
        disposed = true;
        this.ready = false;
        await initializing;
        const errors: unknown[] = [];
        try { if (this.module) await this.module.close(); } catch (error) { errors.push(error); }
        try { if (this.legacy) await this.legacy.close(); } catch (error) { errors.push(error); }
        try { stopListening?.(); } catch (error) { errors.push(error); }
        try { await closeDomains(); } catch (error) { errors.push(error); }
        try { await release(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Session Bin teardown failed.');
      }, 'session-bin.dispose');
    } catch (error) {
      finishInitializing();
      await release();
      throw error;
    }
    try {
      const domain = await this.ctx.storageDomain.open(binDomainSpec);
      domains.push(() => domain.close());
      this.ctx.fiber.assertActive();
      const retirementDomain = await this.ctx.storageDomain.open(retirementDomainSpec);
      domains.push(() => retirementDomain.close());
      this.ctx.fiber.assertActive();
      const archiveDomain = await this.ctx.storageDomain.open(archiveDomainSpec);
      domains.push(() => archiveDomain.close());
      this.ctx.fiber.assertActive();
      const native = new DshBinPort(this.ctx);
      const legacyStore = new DomainBinStore(domain);
      const retirementStore = new DomainRetirementStore(retirementDomain);
      // No admitted native owner. Observation and migration never capture grants.
      this.legacy = new SessionBinModule(legacyStore, native, {
        legacyReadOnly: true, retirement: { store: retirementStore },
      });
      this.archiveStore = new DomainArchiveStore(archiveDomain);
      this.module = new ArchiveModule(this.archiveStore, native, {
        operationIdClaimed: id => legacyStore.operation(id) !== undefined || retirementStore.operation(id) !== undefined,
        pendingPurge: id => retirementStore.operations().some(operation => operation.phase !== 'done' && operation.plan.sessionId === id),
        reconcileLegacy: () => this.legacy.operations(),
      });
      stopListening = this.ctx.root.on('domain/changed', change => {
        if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
        const state = workspaceDomainState.parse(change.value);
        // Both consumers capture the frame synchronously before their queues yield.
        const legacy = this.legacy.observeArchives(state.archivedSessionIds);
        const archive = this.module.observeArchives(state.archivedSessionIds);
        void Promise.all([legacy, archive]).catch(error => {
          this.ctx.logger.warn(`session-bin: reconciliation failed: ${String(error)}`);
        });
      });
      await this.legacy.reconcile();
      await this.module.reconcile();
      this.ctx.fiber.assertActive();
      if (!disposed) this.ready = true;
    } finally { finishInitializing(); }
  }

  private requireModule(): ArchiveModule {
    if (!this.ready) throw new SessionBinError('bin/not-ready', 'Session Bin has not finished initialization or is unloading.');
    return this.module;
  }
  private checkLegacyClaim(operationId: string) {
    if (this.archiveStore.operation(operationId)) {
      throw sessionBinRefusal('bin/operation-id-reused', 'Operation identity belongs to an archive request.');
    }
  }
  prepare(request: ArchivePrepareRequest) { return this.requireModule().prepare(request); }
  preparePurge(request: PreparePurgeRequest) {
    const input = preparePurgeRequestSchema.parse(request);
    return this.requireModule().compatibility(async () => {
      if (input.operationId) this.checkLegacyClaim(input.operationId);
      return this.legacy.preparePurge(input);
    });
  }
  executePurge(input: PurgePlan) {
    const plan = purgePlanSchema.parse(input);
    return this.requireModule().compatibility(async () => { this.checkLegacyClaim(plan.operationId); return this.legacy.executePurge(plan); });
  }
  getPurgeOperation(operationId: string) { return this.requireModule().compatibility(() => this.legacy.getPurgeOperation(operationId)); }
  purgeOperations() { return this.requireModule().compatibility(() => this.legacy.purgeOperations()); }
  reconcilePurge() { return this.requireModule().compatibility(() => this.legacy.reconcilePurge()); }
  execute(input: ArchivePlan | BinPlan) {
    if (input.schemaVersion === 2) return this.requireModule().execute(input);
    const plan = planSchema.parse(input);
    return this.requireModule().compatibility(async () => { this.checkLegacyClaim(plan.operationId); return this.legacy.execute(plan); });
  }
  list() { return this.requireModule().list(); }
  operations() { return this.requireModule().operations(); }
  getOperation(operationId: string) {
    return this.requireModule().compatibility(async () => this.archiveStore.operation(operationId) ?? await this.legacy.getOperation(operationId));
  }
  reconcile() { return this.requireModule().reconcile(); }
}
export async function apply(ctx: Context, config: Config = {}) {
  await ctx.plugin(SessionBin, config);
  await installSessionBinRemote(ctx);
}
