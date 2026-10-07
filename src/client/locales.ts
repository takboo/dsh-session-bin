import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots';
export const NS = 'dshSessionBin';
export const en = {
  title: 'Session Bin', count: '{count} conversations', countOne: '{count} conversation', description: 'Manage Harness native archives with search, filters, and batch unarchive.',
  unarchive: 'Unarchive', unarchiveSelected: 'Unarchive selected', refresh: 'Refresh',
  search: 'Search archives', workspace: 'Workspace filter', allWorkspaces: 'All workspaces', ungrouped: 'Ungrouped', unnamedWorkspace: 'Untitled workspace',
  unnamed: 'Untitled conversation', loading: 'Loading archives…', empty: 'No archived conversations',
  emptyHint: 'Use Archive in the conversation menu to collect conversations here.',
  noMatches: 'No matching conversations', noMatchesHint: 'Try another search or workspace.',
  select: 'Select {title}', selectAll: 'Select visible conversations', selected: '{count} selected', clearSelection: 'Clear selection',
  entries: 'Archived conversations', unarchived: 'Conversation unarchived',
  resultSuccess: 'Unarchived', resultRejected: 'Skipped', resultConflict: 'State changed', resultPending: 'Awaiting confirmation',
  results: 'Latest operation results', pending: '{count} operation results need confirmation.', pendingOne: '{count} operation result needs confirmation.', checkPending: 'Check and retry', checkResults: 'Check results',
  connectionFailed: 'Session Bin could not connect. Refresh to try again.', pendingResult: 'The operation result is not confirmed yet. Check it before trying another action.',
  pendingDeletion: 'Permanent deletion needs recovery before this conversation can be unarchived.',
  legacyPending: 'An earlier Bin operation is awaiting a receipt. Checking only queries its result; it will not be replayed.',
  active: 'This conversation has running work. Try again after it finishes.', stateChanged: 'The conversation changed. Refresh and choose it again.',
  missing: 'This conversation is no longer available.', notArchived: 'This conversation is no longer archived.', operationFailed: 'The operation could not finish. Refresh and try again.',
  retry: 'Try again',
} as const;
export type BinLocaleKey = keyof typeof en;
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshSessionBin: BinLocaleKey }
}
export const zh: LocaleDictOf<typeof NS> = {
  title: '会话回收站', count: '{count} 个会话', countOne: '{count} 个会话', description: '直接管理 Harness 原生归档，支持搜索、筛选与批量取消归档。',
  unarchive: '取消归档', unarchiveSelected: '取消归档所选', refresh: '刷新',
  search: '搜索归档', workspace: '工作区筛选', allWorkspaces: '所有工作区', ungrouped: '未分组', unnamedWorkspace: '未命名工作区',
  unnamed: '未命名会话', loading: '正在加载归档…', empty: '没有已归档的会话',
  emptyHint: '通过会话菜单中的原生归档将会话收起。',
  noMatches: '没有匹配的会话', noMatchesHint: '试试其他关键词或工作区。',
  select: '选择 {title}', selectAll: '选择当前显示的会话', selected: '已选 {count} 项', clearSelection: '取消选择',
  entries: '已归档的会话', unarchived: '会话已取消归档',
  resultSuccess: '已取消归档', resultRejected: '已跳过', resultConflict: '状态已变化', resultPending: '等待确认',
  results: '最近的操作结果', pending: '有 {count} 项操作结果待确认。', pendingOne: '有 {count} 项操作结果待确认。', checkPending: '检查并重试', checkResults: '检查结果',
  connectionFailed: '暂时无法连接回收站，请刷新重试。', pendingResult: '操作结果尚未确认，请先检查，再进行其他操作。',
  pendingDeletion: '永久删除尚待恢复，暂时无法取消归档。',
  legacyPending: '旧版回收站操作仍在等待回执。检查只查询结果，不会重新执行旧操作。',
  active: '这个会话仍有任务运行，请在任务结束后重试。', stateChanged: '会话状态已变化，请刷新后重新选择。',
  missing: '这个会话已不可用。', notArchived: '这个会话已不再归档。', operationFailed: '操作未能完成，请刷新后重试。',
  retry: '重试',
};
