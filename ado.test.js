const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchBuildStatus,
  fetchReleaseStatus,
  inspectRunConfiguration,
  fetchRepositoryBranches,
  fetchRecentBuildConfigurations,
  findLatestReleaseForBranch,
  extractEnvironmentMap,
  deployExistingReleaseEnvironment,
  queueBuild,
  createReleaseAndDeploy,
  findPackageVersion,
  fetchPackageVersions,
  createPackageReleaseAndDeploy,
  normalizeReleaseEnvironment
} = require('./lib/ado');

function mockFetch(body, inspectUrl) {
  return async (url) => {
    inspectUrl(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body
    };
  };
}

test('fetches a Build definition name from Azure DevOps', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch(
    {
      status: 'completed',
      result: 'failed',
      buildNumber: '20260907.1',
      definition: { name: 'Config Function Home' },
      _links: { web: { href: 'https://dev.azure.com/example/build/1' } }
    },
    (url) => assert.match(url, /_apis\/build\/builds\/898625/)
  );

  try {
    const result = await fetchBuildStatus({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      buildId: '898625',
      token: 'test-token'
    });
    assert.equal(result.pipelineName, 'Config Function Home');
    assert.equal(result.status, 'failed');
    assert.equal(result.webUrl, 'https://dev.azure.com/example/build/1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetches a classic Release definition name from Azure DevOps', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch(
    {
      status: 'inProgress',
      name: 'Production',
      release: { name: 'Release-15654' },
      releaseDefinition: { name: 'AG Home SWA' }
    },
    (url) => {
      assert.match(url, /^https:\/\/vsrm\.dev\.azure\.com/);
      assert.match(url, /releases\/15654\/environments\/104796/);
    }
  );

  try {
    const result = await fetchReleaseStatus({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      releaseId: '15654',
      environmentId: '104796',
      token: 'test-token'
    });
    assert.equal(result.pipelineName, 'AG Home SWA');
    assert.equal(result.status, 'running');
    assert.match(result.webUrl, /releaseId=15654&environmentId=104796/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('inspects release build artifacts, environments, branch, and safe parameters', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    let body;
    if (url.includes('/_apis/release/releases/15654?')) {
      body = {
        releaseDefinition: { id: 50, name: 'AG Home SWA Release' },
        environments: [{ id: 104796, definitionEnvironmentId: 7, name: 'UK' }],
        artifacts: [{
          alias: '_AG-Home',
          type: 'Build',
          definitionReference: {
            definition: { id: '42', name: 'AG Home Build' },
            version: { id: '898625', name: '20260907.1' },
            branch: { id: 'refs/heads/main' }
          }
        }]
      };
    } else if (url.includes('/_apis/release/definitions/50?')) {
      body = { environments: [{ id: 7, name: 'UK', rank: 1 }, { id: 8, name: 'AU', rank: 2 }] };
    } else if (url.includes('/_apis/build/builds/898625?')) {
      body = {
        id: 898625,
        buildNumber: '20260907.1',
        sourceBranch: 'refs/heads/main',
        definition: { id: 42, name: 'AG Home Build' },
        repository: { id: 'repo-1', name: 'ag-home', type: 'TfsGit' },
        parameters: '{"region":"UK","apiToken":"secret-value"}',
        templateParameters: { deploy: true }
      };
    } else {
      throw new Error(`Unexpected URL: ${url}`);
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };

  try {
    const result = await inspectRunConfiguration({
      type: 'release',
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      releaseId: '15654',
      environmentId: '104796',
      token: 'test-token'
    });
    assert.equal(result.releaseDefinition.id, 50);
    assert.deepEqual(result.environments.map((environment) => environment.name), ['UK', 'AU']);
    assert.equal(result.artifacts[0].build.definitionId, 42);
    assert.equal(result.artifacts[0].build.sourceBranch, 'refs/heads/main');
    assert.equal(result.artifacts[0].build.parameters.region, 'UK');
    assert.equal(result.artifacts[0].build.parameters.apiToken, '[redacted]');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetches repository branches without refs/heads prefixes', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch(
    { value: [
      { name: 'refs/heads/main', objectId: 'abc' },
      { name: 'refs/heads/release/release-ag-2026.03', objectId: 'def' }
    ] },
    (url) => assert.match(url, /_apis\/git\/repositories\/repo-1\/refs\?filter=heads%2F/)
  );

  try {
    const branches = await fetchRepositoryBranches({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      repositoryId: 'repo-1',
      token: 'test-token'
    });
    assert.deepEqual(branches.map((branch) => branch.name), ['main', 'release/release-ag-2026.03']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('maps pipeline environment parameters to environment resources exactly', () => {
  const yaml = [
    "- \${{ if eq(parameters.environment, 'dev') }}:",
    '  - stage: Deploy_Dev',
    '    jobs:',
    '    - deployment:',
    '      environment: ',
    '        name: env-ag-notifications-dev',
    "# - \${{ if eq(parameters.environment, 'staging-NA') }}:",
    '#   - deployment:',
    '#       environment: ',
    '#         name: env-ag-notifications-staging-WRONG',
    "- \${{ if or(and(eq(parameters.environment, 'staging-CUS'), true), false) }}:",
    '  - stage: Deploy_Staging',
    '    jobs:',
    '    - deployment:',
    '      environment: ',
    '        name: env-ag-notifications-staging',
    "- \${{ if eq(parameters.environment, 'prod-CUS') }}:",
    '  - stage: Deploy_Prod',
    '    jobs:',
    '    - deployment:',
    '      environment: env-ag-notifications-prod-cus'
  ].join('\n');

  const map = extractEnvironmentMap(yaml);
  assert.deepEqual(map.get('dev').names, ['env-ag-notifications-dev']);
  assert.deepEqual(map.get('staging-cus').names, ['env-ag-notifications-staging']);
  assert.deepEqual(map.get('prod-cus').names, ['env-ag-notifications-prod-cus']);
  assert.equal(map.has('staging-na'), false, 'commented-out blocks must be ignored');
});

test('resolves environment names that interpolate the environment parameter', () => {
  const yaml = [
    "- \${{ if eq(parameters.environment, 'prod') }}:",
    '  - stage: Deploy_Production',
    '    jobs:',
    "    - deployment: deploy_\${{ parameters.environment }}",
    '      environment:',
    "        name: env-identity-sync-\${{ parameters.environment }}",
    "- \${{ if eq(parameters.environment, 'prod_GLOBAL') }}:",
    '  - stage: Deploy_Prod_Global',
    '    jobs:',
    '    - deployment:',
    '      environment:',
    "        name: env-proxy-api-\${{ parameters.environment }}"
  ].join('\n');

  const map = extractEnvironmentMap(yaml);
  assert.ok(map.get('prod').names.includes('env-identity-sync-prod'));
  assert.ok(map.get('prod_global').names.includes('env-proxy-api-prod_GLOBAL'));
});

test('collects template references so nested deployment environments can be found', () => {
  const yaml = [
    "- \${{ if eq(parameters.environment, 'demo_GLOBAL') }}:",
    '  - stage: Deploy_Demo',
    '    jobs:',
    '    - template: ./deploy.yml',
    '      parameters:',
    "        environment: \${{ parameters.environment }}"
  ].join('\n');

  const entry = extractEnvironmentMap(yaml).get('demo_global');
  assert.deepEqual(entry.templates, ['./deploy.yml']);
  assert.deepEqual(entry.names, ['demo_GLOBAL'], 'template arguments are candidates, not confirmed environments');
});

test('finds the newest release built from the selected branch', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/releases?')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ value: [
          { id: 15700, artifacts: [{ definitionReference: { branch: { name: 'refs/heads/develop' } } }] },
          { id: 15648, artifacts: [{ definitionReference: { branch: { name: 'refs/heads/release/release-ag-2026.03' } } }] }
        ] })
      };
    }
    assert.match(url, /_apis\/release\/releases\/15648/);
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({
        id: 15648,
        name: 'Release-139',
        releaseDefinition: { id: 59, name: 'Agora-Admin-SWA' },
        artifacts: [{ definitionReference: { branch: { name: 'refs/heads/release/release-ag-2026.03' }, version: { name: '20260907.1', id: '898000' } } }],
        environments: [
          { id: 90001, definitionEnvironmentId: 436, name: 'DEV', status: 'succeeded', deploySteps: [{ lastModifiedOn: '2026-09-06T10:00:00Z' }] },
          { id: 90002, definitionEnvironmentId: 437, name: 'QA', status: 'succeeded', deploySteps: [{ lastModifiedOn: '2026-09-07T09:00:00Z' }] },
          { id: 90003, definitionEnvironmentId: 441, name: 'Prod-CUS', status: 'notStarted', deploySteps: [] }
        ]
      })
    };
  };

  try {
    const release = await findLatestReleaseForBranch({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      releaseDefinitionId: 59,
      sourceBranch: 'release/release-ag-2026.03',
      token: 'test-token'
    });
    assert.equal(release.releaseId, 15648);
    assert.equal(release.buildNumber, '20260907.1');
    assert.equal(release.lastDeployed.name, 'QA');
    assert.equal(release.environments.find((e) => e.definitionEnvironmentId === 441).environmentId, 90003);
  } finally {
    global.fetch = originalFetch;
  }
});

