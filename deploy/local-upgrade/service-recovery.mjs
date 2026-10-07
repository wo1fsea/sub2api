import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { liveGateway } from './live-gateway.mjs'

process.umask(0o077)
export const deployment = '/Users/clawbotbot/Projects/sub2api-local'
export const directory = join(deployment, 'current-0.2.13')
const composePath = join(directory, 'compose-private.json')
const statePath = join(directory, 'state.json')
const project = 'sub2api-current'
export const image = 'sha256:84a75cafee9d37d19df5de7f50924cacdf68ffd7c925485be421b496325979ea'
const proxyImage = 'sha256:8007effce89a08af0236b9529a0daab5b8b36fa939f4162f28201f1bf8731dbf'
const caddyImage = 'sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e'
export const names = { app: 'sub2api-current-app', ingress: 'sub2api-current-ingress', assets: 'sub2api-current-assets', compat: 'sub2api-current-compat' }
export const retired = ['sub2api', 'sub2api-green-clash2', 'sub2api-green-v0213', 'sub2api-blue-hatches',
  'sub2api-release-clash2-ingress-1', 'sub2api-release-clash2-legacy-1', 'sub2api-release-v0213-ingress-1']
const tailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const host = 'openclaw-macmini-ts.tailff52e6.ts.net'
const publicBase = `https://${host}`
const entry = 'http://127.0.0.1:18480'
const direct = 'http://127.0.0.1:18583'
const temporary = 'http://127.0.0.1:18582'
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]

function command(binary, args, input, timeout = 60_000) {
  const r = spawnSync(binary, args, { input, encoding: 'utf8', timeout, maxBuffer: 64 << 20 })
  assert(!r.error && r.status === 0, `${binary.split('/').at(-1)} ${args[0]} failed; sensitive details suppressed`)
  return r.stdout.trim()
}
const docker = (args, input) => command('/opt/homebrew/bin/docker', args, input)
const inspect = name => JSON.parse(docker(['inspect', name]))[0]
function optionalRetired() {
  const existing = new Set(docker(['ps', '-a', '--format', '{{.Names}}']).split('\n'))
  return retired.map(name => ({ name, container: existing.has(name) ? inspect(name) : undefined }))
}
export function retiredStatus(name, container) {
  if (!container) return { name, present: false, running: false }
  assert.equal(container.State.Running, false, 'A retired application was unexpectedly started')
  return { name, present: true, running: false, health: container.State.Health?.Status, restart: container.HostConfig.RestartPolicy.Name }
}
const environment = container => Object.fromEntries(container.Config.Env.map(item => {
  const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]
}))
// The macOS app's CLI uses GUI bootstrap IPC, including when invoked by launchd.
const tailscaleCommand = args => command('/bin/launchctl', ['asuser', '501', tailscale, ...args])
const serve = () => {
  const result = tailscaleCommand(['serve', 'status', '--json'])
  assert(result.startsWith('{'), `Tailscale control plane unavailable: ${result.slice(0, 300)}`)
  return JSON.parse(result)
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function save(path, value) {
  await writeFile(`${path}.pending`, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(`${path}.pending`, path)
}

export async function acquireLock(path) {
  try { return await open(path, 'wx', 0o600) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const before = await stat(path)
    assert(before.size <= 4096, 'Unexpected recovery lock')
    const record = JSON.parse(await readFile(path, 'utf8'))
    assert(Number.isInteger(record.pid) && record.pid > 0, 'Unexpected recovery lock owner')
    const owner = spawnSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 })
    assert(!owner.error, 'Cannot inspect recovery lock owner')
    assert(!(owner.status === 0 && owner.stdout.includes('local-upgrade/')), 'A release operation is already running')
    const after = await stat(path)
    assert(before.ino === after.ino && before.mtimeMs === after.mtimeMs, 'Recovery lock changed during inspection')
    await unlink(path)
    return open(path, 'wx', 0o600)
  }
}

