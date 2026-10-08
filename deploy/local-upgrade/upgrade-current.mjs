import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireLock, assertCurrent, deployment, directory, names, routing } from './service-recovery.mjs'
import { liveGateway } from './live-gateway.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const composePath = join(directory, 'compose-private.json')
const activeStatePath = join(directory, 'state.json')
const direct = 'http://127.0.0.1:18583'
const entry = 'http://127.0.0.1:18480'
const compatibility = 'http://127.0.0.1:18080'
const publicBase = 'https://openclaw-macmini-ts.tailff52e6.ts.net'
const backupRoot = '/Users/clawbotbot/Projects/sub2api-upgrade-private'
const currentComposeArgs = ['compose', '-p', 'sub2api-current', '--env-file', '/dev/null', '-f', composePath]
const digestPattern = /^sha256:[a-f0-9]{64}$/
const assetPattern = /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{6,}\.(?:js|css)$/
const sha = value => createHash('sha256').update(value).digest('hex')
const require = createRequire(join(root, 'frontend/package.json'))
let ts

class UpgradeError extends Error {}
function check(condition, message) { if (!condition) throw new UpgradeError(message) }
function safeError(error) { return error instanceof UpgradeError ? error.message : 'Operation failed; private details suppressed' }
function docker(args, input, timeout = 60_000, binary = false) {
  const result = spawnSync('/opt/homebrew/bin/docker', args, {
    input, encoding: binary ? undefined : 'utf8', timeout, maxBuffer: 256 << 20
  })
  check(!result.error && result.status === 0, `Docker ${args[0]} failed; private details suppressed`)
  return binary ? result.stdout : result.stdout.trim()
}
function inspect(name) { return JSON.parse(docker(['inspect', name]))[0] }
function imageMetadata(id) { return JSON.parse(docker(['image', 'inspect', id]))[0] }
function existingContainer(name) {
  const id = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])
  return id ? inspect(id) : null
}
const environment = container => Object.fromEntries(container.Config.Env.map(value => {
  const separator = value.indexOf('=')
  return [value.slice(0, separator), value.slice(separator + 1)]
}))
async function save(path, value, mode = 0o600) {
  await writeFile(path + '.pending', JSON.stringify(value, null, 2) + '\n', { mode })
  await chmod(path + '.pending', mode)
  await rename(path + '.pending', path)
}
async function privateFile(path) {
  const info = await lstat(path)
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600, 'Private operation file must be a regular mode-0600 file')
  check(info.uid === process.getuid(), 'Private operation file owner changed')
  return readFile(path)
}
async function jsonPrivate(path) { return JSON.parse(await privateFile(path)) }
async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function releaseIdentity(manifestPath, manifest, repositoryRoot = root) {
  check(manifest.version === '0.2.13', 'This recovery deployment supports version 0.2.13 only')
  check(manifest.platform === 'linux/arm64', 'The local release must target linux/arm64')
  check(/^[a-f0-9]{40}$/.test(manifest.commit || ''), 'The release must have an exact source commit')
  check(digestPattern.test(manifest.imageId || ''), 'The release must pin an immutable image ID')
  const short = manifest.commit.slice(0, 12)
  const canonical = join(repositoryRoot, 'release', `sub2api_${manifest.version}_linux_arm64_${short}`, 'manifest.json')
  check(resolve(manifestPath) === canonical, 'The manifest path must match its exact release identity')
  const project = `sub2api-quota-${short}`
  return {
    manifestPath: canonical, commit: manifest.commit, image: manifest.imageId,
    directory: join(deployment, `quota-${manifest.version}-${short}`), project,
    candidateName: `sub2api-quota-candidate-${short}`,
    candidateVolume: `${project}_candidate-data`, candidateBase: 'http://127.0.0.1:18585'
  }
}

export function assertActivePin(state, config, container) {
  check(state.phase === 'active-old-retired', 'Current recovery state is not active')
  check(digestPattern.test(state.image || ''), 'Current state must pin an immutable image')
  check(config.services?.app?.image === state.image && container.Image === state.image, 'Current compose, state and live image disagree')
  check(config.services.app.container_name === names.app && state.backgroundOwner === names.app, 'Current application owner changed')
  check(container.State.Running && container.State.Health?.Status === 'healthy', 'Current application must already serve correctly')
  assertCurrent(container, state.image)
  check(config.services.app.restart === 'always' && container.HostConfig.RestartPolicy.Name === 'always', 'Current restart policy changed')
  check(JSON.stringify(config.services.app.ports) === JSON.stringify(['127.0.0.1:18583:8080']), 'Current loopback port changed')
  check(JSON.stringify(config.services.app.volumes) === JSON.stringify(['current-data:/app/data']), 'Current application volume changed')
  check(config.networks?.production?.external === true && config.networks.production.name === 'sub2api_sub2api-network', 'Shared production network changed')
  const live = environment(container)
  for (const key of ['JWT_SECRET', 'TOTP_ENCRYPTION_KEY', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_DBNAME', 'DATABASE_PASSWORD', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD']) {
    check(live[key] === config.services.app.environment[key], 'Current private environment differs from protected compose')
  }
  check(live.JWT_SECRET && /^[a-f0-9]{64}$/i.test(live.TOTP_ENCRYPTION_KEY || ''), 'Current session/encryption configuration is missing')
  return state.image
}

