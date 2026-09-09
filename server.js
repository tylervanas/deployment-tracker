const express = require('express');
const path = require('path');
const store = require('./lib/store');
const {
  parsePipelineUrl,
  fetchRunStatus,
  inspectRunConfiguration,
  fetchRepositoryBranches,
  fetchDefinitionBranches,
  fetchRecentBuildConfigurations,
  fetchReleaseSummary,
  findLatestReleaseForBranch,
  findReleaseForPackageVersion,
  findReleaseForBuildId,
  fetchReleaseApprovalGates,
  fetchBuildApprovalHistory,
  fetchCurrentBuildApprovers,
  deployExistingReleaseEnvironment,
  queueBuild,
  createReleaseAndDeploy,
  findPackageVersion,
  fetchPackageVersions,
  createPackageReleaseAndDeploy
} = require('./lib/ado');
const {
  extractUrlsOnly,
  findServiceMatch,
  getUrlIdentity,
  countUrlOccurrences,
  uniqueUrlEntries,
  findExistingAssignments,
  normalizeName
} = require('./lib/importer');
const { resolveBranch, resolveQueueTarget, aggregateReleaseRuns } = require('./lib/queue');

const app = express();
// Fixed so the browser-stored PAT (scoped to this origin) survives every restart.
const PORT = 4173;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Note: the PAT is never written to disk. The browser holds it (localStorage)
// and sends it per-request; the server only ever keeps it in memory for the
// duration of a single request while calling Azure DevOps.

app.get('/api/state', (req, res) => {
  res.json(store.getState());
});

