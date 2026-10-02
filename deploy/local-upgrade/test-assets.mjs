import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'frontend/package.json'))
const { JSDOM } = require('jsdom')
const ts = require('typescript')
assert(process.argv[2], 'Pass the exact candidate manifest path')
const candidate = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
assert.match(candidate.imageId, /^sha256:[a-f0-9]{64}$/)
const oldImage = process.env.SUB2API_OLD_ASSET_IMAGE || 'sha256:ccf47a1c62e355f51f896e489f8253e119fe4101b103cd701ba458cc6c6f0f77'
assert.match(oldImage, /^sha256:[a-f0-9]{64}$/)
const proxyImage = 'haproxy@sha256:8007effce89a08af0236b9529a0daab5b8b36fa939f4162f28201f1bf8731dbf'
const outputRoot = join(root, 'frontend/tmp/asset-tests')
await mkdir(outputRoot, { recursive: true })
const directory = await mkdtemp(join(outputRoot, 'run-'))
const project = `sub2api-assets-${randomBytes(6).toString('hex')}`
const composePath = join(directory, 'compose.json')
const proxyConfig = join(directory, 'haproxy.cfg')
const template = await readFile(join(root, 'deploy/local-upgrade/haproxy-legacy-assets.cfg'), 'utf8')
assert.equal(template.split('option httpchk GET /health').length, 3)
// Setup mode has no /health route; only the isolated drill's probe changes.
await writeFile(proxyConfig, template.replaceAll('option httpchk GET /health', 'option httpchk GET /'))
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 << 20 })
  assert(!r.error && r.status === 0, `Asset drill Docker ${args[0]} failed; sensitive details suppressed`)
  return r.stdout.trim()
}
const inspect = id => JSON.parse(docker(['inspect', id]))[0]
const productionBefore = inspect('sub2api')
const image = JSON.parse(docker(['image', 'inspect', candidate.imageId]))[0]
assert.equal(image.Config.Labels['org.opencontainers.image.revision'], candidate.commit)
assert.equal(image.Config.Labels['org.opencontainers.image.version'], candidate.version)
assert.equal(`${image.Os}/${image.Architecture}`, candidate.platform)
const logging = { driver: 'json-file', options: { 'max-size': '1m', 'max-file': '2' } }
// Setup mode serves the exact embedded build without starting database/background services.
const app = image => ({ image, pull_policy: 'never', entrypoint: ['/app/sub2api'], user: '1000:1000',
  environment: { AUTO_SETUP: 'false', SERVER_HOST: '0.0.0.0', SERVER_PORT: '8080', GOMAXPROCS: '1', GIN_MODE: 'release' },
  read_only: true, tmpfs: ['/app/data:uid=1000,gid=1000,mode=0700,size=4m', '/tmp:size=4m'],
  cpus: 0.25, mem_limit: '128m', logging, networks: ['data'] })
