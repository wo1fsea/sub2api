import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { join } from 'node:path'

process.umask(0o077)
const host = 'getcodex-prod'
const privateRoot = '/Users/clawbotbot/Projects/sub2api-upgrade-private'
const names = ['subdock-prod-app-1', 'subdock-prod-worker-1', 'subdock-prod-caddy-1', 'subdock-prod-postgres-1']
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
function remote(command, input) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command],
    { input, encoding: 'utf8', timeout: 120000, maxBuffer: 32 << 20 })
  assert(!r.error && r.status === 0, 'Retirement remote operation failed; private output suppressed')
  return r.stdout.trim()
}
await mkdir(privateRoot, { recursive: true, mode: 0o700 })
const directory = await mkdtemp(join(privateRoot, 'getcodex-retired-'))
const identity = join(directory, 'archive-identity.txt')
const key = spawnSync('age-keygen', ['-o', identity], { encoding: 'utf8' })
assert.equal(key.status, 0)
const pub = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' })
assert.equal(pub.status, 0)
const recipient = pub.stdout.trim()
assert.match(recipient, /^age1[a-z0-9]+$/)
const containers = JSON.parse(remote('sudo -n docker inspect ' + names.map(quote).join(' ')))
for (const c of containers) assert.equal(c.Config.Labels['com.docker.compose.project'], 'subdock-prod')
await writeFile(join(directory, 'containers-private.json'), JSON.stringify(containers), { flag: 'wx', mode: 0o600 })

const maintenance = '{\n admin off\n log {\n  exclude http.log.error\n }\n}\nwww.getcodex.pro {\n redir https://getcodex.pro{uri} permanent\n}\ngetcodex.pro {\n header Cache-Control "no-store"\n header Strict-Transport-Security "max-age=31536000"\n respond "The former sales service has been retired. A standby API service is being prepared." 410\n}\n'
remote('sudo -n tee /opt/subdock/deploy/Caddyfile >/dev/null', maintenance)
// The former storefront deliberately disabled Caddy's admin API.
remote('sudo -n docker exec subdock-prod-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null && sudo -n docker restart subdock-prod-caddy-1 >/dev/null')
remote('sudo -n systemctl disable --now subdock-backup.timer; sudo -n docker update --restart=no subdock-prod-app-1 subdock-prod-worker-1 >/dev/null; sudo -n docker stop --time=45 subdock-prod-app-1 subdock-prod-worker-1 >/dev/null')
const response = await fetch('https://getcodex.pro', { redirect: 'error', signal: AbortSignal.timeout(15000) })
assert.equal(response.status, 410, 'Sales site is not retired')

async function archive(name, command, budget) {
  const sha = createHash('sha256')
  let bytes = 0
  const child = spawn('ssh', ['-o', 'BatchMode=yes', host, command], { stdio: ['ignore', 'pipe', 'pipe'] })
  const encrypt = spawn('age', ['-r', recipient], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume(); encrypt.stderr.resume()
  const done = c => new Promise((resolve, reject) => {
    c.once('error', reject); c.once('close', code => code === 0 ? resolve() : reject(new Error('Archive transport failed; details suppressed')))
  })
  const completions = [done(child), done(encrypt)]
  const timer = setTimeout(() => { child.kill('SIGTERM'); encrypt.kill('SIGTERM') }, 180000)
  try {
    await Promise.all([...completions, pipeline(child.stdout, encrypt.stdin), pipeline(encrypt.stdout,
      new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > budget) return callback(new Error('Retirement archive exceeded size budget'))
        sha.update(chunk); callback(null, chunk)
      } }), createWriteStream(join(directory, name), { flags: 'wx', mode: 0o600 }))])
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); if (encrypt.exitCode === null) encrypt.kill() }
  assert(bytes > 0)
  return { name, bytes, sha256: sha.digest('hex') }
}
const dbCommand = 'sudo -n docker exec subdock-prod-postgres-1 sh -c '
const archives = []
archives.push(await archive('database.dump.age', dbCommand + quote('exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom'), 256 << 20))
archives.push(await archive('roles.sql.age', dbCommand + quote('exec pg_dumpall -U "$POSTGRES_USER" --globals-only'), 16 << 20))
archives.push(await archive('project-and-config.tar.gz.age', 'sudo -n tar -czf - -C / opt/subdock etc/subdock var/backups/subdock home/ubuntu/subdock-staging etc/systemd/system/subdock-backup.service etc/systemd/system/subdock-backup.timer', 256 << 20))
// Query table counts only; schema-specific state columns are discovered separately.
const countsQuery = "BEGIN READ ONLY; SELECT json_build_object('orders',(SELECT count(*) FROM handoff_orders),'receipts',(SELECT count(*) FROM handoff_receipts),'products',(SELECT count(*) FROM subscription_products)); ROLLBACK;"
const counts = JSON.parse(remote('sudo -n docker exec -i subdock-prod-postgres-1 sh -c ' + quote('exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'), countsQuery))
const report = { host, directory, retiredAt: new Date().toISOString(), salesHttp: response.status,
  stopped: names.slice(0, 2), databaseCounts: counts, archives, restoreVerified: false,
  caddyRetainedForReplacement: true, projectFilesDeleted: false }
await writeFile(join(directory, 'retirement.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
