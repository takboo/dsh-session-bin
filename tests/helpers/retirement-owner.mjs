import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import * as bin from '../../dist/index.js';
import { ids, openFixture, workspaceRoot } from './fixture.mjs';

// Fixture-owned data only. The production Coordinator owns a separate journal;
// none of these ports remove native logs, Workspace records, caches or locks.
const recordSchema = z.object({ schemaVersion: z.literal(1), resourceId: z.string(), kind: z.string(),
  revision: z.string(), lifecycleId: z.string().nullable(), payload: z.string().nullable(),
  references: z.array(z.string()), sharedResourceId: z.string().nullable() }).strict();
const sessionSchema = z.object({ schemaVersion: z.literal(1), lifecycle: z.object({ storeId: z.string(),
  sessionId: z.string(), lifecycleId: z.string() }).strict(), status: z.enum(['live', 'retired']), manifest: z.unknown() }).strict();
function dataSpec() {
  return defineDomain({ name: 'session_bin_fixture_owner', version: 1, layout: 'single',
    global: { schema: z.object({ schemaVersion: z.literal(1), storeId: z.string().nullable() }).strict(),
      initial: { schemaVersion: 1, storeId: null } },
    tables: { sessions: domainTable(sessionSchema), resources: domainTable(recordSchema), protected: domainTable(bin.lifecycleKeySchema) } });
}
const clone = value => structuredClone(value);
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
  return { entered: entered.promise, release: released.resolve, async pause() { entered.resolve(); await released.promise; } };
}
async function cleanupAll(actions, message) {
  const errors = [];
  for (const action of actions) try { await action?.(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, message);
}

export function multiParticipantOptions(extra = {}) {
  return { participantIdentities: [
    { id: 'fixture-logs', version: '1' }, { id: 'fixture-derived', version: '1' }, { id: 'fixture-shared', version: '1' },
  ], resourceOwner: kind => kind === 'transcript' ? 'fixture-logs'
    : ['attachment', 'coordination'].includes(kind) ? 'fixture-shared' : 'fixture-derived', ...extra };
}

/** Lifecycle/resource adapters. There is no handwritten journal phase machine. */
export class ReferenceRetirementOwner {
  constructor(domain, journalDomain, options = {}) {
    this.domain = domain;
    this.journalDomain = journalDomain;
    this.options = options;
    this.tail = Promise.resolve();
    this.checkpoints = [];
    this.events = [];
    this.retireCalls = this.recoverCalls = this.effectCalls = this.authorizeCalls = 0;
    this.activeUses = new Set();
    this.scopes = new Set();
    this.lifecycleGuards = null;
    this.participantGuards = new Map();
    this.descriptor = bin.retirementCapabilitiesSchema.parse({ protocolVersion: 1, ownerId: 'fixture-retirement-owner',
      hostVersion: 'test-fixture-v1', providerId: 'fixture-domain-v1', storeId: domain.global.get().storeId,
      participants: options.participantIdentities ?? [{ id: 'fixture-resource-owner', version: '1' }] });
    this.rawOwnerStore = new bin.DomainRetirementOwnerStore(journalDomain);
    this.ownerStore = options.ownerStoreWrapper?.(this.rawOwnerStore, this) ?? this.rawOwnerStore;
    this.lifecyclePort = this.makeLifecyclePort();
    this.participants = this.descriptor.participants.map(identity => this.makeParticipant(identity));
    this.coordinator = new bin.RetirementOwnerCoordinator({ capabilities: this.descriptor, store: this.ownerStore,
      lifecycle: options.lifecycleWrapper?.(this.lifecyclePort, this) ?? this.lifecyclePort,
      participants: this.participants.map(participant => options.participantWrapper?.(participant, this) ?? participant),
      canAdvance: record => this.options.canAdvance ? this.options.canAdvance(record) : this.options.pauseAt !== record.state.phase,
      checkpoint: (name, context) => this.checkpoint(name, context) });
  }
  static async open(ctx, root, options = {}) {
    const canonicalRoot = await realpath(root);
    const parent = await realpath(join(workspaceRoot, '.local', 'lifecycle'));
    const rel = relative(parent, canonicalRoot);
    assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'owner must use isolated lifecycle data');
    const domain = await ctx.storageDomain.open(dataSpec());
    let journalDomain;
    let owner;
    try {
      if (domain.global.get().storeId === null) await domain.global.set({ schemaVersion: 1, storeId: randomUUID() });
      journalDomain = await ctx.storageDomain.open(bin.retirementOwnerDomainSpec);
      owner = new ReferenceRetirementOwner(domain, journalDomain, options);
      if (!options.deferInitialize) await owner.initialize();
      return owner;
    } catch (error) {
      try { await cleanupAll([() => owner?.close(), () => journalDomain?.close(), () => domain.close()], 'Owner initialization cleanup failed'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Owner initialization failed'); }
      throw error;
    }
  }
  initialize() { return this.coordinator.initialize(); }
  capabilities() { return this.coordinator.capabilities(); }
  inspect(sessionId) { return this.coordinator.inspect(sessionId); }
  prepare(expected) { return this.coordinator.prepare(expected); }
  async retire(input, authorize, frozenManifest) {
    this.retireCalls += 1;
    const request = bin.retirementRequestSchema.parse(input);
    const frozen = frozenManifest ?? this.rawOwnerStore.operation(request.operationId)?.state.manifest ?? await this.prepare(request.expected);
    return this.coordinator.retire(request, async () => { this.authorizeCalls += 1; return authorize(); }, frozen);
  }
  getOperation(operationId) { return this.coordinator.getOperation(operationId); }
  recover(operationId) { this.recoverCalls += 1; return this.coordinator.recover(operationId); }
  getRecord(operationId) { return this.coordinator.getRecord(operationId); }
  async seed(sessionIds = ids) {
    for (const sessionId of sessionIds) if (!this.domain.table('sessions').get(sessionId)) await this.createLifecycle(sessionId);
  }
  resourceOwner(kind) { return this.options.resourceOwner?.(kind, this.descriptor.participants) ?? this.descriptor.participants[0].id; }
  requireDataRoutes(expected, { create = false } = {}) {
    assert(this.lifecycleGuards, 'Fixture lifecycle routes are disabled');
    if (create) {
      this.lifecycleGuards.assertCanCreate(expected);
      assert(!this.scopes.has(expected), 'fixture identity has an exclusive maintenance scope');
    } else {
      this.lifecycleGuards.assertCanUse(expected);
      assert(!this.scopes.has(expected.sessionId), 'fixture identity has an exclusive maintenance scope');
    }
  }
  createLifecycle(sessionId) {
    return this.serial(async () => {
      this.requireDataRoutes(sessionId, { create: true });
      const capabilities = await this.capabilities();
      const lifecycle = { storeId: capabilities.storeId, sessionId, lifecycleId: randomUUID() };
      const protectedLifecycle = bin.lifecycleKeySchema.parse({ storeId: capabilities.storeId,
        sessionId: `${sessionId}-independent-fork`, lifecycleId: randomUUID() });
      await this.domain.table('protected').put(protectedLifecycle.lifecycleId, protectedLifecycle);
      const resources = [];
      const add = async (name, kind, disposition, payload, references = [], sharedResourceId = null) => {
        const resourceId = `${lifecycle.lifecycleId}:${name}`;
        const retention = disposition === 'retain-shared' ? { reason: 'shared-reference', retainedBy: [protectedLifecycle] }
          : disposition === 'retain-coordination' ? { reason: 'coordination-identity', retainedBy: [] } : null;
        resources.push(bin.retirementResourceSchema.parse({ ownerId: this.resourceOwner(kind), resourceId, revision: '1', kind, disposition, retention }));
        await this.domain.table('resources').put(resourceId, recordSchema.parse({ schemaVersion: 1, resourceId, kind, revision: '1',
          lifecycleId: disposition === 'retain-shared' ? null : lifecycle.lifecycleId, payload, references, sharedResourceId }));
        return resourceId;
      };
      await add('generation-v3', 'transcript', 'erase', `fixture history v3 for ${sessionId}`);
      await add('generation-v4', 'transcript', 'erase', `fixture history v4 for ${sessionId}`);
      for (const kind of ['workspace', 'index', 'cache', 'spill']) await add(kind, kind, 'erase', `fixture-owned ${kind} for ${sessionId}`);
      const shared = await add('shared-attachment', 'attachment', 'retain-shared', 'shared fixture attachment', [lifecycle.lifecycleId, protectedLifecycle.lifecycleId]);
      await add('attachment-reference', 'attachment', 'release-reference', null, [], shared);
      await add('coordination', 'coordination', 'retain-coordination', null);
      const manifest = bin.retirementManifestSchema.parse({ schemaVersion: 1, lifecycle, capabilities, resources });
      await this.domain.table('sessions').put(sessionId, sessionSchema.parse({ schemaVersion: 1, lifecycle, status: 'live', manifest }));
      return clone(lifecycle);
    });
  }
  async resourceSnapshot(expected) {
    const session = this.domain.table('sessions').get(expected.sessionId);
    const manifest = session && bin.lifecycleEqual(session.lifecycle, expected) ? session.manifest
      : this.rawOwnerStore.operations().find(record => bin.lifecycleEqual(record.state.request.expected, expected))?.state.manifest;
    assert(manifest, 'exact lifecycle resource manifest required');
    return bin.retirementManifestSchema.parse(manifest).resources.map(resource => ({ resource: clone(resource), record: this.domain.table('resources').get(resource.resourceId) ?? null })).map(clone);
  }
  async appendFixtureResource(expected, text) {
    this.requireDataRoutes(expected);
    return this.serial(async () => { this.requireDataRoutes(expected); await this.appendOwned(expected, text); });
  }
  async appendOwned(expected, text) {
    const session = this.domain.table('sessions').get(expected.sessionId);
    assert(session && session.status === 'live' && bin.lifecycleEqual(session.lifecycle, expected), 'exact lifecycle required');
    const manifest = bin.retirementManifestSchema.parse(session.manifest);
    const resource = this.domain.table('resources').get(manifest.resources[0].resourceId);
    assert(resource, 'retired transcript cannot be resurrected');
    const revision = `${Number(resource.revision) + 1}`;
    await this.domain.table('resources').put(resource.resourceId, recordSchema.parse({ ...resource, payload: resource.payload + text, revision }));
    manifest.resources[0].revision = revision;
    await this.domain.table('sessions').put(expected.sessionId, sessionSchema.parse({ ...session, manifest }));
  }
  startUse(expected, kind, gate, { admittedDrain = false, text = '' } = {}) {
    this.requireDataRoutes(expected);
    const participantId = this.resourceOwner(kind);
    const guards = this.participantGuards.get(participantId);
    assert(guards, 'Fixture participant routes are disabled');
    guards.assertCanUse(expected);
    const task = (async () => {
      await gate.pause();
      if (admittedDrain) await this.appendOwned(expected, text);
      else {
        assert(this.lifecycleGuards && this.participantGuards.get(participantId), 'Fixture retained reference was disabled');
        this.lifecycleGuards.assertCanUse(expected);
        this.participantGuards.get(participantId).assertCanUse(expected);
      }
      return clone(expected);
    })();
    const use = { participantId, task };
    this.activeUses.add(use);
    void task.then(() => this.activeUses.delete(use), () => this.activeUses.delete(use));
    return task;
  }
  retainedReference(expected, kind = 'cache') {
    this.requireDataRoutes(expected);
    const lifecycleGuards = this.lifecycleGuards;
    const participantId = this.resourceOwner(kind);
    const participantGuards = this.participantGuards.get(participantId);
    assert(participantGuards, 'Fixture participant routes are disabled');
    return { write: async text => {
      lifecycleGuards.assertCanUse(expected);
      participantGuards.assertCanUse(expected);
      assert(this.lifecycleGuards === lifecycleGuards && this.participantGuards.get(participantId) === participantGuards, 'Fixture retained reference was disabled');
      return this.appendFixtureResource(expected, text);
    } };
  }
  async drain(participantId = null) {
    for (;;) {
      const active = [...this.activeUses].filter(use => participantId === null || use.participantId === participantId);
      if (!active.length) return;
      await Promise.allSettled(active.map(use => use.task));
    }
  }
  async bind(kind, identity, guards) {
    if (kind === 'lifecycle') this.lifecycleGuards = guards;
    else this.participantGuards.set(identity, guards);
    this.events.push({ name: `bind:${kind}`, participantId: identity });
    await this.options.bindGates?.[identity ?? 'lifecycle']?.pause();
    return async () => {
      this.events.push({ name: `unbind:${kind}`, participantId: identity });
      await this.options.disposeGates?.[identity ?? 'lifecycle']?.pause();
      if (kind === 'lifecycle' && this.lifecycleGuards === guards) this.lifecycleGuards = null;
      else if (kind === 'participant' && this.participantGuards.get(identity) === guards) this.participantGuards.delete(identity);
    };
  }
  makeLifecyclePort() {
    return { inspect: async sessionId => {
      const session = this.domain.table('sessions').get(sessionId);
      return !session || session.status === 'retired' ? null : clone(session.lifecycle);
    }, bindGuards: guards => this.bind('lifecycle', null, guards), acquire: async (expected, maintenance) => {
      assert(this.lifecycleGuards, 'Fixture lifecycle routes are disabled');
      assert(!this.scopes.has(expected.sessionId), 'fixture lifecycle scope already held');
      const session = this.domain.table('sessions').get(expected.sessionId);
      if (maintenance) {
        assert(bin.lifecycleEqual(maintenance.state.request.expected, expected), 'maintenance request must match its frozen lifecycle');
        assert(session && bin.lifecycleEqual(session.lifecycle, expected), 'exact owned lifecycle or tombstone required for maintenance');
      }
      this.scopes.add(expected.sessionId);
      this.events.push({ name: 'scope-acquired', lifecycle: clone(expected), maintenance: maintenance?.state.phase ?? null });
      let released = false;
      return { lifecycle: clone(expected), current: async () => {
        const current = this.domain.table('sessions').get(expected.sessionId);
        return !current || current.status === 'retired' ? null : clone(current.lifecycle);
      }, activity: async () => clone(this.options.activity ?? []), quiesce: async request => {
        this.events.push({ name: 'lifecycle-quiesce', operationId: request.operationId });
        await this.options.lifecycleQuiesceGate?.pause();
        if (this.options.lifecycleQuiescePending) return false;
        await this.drain();
        return true;
      }, finalize: async request => {
        this.events.push({ name: 'lifecycle-finalize', operationId: request.operationId });
        await this.options.lifecycleFinalizeGate?.pause();
        if (this.options.lifecycleFinalizePending) return false;
        const current = this.domain.table('sessions').get(expected.sessionId);
        assert(current && bin.lifecycleEqual(current.lifecycle, expected), 'owner cannot finalize a replacement');
        await this.domain.table('sessions').put(expected.sessionId, sessionSchema.parse({ ...current, status: 'retired' }));
        return true;
      }, release: async () => {
        if (released) return;
        released = true;
        this.scopes.delete(expected.sessionId);
        this.events.push({ name: 'scope-released', lifecycle: clone(expected) });
      } };
    } };
  }
  makeParticipant(identityInput) {
    const identity = Object.freeze(clone(identityInput));
    const barrier = async (stage, request) => {
      assert(this.participantGuards.has(identity.id), 'Fixture participant routes are disabled');
      const record = this.rawOwnerStore.operation(request.operationId);
      assert(record && !['rejected', 'conflict'].includes(record.state.phase), 'durable admission must precede participant effects');
      this.events.push({ name: `participant-${stage}`, participantId: identity.id, operationId: request.operationId, phase: record.state.phase });
      await this.options.participantGates?.[`${identity.id}:${stage}`]?.pause();
      if (this.options.participantPending === `${identity.id}:${stage}`) return false;
      if (stage === 'quiesce') await this.drain(identity.id);
      if (stage === 'converge') {
        for (const resource of record.state.manifest.resources.filter(item => item.ownerId === identity.id)) {
          const stored = this.domain.table('resources').get(resource.resourceId);
          if (['erase', 'release-reference'].includes(resource.disposition)) assert.equal(stored, undefined);
          else {
            assert(stored, 'retained resource must still exist at convergence');
            if (resource.disposition === 'retain-shared') {
              assert(!stored.references.includes(request.expected.lifecycleId));
              assert.deepEqual([...stored.references].sort(), resource.retention.retainedBy.map(key => key.lifecycleId).sort());
            }
          }
        }
      }
      return true;
    };
    return { identity, bindGuards: guards => this.bind('participant', identity.id, guards), manifest: async expected => {
      const session = this.domain.table('sessions').get(expected.sessionId);
      assert(session && bin.lifecycleEqual(session.lifecycle, expected), 'fixture participant inventory requires exact lifecycle');
      return bin.retirementManifestSchema.parse(session.manifest).resources.filter(resource => resource.ownerId === identity.id).map(clone);
    }, fence: request => barrier('fence', request), quiesce: request => barrier('quiesce', request), applyResource: async (request, resource) => {
      assert(resource.ownerId === identity.id, 'fixture participant cannot claim another owner');
      const record = this.rawOwnerStore.operation(request.operationId);
      assert(record && record.lifecycleQuiesced && record.participants.every(part => part.fenced && part.quiesced), 'all quiescence acknowledgements must precede erasure');
      this.events.push({ name: 'apply-resource', participantId: identity.id, operationId: request.operationId, resourceId: resource.resourceId });
      if (this.options.failResource === resource.kind || this.options.failResource === resource.resourceId) return { ownerId: identity.id, resourceId: resource.resourceId, status: 'failed', reason: 'fixture-injected-resource-failure' };
      await this.applyResource(request.expected, resource);
      const status = resource.disposition === 'erase' ? 'erased' : resource.disposition === 'release-reference' ? 'reference-released' : 'retained';
      return { ownerId: identity.id, resourceId: resource.resourceId, status, reason: status === 'retained' ? resource.retention.reason : null };
    }, converge: request => barrier('converge', request) };
  }
  async applyResource(expected, resource) {
    const table = this.domain.table('resources');
    const record = table.get(resource.resourceId);
    if (resource.disposition === 'erase' || resource.disposition === 'release-reference') {
      if (record === undefined) return; // Idempotent only inside the frozen owner operation.
      assert.equal(record.lifecycleId, expected.lifecycleId);
      assert.equal(record.revision, resource.revision);
      if (resource.disposition === 'release-reference') {
        const shared = table.get(record.sharedResourceId);
        assert(shared, 'known shared object must exist');
        await table.put(shared.resourceId, recordSchema.parse({ ...shared, references: shared.references.filter(item => item !== expected.lifecycleId) }));
      }
      await table.delete(resource.resourceId);
    } else {
      assert(record, 'retained resource must remain present');
      if (resource.disposition === 'retain-shared') {
        const retainedIds = resource.retention.retainedBy.map(key => {
          const protectedLifecycle = this.domain.table('protected').get(key.lifecycleId);
          assert(protectedLifecycle && bin.lifecycleEqual(protectedLifecycle, key), 'retention needs a durable independent lifecycle');
          assert(!bin.lifecycleEqual(key, expected), 'the target cannot witness its own shared retention');
          return key.lifecycleId;
        });
        assert(record.references.filter(item => item !== expected.lifecycleId).every(item => retainedIds.includes(item)));
        assert(retainedIds.every(item => record.references.includes(item)));
      } else { assert.equal(record.kind, 'coordination'); assert.deepEqual(resource.retention.retainedBy, []); }
    }
    this.effectCalls += 1;
  }
  async checkpoint(name, context) {
    const snapshot = clone(context);
    this.checkpoints.push({ name, value: snapshot });
    if (this.options.slowGate?.checkpoint === name) await this.options.slowGate.gate.pause();
    await this.options.onCheckpoint?.(name, clone(snapshot), this);
  }
  serial(work) {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  close() {
    return this.closing ??= (async () => { await this.tail;
      await cleanupAll([() => this.coordinator.close(), () => this.journalDomain.close(), () => this.domain.close()], 'Fixture owner teardown failed'); })();
  }
}

/** Bin, purge, fixture data and production owner journal share one lease. */
export async function openRetirementFixture(root, options = {}) {
  const fixture = await openFixture(root, { seed: options.seed ?? false, plugin: false });
  let release, binDomain, purgeDomain, owner, module, off, backendCleanup;
  try {
    release = await bin.acquireBinLease(join(root, 'coordination'));
    backendCleanup = await options.beforeDomains?.(fixture);
    binDomain = await fixture.ctx.storageDomain.open(options.nativeArchive ? bin.archiveDomainSpec : bin.binDomainSpec);
    purgeDomain = await fixture.ctx.storageDomain.open(bin.retirementDomainSpec);
    owner = await ReferenceRetirementOwner.open(fixture.ctx, root, options.ownerOptions);
    if (options.seed) await owner.seed(options.sessionIds ?? ids);
    const store = options.nativeArchive ? new bin.DomainArchiveStore(binDomain) : new bin.DomainBinStore(binDomain);
    const retirementStore = new bin.DomainRetirementStore(purgeDomain);
    const native = new bin.DshBinPort(fixture.ctx);
    const exposedOwner = options.ownerEnabled === false ? undefined : options.ownerWrapper ? options.ownerWrapper(owner) : owner;
    const Module = options.nativeArchive ? bin.ArchiveModule : bin.SessionBinModule;
    module = new Module(options.storeWrapper?.(store) ?? store, options.nativeWrapper?.(native) ?? native,
      { ...options.moduleOptions, retirement: { owner: exposedOwner, store: options.purgeStoreWrapper?.(retirementStore) ?? retirementStore,
        verifiedNativeArchive: options.verifiedNativeArchive ?? (options.nativeArchive && !options.legacyQualificationOnly
          ? options.verified ?? (caps => caps.providerId === 'fixture-domain-v1' && caps.hostVersion === 'test-fixture-v1') : undefined),
        verified: options.verified ?? (caps => caps.providerId === 'fixture-domain-v1' && caps.hostVersion === 'test-fixture-v1') } });
    off = fixture.ctx.root.on('domain/changed', change => {
      if (change.domain === 'workspace' && change.table === '' && change.operation === 'put') void module.observeArchives(change.value.archivedSessionIds).catch(() => {});
    });
    await options.beforeReconcile?.({ fixture, module, owner, store, retirementStore });
    if (!options.skipReconcile) await module.reconcile();
    let closing;
    const close = () => closing ??= (async () => {
      const errors = [];
      try { await module.close(); } catch (error) { errors.push(error); }
      off?.();
      try { await cleanupAll([() => owner.close(), () => purgeDomain.close(), () => binDomain.close(), () => backendCleanup?.()], 'Fixture domain teardown failed'); } catch (error) { errors.push(error); }
      try { await release(); } catch (error) { errors.push(error); }
      try { await fixture.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Retirement fixture teardown failed');
    })();
    return { ...fixture, module, owner, store, retirementStore, close };
  } catch (error) {
    off?.();
    try { await cleanupAll([() => module?.close(), () => owner?.close(), () => purgeDomain?.close(),
      () => binDomain?.close(), () => backendCleanup?.(), () => release?.(), () => fixture.close()], 'Fixture initialization cleanup failed'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Retirement fixture initialization failed'); }
    throw error;
  }
}
