import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

process.umask(0o077)
const backup = process.argv[2], manifestPath = resolve(process.argv[3] || '')
assert.match(backup || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/backup-[a-zA-Z0-9]+$/)
assert.match(manifestPath, /\/release\/sub2api_0\.2\.13_linux_amd64_[a-f0-9]{12}\/manifest\.json$/)
const release = JSON.parse(await readFile(manifestPath))
assert.equal(release.platform, 'linux/amd64')
assert.equal(release.version, '0.2.13')
const backupReport = JSON.parse(await readFile(join(backup, 'backup-manifest.json')))
for (const a of backupReport.archives) assert.equal(createHash('sha256').update(await readFile(join(backup, a.name))).digest('hex'), a.sha256)
const originals = JSON.parse(await readFile(join(backup, 'recovery-private.json')))
const seed = Object.fromEntries(originals[0].Config.Env.map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)] }))
const host = 'getcodex-prod', project = 'getcodex-sub2api', remoteDir = '/opt/sub2api'
const quote = v => "'" + v.replaceAll("'", "'\\''") + "'"
const directory = await mkdtemp('/Users/clawbotbot/Projects/sub2api-upgrade-private/getcodex-deploy-')
function command(binary, args, input, timeout = 180000) {
  const r = spawnSync(binary, args, { input, encoding: 'utf8', timeout, maxBuffer: 32 << 20 })
  if (r.error || r.status !== 0) {
    const failure = join(directory, `failure-${Date.now()}.json`)
    spawnSync('mkdir', ['-p', directory])
    // Capture diagnostics privately rather than leaking Docker environment details.
    writeFileSync(failure, JSON.stringify({ operation: binary, status: r.status, stderr: (r.stderr || '').slice(-16384) }), { mode: 0o600 })
    throw new Error(`Remote provisioning failed; private diagnostic ${failure}`)
  }
  return r.stdout.trim()
}
const remote = (cmd, input) => command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd], input)
const dc = args => remote('sudo -n docker compose -p ' + project + ' --env-file /dev/null -f /etc/sub2api/compose-private.json ' + args)
const dbPassword = randomBytes(32).toString('hex'), redisPassword = randomBytes(32).toString('hex')
const logging = { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } }
const common = { restart: 'unless-stopped', security_opt: ['no-new-privileges:true'], logging }
const pgImage = 'postgres@sha256:d8703cd7fba306b9fec9268ecedfa8a966846c053036a60e3635791957eb2f66'
const redisImage = 'redis@sha256:2d3814be5e9b06a30a0be54770b7e12052e7e79ec85271aefd34875c1f393b23'
const caddyImage = 'caddy@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b'
const environment = { ...seed, DATABASE_HOST: 'postgres', DATABASE_USER: 'sub2api', DATABASE_PASSWORD: dbPassword,
  DATABASE_DBNAME: 'sub2api', DATABASE_PORT: '5432', DATABASE_MAX_OPEN_CONNS: '20', DATABASE_MAX_IDLE_CONNS: '4',
  REDIS_HOST: 'redis', REDIS_PASSWORD: redisPassword, REDIS_PORT: '6379', REDIS_POOL_SIZE: '64', REDIS_MIN_IDLE_CONNS: '4',
  AUTO_SETUP: 'false', SERVER_FRONTEND_URL: 'https://getcodex.pro', SERVER_TRUSTED_PROXIES: '172.30.72.0/24',
  TOKEN_REFRESH_ENABLED: 'false', USAGE_CLEANUP_ENABLED: 'false', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1',
  LOG_OUTPUT_TO_FILE: 'false', LOG_LEVEL: 'info', GOMAXPROCS: '2', GOMEMLIMIT: '512MiB' }
