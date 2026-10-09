import { openFixture } from './fixture.mjs';
import { crashAt } from './platform-fixture.mjs';

const [root, checkpoint] = process.argv.slice(2);
const fixture = await openFixture(root, { legacy: false });
const operationId = `archive-crash-${checkpoint}`;
const plan = await fixture.bin.prepare({ action: 'unarchive', sessionId: 'quiet', operationId });
process.send?.({ plan });
fixture.ctx.on('domain/changed', change => {
  const nativeChanged = change.domain === 'workspace' && change.table === '' && change.operation === 'put'
    && !change.value.archivedSessionIds.includes('quiet');
  const journal = change.domain === 'session_archive' && change.table === 'operations' && change.operation === 'put'
    && change.value.plan.operationId === operationId;
  const entryChanged = change.domain === 'session_archive' && change.table === 'entries'
    && change.key === 'quiet' && change.operation === 'deleted';
  if ((checkpoint === 'native' && nativeChanged)
    || (['intent', 'applied', 'done'].includes(checkpoint) && journal && change.value.phase === checkpoint)
    || (checkpoint === 'entry' && entryChanged)) crashAt(root, checkpoint);
});
const result = await fixture.bin.execute(plan);
await fixture.close();
throw new Error(`Archive crash checkpoint did not fire: ${JSON.stringify(result)}`);
