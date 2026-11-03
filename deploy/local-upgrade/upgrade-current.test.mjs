import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  applyRecoveryResult, assertActivePin, assertAppearanceMatch, assertFreshBackup, assertPrepareRetry, assertRestoreReport, assertSnapshotPins, candidateCompose, mergeAssetInventory,
  postgresDumpListToc, promotedCompose, promotedState, publicSummary, quotaResponseSummary, releaseIdentity,
  rollbackPlan, runHotSwitch, runPriorImageRestore, selectQuotaAccountIDs, validateTerraUsage
} from './upgrade-current.mjs'
import { desiredCompose, names, routing } from './service-recovery.mjs'
import { assertLivePostgresCoverage, backupArchiveNames, backupArchiveSpecs, protectedBackupFileNames } from './backup-manifest.mjs'
import { firstUpgradeMode, sameVersionMode } from './rehearse-private-validation.mjs'
import { parsePostgresDumpListing } from './pg-dump-toc.mjs'

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
    Config: { Labels: { 'com.docker.compose.project': 'sub2api-current', 'org.opencontainers.image.version': '0.2.19' },
      Env: Object.entries(config.services.app.environment).map(([key, value]) => `${key}=${value}`) } }
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
  assert.equal(identity.version, '0.2.13')
  assert.equal(identity.candidateName, 'sub2api-upgrade-candidate-0123456789ab')
  assert.equal(identity.candidateVolume, 'sub2api-upgrade-0123456789ab_candidate-data')
  assert.match(identity.directory, /upgrade-0\.2\.13-0123456789ab$/)
  assert.equal(identity.candidateBase, 'http://127.0.0.1:18585')
  for (const replacement of [{ version: '0.2.14' }, { platform: 'linux/amd64' }, { imageId: 'latest' }, { commit: 'short' }]) {
    assert.throws(() => releaseIdentity(manifestPath, { ...manifest, ...replacement }, repositoryRoot))
  }
  assert.throws(() => releaseIdentity('/tmp/manifest.json', manifest, repositoryRoot))
})

