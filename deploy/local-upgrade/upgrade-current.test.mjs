import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertActivePin, assertFreshBackup, assertSnapshotPins, candidateCompose, mergeAssetInventory,
  promotedCompose, promotedState, publicSummary, quotaResponseSummary, releaseIdentity,
  rollbackPlan, runHotSwitch
} from './upgrade-current.mjs'
import { desiredCompose, names } from './service-recovery.mjs'

const currentImage = 'sha256:' + 'a'.repeat(64)
const nextImage = 'sha256:' + 'b'.repeat(64)
const commit = '0123456789ab' + 'c'.repeat(28)
const repositoryRoot = '/tmp/sub2api-repository-fixture'
const manifest = { version: '0.2.13', platform: 'linux/arm64', imageId: nextImage, commit }
const manifestPath = join(repositoryRoot, 'release', `sub2api_0.2.13_linux_arm64_${commit.slice(0, 12)}`, 'manifest.json')
const identity = releaseIdentity(manifestPath, manifest, repositoryRoot)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function activeFixture() {
  const config = desiredCompose({ JWT_SECRET: 'fixture-session-secret', TOTP_ENCRYPTION_KEY: '1'.repeat(64),
    DATABASE_HOST: 'fixture-db', DATABASE_PORT: '5432', DATABASE_USER: 'fixture', DATABASE_DBNAME: 'fixture', DATABASE_PASSWORD: 'fixture-password',
    REDIS_HOST: 'fixture-redis', REDIS_PORT: '6379', REDIS_PASSWORD: 'fixture-redis-password' })
  config.services.app.image = currentImage
  const state = { phase: 'active-old-retired', image: currentImage, backgroundOwner: names.app,
    dependencies: [{ name: 'sub2api-postgres', image: 'sha256:' + 'd'.repeat(64) }, { name: 'sub2api-redis', image: 'sha256:' + 'e'.repeat(64) }],
    unrelated: 'preserved' }
  const container = { Id: 'fixture-current-container', Image: currentImage,
    State: { Running: true, Health: { Status: 'healthy' } }, HostConfig: { RestartPolicy: { Name: 'always' } },
    Config: { Labels: { 'com.docker.compose.project': 'sub2api-current' }, Env: Object.entries(config.services.app.environment).map(([key, value]) => `${key}=${value}`) } }
  return { state, config, container }
}

test('current image comes from protected state, compose and live container rather than the historical default', () => {
  const fixture = activeFixture()
  assert.equal(assertActivePin(fixture.state, fixture.config, fixture.container), currentImage)
  for (const field of ['state', 'config', 'container']) {
    const changed = activeFixture()
    if (field === 'state') changed.state.image = nextImage
    if (field === 'config') changed.config.services.app.image = nextImage
    if (field === 'container') changed.container.Image = nextImage
    assert.throws(() => assertActivePin(changed.state, changed.config, changed.container), /disagree/)
  }
})

test('current pin rejects a changed owner, private session, restart policy, health or data/network location', () => {
  const mutations = [
    fixture => { fixture.state.backgroundOwner = 'another-app' },
    fixture => { fixture.container.Config.Env = fixture.container.Config.Env.map(value => value.startsWith('JWT_SECRET=') ? 'JWT_SECRET=changed' : value) },
    fixture => { fixture.container.HostConfig.RestartPolicy.Name = 'no' },
    fixture => { fixture.container.State.Health.Status = 'unhealthy' },
    fixture => { fixture.config.services.app.volumes = ['other-data:/app/data'] },
    fixture => { fixture.config.networks.production.name = 'other-network' }
  ]
  for (const mutate of mutations) {
    const fixture = activeFixture(); mutate(fixture)
    assert.throws(() => assertActivePin(fixture.state, fixture.config, fixture.container))
  }
})

test('release identity is canonical, immutable and unique to its exact commit', () => {
  assert.equal(identity.candidateName, 'sub2api-quota-candidate-0123456789ab')
  assert.equal(identity.candidateVolume, 'sub2api-quota-0123456789ab_candidate-data')
  assert.match(identity.directory, /quota-0\.2\.13-0123456789ab$/)
  assert.equal(identity.candidateBase, 'http://127.0.0.1:18585')
  for (const replacement of [{ version: '0.2.14' }, { platform: 'linux/amd64' }, { imageId: 'latest' }, { commit: 'short' }]) {
    assert.throws(() => releaseIdentity(manifestPath, { ...manifest, ...replacement }, repositoryRoot))
  }
  assert.throws(() => releaseIdentity('/tmp/manifest.json', manifest, repositoryRoot))
})

