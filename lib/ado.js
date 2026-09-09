/**
 * Azure DevOps Build and classic Release API helpers.
 * Auth: Basic <base64(":"+PAT)> (empty username, PAT as password).
 */

const API_VERSION = '7.1';
// A stage in one of these states is already running or done — starting it again is an error.
const ALREADY_STARTED_STATUSES = ['inProgress', 'queued', 'scheduled', 'succeeded', 'partiallySucceeded'];
const { aggregateReleaseRuns } = require('./queue');

function parsePipelineUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('That does not look like a valid URL.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  let organization;
  let project;

  if (url.hostname === 'dev.azure.com') {
    organization = segments[0];
    project = segments[1];
  } else if (url.hostname.endsWith('.visualstudio.com')) {
    organization = url.hostname.split('.')[0];
    project = segments[0];
  } else {
    throw new Error('URL must be a dev.azure.com or *.visualstudio.com link.');
  }

  const releaseId = url.searchParams.get('releaseId');
  const environmentId = url.searchParams.get('environmentId');
  if (releaseId || environmentId || segments.includes('_releaseProgress')) {
    if (!organization || !project || !releaseId || !environmentId) {
      throw new Error('Release links must contain both "releaseId=" and "environmentId=".');
    }
    return { type: 'release', organization, project, releaseId, environmentId };
  }

  let buildId = url.searchParams.get('buildId');
  if (!buildId) {
    const buildsIndex = segments.findIndex((segment) => segment === 'builds');
    if (buildsIndex !== -1) buildId = segments[buildsIndex + 1];
  }

  if (!organization || !project || !buildId) {
    throw new Error(
      'Could not find a buildId, or a releaseId and environmentId, in that Azure DevOps URL.'
    );
  }

  return { type: 'build', organization, project, buildId };
}

function authHeader(token) {
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}

async function fetchJson(apiUrl, token, notFoundMessage) {
  return requestJson(apiUrl, token, { notFoundMessage });
}

