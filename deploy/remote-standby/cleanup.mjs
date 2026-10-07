import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { liveGateway } from '../local-upgrade/live-gateway.mjs'

process.umask(0o077)
const directory = process.argv[2], archiveDirectory = process.argv[3]
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-deploy-[a-zA-Z0-9]+$/)
assert.match(archiveDirectory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-retired-[a-zA-Z0-9]+$/)
const state = JSON.parse(await readFile(join(directory, 'state.json')))
const archive = JSON.parse(await readFile(join(archiveDirectory, 'retirement.json')))
assert(archive.restoreVerified)
assert.equal(state.phase, 'active-standby')
const verification = JSON.parse(await readFile(join(directory, 'public-verification.json')))
assert(verification.gateway.completed && verification.sessionSurvivesRestart)
assert.equal(verification.image, state.image)
const quote = v => "'" + v.replaceAll("'", "'\\''") + "'"
function remote(command, input) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', 'getcodex-prod', command], { input, encoding: 'utf8', timeout: 180000, maxBuffer: 16 << 20 })
  assert(!r.error && r.status === 0, 'Retired-project cleanup failed; private output suppressed')
  return r.stdout.trim()
}
const names = ['subdock-prod-app-1', 'subdock-prod-worker-1', 'subdock-prod-caddy-1', 'subdock-prod-postgres-1']
const old = JSON.parse(remote('sudo -n docker inspect ' + names.map(quote).join(' ')))
for (const c of old) assert.equal(c.Config.Labels['com.docker.compose.project'], 'subdock-prod')
assert(!old[0].State.Running && !old[1].State.Running && !old[2].State.Running)
// Explicit names and paths only. Caddy's shared software remains with the new stack.
remote('sudo -n docker update --restart=no subdock-prod-postgres-1 >/dev/null; sudo -n docker stop --time=45 subdock-prod-postgres-1 >/dev/null; sudo -n docker rm ' + names.map(quote).join(' ') + ' >/dev/null')
const volumes = ['subdock-prod_postgres-data', 'subdock-prod_caddy-data', 'subdock-prod_caddy-config']
for (const name of volumes) {
  const [v] = JSON.parse(remote('sudo -n docker volume inspect ' + quote(name)))
  assert.equal(v.Labels['com.docker.compose.project'], 'subdock-prod')
  remote('sudo -n docker volume rm ' + quote(name) + ' >/dev/null')
}
const allIds = remote('sudo -n docker ps -aq').split('\n').filter(Boolean)
const used = allIds.length ? JSON.parse(remote('sudo -n docker inspect ' + allIds.map(quote).join(' '))).map(c => c.Image) : []
const tags = remote('sudo -n docker image ls --filter reference=subdock:* --format "{{.Repository}}:{{.Tag}}"').split('\n').filter(Boolean)
for (const tag of tags) {
  assert.match(tag, /^subdock:[a-zA-Z0-9._-]+$/)
  const [image] = JSON.parse(remote('sudo -n docker image inspect ' + quote(tag)))
  assert(!used.includes(image.Id)); remote('sudo -n docker image rm ' + quote(tag) + ' >/dev/null')
}
for (const image of ['postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24', 'node:24-bookworm-slim']) {
  const [meta] = JSON.parse(remote('sudo -n docker image inspect ' + quote(image)))
  assert(!used.includes(meta.Id))
  for (const tag of meta.RepoTags || []) remote('sudo -n docker image rm ' + quote(tag) + ' >/dev/null')
  const remains = remote('sudo -n docker image ls --no-trunc --format "{{.ID}}"').split('\n')
  if (remains.includes(meta.Id)) remote('sudo -n docker image rm ' + quote(meta.Id) + ' >/dev/null')
}
for (const name of ['subdock-prod_egress', 'subdock-prod_ingress', 'subdock-prod_private']) {
  const [network] = JSON.parse(remote('sudo -n docker network inspect ' + quote(name)))
  assert.equal(Object.keys(network.Containers).length, 0)
  assert.equal(network.Labels['com.docker.compose.project'], 'subdock-prod')
  remote('sudo -n docker network rm ' + quote(name) + ' >/dev/null')
}
assert.match(state.upload, /^\/home\/ubuntu\/sub2api-upload-[a-f0-9]{12}$/)
const paths = ['/opt/subdock', '/etc/subdock', '/var/backups/subdock', '/home/ubuntu/subdock-staging',
  '/etc/systemd/system/subdock-backup.service', '/etc/systemd/system/subdock-backup.timer', state.upload]
remote('sudo -n systemctl disable --now subdock-backup.timer >/dev/null; sudo -n rm -rf -- ' + paths.map(quote).join(' ') + '; sudo -n systemctl daemon-reload')
const gateway = await liveGateway('https://getcodex.pro/v1', null, { timeoutMs: 60000 })
archive.projectFilesDeleted = true; archive.deletedAt = new Date().toISOString()
await writeFile(join(archiveDirectory, 'retirement.json'), JSON.stringify(archive, null, 2), { mode: 0o600 })
state.cleanup = { deletedAt: archive.deletedAt, oldContainers: names, oldVolumes: volumes, oldTags: tags, oldPaths: paths, archivedLocally: archiveDirectory, gateway }
await writeFile(join(directory, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 })
remote('sudo -n tee /etc/sub2api/state.json >/dev/null', JSON.stringify(state))
remote('sudo -n chmod 600 /etc/sub2api/state.json')
console.log(JSON.stringify({ standbyReady: true, oldSaleDeleted: true, archiveDirectory, deletedPaths: paths, gateway }))
