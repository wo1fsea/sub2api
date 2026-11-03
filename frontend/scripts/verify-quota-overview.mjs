// Run against a compiled loopback preview; every API call is fulfilled in the
// browser. No production credentials, traffic, database or upstream requests.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.SUB2API_PLAYWRIGHT_MODULE
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright')
const base = process.env.SUB2API_QUOTA_PREVIEW_URL || 'http://127.0.0.1:18389'
assert.equal(new URL(base).hostname, '127.0.0.1', 'QA requires an isolated loopback preview')
const output = resolve(process.env.SUB2API_QUOTA_QA_OUTPUT || 'tmp/quota-overview-qa')
await mkdir(output, { recursive: true })
const live = process.env.SUB2API_QUOTA_SAFE_FIXTURE
  ? JSON.parse(await readFile(process.env.SUB2API_QUOTA_SAFE_FIXTURE, 'utf8')) : null
const sampled = new Date().toISOString()
const reset = hours => new Date(Date.now() + hours * 3600000).toISOString()
const account = (id, platform, type = 'oauth') => ({ id, name: `${platform} subscription`, platform, type, status: 'active' })
const accounts = [account(13, 'factory', 'apikey'), account(12, 'antigravity'), account(14, 'openai', 'apikey')]
const window = (key, utilization, scope = 'account', hours = 2) => ({
  key, utilization, scope, source: 'upstream', sampled_at: sampled, resets_at: reset(hours)
})
const synthetic = { usage: {
  13: { updated_at: sampled, quota_windows: ['standard', 'core'].flatMap((scope, i) =>
    ['five_hour', 'weekly', 'monthly'].map((period, j) => window(`factory_${scope}_${period}`, 10 + i * 10 + j * 10, scope, (j + 1) * 3))) },
  12: { updated_at: sampled, quota_windows: [], subscription_tier: 'ULTRA',
    five_hour: { utilization: 92, resets_at: reset(2) },
    antigravity_quota: Object.fromEntries(Array.from({ length: 26 }, (_, i) => [
      i === 0 ? 'claude-sonnet-4' : `gemini-long-model-name-${i}`, { utilization: i === 0 ? 92 : i, reset_time: reset(i + 2) }
    ])), ai_credits: [{ credit_type: 'GOOGLE_ONE_AI', amount: 0 }] }
}, errors: {} }
const inventory = [
  'Factory API Key label and all six windows with resets',
  'Antigravity ULTRA, six tightest model previews, full 26-window dialog, zero AI Credits',
  'Priority/all/needs-refresh filters; remaining/reset sorting; dialog open/close/Escape and refresh',
  'Failed refresh retains readings/credits and marks stale; recovery restores fresh; empty results stay unknown',
  'Compiled build with sanitized production snapshot (when supplied)',
  'Chinese light desktop, English monochrome dark, mobile 390px; no horizontal clipping or browser errors'
]
const report = { inventory, checks: [], screenshots: [], fits: [], browserErrors: [], apiCalls: [], blockedRequests: [], passed: false }
const browser = await chromium.launch({ headless: true,
  ...(process.env.SUB2API_CHROME_PATH ? { executablePath: process.env.SUB2API_CHROME_PATH } : {}) })
