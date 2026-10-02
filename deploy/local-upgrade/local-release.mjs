import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, rename, open, unlink, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { currentCodex, liveGateway } from './live-gateway.mjs'

process.umask(0o077)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const deployment = '/Users/clawbotbot/Projects/sub2api-local'
const directory = join(deployment, 'releases/clash-2')
const ingressDirectory = join(directory, 'ingress')
const statePath = join(directory, 'state.json')
const action = process.argv[2]
assert(['prepare', 'verify', 'activate', 'rollback', 'status'].includes(action), 'Choose prepare, verify, activate, rollback or status')
const tailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const project = 'sub2api-release-clash2'
const oldId = '6364466784a859fbeb12088ca81afd4a161decb34655337bdc5187c3815e85a7'
const oldImage = 'sha256:ccf47a1c62e355f51f896e489f8253e119fe4101b103cd701ba458cc6c6f0f77'
const candidateCommit = 'd69e52c0ff2e1a3261757de646defe4a97193c02'
const proxyImage = 'haproxy@sha256:8007effce89a08af0236b9529a0daab5b8b36fa939f4162f28201f1bf8731dbf'
const network = 'sub2api_sub2api-network'
const ingressBase = 'http://127.0.0.1:18380'
const greenBase = 'http://127.0.0.1:18282'
const composePath = join(directory, 'compose-private.json')
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath,
  '--file', join(root, 'deploy/local-upgrade/legacy-assets-health.yaml')]

