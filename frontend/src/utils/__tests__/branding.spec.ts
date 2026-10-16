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
  it('neutralizes the default mark for monochrome but keeps its shape and custom uploads', () => {
    expect(resolveBrandLogo('/uploads/custom.png')).toBe('/uploads/custom.png')
    applySiteAppearance({ skin: 'monochrome', mode: 'light', accent_color: '#102030' })
    const light = decodeURIComponent(resolveBrandLogo(''))
    expect(light).toContain('#171717')
    // The stored accent is retained for other skins but is ignored here.
    expect(light).not.toContain('#102030')
    applySiteAppearance({ skin: 'monochrome', mode: 'dark', accent_color: '#102030' })
    const dark = decodeURIComponent(resolveBrandLogo(''))
    expect(dark).toContain('#f5f5f5')
    expect(dark).not.toContain('#102030')
    // Same geometry for every skin; only the palette differs.
    applySiteAppearance({ skin: 'neubrutalism', mode: 'light', accent_color: '#102030' })
    const legacy = decodeURIComponent(resolveBrandLogo(''))
    expect(legacy).toContain('#102030')
    const shape = (value: string) => value.replace(/#[0-9a-f]{6}/gi, 'COLOR').replace(/\s+/g, ' ')
    expect(shape(legacy)).toBe(shape(light))
  })
})