async function requestJson(apiUrl, token, { method = 'GET', body, notFoundMessage } = {}) {
  const response = await fetch(apiUrl, {
    method,
    headers: {
      Authorization: authHeader(token),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (response.status === 401 || response.status === 203) {
    throw new Error('Azure DevOps rejected the token. Check the PAT and its scopes.');
  }
  if (response.status === 404) throw new Error(notFoundMessage);
  if (!response.ok) {
    // Azure's error body almost always explains exactly what's wrong; surface it instead of
    // a bare status code so failures are diagnosable without re-running with logging added.
    const detail = await response.json().catch(() => null);
    throw new Error(
      detail?.message || `Azure DevOps API returned ${response.status} ${response.statusText}`
    );
  }
  return response.json();
}

async function fetchBuildStatus({ organization, project, buildId, token }) {
  const data = await fetchBuildData({ organization, project, buildId, token });

  const normalized = normalizeStatus(data.status, data.result, 'Build');
  const webUrl =
    data._links?.web?.href ||
    `https://dev.azure.com/${organization}/${project}/_build/results?buildId=${buildId}`;

  return {
    ...normalized,
    buildId: data.id || Number(buildId),
    runNumber: data.buildNumber || null,
    pipelineName: data.definition?.name || null,
    sourceBranch: data.sourceBranch || null,
    sourceVersion: data.sourceVersion || null,
    webUrl,
    runType: 'build'
  };
}

async function fetchBuildData({ organization, project, buildId, token }) {
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/build/builds/${encodeURIComponent(buildId)}?api-version=${API_VERSION}`;
  return fetchJson(apiUrl, token, 'Build not found. Double check the pipeline URL.');
}

async function fetchReleaseStatus({ organization, project, releaseId, environmentId, token }) {
  const apiUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/release/releases/${encodeURIComponent(releaseId)}/environments/${encodeURIComponent(
    environmentId
  )}?api-version=${API_VERSION}`;
  const data = await fetchJson(
    apiUrl,
    token,
    'Release environment not found. Double check the release and environment IDs.'
  );

  const normalized = normalizeReleaseEnvironment(data);
  const webUrl = `https://dev.azure.com/${organization}/${project}/_releaseProgress?_a=release-environment-logs&releaseId=${releaseId}&environmentId=${environmentId}`;

  return {
    ...normalized,
    runNumber: data.release?.name || String(releaseId),
    pipelineName: data.releaseDefinition?.name || data.name || null,
    webUrl,
    runType: 'release'
  };
}

function fetchRunStatus(parsed) {
  return parsed.type === 'release' ? fetchReleaseStatus(parsed) : fetchBuildStatus(parsed);
}

async function inspectRunConfiguration(parsed) {
  if (parsed.type === 'build') {
    const build = await fetchBuildData(parsed);
    return {
      type: 'build',
      pipeline: summarizeBuild(build)
    };
  }

  const releaseUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(parsed.organization)}/${encodeURIComponent(
    parsed.project
  )}/_apis/release/releases/${encodeURIComponent(parsed.releaseId)}?api-version=${API_VERSION}`;
  const release = await fetchJson(releaseUrl, parsed.token, 'Release not found. Double check the release ID.');
  const definitionId = release.releaseDefinition?.id;
  let definition = null;
  if (definitionId) {
    const definitionUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(parsed.organization)}/${encodeURIComponent(
      parsed.project
    )}/_apis/release/definitions/${encodeURIComponent(definitionId)}?api-version=${API_VERSION}`;
    definition = await fetchJson(definitionUrl, parsed.token, 'Release definition not found.');
  }

  const artifacts = await Promise.all((release.artifacts || []).map(async (artifact) => {
    const reference = artifact.definitionReference || {};
    const summary = {
      alias: artifact.alias || null,
      type: artifact.type || null,
      definitionId: reference.definition?.id || null,
      definitionName: reference.definition?.name || null,
      feedId: reference.feed?.id || reference.definition?.id || null,
      feedName: reference.feed?.name || null,
      packageId: reference.package?.id || null,
      packageName: reference.package?.name || artifact.alias || null,
      versionId: reference.version?.id || null,
      versionName: reference.version?.name || null,
      sourceBranch: reference.branch?.id || reference.branch?.name || null,
      build: null
    };
    if (String(artifact.type).toLowerCase() === 'build' && summary.versionId) {
      const build = await fetchBuildData({
        organization: parsed.organization,
        project: parsed.project,
        buildId: summary.versionId,
        token: parsed.token
      });
      summary.build = summarizeBuild(build);
    }
    return summary;
  }));

  const currentEnvironment = (release.environments || []).find(
    (environment) => String(environment.id) === String(parsed.environmentId)
  );
  const definitionEnvironments = definition?.environments || [];

  return {
    type: 'release',
    releaseDefinition: {
      id: definitionId || null,
      name: release.releaseDefinition?.name || definition?.name || null
    },
    currentEnvironment: currentEnvironment ? {
      id: currentEnvironment.id,
      definitionEnvironmentId: currentEnvironment.definitionEnvironmentId || null,
      name: currentEnvironment.name || null
    } : null,
    environments: definitionEnvironments.map((environment) => ({
      id: environment.id,
      name: environment.name,
      rank: environment.rank ?? null
    })),
    artifacts
  };
}

async function fetchRepositoryBranches({ organization, project, repositoryId, token }) {
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/refs?filter=${encodeURIComponent(
    'heads/'
  )}&api-version=${API_VERSION}`;
  const data = await fetchJson(apiUrl, token, 'Repository not found. Check the PAT Code (Read) scope.');
  return (data.value || []).map((ref) => ({
    name: String(ref.name || '').replace(/^refs\/heads\//, ''),
    refName: ref.name,
    objectId: ref.objectId || null
  })).filter((branch) => branch.name);
}

async function fetchRecentBuildConfigurations({
  organization,
  project,
  definitionId,
  top = 25,
  token
}) {
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/build/builds?definitions=${encodeURIComponent(definitionId)}&queryOrder=finishTimeDescending&$top=${encodeURIComponent(
    top
  )}&api-version=${API_VERSION}`;
  const data = await fetchJson(apiUrl, token, 'Build definition history was not found.');
  const builds = await Promise.all((data.value || []).map(async (summary) => {
    const build = summary.templateParameters || summary.parameters
      ? summary
      : await fetchBuildData({
          organization,
          project,
          buildId: summary.id,
          token
        });
    return summarizeBuild(build);
  }));
  return builds;
}

function summarizeReleaseForDisplay(release, preferredAlias) {
  const environments = (release.environments || []).map((environment) => {
    const deploySteps = environment.deploySteps || [];
    const last = deploySteps[deploySteps.length - 1];
    return {
      environmentId: environment.id,
      definitionEnvironmentId: environment.definitionEnvironmentId,
      name: environment.name,
      rank: environment.rank,
      status: environment.status,
      deployedAt: last?.lastModifiedOn || last?.queuedOn || null
    };
  });
  const deployed = environments
    .filter((environment) => environment.deployedAt && environment.status !== 'notStarted')
    .sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt));
  // A release can carry several artifacts (e.g. source + package); pick the one that matters.
  const artifact = (release.artifacts || []).find((item) => item.alias === preferredAlias)
    || (release.artifacts || [])[0];
  return {
    releaseId: release.id,
    releaseName: release.name,
    releaseDefinitionId: release.releaseDefinition?.id || null,
    releaseDefinitionName: release.releaseDefinition?.name || null,
    createdOn: release.createdOn || null,
    webUrl: release._links?.web?.href || null,
    branch: artifact?.definitionReference?.branch?.name || null,
    buildNumber: artifact?.definitionReference?.version?.name || null,
    buildId: artifact?.definitionReference?.version?.id || null,
    packageVersion: artifact?.definitionReference?.version?.name || null,
    environments,
    lastDeployed: deployed[0] || null
  };
}

