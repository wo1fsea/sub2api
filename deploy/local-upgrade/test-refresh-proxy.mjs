import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { refreshConfig, refreshAssets } from './refresh-routing.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
const output = join(root, 'frontend/tmp/proxy-tests')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, 'refresh-'))
const project = `sub2api-refresh-test-${randomBytes(5).toString('hex')}`
const proxyImage = 'haproxy@sha256:8007effce89a08af0236b9529a0daab5b8b36fa939f4162f28201f1bf8731dbf'
function run(command, args, input) {
  const r = spawnSync(command, args, { cwd: join(root, 'backend'), input, encoding: 'utf8', timeout: 90_000,
    maxBuffer: 1 << 20, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'arm64', GOMAXPROCS: '2' } })
  assert(!r.error && r.status === 0, `${command} ${args[0]} failed; details suppressed`)
  return r.stdout.trim()
}
const docker = (args, input) => run('docker', args, input)
const inspect = name => JSON.parse(docker(['inspect', name]))[0]
const production = inspect('sub2api-release-v0213-ingress-1')
run('go', ['build', '-p', '2', '-o', join(directory, 'fixture'), join(root, 'deploy/local-upgrade/proxy-fixture.go')])
const template = await readFile(join(root, 'deploy/local-upgrade/haproxy-legacy-assets.cfg'), 'utf8')
const cfg = join(directory, 'haproxy.cfg')
await writeFile(cfg, template)
await writeFile(join(directory, 'active.map'), 'active green\n')
await writeFile(join(directory, 'old-assets.map'), '/assets/old.js legacy_assets\n')
const fixture = slot => ({ image: manifest.imageId, pull_policy: 'never', entrypoint: ['/fixture'],
  environment: { FIXTURE_SLOT: slot }, volumes: [`${join(directory, 'fixture')}:/fixture:ro`],
  cpus: .25, mem_limit: '64m', logging: { driver: 'none' } })
const composePath = join(directory, 'compose.json')
await writeFile(composePath, JSON.stringify({ services: {
  previous: fixture('green'), candidate: fixture('blue'), legacy: fixture('green'),
  ingress: { image: proxyImage, pull_policy: 'never', cpus: .25, mem_limit: '128m', logging: { driver: 'none' },
    ports: ['127.0.0.1::8080'], environment: { SUB2API_BLUE_UPSTREAM: 'legacy:8080', SUB2API_GREEN_UPSTREAM: 'previous:8080', SUB2API_LEGACY_ASSETS_UPSTREAM: 'legacy:8080' },
    volumes: [`${cfg}:/usr/local/etc/haproxy/haproxy.cfg:ro`, `${directory}:/var/lib/sub2api-ingress:ro`] }
}, networks: { default: { driver: 'bridge' } } }))
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]
const id = name => docker([...compose, 'ps', '--quiet', name])
const runtime = command => docker(['exec', '-i', id('ingress'), 'sh', '-c', 'nc -w 1 127.0.0.1 9999'], `${command}\n`)
let base, sampling = true
const samples = []
const health = () => fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
const report = { passed: false, productionDeploymentPerformed: false, checks: [] }
try {
  docker([...compose, 'up', '--detach'])
  const port = inspect(id('ingress')).NetworkSettings.Ports['8080/tcp'][0]
  base = `http://127.0.0.1:${port.HostPort}`
  const deadline = Date.now() + 20_000
  while (true) {
    try { assert.equal((await health()).status, 200); break } catch { assert(Date.now() < deadline); await delay(250) }
  }
  const before = inspect(id('ingress'))
  const sample = (async () => {
    while (sampling && samples.length < 100) {
      try { const r = await health(); samples.push({ status: r.status, slot: r.headers.get('x-sub2api-slot') }); await r.text() }
      catch { samples.push({ failed: true }) }
      await delay(100)
    }
  })()
  const stream = await fetch(`${base}/sse`, { signal: AbortSignal.timeout(15_000) })
  const reader = stream.body.getReader()
  let text = new TextDecoder().decode((await reader.read()).value)
  assert(text.includes('green-0'))
  const existing = Array.from({ length: 160 }, (_, i) => `/assets/old-${i}.js legacy_assets\n`).join('')
  const latest = '/assets/current.js legacy_assets\n'
  const assetMap = refreshAssets(existing, latest)
  await writeFile(join(directory, 'old-assets.map'), assetMap)
  await writeFile(cfg, refreshConfig(template, 'candidate:8080', 'previous:8080'))
  docker(['exec', id('ingress'), 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  docker(['kill', '--signal=USR2', id('ingress')])
  await delay(1500)
  assert.equal((await health()).headers.get('x-sub2api-slot'), 'green')
  assert.equal(runtime('set map /var/lib/sub2api-ingress/active.map active blue'), '')
  await writeFile(join(directory, 'active.map'), 'active blue\n')
  assert.equal((await health()).headers.get('x-sub2api-slot'), 'blue')
  for (const [path, expected] of [['/assets/current.js', 'previous-assets'], ['/assets/old-0.js', 'legacy-assets'], ['/api/test', 'blue']]) {
    assert.equal((await fetch(`${base}${path}`)).headers.get('x-sub2api-slot'), expected)
  }
  assert.equal((await fetch(`${base}/assets/current.js`, { method: 'HEAD' })).headers.get('x-sub2api-slot'), 'previous-assets')
  assert.equal((await fetch(`${base}/assets/current.js`, { method: 'POST', body: 'one' })).headers.get('x-sub2api-slot'), 'blue')
  while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value) }
  assert(text.includes('green-59') && !text.includes('blue-'))
  // Persisted backend + slot survive another graceful reload.
  docker(['kill', '--signal=USR2', id('ingress')])
  await delay(1000)
  assert.equal((await health()).headers.get('x-sub2api-slot'), 'blue')
  assert.equal(runtime('set map /var/lib/sub2api-ingress/active.map active green'), '')
  await writeFile(join(directory, 'active.map'), 'active green\n')
  assert.equal((await health()).headers.get('x-sub2api-slot'), 'green')
  sampling = false
  await sample
  assert(samples.length >= 20 && samples.every(s => s.status === 200))
  const after = inspect(id('ingress'))
  assert.equal(after.State.StartedAt, before.State.StartedAt)
  assert.equal(after.RestartCount, before.RestartCount)
  report.passed = true
  report.samples = samples.length
  report.checks = ['graceful configuration reload on pinned HAProxy', 'old SSE completes across reload and activation',
    'old active slot preserved until atomic activation', 'latest and earlier GET/HEAD assets use separate retained sources',
    'POST and API never use asset bridge', 'backend and slot persist across reload', 'runtime rollback', 'ingress container unchanged']
} finally {
  sampling = false
  docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '3'])
  assert.equal(inspect(production.Id).State.StartedAt, production.State.StartedAt)
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, directory }, null, 2))
}
