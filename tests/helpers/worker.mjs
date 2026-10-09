import { openFixture } from './fixture.mjs';
import { acquireBinLease } from '../../dist/index.js';
import { join } from 'node:path';
import { crashAt } from './platform-fixture.mjs';

const [mode, root, action, checkpoint] = process.argv.slice(2);
if (mode === 'lease') {
  const release = await acquireBinLease(join(root, 'coordination'));
  process.send?.({ ready: true });
  process.on('message', async message => {
    if (message === 'release') { await release(); process.exit(0); }
  });
} else if (mode === 'crash') {
  const fixture = await openFixture(root);
  const operationId = `crash-${action}-${checkpoint}`;
  const plan = await fixture.bin.prepare({ action, sessionId: 'quiet', operationId });
  process.send?.({ plan });
  fixture.ctx.on('domain/changed', change => {
    const nativeChanged = change.domain === 'workspace' && change.table === ''
      && change.operation === 'put'
      && change.value.archivedSessionIds.includes('quiet') === (action === 'bin');
    const journal = change.domain === 'session_bin' && change.table === 'operations'
      && change.operation === 'put' && change.value.plan.operationId === operationId;
    const entryChanged = change.domain === 'session_bin' && change.table === 'entries'
      && change.key === 'quiet' && (action === 'bin' ? change.operation === 'put' : change.operation === 'deleted');
    if ((checkpoint === 'native' && nativeChanged)
      || (['intent', 'applied', 'done'].includes(checkpoint) && journal && change.value.phase === checkpoint)
      || (checkpoint === 'entry' && entryChanged)) {
      crashAt(root, checkpoint);
    }
  });
  const result = await fixture.bin.execute(plan);
  await fixture.close();
  throw new Error(`Crash checkpoint did not fire: ${JSON.stringify(result)}`);
} else { throw new Error(`Unknown worker mode: ${mode}`); }
