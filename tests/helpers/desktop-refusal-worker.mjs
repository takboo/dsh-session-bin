import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratch, transcript } from './fixture.mjs';
import { openNativeDeletionFixture } from './native-deletion-fixture.mjs';
const sdkRoot = process.env.DSH_SESSION_BIN_DESKTOP_SDK;
assert(sdkRoot?.includes('/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'));
const require = createRequire(join(sdkRoot, 'package.json'));
const actual = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json');
assert(actual.startsWith(sdkRoot), 'Refusal probe must use the actual ASAR SDK');
const version = JSON.parse(await readFile(actual, 'utf8')).version;
const expectedUnsupported = version !== process.env.DSH_COMPAT_BASELINE_SDK;
const root = await createScratch('desktop-refusal-');
const fixture = await openNativeDeletionFixture(root, { seed: true, productService: true });
try {
  const before = await transcript(fixture, 'quiet');
  const sibling = await transcript(fixture, 'sibling');
  const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
  assert.deepEqual(plan.blockers, expectedUnsupported ? [{ code: 'permanent-deletion-unsupported' }] : []);
  assert.deepEqual(await transcript(fixture, 'quiet'), before);
  assert.deepEqual(await transcript(fixture, 'sibling'), sibling);
  console.log(JSON.stringify({ status: 'passed', sdk: version, expectedUnsupported, blockers: plan.blockers, deletionExecutions: 0,
    scope: 'Actual ASAR production composition; temporary fixtures; preparation only.' }));
} finally { await fixture.close(); }
