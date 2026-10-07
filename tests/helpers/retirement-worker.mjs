import assert from 'node:assert/strict';
import { openRetirementFixture } from './retirement-owner.mjs';

const [root, checkpoint, rawPlan] = process.argv.slice(2);
assert(root && checkpoint && rawPlan);
const plan = JSON.parse(rawPlan);
const fixture = await openRetirementFixture(root, { ownerOptions: {
  onCheckpoint(name) {
    if (name === checkpoint) process.kill(process.pid, 'SIGKILL');
  },
} });
fixture.ctx.on('domain/changed', change => {
  const operation = change.domain === 'session_bin_purge' && change.table === 'operations'
    && change.operation === 'put' && change.key === plan.operationId;
  const entry = change.domain === 'session_bin' && change.table === 'entries'
    && change.operation === 'deleted' && change.key === plan.sessionId;
  if ((checkpoint === 'plugin-intent' && operation && change.value.phase === 'intent')
    || (checkpoint === 'plugin-authorizing' && operation && change.value.phase === 'authorizing')
    || (checkpoint === 'plugin-entry' && entry)
    || (checkpoint === 'plugin-done' && operation && change.value.phase === 'done')) {
    process.kill(process.pid, 'SIGKILL');
  }
});
await new Promise((resolve, reject) => process.send({ plan }, error => error ? reject(error) : resolve()));
const result = await fixture.module.executePurge(plan);
await fixture.close();
throw new Error(`Retirement crash checkpoint did not fire: ${checkpoint}/${result.status}`);
