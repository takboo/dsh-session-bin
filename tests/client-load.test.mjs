import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as cordis from '@deepseek-ai/cordis';
import * as slots from '@deepseek-ai/dsh-client-ui-slots';
import * as stores from '@deepseek-ai/dsh-client-store';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { openRemoteFixture, within } from './helpers/remote-fixture.mjs';
import { SessionId } from '@deepseek-ai/dsh-session';
import { workspaceRoot } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const MODULES = '@deepseek-ai/dsh-client-modules';
const RENDERER = '@deepseek-ai/dsh-client-ui-renderer';
const LOCALE = '@deepseek-ai/dsh-client-locale';
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives';
const PRODUCT = 'dsh-session-bin';
const panelId = 'dsh-session-bin.panel';
const seats = ['main', 'sidebar.panellist', 'shell.overlay'];
const menuSeat = 'sidebar.workspaces.session.menu.item';

/** Build one actual npm primitive seed, retaining platform React identity.
 * Native CSS is deliberately discarded: this tier verifies code/lifecycle,
 * not native visual styling, layout, or accessibility.
 */
async function nativeSeed(context, seed) {
  const result = await build({
    absWorkingDir: workspaceRoot,
    stdin: { contents: `export { IconTrashOutlineRegular, IconRefreshOutlineRegular, Button, Input, Checkbox, Toast } from '${PRIMITIVES}';`,
      resolveDir: workspaceRoot, sourcefile: 'artifact-platform-primitives.js' },
    bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    external: Object.keys(seed),
    plugins: [{ name: 'discard-native-css', setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
    } }],
    logLevel: 'silent',
  });
  context.__artifactRequire = request => {
    assert(Object.hasOwn(seed, request), `unexpected native seed request ${request}`);
    return seed[request];
  };
  const script = result.outputFiles.find(file => file.path.endsWith('.js')) ?? result.outputFiles[0];
  const code = `(function(require) { var module = { exports: {} }; var exports = module.exports;\n${script.text}\nreturn module.exports; })(__artifactRequire)`;
  const primitives = new vm.Script(code, { filename: 'artifact-platform-primitives.js' }).runInContext(context);
  delete context.__artifactRequire;
  assert(primitives.IconTrashOutlineRegular, 'the official icon export must exist in the shared native seed');
  return primitives;
}

async function modelReady(model, signal) {
  if (model.getSnapshot().phase === 'ready') return;
  const waiting = Promise.withResolvers();
  const check = () => {
    const state = model.getSnapshot();
    if (state.phase === 'ready') waiting.resolve();
    else if (state.phase === 'error') waiting.reject(new Error(`Artifact model failed: ${state.error}`));
  };
  const off = model.subscribe(check);
  check();
  try { await within(waiting.promise, signal); }
  finally { off(); }
}

function listenerCount(fixture) {
  return fixture.ctx.events.dispatch('emit', ['domain/changed', {
    domain: 'session_bin', table: 'entries', key: 'artifact', operation: 'deleted',
  }]).length;
}