// HOST-specific command path is not an application configuration setting.
delete environment.PATH
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete environment[name]
const compose = { services: {
  postgres: { ...common, image: pgImage, container_name: 'getcodex-sub2api-postgres', mem_limit: '512m', cpus: 0.75,
    environment: { POSTGRES_USER: 'sub2api', POSTGRES_DB: 'sub2api', POSTGRES_PASSWORD: dbPassword, TZ: 'Asia/Shanghai' },
    command: ['postgres', '-c', 'max_connections=40', '-c', 'shared_buffers=96MB', '-c', 'work_mem=4MB', '-c', 'maintenance_work_mem=64MB'],
    volumes: ['postgres-data:/var/lib/postgresql'], networks: ['private'],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U sub2api -d sub2api'], interval: '5s', timeout: '3s', retries: 30 } },
  redis: { ...common, image: redisImage, container_name: 'getcodex-sub2api-redis', mem_limit: '128m', cpus: 0.25,
    environment: { REDISCLI_AUTH: redisPassword }, command: ['redis-server', '--requirepass', redisPassword, '--maxmemory', '80mb', '--maxmemory-policy', 'noeviction', '--appendonly', 'no', '--save', '60', '1'],
    volumes: ['redis-data:/data'], networks: ['private'],
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '5s', timeout: '3s', retries: 20 } },
  app: { ...common, image: release.imageId, pull_policy: 'never', container_name: 'getcodex-sub2api-app', mem_limit: '768m', cpus: 1,
    environment, volumes: ['app-data:/app/data'], ports: ['127.0.0.1:18584:8080'], networks: ['private', 'egress'],
    depends_on: { postgres: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } } },
  caddy: { ...common, image: caddyImage, container_name: 'getcodex-sub2api-caddy', mem_limit: '96m', cpus: 0.25,
    ports: ['80:80', '443:443', '443:443/udp'], networks: ['egress'],
    volumes: [remoteDir + '/Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config'],
    depends_on: { app: { condition: 'service_healthy' } } }
}, networks: { private: { internal: true }, egress: { ipam: { config: [{ subnet: '172.30.72.0/24' }] } } },
  volumes: { 'postgres-data': {}, 'redis-data': {}, 'app-data': {},
    'caddy-data': { external: true, name: 'getcodex-sub2api_caddy-data' }, 'caddy-config': {} } }
const caddy = '{\n admin off\n log {\n  exclude http.log.error\n }\n}\nwww.getcodex.pro {\n redir https://getcodex.pro{uri} permanent\n}\ngetcodex.pro {\n header Strict-Transport-Security "max-age=31536000"\n encode zstd gzip\n @retired path /ops /ops/* /api/store/* /api/payments/zpay/* /api/worker/*\n respond @retired "The former sales service has been retired." 410\n request_body {\n  max_size 256MB\n }\n reverse_proxy app:8080 {\n  flush_interval -1\n  header_up X-Forwarded-For {remote_host}\n  header_up X-Forwarded-Proto {scheme}\n  transport http {\n   dial_timeout 5s\n   response_header_timeout 120s\n  }\n }\n}\n'
await writeFile(join(directory, 'compose-private.json'), JSON.stringify(compose, null, 2), { mode: 0o600 })
await writeFile(join(directory, 'Caddyfile'), caddy, { mode: 0o600 })
const upload = '/home/ubuntu/sub2api-upload-' + randomBytes(6).toString('hex')
remote('test ! -e /etc/sub2api/compose-private.json && mkdir -m 700 ' + quote(upload))
const paths = [join(dirname(manifestPath), 'image.tar'), manifestPath, join(directory, 'compose-private.json'), join(directory, 'Caddyfile'),
  ...backupReport.archives.map(a => join(backup, a.name))]
