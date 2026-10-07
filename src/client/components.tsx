import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Toast,
  IconTrashOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { BinClientState, SessionBinClientModel } from './model.js';
import { NS } from './locales.js';
import styles from './panel.module.css';

export interface BinInjected {
  hooks: { bin: HostObservable<BinClientState> };
  model: SessionBinClientModel;
}
type BinFace = InjectFace<BinInjected>;
type PanelProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & BinFace;
type NoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & BinFace;

export function reasonText(reason: string | null, t: TranslateNS<typeof NS>): string {
  switch (reason) {
    case 'session-active': return t('active');
    case 'session-not-found': return t('missing');
    case 'not-archived': return t('notArchived');
    case 'legacy-pending': return t('legacyPending');
    case 'pending-deletion': return t('pendingDeletion');
    case 'pending-result': case 'pending-operation': return t('pendingResult');
    case 'connection-failed': return t('connectionFailed');
    case 'state-changed': case 'archive-changed': case 'entry-changed': case 'interrupted': return t('stateChanged');
    default: return t('operationFailed');
  }
}

export function BinIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconTrashOutlineRegular size={size} />;
}

export function BinNotice({ useBin, model, t }: NoticeProps) {
  const notice = useBin(state => state.notice);
  if (!notice) return null;
  const text = notice.kind === 'unarchived' ? t('unarchived') : reasonText(notice.reason, t);
  return <Toast key={notice.sequence} text={text} {...(notice.kind === 'failed' ? {} : { tone: 'success' as const })}
    holdMs={notice.kind === 'failed' ? 7000 : 5000} onDone={() => model.dismissNotice()} />;
}

