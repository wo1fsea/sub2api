import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import QuotaOverviewView from '../QuotaOverviewView.vue'
import zh from '@/i18n/locales/zh'
import type { AccountListItem, AccountQuotaWindow, AccountUsageInfo } from '@/types'

const { list, getBatchUsage } = vi.hoisted(() => ({ list: vi.fn(), getBatchUsage: vi.fn() }))
vi.mock('@/api/admin/accounts', () => ({ default: { list, getBatchUsage } }))
vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, params: Record<string, string | number> = {}) => {
        const message = key.split('.').reduce<unknown>((value, part) => (
          value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
        ), zh)
        return typeof message === 'string' ? message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? '')) : key
      }
    })
  }
})
const sampledAt = '2026-10-08T02:00:00Z'
const resetAt = '2026-10-08T05:00:00Z'
const wrappers: VueWrapper[] = []
function account(id: number, name: string, platform = 'openai'): AccountListItem {
  return { id, name, platform, type: 'oauth', status: 'active' } as AccountListItem
}
function window(key: string, used: number, sampled = sampledAt, model?: string): AccountQuotaWindow {
  return { key, utilization: used, sampled_at: sampled, resets_at: resetAt, source: 'upstream', scope: model ? 'model' : 'account', model, window_minutes: key === 'five_hour' ? 300 : 10080 }
}
function usage(windows: AccountQuotaWindow[]): AccountUsageInfo {
  return { updated_at: sampledAt, five_hour: null, seven_day: null, seven_day_sonnet: null, quota_windows: windows } as AccountUsageInfo
}
function mountView() {
  const wrapper = mount(QuotaOverviewView, {
    global: {
      stubs: {
        AppLayout: { template: '<div><slot /></div>' },
        BaseDialog: { props: ['show', 'title'], template: '<div v-if="show" data-test="quota-details"><slot /><slot name="footer" /></div>' },
        RouterLink: { template: '<a><slot /></a>' },
        LoadingSpinner: true
      }
    }
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('QuotaOverviewView', () => {
  beforeEach(() => {
    list.mockReset()
    getBatchUsage.mockReset()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(sampledAt))
  })
  afterEach(() => {
    wrappers.splice(0).forEach(wrapper => wrapper.unmount())
    vi.restoreAllMocks()
  })

  it('shows real zero usage as 100% remaining and keeps model-only and stale readings explicit', async () => {
    list.mockResolvedValue({ items: [account(1, 'Idle'), account(2, 'Sonnet only', 'anthropic'), account(3, 'Old sample')], total: 3, pages: 1 })
    getBatchUsage.mockResolvedValue({
      usage: {
        1: usage([window('five_hour', 0), window('seven_day', 0)]),
        2: usage([window('seven_day_sonnet', 87, sampledAt, 'Sonnet')]),
        3: usage([window('five_hour', 95, '2026-10-08T00:00:00Z'), window('seven_day', 40)])
      },
      errors: {}
    })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-account-id="1"] [data-test="remaining-value"]').text()).toBe('100%')
    const modelCard = wrapper.find('[data-account-id="2"]')
    expect(modelCard.text()).toContain('仅 Sonnet')
    expect(modelCard.text()).toContain('已知最紧窗口剩余')
    expect(modelCard.text()).toContain('部分窗口未知')
    expect(wrapper.find('[data-account-id="3"]').text()).toContain('上次最紧窗口剩余')
    const priorityFilter = wrapper.findAll('.qo-filter').find(button => button.text().startsWith('优先关注'))!
    await priorityFilter.trigger('click')
    expect(wrapper.findAll('.qo-account')).toHaveLength(1)
    expect(wrapper.find('.qo-account').attributes('data-account-id')).toBe('2')
    await wrapper.find('.qo-card-open').trigger('click')
    const details = wrapper.find('[data-test="quota-details"]')
    expect(details.text()).toContain('模型限额仅影响对应模型')
    expect(details.text()).toContain('上游读数')
    expect(details.text()).toContain('读数时间')
  })

  it('provides a retry after an initial account-list failure', async () => {
    list.mockRejectedValueOnce(new Error('unavailable'))
    list.mockResolvedValueOnce({ items: [account(1, 'Recovered')], total: 1, pages: 1 })
    getBatchUsage.mockResolvedValue({ usage: { 1: usage([window('five_hour', 12), window('seven_day', 30)]) }, errors: {} })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.findAll('.qo-account')).toHaveLength(0)
    await wrapper.findAll('button').find(button => button.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-account-id="1"]').text()).toContain('Recovered')
    expect(getBatchUsage).toHaveBeenCalledTimes(1)
    expect(getBatchUsage).toHaveBeenCalledWith([1], true, { timeout: 45_000, signal: expect.any(AbortSignal) })
  })
})