export function candidateCompose(config, identity, image = identity.image) {
  check(digestPattern.test(image), 'Candidate image must be immutable')
  const seed = structuredClone(config.services.app)
  return { services: { app: {
    ...seed, image, container_name: identity.candidateName, restart: 'no', pull_policy: 'never',
    ports: ['127.0.0.1:18585:8080'], volumes: ['candidate-data:/app/data'], networks: ['production'],
    environment: { ...seed.environment, AUTO_SETUP: 'false', TOKEN_REFRESH_ENABLED: 'false',
      USAGE_CLEANUP_ENABLED: 'false', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1' },
    labels: { ...seed.labels, 'io.sub2api.local-upgrade.commit': identity.commit }
  } }, networks: { production: structuredClone(config.networks.production) },
  volumes: { 'candidate-data': { name: identity.candidateVolume } } }
}

export function promotedCompose(previous, image) {
  check(digestPattern.test(image), 'Promoted image must be immutable')
  const next = structuredClone(previous)
  next.services.app.image = image
  Object.assign(next.services.app.environment, {
    TOKEN_REFRESH_ENABLED: 'true', USAGE_CLEANUP_ENABLED: 'true', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '0'
  })
  return next
}

export function promotedState(previous, upgrade, activatedAt = new Date().toISOString()) {
  return { ...previous, phase: 'active-old-retired', image: upgrade.image,
    releaseManifest: upgrade.manifestPath, releaseManifestSha256: upgrade.manifestSha256,
    activatedAt, backup: upgrade.backup, backgroundOwner: names.app, entry,
    directCompatibility: compatibility, sourceCommit: upgrade.commit,
    lastUpgrade: { directory: upgrade.directory, priorImage: upgrade.priorImage } }
}

export function assertFreshBackup(record, current, dependencies, now = Date.now()) {
  const started = Date.parse(record.started), finished = Date.parse(record.finished)
  check(Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= now + 60_000 && now - finished < 30 * 60_000, 'A fresh backup from the last 30 minutes is required')
  check(record.oldContainerId === current.Id && record.oldImageId === current.Image, 'Backup does not belong to the current application')
  check(record.databaseImageId === dependencies[0].Image && record.redisImageId === dependencies[1].Image, 'Backup dependency pins changed')
  check(record.archives?.length === 3 && ['postgres.dump', 'redis.rdb', 'app-data.tar.gz'].every(name => record.archives.filter(item => item.name === name).length === 1), 'Backup must contain exactly the three expected archives')
  for (const item of record.archives) check(Number.isInteger(item.bytes) && item.bytes > 0 && item.bytes <= ((item.name === 'redis.rdb' ? 64 : 256) << 20) && /^[a-f0-9]{64}$/.test(item.sha256 || ''), 'Backup archive metadata is invalid')
}

// The ordering is also exercised with an injected operation fixture. No POST
// is retried automatically, and candidate cleanup is outside the rollback path.
export async function runHotSwitch(operations) {
  await operations.verifyCandidate()
  try {
    await operations.routeCandidate()
    await operations.verifyEntryCandidate()
    await operations.replaceCurrent()
    await operations.verifyCurrent()
    await operations.routeCurrent()
    await operations.verifyEntryCurrent()
    await operations.commit()
  } catch (error) {
    await operations.rollback()
    throw error
  }
  await operations.cleanupCandidate()
}

async function loadRelease(path, fullChecks = false) {
  const manifestPath = resolve(path || '')
  const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes)
  const identity = releaseIdentity(manifestPath, manifest)
  const metadata = imageMetadata(identity.image)
  check(metadata.Id === identity.image && `${metadata.Os}/${metadata.Architecture}` === manifest.platform, 'Release image or platform changed')
  check(metadata.Config.Labels?.['org.opencontainers.image.revision'] === identity.commit && metadata.Config.Labels?.['org.opencontainers.image.version'] === manifest.version, 'Release image source/version labels do not match the manifest')
  const sums = await readFile(join(dirname(manifestPath), 'SHA256SUMS'), 'utf8')
  const entries = sums.trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9_.-]+)$/.exec(line)
    check(match, 'Unexpected release checksum entry')
    return { name: match[2], hash: match[1] }
  })
  const manifestHash = entries.find(item => item.name === 'manifest.json')?.hash
  check(manifestHash === sha(bytes), 'Release manifest checksum mismatch')
  if (fullChecks) {
    const expected = ['image.tar', 'source.tar.gz', 'README.md', 'manifest.json', 'source-validation.json', 'smoke.mjs', 'smoke-compose.yaml']
    check(entries.length === expected.length && expected.every(name => entries.filter(item => item.name === name).length === 1), 'Release package checksum inventory changed')
    for (const item of entries) check(await checksum(join(dirname(manifestPath), item.name)) === item.hash, 'Release package checksum mismatch')
  }
  return { identity, manifest, manifestSha256: sha(bytes) }
}

