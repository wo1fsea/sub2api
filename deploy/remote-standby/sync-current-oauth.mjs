import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// One-time credential catch-up after snapshot restoration. This is not a scheduled sync.
process.umask(0o077)
const directory = process.argv[2]
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-deploy-[a-zA-Z0-9]+$/)
const env = JSON.parse(await readFile(join(directory, 'compose-private.json'))).services.app.environment
async function client(base) {
  let token
  async function api(path, method = 'GET', body) {
    const r = await fetch(base + '/api/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(r.status, 200, `${base} ${path}: HTTP ${r.status}; private response suppressed`)
    const value = await r.json()
    assert.equal(value.code, 0)
    return value.data
  }
  token = (await api('/auth/login', 'POST', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })).access_token
  return api
}
const standby = await client('https://getcodex.pro')
function accounts(remote) {
  // Admin DTOs intentionally mask tokens. Read only the scoped rows into process memory.
  const sql = "SELECT json_build_object('id',id,'platform',platform,'type',type,'proxy_id',proxy_id,'credentials',credentials) FROM accounts WHERE deleted_at IS NULL AND platform IN ('openai','anthropic') AND type='oauth' ORDER BY id;"
  const args = remote
    ? ['-o', 'BatchMode=yes', 'getcodex-prod', 'sudo -n docker exec -i getcodex-sub2api-postgres psql -X -qAt -U sub2api -d sub2api -v ON_ERROR_STOP=1']
    : ['exec', '-i', 'sub2api-postgres', 'psql', '-X', '-qAt', '-U', 'sub2api', '-d', 'sub2api', '-v', 'ON_ERROR_STOP=1']
  const r = spawnSync(remote ? 'ssh' : 'docker', args, { input: sql, encoding: 'utf8', timeout: 15000 })
  assert(!r.error && r.status === 0, 'Scoped OAuth database read failed; private output suppressed')
  return r.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
}
const originals = accounts(true)
const changes = []
for (const current of accounts(false)) {
  const item = current
  const old = originals.find(a => a.id === item.id)
  assert(old, 'Standby OAuth account is missing')
  assert.equal(current.platform, old.platform); assert.equal(current.type, old.type)
  if (JSON.stringify(current.credentials) === JSON.stringify(old.credentials)) continue
  const expiry = current.credentials.expires_at
  const expiryMs = /^\d+$/.test(String(expiry)) ? Number(expiry) * 1000 : Date.parse(expiry)
  assert(Number.isFinite(expiryMs) && expiryMs - Date.now() > 10 * 60000, `Primary account ${item.id} token is too close to expiry`)
  assert(current.credentials.access_token?.length > 30)
  await writeFile(join(directory, `hk-oauth-${item.id}-before.json`), JSON.stringify(old.credentials), { mode: 0o600, flag: 'wx' })
    .catch(error => { if (error.code !== 'EEXIST') throw error })
  await standby(`/admin/accounts/${item.id}`, 'PUT', { credentials: current.credentials })
  const after = await standby(`/admin/accounts/${item.id}`)
  assert.deepEqual(accounts(true).find(a => a.id === item.id).credentials, current.credentials)
  assert.equal(after.proxy_id, old.proxy_id, 'Credential catch-up changed the standby proxy binding')
  changes.push({ id: item.id, platform: item.platform, expiresAt: new Date(expiryMs).toISOString(), readbackVerified: true })
}
const report = { checkedAt: new Date().toISOString(), oneTimeOnly: true, primaryWritten: false, oauthRefreshRequested: false, changes }
await writeFile(join(directory, 'oauth-catchup.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
