import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { WorkspaceActiveSessionError, WorkspaceUnknownSessionError, workspaceDomainState } from '@deepseek-ai/dsh-workspace';
import { SessionBinError } from './module.js';
import type { NativeBinPort, NativeSessionState } from './module.js';

/** All native actions stay on public SDK methods; cold inspection claims no writer. */
export class DshBinPort implements NativeBinPort {
  constructor(private readonly ctx: Context) {}
  archivedSessionIds(): readonly string[] {
    // Domain events publish the committed global snapshot before the Registry's
    // in-memory projection resumes its await. Read that public snapshot so list
    // and admission share the same durable native member set as the frame.
    const domain = this.ctx.storageDomain.get('workspace');
    if (!domain) throw new Error('Native workspace domain is unavailable.');
    return workspaceDomainState.parse(domain.global.get()).archivedSessionIds;
  }
  async inspect(rawId: string): Promise<NativeSessionState> {
    const id = SessionId(rawId);
    const live = this.ctx.sessions.get(id);
    const persisted = live ? undefined : await this.ctx.sessionPersistence.stat(id);
    return {
      archived: this.archivedSessionIds().includes(id),
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
