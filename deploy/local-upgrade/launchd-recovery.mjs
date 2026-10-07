import { spawnSync } from 'node:child_process'

// Install this tiny dispatcher as a root-owned file. All deployment code,
// Colima and Docker run as the service owner; root only selects GUI IPC context.
const service = '/Users/clawbotbot/Projects/sub2api-neubrutalism/deploy/local-upgrade/service-recovery.mjs'
const userCommand = action => ['/usr/bin/sudo', '-H', '-n', '-u', 'clawbotbot', '/usr/bin/env',
  'PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin',
  'DOCKER_HOST=unix:///Users/clawbotbot/.colima/default/docker.sock',
  '/opt/homebrew/bin/node', service, action]
function run(binary, args, timeout = 300_000) {
  const r = spawnSync(binary, args, { timeout, stdio: 'ignore' })
  return !r.error && r.status === 0
}

if (!run('/usr/bin/sudo', userCommand('boot-local').slice(1))) process.exitCode = 1
else if (run('/bin/launchctl', ['print', 'gui/501'], 5000)) {
  if (!run('/bin/launchctl', ['asuser', '501', ...userCommand('boot')])) process.exitCode = 1
}
// Before login, leave the already-persisted HTTPS route untouched. Local
// services are ready; route reconciliation follows when GUI IPC is available.
