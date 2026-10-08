import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { routing } from './upgrade-current.mjs'

// Isolated fixtures only: no production volumes, credentials, DB or domain.
// This proves the actual deployed Caddy version can reload an admin-off config
// while its public listener and an existing response continue serving.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, 'frontend/tmp/hk-caddy-tests')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, 'run-'))
const token = randomBytes(6).toString('hex'), revision = '0123456789ab'
const network = 'sub2api-hk-caddy-test-' + token
const edgeNetwork = network + '-edge'
const names = [network + '-blue', network + '-green', network + '-caddy']
const caddyImage = 'sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e'
const nodeImage = 'sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
const asset = '/assets/old-page-aBc12345.js'
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 })
  assert.equal(result.status, 0, `Isolated Caddy operation failed: ${args[0]}`)
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim()
}
const inspect = name => JSON.parse(docker(['inspect', name]))[0]
const config = target => routing(target, revision, [asset])
  .replace('www.getcodex.pro {\n redir https://getcodex.pro{uri} permanent\n}\n', '')
  .replace('getcodex.pro {', ':8080 {')
const fixture = `require('http').createServer((q,r)=>{const slot=process.env.SLOT;if(q.url==='/stream'){r.writeHead(200,{'Content-Type':'text/event-stream'});let n=0;const t=setInterval(()=>{r.write('data: '+slot+'-'+n+'\\n\\n');if(++n===60){clearInterval(t);r.end();}},40);r.on('close',()=>clearInterval(t));}else{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({status:'ok',slot}));}}).listen(8080,'0.0.0.0')`
await writeFile(join(directory, 'Caddyfile'), config('app:8080'))
await mkdir(join(directory, 'retained/assets'), { recursive: true })
await writeFile(join(directory, 'retained' + asset), 'window.oldPage = true;\n')
const created = []
let networkCreated = false, edgeNetworkCreated = false
let monitor, monitoring = false
const report = { version: 'v2.11.4', passed: false, adminDisabled: true, productionDeploymentPerformed: false }
try {
  docker(['network', 'create', '--internal', network]); networkCreated = true
  docker(['network', 'create', edgeNetwork]); edgeNetworkCreated = true
  for (const [name, alias, slot] of [[names[0], 'app', 'blue'], [names[1], `getcodex-sub2api-quota-candidate-${revision}`, 'green']]) {
    docker(['run', '-d', '--name', name, '--label', 'io.sub2api.hk-caddy-test=' + token, '--network', network, '--network-alias', alias,
      '--memory', '64m', '--cpus', '.25', '--log-driver', 'none', '-e', 'SLOT=' + slot, nodeImage, 'node', '-e', fixture])
    created.push(name)
  }
  docker(['run', '-d', '--name', names[2], '--label', 'io.sub2api.hk-caddy-test=' + token, '--network', edgeNetwork,
    '--memory', '96m', '--cpus', '.25', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1', '-p', '127.0.0.1::8080',
    '-v', join(directory, 'Caddyfile') + ':/etc/caddy/Caddyfile:ro', '-v', join(directory, 'retained') + ':/data/sub2api-release-assets/retained:ro',
    caddyImage, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
  created.push(names[2])
  docker(['network', 'connect', network, names[2]])
  assert(docker(['exec', names[2], 'caddy', 'version']).startsWith('v2.11.4 '))
  const before = inspect(names[2]), port = before.NetworkSettings.Ports['8080/tcp'][0].HostPort
  const base = 'http://127.0.0.1:' + port
  async function health(slot) {
    const deadline = Date.now() + 10_000
    while (true) {
      try {
        const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })
        if (r.status === 200 && r.headers.get('x-sub2api-slot') === slot) return
      } catch { /* Fixture startup/reload. */ }
      assert(Date.now() < deadline, 'Caddy did not serve the expected slot'); await delay(50)
    }
  }
  await health('hk-current')
  const stream = await fetch(base + '/stream', { signal: AbortSignal.timeout(10_000) })
  const reader = stream.body.getReader(), first = await reader.read()
  assert(new TextDecoder().decode(first.value).includes('blue-0'))
  let continuityChecks = 0, monitorFailed = false
  monitoring = true
  monitor = (async () => {
    while (monitoring) {
      try {
        const r = await fetch(base + '/health', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(2000) })
        if (r.status !== 200 || (await r.json()).status !== 'ok') monitorFailed = true
        continuityChecks++
      } catch { monitorFailed = true }
      await delay(25)
    }
  })()
  await writeFile(join(directory, 'Caddyfile'), config(`getcodex-sub2api-quota-candidate-${revision}:8080`))
  docker(['exec', names[2], 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
  docker(['kill', '--signal=USR1', names[2]])
  await health('hk-candidate')
  const content = [new TextDecoder().decode(first.value)]
  while (true) { const next = await reader.read(); if (next.done) break; content.push(new TextDecoder().decode(next.value)) }
  assert(content.join('').includes('blue-59') && !content.join('').includes('green-'), 'Existing stream was interrupted or retargeted')
  const retained = await fetch(base + asset)
  assert.equal(retained.headers.get('x-sub2api-slot'), 'hk-retained-assets')
  assert.equal(await retained.text(), 'window.oldPage = true;\n')
  const nonGet = await fetch(base + asset, { method: 'POST', body: 'payload' })
  assert.equal(nonGet.headers.get('x-sub2api-slot'), 'hk-candidate')
  await writeFile(join(directory, 'Caddyfile'), config('app:8080'))
  docker(['kill', '--signal=USR1', names[2]]); await health('hk-current')
  monitoring = false; await monitor
  const after = inspect(names[2])
  assert.equal(after.Id, before.Id); assert.equal(after.State.StartedAt, before.State.StartedAt); assert.equal(after.RestartCount, before.RestartCount)
  assert(!monitorFailed && continuityChecks >= 10, 'Listener continuity monitor saw an outage')
  assert(docker(['logs', names[2]]).includes('successfully reloaded config from file'))
  Object.assign(report, { passed: true, existingStreamCompleted: true, forwardSwitch: true, rollback: true,
    caddyNotRestarted: true, exactOldAssetsServed: true, nonGetAssetsReachApplication: true, continuityChecks })
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ directory, ...report }, null, 2))
} finally {
  monitoring = false
  if (monitor) await monitor
  for (const name of created.reverse()) {
    const c = inspect(name); assert.equal(c.Config.Labels['io.sub2api.hk-caddy-test'], token)
    docker(['rm', '--force', c.Id])
  }
  if (networkCreated) docker(['network', 'rm', network])
  if (edgeNetworkCreated) docker(['network', 'rm', edgeNetwork])
}
