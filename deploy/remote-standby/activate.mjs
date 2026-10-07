import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

process.umask(0o077)
const directory = process.argv[2]
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-deploy-[a-zA-Z0-9]+$/)
const statePath = join(directory, 'state.json')
const state = JSON.parse(await readFile(statePath))
assert.equal(state.phase, 'prepared')
const verified = JSON.parse(await readFile(join(directory, 'candidate-verification.json')))
assert.equal(verified.image, state.image); assert(verified.gateway.completed && verified.sessionSurvivesRestart)
function remote(command, input) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', 'getcodex-prod', command], { input, encoding: 'utf8', timeout: 180000, maxBuffer: 4 << 20 })
  assert(!r.error && r.status === 0, 'Standby activation failed; private output suppressed')
  return r.stdout.trim()
}
const originals = JSON.parse(remote('sudo -n docker inspect subdock-prod-app-1 subdock-prod-worker-1 subdock-prod-caddy-1'))
for (const c of originals) assert.equal(c.Config.Labels['com.docker.compose.project'], 'subdock-prod')
assert(!originals[0].State.Running && !originals[1].State.Running)
remote('sudo -n docker update --restart=no subdock-prod-caddy-1 >/dev/null; sudo -n docker stop --time=30 subdock-prod-caddy-1 >/dev/null')
try {
  remote('sudo -n docker compose -p getcodex-sub2api --env-file /dev/null -f /etc/sub2api/compose-private.json up -d --wait --wait-timeout 120 caddy')
  const r = await fetch('https://getcodex.pro/health', { signal: AbortSignal.timeout(15000) })
  assert.equal(r.status, 200); assert.equal((await r.json()).status, 'ok')
  assert.equal((await fetch('https://getcodex.pro/api/store/config')).status, 410)
} catch (error) {
  remote('sudo -n docker stop getcodex-sub2api-caddy >/dev/null; sudo -n docker start subdock-prod-caddy-1 >/dev/null')
  throw error
}
const root = new URL('./', import.meta.url)
remote('sudo -n tee /etc/systemd/system/getcodex-sub2api.service >/dev/null', await readFile(new URL('getcodex-sub2api.service', root)))
remote('sudo -n tee /opt/sub2api/standby-mode.py >/dev/null', await readFile(new URL('standby-mode.py', root)))
remote('sudo -n chmod 755 /opt/sub2api/standby-mode.py; sudo -n systemctl daemon-reload; sudo -n systemctl enable --now getcodex-sub2api.service >/dev/null')
assert.equal(remote('sudo -n systemctl is-enabled getcodex-sub2api.service'), 'enabled')
assert.equal(remote('sudo -n systemctl is-active getcodex-sub2api.service'), 'active')
state.phase = 'active-standby'
state.publicActivated = true
state.activatedAt = new Date().toISOString()
await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
remote('sudo -n tee /etc/sub2api/state.json >/dev/null', JSON.stringify(state))
remote('sudo -n chmod 600 /etc/sub2api/state.json')
console.log(JSON.stringify({ phase: state.phase, image: state.image, endpoint: 'https://getcodex.pro/v1', autoStartEnabled: true, backgroundRefresh: false }))
