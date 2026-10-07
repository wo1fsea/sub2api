import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

process.umask(0o077)
const directory = process.argv[2]
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-retired-[a-zA-Z0-9]+$/)
const reportPath = join(directory, 'retirement.json')
const report = JSON.parse(await readFile(reportPath))
for (const file of report.archives) assert.equal(createHash('sha256').update(await readFile(join(directory, file.name))).digest('hex'), file.sha256)
const name = 'subdock-retirement-restore-' + randomBytes(6).toString('hex')
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60000, maxBuffer: 8 << 20 })
  assert(!r.error && r.status === 0, 'Archive restoration command failed; details suppressed')
  return r.stdout.trim()
}
async function restore(file, command) {
  const age = spawn('age', ['-d', '-i', join(directory, 'archive-identity.txt'), join(directory, file)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const child = spawn('docker', ['exec', '-i', name, ...command], { stdio: ['pipe', 'ignore', 'pipe'] })
  age.stderr.resume(); child.stderr.resume()
  const done = c => new Promise((resolve, reject) => {
    c.once('error', reject); c.once('close', code => code === 0 ? resolve() : reject(new Error('Encrypted archive restore failed')))
  })
  await Promise.all([done(age), done(child), pipeline(age.stdout, child.stdin)])
}
// Keep ordering inside string_agg; all sensitive row contents stay inside PostgreSQL.
const inventory = "SET timezone='UTC';\nSELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''hash'',md5(coalesce(string_agg(md5(row_to_json(t)::text),'''' ORDER BY md5(row_to_json(t)::text)),''''))) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\n"
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const remote = spawnSync('ssh', ['-o', 'BatchMode=yes', 'getcodex-prod',
  'sudo -n docker exec -i subdock-prod-postgres-1 sh -c ' + quote('exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1')],
  { input: inventory, encoding: 'utf8', timeout: 15000, maxBuffer: 2 << 20 })
assert.equal(remote.status, 0, 'Cannot inventory retired database')
const expected = remote.stdout.trim().split('\n').map(JSON.parse)
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--memory', '256m', '--cpus', '0.5',
    '--label', 'io.sub2api.retirement-test=true', '--log-driver', 'none',
    '-e', 'POSTGRES_USER=archive_restore_admin', '-e', 'POSTGRES_DB=subdock', '-e', 'POSTGRES_PASSWORD=' + randomBytes(32).toString('hex'),
    'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'])
  let ready = false
  for (let i = 0; i < 60; i++) {
    const r = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'archive_restore_admin', '-d', 'subdock'], { stdio: 'ignore' })
    if (r.status === 0) { ready = true; break }
    await delay(500)
  }
  assert(ready)
  await restore('roles.sql.age', ['psql', '-X', '-q', '-U', 'archive_restore_admin', '-d', 'subdock', '-v', 'ON_ERROR_STOP=1'])
  await restore('database.dump.age', ['pg_restore', '-U', 'archive_restore_admin', '-d', 'subdock', '--exit-on-error'])
  const actual = docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'archive_restore_admin', '-d', 'subdock', '-v', 'ON_ERROR_STOP=1'], inventory).split('\n').map(JSON.parse)
  assert.deepEqual(actual, expected, 'Restored sale database differs')
  report.restoreVerified = true
  report.restoreTables = actual.length
  report.restoreRows = actual.reduce((n, row) => n + row.count, 0)
  report.verifiedAt = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ directory, encryptedArchiveVerified: true, restoredTables: report.restoreTables, restoredRows: report.restoreRows, counts: report.databaseCounts }))
} finally {
  const found = spawnSync('docker', ['inspect', name], { encoding: 'utf8' })
  if (found.status === 0) {
    assert.equal(JSON.parse(found.stdout)[0].Config.Labels['io.sub2api.retirement-test'], 'true')
    docker(['rm', '-f', '-v', name])
  }
}
