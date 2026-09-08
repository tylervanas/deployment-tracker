const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('./seed-data.json');
const {
  extractUrlEntries,
  extractUrlsOnly,
  findServiceMatch,
  getUrlIdentity,
  countUrlOccurrences,
  uniqueUrlEntries,
  findExistingAssignments
} = require('./lib/importer');

const MORNING_DEPLOYMENTS = `AG
AG Home SWA
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15654&environmentId=104796
AG Administration SWA
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15653&environmentId=104781
AG Administration Identity
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15647&environmentId=104734
AG Administration Gateway
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15646&environmentId=104726
AG Administration Access Management
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15645&environmentId=104718
Config Function Home
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898625&view=results
Config Function Admin
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898617&view=results
Notifications API
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898582&view=results
Widget
AG Administration API
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898611&view=results
AG API
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898615&view=results

Agora Management Studio
SWA
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15649&environmentId=104755
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15649&environmentId=104756
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15649&environmentId=104757
MFE (Gateway, Identity)
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15650&environmentId=104765
https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15651&environmentId=104771
Yarp API
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898630&view=results
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898633&view=results
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898635&view=results
Config and Manifest Function
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898640&view=results
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898642&view=results
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898643&view=results
New Central Identity
New Central Identity
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898648&view=results
Welcome
Welcome
https://octopus.mrisoftware.net/app#/Spaces-1/projects/welcome-front-end/deployments/releases/1.1.432-Trunk/deployments/Deployments-92815
Identity
Pathfinder
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898545&view=results
Hello
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898545&view=results
Proxy
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898545&view=results
Sync
https://dev.azure.com/mrisoftware/MRI_Platform/_build/results?buildId=898545&view=results`;

const URL_ONLY_DEPLOYMENTS = [...MORNING_DEPLOYMENTS.matchAll(/https?:\/\/\S+/g)]
  .map((match) => match[0])
  .join('\n');

function configuredServices() {
  let id = 0;
  return seed.groups.flatMap((group) =>
    group.services.map((service) => ({ ...service, id: ++id, group: group.name }))
  );
}

test('matches valid URLs and leaves known duplicate/global-child URLs unmatched', () => {
  const groupNames = seed.groups.map((group) => group.name);
  const entries = extractUrlEntries(MORNING_DEPLOYMENTS, groupNames);
  const azureEntries = entries.filter((entry) => new URL(entry.url).hostname === 'dev.azure.com');
  const octopusEntries = entries.filter(
    (entry) => new URL(entry.url).hostname === 'octopus.mrisoftware.net'
  );
  const services = configuredServices();
  const usedIds = new Set();
  const matches = azureEntries.map((entry) => {
    const service = findServiceMatch(services, entry, null, usedIds);
    if (service) usedIds.add(service.id);
    return { entry, service };
  });

  assert.equal(entries.length, 27);
  assert.equal(azureEntries.length, 26);
  assert.equal(octopusEntries.length, 1);
  assert.deepEqual(
    matches.filter(({ service }) => !service).map(({ entry }) => entry.url),
    [
      'https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15649&environmentId=104756',
      'https://dev.azure.com/mrisoftware/MRI_Platform/_releaseProgress?_a=release-environment-logs&releaseId=15649&environmentId=104757'
    ]
  );
  assert.deepEqual(
    matches.slice(-4).map(({ service }) => service.name),
    ['Pathfinder', 'Hello', 'Proxy', 'Sync']
  );
});

test('uses the configured group when service names collide', () => {
  const services = [
    { id: 1, group: 'AG', name: 'SWA', pipelineUrl: '' },
    { id: 2, group: 'Agora Management Studio', name: 'SWA', pipelineUrl: '' }
  ];
  const entry = {
    group: 'Agora Management Studio',
    label: 'SWA',
    url: 'https://dev.azure.com/org/project/_build/results?buildId=1'
  };

  assert.equal(findServiceMatch(services, entry, null).id, 2);
});

test('explicit labels disambiguate services that share one URL', () => {
  const sharedUrl = 'https://dev.azure.com/org/project/_build/results?buildId=1';
  const services = [
    { id: 1, group: 'Identity', name: 'Pathfinder', pipelineUrl: sharedUrl },
    { id: 2, group: 'Identity', name: 'Hello', pipelineUrl: sharedUrl }
  ];
  const entry = { group: 'Identity', label: 'Hello', url: sharedUrl };

  assert.equal(findServiceMatch(services, entry, null).id, 2);
});

