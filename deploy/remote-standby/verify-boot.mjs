import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { liveGateway } from '../local-upgrade/live-gateway.mjs'

process.umask(0o077)
const directory = process.argv[2], previousBoot = process.argv[3]
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-deploy-[a-zA-Z0-9]+$/)
assert.match(previousBoot || '', /^[a-f0-9-]{36}$/)
const state = JSON.parse(await readFile(join(directory, 'state.json')))
let containers, boot
const deadline = Date.now() + 180000
while (Date.now() < deadline) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', 'getcodex-prod',
    'cat /proc/sys/kernel/random/boot_id; sudo -n systemctl is-enabled getcodex-sub2api.service; sudo -n systemctl is-active getcodex-sub2api.service; sudo -n docker inspect getcodex-sub2api-app getcodex-sub2api-postgres getcodex-sub2api-redis getcodex-sub2api-caddy'],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 4 << 20 })
  if (!r.error && r.status === 0) {
    const lines = r.stdout.split('\n')
    if (lines[0] !== previousBoot && lines[1] === 'enabled' && lines[2] === 'active') {
      const items = JSON.parse(lines.slice(3).join('\n'))
      if (items.every(c => c.State.Running) && items.slice(0, 3).every(c => c.State.Health?.Status === 'healthy')) {
        boot = lines[0]; containers = items; break
      }
    }
  }
  // SSH may return before network-online and the Compose startup job have completed.
  await new Promise(resolve => setTimeout(resolve, 3000))
}
assert(containers, 'HK did not complete automatic startup within the readiness deadline')
assert.equal(containers[0].Image, state.image)
assert(containers[0].Config.Env.includes('TOKEN_REFRESH_ENABLED=false'))
assert(containers[0].Config.Env.includes('USAGE_CLEANUP_ENABLED=false'))
const gateway = await liveGateway('https://getcodex.pro/v1', null, { timeoutMs: 60000 })
const report = { checkedAt: new Date().toISOString(), coldReboot: true, previousBoot, bootId: boot,
  autoStartEnabled: true, systemdActive: true,
  containers: containers.map(c => ({ name: c.Name.slice(1), image: c.Image, health: c.State.Health?.Status, running: c.State.Running })), gateway }
await writeFile(join(directory, 'boot-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