test('fixed v0.2.19 target identity is accepted without widening the allowlist', () => {
  const targetCommit = 'fedcba987654' + 'd'.repeat(28)
  const targetManifest = { ...manifest, version: '0.2.19', commit: targetCommit }
  const targetPath = join(repositoryRoot, 'release', `sub2api_0.2.19_linux_arm64_${targetCommit.slice(0, 12)}`, 'manifest.json')
  const target = releaseIdentity(targetPath, targetManifest, repositoryRoot)
  assert.equal(target.version, '0.2.19')
  assert.equal(target.candidateName, 'sub2api-upgrade-candidate-fedcba987654')
  assert.match(target.directory, /upgrade-0\.2\.19-fedcba987654$/)
  assert.throws(() => releaseIdentity(targetPath, { ...targetManifest, version: '0.2.20' }, repositoryRoot))
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
  assert.equal(candidate.services.app.environment.GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT, 'true')
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
  assert.equal(next.services.app.environment.GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT, 'false')
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

test('theme equality accepts differently ordered public/admin JSON objects but rejects actual value changes', () => {
  const current = { skin: 'neubrutalism', mode: 'light', accent_color: '#d7ff00' }
  const admin = { accent_color: '#d7ff00', mode: 'light', skin: 'neubrutalism' }
  assert.doesNotThrow(() => assertAppearanceMatch(current, admin, { mode: 'light', skin: 'neubrutalism', accent_color: '#d7ff00' }))
  assert.throws(() => assertAppearanceMatch(current, { ...admin, accent_color: '#ff0000' }), /themes disagree/)
  assert.throws(() => assertAppearanceMatch(current, admin, { ...current, mode: 'dark' }), /changed during upgrade/)
  assert.throws(() => assertAppearanceMatch(current, { ...admin, unexpected: true }), /themes disagree/)
})

test('failed prepare can resume only its exact immutable release, live current and unchanged protected snapshots/routing', () => {
  const active = activeFixture(), release = { identity, manifestSha256: 'c'.repeat(64) }
  const state = { ...identity, phase: 'prepare-failed', manifestSha256: release.manifestSha256, priorImage: currentImage,
    priorContainerId: active.container.Id, priorComposeSha256: 'd'.repeat(64), priorStateSha256: 'e'.repeat(64) }
  const pins = { composeSha256: state.priorComposeSha256, stateSha256: state.priorStateSha256, route: routing(`${names.app}:8080`) }
  assert.doesNotThrow(() => assertPrepareRetry(state, release, active, pins))
  for (const changed of [{ phase: 'prepared' }, { phase: 'active-verified' }, { commit: 'f'.repeat(40) }, { image: currentImage },
    { manifestPath: '/tmp/other-manifest.json' }, { manifestSha256: 'f'.repeat(64) }, { directory: '/tmp/other-directory' },
    { priorImage: nextImage }, { priorContainerId: 'other-container' }, { priorComposeSha256: 'f'.repeat(64) }, { priorStateSha256: 'f'.repeat(64) }]) {
    assert.throws(() => assertPrepareRetry({ ...state, ...changed }, release, active, pins))
  }
  assert.throws(() => assertPrepareRetry(state, release, active, { ...pins, route: routing(`${identity.candidateName}:8080`) }))
})

function backupFixture(now) {
  const { container, state } = activeFixture()
  const dependencies = state.dependencies.map(item => ({ Image: item.image }))
  const appMount = { type: 'volume', name: 'sub2api-current_current-data', source: '/var/lib/docker/volumes/sub2api-current_current-data/_data', destination: '/app/data', rw: true }
  const pgMount = { type: 'volume', name: 'sub2api_postgres-data', source: '/var/lib/docker/volumes/sub2api_postgres-data/_data', destination: '/var/lib/postgresql/data', rw: true }
  const pgParent = { type: 'volume', name: 'anonymous-pg-parent', source: '/var/lib/docker/volumes/anonymous-pg-parent/_data', destination: '/var/lib/postgresql', rw: true }
  const redisMount = { type: 'volume', name: 'sub2api_redis-data', source: '/var/lib/docker/volumes/sub2api_redis-data/_data', destination: '/data', rw: true }
  const protectedFiles = protectedBackupFileNames.map(name => ({ name,
    source: name === '.env' ? '/Users/clawbotbot/Projects/sub2api-local/.env' : `/Users/clawbotbot/Projects/sub2api-local/current-0.2.13/${name}`,
    bytes: 256, sha256: 'b'.repeat(64), sourceMode: '0600', sourceUid: 501 }))
  return { container, dependencies, record: {
    started: new Date(now - 60_000).toISOString(), finished: new Date(now - 30_000).toISOString(),
    oldContainerId: container.Id, oldImageId: container.Image, databaseImageId: dependencies[0].Image, redisImageId: dependencies[1].Image,
    archives: backupArchiveNames.map(name => ({ name, bytes: backupArchiveSpecs[name].maxBytes, sha256: 'a'.repeat(64) })),
    protectedFiles,
    volumeCoverage: [
      { role: 'application', container: 'sub2api-current-app', mount: appMount, artifact: 'app-data.tar.gz', method: backupArchiveSpecs['app-data.tar.gz'].method },
      { role: 'postgresql', container: 'sub2api-postgres', mount: pgMount, artifact: 'postgres.dump', method: backupArchiveSpecs['postgres.dump'].method,
        database: 'sub2api', serverVersion: '18.6', actualDataDirectory: '/var/lib/postgresql/data', migrationsCount: 299, supportMounts: [pgParent] },
      { role: 'redis', container: 'sub2api-redis', mount: redisMount, artifact: 'redis.rdb', method: backupArchiveSpecs['redis.rdb'].method }
    ],
    postgres: { database: 'sub2api', serverVersion: '18.6', dataDirectory: '/var/lib/postgresql/data', migrationsCount: 299,
      dumpToc: { database: 'sub2api', format: 'CUSTOM', schemaMigrations: true, tocEntries: 12 } }
  } }
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

test('backup manifest requires original protected files and actual PGDATA volume coverage', () => {
  const now = Date.parse('2026-10-08T01:00:00Z'), fixture = backupFixture(now)
  const variants = [
    record => { record.protectedFiles[0].sourceMode = '0644' },
    record => { record.protectedFiles.pop() },
    record => { record.volumeCoverage.find(item => item.role === 'postgresql').actualDataDirectory = '/var/lib/postgresql' },
    record => { record.volumeCoverage.find(item => item.role === 'postgresql').database = 'other' },
    record => { record.postgres.dumpToc.database = 'other' },
    record => { record.postgres.dumpToc.schemaMigrations = false }
  ]
  for (const mutate of variants) {
    const record = structuredClone(fixture.record); mutate(record)
    assert.throws(() => assertFreshBackup(record, fixture.container, fixture.dependencies, now))
  }
})

test('live PostgreSQL backup coverage must match the actual data directory and longest volume mount', () => {
  const now = Date.parse('2026-10-08T01:00:00Z'), fixture = backupFixture(now)
  const pg = fixture.record.volumeCoverage.find(item => item.role === 'postgresql')
  const live = { database: pg.database, dataDirectory: pg.actualDataDirectory, serverVersion: pg.serverVersion, migrationsCount: pg.migrationsCount }
  const mounts = [
    { Type: 'volume', Name: 'anonymous-pg-parent', Destination: '/var/lib/postgresql' },
    { Type: 'volume', Name: pg.mount.name, Destination: pg.mount.destination }
  ]
  assert.doesNotThrow(() => assertLivePostgresCoverage(fixture.record, live, mounts))
  assert.throws(() => assertLivePostgresCoverage(fixture.record, { ...live, dataDirectory: '/var/lib/postgresql' }, mounts), /data directory changed/)
  assert.throws(() => assertLivePostgresCoverage(fixture.record, live, [mounts[0]]), /differs from the backup record/)
  assert.throws(() => assertLivePostgresCoverage(fixture.record, live, [{ ...mounts[1], Name: 'other-volume' }]), /differs from the backup record/)
})

function restoreReportFixture(now, fixture, candidateManifest = manifest) {
  const reportPath = '/Users/clawbotbot/Projects/sub2api-upgrade-private/rehearsal-AbC123/rehearsal-report.json'
  const backup = '/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-AbC123'
  const sourceTrees = { backend: '1'.repeat(40), frontend: '2'.repeat(40), migrations: '3'.repeat(40) }
  const toolFiles = Object.fromEntries([
    'deploy/local-upgrade/upgrade-current.mjs', 'deploy/local-upgrade/rehearse-private.mjs',
    'deploy/local-upgrade/rehearse-private-validation.mjs', 'deploy/local-upgrade/backup-private.mjs',
    'deploy/local-upgrade/backup-manifest.mjs', 'deploy/local-upgrade/pg-dump-toc.mjs',
    'deploy/local-upgrade/service-recovery.mjs', 'deploy/local-upgrade/live-gateway.mjs',
    'deploy/local-upgrade/compatibility-inventory.sql'
  ].map(path => [path, 'd'.repeat(64)]))
  const report = {
    passed: true, cleanupSucceeded: true, scriptCompleted: true, cleanupErrors: [],
    productionDeploymentPerformed: false, realGatewayCallsTested: false,
    backup, directory: dirname(reportPath), backupManifestSha256: 'a'.repeat(64), candidateManifestSha256: 'b'.repeat(64),
    candidateManifestHash: 'b'.repeat(64), imageSourceCommit: candidateManifest.commit,
    opsToolSha: 'e'.repeat(40), toolWorktreeClean: true, toolFiles, imageSourceTrees: sourceTrees, opsToolTrees: { ...sourceTrees },
    applicationTreesMatchImageSource: true,
    oldContainerId: fixture.container.Id, oldImageId: fixture.container.Image,
    candidateCommit: candidateManifest.commit, candidateImageId: candidateManifest.imageId, candidateVersion: candidateManifest.version,
    migrationMode: sameVersionMode,
    isolation: { networkInternal: true, separateImplementationVolumes: true, noHostPublishedPorts: true,
      noProviderBackgroundJobs: true, helperNetworkNone: true, productionDependenciesReferenced: false },
    compatibility: { oldImageReadWrite: true, candidateImageReadWrite: true, restartStable: true },
    migrations: { beforeCount: 299, afterCount: 299, newCount: 0, alreadyMigrated: true, expectedNewCount: 0, restartStable: true },
    sameVersion: { migrationsStable: true, businessStable: true, configurationStable: true, restartStable: true },
    completedAt: new Date(now - 20_000).toISOString()
  }
  return { reportPath, backup, report }
}

test('isolated restore report must match exact backup, manifests, image/commit, isolation and cleanup', () => {
  const now = Date.parse('2026-10-08T01:00:00Z'), fixture = backupFixture(now), targetManifest = { ...manifest, version: '0.2.19' }
  const reportFixture = restoreReportFixture(now, fixture, targetManifest)
  const args = [reportFixture.report, reportFixture.reportPath, reportFixture.backup, targetManifest, 'b'.repeat(64), fixture.container, fixture.record, 'a'.repeat(64)]
  assert.doesNotThrow(() => assertRestoreReport(...args))
  const firstUpgrade = structuredClone(reportFixture.report)
  firstUpgrade.migrationMode = firstUpgradeMode
  firstUpgrade.migrations = { ...firstUpgrade.migrations, newCount: 8, alreadyMigrated: false, expectedNewCount: 8 }
  delete firstUpgrade.sameVersion
  const oldContainer = { ...fixture.container, Config: { ...fixture.container.Config, Labels: { ...fixture.container.Config.Labels, 'org.opencontainers.image.version': '0.2.13' } } }
  assert.doesNotThrow(() => assertRestoreReport(firstUpgrade, reportFixture.reportPath, reportFixture.backup, targetManifest, 'b'.repeat(64), oldContainer, fixture.record, 'a'.repeat(64)))
  const variants = [
    report => { report.passed = false },
    report => { report.cleanupSucceeded = false },
    report => { report.scriptCompleted = false },
    report => { report.cleanupErrors = ['not-cleaned'] },
    report => { report.backup = '/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-OTHER' },
    report => { report.directory = '/Users/clawbotbot/Projects/sub2api-upgrade-private/rehearsal-OTHER' },
    report => { report.backupManifestSha256 = 'f'.repeat(64) },
    report => { report.candidateManifestSha256 = 'f'.repeat(64) },
    report => { report.oldContainerId = 'other-container' },
    report => { report.oldImageId = nextImage },
    report => { report.candidateCommit = 'f'.repeat(40) },
    report => { report.candidateImageId = currentImage },
    report => { report.candidateVersion = '0.2.20' },
    report => { report.candidateManifestHash = 'f'.repeat(64) },
    report => { report.imageSourceCommit = 'f'.repeat(40) },
    report => { report.opsToolSha = 'short' },
    report => { report.toolWorktreeClean = false },
    report => { report.applicationTreesMatchImageSource = false },
    report => { report.opsToolTrees.backend = 'f'.repeat(40) },
    report => { delete report.toolFiles['deploy/local-upgrade/rehearse-private.mjs'] },
    report => { report.toolFiles['../escape.mjs'] = 'f'.repeat(64) },
    report => { report.migrationMode = firstUpgradeMode },
    report => { report.isolation.networkInternal = false },
    report => { report.isolation.helperNetworkNone = false },
    report => { report.compatibility.restartStable = false },
    report => { report.migrations.afterCount = 300 },
    report => { report.sameVersion.configurationStable = false },
    report => { report.completedAt = new Date(now - 40_000).toISOString() }
  ]
  for (const mutate of variants) {
    const report = structuredClone(reportFixture.report); mutate(report)
    assert.throws(() => assertRestoreReport(report, ...args.slice(1)))
  }
})

const priorOperationalSteps = ['stopCurrentReplacement', 'installPriorConfiguration', 'startPriorImage', 'waitPriorHealthy',
  'verifyPriorIdentity', 'persistPriorState', 'routePrior', 'checkpointRouteRestored', 'waitPriorEntryHealthy',
  'authenticatePriorDirect', 'verifyPriorDirect', 'probePriorDirect', 'verifyPriorEntry', 'probePriorEntry', 'verifyCompatibility']
function priorRestoreOperations(failAt) {
  const events = [], finalizations = [], verificationFailures = []
  const operations = Object.fromEntries(priorOperationalSteps.map(step => [step, async () => {
    events.push(step)
    if (step === failAt) throw new Error('fixture-prior-step-failure')
  }]))
  operations.recordVerificationFailure = async error => {
    events.push('recordVerificationFailure')
    verificationFailures.push(error.message)
    return 'Operation failed; private details suppressed'
  }
  operations.finalizePriorState = async result => {
    events.push('finalizePriorState')
    finalizations.push(result)
  }
  return { events, operations, finalizations, verificationFailures }
}

test('candidate-independent emergency restore persists prior state and route before any auth or inference probe', async () => {
  const { events, operations, finalizations } = priorRestoreOperations()
  const result = await runPriorImageRestore(operations, true)
  assert.deepEqual(result, { verified: true, verificationErrors: [] })
  assert.deepEqual(events, [...priorOperationalSteps, 'finalizePriorState'])
  assert.deepEqual(finalizations, [{ verified: true }])
  assert(events.indexOf('stopCurrentReplacement') < events.indexOf('installPriorConfiguration'))
  assert(events.indexOf('verifyPriorIdentity') < events.indexOf('persistPriorState'))
  assert(events.indexOf('persistPriorState') < events.indexOf('routePrior'))
  assert(events.indexOf('routePrior') < events.indexOf('checkpointRouteRestored'))
  assert(events.indexOf('checkpointRouteRestored') < events.indexOf('authenticatePriorDirect'))
  assert(events.indexOf('checkpointRouteRestored') < events.indexOf('probePriorEntry'))
  assert(!runPriorImageRestore.toString().includes('identity.candidateName'))
})

test('emergency restore without replacement does not stop/start current and still persists then reroutes prior', async () => {
  const { events, operations } = priorRestoreOperations()
  await runPriorImageRestore(operations, false)
  assert.deepEqual(events, [...priorOperationalSteps.slice(3), 'finalizePriorState'])
})

for (const failAt of ['authenticatePriorDirect', 'probePriorDirect', 'probePriorEntry']) {
  test(`shared auth/upstream failure at ${failAt} cannot prevent prior state+route recovery or be reported verified`, async () => {
    const { events, operations, finalizations, verificationFailures } = priorRestoreOperations(failAt)
    const result = await runPriorImageRestore(operations, true)
    assert.equal(result.verified, false)
    assert.equal(verificationFailures.length, 1)
    assert.deepEqual(result.verificationErrors, ['Operation failed; private details suppressed'])
    assert.deepEqual(finalizations, [{ verified: false }])
    assert(events.indexOf('persistPriorState') < events.indexOf('routePrior'))
    assert(events.indexOf('routePrior') < events.indexOf('checkpointRouteRestored'))
    assert(events.indexOf('checkpointRouteRestored') < events.indexOf(failAt))
    assert(events.includes('recordVerificationFailure'))
    assert.equal(events.at(-1), 'finalizePriorState')
  })
}

test('manual rollback result merge preserves already-sanitized verification errors', () => {
  const state = { recoveryVerificationErrors: ['Operation failed; private details suppressed'] }
  applyRecoveryResult(state, { verified: false, error: new Error('private upstream details') })
  assert.equal(state.recoveryVerified, false)
  assert.deepEqual(state.recoveryVerificationErrors, ['Operation failed; private details suppressed'])
  const fresh = {}
  applyRecoveryResult(fresh, { verified: false, error: new Error('private auth details') })
  assert.deepEqual(fresh.recoveryVerificationErrors, ['Operation failed; private details suppressed'])
  applyRecoveryResult(fresh, { verified: true, verificationErrors: [] })
  assert.equal(fresh.recoveryVerified, true)
  assert.deepEqual(fresh.recoveryVerificationErrors, [])
})

test('local prior health/identity/state/route failures abort without a false verified result', async () => {
  for (const failAt of ['waitPriorHealthy', 'verifyPriorIdentity', 'persistPriorState', 'routePrior']) {
    const { events, operations, finalizations } = priorRestoreOperations(failAt)
    await assert.rejects(runPriorImageRestore(operations, true), /fixture-prior-step-failure/)
    assert.deepEqual(finalizations, [])
    assert(!events.includes('recordVerificationFailure'))
  }
})


const completeToc = `;
; Archive created at 2026-10-08 01:00:00
;     dbname: fixture
;     TOC Entries: 4
;     Format: CUSTOM
;
; Selected TOC Entries:
;
10; 1259 100 TABLE public schema_migrations fixture
11; 0 100 TABLE DATA public schema_migrations fixture
12; 1259 200 TABLE public accounts fixture
13; 0 200 TABLE DATA public accounts fixture
`
test('dump listing accepts only successful complete TOC output when stdin closes early with EPIPE', () => {
  const result = spawnSync(process.execPath, ['-e', `require('node:fs').writeSync(1, ${JSON.stringify(completeToc)}); process.exit(0)`], {
    input: Buffer.alloc(16 << 20), encoding: 'utf8', timeout: 5000, maxBuffer: (1 << 20)
  })
  assert.equal(result.status, 0)
  assert.equal(result.error?.code, 'EPIPE', 'The child must exit without consuming the oversized input pipe')
  assert.equal(postgresDumpListToc(result), completeToc.trim())
  assert.equal(postgresDumpListToc({ status: 0, stdout: completeToc }), completeToc.trim())
})

test('dump listing preserves non-UTF8 binary stdin and the real TOC trailing newline', () => {
  const binary = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x81, 0x7f, 0x0a, 0x00, 0xc3, 0x28])
  const script = `
    const { createHash } = require('node:crypto')
    const chunks = []
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => {
      const data = Buffer.concat(chunks)
      if (createHash('sha256').update(data).digest('hex') !== ${JSON.stringify(hash(binary))}) process.exit(2)
      process.stdout.write(${JSON.stringify(completeToc)})
    })
  `
  const result = spawnSync(process.execPath, ['-e', script], { input: binary, encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20 })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, completeToc)
  assert.deepEqual(parsePostgresDumpListing(result, 'fixture'), { database: 'fixture', tocEntries: 4, format: 'CUSTOM', schemaMigrations: true })
  assert.throws(() => parsePostgresDumpListing(result, 'other'), /differs from the live database/)
})