// Mirrors findLatestReleaseForBranch, but matches on package version instead of source branch.
async function findReleaseForPackageVersion({
  organization,
  project,
  releaseDefinitionId,
  artifactAlias,
  packageVersion,
  token,
  top = 50
}) {
  const apiUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/release/releases?definitionId=${encodeURIComponent(
    releaseDefinitionId
  )}&$expand=artifacts&queryOrder=descending&$top=${encodeURIComponent(top)}&api-version=${API_VERSION}`;
  const data = await fetchJson(apiUrl, token, 'Release definition history was not found.');
  const match = (data.value || []).find((release) =>
    (release.artifacts || []).some((artifact) =>
      artifact.alias === artifactAlias &&
      String(artifact.definitionReference?.version?.name || '').toLowerCase() ===
        String(packageVersion).toLowerCase()
    )
  );
  if (!match) return null;
  const detail = await fetchJson(
    `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
      project
    )}/_apis/release/releases/${match.id}?api-version=${API_VERSION}`,
    token,
    'Release was not found.'
  );
  return summarizeReleaseForDisplay(detail, artifactAlias);
}

// Some release definitions have a CD trigger, so a build may already have spawned its own
// release before the tracker gets a chance to create one. Check first to avoid a duplicate.
async function findReleaseForBuildId({
  organization,
  project,
  releaseDefinitionId,
  artifactAlias,
  buildId,
  token,
  top = 25
}) {
  const apiUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/release/releases?definitionId=${encodeURIComponent(
    releaseDefinitionId
  )}&$expand=artifacts&queryOrder=descending&$top=${encodeURIComponent(top)}&api-version=${API_VERSION}`;
  const data = await fetchJson(apiUrl, token, 'Release definition history was not found.');
  const match = (data.value || []).find((release) =>
    (release.artifacts || []).some((artifact) =>
      artifact.alias === artifactAlias &&
      String(artifact.definitionReference?.version?.id || '') === String(buildId)
    )
  );
  if (!match) return null;
  const detail = await fetchJson(
    `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
      project
    )}/_apis/release/releases/${match.id}?api-version=${API_VERSION}`,
    token,
    'Release was not found.'
  );
  return summarizeReleaseForDisplay(detail, artifactAlias);
}

async function findLatestReleaseForBranch({
  organization,
  project,
  releaseDefinitionId,
  artifactAlias,
  sourceBranch,
  token,
  top = 50
}) {
  const refName = sourceBranch?.startsWith('refs/heads/') ? sourceBranch : `refs/heads/${sourceBranch}`;
  const apiUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/release/releases?definitionId=${encodeURIComponent(
    releaseDefinitionId
  )}&$expand=environments,artifacts&queryOrder=descending&$top=${encodeURIComponent(
    top
  )}&api-version=${API_VERSION}`;
  const data = await fetchJson(apiUrl, token, 'Release definition history was not found.');
  const match = (data.value || []).find((release) =>
    (release.artifacts || []).some(
      (artifact) => artifact.definitionReference?.branch?.name === refName
    )
  );
  if (!match) return null;
  const detail = await fetchJson(
    `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
      project
    )}/_apis/release/releases/${match.id}?api-version=${API_VERSION}`,
    token,
    'Release was not found.'
  );
  return summarizeReleaseForDisplay(detail, artifactAlias);
}

// Redeploys an environment on an existing release instead of creating a new one.
// currentStatus lets the caller skip stages a CD trigger already started — Azure rejects an
// inProgress -> inProgress transition with VS402964.
async function deployExistingReleaseEnvironment({
  organization,
  project,
  releaseId,
  environmentId,
  currentStatus,
  token,
  comment = 'Queued from Deployment Tracker'
}) {
  const apiUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/release/releases/${encodeURIComponent(releaseId)}/environments/${encodeURIComponent(
    environmentId
  )}?api-version=${API_VERSION}`;
  if (ALREADY_STARTED_STATUSES.includes(String(currentStatus || ''))) {
    return normalizeReleaseEnvironment(
      await fetchJson(apiUrl, token, 'Release environment was not found.')
    );
  }
  const data = await requestJson(apiUrl, token, {
    method: 'PATCH',
    body: { status: 'inProgress', comment },
    notFoundMessage: 'Release environment was not found.'
  });
  return normalizeReleaseEnvironment(data);
}