test('redeploys an environment on an existing release', async () => {
  const originalFetch = global.fetch;
  let seen = {};
  global.fetch = async (url, options) => {
    seen = { url, method: options.method, body: JSON.parse(options.body) };
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ name: 'Prod-CUS', status: 'inProgress' })
    };
  };
  try {
    const result = await deployExistingReleaseEnvironment({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      releaseId: 15648,
      environmentId: 90003,
      token: 'test-token'
    });
    assert.match(seen.url, /releases\/15648\/environments\/90003/);
    assert.equal(seen.method, 'PATCH');
    assert.equal(seen.body.status, 'inProgress');
    assert.equal(result.status, 'running');
  } finally {
    global.fetch = originalFetch;
  }
});

test('queues a build with the selected branch and fixed parameters', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.match(url, /_apis\/build\/builds\?/);
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.definition, { id: 273 });
    assert.equal(body.sourceBranch, 'refs/heads/release/release-ag-2026.03');
    assert.equal(JSON.parse(body.parameters).run_build_task, 'y');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        id: 900001,
        status: 'notStarted',
        definition: { name: 'AG Home Build' },
        sourceBranch: body.sourceBranch,
        _links: { web: { href: 'https://dev.azure.com/example/build/900001' } }
      })
    };
  };

  try {
    const result = await queueBuild({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      definitionId: 273,
      sourceBranch: 'release/release-ag-2026.03',
      parameters: { run_build_task: 'y' },
      token: 'test-token'
    });
    assert.equal(result.buildId, 900001);
    assert.equal(result.status, 'queued');
  } finally {
    global.fetch = originalFetch;
  }
});

