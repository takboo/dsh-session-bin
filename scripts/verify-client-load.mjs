#!/usr/bin/env node
/** Real npm SDK loader/slot fixture; no live GUI, profile, sessions or user config. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';

const execute = promisify(execFile);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkVersion = '0.2.0-rc.2';
const fixtureId = 'dsh-session-bin-compat-fixture';
const panelId = 'dsh-session-bin.compatibility.panel';
const modulesId = '@deepseek-ai/dsh-client-modules';
const rendererId = '@deepseek-ai/dsh-client-ui-renderer';
const primitivesId = '@deepseek-ai/dsh-client-ui-primitives';
const cordisId = '@deepseek-ai/cordis';
const slotsId = '@deepseek-ai/dsh-client-ui-slots';

const hostSource = `export const inject = ['compatibilityProbe'];
export function apply(ctx) {
  ctx.effect(() => {
    ctx.compatibilityProbe.hostApplies++;
    ctx.compatibilityProbe.hostActive = true;
    return () => {
      ctx.compatibilityProbe.hostDisposals++;
      ctx.compatibilityProbe.hostActive = false;
    };
  }, 'compatibility fixture host');
}
`;
const clientSource = `window.__ModuleLoader__.load({
  id: '${fixtureId}',
  factory(require) {
    window.fixtureFactoryRuns++;
    const React = require('react');
    const primitives = require('${primitivesId}');
    const slots = require('${slotsId}');
    const cordis = require('${cordisId}');
    function Panel() {
      return React.createElement(primitives.Button, { children: 'Compatibility fixture' });
    }
    function Icon() { return React.createElement('span', {}, 'Bin'); }
    return {
      inject: ['slots', 'compatibilityProbe'],
      shared: { React, primitives, slots, cordis },
      apply(ctx) {
        ctx.effect(() => {
          ctx.compatibilityProbe.clientApplies++;
          return () => { ctx.compatibilityProbe.clientDisposals++; };
        });
        ctx.slots.inject('main', () => {
          ctx.compatibilityProbe.panelRegistrations++;
          return ctx.slots.register({ name: 'main', key: '${panelId}' }, Panel);
        });
        ctx.slots.inject('sidebar.panellist', () => {
          ctx.compatibilityProbe.iconRegistrations++;
          return ctx.slots.register({
            name: 'sidebar.panellist', id: '${panelId}', order: 500,
            label: 'Session Bin compatibility fixture'
          }, Icon);
        });
      }
    };
  }
});
`;

async function createFixture(scratch, yaml) {
  const source = join(scratch, 'source');
  await mkdir(join(source, 'lib'), { recursive: true });
  const manifest = {
    name: fixtureId, version: '0.0.0', private: true, type: 'module',
    engines: { dsh: sdkVersion, node: '>=24' },
    exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
    files: ['lib', 'cordis.patch.yml'],
    peerDependencies: {
      [cordisId]: '4.0.4', [slotsId]: sdkVersion, [primitivesId]: sdkVersion,
      react: '^18.2.0'
    },
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
  };
  await Promise.all([
    writeFile(join(source, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(source, 'lib/index.js'), hostSource),
    writeFile(join(source, 'lib/client.js'), clientSource),
    writeFile(join(source, 'cordis.patch.yml'), yaml.stringify([{ insert: [{ id: 'session-bin-compatibility', name: fixtureId }] }]))
  ]);
  // Explicit empty config files keep npm away from personal configuration.
  const npmrc = join(scratch, 'empty-user.npmrc');
  const globalNpmrc = join(scratch, 'empty-global.npmrc');
  await Promise.all([writeFile(npmrc, ''), writeFile(globalNpmrc, '')]);
  const packed = await execute('npm', ['pack', '--json', '--ignore-scripts', '--offline',
    '--userconfig', npmrc, '--globalconfig', globalNpmrc, '--cache', join(scratch, 'npm-cache')],
    { cwd: source, maxBuffer: 1024 * 1024 });
  const [pack] = JSON.parse(packed.stdout);
  const fileNames = pack.files.map(({ path }) => path).sort();
  assert.deepEqual(fileNames, ['cordis.patch.yml', 'lib/client.js', 'lib/index.js', 'package.json']);
  const installed = join(scratch, 'installed/node_modules', fixtureId);
  await mkdir(installed, { recursive: true });
  const tarball = join(source, pack.filename);
  await execute('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed]);
  const fixtureRequire = createRequire(join(scratch, 'installed/anchor.cjs'));
  const installedManifest = JSON.parse(await readFile(fixtureRequire.resolve(`${fixtureId}/package.json`), 'utf8'));
  assert.deepEqual(installedManifest, manifest);
  const hostPath = fixtureRequire.resolve(fixtureId);
  const clientPath = fixtureRequire.resolve(`${fixtureId}/client`);
  assert.equal(hostPath, join(installed, 'lib/index.js'));
  assert.equal(clientPath, join(installed, 'lib/client.js'));
  assert.equal(await readFile(clientPath, 'utf8'), clientSource);
  const patch = yaml.parse(await readFile(join(installed, installedManifest.dsh.bundle.patch), 'utf8'));
  assert.equal(patch.length, 1);
  assert.deepEqual(Object.keys(patch[0]), ['insert']);
  assert.equal(patch[0].insert.length, 1);
  assert.equal(patch[0].insert[0].name, fixtureId);
  return { hostPath, clientPath, tarball, fileNames, hostRow: patch[0].insert[0] };
}

/** Return integrated report after all assertions pass, retaining scratch artifacts. */
export async function verifyClientLoad() {
  const require = createRequire(import.meta.url);
  const pinned = {
    [cordisId]: '4.0.4', '@deepseek-ai/cordis-plugin-loader': '1.0.5',
    [modulesId]: sdkVersion, [rendererId]: sdkVersion, [slotsId]: sdkVersion, [primitivesId]: sdkVersion
  };
  for (const [id, expected] of Object.entries(pinned)) {
    const manifest = JSON.parse(await readFile(require.resolve(`${id}/package.json`), 'utf8'));
    assert.equal(manifest.version, expected, `${id}: verifier requires exact SDK version`);
  }
  const [cordis, { Loader }, slots, React, ReactDOM, ReactDOMClient, jsxRuntime,
    { JSDOM }, esbuild, yaml] = await Promise.all([
    import(cordisId), import('@deepseek-ai/cordis-plugin-loader'), import(slotsId),
    import('react'), import('react-dom'), import('react-dom/client'), import('react/jsx-runtime'),
    import('jsdom'), import('esbuild'), import('yaml')
  ]);
  const scratchRoot = join(workspace, '.local/compatibility');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'client-load-'));
  const fixture = await createFixture(scratch, yaml);
  const probe = {
    hostApplies: 0, hostDisposals: 0, hostActive: false,
    clientApplies: 0, clientDisposals: 0, panelRegistrations: 0, iconRegistrations: 0
  };
  const host = new cordis.Context();
  const browser = new cordis.Context();
  await host.plugin(Loader, { baseUrl: pathToFileURL(`${scratch}/installed/`).href });
  await browser.plugin(Loader);
  const hostLoader = host.loader;
  const clientLoader = browser.loader;
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://fixture.invalid/', runScripts: 'outside-only'
  });
  try {
    // Public npm export resolution, then the real Cordis Loader import/apply.
    // The CLI bundle/profile installer is outside this fixture's scope.
    const hostEntryId = await hostLoader.create({ id: fixture.hostRow.id, name: pathToFileURL(fixture.hostPath).href });
    await hostLoader.await();
    assert.equal(probe.hostApplies, 0, 'named inject must gate host activation');
    host.reflect.provide('compatibilityProbe', probe);
    await hostLoader.await();
    assert.equal(probe.hostApplies, 1);
    assert.equal(probe.hostActive, true);
    const hostFiber = hostLoader.resolve(hostEntryId).fiber;
    hostLoader.remove(hostEntryId);
    await hostFiber?.await();
    assert.equal(probe.hostDisposals, 1);
    assert.equal(probe.hostActive, false);

    const context = dom.getInternalVMContext();
    dom.window.fixtureFactoryRuns = 0;
    const facade = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration); } };
    dom.window.__ModuleLoader__ = facade;
    const run = (code, filename) => new vm.Script(code, { filename }).runInContext(context);
    // The actual SDK bootstrap factory establishes the real module table.
    run(await readFile(require.resolve(`${modulesId}/client`), 'utf8'), `${modulesId}/client`);
    assert.equal(facade.pendingQueue.length, 1);
    const bootstrap = facade.pendingQueue.shift();
    assert.equal(bootstrap.id, modulesId);
    const bootstrapExports = bootstrap.factory((id) => { throw new Error(`unexpected bootstrap request ${id}`); });
    assert.equal(typeof bootstrapExports.ClientModuleSystem, 'function');

    // Real published Button, built once as a platform seed; CSS intentionally
    // discarded. Shared React/Cordis/slots remain external to this browser build.
    const seed = {
      react: React.default, 'react-dom': ReactDOM.default, 'react-dom/client': ReactDOMClient.default,
      'react/jsx-runtime': jsxRuntime, [cordisId]: cordis, [slotsId]: slots
    };
    const platformBuild = await esbuild.build({
      absWorkingDir: workspace,
      stdin: { contents: `export { Button } from '${primitivesId}';`, resolveDir: workspace, sourcefile: 'platform-primitives.js' },
      bundle: true, write: false, format: 'iife', globalName: '__FixturePrimitives',
      platform: 'browser', target: 'es2022', external: Object.keys(seed),
      plugins: [{ name: 'fixture-css', setup(build) {
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
      } }], logLevel: 'silent'
    });
    const platformPath = join(scratch, 'platform-primitives.js');
    await writeFile(platformPath, platformBuild.outputFiles[0].text);
    dom.window.require = (id) => {
      assert.ok(Object.hasOwn(seed, id), `platform build unexpected request ${id}`);
      return seed[id];
    };
    run(platformBuild.outputFiles[0].text, platformPath);
    const primitives = dom.window.__FixturePrimitives;
    assert.equal(primitives.Button.$$typeof, Symbol.for('react.forward_ref'));
    seed[primitivesId] = primitives;

    const clientURL = `plugins/??${fixtureId}/client.js&rev=fixture`;
    const boot = {
      rev: 'fixture', entries: [{ id: fixtureId, url: clientURL, rev: 'fixture' }],
      batches: [{ phase: 'application', url: clientURL, rev: 'fixture', entries: [fixtureId] }]
    };
    const requested = [];
    const modules = bootstrapExports.createClientModuleSystem(facade, { id: modulesId, exports: bootstrapExports }, {
      boot, staticModules: seed,
      async loadBundle(url) {
        assert.equal(url, clientURL, 'transport only serves retained local fixture');
        requested.push(url);
        run(await readFile(fixture.clientPath, 'utf8'), fixture.clientPath);
      }
    });
    assert.ok(modules instanceof bootstrapExports.ClientModuleSystem);
    assert.equal(facade.mode, 'live');
    await modules.prefetch(fixtureId);
    assert.equal(requested.length, 1);
    assert.equal(dom.window.fixtureFactoryRuns, 0, 'prefetch only registers lazy factory');
    const clientExports = await modules.import(fixtureId);
    assert.equal(dom.window.fixtureFactoryRuns, 1);
    assert.equal(await modules.import(`${fixtureId}/client`), clientExports);
    assert.equal(clientExports.shared.React, seed.react);
    assert.equal(clientExports.shared.primitives, primitives);
    assert.equal(clientExports.shared.primitives.Button, primitives.Button);
    assert.equal(clientExports.shared.slots, slots);
    assert.equal(clientExports.shared.cordis, cordis);
    assert.ok(seed.react.isValidElement(clientExports.shared.React.createElement(primitives.Button)));
    await assert.rejects(modules.import('fixture-undeclared-module'), /cannot resolve/);

    // Official renderer apply creates official SlotRegistry; no fake slots.
    run(await readFile(require.resolve(`${rendererId}/client`), 'utf8'), `${rendererId}/client`);
    clientLoader.internal = modules;
    browser.reflect.provide('compatibilityProbe', probe);
    await clientLoader.create({ id: 'renderer', name: rendererId });
    await clientLoader.await();
    const rendererExports = await modules.import(rendererId);
    assert.ok(browser.slots instanceof rendererExports.SlotRegistry);
    await modules.entries.start(clientLoader, modules.manifest);
    assert.equal(probe.clientApplies, 1);
    assert.equal(browser.slots.entries('main').length, 0);
    assert.equal(browser.slots.entries('sidebar.panellist').length, 0);
    assert.equal(probe.panelRegistrations, 0, 'inject waits for the declaration');

    // Stand-in owner: only documented declarations from ui-layout/ui-sidebar;
    // no native shell activation, services, stores or rendering are claimed.
    const ownerPlugin = {
      name: 'compatibility-slot-owner', inject: ['slots'],
      apply(ctx) {
        ctx.slots.register({ name: 'root', children: {
          main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }
        } }, () => null);
      }
    };
    const assertContributions = () => {
      const panels = browser.slots.entries('main');
      const icons = browser.slots.entries('sidebar.panellist');
      assert.equal(panels.length, 1);
      assert.equal(icons.length, 1);
      assert.equal(panels[0].options.key, panelId);
      assert.equal(icons[0].options.id, panelId);
      assert.equal(icons[0].options.order, 500);
      const element = panels[0].component({});
      assert.equal(element.type, primitives.Button);
      assert.ok(seed.react.isValidElement(element));
    };
    let owner = browser.plugin(ownerPlugin);
    await owner.await();
    assertContributions();
    assert.equal(probe.panelRegistrations, 1);
    assert.equal(probe.iconRegistrations, 1);
    owner.dispose();
    await owner.await();
    assert.equal(browser.slots.spec('main'), undefined);
    assert.equal(browser.slots.spec('sidebar.panellist'), undefined);
    assert.equal(browser.slots.entries('main').length, 0);
    assert.equal(browser.slots.entries('sidebar.panellist').length, 0);
    owner = browser.plugin(ownerPlugin);
    await owner.await();
    assertContributions();
    assert.equal(probe.panelRegistrations, 2);
    assert.equal(probe.iconRegistrations, 2);
    const clientEntry = [...clientLoader.entries()].find((entry) => entry.options.name === fixtureId);
    assert.ok(clientEntry?.fiber);
    const clientFiber = clientEntry.fiber;
    clientLoader.remove(clientEntry.id);
    await clientFiber.await();
    assert.equal(probe.clientDisposals, 1);
    assert.equal(browser.slots.entries('main').length, 0);
    assert.equal(browser.slots.entries('sidebar.panellist').length, 0);
    owner.dispose();
    await owner.await();
    owner = browser.plugin(ownerPlugin);
    await owner.await();
    assert.equal(browser.slots.entries('main').length, 0, 'unloaded inject does not resurrect');
    assert.equal(browser.slots.entries('sidebar.panellist').length, 0);
    owner.dispose();
    await owner.await();
    assert.equal(dom.window.fixtureFactoryRuns, 1, 'shared imports remain memoized');

    const report = {
      status: 'passed', sdkVersion, pinnedPackages: pinned,
      scratch: relative(workspace, scratch), tarball: relative(workspace, fixture.tarball), packedFiles: fixture.fileNames,
      host: { loader: '@deepseek-ai/cordis-plugin-loader.Loader', namedInjectGating: true,
        applies: probe.hostApplies, disposals: probe.hostDisposals,
        resolution: 'installed fixture public exports resolved with createRequire, then loaded by Cordis' },
      client: { loader: `${modulesId}/client.ClientModuleSystem`, renderer: `${rendererId}/client.SlotRegistry`,
        bundleRequests: requested.length, factoryRuns: dom.window.fixtureFactoryRuns,
        applies: probe.clientApplies, disposals: probe.clientDisposals, panelId,
        declarationRegistrations: probe.panelRegistrations, declarationCollapseAndRedeclare: true,
        noResurrectionAfterUnload: true, sharedReact: true, sharedPrimitives: true, sharedCordis: true, sharedSlots: true },
      scope: [
        'npm tarball with built Host/Client exports and bundle patch; no installation scripts',
        'real Cordis host/client fibers, real DSH lazy module table and SlotRegistry lifecycle',
        'jsdom/local VM transport; stand-in owner declares main/keyed and sidebar.panellist/list only',
        'published primitives Button built once as platform seed; CSS discarded; no React root mounted',
        'no CLI/profile installer, live GUI, full ui-layout/ui-sidebar activation, visual, theme or accessibility validation'
      ]
    };
    await writeFile(join(scratch, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await browser.fiber.dispose();
    await host.fiber.dispose();
    dom.window.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyClientLoad(), null, 2));
}
