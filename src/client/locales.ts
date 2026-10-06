import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots';
export const NS = 'dshSessionBin';
export const en = {
  title: 'Session Bin', count: '{count} conversations', description: 'Keep conversations out of the way and restore them when needed.',
  bin: 'Move to Session Bin', restore: 'Restore', restoreSelected: 'Restore selected', undo: 'Undo', refresh: 'Refresh',
  search: 'Search Session Bin', workspace: 'Workspace filter', allWorkspaces: 'All workspaces', ungrouped: 'Ungrouped',
  unnamed: 'Untitled conversation', loading: 'Loading Session Bin…', empty: 'Session Bin is empty',
  emptyHint: 'Use a conversation’s menu to move it here. Native archives stay in their original view.',
  noMatches: 'No matching conversations', noMatchesHint: 'Try another search or workspace.',
  select: 'Select {title}', selectAll: 'Select visible conversations', selected: '{count} selected', clearSelection: 'Clear selection',
  entries: 'Conversations in Session Bin', originalArchive: 'Originally archived', originalArchiveHint: 'Restoring keeps this conversation archived.',
  moved: 'Conversation moved to Session Bin', restored: 'Conversation restored', restoredArchived: 'Removed from Session Bin; the original archive is preserved.',
  resultSuccess: 'Restored', resultRejected: 'Skipped', resultConflict: 'State changed', resultPending: 'Awaiting confirmation',
  results: 'Latest operation results', pending: '{count} operation results need confirmation.', checkPending: 'Check and retry',
  connectionFailed: 'Session Bin could not connect. Refresh to try again.', pendingResult: 'The operation result is not confirmed yet. Check it before trying another action.',
  active: 'This conversation has running work. Try again after it finishes.', stateChanged: 'The conversation changed. Refresh and choose it again.',
  missing: 'This conversation is no longer available.', alreadyInBin: 'This conversation is already in Session Bin.',
  notInBin: 'This conversation is no longer in Session Bin.', operationFailed: 'The operation could not finish. Refresh and try again.',
  retry: 'Try again',
} as const;
export type BinLocaleKey = keyof typeof en;
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshSessionBin: BinLocaleKey }
}
export const zh: LocaleDictOf<typeof NS> = {
  title: '会话回收站', count: '{count} 个会话', description: '暂时收起会话，需要时再恢复。',
  bin: '移入回收站', restore: '恢复', restoreSelected: '恢复所选', undo: '撤销', refresh: '刷新',
  search: '搜索回收站', workspace: '工作区筛选', allWorkspaces: '所有工作区', ungrouped: '未分组',
  unnamed: '未命名会话', loading: '正在加载回收站…', empty: '回收站是空的',
  emptyHint: '通过会话菜单移入回收站。原生归档仍在原来的视图中。',
  noMatches: '没有匹配的会话', noMatchesHint: '试试其他关键词或工作区。',
  select: '选择 {title}', selectAll: '选择当前显示的会话', selected: '已选 {count} 项', clearSelection: '取消选择',
  entries: '回收站中的会话', originalArchive: '原先已归档', originalArchiveHint: '恢复后会保留这个会话的归档状态。',
  moved: '会话已移入回收站', restored: '会话已恢复', restoredArchived: '已移出回收站，保留原来的归档状态。',
  resultSuccess: '已恢复', resultRejected: '已跳过', resultConflict: '状态已变化', resultPending: '等待确认',
  results: '最近的操作结果', pending: '有 {count} 项操作结果待确认。', checkPending: '检查并重试',
  connectionFailed: '暂时无法连接回收站，请刷新重试。', pendingResult: '操作结果尚未确认，请先检查，再进行其他操作。',
  active: '这个会话仍有任务运行，请在任务结束后重试。', stateChanged: '会话状态已变化，请刷新后重新选择。',
  missing: '这个会话已不可用。', alreadyInBin: '这个会话已经在回收站中。',
  notInBin: '这个会话已不在回收站中。', operationFailed: '操作未能完成，请刷新后重试。',
  retry: '重试',
};
