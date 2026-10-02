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
const directory = join(deployment, 'releases/v0.2.13')
const ingressDirectory = join(directory, 'ingress')
const statePath = join(directory, 'state.json')
const project = 'sub2api-release-v0213'
const previousDirectory = join(deployment, 'releases/clash-2')
const previousId = '9edb659c36a9fe159719d359a2c4cc884711b1bebd3a3507d68a9ebe9fb3af1d'
const previousImage = 'sha256:da20743ebb5610646c8a2898f0cd0c6850bda10d2ed20dbebd75242731563214'
const previousVersion = '0.2.12-clash.2'
const previousBase = 'http://127.0.0.1:18380'
const ingressBase = 'http://127.0.0.1:18480'
const greenBase = 'http://127.0.0.1:18482'
const publicBase = 'https://openclaw-macmini-ts.tailff52e6.ts.net'
const handlerKey = 'openclaw-macmini-ts.tailff52e6.ts.net:443'
const secondaryKey = 'openclaw-macmini-ts.tailff52e6.ts.net:8443'
const tailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const proxyImage = 'haproxy@sha256:8007effce89a08af0236b9529a0daab5b8b36fa939f4162f28201f1bf8731dbf'
const composePath = join(directory, 'compose-private.json')
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]
const action = process.argv[2]
assert(['prepare', 'verify', 'activate', 'rollback', 'status'].includes(action))

function command(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 << 20 })
  assert(!r.error && r.status === 0, `Release ${cmd.split('/').at(-1)} ${args[0]} failed; sensitive details suppressed`)
  return r.stdout.trim()
}
const docker = (args, input) => command('docker', args, input)
const inspect = target => JSON.parse(docker(['inspect', target]))[0]
const service = name => docker([...compose, 'ps', '--all', '--quiet', name])
const serve = () => JSON.parse(command(tailscale, ['serve', 'status', '--json']))
function checkPrevious() {
  const previous = inspect(previousId)
  assert.equal(previous.Image, previousImage)
  for (const container of [previous, inspect('sub2api')]) {
    assert.equal(container.State.Running, true)
    assert.equal(container.State.Health.Status, 'healthy')
    assert.equal(container.RestartCount, 0)
  }
  return previous
}
const environment = container => Object.fromEntries(container.Config.Env.map(item => {
  const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]
}))
async function save(state) {
  await writeFile(`${statePath}.pending`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(`${statePath}.pending`, statePath)
}
async function health(base) {
  const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).status, 'ok')
}
async function admin(base, path) {
  const env = environment(checkPrevious())
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(5000) })
  assert.equal(login.status, 200, 'Existing administrator must authenticate; sensitive details suppressed')
  const token = (await login.json()).data.access_token
  const r = await fetch(`${base}/api/v1/admin/system/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(r.status, 200)
  return (await r.json()).data
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
  await writeFile(join(ingressDirectory, 'active.map.pending'), `active ${slot}\n`, { mode: 0o600 })
  await rename(join(ingressDirectory, 'active.map.pending'), join(ingressDirectory, 'active.map'))
  const r = await fetch(`${ingressBase}/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-sub2api-slot'), slot)
}
async function verifyAssets() {
  const paths = (await readFile(join(ingressDirectory, 'old-assets.map'), 'utf8')).trim().split('\n').map(line => line.split(' ')[0])
  let checked = 0
  for (const path of paths) {
    const responses = await Promise.all([previousBase, ingressBase].map(base => fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })))
    const bodies = []
    for (const r of responses) {
      assert.equal(r.status, 200)
      assert(!r.headers.get('content-type')?.includes('text/html'))
      const body = Buffer.from(await r.arrayBuffer())
      assert(body.length <= 8 << 20)
      bodies.push(createHash('sha256').update(body).digest('hex'))
    }
    assert.equal(bodies[0], bodies[1], 'Old asset contents changed through the new entry')
    checked++
  }
  return { checked, identical: true }
}

