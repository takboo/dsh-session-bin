import assert from 'node:assert/strict';

/** Only an explicit native history open may initialize these fixture settings.
 * The plugin deletion window itself remains completely immutable. */
export function assertHistoryTransition(before, after, { sessionId, startedAt, observedAt }) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert(before[sessionId], 'History must name an existing fixture');
  for (const id of Object.keys(before)) if (id !== sessionId) {
    assert.deepEqual(after[id], before[id], 'Native history must not modify an unopened sibling');
  }
  const { events: original, ...metadata } = before[sessionId];
  const { events: current, ...newMetadata } = after[sessionId];
  assert.deepEqual(newMetadata, metadata, 'Native history must preserve the original log metadata');
  assert.deepEqual(current.slice(0, original.length), original, 'Native history must preserve every seeded event');
  const added = current.slice(original.length);
  if (!added.length) return added;
  const expected = [
    ['session/end-seed', {}],
    ['permission/preset', { preset: 'workspace-write' }],
    ['sandbox/mode', { mode: 'workspace-write' }],
    ['approval/policy', { policy: 'ask' }],
  ];
  assert.equal(added.length, expected.length, 'Only the complete audited native initialization is expected');
  const seq = original.at(-1)?.seq ?? -1;
  for (const [index, event] of added.entries()) {
    assert.deepEqual([event.type, event.data, event.seq], [...expected[index], seq + index + 1]);
    assert(Number.isFinite(event.time) && event.time >= startedAt && event.time <= observedAt,
      'Native initialization must precede the plugin request and follow the explicit history open');
  }
  return added;
}

export function assertFrozenTranscripts(before, after) {
  assert.deepEqual(after, before, 'A plugin deletion attempt must preserve the captured public SDK transcripts');
}

export function assertPhysicalTransition(before, after, { sessionId, appended = 0 } = {}) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const id of Object.keys(before)) {
    const initial = before[id], current = after[id];
    assert.deepEqual([current.directory, current.directoryIdentity, current.coordination],
      [initial.directory, initial.directoryIdentity, initial.coordination], 'Session and coordination identities must remain stable');
    assert.deepEqual(current.files.map(f => [f.path, f.name, f.identity]), initial.files.map(f => [f.path, f.name, f.identity]),
      'Native history and refused deletion cannot remove, replace or publish artifacts');
    for (let index = 0; index < initial.files.length; index++) {
      const oldBytes = initial.files[index].bytes, newBytes = current.files[index].bytes;
      if (id === sessionId && appended > 0) {
        assert(newBytes.length >= oldBytes.length);
        assert.deepEqual(newBytes.subarray(0, oldBytes.length), oldBytes, 'Native history must retain the exact original compressed bytes');
      } else assert.deepEqual(newBytes, oldBytes, 'A plugin deletion attempt or unopened sibling must preserve every byte');
    }
  }
}
