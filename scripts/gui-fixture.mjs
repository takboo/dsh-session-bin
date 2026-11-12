import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const fixtures = [
  { id: 'gui-quiet', title: '待整理的设计讨论', workspace: 'primary' },
  { id: 'gui-sibling', title: '接口实现记录', workspace: 'primary' },
  { id: 'gui-native-only', title: '原生归档保留', workspace: 'primary', archived: true },
  { id: 'gui-prearchived', title: '原先已归档的讨论', workspace: 'secondary', archived: true },
];
export const fixtureWorkspaces = { primary: 'GUI 主工作区', secondary: 'GUI 第二工作区' };

export async function openSdkFixture(paths, seed = false, sdkRequire = createRequire(import.meta.url)) {
  const load = name => import(pathToFileURL(sdkRequire.resolve(name)).href);
  const [{ Context }, { default: Storage }, storageJson, storageDomain, { SessionStore, SessionId },
    Jsonl, { WorkspaceRegistry }] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json',
    '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-workspace',
  ].map(load));
  const ctx = new Context();
  const mounted = [];
  const mount = async (implementation, config) => {
    const fiber = ctx.plugin(implementation, config);
    mounted.push(fiber);
    await fiber;
  };
  const close = async () => {
    const failures = [];
    for (const fiber of [...mounted].reverse()) {
      try { await fiber.dispose(); } catch (error) { failures.push(error); }
    }
    try { await ctx.fiber.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'GUI seed Context cleanup failed');
  };
  try {
    await mount(Storage);
    await mount(storageJson, { root: paths.storages });
    await mount(storageDomain, { backend: 'json' });
    await mount(SessionStore);
    await mount(Jsonl, { root: paths.sessions, compression: 'zstd' });
    if (seed) {
      const cliLookup = createRequire(sdkRequire.resolve('@deepseek-ai/dsh/package.json'));
      const baseLookup = createRequire(cliLookup.resolve('@deepseek-ai/dsh-base/package.json'));
      const projections = await import(pathToFileURL(baseLookup.resolve('@deepseek-ai/dsh-session-projection')).href);
      const title = await import(pathToFileURL(baseLookup.resolve('@deepseek-ai/dsh-session-title')).href);
      const cache = await import(pathToFileURL(baseLookup.resolve('@deepseek-ai/dsh-session-projection-cache')).href);
      await mount(projections.default);
      ctx.sessionProjections.register(title.titleProjectionDefinition);
      await mount(cache.default, { writeEveryEvents: 200, writeIntervalMs: 5000 });
      for (const [index, fixture] of fixtures.entries()) {
        const session = ctx.sessions.prepare(SessionId(fixture.id), {
          meta: { cwd: paths[fixture.workspace], createdAt: Date.now() - index * 1000 },
        });
        const handle = await ctx.sessionPersistence.create(session.header);
        try {
          // Native session-list metadata treats a log without turn/start as a
          // provisional blank. A completed fixture turn makes its row/menu real;
          // the public user title remains log-only and activates no model.
          const time = Date.now();
          await handle.append([
            { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
            { type: 'turn/end', seq: 1, time: time + 1, data: { turn: 1, reason: { kind: 'completed' } } },
            { type: 'turn/start', seq: 2, time: time + 2, data: { turn: 2 } },
            { type: 'turn/end', seq: 3, time: time + 3, data: { turn: 2, reason: { kind: 'completed' } } },
            { type: 'session/title', seq: 4, time: time + 4, data: {
              title: fixture.title, messageSeqs: [], source: { kind: 'user' },
            } },
          ]);
          await handle.flush();
          const persisted = await handle.read();
          ctx.sessionProjectionCache.coldSnapshot(handle.header, handle.inheritedEventCount, persisted.events);
          const deadline = Date.now() + 15000;
          while (ctx.sessionProjectionCache.cachedSnapshot(handle.header)?.values.title !== fixture.title) {
            assert(Date.now() < deadline, 'Title projection must become durable before the real Web startup');
            await delay(50);
          }
        } finally { await handle.close(); }
      }
    }
    await mount(WorkspaceRegistry);
    if (seed) {
      const primary = await ctx.workspaceRegistry.resolveByPath(paths.primary);
      const secondary = await ctx.workspaceRegistry.resolveByPath(paths.secondary);
      assert(primary && secondary, 'Seeded real headers must bootstrap both workspaces');
      await primary.setTitle(fixtureWorkspaces.primary);
      await secondary.setTitle(fixtureWorkspaces.secondary);
      for (const fixture of fixtures.filter(item => item.archived)) {
        await ctx.workspaceRegistry.archiveSession(SessionId(fixture.id));
      }
    }
    return { ctx, close };
  } catch (error) { await close(); throw error; }
}