await mkdir(deployment, { recursive: true, mode: 0o700 })
const lockPath = join(deployment, '.release-operation.lock')
const lock = await open(lockPath, 'wx', 0o600)
await lock.writeFile(JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() }))
let state
try {
  const previous = checkPrevious()
  if (action === 'prepare') {
    assert(process.argv[3] && process.argv[4] && process.argv[5] && process.argv[6],
      'prepare requires manifest, fresh backup, asset drill report and restore drill report paths')
    const manifest = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'))
    assert.equal(manifest.version, '0.2.13')
    assert.equal(manifest.upstreamCommit, '3040209f205472038c1ba745a1bedd2edd9053b1')
    const image = inspect(manifest.imageId)
    assert.equal(image.Config.Labels['org.opencontainers.image.revision'], manifest.commit)
    assert.equal(image.Config.Labels['org.opencontainers.image.version'], manifest.version)
    assert.equal(`${image.Os}/${image.Architecture}`, 'linux/arm64')
    const backup = resolve(process.argv[4])
    assert.match(backup, /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/)
    const record = JSON.parse(await readFile(join(backup, 'backup-manifest.json'), 'utf8'))
    assert.equal(record.oldContainerId, previousId)
    assert.equal(record.oldImageId, previousImage)
    assert(Date.now() - Date.parse(record.finished) < 30 * 60_000)
    for (const file of record.archives) {
      assert(['postgres.dump', 'redis.rdb', 'app-data.tar.gz'].includes(file.name))
      assert.equal(createHash('sha256').update(await readFile(join(backup, file.name))).digest('hex'), file.sha256)
    }
    const assetPath = resolve(process.argv[5])
    const assets = JSON.parse(await readFile(assetPath, 'utf8'))
    const restore = JSON.parse(await readFile(resolve(process.argv[6]), 'utf8'))
    for (const report of [assets, restore]) {
      assert.equal(report.passed, true)
      assert.equal(report.candidateCommit, manifest.commit)
      assert.equal(report.candidateImageId, manifest.imageId)
      assert.equal(report.oldImageId, previousImage)
    }
    assert.equal(restore.backup, backup)
    const jobs = JSON.parse(docker(['exec', '-i', 'sub2api-postgres', 'sh', '-c',
      'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'],
    `BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; ${await readFile(join(root, 'deploy/local-upgrade/compatibility-inventory.sql'), 'utf8')} ROLLBACK;`))
    assert.equal(jobs.enabledScheduledTests, 0)
    assert.equal(jobs.enabledChannelMonitors, 0)
    assert.equal(jobs.backupScheduleEnabled, false)
    assert.equal(jobs.activeBackupOperations, 0)
    assert.equal((await admin(previousBase, 'version')).version, previousVersion)
    const tailscaleBefore = serve()
    assert.equal(tailscaleBefore.Web[handlerKey].Handlers['/'].Proxy, previousBase)
    assert.equal(tailscaleBefore.Web[secondaryKey].Handlers['/'].Proxy, 'http://127.0.0.1:7777')
    const oldMaps = [await readFile(join(previousDirectory, 'ingress/old-assets.map'), 'utf8'),
      await readFile(join(dirname(assetPath), 'old-assets.map'), 'utf8')]
    const lines = [...new Set(oldMaps.join('\n').trim().split('\n').filter(Boolean))].sort()
    assert(lines.length > 150 && lines.length < 1000)
    assert(lines.every(line => /^\/assets\/[a-zA-Z0-9_./-]+\.(js|css) legacy_assets$/.test(line)))
    await mkdir(directory, { mode: 0o700 })
    await mkdir(ingressDirectory, { mode: 0o700 })
    await writeFile(join(ingressDirectory, 'active.map'), 'active blue\n', { flag: 'wx', mode: 0o600 })
    await writeFile(join(ingressDirectory, 'old-assets.map'), `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
    await copyFile(join(root, 'deploy/local-upgrade/haproxy-legacy-assets.cfg'), join(ingressDirectory, 'haproxy.cfg'))
    const env = environment(previous)
    assert(env.JWT_SECRET && /^[0-9a-fA-F]{64}$/.test(env.TOTP_ENCRYPTION_KEY))
    const logging = { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } }
    const config = { services: {
      green: { image: manifest.imageId, pull_policy: 'never', container_name: 'sub2api-green-v0213',
        restart: 'unless-stopped', cpus: 1, mem_limit: '768m',
        environment: { ...env, AUTO_SETUP: 'false', TOKEN_REFRESH_ENABLED: 'false', USAGE_CLEANUP_ENABLED: 'false',
          CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1', GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT: 'true',
          DATABASE_MAX_OPEN_CONNS: '20', DATABASE_MAX_IDLE_CONNS: '5', REDIS_POOL_SIZE: '64', REDIS_MIN_IDLE_CONNS: '2',
          GOMAXPROCS: '2', GOMEMLIMIT: '512MiB', LOG_LEVEL: 'warn', LOG_OUTPUT_TO_FILE: 'false',
          SERVER_TRUSTED_PROXIES: '172.19.0.0/16' }, security_opt: ['no-new-privileges:true'],
        volumes: ['green-data:/app/data'], ports: ['127.0.0.1:18482:8080'], networks: ['production'], logging },
      ingress: { image: proxyImage, pull_policy: 'never', restart: 'unless-stopped',
        cpus: 0.25, mem_limit: '128m', ports: ['127.0.0.1:18480:8080'], networks: ['production'], logging,
        environment: { SUB2API_BLUE_UPSTREAM: 'sub2api-release-clash2-ingress-1:8080',
          SUB2API_GREEN_UPSTREAM: 'sub2api-green-v0213:8080', SUB2API_LEGACY_ASSETS_UPSTREAM: 'sub2api-release-clash2-ingress-1:8080' },
        volumes: [`${join(ingressDirectory, 'haproxy.cfg')}:/usr/local/etc/haproxy/haproxy.cfg:ro`,
          `${ingressDirectory}:/var/lib/sub2api-ingress:ro`] }
    }, networks: { production: { external: true, name: 'sub2api_sub2api-network' } }, volumes: { 'green-data': {} } }
    await writeFile(composePath, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
    state = { phase: 'preparing', activeSlot: 'blue', version: manifest.version, candidateCommit: manifest.commit,
      candidateImageId: manifest.imageId, previousId, previousImage, previousVersion, backup,
      assetReport: assetPath, restoreReport: resolve(process.argv[6]), tailscaleBefore,
      previousStartedAt: previous.State.StartedAt, backgroundOwner: 'sub2api' }
    await save(state)
    docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '120'])
    docker(['exec', service('ingress'), 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
    const deadline = Date.now() + 90_000
    while (true) {
      try { await health(greenBase); break } catch { assert(Date.now() < deadline, 'Candidate startup failed; old entry unchanged'); await delay(1000) }
    }
    state.phase = 'prepared-awaiting-real-call'
    state.preparedAt = new Date().toISOString()
    await save(state)
  } else {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(inspect(service('green')).Image, state.candidateImageId)
    if (action === 'verify') {
      assert(['prepared-awaiting-real-call', 'verified-ready-to-switch'].includes(state.phase))
      await health(greenBase)
      assert.equal((await admin(greenBase, 'version')).version, state.version)
      state.updateStatus = await admin(greenBase, 'check-updates?force=true')
      assert.equal(state.updateStatus.current_version, state.version)
      assert.equal(state.updateStatus.has_update, false)
      state.directGateway = await liveGateway(`${greenBase}/v1`)
      state.verifiedAt = new Date().toISOString()
      state.phase = 'verified-ready-to-switch'
      await save(state)
    } else if (action === 'activate') {
      assert.equal(state.phase, 'verified-ready-to-switch')
      assert(state.directGateway?.completed && Date.now() - Date.parse(state.verifiedAt) < 10 * 60_000)
      await health(greenBase)
      assert.deepEqual(serve(), state.tailscaleBefore, 'Entry changed since prepare')
      state.phase = 'activating'
      await save(state)
      try {
        await setSlot('green')
        state.assets = await verifyAssets()
        command(tailscale, ['serve', '--bg', '--yes', '--https=443', ingressBase])
        assert.equal(serve().Web[handlerKey].Handlers['/'].Proxy, ingressBase)
        assert.deepEqual(serve().Web[secondaryKey], state.tailscaleBefore.Web[secondaryKey])
        state.entryGateway = await liveGateway(currentCodex().baseUrl, 'green')
        assert.equal((await admin(publicBase, 'version')).version, state.version)
        state.activeSlot = 'green'
        state.phase = 'active-previous-retained'
        state.activatedAt = new Date().toISOString()
        await save(state)
      } catch (error) {
        const recovery = { entryRestored: false, proxyRestored: false }
        try {
          command(tailscale, ['serve', '--bg', '--yes', '--https=443', previousBase])
          assert.equal(serve().Web[handlerKey].Handlers['/'].Proxy, previousBase)
          await health(publicBase); recovery.entryRestored = true
        } catch { /* Still recover the candidate proxy independently. */ }
        try { await setSlot('blue'); recovery.proxyRestored = true } catch { /* Record recovery status. */ }
        state.recovery = recovery
        state.activeSlot = recovery.proxyRestored ? 'blue' : 'unknown'
        state.phase = recovery.entryRestored && recovery.proxyRestored ? 'activation-failed-previous-restored' : 'recovery-required'
        await save(state)
        throw error
      }
    } else if (action === 'rollback') {
      await health(previousBase)
      assert.equal((await admin(previousBase, 'version')).version, previousVersion)
      state.rollbackGateway = await liveGateway(`${previousBase}/v1`, 'green')
      command(tailscale, ['serve', '--bg', '--yes', '--https=443', previousBase])
      await setSlot('blue')
      await health(publicBase)
      state.activeSlot = 'blue'
      state.phase = 'rolled-back-new-retained'
      state.rolledBackAt = new Date().toISOString()
      await save(state)
    }
  }
  assert.equal(checkPrevious().State.StartedAt, state.previousStartedAt)
  assert(runtime('show map /var/lib/sub2api-ingress/active.map').includes(`active ${state.activeSlot}`))
  assert.equal((await readFile(join(ingressDirectory, 'active.map'), 'utf8')).trim(), `active ${state.activeSlot}`)
  const tailnetTarget = serve().Web[handlerKey].Handlers['/'].Proxy
  assert.equal(tailnetTarget, state.activeSlot === 'green' ? ingressBase : previousBase)
  assert.deepEqual(serve().Web[secondaryKey], state.tailscaleBefore.Web[secondaryKey])
  const servingVersion = (await admin(publicBase, 'version')).version
  assert.equal(servingVersion, state.activeSlot === 'green' ? state.version : previousVersion)
  console.log(JSON.stringify({ phase: state.phase, version: state.version, candidateCommit: state.candidateCommit,
    candidateImageId: state.candidateImageId, activeSlot: state.activeSlot, tailnetTarget, servingVersion,
    stableLocalEntry: ingressBase, previousEntry: previousBase, runtimeAndPersistedRouteAgree: true,
    updateAvailable: state.updateStatus?.has_update, directGateway: state.directGateway, entryGateway: state.entryGateway,
    assets: state.assets, previousRetained: true, backgroundOwner: state.backgroundOwner }, null, 2))
} finally {
  await lock.close()
  await unlink(lockPath)
}
