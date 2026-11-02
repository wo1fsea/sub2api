import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir, mkdtemp, writeFile, stat } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertMigrationRowsMatchSource, sameVersionMode, selectRehearsalMode, validateMigrationTransition,
  validateSameVersionPreserved } from './rehearse-private-validation.mjs'
import { assertProtectedFileMetadata, assertVolumeCoverage, protectedBackupFileNames } from './backup-manifest.mjs'

process.umask(0o077)
const backup = resolve(process.argv[2] || '')
assert(/^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/.test(backup), 'Pass the exact private backup directory')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
assert(process.argv[3], 'Pass the exact candidate manifest path as the second argument')
const candidatePath = resolve(process.argv[3])
const candidateBytes = await readFile(candidatePath)
const candidate = JSON.parse(candidateBytes)
const candidateManifestSha256 = createHash('sha256').update(candidateBytes).digest('hex')
assert.match(candidate.imageId, /^sha256:[a-f0-9]{64}$/)
assert.equal(candidate.platform, 'linux/arm64')
assert.equal(candidate.version, '0.2.19', 'Rehearsal candidate must be v0.2.19')
const backupManifestBytes = await readFile(join(backup, 'backup-manifest.json'))
const backupManifest = JSON.parse(backupManifestBytes)
const backupManifestSha256 = createHash('sha256').update(backupManifestBytes).digest('hex')
const oldVersion = backupManifest.oldVersion || '0.2.4'
const selection = selectRehearsalMode(oldVersion, candidate.version)
const sameVersion = selection.mode === sameVersionMode
const expectedMigrationNames = selection.expectedMigrationNames
const expectedNewMigrations = selection.expectedNewMigrations
const sourceMigrationChecksums = new Map()
for (const name of (await readdir(join(root, 'backend/migrations'))).filter(name => name.endsWith('.sql')).sort()) {
  const content = (await readFile(join(root, 'backend/migrations', name), 'utf8')).trim()
  sourceMigrationChecksums.set(name, createHash('sha256').update(content).digest('hex'))
}
assert(sourceMigrationChecksums.size > 0, 'Release source migration inventory is empty')
const expectedMigrationChecksums = new Map()
if (!sameVersion) {
  for (const name of expectedMigrationNames) {
    assert(sourceMigrationChecksums.has(name), `Expected migration is absent from release source: ${name}`)
    expectedMigrationChecksums.set(name, sourceMigrationChecksums.get(name))
  }
}
const inventory = await readFile(join(root, 'deploy/local-upgrade/compatibility-inventory.sql'), 'utf8')
const originals = JSON.parse(await readFile(join(backup, 'recovery-private.json'), 'utf8'))
assert.equal((await stat(backup)).mode & 0o777, 0o700)
assertProtectedFileMetadata(backupManifest.protectedFiles)
assertVolumeCoverage(backupManifest)
for (const name of protectedBackupFileNames) {
  const item = backupManifest.protectedFiles.find(file => file.name === name)
  assert(item, `Protected backup file is missing: ${name}`)
  const path = join(backup, name), info = await stat(path)
  assert.equal(info.mode & 0o777, 0o600, `Protected backup file mode changed: ${name}`)
  assert.equal(info.size, item.bytes, `Protected backup file size changed: ${name}`)
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), item.sha256, `Protected backup file checksum changed: ${name}`)
}
for (const item of backupManifest.archives) {
  assert(['postgres.dump', 'app-data.tar.gz', 'redis.rdb'].includes(item.name))
  const data = await readFile(join(backup, item.name))
  assert.equal(data.length, item.bytes)
  assert.equal(createHash('sha256').update(data).digest('hex'), item.sha256)
}
const directory = await mkdtemp(join(dirname(backup), 'rehearsal-'))
const project = `sub2api-rehearsal-${randomBytes(6).toString('hex')}`
const dbPassword = randomBytes(32).toString('hex')
const redisPassword = randomBytes(32).toString('hex')
const originalEnv = Object.fromEntries(originals[0].Config.Env.map(item => {
  const index = item.indexOf('=')
  return [item.slice(0, index), item.slice(index + 1)]
}))
const appEnv = {
  ...originalEnv, AUTO_SETUP: 'false', DATABASE_HOST: 'db', DATABASE_PORT: '5432', DATABASE_USER: 'rehearsal',
  DATABASE_DBNAME: 'rehearsal', DATABASE_PASSWORD: dbPassword, REDIS_HOST: 'redis',
  REDIS_PORT: '6379', REDIS_PASSWORD: redisPassword, SERVER_HOST: '0.0.0.0', SERVER_PORT: '8080',
  TOKEN_REFRESH_ENABLED: 'false', USAGE_CLEANUP_ENABLED: 'false', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1',
  LOG_OUTPUT_TO_FILE: 'false', LOG_LEVEL: 'error',
  DATABASE_MAX_OPEN_CONNS: '10', DATABASE_MAX_IDLE_CONNS: '2', REDIS_POOL_SIZE: '16', REDIS_MIN_IDLE_CONNS: '2',
  GOMAXPROCS: '2', GOMEMLIMIT: '384MiB'
}
const logging = { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } }
function app(image, volume) {
  return { image, pull_policy: 'never', cpus: 0.5, mem_limit: '512m', environment: appEnv,
    volumes: [`${volume}:/app/data`], logging,
    depends_on: { db: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } } }
}
const configuration = {
  services: {
    db: { image: backupManifest.databaseImageId, pull_policy: 'never', cpus: 0.5, mem_limit: '384m',
      environment: { POSTGRES_USER: 'rehearsal', POSTGRES_DB: 'rehearsal', POSTGRES_PASSWORD: dbPassword },
      volumes: ['db-data:/var/lib/postgresql'], logging,
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U rehearsal -d rehearsal'], interval: '2s', timeout: '2s', retries: 45 } },
    redis: { image: backupManifest.redisImageId, pull_policy: 'never', cpus: 0.25, mem_limit: '64m',
      environment: { REDISCLI_AUTH: redisPassword }, volumes: ['redis-data:/data'], logging,
      command: ['redis-server', '--requirepass', redisPassword, '--appendonly', 'no'],
      healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '2s', retries: 45 } },
    blue: app(backupManifest.oldImageId, 'blue-data'), green: {
      ...app(candidate.imageId, 'green-data'),
      environment: { ...appEnv, GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT: 'true' }
    }
  }, networks: { default: { internal: true } },
  volumes: { 'db-data': {}, 'redis-data': {}, 'blue-data': {}, 'green-data': {} }
}
const composePath = join(directory, 'compose-private.json')
await writeFile(composePath, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 })
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]
let failureIndex = 0
const helpers = new Set()
let helperNetworkNone = true
let helperCount = 0
function docker(args, input, timeout = 180_000) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 16 << 20 })
  if (result.error || result.status !== 0) {
    const path = join(directory, `docker-failure-${++failureIndex}.json`)
    // Docker errors can contain credentials; retain bounded diagnostics only in the private run.
    writeFileSync(path, JSON.stringify({ operation: args[0], status: result.status,
      signal: result.signal, code: result.error?.code,
      stderr: (result.stderr || '').slice(-16_384) }), { flag: 'wx', mode: 0o600 })
    throw new Error(`Rehearsal Docker ${args[0]} failed; inspect private diagnostic ${path}`)
  }
  return result.stdout.trim()
}
function restoreVolume(name, command) {
  const helper = `${project}-restore-${name.slice(project.length + 1)}`
  helpers.add(helper)
  const args = ['create', '--name', helper, '--network', 'none', '--entrypoint', 'sh',
    '--cpus', '0.25', '--memory', '128m', '--log-driver', 'none',
    '--label', `io.sub2api.rehearsal=${project}`, '--mount', `type=volume,source=${name},target=/restore`,
    '--mount', `type=bind,source=${backup},target=/backup,readonly`, candidate.imageId, '-ec', command]
  assert(args.includes('--network') && args[args.indexOf('--network') + 1] === 'none')
  helperCount++
  helperNetworkNone &&= args[args.indexOf('--network') + 1] === 'none'
  docker(args, undefined, 60_000)
  docker(['start', helper], undefined, 60_000)
  const exit = docker(['wait', helper])
  const [state] = JSON.parse(docker(['inspect', helper]))
  writeFileSync(join(directory, `${helper}-state.json`), JSON.stringify({ id: state.Id,
    name: state.Name, state: state.State }), { flag: 'wx', mode: 0o600 })
  assert.equal(state.Config.Labels['io.sub2api.rehearsal'], project)
  assert.equal(state.State.OOMKilled, false)
  assert.equal(exit, '0', 'Private restore helper failed')
  docker(['rm', helper])
  helpers.delete(helper)
}
function id(service) { return docker([...compose, 'ps', '--all', '--quiet', service]) }
function serviceEnvironment(service) {
  const [container] = JSON.parse(docker(['inspect', id(service)]))
  return { container, environment: Object.fromEntries(container.Config.Env.map(value => {
    const separator = value.indexOf('=')
    return [value.slice(0, separator), value.slice(separator + 1)]
  })) }
}
function sql(query) {
  return docker(['exec', '-i', id('db'), 'psql', '-X', '-U', 'rehearsal', '-d', 'rehearsal', '-At', '-v', 'ON_ERROR_STOP=1'], query)
}
function request(service, path, token, body) {
  const args = ['exec', id(service), 'wget', '-S', '-O', '-', '-T', '5']
  if (token) args.push('--header', `Authorization: Bearer ${token}`)
  if (body) args.push('--header', 'Content-Type: application/json', '--post-data', JSON.stringify(body))
  args.push(`http://127.0.0.1:8080${path}`)
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 << 20 })
  assert(!result.error, 'Rehearsal HTTP command timed out')
  const status = Number([...result.stderr.matchAll(/HTTP\/1\.1 (\d+)/g)].at(-1)?.[1])
  return { status, body: result.stdout }
}
async function putSettings(service, token, body) {
  // BusyBox wget cannot PUT. Keep the full isolated settings payload on stdin.
  const json = JSON.stringify(body)
  const wire = `PUT /api/v1/admin/settings HTTP/1.0\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`
  const child = spawn('docker', ['exec', '-i', id(service), 'nc', '-w', '5', '127.0.0.1', '8080'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let result = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000)
  try {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { result += chunk; if (result.length > 1 << 20) child.kill('SIGTERM') })
    child.stderr.resume()
    const complete = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Isolated PUT transport failed')))
    })
    // Keep stdin open until the server closes its response. Ending it early
    // makes BusyBox nc close the socket and cancels Go's request context.
    child.stdin.write(wire)
    await complete
  } finally { clearTimeout(timer); child.stdin.destroy(); if (child.exitCode === null) child.kill('SIGTERM') }
  const boundary = result.indexOf('\r\n\r\n')
  assert(boundary > 0, 'Missing isolated PUT response headers')
  return { status: Number(result.slice(0, boundary).match(/^HTTP\/1\.[01] (\d+)/)?.[1]), body: result.slice(boundary + 4) }
}
async function ready(service) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = request(service, '/health')
      if (response.status === 200 && JSON.parse(response.body).status === 'ok') return
    } catch { /* Startup may still be applying migrations. */ }
    await delay(1000)
  }
  throw new Error(`Rehearsal ${service} did not become ready`)
}
const baseTables = ['users', 'accounts', 'api_keys', 'groups', 'account_groups', 'channel_model_pricing',
  'channel_account_stats_model_pricing', 'user_platform_quotas', 'usage_logs']
