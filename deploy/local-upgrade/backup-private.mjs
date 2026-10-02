import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

process.umask(0o077)
const privateRoot = resolve(process.argv[2] || '/Users/clawbotbot/Projects/sub2api-upgrade-private')
assert(isAbsolute(privateRoot) && privateRoot.endsWith('/sub2api-upgrade-private'))
await mkdir(privateRoot, { recursive: true, mode: 0o700 })
await chmod(privateRoot, 0o700)
const directory = await mkdtemp(join(privateRoot, 'backup-'))

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 << 20 })
  assert(!result.error && result.status === 0, `Docker read failed (${args[0]}); details suppressed to protect secrets`)
  return result.stdout.trim()
}

async function archive(name, args, maxBytes) {
  const target = join(directory, name)
  const temporary = `${target}.partial`
  const hash = createHash('sha256')
  let bytes = 0
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Backup ${name} failed; details suppressed`)))
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

const containers = JSON.parse(docker(['inspect', 'sub2api', 'sub2api-postgres', 'sub2api-redis']))
for (const container of containers) {
  assert.equal(container.Config.Labels['com.docker.compose.project'], 'sub2api')
  assert.equal(container.State.Running, true)
  assert.equal(container.State.Health.Status, 'healthy')
}
const [app, postgres, redis] = containers
assert(app.Mounts.some(m => m.Type === 'volume' && m.Name === 'sub2api_app-data' && m.Destination === '/app/data'))
const started = new Date().toISOString()
// This private recovery record contains secrets. It must never enter Git or a delivery package.
await writeFile(join(directory, 'recovery-private.json'), JSON.stringify(containers, null, 2), { flag: 'wx', mode: 0o600 })
const archives = []
archives.push(await archive('postgres.dump', ['exec', postgres.Id, 'sh', '-c',
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl --lock-wait-timeout=3s'], 256 << 20))
archives.push(await archive('app-data.tar.gz', ['exec', app.Id, 'tar', '-czf', '-', '--exclude=./logs', '--exclude=./backups', '-C', '/app/data', '.'], 256 << 20))
archives.push(await archive('redis.rdb', ['exec', redis.Id, 'redis-cli', '--rdb', '-'], 64 << 20))
const [currentApp] = JSON.parse(docker(['inspect', app.Id]))
assert.equal(currentApp.State.StartedAt, app.State.StartedAt)
assert.equal(currentApp.RestartCount, app.RestartCount)
const manifest = {
  started, finished: new Date().toISOString(), archives,
  oldImageId: app.Image, oldContainerId: app.Id,
  databaseImageId: postgres.Image, redisImageId: redis.Image,
  kind: 'live-consistent-postgres-dump-and-separate-redis-snapshot',
  crossStoreAtomicSnapshot: false, productionDeploymentPerformed: false,
  restoreVerified: false
}
await writeFile(join(directory, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
for (const file of ['postgres.dump', 'app-data.tar.gz', 'redis.rdb', 'recovery-private.json', 'backup-manifest.json']) {
  assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600)
}
console.log(JSON.stringify({ directory, ...manifest }, null, 2))
