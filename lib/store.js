const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DEPLOYMENT_TRACKER_DATA_FILE || path.join(__dirname, '..', 'data.json');
const SEED_FILE = path.join(__dirname, '..', 'seed-data.json');

function nextId(state) {
  state._nextId = (state._nextId || 1);
  return state._nextId++;
}

function loadState() {
  let loaded;
  if (!fs.existsSync(DATA_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const initial = { _nextId: 1, groups: [] };
    for (const group of seed.groups) {
      const services = group.services.map((svc) => ({
        id: nextId(initial),
        name: svc.name,
        pipelineUrl: svc.pipelineUrl || '',
        status: 'idle', // idle | queued | awaitingApproval | running | succeeded | warning | failed | error
        runType: null,
        pipelineName: null,
        acceptedPipelineNames: [],
        runNumber: null,
        webUrl: null,
        lastChecked: null,
        message: null
      }));
      initial.groups.push({ name: group.name, services });
    }
    loaded = initial;
  } else {
    loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }

  if (!loaded.deployments) {
    const timestamp = new Date().toISOString();
    loaded = {
      _nextId: loaded._nextId || 1,
      _nextDeploymentId: 2,
      activeDeploymentId: 1,
      deployments: [{
        id: 1,
        name: loaded.deploymentName || 'Current deployment',
        createdAt: timestamp,
        updatedAt: timestamp,
        groups: loaded.groups || []
      }]
    };
  }

  loaded._nextDeploymentId = loaded._nextDeploymentId ||
    Math.max(0, ...loaded.deployments.map((deployment) => deployment.id)) + 1;
  loaded.queueConfigs = loaded.queueConfigs || {};
  if (!loaded.deployments.some((deployment) => deployment.id === loaded.activeDeploymentId)) {
    loaded.activeDeploymentId = loaded.deployments[0]?.id || null;
  }

  for (const deployment of loaded.deployments) {
    if (!Object.prototype.hasOwnProperty.call(deployment, 'savedAt')) {
      deployment.savedAt = deployment.updatedAt || deployment.createdAt || new Date().toISOString();
    }
    if (typeof deployment.isDirty !== 'boolean') deployment.isDirty = false;
    for (const group of deployment.groups) {
      for (const svc of group.services) normalizeService(svc);
    }
  }
  return loaded;
}

function normalizeService(svc) {
  svc.pipelineUrl = svc.pipelineUrl || '';
  svc.status = svc.status || 'idle';
  svc.runNumber = svc.runNumber || svc.buildNumber || null;
  svc.runType = svc.runType || null;
  svc.pipelineName = svc.pipelineName || null;
  svc.acceptedPipelineNames = Array.isArray(svc.acceptedPipelineNames)
    ? [...new Set(svc.acceptedPipelineNames.filter(Boolean))]
    : [];
  svc.webUrl = svc.webUrl || null;
  svc.lastChecked = svc.lastChecked || null;
  svc.message = svc.message || null;
  svc.queueOperation = svc.queueOperation || null;
  delete svc.buildNumber;
}

function saveState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
}

let state = loadState();

