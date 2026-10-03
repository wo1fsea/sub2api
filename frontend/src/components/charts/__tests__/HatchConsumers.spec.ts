import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import GroupDistributionChart from '../GroupDistributionChart.vue'
import EndpointDistributionChart from '../EndpointDistributionChart.vue'
import UserDashboardCharts from '@/components/user/dashboard/UserDashboardCharts.vue'
import PaymentMethodChart from '@/components/admin/payment/PaymentMethodChart.vue'
import DailyRevenueChart from '@/components/admin/payment/DailyRevenueChart.vue'
import OpsLatencyChart from '@/views/admin/ops/components/OpsLatencyChart.vue'
import OpsErrorDistributionChart from '@/views/admin/ops/components/OpsErrorDistributionChart.vue'
import OpsThroughputTrendChart from '@/views/admin/ops/components/OpsThroughputTrendChart.vue'
import OpsErrorTrendChart from '@/views/admin/ops/components/OpsErrorTrendChart.vue'
import OpsSwitchRateTrendChart from '@/views/admin/ops/components/OpsSwitchRateTrendChart.vue'
import { setSkin } from '@/composables/useSkin'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key })
}))
vi.mock('vue-chartjs', () => {
  const chart = (name: string) => defineComponent({ name, props: ['data', 'options'], template: '<div />' })
  return { Doughnut: chart('Doughnut'), Line: chart('Line'), Bar: chart('Bar') }
})
const wrappers: ReturnType<typeof mount>[] = []
const usage = (index: number) => ({ requests: index + 1, total_tokens: index + 100,
  cost: index + 1, actual_cost: 30 - index, account_cost: 1 })
const global = { stubs: { DateRangePicker: true, Select: true, HelpTooltip: true, LoadingSpinner: true } }
function render(component: any, props: any) {
  const wrapper = mount(component, { props, global })
  wrappers.push(wrapper)
  return wrapper
}
function dataset(wrapper: ReturnType<typeof mount>, name = 'Doughnut') {
  return wrapper.findComponent({ name }).props('data').datasets[0]
}

