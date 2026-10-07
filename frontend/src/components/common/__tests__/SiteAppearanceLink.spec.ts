import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'
import SkinSwitcher from '../SkinSwitcher.vue'
import { useAuthStore } from '@/stores/auth'

describe('admin appearance entry', () => {
  it.each(['admin', 'user', null])('shows only for %s when authorized', (role) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore()
    auth.user = role ? { id: 1, role } as typeof auth.user : null
    const wrapper = mount(SkinSwitcher, { global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en: {} } })],
      stubs: { RouterLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' } }
    } })
    expect(wrapper.find('a').exists()).toBe(role === 'admin')
    expect(wrapper.find('button').exists()).toBe(false)
    if (role === 'admin') expect(wrapper.get('a').attributes('data-to')).toContain('#site-appearance')
    wrapper.unmount()
  })
})
