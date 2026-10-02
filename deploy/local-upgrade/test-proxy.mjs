import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises'
import { get, Agent } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputRoot = join(root, 'frontend/tmp/proxy-tests')
await mkdir(outputRoot, { recursive: true })
const directory = await mkdtemp(join(outputRoot, 'run-'))
const project = `sub2api-proxy-test-${randomBytes(6).toString('hex')}`
const port = Number(process.env.SUB2API_PROXY_TEST_PORT || 18384)
assert(Number.isInteger(port) && port >= 1024 && port <= 65535 && ![18080, 18380, 18381].includes(port))
const haproxy = 'haproxy@sha256:8007effce89a08af0236b9529a0daab5b8b36fa939f4162f28201f1bf8731dbf'
assert(process.argv[2], 'Pass the exact candidate manifest path')
const candidate = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
assert.match(candidate.imageId, /^sha256:[a-f0-9]{64}$/)
const fixtureImage = candidate.imageId
function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: join(root, 'backend'), input,
    encoding: 'utf8', timeout: 180_000, maxBuffer: 4 << 20,
    env: { ...process.env, GOTOOLCHAIN: 'go1.27.0', GOMAXPROCS: '2', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'arm64' } })
  assert(!result.error && result.status === 0, `${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}
run('go', ['build', '-p', '2', '-o', join(directory, 'fixture'), join(root, 'deploy/local-upgrade/proxy-fixture.go')])
await writeFile(join(directory, 'active.map'), 'active blue\n')
const logging = { driver: 'json-file', options: { 'max-size': '1m', 'max-file': '2' } }
const fixture = slot => ({ image: fixtureImage, pull_policy: 'never', entrypoint: ['/fixture'],
  environment: { FIXTURE_SLOT: slot }, volumes: [`${join(directory, 'fixture')}:/fixture:ro`],
  cpus: 0.25, mem_limit: '64m', logging,
  healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/health'], interval: '1s', timeout: '1s', retries: 15 } })
const composePath = join(directory, 'compose.json')
await writeFile(composePath, JSON.stringify({ services: {
  blue: fixture('blue'), green: fixture('green'),
  ingress: { image: haproxy, pull_policy: 'never', cpus: 0.25, mem_limit: '128m', logging,
    ports: [`127.0.0.1:${port}:8080`], environment: { SUB2API_BLUE_UPSTREAM: 'blue:8080', SUB2API_GREEN_UPSTREAM: 'green:8080' },
    volumes: [`${join(root, 'deploy/local-upgrade/haproxy.cfg')}:/usr/local/etc/haproxy/haproxy.cfg:ro`, `${directory}:/var/lib/sub2api-ingress`],
    depends_on: { blue: { condition: 'service_healthy' }, green: { condition: 'service_healthy' } } }
}, networks: { default: { driver: 'bridge' } } }))
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]
const docker = (args, input) => run('docker', args, input)
const service = name => docker([...compose, 'ps', '--quiet', name])
function command(text) {
  return docker(['exec', '-i', service('ingress'), 'sh', '-c', 'nc -w 1 127.0.0.1 9999'], `${text}\n`)
}
async function activate(slot) {
  assert(['blue', 'green'].includes(slot))
  assert.equal(command(`set map /var/lib/sub2api-ingress/active.map active ${slot}`), '')
  assert(command('show map /var/lib/sub2api-ingress/active.map').includes(`active ${slot}`))
  // Persist the verified runtime route for proxy restarts; neither slot may be retired
  // while disk/runtime disagree or a release phase is incomplete.
  await writeFile(join(directory, 'active.map.pending'), `active ${slot}\n`)
  await rename(join(directory, 'active.map.pending'), join(directory, 'active.map'))
}
async function request(path = '/', options = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(5000) })
}
async function waitReady() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if (await (await request()).text() === 'blue') return } catch { /* Startup */ }
    await delay(250)
  }
  throw new Error('Test ingress did not become ready')
}
function keepAlive(agent) {
  return new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${port}/`, { agent }, response => {
      let body = ''
      const port = response.socket.localPort
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ body, port }))
      response.on('error', reject)
    }).on('error', reject)
  })
}
async function socket() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket open timed out')) }, 5000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', event => { clearTimeout(timer); ws.close(); reject(event) }, { once: true })
  })
  return ws
}
function echo(ws, text) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket reply timed out')), 3000)
    ws.addEventListener('message', event => { clearTimeout(timer); resolve(event.data) }, { once: true })
    ws.send(text)
  })
}
const agent = new Agent({ keepAlive: true, maxSockets: 1 })
const sockets = []
const checks = []
try {
  docker([...compose, 'up', '--detach', '--wait', '--wait-timeout', '60'])
  docker(['exec', service('ingress'), 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  await waitReady()
  checks.push('pinned HAProxy configuration', 'old route before activation')
  const oldPID = JSON.parse(docker(['inspect', service('ingress')]))[0].State.StartedAt
  const first = await keepAlive(agent)
  assert.equal(first.body, 'blue')
  const ws = await socket()
  sockets.push(ws)
  assert.equal(await echo(ws, 'before'), 'blue:before')
  const stream = await request('/sse', { signal: AbortSignal.timeout(15_000) })
  const reader = stream.body.getReader()
  const firstChunk = await reader.read()
  assert(new TextDecoder().decode(firstChunk.value).includes('blue-0'))
  await activate('green')
  assert.equal(await (await request()).text(), 'green')
  assert.equal((await request()).headers.get('X-Sub2API-Slot'), 'green')
  const second = await keepAlive(agent)
  assert.equal(second.body, 'green')
  assert.equal(second.port, first.port)
  checks.push('atomic runtime activation without restart', 'same keep-alive connection uses new route')
  assert.equal(await echo(ws, 'after'), 'blue:after')
  const newWS = await socket()
  sockets.push(newWS)
  assert.equal(await echo(newWS, 'new'), 'green:new')
  let content = new TextDecoder().decode(firstChunk.value)
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    content += new TextDecoder().decode(chunk.value)
  }
  assert(content.includes('blue-59') && !content.includes('green'))
  checks.push('old SSE exceeds five seconds and completes', 'old WebSocket stays on old process', 'new WebSocket uses new process')
  const beforeFailure = await (await request('/status')).json()
  const failed = await request('/fail', { method: 'POST', body: 'one-operation' })
  assert.equal(failed.status, 500)
  const afterFailure = await (await request('/status')).json()
  assert.equal(afterFailure.requests - beforeFailure.requests, 1)
  checks.push('failed non-idempotent POST is not retried')
  try {
    const aborted = await request('/abort', { method: 'POST', body: 'one-ambiguous-operation' })
    assert.equal(aborted.status, 502)
  } catch (error) {
    // Depending on connection reuse, a truncated upstream response can close the
    // client socket instead of yielding 502. The operation count must still be one.
    assert(['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code))
  }
  assert.equal((await (await request('/status')).json()).requests - afterFailure.requests, 1)
  checks.push('transport-failed POST is not replayed')
  await activate('blue')
  assert.equal(await (await request()).text(), 'blue')
  assert.equal(await echo(newWS, 'rollback'), 'green:rollback')
  assert.equal(await echo(ws, 'rollback'), 'blue:rollback')
  assert.equal(JSON.parse(docker(['inspect', service('ingress')]))[0].State.StartedAt, oldPID)
  checks.push('runtime rollback', 'both existing WebSockets survive rollback', 'proxy process unchanged')
  for (const ws of sockets) ws.close()
  const drainDeadline = Date.now() + 5000
  let oldState
  do {
    oldState = await (await request('/status')).json()
    if (oldState.streams === 0 && oldState.sockets === 0 && oldState.writes === 0) break
    await delay(50)
  } while (Date.now() < drainDeadline)
  assert.equal(oldState.streams, 0)
  assert.equal(oldState.sockets, 0)
  assert.equal(oldState.writes, 0)
  checks.push('fixture request and async persistence drain')
  await activate('green')
  docker([...compose, 'restart', 'ingress'])
  const restartDeadline = Date.now() + 15_000
  let restarted = false
  while (Date.now() < restartDeadline) {
    try { if (await (await request()).text() === 'green') { restarted = true; break } } catch { /* Isolated restart */ }
    await delay(100)
  }
  assert(restarted, 'Proxy must recover the persisted active route after restart')
  checks.push('persisted active route survives isolated proxy restart after connection drain')
  await writeFile(join(directory, 'report.json'), `${JSON.stringify({ passed: true, project, checks,
    proxyImage: haproxy, productionDeploymentPerformed: false, applicationDrainProven: false }, null, 2)}\n`)
  console.log(JSON.stringify({ passed: true, directory, checks,
    productionDeploymentPerformed: false, applicationDrainProven: false }, null, 2))
} finally {
  for (const ws of sockets) ws.close()
  agent.destroy()
  docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10'])
}
