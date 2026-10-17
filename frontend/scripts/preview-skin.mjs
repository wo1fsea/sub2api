import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '18381' },
  role: { type: 'string', default: 'admin' },
  skin: { type: 'string', default: 'neubrutalism' },
  appearance: { type: 'string', default: 'light' },
  'all-features': { type: 'boolean', default: false },
  'quota-preview': { type: 'boolean', default: false },
  'quota-scenario': { type: 'string', default: 'mixed' }
} })
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port')
if (!['light', 'dark'].includes(values.appearance)) throw new Error('Invalid preview appearance')
const previewSkin = values.skin || 'neubrutalism'
if (!['original', 'neubrutalism', 'monochrome'].includes(previewSkin)) throw new Error('Invalid preview skin')
if (!['mixed', 'empty', 'failed'].includes(values['quota-scenario'])) throw new Error('Invalid quota preview scenario')
const quotaPreview = values['quota-preview']
const quotaScenario = values['quota-scenario']
const root = fileURLToPath(new URL('../', import.meta.url))
const timestamp = '2026-10-02T08:00:00Z'
let webSearchFixture = { enabled: false, providers: [] }
const user = {
  id: 1, username: 'Preview Admin', email: 'preview@example.invalid', role: values.role === 'user' ? 'user' : 'admin',
  balance: 128.5, frozen_balance: 0, concurrency: 4, status: 'active', allowed_groups: [],
  balance_notify_enabled: false, balance_notify_threshold: null, balance_notify_extra_emails: [],
  subscriptions: [], created_at: timestamp, updated_at: timestamp, run_mode: 'standard'
}
const settings = {
  site_appearance: { skin: previewSkin, mode: values.appearance, accent_color: '#d4ff3f' },
  site_name: 'Sub2API', site_logo: '', site_subtitle: 'AI API Gateway', api_base_url: '',
  contact_info: '', doc_url: '', home_content: '', compact_home_enabled: true,
  registration_enabled: false, email_verify_enabled: false, password_reset_enabled: false,
  registration_email_suffix_whitelist: [], turnstile_enabled: false, turnstile_site_key: '',
  promo_code_enabled: false, invitation_code_enabled: false, force_email_on_third_party_signup: false,
  payment_enabled: false, risk_control_enabled: false, subscription_enabled: false,
  channel_monitor_enabled: false, available_channels_enabled: false, model_plaza_enabled: false,
  plugin_management_enabled: false, affiliate_enabled: false, service_quota_enabled: false,
  linuxdo_oauth_enabled: false, wechat_oauth_enabled: false, oidc_oauth_enabled: false,
  github_oauth_enabled: false, google_oauth_enabled: false, backend_mode_enabled: false,
  custom_menu_items: [], custom_endpoints: [], table_default_page_size: 20,
  table_page_size_options: [20, 50, 100], ops_monitoring_enabled: false,
  ops_realtime_monitoring_enabled: false, version: 'skin-preview'
}
if (values['all-features']) {
  for (const key of ['payment_enabled', 'risk_control_enabled', 'subscription_enabled',
    'channel_monitor_enabled', 'available_channels_enabled', 'model_plaza_enabled',
    'plugin_management_enabled', 'affiliate_enabled', 'service_quota_enabled']) settings[key] = true
}
const stats = {
  total_users: 24, today_new_users: 2, active_users: 18, hourly_active_users: 8,
  stats_updated_at: timestamp, stats_stale: false, total_api_keys: 36, active_api_keys: 32,
  total_accounts: 12, normal_accounts: 11, error_accounts: 1, ratelimit_accounts: 0, overload_accounts: 0,
  total_requests: 82416, total_input_tokens: 3600000, total_output_tokens: 1900000,
  total_cache_creation_tokens: 280000, total_cache_read_tokens: 1200000, total_tokens: 6980000,
  total_cost: 426.8, total_actual_cost: 296.4, total_account_cost: 148.2,
  today_requests: 1842, today_input_tokens: 180000, today_output_tokens: 94000,
  today_cache_creation_tokens: 18000, today_cache_read_tokens: 60000, today_tokens: 352000,
  today_cost: 18.4, today_actual_cost: 12.8, today_account_cost: 6.4,
  average_duration_ms: 1260, uptime: 86400, rpm: 24, tpm: 4800
}
const emptyPage = { items: [], total: 0, page: 1, page_size: 20, pages: 1 }
const previewUsers = [
  user,
  { ...user, id: 2, username: 'Preview User', email: 'user@example.invalid', role: 'user', balance: 42.6 },
  { ...user, id: 3, username: 'Disabled User', email: 'disabled@example.invalid', role: 'user', status: 'disabled', balance: 0 }
].map(item => ({ ...item, notes: 'Synthetic preview record' }))

