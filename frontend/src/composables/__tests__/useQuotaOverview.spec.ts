import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import type { AccountListItem, AccountUsageInfo } from '@/types'
import {
  useQuotaOverview,
  QUOTA_ACCOUNT_MAX_PAGES,
  QUOTA_USAGE_BATCH_SIZE,
  QUOTA_USAGE_CONCURRENCY,
  QUOTA_USAGE_REQUEST_TIMEOUT_MS
} from '../useQuotaOverview'

const { list, getBatchUsage } = vi.hoisted(() => ({ list: vi.fn(), getBatchUsage: vi.fn() }))
vi.mock('@/api/admin/accounts', () => ({ default: { list, getBatchUsage } }))

const sampledAt = '2026-10-08T02:00:00Z'
const resetAt = '2026-10-08T05:00:00Z'
function account(id: number, platform = 'openai', type = 'oauth'): AccountListItem {
  return { id, name: `account-${id}`, platform, type, status: 'active' } as AccountListItem
}
function usage(used = 88): AccountUsageInfo {
  return {
    updated_at: sampledAt,
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    quota_windows: [
      { key: 'five_hour', utilization: used, resets_at: resetAt, sampled_at: sampledAt, source: 'upstream', scope: 'account', window_minutes: 300 },
      { key: 'seven_day', utilization: 40, resets_at: '2026-10-10T02:00:00Z', sampled_at: sampledAt, source: 'upstream', scope: 'account', window_minutes: 10080 }
    ]
  } as AccountUsageInfo
}
function page(items: AccountListItem[], total = items.length, pages = 1) {
  return { items, total, pages, page: 1, page_size: 100 }
}
const scopes: EffectScope[] = []
function createState() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useQuotaOverview())!
}