test('the currently active 3e364ac release has a compatible canonical manifest', async () => {
  const root = '/Users/clawbotbot/Projects/sub2api-neubrutalism'
  const path = join(root, 'release/sub2api_0.2.13_linux_arm64_3e364ac542d0/manifest.json')
  const bytes = await readFile(path), liveManifest = JSON.parse(bytes)
  const prior = releaseIdentity(path, liveManifest, root)
  assert.equal(prior.commit, '3e364ac542d0463133adaebd6c1e01cc11fdfdd7')
  assert.equal(prior.image, 'sha256:581ca60710bbd7762645d0cbd5355da832edf0ee2a30639b9a6b37826968e966')
  assert.equal(hash(bytes), 'd7feed7d2c8ff42a06b65c60716f99379b37dee892a28820e3015567a9fa9c34')
})

test('candidate uses independent app data and shared sessions/dependencies while all three background roles stay off', () => {
  const { config } = activeFixture(), original = structuredClone(config)
  const candidate = candidateCompose(config, identity)
  assert.equal(candidate.services.app.image, nextImage)
  assert.equal(candidate.services.app.restart, 'no')
  assert.deepEqual(candidate.services.app.ports, ['127.0.0.1:18585:8080'])
  assert.deepEqual(candidate.services.app.volumes, ['candidate-data:/app/data'])
  assert.equal(candidate.volumes['candidate-data'].name, identity.candidateVolume)
  assert.deepEqual(candidate.networks.production, config.networks.production)
  for (const key of ['JWT_SECRET', 'TOTP_ENCRYPTION_KEY', 'DATABASE_PASSWORD', 'REDIS_PASSWORD']) assert.equal(candidate.services.app.environment[key], config.services.app.environment[key])
  assert.equal(candidate.services.app.environment.TOKEN_REFRESH_ENABLED, 'false')
  assert.equal(candidate.services.app.environment.USAGE_CLEANUP_ENABLED, 'false')
  assert.equal(candidate.services.app.environment.CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR, '1')
  assert.equal(candidate.services.app.environment.AUTO_SETUP, 'false')
  assert.deepEqual(config, original)
})

test('promoting changes the canonical app image and restores sole background ownership without touching entry services', () => {
  const { config } = activeFixture(), original = structuredClone(config)
  const next = promotedCompose(config, nextImage)
  assert.equal(next.services.app.image, nextImage)
  assert.equal(next.services.app.container_name, names.app)
  assert.deepEqual(next.services.app.ports, config.services.app.ports)
  assert.deepEqual(next.services.app.volumes, config.services.app.volumes)
  for (const role of ['TOKEN_REFRESH_ENABLED', 'USAGE_CLEANUP_ENABLED']) assert.equal(next.services.app.environment[role], 'true')
  assert.equal(next.services.app.environment.CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR, '0')
  for (const service of ['ingress', 'assets', 'compat']) assert.deepEqual(next.services[service], config.services[service])
  assert.deepEqual(next.networks, config.networks)
  assert.equal(next.services.app.environment.JWT_SECRET, config.services.app.environment.JWT_SECRET)
  assert.deepEqual(config, original)
})

test('promoted state remains boot compatible and preserves dependency pins and unrelated fields', () => {
  const { state } = activeFixture()
  const upgrade = { ...identity, priorImage: currentImage, manifestSha256: 'f'.repeat(64), backup: '/private/fixture-backup' }
  const next = promotedState(state, upgrade, '2026-10-08T01:00:00.000Z')
  assert.equal(next.phase, 'active-old-retired')
  assert.equal(next.image, nextImage)
  assert.equal(next.backgroundOwner, names.app)
  assert.equal(next.releaseManifest, manifestPath)
  assert.equal(next.releaseManifestSha256, upgrade.manifestSha256)
  assert.deepEqual(next.dependencies, state.dependencies)
  assert.equal(next.unrelated, 'preserved')
  assert.equal(next.directCompatibility, 'http://127.0.0.1:18080')
  assert.equal(state.image, currentImage)
})

test('prior snapshots must agree on exact immutable image and canonical owner', () => {
  const { config, state } = activeFixture()
  assert.doesNotThrow(() => assertSnapshotPins({ config, state }, currentImage))
  for (const changes of [{ image: nextImage }, { phase: 'prepared' }, { backgroundOwner: 'other-app' }]) {
    assert.throws(() => assertSnapshotPins({ config, state: { ...state, ...changes } }, currentImage))
  }
  assert.throws(() => assertSnapshotPins({ config: promotedCompose(config, nextImage), state }, currentImage))
})

