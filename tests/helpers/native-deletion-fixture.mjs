import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as product from '../../dist/index.js';
import { openFixture } from './fixture.mjs';
import { nativeOwnerOptions, sessionBinPlugin } from './platform-fixture.mjs';

const require = createRequire(import.meta.url);
const base = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const sdk = createRequire(base.resolve('@deepseek-ai/dsh-base/package.json'));
const load = async name => import(pathToFileURL(sdk.resolve(name)).href);
const Projection = (await load('@deepseek-ai/dsh-session-projection')).default;
const Cache = (await load('@deepseek-ai/dsh-session-projection-cache')).default;
const Query = (await load('@deepseek-ai/dsh-session-query-sqlite')).default;

/** Real SDK participants, not the closed-world reference retirement owner. */
export async function openNativeDeletionFixture(root, { seed = false, compression = 'none', ownerOptions = {}, productService = false, queryMode = 'enabled' } = {}) {
  const fixture = await openFixture(root, { seed, plugin: false, compression });
  let release; let archiveDomain; let purgeDomain; let nativeOwner; let module; let off; let productFiber;
  try {
    await fixture.mount(Projection);
    await fixture.mount(Cache, { writeEveryEvents: 16, writeIntervalMs: 1000 });
    await fixture.mount(Query, queryMode === 'disabled-memory' ? { path: ':memory:', openAt: 'never' }
      : { path: join(root, 'native-query.sqlite'), openAt: 'startup' });
    if (seed) {
      for (const id of ['quiet', 'sibling']) {
        const handle = await fixture.ctx.sessionPersistence.open(SessionId(id), 'read');
        try { const log = await handle.read(); fixture.ctx.get('sessionProjectionCache').coldSnapshot(handle.header, handle.inheritedEventCount, log.events); }
        finally { await handle.close(); }
      }
      // Join actual cache write chain and materialize actual SQLite documents.
      await fixture.ctx.get('sessionProjectionCache').requireTable().host.enqueue(async () => undefined);
      if (queryMode === 'enabled') await fixture.ctx.get('sessionQuery').searchSessions({ query: 'native-deletion-probe', limit: 1 });
      await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    }
    if (productService) {
      productFiber = await fixture.mount(sessionBinPlugin(root), { coordinationDirectory: join(root, 'coordination') });
      module = fixture.ctx.get('sessionBin');
      nativeOwner = module.nativeOwner;
    } else {
      release = await product.acquireBinLease(join(root, 'coordination'));
      archiveDomain = await fixture.ctx.storageDomain.open(product.archiveDomainSpec);
      purgeDomain = await fixture.ctx.storageDomain.open(product.retirementDomainSpec);
      nativeOwner = await product.NativeRetirementOwner.open(fixture.ctx, nativeOwnerOptions(root, ownerOptions)); assert(nativeOwner);
      const store = new product.DomainArchiveStore(archiveDomain);
      const retirementStore = new product.DomainRetirementStore(purgeDomain);
      module = new product.ArchiveModule(store, new product.DshBinPort(fixture.ctx), { retirement: {
        store: retirementStore, closeStore: false, owner: nativeOwner, verifiedNativeArchive: () => true,
      } });
      off = fixture.ctx.on('domain/changed', change => {
        if (change.domain === 'workspace' && change.table === '' && change.operation === 'put') void module.observeArchives(change.value.archivedSessionIds).catch(() => {});
      });
      await module.reconcile();
    }
    let closed;
    const close = () => closed ??= (async () => {
      const errors = [];
      if (!productService) {
        for (const action of [() => module?.close(), () => nativeOwner?.close(), () => off?.(), () => purgeDomain?.close(), () => archiveDomain?.close(), () => release?.()]) {
          try { await action(); } catch (error) { errors.push(error); }
        }
      }
      try { await fixture.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Native deletion fixture teardown failed.');
    })();
    return { ...fixture, module, nativeOwner, productFiber, close };
  } catch (error) {
    const errors = [error];
    for (const action of [() => module?.close(), () => nativeOwner?.close(), () => off?.(), () => purgeDomain?.close(), () => archiveDomain?.close(), () => release?.(), () => fixture.close()]) {
      try { await action(); } catch (cleanup) { errors.push(cleanup); }
    }
    throw errors.length === 1 ? error : new AggregateError(errors, 'Native deletion fixture initialization failed.');
  }
}
