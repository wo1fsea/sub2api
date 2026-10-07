import { beforeEach, describe, expect, it } from 'vitest'
import { resolveBrandLogo, updateFavicon } from '../branding'
import { applySiteAppearance } from '@/composables/useSkin'

describe('shared brand mark', () => {
  beforeEach(() => applySiteAppearance())
  it('preserves valid uploads and rejects executable logo URLs', () => {
    expect(resolveBrandLogo('/uploads/custom.png')).toBe('/uploads/custom.png')
    updateFavicon('https://example.com/custom-logo.png')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('https://example.com/custom-logo.png')
    expect(resolveBrandLogo('javascript:alert(1)')).toBe(resolveBrandLogo(''))
  })
  it('uses identical header/favicon artwork and follows the site appearance', () => {
    updateFavicon('')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(resolveBrandLogo(''))
    const light = resolveBrandLogo('')
    applySiteAppearance({ mode: 'dark', accent_color: '#102030' })
    expect(resolveBrandLogo('')).not.toBe(light)
    expect(decodeURIComponent(resolveBrandLogo(''))).toContain('#102030')
    expect(decodeURIComponent(resolveBrandLogo(''))).not.toContain('__INK__')
  })
})