function backupFixture(now) {
  const { container, state } = activeFixture()
  const dependencies = state.dependencies.map(item => ({ Image: item.image }))
  return { container, dependencies, record: { started: new Date(now - 60_000).toISOString(), finished: new Date(now - 30_000).toISOString(),
    oldContainerId: container.Id, oldImageId: container.Image, databaseImageId: dependencies[0].Image, redisImageId: dependencies[1].Image,
    archives: ['postgres.dump', 'redis.rdb', 'app-data.tar.gz'].map(name => ({ name, bytes: name === 'redis.rdb' ? (64 << 20) : (256 << 20), sha256: 'a'.repeat(64) })) } }
}

test('fresh backup accepts real maximum archive sizes but rejects each byte beyond its budget', () => {
  const now = Date.parse('2026-10-08T01:00:00Z'), fixture = backupFixture(now)
  assert.doesNotThrow(() => assertFreshBackup(fixture.record, fixture.container, fixture.dependencies, now))
  for (const index of [0, 1, 2]) {
    const record = structuredClone(fixture.record); record.archives[index].bytes++
    assert.throws(() => assertFreshBackup(record, fixture.container, fixture.dependencies, now), /metadata/)
  }
})

test('backup rejects stale or future completion and changed application, dependency or archive identities', () => {
  const now = Date.parse('2026-10-08T01:00:00Z'), fixture = backupFixture(now)
  const records = [
    { ...fixture.record, started: new Date(now - 32 * 60_000).toISOString(), finished: new Date(now - 31 * 60_000).toISOString() },
    { ...fixture.record, finished: new Date(now + 60_001).toISOString() },
    { ...fixture.record, oldContainerId: 'other-container' },
    { ...fixture.record, oldImageId: nextImage },
    { ...fixture.record, databaseImageId: nextImage },
    { ...fixture.record, redisImageId: nextImage },
    { ...fixture.record, archives: fixture.record.archives.slice(0, 2) },
    { ...fixture.record, archives: fixture.record.archives.map(item => ({ ...item, sha256: 'wrong' })) }
  ]
  for (const record of records) assert.throws(() => assertFreshBackup(record, fixture.container, fixture.dependencies, now))
})

const quotaWindow = (now, changes = {}) => ({ key: 'five_hour', utilization: 85, source: 'response_headers', scope: 'account', window_minutes: 300,
  sampled_at: new Date(now - 60_000).toISOString(), resets_at: new Date(now + 60_000).toISOString(), ...changes })

test('upstream errors, absent windows and explicit unknown values remain valid quota page states', () => {
  const now = Date.parse('2026-10-08T01:00:00Z')
  const summary = quotaResponseSummary({ usage: { 1: {}, 2: { quota_windows: [quotaWindow(now, { utilization: null, sampled_at: null, resets_at: null })] } }, errors: { 3: 'private-upstream-error' } }, [1, 2, 3], now)
  assert.deepEqual(summary, { accountsChecked: 3, quotaWindows: 1, errors: 1, unknownAccounts: 3, staleAccounts: 0 })
  assert.deepEqual(quotaResponseSummary({ usage: {}, errors: {} }, [], now), { accountsChecked: 0, quotaWindows: 0, errors: 0, unknownAccounts: 0, staleAccounts: 0 })
  assert(!JSON.stringify(summary).includes('private-upstream-error'))
})

test('expired resets, old samples and unknown timestamps are reported as stale without blocking serving', () => {
  const now = Date.parse('2026-10-08T01:00:00Z')
  for (const change of [{ resets_at: new Date(now - 1).toISOString() }, { sampled_at: new Date(now - 16 * 60_000).toISOString() }, { sampled_at: null }]) {
    const summary = quotaResponseSummary({ usage: { 1: { quota_windows: [quotaWindow(now, change)] } }, errors: {} }, [1], now)
    assert.equal(summary.staleAccounts, 1)
    assert.equal(summary.unknownAccounts, 0)
  }
})

test('quota API validation rejects malformed maps, windows, timestamps, provenance and unrelated account IDs', () => {
  const now = Date.parse('2026-10-08T01:00:00Z')
  for (const batch of [{ usage: [], errors: {} }, { usage: {}, errors: null }, { usage: { 2: {} }, errors: {} }, { usage: {}, errors: { 1: { secret: 'hidden' } } }]) {
    assert.throws(() => quotaResponseSummary(batch, [1], now))
  }
  for (const change of [{ utilization: -1 }, { utilization: NaN }, { source: 'local-as-upstream' }, { scope: 'other' }, { sampled_at: 'invalid' }, { resets_at: undefined }, { window_minutes: 0 }, { model: {} }]) {
    assert.throws(() => quotaResponseSummary({ usage: { 1: { quota_windows: [quotaWindow(now, change)] } }, errors: {} }, [1], now))
  }
})