let mode = 'fresh'
let skin = 'neubrutalism'
let appearanceMode = 'light'
let locale = 'zh'
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 })
  await context.addInitScript(() => {
    localStorage.setItem('auth_token', 'isolated-fixture-token')
    localStorage.setItem('auth_user', JSON.stringify({ id: 1, email: 'fixture@example.invalid', role: 'admin', status: 'active' }))
    if (!localStorage.getItem('sub2api_locale')) localStorage.setItem('sub2api_locale', 'zh')
    localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true')
  })
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== new URL(base).origin) {
      report.blockedRequests.push(url.origin + url.pathname)
      return route.abort()
    }
    if (url.pathname === '/setup/status') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { needs_setup: false } }) })
    if (!url.pathname.startsWith('/api/')) return route.continue()
    let data = {}
    if (url.pathname === '/api/v1/admin/accounts') data = { items: accounts, total: accounts.length, pages: 1, page: 1, page_size: 100 }
    else if (url.pathname === '/api/v1/admin/accounts/usage/batch') {
      const body = request.postDataJSON()
      assert.deepEqual(body.account_ids, [13, 12])
      report.apiCalls.push({ mode, force: body.force, ids: body.account_ids })
      data = mode === 'failed' ? { usage: { 12: { updated_at: new Date().toISOString(), error_code: 'forbidden' } }, errors: { 13: 'upstream_unavailable' } }
        : mode === 'unknown' ? { usage: {}, errors: {} }
          : mode === 'live' ? live : synthetic
    } else if (url.pathname === '/api/v1/auth/me') data = { id: 1, email: 'fixture@example.invalid', role: 'admin', status: 'active' }
    else if (url.pathname === '/api/v1/settings/public') data = { site_name: 'Sub2API', site_appearance: { skin, mode: appearanceMode, accent_color: '#d4ff3f' } }
    else if (url.pathname === '/api/v1/admin/compliance') data = { required: false }
    else if (url.pathname.includes('announcements')) data = { items: [], total: 0, unread_count: 0 }
    else if (url.pathname === '/api/v1/setup/status') data = { needs_setup: false }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data }) })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.browserErrors.push(error.message))
  const card = id => page.locator(`[data-account-id="${id}"]`)
  const ready = async () => {
    await card(13).waitFor()
    await page.locator('.qo-refresh:not(:disabled)').waitFor()
  }
  const capture = async (name, options = {}) => {
    const file = resolve(output, `${name}.png`)
    if (await page.locator('.modal-overlay').count() === 0) await page.evaluate(() => window.scrollTo(0, 0))
    // Vue dialog transitions can be present before the panel becomes opaque.
    // Capture the settled state rather than signing off an overlay-only frame.
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})))
    })
    await page.screenshot({ path: file, scale: 'css', animations: 'disabled', ...options })
    report.screenshots.push(file)
    const fit = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('.qo-account, .qo-window, .qo-credits, .modal-content')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1) }).length }))
    assert(fit.scrollWidth <= fit.width && fit.overflowing === 0, `${name}: horizontal clipping`)
    report.fits.push({ name, ...fit })
  }
  await page.goto(`${base}/admin/quota-overview`)
  await ready()
  assert.match(await card(13).innerText(), /Factory · API Key/)
  assert.equal(await card(13).locator('.qo-window').count(), 6)
  assert.equal(await card(13).locator('.qo-window-reset').count(), 6)
  for (const tier of ['Standard', 'Core']) {
    for (const period of ['5 小时', '本周', '本月']) assert((await card(13).innerText()).includes(`${tier} · ${period}`))
  }
  assert.equal(await card(12).locator('.qo-window').count(), 6)
  assert.match(await card(12).innerText(), /6 \/ 26/)
  assert.match(await card(12).innerText(), /ULTRA/)
  assert.match(await card(12).innerText(), /GOOGLE_ONE_AI: 0/)
  assert.equal(await page.locator('.qo-account').count(), 2)
  await capture('synthetic-zh-desktop')
  report.checks.push('six Factory windows; 6/26 Antigravity preview; tier, zero credits and reset labels')
  await page.locator('.qo-filter').nth(1).click()
  assert.equal(await page.locator('.qo-account').count(), 1)
  assert.equal(await page.locator('.qo-account').getAttribute('data-account-id'), '12')
  await page.locator('.qo-filter').nth(0).click()
  await page.locator('.qo-sort select').selectOption('reset')
  assert.equal(await page.locator('.qo-account').first().getAttribute('data-account-id'), '12')
  await page.locator('.qo-sort select').selectOption('remaining')
  await card(12).locator('.qo-card-open').click()
  assert.equal(await page.locator('.qo-detail-window').count(), 26)
  await capture('antigravity-dialog')
  await page.locator('.qo-dialog-refresh').click()
  await page.locator('.qo-dialog-refresh:not(:disabled)').waitFor()
  assert.equal(report.apiCalls.at(-1).force, true)
  await page.getByRole('button', { name: 'Close modal', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await card(13).locator('.qo-card-open').click()
  assert.equal(await page.locator('.qo-detail-window').count(), 6)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  report.checks.push('filter/sort round trips; both dialogs; dialog refresh; Close and Escape')
  mode = 'failed'
  await page.locator('.qo-refresh').click()
  await ready()
  assert.equal(await card(12).getAttribute('data-quota-state'), 'stale')
  assert.equal(await card(13).getAttribute('data-quota-state'), 'stale')
  assert.match(await card(12).innerText(), /GOOGLE_ONE_AI: 0/)
  assert.equal(await card(12).locator('[data-test="remaining-value"]').innerText(), '8%')
  await page.locator('.qo-filter').nth(2).click()
  assert.equal(await page.locator('.qo-account').count(), 2)
  await capture('failed-refresh-retained')
  await page.locator('.qo-filter').nth(0).click()
  mode = 'fresh'
  await page.locator('.qo-refresh').click()
  await ready()
  assert.equal(await card(12).getAttribute('data-quota-state'), 'fresh')
  report.checks.push('forbidden/missing refresh preserves values, tier and credits; recovery restores fresh')
  locale = 'en'; skin = 'monochrome'; appearanceMode = 'dark'
  await page.evaluate(value => localStorage.setItem('sub2api_locale', value), locale)
  await page.reload(); await ready()
  assert.match(await card(12).innerText(), /AI Credits balance/)
  assert.equal(await page.locator('html').getAttribute('data-skin'), 'monochrome')
  await capture('synthetic-en-dark')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await capture('mobile-initial')
  await capture('mobile-all-cards', { fullPage: true })
  mode = 'unknown'
  await page.reload(); await ready()
  assert.equal(await card(12).getAttribute('data-quota-state'), 'unknown')
  assert.equal(await card(13).locator('.qo-window').count(), 6)
  assert.match(await card(12).innerText(), /AI Credits balance · Unknown/)
  await capture('mobile-unknown')
  report.checks.push('English monochrome dark; mobile cards; missing initial usage stays unknown')
  if (live) {
    mode = 'live'; skin = 'monochrome'; appearanceMode = 'light'
    await page.evaluate(() => localStorage.setItem('sub2api_locale', 'zh'))
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.reload(); await ready()
    assert.equal(await card(13).locator('.qo-window').count(), 6)
    assert.match(await card(12).innerText(), /ULTRA/)
    for (const credit of live.usage[12].ai_credits || []) {
      assert((await card(12).innerText()).includes(`${credit.credit_type}: ${credit.amount ?? 0}`))
    }
    await capture('actual-snapshot-desktop')
    await card(12).locator('.qo-card-open').click()
    assert.equal(await page.locator('.qo-detail-window').count(), Object.keys(live.usage[12].antigravity_quota).length)
    await capture('actual-snapshot-dialog')
    await page.keyboard.press('Escape')
    report.checks.push(`sanitized actual snapshot: ${Object.keys(live.usage[12].antigravity_quota).length} models and six Factory windows`)
  }
  assert.deepEqual(report.browserErrors, [])
  // The shared app eagerly loads its payment SDK. It is unrelated to quotas;
  // keep those requests blocked and reject any other attempted external origin.
  assert(report.blockedRequests.every(url => ['https://static.airwallex.com', 'https://checkout.airwallex.com'].includes(new URL(url).origin)))
  report.passed = true
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await browser.close()
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, output }))
