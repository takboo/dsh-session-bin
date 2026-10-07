import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import * as cordis from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { createScratch, openFixture } from './fixture.mjs';
import { sessionBinRemoteContribution } from '../../dist/remote.js';

const require = createRequire(import.meta.url);
async function clientExports(id) {
  let registration;
  const window = { __ModuleLoader__: { load(value) { registration = value; } } };
  const sandbox = { window, console, URL, Request, Response, Headers, Blob, FormData, AbortController, AbortSignal,
    TextEncoder, TextDecoder, ArrayBuffer, Uint8Array, crypto: webcrypto, queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(await readFile(require.resolve(`${id}/client`), 'utf8'), sandbox, { filename: `${id}/client` });
  assert.equal(registration.id, id);
  return registration.factory(request => {
    assert.equal(request, '@deepseek-ai/cordis', `unexpected external in ${id}`);
    return cordis;
  });
}
function untilAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
}

/** Real SDK HTTP Fetch envelope and Client Remote projection, with no listener port.
 * createSharedFetchHandler is the already-admitted logical carrier boundary;
 * authentication and the live Web GUI are outside this isolated fixture.
 */
export async function openRemoteFixture({ seed = true } = {}) {
  const fixture = await openFixture(await createScratch('remote-'), { seed, legacy: false });
  const client = new cordis.Context();
  let disposeEvents;
  try {
    await fixture.mount({ name: 'remote-test-connection', apply(ctx) {
      new HostConnectionService(ctx, [], {
        isAuthenticated: () => true,
        authenticatedUrl: url => url,
        authorizeIndex: () => true,
      });
    } });
    await fixture.mount(TypertGatewayService);
    assert(fixture.ctx.typertGateway);
    disposeEvents = fixture.ctx.typertGateway.registerRemoteEvents(async function* (signal) {
      await untilAbort(signal);
    }, { home: fixture.root });
    const shared = fixture.ctx.connection.createSharedFetchHandler('/api');
    const requests = [];
    const connectionClient = await clientExports('@deepseek-ai/dsh-client-connection');
    const gatewayClient = await clientExports('@deepseek-ai/dsh-api-gateway');
    await client.plugin(TypertRegistry);
    await client.plugin({ name: 'remote-test-client-connection', apply(ctx) {
      connectionClient.installConnection(ctx, { transport: {
        ownsHost: true,
        async fetch(input, init) {
          const request = new Request(new URL(String(input), 'http://fixture.invalid/'), init);
          requests.push({ path: new URL(request.url).pathname, body: JSON.parse(init.body) });
          return shared.fetch(request);
        },
        async *openStream(endpoint, payload, signal, uplink) {
          // Physical JSON serialization reconstructs a Host-realm plain object.
          // RpcStreamOpen returns an iterable immediately; Gateway.open is async.
          const wire = JSON.parse(JSON.stringify(payload));
          const source = await fixture.ctx.typertGateway.wireStream.open(endpoint, wire, uplink,
            fixture.ctx.connection.operator, signal);
          yield* source;
        },
      } });
    } });
    await client.plugin(gatewayClient);
    const unmount = await client.remote.$mount(sessionBinRemoteContribution);
    return { ...fixture, client, api: client.remote.sessionBin, requests, unmount,
      async close() {
        await client.fiber.dispose();
        await disposeEvents?.();
        await fixture.close();
      },
    };
  } catch (error) {
    await client.fiber.dispose();
    await disposeEvents?.();
    await fixture.close();
    throw error;
  }
}

export async function within(promise, signal) {
  signal.throwIfAborted();
  const stopped = Promise.withResolvers();
  const abort = () => stopped.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([promise, stopped.promise]); }
  finally { signal.removeEventListener('abort', abort); }
}