// Quota fixtures are opt-in and never contain real credentials. Relative times
// keep the fresh/expired examples useful without advancing a recorded reading.
const quotaNow = Date.now()
const quotaTime = minutes => new Date(quotaNow + minutes * 60_000).toISOString()
const quotaSampledAt = quotaTime(-1)
const quotaWindow = (key, utilization, resetMinutes, overrides = {}) => ({
  key, utilization,
  resets_at: resetMinutes === null ? null : quotaTime(resetMinutes),
  sampled_at: quotaSampledAt,
  source: 'response_headers',
  window_minutes: key === 'five_hour' ? 300 : 10_080,
  scope: 'account',
  ...overrides
})
const quotaAccounts = [
  { id: 101, name: 'Codex · 工作账号', platform: 'openai', plan: 'plus' },
  { id: 102, name: 'Codex · 高频账号', platform: 'openai', plan: 'pro' },
  { id: 103, name: 'Codex · 空闲账号', platform: 'openai', plan: 'plus' },
  { id: 104, name: 'Claude · Sonnet 专用', platform: 'anthropic', plan: 'max' },
  { id: 105, name: 'Claude · 待采样账号', platform: 'anthropic', plan: 'max' }
].map(({ plan, ...account }) => ({
  ...account, type: 'oauth', notes: 'Synthetic quota preview account',
  credentials: { plan_type: plan }, credentials_status: {}, extra: {},
  proxy_id: null, concurrency: 2, priority: 1, rate_multiplier: 1,
  status: 'active', error_message: null, last_used_at: quotaSampledAt,
  expires_at: null, auto_pause_on_expired: false,
  created_at: quotaTime(-43_200), updated_at: quotaSampledAt,
  group_ids: [], schedulable: true, rate_limited_at: null,
  rate_limit_reset_at: null, overload_until: null,
  temp_unschedulable_until: null, temp_unschedulable_reason: null,
  session_window_start: null, session_window_end: null, session_window_status: null
}))
const quotaUsage = new Map([
  [101, [quotaWindow('five_hour', 18, 160), quotaWindow('seven_day', 92, 2280)]],
  [102, [quotaWindow('five_hour', 88, 85), quotaWindow('seven_day', 46, 4200)]],
  // A confirmed zero usage sample is deliberately different from a missing one.
  [103, [quotaWindow('five_hour', 0, 240), quotaWindow('seven_day', 0, 9600)]],
  [104, [quotaWindow('seven_day_sonnet', 87, 1720, { scope: 'model', model: 'Sonnet' })]],
  // Keep the expired percentage. Passing the reset time does not prove a new
  // allowance was observed; the independent missing window remains unknown.
  [105, [
    quotaWindow('five_hour', 82, -8, { sampled_at: quotaTime(-120) }),
    quotaWindow('seven_day', null, null, { sampled_at: null })
  ]]
].map(([id, windows]) => [id, {
  source: 'passive', updated_at: windows[0].sampled_at,
  five_hour: null, seven_day: null, seven_day_sonnet: null,
  subscription_tier: id < 104 ? (id === 102 ? 'pro' : 'plus') : 'max',
  quota_windows: windows
}]))

function quotaAccountPage(params) {
  const positiveInteger = (raw, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback
  }
  const page = positiveInteger(params.get('page'), 1)
  const pageSize = positiveInteger(params.get('page_size') || params.get('limit'), 20, 1000)
  const search = (params.get('search') || '').toLocaleLowerCase()
  const items = (quotaScenario === 'empty' ? [] : quotaAccounts).filter(account =>
    (!params.get('platform') || account.platform === params.get('platform')) &&
    (!params.get('type') || account.type === params.get('type')) &&
    (!params.get('status') || account.status === params.get('status')) &&
    (!search || account.name.toLocaleLowerCase().includes(search)))
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length, page, page_size: pageSize,
    pages: Math.ceil(items.length / pageSize)
  }
}

