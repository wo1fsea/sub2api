import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initSkin, setSkin, SKIN_STORAGE_KEY, useSkin } from '../useSkin'

describe('skin preference', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    initSkin()
  })

  it('defaults to the one custom skin before mount', () => {
    expect(document.documentElement.dataset.skin).toBe('clash')
    expect(useSkin().skin.value).toBe('clash')
  })

  it('persists original appearance without changing dark mode', () => {
    document.documentElement.classList.add('dark')
    setSkin('original')
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe('original')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    initSkin()
    expect(document.documentElement.dataset.skin).toBe('original')
  })

  it('restores the custom skin and falls back safely on an unknown saved id', () => {
    localStorage.setItem(SKIN_STORAGE_KEY, 'clash')
    initSkin()
    expect(useSkin().skin.value).toBe('clash')
    localStorage.setItem(SKIN_STORAGE_KEY, 'not-a-skin')
    initSkin()
    expect(useSkin().skin.value).toBe('original')
  })

  it('synchronizes another tab and resets when storage is cleared', () => {
    window.dispatchEvent(new StorageEvent('storage', { key: SKIN_STORAGE_KEY, newValue: 'original' }))
    expect(useSkin().skin.value).toBe('original')
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }))
    expect(useSkin().skin.value).toBe('clash')
  })

  it('ignores unrelated preferences', () => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }))
    expect(useSkin().skin.value).toBe('clash')
  })

  it('does not block startup or switching when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => initSkin()).not.toThrow()
    expect(() => setSkin('original')).not.toThrow()
    expect(document.documentElement.dataset.skin).toBe('original')
  })
})