app.post('/api/ado/inspect', async (req, res) => {
  const pipelineUrl = (req.body?.pipelineUrl || '').trim();
  const token = req.body?.token || '';
  if (!pipelineUrl) return res.status(400).json({ error: 'Pipeline URL is required.' });
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  try {
    const parsed = parsePipelineUrl(pipelineUrl);
    res.json(await inspectRunConfiguration({ ...parsed, token }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ado/release-summary', async (req, res) => {
  const { organization, project, releaseId, token } = req.body || {};
  if (!organization || !project || !releaseId || !token) {
    return res.status(400).json({ error: 'Organization, project, releaseId, and PAT are required.' });
  }
  try {
    res.json(await fetchReleaseSummary({ organization, project, releaseId, token }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ado/branches', async (req, res) => {
  const { organization, project, repositoryId, token } = req.body || {};
  if (!organization || !project || !repositoryId || !token) {
    return res.status(400).json({ error: 'Organization, project, repository, and PAT are required.' });
  }
  try {
    res.json(await fetchRepositoryBranches({ organization, project, repositoryId, token }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ado/build-history', async (req, res) => {
  const { organization, project, definitionId, top, token } = req.body || {};
  if (!organization || !project || !definitionId || !token) {
    return res.status(400).json({ error: 'Organization, project, definition, and PAT are required.' });
  }
  try {
    res.json(await fetchRecentBuildConfigurations({
      organization,
      project,
      definitionId,
      top: Number(top) || 25,
      token
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ado/package-version', async (req, res) => {
  const { organization, project, feedId, packageId, packageName, version, token } = req.body || {};
  if (!organization || !project || !feedId || !packageName || !version || !token) {
    return res.status(400).json({ error: 'Feed, package, version, and PAT are required.' });
  }
  try {
    const result = await findPackageVersion({
      organization,
      project,
      feedId,
      packageId,
      packageName,
      version,
      token
    });
    res.json({ exists: Boolean(result), package: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/services/:id/package-versions', async (req, res) => {
  const config = store.getQueueConfig(req.params.id);
  const token = req.body?.token || '';
  if (config?.type !== 'package-release') {
    return res.status(400).json({ error: 'This service is not a package release.' });
  }
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  try {
    res.json(await fetchPackageVersions({
      organization: config.organization,
      project: config.project,
      feedId: config.feedId,
      packageId: config.packageId,
      token
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/deployment/name', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Deployment name is required.' });
  res.json(store.renameDeployment(name));
});

app.post('/api/deployments', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Deployment name is required.' });
  const nextState = store.createDeployment(name, req.body?.saveChanges === true);
  if (!nextState) {
    return res.status(409).json({
      error: 'This saved deployment has changes. Confirm saving them before starting a new deployment.'
    });
  }
  res.json(nextState);
});

app.post('/api/deployments/:id/activate', (req, res) => {
  const nextState = store.activateDeployment(req.params.id);
  if (!nextState) return res.status(404).json({ error: 'Deployment not found.' });
  res.json(nextState);
});

app.post('/api/clear', (req, res) => {
  store.clearAll();
  res.json(store.getState());
});

app.post('/api/services', (req, res) => {
  const { group, name } = req.body || {};
  if (!group || !name) {
    return res.status(400).json({ error: 'group and name are required' });
  }
  const svc = store.addService(group, name);
  res.json(svc);
});

app.delete('/api/services/:id', (req, res) => {
  const ok = store.removeService(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/services/:id/name', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Service name is required.' });
  const svc = store.renameService(req.params.id, name);
  if (!svc) return res.status(404).json({ error: 'not found' });
  res.json(svc);
});

app.post('/api/services/reorder', (req, res) => {
  const group = (req.body?.group || '').trim();
  const orderedIds = req.body?.orderedIds;
  if (!group || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'Group and ordered service IDs are required.' });
  }
  const services = store.reorderServices(group, orderedIds);
  if (!services) return res.status(404).json({ error: 'Group not found.' });
  res.json(store.getState());
});

app.post('/api/groups/layout', (req, res) => {
  const groups = req.body?.groups;
  if (
    !Array.isArray(groups) ||
    groups.some((group) => !group?.name?.trim() || !Array.isArray(group.serviceIds))
  ) {
    return res.status(400).json({ error: 'A complete group layout is required.' });
  }
  const nextState = store.setActiveGroupLayout(groups);
  if (!nextState) {
    return res.status(400).json({ error: 'The layout must include every active service exactly once.' });
  }
  res.json(nextState);
});

app.post('/api/services/:id/queue-config', (req, res) => {
  const config = req.body?.config;
  const validBuild = config?.buildDefinitionId;
  const validPackage = config?.type === 'package-release' && config?.releaseDefinitionId && config?.feedId;
  if (!config?.organization || !config?.project || (!validBuild && !validPackage)) {
    return res.status(400).json({ error: 'A valid queue configuration is required.' });
  }
  const saved = store.setQueueConfig(req.params.id, config);
  if (!saved) return res.status(404).json({ error: 'not found' });
  res.json(saved);
});

app.post('/api/services/:id/branches', async (req, res) => {
  const config = store.getQueueConfig(req.params.id);
  const token = req.body?.token || '';
  if (!config) return res.status(400).json({ error: 'This service is not configured for queueing.' });
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  try {
    res.json(await fetchDefinitionBranches({
      organization: config.organization,
      project: config.project,
      definitionId: config.buildDefinitionId,
      token
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/services/:id/latest-release', async (req, res) => {
  const config = store.getQueueConfig(req.params.id);
  const token = req.body?.token || '';
  const selectedBranch = (req.body?.branch || '').trim();
  if (!config) return res.status(400).json({ error: 'This service is not configured for queueing.' });
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  if (!selectedBranch) return res.status(400).json({ error: 'Select a branch.' });
  if (config.type !== 'build-release') return res.json({ supported: false });

  const branch = resolveBranch(config, selectedBranch);
  try {
    const release = await findLatestReleaseForBranch({
      organization: config.organization,
      project: config.project,
      releaseDefinitionId: config.releaseDefinitionId,
      artifactAlias: config.artifactAlias,
      sourceBranch: branch,
      token
    });
    res.json({
      supported: true,
      branch,
      release,
      buildWebUrl: release?.buildId
        ? `https://dev.azure.com/${config.organization}/${config.project}/_build/results?buildId=${release.buildId}`
        : null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/services/:id/queue', async (req, res) => {
  const currentState = store.getState();
  const deploymentId = currentState.deployment.id;
  const svc = store.findService(req.params.id, deploymentId);
  const config = store.getQueueConfig(req.params.id);
  const token = req.body?.token || '';
  const selectedBranch = (req.body?.branch || '').trim();
  const packageVersion = (req.body?.packageVersion || '').trim();
  const lifecycle = req.body?.lifecycle;
  const region = req.body?.region;
  const forceNewBuild = req.body?.forceNewBuild === true;
  if (!svc) return res.status(404).json({ error: 'not found' });
  if (!config) return res.status(400).json({ error: 'This service is not configured for queueing.' });
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  if (config.type !== 'package-release' && !selectedBranch) {
    return res.status(400).json({ error: 'Select a branch.' });
  }
  const scope = currentState.groups.find((group) =>
    group.services.some((service) => service.id === svc.id)
  )?.name;
  const target = resolveQueueTarget(config, lifecycle, region, scope);
  if (!target || target.applicable === false) {
    return res.status(400).json({ error: `${svc.name} does not support this lifecycle/region selection.` });
  }
  const branch = resolveBranch(config, selectedBranch);

  try {
    if (config.type !== 'package-release' &&
        !(await branchExistsForConfig(config, branch, token, new Map()))) {
      return res.status(400).json({
        error: `Branch "${branch}" was not found in this repository. Nothing was queued.`
      });
    }

    if (config.type === 'package-release') {
      if (!packageVersion) return res.status(400).json({ error: 'Enter a package version.' });
      const packageMatch = await findPackageVersion({
        organization: config.organization,
        project: config.project,
        feedId: config.feedId,
        packageId: config.packageId,
        packageName: config.packageName,
        version: packageVersion,
        token
      });
      if (!packageMatch) {
        return res.status(400).json({
          error: `${config.packageName} version ${packageVersion} was not found. Nothing was deployed.`
        });
      }
      const release = await deployExistingPackageRelease({ config, target, packageVersion: packageMatch.version, token })
        || await createPackageReleaseAndDeploy({
          organization: config.organization,
          project: config.project,
          releaseDefinitionId: config.releaseDefinitionId,
          artifactAlias: config.artifactAlias,
          environmentDefinitionIds: target.environmentIds,
          packageVersion: packageMatch.version,
          token
        });
      const updated = store.updateService(
        svc.id,
        packageReleasePatch(release, config, packageMatch),
        deploymentId
      );
      return res.json(updated);
    }

    if (config.type === 'build-release' && !forceNewBuild) {
      const { patch } = await deployLatestRelease({ config, target, branch, token });
      return res.json(store.updateService(svc.id, patch, deploymentId));
    }

    const queued = await queueBuild({
      organization: config.organization,
      project: config.project,
      definitionId: config.buildDefinitionId,
      sourceBranch: branch,
      parameters: target.parameters,
      templateParameters: target.templateParameters,
      token
    });
    const updated = store.updateService(svc.id, buildQueuePatch(queued, config, target), deploymentId);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Read-only: resolves exactly what a queue would do without calling any Azure write API.
app.post('/api/preview', async (req, res) => {
  const currentState = store.getState();
  const token = req.body?.token || '';
  const selectedBranch = (req.body?.branch || '').trim();
  const lifecycle = req.body?.lifecycle;
  const region = req.body?.region;
  const scope = req.body?.scope;
  const packageVersion = (req.body?.packageVersion || '').trim();
  const forceNewBuilds = (req.body?.forceNewBuilds || []).map(String);
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });

  const services = currentState.groups.find((group) => group.name === scope)?.services || [];
  const branchCache = new Map();
  const steps = await Promise.all(services.map(async (service) => {
    const config = store.getQueueConfig(service.id);
    if (!config) {
      return { service: service.name, action: 'skip', reason: 'Not configured for queueing.' };
    }
    const target = resolveQueueTarget(config, lifecycle, region, scope);
    if (!target || target.applicable === false) {
      return {
        service: service.name,
        action: 'skip',
        reason: `No mapping for ${lifecycle}${region ? ` / ${region}` : ''}.`
      };
    }
    const environments = target.environments.map((environment) => environment.name).join(', ')
      || target.targetValue;
    const releaseUrl = config.releaseDefinitionId
      ? `https://dev.azure.com/${config.organization}/${config.project}/_release?_a=releases&view=mine&definitionId=${config.releaseDefinitionId}`
      : null;

    const approvalFor = async () => {
      if (!config.releaseDefinitionId) return null;
      try {
        const gates = await fetchReleaseApprovalGates({
          organization: config.organization,
          project: config.project,
          releaseDefinitionId: config.releaseDefinitionId,
          token
        });
        const gated = target.environmentIds
          .map((id) => gates[id])
          .filter((gate) => gate?.requiresApproval);
        if (!gated.length) return null;
        const approvers = [...new Set(gated.flatMap((gate) => gate.approvers))];
        return {
          environments: gated.map((gate) => gate.name),
          approvers,
          text: `${gated.map((gate) => gate.name).join(', ')} needs manual approval${
            approvers.length ? ` (${approvers.join(', ')})` : ''}`
        };
      } catch {
        return null;
      }
    };

    const buildApprovalFor = async (live) => {
      if (live?.requiresApproval) {
        return {
          source: live.matchType === 'exact' ? 'live-exact' : 'live-fuzzy',
          environmentName: live.environmentName,
          approvers: live.approvers,
          minRequiredApprovers: live.minRequiredApprovers,
          text: `${live.environmentName} requires approval${
            live.approvers.length ? ` from ${live.approvers.join(', ')}` : ''}`
        };
      }

      // An exact YAML match is authoritative; anything less falls back to run history.
      if (live?.matchType === 'exact' && live.requiresApproval === false) return null;

      try {
        const history = await fetchBuildApprovalHistory({
          organization: config.organization,
          project: config.project,
          definitionId: config.buildDefinitionId,
          environmentValue: target.targetValue,
          token
        });
        if (!history) return { unknown: true, text: 'No previous run to this environment — approvals unknown.' };
        if (!history.requiresApproval) return null;
        return {
          source: 'history',
          stages: history.stages,
          approvers: history.approvers || [],
          minRequiredApprovers: history.minRequiredApprovers,
          text: `Last ${history.environmentValue} run (build ${history.buildNumber}) paused for approval${
            history.stages.length ? ` at: ${history.stages.join(', ')}` : ''}`
        };
      } catch {
        return null;
      }
    };

    try {
      if (config.type === 'package-release') {
        const requested = packageVersion || config.defaultPackageVersion;
        const match = requested && await findPackageVersion({
          organization: config.organization,
          project: config.project,
          feedId: config.feedId,
          packageId: config.packageId,
          packageName: config.packageName,
          version: requested,
          token
        });
        if (!match) {
          return {
            service: service.name,
            action: 'blocked',
            pipelineUrl: releaseUrl,
            reason: `${config.packageName} version ${requested || '(none selected)'} was not found.`
          };
        }
        const existingRelease = await findReleaseForPackageVersion({
          organization: config.organization,
          project: config.project,
          releaseDefinitionId: config.releaseDefinitionId,
          artifactAlias: config.artifactAlias,
          packageVersion: match.version,
          token
        }).catch(() => null);
        return existingRelease
          ? {
              service: service.name,
              action: 'redeploy-release',
              detail: `Redeploy existing ${existingRelease.releaseName} (${config.packageName} ${match.version})`,
              environments,
              webUrl: existingRelease.webUrl,
              pipelineUrl: releaseUrl,
              approval: await approvalFor()
            }
          : {
              service: service.name,
              action: 'create-package-release',
              detail: `Create a new ${config.releaseDefinitionName} release from ${config.packageName} ${match.version}`,
              environments,
              pipelineUrl: releaseUrl,
              approval: await approvalFor()
            };
      }

      const branch = resolveBranch(config, selectedBranch);
      const buildUrl = `https://dev.azure.com/${config.organization}/${config.project}/_build?definitionId=${config.buildDefinitionId}`;

      if (!(await branchExistsForConfig(config, branch, token, branchCache))) {
        return {
          service: service.name,
          action: 'skip',
          reason: `Branch "${branch}" was not found in this repository.`,
          environments,
          pipelineUrl: buildUrl
        };
      }

      if (config.type === 'build-release' && !forceNewBuilds.includes(String(config.buildDefinitionId))) {
        const release = await findLatestReleaseForBranch({
          organization: config.organization,
          project: config.project,
          releaseDefinitionId: config.releaseDefinitionId,
          artifactAlias: config.artifactAlias,
          sourceBranch: branch,
          token
        });
        if (!release) {
          return {
            service: service.name,
            action: 'blocked',
            reason: `No ${config.releaseDefinitionName} release exists for ${branch}.`
          };
        }
        const missing = target.environmentIds.filter((id) =>
          !release.environments.some((environment) => environment.definitionEnvironmentId === id));
        if (missing.length) {
          return {
            service: service.name,
            action: 'blocked',
            reason: `Release ${release.releaseName} has no environment for ${environments}.`
          };
        }
        return {
          service: service.name,
          action: 'redeploy-release',
          detail: `Redeploy existing ${release.releaseName} (build ${release.buildNumber})`,
          environments,
          webUrl: release.webUrl,
          pipelineUrl: releaseUrl,
          branch,
          approval: await approvalFor()
        };
      }

      const live = await fetchCurrentBuildApprovers({
        organization: config.organization,
        project: config.project,
        definitionId: config.buildDefinitionId,
        branch,
        environmentValue: target.targetValue,
        token
      }).catch(() => null);

      const accepted = live?.acceptedEnvironments || [];
      if (accepted.length && !accepted.some((value) =>
        value.toLowerCase() === String(target.targetValue).toLowerCase())) {
        return {
          service: service.name,
          action: 'blocked',
          reason: `"${target.targetValue}" is not a valid environment for this pipeline. Accepted: ${accepted.join(', ')}`,
          environments,
          pipelineUrl: buildUrl
        };
      }

      return {
        service: service.name,
        action: 'queue-build',
        detail: `Queue a NEW build of ${config.buildDefinitionName}`,
        environments,
        branch,
        pipelineUrl: buildUrl,
        approval: await buildApprovalFor(live),
        parameters: { ...target.parameters, ...target.templateParameters }
      };
    } catch (err) {
      return { service: service.name, action: 'blocked', reason: err.message };
    }
  }));

  res.json({ scope, lifecycle, region, branch: selectedBranch, steps });
});

app.post('/api/queue-all', async (req, res) => {
  const currentState = store.getState();
  const deploymentId = currentState.deployment.id;
  const token = req.body?.token || '';
  const selectedBranch = (req.body?.branch || '').trim();
  const lifecycle = req.body?.lifecycle;
  const region = req.body?.region;
  const scope = req.body?.scope;
  const packageVersion = (req.body?.packageVersion || '').trim();
  const forceNewBuilds = (req.body?.forceNewBuilds || []).map(String);
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  if (!['Regional', 'Global'].includes(scope)) {
    return res.status(400).json({ error: 'Select Regional or Global queue scope.' });
  }
  if (!selectedBranch) return res.status(400).json({ error: 'Select a branch.' });
  if (scope === 'Regional' && lifecycle === 'Production' && !['NA', 'EMEA', 'APAC'].includes(region)) {
    return res.status(400).json({ error: 'Select NA, EMEA, or APAC for Regional Production.' });
  }

  const services = currentState.groups.find((group) => group.name === scope)?.services || [];
  const plans = services.map((service) => ({
    service,
    config: store.getQueueConfig(service.id)
  })).filter((plan) => plan.config);
  if (!plans.length) return res.status(400).json({ error: `No ${scope} services are configured for queueing yet.` });

  const applicablePlans = [];
  const skipped = [];
  const branchCache = new Map();
  for (const plan of plans) {
    plan.target = resolveQueueTarget(plan.config, lifecycle, region, scope);
    if (plan.target?.applicable === false) continue;
    if (!plan.target) {
      return res.status(400).json({
        error: `${plan.service.name} has no mapping for ${lifecycle}${region ? ` / ${region}` : ''}. Nothing was queued.`
      });
    }
    plan.branch = resolveBranch(plan.config, selectedBranch);
    plan.forceNewBuild = forceNewBuilds.includes(String(plan.config.buildDefinitionId));

    if (!(await branchExistsForConfig(plan.config, plan.branch, token, branchCache))) {
      skipped.push({
        id: plan.service.id,
        name: plan.service.name,
        reason: `Branch "${plan.branch}" was not found in this repository.`
      });
      continue;
    }

    if (plan.config.type === 'package-release') {
      const requestedVersion = packageVersion || plan.config.defaultPackageVersion;
      if (!requestedVersion) {
        return res.status(400).json({ error: `${plan.service.name} requires a package version.` });
      }
      plan.packageMatch = await findPackageVersion({
        organization: plan.config.organization,
        project: plan.config.project,
        feedId: plan.config.feedId,
        packageId: plan.config.packageId,
        packageName: plan.config.packageName,
        version: requestedVersion,
        token
      });
      if (!plan.packageMatch) {
        return res.status(400).json({
          error: `${plan.config.packageName} version ${requestedVersion} was not found. Nothing was queued.`
        });
      }
    }
    applicablePlans.push(plan);
  }

  const reusePlans = applicablePlans.filter(
    (item) => item.config.type === 'build-release' && !item.forceNewBuild
  );
  const buildGroups = new Map();
  for (const plan of applicablePlans.filter(
    (item) => item.config.type !== 'package-release' && !reusePlans.includes(item)
  )) {
    const key = JSON.stringify({
      organization: plan.config.organization,
      project: plan.config.project,
      definitionId: plan.config.buildDefinitionId,
      branch: plan.branch,
      parameters: plan.target.parameters,
      templateParameters: plan.target.templateParameters
    });
    if (!buildGroups.has(key)) buildGroups.set(key, []);
    buildGroups.get(key).push(plan);
  }

  const queuedServices = [];
  try {
    for (const plan of applicablePlans.filter((item) => item.config.type === 'package-release')) {
      const release = await deployExistingPackageRelease({
        config: plan.config,
        target: plan.target,
        packageVersion: plan.packageMatch.version,
        token
      }) || await createPackageReleaseAndDeploy({
        organization: plan.config.organization,
        project: plan.config.project,
        releaseDefinitionId: plan.config.releaseDefinitionId,
        artifactAlias: plan.config.artifactAlias,
        environmentDefinitionIds: plan.target.environmentIds,
        packageVersion: plan.packageMatch.version,
        token
      });
      store.updateService(plan.service.id, packageReleasePatch(release, plan.config, plan.packageMatch), deploymentId);
      queuedServices.push({
        id: plan.service.id,
        name: plan.service.name,
        packageVersion: plan.packageMatch.version,
        environments: release.environmentRuns.map((environment) => environment.environmentName)
      });
    }
    for (const plan of reusePlans) {
      const { patch, release } = await deployLatestRelease({
        config: plan.config,
        target: plan.target,
        branch: plan.branch,
        token
      });
      store.updateService(plan.service.id, patch, deploymentId);
      queuedServices.push({
        id: plan.service.id,
        name: plan.service.name,
        reusedRelease: true,
        releaseName: release.releaseName,
        target: plan.target.targetKey
      });
    }
    for (const groupedPlans of buildGroups.values()) {
      const config = groupedPlans[0].config;
      const queued = await queueBuild({
        organization: config.organization,
        project: config.project,
        definitionId: config.buildDefinitionId,
        sourceBranch: groupedPlans[0].branch,
        parameters: groupedPlans[0].target.parameters,
        templateParameters: groupedPlans[0].target.templateParameters,
        token
      });
      for (const plan of groupedPlans) {
        store.updateService(
          plan.service.id,
          buildQueuePatch(queued, plan.config, plan.target),
          deploymentId
        );
        queuedServices.push({
          id: plan.service.id,
          name: plan.service.name,
          buildId: queued.buildId,
          target: plan.target.targetKey
        });
      }
    }
    res.json({
      scope,
      lifecycle,
      region: scope === 'Regional' && lifecycle === 'Production' ? region : null,
      queuedServices,
      skipped,
      buildsQueued: buildGroups.size,
      buildsReused: reusePlans.length,
      releasesCreated: applicablePlans.filter((plan) => plan.config.type === 'package-release').length,
      state: store.getState()
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Queues a shared mono-repo build exactly once and patches every SWA fed by it with the same
// build, so per-row Queue pipeline clicks can never trigger duplicate builds on that pipeline.
app.post('/api/pipeline-blocks/queue', async (req, res) => {
  const currentState = store.getState();
  const deploymentId = currentState.deployment.id;
  const token = req.body?.token || '';
  const scope = req.body?.scope;
  const key = String(req.body?.key || '');
  const lifecycle = req.body?.lifecycle;
  const region = req.body?.region;
  const selectedBranch = (req.body?.branch || '').trim();
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  if (!selectedBranch) return res.status(400).json({ error: 'Select a branch.' });

  const services = currentState.groups.find((group) => group.name === scope)?.services || [];
  const plans = services
    .map((service) => ({ service, config: store.getQueueConfig(service.id) }))
    .filter((plan) => plan.config?.type === 'build-release' && String(plan.config.buildDefinitionId) === key);
  if (!plans.length) return res.status(400).json({ error: 'No services found for this pipeline.' });

  const branch = resolveBranch(plans[0].config, selectedBranch);
  const branchCache = new Map();
  if (!(await branchExistsForConfig(plans[0].config, branch, token, branchCache))) {
    return res.status(400).json({ error: `Branch "${branch}" was not found in this repository.` });
  }

  const applicablePlans = [];
  for (const plan of plans) {
    const target = resolveQueueTarget(plan.config, lifecycle, region, scope);
    if (!target || target.applicable === false) continue;
    plan.target = target;
    applicablePlans.push(plan);
  }
  if (!applicablePlans.length) {
    return res.status(400).json({
      error: `No service on this pipeline has a mapping for ${lifecycle}${region ? ` / ${region}` : ''}.`
    });
  }

  try {
    const first = applicablePlans[0];
    const queued = await queueBuild({
      organization: first.config.organization,
      project: first.config.project,
      definitionId: first.config.buildDefinitionId,
      sourceBranch: branch,
      parameters: first.target.parameters,
      templateParameters: first.target.templateParameters,
      token
    });
    for (const plan of applicablePlans) {
      store.updateService(plan.service.id, buildQueuePatch(queued, plan.config, plan.target), deploymentId);
    }
    res.json({
      buildId: queued.buildId,
      queuedServiceIds: applicablePlans.map((plan) => plan.service.id),
      state: store.getState()
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function packageReleasePatch(release, config, packageMatch) {
  return {
    pipelineUrl: release.webUrl,
    runType: 'release',
    pipelineName: release.pipelineName || config.releaseDefinitionName,
    runNumber: release.runNumber,
    status: release.status,
    message: release.message,
    webUrl: release.webUrl,
    lastChecked: new Date().toISOString(),
    queueOperation: {
      phase: 'release',
      packageName: config.packageName,
      packageVersion: packageMatch.version,
      releaseId: release.releaseId,
      environmentId: release.environmentId,
      releaseEnvironments: release.environmentRuns,
      releaseStatus: release.status,
      releaseWebUrl: release.webUrl
    }
  };
}

function buildQueuePatch(queued, config, target) {
  // A build-release row's own URL is its release; the shared build lives on the block instead, so
  // leaving it off the row avoids showing the mono-repo build's name as a pipeline-name mismatch.
  const ownsBuildUrl = config.type !== 'build-release';
  return {
    pipelineUrl: ownsBuildUrl ? queued.webUrl : '',
    runType: ownsBuildUrl ? 'build' : null,
    pipelineName: ownsBuildUrl ? (queued.pipelineName || config.buildDefinitionName) : null,
    runNumber: ownsBuildUrl ? queued.buildNumber : null,
    status: ownsBuildUrl ? queued.status : 'idle',
    message: ownsBuildUrl ? queued.message : null,
    lastChecked: new Date().toISOString(),
    queueOperation: {
      phase: 'build',
      buildId: queued.buildId,
      buildNumber: queued.buildNumber,
      buildPipelineName: queued.pipelineName || config.buildDefinitionName,
      buildStatus: queued.status,
      buildMessage: queued.message,
      buildWebUrl: queued.webUrl,
      sourceBranch: queued.sourceBranch,
      sourceVersion: queued.sourceVersion,
      lifecycle: target.lifecycle,
      targetKey: target.targetKey,
      environmentDefinitionId: target.environmentIds[0] || null,
      environmentDefinitionIds: target.environmentIds,
      environmentName: target.environments.map((environment) => environment.name).join(', ') || target.targetValue,
      queuedAt: new Date().toISOString()
    }
  };
}

function latestReleasePatch(release, runs, config, target) {
  const aggregate = aggregateReleaseRuns(runs);
  // release.webUrl is a release-summary link with no environmentId, which refresh polling can't
  // parse — use the first environment's own progress URL instead so status keeps updating.
  const primaryUrl = runs[0]?.webUrl || release.webUrl;
  return {
    pipelineUrl: primaryUrl,
    runType: 'release',
    pipelineName: config.releaseDefinitionName,
    runNumber: release.releaseName,
    status: aggregate.status,
    message: aggregate.message,
    webUrl: primaryUrl,
    lastChecked: new Date().toISOString(),
    queueOperation: {
      phase: 'release',
      reusedRelease: true,
      releaseId: release.releaseId,
      releaseWebUrl: primaryUrl,
      releaseStatus: aggregate.status,
      releaseMessage: aggregate.message,
      releaseEnvironments: runs,
      buildId: release.buildId,
      buildNumber: release.buildNumber,
      buildPipelineName: config.buildDefinitionName,
      sourceBranch: release.branch,
      lifecycle: target.lifecycle,
      targetKey: target.targetKey,
      environmentDefinitionIds: target.environmentIds,
      environmentName: target.environments.map((environment) => environment.name).join(', ') || target.targetValue,
      queuedAt: new Date().toISOString()
    }
  };
}

// Default path: redeploy the newest release built from the selected branch.
async function deployLatestRelease({ config, target, branch, token }) {
  const release = await findLatestReleaseForBranch({
    organization: config.organization,
    project: config.project,
    releaseDefinitionId: config.releaseDefinitionId,
    artifactAlias: config.artifactAlias,
    sourceBranch: branch,
    token
  });
  if (!release) {
    throw new Error(
      `No ${config.releaseDefinitionName} release exists for ${branch}. Tick "Force new build and release" on ${config.monoRepoName || config.buildDefinitionName}.`
    );
  }

  const runs = [];
  for (const definitionEnvironmentId of target.environmentIds) {
    const environment = release.environments.find(
      (item) => item.definitionEnvironmentId === definitionEnvironmentId
    );
    if (!environment) {
      throw new Error(`Release ${release.releaseName} has no environment matching ${target.targetValue}.`);
    }
    const result = await deployExistingReleaseEnvironment({
      organization: config.organization,
      project: config.project,
      releaseId: release.releaseId,
      environmentId: environment.environmentId,
      token
    });
    runs.push({
      environmentId: environment.environmentId,
      environmentName: environment.name,
      status: result.status,
      message: result.message,
      webUrl: `https://dev.azure.com/${config.organization}/${config.project}/_releaseProgress?_a=release-environment-logs&releaseId=${release.releaseId}&environmentId=${environment.environmentId}`
    });
  }
  return { patch: latestReleasePatch(release, runs, config, target), release };
}

// Same idea as deployLatestRelease, but keyed on package version instead of branch — reuse the
// release already created for this exact version rather than always creating a new one.
async function deployExistingPackageRelease({ config, target, packageVersion, token }) {
  const release = await findReleaseForPackageVersion({
    organization: config.organization,
    project: config.project,
    releaseDefinitionId: config.releaseDefinitionId,
    artifactAlias: config.artifactAlias,
    packageVersion,
    token
  });
  if (!release) return null;

  const environmentRuns = [];
  for (const definitionEnvironmentId of target.environmentIds) {
    const environment = release.environments.find(
      (item) => item.definitionEnvironmentId === definitionEnvironmentId
    );
    if (!environment) {
      throw new Error(`Release ${release.releaseName} has no environment matching ${target.targetValue}.`);
    }
    const result = await deployExistingReleaseEnvironment({
      organization: config.organization,
      project: config.project,
      releaseId: release.releaseId,
      environmentId: environment.environmentId,
      token
    });
    environmentRuns.push({
      environmentId: environment.environmentId,
      environmentName: environment.name,
      status: result.status,
      message: result.message,
      webUrl: `https://dev.azure.com/${config.organization}/${config.project}/_releaseProgress?_a=release-environment-logs&releaseId=${release.releaseId}&environmentId=${environment.environmentId}`
    });
  }
  const aggregate = aggregateReleaseRuns(environmentRuns);
  return {
    ...aggregate,
    releaseId: release.releaseId,
    environmentId: environmentRuns[0]?.environmentId,
    runNumber: release.releaseName,
    pipelineName: release.releaseDefinitionName || config.releaseDefinitionName,
    webUrl: environmentRuns[0]?.webUrl,
    environmentRuns,
    reusedRelease: true
  };
}

// After a shared build succeeds: some release definitions have a CD trigger that already spawned
// a release from this exact build, so deploy to that instead of creating a duplicate release.
async function deployOrCreateReleaseForBuild({ config, environmentIds, buildId, buildNumber, sourceBranch, sourceVersion, token }) {
  const existing = await findReleaseForBuildId({
    organization: config.organization,
    project: config.project,
    releaseDefinitionId: config.releaseDefinitionId,
    artifactAlias: config.artifactAlias,
    buildId,
    token
  }).catch(() => null);

  if (existing) {
    const environmentRuns = [];
    for (const definitionEnvironmentId of environmentIds) {
      const environment = existing.environments.find(
        (item) => item.definitionEnvironmentId === definitionEnvironmentId
      );
      if (!environment) break;
      const result = await deployExistingReleaseEnvironment({
        organization: config.organization,
        project: config.project,
        releaseId: existing.releaseId,
        environmentId: environment.environmentId,
        currentStatus: environment.status,
        token
      });
      environmentRuns.push({
        environmentId: environment.environmentId,
        environmentName: environment.name,
        status: result.status,
        message: result.message,
        webUrl: `https://dev.azure.com/${config.organization}/${config.project}/_releaseProgress?_a=release-environment-logs&releaseId=${existing.releaseId}&environmentId=${environment.environmentId}`
      });
    }
    if (environmentRuns.length === environmentIds.length) {
      const aggregate = aggregateReleaseRuns(environmentRuns);
      return {
        ...aggregate,
        releaseId: existing.releaseId,
        environmentId: environmentRuns[0]?.environmentId,
        runNumber: existing.releaseName,
        pipelineName: existing.releaseDefinitionName || config.releaseDefinitionName,
        webUrl: environmentRuns[0]?.webUrl,
        environmentRuns,
        reusedRelease: true
      };
    }
    // The auto-created release doesn't cover every requested environment; create one that does.
  }

  return createReleaseAndDeploy({
    organization: config.organization,
    project: config.project,
    releaseDefinitionId: config.releaseDefinitionId,
    artifactAlias: config.artifactAlias,
    environmentDefinitionIds: environmentIds,
    buildId,
    buildNumber,
    sourceBranch,
    sourceVersion,
    token
  });
}

// Repos disagree on branch naming (develop/main/migration-v3/master), so rather than maintain an
// alias table we check each pipeline's own repo and let the caller skip it when the branch is
// absent there. Results are cached per definition for the lifetime of one request.
async function branchExistsForConfig(config, branch, token, cache) {
  if (!config.buildDefinitionId) return true;
  const key = `${config.organization}/${config.project}/${config.buildDefinitionId}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      fetchDefinitionBranches({
        organization: config.organization,
        project: config.project,
        definitionId: config.buildDefinitionId,
        token
      }).catch(() => null)
    );
  }
  const branches = await cache.get(key);
  // Fail open: an API hiccup shouldn't hide a service that would otherwise queue fine.
  if (!branches) return true;
  return branches.some((name) => name.toLowerCase() === branch.toLowerCase());
}

app.post('/api/scope-branches', async (req, res) => {
  const { scope, token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Azure DevOps PAT is required.' });
  const services = store.getState().groups.find((group) => group.name === scope)?.services || [];
  const configs = services
    .map((service) => store.getQueueConfig(service.id))
    .filter((config) => config?.buildDefinitionId);

  const seen = new Set();
  const uniqueConfigs = configs.filter((config) => {
    const key = `${config.organization}/${config.project}/${config.buildDefinitionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const perRepo = await Promise.all(uniqueConfigs.map((config) =>
    fetchDefinitionBranches({
      organization: config.organization,
      project: config.project,
      definitionId: config.buildDefinitionId,
      token
    }).catch(() => [])
  ));

  const defaults = [...new Set(configs.map((config) =>
    config.defaultBranch?.replace(/^refs\/heads\//, '')).filter(Boolean))];
  const branches = [...new Set([...defaults, ...perRepo.flat()])].sort((a, b) => a.localeCompare(b));
  res.json({ branches, repoCount: uniqueConfigs.length });
});

app.post('/api/services/:id/correct-pipeline', (req, res) => {
  const deploymentId = store.getState().deployment.id;
  const svc = store.findService(req.params.id, deploymentId);
  if (!svc) return res.status(404).json({ error: 'not found' });
  if (!svc.pipelineName) {
    return res.status(400).json({ error: 'Refresh this row to fetch its Azure pipeline name first.' });
  }
  store.approvePipelineName(svc.id, svc.pipelineName);
  res.json(store.getState());
});

app.post('/api/services/:id/pipeline-url', async (req, res) => {
  const pipelineUrl = (req.body?.pipelineUrl || '').trim();
  const token = req.body?.token || '';
  const deploymentId = store.getState().deployment.id;
  const existing = store.findService(req.params.id, deploymentId);
  if (!existing) return res.status(404).json({ error: 'not found' });

  let parsed = null;
  if (pipelineUrl) {
    try {
      parsed = parsePipelineUrl(pipelineUrl);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  let svc = store.updateService(req.params.id, {
    pipelineUrl,
    runType: parsed?.type || null,
    pipelineName: null,
    status: 'idle',
    runNumber: null,
    webUrl: null,
    lastChecked: null,
    message: null,
    queueOperation: null
  }, deploymentId);

  if (parsed && token) {
    try {
      svc = store.updateService(svc.id, await getRunPatch(parsed, token), deploymentId);
    } catch (err) {
      svc = store.updateService(svc.id, {
        status: 'error',
        message: err.message,
        lastChecked: new Date().toISOString()
      }, deploymentId);
    }
  }
  res.json(svc);
});

app.post('/api/services/:id/refresh', async (req, res) => {
  const deploymentId = store.getState().deployment.id;
  const svc = store.findService(req.params.id, deploymentId);
  if (!svc) return res.status(404).json({ error: 'not found' });

  const token = (req.body && req.body.token) || '';
  // While a shared mono-repo build is in flight the row has no URL of its own — poll the block's
  // build instead, which is what decides when this row's release can be created.
  const pollUrl = svc.pipelineUrl || svc.queueOperation?.buildWebUrl || '';
  if (!pollUrl) {
    return res.status(400).json({ error: 'No pipeline URL set for this service yet.' });
  }
  if (!token) {
    return res.status(400).json({ error: 'Paste your Azure DevOps personal access token first.' });
  }

  try {
    const parsed = parsePipelineUrl(pollUrl);
    let refreshedReleaseEnvironments = null;
    let result;
    if (
      parsed.type === 'release' &&
      Array.isArray(svc.queueOperation?.releaseEnvironments) &&
      svc.queueOperation.releaseEnvironments.length > 1
    ) {
      refreshedReleaseEnvironments = await Promise.all(
        svc.queueOperation.releaseEnvironments.map(async (environment) => ({
          ...environment,
          ...(await fetchRunStatus({ ...parsePipelineUrl(environment.webUrl), token }))
        }))
      );
      const aggregate = aggregateReleaseRuns(refreshedReleaseEnvironments);
      result = {
        ...refreshedReleaseEnvironments[0],
        ...aggregate,
        runNumber: svc.runNumber,
        pipelineName: svc.pipelineName,
        runType: 'release'
      };
    } else {
      result = await fetchRunStatus({ ...parsed, token });
    }
    const config = store.getQueueConfig(svc.id);
    const pollingSharedBuild = config?.type === 'build-release' && parsed.type === 'build';
    // Only the block tracks the shared build, so don't stamp its name/number onto the row.
    let patch = pollingSharedBuild ? { lastChecked: new Date().toISOString() } : getRunPatchFromResult(result);

    if (svc.queueOperation && parsed.type === 'build') {
      patch.queueOperation = {
        ...svc.queueOperation,
        buildId: result.buildId,
        buildNumber: result.runNumber,
        buildPipelineName: result.pipelineName,
        buildStatus: result.status,
        buildMessage: result.message,
        buildWebUrl: result.webUrl,
        sourceBranch: result.sourceBranch || svc.queueOperation.sourceBranch,
        sourceVersion: result.sourceVersion || svc.queueOperation.sourceVersion
      };
    } else if (svc.queueOperation && parsed.type === 'release') {
      patch.queueOperation = {
        ...svc.queueOperation,
        releaseStatus: result.status,
        releaseMessage: result.message,
        releaseWebUrl: result.webUrl,
        releaseEnvironments: refreshedReleaseEnvironments || svc.queueOperation.releaseEnvironments
      };
    }

    if (
      parsed.type === 'build' &&
      result.status === 'succeeded' &&
      // Retry release creation on the next refresh if it failed last time — the build stays put,
      // so there's nothing else that would ever move this row out of a stuck error state.
      (svc.queueOperation?.phase === 'build' || svc.queueOperation?.phase === 'release-error') &&
      config?.type === 'build-release'
    ) {
      store.updateService(svc.id, {
        queueOperation: { ...svc.queueOperation, phase: 'creating-release' }
      }, deploymentId, { markDirty: false });
      const environmentIds = svc.queueOperation.environmentDefinitionIds || [
        svc.queueOperation.environmentDefinitionId
      ];
      const release = await deployOrCreateReleaseForBuild({
        config,
        environmentIds,
        buildId: result.buildId,
        buildNumber: result.runNumber,
        sourceBranch: result.sourceBranch || svc.queueOperation.sourceBranch,
        sourceVersion: result.sourceVersion || svc.queueOperation.sourceVersion,
        token
      });
      patch = {
        status: release.status,
        message: release.message,
        runNumber: release.runNumber,
        pipelineName: release.pipelineName || config.releaseDefinitionName,
        runType: 'release',
        pipelineUrl: release.webUrl,
        webUrl: release.webUrl,
        lastChecked: new Date().toISOString(),
        queueOperation: {
          ...svc.queueOperation,
          phase: 'release',
          buildStatus: 'succeeded',
          buildMessage: null,
          buildWebUrl: result.webUrl,
          releaseId: release.releaseId,
          environmentId: release.environmentId,
          releaseEnvironments: release.environmentRuns,
          releaseStatus: release.status,
          releaseMessage: release.message,
          releaseWebUrl: release.webUrl,
          releaseReused: release.reusedRelease === true
        }
      };
    }

    const updated = store.updateService(svc.id, patch, deploymentId, { markDirty: false });
    res.json(updated);
  } catch (err) {
    const updated = store.updateService(svc.id, {
      status: 'error',
      message: err.message,
      lastChecked: new Date().toISOString(),
      queueOperation: svc.queueOperation?.phase === 'creating-release'
        ? { ...svc.queueOperation, phase: 'release-error' }
        : svc.queueOperation
    }, deploymentId, { markDirty: false });
    res.status(200).json(updated);
  }
});

app.post('/api/import', async (req, res) => {
  const text = req.body?.text || '';
  const token = req.body?.token || '';
  const cleanRun = req.body?.cleanRun === true;
  const currentState = store.getState();
  const deploymentId = currentState.deployment.id;
  const entries = extractUrlsOnly(text);
  if (!entries.length) {
    return res.status(400).json({ error: 'No URLs were found in the pasted text.' });
  }
  if (!token) {
    return res.status(400).json({
      error: 'Save an Azure DevOps PAT before importing so every URL can be verified by Azure first.'
    });
  }

  const ignored = entries.filter((entry) => {
    try {
      return new URL(entry.url).hostname === 'octopus.mrisoftware.net';
    } catch {
      return false;
    }
  });
  const importEntries = entries.filter((entry) => !ignored.includes(entry));
  const duplicateCounts = countUrlOccurrences(importEntries);
  const uniqueImportEntries = uniqueUrlEntries(importEntries);

  const resolved = await Promise.all(uniqueImportEntries.map(async (entry) => {
    try {
      const parsed = parsePipelineUrl(entry.url);
      try {
        const result = await fetchRunStatus({ ...parsed, token });
        return { entry, parsed, result, fetchError: null };
      } catch (err) {
        return { entry, parsed, result: null, fetchError: err.message };
      }
    } catch (err) {
      return { entry, parseError: err.message };
    }
  }));

  if (cleanRun) store.clearAll();
  const importState = cleanRun ? store.getState() : currentState;
  const services = importState.groups.flatMap((group) =>
    group.services.map((service) => ({ ...service, group: group.name }))
  );
  const usedIds = new Set();
  const reportedDuplicates = new Set();
  const reportedAssignments = new Set();
  const duplicateIssues = new Map();
  const matchedByIdentity = new Map();
  const matchedByPipelineName = new Map();
  const matched = [];
  const unmatched = [];
  const issues = ignored.map((entry) => ({
    code: 'unsupported-url',
    severity: 'info',
    url: entry.url,
    label: entry.label,
    pipelineName: null,
    message: 'Unsupported provider: this Octopus URL was ignored.'
  }));

  for (const item of resolved) {
    const identity = getUrlIdentity(item.entry.url);
    const duplicateCount = duplicateCounts.get(identity) || 1;
    if (duplicateCount > 1 && !reportedDuplicates.has(identity)) {
      reportedDuplicates.add(identity);
      const duplicateIssue = {
        code: 'duplicate-url',
        severity: 'warning',
        url: item.entry.url,
        label: item.entry.label,
        pipelineName: item.result?.pipelineName || null,
        message: `Duplicate URL: it appears ${duplicateCount} times in this paste.`
      };
      issues.push(duplicateIssue);
      duplicateIssues.set(identity, duplicateIssue);
    }

    if (item.parseError) {
      const issue = {
        code: 'invalid-url',
        severity: 'error',
        ...item.entry,
        pipelineName: null,
        message: item.parseError
      };
      issues.push(issue);
      unmatched.push({ ...item.entry, code: issue.code, pipelineName: null, reason: issue.message });
      continue;
    }

    if (item.fetchError) {
      const reason = `Azure verification failed: ${item.fetchError}`;
      unmatched.push({
        ...item.entry,
        code: 'azure-error',
        pipelineName: null,
        reason
      });
      issues.push({
        code: 'azure-error',
        severity: 'error',
        ...item.entry,
        pipelineName: null,
        message: reason
      });
      continue;
    }

    const existingAssignments = findExistingAssignments(services, item.entry.url);
    if (existingAssignments.length && !reportedAssignments.has(identity)) {
      reportedAssignments.add(identity);
      const destinations = existingAssignments.map((assigned) => `${assigned.group} / ${assigned.name}`);
      issues.push({
        code: 'already-assigned',
        severity: 'info',
        url: item.entry.url,
        label: item.entry.label,
        pipelineName: item.result?.pipelineName || null,
        destinations,
        message: `Already pasted under ${destinations.join(', ')}.`
      });
    }

    const service = findServiceMatch(services, item.entry, item.result?.pipelineName, usedIds);
    if (!service) {
      const priorRunMatch = matchedByIdentity.get(identity);
      const priorNameMatch = item.result?.pipelineName
        ? matchedByPipelineName.get(normalizeName(item.result.pipelineName))
        : null;
      const priorMatch = priorRunMatch || priorNameMatch;
      const reason = priorMatch
        ? `Azure returned ${item.result.pipelineName || 'the same run'}, which already matched ` +
          `${priorMatch.group} / ${priorMatch.name} in this paste. No additional configured service accepts it.`
        : item.result?.pipelineName
          ? `Azure returned “${item.result.pipelineName}”, but no configured service or approved alias matches it.` +
            (item.entry.label ? ` The pasted label “${item.entry.label}” was ignored.` : '')
          : 'Azure did not return a pipeline name, so this URL was not allocated.';
      const code = priorMatch
        ? 'duplicate-pipeline'
        : item.result?.pipelineName
          ? 'azure-name-mismatch'
          : 'missing-azure-name';
      unmatched.push({
        ...item.entry,
        code,
        pipelineName: item.result?.pipelineName || null,
        reason
      });
      issues.push({
        code,
        severity: 'error',
        ...item.entry,
        pipelineName: item.result?.pipelineName || null,
        message: reason
      });
      continue;
    }

    usedIds.add(service.id);
    matchedByIdentity.set(identity, service);
    if (item.result?.pipelineName) {
      matchedByPipelineName.set(normalizeName(item.result.pipelineName), service);
    }
    const duplicateIssue = duplicateIssues.get(identity);
    if (duplicateIssue && !duplicateIssue.destinations) {
      duplicateIssue.destinations = [`${service.group} / ${service.name}`];
      duplicateIssue.message = `Duplicate URL: it appears ${duplicateCount} times. ` +
        `Azure returned the same run each time; the first match was ${service.group} / ${service.name}.`;
    }
    if (service.pipelineUrl && getUrlIdentity(service.pipelineUrl) !== identity) {
      issues.push({
        code: 'replaced-url',
        severity: 'warning',
        url: item.entry.url,
        label: item.entry.label,
        pipelineName: item.result?.pipelineName || null,
        destinations: [`${service.group} / ${service.name}`],
        message: `${service.group} / ${service.name} already had a different URL; it was replaced.`
      });
    }
    const patch = {
      pipelineUrl: item.entry.url,
      runType: item.parsed.type,
      pipelineName: item.result?.pipelineName || null,
      runNumber: item.result?.runNumber || null,
      webUrl: item.result?.webUrl || null,
      status: item.result.status,
      message: item.result.message,
      lastChecked: new Date().toISOString()
    };
    store.updateService(service.id, patch, deploymentId);
    matched.push({
      id: service.id,
      group: service.group,
      name: service.name,
      pipelineName: patch.pipelineName,
      url: patch.pipelineUrl,
      warning: item.fetchError
    });
  }

  const incomingIdentities = new Set(importEntries.map((entry) => getUrlIdentity(entry.url)));
  const latestHistoricalByService = new Map();
  for (const historical of store.getHistoricalServices()) {
    if (historical.pipelineUrl && !latestHistoricalByService.has(historical.id)) {
      latestHistoricalByService.set(historical.id, historical);
    }
  }
  for (const service of services) {
    if (usedIds.has(service.id)) continue;
    const historical = latestHistoricalByService.get(service.id);
    if (!historical || incomingIdentities.has(getUrlIdentity(historical.pipelineUrl))) continue;
    issues.push({
      code: 'missing-previous-service',
      severity: 'warning',
      url: historical.pipelineUrl,
      label: service.name,
      pipelineName: historical.pipelineName || null,
      destinations: [`${service.group} / ${service.name}`],
      message: `${service.group} / ${service.name} had no matching URL in this paste. ` +
        `The previous deployment “${historical.deploymentName}” used this URL.`
    });
  }

  res.json({
    matched,
    unmatched,
    issues,
    ignored: ignored.length,
    total: importEntries.length,
    uniqueTotal: uniqueImportEntries.length,
    duplicatesSkipped: importEntries.length - uniqueImportEntries.length,
    cleanRun,
    found: entries.length
  });
});

async function getRunPatch(parsed, token) {
  const result = await fetchRunStatus({ ...parsed, token });
  return getRunPatchFromResult(result);
}

function getRunPatchFromResult(result) {
  return {
    status: result.status,
    message: result.message,
    runNumber: result.runNumber,
    pipelineName: result.pipelineName,
    runType: result.runType,
    webUrl: result.webUrl,
    lastChecked: new Date().toISOString()
  };
}

app.post('/api/reset', (req, res) => {
  store.resetAll();
  res.json(store.getState());
});

app.listen(PORT, () => {
  console.log(`Deployment tracker running at http://localhost:${PORT}`);
});
