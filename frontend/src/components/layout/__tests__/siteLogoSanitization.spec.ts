import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const sidebarSource = readFileSync(resolve(dir, '../AppSidebar.vue'), 'utf8')
const homeViewSource = readFileSync(resolve(dir, '../../../views/HomeView.vue'), 'utf8')
const keyUsageViewSource = readFileSync(resolve(dir, '../../../views/KeyUsageView.vue'), 'utf8')

describe('site_logo sanitization', () => {
  it('AppSidebar imports resolveBrandLogo and applies it to siteLogo', () => {
    expect(sidebarSource).toContain("import { resolveBrandLogo } from '@/utils/branding'")
    expect(sidebarSource).toContain('resolveBrandLogo(appStore.siteLogo')
  })

  it('HomeView applies resolveBrandLogo to siteLogo', () => {
    expect(homeViewSource).toContain('resolveBrandLogo(appStore.cachedPublicSettings?.site_logo || appStore.siteLogo')
  })

  it('KeyUsageView applies resolveBrandLogo to siteLogo', () => {
    expect(keyUsageViewSource).toContain('resolveBrandLogo(appStore.cachedPublicSettings?.site_logo || appStore.siteLogo')
  })

  it('all three share the same logo resolver', () => {
    for (const src of [sidebarSource, homeViewSource, keyUsageViewSource]) {
      expect(src).toContain("import { resolveBrandLogo } from '@/utils/branding'")
    }
  })
})