function command(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 << 20 })
  assert(!r.error && r.status === 0, `Release ${cmd.split('/').at(-1)} ${args[0]} failed; sensitive details suppressed`)
  return r.stdout.trim()
}
const docker = (args, input) => command('docker', args, input)
const inspect = target => JSON.parse(docker(['inspect', target]))[0]
const service = name => docker([...compose, 'ps', '--all', '--quiet', name])
const serve = () => JSON.parse(command(tailscale, ['serve', 'status', '--json']))
const handlerKey = 'openclaw-macmini-ts.tailff52e6.ts.net:443'
function checkOld() {
  const old = inspect(oldId)
  assert.equal(old.Image, oldImage)
  assert.equal(old.State.Running, true)
  assert.equal(old.State.Health.Status, 'healthy')
  assert.equal(old.RestartCount, 0)
  return old
}
async function save(state) {
  const temporary = `${statePath}.pending`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, statePath)
}
async function health(base) {
  const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).status, 'ok')
}
async function waitHealth(base) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    checkOld()
    try { await health(base); return } catch { /* Candidate startup/migration. */ }
    await delay(1000)
  }
  throw new Error('New slot failed to start; old entry was not changed')
}
function runtime(text) {
  const ingress = inspect(service('ingress'))
  assert.equal(ingress.Config.Labels['com.docker.compose.project'], project)
  return docker(['exec', '-i', ingress.Id, 'sh', '-c', 'nc -w 1 127.0.0.1 9999'], `${text}\n`)
}
async function setSlot(slot) {
  assert(['blue', 'green'].includes(slot))
  assert.equal(runtime(`set map /var/lib/sub2api-ingress/active.map active ${slot}`), '')
  assert(runtime('show map /var/lib/sub2api-ingress/active.map').includes(`active ${slot}`))
  const temporary = join(ingressDirectory, 'active.map.pending')
  await writeFile(temporary, `active ${slot}\n`, { mode: 0o600 })
  await rename(temporary, join(ingressDirectory, 'active.map'))
  const r = await fetch(`${ingressBase}/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-sub2api-slot'), slot)
}
async function version(base) {
  const old = checkOld()
  const env = Object.fromEntries(old.Config.Env.map(item => {
    const index = item.indexOf('='); return [item.slice(0, index), item.slice(index + 1)]
  }))
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(5000) })
  assert.equal(login.status, 200, 'Existing local administrator login failed; details suppressed')
  const token = (await login.json()).data.access_token
  const r = await fetch(`${base}/api/v1/admin/system/version`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  return (await r.json()).data.version
}

await mkdir(deployment, { recursive: true, mode: 0o700 })
const lockPath = join(deployment, '.release-operation.lock')
const lock = await open(lockPath, 'wx', 0o600)
await lock.writeFile(JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() }))
let state
try {
  checkOld()
  if (action === 'prepare') {
    assert(process.argv[3] && process.argv[4], 'prepare requires exact manifest and fresh private backup paths')
    const manifest = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'))
    assert.equal(manifest.commit, candidateCommit)
    assert.equal(manifest.version, '0.2.12-clash.2')
    const image = JSON.parse(docker(['image', 'inspect', manifest.imageId]))[0]
    assert.equal(image.Config.Labels['org.opencontainers.image.revision'], candidateCommit)
    assert.equal(image.Config.Labels['org.opencontainers.image.version'], manifest.version)
    assert.equal(`${image.Os}/${image.Architecture}`, 'linux/arm64')
    const backup = resolve(process.argv[4])
    assert.match(backup, /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/)
    const record = JSON.parse(await readFile(join(backup, 'backup-manifest.json'), 'utf8'))
    assert.equal(record.oldContainerId, oldId)
    assert.equal(record.oldImageId, oldImage)
    assert(Date.now() - Date.parse(record.finished) < 30 * 60_000, 'Take a fresh backup before shared migration')
    for (const file of record.archives) {
      assert(['postgres.dump', 'redis.rdb', 'app-data.tar.gz'].includes(file.name))
      const data = await readFile(join(backup, file.name))
      assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256)
    }
    const old = checkOld()
    const env = Object.fromEntries(old.Config.Env.map(item => {
      const index = item.indexOf('='); return [item.slice(0, index), item.slice(index + 1)]
    }))
    assert(env.JWT_SECRET && /^[0-9a-fA-F]{64}$/.test(env.TOTP_ENCRYPTION_KEY))
    const inventory = await readFile(join(root, 'deploy/local-upgrade/compatibility-inventory.sql'), 'utf8')
    const jobs = JSON.parse(docker(['exec', '-i', 'sub2api-postgres', 'sh', '-c',
      'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'],
    `BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; ${inventory} ROLLBACK;`))
    assert.equal(jobs.enabledScheduledTests, 0)
    assert.equal(jobs.enabledChannelMonitors, 0)
    assert.equal(jobs.backupScheduleEnabled, false)
    assert.equal(jobs.activeBackupOperations, 0)
    const assetRun = join(root, 'frontend/tmp/asset-tests/run-Y9Krqa')
    const assetReport = JSON.parse(await readFile(join(assetRun, 'report.json'), 'utf8'))
    assert.equal(assetReport.passed, true)
    assert.equal(assetReport.oldImageId, oldImage)
    const oldAssets = await readFile(join(assetRun, 'old-assets.map'), 'utf8')
    assert(oldAssets.trim().split('\n').every(line => /^\/assets\/[a-zA-Z0-9_./-]+\.(js|css) legacy_assets$/.test(line)))
    const tailscaleBefore = serve()
    assert.equal(tailscaleBefore.Web[handlerKey].Handlers['/'].Proxy, 'http://127.0.0.1:18080')
    assert.equal(tailscaleBefore.Web['openclaw-macmini-ts.tailff52e6.ts.net:8443'].Handlers['/'].Proxy, 'http://127.0.0.1:7777')
    await mkdir(join(deployment, 'releases'), { recursive: true, mode: 0o700 })
    await mkdir(directory, { mode: 0o700 })
    await mkdir(ingressDirectory, { mode: 0o700 })
    await writeFile(join(ingressDirectory, 'active.map'), 'active blue\n', { flag: 'wx', mode: 0o600 })
    await writeFile(join(ingressDirectory, 'old-assets.map'), oldAssets, { flag: 'wx', mode: 0o600 })
    await copyFile(join(root, 'deploy/local-upgrade/haproxy-legacy-assets.cfg'), join(ingressDirectory, 'haproxy.cfg'))
    const logging = { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } }
    const greenEnv = { ...env, AUTO_SETUP: 'false', TOKEN_REFRESH_ENABLED: 'false', USAGE_CLEANUP_ENABLED: 'false',
      CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1', GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT: 'true',
      DATABASE_MAX_OPEN_CONNS: '20', DATABASE_MAX_IDLE_CONNS: '5', REDIS_POOL_SIZE: '64', REDIS_MIN_IDLE_CONNS: '2',
      GOMAXPROCS: '2', GOMEMLIMIT: '512MiB', LOG_LEVEL: 'warn', LOG_OUTPUT_TO_FILE: 'false',
      SERVER_TRUSTED_PROXIES: '172.19.0.0/16' }
    const config = { services: {
      green: { image: manifest.imageId, pull_policy: 'never', container_name: 'sub2api-green-clash2',
        restart: 'unless-stopped', cpus: 1, mem_limit: '768m', environment: greenEnv,
        security_opt: ['no-new-privileges:true'], volumes: ['green-data:/app/data'],
        ports: ['127.0.0.1:18282:8080'], networks: ['production'], logging },
      legacy: { image: oldImage, pull_policy: 'never', restart: 'unless-stopped', entrypoint: ['/app/sub2api'],
        user: '1000:1000', read_only: true, cpus: 0.25, mem_limit: '128m',
        environment: { AUTO_SETUP: 'false', SERVER_HOST: '0.0.0.0', SERVER_PORT: '8080', GIN_MODE: 'release', GOMAXPROCS: '1' },
        tmpfs: ['/app/data:uid=1000,gid=1000,mode=0700,size=4m', '/tmp:size=4m'], networks: ['assets'], logging,
        security_opt: ['no-new-privileges:true'] },
      ingress: { image: proxyImage, pull_policy: 'never', restart: 'unless-stopped', cpus: 0.25, mem_limit: '128m', logging,
        ports: ['127.0.0.1:18380:8080'], networks: ['production', 'assets'],
        environment: { SUB2API_BLUE_UPSTREAM: 'sub2api:8080', SUB2API_GREEN_UPSTREAM: 'sub2api-green-clash2:8080',
          SUB2API_LEGACY_ASSETS_UPSTREAM: 'legacy:8080' },
        volumes: [`${join(ingressDirectory, 'haproxy.cfg')}:/usr/local/etc/haproxy/haproxy.cfg:ro`,
          `${ingressDirectory}:/var/lib/sub2api-ingress:ro`], security_opt: ['no-new-privileges:true'] }
    }, networks: { production: { external: true, name: network }, assets: { internal: true } }, volumes: { 'green-data': {} } }
    await writeFile(composePath, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
    state = { createdAt: new Date().toISOString(), candidateCommit, candidateImageId: manifest.imageId,
      version: manifest.version, oldContainerId: oldId, oldImageId: oldImage, backup,
      tailscaleBefore, phase: 'prepared-not-started', sharedMigrationPerformed: false,
      activeSlot: 'blue', oldRetained: true, directory }
    await save(state)
    docker([...compose, 'create', 'green'])
    const volume = `${project}_green-data`
    assert.equal(inspect(volume).Labels['com.docker.compose.project'], project)
    const helper = `${project}-initialize`
    docker(['run', '--rm', '--name', helper, '--network', 'none', '--entrypoint', 'sh', '--log-driver', 'none',
      '--cpus', '0.25', '--memory', '128m', '--mount', `type=volume,source=${volume},target=/restore`,
      '--mount', `type=bind,source=${backup},target=/backup,readonly`, manifest.imageId, '-ec',
      'tar -xzf /backup/app-data.tar.gz -C /restore; chown -R 1000:1000 /restore'])
    state.phase = 'starting-shared-candidate'
    state.sharedMigrationPerformed = 'candidate-startup-may-migrate'
    await save(state)
    docker([...compose, 'up', '--detach', 'green', 'legacy', 'ingress'])
    await waitHealth(greenBase)
    await waitHealth(ingressBase)
    assert.equal(await version(greenBase), manifest.version)
    docker(['exec', service('ingress'), 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
    state.greenContainerId = service('green')
    state.ingressContainerId = service('ingress')
    state.phase = 'prepared-awaiting-real-call'
    state.preparedAt = new Date().toISOString()
    await save(state)
  } else {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(state.candidateCommit, candidateCommit)
    assert.equal(inspect(service('green')).Image, state.candidateImageId)
    if (action === 'verify') {
      assert(['prepared-awaiting-real-call', 'verified-ready-to-switch'].includes(state.phase),
        'Verify only a prepared candidate before activation')
      assert.equal(await version(greenBase), state.version)
      state.directGateway = await liveGateway(`${greenBase}/v1`)
      state.verifiedAt = new Date().toISOString()
      state.phase = 'verified-ready-to-switch'
      await save(state)
    } else if (action === 'activate') {
      assert(state.directGateway?.completed && Date.now() - Date.parse(state.verifiedAt) < 10 * 60_000,
        'A fresh successful real candidate call is required')
      await health(greenBase)
      assert.equal(await version(greenBase), state.version)
      assert.deepEqual(serve(), state.tailscaleBefore, 'Entry changed since prepare; inspect before activation')
      state.phase = 'activating'
      await save(state)
      try {
        await setSlot('green')
        command(tailscale, ['serve', '--bg', '--yes', '--https=443', ingressBase])
        const actual = serve()
        assert.equal(actual.Web[handlerKey].Handlers['/'].Proxy, ingressBase)
        assert.deepEqual(actual.Web['openclaw-macmini-ts.tailff52e6.ts.net:8443'],
          state.tailscaleBefore.Web['openclaw-macmini-ts.tailff52e6.ts.net:8443'])
        state.entryGateway = await liveGateway(currentCodex().baseUrl, 'green')
        assert.equal(await version('https://openclaw-macmini-ts.tailff52e6.ts.net'), state.version)
        state.activeSlot = 'green'
        state.phase = 'active-old-retained'
        state.activatedAt = new Date().toISOString()
        state.minimumGate = 'user-authorized-real-upstream-success-no-full-formal-acceptance'
        await save(state)
      } catch (error) {
        // Restore the public entry independently of proxy runtime/persistence recovery.
        const recovery = { entryRestored: false, proxyRestored: false }
        try {
          command(tailscale, ['serve', '--bg', '--yes', '--https=443', 'http://127.0.0.1:18080'])
          assert.equal(serve().Web[handlerKey].Handlers['/'].Proxy, 'http://127.0.0.1:18080')
          await health('https://openclaw-macmini-ts.tailff52e6.ts.net')
          recovery.entryRestored = true
        } catch { /* Still attempt proxy recovery. */ }
        try { await setSlot('blue'); recovery.proxyRestored = true } catch { /* Report incomplete recovery. */ }
        state.phase = recovery.entryRestored && recovery.proxyRestored
          ? 'activation-failed-old-restored' : 'activation-failed-recovery-required'
        state.activeSlot = recovery.proxyRestored ? 'blue' : 'unknown'
        state.recovery = recovery
        state.error = 'Activation failed; inspect recovery flags, sensitive details suppressed'
        await save(state)
        throw error
      }
    } else if (action === 'rollback') {
      await health('http://127.0.0.1:18080')
      assert.equal(await version('http://127.0.0.1:18080'), '0.2.4')
      await setSlot('blue')
      if (serve().Web[handlerKey].Handlers['/'].Proxy !== ingressBase) {
        command(tailscale, ['serve', '--bg', '--yes', '--https=443', ingressBase])
      }
      await health('https://openclaw-macmini-ts.tailff52e6.ts.net')
      state.phase = 'rolled-back-new-retained'
      state.activeSlot = 'blue'
      state.rolledBackAt = new Date().toISOString()
      await save(state)
    }
  }
  checkOld()
  const runtimeMap = runtime('show map /var/lib/sub2api-ingress/active.map')
  assert(runtimeMap.includes(`active ${state.activeSlot}`), 'Runtime route differs from release state')
  assert.equal((await readFile(join(ingressDirectory, 'active.map'), 'utf8')).trim(), `active ${state.activeSlot}`,
    'Persisted route differs from release state')
  const entryHealth = await fetch(`${ingressBase}/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(entryHealth.status, 200)
  assert.equal(entryHealth.headers.get('x-sub2api-slot'), state.activeSlot)
  const actualServe = serve()
  const tailnetTarget = actualServe.Web[handlerKey].Handlers['/'].Proxy
  assert([ingressBase, 'http://127.0.0.1:18080'].includes(tailnetTarget))
  if (state.activeSlot === 'green') assert.equal(tailnetTarget, ingressBase)
  assert.deepEqual(actualServe.Web['openclaw-macmini-ts.tailff52e6.ts.net:8443'],
    state.tailscaleBefore.Web['openclaw-macmini-ts.tailff52e6.ts.net:8443'])
  const servingVersion = await version(ingressBase)
  assert.equal(servingVersion, state.activeSlot === 'green' ? state.version : '0.2.4')
  console.log(JSON.stringify({ phase: state.phase, activeSlot: state.activeSlot, version: state.version,
    candidateCommit, directory, stableLocalEntry: ingressBase, oldLocalEntry: 'http://127.0.0.1:18080',
    tailnetTarget, servingVersion, runtimeAndPersistedRouteAgree: true,
    directGateway: state.directGateway, entryGateway: state.entryGateway, oldRetained: true }, null, 2))
} catch (error) {
  if (state) { state.lastOperationFailed = { action, at: new Date().toISOString() }; await save(state) }
  throw error
} finally {
  await lock.close()
  await unlink(lockPath)
}
