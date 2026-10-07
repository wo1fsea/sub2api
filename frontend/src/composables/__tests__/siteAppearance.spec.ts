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
