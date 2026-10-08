<template>
  <AppLayout>
    <section class="quota-overview" :aria-label="t('admin.quotaOverview.title')">
      <div class="qo-title-row">
        <div>
          <p class="qo-eyebrow qo-mono">{{ t('admin.quotaOverview.eyebrow') }}</p>
          <h1>{{ t('admin.quotaOverview.title') }}</h1>
          <p class="qo-subtitle">{{ t('admin.quotaOverview.description') }}</p>
        </div>
        <div class="qo-refresh-group">
          <button type="button" class="qo-button qo-refresh" :disabled="refreshing" @click="refresh()">
            <Icon name="refresh" size="sm" :class="{ 'animate-spin': refreshing }" aria-hidden="true" />
            {{ t(refreshing ? 'admin.quotaOverview.refreshing' : 'admin.quotaOverview.refresh') }}
          </button>
          <p class="qo-last-fetch">
            {{ t('admin.quotaOverview.lastFetch') }} ·
            <time v-if="lastFetchedAt" :datetime="lastFetchedAt" class="qo-mono">{{ dateLabel(lastFetchedAt) }}</time>
            <span v-else>{{ t('admin.quotaOverview.notChecked') }}</span>
          </p>
        </div>
      </div>

      <div class="qo-summary" aria-live="polite">
        <div class="qo-stat">
          <div class="qo-stat-value qo-mono">{{ loading ? '—' : rows.length }}</div>
          <p>{{ t('admin.quotaOverview.loadedAccounts') }}</p>
        </div>
        <div class="qo-stat">
          <div class="qo-stat-value qo-mono" :class="{ 'qo-accent': priorityCount > 0 }">{{ loading ? '—' : priorityCount }}</div>
          <p>{{ t('admin.quotaOverview.priorityAccounts') }} <span>· {{ t('admin.quotaOverview.priorityThreshold', { percent: QUOTA_PRIORITY_THRESHOLD }) }}</span></p>
        </div>
        <div class="qo-stat">
          <div class="qo-stat-value qo-mono">{{ loading ? '—' : needsRefreshCount }}</div>
          <p>{{ t('admin.quotaOverview.needsRefreshAccounts') }}</p>
        </div>
      </div>

      <div v-if="listFailed || failedCount > 0 || truncated" class="qo-notices" role="status">
        <p v-if="listFailed" class="qo-notice"><Icon name="exclamationCircle" size="sm" aria-hidden="true" />{{ t('admin.quotaOverview.listFailed') }}</p>
        <p v-if="failedCount > 0" class="qo-notice"><Icon name="clock" size="sm" aria-hidden="true" />{{ t('admin.quotaOverview.refreshFailed', { count: failedCount }) }}</p>
        <p v-if="truncated" class="qo-notice"><Icon name="infoCircle" size="sm" aria-hidden="true" />{{ t('admin.quotaOverview.truncated', { count: QUOTA_ACCOUNT_MAX_PAGES * QUOTA_ACCOUNT_PAGE_SIZE }) }}</p>
      </div>

      <div class="qo-toolbar">
        <div class="qo-filters" role="group" :aria-label="t('admin.quotaOverview.filters.label')">
          <button v-for="option in filterOptions" :key="option.value" type="button" class="qo-filter" :aria-pressed="filter === option.value" @click="filter = option.value">
            {{ t(option.label) }}<span class="qo-mono">{{ loading ? '—' : option.count }}</span>
          </button>
        </div>
        <label class="qo-sort">
          <span>{{ t('admin.quotaOverview.sort.label') }}</span>
          <select v-model="sort">
            <option value="remaining">{{ t('admin.quotaOverview.sort.remaining') }}</option>
            <option value="reset">{{ t('admin.quotaOverview.sort.reset') }}</option>
          </select>
        </label>
      </div>

      <div v-if="loading" class="qo-empty" role="status" aria-live="polite">
        <LoadingSpinner />
        <p>{{ t('admin.quotaOverview.loading') }}</p>
        <p v-if="totalUsageCount > 0" class="qo-secondary qo-mono">{{ t('admin.quotaOverview.loadingProgress', { done: loadedUsageCount, total: totalUsageCount }) }}</p>
      </div>
      <div v-else-if="rows.length === 0" class="qo-empty">
        <Icon :name="listFailed ? 'exclamationCircle' : 'gauge'" size="xl" aria-hidden="true" />
        <h2>{{ t(listFailed ? 'admin.quotaOverview.listFailedTitle' : 'admin.quotaOverview.empty') }}</h2>
        <p v-if="!listFailed" class="qo-secondary">{{ t('admin.quotaOverview.emptyDescription') }}</p>
        <button v-if="listFailed" type="button" class="qo-button" :disabled="refreshing" @click="refresh()">{{ t('admin.quotaOverview.retry') }}</button>
        <RouterLink v-else class="qo-button" to="/admin/accounts">{{ t('admin.quotaOverview.manageAccounts') }}</RouterLink>
      </div>
      <div v-else-if="visibleRows.length === 0" class="qo-empty">
        <Icon name="filter" size="xl" aria-hidden="true" />
        <h2>{{ t('admin.quotaOverview.noMatches') }}</h2>
        <p class="qo-secondary">{{ t('admin.quotaOverview.noMatchesDescription') }}</p>
        <button type="button" class="qo-button" @click="filter = 'all'">{{ t('admin.quotaOverview.viewAll') }}</button>
      </div>
      <div v-else class="qo-board" :aria-busy="refreshing">
        <article v-for="row in visibleRows" :key="row.account.id" class="qo-account" :class="{ 'qo-priority': isPriority(row), 'qo-stale': row.state !== 'fresh' }" :data-account-id="row.account.id" :data-quota-state="row.state">
          <header class="qo-account-header">
            <div class="qo-account-name">
              <h2>{{ row.account.name }}</h2>
              <p class="qo-provider">
                {{ providerLabel(row.account.platform) }} · {{ row.account.type === 'setup-token' ? 'Setup Token' : 'OAuth' }}
                <span v-if="row.account.status !== 'active'"> · {{ t(`admin.quotaOverview.accountStatus.${row.account.status}`) }}</span>
              </p>
            </div>
            <span class="qo-status"><Icon :name="row.state === 'fresh' ? 'gauge' : 'clock'" size="xs" aria-hidden="true" />{{ stateLabel(row) }}</span>
          </header>

          <div class="qo-main-reading">
            <div>
              <p class="qo-quota-caption">{{ remainingCaption(row) }}</p>
              <p v-if="row.remainingPercent !== null" class="qo-quota-value qo-mono" data-test="remaining-value">{{ percent(row.remainingPercent) }}<span>%</span></p>
              <p v-else class="qo-unknown-value">{{ t('admin.quotaOverview.unknown') }}</p>
            </div>
            <div class="qo-bottleneck">
              <template v-if="row.bottleneck">
                <p>{{ windowLabel(row.bottleneck) }}</p>
                <p class="qo-secondary">{{ scopeLabel(row.bottleneck) }}</p>
              </template>
              <p v-else class="qo-secondary">{{ t(row.state === 'estimated' ? 'admin.quotaOverview.estimatedOnly' : 'admin.quotaOverview.noReading') }}</p>
            </div>
          </div>

          <div v-if="row.windows.length > 0" class="qo-windows">
            <div v-for="quotaWindow in row.windows" :key="quotaWindow.key" class="qo-window">
              <span class="qo-window-label">{{ windowLabel(quotaWindow) }}</span>
              <div class="qo-track" :class="{ 'qo-track-unknown': quotaWindow.remainingPercent === null, 'qo-track-estimated': quotaWindow.estimated }" role="img" :aria-label="barLabel(quotaWindow)">
                <div v-if="quotaWindow.utilization !== null" class="qo-used" :style="{ width: usedWidth(quotaWindow) }"></div>
              </div>
              <span class="qo-window-value qo-mono" :title="quotaWindow.estimated ? t('admin.quotaOverview.estimateNote') : undefined">{{ windowPercent(quotaWindow) }}</span>
            </div>
          </div>
          <p v-if="row.incomplete && row.bottleneck" class="qo-partial">{{ t('admin.quotaOverview.partialReading') }}</p>

          <footer class="qo-account-footer">
            <p><span>{{ t('admin.quotaOverview.thisWindowReset') }}</span><strong class="qo-mono">{{ resetLabel(row.bottleneck?.resetsAt) }}</strong></p>
            <p class="qo-source"><span>{{ sourceLabel(row.bottleneck?.source ?? row.source) }}</span><strong class="qo-mono">{{ dateLabel(row.bottleneck?.sampledAt ?? null) }}</strong></p>
          </footer>
          <button type="button" class="qo-card-open" :aria-label="t('admin.quotaOverview.viewDetails', { name: row.account.name })" @click="selectedAccountId = row.account.id">
            <Icon name="chevronRight" size="sm" aria-hidden="true" />
          </button>
        </article>
      </div>

      <div v-if="!loading && rows.length > 0" class="qo-legend">
        <span><i class="qo-swatch qo-swatch-used" aria-hidden="true"></i>{{ t('admin.quotaOverview.legend.used') }}</span>
        <span><i class="qo-swatch" aria-hidden="true"></i>{{ t('admin.quotaOverview.legend.remaining') }}</span>
        <span><i class="qo-swatch qo-swatch-accent" aria-hidden="true"></i>{{ t('admin.quotaOverview.legend.attention') }}</span>
      </div>
      <footer class="qo-page-footer">
        <p>{{ t('admin.quotaOverview.noPooling') }}</p>
        <p>{{ t('admin.quotaOverview.noForecast') }}</p>
      </footer>
    </section>

    <BaseDialog :show="selectedRow !== null" :title="selectedRow?.account.name || t('admin.quotaOverview.title')" width="normal" :close-on-click-outside="true" @close="selectedAccountId = null">
      <div v-if="selectedRow" class="quota-overview-details">
        <div class="qo-detail-summary">
          <p class="qo-provider">{{ providerLabel(selectedRow.account.platform) }} · {{ stateLabel(selectedRow) }}</p>
          <p class="qo-quota-caption">{{ remainingCaption(selectedRow) }}</p>
          <p v-if="selectedRow.remainingPercent !== null" class="qo-quota-value qo-mono" :class="{ 'qo-accent': isPriority(selectedRow) }">{{ percent(selectedRow.remainingPercent) }}<span>%</span></p>
          <p v-else class="qo-unknown-value">{{ t('admin.quotaOverview.unknown') }}</p>
        </div>
        <p v-if="selectedRow.error" class="qo-detail-note">{{ t('admin.quotaOverview.readFailed') }} {{ selectedRow.bottleneck ? t('admin.quotaOverview.lastSuccessfulReading') : '' }}</p>
        <p v-if="selectedRow.state === 'stale'" class="qo-detail-note">{{ t('admin.quotaOverview.staleReading') }}</p>
        <p v-if="selectedRow.incomplete && selectedRow.bottleneck" class="qo-detail-note">{{ t('admin.quotaOverview.partialReading') }}</p>
        <p v-if="selectedRow.windows.length === 0" class="qo-detail-note">{{ t('admin.quotaOverview.noWindows') }}</p>

        <section v-for="quotaWindow in selectedRow.windows" :key="quotaWindow.key" class="qo-detail-window">
          <header class="qo-detail-window-header">
            <h3>{{ windowLabel(quotaWindow) }}</h3>
            <strong class="qo-mono" :class="{ 'qo-accent': isPriority(selectedRow) && quotaWindow.key === selectedRow.bottleneck?.key }">{{ windowPercent(quotaWindow) }} <span v-if="quotaWindow.remainingPercent !== null">{{ t('admin.quotaOverview.remaining') }}</span></strong>
          </header>
          <div class="qo-track" :class="{ 'qo-track-unknown': quotaWindow.remainingPercent === null, 'qo-track-estimated': quotaWindow.estimated }" role="img" :aria-label="barLabel(quotaWindow)">
            <div v-if="quotaWindow.utilization !== null" class="qo-used" :style="{ width: usedWidth(quotaWindow) }"></div>
          </div>
          <dl class="qo-detail-meta">
            <div><dt>{{ t('admin.quotaOverview.scope') }}</dt><dd>{{ scopeLabel(quotaWindow) }}</dd></div>
            <div><dt>{{ t('admin.quotaOverview.thisWindowReset') }}</dt><dd class="qo-mono">{{ resetLabel(quotaWindow.resetsAt) }}</dd></div>
            <div><dt>{{ t('admin.quotaOverview.source') }}</dt><dd>{{ sourceLabel(quotaWindow.source) }}</dd></div>
            <div><dt>{{ t('admin.quotaOverview.sampledAt') }}</dt><dd class="qo-mono">{{ dateLabel(quotaWindow.sampledAt) }}</dd></div>
          </dl>
          <p v-if="quotaWindow.estimated" class="qo-detail-note">{{ t('admin.quotaOverview.estimateNote') }}</p>
          <p v-else-if="quotaWindow.stale && quotaWindow.remainingPercent !== null" class="qo-detail-note">{{ t('admin.quotaOverview.states.stale') }}</p>
        </section>
        <p v-if="selectedRow.windows.some(quotaWindow => quotaWindow.scope === 'model')" class="qo-detail-note">{{ t('admin.quotaOverview.modelScopeNote') }}</p>
        <p class="qo-detail-note">{{ t('admin.quotaOverview.noForecast') }}</p>
      </div>
      <template #footer>
        <button type="button" class="qo-button qo-dialog-refresh" :disabled="refreshing" @click="refresh()"><Icon name="refresh" size="sm" aria-hidden="true" />{{ t(refreshing ? 'admin.quotaOverview.refreshing' : 'admin.quotaOverview.refresh') }}</button>
      </template>
    </BaseDialog>
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import BaseDialog from '@/components/common/BaseDialog.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Icon from '@/components/icons/Icon.vue'
import { useQuotaOverview, QUOTA_ACCOUNT_MAX_PAGES, QUOTA_ACCOUNT_PAGE_SIZE } from '@/composables/useQuotaOverview'
import { formatDateTime } from '@/utils/format'
import {
  QUOTA_PRIORITY_THRESHOLD,
  sortQuotaAccounts,
  type QuotaOverviewAccount,
  type QuotaOverviewSort,
  type QuotaOverviewWindow
} from '@/utils/quotaOverview'

