import { compareVersions, digest, previousReports } from './common.mjs';
export { validComponents } from './common.mjs';

// Bump only when a component's evidence contract requires a fresh run.
export function componentIdentities(target) {
  return { sdk: digest({ contract: 1, version: target.version, npm: target.npm }),
    desktop: target.desktop ? digest({ contract: 1, version: target.version, desktop: target.desktop, npm: target.npm }) : null };
}
export function componentDue(previous, identity, { manual = false, now = Date.now() } = {}) {
  if (!identity) return false;
  if (manual || previous?.identity !== identity) return true;
  return ['retry', 'running'].includes(previous.status) && previous.attempts < 3
    && now - Date.parse(previous.updatedAt) >= 6 * 3600000;
}
export function selectChecks(targets, issues, { baseline, manual = '', now = Date.now(), pullRequest = false } = {}) {
  const previous = previousReports(issues);
  return targets.filter(t => manual ? t.version === manual : compareVersions(t.version, baseline) > 0)
    .map(target => {
      const old = previous.get(target.version);
      const identities = componentIdentities(target);
      const components = old?.components ?? {};
      const runSdk = componentDue(components.sdk, identities.sdk, { manual: Boolean(manual) || pullRequest, now });
      const runDesktop = componentDue(components.desktop, identities.desktop, { manual: Boolean(manual) || pullRequest, now });
      return { ...target, issue: old?.issue ?? 0, attempts: old?.identity === target.identity ? old.attempts : 0,
        identities, runSdk, runDesktop, previousComponents: components,
        metadataOnly: !runSdk && !runDesktop && old?.identity !== target.identity };
    }).filter(t => t.runSdk || t.runDesktop || t.metadataOnly)
    .sort((a, b) => compareVersions(a.version, b.version)).slice(0, 3);
}
export function plannedComponents(target, previous, { run, sourceCommit, now = new Date().toISOString() }) {
  const components = structuredClone(previous ?? {});
  for (const key of ['sdk', 'desktop']) if (target[key === 'sdk' ? 'runSdk' : 'runDesktop']) {
    const old = components[key];
    components[key] = { identity: target.identities[key], status: 'running',
      attempts: old?.identity === target.identities[key] ? old.attempts + (old.run === run ? 0 : 1) : 1, run, sourceCommit, updatedAt: now };
  }
  return components;
}
