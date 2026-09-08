const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveBranch,
  resolveQueueTarget,
  aggregateReleaseRuns
} = require('./lib/queue');

test('maps one release version across AG and IAM branch families', () => {
  assert.equal(
    resolveBranch(
      { defaultBranch: 'refs/heads/release/release-iam-2026.03' },
      'release/release-ag-2026.04'
    ),
    'release/release-iam-2026.04'
  );
});

test('maps Regional Production by region while non-production ignores region', () => {
  const config = {
    type: 'build',
    parameters: {},
    templateParameters: { environment: 'staging-CUS' },
    targetParameter: { location: 'templateParameters', name: 'environment' },
    targetMappings: {
      Staging: 'staging-CUS',
      'Production:NA': 'prod-CUS',
      'Production:EMEA': 'prod-EMEA'
    }
  };
  assert.equal(
    resolveQueueTarget(config, 'Staging', 'APAC', 'Regional').targetValue,
    'staging-CUS'
  );
  assert.equal(
    resolveQueueTarget(config, 'Production', 'NA', 'Regional').targetValue,
    'prod-CUS'
  );
  assert.equal(resolveQueueTarget(config, 'Production', '', 'Regional'), null);
});

test('uses CUS as the preferred logical NA target when configured', () => {
  const config = {
    type: 'build',
    targetParameter: { location: 'templateParameters', name: 'environment' },
    targetMappings: { 'Production:NA': 'prod-CUS' }
  };
  assert.equal(
    resolveQueueTarget(config, 'Production', 'NA', 'Regional').targetValue,
    'prod-CUS'
  );
});

test('resolves Global release fanout to multiple environments', () => {
  const config = {
    type: 'build-release',
    environments: [
      { id: 1, name: 'Production-CUS' },
      { id: 2, name: 'Production-GBR' },
      { id: 3, name: 'Production-AUS' }
    ],
    environmentMappings: { Production: [1, 2, 3] }
  };
  const target = resolveQueueTarget(config, 'Production', 'NA', 'Global');
  assert.deepEqual(target.environmentIds, [1, 2, 3]);
});

test('skips service rows that do not apply to the selected lifecycle', () => {
  const result = resolveQueueTarget(
    {
      type: 'build',
      applicableLifecycles: ['Release', 'Staging', 'Demo', 'Production'],
      targetParameter: { location: 'templateParameters', name: 'environment' },
      targetMappings: { Production: 'prod-EMEA' }
    },
    'Dev',
    '',
    'Global'
  );
  assert.deepEqual(result, { applicable: false });
});

test('awaiting approval wins when aggregating release environments', () => {
  assert.deepEqual(
    aggregateReleaseRuns([
      { status: 'succeeded' },
      { status: 'awaitingApproval' },
      { status: 'queued' }
    ]),
    { status: 'awaitingApproval', message: 'One or more release environments await approval.' }
  );
});