test('asset inventory retains exact hashed old paths, deduplicates matches and rejects path/hash collisions', () => {
  const path = '/assets/QuotaOverviewView-aBc_1234.js', bytes = Buffer.from('export default {}')
  const previous = [{ path, sha256: hash(bytes), bytes: bytes.length }]
  const merged = mergeAssetInventory(previous, [new Map([[path, bytes], ['/assets/QuotaOverviewView-aBc_5678.css', Buffer.from('body{}')]])])
  assert.equal(merged.assets.length, 2)
  assert.equal(merged.additions.length, 1)
  assert.equal(previous.length, 1)
  assert.throws(() => mergeAssetInventory(previous, [new Map([[path, Buffer.from('changed')]])]), /collision/)
  for (const unsafe of ['/api/v1/auth/me', '/assets/../secret-aBc_1234.js', '/assets/plain.js']) {
    assert.throws(() => mergeAssetInventory([], [new Map([[unsafe, bytes]])]))
  }
  assert.throws(() => mergeAssetInventory([...previous, ...previous], []))
})

test('asset cache byte budgets are checked on the full merged inventory before any write', () => {
  const entries = count => Array.from({ length: count }, (_, index) => ({ path: `/assets/Chunk${index}-aBc_1234.js`, sha256: 'a'.repeat(64), bytes: (8 << 20) }))
  assert.equal(mergeAssetInventory(entries(11), []).assets.length, 11)
  assert.throws(() => mergeAssetInventory(entries(12), []), /retention budget/)
  assert.throws(() => mergeAssetInventory([{ ...entries(1)[0], bytes: (8 << 20) + 1 }], []))
  assert.throws(() => mergeAssetInventory([], [new Map([['/assets/TooLarge-aBc_1234.js', Buffer.alloc((8 << 20) + 1)]])]))
  const small = Array.from({ length: 1001 }, (_, index) => ({ ...entries(1)[0], path: `/assets/Chunk${index}-aBc_1234.js`, bytes: 1 }))
  assert.throws(() => mergeAssetInventory(small, []), /retention budget/)
})

const steps = ['verifyCandidate', 'routeCandidate', 'verifyEntryCandidate', 'replaceCurrent', 'verifyCurrent', 'routeCurrent', 'verifyEntryCurrent', 'commit', 'cleanupCandidate']
function operationsFixture(failAt) {
  const events = [], operations = Object.fromEntries([...steps, 'rollback'].map(step => [step, async () => {
    events.push(step)
    if (step === failAt) throw new Error('fixture-step-failure')
  }]))
  return { events, operations }
}

test('hot switch keeps old current until the candidate has passed the actual entry proof', async () => {
  const { events, operations } = operationsFixture()
  await runHotSwitch(operations)
  assert.deepEqual(events, steps)
  assert(events.indexOf('verifyEntryCandidate') < events.indexOf('replaceCurrent'))
  assert(events.indexOf('verifyEntryCurrent') < events.indexOf('commit'))
  assert(events.indexOf('commit') < events.indexOf('cleanupCandidate'))
})

test('failed direct candidate proof never moves traffic or stops the old serving app', async () => {
  const { events, operations } = operationsFixture('verifyCandidate')
  await assert.rejects(runHotSwitch(operations), /fixture-step-failure/)
  assert.deepEqual(events, ['verifyCandidate'])
})

for (const failedStep of ['routeCandidate', 'verifyEntryCandidate', 'replaceCurrent', 'verifyCurrent', 'routeCurrent', 'verifyEntryCurrent', 'commit']) {
  test(`failure at ${failedStep} rolls back once and never cleans the serving candidate`, async () => {
    const { events, operations } = operationsFixture(failedStep)
    await assert.rejects(runHotSwitch(operations), /fixture-step-failure/)
    assert.deepEqual(events, [...steps.slice(0, steps.indexOf(failedStep) + 1), 'rollback'])
    assert.equal(events.filter(step => step === failedStep).length, 1)
    assert(!events.includes('cleanupCandidate'))
    if (['routeCandidate', 'verifyEntryCandidate'].includes(failedStep)) assert(!events.includes('replaceCurrent'))
  })
}

test('cleanup failure after durable promotion does not undo a verified new service', async () => {
  const { events, operations } = operationsFixture('cleanupCandidate')
  await assert.rejects(runHotSwitch(operations), /fixture-step-failure/)
  assert.deepEqual(events, steps)
  assert(!events.includes('rollback'))
})

