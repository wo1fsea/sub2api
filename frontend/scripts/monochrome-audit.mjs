// Read-only browser diagnostics shared by interactive QA and future skin reviews.
// Raster/user content is deliberately not recolored; inspect canvas charts separately.
export async function auditMonochrome(page) {
  return page.evaluate(() => {
    const findings = []
    const seen = new Set()
    let preservedBrandElements = 0
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const pixels = canvas.getContext('2d', { willReadFrequently: true })
    function colored(value) {
      return [...value.matchAll(/(?:rgba?|color|oklch|oklab|lab|lch|hsla?)\([^)]*\)|#[\da-f]{3,8}\b/gi)].some(match => {
        pixels.clearRect(0, 0, 1, 1)
        pixels.fillStyle = '#000'
        pixels.fillStyle = match[0]
        pixels.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = pixels.getImageData(0, 0, 1, 1).data
        return a > 5 && Math.max(r, g, b) - Math.min(r, g, b) > 8
      })
    }
    for (const el of document.body.querySelectorAll('*')) {
      if (!el.getClientRects().length || el.closest('[data-skin-audit-exclude]')) continue
      if (el.closest('.model-icon')) { preservedBrandElements++; continue }
      const actual = getComputedStyle(el)
      if (actual.visibility !== 'visible' || Number(actual.opacity) === 0) continue
      for (const pseudo of [null, '::before', '::after']) {
        const style = pseudo ? getComputedStyle(el, pseudo) : actual
        if (pseudo && ['none', 'normal', '""'].includes(style.content) && !style.width.match(/[1-9]/)) continue
        if (pseudo && ['none', 'normal'].includes(style.content)) continue
        const properties = ['backgroundColor', 'backgroundImage', 'boxShadow', 'outlineColor', 'textDecorationColor']
        const ownText = [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        if (ownText || pseudo || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) properties.push('color')
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          if (parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none') properties.push(`border${side}Color`)
        }
        if (el instanceof SVGElement) properties.push('fill', 'stroke')
        if (['checkbox', 'radio'].includes(el.type)) properties.push('accentColor')
        for (const property of properties) {
          if (property === 'outlineColor' && (!parseFloat(style.outlineWidth) || style.outlineStyle === 'none')) continue
          if (property === 'textDecorationColor' && style.textDecorationLine === 'none') continue
          const value = style[property]
          if (!value || !colored(value)) continue
          const selector = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].slice(0, 5).join('.')}${pseudo || ''}`
          const key = `${selector}|${property}|${value}`
          if (!seen.has(key)) { seen.add(key); findings.push({ selector, property, value }) }
        }
      }
    }
    return {
      path: location.pathname,
      skin: document.documentElement.dataset.skin,
      mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      preservedBrandElements,
      findings
    }
  })
}

export async function auditChartPixels(page) {
  return page.locator('canvas').evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let painted = 0
    let colored = 0
    for (let index = 0; index < pixels.length; index += 4) {
      const [r, g, b, a] = pixels.slice(index, index + 4)
      if (a <= 5) continue
      painted++
      if (Math.max(r, g, b) - Math.min(r, g, b) > 8) colored++
    }
    return { painted, colored }
  }))
}

// Candidate text-contrast findings need visual review: this cannot model an
// overlapping sibling, an image background, or canvas-rendered text.
export async function auditTextContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const pixels = canvas.getContext('2d', { willReadFrequently: true })
    const cache = new Map()
    const parse = value => {
      if (!cache.has(value)) {
        pixels.clearRect(0, 0, 1, 1)
        pixels.fillStyle = value
        pixels.fillRect(0, 0, 1, 1)
        const rgb = [...pixels.getImageData(0, 0, 1, 1).data]
        cache.set(value, [...rgb.slice(0, 3), rgb[3] / 255])
      }
      return cache.get(value)
    }
    const over = (top, bottom) => top.slice(0, 3).map((v, i) => v * top[3] + bottom[i] * (1 - top[3]))
    const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    const findings = []
    for (const el of document.body.querySelectorAll('*')) {
      if (!el.getClientRects().length || el instanceof SVGElement || el.closest('button:disabled, [aria-disabled="true"], .model-icon')) continue
      if (![...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue
      const style = getComputedStyle(el)
      if (style.visibility !== 'visible') continue
      const ancestors = []
      for (let a = el; a; a = a.parentElement) ancestors.unshift(a)
      if (ancestors.some(a => Number(getComputedStyle(a).opacity) < .99)) continue
      let background = [255, 255, 255]
      for (const a of ancestors) background = over(parse(getComputedStyle(a).backgroundColor), background)
      const foreground = over(parse(style.color), background)
      const [high, low] = [lum(foreground), lum(background)].sort((a, b) => b - a)
      const ratio = (high + .05) / (low + .05)
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700)
      const required = large ? 3 : 4.5
      if (ratio + .05 < required) findings.push({
        tag: el.tagName.toLowerCase(), classes: [...el.classList].join(' '),
        text: el.textContent.trim().slice(0, 70), ratio: +ratio.toFixed(2), required,
        color: style.color, background: background.map(Math.round)
      })
    }
    return findings
  })
}

export const reviewRoutes = [
  '/admin/dashboard', '/admin/quota-overview', '/admin/users', '/admin/groups',
  '/admin/accounts', '/admin/channels/pricing', '/admin/announcements', '/admin/proxies',
  '/admin/redeem', '/admin/promo-codes', '/admin/usage', '/admin/audit-logs',
  '/admin/settings', '/keys', '/usage', '/redeem', '/profile', '/dashboard?role=user',
  '/key-usage', '/home', '/login', '/__skin/components', '/__skin/charts'
]

export const optionalReviewRoutes = [
  '/admin/ops', '/admin/channels/monitor', '/admin/subscriptions', '/admin/plugins',
  '/admin/risk-control', '/admin/prompt-audit', '/admin/affiliates/invites',
  '/admin/affiliates/rebates', '/admin/affiliates/transfers', '/admin/orders/dashboard',
  '/admin/orders', '/admin/orders/plans', '/batch-image', '/affiliate',
  '/available-channels', '/subscriptions', '/purchase', '/orders', '/monitor', '/model-plaza'
]
