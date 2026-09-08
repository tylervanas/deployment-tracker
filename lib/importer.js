function extractUrlEntries(text, groupNames = []) {
  const entries = [];
  let nearbyLabel = null;
  let nearbyGroup = null;
  const groupsByNormalizedName = new Map(
    groupNames.map((groupName) => [normalizeName(groupName), groupName])
  );

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const markdownLinks = [...line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi)];
    const links = markdownLinks.length
      ? markdownLinks.map((match) => ({ label: cleanLabel(match[1]), url: cleanUrl(match[2]) }))
      : [...line.matchAll(/https?:\/\/[^\s<>()\[\]]+/gi)].map((match) => ({
          label: null,
          url: cleanUrl(match[0])
        }));

    if (!links.length) {
      const label = cleanLabel(line);
      const group = groupsByNormalizedName.get(normalizeName(label));
      if (group && group !== nearbyGroup) {
        nearbyGroup = group;
        nearbyLabel = null;
      } else if (label) {
        nearbyLabel = label;
      }
      continue;
    }

    for (const link of links) {
      const directLabel = link.label && !/^https?:\/\//i.test(link.label) ? link.label : null;
      entries.push({ label: directLabel || nearbyLabel, group: nearbyGroup, url: link.url });
    }
  }

  return entries;
}

function extractUrlsOnly(text) {
  return extractUrlEntries(text).map((entry) => ({
    label: null,
    group: null,
    url: entry.url
  }));
}

function findServiceMatch(services, entry, pipelineName, usedIds = new Set()) {
  const unused = services.filter((service) => !usedIds.has(service.id));
  if (pipelineName) {
    return findBestNameMatch(unused, [pipelineName]);
  }

  const available = unused.filter(
    (service) =>
      (!entry.group || normalizeName(service.group) === normalizeName(entry.group))
  );

  if (entry.label) {
    const exactLabel = available.find(
      (service) => nameMatchScore(service.name, entry.label) === 100
    );
    if (exactLabel) return exactLabel;
  }

  const entryIdentity = getUrlIdentity(entry.url);
  const sameUrl = available.find(
    (service) => service.pipelineUrl && getUrlIdentity(service.pipelineUrl) === entryIdentity
  );
  if (sameUrl) return sameUrl;

  return findBestNameMatch(available, [entry.label].filter(Boolean));
}

function findBestNameMatch(services, names) {
  let best = null;
  let bestScore = 0;
  for (const service of services) {
    const serviceNames = [service.name, stripRegionQualifier(service.name), ...(service.acceptedPipelineNames || [])];
    const score = Math.max(
      ...serviceNames.flatMap((serviceName) =>
        names.map((name) => nameMatchScore(serviceName, name))
      ),
      0
    );
    if (score > bestScore) {
      best = service;
      bestScore = score;
    }
  }
  return bestScore >= 60 ? best : null;
}

function nameMatchScore(expectedName, candidateName) {
  const expected = normalizeName(expectedName);
  const candidate = normalizeName(candidateName);
  if (!expected || !candidate) return 0;
  if (expected === candidate) return 100;
  if (Math.min(expected.length, candidate.length) >= 5) {
    if (expected.includes(candidate) || candidate.includes(expected)) return 60;
  }
  return 0;
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripRegionQualifier(value) {
  return String(value || '').replace(/\s*\((NA|EMEA|APAC)\)\s*$/i, '').trim();
}

function cleanLabel(value) {
  return String(value || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^[-*]\s+/, '')
    .trim();
}

function cleanUrl(value) {
  return String(value || '').replace(/[.,;:]+$/, '');
}

function getUrlIdentity(rawUrl) {
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

    if (organization && project && buildId) {
      return `azure:${normalizeName(organization)}:${normalizeName(project)}:build:${buildId}`;
    }
    if (organization && project && releaseId && environmentId) {
      return `azure:${normalizeName(organization)}:${normalizeName(project)}:release:${releaseId}:${environmentId}`;
    }

    url.hash = '';
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(rawUrl || '').trim().toLowerCase();
  }
}

function countUrlOccurrences(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const identity = getUrlIdentity(entry.url);
    counts.set(identity, (counts.get(identity) || 0) + 1);
  }
  return counts;
}

function uniqueUrlEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const identity = getUrlIdentity(entry.url);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function findExistingAssignments(services, rawUrl) {
  const identity = getUrlIdentity(rawUrl);
  return services.filter(
    (service) => service.pipelineUrl && getUrlIdentity(service.pipelineUrl) === identity
  );
}

module.exports = {
  extractUrlEntries,
  extractUrlsOnly,
  findServiceMatch,
  nameMatchScore,
  getUrlIdentity,
  countUrlOccurrences,
  uniqueUrlEntries,
  findExistingAssignments,
  normalizeName,
  stripRegionQualifier
};