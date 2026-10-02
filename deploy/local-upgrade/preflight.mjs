import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
assert(process.argv[2], 'Pass the exact candidate manifest path')
const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
assert.match(manifest.imageId, /^sha256:[a-f0-9]{64}$/)
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 << 20 })
  assert(!result.error && result.status === 0, `Read-only preflight ${args[0]} failed; sensitive details suppressed`)
  return result.stdout.trim()
}
const [image] = JSON.parse(docker(['image', 'inspect', manifest.imageId]))
assert.equal(`${image.Os}/${image.Architecture}`, manifest.platform)
assert.equal(image.Config.Labels['org.opencontainers.image.revision'], manifest.commit)
assert.equal(image.Config.Labels['org.opencontainers.image.version'], manifest.version)
const containers = JSON.parse(docker(['inspect', 'sub2api', 'sub2api-postgres', 'sub2api-redis']))
for (const item of containers) {
  assert.equal(item.Config.Labels['com.docker.compose.project'], 'sub2api')
  assert.equal(item.State.Running, true)
  assert.equal(item.State.Health?.Status, 'healthy')
}
const [app, db] = containers
const inventory = await readFile(join(root, 'deploy/local-upgrade/compatibility-inventory.sql'), 'utf8')
const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; ${inventory} ROLLBACK;`
const backgroundJobs = JSON.parse(docker(['exec', '-i', db.Id, 'sh', '-c',
  'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'], sql))
const env = Object.fromEntries(app.Config.Env.map(value => {
  const i = value.indexOf('=')
  return [value.slice(0, i), value.slice(i + 1)]
}))
const findings = []
if (backgroundJobs.enabledScheduledTests > 0) findings.push('Scheduled account tests lack a cross-instance claim: assign one worker before overlapping instances')
if (backgroundJobs.enabledChannelMonitors > 0) findings.push('Channel checks have only per-process exclusion: assign one worker before overlapping instances')
if (backgroundJobs.backupScheduleEnabled || backgroundJobs.activeBackupOperations > 0) findings.push('Freeze backup writes and review old/new backup metadata compatibility before overlap or rollback')
if (backgroundJobs.schedulingThresholdOverrides > 0 || backgroundJobs.rpmOverrides > 0) findings.push('Old scheduler can publish reduced shared-cache projections: prove constraints on both versions')
findings.push('Real model readiness, first-entry migration and per-instance persistence drain are not proven by this check')
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true,
  candidateCommit: manifest.commit, candidateImageId: manifest.imageId,
  production: { containerId: app.Id, imageId: app.Image, startedAt: app.State.StartedAt,
    restartCount: app.RestartCount, health: app.State.Health.Status },
  secretEnvironmentPresence: Object.fromEntries(['JWT_SECRET', 'TOTP_ENCRYPTION_KEY']
    .map(key => [key, Boolean(env[key])])),
  effectiveFileConfigurationInspected: false, backgroundJobs, findings,
  productionDeploymentPerformed: false, approvedForProduction: false }, null, 2))
