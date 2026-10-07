<script setup lang="ts">
// Preview-only synthetic fixtures. This entry is never imported by the product.
import { computed, ref } from 'vue'
import { applySiteAppearance, useSkin } from '../src/composables/useSkin'
import ModelDistributionChart from '../src/components/charts/ModelDistributionChart.vue'
import GroupDistributionChart from '../src/components/charts/GroupDistributionChart.vue'
import EndpointDistributionChart from '../src/components/charts/EndpointDistributionChart.vue'
import UserDashboardCharts from '../src/components/user/dashboard/UserDashboardCharts.vue'
import OpsErrorDistributionChart from '../src/views/admin/ops/components/OpsErrorDistributionChart.vue'
import OpsLatencyChart from '../src/views/admin/ops/components/OpsLatencyChart.vue'
import OpsErrorTrendChart from '../src/views/admin/ops/components/OpsErrorTrendChart.vue'
import OpsThroughputTrendChart from '../src/views/admin/ops/components/OpsThroughputTrendChart.vue'
import OpsSwitchRateTrendChart from '../src/views/admin/ops/components/OpsSwitchRateTrendChart.vue'
import MonitorTrendChart from '../src/features/channel-monitor-v2/MonitorTrendChart.vue'
import PaymentMethodChart from '../src/components/admin/payment/PaymentMethodChart.vue'
import DailyRevenueChart from '../src/components/admin/payment/DailyRevenueChart.vue'
import AccountStatsModal from '../src/components/admin/account/AccountStatsModal.vue'
import UsageProgressBar from '../src/components/account/UsageProgressBar.vue'

const section = ref('分布图')
const state = ref('数据')
const dense = ref(false)
const metric = ref<'tokens' | 'actual_cost'>('tokens')
const source = ref<'inbound' | 'upstream' | 'path'>('inbound')
const showAccount = ref(false)
const events = ref('')
const loading = computed(() => state.value === '加载中')
const usage = (factor: number) => ({ requests: factor * 100, total_tokens: factor * 24000,
  input_tokens: factor * 12000, output_tokens: factor * 8000, cache_creation_tokens: factor * 1000,
  cache_read_tokens: factor * 3000, cost: factor * 1.4, actual_cost: factor * .9, account_cost: factor * .4 })
const models = computed(() => state.value === '数据' ? Array.from({ length: dense.value ? 14 : 4 }, (_, index) => ({
  model: ['claude-sonnet-4-6', 'gpt-6-astra', 'gemini-3-pro', 'deepseek-v3'][index % 4] + (index > 3 ? `-${index}` : ''),
  ...usage(16 - index)
})) : [])
const groups = computed(() => models.value.map((_, index) => ({ group_id: index + 1,
  group_name: `Group ${index + 1}`, ...usage(index + 1) })))
const endpoints = computed(() => models.value.map((_, index) => ({
  endpoint: ['/v1/responses', '/v1/messages', '/v1/chat/completions', '/v1/images/generations'][index % 4] + (index > 3 ? `/${index}` : ''), ...usage(index + 1)
})))
const trend = computed(() => state.value === '数据' ? Array.from({ length: 8 }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, ...usage([2, 4, 3, 5, 6, 4, 7, 5][index])
})) : [])
const throughput = computed(() => trend.value.map((point, index) => ({ bucket_start: `${point.date}T00:00:00Z`,
  request_count: point.requests, token_consumed: point.total_tokens, qps: point.requests / 100,
  tps: point.total_tokens / 60, switch_count: index * 2 })))
const errors = computed(() => throughput.value.map((point, index) => ({ bucket_start: point.bucket_start,
  error_count_total: index * 2 + 1, error_count_sla: index + 1, business_limited_count: index % 2,
  upstream_error_count_excl_429_529: index % 3 + 1, upstream_429_count: 0, upstream_529_count: 0 })))
const distribution = computed(() => state.value === '数据' ? { total: 16, items: [
  { status_code: 502, total: 6, sla: 6, business_limited: 0 },
  { status_code: 400, total: 4, sla: 4, business_limited: 0 },
  { status_code: 500, total: 3, sla: 3, business_limited: 0 },
  { status_code: 0, total: 3, sla: 3, business_limited: 0 }
] } : null)
const latency = computed(() => state.value === '数据' ? { start_time: '', end_time: '', platform: 'openai', total_requests: 100,
  buckets: [12, 32, 27, 18, 11].map((count, index) => ({ range: `${index}-${index + 1}s`, count })) } : null)