export function roleEnvironment(seed) {
  return { ...seed, AUTO_SETUP: 'false', TOKEN_REFRESH_ENABLED: 'true', USAGE_CLEANUP_ENABLED: 'true',
    CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '0', GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT: 'false',
    LOG_LEVEL: 'info', LOG_OUTPUT_TO_FILE: 'false' }
}

export function routing(upstream) {
  assert(/^[a-z0-9-]+:8080$/.test(upstream), 'Invalid pinned upstream')
  return `global
    log stdout format raw local0
    stats socket ipv4@127.0.0.1:9999 level admin
defaults
    mode http
    log global
    timeout connect 5s
    timeout client 10m
    timeout server 10m
    timeout tunnel 0
    retries 0
resolvers docker
    nameserver dns 127.0.0.11:53
    resolve_retries 3
    timeout resolve 1s
    timeout retry 1s
    hold valid 5s
frontend stable
    bind :8080
    acl asset_read method GET HEAD
    acl historical_asset path,map_str(/var/lib/sub2api-ingress/old-assets.map) -m found
    use_backend historical_assets if asset_read historical_asset
    default_backend blue
backend blue
    option httpchk GET /health
    http-response set-header X-Sub2API-Slot blue
    server current ${upstream} check resolvers docker init-addr last,libc,none
backend historical_assets
    http-response set-header X-Sub2API-Slot historical-assets
    server assets ${names.assets}:8080 check resolvers docker init-addr last,libc,none
`
}

export function desiredCompose(seed) {
  const logging = { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } }
  const common = { pull_policy: 'never', restart: 'always', logging, security_opt: ['no-new-privileges:true'] }
  const caddy = config => ({ ...common, image: caddyImage, user: '1000:1000', read_only: true,
    cpus: 0.25, mem_limit: '96m', tmpfs: ['/data:uid=1000,gid=1000,size=4m', '/config:uid=1000,gid=1000,size=4m'],
    volumes: [`${join(directory, config)}:/etc/caddy/Caddyfile:ro`] })
  const assets = caddy('assets.Caddyfile')
  assets.volumes.push(`${join(directory, 'static')}:/srv:ro`)
  return { services: {
    app: { ...common, image, container_name: names.app, cpus: 1, mem_limit: '768m', environment: roleEnvironment(seed),
      ports: ['127.0.0.1:18583:8080'], volumes: ['current-data:/app/data'], networks: ['production'] },
    ingress: { ...common, image: proxyImage, container_name: names.ingress, cpus: 0.25, mem_limit: '128m',
      command: ['haproxy', '-W', '-db', '-f', '/usr/local/etc/haproxy/haproxy.cfg'],
      ports: ['127.0.0.1:18480:8080'], networks: ['production', 'assets'],
      volumes: [`${join(directory, 'haproxy.cfg')}:/usr/local/etc/haproxy/haproxy.cfg:ro`, `${directory}:/var/lib/sub2api-ingress:ro`] },
    assets: { ...assets, container_name: names.assets, networks: ['assets'] },
    compat: { ...caddy('compat.Caddyfile'), container_name: names.compat, ports: ['127.0.0.1:18080:8080'], networks: ['production'] }
  }, networks: { production: { external: true, name: 'sub2api_sub2api-network' }, assets: { internal: true } }, volumes: { 'current-data': {} } }
}

export function assertCurrent(container) {
  assert.equal(container.Image, image, 'The current application image changed')
  assert.equal(container.Config.Labels['com.docker.compose.project'], project)
  const env = environment(container)
  assert.equal(env.TOKEN_REFRESH_ENABLED, 'true')
  assert.equal(env.USAGE_CLEANUP_ENABLED, 'true')
  assert.equal(env.CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR, '0')
  assert.equal(env.GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT, 'false')
}

export function assertVersion(payload) {
  assert.equal(payload.data.version, '0.2.13', 'The authenticated application version changed')
}

