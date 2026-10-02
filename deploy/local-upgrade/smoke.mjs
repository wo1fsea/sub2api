import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const manifestPath = resolve(process.argv[2] || 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(manifest.platform, 'linux/arm64')
assert.match(manifest.imageId, /^sha256:[a-f0-9]{64}$/)
const project = `sub2api-smoke-${randomBytes(6).toString('hex')}`
const port = Number(process.env.SUB2API_SMOKE_PORT || 18383)
assert(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 18080)
const env = {
  ...process.env,
  SUB2API_SMOKE_IMAGE: manifest.imageId,
  SUB2API_SMOKE_PORT: String(port),
  SUB2API_SMOKE_POSTGRES_IMAGE: manifest.smokeImages.postgres,
  SUB2API_SMOKE_REDIS_IMAGE: manifest.smokeImages.redis,
  SUB2API_SMOKE_DB_PASSWORD: randomBytes(32).toString('hex'),
  SUB2API_SMOKE_ADMIN_PASSWORD: randomBytes(32).toString('hex'),
  SUB2API_SMOKE_JWT_SECRET: randomBytes(32).toString('hex'),
  SUB2API_SMOKE_TOTP_KEY: randomBytes(32).toString('hex')
}
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null',
  '--file', resolve(dirname(fileURLToPath(import.meta.url)), 'smoke-compose.yaml')]

function docker(args, capture = false) {
  const result = spawnSync('docker', args, {
    env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 4 * 1024 * 1024, timeout: 180_000
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Docker command failed${capture ? `: ${result.stderr}` : ''}`)
  return capture ? result.stdout.trim() : undefined
}

async function request(path, options = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(5000) })
}

async function ready() {
  for (let round = 0; round < 90; round++) {
    try {
      const response = await request('/health')
      if (response.ok && (await response.json()).status === 'ok') return
    } catch { /* Candidate startup is asynchronous. */ }
    await delay(1000)
  }
  throw new Error('Isolated candidate did not become healthy within the smoke-test budget')
}

const [image] = JSON.parse(docker(['image', 'inspect', manifest.imageId], true))
assert.equal(image.Config.Labels['org.opencontainers.image.revision'], manifest.commit)
assert.equal(image.Config.Labels['org.opencontainers.image.version'], manifest.version)
assert.equal(`${image.Os}/${image.Architecture}`, manifest.platform)
assert(docker(['run', '--rm', '--network', 'none', manifest.imageId, '/app/sub2api', '-version'], true)
  .includes(manifest.version))
const checks = ['image identity', 'offline version']

try {
  docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '120'])
  await ready()
  checks.push('empty database setup and migrations', 'health with independent DB/Redis')
  const app = docker([...compose, 'ps', '--quiet', 'app'], true)
  const [container] = JSON.parse(docker(['inspect', app], true))
  assert.equal(container.Config.Labels['com.docker.compose.project'], project)
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [`${project}_default`])
  assert.equal(docker(['exec', app, 'sh', '-c', 'awk \'/^Uid:/{print $2}\' /proc/1/status'], true), '1000')
  checks.push('isolated network', 'nonroot runtime')

  const login = await request('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@example.invalid', password: env.SUB2API_SMOKE_ADMIN_PASSWORD })
  })
  assert.equal(login.status, 200)
  const token = (await login.json()).data.access_token
  assert.equal(typeof token, 'string')
  const headers = { Authorization: `Bearer ${token}` }
  const me = await request('/api/v1/auth/me', { headers })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).data.email, 'smoke@example.invalid')
  assert.equal((await request('/api/v1/auth/me')).status, 401)
  checks.push('synthetic admin login', 'authenticated session', 'unauthenticated rejection')

  const version = await request('/api/v1/admin/system/version', { headers })
  assert.equal(version.status, 200)
  assert.equal((await version.json()).data.version, manifest.version)
  const page = await request('/login')
  assert.equal(page.status, 200)
  const html = await page.text()
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match => match[1]))]
  assert(assets.length >= 2, 'Embedded page must reference real JS/CSS assets')
  for (const asset of assets) {
    const response = await request(asset)
    assert.equal(response.status, 200)
    assert((await response.arrayBuffer()).byteLength > 100)
  }
  checks.push('serving version', 'embedded HTML/JS/CSS')

  // This proves empty-rehearsal restart behavior, not production migration compatibility.
  docker([...compose, 'restart', 'app'])
  await ready()
  assert.equal((await request('/api/v1/auth/me', { headers })).status, 200)
  checks.push('restart migrations', 'session survives restart')
  console.log(JSON.stringify({ passed: true, project, version: manifest.version,
    commit: manifest.commit, imageId: manifest.imageId, checks,
    productionDeploymentPerformed: false, realGatewayCallsTested: false }, null, 2))
} finally {
  // The random project is created by this process and has no external resources.
  docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10'])
}
