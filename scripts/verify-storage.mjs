#!/usr/bin/env node
/**
 * Focused DSH 0.2.0-rc.2 storage/workspace compatibility probe.
 * Run from the repository with: node scripts/verify-storage.mjs
 *
 * Uses public npm exports only. Session metadata is a deliberately minimal,
 * file-backed sessionPersistence.list provider, seeded with headers validated by
 * the real SessionStore. It has no transcript, SessionHandle, writer lease, or
 * Agent lifecycle. Activity fixtures are event providers on Cordis's real
 * waterfall; they do not start production turns, jobs, subagents, or schedules.
 * All native mutations run through WorkspaceRegistry without method patches.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { SessionStore } from '@deepseek-ai/dsh-session';
import {
  WorkspaceRegistry,
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace';
import { z } from 'zod';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedVersion = '0.2.0-rc.2';
const require = createRequire(import.meta.url);
const expectedPackages = {
  '@deepseek-ai/cordis': '4.0.4',
  '@deepseek-ai/dsh-storage': expectedVersion,
  '@deepseek-ai/dsh-storage-json': expectedVersion,
  '@deepseek-ai/dsh-storage-domain': expectedVersion,
  '@deepseek-ai/dsh-session': expectedVersion,
  '@deepseek-ai/dsh-workspace': expectedVersion,
  zod: '4.4.3',
};

const binRecordSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  workspaceIdAtBin: z.string().min(1).nullable(),
  binnedAt: z.iso.datetime(),
  wasArchived: z.boolean(),
  wasPinned: z.boolean(),
  operationId: z.string().min(1),
  phase: z.enum(['pending', 'committed', 'restoring']),
  revision: z.number().int().nonnegative(),
}).strict();
const binSpec = storageDomain.defineDomain({
  name: 'session_bin_compatibility',
  version: 1,
  layout: 'single',
  tables: { entries: storageDomain.domainTable(binRecordSchema) },
});
const schemaProbeSpec = storageDomain.defineDomain({
  ...binSpec,
  name: 'session_bin_schema_probe',
});
const activityKinds = ['turn', 'subagent', 'job', 'schedule'];
const ids = {
  quiet: 'compat-quiet',
  sibling: 'compat-sibling',
  nativeOnly: 'compat-native-only',
  active: 'compat-active',
  ungrouped: 'compat-ungrouped',
  live: 'compat-live',
  missing: 'compat-definitely-missing',
};

const report = {
  targetVersion: expectedVersion,
  nodeVersion: process.version,
  fixture: {
    storage: 'official storage-json, single layout, through storageDomain',
    sessions: 'real SessionStore headers; minimal file-backed sessionPersistence.list provider',
    activity: 'four fixture listeners on the actual Cordis workspace/session-activity waterfall',
    mutations: 'official WorkspaceRegistry and Workspace entity methods',
  },
  outcomes: [],
  limitations: [
    'No JSONL transcript, SessionHandle ownership/lease, Agent activation, model-step gate, or live worker integration is verified.',
    'Concurrency is within one domain in one process; storage-json has no cross-process write lock.',
    'Bin metadata and native archive state are separate durable writes; this probe does not establish a crash-safe transaction or recovery protocol.',
    'Close/reopen checks acknowledged file persistence, not power-loss or fault-injection durability.',
    'Unarchive success alone does not establish the existence of a restorable transcript.',
    'No account/credential service is mounted; accounting checks concern native Workspace session membership and order.',
    'No permanent session deletion capability is tested or provided.',
  ],
};
let scratch;
let fixture;

function outcome(name, detail, observed = {}) {
  report.outcomes.push({ name, status: 'passed', detail, ...observed });
  console.log(`PASS ${name}: ${detail}`);
}

function record(sessionId, workspaceIdAtBin, overrides = {}) {
  return binRecordSchema.parse({
    schemaVersion: 1,
    sessionId,
    workspaceIdAtBin,
    binnedAt: new Date().toISOString(),
    wasArchived: false,
    wasPinned: false,
    operationId: `operation-${sessionId}`,
    phase: 'pending',
    revision: 0,
    ...overrides,
  });
}

function accounting(registry) {
  return registry.list().map(workspace => ({
    id: workspace.id,
    path: workspace.path,
    sessionIds: [...workspace.sessionIds],
  }));
}

async function verifyPackages() {
  report.packages = {};
  for (const [name, expected] of Object.entries(expectedPackages)) {
    const manifestPath = await realpath(require.resolve(`${name}/package.json`));
    assert(!manifestPath.includes(`${sep}.local${sep}dsh-runtime${sep}`),
      `${name} must resolve from installed npm dependencies, not the extracted snapshot`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.version, expected, `${name} must be pinned to ${expected}`);
    report.packages[name] = manifest.version;
  }
  outcome('exact-public-packages', 'public npm exports resolve at the requested exact versions');
}

async function openFixture(paths, seed = false) {
  const ctx = new Context();
  const domains = new Set();
  const fibers = [];
  const state = {
    activity: new Map(),
    activityCalls: [],
    stopCalls: [],
    changes: [],
    persistenceListCalls: 0,
  };
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  };
  const close = async () => {
    const errors = [];
    // Close domains before unloading their backend; do not depend on the root
    // fiber's parallel disposal ordering for file durability.
    for (const domain of domains) {
      try { await domain.close(); } catch (error) { errors.push(error); }
    }
    const facility = ctx.get('storageDomain');
    if (facility) {
      try { await facility.closeAll(); } catch (error) { errors.push(error); }
    }
    for (const fiber of [...fibers].reverse()) {
      try { await fiber.dispose(); } catch (error) { errors.push(error); }
    }
    try { await ctx.fiber.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed');
  };
  try {
    await mount(Storage);
    await mount(storageJson, { root: paths.storage });
    await mount(storageDomain, { backend: 'json' });
    await mount(SessionStore);
    if (seed) {
      const descriptors = [
        [ids.quiet, paths.original, 3000],
        [ids.sibling, paths.original, 2000],
        [ids.active, paths.original, 1000],
        [ids.nativeOnly, paths.other, 4000],
        [ids.ungrouped, undefined, 5000],
      ];
      const headers = descriptors.map(([id, cwd, createdAt]) =>
        ctx.sessions.prepare(id, { meta: { ...(cwd ? { cwd } : {}), createdAt } }).header);
      await writeFile(paths.headers, `${JSON.stringify(headers, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    await mount({
      name: 'compatibility-session-metadata',
      apply(metadataCtx) {
        metadataCtx.provide('sessionPersistence', {
          async list() {
            state.persistenceListCalls += 1;
            const headers = JSON.parse(await readFile(paths.headers, 'utf8'));
            return headers.map(header => ({ header }));
          },
        });
      },
    });
    for (const kind of activityKinds) {
      ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        state.activityCalls.push({ sessionId, kind });
        const rest = await next();
        if (!state.activity.get(sessionId)?.has(kind)) return rest;
        const own = kind === 'turn' ? { kind } : { kind, items: [{ id: `fixture-${kind}` }] };
        return [own, ...rest];
      });
    }
    ctx.on('workspace/session-stop', ({ sessionId }) => state.stopCalls.push(sessionId));
    ctx.on('domain/changed', change => state.changes.push(structuredClone(change)));
    await mount(WorkspaceRegistry);
    assert(ctx.get('workspaceRegistry'), 'WorkspaceRegistry must activate');
    assert(ctx.get('storageDomain'), 'storageDomain must activate');
    return {
      ctx, state, close,
      registry: ctx.workspaceRegistry,
      async openDomain(spec) {
        const domain = await ctx.storageDomain.open(spec);
        domains.add(domain);
        return domain;
      },
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture startup and cleanup failed');
    }
    throw error;
  }
}

async function checkSchema(fixture, seedRecord) {
  assert.throws(() => storageDomain.defineDomain({ ...binSpec, version: -1 }),
    /non-negative integer/);
  const probe = await fixture.openDomain(schemaProbeSpec);
  const invalid = { ...seedRecord, schemaVersion: 0 };
  let writeRejected = false;
  try {
    // Deliberately bypass caller-side parsing to observe the native contract.
    await probe.table('entries').put('invalid', invalid);
  } catch (error) {
    assert.equal(error.code, 'invalid-record', 'unexpected schema write failure');
    writeRejected = true;
  }
  await probe.close();
  if (!writeRejected) {
    await assert.rejects(fixture.ctx.storageDomain.open(schemaProbeSpec), error => {
      assert(error instanceof storageDomain.DomainError);
      assert.equal(error.code, 'invalid-record');
      assert.deepEqual(error.detail, { table: 'entries', key: 'invalid' });
      return true;
    });
    report.limitations.push('Observed: native table.put accepted a schema-invalid value; validation rejected it only when reopening. Bin callers must validate writes themselves.');
    outcome('schema-validation', 'invalid declaration rejected; raw invalid put admitted, then reopen rejected with invalid-record',
      { writeRejected: false, reopenRejected: true });
  } else {
    const reopened = await fixture.openDomain(schemaProbeSpec);
    assert.equal(reopened.table('entries').size, 0);
    await reopened.close();
    outcome('schema-validation', 'invalid declaration and raw invalid put rejected',
      { writeRejected: true });
  }
}

async function verify() {
  await verifyPackages();
  const scratchParent = join(workspaceRoot, '.local', 'compatibility');
  await mkdir(scratchParent, { recursive: true, mode: 0o700 });
  scratch = await mkdtemp(join(scratchParent, 'storage-'));
  const canonicalRoot = await realpath(workspaceRoot);
  const scratchRelative = relative(canonicalRoot, await realpath(scratch));
  assert(scratchRelative && scratchRelative !== '..' && !scratchRelative.startsWith(`..${sep}`),
    'scratch must stay inside this workspace');
  process.env.DSH_HOME = join(scratch, 'dsh-home');
  const paths = {
    storage: join(scratch, 'storage'),
    headers: join(scratch, 'session-headers.json'),
    original: join(scratch, 'original-workspace'),
    other: join(scratch, 'other-workspace'),
  };
  await Promise.all([process.env.DSH_HOME, paths.original, paths.other].map(path =>
    mkdir(path, { recursive: true, mode: 0o700 })));
  report.scratchDirectory = scratch;
  report.dshHome = process.env.DSH_HOME;
  console.log(`Scratch data retained at ${scratch}`);
  console.log(`Session fixture: ${report.fixture.sessions}`);

  fixture = await openFixture(paths, true);
  let { registry, state } = fixture;
  const original = await registry.resolveByPath(paths.original);
  const other = await registry.resolveByPath(paths.other);
  assert(original && other, 'native header bootstrap must register both workspaces');
  assert.deepEqual(original.sessionIds, [ids.quiet, ids.sibling, ids.active]);
  assert.deepEqual(other.sessionIds, [ids.nativeOnly]);
  const originalAccounting = accounting(registry);
  const originalWorkspaceId = original.id;
  await assert.rejects(other.attachSession(ids.quiet), /cwd|directory|workspace/);
  assert.deepEqual(accounting(registry), originalAccounting);
  assert.equal(registry.list().flatMap(workspace => workspace.sessionIds)
    .filter(id => id === ids.quiet).length, 1);
  outcome('workspace-accounting', 'header bootstrap preserves order and rejects attachment to a foreign workspace');

  const bin = await fixture.openDomain(binSpec);
  let entries = bin.table('entries');
  await registry.archiveSession(ids.nativeOnly);
  assert.equal(entries.get(ids.nativeOnly), undefined);
  await registry.pinSession(ids.quiet);
  await registry.pinSession(ids.sibling);
  const quietRecord = record(ids.quiet, original.id, { wasPinned: true });
  await entries.put(ids.quiet, quietRecord);
  await registry.archiveSession(ids.quiet);
  await entries.update(ids.quiet, value => binRecordSchema.parse({ ...value, phase: 'committed' }));
  assert(registry.archivedSessionIds.includes(ids.quiet));
  assert.deepEqual(registry.pinnedSessionIds, [ids.sibling]);
  assert.deepEqual(accounting(registry), originalAccounting);
  await assert.rejects(registry.pinSession(ids.quiet), WorkspaceArchivedSessionPinError);
  outcome('quiet-archive', 'archive commits, clears only the target pin, and keeps its original workspace slot');

  const beforeRepeat = state.changes.length;
  const beforeActivity = state.activityCalls.length;
  state.activity.set(ids.quiet, new Set(activityKinds));
  await Promise.all([
    registry.archiveSession(ids.quiet),
    registry.archiveSession(ids.quiet, { stopActivity: true }),
  ]);
  assert.equal(state.changes.length, beforeRepeat);
  assert.equal(state.activityCalls.length, beforeActivity);
  assert.deepEqual(state.stopCalls, []);
  state.activity.delete(ids.quiet);
  outcome('archive-idempotence', 'already-archived requests produce no writes, activity checks, or stop requests',
    { caveat: 'Idempotent archive success does not prove inactivity; Bin admission must separately check already-archived sessions.' });

  await registry.pinSession(ids.active);
  for (const kinds of [...activityKinds.map(kind => [kind]), activityKinds]) {
    state.activity.set(ids.active, new Set(kinds));
    const before = {
      changes: state.changes.length,
      calls: state.activityCalls.length,
      archived: [...registry.archivedSessionIds],
      pinned: [...registry.pinnedSessionIds],
    };
    await assert.rejects(registry.archiveSession(ids.active), error => {
      assert(error instanceof WorkspaceActiveSessionError);
      assert.equal(error.sessionId, ids.active);
      assert.deepEqual(error.activity.map(item => item.kind), kinds);
      return true;
    });
    assert.deepEqual(state.activityCalls.slice(before.calls),
      activityKinds.map(kind => ({ sessionId: ids.active, kind })));
    assert.equal(state.changes.length, before.changes);
    assert.deepEqual(registry.archivedSessionIds, before.archived);
    assert.deepEqual(registry.pinnedSessionIds, before.pinned);
  }
  assert.deepEqual(state.stopCalls, []);
  state.activity.delete(ids.active);
  outcome('activity-refusal', 'turn, subagent, job, schedule, and combined reports refuse archive before any write or stop');

  const beforeMissing = state.changes.length;
  const callsBeforeMissing = state.activityCalls.length;
  await assert.rejects(registry.archiveSession(ids.missing), WorkspaceUnknownSessionError);
  await assert.rejects(registry.pinSession(ids.missing), WorkspaceUnknownSessionError);
  const listingsBeforeRestore = state.persistenceListCalls;
  await registry.unarchiveSession(ids.missing);
  assert.equal(state.persistenceListCalls, listingsBeforeRestore);
  assert.equal(state.changes.length, beforeMissing);
  assert.equal(state.activityCalls.length, callsBeforeMissing);
  outcome('missing-session', 'archive and pin reject a definite miss; unarchive resolves without an existence probe or write');

  // A real live SessionStore entry absent from the metadata provider is known.
  const live = fixture.ctx.sessions.create(ids.live, { meta: { cwd: paths.original } });
  assert.equal(live.id, ids.live);
  await registry.archiveSession(ids.live);
  await registry.unarchiveSession(ids.live);
  await registry.archiveSession(ids.ungrouped);
  await registry.unarchiveSession(ids.ungrouped);
  assert.deepEqual(accounting(registry), originalAccounting);
  outcome('archive-admission', 'native archive accepts live-only and persisted ungrouped sessions without changing workspace accounts');

  const updateCount = 32;
  const independentCount = 12;
  const changesBeforeConcurrent = state.changes.length;
  const writes = [
    ...Array.from({ length: updateCount }, () => entries.update(ids.quiet, value =>
      binRecordSchema.parse({ ...value, revision: value.revision + 1 }))),
    ...Array.from({ length: independentCount }, (_, index) => {
      const id = `compat-metadata-${index}`;
      return entries.put(id, record(id, null));
    }),
  ];
  // Observe every write even if one rejects, so cleanup cannot race siblings.
  const settled = await Promise.allSettled(writes);
  const failed = settled.filter(result => result.status === 'rejected');
  assert.equal(failed.length, 0, failed.map(result => String(result.reason)).join('\n'));
  assert.equal(entries.get(ids.quiet).revision, updateCount);
  assert.equal(entries.size, independentCount + 1);
  const concurrentEvents = state.changes.slice(changesBeforeConcurrent);
  assert.equal(concurrentEvents.length, updateCount + independentCount);
  assert.deepEqual(concurrentEvents.filter(change => change.key === ids.quiet)
    .map(change => change.value.revision), Array.from({ length: updateCount }, (_, index) => index + 1));
  const expectedRecords = Object.fromEntries(entries.entries());
  const medium = JSON.parse(await readFile(join(paths.storage, `${binSpec.name}.json`), 'utf8'));
  assert.deepEqual(medium.tables.entries, expectedRecords);
  outcome('concurrent-metadata', '32 same-record updates and 12 independent puts resolve durably with ordered change events');
  await checkSchema(fixture, quietRecord);

  const archivedBeforeClose = [...registry.archivedSessionIds];
  const pinnedBeforeClose = [...registry.pinnedSessionIds];
  await fixture.close();
  fixture = undefined;
  assert.throws(() => entries.get(ids.quiet), error => error.code === 'closed');
  fixture = await openFixture(paths);
  ({ registry, state } = fixture);
  const reopenedBin = await fixture.openDomain(binSpec);
  entries = reopenedBin.table('entries');
  assert.deepEqual(Object.fromEntries(entries.entries()), expectedRecords);
  assert.deepEqual(registry.archivedSessionIds, archivedBeforeClose);
  assert.deepEqual(registry.pinnedSessionIds, pinnedBeforeClose);
  assert.deepEqual(accounting(registry), originalAccounting);
  assert.equal(registry.get(originalWorkspaceId).sessionIds[0], ids.quiet);
  outcome('close-reopen', 'Bin records, revisions, native archive/pin sets, workspace identity, and session order survive a fresh Context');

  await entries.update(ids.quiet, value => binRecordSchema.parse({ ...value, phase: 'restoring' }));
  await registry.unarchiveSession(ids.quiet);
  assert.equal(await entries.delete(ids.quiet), true);
  assert(!registry.archivedSessionIds.includes(ids.quiet));
  assert(registry.archivedSessionIds.includes(ids.nativeOnly));
  assert(!registry.pinnedSessionIds.includes(ids.quiet));
  assert(registry.pinnedSessionIds.includes(ids.sibling));
  assert.deepEqual(accounting(registry), originalAccounting);
  const changesBeforeRestoreRepeat = state.changes.length;
  await registry.unarchiveSession(ids.quiet);
  assert.equal(await entries.delete(ids.quiet), false);
  assert.equal(state.changes.length, changesBeforeRestoreRepeat);
  outcome('restore', 'unarchive restores original position, keeps native-only archives, and does not restore the cleared pin; repeat is a no-op');

  // A caller-owned record must remember independent native archive provenance.
  await entries.put(ids.nativeOnly, record(ids.nativeOnly, other.id, { wasArchived: true, phase: 'committed' }));
  const prior = entries.get(ids.nativeOnly);
  if (!prior.wasArchived) await registry.unarchiveSession(prior.sessionId);
  await entries.delete(prior.sessionId);
  assert(registry.archivedSessionIds.includes(ids.nativeOnly));
  assert.equal(entries.get(ids.nativeOnly), undefined);
  outcome('bin-ownership', 'an independently archived session is outside Bin without a record; restoring wasArchived metadata preserves its native archive');

  const finalRecords = Object.fromEntries(entries.entries());
  const finalArchived = [...registry.archivedSessionIds];
  const finalPinned = [...registry.pinnedSessionIds];
  await fixture.close();
  fixture = undefined;
  fixture = await openFixture(paths);
  const finalDomain = await fixture.openDomain(binSpec);
  assert.deepEqual(Object.fromEntries(finalDomain.table('entries').entries()), finalRecords);
  assert.deepEqual(fixture.registry.archivedSessionIds, finalArchived);
  assert.deepEqual(fixture.registry.pinnedSessionIds, finalPinned);
  assert.deepEqual(accounting(fixture.registry), originalAccounting);
  outcome('restore-reopen', 'restored Bin removal and native visibility/pin/accounting state survive another fresh Context');
  report.conclusion = 'Reversible archive-backed Bin metadata is feasible with caller-side schema validation and reconciliation between separate durable writes.';
}

try {
  await verify();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  if (fixture) {
    try { await fixture.close(); } catch (error) {
      report.status = 'failed';
      report.cleanupError = { name: error.name, message: error.message };
      console.error('Fixture cleanup failed:', error);
      process.exitCode = 1;
    }
  }
  if (scratch) {
    const reportPath = join(scratch, 'report.json');
    try {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(`JSON report: ${reportPath}`);
    } catch (error) {
      console.error('Could not write the JSON report:', error);
      process.exitCode = 1;
    }
  }
  for (const limitation of report.limitations) console.log(`LIMIT ${limitation}`);
  console.log(`Storage compatibility verification ${report.status ?? 'failed'}.`);
}
