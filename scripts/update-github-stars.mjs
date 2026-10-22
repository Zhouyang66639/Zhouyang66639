import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORIES = Object.freeze([
  'bytedance/deer-flow',
  'loopx-project/loopx',
]);

export const DEFAULT_OUTPUT_PATH = fileURLToPath(new URL('../data/github-stars.json', import.meta.url));

const API_VERSION = '2022-11-28';
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

function isCanonicalTimestamp(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Stars snapshot must be an object');
  }
  const rootKeys = Object.keys(snapshot).sort();
  if (rootKeys.join(',') !== 'checkedAt,repositories,schemaVersion') {
    throw new TypeError('Stars snapshot has an unexpected shape');
  }
  if (snapshot.schemaVersion !== 1 || !isCanonicalTimestamp(snapshot.checkedAt)) {
    throw new TypeError('Stars snapshot version or timestamp is invalid');
  }
  if (!snapshot.repositories || typeof snapshot.repositories !== 'object' || Array.isArray(snapshot.repositories)) {
    throw new TypeError('Stars repositories must be an object');
  }
  if (Object.keys(snapshot.repositories).sort().join(',') !== [...REPOSITORIES].sort().join(',')) {
    throw new TypeError('Stars snapshot must contain exactly the configured repositories');
  }

  for (const repository of REPOSITORIES) {
    const entry = snapshot.repositories[repository];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'checkedAt,count'
      || !Number.isSafeInteger(entry.count) || entry.count < 0
      || entry.checkedAt !== snapshot.checkedAt) {
      throw new TypeError(`Stars entry is invalid for ${repository}`);
    }
  }
  return snapshot;
}

function parseRetryAfter(response, now) {
  const raw = response.headers.get('retry-after');
  if (raw && /^\d+$/.test(raw)) return Number(raw) * 1_000;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.max(0, parsed - now);
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1_000;
    if (Number.isFinite(reset)) return Math.max(0, reset - now);
  }
  return 0;
}

function isRetryableStatus(status) {
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

export async function fetchRepositoryStars(repository, token, {
  fetcher = globalThis.fetch,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now = Date.now,
  attempts = MAX_ATTEMPTS,
} = {}) {
  if (!REPOSITORIES.includes(repository)) throw new RangeError('Repository is not in the allowlist');
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('GITHUB_TOKEN is required');

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(`https://api.github.com/repos/${repository}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Zhouyang-GitHub-Stars-Workflow',
          'X-GitHub-Api-Version': API_VERSION,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const error = new Error(`GitHub returned HTTP ${response.status} for ${repository}`);
        if (!isRetryableStatus(response.status) || attempt === attempts - 1) throw error;
        const retryAfter = parseRetryAfter(response, now());
        const delay = Math.min(300_000, Math.max(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1), retryAfter));
        await wait(delay);
        lastError = error;
        continue;
      }

      const data = await response.json();
      if (typeof data?.full_name !== 'string' || data.full_name.toLowerCase() !== repository.toLowerCase()) {
        throw new TypeError(`GitHub returned unexpected repository metadata for ${repository}`);
      }
      if (!Number.isSafeInteger(data.stargazers_count) || data.stargazers_count < 0) {
        throw new TypeError(`GitHub returned an invalid star count for ${repository}`);
      }
      return data.stargazers_count;
    } catch (error) {
      lastError = error;
      if (error instanceof TypeError && /unexpected repository metadata|invalid star count|allowlist|GITHUB_TOKEN/.test(error.message)) throw error;
      if (attempt === attempts - 1) break;
      await wait(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1));
    }
  }
  throw new Error(`Could not update Stars for ${repository} after ${attempts} attempts`, { cause: lastError });
}

async function readExistingSnapshot(outputPath) {
  try {
    const existing = JSON.parse(await readFile(outputPath, 'utf8'));
    return validateSnapshot(existing);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Existing Stars snapshot is invalid; refusing to replace ${outputPath}`, { cause: error });
  }
}

async function writeAtomically(outputPath, snapshot) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function updateSnapshot({
  token = process.env.GITHUB_TOKEN,
  outputPath = DEFAULT_OUTPUT_PATH,
  fetcher = globalThis.fetch,
  wait,
  now = () => new Date(),
} = {}) {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('GITHUB_TOKEN is required');
  const existing = await readExistingSnapshot(outputPath);

  const counts = await Promise.all(REPOSITORIES.map(repository => fetchRepositoryStars(repository, token, { fetcher, wait, now: () => now().getTime() })));
  const checkedAt = now().toISOString();
  if (existing && Date.parse(checkedAt) <= Date.parse(existing.checkedAt)) {
    throw new Error(`New Stars snapshot timestamp ${checkedAt} must be later than ${existing.checkedAt}`);
  }
  const snapshot = validateSnapshot({
    schemaVersion: 1,
    checkedAt,
    repositories: Object.fromEntries(REPOSITORIES.map((repository, index) => [repository, { count: counts[index], checkedAt }])),
  });
  await writeAtomically(outputPath, snapshot);
  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const snapshot = await updateSnapshot();
    for (const repository of REPOSITORIES) {
      const { count } = snapshot.repositories[repository];
      console.log(`${repository}: ${count}`);
    }
    console.log(`Snapshot checked at ${snapshot.checkedAt}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = REPOSITORIES.map(repository => `| ${repository} | ${snapshot.repositories[repository].count} |`).join('\n');
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `## Upstream GitHub Stars refreshed\n\n| Repository | Exact Stars |\n| --- | ---: |\n${rows}\n\nChecked at ${snapshot.checkedAt} (UTC).\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Stars update failed');
    process.exitCode = 1;
  }
}