describe('hatch chart consumers', () => {
  beforeEach(() => {
    setSkin('neubrutalism')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      createPattern: () => ({ hatch: true })
    } as unknown as CanvasRenderingContext2D))
  })
  afterEach(() => {
    wrappers.splice(0).forEach(wrapper => wrapper.unmount())
    vi.restoreAllMocks()
    document.documentElement.classList.remove('dark')
    setSkin('original')
  })

  it('covers more than twelve groups/endpoints and keeps the legends aligned after metric/source changes', async () => {
    const groups = Array.from({ length: 14 }, (_, index) => ({ group_id: index + 1, group_name: `g${index}`, ...usage(index) }))
    const group = render(GroupDistributionChart, { groupStats: groups, enableBreakdown: false })
    const fills = dataset(group).backgroundColor
    expect(fills).toHaveLength(14)
    expect(fills.every((fill: unknown) => typeof fill === 'object')).toBe(true)
    expect(fills[12]).toBe(fills[0])
    expect(group.findAll('.skin-chart-swatch')).toHaveLength(14)
    await group.setProps({ metric: 'actual_cost' })
    expect(dataset(group).data).toEqual(groups.map(g => g.actual_cost))
    const endpoints = groups.map(g => ({ endpoint: g.group_name, ...g }))
    const endpoint = render(EndpointDistributionChart, { endpointStats: endpoints, upstreamEndpointStats: endpoints.slice(0, 2), enableBreakdown: false })
    expect(dataset(endpoint).backgroundColor[0]).toBe(fills[0])
    await endpoint.setProps({ source: 'upstream', metric: 'actual_cost' })
    expect(dataset(endpoint).data).toEqual([30, 29])
    expect(endpoint.findAll('.skin-chart-swatch')).toHaveLength(2)
    setSkin('original')
    await endpoint.vm.$nextTick()
    expect(dataset(endpoint).backgroundColor).toEqual(['#3b82f6', '#10b981'])
    expect(endpoint.find('.skin-chart-swatch').exists()).toBe(false)
  })

  it('covers the user dashboard and latency histogram without changing values', () => {
    const models = [{ model: 'm1', ...usage(1) }, { model: 'm2', ...usage(2) }]
    const user = render(UserDashboardCharts, { models, trend: [], loading: false, startDate: '', endDate: '', granularity: 'day' })
    expect(dataset(user).data).toEqual([101, 102])
    expect(dataset(user).backgroundColor.every((fill: unknown) => typeof fill === 'object')).toBe(true)
    expect(user.findAll('.skin-chart-swatch')).toHaveLength(2)
    const latency = render(OpsLatencyChart, { loading: false, latencyData: { total_requests: 6, buckets: [{ range: '0-1s', count: 6 }] } })
    expect(dataset(latency, 'Bar').data).toEqual([6])
    expect(typeof dataset(latency, 'Bar').backgroundColor).toBe('object')
  })

  it('keeps error-category pattern identities stable when other categories disappear', async () => {
    const items = [502, 400, 500].map(status_code => ({ status_code, total: 4, sla: 2, business_limited: 2 }))
    const wrapper = render(OpsErrorDistributionChart, { loading: false, data: { total: 12, items } })
    const client = dataset(wrapper).backgroundColor[1]
    expect(dataset(wrapper).data).toEqual([2, 2, 2])
    const swatch = wrapper.findAll('.skin-chart-swatch')[1].attributes('style')
    await wrapper.setProps({ data: { total: 4, items: [items[1]] } })
    expect(dataset(wrapper).backgroundColor[0]).toBe(client)
    expect(wrapper.find('.skin-chart-swatch').attributes('style')).toBe(swatch)
  })

  it('preserves per-currency payment bar proportions with matching hatches', async () => {
    const wrapper = render(PaymentMethodChart, { methods: [
      { type: 'alipay', count: 2, amount: { USD: 100, CNY: 40 } },
      { type: 'stripe', count: 1, amount: { USD: 25, CNY: 20 } }
    ] })
    const bars = wrapper.findAll('.skin-chart-bar')
    expect(bars.map(bar => (bar.element as HTMLElement).style.width)).toEqual(['100%', '100%', '50%', '25%'])
    expect(bars[0].attributes('style')).toContain('repeating-linear-gradient')
    expect(wrapper.findAll('.skin-chart-swatch')[1].attributes('style')).toContain('repeating-linear-gradient')
    setSkin('original')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.skin-chart-bar').exists()).toBe(false)
    expect(wrapper.find('.bg-purple-500').exists()).toBe(true)
  })

  it('keeps operational and revenue trend axes/data while removing solid areas, then restores originals', async () => {
    const point = { bucket_start: '2026-10-01T00:00:00Z', request_count: 10, token_consumed: 100, qps: 2, tps: 1000, switch_count: 2,
      error_count_total: 3, error_count_sla: 1, business_limited_count: 1, upstream_error_count_excl_429_529: 1 }
    const charts = [OpsThroughputTrendChart, OpsErrorTrendChart, OpsSwitchRateTrendChart]
      .map(component => render(component, { points: [point], loading: false, timeRange: '24h' }))
    charts.push(render(DailyRevenueChart, { data: [{ date: '2026-10-01', count: 3, amount: { USD: 4 } }] }))
    const before = charts.map(wrapper => wrapper.findComponent({ name: 'Line' }).props('data').datasets)
    expect(before[0].map((series: any) => series.data)).toEqual([[2], [1]])
    expect(before[2][0].data).toEqual([.2])
    for (const series of before.flat()) {
      expect(series.fill).toBe(false)
      expect(series.borderColor).toMatch(/^#(?:181818|4a4a4a)$/)
    }
    expect(before[0][1].borderDash).toEqual([7, 4])
    expect(before[0][1].yAxisID).toBe('y1')
    setSkin('original')
    await charts[0].vm.$nextTick()
    charts.forEach(wrapper => expect(dataset(wrapper, 'Line').fill).toBe(true))
    setSkin('neubrutalism')
    await charts[0].vm.$nextTick()
    charts.forEach(wrapper => expect(dataset(wrapper, 'Line').fill).toBe(false))
  })
})
