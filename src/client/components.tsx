import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Toast, Modal,
  IconTrashOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { BinClientState, PurgeBatchItem, PurgeBatchState, SessionBinClientModel } from './model.js';
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
    case 'purge-cache-capacity': return t('purgeCacheCapacity');
    case 'deletion-pending': case 'owner-incomplete': case 'retirement-owner-unavailable': return t('deletionPending');
    case 'deletion-result-missing': return t('deletionMissing');
    case 'partial-failure': case 'resource-failure': return t('deletionPartial');
    case 'permanent-deletion-unsupported': return t('deletionUnsupported');
    case 'native/session-live': return t('deletionLive');
    case 'native/persistence-retained': case 'native/query-retained': case 'native/follow-retained':
    case 'native/unknown-follow': case 'native/cache-dirty': return t('deletionRetained');
    case 'jsonl/writer-active': return t('deletionWriter');
    case 'native/subagent-unsupported': return t('deletionSubagent');
    case 'lifecycle-changed': case 'resource-scope-changed': case 'jsonl/resource-changed':
    case 'jsonl/scope-changed': case 'native/composition-changed': return t('deletionChanged');
    case 'native/session-retired': return t('missing');
    case 'state-changed': case 'archive-changed': case 'entry-changed': case 'interrupted': return t('stateChanged');
    default: return reason?.startsWith('jsonl/') || reason?.startsWith('native/') ? t('deletionProtected') : t('operationFailed');
  }
}

export function BinIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconTrashOutlineRegular size={size} />;
}

function batchCounts(batch: PurgeBatchState) {
  const executable = batch.items.filter(item => item.plan && item.plan.binding && item.plan.manifest && item.plan.blockers.length === 0).length;
  const blocked = batch.items.filter(item => item.state === 'blocked').length;
  const prepared = batch.items.filter(item => item.state !== 'preparing').length;
  const completed = batch.items.filter(item => item.state === 'settled' && item.outcome?.status === 'success').length;
  const unresolved = Math.max(0, batch.frozenCount - completed);
  return { executable, blocked, prepared, completed, unresolved };
}

function batchItemText(item: PurgeBatchItem, t: TranslateNS<typeof NS>): string {
  if (item.state === 'preparing') return t('batchItemPreparing');
  if (item.state === 'ready') return t('batchItemReady');
  if (item.state === 'running') return t('batchItemRunning');
  if (item.state === 'cancelled') return t('batchItemCancelled');
  if (item.state === 'blocked') return t('batchItemBlocked', { reason: reasonText(item.reason, t) });
  if (item.outcome?.status === 'success') return t('batchItemDeleted');
  return reasonText(item.outcome?.reason ?? item.reason, t);
}

function PurgeBatchDetails({ batch, t }: { batch: PurgeBatchState; t: TranslateNS<typeof NS> }) {
  const counts = batchCounts(batch);
  return <>
    {batch.phase === 'preparing' && <p className={styles.batchProgress} role="status">{t('batchPreparationProgress', {
      prepared: counts.prepared, total: batch.frozenCount,
    })}</p>}
    <p className={styles.batchSummary}>{t('batchSummary', {
      total: batch.frozenCount, executable: counts.executable, blocked: counts.blocked,
    })}</p>
    <p className={styles.description}>{t('batchScope')}</p>
    <dl className={styles.resourceCounts} aria-label={t('batchResources')}>
      <div><dt>{t('resourceErase')}</dt><dd>{batch.resourceCounts.erase}</dd></div>
      <div><dt>{t('resourceReleaseReference')}</dt><dd>{batch.resourceCounts.releaseReference}</dd></div>
      <div><dt>{t('resourceRetainShared')}</dt><dd>{batch.resourceCounts.retainShared}</dd></div>
      <div><dt>{t('resourceRetainCoordination')}</dt><dd>{batch.resourceCounts.retainCoordination}</dd></div>
    </dl>
    <p className={styles.description}>{t('batchRetainedCopies')}</p>
    <ul className={styles.batchItems} aria-label={t('batchItems')}>
      {batch.items.map((item, index) => <li key={`${item.target.entryId}-${index}`}>
        <span className={styles.batchItemTitle}>{item.target.title}</span>
        <span className={styles.batchItemStatus}>{batchItemText(item, t)}</span>
      </li>)}
    </ul>
  </>;
}