const sampleUsage = (date, factor) => ({
  date, requests: 150 * factor, input_tokens: 12000 * factor, output_tokens: 8000 * factor,
  cache_creation_tokens: 1200 * factor, cache_read_tokens: 2400 * factor,
  total_tokens: 23600 * factor, cost: factor, actual_cost: factor * 0.7
})
const sumUsage = rows => rows.reduce((acc, row) => ({
  requests: acc.requests + row.requests,
  input_tokens: acc.input_tokens + row.input_tokens,
  output_tokens: acc.output_tokens + row.output_tokens,
  cache_creation_tokens: acc.cache_creation_tokens + row.cache_creation_tokens,
  cache_read_tokens: acc.cache_read_tokens + row.cache_read_tokens,
  total_tokens: acc.total_tokens + row.total_tokens,
  cost: +(acc.cost + row.cost).toFixed(4),
  actual_cost: +(acc.actual_cost + row.actual_cost).toFixed(4)
}), { requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, cost: 0, actual_cost: 0 })

// The user dashboard loads stats, trend, models and recent usage in parallel;
// without these fixtures the view renders blank content for role=user.
const userTrend = [6, 8, 5, 9, 7, 4, 8].map((factor, index) => sampleUsage(`2026-10-0${index + 1}`, factor))
const userTrendTotals = sumUsage(userTrend)
const userModels = ['claude-sonnet-4-6', 'gpt-5.4', 'gemini-3-pro', 'deepseek-v3']
  .map((model, index) => ({ model, ...sampleUsage('2026-10-07', 9 - index * 2) }))
