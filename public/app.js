const TOKEN_KEY = 'ado_pat_token';
const AUTO_REFRESH_KEY = 'auto_refresh_enabled';

const patInput = document.getElementById('pat-input');
const saveTokenBtn = document.getElementById('save-token-btn');
const refreshAllBtn = document.getElementById('refresh-all-btn');
const copyApprovalLinksBtn = document.getElementById('copy-approval-links-btn');
const queueLifecycleSelect = document.getElementById('queue-lifecycle');
const resetAllBtn = document.getElementById('reset-all-btn');
const clearAllBtn = document.getElementById('clear-all-btn');
const autoRefreshToggle = document.getElementById('auto-refresh-toggle');
const deploymentNameInput = document.getElementById('deployment-name');
const saveDeploymentNameBtn = document.getElementById('save-deployment-name-btn');
const newDeploymentBtn = document.getElementById('new-deployment-btn');
const historySelect = document.getElementById('history-select');
const deploymentSaveState = document.getElementById('deployment-save-state');
const groupsEl = document.getElementById('groups');
const summaryEl = document.getElementById('summary');
const groupOptionsEl = document.getElementById('group-options');
const addServiceForm = document.getElementById('add-service-form');
const bulkImportForm = document.getElementById('bulk-import-form');
const bulkImportText = document.getElementById('bulk-import-text');
const bulkImportReview = document.getElementById('bulk-import-review');
const bulkImportBtn = document.getElementById('bulk-import-btn');
const cleanRunBtn = document.getElementById('clean-run-btn');
const editImportBtn = document.getElementById('edit-import-btn');
const bulkImportResult = document.getElementById('bulk-import-result');

let state = { groups: [], deployment: null, history: [] };
let autoRefreshTimer = null;
let refreshAllInProgress = false;
let queueAllInProgress = false;
const loadedBranchScopes = new Set();
const queueSelections = {
  regionalBranch: '',
  globalBranch: '',
  regionalRegion: 'NA',
  widgetVersion: ''
};
const refreshingIds = new Set();
const latestReleases = {};
const forceRebuild = {};
let widgetVersions = [];
const branchOptions = { Regional: [], Global: [] };

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function initToken() {
  const saved = getToken();
  if (saved) patInput.value = saved;
  renderTokenState();
}

function renderTokenState(message) {
  const el = document.getElementById('token-state');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.className = 'token-state bad';
    return;
  }
  const saved = getToken();
  el.textContent = saved ? 'Token saved' : 'No token saved';
  el.className = `token-state ${saved ? 'good' : 'bad'}`;
}

saveTokenBtn.addEventListener('click', () => {
  localStorage.setItem(TOKEN_KEY, patInput.value.trim());
  saveTokenBtn.textContent = 'Saved!';
  renderTokenState();
  setTimeout(() => (saveTokenBtn.textContent = 'Save'), 1200);
});

const STATUS_LABEL = {
  idle: 'Not started',
  queued: 'Queued',
  awaitingApproval: 'Awaiting approval',
  running: 'Running',
  succeeded: 'Succeeded',
  warning: 'Warning',
  failed: 'Failed',
  error: 'Error'
};

async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.error || `Request failed: ${res.status}`;
    if (/rejected the token|PAT/i.test(message)) {
      renderTokenState('Token expired or rejected — paste a new one');
    }
    throw new Error(message);
  }
  return res.json();
}

async function loadState() {
  state = await api('/state');
  applyDefaultBranches();
  render();
  await loadQueueBranches();
  await loadWidgetVersions();
}