test('backup keeps PostgreSQL archive input binary and uses the bounded shared --list parser', async () => {
  const backupSource = await readFile(new URL('./backup-private.mjs', import.meta.url), 'utf8')
  const tocSource = await readFile(new URL('./pg-dump-toc.mjs', import.meta.url), 'utf8')
  assert(backupSource.includes("input: dump, encoding: 'utf8'"))
  assert(backupSource.includes("'pg_restore', '--list'"))
  assert(backupSource.includes('parsePostgresDumpListing'))
  assert(!backupSource.includes("dumpBytes.toString('utf8')"))
  assert(tocSource.includes("result.error.code === 'EPIPE'"))
  assert(tocSource.includes("result.status === 0 && !result.signal"))
  assert(!tocSource.includes("'pg_restore', '--list'"))
})

test('dump-list EPIPE never masks failure, signal, other spawn errors or truncated/non-TOC stdout', () => {
  const error = code => Object.assign(new Error('fixture-private-details'), { code })
  for (const changes of [
    { status: 1, error: error('EPIPE') }, { status: null, error: error('EPIPE') }, { signal: 'SIGTERM', error: error('EPIPE') },
    ...['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EINTR'].map(code => ({ error: error(code) })),
    { stdout: completeToc.slice(0, -1) }, { stdout: 'schema_migrations TABLE\n' },
    { stdout: completeToc.replace('Selected TOC Entries:', 'incomplete directory') },
    { stdout: completeToc + 'truncated-entry\n' }, { stdout: completeToc.replaceAll('schema_migrations', 'other_table') }
  ]) assert.throws(() => postgresDumpListToc({ status: 0, error: error('EPIPE'), stdout: completeToc, ...changes }))
})

