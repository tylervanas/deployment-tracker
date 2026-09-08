function resolveBranch(config, selectedBranch) {
  const selected = stripRef(selectedBranch || config.defaultBranch || '');
  const fallback = stripRef(config.defaultBranch || '');
  const selectedRelease = selected.match(/^release\/release-(?:ag|iam)-(.+)$/i);
  const fallbackRelease = fallback.match(/^(release\/release-(ag|iam)-).+$/i);
  if (selectedRelease && fallbackRelease) {
    return `${fallbackRelease[1]}${selectedRelease[1]}`;
  }
  return selected;
}

function resolveQueueTarget(config, lifecycle, region, scope) {
  const normalizedLifecycle = normalizeLifecycle(lifecycle);
  if (!normalizedLifecycle) return null;
  if (
    Array.isArray(config.applicableLifecycles) &&
    !config.applicableLifecycles.includes(normalizedLifecycle)
  ) {
    return { applicable: false };
  }

  const targetKey = scope === 'Regional' && normalizedLifecycle === 'Production'
    ? `Production:${String(region || '').toUpperCase()}`
    : normalizedLifecycle;
  if (targetKey === 'Production:') return null;

  const environmentIds = arrayValue(
    config.environmentMappings?.[targetKey] ?? config.environmentMappings?.[normalizedLifecycle]
  ).map(Number).filter(Number.isFinite);
  const environments = environmentIds.map((id) =>
    (config.environments || []).find((environment) => Number(environment.id) === id)
  ).filter(Boolean);

  const targetValue = config.targetMappings?.[targetKey] ?? config.targetMappings?.[normalizedLifecycle];
  const parameters = { ...(config.parameters || {}) };
  const templateParameters = { ...(config.templateParameters || {}) };
  if (config.targetParameter) {
    if (!targetValue) return null;
    const target = config.targetParameter.location === 'parameters' ? parameters : templateParameters;
    target[config.targetParameter.name] = targetValue;
  }

  if (['build-release', 'package-release'].includes(config.type) && !environments.length) {
    return null;
  }

  return {
    applicable: true,
    lifecycle: normalizedLifecycle,
    targetKey,
    targetValue: targetValue || null,
    environmentIds,
    environments,
    parameters,
    templateParameters
  };
}

function aggregateReleaseRuns(runs) {
  if (!runs.length) return { status: 'error', message: 'No release environments were created.' };
  const statuses = runs.map((run) => run.status);
  if (statuses.includes('failed') || statuses.includes('error')) {
    return { status: 'failed', message: 'One or more release environments failed.' };
  }
  if (statuses.includes('awaitingApproval')) {
    return { status: 'awaitingApproval', message: 'One or more release environments await approval.' };
  }
  if (statuses.includes('running')) {
    return { status: 'running', message: 'Release environments are in progress.' };
  }
  if (statuses.includes('queued')) {
    return { status: 'queued', message: 'Release environments are queued.' };
  }
  if (statuses.includes('warning')) {
    return { status: 'warning', message: 'Release environments completed with warnings.' };
  }
  return { status: 'succeeded', message: null };
}

function normalizeLifecycle(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return {
    dev: 'Dev',
    qa: 'QA',
    release: 'Release',
    staging: 'Staging',
    demo: 'Demo',
    prod: 'Production',
    production: 'Production'
  }[normalized] || null;
}

function stripRef(value) {
  return String(value || '').replace(/^refs\/heads\//, '');
}

function arrayValue(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = {
  resolveBranch,
  resolveQueueTarget,
  aggregateReleaseRuns,
  normalizeLifecycle
};
