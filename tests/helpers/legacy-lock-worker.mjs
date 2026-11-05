import { openFixture } from './fixture.mjs';
import { crashAt } from './platform-fixture.mjs';

const [root] = process.argv.slice(2);
const f = await openFixture(root, { legacy: false, compression: 'zstd' });
const files = f.ctx.get('sessionBin').nativeOwner.files;
const rows = files.rows.bind(files);
let reads = 0;
files.rows = async (...args) => {
  // Second enumeration occurs under the newly created and synced kernel lock,
  // before any lifecycle witness or deletion plan has been committed.
  if (++reads === 2) crashAt(root, 'legacy-lock-created');
  return rows(...args);
};
await f.ctx.get('sessionBin').preparePurge({ sessionId: 'historical' });
await f.close();
throw new Error('Legacy lock crash checkpoint did not fire.');