await writeFile(join(directory, 'active.map'), 'active blue\n')
await writeFile(join(directory, 'old-assets.map'), '')
await writeFile(composePath, JSON.stringify({ services: {
  blue: app(oldImage), green: app(candidate.imageId), legacy: app(oldImage),
  ingress: { image: proxyImage, pull_policy: 'never', cpus: 0.25, mem_limit: '128m', logging,
    ports: ['127.0.0.1::8080'], networks: ['data', 'edge'], environment: { SUB2API_BLUE_UPSTREAM: 'blue:8080',
      SUB2API_GREEN_UPSTREAM: 'green:8080', SUB2API_LEGACY_ASSETS_UPSTREAM: 'legacy:8080' },
    volumes: [`${proxyConfig}:/usr/local/etc/haproxy/haproxy.cfg:ro`,
      `${directory}:/var/lib/sub2api-ingress:ro`] }
}, networks: { data: { internal: true }, edge: { driver: 'bridge' } } }))
const compose = ['compose', '--project-name', project, '--env-file', '/dev/null', '--file', composePath]
const id = service => docker([...compose, 'ps', '--all', '--quiet', service])
function activate(slot) {
  assert(['blue', 'green'].includes(slot))
  assert.equal(docker(['exec', '-i', id('ingress'), 'sh', '-c', 'nc -w 1 127.0.0.1 9999'],
    `set map /var/lib/sub2api-ingress/active.map active ${slot}\n`), '')
  assert(docker(['exec', '-i', id('ingress'), 'sh', '-c', 'nc -w 1 127.0.0.1 9999'],
    'show map /var/lib/sub2api-ingress/active.map\n').includes(`active ${slot}`))
}
const base = service => {
  const [{ HostIp, HostPort }] = inspect(id(service)).NetworkSettings.Ports['8080/tcp']
  assert.equal(HostIp, '127.0.0.1')
  return `http://127.0.0.1:${HostPort}`
}
async function request(base, path = '/', options = {}) {
  const r = await fetch(`${base}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) })
  const body = Buffer.from(await r.arrayBuffer())
  assert(body.length <= 8 << 20, 'Asset response exceeded size budget')
  return { status: r.status, type: r.headers.get('content-type'), slot: r.headers.get('x-sub2api-slot'), body }
}
async function ready(base) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try { if ((await request(base)).status === 200) return } catch { /* Startup */ }
    await delay(250)
  }
  throw new Error('Isolated asset server did not start')
}
const digest = body => createHash('sha256').update(body).digest('hex')
async function graph(base) {
  const html = await request(base)
  const dom = new JSDOM(html.body.toString())
  const paths = new Set()
  function add(value, parent = '/') {
    if (!/^(?:\/assets\/|assets\/|\.\.?\/)[a-zA-Z0-9_./-]+\.(?:js|css)$/.test(value)) return
    const path = new URL(value.startsWith('assets/') ? `/${value}` : value, `http://assets.invalid${parent}`).pathname
    assert.match(path, /^\/assets\/[a-zA-Z0-9_./-]+\.(?:js|css)$/)
    // SDK bundles also contain relative URLs intended for a remote CDN. Only
    // Vite fingerprinted JS/CSS belong in this release's local chunk map.
    if (!/-[a-zA-Z0-9_-]{6,}\.(?:js|css)$/.test(path)) return
    paths.add(path)
    assert(paths.size <= 1000, 'Asset graph exceeded file budget')
  }
  for (const node of dom.window.document.querySelectorAll('script[src],link[href]')) add(node.src || node.href)
  dom.window.close()
  const files = new Map()
  let bytes = 0
  for (const path of paths) {
    const r = await request(base, path)
    assert.equal(r.status, 200)
    assert(!r.type?.includes('text/html'), `Missing asset fell back to HTML: ${path}`)
    bytes += r.body.length
    assert(bytes <= 64 << 20, 'Asset graph exceeded byte budget')
    files.set(path, { sha256: digest(r.body), bytes: r.body.length, type: r.type })
    if (path.endsWith('.js')) {
      const source = ts.createSourceFile(path, r.body.toString(), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
      assert.equal(source.parseDiagnostics.length, 0, 'Embedded JavaScript could not be parsed')
      const visit = node => {
        if (ts.isStringLiteralLike(node)) add(node.text, path)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  assert(files.size > 50 && [...files.keys()].some(path => path.endsWith('.css')), 'Lazy graph unexpectedly incomplete')
  return files
}
const report = { candidateCommit: candidate.commit, candidateImageId: candidate.imageId, oldImageId: oldImage,
  project, checks: [], passed: false, productionDeploymentPerformed: false, applicationDrainProven: false,
  scope: 'Discovered fingerprinted JS/CSS graph and isolated proxy; not un-hashed media or logged-in browser/API compatibility' }
try {
  docker([...compose, 'up', '--detach'])
  const network = inspect(`${project}_data`)
  assert.equal(network.Internal, true)
  let ingress = base('ingress')
  await ready(ingress)
  assert.equal((await request(ingress)).slot, 'blue')
  const oldFiles = await graph(ingress)
  activate('green')
  const newFiles = await graph(ingress)
  report.oldFileCount = oldFiles.size
  report.newFileCount = newFiles.size
  const oldOnly = [...oldFiles.keys()].filter(path => !newFiles.has(path))
  assert(oldOnly.length > 0)
  const missing = await request(ingress, oldOnly[0])
  assert.equal(missing.status, 200)
  assert(missing.type?.includes('text/html'), 'Re-check the candidate missing-asset behavior')
  report.checks.push('candidate alone cannot supply old lazy chunks')
  for (const [path, file] of oldFiles) {
    if (newFiles.has(path)) assert.equal(newFiles.get(path).sha256, file.sha256, 'Asset URL collision with different bytes')
  }
  await writeFile(join(directory, 'old-assets.map'), [...oldFiles.keys()].sort().map(path => `${path} legacy_assets\n`).join(''))
  // The discovery phase has no real users/connections. Reload the isolated test
  // once to install the completed map; activation below must not restart it.
  docker([...compose, 'restart', 'ingress'])
  ingress = base('ingress')
  docker(['exec', id('ingress'), 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  await ready(ingress)
  assert.equal((await request(ingress)).slot, 'blue')
  const started = inspect(id('ingress')).State.StartedAt
  activate('green')
  assert.equal((await request(ingress)).slot, 'green')
  docker([...compose, 'stop', '--timeout', '2', 'blue'])
  for (const [path, file] of new Map([...newFiles, ...oldFiles])) {
    const response = await request(ingress, path)
    assert.equal(response.status, 200)
    assert.equal(digest(response.body), file.sha256)
    assert.equal(response.type, file.type)
    assert.equal(response.slot, oldFiles.has(path) ? 'legacy-assets' : 'green')
  }
  assert.equal((await request(ingress, oldOnly[0], { method: 'HEAD' })).slot, 'legacy-assets')
  assert.equal((await request(ingress, oldOnly[0], { method: 'POST', body: 'must-not-use-assets' })).slot, 'green')
  for (const path of ['/setup/status', '/api/v1/auth/me', '/assets/unknown.js']) {
    assert.equal((await request(ingress, path)).slot, 'green')
  }
  const legacy = inspect(id('legacy'))
  assert.equal(legacy.Config.User, '1000:1000')
  assert.equal(docker(['exec', legacy.Id, 'id', '-u']), '1000')
  assert.equal(legacy.HostConfig.ReadonlyRootfs, true)
  assert.equal(legacy.Mounts.length, 0)
  assert(!legacy.NetworkSettings.Ports['8080/tcp'])
  assert.deepEqual(Object.keys(legacy.NetworkSettings.Networks), [`${project}_data`])
  assert.equal(legacy.Config.Env.filter(v => /^(JWT_SECRET|TOTP_ENCRYPTION_KEY|DATABASE_PASSWORD|REDIS_PASSWORD)=/.test(v)).length, 0)
  assert.equal(inspect(id('ingress')).State.StartedAt, started)
  report.checks.push('no-egress secret-free read-only legacy asset instance', 'old and new JS/CSS graph digests and content types',
    'old application asset fixture stopped without breaking old assets', 'GET/HEAD-only exact-path legacy map',
    'setup/API/unknown paths never route to legacy assets', 'no ingress restart during activation')
  report.passed = true
} catch (error) {
  report.error = error.message
  for (const name of ['blue', 'green', 'legacy', 'ingress']) {
    const result = spawnSync('docker', [...compose, 'logs', '--no-color', '--tail', '30', name],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 << 10 })
    await writeFile(join(directory, `${name}-failure.txt`), (result.stdout || '').slice(-16_384))
  }
  throw error
} finally {
  docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '3'])
  const current = inspect(productionBefore.Id)
  assert.equal(current.State.StartedAt, productionBefore.State.StartedAt)
  assert.equal(current.RestartCount, productionBefore.RestartCount)
  assert.equal(current.State.Health.Status, 'healthy')
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ ...report, directory }, null, 2))
}