async function health(base, slot) {
  const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).status, 'ok')
  if (slot) assert.equal(r.headers.get('x-sub2api-slot'), slot)
}
async function ready(base, slot, onRetry) {
  const deadline = Date.now() + 90_000
  while (true) {
    try { await health(base, slot); return } catch {
      assert(Date.now() < deadline, 'Pinned service did not become healthy')
      if (onRetry) await onRetry()
      await delay(1000)
    }
  }
}
async function adminVersion(base) {
  const env = environment(inspect(names.app))
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(10_000) })
  assert.equal(r.status, 200, 'Existing administrator login failed')
  const token = (await r.json()).data.access_token
  const version = await fetch(`${base}/api/v1/admin/system/version`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(version.status, 200)
  assertVersion(await version.json())
}
async function setEntry() {
  await ready(entry, 'blue')
  const before = serve()
  if (before.Web[`${host}:443`]?.Handlers['/']?.Proxy !== entry) {
    tailscaleCommand(['serve', '--bg', '--yes', '--https=443', entry])
  }
  const after = serve()
  assert.equal(after.Web[`${host}:443`].Handlers['/'].Proxy, entry)
  for (const key of Object.keys(before.Web).filter(key => key !== `${host}:443`)) assert.deepEqual(after.Web[key], before.Web[key])
}
async function reload(upstream) {
  // Preserve the inode of the mounted configuration across master-worker reloads.
  await writeFile(join(directory, 'haproxy.cfg'), routing(upstream), { mode: 0o600 })
  docker(['exec', names.ingress, 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  docker(['kill', '--signal=USR2', names.ingress])
  await delay(1500)
  await ready(entry, 'blue')
}

async function prepare(backup) {
  assert.match(backup || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/)
  const record = JSON.parse(await readFile(join(backup, 'backup-manifest.json'), 'utf8'))
  assert(Date.now() - Date.parse(record.finished) < 30 * 60_000, 'A fresh recovery backup is required')
  assert.equal(record.oldContainerId, inspect('sub2api').Id)
  for (const file of record.archives) assert.equal(sha(await readFile(join(backup, file.name))), file.sha256)
  assert.equal(inspect('sub2api-blue-hatches').Image, image)
  await health(temporary)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let prior
  try { prior = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (prior) {
    assert(['preparing', 'prepared'].includes(prior.phase), 'Do not replay prepare on an active deployment')
    assert.equal(prior.image, image)
    assert.equal(prior.backup, backup)
  }
  await save(statePath, { phase: 'preparing', image, backup })
  const containers = retired.map(inspect)
  const dependencies = ['sub2api-postgres', 'sub2api-redis'].map(inspect)
  await save(join(directory, 'recovery-private.json'), [...containers, ...dependencies])
  await mkdir(join(directory, 'static/assets'), { recursive: true, mode: 0o700 })
  const lines = (await readFile(join(deployment, 'releases/v0.2.13/ingress/old-assets.map'), 'utf8')).trim().split('\n')
  const assets = []
  let bytes = 0
  for (const line of lines) {
    const [path, backend] = line.split(' ')
    assert(/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path), 'Unexpected historical asset path')
    assert(['previous_assets', 'legacy_assets'].includes(backend))
    const base = backend === 'previous_assets' ? 'http://127.0.0.1:18482' : 'http://127.0.0.1:18380'
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(r.status, 200)
    assert(!r.headers.get('content-type')?.includes('text/html'))
    const body = Buffer.from(await r.arrayBuffer())
    bytes += body.length
    assert(bytes < 96 << 20, 'Historical resources exceeded the cache budget')
    await writeFile(join(directory, 'static', path.slice(1)), body, { mode: 0o600 })
    assets.push({ path, sha256: sha(body), bytes: body.length })
  }
  // The static server runs as UID 1000, so its secret-free files must be readable.
  command('/bin/chmod', ['-R', 'a+rX', join(directory, 'static')])
  await save(join(directory, 'assets.json'), assets)
  await writeFile(join(directory, 'old-assets.map'), assets.map(a => `${a.path} cached`).join('\n') + '\n', { mode: 0o600 })
  await writeFile(join(directory, 'haproxy.cfg'), routing('sub2api-blue-hatches:8080'), { mode: 0o600 })
  const header = '{\n admin off\n auto_https off\n}\n:8080 {\n'
  await writeFile(join(directory, 'assets.Caddyfile'), header + ' @assets path /assets/*\n handle @assets {\n  root * /srv\n  file_server\n }\n handle {\n  respond 404\n }\n}\n', { mode: 0o644 })
  await writeFile(join(directory, 'compat.Caddyfile'), header + ` reverse_proxy ${names.ingress}:8080\n}\n`, { mode: 0o644 })
  await save(composePath, desiredCompose(environment(inspect('sub2api-blue-hatches'))))
  docker([...compose, 'create', 'app'])
  assert.equal(inspect(names.app).State.Running, false, 'Never overwrite a running application volume')
  const archive = spawnSync('/opt/homebrew/bin/docker', ['exec', 'sub2api-blue-hatches', 'tar', '-c', '--exclude=./logs', '--exclude=./backups', '-C', '/app/data', '.'], { timeout: 30_000, maxBuffer: 64 << 20 })
  assert(!archive.error && archive.status === 0, 'Current application data archive failed')
  docker(['cp', '-', `${names.app}:/app/data`], archive.stdout)
  await save(statePath, { phase: 'prepared', preparedAt: new Date().toISOString(), backup, image,
    dependencies: dependencies.map(c => ({ name: c.Name.slice(1), image: c.Image })), assets: assets.length, bytes })
  docker([...compose, 'up', '-d', '--no-deps', 'assets', 'ingress'])
  await ready(entry, 'blue')
  for (const asset of assets) {
    const r = await fetch(`${entry}${asset.path}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(r.status, 200)
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), asset.sha256)
  }
  console.log(JSON.stringify({ phase: 'prepared', assets: assets.length, bytes, gateway: await liveGateway(`${entry}/v1`, 'blue', { timeoutMs: 45_000 }) }))
}

async function cutover() {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert(['prepared', 'handover-failed-latest-skin-retained'].includes(state.phase))
  assert.equal(inspect('sub2api').State.Running, true, 'The prior background owner must remain available until handover')
  assert.equal(inspect('sub2api-blue-hatches').Image, image)
  await liveGateway(`${entry}/v1`, 'blue', { timeoutMs: 45_000 })
  await setEntry()
  state.firstPublicProbe = await liveGateway(`${publicBase}/v1`, 'blue', { timeoutMs: 45_000 })
  state.phase = 'handover'
  await save(statePath, state)
  // The latest skin stays online while the former background owner is stopped.
  const old = retired.filter(name => name !== 'sub2api-blue-hatches')
  try {
    for (const name of old) docker(['update', '--restart=no', name])
    docker(['stop', '--time=45', ...old])
    docker([...compose, 'up', '-d', '--no-deps', 'app', 'compat'])
    await ready(direct)
    assertCurrent(inspect(names.app))
    await adminVersion(direct)
    state.directProbe = await liveGateway(`${direct}/v1`, null, { timeoutMs: 45_000 })
    await reload(`${names.app}:8080`)
    await setEntry()
    await adminVersion(publicBase)
    state.finalProbe = await liveGateway(`${publicBase}/v1`, 'blue', { timeoutMs: 45_000 })
    await health('http://127.0.0.1:18080', 'blue')
  } catch (error) {
    await reload('sub2api-blue-hatches:8080')
    docker(['stop', '--time=45', names.app, names.compat])
    docker(['start', 'sub2api'])
    state.phase = 'handover-failed-latest-skin-retained'
    await save(statePath, state)
    throw error
  }
  docker(['update', '--restart=no', 'sub2api-blue-hatches'])
  docker(['stop', '--time=45', 'sub2api-blue-hatches'])
  for (const name of retired) assert.equal(inspect(name).State.Running, false)
  state.phase = 'active-old-retired'
  state.activatedAt = new Date().toISOString()
  state.backgroundOwner = names.app
  state.entry = entry
  state.directCompatibility = 'http://127.0.0.1:18080'
  await save(statePath, state)
  console.log(JSON.stringify({ phase: state.phase, activatedAt: state.activatedAt, backgroundOwner: state.backgroundOwner, probe: state.finalProbe }))
}

async function boot(manageRoute = true) {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.phase, 'active-old-retired', 'Recovery is disabled until retirement finishes')
  const available = spawnSync('/opt/homebrew/bin/docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10_000 })
  if (available.status !== 0) command('/opt/homebrew/bin/colima', ['start'], undefined, 180_000)
  for (const { name, container } of optionalRetired()) retiredStatus(name, container)
  for (const dependency of state.dependencies) {
    const container = inspect(dependency.name)
    assert.equal(container.Image, dependency.image)
    if (!container.State.Running) docker(['start', dependency.name])
  }
  for (const [service, name] of Object.entries(names)) {
    const found = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])
    if (!found) docker([...compose, 'up', '-d', '--no-deps', service])
    else {
      const container = inspect(name)
      const desired = { app: image, ingress: proxyImage, assets: caddyImage, compat: caddyImage }
      assert.equal(container.Image, desired[service], 'Recovery will not replace an unexpected image')
      assert.equal(container.Config.Labels['com.docker.compose.project'], project)
      assert.equal(container.HostConfig.RestartPolicy.Name, 'always')
      if (service === 'app') assertCurrent(container)
      if (!container.State.Running) docker(['start', name])
    }
  }
  assertCurrent(inspect(names.app))
  assert.equal(await readFile(join(directory, 'haproxy.cfg'), 'utf8'), routing(`${names.app}:8080`))
  // A manual stop may finish after the initial inspection; retry only starts
  // this already-validated set rather than accepting a false healthy snapshot.
  const restoreStopped = () => {
    for (const name of Object.values(names)) if (!inspect(name).State.Running) docker(['start', name])
  }
  await ready(direct, undefined, restoreStopped)
  await ready(entry, 'blue', restoreStopped)
  if (manageRoute) await setEntry()
  for (const { name, container } of optionalRetired()) retiredStatus(name, container)
  return { ok: true, checkedAt: new Date().toISOString(), version: '0.2.13', image, entry,
    backgroundOwner: names.app, routePending: !manageRoute }
}

async function main() {
  const action = process.argv[2]
  assert(['prepare', 'cutover', 'boot', 'boot-local', 'status'].includes(action))
  const lockPath = join(deployment, '.release-operation.lock')
  let lock
  try {
    lock = await acquireLock(lockPath)
    await lock.writeFile(JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() }))
    if (action === 'prepare') await prepare(process.argv[3])
    if (action === 'cutover') await cutover()
    if (action === 'boot' || action === 'boot-local') {
      const result = await boot(action === 'boot')
      await save(join(directory, 'boot-status.json'), result)
      console.log(JSON.stringify(result))
    }
    if (action === 'status') {
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      console.log(JSON.stringify({ phase: state.phase, backgroundOwner: state.backgroundOwner, serve: serve(),
        containers: [...Object.values(names).map(name => {
          const c = inspect(name); return { name, running: c.State.Running, health: c.State.Health?.Status, restart: c.HostConfig.RestartPolicy.Name }
        }), ...optionalRetired().map(({ name, container }) => retiredStatus(name, container))] }, null, 2))
    }
  } catch (error) {
    if (action.startsWith('boot') && error.code !== 'EEXIST') await save(join(directory, 'boot-status.json'), { ok: false, checkedAt: new Date().toISOString(), error: error.message })
    throw error
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
