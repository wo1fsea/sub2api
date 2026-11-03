<template>
  <div class="space-y-1 text-[10px] text-gray-500 dark:text-gray-400" data-testid="factory-usage-cell">
    <div v-for="tier in tiers" :key="tier" class="space-y-1">
      <p class="font-medium text-gray-700 dark:text-gray-300">{{ tier === 'standard' ? 'Standard' : 'Core' }}</p>
      <template v-for="window in windowsFor(tier)" :key="window.key">
        <UsageProgressBar
          v-if="window.utilization !== null"
          :label="t(`admin.accounts.factory.usage.${window.period}`)"
          :utilization="window.utilization"
          :title="`${window.utilization}%`"
          :resets-at="window.resets_at"
          label-width="auto"
          :color="tier === 'standard' ? 'indigo' : 'emerald'"
          :data-testid="window.key"
        />
        <p v-else :data-testid="window.key">
          {{ t(`admin.accounts.factory.usage.${window.period}`) }} · {{ t('admin.accounts.factory.usage.unknown') }}
        </p>
        <p v-if="window.utilization !== null && !window.resets_at" class="text-[9px]">{{ t('admin.accounts.factory.usage.resetUnknown') }}</p>
      </template>
    </div>
    <p v-if="stale" role="status" data-testid="factory-stale">{{ t('admin.accounts.factory.usage.stale') }}</p>
    <p v-if="failed" role="status" data-testid="factory-error">{{ t('admin.accounts.factory.usage.failed') }}</p>
    <p v-if="state?.has_active_subscription != null">{{ t('admin.accounts.factory.usage.subscription') }}: {{ t(state.has_active_subscription ? 'admin.accounts.factory.usage.active' : 'admin.accounts.factory.usage.inactive') }}</p>
    <p>{{ t('admin.accounts.factory.usage.overage') }}: {{ state?.overage_mode === 'droidCore' ? 'Droid Core' : t('admin.accounts.factory.usage.unknown') }}</p>
    <p v-if="state?.extra_usage_allowed != null">
      {{ t('admin.accounts.factory.usage.extraUsage') }}: {{ t(state.extra_usage_allowed ? 'common.enabled' : 'common.disabled') }}
    </p>
    <p v-if="balance !== null" data-testid="factory-extra-balance">{{ t('admin.accounts.factory.usage.balance', { balance }) }}</p>
    <p v-if="usage?.updated_at" :title="usage.updated_at" data-testid="factory-updated">
      {{ t('admin.accounts.factory.usage.updated') }}: {{ formatDateTime(usage.updated_at) }}
    </p>
    <p>{{ t('admin.accounts.factory.usage.percentOnly') }}</p>
    <button
      type="button"
      class="rounded px-1.5 py-0.5 font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
      :disabled="loading || cooldownSeconds > 0"
      data-testid="factory-refresh"
      @click="emit('refresh', true)"
    >
      {{ loading ? t('admin.accounts.factory.usage.refreshing') : cooldownSeconds > 0 ? t('admin.accounts.factory.usage.retryIn', { seconds: cooldownSeconds }) : t('admin.accounts.factory.usage.refresh') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import type { AccountUsageInfo } from '@/types'
import { formatDateTime } from '@/utils/format'
import UsageProgressBar from './UsageProgressBar.vue'

const props = defineProps<{ usage: AccountUsageInfo | null; loading?: boolean; error?: string | null }>()
const emit = defineEmits<{ refresh: [force: boolean] }>()
const { t } = useI18n()
const tiers = ['standard', 'core'] as const
const periods = ['five_hour', 'weekly', 'monthly'] as const
const now = ref(Date.now())
const receivedAt = ref(now.value)
const state = computed(() => props.usage?.factory_usage)
watch(() => props.usage, () => { receivedAt.value = Date.now() })
const cooldownSeconds = computed(() => {
  const lastAttempt = Date.parse(state.value?.last_attempt_at || '')
  const deadline = Math.max(
    Number.isFinite(lastAttempt) ? lastAttempt + 30_000 : 0,
    state.value?.retry_after_seconds ? receivedAt.value + Math.max(0, state.value.retry_after_seconds) * 1000 : 0
  )
  return Math.max(0, Math.ceil((deadline - now.value) / 1000))
})
const failed = computed(() => !!(props.error || props.usage?.quota_snapshot_error || state.value?.error_code))
const stale = computed(() => {
  if (!props.usage?.quota_windows?.some(window => window.utilization != null)) return false
  return state.value?.stale || failed.value || props.usage.quota_windows.some(window => {
    const sample = Date.parse(window.sampled_at || '')
    const reset = Date.parse(window.resets_at || '')
    return !Number.isFinite(sample) || now.value - sample >= 300_000 || sample > now.value + 60_000 || reset <= now.value
  })
})
const balance = computed(() => {
  const cents = state.value?.extra_usage_balance_cents
  return typeof cents === 'number' && Number.isFinite(cents) ? (cents / 100).toFixed(2) : null
})
function windowsFor(tier: typeof tiers[number]) {
  return periods.map(period => {
    const key = `factory_${tier}_${period}`
    const window = props.usage?.quota_windows?.find(item => item.key === key)
    const used = window?.utilization
    return { key, period, utilization: typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null, resets_at: window?.resets_at }
  })
}
useIntervalFn(() => { now.value = Date.now() }, 1000)
const { pause: pauseRefresh, resume: resumeRefresh } = useIntervalFn(() => {
  if (!document.hidden && !props.loading) emit('refresh', false)
}, 300_000)
// Start the next interval after receiving a snapshot, so a slow first response
// cannot make the five-minute tick hit the still-valid browser cache.
watch(() => props.usage, () => { pauseRefresh(); resumeRefresh() })
</script>