export function BinPanel({ useBin, useSessions, useWorkspaces, model, t }: PanelProps) {
  const state = useBin(snapshot => snapshot);
  const sessions = useSessions(snapshot => snapshot);
  const workspaces = useWorkspaces(snapshot => snapshot.items);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const composing = useRef(false);
  const [workspaceFilter, setWorkspaceFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const ready = state.phase === 'ready';
  const unconfirmed = state.pending.filter(plan => !state.busy.includes(plan.sessionId));
  const legacyPending = unconfirmed.some(plan => plan.schemaVersion === 1);
  const pendingLabel = unconfirmed.every(plan => plan.schemaVersion === 1) ? 'checkResults' : 'checkPending';
  const unnamed = t('unnamed');
  const ungrouped = t('ungrouped');
  const unnamedWorkspace = t('unnamedWorkspace');
  const rows = useMemo(() => state.entries.map(entry => {
    const title = sessions.byId[entry.sessionId as SessionId]?.title || unnamed;
    const workspace = workspaces.find(item => item.sessionIds.includes(entry.sessionId as SessionId));
    return { entry, title, workspaceId: workspace?.workspaceId ?? 'ungrouped', workspaceTitle: workspace ? workspace.title || unnamedWorkspace : ungrouped };
  }), [state.entries, sessions, workspaces, unnamed, ungrouped, unnamedWorkspace]);
  const visible = rows.filter(row => (workspaceFilter === 'all' || row.workspaceId === workspaceFilter)
    && `${row.title} ${row.workspaceTitle}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const targets = rows.filter(row => selected.has(row.entry.entryId));
  const allSelected = visible.length > 0 && visible.every(row => selected.has(row.entry.entryId));
  useEffect(() => {
    const live = new Set(state.entries.map(entry => entry.entryId));
    setSelected(previous => {
      const next = new Set([...previous].filter(id => live.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [state.entries]);
  useEffect(() => {
    if (workspaceFilter !== 'all' && workspaceFilter !== 'ungrouped' && !workspaces.some(row => row.workspaceId === workspaceFilter)) {
      setWorkspaceFilter('all');
    }
  }, [workspaces, workspaceFilter]);
  const toggle = (entryId: string, checked: boolean) => setSelected(previous => {
    const next = new Set(previous);
    if (checked) next.add(entryId); else next.delete(entryId);
    return next;
  });
  const unarchiveSelected = async () => {
    setBatchBusy(true);
    try {
      const outcomes = await model.unarchiveMany(targets.map(row => row.entry));
      const succeeded = new Set(outcomes.filter(item => item.status === 'success').map(item => item.entryId));
      setSelected(previous => new Set([...previous].filter(id => !succeeded.has(id))));
    } finally { setBatchBusy(false); }
  };
  return <section className={styles.panel} aria-label={t('title')}>
    <header className={styles.heading}>
      <div><p className={styles.count}>{t(state.entries.length === 1 ? 'countOne' : 'count', { count: state.entries.length })}</p>
        <h1 className={styles.title}>{t('title')}</h1><p className={styles.description}>{t('description')}</p></div>
      <Button variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={16} />} onClick={() => { void model.refresh(); }}>{t('refresh')}</Button>
    </header>
    <div className={styles.toolbar}>
      <Input className={styles.search!} aria-label={t('search')} placeholder={t('search')} value={draft}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={event => { composing.current = false; setQuery(event.currentTarget.value); }}
        onChange={event => { setDraft(event.currentTarget.value); if (!composing.current) setQuery(event.currentTarget.value); }}
        onKeyDown={event => { if (event.key === 'Escape' && !composing.current && !event.nativeEvent.isComposing) { setDraft(''); setQuery(''); } }} />
      <select className={styles.filter} aria-label={t('workspace')} value={workspaceFilter} onChange={event => setWorkspaceFilter(event.currentTarget.value)}>
        <option value="all">{t('allWorkspaces')}</option>
        {workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title || unnamedWorkspace}</option>)}
        <option value="ungrouped">{t('ungrouped')}</option>
      </select>
    </div>
    {state.error && <div className={styles.alert} role="alert"><span>{reasonText(state.error, t)}</span>
      <Button size="sm" onClick={() => { void (state.pending.length ? model.checkPending() : model.refresh()); }}>{t(state.pending.length ? pendingLabel : 'retry')}</Button></div>}
    {unconfirmed.length > 0 && !state.error && <div className={styles.alert} role="status"><span>{t(unconfirmed.length === 1 ? 'pendingOne' : 'pending', { count: unconfirmed.length })}</span>
      <Button size="sm" onClick={() => { void model.checkPending(); }}>{t(pendingLabel)}</Button></div>}
    {legacyPending && state.error !== 'legacy-pending' && <p className={styles.description} role="status">{t('legacyPending')}</p>}
    {visible.length > 0 && <Checkbox label={t('selectAll')} checked={allSelected} disabled={!ready || batchBusy} onChange={checked => {
      setSelected(previous => { const next = new Set(previous); for (const row of visible) { if (checked) next.add(row.entry.entryId); else next.delete(row.entry.entryId); } return next; });
    }} />}
    <div className={styles.content}>
      {state.phase === 'loading' && rows.length === 0 ? <div className={styles.empty} role="status">{t('loading')}</div>
        : visible.length === 0 ? <div className={styles.empty}>
          <span className={styles.emptyIcon} aria-hidden="true"><IconTrashOutlineRegular size={32} /></span>
          <p className={styles.emptyTitle}>{t(rows.length === 0 ? 'empty' : 'noMatches')}</p>
          <p className={styles.emptyHint}>{t(rows.length === 0 ? 'emptyHint' : 'noMatchesHint')}</p>
        </div> : <ul className={styles.list} aria-label={t('entries')}>
          {visible.map(({ entry, title, workspaceTitle }) => {
            const disabled = !ready || batchBusy || state.busy.includes(entry.sessionId) || state.pending.some(plan => plan.schemaVersion === 2 && plan.sessionId === entry.sessionId);
            return <li className={styles.row} key={entry.entryId}>
              <Checkbox className={styles.rowCheck} label={t('select', { title })} checked={selected.has(entry.entryId)} disabled={disabled}
                onChange={checked => toggle(entry.entryId, checked)} />
              <div className={styles.rowBody}><div className={styles.rowTitle} title={title}>{title}</div>
                <div className={styles.meta}><span>{workspaceTitle}</span></div></div>
              <Button variant="outline" size="sm" disabled={disabled}
                onClick={() => { void model.unarchive(entry); }}>{t('unarchive')}</Button>
            </li>;
          })}
        </ul>}
    </div>
    {state.results.length > 0 && state.results.some(result => result.status !== 'success') && <ul className={styles.results} aria-label={t('results')} aria-live="polite">
      {state.results.map(result => <li className={styles.result} key={result.sessionId}>
        <span>{sessions.byId[result.sessionId as SessionId]?.title || t('unnamed')}</span>
        <span>{result.status === 'success' ? t('resultSuccess') : reasonText(result.reason, t)}</span></li>)}
    </ul>}
    {targets.length > 0 && <footer className={styles.selection}>
      <span>{t('selected', { count: targets.length })}</span><div className={styles.selectionActions}>
        <Button size="sm" disabled={batchBusy} onClick={() => setSelected(new Set())}>{t('clearSelection')}</Button>
        <Button variant="primary" size="sm" disabled={!ready || batchBusy || state.busy.length > 0} onClick={() => { void unarchiveSelected(); }}>{t('unarchiveSelected')}</Button>
      </div></footer>}
  </section>;
}