const { t } = useI18n()
const { rows, now, loading, refreshing, listFailed, truncated, failedCount, lastFetchedAt, loadedUsageCount, totalUsageCount, refresh } = useQuotaOverview()
type QuotaFilter = 'all' | 'priority' | 'needsRefresh'
const filter = ref<QuotaFilter>('all')
const sort = ref<QuotaOverviewSort>('remaining')
const selectedAccountId = ref<number | null>(null)

function isPriority(row: QuotaOverviewAccount): boolean {
  return row.state === 'fresh' && row.remainingPercent !== null && row.remainingPercent <= QUOTA_PRIORITY_THRESHOLD
}
function needsRefresh(row: QuotaOverviewAccount): boolean {
  return row.state !== 'fresh' || row.incomplete
}
const priorityCount = computed(() => rows.value.filter(isPriority).length)
const needsRefreshCount = computed(() => rows.value.filter(needsRefresh).length)
const filterOptions = computed(() => [
  { value: 'all' as const, label: 'admin.quotaOverview.filters.all', count: rows.value.length },
  { value: 'priority' as const, label: 'admin.quotaOverview.filters.priority', count: priorityCount.value },
  { value: 'needsRefresh' as const, label: 'admin.quotaOverview.filters.needsRefresh', count: needsRefreshCount.value }
])
const visibleRows = computed(() => sortQuotaAccounts(rows.value.filter(row => (
  filter.value === 'priority' ? isPriority(row) : filter.value === 'needsRefresh' ? needsRefresh(row) : true
)), sort.value, now.value))
const selectedRow = computed(() => rows.value.find(row => row.account.id === selectedAccountId.value) ?? null)

