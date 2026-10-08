import type { AccountListItem, AccountQuotaWindow, AccountUsageInfo } from '@/types'

export const QUOTA_PRIORITY_THRESHOLD = 20
export const QUOTA_STALE_AFTER_MS = 15 * 60 * 1000
const MAX_SAMPLE_CLOCK_SKEW_MS = 60 * 1000

export interface QuotaOverviewWindow {
  key: string
  labelKey: string
  labelParams?: Record<string, string | number>
  utilization: number | null
  remainingPercent: number | null
  resetsAt: string | null
  sampledAt: string | null
  source: string
  scope: 'account' | 'model'
  model?: string
  stale: boolean
  estimated: boolean
}

export interface QuotaOverviewAccount {
  account: AccountListItem
  windows: QuotaOverviewWindow[]
  bottleneck: QuotaOverviewWindow | null
  state: 'fresh' | 'stale' | 'unknown' | 'estimated'
  error?: string
  sampledAt: string | null
  source: string | null
  remainingPercent: number | null
  incomplete: boolean
}

export type QuotaOverviewSort = 'remaining' | 'reset'

export function isSubscriptionQuotaAccount(account: Pick<AccountListItem, 'type' | 'platform'>): boolean {
  return account.type === 'oauth' || (account.platform === 'anthropic' && account.type === 'setup-token')
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function windowLabel(window: AccountQuotaWindow): Pick<QuotaOverviewWindow, 'labelKey' | 'labelParams'> {
  const base = 'admin.quotaOverview.windows.'
  const minutes = window.window_minutes
  const model = window.model || ''
  if (window.scope === 'model') {
    if (minutes === 10080 || (!minutes && ['seven_day_sonnet', 'seven_day_fable'].includes(window.key))) {
      return { labelKey: base + 'modelSevenDay', labelParams: { model } }
    }
    return { labelKey: base + 'modelQuota', labelParams: { model } }
  }
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
    if (minutes === 300) return { labelKey: base + 'fiveHour' }
    if (minutes === 10080) return { labelKey: base + 'sevenDay' }
    if (minutes === 43200) return { labelKey: base + 'thirtyDay' }
    if (minutes % 60 === 0) return { labelKey: base + 'windowHours', labelParams: { hours: minutes / 60 } }
    return { labelKey: base + 'windowMinutes', labelParams: { minutes } }
  }
  const known: Record<string, string> = { five_hour: 'fiveHour', seven_day: 'sevenDay', thirty_day: 'thirtyDay' }
  return { labelKey: base + (known[window.key] || 'unknown') }
}

function normalizeWindow(window: AccountQuotaWindow, now: number, failed: boolean): QuotaOverviewWindow {
  const utilization = typeof window.utilization === 'number' && Number.isFinite(window.utilization) && window.utilization >= 0
    ? window.utilization : null
  const sampledAt = timestamp(window.sampled_at)
  const resetsAt = timestamp(window.resets_at)
  const estimated = window.source === 'estimated' || window.source === 'local'
  const age = sampledAt ? now - Date.parse(sampledAt) : Infinity
  const authoritative = window.source === 'upstream' || window.source === 'response_headers'
  return {
    key: window.key,
    ...windowLabel(window),
    utilization,
    remainingPercent: utilization === null ? null : Math.max(0, 100 - utilization),
    resetsAt,
    sampledAt,
    source: window.source,
    scope: window.scope === 'model' ? 'model' : 'account',
    model: window.model,
    stale: failed || age > QUOTA_STALE_AFTER_MS || age < -MAX_SAMPLE_CLOCK_SKEW_MS || (resetsAt !== null && Date.parse(resetsAt) <= now) || !authoritative,
    estimated
  }
}

function expectedWindows(account: AccountListItem): AccountQuotaWindow[] {
  if (!['openai', 'anthropic'].includes(account.platform)) return []
  return ['five_hour', 'seven_day'].map((key, index) => ({
    key, utilization: null, resets_at: null, sampled_at: null,
    source: 'response_headers' as const, scope: 'account' as const,
    window_minutes: index === 0 ? 300 : 10080
  }))
}

/** Do not infer upstream capacity from legacy zero-valued local WindowStats. */
export function normalizeQuotaAccount(
  account: AccountListItem,
  usage: AccountUsageInfo | null | undefined,
  now: number = Date.now(),
  previous?: QuotaOverviewAccount,
  error?: string
): QuotaOverviewAccount {
  const failure = error || usage?.quota_snapshot_error || usage?.error || undefined
  const prior = previous?.account.id === account.id ? previous : undefined
  const rawWindows = usage?.quota_windows || []
  const unique = new Map(rawWindows.map(window => [window.key, window]))
  for (const expected of expectedWindows(account)) {
    if (!unique.has(expected.key)) unique.set(expected.key, expected)
  }
  let windows = [...unique.values()].map(window => normalizeWindow(window, now, !!failure))

  // A failed refresh must not erase the previous successful reading. Preserve
  // its actual sample time and reset, and label it stale instead of fresh zero.
  if (failure && prior) {
    const current = new Map(windows.map(window => [window.key, window]))
    for (const old of prior.windows) {
      if (old.utilization !== null && current.get(old.key)?.utilization == null) {
        current.set(old.key, { ...old, stale: true })
      }
    }
    windows = [...current.values()]
  }

  const measured = windows.filter(window => window.remainingPercent !== null && !window.estimated && ['upstream', 'response_headers'].includes(window.source))
  // If any applicable reading expired, the whole account is labeled stale and
  // ranked below current accounts; the old bottleneck stays visible as history.
  const bottleneck = measured.reduce<QuotaOverviewWindow | null>((tightest, window) => (
    tightest === null || window.remainingPercent! < tightest.remainingPercent! ? window : tightest
  ), null)
  const state = measured.length === 0
    ? windows.some(window => window.remainingPercent !== null && window.estimated) ? 'estimated' : 'unknown'
    : failure || measured.some(window => window.stale) ? 'stale' : 'fresh'
  const sampleTimes = measured.map(window => window.sampledAt).filter((value): value is string => value !== null)
  const sampledAt = sampleTimes.length
    ? sampleTimes.reduce((oldest, value) => Date.parse(value) < Date.parse(oldest) ? value : oldest)
    : null
  return {
    account, windows, bottleneck, state, error: failure, sampledAt,
    source: bottleneck?.source || windows.find(window => window.utilization !== null)?.source || null,
    remainingPercent: bottleneck?.remainingPercent ?? null,
    incomplete: measured.length === 0 || windows.some(window => window.utilization === null || window.estimated)
  }
}

/** Exhaustion is not forecast here; resets and remaining fractions stay separate. */
export function sortQuotaAccounts(
  rows: QuotaOverviewAccount[],
  sort: QuotaOverviewSort,
  now: number = Date.now()
): QuotaOverviewAccount[] {
  const stateOrder = { fresh: 0, stale: 1, estimated: 2, unknown: 3 }
  const resetRank = (row: QuotaOverviewAccount) => {
    const reset = row.bottleneck?.resetsAt ? Date.parse(row.bottleneck.resetsAt) : Infinity
    return reset > now ? reset : Infinity
  }
  return [...rows].sort((left, right) => {
    const category = stateOrder[left.state] - stateOrder[right.state]
    if (category !== 0) return category
    const a = sort === 'reset' ? resetRank(left) : left.remainingPercent ?? Infinity
    const b = sort === 'reset' ? resetRank(right) : right.remainingPercent ?? Infinity
    if (a !== b) return a < b ? -1 : 1
    return left.account.name.localeCompare(right.account.name) || left.account.id - right.account.id
  })
}
