import assert from 'node:assert/strict';
import { openNativeDeletionFixture } from './native-deletion-fixture.mjs';
import { crashAt } from './platform-fixture.mjs';

const [root, boundary, rawPlan, compression = 'none'] = process.argv.slice(2);
assert(root && boundary && rawPlan);
const plan = JSON.parse(rawPlan);
const fixture = await openNativeDeletionFixture(root, { compression, ownerOptions: {
  checkpoint(name) { if (name === boundary) crashAt(root, boundary); },
} });
if (process.platform === 'win32' && boundary === 'file-cleared') {
  const files = fixture.nativeOwner.files;
  const openFile = files.openFile.bind(files);
  files.openFile = async (path, access) => {
    const handle = await openFile(path, access);
    if (access === 'write') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        crashAt(root, 'file-cleared');
      };
    }
    return handle;
  };
}
fixture.ctx.on('domain/changed', change => {
  const operation = change.domain === 'session_bin_purge' && change.table === 'operations'
    && change.operation === 'put' && change.key === plan.operationId;
  const entry = change.domain === 'session_archive' && change.table === 'entries'
    && change.operation === 'deleted' && change.key === plan.sessionId;
  if (boundary === 'plugin-intent' && operation && change.value.phase === 'intent'
    || boundary === 'plugin-authorizing' && operation && change.value.phase === 'authorizing'
    || boundary === 'plugin-entry' && entry
    || boundary === 'plugin-done' && operation && change.value.phase === 'done') crashAt(root, boundary);
});
await new Promise((resolve, reject) => process.send({ plan }, error => error ? reject(error) : resolve()));
const result = await fixture.module.executePurge(plan);
await fixture.close();
throw new Error(`Native deletion crash checkpoint did not fire: ${boundary}/${result.status}`);
