import { describe, expect, it } from 'vitest'
import type { AccountListItem, AccountQuotaWindow, AccountUsageInfo } from '@/types'
import { isSubscriptionQuotaAccount, normalizeQuotaAccount, QUOTA_STALE_AFTER_MS, sortQuotaAccounts } from '../quotaOverview'

const now = Date.parse('2026-10-08T02:24:00Z')
const future = '2026-10-08T04:00:00Z'
const sampled = '2026-10-08T02:23:00Z'
const account = (id = 1, platform = 'openai'): AccountListItem => ({
  id, name: `Account ${id}`, platform, type: 'oauth'
} as AccountListItem)
const window = (key: string, utilization: number | null, overrides: Partial<AccountQuotaWindow> = {}): AccountQuotaWindow => ({
  key, utilization, resets_at: future, sampled_at: sampled, source: 'upstream', scope: 'account', ...overrides
})
const usage = (...windows: AccountQuotaWindow[]): AccountUsageInfo => ({
  updated_at: '2026-10-08T02:24:00Z', quota_windows: windows
} as AccountUsageInfo)
const complete = (used: number) => usage(window('five_hour', used), window('seven_day', 10))

describe('subscription quota overview', () => {
  it('highlights the most constrained applicable window without adding capacities', () => {
    const row = normalizeQuotaAccount(account(), usage(window('five_hour', 25), window('seven_day', 92)), now)
    expect(row.bottleneck?.key).toBe('seven_day')
    expect(row.remainingPercent).toBe(8)
    expect(row.state).toBe('fresh')
    expect(row.incomplete).toBe(false)
  })

  it('distinguishes real zero usage from missing windows and local-cost zeros', () => {
    const measured = normalizeQuotaAccount(account(), usage(window('five_hour', 0)), now)
    expect(measured.remainingPercent).toBe(100)
    expect(measured.incomplete).toBe(true)
    expect(measured.windows.find(w => w.key === 'seven_day')?.remainingPercent).toBeNull()
    const legacy = normalizeQuotaAccount(account(), {
      updated_at: sampled, five_hour: { utilization: 0, window_stats: { cost: 42 } }
    } as AccountUsageInfo, now)
    expect(legacy.state).toBe('unknown')
    expect(legacy.remainingPercent).toBeNull()
    const local = normalizeQuotaAccount(account(), usage(window('five_hour', 0, { source: 'local' })), now)
    expect(local.state).toBe('estimated')
    expect(local.remainingPercent).toBeNull()
  })

  it('retains the previous sample and value after a failed refresh', () => {
    const prior = normalizeQuotaAccount(account(), complete(83), now)
    const next = normalizeQuotaAccount(account(), undefined, now, prior, 'Request failed')
    expect(next.state).toBe('stale')
    expect(next.remainingPercent).toBe(17)
    expect(next.sampledAt).toBe(sampled)
    expect(next.bottleneck?.resetsAt).toBe(future)
    expect(next.error).toBe('Request failed')
    expect(next.windows.every(w => w.stale)).toBe(true)
  })

  it('does not retain readings from another account', () => {
    const prior = normalizeQuotaAccount(account(1), complete(83), now)
    const next = normalizeQuotaAccount(account(2), undefined, now, prior, 'Failed')
    expect(next.remainingPercent).toBeNull()
    expect(next.state).toBe('unknown')
  })

  it('marks retained server fallback readings stale even if their timestamps look recent', () => {
    const snapshot = { ...complete(98), quota_snapshot_error: 'Upstream unavailable' }
    const row = normalizeQuotaAccount(account(), snapshot, now)
    expect(row.state).toBe('stale')
    expect(row.remainingPercent).toBe(2)
  })

  it('uses actual window duration and preserves model-specific scope', () => {
    const row = normalizeQuotaAccount(account(1, 'anthropic'), usage(
      window('five_hour', 20, { window_minutes: 180 }), window('seven_day', 40),
      window('seven_day_sonnet', 98, { scope: 'model', model: 'Sonnet', window_minutes: 10080 })
    ), now)
    expect(row.windows[0].labelKey).toBe('admin.quotaOverview.windows.windowHours')
    expect(row.windows[0].labelParams).toEqual({ hours: 3 })
    expect(row.bottleneck?.scope).toBe('model')
    expect(row.bottleneck?.model).toBe('Sonnet')
    expect(row.bottleneck?.labelParams).toEqual({ model: 'Sonnet' })
    expect(row.remainingPercent).toBe(2)
  })

  it('preserves old exhausted readings after their reset instead of assuming fresh zero', () => {
    const row = normalizeQuotaAccount(account(), usage(
      window('five_hour', 100, { resets_at: '2026-10-08T02:20:00Z' }), window('seven_day', 50)
    ), now)
    expect(row.state).toBe('stale')
    expect(row.remainingPercent).toBe(0)
    expect(row.bottleneck?.resetsAt).toBe('2026-10-08T02:20:00Z')
  })

  it('accepts a fresh observed zero countdown with no future reset while retaining the actual weekly bottleneck', () => {
    // The backend normalizes the explicit upstream 0%/0-second pair to a
    // missing future reset; it preserves both the sample and weekly reading.
    const row = normalizeQuotaAccount(account(), usage(
      window('five_hour', 0, { resets_at: null, source: 'response_headers', window_minutes: 300 }),
      window('seven_day', 26, { source: 'response_headers', window_minutes: 10080 })
    ), now)
    expect(row.state).toBe('fresh')
    expect(row.incomplete).toBe(false)
    expect(row.remainingPercent).toBe(74)
    expect(row.bottleneck?.key).toBe('seven_day')
    expect(row.windows[0].remainingPercent).toBe(100)
    expect(row.windows[0].resetsAt).toBeNull()
    expect(row.windows[0].sampledAt).toBe(sampled)
    expect(row.windows[0].stale).toBe(false)
  })

  it('does not let an absent zero-countdown reset refresh old, unknown, future-skewed or failed samples', () => {
    for (const sample of [new Date(now - QUOTA_STALE_AFTER_MS - 1).toISOString(), null, 'invalid', new Date(now + 60_001).toISOString()]) {
      const row = normalizeQuotaAccount(account(), usage(
        window('five_hour', 0, { resets_at: null, sampled_at: sample, source: 'response_headers' }),
        window('seven_day', 26)
      ), now)
      expect(row.state).toBe('stale')
      expect(row.windows[0].stale).toBe(true)
    }
    const failed = normalizeQuotaAccount(account(), {
      ...usage(window('five_hour', 0, { resets_at: null }), window('seven_day', 26)),
      quota_snapshot_error: 'snapshot unavailable'
    }, now)
    expect(failed.state).toBe('stale')
    for (const used of [25, 100]) {
      const expired = normalizeQuotaAccount(account(), usage(
        window('five_hour', used, { resets_at: sampled }), window('seven_day', 26)
      ), now)
      expect(expired.state).toBe('stale')
      expect(expired.windows[0].utilization).toBe(used)
      expect(expired.windows[0].resetsAt).toBe(sampled)
    }
  })

  it('does not substitute response creation time for real sampling time', () => {
    for (const invalid of [null, 'invalid', '2026-10-08T03:24:00Z']) {
      const row = normalizeQuotaAccount(account(), usage(window('five_hour', 25, { sampled_at: invalid })), now)
      expect(row.state).toBe('stale')
    }
    const old = new Date(now - QUOTA_STALE_AFTER_MS - 1).toISOString()
    expect(normalizeQuotaAccount(account(), usage(window('five_hour', 0, { sampled_at: old })), now).state).toBe('stale')
  })

  it('treats invalid or negative usage as unknown and caps remaining at zero on overage', () => {
    for (const invalid of [NaN, Infinity, -1, null]) {
      expect(normalizeQuotaAccount(account(), usage(window('five_hour', invalid)), now).remainingPercent).toBeNull()
    }
    expect(normalizeQuotaAccount(account(), usage(window('five_hour', 123)), now).remainingPercent).toBe(0)
  })

  it('does not promote estimates into authoritative quota rankings', () => {
    const row = normalizeQuotaAccount(account(1, 'anthropic'), usage(window('five_hour', 80, { source: 'estimated' })), now)
    expect(row.state).toBe('estimated')
    expect(row.bottleneck).toBeNull()
    expect(row.windows[0].estimated).toBe(true)
    expect(row.remainingPercent).toBeNull()
  })

  it('sorts current readings before stale and unknown accounts without mutating the source', () => {
    const current = normalizeQuotaAccount(account(1), complete(70), now)
    const stale = normalizeQuotaAccount(account(2), usage(window('five_hour', 99, { sampled_at: null })), now)
    const unknown = normalizeQuotaAccount(account(3), undefined, now)
    const source = [unknown, stale, current]
    expect(sortQuotaAccounts(source, 'remaining', now).map(r => r.account.id)).toEqual([1, 2, 3])
    expect(source.map(r => r.account.id)).toEqual([3, 2, 1])
  })

  it('sorts reset by the bottleneck, independently of remaining capacity', () => {
    const low = normalizeQuotaAccount(account(1), usage(
      window('five_hour', 30, { resets_at: '2026-10-08T02:30:00Z' }),
      window('seven_day', 92, { resets_at: '2026-10-10T00:00:00Z' })
    ), now)
    const soon = normalizeQuotaAccount(account(2), complete(50), now)
    expect(sortQuotaAccounts([low, soon], 'remaining', now)[0].account.id).toBe(1)
    expect(sortQuotaAccounts([low, soon], 'reset', now)[0].account.id).toBe(2)
  })

  it('excludes API key/local budget accounts from subscription overview', () => {
    expect(isSubscriptionQuotaAccount({ platform: 'openai', type: 'oauth' })).toBe(true)
    expect(isSubscriptionQuotaAccount({ platform: 'anthropic', type: 'setup-token' })).toBe(true)
    expect(isSubscriptionQuotaAccount({ platform: 'openai', type: 'apikey' })).toBe(false)
    expect(isSubscriptionQuotaAccount({ platform: 'gemini', type: 'service_account' })).toBe(false)
  })
})