const quotaWindow = (now, changes = {}) => ({ key: 'five_hour', utilization: 85, source: 'response_headers', scope: 'account', window_minutes: 300,
  sampled_at: new Date(now - 60_000).toISOString(), resets_at: new Date(now + 60_000).toISOString(), ...changes })

test('Terra billing requires completed-request model identity and positive token billing', () => {
  const row = { request_id: 'resp_terra', model: 'gpt-6.1-terra', upstream_model: 'gpt-6.1-terra', upstream_response_model: 'gpt-6.1-terra', upstream_model_mismatch: false, input_tokens: 24, output_tokens: 5, total_cost: 0.001, actual_cost: 0.001, billing_mode: 'token' }
  assert.deepEqual(validateTerraUsage([row], 'resp_terra'), { requestId: 'resp_terra', model: 'gpt-6.1-terra', upstreamModel: 'gpt-6.1-terra', upstreamResponseModel: 'gpt-6.1-terra', inputTokens: 24, outputTokens: 5, totalCost: 0.001, actualCost: 0.001, billingMode: 'token', upstreamModelMismatch: false })
  assert.throws(() => validateTerraUsage([], 'resp_terra'), /not persisted/)
  assert.throws(() => validateTerraUsage([{ ...row, model: 'gpt-6.1-sol' }], 'resp_terra'), /identity changed/)
  assert.throws(() => validateTerraUsage([{ ...row, upstream_response_model: 'gpt-6.1-sol' }], 'resp_terra'), /response identity changed/)
  assert.throws(() => validateTerraUsage([{ ...row, total_cost: 0 }], 'resp_terra'), /not positive/)
  assert.throws(() => validateTerraUsage([{ ...row, input_tokens: 0, output_tokens: 0 }], 'resp_terra'), /token usage/)
})

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

