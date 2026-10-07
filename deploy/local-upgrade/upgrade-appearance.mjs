import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireLock, deployment, directory, image as priorImage, names, routing, assertCurrent } from './service-recovery.mjs'
import { liveGateway } from './live-gateway.mjs'

process.umask(0o077)
const action = process.argv[2]
assert(['prepare', 'activate', 'cleanup'].includes(action))
const candidateName = 'sub2api-appearance-candidate'
const candidateVolume = 'sub2api-appearance_candidate-data'
const candidatePort = 'http://127.0.0.1:18584'
const entry = 'http://127.0.0.1:18480'
const publicBase = 'https://openclaw-macmini-ts.tailff52e6.ts.net'
const upgradeDir = join(deployment, 'appearance-0.2.13')
const upgradeStatePath = join(upgradeDir, 'state.json')
const composePath = join(directory, 'compose-private.json')
const candidateComposePath = join(upgradeDir, 'compose-private.json')
const candidateCompose = ['compose', '-p', 'sub2api-appearance', '--env-file', '/dev/null', '-f', candidateComposePath]
const currentCompose = ['compose', '-p', 'sub2api-current', '--env-file', '/dev/null', '-f', composePath]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const ts = require('typescript')
async function assetGraph(base) {
  const html = await (await fetch(base + '/login', { signal: AbortSignal.timeout(5000) })).text()
  const paths = new Set(), files = new Map()
  function add(value, parent = '/') {
    if (!/^(?:\/assets\/|assets\/|\.\.?\/)[a-zA-Z0-9_./-]+\.(?:js|css)$/.test(value)) return
    const path = new URL(value.startsWith('assets/') ? '/' + value : value, 'http://assets.invalid' + parent).pathname
    if (!/^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{6,}\.(js|css)$/.test(path)) return
    paths.add(path)
    assert(paths.size <= 1000)
  }
  for (const match of html.matchAll(/(?:src|href)="([^"?#]+)"/g)) add(match[1])
  let total = 0
  for (const path of paths) {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(5000) })
    assert.equal(r.status, 200)
    assert(!r.headers.get('content-type')?.includes('text/html'))
    const bytes = Buffer.from(await r.arrayBuffer())
    total += bytes.length
    assert(total < 64 << 20)
    files.set(path, bytes)
    if (path.endsWith('.js')) {
      const source = ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
      assert.equal(source.parseDiagnostics.length, 0)
      const visit = node => { if (ts.isStringLiteralLike(node)) add(node.text, path); ts.forEachChild(node, visit) }
      visit(source)
    }
  }
  assert(files.size > 50)
  return files
}
function docker(args, input, timeout = 60000) {
  const r = spawnSync('/opt/homebrew/bin/docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 64 << 20 })
  assert(!r.error && r.status === 0, `Docker ${args[0]} failed; private details suppressed`)
  return r.stdout.trim()
}
const inspect = name => JSON.parse(docker(['inspect', name]))[0]
const environment = c => Object.fromEntries(c.Config.Env.map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)] }))
async function save(path, value) {
  await writeFile(path + '.pending', JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(path + '.pending', path)
}
async function health(base) {
  const r = await fetch(base + '/health', { signal: AbortSignal.timeout(5000) })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).status, 'ok')
}
async function ready(base) {
  const deadline = Date.now() + 90000
  while (true) {
    try { await health(base); return } catch { assert(Date.now() < deadline, 'Application did not become ready'); await delay(1000) }
  }
}
async function login(base) {
  const env = environment(inspect(names.app))
  const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(10000) })
  assert.equal(r.status, 200, 'Existing administrator cannot sign in')
  return (await r.json()).data.access_token
}
async function verifyApp(base, token) {
  const headers = { Authorization: `Bearer ${token}` }
  const v = await fetch(base + '/api/v1/admin/system/version', { headers, signal: AbortSignal.timeout(10000) })
  assert.equal(v.status, 200)
  assert.equal((await v.json()).data.version, '0.2.13')
  const p = await fetch(base + '/api/v1/settings/public', { signal: AbortSignal.timeout(10000) })
  assert.equal(p.status, 200)
  const appearance = (await p.json()).data.site_appearance
  assert.equal(appearance.skin, 'neubrutalism')
  assert.equal(appearance.mode, 'light')
  assert.equal(appearance.accent_color, '#d4ff3f')
  const s = await fetch(base + '/api/v1/admin/settings', { headers, signal: AbortSignal.timeout(10000) })
  assert.equal(s.status, 200)
  assert.deepEqual((await s.json()).data.site_appearance, appearance)
  const noAuth = await fetch(base + '/api/v1/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_appearance: appearance }), signal: AbortSignal.timeout(10000) })
  assert.equal(noAuth.status, 401)
  const html = await (await fetch(base + '/login', { signal: AbortSignal.timeout(10000) })).text()
  assert(html.includes('site_appearance'))
  const jsPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.js)"/g)].map(m => m[1])
  const cssPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.css)"/g)].map(m => m[1])
  assert(jsPaths.length > 0 && cssPaths.length > 0)
  const js = await Promise.all(jsPaths.map(async p => (await fetch(base + p)).text()))
  const css = await Promise.all(cssPaths.map(async p => (await fetch(base + p)).text()))
  assert(js.some(text => text.includes('__ACCENT__') && text.includes('site-accent-color')), 'New shared appearance and brand mark are absent')
  assert(css.some(text => text.includes('skin-dialog-panel') && text.includes('driver-popover.theme-tour-popover')), 'Overlay coverage missing')
  const logo = await (await fetch(base + '/logo.svg')).text()
  assert(logo.includes('pattern id="hatch"'))
  return { appearance, sessionAccepted: true, unauthorizedWriteRejected: true, newAssets: true }
}
async function reload(upstream) {
  await writeFile(join(directory, 'haproxy.cfg'), routing(upstream), { mode: 0o600 })
  docker(['exec', names.ingress, 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  docker(['kill', '--signal=USR2', names.ingress])
  await delay(1500)
  await ready(entry)
}
async function verifyAssets() {
  const assets = JSON.parse(await readFile(join(directory, 'assets.json'), 'utf8'))
  for (const asset of assets) {
    const r = await fetch(entry + asset.path, { signal: AbortSignal.timeout(5000) })
    assert.equal(r.status, 200)
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), asset.sha256)
  }
  return assets.length
}
async function prepare() {
  assertCurrent(inspect(names.app))
  const manifestPath = resolve(process.argv[3] || '')
  assert.match(manifestPath, /^\/Users\/clawbotbot\/Projects\/sub2api-neubrutalism\/release\/sub2api_0\.2\.13_linux_arm64_[a-f0-9]{12}\/manifest\.json$/)
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.version, '0.2.13')
  const metadata = JSON.parse(docker(['image', 'inspect', manifest.imageId]))[0]
  assert.equal(metadata.Config.Labels['org.opencontainers.image.revision'], manifest.commit)
  const backup = resolve(process.argv[4] || '')
  assert.match(backup, /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/)
  const backupManifest = JSON.parse(await readFile(join(backup, 'backup-manifest.json'), 'utf8'))
  assert.equal(backupManifest.oldContainerId, inspect(names.app).Id)
  assert(Date.now() - Date.parse(backupManifest.finished) < 30 * 60000, 'Need a fresh backup')
  for (const archive of backupManifest.archives) assert.equal(sha(await readFile(join(backup, archive.name))), archive.sha256)
  const inventory = await readFile(new URL('./compatibility-inventory.sql', import.meta.url), 'utf8')
  const jobs = JSON.parse(docker(['exec', '-i', 'sub2api-postgres', 'sh', '-c', 'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'], `BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; ${inventory} ROLLBACK;`))
  assert.equal(jobs.enabledScheduledTests, 0)
  assert.equal(jobs.enabledChannelMonitors, 0)
  assert.equal(jobs.backupScheduleEnabled, false)
  assert.equal(jobs.activeBackupOperations, 0)
  await mkdir(upgradeDir, { mode: 0o700 })
  await copyFile(composePath, join(upgradeDir, 'previous-compose-private.json'))
  await copyFile(join(directory, 'state.json'), join(upgradeDir, 'previous-state.json'))
  const config = JSON.parse(await readFile(composePath, 'utf8'))
  const seed = config.services.app
  const candidate = { ...seed, image: manifest.imageId, container_name: candidateName, restart: 'no',
    environment: { ...seed.environment, TOKEN_REFRESH_ENABLED: 'false', USAGE_CLEANUP_ENABLED: 'false', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1' },
    volumes: ['candidate-data:/app/data'], ports: ['127.0.0.1:18584:8080'] }
  await save(candidateComposePath, { services: { app: candidate }, networks: { production: config.networks.production }, volumes: { 'candidate-data': {} } })
  docker([...candidateCompose, 'create', 'app'])
  const data = spawnSync('/opt/homebrew/bin/docker', ['exec', names.app, 'tar', '-c', '--exclude=./logs', '--exclude=./backups', '-C', '/app/data', '.'], { timeout: 30000, maxBuffer: 64 << 20 })
  assert(!data.error && data.status === 0, 'Application data copy failed')
  docker(['cp', '-', candidateName + ':/app/data'], data.stdout)
  docker([...candidateCompose, 'up', '-d', '--no-deps', 'app'])
  await ready(candidatePort)
  const token = await login(candidatePort)
  const appChecks = await verifyApp(candidatePort, token)
  const probe = await liveGateway(candidatePort + '/v1', null, { timeoutMs: 45000 })
  const assets = JSON.parse(await readFile(join(directory, 'assets.json'), 'utf8'))
  const known = new Set(assets.map(a => a.path))
  const currentAssets = await assetGraph('http://127.0.0.1:18583')
  for (const [path, bytes] of currentAssets) {
    if (known.has(path)) {
      assert.equal(assets.find(a => a.path === path).sha256, sha(bytes), 'Historical asset path collision')
      continue
    }
    const target = join(directory, 'static', path.slice(1))
    await writeFile(target, bytes, { mode: 0o644 })
    assets.push({ path, sha256: sha(bytes), bytes: bytes.length })
  }
  assert(assets.reduce((n, a) => n + a.bytes, 0) < 96 << 20)
  await save(join(directory, 'assets.json'), assets)
  await chmod(join(directory, 'assets.json'), 0o644)
  await writeFile(join(directory, 'old-assets.map'), assets.map(a => a.path + ' cached').join('\n') + '\n', { mode: 0o644 })
  await reload(names.app + ':8080')
  const assetCount = await verifyAssets()
  const state = { phase: 'prepared', manifestPath, manifestSha256: sha(manifestBytes), image: manifest.imageId,
    commit: manifest.commit, backup, candidateName, candidateVolume, preparedAt: new Date().toISOString(), appChecks, probe, assetCount }
  await save(upgradeStatePath, state)
  console.log(JSON.stringify(state))
}
async function activate() {
  const state = JSON.parse(await readFile(upgradeStatePath, 'utf8'))
  assert.equal(state.phase, 'prepared')
  assert.equal(inspect(candidateName).Image, state.image)
  assertCurrent(inspect(names.app))
  const token = await login(candidatePort)
  await verifyApp(candidatePort, token)
  await liveGateway(candidatePort + '/v1', null, { timeoutMs: 45000 })
  let handover = false
  try {
    await reload(candidateName + ':8080')
    state.firstEntryProbe = await liveGateway(publicBase + '/v1', 'blue', { timeoutMs: 45000 })
    await verifyApp(publicBase, token)
    handover = true
    docker(['stop', '--time=45', names.app])
    const config = JSON.parse(await readFile(composePath, 'utf8'))
    config.services.app.image = state.image
    await save(composePath, config)
    docker([...currentCompose, 'up', '-d', '--no-deps', 'app'])
    await ready('http://127.0.0.1:18583')
    assertCurrent(inspect(names.app), state.image)
    await verifyApp('http://127.0.0.1:18583', token)
    await liveGateway('http://127.0.0.1:18583/v1', null, { timeoutMs: 45000 })
    await reload(names.app + ':8080')
    state.finalAppChecks = await verifyApp(publicBase, token)
    state.finalProbe = await liveGateway(publicBase + '/v1', 'blue', { timeoutMs: 45000 })
    await health('http://127.0.0.1:18080')
    state.assetCount = await verifyAssets()
    const currentState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    Object.assign(currentState, { image: state.image, releaseManifest: state.manifestPath, releaseManifestSha256: state.manifestSha256,
      activatedAt: new Date().toISOString(), backup: state.backup, backgroundOwner: names.app })
    await save(join(directory, 'state.json'), currentState)
    state.phase = 'active-verified'
    state.activatedAt = currentState.activatedAt
    await save(upgradeStatePath, state)
  } catch (error) {
    // Candidate stays available while restoring the sole prior background owner.
    if (handover) {
      await reload(candidateName + ':8080')
      docker(['stop', '--time=45', names.app])
      await copyFile(join(upgradeDir, 'previous-compose-private.json'), composePath)
      docker([...currentCompose, 'up', '-d', '--no-deps', 'app'])
      await ready('http://127.0.0.1:18583')
      assertCurrent(inspect(names.app))
    }
    await reload(names.app + ':8080')
    await copyFile(join(upgradeDir, 'previous-state.json'), join(directory, 'state.json'))
    throw error
  }
  // After durable promotion, a stop error must leave the healthy new app active.
  docker(['stop', '--time=45', candidateName])
  console.log(JSON.stringify({ phase: state.phase, image: state.image, probe: state.finalProbe, assets: state.assetCount }))
}
async function cleanup() {
  const state = JSON.parse(await readFile(upgradeStatePath, 'utf8'))
  assert.equal(state.phase, 'active-verified')
  assertCurrent(inspect(names.app), state.image)
  const boot = JSON.parse(await readFile(join(directory, 'boot-status.json'), 'utf8'))
  assert(boot.ok && boot.image === state.image, 'New startup recovery must pass before old image cleanup')
  await verifyApp(publicBase, await login(publicBase))
  const probe = await liveGateway(publicBase + '/v1', 'blue', { timeoutMs: 45000 })
  assert.equal(inspect(candidateName).State.Running, false)
  docker(['rm', candidateName])
  const all = JSON.parse(docker(['inspect', ...docker(['ps', '-a', '--format', '{{.ID}}']).split('\n').filter(Boolean)]))
  assert(!all.some(c => c.Mounts.some(m => m.Name === candidateVolume)))
  assert(!all.some(c => c.Image === priorImage), 'Prior image is still in use')
  docker(['volume', 'rm', candidateVolume])
  const old = JSON.parse(docker(['image', 'inspect', priorImage]))[0]
  const tags = old.RepoTags || []
  for (const tag of tags) docker(['image', 'rm', tag])
  const remainingImages = docker(['image', 'ls', '--no-trunc', '--format', '{{.ID}}']).split('\n')
  if (remainingImages.includes(priorImage)) docker(['image', 'rm', priorImage])
  state.phase = 'complete-old-cleaned'
  state.cleanedAt = new Date().toISOString()
  state.cleanup = { candidateContainer: candidateName, candidateVolume, priorImage, tags, probe }
  await save(upgradeStatePath, state)
  console.log(JSON.stringify({ phase: state.phase, cleanup: state.cleanup, assets: await verifyAssets() }))
}
const lockPath = join(deployment, '.release-operation.lock')
const lock = await acquireLock(lockPath)
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, action: 'appearance-' + action, startedAt: new Date().toISOString() }))
  if (action === 'prepare') await prepare()
  if (action === 'activate') await activate()
  if (action === 'cleanup') await cleanup()
} finally { await lock.close(); await unlink(lockPath) }
