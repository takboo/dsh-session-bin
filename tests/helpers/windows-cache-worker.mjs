import assert from 'node:assert/strict';
import { openNativeDeletionFixture } from './native-deletion-fixture.mjs';
import { crashAt } from './platform-fixture.mjs';

const [root, boundary, rawPlan] = process.argv.slice(2);
assert(root && boundary && rawPlan);
assert.equal(process.platform, 'win32');
assert.equal(process.env.DSH_SESSION_BIN_PLATFORM_VERIFY, '1');
const plan = JSON.parse(rawPlan);
const fixture = await openNativeDeletionFixture(root);
const metadata = fixture.nativeOwner.metadata;
if (boundary === 'cache-renamed') {
  const move = metadata.moveCacheDocument.bind(metadata);
  metadata.moveCacheDocument = async (...args) => {
    await move(...args);
    crashAt(root, boundary);
  };
} else if (boundary === 'cache-stage-cleared') {
  const clear = metadata.clearCacheStage.bind(metadata);
  metadata.clearCacheStage = async (...args) => {
    await clear(...args);
    crashAt(root, boundary);
  };
} else {
  throw new Error(`Unknown Windows cache crash boundary: ${boundary}`);
}
await new Promise((resolve, reject) => process.send({ plan }, error => error ? reject(error) : resolve()));
const result = await fixture.module.executePurge(plan);
await fixture.close();
throw new Error(`Windows cache crash checkpoint did not fire: ${boundary}/${result.status}`);
