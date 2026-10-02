import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const modulePath = process.env.SUB2API_PLAYWRIGHT_MODULE
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright')
const base = process.env.SUB2API_SKIN_PREVIEW_URL || 'http://127.0.0.1:18381'
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'QA must target a loopback preview')
const output = fileURLToPath(new URL('../tmp/skin-qa/', import.meta.url))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []

async function auditPixels(page, buffer) {
  return page.evaluate(async base64 => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const pixels = canvas.getContext('2d')
    pixels.drawImage(image, 0, 0)
    const { data } = pixels.getImageData(0, 0, image.width, image.height)
    let colored = 0
    let unexpected = 0
    const examples = new Set()
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
      const high = Math.max(r, g, b)
      const low = Math.min(r, g, b)
      const delta = high - low
      if (delta <= 20) continue
      colored++
      const rawHue = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4
      const hue = (rawHue * 60 + 360) % 360
      if (hue >= 62 && hue <= 86) continue
      unexpected++
      if (examples.size < 6) examples.add(`rgb(${r},${g},${b})`)
    }
    return { coloredRatio: colored / (image.width * image.height), unexpected, examples: [...examples] }
  }, buffer.toString('base64'))
}

async function checkDatePicker(page, name) {
  const trigger = page.locator('.date-picker-trigger')
  await trigger.click()
  const apply = page.locator('.date-picker-apply')
  await apply.waitFor()
  await auditTypography(page, `${name}-date-menu`)
  for (const hovered of [false, true]) {
    if (hovered) await apply.hover()
    const contrast = await apply.evaluate(button => {
      const style = getComputedStyle(button)
      const luminance = color => {
        const channels = color.match(/\d+/g).slice(0, 3).map(channel => {
          const value = Number(channel) / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const [high, low] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a)
      return (high + 0.05) / (low + 0.05)
    })
    assert(contrast >= 7, `${name}: unreadable date apply button, hovered=${hovered}`)
  }
  await page.locator('.date-picker-dropdown').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/${name}-date-menu.png`, scale: 'css' })
  await trigger.click()
  await page.locator('.date-picker-dropdown').waitFor({ state: 'hidden' })
}

async function auditTypography(page, name) {
  const typography = await page.locator('.skin-dashboard').evaluate(root => {
    const colors = new Set()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.textContent.trim() && node.parentElement.getClientRects().length) {
        colors.add(getComputedStyle(node.parentElement).color)
      }
    }
    for (const field of root.querySelectorAll('input, select, textarea')) {
      if (field.getClientRects().length) colors.add(getComputedStyle(field).color)
    }
    const dark = document.documentElement.classList.contains('dark')
    const primary = dark ? 'rgb(244, 244, 244)' : 'rgb(23, 23, 21)'
    const secondary = dark ? 'rgb(188, 188, 188)' : 'rgb(74, 74, 74)'
    const luminance = gray => {
      const value = gray / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    // Use conservative channel bounds for the slightly warm paper/ink reference.
    const foregrounds = dark ? [244, 188] : [23, 74]
    const backgrounds = dark ? [24, 34] : [240, 244]
    const minimumContrast = Math.min(...foregrounds.flatMap(text => backgrounds.map(background => {
      const values = [luminance(text), luminance(background)].sort((a, b) => b - a)
      return (values[0] + 0.05) / (values[1] + 0.05)
    })))
    return { colors: [...colors].sort(), expected: [primary, secondary].sort(), minimumContrast }
  })
  assert.deepEqual(typography.colors, typography.expected, `${name}: dashboard has more than two text tones`)
  assert(typography.minimumContrast >= 7, `${name}: low text contrast`)
  return typography
}

async function checkFit(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(800)
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    switcher: (() => {
      const r = document.querySelector('.skin-switcher').getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()
  }))
  assert(dimensions.scrollWidth <= dimensions.width, `${name}: page overflow`)
  assert(dimensions.switcher.x >= 0 && dimensions.switcher.x + dimensions.switcher.width <= dimensions.width,
    `${name}: switcher clipped`)
  assert.equal(dimensions.switcher.width, 36)
  const clippedValues = await page.locator('.skin-dashboard-metrics .text-xl').evaluateAll(elements =>
    elements.filter(e => e.scrollWidth > e.clientWidth).map(e => e.textContent))
  assert.deepEqual(clippedValues, [], `${name}: metric value clipped`)
  await page.screenshot({ path: `${output}/${name}.png`, scale: 'css' })
  let palette
  let typography
  if (await page.locator('html').getAttribute('data-skin') === 'neubrutalism') {
    palette = await auditPixels(page, await page.screenshot({ fullPage: true, scale: 'css' }))
    assert.equal(palette.unexpected, 0, `${name}: unexpected original colors ${palette.examples.join(', ')}`)
    assert(palette.coloredRatio < 0.08, `${name}: fluorescent accents occupy too much of the page`)
    if (await page.locator('.skin-dashboard').count()) {
      typography = await auditTypography(page, name)
    }
    for (const canvas of await page.locator('canvas').all()) {
      const chart = await auditPixels(page, await canvas.screenshot({ scale: 'css' }))
      assert.equal(chart.coloredRatio, 0, `${name}: chart contains chromatic pixels`)
      assert(await canvas.evaluate(element => {
        const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data
        let painted = 0
        for (let i = 3; i < data.length; i += 4) if (data[i]) painted++
        return painted > 100
      }), `${name}: blank chart`)
    }
    if (await page.locator('canvas').count()) {
      await page.screenshot({ path: `${output}/${name}-charts.png`, scale: 'css' })
    }
    if (await page.locator('.skin-chart-swatch').count()) {
      const transitions = await page.locator('canvas').first().evaluate(canvas => {
        const { width, height } = canvas
        const data = canvas.getContext('2d').getImageData(0, Math.floor(height * 0.16), width, 1).data
        const threshold = document.documentElement.classList.contains('dark') ? 111 : 164
        let previous
        let changes = 0
        for (let x = Math.floor(width * 0.3); x < width * 0.7; x++) {
          const current = data[x * 4] > threshold
          if (previous !== undefined && previous !== current) changes++
          previous = current
        }
        return changes
      })
      assert(transitions > 8, `${name}: doughnut lacks diagonal hatch detail`)
      await page.locator('canvas').first().evaluate(canvas => {
        const top = canvas.getBoundingClientRect().top + window.scrollY
        window.scrollTo(0, Math.max(0, top - 112))
      })
      await page.locator('canvas').first().screenshot({ path: `${output}/${name}-hatching.png`, scale: 'css' })
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  results.push({ name, ...dimensions, palette, typography })
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const version = await (await context.request.get(`${base}/api/v1/admin/system/version`)).json()
  assert.equal(version.data.version, 'skin-preview', 'QA must target the synthetic preview')
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/admin/dashboard`)
  await page.locator('.skin-dashboard-metrics').first().waitFor()
  await page.getByRole('button', { name: '克制的新粗野主义', exact: true }).waitFor()
  await checkFit(page, 'desktop-neubrutalism')
  await checkDatePicker(page, 'desktop-neubrutalism')
  const skinButton = page.getByRole('button', { name: '克制的新粗野主义', exact: true })
  assert.equal(await skinButton.getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('.skin-dashboard-metrics .card').first().evaluate(e => getComputedStyle(e).borderRadius), '0px')
  await skinButton.click()
  assert.equal(await page.locator('html').getAttribute('data-skin'), 'original')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.skin-dashboard-metrics .card')).borderRadius === '16px')
  assert.equal(await page.locator('.skin-dashboard-metrics .card').first().evaluate(e => getComputedStyle(e).borderRadius), '16px')
  await checkFit(page, 'desktop-original')
  await page.reload()
  await page.locator('.skin-dashboard-metrics').first().waitFor()
  assert.equal(await page.locator('html').getAttribute('data-skin'), 'original')
  await skinButton.focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('html').getAttribute('data-skin'), 'neubrutalism')

  const secondTab = await context.newPage()
  await secondTab.goto(`${base}/admin/dashboard`)
  await secondTab.locator('.skin-dashboard-metrics').first().waitFor()
  await skinButton.click()
  await secondTab.waitForFunction(() => document.documentElement.dataset.skin === 'original')
  await skinButton.click()
  await secondTab.waitForFunction(() => document.documentElement.dataset.skin === 'neubrutalism')
  await secondTab.close()

  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  assert.equal(await page.locator('html').evaluate(e => e.classList.contains('dark')), true)
  await checkFit(page, 'desktop-neubrutalism-dark')
  await checkDatePicker(page, 'desktop-neubrutalism-dark')
  await skinButton.click()
  assert.equal(await page.locator('html').evaluate(e => e.classList.contains('dark')), true)
  await checkFit(page, 'desktop-original-dark')
  await skinButton.click()
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()

  await page.getByRole('button', { name: '用户消费榜', exact: true }).click()
  await checkFit(page, 'desktop-ranking')
  await page.getByRole('button', { name: '模型分布', exact: true }).click()

  await page.getByRole('link', { name: '用户管理', exact: true }).click()
  await page.waitForURL('**/admin/users')
  assert.equal(await page.locator('html').getAttribute('data-skin'), 'neubrutalism')
  await checkFit(page, 'desktop-users')
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await checkFit(page, 'desktop-users-dark')
  await page.getByRole('button', { name: '创建用户', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建用户', exact: true })
  await dialog.waitFor()
  await dialog.locator('input[type="email"]').fill('unsaved@example.invalid')
  await dialog.locator('select').selectOption('admin')
  await checkFit(page, 'desktop-users-dark-dialog')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await page.getByTitle('中文', { exact: true }).click()
  await checkFit(page, 'desktop-locale-menu')
  await page.getByTitle('中文', { exact: true }).click()

  const commentContext = await browser.newContext({ viewport: { width: 983, height: 895 }, deviceScaleFactor: 2 })
  const commentPage = await commentContext.newPage()
  commentPage.on('pageerror', error => errors.push(error.message))
  await commentPage.goto(`${base}/admin/dashboard`)
  await commentPage.locator('.skin-dashboard-metrics').first().waitFor()
  await checkFit(commentPage, 'comment-983-neubrutalism')
  await checkDatePicker(commentPage, 'comment-983-neubrutalism')
  const modelCard = commentPage.locator('.card').filter({ has: commentPage.locator('canvas') }).first()
  await modelCard.scrollIntoViewIfNeeded()
  await commentPage.screenshot({ path: `${output}/comment-983-chart-table.png`, scale: 'css' })
  await commentPage.getByRole('button', { name: '切换菜单', exact: true }).click()
  await commentPage.getByRole('button', { name: '深色模式', exact: true }).click()
  await commentPage.getByRole('link', { name: '仪表盘', exact: true }).click()
  await checkFit(commentPage, 'comment-983-neubrutalism-dark')
  await checkDatePicker(commentPage, 'comment-983-neubrutalism-dark')
  await commentContext.close()

  for (const width of [390, 320]) {
    const mobile = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true })
    const mobilePage = await mobile.newPage()
    mobilePage.on('pageerror', error => errors.push(error.message))
    await mobilePage.goto(`${base}/admin/dashboard`)
    await mobilePage.locator('.skin-dashboard-metrics').first().waitFor()
    await checkFit(mobilePage, `mobile-${width}-neubrutalism`)
    await mobilePage.getByRole('button', { name: '切换菜单' }).click()
    await mobilePage.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().x === 0)
    assert.equal(await mobilePage.locator('.sidebar').evaluate(e => e.getBoundingClientRect().x), 0)
    await mobilePage.screenshot({ path: `${output}/mobile-${width}-navigation.png`, scale: 'css' })
    await mobile.close()
  }

  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const login = await guest.newPage()
  await login.goto(`${base}/login`)
  await login.getByRole('button', { name: '克制的新粗野主义', exact: true }).waitFor()
  await checkFit(login, 'mobile-login')
  await login.getByRole('button', { name: '克制的新粗野主义', exact: true }).click()
  assert.equal(await login.locator('html').getAttribute('data-skin'), 'original')
  await guest.close()

  const corrupted = await browser.newContext()
  await corrupted.addInitScript(() => localStorage.setItem('sub2api.skin', 'unknown-skin'))
  const recovery = await corrupted.newPage()
  await recovery.goto(`${base}/admin/dashboard`)
  await recovery.locator('.skin-dashboard-metrics').first().waitFor()
  assert.equal(await recovery.locator('html').getAttribute('data-skin'), 'original')
  await recovery.getByRole('button', { name: '克制的新粗野主义', exact: true }).click()
  assert.equal(await recovery.locator('html').getAttribute('data-skin'), 'neubrutalism')
  await corrupted.close()

  const blockedWrite = await context.request.post(`${base}/api/v1/admin/settings`, { data: { site_name: 'not applied' } })
  assert.equal(blockedWrite.status(), 405)
  assert.equal((await (await context.request.get(`${base}/api/v1/settings/public`)).json()).data.site_name, 'Sub2API')
  assert.deepEqual(errors, [])
  await context.close()
  console.log(JSON.stringify({ passed: true, results, screenshots: output }, null, 2))
} finally {
  await browser.close()
}
