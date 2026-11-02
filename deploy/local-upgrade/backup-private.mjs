import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { assertProtectedFileMetadata, assertVolumeCoverage, backupArchiveSpecs, protectedBackupFileNames } from './backup-manifest.mjs'
import { parsePostgresDumpListing } from './pg-dump-toc.mjs'

process.umask(0o077)
const privateRoot = resolve(process.argv[2] || '/Users/clawbotbot/Projects/sub2api-upgrade-private')
assert(isAbsolute(privateRoot) && privateRoot.endsWith('/sub2api-upgrade-private'))
await mkdir(privateRoot, { recursive: true, mode: 0o700 })
await chmod(privateRoot, 0o700)
const directory = await mkdtemp(join(privateRoot, 'backup-'))
await chmod(directory, 0o700)
const deploymentRoot = '/Users/clawbotbot/Projects/sub2api-local'
const currentDirectory = join(deploymentRoot, 'current-0.2.13')

function docker(args, input, timeout = 30_000) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 256 << 20 })
  assert(!result.error && result.status === 0, `Docker read failed (${args[0]}); details suppressed to protect secrets`)
  return result.stdout.trim()
}
const sha256 = data => createHash('sha256').update(data).digest('hex')

async function archive(name, args, maxBytes) {
  const target = join(directory, name)
  const temporary = `${target}.partial`
  const hash = createHash('sha256')
  let bytes = 0
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Backup ${name} failed; details suppressed`)))
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
  try {
    await Promise.all([completion, pipeline(child.stdout, new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > maxBytes) return callback(new Error(`Backup ${name} exceeded its size budget`))
        hash.update(chunk)
        callback(null, chunk)
      }
    }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))])
    assert(bytes > 0)
    await rename(temporary, target)
    return { name, bytes, sha256: hash.digest('hex') }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}

function postgresMetadata(container) {
  const query = `SELECT json_build_object(
    'database', current_database(),
    'serverVersion', current_setting('server_version'),
    'dataDirectory', current_setting('data_directory'),
    'migrationsCount', (SELECT count(*) FROM schema_migrations)
  )::text;`
  return JSON.parse(docker(['exec', '-i', container.Id, 'sh', '-c',
    'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'], query))
}

function volumeMatching(container, path, role) {
  const matches = (container.Mounts || []).filter(mount => mount.Type === 'volume' &&
    (path === mount.Destination || path.startsWith(mount.Destination.replace(/\/$/, '') + '/')))
    .sort((left, right) => right.Destination.length - left.Destination.length)
  assert(matches.length > 0, `Cannot identify the ${role} data volume from its actual path`)
  return matches[0]
}
const publicMount = mount => ({ type: mount.Type, name: mount.Name, source: mount.Source, destination: mount.Destination, rw: mount.RW })

function postgresDumpListing(container, dump) {
  return spawnSync('docker', ['exec', '-i', container, 'pg_restore', '--list'], {
    input: dump, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 << 20
  })
}

async function protectSource(name, source) {
  assert(protectedBackupFileNames.includes(name), 'Unexpected protected backup file')
  const info = await lstat(source)
  assert(info.isFile() && !info.isSymbolicLink(), 'Protected source must be a regular file')
  assert((info.mode & 0o777) === 0o600 && info.uid === process.getuid(), 'Protected source must be owned mode-0600 by the operator')
  const data = await readFile(source)
  assert(data.length > 0 && data.length <= (1 << 20), 'Protected source size is invalid')
  const target = join(directory, name)
  await writeFile(target, data, { flag: 'wx', mode: 0o600 })
  await chmod(target, 0o600)
  const copied = await lstat(target)
  assert(copied.isFile() && !copied.isSymbolicLink() && (copied.mode & 0o777) === 0o600 && copied.uid === process.getuid(), 'Protected backup copy permissions changed')
  assert(sha256(await readFile(target)) === sha256(data), 'Protected backup copy bytes changed')
  return { name, source, bytes: data.length, sha256: sha256(data), sourceMode: '0600', sourceUid: info.uid }
}

async function protectGenerated(name, data) {
  assert(protectedBackupFileNames.includes(name), 'Unexpected generated protected file')
  assert(Buffer.isBuffer(data) && data.length > 0 && data.length <= (1 << 20), 'Generated protected file size is invalid')
  const target = join(directory, name)
  await writeFile(target, data, { flag: 'wx', mode: 0o600 })
  await chmod(target, 0o600)
  const info = await lstat(target)
  assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid(), 'Generated protected file permissions changed')
  return { name, source: target, bytes: data.length, sha256: sha256(data), sourceMode: '0600', sourceUid: info.uid }
}

const appName = process.env.SUB2API_BACKUP_APP || 'sub2api'
const knownApps = {
  'sub2api-current-app': 'sha256:84a75cafee9d37d19df5de7f50924cacdf68ffd7c925485be421b496325979ea',
  sub2api: 'sha256:ccf47a1c62e355f51f896e489f8253e119fe4101b103cd701ba458cc6c6f0f77',
  'sub2api-green-clash2': 'sha256:da20743ebb5610646c8a2898f0cd0c6850bda10d2ed20dbebd75242731563214',
  'sub2api-green-v0213': 'sha256:145ba95c309d12c854d802075272c3358f125a0b8f11ef9bcf248f49a7c07e6c'
}
assert(Object.hasOwn(knownApps, appName), 'Resolve the current known application before backing it up')
if (appName === 'sub2api-current-app') {
  const active = JSON.parse(await readFile(join(currentDirectory, 'state.json'), 'utf8'))
  assert.equal(active.phase, 'active-old-retired')
  assert.match(active.image, /^sha256:[a-f0-9]{64}$/)
  knownApps[appName] = active.image
}
const containers = JSON.parse(docker(['inspect', appName, 'sub2api-postgres', 'sub2api-redis']))
for (const container of containers) {
  assert.equal(container.State.Running, true)
  assert.equal(container.State.Health.Status, 'healthy')
}
const [app, postgres, redis] = containers
assert.equal(app.Image, knownApps[appName], 'The selected backup application image changed')
const appVolume = volumeMatching(app, '/app/data', 'application')
const redisVolume = volumeMatching(redis, '/data', 'Redis')
assert.equal(postgres.Config.Labels['com.docker.compose.project'], 'sub2api')
assert.equal(redis.Config.Labels['com.docker.compose.project'], 'sub2api')
const pgBefore = postgresMetadata(postgres)
const pgDataMount = volumeMatching(postgres, pgBefore.dataDirectory, 'PostgreSQL actual PGDATA')
const pgSupportMounts = (postgres.Mounts || []).filter(mount => mount.Type === 'volume' && mount.Name !== pgDataMount.Name).map(publicMount)
const started = new Date().toISOString()

const recoveryBytes = Buffer.from(JSON.stringify(containers, null, 2))
const protectedFiles = []
protectedFiles.push(await protectSource('.env', join(deploymentRoot, '.env')))
protectedFiles.push(await protectSource('compose-private.json', join(currentDirectory, 'compose-private.json')))
protectedFiles.push(await protectSource('state.json', join(currentDirectory, 'state.json')))
protectedFiles.push(await protectGenerated('recovery-private.json', recoveryBytes))
assertProtectedFileMetadata(protectedFiles)

const archives = []
const dumpStartedAt = new Date().toISOString()
archives.push(await archive('postgres.dump', ['exec', postgres.Id, 'sh', '-c',
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl --lock-wait-timeout=3s'], backupArchiveSpecs['postgres.dump'].maxBytes))
const dumpFinishedAt = new Date().toISOString()
const dumpBytes = await readFile(join(directory, 'postgres.dump'))
const dumpToc = parsePostgresDumpListing(postgresDumpListing(postgres.Id, dumpBytes), pgBefore.database)
archives.push(await archive('app-data.tar.gz', ['exec', app.Id, 'tar', '-czf', '-', '--exclude=./logs', '--exclude=./backups', '-C', '/app/data', '.'], backupArchiveSpecs['app-data.tar.gz'].maxBytes))
archives.push(await archive('redis.rdb', ['exec', redis.Id, 'redis-cli', '--rdb', '-'], backupArchiveSpecs['redis.rdb'].maxBytes))
const pgAfter = postgresMetadata(postgres)
for (const key of ['database', 'serverVersion', 'dataDirectory', 'migrationsCount']) assert.equal(pgAfter[key], pgBefore[key], `Live PostgreSQL ${key} changed during backup`)
const [currentApp, currentPostgres, currentRedis] = JSON.parse(docker(['inspect', app.Id, postgres.Id, redis.Id]))
for (const original of containers) {
  const current = [currentApp, currentPostgres, currentRedis].find(item => item.Id === original.Id)
  assert(current && current.State.Running && current.State.Health.Status === 'healthy', 'A backup source container changed health')
  assert.equal(current.State.StartedAt, original.State.StartedAt)
  assert.equal(current.RestartCount, original.RestartCount)
}
const volumeCoverage = [
  { role: 'application', container: app.Name.slice(1), mount: publicMount(appVolume), artifact: 'app-data.tar.gz',
    method: backupArchiveSpecs['app-data.tar.gz'].method },
  { role: 'postgresql', container: postgres.Name.slice(1), mount: publicMount(pgDataMount), artifact: 'postgres.dump',
    method: backupArchiveSpecs['postgres.dump'].method, database: pgBefore.database, serverVersion: pgBefore.serverVersion,
    actualDataDirectory: pgBefore.dataDirectory, migrationsCount: pgBefore.migrationsCount, supportMounts: pgSupportMounts },
  { role: 'redis', container: redis.Name.slice(1), mount: publicMount(redisVolume), artifact: 'redis.rdb',
    method: backupArchiveSpecs['redis.rdb'].method }
]
const manifest = {
  started, finished: new Date().toISOString(), archives, protectedFiles, volumeCoverage,
  postgres: { ...pgBefore, dumpStartedAt, dumpFinishedAt, dumpToc,
    consistency: 'PostgreSQL pg_dump transaction snapshot; actual database and PGDATA volume identity verified before and after' },
  oldImageId: app.Image, oldContainerId: app.Id,
  oldVersion: app.Config.Labels['org.opencontainers.image.version'] || '0.2.4',
  databaseImageId: postgres.Image, redisImageId: redis.Image,
  kind: 'live-consistent-postgres-dump-and-separate-redis-snapshot',
  crossStoreAtomicSnapshot: false, productionDeploymentPerformed: false,
  restoreVerified: false
}
assertProtectedFileMetadata(manifest.protectedFiles)
assertVolumeCoverage(manifest)
await writeFile(join(directory, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
for (const file of [...['postgres.dump', 'app-data.tar.gz', 'redis.rdb'], ...protectedBackupFileNames, 'backup-manifest.json']) {
  const info = await stat(join(directory, file))
  assert((info.mode & 0o777) === 0o600, 'Private backup file permissions changed')
}
assert.equal((await stat(directory)).mode & 0o777, 0o700)
console.log(JSON.stringify({ directory, ...manifest }, null, 2))