function percent(value: number): string {
  return Number(value.toFixed(1)).toString()
}
function windowLabel(quotaWindow: QuotaOverviewWindow): string {
  return quotaWindow.labelParams ? t(quotaWindow.labelKey, quotaWindow.labelParams) : t(quotaWindow.labelKey)
}
function windowPercent(quotaWindow: QuotaOverviewWindow): string {
  if (quotaWindow.remainingPercent === null) return t('admin.quotaOverview.unknown')
  return `${quotaWindow.estimated ? '≈ ' : ''}${percent(quotaWindow.remainingPercent)}%`
}
function usedWidth(quotaWindow: QuotaOverviewWindow): string {
  return `${Math.min(100, Math.max(0, quotaWindow.utilization ?? 0))}%`
}
function barLabel(quotaWindow: QuotaOverviewWindow): string {
  if (quotaWindow.remainingPercent === null) return t('admin.quotaOverview.windowUnknown', { window: windowLabel(quotaWindow) })
  const label = t('admin.quotaOverview.windowUsage', { window: windowLabel(quotaWindow), used: percent(quotaWindow.utilization!), remaining: percent(quotaWindow.remainingPercent) })
  return quotaWindow.estimated ? `${label} · ${t('admin.quotaOverview.states.estimated')}` : label
}
function remainingCaption(row: QuotaOverviewAccount): string {
  if (row.state === 'stale') return t('admin.quotaOverview.previousRemaining')
  return t(row.incomplete ? 'admin.quotaOverview.knownRemaining' : 'admin.quotaOverview.tightestRemaining')
}
function scopeLabel(quotaWindow: QuotaOverviewWindow): string {
  return quotaWindow.scope === 'model'
    ? t('admin.quotaOverview.modelOnly', { model: quotaWindow.model || t('admin.quotaOverview.unknown') })
    : t('admin.quotaOverview.allModels')
}
function dateLabel(value: string | null | undefined): string {
  return formatDateTime(value, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) || t('admin.quotaOverview.sampledUnknown')
}
function resetLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t('admin.quotaOverview.resetUnknown')
  if (Date.parse(value) <= now.value) return t('admin.quotaOverview.resetPassed')
  return dateLabel(value)
}
function sourceLabel(source: string | null): string {
  return t(`admin.quotaOverview.sources.${source && ['upstream', 'response_headers', 'estimated', 'local'].includes(source) ? source : 'unknown'}`)
}
function stateLabel(row: QuotaOverviewAccount): string {
  if (isPriority(row)) return t('admin.quotaOverview.states.priority')
  if (row.state === 'fresh' && row.incomplete) return t('admin.quotaOverview.states.partial')
  return t(`admin.quotaOverview.states.${row.state}`)
}
function providerLabel(platform: string): string {
  const labels: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', antigravity: 'Antigravity', grok: 'Grok', kimi: 'Kimi', zhipu: 'Zhipu', deepseek: 'DeepSeek', minimax: 'MiniMax', opencode_go: 'OpenCode Go', typesafe: 'TypeSafe' }
  return labels[platform] || platform
}

