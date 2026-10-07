import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { acquireBinLease } from './host/lease.js';
import { DshBinPort } from './host/native.js';
import { binDomainSpec, DomainBinStore } from './host/store.js';
import { retirementDomainSpec, DomainRetirementStore } from './host/retirement-store.js';
import type { PreparePurgeRequest, PurgePlan } from './operations/retirement.js';
import { SessionBinModule, SessionBinError } from './host/module.js';
import { installSessionBinRemote } from './host/remote.js';
import type { BinPlan, PrepareRequest } from './operations/schema.js';

export { acquireBinLease, BinLeaseError } from './host/lease.js';
export { DshBinPort } from './host/native.js';
export { binDomainSpec, DomainBinStore } from './host/store.js';
export type { BinStore } from './host/store.js';
export { SessionBinModule, SessionBinError } from './host/module.js';
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

/** Host-only public Interface. Client transport and UI are a later slice. */
export class SessionBin extends Service {
  static inject = inject;
  private module!: SessionBinModule;
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
        // Keep the lease while an asynchronous domain open/initial reconciliation
        // settles. A cancelled initialization cannot publish a late unowned handle.
        await initializing;
        const errors: unknown[] = [];
        try { if (this.module) await this.module.close(); } catch (error) { errors.push(error); }
        try { stopListening?.(); } catch (error) { errors.push(error); }
        try { await closeDomains(); } catch (error) { errors.push(error); }
        // Domain.close refuses new writes before draining, even when unit.close
        // rejects. All admitted Module/callback writes have settled at this point.
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
      // No native adapter is admitted in 0.2.0-rc.2. Config cannot turn a
      // self-reported provider capability into deletion authorization.
      this.module = new SessionBinModule(new DomainBinStore(domain), new DshBinPort(this.ctx), {
        retirement: { store: new DomainRetirementStore(retirementDomain) },
      });
      stopListening = this.ctx.root.on('domain/changed', change => {
        if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
        const state = workspaceDomainState.parse(change.value);
        void this.module.observeArchives(state.archivedSessionIds).catch(error => {
          this.ctx.logger.warn(`session-bin: reconciliation failed: ${String(error)}`);
        });
      });
      await this.module.reconcile();
      this.ctx.fiber.assertActive();
      if (!disposed) this.ready = true;
    } finally { finishInitializing(); }
  }

  private requireModule(): SessionBinModule {
    if (!this.ready) throw new SessionBinError('bin/not-ready', 'Session Bin has not finished initialization or is unloading.');
    return this.module;
  }
  prepare(request: PrepareRequest) { return this.requireModule().prepare(request); }
  preparePurge(request: PreparePurgeRequest) { return this.requireModule().preparePurge(request); }
  executePurge(plan: PurgePlan) { return this.requireModule().executePurge(plan); }
  getPurgeOperation(operationId: string) { return this.requireModule().getPurgeOperation(operationId); }
  purgeOperations() { return this.requireModule().purgeOperations(); }
  reconcilePurge() { return this.requireModule().reconcilePurge(); }
  execute(plan: BinPlan) { return this.requireModule().execute(plan); }
  list() { return this.requireModule().list(); }
  operations() { return this.requireModule().operations(); }
  getOperation(operationId: string) { return this.requireModule().getOperation(operationId); }
  reconcile() { return this.requireModule().reconcile(); }
}
export async function apply(ctx: Context, config: Config = {}) {
  await ctx.plugin(SessionBin, config);
  await installSessionBinRemote(ctx);
}
