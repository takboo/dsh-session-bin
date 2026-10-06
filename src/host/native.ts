import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { WorkspaceActiveSessionError, WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace';
import { SessionBinError } from './module.js';
import type { NativeBinPort, NativeSessionState } from './module.js';

/** All native actions stay on public SDK methods; cold inspection claims no writer. */
export class DshBinPort implements NativeBinPort {
  constructor(private readonly ctx: Context) {}
  async inspect(rawId: string): Promise<NativeSessionState> {
    const id = SessionId(rawId);
    const live = this.ctx.sessions.get(id);
    const persisted = live ? undefined : await this.ctx.sessionPersistence.stat(id);
    return {
      archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(id),
      known: live !== undefined || persisted !== undefined,
      workspaceId: this.ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(id))?.id ?? null,
    };
  }
  async activity(rawId: string): Promise<string[]> {
    const activity = await this.ctx.waterfall('workspace/session-activity',
      { sessionId: SessionId(rawId) }, async () => []);
    return activity.map(item => String(item.kind));
  }
  async archive(rawId: string): Promise<void> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(SessionId(rawId));
    } catch (cause) {
      if (cause instanceof WorkspaceActiveSessionError) {
        throw new SessionBinError('session-active', cause.message, { cause });
      }
      if (cause instanceof WorkspaceUnknownSessionError) {
        throw new SessionBinError('session-not-found', cause.message, { cause });
      }
      throw cause;
    }
  }
  unarchive(rawId: string): Promise<void> {
    return this.ctx.workspaceRegistry.unarchiveSession(SessionId(rawId));
  }
}
