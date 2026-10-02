import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, 'frontend/tmp/audit-tests')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, 'run-'))
const project = `sub2api-audit-test-${randomBytes(6).toString('hex')}`
const password = randomBytes(32).toString('hex')
const composePath = join(directory, 'compose.json')
const logging = { driver: 'json-file', options: { 'max-size': '1m', 'max-file': '2' } }
await writeFile(composePath, JSON.stringify({ services: {
  db: { image: 'postgres@sha256:aa6eb304ddb6dd26df23d05db4e5cb05af8951cda3e0dc57731b771e0ef4ab29',
    pull_policy: 'never', cpus: 0.5, mem_limit: '384m', ports: ['127.0.0.1:18385:5432'], logging,
    environment: { POSTGRES_USER: 'audit', POSTGRES_DB: 'audit', POSTGRES_PASSWORD: password },
    volumes: ['db-data:/var/lib/postgresql'],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U audit -d audit'], interval: '1s', timeout: '1s', retries: 45 } },
  redis: { image: 'redis@sha256:0514fa59e3d84e2f3be66731c5401fc2a85b8ea71b49c0116c850f6a558076f4',
    pull_policy: 'never', cpus: 0.25, mem_limit: '64m', ports: ['127.0.0.1:18386:6379'], logging,
    command: ['redis-server', '--save', '', '--appendonly', 'no'],
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '1s', timeout: '1s', retries: 45 } }
}, volumes: { 'db-data': {} } }), { mode: 0o600 })
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 20 })
  assert(!result.error && result.status === 0, 'Owned audit-test Docker command failed')
}
try {
  docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '90'])
  const result = spawnSync('go', ['test', '-tags=integration', '-count=1', '-v', '-timeout=120s', './internal/securityaudit'], {
    cwd: join(root, 'backend'), encoding: 'utf8', timeout: 180_000, maxBuffer: 4 << 20,
    // Do not inherit live model test credentials from the caller's environment.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      GOTOOLCHAIN: 'go1.27.0', GOMAXPROCS: '2', GOMEMLIMIT: '1GiB',
      PROMPT_AUDIT_TEST_POSTGRES_DSN: `postgres://audit:${password}@127.0.0.1:18385/audit?sslmode=disable`,
      PROMPT_AUDIT_TEST_REDIS_ADDR: '127.0.0.1:18386' }
  })
  const report = `${result.stdout || ''}${result.stderr || ''}`.replaceAll(password, '[redacted]')
  await writeFile(join(directory, 'report.txt'), report, { mode: 0o600 })
  assert(!result.error && result.status === 0, `Audit suite failed; inspect ${join(directory, 'report.txt')}`)
  assert(!report.includes('--- SKIP:'), 'Audit dependency suite must not skip tests')
  console.log(JSON.stringify({ passed: true, project, directory, testsPassed: (report.match(/--- PASS:/g) || []).length,
    testsSkipped: 0, productionDeploymentPerformed: false }, null, 2))
} finally {
  docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10'])
}
