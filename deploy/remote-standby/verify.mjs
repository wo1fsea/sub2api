import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { liveGateway } from '../local-upgrade/live-gateway.mjs'

process.umask(0o077)
const directory = process.argv[2], base = process.argv[3]
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-deploy-[a-zA-Z0-9]+$/)
assert(['http://127.0.0.1:18585', 'https://getcodex.pro'].includes(base))
const state = JSON.parse(await readFile(join(directory, 'state.json')))
const config = JSON.parse(await readFile(join(directory, 'compose-private.json')))
const env = config.services.app.environment
const before = await (await fetch('https://openclaw-macmini-ts.tailff52e6.ts.net/api/v1/settings/public')).json()
const health = await fetch(base + '/health', { signal: AbortSignal.timeout(10000) })
assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok')
const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(10000) })
assert.equal(r.status, 200, 'Copied administrator cannot log in')
const token = (await r.json()).data.access_token
const headers = { Authorization: `Bearer ${token}` }
const version = await fetch(base + '/api/v1/admin/system/version', { headers, signal: AbortSignal.timeout(10000) })
assert.equal(version.status, 200); assert.equal((await version.json()).data.version, '0.2.13')
const pub = await (await fetch(base + '/api/v1/settings/public', { signal: AbortSignal.timeout(10000) })).json()
assert.equal(pub.data.registration_enabled, false)
assert.deepEqual(pub.data.site_appearance, before.data.site_appearance)
const unauthorized = await fetch(base + '/api/v1/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ site_appearance: pub.data.site_appearance }), signal: AbortSignal.timeout(10000) })
assert.equal(unauthorized.status, 401)
const html = await (await fetch(base + '/login', { signal: AbortSignal.timeout(10000) })).text()
const paths = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(m => m[1]))]
assert(paths.length >= 2)
for (const path of paths) { const a = await fetch(base + path); assert.equal(a.status, 200); assert((await a.arrayBuffer()).byteLength > 100) }
const gateway = await liveGateway(base + '/v1', null, { timeoutMs: 60000 })
// Hold this existing token in memory across a real application restart.
const child = spawnSync('ssh', ['-o', 'BatchMode=yes', 'getcodex-prod', 'sudo -n docker restart --time=30 getcodex-sub2api-app >/dev/null'],
  { encoding: 'utf8', timeout: 60000 })
assert.equal(child.status, 0, 'Application restart failed; private output suppressed')
let restored = false
for (let i = 0; i < 40; i++) {
  try {
    const me = await fetch(base + '/api/v1/auth/me', { headers, signal: AbortSignal.timeout(3000) })
    if (me.status === 200) { restored = true; break }
  } catch { /* App restart is asynchronous. */ }
  await new Promise(resolve => setTimeout(resolve, 500))
}
assert(restored, 'Existing session was not restored')
const report = { checkedAt: new Date().toISOString(), base, version: '0.2.13', image: state.image,
  existingAdmin: true, sharedAppearance: pub.data.site_appearance, registrationDisabled: true,
  unauthorizedWriteRejected: true, embeddedAssets: paths.length, sessionSurvivesRestart: true, gateway }
await writeFile(join(directory, base.startsWith('https') ? 'public-verification.json' : 'candidate-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