onMounted(() => { void refresh(false) })
</script>

<style scoped>
.quota-overview,
.quota-overview-details {
  --qo-bg: var(--skin-bg, #f7f6f0);
  --qo-surface: var(--skin-surface, #f7f6f0);
  --qo-ink: var(--skin-ink, #171715);
  --qo-secondary: var(--skin-muted, #4a4a4a);
  --qo-line: var(--skin-line-soft, #dcdcdc);
  --qo-strong-line: var(--skin-line, #171715);
  --qo-track: var(--skin-neutral, #e8e8e8);
  --qo-accent: var(--site-accent-color, #d4ff3f);
  color: var(--qo-ink);
  font-size: 14px;
  line-height: 1.5;
}
.quota-overview :is(h1, h2, p), .quota-overview-details :is(h3, p, dl, dd) { margin: 0; }
.qo-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-variant-numeric: tabular-nums; }
.qo-secondary, .qo-provider, .qo-subtitle, .qo-quota-caption, .qo-last-fetch { color: var(--qo-secondary); }
.qo-accent { color: var(--qo-ink); }
.qo-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.qo-eyebrow { color: var(--qo-secondary); font-size: 11px; letter-spacing: 1.6px; margin-bottom: 5px !important; }
.quota-overview h1 { font-size: 34px; font-weight: 800; letter-spacing: -1.2px; line-height: 1.25; }
.qo-subtitle { margin-top: 8px !important; font-size: 13px; max-width: 620px; }
.qo-refresh-group { display: grid; justify-items: end; gap: 9px; padding-top: 22px; flex-shrink: 0; }
.qo-button { border: 1px solid var(--skin-line, #171715); border-radius: 0; background: var(--skin-surface, #f7f6f0); color: var(--skin-ink, #171715); display: inline-flex; justify-content: center; align-items: center; gap: 8px; padding: 8px 12px; min-height: 38px; font-size: 12px; font-weight: 500; text-decoration: none; }
.qo-refresh { box-shadow: 3px 3px 0 var(--qo-line); }
.qo-button:hover:not(:disabled) { background: var(--skin-neutral, #e8e8e8); }
.qo-button:disabled { cursor: wait; opacity: .65; }
.qo-last-fetch { font-size: 11px; }
.qo-summary { display: grid; grid-template-columns: repeat(3, 1fr); border-block: 1px solid var(--qo-line); margin-top: 25px; }
.qo-stat { padding: 14px 20px; border-right: 1px solid var(--qo-line); }
.qo-stat:first-child { padding-left: 0; }
.qo-stat:last-child { border-right: 0; }
.qo-stat-value { font-size: 26px; line-height: 1.2; font-weight: 700; letter-spacing: -.8px; }
.qo-stat > p { margin-top: 6px; font-size: 12px; color: var(--qo-secondary); }
.qo-stat > p > span { white-space: nowrap; }
.qo-notices { display: grid; gap: 8px; border-bottom: 1px solid var(--qo-line); padding: 13px 0; }
.qo-notice { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--qo-secondary); }
.qo-notice svg { flex-shrink: 0; margin-top: 1px; }
.qo-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 20px 0 16px; }
.qo-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.qo-filter { background: transparent; border: 1px solid var(--qo-line); border-radius: 0; padding: 7px 11px; color: var(--qo-ink); font-size: 12px; min-height: 34px; }
.qo-filter span { margin-left: 9px; font-size: 11px; }
.qo-filter[aria-pressed='true'] { background: var(--qo-ink); color: var(--qo-bg); border-color: var(--qo-ink); }
.qo-sort { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--qo-secondary); }
.qo-sort select { border: 1px solid var(--qo-line); border-radius: 0; background: var(--qo-bg); color: var(--qo-ink); min-height: 34px; padding: 6px 8px; font-size: 12px; }
.qo-board { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.qo-account { min-width: 0; border: 1px solid var(--qo-line); padding: 17px 18px; background: var(--qo-surface); position: relative; }
.qo-account.qo-priority { border-top: 2px solid var(--qo-accent); padding-top: 16px; }
.qo-account:hover { background: var(--qo-track); }
.qo-account-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.qo-account-name { min-width: 0; }
.qo-account h2 { font-size: 14px; line-height: 1.5; font-weight: 650; overflow-wrap: anywhere; }
.qo-provider { font-size: 11px; margin-top: 3px !important; }
.qo-status { font-size: 11px; color: var(--qo-secondary); display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.qo-priority .qo-status, .qo-priority .qo-quota-value { color: var(--qo-ink); }
:global(.dark) .qo-accent, :global(.dark) .qo-priority .qo-status, :global(.dark) .qo-priority .qo-quota-value { color: var(--qo-accent); }
.qo-main-reading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; }
.qo-quota-caption { font-size: 11px; }
.qo-quota-value { font-size: 38px; line-height: 1.2; letter-spacing: -1.8px; font-weight: 750; margin-top: 3px !important; }
.qo-quota-value > span { font-size: 17px; letter-spacing: 0; margin-left: 3px; }
.qo-unknown-value { font-size: 26px; line-height: 1.3; font-weight: 650; margin-top: 5px !important; }
.qo-bottleneck { text-align: right; font-size: 13px; font-weight: 600; max-width: 58%; overflow-wrap: anywhere; }
.qo-bottleneck .qo-secondary { font-size: 11px; margin-top: 3px; font-weight: 400; }
.qo-windows { display: grid; gap: 9px; margin-top: 16px; }
.qo-window { display: grid; grid-template-columns: minmax(60px, 105px) minmax(35px, 1fr) 57px; align-items: center; gap: 9px; font-size: 11px; }
.qo-window-label { color: var(--qo-secondary); overflow-wrap: anywhere; }
.qo-window-value { text-align: right; white-space: nowrap; }
.qo-track { height: 8px; background: var(--qo-track); overflow: hidden; }
.qo-used, .qo-swatch-used { height: 100%; background-color: var(--qo-surface); background-image: repeating-linear-gradient(135deg, var(--qo-secondary) 0 .7071px, transparent .7071px 4.2426px); }
.qo-track-unknown { background-color: var(--qo-surface); background-image: repeating-linear-gradient(135deg, var(--qo-line) 0 .7071px, transparent .7071px 6px); }
.qo-track-estimated { outline: 1px dashed var(--qo-line); outline-offset: 2px; }
.qo-partial { font-size: 11px; color: var(--qo-secondary); margin-top: 11px !important; }
.qo-account-footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; border-top: 1px solid var(--qo-line); padding-top: 11px; margin-top: 15px; font-size: 11px; color: var(--qo-secondary); }
.qo-account-footer p { min-width: 0; }
.qo-account-footer strong { display: block; color: var(--qo-ink); font-weight: 400; margin-top: 3px; overflow-wrap: anywhere; }
.qo-source { text-align: right; padding-right: 18px; }
.qo-card-open { position: absolute; inset: 0; width: 100%; border: 0; border-radius: 0; padding: 0; background: transparent; }
.qo-card-open svg { position: absolute; right: 14px; bottom: 15px; color: var(--qo-secondary); }
.qo-card-open:focus-visible { outline: 2px solid var(--qo-ink); outline-offset: 3px; }
.qo-stale { background: var(--qo-bg); }
.qo-stale .qo-quota-value { font-size: 32px; }
.qo-empty { border: 1px solid var(--qo-line); padding: 42px 20px; display: grid; justify-items: center; text-align: center; gap: 12px; }
.qo-empty h2 { font-size: 17px; font-weight: 650; }
.qo-empty p { font-size: 13px; max-width: 500px; }
.qo-legend { display: flex; flex-wrap: wrap; gap: 18px; color: var(--qo-secondary); font-size: 11px; margin-top: 17px; }
.qo-legend > span { display: inline-flex; gap: 7px; align-items: center; }
.qo-swatch { width: 20px; height: 8px; background-color: var(--qo-track); }
.qo-swatch-used { background-color: var(--qo-surface); }
.qo-swatch-accent { background-color: var(--qo-accent); }
.qo-page-footer { display: flex; gap: 12px; flex-wrap: wrap; justify-content: space-between; color: var(--qo-secondary); font-size: 11px; border-top: 1px solid var(--qo-line); padding-top: 14px; margin-top: 24px; }
.qo-detail-summary { padding-bottom: 17px; border-bottom: 1px solid var(--qo-line); }
.qo-detail-summary .qo-quota-caption { margin-top: 12px; }
.qo-detail-window { padding: 18px 0; border-bottom: 1px solid var(--qo-line); }
.qo-detail-window-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 11px; }
.qo-detail-window-header h3 { font-size: 13px; font-weight: 600; }
.qo-detail-window-header strong { font-size: 18px; font-weight: 650; white-space: nowrap; }
.qo-detail-window-header strong > span { font-family: inherit; font-size: 11px; color: var(--qo-secondary); font-weight: 400; }
.qo-detail-meta { display: grid; gap: 7px; margin-top: 12px !important; font-size: 11px; }
.qo-detail-meta div { display: flex; gap: 16px; justify-content: space-between; }
.qo-detail-meta dt { color: var(--qo-secondary); flex-shrink: 0; }
.qo-detail-meta dd { text-align: right; }
.qo-detail-note { font-size: 12px; color: var(--qo-secondary); margin-top: 12px !important; }
.qo-dialog-refresh { margin-left: auto; }
.qo-button:focus-visible, .qo-filter:focus-visible, .qo-sort select:focus-visible { outline: 2px solid var(--skin-ink, #171715); outline-offset: 3px; }
@media (min-width: 1600px) { .qo-board { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 1024px) {
  .qo-stat { padding-inline: 14px; }
  .qo-stat > p > span { display: block; white-space: normal; }
  .qo-title-row { gap: 18px; }
  .qo-refresh-group { max-width: 190px; }
  .qo-last-fetch { text-align: right; }
  .qo-account { padding: 15px; }
  .qo-account.qo-priority { padding-top: 14px; }
}
@media (max-width: 640px) {
  .qo-title-row { flex-wrap: wrap; gap: 13px; }
  .qo-refresh-group { padding-top: 0; justify-items: start; max-width: 100%; }
  .qo-last-fetch { text-align: left; }
  .quota-overview h1 { font-size: 30px; }
  .qo-summary { margin-top: 22px; }
  .qo-stat { padding: 13px 9px; }
  .qo-stat-value { font-size: 24px; }
  .qo-stat > p { font-size: 11px; }
  .qo-stat > p > span { display: none; }
  .qo-board { grid-template-columns: 1fr; }
  .qo-account { padding: 17px; }
  .qo-account.qo-priority { padding-top: 16px; }
  .qo-sort { width: 100%; justify-content: space-between; }
  .qo-sort select { max-width: 85%; }
  .qo-account-header { gap: 7px; }
}
@media (pointer: coarse) {
  .qo-button, .qo-filter, .qo-sort select { min-height: 44px; }
}
</style>
