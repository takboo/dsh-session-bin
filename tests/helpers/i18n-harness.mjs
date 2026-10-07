import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import * as stores from '@deepseek-ai/dsh-client-store';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const workspace = new URL('../../', import.meta.url);

function mutable(value) {
  let current = value;
  const listeners = new Set();
  return {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    set: value => { current = value; for (const listener of listeners) listener(); },
  };
}

/** This is a React DOM copy/state tier over the current source components and
 * public LocaleRuntime, with actual official primitives. Readable snapshots
 * inject UI states; they neither implement nor claim to test Host business.
 * Native CSS is discarded, so this tier does not claim visual layout coverage.
 * The separate client-load/Chrome tiers cover the factory and real styling.
 */
export async function createI18nHarness() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="test-root"></main></body></html>', {
    url: 'http://i18n.fixture.invalid/', pretendToBeVisual: true,
  });
  const saved = new Map();
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const React = (await import('react')).default;
  const jsxRuntime = await import('react/jsx-runtime');
  const ReactDOM = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react-dom/test-utils');
  const seeds = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM };
  const bundle = async (contents, sourcefile, extra = {}) => {
    const result = await build({
      absWorkingDir: new URL('.', workspace).pathname,
      stdin: { contents, resolveDir: new URL('.', workspace).pathname, sourcefile },
      bundle: true, write: false, platform: 'browser', format: 'cjs', jsx: 'automatic', target: 'es2022',
      external: [...Object.keys(seeds), ...Object.keys(extra)],
      plugins: [{ name: 'discard-css-in-copy-tier', setup(builder) {
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
      } }], logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(request => {
      assert(Object.hasOwn(seeds, request) || Object.hasOwn(extra, request), `unexpected UI copy-tier request ${request}`);
      return extra[request] ?? seeds[request];
    }, module, module.exports);
    return module.exports;
  };
  const primitives = await bundle("export { Button, Checkbox, Input, MenuItemButton, Toast, IconTrashOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';", 'i18n-native-seed.js');
  const components = await bundle("export * from './src/client/components.tsx'; export * from './src/client/locales.ts';", 'i18n-components.tsx', {
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  });
  let registration;
  vm.runInNewContext(await readFile(require.resolve('@deepseek-ai/dsh-client-locale/client'), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { registration = value; } } }, console,
    navigator: dom.window.navigator, document: dom.window.document,
  });
  const localeExports = registration.factory(request => {
    if (request === '@deepseek-ai/dsh-client-store') return stores;
    if (request === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    assert(Object.hasOwn(seeds, request), `unexpected LocaleRuntime request ${request}`);
    return seeds[request];
  });
  const ctx = new Context();
  const locale = new localeExports.LocaleRuntime(ctx);
  const removeDictionary = locale.register(components.NS, { en: components.en, zh: components.zh });
  const t = locale.bind(components.NS);
  const baseState = { phase: 'ready', entries: [], busy: [], pending: [], results: [], error: null, notice: null };
  const bin = mutable(baseState);
  const sessions = mutable({ byId: {} });
  const workspaces = mutable({ items: [] });
  const menu = mutable(true);
  const calls = [];
  const model = {
    refresh: async () => { calls.push(['refresh']); },
    move: async id => { calls.push(['move', id]); },
    restore: async entry => { calls.push(['restore', entry]); return { sessionId: entry.sessionId, entryId: entry.entryId, status: 'success', reason: null }; },
    restoreMany: async entries => { calls.push(['restoreMany', entries]); return entries.map(entry => ({ sessionId: entry.sessionId, entryId: entry.entryId, status: 'success', reason: null })); },
    checkPending: async () => { calls.push(['checkPending']); },
    dismissNotice: () => { calls.push(['dismissNotice']); bin.set({ ...bin.getSnapshot(), notice: null }); },
  };
  const hook = source => selector => selector(React.useSyncExternalStore(source.subscribe, source.getSnapshot));
  const root = createRoot(dom.window.document.getElementById('test-root'));
  let view = 'panel';
  let ownerProps = {};
  const formatDate = date => new Intl.DateTimeFormat(locale.getLocale().active, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
  function CopyView() {
    React.useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot());
    const props = { t, useBin: hook(bin), model, formatDate,
      useSessions: hook(sessions), useWorkspaces: hook(workspaces),
      useMenuOpenState: () => { const open = React.useSyncExternalStore(menu.subscribe, menu.getSnapshot); return [open, value => { calls.push(['setMenuOpen', value]); menu.set(value); }]; }, ...ownerProps };
    const Component = view === 'panel' ? components.BinPanel : view === 'notice' ? components.BinNotice : components.BinMenu;
    return React.createElement(Component, props);
  }
  const flush = async fn => { await act(async () => { await fn?.(); }); };
  const render = async (kind = 'panel', props = {}) => { view = kind; ownerProps = props; await flush(() => root.render(React.createElement(CopyView))); };
  const state = async changes => flush(() => bin.set({ ...bin.getSnapshot(), ...changes }));
  const language = async id => flush(() => locale.setLocale(id));
  const click = async element => flush(() => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await render();
  return {
    dom, document: dom.window.document, React, components, ctx, locale, t, baseState, bin, sessions, workspaces, menu, calls,
    render, state, language, click, flush, formatDate,
    text: () => dom.window.document.body.textContent,
    async close() {
      try { await flush(() => root.unmount()); removeDictionary(); await ctx.fiber.dispose(); }
      finally {
        dom.window.close();
        for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
      }
    },
  };
}