async function activeConfiguration() {
  const [state, config] = await Promise.all([jsonPrivate(activeStatePath), jsonPrivate(composePath)])
  const container = inspect(names.app)
  assertActivePin(state, config, container)
  if (state.releaseManifest) {
    const bytes = await readFile(state.releaseManifest)
    check(sha(bytes) === state.releaseManifestSha256, 'Current release manifest changed')
    const prior = JSON.parse(bytes)
    check(prior.imageId === state.image, 'Current release image differs from its manifest')
    releaseIdentity(state.releaseManifest, prior)
  }
  const dependencies = state.dependencies.map(item => {
    const found = inspect(item.name)
    check(found.Image === item.image && found.State.Running && found.State.Health?.Status === 'healthy', 'A shared dependency changed or is unhealthy')
    return found
  })
  check(dependencies.length === 2 && dependencies[0].Name === '/sub2api-postgres' && dependencies[1].Name === '/sub2api-redis', 'Shared dependency identity changed')
  return { state, config, container, dependencies }
}

async function verifyBackup(backup, active, manifest, reportPath) {
  check(resolve(backup) === backup && new RegExp(`^${backupRoot}/backup-[a-zA-Z0-9]+$`).test(backup), 'Pass an exact private backup directory')
  const info = await lstat(backup)
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && info.uid === process.getuid(), 'Private backup directory permissions changed')
  const record = await jsonPrivate(join(backup, 'backup-manifest.json'))
  assertFreshBackup(record, active.container, active.dependencies)
  for (const archive of record.archives) {
    const path = join(backup, archive.name), item = await lstat(path)
    check(item.isFile() && !item.isSymbolicLink() && (item.mode & 0o777) === 0o600 && item.size === archive.bytes, 'Private backup archive permissions/size changed')
    check(await checksum(path) === archive.sha256, 'Private backup archive checksum changed')
  }
  // Parse a dump's table of contents without restoring or writing the live DB.
  const toc = docker(['exec', '-i', active.dependencies[0].Id, 'pg_restore', '--list'], await readFile(join(backup, 'postgres.dump')), 30_000)
  check(toc.includes('TABLE') && toc.includes('schema_migrations'), 'Backup PostgreSQL archive is not readable')
  if (reportPath) {
    const report = await jsonPrivate(resolve(reportPath))
    check(report.passed === true && report.backup === backup && report.candidateCommit === manifest.commit && report.candidateImageId === manifest.imageId && report.oldImageId === active.container.Image, 'Restore report does not verify this exact backup and release')
  }
  return { archivesVerified: true, dumpReadable: true, isolatedRestoreReport: reportPath ? resolve(reportPath) : null }
}

async function request(base, path, { token, body, timeoutMs = 10_000 } = {}) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  check(response.status === 200, `Application check returned HTTP ${response.status}; response details suppressed`)
  return response
}
async function api(base, path, options) {
  const value = await (await request(base, '/api/v1' + path, options)).json()
  check(value.code === 0 && value.data !== undefined, 'Application API envelope is invalid')
  return value.data
}
async function health(base) { check((await (await request(base, '/health', { timeoutMs: 5000 })).json()).status === 'ok', 'Application health check failed') }
async function ready(base) {
  const deadline = Date.now() + 90_000
  while (true) {
    try { await health(base); return } catch { check(Date.now() < deadline, 'Application did not become ready'); await delay(1000) }
  }
}
async function session(config, base = direct) {
  const data = await api(base, '/auth/login', { body: { email: config.services.app.environment.ADMIN_EMAIL, password: config.services.app.environment.ADMIN_PASSWORD } })
  check(typeof data.access_token === 'string' && data.access_token.length > 20, 'Current administrator login failed')
  return data.access_token
}
async function verifyShared(base, token, appearance, version = '0.2.13') {
  const user = await api(base, '/auth/me', { token })
  check(user.role === 'admin', 'The same administrator session was not accepted')
  check((await api(base, '/admin/system/version', { token })).version === version, 'Application version is incorrect')
  const current = (await api(base, '/settings/public')).site_appearance
  const admin = (await api(base, '/admin/settings', { token })).site_appearance
  check(JSON.stringify(admin) === JSON.stringify(current), 'Public and administrator themes disagree')
  if (appearance) check(JSON.stringify(current) === JSON.stringify(appearance), 'The existing administrator theme changed during upgrade')
  return current
}

