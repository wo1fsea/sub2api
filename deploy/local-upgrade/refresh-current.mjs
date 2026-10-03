import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { currentCodex, liveGateway } from './live-gateway.mjs'
import { refreshConfig, refreshAssets } from './refresh-routing.mjs'

// First frontend-only refresh of v0.2.13. Pin the observed deployment, rather
// than guessing which container is safe to change on a later release.
process.umask(0o077)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const deployment = '/Users/clawbotbot/Projects/sub2api-local'
const directory = join(deployment, 'releases/hatches-0.2.13')
const ingressDirectory = join(deployment, 'releases/v0.2.13/ingress')
const statePath = join(directory, 'state.json')
const composePath = join(directory, 'compose-private.json')
const project = 'sub2api-release-hatches'
const previousId = '055da4e89b9a4427ece4509085bd13ac05e51ca3196796022d9ffc83f0a3c5db'
const previousImage = 'sha256:145ba95c309d12c854d802075272c3358f125a0b8f11ef9bcf248f49a7c07e6c'
const ingressId = '22ce08fc311bba07de9b4ea1bf3cd48c13ec5af85b9f84b15d3031c4876a8870'
const candidateName = 'sub2api-blue-hatches'
const previousBase = 'http://127.0.0.1:18482'
const candidateBase = 'http://127.0.0.1:18582'
const ingressBase = 'http://127.0.0.1:18480'
const publicBase = 'https://openclaw-macmini-ts.tailff52e6.ts.net'
const tailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const handlerKey = 'openclaw-macmini-ts.tailff52e6.ts.net:443'
const secondaryKey = 'openclaw-macmini-ts.tailff52e6.ts.net:8443'
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]
const action = process.argv[2]
assert(['prepare', 'verify', 'activate', 'rollback', 'status'].includes(action))
function command(cmd, args, input) {
  const result = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 150_000, maxBuffer: 4 << 20 })
  assert(!result.error && result.status === 0, `${cmd.split('/').at(-1)} ${args[0]} failed; sensitive details suppressed`)
  return result.stdout.trim()
}
const docker = (args, input) => command('docker', args, input)
const inspect = name => JSON.parse(docker(['inspect', name]))[0]
const serve = () => JSON.parse(command(tailscale, ['serve', 'status', '--json']))
const environment = container => Object.fromEntries(container.Config.Env.map(item => {
  const index = item.indexOf('='); return [item.slice(0, index), item.slice(index + 1)]
}))
function checkPrevious() {
  const previous = inspect(previousId)
  assert.equal(previous.Image, previousImage)
  for (const container of [previous, inspect('sub2api')]) {
    assert.equal(container.State.Running, true)
    assert.equal(container.State.Health.Status, 'healthy')
    assert.equal(container.RestartCount, 0)
  }
  assert.equal(inspect(ingressId).State.Running, true)
  return previous
}
async function save(state) {
  await writeFile(`${statePath}.pending`, JSON.stringify(state, null, 2), { mode: 0o600 })
  await rename(`${statePath}.pending`, statePath)
}
async function health(base, slot) {
  const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).status, 'ok')
  if (slot) assert.equal(r.headers.get('x-sub2api-slot'), slot)
}
async function ready(base, slot, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (true) {
    try { await health(base, slot); return } catch { assert(Date.now() < deadline, 'Healthy serving route did not appear'); await delay(500) }
  }
}
async function admin(base, path) {
  const env = environment(checkPrevious())
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(5000) })
  assert.equal(login.status, 200, 'Existing admin must authenticate; sensitive details suppressed')
  const token = (await login.json()).data.access_token
  const r = await fetch(`${base}/api/v1/admin/system/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(r.status, 200)
  return (await r.json()).data
}
const runtime = text => docker(['exec', '-i', ingressId, 'sh', '-c', 'nc -w 1 127.0.0.1 9999'], `${text}\n`)
async function setSlot(slot) {
  assert(['blue', 'green'].includes(slot))
  assert.equal(runtime(`set map /var/lib/sub2api-ingress/active.map active ${slot}`), '')
  assert(runtime('show map /var/lib/sub2api-ingress/active.map').includes(`active ${slot}`))
  await writeFile(join(ingressDirectory, 'active.map.pending'), `active ${slot}\n`, { mode: 0o600 })
  await rename(join(ingressDirectory, 'active.map.pending'), join(ingressDirectory, 'active.map'))
  await ready(ingressBase, slot)
}
async function installRouting(config, map) {
  assert(runtime('show map /var/lib/sub2api-ingress/active.map').includes('active green'))
  assert.equal((await readFile(join(ingressDirectory, 'active.map'), 'utf8')).trim(), 'active green')
  // Keep the config's inode: it is also mounted as a read-only single-file bind.
  await writeFile(join(ingressDirectory, 'old-assets.map'), map, { mode: 0o600 })
  await writeFile(join(ingressDirectory, 'haproxy.cfg'), config, { mode: 0o600 })
  assert.equal(docker(['exec', ingressId, 'cat', '/usr/local/etc/haproxy/haproxy.cfg']), config.trim())
  docker(['exec', ingressId, 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  docker(['kill', '--signal=USR2', ingressId])
  // HAProxy's master reload preserves listeners and in-flight old workers.
  await delay(1500)
  await ready(ingressBase, 'green')
}
async function verifyAssets() {
  const paths = (await readFile(join(ingressDirectory, 'old-assets.map'), 'utf8')).trim().split('\n')
  for (const line of paths) {
    const [path, backend] = line.split(' ')
    assert(['previous_assets', 'legacy_assets'].includes(backend))
    const base = backend === 'previous_assets' ? previousBase : 'http://127.0.0.1:18380'
    const bodies = await Promise.all([base, ingressBase].map(async source => {
      const r = await fetch(`${source}${path}`, { signal: AbortSignal.timeout(5000) })
      assert.equal(r.status, 200)
      assert(!r.headers.get('content-type')?.includes('text/html'))
      const body = Buffer.from(await r.arrayBuffer())
      assert(body.length <= 8 << 20)
      return createHash('sha256').update(body).digest('hex')
    }))
    assert.equal(bodies[0], bodies[1], 'Historical chunk changed through the entry')
  }
  return { checked: paths.length, identical: true }
}

const lockPath = join(deployment, '.release-operation.lock')
const lock = await open(lockPath, 'wx', 0o600)
await lock.writeFile(JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() }))
let state
try {
  const previous = checkPrevious()
  if (action === 'prepare') {
    assert(process.argv.slice(3).length === 5, 'Pass MANIFEST BACKUP ASSET_REPORT RESTORE_REPORT PROXY_REPORT')
    const [manifestPath, backup, assetPath, restorePath, proxyPath] = process.argv.slice(3).map(path => resolve(path))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.version, '0.2.13')
    assert.equal(manifest.upstreamCommit, '3040209f205472038c1ba745a1bedd2edd9053b1')
    assert.equal(manifest.sourceValidation.backendTree, 'ce88118a2e6bc792697f2e438ebde6a6819381e0', 'This refresh may change only the qualified frontend')
    assert.notEqual(manifest.imageId, previousImage)
    const image = inspect(manifest.imageId)
    assert.equal(image.Config.Labels['org.opencontainers.image.revision'], manifest.commit)
    assert.equal(image.Config.Labels['org.opencontainers.image.version'], manifest.version)
    assert.equal(`${image.Os}/${image.Architecture}`, 'linux/arm64')
    assert.match(backup, /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/)
    const record = JSON.parse(await readFile(join(backup, 'backup-manifest.json'), 'utf8'))
    assert.equal(record.oldContainerId, previousId)
    assert.equal(record.oldImageId, previousImage)
    assert(Date.now() - Date.parse(record.finished) < 30 * 60_000)
    for (const file of record.archives) {
      assert(['postgres.dump', 'redis.rdb', 'app-data.tar.gz'].includes(file.name))
      assert.equal(createHash('sha256').update(await readFile(join(backup, file.name))).digest('hex'), file.sha256)
    }
    const assets = JSON.parse(await readFile(assetPath, 'utf8'))
    const restore = JSON.parse(await readFile(restorePath, 'utf8'))
    for (const report of [assets, restore]) {
      assert.equal(report.passed, true)
      assert.equal(report.candidateCommit, manifest.commit)
      assert.equal(report.candidateImageId, manifest.imageId)
      assert.equal(report.oldImageId, previousImage)
    }
    assert.equal(restore.backup, backup)
    assert.equal(JSON.parse(await readFile(proxyPath, 'utf8')).passed, true)
    const jobs = JSON.parse(docker(['exec', '-i', 'sub2api-postgres', 'sh', '-c',
      'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'],
    `BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; ${await readFile(join(root, 'deploy/local-upgrade/compatibility-inventory.sql'), 'utf8')} ROLLBACK;`))
    assert.equal(jobs.enabledScheduledTests, 0)
    assert.equal(jobs.enabledChannelMonitors, 0)
    assert.equal(jobs.backupScheduleEnabled, false)
    assert.equal(jobs.activeBackupOperations, 0)
    assert.equal((await admin(previousBase, 'version')).version, '0.2.13')
    const tailscaleBefore = serve()
    assert.equal(tailscaleBefore.Web[handlerKey].Handlers['/'].Proxy, ingressBase)
    assert.equal(tailscaleBefore.Web[secondaryKey].Handlers['/'].Proxy, 'http://127.0.0.1:7777')
    await health(publicBase, 'green')
    let existing
    try { existing = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing) {
      assert.equal(existing.phase, 'preparing')
      assert.equal(existing.candidateImageId, manifest.imageId)
      assert.equal(existing.backup, backup)
    } else {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(join(directory, 'haproxy-before.cfg'), await readFile(join(ingressDirectory, 'haproxy.cfg')), { flag: 'wx', mode: 0o600 })
      await writeFile(join(directory, 'assets-before.map'), await readFile(join(ingressDirectory, 'old-assets.map')), { flag: 'wx', mode: 0o600 })
    }
    const env = environment(previous)
    assert(env.JWT_SECRET && /^[0-9a-fA-F]{64}$/.test(env.TOTP_ENCRYPTION_KEY))
    const config = { services: { candidate: {
      image: manifest.imageId, pull_policy: 'never', container_name: candidateName, restart: 'unless-stopped',
      cpus: 1, mem_limit: '768m', environment: { ...env, AUTO_SETUP: 'false', TOKEN_REFRESH_ENABLED: 'false',
        USAGE_CLEANUP_ENABLED: 'false', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1', GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT: 'true',
        LOG_OUTPUT_TO_FILE: 'false', LOG_LEVEL: 'warn', GOMAXPROCS: '2', GOMEMLIMIT: '512MiB' },
      security_opt: ['no-new-privileges:true'], ports: ['127.0.0.1:18582:8080'], volumes: ['candidate-data:/app/data'],
      networks: ['production'], logging: { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } }
    } }, networks: { production: { external: true, name: 'sub2api_sub2api-network' } }, volumes: { 'candidate-data': {} } }
    if (existing) assert.equal(await readFile(composePath, 'utf8'), JSON.stringify(config))
    else await writeFile(composePath, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
    state = existing || { phase: 'preparing', activeSlot: 'green', candidateCommit: manifest.commit, candidateImageId: manifest.imageId,
      version: manifest.version, previousId, previousImage, previousStartedAt: previous.State.StartedAt,
      ingressId, ingressStartedAt: inspect(ingressId).State.StartedAt, tailscaleBefore, backup, assetPath, restorePath, proxyPath,
      backgroundOwner: 'sub2api' }
    await save(state)
    docker([...compose, 'create', 'candidate'])
    assert.equal(inspect(candidateName).Image, manifest.imageId)
    if (!state.volumeInitialized) {
      assert.equal(inspect(candidateName).State.Running, false, 'Do not overwrite a running or installed candidate')
      const volume = `${project}_candidate-data`
      assert.equal(inspect(volume).Labels['com.docker.compose.project'], project)
      docker(['run', '--rm', '--name', `${project}-initialize`, '--network', 'none', '--entrypoint', 'sh', '--log-driver', 'none',
        '--cpus', '0.25', '--memory', '128m', '--mount', `type=volume,source=${volume},target=/restore`,
        '--mount', `type=bind,source=${backup},target=/backup,readonly`, manifest.imageId, '-ec',
        'tar -xzf /backup/app-data.tar.gz -C /restore; chown -R 1000:1000 /restore'])
      state.volumeInitialized = true
      await save(state)
    }
    docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '120'])
    await ready(candidateBase, undefined, 90_000)
    state.phase = 'prepared-awaiting-real-call'
    await save(state)
  } else {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(inspect(candidateName).Image, state.candidateImageId)
    if (action === 'verify') {
      assert(['prepared-awaiting-real-call', 'installing-inactive-backend', 'routing-installed-awaiting-asset-check',
        'verification-failed-previous-restored', 'activation-failed-previous-restored',
        'rolled-back-new-retained', 'verified-ready-to-switch'].includes(state.phase))
      assert.equal(state.activeSlot, 'green', 'Restore the previous route before repeating verification')
      await health(candidateBase)
      assert.equal((await admin(candidateBase, 'version')).version, state.version)
      state.updateStatus = await admin(candidateBase, 'check-updates?force=true')
      assert.equal(state.updateStatus.current_version, state.version)
      state.directGateway = await liveGateway(`${candidateBase}/v1`)
      if (!state.routingInstalled) {
        const config = refreshConfig(await readFile(join(directory, 'haproxy-before.cfg'), 'utf8'), `${candidateName}:8080`, 'sub2api-green-v0213:8080')
        const map = refreshAssets(await readFile(join(directory, 'assets-before.map'), 'utf8'), await readFile(join(dirname(state.assetPath), 'old-assets.map'), 'utf8'))
        state.phase = 'installing-inactive-backend'
        await save(state)
        try {
          await installRouting(config, map)
          assert.equal((await fetch(`${publicBase}/health`)).headers.get('x-sub2api-slot'), 'green')
          state.routingInstalled = true
          state.phase = 'routing-installed-awaiting-asset-check'
          await save(state)
        } catch (error) {
          await installRouting(await readFile(join(directory, 'haproxy-before.cfg'), 'utf8'), await readFile(join(directory, 'assets-before.map'), 'utf8'))
          state.routingInstalled = false
          state.phase = 'verification-failed-previous-restored'
          await save(state)
          throw error
        }
      }
      state.assets = await verifyAssets()
      state.verifiedAt = new Date().toISOString()
      state.phase = 'verified-ready-to-switch'
      await save(state)
    } else if (action === 'activate') {
      assert.equal(state.phase, 'verified-ready-to-switch')
      assert(state.directGateway?.completed && Date.now() - Date.parse(state.verifiedAt) < 10 * 60_000)
      await health(candidateBase)
      assert.deepEqual(serve(), state.tailscaleBefore)
      state.phase = 'activating'
      await save(state)
      try {
        await setSlot('blue')
        state.entryGateway = await liveGateway(currentCodex().baseUrl, 'blue')
        assert.equal((await admin(publicBase, 'version')).version, state.version)
        state.assets = await verifyAssets()
        state.phase = 'active-previous-retained'
        state.activeSlot = 'blue'
        state.activatedAt = new Date().toISOString()
        await save(state)
      } catch (error) {
        await setSlot('green')
        state.activeSlot = 'green'
        state.phase = 'activation-failed-previous-restored'
        await save(state)
        throw error
      }
    } else if (action === 'rollback') {
      assert(state.routingInstalled)
      await health(previousBase)
      state.rollbackGateway = await liveGateway(`${previousBase}/v1`)
      await setSlot('green')
      await health(publicBase, 'green')
      state.activeSlot = 'green'
      state.phase = 'rolled-back-new-retained'
      await save(state)
    }
  }
  assert.equal(checkPrevious().State.StartedAt, state.previousStartedAt)
  assert.equal(inspect(ingressId).State.StartedAt, state.ingressStartedAt)
  assert.equal(inspect(ingressId).RestartCount, 0)
  assert.deepEqual(serve(), state.tailscaleBefore, 'The public entry or secondary service changed')
  assert(runtime('show map /var/lib/sub2api-ingress/active.map').includes(`active ${state.activeSlot}`))
  assert.equal((await readFile(join(ingressDirectory, 'active.map'), 'utf8')).trim(), `active ${state.activeSlot}`)
  await health(publicBase, state.activeSlot)
  console.log(JSON.stringify({ phase: state.phase, version: state.version, candidateCommit: state.candidateCommit,
    candidateImageId: state.candidateImageId, activeSlot: state.activeSlot, tailnetTarget: ingressBase,
    ingressContainerUnchanged: true, runtimeAndPersistedRouteAgree: true, previousRetained: true,
    backgroundOwner: state.backgroundOwner, directGateway: state.directGateway, entryGateway: state.entryGateway,
    assets: state.assets, updateAvailable: state.updateStatus?.has_update }, null, 2))
} catch (error) {
  if (state) { state.lastOperationFailed = { action, at: new Date().toISOString(), sensitiveDetailsSuppressed: true }; await save(state) }
  throw error
} finally {
  await lock.close()
  await unlink(lockPath)
}