describe('useQuotaOverview', () => {
  beforeEach(() => {
    list.mockReset()
    getBatchUsage.mockReset()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(sampledAt))
  })
  afterEach(() => {
    scopes.splice(0).forEach(scope => scope.stop())
    vi.restoreAllMocks()
  })

  it('keeps initial loading active until usage completes and deduplicates refreshes', async () => {
    list.mockResolvedValue(page([account(1)]))
    let resolveUsage!: (value: unknown) => void
    getBatchUsage.mockImplementation(() => new Promise(resolve => { resolveUsage = resolve }))
    const state = createState()
    const first = state.refresh(false)
    await flushPromises()
    expect(state.loading.value).toBe(true)
    expect(state.refreshing.value).toBe(true)
    expect(state.refresh(true)).toBe(first)
    expect(getBatchUsage).toHaveBeenCalledTimes(1)
    expect(getBatchUsage).toHaveBeenCalledWith([1], false, { timeout: 45_000, signal: expect.any(AbortSignal) })
    resolveUsage({ usage: { 1: usage() }, errors: {} })
    await first
    expect(state.loading.value).toBe(false)
    expect(state.rows.value[0].remainingPercent).toBe(12)
    expect(state.rows.value[0].state).toBe('fresh')
    expect(state.rows.value[0].sampledAt).toBe(sampledAt)
  })

  it('keeps the original reading and timestamp when both list and usage refresh fail', async () => {
    list.mockResolvedValue(page([account(1)]))
    getBatchUsage.mockResolvedValue({ usage: { 1: usage(92) }, errors: {} })
    const state = createState()
    await state.refresh(false)
    list.mockRejectedValueOnce(new Error('network error'))
    getBatchUsage.mockRejectedValueOnce(new Error('upstream failed'))
    await state.refresh()
    expect(state.listFailed.value).toBe(true)
    expect(state.rows.value).toHaveLength(1)
    expect(state.rows.value[0].remainingPercent).toBe(8)
    expect(state.rows.value[0].sampledAt).toBe(sampledAt)
    expect(state.rows.value[0].state).toBe('stale')
    expect(state.failedCount.value).toBe(1)
  })

  it('deduplicates paginated accounts, excludes API keys, and leaves unsupported subscriptions unknown', async () => {
    list.mockResolvedValueOnce(page([account(1), account(7, 'openai', 'apikey')], 4, 2))
    list.mockResolvedValueOnce(page([account(1), account(2, 'gemini')], 4, 2))
    getBatchUsage.mockResolvedValue({ usage: { 1: usage(0) }, errors: {} })
    const state = createState()
    await state.refresh(false)
    expect(list).toHaveBeenNthCalledWith(1, 1, 100, { lite: '1' }, { signal: expect.any(AbortSignal) })
    expect(list).toHaveBeenNthCalledWith(2, 2, 100, { lite: '1' }, { signal: expect.any(AbortSignal) })
    expect(getBatchUsage).toHaveBeenCalledTimes(1)
    expect(getBatchUsage).toHaveBeenCalledWith([1], false, { timeout: 45_000, signal: expect.any(AbortSignal) })
    expect(state.rows.value.map(row => row.account.id)).toEqual([1, 2])
    expect(state.rows.value[1].remainingPercent).toBeNull()
    expect(state.rows.value[1].state).toBe('unknown')
  })

  it('treats a missing batch result as unknown rather than zero', async () => {
    list.mockResolvedValue(page([account(1)]))
    getBatchUsage.mockResolvedValue({ usage: {}, errors: { 1: 'unavailable' } })
    const state = createState()
    await state.refresh(false)
    expect(state.rows.value[0].remainingPercent).toBeNull()
    expect(state.rows.value[0].state).toBe('unknown')
    expect(state.failedCount.value).toBe(1)
  })

  it('bounds batch size and concurrency while reading all loaded accounts', async () => {
    const items = Array.from({ length: 205 }, (_, index) => account(index + 1))
    list.mockImplementation((pageNumber: number) => Promise.resolve(page(items.slice((pageNumber - 1) * 100, pageNumber * 100), 205, 3)))
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    getBatchUsage.mockImplementation((ids: number[]) => new Promise(resolve => {
      active++
      maxActive = Math.max(maxActive, active)
      releases.push(() => {
        active--
        resolve({ usage: Object.fromEntries(ids.map(id => [id, usage()])), errors: {} })
      })
    }))
    const state = createState()
    const pending = state.refresh(false)
    await flushPromises()
    expect(getBatchUsage).toHaveBeenCalledTimes(QUOTA_USAGE_CONCURRENCY)
    releases[0]()
    await flushPromises()
    expect(getBatchUsage).toHaveBeenCalledTimes(QUOTA_USAGE_CONCURRENCY + 1)
    let released = 1
    const expectedBatches = Math.ceil(items.length / QUOTA_USAGE_BATCH_SIZE)
    while (released < expectedBatches) {
      const waiting = releases.slice(released)
      expect(waiting.length).toBeGreaterThan(0)
      waiting.forEach(release => release())
      released += waiting.length
      await flushPromises()
    }
    await pending
    expect(maxActive).toBe(QUOTA_USAGE_CONCURRENCY)
    expect(getBatchUsage.mock.calls.map(call => call[0].length)).toEqual(Array.from({ length: expectedBatches }, (_, index) => Math.min(QUOTA_USAGE_BATCH_SIZE, items.length - index * QUOTA_USAGE_BATCH_SIZE)))
    expect(getBatchUsage.mock.calls.flatMap(call => call[0])).toEqual(items.map(item => item.id))
    expect(getBatchUsage.mock.calls.every(call => call[2].timeout === QUOTA_USAGE_REQUEST_TIMEOUT_MS)).toBe(true)
    expect(state.rows.value).toHaveLength(205)
    expect(state.loadedUsageCount.value).toBe(205)
  })

  it('stops at the account page cap and explicitly reports incomplete coverage', async () => {
    list.mockImplementation((pageNumber: number) => Promise.resolve(page([account(pageNumber, 'gemini')], 9_000, 90)))
    const state = createState()
    await state.refresh(false)
    expect(list).toHaveBeenCalledTimes(QUOTA_ACCOUNT_MAX_PAGES)
    expect(getBatchUsage).not.toHaveBeenCalled()
    expect(state.truncated.value).toBe(true)
  })

  it('keeps the previous full list if a later page fails during refresh', async () => {
    list.mockResolvedValueOnce(page([account(1), account(2)]))
    getBatchUsage.mockResolvedValue({ usage: { 1: usage(), 2: usage() }, errors: {} })
    const state = createState()
    await state.refresh(false)
    list.mockResolvedValueOnce(page([account(3)], 200, 2))
    list.mockRejectedValueOnce(new Error('page two unavailable'))
    await state.refresh()
    expect(state.listFailed.value).toBe(true)
    expect(state.rows.value.map(row => row.account.id)).toEqual([1, 2])
    expect(getBatchUsage).toHaveBeenLastCalledWith([1, 2], true, { timeout: 45_000, signal: expect.any(AbortSignal) })
  })

  it('cancels every active usage request and does not write state or launch more batches after disposal', async () => {
    const items = Array.from({ length: 205 }, (_, index) => account(index + 1))
    list.mockImplementation((pageNumber: number) => Promise.resolve(page(items.slice((pageNumber - 1) * 100, pageNumber * 100), 205, 3)))
    let aborted = 0
    getBatchUsage.mockImplementation((_ids: number[], _force: boolean, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted++
        reject(new DOMException('Cancelled', 'AbortError'))
      }, { once: true })
    }))
    const state = createState()
    const pending = state.refresh(false)
    await flushPromises()
    const signals = getBatchUsage.mock.calls.map(call => call[2].signal as AbortSignal)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    scopes[scopes.length - 1].stop()
    await pending
    expect(aborted).toBe(QUOTA_USAGE_CONCURRENCY)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(getBatchUsage).toHaveBeenCalledTimes(QUOTA_USAGE_CONCURRENCY)
    expect(state.lastFetchedAt.value).toBeNull()
    expect(state.rows.value.every(row => row.state === 'unknown')).toBe(true)
    await state.refresh()
    expect(getBatchUsage).toHaveBeenCalledTimes(QUOTA_USAGE_CONCURRENCY)
  })
})
