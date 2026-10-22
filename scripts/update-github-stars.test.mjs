import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REPOSITORIES, updateSnapshot, validateSnapshot } from './update-github-stars.mjs';

const sampleTime = '2026-10-22T12:34:56.000Z';
const validSnapshot = {
  schemaVersion: 1,
  checkedAt: sampleTime,
  repositories: {
    'bytedance/deer-flow': { count: 84_280, checkedAt: sampleTime },
    'loopx-project/loopx': { count: 6_393, checkedAt: sampleTime },
  },
};

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'github-stars-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function githubResponse(repository, count, status = 200) {
  return new Response(JSON.stringify({ full_name: repository, stargazers_count: count }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('validates exact repositories, safe counts, and a shared canonical timestamp', () => {
  assert.equal(validateSnapshot(validSnapshot), validSnapshot);
  const mismatchedTimestamp = structuredClone(validSnapshot);
  mismatchedTimestamp.repositories['bytedance/deer-flow'].checkedAt = '2026-10-22T12:00:00.000Z';
  assert.throws(() => validateSnapshot(mismatchedTimestamp), /invalid for bytedance\/deer-flow/);
  const unexpectedRepository = structuredClone(validSnapshot);
  unexpectedRepository.repositories['someone/private-repo'] = { count: 1, checkedAt: sampleTime };
  assert.throws(() => validateSnapshot(unexpectedRepository), /exactly the configured repositories/);
  const unsafeCount = structuredClone(validSnapshot);
  unsafeCount.repositories['loopx-project/loopx'].count = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateSnapshot(unsafeCount), /invalid for loopx-project\/loopx/);
});

test('fetches only the allowlisted repositories and writes one validated snapshot', async () => {
  await withDirectory(async directory => {
    const outputPath = join(directory, 'data', 'github-stars.json');
    const authorizationHeaders = [];
    const snapshotTime = new Date(sampleTime);
    const fetcher = async (url, options) => {
      authorizationHeaders.push(options.headers.Authorization);
      const repository = url.replace('https://api.github.com/repos/', '');
      return githubResponse(repository, repository === REPOSITORIES[0] ? 84_280 : 6_393);
    };
    const snapshot = await updateSnapshot({
      token: 'test-token',
      outputPath,
      fetcher,
      now: () => new Date(snapshotTime),
      wait: async () => {},
    });
    assert.deepEqual(snapshot, validSnapshot);
    assert.deepEqual(authorizationHeaders, ['Bearer test-token', 'Bearer test-token']);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), validSnapshot);
  });
});

test('keeps the previous file intact when either repository cannot be refreshed', async () => {
  await withDirectory(async directory => {
    const outputPath = join(directory, 'data', 'github-stars.json');
    const oldContent = `${JSON.stringify(validSnapshot, null, 2)}\n`;
    await mkdir(join(directory, 'data'));
    await writeFile(outputPath, oldContent);
    let failingAttempts = 0;
    const fetcher = async url => {
      const repository = url.replace('https://api.github.com/repos/', '');
      if (repository === 'loopx-project/loopx') {
        failingAttempts += 1;
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
      }
      return githubResponse(repository, 84_300);
    };
    await assert.rejects(updateSnapshot({
      token: 'test-token', outputPath, fetcher, wait: async () => {}, now: () => new Date(sampleTime),
    }), /Could not update Stars for loopx-project\/loopx/);
    assert.equal(failingAttempts, 4);
    assert.equal(await readFile(outputPath, 'utf8'), oldContent);
  });
});

test('retries a transient upstream failure before producing the snapshot', async () => {
  await withDirectory(async directory => {
    const outputPath = join(directory, 'data', 'github-stars.json');
    let attempts = 0;
    const fetcher = async url => {
      const repository = url.replace('https://api.github.com/repos/', '');
      if (repository === 'bytedance/deer-flow' && attempts++ === 0) return new Response('temporary', { status: 503 });
      return githubResponse(repository, repository === REPOSITORIES[0] ? 84_280 : 6_393);
    };
    const snapshot = await updateSnapshot({ token: 'test-token', outputPath, fetcher, wait: async () => {}, now: () => new Date(sampleTime) });
    assert.equal(attempts, 2);
    assert.deepEqual(snapshot, validSnapshot);
  });
});

test('refuses to replace a corrupt existing snapshot', async () => {
  await withDirectory(async directory => {
    const outputPath = join(directory, 'data', 'github-stars.json');
    await mkdir(join(directory, 'data'));
    await writeFile(outputPath, '{broken');
    let requests = 0;
    await assert.rejects(updateSnapshot({
      token: 'test-token', outputPath, fetcher: async () => { requests += 1; },
    }), /Existing Stars snapshot is invalid/);
    assert.equal(requests, 0);
    assert.equal(await readFile(outputPath, 'utf8'), '{broken');
  });
});

test('missing token and invalid upstream metadata do not publish a snapshot', async () => {
  await withDirectory(async directory => {
    const outputPath = join(directory, 'data', 'github-stars.json');
    await assert.rejects(updateSnapshot({ token: '', outputPath, fetcher: async () => githubResponse(REPOSITORIES[0], 1) }), /GITHUB_TOKEN is required/);
    await assert.rejects(readFile(outputPath, 'utf8'), { code: 'ENOENT' });

    const fetcher = async url => {
      const repository = url.replace('https://api.github.com/repos/', '');
      return repository === REPOSITORIES[0]
        ? githubResponse('unexpected/repository', 84_280)
        : githubResponse(repository, 6_393);
    };
    await assert.rejects(updateSnapshot({ token: 'test-token', outputPath, fetcher }), /unexpected repository metadata/);
    await assert.rejects(readFile(outputPath, 'utf8'), { code: 'ENOENT' });
  });
});

test('rejects an equal or older timestamp and leaves the existing snapshot untouched', async () => {
  await withDirectory(async directory => {
    const outputPath = join(directory, 'data', 'github-stars.json');
    await mkdir(join(directory, 'data'));
    const oldContent = `${JSON.stringify(validSnapshot, null, 2)}\n`;
    await writeFile(outputPath, oldContent);
    const fetcher = async url => {
      const repository = url.replace('https://api.github.com/repos/', '');
      return githubResponse(repository, repository === REPOSITORIES[0] ? 84_300 : 6_400);
    };
    for (const currentTime of [sampleTime, '2026-10-22T12:34:55.000Z']) {
      await assert.rejects(updateSnapshot({
        token: 'test-token', outputPath, fetcher, now: () => new Date(currentTime),
      }), /must be later than/);
      assert.equal(await readFile(outputPath, 'utf8'), oldContent);
    }
  });
});

test('accepts legitimate decreases in counts when the snapshot time advances', async () => {
  await withDirectory(async directory => {
    const outputPath = join(directory, 'data', 'github-stars.json');
    await mkdir(join(directory, 'data'));
    await writeFile(outputPath, `${JSON.stringify(validSnapshot, null, 2)}\n`);
    const newerTime = '2026-10-22T12:35:56.000Z';
    const fetcher = async url => {
      const repository = url.replace('https://api.github.com/repos/', '');
      return githubResponse(repository, repository === REPOSITORIES[0] ? 84_270 : 6_390);
    };
    const snapshot = await updateSnapshot({
      token: 'test-token', outputPath, fetcher, now: () => new Date(newerTime),
    });
    assert.equal(snapshot.checkedAt, newerTime);
    assert.equal(snapshot.repositories['bytedance/deer-flow'].count, 84_270);
    assert.equal(snapshot.repositories['loopx-project/loopx'].count, 6_390);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), snapshot);
  });
});