async function fetchReleaseSummary({ organization, project, releaseId, token }) {
  const apiUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/release/releases/${encodeURIComponent(releaseId)}?api-version=${API_VERSION}`;
  const data = await fetchJson(apiUrl, token, 'Release was not found.');
  return {
    releaseId: data.id,
    releaseName: data.name,
    releaseDefinitionId: data.releaseDefinition?.id || null,
    releaseDefinitionName: data.releaseDefinition?.name || null,
    artifacts: (data.artifacts || []).map((artifact) => ({
      alias: artifact.alias,
      type: artifact.type,
      definitionId: artifact.definitionReference?.definition?.id || null,
      definitionName: artifact.definitionReference?.definition?.name || null,
      version: artifact.definitionReference?.version?.name || null,
      branch: artifact.definitionReference?.branch?.name || null,
      repository: artifact.definitionReference?.repository?.name || null
    })),
    environments: (data.environments || []).map((environment) => ({
      definitionEnvironmentId: environment.definitionEnvironmentId,
      name: environment.name,
      rank: environment.rank,
      status: environment.status
    }))
  };
}

// Branch lists come from the build definition's repo, covering Azure Repos and GitHub alike.
async function fetchDefinitionBranches({ organization, project, definitionId, token }) {
  const definitionUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/build/definitions/${encodeURIComponent(definitionId)}?api-version=${API_VERSION}`;
  const definition = await fetchJson(definitionUrl, token, 'Build definition was not found.');
  const repository = definition.repository || {};

  if (repository.type === 'TfsGit') {
    const branches = await fetchRepositoryBranches({
      organization,
      project,
      repositoryId: repository.id,
      token
    });
    return branches.map((branch) => branch.name);
  }

  const endpointId =
    repository.properties?.connectedServiceId || repository.properties?.connectedServiceEndpointId;
  if (!endpointId) return [];
  const providerName = repository.type === 'GitHub' ? 'github' : String(repository.type || '').toLowerCase();
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/sourceProviders/${encodeURIComponent(providerName)}/branches?serviceEndpointId=${encodeURIComponent(
    endpointId
  )}&repository=${encodeURIComponent(repository.id)}&api-version=7.1-preview.1`;
  const data = await fetchJson(apiUrl, token, 'Branches were not found for that repository.');
  return (data.value || []).map((branch) =>
    typeof branch === 'string' ? branch : branch.name || branch.friendlyName
  ).filter(Boolean);
}

// Reads approval gates from the release definition so a dry run can warn before anything is queued.
async function fetchReleaseApprovalGates({ organization, project, releaseDefinitionId, token }) {
  const apiUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/release/definitions/${encodeURIComponent(releaseDefinitionId)}?api-version=${API_VERSION}`;
  const data = await fetchJson(apiUrl, token, 'Release definition was not found.');
  const gates = {};
  for (const environment of data.environments || []) {
    const manual = [
      ...(environment.preDeployApprovals?.approvals || []),
      ...(environment.postDeployApprovals?.approvals || [])
    ].filter((approval) => approval.isAutomated === false);
    gates[environment.id] = {
      name: environment.name,
      requiresApproval: manual.length > 0,
      approvers: [...new Set(manual
        .map((approval) => approval.approver?.displayName)
        .filter(Boolean))]
    };
  }
  return gates;
}

// YAML pipelines gate on Environment checks, which only show up in a run's timeline.
async function fetchBuildApprovalHistory({
  organization,
  project,
  definitionId,
  environmentValue,
  token
}) {
  const listUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/build/builds?definitions=${encodeURIComponent(
    definitionId
  )}&queryOrder=finishTimeDescending&statusFilter=completed&$top=25&api-version=${API_VERSION}`;
  const list = await fetchJson(listUrl, token, 'Build history was not found.');
  const builds = list.value || [];
  const match = builds.find((build) =>
    String(build.templateParameters?.environment || '').toLowerCase() === String(environmentValue || '').toLowerCase()
  );
  if (!match) return null;

  const timelineUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/build/builds/${match.id}/timeline?api-version=${API_VERSION}`;
  const timeline = await fetchJson(timelineUrl, token, 'Build timeline was not found.');
  const records = timeline.records || [];
  const approvalRecords = records.filter((record) => record.type === 'Checkpoint.Approval');
  if (!approvalRecords.length) {
    return { requiresApproval: false, buildNumber: match.buildNumber, environmentValue, stages: [], approvers: [] };
  }

  const approvalStages = approvalRecords
    .map((record) => {
      const parent = records.find((item) => item.id === record.parentId);
      const stage = records.find((item) => item.id === parent?.parentId) || parent;
      return stage?.name;
    })
    .filter(Boolean);

  // The timeline checkpoint id doubles as the approval id, which is what exposes the approvers.
  const approvers = [];
  let minRequired = null;
  await Promise.all(approvalRecords.map(async (record) => {
    try {
      const approval = await fetchJson(
        `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
          project
        )}/_apis/pipelines/approvals/${record.id}?$expand=steps&api-version=7.1-preview.1`,
        token,
        'Approval was not found.'
      );
      minRequired = approval.minRequiredApprovers ?? minRequired;
      for (const step of approval.steps || []) {
        const name = step.assignedApprover?.displayName;
        if (name) approvers.push(name);
      }
    } catch {
      // An approval record may have been cleaned up; the stage name is still useful.
    }
  }));

  return {
    requiresApproval: true,
    buildNumber: match.buildNumber,
    environmentValue,
    stages: [...new Set(approvalStages)],
    approvers: [...new Set(approvers)],
    minRequiredApprovers: minRequired
  };
}

// Pipelines gate each target behind `${{ if eq(parameters.environment, 'x') }}` (or an `or(...)` of
// several). A block can hold several `environment:` lines (deployment targets and template
// arguments), and expressions like `${{ replace(parameters.environment, '_GLOBAL', '') }}`, so all
// candidates are collected and evaluated, then later validated against real environment resources.
function evaluateTemplateExpression(expr, environmentValue) {
  const trimmed = expr.trim();
  if (trimmed === 'parameters.environment') return environmentValue;
  const replaceCall = trimmed.match(
    /^replace\(\s*parameters\.environment\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)$/
  );
  if (replaceCall) return environmentValue.split(replaceCall[1]).join(replaceCall[2]);
  return null;
}