function getState() {
  const active = getActiveDeployment();
  return {
    groups: active.groups,
    deployment: deploymentSummary(active),
    queueConfigs: state.queueConfigs,
    history: state.deployments
      .filter((deployment) => deployment.id !== active.id)
      .map(deploymentSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  };
}

function getActiveDeployment() {
  return findDeployment(state.activeDeploymentId);
}

function getHistoricalServices() {
  return state.deployments
    .filter((deployment) => deployment.id !== state.activeDeploymentId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .flatMap((deployment) =>
      deployment.groups.flatMap((group) =>
        group.services.map((service) => ({
          ...service,
          group: group.name,
          deploymentId: deployment.id,
          deploymentName: deployment.name
        }))
      )
    );
}

function findDeployment(id) {
  return state.deployments.find((deployment) => deployment.id === Number(id));
}

function deploymentSummary(deployment) {
  return {
    id: deployment.id,
    name: deployment.name,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    isSaved: Boolean(deployment.savedAt),
    isDirty: deployment.isDirty
  };
}

function touchDeployment(deployment, markDirty = true) {
  deployment.updatedAt = new Date().toISOString();
  if (markDirty) deployment.isDirty = true;
}

function findService(id, deploymentId = state.activeDeploymentId) {
  const deployment = findDeployment(deploymentId);
  if (!deployment) return null;
  for (const group of deployment.groups) {
    const svc = group.services.find((s) => s.id === Number(id));
    if (svc) return svc;
  }
  return null;
}

function updateService(id, patch, deploymentId = state.activeDeploymentId, options = {}) {
  const deployment = findDeployment(deploymentId);
  const svc = findService(id, deploymentId);
  if (!svc) return null;
  Object.assign(svc, patch);
  touchDeployment(deployment, options.markDirty !== false);
  saveState(state);
  return svc;
}

function addService(groupName, name) {
  const active = getActiveDeployment();
  let group = active.groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase());
  if (!group) {
    group = { name: groupName, services: [] };
    active.groups.push(group);
  }
  const svc = {
    id: nextId(state),
    name,
    pipelineUrl: '',
    status: 'idle',
    runType: null,
    pipelineName: null,
    acceptedPipelineNames: [],
    runNumber: null,
    webUrl: null,
    lastChecked: null,
    message: null,
    queueOperation: null
  };
  group.services.push(svc);
  touchDeployment(active);
  saveState(state);
  return svc;
}

function removeService(id) {
  for (const group of getActiveDeployment().groups) {
    const idx = group.services.findIndex((s) => s.id === Number(id));
    if (idx !== -1) {
      group.services.splice(idx, 1);
      touchDeployment(getActiveDeployment());
      saveState(state);
      return true;
    }
  }
  return false;
}

function renameService(id, name) {
  const svc = findService(id);
  if (!svc) return null;
  svc.name = name.trim();
  touchDeployment(getActiveDeployment());
  saveState(state);
  return svc;
}

function reorderServices(groupName, orderedIds) {
  const group = getActiveDeployment().groups.find(
    (item) => item.name.toLowerCase() === groupName.toLowerCase()
  );
  if (!group) return null;
  const order = new Map(orderedIds.map((id, index) => [Number(id), index]));
  group.services.sort((left, right) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  );
  touchDeployment(getActiveDeployment());
  saveState(state);
  return group.services;
}

function setActiveGroupLayout(groups) {
  const active = getActiveDeployment();
  const servicesById = new Map(
    active.groups.flatMap((group) => group.services).map((service) => [service.id, service])
  );
  const requestedIds = groups.flatMap((group) => group.serviceIds.map(Number));
  if (
    new Set(requestedIds).size !== requestedIds.length ||
    requestedIds.length !== servicesById.size ||
    requestedIds.some((id) => !servicesById.has(id))
  ) {
    return null;
  }
  active.groups = groups.map((group) => ({
    name: group.name.trim(),
    services: group.serviceIds.map((id) => servicesById.get(Number(id)))
  }));
  touchDeployment(active);
  saveState(state);
  return getState();
}

function resetAll() {
  for (const group of getActiveDeployment().groups) {
    for (const svc of group.services) {
      svc.status = 'idle';
      svc.runNumber = null;
      svc.webUrl = null;
      svc.lastChecked = null;
      svc.message = null;
      svc.queueOperation = null;
    }
  }
  touchDeployment(getActiveDeployment());
  saveState(state);
}

function clearAll() {
  for (const group of getActiveDeployment().groups) {
    for (const svc of group.services) {
      Object.assign(svc, {
        pipelineUrl: '',
        runType: null,
        pipelineName: null,
        status: 'idle',
        runNumber: null,
        webUrl: null,
        lastChecked: null,
        message: null
      });
    }
  }
  touchDeployment(getActiveDeployment());
  saveState(state);
}

function renameDeployment(name) {
  const active = getActiveDeployment();
  active.name = name.trim();
  touchDeployment(active);
  saveState(state);
  return getState();
}

function createDeployment(name, saveChanges = false) {
  const active = getActiveDeployment();
  if (active.savedAt && active.isDirty && !saveChanges) return null;

  const timestamp = new Date().toISOString();
  active.savedAt = timestamp;
  active.isDirty = false;
  const deployment = {
    id: state._nextDeploymentId++,
    name: name.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    savedAt: null,
    isDirty: false,
    groups: active.groups.map((group) => ({
      name: group.name,
      services: group.services.map((svc) => ({
        id: svc.id,
        name: svc.name,
        pipelineUrl: '',
        status: 'idle',
        runType: null,
        pipelineName: null,
        acceptedPipelineNames: [...svc.acceptedPipelineNames],
        runNumber: null,
        webUrl: null,
        lastChecked: null,
        message: null,
        queueOperation: null
      }))
    }))
  };
  state.deployments.push(deployment);
  state.activeDeploymentId = deployment.id;
  saveState(state);
  return getState();
}

function activateDeployment(id) {
  const deployment = findDeployment(id);
  if (!deployment) return null;
  state.activeDeploymentId = deployment.id;
  saveState(state);
  return getState();
}

function approvePipelineName(serviceId, pipelineName) {
  const name = pipelineName.trim();
  const active = getActiveDeployment();
  const sourceGroup = active.groups.find((group) =>
    group.services.some((svc) => svc.id === Number(serviceId))
  );
  const sourceService = sourceGroup?.services.find((svc) => svc.id === Number(serviceId));
  if (!sourceService) return null;

  let found = false;
  for (const deployment of state.deployments) {
    const group = deployment.groups.find(
      (item) => item.name.toLowerCase() === sourceGroup.name.toLowerCase()
    );
    const matchingServices = group?.services.filter(
      (svc) => svc.name.toLowerCase() === sourceService.name.toLowerCase()
    ) || [];
    for (const svc of matchingServices) {
      found = true;
      if (!svc.acceptedPipelineNames.includes(name)) {
        svc.acceptedPipelineNames.push(name);
        touchDeployment(deployment, false);
      }
    }
  }
  if (!found) return null;
  saveState(state);
  return findService(serviceId);
}

function setQueueConfig(serviceId, config) {
  if (!findService(serviceId)) return null;
  state.queueConfigs[String(serviceId)] = config;
  saveState(state);
  return config;
}

function getQueueConfig(serviceId) {
  return state.queueConfigs[String(serviceId)] || null;
}

module.exports = {
  getState,
  getHistoricalServices,
  findService,
  updateService,
  addService,
  removeService,
  renameService,
  reorderServices,
  setActiveGroupLayout,
  resetAll,
  clearAll,
  renameDeployment,
  createDeployment,
  activateDeployment,
  approvePipelineName,
  setQueueConfig,
  getQueueConfig
};