function defaultBranchForScope(scope) {
  const group = state.groups.find((item) => item.name === scope);
  for (const service of group?.services || []) {
    const config = state.queueConfigs?.[String(service.id)];
    if (config?.defaultBranch) return config.defaultBranch.replace(/^refs\/heads\//, '');
  }
  return '';
}

function applyDefaultBranches() {
  if (!queueSelections.regionalBranch) queueSelections.regionalBranch = defaultBranchForScope('Regional');
  if (!queueSelections.globalBranch) queueSelections.globalBranch = defaultBranchForScope('Global');
}

function allServices() {
  return state.groups.flatMap((g) => g.services);
}

function renderSummary() {
  const services = allServices();
  const counts = {
    succeeded: 0,
    failed: 0,
    error: 0,
    running: 0,
    queued: 0,
    awaitingApproval: 0,
    warning: 0,
    idle: 0
  };
  for (const s of services) counts[s.status] = (counts[s.status] || 0) + 1;

  const chips = [
    ['succeeded', 'Deployed', 'var(--green)'],
    ['running', 'In progress', 'var(--blue)'],
    ['queued', 'Queued', 'var(--blue)'],
    ['awaitingApproval', 'Awaiting approval', 'var(--yellow)'],
    ['warning', 'Warnings', 'var(--orange)'],
    ['failed', 'Failed', 'var(--red)'],
    ['error', 'Errors', 'var(--red)'],
    ['idle', 'Not started', 'var(--gray)']
  ];

  summaryEl.innerHTML = chips
    .map(
      ([key, label, color]) => `
      <div class="chip">
        <span class="count" style="color:${color}">${counts[key] || 0}</span>
        <span>${label}</span>
      </div>`
    )
    .join('') + `<div class="chip"><span class="count">${services.length}</span><span>Total services</span></div>`;

  const approvals = approvalLinks();
  copyApprovalLinksBtn.disabled = approvals.length === 0;
  copyApprovalLinksBtn.textContent = `Copy approval links (${approvals.length})`;
}

copyApprovalLinksBtn.addEventListener('click', async () => {
  const approvals = approvalLinks();
  if (!approvals.length) return;
  const heading = `Approval required for ${state.deployment?.name || 'deployment'}:`;
  const text = [
    heading,
    ...approvals.map((approval) =>
      `- ${approval.serviceName}${approval.environmentName ? ` (${approval.environmentName})` : ''}: ${approval.url}`
    )
  ].join('\n');
  await copyText(text);
  copyApprovalLinksBtn.textContent = `Copied ${approvals.length} approval link${approvals.length === 1 ? '' : 's'}`;
  setTimeout(() => renderSummary(), 1500);
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function approvalLinks() {
  return allServices().flatMap((service) => {
    const environmentApprovals = (service.queueOperation?.releaseEnvironments || [])
      .filter((environment) => environment.status === 'awaitingApproval' && environment.webUrl)
      .map((environment) => ({
        serviceName: service.name,
        environmentName: environment.environmentName,
        url: environment.webUrl
      }));
    if (environmentApprovals.length) return environmentApprovals;
    if (service.status === 'awaitingApproval' && (service.webUrl || service.pipelineUrl)) {
      return [{ serviceName: service.name, environmentName: null, url: service.webUrl || service.pipelineUrl }];
    }
    return [];
  });
}

function renderDeploymentControls() {
  if (document.activeElement !== deploymentNameInput) {
    deploymentNameInput.value = state.deployment?.name || '';
  }
  historySelect.innerHTML = '<option value="">Previous deployments...</option>' +
    (state.history || []).map((deployment) => {
      const date = new Date(deployment.updatedAt).toLocaleString();
      return `<option value="${deployment.id}">${escapeHtml(deployment.name)} · ${escapeHtml(date)}</option>`;
    }).join('');
  const saveState = !state.deployment?.isSaved
    ? ['New deployment', 'deployment-new']
    : state.deployment.isDirty
      ? ['Unsaved changes', 'deployment-dirty']
      : ['Saved', 'deployment-saved'];
  deploymentSaveState.textContent = saveState[0];
  deploymentSaveState.className = `deployment-save-state ${saveState[1]}`;
}

function renderQueueControls() {
  const lifecycle = queueLifecycleSelect.value;
  const regionalButton = document.getElementById('queue-regional-btn');
  const globalButton = document.getElementById('queue-global-btn');
  const widgetButton = document.getElementById('queue-widget-btn');
  const regionSelect = document.getElementById('queue-regional-region');
  if (regionSelect) regionSelect.disabled = lifecycle !== 'Production';

  for (const scope of ['Regional', 'Global']) {
    const branchSelect = document.getElementById(`queue-${scope.toLowerCase()}-branch`);
    const firstConfig = configuredServices(scope)[0]?.config;
    const key = `${scope.toLowerCase()}Branch`;
    if (!branchSelect) continue;
    const current = queueSelections[key] || firstConfig?.defaultBranch?.replace(/^refs\/heads\//, '') || '';
    const all = branchOptions[scope].length ? branchOptions[scope] : [current].filter(Boolean);
    const release = all.filter((branch) => /^release\//i.test(branch));
    const others = all.filter((branch) => !/^release\//i.test(branch));
    const option = (branch) =>
      `<option value="${escapeHtml(branch)}" ${branch === current ? 'selected' : ''}>${escapeHtml(branch)}</option>`;
    branchSelect.innerHTML = release.length
      ? `<optgroup label="Release branches">${release.map(option).join('')}</optgroup>` +
        `<optgroup label="All branches">${others.map(option).join('')}</optgroup>`
      : all.map(option).join('');
    if (all.includes(current)) branchSelect.value = current;
  }

  const packageConfig = configuredServices('Global Widget')[0]?.config;
  const packageSelect = document.getElementById('queue-widget-version');
  if (packageSelect) {
    const version = queueSelections.widgetVersion || packageConfig?.defaultPackageVersion || '';
    const available = widgetVersions.length ? widgetVersions : [version].filter(Boolean);
    packageSelect.innerHTML = available.map((item) =>
      `<option value="${escapeHtml(item)}" ${item === version ? 'selected' : ''}>${escapeHtml(item)}</option>`
    ).join('');
    if (available.includes(version)) packageSelect.value = version;
  }
  if (regionSelect) regionSelect.value = queueSelections.regionalRegion;

  const regionalCount = applicableServices('Regional').length;
  const globalCount = applicableServices('Global').length;
  const widgetCount = applicableServices('Global Widget').length;
  if (regionalButton) {
    regionalButton.disabled = !regionalCount || queueAllInProgress;
    regionalButton.textContent = `Queue all Regional (${regionalCount})`;
  }
  if (globalButton) {
    globalButton.disabled = !globalCount || queueAllInProgress;
    globalButton.textContent = `Queue all Global (${globalCount})`;
  }
  if (widgetButton) {
    widgetButton.disabled = !widgetCount || queueAllInProgress;
    widgetButton.textContent = 'Queue Widget';
  }
}

function configuredServices(scope) {
  return (state.groups.find((group) => group.name === scope)?.services || [])
    .map((service) => ({ service, config: state.queueConfigs?.[String(service.id)] }))
    .filter((item) => item.config);
}

function applicableServices(scope) {
  return configuredServices(scope).filter(({ config }) =>
    isLifecycleApplicable(config, queueLifecycleSelect.value)
  );
}

function isLifecycleApplicable(config, lifecycle) {
  return !Array.isArray(config.applicableLifecycles) || config.applicableLifecycles.includes(lifecycle);
}

queueLifecycleSelect.addEventListener('change', renderQueueControls);

function statusBadge(svc) {
  const status = svc.status || 'idle';
  const label = STATUS_LABEL[status] || status;
  return `<span class="status-badge status-${status}"><span class="dot"></span>${label}</span>`;
}

function renderGroups() {
  groupOptionsEl.innerHTML = state.groups.map((g) => `<option value="${escapeHtml(g.name)}"></option>`).join('');

  groupsEl.innerHTML = state.groups
    .map((group) => {
      const total = group.services.length;
      const done = group.services.filter((s) => s.status === 'succeeded').length;
      const scope = group.name.toLowerCase() === 'regional'
        ? {
            className: 'group-scope-regional',
            description: 'AG services · region applies for production deployments'
          }
        : group.name.toLowerCase() === 'global widget'
          ? {
              className: 'group-scope-widget',
              description: 'Package-driven Global Widget release'
            }
          : group.name.toLowerCase() === 'global'
          ? {
              className: 'group-scope-global',
              description: 'Global services · deploy across all required regions'
            }
          : { className: '', description: '' };
      return `
      <div class="group-card ${scope.className}">
        <div class="group-header">
          <div>
            <h3>${escapeHtml(group.name)}</h3>
            ${scope.description ? `<div class="group-description">${scope.description}</div>` : ''}
          </div>
          <div class="group-header-actions">
            ${renderGroupQueueControls(group.name)}
            <span class="group-progress">${done}/${total} deployed</span>
          </div>
        </div>
        ${renderGroupBody(group)}
      </div>`;
    })
    .join('');

  // wire up events
  document.querySelectorAll('[data-action="save-url"]').forEach((el) => {
    el.addEventListener('change', (e) => saveUrl(e.target.dataset.id, e.target.value));
  });
  document.querySelectorAll('[data-action="refresh"]').forEach((el) => {
    el.addEventListener('click', (e) => refreshService(e.currentTarget.dataset.id));
  });
  document.querySelectorAll('[data-action="delete"]').forEach((el) => {
    el.addEventListener('click', (e) => deleteService(e.currentTarget.dataset.id));
  });
  document.querySelectorAll('[data-action="rename"]').forEach((el) => {
    el.addEventListener('click', (e) => renameService(e.currentTarget.dataset.id));
  });
  document.querySelectorAll('[data-action="correct-pipeline"]').forEach((el) => {
    el.addEventListener('click', (e) => correctPipeline(e.currentTarget.dataset.id));
  });
  document.querySelectorAll('[data-action="queue"]').forEach((el) => {
    el.addEventListener('click', (e) => queueService(e.currentTarget.dataset.id));
  });
  document.querySelectorAll('[data-action="load-releases"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const key = e.currentTarget.dataset.key;
      const ids = allServices()
        .filter((svc) => String(state.queueConfigs?.[String(svc.id)]?.buildDefinitionId) === key)
        .map((svc) => svc.id);
      loadLatestReleases(ids);
    });
  });
  document.querySelectorAll('[data-action="force-rebuild"]').forEach((el) => {
    el.addEventListener('change', (e) => {
      forceRebuild[e.currentTarget.dataset.key] = e.currentTarget.checked;
    });
  });
  document.getElementById('queue-regional-btn')?.addEventListener('click', () => queueScope('Regional'));
  document.getElementById('queue-regional-preview')?.addEventListener('click', () => previewScope('Regional'));
  document.getElementById('queue-global-preview')?.addEventListener('click', () => previewScope('Global'));  document.getElementById('queue-global-btn')?.addEventListener('click', () => queueScope('Global'));
  document.getElementById('queue-widget-btn')?.addEventListener('click', () => {
    const widget = state.groups.find((group) => group.name === 'Global Widget')?.services[0];
    if (widget) queueService(widget.id);
  });
  document.getElementById('queue-regional-branch')?.addEventListener('change', (event) => {
    queueSelections.regionalBranch = event.target.value;
  });
  document.getElementById('queue-global-branch')?.addEventListener('change', (event) => {
    queueSelections.globalBranch = event.target.value;
  });
  document.getElementById('queue-regional-region')?.addEventListener('change', (event) => {
    queueSelections.regionalRegion = event.target.value;
  });
  document.getElementById('queue-widget-version')?.addEventListener('change', (event) => {
    queueSelections.widgetVersion = event.target.value;
  });
}


function pipelineBlocks(group) {
  const blocks = new Map();
  const standalone = [];
  for (const service of group.services) {
    const config = state.queueConfigs?.[String(service.id)];
    if (config?.type !== 'build-release') {
      standalone.push(service);
      continue;
    }
    const key = String(config.buildDefinitionId);
    if (!blocks.has(key)) {
      blocks.set(key, {
        key,
        name: config.monoRepoName || config.buildDefinitionName,
        buildUrl: `https://dev.azure.com/${config.organization}/${config.project}/_build?definitionId=${config.buildDefinitionId}`,
        services: []
      });
    }
    blocks.get(key).services.push(service);
  }
  return { blocks: [...blocks.values()], standalone };
}

function formatWhen(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderLatestRelease(serviceId) {
  const info = latestReleases[String(serviceId)];
  if (!info) return '<div class="latest-release muted">Latest release not loaded</div>';
  if (info.loading) return '<div class="latest-release muted">Loading latest release…</div>';
  if (info.error) return `<div class="latest-release muted">${escapeHtml(info.error)}</div>`;
  if (!info.release) return '<div class="latest-release muted">No release found for this branch</div>';

  const release = info.release;
  const last = release.lastDeployed;
  return `<div class="latest-release">
    <a href="${escapeHtml(release.webUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(release.releaseName)}</a>
    <span class="muted">build ${escapeHtml(String(release.buildNumber || '—'))}</span>
    ${last ? `<span class="latest-env status-${escapeHtml(last.status)}">${escapeHtml(last.name)}</span>
      <span class="muted">${escapeHtml(formatWhen(last.deployedAt))}</span>` : '<span class="muted">not deployed yet</span>'}
  </div>`;
}

function renderGroupBody(group) {
  const { blocks, standalone } = pipelineBlocks(group);
  return `
    ${blocks.map((block) => `
      <div class="pipeline-block">
        <div class="pipeline-block-header">
          <div class="pipeline-block-title">
            <a href="${escapeHtml(block.buildUrl)}" target="_blank" rel="noopener">${escapeHtml(block.name)}</a>
            <span class="muted">${block.services.length} services</span>
          </div>
          <div class="pipeline-block-actions">
            <label class="force-rebuild">
              <input type="checkbox" data-action="force-rebuild" data-key="${escapeHtml(block.key)}"
                ${forceRebuild[block.key] ? 'checked' : ''} />
              Force new build and release
            </label>
            <button class="btn btn-ghost" data-action="load-releases" data-key="${escapeHtml(block.key)}">Reload releases</button>
          </div>
        </div>
        ${block.services.map((svc) => serviceRow(svc)).join('')}
      </div>`).join('')}
    ${standalone.map((svc) => serviceRow(svc)).join('')}`;
}

async function loadLatestReleases(serviceIds) {
  const token = getToken();
  if (!token) return;
  const targets = serviceIds.filter((id) => state.queueConfigs?.[String(id)]?.type === 'build-release');
  if (!targets.length) return;

  for (const id of targets) latestReleases[String(id)] = { loading: true };
  render();

  await Promise.all(targets.map(async (id) => {
    const service = allServices().find((item) => String(item.id) === String(id));
    const scope = state.groups.find((g) => g.services.some((item) => item.id === service?.id))?.name;
    const branch = scope === 'Global' ? queueSelections.globalBranch : queueSelections.regionalBranch;
    if (!branch) {
      latestReleases[String(id)] = { error: 'Select a branch first' };
      return;
    }
    try {
      const result = await api(`/services/${id}/latest-release`, {
        method: 'POST',
        body: JSON.stringify({ token, branch })
      });
      latestReleases[String(id)] = { release: result.release, branch: result.branch };
    } catch (err) {
      latestReleases[String(id)] = { error: err.message };
    }
  }));
  render();
}

// The board stays blocked until every release-backed row knows its current release.
async function showBoard() {
  exitWizard();
  const ids = allServices()
    .filter((svc) => state.queueConfigs?.[String(svc.id)]?.type === 'build-release')
    .map((svc) => svc.id);
  if (!ids.length || !getToken()) return;
  const overlay = document.getElementById('loading-overlay');
  overlay.hidden = false;
  try {
    await loadLatestReleases(ids);
  } finally {
    overlay.hidden = true;
  }
}

function renderGroupQueueControls(groupName) {
  if (groupName === 'Regional') {
    return `
      <label for="queue-regional-branch">Branch</label>
      <select id="queue-regional-branch"></select>
      <label for="queue-regional-region">Production region</label>
      <select id="queue-regional-region" ${queueLifecycleSelect.value === 'Production' ? '' : 'disabled'}>
        <option value="NA" selected>NA</option><option value="EMEA">EMEA</option><option value="APAC">APAC</option>
      </select>
      <button id="queue-regional-preview" class="btn btn-secondary">Dry run</button>
      <button id="queue-regional-btn" class="btn btn-primary">Queue all Regional</button>`;
  }
  if (groupName === 'Global Widget') {
    return `
      <label for="queue-widget-version">Package version</label>
      <select id="queue-widget-version"></select>
      <button id="queue-widget-btn" class="btn btn-primary">Queue Widget</button>`;
  }
  if (groupName === 'Global') {
    return `
      <label for="queue-global-branch">Branch</label>
      <select id="queue-global-branch"></select>
      <button id="queue-global-preview" class="btn btn-secondary">Dry run</button>
      <button id="queue-global-btn" class="btn btn-primary">Queue all Global</button>`;
  }
  return '';
}

// Release-backed rows point at their release definition; build-only rows at the build pipeline.
function servicePipelineUrl(config) {
  if (!config?.organization) return null;
  const base = `https://dev.azure.com/${config.organization}/${config.project}`;
  if (config.releaseDefinitionId) {
    return `${base}/_release?_a=releases&view=mine&definitionId=${config.releaseDefinitionId}`;
  }
  if (config.buildDefinitionId) return `${base}/_build?definitionId=${config.buildDefinitionId}`;
  return null;
}

function serviceRow(svc) {
  const isRefreshing = refreshingIds.has(String(svc.id));
  const queueConfig = state.queueConfigs?.[String(svc.id)];
  const pipelineName = svc.pipelineName
    ? `<span class="pipeline-name" title="${escapeHtml(svc.pipelineName)}">[${escapeHtml(svc.pipelineName)}]</span>`
    : '';
  const pipelineNameApproved = (svc.acceptedPipelineNames || []).some(
    (name) => normalizeName(name) === normalizeName(svc.pipelineName)
  );
  const nameCheck = svc.pipelineName
    ? pipelineNameApproved
      ? '<div class="name-check name-match">Name approved</div>'
      : namesMatch(svc.name, svc.pipelineName)
        ? '<div class="name-check name-match">Name matches</div>'
        : `<div class="name-check name-mismatch">
            <span>Name mismatch: expected “${escapeHtml(svc.name)}”</span>
            <button class="btn btn-correct" data-action="correct-pipeline" data-id="${svc.id}"
              title="Approve this Azure pipeline name for future imports">Correct Pipeline</button>
          </div>`
    : '';
  const refreshContent = isRefreshing ? '<span class="spinner" aria-hidden="true"></span> Refreshing' : 'Refresh';

  return `
    <div class="service-row">
      <div>
        <div class="service-name">
          ${servicePipelineUrl(queueConfig)
            ? `<a class="application-name" href="${escapeHtml(servicePipelineUrl(queueConfig))}" target="_blank" rel="noopener">${escapeHtml(svc.name)}</a>`
            : `<span class="application-name">${escapeHtml(svc.name)}</span>`}
          ${pipelineName}
        </div>
        ${nameCheck}
      </div>
      <input type="url" placeholder="Paste build or release run URL..." value="${escapeHtml(svc.pipelineUrl || '')}"
        data-action="save-url" data-id="${svc.id}" />
      <div>
        ${renderRunLines(svc, queueConfig)}
      </div>
      <button class="btn btn-secondary btn-small refresh-btn" data-action="refresh" data-id="${svc.id}"
        ${isRefreshing ? 'disabled' : ''}>${refreshContent}</button>
      <div class="row-actions">
        <button class="btn btn-primary btn-small" data-action="queue" data-id="${svc.id}"
          ${queueConfig ? '' : 'disabled'} title="${queueConfig ? 'Queue this pipeline with the selected deployment settings' : 'Queue configuration has not been set up yet'}">${svc.pipelineUrl ? 'Rerun' : 'Queue pipeline'}</button>
        <button class="btn btn-secondary btn-small" data-action="rename" data-id="${svc.id}">Rename</button>
        <button class="btn btn-danger-outline btn-small" data-action="delete" data-id="${svc.id}">Remove</button>
      </div>
    </div>`;
}

function renderRunLines(svc, queueConfig) {
  if (queueConfig?.type === 'build-release') {
    const operation = svc.queueOperation;
    const releaseRun = svc.runType === 'release' ? {
      status: operation?.releaseStatus || svc.status,
      number: svc.runNumber,
      webUrl: operation?.releaseWebUrl || svc.webUrl,
      message: operation?.releaseMessage || svc.message
    } : null;
    return `
      ${renderLatestRelease(svc.id)}
      ${renderRunLine('Release', releaseRun, operation?.phase === 'build' ? 'Waiting for pipeline.' : 'Not queued.')}`;
  }
  return renderRunLine(svc.runType === 'release' ? 'Release Pipeline' : 'Pipeline', {
    status: svc.status,
    number: svc.runNumber,
    webUrl: svc.webUrl,
    message: svc.message
  }, 'Not queued.');
}

function renderRunLine(label, run, emptyMessage) {
  const normalizedRun = run || { status: 'idle' };
  const number = run?.number ? ` · ${escapeHtml(run.number)}` : '';
  const linkLabel = run?.status === 'failed' ? 'Open failure' : 'Open';
  const link = run?.webUrl
    ? ` <a class="run-link" href="${escapeHtml(run.webUrl)}" target="_blank" rel="noopener">${linkLabel}</a>`
    : '';
  const detail = run?.message || emptyMessage;
  return `
    <div class="run-line">
      <span class="run-kind">${label}</span>
      ${statusBadge(normalizedRun)}
      <span class="meta">${number}${link}${detail ? ` · ${escapeHtml(detail)}` : ''}</span>
    </div>`;
}

function namesMatch(expectedName, pipelineName) {
  const expected = normalizeName(expectedName.replace(/\s*\((NA|EMEA|APAC)\)\s*$/i, ''));
  const actual = normalizeName(pipelineName);
  return actual.includes(expected) || expected.includes(actual);
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function render() {
  captureQueueSelections();
  renderDeploymentControls();
  renderSummary();
  renderGroups();
  renderQueueControls();
}

function captureQueueSelections() {
  queueSelections.regionalBranch = document.getElementById('queue-regional-branch')?.value || queueSelections.regionalBranch;
  queueSelections.globalBranch = document.getElementById('queue-global-branch')?.value || queueSelections.globalBranch;
  queueSelections.regionalRegion = document.getElementById('queue-regional-region')?.value || queueSelections.regionalRegion;
  queueSelections.widgetVersion = document.getElementById('queue-widget-version')?.value || queueSelections.widgetVersion;
}

async function loadQueueBranches() {
  if (!getToken()) return;
  for (const scope of ['Regional', 'Global']) {
    if (loadedBranchScopes.has(scope)) continue;
    const services = configuredServices(scope);
    const configuredId = services[0]?.service.id;
    const defaults = [...new Set(services
      .map(({ config }) => config.defaultBranch?.replace(/^refs\/heads\//, ''))
      .filter(Boolean))];
    if (!configuredId) continue;
    try {
      const branches = await api(`/services/${configuredId}/branches`, {
        method: 'POST',
        body: JSON.stringify({ token: getToken() })
      });
      branchOptions[scope] = [...new Set([...defaults, ...branches])].sort((a, b) => a.localeCompare(b));
      loadedBranchScopes.add(scope);
    } catch {
      branchOptions[scope] = defaults;
    }
    renderQueueControls();
  }
}

async function loadWidgetVersions() {
  const widget = configuredServices('Global Widget')[0];
  const select = document.getElementById('queue-widget-version');
  if (!widget || !select || !getToken()) return;
  try {
    widgetVersions = await api(`/services/${widget.service.id}/package-versions`, {
      method: 'POST',
      body: JSON.stringify({ token: getToken() })
    });
    if (!queueSelections.widgetVersion) {
      queueSelections.widgetVersion = widget.config.defaultPackageVersion || widgetVersions[0] || '';
    }
    renderQueueControls();
  } catch {
    // Keep the verified default version when Packaging Read is unavailable.
  }
}

function selectedQueueValues(config, scope) {
  const branchInput = document.getElementById(`queue-${scope.toLowerCase()}-branch`);
  const branch = branchInput?.value.trim() || config.defaultBranch?.replace(/^refs\/heads\//, '') || '';
  if (config.type !== 'package-release' && !branch) throw new Error('Select or enter a branch first.');
  const packageVersion = document.getElementById('queue-widget-version')?.value.trim() || '';
  if (config.type === 'package-release' && !packageVersion) {
    throw new Error('Enter the Widget package version first.');
  }
  const lifecycle = queueLifecycleSelect.value;
  const region = scope === 'Regional' && lifecycle === 'Production'
    ? document.getElementById('queue-regional-region')?.value
    : null;
  if (scope === 'Regional' && lifecycle === 'Production' && !region) {
    throw new Error('Select NA, EMEA, or APAC for a Regional Production deployment.');
  }
  return { branch, lifecycle, region, packageVersion };
}

async function queueService(id, { skipConfirmation = false } = {}) {
  const service = allServices().find((item) => String(item.id) === String(id));
  const config = state.queueConfigs?.[String(id)];
  if (!service || !config) return;
  const scope = state.groups.find((group) =>
    group.services.some((item) => item.id === service.id)
  )?.name;
  let selected;
  try {
    selected = selectedQueueValues(config, scope);
  } catch (err) {
    alert(err.message);
    return;
  }
  if (!skipConfirmation && !confirm(
    `Queue ${service.name}?\n\n` +
    `${config.type === 'package-release' ? `Package: ${selected.packageVersion}` : `Branch: ${selected.branch}`}\n` +
    `Environment: ${selected.lifecycle}` +
    `${selected.region ? `\nRegion: ${selected.region}` : ''}`
  )) return;

  refreshingIds.add(String(id));
  render();
  try {
    await api(`/services/${id}/queue`, {
      method: 'POST',
      body: JSON.stringify({
        token: getToken(),
        branch: selected.branch,
        lifecycle: selected.lifecycle,
        region: selected.region,
        packageVersion: selected.packageVersion,
        forceNewBuild: forceRebuild[String(config.buildDefinitionId)] === true
      })
    });
  } finally {
    refreshingIds.delete(String(id));
    await loadState();
  }
}

const PREVIEW_LABEL = {
  'redeploy-release': 'Redeploy release',
  'queue-build': 'NEW build',
  'create-package-release': 'New package release',
  blocked: 'Blocked',
  skip: 'Skipped'
};

async function fetchPreview(scope) {
  const selected = selectedQueueValues(configuredServices(scope)[0]?.config, scope);
  return api('/preview', {
    method: 'POST',
    body: JSON.stringify({
      token: getToken(),
      scope,
      branch: selected.branch,
      lifecycle: selected.lifecycle,
      region: selected.region,
      packageVersion: selected.packageVersion,
      forceNewBuilds: Object.entries(forceRebuild).filter(([, f]) => f).map(([key]) => key)
    })
  });
}

function renderApprovers(approval) {
  if (!approval || approval.unknown) return '<span class="muted">—</span>';
  const approvers = approval.approvers || [];
  if (!approvers.length) return '<span class="muted">Not listed</span>';
  const label = (name) => name.replace(/^\[.*?\]\\/, '');
  const shown = approvers.slice(0, 3).map((name) =>
    `<span class="approver" title="${escapeHtml(name)}">${escapeHtml(label(name))}</span>`).join('');
  const extra = approvers.length > 3
    ? `<span class="approver more" title="${escapeHtml(approvers.slice(3).join(', '))}">+${approvers.length - 3}</span>`
    : '';
  return shown + extra;
}

function renderPreview(plan) {
  const gated = plan.steps.filter((step) => step.approval && !step.approval.unknown);
  document.getElementById('preview-context').innerHTML =
    `${escapeHtml(plan.scope)} · ${escapeHtml(plan.lifecycle)}${plan.region ? ` · ${escapeHtml(plan.region)}` : ''}${
      plan.branch ? ` · ${escapeHtml(plan.branch)}` : ''} — nothing has been queued.` +
    (gated.length
      ? `<br><span class="preview-approval-note">${gated.length} deployment${gated.length > 1 ? 's' : ''} will pause for manual approval in Azure DevOps.</span>`
      : '');
  document.getElementById('preview-body').innerHTML = `
    <table class="preview-table">
      <thead><tr><th>Service</th><th>Action</th><th>Details</th><th>Environment</th><th>Approval</th><th>Approvers</th></tr></thead>
      <tbody>${plan.steps.map((step) => `
        <tr class="preview-${escapeHtml(step.action)}">
          <td>${step.pipelineUrl
            ? `<a href="${escapeHtml(step.pipelineUrl)}" target="_blank" rel="noopener">${escapeHtml(step.service)}</a>`
            : escapeHtml(step.service)}</td>
          <td><span class="preview-tag preview-tag-${escapeHtml(step.action)}">${
            escapeHtml(PREVIEW_LABEL[step.action] || step.action)}</span></td>
          <td>${escapeHtml(step.detail || step.reason || '')}</td>
          <td>${escapeHtml(step.environments || '')}</td>
          <td>${step.approval
            ? `<span class="preview-tag preview-tag-${step.approval.unknown ? 'unknown' : 'approval'}" title="${
                escapeHtml(step.approval.text)}">${step.approval.unknown ? 'Unknown' : 'Approval needed'}</span>`
            : '<span class="muted">Automatic</span>'}</td>
          <td class="preview-approvers">${renderApprovers(step.approval)}</td>
        </tr>`).join('')}</tbody>
    </table>`;
  document.getElementById('preview-overlay').hidden = false;
}

async function previewScope(scope) {
  if (!getToken()) return alert('Save your Azure DevOps PAT first.');
  const overlay = document.getElementById('loading-overlay');
  overlay.hidden = false;
  try {
    renderPreview(await fetchPreview(scope));
  } catch (err) {
    alert(err.message);
  } finally {
    overlay.hidden = true;
  }
}

document.getElementById('preview-close-btn')?.addEventListener('click', () => {
  document.getElementById('preview-overlay').hidden = true;
});

async function queueScope(scope) {
  if (queueAllInProgress) return;
  const configured = state.groups.find((group) => group.name === scope)?.services
    .filter((service) => {
      const config = state.queueConfigs?.[String(service.id)];
      return config && isLifecycleApplicable(config, queueLifecycleSelect.value);
    }) || [];
  if (!configured.length) return;
  let selected;
  try {
    const selections = configured.map((service) =>
      selectedQueueValues(state.queueConfigs[String(service.id)], scope)
    );
    selected = selections[0];
  } catch (err) {
    alert(err.message);
    return;
  }
  if (!confirm(
    `Queue all ${scope} services?\n\n` +
    `Environment: ${selected.lifecycle}\n` +
    `${selected.region ? `Region: ${selected.region}\n` : ''}` +
    `Branch/version source: ${selected.branch}\n\n` +
    configured.map((service) => `• ${service.name}`).join('\n')
  )) return;

  queueAllInProgress = true;
  render();
  try {
    const result = await api('/queue-all', {
      method: 'POST',
      body: JSON.stringify({
        token: getToken(),
        scope,
        branch: selected.branch,
        lifecycle: selected.lifecycle,
        region: selected.region,
        packageVersion: selected.packageVersion,
        forceNewBuilds: Object.entries(forceRebuild)
          .filter(([, forced]) => forced)
          .map(([key]) => key)
      })
    });
    state = result.state;
  } finally {
    queueAllInProgress = false;
    render();
  }
}

async function saveUrl(id, pipelineUrl) {
  refreshingIds.add(String(id));
  render();
  try {
    await api(`/services/${id}/pipeline-url`, {
      method: 'POST',
      body: JSON.stringify({ pipelineUrl, token: getToken() })
    });
  } catch (err) {
    alert(err.message);
  } finally {
    refreshingIds.delete(String(id));
    await loadState();
  }
}

async function refreshService(id) {
  const token = getToken();
  if (!token) {
    alert('Paste and save your Azure DevOps personal access token first.');
    return;
  }
  const service = allServices().find((item) => String(item.id) === String(id));
  // Nothing has been queued yet, so show the current release instead of erroring.
  if (!service?.pipelineUrl && state.queueConfigs?.[String(id)]?.type === 'build-release') {
    await loadLatestReleases([id]);
    return;
  }
  refreshingIds.add(String(id));
  render();
  try {
    await api(`/services/${id}/refresh`, {
      method: 'POST',
      body: JSON.stringify({ token })
    });
  } finally {
    refreshingIds.delete(String(id));
    await loadState();
  }
}

async function deleteService(id) {
  if (!confirm('Remove this service from the tracker?')) return;
  await api(`/services/${id}`, { method: 'DELETE' });
  await loadState();
}

async function renameService(id) {
  const service = allServices().find((item) => String(item.id) === String(id));
  if (!service) return;
  const name = prompt('Rename service:', service.name)?.trim();
  if (!name || name === service.name) return;
  await api(`/services/${id}/name`, {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  await loadState();
}

async function correctPipeline(id) {
  state = await api(`/services/${id}/correct-pipeline`, { method: 'POST' });
  render();
}

refreshAllBtn.addEventListener('click', () => refreshAll());

async function refreshAll({ background = false } = {}) {
  if (refreshAllInProgress) return;
  const token = getToken();
  if (!token) {
    if (!background) alert('Paste and save your Azure DevOps personal access token first.');
    return;
  }
  const targets = allServices().filter((s) => s.pipelineUrl);
  refreshAllInProgress = true;
  for (const svc of targets) refreshingIds.add(String(svc.id));
  refreshAllBtn.disabled = true;
  refreshAllBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Refreshing';
  render();
  try {
    await Promise.allSettled(targets.map((svc) =>
      api(`/services/${svc.id}/refresh`, {
        method: 'POST',
        body: JSON.stringify({ token })
      })
    ));
    await loadState();
  } finally {
    refreshAllInProgress = false;
    refreshingIds.clear();
    refreshAllBtn.disabled = false;
    refreshAllBtn.textContent = 'Refresh all';
    render();
  }
}

resetAllBtn.addEventListener('click', async () => {
  if (!confirm('Reset statuses for this deployment? Its links will be kept.')) return;
  await api('/reset', { method: 'POST' });
  await loadState();
});

clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Remove every link and status from this deployment? Saved history will not be changed.')) return;
  await api('/clear', { method: 'POST' });
  await loadState();
});

saveDeploymentNameBtn.addEventListener('click', saveDeploymentName);

async function saveDeploymentName() {
  const name = deploymentNameInput.value.trim();
  if (!name) {
    alert('Enter a deployment name first.');
    deploymentNameInput.focus();
    return false;
  }
  state = await api('/deployment/name', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  render();
  saveDeploymentNameBtn.textContent = 'Name saved';
  setTimeout(() => (saveDeploymentNameBtn.textContent = 'Save name'), 1200);
  return true;
}

newDeploymentBtn.addEventListener('click', async () => {
  const currentName = deploymentNameInput.value.trim();
  if (currentName && currentName !== state.deployment?.name) {
    state = await api('/deployment/name', {
      method: 'POST',
      body: JSON.stringify({ name: currentName })
    });
  }

  let saveChanges = false;
  if (state.deployment?.isSaved && state.deployment?.isDirty) {
    saveChanges = confirm(
      `Save changes to “${state.deployment.name}” before starting a new deployment?\n\n` +
      'Choose Cancel to stay on this deployment.'
    );
    if (!saveChanges) {
      render();
      return;
    }
  }

  const suggestedName = `Deployment ${new Date().toLocaleDateString()}`;
  const name = prompt('Name the new deployment:', suggestedName)?.trim();
  if (!name) return;

  state = await api('/deployments', {
    method: 'POST',
    body: JSON.stringify({ name, saveChanges })
  });
  resetBulkImport();
  render();
});

historySelect.addEventListener('change', async () => {
  if (!historySelect.value) return;
  state = await api(`/deployments/${historySelect.value}/activate`, { method: 'POST' });
  resetBulkImport();
  render();
});

function resetBulkImport() {
  bulkImportText.value = '';
  bulkImportText.hidden = false;
  bulkImportReview.innerHTML = '';
  bulkImportReview.hidden = true;
  editImportBtn.hidden = true;
  bulkImportResult.hidden = true;
}

addServiceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const group = document.getElementById('new-group').value.trim();
  const name = document.getElementById('new-name').value.trim();
  if (!group || !name) return;
  await api('/services', { method: 'POST', body: JSON.stringify({ group, name }) });
  addServiceForm.reset();
  await loadState();
});

bulkImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await importUrls(false);
});

cleanRunBtn.addEventListener('click', async () => {
  if (!confirm('Clear all current service links, then import these URLs?')) return;
  await importUrls(true);
});

async function importUrls(cleanRun) {
  const sourceText = bulkImportText.value;
  if (!sourceText.trim()) {
    bulkImportText.hidden = false;
    bulkImportText.focus();
    return;
  }
  bulkImportBtn.disabled = true;
  cleanRunBtn.disabled = true;
  const activeButton = cleanRun ? cleanRunBtn : bulkImportBtn;
  activeButton.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${cleanRun ? 'Cleaning' : 'Matching'}`;
  bulkImportResult.hidden = true;

  try {
    const result = await api('/import', {
      method: 'POST',
      body: JSON.stringify({ text: sourceText, token: getToken(), cleanRun })
    });
    await loadState();
    renderBulkImportResult(result, sourceText);
  } catch (err) {
    bulkImportReview.hidden = true;
    bulkImportText.hidden = false;
    editImportBtn.hidden = true;
    bulkImportResult.innerHTML = `<p class="import-error">${escapeHtml(err.message)}</p>`;
    bulkImportResult.hidden = false;
  } finally {
    bulkImportBtn.disabled = false;
    cleanRunBtn.disabled = false;
    bulkImportBtn.textContent = 'Match and import';
    cleanRunBtn.textContent = 'Clean Run';
  }
}

editImportBtn.addEventListener('click', () => {
  bulkImportReview.hidden = true;
  bulkImportText.hidden = false;
  editImportBtn.hidden = true;
  bulkImportText.focus();
});

function renderBulkImportResult(result, sourceText) {
  const issueLabels = {
    'duplicate-url': 'Duplicate URL',
    'already-assigned': 'Already assigned',
    'replaced-url': 'Existing URL replaced',
    'duplicate-pipeline': 'Duplicate pipeline',
    'azure-name-mismatch': 'Azure name mismatch',
    'missing-azure-name': 'Azure name missing',
    'no-configured-service': 'No configured service',
    'missing-previous-service': 'Missing previous service',
    'azure-error': 'Azure lookup failed',
    'invalid-url': 'Invalid Azure URL',
    'unsupported-url': 'Unsupported URL'
  };
  const matchedNames = result.matched
    .map((item) => `${item.group} / ${item.name}${item.pipelineName ? ` [${item.pipelineName}]` : ''}`)
    .join('\n');
  const unmatchedText = result.unmatched
    .map((item) => {
      const azureName = item.pipelineName ? `\n  Azure returned: ${item.pipelineName}` : '';
      return `${item.label ? `${item.label}: ` : ''}${item.url}\n  ${item.reason}${azureName}`;
    })
    .join('\n\n');
  const linkedIssues = (result.issues || []).map((issue, index) => ({
    ...issue,
    linkKey: issue.url ? importLinkKey(issue.url) : `issue-${index}`
  }));
  const groupedIssues = groupImportIssues(linkedIssues, issueLabels);
  const renderIssueCard = (issue) => {
    const azureName = issue.pipelineName
      ? `<div class="issue-detail"><strong>Azure returned:</strong> ${escapeHtml(issue.pipelineName)}</div>`
      : '';
    const destinations = issue.destinations?.length
      ? `<div class="issue-detail"><strong>Rows:</strong> ${escapeHtml(issue.destinations.join(', '))}</div>`
      : '';
    const messages = issue.items.length === 1
      ? `<div>${escapeHtml(issue.items[0].message)}</div>`
      : issue.items.map((item) => `
          <div class="issue-subitem">
            <strong>${escapeHtml(issueLabels[item.code] || 'Notice')}:</strong>
            ${escapeHtml(item.message)}
          </div>`).join('');
    return `
      <li class="import-issue import-issue-${escapeHtml(issue.severity)}" data-import-key="${escapeHtml(issue.linkKey)}">
        <div class="issue-heading">${escapeHtml(issue.heading)}</div>
        ${messages}
        ${azureName}
        ${destinations}
        <a href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">Open URL</a>
      </li>`;
  };
  const missingServices = groupedIssues.filter((issue) => issue.category === 'missing');
  const importIssues = groupedIssues.filter((issue) => issue.category === 'issues');
  const activeTab = importIssues.length ? 'issues' : 'missing';
  const issueTabs = linkedIssues.length ? `
    <div class="import-issues">
      <div class="import-tabs" role="tablist" aria-label="Import results">
        <button type="button" class="import-tab ${activeTab === 'issues' ? 'is-active' : ''}"
          role="tab" aria-selected="${activeTab === 'issues'}" aria-controls="import-panel-issues"
          data-import-tab="issues">Issues <span class="tab-count">${importIssues.length}</span></button>
        <button type="button" class="import-tab ${activeTab === 'missing' ? 'is-active' : ''}"
          role="tab" aria-selected="${activeTab === 'missing'}" aria-controls="import-panel-missing"
          data-import-tab="missing">Missing services <span class="tab-count">${missingServices.length}</span></button>
      </div>
      <div id="import-panel-issues" class="import-tab-panel" role="tabpanel" ${activeTab !== 'issues' ? 'hidden' : ''}>
        ${importIssues.length ? `<ul>${importIssues.map(renderIssueCard).join('')}</ul>` : '<p class="import-success">No URL issues found.</p>'}
      </div>
      <div id="import-panel-missing" class="import-tab-panel" role="tabpanel" ${activeTab !== 'missing' ? 'hidden' : ''}>
        ${missingServices.length ? `<ul>${missingServices.map(renderIssueCard).join('')}</ul>` : '<p class="import-success">No services missing from the previous deployment.</p>'}
      </div>
    </div>` : '<p class="import-success">No URL issues or missing services found.</p>';
  const ignoredNote = result.ignored ? ` ${result.ignored} Octopus link${result.ignored === 1 ? '' : 's'} ignored.` : '';
  const duplicateNote = result.duplicatesSkipped
    ? ` ${result.duplicatesSkipped} duplicate cop${result.duplicatesSkipped === 1 ? 'y' : 'ies'} skipped.`
    : '';
  const total = result.uniqueTotal ?? result.total;

  bulkImportResult.innerHTML = `
    <p><strong>${result.matched.length}</strong> of <strong>${total}</strong> unique Azure URLs matched.${duplicateNote}${ignoredNote}</p>
    ${issueTabs}
    ${matchedNames ? `<details><summary>Matched rows</summary><pre>${escapeHtml(matchedNames)}</pre></details>` : ''}
    ${unmatchedText ? `
      <label for="bulk-unmatched">Unmatched URLs</label>
      <textarea id="bulk-unmatched" rows="${Math.min(12, Math.max(4, result.unmatched.length * 3))}" readonly>${escapeHtml(unmatchedText)}</textarea>
    ` : '<p class="import-success">Every supported URL was placed.</p>'}
  `;
  bulkImportResult.hidden = false;
  renderImportReview(sourceText, groupedIssues);
  wireImportIssueTabs();
  wireImportIssueHover();
}

function groupImportIssues(issues, issueLabels) {
  const grouped = new Map();
  for (const issue of issues) {
    const category = issue.code === 'missing-previous-service' ? 'missing' : 'issues';
    const groupKey = `${category}:${issue.linkKey}`;
    let group = grouped.get(groupKey);
    if (!group) {
      group = {
        category,
        linkKey: issue.linkKey,
        url: issue.url,
        severity: issue.severity,
        pipelineName: issue.pipelineName || null,
        destinations: [],
        items: []
      };
      grouped.set(groupKey, group);
    }
    group.items.push(issue);
    if (issueSeverityRank(issue.severity) > issueSeverityRank(group.severity)) {
      group.severity = issue.severity;
    }
    if (!group.pipelineName && issue.pipelineName) group.pipelineName = issue.pipelineName;
    for (const destination of issue.destinations || []) {
      if (!group.destinations.includes(destination)) group.destinations.push(destination);
    }
  }

  return [...grouped.values()].map((group) => ({
    ...group,
    heading: group.items.length === 1
      ? issueLabels[group.items[0].code] || 'Import issue'
      : `${group.items.length} notices for this URL`,
    message: group.items.map((item) => item.message).join(' ')
  }));
}

function wireImportIssueTabs() {
  document.querySelectorAll('[data-import-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-import-tab]').forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.import-tab-panel').forEach((panel) => {
        panel.hidden = panel.id !== `import-panel-${button.dataset.importTab}`;
      });
    });
  });
}

function renderImportReview(sourceText, issues) {
  const issuesByKey = new Map();
  for (const issue of issues) {
    const existing = issuesByKey.get(issue.linkKey);
    if (!existing || issueSeverityRank(issue.severity) > issueSeverityRank(existing.severity)) {
      issuesByKey.set(issue.linkKey, issue);
    }
  }

  bulkImportReview.innerHTML = sourceText.split(/\r?\n/).map((line) => {
    let cursor = 0;
    let rendered = '';
    for (const match of line.matchAll(/https?:\/\/[^\s<>()\[\]]+/gi)) {
      rendered += escapeHtml(line.slice(cursor, match.index));
      const url = match[0].replace(/[.,;:]+$/, '');
      const trailing = match[0].slice(url.length);
      const linkKey = importLinkKey(url);
      const issue = issuesByKey.get(linkKey);
      const issueClass = issue ? ` import-source-${issue.severity}` : ' import-source-ok';
      const title = issue ? issue.message : 'No issue reported for this URL.';
      rendered += `<a class="import-source-url${issueClass}" data-import-key="${escapeHtml(linkKey)}" ` +
        `href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${escapeHtml(url)}</a>` +
        escapeHtml(trailing);
      cursor = match.index + match[0].length;
    }
    rendered += escapeHtml(line.slice(cursor));
    return `<div class="import-source-line">${rendered || '&nbsp;'}</div>`;
  }).join('');

  bulkImportText.hidden = true;
  bulkImportReview.hidden = false;
  editImportBtn.hidden = false;
}

function importLinkKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const organization = url.hostname === 'dev.azure.com'
      ? segments[0]
      : url.hostname.endsWith('.visualstudio.com')
        ? url.hostname.split('.')[0]
        : null;
    const project = url.hostname === 'dev.azure.com' ? segments[1] : segments[0];
    const buildId = url.searchParams.get('buildId');
    const releaseId = url.searchParams.get('releaseId');
    const environmentId = url.searchParams.get('environmentId');
    if (organization && project && buildId) return `azure-${organization}-${project}-build-${buildId}`;
    if (organization && project && releaseId && environmentId) {
      return `azure-${organization}-${project}-release-${releaseId}-${environmentId}`;
    }
    url.hash = '';
    url.searchParams.sort();
    return `url-${url.toString()}`;
  } catch {
    return `url-${rawUrl}`;
  }
}

function issueSeverityRank(severity) {
  return { info: 1, warning: 2, error: 3 }[severity] || 0;
}

function wireImportIssueHover() {
  document.querySelectorAll('[data-import-key]').forEach((element) => {
    const setActive = (active) => {
      const key = element.dataset.importKey;
      document.querySelectorAll('[data-import-key]').forEach((linked) => {
        if (linked.dataset.importKey === key) linked.classList.toggle('import-linked-active', active);
      });
    };
    element.addEventListener('mouseenter', () => setActive(true));
    element.addEventListener('mouseleave', () => setActive(false));
    element.addEventListener('focusin', () => setActive(true));
    element.addEventListener('focusout', () => setActive(false));
  });
}

autoRefreshToggle.addEventListener('change', () => {
  localStorage.setItem(AUTO_REFRESH_KEY, autoRefreshToggle.checked ? '1' : '0');
  setupAutoRefresh();
});

function setupAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (!autoRefreshToggle.checked) return;
  autoRefreshTimer = setInterval(() => refreshAll({ background: true }), 15000);
}

const SCOPE_ORDER = ['Regional', 'Global Widget', 'Global'];
const SCOPE_LABELS = {
  Regional: 'AG (Regional)',
  'Global Widget': 'The Widget',
  Global: 'Global services'
};
const DEFAULT_BRANCHES = {
  Regional: 'release/release-ag-2026.03',
  Global: 'release/release-iam-2026.03'
};
const wizard = {
  index: 0,
  scopes: [],
  lifecycle: 'Staging',
  region: 'NA',
  branches: { Regional: '', Global: '' },
  newCode: { Regional: false, Global: false },
  version: ''
};

function wizardApplicableSteps() {
  const steps = [];
  if (!getToken()) steps.push({ id: 'token' });
  steps.push({ id: 'scopes' });
  if (!wizard.scopes.length) return steps;
  steps.push({ id: 'environment' });
  if (wizard.scopes.includes('Regional') && wizard.lifecycle === 'Production') {
    steps.push({ id: 'region' });
  }
  for (const scope of SCOPE_ORDER.filter((item) => wizard.scopes.includes(item))) {
    if (scope === 'Global Widget') {
      steps.push({ id: 'version', scope });
      continue;
    }
    steps.push({ id: 'branch', scope });
    steps.push({ id: 'freshCode', scope });
  }
  steps.push({ id: 'summary' });
  return steps;
}

function startWizard() {
  document.getElementById('mode-overlay').hidden = true;
  document.getElementById('wizard-overlay').hidden = false;
  wizard.index = 0;
  wizard.branches.Regional = queueSelections.regionalBranch || DEFAULT_BRANCHES.Regional;
  wizard.branches.Global = queueSelections.globalBranch || DEFAULT_BRANCHES.Global;
  wizard.version = queueSelections.widgetVersion || '';
  renderWizard();
}

function exitWizard() {
  document.getElementById('wizard-overlay').hidden = true;
  document.getElementById('mode-overlay').hidden = true;
  document.getElementById('start-overlay').hidden = true;
}

function renderWizard() {
  const steps = wizardApplicableSteps();
  const step = steps[Math.min(wizard.index, steps.length - 1)];
  const body = document.getElementById('wizard-body');
  document.getElementById('wizard-step-label').textContent =
    `Step ${Math.min(wizard.index + 1, steps.length)} of ${steps.length}`;
  document.getElementById('wizard-back-btn').disabled = wizard.index === 0;
  document.getElementById('wizard-next-btn').textContent = step.id === 'summary' ? 'Queue it' : 'Next';

  const options = (name, values, current) => values.map((value) => {
    const label = typeof value === 'string' ? value : value.label;
    const id = typeof value === 'string' ? value : value.id;
    const hint = typeof value === 'string' ? '' : value.hint;
    return `<label class="wizard-option ${current === id ? 'selected' : ''}">
      <input type="radio" name="${name}" value="${escapeHtml(id)}" ${current === id ? 'checked' : ''} />
      <span><strong>${escapeHtml(label)}</strong>${hint ? `<em>${escapeHtml(hint)}</em>` : ''}</span>
    </label>`;
  }).join('');

  if (step.id === 'token') {
    body.innerHTML = `<h3>First, your Azure DevOps token</h3>
      <p class="wizard-help">We need a personal access token to talk to Azure DevOps. It stays in this browser only.</p>
      <input id="wizard-token" type="password" placeholder="Paste your PAT" autocomplete="off" />`;
  } else if (step.id === 'scopes') {
    const choices = [
      { id: 'Regional', label: 'AG (Regional)', hint: 'The AG applications, deployed per region' },
      { id: 'Global Widget', label: 'The Widget', hint: 'Released from a package version' },
      { id: 'Global', label: 'Global services', hint: 'Shared services used by every region' }
    ];
    body.innerHTML = `<h3>What are you deploying?</h3>
      <p class="wizard-help">Pick as many as you need. We'll ask about each one in turn.</p>
      ${choices.map((choice) => `
        <label class="wizard-option ${wizard.scopes.includes(choice.id) ? 'selected' : ''}">
          <input type="checkbox" name="scopes" value="${escapeHtml(choice.id)}"
            ${wizard.scopes.includes(choice.id) ? 'checked' : ''} />
          <span><strong>${escapeHtml(choice.label)}</strong><em>${escapeHtml(choice.hint)}</em></span>
        </label>`).join('')}`;
  } else if (step.id === 'environment') {
    body.innerHTML = `<h3>Which environment?</h3>
      <p class="wizard-help">This applies to everything you selected.</p>
      ${options('lifecycle', ['Dev', 'QA', 'Release', 'Staging', 'Demo', 'Production'], wizard.lifecycle)}`;
  } else if (step.id === 'region') {
    body.innerHTML = `<h3>Which production region?</h3>
      ${options('region', [
        { id: 'NA', label: 'NA', hint: 'North America (CUS)' },
        { id: 'EMEA', label: 'EMEA', hint: 'Europe (GBR)' },
        { id: 'APAC', label: 'APAC', hint: 'Asia Pacific (AUS)' }
      ], wizard.region)}`;
  } else if (step.id === 'version') {
    const versions = [...(document.getElementById('queue-widget-version')?.options || [])].map((o) => o.value);
    body.innerHTML = `<h3>Which Widget version?</h3>
      <p class="wizard-help">Pick the package version to release.</p>
      ${versions.length
        ? `<select id="wizard-version">${versions.map((v) =>
            `<option value="${escapeHtml(v)}" ${v === wizard.version ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`
        : `<input id="wizard-version" type="text" value="${escapeHtml(wizard.version)}" placeholder="6.1.3" />`}`;
  } else if (step.id === 'branch') {
    const all = branchOptions[step.scope].length
      ? branchOptions[step.scope]
      : [wizard.branches[step.scope]].filter(Boolean);
    const release = all.filter((branch) => /^release\//i.test(branch));
    const others = all.filter((branch) => !/^release\//i.test(branch));
    const option = (branch) =>
      `<option value="${escapeHtml(branch)}" ${branch === wizard.branches[step.scope] ? 'selected' : ''}>${
        escapeHtml(branch)}</option>`;
    body.innerHTML = `<h3>Which release branch for ${escapeHtml(SCOPE_LABELS[step.scope])}?</h3>
      <p class="wizard-help">This is the release train you are shipping.</p>
      <select id="wizard-branch">${release.length
        ? `<optgroup label="Release branches">${release.map(option).join('')}</optgroup>` +
          `<optgroup label="All branches">${others.map(option).join('')}</optgroup>`
        : all.map(option).join('')}</select>`;
  } else if (step.id === 'freshCode') {
    body.innerHTML = `<h3>Has new code been merged for ${escapeHtml(SCOPE_LABELS[step.scope])}?</h3>
      <p class="wizard-help">If nothing has changed since the last release was built, we reuse it. That is the normal case.</p>
      ${options('newCode', [
        { id: 'no', label: 'No, deploy what was already built and tested', hint: 'Recommended' },
        { id: 'yes', label: 'Yes, build the latest code first', hint: 'Runs a new pipeline, then creates new releases' }
      ], wizard.newCode[step.scope] ? 'yes' : 'no')}`;
  } else {
    const rows = SCOPE_ORDER.filter((scope) => wizard.scopes.includes(scope)).map((scope) => {
      if (scope === 'Global Widget') {
        return `<li><span>The Widget</span><strong>version ${escapeHtml(wizard.version || 'not set')}</strong></li>`;
      }
      return `<li><span>${escapeHtml(SCOPE_LABELS[scope])}</span><strong>${escapeHtml(wizard.branches[scope])} · ${
        wizard.newCode[scope] ? 'new build first' : 'reuse existing release'}</strong></li>`;
    }).join('');
    body.innerHTML = `<h3>Ready to go</h3>
      <ul class="wizard-summary">
        <li><span>Environment</span><strong>${escapeHtml(wizard.lifecycle)}</strong></li>
        ${wizard.scopes.includes('Regional') && wizard.lifecycle === 'Production'
          ? `<li><span>Region</span><strong>${escapeHtml(wizard.region)}</strong></li>` : ''}
        ${rows}
      </ul>
      <p class="wizard-help">Choosing <strong>Queue it</strong> will start ${wizard.scopes.length > 1
        ? 'these deployments' : 'this deployment'} in Azure DevOps.</p>`;
  }

  body.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const { name, value } = event.target;
      if (name === 'lifecycle') wizard.lifecycle = value;
      if (name === 'region') wizard.region = value;
      if (name === 'newCode') wizard.newCode[step.scope] = value === 'yes';
      renderWizard();
    });
  });
  body.querySelectorAll('input[name="scopes"]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const { value, checked } = event.target;
      wizard.scopes = checked
        ? [...wizard.scopes, value]
        : wizard.scopes.filter((item) => item !== value);
      renderWizard();
    });
  });
}

function applyWizardSelections() {
  queueLifecycleSelect.value = wizard.lifecycle;
  queueSelections.regionalRegion = wizard.region;
  if (wizard.scopes.includes('Regional')) queueSelections.regionalBranch = wizard.branches.Regional;
  if (wizard.scopes.includes('Global')) queueSelections.globalBranch = wizard.branches.Global;
  if (wizard.scopes.includes('Global Widget')) queueSelections.widgetVersion = wizard.version;
  for (const group of state.groups) {
    if (!wizard.scopes.includes(group.name) || group.name === 'Global Widget') continue;
    for (const block of pipelineBlocks(group).blocks) forceRebuild[block.key] = wizard.newCode[group.name];
  }
  render();
}

async function advanceWizard() {
  const steps = wizardApplicableSteps();
  const step = steps[Math.min(wizard.index, steps.length - 1)];

  if (step.id === 'token') {
    const value = document.getElementById('wizard-token')?.value.trim();
    if (!value) return alert('Please paste your Azure DevOps token to continue.');
    localStorage.setItem(TOKEN_KEY, value);
    patInput.value = value;
  }
  if (step.id === 'scopes' && !wizard.scopes.length) {
    return alert('Please choose at least one thing to deploy.');
  }
  if (step.id === 'version') {
    const value = document.getElementById('wizard-version')?.value.trim();
    if (!value) return alert('Please choose a Widget version.');
    wizard.version = value;
  }
  if (step.id === 'branch') {
    const value = document.getElementById('wizard-branch')?.value.trim();
    if (!value) return alert('Please enter the release branch.');
    wizard.branches[step.scope] = value;
  }
  if (step.id === 'summary') {
    applyWizardSelections();
    exitWizard();
    for (const scope of SCOPE_ORDER.filter((item) => wizard.scopes.includes(item))) {
      if (scope === 'Global Widget') {
        const widget = state.groups.find((group) => group.name === 'Global Widget')?.services[0];
        if (widget) await queueService(widget.id);
      } else {
        await queueScope(scope);
      }
    }
    return;
  }

  wizard.index = Math.min(wizard.index + 1, wizardApplicableSteps().length - 1);
  renderWizard();
}

// A section still needs the wizard while any of its queueable services has never been run.
function undeployedScopes() {
  return state.groups
    .filter((group) => {
      const configured = group.services.filter((svc) => state.queueConfigs?.[String(svc.id)]);
      return configured.length && configured.some((svc) => !svc.status || svc.status === 'idle');
    })
    .map((group) => group.name);
}

function renderStartPicker() {
  const select = document.getElementById('start-deployment');
  const history = state.history || [];
  const current = state.deployment;
  const entries = current && !history.some((item) => item.id === current.id)
    ? [{ id: current.id, name: current.name, updatedAt: current.updatedAt }, ...history]
    : history;
  select.innerHTML = entries.length
    ? entries.map((item) => `<option value="${item.id}" ${item.id === current?.id ? 'selected' : ''}>${
        escapeHtml(item.name)}</option>`).join('')
    : '<option value="">No saved deployments yet</option>';
  select.disabled = !entries.length;
  document.getElementById('start-continue-btn').disabled = !entries.length;
  document.getElementById('start-overlay').hidden = false;
}

function offerModeChoice() {
  document.getElementById('start-overlay').hidden = true;
  const pending = undeployedScopes();
  if (!pending.length) {
    showBoard();
    return;
  }
  wizard.scopes = pending;
  document.getElementById('mode-overlay').hidden = false;
}

document.getElementById('start-continue-btn')?.addEventListener('click', async () => {
  const id = document.getElementById('start-deployment').value;
  if (id && String(id) !== String(state.deployment?.id)) {
    state = await api(`/deployments/${id}/activate`, { method: 'POST' });
    resetBulkImport();
    render();
  }
  offerModeChoice();
});

document.getElementById('start-new-btn')?.addEventListener('click', async () => {
  const suggestedName = `Deployment ${new Date().toLocaleDateString()}`;
  const name = prompt('Name the new deployment:', suggestedName)?.trim();
  if (!name) return;
  const saveChanges = Boolean(state.deployment?.isSaved && state.deployment?.isDirty);
  state = await api('/deployments', {
    method: 'POST',
    body: JSON.stringify({ name, saveChanges })
  });
  resetBulkImport();
  render();
  document.getElementById('start-overlay').hidden = true;
  wizard.scopes = undeployedScopes();
  document.getElementById('mode-overlay').hidden = false;
});

document.getElementById('mode-guided-btn')?.addEventListener('click', startWizard);
document.getElementById('mode-technical-btn')?.addEventListener('click', showBoard);
document.getElementById('wizard-next-btn')?.addEventListener('click', advanceWizard);
document.getElementById('wizard-exit-btn')?.addEventListener('click', showBoard);
document.getElementById('wizard-back-btn')?.addEventListener('click', () => {
  wizard.index = Math.max(0, wizard.index - 1);
  renderWizard();
});

initToken();
autoRefreshToggle.checked = localStorage.getItem(AUTO_REFRESH_KEY) !== '0';
loadState()
  .then(() => {
    setupAutoRefresh();
    renderStartPicker();
  })
  .finally(() => {
    document.getElementById('startup-overlay').hidden = true;
  });