command('scp', ['-q', ...paths, host + ':' + upload + '/'], undefined, 300000)
remote('sudo -n install -d -m 700 /etc/sub2api /opt/sub2api /opt/sub2api/releases /var/backups/sub2api; sudo -n install -m 600 ' + quote(upload + '/compose-private.json') + ' /etc/sub2api/compose-private.json; sudo -n install -m 644 ' + quote(upload + '/Caddyfile') + ' /opt/sub2api/Caddyfile; sudo -n install -m 600 ' + quote(upload + '/manifest.json') + ' /opt/sub2api/releases/manifest.json; sudo -n docker load -i ' + quote(upload + '/image.tar') + ' >/dev/null')
const meta = JSON.parse(remote('sudo -n docker image inspect ' + quote(release.imageId)))[0]
assert.equal(meta.Architecture, 'amd64'); assert.equal(meta.Config.Labels['org.opencontainers.image.revision'], release.commit)
dc('pull postgres redis caddy')
remote('sudo -n docker volume create getcodex-sub2api_caddy-data >/dev/null')
dc('create app')
// Restore app/Redis archives using temporary containers before their first start.
const restoreHelper = 'getcodex-sub2api-restore'
remote('sudo -n docker run --rm --name ' + restoreHelper + ' --network none --entrypoint sh --memory 64m --log-driver none -v getcodex-sub2api_app-data:/restore -v ' + quote(upload + ':/backup:ro') + ' ' + quote(release.imageId) + ' -ec ' + quote('tar -xzf /backup/app-data.tar.gz -C /restore; chown -R 1000:1000 /restore'))
remote('sudo -n docker run --rm --name ' + restoreHelper + ' --network none --entrypoint sh --memory 64m --log-driver none -v getcodex-sub2api_redis-data:/restore -v ' + quote(upload + ':/backup:ro') + ' ' + quote(redisImage) + ' -ec ' + quote('cp /backup/redis.rdb /restore/dump.rdb; chown -R redis:redis /restore'))
dc('up -d --wait --wait-timeout 120 postgres redis')
remote('sudo -n docker cp ' + quote(upload + '/postgres.dump') + ' getcodex-sub2api-postgres:/tmp/restore.dump; sudo -n docker exec getcodex-sub2api-postgres pg_restore -U sub2api -d sub2api --no-owner --no-acl --exit-on-error /tmp/restore.dump')
const inventory = "SET timezone='UTC';\nSELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''hash'',md5(coalesce(string_agg(md5(row_to_json(t)::text),'''' ORDER BY md5(row_to_json(t)::text)),''''))) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\n"
const tables = remote('sudo -n docker exec -i getcodex-sub2api-postgres psql -X -qAt -U sub2api -d sub2api -v ON_ERROR_STOP=1', inventory).split('\n').map(JSON.parse)
assert.deepEqual(tables, JSON.parse(await readFile(join(backup, 'database-inventory.json'))), 'Cross-architecture database restore differs from the source snapshot')
await writeFile(join(directory, 'restored-tables.json'), JSON.stringify(tables), { mode: 0o600 })
const changes = "BEGIN; INSERT INTO settings(key,value) VALUES('registration_enabled','false'),('frontend_url','https://getcodex.pro'),('api_base_url','https://getcodex.pro/v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value; COMMIT;"
remote('sudo -n docker exec -i getcodex-sub2api-postgres psql -X -q -U sub2api -d sub2api -v ON_ERROR_STOP=1', changes)
dc('up -d --wait --wait-timeout 120 app')
// Copy renewable TLS state into the new service volume; never retain old project volumes.
remote('sudo -n docker volume create getcodex-sub2api_caddy-data >/dev/null; sudo -n docker run --rm --network none --entrypoint sh --log-driver none -v subdock-prod_caddy-data:/source:ro -v getcodex-sub2api_caddy-data:/target ' + quote(caddyImage) + ' -ec ' + quote('cp -a /source/. /target/'))
remote('sudo -n docker run --rm --network none --entrypoint caddy --log-driver none -v /opt/sub2api/Caddyfile:/etc/caddy/Caddyfile:ro ' + quote(caddyImage) + ' validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null')
const state = { phase: 'prepared', directory, host, backup, snapshotAt: backupReport.finished,
  image: release.imageId, commit: release.commit, manifestPath, upload, restoredTableCount: tables.length,
  restoredRows: tables.reduce((n, r) => n + r.count, 0), standbyBackgroundRefresh: false, publicActivated: false }
await writeFile(join(directory, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 })
remote('sudo -n tee /etc/sub2api/state.json >/dev/null', JSON.stringify(state))
remote('sudo -n chmod 600 /etc/sub2api/state.json')
console.log(JSON.stringify(state, null, 2))
