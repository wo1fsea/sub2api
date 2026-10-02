import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it } from 'vitest'
import SkinSwitcher from '../SkinSwitcher.vue'
import { initSkin, SKIN_STORAGE_KEY } from '@/composables/useSkin'

describe('SkinSwitcher', () => {
  beforeEach(() => {
    localStorage.clear()
    initSkin()
  })

  it('toggles only the custom skin and exposes the selected state', async () => {
    const wrapper = mount(SkinSwitcher, {
      global: {
        plugins: [createI18n({ legacy: false, locale: 'en', messages: {
          en: { common: { clashSkin: () => 'Clash skin', useOriginalSkin: () => 'Use original skin', useClashSkin: () => 'Use Clash skin' } }
        } })]
      }
    })
    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('Clash skin')
    expect(button.attributes('aria-pressed')).toBe('true')
    await button.trigger('click')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.attributes('title')).toBe('Use Clash skin')
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe('original')
    await button.trigger('click')
    expect(button.attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })
})
