import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

process.umask(0o077)
const directory = process.argv[2]
// HK is the current policy; local proxy changes require explicitly selecting macmini/both.
const selected = process.argv[3] || 'hk'
assert(['both', 'macmini', 'hk'].includes(selected))
assert.match(directory || '', /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-deploy-[a-zA-Z0-9]+$/)
const config = JSON.parse(await readFile(join(directory, 'compose-private.json')))
const admin = config.services.app.environment
const note = await readFile('/Users/clawbotbot/Projects/ObsidianVault/02 Engineering/Projects/clash-sub-hub/服务器登录配置.md', 'utf8')
const section = note.split('## webshare-sr-01')[1]?.split('\n## ')[0]
assert(section, 'Webshare note section was not found')
const field = label => {
  const value = section.match(new RegExp('^- ' + label + '：`([^`]+)`', 'm'))?.[1]
  assert(value, `Missing Webshare ${label}; private values suppressed`)
  return value
}
const proxy = { name: 'Webshare-US', protocol: 'http', host: field('地址'), port: Number(field('端口')),
  username: field('用户名'), password: field('密码'), fallback_mode: 'none', expiry_warn_days: 7 }
assert(Number.isInteger(proxy.port) && proxy.port > 0 && proxy.port < 65536)
const sites = [
  { name: 'macmini', base: 'http://127.0.0.1:18480' },
  { name: 'hk', base: 'http://127.0.0.1:18585' }
].filter(site => selected === 'both' || site.name === selected)
for (const site of sites) {
  site.api = async (path, method = 'GET', body) => {
    const response = await fetch(site.base + '/api/v1' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', ...(site.token ? { Authorization: `Bearer ${site.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    assert.equal(response.status, 200, `${site.name} ${method} ${path} returned HTTP ${response.status}; private response suppressed`)
    const value = await response.json()
    assert.equal(value.code, 0, `${site.name} ${path} failed; private response suppressed`)
    return value.data
  }
  site.token = (await site.api('/auth/login', 'POST', { email: admin.ADMIN_EMAIL, password: admin.ADMIN_PASSWORD })).access_token
  assert(site.token)
  const proxies = await site.api('/admin/proxies?page_size=100')
  assert.equal(proxies.items.length, proxies.total, 'Unexpected proxy pagination')
  let existing = proxies.items.find(p => p.name === proxy.name)
  if (existing) {
    assert.equal(existing.host, proxy.host, 'Existing Webshare name refers to another endpoint')
    assert.equal(existing.port, proxy.port, 'Existing Webshare name refers to another port')
  }
  site.accounts = []
  for (let page = 1; ; page++) {
    const list = await site.api(`/admin/accounts?page=${page}&page_size=100`)
    assert(Array.isArray(list.items))
    site.accounts.push(...list.items)
    if (site.accounts.length >= list.total) break
    assert(list.items.length, 'Account pagination stopped unexpectedly')
  }
  const rollbackPath = join(directory, `webshare-${site.name}-before.json`)
  // Never overwrite the original rollback record when retrying an interrupted run.
  await writeFile(rollbackPath, JSON.stringify({ checkedAt: new Date().toISOString(), proxy: existing || null,
    accounts: site.accounts.map(a => ({ id: a.id, platform: a.platform, proxy_id: a.proxy_id })) }, null, 2),
  { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  existing = await site.api('/admin/proxies' + (existing ? `/${existing.id}` : ''), existing ? 'PUT' : 'POST',
    { ...proxy, ...(existing ? { status: 'active' } : {}) })
  site.proxyId = existing.id
  const tested = await site.api(`/admin/proxies/${site.proxyId}/test`, 'POST')
  await writeFile(join(directory, `webshare-${site.name}-probe-private.json`), JSON.stringify(tested), { mode: 0o600 })
  site.test = { success: tested.success, latencyMs: tested.latency_ms, country: tested.country, countryCode: tested.country_code }
  console.log(JSON.stringify({ site: site.name, phase: 'proxy-tested', proxyId: site.proxyId, ...site.test }))
}
assert(sites.every(site => site.test.success), 'Webshare connection test failed; no account bindings changed. See private probe diagnostics.')
const report = { checkedAt: new Date().toISOString(), name: proxy.name, protocol: proxy.protocol, fallbackMode: proxy.fallback_mode, sites: [] }
for (const site of sites) {
  const targets = site.accounts.filter(a => ['openai', 'anthropic'].includes(a.platform))
  const ids = targets.map(a => a.id)
  assert(ids.length, `No OpenAI or Anthropic accounts were found on ${site.name}`)
  const result = await site.api('/admin/accounts/bulk-update', 'POST', { account_ids: ids, proxy_id: site.proxyId })
  assert.equal(result.failed, 0, `${site.name} some account bindings failed`)
  assert.equal(result.success, ids.length)
  for (const id of ids) {
    const account = await site.api(`/admin/accounts/${id}`)
    assert.equal(account.proxy_id, site.proxyId, `${site.name} account ${id} proxy readback differs`)
  }
  const unaffected = site.accounts.filter(a => !ids.includes(a.id))
  for (const old of unaffected) {
    const account = await site.api(`/admin/accounts/${old.id}`)
    assert.equal(account.proxy_id, old.proxy_id, `${site.name} unrelated account ${old.id} proxy changed`)
  }
  report.sites.push({ site: site.name, proxyId: site.proxyId, test: site.test, accountIds: ids,
    platforms: Object.fromEntries(['openai', 'anthropic'].map(p => [p, targets.filter(a => a.platform === p).length])),
    unaffectedAccountCount: unaffected.length, readbackVerified: true })
  console.log(JSON.stringify(report.sites.at(-1)))
}
await writeFile(join(directory, `webshare-verification-${selected}.json`), JSON.stringify(report, null, 2), { mode: 0o600 })
