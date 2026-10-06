import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { acquireBinLease } from './host/lease.js';
import { DshBinPort } from './host/native.js';
import { binDomainSpec, DomainBinStore } from './host/store.js';
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
    let closeDomain: (() => Promise<void>) | undefined;
    let stopListening: (() => void) | undefined;
    try {
      this.ctx.effect(() => async () => {
        this.ready = false;
        try {
          if (this.module) await this.module.close();
        } finally {
          stopListening?.();
          // Module.close also closes this handle. The idempotent second close
          // proves teardown succeeded even if its final reconciliation failed.
          await closeDomain?.();
          await release();
        }
      }, 'session-bin.dispose');
    } catch (error) {
      // Cancellation may make this fiber inactive while lock acquisition awaits.
      await release();
      throw error;
    }
    const domain = await this.ctx.storageDomain.open(binDomainSpec);
    closeDomain = () => domain.close();
    this.module = new SessionBinModule(new DomainBinStore(domain), new DshBinPort(this.ctx));
    // Root-owned subscription is explicitly removed AFTER the Module drains;
    // a fiber-owned listener would be removed as soon as unload starts.
    stopListening = this.ctx.root.on('domain/changed', change => {
      if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
      // Registry getters lag this synchronous domain event. Read the frame.
      const state = workspaceDomainState.parse(change.value);
      void this.module.observeArchives(state.archivedSessionIds).catch(error => {
        this.ctx.logger.warn(`session-bin: reconciliation failed: ${String(error)}`);
      });
    });
    await this.module.reconcile();
    this.ready = true;
  }

  private requireModule(): SessionBinModule {
    if (!this.ready) throw new SessionBinError('bin/not-ready', 'Session Bin has not finished initialization or is unloading.');
    return this.module;
  }
  prepare(request: PrepareRequest) { return this.requireModule().prepare(request); }
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