function resolveEnvironmentToken(rawValue, environmentValue) {
  const value = String(rawValue || '').trim().replace(/^['"]|['"]$/g, '');
  let failed = false;
  const substituted = value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (match, expr) => {
    const resolved = evaluateTemplateExpression(expr, environmentValue);
    if (resolved === null) failed = true;
    return resolved ?? '';
  });
  if (failed || !/^[A-Za-z0-9._-]+$/.test(substituted)) return null;
  return substituted;
}

function extractEnvironmentMap(yaml) {
  const lines = String(yaml || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
  const map = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const rawTargets = [...lines[i].matchAll(/parameters\.environment\s*,\s*'([^']+)'/g)].map((m) => m[1]);
    if (!rawTargets.length) continue;
    const indent = lines[i].search(/\S/);

    const collected = { templates: [], namedByTarget: new Map(rawTargets.map((t) => [t, []])) };
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (line.search(/\S/) <= indent) break;

      const template = line.match(/^\s*-?\s*template:\s*(\S+)/);
      if (template && !collected.templates.includes(template[1])) collected.templates.push(template[1]);

      const named = line.match(/^\s*(?:environment|name):\s*(\S.*)$/);
      if (named) {
        for (const rawTarget of rawTargets) {
          const resolved = resolveEnvironmentToken(named[1], rawTarget);
          const list = collected.namedByTarget.get(rawTarget);
          if (resolved && !list.includes(resolved)) list.push(resolved);
        }
      }
    }

    for (const rawTarget of rawTargets) {
      const targetValue = rawTarget.toLowerCase();
      const entry = map.get(targetValue) || { names: [], templates: [] };
      for (const name of collected.namedByTarget.get(rawTarget)) {
        if (!entry.names.includes(name)) entry.names.push(name);
      }
      for (const template of collected.templates) {
        if (!entry.templates.includes(template)) entry.templates.push(template);
      }
      map.set(targetValue, entry);
    }
  }
  return map;
}

const REGION_ALIASES = {
  na: ['na', 'cus', 'usa'],
  cus: ['na', 'cus', 'usa'],
  usa: ['na', 'cus', 'usa'],
  emea: ['emea', 'gbr'],
  gbr: ['emea', 'gbr'],
  apac: ['apac', 'aus'],
  aus: ['apac', 'aus']
};