async function assetGraph(base) {
  ts ||= require('typescript')
  const html = await (await request(base, '/login')).text(), paths = new Set(), files = new Map()
  function add(value, parent = '/') {
    if (!/^(?:\/assets\/|assets\/|\.\.?\/)[a-zA-Z0-9_./-]+\.(?:js|css)$/.test(value)) return
    const path = new URL(value.startsWith('assets/') ? '/' + value : value, 'http://assets.invalid' + parent).pathname
    if (!assetPattern.test(path)) return
    paths.add(path)
    check(paths.size <= 1000, 'Frontend asset graph exceeds its file budget')
  }
  for (const match of html.matchAll(/(?:src|href)=["']([^"'?#]+)["']/g)) add(match[1])
  let total = 0
  for (const path of paths) {
    const response = await request(base, path, { timeoutMs: 5000 })
    check(!response.headers.get('content-type')?.includes('text/html'), 'A frontend chunk unexpectedly returned HTML')
    const bytes = Buffer.from(await response.arrayBuffer())
    total += bytes.length
    check(bytes.length > 0 && bytes.length <= (8 << 20) && total < (64 << 20), 'Frontend asset graph exceeds its byte budget')
    files.set(path, bytes)
    if (path.endsWith('.js')) {
      const source = ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
      check(source.parseDiagnostics.length === 0, 'Frontend JavaScript chunk cannot be parsed')
      const visit = node => { if (ts.isStringLiteralLike(node)) add(node.text, path); ts.forEachChild(node, visit) }
      visit(source)
    }
  }
  check(files.size > 50, 'Frontend asset graph is incomplete')
  return files
}
export function quotaResponseSummary(batch, ids, now = Date.now()) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  check(object(batch) && object(batch.usage) && object(batch.errors), 'Quota batch response is invalid')
  check(Array.isArray(ids) && ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length, 'Quota account IDs are invalid')
  const requested = new Set(ids.map(String))
  check(Object.keys(batch.usage).every(id => requested.has(id)) && Object.entries(batch.errors).every(([id, error]) => requested.has(id) && typeof error === 'string'), 'Quota batch account/error structure is invalid')
  let windows = 0, unknownAccounts = 0, staleAccounts = 0
  for (const id of ids) {
    const usage = batch.usage[id]
    if (usage === undefined) { unknownAccounts++; continue }
    check(object(usage), 'Quota usage must be an object')
    if (usage.quota_windows === undefined) { unknownAccounts++; continue }
    check(Array.isArray(usage.quota_windows), 'Quota windows must be an array')
    let measured = false, stale = !!batch.errors[id] || !!usage.quota_snapshot_error || !!usage.error
    for (const window of usage.quota_windows) {
      check(object(window) && typeof window.key === 'string' && window.key.length > 0 && (window.utilization === null || (typeof window.utilization === 'number' && Number.isFinite(window.utilization) && window.utilization >= 0)), 'Quota window has invalid numeric data')
      check(['upstream', 'response_headers', 'estimated', 'local'].includes(window.source) && ['account', 'model'].includes(window.scope), 'Quota window source/scope is invalid')
      for (const key of ['resets_at', 'sampled_at']) check(window[key] === null || (typeof window[key] === 'string' && Number.isFinite(Date.parse(window[key]))), 'Quota window timestamp is invalid')
      check(window.window_minutes === undefined || (Number.isInteger(window.window_minutes) && window.window_minutes > 0), 'Quota window duration is invalid')
      check(window.model === undefined || typeof window.model === 'string', 'Quota window model is invalid')
      if (window.utilization !== null && ['upstream', 'response_headers'].includes(window.source)) {
        measured = true
        const age = window.sampled_at === null ? Infinity : now - Date.parse(window.sampled_at)
        stale ||= age > 15 * 60_000 || age < -60_000 || (window.resets_at !== null && Date.parse(window.resets_at) <= now)
      }
      windows++
    }
    if (!measured) unknownAccounts++
    else if (stale) staleAccounts++
  }
  // Missing or stale upstream readings are normal page states. Real gateway
  // completion, rather than the availability of quota observations, gates serving.
  return { accountsChecked: ids.length, quotaWindows: windows, errors: Object.keys(batch.errors).length, unknownAccounts, staleAccounts }
}
async function verifyQuota(base, token, frontend) {
  const list = await api(base, '/admin/accounts?page=1&page_size=100&lite=1', { token })
  check(Array.isArray(list.items), 'Compact account list is invalid')
  const ids = list.items.filter(account => (account.platform === 'openai' && account.type === 'oauth') || (account.platform === 'anthropic' && ['oauth', 'setup-token'].includes(account.type))).slice(0, 6).map(account => account.id)
  const batch = await api(base, '/admin/accounts/usage/batch', { token, body: { account_ids: ids, force: false }, timeoutMs: 45_000 })
  const summary = quotaResponseSummary(batch, ids)
  if (frontend) {
    for (const chunk of frontend) {
      const response = await request(base, chunk.path, { timeoutMs: 5000 })
      check(!response.headers.get('content-type')?.includes('text/html') && sha(Buffer.from(await response.arrayBuffer())) === chunk.sha256, 'Quota overview lazy frontend chunk changed or is unavailable')
    }
  }
  return { ...summary, lazyChunksVerified: frontend?.length || 0 }
}
async function reload(upstream) {
  check(upstream === `${names.app}:8080` || /^sub2api-quota-candidate-[a-f0-9]{12}:8080$/.test(upstream), 'Unexpected upgrade routing target')
  // The single-file bind mount must retain its inode during HAProxy reload.
  await writeFile(join(directory, 'haproxy.cfg'), routing(upstream), { mode: 0o600 })
  docker(['exec', names.ingress, 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  docker(['kill', '--signal=USR2', names.ingress])
  await delay(1500)
  await ready(entry)
}
async function verifyAssets() {
  const assets = JSON.parse(await readFile(join(directory, 'assets.json'), 'utf8'))
  for (const asset of assets) {
    const response = await request(entry, asset.path, { timeoutMs: 5000 })
    check(sha(Buffer.from(await response.arrayBuffer())) === asset.sha256, 'Cached historical frontend resource changed')
  }
  return assets.length
}
export function mergeAssetInventory(previous, graphs) {
  check(Array.isArray(previous), 'Historical frontend cache inventory is invalid')
  const assets = [], additions = [], byPath = new Map()
  for (const item of previous) {
    check(assetPattern.test(item?.path || '') && /^[a-f0-9]{64}$/.test(item.sha256 || '') && Number.isInteger(item.bytes) && item.bytes > 0 && item.bytes <= (8 << 20) && !byPath.has(item.path), 'Historical frontend cache inventory is invalid')
    const record = { path: item.path, sha256: item.sha256, bytes: item.bytes }
    assets.push(record)
    byPath.set(record.path, record)
  }
  for (const graph of graphs) for (const [path, bytes] of graph) {
    check(assetPattern.test(path) && Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= (8 << 20), 'Unexpected cache asset path or bytes')
    const existing = byPath.get(path)
    if (existing) { check(existing.sha256 === sha(bytes) && existing.bytes === bytes.length, 'Historical frontend asset path collision'); continue }
    const item = { path, sha256: sha(bytes), bytes: bytes.length }
    byPath.set(path, item)
    assets.push(item)
    additions.push({ path, bytes })
  }
  check(assets.length <= 1000 && assets.reduce((total, item) => total + item.bytes, 0) < (96 << 20), 'Historical frontend cache exceeds its retention budget')
  return { assets, additions }
}
async function cacheAssets(graphs) {
  const previous = JSON.parse(await readFile(join(directory, 'assets.json'), 'utf8'))
  const { assets, additions } = mergeAssetInventory(previous, graphs)
  for (const item of previous) {
    const path = join(directory, 'static', item.path.slice(1)), info = await lstat(path)
    check(info.isFile() && !info.isSymbolicLink() && info.size === item.bytes && await checksum(path) === item.sha256, 'Retained historical frontend file changed')
  }
  for (const item of additions) await writeFile(join(directory, 'static', item.path.slice(1)), item.bytes, { mode: 0o644, flag: 'wx' })
  await save(join(directory, 'assets.json'), assets, 0o644)
  await writeFile(join(directory, 'old-assets.map'), assets.map(item => item.path + ' cached').join('\n') + '\n', { mode: 0o644 })
}

function candidateArgs(identity) { return ['compose', '-p', identity.project, '--env-file', '/dev/null', '-f', join(identity.directory, 'compose-private.json')] }
function assertCandidate(identity, expectedImage = identity.image) {
  const candidate = inspect(identity.candidateName), env = environment(candidate)
  check(candidate.Image === expectedImage && candidate.Config.Labels['com.docker.compose.project'] === identity.project, 'Candidate container identity changed')
  check(candidate.HostConfig.RestartPolicy.Name === 'no', 'Candidate restart policy changed')
  check(env.TOKEN_REFRESH_ENABLED === 'false' && env.USAGE_CLEANUP_ENABLED === 'false' && env.CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR === '1', 'Candidate must not own background jobs')
  check(candidate.Mounts.some(mount => mount.Name === identity.candidateVolume && mount.Destination === '/app/data'), 'Candidate does not have its dedicated data volume')
  return candidate
}
async function startCandidate(identity, config, expectedImage = identity.image) {
  await save(join(identity.directory, 'compose-private.json'), candidateCompose(config, identity, expectedImage))
  const existing = existingContainer(identity.candidateName)
  if (existing) {
    check(existing.Image === expectedImage && existing.Config.Labels['com.docker.compose.project'] === identity.project, 'Do not replace an unexpected candidate')
  } else {
    docker([...candidateArgs(identity), 'create', 'app'])
    const current = existingContainer(names.app)
    let data
    if (current?.State.Running) {
      data = docker(['exec', names.app, 'tar', '-c', '--exclude=./logs', '--exclude=./backups', '-C', '/app/data', '.'], undefined, 30_000, true)
    } else {
      // Interrupted replacement may leave no running canonical app. Mount an
      // existing, owned application volume read-only; never create a new source.
      const volumeName = config.volumes?.['current-data']?.name || 'sub2api-current_current-data'
      check(/^sub2api-current[_-]current-data$/.test(volumeName), 'Unexpected current data volume')
      const volume = JSON.parse(docker(['volume', 'inspect', volumeName]))[0]
      check(volume.Labels?.['com.docker.compose.project'] === 'sub2api-current', 'Current data volume owner changed')
      data = docker(['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--entrypoint=tar',
        '--mount', `type=volume,src=${volumeName},dst=/seed,readonly`, expectedImage,
        '-c', '--exclude=./logs', '--exclude=./backups', '-C', '/seed', '.'], undefined, 30_000, true)
    }
    docker(['cp', '-', identity.candidateName + ':/app/data'], data)
  }
  docker([...candidateArgs(identity), 'up', '-d', '--no-deps', 'app'])
  await ready(identity.candidateBase)
  assertCandidate(identity, expectedImage)
}
async function snapshots(identity, state) {
  const previousComposeBytes = await privateFile(join(identity.directory, 'previous-compose-private.json'))
  const previousStateBytes = await privateFile(join(identity.directory, 'previous-state.json'))
  check(sha(previousComposeBytes) === state.priorComposeSha256 && sha(previousStateBytes) === state.priorStateSha256, 'Prior deployment recovery snapshots changed')
  const previous = { config: JSON.parse(previousComposeBytes), state: JSON.parse(previousStateBytes) }
  assertSnapshotPins(previous, state.priorImage)
  return previous
}
export function assertSnapshotPins(previous, image) {
  check(digestPattern.test(image || '') && previous.state.phase === 'active-old-retired' && previous.state.image === image && previous.config.services?.app?.image === image, 'Prior recovery snapshot image changed')
  check(previous.state.backgroundOwner === names.app && previous.config.services.app.container_name === names.app, 'Prior recovery snapshot application owner changed')
}
async function cleanupCandidate(identity) {
  check(await readFile(join(directory, 'haproxy.cfg'), 'utf8') === routing(`${names.app}:8080`), 'Candidate cleanup requires the entry to route to the current app')
  const active = await activeConfiguration()
  check([identity.image, (await jsonPrivate(join(identity.directory, 'state.json'))).priorImage].includes(active.state.image), 'Do not clean a candidate for another production release')
  const candidate = existingContainer(identity.candidateName)
  if (candidate) {
    check(candidate.Config.Labels['com.docker.compose.project'] === identity.project, 'Do not clean another project candidate')
    if (candidate.State.Running) docker(['stop', '--time=10', identity.candidateName])
    docker(['rm', identity.candidateName])
  }
  const volumes = new Set(docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n'))
  if (volumes.has(identity.candidateVolume)) {
    const ids = docker(['ps', '-a', '--format', '{{.ID}}']).split('\n').filter(Boolean)
    const containers = ids.length ? JSON.parse(docker(['inspect', ...ids])) : []
    check(!containers.some(container => container.Mounts.some(mount => mount.Name === identity.candidateVolume)), 'Candidate volume is still used by a container')
    const volume = JSON.parse(docker(['volume', 'inspect', identity.candidateVolume]))[0]
    check(volume.Labels?.['com.docker.compose.project'] === identity.project, 'Do not clean another project volume')
    docker(['volume', 'rm', identity.candidateVolume])
  }
}

async function prepare(manifestPath, backup, restoreReport) {
  const release = await loadRelease(manifestPath, true), { identity, manifest } = release
  const active = await activeConfiguration()
  check(active.state.image !== identity.image, 'This release is already active')
  check(await readFile(join(directory, 'haproxy.cfg'), 'utf8') === routing(`${names.app}:8080`), 'The current entry is not pinned to its active app')
  const backupCheck = await verifyBackup(resolve(backup || ''), active, manifest, restoreReport)
  const jobs = JSON.parse(docker(['exec', '-i', active.dependencies[0].Id, 'sh', '-c', 'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'], `BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; ${await readFile(new URL('./compatibility-inventory.sql', import.meta.url), 'utf8')} ROLLBACK;`))
  check(jobs.enabledScheduledTests === 0 && jobs.enabledChannelMonitors === 0 && !jobs.backupScheduleEnabled && jobs.activeBackupOperations === 0, 'An overlapping unclaimed background job blocks candidate preparation')
  await mkdir(identity.directory, { mode: 0o700 })
  await copyFile(composePath, join(identity.directory, 'previous-compose-private.json'))
  await copyFile(activeStatePath, join(identity.directory, 'previous-state.json'))
  const state = { ...identity, phase: 'preparing', manifestSha256: release.manifestSha256,
    backup: resolve(backup), backupCheck, priorImage: active.state.image, priorContainerId: active.container.Id,
    priorComposeSha256: sha(await privateFile(join(identity.directory, 'previous-compose-private.json'))),
    priorStateSha256: sha(await privateFile(join(identity.directory, 'previous-state.json'))),
    preparedAt: new Date().toISOString() }
  const statePath = join(identity.directory, 'state.json')
  await save(statePath, state)
  try {
    const token = await session(active.config)
    const appearance = await verifyShared(direct, token)
    await startCandidate(identity, active.config)
    await verifyShared(identity.candidateBase, token, appearance)
    const oldGraph = await assetGraph(direct), nextGraph = await assetGraph(identity.candidateBase)
    state.frontend = [...nextGraph].filter(([path]) => /\/QuotaOverviewView-[^/]+\.(?:js|css)$/.test(path)).map(([path, bytes]) => ({ path, sha256: sha(bytes) }))
    check(state.frontend.some(chunk => chunk.path.endsWith('.js')) && state.frontend.some(chunk => chunk.path.endsWith('.css')), 'Quota overview lazy frontend files are absent')
    state.quota = await verifyQuota(identity.candidateBase, token, state.frontend)
    state.candidateProbe = await liveGateway(identity.candidateBase + '/v1', null, { timeoutMs: 45_000 })
    await cacheAssets([oldGraph, nextGraph])
    await reload(`${names.app}:8080`)
    state.assetsVerified = await verifyAssets()
    assertActivePin(await jsonPrivate(activeStatePath), await jsonPrivate(composePath), inspect(names.app))
    check(inspect(names.app).Id === active.container.Id, 'Current application changed during preparation')
    state.phase = 'prepared'
    await save(statePath, state)
  } catch (error) {
    state.phase = 'prepare-failed'
    state.failure = safeError(error)
    await save(statePath, state)
    throw error
  }
  return state
}

async function loadUpgrade(path) {
  const release = await loadRelease(path)
  const state = await jsonPrivate(join(release.identity.directory, 'state.json'))
  check(state.manifestPath === release.identity.manifestPath && state.manifestSha256 === release.manifestSha256 && state.image === release.identity.image && state.commit === release.identity.commit, 'Prepared operation no longer matches its immutable release')
  return { ...release, state }
}
async function restorePrevious(identity, state, token, appearance, replacementStarted) {
  const prior = await snapshots(identity, state)
  imageMetadata(state.priorImage)
  if (replacementStarted) {
    // The verified, passive candidate continues serving while the sole prior
    // background owner returns. Never restore a DB or Redis snapshot here.
    await reload(identity.candidateName + ':8080')
    await verifyShared(publicBase, token, appearance)
    state.rollbackCandidateProbe = await liveGateway(publicBase + '/v1', 'blue', { timeoutMs: 45_000 })
    const current = existingContainer(names.app)
    if (current?.State.Running) docker(['stop', '--time=10', names.app])
    await save(composePath, prior.config)
    docker([...currentComposeArgs, 'up', '-d', '--no-deps', 'app'])
  }
  await ready(direct)
  assertCurrent(inspect(names.app), state.priorImage)
  await verifyShared(direct, token, appearance)
  await liveGateway(direct + '/v1', null, { timeoutMs: 45_000 })
  await reload(names.app + ':8080')
  await verifyShared(publicBase, token, appearance)
  state.rollbackProbe = await liveGateway(publicBase + '/v1', 'blue', { timeoutMs: 45_000 })
  await save(activeStatePath, prior.state)
  state.phase = 'rolled-back-verified'
  state.rolledBackAt = new Date().toISOString()
  await save(join(identity.directory, 'state.json'), state)
}

async function activate(path) {
  const { identity, manifest, state } = await loadUpgrade(path)
  check(state.phase === 'prepared', 'Activation requires a freshly prepared release; inspect status instead of replaying it')
  const active = await activeConfiguration()
  check(active.container.Id === state.priorContainerId && active.state.image === state.priorImage, 'Production changed after preparation')
  await verifyBackup(state.backup, active, manifest, state.backupCheck.isolatedRestoreReport)
  await snapshots(identity, state)
  const token = await session(active.config), appearance = await verifyShared(direct, token)
  let replacementStarted = false
  const checkpoint = async phase => { state.phase = phase; await save(join(identity.directory, 'state.json'), state) }
  await runHotSwitch({
    verifyCandidate: async () => {
      assertCandidate(identity)
      await ready(identity.candidateBase)
      await verifyShared(identity.candidateBase, token, appearance)
      await verifyQuota(identity.candidateBase, token, state.frontend)
      await liveGateway(identity.candidateBase + '/v1', null, { timeoutMs: 45_000 })
    },
    routeCandidate: async () => { await checkpoint('routing-candidate'); await reload(identity.candidateName + ':8080') },
    verifyEntryCandidate: async () => {
      await verifyShared(publicBase, token, appearance)
      state.firstEntryQuota = await verifyQuota(publicBase, token, state.frontend)
      state.firstEntryProbe = await liveGateway(publicBase + '/v1', 'blue', { timeoutMs: 45_000 })
    },
    replaceCurrent: async () => {
      await checkpoint('replacing-current')
      replacementStarted = true
      docker(['stop', '--time=10', names.app])
      await save(composePath, promotedCompose(active.config, identity.image))
      docker([...currentComposeArgs, 'up', '-d', '--no-deps', 'app'])
    },
    verifyCurrent: async () => {
      await ready(direct)
      assertCurrent(inspect(names.app), identity.image)
      await verifyShared(direct, token, appearance)
      state.finalDirectQuota = await verifyQuota(direct, token, state.frontend)
      state.finalDirectProbe = await liveGateway(direct + '/v1', null, { timeoutMs: 45_000 })
    },
    routeCurrent: async () => { await checkpoint('routing-current'); await reload(names.app + ':8080') },
    verifyEntryCurrent: async () => {
      await verifyShared(publicBase, token, appearance)
      state.finalEntryQuota = await verifyQuota(publicBase, token, state.frontend)
      state.finalEntryProbe = await liveGateway(publicBase + '/v1', 'blue', { timeoutMs: 45_000 })
      await health(compatibility)
      state.assetsVerified = await verifyAssets()
    },
    commit: async () => {
      const promoted = promotedState(active.state, state)
      await save(activeStatePath, promoted)
      state.phase = 'active-verified'
      state.activatedAt = promoted.activatedAt
      await save(join(identity.directory, 'state.json'), state)
    },
    rollback: async () => { await restorePrevious(identity, state, token, appearance, replacementStarted) },
    cleanupCandidate: async () => {
      try { await cleanupCandidate(identity); state.candidateCleanup = { ok: true, checkedAt: new Date().toISOString() } }
      catch (error) { state.candidateCleanup = { ok: false, error: safeError(error) } }
      await save(join(identity.directory, 'state.json'), state)
    }
  })
  return state
}

async function rollback(path) {
  const { identity, state } = await loadUpgrade(path), prior = await snapshots(identity, state)
  const current = existingContainer(names.app), candidate = existingContainer(identity.candidateName)
  const plan = rollbackPlan(current, candidate, state, identity)
  imageMetadata(state.priorImage)
  if (plan.needCandidate) {
    await startCandidate(identity, prior.config)
    assertCandidate(identity)
    await ready(identity.candidateBase)
  }
  const authBase = plan.authFromCandidate ? identity.candidateBase : direct
  const token = await session(prior.config, authBase), appearance = await verifyShared(authBase, token)
  if (plan.replacementStarted) {
    assertCandidate(identity)
    await verifyShared(identity.candidateBase, token, appearance)
    await liveGateway(identity.candidateBase + '/v1', null, { timeoutMs: 45_000 })
  }
  await restorePrevious(identity, state, token, appearance, plan.replacementStarted)
  await cleanupCandidate(identity)
  state.candidateCleanup = { ok: true, checkedAt: new Date().toISOString() }
  await save(join(identity.directory, 'state.json'), state)
  return state
}

export function rollbackPlan(current, candidate, state, identity) {
  if (current) check([state.priorImage, state.image].includes(current.Image) && current.Config.Labels?.['com.docker.compose.project'] === 'sub2api-current', 'Do not roll back another production release')
  if (candidate) check(candidate.Image === state.image && candidate.Config.Labels?.['com.docker.compose.project'] === identity.project, 'Do not use another candidate for rollback')
  const currentHealthy = current?.State.Running && current.State.Health?.Status === 'healthy'
  const replacementStarted = !currentHealthy || current.Image !== state.priorImage
  return { replacementStarted, needCandidate: replacementStarted && (!candidate?.State.Running || candidate.State.Health?.Status !== 'healthy'), authFromCandidate: !currentHealthy }
}

export function publicSummary(state) {
  const pick = (value, keys) => value ? Object.fromEntries(keys.filter(key => value[key] === null || ['string', 'boolean'].includes(typeof value[key]) || (typeof value[key] === 'number' && Number.isFinite(value[key]))).map(key => [key, value[key]])) : undefined
  const quota = value => pick(value, ['accountsChecked', 'quotaWindows', 'errors', 'unknownAccounts', 'staleAccounts', 'lazyChunksVerified'])
  const probe = value => {
    const result = pick(value, ['checkedAt', 'model', 'httpStatus', 'firstTokenMs', 'totalMs', 'outputCharacters', 'completed', 'slot', 'inputTokens', 'outputTokens', 'automaticRetries'])
    if (result && Array.isArray(value.eventTypes)) result.eventTypes = value.eventTypes.filter(type => /^response\.[a-z_.]+$/.test(type))
    return result
  }
  return { phase: state.phase, commit: state.commit, image: state.image, priorImage: state.priorImage,
    manifestPath: state.manifestPath, operationDirectory: state.directory, backup: state.backup,
    preparedAt: state.preparedAt, activatedAt: state.activatedAt, rolledBackAt: state.rolledBackAt,
    quota: quota(state.quota), finalEntryQuota: quota(state.finalEntryQuota), assetsVerified: state.assetsVerified,
    candidateCleanup: pick(state.candidateCleanup, ['ok', 'checkedAt']),
    candidateProbe: probe(state.candidateProbe), finalEntryProbe: probe(state.finalEntryProbe),
    oldImageRetained: true, databaseRestored: false, tailscaleServeChanged: false }
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077)
  const [action, manifestPath, backup, restoreReport] = argv
  check(['prepare', 'activate', 'rollback', 'status', 'cleanup'].includes(action), 'Usage: upgrade-current.mjs prepare MANIFEST BACKUP [RESTORE_REPORT] | activate|rollback|cleanup MANIFEST | status [MANIFEST]')
  check(action === 'status' || manifestPath, 'Pass the exact immutable manifest path')
  check(action !== 'prepare' || backup, 'Prepare requires a fresh private backup; use SUB2API_BACKUP_APP=sub2api-current-app with backup-private.mjs')
  const lockPath = join(deployment, '.release-operation.lock'), lock = await acquireLock(lockPath)
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, action: 'current-' + action, startedAt: new Date().toISOString() }))
    let state
    if (action === 'prepare') state = await prepare(manifestPath, backup, restoreReport)
    if (action === 'activate') state = await activate(manifestPath)
    if (action === 'rollback') state = await rollback(manifestPath)
    if (action === 'cleanup') {
      const release = await loadUpgrade(manifestPath)
      check(['active-verified', 'rolled-back-verified'].includes(release.state.phase), 'Candidate cleanup requires a verified serving current app')
      await activeConfiguration()
      await health(publicBase)
      await cleanupCandidate(release.identity)
      state = release.state
      state.candidateCleanup = { ok: true, checkedAt: new Date().toISOString() }
      await save(join(release.identity.directory, 'state.json'), state)
    }
    if (action === 'status') {
      const { state: active, container } = await activeConfiguration(), candidate = manifestPath ? await loadUpgrade(manifestPath) : null
      const prepared = candidate ? existingContainer(candidate.identity.candidateName) : null
      const route = await readFile(join(directory, 'haproxy.cfg'), 'utf8')
      await health(publicBase)
      console.log(JSON.stringify({ current: { phase: active.phase, image: active.image, releaseManifest: active.releaseManifest, backgroundOwner: active.backgroundOwner,
        running: container.State.Running, health: container.State.Health?.Status, publicHealth: 'ok' },
        route: route === routing(names.app + ':8080') ? 'current' : candidate && route === routing(candidate.identity.candidateName + ':8080') ? 'candidate' : 'unexpected',
        candidate: candidate ? { present: !!prepared, running: prepared?.State.Running || false, image: prepared?.Image, health: prepared?.State.Health?.Status } : null,
        operation: candidate ? publicSummary(candidate.state) : null }, null, 2))
    } else console.log(JSON.stringify(publicSummary(state), null, 2))
  } finally { await lock.close(); await unlink(lockPath) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1 })
}