const monitor = computed(() => throughput.value.map((point, index) => ({ bucket_start: point.bucket_start,
  metrics: { error_rate: index * .01, cache_rate: .6 - index * .03, ttft: { p50_ms: 200 + index * 40 } }, health: {} })))
const methods = computed(() => state.value === '数据' ? ['alipay', 'wxpay', 'stripe'].map((type, index) => ({
  type, count: 8 - index, amount: { USD: 100 - index * 30, CNY: 500 - index * 100 }
})) : [])
const revenue = computed(() => trend.value.map(point => ({ date: point.date, count: point.requests, amount: { USD: point.cost * 10, CNY: point.cost * 40 } })))
const account = { id: 1, name: 'Synthetic account', platform: 'openai', type: 'apikey' }
function toggleDark() {
  const { appearance } = useSkin()
  applySiteAppearance({ ...appearance.value, mode: appearance.value.mode === 'dark' ? 'light' : 'dark' })
}
</script>

<template>
  <main class="mx-auto max-w-6xl space-y-6 p-4">
    <header class="flex flex-wrap items-center gap-3">
      <h1 class="mr-auto text-2xl font-bold">图表样式预览</h1>
      <button class="btn btn-secondary" @click="applySiteAppearance({ ...useSkin().appearance.value, skin: useSkin().skin.value === 'original' ? 'neubrutalism' : 'original' })">切换外观</button>
      <button class="btn btn-secondary" @click="toggleDark">切换明暗</button>
    </header>
    <nav class="flex flex-wrap gap-2">
      <button v-for="item in ['分布图', '用户', '运维', '支付', '账号']" :key="item" class="btn btn-secondary" :aria-pressed="section === item" @click="section = item">{{ item }}</button>
      <select v-model="state" aria-label="数据状态" class="input w-auto"><option>数据</option><option>空数据</option><option>加载中</option></select>
      <label class="flex items-center gap-2"><input v-model="dense" type="checkbox" />14 个分组</label>
    </nav>
    <div v-if="section === '分布图'" class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <ModelDistributionChart :model-stats="models" :loading="loading" :enable-breakdown="false" />
      <GroupDistributionChart v-model:metric="metric" :group-stats="groups" :loading="loading" :show-metric-toggle="true" />
      <EndpointDistributionChart v-model:metric="metric" v-model:source="source" :endpoint-stats="endpoints" :upstream-endpoint-stats="endpoints.slice().reverse()" :endpoint-path-stats="endpoints.slice(0, 2)" :show-source-toggle="true" :show-metric-toggle="true" :loading="loading" />
    </div>
    <UserDashboardCharts v-if="section === '用户'" :models="models" :trend="trend" :loading="loading" start-date="2026-10-01" end-date="2026-10-08" granularity="day" @refresh="events = '已刷新'" />
    <div v-if="section === '运维'" class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="h-96"><OpsErrorDistributionChart :data="distribution" :loading="loading" @open-details="events = '错误详情'" /></div>
      <div class="h-96"><OpsLatencyChart :latency-data="latency" :loading="loading" /></div>
      <div class="h-96"><OpsErrorTrendChart :points="errors" :loading="loading" time-range="24h" @open-request-errors="events = '请求错误'" @open-upstream-errors="events = '上游错误'" /></div>
      <div class="h-96"><OpsThroughputTrendChart :points="throughput" :loading="loading" time-range="24h" @open-details="events = '吞吐详情'" /></div>
      <div class="h-96"><OpsSwitchRateTrendChart :points="throughput" :loading="loading" time-range="24h" /></div>
      <MonitorTrendChart :trend="monitor as any" :coverage="null" :loading="loading" />
    </div>
    <div v-if="section === '支付'" class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <PaymentMethodChart :methods="methods" /><DailyRevenueChart :data="revenue" :loading="loading" />
    </div>
    <div v-if="section === '账号'"><button class="btn btn-primary" @click="showAccount = true">打开账号统计</button>
      <div class="card mt-4 space-y-3 p-4">
        <h2 class="font-bold">用量与剩余容量</h2>
        <UsageProgressBar v-for="value in [0, 45, 100, 120]" :key="value" label="5h" :utilization="value" color="indigo" />
        <UsageProgressBar label="Req" :utilization="15" color="emerald" :remaining-capacity="true" />
      </div>
      <AccountStatsModal :show="showAccount" :account="account as any" @close="showAccount = false" />
    </div>
    <p role="status">{{ events }}</p>
  </main>
</template>
