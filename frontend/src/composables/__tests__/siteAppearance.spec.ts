import { beforeEach, describe, expect, it } from 'vitest'
import { accentInk, applySiteAppearance, initSkin, normalizeSiteAppearance, useSkin } from '../useSkin'

describe('authoritative site appearance', () => {
  beforeEach(() => {
    delete window.__APP_CONFIG__
    localStorage.clear()
    applySiteAppearance()
  })

  it('ignores old device and cross-tab preferences', () => {
    localStorage.setItem('sub2api_skin', 'original')
    localStorage.setItem('theme', 'dark')
    initSkin()
    window.dispatchEvent(new StorageEvent('storage', { key: 'sub2api_skin', newValue: 'original' }))
    expect(useSkin().skin.value).toBe('neubrutalism')
    expect(useSkin().isDark.value).toBe(false)
  })

  it('applies server skin, mode and accent together and can return to defaults', () => {
    applySiteAppearance({ skin: 'original', mode: 'dark', accent_color: '#102030' })
    expect(document.documentElement.dataset.skin).toBe('original')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--site-accent-color')).toBe('#102030')
    applySiteAppearance()
    expect(useSkin().isDark.value).toBe(false)
    expect(useSkin().skin.value).toBe('neubrutalism')
  })

  it('normalizes malformed appearance without injecting CSS', () => {
    expect(normalizeSiteAppearance({ accent_color: 'red;display:none' }).accent_color).toBe('#d4ff3f')
  })

  it('normalizes monochrome as a distinct third skin', () => {
    expect(normalizeSiteAppearance({ skin: 'monochrome', mode: 'dark' })).toEqual({
      skin: 'monochrome', mode: 'dark', accent_color: '#d4ff3f'
    })
    // Malformed or unknown skins still fall back to the stored default, not monochrome.
    expect(normalizeSiteAppearance({ skin: 'monochrome-ish' }).skin).toBe('neubrutalism')
    expect(normalizeSiteAppearance({ skin: 'original' }).skin).toBe('original')
  })

  it('applies the monochrome skin from server init and can move between light and dark', () => {
    window.__APP_CONFIG__ = { site_appearance: { skin: 'monochrome', mode: 'light', accent_color: '#102030' } }
    initSkin()
    expect(useSkin().skin.value).toBe('monochrome')
    expect(useSkin().isDark.value).toBe(false)
    expect(document.documentElement.dataset.skin).toBe('monochrome')
    applySiteAppearance({ skin: 'monochrome', mode: 'dark', accent_color: '#102030' })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    // The stored accent is kept for the other skins even though monochrome ignores it.
    expect(document.documentElement.style.getPropertyValue('--site-accent-color')).toBe('#102030')
    applySiteAppearance({ skin: 'monochrome', mode: 'light', accent_color: '#102030' })
    expect(useSkin().isDark.value).toBe(false)
    expect(document.documentElement.dataset.skin).toBe('monochrome')
  })

  it('returns from monochrome to a legacy skin without losing the stored accent', () => {
    applySiteAppearance({ skin: 'monochrome', mode: 'dark', accent_color: '#102030' })
    applySiteAppearance({ skin: 'neubrutalism', mode: 'dark', accent_color: '#102030' })
    expect(document.documentElement.dataset.skin).toBe('neubrutalism')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--site-accent-color')).toBe('#102030')
    applySiteAppearance({ skin: 'original', mode: 'light', accent_color: '#102030' })
    expect(document.documentElement.dataset.skin).toBe('original')
    expect(useSkin().isDark.value).toBe(false)
    expect(useSkin().skin.value).toBe('original')
  })

  it('keeps primary-action text at least 4.5:1 for any gray accent', () => {
    for (let value = 0; value < 256; value++) {
      const color = '#' + value.toString(16).padStart(2, '0').repeat(3)
      const channel = value / 255
      const luminance = channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
      const contrast = accentInk(color) === '#000000' ? (luminance + .05) / .05 : 1.05 / (luminance + .05)
      expect(contrast).toBeGreaterThanOrEqual(4.5)
    }
  })
})