const factoryQuotaWindows = (now, changes = {}) => ['standard', 'core'].flatMap(scope => ['five_hour', 'weekly', 'monthly'].map(period => ({
  key: `factory_${scope}_${period}`, scope, source: 'upstream', utilization: scope === 'standard' ? 100 : 2.5,
  sampled_at: new Date(now - 60_000).toISOString(), resets_at: new Date(now + 3600_000).toISOString(), ...changes
})))

test('release quota sampling reserves Factory slots and includes current account 13', () => {
  const list = [...Array.from({ length: 10 }, (_, n) => ({ id: n + 20, platform: 'openai', type: 'oauth' })),
    ...[50, 51, 13].map(id => ({ id, platform: 'factory', type: 'apikey' }))]
  assert.deepEqual(selectQuotaAccountIDs(list), [20, 21, 22, 23, 24, 25, 13, 50])
  assert.deepEqual(selectQuotaAccountIDs([{ id: 13, platform: 'factory', type: 'apikey' }]), [13])
})

test('Factory six-window observations accept zero, percent over 100 and explicit unknown without inventing totals', () => {
  const now = Date.parse('2026-11-03T01:00:00Z')
  const windows = factoryQuotaWindows(now)
  windows[0].utilization = 0
  windows[1].utilization = 130
  windows[2].utilization = null
  const summary = quotaResponseSummary({ usage: { 13: { quota_windows: windows, factory_usage: { stale: false } } }, errors: {} }, [13], now)
  assert.deepEqual(summary, { accountsChecked: 1, quotaWindows: 6, errors: 0, unknownAccounts: 0, staleAccounts: 0 })
  const unknown = quotaResponseSummary({ usage: { 13: { quota_windows: factoryQuotaWindows(now, { utilization: null, sampled_at: null, resets_at: null }), factory_usage: { stale: true } } }, errors: {} }, [13], now)
  assert.equal(unknown.unknownAccounts, 1)
  assert.equal(unknown.quotaWindows, 6)
  assert.equal(quotaResponseSummary({ usage: { 13: { factory_usage: { stale: true } } }, errors: {} }, [13], now).unknownAccounts, 1)
})