function recoveryContainers(current = currentImage) {
  return { current: current ? { Image: current, Config: { Labels: { 'com.docker.compose.project': 'sub2api-current' } }, State: { Running: true, Health: { Status: 'healthy' } } } : null,
    candidate: { Image: nextImage, Config: { Labels: { 'com.docker.compose.project': identity.project } }, State: { Running: true, Health: { Status: 'healthy' } } } }
}

test('manual rollback authenticates through the passive serving candidate if canonical current was lost or stopped', () => {
  const state = { priorImage: currentImage, image: nextImage }
  const missing = recoveryContainers(null)
  assert.deepEqual(rollbackPlan(missing.current, missing.candidate, state, identity), { replacementStarted: true, needCandidate: false, authFromCandidate: true })
  const stopped = recoveryContainers(nextImage); stopped.current.State.Running = false
  assert.deepEqual(rollbackPlan(stopped.current, stopped.candidate, state, identity), { replacementStarted: true, needCandidate: false, authFromCandidate: true })
  const unhealthy = recoveryContainers(currentImage); unhealthy.current.State.Health.Status = 'unhealthy'
  assert.equal(rollbackPlan(unhealthy.current, unhealthy.candidate, state, identity).authFromCandidate, true)
  const prior = recoveryContainers()
  assert.deepEqual(rollbackPlan(prior.current, prior.candidate, state, identity), { replacementStarted: false, needCandidate: false, authFromCandidate: false })
})

test('rollback reconstructs a missing passive candidate but refuses unrelated current/candidate owners', () => {
  const state = { priorImage: currentImage, image: nextImage }, fixture = recoveryContainers(nextImage)
  assert.deepEqual(rollbackPlan(fixture.current, null, state, identity), { replacementStarted: true, needCandidate: true, authFromCandidate: false })
  assert.deepEqual(rollbackPlan(null, null, state, identity), { replacementStarted: true, needCandidate: true, authFromCandidate: true })
  assert.throws(() => rollbackPlan({ ...fixture.current, Image: 'another-image' }, fixture.candidate, state, identity))
  const unrelated = structuredClone(fixture.candidate); unrelated.Config.Labels['com.docker.compose.project'] = 'other-project'
  assert.throws(() => rollbackPlan(fixture.current, unrelated, state, identity))
})

test('public upgrade output strips private nested keys, responses, exception details and credential structures', () => {
  const hidden = 'fixture-DO-NOT-PRINT'
  const report = publicSummary({ phase: 'active-verified', commit, image: nextImage, privateEnvironment: hidden,
    quota: { accountsChecked: 6, errors: 1, privateError: hidden, unknownAccounts: { token: hidden } },
    candidateProbe: { completed: true, httpStatus: 200, authorization: hidden, model: { key: hidden }, response: hidden, eventTypes: ['response.completed', hidden] },
    candidateCleanup: { ok: false, error: hidden } })
  assert(!JSON.stringify(report).includes(hidden))
  assert.deepEqual(report.quota, { accountsChecked: 6, errors: 1 })
  assert.deepEqual(report.candidateProbe, { completed: true, httpStatus: 200, eventTypes: ['response.completed'] })
  assert.deepEqual(report.candidateCleanup, { ok: false })
  assert.equal(report.oldImageRetained, true)
  assert.equal(report.databaseRestored, false)
  assert.equal(report.tailscaleServeChanged, false)
})

test('local upgrade does not restore live stores, rewrite Serve, prune images or clean a routed candidate', async () => {
  const source = await readFile(new URL('./upgrade-current.mjs', import.meta.url), 'utf8')
  assert(!source.includes('84a75caf'))
  assert(!source.includes("'image', 'rm'"))
  assert(!source.includes("'prune'"))
  assert(!source.includes("'tailscale'"))
  assert(!source.includes("'--clean'"))
  assert(source.includes("'pg_restore', '--list'"))
  const cleanup = source.slice(source.indexOf('async function cleanupCandidate'), source.indexOf('async function prepare'))
  assert(cleanup.indexOf('routing(`${names.app}:8080`)') < cleanup.indexOf("docker(['stop'"))
  assert(cleanup.includes('Candidate volume is still used by a container'))
  assert(source.includes("'--network=none', '--read-only'"))
  const restoration = source.slice(source.indexOf('async function restorePrevious'), source.indexOf('async function activate'))
  assert(restoration.indexOf('state.rollbackCandidateProbe = await liveGateway(publicBase') < restoration.indexOf("docker(['stop'"))
})