function tokenize(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Picks the pipeline environment that best matches a lifecycle/region target such as "prod-CUS".
function matchEnvironmentName(candidates, environmentValue) {
  const tokens = tokenize(environmentValue);
  const lifecycle = tokens[0];
  const regionTokens = tokens.slice(1).flatMap((token) => REGION_ALIASES[token] || [token]);

  let best = null;
  for (const candidate of candidates) {
    const candidateTokens = tokenize(candidate);
    if (lifecycle && !candidateTokens.includes(lifecycle)) continue;
    const hasRegion = regionTokens.some((token) => candidateTokens.includes(token));
    const otherRegion = ['cus', 'usa', 'na', 'gbr', 'emea', 'aus', 'apac']
      .some((token) => candidateTokens.includes(token) && !regionTokens.includes(token));
    if (regionTokens.length && otherRegion && !hasRegion) continue;
    const score = (hasRegion ? 2 : 0) + (otherRegion ? 0 : 1);
    if (!best || score > best.score) best = { name: candidate, score };
  }
  return best?.name || null;
}

async function fetchPipelineYaml({ organization, project, definition, branch, token }) {
  const repository = definition.repository || {};
  const yamlPath = definition.process?.yamlFilename;
  if (!yamlPath) return null;
  const branchName = String(branch || '').replace(/^refs\/heads\//, '');

  if (repository.type === 'TfsGit') {
    const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
      project
    )}/_apis/git/repositories/${encodeURIComponent(repository.id)}/items?path=${encodeURIComponent(
      yamlPath
    )}&versionDescriptor.version=${encodeURIComponent(branchName)}&includeContent=true&api-version=${API_VERSION}`;
    const data = await fetchJson(apiUrl, token, 'Pipeline YAML was not found.');
    return data.content || null;
  }

  const endpointId =
    repository.properties?.connectedServiceId || repository.properties?.connectedServiceEndpointId;
  if (!endpointId) return null;
  const providerName = repository.type === 'GitHub' ? 'github' : String(repository.type || '').toLowerCase();
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/sourceProviders/${encodeURIComponent(providerName)}/filecontents?serviceEndpointId=${encodeURIComponent(
    endpointId
  )}&repository=${encodeURIComponent(repository.id)}&commitOrBranch=${encodeURIComponent(
    branchName
  )}&path=${encodeURIComponent(`/${yamlPath}`)}&api-version=7.1-preview.1`;
  const response = await fetch(apiUrl, {
    headers: { Authorization: authHeader(token), Accept: 'application/json' }
  });
  if (!response.ok) return null;
  return response.text();
}

let environmentIndexCache = null;

async function fetchEnvironmentIndex({ organization, project, token }) {
  if (environmentIndexCache) return environmentIndexCache;
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/pipelines/environments?$top=1000&api-version=7.1-preview.1`;
  const data = await fetchJson(apiUrl, token, 'Environments were not found.');
  environmentIndexCache = new Map((data.value || []).map((item) => [item.name.toLowerCase(), item.id]));
  return environmentIndexCache;
}

// Live approver list straight from the environment's approval check, rather than a past run.
async function fetchCurrentBuildApprovers({
  organization,
  project,
  definitionId,
  branch,
  environmentValue,
  token
}) {
  const definition = await fetchJson(
    `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
      project
    )}/_apis/build/definitions/${encodeURIComponent(definitionId)}?api-version=${API_VERSION}`,
    token,
    'Build definition was not found.'
  );
  const yaml = await fetchPipelineYaml({ organization, project, definition, branch, token })
    || await fetchPipelineYaml({
      organization,
      project,
      definition,
      branch: definition.repository?.defaultBranch,
      token
    });
  if (!yaml) return null;

  const exactMap = extractEnvironmentMap(yaml);
  const acceptedEnvironments = [...new Set(
    [...yaml.matchAll(/parameters\.environment\s*,\s*'([^']+)'/g)].map((match) => match[1])
  )];
  const index = await fetchEnvironmentIndex({ organization, project, token });
  const entry = exactMap.get(String(environmentValue || '').toLowerCase());

  // Only a name that exists as a real environment resource counts as an exact match.
  let environmentName = (entry?.names || []).find((name) => index.has(name.toLowerCase())) || null;
  let matchType = environmentName ? 'exact' : null;

  if (!environmentName && entry?.templates?.length) {
    const baseDir = String(definition.process?.yamlFilename || '').replace(/[^/]*$/, '');
    for (const templatePath of entry.templates) {
      const templateYaml = await fetchPipelineYaml({
        organization,
        project,
        definition: {
          ...definition,
          process: { yamlFilename: `${baseDir}${templatePath.replace(/^\.\//, '')}` }
        },
        branch,
        token
      }).catch(() => null);
      if (!templateYaml) continue;
      const names = [...templateYaml.matchAll(/^\s*(?:environment|name):\s*(\S.*)$/gm)]
        .map((match) => resolveEnvironmentToken(match[1], environmentValue))
        .filter(Boolean);
      environmentName = names.find((name) => index.has(name.toLowerCase())) || null;
      if (environmentName) {
        matchType = 'exact';
        break;
      }
    }
  }

  if (!environmentName) {
    const candidates = [...new Set(
      [...yaml.matchAll(/^\s*(?:environment|name):\s*['"]?([A-Za-z0-9._-]*env[A-Za-z0-9._-]*)['"]?\s*$/gm)]
        .map((match) => match[1])
    )].filter((name) => !name.includes('$'));
    environmentName = matchEnvironmentName(candidates, environmentValue);
    matchType = environmentName ? 'fuzzy' : null;
  }
  if (!environmentName) return { acceptedEnvironments, environmentName: null, requiresApproval: null, approvers: [] };

  const environmentId = index.get(environmentName.toLowerCase());
  if (!environmentId) return { environmentName, matchType, acceptedEnvironments, requiresApproval: null, approvers: [] };

  const checks = await fetchJson(
    `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
      project
    )}/_apis/pipelines/checks/configurations?resourceType=environment&resourceId=${environmentId}&$expand=settings&api-version=7.1-preview.1`,
    token,
    'Environment checks were not found.'
  );
  const approvalChecks = (checks.value || []).filter((check) => check.type?.name === 'Approval');
  const approvers = [...new Set(approvalChecks.flatMap((check) =>
    (check.settings?.approvers || []).map((approver) => approver.displayName).filter(Boolean)))];

  return {
    environmentName,
    matchType,
    acceptedEnvironments,
    requiresApproval: approvalChecks.length > 0,
    approvers,
    minRequiredApprovers: approvalChecks[0]?.settings?.minRequiredApprovers ?? null
  };
}

async function queueBuild({
  organization,
  project,
  definitionId,
  sourceBranch,
  parameters = {},
  templateParameters = {},
  token
}) {
  const apiUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/build/builds?api-version=${API_VERSION}`;
  const refName = sourceBranch.startsWith('refs/heads/') ? sourceBranch : `refs/heads/${sourceBranch}`;
  const data = await requestJson(apiUrl, token, {
    method: 'POST',
    body: {
      definition: { id: Number(definitionId) },
      sourceBranch: refName,
      parameters: JSON.stringify(parameters),
      templateParameters
    }
  });
  const normalized = normalizeStatus(data.status, data.result, 'Build');
  return {
    ...normalized,
    buildId: data.id,
    buildNumber: data.buildNumber || null,
    pipelineName: data.definition?.name || null,
    sourceBranch: data.sourceBranch || refName,
    sourceVersion: data.sourceVersion || null,
    webUrl: data._links?.web?.href ||
      `https://dev.azure.com/${organization}/${project}/_build/results?buildId=${data.id}`
  };
}

async function createReleaseAndDeploy({
  organization,
  project,
  releaseDefinitionId,
  artifactAlias,
  environmentDefinitionId,
  environmentDefinitionIds,
  buildId,
  buildNumber,
  sourceBranch,
  sourceVersion,
  token
}) {
  const baseUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
  const requestedEnvironmentIds = normalizeEnvironmentIds(
    environmentDefinitionIds || environmentDefinitionId
  );
  // manualEnvironments takes stage NAMES, not ids — sending ids fails with VS402919.
  const definition = await fetchJson(
    `${baseUrl}/_apis/release/definitions/${encodeURIComponent(releaseDefinitionId)}?api-version=${API_VERSION}`,
    token,
    'Release definition was not found.'
  );
  const manualEnvironments = requestedEnvironmentIds.map((id) => {
    const environment = (definition.environments || []).find((item) => Number(item.id) === Number(id));
    if (!environment?.name) {
      throw new Error(`Stage ${id} is not part of release definition "${definition.name || releaseDefinitionId}".`);
    }
    return environment.name;
  });
  const release = await requestJson(`${baseUrl}/_apis/release/releases?api-version=${API_VERSION}`, token, {
    method: 'POST',
    body: {
      definitionId: Number(releaseDefinitionId),
      description: 'Queued by Deployment Tracker',
      isDraft: false,
      reason: 'manual',
      manualEnvironments,
      artifacts: [{
        alias: artifactAlias,
        instanceReference: {
          id: String(buildId),
          name: buildNumber,
          sourceBranch,
          sourceVersion
        }
      }]
    }
  });
  const environmentRuns = await deployReleaseEnvironments({
    baseUrl,
    release,
    requestedEnvironmentIds,
    token
  });
  const normalized = aggregateReleaseRuns(environmentRuns);
  const primary = environmentRuns[0];
  return {
    ...normalized,
    releaseId: release.id,
    environmentId: primary.environmentId,
    runNumber: release.name || String(release.id),
    pipelineName: release.releaseDefinition?.name || null,
    webUrl: primary.webUrl,
    environmentRuns
  };
}

async function findPackageVersion({ organization, project, feedId, packageId, packageName, version, token }) {
  const feedPath = `/_apis/packaging/feeds/${encodeURIComponent(feedId)}`;
  const suffix = `${feedPath}/packages?packageNameQuery=${encodeURIComponent(
    packageName
  )}&includeAllVersions=true&api-version=7.1-preview.1`;
  let data;
  let scopeBase;
  try {
    scopeBase = `https://feeds.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
    data = await fetchJson(
      `${scopeBase}${suffix}`,
      token,
      'Project-scoped Azure Artifacts feed not found.'
    );
  } catch {
    scopeBase = `https://feeds.dev.azure.com/${encodeURIComponent(organization)}`;
    data = await fetchJson(
      `${scopeBase}${suffix}`,
      token,
      'Azure Artifacts feed not found. Check Packaging (Read) scope.'
    );
  }
  if (packageId) {
    const versionData = await fetchJson(
      `${scopeBase}${feedPath}/packages/${encodeURIComponent(packageId)}/versions?includeUrls=false&api-version=7.1-preview.1`,
      token,
      'Package versions could not be read. Check Packaging (Read) scope.'
    );
    const match = findVersion(versionData.value, version);
    if (match) {
      return {
        packageId,
        packageName,
        versionId: match.id || match.version || match.normalizedVersion,
        version: match.version || match.normalizedVersion
      };
    }
  }

  for (const packageItem of data.value || []) {
    if (String(packageItem.name).toLowerCase() !== String(packageName).toLowerCase()) continue;
    let versions = packageItem.versions || [];
    if (!versions.length && packageItem.id) {
      const versionData = await fetchJson(
        `${scopeBase}${feedPath}/packages/${encodeURIComponent(packageItem.id)}/versions?includeUrls=false&api-version=7.1-preview.1`,
        token,
        'Package versions could not be read. Check Packaging (Read) scope.'
      );
      versions = versionData.value || [];
    }
    const match = findVersion(versions, version);
    if (match) {
      return {
        packageId: packageItem.id,
        packageName: packageItem.name,
        versionId: match.id || match.version || match.normalizedVersion,
        version: match.version || match.normalizedVersion
      };
    }
  }
  return null;
}

async function fetchPackageVersions({ organization, project, feedId, packageId, token }) {
  const feedPath = `/_apis/packaging/feeds/${encodeURIComponent(feedId)}`;
  const suffix = `${feedPath}/packages/${encodeURIComponent(packageId)}/versions?includeUrls=false&api-version=7.1-preview.1`;
  let data;
  try {
    data = await fetchJson(
      `https://feeds.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}${suffix}`,
      token,
      'Project-scoped package versions were not found.'
    );
  } catch {
    data = await fetchJson(
      `https://feeds.dev.azure.com/${encodeURIComponent(organization)}${suffix}`,
      token,
      'Package versions were not found. Check Packaging (Read) scope.'
    );
  }
  return (data.value || []).map((item) => item.version || item.normalizedVersion)
    .filter(Boolean)
    .sort(compareVersionsDescending);
}

function compareVersionsDescending(left, right) {
  const leftParts = String(left).split(/[.-]/).map((part) => Number(part) || 0);
  const rightParts = String(right).split(/[.-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference) return difference;
  }
  return String(right).localeCompare(String(left));
}

function findVersion(versions, requestedVersion) {
  return (versions || []).find((item) =>
    String(item.version || item.normalizedVersion).toLowerCase() === String(requestedVersion).toLowerCase()
  );
}

async function createPackageReleaseAndDeploy({
  organization,
  project,
  releaseDefinitionId,
  artifactAlias,
  environmentDefinitionId,
  environmentDefinitionIds,
  packageVersion,
  token
}) {
  const baseUrl = `https://vsrm.dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
  const requestedEnvironmentIds = normalizeEnvironmentIds(
    environmentDefinitionIds || environmentDefinitionId
  );
  const release = await requestJson(`${baseUrl}/_apis/release/releases?api-version=${API_VERSION}`, token, {
    method: 'POST',
    body: {
      definitionId: Number(releaseDefinitionId),
      description: `Queued by Deployment Tracker for package ${packageVersion}`,
      isDraft: false,
      reason: 'manual',
      manualEnvironments: requestedEnvironmentIds,
      artifacts: [{
        alias: artifactAlias,
        instanceReference: { id: packageVersion, name: packageVersion }
      }]
    }
  });
  const environmentRuns = await deployReleaseEnvironments({
    baseUrl,
    release,
    requestedEnvironmentIds,
    token
  });
  const normalized = aggregateReleaseRuns(environmentRuns);
  const primary = environmentRuns[0];
  return {
    ...normalized,
    releaseId: release.id,
    environmentId: primary.environmentId,
    runNumber: release.name || String(release.id),
    pipelineName: release.releaseDefinition?.name || null,
    webUrl: primary.webUrl,
    environmentRuns
  };
}

async function deployReleaseEnvironments({ baseUrl, release, requestedEnvironmentIds, token }) {
  const environments = (release.environments || []).filter((item) =>
    requestedEnvironmentIds.includes(Number(item.definitionEnvironmentId))
  );
  if (environments.length !== requestedEnvironmentIds.length) {
    throw new Error('Azure created the release, but one or more selected environments were not found in it.');
  }
  return Promise.all(environments.map(async (environment) => {
    let deployed = environment;
    if (!['inProgress', 'succeeded', 'partiallySucceeded'].includes(environment.status)) {
      deployed = await requestJson(
        `${baseUrl}/_apis/release/releases/${encodeURIComponent(release.id)}/environments/${encodeURIComponent(
          environment.id
        )}?api-version=${API_VERSION}`,
        token,
        { method: 'PATCH', body: { status: 'inProgress', comment: 'Queued by Deployment Tracker' } }
      );
    }
    return {
      ...normalizeReleaseEnvironment(deployed),
      environmentId: environment.id,
      environmentDefinitionId: environment.definitionEnvironmentId,
      environmentName: environment.name || deployed.name || null,
      webUrl: `${baseUrl.replace('https://vsrm.dev.azure.com/', 'https://dev.azure.com/')}/_releaseProgress?_a=release-environment-logs&releaseId=${release.id}&environmentId=${environment.id}`
    };
  }));
}

function normalizeEnvironmentIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(Number).filter(Number.isFinite))];
}

function summarizeBuild(build) {
  return {
    definitionId: build.definition?.id || null,
    definitionName: build.definition?.name || null,
    buildId: build.id || null,
    buildNumber: build.buildNumber || null,
    sourceBranch: build.sourceBranch || null,
    repository: build.repository ? {
      id: build.repository.id || null,
      name: build.repository.name || null,
      type: build.repository.type || null
    } : null,
    parameters: sanitizeParameters(parseParameterObject(build.parameters)),
    templateParameters: sanitizeParameters(build.templateParameters || {})
  };
}

function parseParameterObject(parameters) {
  if (!parameters) return {};
  if (typeof parameters === 'object') return parameters;
  try {
    return JSON.parse(parameters);
  } catch {
    return {};
  }
}

function sanitizeParameters(parameters) {
  return Object.fromEntries(Object.entries(parameters).map(([name, value]) => [
    name,
    /(password|secret|token|key|credential)/i.test(name) ? '[redacted]' : value
  ]));
}

function normalizeStatus(status, result, label) {
  if (status === 'notStarted' || status === 'queued' || status === 'scheduled') {
    return { status: 'queued', message: 'Queued, waiting to start.' };
  }
  if (
    status !== 'completed' &&
    !['succeeded', 'partiallySucceeded', 'rejected', 'canceled'].includes(status)
  ) {
    return { status: 'running', message: `${label} in progress...` };
  }

  const outcome = result || status;
  switch (outcome) {
    case 'succeeded':
      return { status: 'succeeded', message: null };
    case 'partiallySucceeded':
      return { status: 'warning', message: 'Completed with warnings/partial success.' };
    case 'canceled':
      return { status: 'failed', message: `${label} was canceled.` };
    case 'rejected':
      return { status: 'failed', message: `${label} was rejected.` };
    case 'failed':
      return { status: 'failed', message: `${label} failed.` };
    default:
      return { status: 'failed', message: `Unexpected result: ${outcome || 'unknown'}` };
  }
}

function normalizeReleaseEnvironment(environment) {
  const approvals = [
    ...(environment.preDeployApprovals || []),
    ...(environment.postDeployApprovals || []),
    ...(environment.deploySteps || []).flatMap((step) => [
      ...(step.preDeployApprovals || []),
      ...(step.postDeployApprovals || [])
    ])
  ];
  const pending = approvals.find(
    (approval) => String(approval.status || '').toLowerCase() === 'pending'
  );
  if (pending) {
    const approver = pending.approver?.displayName || pending.approvedBy?.displayName;
    return {
      status: 'awaitingApproval',
      message: approver ? `Awaiting approval from ${approver}.` : 'Awaiting DevOps/AppAdmin approval.'
    };
  }
  return normalizeStatus(environment.status, null, 'Release');
}

module.exports = {
  parsePipelineUrl,
  fetchRunStatus,
  fetchBuildStatus,
  fetchReleaseStatus,
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
  extractEnvironmentMap,
  deployExistingReleaseEnvironment,
  queueBuild,
  createReleaseAndDeploy,
  findPackageVersion,
  fetchPackageVersions,
  createPackageReleaseAndDeploy,
  normalizeReleaseEnvironment,
  normalizeStatus
};