test('Factory freshness uses the five-minute boundary and explicit stale flag', () => {
  const now = Date.parse('2026-11-03T01:00:00Z')
  for (const usage of [
    { quota_windows: factoryQuotaWindows(now, { sampled_at: new Date(now - 5 * 60_000).toISOString() }), factory_usage: { stale: false } },
    { quota_windows: factoryQuotaWindows(now), factory_usage: { stale: true } }
  ]) assert.equal(quotaResponseSummary({ usage: { 13: usage }, errors: {} }, [13], now).staleAccounts, 1)
})

test('Factory validation rejects mismatched pool keys, unsupported scopes, wrong provenance and incomplete observations', () => {
  const now = Date.parse('2026-11-03T01:00:00Z')
  for (const change of [{ key: 'factory_core_five_hour' }, { key: 'five_hour' }, { key: 'factory_standard_daily' }, { scope: 'account' }, { scope: 'other' }, { source: 'response_headers' }]) {
    const windows = factoryQuotaWindows(now)
    windows[0] = { ...windows[0], ...change }
    assert.throws(() => quotaResponseSummary({ usage: { 13: { quota_windows: windows } }, errors: {} }, [13], now))
  }
  for (const windows of [factoryQuotaWindows(now).slice(0, 5), [...factoryQuotaWindows(now), factoryQuotaWindows(now)[0]]]) {
    assert.throws(() => quotaResponseSummary({ usage: { 13: { quota_windows: windows } }, errors: {} }, [13], now))
  }
  assert.throws(() => quotaResponseSummary({ usage: { 13: { factory_usage: { stale: 'false' } } }, errors: {} }, [13], now))
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
})

