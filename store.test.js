const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataFile = path.join(os.tmpdir(), `deployment-tracker-${process.pid}.json`);
process.env.DEPLOYMENT_TRACKER_DATA_FILE = dataFile;
const store = require('./lib/store');

test.after(() => fs.rmSync(dataFile, { force: true }));

test('creates a blank named deployment and restores the previous snapshot', () => {
  const original = store.getState();
  const originalUrl = original.groups[0].services[0].pipelineUrl;
  assert.ok(originalUrl);

  store.renameDeployment('Morning deployment');
  const created = store.createDeployment('Afternoon deployment', true);
  assert.equal(created.deployment.name, 'Afternoon deployment');
  assert.equal(created.history[0].name, 'Morning deployment');
  assert.ok(created.groups.flatMap((group) => group.services).every((service) => !service.pipelineUrl));
  store.updateService(created.groups[0].services[0].id, { pipelineUrl: 'https://example.test/afternoon' });

  const restored = store.activateDeployment(created.history[0].id);
  assert.equal(restored.deployment.name, 'Morning deployment');
  assert.equal(restored.groups[0].services[0].pipelineUrl, originalUrl);
});

test('clear all removes links only from the active deployment', () => {
  store.clearAll();
  const cleared = store.getState();
  assert.ok(cleared.groups.flatMap((group) => group.services).every((service) => !service.pipelineUrl));

  const afternoon = cleared.history.find((deployment) => deployment.name === 'Afternoon deployment');
  const restored = store.activateDeployment(afternoon.id);
  assert.equal(restored.deployment.name, 'Afternoon deployment');
  assert.equal(restored.groups[0].services[0].pipelineUrl, 'https://example.test/afternoon');
});

test('late updates stay scoped to the deployment that started them', () => {
  const afternoon = store.getState();
  const morning = afternoon.history.find((deployment) => deployment.name === 'Morning deployment');
  const serviceId = afternoon.groups[0].services[0].id;

  store.activateDeployment(morning.id);
  store.updateService(serviceId, { status: 'failed' }, afternoon.deployment.id);
  assert.equal(store.getState().groups[0].services[0].status, 'idle');

  const restored = store.activateDeployment(afternoon.deployment.id);
  assert.equal(restored.groups[0].services[0].status, 'failed');
});

test('approved pipeline names persist across history and new deployments', () => {
  const active = store.getState();
  const serviceId = active.groups[0].services[0].id;
  store.approvePipelineName(serviceId, 'MRI-Software.Technical-Name');

  const previous = active.history[0];
  const historical = store.activateDeployment(previous.id);
  assert.deepEqual(
    historical.groups[0].services[0].acceptedPipelineNames,
    ['MRI-Software.Technical-Name']
  );

  const created = store.createDeployment('Alias test deployment', true);
  assert.deepEqual(
    created.groups[0].services[0].acceptedPipelineNames,
    ['MRI-Software.Technical-Name']
  );
});

test('approval applies to repeated service slots in the same group', () => {
  const active = store.getState();
  const group = active.groups.find((item) => item.name === 'Global');
  const swaServices = group.services.filter((service) => service.name === 'MFE (Gateway, Identity)');
  assert.equal(swaServices.length, 2);

  store.approvePipelineName(swaServices[0].id, 'internal_admin_MFE');
  const updatedGroup = store.getState().groups.find(
    (item) => item.name === 'Global'
  );
  const updatedSwaServices = updatedGroup.services.filter(
    (service) => service.name === 'MFE (Gateway, Identity)'
  );
  assert.ok(
    updatedSwaServices.every((service) =>
      service.acceptedPipelineNames.includes('internal_admin_MFE')
    )
  );
});

test('renaming a service preserves its tracking data', () => {
  const active = store.getState();
  const service = active.groups[0].services[0];
  store.updateService(service.id, {
    pipelineUrl: 'https://dev.azure.com/example/project/_build/results?buildId=789',
    status: 'failed',
    acceptedPipelineNames: ['Technical Pipeline']
  });

  const renamed = store.renameService(service.id, 'Renamed Service');
  assert.equal(renamed.name, 'Renamed Service');
  assert.equal(renamed.pipelineUrl, 'https://dev.azure.com/example/project/_build/results?buildId=789');
  assert.equal(renamed.status, 'failed');
  assert.deepEqual(renamed.acceptedPipelineNames, ['Technical Pipeline']);
  assert.equal(store.getState().deployment.isDirty, true);
});

test('a modified saved deployment requires confirmation and is not duplicated', () => {
  const current = store.getState();
  const savedDeployment = current.deployment.isSaved
    ? current.deployment
    : current.history.find((deployment) => deployment.isSaved);
  if (savedDeployment.id !== current.deployment.id) store.activateDeployment(savedDeployment.id);
  const active = store.getState();
  const activeId = active.deployment.id;
  const historyCount = active.history.length;
  store.updateService(active.groups[0].services[0].id, { pipelineUrl: 'https://example.test/edited' });

  const dirty = store.getState();
  assert.equal(dirty.deployment.isSaved, true);
  assert.equal(dirty.deployment.isDirty, true);
  assert.equal(store.createDeployment('Blocked deployment'), null);
  assert.equal(store.getState().deployment.id, activeId);
  assert.equal(store.getState().history.length, historyCount);

  const created = store.createDeployment('Confirmed deployment', true);
  const savedEntry = created.history.find((deployment) => deployment.id === activeId);
  assert.ok(savedEntry);
  assert.equal(savedEntry.isDirty, false);
  assert.equal(created.history.length, historyCount + 1);
});

test('status-only updates do not mark a saved deployment dirty', () => {
  const saved = store.getState().history.find((deployment) => deployment.isSaved);
  store.activateDeployment(saved.id);
  const active = store.getState();
  store.updateService(
    active.groups[0].services[0].id,
    { status: 'running' },
    active.deployment.id,
    { markDirty: false }
  );
  assert.equal(store.getState().deployment.isDirty, false);
});

test('historical service references expose prior URLs without changing active state', () => {
  const active = store.getState();
  const historical = store.getHistoricalServices();
  assert.ok(historical.length > 0);
  assert.ok(historical.every((service) => service.deploymentId !== active.deployment.id));
  assert.ok(historical.some((service) => service.pipelineUrl));
  assert.equal(store.getState().deployment.id, active.deployment.id);
});

test('queue configuration is stable across deployment snapshots', () => {
  const active = store.getState();
  const serviceId = active.groups[0].services[0].id;
  const config = {
    type: 'build-release',
    buildDefinitionId: 273,
    releaseDefinitionId: 48,
    environments: [{ id: 410, name: 'Staging-cus' }]
  };
  store.setQueueConfig(serviceId, config);
  assert.deepEqual(store.getQueueConfig(serviceId), config);

  const next = store.createDeployment('Queue config test', true);
  assert.deepEqual(next.queueConfigs[String(serviceId)], config);
});

test('active services can move between sections without changing IDs or history', () => {
  const before = store.getState();
  const historyCount = before.history.length;
  const services = before.groups.flatMap((group) => group.services);
  const splitAt = Math.ceil(services.length / 2);
  const next = store.setActiveGroupLayout([
    { name: 'Regional', serviceIds: services.slice(0, splitAt).map((service) => service.id) },
    { name: 'Global', serviceIds: services.slice(splitAt).map((service) => service.id) }
  ]);

  assert.deepEqual(next.groups.map((group) => group.name), ['Regional', 'Global']);
  assert.deepEqual(
    next.groups.flatMap((group) => group.services).map((service) => service.id),
    services.map((service) => service.id)
  );
  assert.equal(next.history.length, historyCount);
});