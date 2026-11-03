import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import FactoryUsageCell from '../FactoryUsageCell.vue'
import type { AccountUsageInfo } from '@/types'

vi.mock('vue-i18n', async () => ({
  ...await vi.importActual<typeof import('vue-i18n')>('vue-i18n'),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key })
}))

const now = '2026-11-03T04:00:00Z'
function usage(): AccountUsageInfo {
  return {
    updated_at: now, five_hour: null, seven_day: null, seven_day_sonnet: null,
    factory_usage: { stale: false, has_active_subscription: true, overage_mode: 'droidCore', extra_usage_balance_cents: 1234 },
    quota_windows: [
      { key: 'factory_standard_five_hour', utilization: 0, resets_at: '2026-11-03T08:00:00Z', sampled_at: now, source: 'upstream', scope: 'standard' },
      { key: 'factory_core_monthly', utilization: 102.5, resets_at: '2026-12-01T00:00:00Z', sampled_at: now, source: 'upstream', scope: 'core' }
    ]
  }
}
const wrappers: ReturnType<typeof mount>[] = []
function render(snapshot: AccountUsageInfo | null = usage()) {
  const wrapper = mount(FactoryUsageCell, { props: { usage: snapshot } })
  wrappers.push(wrapper)
  return wrapper
}

describe('FactoryUsageCell', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
  afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() })

  it('shows observed zero and overage but leaves missing windows unknown, with cents converted only to money', () => {
    const wrapper = render()
    expect(wrapper.get('[data-testid="factory_standard_five_hour"]').text()).toContain('0%')
    expect(wrapper.get('[data-testid="factory_core_monthly"]').attributes('title')).toBe('102.5%')
    expect(wrapper.get('[data-testid="factory_core_weekly"]').text()).toContain('usage.unknown')
    expect(wrapper.get('[data-testid="factory-extra-balance"]').text()).toContain('12.34')
    expect(wrapper.find('[data-testid="factory-stale"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('usage.percentOnly')
    expect(wrapper.text()).toContain('Droid Core')
    expect(wrapper.text()).not.toContain('droidCore')
  })

  it('shows unknown overage and reset metadata without inventing a countdown', () => {
    const snapshot = usage()
    snapshot.factory_usage!.overage_mode = undefined
    snapshot.quota_windows![0].resets_at = null
    const wrapper = render(snapshot)
    expect(wrapper.text()).toContain('usage.overage: admin.accounts.factory.usage.unknown')
    expect(wrapper.text()).toContain('usage.resetUnknown')
  })

  it('retains prior percentages and sample time when a refresh fails', async () => {
    const wrapper = render()
    await wrapper.setProps({ error: 'Request failed' })
    expect(wrapper.find('[data-testid="factory-stale"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="factory-error"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="factory_core_monthly"]').attributes('title')).toBe('102.5%')
    expect(wrapper.get('[data-testid="factory-updated"]').attributes('title')).toBe(now)
  })

  it('honors the manual refresh cooldown and upstream retry deadline', async () => {
    const snapshot = usage()
    snapshot.factory_usage = { stale: false, last_attempt_at: now, retry_after_seconds: 45 }
    const wrapper = render(snapshot)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('refresh')).toEqual([[true]])
  })

  it('ages the snapshot and requests a cached refresh every five minutes', async () => {
    const wrapper = render()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(wrapper.find('[data-testid="factory-stale"]').exists()).toBe(true)
    expect(wrapper.emitted('refresh')).toEqual([[false]])
  })
})
