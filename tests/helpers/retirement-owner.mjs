import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import * as bin from '../../dist/index.js';
import { ids, openFixture, workspaceRoot } from './fixture.mjs';

// This owner controls ONLY this test domain. It never removes or rewrites a
// native transcript, session directory, Workspace record, cache or lock file.
const recordSchema = z.object({
  schemaVersion: z.literal(1), resourceId: z.string(), kind: z.string(),
  revision: z.string(), lifecycleId: z.string().nullable(),
  payload: z.string().nullable(), references: z.array(z.string()), sharedResourceId: z.string().nullable(),
}).strict();
const sessionSchema = z.object({
  schemaVersion: z.literal(1), lifecycle: z.object({ storeId: z.string(), sessionId: z.string(), lifecycleId: z.string() }).strict(),
  status: z.enum(['live', 'retired']), manifest: z.unknown(),
}).strict();
function ownerSpec() {
  return defineDomain({
    name: 'session_bin_fixture_owner', version: 1, layout: 'single',
    global: { schema: z.object({ schemaVersion: z.literal(1), storeId: z.string().nullable() }).strict(),
      initial: { schemaVersion: 1, storeId: null } },
    tables: { sessions: domainTable(sessionSchema), resources: domainTable(recordSchema),
      protected: domainTable(bin.lifecycleKeySchema), operations: domainTable(bin.retirementStateSchema) },
  });
}
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function override(owner, methods) {
  return new Proxy(owner, { get(target, key) {
    if (Object.hasOwn(methods, key)) return methods[key];
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
export function latch() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { entered: entered.promise, release: released.resolve,
    async pause() { entered.resolve(); await released.promise; } };
}

/** Closed-world, durable reference owner for consumer-protocol tests. */
export class ReferenceRetirementOwner {
  constructor(domain, options = {}) {
    this.domain = domain;
    this.options = options;
    this.tail = Promise.resolve();
    this.checkpoints = [];
    this.retireCalls = 0;
    this.recoverCalls = 0;
    this.effectCalls = 0;
    this.authorizeCalls = 0;
  }
  static async open(ctx, root, options = {}) {
    const canonicalRoot = await realpath(root);
    const parent = await realpath(join(workspaceRoot, '.local', 'lifecycle'));
    const rel = relative(parent, canonicalRoot);
    assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'owner must use isolated lifecycle data');
    const domain = await ctx.storageDomain.open(ownerSpec());
    try {
      if (domain.global.get().storeId === null) {
        await domain.global.set({ schemaVersion: 1, storeId: randomUUID() });
      }
      return new ReferenceRetirementOwner(domain, options);
    } catch (error) { await domain.close(); throw error; }
  }
  async capabilities() {
    return bin.retirementCapabilitiesSchema.parse({ protocolVersion: 1,
      ownerId: 'fixture-retirement-owner', hostVersion: 'test-fixture-v1',
      providerId: 'fixture-domain-v1', storeId: this.domain.global.get().storeId,
      participants: [{ id: 'fixture-resource-owner', version: '1' }] });
  }
  async inspect(sessionId) {
    const session = this.domain.table('sessions').get(sessionId);
    return !session || session.status === 'retired' ? null : clone(session.lifecycle);
  }
  async prepare(expected) {
    const session = this.domain.table('sessions').get(expected.sessionId);
    if (!session || !bin.lifecycleEqual(session.lifecycle, expected) || session.status !== 'live') {
      throw new Error('Fixture lifecycle is not live or changed.');
    }
    return bin.retirementManifestSchema.parse(session.manifest);
  }
  async seed(sessionIds = ids) {
    for (const sessionId of sessionIds) {
      if (!this.domain.table('sessions').get(sessionId)) await this.createLifecycle(sessionId);
    }
  }
  createLifecycle(sessionId) {
    return this.serial(async () => {
      const previous = this.domain.table('sessions').get(sessionId);
      assert(!previous || !this.fenced(previous.lifecycle), 'cannot reuse a fenced lifecycle');
      const capabilities = await this.capabilities();
      const lifecycle = { storeId: capabilities.storeId, sessionId, lifecycleId: randomUUID() };
      const protectedLifecycle = bin.lifecycleKeySchema.parse({ storeId: capabilities.storeId,
        sessionId: `${sessionId}-independent-fork`, lifecycleId: randomUUID() });
      await this.domain.table('protected').put(protectedLifecycle.lifecycleId, protectedLifecycle);
      const ownerId = capabilities.participants[0].id;
      const resources = [];
      const prefix = lifecycle.lifecycleId;
      const add = async (name, kind, disposition, payload, references = [], sharedResourceId = null) => {
        const resourceId = `${prefix}:${name}`;
        const retention = disposition === 'retain-shared'
          ? { retention: { reason: 'shared-reference', retainedBy: [protectedLifecycle] } }
          : disposition === 'retain-coordination'
            ? { retention: { reason: 'coordination-identity', retainedBy: [] } } : { retention: null };
        const resource = { ownerId, resourceId, revision: '1', kind, disposition, ...retention };
        resources.push(resource);
        const record = recordSchema.parse({ schemaVersion: 1, resourceId, kind, revision: '1',
          lifecycleId: disposition === 'retain-shared' ? null : lifecycle.lifecycleId,
          payload, references, sharedResourceId });
        await this.domain.table('resources').put(resourceId, record);
        return resourceId;
      };
      await add('generation-v3', 'transcript', 'erase', `fixture history v3 for ${sessionId}`);
      await add('generation-v4', 'transcript', 'erase', `fixture history v4 for ${sessionId}`);
      for (const kind of ['workspace', 'index', 'cache', 'spill']) {
        await add(kind, kind, 'erase', `fixture-owned ${kind} for ${sessionId}`);
      }
      const shared = await add('shared-attachment', 'attachment', 'retain-shared', 'shared fixture attachment',
        [lifecycle.lifecycleId, protectedLifecycle.lifecycleId]);
      await add('attachment-reference', 'attachment', 'release-reference', null, [], shared);
      await add('coordination', 'coordination', 'retain-coordination', null);
      const manifest = bin.retirementManifestSchema.parse({ schemaVersion: 1, lifecycle, capabilities, resources });
      await this.domain.table('sessions').put(sessionId, sessionSchema.parse({ schemaVersion: 1, lifecycle, status: 'live', manifest }));
      return clone(lifecycle);
    });
  }
  async resourceSnapshot(expected) {
    const session = this.domain.table('sessions').get(expected.sessionId);
    assert(session && bin.lifecycleEqual(session.lifecycle, expected));
    const manifest = bin.retirementManifestSchema.parse(session.manifest);
    return manifest.resources.map(resource => ({ resource: clone(resource),
      record: this.domain.table('resources').get(resource.resourceId) ?? null })).map(clone);
  }
  async bumpManifest(expected) {
    return this.serial(async () => {
      assert(!this.fenced(expected), 'cannot change resources under a durable fence');
      const session = this.domain.table('sessions').get(expected.sessionId);
      assert(session && bin.lifecycleEqual(session.lifecycle, expected));
      const manifest = bin.retirementManifestSchema.parse(session.manifest);
      manifest.resources[0].revision = `${Number(manifest.resources[0].revision) + 1}`;
      const resource = this.domain.table('resources').get(manifest.resources[0].resourceId);
      await this.domain.table('resources').put(resource.resourceId, recordSchema.parse({ ...resource, revision: manifest.resources[0].revision }));
      await this.domain.table('sessions').put(expected.sessionId, sessionSchema.parse({ ...session, manifest }));
    });
  }
  async appendFixtureResource(expected, text) {
    return this.serial(async () => {
      assert(!this.fenced(expected), 'fixture writer is fenced');
      const session = this.domain.table('sessions').get(expected.sessionId);
      assert(session && session.status === 'live' && bin.lifecycleEqual(session.lifecycle, expected), 'exact lifecycle required');
      const manifest = bin.retirementManifestSchema.parse(session.manifest);
      const resource = this.domain.table('resources').get(manifest.resources[0].resourceId);
      assert(resource, 'retired transcript cannot be resurrected');
      const revision = `${Number(resource.revision) + 1}`;
      await this.domain.table('resources').put(resource.resourceId, recordSchema.parse({ ...resource,
        payload: resource.payload + text, revision }));
      manifest.resources[0].revision = revision;
      await this.domain.table('sessions').put(expected.sessionId, sessionSchema.parse({ ...session, manifest }));
    });
  }
  fenced(expected) {
    return [...this.domain.table('operations').entries()].some(([, operation]) =>
      bin.lifecycleEqual(operation.request.expected, expected) && !['rejected', 'conflict', 'done'].includes(operation.phase));
  }
  retire(input, authorize) {
    const request = bin.retirementRequestSchema.parse(input);
    return this.serial(async () => {
      this.retireCalls += 1;
      const previous = this.domain.table('operations').get(request.operationId);
      if (previous) {
        assert(equal(previous.request, request), 'fixture operation identity reused');
        return bin.retirementStateSchema.parse(previous);
      }
      const manifest = await this.prepare(request.expected);
      assert.equal(bin.retirementManifestDigest(manifest), request.manifestDigest, 'manifest changed before owner admission');
      await this.checkpoint('before-authorize', { request, manifest });
      this.authorizeCalls += 1;
      const grant = await authorize();
      if (grant.authorized === false) {
        return this.save({ schemaVersion: 1, request, manifest, authorizationId: null,
          phase: 'rejected', reason: grant.reason, resources: [] });
      }
      assert.equal(grant.authorized, true, 'fixture owner requires an explicit authorization grant');
      assert(grant.authorizationId, 'authorization handoff requires its exact nonce');
      const current = await this.prepare(request.expected);
      assert.equal(bin.retirementManifestDigest(current), request.manifestDigest);
      const state = await this.save({ schemaVersion: 1, request, manifest, authorizationId: grant.authorizationId,
        phase: 'fenced', reason: null, resources: [] });
      await this.checkpoint('owner-fenced', state);
      if (this.options.pauseAt === 'fenced') return state;
      return this.advance(state);
    });
  }
  async getOperation(operationId) {
    const state = this.domain.table('operations').get(operationId);
    return state === undefined ? null : bin.retirementStateSchema.parse(state);
  }
  recover(operationId) {
    return this.serial(async () => {
      this.recoverCalls += 1;
      const state = await this.getOperation(operationId);
      assert(state, 'recover only an already durable fixture operation');
      if (['done', 'rejected', 'conflict'].includes(state.phase) || this.options.pauseAt === state.phase) return state;
      return this.advance(state);
    });
  }
  async advance(input) {
    let state = bin.retirementStateSchema.parse(input);
    if (state.phase === 'fenced') {
      state = await this.save({ ...state, phase: 'quiesced' });
      await this.checkpoint('owner-quiesced', state);
      if (this.options.pauseAt === 'quiesced') return state;
    }
    if (state.phase === 'quiesced') state = await this.save({ ...state, phase: 'erasing' });
    if (state.phase === 'erasing') {
      for (const resource of state.manifest.resources) {
        const previous = state.resources.find(receipt => receipt.ownerId === resource.ownerId && receipt.resourceId === resource.resourceId);
        if (previous && previous.status !== 'failed') continue;
        if (this.options.failResource === resource.kind || this.options.failResource === resource.resourceId) {
          const receipt = { ownerId: resource.ownerId, resourceId: resource.resourceId, status: 'failed', reason: 'fixture-injected-resource-failure' };
          return this.save({ ...state, resources: [...state.resources.filter(item => item.resourceId !== resource.resourceId), receipt] });
        }
        await this.applyResource(state.request.expected, resource);
        await this.checkpoint('resource-effect', { state, resource });
        const status = resource.disposition === 'erase' ? 'erased'
          : resource.disposition === 'release-reference' ? 'reference-released' : 'retained';
        state = await this.save({ ...state,
          resources: [...state.resources.filter(item => item.resourceId !== resource.resourceId),
            { ownerId: resource.ownerId, resourceId: resource.resourceId, status,
              reason: status === 'retained' ? resource.retention.reason : null }] });
        await this.checkpoint('resource-receipt', { state, resource });
      }
      state = await this.save({ ...state, phase: 'converging' });
      await this.checkpoint('owner-converging', state);
      if (this.options.pauseAt === 'converging') return state;
    }
    const session = this.domain.table('sessions').get(state.request.expected.sessionId);
    assert(session && bin.lifecycleEqual(session.lifecycle, state.request.expected), 'owner cannot retire a replacement');
    await this.domain.table('sessions').put(session.lifecycle.sessionId, sessionSchema.parse({ ...session, status: 'retired' }));
    state = await this.save({ ...state, phase: 'done' });
    await this.checkpoint('owner-done', state);
    return state;
  }
  async applyResource(expected, resource) {
    const table = this.domain.table('resources');
    const record = table.get(resource.resourceId);
    if (resource.disposition === 'erase' || resource.disposition === 'release-reference') {
      // A missing record is idempotent ONLY inside this owner's durable operation
      // and frozen manifest, never an inference from native Session stat/list.
      if (record === undefined) return;
      assert.equal(record.lifecycleId, expected.lifecycleId);
      assert.equal(record.revision, resource.revision);
      if (resource.disposition === 'release-reference') {
        const shared = table.get(record.sharedResourceId);
        assert(shared, 'known shared object must exist');
        await table.put(shared.resourceId, recordSchema.parse({ ...shared,
          references: shared.references.filter(item => item !== expected.lifecycleId) }));
      }
      await table.delete(resource.resourceId);
    } else {
      assert(record, 'retained resource must remain present');
      if (resource.disposition === 'retain-shared') {
        assert.equal(resource.retention.reason, 'shared-reference');
        const retainedIds = resource.retention.retainedBy.map(key => {
          const protectedLifecycle = this.domain.table('protected').get(key.lifecycleId);
          assert(protectedLifecycle && bin.lifecycleEqual(protectedLifecycle, key), 'retention needs a durable independent lifecycle');
          assert(!bin.lifecycleEqual(key, expected), 'the target cannot witness its own shared retention');
          return key.lifecycleId;
        });
        assert(record.references.filter(item => item !== expected.lifecycleId).every(item => retainedIds.includes(item)));
        assert(retainedIds.every(item => record.references.includes(item)));
      } else {
        assert.equal(record.kind, 'coordination');
        assert.equal(resource.retention.reason, 'coordination-identity');
        assert.deepEqual(resource.retention.retainedBy, []);
      }
    }
    this.effectCalls += 1;
  }
  async save(value) {
    const state = bin.retirementStateSchema.parse(value);
    await this.domain.table('operations').put(state.request.operationId, state);
    return bin.retirementStateSchema.parse(state);
  }
  async checkpoint(name, value) {
    const snapshot = clone(value);
    this.checkpoints.push({ name, value: snapshot });
    if (this.options.slowGate?.checkpoint === name) await this.options.slowGate.gate.pause();
    await this.options.onCheckpoint?.(name, clone(snapshot), this);
  }
  serial(work) {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  close() { return this.tail.then(() => this.domain.close()); }
}

/** Open all consumer/owner domains under the SAME existing plugin lease. */
export async function openRetirementFixture(root, options = {}) {
  const fixture = await openFixture(root, { seed: options.seed ?? false, plugin: false });
  let release;
  let binDomain;
  let purgeDomain;
  let owner;
  let module;
  let off;
  try {
    release = await bin.acquireBinLease(join(root, 'coordination'));
    binDomain = await fixture.ctx.storageDomain.open(bin.binDomainSpec);
    purgeDomain = await fixture.ctx.storageDomain.open(bin.retirementDomainSpec);
    owner = await ReferenceRetirementOwner.open(fixture.ctx, root, options.ownerOptions);
    if (options.seed) await owner.seed(options.sessionIds ?? ids);
    const store = new bin.DomainBinStore(binDomain);
    const retirementStore = new bin.DomainRetirementStore(purgeDomain);
    const native = new bin.DshBinPort(fixture.ctx);
    const exposedOwner = options.ownerEnabled === false ? undefined
      : options.ownerWrapper ? options.ownerWrapper(owner) : owner;
    module = new bin.SessionBinModule(options.storeWrapper?.(store) ?? store,
      options.nativeWrapper?.(native) ?? native,
      { retirement: { owner: exposedOwner, store: options.purgeStoreWrapper?.(retirementStore) ?? retirementStore,
        verified: options.verified ?? (caps => caps.providerId === 'fixture-domain-v1' && caps.hostVersion === 'test-fixture-v1') } });
    off = fixture.ctx.root.on('domain/changed', change => {
      if (change.domain === 'workspace' && change.table === '' && change.operation === 'put') {
        void module.observeArchives(change.value.archivedSessionIds).catch(() => {});
      }
    });
    await options.beforeReconcile?.({ fixture, module, owner, store, retirementStore });
    if (!options.skipReconcile) await module.reconcile();
    let closing;
    const close = () => closing ??= (async () => {
      try { await module.close(); }
      finally {
        off?.();
        try { await owner.close(); }
        finally {
          try { await purgeDomain.close(); await binDomain.close(); }
          finally { await release(); await fixture.close(); }
        }
      }
    })();
    return { ...fixture, module, owner, store, retirementStore, close };
  } catch (error) {
    off?.();
    try { await module?.close(); } catch {}
    try { await owner?.close(); } catch {}
    try { await purgeDomain?.close(); } catch {}
    try { await binDomain?.close(); } catch {}
    try { await release?.(); } catch {}
    await fixture.close();
    throw error;
  }
}
