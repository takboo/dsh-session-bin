import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import * as binPlugin from '../../dist/index.js';

export const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const ids = ['quiet', 'sibling', 'native-only', 'active', 'ungrouped', 'race', 'missing-later'];

export async function createScratch(prefix = 'lifecycle-') {
  const parent = join(workspaceRoot, '.local', 'lifecycle');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, prefix));
  const canonical = await realpath(root);
  const rel = relative(await realpath(workspaceRoot), canonical);
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`));
  await mkdir(join(root, 'workspace'), { mode: 0o700 });
  return root;
}

export async function openFixture(root, { seed = false, plugin = true, observe = true, compression = 'none', legacy = true } = {}) {
  root = await realpath(resolve(root));
  const rel = relative(await realpath(join(workspaceRoot, '.local', 'lifecycle')), root);
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'fixtures must use isolated workspace data');
  process.env.DSH_HOME = join(root, 'dsh-home');
  const ctx = new Context();
  const fibers = [];
  const state = { activity: new Map(), stops: [], changes: [], activityQueries: 0 };
  const mount = async (implementation, config) => {
    const fiber = ctx.plugin(implementation, config);
    fibers.push(fiber);
    await fiber;
    if (fiber.error) throw fiber.error;
    return fiber;
  };
  const close = async () => {
    const errors = [];
    for (const fiber of [...fibers].reverse()) {
      try { await fiber.dispose(); } catch (error) { errors.push(error); }
    }
    try { await ctx.fiber.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'fixture teardown failed');
  };
  try {
    await mount(TypertRegistry);
    await mount(Storage);
    await mount(storageJson, { root: join(root, 'storage') });
    await mount(storageDomain, { backend: 'json' });
    await mount(SessionStore);
    await mount(Jsonl, { root: join(root, 'logs'), compression });
    if (seed) {
      for (const [index, rawId] of ids.entries()) {
        const session = ctx.sessions.prepare(SessionId(rawId), { meta: {
          ...(rawId === 'ungrouped' ? {} : { cwd: join(root, 'workspace') }), createdAt: 10000 - index,
        } });
        const handle = await ctx.sessionPersistence.create(session.header);
        try {
          await handle.append([
            { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
            { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
          ]);
          await handle.flush();
        } finally { await handle.close(); }
      }
    }
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      state.activityQueries += 1;
      return [...(state.activity.get(sessionId) ?? []).map(kind => ({ kind })), ...await next()];
    });
    ctx.on('workspace/session-stop', ({ sessionId }) => { state.stops.push(sessionId); });
    ctx.on('domain/changed', change => { state.changes.push(structuredClone(change)); });
    await mount(WorkspaceRegistry);
    assert(ctx.workspaceRegistry);
    let binFiber;
    let bin;
    if (plugin && legacy) {
      // Old lifecycle/owner regressions explicitly exercise the compatibility
      // core, never the production archive Service or its Remote entry points.
      binFiber = await mount({ name: 'legacy-bin-regression-fixture', inject: binPlugin.inject, async apply(owner) {
        const release = await binPlugin.acquireBinLease(join(root, 'coordination'));
        let domain;
        let retirementDomain;
        let off = () => {};
        owner.effect(() => async () => {
          const errors = [];
          try { await bin?.close(); } catch (error) { errors.push(error); }
          off();
          for (const handle of [retirementDomain, domain]) try { await handle?.close(); } catch (error) { errors.push(error); }
          try { await release(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, 'legacy fixture teardown failed');
        });
        domain = await owner.storageDomain.open(binPlugin.binDomainSpec);
        retirementDomain = await owner.storageDomain.open(binPlugin.retirementDomainSpec);
        bin = new binPlugin.SessionBinModule(new binPlugin.DomainBinStore(domain), new binPlugin.DshBinPort(owner), {
          retirement: { store: new binPlugin.DomainRetirementStore(retirementDomain) },
        });
        off = owner.root.on('domain/changed', change => {
          if (observe && change.domain === 'workspace' && change.table === '' && change.operation === 'put') {
            void bin.observeArchives(change.value.archivedSessionIds).catch(() => {});
          }
        });
        await bin.reconcile();
      } }, undefined);
    } else if (plugin) {
      binFiber = await mount(binPlugin, { coordinationDirectory: join(root, 'coordination') });
      bin = ctx.get('sessionBin');
      assert(bin);
    }
    return { root, ctx, state, binFiber, mount, close, bin, archive: legacy ? undefined : bin,
      async openModule({ storeWrapper = value => value, nativeWrapper = value => value, retirement = {} } = {}) {
        const release = await binPlugin.acquireBinLease(join(root, 'coordination'));
        let domain;
        let retirementDomain;
        let retirementStore;
        let store;
        let native;
        let module;
        let off = () => {};
        const dispose = async () => {
          const errors = [];
          try { await module?.close(); } catch (error) { errors.push(error); }
          try { off(); } catch (error) { errors.push(error); }
          for (const handle of [retirementStore, retirementDomain, domain]) {
            try { await handle?.close(); } catch (error) { errors.push(error); }
          }
          try { await release(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, 'module fixture teardown failed');
        };
        try {
          domain = await ctx.storageDomain.open(binPlugin.binDomainSpec);
          if (retirement.store) retirementStore = retirement.store;
          else {
            retirementDomain = await ctx.storageDomain.open(binPlugin.retirementDomainSpec);
            retirementStore = new binPlugin.DomainRetirementStore(retirementDomain);
          }
          store = new binPlugin.DomainBinStore(domain);
          native = new binPlugin.DshBinPort(ctx);
          module = new binPlugin.SessionBinModule(storeWrapper(store), nativeWrapper(native), {
            retirement: { ...retirement, store: retirementStore },
          });
          off = observe ? ctx.on('domain/changed', change => {
            if (change.domain === 'workspace' && change.table === '' && change.operation === 'put') {
              void module.observeArchives(change.value.archivedSessionIds).catch(() => {});
            }
          }) : () => {};
          await module.reconcile();
          let closing;
          return { module, store, native, retirementStore, close: () => closing ??= dispose() };
        } catch (error) {
          try { await dispose(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'module fixture initialization and cleanup failed'); }
          throw error;
        }
      },
    };
  } catch (error) { await close(); throw error; }
}

export async function transcript(fixture, id = 'quiet') {
  const handle = await fixture.ctx.sessionPersistence.open(SessionId(id), 'read');
  try { return structuredClone(await handle.read()); }
  finally { await handle.close(); }
}
export function accounting(fixture) {
  return fixture.ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, sessions: [...workspace.sessionIds] }));
}
