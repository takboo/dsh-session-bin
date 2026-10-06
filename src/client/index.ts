import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type { SessionBinRemoteApi } from '../remote/contracts.js';
import { sessionBinRemoteContribution } from '../remote/contracts.js';
import { SessionBinClientModel, browserPendingCache } from './model.js';
import { BinMenu, BinPanel, BinIcon, BinNotice } from './components.js';
import type { BinInjected } from './components.js';
import { NS, en, zh } from './locales.js';

export const panelId = 'dsh-session-bin.panel';
export const inject = ['slots', 'locale', 'remote'];
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { sessionBin: SessionBinRemoteApi }
}

async function initialize(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-bin.locale');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.setAttribute('data-plugin', 'dsh-session-bin');
    style.setAttribute('data-plugin-css', 'session-bin-panel');
    style.textContent = __SESSION_BIN_CSS__;
    document.head.append(style);
    return () => style.remove();
  }, 'session-bin.styles');
  let cache;
  try { cache = browserPendingCache(window.sessionStorage); } catch { /* Storage can be withheld by the browser. */ }
  const model = new SessionBinClientModel(ctx.remote.sessionBin, () => ctx.remote.$stream({
    name: 'sessionBin.follow',
    open: signal => ctx.remote.sessionBin.follow(signal),
    ended: () => new Error('Session Bin snapshot stream ended.'),
  }), cache);
  ctx.effect(() => () => model.dispose(), 'session-bin.model');
  const face = (): BinInjected => ({
    hooks: { bin: model }, model,
    formatDate: date => new Intl.DateTimeFormat(ctx.locale.getLocale().active, {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(date)),
  });
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-bin.move', order: 500, locale: NS, inject: face,
  }, BinMenu));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId, locale: NS, inject: face }, BinPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 500, label: () => ctx.locale.bind(NS)('title'),
  }, BinIcon));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-session-bin.notice', locale: NS, inject: face,
  }, BinNotice));
  await model.refresh();
}

export async function apply(ctx: Context): Promise<void> {
  try {
    await ctx.remote.$mount(sessionBinRemoteContribution);
    await ctx.inject(['slots', 'locale', 'remote', 'remote.sessionBin'], async consumer => {
      await initialize(consumer);
    });
  }
  catch (error) {
    console.error('Session Bin: client initialization failed.', error);
    throw error;
  }
}
