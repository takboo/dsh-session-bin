import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHistoryTransition, assertFrozenTranscripts } from '../scripts/gui-preservation.mjs';
const original = { quiet: { eventState: 'shared-frozen', events: [{ type: 'session/title', seq: 4, time: 10, data: { title: 'fixture' } }] }, sibling: { eventState: 'shared-frozen', events: [] } };
function opened() {
  const logs = structuredClone(original);
  logs.quiet.events.push(
    { type: 'session/end-seed', seq: 5, time: 21, data: {} },
    { type: 'permission/preset', seq: 6, time: 22, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 7, time: 22, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 8, time: 22, data: { policy: 'ask' } },
  ); return logs;
}
const window = { sessionId: 'quiet', startedAt: 20, observedAt: 25 };
test('native history may finish initialization before the deletion baseline is frozen', () => {
  assert.equal(assertHistoryTransition(original, opened(), window).length, 4);
  assert.deepEqual(assertHistoryTransition(opened(), opened(), window), []);
});
test('a deletion attempt cannot append even the same legitimate initialization events', () => {
  assert.throws(() => assertFrozenTranscripts(original, opened()), /preserve/);
  assertFrozenTranscripts(opened(), opened());
});
test('native initialization never permits changed seed bytes, sibling writes or arbitrary extra events', () => {
  const changed = opened(); changed.quiet.events[0].data.title = 'changed';
  assert.throws(() => assertHistoryTransition(original, changed, window));
  const sibling = opened(); sibling.sibling.events.push({ type: 'permission/preset', data: { preset: 'workspace-write' } });
  assert.throws(() => assertHistoryTransition(original, sibling, window));
  const extra = opened(); extra.quiet.events.push({ type: 'turn/start', seq: 9, time: 23, data: { turn: 2 } });
  assert.throws(() => assertHistoryTransition(original, extra, window));
});
test('initialization events must occur inside the explicit native-history window with exact sequence and payload', () => {
  const late = opened(); late.quiet.events[2].time = 26;
  assert.throws(() => assertHistoryTransition(original, late, window));
  const old = opened(); old.quiet.events[1].time = 19;
  assert.throws(() => assertHistoryTransition(original, old, window));
  const malformed = opened(); malformed.quiet.events[3].seq = 9;
  assert.throws(() => assertHistoryTransition(original, malformed, window));
  const policy = opened(); policy.quiet.events[4].data.policy = 'auto';
  assert.throws(() => assertHistoryTransition(original, policy, window));
});
test('physical snapshots retain identities and seed bytes; refused deletion permits no append or replacement', async () => {
  const { assertPhysicalTransition } = await import('../scripts/gui-preservation.mjs');
  const snapshot = bytes => ({ quiet: { directory: '/fixture/quiet', directoryIdentity: { inode: '1' }, coordination: { inode: '2' },
    files: [{ path: '/fixture/quiet/session.zstd', name: 'session.zstd', identity: { inode: '3' }, bytes }] } });
  const before = snapshot(Buffer.from('seed'));
  const after = snapshot(Buffer.from('seednative-init'));
  assertPhysicalTransition(before, after, { sessionId: 'quiet', appended: 4 });
  assert.throws(() => assertPhysicalTransition(before, after));
  assert.throws(() => assertPhysicalTransition(before, snapshot(Buffer.from('oopsnative-init')), { sessionId: 'quiet', appended: 4 }));
  const replaced = snapshot(Buffer.from('seed')); replaced.quiet.files[0].identity.inode = '4';
  assert.throws(() => assertPhysicalTransition(before, replaced));
});
test('the live-host snapshot reader uses public read access and does not acquire writer ownership', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
  const Jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');
  const { createScratch } = await import('./helpers/fixture.mjs');
  const { openTranscriptReader } = await import('../scripts/verify-gui.mjs');
  const { join } = await import('node:path');
  const root = await createScratch('gui-read-only-snapshot-');
  const paths = { sessions: join(root, 'logs') };
  const ctx = new Context(); let writer; let reader;
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(Jsonl, { root: paths.sessions, compression: 'zstd' });
    const session = ctx.sessions.prepare(SessionId('quiet'), { meta: { cwd: root, createdAt: 1 } });
    writer = await ctx.sessionPersistence.create(session.header);
    await writer.append([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]); await writer.flush();
    reader = await openTranscriptReader(paths);
    const handle = await reader.ctx.sessionPersistence.open(SessionId('quiet'), 'read');
    try { assert.equal((await handle.read()).events.length, 1); } finally { await handle.close(); }
    assert.equal(reader.ctx.get('workspaceRegistry', false), undefined);
    assert.equal(reader.ctx.get('storageDomain', false), undefined);
    await reader.close(); reader = undefined;
    await writer.append([{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }]);
    await writer.flush(); assert.equal((await writer.read()).events.length, 2);
  } finally { await reader?.close(); await writer?.close(); await ctx.fiber.dispose(); }
});