test('creates a release and starts the selected environment', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    const body = options.method === 'POST'
      ? {
          id: 16000,
          name: 'Release-900',
          releaseDefinition: { name: 'AG-HOME' },
          environments: [{ id: 11000, definitionEnvironmentId: 410, status: 'notStarted' }]
        }
      : { id: 11000, definitionEnvironmentId: 410, status: 'inProgress' };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };

  try {
    const result = await createReleaseAndDeploy({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      releaseDefinitionId: 48,
      artifactAlias: '_AG-Home',
      environmentDefinitionId: 410,
      buildId: 900001,
      buildNumber: '20260907.9',
      sourceBranch: 'refs/heads/release/release-ag-2026.03',
      sourceVersion: 'abc123',
      token: 'test-token'
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.definitionId, 48);
    assert.deepEqual(requests[0].body.manualEnvironments, [410]);
    assert.equal(requests[1].body.status, 'inProgress');
    assert.equal(result.status, 'running');
    assert.match(result.webUrl, /releaseId=16000&environmentId=11000/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('finds an exact package version in an Azure Artifacts feed', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch(
    { value: [{ id: 'package-1', name: 'ag-widget', versions: [
      { id: 'version-1', version: '6.13.0' },
      { id: 'version-2', version: '6.12.0' }
    ] }] },
    (url) => assert.match(url, /feeds\.dev\.azure\.com.*packageNameQuery=ag-widget/)
  );
  try {
    const result = await findPackageVersion({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      feedId: 'feed-1',
      packageName: 'ag-widget',
      version: '6.13.0',
      token: 'test-token'
    });
    assert.equal(result.version, '6.13.0');
  } finally {
    global.fetch = originalFetch;
  }
});

test('creates a package release using the requested semantic version', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    const body = options.method === 'POST'
      ? { id: 17000, name: 'Release-Widget', environments: [
          { id: 12000, definitionEnvironmentId: 406, status: 'notStarted' }
        ] }
      : { id: 12000, definitionEnvironmentId: 406, status: 'inProgress' };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  try {
    const result = await createPackageReleaseAndDeploy({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      releaseDefinitionId: 55,
      artifactAlias: 'ag-widget',
      environmentDefinitionId: 406,
      packageVersion: '6.13.0',
      token: 'test-token'
    });
    assert.deepEqual(requests[0].body.artifacts[0].instanceReference, { id: '6.13.0', name: '6.13.0' });
    assert.equal(result.status, 'running');
  } finally {
    global.fetch = originalFetch;
  }
});

test('loads package versions separately when search results omit them', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const body = url.includes('/versions?')
      ? { value: [{ id: 'version-1', version: '6.13.0' }] }
      : { value: [{ id: 'package-1', name: 'ag-widget' }] };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  try {
    const result = await findPackageVersion({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      feedId: 'feed-1',
      packageName: 'ag-widget',
      version: '6.13.0',
      token: 'test-token'
    });
    assert.equal(result.version, '6.13.0');
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizes pending release approvals before queued status', () => {
  assert.deepEqual(
    normalizeReleaseEnvironment({
      status: 'notStarted',
      preDeployApprovals: [{ status: 'pending', approver: { displayName: 'AppAdmin' } }]
    }),
    { status: 'awaitingApproval', message: 'Awaiting approval from AppAdmin.' }
  );
});

test('finds pending approvals nested in release deploy steps', () => {
  const result = normalizeReleaseEnvironment({
    status: 'scheduled',
    deploySteps: [{ preDeployApprovals: [{ status: 'pending' }] }]
  });
  assert.equal(result.status, 'awaitingApproval');
});

test('uses a classic release package ID for exact version validation', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const body = url.includes('/packages/package-1/versions?')
      ? { value: [{ id: 'version-613', normalizedVersion: '6.1.3' }] }
      : { value: [] };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  try {
    const result = await findPackageVersion({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      feedId: 'feed-1',
      packageId: 'package-1',
      packageName: 'ag-widget',
      version: '6.1.3',
      token: 'test-token'
    });
    assert.equal(result.version, '6.1.3');
    assert.equal(result.packageId, 'package-1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetches and expands recent build configurations', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const body = url.includes('definitions=6098')
      ? { value: [{ id: 10 }, { id: 11 }] }
      : {
          id: Number(url.match(/builds\/(\d+)/)?.[1]),
          definition: { id: 6098, name: 'Central Identity' },
          templateParameters: { environment: 'staging_GLOBAL', datacenter: 'ia01' }
        };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  try {
    const builds = await fetchRecentBuildConfigurations({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      definitionId: 6098,
      token: 'test-token'
    });
    assert.equal(builds.length, 2);
    assert.ok(builds.every((build) => build.templateParameters.datacenter === 'ia01'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('lists package versions newest first', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch(
    { value: [
      { normalizedVersion: '6.1.3' },
      { normalizedVersion: '6.10.0' },
      { normalizedVersion: '5.9.1' }
    ] },
    (url) => assert.match(url, /packages\/package-1\/versions/)
  );
  try {
    const versions = await fetchPackageVersions({
      organization: 'mrisoftware',
      project: 'MRI_Platform',
      feedId: 'feed-1',
      packageId: 'package-1',
      token: 'test-token'
    });
    assert.deepEqual(versions, ['6.10.0', '6.1.3', '5.9.1']);
  } finally {
    global.fetch = originalFetch;
  }
});