test('fetched Azure name takes precedence over a stale stored URL', () => {
  const pastedUrl = 'https://dev.azure.com/org/project/_build/results?buildId=2';
  const services = [
    { id: 1, group: 'AG', name: 'Old Pipeline', pipelineUrl: pastedUrl },
    { id: 2, group: 'AG', name: 'Correct Pipeline', pipelineUrl: '' }
  ];
  const entry = { group: 'AG', label: 'Old Pipeline', url: pastedUrl };

  assert.equal(findServiceMatch(services, entry, 'Correct Pipeline').id, 2);
});

test('ignores a conflicting pasted label and group when Azure identifies the pipeline', () => {
  const pastedUrl = 'https://dev.azure.com/org/project/_build/results?buildId=2';
  const services = [
    { id: 1, group: 'AG', name: 'AG API', pipelineUrl: pastedUrl },
    { id: 2, group: 'Identity', name: 'Identity', pipelineUrl: '' }
  ];
  const entry = { group: 'AG', label: 'AG API', url: pastedUrl };

  assert.equal(findServiceMatch(services, entry, 'Identity').id, 2);
});

test('matches a fetched Azure name against an approved service alias', () => {
  const services = [
    {
      id: 1,
      group: 'AG',
      name: 'Config Function Home',
      acceptedPipelineNames: ['MRI-Software.MRI-Platform-Config-Home'],
      pipelineUrl: ''
    }
  ];
  const entry = {
    group: null,
    label: null,
    url: 'https://dev.azure.com/org/project/_build/results?buildId=2'
  };

  assert.equal(
    findServiceMatch(services, entry, 'MRI-Software.MRI-Platform-Config-Home').id,
    1
  );
});

test('matches valid configured services from the intentionally flawed URL list', () => {
  const groupNames = seed.groups.map((group) => group.name);
  const entries = extractUrlEntries(URL_ONLY_DEPLOYMENTS, groupNames);
  const azureEntries = entries.filter((entry) => new URL(entry.url).hostname === 'dev.azure.com');
  const services = configuredServices();
  const usedIds = new Set();
  const matches = azureEntries.map((entry) => {
    const service = findServiceMatch(services, entry, null, usedIds);
    if (service) usedIds.add(service.id);
    return service;
  });

  assert.equal(entries.length, 27);
  assert.equal(azureEntries.length, 26);
  assert.ok(entries.every((entry) => entry.label === null && entry.group === null));
  assert.equal(matches.filter(Boolean).length, 21);
});

test('recognizes duplicate Azure runs despite query parameter order and view options', () => {
  const first = 'https://dev.azure.com/org/project/_build/results?buildId=123&view=results';
  const second = 'https://dev.azure.com/org/project/_build/results?view=logs&buildId=123';
  const entries = [{ url: first }, { url: second }];

  assert.equal(getUrlIdentity(first), getUrlIdentity(second));
  assert.equal(countUrlOccurrences(entries).get(getUrlIdentity(first)), 2);
  assert.deepEqual(uniqueUrlEntries(entries), [entries[0]]);
});

test('reports every service that already contains an incoming URL', () => {
  const url = 'https://dev.azure.com/org/project/_build/results?buildId=123';
  const services = [
    { id: 1, group: 'Identity', name: 'Pathfinder', pipelineUrl: `${url}&view=results` },
    { id: 2, group: 'Identity', name: 'Hello', pipelineUrl: `${url}&view=logs` },
    { id: 3, group: 'AG', name: 'Other', pipelineUrl: '' }
  ];

  assert.deepEqual(
    findExistingAssignments(services, url).map((service) => service.name),
    ['Pathfinder', 'Hello']
  );
});

test('URL-only import strips headings and Markdown labels', () => {
  const url = 'https://dev.azure.com/org/project/_build/results?buildId=123';
  const entries = extractUrlsOnly(`AG\nAG API\n[Wrong human label](${url})`);

  assert.deepEqual(entries, [{ label: null, group: null, url }]);
});

test('matches one Azure pipeline name across region-qualified service rows', () => {
  const services = [
    { id: 1, group: 'Studio', name: 'Yarp API (NA)', pipelineUrl: '' },
    { id: 2, group: 'Studio', name: 'Yarp API (EMEA)', pipelineUrl: '' },
    { id: 3, group: 'Studio', name: 'Yarp API (APAC)', pipelineUrl: '' }
  ];
  const usedIds = new Set();
  const matches = services.map(() => {
    const service = findServiceMatch(
      services,
      { label: null, group: null, url: 'https://dev.azure.com/org/project/_build/results?buildId=1' },
      'MRI-Software.MRI.Agora.Internal.Yarp.Api',
      usedIds
    );
    usedIds.add(service.id);
    return service.name;
  });

  assert.deepEqual(matches, ['Yarp API (NA)', 'Yarp API (EMEA)', 'Yarp API (APAC)']);
});