import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, mkdtemp, writeFile, stat } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

process.umask(0o077)
const backup = resolve(process.argv[2] || '')
assert(backup.includes('/sub2api-upgrade-private/backup-'))
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
assert(process.argv[3], 'Pass the exact candidate manifest path as the second argument')
const candidatePath = resolve(process.argv[3])
const candidate = JSON.parse(await readFile(candidatePath, 'utf8'))
assert.match(candidate.imageId, /^sha256:[a-f0-9]{64}$/)
assert.equal(candidate.platform, 'linux/arm64')
const manifest = JSON.parse(await readFile(join(backup, 'backup-manifest.json'), 'utf8'))
const oldVersion = manifest.oldVersion || '0.2.4'
const expectedNewMigrations = oldVersion === '0.2.4' ? 7 : 0
const inventory = await readFile(join(root, 'deploy/local-upgrade/compatibility-inventory.sql'), 'utf8')
const originals = JSON.parse(await readFile(join(backup, 'recovery-private.json'), 'utf8'))
assert.equal((await stat(backup)).mode & 0o777, 0o700)
for (const item of manifest.archives) {
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
  ...originalEnv, DATABASE_HOST: 'db', DATABASE_PORT: '5432', DATABASE_USER: 'rehearsal',
  DATABASE_DBNAME: 'rehearsal', DATABASE_PASSWORD: dbPassword, REDIS_HOST: 'redis',
  REDIS_PORT: '6379', REDIS_PASSWORD: redisPassword, SERVER_HOST: '0.0.0.0', SERVER_PORT: '8080',
  TOKEN_REFRESH_ENABLED: 'false', USAGE_CLEANUP_ENABLED: 'false',
  LOG_OUTPUT_TO_FILE: 'false', LOG_LEVEL: 'error',
  DATABASE_MAX_OPEN_CONNS: '10', DATABASE_MAX_IDLE_CONNS: '2', REDIS_POOL_SIZE: '16', REDIS_MIN_IDLE_CONNS: '2',
  GOMAXPROCS: '2', GOMEMLIMIT: '384MiB', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1'
}
const logging = { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } }
function app(image, volume) {
  return { image, pull_policy: 'never', cpus: 0.5, mem_limit: '512m', environment: appEnv,
    volumes: [`${volume}:/app/data`], logging,
    depends_on: { db: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } } }
}
const configuration = {
  services: {
    db: { image: manifest.databaseImageId, pull_policy: 'never', cpus: 0.5, mem_limit: '384m',
      environment: { POSTGRES_USER: 'rehearsal', POSTGRES_DB: 'rehearsal', POSTGRES_PASSWORD: dbPassword },
      volumes: ['db-data:/var/lib/postgresql'], logging,
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U rehearsal -d rehearsal'], interval: '2s', timeout: '2s', retries: 45 } },
    redis: { image: manifest.redisImageId, pull_policy: 'never', cpus: 0.25, mem_limit: '64m',
      environment: { REDISCLI_AUTH: redisPassword }, volumes: ['redis-data:/data'], logging,
      command: ['redis-server', '--requirepass', redisPassword, '--appendonly', 'no'],
      healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '2s', retries: 45 } },
    blue: app(manifest.oldImageId, 'blue-data'), green: {
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
  docker(['create', '--name', helper, '--network', 'none', '--entrypoint', 'sh',
    '--cpus', '0.25', '--memory', '128m', '--log-driver', 'none',
    '--label', `io.sub2api.rehearsal=${project}`, '--mount', `type=volume,source=${name},target=/restore`,
    '--mount', `type=bind,source=${backup},target=/backup,readonly`, candidate.imageId, '-ec', command], undefined, 60_000)
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
const tables = ['users', 'accounts', 'api_keys', 'groups', 'account_groups', 'channel_model_pricing',
  'channel_account_stats_model_pricing', 'user_platform_quotas', 'usage_logs']
const projections = {}
function fingerprints() {
  const results = {}
  for (const table of tables) {
    if (!projections[table]) {
      const columns = sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position;`).split('\n')
      assert(columns.length > 0 && columns.every(name => /^[a-z_][a-z0-9_]*$/.test(name)), `No valid projection for ${table}`)
      // Login intentionally updates user activity timestamps; all business fields remain compared.
      const activity = table === 'users' ? ['last_login_at', 'last_active_at', 'updated_at'] : []
      projections[table] = columns.filter(name => !activity.includes(name)).map(name => `"${name}"`).join(',')
    }
    const filter = table === 'user_platform_quotas' ? ' WHERE daily_limit_usd IS NOT NULL OR weekly_limit_usd IS NOT NULL OR monthly_limit_usd IS NOT NULL' : ''
    results[table] = JSON.parse(sql(`SELECT json_build_object('rows',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),''))) FROM (SELECT ${projections[table]} FROM "${table}"${filter}) t;`))
  }
  return results
}
const report = { project, directory, backup, candidateCommit: candidate.commit,
  oldImageId: manifest.oldImageId, candidateImageId: candidate.imageId,
  checks: [], productionDeploymentPerformed: false, realGatewayCallsTested: false, passed: false }
try {
  const [image] = JSON.parse(docker(['image', 'inspect', candidate.imageId]))
  assert.equal(`${image.Os}/${image.Architecture}`, candidate.platform)
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], candidate.commit)
  assert.equal(image.Config.Labels['org.opencontainers.image.version'], candidate.version)
  docker([...compose, 'create'])
  const [network] = JSON.parse(docker(['network', 'inspect', `${project}_default`]))
  assert.equal(network.Internal, true)
  assert.equal(network.Labels['com.docker.compose.project'], project)
  for (const volume of ['blue-data', 'green-data', 'redis-data']) {
    const name = `${project}_${volume}`
    const [item] = JSON.parse(docker(['volume', 'inspect', name]))
    assert.equal(item.Labels['com.docker.compose.project'], project)
    const command = volume === 'redis-data' ? 'cp /backup/redis.rdb /restore/dump.rdb' : 'tar -xzf /backup/app-data.tar.gz -C /restore; chown -R 1000:1000 /restore'
    restoreVolume(name, command)
  }
  docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '120', 'db', 'redis'])
  docker(['cp', join(backup, 'postgres.dump'), `${id('db')}:/tmp/restore.dump`])
  docker(['exec', id('db'), 'pg_restore', '-U', 'rehearsal', '-d', 'rehearsal', '--exit-on-error', '--no-owner', '--no-acl', '/tmp/restore.dump'])
  report.restored = fingerprints()
  report.backgroundInventory = JSON.parse(sql(inventory))
  report.priorMigrations = JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('filename',filename,'checksum',checksum) ORDER BY filename),'[]'::json) FROM schema_migrations;"))
  report.unlimitedQuotaRowsBefore = Number(sql('SELECT count(*) FROM user_platform_quotas WHERE daily_limit_usd IS NULL AND weekly_limit_usd IS NULL AND monthly_limit_usd IS NULL;'))
  report.legacyGroupPricingRows = Number(sql("SELECT count(*) FROM groups WHERE model_pricing::text LIKE '%max_reasoning_effort_multiplier%';"))
  report.checks.push('backup checksums', 'isolated no-egress network', 'PostgreSQL restore', 'Redis snapshot load', 'separate restored app volumes')
  docker([...compose, 'up', '--detach', 'blue'])
  await ready('blue')
  const login = request('blue', '/api/v1/auth/login', null, { email: originalEnv.ADMIN_EMAIL, password: originalEnv.ADMIN_PASSWORD })
  assert.equal(login.status, 200, 'Recovered administrator must authenticate; credentials are not printed')
  const token = JSON.parse(login.body).data.access_token
  assert.equal(request('blue', '/api/v1/auth/me', token).status, 200)
  const before = fingerprints()
  assert.deepEqual(before.users, report.restored.users)
  assert.deepEqual(before.api_keys, report.restored.api_keys)
  report.checks.push('old image restored startup', 'existing administrator login')
  const started = Date.now()
  docker([...compose, 'up', '--detach', 'green'])
  await ready('green')
  report.candidateStartupMs = Date.now() - started
  report.afterMigrations = fingerprints()
  const expectedStable = ['users', 'accounts', 'api_keys', 'groups', 'account_groups', 'channel_model_pricing',
    'channel_account_stats_model_pricing', 'user_platform_quotas', 'usage_logs']
  for (const table of expectedStable) assert.deepEqual(report.afterMigrations[table], before[table], `Migration changed existing ${table} projections`)
  report.newMigrations = JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('filename',filename,'checksum',checksum) ORDER BY filename),'[]'::json) FROM schema_migrations;"))
    .filter(item => !report.priorMigrations.some(prior => prior.filename === item.filename))
  assert.equal(report.newMigrations.length, expectedNewMigrations)
  assert.equal(Number(sql('SELECT count(*) FROM user_platform_quotas WHERE daily_limit_usd IS NULL AND weekly_limit_usd IS NULL AND monthly_limit_usd IS NULL;')), 0)
  for (const item of report.priorMigrations) {
    assert.equal(sql(`SELECT checksum FROM schema_migrations WHERE filename='${item.filename}';`), item.checksum)
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
  report.checks.push(`${expectedNewMigrations} expected new migrations`, 'existing migration checksums unchanged',
    'business projections unchanged', 'old session valid in both versions', 'existing compliance preserved', 'both admin read workflows')
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
  report.checks.push('both versions create keys and read peer writes', 'both versions authenticate synthetic keys and list models')
  docker([...compose, 'restart', 'green'])
  await ready('green')
  assert.equal(request('green', '/api/v1/auth/me', token).status, 200)
  docker([...compose, 'restart', 'blue'])
  await ready('blue')
  assert.equal(request('blue', '/api/v1/auth/me', token).status, 200)
  report.checks.push('new restart idempotence', 'old restart on migrated data')
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
  await writeFile(join(directory, 'rehearsal-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  assert.equal(report.cleanupErrors.length, 0, `Owned rehearsal cleanup incomplete; inspect ${directory}`)
  console.log(JSON.stringify({ passed: report.passed, project, directory, checks: report.checks,
    candidateStartupMs: report.candidateStartupMs, migrations: report.newMigrations?.map(item => item.filename),
    restoredRows: report.restored && Object.fromEntries(Object.entries(report.restored).map(([table, item]) => [table, item.rows])),
    productionDeploymentPerformed: false, realGatewayCallsTested: false }, null, 2))
}