export function BinNotice({ useBin, model, t }: NoticeProps) {
  const state = useBin(snapshot => snapshot);
  const notice = state.notice;
  const confirmation = state.purgeConfirmation;
  const batch = state.purgeBatch ?? null;
  const batchModal = !confirmation && batch && ['preparing', 'confirming', 'running'].includes(batch.phase) ? batch : null;
  const blocked = confirmation && (confirmation.plan.blockers.length > 0 || !confirmation.plan.binding || !confirmation.plan.manifest);
  const text = notice?.kind === 'unarchived' ? t('unarchived') : notice?.kind === 'deleted' ? t('deleted') : reasonText(notice?.reason ?? null, t);
  return <>
    {notice && <Toast key={notice.sequence} text={text} {...(notice.kind === 'failed' ? {} : { tone: 'success' as const })}
      holdMs={notice.kind === 'failed' ? 7000 : 5000} onDone={() => model.dismissNotice()} />}
    {confirmation && <Modal open title={t('deleteTitle', { title: confirmation.title })} closeLabel={t('closeDeletion')}
      description={t('deleteDescription')} onClose={() => model.cancelPurge()}
      footer={<>
        <Button variant="outline" data-modal-autofocus onClick={() => model.cancelPurge()}>{t('cancelDeletion')}</Button>
        <Button variant="outline" style={{ color: 'var(--dsw-alias-state-error-primary)' }}
          disabled={Boolean(blocked) || !confirmation.acknowledged || state.phase !== 'ready' || Boolean(state.purgeCacheBlocked)}
          onClick={() => { void model.confirmPurge(); }}>{t('confirmDeletion')}</Button>
      </>}>
      <p className={styles.description}>{t('deleteScope')}</p>
      {confirmation.plan.blockers.length > 0 && <ul aria-label={t('deletionBlockers')} role="alert">
        {confirmation.plan.blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`}>{reasonText(blocker.code, t)}</li>)}
      </ul>}
      <Checkbox label={t('deletionAcknowledge')} checked={confirmation.acknowledged}
        disabled={Boolean(blocked) || Boolean(state.purgeCacheBlocked)}
        onChange={checked => model.acknowledgePurge(checked)} />
    </Modal>}
    {batchModal && <Modal open
      title={t(batchModal.scope === 'selection' ? 'batchSelectionTitle' : 'batchAllTitle', { count: batchModal.frozenCount })}
      closeLabel={t('closeBatchDeletion')} description={t(batchModal.phase === 'preparing' ? 'batchPreparingDescription'
        : batchModal.phase === 'running' ? 'batchRunningDescription' : 'batchConfirmDescription')}
      onClose={() => model.stopPurgeBatch()}
      footer={batchModal.phase === 'confirming' ? <>
        <Button variant="outline" data-modal-autofocus onClick={() => model.stopPurgeBatch()}>{t('cancelDeletion')}</Button>
        <Button variant="outline" style={{ color: 'var(--dsw-alias-state-error-primary)' }}
          disabled={!batchModal.acknowledged || batchCounts(batchModal).executable === 0 || state.phase !== 'ready' || Boolean(state.purgeCacheBlocked)}
          onClick={() => { void model.runPurgeBatch(); }}>{t('confirmBatchDeletion')}</Button>
      </> : <Button variant="outline" data-modal-autofocus
        onClick={() => model.stopPurgeBatch()}>{t(batchModal.phase === 'running' ? 'stopBatchDeletion' : 'cancelDeletion')}</Button>}>
      <div className={styles.batchModalBody}>
        <PurgeBatchDetails batch={batchModal} t={t} />
        {batchModal.phase === 'confirming' && <Checkbox label={t('batchAcknowledge')} checked={batchModal.acknowledged}
          disabled={batchCounts(batchModal).executable === 0 || Boolean(state.purgeCacheBlocked)}
          onChange={checked => model.acknowledgePurgeBatch(checked)} />}
      </div>
    </Modal>}
  </>;
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
  const purgePending = state.purgePending ?? [];
  const purgeResults = state.purgeResults ?? [];
  const purgeBatch = state.purgeBatch ?? null;
  const purgeCacheBlocked = state.purgeCacheBlocked ?? false;
  const activePurgeBatch = Boolean(purgeBatch && ['preparing', 'confirming', 'running', 'paused'].includes(purgeBatch.phase));
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
    const succeeded = new Set((purgeBatch?.items ?? [])
      .filter(item => item.state === 'settled' && item.outcome?.status === 'success')
      .map(item => item.target.entryId));
    if (!succeeded.size) return;
    setSelected(previous => {
      const next = new Set([...previous].filter(id => !succeeded.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [purgeBatch]);
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
  const titlesBySessionId = () => Object.fromEntries(rows.map(row => [row.entry.sessionId, row.title]));
  const prepareSelectedPurge = () => model.preparePurgeBatch(
    { kind: 'selection', entryIds: targets.map(row => row.entry.entryId) }, titlesBySessionId());
  const prepareAllPurge = () => model.preparePurgeBatch({ kind: 'all-archived' }, titlesBySessionId());
  const newPurgeDisabled = !ready || activePurgeBatch || purgeCacheBlocked || Boolean(state.purgeConfirmation)
    || purgePending.length > 0 || state.busy.length > 0;
  return <section className={styles.panel} aria-label={t('title')}>
    <header className={styles.heading}>
      <div><p className={styles.count}>{t(state.entries.length === 1 ? 'countOne' : 'count', { count: state.entries.length })}</p>
        <h1 className={styles.title}>{t('title')}</h1><p className={styles.description}>{t('description')}</p></div>
      <div className={styles.headingActions}>
        <Button variant="outline" size="sm" disabled={newPurgeDisabled || state.entries.length === 0}
          onClick={() => { void prepareAllPurge(); }}>{t('clearAllArchived', { count: state.entries.length })}</Button>
        <Button variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={16} />} disabled={activePurgeBatch}
          onClick={() => { void model.refresh(); }}>{t('refresh')}</Button>
      </div>
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
      {(state.error !== 'purge-cache-capacity' || purgePending.length > 0) && <Button size="sm" onClick={() => { void (purgePending.length ? model.checkPurgePending() : state.pending.length ? model.checkPending() : model.refresh()); }}>{t(purgePending.length ? 'checkDeletion' : state.pending.length ? pendingLabel : 'retry')}</Button>}</div>}
    {unconfirmed.length > 0 && !state.error && <div className={styles.alert} role="status"><span>{t(unconfirmed.length === 1 ? 'pendingOne' : 'pending', { count: unconfirmed.length })}</span>
      <Button size="sm" onClick={() => { void model.checkPending(); }}>{t(pendingLabel)}</Button></div>}
    {purgePending.map(plan => {
      const title = sessions.byId[plan.sessionId as SessionId]?.title || unnamed;
      const result = purgeResults.find(row => row.operationId === plan.operationId);
      const missing = result?.reason === 'deletion-result-missing';
      const belongsToBatch = (state.purgeBatchOperationIds ?? []).includes(plan.operationId)
        || (purgeBatch?.items.some(item => item.plan?.operationId === plan.operationId) ?? false);
      return <div className={styles.alert} role="status" key={plan.operationId}>
        <span>{title}: {reasonText(result?.reason ?? 'deletion-pending', t)}</span>
        <Button size="sm" disabled={!ready} onClick={() => { void (missing ? model.preparePurgeAgain(plan.operationId, title) : model.retryPurge(plan.operationId)); }}>
          {t(missing ? 'prepareDeletionAgain' : 'continueDeletion')}
        </Button>
        {missing && !belongsToBatch && <Button size="sm" variant="ghost" disabled={!ready} onClick={() => { void model.discardMissingPurge(plan.operationId); }}>{t('discardMissingDeletion')}</Button>}
      </div>;
    })}
    {legacyPending && state.error !== 'legacy-pending' && <p className={styles.description} role="status">{t('legacyPending')}</p>}
    {visible.length > 0 && <Checkbox label={t('selectAll')} checked={allSelected} disabled={!ready || batchBusy || activePurgeBatch} onChange={checked => {
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
            const disabled = !ready || batchBusy || activePurgeBatch || state.busy.includes(entry.sessionId) || Boolean(state.purgeConfirmation)
              || purgePending.some(plan => plan.sessionId === entry.sessionId)
              || state.pending.some(plan => plan.schemaVersion === 2 && plan.sessionId === entry.sessionId);
            return <li className={styles.row} key={entry.entryId}>
              <Checkbox className={styles.rowCheck} label={t('select', { title })} checked={selected.has(entry.entryId)} disabled={disabled}
                onChange={checked => toggle(entry.entryId, checked)} />
              <div className={styles.rowBody}><div className={styles.rowTitle} title={title}>{title}</div>
                <div className={styles.meta}><span>{workspaceTitle}</span></div></div>
              <Button variant="outline" size="sm" disabled={disabled}
                onClick={() => { void model.unarchive(entry); }}>{t('unarchive')}</Button>
              <Button variant="ghost" size="sm" disabled={disabled || purgeCacheBlocked} aria-label={t('deleteConversation', { title })}
                onClick={() => { void model.preparePurge(entry, title); }}>{t('permanentDelete')}</Button>
            </li>;
          })}
        </ul>}
    </div>
    {state.results.length > 0 && state.results.some(result => result.status !== 'success') && <ul className={styles.results} aria-label={t('results')} aria-live="polite">
      {state.results.map(result => <li className={styles.result} key={result.sessionId}>
        <span>{sessions.byId[result.sessionId as SessionId]?.title || t('unnamed')}</span>
        <span>{result.status === 'success' ? t('resultSuccess') : reasonText(result.reason, t)}</span></li>)}
    </ul>}
    {purgeResults.length > 0 && purgeResults.some(result => result.status !== 'success') && <ul className={styles.results} aria-label={t('deletionResults')} aria-live="polite">
      {purgeResults.map(result => <li className={styles.result} key={result.operationId}>
        <span>{sessions.byId[result.sessionId as SessionId]?.title || unnamed}</span>
        <span>{result.status === 'success' ? t('deleted') : result.status === 'partial-failure' ? t('deletionPartial') : reasonText(result.reason, t)}</span>
      </li>)}
    </ul>}
    {purgeBatch && ['paused', 'done', 'cancelled'].includes(purgeBatch.phase) && <section className={styles.batchStatus}
      aria-label={t('batchStatus')} aria-live="polite">
      <h2>{t(purgeBatch.phase === 'paused' ? 'batchPausedTitle' : purgeBatch.phase === 'done' ? 'batchDoneTitle' : 'batchCancelledTitle')}</h2>
      {purgeBatch.phase === 'paused' && <p className={styles.description}>{t('batchPausedDescription')}</p>}
      <PurgeBatchDetails batch={purgeBatch} t={t} />
      <p className={styles.batchOutcome}>{t('batchOutcome', {
        success: batchCounts(purgeBatch).completed, unresolved: batchCounts(purgeBatch).unresolved,
      })}</p>
      <div className={styles.batchActions}>
        {purgeBatch.phase === 'paused' ? <>
          <Button size="sm" disabled={!ready || purgeCacheBlocked || purgePending.length > 0 || purgeBatch.stopRequested}
            onClick={() => { void model.runPurgeBatch(); }}>{t('continueBatchDeletion')}</Button>
          <Button variant="outline" size="sm" onClick={() => model.stopPurgeBatch()}>{t('stopBatchDeletion')}</Button>
        </> : <Button size="sm" onClick={() => model.dismissPurgeBatch?.()}>{t('dismissBatchDeletion')}</Button>}
      </div>
    </section>}
    {targets.length > 0 && <footer className={styles.selection}>
      <span>{t('selected', { count: targets.length })}</span><div className={styles.selectionActions}>
        <Button size="sm" disabled={batchBusy || activePurgeBatch} onClick={() => setSelected(new Set())}>{t('clearSelection')}</Button>
        <Button variant="outline" size="sm" disabled={newPurgeDisabled}
          onClick={() => { void prepareSelectedPurge(); }}>{t('permanentlyDeleteSelected')}</Button>
        <Button variant="primary" size="sm" disabled={!ready || batchBusy || activePurgeBatch || state.busy.length > 0} onClick={() => { void unarchiveSelected(); }}>{t('unarchiveSelected')}</Button>
      </div></footer>}
  </section>;
}