test('the built lazy Client factory registers real components and cleans up every owned lifecycle',
  { timeout: 30000 }, async t => {
    const fixture = await openRemoteFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'http://fixture.invalid/', runScripts: 'outside-only',
    });
    let owner;
    let feature;
    try {
      await fixture.unmount();
      const baselineListeners = listenerCount(fixture);
      const context = dom.getInternalVMContext();
      // The native browser uses one AbortSignal realm. Keep the in-process
      // Node carrier and this temporary DOM on the same signal constructor.
      Object.assign(dom.window, { AbortController, AbortSignal, TextEncoder, TextDecoder });
      Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto });
      assert.equal(dom.window.React, undefined, 'do not supply a global that hides classic JSX mistakes');
      const run = (code, filename) => new vm.Script(code, { filename }).runInContext(context);
      const seed = {
        react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
        '@deepseek-ai/cordis': cordis,
        '@deepseek-ai/dsh-client-ui-slots': slots,
        '@deepseek-ai/dsh-client-store': stores,
      };
      seed[PRIMITIVES] = await nativeSeed(context, seed);
      const facade = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration); } };
      dom.window.__ModuleLoader__ = facade;
      run(await readFile(require.resolve(`${MODULES}/client`), 'utf8'), `${MODULES}/client`);
      assert.equal(facade.pendingQueue.length, 1);
      const registration = facade.pendingQueue.shift();
      assert.equal(registration.id, MODULES);
      const bootstrap = registration.factory(request => { throw new Error(`unexpected bootstrap request ${request}`); });
      const sourcePaths = {
        [RENDERER]: require.resolve(`${RENDERER}/client`),
        [LOCALE]: require.resolve(`${LOCALE}/client`),
        [PRODUCT]: new URL('../dist/client.js', import.meta.url),
      };
      const entries = Object.keys(sourcePaths).map(id => ({ id, url: `plugins/??${id}/client.js&rev=artifact`, rev: 'artifact' }));
      const boot = { rev: 'artifact', entries,
        batches: entries.map(entry => ({ phase: 'application', url: entry.url, rev: entry.rev, entries: [entry.id] })) };
      const requests = [];
      const modules = bootstrap.createClientModuleSystem(facade, { id: MODULES, exports: bootstrap }, {
        boot, staticModules: seed,
        async loadBundle(url) {
          const entry = entries.find(candidate => candidate.url === url);
          assert(entry, `unexpected artifact bundle request ${url}`);
          requests.push(entry.id);
          run(await readFile(sourcePaths[entry.id], 'utf8'), `${entry.id}/client`);
        },
      });
      assert(modules instanceof bootstrap.ClientModuleSystem);
      assert.equal(await modules.import('react'), React);
      assert.equal(await modules.import(PRIMITIVES), seed[PRIMITIVES]);
      await fixture.client.plugin(Loader);
      fixture.client.loader.internal = modules;
      const renderer = await modules.import(RENDERER);
      await fixture.client.plugin(renderer);
      assert(fixture.client.slots instanceof renderer.SlotRegistry);
      const locale = await modules.import(LOCALE);
      await fixture.client.plugin({ name: 'artifact-dictionary-owner', inject: ['slots'], apply(ctx) {
        // Public standalone LocaleRuntime has no durable preference/settings IO.
        const runtime = new locale.LocaleRuntime(ctx);
        ctx.provide('locale', runtime);
        ctx.slots.installLocale(runtime);
      } });
      const product = await modules.import(PRODUCT);
      assert.equal(await modules.import(`${PRODUCT}/client`), product);
      assert.equal(typeof product.apply, 'function');
      feature = fixture.client.plugin(product);
      await feature;
      assert(fixture.client.remote.sessionBin, 'the real guarded plugin must mount its namespace');
      const styles = () => dom.window.document.head.querySelectorAll('style[data-plugin="dsh-session-bin"]');
      assert.equal(styles().length, 1);
      assert(styles()[0].textContent.length > 0);
      for (const seat of seats) assert.equal(fixture.client.slots.entries(seat).length, 0,
        `${seat} injection must wait for its declaration`);

      const ownerPlugin = { name: 'artifact-documented-slot-owner', inject: ['slots'], apply(ctx) {
        // The three product slots and the native menu seat to verify absence.
        // No shell component, real DOM renderer or visual behavior is claimed.
        ctx.slots.register({ name: 'root', children: {
          main: { kind: 'keyed', scope: 'root' },
          'sidebar.panellist': { kind: 'list', scope: 'root' },
          'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        } }, () => null);
      } };
      const assertRegistered = () => {
        for (const seat of seats) assert.equal(fixture.client.slots.entries(seat).length, 1, seat);
        assert.equal(fixture.client.slots.entries('main')[0].options.key, panelId);
        const icon = fixture.client.slots.entries('sidebar.panellist')[0];
        assert.equal(icon.options.id, panelId);
        // This is execution of the current built component, not an exported
        // function/type inspection. React must be supplied through the shared JSX runtime.
        const element = icon.component({ size: 16, active: false });
        assert(React.isValidElement(element));
        assert.equal(element.type, seed[PRIMITIVES].IconTrashOutlineRegular);
        assert.equal(element.props.size, 16);
        assert.equal(fixture.client.slots.entries(menuSeat).length, 0, 'native Archive remains the only conversation menu entry');
        assert.equal(fixture.client.slots.entries('main')[0].locale, 'dshSessionBin');
      };
      owner = fixture.client.plugin(ownerPlugin);
      await owner;
      assertRegistered();
      const model = fixture.client.slots.entries('main')[0].inject().model;
      await modelReady(model, t.signal);
      assert.equal(listenerCount(fixture), baselineListeners + 1, 'artifact owns exactly one live metadata stream');
      await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
      const [entry] = await fixture.bin.list();
      const unarchived = await model.unarchive(entry);
      assert.equal(unarchived.status, 'success');
      assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
      assert.equal(model.move, undefined);
      assert.equal(model.restore, undefined);
      assert.equal(fixture.client.locale.bind('dshSessionBin')('title'), 'Session Bin');
      await owner.dispose();
      owner = undefined;
      for (const seat of seats) {
        assert.equal(fixture.client.slots.spec(seat), undefined, seat);
        assert.equal(fixture.client.slots.entries(seat).length, 0, seat);
      }
      assert.equal(styles().length, 1, 'declaration collapse does not duplicate or destroy the feature model');
      owner = fixture.client.plugin(ownerPlugin);
      await owner;
      assertRegistered();
      assert.equal(fixture.client.slots.entries('main')[0].inject().model, model);
      await feature.dispose();
      feature = undefined;
      for (const seat of seats) assert.equal(fixture.client.slots.entries(seat).length, 0, seat);
      assert.equal(styles().length, 0);
      assert.equal(fixture.client.remote.sessionBin, undefined);
      assert.equal(listenerCount(fixture), baselineListeners);
      assert.equal(fixture.client.locale.bind('dshSessionBin')('title'), 'title');
      await owner.dispose();
      owner = fixture.client.plugin(ownerPlugin);
      await owner;
      for (const seat of seats) assert.equal(fixture.client.slots.entries(seat).length, 0,
        `${seat} must not resurrect after the real feature fiber unloaded`);
      assert.equal(styles().length, 0);
      assert.equal(requests.filter(id => id === PRODUCT).length, 1, 'the real module system materializes one shared product factory');
    } finally {
      await feature?.dispose();
      await owner?.dispose();
      await fixture.close();
      dom.window.close();
    }
  });