const userDashboardStats = {
  total_api_keys: 4, active_api_keys: 3,
  ...userTrendTotals, total_cost: 426.8, total_actual_cost: 296.4,
  total_requests: userTrendTotals.requests, total_input_tokens: userTrendTotals.input_tokens,
  total_output_tokens: userTrendTotals.output_tokens, total_cache_creation_tokens: userTrendTotals.cache_creation_tokens,
  total_cache_read_tokens: userTrendTotals.cache_read_tokens,
  today_requests: userTrend.at(-1).requests, today_input_tokens: userTrend.at(-1).input_tokens,
  today_output_tokens: userTrend.at(-1).output_tokens, today_cache_creation_tokens: userTrend.at(-1).cache_creation_tokens,
  today_cache_read_tokens: userTrend.at(-1).cache_read_tokens, today_tokens: userTrend.at(-1).total_tokens,
  today_cost: userTrend.at(-1).cost, today_actual_cost: userTrend.at(-1).actual_cost,
  average_duration_ms: 1260, rpm: 24, tpm: 4800,
  by_platform: [
    { platform: 'anthropic', ...sumUsage([userTrend[0], userTrend[1]]), today_requests: 620, today_tokens: 145000, today_actual_cost: 6.4 },
    { platform: 'openai', ...sumUsage([userTrend[2], userTrend[3]]), today_requests: 512, today_tokens: 118000, today_actual_cost: 5.2 }
  ]
}
const sampleUsageLog = (id, model, factor, hour) => ({
  id, user_id: user.id, api_key_id: 1, account_id: 1, request_id: `synthetic-${id}`, model,
  service_tier: 'default', reasoning_effort: 'medium',
  inbound_endpoint: '/v1/messages', upstream_endpoint: 'https://api.example.invalid',
  group_id: null, subscription_id: null,
  input_tokens: 12000 * factor, output_tokens: 8000 * factor,
  cache_creation_tokens: 1200 * factor, cache_read_tokens: 2400 * factor,
  cache_creation_5m_tokens: 1200 * factor, cache_creation_1h_tokens: 0,
  input_cost: factor, output_cost: +(factor * 0.75).toFixed(4),
  cache_creation_cost: +(factor * 0.25).toFixed(4), cache_read_cost: +(factor * 0.2).toFixed(4),
  total_cost: +(factor * 2.2).toFixed(4), actual_cost: +(factor * 1.54).toFixed(4),
  rate_multiplier: 1, long_context_billing_applied: false, billing_type: 0,
  request_type: 'sync', stream: false, openai_ws_mode: false, native_compaction_v2: false,
  duration_ms: 1260 * factor, first_token_ms: 420 * factor,
  image_count: 0, image_size: null, image_input_size: null, image_output_size: null,
  image_size_source: null, image_size_breakdown: null,
  image_input_tokens: 0, image_input_cost: 0, image_output_tokens: 0, image_output_cost: 0,
  user_agent: 'synthetic-preview', ip_address: null, cache_ttl_overridden: false, billing_mode: null,
  created_at: `2026-10-07T${String(hour).padStart(2, '0')}:15:00Z`
})
const usageLogItems = [
  ['claude-sonnet-4-6', 9, 7, 14], ['gpt-5.4', 7, 8, 13],
  ['gemini-3-pro', 5, 9, 12], ['deepseek-v3', 4, 10, 11],
  ['claude-sonnet-4-6', 3, 11, 10], ['o3-pro', 2, 12, 9]
].map(([model, factor, _index, hour], position) => sampleUsageLog(position + 1, model, factor, hour))
const usagePage = params => {
  const pageSize = Math.min(Number(params.get('page_size')) || 20, 1000)
  const page = Math.max(Number(params.get('page')) || 1, 1)
  return {
    items: usageLogItems.slice((page - 1) * pageSize, page * pageSize),
    total: usageLogItems.length, page, page_size: pageSize, pages: Math.ceil(usageLogItems.length / pageSize)
  }
}
const fixtures = new Map([
  ['/setup/status', { needs_setup: false, step: 'complete' }],
  ['/api/v1/usage/dashboard/stats', userDashboardStats],
  ['/api/v1/usage/dashboard/trend', {
    trend: userTrend, start_date: '2026-10-01', end_date: '2026-10-07', granularity: 'day'
  }],
  ['/api/v1/usage/dashboard/models', { models: userModels, start_date: '2026-10-07', end_date: '2026-10-07' }],
  ['/api/v1/user/platform-quotas', { platform_quotas: [] }],
  ['/api/v1/settings/public', settings],
  ['/api/v1/auth/me', user],
  ['/api/v1/admin/settings', settings],
  ['/api/v1/admin/payment/config', { enabled: false }],
  ['/api/v1/admin/system/version', { version: 'skin-preview' }],
  ['/api/v1/admin/system/check-updates', { current_version: 'skin-preview', latest_version: 'skin-preview', has_update: false }],
  ['/api/v1/admin/compliance', { required: false, version: 'preview' }],
  ['/api/v1/admin/dashboard/snapshot-v2', {
    stats,
    trend: [sampleUsage('2026-10-01', 6), sampleUsage('2026-10-02', 8)],
    models: ['claude-sonnet-4-6', 'gpt-5.4', 'gemini-3-pro', 'deepseek-v3']
      .map((model, index) => ({ model, ...sampleUsage('2026-10-02', 8 - index * 2), account_cost: 4.2 - index })),
    groups: []
  }],
  ['/api/v1/admin/dashboard/users-trend', {
    trend: previewUsers.flatMap((item, index) => [1, 2].map(day => ({
      date: `2026-10-0${day}`, user_id: item.id, username: item.username, email: item.email,
      requests: 10 * day, tokens: (4 - index) * day * 1000, cost: day, actual_cost: day * 0.7
    }))),
    users: previewUsers
  }],
  ['/api/v1/admin/dashboard/users-ranking', {
    ranking: previewUsers.map((item, index) => ({
      user_id: item.id, username: item.username, email: item.email,
      actual_cost: 3 - index, requests: (3 - index) * 100, tokens: (3 - index) * 1000
    })), total_actual_cost: 6, total_requests: 600, total_tokens: 6000
  }],
  ['/api/v1/announcements', []],
  ['/api/v1/keys', emptyPage],
  ['/api/v1/subscriptions/active', []],
  ['/api/v1/subscriptions/progress', []],
  ['/api/v1/admin/users', { ...emptyPage, items: previewUsers, total: previewUsers.length }],
  ['/api/v1/admin/groups', emptyPage],
  ['/api/v1/admin/accounts', emptyPage],
  ['/api/v1/admin/proxies', emptyPage]
])
fixtures.set('/api/v1/admin/dashboard/user-breakdown', { users: [] })
// Explicit synthetic read fixtures let visual QA inspect the real forms/tables
// instead of accepting pages hidden behind missing-endpoint toasts. Unknown
// endpoints still fail closed below; no request is forwarded to a live backend.
const previewGroup = {
  id: 1, name: 'Preview · 标准模型组', description: 'Synthetic review group', platform: 'openai',
  status: 'active', rate_multiplier: 1, is_exclusive: false, subscription_type: 'standard',
  daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null,
  model_pricing: [], model_routing: {}, model_routing_enabled: false,
  account_count: 3, active_account_count: 2, rate_limited_account_count: 1,
  supported_model_scopes: [], model_allowlist: [], created_at: timestamp, updated_at: timestamp
}
const previewKey = {
  id: 1, user_id: 1, key: 'sk-synthetic-preview-not-a-real-key', name: 'Preview application',
  group_id: 1, group: previewGroup, status: 'active', ip_whitelist: [], ip_blacklist: [],
  last_used_at: timestamp, last_used_ip: null, quota: 100, quota_used: 28.5,
  expires_at: null, created_at: timestamp, updated_at: timestamp, current_concurrency: 0,
  rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0, usage_5h: 0, usage_1d: 0, usage_7d: 0
}
const supportFixtures = [
  ['/admin/groups', { ...emptyPage, items: [previewGroup], total: 1 }],
  ['/admin/groups/all', [previewGroup]],
  ['/groups/available', [previewGroup]], ['/groups/rates', {}],
  ['/admin/groups/live-capability', { supported: false, reason: 'Synthetic preview' }],
  ['/admin/groups/0/model-allowlist-candidates', { models: ['gpt-6-astra', 'gpt-6.1-sol'] }],
  ['/admin/groups/usage-summary', {}], ['/admin/groups/capacity-summary', {}],
  ['/admin/channels', emptyPage], ['/admin/announcements', emptyPage],
  ['/admin/proxies/all', []], ['/admin/redeem-codes', emptyPage], ['/admin/promo-codes', emptyPage],
  ['/admin/usage', { ...emptyPage, items: usageLogItems, total: usageLogItems.length }],
  ['/admin/usage/stats', stats], ['/admin/dashboard/models', { models: userModels }],
  ['/admin/audit-logs', emptyPage],
  ['/admin/user-attributes', []],
  ['/admin/settings/admin-api-key', { exists: false, masked_key: '' }],
  ['/admin/accounts/upstream-billing-probe/settings', { enabled: false, interval_minutes: 60 }],
  ['/admin/accounts/ollama-cloud-usage/settings', { enabled: false, interval_minutes: 60, debounce_minutes: 5 }],
  ['/admin/accounts/opencode-go-usage/settings', { enabled: false, interval_minutes: 60, debounce_minutes: 5 }],
  ['/admin/settings/overload-cooldown', { enabled: false, cooldown_minutes: 10 }],
  ['/admin/settings/rate-limit-429-cooldown', { enabled: false, cooldown_seconds: 60 }],
  ['/admin/settings/panel-rate-limit', { enabled: false, user_rpm: 120, heavy_rpm: 30, exempt_admin: true, public_ip_rpm: 60 }],
  ['/admin/settings/stream-timeout', { enabled: false, action: 'none', temp_unsched_minutes: 5, threshold_count: 3, threshold_window_minutes: 10 }],
  ['/admin/settings/rectifier', { enabled: false, thinking_signature_enabled: false, thinking_budget_enabled: false, apikey_signature_enabled: false, apikey_signature_patterns: [] }],
  ['/admin/settings/beta-policy', { rules: [] }],
  ['/admin/payment/providers', []],
  ['/admin/settings/email-templates', { events: [], locales: ['zh', 'en'], templates: [], placeholders: [] }],
  ['/admin/backups/s3-config', { endpoint: '', region: '', bucket: '', access_key_id: '', prefix: '', force_path_style: false }],
  ['/admin/backups/image-storage', { config: { enabled: false, reuse_backup_s3: false, bucket: '', prefix: '', public_base_url: '', presign_expiry_hours: 24, max_download_bytes: 10485760, endpoint: '', region: '', access_key_id: '', force_path_style: false }, secret_configured: false }],
  ['/admin/backups/schedule', { enabled: false, cron_expr: '0 3 * * *', retain_days: 7, retain_count: 3, monthly_archive: { enabled: false, days: [1], include_month_end: false, retain_count: 0 } }],
  ['/admin/backups', { items: [] }],
  ['/keys', { ...emptyPage, items: [previewKey], total: 1 }],
  ['/usage/stats', stats],
  ['/usage/dashboard/snapshot-v2', { generated_at: timestamp, start_date: '2026-10-01', end_date: '2026-10-07', granularity: 'day', trend: userTrend, models: userModels, groups: [] }],
  ['/redeem/history', emptyPage], ['/user/totp/status', { enabled: false }]
]
for (const [path, data] of supportFixtures) fixtures.set(`/api/v1${path}`, data)
const moderationConfig = {
  engine: 'openai', enabled: false, mode: 'off', base_url: '', model: '', proxy_id: null,
  api_key_configured: false, api_key_masked: '', api_key_count: 0, api_key_masks: [], api_key_statuses: [],
  timeout_ms: 5000, sample_rate: 1, all_groups: true, group_ids: [], record_non_hits: false,
  thresholds: {}, worker_count: 1, queue_size: 10, block_status: 403, block_message: 'Synthetic review',
  email_on_hit: false, auto_ban_enabled: false, ban_threshold: 3, violation_window_hours: 24,
  retry_count: 0, hit_retention_days: 7, non_hit_retention_days: 1, pre_hash_check_enabled: false,
  blocked_keywords: [], keyword_blocking_mode: 'api_only', model_filter: { type: 'all', models: [] },
  cyber_policy_exclude_from_ban_count: false
}
const optionalFixtures = [
  ['/admin/channel-monitors', emptyPage], ['/channel-monitors', { items: [] }],
  ['/admin/subscriptions', emptyPage], ['/subscriptions', []], ['/admin/plugins', []],
  ['/admin/risk-control/config', moderationConfig],
  ['/admin/risk-control/logs', emptyPage],
  ['/admin/risk-control/status', { ...moderationConfig, risk_control_enabled: true, active_workers: 0, queue_length: 0, queue_usage_percent: 0, processed: 0, errors: 0, pre_block_api_key_loads: [], flagged_hash_count: 0 }],
  ['/admin/prompt-audit/config', { enabled: false, blocking_enabled: false, blocking_latest_turn_only: true, store_pass_events: false, effective_mode: 'off', strategy: 'priority', worker_count: 1, queue_capacity: 10, scanners: [], all_groups: true, group_ids: [], endpoints: [], config_version: 1, updated_at: timestamp, updated_by: 1, change_summary: 'Synthetic preview' }],
  ['/admin/prompt-audit/runtime', { process_status: 'disabled', effective_mode: 'off', expected_config_version: 1, active_config_version: 1, worker_total: 0, worker_active: 0, queue_capacity: 10, queue: { staging: 0, queued: 0, processing: 0, retry: 0, done: 0, failed: 0, active: 0 }, processed_total: 0, failed_total: 0, enqueued_total: 0, dropped_total: 0, database_status: 'ok', redis_status: 'ok', endpoints: {}, guard_metrics: {} }],
  ['/admin/prompt-audit/events', emptyPage],
  ['/admin/affiliates/invites', emptyPage], ['/admin/affiliates/rebates', emptyPage], ['/admin/affiliates/transfers', emptyPage],
  ['/admin/affiliates/users', emptyPage],
  ['/admin/payment/dashboard', { today_amount: { USD: 42 }, total_amount: { USD: 210 }, today_count: 3, total_count: 15, avg_amount: { USD: 14 }, daily_series: [], payment_methods: [], top_users: {} }],
  ['/admin/payment/orders', emptyPage], ['/admin/payment/plans', []],
  ['/payment/orders/my', emptyPage], ['/payment/orders/refund-eligible-providers', { provider_instance_ids: [] }],
  ['/payment/orders/9001', { id: 9001, status: 'PENDING', amount: 10, pay_amount: 10, currency: 'USD', out_trade_no: 'synthetic-preview' }],
  ['/payment/checkout-info', { methods: { stripe: { currency: 'USD', daily_limit: 1000, daily_used: 0, daily_remaining: 1000, single_min: 1, single_max: 100, fee_rate: 0, available: true } }, global_min: 1, global_max: 100, plans: [], balance_disabled: false, balance_recharge_multiplier: 1, subscription_usd_to_cny_rate: 0, recharge_fee_rate: 0, help_text: 'Synthetic preview — no payment can be submitted', help_image_url: '', stripe_publishable_key: '' }],
  ['/channels/available', []],
  ['/user/aff', { user_id: 1, aff_code: 'preview', inviter_id: null, aff_count: 0, aff_quota: 0, aff_frozen_quota: 0, aff_history_quota: 0, effective_rebate_rate_percent: 0, invitees: [] }],
  ['/model-plaza', { description: 'Synthetic model catalog', groups: [{ ...previewGroup, models: ['gpt-6-astra', 'gpt-6.1-sol'].map(name => ({ name, platform: 'openai', pricing: null, official_pricing: null })) }] }]
]
for (const [path, data] of optionalFixtures) fixtures.set(`/api/v1${path}`, data)
fixtures.set('/api/v1/admin/accounts/1/stats', {
  account_id: 1, account_name: 'Synthetic account', days: 30,
  summary: { total_cost: 12, total_user_cost: 18, total_standard_cost: 24, total_requests: 600, total_tokens: 240000,
    avg_daily_cost: .4, avg_daily_user_cost: .6, avg_daily_requests: 20, avg_daily_tokens: 8000, avg_duration_ms: 1200,
    actual_days_used: 30, days: 30,
    highest_cost_day: { date: '2026-10-02', label: '10/02', cost: 5, user_cost: 7, requests: 200 },
    highest_request_day: { date: '2026-10-02', label: '10/02', cost: 5, user_cost: 7, requests: 200 } },
  history: [1, 2, 3, 4, 5, 6].map(day => ({ label: `10/0${day}`, date: `2026-10-0${day}`, ...sampleUsage(`2026-10-0${day}`, day), user_cost: day })),
  models: [], endpoints: [], upstream_endpoints: [], endpoint_paths: []
})

