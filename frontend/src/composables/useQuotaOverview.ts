import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import accountsAPI from '@/api/admin/accounts'
import type { AccountListItem, AccountUsageInfo } from '@/types'
import {
  isSubscriptionQuotaAccount,
  normalizeQuotaAccount,
  type QuotaOverviewAccount
} from '@/utils/quotaOverview'

export const QUOTA_ACCOUNT_PAGE_SIZE = 100
export const QUOTA_ACCOUNT_MAX_PAGES = 50
// A server batch queries six accounts concurrently with a 30-second provider
// budget. Keep each browser batch to one wave and allow transport overhead.
export const QUOTA_USAGE_BATCH_SIZE = 6
export const QUOTA_USAGE_CONCURRENCY = 2
export const QUOTA_USAGE_REQUEST_TIMEOUT_MS = 45_000

interface QuotaReading {
  usage?: AccountUsageInfo
  previous?: QuotaOverviewAccount
  error?: string
}

// Unsupported subscription providers stay visible as unknown. Only these
// providers have authoritative subscription windows in the initial release.
function supportsQuotaReading(account: AccountListItem): boolean {
  return (account.platform === 'openai' && account.type === 'oauth') ||
    (account.platform === 'anthropic' && (account.type === 'oauth' || account.type === 'setup-token'))
}

export function useQuotaOverview() {
  const accounts = shallowRef<AccountListItem[]>([])
  const readings = shallowRef<Record<number, QuotaReading>>({})
  const now = ref(Date.now())
  const loading = ref(false)
  const refreshing = ref(false)
  const listFailed = ref(false)
  const truncated = ref(false)
  const lastFetchedAt = ref<string | null>(null)
  const loadedUsageCount = ref(0)
  const totalUsageCount = ref(0)
  let inFlight: Promise<void> | null = null
  let disposed = false
  let listController: AbortController | null = null
  let usageController: AbortController | null = null

  const rows = computed(() => accounts.value.map((account) => {
    const reading = readings.value[account.id]
    return normalizeQuotaAccount(account, reading?.usage, now.value, reading?.previous, reading?.error)
  }))
  const failedCount = computed(() => rows.value.filter(row => row.error).length)

  // Age readings locally; this deliberately does not poll provider APIs.
  const ageTimer = setInterval(() => { now.value = Date.now() }, 60_000)
  onScopeDispose(() => {
    disposed = true
    listController?.abort()
    usageController?.abort()
    clearInterval(ageTimer)
  })

  async function loadAccounts(): Promise<void> {
    listController = new AbortController()
    const firstPage = await accountsAPI.list(1, QUOTA_ACCOUNT_PAGE_SIZE, { lite: '1' }, {
      signal: listController.signal
    })
    if (disposed) return
    const pageCount = Math.max(firstPage.pages || 0, Math.ceil(firstPage.total / QUOTA_ACCOUNT_PAGE_SIZE), 1)
    const lastPage = Math.min(pageCount, QUOTA_ACCOUNT_MAX_PAGES)
    const byID = new Map<number, AccountListItem>()
    const collect = (items: AccountListItem[]) => {
      for (const account of items) {
        if (isSubscriptionQuotaAccount(account)) byID.set(account.id, account)
      }
    }
    collect(firstPage.items)
    for (let page = 2; page <= lastPage && !disposed; page++) {
      const result = await accountsAPI.list(page, QUOTA_ACCOUNT_PAGE_SIZE, { lite: '1' }, {
        signal: listController.signal
      })
      if (disposed) return
      collect(result.items)
      if (result.items.length === 0) break
    }
    if (disposed) return
    // Commit only a complete bounded list; a failed page must not remove
    // previously displayed accounts or turn a partial list into a total.
    accounts.value = [...byID.values()]
    readings.value = Object.fromEntries(
      Object.entries(readings.value).filter(([id]) => byID.has(Number(id)))
    )
    truncated.value = pageCount > QUOTA_ACCOUNT_MAX_PAGES
  }

  async function loadUsage(force: boolean): Promise<void> {
    const controller = new AbortController()
    usageController = controller
    const supported = accounts.value.filter(supportsQuotaReading)
    const accountByID = new Map(supported.map(account => [account.id, account]))
    const previousByID = new Map(rows.value.map(row => [row.account.id, row]))
    const ids = [...accountByID.keys()]
    const batches: number[][] = []
    for (let offset = 0; offset < ids.length; offset += QUOTA_USAGE_BATCH_SIZE) {
      batches.push(ids.slice(offset, offset + QUOTA_USAGE_BATCH_SIZE))
    }
    loadedUsageCount.value = 0
    totalUsageCount.value = ids.length
    let nextBatch = 0

    async function worker() {
      while (nextBatch < batches.length && !disposed) {
        const batch = batches[nextBatch++]
        try {
          const response = await accountsAPI.getBatchUsage(batch, force, {
            timeout: QUOTA_USAGE_REQUEST_TIMEOUT_MS,
            signal: controller.signal
          })
          if (disposed) return
          const updates = { ...readings.value }
          for (const id of batch) {
            const usage = response.usage[String(id)]
            const error = response.errors[String(id)] || (!usage ? 'missing_usage' : undefined)
            updates[id] = {
              // Keep the last successful raw snapshot and its original time on
              // failure, rather than replacing it with zero or an empty result.
              usage: usage ?? updates[id]?.usage,
              previous: previousByID.get(id),
              error
            }
          }
          readings.value = updates
        } catch {
          if (disposed) return
          const updates = { ...readings.value }
          for (const id of batch) {
            updates[id] = {
              usage: updates[id]?.usage,
              previous: previousByID.get(id),
              error: 'refresh_failed'
            }
          }
          readings.value = updates
        } finally {
          if (!disposed) loadedUsageCount.value += batch.length
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(QUOTA_USAGE_CONCURRENCY, batches.length) }, worker))
    } finally {
      if (usageController === controller) usageController = null
    }
  }

  async function runRefresh(force: boolean): Promise<void> {
    refreshing.value = true
    loading.value = accounts.value.length === 0
    listFailed.value = false
    try {
      try {
        await loadAccounts()
      } catch {
        if (disposed) return
        listFailed.value = true
      }
      if (disposed) return
      if (accounts.value.length > 0) await loadUsage(force)
      if (!disposed) {
        now.value = Date.now()
        lastFetchedAt.value = new Date(now.value).toISOString()
      }
    } finally {
      if (!disposed) {
        loading.value = false
        refreshing.value = false
      }
    }
  }

  function refresh(force = true): Promise<void> {
    if (disposed) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = runRefresh(force).finally(() => { inFlight = null })
    return inFlight
  }

  return {
    rows,
    now,
    loading,
    refreshing,
    listFailed,
    truncated,
    failedCount,
    lastFetchedAt,
    loadedUsageCount,
    totalUsageCount,
    refresh
  }
}