const sameVersionTables = ['channels', 'channel_groups', 'composite_model_routes', 'settings', 'security_secrets',
  'scoped_admin_api_keys', 'subscription_plans', 'user_subscriptions']
const projections = {}
function tableNames(includeAllState) { return includeAllState ? [...new Set([...baseTables, ...sameVersionTables])] : baseTables }
function migrationRows() {
  return JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('filename',filename,'checksum',checksum) ORDER BY filename),'[]'::json) FROM schema_migrations;"))
}
function schemaFingerprint() {
  return JSON.parse(sql(`SELECT json_build_object('columns',count(*),'digest',md5(coalesce(string_agg(md5(table_name||'.'||column_name||'.'||data_type||'.'||is_nullable||'.'||coalesce(column_default,'')),'' ORDER BY table_name,column_name),''))) FROM information_schema.columns WHERE table_schema='public';`))
}
function imageGenerationGate() {
  return JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('id',id,'platform',platform,'allow_image_generation',allow_image_generation) ORDER BY id),'[]'::json) FROM groups;"))
}
function imageBillingRows() {
  return JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('id',id,'enabled',image_count_billing) ORDER BY id),'[]'::json) FROM groups;"))
}
function scopedAdminKeyRows() { return Number(sql('SELECT count(*) FROM scoped_admin_api_keys;')) }
function unlimitedQuotaRows() { return Number(sql('SELECT count(*) FROM user_platform_quotas WHERE daily_limit_usd IS NULL AND weekly_limit_usd IS NULL AND monthly_limit_usd IS NULL;')) }
function fingerprints(includeAllState = false) {
  const results = {}
  for (const table of tableNames(includeAllState)) {
    if (!projections[table]) {
      const columns = sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position;`).split('\n')
      assert(columns.length > 0 && columns.every(name => /^[a-z_][a-z0-9_]*$/.test(name)), `No valid projection for ${table}`)
      // Login intentionally updates user activity timestamps; all business fields remain compared.
      const excluded = table === 'users' ? ['last_login_at', 'last_active_at', 'updated_at'] : !includeAllState && table === 'groups' ? ['allow_image_generation', 'image_count_billing'] : []
      projections[table] = columns.filter(name => excluded.includes(name) === false).map(name => `"${name}"`).join(',')
    }
    const filter = !includeAllState && table === 'user_platform_quotas' ? ' WHERE daily_limit_usd IS NOT NULL OR weekly_limit_usd IS NOT NULL OR monthly_limit_usd IS NOT NULL' : ''
    results[table] = JSON.parse(sql(`SELECT json_build_object('rows',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),''))) FROM (SELECT ${projections[table]} FROM "${table}"${filter}) t;`))
  }
  return results
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const jsonSha256 = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
function appDataDigest(service) {
  const output = docker(['exec', id(service), 'sh', '-c', 'sha256sum /app/data/config.yaml /app/data/model_pricing.json /app/data/model_pricing.sha256 2>/dev/null || true'])
  return output.split('\n').filter(Boolean).sort()
}
function adminSettingsDigest(service, token) {
  const response = request(service, '/api/v1/admin/settings', token)
  assert.equal(response.status, 200, 'Rehearsal administrator settings read failed')
  return jsonSha256(JSON.parse(response.body).data)
}
function configurationSnapshot(service, token) {
  return { schema: schemaFingerprint(), appData: appDataDigest(service), adminSettingsSha256: adminSettingsDigest(service, token),
    imageGeneration: imageGenerationGate(), imageBilling: imageBillingRows(), scopedAdminKeyRows: scopedAdminKeyRows(),
    unlimitedQuotaRows: unlimitedQuotaRows() }
}
const report = { project, directory, backup, backupManifestSha256, candidateManifestPath: candidatePath, candidateManifestSha256,
  candidateCommit: candidate.commit, candidateImageId: candidate.imageId, candidateVersion: candidate.version,
  oldVersion, oldContainerId: backupManifest.oldContainerId, oldImageId: backupManifest.oldImageId,
  migrationMode: selection.mode, checks: [], productionDeploymentPerformed: false, realGatewayCallsTested: false,
  isolation: { networkInternal: false, separateImplementationVolumes: false, noHostPublishedPorts: false,
    noProviderBackgroundJobs: false, helperNetworkNone: false, productionDependenciesReferenced: true },
  compatibility: { oldImageReadWrite: false, candidateImageReadWrite: false, restartStable: false },
  migrations: {}, sameVersion: null, cleanupErrors: [], cleanupSucceeded: false, scriptCompleted: false, passed: false }
try {
  const [image] = JSON.parse(docker(['image', 'inspect', candidate.imageId]))
  assert.equal(`${image.Os}/${image.Architecture}`, candidate.platform)
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], candidate.commit)
  assert.equal(image.Config.Labels['org.opencontainers.image.version'], candidate.version)
  assert(!Object.values(configuration.services).some(service => service.ports), 'Rehearsal services must not publish host ports')
  report.isolation.noHostPublishedPorts = true
  assert.equal(appEnv.TOKEN_REFRESH_ENABLED, 'false')
  assert.equal(appEnv.USAGE_CLEANUP_ENABLED, 'false')
  assert.equal(appEnv.CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR, '1')
  assert.equal(appEnv.AUTO_SETUP, 'false')
  report.isolation.noProviderBackgroundJobs = true
  assert.equal(appEnv.DATABASE_HOST, 'db')
  assert.equal(appEnv.REDIS_HOST, 'redis')
  report.isolation.productionDependenciesReferenced = false
  docker([...compose, 'create'])
  const [network] = JSON.parse(docker(['network', 'inspect', `${project}_default`]))
  assert.equal(network.Internal, true)
  assert.equal(network.Labels['com.docker.compose.project'], project)
  report.isolation.networkInternal = true
  for (const volume of ['db-data', 'redis-data', 'blue-data', 'green-data']) {
    const name = `${project}_${volume}`
    const [item] = JSON.parse(docker(['volume', 'inspect', name]))
    assert.equal(item.Labels['com.docker.compose.project'], project)
    assert(name.startsWith(`${project}_`))
  }
  report.isolation.separateImplementationVolumes = true
  for (const volume of ['blue-data', 'green-data', 'redis-data']) {
    const name = `${project}_${volume}`
    const command = volume === 'redis-data' ? 'cp /backup/redis.rdb /restore/dump.rdb' : 'tar -xzf /backup/app-data.tar.gz -C /restore; chown -R 1000:1000 /restore'
    restoreVolume(name, command)
  }
  assert.equal(helperNetworkNone && helperCount > 0, true)
  report.isolation.helperNetworkNone = true
  docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '120', 'db', 'redis'])
  docker(['cp', join(backup, 'postgres.dump'), `${id('db')}:/tmp/restore.dump`])
  docker(['exec', id('db'), 'pg_restore', '-U', 'rehearsal', '-d', 'rehearsal', '--exit-on-error', '--no-owner', '--no-acl', '/tmp/restore.dump'])
  report.restored = fingerprints(false)
  report.backgroundInventory = JSON.parse(sql(inventory))
  const migrationsBefore = migrationRows()
  const priorByName = new Map(migrationsBefore.map(item => [item.filename, item.checksum]))
  const targetPresentBefore = expectedMigrationNames.filter(name => priorByName.has(name))
  const alreadyMigrated = !sameVersion && targetPresentBefore.length === expectedMigrationNames.length &&
    expectedMigrationNames.every(name => priorByName.get(name) === expectedMigrationChecksums.get(name))
  report.alreadyMigrated = sameVersion ? true : alreadyMigrated
  const allowMissingBefore = sameVersion ? [] : targetPresentBefore.length === 0 ? expectedMigrationNames : []
  report.sourceCoverageBefore = assertMigrationRowsMatchSource(migrationsBefore, sourceMigrationChecksums, { allowMissing: allowMissingBefore })
  const schemaBefore = schemaFingerprint()
  const imageGenerationBefore = imageGenerationGate()
  const imageBillingBefore = sameVersion ? imageBillingRows() : null
  const scopedAdminKeysBefore = sameVersion ? scopedAdminKeyRows() : null
  const unlimitedQuotaRowsBefore = unlimitedQuotaRows()
  docker([...compose, 'up', '--detach', 'blue'])
  await ready('blue')
  const login = request('blue', '/api/v1/auth/login', null, { email: originalEnv.ADMIN_EMAIL, password: originalEnv.ADMIN_PASSWORD })
  assert.equal(login.status, 200, 'Recovered administrator must authenticate; credentials are not printed')
  const token = JSON.parse(login.body).data.access_token
  assert.equal(request('blue', '/api/v1/auth/me', token).status, 200)
  const businessBefore = fingerprints(sameVersion)
  const configurationBefore = sameVersion ? configurationSnapshot('blue', token) : null
  report.checks.push('backup protected-file checksums', 'backup archive checksums', 'isolated no-egress network', 'PostgreSQL restore', 'Redis snapshot load', 'separate restored app volumes')
  report.checks.push('old image restored startup', 'existing administrator login', 'release-source migration coverage')
  const started = Date.now()
  docker([...compose, 'up', '--detach', 'green'])
  await ready('green')
  report.candidateStartupMs = Date.now() - started
  const isolatedDefaultNetwork = `${project}_default`
  for (const service of ['blue', 'green']) {
    const { container, environment } = serviceEnvironment(service)
    assert.equal(environment.TOKEN_REFRESH_ENABLED, 'false', `${service} token refresh must be disabled`)
    assert.equal(environment.USAGE_CLEANUP_ENABLED, 'false', `${service} usage cleanup must be disabled`)
    assert.equal(environment.CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR, '1', `${service} provider monitor aggregation must be disabled`)
    assert.equal(environment.AUTO_SETUP, 'false', `${service} setup must be disabled`)
    assert.equal(environment.DATABASE_HOST, 'db', `${service} must use the isolated database`)
    assert.equal(environment.REDIS_HOST, 'redis', `${service} must use the isolated Redis`)
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [isolatedDefaultNetwork], `${service} joined an unexpected network`)
    assert.equal(Object.values(container.NetworkSettings.Networks)[0].NetworkID, network.Id, `${service} network identity changed`)
    assert.equal(Object.keys(container.HostConfig.PortBindings || {}).length, 0, `${service} published a host port`)
  }
  report.isolation.noProviderBackgroundJobs = true
  report.isolation.productionDependenciesReferenced = false
  const migrationsAfter = migrationRows()
  const schemaAfter = schemaFingerprint()
  const businessAfter = fingerprints(sameVersion)
  const imageGenerationAfter = imageGenerationGate()
  const imageBillingAfter = imageBillingRows()
  const scopedAdminKeysAfter = sameVersion ? scopedAdminKeyRows() : null
  const unlimitedQuotaRowsAfter = unlimitedQuotaRows()
  const transition = validateMigrationTransition({ mode: selection.mode, before: migrationsBefore, after: migrationsAfter,
    expectedChecksums: Object.fromEntries(expectedMigrationChecksums) })
  report.sourceCoverageAfter = assertMigrationRowsMatchSource(migrationsAfter, sourceMigrationChecksums, { allowMissing: [] })
  assert.equal(transition.alreadyMigrated, report.alreadyMigrated)
  report.migrations = { mode: selection.mode, beforeCount: migrationsBefore.length, afterCount: migrationsAfter.length,
    expectedNewCount: expectedNewMigrations, newCount: transition.newMigrations.length, newMigrations: transition.newMigrations,
    alreadyMigrated: transition.alreadyMigrated, restartStable: false }
  if (sameVersion) {
    assert.deepEqual(migrationsAfter, migrationsBefore, 'Same-version startup changed migration rows')
    assert.deepEqual(schemaAfter, schemaBefore, 'Same-version startup changed schema metadata')
    assert.deepEqual(businessAfter, businessBefore, 'Same-version startup changed business projections')
    assert.deepEqual(configurationBefore, configurationSnapshot('green', token), 'Same-version startup changed configuration state')
    assert.deepEqual(imageGenerationAfter, imageGenerationBefore, 'Same-version startup changed image-generation group values')
    assert.deepEqual(imageBillingAfter, imageBillingBefore, 'Same-version startup changed image-count billing values')
    assert.equal(scopedAdminKeysAfter, scopedAdminKeysBefore, 'Same-version startup changed scoped administrator key rows')
    assert.equal(unlimitedQuotaRowsAfter, unlimitedQuotaRowsBefore, 'Same-version startup changed unlimited quota rows')
    const rechecked = validateMigrationTransition({ mode: sameVersionMode, before: migrationsBefore, after: migrationsAfter })
    assert.equal(rechecked.newMigrations.length, 0)
    report.checks.push('same-version zero migration/checksum delta', 'all 299 release-source migration rows exact',
      'business projections unchanged through startup', 'configuration/settings/app-data unchanged through startup',
      'migration 246 image gates preserved, not re-applied', 'migration 247 scoped-key rows preserved, not reset',
      'migration 248 image-count values preserved, not forced false')
  } else {
    for (const table of baseTables) assert.deepEqual(businessAfter[table], businessBefore[table], `Migration changed existing ${table} projections`)
    const beforeGate = new Map(imageGenerationBefore.map(item => [item.id, item]))
    assert.equal(imageGenerationAfter.length, imageGenerationBefore.length, 'Migration 246 changed the group row set')
    let expectedImageGenerationFlips = 0
    for (const item of imageGenerationAfter) {
      const prior = beforeGate.get(item.id)
      assert(prior, 'Migration 246 introduced or removed a group row')
      const targetPlatform = item.platform === 'gemini' || item.platform === 'antigravity'
      if (targetPlatform && prior.allow_image_generation === false) {
        assert.equal(item.allow_image_generation, true, `Migration 246 did not enable expected group ${item.id}`)
        expectedImageGenerationFlips++
      } else {
        assert.equal(item.allow_image_generation, prior.allow_image_generation, `Migration 246 changed an out-of-scope group ${item.id}`)
      }
    }
    report.expectedImageGenerationFlips = expectedImageGenerationFlips
    assert.equal(Number(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='scoped_admin_api_keys';")), 1, 'Migration 247 did not create scoped_admin_api_keys')
    const scopedColumns = JSON.parse(sql("SELECT json_agg(json_build_object('name',column_name,'type',data_type) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='scoped_admin_api_keys';"))
    assert.deepEqual(scopedColumns.map(item => item.name), ['id','name','description','key_prefix','key_hash','enabled','expires_at','allowed_ips','policy','created_by','created_at','updated_at','last_used_at','last_used_ip','revoked_at','deleted_at'], 'Migration 247 column inventory changed')
    assert.equal(scopedColumns.find(item => item.name === 'key_hash').type, 'character varying')
    assert.equal(scopedColumns.find(item => item.name === 'allowed_ips').type, 'jsonb')
    assert.equal(scopedColumns.find(item => item.name === 'policy').type, 'jsonb')
    assert.equal(scopedAdminKeyRows(), 0, 'Rehearsal unexpectedly contains administrator API keys')
    const imageBillingColumn = JSON.parse(sql("SELECT json_build_object('type',data_type,'nullable',is_nullable,'default',column_default) FROM information_schema.columns WHERE table_schema='public' AND table_name='groups' AND column_name='image_count_billing';"))
    assert.equal(imageBillingColumn.type, 'boolean')
    assert.equal(imageBillingColumn.nullable, 'NO')
    assert.equal(imageBillingColumn.default, 'false')
    assert(imageBillingAfter.every(item => item.enabled === false), 'Migration 248 default must leave image_count_billing disabled')
    assert.equal(unlimitedQuotaRowsAfter, 0)
    for (const item of migrationsBefore) assert.equal(sql(`SELECT checksum FROM schema_migrations WHERE filename='${item.filename}';`), item.checksum)
    report.checks.push(`${expectedNewMigrations} expected new migrations with exact checksums`, 'existing migration checksums unchanged',
      `${report.expectedImageGenerationFlips} expected migration 246 Gemini/Antigravity image-gate flips`, 'migration 247 scoped key schema present without keys',
      'migration 248 image-count billing column defaults disabled', 'business projections unchanged outside migration 246')
  }
  for (const service of ['blue', 'green']) {
    assert.equal(request(service, '/api/v1/auth/me', token).status, 200)
    assert.equal(request(service, '/api/v1/auth/me').status, 401)
    const compliance = request(service, '/api/v1/admin/compliance', token)
    assert.equal(compliance.status, 200)
    assert.equal(JSON.parse(compliance.body).data.required, false)
    for (const path of ['/api/v1/admin/system/version', '/api/v1/admin/users?page=1&page_size=10',
      '/api/v1/admin/accounts?page=1&page_size=10', '/api/v1/admin/groups', '/login']) {
      assert.equal(request(service, path, token).status, 200, `${service} ${path}`)
    }
    const version = JSON.parse(request(service, '/api/v1/admin/system/version', token).body).data.version
    assert.equal(version, service === 'green' ? candidate.version : oldVersion)
  }
  report.checks.push('old session valid in both versions', 'existing compliance preserved', 'both admin read workflows')
  const initialSettings = JSON.parse(request('green', '/api/v1/admin/settings', token).body).data
  const sharedAppearance = { skin: 'neubrutalism', mode: 'dark', accent_color: '#112233' }
  const changed = await putSettings('green', token, { ...initialSettings, site_appearance: sharedAppearance })
  if (changed.status !== 200) {
    await writeFile(join(directory, 'appearance-save-response-private.json'), JSON.stringify(changed), { mode: 0o600 })
    const logs = spawnSync('docker', ['logs', '--tail', '120', id('green')], { encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20 })
    await writeFile(join(directory, 'appearance-save-logs-private.txt'), (logs.stdout || '') + (logs.stderr || ''), { mode: 0o600 })
  }
  assert.equal(changed.status, 200, 'Recovered admin appearance save failed')
  const changedSettings = JSON.parse(request('green', '/api/v1/admin/settings', token).body).data
  assert.deepEqual(changedSettings.site_appearance, sharedAppearance)
  assert.deepEqual({ ...changedSettings, site_appearance: initialSettings.site_appearance }, initialSettings,
    'Appearance save changed other visible settings')
  assert.deepEqual(JSON.parse(request('green', '/api/v1/settings/public').body).data.site_appearance, sharedAppearance)
  assert(request('green', '/login').body.includes('"accent_color":"#112233"'), 'SSR appearance did not refresh')
  assert.equal((await putSettings('green', token, { site_appearance: null })).status, 400)
  assert.equal((await putSettings('green', token, { site_appearance: { ...sharedAppearance, accent_color: 'red;bad' } })).status, 400)
  assert.deepEqual(JSON.parse(request('green', '/api/v1/admin/settings', token).body).data, changedSettings)
  assert.equal((await putSettings('green', token, initialSettings)).status, 200)
  assert.deepEqual(JSON.parse(request('green', '/api/v1/settings/public').body).data.site_appearance, initialSettings.site_appearance)
  report.checks.push('existing admin shared appearance roundtrip', 'public and SSR appearance refresh',
    'other visible settings unchanged', 'invalid and null appearance reject without writes')
  const groupId = Number(sql("SELECT id FROM groups WHERE platform='openai' AND deleted_at IS NULL ORDER BY id LIMIT 1;"))
  assert(groupId > 0)
  for (const writer of ['blue', 'green']) {
    const created = request(writer, '/api/v1/keys', token, { name: `isolated-${writer}-${project}`, group_id: groupId, quota: 0.01 })
    assert.equal(created.status, 200)
    const key = JSON.parse(created.body).data
    assert(Number.isInteger(key.id) && typeof key.key === 'string')
    for (const reader of ['blue', 'green']) {
      const visible = request(reader, `/api/v1/keys/${key.id}`, token)
      assert.equal(visible.status, 200)
      assert.equal(JSON.parse(visible.body).data.name, key.name)
      const models = request(reader, '/v1/models', key.key)
      assert.equal(models.status, 200)
      assert(JSON.parse(models.body).data.length > 0)
    }
  }
  report.compatibility.oldImageReadWrite = true
  report.compatibility.candidateImageReadWrite = true
  report.checks.push('both versions create keys and read peer writes', 'both versions authenticate synthetic keys and list models')
  const restartBusinessBefore = sameVersion ? fingerprints(true) : null
  const restartConfigurationBefore = sameVersion ? configurationSnapshot('green', token) : null
  docker([...compose, 'restart', 'green'])
  await ready('green')
  assert.equal(request('green', '/api/v1/auth/me', token).status, 200)
  docker([...compose, 'restart', 'blue'])
  await ready('blue')
  assert.equal(request('blue', '/api/v1/auth/me', token).status, 200)
  const migrationsAfterRestart = migrationRows()
  assertMigrationRowsMatchSource(migrationsAfterRestart, sourceMigrationChecksums, { allowMissing: [] })
  if (sameVersion) {
    assert.deepEqual(migrationsAfterRestart, migrationsBefore, 'Same-version restart changed migration rows')
    const restartBusinessAfter = fingerprints(true)
    const restartConfigurationAfter = configurationSnapshot('green', token)
    report.sameVersion = validateSameVersionPreserved({ beforeMigrations: migrationsBefore, afterMigrations: migrationsAfter,
      restartMigrations: migrationsAfterRestart, beforeBusiness: restartBusinessBefore, afterBusiness: restartBusinessAfter,
      beforeConfiguration: restartConfigurationBefore, afterConfiguration: restartConfigurationAfter })
    report.migrations.restartStable = true
    report.compatibility.restartStable = true
    report.checks.push('new restart idempotence', 'old restart on unchanged 0.2.19 data', 'migration set stable across restarts',
      'business and configuration state stable across both restarts')
  } else {
    assert.deepEqual(migrationsAfterRestart, migrationsAfter, 'Restart changed the migration set')
    const expectedCount = report.alreadyMigrated ? migrationsBefore.length : migrationsBefore.length + expectedNewMigrations
    assert.equal(migrationsAfterRestart.length, expectedCount, 'Restart applied an unexpected migration set')
    report.migrations.restartStable = true
    report.compatibility.restartStable = true
    report.checks.push('new restart idempotence', 'old restart on migrated data', 'migration set stable across restarts')
  }
  report.passed = true
} catch (error) {
  report.error = error.message
  throw error
} finally {
  report.cleanupErrors = []
  for (const helper of helpers) {
    try {
      const result = spawnSync('docker', ['inspect', helper], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 })
      if (result.status === 1 && result.stderr.includes('No such object')) continue
      assert(!result.error && result.status === 0, 'Cannot inspect owned restore helper')
      const [item] = JSON.parse(result.stdout)
      assert.equal(item.Config.Labels['io.sub2api.rehearsal'], project)
      docker(['rm', '--force', item.Id])
    } catch (error) { report.cleanupErrors.push(error.message) }
  }
  try {
    docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '15'])
  } catch (error) { report.cleanupErrors.push(error.message) }
  report.cleanupSucceeded = report.cleanupErrors.length === 0
  report.scriptCompleted = true
  report.passed = report.passed === true && report.cleanupSucceeded
  report.completedAt = new Date().toISOString()
  await writeFile(join(directory, 'rehearsal-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  assert.equal(report.cleanupErrors.length, 0, `Owned rehearsal cleanup incomplete; inspect ${directory}`)
  console.log(JSON.stringify({ passed: report.passed, project, directory, migrationMode: report.migrationMode,
    checks: report.checks, candidateStartupMs: report.candidateStartupMs,
    migrations: report.migrations, sameVersion: report.sameVersion, cleanupSucceeded: report.cleanupSucceeded,
    productionDeploymentPerformed: false, realGatewayCallsTested: false }, null, 2))
}