test('retained builds may cross the per-build file count but the aggregate cap stays bounded', () => {
  const previous = Array.from({ length: 1499 }, (_, index) => ({ path: `/assets/Chunk${index}-aBc_1234.js`, sha256: 'a'.repeat(64), bytes: 1 }))
  const next = new Map([['/assets/Next-aBc_1234.js', Buffer.from('x')]])
  const merged = mergeAssetInventory(previous, [next])
  assert.equal(merged.assets.length, 1500)
  assert.equal(merged.additions.length, 1)
  next.set('/assets/Extra-aBc_1234.js', Buffer.from('y'))
  assert.throws(() => mergeAssetInventory(previous, [next]), /retention budget/)
  assert.equal(previous.length, 1499)
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

test('rollback plan recovers prior image without candidate auth/health/Responses dependency', () => {
  const state = { priorImage: currentImage, image: nextImage }
  const missing = recoveryContainers(null)
  assert.deepEqual(rollbackPlan(missing.current, missing.candidate, state, identity), { replacementStarted: true, candidatePresent: true, candidateDependent: false })
  const stopped = recoveryContainers(nextImage); stopped.current.State.Running = false
  assert.deepEqual(rollbackPlan(stopped.current, stopped.candidate, state, identity), { replacementStarted: true, candidatePresent: true, candidateDependent: false })
  const unhealthy = recoveryContainers(currentImage); unhealthy.current.State.Health.Status = 'unhealthy'
  assert.deepEqual(rollbackPlan(unhealthy.current, unhealthy.candidate, state, identity), { replacementStarted: true, candidatePresent: true, candidateDependent: false })
  const prior = recoveryContainers()
  assert.deepEqual(rollbackPlan(prior.current, prior.candidate, state, identity), { replacementStarted: false, candidatePresent: true, candidateDependent: false })
  assert.deepEqual(rollbackPlan(prior.current, null, state, identity), { replacementStarted: false, candidatePresent: false, candidateDependent: false })
})

test('rollback refuses unrelated current/candidate owners but can reconstruct prior without a candidate', () => {
  const state = { priorImage: currentImage, image: nextImage }, fixture = recoveryContainers(nextImage)
  assert.deepEqual(rollbackPlan(null, null, state, identity), { replacementStarted: true, candidatePresent: false, candidateDependent: false })
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
  const rehearsalSource = await readFile(new URL('./rehearse-private.mjs', import.meta.url), 'utf8')
  assert(!source.includes('84a75caf'))
  assert(!source.includes("'image', 'rm'"))
  assert(!source.includes("'prune'"))
  assert(!source.includes("'tailscale'"))
  assert(!source.includes("'--clean'"))
  assert(source.includes("'pg_restore', '--list'"))
  assert(source.includes('check(!result.error && result.status === 0, `Docker'))
  const cleanup = source.slice(source.indexOf('async function cleanupCandidate'), source.indexOf('async function prepare'))
  assert(cleanup.indexOf('routing(`${names.app}:8080`)') < cleanup.indexOf("docker(['stop'"))
  assert(cleanup.includes('Candidate volume is still used by a container'))
  assert(source.includes("'--network=none', '--read-only'"))
  const candidateIndependent = source.slice(source.indexOf('export async function runPriorImageRestore'), source.indexOf('async function restorePrevious'))
  assert(!candidateIndependent.includes('verifyShared'))
  assert(!candidateIndependent.includes('liveGateway'))
  assert(!candidateIndependent.includes('identity.candidateName'))
  const restoration = source.slice(source.indexOf('async function restorePrevious'), source.indexOf('async function activate'))
  assert(restoration.indexOf('stopCurrentReplacement') < restoration.indexOf('installPriorConfiguration'))
  assert(restoration.indexOf('persistPriorState') < restoration.indexOf('routePrior'))
  assert(restoration.indexOf('routePrior') < restoration.indexOf('checkpointRouteRestored'))
  assert(restoration.indexOf('checkpointRouteRestored') < restoration.indexOf('authenticatePriorDirect'))
  assert(restoration.includes("verified ? 'rolled-back-verified' : 'rolled-back-route-restored-unverified'"))
  assert(!restoration.includes('pg_restore'))
  assert(!restoration.includes('state.rollbackCandidateProbe'))
  assert(source.includes('Restore report ops tool file changed'))
  assert(rehearsalSource.includes('const imageBillingBefore = sameVersion ? imageBillingRows() : null'))
  assert(rehearsalSource.includes('const scopedAdminKeysBefore = sameVersion ? scopedAdminKeyRows() : null'))
  assert(rehearsalSource.includes("assert.equal(scopedAdminKeyRows(), 0, 'Rehearsal unexpectedly contains administrator API keys')"))
})
