import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openRetirementFixture, multiParticipantOptions } from './retirement-owner.mjs';

const [root, selected, rawRequest] = process.argv.slice(2);
assert(root && selected && rawRequest);
const request = JSON.parse(rawRequest);
const [checkpoint, participantId] = selected.split(':');
const fixture = await openRetirementFixture(root, { skipReconcile: true,
  ownerOptions: multiParticipantOptions({ onCheckpoint(name, context) {
    if (name !== checkpoint) return;
    if (participantId) {
      const flag = name === 'participant-fenced' ? 'fenced'
        : name === 'participant-quiesced' ? 'quiesced' : 'converged';
      if (!context.record?.participants.find(participant => participant.id === participantId)?.[flag]) return;
    }
    process.kill(process.pid, 'SIGKILL');
  } }),
});
const manifest = await fixture.owner.prepare(request.expected);
await new Promise((resolve, reject) => process.send({ request }, error => error ? reject(error) : resolve()));
const state = await fixture.owner.retire(request, async () => ({ authorized: true, authorizationId: randomUUID() }), manifest);
await fixture.close();
throw new Error(`Owner crash checkpoint did not fire: ${selected}/${state.phase}`);