const previewPlugin = {
  name: 'isolated-skin-preview',
  enforce: 'pre',
  configResolved(config) {
    // Never forward a preview request to a configured development or production backend.
    config.server.proxy = {}
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      const path = url.pathname
      if (path === '/__skin/charts' || path === '/__skin/components') {
        const entry = path.endsWith('components') ? 'component-skin-preview' : 'chart-skin-preview'
        server.transformIndexHtml(path, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>样式预览</title></head><body><div id="app"></div><script type="module" src="/scripts/${entry}.ts"></script></body></html>`)
          .then(html => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html) })
          .catch(error => { res.statusCode = 500; res.end('Preview could not render'); console.error(error.message) })
        return
      }
      if (!/^\/(api|v1|setup)(\/|$)/.test(path)) return next()
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      const previewRole = req.headers.authorization === 'Bearer synthetic-user-preview' ? 'user' : user.role
      if (path.startsWith('/api/v1/admin/') && previewRole !== 'admin') {
        res.statusCode = 403
        res.end(JSON.stringify({ code: 403, message: 'Administrator required' }))
        return
      }
      if (quotaPreview && path === '/api/v1/admin/accounts/usage/batch' && req.method === 'POST') {
        // This POST only reads fixture values. All other API writes retain the
        // existing memory-only exceptions or are rejected below with 405.
        let body = ''
        req.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy() })
        req.on('end', () => {
          try {
            const request = JSON.parse(body)
            if (!Array.isArray(request.account_ids) || request.account_ids.length > 1000 ||
                request.account_ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
              throw new Error('Invalid synthetic account IDs')
            }
            const usage = {}
            const errors = {}
            for (const id of new Set(request.account_ids)) {
              if (quotaScenario === 'failed') errors[id] = 'Synthetic quota query failed; previous reading is unchanged'
              else if (quotaScenario === 'empty' || !quotaUsage.has(id)) errors[id] = 'Synthetic account not found'
              else usage[id] = quotaUsage.get(id)
            }
            res.end(JSON.stringify({ code: 0, data: { usage, errors } }))
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ code: 400, message: 'Invalid synthetic usage request' }))
          }
        })
        return
      }
      if (path === '/api/v1/admin/settings/web-search-emulation' && ['GET', 'PUT'].includes(req.method) && previewRole === 'admin') {
        if (req.method === 'GET') { res.end(JSON.stringify({ code: 0, data: webSearchFixture })); return }
        let body = ''
        req.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy() })
        req.on('end', () => {
          try { webSearchFixture = JSON.parse(body); res.end(JSON.stringify({ code: 0, data: webSearchFixture })) }
          catch { res.statusCode = 400; res.end(JSON.stringify({ code: 400 })) }
        })
        return
      }
      // Only this in-memory fixture can change; production forwarding stays disabled.
      if (req.method === 'PUT' && path === '/api/v1/admin/settings' && user.role === 'admin') {
        let body = ''
        req.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy() })
        req.on('end', () => {
          try {
            const appearance = JSON.parse(body).site_appearance
            if (!['original', 'neubrutalism', 'monochrome'].includes(appearance?.skin) || !['light', 'dark'].includes(appearance?.mode) || !/^#[\da-f]{6}$/i.test(appearance?.accent_color)) throw new Error('Invalid appearance')
            settings.site_appearance = appearance
            res.end(JSON.stringify({ code: 0, data: settings }))
          } catch { res.statusCode = 400; res.end(JSON.stringify({ code: 400, message: 'Invalid synthetic appearance' })) }
        })
        return
      }
      // These POST endpoints are batch reads; return explicit empty synthetic
      // statistics without forwarding, mutating state or relaxing other writes.
      if (req.method === 'POST' && [
        '/api/v1/admin/accounts/today-stats/batch',
        '/api/v1/usage/dashboard/api-keys-usage'
      ].includes(path)) {
        req.resume()
        res.end(JSON.stringify({ code: 0, data: { stats: {} } }))
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.end(JSON.stringify({ code: 405, message: 'Read-only synthetic preview', data: null }))
        return
      }
      const data = quotaPreview && path === '/api/v1/admin/accounts'
        ? quotaAccountPage(url.searchParams)
        : path === '/api/v1/usage'
          ? usagePage(url.searchParams)
          : path === '/api/v1/auth/me' && previewRole === 'user' ? { ...user, role: 'user' } : fixtures.get(path)
      res.statusCode = data === undefined ? 404 : 200
      res.end(JSON.stringify({ code: data === undefined ? 404 : 0,
        message: data === undefined ? 'No preview fixture for this endpoint' : 'Synthetic preview', data: data ?? null }))
    })
  },
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const script = `<script>window.__APP_CONFIG__=${JSON.stringify(settings)};
        if(location.pathname==='/login'){localStorage.removeItem('auth_token');localStorage.removeItem('auth_user');}
        else{const u=${JSON.stringify(user)};if(new URLSearchParams(location.search).get('role')==='user')u.role='user';localStorage.setItem('auth_token',u.role==='user'?'synthetic-user-preview':'synthetic-preview-only');localStorage.setItem('auth_user',JSON.stringify(u));}
        localStorage.setItem('ops_monitoring_enabled_cached','false');
        localStorage.setItem('admin_guide_1_admin_v4_interactive','true');
        localStorage.setItem('user_guide_1_user_v4_interactive','true');
        if(!localStorage.getItem('sub2api_locale'))localStorage.setItem('sub2api_locale','zh');</script>`
      return html.replace('</head>', `${script}<style>body{padding-top:30px}.sidebar{top:30px!important}.skin-app-header{top:30px!important}</style></head>`).replace('<body>',
        '<body><div style="height:30px;padding:6px 16px;background:#171813;color:#fffefa;font:12px/1.5 system-ui;position:fixed;top:0;left:0;right:0;z-index:60">本地演示 / Synthetic data / 主题设置仅存于演示内存</div>')
    }
  }
}

process.env.VITE_DEV_PROXY_TARGET = `http://127.0.0.1:${port}`
const server = await createServer({ root, plugins: [previewPlugin], server: {
  host: '127.0.0.1', port, strictPort: true
} })
await server.listen()
console.log(`Isolated skin preview (skin: ${previewSkin}, appearance writes are in memory only): http://127.0.0.1:${port}/admin/${quotaPreview ? 'quota-overview' : 'dashboard'}${quotaPreview ? ` [quota: ${quotaScenario}]` : ''}`)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await server.close(); process.exit(0) })
}
