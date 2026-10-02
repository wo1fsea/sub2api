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
          en: { common: { neubrutalismSkin: () => 'Restrained Neubrutalism', useOriginalSkin: () => 'Use original skin', useNeubrutalismSkin: () => 'Use Restrained Neubrutalism' } }
        } })]
      }
    })
    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('Restrained Neubrutalism')
    expect(button.attributes('aria-pressed')).toBe('true')
    await button.trigger('click')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.attributes('title')).toBe('Use Restrained Neubrutalism')
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe('original')
    await button.trigger('click')
    expect(button.attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })
})
