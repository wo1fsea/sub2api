import { describe, expect, it } from 'vitest'
import type { AccountListItem, AccountQuotaWindow, AccountUsageInfo } from '@/types'
import { isSubscriptionQuotaAccount, normalizeQuotaAccount, quotaCardWindows, quotaCardGroups, QUOTA_STALE_AFTER_MS, sortQuotaAccounts } from '../quotaOverview'

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
const pool = (id: string, used: number | null, overrides: Partial<AccountQuotaWindow> = {}) => window(`antigravity_pool:${id}`, used, {
  scope: 'pool', pool: id.startsWith('gemini') ? 'Gemini Models' : 'Claude and GPT models',
  window_minutes: id.endsWith('weekly') ? 10080 : 300, ...overrides
})

describe('subscription quota overview', () => {
  const ag = account(12, 'antigravity')
  const agUsage = (): AccountUsageInfo => ({
    ...usage(pool('gemini-weekly', 42.70768), pool('gemini-5h', 0), pool('3p-weekly', 100), pool('3p-5h', null, { disabled: true })), updated_at: sampled, subscription_tier: 'ULTRA',
    five_hour: { utilization: 80, resets_at: future, remaining_seconds: 5820 },
    antigravity_quota: {
      'gemini-3-pro-high': { utilization: 0, reset_time: '2026-10-08T06:00:00Z' },
      'claude-sonnet-4': { utilization: 80, reset_time: future }
    },
    ai_credits: [{ credit_type: 'GOOGLE_ONE_AI', amount: 0, minimum_balance: 10 }]
  })

  it('uses upstream shared pools, excludes disabled capacity and keeps model details and credits separate', () => {
    const row = normalizeQuotaAccount(ag, agUsage(), now)
    expect(row.windows).toHaveLength(4)
    expect(row.windows.every(w => w.scope === 'pool')).toBe(true)
    expect(row.bottleneck?.key).toBe('antigravity_pool:3p-weekly')
    expect(row.bottleneck?.resetsAt).toBe(future)
    expect(row.remainingPercent).toBe(0)
    expect(row.windows[0].remainingPercent).toBeCloseTo(57.29232)
    expect(row.modelWindows.find(w => w.model === 'gemini-3-pro-high')?.remainingPercent).toBe(100)
    expect(row.incomplete).toBe(false)
    expect(quotaCardGroups(row).map(group => [group.name, group.windows.length])).toEqual([
      ['Gemini Models', 2], ['Claude and GPT models', 1]
    ])
    expect(row.subscriptionTier).toBe('ULTRA')
    expect(row.aiCredits).toEqual([{ type: 'GOOGLE_ONE_AI', amount: 0 }])
    expect(row.creditsSampledAt).toBe(sampled)
    expect(row.creditsStale).toBe(false)
    expect(row.state).toBe('fresh')
  })

  it('never promotes the primary-model alias or old model readings into pool capacity', () => {
    const row = normalizeQuotaAccount(ag, { ...agUsage(), quota_windows: [], antigravity_quota: {} }, now)
    expect(row.windows).toHaveLength(3)
    expect(row.state).toBe('unknown')
    expect(row.bottleneck).toBeNull()
    expect(row.modelWindows[0].labelKey).toBe('admin.quotaOverview.windows.antigravityPrimary')
    expect(normalizeQuotaAccount(ag, undefined, now).state).toBe('unknown')
  })

  it('shows three applicable pool windows while retaining all 26 model readings in details', () => {
    const row = normalizeQuotaAccount(ag, { ...agUsage(), antigravity_quota: Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => [`model-${index}`, { utilization: index * 4, reset_time: future }])
    ) }, now)
    expect(row.modelWindows).toHaveLength(26)
    expect(quotaCardWindows(row)).toHaveLength(3)
    expect(quotaCardWindows(row).every(w => !w.model)).toBe(true)
  })

  it('prefers canonical model windows while retaining other Antigravity models', () => {
    const row = normalizeQuotaAccount(ag, {
      ...agUsage(), quota_windows: [window('canonical-claude', 90, { scope: 'model', model: 'claude-sonnet-4' })]
    }, now)
    expect(row.modelWindows).toHaveLength(2)
    expect(row.modelWindows.find(w => w.model === 'claude-sonnet-4')?.remainingPercent).toBe(10)
    expect(row.remainingPercent).toBeNull()
  })

  it('does not refresh cached Antigravity timestamps or infer missing resets and capacity', () => {
    const old = new Date(now - QUOTA_STALE_AFTER_MS - 1).toISOString()
    const snapshot = { ...agUsage(), updated_at: old, quota_windows: agUsage().quota_windows!.map(w => ({ ...w, sampled_at: old })) }
    const row = normalizeQuotaAccount(ag, snapshot, now)
    expect(row.state).toBe('stale')
    expect(row.creditsStale).toBe(true)
    expect(row.sampledAt).toBe(snapshot.updated_at)
    for (const invalid of [null, 'invalid', new Date(now + 60_001).toISOString()]) {
      expect(normalizeQuotaAccount(ag, { ...snapshot, quota_windows: snapshot.quota_windows.map(w => ({ ...w, sampled_at: invalid })) }, now).state).toBe('stale')
    }
    const unknown = normalizeQuotaAccount(ag, {
      ...agUsage(), quota_windows: [], antigravity_quota: { broken: { utilization: NaN, reset_time: 'invalid' } },
      ai_credits: [{ amount: NaN }, { amount: -1 }]
    }, now)
    expect(unknown.state).toBe('unknown')
    expect(unknown.windows[0].resetsAt).toBeNull()
    expect(unknown.aiCredits.every(credit => credit.amount === null)).toBe(true)
  })

  it('decodes the deployed API omitempty zero credit balance without inferring absent credit pools', () => {
    const row = normalizeQuotaAccount(ag, { ...agUsage(), ai_credits: [{ credit_type: 'GOOGLE_ONE_AI' }] }, now)
    expect(row.aiCredits).toEqual([{ type: 'GOOGLE_ONE_AI', amount: 0 }])
    expect(normalizeQuotaAccount(ag, { ...agUsage(), ai_credits: undefined }, now).aiCredits).toEqual([])
  })

  it('preserves model readings, credit balance and tier on degraded or forbidden Antigravity responses', () => {
    const prior = normalizeQuotaAccount(ag, agUsage(), now)
    for (const error of [{ error_code: 'network_error' }, { is_forbidden: true }, { needs_reauth: true }]) {
      const row = normalizeQuotaAccount(ag, { ...usage(), ...error }, now, prior)
      expect(row.state).toBe('stale')
      expect(row.remainingPercent).toBe(0)
      expect(row.sampledAt).toBe(sampled)
      expect(row.aiCredits).toEqual(prior.aiCredits)
      expect(row.creditsSampledAt).toBe(sampled)
      expect(row.creditsStale).toBe(true)
      expect(row.subscriptionTier).toBe('ULTRA')
    }
    const recovered = normalizeQuotaAccount(ag, { ...agUsage(), ai_credits: [] }, now, prior)
    expect(recovered.aiCredits).toEqual([])
  })

  it('keeps an expired Antigravity window exhausted until a new observation arrives', () => {
    const row = normalizeQuotaAccount(ag, { ...agUsage(), quota_windows: [pool('3p-weekly', 100, { resets_at: sampled })] }, now)
    expect(row.state).toBe('stale')
    expect(row.remainingPercent).toBe(0)
    expect(row.bottleneck?.resetsAt).toBe(sampled)
  })

  it('shows an enabled third-party 5h window and never restores prior data into a disabled window', () => {
    const snapshot = agUsage()
    snapshot.quota_windows![3] = pool('3p-5h', 90)
    const prior = normalizeQuotaAccount(ag, snapshot, now)
    expect(quotaCardWindows(prior)).toHaveLength(4)
    const disabled = normalizeQuotaAccount(ag, { ...agUsage(), quota_snapshot_error: 'partial' }, now, prior)
    expect(disabled.windows.find(w => w.key.endsWith('3p-5h'))?.remainingPercent).toBeNull()
    expect(quotaCardWindows(disabled)).toHaveLength(3)
  })

  it('retains pool samples on summary-only failure without relabeling fresh model readings as capacity', () => {
    const prior = normalizeQuotaAccount(ag, agUsage(), now)
    const failed = normalizeQuotaAccount(ag, { ...agUsage(), quota_windows: [], updated_at: future, quota_snapshot_error: 'summary_unavailable' }, now, prior)
    expect(failed.remainingPercent).toBe(0)
    expect(failed.windows[0].remainingPercent).toBeCloseTo(57.29232)
    expect(failed.sampledAt).toBe(sampled)
    expect(failed.state).toBe('stale')
    expect(quotaCardWindows(failed)).toHaveLength(3)
  })

  it('never carries a previous Factory credential generation into the current subscription', () => {
    const before = { ...account(13, 'factory'), type: 'apikey' as const, extra: { factory_usage_generation: 'before' } }
    const oldUsage = { ...usage(window('factory_core_monthly', 97, { scope: 'core' })), factory_usage: { stale: false, generation: 'before' } }
    const prior = normalizeQuotaAccount(before, oldUsage, now)
    const after = { ...before, extra: { factory_usage_generation: 'after' } }
    const row = normalizeQuotaAccount(after, oldUsage, now, prior, 'refresh_failed')
    expect(row.state).toBe('unknown')
    expect(row.windows.every(window => window.utilization === null)).toBe(true)
  })

  it('includes Factory API keys and keeps six scoped windows with calendar month labels', () => {
    const factory = { ...account(13, 'factory'), type: 'apikey' as const }
    expect(isSubscriptionQuotaAccount(factory)).toBe(true)
    const row = normalizeQuotaAccount(factory, usage(
      window('factory_standard_five_hour', 0, { scope: 'standard', window_minutes: 300 }),
      window('factory_core_monthly', 98, { scope: 'core' })
    ), now)
    expect(row.windows).toHaveLength(6)
    expect(row.bottleneck?.scope).toBe('core')
    expect(row.bottleneck?.labelKey).toBe('admin.quotaOverview.windows.factoryMonthly')
    expect(row.bottleneck?.labelParams).toEqual({ tier: 'Core' })
    expect(row.remainingPercent).toBe(2)
    expect(row.incomplete).toBe(true)
    expect(row.windows.find(item => item.key === 'factory_standard_weekly')?.utilization).toBeNull()
  })

  it('ages Factory snapshots after five minutes and honors explicit stale state', () => {
    const factory = { ...account(13, 'factory'), type: 'apikey' as const }
    const snapshot = usage(window('factory_standard_five_hour', 42, { scope: 'standard' }))
    expect(normalizeQuotaAccount(factory, snapshot, now + 300_000).state).toBe('stale')
    expect(normalizeQuotaAccount(factory, { ...snapshot, factory_usage: { stale: true } }, now).state).toBe('stale')
  })

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
