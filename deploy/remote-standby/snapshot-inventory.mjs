import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'

process.umask(0o077)
const directory = process.argv[2]
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/)
const backup = JSON.parse(await readFile(join(directory, 'backup-manifest.json')))
const name = 'sub2api-snapshot-inventory-' + randomBytes(6).toString('hex')
export const inventory = "SET timezone='UTC';\nSELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''hash'',md5(coalesce(string_agg(md5(row_to_json(t)::text),'''' ORDER BY md5(row_to_json(t)::text)),''''))) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\n"
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 120000, maxBuffer: 4 << 20 })
  assert(!r.error && r.status === 0, 'Snapshot inventory failed; private output suppressed')
  return r.stdout.trim()
}
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--memory', '384m', '--cpus', '0.5',
    '--label', 'io.sub2api.snapshot-test=true', '--log-driver', 'none', '-e', 'POSTGRES_USER=snapshot',
    '-e', 'POSTGRES_DB=snapshot', '-e', 'POSTGRES_PASSWORD=' + randomBytes(32).toString('hex'),
    backup.databaseImageId, 'postgres', '-c', 'shared_buffers=64MB', '-c', 'max_connections=20'])
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'snapshot', '-d', 'snapshot'], { stdio: 'ignore' }).status === 0) { ready = true; break }
    await delay(500)
  }
  assert(ready)
  docker(['cp', join(directory, 'postgres.dump'), name + ':/tmp/snapshot.dump'])
  docker(['exec', name, 'pg_restore', '-U', 'snapshot', '-d', 'snapshot', '--no-owner', '--no-acl', '--exit-on-error', '/tmp/snapshot.dump'])
  const tables = docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'snapshot', '-d', 'snapshot', '-v', 'ON_ERROR_STOP=1'], inventory).split('\n').map(JSON.parse)
  await writeFile(join(directory, 'database-inventory.json'), JSON.stringify(tables), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ directory, snapshotAt: backup.finished, tables: tables.length, rows: tables.reduce((n, r) => n + r.count, 0), allTablesFingerprinted: true }))
} finally {
  const r = spawnSync('docker', ['inspect', name], { encoding: 'utf8' })
  if (r.status === 0) { assert.equal(JSON.parse(r.stdout)[0].Config.Labels['io.sub2api.snapshot-test'], 'true'); docker(['rm', '-f', '-v', name]) }
}
